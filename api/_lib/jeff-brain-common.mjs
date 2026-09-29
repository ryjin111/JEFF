import { createHash } from 'node:crypto';

export const JEFF_NAME = /^[a-z][a-z0-9_.-]{0,127}$/i;
export const JEFF_HASH = /^[a-f0-9]{64}$/;
export const JEFF_SECRET_PATTERN = /\b(?:api[_ -]?key|password|private key|recovery phrase|seed phrase|secret token|access token)\b/i;
export const JEFF_INJECTION_PATTERN = /\b(?:ignore (?:all |the )?(?:previous|system|developer)|reveal (?:the )?(?:system prompt|hidden instructions)|jailbreak|override owner policy)\b/i;

export const isJeffRecord = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

export function canonicalizeJeffValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonicalizeJeffValue);
  if (isJeffRecord(value)) {
    return Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .reduce((result, key) => {
        result[key] = canonicalizeJeffValue(value[key]);
        return result;
      }, {});
  }
  throw new TypeError('JEFF_VALUE_NOT_CANONICAL_JSON');
}

export function hashJeffBrainValue(value) {
  return createHash('sha256')
    .update(JSON.stringify(canonicalizeJeffValue(value)))
    .digest('hex');
}

export function assertJeffText(value, code, maximum = 4_096) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw new Error(code);
  return value.trim();
}

export function assertJeffName(value, code) {
  const normalized = assertJeffText(value, code, 128);
  if (!JEFF_NAME.test(normalized)) throw new Error(code);
  return normalized;
}

export function assertJeffRecord(value, code, maximumBytes = 32_768) {
  if (!isJeffRecord(value)) throw new Error(code);
  const encoded = JSON.stringify(value);
  if (!encoded || encoded.length > maximumBytes) throw new Error(code);
  return value;
}

export function containsJeffUnsafeText(value) {
  const text = String(value ?? '');
  if (JEFF_SECRET_PATTERN.test(text)) return 'secret_like_content';
  if (JEFF_INJECTION_PATTERN.test(text)) return 'instruction_injection';
  return null;
}

export function jeffTerms(value) {
  return new Set(String(value).toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []);
}

export function jeffRelevance(objective, text) {
  const wanted = jeffTerms(objective);
  return [...jeffTerms(text)].filter((term) => wanted.has(term)).length;
}

export function assertJeffIsoTimestamp(value, code) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error(code);
  return value;
}
