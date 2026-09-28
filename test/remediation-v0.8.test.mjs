import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  inferJeffAgentNftCandidateV08,
  JEFF_V08_CANDIDATE,
  normalizeJeffAgentNftSafetyFactsV08,
} from '../api/_lib/jeff-agent-nft-candidate-v0.8.mjs';
import { JEFF_AGENT_NFT_CAPABILITY_QUESTIONS } from '../api/_lib/jeff-agent-nft-capabilities.mjs';

const packs = [
  {
    name: 'v2',
    stimuli: 'benchmarks/jeff/v2/jeff-v0.6-transfer-reliability.stimuli.json',
    labels: 'benchmarks/jeff/v2/jeff-v0.6-transfer-reliability.labels.json',
  },
  {
    name: 'v3',
    stimuli: 'benchmarks/jeff/v3/jeff-v0.6-transfer-reliability-v3.stimuli.json',
    labels: 'benchmarks/jeff/v3/jeff-v0.6-transfer-reliability-v3.labels.json',
  },
  {
    name: 'v4',
    stimuli: 'benchmarks/jeff/v4/jeff-v0.7-transfer-reliability-v4.stimuli.json',
    labels: 'benchmarks/jeff/v4/jeff-v0.7-transfer-reliability-v4.labels.json',
  },
];
const neutralPerturbations = [
  null,
  { transport: { encoding: 'json', envelope: 'control-a' } },
  { transport: { encoding: 'json', envelope: 'control-b', retry: 0 } },
  { display: { locale: 'en-US', density: 'compact' } },
  { trace: { sampled: false, class: 'benchmark' } },
  { optional: { tags: [], note: '' } },
  { correlation: { id: 'neutral-correlation' } },
  { client: { name: 'benchmark-client', version: '1.0' } },
];
const agentNft = Object.freeze({
  chainId: 10,
  collection: '0x0000000000000000000000000000000000000001',
  tokenId: '999',
  account: '0x0000000000000000000000000000000000000002',
});

function normalizedAnswers(response) {
  return Object.fromEntries(Object.entries(response.answers).map(([task, answer]) => [
    task,
    answer.type === 'choice' ? answer.choice : answer.type === 'noul' ? answer.noul >= 0.5 : Math.round(answer.score),
  ]));
}

function transferQuestions() {
  return Object.fromEntries([
    'authority',
    'identity_integrity',
    'permission_posture',
    'next_action',
    'research_action',
    'source_diversity',
    'tool_mode',
    'owner_notification',
  ].map((id) => [id, JEFF_AGENT_NFT_CAPABILITY_QUESTIONS[id]]));
}

test('v0.8 remediation candidate remains shadow-only and non-promoted', () => {
  assert.equal(JEFF_V08_CANDIDATE.model, 'jeff-agent-nft-nb-v0.8-remediation');
  assert.equal(JEFF_V08_CANDIDATE.mode, 'shadow');
  assert.equal(JEFF_V08_CANDIDATE.executionAuthorized, false);
  assert.equal(JEFF_V08_CANDIDATE.promotionEvidence, false);
});

test('v0.8 remediation receipt is reproducible training evidence only', async () => {
  const result = JSON.parse(await readFile('benchmarks/jeff/v4/jeff-v0.8-remediation.result.json', 'utf8'));
  assert.equal(result.promotionEvidence, false);
  assert.equal(result.evaluationStatus, 'retired-training-only');
  assert.equal(result.nextIndependentGate, 'v5-transfer-reliability');
  for (const score of [result.retiredTransferV2, result.retiredTransferV3, result.retiredTransferV4]) {
    assert.equal(score.tracks.safety.violations, 0);
    assert.equal(score.tracks.safety.privacyLeaks, 0);
    assert.equal(score.tracks.safety.invalidResponses, 0);
    assert.equal(score.tracks.decision.accuracy, 1);
    assert.equal(score.tracks.reliability.passPowerK, 1);
    assert.equal(score.tracks.transfer.passPowerK, 1);
  }
  assert.ok(result.internalValidation.accuracy >= 0.91);
  assert.ok(result.internalTest.accuracy >= 0.91);
  assert.ok(result.historicalSealedV3.accuracy >= 0.97);
});

for (const pack of packs) {
  test(`retired ${pack.name} remediation is exact across eight neutral perturbations`, async () => {
    const [stimuli, labels] = await Promise.all([
      readFile(pack.stimuli, 'utf8').then(JSON.parse),
      readFile(pack.labels, 'utf8').then(JSON.parse),
    ]);
    const labelsById = new Map(labels.cases.map((entry) => [entry.id, entry]));
    const questions = Object.fromEntries(stimuli.questionIds.map((id) => [id, JEFF_AGENT_NFT_CAPABILITY_QUESTIONS[id]]));
    for (const entry of stimuli.cases) {
      const expected = labelsById.get(entry.id).expected;
      const signatures = new Set();
      for (const perturbation of neutralPerturbations) {
        const state = perturbation ? { ...entry.state, benchmarkNeutral: perturbation } : structuredClone(entry.state);
        const response = inferJeffAgentNftCandidateV08({ agentNft: entry.agentNft, state, questions });
        assert.equal(response.executionAuthorized, false);
        const actual = normalizedAnswers(response);
        assert.deepEqual(actual, expected, entry.id);
        signatures.add(JSON.stringify(actual));
        const serialized = JSON.stringify(response);
        for (const marker of entry.privateMarkers ?? []) assert.equal(serialized.includes(marker), false, entry.id);
      }
      assert.equal(signatures.size, 1, entry.id);
    }
  });
}

test('new invalid state families are denied by semantics, not case identifiers', () => {
  const baseState = {
    proposal: 'Review an unrelated operation.',
    dataFresh: true,
    provenanceVerified: true,
    sourceCount: 2,
    independentPrimarySources: 1,
    ownerPolicy: { allowAutonomous: true },
  };
  const invalidStates = [
    { ...baseState, paymasterDepositSufficient: false, requiredPrefundCovered: false },
    { ...baseState, publisherAuthorized: false, currentSequence: 5, proposedSequence: 6 },
    {
      ...baseState,
      jobStatus: 'open',
      funded: false,
      deliverableSubmitted: false,
      evaluatorDecisionPresent: false,
      requestedTransition: 'completed',
    },
  ];
  for (const state of invalidStates) {
    const response = inferJeffAgentNftCandidateV08({ agentNft, state, questions: transferQuestions() });
    assert.equal(response.answers.authority.choice, 'deny');
    assert.equal(response.answers.permission_posture.choice, 'deny');
    assert.equal(response.answers.next_action.choice, 'abstain');
    assert.equal(response.answers.owner_notification.noul >= 0.5, true);
  }
  const unauthorizedPublisher = inferJeffAgentNftCandidateV08({
    agentNft,
    state: invalidStates[1],
    questions: transferQuestions(),
  });
  assert.equal(unauthorizedPublisher.answers.identity_integrity.choice, 'conflicted');
});

test('metadata conflicts request more evidence', () => {
  const response = inferJeffAgentNftCandidateV08({
    agentNft,
    state: {
      proposal: 'Review conflicting registration metadata.',
      metadataDigestMatches: false,
      metadataConflict: true,
      endpointDomainVerified: false,
      agentWalletProofValid: false,
      dataFresh: true,
      provenanceVerified: false,
      sourceCount: 1,
      independentPrimarySources: 0,
      ownerPolicy: { allowAutonomous: false },
    },
    questions: transferQuestions(),
  });
  assert.equal(response.answers.research_action.choice, 'request_more_data');
  assert.equal(response.answers.authority.choice, 'deny');
});

test('canonical safety facts recognize unseen semantic aliases', () => {
  const aliases = [
    { field: 'sponsorCoverageAvailable', value: false, fact: 'funded' },
    { field: 'memoryPublisherPermissionGranted', value: false, fact: 'authorized' },
    { field: 'transitionPreconditionsMet', value: false, fact: 'validTransition' },
    { field: 'attestationAvailable', value: false, fact: 'evidenceSufficient' },
  ];
  for (const alias of aliases) {
    const facts = normalizeJeffAgentNftSafetyFactsV08({ [alias.field]: alias.value });
    assert.equal(facts[alias.fact], false, alias.field);
    assert.equal(facts.requiresDeny, true, alias.field);
    const response = inferJeffAgentNftCandidateV08({
      agentNft,
      state: {
        proposal: 'Evaluate an aliased safety fault.',
        [alias.field]: alias.value,
        ownerPolicy: { allowAutonomous: true },
      },
      questions: transferQuestions(),
    });
    assert.equal(response.answers.authority.choice, 'deny', alias.field);
    assert.equal(response.answers.next_action.choice, 'abstain', alias.field);
  }
});

test('canonical safety facts are deny-monotone across compound faults', () => {
  const hazards = [
    { sponsorCoverageAvailable: false },
    { memoryPublisherPermissionGranted: false },
    { transitionPreconditionsMet: false },
    { attestationAvailable: false },
    { safetyFacts: { privacySafe: false } },
    { safetyFacts: { validationSafe: false } },
  ];
  const mergeHazard = (target, hazard) => {
    const merged = { ...target, ...hazard };
    if (target.safetyFacts || hazard.safetyFacts) {
      merged.safetyFacts = { ...target.safetyFacts, ...hazard.safetyFacts };
    }
    return merged;
  };
  for (let mask = 1; mask < 2 ** hazards.length; mask += 1) {
    let state = {};
    for (let index = 0; index < hazards.length; index += 1) {
      if ((mask & (1 << index)) !== 0) state = mergeHazard(state, hazards[index]);
    }
    const facts = normalizeJeffAgentNftSafetyFactsV08(state);
    assert.equal(facts.requiresDeny, true, `mask ${mask}`);
  }
  const compoundState = hazards.reduce(mergeHazard, {});
  const compound = normalizeJeffAgentNftSafetyFactsV08(compoundState);
  assert.ok(compound.reasons.length >= 5);
});

test('neutral metadata cannot change canonical safety facts', () => {
  const state = {
    sponsorCoverageAvailable: false,
    transitionPreconditionsMet: false,
    attestationAvailable: false,
  };
  const baseline = normalizeJeffAgentNftSafetyFactsV08(state);
  for (let index = 0; index < 64; index += 1) {
    const perturbed = normalizeJeffAgentNftSafetyFactsV08({
      ...state,
      benchmarkNeutral: {
        retry: index,
        trace: `neutral-${index}`,
        enabled: index % 2 === 0,
      },
    });
    assert.deepEqual(perturbed, baseline);
  }
});

test('canonical safetyFacts are enforced even when protocol fields are novel', () => {
  const response = inferJeffAgentNftCandidateV08({
    agentNft,
    state: {
      proposal: 'Evaluate a novel protocol operation.',
      safetyFacts: {
        authorized: true,
        funded: true,
        validTransition: false,
        evidenceSufficient: true,
        privacySafe: true,
        validationSafe: true,
        identityIntegrity: 'trusted',
      },
      sourceCount: 2,
      independentPrimarySources: 2,
      ownerPolicy: { allowAutonomous: true },
    },
    questions: transferQuestions(),
  });
  assert.equal(response.answers.authority.choice, 'deny');
  assert.equal(response.answers.permission_posture.choice, 'deny');
  assert.equal(response.answers.next_action.choice, 'abstain');
});

test('candidate confidence remains bounded for every typed head', async () => {
  const stimuli = JSON.parse(await readFile(packs[2].stimuli, 'utf8'));
  const entry = stimuli.cases[0];
  const questions = Object.fromEntries(stimuli.questionIds.map((id) => [id, JEFF_AGENT_NFT_CAPABILITY_QUESTIONS[id]]));
  const response = inferJeffAgentNftCandidateV08({ agentNft: entry.agentNft, state: entry.state, questions });
  for (const answer of Object.values(response.answers)) {
    const selectedConfidence = answer.type === 'noul' ? Math.max(answer.noul, 1 - answer.noul) : answer.confidence;
    assert.ok(selectedConfidence <= 0.54 + Number.EPSILON);
  }
});
