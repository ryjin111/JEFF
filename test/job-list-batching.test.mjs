import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createJeffOpenClawNftBridge, createJeffOpenClawAccountBridge,
  jeffOpenClawWorkspaceId } from 'jeff-agent-nft/openclaw';

const scope = Object.freeze({ chainId: 4663, collection: '0x' + '22'.repeat(20),
  tokenId: '35', owner: '0x' + '11'.repeat(20), ownerEpoch: 7 });
const otherOwner = '0x' + '33'.repeat(20);
const hash = value => createHash('sha256').update(value).digest('hex');
const model = async () => ({ text: 'Synthetic fixture output.', model: 'fixture' });
async function fixture(t) {
  // Stay inside the project rather than the operating system temporary drive.
  const root = await mkdtemp(resolve('test', '.list-batch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function record(index = 0) {
  const text = `Synthetic saved response ${index}.`;
  return { schema: 'jeff-openclaw-job-v1', id: randomUUID(), scope, objective: 'Fixture input',
    status: 'completed', saved: true, startedAt: new Date(1700000000000 + index).toISOString(),
    finishedAt: '2023-11-14T22:14:00.000Z', runtime: 'openclaw', externalActionsAuthorized: false,
    text, textSha256: hash(text), model: 'fixture' };
}
async function seed(root, records, targetScope = scope) {
  const id = targetScope.kind === 'account' ? hash(JSON.stringify(targetScope)) : jeffOpenClawWorkspaceId(targetScope);
  const directory = resolve(root, id, 'results');
  await mkdir(directory, { recursive: true });
  for (const item of records) await writeFile(resolve(directory, `${item.id}.json`), JSON.stringify(item));
  return directory;
}

for (const count of [0, 1, 12]) test(`list checks ownership twice for ${count} saved records`, async t => {
  const root = await fixture(t), records = Array.from({ length: count }, (_, i) => record(i));
  await seed(root, records);
  let checks = 0;
  const bridge = createJeffOpenClawNftBridge({ dataRoot: root,
    resolveOwner: async () => { checks++; return scope; }, runAgent: model });
  const result = await bridge.list(scope);
  assert.equal(checks, 2);
  assert.deepEqual(result.map(item => item.id), [...records].reverse().map(item => item.id));
  if (count) { result[0].text = 'Caller mutation'; assert.equal((await bridge.retrieve(scope, records.at(-1).id)).text, records.at(-1).text); }
});

test('missing results directory still checks both list boundaries', async t => {
  const root = await fixture(t); let checks = 0;
  const bridge = createJeffOpenClawNftBridge({ dataRoot: root,
    resolveOwner: async () => { checks++; return scope; }, runAgent: model });
  assert.deepEqual(await bridge.list(scope), []);
  assert.equal(checks, 2);
});

for (const change of ['owner', 'epoch']) test(`list withholds all records when ${change} changes before final check`, async t => {
  const root = await fixture(t); await seed(root, [record(), record(1)]); let checks = 0;
  const bridge = createJeffOpenClawNftBridge({ dataRoot: root, runAgent: model,
    resolveOwner: async () => ++checks === 1 ? scope : { ...scope,
      ...(change === 'owner' ? { owner: otherOwner } : { ownerEpoch: scope.ownerEpoch + 1 }) } });
  await assert.rejects(bridge.list(scope), /JEFF_OPENCLAW_OWNER_REVOKED/);
  assert.equal(checks, 2);
});

test('revoked owner cannot begin a batch', async t => {
  const root = await fixture(t); let checks = 0;
  const bridge = createJeffOpenClawNftBridge({ dataRoot: root, runAgent: model,
    resolveOwner: async () => { checks++; return { ...scope, owner: otherOwner }; } });
  await assert.rejects(bridge.list(scope), /JEFF_OPENCLAW_OWNER_REVOKED/);
  assert.equal(checks, 1);
});

test('retrieve retains fresh ownership checks before and after reading', async t => {
  const root = await fixture(t), item = record(); await seed(root, [item]); let checks = 0, revoke = false;
  const bridge = createJeffOpenClawNftBridge({ dataRoot: root, runAgent: model,
    resolveOwner: async () => { checks++; return revoke && checks === 2 ? { ...scope, ownerEpoch: 8 } : scope; } });
  assert.equal((await bridge.retrieve(scope, item.id)).text, item.text); assert.equal(checks, 2);
  checks = 0; revoke = true;
  await assert.rejects(bridge.retrieve(scope, item.id), /JEFF_OPENCLAW_OWNER_REVOKED/); assert.equal(checks, 2);
});

for (const corrupt of ['scope', 'id', 'schema', 'textSha256']) test(`list and retrieve reject corrupt ${corrupt}`, async t => {
  const root = await fixture(t), item = record(), originalId = item.id;
  if (corrupt === 'scope') item.scope = { ...scope, owner: otherOwner };
  else if (corrupt === 'id') item.id = randomUUID();
  else if (corrupt === 'schema') item.schema = 'wrong-schema';
  else item.textSha256 = '00'.repeat(32);
  const directory = await seed(root, []);
  await writeFile(resolve(directory, `${originalId}.json`), JSON.stringify(item));
  const bridge = createJeffOpenClawNftBridge({ dataRoot: root, resolveOwner: async () => scope, runAgent: model });
  await assert.rejects(bridge.list(scope), /JEFF_OPENCLAW_RESULT_INVALID/);
  await assert.rejects(bridge.retrieve(scope, originalId), /JEFF_OPENCLAW_RESULT_INVALID/);
});

test('invalid JSON remains unreadable and unchecked reader is private', async t => {
  const root = await fixture(t), directory = await seed(root, []), id = randomUUID();
  await writeFile(resolve(directory, `${id}.json`), '{');
  const bridge = createJeffOpenClawNftBridge({ dataRoot: root, resolveOwner: async () => scope, runAgent: model });
  assert.equal(Object.hasOwn(bridge, 'readRecord'), false);
  await assert.rejects(bridge.list(scope), /JEFF_OPENCLAW_RESULT_NOT_FOUND/);
  await assert.rejects(bridge.retrieve(scope, '../escape'), /JEFF_OPENCLAW_JOB_ID_INVALID/);
});

test('running and interrupted statuses retain process ownership semantics', async t => {
  const root = await fixture(t); let release, started;
  const entered = new Promise(resolveEntered => { started = resolveEntered; });
  const bridge = createJeffOpenClawNftBridge({ dataRoot: root, resolveOwner: async () => scope,
    runAgent: async () => { started(); await new Promise(resolveRun => { release = resolveRun; }); return model(); } });
  const operation = bridge.run(scope, 'Synthetic pending run'); await entered;
  assert.equal((await bridge.list(scope))[0].status, 'running');
  const restarted = createJeffOpenClawNftBridge({ dataRoot: root, resolveOwner: async () => scope, runAgent: model });
  assert.equal((await restarted.list(scope))[0].status, 'interrupted');
  release(); assert.equal((await operation).status, 'completed');
});

test('completed unsaved overlay and retry-save reuse the original model output', async t => {
  const root = await fixture(t); let modelCalls = 0, refuseSave = true;
  const bridge = createJeffOpenClawNftBridge({ dataRoot: root, resolveOwner: async () => scope,
    runAgent: async () => { modelCalls++; return model(); },
    persistRecord: async (directory, item) => {
      if (item.status === 'completed' && refuseSave) throw new Error('Synthetic save failure');
      await mkdir(directory, { recursive: true }); await writeFile(resolve(directory, `${item.id}.json`), JSON.stringify(item));
    } });
  const result = await bridge.run(scope, 'Synthetic unsaved run'); assert.equal(result.status, 'completed_unsaved');
  const listed = (await bridge.list(scope))[0]; assert.equal(listed.status, 'completed_unsaved'); assert.equal(listed.textSha256, result.textSha256);
  refuseSave = false; assert.equal((await bridge.retrySave(scope, result.id)).status, 'completed');
  assert.equal((await bridge.list(scope))[0].status, 'completed'); assert.equal(modelCalls, 1);
});

test('execute still refuses saving output after ownership revocation', async t => {
  const root = await fixture(t); let revoked = false, calls = 0;
  const bridge = createJeffOpenClawNftBridge({ dataRoot: root,
    resolveOwner: async () => revoked ? { ...scope, ownerEpoch: 8 } : scope,
    runAgent: async () => { calls++; revoked = true; return model(); } });
  await assert.rejects(bridge.run(scope, 'Synthetic revoked run'), /JEFF_OPENCLAW_OWNER_REVOKED/);
  revoked = false; const result = (await bridge.list(scope))[0]; assert.equal(result.status, 'failed'); assert.equal(Object.hasOwn(result, 'text'), false); assert.equal(calls, 1);
});

test('standalone account list retains registration checks at both boundaries', async t => {
  const root = await fixture(t), account = { kind: 'account', chainId: 4663, owner: scope.owner };
  await seed(root, [{ ...record(), scope: account }], account); let checks = 0;
  const bridge = createJeffOpenClawAccountBridge({ dataRoot: root,
    resolveAccount: async () => { checks++; return true; }, runAgent: model });
  assert.equal((await bridge.list(account)).length, 1); assert.equal(checks, 2);
});
