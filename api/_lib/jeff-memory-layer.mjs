import { createHash } from 'node:crypto';

import { inferJeffAgentNftCandidateV09, JEFF_V09_CANDIDATE } from './jeff-agent-nft-candidate-v0.9.mjs';
import { JEFF_AGENT_NFT_CAPABILITY_QUESTIONS } from './jeff-agent-nft-capabilities.mjs';
import { validateJeffAgentNftResponse } from './jeff-agent-nft-contract.mjs';

const PROPOSAL_SCHEMA = 'jeff-memory-proposal-v1';
const RECEIPT_SCHEMA = 'jeff-memory-review-receipt-v1';
const RECORD_SCHEMA = 'jeff-memory-record-v1';
const STORAGE_ACK_SCHEMA = 'jeff-memory-storage-ack-v1';
const STORAGE_RECEIPT_SCHEMA = 'jeff-memory-storage-receipt-v1';
const OWNER_SCOPE_SCHEMA = 'jeff-memory-owner-scope-v1';
const ROOT_SCHEMA = 'jeff-memory-root-v1';
const OWNERSHIP_ATTESTATION_SCHEMA = 'jeff-memory-ownership-attestation-v1';
const REVIEW_TTL_MS = 5 * 60 * 1_000;
const OWNERSHIP_ATTESTATION_TTL_MS = 60 * 1_000;
const HASH_64 = /^[a-f0-9]{64}$/;
const ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const TOKEN_ID = /^(?:0|[1-9]\d*)$/;
const MAX_UINT256 = (1n << 256n) - 1n;
const SCOPES = new Set(['public', 'current-owner-only']);
const AGENT_NFT_KEYS = ['account', 'chainId', 'collection', 'tokenId'];
const PROPOSAL_KEYS = ['agentNft', 'memory', 'ownership', 'schema'];
const MEMORY_KEYS = [
  'capturedAt',
  'containsOwnerPrivateContent',
  'contentSha256',
  'currentRootSha256',
  'currentSequence',
  'expiresAt',
  'previousRootSha256',
  'proposedSequence',
  'provenance',
  'rawIncluded',
  'rootSha256',
  'scope',
];
const PROVENANCE_KEYS = ['independentPrimarySources', 'sourceCount', 'verified'];
const OWNERSHIP_KEYS = [
  'currentOwner',
  'ownerEpoch',
  'ownerChanged',
  'ownerScopeSha256',
  'ownerVerified',
  'previousOwnerAccessRevoked',
  'requesterAuthorized',
];
const RECORD_KEYS = [
  'agentNft',
  'capturedAt',
  'contentSha256',
  'expiresAt',
  'ownerScopeSha256',
  'previousRootSha256',
  'provenance',
  'recordSha256',
  'reviewReceiptSha256',
  'reviewValidUntil',
  'reviewedAt',
  'rootSha256',
  'schema',
  'scope',
  'sequence',
];
const ROOT_INPUT_KEYS = [
  'capturedAt',
  'contentSha256',
  'expiresAt',
  'ownerScopeSha256',
  'previousRootSha256',
  'provenance',
  'scope',
  'sequence',
];
const STORAGE_ACK_KEYS = ['recordSha256', 'referenceSha256', 'schema'];
const OWNERSHIP_ATTESTATION_KEYS = [
  'agentNftSha256',
  'currentOwner',
  'observedAt',
  'ownerEpoch',
  'schema',
];

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, keys) {
  return isPlainRecord(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function canonicalize(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((result, key) => {
      if (value[key] !== undefined) result[key] = canonicalize(value[key]);
      return result;
    }, {});
  }
  throw new TypeError('JEFF_MEMORY_VALUE_NOT_CANONICAL_JSON');
}

function hash(value) {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function validTimestamp(value) {
  if (typeof value !== 'string') return false;
  try {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
  } catch {
    return false;
  }
}

function validHash(value) {
  return typeof value === 'string' && HASH_64.test(value);
}

function validAddress(value) {
  return typeof value === 'string' && ADDRESS.test(value);
}

function validAgentNft(value) {
  if (!hasExactKeys(value, AGENT_NFT_KEYS)
    || !Number.isSafeInteger(value.chainId)
    || value.chainId <= 0
    || !validAddress(value.collection)
    || !validAddress(value.account)
    || typeof value.tokenId !== 'string'
    || !TOKEN_ID.test(value.tokenId)) return false;
  try {
    return BigInt(value.tokenId) <= MAX_UINT256;
  } catch {
    return false;
  }
}

function validOwnerEpoch(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function deriveJeffMemoryOwnerScope({ agentNft, currentOwner, ownerEpoch } = {}) {
  if (!validAgentNft(agentNft) || !validAddress(currentOwner) || !validOwnerEpoch(ownerEpoch)) {
    throw new Error('JEFF_MEMORY_OWNER_SCOPE_INVALID');
  }
  return hash({
    schema: OWNER_SCOPE_SCHEMA,
    agentNft: {
      chainId: agentNft.chainId,
      collection: agentNft.collection.toLowerCase(),
      tokenId: agentNft.tokenId,
      account: agentNft.account.toLowerCase(),
    },
    currentOwner: currentOwner.toLowerCase(),
    ownerEpoch,
  });
}

export function deriveJeffMemoryRoot(input) {
  if (!hasExactKeys(input, ROOT_INPUT_KEYS)
    || !validHash(input.contentSha256)
    || (input.previousRootSha256 !== null && !validHash(input.previousRootSha256))
    || !Number.isSafeInteger(input.sequence)
    || input.sequence < 1
    || !SCOPES.has(input.scope)
    || !validHash(input.ownerScopeSha256)
    || !hasExactKeys(input.provenance, PROVENANCE_KEYS)
    || typeof input.provenance.verified !== 'boolean'
    || !Number.isSafeInteger(input.provenance.sourceCount)
    || input.provenance.sourceCount < 0
    || !Number.isSafeInteger(input.provenance.independentPrimarySources)
    || input.provenance.independentPrimarySources < 0
    || input.provenance.independentPrimarySources > input.provenance.sourceCount
    || !validTimestamp(input.capturedAt)
    || !validTimestamp(input.expiresAt)) {
    throw new Error('JEFF_MEMORY_ROOT_INPUT_INVALID');
  }
  return hash({ schema: ROOT_SCHEMA, ...input });
}

function validateProposal(proposal) {
  const memory = proposal?.memory;
  const provenance = memory?.provenance;
  const ownership = proposal?.ownership;
  return hasExactKeys(proposal, PROPOSAL_KEYS)
    && proposal.schema === PROPOSAL_SCHEMA
    && validAgentNft(proposal.agentNft)
    && hasExactKeys(memory, MEMORY_KEYS)
    && validHash(memory.contentSha256)
    && validHash(memory.rootSha256)
    && (memory.previousRootSha256 === null || validHash(memory.previousRootSha256))
    && (memory.currentRootSha256 === null || validHash(memory.currentRootSha256))
    && Number.isSafeInteger(memory.currentSequence)
    && memory.currentSequence >= 0
    && Number.isSafeInteger(memory.proposedSequence)
    && memory.proposedSequence >= 1
    && SCOPES.has(memory.scope)
    && validTimestamp(memory.capturedAt)
    && validTimestamp(memory.expiresAt)
    && typeof memory.rawIncluded === 'boolean'
    && typeof memory.containsOwnerPrivateContent === 'boolean'
    && hasExactKeys(provenance, PROVENANCE_KEYS)
    && typeof provenance.verified === 'boolean'
    && Number.isSafeInteger(provenance.sourceCount)
    && provenance.sourceCount >= 0
    && Number.isSafeInteger(provenance.independentPrimarySources)
    && provenance.independentPrimarySources >= 0
    && provenance.independentPrimarySources <= provenance.sourceCount
    && hasExactKeys(ownership, OWNERSHIP_KEYS)
    && validAddress(ownership.currentOwner)
    && validOwnerEpoch(ownership.ownerEpoch)
    && validHash(ownership.ownerScopeSha256)
    && ownership.ownerScopeSha256 === deriveJeffMemoryOwnerScope({
      agentNft: proposal.agentNft,
      currentOwner: ownership.currentOwner,
      ownerEpoch: ownership.ownerEpoch,
    })
    && memory.rootSha256 === deriveJeffMemoryRoot({
      previousRootSha256: memory.previousRootSha256,
      contentSha256: memory.contentSha256,
      sequence: memory.proposedSequence,
      scope: memory.scope,
      ownerScopeSha256: ownership.ownerScopeSha256,
      provenance,
      capturedAt: memory.capturedAt,
      expiresAt: memory.expiresAt,
    })
    && typeof ownership.ownerVerified === 'boolean'
    && typeof ownership.requesterAuthorized === 'boolean'
    && typeof ownership.ownerChanged === 'boolean'
    && typeof ownership.previousOwnerAccessRevoked === 'boolean';
}

function validateMemoryRecord(record) {
  return hasExactKeys(record, RECORD_KEYS)
    && record.schema === RECORD_SCHEMA
    && validAgentNft(record.agentNft)
    && validHash(record.contentSha256)
    && validHash(record.rootSha256)
    && validHash(record.ownerScopeSha256)
    && (record.previousRootSha256 === null || validHash(record.previousRootSha256))
    && Number.isSafeInteger(record.sequence)
    && record.sequence >= 1
    && SCOPES.has(record.scope)
    && validTimestamp(record.capturedAt)
    && validTimestamp(record.expiresAt)
    && validTimestamp(record.reviewedAt)
    && validTimestamp(record.reviewValidUntil)
    && Date.parse(record.reviewedAt) < Date.parse(record.reviewValidUntil)
    && Date.parse(record.reviewValidUntil) <= Date.parse(record.expiresAt)
    && hasExactKeys(record.provenance, PROVENANCE_KEYS)
    && typeof record.provenance.verified === 'boolean'
    && Number.isSafeInteger(record.provenance.sourceCount)
    && record.provenance.sourceCount >= 0
    && Number.isSafeInteger(record.provenance.independentPrimarySources)
    && record.provenance.independentPrimarySources >= 0
    && record.provenance.independentPrimarySources <= record.provenance.sourceCount
    && validHash(record.reviewReceiptSha256)
    && record.rootSha256 === deriveJeffMemoryRoot({
      previousRootSha256: record.previousRootSha256,
      contentSha256: record.contentSha256,
      sequence: record.sequence,
      scope: record.scope,
      ownerScopeSha256: record.ownerScopeSha256,
      provenance: record.provenance,
      capturedAt: record.capturedAt,
      expiresAt: record.expiresAt,
    })
    && validHash(record.recordSha256);
}

function choiceAnswer(choice, labels, confidence = 0.54) {
  const remainder = (1 - confidence) / Math.max(1, labels.length - 1);
  return {
    type: 'choice',
    choice,
    probabilities: Object.fromEntries(labels.map((label) => [label, label === choice ? confidence : remainder])),
    confidence,
  };
}

function buildMemoryState(proposal, observedAt) {
  const { memory, ownership } = proposal;
  const observedMs = Date.parse(observedAt);
  const capturedMs = Date.parse(memory.capturedAt);
  const expiresMs = Date.parse(memory.expiresAt);
  const fresh = capturedMs <= observedMs && observedMs < expiresMs;
  const sequenceValid = memory.proposedSequence === memory.currentSequence + 1;
  const previousRootMatches = memory.previousRootSha256 === memory.currentRootSha256;
  const transferPrivacySafe = !ownership.ownerChanged || ownership.previousOwnerAccessRevoked;
  const privacySafe = !memory.rawIncluded
    && !memory.containsOwnerPrivateContent
    && transferPrivacySafe;
  const evidenceSufficient = memory.provenance.verified
    && fresh
    && memory.provenance.sourceCount > 0;
  const authorized = ownership.ownerVerified && ownership.requesterAuthorized;
  const validTransition = sequenceValid && previousRootMatches;
  const identityIntegrity = ownership.ownerVerified ? 'trusted' : 'unknown';
  const safetyFacts = {
    authorized,
    funded: true,
    validTransition,
    evidenceSufficient,
    privacySafe,
    validationSafe: true,
    identityIntegrity,
  };
  return {
    proposal: 'Review a hash-only durable memory proposal for this Agent NFT.',
    currentSequence: memory.currentSequence,
    proposedSequence: memory.proposedSequence,
    previousRootMatches,
    memoryProvenanceVerified: memory.provenance.verified,
    rawMemoryIncluded: memory.rawIncluded,
    dataHashOnly: !memory.rawIncluded,
    containsOwnerPrivateContent: memory.containsOwnerPrivateContent,
    publicMemoryVerified: memory.scope === 'public' && memory.provenance.verified,
    privateMemoryAccess: ownership.ownerChanged ? 'new-owner-only' : 'current-owner-only',
    previousOwnerAccessRevoked: ownership.previousOwnerAccessRevoked,
    ownerChanged: ownership.ownerChanged,
    dataFresh: fresh,
    provenanceVerified: memory.provenance.verified,
    sourceCount: memory.provenance.sourceCount,
    independentPrimarySources: memory.provenance.independentPrimarySources,
    requesterIsOwnerOrOperator: ownership.requesterAuthorized,
    ownershipVerified: ownership.ownerVerified,
    ownerPolicy: { allowAutonomous: false },
    safetyFacts,
    requiredSafetyFactsComplete: true,
  };
}

function supervisedDisposition(state, response) {
  if (state.rawMemoryIncluded || state.containsOwnerPrivateContent) return 'discard';
  const unsafe = Object.entries(state.safetyFacts).some(([key, value]) => (
    key === 'identityIntegrity' ? value !== 'trusted' : value === false
  ));
  if (unsafe) return 'quarantine';
  return state.publicMemoryVerified ? 'persist' : 'summarize';
}

export function reviewJeffMemoryProposal(proposal, options = {}) {
  if (!validateProposal(proposal)) throw new Error('JEFF_MEMORY_PROPOSAL_INVALID');
  const observedAt = options.observedAt ?? new Date().toISOString();
  if (!validTimestamp(observedAt)) throw new Error('JEFF_MEMORY_OBSERVED_AT_INVALID');
  const state = buildMemoryState(proposal, observedAt);
  const reviewValidUntil = new Date(Math.min(
    Date.parse(proposal.memory.expiresAt),
    Date.parse(observedAt) + REVIEW_TTL_MS,
  )).toISOString();
  const request = {
    agentNft: proposal.agentNft,
    state,
    questions: JEFF_AGENT_NFT_CAPABILITY_QUESTIONS,
  };
  const response = structuredClone(inferJeffAgentNftCandidateV09(request));
  const disposition = supervisedDisposition(state, response);
  if (disposition !== response.answers.memory_action.choice) {
    response.answers.memory_action = choiceAnswer(
      disposition,
      Object.keys(JEFF_AGENT_NFT_CAPABILITY_QUESTIONS.memory_action.criteria),
    );
  }
  if (!validateJeffAgentNftResponse(response, request)) throw new Error('JEFF_MEMORY_RESPONSE_INVALID');
  const commitAllowed = ['persist', 'summarize'].includes(disposition)
    && response.answers.authority.choice !== 'deny'
    && response.answers.permission_posture.choice !== 'deny'
    && state.safetyFacts.authorized
    && state.safetyFacts.validTransition
    && state.safetyFacts.evidenceSufficient
    && state.safetyFacts.privacySafe;
  const body = {
    schema: RECEIPT_SCHEMA,
    observedAt,
    model: JEFF_V09_CANDIDATE.model,
    mode: 'shadow',
    executionAuthorized: false,
    externalPolicyRequired: true,
    proposalSha256: hash(proposal),
    responseSha256: hash(response),
    agentNftSha256: hash(proposal.agentNft),
    contentSha256: proposal.memory.contentSha256,
    rootSha256: proposal.memory.rootSha256,
    ownerScopeSha256: proposal.ownership.ownerScopeSha256,
    sequence: proposal.memory.proposedSequence,
    scope: proposal.memory.scope,
    reviewValidUntil,
    disposition,
    commitAllowed,
    candidate: JEFF_V09_CANDIDATE.hashes,
  };
  const receipt = Object.freeze({ ...body, receiptSha256: hash(body) });
  return Object.freeze({ response: Object.freeze(response), receipt });
}

export function verifyJeffMemoryReceipt(receipt, proposal) {
  if (!receipt || receipt.schema !== RECEIPT_SCHEMA) return false;
  if (receipt.mode !== 'shadow' || receipt.executionAuthorized !== false) return false;
  try {
    const expected = reviewJeffMemoryProposal(proposal, { observedAt: receipt.observedAt }).receipt;
    return hash(receipt) === hash(expected);
  } catch {
    return false;
  }
}

export function prepareJeffMemoryRecord(proposal, receipt) {
  if (!verifyJeffMemoryReceipt(receipt, proposal)) throw new Error('JEFF_MEMORY_RECEIPT_INVALID');
  if (!receipt.commitAllowed) throw new Error('JEFF_MEMORY_COMMIT_NOT_ALLOWED');
  const record = {
    schema: RECORD_SCHEMA,
    agentNft: Object.freeze({ ...proposal.agentNft }),
    contentSha256: receipt.contentSha256,
    rootSha256: receipt.rootSha256,
    previousRootSha256: proposal.memory.previousRootSha256,
    sequence: receipt.sequence,
    scope: receipt.scope,
    capturedAt: proposal.memory.capturedAt,
    expiresAt: proposal.memory.expiresAt,
    ownerScopeSha256: receipt.ownerScopeSha256,
    provenance: Object.freeze({ ...proposal.memory.provenance }),
    reviewReceiptSha256: receipt.receiptSha256,
    reviewedAt: receipt.observedAt,
    reviewValidUntil: receipt.reviewValidUntil,
  };
  return Object.freeze({ ...record, recordSha256: hash(record) });
}

export async function commitJeffMemoryRecord(record, adapter, ownershipResolver, options = {}) {
  if (options.ownerApproved !== true) throw new Error('JEFF_MEMORY_OWNER_APPROVAL_REQUIRED');
  if (!validateMemoryRecord(record)) throw new Error('JEFF_MEMORY_RECORD_INVALID');
  if (!verifyJeffMemoryReceipt(options.reviewReceipt, options.proposal)) {
    throw new Error('JEFF_MEMORY_COMMIT_RECEIPT_INVALID');
  }
  const expectedRecord = prepareJeffMemoryRecord(options.proposal, options.reviewReceipt);
  if (expectedRecord.recordSha256 !== record.recordSha256) {
    throw new Error('JEFF_MEMORY_COMMIT_RECORD_MISMATCH');
  }
  if (!validTimestamp(options.committedAt)) throw new Error('JEFF_MEMORY_COMMIT_TIME_REQUIRED');
  const committedMs = Date.parse(options.committedAt);
  if (committedMs < Date.parse(record.reviewedAt)
    || committedMs >= Date.parse(record.reviewValidUntil)
    || committedMs >= Date.parse(record.expiresAt)) {
    throw new Error('JEFF_MEMORY_REVIEW_STALE');
  }
  const { recordSha256, ...body } = record;
  if (hash(body) !== recordSha256) throw new Error('JEFF_MEMORY_RECORD_HASH_MISMATCH');
  if (!adapter || typeof adapter.put !== 'function') throw new Error('JEFF_MEMORY_ADAPTER_INVALID');
  if (!ownershipResolver || typeof ownershipResolver.resolveCurrentOwner !== 'function') {
    throw new Error('JEFF_MEMORY_OWNERSHIP_RESOLVER_REQUIRED');
  }
  let ownershipAttestation;
  try {
    ownershipAttestation = await ownershipResolver.resolveCurrentOwner(
      Object.freeze(structuredClone(record.agentNft)),
    );
  } catch {
    throw new Error('JEFF_MEMORY_OWNERSHIP_RESOLUTION_FAILED');
  }
  if (!hasExactKeys(ownershipAttestation, OWNERSHIP_ATTESTATION_KEYS)
    || ownershipAttestation.schema !== OWNERSHIP_ATTESTATION_SCHEMA
    || ownershipAttestation.agentNftSha256 !== hash(record.agentNft)
    || !validAddress(ownershipAttestation.currentOwner)
    || !validOwnerEpoch(ownershipAttestation.ownerEpoch)
    || !validTimestamp(ownershipAttestation.observedAt)) {
    throw new Error('JEFF_MEMORY_OWNERSHIP_ATTESTATION_INVALID');
  }
  const ownershipObservedMs = Date.parse(ownershipAttestation.observedAt);
  if (ownershipObservedMs > committedMs
    || committedMs - ownershipObservedMs > OWNERSHIP_ATTESTATION_TTL_MS) {
    throw new Error('JEFF_MEMORY_OWNERSHIP_ATTESTATION_STALE');
  }
  const currentOwnerScopeSha256 = deriveJeffMemoryOwnerScope({
    agentNft: record.agentNft,
    currentOwner: ownershipAttestation.currentOwner,
    ownerEpoch: ownershipAttestation.ownerEpoch,
  });
  if (currentOwnerScopeSha256 !== record.ownerScopeSha256) {
    throw new Error('JEFF_MEMORY_CURRENT_OWNER_SCOPE_MISMATCH');
  }
  const acknowledgement = await adapter.put(Object.freeze(structuredClone(record)));
  if (!hasExactKeys(acknowledgement, STORAGE_ACK_KEYS)
    || acknowledgement.schema !== STORAGE_ACK_SCHEMA
    || acknowledgement.recordSha256 !== recordSha256
    || !validHash(acknowledgement.referenceSha256)) {
    throw new Error('JEFF_MEMORY_ADAPTER_RECEIPT_INVALID');
  }
  const storageReceipt = {
    schema: STORAGE_RECEIPT_SCHEMA,
    recordSha256,
    ownerScopeSha256: record.ownerScopeSha256,
    referenceSha256: acknowledgement.referenceSha256,
    acknowledgementSha256: hash(acknowledgement),
    ownershipAttestationSha256: hash(ownershipAttestation),
    committedAt: options.committedAt,
    ownerApproved: true,
    executionAuthorized: false,
  };
  return Object.freeze({ ...storageReceipt, storageReceiptSha256: hash(storageReceipt) });
}

export const JEFF_MEMORY_CONTRACT = Object.freeze({
  proposalSchema: PROPOSAL_SCHEMA,
  receiptSchema: RECEIPT_SCHEMA,
  recordSchema: RECORD_SCHEMA,
  storageAcknowledgementSchema: STORAGE_ACK_SCHEMA,
  storageReceiptSchema: STORAGE_RECEIPT_SCHEMA,
  ownerScopeSchema: OWNER_SCOPE_SCHEMA,
  rootSchema: ROOT_SCHEMA,
  ownershipAttestationSchema: OWNERSHIP_ATTESTATION_SCHEMA,
  reviewTtlMs: REVIEW_TTL_MS,
  ownershipAttestationTtlMs: OWNERSHIP_ATTESTATION_TTL_MS,
  scopes: Object.freeze([...SCOPES]),
  mode: 'shadow',
  executionAuthorized: false,
  rawMemoryAccepted: false,
});
