import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createJeffBankrReadOnlyAdapter,
  createJeffBankrReadOnlyCapability,
  JEFF_BANKR_READONLY_ADAPTER,
  verifyJeffBankrReadOnlyCapability,
  verifyJeffBankrReadOnlyReceipt,
} from '../api/_lib/jeff-bankr-readonly-adapter.mjs';
import { hashJeffBrainValue } from '../api/_lib/jeff-brain-common.mjs';

const API_KEY = 'bk_test_readonly_123456789';
const EVM_NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const FIXED_TIME = '2026-09-30T15:00:00.000Z';

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function rawJsonResponse(value, status = 200) {
  return new Response(value, {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function portfolioResponse(overrides = {}) {
  return {
    success: true,
    evmAddress: '0x1234567890abcdef1234567890abcdef12345678',
    balances: {
      base: {
        nativeBalance: '0.5',
        nativeUsd: '1500.00',
        tokenBalances: [],
        total: '1500.00',
      },
    },
    nfts: [],
    ...overrides,
  };
}

function swapQuoteResponse(overrides = {}) {
  return {
    from: {
      chain: 'base',
      token: EVM_NATIVE,
      amount: '0.01',
      formattedAmount: '0.01',
      symbol: 'ETH',
      decimals: 18,
      usdValue: '30.00',
    },
    to: {
      chain: 'base',
      token: USDC_BASE,
      amount: '30000000',
      formattedAmount: '30.00',
      symbol: 'USDC',
      decimals: 6,
      usdValue: '30.00',
    },
    minBuyAmount: '29.85',
    quoteId: '7c2f9f0e-8f1a-4d1a-9a2b-3c4d5e6f7a8b',
    slippageBps: 100,
    ...overrides,
  };
}

const SWAP_INPUT = Object.freeze({
  fromChain: 'base',
  fromToken: EVM_NATIVE,
  toChain: 'base',
  toToken: USDC_BASE,
  amount: '0.01',
  slippageBps: 100,
});

test('Bankr capability is hash-bound and permits reads only', () => {
  const capability = createJeffBankrReadOnlyCapability();
  assert.equal(verifyJeffBankrReadOnlyCapability(capability), true);
  assert.deepEqual(capability.operations, ['wallet.portfolio', 'wallet.swap_quote']);
  assert.equal(capability.writesAllowed, false);
  assert.equal(capability.transactionsAllowed, false);
  assert.equal(capability.actionsAllowed, 0);
  assert.equal(capability.executionAuthorized, false);
  assert.equal(JEFF_BANKR_READONLY_ADAPTER.baseUrl, 'https://api.bankr.bot');
  assert.throws(() => capability.operations.push('wallet.swap'), TypeError);

  const tampered = { ...capability, transactionsAllowed: true };
  assert.equal(verifyJeffBankrReadOnlyCapability(tampered), false);
});

test('portfolio read is constrained to the official endpoint and emits a hash-only receipt', async () => {
  const calls = [];
  const upstream = portfolioResponse();
  const adapter = createJeffBankrReadOnlyAdapter({
    apiKey: API_KEY,
    now: () => FIXED_TIME,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse(upstream);
    },
  });

  const result = await adapter.getPortfolio({
    chains: ['base'],
    include: ['pnl'],
    showLowValueTokens: true,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.bankr.bot/wallet/portfolio?chains=base&include=pnl&showLowValueTokens=true');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.body, undefined);
  assert.equal(calls[0].options.headers['X-API-Key'], API_KEY);
  assert.deepEqual(result.data, upstream);
  assert.equal(result.writesExecuted, 0);
  assert.equal(result.transactionsExecuted, 0);
  assert.equal(verifyJeffBankrReadOnlyReceipt(result.receipt), true);
  assert.equal(JSON.stringify(result.receipt).includes(API_KEY), false);
  assert.equal(JSON.stringify(result.receipt).includes(upstream.evmAddress), false);
});

test('swap quote uses the official read-only quote endpoint and never executes a swap', async () => {
  const calls = [];
  const quote = swapQuoteResponse();
  const adapter = createJeffBankrReadOnlyAdapter({
    apiKey: API_KEY,
    now: () => FIXED_TIME,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse(quote);
    },
  });

  const result = await adapter.getSwapQuote(SWAP_INPUT);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.bankr.bot/wallet/swap-quote');
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].options.body), SWAP_INPUT);
  assert.equal(calls[0].url.endsWith('/wallet/swap'), false);
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.actionsExecuted, 0);
  assert.equal(result.writesExecuted, 0);
  assert.equal(result.transactionsExecuted, 0);
  assert.equal(verifyJeffBankrReadOnlyReceipt(result.receipt), true);
  assert.equal(result.receipt.responseSchema, 'bankr-wallet-swap-quote-normalized-v1');
  assert.equal(result.receipt.responseSha256, hashJeffBrainValue(result.data));
  assert.equal(Object.isFrozen(result.data), true);
  assert.equal(Object.isFrozen(result.data.from), true);
});

test('documented quote defaults and case-insensitive EVM tokens normalize safely', async () => {
  const input = { ...SWAP_INPUT };
  delete input.slippageBps;
  const quote = swapQuoteResponse({
    from: { ...swapQuoteResponse().from, token: EVM_NATIVE.toUpperCase().replace('0X', '0x') },
    to: { ...swapQuoteResponse().to, token: '0x833589FcD6eDb6e08f4c7C32D4f71B54Bda02913' },
    slippageBps: 500,
    feeBps: 100,
    feeWaivedForEcosystemToken: false,
    priceImpactBps: 12,
    swapImpactBps: null,
    networkCostsUsd: null,
    maxPriceImpactBps: 1500,
    sellTokenPriceUsd: 3000,
    buyTokenPriceUsd: 1,
  });
  const adapter = createJeffBankrReadOnlyAdapter({
    apiKey: API_KEY,
    fetchImpl: async () => jsonResponse(quote),
  });
  const result = await adapter.getSwapQuote(input);
  assert.equal(result.data.from.token, EVM_NATIVE);
  assert.equal(result.data.to.token, USDC_BASE);
  assert.equal(result.data.slippageBps, 500);
});

test('documented portfolio token, PnL, and NFT fields normalize safely', async () => {
  const portfolio = portfolioResponse({
    balances: {
      base: {
        ...portfolioResponse().balances.base,
        tokenBalances: [{
          network: 'base',
          token: {
            balance: '30.00',
            balanceUSD: 30,
            bankrDeployed: false,
            whitelisted: true,
            userAcquired: true,
            baseToken: {
              name: 'USD Coin',
              address: USDC_BASE,
              symbol: 'USDC',
              price: 1,
              imgUrl: 'https://example.com/usdc.png',
              decimals: 6,
            },
            pnl: {
              realizedPnl: -1,
              unrealizedPnl: 2,
              totalPnl: 1,
              averageEntryPrice: 1,
              remainingAmount: 30,
            },
          },
        }],
      },
    },
    nfts: [{
      name: 'Room #1',
      tokenId: '1',
      collection: { name: 'Clockers Room', address: USDC_BASE },
      chain: 'base',
    }],
  });
  const adapter = createJeffBankrReadOnlyAdapter({
    apiKey: API_KEY,
    fetchImpl: async () => jsonResponse(portfolio),
  });
  const result = await adapter.getPortfolio({ chains: ['base'], include: ['nfts', 'pnl'] });
  assert.equal(result.data.balances.base.tokenBalances[0].token.pnl.totalPnl, 1);
  assert.equal(result.data.nfts[0].tokenId, '1');
  assert.equal(result.receipt.responseSha256, hashJeffBrainValue(result.data));
});

test('swap quote is bound to the requested chains, tokens, and sell amount', async () => {
  const mismatches = [
    swapQuoteResponse({ from: { ...swapQuoteResponse().from, chain: 'mainnet' } }),
    swapQuoteResponse({ from: { ...swapQuoteResponse().from, token: USDC_BASE } }),
    swapQuoteResponse({ from: { ...swapQuoteResponse().from, amount: '0.02', formattedAmount: '0.02' } }),
    swapQuoteResponse({ to: { ...swapQuoteResponse().to, chain: 'polygon' } }),
    swapQuoteResponse({ to: { ...swapQuoteResponse().to, token: EVM_NATIVE } }),
  ];
  for (const quote of mismatches) {
    const adapter = createJeffBankrReadOnlyAdapter({
      apiKey: API_KEY,
      fetchImpl: async () => jsonResponse(quote),
    });
    await assert.rejects(adapter.getSwapQuote(SWAP_INPUT), /SWAP_QUOTE_RESPONSE_INVALID/);
  }
});

test('Solana mint binding is case-sensitive', async () => {
  const solMint = 'So11111111111111111111111111111111111111112';
  const input = {
    fromChain: 'solana',
    fromToken: solMint,
    toChain: 'base',
    toToken: USDC_BASE,
    amount: '0.01',
  };
  const quote = swapQuoteResponse({
    from: {
      ...swapQuoteResponse().from,
      chain: 'solana',
      token: `s${solMint.slice(1)}`,
    },
    slippageBps: 500,
  });
  const adapter = createJeffBankrReadOnlyAdapter({
    apiKey: API_KEY,
    fetchImpl: async () => jsonResponse(quote),
  });
  await assert.rejects(adapter.getSwapQuote(input), /SWAP_QUOTE_RESPONSE_INVALID/);
});

test('swap quote rejects executable payloads and execution-shaped responses', async () => {
  const hostile = [
    swapQuoteResponse({ rawTransaction: '0xdeadbeef' }),
    swapQuoteResponse({ from: { ...swapQuoteResponse().from, calldata: '0xdeadbeef' } }),
    swapQuoteResponse({ instructions: ['sign', 'submit'] }),
    swapQuoteResponse({ submitUrl: 'https://attacker.example/submit' }),
    swapQuoteResponse({ payload: { route: 'untrusted-raw-payload' } }),
    { success: true, hash: `0x${'ab'.repeat(32)}`, amountSold: 0.01, amountReceived: 30 },
  ];
  for (const quote of hostile) {
    const adapter = createJeffBankrReadOnlyAdapter({
      apiKey: API_KEY,
      fetchImpl: async () => jsonResponse(quote),
    });
    await assert.rejects(
      adapter.getSwapQuote(SWAP_INPUT),
      /EXECUTION_MATERIAL_REJECTED|SWAP_QUOTE_RESPONSE_INVALID/,
    );
  }
});

test('swap quote rejects zero, malformed, unbounded, and inconsistent amounts', async () => {
  const invalid = [
    swapQuoteResponse({ minBuyAmount: '0' }),
    swapQuoteResponse({ minBuyAmount: '30.01' }),
    swapQuoteResponse({ minBuyAmount: '1e9' }),
    swapQuoteResponse({ to: { ...swapQuoteResponse().to, amount: '0' } }),
    swapQuoteResponse({ to: { ...swapQuoteResponse().to, formattedAmount: '9'.repeat(79) } }),
    swapQuoteResponse({ slippageBps: 500 }),
  ];
  for (const quote of invalid) {
    const adapter = createJeffBankrReadOnlyAdapter({
      apiKey: API_KEY,
      fetchImpl: async () => jsonResponse(quote),
    });
    await assert.rejects(adapter.getSwapQuote(SWAP_INPUT), /SWAP_QUOTE_RESPONSE_INVALID/);
  }
});

test('portfolio rejects malformed shapes, executable material, and unrequested chains', async () => {
  const baseBalance = portfolioResponse().balances.base;
  const invalid = [
    portfolioResponse({ balances: { polygon: baseBalance } }),
    portfolioResponse({ balances: { base: { ...baseBalance, nativeBalance: '-1' } } }),
    portfolioResponse({ balances: { base: { ...baseBalance, transaction: '0xdeadbeef' } } }),
    portfolioResponse({ nfts: Array.from({ length: 4_097 }, () => null) }),
    portfolioResponse({ balances: { base: { ...baseBalance, nativeUsd: null } } }),
  ];
  for (const portfolio of invalid) {
    const adapter = createJeffBankrReadOnlyAdapter({
      apiKey: API_KEY,
      fetchImpl: async () => jsonResponse(portfolio),
    });
    await assert.rejects(
      adapter.getPortfolio({ chains: ['base'] }),
      /EXECUTION_MATERIAL_REJECTED|PORTFOLIO_RESPONSE_INVALID/,
    );
  }
});

test('portfolio rejects prototype keys and nested calldata from raw JSON', async () => {
  const base = JSON.stringify(portfolioResponse());
  const hostileJson = `${base.slice(0, -1)},"__proto__":{"calldata":"0xdeadbeef"}}`;
  const adapter = createJeffBankrReadOnlyAdapter({
    apiKey: API_KEY,
    fetchImpl: async () => rawJsonResponse(hostileJson),
  });
  await assert.rejects(adapter.getPortfolio({ chains: ['base'] }), /EXECUTION_MATERIAL_REJECTED/);
});

test('portfolio rejects JSON numeric overflow as a non-finite financial value', async () => {
  const raw = JSON.stringify(portfolioResponse()).replace('"nativeUsd":"1500.00"', '"nativeUsd":1e309');
  const adapter = createJeffBankrReadOnlyAdapter({
    apiKey: API_KEY,
    fetchImpl: async () => rawJsonResponse(raw),
  });
  await assert.rejects(adapter.getPortfolio({ chains: ['base'] }), /PORTFOLIO_RESPONSE_INVALID/);
});

test('adapter rejects non-JSON content types and byte-oversized bodies', async () => {
  const nonJsonAdapter = createJeffBankrReadOnlyAdapter({
    apiKey: API_KEY,
    fetchImpl: async () => new Response(JSON.stringify(portfolioResponse()), {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    }),
  });
  await assert.rejects(nonJsonAdapter.getPortfolio(), /RESPONSE_INVALID/);

  const oversizedAdapter = createJeffBankrReadOnlyAdapter({
    apiKey: API_KEY,
    fetchImpl: async () => rawJsonResponse(`{"padding":"${'€'.repeat(200_000)}"}`),
  });
  await assert.rejects(oversizedAdapter.getPortfolio(), /RESPONSE_INVALID/);
});

test('unknown fields, invalid chains, unsafe amounts, and same-token swaps fail before fetch', async () => {
  let calls = 0;
  const adapter = createJeffBankrReadOnlyAdapter({
    apiKey: API_KEY,
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ success: true });
    },
  });
  await assert.rejects(adapter.getPortfolio({ arbitraryUrl: 'https://attacker.example' }), /PORTFOLIO_INPUT_INVALID/);
  await assert.rejects(adapter.getPortfolio({ chains: ['unknown'] }), /PORTFOLIO_INPUT_INVALID/);
  await assert.rejects(adapter.getSwapQuote({
    fromChain: 'base', fromToken: EVM_NATIVE, toChain: 'base', toToken: USDC_BASE,
    amount: '1e9',
  }), /SWAP_QUOTE_INPUT_INVALID/);
  await assert.rejects(adapter.getSwapQuote({
    fromChain: 'base', fromToken: USDC_BASE, toChain: 'base', toToken: USDC_BASE,
    amount: '1',
  }), /SWAP_QUOTE_INPUT_INVALID/);
  await assert.rejects(adapter.getSwapQuote({
    fromChain: 'base', fromToken: EVM_NATIVE, toChain: 'base', toToken: USDC_BASE,
    amount: '1', slippageBps: 2_001,
  }), /SWAP_QUOTE_INPUT_INVALID/);
  assert.equal(calls, 0);
});

test('adapter refuses alternate hosts, malformed keys, and unsafe configuration', () => {
  assert.throws(() => createJeffBankrReadOnlyAdapter({
    apiKey: 'not-a-key',
    fetchImpl: async () => jsonResponse({}),
  }), /ADAPTER_INVALID/);
  assert.throws(() => createJeffBankrReadOnlyAdapter({
    apiKey: API_KEY,
    baseUrl: 'https://attacker.example',
    fetchImpl: async () => jsonResponse({}),
  }), /ADAPTER_INVALID/);
  assert.throws(() => createJeffBankrReadOnlyAdapter({
    apiKey: API_KEY,
    timeoutMs: 60_000,
    fetchImpl: async () => jsonResponse({}),
  }), /ADAPTER_INVALID/);
});

test('upstream failures are sanitized and receipt tampering is rejected', async () => {
  const adapter = createJeffBankrReadOnlyAdapter({
    apiKey: API_KEY,
    now: () => FIXED_TIME,
    fetchImpl: async () => jsonResponse({ message: `leaked ${API_KEY}` }, 403),
  });
  await assert.rejects(
    adapter.getPortfolio(),
    (error) => error.message === 'JEFF_BANKR_UPSTREAM_403' && !error.message.includes(API_KEY),
  );

  const validAdapter = createJeffBankrReadOnlyAdapter({
    apiKey: API_KEY,
    now: () => FIXED_TIME,
    fetchImpl: async () => jsonResponse({
      success: true,
      evmAddress: '0x1234567890abcdef1234567890abcdef12345678',
      balances: {},
      nfts: [],
    }),
  });
  const result = await validAdapter.getPortfolio();
  assert.equal(verifyJeffBankrReadOnlyReceipt(result.receipt), true);
  assert.equal(verifyJeffBankrReadOnlyReceipt({ ...result.receipt, writesExecuted: 1 }), false);
  assert.equal(verifyJeffBankrReadOnlyReceipt({
    ...result.receipt,
    responseSchema: 'bankr-wallet-swap-quote-normalized-v1',
  }), false);

  const { receiptSha256: ignored, ...fakeBody } = {
    ...result.receipt,
    method: 'POST',
    endpoint: '/wallet/swap',
  };
  const fullyRehashedFake = {
    ...fakeBody,
    receiptSha256: hashJeffBrainValue(fakeBody),
  };
  assert.equal(verifyJeffBankrReadOnlyReceipt(fullyRehashedFake), false);
});
