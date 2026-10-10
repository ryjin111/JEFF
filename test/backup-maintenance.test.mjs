import test from 'node:test';
import assert from 'node:assert/strict';
import { backupMarkerPath, backupDrainReady, LEGACY_RELEASE } from '../src/backup-maintenance.mjs';

test('legacy capture recognizes only the exact old pilot and honors its absolute override', () => {
  const env = { JEFF_RELEASE_SHA: LEGACY_RELEASE };
  assert.equal(backupMarkerPath({}, env), '/tmp/simple-jeff-maintenance.json');
  assert.equal(backupMarkerPath({}, { ...env, JEFF_MAINTENANCE_MARKER: '/data/old-marker.json' }), '/data/old-marker.json');
  assert.throws(() => backupMarkerPath({}, { JEFF_RELEASE_SHA: 'a'.repeat(40) }), /UNSUPPORTED/);
  assert.throws(() => backupMarkerPath({}, {}), /RELEASE_REQUIRED/);
  for (const path of ['relative.json', '/tmp/../marker.json', '/tmp/marker\0.json']) {
    assert.throws(() => backupMarkerPath({}, { ...env, JEFF_MAINTENANCE_MARKER: path }), /PATH_INVALID/);
  }
});

test('current capture uses the runtime resolver with the actual environment', () => {
  const env = { JEFF_RELEASE_SHA: 'b'.repeat(40), JEFF_MAINTENANCE_MARKER: '/data/override.json' };
  assert.equal(backupMarkerPath({ resolveMaintenanceMarkerPath(input) {
    assert.equal(input.env, env); assert.equal(input.dataRoot, '/data'); return input.env.JEFF_MAINTENANCE_MARKER;
  } }, env), '/data/override.json');
});

test('ready marker must identify the drained server and exact release with no remaining writers', () => {
  const expected = { pid: 42, releaseSha: LEGACY_RELEASE };
  const marker = { schema: 'simple-jeff-maintenance-v1', status: 'ready', ...expected,
    activeRequests: 0, pendingTasks: 0, readyAt: new Date().toISOString() };
  assert.equal(backupDrainReady(marker, expected), true);
  for (const changed of [{ pid: 43 }, { releaseSha: 'c'.repeat(40) }, { activeRequests: 1 },
    { pendingTasks: 1 }, { status: 'paused' }, { readyAt: 'invalid' }, { schema: 'other' }]) {
    assert.equal(backupDrainReady({ ...marker, ...changed }, expected), false);
  }
});
