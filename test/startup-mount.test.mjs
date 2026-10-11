import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyStartupMount, writableDataMount } from '../src/startup-mount.mjs';

const env = { JEFF_HOSTED_HARDENING: 'true', JEFF_DATA_ROOT: '/data', RAILWAY_VOLUME_MOUNT_PATH: '/data',
  RAILWAY_PROJECT_ID: '11111111-1111-4111-8111-111111111111', RAILWAY_ENVIRONMENT_ID: '22222222-2222-4222-8222-222222222222',
  RAILWAY_SERVICE_ID: '33333333-3333-4333-8333-333333333333', RAILWAY_DEPLOYMENT_ID: '44444444-4444-4444-8444-444444444444',
  RAILWAY_VOLUME_ID: '55555555-5555-4555-8555-555555555555' };
const mounted = '45 24 8:16 / /data rw,relatime - ext4 /dev/sdb rw\n';
const io = { lstat: async () => ({ isDirectory: () => true, isSymbolicLink: () => false }), realpath: async () => '/data',
  readFile: async () => mounted, access: async () => {} };

test('hosted and Railway startup require a writable exact /data mount', async () => {
  assert.deepEqual(await verifyStartupMount({ env, platform: 'linux', io }), { required: true, verified: true });
  assert.deepEqual(await verifyStartupMount({ env: { JEFF_HOSTED_HARDENING: 'true', JEFF_DATA_ROOT: '/data' }, platform: 'linux', io }), { required: true, verified: true });
  assert.deepEqual(await verifyStartupMount({ env: { ...env, JEFF_HOSTED_HARDENING: 'false' }, platform: 'linux', io }), { required: true, verified: true });
});

test('local development skips filesystem checks for an independent root', async () => {
  const forbidden = new Proxy({}, { get() { throw new Error('unexpected filesystem access'); } });
  assert.deepEqual(await verifyStartupMount({ env: { JEFF_DATA_ROOT: 'local-test-data' }, platform: 'win32', io: forbidden }), { required: false, verified: false });
});

test('wrong paths, partial Railway identity and unsupported hosted platform fail before filesystem work', async () => {
  for (const changed of [{ JEFF_DATA_ROOT: '/tmp/data' }, { RAILWAY_VOLUME_MOUNT_PATH: '/wrong' },
    { RAILWAY_PROJECT_ID: '' }, { RAILWAY_ENVIRONMENT_ID: undefined }, { RAILWAY_SERVICE_ID: 'not-a-uuid' },
    { RAILWAY_DEPLOYMENT_ID: undefined }, { RAILWAY_VOLUME_ID: undefined }]) {
    let reads = 0;
    await assert.rejects(verifyStartupMount({ env: { ...env, ...changed }, platform: 'linux', io: { lstat() { reads++; } } }), /JEFF_STORAGE_IDENTITY_INVALID/);
    assert.equal(reads, 0);
  }
  await assert.rejects(verifyStartupMount({ env, platform: 'win32', io }), /JEFF_STORAGE_IDENTITY_INVALID/);
  await assert.rejects(verifyStartupMount({ env: { RAILWAY_VOLUME_ID: env.RAILWAY_VOLUME_ID }, platform: 'linux', io }), /JEFF_STORAGE_IDENTITY_INVALID/);
});

test('absent, unmounted, symlinked, readonly and unwritable paths fail closed', async () => {
  const failures = [
    [{ lstat: async () => { throw new Error('ENOENT'); } }, /JEFF_STORAGE_MOUNT_UNAVAILABLE/],
    [{ readFile: async () => '24 0 0:1 / / rw - overlay overlay rw\n' }, /JEFF_STORAGE_MOUNT_REQUIRED/],
    [{ lstat: async () => ({ isDirectory: () => true, isSymbolicLink: () => true }) }, /JEFF_STORAGE_PATH_INVALID/],
    [{ realpath: async () => '/elsewhere' }, /JEFF_STORAGE_PATH_INVALID/],
    [{ readFile: async () => mounted.replace('rw,relatime', 'ro,relatime') }, /JEFF_STORAGE_MOUNT_REQUIRED/],
    [{ readFile: async () => mounted.replace('/dev/sdb rw', '/dev/sdb ro') }, /JEFF_STORAGE_MOUNT_REQUIRED/],
    [{ access: async () => { throw new Error('EACCES'); } }, /JEFF_STORAGE_MOUNT_UNAVAILABLE/]
  ];
  for (const [overrides, expected] of failures)
    await assert.rejects(verifyStartupMount({ env, platform: 'linux', io: { ...io, ...overrides } }), expected);
});

test('mount matching rejects subdirectories, escaped lookalikes, malformed and stacked entries', () => {
  assert.equal(writableDataMount(mounted), true);
  for (const text of [mounted.replace(' /data ', ' /data/nested '), mounted.replace(' /data ', ' /data\\040other '),
    '45 24 8:16 / /data rw\n', mounted + mounted, '', mounted.replace(' rw,', ' ro,')])
    assert.equal(writableDataMount(text), false);
});
