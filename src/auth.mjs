import { createHash, randomBytes } from 'node:crypto';
import { recoverMessageAddress, getAddress } from 'viem';
import { normalizeJeffOpenClawScope } from 'jeff-agent-nft/openclaw';

const digest = value => createHash('sha256').update(value).digest('hex');
export function createHolderSessions({ origin, chainId, collection, resolveOwner, now = () => Date.now() }) {
  const challenges = new Map(); const sessions = new Map();
  const prune = () => {
    for (const map of [challenges, sessions]) for (const [key, item] of map) if (item.expiresAt <= now()) map.delete(key);
  };
  return {
    async challenge({ wallet, tokenId }) {
      prune();
      if (challenges.size > 100 || sessions.size > 1000) throw new Error('JEFF_AUTH_BUSY');
      const owner = getAddress(wallet).toLowerCase();
      const candidate = normalizeJeffOpenClawScope({ chainId, collection, tokenId, owner, ownerEpoch: 0 });
      const state = await resolveOwner(candidate);
      if (state.owner !== owner) throw new Error('JEFF_OWNER_REQUIRED');
      const scope = normalizeJeffOpenClawScope({ ...candidate, ownerEpoch: state.ownerEpoch });
      const nonce = randomBytes(24).toString('hex');
      const expiresAt = now() + 300000;
      const message = `Simple JEFF holder login\nOrigin: ${origin}\nWallet: ${owner}\nChain: ${chainId}\nCollection: ${collection}\nToken: ${tokenId}\nOwner epoch: ${scope.ownerEpoch}\nNonce: ${nonce}\nExpires: ${new Date(expiresAt).toISOString()}\nThis signature authorizes a holder session only. No token spending or external actions.`;
      challenges.set(nonce, { scope, message, expiresAt });
      return { nonce, message, expiresAt: new Date(expiresAt).toISOString() };
    },
    async verify({ nonce, signature }) {
      prune();
      const challenge = challenges.get(nonce);
      challenges.delete(nonce);
      if (!challenge) throw new Error('JEFF_CHALLENGE_EXPIRED');
      let signer;
      try { signer = (await recoverMessageAddress({ message: challenge.message, signature })).toLowerCase(); }
      catch { throw new Error('JEFF_SIGNATURE_INVALID'); }
      const state = await resolveOwner(challenge.scope);
      if (signer !== challenge.scope.owner || state.owner !== signer || state.ownerEpoch !== challenge.scope.ownerEpoch) throw new Error('JEFF_OWNER_REQUIRED');
      const token = randomBytes(32).toString('hex');
      const expiresAt = now() + 3600000;
      sessions.set(digest(token), { scope: challenge.scope, expiresAt });
      return { token, scope: challenge.scope, expiresAt: new Date(expiresAt).toISOString() };
    },
    async authenticate(token) {
      prune();
      if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw new Error('JEFF_SESSION_REQUIRED');
      const session = sessions.get(digest(token));
      if (!session) throw new Error('JEFF_SESSION_REQUIRED');
      const state = await resolveOwner(session.scope);
      if (state.owner !== session.scope.owner || state.ownerEpoch !== session.scope.ownerEpoch) {
        sessions.delete(digest(token)); throw new Error('JEFF_SESSION_REVOKED');
      }
      return session.scope;
    },
    logout(token) { if (typeof token === 'string') sessions.delete(digest(token)); },
  };
}
