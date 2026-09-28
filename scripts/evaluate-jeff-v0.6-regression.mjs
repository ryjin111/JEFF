import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { inferJeffAgentNftCandidateV06 } from '../api/_lib/jeff-agent-nft-candidate-v0.6.mjs';
import {
  JEFF_AGENT_NFT_CAPABILITY_QUESTIONS,
  JEFF_CAPABILITY_FAMILIES,
} from '../api/_lib/jeff-agent-nft-capabilities.mjs';

const paths = Object.freeze({
  dataset: new URL('../datasets/jeff-agent-nft/v0.6-remediation/seed.json', import.meta.url),
  sealedStimuli: new URL('../benchmarks/jeff/agent-nft-protocol-blind-v3.stimuli.json', import.meta.url),
  sealedLabels: new URL('../benchmarks/jeff/agent-nft-protocol-blind-v3.labels.json', import.meta.url),
  result: new URL('../benchmarks/jeff/v2/jeff-v0.6-regression.result.json', import.meta.url),
});
const agentNft = Object.freeze({
  chainId: 1,
  collection: '0x0000000000000000000000000000000000000001',
  tokenId: '1',
  account: '0x0000000000000000000000000000000000000002',
});

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
  let wrongConfidence = 0;
  let wrong = 0;
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
    const response = inferJeffAgentNftCandidateV06({ agentNft, state: sample.state, questions });
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

const [dataset, sealedStimuli, sealedLabels] = await Promise.all([
  readFile(paths.dataset, 'utf8').then(JSON.parse),
  readFile(paths.sealedStimuli, 'utf8').then(JSON.parse),
  readFile(paths.sealedLabels, 'utf8').then(JSON.parse),
]);
const sealedExpected = sealedLabels.labels;
const sealedRows = [];
const protocolRows = new Map();
for (const entry of sealedStimuli.cases) {
  const expected = sealedExpected[entry.id];
  const questions = Object.fromEntries(entry.tasks.map((task) => [task, JEFF_AGENT_NFT_CAPABILITY_QUESTIONS[task]]));
  const response = inferJeffAgentNftCandidateV06({ agentNft, state: entry.state, questions });
  for (const task of entry.tasks) {
    const actual = normalized(response.answers[task]);
    const row = {
      caseId: entry.id,
      task,
      expected: expected[task],
      actual,
      correct: JSON.stringify(actual) === JSON.stringify(expected[task]),
      confidence: confidence(response.answers[task]),
    };
    sealedRows.push(row);
    const rows = protocolRows.get(entry.protocol) ?? [];
    rows.push(row);
    protocolRows.set(entry.protocol, rows);
  }
}

const result = {
  schema: 'jeff-agent-nft-v0.6-regression-result-v1',
  model: 'jeff-agent-nft-nb-v0.6-remediation',
  promotionEvidence: false,
  internalValidation: evaluateSamples(dataset.splits.validation),
  internalTest: evaluateSamples(dataset.splits.test),
  historicalSealedV3: {
    ...metrics(sealedRows),
    byProtocol: Object.fromEntries([...protocolRows].sort(([left], [right]) => left.localeCompare(right)).map(([protocol, rows]) => [protocol, metrics(rows)])),
    failures: sealedRows.filter((row) => !row.correct).map(({ caseId, task, expected, actual }) => ({ caseId, task, expected, actual })),
  },
};
const rendered = `${JSON.stringify(result, null, 2)}\n`;
const verify = process.argv.includes('--verify');
if (verify) {
  const existing = await readFile(paths.result, 'utf8');
  if (existing !== rendered) throw new Error('JEFF_V06_REGRESSION_REPRODUCTION_MISMATCH');
} else {
  await writeFile(paths.result, rendered, { encoding: 'utf8', flag: 'wx' });
}
process.stdout.write(rendered);

if (process.argv[1] && resolve(process.argv[1]) !== fileURLToPath(import.meta.url)) process.exitCode = 1;
