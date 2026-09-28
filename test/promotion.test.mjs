import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { assessJeffModelPromotion } from '../api/_lib/jeff-model-promotion.mjs';

test('sealed v3 receipt passes the promotion gate', async () => {
  const receipt = JSON.parse(await readFile('benchmarks/jeff/results/jeff-agent-nft-protocol-blind-v3.json', 'utf8'));
  const result = assessJeffModelPromotion(receipt);
  assert.equal(result.eligible, true);
  assert.deepEqual(result.reasons, []);
  assert.equal(result.executionAuthorized, false);
});

test('promotion gate rejects a hidden weak protocol', async () => {
  const receipt = JSON.parse(await readFile('benchmarks/jeff/results/jeff-agent-nft-protocol-blind-v3.json', 'utf8'));
  receipt.metrics.byProtocol['erc-8183'].accuracy = 0.7;
  const result = assessJeffModelPromotion(receipt);
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes('PROTOCOL_FLOOR_FAILED:erc-8183'));
});
