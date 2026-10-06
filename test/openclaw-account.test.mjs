import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createJeffOpenClawAccountBridge, createJeffOpenClawNftBridge } from '../api/_lib/jeff-openclaw-nft.mjs';

test('account results survive restart and stay separate from other wallets and NFT workspaces', async t => {
  const dataRoot = await mkdtemp(resolve('test', '.account-'));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const scope = { kind: 'account', chainId: 4663, owner: '0x' + '22'.repeat(20) };
  let allowed = true;
  const options = { dataRoot, resolveAccount: async () => allowed,
    runAgent: async () => ({ text: 'Explicit account fixture.', model: 'fixture' }) };
  const result = await createJeffOpenClawAccountBridge(options).run(scope, 'Test account');
  assert.deepEqual((await createJeffOpenClawAccountBridge(options).retrieve(scope, result.id)).scope, scope);
  await assert.rejects(createJeffOpenClawAccountBridge(options).retrieve({ ...scope, owner: '0x' + '33'.repeat(20) }, result.id), /NOT_FOUND/);
  const nft = { chainId: 4663, collection: '0x' + '44'.repeat(20), tokenId: '35', owner: scope.owner, ownerEpoch: 0 };
  await assert.rejects(createJeffOpenClawNftBridge({ ...options, resolveOwner: async () => ({ owner: scope.owner, ownerEpoch: 0 }) }).retrieve(nft, result.id), /NOT_FOUND/);
  allowed = false;
  await assert.rejects(createJeffOpenClawAccountBridge(options).retrieve(scope, result.id), /ACCOUNT_DENIED/);
});
