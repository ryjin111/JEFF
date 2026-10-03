import {
  hashJeffBrainValue,
  isJeffRecord,
} from './jeff-brain-common.mjs';

const SCHEMA = 'jeff-llm-utility-v1';
const MAX_PROVIDER_CALLS = 2;
const MULTI_OPTION_INTENT = /\b(?:compare|evaluate|options|recommend|research|strategy|trade-?offs?)\b/i;

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

function verifiedEvidenceCount(state) {
  if (Array.isArray(state?.evidence)) {
    return state.evidence.filter((entry) => isJeffRecord(entry) && entry.verified === true).length;
  }
  if (Number.isSafeInteger(state?.independentPrimarySources) && state.independentPrimarySources >= 0) {
    return state.independentPrimarySources;
  }
  if (Number.isSafeInteger(state?.sourceCount) && state.sourceCount >= 0) return state.sourceCount;
  return 0;
}

export function assessJeffLlmUtility({ request, decisionAssurance } = {}) {
  if (!isJeffRecord(request)
    || typeof request.objective !== 'string'
    || !request.objective.trim()
    || !isJeffRecord(request.state)
    || !Array.isArray(request.tools)
    || !isJeffRecord(decisionAssurance)
    || decisionAssurance.schema !== 'jeff-decision-assurance-v1'
    || decisionAssurance.executionAuthorized !== false) {
    throw new Error('JEFF_LLM_UTILITY_INPUT_INVALID');
  }

  const text = `${request.objective}\n${String(request.state.proposal ?? '')}`;
  const useCases = [];
  if (decisionAssurance.planningAllowed === true
    && decisionAssurance.writeIntent === true
    && decisionAssurance.verdict === 'review') useCases.push('owner_review_write_plan');
  if (decisionAssurance.planningAllowed === true
    && request.tools.length >= 2
    && MULTI_OPTION_INTENT.test(text)) useCases.push('multi_tool_option_analysis');
  if (decisionAssurance.planningAllowed === true
    && verifiedEvidenceCount(request.state) >= 2
    && MULTI_OPTION_INTENT.test(text)) useCases.push('multi_source_synthesis');

  const allowed = decisionAssurance.planningAllowed === true && useCases.length > 0;
  const decision = decisionAssurance.planningAllowed === false ? 'blocked'
    : allowed ? 'use_llm' : 'deterministic_only';
  const body = {
    schema: SCHEMA,
    mode: 'shadow',
    executionAuthorized: false,
    decision,
    useCases: [...new Set(useCases)].sort(),
    providerCallsAllowed: allowed ? MAX_PROVIDER_CALLS : 0,
    estimatedProviderCalls: allowed ? MAX_PROVIDER_CALLS : 0,
    reason: decision === 'blocked' ? 'decision_assurance_stopped_planning'
      : allowed ? 'bounded_high_value_planning_case'
        : 'deterministic_result_is_sufficient',
    requestSha256: hashJeffBrainValue(request),
    decisionAssuranceSha256: hashJeffBrainValue(decisionAssurance),
  };
  return deepFreeze({ ...body, utilitySha256: hashJeffBrainValue(body) });
}

export function verifyJeffLlmUtility(utility, request, decisionAssurance) {
  if (!utility || utility.schema !== SCHEMA || utility.executionAuthorized !== false) return false;
  try {
    const expected = assessJeffLlmUtility({ request, decisionAssurance });
    return hashJeffBrainValue(utility) === hashJeffBrainValue(expected);
  } catch {
    return false;
  }
}

export const JEFF_LLM_UTILITY_GATE = Object.freeze({
  schema: SCHEMA,
  mode: 'shadow',
  executionAuthorized: false,
  maximumProviderCallsPerDeliberation: MAX_PROVIDER_CALLS,
  defaultProviderCallsAllowed: 0,
});
