import { hashJeffBrainValue, isJeffRecord, JEFF_HASH } from './jeff-brain-common.mjs';

const ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const SIGNATURE = /^0x[a-fA-F0-9]+$/;
const TOKEN_ID = /^(?:0|[1-9]\d*)$/;
const MAX_UINT256 = (1n << 256n) - 1n;
const OWNER_OF_ABI = Object.freeze([Object.freeze({
  type: 'function',
  name: 'ownerOf',
  stateMutability: 'view',
  inputs: Object.freeze([Object.freeze({ name: 'tokenId', type: 'uint256' })]),
  outputs: Object.freeze([Object.freeze({ name: 'owner', type: 'address' })]),
})]);

function normalizeAddress(value, code) {
  if (typeof value !== 'string' || !ADDRESS.test(value)) throw new Error(code);
  return value.toLowerCase();
}

function normalizeAgentNft(agentNft) {
  if (!isJeffRecord(agentNft)
    || !Number.isSafeInteger(agentNft.chainId)
    || agentNft.chainId <= 0
    || typeof agentNft.tokenId !== 'string'
    || !TOKEN_ID.test(agentNft.tokenId)) {
    throw new Error('JEFF_HOLDER_AGENT_NFT_INVALID');
  }
  let tokenId;
  try {
    tokenId = BigInt(agentNft.tokenId);
  } catch {
    throw new Error('JEFF_HOLDER_AGENT_NFT_INVALID');
  }
  if (tokenId > MAX_UINT256) throw new Error('JEFF_HOLDER_AGENT_NFT_INVALID');
  return Object.freeze({
    chainId: agentNft.chainId,
    collection: normalizeAddress(agentNft.collection, 'JEFF_HOLDER_AGENT_NFT_INVALID'),
    tokenId: agentNft.tokenId,
    tokenIdValue: tokenId,
    account: normalizeAddress(agentNft.account, 'JEFF_HOLDER_AGENT_NFT_INVALID'),
  });
}

function isoNow(now) {
  let value;
  try { value = new Date(now()).toISOString(); } catch { throw new Error('JEFF_HOLDER_EVM_CONFIG_INVALID'); }
  return value;
}

async function publicClientFor(getPublicClient, chainId) {
  let client;
  try { client = await getPublicClient(chainId); } catch { throw new Error('JEFF_HOLDER_EVM_UNAVAILABLE'); }
  if (!client
    || !isJeffRecord(client.chain)
    || client.chain.id !== chainId
    || typeof client.verifyMessage !== 'function'
    || typeof client.readContract !== 'function'
    || typeof client.getBlockNumber !== 'function') {
    throw new Error('JEFF_HOLDER_EVM_CHAIN_MISMATCH');
  }
  return client;
}

export function createJeffViemWalletVerifier({
  getPublicClient,
  now = () => new Date().toISOString(),
} = {}) {
  if (typeof getPublicClient !== 'function' || typeof now !== 'function') {
    throw new Error('JEFF_HOLDER_EVM_CONFIG_INVALID');
  }
  return Object.freeze({
    async verify(input) {
      if (!isJeffRecord(input)
        || !JEFF_HASH.test(String(input.challengeSha256 ?? ''))
        || typeof input.message !== 'string'
        || !input.message
        || input.message.length > 8_192
        || typeof input.signature !== 'string'
        || !SIGNATURE.test(input.signature)
        || input.signature.length > 2_048
        || !Number.isSafeInteger(input.chainId)
        || input.chainId <= 0) {
        throw new Error('JEFF_HOLDER_SIGNATURE_INVALID');
      }
      const wallet = normalizeAddress(input.wallet, 'JEFF_HOLDER_SIGNATURE_INVALID');
      const client = await publicClientFor(getPublicClient, input.chainId);
      let verified = false;
      try {
        verified = await client.verifyMessage({
          address: wallet,
          message: input.message,
          signature: input.signature,
        }) === true;
      } catch {
        verified = false;
      }
      return Object.freeze({
        schema: 'jeff-wallet-signature-verification-v1',
        wallet,
        challengeSha256: input.challengeSha256,
        verified,
        observedAt: isoNow(now),
      });
    },
  });
}

export function createJeffViemOwnershipResolver({
  getPublicClient,
  resolveOwnerEpoch,
  now = () => new Date().toISOString(),
} = {}) {
  if (typeof getPublicClient !== 'function'
    || typeof resolveOwnerEpoch !== 'function'
    || typeof now !== 'function') {
    throw new Error('JEFF_HOLDER_EVM_CONFIG_INVALID');
  }
  return Object.freeze({
    async resolveCurrentOwner(rawAgentNft) {
      const normalized = normalizeAgentNft(rawAgentNft);
      const client = await publicClientFor(getPublicClient, normalized.chainId);
      let blockNumber;
      let rawOwner;
      try {
        blockNumber = await client.getBlockNumber({ cacheTime: 0 });
        if (typeof blockNumber !== 'bigint' || blockNumber < 0n) throw new Error();
        rawOwner = await client.readContract({
          address: normalized.collection,
          abi: OWNER_OF_ABI,
          functionName: 'ownerOf',
          args: [normalized.tokenIdValue],
          blockNumber,
        });
      } catch {
        throw new Error('JEFF_HOLDER_OWNERSHIP_UNAVAILABLE');
      }
      const currentOwner = normalizeAddress(rawOwner, 'JEFF_HOLDER_OWNERSHIP_ATTESTATION_INVALID');
      let epoch;
      try {
        epoch = await resolveOwnerEpoch(Object.freeze({
          agentNft: Object.freeze({
            chainId: normalized.chainId,
            collection: normalized.collection,
            tokenId: normalized.tokenId,
            account: normalized.account,
          }),
          currentOwner,
          blockNumber,
        }));
      } catch {
        throw new Error('JEFF_HOLDER_OWNERSHIP_UNAVAILABLE');
      }
      if (!isJeffRecord(epoch)
        || epoch.blockNumber !== blockNumber
        || typeof epoch.currentOwner !== 'string'
        || epoch.currentOwner.toLowerCase() !== currentOwner
        || !Number.isSafeInteger(epoch.ownerEpoch)
        || epoch.ownerEpoch < 0) {
        throw new Error('JEFF_HOLDER_OWNERSHIP_ATTESTATION_INVALID');
      }
      const agentNft = Object.freeze({
        chainId: normalized.chainId,
        collection: normalized.collection,
        tokenId: normalized.tokenId,
        account: normalized.account,
      });
      return Object.freeze({
        schema: 'jeff-holder-ownership-attestation-v1',
        agentNftSha256: hashJeffBrainValue(agentNft),
        currentOwner,
        ownerEpoch: epoch.ownerEpoch,
        observedAt: isoNow(now),
      });
    },
  });
}

export const JEFF_HOLDER_EVM = Object.freeze({
  walletVerification: 'viem-public-client-verifyMessage',
  ownershipFunction: 'ownerOf(uint256)',
  ownershipReadOnly: true,
  ownershipBlockPinned: true,
  ownerEpochRequired: true,
  transactionMethodsIncluded: false,
});
