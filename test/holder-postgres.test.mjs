import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createJeffPostgresHolderStore,
  createJeffPostgresMemoryAdapter,
  createJeffPostgresRateLimiter,
  JEFF_HOLDER_POSTGRES,
} from '../api/_lib/jeff-holder-postgres.mjs';
import { hashJeffBrainValue } from '../api/_lib/jeff-brain-common.mjs';

const sessionId = 'a'.repeat(64);
const challengeSha256 = 'b'.repeat(64);

function marker(sql) {
  return String(sql).match(/\/\*\s*([^*]+?)\s*\*\//)?.[1];
}

function fakeDatabase() {
  const challenges = new Map();
  const sessions = new Map();
  const memory = new Map();
  const limits = new Map();
  const calls = [];
  return {
    calls,
    challenges,
    sessions,
    memory,
    limits,
    async query(sql, params) {
      const operation = marker(sql);
      calls.push({ operation, params: structuredClone(params) });
      if (operation === 'jeff_holder.put_challenge') {
        if (challenges.has(params[0])) return { rows: [] };
        challenges.set(params[0], JSON.parse(params[1]));
        return { rows: [{ challenge_sha256: params[0] }] };
      }
      if (operation === 'jeff_holder.consume_challenge') {
        const payload = challenges.get(params[0]);
        challenges.delete(params[0]);
        return { rows: payload ? [{ payload }] : [] };
      }
      if (operation === 'jeff_holder.put_session') {
        if (sessions.has(params[0])) return { rows: [] };
        sessions.set(params[0], { payload: JSON.parse(params[1]), status: 'active' });
        return { rows: [{ session_id_sha256: params[0] }] };
      }
      if (operation === 'jeff_holder.get_session') {
        const row = sessions.get(params[0]);
        return { rows: row ? [row] : [] };
      }
      if (operation === 'jeff_holder.revoke_session') {
        const row = sessions.get(params[0]);
        if (!row || row.status !== 'active') return { rows: [] };
        Object.assign(row, { status: 'revoked', revoked_at: params[1], revocation_reason: params[2] });
        return { rows: [{ session_id_sha256: params[0] }] };
      }
      if (operation === 'jeff_holder.append_memory') {
        const records = memory.get(params[0]) ?? [];
        const previous = records.at(-1)?.recordSha256 ?? null;
        if (params[2] !== previous) return { rows: [] };
        const record = JSON.parse(params[3]);
        records.push(record);
        memory.set(params[0], records);
        return { rows: [{ record_sha256: params[1] }] };
      }
      if (operation === 'jeff_holder.list_memory') {
        return { rows: (memory.get(params[0]) ?? []).map((payload) => ({ payload })) };
      }
      if (operation === 'jeff_holder.consume_rate_limit') {
        const existing = limits.get(params[0]);
        const reset = !existing || Date.parse(existing.reset_at) <= Date.parse(params[2]);
        const row = reset
          ? { request_count: 1, reset_at: params[3] }
          : { request_count: existing.request_count + 1, reset_at: existing.reset_at };
        limits.set(params[0], row);
        return { rows: [row] };
      }
      throw new Error(`UNKNOWN_QUERY:${operation}`);
    },
  };
}

test('Postgres holder store consumes challenges once and hashes session identifiers', async () => {
  const database = fakeDatabase();
  const store = createJeffPostgresHolderStore({ database });
  const challenge = {
    schema: 'jeff-holder-challenge-v1',
    challengeSha256,
    expiresAt: '2026-10-04T08:05:00.000Z',
  };
  await store.putChallenge(challenge);
  assert.deepEqual(await store.consumeChallenge(challengeSha256), challenge);
  assert.equal(await store.consumeChallenge(challengeSha256), null);

  const session = {
    schema: 'jeff-holder-session-v1',
    sessionId,
    status: 'active',
    expiresAt: '2026-10-04T20:00:00.000Z',
  };
  await store.putSession(session);
  const storedKey = [...database.sessions.keys()][0];
  assert.notEqual(storedKey, sessionId);
  assert.equal(JSON.stringify(database.sessions.get(storedKey)).includes(sessionId), false);
  assert.equal((await store.getSession(sessionId)).sessionId, sessionId);
  assert.equal(await store.revokeSession(sessionId, 'holder_logout', '2026-10-04T09:00:00.000Z'), true);
  assert.equal((await store.getSession(sessionId)).status, 'revoked');
});

test('Postgres holder store fails closed on duplicate challenges and sessions', async () => {
  const database = fakeDatabase();
  const store = createJeffPostgresHolderStore({ database });
  const challenge = { challengeSha256, expiresAt: '2026-10-04T08:05:00.000Z' };
  await store.putChallenge(challenge);
  await assert.rejects(store.putChallenge(challenge), /JEFF_HOLDER_CHALLENGE_DUPLICATE/);
  const session = { sessionId, status: 'active', expiresAt: '2026-10-04T20:00:00.000Z' };
  await store.putSession(session);
  await assert.rejects(store.putSession(session), /JEFF_HOLDER_SESSION_DUPLICATE/);
});

test('Postgres memory adapter enforces one hash-linked record chain', async () => {
  const database = fakeDatabase();
  const adapter = createJeffPostgresMemoryAdapter({ database });
  const scopeSha256 = 'c'.repeat(64);
  const first = {
    scopeSha256,
    previousRecordSha256: null,
    recordSha256: 'd'.repeat(64),
  };
  const second = {
    scopeSha256,
    previousRecordSha256: first.recordSha256,
    recordSha256: 'e'.repeat(64),
  };
  await adapter.append(first);
  await adapter.append(second);
  assert.deepEqual(await adapter.list(scopeSha256), [first, second]);
  await assert.rejects(adapter.append({
    scopeSha256,
    previousRecordSha256: first.recordSha256,
    recordSha256: 'f'.repeat(64),
  }), /JEFF_MEMORY_INTEGRITY_FAILED/);
});

test('Postgres limiter is shared-state compatible and stores no raw subject', async () => {
  const database = fakeDatabase();
  const limiter = createJeffPostgresRateLimiter({
    database,
    limit: 2,
    windowMs: 60_000,
    now: () => '2026-10-04T08:00:00.000Z',
  });
  assert.equal((await limiter.consume({ bucket: 'boot', subject: '203.0.113.1' })).allowed, true);
  assert.equal((await limiter.consume({ bucket: 'boot', subject: '203.0.113.1' })).allowed, true);
  assert.equal((await limiter.consume({ bucket: 'boot', subject: '203.0.113.1' })).allowed, false);
  assert.equal(JSON.stringify([...database.limits.entries()]).includes('203.0.113.1'), false);
  assert.equal(JEFF_HOLDER_POSTGRES.storesRawSessionIds, false);
});

test('database failures are sanitized', async () => {
  const store = createJeffPostgresHolderStore({
    database: {
      async query() { throw new Error('postgres://user:secret@private-host/db'); },
    },
  });
  await assert.rejects(
    store.consumeChallenge(challengeSha256),
    (error) => error.message === 'JEFF_HOLDER_STORE_UNAVAILABLE'
      && !error.message.includes('private-host'),
  );
  assert.match(hashJeffBrainValue(sessionId), /^[a-f0-9]{64}$/);
});
