import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  inferJeffAgentNftCandidateV06,
  JEFF_V06_CANDIDATE,
} from '../api/_lib/jeff-agent-nft-candidate-v0.6.mjs';
import { JEFF_AGENT_NFT_CAPABILITY_QUESTIONS } from '../api/_lib/jeff-agent-nft-capabilities.mjs';
import { validateJeffAgentNftResponse } from '../api/_lib/jeff-agent-nft-contract.mjs';
import {
  canonicalJeffBenchmarkJson,
  hashJeffBenchmarkManifest,
  scoreJeffAgentNftBenchmarkV2,
} from '../api/_lib/jeff-benchmark-v2.mjs';

const root = new URL('../benchmarks/jeff/v2/', import.meta.url);
const paths = Object.freeze({
  stimuli: new URL('jeff-v0.6-transfer-reliability.stimuli.json', root),
  labels: new URL('jeff-v0.6-transfer-reliability.labels.json', root),
  originalPredictions: new URL('jeff-v0.6-transfer-reliability.predictions.json', root),
  result: new URL('jeff-v0.6-remediation.result.json', root),
});
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function perturbState(state, trial) {
  const neutral = {
    1: null,
    2: { transport: { encoding: 'json', envelope: 'control-a' } },
    3: { transport: { encoding: 'json', envelope: 'control-b', retry: 0 } },
    4: { display: { locale: 'en-US', density: 'compact' } },
    5: { trace: { sampled: false, class: 'benchmark' } },
    6: { optional: { tags: [], note: '' } },
    7: { correlation: { id: 'neutral-correlation' } },
    8: { client: { name: 'benchmark-client', version: '1.0' } },
  }[trial];
  return neutral ? { ...state, benchmarkNeutral: neutral } : structuredClone(state);
}

function normalizedAnswer(answer) {
  if (answer?.type === 'choice') return answer.choice;
  if (answer?.type === 'noul') return answer.noul >= 0.5;
  if (answer?.type === 'score') return Math.round(answer.score);
  return undefined;
}

function slicedAccuracy(entries, runs, keyForEntry) {
  const buckets = {};
  const entryMap = new Map(entries.map((entry) => [entry.id, entry]));
  for (const run of runs) {
    const entry = entryMap.get(run.caseId);
    const bucketName = keyForEntry(entry);
    buckets[bucketName] ??= { correct: 0, decisions: 0 };
    for (const [task, expected] of Object.entries(entry.expected)) {
      const actual = normalizedAnswer(run.response.answers[task]);
      buckets[bucketName].correct += Number(canonicalJeffBenchmarkJson(actual) === canonicalJeffBenchmarkJson(expected));
      buckets[bucketName].decisions += 1;
    }
  }
  return Object.fromEntries(Object.entries(buckets).sort(([left], [right]) => left.localeCompare(right)).map(([name, bucket]) => [
    name,
    { ...bucket, accuracy: Number((bucket.correct / bucket.decisions).toFixed(6)) },
  ]));
}

const [stimuliText, labelsText, originalPredictionsText] = await Promise.all([
  readFile(paths.stimuli, 'utf8'),
  readFile(paths.labels, 'utf8'),
  readFile(paths.originalPredictions, 'utf8'),
]);
const stimuli = JSON.parse(stimuliText);
const labels = JSON.parse(labelsText);
const labelsById = new Map(labels.cases.map((entry) => [entry.id, entry]));
const questions = Object.fromEntries(stimuli.questionIds.map((id) => [id, JEFF_AGENT_NFT_CAPABILITY_QUESTIONS[id]]));
const cases = stimuli.cases.map((entry) => {
  const label = labelsById.get(entry.id);
  return {
    id: entry.id,
    protocol: entry.protocol,
    expected: label.expected,
    forbidden: label.forbidden,
    privateMarkers: entry.privateMarkers,
    transfer: entry.transfer,
  };
});
const runs = [];
for (const entry of stimuli.cases) {
  for (let trial = 1; trial <= stimuli.k; trial += 1) {
    const request = {
      agentNft: entry.agentNft,
      state: perturbState(entry.state, trial),
      questions,
    };
    const response = inferJeffAgentNftCandidateV06(request);
    runs.push({
      caseId: entry.id,
      trial,
      fixtureSha256: sha256(canonicalJeffBenchmarkJson(request)),
      schemaValid: validateJeffAgentNftResponse(response, request),
      response,
    });
  }
}

const score = scoreJeffAgentNftBenchmarkV2({ cases, runs, k: stimuli.k });
const headEntries = stimuli.questionIds.map((task) => ({
  id: task,
  expected: Object.fromEntries(cases.map((entry) => [entry.id, entry.expected[task]])),
}));
const byHead = {};
for (const task of stimuli.questionIds) {
  let correct = 0;
  let decisions = 0;
  for (const run of runs) {
    const expected = labelsById.get(run.caseId).expected[task];
    correct += Number(canonicalJeffBenchmarkJson(normalizedAnswer(run.response.answers[task])) === canonicalJeffBenchmarkJson(expected));
    decisions += 1;
  }
  byHead[task] = { correct, decisions, accuracy: Number((correct / decisions).toFixed(6)) };
}
void headEntries;

const manifest = {
  schema: 'jeff-agent-nft-v0.6-remediation-result-v1',
  version: '0.6.0-remediation',
  model: JEFF_V06_CANDIDATE.model,
  mode: JEFF_V06_CANDIDATE.mode,
  executionAuthorized: JEFF_V06_CANDIDATE.executionAuthorized,
  evaluationStatus: 'retired-training-only',
  promotionEvidence: false,
  nextIndependentGate: 'v3-transfer-reliability',
  originalStimuliSha256: sha256(stimuliText),
  originalLabelsSha256: sha256(labelsText),
  originalPredictionsSha256: sha256(originalPredictionsText),
  candidateHashes: JEFF_V06_CANDIDATE.hashes,
  score,
  byHead,
  byProtocol: slicedAccuracy(cases, runs, (entry) => entry.protocol),
};
const result = { ...manifest, manifestSha256: hashJeffBenchmarkManifest(manifest) };
const rendered = `${JSON.stringify(result, null, 2)}\n`;
const verify = process.argv.includes('--verify');
if (verify) {
  const existing = await readFile(paths.result, 'utf8');
  if (existing !== rendered) throw new Error('JEFF_V06_REMEDIATION_SCORE_REPRODUCTION_MISMATCH');
} else {
  await writeFile(paths.result, rendered, { encoding: 'utf8', flag: 'wx' });
}
process.stdout.write(rendered);

if (process.argv[1] && resolve(process.argv[1]) !== fileURLToPath(import.meta.url)) process.exitCode = 1;
