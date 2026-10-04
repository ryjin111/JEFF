# Agent NFT OS completion gates

This checklist defines complete as a production-capable Agent NFT operating system with a read-only default and separately gated action authority.

## Complete and live

- Agent NFT identity and current-holder wallet proof
- Signed soul verification
- Owner-epoch sessions and transfer revocation
- Encrypted owner-approved memory
- JEFF shadow reasoning and supervised holder status reads
- Signed holder receipts
- Same-origin HTTP boundary, secure cookies, strict envelopes, shared rate limits, and sanitized errors
- Holder web interface

## Implemented control-plane foundation

- Hash-bound, server-registered skills with no arbitrary package loading
- Read-only, simulation, and prepare-only modes
- Owner-scoped authorization for every skill call
- Bounded schedules with atomic run reservations and zero-authority receipts
- Replay-safe Agent NFT coordination envelopes with no delegated authority
- Durable PostgreSQL stores and migration for schedules and messages

## Production integration gates

- Run and memory acceptance with a real holder on the production origin
- Logout and session revocation acceptance
- Ownership-transfer revocation drill with a disposable test Room
- Apply the control-plane PostgreSQL migration
- Register and deploy the initial reviewed skills
- Connect reviewed scheduling and coordination UI controls
- Database backup and restore drill
- Memory and receipt key rotation drill
- Incident kill-switch drill and alert verification
- 24 to 48 hour production soak
- Separate dependency upgrade for remaining moderate wallet-stack advisories

## Separately approved action phase

No action adapter is part of the read-only completion gate. Each action capability needs a separate threat model, policy, simulation, durable idempotency, quota, emergency stop, reconciliation procedure, canary, independent review, and explicit owner approval before production enablement.
