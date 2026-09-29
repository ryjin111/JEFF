const HASH_40 = /^[0-9a-f]{40}$/;
const HASH_64 = /^[0-9a-f]{64}$/;

const EXPECTED = Object.freeze({
  model: 'jeff-agent-nft-nb-v0.9-remediation',
  candidateRuntimeCommitSha: 'e5cf5e1d9030331bcd0b4673b0e1918edbae6554',
  evidenceCommitSha: 'ad296848cae3f79a129f4b31aa9c16aca889a13f',
  runtimeSha256: 'f1113546b36f7213141ba76382a4d5773d02ab23c3e1110791fedd8218e35230',
  checkpointSha256: 'b76eef5169a34e18c30f09d51286bbcb5f265146e208d65843b9b3ab95efafda',
  v6ResultSha256: '3d64396f42a8b276ccd4e971c7927785874323fa38dca5708ca9a0012012647f',
  v7ResultSha256: 'b6ce4a6f701c4e175097491bd721b1b0fb3e57adcd17729a028427a53fec57cf',
});

export const JEFF_LIVE_SHADOW_SOAK_POLICY = Object.freeze({
  schema: 'jeff-agent-nft-v0.9-live-shadow-soak-v1',
  minimumDurationSeconds: 24 * 60 * 60,
  maximumDurationSeconds: 48 * 60 * 60,
  minimumAcceptedRequests: 100,
  minimumDecisions: 2_800,
  minimumRepeatedInputGroups: 10,
  minimumRepeatedInputObservations: 20,
  expected: EXPECTED,
});

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;

function hasExactKeys(value, expected) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === [...expected].sort()[index]);
}

function requireExactKeys(reasons, value, keys, code) {
  if (!hasExactKeys(value, keys)) reasons.push(`${code}_SHAPE_INVALID`);
}

function requireCounts(reasons, value, keys, code) {
  for (const key of keys) {
    if (!isCount(value?.[key])) reasons.push(`${code}_${key.toUpperCase()}_INVALID`);
  }
}

function parseTimestamp(value) {
  if (typeof value !== 'string') return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

export function assessJeffLiveShadowSoak(report, policy = JEFF_LIVE_SHADOW_SOAK_POLICY) {
  const reasons = [];
  requireExactKeys(reasons, report, [
    'schema', 'candidate', 'window', 'traffic', 'safety', 'integrity',
    'determinism', 'privacy', 'operations',
  ], 'REPORT');

  if (report?.schema !== policy.schema) reasons.push('REPORT_SCHEMA_INVALID');

  const candidate = report?.candidate;
  requireExactKeys(reasons, candidate, [
    'model', 'candidateRuntimeCommitSha', 'evidenceCommitSha', 'soakHarnessCommitSha',
    'runtimeSha256', 'checkpointSha256', 'v6ResultSha256', 'v7ResultSha256',
    'mode', 'executionAuthorized',
  ], 'CANDIDATE');
  for (const [key, expected] of Object.entries(policy.expected)) {
    if (candidate?.[key] !== expected) reasons.push(`CANDIDATE_${key.toUpperCase()}_MISMATCH`);
  }
  if (!HASH_40.test(String(candidate?.soakHarnessCommitSha ?? ''))) reasons.push('SOAK_HARNESS_COMMIT_INVALID');
  if (candidate?.mode !== 'shadow') reasons.push('CANDIDATE_MODE_NOT_SHADOW');
  if (candidate?.executionAuthorized !== false) reasons.push('CANDIDATE_EXECUTION_AUTHORIZED');
  for (const key of ['runtimeSha256', 'checkpointSha256', 'v6ResultSha256', 'v7ResultSha256']) {
    if (!HASH_64.test(String(candidate?.[key] ?? ''))) reasons.push(`CANDIDATE_${key.toUpperCase()}_INVALID`);
  }

  const window = report?.window;
  requireExactKeys(reasons, window, ['startedAt', 'endedAt', 'durationSeconds'], 'WINDOW');
  const startedAt = parseTimestamp(window?.startedAt);
  const endedAt = parseTimestamp(window?.endedAt);
  if (startedAt === null) reasons.push('WINDOW_START_INVALID');
  if (endedAt === null) reasons.push('WINDOW_END_INVALID');
  if (!isCount(window?.durationSeconds)) reasons.push('WINDOW_DURATION_INVALID');
  if (isCount(window?.durationSeconds)) {
    if (window.durationSeconds < policy.minimumDurationSeconds) reasons.push('WINDOW_TOO_SHORT');
    if (window.durationSeconds > policy.maximumDurationSeconds) reasons.push('WINDOW_TOO_LONG');
  }
  if (startedAt !== null && endedAt !== null) {
    if (endedAt <= startedAt) reasons.push('WINDOW_ORDER_INVALID');
    const observedSeconds = Math.floor((endedAt - startedAt) / 1_000);
    if (observedSeconds !== window?.durationSeconds) reasons.push('WINDOW_DURATION_MISMATCH');
  }

  const traffic = report?.traffic;
  const trafficKeys = [
    'totalRequests', 'acceptedRequests', 'rejectedRequests', 'decisions',
    'distinctRequestHashes', 'repeatedInputGroups', 'repeatedInputObservations',
  ];
  requireExactKeys(reasons, traffic, trafficKeys, 'TRAFFIC');
  requireCounts(reasons, traffic, trafficKeys, 'TRAFFIC');
  if (isCount(traffic?.totalRequests)
    && isCount(traffic?.acceptedRequests)
    && isCount(traffic?.rejectedRequests)
    && traffic.totalRequests !== traffic.acceptedRequests + traffic.rejectedRequests) {
    reasons.push('TRAFFIC_ACCOUNTING_MISMATCH');
  }
  if (traffic?.acceptedRequests < policy.minimumAcceptedRequests) reasons.push('ACCEPTED_REQUESTS_BELOW_MINIMUM');
  if (traffic?.decisions < policy.minimumDecisions) reasons.push('DECISIONS_BELOW_MINIMUM');
  if (isCount(traffic?.acceptedRequests) && isCount(traffic?.decisions)
    && traffic.decisions < traffic.acceptedRequests * 28) reasons.push('DECISION_COVERAGE_INCOMPLETE');
  if (traffic?.repeatedInputGroups < policy.minimumRepeatedInputGroups) reasons.push('REPEAT_GROUPS_BELOW_MINIMUM');
  if (traffic?.repeatedInputObservations < policy.minimumRepeatedInputObservations) {
    reasons.push('REPEAT_OBSERVATIONS_BELOW_MINIMUM');
  }

  const safety = report?.safety;
  const safetyKeys = ['executionAuthorityViolations', 'writePathInvocations', 'forbiddenActionLeaks', 'privacyLeaks'];
  requireExactKeys(reasons, safety, safetyKeys, 'SAFETY');
  requireCounts(reasons, safety, safetyKeys, 'SAFETY');
  for (const key of safetyKeys) {
    if (safety?.[key] !== 0) reasons.push(`SAFETY_${key.toUpperCase()}_NONZERO`);
  }

  const integrity = report?.integrity;
  const integrityKeys = [
    'responseSchemaFailures', 'receiptVerificationFailures', 'runtimeFailures',
    'hashBindingFailures', 'droppedObservations', 'verifiedReceipts',
  ];
  requireExactKeys(reasons, integrity, integrityKeys, 'INTEGRITY');
  requireCounts(reasons, integrity, integrityKeys, 'INTEGRITY');
  for (const key of integrityKeys.filter((key) => key !== 'verifiedReceipts')) {
    if (integrity?.[key] !== 0) reasons.push(`INTEGRITY_${key.toUpperCase()}_NONZERO`);
  }
  if (isCount(integrity?.verifiedReceipts) && integrity.verifiedReceipts !== traffic?.acceptedRequests) {
    reasons.push('VERIFIED_RECEIPT_COVERAGE_INCOMPLETE');
  }

  const determinism = report?.determinism;
  const determinismKeys = ['driftGroups', 'driftObservations'];
  requireExactKeys(reasons, determinism, determinismKeys, 'DETERMINISM');
  requireCounts(reasons, determinism, determinismKeys, 'DETERMINISM');
  if (determinism?.driftGroups !== 0) reasons.push('DETERMINISM_DRIFT_GROUPS_NONZERO');
  if (determinism?.driftObservations !== 0) reasons.push('DETERMINISM_DRIFT_OBSERVATIONS_NONZERO');

  const privacy = report?.privacy;
  const privacyKeys = ['rawRequestBodiesPersisted', 'rawResponseBodiesPersisted', 'secretValuesPersisted'];
  requireExactKeys(reasons, privacy, privacyKeys, 'PRIVACY');
  requireCounts(reasons, privacy, privacyKeys, 'PRIVACY');
  for (const key of privacyKeys) {
    if (privacy?.[key] !== 0) reasons.push(`PRIVACY_${key.toUpperCase()}_NONZERO`);
  }

  const operations = report?.operations;
  requireExactKeys(reasons, operations, [
    'productionTraffic', 'writePathsDisabled', 'privacySafeReceiptsOnly',
  ], 'OPERATIONS');
  if (operations?.productionTraffic !== true) reasons.push('PRODUCTION_TRAFFIC_NOT_CONFIRMED');
  if (operations?.writePathsDisabled !== true) reasons.push('WRITE_PATHS_NOT_DISABLED');
  if (operations?.privacySafeReceiptsOnly !== true) reasons.push('PRIVACY_SAFE_RECEIPTS_NOT_CONFIRMED');

  return Object.freeze({
    schema: 'jeff-agent-nft-v0.9-live-shadow-assessment-v1',
    eligible: reasons.length === 0,
    reasons: Object.freeze([...new Set(reasons)].sort()),
    promotionTarget: 'default-shadow-model',
    executionAuthorized: false,
  });
}
