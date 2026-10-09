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
  if (gateway) await gateway.start();
  const runner = options.runAgent || createOpenClawRunner({ env, allowedModels });
  const modelConfigured = Boolean(options.runAgent || env.BANKR_LLM_API_KEY);
  const maximumJobs = Number(env.JEFF_MAX_CONCURRENT_JOBS || 2);
  if (!Number.isSafeInteger(maximumJobs) || maximumJobs < 1 || maximumJobs > 16) throw new Error('JEFF_RUNTIME_CONFIG_INVALID');
  let admittedJobs = 0, closing = false, closePromise;
  const requireAdmission = () => { if (closing) throw new Error('JEFF_SERVICE_MAINTENANCE'); };
  const requireExecution = () => {
    requireAdmission();
    if (restoreBlocked()) throw new Error('JEFF_RESTORE_GUARDED');
  };
  const pending = new Map(), controllers = new Map(), admission = new Map();
  let bridge, accountBridge;
  const activeBridge = scope => scope.kind === 'account' ? accountBridge : bridge;
  const runAgent = async args => {
    if (closing) throw new Error('JEFF_OPENCLAW_CANCELLED');
    const binding = pending.get(scopeId(args.scope));
    if (!binding) throw new Error('JEFF_WORKSPACE_BINDING_INVALID');
    const controller = new AbortController();
    controllers.set(args.jobId, { controller, scope: scopeId(args.scope) });
    try {
      await workspace.bindJob(args.scope, { jobId: args.jobId, conversationId: binding.conversationId, objective: args.objective, source: binding.source });
      const context = await workspace.executionContext(args.scope, binding.conversationId);
      if (context.settings.paused) throw new Error('JEFF_AGENT_PAUSED');
      const history = [];
      for (const id of context.jobIds.slice(-8)) {
        if (id === args.jobId) continue;
        const record = await activeBridge(args.scope).retrieve(args.scope, id);
        if (record.status === 'completed') history.push({ objective: record.objective.slice(0, 2000), text: record.text.slice(0, 6000) });
      }
      if (closing || controller.signal.aborted) throw new Error('JEFF_OPENCLAW_CANCELLED');
      requireExecution();
      const inferenceGateway = gateway?.issue({ jobId: args.jobId, scope: args.scope, model: context.settings.model.slice(6),
        dailyLimitMicros: context.settings.dailyBudgetMicros, maxChargeMicros: Number(env.JEFF_MAX_JOB_CHARGE_MICROS || 100000) });
      return await runner({ ...args, signal: controller.signal, executionContext: { ...context, history }, inferenceGateway });
    } finally { gateway?.revoke(args.jobId); controllers.delete(args.jobId); }
  };
  bridge = createJeffOpenClawNftBridge({ dataRoot, resolveOwner, runAgent });
  accountBridge = createJeffOpenClawAccountBridge({ dataRoot, resolveAccount: accountSessions.registered, runAgent });

  async function submit(scope, input) {
    requireExecution();
    strict(input, ['objective', 'conversationId', 'source', 'occurrenceId']);
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
      pending.set(key, { conversationId, source: input.source === 'schedule' ? 'schedule' : 'manual' });
      const record = await hosting.startJob(scope, () => {
        requireExecution();
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
  const send = (response, status, value) => {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(value));
  };
  async function body(request) {
    const chunks = []; let size = 0;
    for await (const chunk of request) { size += chunk.length; if (size > 32768) throw new Error('JEFF_REQUEST_TOO_LARGE'); chunks.push(chunk); }
    // A multibyte character can span chunks. Decode only after joining bytes.
    try { return JSON.parse(Buffer.concat(chunks, size).toString('utf8')); } catch { throw new Error('JEFF_REQUEST_INVALID'); }
  }
  const usage = scope => ({ enabled: creditsEnabled, mode: creditsEnabled ? 'prepaid' : 'operator-funded',
    pricingBasis: creditsEnabled ? 'operator-token-tariff' : null, balance: inference.balance(scope), transactions: inference.list(scope) });
  const config = () => ({ product: 'JEFF', stage: options.fixture ? 'development-fixture' : env.JEFF_CONTINUOUS_HOSTING === 'true' ? 'hosted' : 'local',
    fixture: Boolean(options.fixture), chainId, collection, releaseSha: env.JEFF_RELEASE_SHA || null, modelConfigured,
    billingEnabled: hosting.enabled, continuousHosting: env.JEFF_CONTINUOUS_HOSTING === 'true', standaloneAccounts: true,
    toolsEnabled: false, schedulesEnabled: !restoreBlocked(), restoreBlocked: restoreBlocked(), creditsEnabled, allowedModels, plan: hosting.plan, freePassEnabled: hosting.freePassEnabled });
  const server = createServer(async (request, response) => {
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
      if (method === 'GET' && route === '/health') return send(response, 200, { status: 'ready', runtime: 'openclaw', scheduler: scheduler.status() });
      if (method === 'GET' && route === '/api/config') return send(response, 200, config());
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
          const input = strict(await body(request), ['objective', 'conversationId', 'intervalMinutes', 'maxRuns', 'expiresAt']);
          const state = await workspace.get(scope);
          if (state.settings.paused) throw new Error('JEFF_AGENT_PAUSED');
          if (!state.conversations.some(item => item.id === input.conversationId)) throw new Error('JEFF_CONVERSATION_NOT_FOUND');
          await hosting.requireActive(scope);
          return send(response, 201, await scheduler.create(scope, input));
        }
        if (method === 'DELETE' && /^\/api\/schedules\//.test(route)) return send(response, 200, await scheduler.cancel(scope, route.split('/').at(-1)));
        if (method === 'POST' && route === '/api/jobs') {
          const input = strict(await body(request), ['objective', 'conversationId']);
          return send(response, 202, (await submit(scope, input)).record);
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
        : /CONFLICT|BUSY|PAUSED/.test(message) ? 409 : /INSUFFICIENT|ALLOWANCE_EXHAUSTED|USAGE_LIMIT|DAILY_LIMIT/.test(message) ? 429 : /FREE_PASS_DENIED/.test(message) ? 403 : 503;
      if (status >= 500) {
        const event = { event: 'JEFF_REQUEST_FAILED', method: ['GET', 'POST', 'PATCH', 'DELETE', 'HEAD'].includes(request.method) ? request.method : 'OTHER',
          route: diagnosticRoute, status, error: message, ...failureDetails(error) };
        try { (options.onRequestError || (value => console.error(JSON.stringify(value))))(event); } catch {}
      }
      send(response, status, { error: message });
    } finally { finish(); }
  });
  await maintenance.resume();
  if (options.startScheduler !== false) scheduler.start();
  return Object.freeze({ server, sessions, workspace, scheduler, inference, gateway, maintenance, config, submit,
    close() {
      if (closePromise) return closePromise;
      closing = true;
      // pause blocks immediately; await its drain only after cancelling children.
      const paused = maintenance.pause();
      closePromise = (async () => {
        try {
          for (const { controller } of controllers.values()) controller.abort();
          await scheduler.stop();
          if (server.listening) await new Promise(resolveClosed => { server.close(resolveClosed); server.closeIdleConnections(); });
          await paused;
          await gateway?.drain();
          inference.checkpoint();
        } finally {
          await gateway?.stop();
          inference.close();
        }
      })();
      return closePromise;
    },
  });
}
