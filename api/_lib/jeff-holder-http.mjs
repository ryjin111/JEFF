import { hashJeffBrainValue, isJeffRecord } from './jeff-brain-common.mjs';

const RESPONSE_SCHEMA = 'jeff-holder-http-response-v1';
const ERROR_SCHEMA = 'jeff-holder-http-error-v1';
const COOKIE_NAME = '__Host-jeff_holder';
const SESSION_ID = /^[a-f0-9]{64}$/;
const DEFAULT_MAX_BODY_BYTES = 16 * 1024;

function setHeader(response, name, value) {
  if (typeof response.setHeader === 'function') response.setHeader(name, value);
}

function sendJson(response, statusCode, body) {
  response.statusCode = statusCode;
  setHeader(response, 'cache-control', 'no-store');
  setHeader(response, 'content-type', 'application/json; charset=utf-8');
  setHeader(response, 'content-security-policy', "default-src 'none'; frame-ancestors 'none'");
  setHeader(response, 'referrer-policy', 'no-referrer');
  setHeader(response, 'x-content-type-options', 'nosniff');
  setHeader(response, 'x-frame-options', 'DENY');
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
  const lower = name.toLowerCase();
  const value = request?.headers?.[lower]
    ?? request?.headers?.[name]
    ?? (typeof request?.get === 'function' ? request.get(name) : undefined);
  return Array.isArray(value) ? value[0] : value;
}

function normalizeOrigin(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2_048) {
    throw new Error('JEFF_HOLDER_HTTP_CONFIG_INVALID');
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('JEFF_HOLDER_HTTP_CONFIG_INVALID');
  }
  const localDevelopment = parsed.hostname === 'localhost'
    || parsed.hostname === '127.0.0.1'
    || parsed.hostname === '[::1]';
  if ((parsed.protocol !== 'https:' && !(localDevelopment && parsed.protocol === 'http:'))
    || parsed.username
    || parsed.password
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash
    || parsed.origin === 'null') {
    throw new Error('JEFF_HOLDER_HTTP_CONFIG_INVALID');
  }
  return parsed.origin;
}

function normalizeHolderUri(value, origin) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2_048) {
    throw new Error('JEFF_HOLDER_HTTP_CONFIG_INVALID');
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('JEFF_HOLDER_HTTP_CONFIG_INVALID');
  }
  if (parsed.origin !== origin || parsed.username || parsed.password || parsed.hash) {
    throw new Error('JEFF_HOLDER_HTTP_CONFIG_INVALID');
  }
  return parsed.href;
}

function parseJsonBytes(bytes, maximum) {
  if (bytes.length === 0 || bytes.length > maximum) throw new Error('JEFF_HOLDER_HTTP_BODY_INVALID');
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    if (!isJeffRecord(value)) throw new Error();
    return value;
  } catch {
    throw new Error('JEFF_HOLDER_HTTP_BODY_INVALID');
  }
}

async function readJsonBody(request, maximum) {
  if (request.body !== undefined) {
    if (Buffer.isBuffer(request.body)) return parseJsonBytes(request.body, maximum);
    if (typeof request.body === 'string') return parseJsonBytes(Buffer.from(request.body, 'utf8'), maximum);
    if (!isJeffRecord(request.body)) throw new Error('JEFF_HOLDER_HTTP_BODY_INVALID');
    let encoded;
    try {
      encoded = Buffer.from(JSON.stringify(request.body), 'utf8');
    } catch {
      throw new Error('JEFF_HOLDER_HTTP_BODY_INVALID');
    }
    if (encoded.length > maximum) throw new Error('JEFF_HOLDER_HTTP_BODY_INVALID');
    return request.body;
  }
  if (!request || typeof request[Symbol.asyncIterator] !== 'function') {
    throw new Error('JEFF_HOLDER_HTTP_BODY_INVALID');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maximum) throw new Error('JEFF_HOLDER_HTTP_BODY_INVALID');
    chunks.push(bytes);
  }
  return parseJsonBytes(Buffer.concat(chunks), maximum);
}

function hasExactKeys(value, keys) {
  return isJeffRecord(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function validActionEnvelope(value) {
  if (!isJeffRecord(value) || typeof value.action !== 'string') return false;
  if (value.action === 'challenge') return hasExactKeys(value, ['action', 'wallet', 'agentNft']);
  if (value.action === 'boot') return hasExactKeys(value, ['action', 'challengeSha256', 'signature']);
  if (value.action === 'run') return hasExactKeys(value, ['action', 'objective']);
  if (value.action === 'remember') {
    return hasExactKeys(value, ['action', 'id', 'content', 'source', 'verified', 'expiresAt']);
  }
  if (value.action === 'logout') return hasExactKeys(value, ['action']);
  return false;
}

function sessionFromRequest(request) {
  const header = String(requestHeader(request, 'cookie') ?? '');
  const matches = header.split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${COOKIE_NAME}=`));
  if (matches.length !== 1) throw new Error('JEFF_HOLDER_SESSION_INVALID');
  const value = matches[0].slice(COOKIE_NAME.length + 1);
  if (!SESSION_ID.test(value)) throw new Error('JEFF_HOLDER_SESSION_INVALID');
  return value;
}

function setSessionCookie(response, sessionId, maxAgeSeconds) {
  if (!SESSION_ID.test(String(sessionId ?? ''))) throw new Error('JEFF_HOLDER_HTTP_BOUNDARY_FAILED');
  setHeader(
    response,
    'set-cookie',
    `${COOKIE_NAME}=${sessionId}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Strict`,
  );
}

function clearSessionCookie(response) {
  setHeader(
    response,
    'set-cookie',
    `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`,
  );
}

function assertSameOrigin(request, origin) {
  const supplied = requestHeader(request, 'origin');
  const fetchSite = requestHeader(request, 'sec-fetch-site');
  if (typeof supplied !== 'string' || supplied !== origin) {
    throw new Error('JEFF_HOLDER_HTTP_ORIGIN_DENIED');
  }
  if (fetchSite !== undefined && String(fetchSite).toLowerCase() !== 'same-origin') {
    throw new Error('JEFF_HOLDER_HTTP_ORIGIN_DENIED');
  }
}

async function enforceRateLimit(rateLimiter, bucket, subject, response) {
  const result = await rateLimiter.consume({ bucket, subject });
  if (!isJeffRecord(result) || typeof result.allowed !== 'boolean') {
    throw new Error('JEFF_HOLDER_HTTP_CONFIG_INVALID');
  }
  if (result.allowed) return;
  const retryAfter = Number.isSafeInteger(result.retryAfterSeconds) && result.retryAfterSeconds > 0
    ? result.retryAfterSeconds
    : 60;
  setHeader(response, 'retry-after', String(retryAfter));
  throw new Error('JEFF_HOLDER_HTTP_RATE_LIMITED');
}

function classifyFailure(error) {
  const code = typeof error?.message === 'string' ? error.message : '';
  if (code === 'JEFF_HOLDER_HTTP_ORIGIN_DENIED') return [403, 'ORIGIN_DENIED'];
  if (code === 'JEFF_HOLDER_HTTP_RATE_LIMITED') return [429, 'RATE_LIMITED'];
  if (code === 'JEFF_HOLDER_HTTP_BODY_INVALID') return [400, 'INVALID_JSON_BODY'];
  if (code === 'JEFF_HOLDER_HTTP_ENVELOPE_INVALID') return [400, 'INVALID_REQUEST_ENVELOPE'];
  if (code === 'JEFF_HOLDER_HTTP_BOUNDARY_FAILED') return [500, 'SAFETY_BOUNDARY_FAILED'];
  if (code === 'JEFF_HOLDER_HTTP_CONFIG_INVALID') return [503, 'SERVICE_NOT_CONFIGURED'];
  if (code === 'JEFF_HOLDER_SESSION_INVALID'
    || code === 'JEFF_HOLDER_SESSION_EXPIRED'
    || code === 'JEFF_HOLDER_CHALLENGE_CONSUMED_OR_UNKNOWN'
    || code === 'JEFF_HOLDER_SIGNATURE_INVALID') return [401, 'AUTHENTICATION_FAILED'];
  if (code === 'JEFF_HOLDER_NOT_CURRENT_OWNER'
    || code === 'JEFF_HOLDER_AGENT_NFT_DENIED'
    || code === 'JEFF_HOLDER_OWNERSHIP_CHANGED'
    || code === 'JEFF_HOLDER_AUTHORIZATION_DENIED'
    || code === 'JEFF_MEMORY_AUTHORIZATION_DENIED') return [403, 'HOLDER_ACCESS_DENIED'];
  if (code.startsWith('JEFF_OPEN_WEIGHTS_')) return [502, 'PLANNER_UNAVAILABLE'];
  if (code.startsWith('JEFF_HOLDER_') || code.startsWith('JEFF_MEMORY_')) {
    return [400, 'INVALID_HOLDER_REQUEST'];
  }
  return [500, 'INTERNAL_FAILURE'];
}

function publicSession(session) {
  const {
    sessionId: _sessionId,
    bootReceiptSha256,
    ...safe
  } = session;
  return Object.freeze({ ...safe, bootReceiptSha256 });
}

function publicMemory(record) {
  return Object.freeze({
    schema: record.schema,
    id: record.id,
    ownerEpoch: record.ownerEpoch,
    scopeSha256: record.scopeSha256,
    sourceSha256: record.sourceSha256,
    contentSha256: record.contentSha256,
    verified: record.verified,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    recordSha256: record.recordSha256,
  });
}

export function createJeffHolderFixedWindowRateLimiter({
  limit = 30,
  windowMs = 60_000,
  now = () => Date.now(),
} = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000
    || !Number.isSafeInteger(windowMs) || windowMs < 1_000 || windowMs > 86_400_000
    || typeof now !== 'function') throw new Error('JEFF_HOLDER_HTTP_CONFIG_INVALID');
  const entries = new Map();
  return Object.freeze({
    async consume({ bucket, subject }) {
      if (typeof bucket !== 'string' || !bucket || typeof subject !== 'string' || !subject) {
        throw new Error('JEFF_HOLDER_HTTP_CONFIG_INVALID');
      }
      const current = Number(now());
      if (!Number.isFinite(current)) throw new Error('JEFF_HOLDER_HTTP_CONFIG_INVALID');
      const key = `${bucket}:${hashJeffBrainValue(subject)}`;
      let entry = entries.get(key);
      if (!entry || current >= entry.resetAt) entry = { count: 0, resetAt: current + windowMs };
      entry.count += 1;
      entries.set(key, entry);
      return Object.freeze({
        allowed: entry.count <= limit,
        retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - current) / 1_000)),
      });
    },
  });
}

export function createJeffHolderHttpHandler({
  runtime,
  relyingPartyOrigin,
  holderUri,
  rateLimiter,
  clientIdentity,
  maximumBodyBytes = DEFAULT_MAX_BODY_BYTES,
  readiness = () => true,
} = {}) {
  if (!runtime
    || typeof runtime.issueChallenge !== 'function'
    || typeof runtime.boot !== 'function'
    || typeof runtime.run !== 'function'
    || typeof runtime.remember !== 'function'
    || typeof runtime.logout !== 'function'
    || !rateLimiter
    || typeof rateLimiter.consume !== 'function'
    || typeof clientIdentity !== 'function'
    || !Number.isSafeInteger(maximumBodyBytes)
    || maximumBodyBytes < 1_024
    || maximumBodyBytes > 65_536
    || typeof readiness !== 'function') {
    throw new Error('JEFF_HOLDER_HTTP_CONFIG_INVALID');
  }
  const origin = normalizeOrigin(relyingPartyOrigin);
  const pageUri = normalizeHolderUri(holderUri, origin);
  const domain = new URL(origin).host.toLowerCase();

  return async function jeffHolderHttpHandler(request, response) {
    const method = String(request?.method ?? '').toUpperCase();
    if (method === 'GET') {
      let ready = false;
      try { ready = readiness() === true; } catch { ready = false; }
      return sendJson(response, 200, {
        schema: 'jeff-holder-http-status-v1',
        ready,
        runtimeVersion: 'jeff-holder-alpha-v1',
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
      assertSameOrigin(request, origin);
      const contentType = String(requestHeader(request, 'content-type') ?? '').toLowerCase();
      if (!contentType.startsWith('application/json')) {
        return sendJson(response, 415, errorBody('JSON_REQUIRED'));
      }
      const body = await readJsonBody(request, maximumBodyBytes);
      if (!validActionEnvelope(body)) throw new Error('JEFF_HOLDER_HTTP_ENVELOPE_INVALID');
      const client = await clientIdentity(request);
      if (typeof client !== 'string' || !client || client.length > 512) {
        throw new Error('JEFF_HOLDER_HTTP_CONFIG_INVALID');
      }

      if (body.action === 'challenge') {
        await enforceRateLimit(rateLimiter, 'challenge', client, response);
        const challenge = await runtime.issueChallenge({
          domain,
          uri: pageUri,
          wallet: body.wallet,
          agentNft: body.agentNft,
        });
        return sendJson(response, 200, { schema: RESPONSE_SCHEMA, action: body.action, challenge });
      }

      if (body.action === 'boot') {
        await enforceRateLimit(rateLimiter, 'boot', client, response);
        const session = await runtime.boot({
          challengeSha256: body.challengeSha256,
          signature: body.signature,
        });
        const maxAge = Math.max(1, Math.floor((Date.parse(session.expiresAt) - Date.now()) / 1_000));
        setSessionCookie(response, session.sessionId, maxAge);
        return sendJson(response, 200, {
          schema: RESPONSE_SCHEMA,
          action: body.action,
          session: publicSession(session),
        });
      }

      const sessionId = sessionFromRequest(request);
      await enforceRateLimit(rateLimiter, body.action, hashJeffBrainValue(sessionId), response);
      if (body.action === 'run') {
        const output = await runtime.run({ sessionId, objective: body.objective });
        if (output.result?.executionAuthorized !== false
          || output.result?.actionsExecuted !== 0
          || output.receipt?.executionAuthorized !== false
          || output.receipt?.actionsExecuted !== 0) {
          throw new Error('JEFF_HOLDER_HTTP_BOUNDARY_FAILED');
        }
        return sendJson(response, 200, { schema: RESPONSE_SCHEMA, action: body.action, output });
      }
      if (body.action === 'remember') {
        const record = await runtime.remember({
          sessionId,
          id: body.id,
          content: body.content,
          source: body.source,
          verified: body.verified,
          expiresAt: body.expiresAt,
        });
        return sendJson(response, 200, {
          schema: RESPONSE_SCHEMA,
          action: body.action,
          memory: publicMemory(record),
        });
      }
      if (body.action === 'logout') {
        await runtime.logout({ sessionId });
        clearSessionCookie(response);
        return sendJson(response, 200, {
          schema: RESPONSE_SCHEMA,
          action: body.action,
          loggedOut: true,
        });
      }
      throw new Error('JEFF_HOLDER_HTTP_ENVELOPE_INVALID');
    } catch (error) {
      const [status, code] = classifyFailure(error);
      if (status === 401) clearSessionCookie(response);
      return sendJson(response, status, errorBody(code));
    }
  };
}

export const JEFF_HOLDER_HTTP = Object.freeze({
  responseSchema: RESPONSE_SCHEMA,
  errorSchema: ERROR_SCHEMA,
  cookieName: COOKIE_NAME,
  maximumBodyBytes: DEFAULT_MAX_BODY_BYTES,
  mode: 'shadow',
  executionAuthorized: false,
  actionsExecuted: 0,
});
