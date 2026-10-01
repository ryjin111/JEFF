import assert from 'node:assert/strict';
import test from 'node:test';

import { verifyRelease } from '../scripts/verify-release.mjs';

test('standalone release verifies every bound artifact and remains shadow-only', async () => {
  const result = await verifyRelease();
  assert.equal(result.releaseReady, true);
  assert.equal(result.model, 'jeff-agent-nft-nb-v0.5-evidence');
  assert.equal(result.mode, 'shadow');
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.observedAccuracy, 0.939815);
  assert.equal(result.artifacts.length, 15);
  assert.equal(result.soul.schema, 'jeff-agent-soul-manifest-v1');
  assert.equal(result.soul.version, '1.0.0');
  assert.match(result.soul.bundleRootSha256, /^[a-f0-9]{64}$/);
  assert.match(result.soul.manifestSha256, /^[a-f0-9]{64}$/);
});
