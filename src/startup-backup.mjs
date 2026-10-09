import { createHash, createPublicKey, publicEncrypt, randomBytes, timingSafeEqual, constants } from 'node:crypto';
import { captureBackup, encryptBackup } from './backup.mjs';
import { verifyIsolatedRestore } from './backup-verification.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, basename } from 'node:path';

const sha = value => createHash('sha256').update(value).digest('hex');
const identityFields = ['RAILWAY_PROJECT_ID', 'RAILWAY_ENVIRONMENT_ID', 'RAILWAY_SERVICE_ID', 'JEFF_PUBLIC_ORIGIN', 'JEFF_RELEASE_SHA', 'RAILWAY_VOLUME_MOUNT_PATH'];

// Run before the application, scheduler, SQLite connections or runtime start.
// The host must enforce one volume writer and zero deployment overlap.
// Requests can retrieve a pre-encrypted snapshot, never initiate a capture.
export async function prepareStartupBackup({ env = process.env, now = Date.now, capture = captureBackup } = {}) {
  if (!env.JEFF_STARTUP_BACKUP_EXPORT) return null;
  let config;
  try { config = JSON.parse(env.JEFF_STARTUP_BACKUP_EXPORT); } catch { throw new Error('JEFF_BACKUP_EXPORT_CONFIG_INVALID'); }
  const allowed = ['schema', 'nonce', 'tokenSha256', 'publicKey', 'expiresAt', 'expected'];
  if (!config || config.schema !== 'jeff-startup-backup-export-v1' || Object.keys(config).some(key => !allowed.includes(key))
    || !/^[a-f0-9]{32}$/.test(config.nonce || '') || !/^[a-f0-9]{64}$/.test(config.tokenSha256 || '')
    || typeof config.expiresAt !== 'string' || !Number.isFinite(Date.parse(config.expiresAt)) || typeof config.publicKey !== 'string' || config.publicKey.length > 2048
    || !config.expected || Object.keys(config.expected).length !== identityFields.length
    || identityFields.some(key => typeof config.expected[key] !== 'string' || config.expected[key] !== env[key])
    || identityFields.slice(0, 3).some(key => !/^[a-f0-9-]{36}$/.test(env[key] || ''))
    || !/^[a-f0-9]{40}$/.test(env.JEFF_RELEASE_SHA || '')
    || env.JEFF_DATA_ROOT !== '/data' || env.RAILWAY_VOLUME_MOUNT_PATH !== '/data'
    || !/^https:\/\//.test(env.JEFF_PUBLIC_ORIGIN || '')) throw new Error('JEFF_BACKUP_EXPORT_CONFIG_INVALID');
  try { if (new URL(env.JEFF_PUBLIC_ORIGIN).origin !== env.JEFF_PUBLIC_ORIGIN) throw new Error(); }
  catch { throw new Error('JEFF_BACKUP_EXPORT_CONFIG_INVALID'); }
  const expiresAt = Date.parse(config.expiresAt);
  // An expired one-shot must not prevent later ordinary service restarts.
  if (expiresAt <= now()) return null;
  if (expiresAt - now() > 10 * 60 * 1000) throw new Error('JEFF_BACKUP_EXPORT_CONFIG_INVALID');
  let publicKey;
  try { publicKey = createPublicKey(config.publicKey); } catch { throw new Error('JEFF_BACKUP_EXPORT_CONFIG_INVALID'); }
  if (publicKey.asymmetricKeyType !== 'rsa' || publicKey.asymmetricKeyDetails?.modulusLength < 3072) throw new Error('JEFF_BACKUP_EXPORT_CONFIG_INVALID');
  const snapshot = await capture({ dataRoot: env.JEFF_DATA_ROOT, writersQuiesced: true });
  if (now() >= expiresAt) throw new Error('JEFF_BACKUP_EXPORT_EXPIRED');
  const key = randomBytes(32), keyId = sha(publicKey.export({ type: 'spki', format: 'der' }));
  let payload, restoreProof;
  try {
    // Bind export identity inside the authenticated AES plaintext as well.
    const archive = encryptBackup({ ...snapshot, export: { nonce: config.nonce, releaseSha: env.JEFF_RELEASE_SHA,
      expiresAt: config.expiresAt, keyId } }, key);
    const isolatedParent = await mkdtemp(resolve(tmpdir(), 'jeff-backup-verification-'));
    try {
      restoreProof = await verifyIsolatedRestore({ archive, key, parent: isolatedParent });
      if (restoreProof.modelCalls !== 0 || restoreProof.runtimeLaunched || restoreProof.liveDataOverwritten) throw new Error('JEFF_BACKUP_RESTORE_UNSAFE');
    } finally {
      if (dirname(resolve(isolatedParent)) !== resolve(tmpdir()) || !basename(isolatedParent).startsWith('jeff-backup-verification-')) throw new Error('JEFF_BACKUP_CLEANUP_UNSAFE');
      await rm(isolatedParent, { recursive: true, force: true });
    }
    if (now() >= expiresAt) throw new Error('JEFF_BACKUP_EXPORT_EXPIRED');
    const wrappedKey = publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key);
    payload = Buffer.from(JSON.stringify({ schema: 'jeff-encrypted-backup-envelope-v1', nonce: config.nonce,
      releaseSha: env.JEFF_RELEASE_SHA, capturedAt: snapshot.capturedAt, expiresAt: config.expiresAt, keyId,
      keyAlgorithm: 'RSA-OAEP-SHA256', archiveAlgorithm: 'AES-256-GCM',
      wrappedKey: wrappedKey.toString('base64'), archive: archive.toString('base64'), archiveSha256: sha(archive) }));
  } finally { key.fill(0); }
  const receipt = Object.freeze({ event: 'JEFF_STARTUP_BACKUP_READY', releaseSha: env.JEFF_RELEASE_SHA,
    capturedAt: snapshot.capturedAt, expiresAt: config.expiresAt, envelopeSha256: sha(payload),
    envelopeBytes: payload.length, filesCaptured: snapshot.files.length, manifestSha256: snapshot.manifestSha256,
    consistency: snapshot.consistency,
    isolatedStorageRestore: { verified: true, filesVerified: restoreProof.filesVerified,
      databasesQuickChecked: restoreProof.databasesQuickChecked, jobsRetrieved: restoreProof.jobsRetrieved,
      operatorJob: restoreProof.operatorJob, restoreGuardPresent: restoreProof.freePassRedemptionBlocked,
      modelCalls: 0, runtimeLaunched: false, liveDataOverwritten: false, temporaryCopyRemoved: true } });
  const path = `/api/operator/backup/${config.nonce}`;
  const expectedTokenHash = Buffer.from(config.tokenSha256, 'hex');
  const dispose = () => { if (payload) payload.fill(0); payload = null; };
  const timer = setTimeout(dispose, Math.max(1, expiresAt - now())); timer.unref();
  return Object.freeze({ receipt,
    handleRequest(request, response) {
      let url;
      try { url = new URL(request.url, env.JEFF_PUBLIC_ORIGIN); } catch { return false; }
      if (url.pathname !== path) return false;
      response.setHeader('Cache-Control', 'no-store, private');
      response.setHeader('Pragma', 'no-cache');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization || '')?.[1];
      const authorized = bearer && timingSafeEqual(Buffer.from(sha(bearer), 'hex'), expectedTokenHash);
      if (!payload || now() >= expiresAt || request.method !== 'GET' || request.url !== path
        || request.headers.origin && request.headers.origin !== env.JEFF_PUBLIC_ORIGIN || !authorized) {
        response.writeHead(404, { 'Content-Type': 'application/json' });
        response.end('{"error":"JEFF_ROUTE_NOT_FOUND"}'); return true;
      }
      response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': payload.length });
      // Preserve an in-flight response if the expiry timer clears the cache.
      response.end(Buffer.from(payload)); return true;
    },
    dispose() { clearTimeout(timer); dispose(); },
  });
}
