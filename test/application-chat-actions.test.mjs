import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { privateKeyToAccount } from 'viem/accounts';
import { createJeffApplication } from '../src/application.mjs';
import { createDurableJobReader } from '../src/maintenance.mjs';
import { scopeDirectory } from '../src/scope.mjs';

const testRoot = dirname(fileURLToPath(import.meta.url));
const first = privateKeyToAccount('0x' + '12'.repeat(32)); // Disposable fixture signing keys; no live RPC.
const second = privateKeyToAccount('0x' + '34'.repeat(32));
const collection = '0x' + '33'.repeat(20);
const memory = { type: 'memory.save', title: 'Project preference', text: 'Use short paragraphs in project updates.' };
const envelope = (action, text = 'Fixture proposed action; execution is owned by the host.') => JSON.stringify({ schema: 'jeff-chat-response-v1', text, action });
const deferred = () => {
  let resolvePromise;
  const promise = new Promise(done => { resolvePromise = done; });
  return { promise, resolve: resolvePromise };
};
const scheduleAction = (overrides = {}) => ({ type: 'schedule.create', objective: 'Draft a project summary.',
  intervalMinutes: 60, maxRuns: 3, expiresAt: new Date(Date.now() + 86400000).toISOString(), ...overrides });

async function fixture(t, { respond = async () => envelope(null, 'Fixture answer.'), hosting: suppliedHosting, onOwnerRead = async () => {} } = {}) {
  const dataRoot = await mkdtemp(resolve(testRoot, '.application-actions-'));
  const ownership = new Map(['35', '36'].map(tokenId => [tokenId, { owner: first.address.toLowerCase(), ownerEpoch: 0 }]));
  const calls = [], errors = [];
  let responder = respond, app;
  const hosting = suppliedHosting || { enabled: false, freePassEnabled: false, plan: { tasksIncluded: 100 },
    status: async () => ({ active: true, source: 'test-fixture', expiresAt: '2099-01-01T00:00:00Z',
      usage: { remaining: 100, hourlyRemaining: 10, resetsAt: '2099-01-01T00:00:00Z' } }),
    requireActive: async () => {}, startJob: async (scope, start) => start() };
  const options = { dataRoot, origin: 'http://127.0.0.1:8788', startScheduler: false, fixture: true,
    env: { JEFF_CHAIN_ID: '4663', JEFF_COLLECTION: collection, JEFF_MODEL: 'bankr/fixture-model' }, hosting,
    resolveOwner: async scope => { await onOwnerRead(scope); return { ...ownership.get(scope.tokenId) }; }, onRequestError: event => errors.push(event),
    runAgent: async args => { calls.push(args); return { text: await responder(args), model: 'bankr/fixture-model' }; } };
  async function open() {
    app = await createJeffApplication(options);
    await new Promise(done => app.server.listen(0, '127.0.0.1', done));
  }
  await open();
  t.after(async () => {
    await app.close();
    assert.equal(dirname(dataRoot), testRoot);
    await rm(dataRoot, { recursive: true, force: true });
  });
  const api = async (path, { method = 'GET', input, session } = {}) => {
    const headers = { 'Content-Type': 'application/json', Origin: options.origin };
    if (session) headers.Authorization = `Bearer ${session.token}`;
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}${path}`, {
      method, headers, body: input === undefined ? undefined : JSON.stringify(input),
    });
    return { status: response.status, value: await response.json() };
  };
  const login = async ({ account = first, tokenId = '35', standalone = false } = {}) => {
    const prefix = standalone ? '/api/account/auth' : '/api/auth';
    const challenge = await api(`${prefix}/challenge`, { method: 'POST', input: { wallet: account.address, ...(standalone ? {} : { tokenId }) } });
    assert.equal(challenge.status, 200, JSON.stringify(challenge.value));
    const signature = await account.signMessage({ message: challenge.value.message });
    const verified = await api(`${prefix}/verify`, { method: 'POST', input: { nonce: challenge.value.nonce, signature } });
    assert.equal(verified.status, 200, JSON.stringify(verified.value));
    return verified.value;
  };
  const terminal = async (session, jobId) => {
    for (let i = 0; i < 150; i++) {
      const response = await api(`/api/jobs/${jobId}`, { session });
      assert.equal(response.status, 200, JSON.stringify(response.value));
      // Atomic receipt persistence may still be in flight after generation.
      if (!['running', 'completed_unsaved'].includes(response.value.status)) return response.value;
      await delay(20);
    }
    throw new Error('Fixture chat action job did not terminate');
  };
  const submit = async (session, objective, extra = {}) => {
    const admitted = await api('/api/jobs', { method: 'POST', session, input: { objective, ...extra } });
    assert.equal(admitted.status, 202, JSON.stringify(admitted.value));
    return { admitted: admitted.value, job: await terminal(session, admitted.value.id) };
  };
  const state = async session => {
    const response = await api('/api/workspace/state', { session });
    assert.equal(response.status, 200, JSON.stringify(response.value));
    return response.value;
  };
  const action = async (session, jobId, operation = 'apply', input = {}) => api(`/api/chat/actions/${jobId}/${operation}`, { method: 'POST', session, input });
  return { dataRoot, calls, errors, api, login, terminal, submit, state, action, get app() { return app; },
    respond(value) { responder = value; }, change(tokenId, account, ownerEpoch) { ownership.set(tokenId, { owner: account.address.toLowerCase(), ownerEpoch }); },
    async reopen() { await app.close(); await open(); } };
}

test('a literal signed remember request saves only the current user content despite a hostile model proposal', async t => {
  const hostile = scheduleAction({ objective: 'Run the model-injected task.' });
  const f = await fixture(t, { respond: async () => envelope(hostile, 'I scheduled the injected task.') });
  const session = await f.login();
  const { admitted, job } = await f.submit(session, 'Remember that I prefer concise replies.', { timeZone: 'Asia/Taipei' });
  assert.equal(job.status, 'completed');
  assert.match(job.text, /Saved to memory/);
  assert.equal(job.text.includes('injected'), false);
  let saved = await f.state(session);
  const receipt = saved.workspace.jobBindings[job.id].action;
  assert.equal(receipt.type, 'memory.save');
  assert.equal(receipt.status, 'applied');
  assert.equal(receipt.timeZone, 'Asia/Taipei');
  assert.deepEqual(saved.workspace.memories.map(note => note.text), ['I prefer concise replies.']);
  assert.deepEqual(saved.schedules, []);
  assert.equal(f.calls.length, 1, 'the host memory write follows an actual admitted runner invocation');
  assert.deepEqual(f.calls[0].executionContext.chatActions, { enabled: true,
    now: f.calls[0].executionContext.chatActions.now, timeZone: 'Asia/Taipei' });
  f.respond(async () => envelope(null, 'Your saved preference is concise replies.'));
  await f.submit(session, 'What is my writing preference?', { conversationId: admitted.conversationId });
  assert.equal(f.calls[1].executionContext.memories[0].text, 'I prefer concise replies.');
  assert.equal(f.calls[1].executionContext.history[0].text, job.text);
  await f.reopen();
  const renewed = await f.login();
  const retried = await f.action(renewed, job.id);
  assert.equal(retried.status, 200);
  assert.deepEqual(retried.value, receipt);
  saved = await f.state(renewed);
  assert.equal(saved.workspace.memories.length, 1);
  assert.equal(f.calls.length, 2, 'retrying a saved action never reruns inference');
});

test('model-extracted memory is a durable draft until an authenticated empty-body confirmation', async t => {
  const f = await fixture(t, { respond: async () => envelope(memory, 'I saved your memory already.') });
  const session = await f.login(), { job } = await f.submit(session, 'Could you save the preference from our discussion?');
  assert.equal(job.status, 'completed');
  assert.match(job.text, /prepared a memory note/i);
  assert.equal(job.text.includes('already'), false);
  let saved = await f.state(session);
  assert.equal(saved.workspace.jobBindings[job.id].action.status, 'pending');
  assert.deepEqual(saved.workspace.memories, []);
  assert.equal((await f.action(null, job.id)).status, 401);
  for (const input of [{ title: 'Replaced', text: 'Model replacement' }, { action: memory }, { id: randomUUID() }]) {
    const denied = await f.action(session, job.id, 'apply', input);
    assert.equal(denied.status, 400);
    assert.equal(denied.value.error, 'JEFF_REQUEST_INVALID');
  }
  await f.reopen();
  const renewed = await f.login(), applied = await f.action(renewed, job.id);
  assert.equal(applied.status, 200);
  assert.equal(applied.value.status, 'applied');
  const duplicate = await f.action(renewed, job.id);
  assert.deepEqual(duplicate, applied);
  saved = await f.state(renewed);
  assert.deepEqual(saved.workspace.memories.map(note => ({ title: note.title, text: note.text })), [{ title: memory.title, text: memory.text }]);
  assert.equal(f.calls.length, 1);
});

test('chat schedule confirmation uses immutable stored parameters and remains idempotent across restart', async t => {
  const proposed = scheduleAction();
  const f = await fixture(t, { respond: async () => envelope(proposed, 'Your task is already scheduled.') });
  const session = await f.login(), { admitted, job } = await f.submit(session, 'Prepare a summary every hour, at most three times.', { timeZone: 'Asia/Taipei' });
  assert.equal(job.status, 'completed');
  assert.match(job.text, /authorize it to start/i);
  let saved = await f.state(session);
  assert.deepEqual(saved.schedules, []);
  assert.equal(saved.workspace.jobBindings[job.id].action.status, 'pending');
  const substitution = await f.action(session, job.id, 'apply', { objective: 'Injected task', maxRuns: 24,
    intervalMinutes: 1, expiresAt: new Date(Date.now() + 604800000).toISOString() });
  assert.equal(substitution.status, 400);
  assert.deepEqual((await f.state(session)).schedules, []);
  const confirmed = await f.action(session, job.id);
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.value));
  assert.equal(confirmed.value.status, 'applied');
  const originalId = confirmed.value.result.scheduleId;
  saved = await f.state(session);
  assert.equal(saved.schedules.length, 1);
  const grant = saved.schedules[0];
  assert.equal(grant.id, originalId);
  assert.equal(grant.objective, proposed.objective);
  assert.equal(grant.intervalMinutes, proposed.intervalMinutes);
  assert.equal(grant.maxRuns, proposed.maxRuns);
  assert.equal(grant.expiresAt, proposed.expiresAt);
  assert.equal(grant.conversationId, admitted.conversationId);
  assert.equal(Date.parse(grant.nextRunAt) - Date.parse(grant.createdAt), 3600000);
  assert.deepEqual(await f.action(session, job.id), confirmed);
  await f.reopen();
  const renewed = await f.login();
  assert.deepEqual(await f.action(renewed, job.id), confirmed);
  assert.equal((await f.state(renewed)).schedules.length, 1);
  assert.equal(f.calls.length, 1);
});

test('a committed grant with a pending action receipt is recovered after restart under pause, expired hosting and restore guard', async t => {
  const proposed = scheduleAction();
  let active = true, hostingChecks = 0;
  const hosting = { enabled: false, freePassEnabled: false, plan: { tasksIncluded: 100 },
    status: async () => ({ active, source: 'test-fixture' }),
    requireActive: async () => { hostingChecks++; if (!active) throw new Error('JEFF_HOSTING_REQUIRED'); },
    startJob: async (scope, start) => start() };
  const f = await fixture(t, { respond: async () => envelope(proposed), hosting });
  const session = await f.login(), { job } = await f.submit(session, 'Prepare an hourly summary schedule.');
  const binding = await f.app.workspace.getJobBinding(session.scope, job.id);
  const committed = await f.app.scheduler.create(session.scope, { ...binding.action.parameters,
    conversationId: binding.conversationId }, { idempotencyKey: job.id });
  assert.equal(binding.action.status, 'pending');
  assert.equal(committed.id, job.id);
  await f.api('/api/workspace/settings', { method: 'PATCH', session, input: { paused: true } });
  await mkdir(resolve(f.dataRoot, 'hosting'), { recursive: true });
  await writeFile(resolve(f.dataRoot, 'hosting', 'restore-guard.json'), '{}');
  active = false;
  const checksBeforeRecovery = hostingChecks;
  await f.reopen();
  const renewed = await f.login(), recovered = await f.action(renewed, job.id);
  assert.equal(recovered.status, 200, JSON.stringify(recovered.value));
  assert.equal(recovered.value.status, 'applied');
  assert.deepEqual(recovered.value.result, { scheduleId: committed.id });
  assert.equal(hostingChecks, checksBeforeRecovery, 'recovering a durable receipt must not request new hosting admission');
  assert.deepEqual(await f.action(renewed, job.id), recovered);
  const saved = await f.state(renewed);
  assert.equal(saved.workspace.settings.paused, true);
  assert.equal(saved.hosting.active, false);
  assert.equal(saved.schedules.length, 1);
  assert.deepEqual(saved.schedules[0], committed);
  assert.equal(f.calls.length, 1, 'grant recovery never runs the model again');
});

test('dismiss repairs a committed schedule receipt after restart instead of hiding an active grant', async t => {
  const f = await fixture(t, { respond: async () => envelope(scheduleAction()) });
  const session = await f.login(), { job } = await f.submit(session, 'Prepare an hourly summary schedule.');
  const binding = await f.app.workspace.getJobBinding(session.scope, job.id);
  const committed = await f.app.scheduler.create(session.scope, { ...binding.action.parameters,
    conversationId: binding.conversationId }, { idempotencyKey: job.id });
  // Simulate the process stopping after the grant write but before its receipt.
  await f.reopen();
  const renewed = await f.login(), dismissed = await f.action(renewed, job.id, 'dismiss');
  assert.equal(dismissed.status, 409);
  assert.equal(dismissed.value.error, 'JEFF_WORKSPACE_CONFLICT');
  const saved = await f.state(renewed);
  assert.equal(saved.workspace.jobBindings[job.id].action.status, 'applied');
  assert.deepEqual(saved.workspace.jobBindings[job.id].action.result, { scheduleId: committed.id });
  assert.deepEqual(saved.schedules, [committed]);
  assert.equal((await f.action(renewed, job.id)).status, 200);
  assert.equal((await f.action(renewed, job.id, 'dismiss')).status, 409);
  assert.equal(f.calls.length, 1, 'receipt recovery must not rerun inference');
});

test('existing-grant recovery rejects a grant that differs from the stored conversation plan', async t => {
  const proposed = scheduleAction(), f = await fixture(t, { respond: async () => envelope(proposed) });
  const session = await f.login(), { job } = await f.submit(session, 'Prepare an hourly summary schedule.');
  const binding = await f.app.workspace.getJobBinding(session.scope, job.id);
  await f.app.scheduler.create(session.scope, { ...binding.action.parameters, objective: 'A conflicting grant task.',
    conversationId: binding.conversationId }, { idempotencyKey: job.id });
  const denied = await f.action(session, job.id);
  assert.equal(denied.status, 409);
  assert.equal(denied.value.error, 'JEFF_WORKSPACE_CONFLICT');
  const saved = await f.state(session);
  assert.equal(saved.workspace.jobBindings[job.id].action.status, 'pending');
  assert.equal(saved.schedules.length, 1);
  assert.equal(saved.schedules[0].objective, 'A conflicting grant task.');
  assert.equal(f.calls.length, 1);
});

test('simultaneous signed confirmation and dismissal cannot create both terminal outcomes', async t => {
  const f = await fixture(t, { respond: async () => envelope(memory) });
  const session = await f.login(), { job } = await f.submit(session, 'Prepare a memory note from this conversation.');
  const attempts = await Promise.all([f.action(session, job.id), f.action(session, job.id, 'dismiss')]);
  assert.equal(attempts.filter(result => result.status === 200).length, 1);
  assert.equal(attempts.filter(result => result.status === 409).length, 1);
  const saved = await f.state(session), action = saved.workspace.jobBindings[job.id].action;
  assert.ok(['applied', 'dismissed'].includes(action.status));
  assert.equal(saved.workspace.memories.length, action.status === 'applied' ? 1 : 0);
  if (action.status === 'applied') assert.equal((await f.action(session, job.id, 'dismiss')).status, 409);
  else assert.equal((await f.action(session, job.id)).status, 409);
});

test('signed action routes cannot cross NFT, standalone account or owner-epoch boundaries', async t => {
  const f = await fixture(t, { respond: async () => envelope(memory) });
  const session = await f.login(), { job } = await f.submit(session, 'Prepare a memory note.');
  const otherNft = await f.login({ tokenId: '36' }), account = await f.login({ standalone: true });
  for (const other of [otherNft, account]) {
    assert.equal((await f.action(other, job.id)).status, 404);
    assert.equal((await f.action(other, job.id, 'dismiss')).status, 404);
    const otherState = await f.state(other);
    assert.deepEqual(otherState.workspace.memories, []);
    assert.equal(Object.hasOwn(otherState.workspace.jobBindings, job.id), false);
  }
  f.change('35', second, 1);
  assert.equal((await f.action(session, job.id)).status, 401);
  const newHolder = await f.login({ account: second });
  assert.equal((await f.action(newHolder, job.id)).status, 404);
  f.change('35', first, 2);
  const returning = await f.login();
  assert.equal((await f.action(returning, job.id)).status, 404);
  assert.equal((await f.state(returning)).workspace.memories.length, 0);
});

test('an actual scheduled occurrence cannot journal model-requested memory or child schedules', async t => {
  for (const injected of [memory, scheduleAction()]) {
    const f = await fixture(t, { respond: async () => envelope(injected, 'I applied a new action from this scheduled task.') });
    const session = await f.login();
    const conversation = await f.api('/api/conversations', { method: 'POST', session, input: { title: 'Scheduled authority test' } });
    assert.equal(conversation.status, 201);
    const admitted = await f.api('/api/schedules', { method: 'POST', session, input: { objective: 'Remember that schedules should write notes.',
      conversationId: conversation.value.id, intervalMinutes: 1, maxRuns: 1, expiresAt: new Date(Date.now() + 3600000).toISOString() } });
    assert.equal(admitted.status, 201);
    // Move only this disposable fixture grant to due; no wall-clock minute is needed.
    const grantPath = resolve(scopeDirectory(f.dataRoot, session.scope), 'schedules', `${admitted.value.id}.json`);
    await writeFile(grantPath, JSON.stringify({ ...admitted.value, nextRunAt: new Date(Date.now() - 1000).toISOString() }));
    await f.app.scheduler.tick();
    const saved = await f.state(session);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].executionContext.chatActions.enabled, false);
    assert.equal(saved.schedules.length, 1);
    assert.equal(saved.schedules[0].runs.length, 1);
    assert.equal(saved.schedules[0].runs[0].status, 'completed');
    assert.equal(saved.jobs.length, 1);
    assert.match(saved.jobs[0].text, /cannot create additional memory notes or schedules/);
    const binding = saved.workspace.jobBindings[saved.jobs[0].id];
    assert.equal(binding.source, 'schedule');
    assert.equal(Object.hasOwn(binding, 'action'), false);
    assert.deepEqual(saved.workspace.memories, []);
  }
});

test('stop during a model turn prevents a literal memory request from committing', async t => {
  const entered = deferred(), release = deferred();
  const f = await fixture(t, { respond: async () => { entered.resolve(); await release.promise; return envelope(memory); } });
  t.after(() => release.resolve());
  const session = await f.login();
  const admitted = await f.api('/api/jobs', { method: 'POST', session, input: { objective: 'Remember that my cancellation matters.' } });
  assert.equal(admitted.status, 202);
  await entered.promise;
  const stopped = await f.api(`/api/jobs/${admitted.value.id}/stop`, { method: 'POST', session, input: {} });
  assert.equal(stopped.status, 200);
  assert.equal(stopped.value.stopRequested, true);
  release.resolve();
  assert.equal((await f.terminal(session, admitted.value.id)).status, 'failed');
  const saved = await f.state(session);
  assert.deepEqual(saved.workspace.memories, []);
  assert.equal(Object.hasOwn(saved.workspace.jobBindings[admitted.value.id], 'action'), false);
});

for (const heldRead of [4, 5]) {
  test(`Stop during memory authorization read ${heldRead} prevents the final note commit`, { timeout: 15000 }, async t => {
    const entered = deferred(), release = deferred();
    let afterModel = false, ownerReads = 0;
    const f = await fixture(t, {
      respond: async () => { afterModel = true; return envelope(null, 'Fixture answer.'); },
      onOwnerRead: async () => {
        // Proposal reads are 1-3; memory checks are initial (4) and pre-write (5).
        if (afterModel && ++ownerReads === heldRead) { entered.resolve(); await release.promise; }
      },
    });
    t.after(() => release.resolve());
    const session = await f.login();
    const admitted = await f.api('/api/jobs', { method: 'POST', session,
      input: { objective: 'Remember that a stopped write must never commit.' } });
    assert.equal(admitted.status, 202);
    await entered.promise;
    const stopped = await f.api(`/api/jobs/${admitted.value.id}/stop`, { method: 'POST', session, input: {} });
    assert.equal(stopped.status, 200);
    assert.equal(stopped.value.stopRequested, true);
    assert.equal(f.calls[0].signal.aborted, true);
    release.resolve();
    assert.equal((await f.terminal(session, admitted.value.id)).status, 'failed');
    const saved = await f.state(session);
    assert.deepEqual(saved.workspace.memories, []);
    assert.equal(saved.workspace.jobBindings[admitted.value.id].action.status, 'pending');
  });
}

test('pause while a model turn is pending prevents the proposed memory write', async t => {
  const entered = deferred(), release = deferred();
  const f = await fixture(t, { respond: async () => { entered.resolve(); await release.promise; return envelope(memory); } });
  t.after(() => release.resolve());
  const session = await f.login();
  const admitted = await f.api('/api/jobs', { method: 'POST', session, input: { objective: 'Remember that paused agents must not save this.' } });
  assert.equal(admitted.status, 202); await entered.promise;
  assert.equal((await f.api('/api/workspace/settings', { method: 'PATCH', session, input: { paused: true } })).status, 200);
  release.resolve();
  assert.equal((await f.terminal(session, admitted.value.id)).status, 'failed');
  const saved = await f.state(session);
  assert.deepEqual(saved.workspace.memories, []);
  assert.equal(Object.hasOwn(saved.workspace.jobBindings[admitted.value.id], 'action'), false);
});

test('a restore guard appearing during inference blocks host action writes before journaling', async t => {
  const entered = deferred(), release = deferred();
  const f = await fixture(t, { respond: async () => { entered.resolve(); await release.promise; return envelope(memory); } });
  t.after(() => release.resolve());
  const session = await f.login();
  const admitted = await f.api('/api/jobs', { method: 'POST', session, input: { objective: 'Remember that restored storage is guarded.' } });
  assert.equal(admitted.status, 202); await entered.promise;
  await mkdir(resolve(f.dataRoot, 'hosting'), { recursive: true });
  await writeFile(resolve(f.dataRoot, 'hosting', 'restore-guard.json'), '{}');
  release.resolve();
  assert.equal((await f.terminal(session, admitted.value.id)).status, 'failed');
  const saved = await f.state(session);
  assert.deepEqual(saved.workspace.memories, []);
  assert.equal(Object.hasOwn(saved.workspace.jobBindings[admitted.value.id], 'action'), false);
});

test('transfer during inference discards the proposal before any old-holder memory is committed', async t => {
  const entered = deferred(), release = deferred();
  const f = await fixture(t, { respond: async () => { entered.resolve(); await release.promise; return envelope(memory); } });
  t.after(() => release.resolve());
  const session = await f.login();
  const admitted = await f.api('/api/jobs', { method: 'POST', session, input: { objective: 'Remember that only the current holder can save this.' } });
  assert.equal(admitted.status, 202); await entered.promise;
  f.change('35', second, 1); release.resolve();
  const read = createDurableJobReader({ dataRoot: f.dataRoot, scope: session.scope, id: admitted.value.id });
  for (let i = 0; i < 100; i++) { if ((await read()).status === 'failed') break; await delay(10); }
  assert.equal((await read()).status, 'failed');
  assert.equal((await f.action(session, admitted.value.id)).status, 401);
  const oldState = JSON.parse(await readFile(resolve(scopeDirectory(f.dataRoot, session.scope), 'workspace-state.json'), 'utf8'));
  assert.deepEqual(oldState.memories, []);
  assert.equal(Object.hasOwn(oldState.jobBindings[admitted.value.id], 'action'), false);
});

test('malformed claimed action envelopes fail closed without persisting a literal memory command', async t => {
  const outputs = [
    '{"schema":"jeff-chat-response-v1","text":"Saved","action":',
    JSON.stringify({ schema: 'jeff-chat-response-v1', text: 'Saved', action: memory, privileged: true }),
    envelope({ ...memory, trusted: true }),
    envelope({ type: 'shell.exec', command: 'forbidden' }),
  ];
  for (const output of outputs) {
    const f = await fixture(t, { respond: async () => output });
    const session = await f.login(), { job } = await f.submit(session, 'Remember that invalid outputs never authorize writes.');
    assert.equal(job.status, 'failed');
    const saved = await f.state(session);
    assert.deepEqual(saved.workspace.memories, []);
    assert.equal(Object.hasOwn(saved.workspace.jobBindings[job.id], 'action'), false);
  }
});

test('invalid timezones are rejected before model inference or task admission', async t => {
  const f = await fixture(t), session = await f.login();
  for (const timeZone of ['Nowhere/Clock', '+08:00', '', 8, 'Asia/Taipei\n']) {
    const response = await f.api('/api/jobs', { method: 'POST', session, input: { objective: 'Remember that no invalid zone may trigger inference.', timeZone } });
    assert.equal(response.status, 400);
    assert.equal(response.value.error, 'JEFF_CHAT_ACTION_INVALID');
  }
  assert.equal(f.calls.length, 0);
  assert.deepEqual((await f.state(session)).jobs, []);
});

test('one-off future-time proposals preserve the first run while ambiguous scheduling stays a normal reply', async t => {
  const firstRunAt = new Date(Date.now() + 2 * 3600000).toISOString();
  const proposed = scheduleAction({ maxRuns: 1, firstRunAt });
  const f = await fixture(t, { respond: async () => envelope(proposed) });
  const session = await f.login(), { job } = await f.submit(session, 'Remind me to draft an update in two hours.', { timeZone: 'Asia/Taipei' });
  assert.equal(job.status, 'completed');
  const applied = await f.action(session, job.id);
  assert.equal(applied.status, 200, JSON.stringify(applied.value));
  const saved = await f.state(session);
  assert.equal(saved.schedules.length, 1);
  assert.equal(saved.schedules[0].firstRunAt, firstRunAt);
  assert.equal(saved.schedules[0].nextRunAt, firstRunAt);
  assert.equal(saved.schedules[0].maxRuns, 1);
  f.respond(async () => envelope(null, 'What time should I run that task?'));
  const ambiguous = await f.submit(session, 'Do this later.');
  assert.equal(ambiguous.job.status, 'completed');
  assert.equal(ambiguous.job.text, 'What time should I run that task?');
  const after = await f.state(session);
  assert.equal(Object.hasOwn(after.workspace.jobBindings[ambiguous.job.id], 'action'), false);
  assert.equal(after.schedules.length, 1);
});

test('applied receipts stay readable under pause and restore guards while pending confirmations remain blocked', async t => {
  const f = await fixture(t, { respond: async () => envelope(memory) }), session = await f.login();
  const appliedJob = (await f.submit(session, 'Prepare a memory note.')).job;
  const receipt = await f.action(session, appliedJob.id);
  assert.equal(receipt.status, 200);
  const pendingJob = (await f.submit(session, 'Prepare another memory note.')).job;
  await f.api('/api/workspace/settings', { method: 'PATCH', session, input: { paused: true } });
  assert.deepEqual(await f.action(session, appliedJob.id), receipt);
  const paused = await f.action(session, pendingJob.id);
  assert.equal(paused.status, 409);
  assert.equal(paused.value.error, 'JEFF_AGENT_PAUSED');
  await f.api('/api/workspace/settings', { method: 'PATCH', session, input: { paused: false } });
  await mkdir(resolve(f.dataRoot, 'hosting'), { recursive: true });
  await writeFile(resolve(f.dataRoot, 'hosting', 'restore-guard.json'), '{}');
  assert.deepEqual(await f.action(session, appliedJob.id), receipt);
  const guarded = await f.action(session, pendingJob.id);
  assert.equal(guarded.status, 503);
  assert.equal(guarded.value.error, 'JEFF_RESTORE_GUARDED');
  const saved = await f.state(session);
  assert.equal(saved.workspace.memories.length, 1);
  assert.equal(saved.workspace.jobBindings[pendingJob.id].action.status, 'pending');
});
