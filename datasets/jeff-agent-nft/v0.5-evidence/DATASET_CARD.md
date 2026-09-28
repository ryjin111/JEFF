# JEFF Agent NFT Evidence Curriculum v0.5 Dataset Card

## Summary

This is the training curriculum for `jeff-agent-nft-nb-v0.5-evidence`. It contains 161 unique training samples, 32 validation samples, and 32 test samples covering 28 typed Agent NFT decision heads across seven capability families.

The dataset is a development curriculum, not a record of production user behavior. Most examples and labels are project-authored and synthetic. It exists to train and reproduce the v0.5 shadow checkpoint.

## Composition

- Base Agent NFT policy and broad-capability scenarios.
- Specification-derived cases for ERC-6551, ERC-8004, ERC-4337, ERC-1271, ERC-8350, and ERC-8183.
- Retired sealed v1 cases and labels, used only after the original v1 evaluation failed and was exposed.
- Retired sealed v2 cases and labels, used only after the original v2 evaluation failed and was exposed.

Retired sealed cases are training material and must never be presented as independent v0.5 evaluation evidence. The independent promotion evidence is sealed v3, which is excluded from this dataset.

## Split controls

- Proposal phrases are disjoint across training, validation, and test splits.
- Scenario families overlap across splits.
- Semantic deduplication is not complete.
- Internal validation and test labels are not independently authored.
- Frozen Protocol Gauntlet proposals have no exact overlap with the curriculum.
- Sealed v3 has zero exact proposal overlap with this dataset and is excluded from training.

## Sources and provenance

Protocol examples are derived from public Ethereum specification documents listed in the dataset metadata and the pinned source manifest at `benchmarks/jeff/primary-source-manifest-2026-09-28.json`. The primary-source audit is `docs/research/JEFF_PRIMARY_SOURCE_AUDIT_2026-09-28.md`.

Sealed v1 and v2 prediction, stimulus, and label commitments are recorded in the dataset metadata. Their independent labels were revealed only after predictions were frozen. Once incorporated into training, they lost independent evaluation status.

## Data safety

The dataset contains no private keys, seed phrases, signatures, wallet credentials, private user data, or production secrets. It grants no execution authority. Do not add raw production conversations, credentials, unredacted personal information, or signing material.

## Known limitations

- The corpus is small and heavily templated.
- Most labels reflect project policy rather than broad community consensus.
- Protocol coverage is limited to six Ethereum standards and selected decision boundaries.
- Draft and review-stage protocol documents may change.
- Internal split scores cannot establish real-world generalization.
- Results cannot support a superiority claim against another model.
- The dataset is distributed under CC BY 4.0 and requires attribution.

## Reproduction

Generate or verify the exact curriculum with:

```powershell
npm run dataset:jeff-evidence
npm run verify:jeff-evidence
```

The canonical dataset SHA-256 is `6f07dfe92c208d2440402777a016f3a5f2e99df0ff9329a930fe26dadef221be`.
