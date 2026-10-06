import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createJeffOpenClawNftBridge } from 'jeff-agent-nft/openclaw';
import { createOwnershipResolver } from './chain.mjs';
import { createOpenClawRunner } from './openclaw-runner.mjs';

// Explicit operator check, outside holder workspaces. No login is impersonated.
export async function verifyHostedRuntime({ env = process.env, resolveOwner: ownershipResolver, runAgent = createOpenClawRunner() } = {}) {
  const dataRoot = resolve(env.JEFF_DATA_ROOT || 'data', 'operator-verification');
  const file = resolve(dataRoot, 'hosted-proof.json');
  let cached;
  try { cached = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const candidate = { chainId: 4663, collection: '0xf4127ac7e73a807060cbdd08fc2c776b2e78ce67', tokenId: '35' };
  const resolveOwner = ownershipResolver || createOwnershipResolver({ ...candidate, rpcUrl: env.JEFF_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com' });
  const options = { dataRoot, resolveOwner, runAgent };
  if (cached) {
    const saved = await createJeffOpenClawNftBridge(options).retrieve(cached.scope, cached.jobId);
    if (saved.status !== 'completed' || !saved.saved || saved.textSha256 !== cached.textSha256) throw new Error('RETRIEVAL_FAILED');
    return { ...cached, persistenceVerifiedAt: new Date().toISOString(), persistenceReleaseSha: env.JEFF_RELEASE_SHA || null,
      retrievedAfterProcessRestart: true, modelRerun: false };
  }
  const state = await resolveOwner(candidate);
  const scope = { ...candidate, owner: state.owner, ownerEpoch: state.ownerEpoch };
  const bridge = createJeffOpenClawNftBridge(options);
  const result = await bridge.run(scope, 'Create a concise checklist for testing an NFT-controlled hosted assistant. Supplied facts: JEFF uses OpenClaw; Room 35 has a 30-day pilot; tasks produce saved text; paid checkout is disabled; external tools are disabled. Separate available behavior from pending behavior. Do not claim payment verification, holder login or autonomous actions occurred.');
  const read = await createJeffOpenClawNftBridge(options).retrieve(scope, result.id);
  if (result.textSha256 !== read.textSha256 || result.text !== read.text) throw new Error('RETRIEVAL_FAILED');
  const proof = { schema: 'simple-jeff-hosted-runtime-proof-v1', observedAt: new Date().toISOString(), releaseSha: env.JEFF_RELEASE_SHA || null, runtime: 'OpenClaw 2026.9.8', operatorTest: true, signedHolderSessionTested: false, simulatedModel: false, jobId: result.id, scope, textSha256: result.textSha256, retrievedAfterBridgeRestart: true, paidCheckoutEnabled: false };
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify(proof), { mode: 0o600 });
  return proof;
}
