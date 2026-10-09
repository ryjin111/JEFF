import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInferenceLedger } from '../src/inference-ledger.mjs';
import { createInferenceGateway } from '../src/inference-gateway.mjs';
import { createOpenClawRunner } from '../src/openclaw-runner.mjs';

const testRoot = dirname(fileURLToPath(import.meta.url));
const scope = { chainId: 4663, owner: '0x' + '11'.repeat(20) };
const other = { chainId: 4663, owner: '0x' + '22'.repeat(20) };
const policy = { basis: 'operator-token-tariff', policyId: 'operator-tariff-test-v1',
  inputMicrosPerMillionTokens: 1000000, outputMicrosPerMillionTokens: 2000000 };
const completion = (changes = {}) => ({ id: 'fixture-provider-request', object: 'chat.completion', created: 1, model: 'fixture',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Measured fixture response.' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, ...changes });
const requestBody = (changes = {}) => ({ model: 'fixture', messages: [{ role: 'user', content: 'Hello' }], max_tokens: 32, ...changes });
async function fixture(t, options = {}) {
  const root = await mkdtemp(resolve(testRoot, '.inference-gateway-'));
  const ledger = createInferenceLedger({ dataRoot: root });
  ledger.fund({ receiptId: 'provider-capacity', amountMicros: 100000 });
  ledger.grant({ grantId: 'holder-allocation', receiptId: 'provider-capacity', chainId: scope.chainId, wallet: scope.owner, amountMicros: 100000 });
  const calls = [];
  const fetchImpl = options.fetchImpl || (async (url, input) => { calls.push({ url, ...input }); return new Response(JSON.stringify(completion()), { status: 200 }); });
  const gateway = createInferenceGateway({ ledger, upstreamUrl: 'https://provider.example/v1', upstreamKey: 'upstream-fixture-key',
    allowedModels: ['fixture'], pricing: { fixture: policy }, maxInputTokens: 512, maxOutputTokens: 32, fetchImpl, ...options });
  await gateway.start();
  t.after(async () => { await gateway.stop(); ledger.close(); assert.equal(dirname(root), testRoot); await rm(root, { recursive: true, force: true }); });
  return { root, ledger, gateway, calls, issue(jobId = 'job-fixture', input = {}) {
    return gateway.issue({ jobId, scope, model: 'fixture', dailyLimitMicros: 10000, maxChargeMicros: 1000, ...input });
  }, async request(credential, input = requestBody(), path = '/chat/completions', extra = {}) {
    return fetch(credential.baseUrl + path, { method: 'POST', headers: { Authorization: `Bearer ${credential.apiKey}`, 'Content-Type': 'application/json', ...extra.headers },
      body: JSON.stringify(input), ...Object.fromEntries(Object.entries(extra).filter(([key]) => key !== 'headers')) });
  } };
}

test('configured operator tariff charges measured usage, refunds the conservative hold and exposes no provider secret', async t => {
  const f = await fixture(t), credential = f.issue();
  assert.match(credential.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
  assert.notEqual(credential.apiKey, 'upstream-fixture-key');
  const response = await f.request(credential);
  assert.equal(response.status, 200); assert.equal((await response.json()).choices[0].message.content, 'Measured fixture response.');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, 'https://provider.example/v1/chat/completions');
  assert.equal(f.calls[0].redirect, 'error'); assert.equal(f.calls[0].headers['X-API-Key'], 'upstream-fixture-key');
  const forwarded = JSON.parse(f.calls[0].body);
  assert.equal(forwarded.stream, false); assert.equal(forwarded.max_completion_tokens, 32);
  assert.equal(f.ledger.balance(scope).chargedMicros, 20); assert.equal(f.ledger.balance(scope).heldMicros, 0);
  const record = f.ledger.list(scope).find(item => item.type === 'reservation');
  assert.equal(record.details.pricingBasis, 'operator-token-tariff'); assert.equal(record.details.providerDebitVerified, false);
  assert.equal(JSON.stringify(record).includes('upstream-fixture-key'), false);
  assert.equal(JSON.stringify(record).includes('Hello'), false);
});

test('a reservation and forwarded marker are committed before any provider call', async t => {
  let f;
  f = await fixture(t, { fetchImpl: async () => {
    const reopened = createInferenceLedger({ dataRoot: f.root });
    try {
      assert.equal(reopened.balance(scope).heldMicros, 576);
      assert.equal(reopened.list(scope).find(item => item.type === 'reservation').state, 'forwarded');
    } finally { reopened.close(); }
    return new Response(JSON.stringify(completion()));
  } });
  assert.equal((await f.request(f.issue())).status, 200);
});

test('missing, unversioned and inferred price policies cannot issue funded runtime credentials', async t => {
  for (const pricing of [{}, { fixture: { ...policy, basis: 'provider-estimate' } }, { fixture: { ...policy, policyId: '' } }, { fixture: { ...policy, inputMicrosPerMillionTokens: 0.5 } }]) {
    const f = await fixture(t, { pricing });
    assert.throws(() => f.issue(), /PRICE_POLICY_REQUIRED/);
    assert.equal(f.calls.length, 0); assert.equal(f.ledger.balance(scope).heldMicros, 0);
  }
});

test('revoked, expired and other credentials cannot reach a provider', async t => {
  let now = 1000;
  const f = await fixture(t, { now: () => now });
  const revoked = f.issue('revoked'); f.gateway.revoke('revoked');
  assert.equal((await f.request(revoked)).status, 401);
  const expired = f.issue('expired'); now += 180000;
  assert.equal((await f.request(expired)).status, 401);
  assert.equal((await f.request({ ...expired, apiKey: 'forged-key' })).status, 401);
  assert.equal(f.calls.length, 0); assert.equal(f.ledger.balance(scope).heldMicros, 0);
});

test('job IDs cannot be reissued after revocation and a wallet cannot borrow another wallet credits', async t => {
  const f = await fixture(t); f.issue('once'); f.gateway.revoke('once');
  assert.throws(() => f.issue('once'), /JOB_CONFIG_INVALID/);
  assert.throws(() => f.issue('other-wallet', { scope: other }), /BALANCE_EXHAUSTED/);
  assert.throws(() => f.issue('wrong-model', { model: 'unapproved' }), /JOB_CONFIG_INVALID/);
  assert.equal(f.calls.length, 0);
});

test('model swaps, tools, remote content and caller-selected URLs are denied before reservation', async t => {
  const f = await fixture(t), credential = f.issue();
  const attempts = [
    requestBody({ model: 'expensive-model' }), requestBody({ tools: [{ type: 'function' }] }),
    requestBody({ tool_choice: 'auto' }), requestBody({ base_url: 'https://evil.example' }),
    requestBody({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://evil.example' } }] }] }),
    requestBody({ messages: [{ role: 'tool', content: 'tool result' }] }),
    requestBody({ messages: [{ role: 'assistant', content: 'text', tool_calls: [{}] }] }),
  ];
  for (const body of attempts) assert.equal((await f.request(credential, body)).status, 403);
  assert.equal(f.calls.length, 0); assert.equal(f.ledger.balance(scope).heldMicros, 0);
});

test('exact route, method and absence of browser Origin are enforced', async t => {
  const f = await fixture(t), credential = f.issue();
  assert.equal((await f.request(credential, requestBody(), '/models')).status, 403);
  assert.equal((await f.request(credential, requestBody(), '/chat/completions?url=https://evil.example')).status, 403);
  assert.equal((await f.request(credential, requestBody(), '/chat/completions', { headers: { Origin: 'http://evil.example' } })).status, 403);
  assert.equal((await fetch(credential.baseUrl + '/chat/completions', { headers: { Authorization: `Bearer ${credential.apiKey}` } })).status, 403);
  assert.equal(f.calls.length, 0);
});

test('context, output and request size bounds fail before funds or calls are consumed', async t => {
  const f = await fixture(t), credential = f.issue();
  for (const body of [requestBody({ max_tokens: 33 }), requestBody({ max_tokens: -1 }), requestBody({ max_tokens: 0.1 }),
    requestBody({ max_tokens: undefined }), requestBody({ messages: [{ role: 'user', content: 'x'.repeat(600) }] }),
    requestBody({ messages: [{ role: 'user', content: 'x'.repeat(150000) }] })]) assert.ok([400,429].includes((await f.request(credential, body)).status));
  assert.equal(f.calls.length, 0); assert.equal(f.ledger.balance(scope).availableMicros, 100000);
});

test('job, wallet daily and total balance caps prevent upstream access', async t => {
  const f = await fixture(t);
  assert.equal((await f.request(f.issue('job-cap', { maxChargeMicros: 575 }))).status, 429);
  assert.equal((await f.request(f.issue('day-cap', { dailyLimitMicros: 575 }))).status, 429);
  f.ledger.reserve({ id: 'existing-wallet-hold', scope, amountMicros: 99999, dailyLimitMicros: 100000 });
  assert.equal((await f.request(f.issue('balance-cap'))).status, 402);
  assert.equal(f.calls.length, 0); assert.equal(f.ledger.balance(scope).heldMicros, 99999);
});

test('one job credential cannot make provider retries after its call allowance', async t => {
  const f = await fixture(t), credential = f.issue();
  assert.equal((await f.request(credential)).status, 200);
  assert.equal((await f.request(credential)).status, 429);
  assert.equal(f.calls.length, 1); assert.equal(f.ledger.balance(scope).chargedMicros, 20);
});

test('concurrent calls cannot bypass a job call cap or spend its hold twice', async t => {
  let finish;
  const waiting = new Promise(resolveDone => { finish = resolveDone; });
  let entered;
  const started = new Promise(resolveStarted => { entered = resolveStarted; });
  let calls = 0;
  const f = await fixture(t, { fetchImpl: async () => { calls++; entered(); await waiting; return new Response(JSON.stringify(completion())); } });
  const credential = f.issue(); const first = f.request(credential); await started;
  assert.equal((await f.request(credential)).status, 429);
  assert.equal(f.ledger.balance(scope).heldMicros, 576);
  finish(); assert.equal((await first).status, 200); assert.equal(calls, 1);
});

test('HTTP failures and transport errors retain an unknown hold without automatic retries', async t => {
  for (const fetchImpl of [async () => new Response('rejected', { status: 402 }), async () => new Response('failed', { status: 503 }), async () => { throw new Error('fixture transport lost'); }]) {
    let calls = 0;
    const f = await fixture(t, { fetchImpl: async (...args) => { calls++; return fetchImpl(...args); } });
    const credential = f.issue(); assert.equal((await f.request(credential)).status, 503);
    assert.equal(calls, 1); assert.equal(f.ledger.balance(scope).heldMicros, 576);
    const unknown = f.ledger.list(scope).find(item => item.type === 'reservation');
    assert.equal(unknown.state, 'unknown'); assert.throws(() => f.ledger.release(unknown.id), /RECONCILIATION_REQUIRED/);
    assert.equal((await f.request(credential)).status, 429); assert.equal(calls, 1);
  }
});

test('missing, contradictory, fractional and over-budget usage fails closed with its hold intact', async t => {
  const outputs = [completion({ usage: undefined }), completion({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 14 } }),
    completion({ usage: { prompt_tokens: 10.1, completion_tokens: 5, total_tokens: 15.1 } }),
    completion({ usage: { prompt_tokens: 10, completion_tokens: 33, total_tokens: 43 } }),
    completion({ usage: { prompt_tokens: 513, completion_tokens: 5, total_tokens: 518 } }),
    completion({ model: 'silent-fallback' }), completion({ choices: [] })];
  for (const output of outputs) {
    const f = await fixture(t, { fetchImpl: async () => new Response(JSON.stringify(output)) });
    const response = await f.request(f.issue()); assert.equal(response.status, 503);
    assert.equal(f.ledger.balance(scope).chargedMicros, 0); assert.equal(f.ledger.balance(scope).heldMicros, 576);
  }
});

test('a fake provider dollar metadata field never overrides the configured measured-token tariff', async t => {
  const f = await fixture(t, { fetchImpl: async () => new Response(JSON.stringify(completion({ cost: 0, billed_cost: 0, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 999 } }))) });
  assert.equal((await f.request(f.issue())).status, 200);
  assert.equal(f.ledger.balance(scope).chargedMicros, 20);
});

test('small measured costs round deterministically to microUSD without disappearing', async t => {
  const f = await fixture(t, { pricing: { fixture: { ...policy, inputMicrosPerMillionTokens: 1, outputMicrosPerMillionTokens: 1 } } });
  assert.equal((await f.request(f.issue())).status, 200);
  assert.equal(f.ledger.balance(scope).chargedMicros, 1); assert.equal(f.ledger.balance(scope).heldMicros, 0);
});

test('streaming clients receive a completed SSE envelope after metering, while upstream streaming stays disabled', async t => {
  const f = await fixture(t), response = await f.request(f.issue(), requestBody({ stream: true, stream_options: { include_usage: true } }));
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /event-stream/);
  const text = await response.text(); assert.match(text, /chat.completion.chunk/); assert.match(text, /Measured fixture response/); assert.match(text, /\[DONE\]/);
  assert.equal(JSON.parse(f.calls[0].body).stream, false); assert.equal(f.ledger.balance(scope).chargedMicros, 20);
});

test('pausing after issue blocks provider access, and stop revokes every credential', async t => {
  const f = await fixture(t), credential = f.issue();
  f.ledger.setPaused(true); assert.equal((await f.request(credential)).status, 503); assert.equal(f.calls.length, 0);
  f.ledger.setPaused(false); await f.gateway.stop();
  assert.throws(() => f.issue('after-stop'), /JOB_CONFIG_INVALID/);
});

test('provider destinations reject credentials, redirects, query strings, insecure remote URLs and arbitrary paths', () => {
  const ledger = { reserve() {} };
  for (const upstreamUrl of ['http://remote.example/v1','https://u:p@provider.example/v1','https://provider.example/v1?key=x',
    'https://provider.example/v1#fragment','file:///tmp/model','https://provider.example/arbitrary-path']) {
    assert.throws(() => createInferenceGateway({ ledger, upstreamUrl, upstreamKey: 'fixture' }), /GATEWAY_CONFIG_INVALID/);
  }
});

test('the installed OpenClaw CLI completes through a job-scoped gateway without receiving the upstream key', async t => {
  const f = await fixture(t, { maxInputTokens: 16384, maxOutputTokens: 4096 });
  const credential = f.issue('12345678-1234-1234-1234-123456789abc', { maxChargeMicros: 50000, dailyLimitMicros: 50000 });
  const runner = createOpenClawRunner({ model: 'bankr/fixture', allowedModels: ['bankr/fixture'],
    env: Object.fromEntries(['PATH','Path','SystemRoot','WINDIR','USERPROFILE','COMSPEC','LANG'].filter(key => process.env[key]).map(key => [key, process.env[key]])) });
  const stateRoot = resolve(f.root, 'fixture-runtime');
  const result = await runner({ scope: { ...scope, collection: '0x' + '33'.repeat(20), tokenId: '35', ownerEpoch: 0 },
    objective: 'Summarize this explicit model fixture.', workspace: resolve(stateRoot, 'workspace'), stateRoot,
    jobId: '12345678-1234-1234-1234-123456789abc', inferenceGateway: credential });
  assert.equal(result.text, 'Measured fixture response.');
  assert.equal(f.calls.length, 1); assert.equal(f.ledger.balance(scope).chargedMicros, 20);
  f.gateway.revoke('12345678-1234-1234-1234-123456789abc');
  assert.equal((await f.request(credential)).status, 401);
});

test('credential retention is bounded and expired registry entries are collected', async t => {
  let now = 0;
  const f = await fixture(t, { maxJobs: 2, now: () => now });
  f.issue('one'); f.gateway.revoke('one'); f.issue('two');
  assert.throws(() => f.issue('three'), /CAPACITY_REACHED/);
  assert.equal(f.gateway.status().retainedJobs, 2);
  now = 180000; f.issue('three');
  assert.equal(f.gateway.status().retainedJobs, 1);
  assert.equal(f.gateway.status().activeCredentials, 1);
});

test('revoke aborts an active provider request and tracked drain waits for the unknown hold commit', async t => {
  let entered;
  const started = new Promise(resolveStarted => { entered = resolveStarted; });
  const tracked = [];
  const f = await fixture(t, { track: (promise, label) => { tracked.push({ promise, label }); return promise; },
    fetchImpl: async (_url, { signal }) => new Promise((_done, reject) => {
      entered(); signal.addEventListener('abort', () => reject(new Error('fixture aborted after forwarding')), { once: true });
    }) });
  const credential = f.issue(), pending = f.request(credential); await started;
  assert.equal(f.gateway.status().activeRequests, 1); assert.equal(tracked.length, 1);
  f.gateway.revoke('job-fixture');
  await f.gateway.drain(); await tracked[0].promise;
  assert.equal((await pending).status, 503); assert.equal(f.gateway.status().activeRequests, 0);
  assert.equal(f.ledger.list(scope).find(item => item.type === 'reservation').state, 'unknown');
  assert.equal(f.ledger.balance(scope).heldMicros, 576);
});

test('two NFTs sharing a wallet enforce independent agent limits with attributable calls', async t => {
  const f = await fixture(t);
  const nft = { ...scope, collection: '0x' + '33'.repeat(20), tokenId: '35', ownerEpoch: 0 };
  const first = f.issue('nft-one', { scope: nft, dailyLimitMicros: 576 });
  const second = f.issue('nft-two', { scope: { ...nft, tokenId: '36' }, dailyLimitMicros: 576 });
  assert.equal((await f.request(first)).status, 200);
  assert.equal((await f.request(f.issue('nft-one-second', { scope: nft, dailyLimitMicros: 576 }))).status, 429);
  assert.equal((await f.request(second)).status, 200);
  assert.equal(f.ledger.balance(scope).chargedMicros, 40);
  const calls = f.ledger.list(scope).filter(item => item.type === 'reservation');
  assert.equal(new Set(calls.map(item => item.details.budgetScopeId)).size, 2);
  assert.deepEqual(new Set(calls.map(item => item.details.agentScope.tokenId)), new Set(['35','36']));
});

test('preflight catches known policy, balance and cap errors without reservations or provider calls', async t => {
  const f = await fixture(t);
  const input = { scope, model: 'fixture', dailyLimitMicros: 1000, maxChargeMicros: 1000 };
  assert.equal(f.gateway.preflight(input).requiredMicros, 576);
  assert.equal(f.ledger.list(scope).length, 1);
  assert.throws(() => f.gateway.preflight({ ...input, dailyLimitMicros: 575 }), /DAILY_LIMIT_REACHED/);
  assert.throws(() => f.gateway.preflight({ ...input, maxChargeMicros: 575 }), /JOB_LIMIT_REACHED/);
  assert.throws(() => f.gateway.preflight({ ...input, scope: other }), /BALANCE_EXHAUSTED/);
  assert.equal(f.ledger.list(scope).length, 1); assert.equal(f.calls.length, 0);
});
