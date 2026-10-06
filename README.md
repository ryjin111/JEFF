# Simple JEFF

Managed hosting for JEFF agents. This first local slice connects the JEFF soul to
the actual OpenClaw 2026.9.8 runtime, authenticates an NFT holder, generates a text
result and saves it for retrieval after reconnecting.

Status: implementation in review. A real model job still requires a usable model
API key. Paid activation and 24/7 hosted operation are not enabled.

## Run locally

Use Node 24.16 or newer in the Node 24 series. A portable Node 24.21.0 installation
is available in `tools/node-v24.21.0-win-x64` in the Builder workspace.

Keep the JEFF adapter checkout at `../jeff-openclaw-nft`, then run `npm ci`.
Copy `.env.example` to a private `.env`, configure the model key, and run `npm start`.
The server binds to `127.0.0.1:8788` by default. Jester owns the frontend in `public/`.
Do not expose this pilot directly to the Internet.

`npm test` verifies ownership, transfer epochs, signatures, logout, expiry, saved
result integrity and the installed OpenClaw CLI against an explicitly simulated
model. `npm run smoke` uses the configured real provider and writes local evidence
only after a real Room 35 job and a matching retrieval from a new bridge instance.
The smoke is an operator test, not a signed holder acceptance test.

## API

All API responses use JSON and `Cache-Control: no-store`.

| Method | Path | Request | Response |
| --- | --- | --- | --- |
| GET | `/api/config` | none | chain, collection, model and availability flags |
| POST | `/api/auth/challenge` | `{wallet, tokenId}` | `{nonce, message, expiresAt}` |
| POST | `/api/auth/verify` | `{nonce, signature}` | `{token, scope, expiresAt}` |
| POST | `/api/auth/logout` | Bearer token | `{loggedOut:true}` |
| POST | `/api/jobs` | Bearer token, `{objective}` | completed durable job record |
| GET | `/api/jobs/:id` | Bearer token | durable job record |

Sign the exact server-provided message. Never use the NFT address as a session.
The first job request may take up to 150 seconds. Retain its job ID for retrieval.
A saved ID grants no access by itself. Logout or process restart requires a fresh
login. The API rechecks ownership and transfer epoch before returning private data.

## Scope and storage

The first chain adapter supports Clockers on chain 4663 and requires the
collection's `transferNonceOf` method. Other Agent NFT collections need an epoch
adapter that observes every transfer. Comparing owner addresses alone is insufficient
when a token transfers from A to B and then back to A.

Each NFT, owner and epoch has a separate workspace. Old private data is retained
in its former workspace, never loaded into a new owner's context. Model credentials
come from the server environment; workspace configuration contains an environment
reference, not a model key. External tools, shell commands and messaging are disabled.

This is a single-process pilot. Results persist on disk. Holder sessions stay in
memory and are revoked on restart. This version runs embedded OpenClaw turns on
demand; it does not keep an always-on gateway or autonomous schedules running.

## Next deployment inputs

The paid service needs a Linux host, private credential configuration, the
30-day $CLOCKERS price and payment recipient, and the chosen model funding policy.
Those inputs will bind payment verification, persistent worker supervision,
renewal/expiry and the hosted gateway. No payment should be accepted by this pilot.

## Competitors checked before implementation

- [SimpleOpenClaw](https://www.simpleopenclaw.com/) advertises managed persistent
  hosting and bring-your-own model credentials.
- [Claw Operatives Syndicate](https://www.clawsyndicate.com/whitepaper.pdf) describes
  NFT ownership controlling a dedicated OpenClaw instance.
- [OpenClaw deployment docs](https://docs.openclaw.ai/install/docker) document the
  upstream container deployment. This slice uses the upstream npm runtime locally.

These are published descriptions, not independent verification of competitors.
