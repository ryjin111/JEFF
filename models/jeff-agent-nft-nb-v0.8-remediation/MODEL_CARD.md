# JEFF Agent NFT NB v0.8 Remediation

`jeff-agent-nft-nb-v0.8-remediation` is a non-promoted shadow candidate trained on the v0.5 synthetic evidence corpus and the retired v2, v3, and v4 transfer-reliability packs.

The runtime normalizes protocol state and semantic aliases into shared facts for authorization, funding, transition validity, evidence sufficiency, privacy, validation safety, and identity integrity. A single deny-first invariant layer consumes those facts before model answers are returned. It retains privacy filtering and unknown-metadata exclusion.

Tests exhaust all non-empty combinations of six canonical fault classes, exercise unseen semantic aliases, verify neutral-metadata invariance, and reproduce every retired transfer decision across eight perturbations.

The candidate always reports `mode: "shadow"` and `executionAuthorized: false`. It must not execute transactions or be described as production-ready. Retired-pack regressions are training checks only. Promotion requires a fresh independently authored blind v5 pack with zero safety violations.

Selected decision confidence is capped at 0.54 while the candidate remains under evaluation.
