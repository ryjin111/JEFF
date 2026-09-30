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
  v2Stimuli: new URL('benchmarks/jeff/v2/jeff-v0.6-transfer-reliability.stimuli.json', root),
  v2Labels: new URL('benchmarks/jeff/v2/jeff-v0.6-transfer-reliability.labels.json', root),
  v2Predictions: new URL('benchmarks/jeff/v2/jeff-v0.6-transfer-reliability.predictions.json', root),
  v3Stimuli: new URL('benchmarks/jeff/v3/jeff-v0.6-transfer-reliability-v3.stimuli.json', root),
  v3Labels: new URL('benchmarks/jeff/v3/jeff-v0.6-transfer-reliability-v3.labels.json', root),
  v3Predictions: new URL('benchmarks/jeff/v3/jeff-v0.6-transfer-reliability-v3.predictions.json', root),
  v3Result: new URL('benchmarks/jeff/v3/jeff-v0.6-transfer-reliability-v3.result.json', root),
  v4Stimuli: new URL('benchmarks/jeff/v4/jeff-v0.7-transfer-reliability-v4.stimuli.json', root),
  v4Labels: new URL('benchmarks/jeff/v4/jeff-v0.7-transfer-reliability-v4.labels.json', root),
  v4Predictions: new URL('benchmarks/jeff/v4/jeff-v0.7-transfer-reliability-v4.predictions.json', root),
  v4Result: new URL('benchmarks/jeff/v4/jeff-v0.7-transfer-reliability-v4.result.json', root),
  dataset: new URL('datasets/jeff-agent-nft/v0.8-remediation/seed.json', root),
  checkpoint: new URL('models/jeff-agent-nft-nb-v0.8-remediation/checkpoint.json', root),
});

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const render = (value) => `${JSON.stringify(value, null, 2)}\n`;

const [
  baseText,
  checkpointText,
  v2StimuliText,
  v2LabelsText,
  v2PredictionsText,
  v3StimuliText,
  v3LabelsText,
  v3PredictionsText,
  v3ResultText,
  v4StimuliText,
  v4LabelsText,
  v4PredictionsText,
  v4ResultText,
] = await Promise.all([
  readFile(paths.baseDataset, 'utf8'),
  readFile(paths.baseCheckpoint, 'utf8'),
  readFile(paths.v2Stimuli, 'utf8'),
  readFile(paths.v2Labels, 'utf8'),
  readFile(paths.v2Predictions, 'utf8'),
  readFile(paths.v3Stimuli, 'utf8'),
  readFile(paths.v3Labels, 'utf8'),
  readFile(paths.v3Predictions, 'utf8'),
  readFile(paths.v3Result, 'utf8'),
  readFile(paths.v4Stimuli, 'utf8'),
  readFile(paths.v4Labels, 'utf8'),
  readFile(paths.v4Predictions, 'utf8'),
  readFile(paths.v4Result, 'utf8'),
]);

const base = JSON.parse(baseText);
const baseCheckpoint = JSON.parse(checkpointText);

function retiredPack(name, stimuliText, labelsText, predictionsText, resultText = null) {
  const stimuli = JSON.parse(stimuliText);
  const labels = JSON.parse(labelsText);
  if (labels.independentlyLabeled !== true || labels.stimuliSha256 !== sha256(stimuliText)) {
    throw new Error(`JEFF_V08_${name}_LABEL_BINDING_INVALID`);
  }
  if (labels.predictionsSha256 !== sha256(predictionsText)) {
    throw new Error(`JEFF_V08_${name}_PREDICTION_BINDING_INVALID`);
  }
  if (resultText) {
    const result = JSON.parse(resultText);
    if (result.promotion?.qualified !== false
      || result.score?.tracks?.safety?.violations <= 0
      || result.stimuliSha256 !== sha256(stimuliText)
      || result.labelsSha256 !== sha256(labelsText)
      || result.predictionsSha256 !== sha256(predictionsText)) {
      throw new Error(`JEFF_V08_${name}_FAILURE_RECEIPT_INVALID`);
    }
  }
  const labelMap = new Map(labels.cases.map((entry) => [entry.id, entry]));
  const samples = stimuli.cases.map((entry) => {
    const label = labelMap.get(entry.id);
    if (!label) throw new Error(`JEFF_V08_${name}_LABEL_MISSING:${entry.id}`);
    return {
      id: `retired-${name.toLowerCase()}-${entry.id}`,
      scenario: `retired-${name.toLowerCase()}-${entry.protocol}`,
      state: entry.state,
      answers: label.expected,
    };
  });
  return {
    samples,
    receipt: {
      id: name.toLowerCase(),
      stimuliSha256: sha256(stimuliText),
      labelsSha256: sha256(labelsText),
      predictionsSha256: sha256(predictionsText),
      ...(resultText ? { resultSha256: sha256(resultText) } : {}),
      cases: samples.length,
    },
  };
}

const v2 = retiredPack('V2', v2StimuliText, v2LabelsText, v2PredictionsText);
const v3 = retiredPack('V3', v3StimuliText, v3LabelsText, v3PredictionsText, v3ResultText);
const v4 = retiredPack('V4', v4StimuliText, v4LabelsText, v4PredictionsText, v4ResultText);

const dataset = structuredClone(base);
dataset.version = '0.8-remediation';
dataset.labelSource = 'project-authored synthetic curriculum plus independently labeled retired v2, v3, and v4 transfer benchmarks';
dataset.controls = {
  ...dataset.controls,
  retiredTransferV2IncludedInTraining: true,
  retiredTransferV3IncludedInTraining: true,
  retiredTransferV4IncludedInTraining: true,
  retiredTransferPacksNoLongerEvaluation: true,
  retiredPredictionCommitmentsVerified: true,
  freshBlindV5RequiredForPromotion: true,
};
dataset.retiredTransferPacks = [v2.receipt, v3.receipt, v4.receipt];
dataset.splits.train = [
  ...dataset.splits.train,
  ...v2.samples,
  ...v3.samples,
  ...v4.samples,
];
const datasetRendered = render(dataset);

const weights = Object.freeze({ base: 3, protocol: 1, retiredBlind: 4, retiredV2: 4, retiredV3: 1, retiredV4: 1 });
const weighted = [];
for (const sample of dataset.splits.train) {
  const weight = sample.id.startsWith('retired-v4-') ? weights.retiredV4
    : sample.id.startsWith('retired-v3-') ? weights.retiredV3
      : sample.id.startsWith('retired-v2-') ? weights.retiredV2
        : sample.id.startsWith('retired-blind') ? weights.retiredBlind
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
checkpoint.model = 'jeff-agent-nft-nb-v0.8-remediation';
checkpoint.capabilitySurface = baseCheckpoint.capabilitySurface;
checkpoint.training = {
  datasetSha256: sha256(datasetRendered),
  samples: weighted.length,
  uniqueSamples: dataset.splits.train.length,
  weights,
  synthetic: true,
  promotionEvidence: false,
  nextIndependentGate: 'v5-transfer-reliability',
};
const checkpointRendered = render(checkpoint);

const verify = process.argv.includes('--verify');
if (verify) {
  const [existingDataset, existingCheckpoint] = await Promise.all([
    readFile(paths.dataset, 'utf8'),
    readFile(paths.checkpoint, 'utf8'),
  ]);
  if (existingDataset !== datasetRendered) throw new Error('JEFF_V08_DATASET_REPRODUCTION_MISMATCH');
  if (existingCheckpoint !== checkpointRendered) throw new Error('JEFF_V08_CHECKPOINT_REPRODUCTION_MISMATCH');
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
  schema: 'jeff-agent-nft-v0.8-remediation-build-v1',
  model: checkpoint.model,
  uniqueSamples: dataset.splits.train.length,
  weightedSamples: weighted.length,
  retiredTransferCases: v2.samples.length + v3.samples.length + v4.samples.length,
  datasetSha256: sha256(datasetRendered),
  checkpointSha256: sha256(checkpointRendered),
  verified: verify,
}, null, 2)}\n`);

if (process.argv[1] && resolve(process.argv[1]) !== fileURLToPath(import.meta.url)) process.exitCode = 1;
