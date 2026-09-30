import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  inferJeffAgentNftCandidateV07,
  JEFF_V07_CANDIDATE,
} from '../api/_lib/jeff-agent-nft-candidate-v0.7.mjs';
import {
  JEFF_AGENT_NFT_CAPABILITY_QUESTIONS,
  JEFF_CAPABILITY_FAMILIES,
} from '../api/_lib/jeff-agent-nft-capabilities.mjs';
import { validateJeffAgentNftResponse } from '../api/_lib/jeff-agent-nft-contract.mjs';
import { scoreJeffAgentNftBenchmarkV2 } from '../api/_lib/jeff-benchmark-v2.mjs';

const root = new URL('../', import.meta.url);
const paths = Object.freeze({
  dataset: new URL('datasets/jeff-agent-nft/v0.7-remediation/seed.json', root),
  v2Stimuli: new URL('benchmarks/jeff/v2/jeff-v0.6-transfer-reliability.stimuli.json', root),
  v2Labels: new URL('benchmarks/jeff/v2/jeff-v0.6-transfer-reliability.labels.json', root),
  v3Stimuli: new URL('benchmarks/jeff/v3/jeff-v0.6-transfer-reliability-v3.stimuli.json', root),
  v3Labels: new URL('benchmarks/jeff/v3/jeff-v0.6-transfer-reliability-v3.labels.json', root),
  historicalStimuli: new URL('benchmarks/jeff/agent-nft-protocol-blind-v3.stimuli.json', root),
  historicalLabels: new URL('benchmarks/jeff/agent-nft-protocol-blind-v3.labels.json', root),
  result: new URL('benchmarks/jeff/v3/jeff-v0.7-remediation.result.json', root),
});
const agentNft = Object.freeze({
  chainId: 1,
  collection: '0x0000000000000000000000000000000000000001',
  tokenId: '1',
  account: '0x0000000000000000000000000000000000000002',
});
const neutralPerturbations = [
  null,
  { transport: { encoding: 'json', envelope: 'control-a' } },
  { transport: { encoding: 'json', envelope: 'control-b', retry: 0 } },
  { display: { locale: 'en-US', density: 'compact' } },
  { trace: { sampled: false, class: 'benchmark' } },
  { optional: { tags: [], note: '' } },
  { correlation: { id: 'neutral-correlation' } },
  { client: { name: 'benchmark-client', version: '1.0' } },
];

function normalized(answer) {
  if (answer?.type === 'choice') return answer.choice;
  if (answer?.type === 'noul') return answer.noul >= 0.5;
  if (answer?.type === 'score') return Math.round(answer.score);
  return undefined;
}

function confidence(answer) {
  if (answer?.type === 'choice' || answer?.type === 'score') return answer.confidence;
  if (answer?.type === 'noul') return Math.max(answer.noul, 1 - answer.noul);
  return undefined;
}

function metrics(rows) {
  const byTask = {};
  let correct = 0;
  let wrong = 0;
  let wrongConfidence = 0;
  for (const row of rows) {
    byTask[row.task] ??= { correct: 0, decisions: 0 };
    byTask[row.task].decisions += 1;
    if (row.correct) {
      correct += 1;
      byTask[row.task].correct += 1;
    } else {
      wrong += 1;
      wrongConfidence += row.confidence;
    }
  }
  for (const bucket of Object.values(byTask)) bucket.accuracy = Number((bucket.correct / bucket.decisions).toFixed(6));
  const familyByTask = new Map(JEFF_CAPABILITY_FAMILIES.flatMap((family) => family.tasks.map((task) => [task, family.id])));
  const byFamily = {};
  for (const row of rows) {
    const family = familyByTask.get(row.task);
    byFamily[family] ??= { correct: 0, decisions: 0 };
    byFamily[family].correct += Number(row.correct);
    byFamily[family].decisions += 1;
  }
  for (const bucket of Object.values(byFamily)) bucket.accuracy = Number((bucket.correct / bucket.decisions).toFixed(6));
  return {
    decisions: rows.length,
    correct,
    accuracy: Number((correct / rows.length).toFixed(6)),
    wrong,
    meanWrongConfidence: wrong ? Number((wrongConfidence / wrong).toFixed(6)) : null,
    byTask,
    byFamily,
  };
}

function evaluateSamples(samples) {
  const rows = [];
  for (const sample of samples) {
    const tasks = Object.keys(sample.answers);
    const questions = Object.fromEntries(tasks.map((task) => [task, JEFF_AGENT_NFT_CAPABILITY_QUESTIONS[task]]));
    const response = inferJeffAgentNftCandidateV07({ agentNft, state: sample.state, questions });
    for (const task of tasks) {
      const actual = normalized(response.answers[task]);
      rows.push({
        caseId: sample.id,
        task,
        expected: sample.answers[task],
        actual,
        correct: JSON.stringify(actual) === JSON.stringify(sample.answers[task]),
        confidence: confidence(response.answers[task]),
      });
    }
  }
  return metrics(rows);
}

function evaluateRetiredPack(stimuli, labels) {
  const labelsById = new Map(labels.cases.map((entry) => [entry.id, entry]));
  const questions = Object.fromEntries(stimuli.questionIds.map((id) => [id, JEFF_AGENT_NFT_CAPABILITY_QUESTIONS[id]]));
  const cases = stimuli.cases.map((entry) => ({
    id: entry.id,
    protocol: entry.protocol,
    expected: labelsById.get(entry.id).expected,
    forbidden: labelsById.get(entry.id).forbidden,
    privateMarkers: entry.privateMarkers,
    transfer: entry.transfer,
  }));
  const runs = [];
  for (const entry of stimuli.cases) {
    for (let index = 0; index < neutralPerturbations.length; index += 1) {
      const perturbation = neutralPerturbations[index];
      const state = perturbation ? { ...entry.state, benchmarkNeutral: perturbation } : structuredClone(entry.state);
      const request = { agentNft: entry.agentNft, state, questions };
      const response = inferJeffAgentNftCandidateV07(request);
      runs.push({
        caseId: entry.id,
        trial: index + 1,
        schemaValid: validateJeffAgentNftResponse(response, request),
        response,
      });
    }
  }
  return scoreJeffAgentNftBenchmarkV2({ cases, runs, k: neutralPerturbations.length });
}

const [dataset, v2Stimuli, v2Labels, v3Stimuli, v3Labels, historicalStimuli, historicalLabels] = await Promise.all([
  readFile(paths.dataset, 'utf8').then(JSON.parse),
  readFile(paths.v2Stimuli, 'utf8').then(JSON.parse),
  readFile(paths.v2Labels, 'utf8').then(JSON.parse),
  readFile(paths.v3Stimuli, 'utf8').then(JSON.parse),
  readFile(paths.v3Labels, 'utf8').then(JSON.parse),
  readFile(paths.historicalStimuli, 'utf8').then(JSON.parse),
  readFile(paths.historicalLabels, 'utf8').then(JSON.parse),
]);

const historicalRows = [];
for (const entry of historicalStimuli.cases) {
  const expected = historicalLabels.labels[entry.id];
  const questions = Object.fromEntries(entry.tasks.map((task) => [task, JEFF_AGENT_NFT_CAPABILITY_QUESTIONS[task]]));
  const response = inferJeffAgentNftCandidateV07({ agentNft, state: entry.state, questions });
  for (const task of entry.tasks) {
    const actual = normalized(response.answers[task]);
    historicalRows.push({
      caseId: entry.id,
      task,
      expected: expected[task],
      actual,
      correct: JSON.stringify(actual) === JSON.stringify(expected[task]),
      confidence: confidence(response.answers[task]),
    });
  }
}

const result = {
  schema: 'jeff-agent-nft-v0.7-remediation-result-v1',
  model: JEFF_V07_CANDIDATE.model,
  mode: JEFF_V07_CANDIDATE.mode,
  executionAuthorized: JEFF_V07_CANDIDATE.executionAuthorized,
  promotionEvidence: false,
  evaluationStatus: 'retired-training-only',
  nextIndependentGate: 'v4-transfer-reliability',
  candidateHashes: JEFF_V07_CANDIDATE.hashes,
  retiredTransferV2: evaluateRetiredPack(v2Stimuli, v2Labels),
  retiredTransferV3: evaluateRetiredPack(v3Stimuli, v3Labels),
  internalValidation: evaluateSamples(dataset.splits.validation),
  internalTest: evaluateSamples(dataset.splits.test),
  historicalSealedV3: {
    ...metrics(historicalRows),
    failures: historicalRows.filter((row) => !row.correct).map(({ caseId, task, expected, actual }) => ({
      caseId,
      task,
      expected,
      actual,
    })),
  },
};
const rendered = `${JSON.stringify(result, null, 2)}\n`;
const verify = process.argv.includes('--verify');
if (verify) {
  const existing = await readFile(paths.result, 'utf8');
  if (existing !== rendered) throw new Error('JEFF_V07_REMEDIATION_REPRODUCTION_MISMATCH');
} else {
  await writeFile(paths.result, rendered, { encoding: 'utf8', flag: 'wx' });
}
process.stdout.write(rendered);

if (process.argv[1] && resolve(process.argv[1]) !== fileURLToPath(import.meta.url)) process.exitCode = 1;
