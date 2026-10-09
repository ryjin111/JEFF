import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { readdir, lstat, readFile, writeFile, mkdir, realpath, mkdtemp } from 'node:fs/promises';
import { resolve, relative, dirname, sep, isAbsolute } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const transientDb = /\.sqlite\.(?:generation-(?:lock|writer)|reindex-lock)\.sqlite(?:-wal|-shm|-journal)?$/;
const exclusion = path => path.split('/').some(part => ['compile-cache', 'tmp'].includes(part)) ? 'regenerable cache or temporary directory'
  : path.split('/').includes('plugin-skills') ? 'generated OpenClaw plugin-skill links, regenerated from pinned runtime'
  : /\.(?:tmp(?:\.|$)|pid$|sock$)/.test(path.split('/').at(-1)) || transientDb.test(path) ? 'transient lock or temporary file' : null;
const inside = (child, parent) => { const path = relative(parent, child); return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep)); };
const validPath = path => typeof path === 'string' && path.length > 0 && !/[\\:\x00-\x1f]/.test(path)
  && path.split('/').every(part => part && part !== '.' && part !== '..' && !/[. ]$/.test(part)
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));

// The caller must stop all writers first. A stable reread detects accidental writes.
export async function captureBackup({ dataRoot, writersQuiesced = false, maxBytes = 64 * 1024 * 1024, maxFileBytes = 32 * 1024 * 1024, maxFiles = 10000, maxDepth = 32 }) {
  if (!writersQuiesced) throw new Error('JEFF_BACKUP_WRITERS_REQUIRED');
  if (![maxBytes, maxFileBytes, maxFiles, maxDepth].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('JEFF_BACKUP_LIMIT_INVALID');
  const root = await realpath(dataRoot);
  async function scan() {
    const files = [], excludedPaths = []; let totalBytes = 0, entries = 0;
    async function visit(directory, depth = 0) {
      if (depth > maxDepth) throw new Error('JEFF_BACKUP_TOO_LARGE');
      for (const entry of (await readdir(directory)).sort()) {
        if (++entries > maxFiles) throw new Error('JEFF_BACKUP_TOO_LARGE');
        const file = resolve(directory, entry), path = relative(root, file).split(sep).join('/');
        if (!validPath(path)) throw new Error('JEFF_BACKUP_PATH_INVALID');
        const stat = await lstat(file);
        const reason = exclusion(path);
        if (reason) { excludedPaths.push({ path, reason, kind: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : 'file' }); continue; }
        if (stat.isSymbolicLink()) throw new Error('JEFF_BACKUP_LINK_DENIED');
        if (stat.isDirectory()) await visit(file, depth + 1);
        else if (stat.isFile()) {
          totalBytes += stat.size;
          if (totalBytes > maxBytes || stat.size > maxFileBytes) throw new Error('JEFF_BACKUP_TOO_LARGE');
          const bytes = await readFile(file);
          if (bytes.length !== stat.size) throw new Error('JEFF_BACKUP_SOURCE_CHANGED');
          files.push({ path, size: bytes.length, sha256: sha(bytes), data: bytes.toString('base64') });
        } else throw new Error('JEFF_BACKUP_FILE_INVALID');
      }
    }
    await visit(root);
    return { files, excludedPaths };
  }
  const { files, excludedPaths } = await scan();
  const manifestOf = records => records.map(({ path, size, sha256 }) => ({ path, size, sha256 }));
  const manifest = manifestOf(files);
  const reread = await scan();
  if (JSON.stringify(manifest) !== JSON.stringify(manifestOf(reread.files)) || JSON.stringify(excludedPaths) !== JSON.stringify(reread.excludedPaths)) throw new Error('JEFF_BACKUP_SOURCE_CHANGED');
  return { schema: 'simple-jeff-backup-v1', capturedAt: new Date().toISOString(), sourceRoot: root,
    consistency: 'all-service-writers-quiesced-and-stable-reread', exclusions: ['compile-cache/', 'tmp/', 'plugin-skills/ generated links', 'temporary and SQLite generation/reindex lock files'],
    manifestSha256: sha(JSON.stringify(manifest)), excludedPaths, files };
}

export function encryptBackup(snapshot, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('JEFF_BACKUP_KEY_INVALID');
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
  const encrypted = Buffer.concat([cipher.update(gzipSync(JSON.stringify(snapshot))), cipher.final()]);
  return Buffer.concat([Buffer.from('JEFFBK01'), nonce, cipher.getAuthTag(), encrypted]);
}

export function decryptBackup(archive, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32 || !Buffer.isBuffer(archive) || archive.length <= 36 || archive.subarray(0, 8).toString() !== 'JEFFBK01') throw new Error('JEFF_BACKUP_ARCHIVE_INVALID');
  const decipher = createDecipheriv('aes-256-gcm', key, archive.subarray(8, 20), { authTagLength: 16 });
  decipher.setAuthTag(archive.subarray(20, 36));
  const snapshot = JSON.parse(gunzipSync(Buffer.concat([decipher.update(archive.subarray(36)), decipher.final()]), { maxOutputLength: 512 * 1024 * 1024 }));
  if (snapshot.schema !== 'simple-jeff-backup-v1' || !Array.isArray(snapshot.files)) throw new Error('JEFF_BACKUP_ARCHIVE_INVALID');
  const names = new Set();
  for (const file of snapshot.files) {
    if (!validPath(file.path) || names.has(file.path.toLowerCase())) throw new Error('JEFF_BACKUP_PATH_INVALID');
    names.add(file.path.toLowerCase());
    const bytes = Buffer.from(file.data, 'base64');
    if (bytes.length !== file.size || sha(bytes) !== file.sha256) throw new Error('JEFF_BACKUP_HASH_INVALID');
  }
  const manifest = snapshot.files.map(({ path, size, sha256 }) => ({ path, size, sha256 }));
  if (sha(JSON.stringify(manifest)) !== snapshot.manifestSha256) throw new Error('JEFF_BACKUP_HASH_INVALID');
  return snapshot;
}

// Always creates a new directory. This function cannot overwrite an existing tree.
export async function restoreBackup({ archive, key, parent }) {
  const snapshot = decryptBackup(archive, key);
  const destinationParent = await realpath(parent);
  if (inside(destinationParent, resolve(snapshot.sourceRoot))) throw new Error('JEFF_BACKUP_RESTORE_SOURCE_DENIED');
  const root = await mkdtemp(resolve(destinationParent, 'jeff-isolated-restore-'));
  for (const file of snapshot.files) {
    const path = resolve(root, file.path);
    if (!inside(path, root)) throw new Error('JEFF_BACKUP_PATH_INVALID');
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, Buffer.from(file.data, 'base64'), { flag: 'wx', mode: 0o600 });
    if (sha(await readFile(path)) !== file.sha256) throw new Error('JEFF_BACKUP_HASH_INVALID');
  }
  // A snapshot cannot know about passes consumed after its capture. Keep fresh
  // claims disabled in every restored tree until the operator reconciles them.
  const guard = resolve(root, 'hosting', 'restore-guard.json');
  await mkdir(dirname(guard), { recursive: true, mode: 0o700 });
  try {
    await writeFile(guard, JSON.stringify({ schema: 'simple-jeff-restore-guard-v1',
      capturedAt: snapshot.capturedAt, restoredAt: new Date().toISOString(), freePassesBlocked: true }), { flag: 'wx', mode: 0o600 });
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
  return { root, snapshot, filesVerified: snapshot.files.length };
}
