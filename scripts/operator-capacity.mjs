import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createJeffApplication } from '../src/application.mjs';
import { createOwnershipResolver } from '../src/chain.mjs';

// Explicit bounded operator check. Isolated storage, genuine public ownership,
// no holder session, no payments or production-workspace mutation.
if (process.env.JEFF_OPERATOR_CAPACITY_CHECK !== 'true') throw new Error('OPERATOR_CAPACITY_OPT_IN_REQUIRED');
const parent = resolve(process.env.JEFF_DATA_ROOT || '/data');
const dataRoot = await mkdtemp(resolve(parent, 'operator-capacity-'));
const chainId = Number(process.env.JEFF_CHAIN_ID || 4663);
const collection = process.env.JEFF_COLLECTION || '0xf4127ac7e73a807060cbdd08fc2c776b2e78ce67';
const rpcUrl = process.env.JEFF_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
const resolveOwner = createOwnershipResolver({ chainId, collection, rpcUrl });
const samples = [], timings = [], started = performance.now();
const scopes = [];
for (const tokenId of ['35', '128', '207']) {
  const began = performance.now();
  const candidate = { chainId, collection, tokenId };
  const state = await resolveOwner(candidate);
  scopes.push({ ...candidate, owner: state.owner.toLowerCase(), ownerEpoch: state.ownerEpoch });
  timings.push({ operation: 'pinned owner/epoch', ms: Math.round(performance.now() - began) });
}
const app = await createJeffApplication({ dataRoot, env: { ...process.env, JEFF_MAX_CONCURRENT_JOBS: '2',
  JEFF_INFERENCE_CREDITS_ENABLED: 'false' }, startScheduler: false, hosting: {
    enabled: false, freePassEnabled: false, plan: {}, requireActive: async () => {}, startJob: async (scope, start) => start(),
  } });
const sampler = setInterval(() => samples.push({ atMs: Math.round(performance.now() - started),
  rssBytes: process.memoryUsage().rss, cpu: process.cpuUsage() }), 500);
const objective = 'Reply with exactly: Operator capacity check complete. Do not use tools, save memories or propose schedules.';
let report;
try {
  const admissions = await Promise.all(scopes.slice(0, 2).map(async scope => {
    const began = performance.now();
    const admission = await app.submit(scope, { objective });
    timings.push({ operation: 'admission', ms: Math.round(performance.now() - began) });
    return { admission, began };
  }));
  let thirdRejected = false;
  try { await app.submit(scopes[2], { objective }); }
  catch (error) { if (error.message !== 'JEFF_RUNTIME_BUSY') throw error; thirdRejected = true; }
  if (!thirdRejected) throw new Error('OPERATOR_CAPACITY_BOUND_FAILED');
  const jobs = await Promise.all(admissions.map(async ({ admission, began }) => {
    const result = await admission.completion;
    if (result.status !== 'completed' || result.saved !== true) throw new Error('OPERATOR_COMPLETION_FAILED');
    return { id: result.id, status: result.status, saved: result.saved, textSha256: result.textSha256,
      completionMs: Math.round(performance.now() - began) };
  }));
  const version = JSON.parse(await readFile('node_modules/openclaw/package.json', 'utf8')).version;
  report = { schema: 'jeff-bounded-operator-capacity-v1', observedAt: new Date().toISOString(),
    source: process.env.JEFF_RELEASE_SHA, runtime: version, dataRoot, jobs, thirdRejected, maxConcurrentJobs: 2,
    rpcProvider: new URL(rpcUrl).hostname, timings, samples, signedHolderSession: false,
    realProviderCalls: 2, productionWorkspacesTouched: false, limitsRaised: false,
    limitation: 'Two short concurrent operator tasks establish this bounded pilot check, not broad-launch throughput or provider quota.' };
  await writeFile(resolve(dataRoot, 'capacity-proof.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
} finally { clearInterval(sampler); await app.close(); }
console.log(JSON.stringify(report));
