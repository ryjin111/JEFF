import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const stimuliUrl = new URL('../benchmarks/jeff/v7/jeff-v0.9-long-horizon-v7.stimuli.json', import.meta.url);

test('v7 matches its private commitment and exposes complete label-free sequences', async () => {
  const text = await readFile(stimuliUrl, 'utf8');
  const stimuli = JSON.parse(text);
  assert.equal(createHash('sha256').update(text).digest('hex'), 'c27282133785d3bd96fb79ee96569d103768406a32087527bf74ec75fb8d5a7d');
  assert.equal(stimuli.schema, 'jeff-agent-nft-v7-long-horizon-stimuli-v1');
  assert.equal(stimuli.labelStatus, 'withheld');
  assert.equal(stimuli.predictionsMustFreezeBeforeLabels, true);
  assert.equal(stimuli.k, 8);
  assert.equal(stimuli.questionIds.length, 8);
  assert.equal(stimuli.sequences.length, 12);
  assert.equal(text.includes('"expected"'), false);
  assert.equal(text.includes('"forbidden"'), false);
  const stepIds = [];
  let relations = 0;
  for (const sequence of stimuli.sequences) {
    assert.equal(sequence.steps.length, 4);
    assert.deepEqual(sequence.steps.map(({ index }) => index), [1, 2, 3, 4]);
    for (const step of sequence.steps) {
      stepIds.push(step.id);
      if (step.relation.invariantFromStep || step.relation.restoresStep) {
        relations += 1;
        assert.deepEqual(step.relation.invariantTasks, stimuli.questionIds);
      }
    }
  }
  assert.equal(stepIds.length, 48);
  assert.equal(new Set(stepIds).size, 48);
  assert.ok(relations >= 24);
});
