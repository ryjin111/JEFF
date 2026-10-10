import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, privateDecrypt, constants } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRecurringBackup, sealRecurringBackup } from '../src/recurring-backup.mjs';
import { captureBackup, decryptBackup } from '../src/backup.mjs';
import { createBackupObjectStore } from '../src/backup-object-store.mjs';
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
const pem = publicKey.export({ type: 'spki', format: 'pem' });
const source = 'a'.repeat(40);
async function root(t) { const path = await mkdtemp(resolve(tmpdir(), 'jeff-recurring-test-')); t.after(() => rm(path, { recursive: true, force: true })); return path; }
test('recurring envelope restores authentic bytes using the separate private key', async t => {
  const path = await root(t); await mkdir(resolve(path, 'data')); await writeFile(resolve(path, 'data/note.txt'), 'Private fixture');
  const snapshot = await captureBackup({ dataRoot: resolve(path, 'data'), writersQuiesced: true });
  const sealed = await sealRecurringBackup(snapshot, pem, source);
  assert.equal(sealed.bytes.includes(Buffer.from('Private fixture')), false);
  const envelope = JSON.parse(sealed.bytes);
  const key = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(envelope.wrappedKey, 'base64'));
  const opened = decryptBackup(Buffer.from(envelope.archive, 'base64'), key); key.fill(0);
  assert.equal(opened.recurring.releaseSha, source); assert.equal(opened.recurring.keyId, envelope.keyId);
  assert.equal(Buffer.from(opened.files[0].data, 'base64').toString(), 'Private fixture');
  const changed = Buffer.from(envelope.archive, 'base64'); changed[changed.length - 1] ^= 1;
  assert.throws(() => decryptBackup(changed, Buffer.alloc(32)));
});
async function worker(t, overrides = {}) {
  const dataRoot = await root(t); let phase = 'running', resumes = 0, uploads = 0, captures = 0;
  const maintenance = { beginRequest: () => phase === 'running' ? () => {} : null, status: () => ({ phase }), pause: async () => { phase = 'paused'; return { status: 'ready' }; }, resume: async () => { resumes++; phase = 'running'; } };
  const env = { JEFF_DATA_ROOT: dataRoot, JEFF_RELEASE_SHA: source, JEFF_RECURRING_BACKUP: JSON.stringify({ publicKey: pem, intervalHours: 24 }) };
  const backup = createRecurringBackup({ env, maintenance, capture: async () => { captures++; assert.equal(phase, 'paused'); return { capturedAt: new Date().toISOString(), manifestSha256: source }; },
    seal: async () => ({ key: 'fixture.json', bytes: Buffer.from('encrypted-fixture'), filesVerified: 1 }),
    store: { putVerified: async () => { uploads++; assert.equal(phase, 'running'); return { readbackVerified: true }; } }, onReceipt: () => {}, ...overrides });
  return { backup, counts: () => ({ resumes, uploads, captures, phase }) };
}
test('concurrent backup triggers coalesce and resume before slow upload', async t => {
  const f = await worker(t); const first = f.backup.run(), second = f.backup.run();
  assert.equal(first, second); assert.equal((await first).readbackVerified, true);
  assert.deepEqual(f.counts(), { resumes: 1, uploads: 1, captures: 1, phase: 'running' }); await f.backup.stop();
});
test('upload failure leaves application resumed and never records success', async t => {
  let receipts = 0;
  const f = await worker(t, { store: { putVerified: async () => { throw new Error('fixture upload failure'); } }, onReceipt: () => receipts++ });
  await assert.rejects(f.backup.run(), /upload failure/); assert.equal(f.counts().phase, 'running'); assert.equal(receipts, 0); await f.backup.stop();
});
test('rejected pause and resume always release the capture flag without reopening an unsafe drain', async t => {
  for (const boundary of ['pause', 'resume']) {
    let phase = 'running', resumes = 0;
    const maintenance = { status: () => ({ phase }),
      pause: async () => { phase = 'paused'; if (boundary === 'pause') throw new Error('JEFF_MAINTENANCE_TASK_UNSAFE'); return {}; },
      resume: async () => { resumes++; throw new Error('fixture resume failure'); } };
    const f = await worker(t, { maintenance, capture: async () => ({ capturedAt: new Date().toISOString() }) });
    await assert.rejects(f.backup.run()); assert.equal(f.backup.isCapturing(), false);
    assert.equal(resumes, boundary === 'pause' ? 0 : 1); assert.equal(phase, 'paused'); await f.backup.stop();
  }
});
test('an operator pause after upload blocks a new receipt write', async t => {
  let phase = 'running', receipts = 0;
  const maintenance = { status: () => ({ phase }), pause: async () => { phase = 'paused'; return {}; },
    resume: async () => { phase = 'running'; }, beginRequest: () => null };
  const f = await worker(t, { maintenance, capture: async () => ({ capturedAt: new Date().toISOString() }),
    store: { putVerified: async () => { phase = 'paused'; return { readbackVerified: true }; } }, onReceipt: () => receipts++ });
  await assert.rejects(f.backup.run(), /RECEIPT_BLOCKED/); assert.equal(receipts, 0); await f.backup.stop();
});
test('shutdown during a capture never reopens admissions', async t => {
  let closing = false, finish, begin;
  const began = new Promise(done => { begin = done; }), held = new Promise(done => { finish = done; });
  const f = await worker(t, { canResume: () => !closing,
    capture: async () => { begin(); await held; return { capturedAt: new Date().toISOString() }; },
    store: { putVerified: async () => ({ readbackVerified: true }) } });
  const run = f.backup.run(); await began; assert.equal(f.backup.isCapturing(), true);
  closing = true; const stop = f.backup.stop(); finish(); await assert.rejects(run, /RECEIPT_BLOCKED/); await stop;
  assert.equal(f.counts().resumes, 0); assert.equal(f.counts().phase, 'paused'); assert.equal(await f.backup.run(), null);
});
const storeConfig = { endpoint: 'https://objects.example', bucket: 'jeff-backups', region: 'auto', accessKeyId: 'fixture-access-key', secretAccessKey: 'fixture-secret-key-12345' };
test('S3 adapter signs fixed HTTPS requests and verifies actual object readback', async () => {
  const requests = []; let saved;
  const store = createBackupObjectStore(storeConfig, { now: () => new Date('2026-10-10T00:00:00Z'), fetchImpl: async (url, options) => {
    requests.push({ url, options }); assert.equal(options.redirect, 'error');
    assert.match(options.headers.authorization, /^AWS4-HMAC-SHA256 Credential=fixture-access-key\/20261010\/auto\/s3\/aws4_request/);
    assert.equal(options.headers.authorization.includes(storeConfig.secretAccessKey), false);
    if (options.method === 'PUT') { saved = Buffer.from(options.body); return new Response('', { status: 200 }); }
    return new Response(saved);
  } });
  assert.equal((await store.putVerified('fixture.json', Buffer.from('ciphertext'))).readbackVerified, true);
  assert.equal(requests.length, 2); assert.equal(requests[0].url, 'https://objects.example/jeff-backups/jeff/fixture.json');
});
test('S3 upload/readback failures and oversized or modified bodies fail closed', async () => {
  for (const mode of ['upload', 'get', 'changed', 'oversized']) {
    const store = createBackupObjectStore(storeConfig, { fetchImpl: async (url, options) => {
      if (options.method === 'PUT') return new Response('', { status: mode === 'upload' ? 503 : 200 });
      return new Response(mode === 'oversized' ? 'ciphertext-extra' : 'changed!!!', { status: mode === 'get' ? 404 : 200 });
    } });
    await assert.rejects(store.putVerified('fixture.json', Buffer.from('ciphertext')), /JEFF_BACKUP_/);
  }
  assert.throws(() => createBackupObjectStore({ ...storeConfig, endpoint: 'http://objects.example' }), /CONFIG_INVALID/);
});

test('virtual-host buckets sign the bucket host and omit bucket from the object path', async () => {
  let saved;
  const store = createBackupObjectStore({ ...storeConfig, urlStyle: 'virtual-host' }, { fetchImpl: async (url, options) => {
    assert.equal(url, 'https://jeff-backups.objects.example/jeff/fixture.json');
    assert.equal(options.headers.host, 'jeff-backups.objects.example');
    if (options.method === 'PUT') { saved = options.body; return new Response(''); }
    return new Response(saved);
  } });
  assert.equal((await store.putVerified('fixture.json', Buffer.from('ciphertext'))).readbackVerified, true);
  assert.throws(() => createBackupObjectStore({ ...storeConfig, urlStyle: 'arbitrary' }), /CONFIG_INVALID/);
  assert.throws(() => createBackupObjectStore({ ...storeConfig, bucket: 'dotted.bucket', urlStyle: 'virtual-host' }), /CONFIG_INVALID/);
});

test('backup health survives restart from a verified receipt and exposes no storage or job details', async t => {
  const dataRoot = await root(t); await mkdir(resolve(dataRoot, '.operations'));
  const capturedAt = '2026-10-10T01:00:00Z';
  await writeFile(resolve(dataRoot, '.operations/backup-receipt.json'), JSON.stringify({event:'JEFF_RECURRING_BACKUP_READY',readbackVerified:true,capturedAt,key:'private-object-key',jobsRetrieved:42}));
  const f = await worker(t, {env:{JEFF_DATA_ROOT:dataRoot,JEFF_RELEASE_SHA:source,JEFF_RECURRING_BACKUP:JSON.stringify({publicKey:pem,intervalHours:24})}});
  assert.deepEqual(await f.backup.status(),{enabled:true,lastVerifiedAt:capturedAt,lastFailureAt:null});
  await f.backup.stop();
});

test('backup health records upload failures and later successful recovery', async t => {
  let fail = true;
  const f = await worker(t, {store:{putVerified:async()=>{if(fail)throw new Error('secret provider detail');return {readbackVerified:true};}}});
  await assert.rejects(f.backup.run());
  const failed = await f.backup.status(); assert.equal(failed.lastVerifiedAt,null); assert.ok(Date.parse(failed.lastFailureAt));
  fail = false; await f.backup.run(); const recovered = await f.backup.status();
  assert.ok(Date.parse(recovered.lastVerifiedAt)); assert.equal(JSON.stringify(recovered).includes('secret'),false);
  await f.backup.stop();
});
