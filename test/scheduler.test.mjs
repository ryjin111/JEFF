import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createScheduler } from '../src/scheduler.mjs';
import { scopeDirectory } from '../src/scope.mjs';

const scope = { chainId: 4663, collection: '0x' + '11'.repeat(20), tokenId: '35', owner: '0x' + '22'.repeat(20), ownerEpoch: 4 };
const options = { objective: 'Write a daily room summary', conversationId: randomUUID(), intervalMinutes: 1, maxRuns: 2 };
async function fixture(t, overrides = {}) {
  const dataRoot = await mkdtemp(resolve(tmpdir(), 'jeff-schedule-'));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  let clock = Date.parse('2026-10-07T12:00:00.000Z');
  const calls = [];
  const config = { dataRoot, now: () => clock, resolveOwner: async () => ({ owner: scope.owner, ownerEpoch: scope.ownerEpoch }),
    execute: async (subject, job) => { calls.push({ subject, job }); return { id: randomUUID(), status: 'completed' }; }, ...overrides };
  return { config, dataRoot, calls, scheduler: createScheduler(config), advance: (ms = 60000) => { clock += ms; } };
}

test('a durable owner grant executes due occurrences once across concurrent ticks and restart', async t => {
  const f = await fixture(t);
  const record = await f.scheduler.create(scope, options);
  await f.scheduler.tick(); assert.equal(f.calls.length, 0);
  f.advance(); await Promise.all([f.scheduler.tick(), f.scheduler.tick()]);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].job.occurrenceId, `${record.id}:1`);
  assert.equal(f.calls[0].job.source, 'schedule');
  const reopened = createScheduler(f.config);
  await reopened.tick(); assert.equal(f.calls.length, 1);
  f.advance(); await reopened.tick();
  const completed = (await reopened.list(scope))[0];
  assert.equal(completed.status, 'completed'); assert.equal(completed.runs.length, 2);
  assert.equal(f.calls.length, 2);
});

test('a persisted crashed claim becomes interrupted and is never replayed', async t => {
  const f = await fixture(t);
  const record = await f.scheduler.create(scope, options);
  const path = resolve(scopeDirectory(f.dataRoot, scope), 'schedules', `${record.id}.json`);
  record.runs.push({ index: 1, occurrenceId: `${record.id}:1`, status: 'claimed', claimedAt: record.createdAt,
    finishedAt: null, jobId: null, error: null });
  await writeFile(path, JSON.stringify(record));
  f.advance(); await createScheduler(f.config).tick();
  const saved = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(saved.status, 'interrupted'); assert.equal(saved.runs[0].error, 'JEFF_SCHEDULE_PROCESS_RESTARTED');
  await createScheduler(f.config).tick(); assert.equal(f.calls.length, 0);
});

test('transfer before admission revokes the grant instead of executing it', async t => {
  let current = { owner: scope.owner, ownerEpoch: 4 };
  const f = await fixture(t, { resolveOwner: async () => current });
  await f.scheduler.create(scope, options); f.advance(); current = { owner: scope.owner, ownerEpoch: 6 };
  await f.scheduler.tick(); assert.equal(f.calls.length, 0);
  await assert.rejects(f.scheduler.list(scope), /OWNER_REVOKED/);
  current = { owner: scope.owner, ownerEpoch: 4 };
  assert.equal((await f.scheduler.list(scope))[0].status, 'revoked');
});

test('ownership is rechecked after the durable occurrence claim', async t => {
  let resolutions = 0;
  const f = await fixture(t, { resolveOwner: async () => ({ owner: scope.owner, ownerEpoch: ++resolutions >= 4 ? 5 : 4 }) });
  const record = await f.scheduler.create(scope, options); f.advance(); await f.scheduler.tick();
  const saved = JSON.parse(await readFile(resolve(scopeDirectory(f.dataRoot, scope), 'schedules', `${record.id}.json`), 'utf8'));
  assert.equal(saved.status, 'revoked'); assert.equal(saved.runs[0].status, 'interrupted'); assert.equal(f.calls.length, 0);
});

test('pause and maintenance block future work without consuming an occurrence', async t => {
  let paused = true, enabled = true;
  const f = await fixture(t, { isPaused: async () => paused, canRun: () => enabled });
  await f.scheduler.create(scope, options); f.advance(); await f.scheduler.tick();
  assert.equal((await f.scheduler.list(scope))[0].runs.length, 0);
  paused = false; enabled = false; await f.scheduler.tick(); assert.equal(f.calls.length, 0);
  enabled = true; await f.scheduler.tick(); assert.equal(f.calls.length, 1);
});

test('cancelling a grant survives restart and cannot cross NFT scopes', async t => {
  const f = await fixture(t); const record = await f.scheduler.create(scope, options);
  await assert.rejects(f.scheduler.cancel({ ...scope, tokenId: '36' }, record.id), /NOT_FOUND/);
  await f.scheduler.cancel(scope, record.id); f.advance(); await createScheduler(f.config).tick();
  assert.equal((await f.scheduler.list(scope))[0].status, 'cancelled'); assert.equal(f.calls.length, 0);
});

test('unknown execution outcomes halt the schedule without automatic retry', async t => {
  let calls = 0;
  const f = await fixture(t, { execute: async () => { calls++; throw new Error('upstream private details'); } });
  await f.scheduler.create(scope, options); f.advance(); await f.scheduler.tick(); f.advance(); await f.scheduler.tick();
  const saved = (await f.scheduler.list(scope))[0];
  assert.equal(calls, 1); assert.equal(saved.status, 'interrupted');
  assert.equal(saved.runs[0].error, 'JEFF_SCHEDULE_EXECUTION_UNKNOWN');
});

test('schedule admission enforces bounded time, quota and strict objective input', async t => {
  const f = await fixture(t);
  for (const override of [{ intervalMinutes: 0 }, { maxRuns: 25 }, { objective: '' }, { conversationId: '../other' },
    { expiresAt: '2027-01-01T00:00:00.000Z' }]) await assert.rejects(f.scheduler.create(scope, { ...options, ...override }), /INVALID/);
  assert.deepEqual(await f.scheduler.list(scope), []);
});

test('stop drains admitted execution and tick tracking includes the entire durable task', async t => {
  let finish, began;
  const started = new Promise(done => { began = done; });
  let tracked = 0;
  const f = await fixture(t, { track: (promise, label) => { assert.equal(label, 'scheduler:tick'); tracked++; return promise; },
    execute: async () => { began(); return new Promise(done => { finish = done; }); } });
  await f.scheduler.create(scope, options); f.advance(); const tick = f.scheduler.tick(); await started;
  assert.equal(tracked, 1); let stopped = false;
  const stop = f.scheduler.stop().then(() => { stopped = true; }); await new Promise(setImmediate);
  assert.equal(stopped, false); finish({ id: randomUUID(), status: 'completed' }); await Promise.all([tick, stop]);
  assert.equal(stopped, true); assert.equal((await f.scheduler.list(scope))[0].runs[0].status, 'completed');
});

test('account grants use the separate account scope and ownership resolver contract', async t => {
  const account = { kind: 'account', chainId: 4663, owner: scope.owner };
  const f = await fixture(t, { resolveOwner: async input => ({ owner: input.owner }) });
  await f.scheduler.create(account, options); f.advance(); await f.scheduler.tick();
  assert.equal(f.calls[0].subject.kind, 'account'); assert.equal((await f.scheduler.list(account)).length, 1);
});

test('list and cancel stay responsive during execution and cancellation survives finalization', async t => {
  let finish, began;
  const started = new Promise(done => { began = done; });
  let executions = 0;
  const f = await fixture(t, { execute: async () => {
    executions++; began(); return new Promise(done => { finish = done; });
  } });
  const schedule = await f.scheduler.create(scope, options); f.advance();
  const first = f.scheduler.tick(); await started;
  const overlapping = f.scheduler.tick();
  const visible = await f.scheduler.list(scope);
  assert.equal(visible[0].runs[0].status, 'claimed');
  const cancelled = await f.scheduler.cancel(scope, schedule.id);
  assert.equal(cancelled.status, 'cancelled');
  // Neither listing nor cancellation required the executing job to resolve.
  assert.equal(f.scheduler.status().activeExecutions, 1);
  finish({ id: randomUUID(), status: 'completed' }); await Promise.all([first, overlapping]);
  const final = (await f.scheduler.list(scope))[0];
  assert.equal(final.status, 'cancelled'); assert.equal(final.runs[0].status, 'completed');
  f.advance(); await f.scheduler.tick(); assert.equal(executions, 1);
});

test('cancellation during the final asynchronous pause check prevents execution', async t => {
  let pauseChecks = 0, entered, release;
  const finalCheck = new Promise(done => { entered = done; });
  const gate = new Promise(done => { release = done; });
  const f = await fixture(t, { isPaused: async () => {
    if (++pauseChecks === 2) { entered(); await gate; }
    return false;
  } });
  const record = await f.scheduler.create(scope, options);
  f.advance();
  const ticking = f.scheduler.tick();
  await finalCheck;
  const cancelled = await f.scheduler.cancel(scope, record.id);
  assert.equal(cancelled.status, 'cancelled');
  release();
  await ticking;
  assert.equal(f.calls.length, 0);
  const saved = (await f.scheduler.list(scope))[0];
  assert.equal(saved.status, 'cancelled');
  assert.equal(saved.runs[0].status, 'interrupted');
  assert.equal(saved.runs[0].error, 'JEFF_SCHEDULE_ADMISSION_STOPPED');
});

test('explicit authorization denial revokes a grant while transport failures remain retryable', async t => {
  let error;
  const f = await fixture(t, { isPaused: async () => {
    if (error === 'JEFF_OPENCLAW_OWNER_REVOKED') throw new Error(error);
    return false;
  }, resolveOwner: async () => {
    if (error) throw new Error(error);
    return { owner: scope.owner, ownerEpoch: scope.ownerEpoch };
  } });
  const schedule = await f.scheduler.create(scope, options); f.advance();
  error = 'RPC unavailable'; await assert.rejects(f.scheduler.tick(), /JEFF_SCHEDULE_UNAVAILABLE/);
  error = undefined; assert.equal((await f.scheduler.list(scope))[0].status, 'active');
  error = 'JEFF_OPENCLAW_OWNER_REVOKED'; await f.scheduler.tick();
  error = undefined; assert.equal((await f.scheduler.list(scope))[0].status, 'revoked');
  assert.equal(f.calls.length, 0);
  const saved = JSON.parse(await readFile(resolve(scopeDirectory(f.dataRoot, scope), 'schedules', `${schedule.id}.json`), 'utf8'));
  assert.equal(saved.runs.length, 0);
});

test('a grant expiring during the pre-claim ownership read cannot consume or execute an occurrence', async t => {
  let resolutions = 0, f;
  f = await fixture(t, { resolveOwner: async () => {
    if (++resolutions === 3) f.advance(60000);
    return { owner: scope.owner, ownerEpoch: scope.ownerEpoch };
  } });
  await f.scheduler.create(scope, { ...options, expiresAt: '2026-10-07T12:01:30.000Z' });
  f.advance(); await f.scheduler.tick();
  let saved = (await f.scheduler.list(scope))[0];
  assert.equal(saved.status, 'expired'); assert.equal(saved.runs.length, 0); assert.equal(f.calls.length, 0);
  await createScheduler(f.config).tick();
  saved = (await f.scheduler.list(scope))[0];
  assert.equal(saved.status, 'expired'); assert.equal(saved.runs.length, 0); assert.equal(f.calls.length, 0);
});

test('a grant expiring after its durable claim is interrupted without execution or replay', async t => {
  let resolutions = 0, f;
  f = await fixture(t, { resolveOwner: async () => {
    if (++resolutions === 4) f.advance(60000);
    return { owner: scope.owner, ownerEpoch: scope.ownerEpoch };
  } });
  await f.scheduler.create(scope, { ...options, expiresAt: '2026-10-07T12:01:30.000Z' });
  f.advance(); await f.scheduler.tick();
  const saved = (await f.scheduler.list(scope))[0];
  assert.equal(saved.status, 'expired'); assert.equal(saved.runs.length, 1);
  assert.equal(saved.runs[0].status, 'interrupted'); assert.equal(saved.runs[0].error, 'JEFF_SCHEDULE_GRANT_EXPIRED');
  assert.equal(f.calls.length, 0);
  await createScheduler(f.config).tick(); assert.equal(f.calls.length, 0);
});

test('expiry after the final pause check preserves concurrent cancellation and never starts the claimed run', async t => {
  let pauseChecks = 0, f, grant;
  f = await fixture(t, { isPaused: async () => {
    if (++pauseChecks === 2) {
      await f.scheduler.cancel(scope, grant.id);
      f.advance(60000);
    }
    return false;
  } });
  grant = await f.scheduler.create(scope, { ...options, expiresAt: '2026-10-07T12:01:30.000Z' });
  f.advance(); await f.scheduler.tick();
  const saved = (await f.scheduler.list(scope))[0];
  assert.equal(saved.status, 'cancelled'); assert.equal(saved.runs[0].status, 'interrupted');
  assert.equal(saved.runs[0].error, 'JEFF_SCHEDULE_GRANT_EXPIRED'); assert.equal(f.calls.length, 0);
  await createScheduler(f.config).tick(); assert.equal(f.calls.length, 0);
});

test('a scope has at most sixteen live grants and cancellation frees capacity without deleting receipts', async t => {
  const f = await fixture(t), grants = [];
  for (let i = 0; i < 16; i++) grants.push(await f.scheduler.create(scope, options));
  await assert.rejects(f.scheduler.create(scope, options), /JEFF_SCHEDULE_LIMIT_REACHED/);
  const other = { ...scope, tokenId: '36' };
  await f.scheduler.create(other, options);
  await f.scheduler.cancel(scope, grants[0].id);
  const cancelledPath = resolve(scopeDirectory(f.dataRoot, scope), 'schedules', `${grants[0].id}.json`);
  const receipt = await readFile(cancelledPath, 'utf8');
  const replacement = await createScheduler(f.config).create(scope, options);
  assert.notEqual(replacement.id, grants[0].id);
  const history = await f.scheduler.list(scope);
  assert.equal(history.length, 17); assert.equal(history.filter(record => record.status === 'active').length, 16);
  assert.equal((await f.scheduler.list(other)).length, 1);
  assert.equal((await createScheduler(f.config).cancel(scope, grants[0].id)).status, 'cancelled');
  assert.equal(await readFile(cancelledPath, 'utf8'), receipt);
  const entries = JSON.parse(await readFile(resolve(f.dataRoot, '.schedules', 'index.json'), 'utf8')).entries;
  assert.equal(entries.length, 17); assert.equal(entries.some(entry => entry.id === grants[0].id), false);
  assert.equal(f.scheduler.status().maximumSchedulesPerScope, 16);
});

test('a full legacy index of terminal grants is compacted and all historical receipts remain readable', async t => {
  const f = await fixture(t), first = await f.scheduler.create(scope, options);
  await f.scheduler.cancel(scope, first.id);
  const terminal = JSON.parse(await readFile(resolve(scopeDirectory(f.dataRoot, scope), 'schedules', `${first.id}.json`), 'utf8'));
  const entries = [{ id: first.id, scope: terminal.scope }];
  const writes = [];
  for (let i = 1; i < 1024; i++) {
    const id = randomUUID(); entries.push({ id, scope: terminal.scope });
    writes.push(writeFile(resolve(scopeDirectory(f.dataRoot, scope), 'schedules', `${id}.json`), JSON.stringify({ ...terminal, id })));
  }
  await Promise.all(writes);
  await writeFile(resolve(f.dataRoot, '.schedules', 'index.json'), JSON.stringify({ schema: 'jeff-schedule-index-v1', entries }));
  const reopened = createScheduler(f.config), fresh = await reopened.create(scope, options);
  const compacted = JSON.parse(await readFile(resolve(f.dataRoot, '.schedules', 'index.json'), 'utf8')).entries;
  assert.deepEqual(compacted.map(entry => entry.id), [fresh.id]);
  const history = await reopened.list(scope);
  assert.equal(history.length, 1025); assert.equal(history.filter(record => record.status === 'cancelled').length, 1024);
  assert.equal((await reopened.cancel(scope, entries[900].id)).status, 'cancelled');
  f.advance(); await reopened.tick(); assert.equal(f.calls.length, 1);
});

test('completed and expired grants release capacity before the next creation and remain in history', async t => {
  const f = await fixture(t);
  const completed = await f.scheduler.create(scope, { ...options, maxRuns: 1 });
  f.advance(); await f.scheduler.tick();
  assert.equal(JSON.parse(await readFile(resolve(f.dataRoot, '.schedules', 'index.json'), 'utf8')).entries.length, 0);
  for (let i = 0; i < 16; i++) await f.scheduler.create(scope, { ...options, expiresAt: '2026-10-07T12:03:00.000Z' });
  f.advance(120000);
  await createScheduler(f.config).create(scope, options);
  const history = await f.scheduler.list(scope);
  assert.equal(history.find(record => record.id === completed.id).status, 'completed');
  assert.equal(history.filter(record => record.status === 'expired').length, 16);
  assert.equal(history.filter(record => record.status === 'active').length, 1);
});

test('a cancelled admitted claim retains its live slot until durable execution finalizes', async t => {
  let finish, began, executions = 0;
  const started = new Promise(done => { began = done; });
  const f = await fixture(t, { execute: async () => {
    if (++executions === 1) { began(); return new Promise(done => { finish = done; }); }
    return { id: randomUUID(), status: 'completed' };
  } });
  const first = await f.scheduler.create(scope, options);
  for (let i = 1; i < 16; i++) await f.scheduler.create(scope, options);
  f.advance(); const ticking = f.scheduler.tick(); await started;
  await f.scheduler.cancel(scope, first.id);
  await assert.rejects(f.scheduler.create(scope, options), /JEFF_SCHEDULE_LIMIT_REACHED/);
  finish({ id: randomUUID(), status: 'completed' }); await ticking;
  await f.scheduler.create(scope, options);
  const final = (await f.scheduler.list(scope)).find(record => record.id === first.id);
  assert.equal(final.status, 'cancelled'); assert.equal(final.runs[0].status, 'completed');
  const entries = JSON.parse(await readFile(resolve(f.dataRoot, '.schedules', 'index.json'), 'utf8')).entries;
  assert.equal(entries.length, 16); assert.equal(entries.some(entry => entry.id === first.id), false);
});

test('missing live receipts and corrupted archived receipts fail closed after compaction', async t => {
  const f = await fixture(t), archived = await f.scheduler.create(scope, options);
  await f.scheduler.cancel(scope, archived.id);
  const archivedPath = resolve(scopeDirectory(f.dataRoot, scope), 'schedules', `${archived.id}.json`);
  await writeFile(archivedPath, '{}');
  await assert.rejects(f.scheduler.list(scope), /JEFF_SCHEDULE_STORE_INVALID/);
  await assert.rejects(f.scheduler.cancel(scope, archived.id), /JEFF_SCHEDULE_STORE_INVALID/);
  await rm(archivedPath);
  const live = await f.scheduler.create(scope, options);
  await rm(resolve(scopeDirectory(f.dataRoot, scope), 'schedules', `${live.id}.json`));
  await assert.rejects(f.scheduler.list(scope), /JEFF_SCHEDULE_STORE_INVALID/);
  await assert.rejects(f.scheduler.cancel(scope, live.id), /JEFF_SCHEDULE_STORE_INVALID/);
  await assert.rejects(f.scheduler.tick(), /JEFF_SCHEDULE_STORE_INVALID/);
  assert.equal(f.calls.length, 0);
});
