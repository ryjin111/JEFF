import assert from 'node:assert/strict';
import test from 'node:test';

import {
  JEFF_REVIEW_CONTRACT,
  reviewJeffAgentNft,
  verifyJeffReviewReceipt,
} from 'jeff-agent-nft/review';

const request = {
  agentNft: {
    chainId: 1,
    collection: '0x0000000000000000000000000000000000000001',
    tokenId: '1',
    account: '0x0000000000000000000000000000000000000002',
  },
  state: {
    proposal: 'Review a verified read-only portfolio summary.',
    provenanceVerified: true,
    dataFresh: true,
    evidence: [{ source: 'portfolio-indexer', verified: true }],
    ownerPolicy: { allowAutonomous: false },
    privateMemory: 'receipt-must-not-copy-this-value',
  },
};

test('review helper returns a typed shadow response and privacy-preserving receipt', () => {
  const { response, receipt } = reviewJeffAgentNft(request);

  assert.equal(response.mode, 'shadow');
  assert.equal(response.executionAuthorized, false);
  assert.equal(receipt.schema, 'jeff-review-receipt-v1');
  assert.equal(receipt.executionAuthorized, false);
  assert.equal(receipt.externalPolicyRequired, true);
  assert.match(receipt.requestSha256, /^[a-f0-9]{64}$/);
  assert.match(receipt.responseSha256, /^[a-f0-9]{64}$/);
  assert.match(receipt.receiptSha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(receipt).includes('receipt-must-not-copy-this-value'), false);
  assert.equal(verifyJeffReviewReceipt(receipt, request, response), true);
});

test('review helper is deterministic and verifies the exact request and response', () => {
  const first = reviewJeffAgentNft(request);
  const second = reviewJeffAgentNft(request);

  assert.deepEqual(first, second);
  assert.equal(verifyJeffReviewReceipt(first.receipt, request, first.response), true);
  assert.equal(JEFF_REVIEW_CONTRACT.executionAuthorized, false);
});

test('receipt verification rejects response tampering', () => {
  const reviewed = reviewJeffAgentNft(request);
  const tampered = structuredClone(reviewed.response);
  tampered.answers.next_action.confidence = 0;

  assert.equal(verifyJeffReviewReceipt(reviewed.receipt, request, tampered), false);
});

test('review helper rejects invalid requests before inference', () => {
  assert.throws(
    () => reviewJeffAgentNft({ state: { proposal: () => 'not JSON' } }),
    /JEFF_REVIEW_REQUEST_INVALID/,
  );
});
