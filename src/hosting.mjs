import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isAddress } from 'viem';

const monthMs = 30 * 86400000;
const nftKey = scope => createHash('sha256').update(scope.kind === 'account' ? `account:${scope.chainId}:${scope.owner}` : `${scope.chainId}:${scope.collection}:${scope.tokenId}`).digest('hex');
export function createHostingLedger({ dataRoot, env = process.env, verifyPayment, now = () => Date.now() }) {
  const directory = resolve(dataRoot, 'hosting');
  const file = resolve(directory, 'ledger.json');
  let queue = Promise.resolve();
  const pilotIds = new Set(String(env.JEFF_PILOT_NFTS || '').split(',').filter(Boolean));
  const pilotExpiry = Date.parse(env.JEFF_PILOT_EXPIRES_AT || '');
  const token = env.CLOCKERS_TOKEN_ADDRESS || '0xefc067e5d19b847da7863f3f997c2a4639686ba3';
  const recipient = env.CLOCKERS_PAYMENT_RECIPIENT;
  const amount = env.CLOCKERS_MONTHLY_AMOUNT;
  const enabled = env.JEFF_PAID_CHECKOUT_ENABLED === 'true' && isAddress(token) && isAddress(recipient || '')
    && recipient.toLowerCase() !== '0x' + '0'.repeat(40) && /^[1-9]\d*$/.test(amount || '') && BigInt(amount) < 2n ** 256n;
  async function read() {
    try { return JSON.parse(await readFile(file, 'utf8')); }
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
  async function status(scope) {
    const ledger = await read();
    const paidExpiry = Date.parse(ledger.entitlements[nftKey(scope)]?.expiresAt || '');
    const pilot = scope.kind !== 'account' && pilotIds.has(scope.tokenId) && pilotExpiry > now();
    const expiry = Math.max(Number.isFinite(paidExpiry) ? paidExpiry : 0, pilot ? pilotExpiry : 0);
    return { active: expiry > now(), source: paidExpiry > now() ? 'paid' : pilot ? 'pilot' : null,
      expiresAt: expiry ? new Date(expiry).toISOString() : null, periodDays: 30,
      checkoutEnabled: Boolean(enabled), token, amount: enabled ? amount : null,
      recipient: enabled ? recipient.toLowerCase() : null, chainId: scope.chainId,
      modelBilling: 'pilot-funded-with-usage-limits', automaticRenewal: false };
  }
  return Object.freeze({
    enabled: Boolean(enabled), status,
    async requireActive(scope) { if (!(await status(scope)).active) throw new Error('JEFF_HOSTING_INACTIVE'); },
    invoice(scope) {
      if (!enabled) throw new Error('JEFF_CHECKOUT_UNAVAILABLE');
      return serialize(async () => {
        const ledger = await read();
        const invoice = { id: randomUUID(), scope, token, recipient: recipient.toLowerCase(), amount,
          chainId: scope.chainId, periodDays: 30, issuedAt: new Date(now()).toISOString(), expiresAt: new Date(now() + 15 * 60000).toISOString() };
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
        const oldExpiry = Date.parse(ledger.entitlements[key]?.expiresAt || '');
        const expiresAt = new Date(Math.max(now(), Number.isFinite(oldExpiry) ? oldExpiry : 0) + monthMs).toISOString();
        ledger.entitlements[key] = { expiresAt };
        ledger.consumed[hash] = invoiceId; invoice.used = true; invoice.transactionHash = hash;
        await write(ledger); return status(scope);
      });
    },
  });
}
