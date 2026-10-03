import { timingSafeEqual } from 'node:crypto';

import {
  deliberateJeffBrain,
  JEFF_BRAIN_V1,
  verifyJeffBrainReceipt,
} from './jeff-brain-v1.mjs';
import { hashJeffBrainValue, isJeffRecord } from './jeff-brain-common.mjs';
import { createJeffOpenWeightsProvider } from './jeff-open-weights-provider.mjs';

const RESPONSE_SCHEMA = 'jeff-brain-http-response-v1';
const ERROR_SCHEMA = 'jeff-brain-http-error-v1';
const DEFAULT_MAX_BODY_BYTES = 128 * 1024;

function setHeader(response, name, value) {
  if (typeof response.setHeader === 'function') response.setHeader(name, value);
}

function sendJson(response, statusCode, body) {
  response.statusCode = statusCode;
  setHeader(response, 'cache-control', 'no-store');
  setHeader(response, 'content-type', 'application/json; charset=utf-8');
  setHeader(response, 'x-content-type-options', 'nosniff');
  response.end(JSON.stringify(body));
}

function errorBody(code) {
  return {
    schema: ERROR_SCHEMA,
    error: code,
    mode: 'shadow',
    executionAuthorized: false,
    actionsExecuted: 0,
  };
}

function requestHeader(request, name) {
  const value = request?.headers?.[name]
    ?? request?.headers?.[name.toLowerCase()]
    ?? (typeof request?.get === 'function' ? request.get(name) : undefined);
  return Array.isArray(value) ? value[0] : value;
}

function parseJsonBytes(bytes, maximum) {
  if (bytes.length === 0 || bytes.length > maximum) throw new Error('JEFF_BRAIN_HTTP_BODY_INVALID');
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    if (!isJeffRecord(value)) throw new Error();
    return value;
  } catch {
    throw new Error('JEFF_BRAIN_HTTP_BODY_INVALID');
  }
}

async function readJsonBody(request, maximum) {
  if (request.body !== undefined) {
    if (Buffer.isBuffer(request.body)) return parseJsonBytes(request.body, maximum);
    if (typeof request.body === 'string') return parseJsonBytes(Buffer.from(request.body, 'utf8'), maximum);
    if (!isJeffRecord(request.body)) throw new Error('JEFF_BRAIN_HTTP_BODY_INVALID');
    let encoded;
    try {
      encoded = Buffer.from(JSON.stringify(request.body), 'utf8');
    } catch {
      throw new Error('JEFF_BRAIN_HTTP_BODY_INVALID');
    }
    if (encoded.length > maximum) throw new Error('JEFF_BRAIN_HTTP_BODY_INVALID');
    return request.body;
  }
  if (!request || typeof request[Symbol.asyncIterator] !== 'function') {
    throw new Error('JEFF_BRAIN_HTTP_BODY_INVALID');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maximum) throw new Error('JEFF_BRAIN_HTTP_BODY_INVALID');
    chunks.push(bytes);
  }
  return parseJsonBytes(Buffer.concat(chunks), maximum);
}

function validEnvelope(value) {
  return isJeffRecord(value)
    && Object.keys(value).length === 1
    && isJeffRecord(value.request);
}

function classifyFailure(error) {
  const code = typeof error?.message === 'string' ? error.message : '';
  if (code === 'JEFF_BRAIN_HTTP_BODY_INVALID') return [400, 'INVALID_JSON_BODY'];
  if (code === 'JEFF_BRAIN_HTTP_BOUNDARY_FAILED') return [500, 'SAFETY_BOUNDARY_FAILED'];
  if (code === 'JEFF_BRAIN_HTTP_CONFIG_INVALID'
    || code === 'JEFF_BRAIN_MEMORY_SERVICE_REQUIRED'
    || code === 'JEFF_AUTH_VERIFIER_REQUIRED') return [503, 'SERVICE_NOT_CONFIGURED'];
  if (code === 'JEFF_MCP_AUTHORIZATION_DENIED'
    || code === 'JEFF_MEMORY_AUTHORIZATION_DENIED') return [403, 'CONTEXT_AUTHORIZATION_DENIED'];
  if (code.startsWith('JEFF_OPEN_WEIGHTS_')) return [502, 'PLANNER_UNAVAILABLE'];
  if (code.startsWith('JEFF_BRAIN_')
    || code.startsWith('JEFF_MCP_')
    || code.startsWith('JEFF_MEMORY_')) return [400, 'INVALID_BRAIN_REQUEST'];
  return [500, 'INTERNAL_FAILURE'];
}

export function createJeffBrainBearerAuthenticator({ token } = {}) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 4_096) {
    throw new Error('JEFF_BRAIN_HTTP_CONFIG_INVALID');
  }
  const expected = Buffer.from(`Bearer ${token}`, 'utf8');
  return function authenticate(request) {
    const supplied = Buffer.from(String(requestHeader(request, 'authorization') ?? ''), 'utf8');
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  };
}

export function createJeffBrainProviderFromEnv(env = process.env, fetcher = fetch) {
  if (typeof env.JEFF_BRAIN_MODEL !== 'string' || !env.JEFF_BRAIN_MODEL.trim()) {
    throw new Error('JEFF_BRAIN_HTTP_CONFIG_INVALID');
  }
  try {
    return createJeffOpenWeightsProvider({
      model: env.JEFF_BRAIN_MODEL,
      baseUrl: env.JEFF_BRAIN_BASE_URL ?? 'http://127.0.0.1:11434',
      apiKey: env.JEFF_BRAIN_API_KEY,
      allowRemote: env.JEFF_BRAIN_ALLOW_REMOTE === 'true',
      fetcher,
    });
  } catch {
    throw new Error('JEFF_BRAIN_HTTP_CONFIG_INVALID');
  }
}

export function createJeffBrainHttpHandler({
  authorize,
  provider,
  providerFactory,
  memoryService,
  mcpAuthorizationVerifier,
  maximumBodyBytes = DEFAULT_MAX_BODY_BYTES,
  readiness = () => true,
} = {}) {
  if (typeof authorize !== 'function'
    || (!provider && typeof providerFactory !== 'function')
    || !Number.isSafeInteger(maximumBodyBytes)
    || maximumBodyBytes < 1_024
    || maximumBodyBytes > 1_048_576
    || typeof readiness !== 'function') {
    throw new Error('JEFF_BRAIN_HTTP_CONFIG_INVALID');
  }
  let selectedProvider = provider;

  return async function jeffBrainHttpHandler(request, response) {
    const method = String(request?.method ?? '').toUpperCase();
    if (method === 'GET') {
      let ready = false;
      try { ready = readiness() === true; } catch { ready = false; }
      return sendJson(response, 200, {
        schema: 'jeff-brain-http-status-v1',
        ready,
        runtimeVersion: JEFF_BRAIN_V1.version,
        mode: 'shadow',
        executionAuthorized: false,
        actionsExecuted: 0,
      });
    }
    if (method !== 'POST') {
      setHeader(response, 'allow', 'GET, POST');
      return sendJson(response, 405, errorBody('METHOD_NOT_ALLOWED'));
    }

    try {
      if (await authorize(request) !== true) return sendJson(response, 401, errorBody('UNAUTHORIZED'));
    } catch {
      return sendJson(response, 503, errorBody('SERVICE_NOT_CONFIGURED'));
    }

    const contentType = String(requestHeader(request, 'content-type') ?? 'application/json').toLowerCase();
    if (!contentType.includes('application/json')) {
      return sendJson(response, 415, errorBody('JSON_REQUIRED'));
    }

    try {
      const envelope = await readJsonBody(request, maximumBodyBytes);
      if (!validEnvelope(envelope)) return sendJson(response, 400, errorBody('INVALID_REQUEST_ENVELOPE'));
      if (!selectedProvider) selectedProvider = await providerFactory();
      const result = await deliberateJeffBrain({
        request: envelope.request,
        provider: selectedProvider,
        memoryService,
        mcpAuthorizationVerifier,
      });
      if (result.mode !== 'shadow'
        || result.executionAuthorized !== false
        || result.actionsExecuted !== 0
        || !isJeffRecord(result.llmUtility)
        || result.llmUtility.executionAuthorized !== false
        || ![0, 2].includes(result.llmUtility.providerCallsAllowed)
        || result.audit.llmUtilitySha256 !== hashJeffBrainValue(result.llmUtility)
        || !verifyJeffBrainReceipt(result.audit)) {
        throw new Error('JEFF_BRAIN_HTTP_BOUNDARY_FAILED');
      }
      return sendJson(response, 200, {
        schema: RESPONSE_SCHEMA,
        result,
      });
    } catch (error) {
      const [status, code] = classifyFailure(error);
      return sendJson(response, status, errorBody(code));
    }
  };
}

export function createJeffBrainEnvHttpHandler({ env = process.env, fetcher = fetch } = {}) {
  let authenticate;
  let provider;
  return createJeffBrainHttpHandler({
    authorize(request) {
      authenticate ??= createJeffBrainBearerAuthenticator({ token: env.JEFF_BRAIN_ACCESS_TOKEN });
      return authenticate(request);
    },
    providerFactory() {
      provider ??= createJeffBrainProviderFromEnv(env, fetcher);
      return provider;
    },
    readiness() {
      try {
        authenticate ??= createJeffBrainBearerAuthenticator({ token: env.JEFF_BRAIN_ACCESS_TOKEN });
        provider ??= createJeffBrainProviderFromEnv(env, fetcher);
        return true;
      } catch {
        return false;
      }
    },
  });
}

export const JEFF_BRAIN_HTTP = Object.freeze({
  responseSchema: RESPONSE_SCHEMA,
  errorSchema: ERROR_SCHEMA,
  maximumBodyBytes: DEFAULT_MAX_BODY_BYTES,
  mode: 'shadow',
  executionAuthorized: false,
  actionsExecuted: 0,
});
