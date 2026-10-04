# JEFF OS control plane

The JEFF OS control plane adds the reusable operating-system layer around the Holder runtime without changing JEFF's shadow-only authority boundary. It covers skills, bounded schedules, and Agent NFT coordination. It does not grant transaction authority.

## Skills

Each installed skill has a hash-bound manifest that fixes its identifier, version, integrity commitment, operations, mode, network posture, and approval requirement. Adapters are registered server-side and must bind to the exact manifest hash.

Supported modes are:

- `read_only`: inspect approved public or holder-authorized state;
- `simulate`: calculate an outcome without network access or external effects;
- `prepare_write`: prepare a proposal for owner review without executing it.

Every invocation requires a fresh server-controlled authorization attestation bound to the subject, owner epoch, skill, version, manifest, operation, mode, and exact input hash. Inputs and results reject secret-bearing field names and enforce strict size limits. Results and receipts must report zero execution authority, zero actions, and zero writes.

The registry deliberately excludes runtime package installation and arbitrary code loading. A production deployment must review, pin, and deploy each adapter separately.

## Scheduling

A schedule binds one Agent NFT and owner epoch to one installed skill operation and exact input. Schedules are disabled by default, expire within seven days, run no more than 24 times, and use intervals of at least 60 seconds.

The scheduler requires authorization before reserving capacity and again after reservation. The store claims one run atomically. Once a skill adapter starts, an error leaves the run in flight because the external outcome may be unknown. Operators must reconcile the outcome before retrying.

The PostgreSQL adapter provides durable atomic claims and completed receipt storage. The in-memory adapter is for tests and local development only.

## Agent coordination

Agent messages are short-lived, replay-safe envelopes between registered Agent NFT identities. They bind sender, recipient, owner epoch, thread, kind, payload hash, nonce, and expiry. Messages carry `authority: none` and `executionAuthorized: false`.

Routing requires a fresh sender authorization and a server-controlled directory check for both peers. Secret-bearing and instruction-injection payloads fail closed. A message may request analysis or deliver a result, but it cannot authorize a tool, schedule, write, signature, or transaction.

The PostgreSQL adapter stores recipient indexes as hashes and rejects duplicate message hashes. External messaging gateways remain separate deployment adapters.

## Production requirements

Before enabling the control plane in a holder application:

1. Apply `docs/sql/jeff-os-postgres.sql` with the server-only database role.
2. Register exact reviewed skill manifests and adapter integrity hashes.
3. Bind authorization to the current on-chain owner, current owner epoch, revocation state, and emergency stop.
4. Add independent rate limits for skill calls, schedule runs, and message routing.
5. Add alerts for authorization failures, replay attempts, stuck reservations, quota exhaustion, and adapter errors.
6. Exercise database backup and restore, key rotation, kill switch, logout, and ownership-transfer revocation drills.
7. Run a 24 to 48 hour read-only production soak before promoting any scheduled skill.

## Authority boundary

This control plane never calls the execution gate. Transaction, swap, transfer, signing, posting, permission changes, and spending remain disabled. A future action adapter requires its own threat model, durable idempotency, simulation, destination-level controls, monitoring, canary limits, independent review, and explicit release approval.
