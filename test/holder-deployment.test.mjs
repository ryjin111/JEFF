import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import test from 'node:test';

import {
  createJeffHolderDeploymentHandler,
  JEFF_HOLDER_DEPLOYMENT,
} from '../api/_lib/jeff-holder-deployment.mjs';

function responseFixture() {
  const state = { statusCode: 0, headers: {}, body: undefined };
  return {
    state,
    response: {
      set statusCode(value) { state.statusCode = value; },
      get statusCode() { return state.statusCode; },
      setHeader(name, value) { state.headers[name] = value; },
      end(body) { state.body = JSON.parse(body); },
    },
  };
}

test('deployment remains disabled without an explicit kill-switch opt in', async () => {
  const handler = createJeffHolderDeploymentHandler({ env: {} });
  const get = responseFixture();
  await handler({ method: 'GET' }, get.response);
  assert.equal(get.state.statusCode, 200);
  assert.equal(get.state.body.ready, undefined);
  assert.equal(get.state.body.error, 'SERVICE_DISABLED');
  assert.equal(get.state.body.executionAuthorized, false);

  const post = responseFixture();
  await handler({ method: 'POST' }, post.response);
  assert.equal(post.state.statusCode, 503);
  assert.equal(post.state.body.error, 'SERVICE_DISABLED');
});

test('valid managed configuration exposes ready status without financial authority', async () => {
  const { privateKey } = generateKeyPairSync('ed25519');
  const env = {
    JEFF_HOLDER_ENABLED: 'true',
    JEFF_HOLDER_ORIGIN: 'https://clockers.example',
    JEFF_HOLDER_URI: 'https://clockers.example/holder/',
    JEFF_HOLDER_CHAIN_ID: '4663',
    JEFF_HOLDER_COLLECTION: '0xf4127aC7E73a807060Cbdd08fC2c776b2E78CE67',
    JEFF_HOLDER_MEMORY_KEY: randomBytes(32).toString('base64'),
    JEFF_HOLDER_RECEIPT_PRIVATE_KEY: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    JEFF_HOLDER_RECEIPT_KEY_ID: 'staging-holder-2026-10',
    JEFF_BRAIN_MODEL: 'holder-test-model',
    JEFF_BRAIN_BASE_URL: 'http://127.0.0.1:11434',
  };
  const handler = createJeffHolderDeploymentHandler({
    env,
    database: { query: async () => ({ rows: [] }) },
    getPublicClient: async () => ({}),
    resolveOwnerEpoch: async () => ({}),
    clientIdentity: () => 'test-client',
  });
  const result = responseFixture();
  await handler({ method: 'GET' }, result.response);
  assert.equal(result.state.statusCode, 200);
  assert.equal(result.state.body.ready, true);
  assert.equal(result.state.body.executionAuthorized, false);
  assert.equal(result.state.body.actionsExecuted, 0);
});

test('invalid managed secrets fail closed without exposing secret material', async () => {
  const env = {
    JEFF_HOLDER_ENABLED: 'true',
    JEFF_HOLDER_MEMORY_KEY: 'not-a-key',
  };
  const handler = createJeffHolderDeploymentHandler({
    env,
    database: { query: async () => ({ rows: [] }) },
    getPublicClient: async () => ({}),
    resolveOwnerEpoch: async () => ({}),
    clientIdentity: () => 'test-client',
  });
  const result = responseFixture();
  await handler({ method: 'POST' }, result.response);
  assert.equal(result.state.statusCode, 503);
  assert.deepEqual(result.state.body, {
    schema: 'jeff-holder-http-error-v1',
    error: 'SERVICE_NOT_CONFIGURED',
    mode: 'shadow',
    executionAuthorized: false,
    actionsExecuted: 0,
  });
});

test('deployment manifest records the disabled-by-default boundary', () => {
  assert.equal(JEFF_HOLDER_DEPLOYMENT.enabledByDefault, false);
  assert.equal(JEFF_HOLDER_DEPLOYMENT.executionAuthorized, false);
  assert.equal(JEFF_HOLDER_DEPLOYMENT.actionsExecuted, 0);
});
