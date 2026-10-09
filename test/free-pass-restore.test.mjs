import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureBackup, encryptBackup, restoreBackup } from '../src/backup.mjs';
import { createHostingLedger } from '../src/hosting.mjs';

const testRoot = dirname(fileURLToPath(import.meta.url));
const monthMs = 30 * 86400000;
const scope = { chainId: 4663, collection: '0x' + '11'.repeat(20), tokenId: '35', owner: '0x' + '22'.repeat(20), ownerEpoch: 0 };
const env = { JEFF_FREE_PASS_ENABLED: 'true' };
const ledgerPath = root => resolve(root, 'hosting', 'ledger.json');
const guardPath = root => resolve(root, 'hosting', 'restore-guard.json');

async function fixture(t) {
  const root = await mkdtemp(resolve(testRoot, '.free-pass-restore-'));
  const dataRoot = resolve(root, 'source'), parent = resolve(root, 'restores');
  await mkdir(dataRoot); await mkdir(parent);
  t.after(async () => {
    assert.equal(dirname(root), testRoot);
    await rm(root, { recursive: true, force: true });
  });
  const key = randomBytes(32);
  const options = { env, now: () => Date.parse('2026-10-07T00:00:00Z'),
    resolveOwner: async subject => ({ owner: subject.owner, ownerEpoch: subject.ownerEpoch }) };
  const ledger = root => createHostingLedger({ ...options, dataRoot: root });
  async function backup(source = dataRoot) {
    const snapshot = await captureBackup({ dataRoot: source, writersQuiesced: true });
    return { snapshot, archive: encryptBackup(snapshot, key) };
  }
  async function restore(saved) { return restoreBackup({ archive: saved.archive, key, parent }); }
  return { root, dataRoot, parent, key, options, ledger, backup, restore };
}

async function rejectsUnavailable(operation) {
  await assert.rejects(async () => operation(), { message: 'JEFF_FREE_PASS_UNAVAILABLE' });
}

test('an encrypted backup after redemption restores the spent pass and its full 30 day task allowance', async t => {
  const f = await fixture(t);
  const source = f.ledger(f.dataRoot);
  const redeemed = await source.redeemFreePass(scope);
  assert.equal(redeemed.freePass.state, 'consumed');
  assert.equal(redeemed.usage.limit, 100);
  assert.equal(redeemed.usage.used, 0);
  assert.equal(redeemed.usage.remaining, 100);
  assert.equal(Date.parse(redeemed.usage.resetsAt) - Date.parse(redeemed.usage.periodStartsAt), monthMs);
  const before = await readFile(ledgerPath(f.dataRoot));
  const saved = await f.backup();
  assert.ok(saved.snapshot.files.some(file => file.path === 'hosting/ledger-initialized.json'));
  const started = Date.now();
  const restored = await f.restore(saved);
  const finished = Date.now();
  const guard = JSON.parse(await readFile(guardPath(restored.root), 'utf8'));
  assert.equal(guard.schema, 'simple-jeff-restore-guard-v1');
  assert.equal(guard.capturedAt, saved.snapshot.capturedAt);
  assert.equal(guard.freePassesBlocked, true);
  assert.ok(Date.parse(guard.restoredAt) >= started && Date.parse(guard.restoredAt) <= finished);
  assert.deepEqual(await readFile(ledgerPath(restored.root)), before);
  const after = await f.ledger(restored.root).status(scope);
  assert.equal(after.active, true);
  assert.equal(after.source, 'free-pass');
  assert.deepEqual(after.freePass, redeemed.freePass);
  assert.deepEqual(after.usage, redeemed.usage);
  assert.deepEqual(await readFile(ledgerPath(f.dataRoot)), before);
  await assert.rejects(readFile(guardPath(f.dataRoot)), { code: 'ENOENT' });
});

test('restoring a spent pass preserves accepted-task counts and keeps subsequent task writes isolated', async t => {
  const f = await fixture(t);
  const source = f.ledger(f.dataRoot);
  await source.redeemFreePass(scope);
  for (let index = 0; index < 3; index++) {
    await source.startJob(scope, async () => ({ id: `accepted-${index}`, status: 'queued' }));
  }
  const before = await readFile(ledgerPath(f.dataRoot));
  const original = await source.status(scope);
  const restored = await f.restore(await f.backup());
  const target = f.ledger(restored.root);
  const after = await target.status(scope);
  assert.equal(after.freePass.state, 'consumed');
  assert.deepEqual(after.usage, original.usage);
  assert.equal(after.usage.used, 3);
  assert.equal(after.usage.remaining, 97);
  assert.equal(after.usage.hourlyRemaining, 7);
  await target.startJob(scope, async () => ({ id: 'restored-task', status: 'queued' }));
  assert.equal((await f.ledger(restored.root).status(scope)).usage.used, 4);
  assert.equal((await source.status(scope)).usage.used, 3);
  assert.deepEqual(await readFile(ledgerPath(f.dataRoot)), before);
});

test('a pre-redemption backup cannot offer another free pass after the live NFT redeems it', async t => {
  const f = await fixture(t);
  const source = f.ledger(f.dataRoot);
  assert.equal((await source.status(scope)).freePass.state, 'available');
  const old = await f.backup();
  await source.redeemFreePass(scope);
  const before = await readFile(ledgerPath(f.dataRoot));
  const restored = await f.restore(old);
  const target = f.ledger(restored.root);
  const status = await target.status(scope);
  assert.equal(status.freePass.state, 'unavailable');
  assert.equal(status.active, false);
  assert.equal(status.usage.remaining, 0);
  await rejectsUnavailable(() => target.redeemFreePass(scope));
  const transferred = { ...scope, owner: '0x' + '44'.repeat(20), ownerEpoch: 1 };
  assert.equal((await target.status(transferred)).freePass.state, 'unavailable');
  await rejectsUnavailable(() => target.redeemFreePass(transferred));
  await assert.rejects(readFile(ledgerPath(restored.root)), { code: 'ENOENT' });
  assert.equal((await source.status(scope)).freePass.state, 'consumed');
  assert.deepEqual(await readFile(ledgerPath(f.dataRoot)), before);
});

test('marker existence blocks an unspent pass even when the already-created ledger has the feature enabled', async t => {
  const f = await fixture(t);
  const target = f.ledger(f.dataRoot);
  assert.equal((await target.status(scope)).freePass.state, 'available');
  await mkdir(dirname(guardPath(f.dataRoot)), { recursive: true });
  await writeFile(guardPath(f.dataRoot), JSON.stringify({ schema: 'simple-jeff-restore-guard-v1', freePassesBlocked: true }));
  assert.equal((await target.status(scope)).freePass.state, 'unavailable');
  await rejectsUnavailable(() => target.redeemFreePass(scope));
  assert.equal((await f.ledger(f.dataRoot).status(scope)).freePass.state, 'unavailable');
  await assert.rejects(readFile(ledgerPath(f.dataRoot)), { code: 'ENOENT' });
});

test('empty, malformed and falsely permissive marker contents all block by existence', async t => {
  for (const [name, contents] of [
    ['empty', ''], ['invalid JSON', '{not-json'], ['JSON null', 'null'],
    ['false flag', '{"schema":"simple-jeff-restore-guard-v1","freePassesBlocked":false}'],
    ['foreign schema', '{"schema":"another-schema","freePassesBlocked":false}'],
  ]) {
    await t.test(name, async t => {
      const f = await fixture(t);
      await mkdir(dirname(guardPath(f.dataRoot)), { recursive: true });
      await writeFile(guardPath(f.dataRoot), contents);
      const target = f.ledger(f.dataRoot);
      assert.equal((await target.status(scope)).freePass.state, 'unavailable');
      await rejectsUnavailable(() => target.redeemFreePass(scope));
      assert.equal(await readFile(guardPath(f.dataRoot), 'utf8'), contents);
      await assert.rejects(readFile(ledgerPath(f.dataRoot)), { code: 'ENOENT' });
    });
  }
});

test('a directory at the restore marker path also blocks new passes without hiding existing spent state', async t => {
  const f = await fixture(t);
  const target = f.ledger(f.dataRoot);
  await target.redeemFreePass(scope);
  const before = await readFile(ledgerPath(f.dataRoot));
  await mkdir(guardPath(f.dataRoot));
  assert.equal((await target.status(scope)).freePass.state, 'consumed');
  const unspent = { ...scope, tokenId: '36' };
  assert.equal((await target.status(unspent)).freePass.state, 'unavailable');
  await rejectsUnavailable(() => target.redeemFreePass(unspent));
  assert.equal((await f.ledger(f.dataRoot).status(scope)).freePass.state, 'consumed');
  assert.deepEqual(await readFile(ledgerPath(f.dataRoot)), before);
});
