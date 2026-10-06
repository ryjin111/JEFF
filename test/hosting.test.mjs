import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHostingLedger } from '../src/hosting.mjs';
const scope = { chainId: 4663, collection: '0x' + '11'.repeat(20), tokenId: '35', owner: '0x' + '22'.repeat(20), ownerEpoch: 0 };
const hash = '0x' + 'aa'.repeat(32);
const env = { JEFF_PAID_CHECKOUT_ENABLED: 'true', CLOCKERS_MONTHLY_AMOUNT: '1000000000000000000', CLOCKERS_PAYMENT_RECIPIENT: '0x' + '33'.repeat(20) };
async function setup(t, extra = {}) {
  const dataRoot = await mkdtemp(resolve('test', '.hosting-'));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  let time = Date.parse('2026-10-06T00:00:00Z'); let verifications = 0;
  const options = { dataRoot, env, now: () => time, verifyPayment: async () => { verifications++; }, ...extra };
  return { options, ledger: createHostingLedger(options), advance(ms) { time += ms; }, verifications: () => verifications };
}
test('confirmed payment activates exactly 30 days, retries are idempotent and survives restart', async t => {
  const f = await setup(t); const invoice = await f.ledger.invoice(scope);
  const active = await f.ledger.activate(scope, { invoiceId: invoice.id, transactionHash: hash });
  assert.equal(active.active, true); assert.equal(active.expiresAt, '2026-11-05T00:00:00.000Z');
  assert.deepEqual(await f.ledger.activate(scope, { invoiceId: invoice.id, transactionHash: hash }), active);
  assert.equal(f.verifications(), 1);
  assert.deepEqual(await createHostingLedger(f.options).status(scope), active);
  f.advance(30 * 86400000);
  await assert.rejects(f.ledger.requireActive(scope), /HOSTING_INACTIVE/);
});
test('one payment cannot activate two NFTs and failed chain verification gives no entitlement', async t => {
  const f = await setup(t); const invoice = await f.ledger.invoice(scope);
  await f.ledger.activate(scope, { invoiceId: invoice.id, transactionHash: hash });
  const otherScope = { ...scope, tokenId: '36' }; const other = await f.ledger.invoice(otherScope);
  await assert.rejects(f.ledger.activate(otherScope, { invoiceId: other.id, transactionHash: hash }), /ALREADY_USED/);
  assert.equal((await f.ledger.status(otherScope)).active, false);
  const failing = createHostingLedger({ ...f.options, verifyPayment: async () => { throw new Error('unconfirmed'); } });
  await assert.rejects(failing.activate(otherScope, { invoiceId: other.id, transactionHash: '0x' + 'bb'.repeat(32) }), /unconfirmed/);
  assert.equal((await failing.status(otherScope)).active, false);
});
test('checkout requires explicit configuration; pilot expires without creating a payment', async t => {
  const f = await setup(t, { env: { JEFF_PILOT_NFTS: '35', JEFF_PILOT_EXPIRES_AT: '2026-10-07T00:00:00Z' } });
  assert.equal((await f.ledger.status(scope)).source, 'pilot');
  assert.equal((await f.ledger.status(scope)).checkoutEnabled, false);
  assert.throws(() => f.ledger.invoice(scope), /CHECKOUT_UNAVAILABLE/);
  f.advance(86400000); await assert.rejects(f.ledger.requireActive(scope), /HOSTING_INACTIVE/);
});
test('renewal extends the existing term and ownership epoch cannot claim another invoice', async t => {
  const f = await setup(t); const invoice = await f.ledger.invoice(scope);
  await assert.rejects(f.ledger.activate({ ...scope, ownerEpoch: 1 }, { invoiceId: invoice.id, transactionHash: hash }), /INVOICE_DENIED/);
  await f.ledger.activate(scope, { invoiceId: invoice.id, transactionHash: hash });
  const renewal = await f.ledger.invoice(scope);
  const active = await f.ledger.activate(scope, { invoiceId: renewal.id, transactionHash: '0x' + 'bb'.repeat(32) });
  assert.equal(active.expiresAt, '2026-12-05T00:00:00.000Z');
});

test('an expired quote remains redeemable after confirmation delay and another invoice', async t => {
  const f = await setup(t); const invoice = await f.ledger.invoice(scope);
  f.advance(20 * 60000);
  await f.ledger.invoice(scope);
  const active = await createHostingLedger(f.options).activate(scope, { invoiceId: invoice.id, transactionHash: hash });
  assert.equal(active.active, true);
  assert.equal(active.expiresAt, '2026-11-05T00:20:00.000Z');
  assert.equal(f.verifications(), 1);
});
