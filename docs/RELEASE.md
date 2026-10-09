# JEFF local release candidate

Prepared 7–9 October 2026. JEFF is open-source software for running your own Agent NFTs. Simple JEFF is the managed hosting product. This folder contains the local release candidate; it has not replaced the existing hosted pilot.

The workspace now connects its eight views to the application: Conversation, Activity, Skills & tools, Memory, Usage & credits, Scheduled work, Hosting and Settings. Jobs, conversations, memory, preferences and schedule grants use server storage. The original standalone design preview remains a separate artifact.

## Behavior included

| Area | Release candidate behavior |
| --- | --- |
| Access | Discover owned Rooms, sign a server challenge, select an NFT workspace; a separate signed wallet account route also exists. |
| Conversation | Create conversations, submit asynchronous text jobs, retrieve saved results, continue using bounded previous turns, copy answers and retry saving retained output. Action review also works in Activity's run dialog. |
| Identity and privacy | NFT workspaces are scoped by chain, collection, token, owner and ownership epoch. Fresh ownership checks revoke an old holder; a returning holder gets a fresh private workspace. |
| Memory and preferences | Save/delete memory notes, including explicit chat requests; review model-extracted notes before saving. Persist name, allowlisted model, selected-agent budget and pause state. Recalled text is passed as untrusted data. |
| Skills & tools | Enable built-in writing, analysis and planning prompt recipes. These influence text generation; external tools, shell execution, messaging and wallet actions remain disabled. |
| Activity and usage | Show saved jobs, workspace events, task allowances and, when configured, inference balances and scoped charge records. |
| Scheduled work | Explicit, expiring grants run text tasks through the same ownership, hosting, pause, concurrency and inference checks as manual work. Chat plans require inline owner consent. |
| Stop | Abort the owned runtime child and revoke its gateway credential. The saved job becomes failed; an uncertain provider charge remains held for reconciliation. |
| Hosting | Preserve existing pilot/paid/free-pass terms and task quotas. Paid checkout remains disabled in the example configuration. |

The application process can remain available on a persistent host and execute scheduled jobs without an open browser. Each OpenClaw turn starts on demand. This release does not create a dedicated continuously running OpenClaw gateway for every NFT.

Signed sessions last one hour and are revoked by logout, expiry or server restart. NFT requests also recheck current owner and epoch. Sign-in currently supports externally owned accounts; ERC-1271 contract-wallet signatures are not implemented. A wallet signature grants a session, without token spending authority.

NFT hosting time and its task allowance stay attached to the NFT. Private conversation history and memories stay in the holder's ownership epoch. Inference grants belong to the earning wallet and stay with that wallet when the NFT is sold. Standalone accounts have separate private workspaces and hosting terms; a token allowance alone does not silently create a paid hosting term.

## Personal-agent requests in chat

JEFF is the application. The selected NFT's configured name, such as Room #35, identifies its agent in the interface and model instructions. Saved notes belong to that agent's private ownership-scoped workspace.

An explicit literal current-user request such as `Remember: my verification word is blue lantern` automatically saves the supplied note after the chat run succeeds. Requests whose note must be extracted or summarized by the model produce a review card with **Save memory** and **Dismiss**. An unclear referent requires clarification. The service reports success only after the actual write; a model's proposal cannot establish that a note was saved.

Scheduling requests produce an inline plan with its objective, first-run timing, timezone, maximum runs and expiry. The holder must check consent and choose **Authorize schedule**. Plans permit 1–24 runs, an interval of at least one minute and expiry within seven days. The browser timezone is supplied with the request; specific times are converted to UTC and displayed in that timezone for review. A one-time request can name a specific future time. Recurring intervals start after the preceding run completes, so they do not promise a fixed daily wall-clock time. Results are saved in the workspace; authorization consumes the normal hosting allowance and any enabled inference credits when runs execute.

Memory and schedule cards remain available in the conversation and Activity's run dialog. If an action reply is lost or conflicts with a newer state, **Check saved status** and refresh use GET requests to retrieve the durable outcome. They never automatically repeat the action POST or model call. Conflicting apply/dismiss requests reconcile saved state; a committed schedule cannot be hidden by dismissing a stale proposal. Cancel an authorized grant in Scheduled work. Repeated application of the same action uses its durable action ID rather than creating another note or grant.

Only the current manual request can initiate these actions. Recalled memory, history, names and quoted material supply no authorization. Scheduled work cannot create further memory writes or schedule grants, including through structured model output. All existing ownership, pause, maintenance, restore and hosting checks still apply. These additions passed automated and public staging verification; new chat-action holder acceptance remains separate. The existing schedule/run check is accepted by holder report. Earlier release evidence below describes earlier candidates.

## Run and review locally

Use Node **24.21.0** for the release checks and OpenClaw CLI. The package permits Node 24.16 or newer within Node 24; the machine's older default Node 24.13.1 cannot run the pinned OpenClaw CLI. A compatible official portable installation is available at `D:\agentmanagerworks\tools\node-v24.21.0-win-x64\node.exe`.

From the project folder, with the compatible Node installation on `PATH`:

```sh
npm ci
npm run preview:release
```

Open `http://127.0.0.1:8421/`. The explicit fixture preview injects a disposable public signing wallet and simulates model responses. It exercises real application routes and persistence in an isolated temporary directory. It calls no live provider, chain or payment API. Stopping it removes its disposable storage. Its fixture routes and script are excluded from the production Docker image.

For a configured local service, copy `.env.example` to a private `.env`, supply the provider credential and a valid hosting entitlement, then run:

```sh
npm start
```

Safe example settings include:

```dotenv
PORT=8788
JEFF_BIND=127.0.0.1
JEFF_PUBLIC_ORIGIN=http://127.0.0.1:8788
JEFF_DATA_ROOT=./data
JEFF_MODEL=bankr/gpt-5.4-mini
JEFF_ALLOWED_MODELS=bankr/gpt-5.4-mini
JEFF_MAX_CONCURRENT_JOBS=2
BANKR_LLM_URL=https://llm.bankr.bot/v1
BANKR_LLM_API_KEY=
JEFF_INFERENCE_CREDITS_ENABLED=false
JEFF_INFERENCE_PRICING={}
JEFF_MAX_JOB_CHARGE_MICROS=100000
JEFF_PAID_CHECKOUT_ENABLED=false
JEFF_FREE_PASS_ENABLED=false
```

Use the chain, collection and RPC values in `.env.example` for the supported Room collection. A configured model key does not activate hosting. Pilot time requires an explicit future expiry; paid and free-pass access remain separate recorded entitlements.

## Scheduling and runtime limits

A schedule grant names a conversation and objective, an interval of at least one minute, at most 24 runs and an expiry no later than seven days after creation. It can be cancelled. The scheduler persists each occurrence claim before execution, rechecks ownership and owner epoch, and obeys agent pause, hosting/task limits, monetary admission and the service's concurrency cap. The default cap is two active jobs across the service.

The execution registry allows 1,024 live grants globally and 16 per NFT/account owner scope. Completed, cancelled and expired grants free registry capacity; a cancelled grant with unfinished admitted work keeps its slot until that work reaches durable finalization. Historical grant receipts remain on disk and visible in the workspace, so receipt storage and history length grow over time. Expiry is checked again after slow ownership checks, immediately before execution.

An occurrence left claimed by a stopped process is recorded as interrupted after recovery and is never automatically replayed. A new grant requires another explicit owner action. Missing or unavailable ownership data does not authorize a run. Schedule traffic stops during maintenance and under the restore guard.

The OpenClaw runtime uses a 16,384-token context policy and a 4,096-token output cap. Recalled memory and conversation text are bounded before execution. The metering gateway separately applies a conservative 65,536-unit input admission bound using UTF-8 message bytes plus framing; that larger bound allows the JEFF system context and recalled text to fit, and is also used to calculate the worst-case monetary hold. Response usage above the gateway's input or output cap cannot settle automatically.

Rejected bridge starts restore their task reservation. Accepted failures, cancellations, timeouts and interrupted jobs keep their task count. Stopping a child cannot establish that a forwarded provider request was free. Saved-result retrieval and retry-save do not run the model or consume another task.

Job-receipt writes now retry transient `EPERM`, `EACCES` and `EBUSY` rename failures within a bounded wait. They preserve the previous receipt and retry only the atomic file replacement, without rerunning the model or deleting the destination. Persistent failures still surface through the existing save/recovery flow.

## Funded inference accounting

Inference credits are optional and disabled by default. The SQLite ledger stores integer **microUSD**: 1,000,000 units equal $1. It records funding receipts, wallet grants, reservations, charges and reconciliation. Grants cannot exceed the funding assigned to their receipt, and concurrent reservations cannot spend the same balance. Charging releases the unused part of a reservation; an unknown provider outcome keeps its hold.

Funding entries are an operator attestation of already settled provider capacity. The CLI does not purchase credits or verify a funding receipt with Bankr. The operator must preserve the actual backing, reconcile the dedicated billing pool and keep its other obligations separate. No real funding or grants were created for this release work.

Bankr's documented `/v1/usage` reports aggregated billed cost, and `/v1/credits` reports wallet capacity including in-flight usage. Those aggregates do not attribute a provider debit to one concurrent JEFF job. This release therefore charges an explicitly configured **operator token tariff**, using measured prompt and completion tokens, and records `providerDebitVerified: false`. It does not calculate charges from wallet-balance differences or invent a per-request Bankr bill. [Bankr API reference](https://docs.bankr.bot/llm-gateway/api-reference/)

For each allowed bare model ID, `JEFF_INFERENCE_PRICING` must provide:

| Field | Required value |
| --- | --- |
| `basis` | `operator-token-tariff` |
| `policyId` | A stable version identifying the approved tariff |
| `inputMicrosPerMillionTokens` | A nonnegative safe integer; microUSD per million prompt tokens |
| `outputMicrosPerMillionTokens` | A nonnegative safe integer; microUSD per million completion tokens |

At least one rate must be positive. The tariff treats tokens included in the prompt/completion totals consistently, including cached prompt and reasoning tokens. Each combined request charge rounds upward to the next microUSD. A changed tariff needs a distinct policy version; each job retains the policy it was issued with. These rates are a service policy, not a claim about Bankr's current prices.

Preflight checks the full conservative input/output hold against the wallet's available credit, the selected agent's rolling 24-hour budget and the configured maximum job charge before consuming a hosting task. The default maximum job charge is 100,000 microUSD ($0.10). The gateway repeats its reservation atomically before forwarding. Real agent budget scopes include the owner epoch; wallet credit remains shared across that wallet's agents. Older unscoped holds count conservatively against each agent's budget.

OpenClaw receives a short-lived job credential for a loopback-only gateway. The upstream key stays in the parent service. The gateway permits one exact model, one provider request per job by default, bounded text messages and output, with tools disabled. It disables redirects and automatic gateway retries. Missing or contradictory usage, transport errors and uncertain responses preserve the hold for explicit reconciliation. Provider errors cannot create a refund by themselves.

## Offline credit administration

Run the CLI against the intended reconciled data root. The following POSIX-shell examples illustrate command fields; receipt IDs, wallet, amounts and evidence must come from the operator's verified records. They are not a distribution policy or an instruction to create unfunded balances.

```sh
node scripts/inference-admin.mjs fund ./data '{"receiptId":"settled-provider-receipt-001","amountMicros":1000000}'
node scripts/inference-admin.mjs grant ./data '{"grantId":"epoch-wallet-grant-001","receiptId":"settled-provider-receipt-001","chainId":4663,"wallet":"0x1111111111111111111111111111111111111111","amountMicros":1000000}'
node scripts/inference-admin.mjs balance ./data '{"chainId":4663,"owner":"0x1111111111111111111111111111111111111111"}'
node scripts/inference-admin.mjs history ./data '{"chainId":4663,"owner":"0x1111111111111111111111111111111111111111"}'
node scripts/inference-admin.mjs totals ./data
node scripts/inference-admin.mjs pause ./data
node scripts/inference-admin.mjs reconcile ./data '{"id":"JOB_ID:ATTEMPT_ID","chargedMicros":0,"evidenceId":"verified-no-charge-record-001"}'
node scripts/inference-admin.mjs resume ./data
```

The reconciliation `id` must be the exact reservation ID from history. A zero charge requires verified no-charge evidence; an error alone is insufficient. Repeating the same funding, grant or evidence ID is idempotent, while conflicting reuse fails. Pausing prevents new spending; settlements and operator reconciliation can still complete. A restore guard also blocks new funding/grants and spending until the post-checkpoint records are reconciled.

No automatic $CLOCKERS holder eligibility calculation or fee-funded epoch distribution is enabled. Token-time rules, expiry, treasury allocations and the initial pool still need their economic policy. The token relaunch and flywheel contract changes are outside this application release.

## Hosting and deployment

The existing plan is $10 worth of CLOCKERS for 30 days and 100 tasks, with a separate rolling limit of ten accepted tasks per wallet per hour. A free pass, when explicitly enabled, is one server-recorded 30-day/100-task term per NFT. Existing valid invoices, paid entitlements and consumed-pass records must remain intact. Checkout configuration and the old token/pool quote binding remain unchanged in this candidate.

`Dockerfile` pins Node 24.21.0. `compose.yaml` runs one service writer, mounts a persistent named volume at `/data`, binds the published port to `127.0.0.1:8788` and supplies a restart policy. With private `.env` configuration prepared:

```sh
docker compose up --build -d
docker compose logs --tail=100 jeff
```

For remote access, put the loopback service behind an HTTPS reverse proxy and set `JEFF_PUBLIC_ORIGIN` to the exact public origin. Set `JEFF_CONTINUOUS_HOSTING=true` when running the managed service; this flag labels the host and does not provision infrastructure. Keep a single application writer for the hosting/workspace/scheduler volume. The compose resource settings are initial configuration, not measured production capacity. Docker is unavailable locally; Railway's Linux Docker build and isolated staging startup passed on 9 October. See [staging acceptance](STAGING.md) for live evidence and remaining checks.

### Railway staging configuration

Create an empty JEFF staging environment and attach its own persistent volume at `/data`. Keep production storage separate. The checked-in `railway.json` declares direct `node src/server.mjs` startup, the `/data` mount requirement, one replica, Serverless/App Sleeping disabled and a 180-second shutdown drain. Deployment overlap is zero. On this staging deployment, a deploy-only environment patch was needed to persist the settings; effective metadata verifies them except for the separate `requiredMountPath` guard. The actual `/data` mount and saved-result persistence after process replacement are verified. [Railway deployment configuration](https://docs.railway.com/config-as-code/reference), [Serverless](https://docs.railway.com/deployments/serverless)

Set `JEFF_BIND=0.0.0.0`, `JEFF_DATA_ROOT=/data`, `JEFF_PUBLIC_ORIGIN` to the exact generated HTTPS origin, `JEFF_CONTINUOUS_HOSTING=true` and `JEFF_RELEASE_SHA` to the deployed commit. Preserve the configured chain, collection, RPC and model allowlist; supply the provider credential through private service variables. Configure the intended pilot NFT IDs and expiry explicitly. Keep paid checkout, free passes and prepaid credits disabled for the initial deployment.

Railway supplies `PORT`; the server uses it for listening and health checks. `/health` gates deployment but does not continuously monitor runtime health. A volume-backed deployment has a brief interruption because Railway prevents two deployments from writing the same volume. Verify the actual deployment settings, HTTPS sign-in origin, installed OpenClaw turn and saved-result retrieval after restart before holder acceptance. [Railway health checks](https://docs.railway.com/deployments/healthchecks), [Volume limitations](https://docs.railway.com/volumes/reference)

## Maintenance, backup and restore

On Linux, `SIGUSR2` enters maintenance and `SIGCONT` resumes it. Maintenance blocks new HTTP work and scheduled admissions, then waits for admitted requests, durable jobs, scheduler writes and gateway requests to finish. Graceful shutdown aborts owned children, drains the worker and gateway, and checkpoints the inference SQLite ledger.

The service and production backup reader share the maintenance marker at `<JEFF_DATA_ROOT>/maintenance.json`. `JEFF_MAINTENANCE_MARKER` can override it; use the same configured environment for both processes. Shutdown blocks admissions immediately, including requests still waiting on ownership checks, before cancelling and draining existing work.

The existing encrypted backup workflow captures the whole quiesced data root, including saved jobs/accounts, the hosting ledger, workspace JSON, schedule grants/indexes, and SQLite databases plus WAL files. Backups use AES-256-GCM; keep the encryption key separate. The release restore regression exercises the combined workspace, saved results, credits/unknown holds and schedule state. Preserve `hosting/ledger-initialized.json` and `inference/ledger-initialized.json`: these independent markers make a missing known ledger fail closed instead of resetting quotas, free passes or financial records. Existing valid ledgers acquire their marker without rewriting saved history. Losing both the marker and ledger, or rolling back a whole snapshot, still requires independent recovery records.

Every restored tree receives `hosting/restore-guard.json`. It blocks fresh free passes, credit funding/grants/spending and all new model execution, including manual operator-funded tasks and scheduled work. Existing records remain readable; unknown inference charges stay held. Reconcile all post-checkpoint payments, spent passes, task usage, grants, charges and schedule claims from surviving independent records before removing the guard. If those records cannot be recovered, keep the affected features disabled. Restored OpenClaw absolute paths and service secrets require operator reconfiguration before runtime use.

An optional [encrypted startup export](BACKUP.md) supports hosts with exclusive volume mounting. It captures before application writers start, uses a configured public RSA recipient to wrap a fresh AES-GCM key, and exposes only a cached encrypted envelope through a short-lived independently authenticated HTTPS GET. The private recipient key never reaches the server. Capture size/depth/file bounds, exact deployment identity, expiry and stable reread fail closed. This feature is disabled by default; it does not add request-triggered backups or a recurring retention policy.

The current candidate adds an offline restore command for a saved encrypted export and its matching private recipient file. Download expiry does not expire the saved checkpoint. Recovery verifies authenticated metadata, file hashes, SQLite integrity and saved results in a new isolated directory, with no network request or model call. It preserves the execution guard and does not establish replacement-server runtime recovery. See [offline recovery](BACKUP.md#offline-recovery-of-a-saved-export).

The [monitoring procedure](MONITORING.md) records the configured five-minute workstation task, bounded public reachability sample and its uptime/alert limitations. The [production promotion procedure](PROMOTION.md) preserves the existing volume, payment/hosting records and ownership scopes, and separates code rollback from guarded data recovery.

## Validation and remaining release evidence

Application source `6c07af2a3ab996c04df3c1dbfcc04881e27e09fd` passed **371/371 automated tests** with Node 24.21.0 and a fresh isolated OpenClaw 2026.9.9 installation. The integrated browser fixtures passed **49 general checks and 17 chat-action checks**, including lost replies, concurrent confirmations, inline GET recovery, consent and disabled-state explanations. The staging deployment passed **12 live public checks**, its monitor pin matched, and the original saved operator result survived restart without another model call. Offline recovery of the actual expired checkpoint passed 34 files, seven SQLite databases and five saved jobs. Synthetic legacy migration and code rollback also passed, as recorded in [the promotion procedure](PROMOTION.md#synthetic-migration-and-code-rollback-evidence). These results do not complete the remaining holder or operations gates in [staging acceptance](STAGING.md).

On 9 October 2026 (Asia/Taipei), the complete automated suite passed **285/285 tests** with Node 24.21.0 and serial test-file execution against a fresh isolated OpenClaw 2026.9.9 installation. The browser fixture passed **49 checks** at 1440×1000, 1024×600 and 390×844, covering all eight views, signed sessions, NFT privacy isolation, durable results, cancellation, memory/settings/schedules, settings conflict recovery, late wallet callbacks, keyboard navigation and mobile layout. It recorded no external page requests, JavaScript errors or CSP/console errors. Fixture screenshots, the automated test log and the structured browser report are in the local ignored `evidence/release/` folder; they contain disposable test data.

The subsequent backup/monitoring candidate passed **301/301 automated tests** against the same fresh isolated dependency installation. Its additional checks cover scoped encrypted exports, expiry/capture failure, authentication during maintenance, cloud/local isolated storage recovery, tampered metadata/ciphertext/key rejection and bounded/redacted monitoring. The unchanged public frontend retains its 49-check browser evidence; these server additions do not claim new real-wallet acceptance.

Run the release suite with the compatible Node version:

```sh
npm run test:release
```

Tests include signed HTTP sessions, ownership transfer privacy, durable workspace/schedule recovery, concurrent final-unit accounting, gateway bypass/caps, cancellation/drain, encrypted restore, and installed OpenClaw CLI turns against local model fixtures. The fixture integration proves conversation history and saved memory reach the runtime and the raw provider key does not reach its child.

For browser checks, start a fresh fixture preview in one terminal, then run `node scripts/release-browser-check.cjs` in another. The harness uses the installed `playwright-core` and Chrome; set `JEFF_QA_BROWSER` to override the browser executable path. It refuses signed or mutating checks unless the server explicitly reports `fixture: true`. `JEFF_QA_ORIGIN` can select another local fixture origin. Reports and screenshots are written to `evidence/release/`.

These fixtures alone do not prove live holder acceptance, actual provider funding and financial reconciliation, paid checkout, production capacity, container startup or production deployment. The separate staging acceptance record covers the real Docker build, provider turn and restart persistence. The current hosted pilot remains unchanged. Complete the remaining checks against the chosen environment and approved funding policy before enabling their corresponding release features.

## Dependency findings from the 9 October review

The runtime is pinned to OpenClaw `2026.9.9`, which updates its MCP SDK to `1.31.0`. A fresh isolated installation and the actual installed CLI were tested without modifying the original pilot's shared dependencies. npm's production audit falls from seven affected packages (five high, two moderate) to five (three high, two moderate), with zero critical findings. This is not a clean dependency audit.

The remaining reports concern `brace-expansion`, `http-cache-semantics`, `ip-address`, `postcss-selector-parser` and `undici` inside OpenClaw's bundled npm package. Automatic audit fixing cannot replace bundled dependencies. Isolated checks with upstream npm `11.21.0` and `12.2.0` still reported the five findings; neither override is shipped. JEFF currently disables external tools and package-management actions, but this review does not establish that every advisory is unreachable. Keep these reports open and reassess before enabling additional runtime tools or widening the service. Registry reports are saved under `evidence/release/bug-audit-dependencies-before.json` and `bug-audit-dependencies-after.json`.

A later same-day assessment confirmed that explicit nested component overrides also leave the vulnerable bundled versions unchanged. Two actual installed-CLI NFT/account fixture turns completed while test hooks blocked npm modules and npm/npx launches; seven positive controls confirmed the hooks and neither turn loaded an affected package. This finite Windows fixture evidence supports only the current restricted text workflow. It is not an operating-system sandbox, a clean dependency audit or proof of every production path. Detailed primary-source findings and reachability evidence are in `evidence/release/dependency-assessment-20261009.json` and `dependency-reachability-20261009.json`. A patched upstream bundle or separately reviewed vendor build is still needed to resolve the findings.

The [formal bounded dependency assessment](DEPENDENCY-ASSESSMENT.md) retains the restricted text pilot only. Broad launch and additional runtime tools remain blocked until a reviewed fix or explicit, recorded operator risk acceptance. It also corrects the isolated `http-cache-semantics@4.3.0` fixture claim: an audit-clean component candidate is not an advisory-confirmed patched release, and does not repair JEFF's installed bundle.
