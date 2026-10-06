import { createPublicClient, defineChain, http, decodeEventLog, parseAbi } from 'viem';
const abi = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']);
export function createClockersPaymentVerifier({ rpcUrl, chainId, confirmations = 64, publicClient }) {
  const chain = defineChain({ id: chainId, name: 'Clockers', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
  const client = publicClient || createPublicClient({ chain, transport: http(rpcUrl, { timeout: 10000, retryCount: 1 }) });
  return async (invoice, hash) => {
    if (await client.getChainId() !== chainId || invoice.chainId !== chainId) throw new Error('JEFF_PAYMENT_CHAIN_MISMATCH');
    const receipt = await client.getTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error('JEFF_PAYMENT_FAILED');
    const head = await client.getBlockNumber({ cacheTime: 0 });
    if (head - receipt.blockNumber + 1n < BigInt(confirmations)) throw new Error('JEFF_PAYMENT_CONFIRMING');
    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    if (block.hash !== receipt.blockHash || Number(block.timestamp) * 1000 < Date.parse(invoice.issuedAt) - 15000
      || Number(block.timestamp) * 1000 > Date.parse(invoice.expiresAt)) throw new Error('JEFF_PAYMENT_BINDING_INVALID');
    const matched = receipt.logs.some(log => {
      if (log.address.toLowerCase() !== invoice.token.toLowerCase()) return false;
      try {
        const decoded = decodeEventLog({ abi, data: log.data, topics: log.topics });
        return decoded.args.from.toLowerCase() === invoice.scope.owner && decoded.args.to.toLowerCase() === invoice.recipient
          && decoded.args.value === BigInt(invoice.amount);
      } catch { return false; }
    });
    if (!matched) throw new Error('JEFF_PAYMENT_BINDING_INVALID');
  };
}
