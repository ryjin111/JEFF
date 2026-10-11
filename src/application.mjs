import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { createJeffOpenClawNftBridge, createJeffOpenClawAccountBridge } from 'jeff-agent-nft/openclaw';
import { createOwnershipResolver } from './chain.mjs';
import { createNftDiscovery } from './nft-discovery.mjs';
import { createHolderSessions } from './auth.mjs';
import { createAccountSessions } from './account-auth.mjs';
import { createOpenClawRunner } from './openclaw-runner.mjs';
import { createHostingLedger } from './hosting.mjs';
import { createClockersPaymentVerifier } from './payment.mjs';
import { createClockersUsdQuote } from './clockers-price.mjs';
import { createMaintenanceGate, createDurableJobReader, waitForDurableJob, resolveMaintenanceMarkerPath } from './maintenance.mjs';
import { createWorkspaceStore } from './workspace.mjs';
import { createScheduler } from './scheduler.mjs';
import { createInferenceLedger } from './inference-ledger.mjs';
import { createInferenceGateway } from './inference-gateway.mjs';
import { scopeId } from './scope.mjs';
import { chatTimeZone, decodeChatResponse, directMemoryRequest, validateScheduleProposal } from './chat-actions.mjs';
import { createJobRecordPersister } from './job-records.mjs';
import { researchRequest, readResearchPages, researchAnswer, WEB_RESEARCH_LIMITS } from './web-research.mjs';
import {createGithubConnectionStore} from './github-connection-store.mjs';
import {createGithubProvider} from './github-provider.mjs';
import {createGithubConnector,githubJobRequest,githubClearCookie} from './github-connector.mjs';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const strict = (input, fields) => {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !fields.includes(key))) throw new Error('JEFF_REQUEST_INVALID');
  return input;
};
const diagnosticTypes = new Set(['Error', 'TypeError', 'RangeError', 'HttpRequestError', 'TimeoutError', 'RpcRequestError',
  'ContractFunctionExecutionError', 'ContractFunctionRevertedError', 'InvalidInputRpcError', 'InternalRpcError', 'UnknownRpcError']);
function failureDetails(error) {
  const types = [], codes = [];
  let upstreamStatus = null;
  for (let cause = error, depth = 0; cause && depth < 6; cause = cause.cause, depth++) {
    types.push(diagnosticTypes.has(cause.name) ? cause.name : 'OtherError');
    if (Number.isSafeInteger(cause.status) && cause.status >= 400 && cause.status <= 599) upstreamStatus = cause.status;
    if (Number.isSafeInteger(cause.code)) codes.push(cause.code);
    else if (['EACCES', 'ENOSPC', 'EIO', 'ENOENT', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED'].includes(cause.code)) codes.push(cause.code);
  }
  return { types, codes, upstreamStatus };
}

// Injectable dependencies support isolated tests. Production has no auth bypass.
export async function createJeffApplication(options = {}) {
  const env = options.env || process.env;
  const runnerMode = env.JEFF_OPENCLAW_RUNNER_MODE || 'cli';
  if (!['cli', 'warm-gateway'].includes(runnerMode)
    || runnerMode === 'warm-gateway' && env.JEFF_INFERENCE_CREDITS_ENABLED !== 'true') throw new Error('JEFF_RUNTIME_CONFIG_INVALID');
  const port = Number(env.PORT || 8788);
  const origin = options.origin || env.JEFF_PUBLIC_ORIGIN || `http://127.0.0.1:${port}`;
  const chainId = Number(env.JEFF_CHAIN_ID || 4663);
  const collection = (env.JEFF_COLLECTION || '0xf4127ac7e73a807060cbdd08fc2c776b2e78ce67').toLowerCase();
  const rpcUrl = env.JEFF_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
  const dataRoot = resolve(options.dataRoot || env.JEFF_DATA_ROOT || 'data');
  const publicRoot = resolve(options.publicRoot || 'public');
  const restoreBlocked = () => existsSync(resolve(dataRoot, 'hosting', 'restore-guard.json'));
  const allowedModels = (env.JEFF_ALLOWED_MODELS || env.JEFF_MODEL || 'bankr/gpt-5.4-mini').split(',').map(value => value.trim()).filter(Boolean);
  if (!allowedModels.length || allowedModels.some(model => !/^bankr\/[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(model))) throw new Error('JEFF_MODEL_INVALID');
  const resolveOwner = options.resolveOwner || createOwnershipResolver({ chainId, collection, rpcUrl });
  const discoverNfts = options.discoverNfts || createNftDiscovery({ chainId, collection, rpcUrl });
  const sessions = createHolderSessions({ origin, chainId, collection, resolveOwner });
  const accountSessions = createAccountSessions({ origin, chainId, dataRoot });
  const authorizeScope = async scope => {
    if (scope.kind === 'account') {
      if (await accountSessions.registered(scope) !== true) throw new Error('JEFF_OPENCLAW_ACCOUNT_DENIED');
      return { owner: scope.owner };
    }
    const state = await resolveOwner(scope);
    if (state.owner?.toLowerCase() !== scope.owner || state.ownerEpoch !== scope.ownerEpoch) throw new Error('JEFF_OPENCLAW_OWNER_REVOKED');
    return state;
  };
  const workspace = createWorkspaceStore({ dataRoot, resolveOwner: authorizeScope, allowedModels });
  const hosting = options.hosting || createHostingLedger({ dataRoot, resolveOwner,
    quotePayment: createClockersUsdQuote({ rpcUrl, chainId, token: env.CLOCKERS_TOKEN_ADDRESS }),
    verifyPayment: createClockersPaymentVerifier({ rpcUrl, chainId }) });
  const maintenance = createMaintenanceGate({ markerPath: resolveMaintenanceMarkerPath({ env, dataRoot }), releaseSha: env.JEFF_RELEASE_SHA || null });
  const creditsEnabled = env.JEFF_INFERENCE_CREDITS_ENABLED === 'true';
  const inference = createInferenceLedger({ dataRoot });
  let pricing = {};
  if (env.JEFF_INFERENCE_PRICING) {
    try { pricing = JSON.parse(env.JEFF_INFERENCE_PRICING); } catch { throw new Error('JEFF_INFERENCE_CONFIG_INVALID'); }
  }
  const gateway = creditsEnabled ? createInferenceGateway({ ledger: inference, upstreamUrl: env.BANKR_LLM_URL || 'https://llm.bankr.bot/v1',
    upstreamKey: env.BANKR_LLM_API_KEY, allowedModels: allowedModels.map(model => model.slice(6)), pricing,
    maxInputTokens: 65536,
    track: (promise, label) => maintenance.track(promise, label) }) : null;
  let runner;
  try {
    runner = options.runAgent || createOpenClawRunner({ env, allowedModels, mode: runnerMode,
      settleInference: gateway ? async jobId => { gateway.revoke(jobId); await gateway.drain(jobId); } : undefined });
    if (gateway) await gateway.start();
  } catch (error) {
    try { await gateway?.stop(); } finally { inference.close(); }
    throw error;
  }
  const modelConfigured = Boolean(options.runAgent || env.BANKR_LLM_API_KEY);
  const researchEnabled = env.JEFF_WEB_RESEARCH_ENABLED === 'true';
  const maximumJobs = Number(env.JEFF_MAX_CONCURRENT_JOBS || 2);
  if (!Number.isSafeInteger(maximumJobs) || maximumJobs < 1 || maximumJobs > 16) throw new Error('JEFF_RUNTIME_CONFIG_INVALID');
  let admittedJobs = 0, closing = false, closePromise;
  const requireAdmission = () => { if (closing) throw new Error('JEFF_SERVICE_MAINTENANCE'); };
  const requireExecution = () => {
    requireAdmission();
    if (restoreBlocked()) throw new Error('JEFF_RESTORE_GUARDED');
  };
  const pending = new Map(), controllers = new Map(), admission = new Map();
  const githubJobs=new Map();
  const githubConfigured=env.JEFF_GITHUB_ENABLED==='true';
  if(githubConfigured&&!/^[a-fA-F0-9]{64}$/.test(env.JEFF_GITHUB_ENCRYPTION_KEY||''))throw new Error('JEFF_GITHUB_CONFIG_INVALID');
  const github=createGithubConnector({
    store:githubConfigured?createGithubConnectionStore({dataRoot,key:Buffer.from(env.JEFF_GITHUB_ENCRYPTION_KEY,'hex')}):null,
    provider:githubConfigured?(options.githubProvider||createGithubProvider({clientId:env.JEFF_GITHUB_CLIENT_ID,clientSecret:env.JEFF_GITHUB_CLIENT_SECRET,appId:env.JEFF_GITHUB_APP_ID,callbackUrl:origin+'/api/connectors/github/callback'})):null,
    authenticate:session=>(accountSessions.has(session)?accountSessions:sessions).authenticate(session),authorizeScope,requireExecution,
    cancel:scope=>{for(const[id,value]of controllers)if(value.scope===scopeId(scope)&&githubJobs.has(id))value.controller.abort();},
  });
  let bridge, accountBridge;
  const activeBridge = scope => scope.kind === 'account' ? accountBridge : bridge;
  const runAgent = async args => {
    if (closing) throw new Error('JEFF_OPENCLAW_CANCELLED');
    const binding = pending.get(scopeId(args.scope));
    if (!binding) throw new Error('JEFF_WORKSPACE_BINDING_INVALID');
    const controller = new AbortController();
    const beforeCommit = () => {
      if (closing || controller.signal.aborted) throw new Error('JEFF_OPENCLAW_CANCELLED');
      requireExecution();
    };
    controllers.set(args.jobId, { controller, scope: scopeId(args.scope) });
    try {
      await workspace.bindJob(args.scope, { jobId: args.jobId, conversationId: binding.conversationId, objective: args.objective, source: binding.source });
      const context = await workspace.executionContext(args.scope, binding.conversationId);
      if (context.settings.paused) throw new Error('JEFF_AGENT_PAUSED');
      const manual = binding.source === 'manual';
      const directRequest = manual && !binding.github && !binding.research ? directMemoryRequest(args.objective) : null;
      if (directRequest) {
        beforeCommit();
        await workspace.proposeChatAction(args.scope, args.jobId, directRequest, { timeZone: binding.timeZone, beforeCommit });
        beforeCommit();
        await workspace.applyChatMemory(args.scope, args.jobId, { beforeCommit });
        beforeCommit();
        return { text: 'Saved to memory. I’ll use this note in future conversations.', model: null };
      }
      const historyIds = context.jobIds.slice(-8).filter(id => id !== args.jobId);
      const records = historyIds.length ? await activeBridge(args.scope).retrieveMany(args.scope, historyIds) : [];
      const history = [];
      for (const record of records) {
        if (record.status === 'completed') history.push({ objective: record.objective.slice(0, 2000), text: record.text.slice(0, 6000) });
      }
      if (closing || controller.signal.aborted) throw new Error('JEFF_OPENCLAW_CANCELLED');
      requireExecution();
      const inferenceGateway = gateway?.issue({ jobId: args.jobId, scope: args.scope, model: context.settings.model.slice(6),
        dailyLimitMicros: context.settings.dailyBudgetMicros, maxChargeMicros: Number(env.JEFF_MAX_JOB_CHARGE_MICROS || 100000) });
      let research;
      if(binding.github){
        if(!manual)throw new Error('JEFF_GITHUB_SCHEDULE_DENIED');
        const source=await github.read(args.scope,binding.github,{session:binding.session,signal:controller.signal});
        research={sources:[source],failures:[],coverage:'Latest published GitHub release from one provider-confirmed repository only; bounded JSON excerpt, without following links or API pagination.'};
      }
      if (binding.research) {
        if (!manual || !researchEnabled) throw new Error('JEFF_RESEARCH_DENIED');
        await authorizeScope(args.scope);
        research = await (options.readResearchPages || readResearchPages)(binding.research.urls, { signal: controller.signal });
        if (closing || controller.signal.aborted) throw new Error('JEFF_OPENCLAW_CANCELLED');
        await authorizeScope(args.scope);
        requireExecution();
      }
      const liveResponsibility = item => item.status === 'active' && Date.parse(item.expiresAt) > Date.now() && item.runs.length < item.maxRuns;
      const responsibilities = manual ? (await scheduler.list(args.scope))
        .sort((a, b) => Number(liveResponsibility(b)) - Number(liveResponsibility(a))
          || Number(b.conversationId === binding.conversationId) - Number(a.conversationId === binding.conversationId))
        .slice(0, 16).map(item => ({
        objective: item.objective, status: item.status, nextRunAt: item.status === 'active' && !context.settings.paused
          && Date.parse(item.expiresAt) > Date.now() && item.runs.length < item.maxRuns
          && item.runs.at(-1)?.status !== 'claimed' ? item.nextRunAt : null,
        expiresAt: item.expiresAt, maxRuns: item.maxRuns, runsUsed: item.runs.length,
        lastRun: item.runs.length ? { status: item.runs.at(-1).status, finishedAt: item.runs.at(-1).finishedAt } : null,
      })) : [];
      if(binding.github)await github.assert(args.scope,binding.github.generation,binding.session);
      if(closing||controller.signal.aborted)throw new Error('JEFF_OPENCLAW_CANCELLED');
      requireExecution();
      const result = await runner({ ...args, signal: controller.signal, executionContext: { ...context, history,
        responsibilities, ...(research ? { research } : {}),
        chatActions: { enabled: manual && !research, now: new Date().toISOString(), timeZone: binding.timeZone } }, inferenceGateway });
      if (closing || controller.signal.aborted) throw new Error('JEFF_OPENCLAW_CANCELLED');
      requireExecution();
      if (research) {
        if(binding.github)await github.assert(args.scope,binding.github.generation,binding.session);
        await authorizeScope(args.scope);
        if (closing || controller.signal.aborted) throw new Error('JEFF_OPENCLAW_CANCELLED');
        return { ...result, text: researchAnswer(result.text, research) };
      }
      const decoded = decodeChatResponse(result.text);
      if (!manual) return { ...result, text: decoded.action
        ? 'Scheduled work cannot create additional memory notes or schedules. No new action was applied.' : decoded.text };
      const direct = directMemoryRequest(args.objective);
      const action = direct || decoded.action;
      if (!action) return { ...result, text: decoded.text };
      if (action.type === 'schedule.create') validateScheduleProposal(action);
      await workspace.proposeChatAction(args.scope, args.jobId, action, { timeZone: binding.timeZone, beforeCommit });
      if (closing || controller.signal.aborted) throw new Error('JEFF_OPENCLAW_CANCELLED');
      requireExecution();
      if (direct) {
        await workspace.applyChatMemory(args.scope, args.jobId, { beforeCommit });
        return { ...result, text: 'Saved to memory. I’ll use this note in future conversations.' };
      }
      return { ...result, text: action.type === 'memory.save'
        ? 'I’ve prepared a memory note. Review it below and choose Save memory to keep it.'
        : 'Here’s the schedule I’ve prepared. Review its timing and run limit below, then authorize it to start.' };
    } finally { gateway?.revoke(args.jobId); controllers.delete(args.jobId); }
  };
  const saveRecord = options.persistJobRecord || createJobRecordPersister();
  const persistRecord=async(directory,record)=>{
    if(record.status==='running'){
      const binding=pending.get(scopeId(record.scope));
      await saveRecord(directory,record);
      if(binding?.github)githubJobs.set(record.id,{scope:record.scope,generation:binding.github.generation,session:binding.session});
      return;
    }
    const grant=githubJobs.get(record.id);
    if(grant&&record.status==='completed'){
      try{
        await github.assert(grant.scope,grant.generation,grant.session);
        await saveRecord(directory,record,{commit:rename=>github.commit(grant.scope,grant.generation,rename,grant.session)});
      }catch(error){
        if(!/^(?:JEFF_GITHUB_(?:CONNECTION_CHANGED|NOT_CONNECTED|RECONNECT_REQUIRED|AUTHORITY_CHANGED)|JEFF_SESSION_(?:REQUIRED|REVOKED)|JEFF_OPENCLAW_(?:OWNER_REVOKED|ACCOUNT_DENIED|CANCELLED)|JEFF_RESTORE_GUARDED|JEFF_SERVICE_MAINTENANCE)$/.test(error.message))throw error;
        // Authority invalidation is terminal. A retry cannot restore the old
        // grant/session, and retaining it as an unsaved success strands capacity.
        record.status='failed';record.saved=true;record.error='JEFF_GITHUB_AUTHORITY_CHANGED';
        delete record.text;delete record.textSha256;delete record.model;
        await saveRecord(directory,record);
      }
      githubJobs.delete(record.id);return;
    }
    await saveRecord(directory,record);
    if(record.status==='failed')githubJobs.delete(record.id);
  };
  bridge = createJeffOpenClawNftBridge({ dataRoot, resolveOwner, runAgent, persistRecord });
  accountBridge = createJeffOpenClawAccountBridge({ dataRoot, resolveAccount: accountSessions.registered, runAgent, persistRecord });

  async function submit(scope, input, session) {
    requireExecution();
    strict(input, ['objective', 'conversationId', 'source', 'occurrenceId', 'timeZone', 'research','github']);
    let githubInput;
    if(Object.hasOwn(input,'github')){
      if(input.source==='schedule'||Object.hasOwn(input,'research'))throw new Error('JEFF_GITHUB_REQUEST_DENIED');
      githubInput=githubJobRequest(input.github);await github.assert(scope,githubInput.generation,session);
    }
    let research;
    if (Object.hasOwn(input, 'research')) {
      if (!researchEnabled || input.source === 'schedule') throw new Error('JEFF_RESEARCH_DENIED');
      research = researchRequest(input.research);
    }
    const timeZone = chatTimeZone(input.timeZone);
    if (typeof input.objective !== 'string' || !input.objective.trim() || input.objective.length > 4000) throw new Error('JEFF_OBJECTIVE_INVALID');
    if (!modelConfigured) throw new Error('JEFF_MODEL_NOT_CONFIGURED');
    const key = scopeId(scope);
    if (admission.has(key)) throw new Error('JEFF_OPENCLAW_BUSY');
    if (admittedJobs >= maximumJobs) throw new Error('JEFF_RUNTIME_BUSY');
    admittedJobs++;
    let handedOff = false;
    admission.set(key, true);
    try {
      const current = await workspace.get(scope);
      requireExecution();
      if (current.settings.paused) throw new Error('JEFF_AGENT_PAUSED');
      gateway?.preflight({ scope, model: current.settings.model.slice(6), dailyLimitMicros: current.settings.dailyBudgetMicros,
        maxChargeMicros: Number(env.JEFF_MAX_JOB_CHARGE_MICROS || 100000) });
      let conversationId = input.conversationId;
      if (conversationId && (!uuid.test(conversationId) || !current.conversations.some(item => item.id === conversationId))) throw new Error('JEFF_CONVERSATION_NOT_FOUND');
      if (!conversationId) conversationId = (await workspace.createConversation(scope, { title: input.objective.trim().slice(0, 70) })).id;
      requireExecution();
      await hosting.requireActive(scope);
      requireExecution();
      if (creditsEnabled && inference.balance(scope).availableMicros <= 0) throw new Error('JEFF_INFERENCE_INSUFFICIENT');
      if(githubInput)await github.assert(scope,githubInput.generation,session);
      pending.set(key, { conversationId, source: input.source === 'schedule' ? 'schedule' : 'manual', timeZone, research,github:githubInput,session });
      const record = await hosting.startJob(scope, async () => {
        requireExecution();
        if(githubInput)await github.assert(scope,githubInput.generation,session);
        return activeBridge(scope).start(scope, input.objective.trim());
      });
      const completion = maintenance.track(waitForDurableJob({ readRecord: createDurableJobReader({ dataRoot, scope, id: record.id }) }), `job:${record.id}`);
      handedOff = true;
      completion.finally(() => { admittedJobs--; }).catch(() => {});
      return { record: { ...record, conversationId }, completion };
    } finally { pending.delete(key); admission.delete(key); if (!handedOff) admittedJobs--; }
  }
  const scheduler = createScheduler({ dataRoot, resolveOwner: authorizeScope,
    isPaused: async scope => (await workspace.get(scope)).settings.paused,
    canRun: () => !closing && !maintenance.status().blocked && !restoreBlocked(),
    track: (promise, label) => maintenance.track(promise, label),
    execute: async (scope, input) => {
      const finish = maintenance.beginRequest();
      if (!finish) throw new Error('JEFF_SERVICE_MAINTENANCE');
      try { const job = await submit(scope, input); return await job.completion; }
      finally { finish(); }
    },
  });
  const actionOperations = new Map();
  async function changeChatAction(scope, jobId, operation) {
    const key = `${scopeId(scope)}:${jobId}`;
    if (actionOperations.has(key)) throw new Error('JEFF_CHAT_ACTION_BUSY');
    const work = (async () => {
      requireAdmission();
      const binding = await workspace.getJobBinding(scope, jobId), action = binding?.action;
      if (!action) throw new Error('JEFF_WORKSPACE_NOT_FOUND');
      if (binding.source !== 'manual') throw new Error('JEFF_CHAT_ACTION_DENIED');
      if (action.status === 'dismissed') {
        if (operation === 'dismiss') return action;
        throw new Error('JEFF_WORKSPACE_CONFLICT');
      }
      // Applied receipts are immutable and safe to retrieve after a lost reply.
      if (action.status === 'applied') {
        if (operation === 'dismiss') throw new Error('JEFF_WORKSPACE_CONFLICT');
        return action;
      }
      if (action.type === 'schedule.create') {
        // A grant may have committed before its workspace receipt failed. This
        // path only records that existing result; it never admits new work.
        const existing = (await scheduler.list(scope)).find(item => item.id === jobId);
        if (existing) {
          const p = action.parameters;
          if (existing.objective !== p.objective.trim() || existing.conversationId !== binding.conversationId
            || existing.intervalMinutes !== p.intervalMinutes || existing.maxRuns !== p.maxRuns
            || Date.parse(existing.expiresAt) !== Date.parse(p.expiresAt) || existing.firstRunAt !== p.firstRunAt) {
            throw new Error('JEFF_WORKSPACE_CONFLICT');
          }
          const recovered = await workspace.finishChatSchedule(scope, jobId, existing.id);
          // Dismissing a stale proposal must never hide an authorized grant.
          // Repair its receipt first; cancellation remains in Scheduled work.
          if (operation === 'dismiss') throw new Error('JEFF_WORKSPACE_CONFLICT');
          return recovered;
        }
      }
      if (operation === 'dismiss') return await workspace.dismissChatAction(scope, jobId);
      const job = await activeBridge(scope).retrieve(scope, jobId);
      if (job.status !== 'completed') throw new Error('JEFF_CHAT_ACTION_NOT_READY');
      requireExecution();
      if ((await workspace.get(scope)).settings.paused) throw new Error('JEFF_AGENT_PAUSED');
      if (action.type === 'memory.save') return await workspace.applyChatMemory(scope, jobId, { beforeCommit: requireExecution });
      if (action.type !== 'schedule.create') throw new Error('JEFF_CHAT_ACTION_DENIED');
      await hosting.requireActive(scope);
      requireExecution();
      if ((await workspace.get(scope)).settings.paused) throw new Error('JEFF_AGENT_PAUSED');
      const schedule = await scheduler.create(scope, { ...action.parameters, conversationId: binding.conversationId }, { idempotencyKey: jobId });
      return await workspace.finishChatSchedule(scope, jobId, schedule.id);
    })();
    actionOperations.set(key, work);
    try { return await work; }
    finally { if (actionOperations.get(key) === work) actionOperations.delete(key); }
  }
  const send = (response, status, value) => {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(value));
  };
  const bodyTimeoutMs=options.requestBodyTimeoutMs??15000;
  if(!Number.isSafeInteger(bodyTimeoutMs)||bodyTimeoutMs<1||bodyTimeoutMs>30000)throw new Error('JEFF_RUNTIME_CONFIG_INVALID');
  async function body(request) {
    if(request.destroyed)throw new Error(request.errored?.message==='JEFF_REQUEST_TIMEOUT'?'JEFF_REQUEST_TIMEOUT':'JEFF_REQUEST_INVALID');
    return new Promise((resolveBody,rejectBody)=>{
      const chunks=[];let size=0,settled=false;
      const cleanup=()=>{request.off('data',data);request.off('end',end);request.off('error',error);request.off('aborted',aborted);};
      const fail=code=>{if(settled)return;settled=true;cleanup();rejectBody(new Error(code));};
      const data=chunk=>{size+=chunk.length;if(size>32768){fail('JEFF_REQUEST_TOO_LARGE');request.destroy();}else chunks.push(chunk);};
      // Decode only after joining bytes, preserving split UTF-8 characters.
      const end=()=>{if(settled)return;settled=true;cleanup();try{resolveBody(JSON.parse(Buffer.concat(chunks,size).toString('utf8')));}catch{rejectBody(new Error('JEFF_REQUEST_INVALID'));}};
      const error=error=>fail(error?.message==='JEFF_REQUEST_TIMEOUT'?'JEFF_REQUEST_TIMEOUT':'JEFF_REQUEST_INVALID'),aborted=()=>error(request.errored);
      request.on('data',data);request.once('end',end);request.once('error',error);request.once('aborted',aborted);
    });
  }
  const usage = scope => ({ enabled: creditsEnabled, mode: creditsEnabled ? 'prepaid' : 'operator-funded',
    pricingBasis: creditsEnabled ? 'operator-token-tariff' : null, balance: inference.balance(scope), transactions: inference.list(scope) });
  const config = () => ({ product: 'JEFF', stage: options.fixture ? 'development-fixture' : env.JEFF_CONTINUOUS_HOSTING === 'true' ? 'hosted' : 'local',
    fixture: Boolean(options.fixture), chainId, collection, releaseSha: env.JEFF_RELEASE_SHA || null, modelConfigured,
    billingEnabled: hosting.enabled, continuousHosting: env.JEFF_CONTINUOUS_HOSTING === 'true', standaloneAccounts: true,
    toolsEnabled: false, webResearch: { enabled: researchEnabled && modelConfigured && !restoreBlocked(), maxSources: WEB_RESEARCH_LIMITS.maxSources,
      maxBytes: WEB_RESEARCH_LIMITS.maxBytes, maxExcerptChars: WEB_RESEARCH_LIMITS.maxExcerptChars },
    schedulesEnabled: !restoreBlocked(), restoreBlocked: restoreBlocked(), creditsEnabled, allowedModels, plan: hosting.plan, freePassEnabled: hosting.freePassEnabled });
  const transports=new Map();
  const server = createServer(async (request, response) => {
    const socket=request.socket;transports.set(socket,(transports.get(socket)||0)+1);let transportFinished=false;
    const finishTransport=()=>{if(transportFinished)return;transportFinished=true;const count=(transports.get(socket)||1)-1;if(transports.has(socket))transports.set(socket,count);if(closing&&!count)socket.destroy();};
    response.once('finish',finishTransport);response.once('close',finishTransport);
    // Bound incomplete inbound messages even when a route rejects before body().
    // Otherwise an early 401/405 can leave server.close() waiting on its socket.
    const inboundDeadline=setTimeout(()=>{if(!request.complete)request.destroy(new Error('JEFF_REQUEST_TIMEOUT'));},bodyTimeoutMs);
    const clearInboundDeadline=()=>clearTimeout(inboundDeadline);
    request.once('end',clearInboundDeadline);request.once('close',clearInboundDeadline);
    request.on('error',()=>{});
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    if (options.backupExport?.handleRequest(request, response)) return;
    const finish = maintenance.beginRequest();
    if (!finish) return send(response, 503, { error: 'JEFF_SERVICE_MAINTENANCE' });
    let diagnosticRoute = 'other';
    try {
      if (request.headers.origin && request.headers.origin !== origin) return send(response, 403, { error: 'JEFF_ORIGIN_DENIED' });
      const url = new URL(request.url, origin), route = url.pathname, method = request.method;
      if (/^\/api\/(?:auth\/(?:nfts|challenge|verify|logout)|account\/auth\/(?:challenge|verify|logout)|workspace(?:\/(?:state|settings|skills))?|conversations|memory|activity|inference|schedules|jobs)$/.test(route)) diagnosticRoute = route;
      if (/^\/api\/chat\/actions\/[a-f0-9-]{36}\/(?:apply|dismiss)$/.test(route)) diagnosticRoute = '/api/chat/actions';
      if (method === 'GET' && route === '/health') return send(response, 200, { status: 'ready', runtime: 'openclaw', scheduler: scheduler.status(), ...(options.backupStatus ? { backup: await options.backupStatus() } : {}) });
      if (method === 'GET' && route === '/api/config') return send(response, 200, config());
      if(method==='GET'&&route==='/api/connectors/github/callback'){
        try{
          if(Object.keys(Object.fromEntries(url.searchParams)).some(key=>!['code','state','error','error_description','error_uri'].includes(key))||url.searchParams.getAll('state').length!==1||url.searchParams.getAll('code').length>1)throw new Error('JEFF_GITHUB_STATE_INVALID');
          await github.callback({state:url.searchParams.get('state'),code:url.searchParams.get('code'),cookie:request.headers.cookie,denied:url.searchParams.has('error')});
          response.writeHead(303,{Location:'/#skills','Set-Cookie':githubClearCookie,'Cache-Control':'no-store'});response.end();
        }catch{response.writeHead(303,{Location:'/?github=connection_failed#skills','Set-Cookie':githubClearCookie,'Cache-Control':'no-store'});response.end();}
        return;
      }
      const bearer = request.headers.authorization?.replace(/^Bearer /, '');
      if (method === 'POST' && route === '/api/auth/nfts') return send(response, 200, await discoverNfts(await body(request)));
      for (const [prefix, manager] of [['/api/auth', sessions], ['/api/account/auth', accountSessions]]) {
        if (method === 'POST' && route === `${prefix}/challenge`) return send(response, 200, await manager.challenge(await body(request)));
        if (method === 'POST' && route === `${prefix}/verify`) return send(response, 200, await manager.verify(await body(request)));
      }
      if (method === 'POST' && route === '/api/auth/logout') { sessions.logout(bearer); accountSessions.logout(bearer); return send(response, 200, { loggedOut: true }); }
      if (route.startsWith('/api/')) {
        const scope = await (accountSessions.has(bearer) ? accountSessions : sessions).authenticate(bearer);
        requireAdmission();
        const currentBridge = activeBridge(scope);
        if(method==='GET'&&route==='/api/connectors/github')return send(response,200,await github.status(scope));
        if(method==='GET'&&route==='/api/connectors/github/repositories')return send(response,200,await github.repositories(scope,bearer));
        if(method==='POST'&&route==='/api/connectors/github/authorize'){
          if(Object.keys(strict(await body(request),[])).length)throw new Error('JEFF_REQUEST_INVALID');
          const value=await github.authorize(scope,bearer);response.setHeader('Set-Cookie',value.cookie);
          return send(response,200,{authorizationUrl:value.authorizationUrl,expiresAt:value.expiresAt});
        }
        if(method==='DELETE'&&route==='/api/connectors/github')return send(response,200,await github.disconnect(scope,bearer));
        if (method === 'GET' && route === '/api/hosting') return send(response, 200, await hosting.status(scope));
        if (method === 'POST' && route === '/api/hosting/free-pass') {
          const input = await body(request);
          if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) throw new Error('JEFF_FREE_PASS_INVALID');
          return send(response, 200, await hosting.redeemFreePass(scope));
        }
        if (method === 'POST' && route === '/api/hosting/invoice') return send(response, 200, await hosting.invoice(scope));
        if (method === 'POST' && route === '/api/hosting/activate') return send(response, 200, await hosting.activate(scope, await body(request)));
        if (method === 'GET' && route === '/api/workspace') return send(response, 200, await workspace.get(scope));
        if (method === 'GET' && route === '/api/workspace/state') return send(response, 200, { workspace: await workspace.get(scope), jobs: await currentBridge.list(scope),
          hosting: await hosting.status(scope), schedules: await scheduler.list(scope), usage: usage(scope) });
        if (method === 'PATCH' && route === '/api/workspace/settings') return send(response, 200, await workspace.updateSettings(scope, await body(request)));
        if (method === 'PATCH' && route === '/api/workspace/skills') return send(response, 200, await workspace.setSkill(scope, await body(request)));
        if (method === 'POST' && route === '/api/conversations') return send(response, 201, await workspace.createConversation(scope, await body(request)));
        if (method === 'DELETE' && /^\/api\/conversations\//.test(route)) return send(response, 200, await workspace.deleteConversation(scope, route.split('/').at(-1)));
        if (method === 'POST' && route === '/api/memory') return send(response, 200, await workspace.saveMemory(scope, await body(request)));
        if (method === 'DELETE' && /^\/api\/memory\//.test(route)) return send(response, 200, await workspace.deleteMemory(scope, route.split('/').at(-1)));
        if (method === 'GET' && route === '/api/activity') return send(response, 200, { events: await workspace.activity(scope) });
        if (method === 'GET' && route === '/api/inference') return send(response, 200, usage(scope));
        if (method === 'GET' && route === '/api/schedules') return send(response, 200, { schedules: await scheduler.list(scope) });
        if (method === 'POST' && route === '/api/schedules') {
          if (restoreBlocked()) throw new Error('JEFF_RESTORE_GUARDED');
          const input = strict(await body(request), ['objective', 'conversationId', 'intervalMinutes', 'maxRuns', 'expiresAt', 'firstRunAt']);
          const state = await workspace.get(scope);
          if (state.settings.paused) throw new Error('JEFF_AGENT_PAUSED');
          if (!state.conversations.some(item => item.id === input.conversationId)) throw new Error('JEFF_CONVERSATION_NOT_FOUND');
          await hosting.requireActive(scope);
          return send(response, 201, await scheduler.create(scope, input));
        }
        if (method === 'DELETE' && /^\/api\/schedules\//.test(route)) return send(response, 200, await scheduler.cancel(scope, route.split('/').at(-1)));
        if (method === 'POST' && route === '/api/jobs') {
          const input = strict(await body(request), ['objective', 'conversationId', 'timeZone', 'research','github']);
          return send(response, 202, (await submit(scope, input,bearer)).record);
        }
        const chatActionMatch = route.match(/^\/api\/chat\/actions\/([a-f0-9-]{36})\/(apply|dismiss)$/);
        if (method === 'POST' && chatActionMatch && uuid.test(chatActionMatch[1])) {
          const input = strict(await body(request), []);
          if (Object.keys(input).length) throw new Error('JEFF_REQUEST_INVALID');
          return send(response, 200, await changeChatAction(scope, chatActionMatch[1], chatActionMatch[2]));
        }
        const jobMatch = route.match(/^\/api\/jobs\/([a-f0-9-]{36})(?:\/(retry-save|stop))?$/);
        if (jobMatch && uuid.test(jobMatch[1])) {
          const [, id, action] = jobMatch;
          if (method === 'GET' && !action) return send(response, 200, await currentBridge.retrieve(scope, id));
          if (method === 'POST' && action === 'retry-save') return send(response, 200, await currentBridge.retrySave(scope, id));
          if (method === 'POST' && action === 'stop') {
            const record = await currentBridge.retrieve(scope, id), running = controllers.get(id);
            if (running && running.scope === scopeId(scope)) running.controller.abort();
            return send(response, 200, { id, stopRequested: Boolean(running), status: record.status });
          }
        }
        if (method === 'GET' && route === '/api/jobs') return send(response, 200, { jobs: await currentBridge.list(scope) });
        return send(response, 404, { error: 'JEFF_ROUTE_NOT_FOUND' });
      }
      if (method !== 'GET' && method !== 'HEAD') return send(response, 405, { error: 'JEFF_METHOD_DENIED' });
      const file = resolve(publicRoot, `.${decodeURIComponent(route === '/' ? '/index.html' : route)}`);
      if (!file.startsWith(publicRoot + sep)) return send(response, 403, { error: 'JEFF_PATH_DENIED' });
      const data = await readFile(file);
      const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
      response.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      response.end(method === 'HEAD' ? undefined : data);
    } catch (error) {
      const message = /^JEFF_[A-Z_]+$/.test(error.message) ? error.message : error.code === 'ENOENT' ? 'JEFF_ROUTE_NOT_FOUND' : 'JEFF_SERVICE_UNAVAILABLE';
      const status = /SESSION|OWNER|SIGNATURE|CHALLENGE/.test(message) ? 401 : /NOT_FOUND/.test(message) ? 404 : /INVALID|TOO_LARGE/.test(message) ? 400
        : /CONFLICT|BUSY|PAUSED|CHAT_ACTION_(?:NOT_READY|EXPIRED)|GITHUB_(?:CONNECTION_CHANGED|NOT_CONNECTED|RECONNECT_REQUIRED|REPOSITORY_UNAVAILABLE|RELEASE_UNAVAILABLE)/.test(message) ? 409 : /INSUFFICIENT|ALLOWANCE_EXHAUSTED|USAGE_LIMIT|DAILY_LIMIT/.test(message) ? 429 : /FREE_PASS_DENIED|CHAT_ACTION_DENIED|RESEARCH_DENIED/.test(message) ? 403 : 503;
      if (status >= 500) {
        const event = { event: 'JEFF_REQUEST_FAILED', method: ['GET', 'POST', 'PATCH', 'DELETE', 'HEAD'].includes(request.method) ? request.method : 'OTHER',
          route: diagnosticRoute, status, error: message, ...failureDetails(error) };
        try { (options.onRequestError || (value => console.error(JSON.stringify(value))))(event); } catch {}
      }
      send(response, status, { error: message });
    } finally { finish(); }
  });
  server.on('connection',socket=>{transports.set(socket,0);socket.once('close',()=>transports.delete(socket));if(closing)socket.destroy();});
  await maintenance.resume();
  if (options.startScheduler !== false) scheduler.start();
  return Object.freeze({ server, sessions, workspace, scheduler, inference, gateway, maintenance, config, submit,
    close() {
      if (closePromise) return closePromise;
      closing = true;
      let runnerClosePromise;
      const closeRunner = () => runnerClosePromise ||= Promise.resolve().then(() => runner.close?.());
      // pause blocks immediately; await its drain only after cancelling children.
      const paused = maintenance.pause();
      closePromise = (async () => {
        try {
          for (const { controller } of controllers.values()) controller.abort();
          await scheduler.stop();
          if (server.listening) await new Promise(resolveClosed => { server.close(resolveClosed); server.closeIdleConnections();for(const[socket,count]of transports)if(!count)socket.destroy(); });
          await paused;
          await closeRunner();
          await gateway?.drain();
          inference.checkpoint();
        } finally {
          try { await closeRunner(); }
          finally { try { await gateway?.stop(); } finally { inference.close(); } }
        }
      })();
      return closePromise;
    },
  });
}
