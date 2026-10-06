import test from 'node:test';
import assert from 'node:assert/strict';
import { validateHosting, validateInvoice, formatTokenAmount, transferData } from '../public/billing.js';
const scope = { chainId: 4663, collection: '0x' + '33'.repeat(20), tokenId: '35', owner: '0x' + '11'.repeat(20), ownerEpoch: 0 };
const invoice = { id: '12345678-1234-1234-1234-123456789abc', scope, chainId: 4663, token: '0x' + '44'.repeat(20),
  recipient: '0x' + '55'.repeat(20), amount: '1000000000000000001', periodDays: 30,
  issuedAt: '2026-10-06T14:00:00Z', expiresAt: '2026-10-06T14:15:00Z' };
test('hosting checkout needs configured amount and recipient; active access needs an expiry', () => {
  const status = { active: false, checkoutEnabled: false, token: invoice.token, chainId: 4663, periodDays: 30, expiresAt: null };
  assert.deepEqual(validateHosting(status, scope), status);
  assert.throws(() => validateHosting({ ...status, checkoutEnabled: true }, scope), /HOSTING_INVALID/);
  assert.throws(() => validateHosting({ ...status, active: true }, scope), /HOSTING_INVALID/);
});
test('invoice must bind the holder epoch and remain unexpired', () => {
  assert.equal(validateInvoice(invoice, scope, Date.parse(invoice.issuedAt)), invoice);
  assert.throws(() => validateInvoice(invoice, { ...scope, ownerEpoch: 2 }, 0), /INVOICE_INVALID/);
  assert.throws(() => validateInvoice(invoice, scope, Date.parse(invoice.expiresAt)), /INVOICE_INVALID/);
});
test('token quote formatting preserves exact amounts without floating point', () => {
  assert.equal(formatTokenAmount(invoice.amount, 18), '1.000000000000000001');
  assert.equal(formatTokenAmount('1', 18), '0.000000000000000001');
  assert.equal(formatTokenAmount('1000000000000000000', 18), '1');
  assert.throws(() => formatTokenAmount('1', NaN), /TOKEN_DETAILS_UNAVAILABLE/);
});
test('payment data sends the exact invoiced transfer without an allowance approval', () => {
  const data = transferData(invoice);
  assert.equal(data.slice(0, 10), '0xa9059cbb');
  assert.equal(data.slice(10, 74), invoice.recipient.slice(2).padStart(64, '0'));
  assert.equal(BigInt('0x' + data.slice(74)), BigInt(invoice.amount));
});
