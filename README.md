# Simple JEFF

NFT-controlled JEFF assistants hosted on the actual OpenClaw 2026.9.8 runtime.

Live pilot: https://simple-jeff-production.up.railway.app

The service uses a persistent Railway volume, current NFT ownership and transfer
epoch checks, signed holder sessions, asynchronous jobs and saved result history.
Room 35 has a pilot entitlement through 2026-11-05T15:30:00Z. Paid checkout is
implemented but disabled until the 30-day $CLOCKERS amount is set. Payments go
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
| POST | `/api/auth/verify` | verify `{nonce, signature}`, issue session |
| POST | `/api/auth/logout` | revoke bearer session |
| POST | `/api/jobs` | submit `{objective}`, return running job with HTTP 202 |
| GET | `/api/jobs` | authenticated history including unfinished jobs |
| GET | `/api/jobs/:id` | retrieve scoped job |
| POST | `/api/jobs/:id/retry-save` | save retained output without a model rerun |
| GET | `/api/hosting` | NFT entitlement and checkout availability |
| POST | `/api/hosting/invoice` | fixed 15-minute payment quote when enabled |
| POST | `/api/hosting/activate` | verify quoted ERC20 transfer, extend 30 days |

Sign the exact server-provided challenge. Sessions last one hour and are revoked
on logout or process restart. Every authenticated request rechecks the holder and
transfer epoch. An ID alone grants no private data access. Job execution can take
150 seconds; clients poll rather than resubmitting. Unsaved output can be lost
if the process restarts before Retry save succeeds.

## Storage and limits

Chain 4663 Clockers uses `ownerOf` and `transferNonceOf` at the same block. Other
collections require an epoch adapter that observes every transfer. An A to B to A
transfer creates a new workspace even if the original wallet receives the NFT back.
Private context never follows a new owner. A hosting term stays attached to the NFT.

This pilot runs one server process with a persistent `/data` volume. Holder sessions
and usage counters are in memory. Usage is capped at ten submitted tasks per wallet
per hour and model output at 4096 tokens. Restart resets that counter. Model use is
operator funded in this pilot. External tools, shell actions and messaging are off.
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

Paid activation requires `CLOCKERS_MONTHLY_AMOUNT` in smallest token units and
explicit `JEFF_PAID_CHECKOUT_ENABLED=true`. `CLOCKERS_PAYMENT_RECIPIENT` is the
Clockers treasury, verified against the live Flywheel and Progression contracts
on chain 4663 at block 81741824. Do not enable checkout until the price is confirmed.

`JEFF_VERIFY_RUNTIME=true` performs one operator model check in an isolated volume
workspace and logs its result ID and hash. A saved proof prevents reruns on restart.
It does not exercise holder login or payment, and has no public trigger endpoint.

## Competitors checked before implementation

- [SimpleOpenClaw](https://www.simpleopenclaw.com/): managed persistent hosting and BYOK.
- [Claw Operatives Syndicate](https://www.clawsyndicate.com/whitepaper.pdf): NFT ownership controlling OpenClaw instances.
- [OpenClaw deployment docs](https://docs.openclaw.ai/install/docker): upstream containers.

These are published descriptions, not independent verification of competitors.
