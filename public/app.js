import { JOB_ID, scopeKey, validSession, jobIndex, validateRecord, errorLabel } from './client.js';
const $ = id => document.getElementById(id);
const SESSION_KEY = 'simple-jeff:session:v1';
let config, session, provider, loginWallet, busy = false, waiting = false, version = 0, currentResult, expiryTimer, pollTimer;
let serverJobs = [];
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
function formatDate(value) { return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(value)) + ' UTC'; }
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
  version++; session = undefined; loginWallet = undefined; busy = false; waiting = false; serverJobs = []; saveSession(); clearTimeout(expiryTimer); clearTimeout(pollTimer);
  requests.forEach(controller => controller.abort()); requests.clear(); clearResult();
  $('objective').value = ''; $('job-id').value = ''; render();
  if (token) fetch('/api/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', keepalive: true }).catch(() => {});
}
function handleError(error) {
  if (/^JEFF_(SESSION_|OPENCLAW_OWNER_REVOKED)/.test(error.message)) invalidate();
  showNotice(errorLabel(error), true);
}
function renderHistory() {
  const list = $('history-list'); list.replaceChildren();
  if (!session) { $('history-copy').textContent = 'Sign in to retrieve results. This browser remembers job IDs, never result text.'; return; }
  const known = jobIndex([...serverJobs.map(record => record.id), ...ids()]);
  $('history-copy').textContent = known.length ? `${known.length} job${known.length === 1 ? '' : 's'} in this workspace. Server history includes running tasks and results that need a save retry.` : 'No jobs in this workspace yet. You can also retrieve a result using its job ID.';
  for (const id of known) { const record = serverJobs.find(job => job.id === id); const button = document.createElement('button'); button.className = 'history-item'; button.textContent = record ? `${record.status.replaceAll('_', ' ')} | ${record.objective.slice(0, 100)} | ${id}` : id; button.disabled = busy || waiting; button.addEventListener('click', () => retrieve(id)); list.append(button); }
}
function render() {
  $('logout').hidden = !session; $('logout').disabled = false;
  $('login-form').hidden = Boolean(session); $('scope-details').hidden = !session;
  $('token-id').disabled = busy; $('login').disabled = !config || busy;
  $('login').textContent = busy && !session ? 'Waiting for wallet' : 'Connect wallet & sign in';
  $('agent-name').textContent = session ? `Room #${session.scope.tokenId}` : 'Connect your NFT';
  $('identity-copy').textContent = session ? 'Private workspace for this NFT, holder, and ownership epoch.' : 'Sign in with the wallet that holds your Clockers Agent NFT.';
  $('holder-wallet').textContent = session?.scope.owner || '';
  $('owner-epoch').textContent = session ? String(session.scope.ownerEpoch) : '';
  $('session-expiry').textContent = session ? formatDate(session.expiresAt) : '';
  $('objective').disabled = !session || busy || waiting || !config?.modelConfigured;
  $('run').disabled = !session || busy || waiting || !config?.modelConfigured;
  $('run').textContent = (busy || waiting) && session ? 'Working…' : 'Run JEFF';
  $('job-id').disabled = !session || busy || waiting; $('retrieve').disabled = !session || busy || waiting;
  $('refresh').disabled = !session || busy || waiting;
  $('retry-save').disabled = !session || busy || waiting;
  $('job-status').textContent = !session ? 'Sign in first' : busy ? 'Working' : waiting ? 'Running' : currentResult?.status === 'completed_unsaved' ? 'Needs save' : currentResult?.status === 'completed' ? 'Complete' : currentResult?.status === 'failed' ? 'Failed' : currentResult?.status === 'interrupted' ? 'Interrupted' : config?.modelConfigured ? 'Ready' : 'Model unavailable';
  $('task-hint').textContent = !session ? 'Sign in to run a task or retrieve a saved result.' : !config?.modelConfigured ? 'The model connection is not configured. You can still retrieve saved results.' : waiting ? `Task ${currentResult?.id || ''} is running. You can return later; it appears in server history.` : 'A task can take up to 150 seconds. Its job ID is available immediately.';
  renderHistory();
}
function scheduleExpiry() { clearTimeout(expiryTimer); if(session) expiryTimer = setTimeout(() => { invalidate(); showNotice('Your session expired. Sign in again to retrieve saved results.'); }, Math.max(0, Date.parse(session.expiresAt) - Date.now())); }
function bindProvider(next) {
  if (provider === next) return;
  provider?.removeListener?.('accountsChanged', walletChanged); provider?.removeListener?.('chainChanged', walletChanged);
  provider = next; provider?.on?.('accountsChanged', walletChanged); provider?.on?.('chainChanged', walletChanged);
}
function walletChanged() { if (!session && !loginWallet) return; invalidate(); showNotice('Wallet or network changed. Sign in again for your current holder workspace.'); }
$('login-form').addEventListener('submit', async event => {
  event.preventDefault(); if (busy || !config) return;
  const tokenId = $('token-id').value.trim();
  if (!/^(0|[1-9]\d*)$/.test(tokenId) || BigInt(tokenId) >= 2n ** 256n) { showNotice('Enter a valid Room / token ID.', true); return; }
  const operation = ++version; busy = true; clearResult(); showNotice('Approve wallet access, then sign the holder login message.'); render();
  let candidate;
  try {
    bindProvider(window.ethereum); if (!provider?.request) throw new Error('JEFF_WALLET_UNAVAILABLE');
    const accounts = await provider.request({ method: 'eth_requestAccounts' }); if (operation !== version) return;
    const wallet = accounts?.[0]?.toLowerCase(); if (!/^0x[a-f0-9]{40}$/.test(wallet)) throw new Error('JEFF_WALLET_UNAVAILABLE');
    loginWallet = wallet;
    const challenge = await api('/api/auth/challenge', { method: 'POST', body: { wallet, tokenId } }); if (operation !== version) return;
    const message = '0x' + Array.from(new TextEncoder().encode(challenge.message), byte => byte.toString(16).padStart(2, '0')).join('');
    const signature = await provider.request({ method: 'personal_sign', params: [message, wallet] }); if (operation !== version) return;
    candidate = await api('/api/auth/verify', { method: 'POST', body: { nonce: challenge.nonce, signature } });
    if (operation !== version) { fetch('/api/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${candidate.token}` } }).catch(() => {}); return; }
    if (!validSession(candidate, config) || candidate.scope.owner !== wallet || candidate.scope.tokenId !== tokenId) throw new Error('JEFF_SCOPE_INVALID');
    session = candidate; saveSession(); scheduleExpiry(); showNotice('Signed in. Your workspace is ready for saved result retrieval.');
  } catch (error) { if (operation === version) handleError(error); }
  finally { if (operation === version) { loginWallet = undefined; busy = false; render(); if (session) refreshHistory(); } }
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
  if (waiting) { showNotice(`JEFF is working. Job ID: ${record.id}. You can return to this task from server history.`); pollTimer = setTimeout(() => retrieve(record.id, true), 2000); }
  else if (['completed', 'completed_unsaved'].includes(record.status)) { displayRecord(record); showNotice(record.saved ? 'Task complete. Your result is saved and can be retrieved later.' : 'The result is ready, but saving failed. Retry save without running the model again. Pending output is retained only while this service process stays running.', !record.saved); }
  else showNotice(record.status === 'interrupted' ? 'This task was interrupted by a service restart. No completed output is available. Review the task before starting a new one.' : 'This task failed. No completed result was saved.', true);
  serverJobs = [record, ...serverJobs.filter(job => job.id !== record.id)];
  rememberJob(record.id);
}
async function retrieve(id, poll = false) {
  if (!session || busy || (waiting && !poll)) return;
  if (!JOB_ID.test(id)) { showNotice('Enter a valid saved job ID.', true); return; }
  const operation = version, scope = session.scope; busy = true; if (!poll) clearResult(); showNotice('Checking ownership and retrieving your saved result.'); render();
  try {
    const record = await api(`/api/jobs/${id}`, { authenticated: true });
    await validateRecord(record, scope, id); if (operation !== version) return;
    acceptRecord(record);
  } catch (error) { if (operation === version) { waiting = false; clearTimeout(pollTimer); handleError(error); } }
  finally { if (operation === version) { busy = false; render(); } }
}
$('task-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!session || busy || waiting || !config?.modelConfigured) return;
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
$('retrieve-form').addEventListener('submit', event => { event.preventDefault(); retrieve($('job-id').value.trim().toLowerCase()); });
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
async function initialize() {
  try {
    config = await api('/api/config');
    if (!Number.isSafeInteger(config.chainId) || !/^0x[a-f0-9]{40}$/i.test(config.collection)) throw new Error('JEFF_SERVICE_UNAVAILABLE');
    $('model-status').textContent = config.modelConfigured ? 'Model connection configured' : 'Model connection needed';
    $('model-copy').textContent = config.modelConfigured ? 'NFT holder tasks are available. External actions are disabled.' : 'New tasks are unavailable until the operator configures the model connection. Saved results can still be retrieved.';
    const cached = readStorage(sessionStorage, SESSION_KEY);
    if (validSession(cached, config)) { session = cached; scheduleExpiry(); } else saveSession();
    bindProvider(window.ethereum); render(); if (session) await refreshHistory();
  } catch (error) { config = undefined; $('model-status').textContent = 'Service unavailable'; $('model-copy').textContent = 'The workspace could not connect. Reload when the service is available.'; handleError(error); }
}
initialize();
