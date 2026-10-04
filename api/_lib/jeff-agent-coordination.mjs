import {
  assertJeffIsoTimestamp,
  assertJeffName,
  assertJeffText,
  canonicalizeJeffValue,
  containsJeffUnsafeText,
  hashJeffBrainValue,
  isJeffRecord,
  JEFF_HASH,
} from './jeff-brain-common.mjs';
import { requireJeffAuthorization } from './jeff-trusted-authorization.mjs';

const MESSAGE_SCHEMA = 'jeff-agent-message-v1';
const RECEIPT_SCHEMA = 'jeff-agent-message-receipt-v1';
const MESSAGE_KINDS = new Set(['request', 'response', 'notice']);
const MAX_TTL_MS = 60 * 60 * 1_000;
const MAX_PAYLOAD_BYTES = 16_384;
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

function normalizePayload(value) {
  if (!isJeffRecord(value)
    || containsSensitiveKey(value)
    || containsJeffUnsafeText(JSON.stringify(canonicalizeJeffValue(value)))
    || Buffer.byteLength(JSON.stringify(canonicalizeJeffValue(value)), 'utf8') > MAX_PAYLOAD_BYTES) {
    throw new Error('JEFF_AGENT_MESSAGE_PAYLOAD_INVALID');
  }
  return Object.freeze(structuredClone(value));
}

function validEpoch(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function verifyJeffAgentMessage(message) {
  const keys = [
    'schema', 'fromAgentId', 'toAgentId', 'ownerEpoch', 'threadId', 'kind',
    'payload', 'payloadSha256', 'createdAt', 'expiresAt', 'nonce',
    'authority', 'executionAuthorized', 'messageSha256',
  ];
  if (!exactKeys(message, keys)
    || message.schema !== MESSAGE_SCHEMA
    || typeof message.fromAgentId !== 'string'
    || !message.fromAgentId
    || message.fromAgentId.length > 256
    || typeof message.toAgentId !== 'string'
    || !message.toAgentId
    || message.toAgentId.length > 256
    || message.fromAgentId === message.toAgentId
    || !validEpoch(message.ownerEpoch)
    || typeof message.threadId !== 'string'
    || !/^[a-z][a-z0-9_.:-]{0,127}$/i.test(message.threadId)
    || !MESSAGE_KINDS.has(message.kind)
    || !isJeffRecord(message.payload)
    || containsSensitiveKey(message.payload)
    || containsJeffUnsafeText(JSON.stringify(canonicalizeJeffValue(message.payload)))
    || !JEFF_HASH.test(String(message.payloadSha256 ?? ''))
    || message.payloadSha256 !== hashJeffBrainValue(message.payload)
    || typeof message.nonce !== 'string'
    || message.nonce.length < 16
    || message.nonce.length > 128
    || message.authority !== 'none'
    || message.executionAuthorized !== false
    || !JEFF_HASH.test(String(message.messageSha256 ?? ''))) return false;
  let createdMs;
  let expiresMs;
  try {
    createdMs = Date.parse(assertJeffIsoTimestamp(message.createdAt, 'JEFF_AGENT_MESSAGE_INVALID'));
    expiresMs = Date.parse(assertJeffIsoTimestamp(message.expiresAt, 'JEFF_AGENT_MESSAGE_INVALID'));
  } catch {
    return false;
  }
  if (expiresMs <= createdMs || expiresMs - createdMs > MAX_TTL_MS) return false;
  const { messageSha256, ...body } = message;
  return message.messageSha256 === hashJeffBrainValue(body);
}

export function createJeffAgentMessage({
  fromAgentId,
  toAgentId,
  ownerEpoch,
  threadId,
  kind,
  payload,
  createdAt = new Date().toISOString(),
  expiresAt = new Date(Date.parse(createdAt) + 15 * 60 * 1_000).toISOString(),
  nonce,
} = {}) {
  const normalizedPayload = normalizePayload(payload);
  const body = {
    schema: MESSAGE_SCHEMA,
    fromAgentId: assertJeffText(fromAgentId, 'JEFF_AGENT_MESSAGE_INVALID', 256),
    toAgentId: assertJeffText(toAgentId, 'JEFF_AGENT_MESSAGE_INVALID', 256),
    ownerEpoch,
    threadId: assertJeffName(threadId, 'JEFF_AGENT_MESSAGE_INVALID'),
    kind,
    payload: normalizedPayload,
    payloadSha256: hashJeffBrainValue(normalizedPayload),
    createdAt: assertJeffIsoTimestamp(createdAt, 'JEFF_AGENT_MESSAGE_INVALID'),
    expiresAt: assertJeffIsoTimestamp(expiresAt, 'JEFF_AGENT_MESSAGE_INVALID'),
    nonce: assertJeffText(nonce, 'JEFF_AGENT_MESSAGE_INVALID', 128),
    authority: 'none',
    executionAuthorized: false,
  };
  const message = Object.freeze({ ...body, messageSha256: hashJeffBrainValue(body) });
  if (!verifyJeffAgentMessage(message)) throw new Error('JEFF_AGENT_MESSAGE_INVALID');
  return message;
}

export function createInMemoryJeffAgentMessageStore() {
  const messages = new Map();
  return Object.freeze({
    async put(message) {
      if (!verifyJeffAgentMessage(message)) throw new Error('JEFF_AGENT_MESSAGE_INVALID');
      if (messages.has(message.messageSha256)) throw new Error('JEFF_AGENT_MESSAGE_REPLAYED');
      messages.set(message.messageSha256, structuredClone(message));
    },
    async listFor(agentId) {
      return Object.freeze([...messages.values()]
        .filter((message) => message.toAgentId === agentId)
        .map((message) => Object.freeze(structuredClone(message))));
    },
    async snapshot() {
      return structuredClone([...messages.values()]);
    },
  });
}

export function verifyJeffAgentMessageReceipt(receipt) {
  const keys = [
    'schema', 'messageSha256', 'fromAgentIdSha256', 'toAgentIdSha256',
    'authorizationAttestationSha256', 'deliveredAt', 'authority',
    'executionAuthorized', 'actionsExecuted', 'writesExecuted', 'receiptSha256',
  ];
  if (!exactKeys(receipt, keys)
    || receipt.schema !== RECEIPT_SCHEMA
    || !JEFF_HASH.test(String(receipt.messageSha256 ?? ''))
    || !JEFF_HASH.test(String(receipt.fromAgentIdSha256 ?? ''))
    || !JEFF_HASH.test(String(receipt.toAgentIdSha256 ?? ''))
    || !JEFF_HASH.test(String(receipt.authorizationAttestationSha256 ?? ''))
    || receipt.authority !== 'none'
    || receipt.executionAuthorized !== false
    || receipt.actionsExecuted !== 0
    || receipt.writesExecuted !== 0
    || !JEFF_HASH.test(String(receipt.receiptSha256 ?? ''))) return false;
  try {
    assertJeffIsoTimestamp(receipt.deliveredAt, 'JEFF_AGENT_MESSAGE_RECEIPT_INVALID');
  } catch {
    return false;
  }
  const { receiptSha256, ...body } = receipt;
  return receiptSha256 === hashJeffBrainValue(body);
}

export async function routeJeffAgentMessage({
  message,
  subject,
  authorizationVerifier,
  directory,
  store,
  now = () => new Date().toISOString(),
} = {}) {
  if (!verifyJeffAgentMessage(message)) throw new Error('JEFF_AGENT_MESSAGE_INVALID');
  if (!directory || typeof directory.isRegistered !== 'function'
    || !store || typeof store.put !== 'function') {
    throw new Error('JEFF_AGENT_COORDINATION_CONFIG_INVALID');
  }
  const deliveredAt = assertJeffIsoTimestamp(now(), 'JEFF_AGENT_MESSAGE_CLOCK_INVALID');
  const deliveredMs = Date.parse(deliveredAt);
  if (deliveredMs < Date.parse(message.createdAt) || deliveredMs >= Date.parse(message.expiresAt)) {
    throw new Error('JEFF_AGENT_MESSAGE_EXPIRED');
  }
  if (await directory.isRegistered(message.fromAgentId) !== true
    || await directory.isRegistered(message.toAgentId) !== true) {
    throw new Error('JEFF_AGENT_MESSAGE_ROUTE_DENIED');
  }
  const attestation = await requireJeffAuthorization({
    verifier: authorizationVerifier,
    scope: {
      messageSha256: message.messageSha256,
      fromAgentId: message.fromAgentId,
      toAgentId: message.toAgentId,
      threadId: message.threadId,
      kind: message.kind,
      payloadSha256: message.payloadSha256,
    },
    subject: assertJeffText(subject, 'JEFF_AGENT_MESSAGE_SUBJECT_INVALID', 256),
    operation: 'route_agent_message',
    ownerEpoch: message.ownerEpoch,
    now,
  });
  await store.put(message);
  const body = {
    schema: RECEIPT_SCHEMA,
    messageSha256: message.messageSha256,
    fromAgentIdSha256: hashJeffBrainValue(message.fromAgentId),
    toAgentIdSha256: hashJeffBrainValue(message.toAgentId),
    authorizationAttestationSha256: attestation.attestationSha256,
    deliveredAt,
    authority: 'none',
    executionAuthorized: false,
    actionsExecuted: 0,
    writesExecuted: 0,
  };
  const receipt = Object.freeze({ ...body, receiptSha256: hashJeffBrainValue(body) });
  if (!verifyJeffAgentMessageReceipt(receipt)) throw new Error('JEFF_AGENT_MESSAGE_RECEIPT_INVALID');
  return Object.freeze({ message, receipt });
}

export const JEFF_AGENT_COORDINATION = Object.freeze({
  messageSchema: MESSAGE_SCHEMA,
  receiptSchema: RECEIPT_SCHEMA,
  maximumTtlMs: MAX_TTL_MS,
  messageKinds: Object.freeze([...MESSAGE_KINDS]),
  authority: 'none',
  executionAuthorized: false,
});
