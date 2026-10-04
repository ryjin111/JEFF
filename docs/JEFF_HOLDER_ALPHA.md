# JEFF OS Holder Alpha

Holder Alpha is the first end-to-end holder runtime above JEFF v0.5. It is local and experimental. It does not change the promoted model, the live Brain endpoint, or the shadow-only execution boundary.

## Implemented flow

1. The server issues a five-minute, single-use wallet challenge bound to the domain, URI, wallet, chain, collection, token ID, and token-bound account.
2. A trusted wallet adapter verifies the signed challenge.
3. A trusted ownership adapter confirms that the signer currently owns the Agent NFT.
4. JEFF creates a twelve-hour holder session bound to the owner epoch.
5. Holder-approved memory is encrypted with AES-256-GCM and isolated by Agent NFT, owner, and owner epoch.
6. JEFF Brain performs deterministic review, planning, critique, and safety checks in shadow mode.
7. The runtime reads one bounded `holder.status` capability and emits an Ed25519-signed receipt.
8. Every memory or Brain request checks fresh ownership. A transfer revokes the previous holder session before memory or model access.

## Security properties

- Challenges are short-lived and single-use.
- A wallet signature proves control of an address but grants no transaction authority.
- The current on-chain owner must match the signing wallet.
- Transfer changes the owner epoch and invalidates the old holder session and memory scope.
- Private memory is authenticated and encrypted at rest.
- Tools remain read-only in this alpha.
- Brain output remains `mode: shadow`, `executionAuthorized: false`, and `actionsExecuted: 0`.
- Holder receipts are hash-bound and signed with Ed25519.
- The wallet verifier and ownership resolver are trusted server adapters. Caller claims cannot replace them.
- Trusted observations allow at most five seconds of clock skew and expire after sixty seconds.

## Production adapters still required

- A durable store with atomic challenge consumption and session revocation.
- A wallet signature verifier using the target chain's canonical message rules.
- A fresh on-chain ownership resolver pinned to the intended collection and chain.
- Secret-managed AES and Ed25519 keys with rotation and audit procedures.
- Rate limits, abuse controls, observability, backups, and an incident kill switch.
- A holder web interface and authenticated HTTP boundary.

The included in-memory store and example adapters are for tests and local development only.

## Local verification

```bash
npm run test:holder
npm run demo:holder
npm run verify
```

The demo uses mock signature and ownership adapters. It must not be exposed as a production authentication service.
