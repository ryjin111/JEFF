import assert from 'node:assert/strict';
import test from 'node:test';

import { createJeffAgentMessage } from '../api/_lib/jeff-agent-coordination.mjs';
import {
  createJeffPostgresAgentMessageStore,
  createJeffPostgresScheduleStore,
  JEFF_OS_POSTGRES,
} from '../api/_lib/jeff-os-postgres.mjs';
import { hashJeffBrainValue } from '../api/_lib/jeff-brain-common.mjs';

const digest = (value) => hashJeffBrainValue(value);

function agentMessage() {
  return createJeffAgentMessage({
    fromAgentId: 'agent:room:7',
    toAgentId: 'agent:room:35',
    ownerEpoch: 2,
    threadId: 'coordination-001',
    kind: 'notice',
    payload: { summary: 'Verified public status is ready.' },
    createdAt: '2026-10-04T14:00:00.000Z',
    expiresAt: '2026-10-04T14:15:00.000Z',
    nonce: 'coordination-message-0001',
  });
}

test('Postgres schedule store uses atomic claims, completion, and abort markers', async () => {
  const calls = [];
  const database = {
    async query(text, parameters) {
      calls.push({ text, parameters });
      if (text.includes('jeff_os.claim_schedule_run')) return { rows: [{ run_index: 1 }] };
      if (text.includes('jeff_os.complete_schedule_run')) return { rows: [{ schedule_sha256: parameters[0] }] };
      if (text.includes('jeff_os.abort_schedule_run')) return { rows: [] };
      throw new Error('unexpected query');
    },
  };
  const store = createJeffPostgresScheduleStore({ database });
  const scheduleSha256 = digest('schedule');
  const receiptSha256 = digest('receipt');
  assert.deepEqual(await store.claim({ scheduleSha256, maximumRuns: 3, available: 1 }), {
    status: 'reserved', runIndex: 1,
  });
  await store.complete({ scheduleSha256, runIndex: 1, receiptSha256 });
  await store.abort({ scheduleSha256, runIndex: 2 });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].parameters, [scheduleSha256, 3, 1]);
  assert.deepEqual(calls[1].parameters, [scheduleSha256, 1, receiptSha256]);
  assert.deepEqual(calls[2].parameters, [scheduleSha256, 2]);
});

test('Postgres schedule store fails closed when a claim is unavailable', async () => {
  const store = createJeffPostgresScheduleStore({
    database: { async query() { return { rows: [] }; } },
  });
  await assert.rejects(store.claim({
    scheduleSha256: digest('schedule'), maximumRuns: 1, available: 1,
  }), /JEFF_OS_SCHEDULE_RESERVATION_UNAVAILABLE/);
});

test('Postgres message store hashes recipients, prevents replay, and validates loaded payloads', async () => {
  const message = agentMessage();
  const calls = [];
  let inserted = false;
  const database = {
    async query(text, parameters) {
      calls.push({ text, parameters });
      if (text.includes('jeff_os.put_agent_message')) {
        if (inserted) return { rows: [] };
        inserted = true;
        return { rows: [{ message_sha256: message.messageSha256 }] };
      }
      if (text.includes('jeff_os.list_agent_messages')) return { rows: [{ payload: message }] };
      throw new Error('unexpected query');
    },
  };
  const store = createJeffPostgresAgentMessageStore({ database });
  await store.put(message);
  assert.equal(calls[0].parameters[1], digest(message.toAgentId));
  const listed = await store.listFor(message.toAgentId);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].messageSha256, message.messageSha256);
  assert.equal(calls[1].parameters[0], digest(message.toAgentId));
  await assert.rejects(store.put(message), /JEFF_AGENT_MESSAGE_REPLAYED/);
});

test('Postgres stores redact unexpected database failures', async () => {
  const database = { async query() { throw new Error('database password leaked'); } };
  const scheduleStore = createJeffPostgresScheduleStore({ database });
  await assert.rejects(scheduleStore.claim({
    scheduleSha256: digest('schedule'), maximumRuns: 1, available: 1,
  }), (error) => error.message === 'JEFF_OS_STORE_UNAVAILABLE');
  const messageStore = createJeffPostgresAgentMessageStore({ database });
  await assert.rejects(messageStore.put(agentMessage()), (error) => error.message === 'JEFF_OS_STORE_UNAVAILABLE');
});

test('Postgres control-plane contract advertises durable safety properties', () => {
  assert.deepEqual(JEFF_OS_POSTGRES, {
    scheduleClaimsAtomic: true,
    scheduleReceiptsDurable: true,
    preventsMessageReplay: true,
    indexesRecipientsAsHashes: true,
  });
});
