# JEFF: OpenClaw for Agent NFTs

Updated 10 October 2026. Production remains on the original pilot; the reviewed release is on staging.

## Complete

- NFT/holder-epoch private conversations, identity, memory, saved results and bounded scheduled work using real OpenClaw.
- Owner consent for chat actions, pause, cancellation, Stop and durable failure recovery.
- Production checkpoint/isolated restore, encrypted configuration recovery and rollback source archive.
- Restricted-runtime dependency hardening and independent exact-container review.
- Bounded two-job provider capacity and an always-on Railway monitor.
- Labeled product demo with mouse click cues and independent technical review.

## Launch this release

- [x] Configure actual backup storage and separate credentials; verify encrypted upload, readback and restore. Railway staging daily backups are active on `81f22b8`; the first automatic object's isolated restore verified 86 files, 18 SQLite databases, 12 saved jobs and preserved the hosting ledger. See `evidence/operations/automatic-backup-proof.json`. Production backup scheduling still requires activation during promotion.
- [ ] Retain recovery keys independently of the host and this workstation; verify recovery access.
- [ ] Configure an external alert webhook and verify failure/recovery delivery.
- [ ] Record four remaining live holder observations: action cards, Memory reload, continuation and pause/cancel. Completed login, saved-conversation reload, memory recall and schedule/run checks remain accepted.
- [ ] Refresh production inventory/checkpoint, promote the exact reviewed candidate on the existing production volume and verify saved work and entitlements.

Builder owns activation, integration and promotion. Destination/access inputs and live holder observations are still required. Wider launch additionally needs documented RPC/provider quotas and broader capacity measurements; current pilot limits stay unchanged.

## Complete the broader product

- [x] Since your last visit: saved/failed outcomes, result links and explicit holder-scoped review state. Implemented in staging candidate `4846aba`; five fixture browser checks and three unit checks pass. Independent UX and reviewer served-delta sign-off passed on 4846aba; both findings closed.
- [x] First public-web research capability: supplied-page reader implemented locally with explicit per-run consent, source-linked saved results, Stop and deliberate retry. Backend review passed for c6a3a94; staging capability is enabled. Railway-egress real-provider save/reload and all 28 deployed source hashes are verified. Local real-provider/durable-reload verification and the 401-test suite pass; eight reader checks pass after a narrow parser hardening delta. Search discovery is not included. See WEB-RESEARCH.md.
- [ ] Expand useful skills/tools and connected-app workflows after that first capability passes acceptance.

Public API research extension: supplied JSON endpoints are implemented on staging candidate `f44a5f5`, with valid UTF-8/syntax/depth checks and unchanged consent, network, byte/time/excerpt and authority boundaries. Source review, 28 focused local checks, six real-JSON/simulated-model browser checks, and local real-provider save/reload pass. Railway real-provider JSON save/reload, all 28 container source hashes and verification-key revocation pass; independent served sign-off passed in channel message 32176. This adds public API reading; authenticated connected-account workflows remain unfinished.

The supplied-page reader is the enabled external capability on staging. Other external tools, connected apps, package installation and self-updates remain disabled. Paid checkout/free passes/inference funding have separate activation and accounting gates. They are not enabled by production promotion or by a simulated demo.
