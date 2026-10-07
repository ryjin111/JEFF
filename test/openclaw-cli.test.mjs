import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createOpenClawRunner, OPENCLAW_RUNTIME_POLICY } from '../src/openclaw-runner.mjs';

test('installed OpenClaw executes with JEFF context and zero tools against an explicit fixture model', async t => {
  const root = await mkdtemp(resolve('test', '.cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const requests = [];
  const fixture = createServer(async (request, response) => {
    let raw = ''; for await (const part of request) raw += part;
    const input = JSON.parse(raw); requests.push(input);
    const payload = { id: 'fixture-completion', object: 'chat.completion', created: 1, model: 'fixture',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Fixture response. Not a real model proof.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } };
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(payload));
  });
  await new Promise(resolveReady => fixture.listen(0, '127.0.0.1', resolveReady));
  t.after(() => new Promise(resolveClosed => fixture.close(resolveClosed)));
  const diagnostics = [];
  const runner = createOpenClawRunner({ model: 'bankr/fixture', providerUrl: `http://127.0.0.1:${fixture.address().port}/v1`,
    env: { ...process.env, BANKR_LLM_API_KEY: 'fixture-key-not-a-real-credential' }, onDiagnostics: text => diagnostics.push(text) });
  let output;
  try { output = await runner({ scope: { chainId: 4663, collection: '0x' + '33'.repeat(20), tokenId: '35', ownerEpoch: 0 },
    objective: 'Summarize this test input.', workspace: resolve(root, 'workspace'), stateRoot: root,
    jobId: '12345678-1234-1234-1234-123456789abc' }); }
  catch (error) { throw new Error(`${error.message}: ${diagnostics.join('\n')}`); }
  assert.equal(output.text, 'Fixture response. Not a real model proof.');
  assert.equal(requests.length > 0, true);
  assert.deepEqual(OPENCLAW_RUNTIME_POLICY, { contextTokens: 16384, maxOutputTokens: 4096 });
  const contextBytes = [], outputCaps = [];
  for (const request of requests) {
    assert.equal(request.tools?.length ?? 0, 0);
    const context = JSON.stringify(request.messages);
    const bytes = Buffer.byteLength(context, 'utf8');
    contextBytes.push(bytes);
    assert.ok(bytes <= OPENCLAW_RUNTIME_POLICY.contextTokens * 4, 'fixture message JSON exceeds the conservative byte bound');
    const caps = Object.fromEntries(['max_tokens', 'max_completion_tokens']
      .filter(field => request[field] !== undefined).map(field => [field, request[field]]));
    assert.ok(Object.keys(caps).length > 0, 'provider request must include an output token cap');
    for (const cap of Object.values(caps)) {
      assert.ok(Number.isSafeInteger(cap) && cap > 0 && cap <= OPENCLAW_RUNTIME_POLICY.maxOutputTokens,
        'provider output token cap must be a positive integer within runtime policy');
    }
    outputCaps.push(caps);
    assert.match(context, /JEFF/);
    assert.match(context, /No implicit authority/);
    assert.match(context, /owner epoch 0/);
  }
  t.diagnostic(JSON.stringify({ fixtureCalls: requests.length, messageJsonBytes: contextBytes, outputCaps }));
  const config = await readFile(resolve(root, 'openclaw.json'), 'utf8');
  assert.equal(config.includes('fixture-key-not-a-real-credential'), false);
  const parsed = JSON.parse(config);
  const model = parsed.models.providers.bankr.models[0];
  assert.equal(model.contextWindow, 128000);
  assert.equal(model.contextTokens, OPENCLAW_RUNTIME_POLICY.contextTokens);
  assert.equal(model.maxTokens, OPENCLAW_RUNTIME_POLICY.maxOutputTokens);
  assert.equal(parsed.tools.profile, 'minimal');
  assert.deepEqual(parsed.tools.deny, ['*']);
});
