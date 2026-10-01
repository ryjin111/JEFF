import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export const JEFF_SOUL_FILES = Object.freeze([
  Object.freeze({ path: 'SOUL.md', role: 'identity-core' }),
  Object.freeze({ path: 'IDENTITY.md', role: 'public-card' }),
  Object.freeze({ path: 'STYLE.md', role: 'voice' }),
  Object.freeze({ path: 'SKILLS.md', role: 'capabilities' }),
  Object.freeze({ path: 'LIMITS.md', role: 'hard-limits' }),
]);

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isSha256 = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function computeJeffSoulBundleRoot(files) {
  const canonical = JSON.stringify(files.map(({ path, role, sha256: hash }) => ({ path, role, sha256: hash })));
  return sha256(canonical);
}

export function verifyJeffSoulBundle({ manifestText, fileTexts, expectedCheckpointSha256 } = {}) {
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    throw new Error('SOUL_MANIFEST_INVALID_JSON');
  }

  if (!isRecord(manifest) || manifest.schema !== 'jeff-agent-soul-manifest-v1') {
    throw new Error('SOUL_MANIFEST_SCHEMA_INVALID');
  }
  if (!isRecord(manifest.agent)
    || manifest.agent.id !== 'jeff'
    || manifest.agent.name !== 'JEFF'
    || manifest.agent.version !== '1.0.0') {
    throw new Error('SOUL_IDENTITY_INVALID');
  }
  if (!Array.isArray(manifest.tags)
    || manifest.tags.length === 0
    || new Set(manifest.tags).size !== manifest.tags.length
    || manifest.tags.some((tag) => typeof tag !== 'string' || !/^[a-z0-9-]+$/.test(tag))) {
    throw new Error('SOUL_TAGS_INVALID');
  }
  if (manifest.license !== 'MIT') throw new Error('SOUL_LICENSE_INVALID');
  if (!isRecord(manifest.compatibility)
    || manifest.compatibility.package !== 'jeff-agent-nft'
    || manifest.compatibility.packageVersion !== '0.5.0'
    || manifest.compatibility.node !== '>=20'
    || manifest.compatibility.runtimeMode !== 'shadow') {
    throw new Error('SOUL_COMPATIBILITY_INVALID');
  }
  if (!isRecord(manifest.controls)
    || manifest.controls.executionAuthorized !== false
    || manifest.controls.authorityIncluded !== false
    || manifest.controls.memoryIncluded !== false) {
    throw new Error('SOUL_AUTHORITY_BOUNDARY_INVALID');
  }
  if (!isRecord(manifest.checkpoint)
    || manifest.checkpoint.model !== 'jeff-agent-nft-nb-v0.5-evidence'
    || !isSha256(manifest.checkpoint.sha256)) {
    throw new Error('SOUL_CHECKPOINT_BINDING_INVALID');
  }
  if (expectedCheckpointSha256 && manifest.checkpoint.sha256 !== expectedCheckpointSha256) {
    throw new Error('SOUL_CHECKPOINT_HASH_MISMATCH');
  }
  if (!Array.isArray(manifest.files) || manifest.files.length !== JEFF_SOUL_FILES.length) {
    throw new Error('SOUL_FILE_SET_INVALID');
  }
  if (!isRecord(fileTexts)) throw new Error('SOUL_FILE_CONTENTS_INVALID');

  const verifiedFiles = JEFF_SOUL_FILES.map((required, index) => {
    const entry = manifest.files[index];
    if (!isRecord(entry) || entry.path !== required.path || entry.role !== required.role || !isSha256(entry.sha256)) {
      throw new Error(`SOUL_FILE_ENTRY_INVALID:${required.path}`);
    }
    const text = fileTexts[required.path];
    if (typeof text !== 'string') throw new Error(`SOUL_FILE_MISSING:${required.path}`);
    const observed = sha256(text);
    if (observed !== entry.sha256) throw new Error(`SOUL_FILE_HASH_MISMATCH:${required.path}`);
    return Object.freeze({ ...required, sha256: observed });
  });

  const expectedPaths = new Set(JEFF_SOUL_FILES.map(({ path }) => path));
  if (Object.keys(fileTexts).some((path) => !expectedPaths.has(path))) throw new Error('SOUL_FILE_SET_INVALID');

  const bundleRootSha256 = computeJeffSoulBundleRoot(verifiedFiles);
  if (!isSha256(manifest.bundleRootSha256) || manifest.bundleRootSha256 !== bundleRootSha256) {
    throw new Error('SOUL_BUNDLE_ROOT_MISMATCH');
  }

  return Object.freeze({
    schema: manifest.schema,
    agent: Object.freeze({ ...manifest.agent }),
    controls: Object.freeze({ ...manifest.controls }),
    checkpoint: Object.freeze({ ...manifest.checkpoint }),
    files: Object.freeze(verifiedFiles),
    bundleRootSha256,
    manifestSha256: sha256(manifestText),
  });
}

export async function loadAndVerifyJeffSoulBundle({ expectedCheckpointSha256 } = {}) {
  const root = new URL('../../', import.meta.url);
  const manifestText = await readFile(new URL('soul.json', root), 'utf8');
  const fileTexts = Object.fromEntries(await Promise.all(JEFF_SOUL_FILES.map(async ({ path }) => [
    path,
    await readFile(new URL(path, root), 'utf8'),
  ])));
  return verifyJeffSoulBundle({ manifestText, fileTexts, expectedCheckpointSha256 });
}
