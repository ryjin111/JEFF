# JEFF Holder deployment boundary

The Holder service is disabled unless `JEFF_HOLDER_ENABLED=true` is set. Keep that flag off until the database migration, trusted RPC clients, owner-epoch source, and secret bindings are all present.

Required managed settings:

- `JEFF_HOLDER_ORIGIN`: exact HTTPS origin serving the Holder console
- `JEFF_HOLDER_URI`: Holder page URL on that same origin
- `JEFF_HOLDER_MEMORY_KEY`: exactly 32 random bytes encoded as canonical base64
- `JEFF_HOLDER_RECEIPT_PRIVATE_KEY`: Ed25519 PKCS8 PEM secret
- `JEFF_HOLDER_RECEIPT_KEY_ID`: stable public identifier for the signing key
- `JEFF_BRAIN_MODEL`, `JEFF_BRAIN_BASE_URL`, and provider credentials where required
- `JEFF_BRAIN_ALLOW_REMOTE=true` only when the configured model endpoint is intentionally remote

Application bindings passed to `createJeffHolderDeploymentHandler`:

- a Postgres query client after applying `docs/sql/jeff-holder-postgres.sql`
- a chain-ID allowlisted viem Public Client factory using trusted RPC endpoints
- an owner-epoch resolver bound to the same block supplied by the ownership adapter
- a client identity resolver based only on infrastructure-trusted request metadata

Do not derive the rate-limit identity from an untrusted forwarding header. Do not supply a Wallet Client, private key, transaction transport, or write-capable tool. The deployment factory exposes only shadow planning, one read-only holder-status tool, encrypted holder-approved memory, and signed receipts.

Key rotation requires a new receipt key ID. Memory-key rotation requires a versioned re-encryption plan because existing ciphertext is bound to the previous key.
