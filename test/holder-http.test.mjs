import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createJeffHolderFixedWindowRateLimiter,
  createJeffHolderHttpHandler,
} from '../api/_lib/jeff-holder-http.mjs';

const sessionId = 'a'.repeat(64);

function responseRecorder() {
  return {
    headers: {},
    statusCode: null,
    body: null,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(value) { this.body = JSON.parse(value); },
  };
}

function runtimeStub(overrides = {}) {
  const calls = [];
  return {
    calls,
    async issueChallenge(input) {
      calls.push(['challenge', input]);
      return { schema: 'jeff-holder-challenge-v1', challengeSha256: 'b'.repeat(64), message: 'Sign me' };
    },
    async boot(input) {
      calls.push(['boot', input]);
      return {
        sessionId,
        instanceId: 'c'.repeat(64),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        mode: 'shadow',
        executionAuthorized: false,
        bootReceiptSha256: 'd'.repeat(64),
      };
    },
    async run(input) {
      calls.push(['run', input]);
      return {
        result: { mode: 'shadow', executionAuthorized: false, actionsExecuted: 0 },
        receipt: { executionAuthorized: false, actionsExecuted: 0 },
      };
    },
    async remember(input) {
      calls.push(['remember', input]);
      return {
        schema: 'jeff-authorized-memory-record-v1',
        id: input.id,
        ownerEpoch: 1,
        scopeSha256: '1'.repeat(64),
        sourceSha256: '2'.repeat(64),
        contentSha256: '3'.repeat(64),
        ciphertext: 'must-not-leak',
        verified: input.verified,
        createdAt: '2026-10-04T08:00:00.000Z',
        expiresAt: input.expiresAt,
        recordSha256: '4'.repeat(64),
      };
    },
    async logout(input) {
      calls.push(['logout', input]);
      return true;
    },
    ...overrides,
  };
}

function createFixture({ runtime = runtimeStub(), rateLimiter, maximumBodyBytes } = {}) {
  return {
    runtime,
    handler: createJeffHolderHttpHandler({
      runtime,
      relyingPartyOrigin: 'https://jeff.example',
      holderUri: 'https://jeff.example/holder',
      rateLimiter: rateLimiter ?? createJeffHolderFixedWindowRateLimiter({ limit: 20 }),
      clientIdentity: () => 'test-client',
      maximumBodyBytes,
    }),
  };
}

async function invoke(handler, { method = 'POST', headers = {}, body } = {}) {
  const response = responseRecorder();
  await handler({
    method,
    headers: {
      origin: 'https://jeff.example',
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
      ...headers,
    },
    body,
  }, response);
  return response;
}

test('holder HTTP status is minimal and exposes no authority', async () => {
  const { handler } = createFixture();
  const response = await invoke(handler, { method: 'GET' });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ready, true);
  assert.equal(response.body.mode, 'shadow');
  assert.equal(response.body.executionAuthorized, false);
  assert.equal(response.body.actionsExecuted, 0);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['x-frame-options'], 'DENY');
});

test('challenge location is server-controlled and caller fields are strict', async () => {
  const { handler, runtime } = createFixture();
  let response = await invoke(handler, {
    body: { action: 'challenge', wallet: '0xwallet', agentNft: { tokenId: '7' } },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(runtime.calls[0][1].domain, 'jeff.example');
  assert.equal(runtime.calls[0][1].uri, 'https://jeff.example/holder');

  response = await invoke(handler, {
    body: {
      action: 'challenge', wallet: '0xwallet', agentNft: { tokenId: '7' },
      uri: 'https://attacker.example',
    },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.error, 'INVALID_REQUEST_ENVELOPE');
  assert.equal(runtime.calls.length, 1);
});

test('boot stores the session only in a secure HttpOnly cookie', async () => {
  const { handler } = createFixture();
  const response = await invoke(handler, {
    body: { action: 'boot', challengeSha256: 'b'.repeat(64), signature: 'signature' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.stringify(response.body).includes(sessionId), false);
  assert.match(response.headers['set-cookie'], /^__Host-jeff_holder=[a-f0-9]{64};/);
  assert.match(response.headers['set-cookie'], /HttpOnly; Secure; SameSite=Strict/);
});

test('authenticated actions require one canonical holder cookie', async () => {
  const { handler, runtime } = createFixture();
  let response = await invoke(handler, { body: { action: 'run', objective: 'Read status.' } });
  assert.equal(response.statusCode, 401);
  assert.equal(response.body.error, 'AUTHENTICATION_FAILED');
  assert.equal(runtime.calls.length, 0);

  response = await invoke(handler, {
    headers: { cookie: `__Host-jeff_holder=${sessionId}; __Host-jeff_holder=${'b'.repeat(64)}` },
    body: { action: 'run', objective: 'Read status.' },
  });
  assert.equal(response.statusCode, 401);
  assert.equal(runtime.calls.length, 0);

  response = await invoke(handler, {
    headers: { cookie: `__Host-jeff_holder=${sessionId}` },
    body: { action: 'run', objective: 'Read status.' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(runtime.calls[0][1].sessionId, sessionId);
});

test('cross-origin, non-JSON, and oversized requests fail before runtime access', async () => {
  const { handler, runtime } = createFixture({ maximumBodyBytes: 1_024 });
  let response = await invoke(handler, {
    headers: { origin: 'https://attacker.example' },
    body: { action: 'challenge', wallet: '0xwallet', agentNft: {} },
  });
  assert.equal(response.statusCode, 403);
  assert.equal(response.headers['set-cookie'], undefined);

  response = await invoke(handler, {
    headers: { 'content-type': 'text/plain' },
    body: '{}',
  });
  assert.equal(response.statusCode, 415);

  response = await invoke(handler, {
    body: JSON.stringify({ action: 'challenge', wallet: 'x'.repeat(2_000), agentNft: {} }),
  });
  assert.equal(response.statusCode, 400);
  assert.equal(runtime.calls.length, 0);
});

test('mandatory rate limiting returns 429 without runtime access', async () => {
  const rateLimiter = createJeffHolderFixedWindowRateLimiter({ limit: 1, windowMs: 60_000 });
  const { handler, runtime } = createFixture({ rateLimiter });
  const body = { action: 'challenge', wallet: '0xwallet', agentNft: {} };
  let response = await invoke(handler, { body });
  assert.equal(response.statusCode, 200);
  response = await invoke(handler, { body });
  assert.equal(response.statusCode, 429);
  assert.equal(response.body.error, 'RATE_LIMITED');
  assert.equal(response.headers['retry-after'], '60');
  assert.equal(runtime.calls.length, 1);
});

test('memory responses exclude ciphertext and holder failures are sanitized', async () => {
  const runtime = runtimeStub();
  const { handler } = createFixture({ runtime });
  let response = await invoke(handler, {
    headers: { cookie: `__Host-jeff_holder=${sessionId}` },
    body: {
      action: 'remember',
      id: 'preference',
      content: 'Keep reports concise.',
      source: 'holder-approved',
      verified: true,
      expiresAt: '2026-11-04T08:00:00.000Z',
    },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.stringify(response.body).includes('must-not-leak'), false);

  runtime.run = async () => { throw new Error('private upstream detail'); };
  response = await invoke(handler, {
    headers: { cookie: `__Host-jeff_holder=${sessionId}` },
    body: { action: 'run', objective: 'Read status.' },
  });
  assert.equal(response.statusCode, 500);
  assert.equal(response.body.error, 'INTERNAL_FAILURE');
  assert.equal(JSON.stringify(response.body).includes('private upstream detail'), false);
});

test('logout revokes the server session and clears the browser cookie', async () => {
  const { handler, runtime } = createFixture();
  const response = await invoke(handler, {
    headers: { cookie: `__Host-jeff_holder=${sessionId}` },
    body: { action: 'logout' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.loggedOut, true);
  assert.equal(runtime.calls[0][0], 'logout');
  assert.match(response.headers['set-cookie'], /Max-Age=0/);
});
