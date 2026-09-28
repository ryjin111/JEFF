import { createHash } from 'node:crypto';

import { JEFF_AGENT_NFT_CAPABILITY_QUESTIONS } from './jeff-agent-nft-capabilities.mjs';
import {
  validateJeffAgentNftRequest,
  validateJeffAgentNftResponse,
} from './jeff-agent-nft-contract.mjs';
import { inferJeffAgentNftPromoted } from './jeff-agent-nft-promoted.mjs';

const RECEIPT_SCHEMA = 'jeff-review-receipt-v1';

function canonicalize(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .reduce((result, key) => {
        result[key] = canonicalize(value[key]);
        return result;
      }, {});
  }
  throw new TypeError('JEFF_REVIEW_VALUE_NOT_CANONICAL_JSON');
}

function hashArtifact(value) {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');
}

function summarizeAnswer(answer) {
  if (answer.type === 'choice') return Object.freeze({
    type: 'choice',
    choice: answer.choice,
    confidence: answer.confidence,
  });
  if (answer.type === 'noul') return Object.freeze({ type: 'noul', noul: answer.noul });
  return Object.freeze({ type: 'score', score: answer.score, confidence: answer.confidence });
}

function summarizeAnswers(answers) {
  return Object.freeze(Object.fromEntries(
    Object.entries(answers).map(([id, answer]) => [id, summarizeAnswer(answer)]),
  ));
}

function normalizeRequest(request) {
  const normalized = {
    ...(request ?? {}),
    questions: request?.questions ?? JEFF_AGENT_NFT_CAPABILITY_QUESTIONS,
  };
  if (!validateJeffAgentNftRequest(normalized)) throw new Error('JEFF_REVIEW_REQUEST_INVALID');
  return normalized;
}

export function createJeffReviewReceipt(request, response) {
  const normalizedRequest = normalizeRequest(request);
  if (!validateJeffAgentNftResponse(response, normalizedRequest)) throw new Error('JEFF_REVIEW_RESPONSE_INVALID');

  const receipt = {
    schema: RECEIPT_SCHEMA,
    contractVersion: response.contractVersion,
    model: response.model,
    mode: 'shadow',
    executionAuthorized: false,
    externalPolicyRequired: true,
    agentNft: normalizedRequest.agentNft
      ? Object.freeze({ ...normalizedRequest.agentNft })
      : null,
    requestSha256: hashArtifact(normalizedRequest),
    responseSha256: hashArtifact(response),
    answers: summarizeAnswers(response.answers),
  };

  return Object.freeze({
    ...receipt,
    receiptSha256: hashArtifact(receipt),
  });
}

export function verifyJeffReviewReceipt(receipt, request, response) {
  if (!receipt || receipt.schema !== RECEIPT_SCHEMA) return false;
  if (receipt.mode !== 'shadow' || receipt.executionAuthorized !== false) return false;
  if (receipt.externalPolicyRequired !== true) return false;
  try {
    const expected = createJeffReviewReceipt(request, response);
    return hashArtifact(receipt) === hashArtifact(expected);
  } catch {
    return false;
  }
}

export function reviewJeffAgentNft(request) {
  const normalizedRequest = normalizeRequest(request);
  const response = inferJeffAgentNftPromoted(normalizedRequest);
  if (!validateJeffAgentNftResponse(response, normalizedRequest)) {
    throw new Error('JEFF_REVIEW_RESPONSE_INVALID');
  }
  const receipt = createJeffReviewReceipt(normalizedRequest, response);
  return Object.freeze({ response, receipt });
}

export const JEFF_REVIEW_CONTRACT = Object.freeze({
  schema: RECEIPT_SCHEMA,
  mode: 'shadow',
  executionAuthorized: false,
  externalPolicyRequired: true,
});
