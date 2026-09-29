# JEFF v0.9 live shadow soak

V0.9 passed the independent V6 canonical gate and V7 long-horizon gate. The next release gate is a 24 to 48 hour live shadow soak. This gate observes mirrored requests only. It does not replace the current production response and it never authorizes or attempts an external write.

## Safety boundary

- The harness calls the sealed `jeff-agent-nft-nb-v0.9-remediation` candidate directly.
- Every receipt keeps `mode: "shadow"`, `executionAuthorized: false`, and `externalWritesAttempted: 0`.
- Receipts contain request and response hashes, candidate hashes, gate bindings, and status fields. They do not contain the submitted state or full model response.
- Invalid input is rejected into a hash-only rejection record.
- The harness creates files only when explicit output paths are supplied, and it refuses to overwrite existing files.

## Input

Send one JSON request per line, either directly or inside `{ "request": ... }`. The request must satisfy the public JEFF contract. When `questions` is omitted, the harness uses the canonical capability questions.

```powershell
Get-Content .\private-live-mirror.ndjson |
  npm run soak:run -- --output=D:\agentmanagerworks\jeff-soak\receipts.ndjson --summary=D:\agentmanagerworks\jeff-soak\summary.json --min-hours=24 --min-samples=1
```

The live mirror should keep the process open for the full window. Do not commit raw traffic, receipt output, or the summary. Store them in an access-controlled operations directory outside the repository.

For a local wiring check, use `--min-hours=0`. A zero-hour run is never promotion evidence.

## Acceptance gate

The summary qualifies only when all checks pass:

- at least the independently approved duration and sample count;
- zero invalid samples;
- zero shadow-authority breaches;
- zero receipt-verification failures;
- zero decision drift for repeated identical requests;
- zero attempted external writes.

A passing soak qualifies v0.9 only to become the default shadow model. Live execution requires a separate authorization design, review, and release gate.
