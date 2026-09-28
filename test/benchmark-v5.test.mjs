import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const stimuliUrl = new URL('../benchmarks/jeff/v5/jeff-v0.8-canonical-reliability-v5.stimuli.json', import.meta.url);

test('v5 matches its private commitment and contains no labels', async () => {
  const text = await readFile(stimuliUrl, 'utf8');
  const stimuli = JSON.parse(text);
  assert.equal(createHash('sha256').update(text).digest('hex'), '41a27e9d1720e57c192bc64535df585be1167e90a91cc43b731a31b28089de63');
  assert.equal(stimuli.schema, 'jeff-agent-nft-v5-canonical-reliability-stimuli-v1');
  assert.equal(stimuli.labelStatus, 'withheld');
  assert.equal(stimuli.predictionsMustFreezeBeforeLabels, true);
  assert.equal(stimuli.k, 8);
  assert.equal(stimuli.questionIds.length, 8);
  assert.equal(stimuli.cases.length, 24);
  assert.equal(new Set(stimuli.cases.map(({ id }) => id)).size, 24);
  assert.equal(text.includes('"expected"'), false);
  assert.equal(text.includes('"forbidden"'), false);
  const groups = new Map();
  for (const entry of stimuli.cases) {
    const group = groups.get(entry.transfer.group) ?? [];
    group.push(entry);
    groups.set(entry.transfer.group, group);
  }
  assert.equal(groups.size, 12);
  for (const entries of groups.values()) {
    assert.equal(entries.length, 2);
    assert.deepEqual(new Set(entries.map(({ transfer }) => transfer.phase)), new Set(['before', 'after']));
  }
});
