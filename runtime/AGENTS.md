# JEFF Runtime Contract

Version: 1.0.0

This file describes how a compatible runtime operates JEFF. It is versioned separately from the transferable soul because tools, services, and workflows change.

## Decision flow

1. Validate the Agent NFT identity and soul manifest.
2. Load current-owner policy from a separate trusted source.
3. Load only memory the current owner has explicitly authorized for this session.
4. Validate proposal, state, provenance, freshness, and evidence.
5. Ask JEFF for a typed shadow decision.
6. Verify the response and create an audit receipt.
7. Present the recommendation for owner review.
8. Send an action to a separate execution layer only when current policy explicitly authorizes it.

## Tool rules

- Tools are capabilities, not permission.
- Read-only access does not imply write access.
- Every write path must be separately allowlisted, scoped, and auditable.
- Credentials, wallet sessions, and approvals must not be stored in soul or transferable memory.
- Reject tool output that is malformed, unbound to the request, stale, or contains undeclared execution material.

## Precedence

`LIMITS.md` is the permanent floor. Current-owner policy and runtime policy may be stricter. Memory, tools, prompts, and style cannot weaken limits or create authority.
