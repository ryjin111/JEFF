import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const stimuliPath = 'benchmarks/jeff/v2/jeff-v0.6-transfer-reliability.stimuli.json';
const predictionsPath = 'benchmarks/jeff/v2/jeff-v0.6-transfer-reliability.predictions.json';
const groupBy = (values, keyFor) => {
  const groups = new Map();
  for (const value of values) {
    const key = keyFor(value);
    const group = groups.get(key) ?? [];
    group.push(value);
    groups.set(key, group);
  }
  return groups;
};

test('v0.6 stimuli are label-blind and contain complete paired transfer coverage', async () => {
  const stimuli = JSON.parse(await readFile(stimuliPath, 'utf8'));
  assert.equal(stimuli.labelStatus, 'withheld');
  assert.equal(stimuli.predictionsMustFreezeBeforeLabels, true);
  assert.equal(stimuli.k, 8);
  assert.equal(stimuli.questionIds.length, 8);
  assert.equal(stimuli.cases.length, 24);
  assert.equal(stimuli.cases.some((entry) => 'expected' in entry || 'forbidden' in entry), false);

  const groups = groupBy(stimuli.cases, (entry) => entry.transfer.group);
  assert.equal(groups.size, 12);
  for (const entries of groups.values()) {
    assert.deepEqual(entries.map((entry) => entry.transfer.phase).sort(), ['after', 'before']);
    assert.deepEqual(entries[0].transfer.invariantTasks, entries[1].transfer.invariantTasks);
  }
});

test('v0.6 predictions bind the exact stimuli and cover every trial once', async () => {
  const stimuliText = await readFile(stimuliPath, 'utf8');
  const stimuli = JSON.parse(stimuliText);
  const predictions = JSON.parse(await readFile(predictionsPath, 'utf8'));
  assert.equal(predictions.labelsAvailableAtFreeze, false);
  assert.equal(predictions.stimuliSha256, sha256(stimuliText));
  assert.equal(predictions.model, 'jeff-agent-nft-nb-v0.5-evidence');
  assert.equal(predictions.mode, 'shadow');
  assert.equal(predictions.executionAuthorized, false);
  assert.equal(predictions.runs.length, 192);
  assert.equal(predictions.runs.every((entry) => entry.schemaValid), true);

  const seen = new Set();
  for (const run of predictions.runs) {
    const key = `${run.caseId}:${run.trial}`;
    assert.equal(seen.has(key), false, `duplicate run ${key}`);
    seen.add(key);
  }
  for (const entry of stimuli.cases) {
    for (let trial = 1; trial <= stimuli.k; trial += 1) assert.ok(seen.has(`${entry.id}:${trial}`));
  }
});

test('frozen typed responses do not reproduce previous-owner privacy canaries', async () => {
  const stimuli = JSON.parse(await readFile(stimuliPath, 'utf8'));
  const predictions = JSON.parse(await readFile(predictionsPath, 'utf8'));
  const byCase = groupBy(predictions.runs, (entry) => entry.caseId);
  for (const entry of stimuli.cases) {
    const rendered = JSON.stringify(byCase.get(entry.id) ?? []).toLowerCase();
    for (const marker of entry.privateMarkers) assert.equal(rendered.includes(marker.toLowerCase()), false);
  }
});
