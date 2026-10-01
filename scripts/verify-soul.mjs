import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { JEFF_PROMOTED_MODEL } from '../api/_lib/jeff-agent-nft-promoted.mjs';
import { loadAndVerifyJeffSoulBundle } from '../api/_lib/jeff-soul-bundle.mjs';

export async function verifySoul() {
  return loadAndVerifyJeffSoulBundle({
    expectedCheckpointSha256: JEFF_PROMOTED_MODEL.hashes.checkpointSha256,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(await verifySoul(), null, 2)}\n`);
}
