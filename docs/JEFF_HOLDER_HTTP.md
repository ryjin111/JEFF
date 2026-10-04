# JEFF Holder HTTP Boundary

The Holder HTTP boundary exposes the local Holder Alpha runtime through one same-origin JSON endpoint without adding transaction authority.

## Security contract

- The server configures the relying-party origin and holder page URI. The browser cannot supply either value.
- Every state-changing request requires an exact `Origin` match. Cross-site fetches fail closed.
- Holder sessions exist only in a `Secure`, `HttpOnly`, `SameSite=Strict`, `__Host-` cookie.
- Request envelopes reject unknown fields and bodies are capped at 16 KiB by default.
- A rate limiter and a trusted client identity resolver are mandatory dependencies.
- Memory responses expose hashes and metadata, not ciphertext or plaintext.
- Errors are mapped to constant public codes and do not expose provider, wallet, ownership, or storage details.
- Runtime output must remain shadow-only with zero actions executed.

## Actions

The endpoint accepts five strict action envelopes:

- `challenge`: request a server-bound wallet message.
- `boot`: verify the signature and current Agent NFT ownership, then set the holder cookie.
- `run`: ask JEFF to reason and execute its one supervised read-only status capability.
- `remember`: store explicitly holder-approved encrypted memory.
- `logout`: revoke the server session and clear the holder cookie.

## Deployment requirements

`createJeffHolderHttpHandler` is dependency-injected and does not silently create development substitutes. A deployment must provide the hardened holder runtime, a distributed rate limiter, and a client identity resolver that trusts only the hosting platform's authenticated proxy metadata.

The included fixed-window limiter is for local tests and single-process development. It is not a distributed production limiter. The exported PostgreSQL adapter provides atomic challenge consumption, hashed session identifiers, concurrency-safe memory chaining, and a shared rate limiter. Apply [`docs/sql/jeff-holder-postgres.sql`](sql/jeff-holder-postgres.sql) with a server-only database role before using it.
