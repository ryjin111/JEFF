import {
  assertJeffIsoTimestamp,
  assertJeffText,
  containsJeffUnsafeText,
  hashJeffBrainValue,
  isJeffRecord,
  JEFF_HASH,
} from './jeff-brain-common.mjs';

const OUTCOMES = new Set(['helpful', 'unhelpful', 'corrected', 'unsafe']);
const EVENT_KEYS = [
  'schema', 'scopeSha256', 'ownerIdSha256', 'decisionReceiptSha256', 'outcome',
  'correction', 'ownerOptInForTraining', 'observedAt', 'independentReview',
  'trainingApplied', 'eventSha256',
];
const REVIEW_KEYS = ['reviewer', 'approved', 'reviewedAt'];

function hasExactKeys(value, keys) {
  return isJeffRecord(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
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
    || !Number.isFinite(Date.parse(event.observedAt))
    || event.trainingApplied !== false
    || !JEFF_HASH.test(event.eventSha256)) return false;
  if (reviewed) {
    if (!hasExactKeys(event.independentReview, REVIEW_KEYS)
      || typeof event.independentReview.reviewer !== 'string'
      || typeof event.independentReview.approved !== 'boolean'
      || !Number.isFinite(Date.parse(event.independentReview.reviewedAt))
      || hashJeffBrainValue(event.independentReview.reviewer) === event.ownerIdSha256) return false;
  } else if (event.independentReview !== null) return false;
  const { eventSha256, ...body } = event;
  return hashJeffBrainValue(body) === eventSha256;
}

export function createJeffFeedbackEvent({
  scope,
  authorization,
  decisionReceiptSha256,
  outcome,
  correction = null,
  ownerOptInForTraining = false,
  observedAt = new Date().toISOString(),
} = {}) {
  if (!isJeffRecord(scope)
    || typeof scope.agentId !== 'string'
    || typeof scope.ownerId !== 'string'
    || !Number.isSafeInteger(scope.ownerEpoch)
    || scope.ownerEpoch < 0
    || !isJeffRecord(authorization)
    || authorization.ownerId !== scope.ownerId
    || authorization.agentId !== scope.agentId
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
  const body = {
    schema: 'jeff-learning-feedback-v1',
    scopeSha256: hashJeffBrainValue(scope),
    ownerIdSha256: hashJeffBrainValue(scope.ownerId),
    decisionReceiptSha256,
    outcome,
    correction: normalizedCorrection,
    ownerOptInForTraining: ownerOptInForTraining === true,
    observedAt: assertJeffIsoTimestamp(observedAt, 'JEFF_FEEDBACK_TIME_INVALID'),
    independentReview: null,
    trainingApplied: false,
  };
  return Object.freeze({ ...body, eventSha256: hashJeffBrainValue(body) });
}

export function reviewJeffFeedbackEvent(event, { reviewer, approved, reviewedAt = new Date().toISOString() } = {}) {
  if (!validateFeedbackEvent(event, { reviewed: false })) throw new Error('JEFF_FEEDBACK_EVENT_INVALID');
  const { eventSha256: _eventSha256, ...eventBody } = event;
  const reviewerId = assertJeffText(reviewer, 'JEFF_FEEDBACK_REVIEW_INVALID', 200);
  if (hashJeffBrainValue(reviewerId) === event.ownerIdSha256) throw new Error('JEFF_FEEDBACK_REVIEW_NOT_INDEPENDENT');
  const review = {
    reviewer: reviewerId,
    approved: approved === true,
    reviewedAt: assertJeffIsoTimestamp(reviewedAt, 'JEFF_FEEDBACK_REVIEW_INVALID'),
  };
  const body = { ...eventBody, independentReview: review };
  return Object.freeze({ ...body, eventSha256: hashJeffBrainValue(body) });
}

export function assessJeffLearningCandidate(events) {
  if (!Array.isArray(events) || events.length === 0) throw new Error('JEFF_FEEDBACK_EVENTS_REQUIRED');
  const reasons = [];
  const hashes = [];
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
    hashes.push(eventSha256);
  }
  return Object.freeze({
    schema: 'jeff-learning-candidate-assessment-v1',
    eligible: reasons.length === 0,
    reasons: Object.freeze([...new Set(reasons)].sort()),
    eventSha256s: Object.freeze(hashes),
    curriculumSha256: hashJeffBrainValue(hashes),
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
