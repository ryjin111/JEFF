import { createPrivateKey } from 'node:crypto';

import { createJeffBrainProviderFromEnv } from './jeff-brain-http.mjs';
import {
  createJeffAesGcmMemoryCrypto,
  createJeffEd25519ReceiptSigner,
  createJeffHolderRuntime,
} from './jeff-holder-runtime.mjs';
import { createJeffHolderHttpHandler } from './jeff-holder-http.mjs';
import {
  createJeffPostgresHolderStore,
  createJeffPostgresMemoryAdapter,
  createJeffPostgresRateLimiter,
} from './jeff-holder-postgres.mjs';
import {
  createJeffViemOwnershipResolver,
  createJeffViemWalletVerifier,
} from './jeff-holder-evm.mjs';

const MEMORY_KEY = /^[A-Za-z0-9+/]{43}=$/;
const ADDRESS = /^0x[a-fA-F0-9]{40}$/;

function setHeader(response, name, value) {
  if (typeof response.setHeader === 'function') response.setHeader(name, value);
}

function sendStatus(response, statusCode, ready, error) {
  response.statusCode = statusCode;
  setHeader(response, 'cache-control', 'no-store');
  setHeader(response, 'content-type', 'application/json; charset=utf-8');
  setHeader(response, 'content-security-policy', "default-src 'none'; frame-ancestors 'none'");
  setHeader(response, 'referrer-policy', 'no-referrer');
  setHeader(response, 'x-content-type-options', 'nosniff');
  setHeader(response, 'x-frame-options', 'DENY');
  response.end(JSON.stringify({
    schema: ready ? 'jeff-holder-http-status-v1' : 'jeff-holder-http-error-v1',
    ...(ready ? { ready: true, runtimeVersion: 'jeff-holder-alpha-v1' } : { error }),
    mode: 'shadow',
    executionAuthorized: false,
    actionsExecuted: 0,
  }));
}

function memoryKeyFromEnv(env) {
  const encoded = String(env.JEFF_HOLDER_MEMORY_KEY ?? '').trim();
  if (!MEMORY_KEY.test(encoded)) throw new Error('JEFF_HOLDER_DEPLOYMENT_CONFIG_INVALID');
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32 || key.toString('base64') !== encoded) {
    throw new Error('JEFF_HOLDER_DEPLOYMENT_CONFIG_INVALID');
  }
  return key;
}

function receiptPrivateKeyFromEnv(env) {
  const raw = String(env.JEFF_HOLDER_RECEIPT_PRIVATE_KEY ?? '').trim();
  if (!raw) throw new Error('JEFF_HOLDER_DEPLOYMENT_CONFIG_INVALID');
  let privateKey;
  try {
    privateKey = createPrivateKey(raw.replaceAll('\\n', '\n'));
  } catch {
    throw new Error('JEFF_HOLDER_DEPLOYMENT_CONFIG_INVALID');
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('JEFF_HOLDER_DEPLOYMENT_CONFIG_INVALID');
  }
  return privateKey;
}

function allowedAgentNftFromEnv(env) {
  const rawChainId = String(env.JEFF_HOLDER_CHAIN_ID ?? '');
  const collection = String(env.JEFF_HOLDER_COLLECTION ?? '');
  if (!/^[1-9]\d*$/.test(rawChainId) || !ADDRESS.test(collection)) {
    throw new Error('JEFF_HOLDER_DEPLOYMENT_CONFIG_INVALID');
  }
  const chainId = Number(rawChainId);
  if (!Number.isSafeInteger(chainId)) throw new Error('JEFF_HOLDER_DEPLOYMENT_CONFIG_INVALID');
  return Object.freeze({ chainId, collection: collection.toLowerCase() });
}

export function createJeffHolderDeploymentHandler({
  env = process.env,
  database,
  getPublicClient,
  resolveOwnerEpoch,
  clientIdentity,
  fetcher = fetch,
  now = () => new Date().toISOString(),
} = {}) {
  let handler;

  function buildHandler() {
    if (!database || typeof database.query !== 'function'
      || typeof getPublicClient !== 'function'
      || typeof resolveOwnerEpoch !== 'function'
      || typeof clientIdentity !== 'function'
      || typeof fetcher !== 'function'
      || typeof now !== 'function') {
      throw new Error('JEFF_HOLDER_DEPLOYMENT_CONFIG_INVALID');
    }

    const allowedAgentNft = allowedAgentNftFromEnv(env);
    const guardedPublicClient = (chainId) => {
      if (chainId !== allowedAgentNft.chainId) {
        throw new Error('JEFF_HOLDER_AGENT_NFT_DENIED');
      }
      return getPublicClient(chainId);
    };
    const guardedOwnerEpoch = (input) => {
      if (input?.agentNft?.chainId !== allowedAgentNft.chainId
        || String(input?.agentNft?.collection ?? '').toLowerCase() !== allowedAgentNft.collection) {
        throw new Error('JEFF_HOLDER_AGENT_NFT_DENIED');
      }
      return resolveOwnerEpoch(input);
    };
    const store = createJeffPostgresHolderStore({ database });
    const ownershipResolver = createJeffViemOwnershipResolver({
      getPublicClient: guardedPublicClient,
      resolveOwnerEpoch: guardedOwnerEpoch,
      now,
    });
    const runtime = createJeffHolderRuntime({
      store,
      walletVerifier: createJeffViemWalletVerifier({ getPublicClient: guardedPublicClient, now }),
      ownershipResolver,
      provider: createJeffBrainProviderFromEnv(env, fetcher),
      memoryAdapter: createJeffPostgresMemoryAdapter({ database }),
      memoryCrypto: createJeffAesGcmMemoryCrypto({ key: memoryKeyFromEnv(env) }),
      receiptSigner: createJeffEd25519ReceiptSigner({
        privateKey: receiptPrivateKeyFromEnv(env),
        keyId: env.JEFF_HOLDER_RECEIPT_KEY_ID,
      }),
      relyingPartyOrigin: env.JEFF_HOLDER_ORIGIN,
      authorizeAgentNft(agentNft) {
        return agentNft.chainId === allowedAgentNft.chainId
          && agentNft.collection === allowedAgentNft.collection;
      },
      now,
    });

    return createJeffHolderHttpHandler({
      runtime,
      relyingPartyOrigin: env.JEFF_HOLDER_ORIGIN,
      holderUri: env.JEFF_HOLDER_URI,
      rateLimiter: createJeffPostgresRateLimiter({ database, now }),
      clientIdentity,
      readiness: () => true,
    });
  }

  return async function jeffHolderDeploymentHandler(request, response) {
    const method = String(request?.method ?? '').toUpperCase();
    if (env.JEFF_HOLDER_ENABLED !== 'true') {
      return sendStatus(response, method === 'GET' ? 200 : 503, false, 'SERVICE_DISABLED');
    }
    try {
      handler ??= buildHandler();
    } catch {
      return sendStatus(response, method === 'GET' ? 200 : 503, false, 'SERVICE_NOT_CONFIGURED');
    }
    return handler(request, response);
  };
}

export const JEFF_HOLDER_DEPLOYMENT = Object.freeze({
  enabledByDefault: false,
  requiredFlag: 'JEFF_HOLDER_ENABLED=true',
  mode: 'shadow',
  executionAuthorized: false,
  actionsExecuted: 0,
});
