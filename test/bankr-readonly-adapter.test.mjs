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
  const upstream = {
    success: true,
    evmAddress: '0x1234567890abcdef1234567890abcdef12345678',
    balances: { base: { nativeBalance: '0.5', total: '100.00', tokenBalances: [] } },
  };
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
  const quote = {
    from: { chain: 'base', token: EVM_NATIVE, amount: '0.01' },
    to: { chain: 'base', token: USDC_BASE, amount: '30.00' },
    minBuyAmount: '29.85',
    quoteId: '7c2f9f0e-8f1a-4d1a-9a2b-3c4d5e6f7a8b',
  };
  const adapter = createJeffBankrReadOnlyAdapter({
    apiKey: API_KEY,
    now: () => FIXED_TIME,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse(quote);
    },
  });

  const input = {
    fromChain: 'base',
    fromToken: EVM_NATIVE,
    toChain: 'base',
    toToken: USDC_BASE,
    amount: '0.01',
    slippageBps: 100,
  };
  const result = await adapter.getSwapQuote(input);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.bankr.bot/wallet/swap-quote');
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].options.body), input);
  assert.equal(calls[0].url.endsWith('/wallet/swap'), false);
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.actionsExecuted, 0);
  assert.equal(result.writesExecuted, 0);
  assert.equal(result.transactionsExecuted, 0);
  assert.equal(verifyJeffBankrReadOnlyReceipt(result.receipt), true);
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
    fetchImpl: async () => jsonResponse({ success: true }),
  });
  const result = await validAdapter.getPortfolio();
  assert.equal(verifyJeffBankrReadOnlyReceipt(result.receipt), true);
  assert.equal(verifyJeffBankrReadOnlyReceipt({ ...result.receipt, writesExecuted: 1 }), false);

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
