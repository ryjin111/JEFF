import assert from 'node:assert/strict';
import test from 'node:test';

import { hashJeffBrainValue } from '../api/_lib/jeff-brain-common.mjs';
import {
  createInMemoryJeffHolderStore,
  createJeffHolderOsAuthorizationVerifier,
} from '../api/_lib/jeff-holder-runtime.mjs';
import { validateJeffAuthorizationAttestation } from '../api/_lib/jeff-trusted-authorization.mjs';

const nowValue = '2026-10-04T14:00:00.000Z';
const sessionId = 'a'.repeat(64);
const wallet = '0x1111111111111111111111111111111111111111';
const agentNft = Object.freeze({
  chainId: 46630,
  collection: '0x2222222222222222222222222222222222222222',
  tokenId: '7',
  account: '0x3333333333333333333333333333333333333333',
});

function session() {
  return {
    schema: 'jeff-holder-session-v1',
    sessionId,
    instanceId: hashJeffBrainValue(agentNft),
    agentNft,
    wallet,
    ownerEpoch: 4,
    soulManifestSha256: hashJeffBrainValue('manifest'),
    soulBundleRootSha256: hashJeffBrainValue('bundle'),
    soulCheckpointSha256: hashJeffBrainValue('checkpoint'),
    challengeSha256: hashJeffBrainValue('challenge'),
    issuedAt: '2026-10-04T13:55:00.000Z',
    expiresAt: '2026-10-04T16:00:00.000Z',
    status: 'active',
  };
}

function ownership(currentOwner = wallet, ownerEpoch = 4) {
  return {
    schema: 'jeff-holder-ownership-attestation-v1',
    agentNftSha256: hashJeffBrainValue(agentNft),
    currentOwner,
    ownerEpoch,
    observedAt: nowValue,
  };
}

async function configured({ currentOwner = wallet, ownerEpoch = 4, authorize = () => true } = {}) {
  const store = createInMemoryJeffHolderStore();
  await store.putSession(session());
  const verifier = createJeffHolderOsAuthorizationVerifier({
    store,
    ownershipResolver: {
      async resolveCurrentOwner() { return ownership(currentOwner, ownerEpoch); },
    },
    authorize,
    now: () => nowValue,
  });
  return { store, verifier };
}

test('holder OS authorization binds skills to a live session and owner epoch', async () => {
  const calls = [];
  const { verifier } = await configured({
    authorize(input) {
      calls.push(input);
      return input.operation === 'use_skill:holder.report:status'
        && input.scope.skillId === 'holder.report';
    },
  });
  const input = {
    scope: {
      skillId: 'holder.report',
      skillVersion: '1.0.0',
      manifestSha256: hashJeffBrainValue('manifest'),
      operation: 'status',
      inputSha256: hashJeffBrainValue({ tokenId: '7' }),
      mode: 'read_only',
    },
    subject: `session:${sessionId}`,
    operation: 'use_skill:holder.report:status',
    ownerEpoch: 4,
  };
  const attestation = await verifier.attest(input);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].session.wallet, wallet);
  assert.equal(validateJeffAuthorizationAttestation(attestation, {
    scope: input.scope,
    operation: input.operation,
    ownerEpoch: input.ownerEpoch,
    subjectSha256: hashJeffBrainValue(input.subject),
  }), true);
});

test('holder OS authorization rejects unapproved operations and caller epoch drift', async () => {
  const { verifier } = await configured({ authorize: () => false });
  await assert.rejects(verifier.attest({
    scope: { scheduleSha256: hashJeffBrainValue('schedule') },
    subject: `session:${sessionId}`,
    operation: 'run_schedule',
    ownerEpoch: 4,
  }), /JEFF_HOLDER_OS_AUTHORIZATION_DENIED/);

  const approved = (await configured()).verifier;
  await assert.rejects(approved.attest({
    scope: { scheduleSha256: hashJeffBrainValue('schedule') },
    subject: `session:${sessionId}`,
    operation: 'run_schedule',
    ownerEpoch: 5,
  }), /JEFF_HOLDER_OS_AUTHORIZATION_DENIED/);
  await assert.rejects(approved.attest({
    scope: {},
    subject: `session:${sessionId}`,
    operation: 'execute_wallet_transaction',
    ownerEpoch: 4,
  }), /JEFF_HOLDER_OS_AUTHORIZATION_DENIED/);
});

test('holder OS authorization revokes the session when ownership changes', async () => {
  const { store, verifier } = await configured({
    currentOwner: '0x4444444444444444444444444444444444444444',
    ownerEpoch: 5,
  });
  await assert.rejects(verifier.attest({
    scope: { messageSha256: hashJeffBrainValue('message') },
    subject: `session:${sessionId}`,
    operation: 'route_agent_message',
    ownerEpoch: 4,
  }), /JEFF_HOLDER_OWNERSHIP_CHANGED/);
  const revoked = await store.getSession(sessionId);
  assert.equal(revoked.status, 'revoked');
  assert.equal(revoked.revocationReason, 'ownership_changed');
});
