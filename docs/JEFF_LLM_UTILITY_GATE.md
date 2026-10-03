# JEFF LLM utility gate

The LLM utility gate prevents JEFF Brain from calling a provider when the deterministic decision is already sufficient. Routine reads, summaries, rejected requests, and uncertain decisions use zero provider calls.

The gate permits the fixed two-call planning and critique loop only for a bounded use case:

- a verified write-shaped proposal that already requires owner review;
- a genuine comparison across multiple available tools;
- a synthesis backed by at least two verified evidence records.

Each assessment emits a hash-bound record with the classified use cases, the allowed call count, the expected call count, the decision-assurance commitment, and a reason code. The Brain receipt separately records the actual `providerCallsUsed` value. Neither record authorizes execution.

## Decisions

- `deterministic_only`: return the typed JEFF decision without provider access.
- `use_llm`: permit exactly two calls, one planning pass and one critique pass.
- `blocked`: permit no calls because decision assurance stopped planning.

## Example

```js
import { assessJeffLlmUtility } from 'jeff-agent-nft/llm-utility';

const utility = assessJeffLlmUtility({
  request: normalizedBrainRequest,
  decisionAssurance,
});

console.log(utility.decision);
console.log(utility.providerCallsAllowed);
```

Brain v1 includes this assessment in every result and commits its hash in the Brain receipt. The execution gate accepts only a selected plan whose utility record authorized the two-call planning path and whose hash still matches the receipt.

## Cost boundary

The gate is a per-deliberation call budget. Production HTTP deployments should still apply authentication, request quotas, rate limits, and provider-side spend limits across deliberations.
