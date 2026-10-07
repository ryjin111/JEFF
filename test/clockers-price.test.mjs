import test from 'node:test';
import assert from 'node:assert/strict';
import { CLOCKERS_TOKEN, CLOCKERS_POOL, createClockersUsdQuote } from '../src/clockers-price.mjs';

const currentTime = Date.parse('2026-10-07T12:00:00.000Z');
const weth = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
const endpoint = `https://api.dexscreener.com/token-pairs/v1/robinhood/${CLOCKERS_TOKEN}`;

function pair(overrides = {}) {
  return { chainId: 'robinhood', dexId: 'uniswap', labels: ['v4'], pairAddress: CLOCKERS_POOL,
    baseToken: { address: CLOCKERS_TOKEN }, quoteToken: { address: weth }, priceUsd: '0.0025',
    liquidity: { usd: 10000 }, url: `https://dexscreener.com/robinhood/${CLOCKERS_POOL}`, ...overrides };
}

function response(pairs = [pair()], { headers = {}, status = 200 } = {}) {
  const resultHeaders = new Headers({ Date: new Date(currentTime).toUTCString() });
  for (const [name, value] of Object.entries(headers)) {
    if (value === null) resultHeaders.delete(name);
    else resultHeaders.set(name, value);
  }
  return new Response(JSON.stringify(pairs), { status, headers: resultHeaders });
}

function fixture({ pairs = [pair()], headers, status, fetchImpl, client, ...options } = {}) {
  const requests = [], reads = [];
  const rpc = client ?? { getChainId: async () => 4663, readContract: async input => { reads.push(input); return 18; } };
  const quote = createClockersUsdQuote({ rpcUrl: 'https://rpc.example.invalid', chainId: 4663, token: CLOCKERS_TOKEN,
    now: () => currentTime, client: rpc,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return fetchImpl ? fetchImpl(url, init) : response(pairs, { headers, status });
    }, ...options });
  return { quote, requests, reads };
}

async function rejectsPrice(action) {
  await assert.rejects(action, error => {
    assert.match(error.message, /^JEFF_PRICE_[A-Z_]+$/);
    return true;
  });
}

test('quote pins the endpoint, pool, token and decimals while retaining price evidence', async () => {
  assert.equal(CLOCKERS_TOKEN, '0xefc067e5d19b847da7863f3f997c2a4639686ba3');
  assert.equal(CLOCKERS_POOL, '0x51d5b1869b3a406a66a4b2fe84843ab29632d511dd2e0f448a150509e894bfda');
  const f = fixture();
  const result = await f.quote({ usdCents: 1000 });
  assert.equal(result.amount, '4000000000000000000000');
  assert.deepEqual(result.pricing, { usdCents: 1000, currency: 'USD', tokenPriceUsd: '0.0025', tokenDecimals: 18,
    source: 'dexscreener', sourceUrl: `https://dexscreener.com/robinhood/${CLOCKERS_POOL}`, poolId: CLOCKERS_POOL,
    retrievedAt: new Date(currentTime).toISOString(), priceUpdatedAt: null });
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url, endpoint);
  assert.equal(f.requests[0].init.redirect, 'error');
  assert.ok(f.requests[0].init.signal instanceof AbortSignal);
  assert.equal(f.requests[0].init.signal.aborted, false);
  assert.equal(f.reads.length, 1);
  assert.equal(f.reads[0].address.toLowerCase(), CLOCKERS_TOKEN);
  assert.equal(f.reads[0].functionName, 'decimals');
});

test('quote rounds decimal prices upward using the verified token decimals', async () => {
  assert.equal((await fixture({ pairs: [pair({ priceUsd: '0.3' })] }).quote({ usdCents: 1000 })).amount, '33333333333333333334');
  const zeroDecimals = { getChainId: async () => 4663, readContract: async () => 0 };
  assert.equal((await fixture({ pairs: [pair({ priceUsd: '3' })], client: zeroDecimals }).quote({ usdCents: 1000 })).amount, '4');
  const sixDecimals = { getChainId: async () => 4663, readContract: async () => 6 };
  assert.equal((await fixture({ pairs: [pair({ priceUsd: '0.333333333333333333' })], client: sixDecimals }).quote({ usdCents: 1 })).amount, '30001');
});

test('only the pinned chain, token and RPC chain are accepted', async () => {
  for (const options of [{ chainId: 1 }, { chainId: '4663' }, { token: '0x' + '11'.repeat(20) }]) {
    const { quote } = fixture(options);
    await assert.rejects(() => quote({ usdCents: 1000 }), /^Error: JEFF_PRICE_CONFIG_INVALID$/);
  }
  await rejectsPrice(() => fixture({ client: { getChainId: async () => 1, readContract: async () => 18 } }).quote({ usdCents: 1000 }));
  for (const tokenDecimals of [-1, 37, 1.5, '18', Number.NaN, Number.POSITIVE_INFINITY]) {
    await rejectsPrice(() => fixture({ client: { getChainId: async () => 4663, readContract: async () => tokenDecimals } }).quote({ usdCents: 1000 }));
  }
});

test('invalid USD amounts reject before a price request is sent', async () => {
  for (const usdCents of [undefined, null, '1000', 0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    const f = fixture();
    await rejectsPrice(() => f.quote({ usdCents }));
    assert.equal(f.requests.length, 0);
  }
});

test('retrieval time records body receipt without being reset by later RPC work', async () => {
  let time = currentTime;
  const f = fixture({ now: () => time,
    client: { getChainId: async () => 4663, readContract: async () => { time += 30000; return 18; } },
    fetchImpl: async () => ({ ok: true, headers: new Headers({ Date: new Date(currentTime).toUTCString() }),
      text: async () => { time = currentTime; return JSON.stringify([pair()]); } }) });
  assert.equal((await f.quote({ usdCents: 1000 })).pricing.retrievedAt, new Date(currentTime).toISOString());
});

test('a unique pool must have the pinned chain, exchange, version and token identities', async t => {
  const cases = [
    ['missing pool', []],
    ['wrong pool', [pair({ pairAddress: '0x' + '00'.repeat(32) })]],
    ['wrong chain', [pair({ chainId: 'ethereum' })]],
    ['wrong exchange', [pair({ dexId: 'sushiswap' })]],
    ['wrong version', [pair({ labels: ['v3'] })]],
    ['missing version', [pair({ labels: undefined })]],
    ['wrong base token', [pair({ baseToken: { address: weth } })]],
    ['wrong quote token', [pair({ quoteToken: { address: CLOCKERS_TOKEN } })]],
    ['missing base token', [pair({ baseToken: undefined })]],
    ['missing quote token', [pair({ quoteToken: undefined })]],
    ['duplicate valid pool', [pair(), pair()]],
    ['duplicate pool with invalid identity', [pair(), pair({ chainId: 'ethereum' })]],
  ];
  for (const [name, pairs] of cases) {
    await t.test(name, () => rejectsPrice(() => fixture({ pairs }).quote({ usdCents: 1000 })));
  }
});

test('only finite numeric liquidity of at least ten thousand USD is accepted', async () => {
  for (const liquidity of [undefined, null, {}, { usd: null }, { usd: '10000' }, { usd: -1 },
    { usd: 9999.99 }, { usd: Number.NaN }, { usd: Number.POSITIVE_INFINITY }]) {
    await rejectsPrice(() => fixture({ pairs: [pair({ liquidity })] }).quote({ usdCents: 1000 }));
  }
  assert.equal((await fixture({ pairs: [pair({ liquidity: { usd: 10000 } })] }).quote({ usdCents: 1000 })).amount, '4000000000000000000000');
});

test('HTTP Date and Age enforce freshness with inclusive sixty-second and fifteen-second bounds', async t => {
  const valid = [
    ['Age absent', {}], ['Age zero', { Age: '0' }], ['Age sixty', { Age: '60' }], ['Age leading zeros', { Age: '00060' }],
    ['Date sixty seconds old', { Date: new Date(currentTime - 60000).toUTCString() }],
    ['Date fifteen seconds ahead', { Date: new Date(currentTime + 15000).toUTCString() }],
  ];
  for (const [name, headers] of valid) {
    await t.test(name, async () => assert.ok((await fixture({ headers }).quote({ usdCents: 1000 })).amount));
  }
  const invalid = [
    ['missing Date', { Date: null }], ['invalid Date', { Date: 'invalid date' }],
    ['stale Date', { Date: new Date(currentTime - 61000).toUTCString() }],
    ['future Date', { Date: new Date(currentTime + 16000).toUTCString() }],
    ['old cache', { Age: '61' }], ['negative cache age', { Age: '-1' }],
    ['fractional cache age', { Age: '1.5' }], ['invalid cache age', { Age: 'NaN' }], ['empty cache age', { Age: '' }],
  ];
  for (const [name, headers] of invalid) {
    await t.test(name, () => rejectsPrice(() => fixture({ headers }).quote({ usdCents: 1000 })));
  }
});

test('prices must retain the strict positive decimal string grammar', async () => {
  for (const priceUsd of [undefined, null, 0.0025, '', '0', '-1', '+1', ' 1', '1 ', '1e-3', 'NaN', 'Infinity',
    '.25', '1.', '0.0000000000000000001', '1' + '0'.repeat(78)]) {
    await rejectsPrice(() => fixture({ pairs: [pair({ priceUsd })] }).quote({ usdCents: 1000 }));
  }
  assert.equal((await fixture({ pairs: [pair({ priceUsd: '000.002500' })] }).quote({ usdCents: 1000 })).amount, '4000000000000000000000');
});

test('network, abort, timeout and RPC exceptions are normalized to price errors', async t => {
  for (const failure of [new Error('secret network detail'), new DOMException('aborted', 'AbortError'), new DOMException('timed out', 'TimeoutError')]) {
    await t.test(failure.name, () => rejectsPrice(() => fixture({ fetchImpl: async () => { throw failure; } }).quote({ usdCents: 1000 })));
  }
  await rejectsPrice(() => fixture({ client: { getChainId: async () => { throw new Error('secret RPC failure'); }, readContract: async () => 18 } }).quote({ usdCents: 1000 }));
  await rejectsPrice(() => fixture({ client: { getChainId: async () => 4663, readContract: async () => { throw new Error('secret contract failure'); } } }).quote({ usdCents: 1000 }));
});

test('a stalled fetch stays pending through 7999 milliseconds and aborts at eight seconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal, markStarted;
  const started = new Promise(resolveStarted => { markStarted = resolveStarted; });
  const f = fixture({ fetchImpl: async (_url, init) => {
    signal = init.signal;
    markStarted();
    return new Promise(() => {});
  } });
  let settled = false;
  const result = f.quote({ usdCents: 1000 });
  result.then(() => { settled = true; }, () => { settled = true; });
  const rejected = assert.rejects(result, /^Error: JEFF_PRICE_TIMEOUT$/);
  await started;
  t.mock.timers.tick(7999);
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(signal.aborted, true);
});

test('the eight-second deadline also bounds a stalled RPC chain lookup', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let markStarted, contractReads = 0;
  const started = new Promise(resolveStarted => { markStarted = resolveStarted; });
  const f = fixture({ client: {
    getChainId: async () => { markStarted(); return new Promise(() => {}); },
    readContract: async () => { contractReads++; return 18; },
  } });
  let settled = false;
  const result = f.quote({ usdCents: 1000 });
  result.then(() => { settled = true; }, () => { settled = true; });
  const rejected = assert.rejects(result, /^Error: JEFF_PRICE_TIMEOUT$/);
  await started;
  t.mock.timers.tick(7999);
  await Promise.resolve();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(contractReads, 0);
  assert.equal(f.requests.length, 0);
});

test('HTTP failures, invalid JSON, invalid response shapes and oversized bodies are rejected', async () => {
  for (const status of [301, 429, 500]) {
    await rejectsPrice(() => fixture({ status }).quote({ usdCents: 1000 }));
  }
  for (const body of ['not JSON', '{}', 'null', JSON.stringify([pair()]) + ' '.repeat(256 * 1024)]) {
    await rejectsPrice(() => fixture({ fetchImpl: async () => new Response(body, { headers: { Date: new Date(currentTime).toUTCString() } }) }).quote({ usdCents: 1000 }));
  }
  await rejectsPrice(() => fixture({ fetchImpl: async () => ({ ok: true,
    headers: new Headers({ Date: new Date(currentTime).toUTCString() }), text: async () => JSON.stringify([pair()]) + ' '.repeat(256 * 1024) }) }).quote({ usdCents: 1000 }));
  await rejectsPrice(() => fixture({ headers: { 'Content-Length': String(256 * 1024 + 1) } }).quote({ usdCents: 1000 }));
  const encoded = JSON.stringify([pair()]);
  const maximumBody = encoded + ' '.repeat(256 * 1024 - Buffer.byteLength(encoded));
  assert.ok((await fixture({ fetchImpl: async () => new Response(maximumBody,
    { headers: { Date: new Date(currentTime).toUTCString() } }) }).quote({ usdCents: 1000 })).amount);
});
