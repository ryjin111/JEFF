import assert from 'node:assert/strict';
import test from 'node:test';

import { deliberateJeffBrain } from '../api/_lib/jeff-brain-v1.mjs';
import { hashJeffBrainValue } from '../api/_lib/jeff-brain-common.mjs';
import {
  createInMemoryJeffExecutionStore,
  createJeffExecutionIntent,
  createJeffExecutionPolicy,
  executeJeffIntent,
  JEFF_EXECUTION_GATE,
  verifyJeffExecutionIntent,
  verifyJeffExecutionPolicy,
  verifyJeffExecutionReceipt,
} from '../api/_lib/jeff-execution-gate.mjs';
import { createJeffAuthorizationAttestation } from '../api/_lib/jeff-trusted-authorization.mjs';

const nowValue = '2026-09-30T10:00:00.000Z';
const scope = { agentId: 'agent:clockers:10', ownerId: 'owner:alice', ownerEpoch: 3 };

function brainRequest(input = { reportId: 'weekly-10' }) {
  return {
    objective: 'Publish the approved weekly room report after owner review.',
    state: {
      proposal: 'Publish the approved weekly room report after owner review.',
      safetyFacts: {
        authorized: true,
        funded: true,
        validTransition: true,
        evidenceSufficient: true,
        privacySafe: true,
        validationSafe: true,
        identityIntegrity: 'trusted',
      },
      requiredSafetyFactsComplete: true,
      ownerPolicy: { allowAutonomous: false },
    },
    ownerPolicy: {
      writeRequiresOwnerApproval: true,
      allowedTools: ['report.publish'],
    },
    tools: [{
      name: 'report.publish',
      mode: 'write',
      description: 'Publish an owner-approved report.',
    }],
    testInput: input,
  };
}

function provider(input = { reportId: 'weekly-10' }) {
  const planned = {
    situation: 'The weekly report is prepared and awaits authorization.',
    unknowns: ['Whether the owner authorization is still fresh.'],
    candidates: [
      {
        id: 'publish',
        title: 'Publish approved report',
        steps: ['Simulate publication.', 'Publish only after verified authorization.'],
        toolProposals: [{ tool: 'report.publish', purpose: 'Publish the weekly report.', input }],
        expectedOutcome: 'The approved report is published once.',
        risks: ['Authorization may expire.'],
        reversibility: 'The publication can be superseded but not erased.',
      },
      {
        id: 'wait',
        title: 'Wait',
        steps: ['Do not publish.'],
        toolProposals: [],
        expectedOutcome: 'No state changes.',
        risks: ['The report remains unpublished.'],
        reversibility: 'Fully reversible.',
      },
    ],
    recommendedCandidateId: 'publish',
  };
  return {
    model: 'jeff-execution-test',
    async complete({ phase }) {
      if (phase === 'plan') return planned;
      return { candidateId: 'publish', verdict: 'accept', issues: [] };
    },
  };
}

async function brainResult(input) {
  return deliberateJeffBrain({ request: brainRequest(input), provider: provider(input) });
}

function activePolicy(overrides = {}) {
  return createJeffExecutionPolicy({
    ...scope,
    allowedTools: ['report.publish'],
    maximumActions: 1,
    nonce: 'owner-approved-0001',
    validAfter: '2026-09-30T09:59:00.000Z',
    expiresAt: '2026-09-30T10:15:00.000Z',
    enabled: true,
    emergencyStop: false,
    ...overrides,
  });
}

function authorizationVerifier({ deny = false, mutateScope } = {}) {
  return {
    async attest(input) {
      if (deny) throw new Error('OWNER_DENIED');
      return createJeffAuthorizationAttestation({
        ...input,
        scope: mutateScope ? mutateScope(input.scope) : input.scope,
        observedAt: nowValue,
        expiresAt: '2026-09-30T10:05:00.000Z',
      });
    },
  };
}

function toolAdapter(calls) {
  return {
    name: 'report.publish',
    mode: 'write',
    async simulate(input) {
      calls.simulate += 1;
      return {
        ok: true,
        summary: `Would publish ${input.reportId}.`,
        preStateSha256: hashJeffBrainValue({ published: false }),
        postStateSha256: hashJeffBrainValue({ published: true, reportId: input.reportId }),
      };
    },
    async execute(input, context) {
      calls.execute += 1;
      assert.match(context.authorizationAttestationSha256, /^[a-f0-9]{64}$/);
      assert.match(context.idempotencyKey, /^[a-f0-9]{64}$/);
      return {
        ok: true,
        externalId: `report:${input.reportId}`,
        finalStateSha256: hashJeffBrainValue({ published: true, reportId: input.reportId }),
      };
    },
  };
}

test('execution policy is deny-by-default and requires an explicit bounded activation', () => {
  const denied = createJeffExecutionPolicy({
    ...scope,
    allowedTools: ['report.publish'],
    nonce: 'deny-default-0001',
    validAfter: '2026-09-30T09:59:00.000Z',
    expiresAt: '2026-09-30T10:15:00.000Z',
  });
  assert.equal(verifyJeffExecutionPolicy(denied), true);
  assert.equal(denied.enabled, false);
  assert.equal(denied.emergencyStop, true);
  assert.equal(JEFF_EXECUTION_GATE.defaultEnabled, false);
});

test('a verified Brain proposal executes once after simulation and server authorization', async () => {
  const result = await brainResult();
  const policy = activePolicy();
  const intent = createJeffExecutionIntent({ brainResult: result, policy });
  assert.equal(verifyJeffExecutionIntent(intent), true);
  assert.equal(intent.executionAuthorized, false);
  const calls = { simulate: 0, execute: 0 };
  const store = createInMemoryJeffExecutionStore();
  const args = {
    intent,
    policy,
    subject: 'session:alice',
    authorizationVerifier: authorizationVerifier(),
    toolAdapter: toolAdapter(calls),
    executionStore: store,
    now: () => nowValue,
  };
  const first = await executeJeffIntent(args);
  const repeated = await executeJeffIntent(args);
  assert.equal(verifyJeffExecutionReceipt(first), true);
  assert.deepEqual(repeated, first);
  assert.equal(first.executionAuthorized, true);
  assert.equal(first.actionsExecuted, 1);
  assert.equal(JSON.stringify(first).includes('owner:alice'), false);
  assert.equal(JSON.stringify(first).includes('report:weekly-10'), false);
  const tampered = structuredClone(first);
  tampered.finalStateSha256 = '0'.repeat(64);
  assert.equal(verifyJeffExecutionReceipt(tampered), false);
  assert.equal(calls.simulate, 2);
  assert.equal(calls.execute, 1);
});

test('execution intent rejects a tampered decision assurance result', async () => {
  const result = structuredClone(await brainResult());
  result.decisionAssurance.planningAllowed = false;

  assert.throws(
    () => createJeffExecutionIntent({ brainResult: result, policy: activePolicy() }),
    /JEFF_EXECUTION_INTENT_DENIED/,
  );
});

test('disabled policy and emergency stop block intent creation', async () => {
  const result = await brainResult();
  const disabled = activePolicy({ enabled: false, emergencyStop: false, nonce: 'disabled-policy-01' });
  const stopped = activePolicy({ emergencyStop: true, nonce: 'emergency-stop-01' });
  assert.throws(() => createJeffExecutionIntent({ brainResult: result, policy: disabled }), /INTENT_DENIED/);
  assert.throws(() => createJeffExecutionIntent({ brainResult: result, policy: stopped }), /INTENT_DENIED/);
});

test('proposal index must be a canonical in-range safe integer', async () => {
  const result = await brainResult();
  const policy = activePolicy();
  const invalidIndexes = ['0', ['0'], -1, 0.5, result.safety.proposals.length, Number.MAX_SAFE_INTEGER + 1];

  for (const proposalIndex of invalidIndexes) {
    assert.throws(
      () => createJeffExecutionIntent({ brainResult: result, policy, proposalIndex }),
      /INTENT_DENIED/,
      `expected proposalIndex ${JSON.stringify(proposalIndex)} to be denied`,
    );
  }

  const intent = createJeffExecutionIntent({ brainResult: result, policy, proposalIndex: 0 });
  assert.equal(verifyJeffExecutionIntent(intent), true);
  assert.equal(intent.idempotencyKey, hashJeffBrainValue({
    brainReceiptSha256: result.audit.receiptSha256,
    policySha256: policy.policySha256,
    proposalIndex: 0,
    tool: result.safety.proposals[0].tool,
  }));
});

test('expired policy, denied authorization, and mismatched attestations never call execute', async () => {
  const result = await brainResult();
  const policy = activePolicy();
  const intent = createJeffExecutionIntent({ brainResult: result, policy });
  const calls = { simulate: 0, execute: 0 };
  const base = {
    intent,
    policy,
    subject: 'session:alice',
    toolAdapter: toolAdapter(calls),
    executionStore: createInMemoryJeffExecutionStore(),
  };
  await assert.rejects(executeJeffIntent({
    ...base,
    authorizationVerifier: authorizationVerifier(),
    now: () => '2026-09-30T10:16:00.000Z',
  }), /POLICY_EXPIRED/);
  await assert.rejects(executeJeffIntent({
    ...base,
    authorizationVerifier: authorizationVerifier({ deny: true }),
    now: () => nowValue,
  }), /JEFF_AUTH_DENIED/);
  await assert.rejects(executeJeffIntent({
    ...base,
    authorizationVerifier: authorizationVerifier({
      mutateScope: (authorizationScope) => ({ ...authorizationScope, intentSha256: '0'.repeat(64) }),
    }),
    now: () => nowValue,
  }), /JEFF_AUTH_DENIED/);
  await assert.rejects(executeJeffIntent({
    ...base,
    authorizationVerifier: authorizationVerifier({
      mutateScope: (authorizationScope) => ({ ...authorizationScope, ownerEpoch: authorizationScope.ownerEpoch + 1 }),
    }),
    now: () => nowValue,
  }), /JEFF_AUTH_DENIED/);
  assert.equal(calls.execute, 0);
});

test('failed simulation and forged intent are rejected before execution', async () => {
  const result = await brainResult();
  const policy = activePolicy();
  const intent = createJeffExecutionIntent({ brainResult: result, policy });
  const calls = { simulate: 0, execute: 0 };
  const adapter = toolAdapter(calls);
  adapter.simulate = async () => ({ ok: false, summary: 'unsafe' });
  await assert.rejects(executeJeffIntent({
    intent,
    policy,
    subject: 'session:alice',
    authorizationVerifier: authorizationVerifier(),
    toolAdapter: adapter,
    executionStore: createInMemoryJeffExecutionStore(),
    now: () => nowValue,
  }), /SIMULATION_FAILED/);
  assert.equal(calls.execute, 0);
  const forged = structuredClone(intent);
  forged.input.reportId = 'attacker-report';
  assert.equal(verifyJeffExecutionIntent(forged), false);

  const tamperedBrain = structuredClone(result);
  tamperedBrain.safety.proposals[0].input.reportId = 'attacker-report';
  assert.throws(
    () => createJeffExecutionIntent({ brainResult: tamperedBrain, policy }),
    /INTENT_DENIED/,
  );
});

test('atomic policy quota prevents a second distinct action', async () => {
  const policy = activePolicy();
  const firstIntent = createJeffExecutionIntent({ brainResult: await brainResult({ reportId: 'first' }), policy });
  const secondIntent = createJeffExecutionIntent({ brainResult: await brainResult({ reportId: 'second' }), policy });
  const calls = { simulate: 0, execute: 0 };
  const store = createInMemoryJeffExecutionStore();
  const common = {
    policy,
    subject: 'session:alice',
    authorizationVerifier: authorizationVerifier(),
    toolAdapter: toolAdapter(calls),
    executionStore: store,
    now: () => nowValue,
  };
  await executeJeffIntent({ ...common, intent: firstIntent });
  await assert.rejects(executeJeffIntent({ ...common, intent: secondIntent }), /QUOTA_EXCEEDED/);
  assert.equal(calls.execute, 1);
});

test('an unknown adapter outcome remains reserved and cannot auto-retry', async () => {
  const policy = activePolicy();
  const intent = createJeffExecutionIntent({ brainResult: await brainResult(), policy });
  const calls = { simulate: 0, execute: 0 };
  const adapter = toolAdapter(calls);
  adapter.execute = async () => {
    calls.execute += 1;
    throw new Error('UPSTREAM_TIMEOUT_AFTER_SUBMISSION');
  };
  const args = {
    intent,
    policy,
    subject: 'session:alice',
    authorizationVerifier: authorizationVerifier(),
    toolAdapter: adapter,
    executionStore: createInMemoryJeffExecutionStore(),
    now: () => nowValue,
  };
  await assert.rejects(executeJeffIntent(args), /UPSTREAM_TIMEOUT/);
  await assert.rejects(executeJeffIntent(args), /ALREADY_IN_FLIGHT/);
  assert.equal(calls.execute, 1);
});

test('concurrent attempts can cause at most one external effect', async () => {
  const policy = activePolicy();
  const intent = createJeffExecutionIntent({ brainResult: await brainResult(), policy });
  const calls = { simulate: 0, execute: 0 };
  const args = {
    intent,
    policy,
    subject: 'session:alice',
    authorizationVerifier: authorizationVerifier(),
    toolAdapter: toolAdapter(calls),
    executionStore: createInMemoryJeffExecutionStore(),
    now: () => nowValue,
  };
  const attempts = await Promise.allSettled([executeJeffIntent(args), executeJeffIntent(args)]);
  assert.equal(attempts.some(({ status }) => status === 'fulfilled'), true);
  assert.equal(calls.execute, 1);
});

test('policy expiry during simulation is rechecked before reservation', async () => {
  const policy = activePolicy({
    nonce: 'short-policy-0001',
    expiresAt: '2026-09-30T10:02:00.000Z',
  });
  const intent = createJeffExecutionIntent({ brainResult: await brainResult(), policy });
  const times = [
    '2026-09-30T10:01:59.000Z',
    '2026-09-30T10:02:01.000Z',
    '2026-09-30T10:02:01.000Z',
  ];
  const calls = { simulate: 0, execute: 0 };
  const verifier = {
    async attest(input) {
      return createJeffAuthorizationAttestation({
        ...input,
        observedAt: '2026-09-30T10:02:00.000Z',
        expiresAt: '2026-09-30T10:03:00.000Z',
      });
    },
  };
  await assert.rejects(executeJeffIntent({
    intent,
    policy,
    subject: 'session:alice',
    authorizationVerifier: verifier,
    toolAdapter: toolAdapter(calls),
    executionStore: createInMemoryJeffExecutionStore(),
    now: () => times.shift() ?? '2026-09-30T10:02:01.000Z',
  }), /POLICY_EXPIRED/);
  assert.equal(calls.execute, 0);
});

test('policy expiry after reservation is rechecked immediately before execution', async () => {
  const policy = activePolicy();
  const intent = createJeffExecutionIntent({ brainResult: await brainResult(), policy });
  const times = [
    '2026-09-30T10:00:00.000Z',
    '2026-09-30T10:00:00.000Z',
    '2026-09-30T10:00:00.000Z',
    '2026-09-30T10:16:00.000Z',
  ];
  const calls = { simulate: 0, execute: 0 };
  const store = createInMemoryJeffExecutionStore();
  await assert.rejects(executeJeffIntent({
    intent,
    policy,
    subject: 'session:alice',
    authorizationVerifier: authorizationVerifier(),
    toolAdapter: toolAdapter(calls),
    executionStore: store,
    now: () => times.shift() ?? '2026-09-30T10:16:00.000Z',
  }), /POLICY_EXPIRED/);
  assert.equal(calls.execute, 0);
  assert.deepEqual(await store.snapshot(), []);
});

test('post-state divergence is unresolved and cannot auto-retry', async () => {
  const policy = activePolicy();
  const intent = createJeffExecutionIntent({ brainResult: await brainResult(), policy });
  const calls = { simulate: 0, execute: 0 };
  const adapter = toolAdapter(calls);
  adapter.execute = async (input) => {
    calls.execute += 1;
    return {
      ok: true,
      externalId: `report:${input.reportId}`,
      finalStateSha256: hashJeffBrainValue({ published: false, divergent: true }),
    };
  };
  const args = {
    intent,
    policy,
    subject: 'session:alice',
    authorizationVerifier: authorizationVerifier(),
    toolAdapter: adapter,
    executionStore: createInMemoryJeffExecutionStore(),
    now: () => nowValue,
  };
  await assert.rejects(executeJeffIntent(args), /FINAL_STATE_DIVERGED/);
  await assert.rejects(executeJeffIntent(args), /ALREADY_IN_FLIGHT/);
  assert.equal(calls.execute, 1);
});
