# JEFF decision assurance

The decision assurance layer checks a typed JEFF response before Brain planning or any execution-gate handoff. It does not replace the model. It verifies that action-critical heads agree with one another, confidence clears explicit floors, write evidence is complete, and deterministic safety facts do not require denial.

It always returns `executionAuthorized: false`.

## Checks

The v1 assurance contract evaluates:

- authority, next action, risk, and tool-mode confidence;
- escalation, simulation, and owner-notification certainty;
- probability margin between the selected choice and its nearest alternative;
- cross-head coherence for denial, autonomous scope, transaction proposals, risk, and simulation;
- deterministic safety facts for authorization, funding, transition validity, evidence, privacy, validation, and identity integrity;
- secret requests and instruction-injection patterns;
- verified evidence readiness for write-shaped proposals.

## Outcomes

- `pass`: coherent read-only or simulation-safe reasoning may proceed.
- `review`: owner review or more evidence is required. Planning proceeds only when critical confidence and write evidence are sufficient.
- `block`: the proposal or decision failed a hard safety or coherence check.

The layer also emits `planningAllowed` and `recommendedToolMode`. Brain v1 stops before calling its planner when `planningAllowed` is false. The execution gate verifies that the assurance object is present, permits planning, is not blocked, and matches the hash committed in the Brain receipt.

## Usage

```js
import { assessJeffDecisionAssurance } from 'jeff-agent-nft/assurance';

const assurance = assessJeffDecisionAssurance({
  request: contractRequest,
  response: decisionResponse,
});

if (!assurance.planningAllowed) {
  throw new Error('JEFF_PLANNING_NOT_ASSURED');
}
```

The assurance record contains hashes, normalized safety facts, confidence summaries, and reason codes. It does not copy proposal state, evidence payloads, owner policy, or private memory.

## Boundary

Assurance is a fail-closed precondition, not an execution authorization. A passing result still needs external policy checks, current owner authorization, simulation, idempotency controls, and an adapter-specific release decision before any real effect.
