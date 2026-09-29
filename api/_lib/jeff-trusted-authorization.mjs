import {
  assertJeffIsoTimestamp,
  assertJeffText,
  hashJeffBrainValue,
  isJeffRecord,
  JEFF_HASH,
} from './jeff-brain-common.mjs';

const SCHEMA = 'jeff-trusted-authorization-attestation-v1';
const MAX_TTL_MS = 5 * 60 * 1_000;
const KEYS = [
  'attestationSha256',
  'authorized',
  'expiresAt',
  'observedAt',
  'operation',
  'ownerEpoch',
  'schema',
  'scopeSha256',
  'subjectSha256',
];

function hasExactKeys(value, keys) {
  return isJeffRecord(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function validEpoch(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function createJeffAuthorizationAttestation({
  scope,
  subject,
  operation,
  ownerEpoch,
  observedAt = new Date().toISOString(),
  expiresAt = new Date(Date.parse(observedAt) + MAX_TTL_MS).toISOString(),
} = {}) {
  if (!isJeffRecord(scope) || !validEpoch(ownerEpoch)) throw new Error('JEFF_AUTH_ATTESTATION_INPUT_INVALID');
  const body = {
    schema: SCHEMA,
    scopeSha256: hashJeffBrainValue(scope),
    subjectSha256: hashJeffBrainValue(assertJeffText(subject, 'JEFF_AUTH_ATTESTATION_INPUT_INVALID', 256)),
    operation: assertJeffText(operation, 'JEFF_AUTH_ATTESTATION_INPUT_INVALID', 128),
    ownerEpoch,
    observedAt: assertJeffIsoTimestamp(observedAt, 'JEFF_AUTH_ATTESTATION_INPUT_INVALID'),
    expiresAt: assertJeffIsoTimestamp(expiresAt, 'JEFF_AUTH_ATTESTATION_INPUT_INVALID'),
    authorized: true,
  };
  const observedMs = Date.parse(body.observedAt);
  const expiresMs = Date.parse(body.expiresAt);
  if (expiresMs <= observedMs || expiresMs - observedMs > MAX_TTL_MS) {
    throw new Error('JEFF_AUTH_ATTESTATION_INPUT_INVALID');
  }
  return Object.freeze({ ...body, attestationSha256: hashJeffBrainValue(body) });
}

export async function requireJeffAuthorization({
  verifier,
  scope,
  subject,
  operation,
  ownerEpoch,
  now = () => new Date().toISOString(),
} = {}) {
  if (!verifier || typeof verifier.attest !== 'function') throw new Error('JEFF_AUTH_VERIFIER_REQUIRED');
  const normalizedSubject = assertJeffText(subject, 'JEFF_AUTH_DENIED', 256);
  const normalizedOperation = assertJeffText(operation, 'JEFF_AUTH_DENIED', 128);
  if (!isJeffRecord(scope) || !validEpoch(ownerEpoch)) throw new Error('JEFF_AUTH_DENIED');
  let attestation;
  try {
    attestation = await verifier.attest(Object.freeze({
      scope: Object.freeze(structuredClone(scope)),
      subject: normalizedSubject,
      operation: normalizedOperation,
      ownerEpoch,
    }));
  } catch {
    throw new Error('JEFF_AUTH_DENIED');
  }
  if (!hasExactKeys(attestation, KEYS)
    || attestation.schema !== SCHEMA
    || attestation.authorized !== true
    || attestation.scopeSha256 !== hashJeffBrainValue(scope)
    || attestation.subjectSha256 !== hashJeffBrainValue(normalizedSubject)
    || attestation.operation !== normalizedOperation
    || attestation.ownerEpoch !== ownerEpoch
    || !JEFF_HASH.test(String(attestation.attestationSha256 ?? ''))
    || !Number.isFinite(Date.parse(attestation.observedAt))
    || !Number.isFinite(Date.parse(attestation.expiresAt))) {
    throw new Error('JEFF_AUTH_DENIED');
  }
  const { attestationSha256, ...body } = attestation;
  const currentMs = Date.parse(assertJeffIsoTimestamp(now(), 'JEFF_AUTH_CLOCK_INVALID'));
  const observedMs = Date.parse(attestation.observedAt);
  const expiresMs = Date.parse(attestation.expiresAt);
  if (attestationSha256 !== hashJeffBrainValue(body)
    || observedMs > currentMs
    || currentMs >= expiresMs
    || expiresMs <= observedMs
    || expiresMs - observedMs > MAX_TTL_MS) {
    throw new Error('JEFF_AUTH_DENIED');
  }
  return Object.freeze(structuredClone(attestation));
}

export const JEFF_TRUSTED_AUTHORIZATION = Object.freeze({
  schema: SCHEMA,
  maxTtlMs: MAX_TTL_MS,
  requiredBindings: Object.freeze(['scope', 'subject', 'operation', 'ownerEpoch', 'freshness']),
});
