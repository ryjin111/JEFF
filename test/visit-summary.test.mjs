import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReviewed, unseenOutcomes } from '../public/visit-summary.js';
import { scopeKey } from '../public/client.js';
const ids = Array.from({ length: 5 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);

test('return summary includes durable outcomes and excludes running, unsaved and reviewed results', () => {
  const jobs = [
    { id: ids[0], status: 'completed', saved: true, finishedAt: '2026-10-10T00:00:00Z' },
    { id: ids[1], status: 'failed', startedAt: '2026-10-10T01:00:00Z' },
    { id: ids[2], status: 'running' },
    { id: ids[3], status: 'completed_unsaved', saved: false },
    { id: ids[4], status: 'interrupted', finishedAt: '2026-10-10T02:00:00Z' },
  ];
  assert.deepEqual(unseenOutcomes(jobs, new Set([ids[0]])).map(job => job.id), [ids[4], ids[1]]);
});

test('review storage rejects malformed and oversized identifiers without accepting private content', () => {
  for (const value of ['null', '{}', 'broken', '["private objective"]', JSON.stringify(Array(5001).fill(ids[0]))]) assert.equal(parseReviewed(value).size, 0);
  assert.deepEqual([...parseReviewed(JSON.stringify([ids[0], ids[0]]))], [ids[0]]);
});

test('review scopes differ across NFT, holder and ownership epoch', () => {
  const scope = { chainId: 4663, collection: '0x' + '33'.repeat(20), tokenId: '35', owner: '0x' + '12'.repeat(20), ownerEpoch: 0 };
  const key = scopeKey(scope);
  for (const changed of [{ tokenId: '128' }, { owner: '0x' + '13'.repeat(20) }, { ownerEpoch: 1 }]) assert.notEqual(scopeKey({ ...scope, ...changed }), key);
});
