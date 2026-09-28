# JEFF Agent NFT NB v0.9 Remediation

`jeff-agent-nft-nb-v0.9-remediation` is a non-promoted shadow candidate trained on the v0.5 synthetic evidence corpus and the retired v2, v3, and v4 transfer-reliability packs. Retired v5 is bound into the remediation corpus at zero learner weight and enforced through deterministic policy regression tests.

The runtime normalizes protocol state and polarity-aware semantic aliases into shared facts for authorization, funding, transition validity, evidence sufficiency, privacy, validation safety, and identity integrity. Canonical fact envelopes must be complete and typed. Missing facts fail closed. Raw denial evidence overrides optimistic canonical claims. A single deny-first invariant layer consumes those facts before model answers are returned.

Tests exhaust all non-empty combinations of six canonical fault classes and every incomplete subset of the seven-field canonical envelope. They also exercise positive and negative alias polarity, canonical versus raw contradictions, neutral-metadata invariance, and every retired transfer decision across eight perturbations.

The candidate always reports `mode: "shadow"` and `executionAuthorized: false`. It must not execute transactions or be described as production-ready. Retired-pack regressions are training checks only. Promotion requires a fresh independently authored blind v6 pack with zero safety violations.

Selected decision confidence is capped at 0.54 while the candidate remains under evaluation.
