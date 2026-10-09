import test from 'node:test';
import assert from 'node:assert/strict';
import { runMonitorProbe, nextMonitorState, validateMonitorConfig } from '../scripts/uptime-monitor.mjs';

const config = { origin: 'https://jeff.example', rpcUrl: 'https://rpc.example/private-key?token=secret',
  chainId: 4663, collection: `0x${'ab'.repeat(20)}`, expectedReleaseSha: 'a'.repeat(40) };
const healthy = { product: 'JEFF', fixture: false, chainId: config.chainId, collection: config.collection,
  continuousHosting: true, modelConfigured: true, toolsEnabled: false, releaseSha: config.expectedReleaseSha, restoreBlocked: false };
const rpc = [{ jsonrpc: '2.0', id: 2, result: '0x123' }, { jsonrpc: '2.0', id: 1, result: '0x1237' }];
function fixture({ health = { status: 'ready', runtime: 'openclaw' }, publicConfig = healthy, chain = rpc } = {}) {
  const calls = [];
  return { calls, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(url.endsWith('/health') ? health : url.endsWith('/api/config') ? publicConfig : chain));
  } };
}

test('monitor uses only three public bounded requests and retains no credential path or response text', async () => {
  const f = fixture();
  const observation = await runMonitorProbe(config, f);
  assert.equal(observation.ok, true);
  assert.equal(observation.checks[2].blockNumber, '291');
  assert.equal(f.calls.length, 3);
  for (const { options } of f.calls) {
    assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
    assert.ok(options.signal instanceof AbortSignal); assert.equal(options.headers.Authorization, undefined);
  }
  assert.deepEqual(JSON.parse(f.calls[2].options.body).map(item => item.method), ['eth_chainId', 'eth_blockNumber']);
  assert.equal(observation.privateWorkspaceRead, false); assert.equal(observation.inferenceCalled, false);
  assert.equal(JSON.stringify(observation).includes('private-key'), false);
  assert.equal(JSON.stringify(observation).includes('secret'), false);
});

test('monitor fails closed for wrong chain, fixture deployment, source drift and restore guard', async () => {
  for (const [publicConfig, chain, reason] of [
    [healthy, [{ ...rpc[0] }, { ...rpc[1], result: '0x1' }], 'CHAIN_MISMATCH'],
    [{ ...healthy, fixture: true }, rpc, 'CONFIG_MISMATCH'],
    [{ ...healthy, releaseSha: 'b'.repeat(40) }, rpc, 'CONFIG_MISMATCH'],
    [{ ...healthy, restoreBlocked: true }, rpc, 'RESTORE_GUARDED'],
  ]) {
    const observation = await runMonitorProbe(config, fixture({ publicConfig, chain }));
    assert.equal(observation.ok, false); assert.ok(observation.checks.some(item => item.reason === reason));
  }
});

test('monitor redacts upstream errors and bounds response size', async () => {
  const f = fixture({ chain: [{ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'secret provider data' } }, rpc[0]] });
  let observation = await runMonitorProbe(config, f);
  assert.equal(observation.checks[2].reason, 'RPC_ERROR'); assert.equal(JSON.stringify(observation).includes('secret'), false);
  observation = await runMonitorProbe(config, { fetchImpl: async () => new Response('x'.repeat(65537)) });
  assert.ok(observation.checks.every(item => !item.ok && item.reason === 'BODY_TOO_LARGE'));
  observation = await runMonitorProbe(config, { fetchImpl: async () => { throw new Error('https://secret.invalid/key'); } });
  assert.ok(observation.checks.every(item => item.reason === 'TRANSPORT_OR_RESPONSE_ERROR'));
  assert.equal(JSON.stringify(observation).includes('secret'), false);
});

test('monitor treats non-JSON, HTTP errors and malformed JSON-RPC as failures', async () => {
  let observation = await runMonitorProbe(config, { fetchImpl: async () => new Response('upstream private body', { status: 503 }) });
  assert.ok(observation.checks.every(item => item.reason === 'HTTP_ERROR' && item.httpStatus === 503));
  observation = await runMonitorProbe(config, { fetchImpl: async () => new Response('{') });
  assert.ok(observation.checks.every(item => !item.ok));
  observation = await runMonitorProbe(config, fixture({ chain: [rpc[0], rpc[0]] }));
  assert.equal(observation.checks[2].reason, 'RPC_INVALID');
});

test('monitor alerts after three failed samples, clears on recovery, bounds history and resets on target changes', async () => {
  const observation = await runMonitorProbe(config, fixture());
  const failure = { ...observation, ok: false, checks: [{ name: 'public-health', ok: false, reason: 'HTTP_ERROR' }] };
  let state = nextMonitorState(null, failure);
  assert.equal(state.alertActive, false);
  state = nextMonitorState(state, failure); assert.equal(state.alertActive, false);
  state = nextMonitorState(state, failure); assert.equal(state.alertActive, true);
  assert.equal(state.consecutiveFailures, 3);
  state = nextMonitorState(state, observation); assert.equal(state.alertActive, false); assert.equal(state.alertSince, null);
  for (let index = 0; index < 300; index++) state = nextMonitorState(state, observation);
  assert.equal(state.history.length, 288);
  state = nextMonitorState(state, { ...failure, origin: 'https://another.example' });
  assert.equal(state.history.length, 1); assert.equal(state.consecutiveFailures, 1);
});

test('monitor refuses insecure or credentialed endpoints and invalid timeouts before networking', async () => {
  for (const invalid of [{ origin: 'http://jeff.example' }, { origin: 'https://jeff.example/path' },
    { rpcUrl: 'https://user:password@rpc.example' }, { timeoutMs: 99999 }, { expectedReleaseSha: 'unknown' }]) {
    assert.throws(() => validateMonitorConfig({ ...config, ...invalid }));
  }
});
