import {
  assertJeffIsoTimestamp,
  assertJeffName,
  assertJeffText,
  canonicalizeJeffValue,
  hashJeffBrainValue,
  isJeffRecord,
  JEFF_HASH,
} from './jeff-brain-common.mjs';
import { requireJeffAuthorization } from './jeff-trusted-authorization.mjs';
import { verifyJeffOsSkillReceipt } from './jeff-os-skills.mjs';

const SCHEDULE_SCHEMA = 'jeff-os-schedule-v1';
const RECEIPT_SCHEMA = 'jeff-os-schedule-receipt-v1';
const ADMIN_RECEIPT_SCHEMA = 'jeff-os-schedule-admin-receipt-v1';
const MAX_SCHEDULE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_RUNS = 24;
const MIN_INTERVAL_SECONDS = 60;
const MAX_INPUT_BYTES = 16_384;
const SENSITIVE_KEY = /(?:api.?key|credential|mnemonic|passphrase|password|private.?key|raw.?transaction|secret|seed.?phrase|signature)/i;

function exactKeys(value, keys) {
  return isJeffRecord(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function containsSensitiveKey(value) {
  if (Array.isArray(value)) return value.some(containsSensitiveKey);
  if (!isJeffRecord(value)) return false;
  return Object.entries(value).some(([key, entry]) => SENSITIVE_KEY.test(key) || containsSensitiveKey(entry));
}

function normalizeInput(value) {
  if (!isJeffRecord(value)
    || containsSensitiveKey(value)
    || Buffer.byteLength(JSON.stringify(canonicalizeJeffValue(value)), 'utf8') > MAX_INPUT_BYTES) {
    throw new Error('JEFF_OS_SCHEDULE_INPUT_INVALID');
  }
  return Object.freeze(structuredClone(value));
}

function validEpoch(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function verifyJeffOsSchedule(schedule) {
  const keys = [
    'schema', 'agentId', 'ownerId', 'ownerEpoch', 'skillId', 'operation', 'input',
    'inputSha256', 'runAfter', 'expiresAt', 'intervalSeconds', 'maximumRuns',
    'nonce', 'enabled', 'scheduleSha256',
  ];
  if (!exactKeys(schedule, keys)
    || schedule.schema !== SCHEDULE_SCHEMA
    || typeof schedule.agentId !== 'string'
    || !schedule.agentId
    || schedule.agentId.length > 256
    || typeof schedule.ownerId !== 'string'
    || !schedule.ownerId
    || schedule.ownerId.length > 256
    || !validEpoch(schedule.ownerEpoch)
    || typeof schedule.skillId !== 'string'
    || !/^[a-z][a-z0-9_.-]{0,127}$/i.test(schedule.skillId)
    || typeof schedule.operation !== 'string'
    || !/^[a-z][a-z0-9_.-]{0,127}$/i.test(schedule.operation)
    || !isJeffRecord(schedule.input)
    || containsSensitiveKey(schedule.input)
    || !JEFF_HASH.test(String(schedule.inputSha256 ?? ''))
    || schedule.inputSha256 !== hashJeffBrainValue(schedule.input)
    || (schedule.intervalSeconds !== null
      && (!Number.isSafeInteger(schedule.intervalSeconds)
        || schedule.intervalSeconds < MIN_INTERVAL_SECONDS
        || schedule.intervalSeconds > MAX_SCHEDULE_TTL_MS / 1_000))
    || !Number.isSafeInteger(schedule.maximumRuns)
    || schedule.maximumRuns < 1
    || schedule.maximumRuns > MAX_RUNS
    || (schedule.intervalSeconds === null && schedule.maximumRuns !== 1)
    || typeof schedule.nonce !== 'string'
    || schedule.nonce.length < 16
    || schedule.nonce.length > 128
    || typeof schedule.enabled !== 'boolean'
    || !JEFF_HASH.test(String(schedule.scheduleSha256 ?? ''))) return false;
  let runAfterMs;
  let expiresAtMs;
  try {
    runAfterMs = Date.parse(assertJeffIsoTimestamp(schedule.runAfter, 'JEFF_OS_SCHEDULE_INVALID'));
    expiresAtMs = Date.parse(assertJeffIsoTimestamp(schedule.expiresAt, 'JEFF_OS_SCHEDULE_INVALID'));
  } catch {
    return false;
  }
  if (expiresAtMs <= runAfterMs || expiresAtMs - runAfterMs > MAX_SCHEDULE_TTL_MS) return false;
  const { scheduleSha256, ...body } = schedule;
  return schedule.scheduleSha256 === hashJeffBrainValue(body);
}

export function createJeffOsSchedule({
  agentId,
  ownerId,
  ownerEpoch,
  skillId,
  operation,
  input,
  runAfter = new Date().toISOString(),
  expiresAt = new Date(Date.parse(runAfter) + 60 * 60 * 1_000).toISOString(),
  intervalSeconds = null,
  maximumRuns = 1,
  nonce,
  enabled = false,
} = {}) {
  const normalizedInput = normalizeInput(input);
  const body = {
    schema: SCHEDULE_SCHEMA,
    agentId: assertJeffText(agentId, 'JEFF_OS_SCHEDULE_INVALID', 256),
    ownerId: assertJeffText(ownerId, 'JEFF_OS_SCHEDULE_INVALID', 256),
    ownerEpoch,
    skillId: assertJeffName(skillId, 'JEFF_OS_SCHEDULE_INVALID'),
    operation: assertJeffName(operation, 'JEFF_OS_SCHEDULE_INVALID'),
    input: normalizedInput,
    inputSha256: hashJeffBrainValue(normalizedInput),
    runAfter: assertJeffIsoTimestamp(runAfter, 'JEFF_OS_SCHEDULE_INVALID'),
    expiresAt: assertJeffIsoTimestamp(expiresAt, 'JEFF_OS_SCHEDULE_INVALID'),
    intervalSeconds,
    maximumRuns,
    nonce: assertJeffText(nonce, 'JEFF_OS_SCHEDULE_INVALID', 128),
    enabled,
  };
  const schedule = Object.freeze({ ...body, scheduleSha256: hashJeffBrainValue(body) });
  if (!verifyJeffOsSchedule(schedule)) throw new Error('JEFF_OS_SCHEDULE_INVALID');
  return schedule;
}

function availableRuns(schedule, nowMs) {
  const startMs = Date.parse(schedule.runAfter);
  if (nowMs < startMs) return 0;
  if (schedule.intervalSeconds === null) return 1;
  return Math.min(
    schedule.maximumRuns,
    Math.floor((nowMs - startMs) / (schedule.intervalSeconds * 1_000)) + 1,
  );
}

export function createInMemoryJeffOsScheduleStore() {
  const definitions = new Map();
  const runs = new Map();
  return Object.freeze({
    async putSchedule(schedule) {
      if (!verifyJeffOsSchedule(schedule) || definitions.has(schedule.scheduleSha256)) {
        throw new Error('JEFF_OS_SCHEDULE_DUPLICATE');
      }
      definitions.set(schedule.scheduleSha256, {
        schedule: structuredClone(schedule), status: 'active', cancelledAt: null,
      });
    },
    async getSchedule(scheduleSha256) {
      if (!JEFF_HASH.test(String(scheduleSha256 ?? ''))) throw new Error('JEFF_OS_SCHEDULE_INVALID');
      const value = definitions.get(scheduleSha256);
      return value ? Object.freeze(structuredClone(value)) : null;
    },
    async listSchedules({ agentId, ownerEpoch }) {
      if (typeof agentId !== 'string' || !agentId || !validEpoch(ownerEpoch)) {
        throw new Error('JEFF_OS_SCHEDULE_QUERY_INVALID');
      }
      return Object.freeze([...definitions.values()]
        .filter(({ schedule, status }) => schedule.agentId === agentId
          && schedule.ownerEpoch === ownerEpoch
          && status === 'active')
        .map((value) => Object.freeze(structuredClone(value))));
    },
    async cancelSchedule({ scheduleSha256, cancelledAt }) {
      const definition = definitions.get(scheduleSha256);
      const state = runs.get(scheduleSha256);
      if (!definition || definition.status !== 'active' || state?.inFlight !== null && state?.inFlight !== undefined) {
        throw new Error('JEFF_OS_SCHEDULE_CANCEL_DENIED');
      }
      definitions.set(scheduleSha256, { ...definition, status: 'cancelled', cancelledAt });
    },
    async claim({ scheduleSha256, maximumRuns, available }) {
      if (!JEFF_HASH.test(String(scheduleSha256 ?? ''))
        || !Number.isSafeInteger(maximumRuns)
        || maximumRuns < 1
        || !Number.isSafeInteger(available)
        || available < 0) throw new Error('JEFF_OS_SCHEDULE_RESERVATION_INVALID');
      const definition = definitions.get(scheduleSha256);
      if (!definition
        || definition.status !== 'active'
        || definition.schedule.maximumRuns !== maximumRuns) {
        throw new Error('JEFF_OS_SCHEDULE_RESERVATION_INVALID');
      }
      const state = runs.get(scheduleSha256) ?? { completed: 0, inFlight: null, receipts: [] };
      if (state.inFlight !== null) throw new Error('JEFF_OS_SCHEDULE_RUN_IN_FLIGHT');
      const runIndex = state.completed + 1;
      if (runIndex > maximumRuns) throw new Error('JEFF_OS_SCHEDULE_QUOTA_EXHAUSTED');
      if (runIndex > available) throw new Error('JEFF_OS_SCHEDULE_NOT_DUE');
      runs.set(scheduleSha256, { ...state, inFlight: runIndex });
      return Object.freeze({ status: 'reserved', runIndex });
    },
    async complete({ scheduleSha256, runIndex, receiptSha256 }) {
      const state = runs.get(scheduleSha256);
      if (!state
        || state.inFlight !== runIndex
        || !JEFF_HASH.test(String(receiptSha256 ?? ''))) {
        throw new Error('JEFF_OS_SCHEDULE_RESERVATION_INVALID');
      }
      runs.set(scheduleSha256, {
        completed: runIndex,
        inFlight: null,
        receipts: [...state.receipts, receiptSha256],
      });
    },
    async abort({ scheduleSha256, runIndex }) {
      const state = runs.get(scheduleSha256);
      if (state?.inFlight !== runIndex) return;
      runs.set(scheduleSha256, { ...state, inFlight: null });
    },
    async snapshot() {
      return Object.freeze({
        definitions: structuredClone([...definitions.entries()]),
        runs: structuredClone([...runs.entries()]),
      });
    },
  });
}

export function verifyJeffOsScheduleAdminReceipt(receipt) {
  const keys = [
    'schema', 'action', 'scheduleSha256', 'authorizationAttestationSha256',
    'ownerEpoch', 'recordedAt', 'executionAuthorized', 'actionsExecuted',
    'writesExecuted', 'receiptSha256',
  ];
  if (!exactKeys(receipt, keys)
    || receipt.schema !== ADMIN_RECEIPT_SCHEMA
    || !['registered', 'cancelled'].includes(receipt.action)
    || !JEFF_HASH.test(String(receipt.scheduleSha256 ?? ''))
    || !JEFF_HASH.test(String(receipt.authorizationAttestationSha256 ?? ''))
    || !validEpoch(receipt.ownerEpoch)
    || receipt.executionAuthorized !== false
    || receipt.actionsExecuted !== 0
    || receipt.writesExecuted !== 0
    || !JEFF_HASH.test(String(receipt.receiptSha256 ?? ''))) return false;
  try {
    assertJeffIsoTimestamp(receipt.recordedAt, 'JEFF_OS_SCHEDULE_ADMIN_RECEIPT_INVALID');
  } catch {
    return false;
  }
  const { receiptSha256, ...body } = receipt;
  return receiptSha256 === hashJeffBrainValue(body);
}

function adminReceipt({ action, scheduleSha256, attestation, ownerEpoch, recordedAt }) {
  const body = {
    schema: ADMIN_RECEIPT_SCHEMA,
    action,
    scheduleSha256,
    authorizationAttestationSha256: attestation.attestationSha256,
    ownerEpoch,
    recordedAt,
    executionAuthorized: false,
    actionsExecuted: 0,
    writesExecuted: 0,
  };
  const receipt = Object.freeze({ ...body, receiptSha256: hashJeffBrainValue(body) });
  if (!verifyJeffOsScheduleAdminReceipt(receipt)) {
    throw new Error('JEFF_OS_SCHEDULE_ADMIN_RECEIPT_INVALID');
  }
  return receipt;
}

export async function registerJeffOsSchedule({
  schedule,
  subject,
  authorizationVerifier,
  store,
  now = () => new Date().toISOString(),
} = {}) {
  if (!verifyJeffOsSchedule(schedule) || schedule.enabled !== true
    || !store || typeof store.putSchedule !== 'function') {
    throw new Error('JEFF_OS_SCHEDULE_REGISTRATION_INVALID');
  }
  const recordedAt = assertJeffIsoTimestamp(now(), 'JEFF_OS_SCHEDULE_CLOCK_INVALID');
  if (Date.parse(recordedAt) >= Date.parse(schedule.expiresAt)) {
    throw new Error('JEFF_OS_SCHEDULE_EXPIRED');
  }
  const attestation = await requireJeffAuthorization({
    verifier: authorizationVerifier,
    scope: {
      agentId: schedule.agentId,
      ownerId: schedule.ownerId,
      scheduleSha256: schedule.scheduleSha256,
    },
    subject,
    operation: 'register_schedule',
    ownerEpoch: schedule.ownerEpoch,
    now,
  });
  await store.putSchedule(schedule);
  return adminReceipt({
    action: 'registered',
    scheduleSha256: schedule.scheduleSha256,
    attestation,
    ownerEpoch: schedule.ownerEpoch,
    recordedAt,
  });
}

export async function cancelJeffOsSchedule({
  scheduleSha256,
  subject,
  ownerEpoch,
  authorizationVerifier,
  store,
  now = () => new Date().toISOString(),
} = {}) {
  if (!JEFF_HASH.test(String(scheduleSha256 ?? ''))
    || !validEpoch(ownerEpoch)
    || !store
    || typeof store.getSchedule !== 'function'
    || typeof store.cancelSchedule !== 'function') {
    throw new Error('JEFF_OS_SCHEDULE_CANCEL_INVALID');
  }
  const definition = await store.getSchedule(scheduleSha256);
  if (!definition
    || definition.status !== 'active'
    || !verifyJeffOsSchedule(definition.schedule)
    || definition.schedule.ownerEpoch !== ownerEpoch) {
    throw new Error('JEFF_OS_SCHEDULE_CANCEL_DENIED');
  }
  const recordedAt = assertJeffIsoTimestamp(now(), 'JEFF_OS_SCHEDULE_CLOCK_INVALID');
  const attestation = await requireJeffAuthorization({
    verifier: authorizationVerifier,
    scope: {
      agentId: definition.schedule.agentId,
      ownerId: definition.schedule.ownerId,
      scheduleSha256,
    },
    subject,
    operation: 'cancel_schedule',
    ownerEpoch,
    now,
  });
  await store.cancelSchedule({ scheduleSha256, cancelledAt: recordedAt });
  return adminReceipt({
    action: 'cancelled', scheduleSha256, attestation, ownerEpoch, recordedAt,
  });
}

export function verifyJeffOsScheduleReceipt(receipt) {
  const keys = [
    'schema', 'scheduleSha256', 'runIndex', 'skillReceiptSha256',
    'authorizationAttestationSha256', 'startedAt', 'completedAt',
    'executionAuthorized', 'actionsExecuted', 'writesExecuted', 'receiptSha256',
  ];
  if (!exactKeys(receipt, keys)
    || receipt.schema !== RECEIPT_SCHEMA
    || !JEFF_HASH.test(String(receipt.scheduleSha256 ?? ''))
    || !Number.isSafeInteger(receipt.runIndex)
    || receipt.runIndex < 1
    || !JEFF_HASH.test(String(receipt.skillReceiptSha256 ?? ''))
    || !JEFF_HASH.test(String(receipt.authorizationAttestationSha256 ?? ''))
    || receipt.executionAuthorized !== false
    || receipt.actionsExecuted !== 0
    || receipt.writesExecuted !== 0
    || !JEFF_HASH.test(String(receipt.receiptSha256 ?? ''))) return false;
  try {
    const started = Date.parse(assertJeffIsoTimestamp(receipt.startedAt, 'JEFF_OS_SCHEDULE_RECEIPT_INVALID'));
    const completed = Date.parse(assertJeffIsoTimestamp(receipt.completedAt, 'JEFF_OS_SCHEDULE_RECEIPT_INVALID'));
    if (completed < started) return false;
  } catch {
    return false;
  }
  const { receiptSha256, ...body } = receipt;
  return receiptSha256 === hashJeffBrainValue(body);
}

export async function runJeffOsSchedule({
  schedule,
  subject,
  authorizationVerifier,
  registry,
  store,
  now = () => new Date().toISOString(),
} = {}) {
  if (!verifyJeffOsSchedule(schedule) || schedule.enabled !== true) {
    throw new Error('JEFF_OS_SCHEDULE_DISABLED');
  }
  if (!registry || typeof registry.invoke !== 'function'
    || !store
    || typeof store.getSchedule !== 'function'
    || typeof store.claim !== 'function'
    || typeof store.complete !== 'function'
    || typeof store.abort !== 'function') throw new Error('JEFF_OS_SCHEDULER_CONFIG_INVALID');
  const startedAt = assertJeffIsoTimestamp(now(), 'JEFF_OS_SCHEDULE_CLOCK_INVALID');
  const currentMs = Date.parse(startedAt);
  if (currentMs >= Date.parse(schedule.expiresAt)) throw new Error('JEFF_OS_SCHEDULE_EXPIRED');
  const definition = await store.getSchedule(schedule.scheduleSha256);
  if (!definition
    || definition.status !== 'active'
    || !verifyJeffOsSchedule(definition.schedule)
    || definition.schedule.scheduleSha256 !== schedule.scheduleSha256) {
    throw new Error('JEFF_OS_SCHEDULE_NOT_REGISTERED');
  }
  const scope = {
    agentId: schedule.agentId,
    ownerId: schedule.ownerId,
    scheduleSha256: schedule.scheduleSha256,
    skillId: schedule.skillId,
    operation: schedule.operation,
    inputSha256: schedule.inputSha256,
  };
  await requireJeffAuthorization({
    verifier: authorizationVerifier,
    scope,
    subject,
    operation: 'run_schedule',
    ownerEpoch: schedule.ownerEpoch,
    now,
  });
  const reservation = await store.claim({
    scheduleSha256: schedule.scheduleSha256,
    maximumRuns: schedule.maximumRuns,
    available: availableRuns(schedule, currentMs),
  });
  let skillStarted = false;
  try {
    const attestation = await requireJeffAuthorization({
      verifier: authorizationVerifier,
      scope: { ...scope, runIndex: reservation.runIndex },
      subject,
      operation: 'run_schedule',
      ownerEpoch: schedule.ownerEpoch,
      now,
    });
    skillStarted = true;
    const invocation = await registry.invoke({
      skillId: schedule.skillId,
      operation: schedule.operation,
      input: schedule.input,
      subject,
      ownerEpoch: schedule.ownerEpoch,
      authorizationVerifier,
      now,
    });
    if (!verifyJeffOsSkillReceipt(invocation.receipt)
      || invocation.receipt.executionAuthorized !== false
      || invocation.receipt.writesExecuted !== 0) {
      throw new Error('JEFF_OS_SCHEDULE_SKILL_RECEIPT_INVALID');
    }
    const completedAt = assertJeffIsoTimestamp(now(), 'JEFF_OS_SCHEDULE_CLOCK_INVALID');
    const body = {
      schema: RECEIPT_SCHEMA,
      scheduleSha256: schedule.scheduleSha256,
      runIndex: reservation.runIndex,
      skillReceiptSha256: invocation.receipt.receiptSha256,
      authorizationAttestationSha256: attestation.attestationSha256,
      startedAt,
      completedAt,
      executionAuthorized: false,
      actionsExecuted: 0,
      writesExecuted: 0,
    };
    const receipt = Object.freeze({ ...body, receiptSha256: hashJeffBrainValue(body) });
    if (!verifyJeffOsScheduleReceipt(receipt)) throw new Error('JEFF_OS_SCHEDULE_RECEIPT_INVALID');
    await store.complete({
      scheduleSha256: schedule.scheduleSha256,
      runIndex: reservation.runIndex,
      receiptSha256: receipt.receiptSha256,
    });
    return Object.freeze({ invocation, receipt });
  } catch (error) {
    if (!skillStarted) {
      await store.abort({ scheduleSha256: schedule.scheduleSha256, runIndex: reservation.runIndex });
    }
    throw error;
  }
}

export const JEFF_OS_SCHEDULER = Object.freeze({
  scheduleSchema: SCHEDULE_SCHEMA,
  receiptSchema: RECEIPT_SCHEMA,
  adminReceiptSchema: ADMIN_RECEIPT_SCHEMA,
  maximumScheduleTtlMs: MAX_SCHEDULE_TTL_MS,
  maximumRuns: MAX_RUNS,
  minimumIntervalSeconds: MIN_INTERVAL_SECONDS,
  executionAuthorized: false,
  writesAllowed: false,
});
