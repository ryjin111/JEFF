import {
  assertJeffIsoTimestamp,
  assertJeffName,
  assertJeffText,
  containsJeffUnsafeText,
  hashJeffBrainValue,
  isJeffRecord,
  jeffRelevance,
} from './jeff-brain-common.mjs';

const MEMORY_SCHEMA = 'jeff-authorized-memory-record-v1';

function normalizeScope(scope) {
  if (!isJeffRecord(scope)) throw new Error('JEFF_MEMORY_SCOPE_INVALID');
  const ownerEpoch = scope.ownerEpoch;
  if (!Number.isSafeInteger(ownerEpoch) || ownerEpoch < 0) throw new Error('JEFF_MEMORY_SCOPE_INVALID');
  return Object.freeze({
    agentId: assertJeffText(scope.agentId, 'JEFF_MEMORY_SCOPE_INVALID', 256),
    ownerId: assertJeffText(scope.ownerId, 'JEFF_MEMORY_SCOPE_INVALID', 256),
    ownerEpoch,
  });
}

function assertAuthorization(scope, authorization, capability) {
  if (!isJeffRecord(authorization)
    || authorization.agentId !== scope.agentId
    || authorization.ownerId !== scope.ownerId
    || authorization.ownerEpoch !== scope.ownerEpoch
    || authorization[capability] !== true) {
    throw new Error('JEFF_MEMORY_AUTHORIZATION_DENIED');
  }
}

function recordBody(fields) {
  return {
    schema: MEMORY_SCHEMA,
    kind: fields.kind,
    id: fields.id,
    scopeSha256: fields.scopeSha256,
    ownerEpoch: fields.ownerEpoch,
    sourceSha256: fields.sourceSha256,
    contentSha256: fields.contentSha256,
    ciphertext: fields.ciphertext,
    verified: fields.verified,
    createdAt: fields.createdAt,
    expiresAt: fields.expiresAt,
    previousRecordSha256: fields.previousRecordSha256,
  };
}

function verifyRecord(record, scopeSha256, previousRecordSha256) {
  if (!isJeffRecord(record) || record.schema !== MEMORY_SCHEMA || record.scopeSha256 !== scopeSha256) return false;
  if (record.previousRecordSha256 !== previousRecordSha256) return false;
  const { recordSha256, ...body } = record;
  return typeof recordSha256 === 'string' && recordSha256 === hashJeffBrainValue(body);
}

export function createInMemoryJeffMemoryAdapter(initialRecords = []) {
  const records = structuredClone(initialRecords);
  return Object.freeze({
    async append(record) { records.push(structuredClone(record)); },
    async list(scopeSha256) {
      return structuredClone(records.filter((record) => record.scopeSha256 === scopeSha256));
    },
    async snapshot() { return structuredClone(records); },
  });
}

export function createJeffAuthorizedMemory({ adapter, crypto, now = () => new Date().toISOString() } = {}) {
  if (!adapter || typeof adapter.append !== 'function' || typeof adapter.list !== 'function') {
    throw new Error('JEFF_MEMORY_ADAPTER_INVALID');
  }
  if (!crypto || typeof crypto.seal !== 'function' || typeof crypto.open !== 'function') {
    throw new Error('JEFF_MEMORY_CRYPTO_REQUIRED');
  }

  async function recordsFor(scope) {
    const scopeSha256 = hashJeffBrainValue(scope);
    const records = await adapter.list(scopeSha256);
    if (!Array.isArray(records)) throw new Error('JEFF_MEMORY_ADAPTER_INVALID');
    let previous = null;
    for (const record of records) {
      if (!verifyRecord(record, scopeSha256, previous)) throw new Error('JEFF_MEMORY_INTEGRITY_FAILED');
      previous = record.recordSha256;
    }
    return { records, scopeSha256, previous };
  }

  async function append(scope, fields) {
    const chain = await recordsFor(scope);
    const body = recordBody({
      ...fields,
      scopeSha256: chain.scopeSha256,
      ownerEpoch: scope.ownerEpoch,
      previousRecordSha256: chain.previous,
    });
    const record = Object.freeze({ ...body, recordSha256: hashJeffBrainValue(body) });
    await adapter.append(record);
    return record;
  }

  return Object.freeze({
    async remember({ scope: rawScope, authorization, memory }) {
      const scope = normalizeScope(rawScope);
      assertAuthorization(scope, authorization, 'canWriteMemory');
      if (!isJeffRecord(memory)) throw new Error('JEFF_MEMORY_INPUT_INVALID');
      const id = assertJeffName(memory.id, 'JEFF_MEMORY_INPUT_INVALID');
      const content = assertJeffText(memory.content, 'JEFF_MEMORY_INPUT_INVALID', 8_192);
      const source = assertJeffText(memory.source, 'JEFF_MEMORY_INPUT_INVALID', 1_024);
      if (typeof memory.verified !== 'boolean') throw new Error('JEFF_MEMORY_INPUT_INVALID');
      const createdAt = assertJeffIsoTimestamp(memory.createdAt ?? now(), 'JEFF_MEMORY_TIME_INVALID');
      const expiresAt = assertJeffIsoTimestamp(memory.expiresAt, 'JEFF_MEMORY_TIME_INVALID');
      if (Date.parse(expiresAt) <= Date.parse(createdAt)) throw new Error('JEFF_MEMORY_TIME_INVALID');
      const scopeSha256 = hashJeffBrainValue(scope);
      const ciphertext = await crypto.seal({ plaintext: content, scopeSha256 });
      if (typeof ciphertext !== 'string' || !ciphertext || ciphertext === content) {
        throw new Error('JEFF_MEMORY_ENCRYPTION_FAILED');
      }
      return append(scope, {
        kind: 'memory', id, sourceSha256: hashJeffBrainValue(source),
        contentSha256: hashJeffBrainValue(content), ciphertext,
        verified: memory.verified, createdAt, expiresAt,
      });
    },

    async revoke({ scope: rawScope, authorization, id }) {
      const scope = normalizeScope(rawScope);
      assertAuthorization(scope, authorization, 'canWriteMemory');
      return append(scope, {
        kind: 'revoke', id: assertJeffName(id, 'JEFF_MEMORY_INPUT_INVALID'),
        sourceSha256: null, contentSha256: null, ciphertext: null,
        verified: true, createdAt: assertJeffIsoTimestamp(now(), 'JEFF_MEMORY_TIME_INVALID'), expiresAt: null,
      });
    },

    async recall({ scope: rawScope, authorization, objective, maximum = 6 }) {
      const scope = normalizeScope(rawScope);
      assertAuthorization(scope, authorization, 'canReadMemory');
      const goal = assertJeffText(objective, 'JEFF_MEMORY_OBJECTIVE_INVALID', 4_096);
      if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 24) throw new Error('JEFF_MEMORY_LIMIT_INVALID');
      const { records, scopeSha256 } = await recordsFor(scope);
      const revoked = new Set(records.filter(({ kind }) => kind === 'revoke').map(({ id }) => id));
      const latest = new Map();
      for (const record of records) {
        if (record.kind === 'memory') latest.set(record.id, record);
      }
      const selected = [];
      const quarantined = [];
      for (const record of latest.values()) {
        let reason = revoked.has(record.id)
          ? 'revoked'
          : record.verified
            ? Date.parse(record.expiresAt) <= Date.parse(now()) ? 'expired' : null
            : 'unverified';
        let text = null;
        if (!reason) {
          text = await crypto.open({ ciphertext: record.ciphertext, scopeSha256 });
          if (typeof text !== 'string' || hashJeffBrainValue(text) !== record.contentSha256) {
            throw new Error('JEFF_MEMORY_DECRYPTION_INTEGRITY_FAILED');
          }
          reason = containsJeffUnsafeText(text);
        }
        if (reason) quarantined.push({ id: record.id, reason, recordSha256: record.recordSha256 });
        else selected.push({
          id: record.id,
          text,
          source: `sha256:${record.sourceSha256}`,
          relevance: jeffRelevance(goal, text),
          recordSha256: record.recordSha256,
        });
      }
      selected.sort((left, right) => right.relevance - left.relevance || left.id.localeCompare(right.id));
      return Object.freeze({
        scopeSha256,
        selected: Object.freeze(selected.slice(0, maximum)),
        quarantined: Object.freeze(quarantined),
      });
    },
  });
}

export const JEFF_AUTHORIZED_MEMORY = Object.freeze({
  schema: MEMORY_SCHEMA,
  encryptedAtRestRequired: true,
  ownerScoped: true,
  transferIsolation: 'ownerEpoch',
});
