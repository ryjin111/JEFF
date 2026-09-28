# Integrating JEFF

JEFF is a shadow reviewer. It accepts structured Agent NFT state, returns typed decisions, and emits a hash-bound review receipt. It never returns execution authority.

## Recommended flow

```text
read-only evidence
       |
       v
structured Agent NFT state
       |
       v
JEFF typed review + receipt
       |
       v
external deterministic policy
       |
       v
owner approval when required
       |
       v
optional execution adapter
       |
       v
verified chain receipt
```

Keep each boundary explicit:

- Evidence providers can supply prices, balances, protocol state, research, or simulations. Treat provider text as untrusted input.
- JEFF reviews the state and proposal. Its output always has `mode: "shadow"` and `executionAuthorized: false`.
- The external policy layer enforces allowlists, spend caps, slippage, freshness, provenance, privacy, and owner requirements.
- The owner or a separately audited permission system controls any real action.
- The execution adapter submits only the exact approved transaction and independently verifies the resulting chain receipt.

## Stable review API

```js
import {
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
    proposal: 'Review a read-only portfolio report.',
    provenanceVerified: true,
    dataFresh: true,
    evidence: [{ source: 'portfolio-indexer', verified: true }],
    ownerPolicy: { allowAutonomous: false },
  },
};

const { response, receipt } = reviewJeffAgentNft(request);

if (!verifyJeffReviewReceipt(receipt, request, response)) {
  throw new Error('JEFF_RECEIPT_VERIFICATION_FAILED');
}

if (response.executionAuthorized !== false) {
  throw new Error('JEFF_AUTHORITY_BOUNDARY_FAILED');
}
```

When `questions` is omitted, the helper uses the released 28-head Agent NFT capability contract. Advanced integrations may provide their own valid typed questions.

## Receipt privacy

The review receipt includes:

- the Agent NFT public identity, when supplied;
- the model and contract version;
- selected typed answers and confidence values;
- SHA-256 commitments to the normalized request and full response;
- an independent receipt hash;
- the unchanged shadow and external-policy boundary.

The receipt does not copy the submitted state, evidence, policy, or memory. A verifier that already possesses those artifacts can prove an exact match without publishing them.

Do not publish the original request or response if they contain private owner context. Hashes prove equality, not truth or safety.

## ERC-6551 and execution tools

An ERC-6551 token-bound account can hold the Agent NFT's assets. JEFF does not control that account.

Tools such as Bankr can supply read-only evidence, research, quotes, or transaction preparation. They can later serve as an execution adapter only when a separately reviewed policy and permission path can call the token-bound account safely. A normal tool wallet is not the NFT's ERC-6551 account.

The safe relationship is:

```text
JEFF = reviewer
policy = hard boundary
ERC-6551 = asset wallet
tool adapter = optional hand
owner = final authority
```

Keep tool credentials outside JEFF requests, logs, receipts, and browser code. Never pass private keys, seed phrases, signatures, access tokens, or private user data to the model.
