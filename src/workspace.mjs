import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, lstat, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { normalizeScope, scopeId, scopeDirectory } from './scope.mjs';

const SCHEMA = 'jeff-workspace-v1';
const REGISTRY_SCHEMA = 'jeff-workspace-registry-v1';
const LIMITS = Object.freeze({ bytes: 8 * 1024 * 1024, memories: 32, conversations: 64, jobs: 1000, events: 200, contextMemory: 12000, contextJobs: 12, scopes: 10000 });
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ABSENT = Symbol('absent');
const SOURCES = ['manual', 'schedule'];
const SKILLS = Object.freeze([
  { id: 'writing', name: 'Writing', description: 'Draft and revise text from information you provide.', prompt: 'Produce clear, useful writing. Identify unsupported claims and preserve the requested tone.' },
  { id: 'analysis', name: 'Analysis', description: 'Compare options and reason about supplied information.', prompt: 'Separate evidence, assumptions, and uncertainty. Do not imply that external research or tool calls occurred.' },
  { id: 'planning', name: 'Planning', description: 'Turn a goal into practical steps and checkpoints.', prompt: 'Create actionable plans with dependencies and clear completion criteria. Do not claim to have executed the plan.' },
]);

const fail = code => { throw new Error(code); };
const invalid = () => fail('JEFF_WORKSPACE_INVALID');
const unavailable = () => fail('JEFF_WORKSPACE_STORAGE_UNAVAILABLE');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exact = (value, keys) => record(value) && Object.keys(value).every(key => keys.includes(key));
const all = (value, keys) => exact(value, keys) && keys.every(key => Object.hasOwn(value, key));
const text = (value, max, empty = false) => typeof value === 'string' && value.length <= max
  && (empty || Boolean(value.trim())) && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value);
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const id = value => typeof value === 'string' && UUID.test(value);
const clone = value => structuredClone(value);

export function createWorkspaceStore({ dataRoot, resolveOwner, allowedModels = ['bankr/gpt-5.4-mini'], now = () => Date.now() }) {
  if (!dataRoot || !Array.isArray(allowedModels) || !allowedModels.length || allowedModels.length > 32
    || new Set(allowedModels).size !== allowedModels.length
    || allowedModels.some(model => !/^bankr\/[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/.test(model))) invalid();
  const models = new Set(allowedModels);
  const registryFile = resolve(dataRoot, 'workspaces', 'registry.json');
  let queue = Promise.resolve();
  const serialize = operation => {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  };
  const time = () => {
    const value = now();
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) unavailable();
    return date.toISOString();
  };
  async function authorize(input) {
    const scope = normalizeScope(input);
    if (scope.kind !== 'account') {
      if (typeof resolveOwner !== 'function') fail('JEFF_OWNER_REQUIRED');
      const owner = await resolveOwner(scope);
      if (owner?.owner?.toLowerCase() !== scope.owner || owner.ownerEpoch !== scope.ownerEpoch) fail('JEFF_OWNER_REQUIRED');
    }
    return scope;
  }
  const stateFile = scope => resolve(scopeDirectory(dataRoot, scope), 'workspace-state.json');
  function initial(scope) {
    const at = time();
    return { schema: SCHEMA, scope, revision: 0, createdAt: at, updatedAt: at,
      settings: { name: scope.kind === 'account' ? 'My JEFF' : `Room #${scope.tokenId}`, model: allowedModels[0], dailyBudgetMicros: 1000000, paused: false },
      skills: SKILLS.map(skill => ({ ...skill, enabled: true })), memories: [], conversations: [], jobBindings: {}, activity: [] };
  }
  function validSettings(value) {
    return all(value, ['name', 'model', 'dailyBudgetMicros', 'paused']) && text(value.name, 80)
      && models.has(value.model) && Number.isSafeInteger(value.dailyBudgetMicros) && value.dailyBudgetMicros > 0
      && value.dailyBudgetMicros <= 1000000000 && typeof value.paused === 'boolean';
  }
  function validateState(state, scope) {
    if (!all(state, ['schema', 'scope', 'revision', 'createdAt', 'updatedAt', 'settings', 'skills', 'memories', 'conversations', 'jobBindings', 'activity'])
      || state.schema !== SCHEMA || JSON.stringify(state.scope) !== JSON.stringify(scope)
      || !Number.isSafeInteger(state.revision) || state.revision < 0 || !timestamp(state.createdAt) || !timestamp(state.updatedAt)
      || !validSettings(state.settings)) unavailable();
    if (!Array.isArray(state.skills) || state.skills.length !== SKILLS.length || state.skills.some((skill, i) =>
      !all(skill, ['id', 'name', 'description', 'prompt', 'enabled']) || typeof skill.enabled !== 'boolean'
      || ['id', 'name', 'description', 'prompt'].some(key => skill[key] !== SKILLS[i][key]))) unavailable();
    if (!Array.isArray(state.memories) || state.memories.length > LIMITS.memories || new Set(state.memories.map(item => item?.id)).size !== state.memories.length
      || state.memories.some(item => !all(item, ['id', 'title', 'text', 'createdAt', 'updatedAt']) || !id(item.id)
        || !text(item.title, 120) || !text(item.text, 4000) || !timestamp(item.createdAt) || !timestamp(item.updatedAt))) unavailable();
    if (!Array.isArray(state.conversations) || state.conversations.length > LIMITS.conversations
      || new Set(state.conversations.map(item => item?.id)).size !== state.conversations.length
      || state.conversations.some(item => !all(item, ['id', 'title', 'createdAt', 'updatedAt', 'jobIds']) || !id(item.id)
        || !text(item.title, 120) || !timestamp(item.createdAt) || !timestamp(item.updatedAt) || !Array.isArray(item.jobIds)
        || item.jobIds.length > LIMITS.jobs || item.jobIds.some(jobId => !id(jobId)) || new Set(item.jobIds).size !== item.jobIds.length)) unavailable();
    if (!record(state.jobBindings) || Object.keys(state.jobBindings).length > LIMITS.jobs) unavailable();
    const conversations = new Map(state.conversations.map(item => [item.id, item]));
    for (const [jobId, binding] of Object.entries(state.jobBindings)) {
      if (!id(jobId) || !all(binding, ['jobId', 'conversationId', 'objective', 'source', 'createdAt']) || binding.jobId !== jobId
        || !id(binding.conversationId) || !text(binding.objective, 4000) || !SOURCES.includes(binding.source) || !timestamp(binding.createdAt)
        || !conversations.get(binding.conversationId)?.jobIds.includes(jobId)) unavailable();
    }
    for (const conversation of state.conversations) {
      if (conversation.jobIds.some(jobId => state.jobBindings[jobId]?.conversationId !== conversation.id)) unavailable();
    }
    if (!Array.isArray(state.activity) || state.activity.length > LIMITS.events || state.activity.some(event =>
      !all(event, ['id', 'type', 'message', 'at']) || !id(event.id) || !text(event.type, 60) || !text(event.message, 240) || !timestamp(event.at))) unavailable();
    return state;
  }
  async function readJson(file, missing) {
    try {
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > LIMITS.bytes) unavailable();
      return JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return missing;
      unavailable();
    }
  }
  async function writeJson(file, value) {
    const raw = JSON.stringify(value);
    if (Buffer.byteLength(raw) > LIMITS.bytes) fail('JEFF_WORKSPACE_FULL');
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(temporary, raw, { mode: 0o600, flag: 'wx' });
      await rename(temporary, file);
    } catch { unavailable(); }
    finally { await rm(temporary, { force: true }).catch(() => {}); }
  }
  async function registry() {
    const value = await readJson(registryFile, { schema: REGISTRY_SCHEMA, scopes: [] });
    if (!all(value, ['schema', 'scopes']) || value.schema !== REGISTRY_SCHEMA || !Array.isArray(value.scopes) || value.scopes.length > LIMITS.scopes) unavailable();
    let normalized;
    try { normalized = value.scopes.map(scope => normalizeScope(scope)); } catch { unavailable(); }
    if (normalized.some((scope, i) => JSON.stringify(scope) !== JSON.stringify(value.scopes[i]))
      || new Set(normalized.map(scope => scopeId(scope))).size !== normalized.length) unavailable();
    return value;
  }
  async function register(scope, manifest) {
    if (manifest.scopes.some(item => scopeId(item) === scopeId(scope))) return;
    if (manifest.scopes.length >= LIMITS.scopes) fail('JEFF_WORKSPACE_FULL');
    manifest.scopes.push(scope);
    await writeJson(registryFile, manifest);
  }
  async function load(scope) {
    const manifest = await registry();
    let state = await readJson(stateFile(scope), ABSENT);
    if (state === ABSENT) {
      // A known workspace must never silently reset pause, budget, or memories.
      if (manifest.scopes.some(item => scopeId(item) === scopeId(scope))) unavailable();
      state = initial(scope);
      await authorize(scope);
      await writeJson(stateFile(scope), state);
    } else validateState(state, scope);
    await register(scope, manifest);
    return state;
  }
  function event(state, type, message) {
    state.activity.push({ id: randomUUID(), type, message, at: time() });
    state.activity = state.activity.slice(-LIMITS.events);
  }
  async function inspect(input, operation) {
    return serialize(async () => {
      const scope = await authorize(input);
      const state = await load(scope);
      const result = operation(state);
      await authorize(scope);
      return clone(result);
    });
  }
  async function mutate(input, operation) {
    return serialize(async () => {
      const scope = await authorize(input);
      const state = await load(scope);
      const result = operation(state);
      if (state.revision >= Number.MAX_SAFE_INTEGER) unavailable();
      state.revision++;
      state.updatedAt = time();
      validateState(state, scope);
      await authorize(scope);
      await writeJson(stateFile(scope), state);
      await authorize(scope);
      return clone(result ?? state);
    });
  }
  const api = {
    get(scope) { return inspect(scope, state => state); },
    updateSettings(scope, input) {
      if (!exact(input, ['revision', 'name', 'model', 'dailyBudgetMicros', 'paused']) || !Object.keys(input).length
        || (Object.hasOwn(input, 'revision') && (!Number.isSafeInteger(input.revision) || input.revision < 0))) invalid();
      return mutate(scope, state => {
        if (Object.hasOwn(input, 'revision') && input.revision !== state.revision) fail('JEFF_WORKSPACE_CONFLICT');
        const settings = { ...state.settings, ...Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'revision')) };
        if (!validSettings(settings)) invalid();
        state.settings = settings;
        event(state, 'settings.updated', settings.paused ? 'Agent settings saved; future runs paused.' : 'Agent settings saved.');
      });
    },
    createConversation(scope, input = {}) {
      if (!exact(input, ['title']) || (Object.hasOwn(input, 'title') && !text(input.title, 120))) invalid();
      return mutate(scope, state => {
        if (state.conversations.length >= LIMITS.conversations) fail('JEFF_WORKSPACE_FULL');
        const at = time();
        const conversation = { id: randomUUID(), title: input.title?.trim() || 'New conversation', createdAt: at, updatedAt: at, jobIds: [] };
        state.conversations.push(conversation);
        event(state, 'conversation.created', 'Conversation created.');
        return conversation;
      });
    },
    deleteConversation(scope, conversationId) {
      if (!id(conversationId)) invalid();
      return mutate(scope, state => {
        const conversation = state.conversations.find(item => item.id === conversationId);
        if (!conversation) fail('JEFF_WORKSPACE_NOT_FOUND');
        state.conversations = state.conversations.filter(item => item.id !== conversationId);
        for (const jobId of conversation.jobIds) delete state.jobBindings[jobId];
        event(state, 'conversation.deleted', 'Conversation removed from the workspace. Saved job receipts remain in history.');
      });
    },
    saveMemory(scope, input) {
      if (!exact(input, ['id', 'title', 'text']) || !text(input.title, 120) || !text(input.text, 4000)
        || (Object.hasOwn(input, 'id') && !id(input.id))) invalid();
      return mutate(scope, state => {
        const existing = input.id && state.memories.find(item => item.id === input.id);
        if (input.id && !existing) fail('JEFF_WORKSPACE_NOT_FOUND');
        if (!existing && state.memories.length >= LIMITS.memories) fail('JEFF_WORKSPACE_FULL');
        const at = time();
        if (existing) Object.assign(existing, { title: input.title.trim(), text: input.text, updatedAt: at });
        else state.memories.push({ id: randomUUID(), title: input.title.trim(), text: input.text, createdAt: at, updatedAt: at });
        event(state, existing ? 'memory.updated' : 'memory.created', existing ? 'A user memory was updated.' : 'A user memory was saved.');
      });
    },
    deleteMemory(scope, memoryId) {
      if (!id(memoryId)) invalid();
      return mutate(scope, state => {
        if (!state.memories.some(item => item.id === memoryId)) fail('JEFF_WORKSPACE_NOT_FOUND');
        state.memories = state.memories.filter(item => item.id !== memoryId);
        event(state, 'memory.deleted', 'A user memory was deleted.');
      });
    },
    setSkill(scope, input) {
      if (!all(input, ['id', 'enabled']) || !SKILLS.some(skill => skill.id === input.id) || typeof input.enabled !== 'boolean') invalid();
      return mutate(scope, state => {
        const skill = state.skills.find(item => item.id === input.id);
        skill.enabled = input.enabled;
        event(state, 'skill.updated', `${skill.name} prompt recipe ${input.enabled ? 'enabled' : 'disabled'}.`);
      });
    },
    bindJob(scope, input) {
      if (!exact(input, ['jobId', 'conversationId', 'objective', 'source']) || !id(input.jobId) || !id(input.conversationId)
        || !text(input.objective, 4000) || (Object.hasOwn(input, 'source') && !SOURCES.includes(input.source))) invalid();
      return mutate(scope, state => {
        const previous = state.jobBindings[input.jobId];
        if (previous) {
          if (previous.conversationId !== input.conversationId || previous.objective !== input.objective || previous.source !== (input.source || 'manual')) fail('JEFF_WORKSPACE_CONFLICT');
          return;
        }
        const conversation = state.conversations.find(item => item.id === input.conversationId);
        if (!conversation) fail('JEFF_WORKSPACE_NOT_FOUND');
        if (Object.keys(state.jobBindings).length >= LIMITS.jobs) fail('JEFF_WORKSPACE_FULL');
        const at = time();
        state.jobBindings[input.jobId] = { jobId: input.jobId, conversationId: input.conversationId, objective: input.objective, source: input.source || 'manual', createdAt: at };
        conversation.jobIds.push(input.jobId);
        conversation.updatedAt = at;
        event(state, 'job.started', input.source === 'schedule' ? 'A scheduled run was admitted.' : 'A conversation run was admitted.');
      });
    },
    getJobBinding(scope, jobId) {
      if (!id(jobId)) invalid();
      return inspect(scope, state => state.jobBindings[jobId] || null);
    },
    executionContext(scope, conversationId) {
      if (!id(conversationId)) invalid();
      return inspect(scope, state => {
        const conversation = state.conversations.find(item => item.id === conversationId);
        if (!conversation) fail('JEFF_WORKSPACE_NOT_FOUND');
        let available = LIMITS.contextMemory;
        const memories = [];
        for (const memory of state.memories) {
          if (available <= memory.title.length) break;
          const content = memory.text.slice(0, available - memory.title.length);
          memories.push({ id: memory.id, title: memory.title, text: content });
          available -= memory.title.length + content.length;
        }
        return { settings: state.settings, memories, skills: state.skills.filter(skill => skill.enabled), jobIds: conversation.jobIds.slice(-LIMITS.contextJobs) };
      });
    },
    activity(scope) { return inspect(scope, state => state.activity.slice().reverse()); },
    listScopes() {
      return serialize(async () => {
        const manifest = await registry();
        const scopes = [];
        for (const candidate of manifest.scopes) {
          try { scopes.push(await authorize(candidate)); }
          catch (error) { if (error.message !== 'JEFF_OWNER_REQUIRED') throw error; }
        }
        return clone(scopes);
      });
    },
  };
  return Object.freeze(api);
}
