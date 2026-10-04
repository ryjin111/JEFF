# JEFF

![JEFF v0.5 sealed v3 benchmark result](public/media/jeff-v0.5-sealed-v3-benchmark-2026-09-28.png)

JEFF is an open, token-agnostic decision model and runtime for Agent NFTs. It turns structured identity, state, memory, policy, and proposal data into typed, machine-readable decisions that downstream systems can inspect.

JEFF v0.5 is intentionally shadow-only. It cannot sign, submit, publish, spend, or execute transactions. Every response keeps `executionAuthorized: false`.

Experimental [JEFF OS Holder Alpha](docs/JEFF_HOLDER_ALPHA.md) now provides a local end-to-end holder flow above the unchanged v0.5 release: single-use wallet challenges, current-owner verification, owner-epoch sessions, encrypted memory, one guarded read-only tool, transfer revocation, and Ed25519-signed shadow receipts. Its [HTTP boundary](docs/JEFF_HOLDER_HTTP.md) adds same-origin requests, secure holder cookies, strict envelopes, mandatory rate limiting, and sanitized errors. It is not enabled on the live endpoint. The [Hermes reuse map](docs/HERMES_REUSE_MAP.md) records which open-source patterns JEFF adapts and which NFT-native responsibilities remain independent.

The current release includes [JEFF Brain v1](docs/JEFF_BRAIN_V1.md), which adds authorized encrypted recall, MCP context intake, planning, critique, proposal-only tools, review-gated learning feedback, and hash-bound brain receipts above the v0.9 decision core. Brain v1 is also shadow-only.

The release also provides a server-authenticated [Brain shadow HTTP API](docs/JEFF_BRAIN_HTTP.md) for calling the complete non-executing reasoning loop through `https://www.isoclockers.world/api/jeff-brain`. Public verification is available at `https://www.isoclockers.world/jeff-brain-certification/`.

The release includes a separate [deny-by-default execution gate](docs/JEFF_EXECUTION_GATE.md). It binds a Brain proposal to an owner-scoped policy, simulation, fresh server authorization, atomic idempotency reservation, quota, emergency stop, and an execution receipt. This code is not enabled in the production Brain endpoint and is not a released execution certification.

The release includes a [deny-by-default curiosity loop](docs/JEFF_CURIOSITY_LOOP.md) for autonomous questions, novelty and information-gain scoring, approved read-only research, nonexecuting simulations, bounded discoveries, and hash-bound receipts. It cannot use write tools or silently retrain the live Brain.

An optional [Bankr read-only adapter](docs/JEFF_BANKR_READONLY_ADAPTER.md) exposes only wallet portfolio reads and swap quotes through exact allowlisted endpoints. It emits hash-bound zero-action receipts and cannot swap, transfer, sign, submit, launch tokens, or call the Bankr Agent API.

The [decision assurance layer](docs/JEFF_DECISION_ASSURANCE.md) checks confidence, critical-head coherence, deterministic safety facts, and write evidence before Brain planning. Low-confidence or inconsistent decisions stop before provider access, and the execution gate verifies the assurance hash before creating an intent.

The [LLM utility gate](docs/JEFF_LLM_UTILITY_GATE.md) gives routine deterministic decisions a zero-call path. It permits the fixed planning and critique budget only for owner-reviewed write plans, multi-tool comparisons, or verified multi-source synthesis, and records the reason in a hash-bound receipt.

## Released checkpoint

- Model: `jeff-agent-nft-nb-v0.5-evidence`
- Sealed v3 result: 203 of 216 typed decisions, or 93.98%
- Evaluation: 24 unseen cases with predictions frozen before independent labels
- Capability floors: all 7 families above 91%
- Protocol floors: all 6 protocols above 86%
- Mean confidence on wrong answers: 49.84%
- Runtime: dependency-free Node.js ESM
- Code and checkpoint: MIT
- Dataset: CC BY 4.0

This result supports the released shadow model only. It is not evidence of autonomous execution, economic performance, or universal superiority.

## Quick start

Requires Node.js 20 or newer. There are no runtime dependencies.

```bash
git clone https://github.com/ryjin111/JEFF.git
cd JEFF
npm test
npm run verify
npm run soul:verify
npm run demo
npm run review
```

Use the stable review helper. It applies the promoted, hash-bound checkpoint, validates the typed response, and creates a privacy-preserving receipt that contains hashes rather than the submitted state:

```js
import { reviewJeffAgentNft } from 'jeff-agent-nft/review';

const { response, receipt } = reviewJeffAgentNft({
  agentNft: {
    chainId: 1,
    collection: '0x0000000000000000000000000000000000000001',
    tokenId: '1',
    account: '0x0000000000000000000000000000000000000002'
  },
  state: {
    proposal: 'Read the verified token-bound account state.',
    authorized: true,
    provenanceVerified: true,
    dataFresh: true,
    evidence: [{ verified: true }],
    ownerPolicy: { allowAutonomous: false }
  }
});

console.log(response.mode);                // shadow
console.log(response.executionAuthorized); // false
console.log(receipt.executionAuthorized);  // false
console.log(receipt.receiptSha256);
```

The receipt never authorizes execution. An integration must run its own policy checks and obtain any required owner approval. See [the integration guide](docs/INTEGRATION.md).

## What is included

- `api/`: the Brain shadow HTTP route plus typed contracts, 28 capability questions, inference runtimes, decision assurance, LLM utility gating, Brain v1, the gated execution boundary, curiosity loop, memory and MCP context boundaries, promotion gate, review helpers, receipts, and benchmark scorers.
- `models/`: the released v0.5 checkpoint, model card, and MIT license.
- `datasets/`: the v0.5 evidence curriculum, dataset card, and CC BY 4.0 license.
- `benchmarks/`: sealed stimuli, independent labels, frozen predictions, result receipt, source manifest, and the v2 benchmark contract.
- `docs/`: model architecture, integration guide, release readiness, and primary-source audit.
- `test/`: contract, runtime, benchmark, and release-integrity tests.

## Portable Agent NFT identity

JEFF ships a versioned, content-addressed identity bundle:

- `SOUL.md`: purpose, values, judgment, taste, and identity boundaries.
- `IDENTITY.md`: marketplace-safe public card.
- `STYLE.md`: voice separated from identity and authority.
- `SKILLS.md`: truthful, sellable decision and review capabilities.
- `LIMITS.md`: hard constraints that survive transfer.
- `soul.json`: manifest binding those files and the promoted checkpoint by SHA-256.

Run `npm run soul:verify` to validate the bundle. The command emits both `bundleRootSha256` and `manifestSha256`. An Agent NFT contract should anchor the `manifestSha256` or a content URI whose bytes produce that hash. This prevents mutable token metadata from silently replacing the soul after resale.

Runtime instructions live in `runtime/AGENTS.md` and recurring-loop guidance lives in `runtime/HEARTBEAT.md`. They are deliberately outside the transferable soul root so integrations can version tools and workflows without rewriting JEFF's identity. `memory/MEMORY.template.md` is owner-scoped, private by default, and excluded from the soul manifest.

## Integrity and verification

`npm run verify` fails closed if a bound artifact changes. The promoted loader binds the checkpoint, runtime, and sealed receipt by SHA-256. The release verifier additionally checks the training dataset, frozen stimuli, labels, predictions, source manifest, source audit, licenses, promotion gate, and shadow execution boundary.

The canonical result receipt is:

`benchmarks/jeff/results/jeff-agent-nft-protocol-blind-v3.json`

## What JEFF is and is not

JEFF is a hash-bound shadow decision model and runtime that Agent NFT systems can call as a reviewer. It is useful for proposal linting, owner-policy checks, typed recommendations, and inspectable receipts.

JEFF is not a signer, wallet, NFT contract, identity registry, or reputation registry. It can reason about protocol-shaped state, but it does not implement ERC-8048, ERC-8004, or ERC-6551.

A compatible stack can keep those responsibilities separate:

- [ERC-8048](https://eips.ethereum.org/EIPS/eip-8048), including its Agent Metadata Profile nicknamed ERC-721T, provides on-chain token metadata such as context, service endpoints, and linked accounts.
- [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) provides optional agent identity, reputation, and validation registries.
- [ERC-6551](https://eips.ethereum.org/EIPS/eip-6551) provides token-bound accounts controlled by NFTs.
- JEFF provides the shadow decision and critique layer above structured state from those systems.
- The optional execution gate provides a reusable hard boundary, but every real adapter still requires its own reviewed policy, durable idempotency store, and release approval.

## Benchmark design

The public v2 benchmark separates four model tracks:

1. Hard safety qualification.
2. Independently labeled decision quality and calibration.
3. Strict `pass^k` reliability under harmless context perturbations.
4. Agent NFT transfer invariance and previous-owner privacy.

Execution settlement and economic outcomes are separate runtime tracks. The released v0.5 score does not claim results for the new reliability or transfer tracks. See [the benchmark contract](benchmarks/jeff/AGENT_NFT_BENCHMARK_V2.md).

## Security boundary

Treat JEFF output as advice for policy and execution systems, never as authorization. Do not provide private keys, seed phrases, signatures, API secrets, or private user data. See [SECURITY.md](SECURITY.md).

## Status

JEFF v0.5 is production-ready for promoted shadow use. Autonomous wallet execution remains disabled and out of scope for this release.
