import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  sign as signValue,
  verify as verifyValue,
} from 'node:crypto';

import {
  createJeffAuthorizedMemory,
} from './jeff-authorized-memory.mjs';
import { loadAndVerifyJeffSoulBundle } from './jeff-soul-bundle.mjs';
import {
  deliberateJeffBrain,
  verifyJeffBrainReceipt,
} from './jeff-brain-v1.mjs';
import {
  assertJeffIsoTimestamp,
  assertJeffText,
  hashJeffBrainValue,
  isJeffRecord,
  JEFF_HASH,
} from './jeff-brain-common.mjs';
import { createJeffAuthorizationAttestation } from './jeff-trusted-authorization.mjs';

const ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const TOKEN_ID = /^(?:0|[1-9]\d*)$/;
const NONCE = /^[a-f0-9]{32}$/;
const SESSION_ID = /^[a-f0-9]{64}$/;
const MAX_UINT256 = (1n << 256n) - 1n;
const CHALLENGE_TTL_MS = 5 * 60 * 1_000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1_000;
const OWNERSHIP_TTL_MS = 60 * 1_000;
const AUTH_TTL_MS = 60 * 1_000;
const CLOCK_SKEW_MS = 5 * 1_000;
const MEMORY_OPERATIONS = new Set(['canReadMemory', 'canWriteMemory']);

const DEFAULT_SOUL_VERIFIER = Object.freeze({
  verify: () => loadAndVerifyJeffSoulBundle(),
});

function clone(value) {
  return structuredClone(value);
}

async function holderStage(stage, operation) {
  try {
    return await operation();
  } catch (error) {
    const failure = error instanceof Error ? error : new Error('JEFF_HOLDER_RUNTIME_FAILED');
    Object.defineProperty(failure, 'jeffHolderStage', {
      value: stage,
      configurable: true,
    });
    throw failure;
  }
}

function exactKeys(value, keys) {
  return isJeffRecord(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function normalizeAddress(value, code) {
  if (typeof value !== 'string' || !ADDRESS.test(value)) throw new Error(code);
  return value.toLowerCase();
}

function normalizeRelyingPartyOrigin(value) {
  const raw = assertJeffText(value, 'JEFF_HOLDER_RELYING_PARTY_INVALID', 2_048);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('JEFF_HOLDER_RELYING_PARTY_INVALID');
  }
  const localDevelopment = parsed.hostname === 'localhost'
    || parsed.hostname === '127.0.0.1'
    || parsed.hostname === '[::1]';
  if ((parsed.protocol !== 'https:' && !(localDevelopment && parsed.protocol === 'http:'))
    || parsed.username
    || parsed.password
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash
    || parsed.origin === 'null') {
    throw new Error('JEFF_HOLDER_RELYING_PARTY_INVALID');
  }
  return Object.freeze({ origin: parsed.origin, domain: parsed.host.toLowerCase() });
}

function normalizeChallengeLocation(domain, uri, relyingParty) {
  const normalizedDomain = assertJeffText(domain, 'JEFF_HOLDER_CHALLENGE_INVALID', 253).toLowerCase();
  const rawUri = assertJeffText(uri, 'JEFF_HOLDER_CHALLENGE_INVALID', 2_048);
  let parsed;
  try {
    parsed = new URL(rawUri);
  } catch {
    throw new Error('JEFF_HOLDER_CHALLENGE_INVALID');
  }
  if (normalizedDomain !== relyingParty.domain
    || parsed.origin !== relyingParty.origin
    || parsed.username
    || parsed.password
    || parsed.hash) {
    throw new Error('JEFF_HOLDER_CHALLENGE_ORIGIN_MISMATCH');
  }
  return Object.freeze({ domain: relyingParty.domain, uri: parsed.href });
}

function normalizeAgentNft(agentNft) {
  if (!isJeffRecord(agentNft)
    || !Number.isSafeInteger(agentNft.chainId)
    || agentNft.chainId <= 0
    || typeof agentNft.tokenId !== 'string'
    || !TOKEN_ID.test(agentNft.tokenId)) {
    throw new Error('JEFF_HOLDER_AGENT_NFT_INVALID');
  }
  try {
    if (BigInt(agentNft.tokenId) > MAX_UINT256) throw new Error('JEFF_HOLDER_AGENT_NFT_INVALID');
  } catch {
    throw new Error('JEFF_HOLDER_AGENT_NFT_INVALID');
  }
  return Object.freeze({
    chainId: agentNft.chainId,
    collection: normalizeAddress(agentNft.collection, 'JEFF_HOLDER_AGENT_NFT_INVALID'),
    tokenId: agentNft.tokenId,
    account: normalizeAddress(agentNft.account, 'JEFF_HOLDER_AGENT_NFT_INVALID'),
  });
}

function timestampMs(value, code) {
  const normalized = assertJeffIsoTimestamp(value, code);
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) throw new Error(code);
  return parsed;
}

function nowIso(now) {
  return new Date(timestampMs(now(), 'JEFF_HOLDER_CLOCK_INVALID')).toISOString();
}

function agentId(agentNft) {
  return `eip155:${agentNft.chainId}:${agentNft.collection}:${agentNft.tokenId}`;
}

function ownerId(agentNft, wallet) {
  return `eip155:${agentNft.chainId}:${wallet}`;
}

function holderScope(session) {
  return Object.freeze({
    agentId: agentId(session.agentNft),
    ownerId: ownerId(session.agentNft, session.wallet),
    ownerEpoch: session.ownerEpoch,
  });
}

function holderAuthorization(session, operation) {
  return Object.freeze({
    ...holderScope(session),
    subject: `session:${session.sessionId}`,
    [operation]: true,
  });
}

function validateSoulBundle(bundle) {
  if (!isJeffRecord(bundle)
    || bundle.schema !== 'jeff-agent-soul-manifest-v1'
    || !isJeffRecord(bundle.agent)
    || bundle.agent.id !== 'jeff'
    || !isJeffRecord(bundle.controls)
    || bundle.controls.executionAuthorized !== false
    || bundle.controls.authorityIncluded !== false
    || bundle.controls.memoryIncluded !== false
    || !isJeffRecord(bundle.checkpoint)
    || !JEFF_HASH.test(String(bundle.checkpoint.sha256 ?? ''))
    || !JEFF_HASH.test(String(bundle.bundleRootSha256 ?? ''))
    || !JEFF_HASH.test(String(bundle.manifestSha256 ?? ''))) {
    throw new Error('JEFF_HOLDER_SOUL_BUNDLE_INVALID');
  }
  return Object.freeze({
    manifestSha256: bundle.manifestSha256,
    bundleRootSha256: bundle.bundleRootSha256,
    checkpointSha256: bundle.checkpoint.sha256,
  });
}

function validateFreshObservation(observedAt, currentAt, ttlMs, code) {
  const observedMs = timestampMs(observedAt, code);
  const currentMs = timestampMs(currentAt, code);
  if (observedMs - currentMs > CLOCK_SKEW_MS || currentMs - observedMs > ttlMs) throw new Error(code);
}

function validateOwnership(attestation, agentNft, currentAt) {
  if (!isJeffRecord(attestation)
    || attestation.schema !== 'jeff-holder-ownership-attestation-v1'
    || attestation.agentNftSha256 !== hashJeffBrainValue(agentNft)
    || !Number.isSafeInteger(attestation.ownerEpoch)
    || attestation.ownerEpoch < 0) {
    throw new Error('JEFF_HOLDER_OWNERSHIP_ATTESTATION_INVALID');
  }
  const currentOwner = normalizeAddress(
    attestation.currentOwner,
    'JEFF_HOLDER_OWNERSHIP_ATTESTATION_INVALID',
  );
  validateFreshObservation(
    attestation.observedAt,
    currentAt,
    OWNERSHIP_TTL_MS,
    'JEFF_HOLDER_OWNERSHIP_ATTESTATION_STALE',
  );
  return Object.freeze({
    schema: attestation.schema,
    agentNftSha256: attestation.agentNftSha256,
    currentOwner,
    ownerEpoch: attestation.ownerEpoch,
    observedAt: new Date(Date.parse(attestation.observedAt)).toISOString(),
  });
}

function challengeMessage({ domain, uri, wallet, agentNft, nonce, issuedAt, expiresAt }) {
  return [
    'JEFF Holder Alpha',
    `Domain: ${domain}`,
    `URI: ${uri}`,
    `Wallet: ${wallet}`,
    `Agent NFT: eip155:${agentNft.chainId}:${agentNft.collection}:${agentNft.tokenId}`,
    `Token-bound account: ${agentNft.account}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
    `Expiration Time: ${expiresAt}`,
    'Purpose: Boot this Agent NFT in shadow mode. This signature authorizes no transaction.',
  ].join('\n');
}

function validateChallenge(challenge, currentAt) {
  if (!isJeffRecord(challenge)
    || challenge.schema !== 'jeff-holder-challenge-v1'
    || !NONCE.test(String(challenge.nonce ?? ''))
    || !JEFF_HASH.test(String(challenge.challengeSha256 ?? ''))) {
    throw new Error('JEFF_HOLDER_CHALLENGE_INVALID');
  }
  const agentNft = normalizeAgentNft(challenge.agentNft);
  const wallet = normalizeAddress(challenge.wallet, 'JEFF_HOLDER_CHALLENGE_INVALID');
  const domain = assertJeffText(challenge.domain, 'JEFF_HOLDER_CHALLENGE_INVALID', 253);
  const uri = assertJeffText(challenge.uri, 'JEFF_HOLDER_CHALLENGE_INVALID', 2_048);
  const issuedAt = new Date(timestampMs(challenge.issuedAt, 'JEFF_HOLDER_CHALLENGE_INVALID')).toISOString();
  const expiresAt = new Date(timestampMs(challenge.expiresAt, 'JEFF_HOLDER_CHALLENGE_INVALID')).toISOString();
  const issuedMs = Date.parse(issuedAt);
  const expiresMs = Date.parse(expiresAt);
  const currentMs = timestampMs(currentAt, 'JEFF_HOLDER_CLOCK_INVALID');
  if (expiresMs <= issuedMs
    || expiresMs - issuedMs > CHALLENGE_TTL_MS
    || currentMs < issuedMs
    || currentMs >= expiresMs) {
    throw new Error('JEFF_HOLDER_CHALLENGE_EXPIRED');
  }
  const message = challengeMessage({
    domain, uri, wallet, agentNft, nonce: challenge.nonce, issuedAt, expiresAt,
  });
  const body = {
    schema: challenge.schema,
    domain,
    uri,
    wallet,
    agentNft,
    nonce: challenge.nonce,
    issuedAt,
    expiresAt,
    message,
  };
  if (challenge.message !== message || challenge.challengeSha256 !== hashJeffBrainValue(body)) {
    throw new Error('JEFF_HOLDER_CHALLENGE_INVALID');
  }
  return Object.freeze({ ...body, challengeSha256: challenge.challengeSha256 });
}

function validateWalletVerification(result, challenge, currentAt) {
  if (!isJeffRecord(result)
    || result.schema !== 'jeff-wallet-signature-verification-v1'
    || result.verified !== true
    || result.challengeSha256 !== challenge.challengeSha256
    || normalizeAddress(result.wallet, 'JEFF_HOLDER_SIGNATURE_INVALID') !== challenge.wallet) {
    throw new Error('JEFF_HOLDER_SIGNATURE_INVALID');
  }
  validateFreshObservation(
    result.observedAt,
    currentAt,
    OWNERSHIP_TTL_MS,
    'JEFF_HOLDER_SIGNATURE_INVALID',
  );
}

function validateSession(session, currentAt) {
  if (!isJeffRecord(session)
    || session.schema !== 'jeff-holder-session-v1'
    || !SESSION_ID.test(String(session.sessionId ?? ''))
    || session.status !== 'active') {
    throw new Error('JEFF_HOLDER_SESSION_INVALID');
  }
  const currentMs = timestampMs(currentAt, 'JEFF_HOLDER_CLOCK_INVALID');
  if (currentMs >= timestampMs(session.expiresAt, 'JEFF_HOLDER_SESSION_INVALID')) {
    throw new Error('JEFF_HOLDER_SESSION_EXPIRED');
  }
  normalizeAgentNft(session.agentNft);
  normalizeAddress(session.wallet, 'JEFF_HOLDER_SESSION_INVALID');
  if (!Number.isSafeInteger(session.ownerEpoch) || session.ownerEpoch < 0) {
    throw new Error('JEFF_HOLDER_SESSION_INVALID');
  }
  if (!JEFF_HASH.test(String(session.soulManifestSha256 ?? ''))
    || !JEFF_HASH.test(String(session.soulBundleRootSha256 ?? ''))
    || !JEFF_HASH.test(String(session.soulCheckpointSha256 ?? ''))) {
    throw new Error('JEFF_HOLDER_SESSION_INVALID');
  }
  return session;
}

export function createInMemoryJeffHolderStore() {
  const challenges = new Map();
  const sessions = new Map();
  return Object.freeze({
    async putChallenge(challenge) {
      if (challenges.has(challenge.challengeSha256)) throw new Error('JEFF_HOLDER_CHALLENGE_DUPLICATE');
      challenges.set(challenge.challengeSha256, clone(challenge));
    },
    async consumeChallenge(challengeSha256) {
      const challenge = challenges.get(challengeSha256);
      if (!challenge) return null;
      challenges.delete(challengeSha256);
      return clone(challenge);
    },
    async putSession(session) {
      if (sessions.has(session.sessionId)) throw new Error('JEFF_HOLDER_SESSION_DUPLICATE');
      sessions.set(session.sessionId, clone(session));
    },
    async getSession(sessionId) {
      const session = sessions.get(sessionId);
      return session ? clone(session) : null;
    },
    async revokeSession(sessionId, reason, revokedAt) {
      const session = sessions.get(sessionId);
      if (!session) return false;
      sessions.set(sessionId, {
        ...session,
        status: 'revoked',
        revokedAt,
        revocationReason: reason,
      });
      return true;
    },
    async snapshot() {
      return Object.freeze({
        challenges: Object.freeze([...challenges.values()].map(clone)),
        sessions: Object.freeze([...sessions.values()].map(clone)),
      });
    },
  });
}

export function createJeffAesGcmMemoryCrypto({ key } = {}) {
  const secret = Buffer.isBuffer(key) ? Buffer.from(key) : Buffer.from(String(key ?? ''), 'base64');
  if (secret.length !== 32) throw new Error('JEFF_HOLDER_MEMORY_KEY_INVALID');
  return Object.freeze({
    async seal({ plaintext, scopeSha256 }) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', secret, iv);
      cipher.setAAD(Buffer.from(scopeSha256, 'utf8'));
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return ['v1', iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
    },
    async open({ ciphertext, scopeSha256 }) {
      const [version, ivText, tagText, bodyText, extra] = String(ciphertext).split('.');
      if (version !== 'v1' || !ivText || !tagText || bodyText === undefined || extra !== undefined) {
        throw new Error('JEFF_HOLDER_MEMORY_CIPHERTEXT_INVALID');
      }
      const decipher = createDecipheriv('aes-256-gcm', secret, Buffer.from(ivText, 'base64url'));
      decipher.setAAD(Buffer.from(scopeSha256, 'utf8'));
      decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(bodyText, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    },
  });
}

export function createJeffEd25519ReceiptSigner({ privateKey, keyId } = {}) {
  const normalizedKeyId = assertJeffText(keyId, 'JEFF_HOLDER_RECEIPT_SIGNER_INVALID', 128);
  if (!privateKey) throw new Error('JEFF_HOLDER_RECEIPT_SIGNER_INVALID');
  return Object.freeze({
    algorithm: 'Ed25519',
    keyId: normalizedKeyId,
    signDigest(digest) {
      if (!JEFF_HASH.test(String(digest ?? ''))) throw new Error('JEFF_HOLDER_RECEIPT_DIGEST_INVALID');
      return signValue(null, Buffer.from(digest, 'hex'), privateKey).toString('base64url');
    },
  });
}

export function createJeffEd25519ReceiptVerifier({ publicKey, keyId } = {}) {
  const normalizedKeyId = assertJeffText(keyId, 'JEFF_HOLDER_RECEIPT_VERIFIER_INVALID', 128);
  if (!publicKey) throw new Error('JEFF_HOLDER_RECEIPT_VERIFIER_INVALID');
  return Object.freeze({
    algorithm: 'Ed25519',
    keyId: normalizedKeyId,
    verifyDigest(digest, signature) {
      if (!JEFF_HASH.test(String(digest ?? '')) || typeof signature !== 'string') return false;
      try {
        return verifyValue(
          null,
          Buffer.from(digest, 'hex'),
          publicKey,
          Buffer.from(signature, 'base64url'),
        );
      } catch {
        return false;
      }
    },
  });
}

export function verifyJeffHolderToolReceipt(receipt) {
  if (!exactKeys(receipt, [
    'schema', 'tool', 'mode', 'inputSha256', 'outputSha256', 'ownerEpoch',
    'observedAt', 'executionAuthorized', 'writesExecuted', 'receiptSha256',
  ])
    || receipt.schema !== 'jeff-holder-tool-receipt-v1'
    || receipt.tool !== 'holder.status'
    || receipt.mode !== 'read_only'
    || !JEFF_HASH.test(String(receipt.inputSha256 ?? ''))
    || !JEFF_HASH.test(String(receipt.outputSha256 ?? ''))
    || !Number.isSafeInteger(receipt.ownerEpoch)
    || receipt.ownerEpoch < 0
    || receipt.executionAuthorized !== false
    || receipt.writesExecuted !== 0
    || !JEFF_HASH.test(String(receipt.receiptSha256 ?? ''))) return false;
  try {
    timestampMs(receipt.observedAt, 'JEFF_HOLDER_TOOL_RECEIPT_INVALID');
  } catch {
    return false;
  }
  const { receiptSha256, ...body } = receipt;
  return receiptSha256 === hashJeffBrainValue(body);
}

export function verifyJeffHolderReceipt(receipt, verifier) {
  if (!exactKeys(receipt, [
    'schema', 'runtimeVersion', 'mode', 'executionAuthorized', 'actionsExecuted',
    'readOnlyToolsExecuted', 'tool', 'sessionSha256', 'instanceId', 'agentNftSha256',
    'walletSha256', 'ownerEpoch', 'soulManifestSha256', 'soulBundleRootSha256',
    'soulCheckpointSha256', 'objectiveSha256', 'holderStatusSha256', 'toolReceiptSha256',
    'brainReceiptSha256', 'memoryScopeSha256', 'createdAt', 'receiptSha256', 'signature',
  ])
    || receipt.schema !== 'jeff-holder-action-receipt-v1'
    || receipt.runtimeVersion !== 'jeff-holder-alpha-v1'
    || receipt.mode !== 'shadow'
    || receipt.executionAuthorized !== false
    || receipt.actionsExecuted !== 0
    || receipt.readOnlyToolsExecuted !== 1
    || receipt.tool !== 'holder.status'
    || !JEFF_HASH.test(String(receipt.sessionSha256 ?? ''))
    || !JEFF_HASH.test(String(receipt.instanceId ?? ''))
    || !JEFF_HASH.test(String(receipt.agentNftSha256 ?? ''))
    || !JEFF_HASH.test(String(receipt.walletSha256 ?? ''))
    || !Number.isSafeInteger(receipt.ownerEpoch)
    || receipt.ownerEpoch < 0
    || !JEFF_HASH.test(String(receipt.toolReceiptSha256 ?? ''))
    || !JEFF_HASH.test(String(receipt.soulManifestSha256 ?? ''))
    || !JEFF_HASH.test(String(receipt.soulBundleRootSha256 ?? ''))
    || !JEFF_HASH.test(String(receipt.soulCheckpointSha256 ?? ''))
    || !JEFF_HASH.test(String(receipt.objectiveSha256 ?? ''))
    || !JEFF_HASH.test(String(receipt.holderStatusSha256 ?? ''))
    || !JEFF_HASH.test(String(receipt.brainReceiptSha256 ?? ''))
    || (receipt.memoryScopeSha256 !== null
      && !JEFF_HASH.test(String(receipt.memoryScopeSha256 ?? '')))
    || !exactKeys(receipt.signature, ['algorithm', 'keyId', 'value'])
    || !verifier
    || typeof verifier.verifyDigest !== 'function'
    || receipt.signature.algorithm !== verifier.algorithm
    || receipt.signature.keyId !== verifier.keyId) return false;
  try {
    timestampMs(receipt.createdAt, 'JEFF_HOLDER_RECEIPT_INVALID');
  } catch {
    return false;
  }
  const { receiptSha256, signature, ...body } = receipt;
  if (receiptSha256 !== hashJeffBrainValue(body)) return false;
  return verifier.verifyDigest(receiptSha256, signature.value) === true;
}

export function createJeffHolderSessionAuthorizationVerifier({
  store,
  ownershipResolver,
  now = () => new Date().toISOString(),
} = {}) {
  if (!store || typeof store.getSession !== 'function' || typeof store.revokeSession !== 'function') {
    throw new Error('JEFF_HOLDER_STORE_INVALID');
  }
  if (!ownershipResolver || typeof ownershipResolver.resolveCurrentOwner !== 'function') {
    throw new Error('JEFF_HOLDER_OWNERSHIP_RESOLVER_REQUIRED');
  }
  return Object.freeze({
    async attest(input) {
      if (!isJeffRecord(input)
        || !MEMORY_OPERATIONS.has(input.operation)
        || typeof input.subject !== 'string'
        || !input.subject.startsWith('session:')) {
        throw new Error('JEFF_HOLDER_AUTHORIZATION_DENIED');
      }
      const sessionId = input.subject.slice('session:'.length);
      if (!SESSION_ID.test(sessionId)) throw new Error('JEFF_HOLDER_AUTHORIZATION_DENIED');
      const session = validateSession(await store.getSession(sessionId), nowIso(now));
      const expectedScope = holderScope(session);
      if (hashJeffBrainValue(input.scope) !== hashJeffBrainValue(expectedScope)
        || input.ownerEpoch !== session.ownerEpoch) {
        throw new Error('JEFF_HOLDER_AUTHORIZATION_DENIED');
      }
      const rawOwnership = await ownershipResolver.resolveCurrentOwner(clone(session.agentNft));
      const currentAt = nowIso(now);
      validateSession(session, currentAt);
      const ownership = validateOwnership(
        rawOwnership,
        session.agentNft,
        currentAt,
      );
      if (ownership.currentOwner !== session.wallet || ownership.ownerEpoch !== session.ownerEpoch) {
        await store.revokeSession(sessionId, 'ownership_changed', currentAt);
        throw new Error('JEFF_HOLDER_AUTHORIZATION_DENIED');
      }
      return createJeffAuthorizationAttestation({
        scope: expectedScope,
        subject: input.subject,
        operation: input.operation,
        ownerEpoch: session.ownerEpoch,
        observedAt: currentAt,
        expiresAt: new Date(Date.parse(currentAt) + AUTH_TTL_MS).toISOString(),
      });
    },
  });
}

export function createJeffHolderOsAuthorizationVerifier({
  store,
  ownershipResolver,
  authorize,
  now = () => new Date().toISOString(),
} = {}) {
  if (!store || typeof store.getSession !== 'function' || typeof store.revokeSession !== 'function') {
    throw new Error('JEFF_HOLDER_STORE_INVALID');
  }
  if (!ownershipResolver || typeof ownershipResolver.resolveCurrentOwner !== 'function') {
    throw new Error('JEFF_HOLDER_OWNERSHIP_RESOLVER_REQUIRED');
  }
  if (typeof authorize !== 'function') throw new Error('JEFF_HOLDER_OS_POLICY_REQUIRED');
  return Object.freeze({
    async attest(input) {
      if (!isJeffRecord(input)
        || !isJeffRecord(input.scope)
        || typeof input.subject !== 'string'
        || !input.subject.startsWith('session:')
        || typeof input.operation !== 'string'
        || !(
          input.operation.startsWith('use_skill:')
          || input.operation === 'run_schedule'
          || input.operation === 'register_schedule'
          || input.operation === 'cancel_schedule'
          || input.operation === 'route_agent_message'
        )) {
        throw new Error('JEFF_HOLDER_OS_AUTHORIZATION_DENIED');
      }
      const sessionId = input.subject.slice('session:'.length);
      if (!SESSION_ID.test(sessionId)) throw new Error('JEFF_HOLDER_OS_AUTHORIZATION_DENIED');
      const currentAt = nowIso(now);
      const session = validateSession(await store.getSession(sessionId), currentAt);
      const ownership = validateOwnership(
        await ownershipResolver.resolveCurrentOwner(clone(session.agentNft)),
        session.agentNft,
        currentAt,
      );
      if (ownership.currentOwner !== session.wallet || ownership.ownerEpoch !== session.ownerEpoch) {
        await store.revokeSession(session.sessionId, 'ownership_changed', currentAt);
        throw new Error('JEFF_HOLDER_OWNERSHIP_CHANGED');
      }
      if (input.ownerEpoch !== session.ownerEpoch
        || await authorize(Object.freeze({
          session: clone(session),
          scope: clone(input.scope),
          operation: input.operation,
        })) !== true) {
        throw new Error('JEFF_HOLDER_OS_AUTHORIZATION_DENIED');
      }
      return createJeffAuthorizationAttestation({
        scope: input.scope,
        subject: input.subject,
        operation: input.operation,
        ownerEpoch: input.ownerEpoch,
        observedAt: currentAt,
        expiresAt: new Date(Date.parse(currentAt) + AUTH_TTL_MS).toISOString(),
      });
    },
  });
}

export function createJeffHolderRuntime({
  store,
  walletVerifier,
  ownershipResolver,
  provider,
  memoryAdapter,
  memoryCrypto,
  receiptSigner,
  relyingPartyOrigin,
  authorizeAgentNft = () => true,
  soulVerifier = DEFAULT_SOUL_VERIFIER,
  now = () => new Date().toISOString(),
  nonce = () => randomBytes(16).toString('hex'),
  sessionId = () => randomBytes(32).toString('hex'),
} = {}) {
  if (!store
    || typeof store.putChallenge !== 'function'
    || typeof store.consumeChallenge !== 'function'
    || typeof store.putSession !== 'function'
    || typeof store.getSession !== 'function'
    || typeof store.revokeSession !== 'function') throw new Error('JEFF_HOLDER_STORE_INVALID');
  if (!walletVerifier || typeof walletVerifier.verify !== 'function') {
    throw new Error('JEFF_HOLDER_WALLET_VERIFIER_REQUIRED');
  }
  if (!ownershipResolver || typeof ownershipResolver.resolveCurrentOwner !== 'function') {
    throw new Error('JEFF_HOLDER_OWNERSHIP_RESOLVER_REQUIRED');
  }
  if (!provider || typeof provider.complete !== 'function') throw new Error('JEFF_HOLDER_PROVIDER_REQUIRED');
  if (!soulVerifier || typeof soulVerifier.verify !== 'function') {
    throw new Error('JEFF_HOLDER_SOUL_VERIFIER_REQUIRED');
  }
  if (!receiptSigner
    || receiptSigner.algorithm !== 'Ed25519'
    || typeof receiptSigner.keyId !== 'string'
    || !receiptSigner.keyId
    || typeof receiptSigner.signDigest !== 'function') {
    throw new Error('JEFF_HOLDER_RECEIPT_SIGNER_REQUIRED');
  }
  if (typeof authorizeAgentNft !== 'function') {
    throw new Error('JEFF_HOLDER_AGENT_NFT_POLICY_REQUIRED');
  }
  const relyingParty = normalizeRelyingPartyOrigin(relyingPartyOrigin);

  const authorizationVerifier = createJeffHolderSessionAuthorizationVerifier({
    store, ownershipResolver, now,
  });
  const memoryService = createJeffAuthorizedMemory({
    adapter: memoryAdapter,
    crypto: memoryCrypto,
    authorizationVerifier,
    now,
  });

  async function resolveLiveOwnership(session) {
    const rawOwnership = await ownershipResolver.resolveCurrentOwner(clone(session.agentNft));
    const currentAt = nowIso(now);
    validateSession(session, currentAt);
    const ownership = validateOwnership(
      rawOwnership,
      session.agentNft,
      currentAt,
    );
    if (ownership.currentOwner !== session.wallet || ownership.ownerEpoch !== session.ownerEpoch) {
      await store.revokeSession(session.sessionId, 'ownership_changed', currentAt);
      throw new Error('JEFF_HOLDER_OWNERSHIP_CHANGED');
    }
    return Object.freeze({ ownership, currentAt });
  }

  async function requireLiveSession(rawSessionId) {
    if (!SESSION_ID.test(String(rawSessionId ?? ''))) throw new Error('JEFF_HOLDER_SESSION_INVALID');
    const currentAt = nowIso(now);
    const session = validateSession(await store.getSession(rawSessionId), currentAt);
    const live = await resolveLiveOwnership(session);
    return Object.freeze({ session, ...live });
  }

  function guardedProvider(session) {
    return Object.freeze({
      model: provider.model,
      async complete(input) {
        await resolveLiveOwnership(session);
        return provider.complete(input);
      },
    });
  }

  function authorizeHolderStatusTool(result, session) {
    const toolMode = result.decisionResponse?.answers?.tool_mode;
    if (toolMode?.type !== 'choice'
      || toolMode.choice !== 'read_only'
      || result.safety?.disposition === 'deny') {
      throw new Error('JEFF_HOLDER_TOOL_NOT_AUTHORIZED');
    }
    const proposals = result.safety?.proposals;
    if (!Array.isArray(proposals)) throw new Error('JEFF_HOLDER_TOOL_NOT_AUTHORIZED');
    if (result.llmUtility?.providerCallsAllowed === 0) {
      if (proposals.length !== 0) throw new Error('JEFF_HOLDER_TOOL_NOT_AUTHORIZED');
      return Object.freeze({ tokenId: session.agentNft.tokenId });
    }
    if (result.llmUtility?.providerCallsAllowed !== 2 || proposals.length !== 1) {
      throw new Error('JEFF_HOLDER_TOOL_NOT_AUTHORIZED');
    }
    const proposal = proposals[0];
    if (proposal.tool !== 'holder.status'
      || proposal.mode !== 'read_only'
      || proposal.status !== 'read_only_candidate'
      || !isJeffRecord(proposal.input)
      || Object.keys(proposal.input).length !== 1
      || proposal.input.tokenId !== session.agentNft.tokenId) {
      throw new Error('JEFF_HOLDER_TOOL_NOT_AUTHORIZED');
    }
    return Object.freeze({ tokenId: proposal.input.tokenId });
  }

  async function executeHolderStatusTool(session, result) {
    const input = authorizeHolderStatusTool(result, session);
    const { ownership, currentAt } = await resolveLiveOwnership(session);
    const holderStatus = Object.freeze({
      schema: 'jeff-holder-status-v1',
      agentNft: session.agentNft,
      currentOwner: ownership.currentOwner,
      ownerEpoch: ownership.ownerEpoch,
      observedAt: ownership.observedAt,
      mode: 'shadow',
      executionAuthorized: false,
    });
    const body = {
      schema: 'jeff-holder-tool-receipt-v1',
      tool: 'holder.status',
      mode: 'read_only',
      inputSha256: hashJeffBrainValue(input),
      outputSha256: hashJeffBrainValue(holderStatus),
      ownerEpoch: session.ownerEpoch,
      observedAt: currentAt,
      executionAuthorized: false,
      writesExecuted: 0,
    };
    const receipt = Object.freeze({ ...body, receiptSha256: hashJeffBrainValue(body) });
    if (!verifyJeffHolderToolReceipt(receipt)) throw new Error('JEFF_HOLDER_TOOL_RECEIPT_INVALID');
    return Object.freeze({
      holderStatus,
      receipt,
    });
  }

  return Object.freeze({
    async issueChallenge({ domain, uri, wallet: rawWallet, agentNft: rawAgentNft } = {}) {
      const currentAt = nowIso(now);
      const wallet = normalizeAddress(rawWallet, 'JEFF_HOLDER_WALLET_INVALID');
      const agentNft = normalizeAgentNft(rawAgentNft);
      if (await authorizeAgentNft(clone(agentNft)) !== true) {
        throw new Error('JEFF_HOLDER_AGENT_NFT_DENIED');
      }
      const { domain: normalizedDomain, uri: normalizedUri } = normalizeChallengeLocation(
        domain,
        uri,
        relyingParty,
      );
      const challengeNonce = nonce();
      if (!NONCE.test(String(challengeNonce ?? ''))) throw new Error('JEFF_HOLDER_NONCE_INVALID');
      const expiresAt = new Date(Date.parse(currentAt) + CHALLENGE_TTL_MS).toISOString();
      const message = challengeMessage({
        domain: normalizedDomain,
        uri: normalizedUri,
        wallet,
        agentNft,
        nonce: challengeNonce,
        issuedAt: currentAt,
        expiresAt,
      });
      const body = {
        schema: 'jeff-holder-challenge-v1',
        domain: normalizedDomain,
        uri: normalizedUri,
        wallet,
        agentNft,
        nonce: challengeNonce,
        issuedAt: currentAt,
        expiresAt,
        message,
      };
      const challenge = Object.freeze({ ...body, challengeSha256: hashJeffBrainValue(body) });
      await store.putChallenge(challenge);
      return challenge;
    },

    async boot({ challengeSha256, signature } = {}) {
      if (!JEFF_HASH.test(String(challengeSha256 ?? ''))) throw new Error('JEFF_HOLDER_CHALLENGE_INVALID');
      const stored = await holderStage(
        'boot_consume_challenge',
        () => store.consumeChallenge(challengeSha256),
      );
      if (!stored) throw new Error('JEFF_HOLDER_CHALLENGE_CONSUMED_OR_UNKNOWN');
      let currentAt = nowIso(now);
      let challenge = validateChallenge(stored, currentAt);
      const verification = await holderStage(
        'boot_wallet_verify',
        () => walletVerifier.verify(Object.freeze({
          challengeSha256,
          message: challenge.message,
          signature: assertJeffText(signature, 'JEFF_HOLDER_SIGNATURE_INVALID', 2_048),
          wallet: challenge.wallet,
          chainId: challenge.agentNft.chainId,
        })),
      );
      currentAt = nowIso(now);
      challenge = validateChallenge(stored, currentAt);
      validateWalletVerification(verification, challenge, currentAt);
      const rawOwnership = await holderStage(
        'boot_initial_ownership',
        () => ownershipResolver.resolveCurrentOwner(clone(challenge.agentNft)),
      );
      currentAt = nowIso(now);
      challenge = validateChallenge(stored, currentAt);
      let ownership = validateOwnership(
        rawOwnership,
        challenge.agentNft,
        currentAt,
      );
      if (ownership.currentOwner !== challenge.wallet) throw new Error('JEFF_HOLDER_NOT_CURRENT_OWNER');
      const soul = await holderStage(
        'boot_soul_verify',
        async () => validateSoulBundle(await soulVerifier.verify(Object.freeze({
          agentNft: clone(challenge.agentNft),
        }))),
      );
      currentAt = nowIso(now);
      challenge = validateChallenge(stored, currentAt);
      const finalRawOwnership = await holderStage(
        'boot_final_ownership',
        () => ownershipResolver.resolveCurrentOwner(clone(challenge.agentNft)),
      );
      currentAt = nowIso(now);
      challenge = validateChallenge(stored, currentAt);
      ownership = validateOwnership(finalRawOwnership, challenge.agentNft, currentAt);
      if (ownership.currentOwner !== challenge.wallet) throw new Error('JEFF_HOLDER_NOT_CURRENT_OWNER');
      const id = sessionId();
      if (!SESSION_ID.test(String(id ?? ''))) throw new Error('JEFF_HOLDER_SESSION_ID_INVALID');
      const session = Object.freeze({
        schema: 'jeff-holder-session-v1',
        sessionId: id,
        instanceId: hashJeffBrainValue(challenge.agentNft),
        agentNft: challenge.agentNft,
        wallet: challenge.wallet,
        ownerEpoch: ownership.ownerEpoch,
        soulManifestSha256: soul.manifestSha256,
        soulBundleRootSha256: soul.bundleRootSha256,
        soulCheckpointSha256: soul.checkpointSha256,
        challengeSha256,
        issuedAt: currentAt,
        expiresAt: new Date(Date.parse(currentAt) + SESSION_TTL_MS).toISOString(),
        status: 'active',
      });
      await holderStage('boot_store_session', () => store.putSession(session));
      return Object.freeze({
        sessionId: session.sessionId,
        instanceId: session.instanceId,
        agentNft: session.agentNft,
        wallet: session.wallet,
        ownerEpoch: session.ownerEpoch,
        soulManifestSha256: session.soulManifestSha256,
        soulBundleRootSha256: session.soulBundleRootSha256,
        soulCheckpointSha256: session.soulCheckpointSha256,
        expiresAt: session.expiresAt,
        mode: 'shadow',
        executionAuthorized: false,
        bootReceiptSha256: hashJeffBrainValue({
          sessionSha256: hashJeffBrainValue(session.sessionId),
          instanceId: session.instanceId,
          agentNftSha256: hashJeffBrainValue(session.agentNft),
          walletSha256: hashJeffBrainValue(session.wallet),
          ownerEpoch: session.ownerEpoch,
          soulManifestSha256: session.soulManifestSha256,
          soulBundleRootSha256: session.soulBundleRootSha256,
          soulCheckpointSha256: session.soulCheckpointSha256,
          challengeSha256,
          issuedAt: session.issuedAt,
          expiresAt: session.expiresAt,
          mode: 'shadow',
          executionAuthorized: false,
        }),
      });
    },

    async remember({ sessionId: rawSessionId, id, content, source, verified = true, expiresAt } = {}) {
      const { session } = await requireLiveSession(rawSessionId);
      return memoryService.remember({
        scope: holderScope(session),
        authorization: holderAuthorization(session, 'canWriteMemory'),
        memory: { id, content, source, verified, expiresAt },
      });
    },

    async run({ sessionId: rawSessionId, objective } = {}) {
      const { session, ownership } = await requireLiveSession(rawSessionId);
      const normalizedObjective = assertJeffText(objective, 'JEFF_HOLDER_OBJECTIVE_INVALID', 4_000);
      const preflightHolderStatus = Object.freeze({
        schema: 'jeff-holder-status-v1',
        agentNft: session.agentNft,
        currentOwner: ownership.currentOwner,
        ownerEpoch: ownership.ownerEpoch,
        observedAt: ownership.observedAt,
        mode: 'shadow',
        executionAuthorized: false,
      });
      const result = await deliberateJeffBrain({
        provider: guardedProvider(session),
        memoryService,
        request: {
          agentNft: session.agentNft,
          objective: normalizedObjective,
          state: {
            proposal: normalizedObjective,
            holderStatus: preflightHolderStatus,
            evidence: [
              {
                source: 'holder-ownership-attestation',
                verified: true,
                sha256: hashJeffBrainValue(preflightHolderStatus),
              },
              {
                source: 'jeff-soul-manifest',
                verified: true,
                sha256: session.soulManifestSha256,
              },
            ],
            safetyFacts: {
              authorized: true,
              funded: true,
              validTransition: true,
              evidenceSufficient: true,
              privacySafe: true,
              validationSafe: true,
              identityIntegrity: 'trusted',
            },
            requiredSafetyFactsComplete: true,
            ownerPolicy: { allowAutonomous: false },
          },
          ownerPolicy: {
            writeRequiresOwnerApproval: true,
            allowedTools: ['holder.status'],
          },
          tools: [{
            name: 'holder.status',
            mode: 'read_only',
            description: 'Read the verified current holder and Agent NFT identity status.',
          }],
          memory: {
            scope: holderScope(session),
            authorization: holderAuthorization(session, 'canReadMemory'),
            maximum: 6,
          },
        },
      });
      if (!verifyJeffBrainReceipt(result.audit)
        || result.mode !== 'shadow'
        || result.executionAuthorized !== false
        || result.actionsExecuted !== 0) {
        throw new Error('JEFF_HOLDER_BRAIN_RESULT_INVALID');
      }
      const toolExecution = await executeHolderStatusTool(session, result);
      const finalOwnership = await resolveLiveOwnership(session);
      if (finalOwnership.ownership.currentOwner !== toolExecution.holderStatus.currentOwner
        || finalOwnership.ownership.ownerEpoch !== toolExecution.holderStatus.ownerEpoch) {
        throw new Error('JEFF_HOLDER_OWNERSHIP_CHANGED');
      }
      const body = {
        schema: 'jeff-holder-action-receipt-v1',
        runtimeVersion: 'jeff-holder-alpha-v1',
        mode: 'shadow',
        executionAuthorized: false,
        actionsExecuted: 0,
        readOnlyToolsExecuted: 1,
        tool: 'holder.status',
        sessionSha256: hashJeffBrainValue(session.sessionId),
        instanceId: session.instanceId,
        agentNftSha256: hashJeffBrainValue(session.agentNft),
        walletSha256: hashJeffBrainValue(session.wallet),
        ownerEpoch: session.ownerEpoch,
        soulManifestSha256: session.soulManifestSha256,
        soulBundleRootSha256: session.soulBundleRootSha256,
        soulCheckpointSha256: session.soulCheckpointSha256,
        objectiveSha256: hashJeffBrainValue(normalizedObjective),
        holderStatusSha256: hashJeffBrainValue(toolExecution.holderStatus),
        toolReceiptSha256: toolExecution.receipt.receiptSha256,
        brainReceiptSha256: result.audit.receiptSha256,
        memoryScopeSha256: result.audit.memoryScopeSha256,
        createdAt: finalOwnership.currentAt,
      };
      const receiptSha256 = hashJeffBrainValue(body);
      const signatureValue = receiptSigner.signDigest(receiptSha256);
      if (typeof signatureValue !== 'string' || !signatureValue) {
        throw new Error('JEFF_HOLDER_RECEIPT_SIGNATURE_INVALID');
      }
      const receipt = Object.freeze({
        ...body,
        receiptSha256,
        signature: Object.freeze({
          algorithm: receiptSigner.algorithm,
          keyId: receiptSigner.keyId,
          value: signatureValue,
        }),
      });
      return Object.freeze({
        holderStatus: toolExecution.holderStatus,
        toolReceipt: toolExecution.receipt,
        result,
        receipt,
      });
    },

    async logout({ sessionId: rawSessionId } = {}) {
      if (!SESSION_ID.test(String(rawSessionId ?? ''))) throw new Error('JEFF_HOLDER_SESSION_INVALID');
      return store.revokeSession(rawSessionId, 'holder_logout', nowIso(now));
    },
  });
}

export const JEFF_HOLDER_RUNTIME = Object.freeze({
  version: 'jeff-holder-alpha-v1',
  challengeTtlMs: CHALLENGE_TTL_MS,
  sessionTtlMs: SESSION_TTL_MS,
  ownershipTtlMs: OWNERSHIP_TTL_MS,
  mode: 'shadow',
  executionAuthority: false,
  productionRequirements: Object.freeze([
    'durable_atomic_store',
    'wallet_signature_verifier',
    'fresh_onchain_ownership_resolver',
    'verified_soul_bundle',
    'authenticated_encryption',
    'ed25519_receipt_key',
  ]),
});
