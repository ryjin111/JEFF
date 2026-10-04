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

const MANIFEST_SCHEMA = 'jeff-os-skill-manifest-v1';
const RESULT_SCHEMA = 'jeff-os-skill-result-v1';
const RECEIPT_SCHEMA = 'jeff-os-skill-receipt-v1';
const MODES = new Set(['read_only', 'simulate', 'prepare_write']);
const NETWORK_ACCESS = new Set(['none', 'allowlisted_read']);
const SENSITIVE_KEY = /(?:api.?key|credential|mnemonic|passphrase|password|private.?key|raw.?transaction|secret|seed.?phrase|signature)/i;
const MAX_INPUT_BYTES = 16_384;
const MAX_RESULT_BYTES = 65_536;

function exactKeys(value, keys) {
  return isJeffRecord(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(canonicalizeJeffValue(value)), 'utf8');
}

function containsSensitiveKey(value) {
  if (Array.isArray(value)) return value.some(containsSensitiveKey);
  if (!isJeffRecord(value)) return false;
  return Object.entries(value).some(([key, entry]) => SENSITIVE_KEY.test(key) || containsSensitiveKey(entry));
}

function normalizeSafeRecord(value, code, maximumBytes) {
  if (!isJeffRecord(value) || containsSensitiveKey(value) || jsonBytes(value) > maximumBytes) {
    throw new Error(code);
  }
  return Object.freeze(structuredClone(value));
}

function normalizeOperations(operations) {
  if (!Array.isArray(operations)
    || operations.length < 1
    || operations.length > 32) throw new Error('JEFF_OS_SKILL_MANIFEST_INVALID');
  const normalized = operations.map((operation) => assertJeffName(
    operation,
    'JEFF_OS_SKILL_MANIFEST_INVALID',
  ));
  if (new Set(normalized).size !== normalized.length) {
    throw new Error('JEFF_OS_SKILL_MANIFEST_INVALID');
  }
  return Object.freeze([...normalized].sort());
}

export function verifyJeffOsSkillManifest(manifest) {
  const keys = [
    'schema', 'id', 'version', 'description', 'mode', 'operations', 'networkAccess',
    'dataEgress', 'writesAllowed', 'requiresOwnerApproval', 'enabled',
    'integritySha256', 'manifestSha256',
  ];
  if (!exactKeys(manifest, keys)
    || manifest.schema !== MANIFEST_SCHEMA
    || typeof manifest.id !== 'string'
    || !/^[a-z][a-z0-9_.-]{0,127}$/i.test(manifest.id)
    || typeof manifest.version !== 'string'
    || !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(manifest.version)
    || typeof manifest.description !== 'string'
    || !manifest.description.trim()
    || manifest.description.length > 1_000
    || !MODES.has(manifest.mode)
    || !Array.isArray(manifest.operations)
    || manifest.operations.length < 1
    || manifest.operations.length > 32
    || new Set(manifest.operations).size !== manifest.operations.length
    || manifest.operations.some((operation) => typeof operation !== 'string'
      || !/^[a-z][a-z0-9_.-]{0,127}$/i.test(operation))
    || !NETWORK_ACCESS.has(manifest.networkAccess)
    || (manifest.mode === 'simulate' && manifest.networkAccess !== 'none')
    || manifest.dataEgress !== 'public_only'
    || manifest.writesAllowed !== false
    || typeof manifest.requiresOwnerApproval !== 'boolean'
    || (manifest.mode === 'prepare_write' && manifest.requiresOwnerApproval !== true)
    || typeof manifest.enabled !== 'boolean'
    || !JEFF_HASH.test(String(manifest.integritySha256 ?? ''))
    || !JEFF_HASH.test(String(manifest.manifestSha256 ?? ''))) return false;
  const { manifestSha256, ...body } = manifest;
  return manifest.manifestSha256 === hashJeffBrainValue(body);
}

export function createJeffOsSkillManifest({
  id,
  version,
  description,
  mode,
  operations,
  networkAccess = mode === 'simulate' ? 'none' : 'allowlisted_read',
  requiresOwnerApproval = mode === 'prepare_write',
  enabled = false,
  integritySha256,
} = {}) {
  const body = {
    schema: MANIFEST_SCHEMA,
    id: assertJeffName(id, 'JEFF_OS_SKILL_MANIFEST_INVALID'),
    version: assertJeffText(version, 'JEFF_OS_SKILL_MANIFEST_INVALID', 128),
    description: assertJeffText(description, 'JEFF_OS_SKILL_MANIFEST_INVALID', 1_000),
    mode,
    operations: normalizeOperations(operations),
    networkAccess,
    dataEgress: 'public_only',
    writesAllowed: false,
    requiresOwnerApproval,
    enabled,
    integritySha256,
  };
  const manifest = Object.freeze({ ...body, manifestSha256: hashJeffBrainValue(body) });
  if (!verifyJeffOsSkillManifest(manifest)) throw new Error('JEFF_OS_SKILL_MANIFEST_INVALID');
  return manifest;
}

export function verifyJeffOsSkillReceipt(receipt) {
  const keys = [
    'schema', 'skillId', 'skillVersion', 'operation', 'mode', 'manifestSha256',
    'inputSha256', 'resultSha256', 'authorizationAttestationSha256', 'ownerEpoch',
    'completedAt', 'executionAuthorized', 'actionsExecuted', 'writesExecuted',
    'receiptSha256',
  ];
  if (!exactKeys(receipt, keys)
    || receipt.schema !== RECEIPT_SCHEMA
    || typeof receipt.skillId !== 'string'
    || typeof receipt.skillVersion !== 'string'
    || typeof receipt.operation !== 'string'
    || !MODES.has(receipt.mode)
    || !JEFF_HASH.test(String(receipt.manifestSha256 ?? ''))
    || !JEFF_HASH.test(String(receipt.inputSha256 ?? ''))
    || !JEFF_HASH.test(String(receipt.resultSha256 ?? ''))
    || !JEFF_HASH.test(String(receipt.authorizationAttestationSha256 ?? ''))
    || !Number.isSafeInteger(receipt.ownerEpoch)
    || receipt.ownerEpoch < 0
    || receipt.executionAuthorized !== false
    || receipt.actionsExecuted !== 0
    || receipt.writesExecuted !== 0
    || !JEFF_HASH.test(String(receipt.receiptSha256 ?? ''))) return false;
  try {
    assertJeffIsoTimestamp(receipt.completedAt, 'JEFF_OS_SKILL_RECEIPT_INVALID');
  } catch {
    return false;
  }
  const { receiptSha256, ...body } = receipt;
  return receiptSha256 === hashJeffBrainValue(body);
}

function normalizeResult(raw) {
  if (!exactKeys(raw, [
    'schema', 'ok', 'summary', 'data', 'evidence', 'executionAuthorized',
    'actionsExecuted', 'writesExecuted',
  ])
    || raw.schema !== RESULT_SCHEMA
    || raw.ok !== true
    || typeof raw.summary !== 'string'
    || !raw.summary.trim()
    || raw.summary.length > 2_000
    || !isJeffRecord(raw.data)
    || !Array.isArray(raw.evidence)
    || raw.evidence.length > 32
    || raw.executionAuthorized !== false
    || raw.actionsExecuted !== 0
    || raw.writesExecuted !== 0
    || containsSensitiveKey(raw)
    || jsonBytes(raw) > MAX_RESULT_BYTES) {
    throw new Error('JEFF_OS_SKILL_RESULT_INVALID');
  }
  const evidence = raw.evidence.map((entry) => {
    if (!exactKeys(entry, ['source', 'contentSha256'])
      || typeof entry.source !== 'string'
      || !entry.source.trim()
      || entry.source.length > 1_000
      || !JEFF_HASH.test(String(entry.contentSha256 ?? ''))) {
      throw new Error('JEFF_OS_SKILL_RESULT_INVALID');
    }
    return Object.freeze({ source: entry.source.trim(), contentSha256: entry.contentSha256 });
  });
  return Object.freeze({
    schema: RESULT_SCHEMA,
    ok: true,
    summary: raw.summary.trim(),
    data: Object.freeze(structuredClone(raw.data)),
    evidence: Object.freeze(evidence),
    executionAuthorized: false,
    actionsExecuted: 0,
    writesExecuted: 0,
  });
}

export function createJeffOsSkillRegistry({ manifests = [], adapters = {} } = {}) {
  if (!Array.isArray(manifests) || manifests.length > 128 || !isJeffRecord(adapters)) {
    throw new Error('JEFF_OS_SKILL_REGISTRY_INVALID');
  }
  const installed = new Map();
  for (const manifest of manifests) {
    if (!verifyJeffOsSkillManifest(manifest) || installed.has(manifest.id)) {
      throw new Error('JEFF_OS_SKILL_REGISTRY_INVALID');
    }
    const adapter = adapters[manifest.id];
    if (!adapter
      || adapter.manifestSha256 !== manifest.manifestSha256
      || typeof adapter.invoke !== 'function') {
      throw new Error('JEFF_OS_SKILL_ADAPTER_INVALID');
    }
    installed.set(manifest.id, Object.freeze({ manifest, adapter }));
  }

  return Object.freeze({
    list() {
      return Object.freeze([...installed.values()].map(({ manifest }) => manifest));
    },

    manifest(skillId) {
      return installed.get(String(skillId))?.manifest ?? null;
    },

    async invoke({
      skillId,
      operation,
      input,
      subject,
      ownerEpoch,
      authorizationVerifier,
      now = () => new Date().toISOString(),
    } = {}) {
      const entry = installed.get(String(skillId));
      if (!entry || entry.manifest.enabled !== true) throw new Error('JEFF_OS_SKILL_DISABLED');
      const normalizedOperation = assertJeffName(operation, 'JEFF_OS_SKILL_OPERATION_INVALID');
      if (!entry.manifest.operations.includes(normalizedOperation)) {
        throw new Error('JEFF_OS_SKILL_OPERATION_DENIED');
      }
      if (!Number.isSafeInteger(ownerEpoch) || ownerEpoch < 0) {
        throw new Error('JEFF_OS_SKILL_OWNER_EPOCH_INVALID');
      }
      const normalizedInput = normalizeSafeRecord(input, 'JEFF_OS_SKILL_INPUT_INVALID', MAX_INPUT_BYTES);
      const inputSha256 = hashJeffBrainValue(normalizedInput);
      const authorizationOperation = `use_skill:${entry.manifest.id}:${normalizedOperation}`;
      if (authorizationOperation.length > 128) throw new Error('JEFF_OS_SKILL_OPERATION_INVALID');
      const attestation = await requireJeffAuthorization({
        verifier: authorizationVerifier,
        scope: {
          skillId: entry.manifest.id,
          skillVersion: entry.manifest.version,
          manifestSha256: entry.manifest.manifestSha256,
          operation: normalizedOperation,
          inputSha256,
          mode: entry.manifest.mode,
        },
        subject: assertJeffText(subject, 'JEFF_OS_SKILL_SUBJECT_INVALID', 256),
        operation: authorizationOperation,
        ownerEpoch,
        now,
      });
      const result = normalizeResult(await entry.adapter.invoke(structuredClone(normalizedInput), Object.freeze({
        skillId: entry.manifest.id,
        skillVersion: entry.manifest.version,
        manifestSha256: entry.manifest.manifestSha256,
        operation: normalizedOperation,
        mode: entry.manifest.mode,
        ownerEpoch,
        authorizationAttestationSha256: attestation.attestationSha256,
      })));
      const body = {
        schema: RECEIPT_SCHEMA,
        skillId: entry.manifest.id,
        skillVersion: entry.manifest.version,
        operation: normalizedOperation,
        mode: entry.manifest.mode,
        manifestSha256: entry.manifest.manifestSha256,
        inputSha256,
        resultSha256: hashJeffBrainValue(result),
        authorizationAttestationSha256: attestation.attestationSha256,
        ownerEpoch,
        completedAt: assertJeffIsoTimestamp(now(), 'JEFF_OS_SKILL_CLOCK_INVALID'),
        executionAuthorized: false,
        actionsExecuted: 0,
        writesExecuted: 0,
      };
      const receipt = Object.freeze({ ...body, receiptSha256: hashJeffBrainValue(body) });
      if (!verifyJeffOsSkillReceipt(receipt)) throw new Error('JEFF_OS_SKILL_RECEIPT_INVALID');
      return Object.freeze({ result, receipt });
    },
  });
}

export const JEFF_OS_SKILLS = Object.freeze({
  manifestSchema: MANIFEST_SCHEMA,
  resultSchema: RESULT_SCHEMA,
  receiptSchema: RECEIPT_SCHEMA,
  modes: Object.freeze([...MODES]),
  executionAuthorized: false,
  writesAllowed: false,
});
