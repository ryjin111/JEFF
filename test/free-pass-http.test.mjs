import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeFunctionData, encodeAbiParameters, parseAbi, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const testRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(testRoot);
const chainId = 4663;
const collection = '0x' + '11'.repeat(20);
const tokenId = '35';
// Explicit disposable signing fixtures. These keys are never used with a live RPC.
const firstHolder = privateKeyToAccount('0x' + '12'.repeat(32));
const nextHolder = privateKeyToAccount('0x' + '34'.repeat(32));
const ownershipAbi = parseAbi(['function ownerOf(uint256) view returns (address)', 'function transferNonceOf(uint256) view returns (uint64)']);

async function listen(server) {
  await new Promise((resolveReady, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveReady);
  });
  return server.address().port;
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise(resolveClosed => {
    server.close(resolveClosed);
    server.closeAllConnections();
  });
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close');
  child.kill();
  await closed;
}

async function startApplication({ port, dataRoot, rpcUrl }) {
  const origin = `http://127.0.0.1:${port}`;
  const childEnv = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'LANG']
    .filter(key => process.env[key]).map(key => [key, process.env[key]]));
  Object.assign(childEnv, {
    PORT: String(port), JEFF_BIND: '127.0.0.1', JEFF_PUBLIC_ORIGIN: origin,
    JEFF_CHAIN_ID: String(chainId), JEFF_COLLECTION: collection, JEFF_RPC_URL: rpcUrl,
    JEFF_DATA_ROOT: dataRoot, JEFF_MAINTENANCE_MARKER: resolve(dataRoot, 'maintenance.json'),
    JEFF_FREE_PASS_ENABLED: 'true', JEFF_PAID_CHECKOUT_ENABLED: 'false',
    JEFF_PILOT_NFTS: '', JEFF_PILOT_EXPIRES_AT: '', JEFF_VERIFY_RUNTIME: 'false',
    JEFF_CONTINUOUS_HOSTING: 'false', BANKR_LLM_API_KEY: '', BANKR_LLM_URL: rpcUrl,
    TEMP: resolve(dataRoot, 'tmp'), TMP: resolve(dataRoot, 'tmp'),
    NODE_COMPILE_CACHE: resolve(dataRoot, 'compile-cache'),
  });
  await mkdir(childEnv.TEMP, { recursive: true });
  const child = spawn(process.execPath, [resolve(repoRoot, 'src', 'server.mjs')], {
    cwd: repoRoot, env: childEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let diagnostics = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-8192); });
  const ready = new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error(`HTTP fixture startup timed out: ${diagnostics}`)), 15000);
    const failed = error => { clearTimeout(timer); reject(error); };
    child.once('error', failed);
    child.once('exit', code => failed(new Error(`HTTP fixture exited with code ${code}: ${diagnostics}`)));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output = (output + chunk).slice(-8192);
      if (output.includes(`Simple JEFF: ${origin}`)) { clearTimeout(timer); resolveReady(); }
    });
  });
  return { child, origin, ready };
}

test('HTTP free-pass redemption uses the signed holder scope and stays consumed after transfer', { timeout: 30000 }, async t => {
  const dataRoot = await mkdtemp(resolve(testRoot, '.free-pass-http-'));
  let rpc;
  let child;
  t.after(async () => {
    await stopChild(child);
    await closeServer(rpc);
    assert.equal(dirname(dataRoot), testRoot);
    await rm(dataRoot, { recursive: true, force: true });
  });

  let state = { owner: firstHolder.address.toLowerCase(), ownerEpoch: 0, blockNumber: 100n };
  const rpcRequests = [];
  const unexpectedRpc = [];
  const answer = input => {
    rpcRequests.push(input);
    if (input.method === 'eth_chainId') return { jsonrpc: '2.0', id: input.id, result: toHex(chainId) };
    if (input.method === 'eth_blockNumber') return { jsonrpc: '2.0', id: input.id, result: toHex(state.blockNumber) };
    if (input.method === 'eth_call') {
      try {
        const [call, block] = input.params;
        assert.equal(call.to.toLowerCase(), collection);
        assert.equal(block, toHex(state.blockNumber));
        const decoded = decodeFunctionData({ abi: ownershipAbi, data: call.data });
        assert.equal(decoded.args[0], BigInt(tokenId));
        const result = decoded.functionName === 'ownerOf'
          ? encodeAbiParameters([{ type: 'address' }], [state.owner])
          : encodeAbiParameters([{ type: 'uint64' }], [BigInt(state.ownerEpoch)]);
        return { jsonrpc: '2.0', id: input.id, result };
      } catch (error) {
        unexpectedRpc.push(error.message);
        return { jsonrpc: '2.0', id: input.id, error: { code: -32602, message: 'Invalid fixture call' } };
      }
    }
    unexpectedRpc.push(input.method);
    return { jsonrpc: '2.0', id: input.id, error: { code: -32601, message: 'Fixture method unavailable' } };
  };
  rpc = createServer(async (request, response) => {
    try {
      let contents = '';
      for await (const chunk of request) contents += chunk;
      const input = JSON.parse(contents);
      const result = Array.isArray(input) ? input.map(answer) : answer(input);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(result));
    } catch (error) {
      unexpectedRpc.push(error.message);
      response.writeHead(400); response.end();
    }
  });
  const rpcPort = await listen(rpc);
  const reservation = createServer();
  const port = await listen(reservation);
  await closeServer(reservation);
  const application = await startApplication({ port, dataRoot, rpcUrl: `http://127.0.0.1:${rpcPort}` });
  child = application.child;
  await application.ready;

  const request = async (path, { method = 'GET', session, body } = {}) => {
    const response = await fetch(application.origin + path, {
      method, signal: AbortSignal.timeout(5000),
      headers: { Origin: application.origin, Accept: 'application/json',
        ...(session ? { Authorization: `Bearer ${session}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  const login = async (holder, standalone = false) => {
    const prefix = standalone ? '/api/account/auth' : '/api/auth';
    const challenge = await request(`${prefix}/challenge`, { method: 'POST',
      body: { wallet: holder.address, ...(standalone ? {} : { tokenId }) } });
    assert.equal(challenge.status, 200);
    const signature = await holder.signMessage({ message: challenge.body.message });
    const verified = await request(`${prefix}/verify`, { method: 'POST', body: { nonce: challenge.body.nonce, signature } });
    assert.equal(verified.status, 200);
    assert.equal(verified.body.scope.owner, holder.address.toLowerCase());
    return verified.body;
  };

  const config = await request('/api/config');
  assert.equal(config.status, 200);
  assert.equal(config.body.freePassEnabled, true);
  assert.equal(config.body.modelConfigured, false);
  assert.equal(config.body.billingEnabled, false);
  for (const options of [{}, { method: 'POST', body: {} }]) {
    const denied = await request(options.method ? '/api/hosting/free-pass' : '/api/hosting', options);
    assert.equal(denied.status, 401);
    assert.equal(denied.body.error, 'JEFF_SESSION_REQUIRED');
  }

  const holderSession = await login(firstHolder);
  assert.equal(holderSession.scope.ownerEpoch, 0);
  const available = await request('/api/hosting', { session: holderSession.token });
  assert.equal(available.status, 200);
  assert.equal(available.body.freePass.state, 'available');
  assert.equal(available.body.active, false);
  for (const body of [{ tokenId: '36' },
    { chainId: 1, collection: '0x' + '55'.repeat(20), owner: nextHolder.address, ownerEpoch: 9 },
    { scope: { ...holderSession.scope, tokenId: '36' } }, [], null]) {
    const invalid = await request('/api/hosting/free-pass', { method: 'POST', session: holderSession.token, body });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error, 'JEFF_FREE_PASS_INVALID');
  }
  const ledgerFile = resolve(dataRoot, 'hosting', 'ledger.json');
  await assert.rejects(readFile(ledgerFile), { code: 'ENOENT' });

  const redeemed = await request('/api/hosting/free-pass', { method: 'POST', session: holderSession.token, body: {} });
  assert.equal(redeemed.status, 200);
  assert.equal(redeemed.body.active, true);
  assert.equal(redeemed.body.source, 'free-pass');
  assert.equal(redeemed.body.freePass.state, 'consumed');
  assert.equal(redeemed.body.usage.remaining, 100);
  assert.equal(Date.parse(redeemed.body.freePass.expiresAt) - Date.parse(redeemed.body.freePass.startsAt), 30 * 86400000);
  const ledgerContents = await readFile(ledgerFile, 'utf8');
  for (let retry = 0; retry < 2; retry++) {
    const replay = await request('/api/hosting/free-pass', { method: 'POST', session: holderSession.token, body: {} });
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body, redeemed.body);
  }

  const accountSession = await login(firstHolder, true);
  assert.equal(accountSession.scope.kind, 'account');
  const accountStatus = await request('/api/hosting', { session: accountSession.token });
  assert.equal(accountStatus.status, 200);
  assert.equal(accountStatus.body.freePass, null);
  assert.equal(accountStatus.body.active, false);
  const accountDenied = await request('/api/hosting/free-pass', { method: 'POST', session: accountSession.token, body: {} });
  assert.equal(accountDenied.status, 403);
  assert.equal(accountDenied.body.error, 'JEFF_FREE_PASS_DENIED');

  state = { owner: nextHolder.address.toLowerCase(), ownerEpoch: 1, blockNumber: 101n };
  const revoked = await request('/api/hosting', { session: holderSession.token });
  assert.equal(revoked.status, 401);
  assert.equal(revoked.body.error, 'JEFF_SESSION_REVOKED');
  const oldHolderDenied = await request('/api/hosting/free-pass', { method: 'POST', session: holderSession.token, body: {} });
  assert.equal(oldHolderDenied.status, 401);
  const nextSession = await login(nextHolder);
  assert.equal(nextSession.scope.ownerEpoch, 1);
  const inherited = await request('/api/hosting', { session: nextSession.token });
  assert.equal(inherited.status, 200);
  assert.equal(inherited.body.source, 'free-pass');
  assert.deepEqual(inherited.body.freePass, redeemed.body.freePass);
  const transferRetry = await request('/api/hosting/free-pass', { method: 'POST', session: nextSession.token, body: {} });
  assert.equal(transferRetry.status, 200);
  assert.deepEqual(transferRetry.body.freePass, redeemed.body.freePass);
  assert.equal(await readFile(ledgerFile, 'utf8'), ledgerContents);
  const stored = JSON.parse(ledgerContents);
  assert.equal(Object.keys(stored.freePasses).length, 1);
  const grant = Object.values(stored.entitlements)[0].periods;
  assert.equal(grant.length, 1);
  assert.equal(grant[0].id, Object.values(stored.freePasses)[0].periodId);
  assert.equal(grant[0].source, 'free-pass');
  assert.deepEqual(unexpectedRpc, []);
  assert.deepEqual(new Set(rpcRequests.map(input => input.method)), new Set(['eth_chainId', 'eth_blockNumber', 'eth_call']));
});
