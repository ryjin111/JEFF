# Simple JEFF frontend

The local pilot serves public/index.html and its buildless JavaScript/CSS on the existing backend. Open http://127.0.0.1:8788/ with the server running. No dependency or build step is added.

The first usable loop is wallet sign-in, a text task, its durably saved result, and authenticated retrieval after reopening the page. Both standalone accounts and NFT holder access use this workspace. Model readiness comes from /api/config. New tasks stay disabled when the model or hosting access is unavailable; retrieval remains available after sign-in. There is no simulated success fallback.

## Product entry and standalone signup

The entry switch has Agent NFT JEFF and Simple JEFF. Direct links use ?mode=nft and ?mode=standalone. When standaloneAccounts is enabled and no mode is specified, Simple JEFF is the default entry. A restored session retains its account type. Log out to change access type.

Simple JEFF hides the Room field and ownership epoch. Wallet sign-in uses POST /api/account/auth/challenge with {wallet}, then /api/account/auth/verify with {nonce,signature}. The exact returned message is signed. The resulting scope is {kind:'account',chainId,owner}; no NFT proof or ownership claim is implied. The signup action stays unavailable when the server does not advertise standaloneAccounts.

NFT login retains its original /api/auth routes, Room ID and ownership checks. Account and NFT result indexes and pending invoice references use separate keys. Scope validation rejects account records in the NFT workspace and NFT records in the account workspace. Account history uses the same authenticated job routes, with the backend selecting the correct bridge. Creating an account grants no hosting entitlement. Inactive standalone accounts can retrieve their own prior results but cannot run new jobs.

Wallet login uses personal_sign on the exact server-provided challenge, encoded as UTF-8 hex. The token and its one-hour session metadata are held in tab session storage. Each authenticated API route rechecks ownership. Logout, wallet changes, transfer revocation and expiry clear private output and pending requests. Late responses are discarded when the workspace changes.

Job IDs and pending payment invoice references are remembered in local storage. Each index includes chain, collection, token, holder wallet and transfer epoch. Full objectives and result text are never persisted in browser storage. The server is the source of saved records. Completed records must match the scope, expected job ID and text hash before display. Model output is rendered as text, not HTML. The hash check is an integrity check, not a signed receipt or proof of a real provider run.

Sign in again after a server restart or expired session. Remembered job IDs can still be retrieved from the same holder epoch. Download result saves the server record as JSON and includes the job ID for retrieval from another browser. Manual job-ID retrieval is also available.

POST /api/jobs returns the running job immediately. The UI retains its ID and polls the authenticated result route every two seconds. On reopening or signing in, GET /api/jobs retrieves server history, including running tasks, so recovery does not depend on the browser remembering an ID. No recovery step submits another model job.

Completed-but-unsaved output is displayed with Not saved yet and Retry save. The retry action calls POST /api/jobs/:id/retry-save, preserving the output and avoiding another model run. A retry failure leaves the existing output visible. Pending output is held by the running backend process, so the UI explains that this output can be lost if the process restarts before persistence succeeds. Interrupted jobs are labeled accordingly and are never automatically restarted.

## Hosting and checkout

Clint confirmed on 2026-10-06 that payments go to the treasury. The invoice labels the configured recipient Treasury and shows its full address. The Builder must bind that address to the confirmed Clockers treasury before enabling checkout.

Stage and hosting availability come from /api/config. Hosted mode replaces the LOCAL PILOT label when continuousHosting is true. After login, /api/hosting supplies the NFT's pilot or paid access and its exact expiry. Inactive access disables new tasks while preserving result history, retrieval and save retries. No hosted-mode flag alone grants holder access.

Invoice creation and activation controls are gated by both public billingEnabled and authenticated checkoutEnabled. When either is false, the screen does not offer payment. POST /api/hosting/invoice binds the quote to the exact holder scope. The UI displays its token contract, recipient, chain, expiry and exact amount. It reads token decimals from the wallet's invoice network and formats amounts without floating-point conversion. If token details or the wallet/network binding are unavailable, wallet payment stays disabled.

The Pay action explicitly requests an exact ERC-20 transfer, without an allowance approval. After the wallet returns a transaction hash, the reference is retained in the scoped browser invoice record and POST /api/hosting/activate verifies the chain payment. The UI does not grant hosting based on wallet submission alone. Confirming or failed verification keeps the existing transaction hash and disables sending a second payment. A returned active entitlement enables new tasks. Pending invoices and references survive reopening so the user can retry verification without paying again.

The hosted pilot has model access and continuousHosting enabled. Monthly checkout remains disabled pending price configuration; the treasury recipient has been configured. Standalone signup availability is controlled by standaloneAccounts. External tools remain unavailable. The broader design handoff is at ../jeff-managed-hosting-design-20261006/HANDOFF.md.

Frontend checks live in test/frontend.test.mjs. They cover scope-separated result indexes, session binding/expiry, rejection of altered or cross-workspace records, and correct saved/unsaved labeling. scripts/frontend-browser-check.mjs uses the existing Playwright install and Chromium on D: to verify desktop/mobile rendering and the holder UI loop with explicit API and wallet fixtures. Its evidence distinguishes fixtures from a real model run. Screenshots and browser-check.json are written under evidence/frontend, which is ignored by Git.
