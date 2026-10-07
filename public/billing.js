import { JOB_ID, scopeKey, validScope } from './client.js';
const address = /^0x[a-f0-9]{40}$/i;
const amount = value => typeof value === 'string' && /^[1-9]\d*$/.test(value) && BigInt(value) < 2n ** 256n;
const positiveCount = value => Number.isSafeInteger(value) && value > 0;
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
export const validUsdPlan = value => Boolean(value?.currency === 'USD' && value.periodDays === 30
  && Number.isSafeInteger(value.usdCents) && value.usdCents > 0
  && (value.tasksIncluded === undefined || positiveCount(value.tasksIncluded)));
function validUsage(value, hosting) {
  return Boolean(value?.unit === 'tasks' && positiveCount(value.limit)
    && Number.isSafeInteger(value.used) && value.used >= 0 && value.used <= value.limit
    && Number.isSafeInteger(value.remaining) && value.remaining >= 0 && value.remaining <= value.limit
    && positiveCount(value.hourlyLimit) && Number.isSafeInteger(value.hourlyRemaining)
    && value.hourlyRemaining >= 0 && value.hourlyRemaining <= value.hourlyLimit
    && (value.hourlyResetsAt === null || date(value.hourlyResetsAt))
    && (value.hourlyRemaining === value.hourlyLimit || date(value.hourlyResetsAt))
    && (hosting.active ? ['paid', 'pilot'].includes(value.source) && value.source === hosting.source
      && date(value.resetsAt) && (value.source === 'pilot' ? value.periodStartsAt === null
        : date(value.periodStartsAt) && Date.parse(value.periodStartsAt) < Date.parse(value.resetsAt))
      && value.remaining === value.limit - value.used
      : value.remaining === 0 && value.periodStartsAt === null && value.resetsAt === null && value.source === null));
}
function validUsdPricing(value) {
  return Boolean(value?.currency === 'USD' && Number.isSafeInteger(value.usdCents) && value.usdCents > 0
    && typeof value.tokenPriceUsd === 'string' && /^\d{1,78}(?:\.\d{1,18})?$/.test(value.tokenPriceUsd)
    && /[1-9]/.test(value.tokenPriceUsd) && Number.isInteger(value.tokenDecimals) && value.tokenDecimals >= 0 && value.tokenDecimals <= 36
    && value.source === 'dexscreener' && typeof value.sourceUrl === 'string'
    && Number.isFinite(Date.parse(value.retrievedAt)) && value.priceUpdatedAt === null);
}
export function validateHosting(value, scope) {
  if (!value || typeof value.active !== 'boolean' || typeof value.checkoutEnabled !== 'boolean'
    || value.chainId !== scope.chainId || value.periodDays !== 30 || !address.test(value.token)
    || (value.plan !== undefined && !validUsdPlan(value.plan))
    || (value.usage !== undefined && !validUsage(value.usage, value))
    || (value.plan?.tasksIncluded !== undefined && !value.usage)
    || (value.expiresAt !== null && !Number.isFinite(Date.parse(value.expiresAt)))
    || (value.active && !value.expiresAt) || (value.checkoutEnabled && (!address.test(value.recipient)
      || (value.plan ? value.amount !== null : !amount(value.amount))))) throw new Error('JEFF_HOSTING_INVALID');
  return value;
}
export function validateInvoice(value, scope, now = Date.now()) {
  if (!value || !JOB_ID.test(value.id) || !validScope(value.scope) || scopeKey(value.scope) !== scopeKey(scope)
    || value.chainId !== scope.chainId || value.periodDays !== 30 || !address.test(value.token)
    || !address.test(value.recipient) || /^0x0{40}$/i.test(value.recipient) || !amount(value.amount)
    || (value.pricing !== undefined && !validUsdPricing(value.pricing))
    || (value.tasksIncluded !== undefined && !positiveCount(value.tasksIncluded))
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
export function formatUsdCents(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('JEFF_INVOICE_INVALID');
  const cents = BigInt(value).toString().padStart(3, '0');
  return '$' + cents.slice(0, -2) + '.' + cents.slice(-2);
}
export function transferData(invoice) {
  if (!address.test(invoice.recipient) || !amount(invoice.amount)) throw new Error('JEFF_INVOICE_INVALID');
  return '0xa9059cbb' + invoice.recipient.slice(2).toLowerCase().padStart(64, '0') + BigInt(invoice.amount).toString(16).padStart(64, '0');
}
