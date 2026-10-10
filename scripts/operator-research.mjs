import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createJeffOpenClawNftBridge } from 'jeff-agent-nft/openclaw';
import { createJeffApplication } from '../src/application.mjs';
import { createOwnershipResolver } from '../src/chain.mjs';

if (process.env.JEFF_OPERATOR_RESEARCH_CHECK !== 'true') throw new Error('OPERATOR_RESEARCH_OPT_IN_REQUIRED');
const dataRoot = await mkdtemp(resolve(process.env.JEFF_DATA_ROOT, 'operator-research-'));
const chainId = Number(process.env.JEFF_CHAIN_ID || 4663);
const collection = process.env.JEFF_COLLECTION || '0xf4127ac7e73a807060cbdd08fc2c776b2e78ce67';
const resolveOwner = createOwnershipResolver({ chainId, collection, rpcUrl: process.env.JEFF_RPC_URL });
const candidate = { chainId, collection, tokenId: '35' }, ownership = await resolveOwner(candidate);
const scope = { ...candidate, owner: ownership.owner, ownerEpoch: ownership.ownerEpoch };
const app = await createJeffApplication({ dataRoot, startScheduler: false, env: {
  ...process.env, JEFF_WEB_RESEARCH_ENABLED: 'true', JEFF_INFERENCE_CREDITS_ENABLED: 'false',
}, hosting: { enabled: false, freePassEnabled: false, plan: {}, requireActive: async () => {}, startJob: async (_scope, start) => start() } });
let saved;
try {
  const admission = await app.submit(scope, {
    objective: 'Using only supplied source [1], quote the sentence explaining the use of this domain in documentation examples. Cite [1]. Do not propose memory or schedules.',
    research: { urls: ['https://example.com/'], consent: true },
  });
  saved = await admission.completion;
  if (saved.status !== 'completed' || saved.saved !== true || !saved.text.includes('### Retrieved sources')
    || !saved.text.includes('https://example.com/') || !saved.text.includes('documentation')) throw new Error('OPERATOR_RESEARCH_FAILED');
  const binding = await app.workspace.getJobBinding(scope, saved.id);
  if (binding.action || (await app.workspace.get(scope)).memories.length) throw new Error('OPERATOR_RESEARCH_ACTION_LEAK');
} finally { await app.close(); }
const bridge = createJeffOpenClawNftBridge({ dataRoot, resolveOwner, runAgent: async () => { throw new Error('OPERATOR_REPLAY_FORBIDDEN'); } });
const recovered = await bridge.retrieve(scope, saved.id);
if (recovered.textSha256 !== saved.textSha256 || recovered.text !== saved.text) throw new Error('OPERATOR_RESEARCH_RELOAD_FAILED');
const proof = { schema: 'jeff-operator-research-v1', observedAt: new Date().toISOString(), source: process.env.JEFF_RELEASE_SHA,
  runtime: JSON.parse(await readFile('node_modules/openclaw/package.json', 'utf8')).version,
  jobId: saved.id, status: saved.status, saved: saved.saved, textSha256: saved.textSha256,
  sourceUrl: 'https://example.com/', realHttps: true, realProviderTurn: true, providerRequestCountUnmeasured: true,
  postShutdownReloadVerified: true, signedHolderSession: false, productionWorkspacesTouched: false,
  operatorOnlyHosting: true, inferenceCreditsDisabledForIsolatedCheck: true,
  limitation: 'Operator-only isolated storage and hosting stub; this is not holder acceptance or a Railway-egress check.' };
await writeFile(resolve(dataRoot, 'research-proof.json'), JSON.stringify(proof, null, 2), { mode: 0o600 });
console.log(JSON.stringify(proof));
