import { hashJeffBrainValue, isJeffRecord, JEFF_HASH } from './jeff-brain-common.mjs';
import { verifyJeffAgentMessage } from './jeff-agent-coordination.mjs';

function requireDatabase(database) {
  if (!database || typeof database.query !== 'function') {
    throw new Error('JEFF_OS_POSTGRES_CONFIG_INVALID');
  }
  return database;
}

function rowsFrom(result) {
  if (!result || !Array.isArray(result.rows)) throw new Error('JEFF_OS_POSTGRES_INVALID_RESPONSE');
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

function publicStoreError(error) {
  if (typeof error?.message === 'string' && error.message.startsWith('JEFF_')) return error;
  return new Error('JEFF_OS_STORE_UNAVAILABLE');
}

export function createJeffPostgresScheduleStore({ database } = {}) {
  const db = requireDatabase(database);
  return Object.freeze({
    async claim({ scheduleSha256, maximumRuns, available }) {
      if (!JEFF_HASH.test(String(scheduleSha256 ?? ''))
        || !Number.isSafeInteger(maximumRuns)
        || maximumRuns < 1
        || !Number.isSafeInteger(available)
        || available < 0) throw new Error('JEFF_OS_SCHEDULE_RESERVATION_INVALID');
      try {
        const result = await db.query(`
          /* jeff_os.claim_schedule_run */
          WITH state AS (
            SELECT
              COALESCE(MAX(run_index), 0) + 1 AS next_run,
              COALESCE(BOOL_OR(status = 'reserved'), false) AS has_in_flight
            FROM jeff_os_schedule_runs
            WHERE schedule_sha256 = $1
          )
          INSERT INTO jeff_os_schedule_runs (schedule_sha256, run_index, status)
          SELECT $1, next_run, 'reserved'
          FROM state
          WHERE has_in_flight = false
            AND next_run <= $2
            AND next_run <= $3
          ON CONFLICT DO NOTHING
          RETURNING run_index
        `, [scheduleSha256, maximumRuns, available]);
        const rows = rowsFrom(result);
        if (rows.length !== 1) throw new Error('JEFF_OS_SCHEDULE_RESERVATION_UNAVAILABLE');
        const runIndex = Number(rows[0].run_index);
        if (!Number.isSafeInteger(runIndex) || runIndex < 1) {
          throw new Error('JEFF_OS_POSTGRES_INVALID_RESPONSE');
        }
        return Object.freeze({ status: 'reserved', runIndex });
      } catch (error) {
        throw publicStoreError(error);
      }
    },

    async complete({ scheduleSha256, runIndex, receiptSha256 }) {
      if (!JEFF_HASH.test(String(scheduleSha256 ?? ''))
        || !Number.isSafeInteger(runIndex)
        || runIndex < 1
        || !JEFF_HASH.test(String(receiptSha256 ?? ''))) {
        throw new Error('JEFF_OS_SCHEDULE_RESERVATION_INVALID');
      }
      try {
        const result = await db.query(`
          /* jeff_os.complete_schedule_run */
          UPDATE jeff_os_schedule_runs
          SET status = 'completed', receipt_sha256 = $3, completed_at = now()
          WHERE schedule_sha256 = $1 AND run_index = $2 AND status = 'reserved'
          RETURNING schedule_sha256
        `, [scheduleSha256, runIndex, receiptSha256]);
        if (rowsFrom(result).length !== 1) throw new Error('JEFF_OS_SCHEDULE_RESERVATION_INVALID');
      } catch (error) {
        throw publicStoreError(error);
      }
    },

    async abort({ scheduleSha256, runIndex }) {
      if (!JEFF_HASH.test(String(scheduleSha256 ?? ''))
        || !Number.isSafeInteger(runIndex)
        || runIndex < 1) throw new Error('JEFF_OS_SCHEDULE_RESERVATION_INVALID');
      try {
        await db.query(`
          /* jeff_os.abort_schedule_run */
          DELETE FROM jeff_os_schedule_runs
          WHERE schedule_sha256 = $1 AND run_index = $2 AND status = 'reserved'
        `, [scheduleSha256, runIndex]);
      } catch (error) {
        throw publicStoreError(error);
      }
    },
  });
}

export function createJeffPostgresAgentMessageStore({ database } = {}) {
  const db = requireDatabase(database);
  return Object.freeze({
    async put(message) {
      if (!verifyJeffAgentMessage(message)) throw new Error('JEFF_AGENT_MESSAGE_INVALID');
      try {
        const result = await db.query(`
          /* jeff_os.put_agent_message */
          INSERT INTO jeff_agent_messages (
            message_sha256, recipient_sha256, payload, expires_at
          ) VALUES ($1, $2, $3::jsonb, $4::timestamptz)
          ON CONFLICT (message_sha256) DO NOTHING
          RETURNING message_sha256
        `, [
          message.messageSha256,
          hashJeffBrainValue(message.toAgentId),
          JSON.stringify(message),
          message.expiresAt,
        ]);
        if (rowsFrom(result).length !== 1) throw new Error('JEFF_AGENT_MESSAGE_REPLAYED');
      } catch (error) {
        throw publicStoreError(error);
      }
    },

    async listFor(agentId) {
      if (typeof agentId !== 'string' || !agentId || agentId.length > 256) {
        throw new Error('JEFF_AGENT_MESSAGE_ROUTE_DENIED');
      }
      try {
        const result = await db.query(`
          /* jeff_os.list_agent_messages */
          SELECT payload
          FROM jeff_agent_messages
          WHERE recipient_sha256 = $1 AND expires_at > now()
          ORDER BY created_at ASC
        `, [hashJeffBrainValue(agentId)]);
        return Object.freeze(rowsFrom(result).map((row) => {
          const message = jsonRecord(row.payload, 'JEFF_AGENT_MESSAGE_INVALID');
          if (!verifyJeffAgentMessage(message) || message.toAgentId !== agentId) {
            throw new Error('JEFF_AGENT_MESSAGE_INVALID');
          }
          return Object.freeze(message);
        }));
      } catch (error) {
        throw publicStoreError(error);
      }
    },
  });
}

export const JEFF_OS_POSTGRES = Object.freeze({
  scheduleClaimsAtomic: true,
  scheduleReceiptsDurable: true,
  preventsMessageReplay: true,
  indexesRecipientsAsHashes: true,
});
