export const JOB_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function validateNftDiscovery(value, config, wallet) {
  if (value?.complete !== true) throw new Error('JEFF_DISCOVERY_UNAVAILABLE');
  if (value.chainId !== config.chainId || value.collection !== config.collection.toLowerCase() || value.wallet !== wallet
    || !Number.isSafeInteger(value.balance) || value.balance < 0 || !Array.isArray(value.tokenIds)
    || value.tokenIds.length !== value.balance || new Set(value.tokenIds).size !== value.tokenIds.length
    || value.tokenIds.some(id => typeof id !== 'string' || !/^(0|[1-9]\d{0,77})$/.test(id) || BigInt(id) >= 2n ** 256n)
    || typeof value.blockNumber !== 'string' || !/^(0|[1-9]\d{0,77})$/.test(value.blockNumber)) throw new Error('JEFF_DISCOVERY_INVALID');
  return value;
}
export function validScope(scope) {
  if (scope?.kind === 'account') return Boolean(Number.isSafeInteger(scope.chainId) && scope.chainId > 0
    && /^0x[a-f0-9]{40}$/.test(scope.owner) && scope.collection === undefined && scope.tokenId === undefined && scope.ownerEpoch === undefined);
  return Boolean(scope && Number.isSafeInteger(scope.chainId) && scope.chainId > 0
    && scope.kind === undefined
    && /^0x[a-f0-9]{40}$/.test(scope.collection) && /^0x[a-f0-9]{40}$/.test(scope.owner)
    && /^(0|[1-9]\d*)$/.test(scope.tokenId) && BigInt(scope.tokenId) < 2n ** 256n
    && Number.isSafeInteger(scope.ownerEpoch) && scope.ownerEpoch >= 0);
}
export function scopeKey(scope) {
  if (!validScope(scope)) throw new Error('JEFF_SCOPE_INVALID');
  if (scope.kind === 'account') return ['account', scope.chainId, scope.owner].join(':');
  return [scope.chainId, scope.collection, scope.tokenId, scope.owner, scope.ownerEpoch].join(':');
}
export function validSession(session, config, now = Date.now()) {
  return Boolean(session && /^[a-f0-9]{64}$/.test(session.token) && validScope(session.scope)
    && session.scope.chainId === config.chainId
    && (session.scope.kind === 'account' ? config.standaloneAccounts === true : session.scope.collection === config.collection.toLowerCase())
    && Date.parse(session.expiresAt) > now);
}
export function jobIndex(value) {
  return Array.isArray(value) ? [...new Set(value.filter(id => typeof id === 'string' && JOB_ID.test(id)))].slice(0, 30) : [];
}
export async function validateRecord(record, scope, expectedId) {
  if (!record || record.schema !== 'jeff-openclaw-job-v1' || !JOB_ID.test(record.id)
    || (expectedId && record.id !== expectedId) || !validScope(record.scope)
    || typeof record.objective !== 'string' || record.objective.length > 4000
    || scopeKey(record.scope) !== scopeKey(scope) || record.externalActionsAuthorized !== false
    || !['running', 'completed', 'completed_unsaved', 'failed', 'interrupted'].includes(record.status)) throw new Error('JEFF_RESULT_INVALID');
  if (['completed', 'completed_unsaved'].includes(record.status)) {
    if (typeof record.text !== 'string' || !record.text.trim() || record.text.length > 65536
      || typeof record.objective !== 'string' || !Number.isFinite(Date.parse(record.finishedAt))
      || (record.status === 'completed' && record.saved !== true)
      || (record.status === 'completed_unsaved' && record.saved !== false)) throw new Error('JEFF_RESULT_INVALID');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(record.text));
    const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    if (hash !== record.textSha256) throw new Error('JEFF_RESULT_INVALID');
  }
  return record;
}
export const labels = {
  JEFF_DISCOVERY_UNAVAILABLE: 'Couldn\'t check this wallet\'s Rooms. Try again.',
  JEFF_DISCOVERY_INVALID: 'The Room list could not be verified. Try again.',
  JEFF_WALLET_CHANGED: 'Wallet or network changed. Connect again to load the current wallet\'s NFTs.',
  JEFF_OPENCLAW_ACCOUNT_DENIED: 'This account is unavailable. Sign in again to open your registered wallet workspace.',
  JEFF_ACCOUNT_INVALID: 'The wallet account could not be registered. Check the connected wallet and try again.',
  JEFF_HOSTING_INACTIVE: 'Hosting is inactive for this workspace. Activate or renew hosting to run new tasks. Saved results are still accessible.',
  JEFF_CHECKOUT_UNAVAILABLE: 'Monthly checkout is not available yet. No payment has been requested.',
  JEFF_PRICE_UNAVAILABLE: 'A $CLOCKERS price quote is unavailable. No payment was requested. Try again later.',
  JEFF_HOSTING_INVALID: 'Hosting details could not be verified. New tasks and checkout remain unavailable.',
  JEFF_INVOICE_INVALID: 'This invoice is invalid, expired, or belongs to another holder workspace. No payment was sent.',
  JEFF_INVOICE_EXPIRED: 'The invoice expired. Keep your payment reference and contact support before sending another payment.',
  JEFF_PAYMENT_CONFIRMING: 'The payment is waiting for chain confirmations. Keep the same transaction reference; do not pay again.',
  JEFF_PAYMENT_ALREADY_USED: 'That transaction has already been used. No additional hosting time was applied.',
  JEFF_PAYMENT_BINDING_INVALID: 'The transaction does not match this invoice. Check the token, amount, recipient, and payment time.',
  JEFF_PAYMENT_FAILED: 'The chain reports that this payment failed. Hosting was not activated.',
  JEFF_PAYMENT_CHAIN_MISMATCH: 'The payment network does not match this invoice. Hosting was not activated.',
  JEFF_INVOICE_DENIED: 'This invoice belongs to a different holder workspace.',
  JEFF_TOKEN_DETAILS_UNAVAILABLE: 'The token amount could not be displayed safely. Wallet payment is disabled. No transaction was sent.',
  JEFF_WALLET_NETWORK_MISMATCH: 'Switch your wallet to the invoice network and sign in again before paying.',
  JEFF_USAGE_LIMIT_REACHED: 'The hourly task limit was reached. Check hosting for the next available task time. Saved results are still available.',
  JEFF_TASK_ALLOWANCE_EXHAUSTED: 'Your included task allowance is used up. Check hosting for period details. Saved results are still available.',
  JEFF_MODEL_NOT_CONFIGURED: 'The model connection is not configured yet. Saved result retrieval is still available.',
  JEFF_OWNER_REQUIRED: 'This wallet does not currently hold that NFT. Choose an NFT you own.',
  JEFF_OPENCLAW_OWNER_REVOKED: 'NFT ownership changed. Sign in again to access your current workspace.',
  JEFF_SESSION_REVOKED: 'NFT ownership changed. Sign in again to access your current workspace.',
  JEFF_SESSION_REQUIRED: 'Your session expired or the service restarted. Sign in again; saved results remain on the server.',
  JEFF_CHALLENGE_EXPIRED: 'The login message expired. Sign in again for a fresh message.',
  JEFF_SIGNATURE_INVALID: 'The wallet signature could not be verified. Sign in again.',
  JEFF_OPENCLAW_RESULT_NOT_FOUND: 'That result was not found in this holder workspace.',
  JEFF_OPENCLAW_BUSY: 'JEFF already has a task running in this workspace. Wait for it to finish.',
  JEFF_RESULT_INVALID: 'This result did not match the current workspace or pass the integrity check. It was withheld.',
  JEFF_OPENCLAW_RESULT_INVALID: 'The saved result failed its integrity check. It was withheld.',
  JEFF_WALLET_UNAVAILABLE: 'Open this page in a browser with an Ethereum wallet extension, then sign in.',
  JEFF_SERVICE_UNAVAILABLE: 'The service is unavailable. Check the connection before trying again.',
  JEFF_NETWORK_FAILURE: 'The request was interrupted. A task may still be running; do not submit it again automatically.',
  JEFF_STORAGE_UNAVAILABLE: 'Browser storage is unavailable. Keep the job ID or download the result so you can retrieve it later.',
};
export function errorLabel(error) {
  return Number(error?.code) === 4001 ? 'The wallet request was declined. You can try again when ready.'
    : labels[error?.message] || (/^JEFF_PRICE_/.test(error?.message) ? labels.JEFF_PRICE_UNAVAILABLE : 'JEFF could not finish this request. No new task was submitted automatically.');
}
