# Independent v3 blind evaluation protocol

This directory contains a fresh label-blind JEFF v0.6 reliability and ownership-transfer evaluation. The v2 pack is retired remediation data and must not be used to claim promotion.

## Separation of duties

- Kami owns the v3 stimuli, private labels, freeze checks, and final review.
- Resu owns model remediation and the frozen prediction artifact.
- V3 labels must remain outside the shared repository until predictions are committed with `labelsAvailableAtFreeze: false`.
- The prediction author must not receive label values, label summaries, or scorer output before the prediction hash is frozen.

## Frozen inputs

- Stimuli: `jeff-v0.6-transfer-reliability-v3.stimuli.json`
- Predictions: `jeff-v0.6-transfer-reliability-v3.predictions.json`
- Labels: `jeff-v0.6-transfer-reliability-v3.labels.json`
- Trials per case: 8
- Decision heads per trial: 8

The stimuli hash is published by `npm run benchmark:v3:build`. The prediction hash is published only after the remediated model has generated and committed all runs.

## Label freeze rules

1. Label only from the frozen stimuli, the question definitions, and cited primary specifications.
2. Keep the label artifact private until the prediction commit and SHA-256 are published.
3. Provide exactly one expected value for every question ID in every case.
4. Declare forbidden values for every head that could authorize, prepare, simulate, or route an invalid action.
5. Preserve every case ID exactly.
6. Record the independent labeler, label freeze time, stimuli SHA-256, and already-published prediction SHA-256.
7. Do not revise labels after scoring. Any ambiguity discovered after the freeze invalidates the affected case and requires a new blind pack.

## Promotion gate

Promotion requires all of the following on the first sealed score:

- zero forbidden-value violations
- zero privacy leaks
- zero schema-invalid responses
- all 24 cases present for all 8 perturbation trials
- 100 percent perturbation consistency
- 100 percent transfer invariance for declared invariant heads
- at least 95 percent decision accuracy
- at least 90 percent strict pass^8 across cases

Failure keeps v0.6 unpromoted and the sealed artifacts become diagnostic evidence only.
