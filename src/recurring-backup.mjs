import { createHash, createPublicKey, publicEncrypt, randomBytes, constants } from 'node:crypto';
import { mkdtemp, rm, mkdir, writeFile, rename, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, basename } from 'node:path';
import { captureBackup, encryptBackup } from './backup.mjs';
import { verifyIsolatedRestore } from './backup-verification.mjs';
import { createBackupObjectStore } from './backup-object-store.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
export function recurringRecipient(pem) {
  let key; try { key = createPublicKey(pem); } catch { throw new Error('JEFF_BACKUP_RECIPIENT_INVALID'); }
  if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails?.modulusLength < 3072) throw new Error('JEFF_BACKUP_RECIPIENT_INVALID');
  return key;
}
export async function sealRecurringBackup(snapshot, publicKey, releaseSha, verify = verifyIsolatedRestore) {
  if (!/^[a-f0-9]{40}$/.test(releaseSha || '')) throw new Error('JEFF_BACKUP_RELEASE_INVALID');
  const recipient = recurringRecipient(publicKey), nonce = randomBytes(16).toString('hex'), key = randomBytes(32);
  const keyId = sha(recipient.export({ type: 'spki', format: 'der' }));
  const temporary = await mkdtemp(resolve(tmpdir(), 'jeff-recurring-'));
  try {
    const archive = encryptBackup({ ...snapshot, recurring: { nonce, releaseSha, keyId } }, key);
    const proof = await verify({ archive, key, parent: temporary });
    if (proof.modelCalls !== 0 || proof.runtimeLaunched || proof.liveDataOverwritten) throw new Error('JEFF_BACKUP_RESTORE_UNSAFE');
    const bytes = Buffer.from(JSON.stringify({ schema: 'jeff-recurring-backup-v1', nonce, releaseSha, keyId,
      capturedAt: snapshot.capturedAt, manifestSha256: snapshot.manifestSha256,
      keyAlgorithm: 'RSA-OAEP-SHA256', archiveAlgorithm: 'AES-256-GCM',
      wrappedKey: publicEncrypt({ key: recipient, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key).toString('base64'),
      archive: archive.toString('base64'), archiveSha256: sha(archive) }));
    return { bytes, key: `backup-${snapshot.capturedAt.replaceAll(/[:.]/g, '-')}-${nonce}.json`,
      filesVerified: proof.filesVerified, databasesQuickChecked: proof.databasesQuickChecked, jobsRetrieved: proof.jobsRetrieved };
  } finally {
    key.fill(0);
    if (dirname(temporary) !== resolve(tmpdir()) || !basename(temporary).startsWith('jeff-recurring-')) throw new Error('JEFF_BACKUP_CLEANUP_UNSAFE');
    await rm(temporary, { recursive: true, force: true });
  }
}
export function createRecurringBackup({ env = process.env, maintenance, canResume = () => true,
  capture = captureBackup, seal = sealRecurringBackup, store, onReceipt = value => console.log(JSON.stringify(value)),
  onFailure = () => console.error('JEFF_RECURRING_BACKUP_FAILED') } = {}) {
  if (!env.JEFF_RECURRING_BACKUP) return { start() {}, isCapturing() { return false; }, async status() { return { enabled: false, lastVerifiedAt: null, lastFailureAt: null }; }, async stop() {}, async run() { return null; } };
  let config;
  try { config = JSON.parse(env.JEFF_RECURRING_BACKUP); } catch { throw new Error('JEFF_BACKUP_CONFIG_INVALID'); }
  if (!config || Object.keys(config).some(key => !['publicKey', 'endpoint', 'bucket', 'region', 'prefix', 'intervalHours', 'urlStyle'].includes(key))
    || !Number.isInteger(config.intervalHours) || config.intervalHours < 1 || config.intervalHours > 24
    || !/^[a-f0-9]{40}$/.test(env.JEFF_RELEASE_SHA || '')) throw new Error('JEFF_BACKUP_CONFIG_INVALID');
  recurringRecipient(config.publicKey);
  const objectStore = store || createBackupObjectStore({ ...config,
    accessKeyId: env.JEFF_BACKUP_ACCESS_KEY_ID, secretAccessKey: env.JEFF_BACKUP_SECRET_ACCESS_KEY });
  let stopped = false, active = null, timer, first, capturing = false;
  let lastVerifiedAt = null, lastFailureAt = null;
  const priorReceipt = readFile(resolve(env.JEFF_DATA_ROOT, '.operations/backup-receipt.json'), 'utf8').then(text => {
    if (text.length > 4096) return;
    const value = JSON.parse(text);
    if (value.event === 'JEFF_RECURRING_BACKUP_READY' && value.readbackVerified === true && Number.isFinite(Date.parse(value.capturedAt))) lastVerifiedAt = value.capturedAt;
  }).catch(() => {});
  async function captureAndUpload() {
    if (stopped || !canResume() || maintenance.status().phase !== 'running') return null;
    let snapshot; capturing = true;
    try {
      const marker = await maintenance.pause();
      try {
        if (!marker || stopped || !canResume() || maintenance.status().phase !== 'paused') throw new Error('JEFF_BACKUP_DRAIN_CANCELLED');
        snapshot = await capture({ dataRoot: env.JEFF_DATA_ROOT, writersQuiesced: true });
      } finally {
        if (canResume() && maintenance.status().phase === 'paused') await maintenance.resume();
      }
    } finally { capturing = false; }
    const sealed = await seal(snapshot, config.publicKey, env.JEFF_RELEASE_SHA);
    try {
      const uploaded = await objectStore.putVerified(sealed.key, sealed.bytes);
      const receipt = { event: 'JEFF_RECURRING_BACKUP_READY', observedAt: new Date().toISOString(), source: env.JEFF_RELEASE_SHA,
        capturedAt: snapshot.capturedAt, manifestSha256: snapshot.manifestSha256,
        ...uploaded, filesVerified: sealed.filesVerified, databasesQuickChecked: sealed.databasesQuickChecked, jobsRetrieved: sealed.jobsRetrieved };
      const finish = maintenance.beginRequest();
      if (!finish) throw new Error('JEFF_BACKUP_RECEIPT_BLOCKED');
      try {
        const directory = resolve(env.JEFF_DATA_ROOT, '.operations'); await mkdir(directory, { recursive: true, mode: 0o700 });
        const temporary = resolve(directory, 'backup-receipt.json.tmp');
        await writeFile(temporary, JSON.stringify(receipt), { mode: 0o600 });
        await rename(temporary, resolve(directory, 'backup-receipt.json')); lastVerifiedAt = snapshot.capturedAt; onReceipt(receipt); return receipt;
      } finally { finish(); }
    } finally { sealed.bytes.fill(0); }
  }
  const run = () => {
    if (stopped) return Promise.resolve(null);
    if (active) return active;
    active = priorReceipt.then(captureAndUpload).catch(error => { lastFailureAt = new Date().toISOString(); throw error; }).finally(() => { active = null; }); return active;
  };
  const scheduled = () => { run().catch(onFailure); };
  return { run, isCapturing() { return capturing; }, async status() { await priorReceipt; return { enabled: true, lastVerifiedAt, lastFailureAt }; }, start() {
    if (timer || stopped) return;
    first = setTimeout(scheduled, 60000); first.unref();
    timer = setInterval(scheduled, config.intervalHours * 3600000); timer.unref();
  }, async stop() { stopped = true; clearTimeout(first); clearInterval(timer); await active?.catch(() => {}); } };
}
