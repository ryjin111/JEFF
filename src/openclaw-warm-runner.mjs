import { spawn } from 'node:child_process';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve, sep } from 'node:path';
import { scopeId } from './scope.mjs';

const fail = code => new Error(`JEFF_OPENCLAW_${code}`);
const bounded = (promise, ms, code, signal) => new Promise((ok, reject) => {
  let timer;
  const finish = (callback, value) => { clearTimeout(timer); signal?.removeEventListener('abort', abort); callback(value); };
  const abort = () => finish(reject, signal.reason);
  timer = setTimeout(() => finish(reject, fail(code)), ms);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  Promise.resolve(promise).then(value => finish(ok, value), error => finish(reject, error));
});
const loopback = value => {
  try { const url = new URL(value); return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname); }
  catch { return false; }
};
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const overlap = (left, right) => {
  if (process.platform === 'win32') { left = left.toLowerCase(); right = right.toLowerCase(); }
  return left === right || left.startsWith(right + sep) || right.startsWith(left + sep);
};
async function allocatePort() {
  const socket = createServer();
  await new Promise((ok, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', ok); });
  const port = socket.address().port;
  await new Promise((ok, reject) => socket.close(error => error ? reject(error) : ok()));
  return port;
}
async function defaultClient(options) {
  const { GatewayClient } = await import('openclaw/plugin-sdk/gateway-runtime');
  return new GatewayClient(options);
}

// A worker belongs to one complete owner scope, including its NFT owner epoch.
// It never receives an upstream credential. Reuse requires a host-owned callback
// that revokes this job's proxy key and joins only this job's ledger settlement.
export function createOpenClawWarmPool({ node, cli, env, timeoutMs, settleInference,
  spawnProcess = spawn, maxWorkers = 2, idleMs = 60000, startupTimeoutMs = 90000,
  cleanupTimeoutMs = 5000, createGatewayClient = defaultClient } = {}) {
  if (typeof settleInference !== 'function' || typeof createGatewayClient !== 'function'
    || !Number.isSafeInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > 4
    || !Number.isSafeInteger(idleMs) || idleMs < 1 || idleMs > 300000
    || !Number.isSafeInteger(startupTimeoutMs) || startupTimeoutMs < 1 || startupTimeoutMs > 120000
    || !Number.isSafeInteger(cleanupTimeoutMs) || cleanupTimeoutMs < 1 || cleanupTimeoutMs > 15000) throw fail('CONFIG_INVALID');
  const workers = new Map(), active = new Set();
  const modelTimeoutSeconds = Math.min(120, Math.max(1, Math.ceil(timeoutMs / 1000)));
  let closed = false, closePromise, drainPromise, quiescing = false, reservation = Promise.resolve();
  async function reserve(operation) {
    const previous = reservation;
    let release;
    reservation = new Promise(ok => { release = ok; });
    await previous;
    try { return await operation(); } finally { release(); }
  }
  const request = (worker, method, params, options = {}) => bounded(
    worker.client.request(method, params, { timeoutMs: cleanupTimeoutMs, ...options }),
    options.timeoutMs ?? cleanupTimeoutMs, 'GATEWAY_TIMEOUT');

  async function retire(worker) {
    if (worker.retirement) return worker.retirement;
    worker.retiring = true;
    clearTimeout(worker.idleTimer);
    worker.retirement = (async () => {
      const current = worker.current;
      if (current?.runId && worker.client && !current.finalReceived) {
        try { await request(worker, 'chat.abort', { sessionKey: current.sessionKey, runId: current.runId }, { timeoutMs: 1500 }); } catch {}
      }
      if (worker.client) {
        try { await bounded(worker.client.stopAndWait({ timeoutMs: 1500 }), 1700, 'GATEWAY_STOP_TIMEOUT'); } catch {}
      }
      if (worker.child && !worker.exited) {
        try { worker.child.kill('SIGTERM'); } catch {}
        try { await bounded(worker.exit, 2000, 'GATEWAY_STOP_TIMEOUT'); }
        catch {
          try { worker.child.kill('SIGKILL'); } catch {}
          await bounded(worker.exit, 2000, 'GATEWAY_STOP_TIMEOUT');
        }
      }
      if (worker.child && !worker.exited) throw fail('GATEWAY_STOP_TIMEOUT');
      // Killing a child does not cancel host-side filesystem awaits or an SDK
      // import. Keep both paths reserved until all old preparation has ended.
      // If that cannot be established, retain this quarantined map entry.
      if (worker.preparation) {
        await bounded(worker.preparation.then(() => {}, () => {}), cleanupTimeoutMs, 'GATEWAY_STOP_TIMEOUT');
      }
      if (workers.get(worker.key) === worker) workers.delete(worker.key);
    })();
    return worker.retirement;
  }

  async function patchCredential(worker, apiKey) {
    const before = await request(worker, 'config.get', {});
    if (typeof before?.hash !== 'string' || !before.hash || before.hash.length > 256) throw fail('GATEWAY_CONFIG_INVALID');
    const patch = await request(worker, 'config.patch', {
      raw: JSON.stringify({ models: { providers: { bankr: { apiKey } } } }), baseHash: before.hash,
    });
    const after = await request(worker, 'config.get', {});
    if (!Array.isArray(patch?.changedPaths) || patch.changedPaths.length !== 1
      || patch.changedPaths[0] !== 'models.providers.bankr.apiKey'
      || typeof after?.configRevisionHash !== 'string' || !after.configRevisionHash
      || after.appliedConfigHash !== after.configRevisionHash) throw fail('GATEWAY_CONFIG_NOT_APPLIED');
  }

  async function start(worker, prepared) {
    const signal = worker.current.controller.signal;
    const assertCurrent = () => { signal.throwIfAborted(); if (worker.retiring) throw fail('CANCELLED'); };
    assertCurrent();
    const port = await allocatePort(), controlToken = randomBytes(32).toString('base64url');
    assertCurrent();
    const configPath = resolve(worker.stateRoot, 'openclaw.json');
    const config = structuredClone(prepared.config);
    config.models.providers.bankr.apiKey = worker.inactiveKey;
    config.agents.defaults.heartbeat = { every: '0m' };
    config.agents.defaults.timeoutSeconds = modelTimeoutSeconds;
    config.cron = { enabled: false };
    config.update = { checkOnStart: false, auto: { enabled: false } };
    config.browser = { enabled: false };
    config.discovery = { mdns: { mode: 'off' } };
    config.gateway = { mode: 'local', bind: 'loopback', port, auth: { mode: 'token', token: controlToken },
      controlUi: { enabled: false }, reload: { mode: 'hybrid' } };
    await writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    assertCurrent();
    const childEnv = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'LANG']
      .filter(key => env[key]).map(key => [key, env[key]]));
    Object.assign(childEnv, { HOME: worker.stateRoot, USERPROFILE: worker.stateRoot,
      OPENCLAW_STATE_DIR: worker.stateRoot, OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_HOME: worker.stateRoot,
      OPENCLAW_NO_RESPAWN: '1', NODE_DISABLE_COMPILE_CACHE: '1',
      OPENCLAW_DISABLE_BONJOUR: '1', OPENCLAW_SKIP_CHANNELS: '1', OPENCLAW_EXEC_SHELL_SNAPSHOT: '0', OPENCLAW_NO_AUTO_UPDATE: '1',
      TEMP: resolve(worker.stateRoot, 'tmp'), TMP: resolve(worker.stateRoot, 'tmp') });
    worker.child = spawnProcess(node, [cli, 'gateway', 'run', '--bind', 'loopback', '--port', String(port)],
      { cwd: worker.stateRoot, env: childEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let exitResolve;
    worker.exit = new Promise(ok => { exitResolve = ok; });
    const died = () => { worker.exited = true; worker.fault = true; exitResolve(); if (!worker.retiring) worker.current?.controller.abort(fail('PROCESS_FAILED')); };
    worker.child.once('close', died);
    worker.child.once('error', () => { if (!worker.retiring) worker.current?.controller.abort(fail('PROCESS_FAILED')); });
    let outputBytes = 0;
    for (const stream of [worker.child.stdout, worker.child.stderr]) stream.on('data', chunk => {
      outputBytes += chunk.length;
      // Child output can contain recalled text or keys. Consume and discard it.
      if (outputBytes > 1024 * 1024) worker.current?.controller.abort(fail('PROCESS_FAILED'));
    });
    let helloResolve;
    const hello = new Promise(ok => { helloResolve = ok; });
    const client = await createGatewayClient({ url: `ws://127.0.0.1:${port}`, token: controlToken,
      clientName: 'cli', mode: 'cli', scopes: ['operator.admin', 'operator.read', 'operator.write'],
      env: childEnv, deviceIdentity: null, hostDeps: { logDebug() {}, logError() {}, redactForLog: () => '[REDACTED]' },
      onHelloOk: () => { if (!worker.retiring) { worker.ready = true; helloResolve(); } }, onConnectError() {},
      onClose: () => {
        // A connection refused while the supervised child boots is retryable.
        // Losing an authenticated, ready worker is an uncertain execution.
        if (worker.ready) { worker.fault = true; if (!worker.retiring) worker.current?.controller.abort(fail('PROCESS_FAILED')); }
      } });
    if (worker.retiring || signal.aborted) {
      try { await bounded(client.stopAndWait({ timeoutMs: 1500 }), 1700, 'GATEWAY_STOP_TIMEOUT'); } catch {}
      throw fail('CANCELLED');
    }
    worker.client = client;
    worker.client.start();
    await bounded(Promise.race([hello, worker.exit.then(() => { throw fail('PROCESS_FAILED'); })]), startupTimeoutMs, 'GATEWAY_STARTUP_TIMEOUT', signal);
  }

  async function execute(worker, prepared) {
    if (worker.fault || worker.retiring) throw fail('PROCESS_FAILED');
    const shape = fingerprint(prepared.config);
    if (worker.shape && worker.shape !== shape) throw fail('GATEWAY_CONFIG_CHANGED');
    worker.shape = shape;
    if (!worker.client) await start(worker, prepared);
    worker.current.controller.signal.throwIfAborted();
    await patchCredential(worker, prepared.apiKey);
    worker.current.controller.signal.throwIfAborted();
    const current = worker.current;
    current.runId = randomUUID(); current.sessionId = randomUUID();
    current.sessionKey = `agent:main:explicit:${current.sessionId}`;
    const result = await request(worker, 'agent', { agentId: 'main', sessionId: current.sessionId,
      sessionKey: current.sessionKey, idempotencyKey: current.runId, message: prepared.message,
      promptMode: 'full', bootstrapContextMode: 'full', timeout: modelTimeoutSeconds },
    { expectFinal: true, timeoutMs, signal: current.controller.signal });
    if (!result || result.runId !== current.runId || result.status !== 'ok'
      || !result.result || result.result.meta?.aborted) throw fail('RESPONSE_FAILED');
    current.finalReceived = true;
    return result.result;
  }

  async function admitted(input, prepare) {
    if (closed) throw fail('CANCELLED');
    if (quiescing) throw fail('WARM_PAUSED');
    if (input.signal?.aborted) throw fail('CANCELLED');
    if (!input.inferenceGateway || !loopback(input.inferenceGateway.baseUrl)
      || typeof input.inferenceGateway.apiKey !== 'string' || !input.inferenceGateway.apiKey
      || typeof input.jobId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,119}$/.test(input.jobId)) throw fail('WARM_INFERENCE_REQUIRED');
    const ownerScope = scopeId(input.scope), stateRoot = resolve(input.stateRoot), workspace = resolve(input.workspace);
    await mkdir(stateRoot, { recursive: true, mode: 0o700 });
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    const canonicalRoot = await realpath(stateRoot), canonicalWorkspace = await realpath(workspace);
    const resourceKey = fingerprint([canonicalRoot, canonicalWorkspace]);
    const key = fingerprint([ownerScope, resourceKey, input.inferenceGateway.baseUrl, input.inferenceGateway.model]);
    const worker = await reserve(async () => {
    if (closed || input.signal?.aborted) throw fail('CANCELLED');
    if (quiescing) throw fail('WARM_PAUSED');
    for (const other of workers.values()) if (other.key !== key
      && [other.stateRoot, other.workspace].some(path => [canonicalRoot, canonicalWorkspace].some(next => overlap(path, next)))) {
      if (other.busy) throw fail('WARM_BUSY');
      await retire(other);
    }
    let worker = workers.get(key);
    if (worker?.fault && !worker.busy) { await retire(worker); worker = undefined; }
    if (worker?.busy || worker?.retiring) throw fail('WARM_BUSY');
    if (!worker && workers.size >= maxWorkers) {
      const oldest = [...workers.values()].filter(item => !item.busy && !item.retiring).sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (!oldest) throw fail('WARM_CAPACITY_REACHED');
      await retire(oldest);
    }
    // Recheck after retirement awaits so simultaneous admissions cannot exceed the cap.
    if (closed || input.signal?.aborted) throw fail('CANCELLED');
    if (quiescing) throw fail('WARM_PAUSED');
    worker = workers.get(key);
    if (worker?.busy || worker?.retiring) throw fail('WARM_BUSY');
    if (!worker && workers.size >= maxWorkers) throw fail('WARM_CAPACITY_REACHED');
    worker ??= { key, ownerScope, stateRoot: canonicalRoot, workspace: canonicalWorkspace,
      inactiveKey: `inactive-${randomBytes(32).toString('base64url')}`, lastUsed: Date.now() };
    clearTimeout(worker.idleTimer); worker.busy = true; workers.set(key, worker);
    return worker;
    });
    const controller = new AbortController();
    const current = { controller, jobId: input.jobId, finalReceived: false };
    worker.current = current;
    const abort = () => controller.abort(fail('CANCELLED'));
    input.signal?.addEventListener('abort', abort, { once: true });
    if (input.signal?.aborted) abort();
    const timer = setTimeout(() => controller.abort(fail('TIMEOUT')), timeoutMs);
    let result, error;
    const aborted = new Promise((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
      if (controller.signal.aborted) reject(controller.signal.reason);
    });
    worker.preparation = Promise.resolve().then(() => prepare(worker, controller.signal));
    try { result = await Promise.race([worker.preparation, aborted]); }
    catch (cause) { error = /^JEFF_OPENCLAW_[A-Z_]+$/.test(cause?.message) ? cause : fail('PROCESS_FAILED'); }
    finally {
      clearTimeout(timer);
      // Host revocation starts before child abort/retirement or any credential replacement.
      let settlement;
      try { settlement = bounded(settleInference(input.jobId), cleanupTimeoutMs, 'INFERENCE_SETTLEMENT_FAILED'); }
      catch { settlement = Promise.reject(fail('INFERENCE_SETTLEMENT_FAILED')); }
      const clean = (async () => {
        if (error || closed || controller.signal.aborted) await retire(worker);
        else { await patchCredential(worker, worker.inactiveKey); }
      })();
      const outcomes = await Promise.allSettled([settlement, clean]);
      if (outcomes.some(item => item.status === 'rejected')) {
        try { await retire(worker); } catch {}
        error ??= fail('INFERENCE_SETTLEMENT_FAILED');
      }
      if (controller.signal.aborted || closed) {
        error ??= controller.signal.reason ?? fail('CANCELLED');
        try { await retire(worker); } catch { error = fail('GATEWAY_STOP_TIMEOUT'); }
      }
      input.signal?.removeEventListener('abort', abort);
      worker.current = null; worker.busy = false; worker.lastUsed = Date.now();
      if (!worker.retiring && !closed) {
        worker.idleTimer = setTimeout(() => { void retire(worker).catch(() => {}); }, idleMs);
        worker.idleTimer.unref?.();
      }
    }
    if (error) throw error;
    return result;
  }

  return Object.freeze({
    execute,
    run(input, prepare) {
      const pending = admitted(input, prepare); active.add(pending);
      pending.then(() => active.delete(pending), () => active.delete(pending));
      return pending;
    },
    async retireScope(scope) {
      const ownerScope = scopeId(scope), matching = [...workers.values()].filter(worker => worker.ownerScope === ownerScope);
      for (const worker of matching) worker.current?.controller.abort(fail('CANCELLED'));
      await Promise.all(matching.map(retire));
    },
    // The host must already block admission for the full maintenance capture.
    // No persistent child may be alive when it asserts writersQuiesced.
    drainIdle() {
      if (drainPromise) return drainPromise;
      quiescing = true;
      drainPromise = (async () => {
        try {
          await Promise.allSettled([...active]);
          await reserve(() => Promise.all([...workers.values()].map(retire)));
        } finally { quiescing = false; drainPromise = null; }
      })();
      return drainPromise;
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      for (const worker of workers.values()) worker.current?.controller.abort(fail('CANCELLED'));
      closePromise = (async () => {
        await Promise.allSettled([...active]);
        await Promise.all([...workers.values()].map(retire));
      })();
      return closePromise;
    },
  });
}
