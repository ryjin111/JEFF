# Security policy

## Supported version

Security fixes target the latest released JEFF checkpoint and runtime.

## Report a vulnerability

Do not open a public issue for a vulnerability that could expose secrets, private memory, owner policy, or transaction authority. Use GitHub private vulnerability reporting for this repository.

Include the affected file or version, reproduction steps, impact, and any proposed mitigation. Do not include live private keys, seed phrases, signatures, API credentials, or private user data.

## Runtime boundary

JEFF v0.5 is a shadow decision model. It must not sign, submit, publish, spend, change permissions, or execute transactions. Integrations must preserve `executionAuthorized: false` and apply their own independently reviewed policy and execution controls.

JEFF Brain v1 never invokes proposed tools. Use authenticated encryption for durable recall memory, isolate memory by current owner and owner epoch, and require a server-controlled authorization verifier for every memory read, write, and revocation. Apply the same trusted verification to MCP context policy, feedback opt-in, and reviewer identity. Never trust capability flags, allowlists, opt-in, approval decisions, or reviewer names supplied in a request. Bind authorization attestations to subject, operation, scope, owner epoch, freshness, and the exact consent decision. Keep model endpoints pinned server-side, and never send secret-bearing state to a model provider. Learning feedback cannot update a model directly. It requires owner opt-in, independent review, a separate model build, and a fresh blind evaluation.

The optional execution gate is disabled by default and does not change Brain v1's shadow-only contract. Production use requires a server-controlled verifier that checks current ownership, owner epoch, delegation, revocation, and emergency-stop state against trusted data. It also requires a durable atomic idempotency and quota store. Tool adapters must simulate first, enforce destination-level idempotency, hold secrets outside JEFF inputs and receipts, and reconcile unknown submission outcomes before retrying. A content hash is tamper evidence, not proof of signer identity.

The optional curiosity loop is disabled by default and permits only read-only and nonexecuting simulation adapters. Production integrations require server-verified current ownership, a durable atomic cycle-quota store, strict network and cost allowlists, independent evidence validation, and monitoring. Curiosity discoveries are untrusted inputs. They do not authorize writes, memory persistence, training, model promotion, or execution.
