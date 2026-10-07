import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHostingLedger } from '../src/hosting.mjs';

const hourMs = 3600000;
const monthMs = 30 * 86400000;
const testRoot = dirname(fileURLToPath(import.meta.url));
const scope = { chainId: 4663, collection: '0x' + '11'.repeat(20), tokenId: '35', owner: '0x' + '22'.repeat(20), ownerEpoch: 0 };
const env = { JEFF_PAID_CHECKOUT_ENABLED: 'true', CLOCKERS_PAYMENT_RECIPIENT: '0x' + '33'.repeat(20) };
const fixtureQuote = retrievedAt => ({ amount: '1000000000000000000', pricing: {
  usdCents: 1000, currency: 'USD', tokenDecimals: 18, tokenPriceUsd: '10', retrievedAt,
} });

async function setup(t) {
  const dataRoot = await mkdtemp(resolve(testRoot, '.allowance-'));
  t.after(async () => {
    assert.equal(dirname(dataRoot), testRoot);
    await rm(dataRoot, { recursive: true, force: true });
  });
  let time = Date.parse('2026-10-06T00:00:00Z');
  let payments = 0;
  const options = { dataRoot, env, now: () => time,
    quotePayment: async ({ usdCents }) => {
      assert.equal(usdCents, 1000);
      return fixtureQuote(new Date(time).toISOString());
    }, verifyPayment: async () => {},
  };
  const ledger = createHostingLedger(options);
  return {
    dataRoot, ledger, options,
    advance(ms) { time += ms; },
    restart() { return createHostingLedger(options); },
    async purchase(subject = scope, target = ledger) {
      const invoice = await target.invoice(subject);
      const transactionHash = '0x' + (++payments).toString(16).padStart(64, '0');
      return target.activate(subject, { invoiceId: invoice.id, transactionHash });
    },
    async stored() { return JSON.parse(await readFile(resolve(dataRoot, 'hosting', 'ledger.json'), 'utf8')); },
  };
}

async function consume(f, count, subject = scope, target = f.ledger) {
  for (let index = 0; index < count; index++) {
    if (index && index % 10 === 0) f.advance(hourMs);
    await target.startJob(subject, async () => ({ id: `fixture-${index}`, status: 'queued' }));
  }
}

test('a $10 term includes exactly 100 accepted tasks over 30 days', async t => {
  const f = await setup(t);
  const active = await f.purchase();
  assert.deepEqual(active.plan, { usdCents: 1000, currency: 'USD', periodDays: 30, tasksIncluded: 100 });
  assert.equal(active.usage.limit, 100);
  assert.equal(active.usage.remaining, 100);
  assert.equal(Date.parse(active.usage.resetsAt) - Date.parse(active.usage.periodStartsAt), monthMs);

  await consume(f, 100);
  f.advance(hourMs);
  const restarted = f.restart();
  const exhausted = await restarted.status(scope);
  assert.equal(exhausted.active, true);
  assert.equal(exhausted.usage.used, 100);
  assert.equal(exhausted.usage.remaining, 0);
  assert.equal(exhausted.usage.hourlyRemaining, 10);
  let starts = 0;
  await assert.rejects(restarted.startJob(scope, () => { starts++; }), /JEFF_TASK_ALLOWANCE_EXHAUSTED/);
  assert.equal(starts, 0);
  assert.equal((await f.restart().status(scope)).usage.used, 100);
});

test('the rolling 10 task hourly limit survives restart and releases slots at their exact boundaries', async t => {
  const f = await setup(t);
  await f.purchase();
  let starts = 0;
  const start = async () => ({ id: `hourly-${++starts}`, status: 'queued' });
  await f.ledger.startJob(scope, start);
  f.advance(20 * 60000);
  for (let index = 0; index < 9; index++) await f.ledger.startJob(scope, start);

  const restarted = f.restart();
  const limited = await restarted.status(scope);
  assert.equal(limited.usage.used, 10);
  assert.equal(limited.usage.remaining, 90);
  assert.equal(limited.usage.hourlyRemaining, 0);
  assert.equal(limited.usage.hourlyResetsAt, '2026-10-06T01:00:00.000Z');
  await assert.rejects(restarted.startJob(scope, start), /JEFF_USAGE_LIMIT_REACHED/);
  f.advance(40 * 60000 - 1);
  await assert.rejects(f.restart().startJob(scope, start), /JEFF_USAGE_LIMIT_REACHED/);
  assert.equal(starts, 10);

  f.advance(1);
  assert.equal((await restarted.status(scope)).usage.hourlyRemaining, 1);
  await restarted.startJob(scope, start);
  await assert.rejects(restarted.startJob(scope, start), /JEFF_USAGE_LIMIT_REACHED/);
  const next = await f.restart().status(scope);
  assert.equal(next.usage.used, 11);
  assert.equal(next.usage.hourlyResetsAt, '2026-10-06T01:20:00.000Z');
  f.advance(20 * 60000);
  assert.equal((await f.restart().status(scope)).usage.hourlyRemaining, 9);
  assert.equal(starts, 11);
});

test('concurrent admissions cannot both claim the final monthly task', async t => {
  const f = await setup(t);
  await f.purchase();
  await consume(f, 99);
  f.advance(hourMs);
  assert.equal((await f.ledger.status(scope)).usage.remaining, 1);
  let starts = 0;
  const results = await Promise.allSettled([
    f.ledger.startJob(scope, async () => ({ id: `final-${++starts}`, status: 'queued' })),
    f.ledger.startJob(scope, async () => ({ id: `final-${++starts}`, status: 'queued' })),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const denied = results.find(result => result.status === 'rejected');
  assert.match(denied.reason.message, /JEFF_TASK_ALLOWANCE_EXHAUSTED/);
  assert.equal(starts, 1);
  const durable = await f.restart().status(scope);
  assert.equal(durable.usage.used, 100);
  assert.equal(durable.usage.remaining, 0);
  assert.equal(durable.usage.hourlyRemaining, 9);
});

test('task and hourly reservations are durable before the start callback runs', async t => {
  const f = await setup(t);
  await f.purchase();
  const record = { id: 'durably-admitted', status: 'queued' };
  const result = await f.ledger.startJob(scope, async () => {
    const stored = await f.stored();
    assert.deepEqual(Object.values(stored.taskUsage), [1]);
    const admissions = Object.values(stored.hourlyUsage).flatMap(entries => Object.values(entries));
    assert.deepEqual(admissions, [f.options.now()]);
    const durable = await f.restart().status(scope);
    assert.equal(durable.usage.used, 1);
    assert.equal(durable.usage.remaining, 99);
    assert.equal(durable.usage.hourlyRemaining, 9);
    return record;
  });
  assert.strictEqual(result, record);
});

test('rejected starts refund both counters, while accepted failed records consume both limits', async t => {
  const f = await setup(t);
  await f.purchase();
  const rejection = new Error('FIXTURE_START_REJECTED');
  await assert.rejects(f.ledger.startJob(scope, async () => { throw rejection; }), error => error === rejection);
  let durable = await f.restart().status(scope);
  assert.equal(durable.usage.used, 0);
  assert.equal(durable.usage.remaining, 100);
  assert.equal(durable.usage.hourlyRemaining, 10);

  for (let index = 0; index < 10; index++) {
    const failedRecord = { id: `failed-${index}`, status: 'failed', error: 'FIXTURE_MODEL_FAILED' };
    assert.strictEqual(await f.ledger.startJob(scope, async () => failedRecord), failedRecord);
  }
  durable = await f.restart().status(scope);
  assert.equal(durable.usage.used, 10);
  assert.equal(durable.usage.remaining, 90);
  assert.equal(durable.usage.hourlyRemaining, 0);
  let starts = 0;
  await assert.rejects(f.ledger.startJob(scope, () => { starts++; }), /JEFF_USAGE_LIMIT_REACHED/);
  assert.equal(starts, 0);
});

test('early renewal keeps the current count and grants a fresh 100 tasks when the next term begins', async t => {
  const f = await setup(t);
  const first = await f.purchase();
  await consume(f, 100);
  const renewed = await f.purchase();
  assert.equal(renewed.active, true);
  assert.equal(renewed.usage.used, 100);
  assert.equal(renewed.usage.remaining, 0);
  assert.equal(renewed.usage.resetsAt, first.usage.resetsAt);
  assert.equal(Date.parse(renewed.expiresAt) - Date.parse(first.expiresAt), monthMs);
  let starts = 0;
  await assert.rejects(f.ledger.startJob(scope, () => { starts++; }), /JEFF_TASK_ALLOWANCE_EXHAUSTED/);
  assert.equal(starts, 0);

  f.advance(Date.parse(first.expiresAt) - f.options.now());
  const restarted = f.restart();
  const nextTerm = await restarted.status(scope);
  assert.equal(nextTerm.active, true);
  assert.equal(nextTerm.usage.used, 0);
  assert.equal(nextTerm.usage.remaining, 100);
  assert.equal(nextTerm.usage.periodStartsAt, first.expiresAt);
  assert.equal(nextTerm.usage.resetsAt, renewed.expiresAt);
  await restarted.startJob(scope, async () => ({ id: 'next-term', status: 'queued' }));
  assert.equal((await f.restart().status(scope)).usage.used, 1);
});

test('expired hosting denies admission before starting and a later purchase opens a fresh 30 day term', async t => {
  const f = await setup(t);
  const first = await f.purchase();
  await f.ledger.startJob(scope, async () => ({ id: 'old-term', status: 'queued' }));
  f.advance(monthMs);
  const expired = await f.restart().status(scope);
  assert.equal(expired.active, false);
  assert.equal(expired.usage.remaining, 0);
  let starts = 0;
  await assert.rejects(f.ledger.startJob(scope, () => { starts++; }), /JEFF_HOSTING_INACTIVE/);
  assert.equal(starts, 0);

  f.advance(2 * 86400000);
  const renewed = await f.purchase(scope, f.restart());
  assert.equal(renewed.usage.periodStartsAt, new Date(f.options.now()).toISOString());
  assert.equal(Date.parse(renewed.expiresAt) - f.options.now(), monthMs);
  assert.ok(Date.parse(renewed.usage.periodStartsAt) > Date.parse(first.expiresAt));
  assert.equal(renewed.usage.used, 0);
  assert.equal(renewed.usage.remaining, 100);
  await f.restart().startJob(scope, async () => ({ id: 'repurchased', status: 'queued' }));
  assert.equal((await f.ledger.status(scope)).usage.used, 1);
});

test('NFT allowance follows the token across owner and epoch changes, while account allowances stay separate', async t => {
  const f = await setup(t);
  await f.purchase();
  await consume(f, 3);
  const transferred = { ...scope, owner: '0x' + '44'.repeat(20), ownerEpoch: 1 };
  assert.equal((await f.restart().status(transferred)).usage.used, 3);
  await f.ledger.startJob(transferred, async () => ({ id: 'new-owner', status: 'queued' }));
  const returned = { ...scope, ownerEpoch: 2 };
  assert.equal((await f.restart().status(returned)).usage.used, 4);

  const account = { kind: 'account', chainId: scope.chainId, owner: scope.owner };
  const otherAccount = { ...account, owner: '0x' + '55'.repeat(20) };
  assert.equal((await f.ledger.status(account)).active, false);
  assert.equal((await f.ledger.status(otherAccount)).active, false);
  await f.purchase(account);
  await f.purchase(otherAccount);
  assert.equal((await f.ledger.status(account)).usage.used, 0);
  assert.equal((await f.ledger.status(otherAccount)).usage.used, 0);
  await f.ledger.startJob(account, async () => ({ id: 'account', status: 'queued' }));
  await consume(f, 2, otherAccount);
  const restarted = f.restart();
  assert.equal((await restarted.status(returned)).usage.used, 4);
  assert.equal((await restarted.status(account)).usage.used, 1);
  assert.equal((await restarted.status(otherAccount)).usage.used, 2);
  assert.equal((await restarted.status(account)).usage.hourlyRemaining, 6);
  assert.equal((await restarted.status(otherAccount)).usage.hourlyRemaining, 8);
});

test('an expiry-only legacy entitlement initializes missing usage safely and keeps its count through migration', async t => {
  const f = await setup(t);
  const key = createHash('sha256').update(`${scope.chainId}:${scope.collection}:${scope.tokenId}`).digest('hex');
  const expiresAt = new Date(f.options.now() + monthMs).toISOString();
  await mkdir(resolve(f.dataRoot, 'hosting'), { recursive: true });
  await writeFile(resolve(f.dataRoot, 'hosting', 'ledger.json'), JSON.stringify({
    invoices: {}, consumed: {}, entitlements: { [key]: { expiresAt } },
  }));

  const legacy = await f.ledger.status(scope);
  assert.equal(legacy.active, true);
  assert.equal(legacy.usage.used, 0);
  assert.equal(legacy.usage.remaining, 100);
  assert.equal(legacy.usage.hourlyRemaining, 10);
  assert.equal(legacy.usage.resetsAt, expiresAt);
  await f.ledger.startJob(scope, async () => ({ id: 'legacy-task', status: 'queued' }));
  assert.equal((await f.restart().status(scope)).usage.used, 1);
  f.advance(86400000);
  assert.equal((await f.restart().status(scope)).usage.used, 1);

  const renewed = await f.purchase();
  assert.equal(renewed.usage.used, 1);
  assert.equal(renewed.usage.remaining, 99);
  assert.equal(renewed.usage.resetsAt, expiresAt);
  const migrated = await f.stored();
  assert.equal(migrated.entitlements[key].periods.length, 2);
  assert.equal(migrated.entitlements[key].periods[0].expiresAt, expiresAt);
  assert.equal((await f.restart().status(scope)).usage.used, 1);
  f.advance(Date.parse(expiresAt) - f.options.now());
  assert.equal((await f.restart().status(scope)).usage.remaining, 100);
});

test('corrupt task counters and hourly timestamps deny admission without starting or changing the ledger', async t => {
  const f = await setup(t);
  await f.purchase();
  await f.ledger.startJob(scope, async () => ({ id: 'valid-reservation', status: 'queued' }));
  const valid = await f.stored();
  const counter = Object.keys(valid.taskUsage)[0];
  const wallet = Object.keys(valid.hourlyUsage)[0];
  const admission = Object.keys(valid.hourlyUsage[wallet])[0];
  let starts = 0;
  for (const field of ['taskUsage', 'hourlyUsage']) {
    for (const value of [null, false, '0', -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const corrupted = structuredClone(valid);
      if (field === 'taskUsage') corrupted.taskUsage[counter] = value;
      else corrupted.hourlyUsage[wallet][admission] = value;
      await writeFile(resolve(f.dataRoot, 'hosting', 'ledger.json'), JSON.stringify(corrupted));
      const restarted = f.restart();
      await assert.rejects(restarted.status(scope), /JEFF_USAGE_STORAGE_UNAVAILABLE/);
      await assert.rejects(restarted.startJob(scope, () => { starts++; }), /JEFF_USAGE_STORAGE_UNAVAILABLE/);
      assert.deepEqual(await f.stored(), corrupted);
    }
  }
  assert.equal(starts, 0);
});
