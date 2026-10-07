import { createHash } from 'node:crypto';
import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { normalizeJeffOpenClawScope, normalizeJeffOpenClawAccountScope } from 'jeff-agent-nft/openclaw';

const sha = value => createHash('sha256').update(value).digest('hex');

// Internal drain observation only. HTTP access still uses the authorized bridge.
export function createDurableJobReader({ dataRoot, scope, id }) {
  const normalize = scope?.kind === 'account' ? normalizeJeffOpenClawAccountScope : normalizeJeffOpenClawScope;
  const scopeHash = sha(JSON.stringify(normalize(scope)));
  if (!/^[a-f0-9-]{36}$/.test(id || '')) throw new Error('JEFF_MAINTENANCE_JOB_UNSAFE');
  const path = resolve(dataRoot, scopeHash, 'results', `${id}.json`);
  return async () => {
    const record = JSON.parse(await readFile(path, 'utf8'));
    if (record.schema !== 'jeff-openclaw-job-v1' || record.id !== id || record.saved !== true
      || sha(JSON.stringify(normalize(record.scope))) !== scopeHash
      || !['running', 'completed', 'failed'].includes(record.status)
      || (record.status === 'completed' && (typeof record.text !== 'string' || !record.text.trim()
        || record.text.length > 65536 || sha(record.text) !== record.textSha256))) {
      throw new Error('JEFF_MAINTENANCE_JOB_UNSAFE');
    }
    return record;
  };
}

export async function waitForDurableJob({ bridge, scope, id, readRecord, pollMs = 100, timeoutMs = 180000 }) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const record = readRecord ? await readRecord() : await bridge.retrieve(scope, id);
    if (record.saved === true && ['completed', 'failed'].includes(record.status)) return record;
    // The bridge exposes completed_unsaved while an atomic save is still in
    // progress. It must become durable before this task can drain successfully.
    if (!['running', 'completed_unsaved'].includes(record.status)) throw new Error('JEFF_MAINTENANCE_JOB_UNSAFE');
    if (Date.now() >= deadline) throw new Error(record.status === 'running' ? 'JEFF_MAINTENANCE_JOB_TIMEOUT' : 'JEFF_MAINTENANCE_JOB_UNSAFE');
    await delay(pollMs);
  }
}

// Every durable writer must belong to an admitted request or a tracked task.
export function createMaintenanceGate({ markerPath = '/tmp/simple-jeff-maintenance.json', releaseSha = null, pid = process.pid } = {}) {
  let blocked = true, phase = 'starting', generation = 0, activeRequests = 0, taskSequence = 0;
  let pausePromise = null, markerQueue = Promise.resolve();
  const tasks = new Set(), failures = new Map(), listeners = new Set();
  const changed = () => { for (const listener of listeners) listener(); listeners.clear(); };
  const status = () => ({ blocked, phase, activeRequests, pendingTasks: tasks.size, failures: [...failures.keys()] });
  function markerOperation(operation) {
    const result = markerQueue.then(operation);
    markerQueue = result.catch(() => {});
    return result;
  }
  function beginRequest() {
    if (blocked) return null;
    activeRequests++;
    let finished = false;
    return () => { if (!finished) { finished = true; activeRequests--; changed(); } };
  }
  function track(promise, label = `background:${++taskSequence}`) {
    const entry = {};
    tasks.add(entry); changed();
    const tracked = Promise.resolve(promise).then(value => {
      tasks.delete(entry); failures.delete(label); changed(); return value;
    }, error => {
      tasks.delete(entry); failures.set(label, error); changed(); throw error;
    });
    // Tracking must remain effective even when the HTTP caller already returned.
    tracked.catch(() => {});
    return tracked;
  }
  function pause() {
    if (['pausing', 'paused'].includes(phase)) return pausePromise;
    blocked = true; phase = 'pausing';
    const token = ++generation;
    changed();
    pausePromise = (async () => {
      await markerOperation(() => rm(markerPath, { force: true }));
      while (token === generation && (activeRequests || tasks.size)) {
        await new Promise(resolveChanged => listeners.add(resolveChanged));
      }
      if (token !== generation) return null;
      if (failures.size) throw new Error('JEFF_MAINTENANCE_TASK_UNSAFE');
      const marker = { schema: 'simple-jeff-maintenance-v1', status: 'ready', pid, releaseSha,
        readyAt: new Date().toISOString(), activeRequests, pendingTasks: tasks.size };
      await markerOperation(async () => {
        if (token !== generation) return;
        const temporary = `${markerPath}.${pid}.${token}.tmp`;
        try {
          await writeFile(temporary, JSON.stringify(marker), { mode: 0o600, flag: 'wx' });
          if (token === generation) await rename(temporary, markerPath);
        } finally { await rm(temporary, { force: true }); }
      });
      if (token !== generation) return null;
      phase = 'paused';
      return marker;
    })().catch(error => {
      if (token === generation) phase = 'paused';
      throw error;
    });
    pausePromise.catch(() => {});
    return pausePromise;
  }
  async function resume() {
    blocked = true; phase = 'resuming';
    const token = ++generation;
    changed();
    // Remove the ready marker before any new request may write again.
    await markerOperation(() => rm(markerPath, { force: true }));
    if (token === generation) { blocked = false; phase = 'running'; pausePromise = null; changed(); }
    return status();
  }
  return Object.freeze({ beginRequest, track, pause, resume, status });
}
