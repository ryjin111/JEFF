import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { validateJeffAgentNftResponse } from './jeff-agent-nft-contract.mjs';
import { inferJeffAgentNftLearned } from './jeff-agent-nft-learned-v0.5.mjs';

const checkpointPath = new URL('../../models/jeff-agent-nft-nb-v0.9-remediation/checkpoint.json', import.meta.url);
const datasetPath = new URL('../../datasets/jeff-agent-nft/v0.9-remediation/seed.json', import.meta.url);
const checkpointText = readFileSync(checkpointPath, 'utf8');
const datasetText = readFileSync(datasetPath, 'utf8');
const runtimeText = readFileSync(new URL('./jeff-agent-nft-candidate-v0.9.mjs', import.meta.url), 'utf8');
const checkpoint = JSON.parse(checkpointText);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

if (checkpoint.model !== 'jeff-agent-nft-nb-v0.9-remediation') throw new Error('JEFF_V09_CANDIDATE_MODEL_INVALID');
if (checkpoint.training?.datasetSha256 !== sha256(datasetText)) throw new Error('JEFF_V09_CANDIDATE_DATASET_BINDING_FAILED');
if (checkpoint.training?.promotionEvidence !== false) throw new Error('JEFF_V09_CANDIDATE_STATUS_INVALID');

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

const normalizedKey = (key) => key
  .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
  .replace(/[^a-zA-Z0-9]+/g, '_')
  .toLowerCase();

const CANONICAL_FACTS = Object.freeze([
  ['authorized', 'authorized', (value) => typeof value === 'boolean'],
  ['funded', 'funded', (value) => typeof value === 'boolean'],
  ['validTransition', 'valid_transition', (value) => typeof value === 'boolean'],
  ['evidenceSufficient', 'evidence_sufficient', (value) => typeof value === 'boolean'],
  ['privacySafe', 'privacy_safe', (value) => typeof value === 'boolean'],
  ['validationSafe', 'validation_safe', (value) => typeof value === 'boolean'],
  ['identityIntegrity', 'identity_integrity', (value) => ['trusted', 'unknown', 'conflicted'].includes(value)],
]);

function canonicalEnvelope(state) {
  const hasCamel = Object.hasOwn(state, 'safetyFacts');
  const hasSnake = Object.hasOwn(state, 'safety_facts');
  const hasCompletenessDeclaration = Object.hasOwn(state, 'requiredSafetyFactsComplete')
    || Object.hasOwn(state, 'required_safety_facts_complete');
  const supplied = state.safetyFacts && typeof state.safetyFacts === 'object' && !Array.isArray(state.safetyFacts)
    ? state.safetyFacts
    : state.safety_facts && typeof state.safety_facts === 'object' && !Array.isArray(state.safety_facts)
      ? state.safety_facts
      : null;
  const read = (camel, snake) => supplied?.[camel] ?? supplied?.[snake];
  const present = hasCamel || hasSnake || hasCompletenessDeclaration;
  const complete = supplied !== null
    && !(hasCamel && hasSnake)
    && CANONICAL_FACTS.every(([camel, snake, valid]) => valid(read(camel, snake)))
    && state.requiredSafetyFactsComplete !== false
    && state.required_safety_facts_complete !== false;
  return { supplied, read, present, complete };
}

function polarity(entries, positivePattern, negativePattern = null) {
  const positiveFalse = entries.some(({ key, value }) => value === false && positivePattern.test(key));
  const negativeTrue = negativePattern
    ? entries.some(({ key, value }) => value === true && negativePattern.test(key))
    : false;
  const positiveTrue = entries.some(({ key, value }) => value === true && positivePattern.test(key));
  return { failure: positiveFalse || negativeTrue, positive: positiveTrue && !negativeTrue };
}

export function normalizeJeffAgentNftSafetyFactsV09(state = {}) {
  const canonical = canonicalEnvelope(state);
  const entries = Object.entries(state)
    .filter(([key]) => !['benchmarkNeutral', 'ownerPolicy', 'safetyFacts', 'safety_facts'].includes(key))
    .map(([key, value]) => ({ key: normalizedKey(key), value }));
  const falseField = (pattern) => entries.some((entry) => entry.value === false && pattern.test(entry.key));
  const trueField = (pattern) => entries.some((entry) => entry.value === true && pattern.test(entry.key));
  const presentField = (pattern) => entries.some((entry) => pattern.test(entry.key));
  const reasons = new Set();

  const authorityAlias = polarity(
    entries,
    /(?:(?:owner|controller|publisher|operator|account|signer|actor|submitter|requester|delegate).*(?:authorized|authority_valid|permission_granted|approved|verified|matches)|evaluator.*(?:authorized|authority_valid|permission_granted|verified|matches))$/,
    /(?:owner|controller|publisher|operator|evaluator|account|signer|actor|submitter|requester|delegate).*(?:unauthorized|permission_denied|authority_invalid)$/,
  );
  const fundingAlias = polarity(
    entries,
    /(?:fund|prefund|deposit|balance|collateral|sponsor|escrow).*(?:sufficient|covered|coverage_available|adequate|funded)$/,
    /(?:fund|prefund|deposit|balance|collateral|sponsor|escrow).*(?:insufficient|missing|depleted|unfunded)$/,
  );
  const transitionAlias = polarity(
    entries,
    /(?:transition|lifecycle|settlement|completion|prerequisite|precondition).*(?:valid|allowed|ready|satisfied|met)$/,
    /(?:transition|lifecycle|settlement|completion|prerequisite|precondition).*(?:invalid|blocked|missing|unmet)$/,
  );
  const evidenceAlias = polarity(
    entries,
    /(?:provenance|evidence|attestation|endpoint.*domain|previous_root|metadata.*proof).*(?:verified|matches|sufficient|available|complete|valid)$/,
    /(?:provenance|evidence|attestation|endpoint.*domain|previous_root|metadata.*proof).*(?:missing|unavailable|insufficient|invalid|conflicted)$/,
  );
  const privacyAlias = polarity(
    entries,
    /(?:privacy|private|payload|data).*(?:safe|excluded|redacted|hash_only)$/,
    /(?:raw|private).*(?:included|content_present|payload_present|contains_private|exposed|leaked)$/,
  );
  const validationAlias = polarity(
    entries,
    /(?:validation|signature|static_call|magic_value).*(?:safe|valid|matches)$/,
    /(?:validation|signature|static_call|magic_value).*(?:unsafe|malformed|mutates|reverted|invalid|mismatch)$/,
  );

  const explicitIdentityConflict = trueField(/identity_conflict/);
  const bindingConflict = trueField(/binding_conflict/)
    || falseField(/token_contract_matches/)
    || (state.expectedChainId !== undefined && state.reportedChainId !== undefined
      && String(state.expectedChainId) !== String(state.reportedChainId))
    || (state.expectedTokenId !== undefined && state.reportedTokenId !== undefined
      && String(state.expectedTokenId) !== String(state.reportedTokenId));

  const metadataEvidenceMissing = trueField(/metadata_conflict/)
    || falseField(/metadata.*(?:digest.*matches|proof.*valid)/)
    || falseField(/agent_wallet_proof_valid/);
  const evidenceCountsPresent = Number.isFinite(state.sourceCount) || Number.isFinite(state.independentPrimarySources);
  const evidenceEnvelopeIncomplete = evidenceCountsPresent
    && (state.provenanceVerified !== true || state.dataFresh !== true || Number(state.sourceCount ?? 0) <= 0);
  const canonicalIncomplete = canonical.present && !canonical.complete;
  if (canonicalIncomplete) reasons.add('incomplete_safety_facts');

  const identityAuthorityFailure = authorityAlias.failure
    || (!metadataEvidenceMissing && falseField(/(?:wallet|identity).*proof.*valid$/))
    || trueField(/proof_signer_is_previous_owner/);
  const authorityFailure = canonical.read('authorized', 'authorized') === false
    || falseField(/(?:^|_)authorized$/)
    || identityAuthorityFailure;
  if (authorityFailure) reasons.add('unauthorized_actor');

  const validationFailure = canonical.read('validationSafe', 'validation_safe') === false
    || validationAlias.failure;
  if (validationFailure) reasons.add('unsafe_validation');

  const fundingEvidencePresent = fundingAlias.positive || state.funded !== undefined;
  const fundingFailure = canonical.read('funded', 'funded') === false
    || fundingAlias.failure
    || (String(state.requestedTransition ?? '').toLowerCase() === 'completed' && state.funded === false);
  if (fundingFailure) reasons.add('insufficient_funding');

  const invalidNonce = trueField(/nonce.*(?:consumed|replayed)/) || falseField(/nonce.*fresh/);
  const invalidWindow = falseField(/(?:validity|validation).*window.*current|valid_after_reached/)
    || trueField(/valid_until_expired/);
  const invalidSequence = Number.isFinite(state.currentSequence)
    && Number.isFinite(state.proposedSequence)
    && state.proposedSequence !== state.currentSequence + 1;
  const requestedTransition = String(state.requestedTransition ?? '').toLowerCase();
  const terminalConflict = trueField(/already_refunded/)
    || (state.expired === true && String(state.jobStatus ?? '').toLowerCase() === 'completed')
    || (state.terminalState === true
      && requestedTransition.length > 0
      && requestedTransition !== String(state.jobStatus ?? '').toLowerCase());
  const prerequisiteFailure = canonical.read('validTransition', 'valid_transition') === false
    || transitionAlias.failure
    || (requestedTransition === 'completed'
      && falseField(/^(?:funded|deliverable_submitted|evaluator_decision_present)$/));
  const transitionFailure = invalidNonce || invalidWindow || invalidSequence || terminalConflict || prerequisiteFailure;
  if (transitionFailure) reasons.add('invalid_transition');

  const privacyFailure = canonical.read('privacySafe', 'privacy_safe') === false
    || privacyAlias.failure
    || falseField(/data_hash_only/);
  if (privacyFailure) reasons.add('unsafe_private_payload');

  const identityEvidenceFailure = canonical.read('evidenceSufficient', 'evidence_sufficient') === false
    || canonicalIncomplete
    || metadataEvidenceMissing
    || evidenceEnvelopeIncomplete
    || bindingConflict
    || evidenceAlias.failure
    || falseField(/data_fresh$/);
  const evidenceFailure = identityEvidenceFailure || privacyFailure || trueField(/already_refunded/);
  if (evidenceFailure) reasons.add('insufficient_evidence');
  if (bindingConflict || explicitIdentityConflict) reasons.add('identity_conflict');

  const suppliedIdentity = canonical.read('identityIntegrity', 'identity_integrity')
    ?? state.identityIntegrity
    ?? state.identity_integrity;
  const identityIntegrity = suppliedIdentity === 'conflicted'
    || bindingConflict || explicitIdentityConflict || identityAuthorityFailure || validationFailure
    ? 'conflicted'
    : suppliedIdentity === 'unknown' || canonicalIncomplete || identityEvidenceFailure || state.tokenChainMatchesExecutionChain === false
      ? 'unknown'
      : 'trusted';
  const facts = {
    authorized: authorityFailure ? false : true,
    funded: fundingFailure ? false : fundingEvidencePresent || canonical.read('funded', 'funded') === true ? true : null,
    validTransition: transitionFailure ? false : true,
    evidenceSufficient: evidenceFailure ? false : true,
    privacySafe: privacyFailure ? false : true,
    validationSafe: validationFailure ? false : true,
    identityIntegrity,
    canonicalEnvelopeComplete: canonical.present ? canonical.complete : null,
    researchDisposition: canonicalIncomplete || metadataEvidenceMissing ? 'request_more_data'
      : evidenceFailure ? 'verify_sources' : 'synthesize_report',
    reasons: [...reasons].sort(),
  };
  facts.requiresDeny = canonicalIncomplete
    || facts.authorized === false
    || facts.funded === false
    || facts.validTransition === false
    || facts.evidenceSufficient === false
    || facts.privacySafe === false
    || facts.validationSafe === false
    || facts.identityIntegrity !== 'trusted';
  return facts;
}

function hasSemanticSafetyInput(state) {
  return Object.keys(state).some((key) => /(?:authority_valid|permission_granted|coverage_available|preconditions_met|attestation_available|payload_safe|validation_safe|identity_integrity|required_safety_facts_complete)$/.test(normalizedKey(key)));
}

function applyCanonicalSafetyPolicy(request, response) {
  const state = request.state ?? {};
  const hasEvidenceCounts = Number.isFinite(state.sourceCount) || Number.isFinite(state.independentPrimarySources);
  const hasCanonicalInput = Object.hasOwn(state, 'safetyFacts')
    || Object.hasOwn(state, 'safety_facts')
    || Object.hasOwn(state, 'requiredSafetyFactsComplete')
    || Object.hasOwn(state, 'required_safety_facts_complete');
  const hasSafetyInput = hasEvidenceCounts || hasCanonicalInput || hasSemanticSafetyInput(state);

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
  const facts = normalizeJeffAgentNftSafetyFactsV09(state);
  if (!hasSafetyInput) return response;
  const deny = facts.requiresDeny;
  const ownerReview = state.ownerPolicy?.allowAutonomous === false;
  const proposal = String(state.proposal ?? '');
  const simulation = /\b(simulate|simulation|dry run)\b/i.test(proposal);

  setChoice('identity_integrity', facts.identityIntegrity);
  setChoice('authority', deny ? 'deny' : ownerReview ? 'owner_review' : 'autonomous');
  setChoice('permission_posture', deny ? 'deny' : ownerReview ? 'owner_review' : 'allow_bounded');
  setChoice('next_action', deny ? 'abstain' : simulation ? 'propose_transaction' : 'observe');
  setChoice('research_action', facts.researchDisposition);
  setChoice('tool_mode', facts.privacySafe === false ? 'none' : deny ? 'read_only' : simulation ? 'simulate' : 'read_only');
  setNoul('owner_notification', deny || state.ownerChanged === true);

  const independentSources = Number.isFinite(state.independentPrimarySources) ? state.independentPrimarySources : 0;
  const sourceCount = Number.isFinite(state.sourceCount) ? state.sourceCount : 0;
  if (facts.canonicalEnvelopeComplete === false) setScore('source_diversity', 0);
  else if (hasEvidenceCounts) setScore('source_diversity', Math.min(4, Math.max(0, sourceCount + independentSources)));
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

export const JEFF_V09_CANDIDATE = Object.freeze({
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

export function inferJeffAgentNftCandidateV09(request) {
  const response = capDecisionConfidence(applyCanonicalSafetyPolicy(
    request,
    inferJeffAgentNftLearned(checkpoint, modelVisibleRequest(request)),
  ));
  if (!validateJeffAgentNftResponse(response, request)) throw new Error('JEFF_V09_CANDIDATE_RESPONSE_INVALID');
  if (response.mode !== 'shadow' || response.executionAuthorized !== false) throw new Error('JEFF_V09_CANDIDATE_AUTHORITY_BREACH');
  return response;
}
