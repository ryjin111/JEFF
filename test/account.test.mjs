import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { createAccountSessions } from '../src/account-auth.mjs';
import { createHolderSessions } from '../src/auth.mjs';
import { createJeffOpenClawAccountBridge } from 'jeff-agent-nft/openclaw';
import { createHostingLedger } from '../src/hosting.mjs';
const wallet = privateKeyToAccount('0x' + '12'.repeat(32));
const other = privateKeyToAccount('0x' + '34'.repeat(32));
const chainId = 4663, origin = 'https://account-test.invalid';

test('standalone signature creates a durable account; sessions are one-use, expire, logout and stay distinct from NFT login', async t => {
  const dataRoot = await mkdtemp(resolve('test', '.account-'));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  let time = Date.now();
  const options = { origin, chainId, dataRoot, now: () => time };
  const sessions = createAccountSessions(options);
  const challenge = await sessions.challenge({ wallet: wallet.address });
  const signature = await wallet.signMessage({ message: challenge.message });
  const holder = createHolderSessions({ origin, chainId, collection: '0x' + '11'.repeat(20), resolveOwner: async () => { throw Error('NFT_MUST_NOT_BE_READ'); } });
  await assert.rejects(holder.verify({ nonce: challenge.nonce, signature }), /CHALLENGE_EXPIRED/);
  const session = await sessions.verify({ nonce: challenge.nonce, signature });
  assert.deepEqual(session.scope, { kind: 'account', chainId, owner: wallet.address.toLowerCase() });
  assert.deepEqual(await sessions.authenticate(session.token), session.scope);
  await assert.rejects(sessions.verify({ nonce: challenge.nonce, signature }), /CHALLENGE_EXPIRED/);
  const restarted = createAccountSessions(options);
  assert.equal(await restarted.registered(session.scope), true);
  await assert.rejects(restarted.authenticate(session.token), /SESSION_REQUIRED/);
  time += 3600000; await assert.rejects(sessions.authenticate(session.token), /SESSION_REQUIRED/);
  const fresh = await sessions.challenge({ wallet: wallet.address });
  const signed = await sessions.verify({ nonce: fresh.nonce, signature: await wallet.signMessage({ message: fresh.message }) });
  sessions.logout(signed.token); await assert.rejects(sessions.authenticate(signed.token), /SESSION_REQUIRED/);
  const wrong = await sessions.challenge({ wallet: wallet.address });
  await assert.rejects(sessions.verify({ nonce: wrong.nonce, signature: await other.signMessage({ message: wrong.message }) }), /SIGNATURE_INVALID/);
  assert.equal(await sessions.registered({ kind: 'account', chainId, owner: other.address.toLowerCase() }), false);
});

test('standalone job history is wallet scoped; NFT pilot time cannot fund an account', async t => {
  const dataRoot = await mkdtemp(resolve('test', '.account-'));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const sessions = createAccountSessions({ origin, chainId, dataRoot });
  const challenge = await sessions.challenge({ wallet: wallet.address });
  const { scope } = await sessions.verify({ nonce: challenge.nonce, signature: await wallet.signMessage({ message: challenge.message }) });
  const options = { dataRoot, resolveAccount: sessions.registered, runAgent: async () => ({ text: 'Explicit fixture.', model: 'fixture' }) };
  const result = await createJeffOpenClawAccountBridge(options).run(scope, 'Account fixture');
  assert.equal((await createJeffOpenClawAccountBridge(options).list(scope))[0].id, result.id);
  await assert.rejects(createJeffOpenClawAccountBridge(options).retrieve({ ...scope, owner: other.address.toLowerCase() }, result.id), /ACCOUNT_DENIED/);
  const ledger = createHostingLedger({ dataRoot, env: { JEFF_PILOT_NFTS: '35', JEFF_PILOT_EXPIRES_AT: '2099-01-01' } });
  assert.equal((await ledger.status(scope)).active, false);
  assert.equal((await ledger.status({ chainId, collection: '0x' + '11'.repeat(20), tokenId: '35' })).active, true);
});

test('a paid standalone term stays bound to its account and cannot activate an NFT or another wallet', async t => {
  const dataRoot = await mkdtemp(resolve('test', '.account-bill-'));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const ledger = createHostingLedger({ dataRoot, env: { JEFF_PAID_CHECKOUT_ENABLED: 'true', CLOCKERS_MONTHLY_AMOUNT: '100', CLOCKERS_PAYMENT_RECIPIENT: other.address }, verifyPayment: async () => {} });
  const scope = { kind: 'account', chainId, owner: wallet.address.toLowerCase() };
  const invoice = await ledger.invoice(scope);
  await ledger.activate(scope, { invoiceId: invoice.id, transactionHash: '0x' + 'aa'.repeat(32) });
  assert.equal((await ledger.status(scope)).active, true);
  assert.equal((await ledger.status({ ...scope, owner: other.address.toLowerCase() })).active, false);
  assert.equal((await ledger.status({ chainId, collection: '0x' + '11'.repeat(20), tokenId: '35', owner: scope.owner, ownerEpoch: 0 })).active, false);
});
