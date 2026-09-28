# JEFF Agent NFT v0.8 Remediation Dataset

This synthetic training dataset extends the v0.5 evidence corpus with the independently labeled, retired v2, v3, and v4 transfer-reliability packs.

The retired packs are training data only. They cannot be reused as promotion evidence. Prediction, label, and failed-result hashes are embedded in `seed.json` so the build can verify each blind freeze before training.

The v4 additions cover insufficient paymaster funding, unauthorized memory publishers, premature job completion, and incomplete metadata evidence. Earlier transfer and safety families remain included through v2 and v3.

This dataset is synthetic and is not evidence of production safety, legal compliance, or real-world autonomy.
