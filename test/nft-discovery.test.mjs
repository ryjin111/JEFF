import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, encodeAbiParameters, getAddress, parseAbi } from 'viem';
import { createNftDiscovery } from '../src/nft-discovery.mjs';

const chainId = 4663;
const collection = '0x' + 'ab'.repeat(20);
const wallet = '0x' + 'cd'.repeat(20);
const otherWallet = '0x' + '34'.repeat(20);
const unownedWallet = '0x' + '56'.repeat(20);
const defaultOwner = '0x' + '78'.repeat(20);
const blockNumber = 12345n;
const ownerAbi = parseAbi(['function ownerOf(uint256) view returns (address)']);
const unavailable = { message: 'JEFF_DISCOVERY_UNAVAILABLE' };

function fixture({ owners = { '2': wallet }, burned = [], minted = 12n, balance,
  aggregate, client: overrides = {}, config = {} } = {}) {
  const reads = [], codeReads = [], batches = [];
  let chainReads = 0, blockReads = 0;
  const holes = new Set(burned.map(String));
  const client = {
    async getChainId() { chainReads++; return chainId; },
    async getBlockNumber() { blockReads++; return blockNumber; },
    async getBytecode(input) { codeReads.push(input); return '0x60006000'; },
    async readContract(input) {
      reads.push(input);
      if (input.functionName === 'balanceOf') {
        return balance === undefined ? BigInt(Object.values(owners).filter(owner => owner.toLowerCase() === input.args[0].toLowerCase()).length) : balance;
      }
      if (input.functionName === 'saleMinted') return minted;
      if (input.functionName !== 'aggregate3') throw new Error('UNEXPECTED_FIXTURE_CONTRACT_READ');
      const calls = input.args[0];
      const ids = calls.map(call => decodeFunctionData({ abi: ownerAbi, data: call.callData }).args[0].toString());
      batches.push({ input, calls, ids });
      const result = ids.map(id => holes.has(id)
        ? { success: false, returnData: '0xdf2d9b42' }
        : { success: true, returnData: encodeAbiParameters([{ type: 'address' }], [owners[id] || defaultOwner]) });
      return aggregate ? aggregate(result, input, ids) : result;
    },
    ...overrides,
  };
  const discover = createNftDiscovery({ rpcUrl: 'http://127.0.0.1:1', chainId, collection, client, ...config });
  return { discover, client, reads, codeReads, batches, chainReads: () => chainReads, blockReads: () => blockReads };
}

function assertPinnedReads(f, batchSize = 350) {
  for (const input of [...f.reads, ...f.codeReads]) assert.equal(input.blockNumber, blockNumber);
  for (const input of f.reads.filter(input => input.functionName !== 'aggregate3')) assert.equal(input.address.toLowerCase(), collection);
  for (const { calls } of f.batches) {
    assert.ok(calls.length > 0 && calls.length <= batchSize);
    for (const call of calls) {
      assert.equal(call.target.toLowerCase(), collection);
      assert.equal(call.allowFailure, true);
      assert.equal(decodeFunctionData({ abi: ownerAbi, data: call.callData }).functionName, 'ownerOf');
    }
  }
}

test('zero balance returns a complete empty snapshot without scanning or multicall setup', async () => {
  const f = fixture({ owners: {}, minted: 4444n });
  assert.deepEqual(await f.discover({ wallet }), { chainId, collection, wallet, tokenIds: [], balance: 0, blockNumber: '12345', complete: true });
  assert.equal(f.chainReads(), 1);
  assert.equal(f.blockReads(), 1);
  assert.deepEqual(f.reads.map(input => input.functionName), ['balanceOf']);
  assert.equal(f.codeReads.length, 0);
  assert.equal(f.batches.length, 0);
  assertPinnedReads(f);
});

test('one or multiple NFTs are returned as numerically sorted decimal IDs with normalized identities', async () => {
  for (const ids of [['2'], ['2', '10', '12']]) {
    const f = fixture({ owners: Object.fromEntries(ids.map(id => [id, wallet])),
      config: { collection: '0x' + collection.slice(2).toUpperCase(), batchSize: 5 } });
    const result = await f.discover({ wallet: getAddress(wallet) });
    assert.deepEqual(result, { chainId, collection, wallet, tokenIds: ids, balance: ids.length, blockNumber: '12345', complete: true });
    assert.deepEqual(f.batches.map(batch => batch.ids.length), [5, 5, 2]);
    assert.deepEqual(f.batches.flatMap(batch => batch.ids), Array.from({ length: 12 }, (_, index) => String(index + 1)));
    assertPinnedReads(f, 5);
  }
});

test('burned token holes do not hide the highest surviving ID above current total supply', async () => {
  const burned = [1, 2, 3, 5, 7, 8, 9, 10, 11];
  const f = fixture({ owners: { '12': wallet }, burned, minted: 12n, config: { batchSize: 4 } });
  const result = await f.discover({ wallet });
  assert.deepEqual(result.tokenIds, ['12']);
  assert.equal(result.complete, true);
  assert.equal(result.balance, 1);
  assert.ok(Number(result.tokenIds[0]) > 12 - burned.length);
  assert.equal(f.reads.some(input => input.functionName === 'totalSupply'), false);
  assert.deepEqual(f.batches.flatMap(batch => batch.ids), Array.from({ length: 12 }, (_, index) => String(index + 1)));
  assertPinnedReads(f, 4);
});

test('wallet inputs and client-supplied discovery overrides are rejected before RPC work', async () => {
  for (const input of [undefined, null, [], '', 0, true, {}, { wallet: null }, { wallet: 1 }, { wallet: 'invalid' },
    { wallet, tokenIds: ['2'] }, { wallet, chainId: 1 }, { wallet, collection }, { wallet, scope: {} }, { wallet, extra: true }]) {
    const f = fixture();
    await assert.rejects(async () => f.discover(input), { message: 'JEFF_DISCOVERY_INVALID' });
    assert.equal(f.chainReads(), 0);
    assert.equal(f.blockReads(), 0);
    assert.equal(f.reads.length, 0);
  }
});

test('chain mismatch and unavailable or malformed multicall bytecode never yield a partial result', async () => {
  for (const rpcChain of [1, '4663', null]) {
    const f = fixture({ client: { getChainId: async () => rpcChain } });
    await assert.rejects(async () => f.discover({ wallet }), unavailable);
    assert.equal(f.reads.length, 0);
  }
  for (const code of [undefined, null, '0x', '0x00', '0x0000', '0x0', '0xzz', 1, []]) {
    const f = fixture({ client: { getBytecode: async () => code } });
    await assert.rejects(async () => f.discover({ wallet }), unavailable);
    assert.equal(f.batches.length, 0);
  }
});

test('scan bounds are inclusive and impossible balances or mint counters fail before aggregation', async () => {
  const boundary = fixture({ owners: { '12': wallet }, minted: 12n, config: { maxScan: 12 } });
  assert.deepEqual((await boundary.discover({ wallet })).tokenIds, ['12']);
  for (const options of [{ minted: 4445n }, { minted: 13n, config: { maxScan: 12 } },
    ...[null, '1', 1, -1n, 4445n, BigInt(Number.MAX_SAFE_INTEGER) + 1n].map(balance => ({ balance })),
    ...[null, '12', 12, -1n, 0n].map(minted => ({ minted }))]) {
    const f = fixture(options);
    await assert.rejects(async () => f.discover({ wallet }), unavailable);
    assert.equal(f.batches.length, 0);
  }
  for (const value of [null, '12345', 12345, -1n]) {
    const f = fixture({ client: { getBlockNumber: async () => value } });
    await assert.rejects(async () => f.discover({ wallet }), unavailable);
    assert.equal(f.reads.length, 0);
  }
});

test('factory resource bounds must be positive safe integers', async () => {
  for (const field of ['timeoutMs', 'maxScan', 'batchSize', 'maxConcurrent']) {
    for (const value of [0, -1, 1.5, '2', null, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(async () => fixture({ config: { [field]: value } }).discover({ wallet }), unavailable, `${field}=${String(value)}`);
    }
  }
});

test('malformed or partial aggregate replies fail closed', async () => {
  const cases = [
    ['null', () => null], ['object', () => ({})], ['empty', () => []],
    ['short', rows => rows.slice(0, -1)], ['extra', rows => [...rows, rows[0]]],
    ['missing record', rows => [undefined, ...rows.slice(1)]],
    ['missing success', rows => [{ returnData: rows[0].returnData }, ...rows.slice(1)]],
    ['string success', rows => [{ ...rows[0], success: 'true' }, ...rows.slice(1)]],
    ['missing data', rows => [{ success: true }, ...rows.slice(1)]],
    ['empty data', rows => [{ success: true, returnData: '0x' }, ...rows.slice(1)]],
    ['short address', rows => [{ success: true, returnData: wallet }, ...rows.slice(1)]],
    ['nonhex address', rows => [{ success: true, returnData: '0x' + 'zz'.repeat(32) }, ...rows.slice(1)]],
    ['noncanonical padding', rows => [{ success: true, returnData: '0x' + 'ff'.repeat(12) + wallet.slice(2) }, ...rows.slice(1)]],
    ['extra address bytes', rows => [{ success: true, returnData: rows[0].returnData + '00' }, ...rows.slice(1)]],
    ['zero owner', rows => [{ success: true, returnData: '0x' + '00'.repeat(32) }, ...rows.slice(1)]],
  ];
  for (const [name, aggregate] of cases) {
    const f = fixture({ aggregate, config: { batchSize: 4 } });
    await assert.rejects(async () => f.discover({ wallet }), unavailable, name);
  }
});

test('only the exact nonexistent-owner revert selector is tolerated', async () => {
  for (const returnData of ['0x', '0xdeadbeef', '0xdf2d9b4200', null, ['0xdf2d9b42']]) {
    const f = fixture({ aggregate: rows => [{ success: false, returnData }, ...rows.slice(1)] });
    await assert.rejects(async () => f.discover({ wallet }), unavailable);
  }
});

test('a count disagreement denies the entire snapshot, including an overcount', async () => {
  for (const balance of [1n, 3n]) {
    const f = fixture({ owners: { '2': wallet, '10': wallet }, balance, config: { batchSize: 4 } });
    await assert.rejects(async () => f.discover({ wallet }), unavailable);
  }
});

test('RPC failures expose only the unavailable error', async () => {
  for (const method of ['getChainId', 'getBlockNumber', 'getBytecode', 'readContract']) {
    const f = fixture({ client: { [method]: async () => { throw new Error('PRIVATE_FIXTURE_RPC_DETAIL'); } } });
    await assert.rejects(async () => f.discover({ wallet }), unavailable);
  }
});

test('the discovery deadline also covers a stalled aggregate and releases its in-flight slot', { timeout: 2000 }, async () => {
  let stall = true;
  const f = fixture({ config: { timeoutMs: 20, maxConcurrent: 1 },
    aggregate: rows => stall ? new Promise(() => {}) : rows });
  await assert.rejects(async () => f.discover({ wallet }), unavailable);
  stall = false;
  assert.deepEqual((await f.discover({ wallet })).tokenIds, ['2']);
});

test('same-wallet concurrent discoveries share one promise and one scan, then refresh after completion', async () => {
  let release, entered;
  const held = new Promise(resolveHeld => { release = resolveHeld; });
  const scanning = new Promise(resolveScanning => { entered = resolveScanning; });
  const f = fixture({ minted: 3n, aggregate: async rows => { entered(); await held; return rows; } });
  const first = f.discover({ wallet });
  const repeated = f.discover({ wallet: getAddress(wallet) });
  assert.strictEqual(repeated, first);
  await scanning;
  assert.strictEqual(f.discover({ wallet }), first);
  release();
  assert.deepEqual(await repeated, await first);
  assert.equal(f.reads.filter(input => input.functionName === 'balanceOf').length, 1);
  assert.equal(f.reads.filter(input => input.functionName === 'saleMinted').length, 1);
  assert.equal(f.batches.length, 1);
  await f.discover({ wallet });
  assert.equal(f.reads.filter(input => input.functionName === 'balanceOf').length, 2);
  assert.equal(f.batches.length, 2);
});

test('distinct wallet discovery is capped while coalesced requests remain admitted and completed slots reopen', async () => {
  let release, entered;
  const held = new Promise(resolveHeld => { release = resolveHeld; });
  const bothScanning = new Promise(resolveScanning => { entered = resolveScanning; });
  let active = 0, maximumActive = 0;
  const f = fixture({ owners: { '1': wallet, '2': otherWallet }, minted: 3n,
    config: { maxConcurrent: 2 }, aggregate: async rows => {
      active++; maximumActive = Math.max(maximumActive, active);
      if (active === 2) entered();
      await held;
      active--;
      return rows;
    } });
  const first = f.discover({ wallet });
  const second = f.discover({ wallet: otherWallet });
  await bothScanning;
  assert.strictEqual(f.discover({ wallet }), first);
  await assert.rejects(async () => f.discover({ wallet: unownedWallet }), unavailable);
  assert.equal(f.reads.filter(input => input.functionName === 'balanceOf').length, 2);
  assert.equal(maximumActive, 2);
  release();
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map(result => result.tokenIds), [['1'], ['2']]);
  assert.deepEqual((await f.discover({ wallet: unownedWallet })).tokenIds, []);
  assert.equal(f.reads.filter(input => input.functionName === 'balanceOf').length, 3);
  assert.equal(maximumActive, 2);
});
