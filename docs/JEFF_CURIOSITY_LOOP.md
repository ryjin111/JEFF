# JEFF curiosity loop

The JEFF curiosity loop gives an Agent NFT a bounded way to explore without granting write authority. It detects useful unknowns, proposes questions, scores expected information gain and novelty, runs approved read-only searches or nonexecuting simulations, and returns privacy-conscious discoveries with a tamper-evident receipt.

## Safety model

Curiosity is disabled by default. An active policy binds exploration to the current agent, owner, owner epoch, allowed tools, per-cycle probe limit, total cycle quota, novelty threshold, information-gain threshold, validity window, and unique nonce.

Every selected probe requires a fresh server-controlled authorization attestation bound to:

- the current agent and owner epoch;
- the exact curiosity policy;
- the exact probe content hash;
- the selected tool and its read-only or simulation mode;
- the authenticated subject and operation.

The policy is checked before planning, before every authorization, and immediately before every tool call. Write-mode adapters are rejected. Inputs containing execution material, secret requests, or prompt-injection patterns fail closed. Unverified or unsafe history is quarantined before it reaches the planning provider.

## Exploration budget

A durable reservation store enforces the total number of exploration cycles authorized by one policy and prevents cycle replay. The included in-memory store is for tests and local development only. Production integrations must provide a durable atomic implementation shared by every process.

Within a cycle, JEFF ranks probes by expected information gain, then novelty, then stable probe ID. It executes at most the policy's `maxProbes`. Low-value and repetitive questions do not consume tool calls, although starting the planning cycle consumes one reserved cycle.

## Evidence and learning

Tool adapters return a bounded summary and content hashes for their evidence. The curiosity receipt binds the objective, policy, plan, selected history, quarantined history, authorization attestations, and discovery hashes. It contains no write authority and reports:

```json
{
  "mode": "bounded_exploration",
  "executionAuthorized": false,
  "actionsExecuted": 0,
  "writesExecuted": 0
}
```

Discoveries may be submitted to JEFF's authorized memory or review-gated learning pipeline by an integration. The curiosity loop does not silently store memory, retrain a model, promote weights, or call the execution gate.

## Integration requirements

- Keep source credentials and private user data outside prompts, observations, and receipts.
- Use server-verified current ownership and owner epoch for every probe.
- Permit only narrowly scoped read-only and local simulation adapters.
- Rate-limit provider and tool calls independently of the policy quota.
- Treat adapter summaries as untrusted until evidence hashes and sources are independently checked.
- Monitor repeated authorization failures, quota exhaustion, unsafe-plan rejection, and quarantined history.

This module is an exploration foundation, not approval for unrestricted browsing or production writes. Network domains, data licenses, cost limits, and content policies remain integration-specific release gates.
