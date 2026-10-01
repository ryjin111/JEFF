import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  JEFF_SOUL_FILES,
  loadAndVerifyJeffSoulBundle,
  verifyJeffSoulBundle,
} from '../api/_lib/jeff-soul-bundle.mjs';
import { JEFF_PROMOTED_MODEL } from '../api/_lib/jeff-agent-nft-promoted.mjs';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

async function loadRawBundle() {
  return {
    manifestText: await read('soul.json'),
    fileTexts: Object.fromEntries(await Promise.all(JEFF_SOUL_FILES.map(async ({ path }) => [path, await read(path)]))),
  };
}

test('portable soul bundle binds identity files and promoted checkpoint', async () => {
  const result = await loadAndVerifyJeffSoulBundle({
    expectedCheckpointSha256: JEFF_PROMOTED_MODEL.hashes.checkpointSha256,
  });

  assert.equal(result.agent.id, 'jeff');
  assert.equal(result.agent.version, '1.0.0');
  assert.equal(result.controls.executionAuthorized, false);
  assert.equal(result.controls.authorityIncluded, false);
  assert.equal(result.controls.memoryIncluded, false);
  assert.equal(result.files.length, 5);
  assert.match(result.bundleRootSha256, /^[a-f0-9]{64}$/);
  assert.match(result.manifestSha256, /^[a-f0-9]{64}$/);
});

test('portable soul bundle fails closed when identity content changes', async () => {
  const bundle = await loadRawBundle();
  bundle.fileTexts['SOUL.md'] += '\nInjected authority.\n';

  assert.throws(
    () => verifyJeffSoulBundle(bundle),
    /SOUL_FILE_HASH_MISMATCH:SOUL\.md/,
  );
});

test('portable soul bundle rejects a mismatched checkpoint', async () => {
  const bundle = await loadRawBundle();

  assert.throws(
    () => verifyJeffSoulBundle({ ...bundle, expectedCheckpointSha256: '0'.repeat(64) }),
    /SOUL_CHECKPOINT_HASH_MISMATCH/,
  );
});

test('portable soul bundle rejects attempts to embed authority or memory', async () => {
  const bundle = await loadRawBundle();
  const manifest = JSON.parse(bundle.manifestText);
  manifest.controls.executionAuthorized = true;
  manifest.controls.authorityIncluded = true;
  manifest.controls.memoryIncluded = true;

  assert.throws(
    () => verifyJeffSoulBundle({ ...bundle, manifestText: JSON.stringify(manifest) }),
    /SOUL_AUTHORITY_BOUNDARY_INVALID/,
  );
});

test('portable soul core excludes mutable authority and private memory files', async () => {
  const manifest = JSON.parse(await read('soul.json'));
  const paths = manifest.files.map(({ path }) => path);

  assert.deepEqual(paths, ['SOUL.md', 'IDENTITY.md', 'STYLE.md', 'SKILLS.md', 'LIMITS.md']);
  assert.equal(paths.includes('MEMORY.md'), false);
  assert.equal(paths.includes('HEARTBEAT.md'), false);
  assert.equal(paths.includes('AGENTS.md'), false);
});
