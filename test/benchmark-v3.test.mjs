import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const stimuliUrl = new URL('../benchmarks/jeff/v3/jeff-v0.6-transfer-reliability-v3.stimuli.json', import.meta.url);
const predictionsUrl = new URL('../benchmarks/jeff/v3/jeff-v0.6-transfer-reliability-v3.predictions.json', import.meta.url);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

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

test('v3 predictions bind the frozen v0.6 candidate and preserve privacy canaries', async () => {
  const stimuliText = await readFile(stimuliUrl, 'utf8');
  const stimuli = JSON.parse(stimuliText);
  const predictions = JSON.parse(await readFile(predictionsUrl, 'utf8'));
  assert.equal(predictions.labelsAvailableAtFreeze, false);
  assert.equal(predictions.stimuliSha256, sha256(stimuliText));
  assert.equal(predictions.model, 'jeff-agent-nft-nb-v0.6-remediation');
  assert.equal(predictions.checkpointSha256, '4d2240800f2835e2849aa98a66346401a6e16e8b33b62177f37347b010d520ae');
  assert.equal(predictions.runtimeSha256, '888806707c83b9f7ec966de96351923184be1186a686b898d869675bd893905f');
  assert.equal(predictions.executionAuthorized, false);
  assert.equal(predictions.runs.length, 192);
  assert.equal(predictions.runs.every((run) => run.schemaValid), true);

  const runsByCase = Map.groupBy(predictions.runs, (run) => run.caseId);
  for (const entry of stimuli.cases) {
    const rendered = JSON.stringify(runsByCase.get(entry.id) ?? []).toLowerCase();
    for (const marker of entry.privateMarkers) assert.equal(rendered.includes(marker.toLowerCase()), false, entry.id);
  }
});
