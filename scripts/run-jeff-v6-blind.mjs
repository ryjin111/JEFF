import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { JEFF_AGENT_NFT_CAPABILITY_QUESTIONS } from '../api/_lib/jeff-agent-nft-capabilities.mjs';
import { inferJeffAgentNftCandidateV09, JEFF_V09_CANDIDATE } from '../api/_lib/jeff-agent-nft-candidate-v0.9.mjs';
import { validateJeffAgentNftResponse } from '../api/_lib/jeff-agent-nft-contract.mjs';
import { canonicalJeffBenchmarkJson } from '../api/_lib/jeff-benchmark-v2.mjs';

const stimuliPath = new URL('../benchmarks/jeff/v6/jeff-v0.9-canonical-reliability-v6.stimuli.json', import.meta.url);
const outputPath = new URL('../benchmarks/jeff/v6/jeff-v0.9-canonical-reliability-v6.predictions.json', import.meta.url);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const SEALED_CANDIDATE = Object.freeze({
  checkpointSha256: 'b76eef5169a34e18c30f09d51286bbcb5f265146e208d65843b9b3ab95efafda',
  datasetSha256: '8df1b56c600ca1586d430aa67f6d709c64cb13f7cf4e0d3009bda5d2d2a70930',
  runtimeSha256: 'f1113546b36f7213141ba76382a4d5773d02ab23c3e1110791fedd8218e35230',
});

for (const [name, expected] of Object.entries(SEALED_CANDIDATE)) {
  if (JEFF_V09_CANDIDATE.hashes[name] !== expected) throw new Error(`JEFF_V6_CANDIDATE_BINDING_MISMATCH:${name}`);
}

function perturbState(state, trial) {
  const neutral = {
    1: null,
    2: { rpc: { envelope: 'json-rpc-2.0', batch: false } },
    3: { ui: { locale: 'en-GB', density: 'standard' } },
    4: { trace: { sampled: false, parent: null } },
    5: { hints: { tags: [], note: '' } },
    6: { client: { name: 'blind-benchmark', build: 'v6' } },
    7: { correlation: { id: 'v6-neutral-correlation' } },
    8: { transport: { retry: 0, compressed: false } },
  }[trial];
  return neutral ? { ...state, benchmarkNeutral: neutral } : structuredClone(state);
}

function buildPredictions(stimuli, stimuliText) {
  const questions = Object.fromEntries(stimuli.questionIds.map((id) => {
    const definition = JEFF_AGENT_NFT_CAPABILITY_QUESTIONS[id];
    if (!definition) throw new Error(`JEFF_V6_QUESTION_UNKNOWN:${id}`);
    return [id, definition];
  }));
  const runs = [];
  for (const entry of stimuli.cases) {
    for (let trial = 1; trial <= stimuli.k; trial += 1) {
      const request = {
        agentNft: entry.agentNft,
        state: perturbState(entry.state, trial),
        questions,
      };
      const response = inferJeffAgentNftCandidateV09(request);
      runs.push({
        caseId: entry.id,
        trial,
        perturbationId: stimuli.perturbations[trial - 1],
        fixtureSha256: sha256(canonicalJeffBenchmarkJson(request)),
        schemaValid: validateJeffAgentNftResponse(response, request),
        response,
      });
    }
  }
  return {
    schema: 'jeff-agent-nft-v6-canonical-reliability-predictions-v1',
    version: stimuli.version,
    frozenAt: new Date().toISOString(),
    labelsAvailableAtFreeze: false,
    stimuliSha256: sha256(stimuliText),
    model: JEFF_V09_CANDIDATE.model,
    mode: JEFF_V09_CANDIDATE.mode,
    executionAuthorized: JEFF_V09_CANDIDATE.executionAuthorized,
    checkpointSha256: JEFF_V09_CANDIDATE.hashes.checkpointSha256,
    datasetSha256: JEFF_V09_CANDIDATE.hashes.datasetSha256,
    runtimeSha256: JEFF_V09_CANDIDATE.hashes.runtimeSha256,
    k: stimuli.k,
    questionIds: stimuli.questionIds,
    runs,
  };
}

const stimuliText = await readFile(stimuliPath, 'utf8');
const stimuli = JSON.parse(stimuliText);
if (stimuli.labelStatus !== 'withheld' || stimuli.predictionsMustFreezeBeforeLabels !== true) {
  throw new Error('JEFF_V6_STIMULI_NOT_LABEL_BLIND');
}
if (stimuli.cases.length !== 24 || stimuli.k !== 8 || stimuli.questionIds.length !== 8) {
  throw new Error('JEFF_V6_STIMULI_COVERAGE_INVALID');
}

const rendered = `${JSON.stringify(buildPredictions(stimuli, stimuliText), null, 2)}\n`;
const verify = process.argv.includes('--verify');

if (verify) {
  const existing = await readFile(outputPath, 'utf8');
  const parsed = JSON.parse(existing);
  const rebuilt = JSON.parse(rendered);
  rebuilt.frozenAt = parsed.frozenAt;
  const rebuiltText = `${JSON.stringify(rebuilt, null, 2)}\n`;
  if (existing !== rebuiltText) throw new Error('JEFF_V6_PREDICTION_REPRODUCTION_MISMATCH');
} else {
  await writeFile(outputPath, rendered, { encoding: 'utf8', flag: 'wx' });
}

const artifactText = verify ? await readFile(outputPath, 'utf8') : rendered;
const artifact = JSON.parse(artifactText);
process.stdout.write(`${JSON.stringify({
  schema: artifact.schema,
  model: artifact.model,
  cases: stimuli.cases.length,
  runs: artifact.runs.length,
  decisions: artifact.runs.length * artifact.questionIds.length,
  schemaValidRuns: artifact.runs.filter((entry) => entry.schemaValid).length,
  stimuliSha256: artifact.stimuliSha256,
  predictionsSha256: sha256(artifactText),
  verified: verify,
}, null, 2)}\n`);

if (process.argv[1] && resolve(process.argv[1]) !== fileURLToPath(import.meta.url)) process.exitCode = 1;
