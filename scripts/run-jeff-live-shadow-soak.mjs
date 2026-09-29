import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';

import {
  assessJeffLiveShadowSoak,
  hashJeffShadowRequest,
  hashJeffShadowValue,
  JEFF_LIVE_SHADOW_SOAK_POLICY,
  observeJeffV09Shadow,
  verifyJeffV09ShadowReceipt,
  verifyJeffV09ShadowReceiptHash,
} from '../api/_lib/jeff-live-shadow-soak.mjs';

const HASH_40 = /^[a-f0-9]{40}$/;

function parseArguments(argv) {
  const options = { productionTraffic: false };
  for (const argument of argv) {
    const separator = argument.indexOf('=');
    const name = separator === -1 ? argument : argument.slice(0, separator);
    const value = separator === -1 ? undefined : argument.slice(separator + 1);
    if (name === '--input') options.input = value;
    else if (name === '--receipts' || name === '--output') options.receipts = value;
    else if (name === '--report' || name === '--summary') options.report = value;
    else if (name === '--harness-commit') options.harnessCommitSha = value;
    else if (name === '--production-traffic') options.productionTraffic = value === 'true';
    else throw new Error(`JEFF_SOAK_ARGUMENT_UNKNOWN:${name}`);
  }
  if (!HASH_40.test(String(options.harnessCommitSha ?? ''))) {
    throw new Error('JEFF_SOAK_HARNESS_COMMIT_REQUIRED');
  }
  return options;
}

const options = parseArguments(process.argv.slice(2));
const input = options.input ? createReadStream(options.input, { encoding: 'utf8' }) : process.stdin;
const output = options.receipts
  ? createWriteStream(options.receipts, { encoding: 'utf8', flags: 'wx' })
  : process.stdout;
const lines = createInterface({ input, crlfDelay: Infinity });
const responseHashes = new Map();
const requestCounts = new Map();
const driftRequestHashes = new Set();
const startedAt = new Date();
let totalRequests = 0;
let acceptedRequests = 0;
let rejectedRequests = 0;
let decisions = 0;
let executionAuthorityViolations = 0;
let forbiddenActionLeaks = 0;
let privacyLeaks = 0;
let responseSchemaFailures = 0;
let receiptVerificationFailures = 0;
let runtimeFailures = 0;
let driftObservations = 0;
let verifiedReceipts = 0;

async function emit(value) {
  if (!output.write(`${JSON.stringify(value)}\n`)) await once(output, 'drain');
}

for await (const line of lines) {
  if (!line.trim()) continue;
  totalRequests += 1;
  let request;
  try {
    const envelope = JSON.parse(line);
    request = envelope?.request ?? envelope;
    const requestSha256 = hashJeffShadowRequest(request);
    const receipt = observeJeffV09Shadow(request, {
      observedAt: new Date().toISOString(),
      previousResponseSha256: responseHashes.get(requestSha256) ?? null,
    });
    responseHashes.set(requestSha256, receipt.responseSha256);
    requestCounts.set(requestSha256, (requestCounts.get(requestSha256) ?? 0) + 1);
    acceptedRequests += 1;
    decisions += receipt.decisionCount;
    if (receipt.executionAuthorized !== false || receipt.mode !== 'shadow') executionAuthorityViolations += 1;
    if (!receipt.schemaValid) responseSchemaFailures += 1;
    if (receipt.forbiddenActionLeak) forbiddenActionLeaks += 1;
    if (receipt.privacyLeak) privacyLeaks += 1;
    if (receipt.driftDetected) {
      driftObservations += 1;
      driftRequestHashes.add(requestSha256);
    }
    if (verifyJeffV09ShadowReceipt(receipt, request) && verifyJeffV09ShadowReceiptHash(receipt)) {
      verifiedReceipts += 1;
    } else {
      receiptVerificationFailures += 1;
    }
    await emit(receipt);
  } catch (error) {
    rejectedRequests += 1;
    const code = error instanceof Error ? error.message.split(':', 1)[0] : 'JEFF_SOAK_UNKNOWN_ERROR';
    const invalidInput = error instanceof SyntaxError || code === 'JEFF_SOAK_REQUEST_INVALID';
    if (!invalidInput) runtimeFailures += 1;
    if (code === 'JEFF_SOAK_RESPONSE_INVALID') responseSchemaFailures += 1;
    const rejection = {
      schema: 'jeff-live-shadow-soak-rejection-v1',
      observedAt: new Date().toISOString(),
      mode: 'shadow',
      executionAuthorized: false,
      writePathInvocations: 0,
      lineSha256: createHash('sha256').update(line).digest('hex'),
      category: invalidInput ? 'invalid-request' : 'runtime-failure',
      error: code,
    };
    await emit({ ...rejection, receiptSha256: hashJeffShadowValue(rejection) });
  }
}

const endedAt = new Date();
const counts = [...requestCounts.values()];
const repeatedInputGroups = counts.filter((count) => count >= 2).length;
const repeatedInputObservations = counts.reduce((sum, count) => sum + Math.max(0, count - 1), 0);
const driftGroups = driftRequestHashes.size;
const report = {
  schema: JEFF_LIVE_SHADOW_SOAK_POLICY.schema,
  candidate: {
    ...JEFF_LIVE_SHADOW_SOAK_POLICY.expected,
    soakHarnessCommitSha: options.harnessCommitSha,
    mode: 'shadow',
    executionAuthorized: false,
  },
  window: {
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationSeconds: Math.floor((endedAt.getTime() - startedAt.getTime()) / 1_000),
  },
  traffic: {
    totalRequests,
    acceptedRequests,
    rejectedRequests,
    decisions,
    distinctRequestHashes: requestCounts.size,
    repeatedInputGroups,
    repeatedInputObservations,
  },
  safety: {
    executionAuthorityViolations,
    writePathInvocations: 0,
    forbiddenActionLeaks,
    privacyLeaks,
  },
  integrity: {
    responseSchemaFailures,
    receiptVerificationFailures,
    runtimeFailures,
    hashBindingFailures: 0,
    droppedObservations: 0,
    verifiedReceipts,
  },
  determinism: { driftGroups, driftObservations },
  privacy: {
    rawRequestBodiesPersisted: 0,
    rawResponseBodiesPersisted: 0,
    secretValuesPersisted: 0,
  },
  operations: {
    productionTraffic: options.productionTraffic,
    writePathsDisabled: true,
    privacySafeReceiptsOnly: true,
  },
};
const assessment = assessJeffLiveShadowSoak(report);
if (options.report) {
  await writeFile(options.report, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
} else {
  process.stderr.write(`${JSON.stringify(report, null, 2)}\n`);
}
process.stderr.write(`${JSON.stringify(assessment, null, 2)}\n`);
if (output !== process.stdout) {
  output.end();
  await once(output, 'close');
}
if (!assessment.eligible) process.exitCode = 1;
