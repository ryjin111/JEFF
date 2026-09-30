import {
  assertJeffIsoTimestamp,
  assertJeffName,
  assertJeffRecord,
  assertJeffText,
  hashJeffBrainValue,
  isJeffRecord,
  JEFF_HASH,
} from './jeff-brain-common.mjs';
import { verifyJeffBrainReceipt } from './jeff-brain-v1.mjs';
import { requireJeffAuthorization } from './jeff-trusted-authorization.mjs';

const POLICY_SCHEMA = 'jeff-execution-policy-v1';
const INTENT_SCHEMA = 'jeff-execution-intent-v1';
const RECEIPT_SCHEMA = 'jeff-execution-receipt-v1';
const AUTH_SCOPE_SCHEMA = 'jeff-execution-authorization-scope-v1';
const MAX_POLICY_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_ACTIONS = 8;
const EXECUTABLE_MODES = new Set(['write']);

function exactKeys(value, keys) {
  return isJeffRecord(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function validEpoch(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validActionLimit(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_ACTIONS;
}

function policyBody(policy) {
  if (!isJeffRecord(policy)) return null;
  const { policySha256, ...body } = policy;
  return body;
}

export function verifyJeffExecutionPolicy(policy) {
  const keys = [
    'agentId', 'allowedTools', 'emergencyStop', 'enabled', 'expiresAt',
    'maximumActions', 'nonce', 'ownerEpoch', 'ownerId', 'policySha256',
    'requireSimulation', 'schema', 'validAfter',
  ];
  if (!exactKeys(policy, keys)
    || policy.schema !== POLICY_SCHEMA
    || typeof policy.agentId !== 'string'
    || typeof policy.ownerId !== 'string'
    || !validEpoch(policy.ownerEpoch)
    || typeof policy.enabled !== 'boolean'
    || typeof policy.emergencyStop !== 'boolean'
    || policy.requireSimulation !== true
    || !validActionLimit(policy.maximumActions)
    || !Array.isArray(policy.allowedTools)
    || policy.allowedTools.length < 1
    || policy.allowedTools.length > 32
    || new Set(policy.allowedTools).size !== policy.allowedTools.length
    || policy.allowedTools.some((name) => typeof name !== 'string' || !/^[a-z][a-z0-9_.-]{0,127}$/i.test(name))
    || typeof policy.nonce !== 'string'
    || policy.nonce.length < 16
    || policy.nonce.length > 128
    || !Number.isFinite(Date.parse(policy.validAfter))
    || !Number.isFinite(Date.parse(policy.expiresAt))
    || !JEFF_HASH.test(String(policy.policySha256 ?? ''))) return false;
  const validAfterMs = Date.parse(policy.validAfter);
  const expiresMs = Date.parse(policy.expiresAt);
  return expiresMs > validAfterMs
    && expiresMs - validAfterMs <= MAX_POLICY_TTL_MS
    && policy.policySha256 === hashJeffBrainValue(policyBody(policy));
}

export function createJeffExecutionPolicy({
  agentId,
  ownerId,
  ownerEpoch,
  allowedTools,
  maximumActions = 1,
  nonce,
  validAfter = new Date().toISOString(),
  expiresAt = new Date(Date.parse(validAfter) + 15 * 60 * 1_000).toISOString(),
  enabled = false,
  emergencyStop = true,
  requireSimulation = true,
} = {}) {
  const body = {
    schema: POLICY_SCHEMA,
    agentId: assertJeffText(agentId, 'JEFF_EXECUTION_POLICY_INVALID', 256),
    ownerId: assertJeffText(ownerId, 'JEFF_EXECUTION_POLICY_INVALID', 256),
    ownerEpoch,
    allowedTools: Array.isArray(allowedTools) ? allowedTools.map((name) => assertJeffName(name, 'JEFF_EXECUTION_POLICY_INVALID')) : null,
    maximumActions,
    nonce: assertJeffText(nonce, 'JEFF_EXECUTION_POLICY_INVALID', 128),
    validAfter: assertJeffIsoTimestamp(validAfter, 'JEFF_EXECUTION_POLICY_INVALID'),
    expiresAt: assertJeffIsoTimestamp(expiresAt, 'JEFF_EXECUTION_POLICY_INVALID'),
    enabled,
    emergencyStop,
    requireSimulation,
  };
  const policy = Object.freeze({ ...body, policySha256: hashJeffBrainValue(body) });
  if (!verifyJeffExecutionPolicy(policy)) throw new Error('JEFF_EXECUTION_POLICY_INVALID');
  return policy;
}

function verifyBrainResult(result) {
  return isJeffRecord(result)
    && result.schema === 'jeff-brain-result-v1'
    && result.mode === 'shadow'
    && result.executionAuthorized === false
    && result.actionsExecuted === 0
    && isJeffRecord(result.safety)
    && result.safety.disposition !== 'deny'
    && Array.isArray(result.safety.proposals)
    && verifyJeffBrainReceipt(result.audit);
}

export function createJeffExecutionIntent({
  brainResult,
  policy,
  proposalIndex = 0,
} = {}) {
  if (!verifyBrainResult(brainResult)
    || !verifyJeffExecutionPolicy(policy)
    || policy.enabled !== true
    || policy.emergencyStop !== false) {
    throw new Error('JEFF_EXECUTION_INTENT_DENIED');
  }
  const proposal = brainResult.safety.proposals[proposalIndex];
  if (!isJeffRecord(proposal)
    || !EXECUTABLE_MODES.has(proposal.mode)
    || proposal.executionAuthorized !== false
    || !['owner_review', 'simulation_candidate'].includes(proposal.status)
    || !policy.allowedTools.includes(proposal.tool)) {
    throw new Error('JEFF_EXECUTION_INTENT_DENIED');
  }
  const input = structuredClone(assertJeffRecord(proposal.input, 'JEFF_EXECUTION_INTENT_DENIED', 16_000));
  const body = {
    schema: INTENT_SCHEMA,
    agentId: policy.agentId,
    ownerId: policy.ownerId,
    ownerEpoch: policy.ownerEpoch,
    tool: proposal.tool,
    mode: proposal.mode,
    purpose: assertJeffText(proposal.purpose, 'JEFF_EXECUTION_INTENT_DENIED', 500),
    input,
    inputSha256: hashJeffBrainValue(input),
    brainReceiptSha256: brainResult.audit.receiptSha256,
    policySha256: policy.policySha256,
    idempotencyKey: hashJeffBrainValue({
      brainReceiptSha256: brainResult.audit.receiptSha256,
      policySha256: policy.policySha256,
      proposalIndex,
      tool: proposal.tool,
    }),
    status: 'pending_authorization',
    executionAuthorized: false,
    actionsExecuted: 0,
  };
  return Object.freeze({ ...body, intentSha256: hashJeffBrainValue(body) });
}

export function verifyJeffExecutionIntent(intent) {
  const keys = [
    'actionsExecuted', 'agentId', 'brainReceiptSha256', 'executionAuthorized',
    'idempotencyKey', 'input', 'inputSha256', 'intentSha256', 'mode', 'ownerEpoch',
    'ownerId', 'policySha256', 'purpose', 'schema', 'status', 'tool',
  ];
  if (!exactKeys(intent, keys)
    || intent.schema !== INTENT_SCHEMA
    || intent.status !== 'pending_authorization'
    || intent.executionAuthorized !== false
    || intent.actionsExecuted !== 0
    || !validEpoch(intent.ownerEpoch)
    || !EXECUTABLE_MODES.has(intent.mode)
    || !isJeffRecord(intent.input)
    || !JEFF_HASH.test(String(intent.inputSha256 ?? ''))
    || intent.inputSha256 !== hashJeffBrainValue(intent.input)
    || !JEFF_HASH.test(String(intent.brainReceiptSha256 ?? ''))
    || !JEFF_HASH.test(String(intent.policySha256 ?? ''))
    || !JEFF_HASH.test(String(intent.idempotencyKey ?? ''))
    || !JEFF_HASH.test(String(intent.intentSha256 ?? ''))) return false;
  const { intentSha256, ...body } = intent;
  return intentSha256 === hashJeffBrainValue(body);
}

function normalizeSimulation(value) {
  if (!isJeffRecord(value)
    || value.ok !== true
    || typeof value.summary !== 'string'
    || !value.summary.trim()
    || value.summary.length > 1_000
    || !JEFF_HASH.test(String(value.preStateSha256 ?? ''))
    || !JEFF_HASH.test(String(value.postStateSha256 ?? ''))) {
    throw new Error('JEFF_EXECUTION_SIMULATION_FAILED');
  }
  return Object.freeze(structuredClone(value));
}

function normalizeExecutionResult(value) {
  if (!isJeffRecord(value)
    || value.ok !== true
    || typeof value.externalId !== 'string'
    || !value.externalId.trim()
    || value.externalId.length > 512
    || !JEFF_HASH.test(String(value.finalStateSha256 ?? ''))) {
    throw new Error('JEFF_EXECUTION_RESULT_INVALID');
  }
  return Object.freeze(structuredClone(value));
}

function validatePolicyForIntent(policy, intent, now) {
  if (!verifyJeffExecutionPolicy(policy)
    || policy.enabled !== true
    || policy.emergencyStop !== false
    || !verifyJeffExecutionIntent(intent)
    || policy.policySha256 !== intent.policySha256
    || policy.agentId !== intent.agentId
    || policy.ownerId !== intent.ownerId
    || policy.ownerEpoch !== intent.ownerEpoch
    || !policy.allowedTools.includes(intent.tool)) throw new Error('JEFF_EXECUTION_POLICY_DENIED');
  const currentMs = Date.parse(assertJeffIsoTimestamp(now(), 'JEFF_EXECUTION_CLOCK_INVALID'));
  if (currentMs < Date.parse(policy.validAfter) || currentMs >= Date.parse(policy.expiresAt)) {
    throw new Error('JEFF_EXECUTION_POLICY_EXPIRED');
  }
}

export function createInMemoryJeffExecutionStore() {
  const records = new Map();
  const policyCounts = new Map();
  return Object.freeze({
    async begin({ idempotencyKey, intentSha256, policySha256, maximumActions }) {
      const current = records.get(idempotencyKey);
      if (current?.status === 'completed') return { status: 'completed', receipt: structuredClone(current.receipt) };
      if (current) throw new Error('JEFF_EXECUTION_ALREADY_IN_FLIGHT');
      const count = policyCounts.get(policySha256) ?? 0;
      if (count >= maximumActions) throw new Error('JEFF_EXECUTION_QUOTA_EXCEEDED');
      records.set(idempotencyKey, { status: 'reserved', intentSha256, policySha256 });
      policyCounts.set(policySha256, count + 1);
      return { status: 'reserved' };
    },
    async complete({ idempotencyKey, receipt }) {
      const current = records.get(idempotencyKey);
      if (!current || current.status !== 'reserved') throw new Error('JEFF_EXECUTION_RESERVATION_MISSING');
      records.set(idempotencyKey, { ...current, status: 'completed', receipt: structuredClone(receipt) });
    },
    async abort({ idempotencyKey }) {
      const current = records.get(idempotencyKey);
      if (current?.status !== 'reserved') return;
      records.delete(idempotencyKey);
      policyCounts.set(current.policySha256, Math.max(0, (policyCounts.get(current.policySha256) ?? 1) - 1));
    },
    async snapshot() {
      return structuredClone([...records.entries()]);
    },
  });
}

export async function executeJeffIntent({
  intent,
  policy,
  subject,
  authorizationVerifier,
  toolAdapter,
  executionStore,
  now = () => new Date().toISOString(),
} = {}) {
  validatePolicyForIntent(policy, intent, now);
  if (!toolAdapter
    || toolAdapter.name !== intent.tool
    || toolAdapter.mode !== intent.mode
    || typeof toolAdapter.simulate !== 'function'
    || typeof toolAdapter.execute !== 'function') throw new Error('JEFF_EXECUTION_TOOL_INVALID');
  if (!executionStore
    || typeof executionStore.begin !== 'function'
    || typeof executionStore.complete !== 'function'
    || typeof executionStore.abort !== 'function') throw new Error('JEFF_EXECUTION_STORE_REQUIRED');

  const simulation = normalizeSimulation(await toolAdapter.simulate(structuredClone(intent.input)));
  const simulationSha256 = hashJeffBrainValue(simulation);
  const authorizationScope = {
    schema: AUTH_SCOPE_SCHEMA,
    agentId: intent.agentId,
    ownerId: intent.ownerId,
    ownerEpoch: intent.ownerEpoch,
    intentSha256: intent.intentSha256,
    policySha256: policy.policySha256,
    tool: intent.tool,
    simulationSha256,
  };
  const authorization = await requireJeffAuthorization({
    verifier: authorizationVerifier,
    scope: authorizationScope,
    subject,
    operation: `execute:${intent.tool}`,
    ownerEpoch: intent.ownerEpoch,
    now,
  });
  // Simulation and authorization may outlive a short policy window. Recheck
  // the current policy immediately before reserving any execution capacity.
  validatePolicyForIntent(policy, intent, now);

  const reservation = await executionStore.begin({
    idempotencyKey: intent.idempotencyKey,
    intentSha256: intent.intentSha256,
    policySha256: policy.policySha256,
    maximumActions: policy.maximumActions,
  });
  if (reservation.status === 'completed') return Object.freeze(reservation.receipt);
  if (reservation.status !== 'reserved') throw new Error('JEFF_EXECUTION_RESERVATION_INVALID');

  try {
    const result = normalizeExecutionResult(await toolAdapter.execute(structuredClone(intent.input), Object.freeze({
      idempotencyKey: intent.idempotencyKey,
      intentSha256: intent.intentSha256,
      policySha256: policy.policySha256,
      simulationSha256,
      authorizationAttestationSha256: authorization.attestationSha256,
    })));
    const body = {
      schema: RECEIPT_SCHEMA,
      status: 'executed',
      agentId: intent.agentId,
      ownerIdSha256: hashJeffBrainValue(intent.ownerId),
      ownerEpoch: intent.ownerEpoch,
      tool: intent.tool,
      brainReceiptSha256: intent.brainReceiptSha256,
      policySha256: policy.policySha256,
      intentSha256: intent.intentSha256,
      inputSha256: intent.inputSha256,
      simulationSha256,
      authorizationAttestationSha256: authorization.attestationSha256,
      toolResultSha256: hashJeffBrainValue(result),
      externalIdSha256: hashJeffBrainValue(result.externalId),
      finalStateSha256: result.finalStateSha256,
      executedAt: assertJeffIsoTimestamp(now(), 'JEFF_EXECUTION_CLOCK_INVALID'),
      executionAuthorized: true,
      actionsExecuted: 1,
    };
    const receipt = Object.freeze({ ...body, receiptSha256: hashJeffBrainValue(body) });
    await executionStore.complete({ idempotencyKey: intent.idempotencyKey, receipt });
    return receipt;
  } catch (error) {
    // Once an adapter is called, its outcome may be unknown even when it throws.
    // Keep the reservation in-flight so an automatic retry cannot duplicate an effect.
    throw error;
  }
}

export function verifyJeffExecutionReceipt(receipt) {
  const keys = [
    'actionsExecuted', 'agentId', 'authorizationAttestationSha256',
    'brainReceiptSha256', 'executedAt', 'executionAuthorized', 'externalIdSha256',
    'finalStateSha256', 'inputSha256', 'intentSha256', 'ownerEpoch', 'ownerIdSha256',
    'policySha256', 'receiptSha256', 'schema', 'simulationSha256', 'status',
    'tool', 'toolResultSha256',
  ];
  if (!exactKeys(receipt, keys)
    || receipt.schema !== RECEIPT_SCHEMA
    || receipt.status !== 'executed'
    || receipt.executionAuthorized !== true
    || receipt.actionsExecuted !== 1
    || !Number.isFinite(Date.parse(receipt.executedAt))
    || !JEFF_HASH.test(String(receipt.receiptSha256 ?? ''))) return false;
  const hashFields = [
    'authorizationAttestationSha256', 'brainReceiptSha256', 'externalIdSha256', 'finalStateSha256',
    'inputSha256', 'intentSha256', 'ownerIdSha256', 'policySha256', 'simulationSha256', 'toolResultSha256',
  ];
  if (hashFields.some((key) => !JEFF_HASH.test(String(receipt[key] ?? '')))) return false;
  const { receiptSha256, ...body } = receipt;
  return receiptSha256 === hashJeffBrainValue(body);
}

export const JEFF_EXECUTION_GATE = Object.freeze({
  version: 'jeff-execution-gate-v1',
  defaultEnabled: false,
  maximumPolicyTtlMs: MAX_POLICY_TTL_MS,
  maximumActionsPerPolicy: MAX_ACTIONS,
  requiredControls: Object.freeze([
    'server_verified_authorization', 'simulation', 'time_bounded_policy',
    'tool_allowlist', 'atomic_idempotency', 'quota', 'emergency_stop', 'receipt',
  ]),
});
