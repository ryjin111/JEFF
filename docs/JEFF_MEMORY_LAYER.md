# JEFF memory layer

JEFF now exposes a backend-neutral memory decision layer for Agent NFTs. It does not store raw conversation text or owner-private content. It reviews hash-only memory proposals, binds them to the current Agent NFT and owner state, and decides whether the memory should be persisted, summarized, quarantined, or discarded.

## Safety model

- Memory proposals contain content hashes, root hashes, sequence state, scope, expiry, provenance counts, and ownership evidence.
- Raw payloads and owner-private content are deterministically discarded.
- Expired, unverified, root-mismatched, sequence-invalid, or unsafe post-transfer memory is quarantined.
- Safety facts are complete and fail closed before the learned memory decision is accepted.
- Memory records remain hash-only and contain no submitted content.
- Storage is backend-neutral. An adapter receives a prepared record only after explicit owner approval.
- Storage approval does not authorize Agent NFT execution. Every review and storage receipt keeps `executionAuthorized: false`.

## Flow

1. Build a `jeff-memory-proposal-v1` envelope containing only hashes and verified metadata.
2. Call `reviewJeffMemoryProposal` to receive JEFF's typed response and a hash-bound review receipt.
3. Call `prepareJeffMemoryRecord` only when the receipt permits persistence.
4. Present the record for explicit owner approval.
5. Call `commitJeffMemoryRecord` with a backend adapter and `{ ownerApproved: true }`.

The adapter can target an encrypted local store, a content-addressed network, an MCP memory provider, or another durable backend. JEFF depends only on the hash-only record contract and the adapter's hash receipt.

This layer is separate from the frozen v0.9 production shadow soak. It does not modify the soak candidate or its receipts.
