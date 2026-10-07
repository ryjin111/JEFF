import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isAddress } from 'viem';
import { usdCentsToTokenAmount } from './usd-amount.mjs';

const monthMs = 30 * 86400000;
export const CLOCKERS_PLAN = Object.freeze({ usdCents: 1000, currency: 'USD', periodDays: 30, tasksIncluded: 100 });
const nftKey = scope => createHash('sha256').update(scope.kind === 'account' ? `account:${scope.chainId}:${scope.owner}` : `${scope.chainId}:${scope.collection}:${scope.tokenId}`).digest('hex');
const walletKey = scope => createHash('sha256').update(`${scope.chainId}:${scope.owner?.toLowerCase()}`).digest('hex');
const periodKey = (scope, period) => `${nftKey(scope)}:${period.id}`;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function validateUsageContainers(ledger) {
  if (!record(ledger)
    || (Object.hasOwn(ledger, 'taskUsage') && !record(ledger.taskUsage))
    || (Object.hasOwn(ledger, 'hourlyUsage') && (!record(ledger.hourlyUsage)
      || Object.values(ledger.hourlyUsage).some(value => !record(value))))) throw new Error('JEFF_USAGE_STORAGE_UNAVAILABLE');
  return ledger;
}

function paidPeriods(entitlement, time) {
  if (!entitlement) return [];
  if (Array.isArray(entitlement.periods)) {
    let previousEnd = 0;
    for (const period of entitlement.periods) {
      const start = Date.parse(period.startsAt), end = Date.parse(period.expiresAt);
      if (typeof period.id !== 'string' || period.id.length > 100 || !Number.isFinite(start) || end - start !== monthMs
        || start < previousEnd || !Number.isSafeInteger(period.limit) || period.limit <= 0) throw new Error('JEFF_USAGE_STORAGE_UNAVAILABLE');
      previousEnd = end;
    }
    if (entitlement.periods.length && Date.parse(entitlement.expiresAt) !== previousEnd) throw new Error('JEFF_USAGE_STORAGE_UNAVAILABLE');
    return entitlement.periods;
  }
  // Preserve existing paid terms when upgrading from an expiry-only ledger.
  const expiry = Date.parse(entitlement.expiresAt);
  if (!(expiry > time)) return [];
  const count = Math.ceil((expiry - time) / monthMs);
  if (count > 120) throw new Error('JEFF_USAGE_STORAGE_UNAVAILABLE');
  return Array.from({ length: count }, (_, i) => {
    const end = expiry - (count - i - 1) * monthMs;
    return { id: `legacy:${end}`, startsAt: new Date(end - monthMs).toISOString(), expiresAt: new Date(end).toISOString(), limit: 100 };
  });
}
export function createHostingLedger({ dataRoot, env = process.env, verifyPayment, quotePayment, now = () => Date.now() }) {
  const directory = resolve(dataRoot, 'hosting');
  const file = resolve(directory, 'ledger.json');
  let queue = Promise.resolve();
  const pilotIds = new Set(String(env.JEFF_PILOT_NFTS || '').split(',').filter(Boolean));
  const pilotExpiry = Date.parse(env.JEFF_PILOT_EXPIRES_AT || '');
  const token = env.CLOCKERS_TOKEN_ADDRESS || '0xefc067e5d19b847da7863f3f997c2a4639686ba3';
  const recipient = env.CLOCKERS_PAYMENT_RECIPIENT;
  const enabled = env.JEFF_PAID_CHECKOUT_ENABLED === 'true' && isAddress(token) && isAddress(recipient || '')
    && recipient.toLowerCase() !== '0x' + '0'.repeat(40) && typeof quotePayment === 'function';
  async function read() {
    try { return validateUsageContainers(JSON.parse(await readFile(file, 'utf8'))); }
    catch (error) { if (error.code === 'ENOENT') return { invoices: {}, consumed: {}, entitlements: {} }; throw error; }
  }
  async function write(value) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 }); await rename(temporary, file);
  }
  function serialize(operation) {
    const result = queue.then(operation); queue = result.catch(() => {}); return result;
  }
  function describe(scope, ledger, time) {
    const entitlement = ledger.entitlements[nftKey(scope)];
    const paidExpiry = Date.parse(entitlement?.expiresAt || '');
    const paid = paidPeriods(entitlement, time).find(period => Date.parse(period.startsAt) <= time && Date.parse(period.expiresAt) > time);
    if (paidExpiry > time && !paid) throw new Error('JEFF_USAGE_STORAGE_UNAVAILABLE');
    const pilot = scope.kind !== 'account' && pilotIds.has(scope.tokenId) && pilotExpiry > time;
    const period = paid || (pilot ? { id: `pilot:${pilotExpiry}`, startsAt: null, expiresAt: new Date(pilotExpiry).toISOString(), limit: 100 } : null);
    const source = paid ? 'paid' : pilot ? 'pilot' : null;
    const expiry = paid ? paidExpiry : pilot ? pilotExpiry : Number.isFinite(paidExpiry) ? paidExpiry : 0;
    const counter = period && periodKey(scope, period);
    const used = counter && Object.hasOwn(ledger.taskUsage || {}, counter) ? ledger.taskUsage[counter] : 0;
    if (!Number.isSafeInteger(used) || used < 0) throw new Error('JEFF_USAGE_STORAGE_UNAVAILABLE');
    const timestamps = Object.values(ledger.hourlyUsage?.[walletKey(scope)] || {});
    if (timestamps.some(at => !Number.isSafeInteger(at) || at < 0)) throw new Error('JEFF_USAGE_STORAGE_UNAVAILABLE');
    const hourly = timestamps.filter(at => at > time - 3600000);
    const usage = { unit: 'tasks', limit: period?.limit || 100, used, remaining: period ? Math.max(0, period.limit - used) : 0,
      periodStartsAt: period?.startsAt || null, resetsAt: period?.expiresAt || null, source,
      hourlyLimit: 10, hourlyRemaining: Math.max(0, 10 - hourly.length),
      hourlyResetsAt: hourly.length ? new Date(Math.min(...hourly) + 3600000).toISOString() : null };
    return { period, usage, active: Boolean(period), source, expiry };
  }
  async function status(scope) {
    const { usage, active, source, expiry } = describe(scope, await read(), now());
    return { active, source,
      expiresAt: expiry ? new Date(expiry).toISOString() : null, periodDays: 30,
      checkoutEnabled: Boolean(enabled), token, amount: null, plan: CLOCKERS_PLAN,
      recipient: enabled ? recipient.toLowerCase() : null, chainId: scope.chainId,
      modelBilling: 'included-task-allowance', automaticRenewal: false, usage };
  }
  return Object.freeze({
    enabled: Boolean(enabled), plan: CLOCKERS_PLAN, status,
    async requireActive(scope) { if (!(await status(scope)).active) throw new Error('JEFF_HOSTING_INACTIVE'); },
    startJob(scope, start) {
      if (typeof start !== 'function' || !isAddress(scope.owner || '')) throw new Error('JEFF_USAGE_SCOPE_INVALID');
      return serialize(async () => {
        const ledger = await read(); const time = now();
        const current = describe(scope, ledger, time);
        if (!current.active) throw new Error('JEFF_HOSTING_INACTIVE');
        if (!current.usage.remaining) throw new Error('JEFF_TASK_ALLOWANCE_EXHAUSTED');
        if (!current.usage.hourlyRemaining) throw new Error('JEFF_USAGE_LIMIT_REACHED');
        const counter = periodKey(scope, current.period), wallet = walletKey(scope), id = randomUUID();
        ledger.taskUsage ||= {}; ledger.hourlyUsage ||= {};
        for (const [key, entries] of Object.entries(ledger.hourlyUsage)) {
          for (const [admission, at] of Object.entries(entries)) if (at <= time - 3600000) delete entries[admission];
          if (!Object.keys(entries).length) delete ledger.hourlyUsage[key];
        }
        ledger.taskUsage[counter] = current.usage.used + 1;
        ledger.hourlyUsage[wallet] ||= {}; ledger.hourlyUsage[wallet][id] = time;
        // A crash after this durable reservation remains counted. Never guess
        // whether a provider call happened and silently restore its allowance.
        await write(ledger);
        try { return await start(); }
        catch (error) {
          ledger.taskUsage[counter]--;
          delete ledger.hourlyUsage[wallet][id];
          await write(ledger);
          throw error;
        }
      });
    },
    invoice(scope) {
      if (!enabled) throw new Error('JEFF_CHECKOUT_UNAVAILABLE');
      return serialize(async () => {
        const quote = await quotePayment({ usdCents: CLOCKERS_PLAN.usdCents });
        const pricing = quote?.pricing;
        const fetchedAt = Date.parse(pricing?.retrievedAt || '');
        if (pricing?.usdCents !== CLOCKERS_PLAN.usdCents || pricing?.currency !== 'USD'
          || !Number.isFinite(fetchedAt) || now() - fetchedAt > 60000 || fetchedAt > now() + 15000
          || quote.amount !== usdCentsToTokenAmount({ usdCents: pricing.usdCents, tokenDecimals: pricing.tokenDecimals, priceUsd: pricing.tokenPriceUsd })) throw new Error('JEFF_PRICE_UNAVAILABLE');
        const ledger = await read();
        const issuedAt = now();
        const invoice = { id: randomUUID(), scope, token, recipient: recipient.toLowerCase(), amount: quote.amount, pricing, tasksIncluded: CLOCKERS_PLAN.tasksIncluded,
          chainId: scope.chainId, periodDays: 30, issuedAt: new Date(issuedAt).toISOString(), expiresAt: new Date(issuedAt + 15 * 60000).toISOString() };
        ledger.invoices[invoice.id] = invoice; await write(ledger); return invoice;
      });
    },
    activate(scope, { invoiceId, transactionHash }) {
      if (!enabled) throw new Error('JEFF_CHECKOUT_UNAVAILABLE');
      if (!/^[a-f0-9-]{36}$/.test(invoiceId || '') || !/^0x[a-fA-F0-9]{64}$/.test(transactionHash || '')) throw new Error('JEFF_PAYMENT_INVALID');
      return serialize(async () => {
        const ledger = await read(); const invoice = ledger.invoices[invoiceId];
        if (!invoice || JSON.stringify(invoice.scope) !== JSON.stringify(scope)) throw new Error('JEFF_INVOICE_DENIED');
        const hash = transactionHash.toLowerCase();
        if (invoice.used && invoice.transactionHash === hash) return status(scope);
        if (invoice.used || ledger.consumed[hash]) throw new Error('JEFF_PAYMENT_ALREADY_USED');
        // Confirmation or reconnect delays can outlive the quote. The verifier
        // checks the payment's block timestamp against the original quote window.
        await verifyPayment(invoice, hash);
        const key = nftKey(scope);
        const old = ledger.entitlements[key];
        const oldExpiry = Date.parse(old?.expiresAt || '');
        const startsAt = Math.max(now(), Number.isFinite(oldExpiry) ? oldExpiry : 0);
        const expiresAt = new Date(startsAt + monthMs).toISOString();
        const periods = paidPeriods(old, now());
        periods.push({ id: invoice.id, startsAt: new Date(startsAt).toISOString(), expiresAt, limit: invoice.tasksIncluded || 100 });
        ledger.entitlements[key] = { expiresAt, periods };
        ledger.consumed[hash] = invoiceId; invoice.used = true; invoice.transactionHash = hash;
        await write(ledger); return status(scope);
      });
    },
  });
}
