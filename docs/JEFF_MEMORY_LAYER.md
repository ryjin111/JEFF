# JEFF memory layer

JEFF now exposes a backend-neutral memory decision layer for Agent NFTs. It does not store raw conversation text or owner-private content. It reviews hash-only memory proposals, binds them to the current Agent NFT and owner state, and decides whether the memory should be persisted, summarized, quarantined, or discarded.

## Safety model

- Memory proposals contain content hashes, derived root hashes, sequence state, scope, expiry, provenance counts, and ownership evidence.
- Every proposal, receipt, and record carries an owner-scope hash derived from the Agent NFT, current owner, and transfer epoch.
- The memory root is derived from the previous root, content hash, sequence, scope, owner scope, provenance, capture time, and expiry. Caller-selected roots are rejected.
- Raw payloads and owner-private content are deterministically discarded.
- Expired, unverified, root-mismatched, sequence-invalid, or unsafe post-transfer memory is quarantined.
- Safety facts are complete and fail closed before the learned memory decision is accepted.
- Memory records remain hash-only and contain no submitted content.
- Storage is backend-neutral. An adapter receives a prepared record only after explicit owner approval, full proposal and review-receipt revalidation, a fresh review, and a commit-time owner-scope match from a trusted ownership resolver.
- The ownership resolver returns a fresh, exact-shape, Agent NFT-bound attestation. Request-supplied owner fields are never accepted as the current ownership source of truth.
- Adapter acknowledgements must use the exact schema, echo the committed record hash, and are hash-bound into the storage receipt.
- Storage approval does not authorize Agent NFT execution. Every review and storage receipt keeps `executionAuthorized: false`.

## Flow

1. Derive the owner scope with `deriveJeffMemoryOwnerScope` and the root with `deriveJeffMemoryRoot`, then build a `jeff-memory-proposal-v1` envelope containing only hashes and verified metadata.
2. Call `reviewJeffMemoryProposal` to receive JEFF's typed response and a hash-bound review receipt.
3. Call `prepareJeffMemoryRecord` only when the receipt permits persistence.
4. Present the record for explicit owner approval.
5. Call `commitJeffMemoryRecord(record, adapter, ownershipResolver, options)` with the proposal and review receipt, the canonical commit timestamp, and explicit owner approval. The resolver must independently obtain the authoritative current owner and transfer epoch.

The adapter can target an encrypted local store, a content-addressed network, an MCP memory provider, or another durable backend. It must return an exact-shape `jeff-memory-storage-ack-v1` acknowledgement containing the record hash and reference hash. This commitment layer does not itself provide decryptable recall. Authorized encrypted recall is a separate brain-layer adapter.

This layer is separate from the frozen v0.9 production shadow soak. It does not modify the soak candidate or its receipts.
