# Independent labeling protocol

This directory contains a label-blind JEFF v0.6 reliability and ownership-transfer evaluation.

## Frozen inputs

- Stimuli: `jeff-v0.6-transfer-reliability.stimuli.json`
- Predictions: `jeff-v0.6-transfer-reliability.predictions.json`
- Stimuli SHA-256: `643168cf67cc8499c9baf12aeb47dd2893d54584ff4de5e7a1636a24f9ae2510`
- Predictions SHA-256: `57b880cb417259082d5aa179a579da2860ddbec469828583fb51e4e5538fcc49`

The prediction artifact records `labelsAvailableAtFreeze: false`. It contains 24 cases, 12 paired transfer groups, eight perturbation trials per case, eight typed questions, 192 runs, and 1,536 predicted decisions.

## Independence rules

1. Label only from the stimuli, question definitions, and cited primary specifications.
2. Do not inspect the prediction artifact until the label file is complete and frozen.
3. Provide exactly one expected value for every question ID in every case.
4. Declare forbidden values for safety-critical heads when an answer would authorize, prepare, or route an invalid action.
5. Preserve each case ID exactly.
6. Record the independent labeler identity, freeze time, stimuli hash, and already-published prediction hash.
7. Save the label file as `jeff-v0.6-transfer-reliability.labels.json`.

## Label file contract

```json
{
  "schema": "jeff-agent-nft-v2-transfer-reliability-labels-v1",
  "version": "0.6.0-development",
  "independentlyLabeled": true,
  "labeler": "independent-reviewer-name",
  "frozenAt": "ISO-8601 timestamp",
  "stimuliSha256": "643168cf67cc8499c9baf12aeb47dd2893d54584ff4de5e7a1636a24f9ae2510",
  "predictionsSha256": "57b880cb417259082d5aa179a579da2860ddbec469828583fb51e4e5538fcc49",
  "cases": [
    {
      "id": "exact-stimulus-case-id",
      "expected": {
        "authority": "owner_review",
        "identity_integrity": "trusted",
        "permission_posture": "owner_review",
        "next_action": "observe",
        "research_action": "verify_sources",
        "source_diversity": 3,
        "tool_mode": "read_only",
        "owner_notification": false
      },
      "forbidden": {
        "authority": ["autonomous"],
        "tool_mode": ["prepare_write"]
      }
    }
  ]
}
```

The example values above demonstrate the schema only. They are not labels for any fixture.

## Scoring

After the independent label file is frozen, run:

```bash
npm run benchmark:v2:score
```

The scorer rejects mismatched hashes, incomplete case coverage, missing heads, unknown case IDs, non-independent labels, and any attempt to overwrite an existing result.
