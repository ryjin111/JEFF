import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  commitJeffMemoryRecord,
  deriveJeffMemoryOwnerScope,
  deriveJeffMemoryRoot,
  JEFF_MEMORY_CONTRACT,
  prepareJeffMemoryRecord,
  reviewJeffMemoryProposal,
  verifyJeffMemoryReceipt,
} from '../api/_lib/jeff-memory-layer.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const canonicalize = (value) => {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = canonicalize(value[key]);
    return result;
  }, {});
};
const canonicalSha256 = (value) => sha256(JSON.stringify(canonicalize(value)));
const agentNft = Object.freeze({
  chainId: 8453,
  collection: '0x0000000000000000000000000000000000000001',
  tokenId: '7',
  account: '0x0000000000000000000000000000000000000002',
});
const provenance = Object.freeze({ verified: true, sourceCount: 3, independentPrimarySources: 2 });
const currentOwner = '0x0000000000000000000000000000000000000003';
const ownerEpoch = 4;
const ownerScopeSha256 = deriveJeffMemoryOwnerScope({ agentNft, currentOwner, ownerEpoch });
const previousRootSha256 = sha256('root-1');
const contentSha256 = sha256('verified-public-memory');
const testNowMs = Date.now();
const capturedAt = new Date(testNowMs - 10 * 60 * 1_000).toISOString();
const expiresAt = new Date(testNowMs + 24 * 60 * 60 * 1_000).toISOString();
const rootSha256 = deriveJeffMemoryRoot({
  previousRootSha256,
  contentSha256,
  sequence: 2,
  scope: 'public',
  ownerScopeSha256,
  provenance,
  capturedAt,
  expiresAt,
});
const baseProposal = Object.freeze({
  schema: 'jeff-memory-proposal-v1',
  agentNft,
  memory: Object.freeze({
    contentSha256,
    rootSha256,
    previousRootSha256,
    currentRootSha256: previousRootSha256,
    currentSequence: 1,
    proposedSequence: 2,
    scope: 'public',
    capturedAt,
    expiresAt,
    rawIncluded: false,
    containsOwnerPrivateContent: false,
    provenance,
  }),
  ownership: Object.freeze({
    currentOwner,
    ownerEpoch,
    ownerScopeSha256,
    ownerVerified: true,
    requesterAuthorized: true,
    ownerChanged: false,
    previousOwnerAccessRevoked: true,
  }),
});
const observedAt = new Date(testNowMs - 30 * 1_000).toISOString();

function trustedOwnershipResolver({
  owner = currentOwner,
  epoch = ownerEpoch,
  attestedAt,
} = {}) {
  return {
    async resolveCurrentOwner(resolvedAgentNft) {
      return {
        schema: 'jeff-memory-ownership-attestation-v1',
        agentNftSha256: canonicalSha256(resolvedAgentNft),
        currentOwner: owner,
        ownerEpoch: epoch,
        observedAt: attestedAt ?? new Date().toISOString(),
      };
    },
  };
}

function rebindProposal(proposal) {
  proposal.ownership.ownerScopeSha256 = deriveJeffMemoryOwnerScope({
    agentNft: proposal.agentNft,
    currentOwner: proposal.ownership.currentOwner,
    ownerEpoch: proposal.ownership.ownerEpoch,
  });
  proposal.memory.rootSha256 = deriveJeffMemoryRoot({
    previousRootSha256: proposal.memory.previousRootSha256,
    contentSha256: proposal.memory.contentSha256,
    sequence: proposal.memory.proposedSequence,
    scope: proposal.memory.scope,
    ownerScopeSha256: proposal.ownership.ownerScopeSha256,
    provenance: proposal.memory.provenance,
    capturedAt: proposal.memory.capturedAt,
    expiresAt: proposal.memory.expiresAt,
  });
  return proposal;
}

test('verified hash-only memory can be prepared for owner-approved persistence', async () => {
  const reviewed = reviewJeffMemoryProposal(baseProposal, { observedAt });
  assert.equal(reviewed.response.answers.memory_action.choice, 'persist');
  assert.equal(reviewed.response.answers.authority.choice, 'owner_review');
  assert.equal(reviewed.receipt.commitAllowed, true);
  assert.equal(reviewed.receipt.executionAuthorized, false);
  assert.equal(verifyJeffMemoryReceipt(reviewed.receipt, baseProposal), true);

  const record = prepareJeffMemoryRecord(baseProposal, reviewed.receipt);
  let stored = null;
  const adapter = {
    async put(value) {
      stored = value;
      return {
        schema: 'jeff-memory-storage-ack-v1',
        recordSha256: value.recordSha256,
        referenceSha256: sha256(value.recordSha256),
      };
    },
  };
  await assert.rejects(commitJeffMemoryRecord(record, adapter), /JEFF_MEMORY_OWNER_APPROVAL_REQUIRED/);
  const storageReceipt = await commitJeffMemoryRecord(record, adapter, trustedOwnershipResolver(), {
    ownerApproved: true,
    proposal: baseProposal,
    reviewReceipt: reviewed.receipt,
  });
  assert.equal(stored.recordSha256, record.recordSha256);
  assert.equal(storageReceipt.executionAuthorized, false);
  assert.equal(storageReceipt.ownerApproved, true);
  assert.match(storageReceipt.ownershipAttestationSha256, /^[a-f0-9]{64}$/);
  assert.ok(Date.parse(storageReceipt.committedAt) >= testNowMs);
});

test('raw owner-private memory is discarded and cannot become a record', () => {
  const canary = 'owner-private-value-that-must-never-appear';
  const proposal = structuredClone(baseProposal);
  proposal.memory.contentSha256 = sha256(canary);
  proposal.memory.rawIncluded = true;
  proposal.memory.containsOwnerPrivateContent = true;
  rebindProposal(proposal);
  const reviewed = reviewJeffMemoryProposal(proposal, { observedAt });
  assert.equal(reviewed.response.answers.memory_action.choice, 'discard');
  assert.equal(reviewed.response.answers.authority.choice, 'deny');
  assert.equal(reviewed.receipt.commitAllowed, false);
  assert.equal(JSON.stringify(reviewed).includes(canary), false);
  assert.throws(() => prepareJeffMemoryRecord(proposal, reviewed.receipt), /JEFF_MEMORY_COMMIT_NOT_ALLOWED/);
});

test('expired, unverified, or sequence-invalid memory is quarantined', () => {
  const variants = [
    (proposal) => { proposal.memory.expiresAt = new Date(testNowMs - 60 * 1_000).toISOString(); },
    (proposal) => { proposal.memory.provenance.verified = false; },
    (proposal) => { proposal.memory.proposedSequence = 3; },
    (proposal) => { proposal.memory.previousRootSha256 = sha256('wrong-root'); },
    (proposal) => {
      proposal.ownership.ownerChanged = true;
      proposal.ownership.previousOwnerAccessRevoked = false;
      proposal.memory.scope = 'current-owner-only';
    },
  ];
  for (const mutate of variants) {
    const proposal = structuredClone(baseProposal);
    mutate(proposal);
    rebindProposal(proposal);
    const reviewed = reviewJeffMemoryProposal(proposal, { observedAt });
    assert.equal(reviewed.response.answers.memory_action.choice, 'quarantine');
    assert.equal(reviewed.response.answers.authority.choice, 'deny');
    assert.equal(reviewed.receipt.commitAllowed, false);
  }
});

test('memory receipts reject proposal or receipt tampering', () => {
  const reviewed = reviewJeffMemoryProposal(baseProposal, { observedAt });
  const changedProposal = structuredClone(baseProposal);
  changedProposal.memory.rootSha256 = sha256('changed-root');
  assert.equal(verifyJeffMemoryReceipt(reviewed.receipt, changedProposal), false);
  assert.equal(verifyJeffMemoryReceipt({ ...reviewed.receipt, commitAllowed: false }, baseProposal), false);
});

test('owner scope and derived root are required and transfer-bound', () => {
  const arbitraryRoot = structuredClone(baseProposal);
  arbitraryRoot.memory.rootSha256 = sha256('caller-chosen-root');
  assert.throws(() => reviewJeffMemoryProposal(arbitraryRoot, { observedAt }), /JEFF_MEMORY_PROPOSAL_INVALID/);

  const wrongOwnerScope = structuredClone(baseProposal);
  wrongOwnerScope.ownership.ownerScopeSha256 = sha256('wrong-owner-cycle');
  assert.throws(() => reviewJeffMemoryProposal(wrongOwnerScope, { observedAt }), /JEFF_MEMORY_PROPOSAL_INVALID/);

  const reviewed = reviewJeffMemoryProposal(baseProposal, { observedAt });
  const record = prepareJeffMemoryRecord(baseProposal, reviewed.receipt);
  assert.equal(record.ownerScopeSha256, ownerScopeSha256);
  assert.equal(reviewed.receipt.ownerScopeSha256, ownerScopeSha256);
});

test('commit rejects expired reviews and authoritative post-transfer ownership before storage', async () => {
  const reviewed = reviewJeffMemoryProposal(baseProposal, { observedAt });
  const record = prepareJeffMemoryRecord(baseProposal, reviewed.receipt);
  const staleReviewed = reviewJeffMemoryProposal(baseProposal, {
    observedAt: new Date(testNowMs - 6 * 60 * 1_000).toISOString(),
  });
  const staleRecord = prepareJeffMemoryRecord(baseProposal, staleReviewed.receipt);
  let adapterCalls = 0;
  const adapter = { async put() { adapterCalls += 1; throw new Error('must not run'); } };
  const reviewBinding = { proposal: baseProposal, reviewReceipt: reviewed.receipt };

  await assert.rejects(commitJeffMemoryRecord(staleRecord, adapter, trustedOwnershipResolver(), {
    ownerApproved: true,
    proposal: baseProposal,
    reviewReceipt: staleReviewed.receipt,
  }), /JEFF_MEMORY_REVIEW_STALE/);
  await assert.rejects(commitJeffMemoryRecord(record, adapter, trustedOwnershipResolver({
    owner: '0x0000000000000000000000000000000000000004',
    epoch: ownerEpoch + 1,
  }), {
    ownerApproved: true,
    ...reviewBinding,
  }), /JEFF_MEMORY_CURRENT_OWNER_SCOPE_MISMATCH/);
  await assert.rejects(commitJeffMemoryRecord(record, adapter, trustedOwnershipResolver(), {
    ownerApproved: true,
    proposal: baseProposal,
    reviewReceipt: { ...reviewed.receipt, commitAllowed: false },
  }), /JEFF_MEMORY_COMMIT_RECEIPT_INVALID/);
  await assert.rejects(commitJeffMemoryRecord(record, adapter, trustedOwnershipResolver({
    attestedAt: new Date(testNowMs - 61 * 1_000).toISOString(),
  }), {
    ownerApproved: true,
    ...reviewBinding,
  }), /JEFF_MEMORY_OWNERSHIP_ATTESTATION_STALE/);
  assert.equal(adapterCalls, 0);
});

test('storage acknowledgement must exactly echo the committed record', async () => {
  const reviewed = reviewJeffMemoryProposal(baseProposal, { observedAt });
  const record = prepareJeffMemoryRecord(baseProposal, reviewed.receipt);
  const options = {
    ownerApproved: true,
    proposal: baseProposal,
    reviewReceipt: reviewed.receipt,
  };
  const acknowledgements = [
    { schema: 'jeff-memory-storage-ack-v1', recordSha256: sha256('other'), referenceSha256: sha256('ref') },
    { schema: 'wrong-schema', recordSha256: record.recordSha256, referenceSha256: sha256('ref') },
    {
      schema: 'jeff-memory-storage-ack-v1',
      recordSha256: record.recordSha256,
      referenceSha256: sha256('ref'),
      extra: true,
    },
  ];
  for (const acknowledgement of acknowledgements) {
    await assert.rejects(
      commitJeffMemoryRecord(
        record,
        { async put() { return acknowledgement; } },
        trustedOwnershipResolver(),
        options,
      ),
      /JEFF_MEMORY_ADAPTER_RECEIPT_INVALID/,
    );
  }
});

test('caller cannot backdate commit of an expired historical record', async () => {
  const historicalProposal = structuredClone(baseProposal);
  historicalProposal.memory.capturedAt = '2026-01-01T00:00:00.000Z';
  historicalProposal.memory.expiresAt = '2026-01-31T00:00:00.000Z';
  rebindProposal(historicalProposal);
  const historicalReview = reviewJeffMemoryProposal(historicalProposal, {
    observedAt: '2026-01-02T00:00:00.000Z',
  });
  const historicalRecord = prepareJeffMemoryRecord(historicalProposal, historicalReview.receipt);
  let adapterCalls = 0;
  const adapter = { async put() { adapterCalls += 1; throw new Error('must not run'); } };
  const options = {
    ownerApproved: true,
    proposal: historicalProposal,
    reviewReceipt: historicalReview.receipt,
  };

  await assert.rejects(commitJeffMemoryRecord(
    historicalRecord,
    adapter,
    trustedOwnershipResolver(),
    { ...options, committedAt: '2026-01-02T00:01:00.000Z' },
  ), /JEFF_MEMORY_CALLER_TIME_FORBIDDEN/);
  await assert.rejects(commitJeffMemoryRecord(
    historicalRecord,
    adapter,
    trustedOwnershipResolver(),
    options,
  ), /JEFF_MEMORY_REVIEW_STALE/);
  assert.equal(adapterCalls, 0);
});

test('undeclared proposal fields and oversized token ids fail closed', () => {
  const rawSmuggling = structuredClone(baseProposal);
  rawSmuggling.memory.rawContent = 'must-not-cross-the-boundary';
  assert.throws(() => reviewJeffMemoryProposal(rawSmuggling, { observedAt }), /JEFF_MEMORY_PROPOSAL_INVALID/);

  const oversizedToken = structuredClone(baseProposal);
  oversizedToken.agentNft.tokenId = (1n << 256n).toString();
  assert.throws(() => reviewJeffMemoryProposal(oversizedToken, { observedAt }), /JEFF_MEMORY_PROPOSAL_INVALID/);
});

test('storage adapter rejects records with undeclared fields', async () => {
  const reviewed = reviewJeffMemoryProposal(baseProposal, { observedAt });
  const record = prepareJeffMemoryRecord(baseProposal, reviewed.receipt);
  const smuggled = { ...record, rawContent: 'must-not-reach-storage' };
  await assert.rejects(
    commitJeffMemoryRecord(
      smuggled,
      { async put() { throw new Error('adapter must not run'); } },
      trustedOwnershipResolver(),
      {
        ownerApproved: true,
        proposal: baseProposal,
        reviewReceipt: reviewed.receipt,
      },
    ),
    /JEFF_MEMORY_RECORD_INVALID/,
  );
});

test('memory contract stays backend-neutral and shadow-only', () => {
  assert.deepEqual(JEFF_MEMORY_CONTRACT.scopes, ['public', 'current-owner-only']);
  assert.equal(JEFF_MEMORY_CONTRACT.rawMemoryAccepted, false);
  assert.equal(JEFF_MEMORY_CONTRACT.executionAuthorized, false);
});
