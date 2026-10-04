import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createJeffOsSchedule } from '../api/_lib/jeff-os-scheduler.mjs';
import { createJeffPostgresScheduleStore } from '../api/_lib/jeff-os-postgres.mjs';

// Uses real independent PostgreSQL connections and a unique, disposable schema.
// Set this only to an isolated test database, never a production connection.
const connectionString = process.env.JEFF_OS_TEST_DATABASE_URL;

test('PostgreSQL serializes cancel/claim and retains quota across concurrent lifecycle requests', {
  skip: !connectionString,
}, async () => {
  const { Client } = await import('pg');
  const schema = `jeff_os_test_${randomBytes(8).toString('hex')}`;
  const clients = [];
  async function connect() {
    const client = new Client({ connectionString, connectionTimeoutMillis: 5000 });
    await client.connect();
    clients.push(client);
    await client.query(`SET search_path TO ${schema}`);
    await client.query("SET statement_timeout TO '10s'");
    return client;
  }
  const admin = await connect();
  let stage = 'migration';
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    const original = await readFile(new URL('../docs/sql/jeff-os-postgres.sql', import.meta.url), 'utf8');
    const upgrade = await readFile(new URL('../docs/sql/jeff-os-schedule-state.sql', import.meta.url), 'utf8');
    await admin.query(original);
    await admin.query(upgrade);
    await admin.query(upgrade); // Upgrade must be safe to rerun.
    const a = await connect();
    const b = await connect();
    const storeA = createJeffPostgresScheduleStore({ database: a });
    const storeB = createJeffPostgresScheduleStore({ database: b });
    async function schedule(maximumRuns = 1) {
      const value = createJeffOsSchedule({
        agentId: 'agent:test:7', ownerId: 'owner:test', ownerEpoch: 4,
        skillId: 'holder.report', operation: 'status', input: { tokenId: '7' },
        runAfter: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        maximumRuns, intervalSeconds: maximumRuns > 1 ? 60 : null,
        nonce: randomBytes(16).toString('hex'), enabled: true,
      });
      await storeA.putSchedule(value);
      return value.scheduleSha256;
    }
    async function waitForLock(client) {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const state = await admin.query(
          'SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1', [client.processID],
        );
        if (state.rows[0]?.wait_event_type === 'Lock') return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.fail('Competing request did not wait on a PostgreSQL row lock');
    }

    // Claim wins first: cancellation must wait, then reject the committed reservation.
    const claimed = await schedule();
    stage = 'claim_before_cancel';
    await a.query('BEGIN');
    await storeA.claim({ scheduleSha256: claimed, maximumRuns: 1, available: 1 });
    const deniedCancel = assert.rejects(storeB.cancelSchedule({
      scheduleSha256: claimed, cancelledAt: new Date().toISOString(),
    }), /JEFF_OS_SCHEDULE_CANCEL_DENIED/);
    await waitForLock(b);
    await a.query('COMMIT');
    await deniedCancel;
    assert.equal((await storeA.getSchedule(claimed)).status, 'active');

    // Cancel wins first: a claim with an older statement snapshot must recheck status.
    const cancelled = await schedule();
    stage = 'cancel_before_claim';
    await a.query('BEGIN');
    await storeA.cancelSchedule({ scheduleSha256: cancelled, cancelledAt: new Date().toISOString() });
    const deniedClaim = assert.rejects(storeB.claim({
      scheduleSha256: cancelled, maximumRuns: 1, available: 1,
    }), /JEFF_OS_SCHEDULE_RESERVATION_UNAVAILABLE/);
    await waitForLock(b);
    await a.query('COMMIT');
    await deniedClaim;
    assert.equal((await admin.query('SELECT * FROM jeff_os_schedule_runs WHERE schedule_sha256 = $1',
      [cancelled])).rows.length, 0);

    // Two claimers cannot reserve the same or overlapping run.
    const duplicate = await schedule(2);
    stage = 'overlapping_claims';
    await a.query('BEGIN');
    await storeA.claim({ scheduleSha256: duplicate, maximumRuns: 2, available: 2 });
    const deniedDuplicate = assert.rejects(storeB.claim({
      scheduleSha256: duplicate, maximumRuns: 2, available: 2,
    }), /JEFF_OS_SCHEDULE_RESERVATION_UNAVAILABLE/);
    await waitForLock(b);
    await a.query('COMMIT');
    await deniedDuplicate;

    // Completion and the next claim share the same serialization point.
    await a.query('BEGIN');
    await storeA.complete({ scheduleSha256: duplicate, runIndex: 1, receiptSha256: 'a'.repeat(64) });
    stage = 'completion_then_claim';
    await assert.rejects(storeB.claim({ scheduleSha256: duplicate, maximumRuns: 2, available: 2 }),
      /JEFF_OS_SCHEDULE_RESERVATION_UNAVAILABLE/);
    await a.query('COMMIT');
    assert.equal((await storeB.claim({ scheduleSha256: duplicate, maximumRuns: 2, available: 2 })).runIndex, 2);
    stage = 'abort_then_retry';
    await storeB.abort({ scheduleSha256: duplicate, runIndex: 2 });
    assert.equal((await storeA.claim({ scheduleSha256: duplicate, maximumRuns: 2, available: 2 })).runIndex, 2);
    await storeA.complete({ scheduleSha256: duplicate, runIndex: 2, receiptSha256: 'b'.repeat(64) });
    await assert.rejects(storeB.claim({ scheduleSha256: duplicate, maximumRuns: 2, available: 2 }),
      /JEFF_OS_SCHEDULE_RESERVATION_UNAVAILABLE/);

    // Rerunning the upgrade preserves completed quota and unknown in-flight runs.
    await admin.query(upgrade);
    const rows = (await admin.query(
      'SELECT schedule_sha256, completed_runs, reserved_run_index FROM jeff_os_schedules',
    )).rows;
    assert.equal(rows.find((row) => row.schedule_sha256 === claimed).reserved_run_index, 1);
    assert.equal(rows.find((row) => row.schedule_sha256 === duplicate).completed_runs, 2);
    assert.equal(rows.find((row) => row.schedule_sha256 === duplicate).reserved_run_index, null);
    console.log(JSON.stringify({
      schema: 'jeff-os-postgres-concurrency-evidence-v1',
      serverVersion: (await admin.query('SHOW server_version')).rows[0].server_version,
      claimBeforeCancel: true, cancelBeforeClaim: true, overlappingClaimsDenied: true,
      completionThenClaim: true, abortThenRetry: true, quotaPreserved: true,
      migrationRerunPreservedInFlight: true,
    }));
  } catch (error) {
    throw new Error(`${stage}: ${error.message}`, { cause: error });
  } finally {
    for (const client of clients.slice(1)) {
      await client.query('ROLLBACK').catch(() => {});
      await client.end();
    }
    await admin.query('ROLLBACK').catch(() => {});
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
