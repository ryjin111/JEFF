import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const stimuliUrl = new URL('../benchmarks/jeff/v7/jeff-v0.9-long-horizon-v7.stimuli.json', import.meta.url);
const predictionsUrl = new URL('../benchmarks/jeff/v7/jeff-v0.9-long-horizon-v7.predictions.json', import.meta.url);
const labelsUrl = new URL('../benchmarks/jeff/v7/jeff-v0.9-long-horizon-v7.labels.json', import.meta.url);
const resultUrl = new URL('../benchmarks/jeff/v7/jeff-v0.9-long-horizon-v7.result.json', import.meta.url);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

test('v7 matches its private commitment and exposes complete label-free sequences', async () => {
  const text = await readFile(stimuliUrl, 'utf8');
  const stimuli = JSON.parse(text);
  assert.equal(sha256(text), 'c27282133785d3bd96fb79ee96569d103768406a32087527bf74ec75fb8d5a7d');
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

test('v7 release binds the frozen sequence predictions to the private labels and score', async () => {
  const predictionsText = await readFile(predictionsUrl, 'utf8');
  const labelsText = await readFile(labelsUrl, 'utf8');
  const resultText = await readFile(resultUrl, 'utf8');
  const predictions = JSON.parse(predictionsText);
  const labels = JSON.parse(labelsText);
  const result = JSON.parse(resultText);
  assert.equal(sha256(predictionsText), 'f39f95258524d1fc407bee9ad7dc7c0c608c63867ae9a2bcdb578693a4ffbb94');
  assert.equal(sha256(labelsText), '558f1a0b05a24457d6ef8120c331530cfa05bd7fbc8b0b0a1853fdf69cb176e3');
  assert.equal(sha256(resultText), 'b6ce4a6f701c4e175097491bd721b1b0fb3e57adcd17729a028427a53fec57cf');
  assert.equal(predictions.labelsAvailableAtFreeze, false);
  assert.equal(predictions.mode, 'shadow');
  assert.equal(predictions.executionAuthorized, false);
  const precommittedPayload = {
    schema: 'jeff-agent-nft-v7-long-horizon-label-payload-v1',
    version: labels.version,
    createdAt: labels.frozenAt,
    independentlyLabeled: labels.independentlyLabeled,
    labeler: labels.labeler,
    stimuliSha256: labels.stimuliSha256,
    sequences: labels.sequences,
  };
  assert.equal(
    sha256(`${JSON.stringify(precommittedPayload, null, 2)}\n`),
    '6c2bc5fd9119f63705e0979ec37bace156683ec6874157ee496e60adcba9721b',
  );
  assert.equal(labels.precommitReceiptSha256, '6a5f444456d52f64fefb8403640704d6b569eb8a961149861d36097a500a3388');
  assert.equal(result.predictionsSha256, sha256(predictionsText));
  assert.equal(result.labelsSha256, sha256(labelsText));
  assert.equal(result.promotion.qualified, true);
  assert.equal(result.score.tracks.decision.accuracy, 1);
  assert.equal(result.score.tracks.safety.violations, 0);
  assert.equal(result.score.tracks.safety.privacyLeaks, 0);
  assert.equal(result.score.tracks.safety.invalidResponses, 0);
  assert.equal(result.score.tracks.reliability.passPowerK, 1);
  assert.equal(result.score.tracks.sequenceReliability.retryInvarianceRate, 1);
  assert.equal(result.score.tracks.sequenceReliability.recoveryRate, 1);
});
