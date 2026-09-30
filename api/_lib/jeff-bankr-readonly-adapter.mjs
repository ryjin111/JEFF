import {
  assertJeffIsoTimestamp,
  hashJeffBrainValue,
  isJeffRecord,
  JEFF_HASH,
} from './jeff-brain-common.mjs';

const CAPABILITY_SCHEMA = 'jeff-bankr-readonly-capability-v1';
const RECEIPT_SCHEMA = 'jeff-bankr-readonly-receipt-v1';
const RESULT_SCHEMA = 'jeff-bankr-readonly-result-v1';
const ADAPTER_ID = 'jeff.bankr.wallet.readonly.v1';
const BANKR_BASE_URL = 'https://api.bankr.bot';
const MAX_RESPONSE_BYTES = 512 * 1_024;
const BANKR_KEY = /^bk_[A-Za-z0-9_-]{8,255}$/;
const EVM_TOKEN = /^0x[a-fA-F0-9]{40}$/;
const SOLANA_MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const DECIMAL_AMOUNT = /^(?:\d+(?:\.\d*)?|\.\d+)$/;
const PORTFOLIO_CHAINS = new Set([
  'base', 'polygon', 'mainnet', 'unichain', 'worldchain',
  'arbitrum', 'bnb', 'robinhood', 'arc', 'solana',
]);
const SWAP_CHAINS = new Set(PORTFOLIO_CHAINS);
const PORTFOLIO_INCLUDES = new Set(['pnl', 'nfts']);
const OPERATIONS = Object.freeze(['wallet.portfolio', 'wallet.swap_quote']);

function exactKeys(value, allowed) {
  return isJeffRecord(value)
    && Object.keys(value).every((key) => allowed.includes(key));
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
    'transactionsExecuted', 'writesExecuted',
  ];
  return isJeffRecord(receipt)
    && Object.keys(receipt).sort().join('\0') === keys.sort().join('\0')
    && receipt.schema === RECEIPT_SCHEMA
    && receipt.adapterId === ADAPTER_ID
    && OPERATIONS.includes(receipt.operation)
    && validReceiptRoute(receipt)
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
  return typeof value === 'string'
    && value.length <= 80
    && DECIMAL_AMOUNT.test(value)
    && /[1-9]/.test(value);
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
  });
}

function swapQuoteRequest(input) {
  return Object.freeze({
    operation: 'wallet.swap_quote',
    method: 'POST',
    endpoint: '/wallet/swap-quote',
    body: input,
  });
}

function createReceipt({ capability, request, response, observedAt }) {
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
  if (!response || typeof response.ok !== 'boolean' || !Number.isSafeInteger(response.status)) {
    throw new Error('JEFF_BANKR_UPSTREAM_INVALID');
  }
  if (!response.ok) throw new Error(`JEFF_BANKR_UPSTREAM_${response.status}`);
  const text = await response.text();
  if (!text || text.length > MAX_RESPONSE_BYTES) throw new Error('JEFF_BANKR_RESPONSE_INVALID');
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('JEFF_BANKR_RESPONSE_INVALID');
  }
  if (!isJeffRecord(value)) throw new Error('JEFF_BANKR_RESPONSE_INVALID');
  return structuredClone(value);
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
    const data = await parseResponse(response);
    const receipt = createReceipt({ capability, request: readRequest, response: data, observedAt: now() });
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
