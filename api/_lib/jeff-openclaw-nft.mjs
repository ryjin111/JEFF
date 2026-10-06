import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const address = /^0x[a-f0-9]{40}$/;
const jobId = /^[a-f0-9-]{36}$/;
const hash = value => createHash('sha256').update(value).digest('hex');

export function normalizeJeffOpenClawScope(input) {
  if (!input || !Number.isSafeInteger(input.chainId) || input.chainId < 1
    || !address.test(String(input.collection).toLowerCase())
    || !address.test(String(input.owner).toLowerCase())
    || typeof input.tokenId !== 'string' || !/^(0|[1-9]\d*)$/.test(input.tokenId)
    || BigInt(input.tokenId) >= 2n ** 256n
    || !Number.isSafeInteger(input.ownerEpoch) || input.ownerEpoch < 0) {
    throw new Error('JEFF_OPENCLAW_SCOPE_INVALID');
  }
  return Object.freeze({ chainId: input.chainId, collection: input.collection.toLowerCase(),
    tokenId: input.tokenId, owner: input.owner.toLowerCase(), ownerEpoch: input.ownerEpoch });
}

export function jeffOpenClawWorkspaceId(scope) {
  return hash(JSON.stringify(normalizeJeffOpenClawScope(scope)));
}

export function normalizeJeffOpenClawAccountScope(input) {
  if (input?.kind !== 'account' || !Number.isSafeInteger(input.chainId) || input.chainId < 1
    || !address.test(String(input.owner).toLowerCase())) throw new Error('JEFF_OPENCLAW_SCOPE_INVALID');
  return Object.freeze({ kind: 'account', chainId: input.chainId, owner: input.owner.toLowerCase() });
}

// Account registration and session authentication belong to the host. The
// callback must confirm a registered account; this scope makes no NFT claim.
export function createJeffOpenClawAccountBridge({ resolveAccount, ...options } = {}) {
  if (typeof resolveAccount !== 'function') throw new Error('JEFF_OPENCLAW_CONFIG_INVALID');
  return createScopedBridge({ ...options, normalizeScope: normalizeJeffOpenClawAccountScope,
    authorizeScope: async scope => {
      if (await resolveAccount(scope) !== true) throw new Error('JEFF_OPENCLAW_ACCOUNT_DENIED');
    } });
}

// Callers establish the wallet session separately. The resolver must read trusted
// chain state, including an epoch that changes on every transfer (also A -> B -> A).
export function createJeffOpenClawNftBridge({ resolveOwner, ...options } = {}) {
  if (typeof resolveOwner !== 'function') throw new Error('JEFF_OPENCLAW_CONFIG_INVALID');
  return createScopedBridge({ ...options, normalizeScope: normalizeJeffOpenClawScope,
    authorizeScope: async scope => {
      const current = await resolveOwner(scope);
      if (current?.owner?.toLowerCase() !== scope.owner || current.ownerEpoch !== scope.ownerEpoch) {
        throw new Error('JEFF_OPENCLAW_OWNER_REVOKED');
      }
    } });
}

function createScopedBridge({ dataRoot, normalizeScope, authorizeScope, runAgent, now = () => new Date().toISOString(), persistRecord }) {
  if (!dataRoot || typeof runAgent !== 'function') {
    throw new Error('JEFF_OPENCLAW_CONFIG_INVALID');
  }
  const busy = new Set();
  const pending = new Map();
  const completions = new Map();
  async function authorize(input) {
    const scope = normalizeScope(input);
    await authorizeScope(scope);
    return scope;
  }
  const paths = scope => {
    const id = workspaceId(scope);
    const root = resolve(dataRoot, id);
    return { id, root, workspace: resolve(root, 'workspace'), results: resolve(root, 'results') };
  };
  async function save(directory, result) {
    if (persistRecord) return persistRecord(directory, result);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = resolve(directory, `${result.id}.json`);
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(result, null, 2), { mode: 0o600 });
    await rename(temporary, file);
  }
  const workspaceId = scope => hash(JSON.stringify(normalizeScope(scope)));
  const keyFor = (scope, id) => `${workspaceId(scope)}:${id}`;
  async function execute(scope, objective, location, record) {
    const key = keyFor(scope, record.id);
    try {
      const response = await runAgent({ scope, objective, workspace: location.workspace, stateRoot: location.root, jobId: record.id });
      await authorize(scope);
      if (typeof response?.text !== 'string' || !response.text.trim() || response.text.length > 65536) throw new Error('JEFF_OPENCLAW_RESULT_INVALID');
      const result = { ...record, status: 'completed', saved: true, finishedAt: now(), text: response.text,
        textSha256: hash(response.text), model: response.model ?? null };
      // Keep generated output until persistence succeeds. A save failure must
      // never become a model failure or cause the model to be run again.
      pending.set(key, { ...result, status: 'completed_unsaved', saved: false });
      try { await save(location.results, result); pending.delete(key); return result; }
      catch { return structuredClone(pending.get(key)); }
    } catch (error) {
      pending.delete(key);
      await save(location.results, { ...record, status: 'failed', saved: true, finishedAt: now(), error: 'JEFF_OPENCLAW_JOB_FAILED' }).catch(() => {});
      throw error;
    } finally { busy.delete(location.id); }
  }
  const bridge = {
    async start(input, objective) {
      const scope = await authorize(input);
      if (typeof objective !== 'string' || !objective.trim() || objective.length > 4000) {
        throw new Error('JEFF_OPENCLAW_OBJECTIVE_INVALID');
      }
      const location = paths(scope);
      if (busy.has(location.id)) throw new Error('JEFF_OPENCLAW_BUSY');
      busy.add(location.id);
      const record = { schema: 'jeff-openclaw-job-v1', id: randomUUID(), scope,
        objective, status: 'running', saved: true, startedAt: now(), runtime: 'openclaw',
        externalActionsAuthorized: false };
      try {
        await save(location.results, record);
      } catch (error) {
        busy.delete(location.id); throw error;
      }
      const completion = execute(scope, objective, location, record);
      const key = keyFor(scope, record.id);
      completions.set(key, completion);
      completion.catch(() => {}).finally(() => completions.delete(key));
      return record;
    },
    async run(input, objective) {
      const record = await bridge.start(input, objective);
      const completion = completions.get(keyFor(record.scope, record.id));
      return completion ? completion : bridge.retrieve(record.scope, record.id);
    },
    async retrieve(input, id) {
      const scope = await authorize(input);
      if (!jobId.test(id ?? '')) throw new Error('JEFF_OPENCLAW_JOB_ID_INVALID');
      let result;
      try { result = pending.get(keyFor(scope, id)) ?? JSON.parse(await readFile(resolve(paths(scope).results, `${id}.json`), 'utf8')); }
      catch { throw new Error('JEFF_OPENCLAW_RESULT_NOT_FOUND'); }
      if (workspaceId(result.scope) !== workspaceId(scope)
        || result.id !== id || result.schema !== 'jeff-openclaw-job-v1'
        || (['completed','completed_unsaved'].includes(result.status) && hash(result.text) !== result.textSha256)) {
        throw new Error('JEFF_OPENCLAW_RESULT_INVALID');
      }
      await authorize(scope);
      if (result.status === 'running' && !completions.has(keyFor(scope, id))) {
        return { ...result, status: 'interrupted', error: 'JEFF_OPENCLAW_PROCESS_RESTARTED' };
      }
      return structuredClone(result);
    },
    async list(input) {
      const scope = await authorize(input);
      let files;
      try { files = await readdir(paths(scope).results); }
      catch (error) { if (error.code === 'ENOENT') return []; throw error; }
      const records = [];
      for (const file of files.filter(file => /^[a-f0-9-]{36}\.json$/.test(file))) {
        records.push(await bridge.retrieve(scope, file.slice(0, -5)));
      }
      await authorize(scope);
      return records.sort((a,b) => b.startedAt.localeCompare(a.startedAt));
    },
    async retrySave(input, id) {
      const scope = await authorize(input);
      if (!jobId.test(id ?? '')) throw new Error('JEFF_OPENCLAW_JOB_ID_INVALID');
      const key = keyFor(scope, id);
      const result = pending.get(key);
      if (!result) return bridge.retrieve(scope, id);
      const saved = { ...result, status: 'completed', saved: true };
      await save(paths(scope).results, saved);
      await authorize(scope);
      pending.delete(key);
      return saved;
    },
  };
  return Object.freeze(bridge);
}
