# Encrypted startup exports

Current operations, 10 October 2026: daily encrypted bucket backups are active on staging, with upload/readback and independent isolated restore evidence. This document retains the startup-export and 9 October replacement-drill procedures; [current operations](OPERATIONS-20261010.md) covers recurring backup configuration and recovery. Independent key retention, production backup activation and fresh pre-promotion checkpoint/reconciliation remain separate gates.

The optional startup export captures the existing `/data` tree **before** JEFF creates its application, scheduler, SQLite connections or OpenClaw verifier. It supports a host with one exclusive volume writer and zero deployment overlap. Railway documents that deployments cannot simultaneously mount the same service volume. The hook runs in the start command, after the volume mounts; it is not a build or pre-deploy command. [Railway volume reference](https://docs.railway.com/volumes/reference)

This route uses verified HTTPS rather than unverified SSH. No request can start a backup, change a storage path, run a command or supply an encryption key. By default the route does not exist. An operator configures a public recipient key, an independent high-entropy bearer hash, a random path nonce, an absolute expiry and the exact project/environment/service/origin/release/mount identity. The private RSA key stays off the server.

The server captures and rereads stable storage, encrypts the archive using a fresh AES-256-GCM key and wraps that key using RSA-OAEP-SHA256. Export identity is included inside the authenticated plaintext. Only the encrypted envelope is cached in memory. A scoped GET with the correct bearer can retrieve it; queries, other methods and foreign origins are rejected. Responses are `no-store`; the cache is cleared after at most ten minutes. A well-formed expired configuration disables exports on subsequent ordinary restarts. Malformed active configuration, wrong identity or a failed capture fails startup rather than producing an empty backup.

Capture is bounded to 64 MiB of source file bytes, 32 MiB per file, 10,000 filesystem entries and 32 directory levels. Generated compile caches, temporary files and plugin-skill links are explicitly excluded by the existing backup format. Durable databases, SQLite WALs, saved results, workspaces, ledgers, schedules and initialization markers remain included. A larger data tree needs a reviewed streaming backup implementation; do not increase memory limits or exclude durable records merely to make a capture pass.

## Operator procedure

First verify the intended service and volume, effective single-writer/zero-overlap settings and an idle task window. Existing holder sessions will require a fresh signature after deployment. Never switch the production service to a staging volume or restore a checkpoint over newer live work.

1. Write a private local JSON identity with exactly `RAILWAY_PROJECT_ID`, `RAILWAY_ENVIRONMENT_ID`, `RAILWAY_SERVICE_ID`, `JEFF_PUBLIC_ORIGIN`, `JEFF_RELEASE_SHA` and `RAILWAY_VOLUME_MOUNT_PATH`. Use the exact tested application source and `/data` mount.
2. Run `node scripts/backup-export-client.mjs prepare IDENTITY_JSON`. It creates separate restricted key and archive directories under `.private`, and prints only their paths and expiry.
3. Set `JEFF_STARTUP_BACKUP_EXPORT` to the generated **public** configuration JSON and set `JEFF_RELEASE_SHA` to the matching source, targeting only the intended environment. Do not upload the local private-key file or bearer. Set variables without triggering an extra deployment, then deploy the exact source within the ten-minute window.
4. Confirm deployment health and the sanitized `JEFF_STARTUP_BACKUP_READY` receipt, including its isolated cloud storage-restore result. The server verifies a newly created temporary restore tree before normal application startup, then deletes only that temporary tree. Run `node scripts/backup-export-client.mjs download KEY_FILE ARCHIVE_DIRECTORY RECEIPT_FILE`. The client disables redirects, bounds the response, verifies the wrapped key and authenticated export identity, stores the encrypted envelope off-host and performs another storage-only restore into a new restricted local directory.
5. Match the downloaded envelope hash to the server receipt and record the exact source/volume/deployment. Verify saved-job hashes and SQLite integrity without printing holder contents or running a model. Clear the one-shot export variable using a skip-deployment update; verify the cached route expires and ordinary service health remains ready.
6. Retain the private recipient key independently from the encrypted envelope. The generated directories are separate, but are initially on the same workstation. Copying both to a single backup destination does not protect against that destination's loss or compromise. Do not print either the bearer or private key in commands, logs, reports or source control.

The local client writes aggregate verification receipts. Its isolated restore preserves the execution guard; it never launches OpenClaw or overwrites the live volume. Service credentials/configuration require their own secure recovery procedure.

## Offline recovery of a saved export

The current candidate adds recovery from an already downloaded `.jeffenvelope` and the matching private recipient JSON file created by `prepare`:

```sh
node scripts/backup-export-client.mjs restore SAVED_ENVELOPE KEY_FILE EXISTING_ISOLATED_PARENT NEW_RECEIPT_FILE
```

The destination parent must already exist outside the original `/data` source tree. The command creates a new restricted recovery directory, refuses to overwrite an existing receipt, authenticates the envelope and captured identity, and checks file hashes, SQLite integrity and saved-result retrieval. It makes no network requests, starts no model and leaves live data untouched. Keep the recipient file private; it contains the decryption key material.

The export's expiry closes its live download route. It does not expire a saved authenticated archive, so this offline command accepts a matching recipient file after that download window ends. The receipt records whether the export had expired at recovery.

The restored tree retains `hosting/restore-guard.json`. All new model execution, schedule admissions, credit funding/grants/spending and fresh free-pass claims stay blocked until post-checkpoint records are reconciled. Offline storage verification does not remove that guard or prove runtime recovery on a replacement server. Release `6c07af2` passed all six client checks, including deep Windows SQLite paths. The actual expired checkpoint also passed offline recovery: 34 files, seven SQLite databases and five saved jobs, with its manifest and original operator result preserved. Evidence is `evidence/release/saved-checkpoint-offline-restore.json`; no network request, model call or live-data overwrite occurred.

## Replacement cloud recovery, 9 October 2026

The same historical checkpoint recovered into a new Railway project, service and `/recovery` volume, separately from staging and production. Application source was `6c07af2a3ab996c04df3c1dbfcc04881e27e09fd`, with a separately hashed recovery boot helper. Only encrypted archive bytes and application source were uploaded. The original RSA private key stayed local; the one-shot AES variable was cleared before the restart check.

Initial recovery verified 34 files, seven SQLite databases and five saved jobs. The guarded application became ready and denied unsigned private access. An independent process restart retrieved the original operator job with the same text hash and rechecked all seven databases. The restore guard remained active, with models unconfigured and schedules, payments, free passes, credits and external tools disabled. No holder login or model call occurred. Evidence is `evidence/release/cloud-recovery-first.json` and `cloud-recovery-restart.json`.

The temporary deployment was stopped and its separate recovery volume retained. Railway reported `deploymentStopped: true`; the current service configuration no longer contains the AES variable. The final receipt is `evidence/release/cloud-recovery-drill.json`.

This verifies guarded replacement runtime recovery for the 9 October drill. Provider credentials and live inference were not recovered or exercised in that drill; the later encrypted production-configuration round trip is separate evidence. The historical checkpoint predates subsequent holder work, so financial/schedule reconciliation and independent key retention remain gates. Recurring off-machine staging capture was subsequently activated and verified; production activation and an independently configured retention policy remain separate. The guard must stay until surviving records have been reconciled. See [current operations](OPERATIONS-20261010.md) and [production recovery](PROMOTION.md).
