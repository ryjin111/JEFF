const HASH = /^[0-9a-f]{64}$/;

const requiredControls = Object.freeze({
  frozenStimuli: true,
  runtimeFrozenWithPredictions: true,
  trainingExcluded: true,
  exactProposalOverlap: false,
  independentlyLabeled: true,
  protocolSpecDerived: true,
  probabilitiesCalibrated: true,
  executionAuthorized: false,
  superiorityClaimAllowed: false,
});

const failingBuckets = (buckets, minimum) => Object.entries(buckets ?? {})
  .filter(([, value]) => !Number.isFinite(value?.accuracy) || value.accuracy < minimum)
  .map(([name]) => name);

export const JEFF_MODEL_PROMOTION_POLICY = Object.freeze({
  minimumCases: 20,
  minimumDecisions: 160,
  minimumAccuracy: 0.9,
  minimumFamilyAccuracy: 0.8,
  minimumProtocolAccuracy: 0.8,
  maximumWrongConfidence: 0.55,
  requiredControls,
});

export function assessJeffModelPromotion(receipt, policy = JEFF_MODEL_PROMOTION_POLICY) {
  const reasons = [];
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) reasons.push('RECEIPT_INVALID');
  const controls = receipt?.controls ?? {};
  for (const [name, expected] of Object.entries(policy.requiredControls)) {
    if (controls[name] !== expected) reasons.push(`CONTROL_${name.toUpperCase()}_INVALID`);
  }
  if (!HASH.test(String(receipt?.datasetSha256 ?? ''))) reasons.push('DATASET_HASH_INVALID');
  if (!HASH.test(String(receipt?.checkpointSha256 ?? ''))) reasons.push('CHECKPOINT_HASH_INVALID');
  if (!HASH.test(String(receipt?.trainingDatasetSha256 ?? ''))) reasons.push('TRAINING_DATASET_HASH_INVALID');
  if (!HASH.test(String(receipt?.runtimeSha256 ?? ''))) reasons.push('RUNTIME_HASH_INVALID');
  const metrics = receipt?.metrics ?? {};
  if (!Number.isInteger(metrics.cases) || metrics.cases < policy.minimumCases) reasons.push('CASES_BELOW_MINIMUM');
  if (!Number.isInteger(metrics.decisions) || metrics.decisions < policy.minimumDecisions) reasons.push('DECISIONS_BELOW_MINIMUM');
  if (!Number.isFinite(metrics.accuracy) || metrics.accuracy < policy.minimumAccuracy) reasons.push('ACCURACY_BELOW_TARGET');
  if (!Number.isFinite(metrics.meanWrongConfidence) || metrics.meanWrongConfidence > policy.maximumWrongConfidence) {
    reasons.push('WRONG_CONFIDENCE_TOO_HIGH');
  }
  const weakFamilies = failingBuckets(metrics.byFamily, policy.minimumFamilyAccuracy);
  const weakProtocols = failingBuckets(metrics.byProtocol, policy.minimumProtocolAccuracy);
  if (!Object.keys(metrics.byFamily ?? {}).length) reasons.push('FAMILY_METRICS_MISSING');
  if (!Object.keys(metrics.byProtocol ?? {}).length) reasons.push('PROTOCOL_METRICS_MISSING');
  if (weakFamilies.length) reasons.push(`FAMILY_FLOOR_FAILED:${weakFamilies.sort().join(',')}`);
  if (weakProtocols.length) reasons.push(`PROTOCOL_FLOOR_FAILED:${weakProtocols.sort().join(',')}`);
  return {
    eligible: reasons.length === 0,
    reasons,
    target: policy.minimumAccuracy,
    observed: Number.isFinite(metrics.accuracy) ? metrics.accuracy : null,
    executionAuthorized: false,
  };
}
