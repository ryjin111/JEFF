# Simple JEFF

## Local release candidate, 7–9 October 2026

This folder contains the connected JEFF workspace release candidate: eight application views, durable conversations and memory, NFT owner-epoch privacy, bounded scheduled work, hosting controls, and optional funded inference accounting. It has not been deployed over the existing hosted pilot.

The current candidate adds personal-agent requests in chat. An explicit literal request such as `Remember: my verification word is blue lantern` saves that note automatically; model-extracted notes require review. Scheduling requests produce an inline plan showing the timezone, timing, 1–24 runs and an expiry within seven days, with explicit consent before authorization. JEFF is the app; the selected NFT's configured name identifies the agent. See [personal-agent behavior](docs/RELEASE.md#personal-agent-requests-in-chat) for recovery and authorization rules. These additions are deployed to staging; holder acceptance of the new chat actions remains pending.

Use Node 24.21.0 and `npm run preview:release` for the isolated local fixture, or follow [the release guide](docs/RELEASE.md) for configured operation, credit administration, deployment and restore behavior. Run `npm run test:release` for the release checks.

The isolated [JEFF staging service](https://jeff-staging-jeff-staging.up.railway.app) runs application source `6c07af2` with real OpenClaw. All 371 automated tests, 49 general browser checks, 17 chat-action browser checks and 12 live public checks passed. The original saved operator result survived deployment without another model call. [Staging acceptance](docs/STAGING.md) records the exact source and remaining holder and operations checks. [Offline recovery of saved encrypted exports](docs/BACKUP.md#offline-recovery-of-a-saved-export) also passed against the actual expired checkpoint, preserving the execution guard.

The sections below preserve the earlier hosted pilot record. Their capability and deployment statements describe that pilot; the release guide describes this candidate.

## Existing hosted pilot record

JEFF assistants hosted on the actual OpenClaw 2026.9.8 runtime, with NFT holder
access and standalone wallet accounts.

Live pilot: https://simple-jeff-production.up.railway.app

The service uses a persistent Railway volume, current NFT ownership and transfer
epoch checks, signed holder sessions, asynchronous jobs and saved result history.
Room 35 has a pilot entitlement through 2026-11-05T15:30:00Z. The plan is $10 worth
of CLOCKERS for 30 days with 100 JEFF tasks. Paid checkout remains disabled while
real holder login and payment acceptance are pending. Payments go
to the Clockers treasury, `0x2a9Bc20B7e7638808019A9A1B5Ee5EB6132DBff2`.
A real provider job has completed and survived reopening the storage bridge.
Holder login acceptance and actual paid activation remain separate checks.

## Run locally

Use Node 24.16 or newer in the Node 24 series. Run `npm ci`, copy `.env.example`
to a private `.env`, configure the provider key and pilot expiry, then `npm start`.
The pinned JEFF adapter is included in `vendor/`, so no sibling checkout is needed.
The default server address is http://127.0.0.1:8788/.

`npm test` checks session signatures, ownership epochs, result integrity, CLI
integration using an explicit model fixture, billing recovery and transfer receipt
bindings. `npm run smoke` runs the real configured model as an operator and saves
local evidence. It does not impersonate a signed holder session.

## API

JSON API responses use `Cache-Control: no-store`.

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/api/config` | runtime and availability flags |
| POST | `/api/auth/challenge` | challenge for `{wallet, tokenId}` |
| POST | `/api/auth/nfts` | discover current wallet-owned Rooms with `{wallet}` |
| POST | `/api/auth/verify` | verify `{nonce, signature}`, issue session |
| POST | `/api/auth/logout` | revoke bearer session |
| POST | `/api/account/auth/challenge` | standalone wallet challenge, no NFT required |
| POST | `/api/account/auth/verify` | create or open wallet account after signature |
| POST | `/api/jobs` | submit `{objective}`, return running job with HTTP 202 |
| GET | `/api/jobs` | authenticated history including unfinished jobs |
| GET | `/api/jobs/:id` | retrieve scoped job |
| POST | `/api/jobs/:id/retry-save` | save retained output without a model rerun |
| GET | `/api/hosting` | NFT entitlement and checkout availability |
| POST | `/api/hosting/free-pass` | consume the NFT's single free month with `{}` |
| POST | `/api/hosting/invoice` | fixed 15-minute payment quote when enabled |
| POST | `/api/hosting/activate` | verify quoted ERC20 transfer, extend 30 days |

Sign the exact server-provided challenge. Sessions last one hour and are revoked
on logout or process restart. Every authenticated request rechecks the holder and
transfer epoch. An ID alone grants no private data access. Job execution can take
150 seconds; clients poll rather than resubmitting. Unsaved output can be lost
if the process restarts before Retry save succeeds.

NFT sign-in discovers the connected wallet's Rooms automatically. A single Room
continues directly to the holder signature; multiple Rooms use a selector. The
public discovery endpoint returns `{chainId, collection, wallet, tokenIds,
balance, blockNumber, complete: true}`. It reads `balanceOf` and every `ownerOf`
from ID 1 through the lifetime `saleMinted` count at one block. Burned IDs are
skipped only for the contract's exact nonexistent-owner error; incomplete reads
fail instead of reporting an empty wallet. Scans are limited to 4,444 minted IDs,
350 calls per batch, four simultaneous wallets and ten seconds per request.
Multicall3 code must exist at the configured canonical address. Repeated in-flight
requests for one wallet share work; completed results are not cached. Discovery
does not authorize access. Signed login still checks fresh ownership and epoch.

## Storage and limits

Chain 4663 Clockers uses `ownerOf` and `transferNonceOf` at the same block. Other
collections require an epoch adapter that observes every transfer. An A to B to A
transfer creates a new workspace even if the original wallet receives the NFT back.
Private context never follows a new owner. A hosting term stays attached to the NFT.

With `JEFF_FREE_PASS_ENABLED=true`, each NFT has one free 30-day pass with 100 tasks.
The signed current holder activates it explicitly. The server rechecks the holder
and epoch inside the serialized redemption, then commits the spent record and
hosting period together. Retries return the existing grant. Transfer, restart,
expiry and exhausted tasks never restore the pass. An active pilot or hosting term
keeps its allowance; the free period starts after all existing time. A free period
uses `source: free-pass`; paid renewal remains separate. Standalone accounts have
no NFT pass. This benefit is recorded by the hosting service. It does not mint or
burn an on-chain item and cannot prove consumption independently of service storage.

Authenticated hosting responses include `freePass: {state, periodDays,
tasksIncluded, startsAt, expiresAt, consumedAt}`, or `null` for standalone accounts.
State is `available`, `consumed`, or `unavailable`. Available dates are a current
server proposal; consumed dates are fixed. Keep `hosting/ledger.json` intact,
including expired free-pass periods and `freePasses` records. Missing or malformed
links between a spent record and its grant fail closed.

Standalone accounts use a separate `kind: account` scope bound to the wallet and
payment chain. A signature creates the durable account; its private jobs and paid
term stay attached to that account. NFT pilot time does not grant account hosting,
even for the same wallet. Both entry points use the shared jobs and hosting API.
New accounts start inactive while checkout is unavailable. Account login requires
no on-chain transaction. Contract-wallet signature validation is not implemented.

This pilot runs one server process with a persistent `/data` volume. Holder sessions
are in memory. The hosting ledger durably counts 100 tasks per paid 30-day period
and ten tasks per wallet in a rolling hour. A task is reserved before starting the
bridge. Rejected starts are refunded; accepted failures, timeouts and interrupted
runs stay counted. An uncertain admission after a crash also stays counted. Saved
result retrieval and Retry save use no tasks. Both counters survive restart.
Early renewal queues another period and does not refill today's allowance. Unused
tasks expire at their period boundary. NFT allowance follows the NFT across owners;
private job history still follows its ownership epoch. Pilot access has a separate
100-task allowance through its configured expiry. This is a task allowance, not a
USD credit balance or a dollar cap on provider billing. The model runtime has a
16,384-token context budget and 4,096-token output limit; providers may retry calls.
Model use is operator funded. External tools, shell actions and messaging are off.
The hosted service is continuously available; OpenClaw turns run on demand. Autonomous
schedules and persistent per-NFT gateways are not implemented.

Payment verification requires 64 confirmations, the configured chain and token,
exact sender, recipient and amount, a canonical block and a block timestamp within
the original quote window. Expired quotes remain redeemable after confirmation or
reconnection delays. One transaction can fund one invoice, and successful retries
are idempotent. No automatic renewal or token approval is requested.

## Deployment

`Dockerfile` pins Node 24.21.0. Railway runs the service with a `/data` volume and
health check at `/health`. Keep provider secrets in service variables. Project
archives exclude `.env`, credentials, local data, evidence and development tools.
Set `JEFF_PUBLIC_ORIGIN` to the deployed HTTPS origin and bind `0.0.0.0`.

The plan is $10 USD worth of CLOCKERS for 30 days. The server converts the USD
reference into exact smallest token units, rounds up, and stores a 15-minute
quote. It uses the pinned Robinhood CLOCKERS/WETH Uniswap v4 pool from
[DEX Screener](https://docs.dexscreener.com/api/reference), verifies chain and
token decimals over RPC, rejects incorrect pool identities, low liquidity,
failed requests and HTTP responses older than 60 seconds. The source does not
publish a per-price update timestamp. `retrievedAt` describes retrieval time;
`priceUpdatedAt` remains null. HTTP freshness does not establish market freshness.
Activation verifies the stored token amount without fetching or changing its price.

Paid activation requires explicit `JEFF_PAID_CHECKOUT_ENABLED=true`.
`CLOCKERS_PAYMENT_RECIPIENT` is the
Clockers treasury, verified against the live Flywheel and Progression contracts
on chain 4663 at block 81741824. Checkout remains disabled until holder/payment
acceptance is complete. Price-source review approved the checkout-disabled slice;
market update time remains unknown. Monthly and rolling-hour counters use the
same serialized ledger writer as payments. Run only one server writer per volume.

`JEFF_VERIFY_RUNTIME=true` performs one operator model check in an isolated volume
workspace and logs its result ID and hash. A saved proof prevents reruns on restart.
It does not exercise holder login or payment, and has no public trigger endpoint.

## Backup and isolated restore

`scripts/backup-production.mjs SSH_TARGET SSH_KEY KNOWN_HOSTS` captures the running
Linux service over SSH. It first enters internal maintenance with `SIGUSR2`, blocks
new requests and waits for existing requests and jobs to finish saving. A readiness
marker in `/tmp` confirms draining. The capture compares two complete manifests
while writers are paused. `SIGCONT` resumes the service in `finally`; a separate
30-second watchdog also releases maintenance if the capture process stops.

The AES-256-GCM encrypted archive is saved off-host in `.private/backups/`. Its
32-byte key stays separately at `.private/backup-key.bin`. Preserve that key in
secure operator storage to recover an archive. Do not publish archives, keys or
restored workspaces. All canonical SQLite databases and WAL files, saved jobs,
accounts and the whole hosting ledger are included. Regenerable compile caches,
temporary files, SQLite generation/reindex locks and generated `plugin-skills`
links are excluded and recorded. Other symlinks fail capture.

`scripts/backup-restore.mjs ARCHIVE KEY_FILE EXISTING_ISOLATED_PARENT` always creates
a new restore directory and refuses the source tree. It verifies every file hash,
SQLite integrity, account registration and saved result retrieval with model
execution disabled. Restored OpenClaw config contains original absolute workspace
paths, so this storage drill never starts the runtime. Runtime recovery requires
rewriting those paths and restoring service variables separately.

Every restore also creates `hosting/restore-guard.json`. Its presence blocks new
free-pass claims even if the service flag is enabled, while preserving recorded
consumption and existing hosting. An old snapshot cannot know which passes were
spent after capture. Before promoting a restored tree, reconcile its ledger with
the latest surviving spent records and grants under maintenance, preserving usage
and payment replay guards. Remove the restore guard only after that reconciliation.
If post-checkpoint spent records cannot be recovered, keep new free passes disabled.
Deleting the ledger or bypassing the guard can reopen claims; this server-issued
benefit depends on operator preservation of its durable records.

This is an operator-triggered backup, with no recurring schedule configured.
After paid launch, reconcile on-chain payments and consumed transaction records
after any checkpoint before reopening checkout following a disaster restore.

## Competitors checked before implementation

- [SimpleOpenClaw](https://www.simpleopenclaw.com/): managed persistent hosting and BYOK.
- [Claw Operatives Syndicate](https://www.clawsyndicate.com/whitepaper.pdf): NFT ownership controlling OpenClaw instances.
- [OpenClaw deployment docs](https://docs.openclaw.ai/install/docker): upstream containers.

These are published descriptions, not independent verification of competitors.
