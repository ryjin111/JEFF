import {
  validateJeffAgentNftRequest,
  validateJeffAgentNftResponse,
} from './jeff-agent-nft-contract.mjs';
import { normalizeJeffAgentNftSafetyFactsV09 } from './jeff-agent-nft-candidate-v0.9.mjs';
import {
  containsJeffUnsafeText,
  hashJeffBrainValue,
} from './jeff-brain-common.mjs';

const SCHEMA = 'jeff-decision-assurance-v1';
const CRITICAL_CHOICE_HEADS = Object.freeze(['authority', 'next_action', 'risk', 'tool_mode']);
const CRITICAL_NOUL_HEADS = Object.freeze(['should_escalate', 'requires_simulation', 'owner_notification']);
const WRITE_INTENT = /\b(?:approve|bridge|buy|deploy|execute|grant|mint|publish|sell|send|sign|stake|submit|swap|trade|transfer|unstake|upgrade|withdraw|write)\b/i;
const EXPLICIT_NON_EXECUTION = /\b(?:do not|don't|never|without)\s+(?:approve|broadcast|buy|execute|publish|sell|send|sign|submit|swap|trade|transfer|withdraw)\b|\bno transaction\b/i;
const PERMISSION_MUTATION = /\b(?:admin|allowance|approval|controller|governor|operator|owner|ownership|permission|role|upgrade)\b/i;

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

function choice(response, task) {
  const answer = response.answers?.[task];
  return answer?.type === 'choice' ? answer.choice : null;
}

function choiceConfidence(response, task) {
  const answer = response.answers?.[task];
  if (answer?.type !== 'choice') return null;
  const selected = answer.probabilities[answer.choice];
  const alternatives = Object.entries(answer.probabilities)
    .filter(([label]) => label !== answer.choice)
    .map(([, probability]) => probability);
  return {
    confidence: answer.confidence,
    margin: answer.confidence - Math.max(0, ...alternatives),
    selected,
  };
}

function noulConfidence(response, task) {
  const answer = response.answers?.[task];
  if (answer?.type !== 'noul') return null;
  return {
    probabilityTrue: answer.noul,
    confidence: Math.max(answer.noul, 1 - answer.noul),
  };
}

function hasVerifiedEvidence(state, safetyFacts) {
  if (safetyFacts.canonicalEnvelopeComplete === true) {
    return safetyFacts.evidenceSufficient === true
      && safetyFacts.validationSafe === true
      && safetyFacts.identityIntegrity === 'trusted';
  }
  return state?.provenanceVerified === true
    && state?.dataFresh === true
    && Array.isArray(state?.evidence)
    && state.evidence.length > 0
    && state.evidence.every((entry) => entry && typeof entry === 'object' && entry.verified === true);
}

function addCoherenceFailures(response, writeIntent, blocking) {
  const authority = choice(response, 'authority');
  const nextAction = choice(response, 'next_action');
  const risk = choice(response, 'risk');
  const toolMode = choice(response, 'tool_mode');
  const shouldEscalate = response.answers?.should_escalate?.noul;
  const requiresSimulation = response.answers?.requires_simulation?.noul;

  if (authority === 'deny' && (nextAction !== 'abstain' || risk !== 'blocked' || toolMode !== 'none')) {
    blocking.add('deny_heads_inconsistent');
  }
  if (authority === 'autonomous' && (risk === 'high' || risk === 'blocked' || toolMode === 'prepare_write')) {
    blocking.add('autonomous_scope_inconsistent');
  }
  if (nextAction === 'propose_transaction' && authority !== 'owner_review') {
    blocking.add('transaction_authority_inconsistent');
  }
  if (nextAction === 'propose_transaction' && !['simulate', 'prepare_write'].includes(toolMode)) {
    blocking.add('transaction_tool_mode_inconsistent');
  }
  if (nextAction === 'propose_transaction' && requiresSimulation < 0.5) {
    blocking.add('transaction_simulation_inconsistent');
  }
  if (writeIntent && authority === 'autonomous') blocking.add('write_marked_autonomous');
  if (writeIntent && risk === 'low') blocking.add('write_risk_understated');
  if (writeIntent && shouldEscalate < 0.5) blocking.add('write_escalation_missing');
  if (PERMISSION_MUTATION.test(String(response.__proposal ?? '')) && authority === 'autonomous') {
    blocking.add('permission_change_marked_autonomous');
  }
}

export function assessJeffDecisionAssurance({
  request,
  response,
  minimumChoiceConfidence = 0.5,
  minimumChoiceMargin = 0.1,
  minimumNoulConfidence = 0.53,
} = {}) {
  if (!validateJeffAgentNftRequest(request)
    || !validateJeffAgentNftResponse(response, request)
    || !Number.isFinite(minimumChoiceConfidence)
    || minimumChoiceConfidence < 0.5
    || minimumChoiceConfidence > 1
    || !Number.isFinite(minimumChoiceMargin)
    || minimumChoiceMargin < 0
    || minimumChoiceMargin > 1
    || !Number.isFinite(minimumNoulConfidence)
    || minimumNoulConfidence < 0.5
    || minimumNoulConfidence > 1) {
    throw new Error('JEFF_DECISION_ASSURANCE_INPUT_INVALID');
  }

  const state = request.state ?? {};
  const proposal = typeof state.proposal === 'string' ? state.proposal : '';
  const writeIntent = WRITE_INTENT.test(proposal) && !EXPLICIT_NON_EXECUTION.test(proposal);
  const safetyFacts = normalizeJeffAgentNftSafetyFactsV09(state);
  const evidenceReady = hasVerifiedEvidence(state, safetyFacts);
  const blocking = new Set();
  const reviewing = new Set();
  const missingHeads = [];
  const uncertainHeads = [];
  const criticalConfidence = {};

  for (const task of CRITICAL_CHOICE_HEADS) {
    if (!Object.hasOwn(request.questions, task)) {
      missingHeads.push(task);
      continue;
    }
    const observed = choiceConfidence(response, task);
    criticalConfidence[task] = observed;
    if (!observed
      || observed.confidence < minimumChoiceConfidence
      || observed.margin < minimumChoiceMargin
      || Math.abs(observed.selected - observed.confidence) > 1e-9) uncertainHeads.push(task);
  }
  for (const task of CRITICAL_NOUL_HEADS) {
    if (!Object.hasOwn(request.questions, task)) {
      missingHeads.push(task);
      continue;
    }
    const observed = noulConfidence(response, task);
    criticalConfidence[task] = observed;
    if (!observed || observed.confidence < minimumNoulConfidence) uncertainHeads.push(task);
  }

  if (missingHeads.length) reviewing.add('critical_heads_missing');
  if (uncertainHeads.length) reviewing.add('critical_heads_uncertain');
  if (containsJeffUnsafeText(proposal)) blocking.add('unsafe_proposal_text');
  if (safetyFacts.requiresDeny) blocking.add('deterministic_safety_facts_failed');
  if (choice(response, 'authority') === 'deny'
    || choice(response, 'risk') === 'blocked'
    || choice(response, 'tool_mode') === 'none') blocking.add('decision_requires_block');

  const coherenceResponse = { ...response, __proposal: proposal };
  addCoherenceFailures(coherenceResponse, writeIntent, blocking);

  if (writeIntent) {
    reviewing.add('write_requires_owner_review');
    if (!evidenceReady) reviewing.add('write_evidence_incomplete');
  }
  if (choice(response, 'authority') === 'owner_review') reviewing.add('decision_requires_owner_review');

  const verdict = blocking.size ? 'block' : reviewing.size ? 'review' : 'pass';
  const confidenceReady = missingHeads.length === 0 && uncertainHeads.length === 0;
  const planningAllowed = verdict !== 'block' && confidenceReady && (!writeIntent || evidenceReady);
  const recommendedToolMode = verdict === 'block' ? 'none'
    : writeIntent ? planningAllowed ? 'simulate' : 'read_only'
      : choice(response, 'tool_mode') === 'simulate' ? 'simulate' : 'read_only';
  const body = {
    schema: SCHEMA,
    mode: 'shadow',
    executionAuthorized: false,
    verdict,
    planningAllowed,
    ownerReviewRequired: verdict !== 'pass' || choice(response, 'authority') === 'owner_review',
    recommendedToolMode,
    writeIntent,
    evidenceReady,
    confidencePolicy: {
      minimumChoiceConfidence,
      minimumChoiceMargin,
      minimumNoulConfidence,
    },
    criticalConfidence,
    missingHeads: [...missingHeads].sort(),
    uncertainHeads: [...uncertainHeads].sort(),
    blockingReasons: [...blocking].sort(),
    reviewReasons: [...reviewing].sort(),
    safetyFacts: {
      authorized: safetyFacts.authorized,
      funded: safetyFacts.funded,
      validTransition: safetyFacts.validTransition,
      evidenceSufficient: safetyFacts.evidenceSufficient,
      privacySafe: safetyFacts.privacySafe,
      validationSafe: safetyFacts.validationSafe,
      identityIntegrity: safetyFacts.identityIntegrity,
      canonicalEnvelopeComplete: safetyFacts.canonicalEnvelopeComplete,
    },
    requestSha256: hashJeffBrainValue(request),
    responseSha256: hashJeffBrainValue(response),
  };
  return deepFreeze({ ...body, assuranceSha256: hashJeffBrainValue(body) });
}

export function verifyJeffDecisionAssurance(assurance, request, response, options = {}) {
  if (!assurance || assurance.schema !== SCHEMA || assurance.executionAuthorized !== false) return false;
  try {
    const expected = assessJeffDecisionAssurance({ request, response, ...options });
    return hashJeffBrainValue(assurance) === hashJeffBrainValue(expected);
  } catch {
    return false;
  }
}

export const JEFF_DECISION_ASSURANCE = Object.freeze({
  schema: SCHEMA,
  mode: 'shadow',
  executionAuthorized: false,
  criticalChoiceHeads: CRITICAL_CHOICE_HEADS,
  criticalNoulHeads: CRITICAL_NOUL_HEADS,
});
