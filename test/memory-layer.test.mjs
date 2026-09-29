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
const capturedAt = '2026-09-29T00:00:00.000Z';
const expiresAt = '2026-10-29T00:00:00.000Z';
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
const observedAt = '2026-09-30T00:00:00.000Z';
const committedAt = '2026-09-30T00:01:00.000Z';

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
  const storageReceipt = await commitJeffMemoryRecord(record, adapter, {
    ownerApproved: true,
    committedAt,
    ownerScope: { currentOwner, ownerEpoch },
    proposal: baseProposal,
    reviewReceipt: reviewed.receipt,
  });
  assert.equal(stored.recordSha256, record.recordSha256);
  assert.equal(storageReceipt.executionAuthorized, false);
  assert.equal(storageReceipt.ownerApproved, true);
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
    (proposal) => { proposal.memory.expiresAt = '2026-09-29T12:00:00.000Z'; },
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

test('commit rejects expired reviews and changed owner epochs before storage', async () => {
  const reviewed = reviewJeffMemoryProposal(baseProposal, { observedAt });
  const record = prepareJeffMemoryRecord(baseProposal, reviewed.receipt);
  let adapterCalls = 0;
  const adapter = { async put() { adapterCalls += 1; throw new Error('must not run'); } };
  const reviewBinding = { proposal: baseProposal, reviewReceipt: reviewed.receipt };

  await assert.rejects(commitJeffMemoryRecord(record, adapter, {
    ownerApproved: true,
    committedAt: '2026-09-30T00:05:00.000Z',
    ownerScope: { currentOwner, ownerEpoch },
    ...reviewBinding,
  }), /JEFF_MEMORY_REVIEW_STALE/);
  await assert.rejects(commitJeffMemoryRecord(record, adapter, {
    ownerApproved: true,
    committedAt,
    ownerScope: { currentOwner, ownerEpoch: ownerEpoch + 1 },
    ...reviewBinding,
  }), /JEFF_MEMORY_CURRENT_OWNER_SCOPE_MISMATCH/);
  await assert.rejects(commitJeffMemoryRecord(record, adapter, {
    ownerApproved: true,
    committedAt,
    ownerScope: { currentOwner, ownerEpoch },
    proposal: baseProposal,
    reviewReceipt: { ...reviewed.receipt, commitAllowed: false },
  }), /JEFF_MEMORY_COMMIT_RECEIPT_INVALID/);
  assert.equal(adapterCalls, 0);
});

test('storage acknowledgement must exactly echo the committed record', async () => {
  const reviewed = reviewJeffMemoryProposal(baseProposal, { observedAt });
  const record = prepareJeffMemoryRecord(baseProposal, reviewed.receipt);
  const options = {
    ownerApproved: true,
    committedAt,
    ownerScope: { currentOwner, ownerEpoch },
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
      commitJeffMemoryRecord(record, { async put() { return acknowledgement; } }, options),
      /JEFF_MEMORY_ADAPTER_RECEIPT_INVALID/,
    );
  }
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
    commitJeffMemoryRecord(smuggled, { async put() { throw new Error('adapter must not run'); } }, {
      ownerApproved: true,
      committedAt,
      ownerScope: { currentOwner, ownerEpoch },
      proposal: baseProposal,
      reviewReceipt: reviewed.receipt,
    }),
    /JEFF_MEMORY_RECORD_INVALID/,
  );
});

test('memory contract stays backend-neutral and shadow-only', () => {
  assert.deepEqual(JEFF_MEMORY_CONTRACT.scopes, ['public', 'current-owner-only']);
  assert.equal(JEFF_MEMORY_CONTRACT.rawMemoryAccepted, false);
  assert.equal(JEFF_MEMORY_CONTRACT.executionAuthorized, false);
});
