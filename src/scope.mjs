import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { normalizeJeffOpenClawScope, normalizeJeffOpenClawAccountScope } from 'jeff-agent-nft/openclaw';

export const normalizeScope = scope => scope?.kind === 'account'
  ? normalizeJeffOpenClawAccountScope(scope) : normalizeJeffOpenClawScope(scope);
export const scopeId = scope => createHash('sha256').update(JSON.stringify(normalizeScope(scope))).digest('hex');
export const scopeDirectory = (dataRoot, scope) => resolve(dataRoot, scopeId(scope));
