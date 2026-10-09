import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_BODY_BYTES = 65536;
const HISTORY_LIMIT = 288;

function requireUrl(value, originOnly = false) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash ||
      (originOnly && (url.pathname !== '/' || url.search))) throw new Error('JEFF_MONITOR_CONFIG_INVALID');
  return url;
}

export function validateMonitorConfig(input) {
  const origin = requireUrl(input.origin, true).origin;
  const rpcUrl = requireUrl(input.rpcUrl).href;
  if (!Number.isSafeInteger(input.chainId) || input.chainId < 1 ||
      !/^0x[0-9a-f]{40}$/i.test(input.collection) ||
      (input.expectedReleaseSha != null && !/^[0-9a-f]{40}$/.test(input.expectedReleaseSha)) ||
      !Number.isInteger(input.timeoutMs ?? 8000) || (input.timeoutMs ?? 8000) < 100 || (input.timeoutMs ?? 8000) > 15000) {
    throw new Error('JEFF_MONITOR_CONFIG_INVALID');
  }
  return { origin, rpcUrl, chainId: input.chainId, collection: input.collection.toLowerCase(),
    expectedReleaseSha: input.expectedReleaseSha ?? null, timeoutMs: input.timeoutMs ?? 8000 };
}

async function boundedJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('INVALID_JSON');
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) throw new Error('BODY_TOO_LARGE');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); }
}

export async function runMonitorProbe(input, { fetchImpl = fetch, now = () => new Date() } = {}) {
  const config = validateMonitorConfig(input);
  async function check(name, url, validate, request = {}) {
    const started = performance.now(); let httpStatus = null;
    try {
      const response = await fetchImpl(url, { redirect: 'error', credentials: 'omit',
        signal: AbortSignal.timeout(config.timeoutMs), headers: { 'Cache-Control': 'no-cache',
          ...(request.body ? { 'Content-Type': 'application/json' } : {}) }, ...request });
      httpStatus = response.status;
      if (!response.ok) { await response.body?.cancel(); throw new Error('HTTP_ERROR'); }
      const detail = validate(await boundedJson(response));
      return { name, ok: true, httpStatus, durationMs: Math.round(performance.now() - started), ...detail };
    } catch (error) {
      const reason = ['HTTP_ERROR', 'BODY_TOO_LARGE', 'INVALID_JSON', 'HEALTH_NOT_READY', 'CONFIG_MISMATCH',
        'RESTORE_GUARDED', 'RPC_INVALID', 'RPC_ERROR', 'CHAIN_MISMATCH'].includes(error.message) ? error.message :
        error.name === 'TimeoutError' || error.name === 'AbortError' ? 'TIMEOUT' : 'TRANSPORT_OR_RESPONSE_ERROR';
      return { name, ok: false, httpStatus, durationMs: Math.round(performance.now() - started), reason };
    }
  }
  const checks = await Promise.all([
    check('public-health', `${config.origin}/health`, value => {
      if (value.status !== 'ready' || value.runtime !== 'openclaw') throw new Error('HEALTH_NOT_READY');
      return {};
    }),
    check('public-config', `${config.origin}/api/config`, value => {
      if (value.product !== 'JEFF' || value.fixture !== false || value.chainId !== config.chainId ||
          typeof value.collection !== 'string' || value.collection.toLowerCase() !== config.collection ||
          value.continuousHosting !== true || value.modelConfigured !== true || value.toolsEnabled !== false ||
          (config.expectedReleaseSha && value.releaseSha !== config.expectedReleaseSha)) throw new Error('CONFIG_MISMATCH');
      if (value.restoreBlocked) throw new Error('RESTORE_GUARDED');
      return { releaseSha: /^[0-9a-f]{40}$/.test(value.releaseSha) ? value.releaseSha : null };
    }),
    check('public-rpc', config.rpcUrl, value => {
      if (!Array.isArray(value) || value.length !== 2) throw new Error('RPC_INVALID');
      const chain = value.find(item => item.id === 1), block = value.find(item => item.id === 2);
      if (!chain || !block || value.some(item => item.jsonrpc !== '2.0')) throw new Error('RPC_INVALID');
      if (chain.error || block.error) throw new Error('RPC_ERROR');
      if (!/^0x[0-9a-f]+$/i.test(chain.result) || !/^0x[0-9a-f]+$/i.test(block.result)) throw new Error('RPC_INVALID');
      if (BigInt(chain.result) !== BigInt(config.chainId)) throw new Error('CHAIN_MISMATCH');
      return { chainId: config.chainId, blockNumber: BigInt(block.result).toString() };
    }, { method: 'POST', body: JSON.stringify([
      { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] },
      { jsonrpc: '2.0', id: 2, method: 'eth_blockNumber', params: [] },
    ]) }),
  ]);
  return { version: 1, observedAt: now().toISOString(), origin: config.origin,
    rpcHost: new URL(config.rpcUrl).host, ok: checks.every(item => item.ok), checks,
    privateWorkspaceRead: false, holderSessionCreated: false, inferenceCalled: false,
    note: 'Public reachability sample; not an ownership, provider, capacity or SLA proof.' };
}

export function nextMonitorState(previous, observation, { threshold = 3 } = {}) {
  if (!Number.isSafeInteger(threshold) || threshold < 1) throw new Error('JEFF_MONITOR_CONFIG_INVALID');
  // Never carry an alert or history from an unrelated deployment origin/RPC host.
  const sameTarget = previous?.origin === observation.origin && previous?.rpcHost === observation.rpcHost;
  const prior = sameTarget ? previous : null;
  const consecutiveFailures = observation.ok ? 0 : Math.min((Number.isSafeInteger(prior?.consecutiveFailures) ? prior.consecutiveFailures : 0) + 1, 1000000);
  const alertActive = consecutiveFailures >= threshold;
  const history = Array.isArray(prior?.history) ? prior.history.slice(-(HISTORY_LIMIT - 1)) : [];
  history.push({ observedAt: observation.observedAt, ok: observation.ok,
    failedChecks: observation.checks.filter(item => !item.ok).map(item => ({ name: item.name, reason: item.reason })) });
  return { version: 1, origin: observation.origin, rpcHost: observation.rpcHost, observation,
    consecutiveFailures, alertActive, alertSince: alertActive ? prior?.alertSince ?? observation.observedAt : null,
    lastSuccessAt: observation.ok ? observation.observedAt : prior?.lastSuccessAt ?? null,
    history, alertDelivery: 'local-file-and-task-exit-code-only' };
}

async function main() {
  if (process.argv.length !== 4 || process.argv[2] !== '--config') throw new Error('JEFF_MONITOR_CONFIG_REQUIRED');
  const configFile = path.resolve(process.argv[3]);
  const input = JSON.parse((await readFile(configFile, 'utf8')).replace(/^\uFEFF/, ''));
  if (typeof input.reportFile !== 'string' || !path.isAbsolute(input.reportFile)) throw new Error('JEFF_MONITOR_CONFIG_INVALID');
  const reportFile = path.resolve(input.reportFile);
  let previous;
  try { previous = JSON.parse(await readFile(reportFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('JEFF_MONITOR_STATE_UNAVAILABLE'); }
  const observation = await runMonitorProbe(input);
  const state = nextMonitorState(previous, observation);
  await mkdir(path.dirname(reportFile), { recursive: true });
  const temporary = `${reportFile}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, reportFile);
  process.stdout.write(`${JSON.stringify({ observedAt: observation.observedAt, ok: observation.ok,
    alertActive: state.alertActive, failedChecks: observation.checks.filter(item => !item.ok).map(item => item.name) })}\n`);
  if (!observation.ok) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => { process.stderr.write('JEFF_MONITOR_FAILED\n'); process.exitCode = 2; });
}
