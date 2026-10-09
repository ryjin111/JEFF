import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createScheduler } from '../src/scheduler.mjs';
import { scopeDirectory } from '../src/scope.mjs';

const scope = { chainId: 4663, collection: '0x' + '11'.repeat(20), tokenId: '35', owner: '0x' + '22'.repeat(20), ownerEpoch: 4 };
const initialTime = Date.parse('2026-10-09T12:00:00.000Z');
const options = () => ({ objective: 'Write my project update.', conversationId: randomUUID(), intervalMinutes: 1,
  maxRuns: 1, expiresAt: '2026-10-10T12:00:00.000Z' });

async function fixture(t, overrides = {}) {
  const dataRoot = await mkdtemp(resolve(tmpdir(), 'jeff-schedule-chat-'));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  let clock = initialTime;
  const calls = [];
  const config = { dataRoot, now: () => clock,
    resolveOwner: async input => ({ owner: input.owner, ownerEpoch: input.ownerEpoch }),
    execute: async (subject, job) => { calls.push({ subject, job }); return { id: randomUUID(), status: 'completed' }; }, ...overrides };
  return { config, dataRoot, calls, scheduler: createScheduler(config), advance: milliseconds => { clock += milliseconds; } };
}
const indexPath = f => resolve(f.dataRoot, '.schedules', 'index.json');
const receiptPath = (f, id, subject = scope) => resolve(scopeDirectory(f.dataRoot, subject), 'schedules', `${id}.json`);
const entries = async f => JSON.parse(await readFile(indexPath(f), 'utf8')).entries;

test('concurrent chat confirmations and a process restart recover the same grant without extending authority', async t => {
  const f = await fixture(t), grant = options(), idempotencyKey = randomUUID();
  const [first, second] = await Promise.all([
    f.scheduler.create(scope, grant, { idempotencyKey }), f.scheduler.create(scope, grant, { idempotencyKey }),
  ]);
  assert.equal(first.id, idempotencyKey); assert.deepEqual(second, first);
  first.objective = 'Changed client object';
  f.advance(120000);
  const reopened = createScheduler(f.config), recovered = await reopened.create(scope, grant, { idempotencyKey });
  assert.equal(recovered.objective, grant.objective);
  assert.equal(recovered.createdAt, second.createdAt); assert.equal(recovered.expiresAt, grant.expiresAt);
  assert.equal((await entries(f)).length, 1); assert.equal((await reopened.list(scope)).length, 1);
  assert.equal(f.calls.length, 0);
});

test('completed and cancelled chat grants survive retries after expiration without creating or replaying work', async t => {
  const f = await fixture(t), grant = options(), completedId = randomUUID(), cancelledId = randomUUID();
  await f.scheduler.create(scope, grant, { idempotencyKey: completedId });
  await f.scheduler.create(scope, grant, { idempotencyKey: cancelledId });
  await f.scheduler.cancel(scope, cancelledId);
  f.advance(60000); await f.scheduler.tick();
  assert.equal(f.calls.length, 1); assert.equal((await entries(f)).length, 0);
  f.advance(2 * 24 * 60 * 60000);
  const reopened = createScheduler(f.config);
  const completed = await reopened.create(scope, grant, { idempotencyKey: completedId });
  const cancelled = await reopened.create(scope, grant, { idempotencyKey: cancelledId });
  assert.equal(completed.status, 'completed'); assert.equal(cancelled.status, 'cancelled');
  assert.equal(completed.runs.length, 1); assert.equal(cancelled.runs.length, 0);
  assert.equal((await entries(f)).length, 0);
  await reopened.tick(); assert.equal(f.calls.length, 1);
});

test('a reused chat grant ID rejects every changed immutable field', async t => {
  const f = await fixture(t), idempotencyKey = randomUUID();
  const grant = { ...options(), firstRunAt: '2026-10-09T13:00:00.000Z' };
  await f.scheduler.create(scope, grant, { idempotencyKey });
  for (const override of [{ objective: 'A different request' }, { conversationId: randomUUID() }, { intervalMinutes: 2 },
    { maxRuns: 2 }, { expiresAt: '2026-10-10T11:00:00.000Z' }, { firstRunAt: '2026-10-09T14:00:00.000Z' }]) {
    await assert.rejects(f.scheduler.create(scope, { ...grant, ...override }, { idempotencyKey }), /JEFF_SCHEDULE_CONFLICT/);
  }
  const withoutFirst = { ...grant }; delete withoutFirst.firstRunAt;
  await assert.rejects(f.scheduler.create(scope, withoutFirst, { idempotencyKey }), /JEFF_SCHEDULE_CONFLICT/);
  assert.equal((await entries(f)).length, 1); assert.equal(f.calls.length, 0);
});

test('legacy default expiry stays fixed on idempotent retry, and manual creates keep independent random IDs', async t => {
  const f = await fixture(t), grant = options(), idempotencyKey = randomUUID(); delete grant.expiresAt;
  const first = await f.scheduler.create(scope, grant, { idempotencyKey });
  assert.equal(Object.hasOwn(first, 'firstRunAt'), false);
  f.advance(3600000);
  assert.deepEqual(await createScheduler(f.config).create(scope, grant, { idempotencyKey }), first);
  const manual = await f.scheduler.create(scope, { ...grant, idempotencyKey });
  assert.notEqual(manual.id, idempotencyKey);
  assert.notEqual((await f.scheduler.create(scope, grant)).id, manual.id);
});

test('a future one-off starts at the specified instant once and does not wait for its recurrence interval', async t => {
  const f = await fixture(t), firstRunAt = '2026-10-10T01:00:00.000Z'; // October 10, 09:00 in Taipei.
  const grant = { ...options(), intervalMinutes: 10080, firstRunAt };
  const saved = await f.scheduler.create(scope, grant, { idempotencyKey: randomUUID() });
  assert.equal(saved.nextRunAt, firstRunAt); assert.equal(saved.firstRunAt, firstRunAt);
  f.advance(13 * 3600000 - 1); await f.scheduler.tick(); assert.equal(f.calls.length, 0);
  f.advance(1); await Promise.all([f.scheduler.tick(), f.scheduler.tick()]);
  assert.equal(f.calls.length, 1);
  assert.equal((await f.scheduler.list(scope))[0].status, 'completed');
  f.advance(24 * 3600000); await createScheduler(f.config).tick(); assert.equal(f.calls.length, 1);
});

test('recurrence after an explicit first run remains relative to durable completion', async t => {
  let f;
  f = await fixture(t, { execute: async (subject, job) => {
    f.calls.push({ subject, job }); f.advance(5000); return { id: randomUUID(), status: 'completed' };
  } });
  const grant = { ...options(), maxRuns: 2, firstRunAt: '2026-10-09T12:10:00.000Z' };
  await f.scheduler.create(scope, grant, { idempotencyKey: randomUUID() });
  f.advance(600000); await f.scheduler.tick();
  const first = (await f.scheduler.list(scope))[0];
  assert.equal(first.nextRunAt, '2026-10-09T12:11:05.000Z');
  f.advance(59999); await f.scheduler.tick(); assert.equal(f.calls.length, 1);
  f.advance(1); await f.scheduler.tick(); assert.equal(f.calls.length, 2);
});

test('invalid absolute start times and untrusted host IDs cannot create grants', async t => {
  const f = await fixture(t), grant = options();
  for (const firstRunAt of ['2026-10-09T11:59:59.999Z', '2026-10-09T12:00:00.000Z', grant.expiresAt,
    '2026-10-17T12:00:00.000Z', '2026-10-09T13:00:00Z', '2026-10-09T21:00:00.000+08:00', 'bad date', initialTime + 60000, null, undefined]) {
    await assert.rejects(f.scheduler.create(scope, { ...grant, firstRunAt }), /JEFF_SCHEDULE_INVALID/);
  }
  for (const hostOptions of [{ idempotencyKey: '../escape' }, { idempotencyKey: [randomUUID()] },
    { idempotencyKey: undefined }, { idempotencyKey: randomUUID(), trusted: true }, null]) {
    await assert.rejects(f.scheduler.create(scope, grant, hostOptions), /JEFF_SCHEDULE_INVALID/);
  }
  assert.deepEqual(await f.scheduler.list(scope), []);
});

test('persisted absolute start metadata is validated on reload without invalidating legacy receipts', async t => {
  const f = await fixture(t), grant = options();
  const saved = await f.scheduler.create(scope, { ...grant, firstRunAt: '2026-10-09T13:00:00.000Z' });
  for (const firstRunAt of [null, saved.createdAt, saved.expiresAt, 'bad date', '2026-10-09T13:00:00Z']) {
    await writeFile(receiptPath(f, saved.id), JSON.stringify({ ...saved, firstRunAt }));
    await assert.rejects(createScheduler(f.config).list(scope), /JEFF_SCHEDULE_STORE_INVALID/);
  }
  await writeFile(receiptPath(f, saved.id), JSON.stringify(saved));
  const legacy = await f.scheduler.create(scope, grant);
  assert.equal(Object.hasOwn(legacy, 'firstRunAt'), false);
  assert.equal((await createScheduler(f.config).list(scope)).length, 2);
});

test('a record-to-index write fault is an unknown admission and retry never repairs or replays it', async t => {
  let f, ownerReads = 0;
  f = await fixture(t, { resolveOwner: async input => {
    if (++ownerReads === 2) await mkdir(indexPath(f), { recursive: true });
    return { owner: input.owner, ownerEpoch: input.ownerEpoch };
  } });
  const grant = options(), idempotencyKey = randomUUID();
  await assert.rejects(f.scheduler.create(scope, grant, { idempotencyKey }));
  const orphan = JSON.parse(await readFile(receiptPath(f, idempotencyKey), 'utf8'));
  assert.equal(orphan.status, 'active'); assert.equal(orphan.runs.length, 0);
  await rm(indexPath(f), { recursive: true });
  const reopened = createScheduler(f.config);
  await assert.rejects(reopened.create(scope, grant, { idempotencyKey }), /JEFF_SCHEDULE_STORE_INVALID/);
  await assert.rejects(reopened.list(scope), /JEFF_SCHEDULE_STORE_INVALID/);
  f.advance(60000); await reopened.tick(); assert.equal(f.calls.length, 0);
  assert.equal(await readFile(receiptPath(f, idempotencyKey), 'utf8'), JSON.stringify(orphan, null, 2));
});

test('a live index with a missing receipt fails closed instead of treating its ID as a new grant', async t => {
  const f = await fixture(t), grant = options(), idempotencyKey = randomUUID();
  await f.scheduler.create(scope, grant, { idempotencyKey });
  await rm(receiptPath(f, idempotencyKey));
  await assert.rejects(createScheduler(f.config).create(scope, grant, { idempotencyKey }), /JEFF_SCHEDULE_STORE_INVALID/);
  assert.equal((await entries(f)).length, 1); assert.equal(f.calls.length, 0);
});

test('scope-bound chat retries cannot return another NFT or owner epoch grant', async t => {
  const f = await fixture(t), grant = options(), idempotencyKey = randomUUID();
  const first = await f.scheduler.create(scope, grant, { idempotencyKey });
  for (const subject of [{ ...scope, tokenId: '36' }, { ...scope, ownerEpoch: 5 },
    { ...scope, owner: '0x' + '33'.repeat(20) }, { kind: 'account', chainId: scope.chainId, owner: scope.owner }]) {
    await assert.rejects(f.scheduler.create(subject, grant, { idempotencyKey }), /JEFF_SCHEDULE_CONFLICT/);
    assert.deepEqual(await f.scheduler.list(subject), []);
  }
  assert.deepEqual((await f.scheduler.list(scope))[0], first);
});

test('new grants check pause before admission and after ownership waits; existing retries remain bookkeeping', async t => {
  let paused = true, ownerReads = 0, pauseAfterOwnerRead = false;
  const f = await fixture(t, { isPaused: async () => paused, resolveOwner: async input => {
    if (pauseAfterOwnerRead && ++ownerReads === 2) paused = true;
    return { owner: input.owner, ownerEpoch: input.ownerEpoch };
  } });
  const grant = options(), idempotencyKey = randomUUID();
  await assert.rejects(f.scheduler.create(scope, grant, { idempotencyKey }), /JEFF_SCHEDULE_PAUSED/);
  paused = false; pauseAfterOwnerRead = true;
  await assert.rejects(f.scheduler.create(scope, grant, { idempotencyKey }), /JEFF_SCHEDULE_PAUSED/);
  assert.deepEqual(await f.scheduler.list(scope), []);
  paused = false; pauseAfterOwnerRead = false;
  const saved = await f.scheduler.create(scope, grant, { idempotencyKey });
  paused = true;
  assert.deepEqual(await createScheduler(f.config).create(scope, grant, { idempotencyKey }), saved);
  f.advance(60000); await f.scheduler.tick(); assert.equal(f.calls.length, 0);
});

test('idempotent retries still require ownership and maintenance authority', async t => {
  let owner = true, enabled = true;
  const f = await fixture(t, { canRun: () => enabled, resolveOwner: async input => ({
    owner: input.owner, ownerEpoch: input.ownerEpoch + (owner ? 0 : 1),
  }) });
  const grant = options(), idempotencyKey = randomUUID();
  await f.scheduler.create(scope, grant, { idempotencyKey });
  owner = false; await assert.rejects(f.scheduler.create(scope, grant, { idempotencyKey }), /JEFF_SCHEDULE_OWNER_REVOKED/);
  owner = true; enabled = false;
  await assert.rejects(f.scheduler.create(scope, grant, { idempotencyKey }), /JEFF_SCHEDULE_MAINTENANCE/);
  assert.equal((await entries(f)).length, 1);
});
