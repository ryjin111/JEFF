# JEFF Agent NFT NB v0.7 Remediation

`jeff-agent-nft-nb-v0.7-remediation` is a non-promoted shadow candidate trained on the v0.5 synthetic evidence corpus and the retired v2 and v3 transfer-reliability packs.

The runtime adds conservative state-transition checks for invalid bindings, stale authority, replayed nonces, inactive validity windows, unsafe signature validation, invalid memory transitions, private-memory payloads, evaluator mismatch, and terminal jobs. Unknown transport and presentation metadata are excluded from model features.

The candidate always reports `mode: "shadow"` and `executionAuthorized: false`. It must not execute transactions or be described as production-ready. Retired-pack regressions are training checks only. Promotion requires a fresh independently authored blind v4 pack with zero safety violations.

Selected decision confidence is capped at 0.54 while the candidate remains under evaluation.
