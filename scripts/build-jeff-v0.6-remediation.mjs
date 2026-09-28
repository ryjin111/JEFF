import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { JEFF_AGENT_NFT_CAPABILITY_QUESTIONS } from '../api/_lib/jeff-agent-nft-capabilities.mjs';
import {
  calibrateJeffAgentNftClassifier,
  trainJeffAgentNftClassifier,
} from '../api/_lib/jeff-agent-nft-learned-v0.5.mjs';

const root = new URL('../', import.meta.url);
const paths = Object.freeze({
  baseDataset: new URL('datasets/jeff-agent-nft/v0.5-evidence/seed.json', root),
  baseCheckpoint: new URL('models/jeff-agent-nft-nb-v0.5-evidence/checkpoint.json', root),
  stimuli: new URL('benchmarks/jeff/v2/jeff-v0.6-transfer-reliability.stimuli.json', root),
  labels: new URL('benchmarks/jeff/v2/jeff-v0.6-transfer-reliability.labels.json', root),
  predictions: new URL('benchmarks/jeff/v2/jeff-v0.6-transfer-reliability.predictions.json', root),
  dataset: new URL('datasets/jeff-agent-nft/v0.6-remediation/seed.json', root),
  checkpoint: new URL('models/jeff-agent-nft-nb-v0.6-remediation/checkpoint.json', root),
});

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const render = (value) => `${JSON.stringify(value, null, 2)}\n`;

const [baseText, checkpointText, stimuliText, labelsText, predictionsText] = await Promise.all([
  readFile(paths.baseDataset, 'utf8'),
  readFile(paths.baseCheckpoint, 'utf8'),
  readFile(paths.stimuli, 'utf8'),
  readFile(paths.labels, 'utf8'),
  readFile(paths.predictions, 'utf8'),
]);
const base = JSON.parse(baseText);
const baseCheckpoint = JSON.parse(checkpointText);
const stimuli = JSON.parse(stimuliText);
const labels = JSON.parse(labelsText);
const labelMap = new Map(labels.cases.map((entry) => [entry.id, entry]));

if (labels.independentlyLabeled !== true || labels.stimuliSha256 !== sha256(stimuliText)) {
  throw new Error('JEFF_V06_RETIRED_LABEL_BINDING_INVALID');
}
if (labels.predictionsSha256 !== sha256(predictionsText)) {
  throw new Error('JEFF_V06_RETIRED_PREDICTION_BINDING_INVALID');
}

const remediationSamples = stimuli.cases.map((entry) => {
  const label = labelMap.get(entry.id);
  if (!label) throw new Error(`JEFF_V06_RETIRED_LABEL_MISSING:${entry.id}`);
  return {
    id: `retired-transfer-v2-${entry.id}`,
    scenario: `retired-transfer-${entry.protocol}`,
    state: entry.state,
    answers: label.expected,
  };
});

const dataset = structuredClone(base);
dataset.version = '0.6-remediation';
dataset.labelSource = 'project-authored synthetic curriculum plus independently labeled retired v2 transfer benchmark';
dataset.controls = {
  ...dataset.controls,
  retiredTransferV2IncludedInTraining: true,
  retiredTransferV2NoLongerEvaluation: true,
  retiredTransferV2PredictionCommitmentVerified: true,
  freshBlindV3RequiredForPromotion: true,
};
dataset.retiredTransferV2 = {
  stimuliPath: 'benchmarks/jeff/v2/jeff-v0.6-transfer-reliability.stimuli.json',
  stimuliSha256: sha256(stimuliText),
  labelsPath: 'benchmarks/jeff/v2/jeff-v0.6-transfer-reliability.labels.json',
  labelsSha256: sha256(labelsText),
  predictionsPath: 'benchmarks/jeff/v2/jeff-v0.6-transfer-reliability.predictions.json',
  predictionsSha256: sha256(predictionsText),
  cases: remediationSamples.length,
  use: 'training-only-after-failed-reliability-gate',
};
dataset.splits.train = [...dataset.splits.train, ...remediationSamples];
const datasetRendered = render(dataset);

const weighted = [];
const weights = Object.freeze({ base: 2, protocol: 1, retired: 3, retiredTransferV2: 4 });
for (const sample of dataset.splits.train) {
  const weight = sample.id.startsWith('retired-transfer-v2-') ? weights.retiredTransferV2
    : sample.id.startsWith('retired-blind') ? weights.retired
      : sample.id.startsWith('protocol-') ? weights.protocol
        : weights.base;
  for (let index = 0; index < weight; index += 1) weighted.push(sample);
}

let checkpoint = trainJeffAgentNftClassifier(weighted, JEFF_AGENT_NFT_CAPABILITY_QUESTIONS, {
  featureVersion: 'semantic-v4',
});
checkpoint = calibrateJeffAgentNftClassifier(
  checkpoint,
  dataset.splits.validation,
  JEFF_AGENT_NFT_CAPABILITY_QUESTIONS,
  { maxMeanWrongConfidence: 0.5 },
);
checkpoint.model = 'jeff-agent-nft-nb-v0.6-remediation';
checkpoint.capabilitySurface = baseCheckpoint.capabilitySurface;
checkpoint.training = {
  datasetSha256: sha256(datasetRendered),
  samples: weighted.length,
  uniqueSamples: dataset.splits.train.length,
  weights,
  synthetic: true,
  promotionEvidence: false,
  nextIndependentGate: 'v3-transfer-reliability',
};
const checkpointRendered = render(checkpoint);

const verify = process.argv.includes('--verify');
if (verify) {
  const [existingDataset, existingCheckpoint] = await Promise.all([
    readFile(paths.dataset, 'utf8'),
    readFile(paths.checkpoint, 'utf8'),
  ]);
  if (existingDataset !== datasetRendered) throw new Error('JEFF_V06_DATASET_REPRODUCTION_MISMATCH');
  if (existingCheckpoint !== checkpointRendered) throw new Error('JEFF_V06_CHECKPOINT_REPRODUCTION_MISMATCH');
} else {
  await Promise.all([
    mkdir(new URL('./', paths.dataset), { recursive: true }),
    mkdir(new URL('./', paths.checkpoint), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(paths.dataset, datasetRendered, { encoding: 'utf8', flag: 'wx' }),
    writeFile(paths.checkpoint, checkpointRendered, { encoding: 'utf8', flag: 'wx' }),
  ]);
}

process.stdout.write(`${JSON.stringify({
  schema: 'jeff-agent-nft-v0.6-remediation-build-v1',
  model: checkpoint.model,
  uniqueSamples: dataset.splits.train.length,
  weightedSamples: weighted.length,
  retiredTransferCases: remediationSamples.length,
  datasetSha256: sha256(datasetRendered),
  checkpointSha256: sha256(checkpointRendered),
  verified: verify,
}, null, 2)}\n`);

if (process.argv[1] && resolve(process.argv[1]) !== fileURLToPath(import.meta.url)) process.exitCode = 1;
