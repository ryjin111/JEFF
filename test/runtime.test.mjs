import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createJeffOpenClawNftBridge, jeffOpenClawWorkspaceId } from 'jeff-agent-nft/openclaw';
import { createHolderSessions } from '../src/auth.mjs';
import { privateKeyToAccount } from 'viem/accounts';

const account = privateKeyToAccount('0x' + '11'.repeat(32)); // Disposable test-only account.
const owner = account.address.toLowerCase();
const otherOwner = '0x' + '22'.repeat(20);
const scope = { chainId: 4663, collection: '0x' + '33'.repeat(20), tokenId: '35', owner, ownerEpoch: 0 };
async function fixture(t, runAgent = async () => ({ text: 'Useful result', model: 'test-double' })) {
  const dataRoot = await mkdtemp(resolve('test', '.runtime-'));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  let state = { owner, ownerEpoch: 0 };
  const resolveOwner = async () => state;
  const options = { dataRoot, resolveOwner, runAgent };
  return { dataRoot, options, bridge: createJeffOpenClawNftBridge(options), setState(value) { state = value; } };
}

test('saved result survives a new bridge instance and tampering is detected', async t => {
  const f = await fixture(t);
  const result = await f.bridge.run(scope, 'Create a checklist');
  const reopened = createJeffOpenClawNftBridge(f.options);
  assert.deepEqual(await reopened.retrieve(scope, result.id), result);
  const file = resolve(f.dataRoot, jeffOpenClawWorkspaceId(scope), 'results', `${result.id}.json`);
  await writeFile(file, JSON.stringify({ ...result, text: 'Changed after saving' }));
  await assert.rejects(reopened.retrieve(scope, result.id), /RESULT_INVALID/);
});

test('transfer revokes old workspace and returning owner gets a new epoch', async t => {
  const f = await fixture(t);
  const result = await f.bridge.run(scope, 'Create a checklist');
  f.setState({ owner: otherOwner, ownerEpoch: 1 });
  await assert.rejects(f.bridge.retrieve(scope, result.id), /OWNER_REVOKED/);
  await assert.rejects(f.bridge.retrieve({ ...scope, owner: otherOwner, ownerEpoch: 1 }, result.id), /NOT_FOUND/);
  f.setState({ owner, ownerEpoch: 2 });
  await assert.rejects(f.bridge.retrieve(scope, result.id), /OWNER_REVOKED/);
  await assert.rejects(f.bridge.retrieve({ ...scope, ownerEpoch: 2 }, result.id), /NOT_FOUND/);
});

test('ownership change during a job discards the completed output', async t => {
  let f;
  f = await fixture(t, async () => { f.setState({ owner: otherOwner, ownerEpoch: 1 }); return { text: 'Private result' }; });
  await assert.rejects(f.bridge.run(scope, 'Summarize'), /OWNER_REVOKED/);
  const directory = resolve(f.dataRoot, jeffOpenClawWorkspaceId(scope), 'results');
  const [filename] = await readdir(directory);
  const record = JSON.parse(await readFile(resolve(directory, filename), 'utf8'));
  assert.equal(record.status, 'failed'); assert.equal(record.text, undefined);
});

test('overlapping jobs in one owner workspace are rejected', async t => {
  let finish;
  let entered;
  const started = new Promise(resolveStarted => { entered = resolveStarted; });
  const f = await fixture(t, async () => { entered(); return new Promise(resolveRun => { finish = resolveRun; }); });
  const first = f.bridge.run(scope, 'First job');
  await started;
  await assert.rejects(f.bridge.run(scope, 'Second job'), /BUSY/);
  finish({ text: 'First result' }); await first;
});

test('wallet signature login is one-use; logout, expiry and A-B-A transfer revoke sessions', async () => {
  let time = 1000000; let state = { owner, ownerEpoch: 0 };
  const sessions = createHolderSessions({ origin: 'http://127.0.0.1:8788', chainId: scope.chainId,
    collection: scope.collection, resolveOwner: async () => state, now: () => time });
  async function login() {
    const challenge = await sessions.challenge({ wallet: owner, tokenId: scope.tokenId });
    const signature = await account.signMessage({ message: challenge.message });
    return { challenge, signature, session: await sessions.verify({ nonce: challenge.nonce, signature }) };
  }
  const first = await login();
  await assert.rejects(sessions.verify({ nonce: first.challenge.nonce, signature: first.signature }), /CHALLENGE_EXPIRED/);
  assert.deepEqual(await sessions.authenticate(first.session.token), scope);
  sessions.logout(first.session.token);
  await assert.rejects(sessions.authenticate(first.session.token), /SESSION_REQUIRED/);
  const second = await login(); time += 3600001;
  await assert.rejects(sessions.authenticate(second.session.token), /SESSION_REQUIRED/);
  const third = await login(); state = { owner, ownerEpoch: 2 };
  await assert.rejects(sessions.authenticate(third.session.token), /SESSION_REVOKED/);
});

test('a different signer cannot authenticate as the holder', async () => {
  const sessions = createHolderSessions({ origin: 'http://127.0.0.1:8788', chainId: scope.chainId,
    collection: scope.collection, resolveOwner: async () => ({ owner, ownerEpoch: 0 }) });
  const challenge = await sessions.challenge({ wallet: owner, tokenId: scope.tokenId });
  const other = privateKeyToAccount('0x' + '22'.repeat(32));
  const signature = await other.signMessage({ message: challenge.message });
  await assert.rejects(sessions.verify({ nonce: challenge.nonce, signature }), /OWNER_REQUIRED/);
});

test('unavailable chain fails closed on private result retrieval', async t => {
  const f = await fixture(t);
  const result = await f.bridge.run(scope, 'Summarize');
  const reopened = createJeffOpenClawNftBridge({ ...f.options, resolveOwner: async () => { throw new Error('RPC unavailable'); } });
  await assert.rejects(reopened.retrieve(scope, result.id), /RPC unavailable/);
});
