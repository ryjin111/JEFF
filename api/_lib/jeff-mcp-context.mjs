import {
  assertJeffText,
  containsJeffUnsafeText,
  hashJeffBrainValue,
  isJeffRecord,
  jeffRelevance,
  JEFF_HASH,
} from './jeff-brain-common.mjs';

const ALLOWED_MIME_TYPES = new Set(['text/plain', 'text/markdown', 'application/json']);

export function ingestJeffMcpContext({ objective, resources, authorization, maximum = 8 } = {}) {
  const goal = assertJeffText(objective, 'JEFF_MCP_OBJECTIVE_INVALID', 4_096);
  if (!Array.isArray(resources) || resources.length > 64) throw new Error('JEFF_MCP_RESOURCES_INVALID');
  if (!isJeffRecord(authorization)
    || !Array.isArray(authorization.allowedServers)
    || !Array.isArray(authorization.allowedUriPrefixes)) throw new Error('JEFF_MCP_AUTHORIZATION_INVALID');
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 24) throw new Error('JEFF_MCP_LIMIT_INVALID');
  const servers = new Set(authorization.allowedServers);
  const selected = [];
  const quarantined = [];

  for (const resource of resources) {
    let reason = null;
    if (!isJeffRecord(resource)) {
      quarantined.push({ id: null, reason: 'resource_invalid' });
      continue;
    }
    const server = typeof resource.server === 'string' ? resource.server : '';
    const uri = typeof resource.uri === 'string' ? resource.uri : '';
    const text = typeof resource.text === 'string' ? resource.text : '';
    const id = `mcp_${hashJeffBrainValue({ server, uri }).slice(0, 24)}`;
    if (!servers.has(server)) reason = 'server_not_authorized';
    else if (!authorization.allowedUriPrefixes.some((prefix) => typeof prefix === 'string' && uri.startsWith(prefix))) {
      reason = 'uri_not_authorized';
    } else if (!ALLOWED_MIME_TYPES.has(resource.mimeType)) reason = 'mime_type_not_allowed';
    else if (!text || text.length > 16_384) reason = 'content_invalid';
    else if (resource.sha256 !== undefined
      && (!JEFF_HASH.test(String(resource.sha256)) || resource.sha256 !== hashJeffBrainValue(text))) reason = 'content_hash_mismatch';
    else reason = containsJeffUnsafeText(text);
    const contentSha256 = text ? hashJeffBrainValue(text) : null;
    if (reason) quarantined.push({ id, reason, contentSha256 });
    else selected.push({
      id,
      text,
      source: `mcp:${server}:sha256:${hashJeffBrainValue(uri)}`,
      contentSha256,
      relevance: jeffRelevance(goal, text),
    });
  }

  selected.sort((left, right) => right.relevance - left.relevance || left.id.localeCompare(right.id));
  return Object.freeze({
    selected: Object.freeze(selected.slice(0, maximum)),
    quarantined: Object.freeze(quarantined),
    executionAuthorized: false,
  });
}

export const JEFF_MCP_CONTEXT = Object.freeze({
  mode: 'read_only',
  executionAuthorized: false,
  allowedMimeTypes: Object.freeze([...ALLOWED_MIME_TYPES]),
});
