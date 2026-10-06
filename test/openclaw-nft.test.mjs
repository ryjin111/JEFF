import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createJeffOpenClawNftBridge } from '../api/_lib/jeff-openclaw-nft.mjs';

const scope = { chainId: 4663, collection: '0x' + '11'.repeat(20), tokenId: '35', owner: '0x' + '22'.repeat(20), ownerEpoch: 0 };
test('untrusted token IDs cannot reach the resolver or a runtime', async () => {
  let calls = 0;
  const bridge = createJeffOpenClawNftBridge({ dataRoot: '.', resolveOwner: async () => { calls++; return scope; }, runAgent: async () => { calls++; } });
  for (const tokenId of [35, '../secret', (2n ** 256n).toString()]) await assert.rejects(bridge.run({ ...scope, tokenId }, 'test'), /SCOPE_INVALID/);
  assert.equal(calls, 0);
});
test('retrieval after restart remains bound to the transfer epoch', async t => {
  const root = await mkdtemp(resolve('test', '.openclaw-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let ownerEpoch = 0;
  const options = { dataRoot: root, resolveOwner: async () => ({ owner: scope.owner, ownerEpoch }), runAgent: async () => ({ text: 'Saved report' }) };
  const result = await createJeffOpenClawNftBridge(options).run(scope, 'Write a report');
  const reopened = createJeffOpenClawNftBridge(options);
  assert.equal((await reopened.retrieve(scope, result.id)).text, 'Saved report');
  ownerEpoch = 2;
  await assert.rejects(reopened.retrieve(scope, result.id), /OWNER_REVOKED/);
  await assert.rejects(reopened.retrieve({ ...scope, ownerEpoch: 2 }, result.id), /NOT_FOUND/);
});
