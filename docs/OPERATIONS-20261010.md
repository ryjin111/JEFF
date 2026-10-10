# Release operations, 10 October 2026

The personal-agent release is being hardened on staging. Production remains on `4a0145727279d22e0db0394b0da0ea5ff3ace03e`; no production source upgrade, payment activation or holder-data overwrite has occurred.

Current reviewed application candidate: `c6a3a9417bdc05d6799a1e44bb403bf4e7959b47` on staging deployment `eddce389-d351-4385-bce1-f42a154ca671`. The supplied-page reader is enabled. Independent review matched all 28 recorded container source hashes; Railway operator evidence records real HTTPS/provider execution and durable sourced-result reload. This isolated check used a hosting stub with credits disabled and does not replace holder acceptance. The preceding full suite passed 401/401; all eight reader checks passed after the final linear-parser hardening. See `evidence/research/railway-provider-proof.json` and `container-proof.json`.

Historical operations baseline: `cd44f8d` on staging deployment `7a08eb36-712e-4ea3-8b96-80624546817b`. The operations suite passed 386/386 before the narrow startup/shutdown delta; 47 application/maintenance/recurring checks passed after the final correction, including held-child cancellation and durable terminal persistence.

Independent source/container review passed for `cd44f8d48be8258a8a0f8050429e05ef39bac8c1`, deployed image `sha256:f7323c3958850c82b9a1719b5566d3aaf0b70c8ef645f28772671af0ef3c14ea`. Review checked the server process root, all 27 source hashes, six global manager paths, the local disabled package and seven shutdown/failure tests. The dedicated inspection SSH key was revoked after review. Sanitized proof is archived in the delivery folder as `independent-container-proof.json`.

## Completed evidence

- Actual legacy production capture and isolated restore: 16 files, three SQLite databases and the saved operator result verified. Maintenance drain/capture/resume took 177 ms. Encrypted archive is restricted under `.private/backups`; sanitized proof is `evidence/production-backup-restore.json`.
- Production configuration recovery: all 32 variables captured encrypted, authenticated and round-trip verified, including presence of the provider credential. The recovery CLI wrote a restricted new local output without printing values. Proof: `evidence/personal-agent/config-recovery-proof.json`. The existing AES key needs independent retention before this is a disaster-ready arrangement.
- Old production source and lockfile preserved as `D:\agentmanagerworks\deliveries\jeff-personal-f30fd22\rollback-source-4a014572.zip`.
- Bounded staging capacity: two simultaneous genuine provider turns completed and persisted; a third admission was rejected at the unchanged two-job limit. Public pinned owner/epoch reads ran from Railway egress. This was isolated operator storage with no holder session. Parent-process memory samples exclude model child RSS. It is not a wider-launch throughput or provider-quota benchmark. Proof: `evidence/personal-agent/capacity-proof.json`.
- Fresh installed dependency audit reports zero findings after replacing OpenClaw's unused npm dependency with the explicit, pinned JEFF-owned disabled package. Its imports throw and both npm/npx entrypoints exit 78. The Docker build and hosted startup remove global npm/npx/corepack/yarn/pnpm paths. Startup enforcement is retained because a build-only removal check did not match the observed running container. This is dependency removal for the restricted runtime, not an upstream vulnerability patch or support for package-management tools.
- A separate always-on Railway monitor service is running and probes the application/RPC every minute: https://jeff-monitor-jeff-staging.up.railway.app/health . Service `b691d84d-1b44-4622-b769-b2e65eae2442`, initial deployment `de4edafa-184d-4c22-8d1c-42b5f502f919`. It survives workstation shutdown. It shares the Railway provider, so it is not independent of a provider-wide outage. External alert delivery is unconfigured.

## Prepared, requiring activation inputs

Recurring backup configuration `JEFF_RECURRING_BACKUP` supplies an RSA public PEM, S3/R2 endpoint, bucket, region, prefix and intervalHours from 1 to 24. Credentials use separate `JEFF_BACKUP_ACCESS_KEY_ID` and `JEFF_BACKUP_SECRET_ACCESS_KEY` variables. The private recipient key stays outside the application and must be retained independently first.

The worker drains tracked writers, captures, resumes, verifies an isolated restore, wraps an ephemeral AES key with the recipient's RSA key, uploads the encrypted envelope and reads it back to verify its SHA256. Receipt persistence participates in maintenance draining. Overlapping triggers coalesce. Rejected drains, operator maintenance and shutdown cannot be silently reopened. No runtime configuration means the worker is disabled.

Recover an object into a new isolated directory with `node scripts/restore-recurring-backup.mjs ENVELOPE PRIVATE_PEM ISOLATED_PARENT NEW_RECEIPT`. Recovery authenticates the recipient, source metadata and archive, checks saved results/SQLite, and retains the execution guard. It never overwrites live data or launches a model. Configure bucket retention independently; this worker never deletes stored archives.

The monitor accepts `JEFF_ALERT_WEBHOOK` and optional `JEFF_ALERT_BEARER` through provider secret settings. It alerts after three failed samples, retries delivery failures and sends one recovery after a delivered outage alert. Set `JEFF_MONITOR_TEST_DELIVERY=true` for one synthetic failure/recovery delivery test, then clear it. HTTP acceptance is evidence of delivery to the configured endpoint, not a human acknowledgment.

## Remaining external and release gates

Supply the S3/R2 destination, separate recovery-key destination and alert webhook/contact. Neither mocked object storage nor mocked alert tests count as live activation. Documented dedicated RPC/provider quotas and broader capacity remain necessary before wider launch. Existing pilot limits stay unchanged.

Holder evidence still does not record new chat-action cards, explicit Memory-page reload, a new continuation turn or pause/cancel. Login, saved-conversation reload, memory recall and schedule/run acceptance remain complete. Do not request those completed checks again. Production promotion still needs the configured recovery/alert gates, remaining holder observations and a fresh checkpoint immediately before the change.
