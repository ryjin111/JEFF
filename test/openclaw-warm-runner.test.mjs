import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createOpenClawRunner } from '../src/openclaw-runner.mjs';
import { createOpenClawWarmPool } from '../src/openclaw-warm-runner.mjs';

const scope = { chainId: 4663, collection: `0x${'11'.repeat(20)}`, tokenId: '999999', owner: `0x${'22'.repeat(20)}`, ownerEpoch: 4 };
const turn = id => ({ scope, objective: `Synthetic request ${id}`, jobId: `fixture-${id}`,
  executionContext: { settings: { name: 'Synthetic fixture' }, chatActions: { enabled: true, now: '2026-10-11T12:00:00.000Z', timeZone: 'UTC' } },
  inferenceGateway: { baseUrl: 'http://127.0.0.1:8419/v1', apiKey: `fixture-key-${id}`, model: 'fixture' } });
const deferred = () => { let ok, reject; const promise = new Promise((a, b) => { ok = a; reject = b; }); return { promise, ok, reject }; };

async function fixture(t, behavior = {}) {
  const root = await mkdtemp(resolve('test', '.warm-'));
  const children = [], clients = [], calls = [], settlements = [], agents = [];
  const spawnProcess = (_node, args, options) => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kills = [];
    child.kill = signal => { child.kills.push(signal); if (!behavior.ignoreTerm || signal === 'SIGKILL') queueMicrotask(() => child.emit('close', 0)); return true; };
    children.push({ child, args, options }); return child;
  };
  const createGatewayClient = async options => {
    if (behavior.clientGate) await behavior.clientGate.promise;
    const configPath = options.env.OPENCLAW_CONFIG_PATH;
    let revision = 0;
    const client = {
      options, stopped: false,
      start() { if (behavior.preHelloClose) options.onClose(); if (!behavior.noHello) queueMicrotask(() => options.onHelloOk()); },
      async stopAndWait() { client.stopped = true; options.onClose?.(); },
      async request(method, params, requestOptions) {
        calls.push({ method, params, requestOptions });
        if (method === 'config.get') return { hash: `opaque-raw-${revision}`, configRevisionHash: `resolved-${revision}`,
          appliedConfigHash: behavior.unapplied ? 'unapplied' : `resolved-${revision}` };
        if (method === 'config.patch') {
          assert.equal(params.baseHash, `opaque-raw-${revision}`);
          const config = JSON.parse(await readFile(configPath));
          config.models.providers.bankr.apiKey = JSON.parse(params.raw).models.providers.bankr.apiKey;
          await writeFile(configPath, JSON.stringify(config)); revision++;
          return { changedPaths: behavior.extraPath ? ['models.providers.bankr.apiKey', 'tools.deny'] : ['models.providers.bankr.apiKey'] };
        }
        if (method === 'chat.abort') { behavior.held?.reject(new Error('synthetic-abort')); return { aborted: true, runIds: [params.runId] }; }
        if (method === 'agent') {
          agents.push({ params, requestOptions, client }); behavior.entered?.ok();
          assert.equal(requestOptions.expectFinal, true);
          assert.equal(params.promptMode, 'full'); assert.equal(params.bootstrapContextMode, 'full');
          if (behavior.disconnect) { options.onClose(); throw new Error('private token and prompt must never escape'); }
          if (behavior.held) return behavior.held.promise;
          if (behavior.response) return behavior.response(params);
          return { runId: params.idempotencyKey, status: 'ok', result: { payloads: [{ text: 'Synthetic answer' }],
            meta: { agentMeta: { usage: { input: 50, output: 3, total: 53 } } } } };
        }
        throw new Error('unexpected mock RPC');
      },
    };
    clients.push(client); return client;
  };
  const factory = { mode: 'warm-gateway', model: 'bankr/fixture', allowedModels: ['bankr/fixture', 'bankr/other'],
    env: { ...process.env, BANKR_LLM_API_KEY: 'upstream-must-not-leak' }, spawnProcess,
    warm: { createGatewayClient, maxWorkers: 2, idleMs: 60000, startupTimeoutMs: 1000, cleanupTimeoutMs: 1000 },
    settleInference: async id => { settlements.push(id); if (behavior.settle) await behavior.settle(id); } };
  const runner = createOpenClawRunner(factory);
  t.after(async () => { await runner.close(); await rm(root, { recursive: true, force: true }); });
  const input = id => ({ ...turn(id), stateRoot: resolve(root, 'state'), workspace: resolve(root, 'workspace') });
  return { root, runner, input, factory, children, clients, calls, agents, settlements };
}

test('warm mode is explicit and requires the host per-job settlement capability', async () => {
  assert.throws(() => createOpenClawRunner({ mode: 'warm-gateway' }), /CONFIG_INVALID/);
  assert.throws(() => createOpenClawRunner({ mode: 'unknown' }), /CONFIG_INVALID/);
  const legacy = createOpenClawRunner(); await legacy.close(); await legacy.retireScope(scope);
});

test('two jobs reuse one worker with fresh sessions, final response, usage and exact token clearing', async t => {
  const f = await fixture(t);
  const first = await f.runner(f.input(1)), second = await f.runner(f.input(2));
  assert.deepEqual(first, { text: 'Synthetic answer', model: 'bankr/fixture', usage: { inputTokens: 50, outputTokens: 3, totalTokens: 53 } });
  assert.deepEqual(second, first); assert.equal(f.children.length, 1); assert.equal(f.clients.length, 1);
  assert.notEqual(f.agents[0].params.sessionId, f.agents[1].params.sessionId);
  assert.notEqual(f.agents[0].params.sessionKey, f.agents[1].params.sessionKey);
  assert.notEqual(f.agents[0].params.idempotencyKey, f.agents[1].params.idempotencyKey);
  assert.equal(f.agents[1].params.message.includes('Synthetic request 1'), false);
  assert.deepEqual(f.settlements, ['fixture-1', 'fixture-2']);
  const patches = f.calls.filter(call => call.method === 'config.patch').map(call => JSON.parse(call.params.raw).models.providers.bankr.apiKey);
  assert.equal(patches[0], 'fixture-key-1'); assert.equal(patches[2], 'fixture-key-2');
  assert.match(patches[1], /^inactive-/); assert.equal(patches[1], patches[3]);
  const child = f.children[0], config = JSON.parse(await readFile(resolve(f.input(1).stateRoot, 'openclaw.json')));
  assert.deepEqual(config.tools, { profile: 'minimal', deny: ['*'] });
  assert.equal(config.plugins.enabled, false); assert.deepEqual(config.agents.defaults.skills, []);
  assert.equal(config.models.providers.bankr.apiKey, patches[3]);
  assert.equal(config.gateway.bind, 'loopback'); assert.equal(config.gateway.auth.mode, 'token');
  assert.equal(config.agents.defaults.timeoutSeconds, 120); assert.equal(f.agents[0].params.timeout, 120);
  assert.equal(child.options.env.BANKR_LLM_API_KEY, undefined); assert.equal(child.options.env.JEFF_INFERENCE_API_KEY, undefined);
  assert.equal(JSON.stringify(child.options.env).includes('fixture-key'), false);
  assert.equal(child.options.env.HOME, f.input(1).stateRoot); assert.equal(f.clients[0].options.deviceIdentity, null);
  assert.match(await readFile(resolve(f.input(1).workspace, 'AGENTS.md'), 'utf8'), /jeff-chat-response-v1/);
});

test('shorter outer deadlines also cap model execution below the legacy 120 second maximum', async t => {
  const f = await fixture(t), runner = createOpenClawRunner({ ...f.factory, timeoutMs: 35000 });
  t.after(() => runner.close()); await runner(f.input(1));
  assert.equal(f.agents[0].params.timeout, 35);
  assert.equal(JSON.parse(await readFile(resolve(f.input(1).stateRoot, 'openclaw.json'))).agents.defaults.timeoutSeconds, 35);
});

test('maintenance restart rebuilds fresh credentials without dropping the config metadata envelope', async t => {
  const f = await fixture(t); await f.runner(f.input(1));
  const path = resolve(f.input(1).stateRoot, 'openclaw.json');
  const previous = JSON.parse(await readFile(path));
  assert.deepEqual(previous.meta, {});
  // Actual OpenClaw adds this stamp on config.patch and treats its removal as
  // an incomplete overwrite, restoring the old Gateway port and auth token.
  previous.meta = { lastTouchedVersion: '2026.9.9' };
  previous.syntheticUntrustedPolicy = true;
  await writeFile(path, JSON.stringify(previous));
  await f.runner.drainIdle(); await f.runner(f.input(2));
  const next = JSON.parse(await readFile(path));
  assert.deepEqual(next.meta, {});
  assert.notEqual(next.gateway.auth.token, previous.gateway.auth.token);
  assert.notEqual(next.models.providers.bankr.apiKey, previous.models.providers.bankr.apiKey);
  assert.equal(next.syntheticUntrustedPolicy, undefined);
  assert.equal(f.children.length, 2); assert.equal(f.children[0].child.kills.length, 1);
  assert.equal(f.agents[1].params.message.includes('Synthetic request 1'), false);
});

test('current canonical identity and host action context are rewritten before each fresh session', async t => {
  const f = await fixture(t); await f.runner(f.input(1));
  const next = f.input(2); next.executionContext = { settings: { name: 'Changed fixture' }, chatActions: { enabled: false } };
  await f.runner(next);
  assert.match(await readFile(resolve(next.workspace, 'IDENTITY.md'), 'utf8'), /Changed fixture/);
  const agents = await readFile(resolve(next.workspace, 'AGENTS.md'), 'utf8');
  assert.match(agents, /This is scheduled work/); assert.equal(agents.includes('jeff-chat-response-v1'), false);
  assert.equal(f.children.length, 1);
});

test('upstream credentials and non-loopback proxy URLs cannot enter a warm worker', async t => {
  const f = await fixture(t);
  await assert.rejects(f.runner({ ...f.input(1), inferenceGateway: undefined }), /WARM_INFERENCE_REQUIRED/);
  await assert.rejects(f.runner({ ...f.input(1), inferenceGateway: { ...f.input(1).inferenceGateway, baseUrl: 'https://example.com/v1' } }), /WARM_INFERENCE_REQUIRED/);
  assert.equal(f.children.length, 0); assert.deepEqual(f.settlements, []);
});

test('owner epoch and model changes retire the old worker before reusing the same state paths', async t => {
  const f = await fixture(t); await f.runner(f.input(1));
  await f.runner({ ...f.input(2), scope: { ...scope, ownerEpoch: 5 } });
  assert.equal(f.children.length, 2); assert.equal(f.clients[0].stopped, true); assert.equal(f.children[0].child.kills.length, 1);
  await f.runner({ ...f.input(3), scope: { ...scope, ownerEpoch: 5 }, inferenceGateway: { ...f.input(3).inferenceGateway, model: 'other' } });
  assert.equal(f.children.length, 3); assert.equal(f.clients[1].stopped, true);
});

test('concurrent admission to an active scope cannot rewrite its files or credential', async t => {
  const held = deferred(), entered = deferred(); const f = await fixture(t, { held, entered });
  const pending = f.runner(f.input(1)); await entered.promise;
  await assert.rejects(f.runner(f.input(2)), /WARM_BUSY/);
  await assert.rejects(f.runner({ ...f.input(3), scope: { ...scope, ownerEpoch: 5 } }), /WARM_BUSY/);
  assert.equal(f.children.length, 1); assert.equal(f.agents.length, 1);
  held.ok({ runId: f.agents[0].params.idempotencyKey, status: 'ok', result: { payloads: [{ text: 'Synthetic answer' }] } });
  await pending;
});

test('owner cancellation revokes before exact abort and retires the worker without accepting late output', async t => {
  const held = deferred(), entered = deferred(); const f = await fixture(t, { held, entered });
  const controller = new AbortController(), pending = f.runner({ ...f.input(1), signal: controller.signal });
  await entered.promise; controller.abort(); await assert.rejects(pending, /CANCELLED/);
  assert.deepEqual(f.settlements, ['fixture-1']);
  const abort = f.calls.find(call => call.method === 'chat.abort');
  assert.equal(abort.params.runId, f.agents[0].params.idempotencyKey); assert.equal(abort.params.sessionKey, f.agents[0].params.sessionKey);
  assert.equal(f.clients[0].stopped, true); assert.equal(f.children[0].child.kills.length, 1);
});

test('an unexpected transport close retires and exposes only a constant failure', async t => {
  const f = await fixture(t, { disconnect: true });
  await assert.rejects(f.runner(f.input(1)), error => error.message === 'JEFF_OPENCLAW_PROCESS_FAILED');
  assert.equal(f.agents.length, 1); assert.equal(f.clients[0].stopped, true); assert.equal(f.children[0].child.kills.length, 1);
  assert.deepEqual(f.settlements, ['fixture-1']);
});

for (const variant of ['wrong-run', 'missing-output', 'error', 'aborted']) test(`invalid ${variant} final responses retire instead of reusing`, async t => {
  const f = await fixture(t, { response: params => ({ runId: variant === 'wrong-run' ? 'other-run' : params.idempotencyKey,
    status: variant === 'error' ? 'error' : 'ok', result: { payloads: variant === 'missing-output' ? [] : [{ text: 'Synthetic answer' }],
      meta: { aborted: variant === 'aborted' } } }) });
  await assert.rejects(f.runner(f.input(1)), /RESPONSE_(?:FAILED|INVALID)/);
  assert.equal(f.clients[0].stopped, true); assert.deepEqual(f.settlements, ['fixture-1']);
});

for (const variant of ['unapplied', 'extraPath']) test(`${variant} config prevents agent admission`, async t => {
  const f = await fixture(t, { [variant]: true });
  await assert.rejects(f.runner(f.input(1)), /GATEWAY_CONFIG_NOT_APPLIED/);
  assert.equal(f.agents.length, 0); assert.equal(f.children[0].child.kills.length, 1);
});

test('settlement failure denies the result and prevents worker reuse', async t => {
  const f = await fixture(t, { settle: () => { throw new Error('private ledger details'); } });
  await assert.rejects(f.runner(f.input(1)), error => error.message === 'JEFF_OPENCLAW_INFERENCE_SETTLEMENT_FAILED');
  assert.equal(f.clients[0].stopped, true); assert.equal(f.children[0].child.kills.length, 1);
});

test('startup timeout stops a child that never authenticates', async t => {
  const f = await fixture(t, { noHello: true });
  const runner = createOpenClawRunner({ ...f.factory, warm: { ...f.factory.warm, startupTimeoutMs: 20 } });
  t.after(() => runner.close()); await assert.rejects(runner(f.input(1)), /GATEWAY_STARTUP_TIMEOUT/);
  assert.equal(f.clients[0].stopped, true); assert.equal(f.children[0].child.kills.length, 1);
});

test('a pre-handshake connection refusal can retry while the supervised child boots', async t => {
  const f = await fixture(t, { preHelloClose: true });
  assert.equal((await f.runner(f.input(1))).text, 'Synthetic answer');
  assert.equal(f.children.length, 1);
});

test('job deadline explicitly aborts and retires a held request', async t => {
  const held = deferred(); const f = await fixture(t, { held });
  const runner = createOpenClawRunner({ ...f.factory, timeoutMs: 100 });
  t.after(() => runner.close()); await assert.rejects(runner(f.input(1)), /TIMEOUT/);
  assert.equal(f.clients[0].stopped, true); assert.equal(f.calls.some(call => call.method === 'chat.abort'), true);
});

test('idle eviction, explicit scope retirement and idempotent shutdown close every worker', async t => {
  const f = await fixture(t);
  const runner = createOpenClawRunner({ ...f.factory, warm: { ...f.factory.warm, idleMs: 20 } });
  t.after(() => runner.close()); await runner(f.input(1)); await delay(40);
  assert.equal(f.clients[0].stopped, true); await runner(f.input(2)); await runner.retireScope(scope);
  assert.equal(f.clients[1].stopped, true); await runner(f.input(3));
  const closing = runner.close(); assert.equal(runner.close(), closing); await closing;
  assert.equal(f.clients.every(client => client.stopped), true);
  await assert.rejects(runner(f.input(4)), /CANCELLED/);
});

test('pool capacity evicts idle workers and refuses active workers without a queue', async t => {
  const f = await fixture(t);
  const runner = createOpenClawRunner({ ...f.factory, warm: { ...f.factory.warm, maxWorkers: 1 } });
  t.after(() => runner.close()); await runner(f.input(1));
  await runner({ ...f.input(2), scope: { ...scope, tokenId: '999998' }, stateRoot: resolve(f.root, 'other-state'), workspace: resolve(f.root, 'other-workspace') });
  assert.equal(f.children.length, 2); assert.equal(f.clients[0].stopped, true);
  const g = await fixture(t, { held: deferred(), entered: deferred() });
  const capacity = createOpenClawRunner({ ...g.factory, warm: { ...g.factory.warm, maxWorkers: 1 } });
  t.after(() => capacity.close()); const controller = new AbortController();
  const pending = capacity({ ...g.input(1), signal: controller.signal });
  while (!g.agents.length) await delay(2);
  await assert.rejects(capacity({ ...g.input(2), scope: { ...scope, tokenId: '999998' }, stateRoot: resolve(g.root, 'second-state'), workspace: resolve(g.root, 'second-workspace') }), /WARM_CAPACITY_REACHED/);
  controller.abort(); await assert.rejects(pending, /CANCELLED/);
});

test('shutdown during delayed client creation prevents a late connection from starting', async t => {
  const clientGate = deferred(); const f = await fixture(t, { clientGate });
  const pending = f.runner(f.input(1));
  while (!f.children.length) await delay(2);
  const closing = f.runner.close(); await delay(20); clientGate.ok();
  await assert.rejects(pending, /CANCELLED/); await closing;
  assert.equal(f.children[0].child.kills.length, 1); assert.equal(f.clients[0].stopped, true);
  assert.equal(f.agents.length, 0);
});

test('cancellation retains path ownership until old host preparation and writes have settled', async t => {
  const f = await fixture(t), gate = deferred(), entered = deferred(), controller = new AbortController();
  const pool = createOpenClawWarmPool({ node: process.execPath, cli: 'unused', env: {}, timeoutMs: 1000,
    cleanupTimeoutMs: 500, settleInference: async () => {} });
  t.after(() => pool.close());
  const markerPath = resolve(f.root, 'workspace', 'AGENTS.md');
  const pending = pool.run({ ...f.input(1), signal: controller.signal }, async () => {
    entered.ok(); await gate.promise; await writeFile(markerPath, 'old synthetic preparation');
  });
  await entered.promise; controller.abort(); await delay(10);
  await assert.rejects(pool.run(f.input(2), async () => { throw new Error('must not enter'); }), /WARM_BUSY/);
  gate.ok(); await assert.rejects(pending, /CANCELLED/);
  await pool.run(f.input(3), async () => { await writeFile(markerPath, 'new synthetic preparation'); throw new Error('fixture exit without a client'); }).catch(() => {});
  assert.equal(await readFile(markerPath, 'utf8'), 'new synthetic preparation');
});

test('owner cancellation during successful credential cleanup still rejects and retires', async t => {
  const gate = deferred(), entered = deferred(), controller = new AbortController();
  const f = await fixture(t, { settle: async () => { entered.ok(); await gate.promise; } });
  const pending = f.runner({ ...f.input(1), signal: controller.signal });
  await entered.promise; controller.abort(); gate.ok(); await assert.rejects(pending, /CANCELLED/);
  assert.equal(f.clients[0].stopped, true); assert.equal(f.children[0].child.kills.length, 1);
});

test('unsettled host preparation permanently quarantines its paths and pool slot', async t => {
  const f = await fixture(t), gate = deferred(), entered = deferred(), controller = new AbortController();
  const pool = createOpenClawWarmPool({ node: process.execPath, cli: 'unused', env: {}, timeoutMs: 1000,
    maxWorkers: 1, cleanupTimeoutMs: 20, settleInference: async () => {} });
  const pending = pool.run({ ...f.input(1), signal: controller.signal }, async () => { entered.ok(); await gate.promise; });
  await entered.promise; controller.abort(); await assert.rejects(pending, /GATEWAY_STOP_TIMEOUT/);
  await assert.rejects(pool.run(f.input(2), async () => {}), /WARM_BUSY/);
  await assert.rejects(pool.run({ ...f.input(3), stateRoot: resolve(f.root, 'other-state'), workspace: resolve(f.root, 'other-workspace') }, async () => {}), /WARM_CAPACITY_REACHED/);
  gate.ok(); await assert.rejects(pool.close(), /GATEWAY_STOP_TIMEOUT/);
});

test('maintenance drains all child writers and permits a fresh worker only after the barrier', async t => {
  const held = deferred(), entered = deferred(), f = await fixture(t, { held, entered });
  const pending = f.runner(f.input(1)); await entered.promise;
  const draining = f.runner.drainIdle(); assert.equal(f.runner.drainIdle(), draining);
  await assert.rejects(f.runner(f.input(2)), /WARM_PAUSED/);
  held.ok({ runId: f.agents[0].params.idempotencyKey, status: 'ok', result: { payloads: [{ text: 'Synthetic answer' }] } });
  await pending; await draining;
  assert.equal(f.clients[0].stopped, true); assert.equal(f.children[0].child.kills.length, 1);
  // The mock held promise is already resolved with the old UUID. A new worker
  // must reach the fresh request and fail that stale result, proving no reuse.
  await assert.rejects(f.runner(f.input(3)), /RESPONSE_FAILED/);
  assert.equal(f.children.length, 2);
});
