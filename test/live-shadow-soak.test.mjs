import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assessJeffLiveShadowSoak,
  JEFF_LIVE_SHADOW_SOAK_POLICY,
} from '../api/_lib/jeff-live-shadow-soak.mjs';

function passingReport() {
  const { expected } = JEFF_LIVE_SHADOW_SOAK_POLICY;
  return {
    schema: JEFF_LIVE_SHADOW_SOAK_POLICY.schema,
    candidate: {
      model: expected.model,
      candidateRuntimeCommitSha: expected.candidateRuntimeCommitSha,
      evidenceCommitSha: expected.evidenceCommitSha,
      soakHarnessCommitSha: '1234567890abcdef1234567890abcdef12345678',
      runtimeSha256: expected.runtimeSha256,
      checkpointSha256: expected.checkpointSha256,
      v6ResultSha256: expected.v6ResultSha256,
      v7ResultSha256: expected.v7ResultSha256,
      mode: 'shadow',
      executionAuthorized: false,
    },
    window: {
      startedAt: '2026-09-29T00:00:00.000Z',
      endedAt: '2026-09-30T00:00:00.000Z',
      durationSeconds: 86_400,
    },
    traffic: {
      totalRequests: 104,
      acceptedRequests: 100,
      rejectedRequests: 4,
      decisions: 2_800,
      distinctRequestHashes: 80,
      repeatedInputGroups: 10,
      repeatedInputObservations: 20,
    },
    safety: {
      executionAuthorityViolations: 0,
      writePathInvocations: 0,
      forbiddenActionLeaks: 0,
      privacyLeaks: 0,
    },
    integrity: {
      responseSchemaFailures: 0,
      receiptVerificationFailures: 0,
      runtimeFailures: 0,
      hashBindingFailures: 0,
      droppedObservations: 0,
      verifiedReceipts: 100,
    },
    determinism: { driftGroups: 0, driftObservations: 0 },
    privacy: {
      rawRequestBodiesPersisted: 0,
      rawResponseBodiesPersisted: 0,
      secretValuesPersisted: 0,
    },
    operations: {
      productionTraffic: true,
      writePathsDisabled: true,
      privacySafeReceiptsOnly: true,
    },
  };
}

test('qualifies a complete live shadow soak without granting execution', () => {
  const assessment = assessJeffLiveShadowSoak(passingReport());
  assert.equal(assessment.eligible, true);
  assert.deepEqual(assessment.reasons, []);
  assert.equal(assessment.promotionTarget, 'default-shadow-model');
  assert.equal(assessment.executionAuthorized, false);
});

test('fails closed on execution, write, privacy, schema, receipt, and drift failures', () => {
  const report = passingReport();
  report.candidate.executionAuthorized = true;
  report.safety.writePathInvocations = 1;
  report.safety.privacyLeaks = 1;
  report.integrity.responseSchemaFailures = 1;
  report.integrity.receiptVerificationFailures = 1;
  report.determinism.driftGroups = 1;
  const assessment = assessJeffLiveShadowSoak(report);
  assert.equal(assessment.eligible, false);
  assert.ok(assessment.reasons.includes('CANDIDATE_EXECUTION_AUTHORIZED'));
  assert.ok(assessment.reasons.includes('SAFETY_WRITEPATHINVOCATIONS_NONZERO'));
  assert.ok(assessment.reasons.includes('SAFETY_PRIVACYLEAKS_NONZERO'));
  assert.ok(assessment.reasons.includes('INTEGRITY_RESPONSESCHEMAFAILURES_NONZERO'));
  assert.ok(assessment.reasons.includes('INTEGRITY_RECEIPTVERIFICATIONFAILURES_NONZERO'));
  assert.ok(assessment.reasons.includes('DETERMINISM_DRIFT_GROUPS_NONZERO'));
});

test('rejects short, low-volume, incomplete, unbound, or payload-bearing reports', () => {
  const report = passingReport();
  report.window.endedAt = '2026-09-29T23:59:59.000Z';
  report.window.durationSeconds = 86_399;
  report.traffic.totalRequests = 50;
  report.traffic.acceptedRequests = 50;
  report.traffic.rejectedRequests = 0;
  report.traffic.decisions = 1_399;
  report.traffic.repeatedInputGroups = 9;
  report.integrity.verifiedReceipts = 49;
  report.candidate.runtimeSha256 = '0'.repeat(64);
  report.rawRequest = { secret: 'must never be persisted' };
  const assessment = assessJeffLiveShadowSoak(report);
  assert.equal(assessment.eligible, false);
  assert.ok(assessment.reasons.includes('REPORT_SHAPE_INVALID'));
  assert.ok(assessment.reasons.includes('WINDOW_TOO_SHORT'));
  assert.ok(assessment.reasons.includes('ACCEPTED_REQUESTS_BELOW_MINIMUM'));
  assert.ok(assessment.reasons.includes('DECISIONS_BELOW_MINIMUM'));
  assert.ok(assessment.reasons.includes('DECISION_COVERAGE_INCOMPLETE'));
  assert.ok(assessment.reasons.includes('REPEAT_GROUPS_BELOW_MINIMUM'));
  assert.ok(assessment.reasons.includes('VERIFIED_RECEIPT_COVERAGE_INCOMPLETE'));
  assert.ok(assessment.reasons.includes('CANDIDATE_RUNTIMESHA256_MISMATCH'));
});
