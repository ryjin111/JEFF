import assert from 'node:assert/strict';
import test from 'node:test';

import { hashJeffBrainValue } from '../api/_lib/jeff-brain-common.mjs';
import {
  createJeffViemOwnershipResolver,
  createJeffViemWalletVerifier,
  JEFF_HOLDER_EVM,
} from '../api/_lib/jeff-holder-evm.mjs';

const wallet = '0x1000000000000000000000000000000000000001';
const agentNft = Object.freeze({
  chainId: 8453,
  collection: '0x3000000000000000000000000000000000000003',
  tokenId: '7',
  account: '0x4000000000000000000000000000000000000004',
});
const observedAt = '2026-10-04T08:00:00.000Z';

function publicClient({ verified = true, owner = wallet, chainId = 8453 } = {}) {
  const calls = [];
  return {
    chain: { id: chainId },
    calls,
    async verifyMessage(input) { calls.push(['verifyMessage', input]); return verified; },
    async getBlockNumber(input) { calls.push(['getBlockNumber', input]); return 12345n; },
    async readContract(input) { calls.push(['readContract', input]); return owner; },
  };
}

test('viem wallet verifier supports canonical public-client message verification', async () => {
  const client = publicClient();
  const verifier = createJeffViemWalletVerifier({
    getPublicClient: () => client,
    now: () => observedAt,
  });
  const result = await verifier.verify({
    challengeSha256: 'a'.repeat(64),
    message: 'JEFF Holder Alpha\nPurpose: no transaction.',
    signature: `0x${'b'.repeat(130)}`,
    wallet,
    chainId: 8453,
  });
  assert.equal(result.verified, true);
  assert.equal(result.wallet, wallet);
  assert.equal(client.calls[0][0], 'verifyMessage');
  assert.equal(client.calls[0][1].message, 'JEFF Holder Alpha\nPurpose: no transaction.');
});

test('invalid signatures fail closed without exposing verifier errors', async () => {
  const client = publicClient();
  client.verifyMessage = async () => { throw new Error('private rpc detail'); };
  const verifier = createJeffViemWalletVerifier({ getPublicClient: () => client, now: () => observedAt });
  const result = await verifier.verify({
    challengeSha256: 'a'.repeat(64),
    message: 'message',
    signature: `0x${'b'.repeat(130)}`,
    wallet,
    chainId: 8453,
  });
  assert.equal(result.verified, false);
  assert.equal(JSON.stringify(result).includes('private rpc detail'), false);
});

test('ownership resolver pins ownerOf to one block and binds the transfer epoch', async () => {
  const client = publicClient();
  const resolver = createJeffViemOwnershipResolver({
    getPublicClient: () => client,
    resolveOwnerEpoch(input) {
      assert.equal(input.blockNumber, 12345n);
      assert.equal(input.currentOwner, wallet);
      return { blockNumber: input.blockNumber, currentOwner: input.currentOwner, ownerEpoch: 9 };
    },
    now: () => observedAt,
  });
  const result = await resolver.resolveCurrentOwner(agentNft);
  assert.equal(result.currentOwner, wallet);
  assert.equal(result.ownerEpoch, 9);
  assert.equal(result.agentNftSha256, hashJeffBrainValue(agentNft));
  const read = client.calls.find(([name]) => name === 'readContract')[1];
  assert.equal(read.functionName, 'ownerOf');
  assert.equal(read.blockNumber, 12345n);
  assert.deepEqual(read.args, [7n]);
  assert.equal(Object.hasOwn(read, 'account'), false);
  assert.equal(JEFF_HOLDER_EVM.transactionMethodsIncluded, false);
});

test('chain mismatches and stale epoch attestations fail closed', async () => {
  const wrongChain = publicClient({ chainId: 1 });
  const verifier = createJeffViemWalletVerifier({ getPublicClient: () => wrongChain });
  await assert.rejects(verifier.verify({
    challengeSha256: 'a'.repeat(64),
    message: 'message',
    signature: `0x${'b'.repeat(130)}`,
    wallet,
    chainId: 8453,
  }), /JEFF_HOLDER_EVM_CHAIN_MISMATCH/);
  assert.equal(wrongChain.calls.length, 0);

  const resolver = createJeffViemOwnershipResolver({
    getPublicClient: () => publicClient(),
    resolveOwnerEpoch: ({ currentOwner }) => ({
      blockNumber: 12344n,
      currentOwner,
      ownerEpoch: 9,
    }),
  });
  await assert.rejects(
    resolver.resolveCurrentOwner(agentNft),
    /JEFF_HOLDER_OWNERSHIP_ATTESTATION_INVALID/,
  );
});

test('malformed wallet, token, and signature inputs never reach the chain client', async () => {
  const client = publicClient();
  const verifier = createJeffViemWalletVerifier({ getPublicClient: () => client });
  await assert.rejects(verifier.verify({
    challengeSha256: 'a'.repeat(64),
    message: 'message',
    signature: 'not-hex',
    wallet,
    chainId: 8453,
  }), /JEFF_HOLDER_SIGNATURE_INVALID/);
  const resolver = createJeffViemOwnershipResolver({
    getPublicClient: () => client,
    resolveOwnerEpoch: () => ({ blockNumber: 1n, currentOwner: wallet, ownerEpoch: 1 }),
  });
  await assert.rejects(
    resolver.resolveCurrentOwner({ ...agentNft, tokenId: '-1' }),
    /JEFF_HOLDER_AGENT_NFT_INVALID/,
  );
  assert.equal(client.calls.length, 0);
});
