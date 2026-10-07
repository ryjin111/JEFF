import { createPublicClient, http, getAddress, isAddress, parseAbi, encodeFunctionData, decodeFunctionResult, multicall3Abi } from 'viem';

const roomAbi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function saleMinted() view returns (uint256)',
  'function ownerOf(uint256) view returns (address)',
]);
const multicallAddress = '0xcA11bde05977b3631167028862bE2a173976CA11';
const nonexistentOwner = '0xdf2d9b42';

// Discovery only supplies choices. Signed holder authentication independently
// rechecks ownerOf and the transfer nonce before opening a private workspace.
export function createNftDiscovery({ rpcUrl, chainId, collection, client: fixtureClient,
  timeoutMs = 10000, maxScan = 4444, batchSize = 350, maxConcurrent = 4 }) {
  if (![chainId, timeoutMs, maxScan, batchSize, maxConcurrent].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('JEFF_DISCOVERY_UNAVAILABLE');
  const nft = getAddress(collection).toLowerCase();
  const inflight = new Map();
  return function discover(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).length !== 1 || !Object.hasOwn(input, 'wallet')
      || !isAddress(input.wallet || '')) throw new Error('JEFF_DISCOVERY_INVALID');
    const wallet = getAddress(input.wallet).toLowerCase();
    if (inflight.has(wallet)) return inflight.get(wallet);
    if (inflight.size >= maxConcurrent) throw new Error('JEFF_DISCOVERY_UNAVAILABLE');
    const controller = new AbortController();
    const client = fixtureClient || createPublicClient({ transport: http(rpcUrl,
      { timeout: Math.min(timeoutMs, 5000), retryCount: 0, maxResponseBodySize: 256 * 1024, fetchOptions: { signal: controller.signal } }) });
    const stopped = () => { if (controller.signal.aborted) throw new Error('JEFF_DISCOVERY_UNAVAILABLE'); };
    const work = async () => {
      if (await client.getChainId() !== chainId) throw new Error('JEFF_DISCOVERY_UNAVAILABLE');
      stopped();
      const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
      if (typeof blockNumber !== 'bigint' || blockNumber < 0n) throw new Error('JEFF_DISCOVERY_UNAVAILABLE');
      const balance = await client.readContract({ address: nft, abi: roomAbi, functionName: 'balanceOf', args: [wallet], blockNumber });
      stopped();
      if (typeof balance !== 'bigint' || balance < 0n || balance > BigInt(maxScan)) throw new Error('JEFF_DISCOVERY_UNAVAILABLE');
      const tokenIds = [];
      const response = () => ({ chainId, collection: nft, wallet, tokenIds, balance: Number(balance), blockNumber: blockNumber.toString(), complete: true });
      if (balance === 0n) return response();
      const [minted, code] = await Promise.all([
        client.readContract({ address: nft, abi: roomAbi, functionName: 'saleMinted', blockNumber }),
        client.getBytecode({ address: multicallAddress, blockNumber }),
      ]);
      stopped();
      // saleMinted is lifetime minted count. totalSupply omits burned IDs and
      // would miss surviving tokens above that smaller number.
      if (typeof minted !== 'bigint' || minted < balance || minted > BigInt(maxScan)
        || !/^0x(?:[a-fA-F0-9]{2})+$/.test(code || '') || /^0x(?:00)+$/.test(code)) throw new Error('JEFF_DISCOVERY_UNAVAILABLE');
      for (let first = 1; first <= Number(minted); first += batchSize) {
        stopped();
        const count = Math.min(batchSize, Number(minted) - first + 1);
        const calls = Array.from({ length: count }, (_, index) => ({ target: nft, allowFailure: true,
          callData: encodeFunctionData({ abi: roomAbi, functionName: 'ownerOf', args: [BigInt(first + index)] }) }));
        const owners = await client.readContract({ address: multicallAddress, abi: multicall3Abi,
          functionName: 'aggregate3', args: [calls], blockNumber });
        stopped();
        if (!Array.isArray(owners) || owners.length !== calls.length) throw new Error('JEFF_DISCOVERY_UNAVAILABLE');
        for (let index = 0; index < owners.length; index++) {
          const result = owners[index];
          if (result?.success === false && result.returnData?.toLowerCase() === nonexistentOwner) continue;
          if (result?.success !== true || !/^0x0{24}[a-fA-F0-9]{40}$/.test(result.returnData || '')) throw new Error('JEFF_DISCOVERY_UNAVAILABLE');
          const owner = decodeFunctionResult({ abi: roomAbi, functionName: 'ownerOf', data: result.returnData });
          if (!isAddress(owner) || /^0x0{40}$/i.test(owner)) throw new Error('JEFF_DISCOVERY_UNAVAILABLE');
          if (owner.toLowerCase() === wallet) tokenIds.push(String(first + index));
        }
      }
      if (BigInt(tokenIds.length) !== balance) throw new Error('JEFF_DISCOVERY_UNAVAILABLE');
      return response();
    };
    let timer;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => {
      controller.abort(); reject(new Error('JEFF_DISCOVERY_UNAVAILABLE'));
    }, timeoutMs); });
    const pending = Promise.race([work(), deadline]).catch(() => { throw new Error('JEFF_DISCOVERY_UNAVAILABLE'); })
      .finally(() => { clearTimeout(timer); controller.abort(); inflight.delete(wallet); });
    inflight.set(wallet, pending);
    return pending;
  };
}
