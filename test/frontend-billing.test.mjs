import test from 'node:test';
import assert from 'node:assert/strict';
import { validateHosting, validateInvoice, validUsdPlan, formatTokenAmount, formatUsdCents, transferData } from '../public/billing.js';
const scope = { chainId: 4663, collection: '0x' + '33'.repeat(20), tokenId: '35', owner: '0x' + '11'.repeat(20), ownerEpoch: 0 };
const invoice = { id: '12345678-1234-1234-1234-123456789abc', scope, chainId: 4663, token: '0x' + '44'.repeat(20),
  recipient: '0x' + '55'.repeat(20), amount: '1000000000000000001', periodDays: 30,
  issuedAt: '2026-10-06T14:00:00Z', expiresAt: '2026-10-06T14:15:00Z' };
test('hosting checkout needs configured amount and recipient; active access needs an expiry', () => {
  const status = { active: false, checkoutEnabled: false, token: invoice.token, chainId: 4663, periodDays: 30, expiresAt: null };
  assert.deepEqual(validateHosting(status, scope), status);
  assert.throws(() => validateHosting({ ...status, checkoutEnabled: true }, scope), /HOSTING_INVALID/);
  assert.throws(() => validateHosting({ ...status, active: true }, scope), /HOSTING_INVALID/);
  const usdStatus = { ...status, checkoutEnabled: true, amount: null, recipient: invoice.recipient,
    plan: { usdCents: 1000, currency: 'USD', periodDays: 30 } };
  assert.equal(validUsdPlan(usdStatus.plan), true);
  assert.equal(validateHosting(usdStatus, scope), usdStatus);
  assert.throws(() => validateHosting({ ...usdStatus, recipient: null }, scope), /HOSTING_INVALID/);
  assert.throws(() => validateHosting({ ...usdStatus, amount: '10' }, scope), /HOSTING_INVALID/);
  assert.throws(() => validateHosting({ ...usdStatus, plan: { ...usdStatus.plan, usdCents: '1000' } }, scope), /HOSTING_INVALID/);
});
test('invoice must bind the holder epoch and remain unexpired', () => {
  assert.equal(validateInvoice(invoice, scope, Date.parse(invoice.issuedAt)), invoice);
  assert.throws(() => validateInvoice(invoice, { ...scope, ownerEpoch: 2 }, 0), /INVOICE_INVALID/);
  assert.throws(() => validateInvoice(invoice, scope, Date.parse(invoice.expiresAt)), /INVOICE_INVALID/);
  const pricing = { usdCents: 1000, currency: 'USD', tokenPriceUsd: '0.000125', tokenDecimals: 18,
    source: 'dexscreener', sourceUrl: 'https://dexscreener.com/robinhood/fixture',
    retrievedAt: invoice.issuedAt, priceUpdatedAt: null };
  const quoted = { ...invoice, pricing };
  assert.equal(validateInvoice(quoted, scope, Date.parse(invoice.issuedAt)), quoted);
  for (const invalid of [{ usdCents: 0 }, { tokenPriceUsd: '0' }, { tokenDecimals: 255 }, { retrievedAt: 'unknown' }]) {
    assert.throws(() => validateInvoice({ ...quoted, pricing: { ...pricing, ...invalid } }, scope, 0), /INVOICE_INVALID/);
  }
});
test('monthly task balances are authoritative and distinct from the hourly limit', () => {
  const plan = { usdCents: 1000, currency: 'USD', periodDays: 30, tasksIncluded: 100 };
  const usage = { unit: 'tasks', limit: 100, used: 99, remaining: 1, hourlyLimit: 10, hourlyRemaining: 0,
    periodStartsAt: '2026-10-06T14:00:00Z', resetsAt: '2026-11-05T14:00:00Z', source: 'paid', hourlyResetsAt: '2026-10-06T14:30:00Z' };
  const status = { active: true, source: 'paid', checkoutEnabled: false, token: invoice.token, chainId: 4663,
    periodDays: 30, expiresAt: usage.resetsAt, plan, usage };
  assert.equal(validateHosting(status, scope), status);
  assert.equal(validateHosting({ ...status, usage: { ...usage, used: 100, remaining: 0 } }, scope).active, true);
  for (const invalid of [{ unit: 'USD' }, { used: -1 }, { used: 101 }, { remaining: 10 }, { remaining: '1' },
    { hourlyRemaining: 11 }, { hourlyLimit: 0 }, { hourlyResetsAt: null }, { source: 'pilot' }, { resetsAt: usage.periodStartsAt }]) {
    assert.throws(() => validateHosting({ ...status, usage: { ...usage, ...invalid } }, scope), /HOSTING_INVALID/);
  }
  assert.throws(() => validateHosting({ ...status, usage: undefined }, scope), /HOSTING_INVALID/);
  assert.equal(validateHosting({ ...status, source: 'pilot', usage: { ...usage, source: 'pilot', periodStartsAt: null } }, scope).usage.source, 'pilot');
  assert.equal(validateHosting({ ...status, active: false, source: null, expiresAt: null,
    usage: { ...usage, used: 0, remaining: 0, periodStartsAt: null, resetsAt: null, source: null } }, scope).active, false);
  assert.equal(validUsdPlan({ ...plan, tasksIncluded: '100' }), false);
  assert.equal(validateInvoice({ ...invoice, tasksIncluded: 100 }, scope, 0).tasksIncluded, 100);
  assert.throws(() => validateInvoice({ ...invoice, tasksIncluded: 0 }, scope, 0), /INVOICE_INVALID/);
});
test('token quote formatting preserves exact amounts without floating point', () => {
  assert.equal(formatTokenAmount(invoice.amount, 18), '1.000000000000000001');
  assert.equal(formatTokenAmount('1', 18), '0.000000000000000001');
  assert.equal(formatTokenAmount('1000000000000000000', 18), '1');
  assert.throws(() => formatTokenAmount('1', NaN), /TOKEN_DETAILS_UNAVAILABLE/);
  assert.equal(formatUsdCents(1000), '$10.00');
  assert.equal(formatUsdCents(1), '$0.01');
  assert.throws(() => formatUsdCents('1000'), /INVOICE_INVALID/);
  assert.throws(() => formatUsdCents(0), /INVOICE_INVALID/);
});
test('payment data sends the exact invoiced transfer without an allowance approval', () => {
  const data = transferData(invoice);
  assert.equal(data.slice(0, 10), '0xa9059cbb');
  assert.equal(data.slice(10, 74), invoice.recipient.slice(2).padStart(64, '0'));
  assert.equal(BigInt('0x' + data.slice(74)), BigInt(invoice.amount));
});
