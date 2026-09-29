import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  commitJeffMemoryRecord,
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
const baseProposal = Object.freeze({
  schema: 'jeff-memory-proposal-v1',
  agentNft,
  memory: Object.freeze({
    contentSha256: sha256('verified-public-memory'),
    rootSha256: sha256('root-2'),
    previousRootSha256: sha256('root-1'),
    currentRootSha256: sha256('root-1'),
    currentSequence: 1,
    proposedSequence: 2,
    scope: 'public',
    capturedAt: '2026-09-29T00:00:00.000Z',
    expiresAt: '2026-10-29T00:00:00.000Z',
    rawIncluded: false,
    containsOwnerPrivateContent: false,
    provenance: Object.freeze({ verified: true, sourceCount: 3, independentPrimarySources: 2 }),
  }),
  ownership: Object.freeze({
    currentOwner: '0x0000000000000000000000000000000000000003',
    ownerVerified: true,
    requesterAuthorized: true,
    ownerChanged: false,
    previousOwnerAccessRevoked: true,
  }),
});
const observedAt = '2026-09-30T00:00:00.000Z';

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
      return { referenceSha256: sha256(value.recordSha256) };
    },
  };
  await assert.rejects(commitJeffMemoryRecord(record, adapter), /JEFF_MEMORY_OWNER_APPROVAL_REQUIRED/);
  const storageReceipt = await commitJeffMemoryRecord(record, adapter, { ownerApproved: true });
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
    commitJeffMemoryRecord(smuggled, { async put() { throw new Error('adapter must not run'); } }, { ownerApproved: true }),
    /JEFF_MEMORY_RECORD_INVALID/,
  );
});

test('memory contract stays backend-neutral and shadow-only', () => {
  assert.deepEqual(JEFF_MEMORY_CONTRACT.scopes, ['public', 'current-owner-only']);
  assert.equal(JEFF_MEMORY_CONTRACT.rawMemoryAccepted, false);
  assert.equal(JEFF_MEMORY_CONTRACT.executionAuthorized, false);
});
