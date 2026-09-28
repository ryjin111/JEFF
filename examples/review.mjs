import { reviewJeffAgentNft } from '../api/_lib/jeff-review.mjs';

const { response, receipt } = reviewJeffAgentNft({
  agentNft: {
    chainId: 1,
    collection: '0x0000000000000000000000000000000000000001',
    tokenId: '1',
    account: '0x0000000000000000000000000000000000000002',
  },
  state: {
    proposal: 'Review a read-only portfolio report before it reaches the owner.',
    provenanceVerified: true,
    dataFresh: true,
    evidence: [{ source: 'portfolio-indexer', verified: true }],
    ownerPolicy: { allowAutonomous: false },
  },
});

process.stdout.write(`${JSON.stringify({
  decision: response.answers.next_action,
  risk: response.answers.risk,
  receipt,
}, null, 2)}\n`);
