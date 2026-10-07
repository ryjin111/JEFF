import { JOB_ID, scopeKey, validSession, jobIndex, validateRecord, errorLabel } from './client.js';
import { validateHosting, validateInvoice, validUsdPlan, formatUsdCents, formatTokenAmount, transferData } from './billing.js';
const $ = id => document.getElementById(id);
const SESSION_KEY = 'simple-jeff:session:v1';
let config, session, provider, loginWallet, busy = false, waiting = false, version = 0, currentResult, expiryTimer, pollTimer;
let serverJobs = [];
let hosting, invoice, tokenDecimals, hostingTimer, hostingRequest = 0, hostingFailed = false, passState;
let accessMode = new URLSearchParams(location.search).get('mode') === 'standalone' ? 'standalone' : 'holder';
const standaloneSession = () => session?.scope?.kind === 'account';
const checkoutAvailable = () => Boolean(session && config?.billingEnabled && hosting?.checkoutEnabled);
const hostingActive = () => Boolean(hosting?.active && Date.parse(hosting.expiresAt) > Date.now());
const allowanceAvailable = () => hosting?.usage
  ? hosting.usage.remaining > 0 && hosting.usage.hourlyRemaining > 0 && Date.parse(hosting.usage.resetsAt) > Date.now()
  : !Number.isSafeInteger((hosting?.plan || config?.plan)?.tasksIncluded);
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
  hostingFailed = false;
  passState = undefined;
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
  $('objective').disabled = !session || busy || waiting || !config?.modelConfigured || !hostingActive() || !allowanceAvailable();
  document.querySelectorAll('[data-prompt]').forEach(button => { button.disabled = $('objective').disabled; });
  $('run').disabled = $('objective').disabled;
  $('run').textContent = (busy || waiting) && session ? 'Working…' : 'Run JEFF';
  $('job-id').disabled = !session || busy || waiting; $('retrieve').disabled = !session || busy || waiting;
  $('refresh').disabled = !session || busy || waiting;
  $('retry-save').disabled = !session || busy || waiting;
  $('job-status').textContent = !session ? 'Sign in first' : busy ? 'Working' : waiting ? 'Running' : currentResult?.status === 'completed_unsaved' ? 'Needs save' : currentResult?.status === 'completed' ? 'Complete' : currentResult?.status === 'failed' ? 'Failed' : currentResult?.status === 'interrupted' ? 'Interrupted' : !hostingActive() ? 'Hosting inactive' : !allowanceAvailable() ? 'Usage limit' : config?.modelConfigured ? 'Ready' : 'Model unavailable';
  $('task-hint').textContent = !session ? 'Sign in to run a task or retrieve a saved result.' : !hosting ? 'Checking hosting access. Saved results remain accessible.' : !hostingActive() ? 'Hosting is inactive. Activate or renew to run new tasks; saved results remain accessible.' : !config?.modelConfigured ? 'The model connection is not configured. You can still retrieve saved results.' : waiting ? `Task ${currentResult?.id || ''} is running. You can return later; it appears in server history.` : !allowanceAvailable() ? !hosting.usage ? 'Monthly allowance could not be verified. Refresh hosting; saved results remain accessible.' : Date.parse(hosting.usage.resetsAt) <= Date.now() ? 'Checking the new allowance period. Refresh hosting; saved results remain accessible.' : hosting.usage.remaining === 0 ? hosting.source === 'pilot' ? 'Your pilot task allowance is used up. Saved results remain accessible.' : hosting.source === 'free-pass' ? "Your free month's task allowance is used up. Saved results remain accessible." : 'Your included tasks are used up. Check the reset date in hosting. Saved results remain accessible.' : 'The hourly task limit was reached. Check hosting for the next available task time. Saved results remain accessible.' : 'A task can take up to 150 seconds. Its job ID is available immediately.';
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
      if (poll && !waiting) loadHosting({ quiet: true });
      if (focusResult && currentResult?.id === id && !$('result').hidden) $('result-heading').focus();
    }
  }
}
$('task-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!session || busy || waiting || !config?.modelConfigured || !hostingActive() || !allowanceAvailable()) return;
  const objective = $('objective').value.trim(); if (!objective || objective.length > 4000) return;
  const operation = version, scope = session.scope; busy = true; clearResult(); showNotice('Submitting your task. JEFF will return its job ID immediately.'); render();
  try {
    const record = await api('/api/jobs', { method: 'POST', body: { objective }, authenticated: true });
    await validateRecord(record, scope); if (operation !== version) return;
    acceptRecord(record);
  } catch (error) { if (operation === version) handleError(error); }
  finally { if (operation === version) { busy = false; render(); loadHosting({ quiet: true }); } }
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
  $('plan-price-copy').textContent = Number.isSafeInteger(plan?.tasksIncluded) ? `Paid in $CLOCKERS. Includes ${plan.tasksIncluded.toLocaleString('en-US')} tasks per 30-day period.` : config?.billingEnabled ? 'Paid in $CLOCKERS. Your invoice fixes the exact token amount before payment.' : 'Paid in $CLOCKERS. Monthly AI allowance will be confirmed before checkout opens.';
  $('hosting-status').textContent = !session ? 'Sign in to view' : !hosting ? hostingFailed ? 'Unavailable' : 'Checking' : active ? 'Active' : 'Inactive';
  $('hosting-status').className = 'status ' + (hosting ? active ? 'active' : 'inactive' : '');
  $('hosting-copy').textContent = !session ? 'Sign in to view hosting access and expiry.' : !hosting ? hostingFailed ? 'Hosting details could not be verified. Refresh hosting to check access and usage. Saved results remain accessible.' : 'Loading your hosting entitlement.' : active ? standaloneSession() ? 'Hosting access is active for your wallet account.' : 'Hosting access is active for this NFT. Its private workspace stays tied to the current holder.' : 'Hosting is inactive. You can retrieve existing results; new tasks need activation or renewal.';
  $('hosting-plan').textContent = !hosting ? 'Not loaded' : hosting.source === 'pilot' ? 'Pilot access' : hosting.source === 'free-pass' ? 'Free 30-day pass' : hosting.source === 'paid' ? '30-day hosting' : 'Not active';
  $('hosting-expiry').textContent = hosting?.expiresAt ? formatDate(hosting.expiresAt) : 'No active term';
  $('hosting-usage').textContent = hosting ? hosting.usage ? `${hosting.usage.limit.toLocaleString('en-US')} tasks / ${hosting.source === 'pilot' ? 'pilot term' : '30-day period'}` : validUsdPlan(plan) ? 'Monthly AI allowance pending' : 'Service-funded, with task limits' : 'Not loaded';
  renderAllowance(); renderFreePass();
  $('refresh-hosting').disabled = !session || busy || waiting;
  $('create-invoice').hidden = !checkoutAvailable(); $('create-invoice').disabled = busy || waiting;
  $('create-invoice').textContent = active ? 'Renew for 30 days' : 'Create 30-day invoice';
  $('checkout-copy').textContent = checkoutAvailable() ? 'Payment activates 30 days. No automatic renewal.' : 'Monthly checkout is not open yet.';
  $('invoice').hidden = !session || !invoice || !checkoutAvailable();
  if (!invoice || !session) {
    for (const id of ['invoice-usd', 'invoice-tasks', 'invoice-source-copy', 'invoice-amount', 'invoice-network', 'invoice-token', 'invoice-recipient', 'invoice-expiry']) $(id).textContent = '';
    $('invoice-usd-row').hidden = true; $('invoice-tasks-row').hidden = true; $('invoice-source-copy').hidden = true;
    return;
  }
  $('invoice-usd-row').hidden = !invoice.pricing;
  $('invoice-usd').textContent = invoice.pricing ? formatUsdCents(invoice.pricing.usdCents) : '';
  $('invoice-tasks-row').hidden = !invoice.tasksIncluded;
  $('invoice-tasks').textContent = invoice.tasksIncluded ? `${invoice.tasksIncluded.toLocaleString('en-US')} tasks for this 30-day period` : '';
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
function renderFreePass() {
  const pass = session && !standaloneSession() && hosting?.freePass;
  const available = pass?.state === 'available';
  const consumedTerm = pass?.state === 'consumed' && Date.parse(pass.expiresAt) > Date.now();
  $('free-pass-schedule').hidden = !consumedTerm;
  $('free-pass-schedule').textContent = consumedTerm ? Date.parse(pass.startsAt) > Date.now()
    ? `Free month scheduled: ${formatDate(pass.startsAt)} to ${formatDate(pass.expiresAt)}. Current allowance is unchanged.`
    : `Free month active: ${formatDate(pass.startsAt)} to ${formatDate(pass.expiresAt)}. This NFT's pass has been used.` : '';
  $('free-pass-card').hidden = !available;
  if (!available) {
    for (const id of ['free-pass-start', 'free-pass-end', 'free-pass-recovery']) $(id).textContent = '';
    $('use-free-pass').disabled = true;
    return;
  }
  $('free-pass-detail').textContent = `${pass.tasksIncluded.toLocaleString('en-US')} tasks. One use per NFT. Unused tasks expire.`;
  $('free-pass-period').hidden = false;
  $('free-pass-start').textContent = formatDate(pass.startsAt);
  $('free-pass-end').textContent = formatDate(pass.expiresAt);
  $('use-free-pass').disabled = busy || waiting || Boolean(passState);
  $('use-free-pass').textContent = passState === 'activating' ? 'Applying free month' : passState ? 'Checking pass status' : 'Use free month';
  $('free-pass-recovery').hidden = !passState;
  $('free-pass-recovery').textContent = passState === 'activating' ? 'Applying this NFT benefit. Keep this page open for confirmation.' : passState ? 'Activation is not confirmed. Refresh hosting to check the pass before another attempt.' : '';
}
function showPassConsumed(pass) {
  showNotice(`Free month applied: ${formatDate(pass.startsAt)} to ${formatDate(pass.expiresAt)}. This NFT's pass is permanently consumed.`);
}
$('use-free-pass').addEventListener('click', async () => {
  if (!session || standaloneSession() || busy || waiting || passState || hosting?.freePass?.state !== 'available') return;
  const operation = version, scope = session.scope;
  hostingRequest++; clearTimeout(hostingTimer);
  passState = 'activating'; busy = true; showNotice('Applying this NFT\'s free month. Its pass is consumed permanently when confirmed.'); render();
  try {
    const response = validateHosting(await api('/api/hosting/free-pass', { method: 'POST', body: {}, authenticated: true }), scope);
    if (operation !== version) return;
    if (response.freePass?.state !== 'consumed') throw new Error('JEFF_FREE_PASS_UNCONFIRMED');
    hostingRequest++; hosting = response; hostingFailed = false; passState = undefined;
    scheduleHostingRefresh(operation); showPassConsumed(response.freePass);
  } catch (error) {
    if (operation !== version) return;
    if (error.message === 'JEFF_OWNER_REQUIRED') { invalidate(); showNotice(errorLabel(error), true); }
    else if (/^JEFF_(SESSION_|OPENCLAW_OWNER_REVOKED|OPENCLAW_ACCOUNT_DENIED)/.test(error.message)) handleError(error);
    else {
      passState = 'checking'; showNotice('Free month activation is not confirmed. Checking the NFT pass before another attempt.', true); render();
      await loadHosting({ quiet: true });
      if (operation === version && passState) { passState = 'unknown'; showNotice('Free month activation is not confirmed. Refresh hosting before trying again.', true); }
    }
  } finally { if (operation === version) { busy = false; render(); } }
});
function renderAllowance() {
  const usage = session && hosting?.usage;
  $('monthly-allowance').hidden = !usage;
  if (!usage) {
    for (const id of ['allowance-summary', 'allowance-remaining', 'allowance-reset', 'allowance-hourly', 'allowance-policy', 'allowance-state']) $(id).textContent = '';
    $('allowance-progress').value = 0;
    return;
  }
  const active = hostingActive(), currentPeriod = active && Date.parse(usage.resetsAt) > Date.now(), exhausted = currentPeriod && usage.remaining === 0;
  $('monthly-allowance').dataset.exhausted = String(exhausted);
  $('allowance-heading').textContent = hosting.source === 'pilot' ? 'Pilot AI usage' : 'Included AI usage';
  $('allowance-state').textContent = !active ? 'Inactive' : !currentPeriod ? 'Refresh needed' : exhausted ? 'Used up' : 'Available';
  $('allowance-state').className = 'status ' + (currentPeriod && !exhausted ? 'active' : 'inactive');
  $('allowance-summary').textContent = !active ? 'Activate hosting to start an allowance period.' : !currentPeriod ? 'Checking the new allowance period.' : `${usage.used.toLocaleString('en-US')} of ${usage.limit.toLocaleString('en-US')} tasks used`;
  $('allowance-progress').hidden = !currentPeriod;
  $('allowance-progress').max = usage.limit; $('allowance-progress').value = usage.used;
  $('allowance-remaining').textContent = !active ? 'No active allowance' : !currentPeriod ? 'Refresh hosting to check' : `${usage.remaining.toLocaleString('en-US')} tasks`;
  $('allowance-reset').textContent = active ? formatDate(usage.resetsAt) : 'No active period';
  $('allowance-reset-label').textContent = hosting.source === 'pilot' ? 'Pilot ends' : hosting.source === 'free-pass' ? 'Free pass ends' : 'Resets';
  $('allowance-hourly').textContent = !active ? `${usage.hourlyLimit} tasks per rolling hour when active` : usage.hourlyRemaining === 0 ? `Hourly limit reached. Next task available ${formatDate(usage.hourlyResetsAt, true)}.` : `${usage.hourlyRemaining} of ${usage.hourlyLimit} tasks available now. Rolling-hour limit.`;
  $('allowance-policy').textContent = 'Accepted runs count, including failed or timed out runs. Unused tasks expire at the period end. Save retries do not count. Early renewal adds the next period; it does not reset current usage.';
}
function scheduleHostingRefresh(operation) {
  clearTimeout(hostingTimer);
  if (!hostingActive()) return;
  const now = Date.now(), deadlines = [Date.parse(hosting.expiresAt)];
  if (hosting.usage) deadlines.push(Date.parse(hosting.usage.resetsAt), Date.parse(hosting.usage.hourlyResetsAt));
  const deadline = Math.min(...deadlines.filter(value => value > now));
  if (Number.isFinite(deadline)) hostingTimer = setTimeout(() => {
    if (operation !== version) return;
    render(); loadHosting({ quiet: true });
  }, Math.min(2147483647, Math.max(100, deadline - now + 25)));
}
async function loadHosting({ quiet = false } = {}) {
  if (!session) return;
  const operation = version, scope = session.scope, request = ++hostingRequest;
  try {
    const response = validateHosting(await api('/api/hosting', { authenticated: true }), scope);
    if (operation !== version || request !== hostingRequest) return;
    hosting = response; hostingFailed = false; scheduleHostingRefresh(operation);
    if (passState === 'checking' || passState === 'unknown') {
      passState = undefined;
      if (response.freePass?.state === 'consumed') showPassConsumed(response.freePass);
      else if (response.freePass?.state === 'available') showNotice('The NFT pass is still available. No free month was confirmed; you can try again.');
      else showNotice('The NFT pass is unavailable. No additional free month was confirmed.', true);
    }
    render();
  } catch (error) { if (operation === version && request === hostingRequest) { hosting = undefined; hostingFailed = true; clearTimeout(hostingTimer); if (!quiet || /^JEFF_(SESSION_|OPENCLAW_OWNER_REVOKED|OPENCLAW_ACCOUNT_DENIED)/.test(error.message)) handleError(error); render(); } }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && session) loadHosting({ quiet: true }); });
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
