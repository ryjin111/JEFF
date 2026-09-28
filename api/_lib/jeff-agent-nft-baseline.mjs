import {
  JEFF_AGENT_NFT_CONTRACT,
  JEFF_AGENT_NFT_QUESTIONS,
  validateJeffAgentNftRequest,
  validateJeffAgentNftResponse,
} from './jeff-agent-nft-contract.mjs';

const SECRET = /\b(?:private key|seed phrase|recovery phrase|wallet password|api key)\b/i;
const INJECTION = /\b(?:ignore (?:all|the|previous)|system prompt|developer message|jailbreak|bypass (?:approval|policy|safety))\b/i;
const TRANSACTION = /\b(?:send|transfer|swap|buy|sell|mint|burn|approve|sign|broadcast|bridge|stake|unstake)\b/i;
const PERMISSION = /\b(?:grant|revoke|permission|role|admin|allowance|upgrade|ownership)\b/i;
const COORDINATION = /\b(?:coordinate|delegate|vote|consensus|quorum|multi-agent)\b/i;
const COMMUNICATION = /\b(?:reply|post|publish|message|announce|report|explain)\b/i;

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const textOf = (value) => {
  try { return JSON.stringify(value); } catch { return ''; }
};

function choice(question, selected, confidence) {
  const options = Object.keys(question.criteria);
  const bounded = Math.max(1 / options.length, Math.min(0.999, confidence));
  const remainder = (1 - bounded) / (options.length - 1);
  return {
    type: 'choice',
    choice: selected,
    probabilities: Object.fromEntries(options.map((option) => [option, option === selected ? bounded : remainder])),
    confidence: bounded,
  };
}

function evidenceQuality(state) {
  const evidence = Array.isArray(state.evidence) ? state.evidence : [];
  let score = 0;
  if (state.provenanceVerified === true) score += 1;
  if (evidence.length > 0) score += 1;
  if (evidence.length > 0 && evidence.every((item) => isRecord(item) && item.verified === true)) score += 1;
  const fresh = state.dataFresh === true
    || (Number.isFinite(Number(state.dataAgeSeconds)) && Number(state.dataAgeSeconds) <= 300);
  if (fresh) score += 1;
  return { score, confidence: evidence.length > 0 ? 0.82 : 0.68 };
}

export function inferJeffAgentNftBaseline(request) {
  if (!validateJeffAgentNftRequest(request)) throw new Error('JEFF_AGENT_NFT_REQUEST_INVALID');
  const state = request.state;
  const text = textOf(state);
  const ownerPolicy = isRecord(state.ownerPolicy) ? state.ownerPolicy : {};
  const explicitlyUnauthorized = state.authorized === false
    || state.policyViolation === true
    || ownerPolicy.authorized === false;
  const blocked = explicitlyUnauthorized || SECRET.test(text) || INJECTION.test(text);
  const explicitlyAutonomous = state.authorized === true && ownerPolicy.allowAutonomous === true;
  const consequential = state.irreversible === true
    || state.externalWrite === true
    || TRANSACTION.test(text)
    || PERMISSION.test(text);
  const evidence = Array.isArray(state.evidence) ? state.evidence : [];
  const fresh = state.dataFresh === true
    || (Number.isFinite(state.dataAgeSeconds) && state.dataAgeSeconds >= 0 && state.dataAgeSeconds <= 300);
  const verifiedEvidence = state.provenanceVerified === true
    && fresh
    && evidence.length > 0
    && evidence.every((item) => isRecord(item) && item.verified === true);
  const requiresReview = !explicitlyAutonomous || !verifiedEvidence;

  const risk = blocked ? 'blocked' : consequential ? 'high' : requiresReview ? 'elevated' : 'low';
  const authority = blocked ? 'deny'
    : consequential || requiresReview ? 'owner_review'
      : 'autonomous';
  const nextAction = blocked ? 'abstain'
    : requiresReview || state.needsMoreEvidence === true ? 'observe'
      : consequential ? 'propose_transaction'
        : COORDINATION.test(text) ? 'coordinate'
          : COMMUNICATION.test(text) ? 'communicate'
            : 'observe';
  const escalate = authority === 'deny' ? 0.99
    : authority === 'owner_review' ? 0.96
      : risk === 'elevated' ? 0.72
        : 0.08;
  const quality = evidenceQuality(state);
  const answers = {};

  for (const [id, question] of Object.entries(request.questions)) {
    if (id === 'authority') answers[id] = choice(question, authority, authority === 'autonomous' ? 0.9 : 0.96);
    else if (id === 'next_action') answers[id] = choice(question, nextAction, nextAction === 'observe' ? 0.82 : 0.92);
    else if (id === 'risk') answers[id] = choice(question, risk, risk === 'low' ? 0.88 : 0.96);
    else if (id === 'should_escalate') answers[id] = { type: 'noul', noul: escalate };
    else if (id === 'proposal_quality') answers[id] = { type: 'score', ...quality };
    else throw new Error(`JEFF_AGENT_NFT_BASELINE_QUESTION_UNSUPPORTED:${id}`);
  }

  const response = {
    schemaVersion: 1,
    contractVersion: JEFF_AGENT_NFT_CONTRACT.contractVersion,
    model: 'jeff-agent-nft-baseline-v0.1',
    mode: 'shadow',
    executionAuthorized: false,
    answers,
    trace: {
      policy: 'agent-nft-shadow-v1',
      reasonCodes: [
        blocked ? 'AUTHORITY_OR_SAFETY_FAILURE' : 'AUTHORITY_CHECKED',
        consequential ? 'CONSEQUENTIAL_ACTION' : 'BOUNDED_ACTION',
        verifiedEvidence ? 'EVIDENCE_ACCEPTABLE' : 'EVIDENCE_REVIEW_REQUIRED',
      ],
    },
  };
  if (!validateJeffAgentNftResponse(response, request)) throw new Error('JEFF_AGENT_NFT_RESPONSE_INVALID');
  return response;
}

export function canonicalJeffAgentNftRequest({ agentNft, state }) {
  return { agentNft, state, questions: JEFF_AGENT_NFT_QUESTIONS };
}
