const CONTRACT_VERSION = 'jeff-agent-nft-contract-v1';

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const probability = (value) => finite(value) && value >= 0 && value <= 1;
const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const TOKEN_ID = /^(?:0|[1-9]\d*)$/;
const MAX_UINT256 = (1n << 256n) - 1n;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function validateJsonValue(value, depth = 0, budget = { nodes: 0 }) {
  budget.nodes += 1;
  if (budget.nodes > 2_048 || depth > 12) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'string') return value.length <= 4_096;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) {
    return value.length <= 256 && value.every((entry) => validateJsonValue(entry, depth + 1, budget));
  }
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const entries = Object.entries(value);
  return entries.length <= 256 && entries.every(([key, entry]) => (
    key.length > 0
    && key.length <= 128
    && !FORBIDDEN_KEYS.has(key)
    && validateJsonValue(entry, depth + 1, budget)
  ));
}

export const JEFF_AGENT_NFT_QUESTIONS = Object.freeze({
  authority: Object.freeze({
    type: 'choice',
    instructions: 'What authority does this Agent NFT have for the proposed action?',
    criteria: Object.freeze({
      autonomous: 'The owner policy explicitly permits this bounded and reversible action.',
      owner_review: 'The action is consequential or outside the autonomous policy and needs owner approval.',
      deny: 'The action violates policy, safety, provenance, or authorization requirements.',
    }),
  }),
  next_action: Object.freeze({
    type: 'choice',
    instructions: 'What should the Agent NFT do next?',
    criteria: Object.freeze({
      observe: 'Collect more state without changing external systems.',
      communicate: 'Produce a factual message or report within the communication policy.',
      coordinate: 'Request help, delegation, or a bounded multi-agent decision.',
      propose_transaction: 'Prepare a transaction proposal for policy checks and owner review.',
      abstain: 'Take no action because evidence, confidence, or authority is insufficient.',
    }),
  }),
  risk: Object.freeze({
    type: 'choice',
    instructions: 'What is the risk level of the proposed Agent NFT action?',
    criteria: Object.freeze({
      low: 'Read-only or reversible with verified inputs and explicit authority.',
      elevated: 'Bounded risk exists and additional checks or monitoring are required.',
      high: 'Funds, permissions, reputation, or irreversible state may be materially affected.',
      blocked: 'Safety, provenance, policy, or authority requirements fail.',
    }),
  }),
  should_escalate: Object.freeze({
    type: 'noul',
    instructions: 'Should this Agent NFT escalate the decision to its owner or governance policy?',
  }),
  proposal_quality: Object.freeze({
    type: 'score',
    instructions: 'How strong is the evidence supporting the proposed action?',
    criteria: Object.freeze([
      'unsupported',
      'weak',
      'mixed',
      'strong',
      'verified',
    ]),
  }),
});

function validateQuestion(question) {
  if (!isRecord(question) || typeof question.instructions !== 'string' || !question.instructions.trim()) return false;
  if (question.type === 'choice') {
    return isRecord(question.criteria)
      && Object.keys(question.criteria).length >= 2
      && Object.values(question.criteria).every((description) => typeof description === 'string' && description.trim());
  }
  if (question.type === 'noul') return question.criteria === undefined;
  return question.type === 'score'
    && Array.isArray(question.criteria)
    && question.criteria.length >= 2
    && question.criteria.every((description) => typeof description === 'string' && description.trim());
}

export function validateJeffAgentNftRequest(request) {
  if (!isRecord(request) || !isRecord(request.state) || !validateJsonValue(request.state) || !isRecord(request.questions)) return false;
  const entries = Object.entries(request.questions);
  if (entries.length === 0 || entries.length > 64) return false;
  if (entries.some(([id, question]) => !/^[a-z][a-z0-9_]{0,63}$/i.test(id) || !validateQuestion(question))) return false;
  if (request.agentNft !== undefined) {
    const agent = request.agentNft;
    if (!isRecord(agent) || !Number.isSafeInteger(agent.chainId) || agent.chainId <= 0) return false;
    if (typeof agent.collection !== 'string' || !EVM_ADDRESS.test(agent.collection)) return false;
    if (typeof agent.account !== 'string' || !EVM_ADDRESS.test(agent.account)) return false;
    if (typeof agent.tokenId !== 'string' || !TOKEN_ID.test(agent.tokenId)) return false;
    try { if (BigInt(agent.tokenId) > MAX_UINT256) return false; } catch { return false; }
  }
  return true;
}

function validateChoice(answer, question) {
  if (answer.type !== 'choice' || typeof answer.choice !== 'string') return false;
  const options = Object.keys(question.criteria);
  if (!options.includes(answer.choice) || !isRecord(answer.probabilities)) return false;
  if (Object.keys(answer.probabilities).length !== options.length) return false;
  if (options.some((option) => !probability(answer.probabilities[option]))) return false;
  const total = options.reduce((sum, option) => sum + answer.probabilities[option], 0);
  const confidence = answer.confidence;
  const selected = answer.probabilities[answer.choice];
  const maximum = Math.max(...options.map((option) => answer.probabilities[option]));
  return probability(confidence)
    && Math.abs(total - 1) < 1e-6
    && Math.abs(selected - maximum) < 1e-9
    && Math.abs(selected - confidence) < 1e-9;
}

function validateNoul(answer) {
  return answer.type === 'noul' && probability(answer.noul);
}

function validateScore(answer, question) {
  return answer.type === 'score'
    && Number.isInteger(answer.score)
    && answer.score >= 0
    && answer.score <= question.criteria.length - 1
    && probability(answer.confidence);
}

export function validateJeffAgentNftResponse(response, request) {
  if (!validateJeffAgentNftRequest(request) || !isRecord(response) || !isRecord(response.answers)) return false;
  if (response.schemaVersion !== 1 || response.contractVersion !== CONTRACT_VERSION) return false;
  if (response.executionAuthorized !== false || response.mode !== 'shadow') return false;
  const questionIds = Object.keys(request.questions);
  if (Object.keys(response.answers).length !== questionIds.length) return false;
  return questionIds.every((id) => {
    const question = request.questions[id];
    const answer = response.answers[id];
    if (!isRecord(answer)) return false;
    if (question.type === 'choice') return validateChoice(answer, question);
    if (question.type === 'noul') return validateNoul(answer);
    return validateScore(answer, question);
  });
}

export const JEFF_AGENT_NFT_CONTRACT = Object.freeze({
  name: 'JEFF Agent NFT Decision Model',
  contractVersion: CONTRACT_VERSION,
  domain: 'agent-nft',
  questionTypes: Object.freeze(['choice', 'noul', 'score']),
  executionAuthority: false,
  mode: 'shadow',
});
