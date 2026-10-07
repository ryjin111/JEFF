import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { scopeKey, validSession, jobIndex, validateRecord, validateNftDiscovery } from '../public/client.js';

const scope = { chainId: 4663, collection: '0x' + '33'.repeat(20), tokenId: '35', owner: '0x' + '11'.repeat(20), ownerEpoch: 0 };
const id = '12345678-1234-1234-1234-123456789abc';
const result = { schema: 'jeff-openclaw-job-v1', id, scope, status: 'completed', objective: 'Prepare a checklist',
  text: 'A useful result', textSha256: createHash('sha256').update('A useful result').digest('hex'), saved: true,
  finishedAt: '2026-10-06T14:00:00Z', externalActionsAuthorized: false };
test('only complete NFT lists bound to this wallet, chain and collection can drive login', () => {
  const config = { chainId: scope.chainId, collection: scope.collection };
  const inventory = { ...config, wallet: scope.owner, tokenIds: ['35', '999999999999999999999'], balance: 2, blockNumber: '81741824', complete: true };
  assert.equal(validateNftDiscovery(inventory, config, scope.owner), inventory);
  assert.equal(validateNftDiscovery({ ...inventory, tokenIds: [], balance: 0 }, config, scope.owner).balance, 0);
  for (const invalid of [{ chainId: 1 }, { collection: '0x' + '22'.repeat(20) }, { wallet: '0x' + '22'.repeat(20) },
    { tokenIds: ['35', '35'] }, { balance: 1 }, { tokenIds: ['35', 36] }, { tokenIds: ['35', '01'] },
    { tokenIds: ['35', String(2n ** 256n)] }, { blockNumber: 'unknown' }]) {
    assert.throws(() => validateNftDiscovery({ ...inventory, ...invalid }, config, scope.owner), /DISCOVERY_INVALID/);
  }
  assert.throws(() => validateNftDiscovery({ ...inventory, complete: false }, config, scope.owner), /DISCOVERY_UNAVAILABLE/);
});

test('saved-job browser index is isolated by NFT, holder and transfer epoch', () => {
  for (const changed of [{ tokenId: '36' }, { owner: '0x' + '22'.repeat(20) }, { ownerEpoch: 2 }, { chainId: 1 }]) {
    assert.notEqual(scopeKey({ ...scope, ...changed }), scopeKey(scope));
  }
  assert.deepEqual(jobIndex([id, id, '../private-result', null]), [id]);
});
test('cached session must match service binding and expiry', () => {
  const session = { token: 'aa'.repeat(32), scope, expiresAt: '2026-10-06T15:00:00Z' };
  const config = { chainId: scope.chainId, collection: scope.collection };
  assert.equal(validSession(session, config, Date.parse('2026-10-06T14:00:00Z')), true);
  assert.equal(validSession(session, config, Date.parse('2026-10-06T16:00:00Z')), false);
  assert.equal(validSession(session, { ...config, chainId: 1 }, 0), false);
});
test('result display rejects scope mismatch, tampering and unexpected job IDs', async () => {
  assert.deepEqual(await validateRecord(result, scope, id), result);
  await assert.rejects(validateRecord({ ...result, text: 'Tampered' }, scope, id), /RESULT_INVALID/);
  await assert.rejects(validateRecord(result, { ...scope, ownerEpoch: 2 }, id), /RESULT_INVALID/);
  await assert.rejects(validateRecord(result, scope, 'abcdefab-1234-1234-1234-123456789abc'), /RESULT_INVALID/);
  await assert.rejects(validateRecord({ ...result, externalActionsAuthorized: true }, scope, id), /RESULT_INVALID/);
});
test('unsaved completed output must not claim persistence', async () => {
  const unsaved = { ...result, status: 'completed_unsaved', saved: false };
  assert.deepEqual(await validateRecord(unsaved, scope, id), unsaved);
  await assert.rejects(validateRecord({ ...unsaved, saved: true }, scope, id), /RESULT_INVALID/);
  await assert.rejects(validateRecord({ ...result, saved: false }, scope, id), /RESULT_INVALID/);
});
test('standalone account sessions and results are separate from NFT holder workspaces', async () => {
  const account = { kind: 'account', chainId: scope.chainId, owner: scope.owner };
  assert.notEqual(scopeKey(account), scopeKey(scope));
  assert.notEqual(scopeKey(account), scopeKey({ ...account, owner: '0x' + '22'.repeat(20) }));
  const config = { chainId: scope.chainId, collection: scope.collection, standaloneAccounts: true };
  const session = { token: 'aa'.repeat(32), scope: account, expiresAt: '2026-10-06T15:00:00Z' };
  assert.equal(validSession(session, config, 0), true);
  assert.equal(validSession(session, { ...config, standaloneAccounts: false }, 0), false);
  const accountResult = { ...result, scope: account };
  assert.deepEqual(await validateRecord(accountResult, account, id), accountResult);
  await assert.rejects(validateRecord(result, account, id), /RESULT_INVALID/);
  await assert.rejects(validateRecord(accountResult, scope, id), /RESULT_INVALID/);
});
