# JEFF staging acceptance — 9 October 2026

Staging: https://jeff-staging-jeff-staging.up.railway.app

This is a separate JEFF service and volume. The existing hosted pilot continues on its original deployment. The staging application runs real OpenClaw and the configured Bankr provider; it contains no disposable fixture wallet or simulated responses.

## Deployment identity

| Item | Value |
| --- | --- |
| Application source | `8a8dd4b1ebe4893a38bfe5db0b3cc3cc2c1d43cd` |
| Railway project | `ec9d2cd1-0714-425b-9bfa-2392fee7c7a8` |
| Environment | `jeff-staging` / `f5fd75b1-27d8-46e7-81dd-88abde70eba0` |
| Service | `jeff-staging` / `b527c9ed-5728-4f14-83f6-bca5bc28ad8b` |
| Current deployment | `9c78d7ed-aa9e-4b45-8cdd-19b7ab338894` |
| Isolated volume | `69c4a618-e0a1-45c7-ae76-3bb366ea0c78`, mounted at `/data` |
| Staging ownership/discovery RPC | `https://robinhood-rpc.publicnode.com` |

Provider credentials are stored in Railway service variables and omitted from all reports. Staging currently uses the existing JEFF provider credential, so its model use shares that provider billing capacity. Prepaid inference accounting, paid checkout, free passes and external tools remain disabled. Room #35 has an explicit staging pilot through **16 October 2026, 23:59 Asia/Taipei**. Its hosting allowance is 100 tasks, with the existing ten-task rolling hourly limit.

## Verified

- Backend validation passed 266 automated tests. Six frontend integrity tests were rerun successfully. The updated frontend passed 41 fixture browser checks. Coverage includes restored account sessions, explicit account/NFT selection, fresh Room #35 signatures, hosting admission, private-memory isolation, first-task admission, automatic recovery after repeated refresh failures, and safe formatted replies on desktop and mobile.
- A clean source installation passed production dependency installation, OpenClaw CLI verification, health/shutdown/restart checks and 15 focused runtime/restore tests. It used no shared `node_modules`.
- Railway built the pinned Linux Dockerfile successfully and started it with the separate `/data` volume.
- Seven public HTTPS checks passed: health, exact source revision, live hosted configuration, unsigned private-route rejection, no fixture wallet, strict CSP and reachable application assets.
- Desktop and mobile staging render without horizontal overflow, external page requests, JavaScript errors or console/CSP errors. These checks used an isolated browser without a holder wallet.
- The live wallet-flow correction was checked at 1440×1000 and 390×844: served JavaScript matches the local source hash, Agent NFT actions reset account mode, the connection headings match the selected scope, and unsigned private requests still return 401. No live wallet signature or model request was made by this check.
- A genuine operator OpenClaw turn completed and its saved result was retrieved through a new bridge. This was an operator check outside holder workspaces, without impersonating a holder login.
- A replacement process retrieved the same saved job and text hash from the volume. It reported `retrievedAfterProcessRestart: true` and `modelRerun: false`.
- Effective deployment metadata confirms one replica, Serverless disabled, direct Node startup, `/health`, health timeout 180 seconds, overlap zero and graceful drain 180 seconds.

Operator evidence: job `e81aeefc-57fb-42fa-94e0-588674b300ad`; text SHA-256 `e4fa97816b655102b0b983e70aaf12ddb357d6f4ef6a04472538e4109adf68ee`. The original result timestamp is `2026-10-09T04:58:48.797Z`; process-restart retrieval was verified at `2026-10-09T05:02:01.891Z`. No model output text is published here.

The wallet-flow deployment retrieved that same saved result again at `2026-10-09T05:33:17.209Z`, reporting persistence source `30254683cb44c8c907de8633b7a59b0f84c81808` and `modelRerun: false`.

The task-flow deployment retrieved the same result at `2026-10-09T05:51:07.518Z`, reporting persistence source `ddbe3eeeb88e3ea1bfeeb09cfa35e7d8c933902a` and `modelRerun: false`. Its live desktop/mobile smoke check matched served JavaScript to source, reported no page/console errors or overflow, and left signed holder tasks untested.

The RPC configuration deployment retrieved the same result at `2026-10-09T05:58:36.208Z`, again without a model rerun.

The JEFF wording deployment retrieved the same operator result at `2026-10-09T06:21:05.168Z`, reporting persistence source `fc3deb5ff0d1c3046f169269cbddaf0fa7079fd9` and `modelRerun: false`. The current formatted-reply deployment retrieved it again at `2026-10-09T06:46:42.456Z`, reporting persistence source `8a8dd4b1ebe4893a38bfe5db0b3cc3cc2c1d43cd` without a model rerun. These remain operator proofs outside holder workspaces.

The initial upload recognized `railway.json` field mappings but did not persist its deployment settings. A deploy-only environment configuration patch applied the settings explicitly; the replacement deployment metadata proves their effective values. The volume is attached and restart persistence is verified. Provider metadata still does not report a separate `requiredMountPath` guard, so that field is not counted as verified.

## Room #35 holder acceptance

The holder confirmed Room #35 for staging acceptance. Its signed NFT workspace showed owner epoch 0, Ready status and 100 tasks remaining. A later holder screenshot dated **9 October 2026, 14:31 Asia/Taipei** shows a generated reply, the Saved badge and “Run completed and saved.” Sanitized HTTP metadata records a task admission HTTP 202 at `2026-10-09T06:31:47.854Z` and successful workspace refreshes afterward. This confirms at least one genuine Room #35 task completed and saved in the hosted pilot. The screenshot does not disclose its job ID, and does not establish the terminal status of the earlier `cad3400e` task. Evidence is in `evidence/staging/holder-task-acceptance-metadata.json`. Restarted sessions still require a fresh holder signature.

The initial holder screenshot showed a signed standalone wallet account with no hosting, rather than an NFT workspace. Read-only staging discovery for that wallet returned Rooms **7, 35, 108, 109 and 110**. The UI preserved account mode when opening an Agent NFT connection, and its dropdown could lose a selected mode during synchronous session cleanup. Release `3025468` fixes both paths: Agent NFT actions choose NFT mode explicitly, account mode remains an explicit choice, and inactive wallet accounts display a route to their owned Rooms. Room hosting remains attached to the NFT and requires a fresh holder signature; account memories stay in their separate workspace.

The holder's first send then failed immediately: Railway HTTP logs show `POST /api/conversations` returning 503 in 545 ms at `2026-10-09T05:37:28.238877614Z`, followed by failing workspace refreshes. The application did not log the original underlying exception. Subsequent public ownership/discovery checks succeeded, so an RPC failure is not established as the cause.

Release `ddbe3ee` submits the first task directly through `POST /api/jobs`, using the backend's existing conversation creation path. It adds sanitized request-failure diagnostics and a distinct fail-closed ownership-RPC error. Once a task is acknowledged as admitted, a failed refresh retains its job ID and prevents another submission; manual refresh preserves completion tracking. Fixture regressions prove rejection preserves the draft, one accepted job creates one conversation, and recovery/reload does not rerun the task.

The new diagnostics identified the repeated workspace 503s: `JEFF_CHAIN_UNAVAILABLE` with upstream `HttpRequestError` status **403**, including `2026-10-09T05:53:27.652507770Z` and `2026-10-09T05:54:17.561388658Z`. This establishes the cause of those later ownership failures; the original unlogged conversation exception is not independently identified. Staging's RPC configuration was switched to the mainnet endpoint published by [PublicNode](https://robinhood.publicnode.com/). Local validation confirmed chain 4663, the expected Room #35 owner and epoch, fresh pinned-block reads and Multicall3 consistency.

Railway egress validation then passed four concurrent Room #35 ownership challenges (HTTP 200 in 635/609/618/624 ms), NFT discovery with Room #35 present, and healthy service status at `2026-10-09T06:00:17.576Z`. These checks supplied no holder signature, created no holder session, read no private work and called no model. The sanitized receipts are `evidence/staging/publicnode-rpc-validation.json` and `evidence/staging/rpc-fix-railway-smoke.json`. These public probes preceded the successful holder task recorded above.

Release `94168bb` fixes a browser recovery defect: a failed workspace GET previously stopped polling and left an ownership warning indefinitely. Temporary failures now retry only workspace GETs after 2, 5, 10 and then at most once every 30 seconds. Recovery clears its own warning, keeps accepted job IDs and unsent drafts, and never repeats a task POST or wallet signature. Logout, wallet changes and session expiry cancel recovery; hidden tabs pause polling. The fixture checks also prove that a rejected Send recovers its connection warning without creating a job, and an admitted job becomes Saved after three consecutive GET failures without another POST.

The holder's task `cad3400e-01b9-4f65-bfb0-b1093c658f95` was admitted on the preceding deployment while this release was building. Sanitized HTTP metadata shows authentication HTTP 200 at `06:14:34.730Z`, task admission HTTP 202 at `06:14:39.080Z`, and workspace HTTP 200 at `06:14:40.026Z` and `06:14:42.926Z`. Its next workspace request returned HTTP 502 in 6 ms at `06:14:45.152Z`, during the staging restart. This latest connection failure is distinct from the earlier ownership HTTP 403s. The saved terminal status has not been read through the holder session. Reopen Room #35 and inspect this existing task in Activity before submitting another; it must not be automatically replayed. A graceful shutdown normally saves a Failed receipt, while restart recovery can expose an Interrupted receipt; neither outcome is claimed for this specific task without its authorized receipt.

Release `fc3deb5` changes normal app status, runtime presentation and legacy marketing copy to JEFF, including “JEFF is working on your request.” Technical run receipts still report the actual runtime and model. Its final 38 fixture browser checks passed, including the rendered JEFF status, preserved receipt details, repeated GET failure recovery, rejected-Send draft preservation and cancellation of recovery on wallet changes. Sanitized live source/health/browser checks are recorded in `evidence/staging/ownership-recovery-smoke.json`; the holder restart correlation is in `evidence/staging/holder-restart-observation.json`. Restarted in-memory sessions require a fresh holder sign-in.

Release `8a8dd4b` renders saved replies as structured Markdown: headings, emphasis, nested lists, code, quotes, tables and protected HTTP/HTTPS links. It uses an unchanged locally vendored Marked lexer and builds an allowlisted DOM tree; HTML remains literal, remote images are suppressed, unsafe URLs are excluded, and input/render complexity is bounded. Existing replies receive the same presentation without another model call. Copy and downloaded receipts preserve the original Markdown; stored text and content hashes remain unchanged. All 41 fixture browser checks passed, including actual Windows clipboard behavior, downloaded/stored integrity, desktop/mobile formatting, and unsafe-content cases. The renderer does not change model instructions or personality.

The formatted-reply deployment passed 12 live public checks at **14:47 Asia/Taipei**: exact source and health, matching frontend and four renderer/parser/license/source-map assets, strict CSP, unsigned private-route rejection, public Room #35 discovery/challenge, and safe desktop/mobile canary rendering with no browser errors, external requests or overflow. No holder session, private workspace or inference call was used. Before deployment, the last task admission was 864 seconds old and the holder had shown its Saved response; no newer task admission was observed.

For a broader production service, provision and validate a dedicated RPC endpoint with sufficient capacity. Robinhood's official guide describes its original public endpoint as rate-limited and recommends provider-backed access for production. [Robinhood connection guide](https://docs.robinhood.com/chain/connecting/)

1. Send one task and wait for its saved response. Reload and continue the conversation.
2. Save a harmless memory note, send a task that uses it, then reopen Memory to verify persistence.
3. In **Scheduled work**, authorize a short test with a one-minute interval, at most two runs and a one-hour expiry. Close the browser, return after the next run, and open its saved result.
4. Cancel any remaining test schedule. Check the pause setting, then resume before normal use.

These steps consume the pilot task allowance. The operator runtime check does not substitute for this holder acceptance.

## Backup status

An isolated Railway volume snapshot was created through its authenticated HTTPS API at `2026-10-09T05:13:06.593Z`: backup `6a5df0d6-e428-4466-8ae3-91c6b2d9818a`. It is listed by the provider. The terminal workflow query returned **Not Authorized**, so completion and restoration are not counted as verified. No restore ran. [Railway volume backups](https://docs.railway.com/volumes/backups)

The separate AES-256-GCM off-host backup and isolated restore drill remains pending. Its SSH route stopped before any remote command or maintenance operation because no provider-authenticated host key was available. Railway staff confirms that independently authenticated SSH host verification is unavailable. [Railway staff confirmation](https://station.railway.com/questions/official-ssh-host-key-fingerprints-for-s-6c2aecfc)

The temporary SSH key registration was removed and its absence verified. Automatic approval review rejected deleting its local private/public key files with **blocked by policy**, without a more specific reason. Those unregistered files remain under restrictive ACL; the rejection was not bypassed. The sanitized receipt and continuation instructions are in `evidence/release/staging-backup-pending.json` and `evidence/release/staging-backup-drill-pending.md`.

Provider snapshots and JEFF encrypted exports are separate recovery paths. A provider volume restore does not establish JEFF's application restore guard or financial reconciliation; those controls must be applied before restored storage resumes scheduled work or spending.

## Remaining acceptance

1. Verify conversation continuation after reload and memory persistence. Holder sign-in and a completed saved response have passed.
2. Complete the holder-authorized cloud schedule and pause/cancellation checks above.
3. Complete the stage-only encrypted backup/isolated restore drill and record its receipt.
4. Check production capacity and continuous monitoring before a wider holder pilot. Railway deployment health checks alone are not ongoing monitoring.
5. Approve a funded credit policy and payment configuration before enabling their corresponding features. Token relaunch and automatic token-holder distributions remain separate.

Public smoke reports and screenshots are in the local ignored `evidence/staging/` folder. Provider keys and backup encryption keys are excluded. Production remains on deployment `3dbc3610-d799-4c0a-8133-ac727759559d`, source `4a0145727279d22e0db0394b0da0ea5ff3ace03e`.
