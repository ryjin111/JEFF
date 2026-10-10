import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJeffOpenClawAccountBridge } from 'jeff-agent-nft/openclaw';
import { createJobRecordPersister } from '../src/job-records.mjs';

const testRoot = dirname(fileURLToPath(import.meta.url));

async function fixture(t) {
  const directory = await mkdtemp(resolve(testRoot, '.job-records-'));
  t.after(async () => {
    assert.equal(dirname(directory), testRoot);
    await rm(directory, { recursive: true, force: true });
  });
  const previous = { id: randomUUID(), status: 'running', saved: true };
  const file = resolve(directory, `${previous.id}.json`);
  const previousRaw = JSON.stringify(previous);
  await writeFile(file, previousRaw);
  return { directory, file, previous, previousRaw, next: { ...previous, status: 'failed', error: 'cancelled' } };
}
test('commit guard runs after temporary write and denies rename without changing the receipt',async t=>{
  const f=await fixture(t);let renamed=false;
  const persist=createJobRecordPersister({renameImpl:async(...args)=>{renamed=true;return rename(...args);}});
  await assert.rejects(persist(f.directory,f.next,{commit:async()=>{
    const files=await readdir(f.directory);assert.equal(files.filter(name=>name.endsWith('.tmp')).length,1);
    throw new Error('JEFF_GITHUB_CONNECTION_CHANGED');
  }}),/CONNECTION_CHANGED/);
  assert.equal(renamed,false);assert.equal(await readFile(f.file,'utf8'),f.previousRaw);assert.equal((await readdir(f.directory)).filter(name=>name.endsWith('.tmp')).length,0);
});

for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
  test(`job receipts retry transient ${code} rename errors and save the complete terminal record`, async t => {
    const f = await fixture(t);
    const delays = [];
    let attempts = 0;
    const persistRecord = createJobRecordPersister({
      sleepImpl: async delay => { delays.push(delay); },
      async renameImpl(temporary, destination) {
        attempts++;
        assert.equal(destination, f.file);
        assert.equal(dirname(temporary), f.directory);
        assert.deepEqual(JSON.parse(await readFile(temporary, 'utf8')), f.next);
        assert.equal(await readFile(f.file, 'utf8'), f.previousRaw);
        if (process.platform !== 'win32') assert.equal((await stat(temporary)).mode & 0o777, 0o600);
        if (attempts < 3) throw Object.assign(new Error('temporary file lock'), { code });
        await rename(temporary, destination);
      },
    });
    await persistRecord(f.directory, f.next);
    assert.equal(attempts, 3);
    assert.deepEqual(delays, [20, 40]);
    assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')), f.next);
    assert.deepEqual(await readdir(f.directory), [`${f.previous.id}.json`]);
  });
}

test('permanent rename locking stops after a bounded wait, preserves the old receipt and cleans only its own temp', async t => {
  const f = await fixture(t);
  const unrelated = resolve(f.directory, `${f.previous.id}.json.other-writer.tmp`);
  await writeFile(unrelated, 'another writer');
  const failure = Object.assign(new Error('persistent file lock'), { code: 'EPERM' });
  const delays = [];
  let attempts = 0;
  let temporary;
  const persistRecord = createJobRecordPersister({
    sleepImpl: async delay => { delays.push(delay); },
    async renameImpl(source, destination) {
      attempts++;
      temporary ??= source;
      assert.equal(source, temporary);
      assert.equal(destination, f.file);
      assert.equal(await readFile(f.file, 'utf8'), f.previousRaw);
      throw failure;
    },
  });
  await assert.rejects(persistRecord(f.directory, f.next), error => error === failure);
  assert.equal(attempts, 8);
  assert.equal(delays.length, 7);
  assert.equal(delays.reduce((total, delay) => total + delay, 0), 900);
  assert.equal(await readFile(f.file, 'utf8'), f.previousRaw);
  assert.equal(await readFile(unrelated, 'utf8'), 'another writer');
  await assert.rejects(readFile(temporary), { code: 'ENOENT' });
  assert.equal((await readdir(f.directory)).length, 2);
});

test('nontransient rename failure propagates immediately without replacing the previous receipt', async t => {
  const f = await fixture(t);
  const failure = Object.assign(new Error('storage failure'), { code: 'EIO' });
  let attempts = 0;
  let sleeps = 0;
  const persistRecord = createJobRecordPersister({
    sleepImpl: async () => { sleeps++; },
    async renameImpl() { attempts++; throw failure; },
  });
  await assert.rejects(persistRecord(f.directory, f.next), error => error === failure);
  assert.equal(attempts, 1);
  assert.equal(sleeps, 0);
  assert.equal(await readFile(f.file, 'utf8'), f.previousRaw);
  assert.deepEqual(await readdir(f.directory), [`${f.previous.id}.json`]);
});

test('concurrent receipt writes use independent exclusive temp files and each commits complete JSON', async t => {
  const f = await fixture(t);
  const temporaryPaths = new Set();
  let release;
  const bothReady = new Promise(resolveReady => { release = resolveReady; });
  let commits = Promise.resolve();
  const records = [f.next, { ...f.next, error: 'another receipt version' }];
  const persistRecord = createJobRecordPersister({
    async renameImpl(temporary, destination) {
      assert.equal(destination, f.file);
      assert.equal(temporaryPaths.has(temporary), false);
      temporaryPaths.add(temporary);
      const record = JSON.parse(await readFile(temporary, 'utf8'));
      assert.ok(records.some(candidate => candidate.error === record.error));
      if (temporaryPaths.size === 2) release();
      await bothReady;
      const committed = commits.then(() => rename(temporary, destination));
      commits = committed;
      await committed;
    },
  });
  await Promise.all(records.map(record => persistRecord(f.directory, record)));
  assert.equal(temporaryPaths.size, 2);
  const saved = JSON.parse(await readFile(f.file, 'utf8'));
  assert.ok(records.some(record => record.error === saved.error));
  assert.deepEqual(await readdir(f.directory), [`${f.previous.id}.json`]);
});

test('receipt IDs cannot redirect persistence outside the supplied results directory', async t => {
  const f = await fixture(t);
  const persistRecord = createJobRecordPersister();
  for (const id of ['../other-receipt', '..\\other-receipt', '/absolute/path', undefined]) {
    await assert.rejects(persistRecord(f.directory, { ...f.next, id }), /JEFF_JOB_RECORD_INVALID/);
  }
  assert.equal(await readFile(f.file, 'utf8'), f.previousRaw);
  assert.deepEqual(await readdir(f.directory), [`${f.previous.id}.json`]);
});

test('a cancelled bridge execution persists a failed receipt through transient rename locking without rerunning the model', async t => {
  const f = await fixture(t);
  const cancellation = new Error('JEFF_OPENCLAW_CANCELLED');
  const scope = { kind: 'account', chainId: 4663, owner: '0x' + '11'.repeat(20) };
  let executions = 0;
  let failedSaves = 0;
  const persistRecord = createJobRecordPersister({
    sleepImpl: async () => {},
    async renameImpl(temporary, destination) {
      const record = JSON.parse(await readFile(temporary, 'utf8'));
      if (record.status === 'failed' && ++failedSaves < 3) {
        throw Object.assign(new Error('temporary file lock'), { code: 'EPERM' });
      }
      await rename(temporary, destination);
    },
  });
  const options = { dataRoot: resolve(f.directory, 'bridge'), resolveAccount: async () => true,
    persistRecord, async runAgent() { executions++; throw cancellation; } };
  const bridge = createJeffOpenClawAccountBridge(options);
  await assert.rejects(bridge.run(scope, 'Cancelled work'), error => error === cancellation);
  assert.equal(executions, 1);
  assert.equal(failedSaves, 3);
  const [saved] = await createJeffOpenClawAccountBridge(options).list(scope);
  assert.equal(saved.status, 'failed');
  assert.equal(saved.saved, true);
  assert.equal(saved.error, 'JEFF_OPENCLAW_JOB_FAILED');
  assert.equal(executions, 1);
});
