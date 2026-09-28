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
  assert.equal(result.artifacts.length, 9);
});
