import {
  assertJeffIsoTimestamp,
  hashJeffBrainValue,
  isJeffRecord,
  JEFF_HASH,
} from './jeff-brain-common.mjs';

const CAPABILITY_SCHEMA = 'jeff-bankr-readonly-capability-v1';
const RECEIPT_SCHEMA = 'jeff-bankr-readonly-receipt-v2';
const RESULT_SCHEMA = 'jeff-bankr-readonly-result-v1';
const PORTFOLIO_RESPONSE_SCHEMA = 'bankr-wallet-portfolio-normalized-v1';
const SWAP_QUOTE_RESPONSE_SCHEMA = 'bankr-wallet-swap-quote-normalized-v1';
const ADAPTER_ID = 'jeff.bankr.wallet.readonly.v1';
const BANKR_BASE_URL = 'https://api.bankr.bot';
const MAX_RESPONSE_BYTES = 512 * 1_024;
const BANKR_KEY = /^bk_[A-Za-z0-9_-]{8,255}$/;
const EVM_TOKEN = /^0x[a-fA-F0-9]{40}$/;
const SOLANA_MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const DECIMAL_AMOUNT = /^(?:\d+(?:\.\d*)?|\.\d+)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_DECIMAL_DIGITS = 78;
const MAX_TOKEN_BALANCES = 4_096;
const MAX_NFTS = 4_096;
const MAX_SAFE_FINANCIAL_VALUE = 1e18;
const PORTFOLIO_CHAINS = new Set([
  'base', 'polygon', 'mainnet', 'unichain', 'worldchain',
  'arbitrum', 'bnb', 'robinhood', 'arc', 'solana',
]);
const SWAP_CHAINS = new Set(PORTFOLIO_CHAINS);
const PORTFOLIO_INCLUDES = new Set(['pnl', 'nfts']);
const OPERATIONS = Object.freeze(['wallet.portfolio', 'wallet.swap_quote']);
const EXECUTION_KEYS = new Set([
  'broadcast', 'calldata', 'data', 'execute', 'execution', 'instruction', 'instructions',
  'payload', 'rawpayload', 'rawtransaction', 'rawtx', 'signature', 'signedtransaction',
  'signrequest', 'signurl', 'submit', 'submiturl', 'transaction', 'transactionhash',
  'transactions', 'transactionurl', 'tx', 'txhash', 'txurl',
]);

function exactKeys(value, allowed) {
  return isJeffRecord(value)
    && Object.keys(value).every((key) => allowed.includes(key));
}

function hasKeys(value, required) {
  return required.every((key) => Object.hasOwn(value, key));
}

function boundedString(value, maxLength) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && value === value.trim();
}

function decimalString(value, { positive = false } = {}) {
  return typeof value === 'string'
    && value.length <= 80
    && DECIMAL_AMOUNT.test(value)
    && value.replace('.', '').length <= MAX_DECIMAL_DIGITS
    && (!positive || /[1-9]/.test(value));
}

function finiteFinancialNumber(value, { signed = false } = {}) {
  return typeof value === 'number'
    && Number.isFinite(value)
    && Math.abs(value) <= MAX_SAFE_FINANCIAL_VALUE
    && (signed || value >= 0);
}

function normalizeDecimalParts(value) {
  let [integer = '', fraction = ''] = value.split('.');
  integer = (integer || '0').replace(/^0+(?=\d)/, '');
  fraction = fraction.replace(/0+$/, '');
  return { integer, fraction };
}

function compareDecimals(left, right) {
  const a = normalizeDecimalParts(left);
  const b = normalizeDecimalParts(right);
  if (a.integer.length !== b.integer.length) return a.integer.length < b.integer.length ? -1 : 1;
  if (a.integer !== b.integer) return a.integer < b.integer ? -1 : 1;
  const length = Math.max(a.fraction.length, b.fraction.length);
  const af = a.fraction.padEnd(length, '0');
  const bf = b.fraction.padEnd(length, '0');
  return af === bf ? 0 : af < bf ? -1 : 1;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function containsExecutionMaterial(value) {
  const stack = [{ value, depth: 0 }];
  let visited = 0;
  while (stack.length) {
    const current = stack.pop();
    visited += 1;
    if (visited > 50_000 || current.depth > 32) return true;
    if (Array.isArray(current.value)) {
      for (const child of current.value) stack.push({ value: child, depth: current.depth + 1 });
      continue;
    }
    if (!isJeffRecord(current.value)) continue;
    for (const [key, child] of Object.entries(current.value)) {
      if (EXECUTION_KEYS.has(key.toLowerCase())) return true;
      stack.push({ value: child, depth: current.depth + 1 });
    }
  }
  return false;
}

function capabilityBody(capability) {
  if (!isJeffRecord(capability)) return null;
  const { capabilitySha256, ...body } = capability;
  return body;
}

function receiptBody(receipt) {
  if (!isJeffRecord(receipt)) return null;
  const { receiptSha256, ...body } = receipt;
  return body;
}

function validPortfolioReceiptEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || !endpoint.startsWith('/wallet/portfolio')) return false;
  let url;
  try {
    url = new URL(endpoint, BANKR_BASE_URL);
  } catch {
    return false;
  }
  if (url.origin !== BANKR_BASE_URL
    || url.pathname !== '/wallet/portfolio'
    || `${url.pathname}${url.search}` !== endpoint
    || [...url.searchParams.keys()].some((key) => !['chains', 'include', 'showLowValueTokens'].includes(key))
    || ['chains', 'include', 'showLowValueTokens'].some((key) => url.searchParams.getAll(key).length > 1)) return false;
  const chainsValue = url.searchParams.get('chains');
  const includeValue = url.searchParams.get('include');
  const lowValue = url.searchParams.get('showLowValueTokens');
  if (lowValue !== null && lowValue !== 'true') return false;
  try {
    const normalized = normalizePortfolioInput({
      chains: chainsValue === null ? [] : chainsValue.split(','),
      include: includeValue === null ? [] : includeValue.split(','),
      showLowValueTokens: lowValue === 'true',
    });
    return portfolioRequest(normalized).endpoint === endpoint;
  } catch {
    return false;
  }
}

function validReceiptRoute(receipt) {
  if (receipt.operation === 'wallet.portfolio') {
    return receipt.method === 'GET' && validPortfolioReceiptEndpoint(receipt.endpoint);
  }
  return receipt.operation === 'wallet.swap_quote'
    && receipt.method === 'POST'
    && receipt.endpoint === '/wallet/swap-quote';
}

function validReceiptResponseSchema(receipt) {
  return receipt.operation === 'wallet.portfolio'
    ? receipt.responseSchema === PORTFOLIO_RESPONSE_SCHEMA
    : receipt.responseSchema === SWAP_QUOTE_RESPONSE_SCHEMA;
}

export function verifyJeffBankrReadOnlyCapability(capability) {
  const keys = [
    'actionsAllowed', 'adapterId', 'baseUrl', 'capabilitySha256',
    'credentialMode', 'executionAuthorized', 'networkAccess', 'operations',
    'provider', 'schema', 'transactionsAllowed', 'writesAllowed',
  ];
  return isJeffRecord(capability)
    && Object.keys(capability).sort().join('\0') === keys.sort().join('\0')
    && capability.schema === CAPABILITY_SCHEMA
    && capability.adapterId === ADAPTER_ID
    && capability.provider === 'bankr'
    && capability.baseUrl === BANKR_BASE_URL
    && capability.networkAccess === 'allowlisted_read'
    && capability.credentialMode === 'server_secret'
    && capability.writesAllowed === false
    && capability.transactionsAllowed === false
    && capability.actionsAllowed === 0
    && capability.executionAuthorized === false
    && Array.isArray(capability.operations)
    && capability.operations.length === OPERATIONS.length
    && capability.operations.every((operation, index) => operation === OPERATIONS[index])
    && JEFF_HASH.test(String(capability.capabilitySha256 ?? ''))
    && capability.capabilitySha256 === hashJeffBrainValue(capabilityBody(capability));
}

export function createJeffBankrReadOnlyCapability() {
  const body = {
    schema: CAPABILITY_SCHEMA,
    adapterId: ADAPTER_ID,
    provider: 'bankr',
    baseUrl: BANKR_BASE_URL,
    operations: Object.freeze([...OPERATIONS]),
    networkAccess: 'allowlisted_read',
    credentialMode: 'server_secret',
    writesAllowed: false,
    transactionsAllowed: false,
    actionsAllowed: 0,
    executionAuthorized: false,
  };
  return Object.freeze({ ...body, capabilitySha256: hashJeffBrainValue(body) });
}

export function verifyJeffBankrReadOnlyReceipt(receipt) {
  const keys = [
    'actionsExecuted', 'adapterId', 'capabilitySha256', 'endpoint',
    'executionAuthorized', 'method', 'observedAt', 'operation',
    'receiptSha256', 'requestSha256', 'responseSha256', 'schema',
    'responseSchema',
    'transactionsExecuted', 'writesExecuted',
  ];
  return isJeffRecord(receipt)
    && Object.keys(receipt).sort().join('\0') === keys.sort().join('\0')
    && receipt.schema === RECEIPT_SCHEMA
    && receipt.adapterId === ADAPTER_ID
    && OPERATIONS.includes(receipt.operation)
    && validReceiptRoute(receipt)
    && validReceiptResponseSchema(receipt)
    && Number.isFinite(Date.parse(receipt.observedAt))
    && receipt.executionAuthorized === false
    && receipt.actionsExecuted === 0
    && receipt.writesExecuted === 0
    && receipt.transactionsExecuted === 0
    && [receipt.capabilitySha256, receipt.requestSha256, receipt.responseSha256, receipt.receiptSha256]
      .every((value) => JEFF_HASH.test(String(value ?? '')))
    && receipt.receiptSha256 === hashJeffBrainValue(receiptBody(receipt));
}

function normalizePortfolioInput(input = {}) {
  if (!exactKeys(input, ['chains', 'include', 'showLowValueTokens'])) {
    throw new Error('JEFF_BANKR_PORTFOLIO_INPUT_INVALID');
  }
  const chains = input.chains ?? [];
  const include = input.include ?? [];
  const showLowValueTokens = input.showLowValueTokens ?? false;
  if (!Array.isArray(chains)
    || chains.length > PORTFOLIO_CHAINS.size
    || chains.some((chain) => !PORTFOLIO_CHAINS.has(chain))
    || new Set(chains).size !== chains.length
    || !Array.isArray(include)
    || include.length > PORTFOLIO_INCLUDES.size
    || include.some((value) => !PORTFOLIO_INCLUDES.has(value))
    || new Set(include).size !== include.length
    || typeof showLowValueTokens !== 'boolean') {
    throw new Error('JEFF_BANKR_PORTFOLIO_INPUT_INVALID');
  }
  return Object.freeze({
    chains: [...chains].sort(),
    include: [...include].sort(),
    showLowValueTokens,
  });
}

function validTokenForChain(token, chain) {
  return typeof token === 'string'
    && token.length <= 64
    && (chain === 'solana' ? SOLANA_MINT.test(token) : EVM_TOKEN.test(token));
}

function positiveDecimal(value) {
  return decimalString(value, { positive: true });
}

function normalizeSwapQuoteInput(input) {
  if (!exactKeys(input, ['amount', 'fromChain', 'fromToken', 'slippageBps', 'toChain', 'toToken'])
    || !SWAP_CHAINS.has(input.fromChain)
    || !SWAP_CHAINS.has(input.toChain)
    || !validTokenForChain(input.fromToken, input.fromChain)
    || !validTokenForChain(input.toToken, input.toChain)
    || input.fromChain === input.toChain && input.fromToken.toLowerCase() === input.toToken.toLowerCase()
    || !positiveDecimal(input.amount)
    || (input.slippageBps !== undefined
      && (!Number.isSafeInteger(input.slippageBps) || input.slippageBps < 10 || input.slippageBps > 2_000))) {
    throw new Error('JEFF_BANKR_SWAP_QUOTE_INPUT_INVALID');
  }
  return Object.freeze({
    fromChain: input.fromChain,
    fromToken: input.fromToken,
    toChain: input.toChain,
    toToken: input.toToken,
    amount: input.amount,
    ...(input.slippageBps === undefined ? {} : { slippageBps: input.slippageBps }),
  });
}

function portfolioRequest(input) {
  const query = new URLSearchParams();
  if (input.chains.length) query.set('chains', input.chains.join(','));
  if (input.include.length) query.set('include', input.include.join(','));
  if (input.showLowValueTokens) query.set('showLowValueTokens', 'true');
  const suffix = query.toString();
  return Object.freeze({
    operation: 'wallet.portfolio',
    method: 'GET',
    endpoint: `/wallet/portfolio${suffix ? `?${suffix}` : ''}`,
    body: null,
    input,
  });
}

function swapQuoteRequest(input) {
  return Object.freeze({
    operation: 'wallet.swap_quote',
    method: 'POST',
    endpoint: '/wallet/swap-quote',
    body: input,
    input,
  });
}

function createReceipt({ capability, request, response, responseSchema, observedAt }) {
  const body = {
    schema: RECEIPT_SCHEMA,
    adapterId: ADAPTER_ID,
    capabilitySha256: capability.capabilitySha256,
    operation: request.operation,
    method: request.method,
    endpoint: request.endpoint,
    requestSha256: hashJeffBrainValue({
      operation: request.operation,
      method: request.method,
      endpoint: request.endpoint,
      body: request.body,
    }),
    responseSha256: hashJeffBrainValue(response),
    responseSchema,
    observedAt: assertJeffIsoTimestamp(observedAt, 'JEFF_BANKR_CLOCK_INVALID'),
    executionAuthorized: false,
    actionsExecuted: 0,
    writesExecuted: 0,
    transactionsExecuted: 0,
  };
  const receipt = Object.freeze({ ...body, receiptSha256: hashJeffBrainValue(body) });
  if (!verifyJeffBankrReadOnlyReceipt(receipt)) throw new Error('JEFF_BANKR_RECEIPT_INVALID');
  return receipt;
}

async function parseResponse(response) {
  if (!response
    || typeof response.ok !== 'boolean'
    || !Number.isSafeInteger(response.status)
    || !response.headers
    || typeof response.headers.get !== 'function') {
    throw new Error('JEFF_BANKR_UPSTREAM_INVALID');
  }
  if (!response.ok) throw new Error(`JEFF_BANKR_UPSTREAM_${response.status}`);
  const contentType = response.headers.get('content-type');
  if (typeof contentType !== 'string' || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw new Error('JEFF_BANKR_RESPONSE_INVALID');
  }
  const text = await response.text();
  if (!text || new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
    throw new Error('JEFF_BANKR_RESPONSE_INVALID');
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('JEFF_BANKR_RESPONSE_INVALID');
  }
  if (!isJeffRecord(value)) throw new Error('JEFF_BANKR_RESPONSE_INVALID');
  return value;
}

function normalizeHttpsUrl(value) {
  if (!boundedString(value, 2_048)) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function normalizePnl(value) {
  const allowed = ['averageEntryPrice', 'realizedPnl', 'remainingAmount', 'totalPnl', 'unrealizedPnl'];
  if (!exactKeys(value, allowed)) return null;
  const normalized = {};
  for (const key of allowed) {
    if (!Object.hasOwn(value, key)) continue;
    const signed = ['realizedPnl', 'totalPnl', 'unrealizedPnl'].includes(key);
    if (!finiteFinancialNumber(value[key], { signed })) return null;
    normalized[key] = value[key];
  }
  return normalized;
}

function normalizeBaseToken(value, chain) {
  const allowed = ['address', 'decimals', 'imgUrl', 'name', 'price', 'symbol'];
  if (!exactKeys(value, allowed)
    || !hasKeys(value, allowed)
    || !boundedString(value.name, 128)
    || !validTokenForChain(value.address, chain)
    || !boundedString(value.symbol, 32)
    || !finiteFinancialNumber(value.price)
    || normalizeHttpsUrl(value.imgUrl) === null
    || !Number.isSafeInteger(value.decimals)
    || value.decimals < 0
    || value.decimals > 255) return null;
  return {
    name: value.name,
    address: chain === 'solana' ? value.address : value.address.toLowerCase(),
    symbol: value.symbol,
    price: value.price,
    imgUrl: normalizeHttpsUrl(value.imgUrl),
    decimals: value.decimals,
  };
}

function normalizeTokenBalance(value, chain, includePnl) {
  if (!exactKeys(value, ['network', 'token'])
    || !hasKeys(value, ['network', 'token'])
    || value.network !== chain
    || !isJeffRecord(value.token)) return null;
  const token = value.token;
  const allowed = ['balance', 'balanceUSD', 'bankrDeployed', 'baseToken', 'pnl', 'userAcquired', 'whitelisted'];
  if (!exactKeys(token, allowed)
    || !hasKeys(token, ['balance', 'balanceUSD', 'baseToken'])
    || !decimalString(token.balance)
    || !finiteFinancialNumber(token.balanceUSD)) return null;
  for (const key of ['bankrDeployed', 'userAcquired', 'whitelisted']) {
    if (Object.hasOwn(token, key) && typeof token[key] !== 'boolean') return null;
  }
  const baseToken = normalizeBaseToken(token.baseToken, chain);
  if (!baseToken) return null;
  if (Object.hasOwn(token, 'pnl') && !includePnl) return null;
  const pnl = Object.hasOwn(token, 'pnl') ? normalizePnl(token.pnl) : undefined;
  if (Object.hasOwn(token, 'pnl') && !pnl) return null;
  return {
    network: chain,
    token: {
      balance: token.balance,
      balanceUSD: token.balanceUSD,
      ...(Object.hasOwn(token, 'bankrDeployed') ? { bankrDeployed: token.bankrDeployed } : {}),
      ...(Object.hasOwn(token, 'whitelisted') ? { whitelisted: token.whitelisted } : {}),
      ...(Object.hasOwn(token, 'userAcquired') ? { userAcquired: token.userAcquired } : {}),
      baseToken,
      ...(pnl ? { pnl } : {}),
    },
  };
}

function normalizeChainBalance(value, chain, includePnl) {
  const fields = ['nativeBalance', 'nativeUsd', 'tokenBalances', 'total'];
  if (!exactKeys(value, fields)
    || !hasKeys(value, fields)
    || !decimalString(value.nativeBalance)
    || !decimalString(value.nativeUsd)
    || !decimalString(value.total)
    || !Array.isArray(value.tokenBalances)
    || value.tokenBalances.length > MAX_TOKEN_BALANCES) return null;
  const tokenBalances = value.tokenBalances.map((entry) => normalizeTokenBalance(entry, chain, includePnl));
  if (tokenBalances.some((entry) => entry === null)) return null;
  return {
    nativeBalance: value.nativeBalance,
    nativeUsd: value.nativeUsd,
    tokenBalances,
    total: value.total,
  };
}

function normalizeNft(value, allowedChains) {
  if (!exactKeys(value, ['chain', 'collection', 'name', 'tokenId'])
    || !hasKeys(value, ['chain', 'collection', 'name', 'tokenId'])
    || !allowedChains.has(value.chain)
    || !boundedString(value.name, 256)
    || !boundedString(value.tokenId, 256)
    || !exactKeys(value.collection, ['address', 'name'])
    || !hasKeys(value.collection, ['address', 'name'])
    || !boundedString(value.collection.name, 256)
    || !validTokenForChain(value.collection.address, value.chain)) return null;
  return {
    name: value.name,
    tokenId: value.tokenId,
    collection: {
      name: value.collection.name,
      address: value.chain === 'solana' ? value.collection.address : value.collection.address.toLowerCase(),
    },
    chain: value.chain,
  };
}

function normalizePortfolioResponse(value, input) {
  const allowed = ['balances', 'evmAddress', 'nfts', 'solAddress', 'success'];
  if (!exactKeys(value, allowed)
    || !hasKeys(value, ['balances', 'evmAddress', 'nfts', 'success'])
    || value.success !== true
    || !EVM_TOKEN.test(value.evmAddress)
    || (Object.hasOwn(value, 'solAddress') && !SOLANA_MINT.test(value.solAddress))
    || !isJeffRecord(value.balances)
    || !Array.isArray(value.nfts)
    || value.nfts.length > MAX_NFTS) {
    throw new Error('JEFF_BANKR_PORTFOLIO_RESPONSE_INVALID');
  }
  const allowedChains = new Set(input.chains.length ? input.chains : PORTFOLIO_CHAINS);
  const includePnl = input.include.includes('pnl');
  const includeNfts = input.include.includes('nfts');
  if (!includeNfts && value.nfts.length !== 0) throw new Error('JEFF_BANKR_PORTFOLIO_RESPONSE_INVALID');
  const balances = {};
  for (const [chain, balance] of Object.entries(value.balances)) {
    if (!allowedChains.has(chain)) throw new Error('JEFF_BANKR_PORTFOLIO_RESPONSE_INVALID');
    const normalized = normalizeChainBalance(balance, chain, includePnl);
    if (!normalized) throw new Error('JEFF_BANKR_PORTFOLIO_RESPONSE_INVALID');
    balances[chain] = normalized;
  }
  const nfts = value.nfts.map((nft) => normalizeNft(nft, allowedChains));
  if (nfts.some((nft) => nft === null)) throw new Error('JEFF_BANKR_PORTFOLIO_RESPONSE_INVALID');
  return deepFreeze({
    success: true,
    evmAddress: value.evmAddress.toLowerCase(),
    ...(Object.hasOwn(value, 'solAddress') ? { solAddress: value.solAddress } : {}),
    balances,
    nfts,
  });
}

function sameToken(left, right, chain) {
  return chain === 'solana' ? left === right : left.toLowerCase() === right.toLowerCase();
}

function normalizeSwapLeg(value, { chain, token, amount, sellSide }) {
  const fields = ['amount', 'chain', 'decimals', 'formattedAmount', 'symbol', 'token', 'usdValue'];
  if (!exactKeys(value, fields)
    || !hasKeys(value, fields)
    || value.chain !== chain
    || !validTokenForChain(value.token, chain)
    || !sameToken(value.token, token, chain)
    || !decimalString(value.amount, { positive: true })
    || (!sellSide && !/^\d+$/.test(value.amount))
    || !decimalString(value.formattedAmount, { positive: true })
    || (sellSide && (value.amount !== amount || value.formattedAmount !== amount))
    || !boundedString(value.symbol, 32)
    || !Number.isSafeInteger(value.decimals)
    || value.decimals < 0
    || value.decimals > 255
    || !decimalString(value.usdValue)) return null;
  return {
    chain,
    token,
    amount: value.amount,
    formattedAmount: value.formattedAmount,
    symbol: value.symbol,
    decimals: value.decimals,
    usdValue: value.usdValue,
  };
}

function validOptionalQuoteField(value, key, expectedSlippageBps) {
  if (key === 'feeWaivedForEcosystemToken') return typeof value === 'boolean';
  if (key === 'quoteId') return UUID.test(String(value ?? ''));
  if (key === 'slippageBps') return Number.isSafeInteger(value) && value === expectedSlippageBps;
  if (key === 'feeBps') return Number.isSafeInteger(value) && value >= 0 && value <= 10_000;
  if (key === 'maxPriceImpactBps') {
    return value === null || Number.isSafeInteger(value) && value >= 0 && value <= 100_000;
  }
  if (['priceImpactBps', 'swapImpactBps'].includes(key)) {
    return value === null || Number.isSafeInteger(value) && Math.abs(value) <= 100_000;
  }
  if (['buyTokenPriceUsd', 'networkCostsUsd', 'sellTokenPriceUsd'].includes(key)) {
    return value === null || finiteFinancialNumber(value);
  }
  return false;
}

function normalizeSwapQuoteResponse(value, input) {
  const required = ['from', 'minBuyAmount', 'to'];
  const optional = [
    'buyTokenPriceUsd', 'feeBps', 'feeWaivedForEcosystemToken', 'maxPriceImpactBps',
    'networkCostsUsd', 'priceImpactBps', 'quoteId', 'sellTokenPriceUsd',
    'slippageBps', 'swapImpactBps',
  ];
  if (!exactKeys(value, [...required, ...optional])
    || !hasKeys(value, required)
    || !isJeffRecord(value.from)
    || !isJeffRecord(value.to)
    || !decimalString(value.minBuyAmount, { positive: true })) {
    throw new Error('JEFF_BANKR_SWAP_QUOTE_RESPONSE_INVALID');
  }
  const from = normalizeSwapLeg(value.from, {
    chain: input.fromChain,
    token: input.fromToken,
    amount: input.amount,
    sellSide: true,
  });
  const to = normalizeSwapLeg(value.to, {
    chain: input.toChain,
    token: input.toToken,
    sellSide: false,
  });
  if (!from || !to || compareDecimals(value.minBuyAmount, to.formattedAmount) > 0) {
    throw new Error('JEFF_BANKR_SWAP_QUOTE_RESPONSE_INVALID');
  }
  const expectedSlippageBps = input.slippageBps ?? 500;
  for (const key of optional) {
    if (Object.hasOwn(value, key) && !validOptionalQuoteField(value[key], key, expectedSlippageBps)) {
      throw new Error('JEFF_BANKR_SWAP_QUOTE_RESPONSE_INVALID');
    }
  }
  return deepFreeze({
    from,
    to,
    minBuyAmount: value.minBuyAmount,
    ...Object.fromEntries(optional
      .filter((key) => Object.hasOwn(value, key))
      .map((key) => [key, value[key]])),
  });
}

function normalizeResponse(request, value) {
  if (containsExecutionMaterial(value)) throw new Error('JEFF_BANKR_EXECUTION_MATERIAL_REJECTED');
  return request.operation === 'wallet.portfolio'
    ? {
        data: normalizePortfolioResponse(value, request.input),
        responseSchema: PORTFOLIO_RESPONSE_SCHEMA,
      }
    : {
        data: normalizeSwapQuoteResponse(value, request.input),
        responseSchema: SWAP_QUOTE_RESPONSE_SCHEMA,
      };
}

export function createJeffBankrReadOnlyAdapter({
  apiKey,
  fetchImpl = globalThis.fetch,
  baseUrl = BANKR_BASE_URL,
  timeoutMs = 15_000,
  now = () => new Date().toISOString(),
} = {}) {
  if (!BANKR_KEY.test(String(apiKey ?? ''))
    || typeof fetchImpl !== 'function'
    || baseUrl !== BANKR_BASE_URL
    || !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 1
    || timeoutMs > 30_000
    || typeof now !== 'function') {
    throw new Error('JEFF_BANKR_ADAPTER_INVALID');
  }
  const capability = createJeffBankrReadOnlyCapability();

  async function request(readRequest) {
    const headers = {
      Accept: 'application/json',
      'X-API-Key': apiKey,
      ...(readRequest.body === null ? {} : { 'Content-Type': 'application/json' }),
    };
    let response;
    try {
      response = await fetchImpl(`${BANKR_BASE_URL}${readRequest.endpoint}`, {
        method: readRequest.method,
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
        ...(readRequest.body === null ? {} : { body: JSON.stringify(readRequest.body) }),
      });
    } catch {
      throw new Error('JEFF_BANKR_UPSTREAM_UNAVAILABLE');
    }
    const raw = await parseResponse(response);
    const { data, responseSchema } = normalizeResponse(readRequest, raw);
    const receipt = createReceipt({
      capability,
      request: readRequest,
      response: data,
      responseSchema,
      observedAt: now(),
    });
    return Object.freeze({
      schema: RESULT_SCHEMA,
      operation: readRequest.operation,
      data,
      receipt,
      executionAuthorized: false,
      actionsExecuted: 0,
      writesExecuted: 0,
      transactionsExecuted: 0,
    });
  }

  return Object.freeze({
    capability,
    async getPortfolio(input = {}) {
      return request(portfolioRequest(normalizePortfolioInput(input)));
    },
    async getSwapQuote(input) {
      return request(swapQuoteRequest(normalizeSwapQuoteInput(input)));
    },
  });
}

export const JEFF_BANKR_READONLY_ADAPTER = Object.freeze({
  schema: CAPABILITY_SCHEMA,
  adapterId: ADAPTER_ID,
  baseUrl: BANKR_BASE_URL,
  operations: Object.freeze([...OPERATIONS]),
  executionAuthorized: false,
  actionsAllowed: 0,
  writesAllowed: false,
  transactionsAllowed: false,
});
