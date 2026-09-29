import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';

import {
  assessJeffShadowSoakSummary,
  hashJeffShadowRequest,
  JEFF_LIVE_SHADOW_SOAK,
  observeJeffV09Shadow,
  verifyJeffV09ShadowReceipt,
} from '../api/_lib/jeff-live-shadow-soak.mjs';

function parseArguments(argv) {
  const options = { minimumHours: 24, minimumSamples: 1 };
  for (const argument of argv) {
    const separator = argument.indexOf('=');
    const name = separator === -1 ? argument : argument.slice(0, separator);
    const value = separator === -1 ? undefined : argument.slice(separator + 1);
    if (name === '--input') options.input = value;
    else if (name === '--output') options.output = value;
    else if (name === '--summary') options.summary = value;
    else if (name === '--min-hours') options.minimumHours = Number(value);
    else if (name === '--min-samples') options.minimumSamples = Number(value);
    else throw new Error(`JEFF_SOAK_ARGUMENT_UNKNOWN:${name}`);
  }
  if (!Number.isFinite(options.minimumHours) || options.minimumHours < 0) throw new Error('JEFF_SOAK_MINIMUM_HOURS_INVALID');
  if (!Number.isInteger(options.minimumSamples) || options.minimumSamples < 1) throw new Error('JEFF_SOAK_MINIMUM_SAMPLES_INVALID');
  return options;
}

const options = parseArguments(process.argv.slice(2));
const input = options.input ? createReadStream(options.input, { encoding: 'utf8' }) : process.stdin;
const output = options.output ? createWriteStream(options.output, { encoding: 'utf8', flags: 'wx' }) : process.stdout;
const lines = createInterface({ input, crlfDelay: Infinity });
const decisions = new Map();
const startedAt = new Date();
let totalSamples = 0;
let validSamples = 0;
let invalidSamples = 0;
let authorityBreaches = 0;
let receiptFailures = 0;
let driftFailures = 0;

function emit(value) {
  output.write(`${JSON.stringify(value)}\n`);
}

for await (const line of lines) {
  if (!line.trim()) continue;
  totalSamples += 1;
  try {
    const envelope = JSON.parse(line);
    const request = envelope?.request ?? envelope;
    const requestSha256 = hashJeffShadowRequest(request);
    const receipt = observeJeffV09Shadow(request, {
      observedAt: new Date().toISOString(),
      previousResponseSha256: decisions.get(requestSha256) ?? null,
    });
    decisions.set(requestSha256, receipt.responseSha256);
    validSamples += 1;
    if (receipt.executionAuthorized !== false || receipt.mode !== 'shadow') authorityBreaches += 1;
    if (!verifyJeffV09ShadowReceipt(receipt, request)) receiptFailures += 1;
    if (receipt.driftDetected) driftFailures += 1;
    emit(receipt);
  } catch (error) {
    invalidSamples += 1;
    emit({
      schema: 'jeff-live-shadow-soak-rejection-v1',
      observedAt: new Date().toISOString(),
      mode: 'shadow',
      executionAuthorized: false,
      externalWritesAttempted: 0,
      lineSha256: createHash('sha256').update(line).digest('hex'),
      error: error instanceof Error ? error.message.split(':', 1)[0] : 'JEFF_SOAK_UNKNOWN_ERROR',
    });
  }
}

const endedAt = new Date();
const summary = {
  schema: JEFF_LIVE_SHADOW_SOAK.summarySchema,
  startedAt: startedAt.toISOString(),
  endedAt: endedAt.toISOString(),
  durationHours: (endedAt.getTime() - startedAt.getTime()) / 3_600_000,
  model: JEFF_LIVE_SHADOW_SOAK.model,
  mode: 'shadow',
  executionAuthorized: false,
  totalSamples,
  validSamples,
  invalidSamples,
  uniqueRequests: decisions.size,
  authorityBreaches,
  receiptFailures,
  driftFailures,
  externalWritesAttempted: 0,
};
const assessment = assessJeffShadowSoakSummary(summary, options);
const finalSummary = { ...summary, assessment };
if (options.summary) {
  await writeFile(options.summary, `${JSON.stringify(finalSummary, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
} else {
  process.stderr.write(`${JSON.stringify(finalSummary, null, 2)}\n`);
}
if (output !== process.stdout) await new Promise((resolve, reject) => output.end(resolve).once('error', reject));
if (!assessment.qualified) process.exitCode = 1;
