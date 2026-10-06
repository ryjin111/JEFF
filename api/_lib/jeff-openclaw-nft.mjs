import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
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

// Callers establish the wallet session separately. The resolver must read trusted
// chain state, including an epoch that changes on every transfer (also A -> B -> A).
export function createJeffOpenClawNftBridge({ dataRoot, resolveOwner, runAgent, now = () => new Date().toISOString() }) {
  if (!dataRoot || typeof resolveOwner !== 'function' || typeof runAgent !== 'function') {
    throw new Error('JEFF_OPENCLAW_CONFIG_INVALID');
  }
  const busy = new Set();
  async function authorize(input) {
    const scope = normalizeJeffOpenClawScope(input);
    const current = await resolveOwner(scope);
    if (current?.owner?.toLowerCase() !== scope.owner || current.ownerEpoch !== scope.ownerEpoch) {
      throw new Error('JEFF_OPENCLAW_OWNER_REVOKED');
    }
    return scope;
  }
  const paths = scope => {
    const id = jeffOpenClawWorkspaceId(scope);
    const root = resolve(dataRoot, id);
    return { id, root, workspace: resolve(root, 'workspace'), results: resolve(root, 'results') };
  };
  async function save(directory, result) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = resolve(directory, `${result.id}.json`);
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(result, null, 2), { mode: 0o600 });
    await rename(temporary, file);
  }
  return Object.freeze({
    async run(input, objective) {
      const scope = await authorize(input);
      if (typeof objective !== 'string' || !objective.trim() || objective.length > 4000) {
        throw new Error('JEFF_OPENCLAW_OBJECTIVE_INVALID');
      }
      const location = paths(scope);
      if (busy.has(location.id)) throw new Error('JEFF_OPENCLAW_BUSY');
      busy.add(location.id);
      const record = { schema: 'jeff-openclaw-job-v1', id: randomUUID(), scope,
        objective, status: 'running', startedAt: now(), runtime: 'openclaw',
        externalActionsAuthorized: false };
      try {
        await save(location.results, record);
        const response = await runAgent({ scope, objective, workspace: location.workspace, stateRoot: location.root, jobId: record.id });
        await authorize(scope);
        if (typeof response?.text !== 'string' || !response.text.trim() || response.text.length > 65536) {
          throw new Error('JEFF_OPENCLAW_RESULT_INVALID');
        }
        const result = { ...record, status: 'completed', finishedAt: now(), text: response.text,
          textSha256: hash(response.text), model: response.model ?? null };
        await save(location.results, result);
        return result;
      } catch (error) {
        await save(location.results, { ...record, status: 'failed', finishedAt: now(), error: 'JEFF_OPENCLAW_JOB_FAILED' });
        throw error;
      } finally { busy.delete(location.id); }
    },
    async retrieve(input, id) {
      const scope = await authorize(input);
      if (!jobId.test(id ?? '')) throw new Error('JEFF_OPENCLAW_JOB_ID_INVALID');
      let result;
      try { result = JSON.parse(await readFile(resolve(paths(scope).results, `${id}.json`), 'utf8')); }
      catch { throw new Error('JEFF_OPENCLAW_RESULT_NOT_FOUND'); }
      if (jeffOpenClawWorkspaceId(result.scope) !== jeffOpenClawWorkspaceId(scope)
        || result.id !== id || result.schema !== 'jeff-openclaw-job-v1'
        || (result.status === 'completed' && hash(result.text) !== result.textSha256)) {
        throw new Error('JEFF_OPENCLAW_RESULT_INVALID');
      }
      await authorize(scope);
      return result;
    },
  });
}
