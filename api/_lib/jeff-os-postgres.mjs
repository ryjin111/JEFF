import { hashJeffBrainValue, isJeffRecord, JEFF_HASH } from './jeff-brain-common.mjs';
import { verifyJeffAgentMessage } from './jeff-agent-coordination.mjs';
import { verifyJeffOsSchedule } from './jeff-os-scheduler.mjs';

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
    async putSchedule(schedule) {
      if (!verifyJeffOsSchedule(schedule)) throw new Error('JEFF_OS_SCHEDULE_INVALID');
      try {
        const result = await db.query(`
          /* jeff_os.put_schedule */
          INSERT INTO jeff_os_schedules (
            schedule_sha256, agent_sha256, owner_sha256, owner_epoch,
            maximum_runs, payload, status, expires_at
          ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'active', $7::timestamptz)
          ON CONFLICT (schedule_sha256) DO NOTHING
          RETURNING schedule_sha256
        `, [
          schedule.scheduleSha256,
          hashJeffBrainValue(schedule.agentId),
          hashJeffBrainValue(schedule.ownerId),
          schedule.ownerEpoch,
          schedule.maximumRuns,
          JSON.stringify(schedule),
          schedule.expiresAt,
        ]);
        if (rowsFrom(result).length !== 1) throw new Error('JEFF_OS_SCHEDULE_DUPLICATE');
      } catch (error) {
        throw publicStoreError(error);
      }
    },

    async getSchedule(scheduleSha256) {
      if (!JEFF_HASH.test(String(scheduleSha256 ?? ''))) throw new Error('JEFF_OS_SCHEDULE_INVALID');
      try {
        const result = await db.query(`
          /* jeff_os.get_schedule */
          SELECT payload, status, cancelled_at
          FROM jeff_os_schedules
          WHERE schedule_sha256 = $1
        `, [scheduleSha256]);
        const rows = rowsFrom(result);
        if (rows.length === 0) return null;
        const schedule = jsonRecord(rows[0].payload, 'JEFF_OS_SCHEDULE_INVALID');
        if (!verifyJeffOsSchedule(schedule)) throw new Error('JEFF_OS_SCHEDULE_INVALID');
        return Object.freeze({
          schedule,
          status: rows[0].status,
          cancelledAt: rows[0].cancelled_at
            ? new Date(rows[0].cancelled_at).toISOString()
            : null,
        });
      } catch (error) {
        throw publicStoreError(error);
      }
    },

    async listSchedules({ agentId, ownerEpoch }) {
      if (typeof agentId !== 'string' || !agentId
        || !Number.isSafeInteger(ownerEpoch) || ownerEpoch < 0) {
        throw new Error('JEFF_OS_SCHEDULE_QUERY_INVALID');
      }
      try {
        const result = await db.query(`
          /* jeff_os.list_schedules */
          SELECT payload, status, cancelled_at
          FROM jeff_os_schedules
          WHERE agent_sha256 = $1
            AND owner_epoch = $2
            AND status = 'active'
            AND expires_at > now()
          ORDER BY created_at ASC
        `, [hashJeffBrainValue(agentId), ownerEpoch]);
        return Object.freeze(rowsFrom(result).map((row) => {
          const schedule = jsonRecord(row.payload, 'JEFF_OS_SCHEDULE_INVALID');
          if (!verifyJeffOsSchedule(schedule)
            || schedule.agentId !== agentId
            || schedule.ownerEpoch !== ownerEpoch) throw new Error('JEFF_OS_SCHEDULE_INVALID');
          return Object.freeze({ schedule, status: row.status, cancelledAt: null });
        }));
      } catch (error) {
        throw publicStoreError(error);
      }
    },

    async cancelSchedule({ scheduleSha256, cancelledAt }) {
      if (!JEFF_HASH.test(String(scheduleSha256 ?? ''))
        || typeof cancelledAt !== 'string'
        || !Number.isFinite(Date.parse(cancelledAt))) {
        throw new Error('JEFF_OS_SCHEDULE_CANCEL_INVALID');
      }
      try {
        const result = await db.query(`
          /* jeff_os.cancel_schedule */
          UPDATE jeff_os_schedules
          SET status = 'cancelled', cancelled_at = $2::timestamptz
          WHERE schedule_sha256 = $1
            AND status = 'active'
            AND reserved_run_index IS NULL
          RETURNING schedule_sha256
        `, [scheduleSha256, cancelledAt]);
        if (rowsFrom(result).length !== 1) throw new Error('JEFF_OS_SCHEDULE_CANCEL_DENIED');
      } catch (error) {
        throw publicStoreError(error);
      }
    },

    async claim({ scheduleSha256, maximumRuns, available }) {
      if (!JEFF_HASH.test(String(scheduleSha256 ?? ''))
        || !Number.isSafeInteger(maximumRuns)
        || maximumRuns < 1
        || maximumRuns > 24
        || !Number.isSafeInteger(available)
        || available < 0) throw new Error('JEFF_OS_SCHEDULE_RESERVATION_INVALID');
      try {
        const result = await db.query(`
          /* jeff_os.claim_schedule_run */
          WITH reservation AS (
            UPDATE jeff_os_schedules
            SET reserved_run_index = completed_runs + 1
            WHERE schedule_sha256 = $1 AND status = 'active' AND expires_at > now()
              AND maximum_runs = $2
              AND reserved_run_index IS NULL
              AND completed_runs + 1 <= $2
              AND completed_runs + 1 <= $3
            RETURNING schedule_sha256, reserved_run_index
          )
          INSERT INTO jeff_os_schedule_runs (schedule_sha256, run_index, status)
          SELECT schedule_sha256, reserved_run_index, 'reserved'
          FROM reservation
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
        || runIndex > 24
        || !JEFF_HASH.test(String(receiptSha256 ?? ''))) {
        throw new Error('JEFF_OS_SCHEDULE_RESERVATION_INVALID');
      }
      try {
        const result = await db.query(`
          /* jeff_os.complete_schedule_run */
          WITH completed AS (
            UPDATE jeff_os_schedules
            SET completed_runs = $2, reserved_run_index = NULL
            WHERE schedule_sha256 = $1 AND reserved_run_index = $2
              AND status = 'active'
              AND EXISTS (
                SELECT 1 FROM jeff_os_schedule_runs
                WHERE schedule_sha256 = $1 AND run_index = $2 AND status = 'reserved'
              )
            RETURNING schedule_sha256
          )
          UPDATE jeff_os_schedule_runs AS runs
          SET status = 'completed', receipt_sha256 = $3, completed_at = now()
          FROM completed
          WHERE runs.schedule_sha256 = completed.schedule_sha256
            AND runs.run_index = $2 AND runs.status = 'reserved'
          RETURNING runs.schedule_sha256
        `, [scheduleSha256, runIndex, receiptSha256]);
        if (rowsFrom(result).length !== 1) throw new Error('JEFF_OS_SCHEDULE_RESERVATION_INVALID');
      } catch (error) {
        throw publicStoreError(error);
      }
    },

    async abort({ scheduleSha256, runIndex }) {
      if (!JEFF_HASH.test(String(scheduleSha256 ?? ''))
        || !Number.isSafeInteger(runIndex)
        || runIndex < 1 || runIndex > 24) throw new Error('JEFF_OS_SCHEDULE_RESERVATION_INVALID');
      try {
        await db.query(`
          /* jeff_os.abort_schedule_run */
          WITH aborted AS (
            UPDATE jeff_os_schedules
            SET reserved_run_index = NULL
            WHERE schedule_sha256 = $1 AND reserved_run_index = $2
              AND status = 'active'
              AND EXISTS (
                SELECT 1 FROM jeff_os_schedule_runs
                WHERE schedule_sha256 = $1 AND run_index = $2 AND status = 'reserved'
              )
            RETURNING schedule_sha256
          )
          DELETE FROM jeff_os_schedule_runs AS runs
          USING aborted
          WHERE runs.schedule_sha256 = aborted.schedule_sha256
            AND runs.run_index = $2 AND runs.status = 'reserved'
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
  scheduleDefinitionsDurable: true,
  scheduleClaimsAtomic: true,
  scheduleReceiptsDurable: true,
  preventsMessageReplay: true,
  indexesRecipientsAsHashes: true,
});
