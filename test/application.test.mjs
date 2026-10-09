import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { privateKeyToAccount } from 'viem/accounts';
import { createJeffApplication } from '../src/application.mjs';
import { createDurableJobReader, resolveMaintenanceMarkerPath } from '../src/maintenance.mjs';

const first = privateKeyToAccount('0x' + '12'.repeat(32)); // Disposable signing fixture; never a live RPC.
const second = privateKeyToAccount('0x' + '34'.repeat(32));
const collection = '0x' + '33'.repeat(20);
function deferred() {
  let resolvePromise;
  const promise = new Promise(resolveValue => { resolvePromise = resolveValue; });
  return { promise, resolve: resolvePromise };
}
async function fixture(t, overrides = {}) {
  const dataRoot = await mkdtemp(resolve('test', '.application-'));
  const ownership = { owner: first.address.toLowerCase(), ownerEpoch: 0 };
  const calls = [];
  const hosting = { enabled: false, freePassEnabled: false, plan: { tasksIncluded: 100 },
    status: async () => ({ active: true, source: 'test-fixture', expiresAt: '2099-01-01T00:00:00Z', usage: { remaining: 100, hourlyRemaining: 10, resetsAt: '2099-01-01T00:00:00Z' } }),
    requireActive: async () => {}, startJob: async (scope, start) => start() };
  const options = { dataRoot, origin: 'http://127.0.0.1:8788', startScheduler: false, fixture: true,
    env: { JEFF_CHAIN_ID: '4663', JEFF_COLLECTION: collection, JEFF_MODEL: 'bankr/fixture-model' }, hosting,
    resolveOwner: async () => ({ ...ownership }),
    runAgent: async args => { calls.push(args); return { text: `Fixture answer ${calls.length}`, model: 'bankr/fixture-model' }; }, ...overrides };
  let app;
  async function open() {
    app = await createJeffApplication(options);
    await new Promise(done => app.server.listen(0, '127.0.0.1', done));
    return app;
  }
  await open();
  t.after(async () => { await app.close(); await rm(dataRoot, { recursive: true, force: true }); });
  const api = async (path, { method = 'GET', input, session } = {}) => {
    const headers = { 'Content-Type': 'application/json' };
    if (session) headers.Authorization = `Bearer ${session.token}`;
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}${path}`, { method, headers, body: input === undefined ? undefined : JSON.stringify(input) });
    return { status: response.status, value: await response.json() };
  };
  const login = async (account = first) => {
    const challenge = await api('/api/auth/challenge', { method: 'POST', input: { wallet: account.address, tokenId: '35' } });
    assert.equal(challenge.status, 200);
    const signature = await account.signMessage({ message: challenge.value.message });
    const result = await api('/api/auth/verify', { method: 'POST', input: { nonce: challenge.value.nonce, signature } });
    assert.equal(result.status, 200); return result.value;
  };
  const terminal = async (session, id) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = await api(`/api/jobs/${id}`, { session });
      if (result.value.status !== 'running') return result;
      await delay(20);
    }
    throw new Error('Fixture job did not finish');
  };
  return { api, login, terminal, dataRoot, calls, ownership, get app() { return app; }, async reopen() { await app.close(); await open(); } };
}

test('real signed HTTP flow persists private context, binds conversation jobs, and reopens history', async t => {
  const f = await fixture(t);
  assert.equal((await f.api('/api/workspace')).status, 401);
  const session = await f.login();
  const current = await f.api('/api/workspace', { session });
  assert.equal(current.status, 200);
  const conversation = await f.api('/api/conversations', { method: 'POST', session, input: { title: 'Release acceptance' } });
  await f.api('/api/memory', { method: 'POST', session, input: { title: 'Style', text: 'Keep answers short. <script>untrusted</script>' } });
  const start = await f.api('/api/jobs', { method: 'POST', session, input: { objective: 'First question', conversationId: conversation.value.id } });
  assert.equal(start.status, 202);
  assert.equal((await f.terminal(session, start.value.id)).value.status, 'completed');
  assert.equal(f.calls[0].executionContext.memories[0].text, 'Keep answers short. <script>untrusted</script>');
  assert.deepEqual(f.calls[0].executionContext.history, []);
  const next = await f.api('/api/jobs', { method: 'POST', session, input: { objective: 'Follow up', conversationId: conversation.value.id } });
  assert.equal((await f.terminal(session, next.value.id)).value.status, 'completed');
  assert.equal(f.calls[1].executionContext.history[0].text, 'Fixture answer 1');
  await f.reopen();
  assert.equal((await f.api('/api/workspace', { session })).status, 401);
  const renewed = await f.login();
  const state = await f.api('/api/workspace/state', { session: renewed });
  assert.equal(state.status, 200);
  assert.equal(state.value.workspace.memories.length, 1);
  assert.equal(state.value.jobs.length, 2);
  assert.equal(state.value.workspace.conversations[0].jobIds.length, 2);
  assert.equal(state.value.usage.mode, 'operator-funded');
});

test('transfer revokes every private route and fresh owner/return epoch starts an empty workspace', async t => {
  const f = await fixture(t);
  const old = await f.login();
  await f.api('/api/memory', { method: 'POST', session: old, input: { title: 'Private', text: 'First holder only' } });
  f.ownership.owner = second.address.toLowerCase(); f.ownership.ownerEpoch = 1;
  for (const route of ['/api/workspace', '/api/workspace/state', '/api/inference', '/api/schedules', '/api/jobs']) assert.equal((await f.api(route, { session: old })).status, 401);
  const fresh = await f.login(second);
  assert.equal((await f.api('/api/workspace', { session: fresh })).value.memories.length, 0);
  f.ownership.owner = first.address.toLowerCase(); f.ownership.ownerEpoch = 2;
  const returned = await f.login();
  assert.equal((await f.api('/api/workspace', { session: returned })).value.memories.length, 0);
});

test('pause blocks admission, stop aborts only the owned child, and unknown request fields fail closed', async t => {
  const f = await fixture(t, { runAgent: async ({ signal }) => new Promise((done, reject) => {
    if (signal.aborted) reject(new Error('JEFF_OPENCLAW_CANCELLED'));
    else signal.addEventListener('abort', () => reject(new Error('JEFF_OPENCLAW_CANCELLED')), { once: true });
  }) });
  const session = await f.login();
  await f.api('/api/workspace/settings', { method: 'PATCH', session, input: { paused: true } });
  assert.equal((await f.api('/api/jobs', { method: 'POST', session, input: { objective: 'Blocked' } })).status, 409);
  await f.api('/api/workspace/settings', { method: 'PATCH', session, input: { paused: false } });
  assert.equal((await f.api('/api/jobs', { method: 'POST', session, input: { objective: 'Invalid', scope: {} } })).status, 400);
  const started = await f.api('/api/jobs', { method: 'POST', session, input: { objective: 'Wait for cancellation' } });
  assert.equal(started.status, 202);
  const stop = await f.api(`/api/jobs/${started.value.id}/stop`, { method: 'POST', session, input: {} });
  assert.equal(stop.status, 200); assert.equal(stop.value.stopRequested, true);
  assert.equal((await f.terminal(session, started.value.id)).value.status, 'failed');
});

test('schedule grants require an owned conversation and restore guard blocks new unattended grants', async t => {
  const f = await fixture(t);
  const session = await f.login();
  const conversation = (await f.api('/api/conversations', { method: 'POST', session, input: {} })).value;
  const input = { objective: 'Draft a short daily plan', conversationId: conversation.id, intervalMinutes: 60, maxRuns: 3,
    expiresAt: new Date(Date.now() + 86400000).toISOString() };
  const created = await f.api('/api/schedules', { method: 'POST', session, input });
  assert.equal(created.status, 201);
  assert.equal((await f.api('/api/schedules', { session })).value.schedules.length, 1);
  assert.equal((await f.api(`/api/schedules/${created.value.id}`, { method: 'DELETE', session })).status, 200);
  await mkdir(resolve(f.dataRoot, 'hosting'), { recursive: true });
  await writeFile(resolve(f.dataRoot, 'hosting', 'restore-guard.json'), '{}');
  assert.equal((await f.api('/api/schedules', { method: 'POST', session, input })).value.error, 'JEFF_RESTORE_GUARDED');
  assert.equal((await f.api('/api/config')).value.schedulesEnabled, false);
});

test('application publishes readiness where the backup reader expects its configured marker', async t => {
  const f = await fixture(t);
  await f.app.maintenance.pause();
  const marker = JSON.parse(await readFile(resolveMaintenanceMarkerPath({ env: {}, dataRoot: f.dataRoot }), 'utf8'));
  assert.equal(marker.status, 'ready');
  assert.equal(marker.pid, process.pid);
});

test('shutdown rejects an in-flight signed admission and direct submissions before a runner can start', async t => {
  const ownerCheck = deferred(), allowOwner = deferred();
  let holdOwner = false, runnerCalls = 0;
  const f = await fixture(t, {
    resolveOwner: async () => {
      if (holdOwner) { ownerCheck.resolve(); await allowOwner.promise; }
      return { owner: first.address.toLowerCase(), ownerEpoch: 0 };
    },
    runAgent: async ({ signal }) => {
      runnerCalls++;
      assert.equal(signal.aborted, false);
      return { text: 'An unexpected post-shutdown run', model: 'bankr/fixture-model' };
    },
  });
  t.after(() => allowOwner.resolve());
  const session = await f.login();
  holdOwner = true;
  const request = f.api('/api/jobs', { method: 'POST', session, input: { objective: 'Do not begin during shutdown' } });
  await ownerCheck.promise;
  const closed = f.app.close();
  assert.equal(f.app.maintenance.status().blocked, true);
  await assert.rejects(f.app.submit(session.scope, { objective: 'No direct admission either' }), /JEFF_SERVICE_MAINTENANCE/);
  allowOwner.resolve();
  const result = await request;
  assert.equal(result.status, 503);
  assert.equal(result.value.error, 'JEFF_SERVICE_MAINTENANCE');
  await closed;
  assert.equal(runnerCalls, 0);
});

test('shutdown rejects an admission already awaiting hosting without consuming a task or starting a runner', async t => {
  const hostingEntered = deferred(), allowHosting = deferred();
  let taskStarts = 0, runnerCalls = 0;
  const f = await fixture(t, {
    hosting: {
      enabled: false, freePassEnabled: false, plan: { tasksIncluded: 100 },
      status: async () => ({ active: true }),
      requireActive: async () => { hostingEntered.resolve(); await allowHosting.promise; },
      startJob: async (scope, start) => { taskStarts++; return start(); },
    },
    runAgent: async () => {
      runnerCalls++;
      return { text: 'An unexpected post-shutdown run', model: 'bankr/fixture-model' };
    },
  });
  const session = await f.login();
  const request = f.api('/api/jobs', { method: 'POST', session, input: { objective: 'Stop admission after its hosting await' } });
  await hostingEntered.promise;
  const closed = f.app.close();
  allowHosting.resolve();
  const result = await request;
  assert.equal(result.status, 503);
  assert.equal(result.value.error, 'JEFF_SERVICE_MAINTENANCE');
  await closed;
  assert.equal(taskStarts, 0);
  assert.equal(runnerCalls, 0);
});

test('shutdown cancels the already running child and waits for its failed record to be durable', async t => {
  const started = deferred();
  let aborts = 0;
  const f = await fixture(t, { runAgent: async ({ signal }) => {
    started.resolve();
    return new Promise((done, reject) => {
      signal.addEventListener('abort', () => { aborts++; reject(new Error('JEFF_OPENCLAW_CANCELLED')); }, { once: true });
    });
  } });
  const session = await f.login();
  const result = await f.api('/api/jobs', { method: 'POST', session, input: { objective: 'Wait for worker shutdown' } });
  assert.equal(result.status, 202);
  await started.promise;
  const firstClose = f.app.close();
  assert.equal(f.app.close(), firstClose);
  await firstClose;
  const record = await createDurableJobReader({ dataRoot: f.dataRoot, scope: session.scope, id: result.value.id })();
  assert.equal(aborts, 1);
  assert.equal(record.status, 'failed');
  assert.equal(record.saved, true);
});
