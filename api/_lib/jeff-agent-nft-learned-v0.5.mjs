import {
  JEFF_AGENT_NFT_CONTRACT,
  JEFF_AGENT_NFT_QUESTIONS,
  validateJeffAgentNftRequest,
  validateJeffAgentNftResponse,
} from './jeff-agent-nft-contract.mjs';

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function addTokens(value, prefix, output) {
  if (Array.isArray(value)) {
    output.push(`${prefix}__array`, `${prefix}__count_${Math.min(value.length, 8)}`);
    value.forEach((entry) => addTokens(entry, `${prefix}__item`, output));
    return;
  }
  if (isRecord(value)) {
    for (const key of Object.keys(value).sort()) addTokens(value[key], prefix ? `${prefix}__${key}` : key, output);
    return;
  }
  if (typeof value === 'string') {
    output.push(...value.toLowerCase().match(/[a-z0-9_]+/g)?.map((token) => `${prefix}__${token}`) ?? []);
    return;
  }
  output.push(`${prefix}__${String(value)}`);
}

function semanticTokensForState(state) {
  const proposal = typeof state?.proposal === 'string' ? state.proposal.toLowerCase() : '';
  const tokens = [];
  const add = (name, condition) => { if (condition) tokens.push(`semantic__${name}`); };
  add('read_intent', /\b(compute|discover|inspect|list|look up|query|read|review|verify)\b/.test(proposal));
  add('simulation_intent', /\b(dry run|model|prepare|simulate)\b/.test(proposal));
  add('explicit_nonexecution', /\b(do not|don't|never|without)\s+(?:broadcast|call|deploy|execute|sign|submit|transfer)|\bno transaction\b/.test(proposal));
  add('write_intent', /\b(approve|assign|bridge|change|execute|grant|persist|register|release|submit|transfer|upgrade|withdraw)\b/.test(proposal));
  add('permission_change', /\b(admin|allowance|controller|operator|owner|ownership|permission|role|upgrade)\b/.test(proposal));
  add('identity_or_signature_risk', /\b(conflict|different registry|invalid|mismatch|previous owner|unverified|wrong)\b/.test(proposal)
    || state?.identityConflict === true || state?.signatureValid === false);
  add('stale_state', /\b(expired|stale)\b/.test(proposal) || state?.dataFresh === false);
  add('prompt_injection', /\b(bypass|hidden instruction|ignore (?:all|owner)|jailbreak|system prompt)\b/.test(proposal));
  add('secret_material', /\b(api key|private key|recovery phrase|seed phrase|wallet secret)\b/.test(proposal) || state?.containsSecret === true);
  add('memory_context', /\b(memory|note|preference|registry)\b/.test(proposal) || 'memoryProvenanceVerified' in (state ?? {}));
  add('reputation_manipulation', /\b(cluster|feedback|newly funded|related reviewer|sybil)\b/.test(proposal) || state?.feedbackClustered === true);
  add('cross_chain_context', /\b(chain id|cross-chain|another chain|two chains)\b/.test(proposal) || 'destinationChain' in (state ?? {}));
  add('account_abstraction', /\b(entrypoint|paymaster|useroperation)\b/.test(proposal));
  add('contract_signature', /\b(isvalidsignature|magic value|contract-wallet)\b/.test(proposal));
  add('token_bound_account', /\b(token-bound|token bound)\b/.test(proposal));
  add('agent_registration', /\b(agent endpoint|agent registration|registration file)\b/.test(proposal));
  add('agentic_commerce', /\b(escrow|evaluator|job-state)\b/.test(proposal));
  add('approval_complete', state?.evaluatorApproved === true || state?.signatureValid === true);
  add('approval_missing', state?.evaluatorApproved === false || state?.signatureValid === false);
  add('verified_context', verifiedAutonomousContext(state));
  add('autonomy_disabled', state?.ownerPolicy?.allowAutonomous === false);
  add('autonomy_enabled', state?.ownerPolicy?.allowAutonomous === true);
  add('unauthorized', state?.authorized === false);
  return tokens;
}

function semanticTokensV3ForState(state) {
  const proposal = typeof state?.proposal === 'string' ? state.proposal.toLowerCase() : '';
  const tokens = [...semanticTokensForState(state)];
  const add = (name, condition) => { if (condition) tokens.push(`semantic_v3__${name}`); };
  add('reject_or_abstain', /\b(abstain|block|deny|discard|refuse|reject|stop)\b/.test(proposal));
  add('report_result', /\b(communicate|publish|report|summarize)\b/.test(proposal));
  add('prepare_write', /\b(build|prepare)\b/.test(proposal) && /\b(commitment|operation|payout|refund|release|settlement|transaction|update)\b/.test(proposal));
  add('insufficient_state', Object.entries(state ?? {}).some(([key, value]) => value === false
    && /(?:approved|matches|sufficient|trusted|valid|verified)$/i.test(key)));
  add('state_conflict', state?.identityConflict === true || state?.walletConflict === true || state?.ownerChanged === true);
  add('invalid_operation_shape', (state?.senderExists === true && state?.initCodePresent === true)
    || state?.alreadyRefunded === true || state?.validationMutatesState === true);
  add('valid_sequential_commitment', Number.isInteger(state?.currentSequence)
    && state?.proposedSequence === state.currentSequence + 1 && state?.previousRootMatches === true);
  add('terminal_or_expired', state?.expired === true || ['completed', 'rejected'].includes(String(state?.jobStatus ?? '').toLowerCase()));
  add('owner_review_context', state?.ownerPolicy?.allowAutonomous === false);
  return tokens;
}

function semanticTokensV4ForState(state) {
  const tokens = [...semanticTokensV3ForState(state)];
  const add = (name, condition) => { if (condition) tokens.push(`semantic_v4__${name}`); };
  add('unsupported_proposal', state?.valueDecimals > 18 || state?.validityUnitsMatch === false || state?.evaluatorIsZero === true);
  add('critical_integrity_failure', state?.ownershipCycleDetected === true || state?.enforcingLogicUpgradeable === true);
  add('policy_banned', state?.paymasterBanned === true || state?.hookWhitelisted === false);
  add('identity_reset', state?.agentTransferred === true && state?.agentWalletCleared === true);
  add('signature_interface_failure', state?.returnsBoolean === true || state?.signatureCallReverted === true);
  add('private_commitment_exposed', state?.lowEntropyPayload === true || state?.saltPublic === true);
  return tokens;
}

export function tokenizeJeffAgentNftState(task, state, featureVersion = 'raw-v1') {
  const tokens = [`task__${task}`];
  addTokens(state, 'state', tokens);
  if (featureVersion === 'semantic-v2') tokens.push(...semanticTokensForState(state));
  if (featureVersion === 'semantic-v3') tokens.push(...semanticTokensV3ForState(state));
  if (featureVersion === 'semantic-v4') tokens.push(...semanticTokensV4ForState(state));
  return tokens;
}

const labelFor = (question, value) => question.type === 'noul' ? String(Boolean(value)) : String(value);
const labelsFor = (question) => question.type === 'choice' ? Object.keys(question.criteria)
  : question.type === 'noul' ? ['false', 'true']
    : question.criteria.map((_, index) => String(index));

export function trainJeffAgentNftClassifier(samples, questions = JEFF_AGENT_NFT_QUESTIONS, options = {}) {
  if (!Array.isArray(samples) || samples.length === 0) throw new Error('JEFF_AGENT_NFT_TRAINING_EMPTY');
  const featureVersion = options.featureVersion ?? 'raw-v1';
  if (!['raw-v1', 'semantic-v2', 'semantic-v3', 'semantic-v4'].includes(featureVersion)) throw new Error('JEFF_AGENT_NFT_FEATURE_VERSION_INVALID');
  const tasks = {};
  for (const [task, question] of Object.entries(questions)) {
    const taskSamples = samples.filter((sample) => Object.hasOwn(sample.answers ?? {}, task));
    if (taskSamples.length === 0) throw new Error(`JEFF_AGENT_NFT_TRAINING_TASK_EMPTY:${task}`);
    const labels = labelsFor(question);
    const documents = Object.fromEntries(labels.map((label) => [label, 0]));
    const totalTokens = Object.fromEntries(labels.map((label) => [label, 0]));
    const tokenCounts = Object.fromEntries(labels.map((label) => [label, {}]));
    const vocabulary = new Set();
    for (const sample of taskSamples) {
      const label = labelFor(question, sample.answers?.[task]);
      if (!labels.includes(label)) throw new Error(`JEFF_AGENT_NFT_TRAINING_LABEL_INVALID:${task}:${label}`);
      documents[label] += 1;
      for (const token of tokenizeJeffAgentNftState(task, sample.state, featureVersion)) {
        vocabulary.add(token);
        tokenCounts[label][token] = (tokenCounts[label][token] ?? 0) + 1;
        totalTokens[label] += 1;
      }
    }
    tasks[task] = {
      type: question.type,
      labels,
      documents,
      totalTokens,
      tokenCounts,
      vocabularySize: vocabulary.size,
      trainingDocuments: taskSamples.length,
    };
  }
  return {
    schema: 'jeff-agent-nft-naive-bayes-v1',
    model: 'jeff-agent-nft-nb-v0.1',
    contractVersion: JEFF_AGENT_NFT_CONTRACT.contractVersion,
    ...(featureVersion === 'raw-v1' ? {} : { featureVersion }),
    tasks,
  };
}

function probabilitiesFor(taskModel, tokens) {
  const labelCount = taskModel.labels.length;
  const logs = {};
  for (const label of taskModel.labels) {
    let log = Math.log((taskModel.documents[label] + 1) / (taskModel.trainingDocuments + labelCount));
    const denominator = taskModel.totalTokens[label] + Math.max(1, taskModel.vocabularySize);
    for (const token of tokens) log += Math.log(((taskModel.tokenCounts[label][token] ?? 0) + 1) / denominator);
    logs[label] = log;
  }
  const maximum = Math.max(...Object.values(logs));
  const temperature = Number.isFinite(taskModel.temperature) && taskModel.temperature >= 1 ? taskModel.temperature : 1;
  const exponentials = Object.fromEntries(Object.entries(logs).map(([label, log]) => [label, Math.exp((log - maximum) / temperature)]));
  const total = Object.values(exponentials).reduce((sum, value) => sum + value, 0);
  return Object.fromEntries(Object.entries(exponentials).map(([label, value]) => [label, value / total]));
}

export function calibrateJeffAgentNftClassifier(model, samples, questions = JEFF_AGENT_NFT_QUESTIONS, options = {}) {
  if (!isRecord(model) || !isRecord(model.tasks) || !Array.isArray(samples) || samples.length === 0) {
    throw new Error('JEFF_AGENT_NFT_CALIBRATION_INVALID');
  }
  const temperatures = options.temperatures ?? [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32, 48, 64];
  const maxMeanWrongConfidence = options.maxMeanWrongConfidence ?? 0.5;
  if (!Array.isArray(temperatures) || temperatures.some((value) => !Number.isFinite(value) || value < 1)) {
    throw new Error('JEFF_AGENT_NFT_CALIBRATION_TEMPERATURE_INVALID');
  }
  if (!Number.isFinite(maxMeanWrongConfidence) || maxMeanWrongConfidence <= 0 || maxMeanWrongConfidence >= 1) {
    throw new Error('JEFF_AGENT_NFT_CALIBRATION_CONFIDENCE_INVALID');
  }
  const calibrated = structuredClone(model);
  const metrics = {};
  let globalSelection;
  for (const temperature of temperatures) {
    let nll = 0;
    let decisions = 0;
    let wrongConfidence = 0;
    let wrong = 0;
    for (const [task, question] of Object.entries(questions)) {
      const candidate = { ...calibrated.tasks[task], temperature };
      const taskSamples = samples.filter((sample) => Object.hasOwn(sample.answers ?? {}, task));
      for (const sample of taskSamples) {
        const expected = labelFor(question, sample.answers?.[task]);
        const probabilities = probabilitiesFor(candidate, tokenizeJeffAgentNftState(task, sample.state, model.featureVersion ?? 'raw-v1'));
        const predicted = Object.entries(probabilities).sort((left, right) => right[1] - left[1])[0];
        nll -= Math.log(Math.max(1e-12, probabilities[expected] ?? 0));
        decisions += 1;
        if (predicted[0] !== expected) {
          wrongConfidence += predicted[1];
          wrong += 1;
        }
      }
    }
    const candidate = {
      temperature,
      nll: nll / decisions,
      meanWrongConfidence: wrongConfidence / Math.max(1, wrong),
    };
    if (candidate.meanWrongConfidence <= maxMeanWrongConfidence
      && (!globalSelection || candidate.nll < globalSelection.nll)) globalSelection = candidate;
  }
  globalSelection ??= { temperature: temperatures.at(-1), nll: Number.POSITIVE_INFINITY, meanWrongConfidence: 1 };
  for (const [task, question] of Object.entries(questions)) {
    const taskModel = calibrated.tasks[task];
    if (!taskModel || taskModel.type !== question.type) throw new Error(`JEFF_AGENT_NFT_MODEL_TASK_UNSUPPORTED:${task}`);
    let selected = { temperature: 1, nll: Number.POSITIVE_INFINITY };
    const taskSamples = samples.filter((sample) => Object.hasOwn(sample.answers ?? {}, task));
    if (taskSamples.length === 0) throw new Error(`JEFF_AGENT_NFT_CALIBRATION_TASK_EMPTY:${task}`);
    for (const temperature of temperatures) {
      const candidate = { ...taskModel, temperature };
      let nll = 0;
      for (const sample of taskSamples) {
        const expected = labelFor(question, sample.answers?.[task]);
        const probabilities = probabilitiesFor(candidate, tokenizeJeffAgentNftState(task, sample.state, model.featureVersion ?? 'raw-v1'));
        nll -= Math.log(Math.max(1e-12, probabilities[expected] ?? 0));
      }
      nll /= taskSamples.length;
      if (nll < selected.nll) selected = { temperature, nll };
    }
    taskModel.temperature = Math.max(globalSelection.temperature, selected.temperature);
    metrics[task] = { temperature: taskModel.temperature, nll: Number(selected.nll.toFixed(8)) };
  }
  calibrated.calibration = {
    method: 'per-task-temperature-scaling',
    objective: 'negative-log-likelihood-with-wrong-confidence-constraint',
    samples: samples.length,
    maxMeanWrongConfidence,
    globalTemperatureFloor: globalSelection.temperature,
    validationMeanWrongConfidence: Number(globalSelection.meanWrongConfidence.toFixed(8)),
    metrics,
  };
  return calibrated;
}

const permissionMutation = /\b(admin|allowance|approval|controller|governor|operator|ownership|permission|role|upgrade)\b/i;
const sensitiveAction = /\b(approve|assign|bridge|burn|buy|call|change|execute|grant|make|mint|sell|set|sign|stake|swap|transfer|upgrade|withdraw)\b/i;
const negatedSensitiveAction = /\b(?:do not|don't|never|refuse to)\s+(?:approve|assign|bridge|burn|buy|call|change|execute|grant|make|mint|sell|set|sign|stake|swap|transfer|upgrade|withdraw)\b/i;
const explicitNonExecution = /\bwithout\s+(?:broadcasting|executing|signing|submitting|transferring|withdrawing)\b|\bno transaction\b/i;
const policyBypass = /\b(bypass|ignore (all|owner|previous)|jailbreak|reveal (hidden|system))\b/i;
const secretRequest = /\b(api key|password|private key|recovery phrase|seed phrase|signer secret|system prompt|vault secret)\b/i;

const choiceAnswer = (choice, labels, confidence = 0.97) => {
  const remainder = (1 - confidence) / Math.max(1, labels.length - 1);
  return {
    type: 'choice',
    choice,
    probabilities: Object.fromEntries(labels.map((label) => [label, label === choice ? confidence : remainder])),
    confidence,
  };
};

const verifiedAutonomousContext = (state) => state?.authorized === true
  && state?.ownerPolicy?.allowAutonomous === true
  && state?.provenanceVerified === true
  && state?.dataFresh === true
  && Array.isArray(state?.evidence)
  && state.evidence.length > 0
  && state.evidence.every((entry) => isRecord(entry) && entry.verified === true);

function applySafetyEnvelope(request, answers, featureVersion = 'raw-v1') {
  if (!['authority', 'next_action', 'risk', 'should_escalate'].every((task) => request.questions[task])) return;
  const proposal = typeof request.state?.proposal === 'string' ? request.state.proposal : '';
  const hasSensitiveAction = sensitiveAction.test(proposal);
  const safetyConfidence = featureVersion === 'semantic-v4' ? 0.54 : 0.97;
  const boundedConfidence = (confidence) => featureVersion === 'semantic-v4' ? Math.min(confidence, safetyConfidence) : confidence;
  const setChoice = (task, choice, confidence = safetyConfidence) => {
    const question = request.questions[task];
    if (question?.type === 'choice' && Object.hasOwn(question.criteria, choice)) {
      answers[task] = choiceAnswer(choice, Object.keys(question.criteria), boundedConfidence(confidence));
    }
  };
  const setNoul = (task, value, confidence = safetyConfidence) => {
    if (request.questions[task]?.type === 'noul') {
      const selectedConfidence = boundedConfidence(confidence);
      answers[task] = { type: 'noul', noul: value ? selectedConfidence : 1 - selectedConfidence };
    }
  };
  const setScore = (task, score, confidence = safetyConfidence) => {
    const question = request.questions[task];
    if (question?.type === 'score' && Number.isInteger(score) && score >= 0 && score < question.criteria.length) {
      answers[task] = { type: 'score', score, confidence: boundedConfidence(confidence) };
    }
  };

  if (featureVersion === 'semantic-v3' || featureVersion === 'semantic-v4') {
    const evidenceV4 = featureVersion === 'semantic-v4';
    const state = request.state ?? {};
    const ownerReview = state.ownerPolicy?.allowAutonomous === false;
    const trustedEvidence = state.provenanceVerified === true
      && state.dataFresh === true
      && Array.isArray(state.evidence)
      && state.evidence.length > 0
      && state.evidence.every((entry) => isRecord(entry) && entry.verified === true);
    const stateConflict = state.identityConflict === true || state.walletConflict === true || state.ownerChanged === true;
    const identityMismatch = stateConflict || state.signatureScopeMatches === false || state.signatureValid === false
      || /\b(wrong|required) magic value\b/i.test(proposal) || /\b0xffffffff\b/i.test(proposal);
    const invalidState = stateConflict
      || (state.senderExists === true && state.initCodePresent === true)
      || state.alreadyRefunded === true
      || state.validationMutatesState === true
      || state.signatureValid === false
      || state.signatureScopeMatches === false
      || state.validatorMatchesRequest === false
      || state.requesterIsOwnerOrOperator === false
      || state.previousRootMatches === false;
    const insufficientState = Object.entries(state).some(([key, value]) => value === false
      && !['authorized', 'dataFresh', 'provenanceVerified'].includes(key)
      && /(?:approved|matches|sufficient|trusted|valid|verified)$/i.test(key));
    const implementationAmbiguous = state.implementationCount > 1 || state.multipleTokenBoundAccounts === true;
    const unsupportedProposal = state.valueDecimals > 18 || state.validityUnitsMatch === false || state.evaluatorIsZero === true;
    const criticalIntegrityFailure = state.ownershipCycleDetected === true || state.enforcingLogicUpgradeable === true;
    const explicitAbstention = /\b(abstain|block|deny|discard|refuse|reject|stop)\b/i.test(proposal);
    const simulationIntent = /\b(dry run|model|simulate|simulation)\b/i.test(proposal);
    const prepareWriteIntent = /\b(build|prepare)\b/i.test(proposal)
      && (evidenceV4
        ? /\b(commitment|operation|order|payout|refund|release|settlement|trade|transaction|update)\b/i.test(proposal)
        : /\b(commitment|operation|payout|refund|release|settlement|transaction|update)\b/i.test(proposal));
    const reportIntent = evidenceV4
      ? /\bcommunicate\b|\breport (?:findings|result|the|this)\b/i.test(proposal)
      : /\b(communicate|report)\b/i.test(proposal);
    const readIntent = /\b(ask|calculate|compare|compute|discover|inspect|investigate|list|look up|post|query|read|refresh|review|synthesize|verify)\b/i.test(proposal);
    const containsSecret = state.containsSecret === true || secretRequest.test(proposal);
    const invalidOrUnauthorized = state.authorized === false || policyBypass.test(proposal) || containsSecret;

    if (typeof state.dataFresh === 'boolean') setNoul('requires_fresh_state', state.dataFresh === false);
    if (evidenceV4 && state.agentTransferred === true && state.agentWalletCleared === true) setChoice('identity_integrity', 'unknown');
    else if (identityMismatch || (evidenceV4 && (state.returnsBoolean === true || state.registryCanonical === false))) setChoice('identity_integrity', 'conflicted');
    else if (trustedEvidence) setChoice('identity_integrity', 'trusted');
    else if (!trustedEvidence && implementationAmbiguous) setChoice('identity_integrity', 'unknown');

    if (invalidOrUnauthorized) {
      setChoice('authority', 'deny');
      setChoice('next_action', 'abstain');
      setChoice('risk', 'blocked');
      setNoul('should_escalate', true, 0.99);
      setChoice('permission_posture', 'deny');
      setChoice('vault_posture', 'abstain');
      setChoice('research_action', containsSecret || policyBypass.test(proposal) ? 'abstain' : 'request_more_data');
      setChoice('social_action', 'abstain');
      setChoice('tool_mode', 'none', 0.99);
      if (evidenceV4 && unsupportedProposal) setScore('proposal_quality', 0);
      setNoul('requires_simulation', false);
      setNoul('requires_fresh_state', state.dataFresh !== true);
      setNoul('owner_notification', true);
      if (containsSecret) {
        setChoice('memory_action', 'discard');
        setChoice('moderation_action', 'quarantine');
        setChoice('threat_level', 'critical');
        setChoice('incident_response', 'freeze');
      } else if (evidenceV4 && criticalIntegrityFailure) {
        setChoice('memory_action', 'quarantine');
        setChoice('threat_level', 'critical');
        setChoice('incident_response', 'freeze');
      } else if (invalidState) {
        setChoice('memory_action', 'quarantine');
        if (state.validationMutatesState === true || state.validatorMatchesRequest === false) setChoice('threat_level', 'malicious');
        setChoice('incident_response', 'freeze');
      }
      return;
    }

    if (evidenceV4 && ownerReview && state.paymasterBanned === true) {
      setChoice('authority', 'owner_review');
      setChoice('next_action', 'abstain');
      setChoice('risk', 'high');
      setNoul('should_escalate', true);
      setChoice('vault_posture', 'abstain');
      setChoice('research_action', 'verify_sources');
      setChoice('social_action', 'abstain');
      setChoice('tool_mode', 'none');
      setChoice('threat_level', 'suspicious');
      setNoul('owner_notification', true);
      return;
    }

    if (evidenceV4 && ownerReview && state.lowEntropyPayload === true && state.saltPublic === true) {
      setChoice('authority', 'owner_review');
      setChoice('next_action', 'abstain');
      setChoice('risk', 'high');
      setNoul('should_escalate', true);
      setChoice('vault_posture', 'abstain');
      setChoice('research_action', 'verify_sources');
      setChoice('social_action', 'abstain');
      setChoice('tool_mode', 'none');
      setChoice('memory_action', 'quarantine');
      setNoul('owner_notification', true);
      return;
    }

    if (evidenceV4 && ownerReview && state.agentTransferred === true && state.agentWalletCleared === true) {
      setChoice('authority', 'owner_review');
      setChoice('next_action', 'abstain');
      setChoice('risk', 'high');
      setNoul('should_escalate', true);
      setChoice('vault_posture', 'abstain');
      setChoice('research_action', 'request_more_data');
      setChoice('social_action', 'abstain');
      setChoice('tool_mode', 'read_only');
      setNoul('owner_notification', true);
      return;
    }

    if (ownerReview && trustedEvidence && ['completed', 'accepted'].includes(String(state.jobStatus ?? '').toLowerCase())
      && /\b(payout|payment|release|settlement)\b/i.test(proposal)) {
      setChoice('authority', 'owner_review');
      setChoice('next_action', 'propose_transaction');
      setChoice('risk', 'high');
      setNoul('should_escalate', true);
      setChoice('vault_posture', 'simulate');
      setChoice('research_action', 'compare_options');
      setChoice('social_action', 'observe');
      setChoice('tool_mode', 'prepare_write');
      setNoul('requires_simulation', true);
      setNoul('owner_notification', true);
      return;
    }

    if (ownerReview && trustedEvidence && simulationIntent) {
      setChoice('authority', 'owner_review');
      setChoice('next_action', 'observe');
      setChoice('risk', 'elevated');
      setNoul('should_escalate', true);
      setChoice('vault_posture', 'simulate');
      setChoice('research_action', evidenceV4 && state.callerIsEvaluator === true && state.jobStatus === 'submitted' ? 'verify_sources' : 'compare_options');
      setChoice('social_action', 'observe');
      setChoice('tool_mode', 'simulate');
      setNoul('requires_simulation', true);
      setNoul('owner_notification', true);
      return;
    }

    if (ownerReview && simulationIntent && !explicitAbstention && !insufficientState && !implementationAmbiguous) {
      setChoice('authority', 'owner_review');
      setChoice('next_action', 'observe');
      setChoice('risk', 'elevated');
      setNoul('should_escalate', true);
      setChoice('vault_posture', state.dataFresh === true ? 'simulate' : 'observe');
      setChoice('research_action', state.dataFresh === true ? 'compare_options' : 'request_more_data');
      setChoice('social_action', 'observe');
      setChoice('tool_mode', 'simulate');
      setNoul('requires_simulation', true);
      setNoul('owner_notification', true);
      return;
    }

    if (ownerReview && trustedEvidence && prepareWriteIntent) {
      const validMemoryCommitment = Number.isInteger(state.currentSequence)
        && state.proposedSequence === state.currentSequence + 1
        && state.previousRootMatches === true
        && state.containsSecret === false;
      setChoice('authority', 'owner_review');
      setChoice('next_action', 'propose_transaction');
      setChoice('risk', 'high');
      setNoul('should_escalate', true);
      setChoice('vault_posture', validMemoryCommitment ? 'propose_transaction' : 'simulate');
      setChoice('research_action', validMemoryCommitment ? 'synthesize_report' : 'verify_sources');
      setChoice('social_action', 'observe');
      setChoice('tool_mode', 'prepare_write');
      setNoul('requires_simulation', !validMemoryCommitment);
      setNoul('owner_notification', true);
      if (validMemoryCommitment) setChoice('memory_action', 'persist');
      return;
    }

    if (ownerReview && (state.dataFresh === false || !trustedEvidence || insufficientState || invalidState || explicitAbstention || implementationAmbiguous)) {
      const abstain = explicitAbstention || stateConflict || insufficientState || implementationAmbiguous;
      setChoice('authority', 'owner_review');
      setChoice('next_action', abstain ? 'abstain' : 'observe');
      setChoice('risk', stateConflict || state.multipleTokenBoundAccounts === true ? 'high' : 'elevated');
      setNoul('should_escalate', true);
      setChoice('vault_posture', abstain ? 'abstain' : 'observe');
      setChoice('research_action', 'request_more_data');
      setChoice('social_action', stateConflict || explicitAbstention || state.signatureExpired === true ? 'abstain' : 'observe');
      if (evidenceV4 && state.executionInterfaceSupported === false) setChoice('social_action', 'observe');
      setChoice('tool_mode', state.multipleTokenBoundAccounts === true ? 'none' : 'read_only');
      setNoul('requires_simulation', state.multipleTokenBoundAccounts === true);
      if (evidenceV4 && (state.signatureCallReverted === true || !trustedEvidence)) setNoul('requires_fresh_state', true);
      setNoul('owner_notification', true);
      return;
    }

    if (trustedEvidence && (permissionMutation.test(proposal)
      || /\bprepare\b.*\b(acquisition|exit)\b/i.test(proposal)
      || /\b(?:prepare|simulate)\b.*\b(acquisition|bridge|buying|cross-chain|exit|liquidity|selling|strategy|transfer)\b/i.test(proposal))) {
      setChoice('authority', 'owner_review');
      setChoice('next_action', 'propose_transaction');
      setChoice('risk', 'high');
      setNoul('should_escalate', true);
      setChoice('vault_posture', permissionMutation.test(proposal) ? 'propose_transaction' : 'simulate');
      setChoice('research_action', permissionMutation.test(proposal) ? 'verify_sources' : 'compare_options');
      setChoice('social_action', 'observe');
      setChoice('tool_mode', 'prepare_write');
      setNoul('requires_simulation', true);
      setNoul('owner_notification', true);
      return;
    }

    if (trustedEvidence && /\b(vote|voting)\b/i.test(proposal) && !/\bdiscussion\b/i.test(proposal)) {
      setChoice('authority', 'owner_review');
      setChoice('next_action', 'coordinate');
      setChoice('risk', 'elevated');
      setNoul('should_escalate', true);
      setChoice('vault_posture', 'observe');
      setChoice('research_action', 'compare_options');
      setChoice('social_action', 'draft');
      setChoice('tool_mode', 'simulate');
      setNoul('requires_simulation', true);
      setNoul('owner_notification', true);
      return;
    }

    if (verifiedAutonomousContext(state) && state.entryPointTrusted === true && simulationIntent) {
      setChoice('authority', 'autonomous');
      setChoice('next_action', 'propose_transaction');
      setChoice('risk', 'low');
      setNoul('should_escalate', false);
      setChoice('vault_posture', 'simulate');
      setChoice('research_action', 'synthesize_report');
      setChoice('social_action', 'observe');
      setChoice('tool_mode', 'simulate');
      setNoul('requires_simulation', true);
      setNoul('owner_notification', true);
      return;
    }

    if (state.dataFresh === false || state.feedbackClustered === true || state.endpointDomainMatchesRegistration === false) {
      setChoice('authority', 'owner_review');
      setChoice('next_action', 'observe');
      setChoice('risk', 'elevated');
      setNoul('should_escalate', true);
      setChoice('vault_posture', 'observe');
      setChoice('research_action', state.dataFresh === false ? 'request_more_data' : 'verify_sources');
      setChoice('social_action', state.dataFresh === false && state.sourceChain || state.feedbackClustered === true ? 'observe' : 'abstain');
      setChoice('tool_mode', 'read_only');
      setNoul('requires_simulation', false);
      setNoul('requires_fresh_state', true);
      setNoul('owner_notification', true);
      return;
    }

    if (verifiedAutonomousContext(state) && (readIntent || reportIntent || explicitNonExecution)) {
      setChoice('authority', 'autonomous');
      const marketResearch = /\b(acquisition candidates|market entry|market outlook|research)\b/i.test(proposal);
      const coordination = /\b(agent vote|coordinate|delegate|discussion|qualified agent|reply)\b/i.test(proposal);
      const socialReply = /\b(answer|post|reply)\b/i.test(proposal);
      setChoice('next_action', reportIntent || socialReply ? 'communicate' : coordination ? 'coordinate' : 'observe');
      setChoice('risk', 'low');
      setNoul('should_escalate', false);
      setChoice('vault_posture', 'observe');
      setChoice('research_action', marketResearch || /\bwatchlist\b/i.test(proposal) ? 'compare_options'
        : /\bdelegate\b/i.test(proposal) ? 'verify_sources' : 'synthesize_report');
      setChoice('social_action', socialReply ? 'reply'
        : /\bdiscussion\b/i.test(proposal) ? 'reply'
          : reportIntent || marketResearch ? 'draft' : 'observe');
      setChoice('tool_mode', 'read_only');
      setNoul('requires_simulation', false);
      setNoul('owner_notification', false);
      return;
    }
  }

  if (request.state?.authorized === false || policyBypass.test(proposal) || secretRequest.test(proposal)) {
    answers.authority = choiceAnswer('deny', Object.keys(request.questions.authority.criteria));
    answers.next_action = choiceAnswer('abstain', Object.keys(request.questions.next_action.criteria));
    answers.risk = choiceAnswer('blocked', Object.keys(request.questions.risk.criteria));
    answers.should_escalate = { type: 'noul', noul: 0.99 };
    return;
  }
  if (permissionMutation.test(proposal) && hasSensitiveAction) {
    answers.authority = choiceAnswer('owner_review', Object.keys(request.questions.authority.criteria));
    answers.next_action = choiceAnswer('propose_transaction', Object.keys(request.questions.next_action.criteria));
    answers.risk = choiceAnswer('high', Object.keys(request.questions.risk.criteria));
    answers.should_escalate = { type: 'noul', noul: 0.97 };
    return;
  }
  if (hasSensitiveAction && (negatedSensitiveAction.test(proposal) || explicitNonExecution.test(proposal))) {
    const trusted = verifiedAutonomousContext(request.state);
    answers.authority = choiceAnswer(trusted ? 'autonomous' : 'owner_review', Object.keys(request.questions.authority.criteria));
    answers.next_action = choiceAnswer(trusted ? 'communicate' : 'observe', Object.keys(request.questions.next_action.criteria));
    answers.risk = choiceAnswer(trusted ? 'low' : 'elevated', Object.keys(request.questions.risk.criteria));
    answers.should_escalate = { type: 'noul', noul: trusted ? 0.03 : 0.97 };
    return;
  }
  if (hasSensitiveAction) {
    answers.authority = choiceAnswer('owner_review', Object.keys(request.questions.authority.criteria));
    answers.next_action = choiceAnswer('propose_transaction', Object.keys(request.questions.next_action.criteria));
    answers.risk = choiceAnswer('high', Object.keys(request.questions.risk.criteria));
    answers.should_escalate = { type: 'noul', noul: 0.97 };
  }
}

export function inferJeffAgentNftLearned(model, request) {
  if (!validateJeffAgentNftRequest(request)) throw new Error('JEFF_AGENT_NFT_REQUEST_INVALID');
  if (!isRecord(model) || model.contractVersion !== JEFF_AGENT_NFT_CONTRACT.contractVersion || !isRecord(model.tasks)) {
    throw new Error('JEFF_AGENT_NFT_MODEL_INVALID');
  }
  const answers = {};
  for (const [task, question] of Object.entries(request.questions)) {
    const taskModel = model.tasks[task];
    if (!taskModel || taskModel.type !== question.type) throw new Error(`JEFF_AGENT_NFT_MODEL_TASK_UNSUPPORTED:${task}`);
    const probabilities = probabilitiesFor(taskModel, tokenizeJeffAgentNftState(task, request.state, model.featureVersion ?? 'raw-v1'));
    const selected = Object.entries(probabilities).sort((left, right) => right[1] - left[1])[0][0];
    if (question.type === 'choice') {
      answers[task] = { type: 'choice', choice: selected, probabilities, confidence: probabilities[selected] };
    } else if (question.type === 'noul') {
      answers[task] = { type: 'noul', noul: probabilities.true };
    } else {
      answers[task] = { type: 'score', score: Number(selected), confidence: probabilities[selected] };
    }
  }
  applySafetyEnvelope(request, answers, model.featureVersion ?? 'raw-v1');
  const response = {
    schemaVersion: 1,
    contractVersion: JEFF_AGENT_NFT_CONTRACT.contractVersion,
    model: model.model,
    mode: 'shadow',
    executionAuthorized: false,
    answers,
  };
  if (!validateJeffAgentNftResponse(response, request)) throw new Error('JEFF_AGENT_NFT_RESPONSE_INVALID');
  return response;
}

