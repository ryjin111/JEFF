# Simple JEFF frontend

The local pilot serves public/index.html and its buildless JavaScript/CSS on the existing backend. Open http://127.0.0.1:8788/ with the server running. No dependency or build step is added.

The first usable loop is NFT holder sign-in, a text task, its durably saved result, and authenticated retrieval after reopening the page. Model readiness comes from /api/config. New tasks stay disabled when the model is unavailable; retrieval remains available after sign-in. There is no simulated success fallback.

Wallet login uses personal_sign on the exact server-provided challenge, encoded as UTF-8 hex. The token and its one-hour session metadata are held in tab session storage. Each authenticated API route rechecks ownership. Logout, wallet changes, transfer revocation and expiry clear private output and pending requests. Late responses are discarded when the workspace changes.

Only job IDs are remembered in local storage. The index includes chain, collection, token, holder wallet and transfer epoch. Full objectives and result text are never persisted in browser storage. The server is the source of saved records. Completed records must match the scope, expected job ID and text hash before display. Model output is rendered as text, not HTML. The hash check is an integrity check, not a signed receipt or proof of a real provider run.

Sign in again after a server restart or expired session. Remembered job IDs can still be retrieved from the same holder epoch. Download result saves the server record as JSON and includes the job ID for retrieval from another browser. Manual job-ID retrieval is also available.

POST /api/jobs returns the running job immediately. The UI retains its ID and polls the authenticated result route every two seconds. On reopening or signing in, GET /api/jobs retrieves server history, including running tasks, so recovery does not depend on the browser remembering an ID. No recovery step submits another model job.

Completed-but-unsaved output is displayed with Not saved yet and Retry save. The retry action calls POST /api/jobs/:id/retry-save, preserving the output and avoiding another model run. A retry failure leaves the existing output visible. Pending output is held by the running backend process, so the UI explains that this output can be lost if the process restarts before persistence succeeds. Interrupted jobs are labeled accordingly and are never automatically restarted.

24/7 hosting, paid activation, external tools and standalone signup remain unavailable in the current local pilot. The screen does not accept payments or advertise a live subscription. The broader design handoff is at ../jeff-managed-hosting-design-20261006/HANDOFF.md.

Frontend checks live in test/frontend.test.mjs. They cover scope-separated result indexes, session binding/expiry, rejection of altered or cross-workspace records, and correct saved/unsaved labeling. scripts/frontend-browser-check.mjs uses the existing Playwright install and Chromium on D: to verify desktop/mobile rendering and the holder UI loop with explicit API and wallet fixtures. Its evidence distinguishes fixtures from a real model run. Screenshots and browser-check.json are written under evidence/frontend, which is ignored by Git.
