# Hermes Agent reuse map for JEFF OS

Status: architecture decision for Holder Alpha

Hermes Agent is available under the MIT License. JEFF may study, modify, and distribute Hermes code if reused portions retain the Nous Research copyright and MIT permission notice.

JEFF Holder Alpha does not fork or rename Hermes. It reuses JEFF's existing audited primitives and treats Hermes as a reference implementation.

## Decisions

| Hermes area | JEFF decision | Reason |
| --- | --- | --- |
| Agent loop | Adapt the phase pattern | JEFF already has deterministic decision, planning, critique, safety, and receipt phases. |
| SQLite and FTS5 memory | Reference for a later durable adapter | Holder Alpha already has encrypted, owner-epoch-isolated memory behind an adapter contract. |
| Tool registry | Adapt the capability pattern | JEFF tools remain deny-by-default, mode-labeled, owner-policy-scoped, and proposal-only unless a separate gate approves execution. |
| MCP | Reuse JEFF's existing MCP intake | JEFF already hash-binds authorized resources and quarantines unsafe context. |
| Skills and plugins | Adapt the capability pattern | JEFF now provides hash-bound, server-registered skill manifests for read-only, simulation, and prepare-only adapters. It does not hot-load third-party code. |
| Cron and gateway | Adapt the control-plane pattern | JEFF now provides bounded schedules with atomic run reservations and non-authoritative agent message envelopes. Hosting and external delivery remain deployment responsibilities. |
| Container backends | Reference for hosting | JEFF remains deployable on local machines, VPS hosts, or managed containers. |
| Command approval | Adapt | JEFF retains its own owner policy, trusted authorization, and execution gate. |
| Identity and ownership | Keep JEFF-native | Wallet proof, Agent NFT identity, owner epoch, transfer revocation, and token-bound accounts are JEFF responsibilities. |
| Receipts | Keep JEFF-native | JEFF receipts bind decisions, owner scope, memory scope, tools, and holder sessions. |

## License rule

If JEFF later copies or modifies Hermes source, the copied distribution must retain the applicable Nous Research copyright and MIT license text. Architectural ideas and independently written JEFF code do not require copying Hermes branding.

References:

- https://hermes-agent.nousresearch.com/docs
- https://github.com/NousResearch/hermes-agent
- https://github.com/NousResearch/hermes-agent/blob/main/LICENSE
