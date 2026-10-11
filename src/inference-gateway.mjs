import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { scopeId } from './scope.mjs';

const fail = code => new Error(`JEFF_INFERENCE_${code}`);
const positive = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const modelName = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,119}$/.test(value);
const same = (left, right) => {
  const a = Buffer.from(left || ''), b = Buffer.from(right || '');
  return a.length === b.length && timingSafeEqual(a, b);
};
const cost = (input, output, policy) => {
  const numerator = BigInt(input) * BigInt(policy.inputMicrosPerMillionTokens)
    + BigInt(output) * BigInt(policy.outputMicrosPerMillionTokens);
  const micros = (numerator + 999999n) / 1000000n;
  if (micros > BigInt(Number.MAX_SAFE_INTEGER)) throw fail('PRICE_INVALID');
  return Number(micros);
};

// Bankr's documented /v1/usage returns aggregate billed totals, not attributable
// call charges (https://docs.bankr.bot/llm-gateway/api-reference/, checked 2026-10-07).
// This gateway therefore charges a separately configured, versioned operator
// token tariff using measured response usage. It never labels this provider debit.
// No tariff is inferred from a model name or a wallet balance difference.
export function createInferenceGateway({ ledger, upstreamUrl, upstreamKey, allowedModels = [], pricing = {},
  maxCalls = 1, maxInputTokens = 16384, maxOutputTokens = 4096, fetchImpl = fetch, now = Date.now,
  track = promise => promise, maxJobs = 4096 } = {}) {
  if (!ledger || typeof ledger.reserve !== 'function' || typeof fetchImpl !== 'function'
    || !positive(maxCalls) || maxCalls > 16 || !positive(maxInputTokens) || maxInputTokens > 131072
    || !positive(maxOutputTokens) || maxOutputTokens > 32768 || typeof now !== 'function'
    || typeof track !== 'function' || !positive(maxJobs) || maxJobs > 65536) throw fail('GATEWAY_CONFIG_INVALID');
  let upstream;
  try { upstream = new URL(upstreamUrl); } catch { throw fail('GATEWAY_CONFIG_INVALID'); }
  if (upstream.username || upstream.password || upstream.search || upstream.hash
    || !['https:', 'http:'].includes(upstream.protocol)
    || (upstream.protocol === 'http:' && !['127.0.0.1', '[::1]', 'localhost'].includes(upstream.hostname))
    || !['', '/', '/v1', '/v1/', '/zdr', '/zdr/'].includes(upstream.pathname)
    || typeof upstreamKey !== 'string' || !upstreamKey || /[\r\n]/.test(upstreamKey)) throw fail('GATEWAY_CONFIG_INVALID');
  const destination = new URL(`${upstream.pathname.replace(/\/$/, '') || '/v1'}/chat/completions`, upstream.origin).href;
  const models = new Set(allowedModels);
  if (!Array.isArray(allowedModels) || allowedModels.some(model => !modelName(model))) throw fail('GATEWAY_CONFIG_INVALID');
  const jobs = new Map(), credentials = new Map();
  let server, baseUrl, stopping = false;
  const inFlight = new Set(), inFlightByJob = new Map(), controllers = new Set();
  function expire() {
    for (const [id, job] of jobs) {
      if (now() >= job.expiresAt && !job.busy) { credentials.delete(job.apiKey); jobs.delete(id); }
    }
  }
  function policyFor(model) {
    const policy = pricing[model];
    if (!policy || policy.basis !== 'operator-token-tariff' || typeof policy.policyId !== 'string'
      || !/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,119}$/.test(policy.policyId)
      || !nonnegative(policy.inputMicrosPerMillionTokens) || !nonnegative(policy.outputMicrosPerMillionTokens)
      || !(policy.inputMicrosPerMillionTokens || policy.outputMicrosPerMillionTokens)) throw fail('PRICE_POLICY_REQUIRED');
    return Object.freeze({ ...policy });
  }
  function budgetFor(scope) {
    return scope.kind === 'account' || (/^0x[a-fA-F0-9]{40}$/.test(scope.collection || '')
      && /^(0|[1-9][0-9]{0,77})$/.test(scope.tokenId || '') && Number.isSafeInteger(scope.ownerEpoch) && scope.ownerEpoch >= 0)
      ? scopeId(scope) : undefined;
  }
  function preflight({ scope, model, dailyLimitMicros, maxChargeMicros } = {}) {
    if (!models.has(model) || !positive(dailyLimitMicros) || !positive(maxChargeMicros)) throw fail('JOB_CONFIG_INVALID');
    const policy = policyFor(model), requiredMicros = Math.max(1, cost(maxInputTokens, maxOutputTokens, policy));
    if (requiredMicros > maxChargeMicros) throw fail('JOB_LIMIT_REACHED');
    return { ...ledger.checkReservation({ scope, amountMicros: requiredMicros, dailyLimitMicros, budgetScopeId: budgetFor(scope) }),
      pricingBasis: 'operator-token-tariff', pricingPolicyId: policy.policyId, maxInputTokens, maxOutputTokens };
  }
  const send = (response, status, code) => {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify({ error: { message: code, type: 'jeff_inference_error' } }));
  };
  async function readRequest(request) {
    const chunks = []; let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > 128 * 1024) throw fail('REQUEST_TOO_LARGE');
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw fail('REQUEST_INVALID'); }
  }
  function validateRequest(input, job) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || input.model !== job.model) throw fail('MODEL_DENIED');
    const fields = new Set(['model','messages','stream','stream_options','max_tokens','max_completion_tokens','temperature','top_p',
      'stop','frequency_penalty','presence_penalty','seed','reasoning_effort','tools','tool_choice','store','user']);
    if (Object.keys(input).some(key => !fields.has(key)) || (input.tools !== undefined && (!Array.isArray(input.tools) || input.tools.length))
      || (input.tool_choice !== undefined && input.tool_choice !== 'none') || (input.store !== undefined && input.store !== false)
      || (input.stream !== undefined && typeof input.stream !== 'boolean')) throw fail('REQUEST_DENIED');
    if (!Array.isArray(input.messages) || input.messages.length < 1 || input.messages.length > 128) throw fail('CONTEXT_LIMIT_REACHED');
    const roles = new Set(['system','developer','user','assistant']);
    for (const message of input.messages) {
      if (!message || !roles.has(message.role) || Object.keys(message).some(key => !['role','content','name'].includes(key))
        || (message.name !== undefined && (typeof message.name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(message.name)))) throw fail('REQUEST_DENIED');
      if (Array.isArray(message.content)) {
        if (!message.content.length || message.content.some(part => !part || part.type !== 'text' || typeof part.text !== 'string'
          || Object.keys(part).some(key => !['type','text'].includes(key)))) throw fail('REQUEST_DENIED');
      } else if (typeof message.content !== 'string') throw fail('REQUEST_DENIED');
    }
    // One token per UTF-8 byte plus generous per-message framing is a
    // conservative admission bound, not a charge. Only measured usage settles.
    const contextBound = Buffer.byteLength(JSON.stringify(input.messages)) + 96 * input.messages.length;
    if (contextBound > maxInputTokens) throw fail('CONTEXT_LIMIT_REACHED');
    const supplied = [input.max_tokens, input.max_completion_tokens].filter(value => value !== undefined);
    if (!supplied.length || supplied.some(value => !positive(value) || value > maxOutputTokens)) throw fail('OUTPUT_LIMIT_REACHED');
    const cap = Math.min(...supplied);
    if (input.temperature !== undefined && (!Number.isFinite(input.temperature) || input.temperature < 0 || input.temperature > 2)) throw fail('REQUEST_INVALID');
    if (input.top_p !== undefined && (!Number.isFinite(input.top_p) || input.top_p < 0 || input.top_p > 1)) throw fail('REQUEST_INVALID');
    if (input.reasoning_effort !== undefined && !['none','minimal','low','medium','high'].includes(input.reasoning_effort)) throw fail('REQUEST_DENIED');
    if (input.stop !== undefined && !(typeof input.stop === 'string' && input.stop.length <= 256)
      && !(Array.isArray(input.stop) && input.stop.length <= 4 && input.stop.every(item => typeof item === 'string' && item.length <= 256))) throw fail('REQUEST_INVALID');
    for (const key of ['frequency_penalty','presence_penalty']) if (input[key] !== undefined && (!Number.isFinite(input[key]) || Math.abs(input[key]) > 2)) throw fail('REQUEST_INVALID');
    if (input.seed !== undefined && !Number.isSafeInteger(input.seed)) throw fail('REQUEST_INVALID');
    const forwarded = { model: job.model, messages: input.messages, stream: false, max_completion_tokens: cap };
    for (const key of ['temperature','top_p','stop','frequency_penalty','presence_penalty','seed','reasoning_effort'])
      if (input[key] !== undefined) forwarded[key] = input[key];
    return { forwarded, cap, streaming: input.stream === true };
  }
  async function boundedResponse(response, signal) {
    const chunks = []; let bytes = 0;
    if (!response.body?.getReader) {
      const text = await response.text();
      if (Buffer.byteLength(text) > 1024 * 1024) throw fail('RESPONSE_INVALID');
      return JSON.parse(text);
    }
    const reader = response.body.getReader();
    try {
      while (true) {
        if (signal.aborted) throw fail('PROVIDER_OUTCOME_UNKNOWN');
        const next = await reader.read(); if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > 1024 * 1024) throw fail('RESPONSE_INVALID');
        chunks.push(Buffer.from(next.value));
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } finally { if (bytes > 1024 * 1024 || signal.aborted) await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  function measuredCost(output, job, cap) {
    const usage = output?.usage;
    if (!output || output.error || !Array.isArray(output.choices) || output.choices.length !== 1
      || typeof output.choices[0]?.message?.content !== 'string' || !usage
      || !nonnegative(usage.prompt_tokens) || !nonnegative(usage.completion_tokens)
      || !nonnegative(usage.total_tokens) || usage.total_tokens !== usage.prompt_tokens + usage.completion_tokens
      || usage.prompt_tokens > maxInputTokens || usage.completion_tokens > cap
      || (output.model !== undefined && output.model !== job.model)) throw fail('USAGE_UNVERIFIED');
    const inputDetails = usage.prompt_tokens_details, outputDetails = usage.completion_tokens_details;
    if ((inputDetails !== undefined && (!inputDetails || typeof inputDetails !== 'object' || Array.isArray(inputDetails)))
      || (outputDetails !== undefined && (!outputDetails || typeof outputDetails !== 'object' || Array.isArray(outputDetails)))) throw fail('USAGE_UNVERIFIED');
    for (const value of Object.values(inputDetails || {})) if (!nonnegative(value) || value > usage.prompt_tokens) throw fail('USAGE_UNVERIFIED');
    for (const value of Object.values(outputDetails || {})) if (!nonnegative(value) || value > usage.completion_tokens) throw fail('USAGE_UNVERIFIED');
    // The declared tariff bills all prompt and completion tokens equally,
    // including cached prompt and reasoning tokens included in those totals.
    return { chargedMicros: cost(usage.prompt_tokens, usage.completion_tokens, job.policy), details: {
      pricingBasis: 'operator-token-tariff', pricingPolicyId: job.policy.policyId,
      providerDebitVerified: false, inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens,
      providerRequestId: typeof output.id === 'string' ? output.id.slice(0, 160) : null } };
  }
  function deliver(response, output, streaming) {
    if (response.destroyed || response.writableEnded) return;
    if (!streaming) {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(output)); return;
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    const common = { id: output.id, object: 'chat.completion.chunk', created: output.created, model: output.model };
    response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: { role: 'assistant', content: output.choices[0].message.content }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: output.choices[0].finish_reason || 'stop' }], usage: output.usage })}\n\n`);
    response.end('data: [DONE]\n\n');
  }
  async function handle(request, response, requestState) {
    let reservationId, forwarded = false, job, ownsBusy = false;
    try {
      if (stopping || request.method !== 'POST' || request.url !== '/v1/chat/completions'
        || request.headers.origin || !['127.0.0.1','::1','::ffff:127.0.0.1'].includes(request.socket.remoteAddress)) return send(response, 403, 'JEFF_INFERENCE_ROUTE_DENIED');
      const authorization = request.headers.authorization;
      expire();
      const key = typeof authorization === 'string' && authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
      job = credentials.get(key);
      if (!job || !same(job.apiKey, key) || job.revoked || now() >= job.expiresAt) return send(response, 401, 'JEFF_INFERENCE_CREDENTIAL_DENIED');
      // Associate body reads with the job before the handler first yields.
      requestState.jobId = job.jobId;
      const input = await readRequest(request);
      if (job.revoked || now() >= job.expiresAt) throw fail('CREDENTIAL_DENIED');
      const validated = validateRequest(input, job);
      if (job.calls >= maxCalls || job.busy) throw fail('CALL_LIMIT_REACHED');
      const reservationMicros = Math.max(1, cost(maxInputTokens, validated.cap, job.policy));
      if (reservationMicros > job.maxChargeMicros - job.committedMicros) throw fail('JOB_LIMIT_REACHED');
      reservationId = `${job.jobId}:${randomUUID()}`;
      ledger.reserve({ id: reservationId, scope: job.scope, amountMicros: reservationMicros, dailyLimitMicros: job.dailyLimitMicros,
        budgetScopeId: job.budgetScopeId,
        details: { jobId: job.jobId, model: job.model, agentScope: job.agentScope,
          pricingBasis: 'operator-token-tariff', pricingPolicyId: job.policy.policyId } });
      job.calls++; job.busy = true; ownsBusy = true; job.committedMicros += reservationMicros;
      if (job.revoked || stopping) { ledger.release(reservationId); throw fail('CREDENTIAL_DENIED'); }
      ledger.markForwarded(reservationId); forwarded = true;
      const controller = new AbortController();
      controllers.add(controller); job.controllers.add(controller);
      const timer = setTimeout(() => controller.abort(), 120000);
      let output;
      try {
        const upstreamResponse = await fetchImpl(destination, { method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { 'Content-Type': 'application/json', 'X-API-Key': upstreamKey, Authorization: `Bearer ${upstreamKey}` },
          body: JSON.stringify(validated.forwarded) });
        if (!upstreamResponse.ok) throw fail('PROVIDER_OUTCOME_UNKNOWN');
        output = await boundedResponse(upstreamResponse, controller.signal);
      } finally { clearTimeout(timer); controllers.delete(controller); job.controllers.delete(controller); }
      const measured = measuredCost(output, job, validated.cap);
      ledger.settle({ id: reservationId, outcome: 'charged', ...measured });
      job.committedMicros -= reservationMicros - measured.chargedMicros;
      deliver(response, output, validated.streaming);
    } catch (error) {
      if (reservationId) {
        try {
          if (forwarded) ledger.settle({ id: reservationId, outcome: 'unknown', details: { failure: 'provider-outcome-or-usage-unverified' } });
          else ledger.release(reservationId);
        } catch { /* Preserve the durable reservation if settlement itself failed. */ }
      }
      const code = /^JEFF_INFERENCE_[A-Z_]+$/.test(error.message) ? error.message : 'JEFF_INFERENCE_PROVIDER_OUTCOME_UNKNOWN';
      const status = /CREDENTIAL/.test(code) ? 401 : /BALANCE/.test(code) ? 402 : /LIMIT|EXHAUSTED/.test(code) ? 429
        : /MODEL_DENIED|REQUEST_DENIED/.test(code) ? 403 : /INVALID|TOO_LARGE/.test(code) ? 400 : 503;
      send(response, status, code);
    } finally { if (job && ownsBusy) job.busy = false; }
  }
  return Object.freeze({
    preflight,
    async start() {
      if (server) return { baseUrl };
      stopping = false;
      server = createServer((request, response) => {
        const requestState = {}, promise = handle(request, response, requestState); inFlight.add(promise);
        let jobRequests;
        if (requestState.jobId !== undefined) {
          jobRequests = inFlightByJob.get(requestState.jobId);
          if (!jobRequests) { jobRequests = new Set(); inFlightByJob.set(requestState.jobId, jobRequests); }
          jobRequests.add(promise);
        }
        promise.finally(() => {
          inFlight.delete(promise);
          if (jobRequests) {
            jobRequests.delete(promise);
            if (!jobRequests.size) inFlightByJob.delete(requestState.jobId);
          }
        }).catch(() => {});
        Promise.resolve(track(promise, `inference:${randomUUID()}`)).catch(() => {});
      });
      server.requestTimeout = 130000; server.headersTimeout = 10000;
      await new Promise((resolveReady, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveReady); });
      baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
      return { baseUrl };
    },
    issue({ jobId, scope, model, dailyLimitMicros, maxChargeMicros } = {}) {
      expire();
      if (!baseUrl || stopping || typeof jobId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,119}$/.test(jobId)
        || jobs.has(jobId) || !models.has(model) || !positive(dailyLimitMicros) || !positive(maxChargeMicros)) throw fail('JOB_CONFIG_INVALID');
      if (jobs.size >= maxJobs) throw fail('CAPACITY_REACHED');
      const current = ledger.balance(scope);
      if (current.restoreBlocked || current.paused) throw fail('PAUSED');
      const policy = policyFor(model);
      if (!current.availableMicros) throw fail('BALANCE_EXHAUSTED');
      const apiKey = randomBytes(32).toString('base64url');
      const agentScope = scope.kind === 'account' ? { kind: 'account' } : {
        kind: 'nft', collection: /^0x[a-fA-F0-9]{40}$/.test(scope.collection || '') ? scope.collection.toLowerCase() : null,
        tokenId: /^(0|[1-9][0-9]{0,77})$/.test(scope.tokenId || '') ? scope.tokenId : null,
        ownerEpoch: Number.isSafeInteger(scope.ownerEpoch) && scope.ownerEpoch >= 0 ? scope.ownerEpoch : null };
      const budgetScopeId = budgetFor(scope);
      const job = { jobId, scope: { chainId: current.chainId, owner: current.wallet }, model, dailyLimitMicros, maxChargeMicros,
        apiKey, policy, agentScope, budgetScopeId, controllers: new Set(), calls: 0, committedMicros: 0, busy: false, revoked: false, expiresAt: now() + 180000 };
      jobs.set(jobId, job); credentials.set(apiKey, job);
      return { baseUrl, apiKey, model, maxInputTokens, maxOutputTokens };
    },
    revoke(jobId) { const job = jobs.get(jobId); if (job) {
      job.revoked = true; credentials.delete(job.apiKey);
      for (const controller of job.controllers) controller.abort();
    } },
    async drain(jobId) {
      if (jobId !== undefined && (typeof jobId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,119}$/.test(jobId))) throw fail('JOB_CONFIG_INVALID');
      const requests = jobId === undefined ? inFlight : inFlightByJob.get(jobId);
      while (requests?.size) await Promise.allSettled([...requests]);
    },
    status() { expire(); return { activeRequests: inFlight.size, activeCredentials: credentials.size, retainedJobs: jobs.size, maxJobs, stopping }; },
    async stop() {
      stopping = true;
      for (const job of jobs.values()) { job.revoked = true; credentials.delete(job.apiKey); }
      for (const controller of controllers) controller.abort();
      if (server) {
        const current = server; server = undefined; baseUrl = undefined;
        await new Promise(resolveClosed => { current.close(resolveClosed); current.closeIdleConnections(); });
      }
      await Promise.allSettled([...inFlight]);
    },
  });
}
