import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createJeffBrainBearerAuthenticator,
  createJeffBrainEnvHttpHandler,
  createJeffBrainHttpHandler,
} from '../api/_lib/jeff-brain-http.mjs';

function responseRecorder() {
  return {
    headers: {},
    statusCode: null,
    body: null,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(value) { this.body = JSON.parse(value); },
  };
}

function safeRequest(overrides = {}) {
  return {
    objective: 'Inspect verified policy and prepare a read-only report.',
    state: {
      proposal: 'Inspect verified policy and prepare a read-only report.',
      safetyFacts: {
        authorized: true,
        funded: true,
        validTransition: true,
        evidenceSufficient: true,
        privacySafe: true,
        validationSafe: true,
        identityIntegrity: 'trusted',
      },
      requiredSafetyFactsComplete: true,
      ownerPolicy: { allowAutonomous: true },
    },
    ownerPolicy: {
      writeRequiresOwnerApproval: true,
      allowedTools: ['policy.read'],
    },
    tools: [{
      name: 'policy.read',
      mode: 'read_only',
      description: 'Read verified policy.',
    }],
    ...overrides,
  };
}

function planningRequest(overrides = {}) {
  return safeRequest({
    objective: 'Compare verified policy options and recommend a bounded strategy.',
    state: {
      ...safeRequest().state,
      proposal: 'Compare verified policy options and recommend a strategy.',
      evidence: [{ verified: true }, { verified: true }],
    },
    ...overrides,
  });
}

function providerStub() {
  const calls = [];
  return {
    model: 'jeff-http-test-model',
    calls,
    async complete(input) {
      calls.push(input);
      if (input.phase === 'plan') {
        return {
          situation: 'A verified policy review is required.',
          unknowns: ['Whether the state changes after review.'],
          candidates: [
            {
              id: 'inspect',
              title: 'Inspect policy',
              steps: ['Read the verified policy.', 'Prepare a bounded report.'],
              toolProposals: [{ tool: 'policy.read', purpose: 'Read policy.', input: { policyId: 'vault' } }],
              expectedOutcome: 'A verified report is prepared.',
              risks: ['The state may become stale.'],
              reversibility: 'Read-only.',
            },
            {
              id: 'wait',
              title: 'Wait for evidence',
              steps: ['Wait for fresher evidence.'],
              toolProposals: [],
              expectedOutcome: 'No action is proposed.',
              risks: ['The report is delayed.'],
              reversibility: 'No state change.',
            },
          ],
          recommendedCandidateId: 'inspect',
        };
      }
      return { candidateId: 'inspect', verdict: 'accept', issues: [] };
    },
  };
}

async function invoke(handler, request) {
  const response = responseRecorder();
  await handler(request, response);
  return response;
}

test('Brain HTTP status is public, minimal, and shadow-only', async () => {
  const handler = createJeffBrainHttpHandler({
    authorize: () => false,
    provider: providerStub(),
  });
  const response = await invoke(handler, { method: 'GET', headers: {} });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ready, true);
  assert.equal(response.body.mode, 'shadow');
  assert.equal(response.body.executionAuthorized, false);
  assert.equal(response.body.actionsExecuted, 0);
  assert.equal(response.headers['cache-control'], 'no-store');
});

test('Brain HTTP POST returns a verified non-executing result', async () => {
  const provider = providerStub();
  const handler = createJeffBrainHttpHandler({ authorize: () => true, provider });
  const response = await invoke(handler, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: { request: safeRequest() },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.schema, 'jeff-brain-http-response-v1');
  assert.equal(response.body.result.executionAuthorized, false);
  assert.equal(response.body.result.actionsExecuted, 0);
  assert.equal(response.body.result.audit.executionAuthorized, false);
  assert.match(response.body.result.audit.receiptSha256, /^[a-f0-9]{64}$/);
  assert.equal(response.body.result.llmUtility.decision, 'deterministic_only');
  assert.equal(response.body.result.llmUtility.providerCallsAllowed, 0);
  assert.equal(response.body.result.audit.providerCallsUsed, 0);
  assert.equal(provider.calls.length, 0);
});

test('Brain HTTP spends two provider calls only for a qualified planning use case', async () => {
  const provider = providerStub();
  const handler = createJeffBrainHttpHandler({ authorize: () => true, provider });
  const response = await invoke(handler, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: { request: planningRequest() },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.result.llmUtility.decision, 'use_llm');
  assert.equal(response.body.result.llmUtility.providerCallsAllowed, 2);
  assert.equal(response.body.result.audit.providerCallsUsed, 2);
  assert.equal(provider.calls.length, 2);
});

test('Brain HTTP rejects unauthenticated, malformed, oversized, and non-JSON requests', async () => {
  const provider = providerStub();
  const authenticate = createJeffBrainBearerAuthenticator({ token: 'a'.repeat(32) });
  const handler = createJeffBrainHttpHandler({ authorize: authenticate, provider, maximumBodyBytes: 1_024 });

  let response = await invoke(handler, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: { request: safeRequest() },
  });
  assert.equal(response.statusCode, 401);
  assert.equal(provider.calls.length, 0);

  response = await invoke(handler, {
    method: 'POST',
    headers: { 'content-type': 'text/plain', authorization: `Bearer ${'a'.repeat(32)}` },
    body: '{}',
  });
  assert.equal(response.statusCode, 415);

  response = await invoke(handler, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${'a'.repeat(32)}` },
    body: '{not-json',
  });
  assert.equal(response.statusCode, 400);

  response = await invoke(handler, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${'a'.repeat(32)}` },
    body: JSON.stringify({ request: safeRequest(), padding: 'x'.repeat(2_000) }),
  });
  assert.equal(response.statusCode, 400);
  assert.equal(provider.calls.length, 0);
});

test('Brain HTTP keeps privileged context closed when server dependencies are absent', async () => {
  const provider = providerStub();
  const handler = createJeffBrainHttpHandler({ authorize: () => true, provider });
  const response = await invoke(handler, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: {
      request: safeRequest({
        memory: {
          scope: { agentId: 'agent:1', ownerId: 'owner:alice', ownerEpoch: 1 },
          authorization: {
            agentId: 'agent:1', ownerId: 'owner:alice', ownerEpoch: 1,
            subject: 'caller', canReadMemory: true,
          },
        },
      }),
    },
  });
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.error, 'SERVICE_NOT_CONFIGURED');
  assert.equal(response.body.executionAuthorized, false);
  assert.equal(provider.calls.length, 0);
});

test('Brain HTTP sanitizes provider failures and never leaks execution authority', async () => {
  const provider = {
    model: 'broken-provider',
    async complete() { throw new Error('private-provider-detail'); },
  };
  const handler = createJeffBrainHttpHandler({ authorize: () => true, provider });
  const response = await invoke(handler, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: { request: planningRequest() },
  });
  assert.equal(response.statusCode, 500);
  assert.equal(response.body.error, 'INTERNAL_FAILURE');
  assert.equal(JSON.stringify(response.body).includes('private-provider-detail'), false);
  assert.equal(response.body.executionAuthorized, false);
  assert.equal(response.body.actionsExecuted, 0);
});

test('environment handler fails closed when secrets or model configuration are missing', async () => {
  const handler = createJeffBrainEnvHttpHandler({ env: {} });
  let response = await invoke(handler, { method: 'GET', headers: {} });
  assert.equal(response.body.ready, false);
  response = await invoke(handler, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: { request: safeRequest() },
  });
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.error, 'SERVICE_NOT_CONFIGURED');

  const invalidRemote = createJeffBrainEnvHttpHandler({
    env: {
      JEFF_BRAIN_ACCESS_TOKEN: 'a'.repeat(32),
      JEFF_BRAIN_MODEL: 'model',
      JEFF_BRAIN_BASE_URL: 'https://remote.example',
    },
  });
  response = await invoke(invalidRemote, { method: 'GET', headers: {} });
  assert.equal(response.body.ready, false);
});

test('unsupported methods fail without invoking the provider', async () => {
  const provider = providerStub();
  const handler = createJeffBrainHttpHandler({ authorize: () => true, provider });
  const response = await invoke(handler, { method: 'DELETE', headers: {} });
  assert.equal(response.statusCode, 405);
  assert.equal(response.headers.allow, 'GET, POST');
  assert.equal(provider.calls.length, 0);
});
