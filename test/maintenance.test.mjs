import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createJeffOpenClawAccountBridge } from 'jeff-agent-nft/openclaw';
import { createDurableJobReader, createMaintenanceGate, waitForDurableJob, resolveMaintenanceMarkerPath } from '../src/maintenance.mjs';

const scope = { kind: 'account', chainId: 4663, owner: '0x' + '11'.repeat(20) };
const id = 'maintenance-job';

function deferred() {
  let resolvePromise, reject;
  const promise = new Promise((resolveValue, rejectValue) => { resolvePromise = resolveValue; reject = rejectValue; });
  return { promise, resolve: resolvePromise, reject };
}

async function fixture(t, { open = true } = {}) {
  const root = await mkdtemp(resolve('test', '.maintenance-'));
  const markerPath = resolve(root, 'ready.json');
  t.after(() => rm(root, { recursive: true, force: true }));
  const gate = createMaintenanceGate({ markerPath, releaseSha: 'release-test', pid: 12345 });
  if (open) await gate.resume();
  return { root, markerPath, gate };
}

async function noMarker(path) {
  await assert.rejects(readFile(path), { code: 'ENOENT' });
}

function track(gate, promise, label) {
  // The gate owns the failure; also observe a returned promise if it exposes one.
  const tracked = gate.track(promise, label);
  if (tracked?.catch) tracked.catch(() => {});
  return tracked;
}

test('backup reader and maintenance writer share data-root defaults and explicit marker overrides', async t => {
  const { root } = await fixture(t, { open: false });
  for (const env of [{ JEFF_DATA_ROOT: root }, { JEFF_DATA_ROOT: root, JEFF_MAINTENANCE_MARKER: resolve(root, 'custom-ready.json') }]) {
    const writerPath = resolveMaintenanceMarkerPath({ env, dataRoot: root });
    const readerPath = resolveMaintenanceMarkerPath({ env });
    assert.equal(writerPath, readerPath);
    assert.equal(writerPath, env.JEFF_MAINTENANCE_MARKER || resolve(root, 'maintenance.json'));
    const gate = createMaintenanceGate({ markerPath: writerPath, pid: 12345 });
    await gate.resume();
    const requestDone = gate.beginRequest();
    const paused = gate.pause();
    await noMarker(readerPath);
    requestDone();
    await paused;
    const marker = JSON.parse(await readFile(readerPath, 'utf8'));
    assert.equal(marker.status, 'ready');
    assert.equal(marker.pid, 12345);
    await gate.resume();
    await noMarker(readerPath);
  }
  assert.notEqual(resolveMaintenanceMarkerPath({ env: {}, dataRoot: resolve(root, 'one') }),
    resolveMaintenanceMarkerPath({ env: {}, dataRoot: resolve(root, 'two') }));
});

test('startup keeps requests blocked until resume removes stale readiness', async t => {
  const { gate, markerPath } = await fixture(t, { open: false });
  await writeFile(markerPath, JSON.stringify({ status: 'ready', pid: 1, releaseSha: 'old-release' }));
  assert.equal(gate.status().blocked, true);
  assert.equal(gate.beginRequest(), null);
  const resumed = gate.resume();
  assert.equal(gate.beginRequest(), null);
  await resumed;
  await noMarker(markerPath);
  const finish = gate.beginRequest();
  assert.equal(typeof finish, 'function');
  finish();
});

test('pause blocks new requests immediately and writes readiness only after every request drains', async t => {
  const { gate, markerPath } = await fixture(t);
  const finishFirst = gate.beginRequest();
  const finishSecond = gate.beginRequest();
  assert.equal(typeof finishFirst, 'function');
  assert.equal(typeof finishSecond, 'function');
  const paused = gate.pause();
  assert.equal(gate.status().blocked, true);
  assert.equal(gate.status().activeRequests, 2);
  assert.equal(gate.beginRequest(), null);
  await noMarker(markerPath);

  finishFirst();
  finishFirst();
  assert.equal(gate.status().activeRequests, 1);
  await noMarker(markerPath);
  finishSecond();
  const ready = await paused;
  assert.deepEqual(JSON.parse(await readFile(markerPath, 'utf8')), ready);
  assert.equal(ready.releaseSha, 'release-test');
  assert.equal(ready.pid, 12345);
  assert.equal(gate.status().activeRequests, 0);

  await gate.resume();
  await noMarker(markerPath);
  assert.equal(gate.status().blocked, false);
  const finishAfterResume = gate.beginRequest();
  assert.equal(typeof finishAfterResume, 'function');
  finishAfterResume();
});

test('a tracked background job holds readiness until retrieval confirms saved terminal output', async t => {
  const { root, gate, markerPath } = await fixture(t);
  const resultPath = resolve(root, 'result.json');
  const firstPoll = deferred();
  let saved = false;
  let polls = 0;
  const bridge = { async retrieve(actualScope, actualId) {
    assert.deepEqual(actualScope, scope);
    assert.equal(actualId, id);
    polls++;
    if (!saved) {
      firstPoll.resolve();
      return { id, scope, status: 'running', saved: false };
    }
    return JSON.parse(await readFile(resultPath, 'utf8'));
  } };
  const durable = waitForDurableJob({ bridge, scope, id, pollMs: 1, timeoutMs: 1000 });
  track(gate, durable, 'job completion');
  await firstPoll.promise;
  const paused = gate.pause();
  assert.equal(gate.status().pendingTasks, 1);
  await noMarker(markerPath);

  const record = { id, scope, status: 'completed', saved: true, text: 'Persisted output' };
  await writeFile(resultPath, JSON.stringify(record));
  saved = true;
  assert.deepEqual(await durable, record);
  await paused;
  assert.ok(polls >= 2);
  assert.equal(gate.status().pendingTasks, 0);
  assert.equal(JSON.parse(await readFile(markerPath, 'utf8')).releaseSha, 'release-test');
});

test('a saved failed job is a durable terminal result and permits readiness', async t => {
  const { gate, markerPath } = await fixture(t);
  const record = { id, scope, status: 'failed', saved: true, error: 'Model execution failed' };
  const durable = waitForDurableJob({ bridge: { retrieve: async () => record }, scope, id, pollMs: 1, timeoutMs: 1000 });
  track(gate, durable, 'failed job');
  const paused = gate.pause();
  assert.deepEqual(await durable, record);
  await paused;
  assert.equal(gate.status().pendingTasks, 0);
  assert.ok(JSON.parse(await readFile(markerPath, 'utf8')));
});

test('real bridge completion remains tracked while its terminal save is in flight after the request returns', async t => {
  const { root, gate, markerPath } = await fixture(t);
  const run = deferred(), allowSave = deferred(), terminalSave = deferred(), observedUnsaved = deferred();
  t.after(() => { run.resolve({ text: 'Persisted bridge result' }); allowSave.resolve(); });
  let terminalFile;
  const options = { dataRoot: resolve(root, 'data'), resolveAccount: async () => true,
    runAgent: () => run.promise,
    async persistRecord(directory, record) {
      await mkdir(directory, { recursive: true });
      const file = resolve(directory, `${record.id}.json`);
      if (record.status === 'completed') {
        terminalFile = file;
        terminalSave.resolve();
        await allowSave.promise;
      }
      await writeFile(file, JSON.stringify(record));
    } };
  const bridge = createJeffOpenClawAccountBridge(options);
  const finishRequest = gate.beginRequest();
  const started = await bridge.start(scope, 'Produce a durable result');
  const observedBridge = { async retrieve(...args) {
    const record = await bridge.retrieve(...args);
    if (record.status === 'completed_unsaved') observedUnsaved.resolve();
    return record;
  } };
  const durable = waitForDurableJob({ bridge: observedBridge, scope, id: started.id, pollMs: 1, timeoutMs: 1000 });
  track(gate, durable, 'real bridge completion');
  finishRequest();
  const paused = gate.pause();
  run.resolve({ text: 'Persisted bridge result' });
  await terminalSave.promise;
  await observedUnsaved.promise;
  assert.equal(gate.status().activeRequests, 0);
  assert.equal(gate.status().pendingTasks, 1);
  assert.equal(JSON.parse(await readFile(terminalFile, 'utf8')).status, 'running');
  await noMarker(markerPath);

  allowSave.resolve();
  const result = await durable;
  await paused;
  assert.equal(result.status, 'completed');
  assert.equal(result.saved, true);
  const reopened = createJeffOpenClawAccountBridge({ ...options, runAgent: () => { throw new Error('Model execution forbidden'); } });
  assert.deepEqual(await reopened.retrieve(scope, started.id), result);
  assert.deepEqual(JSON.parse(await readFile(terminalFile, 'utf8')), result);
  assert.ok(JSON.parse(await readFile(markerPath, 'utf8')));
});

test('disk reader accepts valid saved terminal records without authorizing through the bridge', async t => {
  const { root } = await fixture(t);
  const dataRoot = resolve(root, 'data');
  let authorizations = 0;
  const options = { dataRoot, resolveAccount: async () => { authorizations++; return true; },
    runAgent: async () => ({ text: 'Durable disk result' }) };
  const bridge = createJeffOpenClawAccountBridge(options);
  const result = await bridge.run(scope, 'Save a result');
  const readRecord = createDurableJobReader({ dataRoot, scope, id: result.id });
  const afterRun = authorizations;
  assert.deepEqual(await readRecord(), result);
  assert.deepEqual(await waitForDurableJob({ readRecord, pollMs: 1, timeoutMs: 1000 }), result);
  assert.equal(authorizations, afterRun);

  const workspace = createHash('sha256').update(JSON.stringify(scope)).digest('hex');
  const file = resolve(dataRoot, workspace, 'results', `${result.id}.json`);
  const failed = { ...result, status: 'failed', error: 'JEFF_OPENCLAW_JOB_FAILED' };
  delete failed.text;
  delete failed.textSha256;
  await writeFile(file, JSON.stringify(failed));
  assert.deepEqual(await readRecord(), failed);
  assert.deepEqual(await waitForDurableJob({ readRecord, pollMs: 1, timeoutMs: 1000 }), failed);
  assert.equal(authorizations, afterRun);
});

test('disk reader rejects saved result scope, id, schema and content tampering', async t => {
  const { root } = await fixture(t);
  const dataRoot = resolve(root, 'data');
  const bridge = createJeffOpenClawAccountBridge({ dataRoot, resolveAccount: async () => true,
    runAgent: async () => ({ text: 'Original saved result' }) });
  const result = await bridge.run(scope, 'Save a result for validation');
  const workspace = createHash('sha256').update(JSON.stringify(scope)).digest('hex');
  const file = resolve(dataRoot, workspace, 'results', `${result.id}.json`);
  const readRecord = createDurableJobReader({ dataRoot, scope, id: result.id });
  const cases = [
    ['scope', { ...result, scope: { ...scope, owner: '0x' + '22'.repeat(20) } }],
    ['id', { ...result, id: '00000000-0000-4000-8000-000000000000' }],
    ['schema', { ...result, schema: 'unexpected-job-schema' }],
    ['text', { ...result, text: 'Tampered after persistence' }],
    ['text hash', { ...result, textSha256: '0'.repeat(64) }],
    ['saved flag', { ...result, saved: false }],
  ];
  for (const [name, invalid] of cases) {
    await t.test(name, async () => {
      await writeFile(file, JSON.stringify(invalid));
      await assert.rejects(readRecord());
    });
  }
  await writeFile(file, JSON.stringify(result));
  assert.deepEqual(await readRecord(), result);
});

test('disk polling waits for real bridge atomic terminal persistence without additional authorization calls', async t => {
  const { root, gate, markerPath } = await fixture(t);
  const dataRoot = resolve(root, 'data');
  const run = deferred(), allowSave = deferred(), terminalSave = deferred(), pollDuringSave = deferred();
  t.after(() => { run.resolve({ text: 'Disk tracked output' }); allowSave.resolve(); });
  let authorizations = 0, savingTerminal = false;
  const bridge = createJeffOpenClawAccountBridge({ dataRoot,
    resolveAccount: async () => { authorizations++; return true; },
    runAgent: () => run.promise,
    async persistRecord(directory, record) {
      await mkdir(directory, { recursive: true });
      const file = resolve(directory, `${record.id}.json`);
      if (record.status === 'completed') {
        savingTerminal = true;
        terminalSave.resolve();
        await allowSave.promise;
      }
      await writeFile(`${file}.tmp`, JSON.stringify(record));
      await rename(`${file}.tmp`, file);
    } });
  const finishRequest = gate.beginRequest();
  const started = await bridge.start(scope, 'Produce disk tracked output');
  const readRecord = createDurableJobReader({ dataRoot, scope, id: started.id });
  const durable = waitForDurableJob({ readRecord: async () => {
    const record = await readRecord();
    if (savingTerminal && record.status === 'running') pollDuringSave.resolve();
    return record;
  }, pollMs: 1, timeoutMs: 1000 });
  track(gate, durable, 'disk tracked completion');
  finishRequest();
  const paused = gate.pause();
  run.resolve({ text: 'Disk tracked output' });
  await terminalSave.promise;
  const callsBeforeDiskPoll = authorizations;
  await pollDuringSave.promise;
  assert.equal((await readRecord()).status, 'running');
  assert.equal(gate.status().activeRequests, 0);
  assert.equal(gate.status().pendingTasks, 1);
  assert.equal(authorizations, callsBeforeDiskPoll);
  await noMarker(markerPath);

  allowSave.resolve();
  const result = await durable;
  await paused;
  assert.equal(result.status, 'completed');
  assert.equal(result.saved, true);
  assert.equal(result.text, 'Disk tracked output');
  assert.deepEqual(await readRecord(), result);
  assert.equal(authorizations, callsBeforeDiskPoll);
  assert.ok(JSON.parse(await readFile(markerPath, 'utf8')));
});

test('unsaved, interrupted and authorization failures reject maintenance readiness', async t => {
  const cases = [
    ['completed_unsaved', { status: 'completed_unsaved', saved: false }],
    ['failed_unsaved', { status: 'failed_unsaved', saved: false }],
    ['completed without save', { status: 'completed', saved: false }],
    ['failed without save', { status: 'failed', saved: false }],
    ['interrupted', { status: 'interrupted', saved: false }],
    ['saved interrupted', { status: 'interrupted', saved: true }],
    ['authorization', new Error('JEFF_OWNER_REVOKED')],
  ];
  for (const [name, value] of cases) {
    await t.test(name, async subtest => {
      const { gate, markerPath } = await fixture(subtest);
      const bridge = { async retrieve() {
        if (value instanceof Error) throw value;
        return { id, scope, ...value };
      } };
      const durable = waitForDurableJob({ bridge, scope, id, pollMs: 1, timeoutMs: 20 });
      track(gate, durable, name);
      const rejectedJob = assert.rejects(durable);
      await assert.rejects(gate.pause());
      await rejectedJob;
      assert.equal(gate.status().blocked, true);
      assert.equal(gate.status().pendingTasks, 0);
      assert.equal(gate.beginRequest(), null);
      await noMarker(markerPath);
    });
  }
});

test('a settled background failure remains unsafe for subsequent pause attempts', async t => {
  const { gate, markerPath } = await fixture(t);
  const task = deferred();
  track(gate, task.promise, 'durable write');
  const rejectedTask = assert.rejects(task.promise, /disk write failed/);
  task.reject(new Error('disk write failed'));
  await rejectedTask;
  await assert.rejects(gate.pause());
  await assert.rejects(gate.pause());
  assert.equal(gate.status().blocked, true);
  assert.equal(gate.status().pendingTasks, 0);
  await noMarker(markerPath);
});

test('default task labels keep a successful task from clearing a different task failure', async t => {
  const { gate, markerPath } = await fixture(t);
  const failed = deferred(), successful = deferred();
  track(gate, failed.promise);
  track(gate, successful.promise);
  const rejected = assert.rejects(failed.promise, /failed write/);
  failed.reject(new Error('failed write'));
  await rejected;
  successful.resolve();
  await successful.promise;
  await assert.rejects(gate.pause(), /JEFF_MAINTENANCE_TASK_UNSAFE/);
  assert.equal(gate.status().pendingTasks, 0);
  await noMarker(markerPath);
});

test('resume cancels a pending pause and draining old work cannot publish a late marker', async t => {
  const { gate, markerPath } = await fixture(t);
  const finish = gate.beginRequest();
  const task = deferred();
  track(gate, task.promise, 'pending job');
  const paused = gate.pause();
  await gate.resume();
  assert.equal(await paused, null);
  assert.equal(gate.status().blocked, false);
  await noMarker(markerPath);

  finish();
  task.resolve();
  await task.promise;
  await new Promise(resolveTick => setImmediate(resolveTick));
  assert.equal(gate.status().activeRequests, 0);
  assert.equal(gate.status().pendingTasks, 0);
  await noMarker(markerPath);

  const ready = await gate.pause();
  assert.deepEqual(JSON.parse(await readFile(markerPath, 'utf8')), ready);
});

test('repeated pause and resume calls are idempotent', async t => {
  const { gate, markerPath } = await fixture(t);
  const finish = gate.beginRequest();
  const first = gate.pause();
  const second = gate.pause();
  assert.equal(gate.status().activeRequests, 1);
  await noMarker(markerPath);
  finish();
  const [firstReady, secondReady] = await Promise.all([first, second]);
  assert.deepEqual(firstReady, secondReady);
  const marker = await readFile(markerPath, 'utf8');
  assert.deepEqual(await gate.pause(), firstReady);
  assert.equal(await readFile(markerPath, 'utf8'), marker);

  await gate.resume();
  await gate.resume();
  assert.equal(gate.status().blocked, false);
  await noMarker(markerPath);
  const finishNext = gate.beginRequest();
  assert.equal(typeof finishNext, 'function');
  finishNext();
});

test('a job that never reaches durable terminal state times out without readiness', async t => {
  const { gate, markerPath } = await fixture(t);
  const durable = waitForDurableJob({ bridge: { retrieve: async () => ({ id, scope, status: 'running', saved: false }) },
    scope, id, pollMs: 1, timeoutMs: 20 });
  track(gate, durable, 'stalled job');
  const timedOut = assert.rejects(durable);
  await assert.rejects(gate.pause());
  await timedOut;
  assert.equal(gate.status().blocked, true);
  await noMarker(markerPath);
});
