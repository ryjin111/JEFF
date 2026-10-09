import { readFile } from 'node:fs/promises';
import { verifyIsolatedRestore } from '../src/backup-verification.mjs';

// Keep the original import and CLI entry points compatible.
export { verifyIsolatedRestore };

if (process.argv[1] === import.meta.filename) {
  const [archiveFile, keyFile, parent] = process.argv.slice(2);
  if (!archiveFile || !keyFile || !parent) throw new Error('Usage: node scripts/backup-restore.mjs ARCHIVE KEY_FILE EXISTING_ISOLATED_PARENT');
  console.log(JSON.stringify(await verifyIsolatedRestore({ archive: await readFile(archiveFile), key: await readFile(keyFile), parent })));
}
