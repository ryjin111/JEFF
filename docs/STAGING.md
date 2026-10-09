# JEFF staging acceptance — 9 October 2026

Staging: https://jeff-staging-jeff-staging.up.railway.app

This is a separate JEFF service and volume. The existing hosted pilot continues on its original deployment. The staging application runs real OpenClaw and the configured Bankr provider; it contains no disposable fixture wallet or simulated responses.

## Deployment identity

| Item | Value |
| --- | --- |
| Application source | `30254683cb44c8c907de8633b7a59b0f84c81808` |
| Railway project | `ec9d2cd1-0714-425b-9bfa-2392fee7c7a8` |
| Environment | `jeff-staging` / `f5fd75b1-27d8-46e7-81dd-88abde70eba0` |
| Service | `jeff-staging` / `b527c9ed-5728-4f14-83f6-bca5bc28ad8b` |
| Current deployment | `56008b28-ffad-4b88-bbd9-ef89e8cdc541` |
| Isolated volume | `69c4a618-e0a1-45c7-ae76-3bb366ea0c78`, mounted at `/data` |

Provider credentials are stored in Railway service variables and omitted from all reports. Staging currently uses the existing JEFF provider credential, so its model use shares that provider billing capacity. Prepaid inference accounting, paid checkout, free passes and external tools remain disabled. Room #35 has an explicit staging pilot through **16 October 2026, 23:59 Asia/Taipei**. Its hosting allowance is 100 tasks, with the existing ten-task rolling hourly limit.

## Verified

- The application baseline passed 261 automated tests. The wallet-switch correction passed 32 fixture browser checks, including restored account sessions, explicit account/NFT selection, fresh Room #35 signatures, hosting admission and private-memory isolation on desktop and mobile.
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

The initial upload recognized `railway.json` field mappings but did not persist its deployment settings. A deploy-only environment configuration patch applied the settings explicitly; the replacement deployment metadata proves their effective values. The volume is attached and restart persistence is verified. Provider metadata still does not report a separate `requiredMountPath` guard, so that field is not counted as verified.

## Room #35 holder acceptance

The holder confirmed Room #35 for staging acceptance. Its NFT holder login has not yet been verified. Refresh staging in a browser with the holder wallet, choose **Connect an Agent NFT**, select Room #35, and sign the login challenge.

The initial holder screenshot showed a signed standalone wallet account with no hosting, rather than an NFT workspace. Read-only staging discovery for that wallet returned Rooms **7, 35, 108, 109 and 110**. The UI preserved account mode when opening an Agent NFT connection, and its dropdown could lose a selected mode during synchronous session cleanup. Release `3025468` fixes both paths: Agent NFT actions choose NFT mode explicitly, account mode remains an explicit choice, and inactive wallet accounts display a route to their owned Rooms. Room hosting remains attached to the NFT and requires a fresh holder signature; account memories stay in their separate workspace.

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

1. Complete the Room #35 holder login, conversation and memory checks above.
2. Complete the holder-authorized cloud schedule and pause/cancellation checks above.
3. Complete the stage-only encrypted backup/isolated restore drill and record its receipt.
4. Check production capacity and continuous monitoring before a wider holder pilot. Railway deployment health checks alone are not ongoing monitoring.
5. Approve a funded credit policy and payment configuration before enabling their corresponding features. Token relaunch and automatic token-holder distributions remain separate.

Public smoke reports and screenshots are in the local ignored `evidence/staging/` folder. Provider keys and backup encryption keys are excluded. Production remains on deployment `3dbc3610-d799-4c0a-8133-ac727759559d`, source `4a0145727279d22e0db0394b0da0ea5ff3ace03e`.
