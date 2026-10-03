# JEFF Brain v1

JEFF Brain v1 turns the verified v0.9 decision core into a complete shadow reasoning loop. It combines authorized context, deterministic decisions, planning, critique, tool supervision, learning feedback, and privacy-safe receipts.

Brain v1 remains non-executing. It proposes and reviews actions but never calls a tool. Every result contains `executionAuthorized: false` and `actionsExecuted: 0`.

## Architecture

1. Authorized memory recall loads only the current owner scope and owner epoch through an encrypted storage adapter after a mandatory server-controlled authorization verifier approves the exact capability.
2. MCP context intake requires a fresh server-verified subject, operation, owner epoch, and allowlist scope before it reads or selects hash-matched safe text.
3. The sealed v0.9 runtime produces the authoritative 28 typed decisions.
4. Decision assurance checks critical confidence, cross-head coherence, deterministic safety facts, and write evidence. A failed planning gate stops before provider access.
5. A pinned open-weight model produces two to five bounded alternatives.
6. A second model pass critiques the recommended alternative.
7. The deterministic supervisor blocks unknown tools, policy violations, execution material, and every unapproved write.
8. A hash-only receipt binds the request, decision, assurance result, context records, plan, critique, selected plan, and safety result.
9. Owner feedback can become a curriculum candidate only after server-verified owner opt-in and a separately verified reviewer identity. Training remains a separate build and blind-evaluation process.

## Memory boundaries

Brain v1 supports two separate memory planes:

- The memory commitment layer stores hash-only public or owner-scoped commitments with provenance and owner approval.
- The authorized recall adapter stores encrypted content through caller-provided storage and cryptography interfaces. Scope includes agent ID, owner ID, and owner epoch so a transfer starts a new memory boundary.

Production integrations must use authenticated encryption, an access-controlled durable adapter, and a server-controlled authorization verifier backed by authenticated sessions, signatures, or equivalent owner evidence. Caller-supplied capability flags are never sufficient. The included in-memory adapter is for tests and local development only.

The same verifier boundary applies to MCP context policy, owner feedback submission, and independent review identity. JEFF validates exact-shape attestations bound to subject, operation, scope, owner epoch, and a maximum five-minute freshness window. Owner consent also binds the decision receipt, outcome, correction commitment, training opt-in decision, and event time. Reviewer consent binds the reviewed event, approval decision, and review time. Final eligibility returns the eligibility attestation hashes. Brain receipts retain only authorization hashes outside the learning event contract.

## Example

```js
import { deliberateJeffBrain } from 'jeff-agent-nft/brain';
import { createJeffOpenWeightsProvider } from 'jeff-agent-nft/open-weights';

const provider = createJeffOpenWeightsProvider({
  model: 'your-pinned-open-weight-model',
  baseUrl: 'http://127.0.0.1:11434'
});

const result = await deliberateJeffBrain({
  provider,
  request: {
    objective: 'Review verified vault policy and prepare a report.',
    state: {
      proposal: 'Inspect verified state.',
      safetyFacts: {
        authorized: true,
        funded: true,
        validTransition: true,
        evidenceSufficient: true,
        privacySafe: true,
        validationSafe: true,
        identityIntegrity: 'trusted'
      },
      requiredSafetyFactsComplete: true,
      ownerPolicy: { allowAutonomous: true }
    },
    ownerPolicy: {
      writeRequiresOwnerApproval: true,
      allowedTools: ['policy.read']
    },
    tools: [{
      name: 'policy.read',
      mode: 'read_only',
      description: 'Read verified owner policy.'
    }]
  }
});

console.log(result.safety.disposition);
console.log(result.decisionAssurance.verdict);
console.log(result.decisionAssurance.planningAllowed);
console.log(result.audit.receiptSha256);
console.log(result.executionAuthorized); // false
console.log(result.actionsExecuted);      // 0
```

Remote model endpoints are denied by default. Enabling a remote endpoint is an explicit integration choice and must not send private state. Brain v1 redacts secret-bearing state keys before any provider call.

## Completion boundary

Brain v1 completes the shadow brain loop. It does not complete autonomous execution. Signing, broadcasting, spending, publishing, or permission changes require a separate authorization architecture and release gate.
