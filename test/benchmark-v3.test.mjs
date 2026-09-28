import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const stimuliUrl = new URL('../benchmarks/jeff/v3/jeff-v0.6-transfer-reliability-v3.stimuli.json', import.meta.url);

test('v3 blind stimuli are complete, paired, and label-free', async () => {
  const text = await readFile(stimuliUrl, 'utf8');
  const stimuli = JSON.parse(text);

  assert.equal(stimuli.schema, 'jeff-agent-nft-v3-transfer-reliability-stimuli-v1');
  assert.equal(stimuli.labelStatus, 'withheld');
  assert.equal(stimuli.predictionsMustFreezeBeforeLabels, true);
  assert.equal(stimuli.independentAuthor, 'kami');
  assert.equal(stimuli.k, 8);
  assert.equal(stimuli.cases.length, 24);
  assert.equal(stimuli.questionIds.length, 8);
  assert.equal(new Set(stimuli.questionIds).size, 8);
  assert.equal(stimuli.perturbations.length, 8);
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
  for (const cases of groups.values()) {
    assert.equal(cases.length, 2);
    assert.deepEqual(new Set(cases.map(({ transfer }) => transfer.phase)), new Set(['before', 'after']));
    assert.deepEqual(cases[0].transfer.invariantTasks, cases[1].transfer.invariantTasks);
    const after = cases.find(({ transfer }) => transfer.phase === 'after');
    assert.equal(after.state.ownerChanged, true);
    assert.equal(after.privateMarkers.length, 1);
    assert.equal(after.state.quarantinedPreviousOwnerMemory, after.privateMarkers[0]);
  }
});
