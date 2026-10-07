import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createJeffOpenClawNftBridge, createJeffOpenClawAccountBridge } from 'jeff-agent-nft/openclaw';
import { restoreBackup } from '../src/backup.mjs';
import { createAccountSessions } from '../src/account-auth.mjs';
import { createHostingLedger } from '../src/hosting.mjs';

// Storage-only drill. Never launch OpenClaw from copied absolute workspace paths.
export async function verifyIsolatedRestore({ archive, key, parent }) {
  const restored = await restoreBackup({ archive, key, parent });
  const { root, snapshot } = restored;
  const accounts = createAccountSessions({ origin: 'http://restore.invalid', chainId: 4663, dataRoot: root });
  let modelCalls = 0, jobs = 0, accountCount = 0, databases = 0;
  const runAgent = async () => { modelCalls++; throw new Error('Restore must never run a model'); };
  const noPayment = async () => { throw new Error('Restore must never accept payments'); };
  const ledger = snapshot.files.find(file => file.path === 'hosting/ledger.json');
  if (ledger) assert.deepEqual(JSON.parse(await readFile(resolve(root, ledger.path))), JSON.parse(Buffer.from(ledger.data, 'base64')));
  for (const file of snapshot.files) {
    if (/\.sqlite$/.test(file.path)) {
      const db = new DatabaseSync(resolve(root, file.path));
      try { assert.deepEqual(db.prepare('PRAGMA quick_check').all().map(row => row.quick_check), ['ok']); }
      finally { db.close(); }
      databases++;
    }
    if (/^accounts\/[a-f0-9]{64}\.json$/.test(file.path)) {
      const record = JSON.parse(await readFile(resolve(root, file.path)));
      assert.equal(await accounts.registered(record.scope), true);
      accountCount++;
    }
    if (!/(?:^|\/)results\/[a-f0-9-]{36}\.json$/.test(file.path)) continue;
    const record = JSON.parse(await readFile(resolve(root, file.path)));
    const workspace = createHash('sha256').update(JSON.stringify(record.scope)).digest('hex');
    const dataRoot = resolve(root, file.path.slice(0, -(`${workspace}/results/${record.id}.json`.length)));
    assert.equal(resolve(dataRoot, workspace, 'results', `${record.id}.json`), resolve(root, file.path));
    let owner = { owner: record.scope.owner, ownerEpoch: record.scope.ownerEpoch };
    const bridge = record.scope.kind === 'account'
      ? createJeffOpenClawAccountBridge({ dataRoot, resolveAccount: accounts.registered, runAgent })
      : createJeffOpenClawNftBridge({ dataRoot, resolveOwner: async () => owner, runAgent });
    const saved = await bridge.retrieve(record.scope, record.id);
    assert.equal(saved.id, record.id);
    assert.equal(saved.status, record.status === 'running' ? 'interrupted' : record.status);
    if (record.status === 'completed') assert.equal(saved.textSha256, record.textSha256);
    if (record.scope.kind !== 'account') {
      owner = { owner: `0x${'77'.repeat(20)}`, ownerEpoch: record.scope.ownerEpoch + 1 };
      await assert.rejects(bridge.retrieve(record.scope, record.id), /OWNER_REVOKED/);
      await assert.rejects(bridge.retrieve({ ...record.scope, ...owner }, record.id), /NOT_FOUND/);
    }
    jobs++;
  }
  const proofFile = snapshot.files.find(file => file.path === 'operator-verification/hosted-proof.json');
  let operatorJob = null;
  if (proofFile) {
    const proof = JSON.parse(Buffer.from(proofFile.data, 'base64'));
    const bridge = createJeffOpenClawNftBridge({ dataRoot: resolve(root, 'operator-verification'), resolveOwner: async () => proof.scope, runAgent });
    const job = await bridge.retrieve(proof.scope, proof.jobId);
    assert.equal(job.textSha256, proof.textSha256);
    operatorJob = { jobId: job.id, textSha256: job.textSha256, originalModelRunAt: proof.observedAt };
  }
  // The restored whole ledger is byte-identical, including replay guards.
  const hosting = createHostingLedger({ dataRoot: root, env: {}, verifyPayment: noPayment });
  assert.equal(hosting.enabled, false);
  assert.equal(hosting.freePassEnabled, false);
  const restoreGuard = await readFile(resolve(root, 'hosting', 'restore-guard.json'), 'utf8');
  assert.ok(restoreGuard.length > 0);
  assert.equal(modelCalls, 0);
  return { schema: 'simple-jeff-isolated-restore-v1', observedAt: new Date().toISOString(), restoredRoot: root,
    sourceRoot: snapshot.sourceRoot, capturedAt: snapshot.capturedAt, manifestSha256: snapshot.manifestSha256,
    filesVerified: restored.filesVerified, databasesQuickChecked: databases, jobsRetrieved: jobs, accountsRestored: accountCount,
    hostingLedgerPresent: Boolean(ledger), hostingLedgerBytePreserved: Boolean(ledger), freePassRedemptionBlocked: true, operatorJob,
    ownershipChecks: 'recorded-scope fixtures for storage verification; no live holder session impersonated',
    modelCalls, liveDataOverwritten: false, runtimeLaunched: false };
}

if (process.argv[1] === import.meta.filename) {
  const [archiveFile, keyFile, parent] = process.argv.slice(2);
  if (!archiveFile || !keyFile || !parent) throw new Error('Usage: node scripts/backup-restore.mjs ARCHIVE KEY_FILE EXISTING_ISOLATED_PARENT');
  console.log(JSON.stringify(await verifyIsolatedRestore({ archive: await readFile(archiveFile), key: await readFile(keyFile), parent })));
}
