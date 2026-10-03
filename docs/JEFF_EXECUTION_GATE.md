# JEFF execution gate

The JEFF execution gate is a separate, deny-by-default boundary between Brain v1 proposals and real tools. Brain v1 remains shadow-only. A proposal cannot call this gate merely because the model recommended it.

The gate executes one write proposal only when all of these controls pass:

1. The Brain result, decision assurance record, and content-addressed receipt validate.
2. A time-bounded policy names the current agent, owner, owner epoch, exact tool allowlist, action quota, and emergency-stop state.
3. The tool adapter produces a successful simulation with pre-state and post-state commitments.
4. A server-controlled verifier authorizes the exact intent, policy, tool, simulation, subject, and owner epoch with a fresh attestation.
5. A durable store atomically reserves the idempotency key and policy quota before the adapter is called.
6. The adapter executes with the same idempotency key and returns a bounded result.
7. The gate records a tamper-evident receipt that binds the Brain receipt, policy, intent, simulation, authorization attestation, and final state. Owner and external destination identifiers are retained as hashes.

## Default state

`createJeffExecutionPolicy` defaults to `enabled: false` and `emergencyStop: true`. Both values must be explicitly changed to activate a policy. The maximum policy lifetime is 24 hours and the maximum action quota is eight.

The exported in-memory store is only for tests and local development. Production integrations must provide a durable store with atomic reservation, quota enforcement, completed-receipt replay, and manual reconciliation for unknown outcomes.

## Example

```js
import {
  createJeffExecutionIntent,
  createJeffExecutionPolicy,
  executeJeffIntent,
} from 'jeff-agent-nft/execution';

const policy = createJeffExecutionPolicy({
  agentId: 'agent:10',
  ownerId: 'owner:alice',
  ownerEpoch: 3,
  allowedTools: ['report.publish'],
  maximumActions: 1,
  nonce: 'owner-generated-unique-nonce',
  validAfter: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  enabled: true,
  emergencyStop: false,
});

const intent = createJeffExecutionIntent({
  brainResult,
  policy,
  proposalIndex: 0,
});

const receipt = await executeJeffIntent({
  intent,
  policy,
  subject: authenticatedOwnerSession,
  authorizationVerifier,
  toolAdapter,
  executionStore,
});
```

The authorization verifier must be server-controlled and must resolve current ownership, owner epoch, revocation state, and delegated capability policy from trusted data. Do not construct attestations from request flags. Policy and receipt hashes provide tamper evidence, not signer provenance.

## Adapter requirements

Every production tool adapter must:

- expose only one named, allowlisted write capability;
- simulate without causing an external effect;
- enforce the supplied `idempotencyKey` at the destination when possible;
- never accept or return private keys, seed phrases, raw signatures, or reusable credentials;
- return an opaque external identifier and final-state commitment;
- treat timeouts after submission as unknown outcomes and reconcile them before any retry.

The gate deliberately keeps an intent reserved after any adapter exception because an external effect may already have occurred. Automatic retry is unsafe until the destination confirms the original outcome.

## Release boundary

This module is an execution-control foundation, not approval to enable production actions. Each integration still needs adapter-specific threat modeling, adversarial tests, durable storage, current-owner verification, limited canary limits, monitoring, revocation drills, and independent release approval.
