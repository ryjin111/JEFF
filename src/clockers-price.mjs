import { createPublicClient, defineChain, http, parseAbi } from 'viem';
import { usdCentsToTokenAmount } from './usd-amount.mjs';

export const CLOCKERS_TOKEN = '0xefc067e5d19b847da7863f3f997c2a4639686ba3';
export const CLOCKERS_POOL = '0x51d5b1869b3a406a66a4b2fe84843ab29632d511dd2e0f448a150509e894bfda';
const weth = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const endpoint = `https://api.dexscreener.com/token-pairs/v1/robinhood/${CLOCKERS_TOKEN}`;
const sourceUrl = `https://dexscreener.com/robinhood/${CLOCKERS_POOL}`;
const decimalsAbi = parseAbi(['function decimals() view returns (uint8)']);
const maximumBytes = 256 * 1024;
class PriceError extends Error {}
const fail = code => new PriceError(`JEFF_PRICE_${code}`);
const lower = value => typeof value === 'string' ? value.toLowerCase() : null;

async function readBoundedJson(response, signal) {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d{1,10}$/.test(length) || Number(length) > maximumBytes)) throw fail('RESPONSE_INVALID');
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maximumBytes) throw fail('RESPONSE_INVALID');
    return JSON.parse(text);
  }
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      if (signal.aborted) throw fail('TIMEOUT');
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) throw fail('RESPONSE_INVALID');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  } finally {
    if (size > maximumBytes || signal.aborted) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function verifyResponseAge(headers, observedAt) {
  const date = headers.get('date'), age = headers.get('age');
  const serverAt = Date.parse(date || '');
  if (!Number.isFinite(observedAt) || !Number.isFinite(serverAt)
    || new Date(serverAt).toUTCString() !== date) throw fail('RESPONSE_INVALID');
  if (age !== null && !/^\d{1,10}$/.test(age)) throw fail('STALE_RESPONSE');
  const responseAge = Math.max(observedAt - serverAt, Number(age || 0) * 1000);
  if (responseAge > 60000 || serverAt - observedAt > 15000) throw fail('STALE_RESPONSE');
}

export function createClockersUsdQuote({ rpcUrl, chainId = 4663, token = CLOCKERS_TOKEN,
  fetchImpl = fetch, now = Date.now, client } = {}) {
  let publicClient = client;
  return async ({ usdCents } = {}) => {
    try {
      if (chainId !== 4663 || lower(token) !== CLOCKERS_TOKEN || typeof fetchImpl !== 'function' || typeof now !== 'function') {
        throw fail('CONFIG_INVALID');
      }
      if (!Number.isSafeInteger(usdCents) || usdCents <= 0) throw fail('USD_INVALID');
      if (!publicClient) {
        try {
          const chain = defineChain({ id: 4663, name: 'Clockers', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
            rpcUrls: { default: { http: [rpcUrl] } } });
          publicClient = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 8000, retryCount: 0 }) });
        } catch { throw fail('CONFIG_INVALID'); }
      }
      const controller = new AbortController();
      let timer;
      try {
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => { reject(fail('TIMEOUT')); controller.abort(); }, 8000);
        });
        return await Promise.race([timeout, (async () => {
          if (await publicClient.getChainId() !== 4663) throw fail('CHAIN_MISMATCH');
          if (controller.signal.aborted) throw fail('TIMEOUT');
          const tokenDecimals = await publicClient.readContract({ address: CLOCKERS_TOKEN, abi: decimalsAbi, functionName: 'decimals' });
          if (controller.signal.aborted) throw fail('TIMEOUT');
          if (!Number.isInteger(tokenDecimals) || tokenDecimals < 0 || tokenDecimals > 36) throw fail('DECIMALS_INVALID');
          const response = await fetchImpl(endpoint, { signal: controller.signal, redirect: 'error', headers: { Accept: 'application/json' } });
          if (!response.ok) throw fail('UNAVAILABLE');
          const pairs = await readBoundedJson(response, controller.signal);
          const observedAt = now();
          // These headers describe the HTTP response, not the market price's age.
          verifyResponseAge(response.headers, observedAt);
          if (!Array.isArray(pairs)) throw fail('RESPONSE_INVALID');
          const matches = pairs.filter(pair => lower(pair?.pairAddress) === CLOCKERS_POOL);
          if (matches.length !== 1) throw fail('POOL_INVALID');
          const pair = matches[0];
          if (pair.chainId !== 'robinhood' || pair.dexId !== 'uniswap' || !Array.isArray(pair.labels) || !pair.labels.includes('v4')
            || lower(pair.baseToken?.address) !== CLOCKERS_TOKEN || lower(pair.quoteToken?.address) !== weth) throw fail('POOL_INVALID');
          if (!Number.isFinite(pair.liquidity?.usd) || pair.liquidity.usd < 10000) throw fail('LIQUIDITY_INVALID');
          let amount;
          try { amount = usdCentsToTokenAmount({ usdCents, tokenDecimals, priceUsd: pair.priceUsd }); }
          catch { throw fail('VALUE_INVALID'); }
          return { amount, pricing: { usdCents, currency: 'USD', tokenPriceUsd: pair.priceUsd, tokenDecimals,
            source: 'dexscreener', sourceUrl, poolId: CLOCKERS_POOL, retrievedAt: new Date(observedAt).toISOString(), priceUpdatedAt: null } };
        })()]);
      } finally { clearTimeout(timer); }
    } catch (error) {
      throw error instanceof PriceError ? error : fail('UNAVAILABLE');
    }
  };
}
