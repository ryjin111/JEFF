import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { normalizeScope, scopeId, scopeDirectory } from './scope.mjs';

const SCHEMA = 'jeff-schedule-v1';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const WEEK = 7 * 24 * 60 * 60 * 1000;
const MAX_SCHEDULES = 1024;
const MAX_SCHEDULES_PER_SCOPE = 16;
const MAX_PER_TICK = 16;
const fail = code => new Error(`JEFF_SCHEDULE_${code}`);
const date = value => {
  const parsed = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(parsed)) throw fail('CLOCK_INVALID');
  return parsed;
};

// One service writer per volume. The queue serializes all index and record writes.
// A persisted claim is never automatically replayed, including after a crash.
export function createScheduler({ dataRoot, resolveOwner, execute, isPaused = async () => false,
  canRun = () => true, track = promise => promise, now = () => Date.now(), pollMs = 10000 } = {}) {
  if (!dataRoot || typeof resolveOwner !== 'function' || typeof execute !== 'function'
    || typeof isPaused !== 'function' || typeof canRun !== 'function' || typeof track !== 'function' || typeof now !== 'function'
    || !Number.isSafeInteger(pollMs) || pollMs < 10) throw fail('CONFIG_INVALID');
  const indexPath = resolve(dataRoot, '.schedules', 'index.json');
  let queue = Promise.resolve(), tickQueue = Promise.resolve(), timer = null, running = false, stopping = false;
  let ticking = false, activeExecutions = 0, lastTickAt = null, lastError = null;
  const serial = operation => {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  };
  const timestamp = () => date(now());
  const iso = () => new Date(timestamp()).toISOString();
  async function atomic(path, value) {
    const directory = resolve(path, '..');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  }
  async function index() {
    let value;
    try { value = JSON.parse(await readFile(indexPath, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return []; throw fail('STORE_INVALID'); }
    if (value?.schema !== 'jeff-schedule-index-v1' || !Array.isArray(value.entries)
      || value.entries.length > MAX_SCHEDULES) throw fail('STORE_INVALID');
    const seen = new Set();
    for (const entry of value.entries) {
      if (!UUID.test(entry?.id ?? '') || seen.has(entry.id)) throw fail('STORE_INVALID');
      normalizeScope(entry.scope); seen.add(entry.id);
    }
    return value.entries;
  }
  const recordPath = (scope, id) => resolve(scopeDirectory(dataRoot, scope), 'schedules', `${id}.json`);
  async function read(entry, allowMissing = false) {
    let value;
    try { value = JSON.parse(await readFile(recordPath(entry.scope, entry.id), 'utf8')); }
    catch (error) { if (allowMissing && error.code === 'ENOENT') return null; throw fail('STORE_INVALID'); }
    if (value?.schema !== SCHEMA || value.id !== entry.id || scopeId(value.scope) !== scopeId(entry.scope)
      || typeof value.objective !== 'string' || !value.objective.trim() || value.objective.length > 4000
      || typeof value.conversationId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.conversationId)
      || !Number.isSafeInteger(value.intervalMinutes) || value.intervalMinutes < 1 || value.intervalMinutes > 10080
      || !Number.isSafeInteger(value.maxRuns) || value.maxRuns < 1 || value.maxRuns > 24
      || !Array.isArray(value.runs) || value.runs.length > value.maxRuns
      || !['active', 'completed', 'cancelled', 'revoked', 'expired', 'interrupted', 'failed'].includes(value.status)
      || date(value.expiresAt) <= date(value.createdAt) || date(value.expiresAt) - date(value.createdAt) > WEEK) {
      throw fail('STORE_INVALID');
    }
    date(value.nextRunAt);
    for (let i = 0; i < value.runs.length; i++) {
      const run = value.runs[i];
      if (run.index !== i + 1 || run.occurrenceId !== `${value.id}:${i + 1}`
        || !['claimed', 'completed', 'failed', 'interrupted'].includes(run.status)) throw fail('STORE_INVALID');
      date(run.claimedAt);
    }
    return value;
  }
  const save = record => atomic(recordPath(record.scope, record.id), record);
  // The index contains only live grants and unfinished claims. Terminal receipts
  // remain in the scope directory for list/cancel, but cannot exhaust live capacity.
  // Commit each terminal status before removing its entry so restart is fail-closed.
  async function compact(entries) {
    entries ??= await index();
    const live = [];
    for (const entry of entries) {
      const record = await read(entry), claimed = record.runs.some(run => run.status === 'claimed');
      if (record.status === 'active' && !claimed) {
        if (timestamp() >= date(record.expiresAt)) { record.status = 'expired'; await save(record); }
        else if (record.runs.length >= record.maxRuns) { record.status = 'completed'; await save(record); }
      }
      if (record.status === 'active' || claimed) live.push(entry);
    }
    if (live.length !== entries.length) await atomic(indexPath, { schema: 'jeff-schedule-index-v1', entries: live });
    return live;
  }
  const update = (entry, operation) => serial(async () => {
    const record = await read(entry);
    await operation(record);
    await save(record);
    return record;
  });
  async function owns(scope) {
    let owner;
    try { owner = await resolveOwner(scope); }
    catch (error) {
      if (['JEFF_OPENCLAW_OWNER_REVOKED', 'JEFF_OPENCLAW_ACCOUNT_DENIED', 'JEFF_OWNER_REQUIRED'].includes(error?.message)) return false;
      throw error;
    }
    if (scope.kind === 'account') return owner === true || owner?.owner?.toLowerCase() === scope.owner;
    return owner?.owner?.toLowerCase() === scope.owner && owner.ownerEpoch === scope.ownerEpoch;
  }
  async function allowed(scope) {
    if (stopping || await canRun() !== true) return false;
    return await isPaused(scope) !== true;
  }
  async function revoke(record) {
    record.status = 'revoked'; record.revokedAt = iso(); await save(record);
  }
  async function interrupted(record, reason) {
    for (const run of record.runs) if (run.status === 'claimed') {
      run.status = 'interrupted'; run.finishedAt = iso(); run.error = reason;
    }
    if (record.status === 'active') record.status = 'interrupted';
    await save(record);
  }
  async function expire(record) {
    for (const run of record.runs) if (run.status === 'claimed') {
      run.status = 'interrupted'; run.finishedAt = iso(); run.error = 'JEFF_SCHEDULE_GRANT_EXPIRED';
    }
    // Cancellation may have committed while an ownership or pause check waited.
    if (record.status === 'active') record.status = 'expired';
    await save(record);
  }
  async function performTick() {
    ticking = true; lastTickAt = iso(); lastError = null;
    try {
      // Maintenance blocks even recovery writes so volume snapshots remain stable.
      if (stopping || await canRun() !== true) return;
      const entries = await serial(index);
      let admitted = 0;
      for (const entry of entries) {
        if (stopping || await canRun() !== true) break;
        let record = await serial(() => read(entry));
        if (record.runs.some(run => run.status === 'claimed')) {
          await serial(async () => interrupted(await read(entry), 'JEFF_SCHEDULE_PROCESS_RESTARTED'));
          continue;
        }
        if (record.status !== 'active') continue;
        if (timestamp() >= date(record.expiresAt)) {
          await update(entry, current => { if (current.status === 'active') current.status = 'expired'; });
          continue;
        }
        if (record.runs.length >= record.maxRuns) {
          await update(entry, current => { if (current.status === 'active') current.status = 'completed'; });
          continue;
        }
        if (timestamp() < date(record.nextRunAt) || admitted >= MAX_PER_TICK) continue;
        if (!await owns(record.scope)) { await serial(async () => revoke(await read(entry))); continue; }
        if (!await allowed(record.scope)) continue;
        record = await serial(async () => {
          const current = await read(entry);
          if (current.status !== 'active' || current.runs.some(run => run.status === 'claimed')) return null;
          // Recheck after a slow ownership read or queue wait, before the claim.
          if (timestamp() >= date(current.expiresAt)) { await expire(current); return null; }
          if (current.runs.length >= current.maxRuns) { current.status = 'completed'; await save(current); return null; }
          if (timestamp() < date(current.nextRunAt)) return null;
          current.runs.push({ index: current.runs.length + 1, occurrenceId: `${current.id}:${current.runs.length + 1}`,
            status: 'claimed', claimedAt: iso(), finishedAt: null, jobId: null, error: null });
          // Persist before execution. A process failure after this write requires review.
          await save(current);
          return current;
        });
        if (!record) continue;
        const runIndex = record.runs.length, occurrenceId = record.runs[runIndex - 1].occurrenceId;
        admitted++;
        if (!await owns(record.scope)) {
          await serial(async () => {
            const current = await read(entry), run = current.runs[runIndex - 1];
            run.status = 'interrupted'; run.finishedAt = iso(); run.error = 'JEFF_SCHEDULE_OWNER_REVOKED';
            await revoke(current);
          });
          continue;
        }
        if (!await allowed(record.scope)) {
          await serial(async () => interrupted(await read(entry), 'JEFF_SCHEDULE_ADMISSION_STOPPED'));
          continue;
        }
        // Cancellation can commit while the final pause check waits. Read the
        // grant after that check, in the same queue as cancellation writes.
        const execution = await serial(async () => {
          const current = await read(entry), canAdmit = await canRun();
          if (timestamp() >= date(current.expiresAt)) { await expire(current); return null; }
          if (stopping || canAdmit !== true || current.status !== 'active') {
            await interrupted(current, 'JEFF_SCHEDULE_ADMISSION_STOPPED');
            return null;
          }
          // Start inside the cancellation queue, but never hold it for the run.
          // No await belongs between the final grant checks and this admission.
          activeExecutions++;
          let result;
          try {
            result = Promise.resolve(execute(current.scope, { objective: current.objective,
              conversationId: current.conversationId, occurrenceId, source: 'schedule' }));
          } catch (error) { result = Promise.reject(error); }
          return { result };
        });
        if (!execution) continue;
        try {
          const result = await execution.result;
          if (!result || typeof result.id !== 'string' || !UUID.test(result.id)
            || !['completed', 'failed', 'cancelled', 'interrupted'].includes(result.status)) throw fail('RESULT_INVALID');
          await update(entry, current => {
            const run = current.runs[runIndex - 1];
            run.jobId = result.id; run.finishedAt = iso();
            run.status = result.status === 'completed' ? 'completed' : result.status === 'interrupted' ? 'interrupted' : 'failed';
            if (run.status !== 'completed') {
              run.error = `JEFF_SCHEDULE_JOB_${result.status.toUpperCase()}`;
              if (current.status === 'active') current.status = run.status;
            } else if (current.status === 'active') {
              current.nextRunAt = new Date(timestamp() + current.intervalMinutes * 60000).toISOString();
              if (current.runs.length >= current.maxRuns) current.status = 'completed';
            }
          });
        } catch {
          // An exception after admission has an unknown outcome. Never retry it.
          await serial(async () => interrupted(await read(entry), 'JEFF_SCHEDULE_EXECUTION_UNKNOWN'));
        } finally { activeExecutions--; }
      }
      await serial(() => compact());
    } catch (error) {
      lastError = /^JEFF_SCHEDULE_[A-Z_]+$/.test(error?.message) ? error.message : 'JEFF_SCHEDULE_UNAVAILABLE';
      throw new Error(lastError);
    } finally { ticking = false; }
  }
  const scheduler = {
    async list(input) {
      const scope = normalizeScope(input);
      return serial(async () => {
        if (!await owns(scope)) throw fail('OWNER_REVOKED');
        const records = [];
        let names;
        try { names = await readdir(resolve(scopeDirectory(dataRoot, scope), 'schedules')); }
        catch (error) { if (error.code === 'ENOENT') names = []; else throw fail('STORE_INVALID'); }
        const ids = new Set(names.filter(name => name.endsWith('.json') && UUID.test(name.slice(0, -5))).map(name => name.slice(0, -5)));
        // An indexed live receipt must exist even if its whole directory vanished.
        const liveIds = new Set((await index()).filter(entry => scopeId(entry.scope) === scopeId(scope)).map(entry => entry.id));
        for (const id of liveIds) if (!ids.has(id)) throw fail('STORE_INVALID');
        for (const id of ids) {
          const record = await read({ id, scope });
          if ((record.status === 'active' || record.runs.some(run => run.status === 'claimed')) && !liveIds.has(id)) throw fail('STORE_INVALID');
          records.push(record);
        }
        if (!await owns(scope)) throw fail('OWNER_REVOKED');
        return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      });
    },
    async create(input, options = {}) {
      const scope = normalizeScope(input);
      return serial(async () => {
        if (!await owns(scope)) throw fail('OWNER_REVOKED');
        if (await canRun() !== true || stopping) throw fail('MAINTENANCE');
        const { objective, conversationId, intervalMinutes, maxRuns = 24 } = options;
        if (typeof objective !== 'string' || !objective.trim() || objective.length > 4000
          || typeof conversationId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(conversationId)
          || !Number.isSafeInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 10080
          || !Number.isSafeInteger(maxRuns) || maxRuns < 1 || maxRuns > 24) throw fail('INVALID');
        const created = timestamp(), expires = options.expiresAt === undefined ? created + WEEK : date(options.expiresAt);
        if (expires <= created || expires - created > WEEK || created + intervalMinutes * 60000 >= expires) throw fail('INVALID');
        const entries = await compact();
        if (entries.length >= MAX_SCHEDULES
          || entries.filter(entry => scopeId(entry.scope) === scopeId(scope)).length >= MAX_SCHEDULES_PER_SCOPE) throw fail('LIMIT_REACHED');
        const record = { schema: SCHEMA, id: randomUUID(), scope, objective: objective.trim(), conversationId,
          intervalMinutes, maxRuns, createdAt: new Date(created).toISOString(), expiresAt: new Date(expires).toISOString(),
          nextRunAt: new Date(created + intervalMinutes * 60000).toISOString(), status: 'active', runs: [] };
        if (!await owns(scope)) throw fail('OWNER_REVOKED');
        await save(record);
        entries.push({ id: record.id, scope });
        await atomic(indexPath, { schema: 'jeff-schedule-index-v1', entries });
        return structuredClone(record);
      });
    },
    async cancel(input, id) {
      const scope = normalizeScope(input);
      if (!UUID.test(id ?? '')) throw fail('INVALID');
      return serial(async () => {
        if (!await owns(scope)) throw fail('OWNER_REVOKED');
        if (await canRun() !== true) throw fail('MAINTENANCE');
        const entries = await index();
        const entry = entries.find(value => value.id === id && scopeId(value.scope) === scopeId(scope));
        const record = await read(entry ?? { id, scope }, !entry);
        if (!record) throw fail('NOT_FOUND');
        if (record.status === 'active') { record.status = 'cancelled'; record.cancelledAt = iso(); await save(record); }
        await compact(entries);
        return record;
      });
    },
    tick() {
      const result = tickQueue.then(performTick);
      tickQueue = result.catch(() => {});
      return track(result, 'scheduler:tick');
    },
    start() {
      if (running) return scheduler.status();
      stopping = false; running = true;
      scheduler.tick().catch(() => {});
      timer = setInterval(() => { if (!ticking) scheduler.tick().catch(() => {}); }, pollMs);
      timer.unref?.();
      return scheduler.status();
    },
    async stop() {
      stopping = true; running = false; clearInterval(timer); timer = null;
      await tickQueue;
      await queue;
      return scheduler.status();
    },
    status() { return { running, ticking, activeExecutions, lastTickAt, lastError,
      maximumSchedules: MAX_SCHEDULES, maximumSchedulesPerScope: MAX_SCHEDULES_PER_SCOPE }; },
  };
  return Object.freeze(scheduler);
}
