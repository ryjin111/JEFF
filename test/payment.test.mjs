import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeEventTopics, encodeAbiParameters, parseAbi } from 'viem';
import { createClockersPaymentVerifier } from '../src/payment.mjs';
const owner = '0x' + '22'.repeat(20), recipient = '0x' + '33'.repeat(20), token = '0x' + '44'.repeat(20);
const hash = '0x' + 'aa'.repeat(32), blockHash = '0x' + 'bb'.repeat(32);
const abi = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']);
const invoice = { chainId: 4663, scope: { owner }, recipient, token, amount: '100', issuedAt: '2026-10-06T00:00:00Z', expiresAt: '2026-10-06T00:15:00Z' };
function fixture({ from = owner, to = recipient, value = 100n, logToken = token, head = 163n, status = 'success', canonicalHash = blockHash, timestamp = 1791244860n, chainId = 4663 } = {}) {
  const log = { address: logToken, topics: encodeEventTopics({ abi, eventName: 'Transfer', args: { from, to } }), data: encodeAbiParameters([{ type: 'uint256' }], [value]) };
  const publicClient = { getChainId: async () => chainId, getTransactionReceipt: async () => ({ status, blockNumber: 100n, blockHash, logs: [log] }), getBlockNumber: async () => head, getBlock: async () => ({ hash: canonicalHash, timestamp }) };
  return createClockersPaymentVerifier({ rpcUrl: 'https://unused.invalid', chainId: 4663, publicClient });
}
test('confirmed exact transfer is accepted even when redeemed later than quote expiry', async () => {
  await fixture()(invoice, hash);
});
test('wrong token, sender, recipient or amount cannot activate hosting', async () => {
  for (const change of [{ logToken: owner }, { from: recipient }, { to: owner }, { value: 99n }]) {
    await assert.rejects(fixture(change)(invoice, hash), /BINDING_INVALID/);
  }
});
test('confirmation depth, chain, failed receipt, canonical block and quote timestamp are enforced', async () => {
  for (const [change, expected] of [[{ head: 162n }, /CONFIRMING/], [{ chainId: 1 }, /CHAIN_MISMATCH/], [{ status: 'reverted' }, /PAYMENT_FAILED/], [{ canonicalHash: hash }, /BINDING_INVALID/], [{ timestamp: 1791245800n }, /BINDING_INVALID/], [{ timestamp: 1791244700n }, /BINDING_INVALID/]]) {
    await assert.rejects(fixture(change)(invoice, hash), expected);
  }
});
