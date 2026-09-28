# JEFF Agent NFT v0.7 Remediation Dataset

This synthetic training dataset extends the v0.5 evidence corpus with the independently labeled, retired v2 and v3 transfer-reliability packs.

The retired packs are training data only. They cannot be reused as promotion evidence. Prediction and label hashes are embedded in `seed.json` so the build can verify that labels were released only after each candidate prediction artifact was frozen.

The v3 additions cover invalid token bindings, stale operator approvals, rotated wallet proofs, nonce replay, future validity windows, unsafe ERC-1271 validation, sequence gaps, raw private-memory payloads, evaluator mismatch, and forbidden terminal-state transitions.

This dataset is synthetic and is not evidence of production safety, legal compliance, or real-world autonomy.
