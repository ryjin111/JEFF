import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createJeffOpenClawNftBridge } from '../api/_lib/jeff-openclaw-nft.mjs';

const scope = { chainId: 4663, collection: '0x' + '11'.repeat(20), tokenId: '35', owner: '0x' + '22'.repeat(20), ownerEpoch: 0 };
test('untrusted token IDs cannot reach the resolver or a runtime', async () => {
  let calls = 0;
  const bridge = createJeffOpenClawNftBridge({ dataRoot: '.', resolveOwner: async () => { calls++; return scope; }, runAgent: async () => { calls++; } });
  for (const tokenId of [35, '../secret', (2n ** 256n).toString()]) await assert.rejects(bridge.run({ ...scope, tokenId }, 'test'), /SCOPE_INVALID/);
  assert.equal(calls, 0);
});
test('retrieval after restart remains bound to the transfer epoch', async t => {
  const root = await mkdtemp(resolve('test', '.openclaw-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let ownerEpoch = 0;
  const options = { dataRoot: root, resolveOwner: async () => ({ owner: scope.owner, ownerEpoch }), runAgent: async () => ({ text: 'Saved report' }) };
  const result = await createJeffOpenClawNftBridge(options).run(scope, 'Write a report');
  const reopened = createJeffOpenClawNftBridge(options);
  assert.equal((await reopened.retrieve(scope, result.id)).text, 'Saved report');
  ownerEpoch = 2;
  await assert.rejects(reopened.retrieve(scope, result.id), /OWNER_REVOKED/);
  await assert.rejects(reopened.retrieve({ ...scope, ownerEpoch: 2 }, result.id), /NOT_FOUND/);
});

test('jobs are discoverable while running and failed saves retry without regenerating', async t => {
  const root = await mkdtemp(resolve('test', '.openclaw-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let modelCalls = 0; let finish; let diskRecovered = false;
  const options = { dataRoot: root, resolveOwner: async () => ({ owner: scope.owner, ownerEpoch: 0 }),
    runAgent: async () => { modelCalls++; return new Promise(done => { finish = done; }); },
    persistRecord: async (directory, record) => {
      if (record.status === 'completed' && !diskRecovered) throw new Error('disk temporarily unavailable');
      await mkdir(directory, { recursive: true });
      await writeFile(resolve(directory, `${record.id}.json`), JSON.stringify(record));
    } };
  const bridge = createJeffOpenClawNftBridge(options);
  const started = await bridge.start(scope, 'Create a useful report');
  assert.equal(started.status, 'running');
  assert.equal((await bridge.list(scope))[0].id, started.id);
  finish({ text: 'Generated output retained for retry' });
  await new Promise(setImmediate);
  const unsaved = await bridge.retrieve(scope, started.id);
  assert.equal(unsaved.status, 'completed_unsaved');
  assert.equal(unsaved.text, 'Generated output retained for retry');
  assert.equal(unsaved.saved, false);
  diskRecovered = true;
  const saved = await bridge.retrySave(scope, started.id);
  assert.equal(saved.saved, true);
  assert.equal(modelCalls, 1);
  const reopened = createJeffOpenClawNftBridge(options);
  assert.equal((await reopened.retrieve(scope, started.id)).text, saved.text);
});
