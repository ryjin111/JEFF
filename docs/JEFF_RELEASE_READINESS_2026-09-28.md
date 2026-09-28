# JEFF v0.5 release readiness

Reviewed: 2026-09-28

## Decision

JEFF v0.5 is complete for promoted production shadow use and its first public open-source model release package. Clint approved MIT for the code and checkpoint and CC BY 4.0 for the dataset on 2026-09-28.

No autonomous execution authority is part of this release. The production boundary remains `mode: shadow` and `executionAuthorized: false`.

## Passing gates

- 117 of 117 JEFF tests pass.
- v0.5 dataset and checkpoint reproduce exactly.
- Internal validation accuracy is 91.1830%.
- Internal test accuracy is 90.1786%.
- Independently authored sealed v3 accuracy is 93.9815% over 216 decisions.
- Every sealed v3 capability family exceeds 91%.
- Every sealed v3 protocol exceeds 86%.
- Mean confidence on sealed v3 wrong answers is 49.8406%, below the 55% gate.
- The promoted loader verifies the checkpoint, runtime, receipt, source manifest, and source audit hashes and fails closed.
- The production web build passes.
- The live production GET and POST probe serves v0.5, returns all 28 decision heads, and preserves the shadow authority boundary.
- The v0.5 model card and dataset card are present.

## Approved licenses

1. Root source code: MIT.
2. v0.5 checkpoint: MIT.
3. v0.5 evidence curriculum: CC BY 4.0.

## Verification

Technical gate:

```powershell
npm run verify:jeff-release:technical
```

Full public-release gate:

```powershell
npm run verify:jeff-release
```

The full gate validates the approved license files and fails closed if any file or required license marker is missing.
