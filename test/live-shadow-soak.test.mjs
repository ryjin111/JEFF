import assert from 'node:assert/strict';
import test from 'node:test';

import { JEFF_AGENT_NFT_CAPABILITY_QUESTIONS } from '../api/_lib/jeff-agent-nft-capabilities.mjs';
import {
  assessJeffShadowSoakSummary,
  JEFF_LIVE_SHADOW_SOAK,
  observeJeffV09Shadow,
  verifyJeffV09ShadowReceipt,
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
});

test('live shadow soak qualification is fail closed', () => {
  const summary = {
    schema: JEFF_LIVE_SHADOW_SOAK.summarySchema,
    durationHours: 24,
    validSamples: 100,
    invalidSamples: 0,
    authorityBreaches: 0,
    receiptFailures: 0,
    driftFailures: 0,
    externalWritesAttempted: 0,
  };
  assert.equal(assessJeffShadowSoakSummary(summary, { minimumHours: 24, minimumSamples: 100 }).qualified, true);
  assert.equal(assessJeffShadowSoakSummary({ ...summary, driftFailures: 1 }).qualified, false);
  assert.equal(assessJeffShadowSoakSummary({ ...summary, durationHours: 23.99 }).qualified, false);
});

test('live shadow soak is bound to independently passing V6 and V7 evidence', () => {
  assert.equal(JEFF_LIVE_SHADOW_SOAK.model, 'jeff-agent-nft-nb-v0.9-remediation');
  assert.equal(JEFF_LIVE_SHADOW_SOAK.executionAuthorized, false);
  assert.deepEqual(JEFF_LIVE_SHADOW_SOAK.evidence.map(({ gate }) => gate), ['v6', 'v7']);
});
