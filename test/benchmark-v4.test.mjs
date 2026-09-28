import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const stimuliUrl = new URL('../benchmarks/jeff/v4/jeff-v0.7-transfer-reliability-v4.stimuli.json', import.meta.url);

test('v4 matches the private precommit and contains no labels', async () => {
  const text = await readFile(stimuliUrl, 'utf8');
  const stimuli = JSON.parse(text);

  assert.equal(createHash('sha256').update(text).digest('hex'), '4b1a5598c21c6127ade32c5760399f45408a1e2cb00a60c12a48d5d4f12f065e');
  assert.equal(stimuli.schema, 'jeff-agent-nft-v4-transfer-reliability-stimuli-v1');
  assert.equal(stimuli.labelStatus, 'withheld');
  assert.equal(stimuli.predictionsMustFreezeBeforeLabels, true);
  assert.equal(stimuli.independentAuthor, 'kami');
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
    const after = entries.find(({ transfer }) => transfer.phase === 'after');
    assert.equal(after.state.ownerChanged, true);
    assert.equal(after.privateMarkers.length, 1);
    assert.equal(after.privateMarkers[0], after.state.quarantinedPreviousOwnerMemory);
  }
});
