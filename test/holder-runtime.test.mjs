import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';

import { createInMemoryJeffMemoryAdapter } from '../api/_lib/jeff-authorized-memory.mjs';
import { hashJeffBrainValue } from '../api/_lib/jeff-brain-common.mjs';
import {
  createInMemoryJeffHolderStore,
  createJeffAesGcmMemoryCrypto,
  createJeffEd25519ReceiptSigner,
  createJeffEd25519ReceiptVerifier,
  createJeffHolderRuntime,
  verifyJeffHolderReceipt,
} from '../api/_lib/jeff-holder-runtime.mjs';

const nowValue = '2026-10-04T08:00:00.000Z';
const wallet = '0x1000000000000000000000000000000000000001';
const transferredWallet = '0x2000000000000000000000000000000000000002';
const agentNft = Object.freeze({
  chainId: 8453,
  collection: '0x3000000000000000000000000000000000000003',
  tokenId: '7',
  account: '0x4000000000000000000000000000000000000004',
});

function candidate(id) {
  return {
    id,
    title: `Candidate ${id}`,
    steps: ['Read verified holder status.', 'Prepare a bounded response.'],
    toolProposals: [{
      tool: 'holder.status',
      purpose: 'Confirm the current holder and Agent NFT identity.',
      input: { tokenId: agentNft.tokenId },
    }],
    expectedOutcome: 'A verified holder status summary is prepared.',
    risks: ['Ownership state can become stale.'],
    reversibility: 'The operation is read-only.',
  };
}

function createProvider() {
  const calls = [];
  return {
    model: 'jeff-holder-alpha-test-model',
    calls,
    async complete(input) {
      calls.push(input);
      if (input.phase === 'plan') {
        return {
          situation: 'The holder requested a safe Agent NFT status review.',
          unknowns: ['Ownership can change after this observation.'],
          candidates: [candidate('inspect'), candidate('wait')],
          recommendedCandidateId: 'inspect',
        };
      }
      return { candidateId: 'inspect', verdict: 'accept', issues: [] };
    },
  };
}

function createFixture() {
  const store = createInMemoryJeffHolderStore();
  const provider = createProvider();
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const signer = createJeffEd25519ReceiptSigner({ privateKey, keyId: 'holder-alpha-test' });
  const verifier = createJeffEd25519ReceiptVerifier({ publicKey, keyId: 'holder-alpha-test' });
  let currentOwner = wallet;
  let ownerEpoch = 1;
  const ownershipResolver = {
    async resolveCurrentOwner(subject) {
      return {
        schema: 'jeff-holder-ownership-attestation-v1',
        agentNftSha256: hashJeffBrainValue(subject),
        currentOwner,
        ownerEpoch,
        observedAt: nowValue,
      };
    },
  };
  const walletVerifier = {
    async verify(input) {
      return {
        schema: 'jeff-wallet-signature-verification-v1',
        wallet: input.wallet,
        challengeSha256: input.challengeSha256,
        verified: input.signature === 'valid-holder-signature',
        observedAt: nowValue,
      };
    },
  };
  const runtime = createJeffHolderRuntime({
    store,
    walletVerifier,
    ownershipResolver,
    provider,
    memoryAdapter: createInMemoryJeffMemoryAdapter(),
    memoryCrypto: createJeffAesGcmMemoryCrypto({ key: Buffer.alloc(32, 7) }),
    receiptSigner: signer,
    now: () => nowValue,
    nonce: () => 'a'.repeat(32),
    sessionId: () => 'b'.repeat(64),
  });
  return {
    store,
    provider,
    runtime,
    verifier,
    transfer() {
      currentOwner = transferredWallet;
      ownerEpoch += 1;
    },
  };
}

async function boot(runtime) {
  const challenge = await runtime.issueChallenge({
    domain: 'jeff.example',
    uri: 'https://jeff.example/holder',
    wallet,
    agentNft,
  });
  const session = await runtime.boot({
    challengeSha256: challenge.challengeSha256,
    signature: 'valid-holder-signature',
  });
  return { challenge, session };
}

test('holder alpha boots, remembers, reasons, and signs a shadow receipt', async () => {
  const fixture = createFixture();
  const { session } = await boot(fixture.runtime);
  const memory = await fixture.runtime.remember({
    sessionId: session.sessionId,
    id: 'holder_preference',
    content: 'Prefer concise status reports backed by verified ownership.',
    source: 'holder-approved-profile',
    expiresAt: '2026-11-04T08:00:00.000Z',
  });
  assert.equal(memory.schema, 'jeff-authorized-memory-record-v1');
  assert.notEqual(memory.ciphertext, 'Prefer concise status reports backed by verified ownership.');

  const output = await fixture.runtime.run({
    sessionId: session.sessionId,
    objective: 'Confirm my Agent NFT status and summarize the verified holder preference.',
  });

  assert.equal(output.result.mode, 'shadow');
  assert.equal(output.result.executionAuthorized, false);
  assert.equal(output.result.actionsExecuted, 0);
  assert.equal(output.result.audit.selectedMemoryRecordSha256s.length, 1);
  assert.equal(output.receipt.readOnlyToolsExecuted, 1);
  assert.equal(verifyJeffHolderReceipt(output.receipt, fixture.verifier), true);
  assert.equal(fixture.provider.calls.length, 2);
});

test('holder challenge is single-use even after a successful boot', async () => {
  const fixture = createFixture();
  const { challenge } = await boot(fixture.runtime);
  await assert.rejects(
    fixture.runtime.boot({
      challengeSha256: challenge.challengeSha256,
      signature: 'valid-holder-signature',
    }),
    /JEFF_HOLDER_CHALLENGE_CONSUMED_OR_UNKNOWN/,
  );
});

test('invalid wallet proof cannot boot a holder session', async () => {
  const fixture = createFixture();
  const challenge = await fixture.runtime.issueChallenge({
    domain: 'jeff.example',
    uri: 'https://jeff.example/holder',
    wallet,
    agentNft,
  });
  await assert.rejects(
    fixture.runtime.boot({
      challengeSha256: challenge.challengeSha256,
      signature: 'invalid-signature',
    }),
    /JEFF_HOLDER_SIGNATURE_INVALID/,
  );
});

test('ownership transfer revokes the old holder before memory or model access', async () => {
  const fixture = createFixture();
  const { session } = await boot(fixture.runtime);
  fixture.transfer();

  await assert.rejects(
    fixture.runtime.run({ sessionId: session.sessionId, objective: 'Read my holder status.' }),
    /JEFF_HOLDER_OWNERSHIP_CHANGED/,
  );
  assert.equal(fixture.provider.calls.length, 0);
  const snapshot = await fixture.store.snapshot();
  assert.equal(snapshot.sessions[0].status, 'revoked');
  assert.equal(snapshot.sessions[0].revocationReason, 'ownership_changed');
});

test('tampering invalidates the signed holder receipt', async () => {
  const fixture = createFixture();
  const { session } = await boot(fixture.runtime);
  const output = await fixture.runtime.run({
    sessionId: session.sessionId,
    objective: 'Confirm the current holder.',
  });
  assert.equal(verifyJeffHolderReceipt(output.receipt, fixture.verifier), true);
  assert.equal(verifyJeffHolderReceipt({ ...output.receipt, ownerEpoch: 99 }, fixture.verifier), false);
});
