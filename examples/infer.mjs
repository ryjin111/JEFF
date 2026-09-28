import { inferJeffAgentNftPromoted, JEFF_PROMOTED_MODEL } from '../api/_lib/jeff-agent-nft-promoted.mjs';
import { JEFF_AGENT_NFT_CAPABILITY_QUESTIONS } from '../api/_lib/jeff-agent-nft-capabilities.mjs';

const request = {
  agentNft: {
    chainId: 1,
    collection: '0x0000000000000000000000000000000000000001',
    tokenId: '1',
    account: '0x0000000000000000000000000000000000000002',
  },
  state: {
    proposal: 'Read the verified token-bound account state and prepare a summary for owner review.',
    authorized: true,
    provenanceVerified: true,
    dataFresh: true,
    evidence: [{ verified: true }],
    ownerPolicy: { allowAutonomous: false },
  },
  questions: JEFF_AGENT_NFT_CAPABILITY_QUESTIONS,
};

const result = inferJeffAgentNftPromoted(request);
process.stdout.write(`${JSON.stringify({ model: JEFF_PROMOTED_MODEL, result }, null, 2)}\n`);
