import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hashJeffBenchmarkManifest, scoreJeffAgentNftBenchmarkV2 } from '../api/_lib/jeff-benchmark-v2.mjs';

const root = new URL('../benchmarks/jeff/v2/', import.meta.url);
const paths = Object.freeze({
  stimuli: new URL('jeff-v0.6-transfer-reliability.stimuli.json', root),
  predictions: new URL('jeff-v0.6-transfer-reliability.predictions.json', root),
  labels: new URL('jeff-v0.6-transfer-reliability.labels.json', root),
  result: new URL('jeff-v0.6-transfer-reliability.result.json', root),
});
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const stimuliText = await readFile(paths.stimuli, 'utf8');
const predictionsText = await readFile(paths.predictions, 'utf8');
const labelsText = await readFile(paths.labels, 'utf8');
const stimuli = JSON.parse(stimuliText);
const predictions = JSON.parse(predictionsText);
const labels = JSON.parse(labelsText);

if (labels.schema !== 'jeff-agent-nft-v2-transfer-reliability-labels-v1') throw new Error('JEFF_V2_LABEL_SCHEMA_INVALID');
if (labels.independentlyLabeled !== true || typeof labels.labeler !== 'string' || !labels.labeler.trim()) {
  throw new Error('JEFF_V2_INDEPENDENT_LABELER_REQUIRED');
}
if (labels.stimuliSha256 !== sha256(stimuliText) || predictions.stimuliSha256 !== labels.stimuliSha256) {
  throw new Error('JEFF_V2_STIMULI_BINDING_MISMATCH');
}
if (labels.predictionsSha256 !== sha256(predictionsText)) throw new Error('JEFF_V2_PREDICTION_BINDING_MISMATCH');
if (predictions.labelsAvailableAtFreeze !== false) throw new Error('JEFF_V2_PREDICTION_FREEZE_INVALID');

const stimulusIds = new Set(stimuli.cases.map((entry) => entry.id));
const labelIds = new Set(labels.cases?.map((entry) => entry.id));
if (labelIds.size !== stimulusIds.size || [...stimulusIds].some((id) => !labelIds.has(id))) {
  throw new Error('JEFF_V2_LABEL_CASE_COVERAGE_INVALID');
}
const labelsById = new Map(labels.cases.map((entry) => [entry.id, entry]));
const mergedCases = stimuli.cases.map((entry) => {
  const label = labelsById.get(entry.id);
  const expectedIds = Object.keys(label.expected ?? {}).sort();
  if (JSON.stringify(expectedIds) !== JSON.stringify([...stimuli.questionIds].sort())) {
    throw new Error(`JEFF_V2_LABEL_HEAD_COVERAGE_INVALID:${entry.id}`);
  }
  return {
    id: entry.id,
    protocol: entry.protocol,
    expected: label.expected,
    forbidden: label.forbidden ?? {},
    privateMarkers: entry.privateMarkers,
    transfer: entry.transfer,
  };
});

const score = scoreJeffAgentNftBenchmarkV2({ cases: mergedCases, runs: predictions.runs, k: stimuli.k });
const manifest = {
  schema: 'jeff-agent-nft-v2-transfer-reliability-result-v1',
  version: stimuli.version,
  model: predictions.model,
  mode: predictions.mode,
  executionAuthorized: predictions.executionAuthorized,
  independentLabeler: labels.labeler,
  labelsFrozenAt: labels.frozenAt,
  stimuliSha256: sha256(stimuliText),
  predictionsSha256: sha256(predictionsText),
  labelsSha256: sha256(labelsText),
  score,
};
const result = { ...manifest, manifestSha256: hashJeffBenchmarkManifest(manifest) };
const rendered = `${JSON.stringify(result, null, 2)}\n`;
const verify = process.argv.includes('--verify');
if (verify) {
  const existing = await readFile(paths.result, 'utf8');
  if (existing !== rendered) throw new Error('JEFF_V2_SCORE_REPRODUCTION_MISMATCH');
} else {
  await writeFile(paths.result, rendered, { encoding: 'utf8', flag: 'wx' });
}
process.stdout.write(rendered);

if (process.argv[1] && resolve(process.argv[1]) !== fileURLToPath(import.meta.url)) process.exitCode = 1;
