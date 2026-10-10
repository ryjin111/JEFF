import { readFile, writeFile } from 'node:fs/promises';
import { createHash, createPublicKey, privateDecrypt, constants } from 'node:crypto';
import { decryptBackup } from '../src/backup.mjs';
import { verifyIsolatedRestore } from '../src/backup-verification.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export async function restoreRecurringBackup({ envelopeFile, privateKeyFile, parent }) {
  const envelope = JSON.parse(await readFile(envelopeFile, 'utf8'));
  if (envelope.schema !== 'jeff-recurring-backup-v1' || envelope.keyAlgorithm !== 'RSA-OAEP-SHA256'
    || envelope.archiveAlgorithm !== 'AES-256-GCM' || !/^[a-f0-9]{32}$/.test(envelope.nonce || '')
    || !/^[a-f0-9]{40}$/.test(envelope.releaseSha || '')) throw new Error('JEFF_BACKUP_ENVELOPE_INVALID');
  const privateKey = await readFile(privateKeyFile);
  const keyId = sha(createPublicKey(privateKey).export({ type: 'spki', format: 'der' }));
  const archive = Buffer.from(envelope.archive, 'base64');
  if (keyId !== envelope.keyId || sha(archive) !== envelope.archiveSha256) throw new Error('JEFF_BACKUP_ENVELOPE_INVALID');
  const key = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(envelope.wrappedKey, 'base64'));
  try {
    const snapshot = decryptBackup(archive, key);
    if (snapshot.recurring?.nonce !== envelope.nonce || snapshot.recurring.releaseSha !== envelope.releaseSha
      || snapshot.recurring.keyId !== keyId || snapshot.capturedAt !== envelope.capturedAt
      || snapshot.manifestSha256 !== envelope.manifestSha256) throw new Error('JEFF_BACKUP_ENVELOPE_INVALID');
    return { ...(await verifyIsolatedRestore({ archive, key, parent })), source: envelope.releaseSha, envelopeSha256: sha(await readFile(envelopeFile)) };
  } finally { key.fill(0); privateKey.fill(0); }
}
if (process.argv[1] === import.meta.filename) {
  const [envelopeFile, privateKeyFile, parent, receiptFile] = process.argv.slice(2);
  if (!envelopeFile || !privateKeyFile || !parent || !receiptFile) throw new Error('Usage: node scripts/restore-recurring-backup.mjs ENVELOPE PRIVATE_PEM ISOLATED_PARENT NEW_RECEIPT');
  const proof = await restoreRecurringBackup({ envelopeFile, privateKeyFile, parent });
  await writeFile(receiptFile, JSON.stringify(proof, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(proof));
}
