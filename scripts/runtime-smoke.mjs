import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createJeffOpenClawNftBridge } from 'jeff-agent-nft/openclaw';
import { createOwnershipResolver } from '../src/chain.mjs';
import { createOpenClawRunner } from '../src/openclaw-runner.mjs';

const candidate = { chainId: 4663, collection: '0xf4127ac7e73a807060cbdd08fc2c776b2e78ce67', tokenId: '35' };
const resolveOwner = createOwnershipResolver({ ...candidate, rpcUrl: 'https://rpc.mainnet.chain.robinhood.com' });
const state = await resolveOwner(candidate);
const scope = { ...candidate, owner: state.owner, ownerEpoch: state.ownerEpoch };
const dataRoot = resolve('data/operator-smoke');
await mkdir('.private', { recursive: true });
const runner = createOpenClawRunner({ onDiagnostics: text => writeFile('.private/runtime-diagnostic.txt', text, { mode: 0o600 }) });
const bridge = createJeffOpenClawNftBridge({ dataRoot, resolveOwner, runAgent: runner });
const objective = `Create a concise holder onboarding checklist from these supplied facts. Separate confirmed facts from work still pending. NFT: Room 35 on chain 4663. Current public owner: ${scope.owner}. Transfer epoch: ${scope.ownerEpoch}. JEFF is being connected to OpenClaw. This pilot generates and saves text responses. Paid 30-day hosting, continuous operation and messaging channels are not available yet. Do not browse, perform external actions, or invent launch readiness.`;
const result = await bridge.run(scope, objective);
// New bridge instance proves retrieval is from disk, not a process-local cache.
const reopened = createJeffOpenClawNftBridge({ dataRoot, resolveOwner, runAgent: createOpenClawRunner() });
const retrieved = await reopened.retrieve(scope, result.id);
if (retrieved.textSha256 !== result.textSha256 || retrieved.text !== result.text) throw new Error('RETRIEVAL_MISMATCH');
await mkdir('evidence', { recursive: true });
const evidence = { schema: 'simple-jeff-real-runtime-smoke-v1', observedAt: new Date().toISOString(),
  operatorTest: true, signedHolderSessionTested: false, simulatedModel: false, runtime: 'OpenClaw 2026.9.8',
  jobId: result.id, scope, blockNumber: state.blockNumber, textSha256: result.textSha256,
  retrievedAfterBridgeRestart: true, response: result.text, externalActionsAuthorized: false,
  paidHostingTested: false, continuousHostingTested: false };
const evidencePath = resolve('evidence/runtime-smoke.json');
await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ evidencePath, jobId: result.id, textSha256: result.textSha256,
  evidenceSha256: createHash('sha256').update(JSON.stringify(evidence, null, 2)).digest('hex'),
  retrievedAfterBridgeRestart: true }));
