import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, relative, sep } from 'node:path';
import { createJeffOpenClawNftBridge } from 'jeff-agent-nft/openclaw';
import { captureBackup, encryptBackup, decryptBackup, restoreBackup } from '../src/backup.mjs';
import { createJeffApplication } from '../src/application.mjs';
import { createWorkspaceStore } from '../src/workspace.mjs';
import { createScheduler } from '../src/scheduler.mjs';
import { createInferenceLedger } from '../src/inference-ledger.mjs';
import { scopeDirectory } from '../src/scope.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const scope = { chainId: 4663, collection: '0x' + '11'.repeat(20), tokenId: '35', owner: '0x' + '22'.repeat(20), ownerEpoch: 4 };
async function inventory(root) {
  const records = [];
  async function visit(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else records.push({ path: relative(root, path).split(sep).join('/'), hash: sha(await readFile(path)) });
    }
  }
  await visit(root); return records;
}

test('encrypted release backup restores workspace, grants and SQLite holds without enabling fresh spending or scheduled work', async t => {
  const privateRoot = await mkdtemp(resolve(tmpdir(), 'jeff-release-restore-'));
  const dataRoot = resolve(privateRoot, 'source'), parent = resolve(privateRoot, 'restores');
  await mkdir(dataRoot, { mode: 0o700 }); await mkdir(parent, { mode: 0o700 });
  let originalLedger, restoredApp;
  t.after(async () => {
    if (restoredApp) await restoredApp.close();
    originalLedger?.close();
    await rm(privateRoot, { recursive: true, force: true });
  });
  const resolveOwner = async () => ({ owner: scope.owner, ownerEpoch: scope.ownerEpoch });
  const workspace = createWorkspaceStore({ dataRoot, resolveOwner, allowedModels: ['bankr/fixture'] });
  const conversation = await workspace.createConversation(scope, { title: 'Restore regression' });
  await workspace.saveMemory(scope, { title: 'Private preference', text: 'Keep responses concise and preserve this memory.' });
  let modelCalls = 0;
  const bridge = createJeffOpenClawNftBridge({ dataRoot, resolveOwner,
    runAgent: async () => { modelCalls++; return { text: 'Persisted fixture job output.', model: 'bankr/fixture' }; } });
  const job = await bridge.run(scope, 'Save a fixture result');
  await workspace.bindJob(scope, { jobId: job.id, conversationId: conversation.id, objective: job.objective, source: 'manual' });
  const clock = Date.now() - 120000;
  const scheduler = createScheduler({ dataRoot, resolveOwner, now: () => clock,
    execute: async () => { throw new Error('Source schedules must not execute during the restore drill'); } });
  const grantInput = { objective: 'Write a scheduled fixture update', conversationId: conversation.id,
    intervalMinutes: 1, maxRuns: 2, expiresAt: new Date(clock + 86400000).toISOString() };
  const grant = await scheduler.create(scope, grantInput);
  const crashedGrant = await scheduler.create(scope, { ...grantInput, objective: 'Unknown admitted occurrence' });
  crashedGrant.runs.push({ index: 1, occurrenceId: `${crashedGrant.id}:1`, status: 'claimed', claimedAt: crashedGrant.createdAt,
    finishedAt: null, jobId: null, error: null });
  await writeFile(resolve(scopeDirectory(dataRoot, scope), 'schedules', `${crashedGrant.id}.json`), JSON.stringify(crashedGrant));
  originalLedger = createInferenceLedger({ dataRoot });
  originalLedger.fund({ receiptId: 'settled-funding-fixture', amountMicros: 1000000 });
  originalLedger.grant({ grantId: 'earned-grant-fixture', receiptId: 'settled-funding-fixture', chainId: scope.chainId,
    wallet: scope.owner, amountMicros: 900000 });
  originalLedger.reserve({ id: 'unknown-provider-call', scope, amountMicros: 200000, dailyLimitMicros: 1000000 });
  originalLedger.markForwarded('unknown-provider-call');
  originalLedger.settle({ id: 'unknown-provider-call', outcome: 'unknown' });
  originalLedger.reserve({ id: 'settled-provider-call', scope, amountMicros: 100000, dailyLimitMicros: 1000000 });
  originalLedger.markForwarded('settled-provider-call');
  originalLedger.settle({ id: 'settled-provider-call', chargedMicros: 50000 });
  const sourceBalance = originalLedger.balance(scope), sourceTransactions = originalLedger.list(scope);
  originalLedger.checkpoint(); originalLedger.close();
  const before = await inventory(dataRoot);
  const snapshot = await captureBackup({ dataRoot, writersQuiesced: true });
  const paths = snapshot.files.map(item => item.path);
  assert.ok(paths.includes('inference/ledger.sqlite'));
  assert.ok(paths.includes('.schedules/index.json'));
  assert.ok(paths.some(path => path.endsWith('/workspace-state.json')));
  assert.ok(paths.some(path => path.endsWith(`/schedules/${grant.id}.json`)));
  assert.ok(paths.some(path => path.endsWith(`/results/${job.id}.json`)));
  const key = randomBytes(32), archive = encryptBackup(snapshot, key);
  assert.equal(archive.includes(Buffer.from('Keep responses concise')), false);
  assert.deepEqual(decryptBackup(archive, key), snapshot);
  const restored = await restoreBackup({ archive, key, parent });
  for (const file of snapshot.files) assert.equal(sha(await readFile(resolve(restored.root, file.path))), file.sha256);
  assert.deepEqual(await inventory(dataRoot), before);
  const noPayment = async () => { throw new Error('Restore drill cannot accept payment'); };
  restoredApp = await createJeffApplication({ dataRoot: restored.root, startScheduler: false, fixture: true,
    env: { JEFF_CHAIN_ID: String(scope.chainId), JEFF_COLLECTION: scope.collection, JEFF_MODEL: 'bankr/fixture' },
    resolveOwner, runAgent: async () => { modelCalls++; throw new Error('Restored model must stay idle'); },
    hosting: { enabled: false, freePassEnabled: false, plan: {}, requireActive: noPayment, startJob: noPayment } });
  const restoredWorkspace = await restoredApp.workspace.get(scope);
  assert.equal(restoredWorkspace.memories[0].text, 'Keep responses concise and preserve this memory.');
  assert.deepEqual(restoredWorkspace.conversations[0].jobIds, [job.id]);
  const restoredBridge = createJeffOpenClawNftBridge({ dataRoot: restored.root, resolveOwner,
    runAgent: async () => { throw new Error('Retrieval must not run a model'); } });
  assert.equal((await restoredBridge.retrieve(scope, job.id)).text, 'Persisted fixture job output.');
  assert.equal(restoredApp.config().restoreBlocked, true);
  assert.equal(restoredApp.config().schedulesEnabled, false);
  const restoredBalance = restoredApp.inference.balance(scope);
  assert.deepEqual({ ...restoredBalance, restoreBlocked: false }, sourceBalance);
  assert.deepEqual(restoredApp.inference.list(scope), sourceTransactions);
  assert.equal(restoredBalance.heldMicros, 200000);
  assert.throws(() => restoredApp.inference.reserve({ id: 'fresh-restored-call', scope, amountMicros: 1,
    dailyLimitMicros: 1000000 }), /RESTORE_RECONCILIATION_REQUIRED/);
  assert.throws(() => restoredApp.inference.grant({ grantId: 'fresh-restored-grant', receiptId: 'settled-funding-fixture',
    chainId: scope.chainId, wallet: scope.owner, amountMicros: 1 }), /RESTORE_RECONCILIATION_REQUIRED/);
  assert.throws(() => restoredApp.inference.release('unknown-provider-call'), /RECONCILIATION_REQUIRED/);
  const grantsBefore = await restoredApp.scheduler.list(scope);
  await restoredApp.scheduler.tick();
  assert.deepEqual(await restoredApp.scheduler.list(scope), grantsBefore);
  await assert.rejects(restoredApp.scheduler.create(scope, grantInput), /MAINTENANCE/);
  assert.equal(grantsBefore.find(item => item.id === grant.id).status, 'active');
  assert.equal(grantsBefore.find(item => item.id === crashedGrant.id).runs[0].status, 'claimed');
  assert.equal(modelCalls, 1);
  assert.deepEqual(await inventory(dataRoot), before);
});
