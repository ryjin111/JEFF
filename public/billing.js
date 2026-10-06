import { JOB_ID, scopeKey, validScope } from './client.js';
const address = /^0x[a-f0-9]{40}$/i;
const amount = value => typeof value === 'string' && /^[1-9]\d*$/.test(value) && BigInt(value) < 2n ** 256n;
export function validateHosting(value, scope) {
  if (!value || typeof value.active !== 'boolean' || typeof value.checkoutEnabled !== 'boolean'
    || value.chainId !== scope.chainId || value.periodDays !== 30 || !address.test(value.token)
    || (value.expiresAt !== null && !Number.isFinite(Date.parse(value.expiresAt)))
    || (value.active && !value.expiresAt) || (value.checkoutEnabled && (!amount(value.amount) || !address.test(value.recipient)))) throw new Error('JEFF_HOSTING_INVALID');
  return value;
}
export function validateInvoice(value, scope, now = Date.now()) {
  if (!value || !JOB_ID.test(value.id) || !validScope(value.scope) || scopeKey(value.scope) !== scopeKey(scope)
    || value.chainId !== scope.chainId || value.periodDays !== 30 || !address.test(value.token)
    || !address.test(value.recipient) || /^0x0{40}$/i.test(value.recipient) || !amount(value.amount)
    || !Number.isFinite(Date.parse(value.issuedAt)) || Date.parse(value.expiresAt) <= now
    || !Number.isFinite(Date.parse(value.expiresAt))) throw new Error('JEFF_INVOICE_INVALID');
  return value;
}
export function formatTokenAmount(value, decimals) {
  if (!amount(value) || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error('JEFF_TOKEN_DETAILS_UNAVAILABLE');
  if (!decimals) return value;
  const padded = value.padStart(decimals + 1, '0');
  const fraction = padded.slice(-decimals).replace(/0+$/, '');
  return padded.slice(0, -decimals) + (fraction ? '.' + fraction : '');
}
export function transferData(invoice) {
  if (!address.test(invoice.recipient) || !amount(invoice.amount)) throw new Error('JEFF_INVOICE_INVALID');
  return '0xa9059cbb' + invoice.recipient.slice(2).toLowerCase().padStart(64, '0') + BigInt(invoice.amount).toString(16).padStart(64, '0');
}
