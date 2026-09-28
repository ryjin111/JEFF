# JEFF Agent NFT v0.9 Remediation Dataset

This synthetic remediation corpus extends the v0.5 evidence corpus with the independently labeled, retired v2, v3, v4, and v5 transfer-reliability packs.

The retired packs cannot be reused as promotion evidence. Prediction, label, and failed-result hashes are embedded in `seed.json` so the build can verify each blind freeze. V2 through v4 retain their established learner weights. V5 is held at zero learner weight and used for deterministic policy regression, preventing a small safety pack from distorting the broader classifier.

The v5 additions cover complete and incomplete canonical safety envelopes, polarity-aware semantic aliases, contradictions between optimistic canonical facts and raw denial evidence, and transfer privacy. Earlier transfer and safety families remain included through v2, v3, and v4.

This dataset is synthetic and is not evidence of production safety, legal compliance, or real-world autonomy.
