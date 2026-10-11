import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createInferenceLedger } from '../src/inference-ledger.mjs';
import { createInferenceGateway } from '../src/inference-gateway.mjs';

const testRoot = import.meta.dirname;
const scope = { chainId: 4663, owner: '0x' + '11'.repeat(20) };
const policy = { basis: 'operator-token-tariff', policyId: 'drain-fixture-v1',
  inputMicrosPerMillionTokens: 1000000, outputMicrosPerMillionTokens: 2000000 };
const body = label => ({ model: 'fixture', messages: [{ role: 'user', content: label }], max_tokens: 32 });
const completion = () => ({ model: 'fixture', choices: [{ message: { role: 'assistant', content: 'Synthetic response.' } }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
const tick = () => new Promise(done => setImmediate(done));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function within(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('FIXTURE_DRAIN_TIMEOUT')), 2000); })]); }
  finally { clearTimeout(timer); }
}
async function active(gateway, count) {
  const deadline = Date.now() + 2000;
  while (gateway.status().activeRequests !== count) { assert.ok(Date.now() < deadline, 'FIXTURE_REQUEST_NOT_ADMITTED'); await tick(); }
}
async function fixture(t, options = {}) {
  const root = await mkdtemp(resolve(testRoot, '.inference-drain-'));
  const ledger = createInferenceLedger({ dataRoot: root });
  ledger.fund({ receiptId: 'synthetic-capacity', amountMicros: 100000 });
  ledger.grant({ grantId: 'synthetic-grant', receiptId: 'synthetic-capacity', chainId: scope.chainId, wallet: scope.owner, amountMicros: 100000 });
  const entered = new Map(), waiting = new Map(), signals = new Map(); let providerCalls = 0;
  const started = label => { if (!entered.has(label)) entered.set(label, deferred()); return entered.get(label).promise; };
  const fetchImpl = async (_url, input) => {
    const label = JSON.parse(input.body).messages[0].content, pending = deferred(); providerCalls++;
    waiting.set(label, pending); signals.set(label, input.signal);
    const abort = () => pending.reject(Error('SYNTHETIC_UPSTREAM_ABORTED'));
    input.signal.addEventListener('abort', abort, { once: true });
    if (input.signal.aborted) abort();
    if (!entered.has(label)) entered.set(label, deferred()); entered.get(label).resolve();
    try { await pending.promise; return new Response(JSON.stringify(completion())); }
    finally { input.signal.removeEventListener('abort', abort); }
  };
  const gateway = createInferenceGateway({ ledger, upstreamUrl: 'https://provider.invalid/v1', upstreamKey: 'synthetic-only',
    allowedModels: ['fixture'], pricing: { fixture: policy }, maxInputTokens: 512, maxOutputTokens: 32, fetchImpl, ...options });
  await gateway.start();
  t.after(async () => { await gateway.stop(); ledger.close(); assert.equal(dirname(root), testRoot); await rm(root, { recursive: true, force: true }); });
  return { root, gateway, ledger, started, signals, finish: label => waiting.get(label).resolve(), calls: () => providerCalls,
    issue: jobId => gateway.issue({ jobId, scope, model: 'fixture', dailyLimitMicros: 10000, maxChargeMicros: 1000 }),
    request: (credential, label, extra = {}) => fetch(credential.baseUrl + '/chat/completions', { method: 'POST',
      headers: { Authorization: 'Bearer ' + credential.apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body(label), ...extra }) }) };
}
function partialRequest(credential) {
  let responseReady;
  const response = new Promise((resolveResponse, reject) => {
    responseReady = httpRequest(credential.baseUrl + '/chat/completions', { method: 'POST', headers: {
      Authorization: 'Bearer ' + credential.apiKey, 'Content-Type': 'application/json' } }, incoming => {
      incoming.resume(); incoming.once('end', () => resolveResponse(incoming.statusCode));
    });
    responseReady.once('error', reject); responseReady.write('{');
  });
  response.catch(() => {});
  return { request: responseReady, response };
}

test('revoked job drain commits its unknown outcome without waiting for another held SSE job', async t => {
  const f = await fixture(t), a = f.issue('job-a'), b = f.issue('job-b');
  const first = f.request(a, 'A'), second = f.request(b, 'B', { stream: true });
  await Promise.all([f.started('A'), f.started('B')]);
  f.gateway.revoke('job-a'); await within(f.gateway.drain('job-a'));
  assert.equal((await first).status, 503); assert.equal(f.gateway.status().activeRequests, 1);
  assert.equal(f.signals.get('B').aborted, false); assert.equal(f.calls(), 2);
  const reopened = createInferenceLedger({ dataRoot: f.root });
  try {
    const records = reopened.list(scope).filter(record => record.type === 'reservation');
    assert.equal(records.find(record => record.details.jobId === 'job-a').state, 'unknown');
    assert.equal(records.find(record => record.details.jobId === 'job-b').state, 'forwarded');
    assert.equal(reopened.balance(scope).heldMicros, 1152);
  } finally { reopened.close(); }
  f.gateway.revoke('job-a'); await within(f.gateway.drain('job-a')); await within(f.gateway.drain('unknown-job'));
  assert.equal(f.gateway.status().activeRequests, 1); assert.equal(f.signals.get('B').aborted, false);
  assert.equal((await f.request(a, 'late-A')).status, 401); assert.equal(f.calls(), 2);
  f.finish('B'); const response = await second; assert.equal(response.status, 200); assert.match(await response.text(), /\[DONE\]/);
  await f.gateway.drain('job-b'); assert.equal(f.ledger.balance(scope).chargedMicros, 20); assert.equal(f.ledger.balance(scope).heldMicros, 576);
});

test('global drain still waits for every job while a completed job can drain independently', async t => {
  const f = await fixture(t), first = f.request(f.issue('first'), 'A'), second = f.request(f.issue('second'), 'B');
  await Promise.all([f.started('A'), f.started('B')]);
  let globallyDrained = false;
  const global = f.gateway.drain().then(() => { globallyDrained = true; });
  f.finish('A'); assert.equal((await first).status, 200); await f.gateway.drain('first'); await tick();
  assert.equal(globallyDrained, false); assert.equal(f.gateway.status().activeRequests, 1);
  f.finish('B'); assert.equal((await second).status, 200); await within(global);
  assert.equal(globallyDrained, true); assert.equal(f.gateway.status().activeRequests, 0); assert.equal(f.ledger.balance(scope).chargedMicros, 40);
});

for (const [name, malformed, expired] of [['queued-valid-body', false, false], ['queued-malformed-body', true, false], ['expired-registry-with-queued-body', false, true]]) {
  test('job drain waits for ' + name + ' without reserving or forwarding', async t => {
    let now = 0;
    const f = await fixture(t, { now: () => now }), credential = f.issue('queued'), pending = partialRequest(credential);
    try {
      await active(f.gateway, 1);
      if (expired) { now = 180000; assert.equal(f.gateway.status().retainedJobs, 0); }
      f.gateway.revoke('queued'); let drained = false;
      const drain = f.gateway.drain('queued').then(() => { drained = true; });
      await tick(); assert.equal(drained, false);
      pending.request.end(malformed ? 'malformed}' : JSON.stringify(body('queued')).slice(1));
      assert.equal(await pending.response, malformed ? 400 : 401); await within(drain);
      assert.equal(drained, true); assert.equal(f.calls(), 0); assert.equal(f.ledger.balance(scope).heldMicros, 0);
      assert.equal(f.ledger.list(scope).filter(record => record.type === 'reservation').length, 0);
    } finally { pending.request.destroy(); }
  });
}

test('a revoked unused or expired credential drains safely and cannot be used after settlement', async t => {
  let now = 0;
  const f = await fixture(t, { now: () => now }), unused = f.issue('unused');
  f.gateway.revoke('unused'); await f.gateway.drain('unused'); await f.gateway.drain('unused');
  assert.equal((await f.request(unused, 'unused')).status, 401);
  const expired = f.issue('expired'); now = 180000;
  assert.equal((await f.request(expired, 'expired')).status, 401); await f.gateway.drain('expired');
  assert.equal(f.calls(), 0); assert.equal(f.ledger.balance(scope).heldMicros, 0);
});

test('malformed drain IDs reject without falling back to the global drain', async t => {
  const f = await fixture(t), pending = f.request(f.issue('active'), 'active'); await f.started('active');
  for (const jobId of [null, '', [], {}, 1, 'bad/id', 'x'.repeat(121)]) await assert.rejects(f.gateway.drain(jobId), /JEFF_INFERENCE_JOB_CONFIG_INVALID/);
  assert.equal(f.gateway.status().activeRequests, 1); assert.equal(f.signals.get('active').aborted, false);
  f.finish('active'); assert.equal((await pending).status, 200); await f.gateway.drain();
});
