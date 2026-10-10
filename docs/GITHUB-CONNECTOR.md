# GitHub release connection contract

Status: implemented behind explicit configuration, not activated or delivered with a real GitHub App. The shipped public JSON reader remains separate. Jester owns UX, Builder owns provider/backend integration, and Resu owns independent review.

## First usable workflow

The signed holder authorizes a GitHub App, selects one repository from the provider-confirmed grant, and explicitly approves one read of its latest published release. The host supplies a bounded release excerpt to the existing model runner and saves the answer with source, retrieval time and coverage in the current private conversation. No recurring execution, code changes, issue operations or messages are included.

Use a GitHub App with repository Metadata read and Contents read only. Do not substitute an OAuth App with repo/public_repo scope: those scopes do not provide the intended granular read-only boundary. Reject provider configuration or confirmed grants containing write permissions or unrelated requested permissions. GitHub App user access must remain the intersection of the app's grant and that user's access. Installation access alone must not be treated as proof that the current holder can read a repository.

Primary references: [GitHub Apps versus OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps), [GitHub App user access](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app), and [installation access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app).

## Provider and secret prerequisites

An operator-owned GitHub App registration, its client ID/client secret, confirmed permission settings, and an exact HTTPS callback URI are required. Provider credentials must enter through secret settings. A separate 32-byte connector-encryption key must be independently retained; backup encryption does not replace it. Never collect provider passwords, PATs or secrets in chat, Memory, source URLs or browser storage. Do not register a callback or advertise a working Connect button before the backend callback is implemented and verified.

Missing configuration produces `not_configured`. It must make zero GitHub requests and expose no functional Connect action. Configuration alone never produces `connected`.

## API boundary

- `GET /api/connectors/github`: signed, current-epoch status. Return only configuration state and the current scope's verified connection summary.
- `POST /api/connectors/github/authorize`: signed manual authorization initiation with same-origin protection. Mint a random one-use state, bind it to holder scope, session identity and expiry, and return the fixed provider authorization URL. Require PKCE S256 and keep its verifier server-side, bound to that authorization attempt. Never put the holder session token in a URL.
- `GET /api/connectors/github/callback`: validate exact callback, one-use state, expiry and current holder authority. Atomically consume state before exchanging code so concurrent callbacks cannot reuse it. Recheck authority after provider operations and before storing a grant. Bind the verified provider user ID to the connection. No arbitrary redirect target. The callback returns to the fixed Skills & tools route.
- `GET /api/connectors/github/repositories`: signed, current-epoch request. List only provider-confirmed repositories available to both the user and this App, with bounded pagination and a visible coverage limit. Return opaque provider repository IDs, not an unchecked name-based grant.
- `POST /api/jobs`: strict `github:{repositoryId,generation,consent:true}` input. The generation must be the one displayed with the repository selection. Reject stale generations before provider/model calls or task usage. The host verifies the current grant and performs one fixed releases request. Callers cannot supply a hostname, arbitrary API path, method or headers. Reject scheduled use in this slice.
- `DELETE /api/connectors/github`: signed explicit disconnect. Immediately invalidate the local connection generation, cancel its active reads, remove local secrets, and attempt documented provider revocation. Distinguish local disconnection from provider revocation failure. Never claim remote revocation without confirmation.

Signed status is available even when configuration is absent. Authorization and reads fail closed without configuration. No real authorization has been performed on staging.

Enable only with `JEFF_GITHUB_ENABLED=true`, `JEFF_GITHUB_APP_ID`, `JEFF_GITHUB_CLIENT_ID`, `JEFF_GITHUB_CLIENT_SECRET`, and a 64-hex-character `JEFF_GITHUB_ENCRYPTION_KEY`. Register exactly `JEFF_PUBLIC_ORIGIN/api/connectors/github/callback` as the HTTPS callback. The authorization callback uses a Secure HttpOnly SameSite=Lax browser binding and returns to `/#skills`; the UI refreshes signed status rather than assuming success from the redirect. Refresh tokens are not retained or used in this slice. Expired/denied grants require explicit reconnection, with no automatic job retry. Each repository list covers at most five installations and five repositories per installation, with incomplete coverage disclosed.

## Storage and lifecycle

Bind each connection to the full existing scope: account or chain, collection, NFT, holder and ownership epoch. Encrypt credentials with AES-GCM using that complete scope plus connection generation as authenticated metadata; use fresh nonces and atomic restrictive writes. Return only sanitized state from status routes. Do not expose tokens, repository names or source excerpts in public health/config, logs, errors, monitor output or model context. Encrypted backups may contain encrypted connector records; recovery must require the separately retained connector key and preserve the restore execution guard.

Ownership transfer, logout/revocation and disconnect must stop new admissions and invalidate pending authorization or in-flight results at the existing authority checkpoints. A new holder epoch cannot list or use an old holder's connections. A transfer back creates a new epoch and does not revive an old grant. Connection generation must prevent a pending read from saving a result after disconnect/reconnect. Failed refresh or provider denial becomes `reconnect_required`; it does not retry a paid job automatically.

## Fetch and answer restrictions

Authenticated requests go only to the fixed GitHub API origin using native HTTPS with public-address checks, pinned DNS, no redirects, bounded response headers/body and a deadline. Never attach a GitHub credential to user-supplied public-reader URLs. Provider response URLs and release text remain untrusted; generate source URLs from validated provider identity and fixed GitHub routes. Pass only relevant bounded release fields to the model, never tokens or complete provider responses. Existing Stop, hosting, credits, concurrency, maintenance, ownership checks, action suppression and durable-save behavior apply.

Use separate exact allowlists for authorization/token lifecycle and data reads. The code exchange uses `POST https://github.com/login/oauth/access_token`; user-token revocation uses `DELETE https://api.github.com/applications/{client_id}/token`, with the configured client ID. These fixed lifecycle operations do not authorize arbitrary paths or forwarding credentials between origins. Validate connection generation again at the durable result commit, including disconnect/reconnect races.

## Required verification

Verify state replay/session swapping/expiry, callback and token-response failures, overbroad grants, malformed provider identity, repository removal, rate limits, refresh failure, credential-at-rest tampering, scope/epoch isolation, disconnect during read, ownership transfer during callback/read/save, Stop and no automatic replay. Confirm private saved-result reload without a provider/model call. Fixture tests establish implementation behavior; a real configured GitHub App authorization and permitted repository read are required before marking the connector delivered.
