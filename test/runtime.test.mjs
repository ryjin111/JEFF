import assert from 'node:assert/strict';
import test from 'node:test';

import { JEFF_AGENT_NFT_CAPABILITY_QUESTIONS } from '../api/_lib/jeff-agent-nft-capabilities.mjs';
import { inferJeffAgentNftPromoted, JEFF_PROMOTED_MODEL } from '../api/_lib/jeff-agent-nft-promoted.mjs';

const request = {
  agentNft: {
    chainId: 1,
    collection: '0x0000000000000000000000000000000000000001',
    tokenId: '1',
    account: '0x0000000000000000000000000000000000000002',
  },
  state: {
    proposal: 'Read the verified token-bound account state.',
    authorized: true,
    provenanceVerified: true,
    dataFresh: true,
    evidence: [{ verified: true }],
    ownerPolicy: { allowAutonomous: false },
  },
  questions: JEFF_AGENT_NFT_CAPABILITY_QUESTIONS,
};

test('promoted loader is bound to the passing sealed receipt', () => {
  assert.equal(JEFF_PROMOTED_MODEL.model, 'jeff-agent-nft-nb-v0.5-evidence');
  assert.equal(JEFF_PROMOTED_MODEL.promotionReceipt, 'jeff-agent-nft-protocol-blind-v3');
  assert.equal(JEFF_PROMOTED_MODEL.observedAccuracy, 0.939815);
  assert.equal(JEFF_PROMOTED_MODEL.mode, 'shadow');
  assert.equal(JEFF_PROMOTED_MODEL.executionAuthorized, false);
});

test('promoted runtime returns all typed decisions without execution authority', () => {
  const response = inferJeffAgentNftPromoted(request);
  assert.equal(response.model, JEFF_PROMOTED_MODEL.model);
  assert.equal(response.mode, 'shadow');
  assert.equal(response.executionAuthorized, false);
  assert.deepEqual(Object.keys(response.answers), Object.keys(JEFF_AGENT_NFT_CAPABILITY_QUESTIONS));
});
