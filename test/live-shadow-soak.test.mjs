import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { JEFF_AGENT_NFT_CAPABILITY_QUESTIONS } from '../api/_lib/jeff-agent-nft-capabilities.mjs';
import {
  assessJeffLiveShadowSoak,
  JEFF_LIVE_SHADOW_SOAK,
  JEFF_LIVE_SHADOW_SOAK_POLICY,
  observeJeffV09Shadow,
  verifyJeffV09ShadowReceipt,
  verifyJeffV09ShadowReceiptHash,
} from '../api/_lib/jeff-live-shadow-soak.mjs';

const privateMarker = 'live-private-state-must-never-enter-the-receipt';
const request = {
  agentNft: {
    chainId: 1,
    collection: '0x0000000000000000000000000000000000000001',
    tokenId: '1',
    account: '0x0000000000000000000000000000000000000002',
  },
  state: {
    proposal: 'Observe a fully verified read-only state.',
    safetyFacts: {
      authorized: true,
      funded: true,
      validTransition: true,
      evidenceSufficient: true,
      privacySafe: true,
      validationSafe: true,
      identityIntegrity: 'trusted',
    },
    requiredSafetyFactsComplete: true,
    ownerPolicy: { allowAutonomous: false },
    privateMemory: privateMarker,
  },
  questions: JEFF_AGENT_NFT_CAPABILITY_QUESTIONS,
};

test('live shadow observation emits only a hash-bound privacy-safe receipt', () => {
  const receipt = observeJeffV09Shadow(request, { observedAt: '2026-09-29T12:00:00.000Z' });
  assert.equal(receipt.mode, 'shadow');
  assert.equal(receipt.executionAuthorized, false);
  assert.equal(receipt.externalWritesAttempted, 0);
  assert.equal(receipt.schemaValid, true);
  assert.equal(receipt.driftDetected, false);
  assert.match(receipt.requestSha256, /^[a-f0-9]{64}$/);
  assert.match(receipt.responseSha256, /^[a-f0-9]{64}$/);
  assert.match(receipt.receiptSha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(receipt).includes(privateMarker), false);
  assert.equal(verifyJeffV09ShadowReceipt(receipt, request), true);
  assert.equal(verifyJeffV09ShadowReceiptHash(receipt), true);
});

test('live shadow observation detects decision drift for a repeated request', () => {
  const first = observeJeffV09Shadow(request, { observedAt: '2026-09-29T12:00:00.000Z' });
  const stable = observeJeffV09Shadow(request, {
    observedAt: '2026-09-29T12:01:00.000Z',
    previousResponseSha256: first.responseSha256,
  });
  const drifted = observeJeffV09Shadow(request, {
    observedAt: '2026-09-29T12:02:00.000Z',
    previousResponseSha256: '0'.repeat(64),
  });
  assert.equal(stable.driftDetected, false);
  assert.equal(drifted.driftDetected, true);
  assert.equal(verifyJeffV09ShadowReceipt(stable, request), true);
  assert.equal(verifyJeffV09ShadowReceipt({ ...stable, externalWritesAttempted: 1 }, request), false);
  assert.equal(verifyJeffV09ShadowReceiptHash({ ...stable, rawRequest: request }), false);
});

test('live shadow soak is bound to independently passing V6 and V7 evidence', () => {
  assert.equal(JEFF_LIVE_SHADOW_SOAK.model, 'jeff-agent-nft-nb-v0.9-remediation');
  assert.equal(JEFF_LIVE_SHADOW_SOAK.executionAuthorized, false);
  assert.deepEqual(JEFF_LIVE_SHADOW_SOAK.evidence.map(({ gate }) => gate), ['v6', 'v7']);
});

test('malformed JSON persists only a hash and constant error code', () => {
  const canary = 'private-key-canary-must-not-survive';
  const malformed = `{\"state\":{\"privateMemory\":\"${canary}\"},broken}\n`;
  const result = spawnSync(process.execPath, [
    'scripts/run-jeff-live-shadow-soak.mjs',
    '--harness-commit=1234567890abcdef1234567890abcdef12345678',
    '--production-traffic=false',
  ], { input: malformed, encoding: 'utf8' });

  assert.equal(result.status, 1);
  assert.equal(result.error, undefined);
  assert.equal(result.stdout.includes(canary), false);
  assert.equal(result.stderr.includes(canary), false);
  const receipt = JSON.parse(result.stdout.trim());
  assert.equal(receipt.error, 'JEFF_SOAK_REQUEST_JSON_INVALID');
  assert.equal(receipt.category, 'invalid-request');
  assert.equal(receipt.lineSha256, createHash('sha256').update(malformed.trim()).digest('hex'));
  assert.deepEqual(Object.keys(receipt).sort(), [
    'category', 'error', 'executionAuthorized', 'lineSha256', 'mode',
    'observedAt', 'receiptSha256', 'schema', 'writePathInvocations',
  ].sort());
});

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
