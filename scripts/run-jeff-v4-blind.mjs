import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { JEFF_AGENT_NFT_CAPABILITY_QUESTIONS } from '../api/_lib/jeff-agent-nft-capabilities.mjs';
import { inferJeffAgentNftCandidateV07, JEFF_V07_CANDIDATE } from '../api/_lib/jeff-agent-nft-candidate-v0.7.mjs';
import { validateJeffAgentNftResponse } from '../api/_lib/jeff-agent-nft-contract.mjs';
import { canonicalJeffBenchmarkJson } from '../api/_lib/jeff-benchmark-v2.mjs';

const stimuliPath = new URL('../benchmarks/jeff/v4/jeff-v0.7-transfer-reliability-v4.stimuli.json', import.meta.url);
const outputPath = new URL('../benchmarks/jeff/v4/jeff-v0.7-transfer-reliability-v4.predictions.json', import.meta.url);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function perturbState(state, trial) {
  const neutral = {
    1: null,
    2: { rpc: { envelope: 'json-rpc-2.0', batch: false } },
    3: { ui: { locale: 'en-GB', density: 'standard' } },
    4: { trace: { sampled: false, parent: null } },
    5: { hints: { tags: [], note: '' } },
    6: { client: { name: 'blind-benchmark', build: 'v4' } },
    7: { correlation: { id: 'v4-neutral-correlation' } },
    8: { transport: { retry: 0, compressed: false } },
  }[trial];
  return neutral ? { ...state, benchmarkNeutral: neutral } : structuredClone(state);
}

function buildPredictions(stimuli, stimuliText) {
  const questions = Object.fromEntries(stimuli.questionIds.map((id) => {
    const definition = JEFF_AGENT_NFT_CAPABILITY_QUESTIONS[id];
    if (!definition) throw new Error(`JEFF_V4_QUESTION_UNKNOWN:${id}`);
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
      const response = inferJeffAgentNftCandidateV07(request);
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
    schema: 'jeff-agent-nft-v4-transfer-reliability-predictions-v1',
    version: stimuli.version,
    frozenAt: new Date().toISOString(),
    labelsAvailableAtFreeze: false,
    stimuliSha256: sha256(stimuliText),
    model: JEFF_V07_CANDIDATE.model,
    mode: JEFF_V07_CANDIDATE.mode,
    executionAuthorized: JEFF_V07_CANDIDATE.executionAuthorized,
    checkpointSha256: JEFF_V07_CANDIDATE.hashes.checkpointSha256,
    datasetSha256: JEFF_V07_CANDIDATE.hashes.datasetSha256,
    runtimeSha256: JEFF_V07_CANDIDATE.hashes.runtimeSha256,
    k: stimuli.k,
    questionIds: stimuli.questionIds,
    runs,
  };
}

const stimuliText = await readFile(stimuliPath, 'utf8');
const stimuli = JSON.parse(stimuliText);
if (stimuli.labelStatus !== 'withheld' || stimuli.predictionsMustFreezeBeforeLabels !== true) {
  throw new Error('JEFF_V4_STIMULI_NOT_LABEL_BLIND');
}
if (stimuli.cases.length !== 24 || stimuli.k !== 8 || stimuli.questionIds.length !== 8) {
  throw new Error('JEFF_V4_STIMULI_COVERAGE_INVALID');
}

const rendered = `${JSON.stringify(buildPredictions(stimuli, stimuliText), null, 2)}\n`;
const verify = process.argv.includes('--verify');

if (verify) {
  const existing = await readFile(outputPath, 'utf8');
  const parsed = JSON.parse(existing);
  const rebuilt = JSON.parse(rendered);
  rebuilt.frozenAt = parsed.frozenAt;
  const rebuiltText = `${JSON.stringify(rebuilt, null, 2)}\n`;
  if (existing !== rebuiltText) throw new Error('JEFF_V4_PREDICTION_REPRODUCTION_MISMATCH');
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
