# JEFF curiosity loop

The JEFF curiosity loop gives an Agent NFT a bounded way to explore without granting write authority. It detects useful unknowns, proposes questions, scores expected information gain and novelty, runs approved read-only searches or nonexecuting simulations, and returns privacy-conscious discoveries with a tamper-evident receipt.

## Safety model

Curiosity is disabled by default. An active policy binds exploration to the current agent, owner, owner epoch, allowed tools, per-cycle probe limit, total cycle quota, novelty threshold, information-gain threshold, validity window, and unique nonce. A fresh cycle authorization is required before quota reservation and is repeated after reservation immediately before provider access. It binds the agent, owner, owner epoch, policy, objective hash, public-history hash, cycle key, and the exact registered tool-capability set. If the post-reservation check fails, the reservation is aborted before the provider is called.

Every selected probe requires a fresh server-controlled authorization attestation bound to:

- the current agent and owner epoch;
- the exact curiosity policy;
- the cycle, objective, public history, exact probe, and input hashes;
- the selected tool and its read-only or simulation mode;
- the server-registered adapter capability hash;
- the authenticated subject and operation.

The policy is checked before planning, before every authorization, and immediately before every tool call. Write-mode adapters are rejected. A mode label alone grants no authority. Each adapter must present a hash-bound capability contract requiring a server sandbox, no writes, public-only egress, and server-attested evidence. The current-owner verifier must match that capability hash to a trusted server registry and deployment before authorizing the cycle or probe.

Inputs containing execution material, secret requests, or prompt-injection patterns fail closed. Only explicitly public, verified history may reach the planning provider. Private, unlabeled, unverified, or unsafe history is quarantined. Private content is also treated as a restricted value and is rejected if a provider attempts to place it in a plan or adapter input.

## Exploration budget

A durable reservation store enforces the total number of exploration cycles authorized by one policy and prevents cycle replay. Its atomic `abort` operation releases a reserved cycle when authorization or ownership changes before provider access. The included in-memory store is for tests and local development only. Production integrations must provide a durable atomic implementation shared by every process.

Within a cycle, JEFF ranks probes by expected information gain, then novelty, then stable probe ID. It executes at most the policy's `maxProbes`. Low-value and repetitive questions do not consume tool calls, although starting the planning cycle consumes one reserved cycle.

## Evidence and learning

Tool adapters return a bounded summary and content hashes for their evidence. Syntax and a content hash are not proof. Every evidence item requires a separate server-controlled provenance attestation bound to its source, hash, probe, capability, owner epoch, and policy. The verifier must independently resolve or validate the source and content commitment. Unsupported evidence fails the cycle and cannot produce a completed receipt.

The curiosity receipt binds the objective, policy, plan, selected history, quarantined history, cycle authorization, probe authorizations, evidence attestations, registered capability set, and discovery hashes. It contains no write authority and reports:

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
- Use server-verified current ownership and owner epoch before provider access and for every probe and evidence item.
- Run only registered adapters in an enforced server sandbox. Verify their capability hashes against the deployed implementation. Never trust a self-declared `read_only` label.
- Permit only allowlisted public reads and isolated local simulations. Deny filesystem, database, wallet, process, and mutation access at the sandbox boundary.
- Rate-limit provider and tool calls independently of the policy quota.
- Treat adapter summaries as untrusted until evidence hashes and sources receive independent provenance attestations.
- Monitor repeated authorization failures, quota exhaustion, unsafe-plan rejection, and quarantined history.

This module is an exploration foundation, not approval for unrestricted browsing or production writes. Network domains, data licenses, cost limits, and content policies remain integration-specific release gates.
