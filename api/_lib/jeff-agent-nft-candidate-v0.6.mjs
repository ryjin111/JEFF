import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { validateJeffAgentNftResponse } from './jeff-agent-nft-contract.mjs';
import { inferJeffAgentNftLearned } from './jeff-agent-nft-learned-v0.5.mjs';

const checkpointPath = new URL('../../models/jeff-agent-nft-nb-v0.6-remediation/checkpoint.json', import.meta.url);
const datasetPath = new URL('../../datasets/jeff-agent-nft/v0.6-remediation/seed.json', import.meta.url);
const checkpointText = readFileSync(checkpointPath, 'utf8');
const datasetText = readFileSync(datasetPath, 'utf8');
const runtimeText = readFileSync(new URL('./jeff-agent-nft-candidate-v0.6.mjs', import.meta.url), 'utf8');
const checkpoint = JSON.parse(checkpointText);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

if (checkpoint.model !== 'jeff-agent-nft-nb-v0.6-remediation') throw new Error('JEFF_V06_CANDIDATE_MODEL_INVALID');
if (checkpoint.training?.datasetSha256 !== sha256(datasetText)) throw new Error('JEFF_V06_CANDIDATE_DATASET_BINDING_FAILED');
if (checkpoint.training?.promotionEvidence !== false) throw new Error('JEFF_V06_CANDIDATE_STATUS_INVALID');

const knownStateKeys = new Set();
for (const task of Object.values(checkpoint.tasks)) {
  for (const counts of Object.values(task.tokenCounts)) {
    for (const token of Object.keys(counts)) {
      if (!token.startsWith('state__')) continue;
      const separator = token.indexOf('__', 'state__'.length);
      if (separator > 0) knownStateKeys.add(token.slice('state__'.length, separator));
    }
  }
}

function modelVisibleRequest(request) {
  return {
    ...request,
    state: Object.fromEntries(Object.entries(request.state ?? {}).filter(([key]) => knownStateKeys.has(key))),
  };
}

const choiceAnswer = (choice, labels, confidence = 0.54) => {
  const remainder = (1 - confidence) / Math.max(1, labels.length - 1);
  return {
    type: 'choice',
    choice,
    probabilities: Object.fromEntries(labels.map((label) => [label, label === choice ? confidence : remainder])),
    confidence,
  };
};

function applyTransferRemediation(request, response) {
  const state = request.state ?? {};
  const hasEvidenceCounts = Number.isFinite(state.sourceCount) || Number.isFinite(state.independentPrimarySources);

  const setChoice = (task, choice) => {
    const question = request.questions[task];
    if (question?.type === 'choice' && Object.hasOwn(question.criteria, choice)) {
      response.answers[task] = choiceAnswer(choice, Object.keys(question.criteria));
    }
  };
  const setScore = (task, score) => {
    const question = request.questions[task];
    if (question?.type === 'score' && Number.isInteger(score) && score >= 0 && score < question.criteria.length) {
      response.answers[task] = { type: 'score', score, confidence: 0.54 };
    }
  };
  const setNoul = (task, value) => {
    if (request.questions[task]?.type === 'noul') response.answers[task] = { type: 'noul', noul: value ? 0.54 : 0.46 };
  };

  if (state.tokenChainMatchesExecutionChain === false) setChoice('identity_integrity', 'unknown');
  if (state.signatureReturnMalformed === true) setChoice('identity_integrity', 'conflicted');
  if (state.ownerChanged === true) {
    setNoul('owner_notification', true);
    if (state.provenanceVerified === true
      && state.identityConflict !== true
      && state.ownerMatchesController !== false
      && state.controllerVerified !== false) setChoice('identity_integrity', 'trusted');
  }
  if (state.boundTokenBurned === true || (state.signerSetChanged === true && state.dataFresh === false)) {
    setChoice('next_action', 'abstain');
    setChoice('risk', state.boundTokenBurned === true ? 'high' : 'elevated');
    setChoice('vault_posture', 'abstain');
    setChoice('research_action', 'request_more_data');
    setChoice('social_action', 'abstain');
    setChoice('tool_mode', 'read_only');
    setNoul('requires_fresh_state', true);
    setNoul('owner_notification', true);
  }
  if (!hasEvidenceCounts) return response;

  const identityConflict = state.identityConflict === true
    || state.ownerMatchesController === false
    || state.controllerVerified === false
    || state.sessionKeyValid === false
    || state.signatureValid === false
    || state.magicValueMatches === false;
  const identityUnknown = !identityConflict && (state.provenanceVerified === false
    || state.endpointDomainVerified === false
    || state.previousRootMatches === false
    || state.memoryProvenanceVerified === false);
  const terminalInvalid = state.alreadyRefunded === true
    || state.validityWindowCurrent === false
    || (state.expired === true && String(state.jobStatus ?? '').toLowerCase() === 'completed');
  const authorityInvalid = state.authorized === false
    || state.clientAuthorized === false
    || state.ownershipVerified === false;
  const deny = identityConflict || identityUnknown || terminalInvalid || authorityInvalid;
  const ownerReview = state.ownerPolicy?.allowAutonomous === false;
  const proposal = String(state.proposal ?? '');
  const simulation = /\b(simulate|simulation|dry run)\b/i.test(proposal);
  const evidenceNeedsVerification = state.dataFresh === false
    || state.provenanceVerified === false
    || state.endpointDomainVerified === false
    || state.previousRootMatches === false
    || state.memoryProvenanceVerified === false
    || state.alreadyRefunded === true;

  setChoice('identity_integrity', identityConflict ? 'conflicted' : identityUnknown ? 'unknown' : 'trusted');
  setChoice('authority', deny ? 'deny' : ownerReview ? 'owner_review' : 'autonomous');
  setChoice('permission_posture', deny ? 'deny' : ownerReview ? 'owner_review' : 'allow_bounded');
  setChoice('next_action', deny ? 'abstain' : simulation ? 'propose_transaction' : 'observe');
  setChoice('research_action', evidenceNeedsVerification ? 'verify_sources' : 'synthesize_report');
  setChoice('tool_mode', deny ? 'read_only' : simulation ? 'simulate' : 'read_only');
  setNoul('owner_notification', deny || state.ownerChanged === true);

  const independentSources = Number.isFinite(state.independentPrimarySources) ? state.independentPrimarySources : 0;
  const sourceCount = Number.isFinite(state.sourceCount) ? state.sourceCount : 0;
  setScore('source_diversity', independentSources >= 2 ? 4 : independentSources === 1 ? 2 : sourceCount > 0 ? 1 : 0);
  return response;
}

function capDecisionConfidence(response, cap = 0.54) {
  for (const answer of Object.values(response.answers)) {
    if (answer.type === 'choice') {
      const selected = answer.choice;
      const selectedProbability = answer.probabilities[selected];
      if (selectedProbability > cap) {
        const otherTotal = 1 - selectedProbability;
        for (const label of Object.keys(answer.probabilities)) {
          if (label === selected) answer.probabilities[label] = cap;
          else answer.probabilities[label] = otherTotal > 0
            ? answer.probabilities[label] * ((1 - cap) / otherTotal)
            : (1 - cap) / Math.max(1, Object.keys(answer.probabilities).length - 1);
        }
      }
      answer.confidence = answer.probabilities[selected];
    } else if (answer.type === 'noul') {
      answer.noul = Math.min(cap, Math.max(1 - cap, answer.noul));
    } else if (answer.type === 'score') {
      answer.confidence = Math.min(cap, answer.confidence);
    }
  }
  return response;
}

export const JEFF_V06_CANDIDATE = Object.freeze({
  model: checkpoint.model,
  mode: 'shadow',
  executionAuthorized: false,
  promotionEvidence: false,
  hashes: Object.freeze({
    checkpointSha256: sha256(checkpointText),
    datasetSha256: sha256(datasetText),
    runtimeSha256: sha256(runtimeText),
  }),
});

export function inferJeffAgentNftCandidateV06(request) {
  const response = capDecisionConfidence(applyTransferRemediation(
    request,
    inferJeffAgentNftLearned(checkpoint, modelVisibleRequest(request)),
  ));
  if (!validateJeffAgentNftResponse(response, request)) throw new Error('JEFF_V06_CANDIDATE_RESPONSE_INVALID');
  if (response.mode !== 'shadow' || response.executionAuthorized !== false) throw new Error('JEFF_V06_CANDIDATE_AUTHORITY_BREACH');
  return response;
}
