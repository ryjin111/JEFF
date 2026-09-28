# JEFF Agent NFT NB v0.5 Evidence Model Card

## Summary

`jeff-agent-nft-nb-v0.5-evidence` is JEFF's promoted shadow checkpoint for Agent NFT decisions. It is a dependency-free multinomial Naive Bayes classifier with semantic-v4 features and 28 typed decision heads across authority, onchain activity, evidence, coordination, social behavior, security, and tool boundaries.

The checkpoint is deployed behind the public JEFF Agent NFT endpoint in shadow mode. It can recommend, abstain, or request owner review. It cannot authorize execution.

## Intended use

- Inspect structured Agent NFT state.
- Produce typed recommendations under the JEFF Agent NFT contract v1.
- Support research, simulation, proposal preparation, and owner review.
- Provide reproducible shadow decisions for product and safety evaluation.

It is not an execution engine, signer, transaction broadcaster, permission manager, or substitute for owner authorization.

## Training data

The v0.5 curriculum contains 161 unique training samples, 32 validation samples, and 32 test samples. Training uses weighted rehearsal, so the serialized checkpoint records 325 weighted samples. The corpus combines project-authored synthetic policy and protocol cases with the independently labeled sealed v1 and v2 failures after those evaluations were retired into training-only material.

The protocol curriculum is derived from public ERC-6551, ERC-8004, ERC-4337, ERC-1271, ERC-8350, and ERC-8183 specifications. The dataset contains no private keys, seed phrases, signatures, wallet credentials, private user data, or production secrets. See `datasets/jeff-agent-nft/v0.5-evidence/DATASET_CARD.md`.

## Training and calibration

- Architecture: multinomial Naive Bayes, one classifier per typed task.
- Feature layer: `semantic-v4`.
- Training weights: base 2, protocol 1, retired sealed examples 3.
- Calibration: per-task temperature scaling on the 32-sample validation split.
- Calibration objective: negative log likelihood with a wrong-confidence constraint.
- Validation mean confidence on wrong decisions: 34.04718%.
- Runtime safety envelope caps deterministic policy decisions at 54% confidence.

## Evaluation

The reproducible training receipt reports:

- Training: 3,291 of 3,596 decisions correct, 91.5184%.
- Validation: 817 of 896 decisions correct, 91.1830%.
- Test: 808 of 896 decisions correct, 90.1786%.

The independently authored sealed v3 evaluation froze predictions before labels and had zero exact proposal overlap with v0.5 training or the earlier sealed sets. It reports:

- 203 of 216 decisions correct, 93.9815%.
- Every capability family above 91%.
- Every protocol above 86%.
- Mean selected confidence on wrong answers: 49.8406%.
- Promotion gate: passed for shadow use only.

The sealed set contains 24 cases, so individual task slices are too small for broad claims. The evaluation explicitly sets `superiorityClaimAllowed: false`.

## Safety and authority

Every response must remain `mode: "shadow"` with `executionAuthorized: false`. JEFF cannot sign, broadcast, spend, move assets, change permissions, publish consequential claims, or turn model confidence into authorization. Downstream systems must independently enforce owner policy, provenance, fresh-state checks, simulation, rate limits, and transaction confirmation.

The promoted loader verifies the checkpoint, inference runtime, sealed v3 receipt, source manifest, and source audit with pinned SHA-256 commitments and fails closed on mismatch.

## Known limitations

- Most training examples are synthetic and project-authored.
- Validation and test phrases are disjoint, but their scenario families overlap with training.
- The architecture is a multi-head text classifier, not a general reasoning foundation model.
- The internal test `memory_action` head scores 71.875%, lower than the aggregate result.
- The sealed v3 task-level slices are small even though family and protocol gates pass.
- Draft or review-stage ERCs may change and must not be treated as stable ground truth without status checks.
- No broad superiority claim over general LLMs, Laya, Jev, or another system is supported.
- The checkpoint is distributed under the MIT License. The training dataset is distributed separately under CC BY 4.0.

## Reproduction

```powershell
npm run verify:jeff-evidence
npm run verify:jeff-sealed-v3
npm run verify:jeff-sources
npm run test:jeff
```

Core artifact commitments:

- Checkpoint SHA-256: `1543685838160edbb1f25c23d3706261a6e94184362bfe64c541ab9651374e19`
- Dataset SHA-256: `6f07dfe92c208d2440402777a016f3a5f2e99df0ff9329a930fe26dadef221be`
- Inference runtime SHA-256: `ccf920c8b4c6998baf327eb10ece2fec0512ff624d05852cdb83ae7d39b084ec`
- Sealed v3 receipt SHA-256: `fa5716f2cfee95e2c4f47b5a5fd401564023116e66709c44ba42c15f846923b4`
