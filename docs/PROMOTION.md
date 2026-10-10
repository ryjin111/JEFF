# Production promotion and recovery plan

This is the prepared procedure, not a record of a production deployment. Production remains on its existing pilot. Read-only metadata was checked on 9 October 2026, at approximately **17:46 Asia/Taipei**; no production restart, variable change, volume operation or private workspace read was performed.

Update, 10 October 2026: actual production checkpoint/isolated restore, encrypted provider-configuration recovery, rollback source retention, restricted dependency removal, bounded two-job staging capacity, an always-on monitor and independent exact-container review are complete. The temporary inspection key is revoked. Recurring remote backup activation, independent key retention, external alert delivery and remaining holder observations are still pending. See [current operations evidence](OPERATIONS-20261010.md) for the current status; the dated inventory below remains historical and must be refreshed before promotion.

## Existing production target

| Item | Existing value |
| --- | --- |
| Public origin | `https://simple-jeff-production.up.railway.app` |
| Project | `ec9d2cd1-0714-425b-9bfa-2392fee7c7a8` |
| Environment | `production` / `e369112f-cf3a-4b18-84e6-e9d94f799fae` |
| Service | `simple-jeff` / `2fbd4023-b87e-4b9b-a3c5-450d4f90fbff` |
| Successful deployment | `3dbc3610-d799-4c0a-8133-ac727759559d` |
| Expected source | `4a0145727279d22e0db0394b0da0ea5ff3ace03e` |
| Production volume | `6d50acfe-4cfc-467a-9f64-b17571d947d1` |
| Volume instance | `94fb2ddd-3ef9-485d-aee0-666f394269a1` |
| Mount | `/data` |

Sanitized readback: `evidence/staging/production-promotion-metadata.json`. The returned service metadata did not establish all effective restart, health, sleeping or drain settings, so those remain explicit preflight checks. Refresh this inventory immediately before executing a promotion.

## Gates before production changes

1. Carry forward Room #35's accepted sign-in, saved-conversation reload, memory recall and holder-reported scheduling. The scheduling report does not identify an exact tested source, job or browser-closed timing. Outstanding observations are a new continuation turn, explicit Memory-view reload and pause/cancellation. Preserve completed acceptance records when assessing the production candidate.
2. Preserve independently retained recovery keys and configure recurring encrypted off-machine backups. The actual historical checkpoint passed local recovery and a guarded replacement cloud service/volume restart, as recorded in [backup operation](BACKUP.md#replacement-cloud-recovery-9-october-2026). Provider-credential recovery, post-checkpoint reconciliation and an actual production checkpoint remain separate requirements.
3. Resolve or explicitly assess the remaining dependency findings against the final installed artifact; record the decision before widening service or enabling tools.
4. Validate production RPC capacity, real provider capacity and independent monitoring as described in [monitoring](MONITORING.md). Preserve current pilot limits until measured.
5. Build the exact candidate source and pin the tested dependency lockfile. Preserve a reproducible copy of the old image/source, private variables and configuration for rollback. Confirm provider image retention rather than assuming a two-day-old image will remain available indefinitely.

Paid checkout, free passes and inference credits need their own funding/configuration/acceptance gate. Keep disabled features disabled. This promotion does not authorize the separate token relaunch or change existing token, pool, beneficiary, plan or invoice bindings.

## Preserve the existing data and entitlements

Upgrade the existing production service using its **existing production `/data` volume**. Do not attach the staging volume, replace production with local `data`, seed production from fixture data, or recreate a missing ledger. Keep the chain, collection, owner epoch and account/NFT storage identities unchanged.

The whole-tree checkpoint must retain saved bridge jobs and results, NFT/account records, workspace state, hosting invoices, consumed payment records, entitlement periods, free-pass consumption, task usage/hourly counters, schedule grants and claims, inference funding/grants/reservations/charges, SQLite databases/WAL files, and both ledger initialization markers. Existing valid legacy ledgers acquire a loss guard without rewriting payment history. Preserve that marker after it is created.

The original pilot's maintenance marker defaults to `/tmp/simple-jeff-maintenance.json`; the candidate defaults to `/data/maintenance.json`. Read the actual `JEFF_MAINTENANCE_MARKER` override and use the matching path for each version. The current `scripts/backup-production.mjs` expects the candidate's remote `resolveMaintenanceMarkerPath` export; that export is absent in source `4a014572`. Do not run the current helper unchanged against the old pilot. Prepare and test the appropriate legacy-compatible capture path before the production checkpoint.

New workspace conversations and schedules are additive. Existing unbound legacy jobs remain in the bridge history and should open through Activity's receipt view; they must not be assigned silently to a newly created conversation or another owner epoch. Validate a synthetic legacy dataset before promotion and an authorized existing receipt after promotion. Do not infer migration success from an empty new conversation list.

## Synthetic migration and code rollback evidence

The 9 October Windows fixture passed the exact old source `4a014572` with OpenClaw `2026.9.8` → candidate `b13fbac0407e57d62540b386447878bd5412fdc4` with OpenClaw `2026.9.9` → exact old source sequence, retaining the **same current data tree** for code rollback. All nine legacy files, comprising the hosting ledger and eight saved receipts, stayed byte-identical. Invoices, consumed payments/free passes, hosting terms and task/hourly counters were preserved. Signed HTTP history and the candidate Activity backend exposed the expected saved jobs while preserving owner/epoch isolation and idempotent payment/pass retries.

One new future schedule was explicitly cancelled with zero runs before rollback. Its cancellation receipt and all ten candidate-added files remained byte-identical afterward. The old binary cannot operate candidate workspace, memory or schedule endpoints; preserved files support a later re-upgrade, not those capabilities in the old application. Cancel active candidate grants and retain their receipts before a real return to old code.

Evidence: `evidence/release/legacy-migration-rollback-20261009.json`. This synthetic source/data compatibility exercise accessed no production data, secrets, live chain or real provider. It proves neither an actual production checkpoint/rollback nor Linux signal draining. The legacy maintenance-marker and missing `resolveMaintenanceMarkerPath` incompatibility above remains unresolved by this fixture; a tested legacy-compatible capture path is still required before the production checkpoint.

## Execution window

1. Record the old deployment/image/source, effective private-variable snapshot, volume identity, public configuration and a fresh recovery checkpoint. The variable snapshot and private data stay in restricted storage, not in logs or this document.
2. Announce the actual maintenance interval through an authorized channel. Enter the old server's verified maintenance mechanism; drain requests and durable jobs, verify no runtime writer is active, checkpoint SQLite where applicable, and capture the consistent encrypted whole-tree backup. A successful backup must also show the service resumed or intentionally stayed paused for the change.
3. Deploy the exact tested source to the existing production service and volume with one writer, direct Node startup, sleeping disabled, zero overlap, `/health`, a 180-second health timeout and 180-second graceful drain. Set the exact production public origin and source revision. Preserve existing pilot expiries and consumed terms; do not copy Room #35's temporary staging grant into production.
4. Read back effective settings; do not rely only on `railway.json`. Verify `/data` is actually mounted and the expected volume was retained. Railway prevents simultaneous deployments on the same volume, so allow a brief interruption. [Railway health checks](https://docs.railway.com/deployments/healthchecks), [Railway volume limits](https://docs.railway.com/volumes/reference)
5. Check health, exact source, frontend hashes, strict CSP, unsigned private-route denial and public ownership/discovery from the new deployment. Retrieve an existing authorized saved receipt without inference. Require a fresh holder signature after process replacement; sessions are intentionally in memory.
6. Verify pre-change invoices, active terms, consumed free passes, task counters and unknown inference holds against the checkpoint/independent records using aggregate or hash comparisons. Verify scope/epoch separation and that legacy results remain readable. Do not publish holder content in the verification report.
7. Complete one explicitly authorized holder task and schedule, inspect their durable results and accounting, and watch resource/RPC/provider errors. Point monitoring at production and update its expected revision only after these checks pass.

## Rollback without losing newer work

If health, ownership, durable reads, scope isolation or accounting fail, pause new admissions immediately and retain a consistent checkpoint of the failed candidate's current tree. Do not clear a ledger, delete initialization/restore markers, automatically replay a task or restore an earlier snapshot over newer work.

If the existing tree is compatible with the old application, restore the retained old image and its correct variables **using the current volume**. Railway rollback restores both image and custom variables; confirm the resulting origin, RPC, feature flags and maintenance marker again. A platform code rollback does not restore the volume's historical contents. If image retention has elapsed, rebuild the preserved old source/lockfile rather than selecting an unrelated release. [Railway rollback procedure](https://docs.railway.com/guides/roll-back-bad-deploy)

Do not blindly return to source `4a014572` while candidate schedules are still live: that version has no scheduler/restore guard and does not know the new initialization loss guards. Keep external admission closed during compatibility evaluation, and preserve any candidate grants/claims for an explicit cancellation or reconciliation plan. If the old binary cannot safely interpret current state, keep the service paused and repair forward.

Restore a data checkpoint only into an empty isolated recovery target first. Every restored tree keeps its restore guard. Reconcile all post-checkpoint payments, task usage, free passes, funding/grants/charges, unknown holds and schedule claims using surviving independent records before resuming execution. If those records cannot be recovered, leave the affected features disabled. Never remove the guard merely to make a health or holder test pass.
