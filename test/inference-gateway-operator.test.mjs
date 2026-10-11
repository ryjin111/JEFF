import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { createInferenceGateway } from '../src/inference-gateway.mjs';

const nft = { chainId: 4663, collection: '0x' + '22'.repeat(20), tokenId: '35', owner: '0x' + '11'.repeat(20), ownerEpoch: 0 };
const account = { kind: 'account', chainId: 4663, owner: nft.owner };
const input = (content = 'Synthetic operator request.') => ({ model: 'fixture', messages: [{ role: 'user', content }], max_tokens: 32 });
const output = () => ({ model: 'fixture', choices: [{ message: { role: 'assistant', content: 'Synthetic operator response.' } }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
const tick = () => new Promise(done => setImmediate(done));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function bounded(promise) {
  let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('SYNTHETIC_OPERATOR_TIMEOUT')), 2000); })]); }
  finally { clearTimeout(timer); }
}
async function fixture(t, options = {}) {
  let ledgerAccesses = 0, pricingAccesses = 0, calls = 0;
  const ledger = new Proxy({}, { get() { ledgerAccesses++; throw Error('SYNTHETIC_LEDGER_FORBIDDEN'); } });
  const pricing = new Proxy({}, { get() { pricingAccesses++; throw Error('SYNTHETIC_PRICING_FORBIDDEN'); } });
  const tracked = new Set(), suppliedFetch = options.fetchImpl;
  const gateway = createInferenceGateway({ billingMode: 'operator-funded', ledger, pricing,
    upstreamUrl: 'https://provider.invalid/v1', upstreamKey: 'synthetic-operator-key', allowedModels: ['fixture'], maxInputTokens: 512, maxOutputTokens: 32,
    ...options, track: promise => { tracked.add(promise); promise.finally(() => tracked.delete(promise)).catch(() => {}); },
    fetchImpl: async (url, init) => { calls++; assert.equal(url, 'https://provider.invalid/v1/chat/completions');
      assert.equal(init.headers.Authorization, 'Bearer synthetic-operator-key');
      return suppliedFetch ? suppliedFetch(url, init) : new Response(JSON.stringify(output())); } });
  await gateway.start();
  t.after(async () => { await gateway.stop(); assert.equal(ledgerAccesses, 0); assert.equal(pricingAccesses, 0); assert.equal(tracked.size, 0); });
  return { gateway, calls: () => calls, tracked,
    issue: (jobId, scope = nft, extra = {}) => gateway.issue({ jobId, scope, model: 'fixture', ...extra }),
    request: (credential, body = input(), headers = {}) => fetch(credential.baseUrl + '/chat/completions', { method: 'POST',
      headers: { Authorization: 'Bearer ' + credential.apiKey, 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }) };
}

test('operator-funded mode works without grants or tariff and never accesses ledger or pricing', async t => {
  const f = await fixture(t);
  for (const [i, scope] of [nft, account].entries()) {
    assert.deepEqual(f.gateway.preflight({ scope, model: 'fixture', dailyLimitMicros: 0, maxChargeMicros: -1 }),
      { billingMode: 'operator-funded', maxCalls: 1, maxInputTokens: 512, maxOutputTokens: 32 });
    const credential = f.issue('job-' + i, scope, { dailyLimitMicros: Infinity, maxChargeMicros: 0 });
    const response = await f.request(credential); assert.equal(response.status, 200); assert.deepEqual(await response.json(), output());
    f.gateway.revoke('job-' + i); await f.gateway.drain('job-' + i);
    assert.equal((await f.request(credential)).status, 401);
  }
  assert.equal(f.calls(), 2);
});

test('prepaid is still the default and operator mode requires an explicit valid enum', () => {
  const options = { upstreamUrl: 'https://provider.invalid/v1', upstreamKey: 'synthetic-key', allowedModels: ['fixture'] };
  assert.throws(() => createInferenceGateway(options), /JEFF_INFERENCE_GATEWAY_CONFIG_INVALID/);
  for (const billingMode of ['', 'free', null, false]) assert.throws(() => createInferenceGateway({ ...options, billingMode }), /JEFF_INFERENCE_GATEWAY_CONFIG_INVALID/);
  assert.doesNotThrow(() => createInferenceGateway({ ...options, billingMode: 'operator-funded' }));
});

test('operator scopes models job IDs and capacity remain validated before issuing keys', async t => {
  const f = await fixture(t, { maxJobs: 1 });
  for (const scope of [undefined, { chainId: 4663, owner: nft.owner }, { ...nft, ownerEpoch: -1 }, { ...nft, tokenId: '035' }, { ...account, owner: '0x' + '00'.repeat(20) }]) {
    assert.throws(() => f.gateway.preflight({ scope, model: 'fixture' }), /JEFF_INFERENCE_SCOPE_INVALID/);
    assert.throws(() => f.gateway.issue({ jobId: 'invalid', scope, model: 'fixture' }), /JEFF_INFERENCE_SCOPE_INVALID/);
  }
  assert.throws(() => f.gateway.preflight({ scope: nft, model: 'other' }), /JEFF_INFERENCE_JOB_CONFIG_INVALID/);
  assert.throws(() => f.gateway.issue({ jobId: '../bad', scope: nft, model: 'fixture' }), /JEFF_INFERENCE_JOB_CONFIG_INVALID/);
  f.issue('only'); assert.throws(() => f.issue('only'), /JEFF_INFERENCE_JOB_CONFIG_INVALID/);
  assert.throws(() => f.issue('another'), /JEFF_INFERENCE_CAPACITY_REACHED/); assert.equal(f.calls(), 0);
});

test('operator request limits reject without forwarding and one successful call consumes the key budget', async t => {
  const f = await fixture(t), credential = f.issue('limits');
  for (const [body, status] of [[{ ...input(), model: 'other' }, 403], [{ ...input(), tools: [{ type: 'function' }] }, 403],
    [input('x'.repeat(513)), 429], [{ ...input(), max_tokens: 33 }, 429], [{ ...input(), max_tokens: 0 }, 429], ['malformed', 400]])
    assert.equal((await f.request(credential, body)).status, status);
  assert.equal((await f.request(credential, input(), { Origin: 'https://fixture.invalid' })).status, 403); assert.equal(f.calls(), 0);
  assert.equal((await f.request(credential, { ...input(), stream: true })).status, 200);
  assert.equal((await f.request(credential)).status, 429); assert.equal(f.calls(), 1);
});

test('operator revoked job drains without blocking another held job and old keys never remap', async t => {
  const entered = new Map(), waiting = new Map(), signals = new Map();
  const started = label => { if (!entered.has(label)) entered.set(label, deferred()); return entered.get(label).promise; };
  const f = await fixture(t, { fetchImpl: async (_url, init) => {
    const label = JSON.parse(init.body).messages[0].content, held = deferred(); waiting.set(label, held); signals.set(label, init.signal);
    const abort = () => held.reject(Error('SYNTHETIC_ABORT')); init.signal.addEventListener('abort', abort, { once: true });
    if (!entered.has(label)) entered.set(label, deferred()); entered.get(label).resolve();
    try { await held.promise; return new Response(JSON.stringify(output())); }
    finally { init.signal.removeEventListener('abort', abort); }
  } });
  const a = f.issue('A'), b = f.issue('B', account); assert.notEqual(a.apiKey, b.apiKey);
  const first = f.request(a, input('A')), second = f.request(b, { ...input('B'), stream: true });
  await bounded(Promise.all([started('A'), started('B')])); assert.equal(f.tracked.size, 2);
  f.gateway.revoke('A'); await bounded(f.gateway.drain('A')); assert.equal((await first).status, 503);
  assert.equal(f.gateway.status().activeRequests, 1); assert.equal(signals.get('B').aborted, false);
  f.gateway.revoke('A'); await f.gateway.drain('A'); assert.equal((await f.request(a)).status, 401);
  const c = f.issue('C'); assert.notEqual(c.apiKey, a.apiKey); assert.notEqual(c.apiKey, b.apiKey);
  let globalSettled = false; const global = f.gateway.drain().then(() => { globalSettled = true; }); await tick(); assert.equal(globalSettled, false);
  waiting.get('B').resolve(); const response = await second; assert.equal(response.status, 200); assert.match(await response.text(), /\[DONE\]/);
  await bounded(global); assert.equal(f.calls(), 2); assert.equal((await f.request(a)).status, 401);
});

test('operator expired and queued revoked credentials settle without forwarding', async t => {
  let now = 0; const f = await fixture(t, { now: () => now }), expired = f.issue('expired'); now = 180000;
  assert.equal((await f.request(expired)).status, 401); assert.equal(f.calls(), 0);
  const credential = f.issue('queued'); let request;
  const response = new Promise((resolveResponse, reject) => { request = httpRequest(credential.baseUrl + '/chat/completions', { method: 'POST',
    headers: { Authorization: 'Bearer ' + credential.apiKey, 'Content-Type': 'application/json' } }, incoming => { incoming.resume(); incoming.once('end', () => resolveResponse(incoming.statusCode)); });
    request.once('error', reject); request.write('{'); });
  try {
    await bounded((async () => { while (!f.gateway.status().activeRequests) await tick(); })());
    f.gateway.revoke('queued'); let settled = false; const drain = f.gateway.drain('queued').then(() => { settled = true; });
    await tick(); assert.equal(settled, false); request.end(JSON.stringify(input()).slice(1));
    assert.equal(await bounded(response), 401); await bounded(drain); assert.equal(f.calls(), 0);
  } finally { request.destroy(); }
});

for (const [name, mutate] of [
  ['missing usage', value => { delete value.usage; }], ['inconsistent totals', value => { value.usage.total_tokens++; }],
  ['excess input', value => { value.usage.prompt_tokens = 513; value.usage.total_tokens = 518; }],
  ['excess output', value => { value.usage.completion_tokens = 33; value.usage.total_tokens = 43; }],
  ['negative detail', value => { value.usage.prompt_tokens_details = { cached_tokens: -1 }; }],
  ['nonstring model', value => { value.model = 7; }], ['oversized model', value => { value.model = 'x'.repeat(121); }],
  ['bad choice', value => { value.choices = []; }],
]) test('operator validates measured usage without tariff: ' + name, async t => {
  const f = await fixture(t, { fetchImpl: async () => { const value = output(); mutate(value); return new Response(JSON.stringify(value)); } }), credential = f.issue('usage');
  const response = await f.request(credential); assert.equal(response.status, 503); assert.match((await response.json()).error.message, /JEFF_INFERENCE_USAGE_UNVERIFIED/);
  await f.gateway.drain('usage'); assert.equal((await f.request(credential)).status, 429); assert.equal(f.calls(), 1);
});

test('operator preserves bounded provider-prefixed and dated response model aliases without changing requested model', async t => {
  const aliases = ['openai/fixture-2026-10-11', 'openrouter/fixture'], forwarded = [];
  const f = await fixture(t, { fetchImpl: async (_url, init) => { const requested = JSON.parse(init.body); forwarded.push(requested.model);
    return new Response(JSON.stringify({ ...output(), model: aliases[forwarded.length - 1] })); } });
  for (const [index, alias] of aliases.entries()) {
    const credential = f.issue('alias-' + index), response = await f.request(credential);
    assert.equal(response.status, 200); assert.equal((await response.json()).model, alias);
    f.gateway.revoke('alias-' + index); await f.gateway.drain('alias-' + index);
  }
  assert.deepEqual(forwarded, ['fixture', 'fixture']); assert.equal(f.calls(), 2);
});

test('operator unknown provider outcomes remain bounded and cannot be retried with the same credential', async t => {
  const f = await fixture(t, { fetchImpl: async () => { throw Error('SYNTHETIC_UPSTREAM_UNAVAILABLE'); } }), credential = f.issue('unknown');
  const response = await f.request(credential); assert.equal(response.status, 503); assert.equal((await response.json()).error.message, 'JEFF_INFERENCE_PROVIDER_OUTCOME_UNKNOWN');
  await f.gateway.drain('unknown'); assert.equal((await f.request(credential)).status, 429); assert.equal(f.calls(), 1);
  f.gateway.revoke('unknown'); await f.gateway.drain('unknown'); assert.equal((await f.request(credential)).status, 401);
});
