import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { JEFF_AGENT_NFT_CAPABILITY_QUESTIONS } from '../api/_lib/jeff-agent-nft-capabilities.mjs';
import { validateJeffAgentNftResponse } from '../api/_lib/jeff-agent-nft-contract.mjs';
import { inferJeffAgentNftPromoted, JEFF_PROMOTED_MODEL } from '../api/_lib/jeff-agent-nft-promoted.mjs';
import { canonicalJeffBenchmarkJson } from '../api/_lib/jeff-benchmark-v2.mjs';

const stimuliPath = new URL('../benchmarks/jeff/v2/jeff-v0.6-transfer-reliability.stimuli.json', import.meta.url);
const outputPath = new URL('../benchmarks/jeff/v2/jeff-v0.6-transfer-reliability.predictions.json', import.meta.url);
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

function buildPredictions(stimuli, stimuliText) {
  const questions = Object.fromEntries(stimuli.questionIds.map((id) => {
    const definition = JEFF_AGENT_NFT_CAPABILITY_QUESTIONS[id];
    if (!definition) throw new Error(`JEFF_V2_QUESTION_UNKNOWN:${id}`);
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
      const response = inferJeffAgentNftPromoted(request);
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
    schema: 'jeff-agent-nft-v2-transfer-reliability-predictions-v1',
    version: stimuli.version,
    frozenAt: '2026-09-28T14:30:00.000Z',
    labelsAvailableAtFreeze: false,
    stimuliSha256: sha256(stimuliText),
    model: JEFF_PROMOTED_MODEL.model,
    mode: JEFF_PROMOTED_MODEL.mode,
    executionAuthorized: JEFF_PROMOTED_MODEL.executionAuthorized,
    checkpointSha256: JEFF_PROMOTED_MODEL.hashes.checkpointSha256,
    runtimeSha256: JEFF_PROMOTED_MODEL.hashes.runtimeSha256,
    k: stimuli.k,
    questionIds: stimuli.questionIds,
    runs,
  };
}

const stimuliText = await readFile(stimuliPath, 'utf8');
const stimuli = JSON.parse(stimuliText);
if (stimuli.labelStatus !== 'withheld' || stimuli.predictionsMustFreezeBeforeLabels !== true) {
  throw new Error('JEFF_V2_STIMULI_NOT_LABEL_BLIND');
}
const rendered = `${JSON.stringify(buildPredictions(stimuli, stimuliText), null, 2)}\n`;
const verify = process.argv.includes('--verify');

if (verify) {
  const existing = await readFile(outputPath, 'utf8');
  if (existing !== rendered) throw new Error('JEFF_V2_PREDICTION_REPRODUCTION_MISMATCH');
} else {
  await writeFile(outputPath, rendered, { encoding: 'utf8', flag: 'wx' });
}

const artifact = JSON.parse(rendered);
process.stdout.write(`${JSON.stringify({
  schema: artifact.schema,
  model: artifact.model,
  cases: stimuli.cases.length,
  runs: artifact.runs.length,
  decisions: artifact.runs.length * artifact.questionIds.length,
  schemaValidRuns: artifact.runs.filter((entry) => entry.schemaValid).length,
  stimuliSha256: artifact.stimuliSha256,
  predictionsSha256: sha256(rendered),
  verified: verify,
}, null, 2)}\n`);

if (process.argv[1] && resolve(process.argv[1]) !== fileURLToPath(import.meta.url)) process.exitCode = 1;
