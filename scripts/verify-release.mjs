import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { JEFF_PROMOTED_MODEL } from '../api/_lib/jeff-agent-nft-promoted.mjs';
import { assessJeffModelPromotion } from '../api/_lib/jeff-model-promotion.mjs';
import { loadAndVerifyJeffSoulBundle } from '../api/_lib/jeff-soul-bundle.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

const paths = Object.freeze({
  checkpoint: 'models/jeff-agent-nft-nb-v0.5-evidence/checkpoint.json',
  runtime: 'api/_lib/jeff-agent-nft-learned-v0.5.mjs',
  receipt: 'benchmarks/jeff/results/jeff-agent-nft-protocol-blind-v3.json',
  trainingDataset: 'datasets/jeff-agent-nft/v0.5-evidence/seed.json',
  stimuli: 'benchmarks/jeff/agent-nft-protocol-blind-v3.stimuli.json',
  labels: 'benchmarks/jeff/agent-nft-protocol-blind-v3.labels.json',
  predictions: 'benchmarks/jeff/results/jeff-agent-nft-protocol-blind-v3.predictions.json',
  sourceManifest: 'benchmarks/jeff/primary-source-manifest-2026-09-28.json',
  sourceAudit: 'docs/research/JEFF_PRIMARY_SOURCE_AUDIT_2026-09-28.md',
});

export async function verifyRelease() {
  const receiptText = await read(paths.receipt);
  const receipt = JSON.parse(receiptText);
  const checks = [
    ['checkpoint', paths.checkpoint, JEFF_PROMOTED_MODEL.hashes.checkpointSha256],
    ['runtime', paths.runtime, JEFF_PROMOTED_MODEL.hashes.runtimeSha256],
    ['receipt', paths.receipt, JEFF_PROMOTED_MODEL.hashes.receiptSha256],
    ['training dataset', paths.trainingDataset, receipt.trainingDatasetSha256],
    ['stimuli', paths.stimuli, receipt.datasetSha256],
    ['labels', paths.labels, receipt.labelsSha256],
    ['predictions', paths.predictions, receipt.predictionsSha256],
    ['source manifest', paths.sourceManifest, JEFF_PROMOTED_MODEL.hashes.sourceManifestSha256],
    ['source audit', paths.sourceAudit, JEFF_PROMOTED_MODEL.hashes.sourceAuditSha256],
  ];

  const artifacts = [];
  for (const [name, path, expected] of checks) {
    const observed = sha256(await read(path));
    if (observed !== expected) throw new Error(`${name.toUpperCase().replaceAll(' ', '_')}_HASH_MISMATCH`);
    artifacts.push({ name, path, sha256: observed });
  }

  const promotion = assessJeffModelPromotion(receipt);
  if (!promotion.eligible) throw new Error(`PROMOTION_GATE_FAILED:${promotion.reasons.join(',')}`);
  if (receipt.controls.executionAuthorized !== false || JEFF_PROMOTED_MODEL.executionAuthorized !== false) {
    throw new Error('EXECUTION_BOUNDARY_INVALID');
  }

  const licenses = [
    ['LICENSE', ['MIT License', 'Clockers Room contributors']],
    ['models/jeff-agent-nft-nb-v0.5-evidence/LICENSE', ['MIT License', 'SPDX-License-Identifier: MIT']],
    ['datasets/jeff-agent-nft/v0.5-evidence/LICENSE', ['CC BY 4.0', 'SPDX-License-Identifier: CC-BY-4.0']],
  ];
  for (const [path, markers] of licenses) {
    const text = await read(path);
    if (markers.some((marker) => !text.includes(marker))) throw new Error(`LICENSE_INVALID:${path}`);
  }

  const soul = await loadAndVerifyJeffSoulBundle({
    expectedCheckpointSha256: JEFF_PROMOTED_MODEL.hashes.checkpointSha256,
  });
  artifacts.push({ name: 'soul manifest', path: 'soul.json', sha256: soul.manifestSha256 });
  artifacts.push(...soul.files.map((file) => ({
    name: `soul ${file.role}`,
    path: file.path,
    sha256: file.sha256,
  })));

  return {
    schema: 'jeff-standalone-release-verification-v1',
    model: JEFF_PROMOTED_MODEL.model,
    mode: JEFF_PROMOTED_MODEL.mode,
    executionAuthorized: false,
    observedAccuracy: promotion.observed,
    releaseReady: true,
    artifacts,
    soul: {
      schema: soul.schema,
      version: soul.agent.version,
      bundleRootSha256: soul.bundleRootSha256,
      manifestSha256: soul.manifestSha256,
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(await verifyRelease(), null, 2)}\n`);
}
