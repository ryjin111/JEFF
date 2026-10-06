import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { verifyHostedRuntime } from '../src/operator-smoke.mjs';

test('cached operator proof rereads durable output without another model call or changing the original timestamp', async t => {
  const root = await mkdtemp(resolve('test', '.operator-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  const options = { env: { JEFF_DATA_ROOT: root, JEFF_RELEASE_SHA: 'first-release' },
    resolveOwner: async () => ({ owner: '0x' + '22'.repeat(20), ownerEpoch: 0 }),
    runAgent: async () => { calls++; return { text: 'Explicit fixture output.', model: 'fixture' }; } };
  const first = await verifyHostedRuntime(options);
  const reopened = await verifyHostedRuntime({ ...options, env: { ...options.env, JEFF_RELEASE_SHA: 'next-release' } });
  assert.equal(calls, 1); assert.equal(reopened.jobId, first.jobId);
  assert.equal(reopened.observedAt, first.observedAt); assert.equal(reopened.releaseSha, 'first-release');
  assert.equal(reopened.persistenceReleaseSha, 'next-release');
  assert.equal(reopened.retrievedAfterProcessRestart, true); assert.equal(reopened.modelRerun, false);
  const file = resolve(root, 'operator-verification', 'hosted-proof.json');
  const proof = JSON.parse(await readFile(file, 'utf8'));
  await writeFile(file, JSON.stringify({ ...proof, textSha256: '0'.repeat(64) }));
  await assert.rejects(verifyHostedRuntime(options), /RETRIEVAL_FAILED/);
  assert.equal(calls, 1);
  await writeFile(file, JSON.stringify(proof));
  await assert.rejects(verifyHostedRuntime({ ...options, resolveOwner: async () => ({ owner: '0x' + '33'.repeat(20), ownerEpoch: 1 }) }), /OWNER|SCOPE/);
  assert.equal(calls, 1);
});
