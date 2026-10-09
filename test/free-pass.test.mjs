import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHostingLedger } from '../src/hosting.mjs';

const hourMs = 3600000;
const monthMs = 30 * 86400000;
const testRoot = dirname(fileURLToPath(import.meta.url));
const scope = { chainId: 4663, collection: '0x' + '11'.repeat(20), tokenId: '35', owner: '0x' + '22'.repeat(20), ownerEpoch: 0 };
const env = { JEFF_FREE_PASS_ENABLED: 'true', JEFF_PAID_CHECKOUT_ENABLED: 'true', CLOCKERS_PAYMENT_RECIPIENT: '0x' + '33'.repeat(20) };
const fixtureQuote = retrievedAt => ({ amount: '1000000000000000000', pricing: {
  usdCents: 1000, currency: 'USD', tokenDecimals: 18, tokenPriceUsd: '10', retrievedAt,
} });

async function setup(t, extra = {}) {
  const dataRoot = await mkdtemp(resolve(testRoot, '.free-pass-'));
  t.after(async () => {
    assert.equal(dirname(dataRoot), testRoot);
    await rm(dataRoot, { recursive: true, force: true });
  });
  let time = Date.parse('2026-10-06T00:00:00Z');
  let owner = { owner: scope.owner, ownerEpoch: scope.ownerEpoch };
  let ownerChecks = 0;
  let payments = 0;
  let verifications = 0;
  const options = { dataRoot, env, now: () => time,
    resolveOwner: async () => { ownerChecks++; return owner; },
    quotePayment: async ({ usdCents }) => {
      assert.equal(usdCents, 1000);
      return fixtureQuote(new Date(time).toISOString());
    }, verifyPayment: async () => { verifications++; },
    ...extra,
  };
  const file = resolve(dataRoot, 'hosting', 'ledger.json');
  const ledger = createHostingLedger(options);
  return {
    dataRoot, file, ledger, options,
    advance(ms) { time += ms; },
    setOwner(value) { owner = value; },
    ownerChecks: () => ownerChecks,
    verifications: () => verifications,
    restart() { return createHostingLedger(options); },
    async stored() { return JSON.parse(await readFile(file, 'utf8')); },
    async seed(value = { invoices: {}, consumed: {}, entitlements: {} }) {
      await mkdir(dirname(file), { recursive: true });
      const contents = JSON.stringify(value, null, 2) + '\n';
      await writeFile(file, contents);
      return contents;
    },
    async purchase(subject = scope) {
      const invoice = await ledger.invoice(subject);
      return ledger.activate(subject, { invoiceId: invoice.id, transactionHash: '0x' + (++payments).toString(16).padStart(64, '0') });
    },
  };
}

async function consume(f, count, subject = scope, target = f.ledger) {
  for (let index = 0; index < count; index++) {
    if (index && index % 10 === 0) f.advance(hourMs);
    await target.startJob(subject, async () => ({ id: `fixture-${index}`, status: 'queued' }));
  }
}

test('a lost hosting ledger cannot make a consumed free pass redeemable again', async t => {
  const f = await setup(t);
  await f.ledger.redeemFreePass(scope);
  await rm(f.file);
  const checks = f.ownerChecks();
  for (const ledger of [f.ledger, f.restart()]) {
    await assert.rejects(ledger.status(scope), /JEFF_USAGE_STORAGE_UNAVAILABLE/);
    await assert.rejects(ledger.redeemFreePass(scope), /JEFF_USAGE_STORAGE_UNAVAILABLE/);
  }
  assert.equal(f.ownerChecks(), checks);
  await assert.rejects(readFile(f.file), { code: 'ENOENT' });
});

test('an eligible NFT redeems one durable 100 task, 30 day free pass without payment', async t => {
  const f = await setup(t);
  const available = await f.ledger.status(scope);
  assert.equal(available.active, false);
  assert.deepEqual(available.freePass, { state: 'available', periodDays: 30, tasksIncluded: 100,
    startsAt: '2026-10-06T00:00:00.000Z', expiresAt: '2026-11-05T00:00:00.000Z', consumedAt: null });
  const active = await f.ledger.redeemFreePass(scope);
  assert.equal(active.active, true);
  assert.equal(active.source, 'free-pass');
  assert.equal(active.usage.source, 'free-pass');
  assert.equal(active.usage.limit, 100);
  assert.equal(active.usage.used, 0);
  assert.equal(active.usage.remaining, 100);
  assert.equal(active.usage.hourlyRemaining, 10);
  assert.equal(active.freePass.state, 'consumed');
  assert.equal(active.freePass.startsAt, '2026-10-06T00:00:00.000Z');
  assert.equal(active.freePass.consumedAt, active.freePass.startsAt);
  assert.equal(Date.parse(active.freePass.expiresAt) - Date.parse(active.freePass.startsAt), monthMs);
  assert.equal(active.usage.periodStartsAt, active.freePass.startsAt);
  assert.equal(active.usage.resetsAt, active.freePass.expiresAt);
  assert.deepEqual(await f.restart().status(scope), active);
  assert.equal(f.verifications(), 0);

  const stored = await f.stored();
  const keys = Object.keys(stored.freePasses);
  assert.equal(keys.length, 1);
  const pass = stored.freePasses[keys[0]];
  assert.match(pass.periodId, /^free-pass:/);
  assert.equal(stored.entitlements[keys[0]].periods.length, 1);
  assert.deepEqual(stored.entitlements[keys[0]].periods[0], {
    id: pass.periodId, source: 'free-pass', startsAt: pass.startsAt, expiresAt: pass.expiresAt, limit: 100,
  });
  assert.equal(pass.consumedAt, active.freePass.consumedAt);
});

test('concurrent claims and retries create one term, and transfer or expiry never restores the pass', async t => {
  const f = await setup(t);
  const claims = await Promise.all(Array.from({ length: 5 }, () => f.ledger.redeemFreePass(scope)));
  for (const result of claims) assert.deepEqual(result, claims[0]);
  assert.deepEqual(await f.restart().redeemFreePass(scope), claims[0]);
  await consume(f, 3);

  const transferred = { ...scope, owner: '0x' + '44'.repeat(20), ownerEpoch: 1 };
  f.setOwner({ owner: transferred.owner, ownerEpoch: transferred.ownerEpoch });
  const afterTransfer = await f.restart().redeemFreePass(transferred);
  assert.equal(afterTransfer.freePass.state, 'consumed');
  assert.deepEqual(afterTransfer.freePass, claims[0].freePass);
  assert.equal(afterTransfer.usage.used, 3);
  const stored = await f.stored();
  assert.equal(Object.keys(stored.freePasses).length, 1);
  assert.equal(Object.values(stored.entitlements)[0].periods.length, 1);

  f.advance(monthMs);
  const beforeRetry = await readFile(f.file, 'utf8');
  const expired = await f.restart().redeemFreePass(transferred);
  assert.equal(expired.active, false);
  assert.equal(expired.freePass.state, 'consumed');
  assert.deepEqual(expired.freePass, claims[0].freePass);
  assert.equal(expired.usage.remaining, 0);
  assert.equal(await readFile(f.file, 'utf8'), beforeRetry);
  assert.equal((await f.restart().status(transferred)).freePass.state, 'consumed');
});

test('free passes are independently keyed by chain, collection and token', async t => {
  const f = await setup(t);
  const subjects = [scope, { ...scope, chainId: scope.chainId + 1 },
    { ...scope, collection: '0x' + '66'.repeat(20) }, { ...scope, tokenId: '36' }];
  for (const subject of subjects) {
    assert.equal((await f.ledger.status(subject)).freePass.state, 'available');
    assert.equal((await f.ledger.redeemFreePass(subject)).freePass.state, 'consumed');
  }
  assert.equal(Object.keys((await f.stored()).freePasses).length, subjects.length);
});

test('free-pass tasks obey durable rolling hourly limits and the 100 task allowance', async t => {
  const f = await setup(t);
  await f.ledger.redeemFreePass(scope);
  await consume(f, 10);
  let starts = 0;
  const start = async () => ({ id: `over-limit-${++starts}`, status: 'queued' });
  const restarted = f.restart();
  assert.equal((await restarted.status(scope)).usage.hourlyRemaining, 0);
  await assert.rejects(restarted.startJob(scope, start), /JEFF_USAGE_LIMIT_REACHED/);
  f.advance(hourMs - 1);
  await assert.rejects(restarted.startJob(scope, start), /JEFF_USAGE_LIMIT_REACHED/);
  f.advance(1);
  await consume(f, 90, scope, restarted);
  f.advance(hourMs);
  const exhausted = await f.restart().status(scope);
  assert.equal(exhausted.active, true);
  assert.equal(exhausted.source, 'free-pass');
  assert.equal(exhausted.usage.used, 100);
  assert.equal(exhausted.usage.remaining, 0);
  assert.equal(exhausted.usage.hourlyRemaining, 10);
  await assert.rejects(f.restart().startJob(scope, start), /JEFF_TASK_ALLOWANCE_EXHAUSTED/);
  assert.equal(starts, 0);
});

test('a free pass queues after all paid terms without resetting the current allowance', async t => {
  const f = await setup(t);
  const first = await f.purchase();
  await consume(f, 3);
  const renewed = await f.purchase();
  const queued = await f.ledger.redeemFreePass(scope);
  assert.equal(queued.source, 'paid');
  assert.equal(queued.usage.used, 3);
  assert.equal(queued.usage.remaining, 97);
  assert.equal(queued.usage.resetsAt, first.expiresAt);
  assert.equal(queued.freePass.startsAt, renewed.expiresAt);
  assert.equal(Date.parse(queued.freePass.expiresAt) - Date.parse(queued.freePass.startsAt), monthMs);
  assert.equal(queued.freePass.consumedAt, new Date(f.options.now()).toISOString());

  f.advance(Date.parse(first.expiresAt) - f.options.now());
  const nextPaid = await f.restart().status(scope);
  assert.equal(nextPaid.source, 'paid');
  assert.equal(nextPaid.usage.remaining, 100);
  f.advance(Date.parse(renewed.expiresAt) - f.options.now());
  const freeTerm = await f.restart().status(scope);
  assert.equal(freeTerm.active, true);
  assert.equal(freeTerm.source, 'free-pass');
  assert.equal(freeTerm.usage.used, 0);
  assert.equal(freeTerm.usage.remaining, 100);
  assert.equal(freeTerm.usage.resetsAt, queued.freePass.expiresAt);
});

test('a free pass queues after an active pilot without resetting pilot usage', async t => {
  const f = await setup(t, { env: { ...env, JEFF_PILOT_NFTS: scope.tokenId, JEFF_PILOT_EXPIRES_AT: '2026-10-08T00:00:00.000Z' } });
  await consume(f, 3);
  const pilot = await f.ledger.status(scope);
  const queued = await f.ledger.redeemFreePass(scope);
  assert.equal(queued.source, 'pilot');
  assert.equal(queued.usage.used, 3);
  assert.equal(queued.usage.remaining, 97);
  assert.equal(queued.usage.resetsAt, pilot.usage.resetsAt);
  assert.equal(queued.freePass.startsAt, pilot.expiresAt);
  f.advance(Date.parse(pilot.expiresAt) - f.options.now());
  const freeTerm = await f.restart().status(scope);
  assert.equal(freeTerm.source, 'free-pass');
  assert.equal(freeTerm.usage.used, 0);
  assert.equal(freeTerm.usage.remaining, 100);
});

test('disabled free passes and a missing owner resolver report unavailable and cannot write a grant', async t => {
  for (const extra of [{ env: { ...env, JEFF_FREE_PASS_ENABLED: 'false' } }, { resolveOwner: undefined }]) {
    const f = await setup(t, extra);
    const before = await f.seed();
    const status = await f.ledger.status(scope);
    assert.equal(status.freePass.state, 'unavailable');
    await assert.rejects(async () => f.ledger.redeemFreePass(scope), /JEFF_FREE_PASS_UNAVAILABLE/);
    assert.equal(await readFile(f.file, 'utf8'), before);
    assert.equal(f.ownerChecks(), 0);
  }
});

test('standalone accounts have no free pass and cannot redeem one', async t => {
  const f = await setup(t);
  const before = await f.seed();
  const account = { kind: 'account', chainId: scope.chainId, owner: scope.owner };
  assert.equal((await f.ledger.status(account)).freePass, null);
  await assert.rejects(async () => f.ledger.redeemFreePass(account), /JEFF_FREE_PASS_DENIED/);
  assert.equal(await readFile(f.file, 'utf8'), before);
  assert.equal(f.ownerChecks(), 0);
});

test('an owner or ownership epoch mismatch denies redemption without changing the ledger', async t => {
  const f = await setup(t);
  const before = await f.seed();
  for (const owner of [{ owner: '0x' + '44'.repeat(20), ownerEpoch: scope.ownerEpoch },
    { owner: scope.owner, ownerEpoch: scope.ownerEpoch + 1 }]) {
    f.setOwner(owner);
    await assert.rejects(async () => f.ledger.redeemFreePass(scope), /JEFF_OWNER_REQUIRED/);
    assert.equal(await readFile(f.file, 'utf8'), before);
  }
  f.setOwner({ owner: scope.owner, ownerEpoch: scope.ownerEpoch });
  assert.equal((await f.ledger.redeemFreePass(scope)).freePass.state, 'consumed');
});

test('ownership is checked inside the serialized redemption after earlier work finishes', async t => {
  let entered;
  const quoteEntered = new Promise(resolveEntered => { entered = resolveEntered; });
  let release;
  const quoteHeld = new Promise(resolveHeld => { release = resolveHeld; });
  let f;
  f = await setup(t, { quotePayment: async () => {
    entered();
    await quoteHeld;
    return fixtureQuote(new Date(f.options.now()).toISOString());
  } });
  const invoice = f.ledger.invoice(scope);
  await quoteEntered;
  const redemption = f.ledger.redeemFreePass(scope);
  const denied = assert.rejects(async () => redemption, /JEFF_OWNER_REQUIRED/);
  await Promise.resolve();
  assert.equal(f.ownerChecks(), 0);
  f.setOwner({ owner: '0x' + '44'.repeat(20), ownerEpoch: 1 });
  release();
  await invoice;
  await denied;
  const stored = await f.stored();
  assert.deepEqual(stored.entitlements, {});
  assert.equal(Object.keys(stored.freePasses || {}).length, 0);
  assert.ok(f.ownerChecks() > 0);
});

test('malformed free-pass containers, records and grant links fail closed without callbacks or writes', async t => {
  const f = await setup(t);
  await f.ledger.redeemFreePass(scope);
  const valid = await f.stored();
  const key = Object.keys(valid.freePasses)[0];
  const corruptions = [];
  for (const value of [null, [], '', 'invalid', 0, 1, false, true]) {
    corruptions.push({ label: `container=${JSON.stringify(value)}`, mutate: valueToChange => { valueToChange.freePasses = value; } });
    corruptions.push({ label: `record=${JSON.stringify(value)}`, mutate: valueToChange => { valueToChange.freePasses[key] = value; } });
  }
  for (const field of ['periodId', 'startsAt', 'expiresAt', 'consumedAt']) {
    corruptions.push({ label: `missing ${field}`, mutate: value => { delete value.freePasses[key][field]; } });
    corruptions.push({ label: `invalid ${field}`, mutate: value => { value.freePasses[key][field] = 'invalid'; } });
  }
  for (const field of ['startsAt', 'expiresAt', 'consumedAt']) {
    for (const wrongType of [0, [valid.freePasses[key][field]], null]) {
      corruptions.push({ label: `wrong type ${field}=${JSON.stringify(wrongType)}`,
        mutate: value => { value.freePasses[key][field] = wrongType; } });
    }
  }
  corruptions.push(
    { label: 'missing consumed map', mutate: value => { delete value.freePasses; } },
    { label: 'missing consumed record', mutate: value => { value.freePasses = {}; } },
    { label: 'missing grant', mutate: value => { delete value.entitlements[key]; } },
    { label: 'mismatched grant limit', mutate: value => { value.entitlements[key].periods[0].limit = 99; } },
    { label: 'mismatched grant source', mutate: value => { value.entitlements[key].periods[0].source = 'paid'; } },
    { label: 'mismatched grant expiry', mutate: value => { value.freePasses[key].expiresAt = new Date(f.options.now() + monthMs + 1).toISOString(); } },
  );
  let starts = 0;
  for (const { label, mutate } of corruptions) {
    const corrupted = structuredClone(valid);
    mutate(corrupted);
    const before = await f.seed(corrupted);
    const restarted = f.restart();
    await assert.rejects(restarted.status(scope), /JEFF_FREE_PASS_STORAGE_UNAVAILABLE/, label);
    await assert.rejects(async () => restarted.redeemFreePass(scope), /JEFF_FREE_PASS_STORAGE_UNAVAILABLE/, label);
    await assert.rejects(restarted.startJob(scope, () => { starts++; }), /JEFF_FREE_PASS_STORAGE_UNAVAILABLE/, label);
    assert.equal(await readFile(f.file, 'utf8'), before, label);
  }
  assert.equal(starts, 0);
});

test('missing or malformed mandatory ledger maps deny free-pass status and redemption without writes', async t => {
  const f = await setup(t);
  await f.ledger.redeemFreePass(scope);
  const valid = await f.stored();
  let starts = 0;
  for (const field of ['invoices', 'consumed', 'entitlements']) {
    for (const value of [undefined, null, [], 'invalid', 0, false]) {
      const corrupted = structuredClone(valid);
      if (value === undefined) delete corrupted[field];
      else corrupted[field] = value;
      const label = `${field}=${JSON.stringify(value)}`;
      const before = await f.seed(corrupted);
      const restarted = f.restart();
      await assert.rejects(restarted.status(scope), /JEFF_USAGE_STORAGE_UNAVAILABLE/, label);
      await assert.rejects(async () => restarted.redeemFreePass(scope), /JEFF_USAGE_STORAGE_UNAVAILABLE/, label);
      await assert.rejects(restarted.startJob(scope, () => { starts++; }), /JEFF_USAGE_STORAGE_UNAVAILABLE/, label);
      assert.equal(await readFile(f.file, 'utf8'), before, label);
    }
  }
  assert.equal(starts, 0);
});
