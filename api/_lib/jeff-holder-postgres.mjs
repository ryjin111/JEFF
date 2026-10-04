import { hashJeffBrainValue, isJeffRecord, JEFF_HASH } from './jeff-brain-common.mjs';

const SESSION_ID = /^[a-f0-9]{64}$/;

function requireDatabase(database) {
  if (!database || typeof database.query !== 'function') {
    throw new Error('JEFF_HOLDER_POSTGRES_CONFIG_INVALID');
  }
  return database;
}

function rowsFrom(result) {
  if (!result || !Array.isArray(result.rows)) throw new Error('JEFF_HOLDER_POSTGRES_INVALID_RESPONSE');
  return result.rows;
}

function jsonRecord(value, code) {
  let parsed = value;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { throw new Error(code); }
  }
  if (!isJeffRecord(parsed)) throw new Error(code);
  return structuredClone(parsed);
}

function sessionHash(sessionId) {
  if (!SESSION_ID.test(String(sessionId ?? ''))) throw new Error('JEFF_HOLDER_SESSION_INVALID');
  return hashJeffBrainValue(sessionId);
}

function publicStoreError(error) {
  if (typeof error?.message === 'string' && error.message.startsWith('JEFF_')) return error;
  return new Error('JEFF_HOLDER_STORE_UNAVAILABLE');
}

export function createJeffPostgresHolderStore({ database } = {}) {
  const db = requireDatabase(database);
  return Object.freeze({
    async putChallenge(challenge) {
      if (!isJeffRecord(challenge)
        || !JEFF_HASH.test(String(challenge.challengeSha256 ?? ''))
        || typeof challenge.expiresAt !== 'string') {
        throw new Error('JEFF_HOLDER_CHALLENGE_INVALID');
      }
      try {
        const result = await db.query(`
          /* jeff_holder.put_challenge */
          INSERT INTO jeff_holder_challenges (challenge_sha256, payload, expires_at)
          VALUES ($1, $2::jsonb, $3::timestamptz)
          ON CONFLICT (challenge_sha256) DO NOTHING
          RETURNING challenge_sha256
        `, [challenge.challengeSha256, JSON.stringify(challenge), challenge.expiresAt]);
        if (rowsFrom(result).length !== 1) throw new Error('JEFF_HOLDER_CHALLENGE_DUPLICATE');
      } catch (error) {
        throw publicStoreError(error);
      }
    },

    async consumeChallenge(challengeSha256) {
      if (!JEFF_HASH.test(String(challengeSha256 ?? ''))) throw new Error('JEFF_HOLDER_CHALLENGE_INVALID');
      try {
        const result = await db.query(`
          /* jeff_holder.consume_challenge */
          DELETE FROM jeff_holder_challenges
          WHERE challenge_sha256 = $1
          RETURNING payload
        `, [challengeSha256]);
        const rows = rowsFrom(result);
        return rows.length === 0 ? null : jsonRecord(rows[0].payload, 'JEFF_HOLDER_CHALLENGE_INVALID');
      } catch (error) {
        throw publicStoreError(error);
      }
    },

    async putSession(session) {
      if (!isJeffRecord(session) || !SESSION_ID.test(String(session.sessionId ?? ''))
        || typeof session.expiresAt !== 'string' || session.status !== 'active') {
        throw new Error('JEFF_HOLDER_SESSION_INVALID');
      }
      const {
        sessionId,
        status: _status,
        revokedAt: _revokedAt,
        revocationReason: _revocationReason,
        ...payload
      } = session;
      try {
        const result = await db.query(`
          /* jeff_holder.put_session */
          INSERT INTO jeff_holder_sessions (
            session_id_sha256, payload, status, expires_at
          ) VALUES ($1, $2::jsonb, 'active', $3::timestamptz)
          ON CONFLICT (session_id_sha256) DO NOTHING
          RETURNING session_id_sha256
        `, [sessionHash(sessionId), JSON.stringify(payload), session.expiresAt]);
        if (rowsFrom(result).length !== 1) throw new Error('JEFF_HOLDER_SESSION_DUPLICATE');
      } catch (error) {
        throw publicStoreError(error);
      }
    },

    async getSession(sessionId) {
      const idSha256 = sessionHash(sessionId);
      try {
        const result = await db.query(`
          /* jeff_holder.get_session */
          SELECT payload, status, revoked_at, revocation_reason
          FROM jeff_holder_sessions
          WHERE session_id_sha256 = $1
        `, [idSha256]);
        const rows = rowsFrom(result);
        if (rows.length === 0) return null;
        const row = rows[0];
        const payload = jsonRecord(row.payload, 'JEFF_HOLDER_SESSION_INVALID');
        return {
          ...payload,
          sessionId,
          status: row.status,
          ...(row.revoked_at ? { revokedAt: new Date(row.revoked_at).toISOString() } : {}),
          ...(row.revocation_reason ? { revocationReason: row.revocation_reason } : {}),
        };
      } catch (error) {
        throw publicStoreError(error);
      }
    },

    async revokeSession(sessionId, reason, revokedAt) {
      const idSha256 = sessionHash(sessionId);
      if (typeof reason !== 'string' || !reason || reason.length > 128
        || typeof revokedAt !== 'string' || !Number.isFinite(Date.parse(revokedAt))) {
        throw new Error('JEFF_HOLDER_SESSION_INVALID');
      }
      try {
        const result = await db.query(`
          /* jeff_holder.revoke_session */
          UPDATE jeff_holder_sessions
          SET status = 'revoked', revoked_at = $2::timestamptz, revocation_reason = $3
          WHERE session_id_sha256 = $1 AND status = 'active'
          RETURNING session_id_sha256
        `, [idSha256, revokedAt, reason]);
        return rowsFrom(result).length === 1;
      } catch (error) {
        throw publicStoreError(error);
      }
    },
  });
}

export function createJeffPostgresMemoryAdapter({ database } = {}) {
  const db = requireDatabase(database);
  return Object.freeze({
    async append(record) {
      if (!isJeffRecord(record)
        || !JEFF_HASH.test(String(record.scopeSha256 ?? ''))
        || !JEFF_HASH.test(String(record.recordSha256 ?? ''))
        || (record.previousRecordSha256 !== null
          && !JEFF_HASH.test(String(record.previousRecordSha256 ?? '')))) {
        throw new Error('JEFF_MEMORY_INPUT_INVALID');
      }
      try {
        const result = await db.query(`
          /* jeff_holder.append_memory */
          WITH latest AS (
            SELECT record_sha256
            FROM jeff_holder_memory_records
            WHERE scope_sha256 = $1
            ORDER BY sequence_number DESC
            LIMIT 1
          ), next_sequence AS (
            SELECT COALESCE(MAX(sequence_number), 0) + 1 AS value
            FROM jeff_holder_memory_records
            WHERE scope_sha256 = $1
          )
          INSERT INTO jeff_holder_memory_records (
            scope_sha256, sequence_number, record_sha256, previous_record_sha256, payload
          )
          SELECT $1, next_sequence.value, $2, $3, $4::jsonb
          FROM next_sequence
          WHERE $3 IS NOT DISTINCT FROM (SELECT record_sha256 FROM latest)
          ON CONFLICT DO NOTHING
          RETURNING record_sha256
        `, [
          record.scopeSha256,
          record.recordSha256,
          record.previousRecordSha256,
          JSON.stringify(record),
        ]);
        if (rowsFrom(result).length !== 1) throw new Error('JEFF_MEMORY_INTEGRITY_FAILED');
      } catch (error) {
        throw publicStoreError(error);
      }
    },

    async list(scopeSha256) {
      if (!JEFF_HASH.test(String(scopeSha256 ?? ''))) throw new Error('JEFF_MEMORY_SCOPE_INVALID');
      try {
        const result = await db.query(`
          /* jeff_holder.list_memory */
          SELECT payload
          FROM jeff_holder_memory_records
          WHERE scope_sha256 = $1
          ORDER BY sequence_number ASC
        `, [scopeSha256]);
        return rowsFrom(result).map((row) => jsonRecord(row.payload, 'JEFF_MEMORY_INTEGRITY_FAILED'));
      } catch (error) {
        throw publicStoreError(error);
      }
    },
  });
}

export function createJeffPostgresRateLimiter({
  database,
  limit = 30,
  windowMs = 60_000,
  now = () => new Date().toISOString(),
} = {}) {
  const db = requireDatabase(database);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000
    || !Number.isSafeInteger(windowMs) || windowMs < 1_000 || windowMs > 86_400_000
    || typeof now !== 'function') throw new Error('JEFF_HOLDER_POSTGRES_CONFIG_INVALID');
  return Object.freeze({
    async consume({ bucket, subject }) {
      if (typeof bucket !== 'string' || !bucket || bucket.length > 64
        || typeof subject !== 'string' || !subject || subject.length > 512) {
        throw new Error('JEFF_HOLDER_POSTGRES_CONFIG_INVALID');
      }
      let currentAt;
      try {
        currentAt = new Date(now()).toISOString();
      } catch {
        throw new Error('JEFF_HOLDER_POSTGRES_CONFIG_INVALID');
      }
      const resetAt = new Date(Date.parse(currentAt) + windowMs).toISOString();
      const keySha256 = hashJeffBrainValue({ bucket, subject });
      try {
        const result = await db.query(`
          /* jeff_holder.consume_rate_limit */
          INSERT INTO jeff_holder_rate_limits (
            key_sha256, bucket, request_count, window_started_at, reset_at
          ) VALUES ($1, $2, 1, $3::timestamptz, $4::timestamptz)
          ON CONFLICT (key_sha256) DO UPDATE SET
            request_count = CASE
              WHEN jeff_holder_rate_limits.reset_at <= EXCLUDED.window_started_at THEN 1
              ELSE jeff_holder_rate_limits.request_count + 1
            END,
            window_started_at = CASE
              WHEN jeff_holder_rate_limits.reset_at <= EXCLUDED.window_started_at
              THEN EXCLUDED.window_started_at ELSE jeff_holder_rate_limits.window_started_at
            END,
            reset_at = CASE
              WHEN jeff_holder_rate_limits.reset_at <= EXCLUDED.window_started_at
              THEN EXCLUDED.reset_at ELSE jeff_holder_rate_limits.reset_at
            END
          RETURNING request_count, reset_at
        `, [keySha256, bucket, currentAt, resetAt]);
        const rows = rowsFrom(result);
        if (rows.length !== 1) throw new Error('JEFF_HOLDER_POSTGRES_INVALID_RESPONSE');
        const count = Number(rows[0].request_count);
        const storedResetAt = Date.parse(rows[0].reset_at);
        if (!Number.isSafeInteger(count) || count < 1 || !Number.isFinite(storedResetAt)) {
          throw new Error('JEFF_HOLDER_POSTGRES_INVALID_RESPONSE');
        }
        return Object.freeze({
          allowed: count <= limit,
          retryAfterSeconds: Math.max(1, Math.ceil((storedResetAt - Date.parse(currentAt)) / 1_000)),
        });
      } catch (error) {
        throw publicStoreError(error);
      }
    },
  });
}

export const JEFF_HOLDER_POSTGRES = Object.freeze({
  storesRawSessionIds: false,
  consumesChallengesAtomically: true,
  revokesSessionsAtomically: true,
  preventsMemoryForks: true,
  storesRateLimitSubjectsAsHashes: true,
});
