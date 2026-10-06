import { mkdir, writeFile } from 'node:fs/promises';
import { createOwnershipResolver } from '../src/chain.mjs';
const origin = 'http://127.0.0.1:8788';
const config = await (await fetch(`${origin}/api/config`)).json();
const candidate = { chainId: config.chainId, collection: config.collection, tokenId: '35' };
const state = await createOwnershipResolver({ ...candidate, rpcUrl: 'https://rpc.mainnet.chain.robinhood.com' })(candidate);
const challengeResponse = await fetch(`${origin}/api/auth/challenge`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ wallet: state.owner, tokenId: candidate.tokenId }) });
const challenge = await challengeResponse.json();
const denied = await fetch(`${origin}/api/jobs/12345678-1234-1234-1234-123456789abc`);
const foreignOrigin = await fetch(`${origin}/api/config`, { headers: { Origin: 'https://example.com' } });
if (challengeResponse.status !== 200 || !challenge.nonce || denied.status !== 401 || foreignOrigin.status !== 403) throw new Error('HTTP_SMOKE_FAILED');
const result = { checkedAt: new Date().toISOString(), origin, config,
  chain: { ...candidate, ...state }, chainChallengeIssued: true,
  unauthenticatedResultStatus: denied.status, foreignOriginStatus: foreignOrigin.status,
  realModelJobPassed: false, signedHolderLoginPassed: false };
await mkdir('evidence', { recursive: true });
await writeFile('evidence/http-smoke.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
