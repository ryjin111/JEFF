import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { decodeFunctionData, encodeAbiParameters, parseAbi } from 'viem';
import { createOwnershipResolver } from '../src/chain.mjs';

const chainId = 4663;
const collection = '0x' + 'ab'.repeat(20);
const firstOwner = '0x' + 'cd'.repeat(20);
const secondOwner = '0x' + 'ef'.repeat(20);
const abi = parseAbi(['function ownerOf(uint256) view returns (address)', 'function transferNonceOf(uint256) view returns (uint64)']);
const scope = { chainId, collection, tokenId: '35' };

async function fixture(t) {
  const requests = [];
  const state = { chainId, blockNumber: 12345n, owner: firstOwner, epoch: 0n, failure: null };
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw);
    requests.push(input);
    response.setHeader('Content-Type', 'application/json');
    if (state.failure === 'http') {
      response.writeHead(503);
      response.end(JSON.stringify({ error: 'Fixture RPC unavailable' }));
      return;
    }
    if (state.failure === 'rpc' && input.method === 'eth_call') {
      response.end(JSON.stringify({ jsonrpc: '2.0', id: input.id, error: { code: -32000, message: 'Fixture contract read unavailable' } }));
      return;
    }
    let result;
    if (input.method === 'eth_chainId') result = `0x${state.chainId.toString(16)}`;
    else if (input.method === 'eth_blockNumber') result = `0x${state.blockNumber.toString(16)}`;
    else if (input.method === 'eth_call') {
      const decoded = decodeFunctionData({ abi, data: input.params[0].data });
      assert.equal(decoded.args[0], 35n);
      if (state.failure === 'malformed') result = '0x';
      else if (decoded.functionName === 'ownerOf') result = encodeAbiParameters([{ type: 'address' }], [state.owner]);
      else result = encodeAbiParameters([{ type: 'uint64' }], [state.epoch]);
    } else throw new Error('Unexpected fixture RPC method');
    response.end(JSON.stringify({ jsonrpc: '2.0', id: input.id, result }));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); });
  const resolveOwner = createOwnershipResolver({ rpcUrl: `http://127.0.0.1:${server.address().port}`, chainId, collection });
  return { state, requests, resolveOwner };
}

test('ownership reads are pinned to the same fresh block and observe transfers on the next check', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.resolveOwner(scope), { owner: firstOwner, ownerEpoch: 0, blockNumber: '12345' });
  const firstReads = f.requests.filter(request => request.method === 'eth_call');
  assert.equal(firstReads.length, 2);
  for (const request of firstReads) {
    assert.equal(request.params[0].to.toLowerCase(), collection);
    assert.equal(request.params[1], '0x3039');
  }
  f.state.blockNumber = 12346n;
  f.state.owner = secondOwner;
  f.state.epoch = 1n;
  assert.deepEqual(await f.resolveOwner(scope), { owner: secondOwner, ownerEpoch: 1, blockNumber: '12346' });
  assert.equal(f.requests.filter(request => request.method === 'eth_chainId').length, 2);
  assert.equal(f.requests.filter(request => request.method === 'eth_blockNumber').length, 2);
  for (const request of f.requests.filter(request => request.method === 'eth_call').slice(2)) assert.equal(request.params[1], '0x303a');
});

test('transport outages fail closed with a stable error and recover without stale ownership', async t => {
  const f = await fixture(t);
  await f.resolveOwner(scope);
  f.state.failure = 'http';
  await assert.rejects(f.resolveOwner(scope), error => {
    assert.equal(error.message, 'JEFF_CHAIN_UNAVAILABLE');
    assert.ok(error.cause instanceof Error);
    assert.equal(Object.getOwnPropertyDescriptor(error, 'cause').enumerable, false);
    return true;
  });
  f.state.failure = null;
  f.state.owner = secondOwner;
  f.state.epoch = 2n;
  const recovered = await f.resolveOwner(scope);
  assert.equal(recovered.owner, secondOwner);
  assert.equal(recovered.ownerEpoch, 2);
});

test('RPC and malformed contract responses cannot produce an ownership result', async t => {
  const f = await fixture(t);
  for (const failure of ['rpc', 'malformed']) {
    f.state.failure = failure;
    await assert.rejects(f.resolveOwner(scope), { message: 'JEFF_CHAIN_UNAVAILABLE' });
  }
  f.state.failure = null;
  assert.equal((await f.resolveOwner(scope)).owner, firstOwner);
});

test('scope denial, wrong RPC chain, and unsafe epochs retain their distinct errors', async t => {
  const f = await fixture(t);
  await assert.rejects(f.resolveOwner({ ...scope, chainId: 1 }), { message: 'JEFF_CHAIN_DENIED' });
  await assert.rejects(f.resolveOwner({ ...scope, collection: '0x' + '11'.repeat(20) }), { message: 'JEFF_CHAIN_DENIED' });
  assert.equal(f.requests.length, 0);
  f.state.chainId = 1;
  await assert.rejects(f.resolveOwner(scope), { message: 'JEFF_CHAIN_MISMATCH' });
  assert.equal(f.requests.some(request => request.method === 'eth_call'), false);
  f.state.chainId = chainId;
  f.state.epoch = 2n ** 53n;
  await assert.rejects(f.resolveOwner(scope), { message: 'JEFF_EPOCH_INVALID' });
});
