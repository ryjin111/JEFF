import { readFile, writeFile } from 'node:fs/promises';
import { createDecipheriv } from 'node:crypto';
const [archive, keyFile, newOutput] = process.argv.slice(2);
if (!archive || !keyFile || !newOutput) throw new Error('Usage: node scripts/restore-config.mjs ENCRYPTED_CONFIG KEY_FILE NEW_PRIVATE_OUTPUT');
const envelope = JSON.parse(await readFile(archive, 'utf8'));
if (envelope.identity?.schema !== 'jeff-config-recovery-v1') throw new Error('CONFIG_ARCHIVE_INVALID');
const key = await readFile(keyFile);
let plaintext;
try {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAAD(Buffer.from(JSON.stringify(envelope.identity))); decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]);
  JSON.parse(plaintext.toString('utf8'));
  await writeFile(newOutput, plaintext, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ recovered: true, source: envelope.identity.source, valuesPrinted: false }));
} finally { key.fill(0); plaintext?.fill(0); }
