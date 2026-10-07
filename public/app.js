import { JOB_ID, scopeKey, validSession, jobIndex, validateRecord, errorLabel } from './client.js';
import { validateHosting, validateInvoice, validUsdPlan, formatUsdCents, formatTokenAmount, transferData } from './billing.js';
const $ = id => document.getElementById(id);
const SESSION_KEY = 'simple-jeff:session:v1';
let config, session, provider, loginWallet, busy = false, waiting = false, version = 0, currentResult, expiryTimer, pollTimer;
let serverJobs = [];
let hosting, invoice, tokenDecimals, hostingTimer;
let accessMode = new URLSearchParams(location.search).get('mode') === 'standalone' ? 'standalone' : 'holder';
const standaloneSession = () => session?.scope?.kind === 'account';
const checkoutAvailable = () => Boolean(session && config?.billingEnabled && hosting?.checkoutEnabled);
const hostingActive = () => Boolean(hosting?.active && Date.parse(hosting.expiresAt) > Date.now());
const invoiceKey = () => `simple-jeff:invoice:v1:${scopeKey(session.scope)}`;
const requests = new Set();
const historyKey = () => `simple-jeff:jobs:v1:${scopeKey(session.scope)}`;
function showNotice(message, error = false) { $('notice').textContent = message; $('notice').className = error ? 'notice error' : 'notice'; $('notice').hidden = !message; }
function readStorage(storage, key) { try { return JSON.parse(storage.getItem(key) || 'null'); } catch { return null; } }
function saveSession() { try { session ? sessionStorage.setItem(SESSION_KEY, JSON.stringify(session)) : sessionStorage.removeItem(SESSION_KEY); } catch { /* The in-memory session still works. */ } }
function ids() { return session ? jobIndex(readStorage(localStorage, historyKey())) : []; }
function rememberJob(id) {
  try { localStorage.setItem(historyKey(), JSON.stringify(jobIndex([id, ...ids()]))); }
  catch { showNotice(errorLabel(new Error('JEFF_STORAGE_UNAVAILABLE')), true); }
}
function formatDate(value, seconds = false) { return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: seconds ? 'medium' : 'short', timeZone: 'UTC' }).format(new Date(value)) + ' UTC'; }
async function api(path, { method = 'GET', body, authenticated = false } = {}) {
  const controller = new AbortController(); requests.add(controller);
  try {
    const headers = {}; if (body) headers['Content-Type'] = 'application/json';
    if (authenticated) { if (!session) throw new Error('JEFF_SESSION_REQUIRED'); headers.Authorization = `Bearer ${session.token}`; }
    const response = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: controller.signal, cache: 'no-store' });
    const value = await response.json();
    if (!response.ok) { const error = new Error(value.error || 'JEFF_SERVICE_UNAVAILABLE'); error.status = response.status; throw error; }
    return value;
  } catch (error) { if (error.name === 'TypeError') throw new Error('JEFF_NETWORK_FAILURE'); throw error; }
  finally { requests.delete(controller); }
}
function clearResult() { currentResult = undefined; $('result').hidden = true; $('saved-state').hidden = true; $('empty-result').hidden = false; for (const id of ['result-text', 'result-objective', 'result-id', 'result-date', 'result-model']) $(id).textContent = ''; }
function invalidate() {
  const token = session?.token;
  version++; session = undefined; loginWallet = undefined; busy = false; waiting = false; serverJobs = []; hosting = undefined; invoice = undefined; tokenDecimals = undefined; saveSession(); clearTimeout(expiryTimer); clearTimeout(pollTimer); clearTimeout(hostingTimer);
  requests.forEach(controller => controller.abort()); requests.clear(); clearResult();
  $('objective').value = ''; $('job-id').value = ''; $('transaction-hash').value = ''; render();
  if (token) fetch('/api/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', keepalive: true }).catch(() => {});
}
function handleError(error) {
  if (/^JEFF_(SESSION_|OPENCLAW_OWNER_REVOKED|OPENCLAW_ACCOUNT_DENIED)/.test(error.message)) invalidate();
  if (error.message === 'JEFF_HOSTING_INACTIVE' && hosting) { hosting = { ...hosting, active: false }; render(); }
  showNotice(errorLabel(error), true);
}
function renderHistory() {
  const list = $('history-list'); list.replaceChildren();
  $('history-count').textContent = '0';
  if (!session) { $('history-copy').textContent = 'Sign in to retrieve results. This browser remembers job IDs, never result text.'; return; }
  const known = jobIndex([...serverJobs.map(record => record.id), ...ids()]);
  $('history-count').textContent = String(known.length);
  $('history-copy').textContent = known.length ? `${known.length} job${known.length === 1 ? '' : 's'} in this workspace. Server history includes running tasks and results that need a save retry.` : 'No jobs in this workspace yet. You can also retrieve a result using its job ID.';
  for (const id of known) {
    const record = serverJobs.find(job => job.id === id);
    const button = document.createElement('button'); button.className = 'history-item';
    const title = document.createElement('span'); title.className = 'history-objective'; title.textContent = record?.objective.slice(0, 120) || 'Open saved result';
    const state = document.createElement('span'); state.className = 'history-state'; state.dataset.status = record?.status || 'unknown';
    state.textContent = ({ completed: 'Saved', completed_unsaved: 'Needs save', running: 'Running', failed: 'Failed', interrupted: 'Interrupted' })[record?.status] || 'Saved ID';
    const reference = document.createElement('span'); reference.className = 'history-id'; reference.textContent = id;
    button.append(title, state, reference); button.disabled = busy || waiting;
    button.addEventListener('click', () => retrieve(id, { focusResult: true })); list.append(button);
  }
}
function render() {
  const standalone = session ? standaloneSession() : accessMode === 'standalone';
  document.body.classList.toggle('signed-in', Boolean(session));
  renderAccess();
  $('logout').hidden = !session; $('logout').disabled = false;
  $('login-form').hidden = Boolean(session); $('scope-details').hidden = !session;
  $('token-id').disabled = busy; $('login').disabled = !config || busy || (standalone && config?.standaloneAccounts !== true);
  $('login').textContent = busy && !session ? 'Waiting for wallet' : standalone && config?.standaloneAccounts !== true ? 'Standalone signup coming soon' : 'Connect wallet & sign in';
  $('agent-name').textContent = session ? standalone ? 'My JEFF' : `Room #${session.scope.tokenId}` : standalone ? 'Create your JEFF account' : 'Connect your NFT';
  $('identity-copy').textContent = session ? standalone ? 'A private agent workspace controlled by your wallet.' : 'Private workspace for this NFT, holder, and ownership epoch.' : standalone ? config?.standaloneAccounts === true ? 'Sign in with your wallet. No NFT or Room ID is required.' : 'Standalone wallet signup is being configured. NFT holder access is available now.' : 'Sign in with the wallet that holds your Clockers Agent NFT.';
  $('holder-wallet').textContent = session?.scope.owner || '';
  $('owner-epoch').textContent = session ? String(session.scope.ownerEpoch) : '';
  $('session-expiry').textContent = session ? formatDate(session.expiresAt) : '';
  $('objective').disabled = !session || busy || waiting || !config?.modelConfigured || !hostingActive();
  document.querySelectorAll('[data-prompt]').forEach(button => { button.disabled = $('objective').disabled; });
  $('run').disabled = !session || busy || waiting || !config?.modelConfigured || !hostingActive();
  $('run').textContent = (busy || waiting) && session ? 'Working…' : 'Run JEFF';
  $('job-id').disabled = !session || busy || waiting; $('retrieve').disabled = !session || busy || waiting;
  $('refresh').disabled = !session || busy || waiting;
  $('retry-save').disabled = !session || busy || waiting;
  $('job-status').textContent = !session ? 'Sign in first' : busy ? 'Working' : waiting ? 'Running' : currentResult?.status === 'completed_unsaved' ? 'Needs save' : currentResult?.status === 'completed' ? 'Complete' : currentResult?.status === 'failed' ? 'Failed' : currentResult?.status === 'interrupted' ? 'Interrupted' : !hostingActive() ? 'Hosting inactive' : config?.modelConfigured ? 'Ready' : 'Model unavailable';
  $('task-hint').textContent = !session ? 'Sign in to run a task or retrieve a saved result.' : !hosting ? 'Checking hosting access. Saved results remain accessible.' : !hostingActive() ? 'Hosting is inactive. Activate or renew to run new tasks; saved results remain accessible.' : !config?.modelConfigured ? 'The model connection is not configured. You can still retrieve saved results.' : waiting ? `Task ${currentResult?.id || ''} is running. You can return later; it appears in server history.` : 'A task can take up to 150 seconds. Its job ID is available immediately.';
  renderHistory(); renderHosting();
}
function renderAccess() {
  const standalone = session ? standaloneSession() : accessMode === 'standalone';
  $('holder-mode').setAttribute('aria-pressed', String(!standalone));
  $('standalone-mode').setAttribute('aria-pressed', String(standalone));
  $('holder-mode').disabled = Boolean(session) || busy; $('standalone-mode').disabled = Boolean(session) || busy;
  $('token-field').hidden = standalone; $('token-id').required = !standalone;
  $('epoch-field').hidden = standalone;
  $('wallet-label').textContent = standalone ? 'Account wallet' : 'Holder wallet';
  $('objective').placeholder = 'Describe an idea, share some notes, or ask for a plan.';
  $('workspace-type').textContent = standalone ? 'Simple JEFF' : 'Agent NFT';
  $('product-eyebrow').textContent = standalone ? 'SIMPLE JEFF / PRIVATE WORKSPACE' : 'CLOCKERS / AGENT NFT';
  $('product-heading').innerHTML = standalone ? 'Good work starts here<span>.</span>' : 'Your NFT. Your workspace<span>.</span>';
  $('product-lede').textContent = standalone ? 'Give JEFF a task. Come back to a useful result. No NFT needed.' : 'A private workspace, opened by the wallet that holds your Agent NFT.';
  $('login-boundary').textContent = standalone ? 'Login proves control of your wallet. It does not approve spending.' : 'Login proves NFT ownership. It does not approve spending.';
  $('signup-copy').textContent = standalone ? 'Standalone wallet accounts do not require an NFT.' : 'Use Simple JEFF for standalone access without an NFT.';
}
function switchAccess(mode) {
  if (session || busy) return;
  accessMode = mode; showNotice('');
  const url = new URL(location.href); url.searchParams.set('mode', mode === 'standalone' ? 'standalone' : 'nft'); history.replaceState(null, '', url);
  render();
}
$('holder-mode').addEventListener('click', () => switchAccess('holder'));
$('standalone-mode').addEventListener('click', () => switchAccess('standalone'));
document.querySelectorAll('[data-prompt]').forEach(button => button.addEventListener('click', () => {
  if ($('objective').disabled) return;
  $('objective').value = button.dataset.prompt; $('objective').focus();
}));
function syncNavigation() {
  const destination = ['#saved-results', '#hosting'].includes(location.hash) ? location.hash : '#workspace';
  document.querySelectorAll('.side-nav a').forEach(link => {
    const selected = link.getAttribute('href') === destination;
    link.classList.toggle('selected', selected);
    if (selected) link.setAttribute('aria-current', 'location'); else link.removeAttribute('aria-current');
  });
}
window.addEventListener('hashchange', syncNavigation);
syncNavigation();
function scheduleExpiry() { clearTimeout(expiryTimer); if(session) expiryTimer = setTimeout(() => { invalidate(); showNotice('Your session expired. Sign in again to retrieve saved results.'); }, Math.max(0, Date.parse(session.expiresAt) - Date.now())); }
function bindProvider(next) {
  if (provider === next) return;
  provider?.removeListener?.('accountsChanged', walletChanged); provider?.removeListener?.('chainChanged', walletChanged);
  provider = next; provider?.on?.('accountsChanged', walletChanged); provider?.on?.('chainChanged', walletChanged);
}
function walletChanged() { if (!session && !loginWallet) return; invalidate(); showNotice('Wallet or network changed. Sign in again for your current workspace.'); }
$('login-form').addEventListener('submit', async event => {
  event.preventDefault(); if (busy || !config) return;
  const accountLogin = accessMode === 'standalone';
  if (accountLogin && config.standaloneAccounts !== true) { showNotice('Standalone signup is not available on this deployment yet.'); return; }
  const tokenId = $('token-id').value.trim();
  if (!accountLogin && (!/^(0|[1-9]\d*)$/.test(tokenId) || BigInt(tokenId) >= 2n ** 256n)) { showNotice('Enter a valid Room / token ID.', true); return; }
  const authPath = accountLogin ? '/api/account/auth' : '/api/auth';
  const operation = ++version; busy = true; clearResult(); showNotice(accountLogin ? 'Approve wallet access, then sign the standalone account login message.' : 'Approve wallet access, then sign the holder login message.'); render();
  let candidate;
  try {
    bindProvider(window.ethereum); if (!provider?.request) throw new Error('JEFF_WALLET_UNAVAILABLE');
    const accounts = await provider.request({ method: 'eth_requestAccounts' }); if (operation !== version) return;
    const wallet = accounts?.[0]?.toLowerCase(); if (!/^0x[a-f0-9]{40}$/.test(wallet)) throw new Error('JEFF_WALLET_UNAVAILABLE');
    loginWallet = wallet;
    const challenge = await api(`${authPath}/challenge`, { method: 'POST', body: accountLogin ? { wallet } : { wallet, tokenId } }); if (operation !== version) return;
    const message = '0x' + Array.from(new TextEncoder().encode(challenge.message), byte => byte.toString(16).padStart(2, '0')).join('');
    const signature = await provider.request({ method: 'personal_sign', params: [message, wallet] }); if (operation !== version) return;
    candidate = await api(`${authPath}/verify`, { method: 'POST', body: { nonce: challenge.nonce, signature } });
    if (operation !== version) { fetch('/api/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${candidate.token}` } }).catch(() => {}); return; }
    if (!validSession(candidate, config) || candidate.scope.owner !== wallet
      || (accountLogin ? candidate.scope.kind !== 'account' : candidate.scope.kind !== undefined || candidate.scope.tokenId !== tokenId)) throw new Error('JEFF_SCOPE_INVALID');
    session = candidate; saveSession(); scheduleExpiry(); showNotice('Signed in. Your workspace is ready for saved result retrieval.');
  } catch (error) { if (operation === version) handleError(error); }
  finally { if (operation === version) { loginWallet = undefined; busy = false; render(); if (session) refreshWorkspace(); } }
});
function displayRecord(record) {
  currentResult = record; $('result-objective').textContent = record.objective; $('result-text').textContent = record.text;
  $('result-id').textContent = record.id; $('result-date').textContent = formatDate(record.finishedAt);
  $('result-model').textContent = record.model || 'Not reported'; $('saved-state').textContent = record.saved ? 'Saved to workspace' : 'Not saved yet';
  $('retry-save').hidden = record.status !== 'completed_unsaved';
  $('saved-state').hidden = false; $('empty-result').hidden = true; $('result').hidden = false;
}
function acceptRecord(record) {
  clearTimeout(pollTimer); waiting = record.status === 'running';
  clearResult(); currentResult = record;
  if (waiting) { showNotice(`JEFF is working. Job ID: ${record.id}. You can return to this task from server history.`); pollTimer = setTimeout(() => retrieve(record.id, { poll: true }), 2000); }
  else if (['completed', 'completed_unsaved'].includes(record.status)) { displayRecord(record); showNotice(record.saved ? 'Task complete. Your result is saved and can be retrieved later.' : 'The result is ready, but saving failed. Retry save without running the model again. Pending output is retained only while this service process stays running.', !record.saved); }
  else showNotice(record.status === 'interrupted' ? 'This task was interrupted by a service restart. No completed output is available. Review the task before starting a new one.' : 'This task failed. No completed result was saved.', true);
  serverJobs = [record, ...serverJobs.filter(job => job.id !== record.id)];
  rememberJob(record.id);
}
async function retrieve(id, { poll = false, focusResult = false } = {}) {
  if (!session || busy || (waiting && !poll)) return;
  if (!JOB_ID.test(id)) { showNotice('Enter a valid saved job ID.', true); return; }
  const operation = version, scope = session.scope; busy = true; if (!poll) clearResult(); showNotice(standaloneSession() ? 'Checking account access and retrieving your saved result.' : 'Checking ownership and retrieving your saved result.'); render();
  try {
    const record = await api(`/api/jobs/${id}`, { authenticated: true });
    await validateRecord(record, scope, id); if (operation !== version) return;
    acceptRecord(record);
  } catch (error) { if (operation === version) { waiting = false; clearTimeout(pollTimer); handleError(error); } }
  finally {
    if (operation === version) {
      busy = false; render();
      if (focusResult && currentResult?.id === id && !$('result').hidden) $('result-heading').focus();
    }
  }
}
$('task-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!session || busy || waiting || !config?.modelConfigured || !hostingActive()) return;
  const objective = $('objective').value.trim(); if (!objective || objective.length > 4000) return;
  const operation = version, scope = session.scope; busy = true; clearResult(); showNotice('Submitting your task. JEFF will return its job ID immediately.'); render();
  try {
    const record = await api('/api/jobs', { method: 'POST', body: { objective }, authenticated: true });
    await validateRecord(record, scope); if (operation !== version) return;
    acceptRecord(record);
  } catch (error) { if (operation === version) handleError(error); }
  finally { if (operation === version) { busy = false; render(); } }
});
async function refreshHistory() {
  if (!session || busy || waiting) return;
  const operation = version, scope = session.scope; busy = true; render();
  let latest;
  try {
    const response = await api('/api/jobs', { authenticated: true });
    if (!Array.isArray(response.jobs)) throw new Error('JEFF_RESULT_INVALID');
    const records = await Promise.all(response.jobs.map(record => validateRecord(record, scope)));
    if (operation !== version) return;
    serverJobs = records; latest = records[0]?.id || ids()[0];
  } catch (error) { if (operation === version) handleError(error); }
  finally { if (operation === version) { busy = false; render(); if (latest) retrieve(latest); } }
}
$('retrieve-form').addEventListener('submit', event => { event.preventDefault(); retrieve($('job-id').value.trim().toLowerCase(), { focusResult: true }); });
$('refresh').addEventListener('click', refreshHistory);
$('retry-save').addEventListener('click', async () => {
  if (!session || busy || currentResult?.status !== 'completed_unsaved') return;
  const operation = version, scope = session.scope, id = currentResult.id; busy = true; showNotice('Retrying storage of the existing result. The model is not being rerun.'); render();
  try {
    const record = await api(`/api/jobs/${id}/retry-save`, { method: 'POST', authenticated: true });
    await validateRecord(record, scope, id); if (operation !== version) return; acceptRecord(record);
  } catch (error) { if (operation === version) handleError(error); }
  finally { if (operation === version) { busy = false; render(); } }
});
$('logout').addEventListener('click', () => { invalidate(); showNotice('Logged out. Private output has been cleared from this page.'); });
$('download').addEventListener('click', () => {
  if (!currentResult || !session) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(currentResult, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = `jeff-result-${currentResult.id}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
function renderHosting() {
  const active = hostingActive();
  const plan = hosting?.plan || config?.plan;
  $('plan-price-summary').hidden = !validUsdPlan(plan);
  $('plan-price').textContent = validUsdPlan(plan) ? formatUsdCents(plan.usdCents) : '';
  $('plan-price-copy').textContent = config?.billingEnabled ? 'Paid in $CLOCKERS. Your invoice fixes the exact token amount before payment.' : 'Paid in $CLOCKERS. Monthly AI allowance will be confirmed before checkout opens.';
  $('hosting-status').textContent = !session ? 'Sign in to view' : !hosting ? 'Checking' : active ? 'Active' : 'Inactive';
  $('hosting-status').className = 'status ' + (hosting ? active ? 'active' : 'inactive' : '');
  $('hosting-copy').textContent = !session ? 'Sign in to view hosting access and expiry.' : !hosting ? 'Loading your hosting entitlement.' : active ? standaloneSession() ? 'Hosting access is active for your wallet account.' : 'Hosting access is active for this NFT. Its private workspace stays tied to the current holder.' : 'Hosting is inactive. You can retrieve existing results; new tasks need activation or renewal.';
  $('hosting-plan').textContent = !hosting ? 'Not loaded' : hosting.source === 'pilot' ? 'Pilot access' : hosting.source === 'paid' ? '30-day hosting' : 'Not active';
  $('hosting-expiry').textContent = hosting?.expiresAt ? formatDate(hosting.expiresAt) : 'No active term';
  $('hosting-usage').textContent = hosting ? validUsdPlan(plan) ? 'Monthly AI allowance pending' : 'Service-funded, with task limits' : 'Not loaded';
  $('refresh-hosting').disabled = !session || busy || waiting;
  $('create-invoice').hidden = !checkoutAvailable(); $('create-invoice').disabled = busy || waiting;
  $('create-invoice').textContent = active ? 'Renew for 30 days' : 'Create 30-day invoice';
  $('checkout-copy').textContent = checkoutAvailable() ? 'Payment activates 30 days. No automatic renewal.' : 'Monthly checkout is not open yet.';
  $('invoice').hidden = !session || !invoice || !checkoutAvailable();
  if (!invoice || !session) {
    for (const id of ['invoice-usd', 'invoice-source-copy', 'invoice-amount', 'invoice-network', 'invoice-token', 'invoice-recipient', 'invoice-expiry']) $(id).textContent = '';
    $('invoice-usd-row').hidden = true; $('invoice-source-copy').hidden = true;
    return;
  }
  $('invoice-usd-row').hidden = !invoice.pricing;
  $('invoice-usd').textContent = invoice.pricing ? formatUsdCents(invoice.pricing.usdCents) : '';
  $('invoice-source-copy').hidden = !invoice.pricing;
  $('invoice-source-copy').textContent = invoice.pricing ? `DEX Screener price fetched ${formatDate(invoice.pricing.retrievedAt, true)}. Market update time unavailable. The token amount is fixed for this invoice.` : '';
  $('invoice-amount').textContent = Number.isInteger(tokenDecimals) ? `${formatTokenAmount(invoice.amount, tokenDecimals)} $CLOCKERS` : 'Loading exact token amount';
  $('invoice-network').textContent = `Chain ${invoice.chainId}`;
  $('invoice-token').textContent = invoice.token; $('invoice-recipient').textContent = invoice.recipient;
  $('invoice-expiry').textContent = formatDate(invoice.expiresAt, true);
  const hash = $('transaction-hash').value.trim();
  const expired = Date.parse(invoice.expiresAt) <= Date.now();
  $('pay-invoice').disabled = busy || waiting || Boolean(hash) || expired || !Number.isInteger(tokenDecimals);
  $('pay-invoice').textContent = hash ? 'Payment reference saved' : expired ? 'Invoice expired' : Number.isInteger(tokenDecimals) ? `Pay ${formatTokenAmount(invoice.amount, tokenDecimals)} $CLOCKERS` : 'Wallet payment unavailable';
  $('activate').disabled = busy || waiting; $('transaction-hash').disabled = busy || waiting;
  $('payment-copy').textContent = hash ? 'Keep this transaction reference. Verify it to activate hosting; do not send another payment.' : expired ? 'This invoice expired. Create a fresh invoice only if no payment was sent.' : 'Pay this invoice to the treasury once. Network fees are shown by your wallet.';
}
async function loadHosting() {
  if (!session) return;
  const operation = version, scope = session.scope;
  try {
    const response = validateHosting(await api('/api/hosting', { authenticated: true }), scope);
    if (operation !== version) return;
    hosting = response; clearTimeout(hostingTimer);
    if (hostingActive()) hostingTimer = setTimeout(() => { if (operation === version) { if (Date.parse(hosting.expiresAt) <= Date.now()) { hosting = { ...hosting, active: false }; render(); } else loadHosting(); } }, Math.min(2147483647, Math.max(0, Date.parse(hosting.expiresAt) - Date.now())));
    render();
  } catch (error) { if (operation === version) { hosting = undefined; handleError(error); render(); } }
}
async function walletForInvoice(selected) {
  if (!provider?.request) throw new Error('JEFF_WALLET_UNAVAILABLE');
  const chain = await provider.request({ method: 'eth_chainId' });
  if (Number.parseInt(chain, 16) !== selected.chainId) throw new Error('JEFF_WALLET_NETWORK_MISMATCH');
  const accounts = await provider.request({ method: 'eth_accounts' });
  if (accounts?.[0]?.toLowerCase() !== selected.scope.owner) throw new Error('JEFF_OWNER_REQUIRED');
}
async function loadTokenDetails(selected, operation) {
  await walletForInvoice(selected); if (operation !== version) return;
  const response = await provider.request({ method: 'eth_call', params: [{ to: selected.token, data: '0x313ce567' }, 'latest'] });
  const decimals = /^0x[a-f0-9]+$/i.test(response) ? Number.parseInt(response.slice(2), 16) : NaN;
  if (selected.pricing && selected.pricing.tokenDecimals !== decimals) throw new Error('JEFF_TOKEN_DETAILS_UNAVAILABLE');
  formatTokenAmount(selected.amount, decimals);
  if (operation === version && invoice?.id === selected.id) { tokenDecimals = decimals; renderHosting(); }
}
function rememberInvoice(selected = invoice, hash = $('transaction-hash').value.trim(), key = invoiceKey()) {
  try { localStorage.setItem(key, JSON.stringify({ invoice: selected, transactionHash: hash })); }
  catch { showNotice('Keep the invoice ID and transaction hash. Browser storage is unavailable.', true); }
}
async function refreshWorkspace() {
  const operation = version; await loadHosting(); if (operation !== version || !session) return;
  if (checkoutAvailable() && !invoice) {
    const saved = readStorage(localStorage, invoiceKey());
    if (saved?.invoice) {
      try {
        invoice = validateInvoice(saved.invoice, session.scope, 0);
        $('transaction-hash').value = /^0x[a-f0-9]{64}$/i.test(saved.transactionHash || '') ? saved.transactionHash : '';
        renderHosting(); loadTokenDetails(invoice, operation).catch(error => { if (operation === version) { showNotice(errorLabel(error), true); renderHosting(); } });
      } catch { /* Invalid or other-scope invoices are not restored. */ }
    }
  }
  await refreshHistory();
}
$('refresh-hosting').addEventListener('click', loadHosting);
$('create-invoice').addEventListener('click', async () => {
  if (!checkoutAvailable() || busy || waiting) return;
  if (invoice && $('transaction-hash').value.trim()) { showNotice('An existing payment reference is saved. Verify that payment before creating another invoice.', true); return; }
  const operation = version, scope = session.scope; busy = true; showNotice('Creating your 30-day hosting invoice. No payment is sent yet.'); render();
  try {
    const candidate = validateInvoice(await api('/api/hosting/invoice', { method: 'POST', authenticated: true }), scope);
    if (operation !== version) return;
    invoice = candidate; tokenDecimals = undefined; $('transaction-hash').value = ''; rememberInvoice(); renderHosting();
    await loadTokenDetails(candidate, operation);
    if (operation === version) showNotice('Review the amount, network, token, recipient, and expiry before approving a payment.');
  } catch (error) { if (operation === version) handleError(error); }
  finally { if (operation === version) { busy = false; render(); } }
});
async function activatePayment() {
  if (!checkoutAvailable() || busy || waiting || !invoice) return;
  const hash = $('transaction-hash').value.trim();
  if (!/^0x[a-f0-9]{64}$/i.test(hash)) { showNotice('Enter the full payment transaction hash.', true); return; }
  const operation = version, scope = session.scope, selected = invoice; rememberInvoice(); busy = true; showNotice('Verifying the payment on chain. Hosting is activated only after confirmation.'); render();
  try {
    const response = validateHosting(await api('/api/hosting/activate', { method: 'POST', body: { invoiceId: selected.id, transactionHash: hash }, authenticated: true }), scope);
    if (operation !== version) return;
    hosting = response; invoice = undefined; tokenDecimals = undefined; $('transaction-hash').value = '';
    try { localStorage.removeItem(invoiceKey()); } catch { /* The server makes activation idempotent. */ }
    showNotice(response.active ? 'Payment verified. Hosting is active; the expiry above includes your new term.' : 'Payment checked. Refresh hosting to confirm your current access.');
    await loadHosting();
  } catch (error) { if (operation === version) handleError(error); }
  finally { if (operation === version) { busy = false; render(); } }
}
$('activate-form').addEventListener('submit', event => { event.preventDefault(); activatePayment(); });
$('transaction-hash').addEventListener('input', () => { if (session && invoice) { rememberInvoice(); renderHosting(); } });
$('pay-invoice').addEventListener('click', async () => {
  if (!checkoutAvailable() || busy || waiting || !invoice || !Number.isInteger(tokenDecimals) || $('transaction-hash').value.trim()) return;
  const operation = version, scope = session.scope, selected = invoice, key = invoiceKey(); busy = true; showNotice('Review the exact token transfer in your wallet.'); render();
  let submitted = false;
  try {
    validateInvoice(selected, scope); await walletForInvoice(selected); if (operation !== version) return;
    const hash = await provider.request({ method: 'eth_sendTransaction', params: [{ from: scope.owner, to: selected.token, value: '0x0', data: transferData(selected) }] });
    if (!/^0x[a-f0-9]{64}$/i.test(hash)) throw new Error('JEFF_PAYMENT_INVALID');
    rememberInvoice(selected, hash, key); if (operation !== version) return;
    $('transaction-hash').value = hash; submitted = true;
  } catch (error) { if (operation === version) handleError(error); }
  finally { if (operation === version) { busy = false; render(); if (submitted) activatePayment(); } }
});
async function initialize() {
  try {
    config = await api('/api/config');
    if (!Number.isSafeInteger(config.chainId) || !/^0x[a-f0-9]{40}$/i.test(config.collection)) throw new Error('JEFF_SERVICE_UNAVAILABLE');
    if (!new URLSearchParams(location.search).has('mode') && config.standaloneAccounts === true) accessMode = 'standalone';
    $('model-status').textContent = config.modelConfigured ? 'Model connection configured' : 'Model connection needed';
    document.body.classList.toggle('service-ready', config.modelConfigured);
    $('model-copy').textContent = config.modelConfigured ? 'Tasks are available with active hosting. External actions are disabled.' : 'New tasks are unavailable until the operator configures the model connection. Saved results can still be retrieved.';
    const cached = readStorage(sessionStorage, SESSION_KEY);
    if (validSession(cached, config)) { session = cached; scheduleExpiry(); } else saveSession();
    $('stage').textContent = config.continuousHosting ? 'HOSTED PILOT' : 'LOCAL PILOT';
    $('hosting-availability').textContent = config.continuousHosting ? 'Hosted' : 'Unavailable';
    $('checkout-availability').textContent = config.billingEnabled ? 'Invoice checkout' : 'Unavailable';
    $('footer-status').textContent = config.continuousHosting ? 'Hosted pilot. Monthly checkout availability is shown above.' : 'Local pilot. Continuous hosting is unavailable.';
    bindProvider(window.ethereum); render(); if (session) await refreshWorkspace();
  } catch (error) { config = undefined; $('model-status').textContent = 'Service unavailable'; $('model-copy').textContent = 'The workspace could not connect. Reload when the service is available.'; handleError(error); }
}
initialize();
