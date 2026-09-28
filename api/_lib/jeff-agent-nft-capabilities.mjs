import { JEFF_AGENT_NFT_QUESTIONS } from './jeff-agent-nft-contract.mjs';

const choice = (instructions, criteria) => Object.freeze({
  type: 'choice',
  instructions,
  criteria: Object.freeze(criteria),
});
const score = (instructions, criteria) => Object.freeze({
  type: 'score',
  instructions,
  criteria: Object.freeze(criteria),
});
const noul = (instructions) => Object.freeze({ type: 'noul', instructions });

export const JEFF_AGENT_NFT_CAPABILITY_QUESTIONS = Object.freeze({
  ...JEFF_AGENT_NFT_QUESTIONS,
  identity_integrity: choice('How trustworthy is the Agent NFT identity and controller state?', {
    trusted: 'Identity, ownership, and controller state are consistent and verified.',
    conflicted: 'Sources disagree about identity, ownership, or the active controller.',
    compromised: 'The identity or controller is known or strongly suspected to be compromised.',
    unknown: 'There is not enough verified state to judge identity integrity.',
  }),
  permission_posture: choice('How should JEFF handle the requested permission scope?', {
    allow_bounded: 'The existing owner policy explicitly permits this narrow and reversible scope.',
    owner_review: 'The permission is consequential, expanded, or requires explicit owner approval.',
    deny: 'The permission request violates policy or attempts to bypass authority.',
  }),
  vault_posture: choice('What should JEFF do with the Agent NFT vault state?', {
    observe: 'Read current balances, positions, approvals, and constraints.',
    simulate: 'Model a possible vault change without submitting it.',
    propose_transaction: 'Prepare a bounded transaction proposal for owner review.',
    abstain: 'Do not prepare a vault action because authority or evidence is insufficient.',
  }),
  market_action: choice('What market-analysis action should JEFF take?', {
    monitor: 'Track the market without forming an execution proposal.',
    research: 'Compare sources, liquidity, price, and risk.',
    prepare_order: 'Prepare order parameters for simulation and owner review.',
    abstain: 'Avoid a market recommendation because the evidence is insufficient.',
  }),
  nft_action: choice('What NFT-specific action should JEFF take?', {
    inspect: 'Inspect collection, token, provenance, ownership, and market state.',
    watchlist: 'Monitor the asset against an approved acquisition or exit policy.',
    propose_acquisition: 'Prepare an acquisition proposal without executing it.',
    propose_sale: 'Prepare a sale proposal without executing it.',
    abstain: 'Take no NFT action because policy, authority, or evidence is insufficient.',
  }),
  defi_action: choice('What DeFi action should JEFF take?', {
    inspect_yield: 'Inspect protocols, positions, yields, approvals, and risks.',
    simulate_swap: 'Simulate a swap and report price impact and slippage.',
    simulate_liquidity: 'Simulate a liquidity or staking position.',
    propose_position: 'Prepare a position change for owner review.',
    abstain: 'Take no DeFi action because the safety or evidence gate failed.',
  }),
  cross_chain_action: choice('What cross-chain action should JEFF take?', {
    inspect_route: 'Inspect bridge support, destination state, fees, and finality.',
    simulate_bridge: 'Simulate a bridge route without submitting it.',
    propose_bridge: 'Prepare a bridge proposal for owner review.',
    abstain: 'Avoid bridging because route, authority, or evidence is insufficient.',
  }),
  research_action: choice('What research action should JEFF take next?', {
    verify_sources: 'Verify provenance, freshness, and primary-source support.',
    compare_options: 'Compare multiple qualified options against the policy.',
    synthesize_report: 'Produce a bounded evidence-backed synthesis.',
    request_more_data: 'Ask for missing or conflicting evidence.',
    abstain: 'Do not form a conclusion from the available inputs.',
  }),
  memory_action: choice('How should JEFF handle the proposed memory?', {
    persist: 'Store verified durable facts with provenance.',
    summarize: 'Store a bounded summary instead of raw transient detail.',
    quarantine: 'Isolate suspicious, conflicting, or untrusted memory.',
    discard: 'Do not retain unsafe, secret, irrelevant, or invalid data.',
  }),
  delegation_action: choice('Who should own the next decision step?', {
    self: 'JEFF can complete the bounded reasoning step itself.',
    specialist: 'A specialist agent should handle the domain-specific analysis.',
    quorum: 'Multiple agents or voters should reach a bounded consensus.',
    owner: 'The owner or governance policy must decide.',
    abstain: 'No delegation is safe or useful with the current state.',
  }),
  governance_action: choice('What governance action should JEFF take?', {
    observe: 'Monitor the proposal and governance state.',
    discuss: 'Provide evidence or request clarification without voting.',
    propose: 'Draft a governance proposal for review.',
    vote: 'Prepare a vote recommendation under the approved mandate.',
    abstain: 'Do not participate because mandate or evidence is insufficient.',
  }),
  social_action: choice('What social or communication action should JEFF take?', {
    observe: 'Read the conversation without posting.',
    draft: 'Prepare copy for approval.',
    reply: 'Send a bounded factual reply within the communication policy.',
    announce: 'Publish an approved factual announcement.',
    abstain: 'Do not communicate because authority or evidence is insufficient.',
  }),
  moderation_action: choice('How should JEFF moderate the content or request?', {
    allow: 'Content is within policy.',
    flag: 'Content needs review or a caution label.',
    quarantine: 'Content should be isolated from agents and memory.',
    escalate: 'A human or governance policy must handle the incident.',
  }),
  reputation_risk: choice('What reputational risk does the proposed action create?', {
    low: 'The action is factual, bounded, reversible, and policy-compliant.',
    elevated: 'The action may create confusion or minor trust impact.',
    high: 'The action may materially damage trust or public standing.',
    blocked: 'The action is deceptive, abusive, unauthorized, or unsafe to publish.',
  }),
  threat_level: choice('What security threat level is present?', {
    benign: 'No meaningful threat indicators are present.',
    suspicious: 'Inputs contain anomalies that require validation.',
    malicious: 'The request attempts theft, bypass, manipulation, or harmful action.',
    critical: 'Secrets, control, funds, or system integrity face immediate danger.',
  }),
  incident_response: choice('What incident response should JEFF recommend?', {
    continue: 'Continue bounded read-only work.',
    restrict: 'Reduce tools, scope, or communication until checks pass.',
    quarantine: 'Isolate the input, memory, agent, or workflow.',
    freeze: 'Stop consequential actions and preserve evidence.',
    escalate: 'Notify the owner or incident policy immediately.',
  }),
  tool_mode: choice('What is the maximum safe tool mode for this step?', {
    none: 'Do not call external tools.',
    read_only: 'Use only non-mutating tools.',
    simulate: 'Prepare or simulate a state change without submitting it.',
    prepare_write: 'Prepare a bounded write for owner review without executing it.',
  }),
  reversibility: choice('How reversible is the proposed action?', {
    reversible: 'The action can be cleanly undone without material loss.',
    bounded: 'The impact is limited but not fully reversible.',
    irreversible: 'The action permanently changes funds, permissions, identity, or public state.',
    unknown: 'Reversibility cannot be established from the current evidence.',
  }),
  policy_confidence: score('How strongly does the owner policy support the decision?', [
    'no policy support', 'weak policy support', 'partial policy support', 'strong policy support', 'explicit verified mandate',
  ]),
  source_diversity: score('How diverse and independent are the supporting sources?', [
    'no sources', 'single weak source', 'limited related sources', 'multiple qualified sources', 'multiple independent primary sources',
  ]),
  requires_simulation: noul('Must the proposed state change be simulated before owner review?'),
  requires_fresh_state: noul('Must JEFF refresh external state before forming the decision?'),
  owner_notification: noul('Should JEFF notify the owner even if the action stays in shadow mode?'),
});

export const JEFF_CAPABILITY_FAMILIES = Object.freeze([
  Object.freeze({ id: 'authority', name: 'Identity, ownership, and permissions', tasks: Object.freeze(['authority', 'identity_integrity', 'permission_posture', 'policy_confidence']) }),
  Object.freeze({ id: 'onchain', name: 'Vault, market, NFT, DeFi, and cross-chain', tasks: Object.freeze(['vault_posture', 'market_action', 'nft_action', 'defi_action', 'cross_chain_action', 'requires_simulation', 'reversibility']) }),
  Object.freeze({ id: 'evidence', name: 'Research, evidence, and memory', tasks: Object.freeze(['proposal_quality', 'research_action', 'memory_action', 'source_diversity', 'requires_fresh_state']) }),
  Object.freeze({ id: 'coordination', name: 'Planning, delegation, and governance', tasks: Object.freeze(['next_action', 'delegation_action', 'governance_action', 'should_escalate', 'owner_notification']) }),
  Object.freeze({ id: 'social', name: 'Communication, moderation, and reputation', tasks: Object.freeze(['social_action', 'moderation_action', 'reputation_risk']) }),
  Object.freeze({ id: 'security', name: 'Threat detection and incident response', tasks: Object.freeze(['risk', 'threat_level', 'incident_response']) }),
  Object.freeze({ id: 'tools', name: 'Tool use and execution boundaries', tasks: Object.freeze(['tool_mode']) }),
]);

export const JEFF_CAPABILITY_SURFACE = Object.freeze({
  version: '0.2.0',
  domain: 'agent-nft',
  executionAuthority: false,
  families: JEFF_CAPABILITY_FAMILIES,
  questions: JEFF_AGENT_NFT_CAPABILITY_QUESTIONS,
});

export function selectJeffCapabilityQuestions(familyIds = JEFF_CAPABILITY_FAMILIES.map(({ id }) => id)) {
  const selected = new Set(familyIds);
  const unknown = [...selected].filter((id) => !JEFF_CAPABILITY_FAMILIES.some((family) => family.id === id));
  if (unknown.length) throw new Error(`JEFF_CAPABILITY_FAMILY_UNKNOWN:${unknown.join(',')}`);
  const tasks = JEFF_CAPABILITY_FAMILIES.filter(({ id }) => selected.has(id)).flatMap(({ tasks }) => tasks);
  return Object.freeze(Object.fromEntries(tasks.map((task) => [task, JEFF_AGENT_NFT_CAPABILITY_QUESTIONS[task]])));
}
