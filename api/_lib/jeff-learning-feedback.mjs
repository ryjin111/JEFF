import {
  assertJeffIsoTimestamp,
  assertJeffText,
  containsJeffUnsafeText,
  hashJeffBrainValue,
  isJeffRecord,
  JEFF_HASH,
} from './jeff-brain-common.mjs';
import {
  requireJeffAuthorization,
  validateJeffAuthorizationAttestation,
} from './jeff-trusted-authorization.mjs';

const OUTCOMES = new Set(['helpful', 'unhelpful', 'corrected', 'unsafe']);
const EVENT_KEYS = [
  'schema', 'scopeSha256', 'ownerIdSha256', 'decisionReceiptSha256', 'outcome',
  'correction', 'ownerOptInForTraining', 'observedAt', 'independentReview',
  'ownerEpoch', 'ownerAuthorizationAttestation', 'trainingApplied', 'eventSha256',
];
const REVIEW_KEYS = [
  'reviewer', 'approved', 'reviewedAt', 'reviewedEventSha256', 'authorizationAttestation',
];

function hasExactKeys(value, keys) {
  return isJeffRecord(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function ownerIntent(event) {
  return {
    scopeSha256: event.scopeSha256,
    ownerIdSha256: event.ownerIdSha256,
    decisionReceiptSha256: event.decisionReceiptSha256,
    outcome: event.outcome,
    correctionSha256: event.correction === null ? null : hashJeffBrainValue(event.correction),
    ownerOptInForTraining: event.ownerOptInForTraining,
    observedAt: event.observedAt,
  };
}

function reviewerIntent(review) {
  return {
    reviewedEventSha256: review.reviewedEventSha256,
    approved: review.approved,
    reviewedAt: review.reviewedAt,
  };
}

function validateFeedbackEvent(event, { reviewed }) {
  if (!hasExactKeys(event, EVENT_KEYS)
    || event.schema !== 'jeff-learning-feedback-v1'
    || !JEFF_HASH.test(event.scopeSha256)
    || !JEFF_HASH.test(event.ownerIdSha256)
    || !JEFF_HASH.test(event.decisionReceiptSha256)
    || !OUTCOMES.has(event.outcome)
    || (event.correction !== null && typeof event.correction !== 'string')
    || typeof event.ownerOptInForTraining !== 'boolean'
    || !Number.isSafeInteger(event.ownerEpoch)
    || event.ownerEpoch < 0
    || !Number.isFinite(Date.parse(event.observedAt))
    || event.trainingApplied !== false
    || !JEFF_HASH.test(event.eventSha256)) return false;
  if (!validateJeffAuthorizationAttestation(event.ownerAuthorizationAttestation, {
    scope: ownerIntent(event),
    operation: 'submit_feedback',
    ownerEpoch: event.ownerEpoch,
  })) return false;
  if (reviewed) {
    if (!hasExactKeys(event.independentReview, REVIEW_KEYS)
      || typeof event.independentReview.reviewer !== 'string'
      || typeof event.independentReview.approved !== 'boolean'
      || !Number.isFinite(Date.parse(event.independentReview.reviewedAt))
      || !JEFF_HASH.test(event.independentReview.reviewedEventSha256)
      || hashJeffBrainValue(event.independentReview.reviewer) === event.ownerIdSha256) return false;
    const { eventSha256: _eventSha256, ...reviewedBody } = event;
    const canonicalUnreviewedSha256 = hashJeffBrainValue({
      ...reviewedBody,
      independentReview: null,
    });
    if (event.independentReview.reviewedEventSha256 !== canonicalUnreviewedSha256) return false;
    if (!validateJeffAuthorizationAttestation(event.independentReview.authorizationAttestation, {
      scope: reviewerIntent(event.independentReview),
      operation: 'review_feedback',
      ownerEpoch: event.ownerEpoch,
      subjectSha256: hashJeffBrainValue(event.independentReview.reviewer),
    })) return false;
  } else if (event.independentReview !== null) return false;
  const { eventSha256, ...body } = event;
  return hashJeffBrainValue(body) === eventSha256;
}

export async function createJeffFeedbackEvent({
  scope,
  authorization,
  decisionReceiptSha256,
  outcome,
  correction = null,
  ownerOptInForTraining = false,
  observedAt,
} = {}, {
  authorizationVerifier,
  now = () => new Date().toISOString(),
} = {}) {
  if (!isJeffRecord(scope)
    || typeof scope.agentId !== 'string'
    || typeof scope.ownerId !== 'string'
    || !Number.isSafeInteger(scope.ownerEpoch)
    || scope.ownerEpoch < 0
    || !isJeffRecord(authorization)
    || authorization.ownerId !== scope.ownerId
    || authorization.agentId !== scope.agentId
    || authorization.ownerEpoch !== scope.ownerEpoch
    || authorization.canSubmitFeedback !== true) throw new Error('JEFF_FEEDBACK_AUTHORIZATION_DENIED');
  if (!JEFF_HASH.test(String(decisionReceiptSha256 ?? '')) || !OUTCOMES.has(outcome)) {
    throw new Error('JEFF_FEEDBACK_INPUT_INVALID');
  }
  let normalizedCorrection = null;
  if (correction !== null) {
    normalizedCorrection = assertJeffText(correction, 'JEFF_FEEDBACK_INPUT_INVALID', 2_000);
    if (containsJeffUnsafeText(normalizedCorrection)) throw new Error('JEFF_FEEDBACK_UNSAFE_CONTENT');
  }
  if (outcome === 'corrected' && !normalizedCorrection) throw new Error('JEFF_FEEDBACK_INPUT_INVALID');
  const normalizedObservedAt = assertJeffIsoTimestamp(observedAt ?? now(), 'JEFF_FEEDBACK_TIME_INVALID');
  const intent = {
    scopeSha256: hashJeffBrainValue(scope),
    ownerIdSha256: hashJeffBrainValue(scope.ownerId),
    decisionReceiptSha256,
    outcome,
    correctionSha256: normalizedCorrection === null ? null : hashJeffBrainValue(normalizedCorrection),
    ownerOptInForTraining: ownerOptInForTraining === true,
    observedAt: normalizedObservedAt,
  };
  let ownerAttestation;
  try {
    ownerAttestation = await requireJeffAuthorization({
      verifier: authorizationVerifier,
      scope: intent,
      subject: authorization.subject,
      operation: 'submit_feedback',
      ownerEpoch: scope.ownerEpoch,
      now,
    });
  } catch {
    throw new Error('JEFF_FEEDBACK_AUTHORIZATION_DENIED');
  }
  const body = {
    schema: 'jeff-learning-feedback-v1',
    scopeSha256: hashJeffBrainValue(scope),
    ownerIdSha256: hashJeffBrainValue(scope.ownerId),
    ownerEpoch: scope.ownerEpoch,
    ownerAuthorizationAttestation: ownerAttestation,
    decisionReceiptSha256,
    outcome,
    correction: normalizedCorrection,
    ownerOptInForTraining: ownerOptInForTraining === true,
    observedAt: normalizedObservedAt,
    independentReview: null,
    trainingApplied: false,
  };
  return Object.freeze({ ...body, eventSha256: hashJeffBrainValue(body) });
}

export async function reviewJeffFeedbackEvent(
  event,
  { reviewer, approved, reviewedAt } = {},
  { reviewerVerifier, now = () => new Date().toISOString() } = {},
) {
  if (!validateFeedbackEvent(event, { reviewed: false })) throw new Error('JEFF_FEEDBACK_EVENT_INVALID');
  const { eventSha256: _eventSha256, ...eventBody } = event;
  const reviewerId = assertJeffText(reviewer, 'JEFF_FEEDBACK_REVIEW_INVALID', 200);
  if (hashJeffBrainValue(reviewerId) === event.ownerIdSha256) throw new Error('JEFF_FEEDBACK_REVIEW_NOT_INDEPENDENT');
  const normalizedReviewedAt = assertJeffIsoTimestamp(reviewedAt ?? now(), 'JEFF_FEEDBACK_REVIEW_INVALID');
  const intent = {
    reviewedEventSha256: event.eventSha256,
    approved: approved === true,
    reviewedAt: normalizedReviewedAt,
  };
  let reviewerAttestation;
  try {
    reviewerAttestation = await requireJeffAuthorization({
      verifier: reviewerVerifier,
      scope: intent,
      subject: reviewerId,
      operation: 'review_feedback',
      ownerEpoch: event.ownerEpoch,
      now,
    });
  } catch {
    throw new Error('JEFF_FEEDBACK_REVIEW_AUTHORIZATION_DENIED');
  }
  const review = {
    reviewer: reviewerId,
    approved: intent.approved,
    reviewedAt: normalizedReviewedAt,
    reviewedEventSha256: event.eventSha256,
    authorizationAttestation: reviewerAttestation,
  };
  const body = { ...eventBody, independentReview: review };
  return Object.freeze({ ...body, eventSha256: hashJeffBrainValue(body) });
}

export async function assessJeffLearningCandidate(events, {
  eligibilityVerifier,
  eligibilitySubject,
  now = () => new Date().toISOString(),
} = {}) {
  if (!Array.isArray(events) || events.length === 0) throw new Error('JEFF_FEEDBACK_EVENTS_REQUIRED');
  const reasons = [];
  const hashes = [];
  const eligibilityAttestationSha256s = [];
  for (const event of events) {
    const reviewed = validateFeedbackEvent(event, { reviewed: true });
    const unreviewed = validateFeedbackEvent(event, { reviewed: false });
    if (!reviewed && !unreviewed) {
      reasons.push('EVENT_INVALID');
      continue;
    }
    const { eventSha256 } = event;
    if (event.ownerOptInForTraining !== true) reasons.push('OWNER_OPT_IN_MISSING');
    if (!reviewed || event.independentReview?.approved !== true) reasons.push('INDEPENDENT_REVIEW_MISSING');
    if (event.trainingApplied !== false) reasons.push('SILENT_TRAINING_STATE_INVALID');
    if (reviewed
      && event.ownerOptInForTraining === true
      && event.independentReview.approved === true
      && event.trainingApplied === false) {
      try {
        const eligibilityAttestation = await requireJeffAuthorization({
          verifier: eligibilityVerifier,
          scope: {
            eventSha256: event.eventSha256,
            ownerAuthorizationAttestationSha256: event.ownerAuthorizationAttestation.attestationSha256,
            reviewerAuthorizationAttestationSha256: event.independentReview.authorizationAttestation.attestationSha256,
          },
          subject: eligibilitySubject,
          operation: 'assess_learning_eligibility',
          ownerEpoch: event.ownerEpoch,
          now,
        });
        eligibilityAttestationSha256s.push(eligibilityAttestation.attestationSha256);
      } catch {
        reasons.push('ELIGIBILITY_AUTHORIZATION_DENIED');
      }
    }
    hashes.push(eventSha256);
  }
  return Object.freeze({
    schema: 'jeff-learning-candidate-assessment-v1',
    eligible: reasons.length === 0,
    reasons: Object.freeze([...new Set(reasons)].sort()),
    eventSha256s: Object.freeze(hashes),
    eligibilityAttestationSha256s: Object.freeze(eligibilityAttestationSha256s),
    curriculumSha256: hashJeffBrainValue({ hashes, eligibilityAttestationSha256s }),
    trainingAuthorized: false,
    requiresSeparateBuildAndBlindEvaluation: true,
  });
}

export const JEFF_LEARNING_FEEDBACK = Object.freeze({
  silentTrainingAllowed: false,
  ownerOptInRequired: true,
  independentReviewRequired: true,
  trainingAuthorized: false,
});
