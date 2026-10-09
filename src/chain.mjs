import { createPublicClient, defineChain, http, parseAbi, getAddress } from 'viem';

const abi = parseAbi(['function ownerOf(uint256) view returns (address)', 'function transferNonceOf(uint256) view returns (uint64)']);
export function createOwnershipResolver({ rpcUrl, chainId, collection }) {
  const nft = getAddress(collection).toLowerCase();
  const chain = defineChain({ id: chainId, name: 'Agent NFT chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } } });
  const client = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 10000, retryCount: 1 }) });
  return async scope => {
    if (scope.chainId !== chainId || scope.collection.toLowerCase() !== nft) throw new Error('JEFF_CHAIN_DENIED');
    try {
      if (await client.getChainId() !== chainId) throw new Error('JEFF_CHAIN_MISMATCH');
      const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
      const [owner, epoch] = await Promise.all([
        client.readContract({ address: nft, abi, functionName: 'ownerOf', args: [BigInt(scope.tokenId)], blockNumber }),
        client.readContract({ address: nft, abi, functionName: 'transferNonceOf', args: [BigInt(scope.tokenId)], blockNumber }),
      ]);
      const ownerEpoch = Number(epoch);
      if (!Number.isSafeInteger(ownerEpoch)) throw new Error('JEFF_EPOCH_INVALID');
      return { owner: owner.toLowerCase(), ownerEpoch, blockNumber: blockNumber.toString() };
    } catch (error) {
      if (error?.message === 'JEFF_CHAIN_MISMATCH' || error?.message === 'JEFF_EPOCH_INVALID') throw error;
      // Keep RPC details on the non-enumerable cause for server diagnostics;
      // callers receive a stable code and must never admit work without a read.
      throw new Error('JEFF_CHAIN_UNAVAILABLE', { cause: error });
    }
  };
}
