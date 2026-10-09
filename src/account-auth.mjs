import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { recoverMessageAddress, getAddress } from 'viem';
import { normalizeJeffOpenClawAccountScope } from 'jeff-agent-nft/openclaw';

const digest = value => createHash('sha256').update(value).digest('hex');
export function createAccountSessions({ origin, chainId, dataRoot, now = () => Date.now() }) {
  const challenges = new Map(), sessions = new Map();
  const directory = resolve(dataRoot, 'accounts');
  const path = scope => resolve(directory, `${digest(`${scope.chainId}:${scope.owner}`)}.json`);
  const prune = () => {
    for (const map of [challenges, sessions]) for (const [key, item] of map) if (item.expiresAt <= now()) map.delete(key);
  };
  async function registered(scope) {
    try { return JSON.stringify(JSON.parse(await readFile(path(scope), 'utf8')).scope) === JSON.stringify(normalizeJeffOpenClawAccountScope(scope)); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  return {
    registered,
    has(token) { prune(); return typeof token === 'string' && sessions.has(digest(token)); },
    async challenge({ wallet }) {
      prune();
      if (challenges.size > 100 || sessions.size > 1000) throw new Error('JEFF_AUTH_BUSY');
      let scope;
      try { scope = normalizeJeffOpenClawAccountScope({ kind: 'account', chainId, owner: getAddress(wallet).toLowerCase() }); }
      catch { throw new Error('JEFF_ACCOUNT_INVALID'); }
      const nonce = randomBytes(24).toString('hex'), expiresAt = now() + 300000;
      const message = `Simple JEFF standalone account login\nOrigin: ${origin}\nWallet: ${scope.owner}\nChain: ${chainId}\nNonce: ${nonce}\nExpires: ${new Date(expiresAt).toISOString()}\nThis signature creates or opens your wallet account. No NFT is required. It authorizes a session only, with no token spending or external actions.`;
      challenges.set(nonce, { scope, message, expiresAt });
      return { nonce, message, expiresAt: new Date(expiresAt).toISOString() };
    },
    async verify({ nonce, signature }) {
      prune(); const challenge = challenges.get(nonce); challenges.delete(nonce);
      if (!challenge) throw new Error('JEFF_CHALLENGE_EXPIRED');
      let signer;
      try { signer = (await recoverMessageAddress({ message: challenge.message, signature })).toLowerCase(); }
      catch { throw new Error('JEFF_SIGNATURE_INVALID'); }
      if (signer !== challenge.scope.owner) throw new Error('JEFF_SIGNATURE_INVALID');
      if (challenge.expiresAt <= now()) throw new Error('JEFF_CHALLENGE_EXPIRED');
      const exists = await registered(challenge.scope);
      if (challenge.expiresAt <= now()) throw new Error('JEFF_CHALLENGE_EXPIRED');
      if (!exists) {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const file = path(challenge.scope), temporary = `${file}.${randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify({ schema: 'simple-jeff-account-v1', scope: challenge.scope, createdAt: new Date(now()).toISOString() }), { mode: 0o600 });
        await rename(temporary, file);
      }
      if (challenge.expiresAt <= now()) throw new Error('JEFF_CHALLENGE_EXPIRED');
      const token = randomBytes(32).toString('hex'), expiresAt = now() + 3600000;
      sessions.set(digest(token), { scope: challenge.scope, expiresAt });
      return { token, scope: challenge.scope, expiresAt: new Date(expiresAt).toISOString() };
    },
    async authenticate(token) {
      prune();
      if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw new Error('JEFF_SESSION_REQUIRED');
      const key = digest(token), session = sessions.get(key);
      if (!session || !await registered(session.scope)) throw new Error('JEFF_SESSION_REQUIRED');
      // The registration read must not revive a logged-out or expired session.
      prune();
      if (sessions.get(key) !== session) throw new Error('JEFF_SESSION_REQUIRED');
      return session.scope;
    },
    logout(token) { if (typeof token === 'string') sessions.delete(digest(token)); },
  };
}
