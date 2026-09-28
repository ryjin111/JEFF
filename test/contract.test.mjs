import assert from 'node:assert/strict';
import test from 'node:test';
import {
  JEFF_AGENT_NFT_CONTRACT,
  JEFF_AGENT_NFT_QUESTIONS,
  validateJeffAgentNftRequest,
  validateJeffAgentNftResponse,
} from '../api/_lib/jeff-agent-nft-contract.mjs';

const request = {
  agentNft: {
    chainId: 46630,
    collection: '0x0000000000000000000000000000000000000001',
    tokenId: '10',
    account: '0x0000000000000000000000000000000000000010',
  },
  state: {
    proposal: 'Prepare a bounded transaction proposal for owner review.',
    ownerPolicy: { transactionExecution: false },
  },
  questions: JEFF_AGENT_NFT_QUESTIONS,
};

const response = {
  schemaVersion: 1,
  contractVersion: 'jeff-agent-nft-contract-v1',
  mode: 'shadow',
  executionAuthorized: false,
  answers: {
    authority: {
      type: 'choice',
      choice: 'owner_review',
      probabilities: { autonomous: 0.02, owner_review: 0.96, deny: 0.02 },
      confidence: 0.96,
    },
    next_action: {
      type: 'choice',
      choice: 'propose_transaction',
      probabilities: {
        observe: 0.02,
        communicate: 0.02,
        coordinate: 0.02,
        propose_transaction: 0.92,
        abstain: 0.02,
      },
      confidence: 0.92,
    },
    risk: {
      type: 'choice',
      choice: 'high',
      probabilities: { low: 0.02, elevated: 0.04, high: 0.92, blocked: 0.02 },
      confidence: 0.92,
    },
    should_escalate: { type: 'noul', noul: 0.99 },
    proposal_quality: { type: 'score', score: 3, confidence: 0.8 },
  },
};

test('Agent NFT model contract accepts canonical typed input and safe shadow output', () => {
  assert.equal(validateJeffAgentNftRequest(request), true);
  assert.equal(validateJeffAgentNftResponse(response, request), true);
  assert.equal(JEFF_AGENT_NFT_CONTRACT.domain, 'agent-nft');
  assert.deepEqual(JEFF_AGENT_NFT_CONTRACT.questionTypes, ['choice', 'noul', 'score']);
  assert.equal(JEFF_AGENT_NFT_CONTRACT.executionAuthority, false);
});

test('Agent NFT model contract supports generic typed questions without task-specific adapters', () => {
  const genericRequest = {
    state: { message: 'Inspect the proposal.' },
    questions: {
      disposition: {
        type: 'choice',
        instructions: 'Choose the disposition.',
        criteria: { inspect: 'Inspect it.', abstain: 'Do nothing.' },
      },
      escalate: { type: 'noul', instructions: 'Should this be escalated?' },
      quality: { type: 'score', instructions: 'Rate quality.', criteria: ['low', 'high'] },
    },
  };
  assert.equal(validateJeffAgentNftRequest(genericRequest), true);
});

test('Agent NFT model contract rejects authority, schema, and probability violations', () => {
  assert.equal(validateJeffAgentNftRequest({ ...request, agentNft: { ...request.agentNft, chainId: 0 } }), false);
  assert.equal(validateJeffAgentNftRequest({ ...request, agentNft: { ...request.agentNft, chainId: 1.5 } }), false);
  assert.equal(validateJeffAgentNftRequest({ ...request, agentNft: { ...request.agentNft, collection: 'not-an-address' } }), false);
  assert.equal(validateJeffAgentNftRequest({ ...request, agentNft: { ...request.agentNft, account: '0x1234' } }), false);
  assert.equal(validateJeffAgentNftRequest({ ...request, agentNft: { ...request.agentNft, tokenId: '-1' } }), false);
  assert.equal(validateJeffAgentNftRequest({ ...request, state: { value: undefined } }), false);
  assert.equal(validateJeffAgentNftRequest({ ...request, state: { value: 1n } }), false);
  assert.equal(validateJeffAgentNftResponse({ ...response, executionAuthorized: true }, request), false);
  assert.equal(validateJeffAgentNftResponse({
    ...response,
    answers: { ...response.answers, proposal_quality: { type: 'score', score: 2.5, confidence: 0.8 } },
  }, request), false);
  assert.equal(validateJeffAgentNftResponse({
    ...response,
    answers: { ...response.answers, proposal_quality: { type: 'score', score: 3, confidence: '0.8' } },
  }, request), false);
  assert.equal(validateJeffAgentNftResponse({
    ...response,
    answers: {
      ...response.answers,
      authority: { ...response.answers.authority, confidence: null },
    },
  }, request), false);
  assert.equal(validateJeffAgentNftResponse({
    ...response,
    answers: {
      ...response.answers,
      authority: {
        ...response.answers.authority,
        probabilities: { autonomous: 0.2, owner_review: 0.9, deny: 0.2 },
      },
    },
  }, request), false);
  assert.equal(validateJeffAgentNftResponse({
    ...response,
    answers: { ...response.answers, proposal_quality: { type: 'score', score: 5, confidence: 0.8 } },
  }, request), false);
});

test('Agent NFT model contract rejects oversized and non-canonical JSON state', () => {
  assert.equal(validateJeffAgentNftRequest({ ...request, state: { text: 'x'.repeat(4_097) } }), false);
  assert.equal(validateJeffAgentNftRequest({ ...request, state: new Date() }), false);
  let deep = { value: true };
  for (let index = 0; index < 13; index += 1) deep = { child: deep };
  assert.equal(validateJeffAgentNftRequest({ ...request, state: deep }), false);
});
