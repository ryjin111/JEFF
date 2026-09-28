# JEFF Agent NFT Decision Model

## Product identity

JEFF is the open-source AI decision model being built specifically for Agent NFTs. Its job is to turn structured Agent NFT state and typed questions into calibrated, machine-readable decisions that downstream policy and execution systems can inspect.

The current stack has deliberately separate model, runtime, and proof layers. `jeff-shadow-v0.1` is the transparent deterministic policy baseline. `jeff-agent-nft-nb-v0.2-broad` is the broad learned bootstrap checkpoint. `jeff-deliberation-runtime-v0.3` adds two-pass planning, critique, memory hygiene, tool proposals, and a deterministic safety supervisor through a pluggable open-weight model interface. The frozen Protocol Gauntlet remains outside training and measures how the v0.2 checkpoint transfers to unfamiliar protocol states. None of these layers is a production authorization system.

## V1 model contract

`api/_lib/jeff-agent-nft-contract.mjs` defines the stable boundary between a future learned model and Agent NFT products:

- Arbitrary JSON state, with optional `agentNft` identity containing chain, collection, token, and account.
- Typed `choice`, binary `noul`, and ordinal `score` questions.
- Complete probabilities and an explicit confidence field for choice decisions. A checkpoint may only call these values calibrated after a held-out calibration study.
- Exact answer coverage with no missing or extra question IDs.
- Shadow-only output with `executionAuthorized: false`.

The canonical Agent NFT questions cover authority, next action, risk, owner escalation, and proposal quality. The generic typed interface also allows byte-identical external benchmark inputs without per-provider prompt rewriting.

`api/_lib/jeff-agent-nft-baseline.mjs` implements the first runnable shadow baseline. `GET /api/jeff-agent-nft` publishes the contract and canonical questions. Same-origin `POST /api/jeff-agent-nft` validates a typed request and returns the shadow decision. The endpoint is rate-limited, body-size-limited, and cannot authorize execution.

The public policy-conformance suite is `benchmarks/jeff/agent-nft-policy-v1.json`. Run the deterministic baseline with `npm run benchmark:jeff-agent-nft` or the learned checkpoint with `npm run benchmark:jeff-agent-nft-learned`. Receipts are append-only and explicitly forbid a superiority claim because the cases are public and were authored for the deterministic baseline.

## Learned bootstrap checkpoint

Run `npm run dataset:jeff-agent-nft` to generate the versioned synthetic seed dataset, then run `npm run train:jeff-agent-nft` to train and score the dependency-free multinomial Naive Bayes checkpoint. Both commands use exclusive file creation to prevent silent replacement of published artifacts.

The v0.1 dataset contains 72 examples across 12 Agent NFT policy scenarios. Its proposal phrases are disjoint across the 48-example training, 12-example validation, and 12-example test splits. Scenario families still overlap, semantic deduplication is not complete, and the labels are project-authored rather than independent. The frozen training receipt binds the dataset and checkpoint with SHA-256 hashes.

The current guarded run scored 96.2500% on training decisions, 80.0000% on validation decisions, and 81.6667% on test decisions. Score labels 1 and 2 are absent from training and the Naive Bayes probabilities are not calibrated. These are seed-pipeline measurements over synthetic scenarios. They do not establish real-world generalization or superiority over Laya, Jev, or another model. See `datasets/jeff-agent-nft/v0.1/DATASET_CARD.md`, `models/jeff-agent-nft-nb-v0.1/MODEL_CARD.md`, and `benchmarks/jeff/results/jeff-agent-nft-nb-v0.1.json`.

The 14-case project-authored adversarial suite covers negated transaction explanations, permission-mutation synonyms, mixed-intent action requests, and partially invalid evidence that the raw checkpoint or earlier guard revisions mishandled. Run it with `npm run benchmark:jeff-agent-nft-challenge`. It is not independently labeled and cannot support a superiority claim.

The primary AI-model-only comparison uses deterministic JEFF, learned JEFF, and three pinned Laya checkpoints on the same 55 decisions. Its shareable graphic and evidence note are `public/media/jeff-agent-nft-benchmark-2026-09-25.png` and `public/media/jeff-agent-nft-benchmark-2026-09-25.md`.

The separate General LLM track uses the same 11 states and 55 typed decisions with temperature zero, pinned model IDs, strict JSON parsing, raw-response hashes, token usage, latency, schema validity, accuracy, and safety violations. The configured candidates are Claude Sonnet 5, GPT-5.6 Terra, Gemini 3.8 Flash, Grok 4.3, and Muse Spark 1.3. Run one Bankr gateway model with `BENCHMARK_LLM_MODEL=<model> npm run benchmark:jeff-agent-nft-llm`. Muse uses `BENCHMARK_LLM_AUTH=bearer`, `BENCHMARK_LLM_API_KEY_ENV=META_MODEL_API_KEY`, and the Meta endpoint. Provider failures and malformed outputs are recorded as invalid cases, never replaced with JEFF answers. Receipts are append-only and do not permit a general superiority claim.

Production runs use `POST /api/jeff-agent-nft-llm-benchmark` with `Authorization: Bearer <CRON_SECRET>` and a JSON body containing one allowlisted model key: `claude`, `gpt`, `gemini`, `grok`, or `muse`. The endpoint executes all cases inside Vercel, returns only normalized decisions and response hashes, and never returns the provider credential. Run one model per request and save each returned JSON receipt before updating any comparison graphic.

For an unaliased Production-secret deployment protected by Vercel Authentication, `vercel curl` may invoke the exact `VERCEL_URL` without copying `CRON_SECRET` or a provider key into the local process. This exception is bound to the exact deployment hostname. Custom domains and aliases still require `CRON_SECRET`.

The 2026-09-25 production attempt produced no qualified General LLM scores. Claude, GPT, Gemini, and Grok returned HTTP 402 from the shared Bankr gateway for every case. Muse returned HTTP 402 or HTTP 404 for every case. These are provider availability receipts, not zero-percent model results, and must not be added to a performance graphic. See `benchmarks/jeff/results/GENERAL_LLM_RUN_2026-09-25.md`.

Two statistical reference baselines remain as technical context. A majority-label classifier scores 49.0909%. A token Jaccard 1-NN classifier scores 100%, but it is trained on closely related synthetic templates and therefore demonstrates benchmark template similarity rather than independent generalization. Run both with `npm run benchmark:jeff-agent-nft-baselines`. They are not included in the primary AI-model graphic.

## Agent NFT training domain

Training and evaluation data should represent decisions that Agent NFTs actually face:

1. Owner policy and delegated authority.
2. Wallet, vault, token, NFT, and contract state.
3. Transaction proposals without private keys or signatures.
4. Provenance, freshness, and confidence of external signals.
5. Social communication, coordination, voting, and delegation.
6. Abstention and owner escalation when evidence or authority is insufficient.
7. Adversarial prompts, malicious proposals, compromised data, and policy bypasses.

Private keys, seed phrases, signatures, private user data, and production secrets must never enter a training corpus.

## Broad capability surface v0.2

JEFF's five original heads are the safety kernel, not the product boundary. `api/_lib/jeff-agent-nft-capabilities.mjs` expands the same typed contract to 28 decision powers across seven families: authority, onchain activity, evidence, coordination, social behavior, security, and tool boundaries. The surface covers identity integrity, permissions, vault posture, market analysis, NFT and DeFi proposals, cross-chain routing, research, memory, delegation, governance, communication, moderation, reputation, incident response, reversibility, simulation gates, and owner notification.

The broad surface remains shadow-only and keeps `executionAuthorized: false`. It can observe, research, simulate, and prepare reviewed actions, but it cannot sign, broadcast, spend, change permissions, or publish consequential claims by itself.

The v0.2 broad bootstrap is generated with `npm run dataset:jeff-broad`, trained with `npm run train:jeff-broad`, and reproduced with `npm run verify:jeff-broad`. It is a project-authored synthetic seed with phrase-disjoint but scenario-family-overlapping splits. Its scores measure pipeline coverage, not independent generalization or model maturity. A larger neural checkpoint, calibrated probabilities, real licensed Agent NFT data, semantic deduplication, and an independently labeled blind set remain required before comparison with Laya or Jev.

## Deliberation runtime v0.3

`api/_lib/jeff-deliberation-runtime.mjs` adds the qualitative layer missing from the broad classifier. A pinned open-weight provider produces all 28 typed decisions, compares multiple plans, and runs a second critique pass. The deterministic supervisor then applies owner policy independently of the model. It quarantines unsafe memory, rejects unknown tools and execution material, routes every write proposal to owner review, and produces a hash-bound audit receipt. Secret-extraction and owner-policy bypass requests stop before model invocation.

`POST /api/jeff-deliberate` is protected by a server-side bearer token, body limit, and rate limit. The model ID, endpoint, and provider credential are pinned on the server and cannot be selected by the client. Remote model endpoints require an explicit server configuration flag. The endpoint remains shadow-only and never invokes a proposed tool.

The separate deterministic safety suite covers 12 scenario families absent from the v0.2 synthetic training families. All 12 currently conform, but this measures the supervisor boundary rather than model intelligence. See `docs/JEFF_DELIBERATION_RUNTIME.md` and reproduce it with `npm run verify:jeff-deliberation`.

## Protocol Gauntlet v1

The frozen Protocol Gauntlet evaluates the unchanged v0.2 checkpoint on 18 unseen states derived from ERC-6551, ERC-8004, ERC-4337, ERC-1271, ERC-8350, and ERC-8183. It contains 176 typed decisions with no exact proposal overlap with training.

JEFF scored 125 of 176, or 71.02%. The weakest capability family was on-chain reasoning at 54.55%, and the weakest protocol was ERC-8183 at 52.63%. Wrong answers still carried 78.16% mean selected confidence. This historical development result confirmed that the 92.02% synthetic v0.2 test result materially overstated transfer to unfamiliar protocol contexts.

The gauntlet is not part of training. Its frozen failures are the next training map, not examples to silently fold into the same evaluation. See `benchmarks/jeff/PROTOCOL_GAUNTLET_V1.md` and reproduce the receipt with `npm run verify:jeff-protocol-gauntlet`.

## Protocol candidate v0.3.4

`jeff-agent-nft-nb-v0.3.4-protocol` is the first candidate trained after the v0.2 failure analysis. It adds 15 specification-derived curriculum families, an opt-in semantic feature layer, balanced rehearsal of the original 28-task surface, and validation-fitted temperature scaling. The curriculum contains 113 training, 32 validation, and 32 test samples. No curriculum proposal exactly overlaps the frozen Protocol Gauntlet.

The phrase-disjoint curriculum holdout scores 90.40%. On the original development gauntlet, the candidate scores 169 of 176 decisions, or 96.02%. Every capability family and protocol is above 80%, and mean confidence on wrong development answers is 49.56%. The checkpoint, dataset, calibration settings, and receipts are hash-bound and reproduce with `npm run verify:jeff-protocol`.

This is a development candidate, not a promoted model. The original gauntlet informed the curriculum design and is no longer an independent evaluation of v0.3.4. It has only 18 project-labeled cases. Promotion still requires the separate gate in `api/_lib/jeff-model-promotion.mjs`: at least 20 unseen independently labeled cases, 160 decisions, 90% overall accuracy, 80% in every family and protocol, wrong-answer confidence no higher than 55%, valid artifact hashes, calibrated probabilities, and no training overlap. Execution authority remains disabled regardless of promotion status.

## Independent sealed evaluation v1

The first independent sealed evaluation froze 24 new protocol cases and 216 predictions before an independent label file was revealed. It had zero exact proposal overlap with training. Candidate v0.3.4 scored 177 of 216 decisions, or 81.94%, with 35.82% mean confidence on wrong answers. Tool decisions scored 54.17%, social decisions scored 75%, and ERC-4337 scored 72.22%. The promotion gate rejected the candidate because overall, family, and protocol thresholds were missed. Execution remains disabled.

The sealed v1 stimuli and labels are now exposed. They cannot be reused as independent promotion evidence. Their artifacts remain preserved under `benchmarks/jeff/` as a reproducible record of the rejection.

## Boundary candidate v0.4

`jeff-agent-nft-nb-v0.4-boundary` converts the exposed sealed v1 failures into training-only examples and adds explicit semantic-v3 boundaries for tool use and abstention. Unauthorized or invalid states select no tools and abstain. Stale or conflicting states stay read-only. Verified simulations stay simulation-only. Owner-reviewed writes can be prepared but never executed.

The training split has 137 unique samples, including the 24 retired sealed cases with partial task labels. The untouched internal validation split scores 819 of 896 decisions, or 91.41%. The untouched internal test split scores 808 of 896, or 90.18%. The retired sealed v1 regression scores 216 of 216, but that result is development evidence only because those labels are now in training. Dataset and checkpoint reproduction uses `npm run verify:jeff-boundary`.

Candidate v0.4 was not promoted. Sealed v2 independently confirmed 197 of 216 decisions, or 91.20%, with zero exact overlap and hash-bound checkpoint, runtime, training data, stimuli, predictions, and labels. This established the first honest fresh score above 90%. Promotion still failed because the evidence family scored 78.79%, below its 80% floor, and wrong answers carried 68.28% mean confidence, above the 55% ceiling. All protocol floors and the other six family floors passed. Shadow mode and `executionAuthorized: false` remain mandatory.

## Evidence candidate v0.5

`jeff-agent-nft-nb-v0.5-evidence` retires the exposed sealed v2 set into training-only data. It adds semantic-v4 features and explicit boundaries for unsupported proposal evidence, critical integrity failures, banned execution policy, identity resets, signature interface failures, and exposed private commitments. Safety-envelope decisions use a conservative 54% confidence cap so deterministic policy decisions do not claim unsupported certainty.

The training split contains 161 unique samples. The untouched internal validation split scores 817 of 896 decisions, or 91.18%. The untouched internal test split scores 808 of 896, or 90.18%. Both retired sealed sets score 216 of 216 as development regressions. Reproduce the dataset, checkpoint, receipt, and tests with `npm run verify:jeff-evidence`.

Candidate v0.5 cleared the independently authored sealed v3 promotion gate in shadow mode. It scored 203 of 216 decisions, or 93.98%, with every capability family above 91%, every protocol above 86%, and 49.84% mean confidence on wrong answers. Predictions were frozen before independent labels and had zero exact overlap with v0.5 training, sealed v1, or sealed v2. The model is eligible for shadow-mode promotion. This does not authorize autonomous execution.

The public `POST /api/jeff-agent-nft` shadow endpoint now serves this exact promoted checkpoint. Startup verifies the frozen checkpoint, inference runtime, and sealed v3 receipt against pinned SHA-256 commitments and fails closed if any binding changes. `GET /api/jeff-agent-nft` exposes the active model name, promotion receipt, observed sealed accuracy, hashes, and the unchanged `executionAuthorized: false` boundary.

The primary-source basis, protocol decision rules, calibration policy, residual risks, pinned upstream revisions, and reproducibility commands are documented in [`research/JEFF_PRIMARY_SOURCE_AUDIT_2026-09-28.md`](research/JEFF_PRIMARY_SOURCE_AUDIT_2026-09-28.md). Run `npm run verify:jeff-sources:online` to refetch the pinned protocol documents and verify their byte lengths and SHA-256 digests.

## Open-source release boundary

The repository currently has no license file. Public source visibility alone does not make JEFF open source. Before the first public model release, the owner must approve:

- An OSI-approved license for code.
- A model-weight license that permits the intended use and redistribution.
- Dataset cards and compatible licenses for every training source.
- A model card with architecture, training procedure, limitations, safety evaluation, and hashes.
- Reproducible inference and benchmark scripts that do not require private Clockers infrastructure.

No code in this change assigns a legal license on the owner's behalf.

## Development stages

### Stage 0: contract and deterministic baseline

- Stable Agent NFT request and response schema.
- Clockers-specific deterministic baseline.
- Policy-conformance and safety regression tests.
- No execution authority.

### Stage 1a: learned seed pipeline, complete

- Versioned synthetic dataset with phrase-disjoint splits.
- Reproducible dependency-free training and inference.
- Learned checkpoint and immutable hash-bound evaluation receipt.
- Strict shadow contract with no execution authority.

### Stage 1b: independent dataset expansion

- Versioned Agent NFT ontology and task taxonomy.
- Public training split plus independently held blind evaluation split.
- Documented provenance, deduplication, contamination checks, and label agreement.

### Stage 1c: deliberation and proof boundary, complete

- Two-pass plan and critique runtime with a pluggable open-weight provider.
- Verified-memory retrieval and prompt-injection quarantine.
- Deterministic tool and owner-authorization supervisor.
- Protected inference endpoint with server-pinned model configuration.
- Scenario-family-disjoint supervisor suite and frozen protocol-transfer gauntlet.

### Stage 2: production candidate checkpoint

- Open architecture and reproducible training configuration.
- Versioned weights with cryptographic hashes.
- Calibrated probabilities for choice, noul, and score tasks.
- Local inference adapter implementing the V1 contract.

### Stage 3: independent evaluation

- Clockers policy benchmark kept separate from generalization benchmarks.
- Unchanged external cases from `sysone-bench` and other audited suites.
- Independent Agent NFT blind benchmark with frozen stimuli and post-freeze labels.
- Published raw predictions, failures, latency, cost, and calibration metrics.

### Stage 4: bounded product use

- Shadow observation first.
- Narrow, reversible, rate-limited authority only after independent audit.
- Owner or governance approval for transactions, signatures, permissions, and irreversible state.

## Definition of done for the first model release

The first release may be called an open-source Agent NFT AI decision model only when all of these are true:

1. Code and weights have approved public licenses.
2. A learned checkpoint and reproducible training configuration are published.
3. The checkpoint implements the V1 typed contract without task-specific benchmark adapters.
4. An independently labeled Agent NFT blind set is frozen and scored.
5. Safety, schema, coverage, calibration, latency, and cost receipts are public.
6. Known limitations and prohibited authority are documented in the model card.

Until then, describe JEFF as the open-source Agent NFT decision-model project with deterministic and learned shadow baselines.
