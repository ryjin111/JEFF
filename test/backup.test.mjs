import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { resolve, dirname, relative, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { captureBackup, encryptBackup, decryptBackup, restoreBackup } from '../src/backup.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const key = randomBytes(32);

async function fixture(t) {
  const root = await mkdtemp(resolve('test', '.backup-'));
  const dataRoot = resolve(root, 'source'), parent = resolve(root, 'restores');
  const cleanups = [];
  await mkdir(dataRoot); await mkdir(parent);
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    await rm(root, { recursive: true, force: true });
  });
  return { root, dataRoot, parent, cleanups };
}

async function put(root, path, value) {
  const file = resolve(root, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, value);
  return file;
}

async function inventory(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else files.push([relative(root, file).split(sep).join('/'), sha(await readFile(file))]);
    }
  }
  await visit(root);
  return files;
}

function refreshManifest(snapshot) {
  snapshot.manifestSha256 = sha(JSON.stringify(snapshot.files.map(({ path, size, sha256 }) => ({ path, size, sha256 }))));
  return snapshot;
}

test('generated plugin-skill links are explicitly excluded without following their targets', async t => {
  const f = await fixture(t);
  await put(f.dataRoot, 'scope/results/job.json', '{"saved":true}');
  const outside = resolve(f.root, 'external-plugin');
  await mkdir(outside);
  await put(outside, 'private.txt', 'outside the data root');
  await mkdir(resolve(f.dataRoot, 'scope/plugin-skills'), { recursive: true });
  await symlink(outside, resolve(f.dataRoot, 'scope/plugin-skills/browser-automation'), process.platform === 'win32' ? 'junction' : 'dir');
  const snapshot = await captureBackup({ dataRoot: f.dataRoot, writersQuiesced: true });
  assert.deepEqual(snapshot.files.map(file => file.path), ['scope/results/job.json']);
  assert.deepEqual(snapshot.excludedPaths, [{ path: 'scope/plugin-skills', reason: 'generated OpenClaw plugin-skill links, regenerated from pinned runtime', kind: 'directory' }]);
});

test('encrypted restore preserves committed SQLite WAL data and durable files without touching the source', async t => {
  const f = await fixture(t);
  const database = await put(f.dataRoot, 'scope/state/openclaw.sqlite', '');
  const db = new DatabaseSync(database);
  f.cleanups.push(() => db.close());
  db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE history (id INTEGER PRIMARY KEY, text TEXT NOT NULL); PRAGMA wal_checkpoint(TRUNCATE);');
  db.prepare('INSERT INTO history (text) VALUES (?)').run('committed private output in WAL');
  assert.ok((await readFile(`${database}-wal`)).length > 32);

  await put(f.dataRoot, 'accounts/account.json', JSON.stringify({ schema: 'simple-jeff-account-v1', scope: { kind: 'account', chainId: 4663, owner: '0x' + '11'.repeat(20) } }));
  await put(f.dataRoot, 'hosting/ledger.json', JSON.stringify({ invoices: { paid: { used: true, transactionHash: 'payment' } }, consumed: { payment: 'paid' }, entitlements: { account: { expiresAt: '2026-11-05T00:00:00Z' } } }));
  await put(f.dataRoot, 'scope/results/result.json', JSON.stringify({ status: 'completed', text: 'private result', textSha256: sha('private result') }));
  await put(f.dataRoot, 'scope/workspace/AGENTS.md', 'private workspace');
  await put(f.dataRoot, 'scope/openclaw.json', JSON.stringify({ agents: { defaults: { workspace: resolve(f.dataRoot, 'scope/workspace') } } }));
  await put(f.dataRoot, 'scope/state/openclaw-quarantine.sqlite', 'durable quarantine fixture');
  for (const path of ['scope/compile-cache/compiled', 'scope/tmp/scratch', 'hosting/ledger.json.temporary.tmp', 'scope/worker.pid', 'scope/worker.sock', 'scope/agents/main/agent/openclaw-agent.sqlite.generation-lock.sqlite', 'scope/agents/main/agent/openclaw-agent.sqlite.generation-writer.sqlite-wal', 'scope/agents/main/agent/openclaw-agent.sqlite.reindex-lock.sqlite-shm']) {
    await put(f.dataRoot, path, 'transient fixture');
  }

  const before = await inventory(f.dataRoot);
  const snapshot = await captureBackup({ dataRoot: f.dataRoot, writersQuiesced: true });
  const names = snapshot.files.map(file => file.path);
  assert.ok(names.includes('scope/state/openclaw.sqlite-wal'));
  assert.ok(names.includes('scope/state/openclaw-quarantine.sqlite'));
  assert.equal(names.some(path => /compile-cache|\/tmp\/|\.tmp$|\.pid$|\.sock$|generation-|reindex-lock/.test(path)), false);
  const archive = encryptBackup(snapshot, key);
  assert.notDeepEqual(archive, encryptBackup(snapshot, key));
  assert.equal(archive.includes(Buffer.from('committed private output in WAL')), false);
  assert.deepEqual(decryptBackup(archive, key), snapshot);

  const restored = await restoreBackup({ archive, key, parent: f.parent });
  assert.equal(restored.filesVerified, snapshot.files.length);
  for (const file of snapshot.files) assert.equal(sha(await readFile(resolve(restored.root, file.path))), file.sha256);
  const restoredDb = new DatabaseSync(resolve(restored.root, 'scope/state/openclaw.sqlite'), { readOnly: true });
  try {
    assert.equal(restoredDb.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    assert.equal(restoredDb.prepare('SELECT text FROM history').get().text, 'committed private output in WAL');
  } finally { restoredDb.close(); }
  assert.deepEqual(await inventory(f.dataRoot), before);

  // The checkpointed main database has the schema but not the committed WAL row.
  const mainOnly = await put(f.parent, 'main-only.sqlite', await readFile(database));
  const mainOnlyDb = new DatabaseSync(mainOnly, { readOnly: true });
  try { assert.equal(mainOnlyDb.prepare('SELECT COUNT(*) AS count FROM history').get().count, 0); }
  finally { mainOnlyDb.close(); }

  const second = await restoreBackup({ archive, key, parent: f.parent });
  assert.notEqual(second.root, restored.root);
  assert.deepEqual(await inventory(f.dataRoot), before);
});

test('capture requires quiesced writers and rejects source symlinks', async t => {
  const f = await fixture(t);
  await assert.rejects(captureBackup({ dataRoot: f.dataRoot }), /JEFF_BACKUP_WRITERS_REQUIRED/);
  const outside = resolve(f.root, 'outside');
  await mkdir(outside); await put(outside, 'sentinel.txt', 'outside data');
  await symlink(outside, resolve(f.dataRoot, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(captureBackup({ dataRoot: f.dataRoot, writersQuiesced: true }), /JEFF_BACKUP_LINK_DENIED/);
  assert.equal(await readFile(resolve(outside, 'sentinel.txt'), 'utf8'), 'outside data');
});

test('restore rejects traversal, absolute paths, path aliases and invalid manifest hashes before writing', async t => {
  const f = await fixture(t);
  await put(f.dataRoot, 'valid.json', '{}');
  const original = await captureBackup({ dataRoot: f.dataRoot, writersQuiesced: true });
  const before = await readdir(f.parent);
  for (const path of ['../escape.json', '/escape.json', 'folder/../../escape.json', 'C:/escape.json', '..\\escape.json', 'folder\\escape.json', 'folder/./escape.json', 'folder//escape.json', 'folder/\u0000escape.json']) {
    const snapshot = structuredClone(original);
    snapshot.files[0].path = path;
    await assert.rejects(restoreBackup({ archive: encryptBackup(refreshManifest(snapshot), key), key, parent: f.parent }), /JEFF_BACKUP_PATH_INVALID/);
  }
  const duplicate = structuredClone(original);
  duplicate.files.push({ ...duplicate.files[0], path: 'VALID.JSON' });
  await assert.rejects(restoreBackup({ archive: encryptBackup(refreshManifest(duplicate), key), key, parent: f.parent }), /JEFF_BACKUP_PATH_INVALID/);
  const modifiedContent = structuredClone(original);
  modifiedContent.files[0].data = Buffer.from('modified').toString('base64');
  await assert.rejects(restoreBackup({ archive: encryptBackup(modifiedContent, key), key, parent: f.parent }), /JEFF_BACKUP_HASH_INVALID/);
  const modifiedManifest = structuredClone(original);
  modifiedManifest.manifestSha256 = '0'.repeat(64);
  await assert.rejects(restoreBackup({ archive: encryptBackup(modifiedManifest, key), key, parent: f.parent }), /JEFF_BACKUP_HASH_INVALID/);
  assert.deepEqual(await readdir(f.parent), before);
  assert.equal(await readFile(resolve(f.dataRoot, 'valid.json'), 'utf8'), '{}');
});

test('archive corruption, truncation and a wrong key cannot restore any files', async t => {
  const f = await fixture(t);
  await put(f.dataRoot, 'private.txt', 'private saved history');
  const archive = encryptBackup(await captureBackup({ dataRoot: f.dataRoot, writersQuiesced: true }), key);
  const tampered = Buffer.from(archive); tampered[tampered.length - 1] ^= 1;
  const header = Buffer.from(archive); header[0] ^= 1;
  for (const invalid of [tampered, header, archive.subarray(0, 35), archive.subarray(0, archive.length - 1)]) {
    await assert.rejects(restoreBackup({ archive: invalid, key, parent: f.parent }));
  }
  await assert.rejects(restoreBackup({ archive, key: randomBytes(32), parent: f.parent }));
  assert.deepEqual(await readdir(f.parent), []);
});

test('restore rejects source tree parents including a symlink alias', async t => {
  const f = await fixture(t);
  await put(f.dataRoot, 'private.txt', 'original');
  const descendant = resolve(f.dataRoot, 'nested'); await mkdir(descendant);
  const archive = encryptBackup(await captureBackup({ dataRoot: f.dataRoot, writersQuiesced: true }), key);
  const alias = resolve(f.root, 'source-alias');
  await symlink(f.dataRoot, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const before = await inventory(f.dataRoot);
  for (const parent of [f.dataRoot, descendant, alias]) {
    await assert.rejects(restoreBackup({ archive, key, parent }), /JEFF_BACKUP_RESTORE_SOURCE_DENIED/);
  }
  assert.deepEqual(await inventory(f.dataRoot), before);
});

test('Windows source-tree isolation is case insensitive', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  await put(f.dataRoot, 'private.txt', 'original');
  const snapshot = await captureBackup({ dataRoot: f.dataRoot, writersQuiesced: true });
  snapshot.sourceRoot = snapshot.sourceRoot.toUpperCase();
  const before = await inventory(f.dataRoot);
  await assert.rejects(restoreBackup({ archive: encryptBackup(snapshot, key), key, parent: f.dataRoot }), /JEFF_BACKUP_RESTORE_SOURCE_DENIED/);
  assert.deepEqual(await inventory(f.dataRoot), before);
});
