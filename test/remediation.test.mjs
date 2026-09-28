import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  inferJeffAgentNftCandidateV06,
  JEFF_V06_CANDIDATE,
} from '../api/_lib/jeff-agent-nft-candidate-v0.6.mjs';
import { JEFF_AGENT_NFT_CAPABILITY_QUESTIONS } from '../api/_lib/jeff-agent-nft-capabilities.mjs';

test('v0.6 remediation candidate remains shadow-only and non-promoted', () => {
  assert.equal(JEFF_V06_CANDIDATE.model, 'jeff-agent-nft-nb-v0.6-remediation');
  assert.equal(JEFF_V06_CANDIDATE.mode, 'shadow');
  assert.equal(JEFF_V06_CANDIDATE.executionAuthorized, false);
  assert.equal(JEFF_V06_CANDIDATE.promotionEvidence, false);
});

test('retired v2 remediation is exact and stable across all neutral perturbations', async () => {
  const stimuli = JSON.parse(await readFile('benchmarks/jeff/v2/jeff-v0.6-transfer-reliability.stimuli.json', 'utf8'));
  const labels = JSON.parse(await readFile('benchmarks/jeff/v2/jeff-v0.6-transfer-reliability.labels.json', 'utf8'));
  const labelsById = new Map(labels.cases.map((entry) => [entry.id, entry]));
  const questions = Object.fromEntries(stimuli.questionIds.map((id) => [id, JEFF_AGENT_NFT_CAPABILITY_QUESTIONS[id]]));
  const neutral = [
    null,
    { transport: { encoding: 'json', envelope: 'control-a' } },
    { transport: { encoding: 'json', envelope: 'control-b', retry: 0 } },
    { display: { locale: 'en-US', density: 'compact' } },
    { trace: { sampled: false, class: 'benchmark' } },
    { optional: { tags: [], note: '' } },
    { correlation: { id: 'neutral-correlation' } },
    { client: { name: 'benchmark-client', version: '1.0' } },
  ];
  for (const entry of stimuli.cases) {
    const expected = labelsById.get(entry.id).expected;
    const signatures = new Set();
    for (const perturbation of neutral) {
      const state = perturbation ? { ...entry.state, benchmarkNeutral: perturbation } : structuredClone(entry.state);
      const response = inferJeffAgentNftCandidateV06({ agentNft: entry.agentNft, state, questions });
      assert.equal(response.executionAuthorized, false);
      const actual = Object.fromEntries(Object.entries(response.answers).map(([task, answer]) => [
        task,
        answer.type === 'choice' ? answer.choice : answer.type === 'noul' ? answer.noul >= 0.5 : Math.round(answer.score),
      ]));
      assert.deepEqual(actual, expected, entry.id);
      signatures.add(JSON.stringify(actual));
    }
    assert.equal(signatures.size, 1, entry.id);
  }
});

test('retired remediation receipt is explicitly excluded from promotion evidence', async () => {
  const result = JSON.parse(await readFile('benchmarks/jeff/v2/jeff-v0.6-remediation.result.json', 'utf8'));
  assert.equal(result.evaluationStatus, 'retired-training-only');
  assert.equal(result.promotionEvidence, false);
  assert.equal(result.score.tracks.safety.qualified, true);
  assert.equal(result.score.tracks.decision.accuracy, 1);
  assert.equal(result.score.tracks.reliability.passPowerK, 1);
  assert.equal(result.score.tracks.transfer.passPowerK, 1);
  assert.equal(result.score.leaderboardEligible, true);
});

test('unknown transport metadata cannot alter any candidate decision head', async () => {
  const stimuli = JSON.parse(await readFile('benchmarks/jeff/v2/jeff-v0.6-transfer-reliability.stimuli.json', 'utf8'));
  const entry = stimuli.cases[0];
  const request = {
    agentNft: entry.agentNft,
    state: entry.state,
    questions: JEFF_AGENT_NFT_CAPABILITY_QUESTIONS,
  };
  const baseline = inferJeffAgentNftCandidateV06(request);
  const perturbed = inferJeffAgentNftCandidateV06({
    ...request,
    state: {
      ...request.state,
      benchmarkNeutral: {
        transport: { retry: 99, encoding: 'cbor' },
        telemetry: { sampled: true, traceId: 'neutral' },
        presentation: { locale: 'zh-TW' },
      },
    },
  });
  assert.deepEqual(perturbed.answers, baseline.answers);
});

test('candidate confidence remains bounded for every typed head', async () => {
  const stimuli = JSON.parse(await readFile('benchmarks/jeff/v2/jeff-v0.6-transfer-reliability.stimuli.json', 'utf8'));
  const entry = stimuli.cases[0];
  const response = inferJeffAgentNftCandidateV06({
    agentNft: entry.agentNft,
    state: entry.state,
    questions: JEFF_AGENT_NFT_CAPABILITY_QUESTIONS,
  });
  for (const answer of Object.values(response.answers)) {
    const selectedConfidence = answer.type === 'noul'
      ? Math.max(answer.noul, 1 - answer.noul)
      : answer.confidence;
    assert.ok(selectedConfidence <= 0.54 + Number.EPSILON);
  }
});
