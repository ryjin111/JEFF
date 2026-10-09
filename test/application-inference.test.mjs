import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { privateKeyToAccount } from 'viem/accounts';
import { createJeffApplication } from '../src/application.mjs';
import { createOpenClawRunner } from '../src/openclaw-runner.mjs';

const testRoot = dirname(fileURLToPath(import.meta.url));
const signer = privateKeyToAccount('0x' + '12'.repeat(32)); // Disposable, local signing fixture.
const collection = '0x' + '33'.repeat(20);
const scope = { chainId: 4663, collection, tokenId: '35', owner: signer.address.toLowerCase(), ownerEpoch: 0 };
const tariff = { basis: 'operator-token-tariff', policyId: 'fixture-rate-v1',
  inputMicrosPerMillionTokens: 1000000, outputMicrosPerMillionTokens: 2000000 };
const completion = () => ({ id: 'local-provider-receipt', model: 'fixture', object: 'chat.completion', created: 1,
  choices: [{ index: 0, message: { role: 'assistant', content: 'Local provider fixture response.' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } });

async function fixture(t, { actualCli = false, mode = 'complete', funds = 100000, oversized = false } = {}) {
  const dataRoot = await mkdtemp(resolve(testRoot, '.application-inference-'));
  const providerCalls = [], children = [];
  let entered;
  const providerEntered = new Promise(done => { entered = done; });
  const provider = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    providerCalls.push({ path: request.url, key: request.headers['x-api-key'], input: JSON.parse(raw) });
    entered();
    if (mode === 'hang') return;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(mode === 'missing-usage' ? { ...completion(), usage: undefined } : completion()));
  });
  await new Promise(done => provider.listen(0, '127.0.0.1', done));
  const env = { ...Object.fromEntries(['PATH','Path','SystemRoot','WINDIR','USERPROFILE','COMSPEC','LANG'].filter(key => process.env[key]).map(key => [key, process.env[key]])),
    JEFF_CHAIN_ID: '4663', JEFF_COLLECTION: collection, JEFF_MODEL: 'bankr/fixture', JEFF_ALLOWED_MODELS: 'bankr/fixture',
    JEFF_INFERENCE_CREDITS_ENABLED: 'true', JEFF_INFERENCE_PRICING: JSON.stringify({ fixture: tariff }),
    BANKR_LLM_URL: `http://127.0.0.1:${provider.address().port}/v1`, BANKR_LLM_API_KEY: 'provider-fixture-key-never-for-child' };
  const simulatedSpawn = (_node, _arguments, options) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    let closed = false;
    const close = code => { if (!closed) { closed = true; child.emit('close', code); } };
    child.kill = () => { queueMicrotask(() => close(1)); return true; };
    queueMicrotask(async () => {
      try {
        const config = JSON.parse(await readFile(options.env.OPENCLAW_CONFIG_PATH, 'utf8'));
        const baseUrl = config.models.providers.bankr.baseUrl;
        const response = await fetch(baseUrl + '/chat/completions', { method: 'POST',
          headers: { Authorization: `Bearer ${options.env.JEFF_INFERENCE_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'fixture', messages: [{ role: 'user', content: oversized ? 'x'.repeat(70000) : 'Explicit child fixture' }], max_tokens: 4096 }) });
        if (!response.ok) { await response.text(); close(1); return; }
        const output = await response.json();
        if (!closed) child.stdout.write(JSON.stringify({ payloads: [{ text: output.choices[0].message.content }], meta: { agentMeta: { usage: { input: 50, output: 10, total: 60 } } } }));
        close(0);
      } catch { close(1); }
    });
    return child;
  };
  const spawnProcess = (node, args, options) => {
    children.push({ keys: Object.keys(options.env), gatewayKeyPresent: Boolean(options.env.JEFF_INFERENCE_API_KEY),
      upstreamKeyPresent: Object.values(options.env).includes(env.BANKR_LLM_API_KEY) });
    return actualCli ? spawn(node, args, options) : simulatedSpawn(node, args, options);
  };
  const runAgent = createOpenClawRunner({ env, model: 'bankr/fixture', allowedModels: ['bankr/fixture'], spawnProcess });
  let taskStarts = 0;
  const hosting = { enabled: false, freePassEnabled: false, plan: { tasksIncluded: 100 },
    status: async () => ({ active: true, source: 'explicit-test-hosting', expiresAt: '2099-01-01T00:00:00Z', usage: { remaining: 100 } }),
    requireActive: async () => {}, startJob: async (_scope, start) => { taskStarts++; return start(); } };
  const app = await createJeffApplication({ dataRoot, env, origin: 'http://127.0.0.1:8788', startScheduler: false,
    fixture: true, hosting, resolveOwner: async () => ({ owner: scope.owner, ownerEpoch: 0 }), runAgent });
  if (funds) { app.inference.fund({ receiptId: 'fixture-provider-capacity', amountMicros: funds });
    app.inference.grant({ grantId: 'fixture-holder-grant', receiptId: 'fixture-provider-capacity', chainId: scope.chainId, wallet: scope.owner, amountMicros: funds }); }
  await new Promise(done => app.server.listen(0, '127.0.0.1', done));
  t.after(async () => {
    await app.close(); provider.closeAllConnections(); await new Promise(done => provider.close(done));
    assert.equal(dirname(dataRoot), testRoot); await rm(dataRoot, { recursive: true, force: true });
  });
  const api = async (path, { method = 'GET', input, session } = {}) => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}${path}`, { method,
      headers: { 'Content-Type': 'application/json', ...(session ? { Authorization: `Bearer ${session.token}` } : {}) },
      body: input === undefined ? undefined : JSON.stringify(input) });
    return { status: response.status, value: await response.json() };
  };
  const login = async () => {
    const challenge = await api('/api/auth/challenge', { method: 'POST', input: { wallet: signer.address, tokenId: '35' } });
    assert.equal(challenge.status, 200);
    const signature = await signer.signMessage({ message: challenge.value.message });
    const verified = await api('/api/auth/verify', { method: 'POST', input: { nonce: challenge.value.nonce, signature } });
    assert.equal(verified.status, 200); return verified.value;
  };
  const terminal = async (session, id) => {
    for (let count = 0; count < 600; count++) {
      const result = await api(`/api/jobs/${id}`, { session });
      if (result.value.status !== 'running') return result.value;
      await delay(100);
    }
    throw new Error('Fixture exceeded its one minute job deadline');
  };
  return { app, api, login, terminal, providerCalls, children, providerEntered, get taskStarts() { return taskStarts; } };
}

test('signed app + installed OpenClaw + scoped gateway settles funded usage and persists private memory', async t => {
  const f = await fixture(t, { actualCli: true }), session = await f.login();
  assert.equal((await f.api('/api/inference')).status, 401);
  const memory = await f.api('/api/memory', { method: 'POST', session, input: { title: 'Fixture preference', text: 'Remember the copper owl fixture.' } });
  assert.equal(memory.status, 200);
  const submitted = await f.api('/api/jobs', { method: 'POST', session, input: { objective: 'Summarize the supplied local fixture.' } });
  assert.equal(submitted.status, 202);
  const result = await f.terminal(session, submitted.value.id);
  assert.equal(result.status, 'completed'); assert.equal(result.text, 'Local provider fixture response.');
  assert.equal(f.providerCalls.length, 1); assert.equal(f.providerCalls[0].key, 'provider-fixture-key-never-for-child');
  assert.match(JSON.stringify(f.providerCalls[0].input.messages), /copper owl fixture/);
  assert.equal(f.children.length, 1); assert.equal(f.children[0].gatewayKeyPresent, true); assert.equal(f.children[0].upstreamKeyPresent, false);
  const usage = await f.api('/api/inference', { session });
  assert.equal(usage.value.balance.chargedMicros, 70); assert.equal(usage.value.balance.heldMicros, 0);
  assert.equal(usage.value.transactions.find(item => item.type === 'reservation').details.providerDebitVerified, false);
  const followUp = await f.api('/api/jobs', { method: 'POST', session,
    input: { objective: 'Follow up using the saved fixture conversation and memory.', conversationId: submitted.value.conversationId } });
  assert.equal(followUp.status, 202); assert.equal((await f.terminal(session, followUp.value.id)).status, 'completed');
  assert.equal(f.providerCalls.length, 2);
  assert.match(JSON.stringify(f.providerCalls[1].input.messages), /Local provider fixture response/);
  assert.match(JSON.stringify(f.providerCalls[1].input.messages), /copper owl fixture/);
  assert.ok(f.children.every(child => child.gatewayKeyPresent && !child.upstreamKeyPresent));
  const retry = await f.api(`/api/jobs/${submitted.value.id}/retry-save`, { method: 'POST', session, input: {} });
  assert.equal(retry.status, 200); assert.equal(f.providerCalls.length, 2); assert.equal(f.app.inference.balance(scope).chargedMicros, 140);
});

test('known insufficient funds and selected agent daily cap fail before consuming a hosting task', async t => {
  const f = await fixture(t, { funds: 1 }), session = await f.login();
  const unfunded = await f.api('/api/jobs', { method: 'POST', session, input: { objective: 'Cannot cover a worst-case request' } });
  assert.ok([402,429,503].includes(unfunded.status)); assert.equal(f.providerCalls.length, 0); assert.equal(f.taskStarts, 0); assert.equal(f.children.length, 0);
  f.app.inference.fund({ receiptId: 'additional-fixture-capacity', amountMicros: 100000 });
  f.app.inference.grant({ grantId: 'additional-fixture-grant', receiptId: 'additional-fixture-capacity', chainId: scope.chainId, wallet: scope.owner, amountMicros: 100000 });
  const setting = await f.api('/api/workspace/settings', { method: 'PATCH', session, input: { dailyBudgetMicros: 24575 } });
  assert.equal(setting.status, 200);
  const capped = await f.api('/api/jobs', { method: 'POST', session, input: { objective: 'Cannot fit the selected agent cap' } });
  assert.equal(capped.status, 429); assert.equal(f.providerCalls.length, 0); assert.equal(f.taskStarts, 0);
});

test('runtime context bypass is rejected by the gateway before provider spending or charge', async t => {
  const f = await fixture(t, { oversized: true }), session = await f.login();
  const submitted = await f.api('/api/jobs', { method: 'POST', session, input: { objective: 'Oversized simulated child request' } });
  assert.equal(submitted.status, 202); assert.equal((await f.terminal(session, submitted.value.id)).status, 'failed');
  assert.equal(f.providerCalls.length, 0); assert.equal(f.app.inference.balance(scope).chargedMicros, 0); assert.equal(f.app.inference.balance(scope).heldMicros, 0);
});

test('stop aborts the runtime and the provider request drains into a durable unknown hold before maintenance ready', async t => {
  const f = await fixture(t, { mode: 'hang' }), session = await f.login();
  const submitted = await f.api('/api/jobs', { method: 'POST', session, input: { objective: 'Wait for explicit cancellation' } });
  assert.equal(submitted.status, 202); await f.providerEntered;
  const held = f.app.inference.balance(scope).heldMicros;
  assert.ok(held > 0);
  const stopped = await f.api(`/api/jobs/${submitted.value.id}/stop`, { method: 'POST', session, input: {} });
  assert.equal(stopped.value.stopRequested, true);
  assert.equal((await f.terminal(session, submitted.value.id)).status, 'failed');
  const ready = await f.app.maintenance.pause();
  assert.equal(ready.pendingTasks, 0); assert.equal(f.app.gateway.status().activeRequests, 0);
  const call = f.app.inference.list(scope).find(item => item.type === 'reservation');
  assert.equal(call.state, 'unknown'); assert.equal(f.app.inference.balance(scope).heldMicros, held);
  assert.throws(() => f.app.inference.release(call.id), /RECONCILIATION_REQUIRED/);
});

test('an app provider response with missing usage retains backing until explicit operator reconciliation', async t => {
  const f = await fixture(t, { mode: 'missing-usage' }), session = await f.login();
  const submitted = await f.api('/api/jobs', { method: 'POST', session, input: { objective: 'Unmeterable local provider fixture' } });
  assert.equal((await f.terminal(session, submitted.value.id)).status, 'failed');
  await f.app.gateway.drain();
  const call = f.app.inference.list(scope).find(item => item.type === 'reservation');
  assert.equal(call.state, 'unknown'); assert.equal(f.providerCalls.length, 1);
  f.app.inference.reconcile({ id: call.id, chargedMicros: 70, evidenceId: 'verified-local-fixture-usage' });
  assert.equal(f.app.inference.balance(scope).heldMicros, 0); assert.equal(f.app.inference.balance(scope).chargedMicros, 70);
});
