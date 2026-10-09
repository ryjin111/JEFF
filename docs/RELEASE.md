# JEFF local release candidate

Prepared 7–9 October 2026. JEFF is open-source software for running your own Agent NFTs. Simple JEFF is the managed hosting product. This folder contains the local release candidate; it has not replaced the existing hosted pilot.

The workspace now connects its eight views to the application: Conversation, Activity, Skills & tools, Memory, Usage & credits, Scheduled work, Hosting and Settings. Jobs, conversations, memory, preferences and schedule grants use server storage. The original standalone design preview remains a separate artifact.

## Behavior included

| Area | Release candidate behavior |
| --- | --- |
| Access | Discover owned Rooms, sign a server challenge, select an NFT workspace; a separate signed wallet account route also exists. |
| Conversation | Create conversations, submit asynchronous text jobs, retrieve saved results, continue using bounded previous turns, copy/download answers and retry saving retained output. |
| Identity and privacy | NFT workspaces are scoped by chain, collection, token, owner and ownership epoch. Fresh ownership checks revoke an old holder; a returning holder gets a fresh private workspace. |
| Memory and preferences | Save/delete memory notes; persist name, allowlisted model, selected-agent budget and pause state. Recalled text is passed as untrusted data. |
| Skills & tools | Enable built-in writing, analysis and planning prompt recipes. These influence text generation; external tools, shell execution, messaging and wallet actions remain disabled. |
| Activity and usage | Show saved jobs, workspace events, task allowances and, when configured, inference balances and scoped charge records. |
| Scheduled work | Explicit, expiring grants run text tasks through the same ownership, hosting, pause, concurrency and inference checks as manual work. |
| Stop | Abort the owned runtime child and revoke its gateway credential. The saved job becomes failed; an uncertain provider charge remains held for reconciliation. |
| Hosting | Preserve existing pilot/paid/free-pass terms and task quotas. Paid checkout remains disabled in the example configuration. |

The application process can remain available on a persistent host and execute scheduled jobs without an open browser. Each OpenClaw turn starts on demand. This release does not create a dedicated continuously running OpenClaw gateway for every NFT.

Signed sessions last one hour and are revoked by logout, expiry or server restart. NFT requests also recheck current owner and epoch. Sign-in currently supports externally owned accounts; ERC-1271 contract-wallet signatures are not implemented. A wallet signature grants a session, without token spending authority.

NFT hosting time and its task allowance stay attached to the NFT. Private conversation history and memories stay in the holder's ownership epoch. Inference grants belong to the earning wallet and stay with that wallet when the NFT is sold. Standalone accounts have separate private workspaces and hosting terms; a token allowance alone does not silently create a paid hosting term.

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

For remote access, put the loopback service behind an HTTPS reverse proxy and set `JEFF_PUBLIC_ORIGIN` to the exact public origin. Set `JEFF_CONTINUOUS_HOSTING=true` when running the managed service; this flag labels the host and does not provision infrastructure. Keep a single application writer for the hosting/workspace/scheduler volume. The compose resource settings are initial configuration, not measured production capacity. Docker is unavailable in this workspace, so the container build and compose startup have not been executed here.

## Maintenance, backup and restore

On Linux, `SIGUSR2` enters maintenance and `SIGCONT` resumes it. Maintenance blocks new HTTP work and scheduled admissions, then waits for admitted requests, durable jobs, scheduler writes and gateway requests to finish. Graceful shutdown aborts owned children, drains the worker and gateway, and checkpoints the inference SQLite ledger.

The service and production backup reader share the maintenance marker at `<JEFF_DATA_ROOT>/maintenance.json`. `JEFF_MAINTENANCE_MARKER` can override it; use the same configured environment for both processes. Shutdown blocks admissions immediately, including requests still waiting on ownership checks, before cancelling and draining existing work.

The existing encrypted backup workflow captures the whole quiesced data root, including saved jobs/accounts, the hosting ledger, workspace JSON, schedule grants/indexes, and SQLite databases plus WAL files. Backups use AES-256-GCM; keep the encryption key separate. The release restore regression exercises the combined workspace, saved results, credits/unknown holds and schedule state.

Every restored tree receives `hosting/restore-guard.json`. It blocks fresh free passes, credit funding/grants/spending and scheduled work. Existing records remain readable; unknown inference charges stay held. Reconcile all post-checkpoint payments, spent passes, grants, charges and schedule claims from surviving independent records before removing the guard. If those records cannot be recovered, keep the affected features disabled. Restored OpenClaw absolute paths and service secrets require operator reconfiguration before runtime use.

## Validation and remaining release evidence

On 9 October 2026 (Asia/Taipei), the complete automated suite passed **261/261 tests** with Node 24.21.0 and serial test-file execution. The browser fixture passed **25 checks** at 1440×1000, 1024×600 and 390×844, covering all eight views, signed sessions, NFT privacy isolation, durable results, cancellation, memory/settings/schedules, keyboard navigation and mobile layout. It recorded no external page requests, JavaScript errors or CSP/console errors. Fixture screenshots, the automated test log and the structured browser report are in the local ignored `evidence/release/` folder; they contain disposable test data.

Run the release suite with the compatible Node version:

```sh
npm run test:release
```

Tests include signed HTTP sessions, ownership transfer privacy, durable workspace/schedule recovery, concurrent final-unit accounting, gateway bypass/caps, cancellation/drain, encrypted restore, and installed OpenClaw CLI turns against local model fixtures. The fixture integration proves conversation history and saved memory reach the runtime and the raw provider key does not reach its child.

For browser checks, start a fresh fixture preview in one terminal, then run `node scripts/release-browser-check.cjs` in another. The harness uses the installed `playwright-core` and Chrome; set `JEFF_QA_BROWSER` to override the browser executable path. It refuses signed or mutating checks unless the server explicitly reports `fixture: true`. `JEFF_QA_ORIGIN` can select another local fixture origin. Reports and screenshots are written to `evidence/release/`.

These fixtures do not prove live holder acceptance, actual provider funding and financial reconciliation, paid checkout, production capacity, container startup or production deployment. The current hosted pilot remains unchanged. Complete those checks against the chosen environment and approved funding policy before enabling their corresponding release features.
