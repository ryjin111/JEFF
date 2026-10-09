import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { createHolderSessions } from '../src/auth.mjs';
import { createAccountSessions } from '../src/account-auth.mjs';

const wallet = privateKeyToAccount('0x' + '12'.repeat(32)); // Disposable local signing fixture.
const origin = 'https://auth-races.invalid', chainId = 4663, collection = '0x' + '33'.repeat(20);

async function fixture(t, kind) {
  let time = 1000000, blocked;
  const now = () => time;
  let sessions;
  if (kind === 'holder') sessions = createHolderSessions({ origin, chainId, collection, now,
    resolveOwner: async () => {
      if (blocked) { blocked.enter(); await blocked.gate; }
      return { owner: wallet.address.toLowerCase(), ownerEpoch: 0 };
    } });
  else {
    const dataRoot = await mkdtemp(resolve(tmpdir(), 'jeff-auth-races-'));
    t.after(() => rm(dataRoot, { recursive: true, force: true }));
    sessions = createAccountSessions({ origin, chainId, dataRoot, now });
  }
  return { sessions, advance(ms) { time += ms; },
    blockOwnership() {
      let enter, release;
      const entered = new Promise(done => { enter = done; });
      const gate = new Promise(done => { release = done; });
      blocked = { enter, gate };
      return { entered, release };
    },
    async signedChallenge() {
      const challenge = await sessions.challenge({ wallet: wallet.address, tokenId: '35' });
      return { nonce: challenge.nonce, signature: await wallet.signMessage({ message: challenge.message }) };
    },
    async login() { return sessions.verify(await this.signedChallenge()); },
  };
}

for (const kind of ['holder', 'account']) for (const invalidation of ['logout', 'expiry']) {
  test(`${kind} authentication cannot finish after ${invalidation} during its asynchronous validation`, async t => {
    const f = await fixture(t, kind), session = await f.login();
    const gate = kind === 'holder' ? f.blockOwnership() : null;
    const authenticating = f.sessions.authenticate(session.token);
    if (gate) await gate.entered;
    if (invalidation === 'logout') f.sessions.logout(session.token);
    else f.advance(3600000);
    gate?.release();
    await assert.rejects(authenticating, /^Error: JEFF_SESSION_REQUIRED$/);
    await assert.rejects(f.sessions.authenticate(session.token), /^Error: JEFF_SESSION_REQUIRED$/);
  });
}

for (const kind of ['holder', 'account']) {
  test(`${kind} login cannot issue a session when its challenge expires during verification`, async t => {
    const f = await fixture(t, kind), challenge = await f.signedChallenge();
    const gate = kind === 'holder' ? f.blockOwnership() : null;
    const verifying = f.sessions.verify(challenge);
    if (gate) await gate.entered;
    f.advance(300000);
    gate?.release();
    await assert.rejects(verifying, /^Error: JEFF_CHALLENGE_EXPIRED$/);
    await assert.rejects(f.sessions.verify(challenge), /^Error: JEFF_CHALLENGE_EXPIRED$/);
  });
}
