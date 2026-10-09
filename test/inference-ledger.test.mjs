import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createInferenceLedger } from '../src/inference-ledger.mjs';

const testRoot = dirname(fileURLToPath(import.meta.url));
const scope = { chainId: 4663, owner: '0x' + '11'.repeat(20) };
const other = { chainId: 4663, owner: '0x' + '22'.repeat(20) };
async function fixture(t, funded = 1000) {
  const root = await mkdtemp(resolve(testRoot, '.inference-ledger-'));
  let currentTime = Date.parse('2026-10-07T00:00:00Z');
  const connections = [];
  const open = () => { const ledger = createInferenceLedger({ dataRoot: root, now: () => currentTime }); connections.push(ledger); return ledger; };
  const ledger = open();
  t.after(async () => { for (const item of connections) item.close(); assert.equal(dirname(root), testRoot); await rm(root, { recursive: true, force: true }); });
  if (funded) {
    ledger.fund({ receiptId: 'settled-provider-receipt', amountMicros: funded });
    ledger.grant({ grantId: 'epoch-wallet-grant', receiptId: 'settled-provider-receipt', chainId: scope.chainId, wallet: scope.owner, amountMicros: funded });
  }
  return { root, ledger, open, advance(ms) { currentTime += ms; }, reserve(id, amountMicros = 100, dailyLimitMicros = 1000, target = ledger) {
    return target.reserve({ id, scope, amountMicros, dailyLimitMicros });
  } };
}

test('only settled operator funding can back grants; repeated receipts and grants cannot create capacity', async t => {
  const f = await fixture(t, 0);
  assert.throws(() => f.ledger.grant({ grantId: 'missing', receiptId: 'unknown', chainId: scope.chainId, wallet: scope.owner, amountMicros: 1 }), /FUNDING_EXHAUSTED/);
  f.ledger.fund({ receiptId: 'fund', amountMicros: 1000 });
  f.ledger.fund({ receiptId: 'fund', amountMicros: 1000 });
  assert.throws(() => f.ledger.fund({ receiptId: 'fund', amountMicros: 1001 }), /REPLAY_CONFLICT/);
  const grant = { grantId: 'grant', receiptId: 'fund', chainId: scope.chainId, wallet: scope.owner, amountMicros: 700 };
  f.ledger.grant(grant); f.open().grant(grant);
  assert.throws(() => f.ledger.grant({ ...grant, wallet: other.owner }), /REPLAY_CONFLICT/);
  assert.throws(() => f.ledger.grant({ ...grant, grantId: 'over', amountMicros: 301 }), /FUNDING_EXHAUSTED/);
  assert.equal(f.ledger.totals().unallocatedMicros, 300);
  assert.equal(f.ledger.balance(scope).availableMicros, 700);
});

test('wallet credits stay with their earning wallet across NFT transfers and separate chains', async t => {
  const f = await fixture(t);
  assert.equal(f.ledger.balance({ ...scope, tokenId: '35', ownerEpoch: 0 }).availableMicros, 1000);
  assert.equal(f.ledger.balance({ ...other, tokenId: '35', ownerEpoch: 1 }).availableMicros, 0);
  assert.equal(f.ledger.balance({ ...scope, tokenId: '35', ownerEpoch: 2 }).availableMicros, 1000);
  assert.equal(f.ledger.balance({ ...scope, chainId: 1 }).availableMicros, 0);
  assert.equal(f.ledger.balance({ ...scope, owner: scope.owner.toUpperCase().replace('0X','0x') }).availableMicros, 1000);
});

test('reserving the last unit through two independent ledger connections admits one caller', async t => {
  const f = await fixture(t, 1), second = f.open();
  const attempts = await Promise.allSettled([
    Promise.resolve().then(() => f.reserve('one', 1, 1)),
    Promise.resolve().then(() => f.reserve('two', 1, 1, second)),
  ]);
  assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 1);
  assert.match(attempts.find(item => item.status === 'rejected').reason.message, /BALANCE_EXHAUSTED/);
  assert.equal(second.balance(scope).heldMicros, 1);
});

test('separate processes cannot spend the same final microUSD', async t => {
  const f = await fixture(t, 1);
  const moduleUrl = new URL('../src/inference-ledger.mjs', import.meta.url).href;
  const code = `import {createInferenceLedger} from ${JSON.stringify(moduleUrl)};
    const l=createInferenceLedger({dataRoot:process.argv[1]});
    try {l.reserve({id:process.argv[2],scope:${JSON.stringify(scope)},amountMicros:1,dailyLimitMicros:1});process.stdout.write('accepted');}
    catch(e){process.stdout.write(e.message);}finally{l.close();}`;
  const run = id => new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, f.root, id], { windowsHide: true, stdio: ['ignore','pipe','pipe'] });
    let output = '', diagnostic = '';
    child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { diagnostic += value; });
    child.on('error', reject); child.on('close', status => status === 0 ? resolveResult(output) : reject(new Error(diagnostic)));
  });
  const outcomes = await Promise.all([run('process-one'), run('process-two')]);
  assert.equal(outcomes.filter(value => value === 'accepted').length, 1);
  assert.equal(outcomes.filter(value => value === 'JEFF_INFERENCE_BALANCE_EXHAUSTED').length, 1);
  assert.equal(f.ledger.balance(scope).heldMicros, 1);
});

test('a reservation is durable, retries bind its exact scope and amount, and charges refund unused hold', async t => {
  const f = await fixture(t);
  const input = { id: 'job:attempt', scope, amountMicros: 100, dailyLimitMicros: 1000, details: { model: 'fixture' } };
  f.ledger.reserve(input);
  assert.equal(f.open().balance(scope).heldMicros, 100);
  assert.deepEqual(f.ledger.reserve(input), f.open().reserve(input));
  assert.throws(() => f.ledger.reserve({ ...input, scope: other }), /REPLAY_CONFLICT/);
  assert.throws(() => f.ledger.reserve({ ...input, amountMicros: 101 }), /REPLAY_CONFLICT/);
  f.ledger.markForwarded(input.id);
  const charged = f.ledger.settle({ id: input.id, chargedMicros: 23, outcome: 'charged', details: { pricingBasis: 'operator-token-tariff' } });
  assert.equal(charged.state, 'charged');
  assert.deepEqual(f.ledger.balance(scope), f.open().balance(scope));
  assert.equal(f.ledger.balance(scope).availableMicros, 977);
  assert.equal(f.ledger.reserve(input).chargedMicros, 23);
  assert.equal(f.ledger.settle({ id: input.id, chargedMicros: 23 }).chargedMicros, 23);
  assert.throws(() => f.ledger.settle({ id: input.id, chargedMicros: 24 }), /REPLAY_CONFLICT/);
});

test('unknown provider outcomes survive restart and require explicit idempotent reconciliation', async t => {
  const f = await fixture(t);
  f.reserve('unknown', 400); f.ledger.markForwarded('unknown');
  f.ledger.settle({ id: 'unknown', outcome: 'unknown' });
  const reopened = f.open();
  assert.equal(reopened.balance(scope).heldMicros, 400);
  assert.throws(() => reopened.release('unknown'), /RECONCILIATION_REQUIRED/);
  reopened.reconcile({ id: 'unknown', chargedMicros: 17, evidenceId: 'provider-record-1' });
  reopened.reconcile({ id: 'unknown', chargedMicros: 17, evidenceId: 'provider-record-1' });
  assert.throws(() => reopened.reconcile({ id: 'unknown', chargedMicros: 0, evidenceId: 'provider-record-1' }), /REPLAY_CONFLICT/);
  assert.equal(reopened.balance(scope).heldMicros, 0); assert.equal(reopened.balance(scope).chargedMicros, 17);
  f.reserve('other-unknown'); f.ledger.markForwarded('other-unknown');
  assert.throws(() => reopened.reconcile({ id: 'other-unknown', chargedMicros: 17, evidenceId: 'provider-record-1' }), /REPLAY_CONFLICT/);
});

test('only known unforwarded requests can be released without reconciliation', async t => {
  const f = await fixture(t);
  f.reserve('not-forwarded'); assert.equal(f.open().release('not-forwarded').state, 'released');
  assert.equal(f.ledger.release('not-forwarded').state, 'released');
  f.reserve('forwarded'); f.ledger.markForwarded('forwarded');
  assert.throws(() => f.ledger.release('forwarded'), /RECONCILIATION_REQUIRED/);
  assert.throws(() => f.ledger.markForwarded('forwarded'), /ALREADY_FORWARDED/);
  f.ledger.reconcile({ id: 'forwarded', chargedMicros: 0, evidenceId: 'confirmed-no-debit' });
  assert.equal(f.ledger.balance(scope).availableMicros, 1000);
});

test('charges exceeding reservation or using fractional units never consume available credit', async t => {
  const f = await fixture(t);
  f.reserve('held', 10); f.ledger.markForwarded('held');
  for (const chargedMicros of [11, -1, 0.5, NaN, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => f.ledger.settle({ id: 'held', chargedMicros }), /CHARGE_INVALID/);
  assert.equal(f.ledger.balance(scope).heldMicros, 10); assert.equal(f.ledger.balance(scope).chargedMicros, 0);
});

test('rolling daily limits include all unresolved holds and release settled charges at their boundary', async t => {
  const f = await fixture(t);
  f.reserve('first', 60, 100); f.ledger.markForwarded('first'); f.ledger.settle({ id: 'first', chargedMicros: 60 });
  f.reserve('uncertain', 40, 100); f.ledger.markForwarded('uncertain'); f.ledger.settle({ id: 'uncertain', outcome: 'unknown' });
  assert.throws(() => f.reserve('denied', 1, 100), /DAILY_LIMIT_REACHED/);
  f.advance(86400000 - 1); assert.throws(() => f.reserve('early', 61, 100), /DAILY_LIMIT_REACHED/);
  f.advance(1); f.reserve('boundary', 60, 100);
  f.advance(86400000); assert.throws(() => f.reserve('unknown-still-held', 1, 100), /DAILY_LIMIT_REACHED/);
  assert.equal(f.ledger.balance(scope).heldMicros, 100);
});

test('pause and every restore marker fail closed for new spending while preserving settlement and balances', async t => {
  const f = await fixture(t);
  f.reserve('already-forwarded'); f.ledger.markForwarded('already-forwarded');
  f.ledger.setPaused(true); assert.throws(() => f.reserve('paused'), /PAUSED/);
  assert.equal(f.open().balance(scope).paused, true);
  f.ledger.settle({ id: 'already-forwarded', chargedMicros: 5 });
  f.ledger.setPaused(false);
  await mkdir(resolve(f.root, 'hosting'), { recursive: true });
  await writeFile(resolve(f.root, 'hosting', 'restore-guard.json'), '');
  assert.equal(f.open().balance(scope).restoreBlocked, true);
  assert.throws(() => f.reserve('restored'), /RESTORE_RECONCILIATION_REQUIRED/);
  assert.throws(() => f.ledger.grant({ grantId: 'restore-replay', receiptId: 'settled-provider-receipt', chainId: scope.chainId, wallet: scope.owner, amountMicros: 1 }), /RESTORE_RECONCILIATION_REQUIRED/);
  assert.equal(f.ledger.balance(scope).chargedMicros, 5);
});

test('funding conservation holds across grants, held calls, charges and refunds without reissuing spent funds', async t => {
  const f = await fixture(t);
  f.reserve('one', 100); f.ledger.markForwarded('one'); f.ledger.settle({ id: 'one', chargedMicros: 3 });
  f.reserve('two', 100); f.ledger.release('two');
  f.reserve('three', 100); f.ledger.markForwarded('three'); f.ledger.settle({ id: 'three', outcome: 'unknown' });
  const totals = f.open().totals();
  assert.equal(totals.fundedMicros, totals.unallocatedMicros + totals.outstandingMicros + totals.chargedMicros);
  assert.equal(totals.grantedMicros, f.ledger.balance(scope).availableMicros + totals.heldMicros + totals.chargedMicros);
  assert.throws(() => f.ledger.grant({ grantId: 'recycle', receiptId: 'settled-provider-receipt', chainId: other.chainId, wallet: other.owner, amountMicros: 3 }), /FUNDING_EXHAUSTED/);
  assert.equal(f.ledger.list(other).length, 0);
  assert.equal(f.ledger.list(scope).length, 4);
});

test('unsafe units, invalid wallets and total overflow are rejected', async t => {
  const f = await fixture(t, 0);
  for (const amountMicros of [0, -1, 1.1, '1', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => f.ledger.fund({ receiptId: 'invalid', amountMicros }), /FUNDING_INVALID/);
  f.ledger.fund({ receiptId: 'maximum', amountMicros: Number.MAX_SAFE_INTEGER });
  assert.throws(() => f.ledger.fund({ receiptId: 'overflow', amountMicros: 1 }), /AMOUNT_OVERFLOW/);
  for (const bad of [{ ...scope, chainId: 0 }, { ...scope, owner: '0x' + '0'.repeat(40) }, { ...scope, owner: '../wallet' }]) assert.throws(() => f.ledger.balance(bad), /SCOPE_INVALID/);
});

test('per-agent rolling budgets remain separate while all agents share one wallet balance', async t => {
  const f = await fixture(t), a = 'a'.repeat(64), b = 'b'.repeat(64), epoch = 'c'.repeat(64);
  const reserve = (id, budgetScopeId) => f.ledger.reserve({ id, scope, amountMicros: 100, dailyLimitMicros: 100, budgetScopeId });
  reserve('agent-a', a); reserve('agent-b', b);
  assert.throws(() => reserve('agent-a-second', a), /DAILY_LIMIT_REACHED/);
  reserve('same-nft-new-epoch', epoch);
  assert.equal(f.ledger.balance(scope).availableMicros, 700);
  f.ledger.release('agent-a');
  f.reserve('legacy-hold', 1, 1000);
  assert.throws(() => reserve('legacy-counts-conservatively', a), /DAILY_LIMIT_REACHED/);
  assert.throws(() => f.ledger.reserve({ id: 'invalid-scope', scope, amountMicros: 1, dailyLimitMicros: 100, budgetScopeId: '../arbitrary' }), /SCOPE_INVALID/);
});

test('missing pause metadata fails closed across restart instead of restoring an enabled default', async t => {
  const f = await fixture(t);
  f.ledger.setPaused(true); f.ledger.close();
  const tampered = new DatabaseSync(f.ledger.file);
  tampered.exec("DELETE FROM inference_meta WHERE key='paused'"); tampered.close();
  assert.throws(() => f.open(), /STORAGE_UNAVAILABLE/);
});

test('a lost initialized database cannot silently recreate funding receipts or erase unknown provider holds', async t => {
  const f = await fixture(t);
  f.reserve('unknown-before-loss', 400); f.ledger.markForwarded('unknown-before-loss');
  f.ledger.settle({ id: 'unknown-before-loss', outcome: 'unknown' });
  f.ledger.close();
  await rm(f.ledger.file);
  assert.throws(() => f.open(), /JEFF_INFERENCE_STORAGE_UNAVAILABLE/);
  await assert.rejects(readFile(f.ledger.file), { code: 'ENOENT' });
});

test('legacy inference databases gain a loss guard while preserving funding and unresolved holds', async t => {
  const f = await fixture(t);
  f.reserve('legacy-unknown', 400); f.ledger.markForwarded('legacy-unknown');
  f.ledger.settle({ id: 'legacy-unknown', outcome: 'unknown' });
  const balance = f.ledger.balance(scope), history = f.ledger.list(scope);
  const marker = resolve(f.root, 'inference', 'ledger-initialized.json');
  f.ledger.close(); await rm(marker, { force: true });
  const reopened = f.open();
  assert.deepEqual(reopened.balance(scope), balance);
  assert.deepEqual(reopened.list(scope), history);
  assert.equal(JSON.parse(await readFile(marker, 'utf8')).schema, 'simple-jeff-inference-initialized-v1');
  reopened.close(); await rm(reopened.file);
  assert.throws(() => f.open(), /JEFF_INFERENCE_STORAGE_UNAVAILABLE/);
});
