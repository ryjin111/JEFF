import { JOB_ID, scopeKey, validSession, validateRecord, validateNftDiscovery, errorLabel } from './client.js';
import { validateHosting, validateInvoice, formatTokenAmount, formatUsdCents, transferData } from './billing.js';
import { renderMarkdown } from './markdown.js';
import { parseReviewed, unseenOutcomes } from './visit-summary.js';
import {githubConnectorPanel} from './github-connector-ui.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const content = $('#workspace-content');
const SESSION_KEY = 'jeff:workspace:session:v1';
const THEME_KEY = 'jeff:workspace:theme:v1';
const pages = [
  ['chat', 'Conversation', 'chat'], ['activity', 'Activity', 'activity'], ['skills', 'Skills & tools', 'grid'],
  ['memory', 'Memory', 'book'], ['usage', 'Usage & credits', 'bolt'], ['schedules', 'Scheduled work', 'clock'],
  ['hosting', 'Hosting', 'credit'], ['settings', 'Settings', 'settings'],
];
const S = { config: null, session: null, workspace: null, jobs: [], hosting: null, schedules: [], usage: null,
  inventory: null, wallet: null, mode: 'nft', view: 'chat', conversationId: null, draft: '', draftVersion: 0, submission: null, admitted: null, busy: false, authBusy: false,
  memoryDraft: { title: '', text: '' }, researchDraft: { question: '', urls: '', consent: false, unconfirmed: false }, settingsDraft: null, scheduleDraft: null, invoice: null, decimals: null,
  paymentHash: '', paymentSubmitted: false, version: 0, notice: '', noticeError: false, runNotice: null, commands: [],
  actionConsent: new Set(), actionRequests: new Map() };
Object.assign(S,{githubConnection:null,githubRepositories:null,githubDraft:{question:'',repositoryId:''},githubUnconfirmed:false});
let provider, pollTimer, expiryTimer, toastTimer, refreshSequence = 0, refreshFailures = 0, refreshNotice = null, sidebarReturnFocus;
let reviewedOutcomes = new Set(), reviewedScope = null;
const reviewedKey = scope => `jeff:reviewed-outcomes:v1:${scopeKey(scope)}`;
const refreshRetryDelays = [2000, 5000, 10000, 30000];
const pending = new Set();
const mobile = matchMedia('(max-width: 760px)');
const node = (tag, className = '', value) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (value !== undefined) element.textContent = value;
  return element;
};
const icon = name => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon'); svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`); svg.append(use); return svg;
};
const button = (label, action, iconName, className = 'button button-outline', data = {}) => {
  const element = node('button', className); element.type = 'button'; element.dataset.action = action;
  Object.assign(element.dataset, data);
  if (iconName) element.append(icon(iconName));
  element.append(node('span', '', label)); return element;
};
const put = (selector, value) => { const element = $(selector); if (element) element.textContent = value; };
const pill = (label, kind = '') => node('span', `pill ${kind}`, label);
const shortWallet = wallet => wallet ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : '';
const when = value => Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—';
const safeMicros = value => Number.isSafeInteger(value) && value >= 0;
const dollars = value => {
  if (!safeMicros(value)) return '—';
  const raw = BigInt(value).toString().padStart(7, '0');
  const fraction = raw.slice(-6).replace(/0+$/, '').padEnd(2, '0');
  return `$${raw.slice(0, -6)}.${fraction}`;
};
const dollarsInput = value => safeMicros(value) ? dollars(value).slice(1) : '';
function parseBudget(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,3})(?:\.\d{1,6})?$/.test(value.trim())) throw new Error('JEFF_BUDGET_INVALID');
  const [whole, fractional = ''] = value.trim().split('.');
  const amount = BigInt(whole) * 1000000n + BigInt(fractional.padEnd(6, '0'));
  if (amount < 1n || amount > 1000000000n) throw new Error('JEFF_BUDGET_INVALID');
  return Number(amount);
}
const settingsSnapshot = settings => Object.fromEntries(['name', 'model', 'dailyBudgetMicros', 'paused'].map(key => [key, settings[key]]));
function reconcileSettingsDraft(workspace) {
  const draft = S.settingsDraft;
  if (!draft || draft.revision === workspace.revision) return;
  const unchanged = Object.entries(draft.savedSettings).every(([key, value]) => workspace.settings[key] === value);
  // Conversation, memory and run updates also advance the workspace revision.
  // Rebase only when the persisted settings still match the draft's starting point.
  S.settingsDraft = unchanged ? { ...draft, revision: workspace.revision, conflict: false } : { ...draft, conflict: true };
}
const prepaid = () => S.usage?.enabled === true && ['prepaid', 'prepaid-credits'].includes(S.usage.mode);
const conversation = () => {
  const saved = S.workspace?.conversations.find(item => item.id === S.conversationId);
  const admitted = S.admitted?.conversationId === S.conversationId ? [S.admitted] : [];
  if (!saved && !admitted.length) return;
  return { ...(saved || { id: S.conversationId, title: admitted[0].objective.slice(0, 64) }),
    jobIds: [...new Set([...(saved?.jobIds || []), ...admitted.map(job => job.id)])] };
};
const running = () => S.jobs.some(job => job.status === 'running');
const signedIn = () => Boolean(S.session && S.workspace);
const agentName = () => S.workspace?.settings.name?.trim()
  || (S.session && S.session.scope.kind !== 'account' ? `Room #${S.session.scope.tokenId}` : 'Your agent');
const browserTimeZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };
function allowanceReason() {
  if (!S.session) return 'Connect your Agent NFT to start a conversation.';
  if (!S.workspace || !S.hosting) return 'Loading your private workspace…';
  if (S.config?.restoreBlocked) return 'New runs are paused while restored storage is verified. Saved work remains accessible.';
  if (!S.config?.modelConfigured) return 'JEFF’s model connection is unavailable. Saved work remains accessible.';
  if (S.workspace.settings.paused) return 'Future runs are paused. Resume this agent to send a task.';
  if (!S.hosting.active || Date.parse(S.hosting.expiresAt) <= Date.now()) return S.session.scope.kind === 'account'
    ? 'This wallet account has no active hosting. Open your Agent NFT to use its hosting.'
    : 'Activate hosting to run tasks. Your saved work remains accessible.';
  if (!S.hosting.usage || S.hosting.usage.remaining === 0) return 'Your included task allowance is used up. Check Hosting for the next period.';
  if (S.hosting.usage.hourlyRemaining === 0) return 'The hourly task limit was reached. Check Usage for the next available time.';
  if (prepaid() && (!S.usage.balance || S.usage.balance.availableMicros <= 0 || S.usage.balance.paused || S.usage.balance.restoreBlocked)) return 'Inference credits are unavailable. Check Usage & credits before running.';
  if (running()) return `${S.workspace.settings.name} is working. You can draft your next message while you wait.`;
  return '';
}
function notify(message, error = false) {
  S.notice = message; S.noticeError = error; S.runNotice = null; refreshNotice = null;
  const element = $('#workspace-notice'); element.textContent = message; element.hidden = !message;
  element.classList.toggle('is-error', error);
}
function notifyRun(jobId, message, stopRequested = false) {
  if (!S.session || !JOB_ID.test(jobId)) return;
  notify(message);
  S.runNotice = { jobId, scope: scopeKey(S.session.scope), message, stopRequested };
}
function updateRunNotice() {
  const tracked = S.runNotice;
  if (!tracked || !S.session || tracked.scope !== scopeKey(S.session.scope)
    || (S.noticeError && !tracked.refreshFailed) || S.notice !== tracked.message) return;
  const job = S.jobs.find(item => item.id === tracked.jobId);
  if (!job) return;
  if (job.status === 'running') {
    if (tracked.refreshFailed) notifyRun(job.id, 'Run admitted. Its result will appear here.', tracked.stopRequested);
    return;
  }
  if (job.status === 'completed') notify('Run completed and saved.');
  else if (job.status === 'completed_unsaved') notify('Run completed, but its output is not saved. Retry save to keep the existing result.', true);
  else if (job.status === 'failed') notify(tracked.stopRequested
    ? 'The run ended after your stop request. Its saved status is Failed.'
    : 'Run failed. No completed result was saved. Review it in Activity before starting another run.', true);
  else if (job.status === 'interrupted') notify('Run interrupted by a server restart. It was not automatically resubmitted.', true);
}
function toast(message) {
  const element = $('#toast'); clearTimeout(toastTimer); element.textContent = message; element.hidden = false;
  toastTimer = setTimeout(() => { element.hidden = true; }, 4200);
}
function friendly(error) {
  const labels = {
    JEFF_BUDGET_INVALID: 'Enter a daily budget above $0 and at most $1,000, using up to six decimal places.',
    JEFF_WORKSPACE_INVALID: 'These settings could not be saved. Check the field lengths, model and budget.',
    JEFF_WORKSPACE_CONFLICT: 'The workspace changed while you were editing. Refresh and review the latest settings.',
    JEFF_WORKSPACE_FULL: 'This workspace reached its storage limit. Remove an unused conversation or memory before adding more.',
    JEFF_WORKSPACE_NOT_FOUND: 'That conversation or memory is no longer available. Refresh the workspace.',
    JEFF_WORKSPACE_STORAGE_UNAVAILABLE: 'Workspace storage could not be verified. Work is paused until storage is available.',
    JEFF_AGENT_PAUSED: 'This agent is paused. Resume future runs before submitting a task.',
    JEFF_RESTORE_GUARDED: 'New runs are paused while restored storage is verified. Saved work remains accessible.',
    JEFF_INFERENCE_INSUFFICIENT_CREDITS: 'There are not enough available inference credits for this run.',
    JEFF_INFERENCE_INSUFFICIENT: 'There are not enough available inference credits for this run.',
    JEFF_INFERENCE_BALANCE_INSUFFICIENT: 'There are not enough available inference credits for this run.',
    JEFF_INFERENCE_DAILY_LIMIT: 'This run would exceed the daily inference budget.',
    JEFF_INFERENCE_DAILY_LIMIT_EXCEEDED: 'This run would exceed the daily inference budget.',
    JEFF_SCHEDULE_INVALID: 'Check the task, interval, run count and expiry. Schedules allow at most 24 runs over seven days.',
    JEFF_SCHEDULE_LIMIT: 'The schedule limit was reached. Cancel an unused schedule first.',
    JEFF_CHAT_ACTION_INVALID: 'This action could not be verified. Refresh and review the saved request.',
    JEFF_CHAT_ACTION_DENIED: 'This action cannot be performed from this conversation. Refresh and review the saved request.',
    JEFF_CHAT_ACTION_NOT_READY: 'The response is still being saved. Refresh before confirming this action.',
    JEFF_CHAT_RESPONSE_INVALID: 'The agent’s action draft could not be verified. Nothing was authorized.',
    JEFF_CHAT_ACTION_NOT_FOUND: 'This action is no longer available. Refresh the conversation.',
    JEFF_CHAT_ACTION_CONFLICT: 'This action has already changed. Refresh to check its saved status.',
    JEFF_CHAT_ACTION_EXPIRED: 'This schedule proposal has expired. Ask your agent for a new schedule.',
    JEFF_ROUTE_NOT_FOUND: 'This feature is unavailable on the connected runtime. Refresh after the service is updated.',
    JEFF_WALLET_NETWORK_MISMATCH: 'Switch your wallet to the workspace network, then connect again.',
  };
  if (Number(error?.code) === 4001) return 'The wallet request was declined. You can try again when ready.';
  return labels[error?.message] || errorLabel(error);
}
function saveSession() {
  try { S.session ? sessionStorage.setItem(SESSION_KEY, JSON.stringify(S.session)) : sessionStorage.removeItem(SESSION_KEY); }
  catch { toast('Session storage is unavailable. This tab will still work until it closes.'); }
}
function clearPrivate({ preserveInventory = false, revoke = true } = {}) {
  const token = S.session?.token;
  S.version++; refreshSequence++; clearTimeout(pollTimer); clearTimeout(expiryTimer);
  refreshFailures = 0; refreshNotice = null;
  for (const controller of pending) controller.abort(); pending.clear();
  S.session = null; S.workspace = null; S.jobs = []; S.hosting = null; S.schedules = []; S.usage = null;
  S.conversationId = null; S.draft = ''; S.draftVersion++; S.submission = null; S.admitted = null; S.memoryDraft = { title: '', text: '' }; S.settingsDraft = null; S.scheduleDraft = null;
  S.invoice = null; S.decimals = null; S.paymentHash = ''; S.paymentSubmitted = false; S.busy = false; S.authBusy = false; S.runNotice = null;
  S.actionConsent.clear(); S.actionRequests.clear();
  personalPanels.clear();
  S.researchDraft = { question: '', urls: '', consent: false, unconfirmed: false };
  S.githubConnection=null;S.githubRepositories=null;S.githubDraft={question:'',repositoryId:''};S.githubUnconfirmed=false;
  reviewedOutcomes = new Set(); reviewedScope = null;
  $$('.receipt-dialog').forEach(dialog => dialog.remove());
  if (!preserveInventory) { S.inventory = null; S.wallet = null; }
  saveSession();
  if (token && revoke) fetch('/api/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' }).catch(() => {});
  render(); renderConnection();
}
async function api(path, { method = 'GET', body, authenticated = true } = {}) {
  const version = S.version;
  const controller = new AbortController(); pending.add(controller);
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (authenticated) {
    if (!S.session) throw new Error('JEFF_SESSION_REQUIRED');
    headers.Authorization = `Bearer ${S.session.token}`;
  }
  try {
    const response = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal, cache: 'no-store' });
    let value;
    try { value = await response.json(); } catch { throw new Error('JEFF_SERVICE_UNAVAILABLE'); }
    if (version !== S.version) throw new Error('JEFF_REQUEST_SUPERSEDED');
    if (!response.ok) {
      const error = new Error(/^JEFF_[A-Z_]+$/.test(value?.error) ? value.error : 'JEFF_SERVICE_UNAVAILABLE');
      error.status = response.status;
      if (authenticated && (response.status === 401 || /OWNER_REVOKED|SESSION_REVOKED/.test(error.message))) {
        clearPrivate({ revoke: false }); notify(friendly(error), true);
      }
      throw error;
    }
    return value;
  } catch (error) {
    if (controller.signal.aborted || version !== S.version) throw new Error('JEFF_REQUEST_SUPERSEDED');
    if (error.name === 'TypeError') throw new Error('JEFF_NETWORK_FAILURE');
    throw error;
  } finally { pending.delete(controller); }
}
function validateWorkspace(value, scope) {
  if (!value || value.schema !== 'jeff-workspace-v1' || scopeKey(value.scope) !== scopeKey(scope)
    || !Number.isSafeInteger(value.revision) || value.revision < 0 || !value.settings
    || typeof value.settings.name !== 'string' || value.settings.name.length > 80
    || !S.config.allowedModels.includes(value.settings.model) || !Number.isSafeInteger(value.settings.dailyBudgetMicros)
    || value.settings.dailyBudgetMicros <= 0 || typeof value.settings.paused !== 'boolean'
    || !Array.isArray(value.conversations) || value.conversations.length > 64 || !Array.isArray(value.memories) || value.memories.length > 32
    || !Array.isArray(value.skills) || value.skills.length > 10 || !Array.isArray(value.activity)) throw new Error('JEFF_WORKSPACE_STORAGE_UNAVAILABLE');
  for (const item of value.conversations) {
    if (!JOB_ID.test(item?.id) || typeof item.title !== 'string' || !Array.isArray(item.jobIds) || item.jobIds.some(jobId => !JOB_ID.test(jobId))) throw new Error('JEFF_WORKSPACE_STORAGE_UNAVAILABLE');
  }
  for (const memory of value.memories) if (!JOB_ID.test(memory?.id) || typeof memory.title !== 'string' || typeof memory.text !== 'string') throw new Error('JEFF_WORKSPACE_STORAGE_UNAVAILABLE');
  for (const skill of value.skills) if (!['writing', 'analysis', 'planning'].includes(skill?.id) || typeof skill.enabled !== 'boolean') throw new Error('JEFF_WORKSPACE_STORAGE_UNAVAILABLE');
  for (const [jobId, binding] of Object.entries(value.jobBindings || {})) {
    const action = binding?.action;
    if (action && (!JOB_ID.test(jobId) || action.schema !== 'jeff-chat-action-v1' || action.id !== jobId
      || !['memory.save', 'schedule.create'].includes(action.type) || !['pending', 'applied', 'dismissed'].includes(action.status)
      || !action.parameters || typeof action.parameters !== 'object' || !Number.isFinite(Date.parse(action.createdAt))
      || typeof action.timeZone !== 'string')) throw new Error('JEFF_WORKSPACE_STORAGE_UNAVAILABLE');
    if (!action) continue;
    const p = action.parameters;
    if (action.type === 'memory.save' ? typeof p.title !== 'string' || typeof p.text !== 'string' || p.title.length > 120 || p.text.length > 4000
      : typeof p.objective !== 'string' || p.objective.length > 4000 || !Number.isInteger(p.intervalMinutes) || p.intervalMinutes < 1
        || !Number.isInteger(p.maxRuns) || p.maxRuns < 1 || p.maxRuns > 24 || !Number.isFinite(Date.parse(p.expiresAt))
        || (p.firstRunAt !== undefined && !Number.isFinite(Date.parse(p.firstRunAt)))) throw new Error('JEFF_WORKSPACE_STORAGE_UNAVAILABLE');
  }
  return value;
}
function validateUsage(value) {
  if (!value || typeof value.enabled !== 'boolean' || typeof value.mode !== 'string' || !Array.isArray(value.transactions)) throw new Error('JEFF_SERVICE_UNAVAILABLE');
  if (value.enabled) {
    const balance = value.balance;
    if (!balance || balance.chainId !== S.session.scope.chainId || balance.wallet !== S.session.scope.owner
      || balance.currency !== 'USD' || balance.unit !== 'microUSD'
      || ['availableMicros', 'heldMicros', 'chargedMicros', 'grantedMicros'].some(key => !safeMicros(balance[key]))) throw new Error('JEFF_SERVICE_UNAVAILABLE');
  }
  return value;
}
function temporaryConnectionError(error) {
  return error.status === 429 || error.status >= 500
    || ['JEFF_NETWORK_FAILURE', 'JEFF_CHAIN_UNAVAILABLE', 'JEFF_SERVICE_UNAVAILABLE'].includes(error.message);
}
async function refresh({ quiet = false } = {}) {
  if (!S.session) return;
  clearTimeout(pollTimer);
  const version = S.version, sequence = ++refreshSequence, scope = S.session.scope;
  try {
    const value = await api('/api/workspace/state');
    const workspace = validateWorkspace(value.workspace, scope);
    if (!Array.isArray(value.jobs) || value.jobs.length > 5000 || !Array.isArray(value.schedules)) throw new Error('JEFF_RESULT_INVALID');
    const jobs = await Promise.all(value.jobs.map(job => validateRecord(job, scope)));
    const hosting = validateHosting(value.hosting, scope);
    const usage = validateUsage(value.usage);
    if (version !== S.version || sequence !== refreshSequence) return;
    if (S.admitted) {
      const observed = jobs.find(job => job.id === S.admitted.id);
      const savedConversation = workspace.conversations.find(item => item.id === S.admitted.conversationId);
      const bound = savedConversation?.jobIds.includes(S.admitted.id);
      if (observed && (bound || (!savedConversation && observed.status !== 'running'))) S.admitted = null;
      else if (!observed) jobs.unshift(S.admitted);
    }
    reconcileSettingsDraft(workspace);
    S.workspace = workspace; S.jobs = jobs; S.hosting = hosting; S.usage = usage; S.schedules = value.schedules;
    if(!S.githubConnection)await refreshGithub();
    if(version!==S.version||sequence!==refreshSequence)return;
    if (reviewedScope !== scopeKey(scope)) {
      reviewedScope = scopeKey(scope);
      try { reviewedOutcomes = parseReviewed(localStorage.getItem(reviewedKey(scope))); }
      catch { reviewedOutcomes = new Set(); }
    }
    for (const [jobId, request] of S.actionRequests) {
      const action = workspace.jobBindings?.[jobId]?.action;
      if (!action || action.status !== 'pending' || request === 'uncertain') S.actionRequests.delete(jobId);
    }
    for (const jobId of S.actionConsent) if (workspace.jobBindings?.[jobId]?.action?.status !== 'pending') S.actionConsent.delete(jobId);
    refreshFailures = 0;
    const recovered = refreshNotice && refreshNotice.scope === scopeKey(scope) && S.noticeError && S.notice === refreshNotice.message ? refreshNotice : null;
    const trackedRun = S.runNotice;
    updateRunNotice();
    if (recovered) notify(recovered.recoveryMessage || 'Connection restored. Saved work is up to date.');
    if (!workspace.conversations.some(item => item.id === S.conversationId) && !conversation()) S.conversationId = workspace.conversations.at(-1)?.id || null;
    render(); schedulePoll();
    if (!quiet && !trackedRun && !recovered) notify('Workspace refreshed.');
    return true;
  } catch (error) {
    if (version !== S.version || sequence !== refreshSequence || error.message === 'JEFF_REQUEST_SUPERSEDED') return false;
    const retry = S.session && temporaryConnectionError(error);
    if (retry) refreshFailures = Math.min(refreshFailures + 1, refreshRetryDelays.length);
    if (S.runNotice && S.session && S.runNotice.scope === scopeKey(S.session.scope)) {
      const tracked = S.runNotice;
      notify(`Task ${tracked.jobId} was admitted, but the workspace could not refresh. ${retry ? 'Checking its saved status automatically; do not send it again.' : 'Use Refresh to retrieve its saved status; do not send it again.'}`, true);
      S.runNotice = { ...tracked, message: S.notice, refreshFailed: true };
    } else {
      const recoveryMessage = refreshNotice?.scope === scopeKey(scope) ? refreshNotice.recoveryMessage : undefined;
      notify(retry ? `${error.message === 'JEFF_CHAIN_UNAVAILABLE' ? 'Ownership verification is temporarily unavailable.' : 'The connection is temporarily unavailable.'} Reconnecting to check saved work. Your task will not be sent again.` : friendly(error), true);
      if (retry) refreshNotice = { scope: scopeKey(scope), message: S.notice, recoveryMessage };
    }
    render();
    if (retry) schedulePoll();
    return false;
  }
}
function schedulePoll() {
  clearTimeout(pollTimer);
  if (!S.session || document.visibilityState === 'hidden') return;
  const version = S.version;
  const delay = refreshFailures ? refreshRetryDelays[refreshFailures - 1]
    : running() ? 2000 : S.schedules.some(item => item.status === 'active') ? 10000 : 30000;
  pollTimer = setTimeout(() => { if (version === S.version && S.session) refresh({ quiet: true }); }, delay);
}
function scheduleExpiry() {
  clearTimeout(expiryTimer);
  if (S.session) expiryTimer = setTimeout(() => { clearPrivate(); notify('Your session expired. Sign in again to reopen your saved workspace.'); }, Math.max(0, Date.parse(S.session.expiresAt) - Date.now()));
}
async function mutate(operation, success) {
  if (S.busy || !S.session) return;
  const version = S.version; S.busy = true; render();
  try {
    await operation();
    if (version !== S.version) return;
    const refreshed = await refresh({ quiet: true });
    if (refreshed && version === S.version && success) { notify(success); toast(success); }
  } catch (error) {
    if (version === S.version && error.message !== 'JEFF_REQUEST_SUPERSEDED') {
      if (!error.refreshHandled) notify(friendly(error), true);
      if (S.session && temporaryConnectionError(error)) {
        refreshFailures = Math.max(refreshFailures, 1);
        refreshNotice = { scope: scopeKey(S.session.scope), message: S.notice,
          recoveryMessage: 'Connection restored. Review saved work before retrying.' };
      }
    }
  }
  finally { if (version === S.version) { S.busy = false; render(); schedulePoll(); } }
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem(THEME_KEY, theme); } catch {}
  for (const element of $$('[data-action="theme"]')) {
    element.setAttribute('aria-label', `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`);
    $('use', element)?.setAttribute('href', `#i-${theme === 'dark' ? 'sun' : 'moon'}`);
  }
}
function closeSidebar({ restoreFocus = true } = {}) {
  $('#sidebar').classList.remove('open'); $('#sidebar-backdrop').hidden = true;
  content.inert = false; $('#context-panel').inert = false;
  if (restoreFocus && sidebarReturnFocus?.isConnected) sidebarReturnFocus.focus();
}
function openSidebar() {
  sidebarReturnFocus = document.activeElement; $('#sidebar').classList.add('open'); $('#sidebar-backdrop').hidden = false;
  content.inert = true; $('#context-panel').inert = true;
  $('.nav-item.active', $('#sidebar'))?.focus();
}
function openDialog(selector) {
  closeSidebar({ restoreFocus: false });
  const dialog = $(selector);
  if (!dialog.open) dialog.showModal();
  if (selector === '#connect-dialog') renderConnection();
  if (selector === '#command-dialog') { $('#command-search').value = ''; renderCommands(); $('#command-search').focus(); }
}
function openConnection(mode = 'nft') {
  if (S.authBusy) return false;
  S.mode = mode === 'account' ? 'account' : 'nft';
  put('#connect-status', ''); $('#switch-network').hidden = true;
  openDialog('#connect-dialog');
  return true;
}
function go(view) {
  if (!pages.some(([id]) => id === view)) return;
  S.view = view; history.replaceState(null, '', `#${view}`); closeSidebar({ restoreFocus: false });
  $$('dialog[open]').forEach(dialog => dialog.close()); render(); content.focus();
}
function field(label, id, { type = 'text', value = '', maxLength, required = true, min, max, rows } = {}) {
  const wrap = node('div', 'form-field'); const caption = node('label', 'field-label', label); caption.htmlFor = id;
  const input = node(type === 'textarea' ? 'textarea' : 'input', 'field'); input.id = id; input.name = id; input.value = value;
  if (type !== 'textarea') input.type = type;
  input.required = required;
  if (maxLength !== undefined) input.maxLength = maxLength;
  if (min !== undefined) input.min = min;
  if (max !== undefined) input.max = max;
  if (rows) input.rows = rows;
  wrap.append(caption, input); return { wrap, input };
}
function page(title, description, eyebrow = 'YOUR WORKSPACE') {
  const element = node('section', 'workspace-view page-view');
  element.append(node('span', 'eyebrow', eyebrow), node('h1', 'view-heading', title), node('p', 'view-description', description));
  return element;
}
function empty(title, description, action) {
  const element = node('div', 'agent-empty'); element.append(icon('spark'), node('h2', '', title), node('p', '', description));
  if (action) element.append(button(action[0], action[1], 'arrow', 'button button-primary'));
  return element;
}
function section(title) {
  const element = node('section', 'panel-card'); if (title) element.append(node('h2', 'section-title', title)); return element;
}
function stat(label, value, detail) {
  const element = node('div', 'panel-card stat-card'); element.append(node('span', 'memory-tag', label), node('strong', 'stat-value', value), node('span', 'muted', detail)); return element;
}
function row(label, value, detail) {
  const element = node('div', 'setting-row'), copy = node('div'); copy.append(node('strong', '', label));
  if (detail) copy.append(node('p', '', detail));
  element.append(copy, typeof value === 'string' ? node('span', 'row-value', value) : value); return element;
}
function renderAgents() {
  const list = $('#agent-list'); list.replaceChildren();
  if (!S.session) {
    const connect = button('Connect your Agent NFT', 'connect', 'plus', 'agent-item agent-connect');
    list.append(connect, node('p', 'sidebar-help', 'Your owned Rooms appear after your wallet is checked.'));
  } else if (S.session.scope.kind === 'account') {
    const element = button(agentName(), 'connect-account', 'spark', 'agent-item active');
    element.append(node('small', 'agent-item-meta', 'Standalone wallet account')); list.append(element);
    list.append(button('Open an Agent NFT', 'discover-agents', 'search', 'button sidebar-discover'));
  } else {
    const tokenIds = S.inventory?.wallet === S.session.scope.owner ? S.inventory.tokenIds : [S.session.scope.tokenId];
    for (const tokenId of tokenIds) {
      const selected = tokenId === S.session.scope.tokenId;
      const element = button('', 'select-agent', null, `agent-item${selected ? ' active' : ''}`, { token: tokenId });
      element.replaceChildren(node('span', 'agent-token-avatar', '#'));
      const copy = node('span', 'agent-item-copy');
      copy.append(node('span', 'agent-item-name', selected ? S.workspace?.settings.name || `Room #${tokenId}` : `Room #${tokenId}`), node('span', 'agent-item-meta', selected ? 'Signed holder workspace' : 'Sign in to open'));
      element.append(copy, node('span', 'status-dot')); list.append(element);
    }
    if (!S.inventory) list.append(button('Find my other Rooms', 'discover-agents', 'search', 'button sidebar-discover'));
  }
  put('#account-name', S.session ? S.session.scope.kind === 'account' ? 'Wallet account' : 'NFT holder workspace' : 'Your workspace');
  put('#account-wallet', S.session ? shortWallet(S.session.scope.owner) : 'Connect your wallet');
}
function renderShell() {
  const settings = S.workspace?.settings;
  const account = S.session?.scope.kind === 'account';
  put('#agent-title', agentName());
  put('#agent-subtitle', S.session ? account ? 'Wallet account' : `Room #${S.session.scope.tokenId}` : 'Agent NFT workspace');
  const status = $('#agent-status'); status.replaceChildren(node('span', `status-dot${settings?.paused ? ' is-paused' : running() ? ' is-working' : ''}`), document.createTextNode(
    !S.session ? 'Not connected' : !S.workspace ? 'Loading' : settings.paused ? 'Paused' : running() ? 'Working' : allowanceReason() ? 'Limited' : 'Ready'));
  status.classList.toggle('is-paused', Boolean(settings?.paused));
  put('#context-agent-name', agentName());
  put('#context-agent-room', S.session ? account ? `Account · ${shortWallet(S.session.scope.owner)}` : `Clockers Room #${S.session.scope.tokenId}` : 'Connect an Agent NFT');
  $('#ownership-mark').hidden = !S.session || account;
  put('#context-owner-note', S.session ? account ? 'Private workspace controlled by your wallet' : `Holder epoch ${S.session.scope.ownerEpoch} · ${shortWallet(S.session.scope.owner)}` : 'Your wallet proves ownership');
  put('#context-model', settings?.model?.replace(/^bankr\//, '') || '—');
  put('#context-last-run', S.jobs.length ? when(S.jobs[0].startedAt) : 'No runs yet');
  put('#context-host', S.config?.continuousHosting ? 'Simple JEFF · cloud' : 'Simple JEFF · local');
  put('#context-engine', S.config?.fixture ? 'Test fixture' : 'JEFF');
  put('#runtime-mode', !S.config ? 'CONNECTING' : S.config.fixture ? 'FIXTURE' : S.config.modelConfigured ? 'CONNECTED' : 'UNAVAILABLE');
  put('#runtime-label', S.config?.fixture ? 'DEVELOPMENT FIXTURE' : 'JEFF WORKSPACE');
  put('#runtime-copy', !S.config ? 'Connecting to JEFF…' : S.config.fixture ? 'Explicit test runtime. Responses and funding are fixtures, not live AI or payments.' : !S.config.modelConfigured ? 'JEFF’s model connection is unavailable. Sign in to reopen saved work.' : S.config.continuousHosting ? 'Hosted by Simple JEFF. Your Agent NFT’s private workspace.' : 'Your local JEFF workspace for Agent NFTs.');
  $('#runtime-banner').classList.toggle('fixture-banner', S.config?.fixture === true);
  const pause = $('#pause-agent'); pause.disabled = !signedIn() || S.busy;
  $('span', pause).textContent = settings?.paused ? 'Resume all future runs' : 'Pause all future runs';
  $('use', pause).setAttribute('href', settings?.paused ? '#i-play' : '#i-pause');
  const quota = S.hosting?.usage;
  put('#context-credit-heading', prepaid() ? 'Inference credits' : 'Task allowance');
  put('#context-credit', prepaid() ? dollars(S.usage.balance?.availableMicros) : quota ? String(quota.remaining) : '—');
  put('#context-credit-unit', prepaid() ? 'available credits' : quota ? 'tasks remaining' : 'Sign in to view');
  put('#context-budget', prepaid() && settings ? `${dollars(settings.dailyBudgetMicros)} daily budget` : quota ? `${quota.used} of ${quota.limit} tasks used` : 'Usage stays visible');
  put('#context-credit-caption', prepaid() ? 'Prepaid ledger' : quota ? `${quota.hourlyRemaining}/10 this hour` : '');
  const fraction = prepaid() && S.usage.balance?.grantedMicros ? S.usage.balance.availableMicros / S.usage.balance.grantedMicros : quota?.limit ? quota.remaining / quota.limit : 0;
  $('#credit-progress').style.width = `${Math.max(0, Math.min(100, fraction * 100))}%`;
  for (const element of $$('[data-view]')) {
    const active = element.dataset.view === S.view; element.classList.toggle('active', active);
    active ? element.setAttribute('aria-current', 'page') : element.removeAttribute('aria-current');
  }
  $$('[data-action="new-session"]').forEach(element => { element.disabled = !signedIn() || S.busy; });
  renderAgents();
}

const chatActionExpired = action => action?.type === 'schedule.create' && (Date.parse(action.parameters.expiresAt) <= Date.now()
  || (action.parameters.firstRunAt ? Date.parse(action.parameters.firstRunAt) <= Date.now()
    : Date.now() + action.parameters.intervalMinutes * 60000 >= Date.parse(action.parameters.expiresAt)));
const chatActionViewState = jobId => {
  const action = S.workspace.jobBindings?.[jobId]?.action;
  return action ? `${action.status}:${S.actionConsent.has(jobId)}:${S.actionRequests.get(jobId) || ''}:${chatActionExpired(action)}:${chatActionBlockedReason(action)}` : '';
};
function chatActionBlockedReason(action) {
  if (S.config?.restoreBlocked) return 'Saving actions is paused while restored storage is verified.';
  if (S.workspace?.settings.paused) return 'This agent is paused. Resume it in Settings before applying this action.';
  if (action.type === 'schedule.create') {
    if (!S.config?.modelConfigured) return 'The model connection is unavailable. Scheduling will reopen when it is restored.';
    if (!S.hosting?.active || Date.parse(S.hosting.expiresAt) <= Date.now()) return 'Active hosting is required. Open Hosting before authorizing this schedule.';
    if (S.config.schedulesEnabled === false) return 'Scheduled work is currently unavailable. Check saved work again later.';
  }
  return '';
}
function chatActionOutcome(jobId) {
  const action = S.workspace?.jobBindings?.[jobId]?.action;
  if (action?.status === 'applied') return action.type === 'memory.save' ? 'Memory saved.' : 'Scheduled work is authorized. Open Scheduled work to review or cancel it.';
  if (action?.status === 'dismissed') return 'Suggestion dismissed.';
  return 'Saved status checked. This suggestion is still pending; review it before applying it.';
}
function chatActionCard(job, inDialog = false) {
  const binding = S.workspace.jobBindings?.[job.id], action = binding?.action;
  if (!action || (action.status === 'pending' && (job.status !== 'completed' || binding.source !== 'manual'))) return;
  const memory = action.type === 'memory.save', p = action.parameters;
  const card = node('section', 'chat-action-card'); card.dataset.chatAction = action.type; card.dataset.actionStatus = action.status;
  card.dataset.jobId = job.id;
  const heading = node('div', 'chat-action-heading');
  heading.append(icon(memory ? 'book' : 'clock'), node('h3', '', action.status === 'applied' ? memory ? 'Saved to memory' : 'Scheduled'
    : action.status === 'dismissed' ? memory ? 'Memory suggestion dismissed' : 'Schedule suggestion dismissed'
      : memory ? 'Save this memory?' : 'Review this schedule'));
  card.append(heading);
  if (action.status === 'dismissed') return card;
  if (memory) card.append(node('strong', 'chat-action-title', p.title), node('p', 'chat-action-content', p.text));
  else {
    card.append(node('p', 'chat-action-content', p.objective));
    const facts = node('dl', 'chat-action-facts');
    const at = value => { try { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: action.timeZone }).format(new Date(value)); } catch { return when(value); } };
    const minute = `${p.intervalMinutes} minute${p.intervalMinutes === 1 ? '' : 's'}`;
    for (const [label, value] of [
      ['Timing', p.maxRuns === 1 ? 'One run' : `Every ${minute} after the previous run completes`],
      ['First run', p.firstRunAt ? at(p.firstRunAt) : `${minute} after authorization`],
      ['Maximum runs', String(p.maxRuns)], ['Expires', at(p.expiresAt)], ['Time zone', action.timeZone], ['Delivery', 'Saved in this workspace'],
    ]) { const row = node('div'); row.append(node('dt', '', label), node('dd', '', value)); facts.append(row); }
    card.append(facts);
  }
  const actions = node('div', 'chat-action-buttons');
  if (action.status === 'applied') actions.append(button(memory ? 'Open Memory' : 'Open Scheduled work', 'open-chat-action', memory ? 'book' : 'clock', 'button button-outline', { target: memory ? 'memory' : 'schedules' }));
  else {
    const checking = S.actionRequests.has(job.id), expired = chatActionExpired(action), blockedReason = chatActionBlockedReason(action);
    if (!memory && !expired) {
      const consent = node('label', 'checkbox-row chat-action-consent'), checkbox = node('input');
      checkbox.type = 'checkbox'; checkbox.id = `${inDialog ? 'dialog-' : ''}chat-action-consent-${job.id}`; checkbox.dataset.chatActionConsent = job.id;
      checkbox.checked = S.actionConsent.has(job.id); checkbox.disabled = S.busy || checking;
      consent.append(checkbox, node('span', '', `I authorize ${p.maxRuns === 1 ? 'this model run' : 'these model runs'} while my browser is closed, using my hosting allowance and any active prepaid credits.`));
      card.append(consent);
    }
    if (checking) card.append(node('p', 'preview-info', 'Check the saved action status before trying again. This does not submit the action again.'));
    if (expired) card.append(node('p', 'preview-info', 'This schedule proposal has expired. Ask your agent for a new schedule.'));
    const apply = button(memory ? 'Save memory' : 'Authorize schedule', 'apply-chat-action', memory ? 'check' : 'clock', 'button button-primary', { id: job.id });
    apply.disabled = S.busy || checking || expired || Boolean(blockedReason)
      || (!memory && !S.actionConsent.has(job.id));
    const dismiss = button('Dismiss', 'dismiss-chat-action', 'close', 'button button-subtle', { id: job.id }); dismiss.disabled = S.busy || checking;
    actions.append(apply, dismiss);
    if (blockedReason) card.append(node('p', 'preview-info', blockedReason));
    if (checking) {
      const check = button('Check saved status', 'check-chat-action', 'refresh', 'button button-outline', { id: job.id });
      check.disabled = S.busy; actions.append(check);
    }
  }
  card.append(actions); return card;
}
function resultMessage(job, showReceipt = false) {
  const message = node('article', 'message assistant'); message.dataset.jobId = job.id;
  message.dataset.jobStatus = job.status; message.dataset.busy = String(S.busy);
  message.dataset.chatActionState = chatActionViewState(job.id);
  const avatar = node('span', 'message-avatar'); avatar.append(icon('spark'));
  const body = node('div', 'message-body'), heading = node('div', 'message-header');
  heading.append(node('strong', '', S.workspace.settings.name), node('span', 'message-time', when(job.finishedAt || job.startedAt)));
  const states = { running: 'Working', completed: 'Saved', completed_unsaved: 'Not saved yet', failed: 'Failed', interrupted: 'Interrupted' };
  heading.append(pill(states[job.status] || job.status, job.status === 'completed' ? 'success' : ''));
  body.append(heading);
  const card = node('div', 'report-card live-report');
  if (job.status === 'running') {
    card.append(node('div', 'running-indicator', `${S.workspace.settings.name} is working on your request.`), node('p', 'preview-info', 'Your job is registered on the server. Closing this page does not resubmit or cancel it.'));
    const stop = button('Stop this run', 'stop-job', 'pause', 'button button-outline', { id: job.id }); stop.disabled = S.busy; card.append(stop);
  } else if (job.status === 'completed' || job.status === 'completed_unsaved') {
    const reply = node('div', 'message-text message-markdown');
    reply.append(renderMarkdown(job.text)); card.append(reply);
    if (job.status === 'completed_unsaved') {
      card.append(node('p', 'state-notice', 'This output has not been saved. It can be lost if the server restarts. Retry save reuses this output without running the model again.'), button('Retry save', 'retry-save', 'download', 'button button-primary', { id: job.id }));
    }
  } else card.append(node('p', 'message-text', job.status === 'interrupted' ? 'The server restarted before this run finished. JEFF did not automatically run the task again.' : 'This run did not complete. Review the task before deciding whether to submit a new run.'));
  if (showReceipt) {
    const receipt = node('details', 'work-disclosure receipt-details'); const summary = node('summary'); summary.append(icon('shield'), document.createTextNode('Run receipt'));
    const facts = node('dl', 'receipt-facts');
    for (const [label, value] of [['Job ID', job.id], ['Runtime', job.runtime], ['Model', job.model || 'Not returned'], ['Started', when(job.startedAt)], ['Content hash', job.textSha256 || 'Available after completion']]) {
      const part = node('div'); part.append(node('dt', '', label), node('dd', '', value)); facts.append(part);
    }
    receipt.append(summary, facts, node('p', 'preview-info', 'The content hash checks saved text integrity. It is not a signed proof of provider execution.'));
    card.append(receipt);
  }
  const chatAction = chatActionCard(job, showReceipt); if (chatAction) card.append(chatAction);
  const actions = node('div', 'message-actions');
  if (job.text) actions.append(button('Copy answer', 'copy-result', 'copy', 'text-button', { id: job.id }));
  if (showReceipt) actions.append(button('Download receipt', 'download-result', 'download', 'text-button', { id: job.id }));
  if (actions.childElementCount) card.append(actions);
  body.append(card); message.append(avatar, body); return message;
}
const personalPanels = new Map();
function personalContext(selected) {
  const panel = node('aside', 'personal-context');
  panel.setAttribute('aria-label', 'Agent responsibilities and saved preferences');
  const work = node('details', 'personal-context-section');
  const workHeading = node('summary', '', 'What I’m working on'); work.append(workHeading);
  const live = item => item.status === 'active' && Date.parse(item.expiresAt) > Date.now() && item.runs.length < item.maxRuns;
  const schedules = S.schedules.filter(item => selected && item.conversationId === selected.id)
    .sort((a, b) => Number(live(b)) - Number(live(a)));
  const key = selected?.id || 'new';
  const choices = personalPanels.get(key) || {};
  work.open = choices.work ?? schedules.some(live);
  workHeading.addEventListener('click', () => { personalPanels.set(key, { ...personalPanels.get(key), work: !work.open }); });
  for (const schedule of schedules.slice(0, 3)) {
    const card = node('div', 'personal-responsibility');
    const expired = Date.parse(schedule.expiresAt) <= Date.now();
    const active = schedule.status === 'active' && !expired && schedule.runs.length < schedule.maxRuns;
    const paused = active && S.workspace.settings.paused;
    const latest = schedule.runs.at(-1), job = latest && S.jobs.find(item => item.id === latest.jobId);
    card.append(node('strong', '', schedule.objective), node('p', 'preview-info',
      paused ? 'Future runs paused' : active && latest?.status === 'claimed' ? 'Current run admitted. Next check-in follows completion.'
        : active ? `Next check-in: ${when(schedule.nextRunAt)} (${browserTimeZone()})`
        : expired && schedule.status === 'active' ? 'Expired' : schedule.status === 'active' ? 'Run limit reached' : schedule.status));
    card.append(node('p', 'preview-info', `${schedule.runs.length}/${schedule.maxRuns} runs used · Ends ${when(schedule.expiresAt)} · Saved in this workspace`));
    if (latest) {
      const saved = job?.status === 'completed' && typeof job.text === 'string';
      const outcome = saved ? 'Saved' : job?.status ? job.status.replaceAll('_', ' ') : latest.status === 'claimed' ? 'Working' : latest.status;
      card.append(node('p', 'preview-info', `Latest run: ${outcome}`));
      if (saved) card.append(button('Open saved result', 'open-job', 'arrow', 'text-button', { id: job.id }));
      if (latest.error || ['failed', 'interrupted'].includes(latest.status)) card.append(node('p', 'preview-info', 'This run was not automatically replayed.'));
    }
    work.append(card);
  }
  if (!schedules.length) {
    work.append(node('p', 'preview-info', 'Give me something to follow through on.'));
    work.append(button('Prepare a check-in', 'suggestion', 'clock', 'text-button', {
      prompt: 'Every 60 minutes, review the notes in this conversation and save a short next-step summary. Stop after 3 runs.',
    }));
  }
  work.append(button('Manage scheduled work', 'open-chat-action', 'clock', 'text-button', { target: 'schedules' }));
  const memory = node('details', 'personal-context-section');
  const memoryHeading = node('summary', '', 'Saved context I remember'); memory.append(memoryHeading);
  memory.open = choices.memory ?? false;
  memoryHeading.addEventListener('click', () => { personalPanels.set(key, { ...personalPanels.get(key), memory: !memory.open }); });
  for (const note of S.workspace.memories.slice(0, 3)) memory.append(node('p', 'preview-info', `${note.title}: ${note.text}`));
  if (!S.workspace.memories.length) memory.append(node('p', 'preview-info', 'No saved context yet. Ask me to remember a preference.'));
  memory.append(button('Open Memory', 'open-chat-action', 'book', 'text-button', { target: 'memory' }));
  panel.append(work, memory); return panel;
}
function returnSummary() {
  const outcomes = unseenOutcomes(S.jobs, reviewedOutcomes);
  if (!outcomes.length) return null;
  const panel = node('section', 'personal-context-section return-summary');
  panel.setAttribute('aria-label', 'Since your last visit');
  panel.append(node('h2', '', 'Since your last visit'), node('p', 'preview-info', `${outcomes.length} saved or unsuccessful ${outcomes.length === 1 ? 'run' : 'runs'} not marked reviewed in this browser.`));
  const shown = outcomes.slice(0, 5);
  for (const job of shown) {
    const item = node('div', 'personal-responsibility');
    item.append(node('strong', '', job.objective), pill(job.status === 'completed' ? 'Saved' : job.status === 'interrupted' ? 'Interrupted' : 'Failed', job.status === 'completed' ? 'success' : ''), button('Open result', 'open-job', 'arrow', 'text-button', { id: job.id }));
    panel.append(item);
  }
  if (outcomes.length > 5) panel.append(button('View all runs', 'open-chat-action', 'activity', 'text-button', { target: 'activity' }));
  panel.append(button('Mark these reviewed', 'review-outcomes', 'check', 'button button-subtle', {
    ids: JSON.stringify(shown.map(job => job.id)), scope: scopeKey(S.session.scope),
  }));
  return panel;
}
function renderChat() {
  const view = node('section', 'workspace-view chat-view');
  if (!signedIn()) { view.append(empty(S.session ? 'Opening your workspace…' : 'A home for your Agent NFT.', S.session ? 'Checking ownership and loading saved work.' : 'Give your agent useful work. Keep conversations and memories together, and return to the results whenever you need them.', S.session ? null : ['Connect an Agent NFT', 'connect'])); return view; }
  const selected = conversation(), conversations = S.workspace.conversations.slice();
  if (selected && !conversations.some(item => item.id === selected.id)) conversations.push(selected);
  const toolbar = node('div', 'conversation-toolbar');
  const selector = node('select', 'field conversation-select'); selector.id = 'conversation-select'; selector.setAttribute('aria-label', 'Open a saved conversation');
  if (!conversations.length) selector.append(node('option', '', 'Start your first conversation'));
  for (const item of conversations.reverse()) { const option = node('option', '', item.title); option.value = item.id; option.selected = item.id === S.conversationId; selector.append(option); }
  selector.disabled = S.busy || !conversations.length;
  toolbar.append(selector, button('Refresh', 'refresh', 'activity', 'button button-subtle'));
  if (conversation()) { const del = button('Delete conversation', 'delete-conversation', 'close', 'icon-button'); del.replaceChildren(icon('close')); del.setAttribute('aria-label', 'Delete this conversation'); del.disabled = S.busy || running(); toolbar.append(del); }
  view.append(toolbar);
  const returned = returnSummary(); if (returned) view.append(returned);
  view.append(personalContext(selected));
  const feed = node('div', 'chat-feed'); feed.id = 'chat-feed'; feed.setAttribute('aria-live', running() ? 'off' : 'polite');
  const selectedJobs = selected ? selected.jobIds.map(id => S.jobs.find(job => job.id === id)).filter(Boolean) : [];
  const submitting = S.submission?.conversationId === S.conversationId ? S.submission : null;
  if (!selectedJobs.length && !submitting) feed.append(empty(selected ? 'What are we working on?' : 'Your first conversation starts here.', `Bring an idea, a question, or material to work through. ${agentName()} can write, analyze and plan from what you provide.`));
  for (const job of selectedJobs) {
    const user = node('article', 'message user'), body = node('div', 'message-body'), heading = node('div', 'message-header');
    heading.append(node('strong', '', 'You'), node('span', 'message-time', when(job.startedAt))); body.append(heading, node('p', 'user-bubble message-text', job.objective)); user.append(body); feed.append(user, resultMessage(job));
  }
  if (submitting) {
    const message = node('article', 'message user pending-message'), body = node('div', 'message-body'), heading = node('div', 'message-header');
    message.dataset.pendingMessage = submitting.status;
    heading.append(node('strong', '', 'You'), pill(submitting.status === 'sending' ? 'Sending…' : 'Send not confirmed'));
    body.append(heading, node('p', 'user-bubble message-text', submitting.objective)); message.append(body); feed.append(message);
  }
  view.append(feed);
  const composerWrap = node('div', 'composer-wrap');
  const suggestions = node('div', 'prompt-suggestions');
  for (const [title, prompt, iconName] of [['Plan a project', 'Help me plan a project. Ask me about my goal, constraints and deadline.', 'clock'], ['Shape an idea', 'Help me examine an idea. Ask me for the context and compare the main options.', 'spark'], ['Draft an update', 'Help me draft a community update. Ask me for the information and tone to use.', 'book']]) suggestions.append(button(title, 'suggestion', iconName, 'suggestion-chip', { prompt }));
  const form = node('form', 'composer'); form.id = 'composer-form';
  const input = node('textarea'); input.id = 'composer-input'; input.name = 'objective'; input.placeholder = `Give ${S.workspace.settings.name} something to work on…`; input.maxLength = 4000; input.rows = 2; input.required = true; input.value = S.draft;
  const reason = allowanceReason(); input.disabled = Boolean(reason) && !running() && S.submission?.status !== 'sending';
  const lower = node('div', 'composer-bottom'), meta = node('div', 'composer-meta'); meta.append(icon('spark'), node('span', '', S.workspace.settings.model.replace(/^bankr\//, '')), pill('PRIVATE WORKSPACE'));
  const send = button('Send task', 'send-task', 'send', 'send-button'); send.type = 'submit'; send.setAttribute('aria-label', 'Send task'); send.disabled = Boolean(reason) || S.busy || !S.draft.trim();
  if (S.submission?.status === 'sending') { send.setAttribute('aria-label', 'Sending message'); send.setAttribute('aria-busy', 'true'); }
  lower.append(meta, send); form.append(input, lower);
  composerWrap.append(suggestions, form, node('p', 'composer-footnote', reason || 'Enter to send · Shift + Enter for a new line · External tools and messaging are disabled.'));
  if (S.session.scope.kind === 'account' && (!S.hosting.active || Date.parse(S.hosting.expiresAt) <= Date.now())) {
    const actions = node('div', 'prompt-suggestions');
    actions.append(button('Open your Agent NFT', 'connect', 'link', 'button button-outline'));
    composerWrap.append(actions);
  }
  view.append(composerWrap); return view;
}
function renderActivity() {
  const view = page('A clear trail of work.', 'Actual runs and saved workspace changes. Open a receipt to see its status and result.', 'ACTIVITY');
  const actions = node('div', 'page-actions'); actions.append(button('Refresh activity', 'refresh', 'activity')); view.append(actions);
  if (!S.jobs.length && !S.workspace.activity.length) { view.append(empty('No activity yet.', 'Your agent’s work and the changes you make will appear here.')); return view; }
  const jobs = section('Runs');
  for (const job of S.jobs) {
    const element = node('div', 'list-row activity-row'), marker = node('span', 'activity-marker'); marker.append(icon(job.status === 'completed' ? 'check' : job.status === 'running' ? 'clock' : 'activity'));
    const copy = node('div', 'activity-copy'); copy.append(node('strong', '', job.objective), node('span', 'muted', `${when(job.startedAt)} · ${job.model || 'JEFF'} · ${job.id}`));
    element.append(marker, copy, pill(job.status.replaceAll('_', ' '), job.status === 'completed' ? 'success' : ''), button('Open receipt', 'open-job', 'arrow', 'text-button', { id: job.id })); jobs.append(element);
  }
  if (!S.jobs.length) jobs.append(node('p', 'preview-info', 'No runs have been submitted.'));
  const changes = section('Workspace changes');
  for (const event of S.workspace.activity.slice().reverse()) {
    const element = node('div', 'list-row'); element.append(node('span', 'activity-copy', event.message), node('span', 'activity-time', when(event.at))); changes.append(element);
  }
  if (!S.workspace.activity.length) changes.append(node('p', 'preview-info', 'No saved workspace changes yet.'));
  view.append(jobs, changes); return view;
}
function renderSkills() {
  const view = page('Choose how your agent works.', 'Use available tools or choose prompt recipes to guide its responses.', 'SKILLS & TOOLS');
  view.append(githubConnectorPanel({connection:S.githubConnection,repositoryList:S.githubRepositories,draft:S.githubDraft,busy:S.busy,
    uncertainAdmission:S.githubUnconfirmed||S.researchDraft.unconfirmed||Boolean(S.submission)||Boolean(allowanceReason()),
    onDraft:draft=>{S.githubDraft=draft;},onRefresh:()=>mutate(refreshGithub),
    onConnect:()=>mutate(async()=>{const value=await api('/api/connectors/github/authorize',{method:'POST',body:{}});const url=new URL(value.authorizationUrl);if(url.origin!=='https://github.com'||url.pathname!=='/login/oauth/authorize')throw new Error('JEFF_RESULT_INVALID');location.assign(url.href);}),
    onDisconnect:()=>mutate(async()=>{const value=await api('/api/connectors/github',{method:'DELETE'});await refreshGithub();notify(value.providerRevoked?'GitHub disconnected here and provider token revoked.':'GitHub disconnected here. Provider token revocation was not confirmed.');}),
    onRead:readGithub,
  }));
  if(S.githubUnconfirmed){
    const reset=node('button','button button-outline','I checked Activity; prepare another GitHub read');reset.type='button';reset.disabled=S.busy;
    reset.addEventListener('click',()=>{if(S.busy)return;S.githubUnconfirmed=false;S.githubDraft.repositoryId='';mutate(refreshGithub);});view.append(reset);
  }
  const enabled = S.config.webResearch?.enabled === true;
  const reader = section('Read public pages & JSON');
  reader.classList.add('research-tool');
  reader.append(pill(enabled ? 'Available' : 'Unavailable', enabled ? 'success' : ''), node('p', 'preview-info', 'Read up to 3 public HTTPS pages or JSON endpoints you provide and save an answer with sources. For example, summarize a public GitHub releases endpoint. This tool does not search the web.'));
  if (enabled) {
    const form = node('form', 'research-form'); form.id = 'research-form';
    const example = button('Try an OpenClaw release example', 'research-example', 'arrow', 'text-button');
    example.disabled = S.busy || S.researchDraft.unconfirmed;
    form.append(example, node('p', 'preview-info', 'Fills a public GitHub JSON link and a question. Review them and authorize the run below.'));
    const question = field('Question about these sources', 'research-question', { type: 'textarea', value: S.researchDraft.question, maxLength: 4000, rows: 2 });
    const urls = field('Public HTTPS links, one per line', 'research-urls', { type: 'textarea', value: S.researchDraft.urls, maxLength: 6000, rows: 3 });
    $('textarea', question.wrap).required = true; $('textarea', urls.wrap).required = true;
    const label = node('label', 'checkbox-row'), consent = node('input'); consent.type = 'checkbox'; consent.id = 'research-consent'; consent.required = true; consent.checked = S.researchDraft.consent;
    label.append(consent, node('span', '', 'Allow this run to read the public sources listed above. This run uses my hosting allowance and any active prepaid credits.'));
    const submit = button('Read these sources', 'read-pages', 'search', 'button button-primary'); submit.type = 'submit'; submit.disabled = S.busy || Boolean(allowanceReason()) || S.researchDraft.unconfirmed;
    form.append(question.wrap, urls.wrap, node('p', 'preview-info', `Permission applies to this run only. Reads up to ${S.config.webResearch.maxExcerptChars || 2400} text characters per source, without following links or redirects. Use public URLs that require no login, API key or access token. Results are saved in Conversation. Stop controls active work.`), label, submit);
    if (allowanceReason()) form.append(node('p', 'state-notice', allowanceReason()));
    if (S.researchDraft.unconfirmed) form.append(node('p', 'state-notice', 'The previous request could not be confirmed. Check Activity before preparing another run.'), button('Open Activity', 'open-chat-action', 'activity', 'text-button', { target: 'activity' }), button('I checked Activity; prepare another run', 'prepare-research-retry', null, 'button button-outline'));
    reader.append(form);
  } else reader.append(node('p', 'state-notice', 'Public-source reading is unavailable on this runtime. Prompt recipes below do not enable it.'));
  view.append(reader, node('h2', 'section-title', 'Prompt recipes'));
  const grid = node('div', 'skills-grid');
  for (const skill of S.workspace.skills) {
    const card = node('article', 'skill-card'), top = node('div', 'skill-card-top'), glyph = node('span', 'skill-icon'); glyph.append(icon(skill.id === 'writing' ? 'book' : skill.id === 'analysis' ? 'search' : 'clock'));
    const toggle = button(`${skill.enabled ? 'Disable' : 'Enable'} ${skill.name}`, 'toggle-skill', null, 'toggle-switch', { id: skill.id }); toggle.replaceChildren(); toggle.setAttribute('role', 'switch'); toggle.setAttribute('aria-checked', String(skill.enabled)); toggle.setAttribute('aria-label', `${skill.name} prompt recipe`); toggle.disabled = S.busy;
    top.append(glyph, toggle); card.append(top, node('span', 'eyebrow', 'PROMPT RECIPE'), node('h2', '', skill.name), node('p', '', skill.description), pill(skill.enabled ? 'Enabled' : 'Disabled')); grid.append(card);
  }
  view.append(grid, node('p', 'state-notice tools-notice', 'Prompt recipes do not grant tool access. Shell execution, wallet spending and outbound messages are unavailable.'));
  return view;
}
async function refreshGithub(){
  const version=S.version;
  try{
    const connection=await api('/api/connectors/github');if(version!==S.version)return;
    if(!['not_configured','not_connected','connected','reconnect_required','unavailable'].includes(connection.status))throw new Error('JEFF_RESULT_INVALID');
    if(S.githubConnection?.generation!==connection.generation){S.githubDraft.repositoryId='';S.githubRepositories=null;}
    S.githubConnection=connection;
    const repositories=connection.status==='connected'?await api('/api/connectors/github/repositories'):null;
    if(version!==S.version)return;
    S.githubRepositories=repositories;
  }catch(error){
    if(version===S.version){
      try{const status=await api('/api/connectors/github');if(version===S.version)S.githubConnection=status;}
      catch{if(version===S.version)S.githubConnection={status:'unavailable'};}
      if(version===S.version)S.githubRepositories=null;
    }
    if(error.message==='JEFF_REQUEST_SUPERSEDED')return;
  }
}
async function readGithub(input){
  if(!signedIn()||S.busy||allowanceReason()||S.githubUnconfirmed||S.researchDraft.unconfirmed||S.submission)return;
  const version=S.version,scope=S.session.scope,selected=conversation();
  await mutate(async()=>{
    try{
      const record=await api('/api/jobs',{method:'POST',body:{...input,timeZone:browserTimeZone(),...(selected?{conversationId:selected.id}:{})}});
      await validateRecord(record,scope);if(version!==S.version)return;
      if(!JOB_ID.test(record.conversationId))throw new Error('JEFF_RESULT_INVALID');
      S.conversationId=record.conversationId;S.admitted=record;S.jobs=[record,...S.jobs.filter(job=>job.id!==record.id)];notifyRun(record.id,'GitHub read admitted. Its saved result will appear here.');go('chat');
    }catch(error){if(version===S.version&&(temporaryConnectionError(error)||error.message==='JEFF_RESULT_INVALID'))S.githubUnconfirmed=true;throw error;}
  });
}
function renderMemory() {
  const view = page('A little context goes a long way.', `Ask ${agentName()} to remember something in Conversation, or add a note here. These memories stay in your private workspace.`, 'MEMORY');
  const grid = node('div', 'memory-grid');
  for (const memory of S.workspace.memories) {
    const card = node('article', 'memory-card'), heading = node('div', 'section-title'); heading.append(node('h2', '', memory.title), pill('USER NOTE'));
    card.append(heading, node('p', 'memory-content', memory.text), node('span', 'memory-tag', `Updated ${when(memory.updatedAt)}`));
    const actions = node('div', 'memory-actions'); actions.append(button('Edit', 'edit-memory', 'book', 'text-button', { id: memory.id }), button('Delete', 'delete-memory', 'close', 'text-button', { id: memory.id })); card.append(actions); grid.append(card);
  }
  if (!S.workspace.memories.length) grid.append(node('div', 'empty-state', 'No saved memories yet. Add a preference, project detail or useful reference below.'));
  const card = section(S.memoryDraft.id ? 'Edit a memory' : 'Add a memory');
  const form = node('form', 'memory-form'); form.id = 'memory-form';
  const title = field('Title', 'memory-title', { value: S.memoryDraft.title, maxLength: 120 });
  const text = field(`What should ${agentName()} remember?`, 'memory-text', { type: 'textarea', value: S.memoryDraft.text, maxLength: 4000, rows: 5 });
  const submit = button(S.memoryDraft.id ? 'Save changes' : 'Save memory', 'save-memory', 'check', 'button button-primary'); submit.type = 'submit'; submit.disabled = S.busy;
  form.append(title.wrap, text.wrap, submit);
  if (S.memoryDraft.id) form.append(button('Cancel edit', 'cancel-memory-edit', 'close'));
  card.append(form, node('p', 'preview-info', 'Do not store passwords, recovery phrases or API keys here. NFT transfers open a fresh private workspace for the new holder.'));
  view.append(grid, card); return view;
}
function renderUsage() {
  const view = page('Know what your agent uses.', prepaid() ? 'Your wallet’s funded inference credits and reserved usage, alongside this NFT’s hosting task allowance.' : 'Model use is operator funded. This workspace has a task allowance, not a dollar credit balance or a provider billing cap.', 'USAGE & CREDITS');
  const stats = node('div', 'stats-grid'), quota = S.hosting?.usage;
  stats.append(stat('TASKS REMAINING', quota ? String(quota.remaining) : '—', quota ? `${quota.used} used of ${quota.limit} this period` : 'Hosting details unavailable'), stat('HOURLY ALLOWANCE', quota ? `${quota.hourlyRemaining}/${quota.hourlyLimit}` : '—', quota?.hourlyResetsAt ? `Next slot ${when(quota.hourlyResetsAt)}` : 'Rolling hour'), stat(prepaid() ? 'AVAILABLE CREDITS' : 'MODEL FUNDING', prepaid() ? dollars(S.usage.balance.availableMicros) : 'Included', prepaid() ? 'Wallet-scoped prepaid balance' : 'Operator funded within task allowance'));
  view.append(stats);
  const chart = section('Runs over the last seven days'); const columns = node('div', 'usage-chart live-usage-chart');
  const days = Array.from({ length: 7 }, (_, index) => { const date = new Date(); date.setHours(0, 0, 0, 0); date.setDate(date.getDate() - (6 - index)); const count = S.jobs.filter(job => { const time = Date.parse(job.startedAt); return time >= date.getTime() && time < date.getTime() + 86400000; }).length; return { date, count }; });
  const peak = Math.max(1, ...days.map(day => day.count));
  for (const day of days) { const column = node('div', 'chart-column'); column.style.setProperty('--height', `${day.count ? Math.max(4, day.count / peak * 100) : 1}%`); column.title = `${day.date.toLocaleDateString()}: ${day.count} runs`; column.setAttribute('aria-label', column.title); column.append(node('span', '', day.date.toLocaleDateString(undefined, { weekday: 'short' })), node('b', 'chart-count', String(day.count))); columns.append(column); }
  chart.append(columns, node('p', 'preview-info', 'Counts show admitted runs, including failed or interrupted work. They are not provider cost estimates.')); view.append(chart);
  const details = section(prepaid() ? 'Inference ledger' : 'Inference availability');
  if (prepaid()) {
    const balance = S.usage.balance;
    details.append(row('Granted', dollars(balance.grantedMicros)), row('Charged', dollars(balance.chargedMicros)), row('Reserved / uncertain', dollars(balance.heldMicros)), row('Daily budget', dollars(S.workspace.settings.dailyBudgetMicros), 'Enforced at inference admission for this agent’s rolling 24-hour usage. Credits are shared by the wallet.'));
    details.append(node('p', 'preview-info', `Pricing basis: ${S.usage.pricingBasis || 'Operator-configured reservation pricing.'}`));
    const records = section('Recent credit entries');
    for (const entry of S.usage.transactions) { const element = node('div', 'list-row'); const copy = node('div', 'activity-copy'); copy.append(node('strong', '', entry.type === 'grant' ? 'Funded credit grant' : `Inference ${entry.state}`), node('span', 'muted', `${when(entry.createdAt)} · ${entry.id}`)); element.append(copy, node('span', 'row-value', dollars(entry.type === 'grant' ? entry.amountMicros : entry.state === 'charged' ? entry.chargedMicros : entry.reservedMicros))); records.append(element); }
    if (!S.usage.transactions.length) records.append(node('p', 'preview-info', 'No credit entries yet.'));
    view.append(details, records);
  } else {
    details.append(node('p', 'message-text', 'No prepaid inference wallet is active for this runtime. New runs use the hosting task allowance and operator-funded model connection.'), node('p', 'preview-info', 'The daily budget preference is saved for prepaid mode. It does not cap the operator’s provider bill in this mode. $CLOCKERS holder distributions are not enabled by this interface.'));
    view.append(details);
  }
  view.append(button('Refresh usage', 'refresh', 'activity')); return view;
}
function renderSettings() {
  const view = page('Make this agent yours.', 'A name, a model and clear limits. Settings are saved privately for this NFT, holder and ownership epoch.', 'SETTINGS');
  const settings = S.settingsDraft || { ...S.workspace.settings, budget: dollarsInput(S.workspace.settings.dailyBudgetMicros) };
  const form = node('form', 'panel-card settings-form'); form.id = 'settings-form';
  if (settings.conflict) {
    const conflict = node('div', 'state-notice settings-conflict'); conflict.setAttribute('role', 'status');
    conflict.append(node('p', '', 'Saved settings changed while you were editing. Your draft is preserved. Review the saved values before choosing which settings to use.'),
      row('Saved agent name', S.workspace.settings.name), row('Saved model', S.workspace.settings.model.replace(/^bankr\//, '')),
      row('Saved daily budget', dollars(S.workspace.settings.dailyBudgetMicros)), row('Saved run preference', S.workspace.settings.paused ? 'Paused' : 'Active'));
    const keep = button('Keep my draft', 'keep-settings-draft', 'check'); keep.disabled = S.busy;
    const reset = button('Use saved settings', 'reset-settings-draft', 'activity'); reset.disabled = S.busy;
    conflict.append(keep, reset); form.append(conflict);
  }
  const name = field('Agent name', 'settings-name', { value: settings.name, maxLength: 80 });
  const modelWrap = node('div', 'form-field'); const label = node('label', 'field-label', 'Model'); label.htmlFor = 'settings-model';
  const select = node('select', 'field'); select.id = 'settings-model'; select.name = 'settings-model';
  for (const model of S.config.allowedModels) { const option = node('option', '', model.replace(/^bankr\//, '')); option.value = model; option.selected = model === settings.model; select.append(option); }
  modelWrap.append(label, select);
  const budget = field('Daily inference budget (USD)', 'settings-budget', { value: settings.budget, maxLength: 14 }); budget.input.inputMode = 'decimal';
  form.append(name.wrap, modelWrap, budget.wrap, node('p', 'preview-info', prepaid() ? 'Prepaid inference admission enforces this agent’s rolling 24-hour usage limit. Amounts use exact microdollar units.' : 'Saved for prepaid mode. Current operator-funded task allowances do not enforce a dollar cap on provider billing.'));
  const paused = node('label', 'checkbox-row'); const checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.id = 'settings-paused'; checkbox.checked = settings.paused; paused.append(checkbox, node('span', '', 'Pause future manual and scheduled runs')); form.append(paused);
  const save = button('Save settings', 'save-settings', 'check', 'button button-primary'); save.type = 'submit'; save.disabled = S.busy || settings.conflict === true; form.append(save);
  if (S.settingsDraft && !settings.conflict) { const reset = button('Discard changes', 'reset-settings-draft', 'close'); reset.disabled = S.busy; form.append(reset); }
  const owner = section('Ownership & session'); owner.append(row('Wallet', S.session.scope.owner), row('Network', `Chain ${S.session.scope.chainId}`));
  if (S.session.scope.kind !== 'account') owner.append(row('NFT', `${S.session.scope.collection} #${S.session.scope.tokenId}`), row('Holder epoch', String(S.session.scope.ownerEpoch), 'Transfers isolate private conversations, settings and memory.'));
  owner.append(row('Session ends', when(S.session.expiresAt)), button('Sign out', 'logout', 'arrow-left'));
  view.append(form, owner); return view;
}
function renderSchedules() {
  const view = page('Let the work come back to you.', 'Authorize a bounded recurring task. Scheduled turns run on this service while your browser is closed, with ownership, hosting and limits checked at each run.', 'SCHEDULED WORK');
  if (S.config.schedulesEnabled === false) view.append(node('p', 'state-notice', S.config.restoreBlocked ? 'New scheduled work is blocked while restored storage awaits reconciliation.' : 'Scheduled work is currently unavailable on this runtime.'));
  const list = section('Your schedules');
  for (const schedule of S.schedules) {
    const card = node('article', 'schedule-card'); card.append(node('h3', '', schedule.objective), pill(schedule.status, schedule.status === 'active' ? 'success' : ''), node('p', 'preview-info', `Every ${schedule.intervalMinutes} minute${schedule.intervalMinutes === 1 ? '' : 's'} · ${schedule.runs.length}/${schedule.maxRuns} runs admitted · expires ${when(schedule.expiresAt)}`));
    if (schedule.status === 'active') { card.append(node('p', 'preview-info', `Next run ${when(schedule.nextRunAt)}`)); const cancel = button('Cancel schedule', 'cancel-schedule', 'pause', 'button button-outline', { id: schedule.id }); cancel.disabled = S.busy; card.append(cancel); }
    for (const run of schedule.runs) { const item = node('div', 'schedule-run'); item.append(node('span', '', `Run ${run.index}: ${run.status}`), node('span', 'muted', when(run.claimedAt))); if (run.jobId) item.append(button('Open run', 'open-job', 'arrow', 'text-button', { id: run.jobId })); if (run.error) item.append(node('p', 'preview-info', 'The occurrence could not complete and was not automatically replayed.')); card.append(item); }
    list.append(card);
  }
  if (!S.schedules.length) list.append(node('p', 'preview-info', 'No recurring work is authorized yet.'));
  view.append(list);
  const card = section('Authorize a scheduled task'), form = node('form', 'schedule-form'); form.id = 'schedule-form';
  const defaults = S.scheduleDraft || { objective: '', interval: '60', maxRuns: '3', expiry: '24', consent: false };
  const objective = field('Task to repeat', 'schedule-objective', { type: 'textarea', value: defaults.objective, maxLength: 4000, rows: 3 });
  const interval = field('Minutes between runs', 'schedule-interval', { type: 'number', value: defaults.interval, min: 1, max: 10080 });
  const maxRuns = field('Maximum runs', 'schedule-max-runs', { type: 'number', value: defaults.maxRuns, min: 1, max: 24 });
  const expiry = field('Grant expires in (hours)', 'schedule-expiry', { type: 'number', value: defaults.expiry, min: 1, max: 168 });
  const fields = node('div', 'form-grid'); fields.append(interval.wrap, maxRuns.wrap, expiry.wrap);
  const consent = node('label', 'checkbox-row'); const checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.id = 'schedule-consent'; checkbox.required = true; checkbox.checked = defaults.consent;
  consent.append(checkbox, node('span', '', 'I authorize these recurring model runs while my browser is closed. They consume my hosting allowance and, when active, prepaid credits.'));
  const submit = button('Authorize schedule', 'save-schedule', 'clock', 'button button-primary'); submit.type = 'submit'; submit.disabled = S.busy || !S.hosting?.active || !S.config?.modelConfigured || S.workspace.settings.paused || S.config.schedulesEnabled === false;
  form.append(objective.wrap, fields, consent, submit); card.append(form, node('p', 'preview-info', 'At most 24 runs over seven days. The first run starts after the interval. Pause or cancel stops future admissions. A failed or interrupted occurrence is not replayed automatically.'));
  view.append(card); return view;
}
function renderHosting() {
  const view = page('A home that stays available.', 'Simple JEFF hosts your agent workspace. Your hosting term stays with the NFT; private work stays with its holder epoch.', 'HOSTING');
  const hosting = S.hosting, quota = hosting?.usage;
  const stats = node('div', 'stats-grid'); stats.append(stat('HOSTING', hosting.active ? 'Active' : 'Inactive', hosting.source ? hosting.source.replaceAll('-', ' ') : 'No current term'), stat('TASKS INCLUDED', quota ? String(quota.limit) : '—', quota ? `${quota.remaining} remaining` : ''), stat('TERM ENDS', hosting.expiresAt ? new Date(hosting.expiresAt).toLocaleDateString() : '—', hosting.expiresAt ? when(hosting.expiresAt) : 'Activate a hosting term')); view.append(stats);
  const pass = hosting.freePass;
  if (pass) {
    const card = section('Your NFT’s free month');
    card.append(node('p', 'message-text', pass.state === 'available' ? `This NFT can claim one ${pass.periodDays}-day hosting pass with ${pass.tasksIncluded} tasks. No payment or transaction is required.` : pass.state === 'consumed' ? 'This NFT’s free month has been claimed. Transfer, restart and expiry do not restore the pass.' : 'A free hosting pass is not available on this runtime.'));
    if (pass.startsAt) card.append(row(pass.state === 'available' ? 'Proposed start' : 'Starts', when(pass.startsAt)), row('Expires', when(pass.expiresAt)));
    if (pass.state === 'available') { const claim = button('Claim free month', 'claim-free-pass', 'spark', 'button button-primary'); claim.disabled = S.busy; card.append(claim); }
    view.append(card);
  }
  const billing = section('Monthly hosting');
  billing.append(node('p', 'message-text', hosting.plan ? `${formatUsdCents(hosting.plan.usdCents)} worth of $CLOCKERS for ${hosting.plan.periodDays} days, with ${hosting.plan.tasksIncluded} tasks.` : 'Monthly hosting availability comes from the service.'));
  if (!(S.config.billingEnabled && hosting.checkoutEnabled)) billing.append(node('p', 'state-notice', 'Paid checkout is unavailable on this runtime. No payment is requested.'));
  else {
    const invoice = button(S.invoice ? 'Refresh invoice' : 'Create hosting invoice', 'create-invoice', 'credit', 'button button-primary'); invoice.disabled = S.busy || S.paymentSubmitted; billing.append(invoice);
    if (S.invoice) {
      const quote = S.invoice;
      billing.append(row('Token contract', quote.token), row('Treasury recipient', quote.recipient), row('Exact amount', S.decimals === null ? `${quote.amount} smallest token units` : `${formatTokenAmount(quote.amount, S.decimals)} CLOCKERS`), row('Network', `Chain ${quote.chainId}`), row('Quote expires', when(quote.expiresAt)));
      billing.append(node('p', 'preview-info', 'Review the exact token, network, recipient and amount. Payment is an ERC-20 transfer, with no token approval or automatic renewal. Hosting activates only after server verification.'));
      const pay = button(S.paymentSubmitted ? 'Payment submitted · verify below' : 'Pay exact invoice in wallet', 'pay-invoice', 'credit', 'button button-primary'); pay.disabled = S.busy || S.paymentSubmitted || S.decimals === null || Date.parse(quote.expiresAt) <= Date.now(); billing.append(pay);
      const form = node('form', 'payment-form'); form.id = 'payment-form'; const hash = field('Payment transaction hash', 'payment-hash', { value: S.paymentHash, maxLength: 66 }); hash.input.pattern = '0x[a-fA-F0-9]{64}';
      const verify = button('Verify this payment', 'verify-payment', 'shield'); verify.type = 'submit'; verify.disabled = S.busy;
      form.append(hash.wrap, verify); billing.append(form, node('p', 'state-notice', 'Keep your invoice and transaction reference before closing this page. If verification is pending, use the same transaction hash. Do not send a second payment.'), button('Download invoice reference', 'download-invoice', 'download'));
    }
  }
  view.append(billing, button('Refresh hosting', 'refresh', 'activity')); return view;
}
function render() {
  const focus = document.activeElement?.id;
  const start = document.activeElement?.selectionStart, end = document.activeElement?.selectionEnd;
  const scroll = $('#chat-feed')?.scrollTop || content.scrollTop;
  const atBottom = $('#chat-feed') ? $('#chat-feed').scrollHeight - $('#chat-feed').scrollTop - $('#chat-feed').clientHeight < 120 : false;
  renderShell();
  let view;
  if (!signedIn()) view = S.view === 'chat' ? renderChat() : page(pages.find(([id]) => id === S.view)?.[1] || 'Your workspace', 'Connect your Agent NFT to open its private workspace.');
  else view = ({ chat: renderChat, activity: renderActivity, skills: renderSkills, memory: renderMemory, usage: renderUsage, schedules: renderSchedules, hosting: renderHosting, settings: renderSettings }[S.view] || renderChat)();
  if (!signedIn() && S.view !== 'chat') view.append(empty('Your NFT opens the workspace.', 'Ownership is checked before private settings, memory and history are returned.', ['Connect an Agent NFT', 'connect']));
  content.replaceChildren(view);
  for (const dialog of $$('.receipt-dialog[open]')) {
    const current = $('.message.assistant', dialog), job = S.jobs.find(item => item.id === current?.dataset.jobId);
    if (!signedIn() || !job) { dialog.close(); continue; }
    if (current.dataset.jobStatus !== job.status || current.dataset.busy !== String(S.busy)
      || current.dataset.chatActionState !== chatActionViewState(job.id)) current.replaceWith(resultMessage(job, true));
  }
  if (S.busy) $$('form input, form textarea, form select', content).forEach(element => { if (element.id !== 'composer-input') element.disabled = true; });
  if (focus && $(`#${focus}`, content)) {
    const element = $(`#${focus}`, content);
    if (!element.disabled) { element.focus({ preventScroll: true }); if (typeof start === 'number' && element.setSelectionRange && !['number', 'checkbox'].includes(element.type)) element.setSelectionRange(start, end); }
  }
  const feed = $('#chat-feed'); if (feed) feed.scrollTop = atBottom ? feed.scrollHeight : scroll; else content.scrollTop = scroll;
}

function bindProvider(next) {
  if (provider === next) return;
  if (provider?.removeListener) { provider.removeListener('accountsChanged', accountsChanged); provider.removeListener('chainChanged', chainChanged); }
  provider = next;
  provider?.on?.('accountsChanged', accountsChanged); provider?.on?.('chainChanged', chainChanged);
}
function accountsChanged(accounts) {
  const expected = S.session?.scope.owner || S.wallet;
  if (expected && accounts?.[0]?.toLowerCase() !== expected) { clearPrivate(); notify('Wallet changed. Private content was cleared. Connect again to open the current wallet’s workspace.'); }
}
function chainChanged() { clearPrivate(); notify('Wallet network changed. Private content was cleared. Connect again on the workspace network.'); }
async function walletBinding(wallet, version, expectedChain = S.config.chainId) {
  if (!provider) throw new Error('JEFF_WALLET_UNAVAILABLE');
  const [accounts, chain] = await Promise.all([provider.request({ method: 'eth_accounts' }), provider.request({ method: 'eth_chainId' })]);
  if (version !== S.version) throw new Error('JEFF_REQUEST_SUPERSEDED');
  if (accounts?.[0]?.toLowerCase() !== wallet) throw new Error('JEFF_WALLET_CHANGED');
  if (Number(BigInt(chain)) !== expectedChain) throw new Error('JEFF_WALLET_NETWORK_MISMATCH');
}
function renderConnection() {
  $('#account-mode-option').disabled = !S.config?.standaloneAccounts;
  $('#connect-mode').value = S.mode;
  $('#connect-mode').disabled = S.authBusy;
  put('#connect-heading', S.mode === 'account' ? 'Your wallet workspace.' : 'Your NFT. Your agent.');
  put('#connect-copy', S.mode === 'account' ? 'Sign in to a standalone wallet workspace. Wallet accounts have separate hosting; your Room’s hosting belongs to its Agent NFT workspace.' : 'Connect the wallet holding your Clockers Room. Choose your Room and sign the login message to use its private workspace and hosting.');
  const showPicker = S.mode === 'nft' && S.inventory?.tokenIds.length > 0;
  $('#token-picker').hidden = !showPicker;
  const selector = $('#connect-token'), current = selector.value; selector.replaceChildren();
  if (showPicker) for (const tokenId of S.inventory.tokenIds) { const option = node('option', '', `Clockers Room #${tokenId}`); option.value = tokenId; option.selected = tokenId === current || tokenId === S.session?.scope.tokenId; selector.append(option); }
  selector.disabled = S.authBusy;
  $('#connect-submit').disabled = !S.config || S.authBusy;
  $('#connect-submit').replaceChildren(node('span', '', S.authBusy ? 'Checking your wallet…' : showPicker ? 'Sign in to this Room' : S.mode === 'account' ? 'Sign in with wallet' : 'Connect wallet'), icon('arrow'));
  $('#disconnect-wallet').hidden = !S.session;
}
async function signIn(tokenId, wallet, version) {
  await walletBinding(wallet, version);
  const account = S.mode === 'account';
  const challenge = await api(account ? '/api/account/auth/challenge' : '/api/auth/challenge', { method: 'POST', body: account ? { wallet } : { wallet, tokenId }, authenticated: false });
  if (version !== S.version) return;
  if (typeof challenge.message !== 'string' || challenge.message.length > 8000 || typeof challenge.nonce !== 'string') throw new Error('JEFF_CHALLENGE_EXPIRED');
  put('#connect-status', 'Review the login message in your wallet. No transaction is requested.');
  await walletBinding(wallet, version);
  const encoded = '0x' + [...new TextEncoder().encode(challenge.message)].map(value => value.toString(16).padStart(2, '0')).join('');
  const signature = await provider.request({ method: 'personal_sign', params: [encoded, wallet] });
  if (version !== S.version) return;
  await walletBinding(wallet, version);
  const candidate = await api(account ? '/api/account/auth/verify' : '/api/auth/verify', { method: 'POST', body: { nonce: challenge.nonce, signature }, authenticated: false });
  if (version !== S.version) return;
  if (!validSession(candidate, S.config) || candidate.scope.owner !== wallet
    || (account ? candidate.scope.kind !== 'account' : candidate.scope.kind !== undefined || candidate.scope.tokenId !== tokenId)) throw new Error('JEFF_SCOPE_INVALID');
  S.session = candidate; saveSession(); scheduleExpiry(); $('#connect-dialog').close(); render();
  notify('Signed in. Loading your private workspace.'); await refresh({ quiet: true });
  if (version === S.version && S.workspace) notify(S.session.scope.kind === 'account' && !S.hosting?.active
    ? 'Wallet account opened. Open your Agent NFT to use its hosting.' : 'Your workspace is ready.');
}
async function connect({ preferredToken, discoverOnly = false } = {}) {
  if (S.authBusy || !S.config) return;
  if (S.session) clearPrivate({ preserveInventory: true });
  const version = S.version; S.authBusy = true; renderConnection(); $('#switch-network').hidden = true;
  try {
    bindProvider(window.ethereum);
    if (!provider) throw new Error('JEFF_WALLET_UNAVAILABLE');
    put('#connect-status', 'Connecting to your wallet…');
    let accounts = await provider.request({ method: 'eth_accounts' });
    if (version !== S.version) return;
    if (!accounts?.length) accounts = await provider.request({ method: 'eth_requestAccounts' });
    if (version !== S.version) return;
    const wallet = accounts?.[0]?.toLowerCase(); if (!/^0x[a-f0-9]{40}$/.test(wallet || '')) throw new Error('JEFF_WALLET_UNAVAILABLE');
    if (S.wallet && S.wallet !== wallet) S.inventory = null;
    S.wallet = wallet; await walletBinding(wallet, version);
    if (S.mode === 'account') { await signIn(undefined, wallet, version); return; }
    if (!S.inventory || S.inventory.wallet !== wallet || discoverOnly) {
      put('#connect-status', 'Finding all Rooms held by this wallet…');
      const result = await api('/api/auth/nfts', { method: 'POST', body: { wallet }, authenticated: false });
      const inventory = validateNftDiscovery(result, S.config, wallet);
      if (version !== S.version) return;
      S.inventory = inventory;
    }
    if (!S.inventory.tokenIds.length) { put('#connect-status', 'This wallet holds no Clockers Rooms. Choose another wallet, then try again.'); return; }
    const chosen = preferredToken || (S.inventory.tokenIds.length === 1 ? S.inventory.tokenIds[0] : $('#connect-token').value);
    if (chosen && S.inventory.tokenIds.includes(chosen) && !discoverOnly) await signIn(chosen, wallet, version);
    else { put('#connect-status', `${S.inventory.tokenIds.length} owned Rooms found. Choose one and sign in.`); renderConnection(); $('#connect-token').focus(); }
  } catch (error) {
    if (version !== S.version || error.message === 'JEFF_REQUEST_SUPERSEDED') return;
    put('#connect-status', friendly(error)); notify(friendly(error), true);
    if (error.message === 'JEFF_WALLET_NETWORK_MISMATCH') $('#switch-network').hidden = false;
  } finally { if (version === S.version) { S.authBusy = false; renderConnection(); render(); } }
}
async function newConversation(title) {
  const item = await api('/api/conversations', { method: 'POST', body: title ? { title } : {} });
  if (!JOB_ID.test(item?.id)) throw new Error('JEFF_WORKSPACE_STORAGE_UNAVAILABLE');
  S.conversationId = item.id; return item;
}
async function sendTask(event) {
  event.preventDefault();
  const originalDraft = S.draft, objective = originalDraft.trim();
  if (!objective || objective.length > 4000 || S.busy || allowanceReason()) return;
  const version = S.version, draftVersion = S.draftVersion, scope = S.session.scope;
  const selected = conversation();
  S.submission = { objective, conversationId: S.conversationId, status: 'sending' };
  S.draft = ''; notify('Sending your message…');
  await mutate(async () => {
    try {
      const record = await api('/api/jobs', { method: 'POST', body: { objective, timeZone: browserTimeZone(), ...(selected ? { conversationId: selected.id } : {}) } });
      await validateRecord(record, scope);
      if (version !== S.version) throw new Error('JEFF_REQUEST_SUPERSEDED');
      if (!JOB_ID.test(record.conversationId)) throw new Error('JEFF_RESULT_INVALID');
      S.conversationId = record.conversationId;
      S.submission = null; S.admitted = record; S.jobs = [record, ...S.jobs.filter(job => job.id !== record.id)];
      notifyRun(record.id, 'Run admitted. Its result will appear here.'); render();
    } catch (error) {
      if (version === S.version) {
        if (S.draftVersion === draftVersion) { S.draft = originalDraft; S.submission = null; }
        else S.submission = { objective, conversationId: selected?.id || null, status: 'unconfirmed' };
      }
      throw error;
    }
  });
  $('#chat-feed')?.scrollTo({ top: $('#chat-feed').scrollHeight });
}
async function resolveChatAction(jobId, intent) {
  const action = S.workspace?.jobBindings?.[jobId]?.action;
  if (S.busy || !action || action.status !== 'pending' || S.actionRequests.has(jobId)) return;
  if (intent === 'apply' && action.type === 'schedule.create' && !S.actionConsent.has(jobId)) {
    notify('Review the schedule and check consent before authorizing it.', true); return;
  }
  const version = S.version; let accepted = false;
  await mutate(async () => {
    try {
      await api(`/api/chat/actions/${jobId}/${intent}`, { method: 'POST', body: {} });
      accepted = true; S.actionRequests.set(jobId, 'accepted'); S.actionConsent.delete(jobId);
    } catch (error) {
      if (version === S.version && ['JEFF_WORKSPACE_CONFLICT', 'JEFF_CHAT_ACTION_BUSY'].includes(error.message)) {
        S.actionRequests.set(jobId, 'uncertain'); S.actionConsent.delete(jobId);
        const reconciled = await refresh({ quiet: true });
        if (reconciled && version === S.version) notify(chatActionOutcome(jobId));
        error.refreshHandled = true;
      }
      if (version === S.version && temporaryConnectionError(error)) {
        S.actionRequests.set(jobId, 'uncertain'); S.actionConsent.delete(jobId);
        notify('The action’s saved status could not be confirmed. Use Refresh to check it before trying again.', true);
        error.refreshHandled = true;
      }
      throw error;
    }
  }, intent === 'dismiss' ? 'Suggestion dismissed.' : action.type === 'memory.save' ? 'Memory saved.' : 'Scheduled work authorized.');
  if (version === S.version && accepted && S.actionRequests.has(jobId)) {
    notify('Your request was accepted, but its saved status could not refresh. Use Refresh to check it; do not submit it again.', true);
  }
}
function renderCommands() {
  const query = $('#command-search').value.trim().toLowerCase();
  S.commands = pages.map(([view, label, iconName]) => ({ view, label, iconName }));
  S.commands.push({ action: 'connect', label: S.session ? 'Connect another Agent NFT' : 'Connect wallet', iconName: 'link' }, { action: 'theme', label: 'Switch color theme', iconName: 'moon' });
  if (signedIn()) S.commands.push({ action: 'new-session', label: 'New conversation', iconName: 'plus' });
  const results = $('#command-results'); results.replaceChildren();
  for (const command of S.commands.filter(item => item.label.toLowerCase().includes(query))) {
    const element = button(command.label, command.action || 'command-view', command.iconName, 'command-result', command.view ? { view: command.view } : {}); results.append(element);
  }
  if (!results.children.length) results.append(node('p', 'empty-state', 'No matching pages.'));
}
async function copy(value) {
  try { await navigator.clipboard.writeText(value); toast('Copied.'); }
  catch { notify('Clipboard access is unavailable. Open the run in Activity to download a copy.', true); }
}
function download(value, name) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob), link = node('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function createInvoice() {
  await mutate(async () => {
    const candidate = validateInvoice(await api('/api/hosting/invoice', { method: 'POST' }), S.session.scope);
    S.invoice = candidate; S.decimals = null; S.paymentHash = ''; S.paymentSubmitted = false;
    if (!provider) return;
    const version = S.version;
    try {
      await walletBinding(S.session.scope.owner, version, candidate.chainId);
      const raw = await provider.request({ method: 'eth_call', params: [{ to: candidate.token, data: '0x313ce567' }, 'latest'] });
      if (version !== S.version) return;
      const decimals = Number(BigInt(raw)); if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error('JEFF_TOKEN_DETAILS_UNAVAILABLE');
      S.decimals = decimals;
    } catch (error) {
      if (version !== S.version || error.message === 'JEFF_REQUEST_SUPERSEDED') return;
      notify(`${friendly(error)} The invoice is available; wallet payment remains disabled.`, true);
    }
  });
}
async function payInvoice() {
  if (!S.invoice || S.paymentSubmitted || S.decimals === null || S.busy) return;
  await mutate(async () => {
    const invoice = validateInvoice(S.invoice, S.session.scope), version = S.version;
    await walletBinding(S.session.scope.owner, version, invoice.chainId);
    S.paymentSubmitted = true;
    try {
      const hash = await provider.request({ method: 'eth_sendTransaction', params: [{ from: S.session.scope.owner, to: invoice.token, value: '0x0', data: transferData(invoice) }] });
      if (version !== S.version) return;
      if (!/^0x[a-fA-F0-9]{64}$/.test(hash)) throw new Error('JEFF_PAYMENT_INVALID');
      S.paymentHash = hash; notify('Payment submitted. Keep this reference and verify the same transaction.');
    } catch (error) {
      if (version !== S.version || error.message === 'JEFF_REQUEST_SUPERSEDED') return;
      if (Number(error.code) === 4001) S.paymentSubmitted = false;
      throw error;
    }
  });
}

document.addEventListener('click', async event => {
  const element = event.target.closest('button'); if (!element || element.disabled) return;
  const action = element.dataset.action;
  if (action === 'research-example') {
    if (!signedIn() || S.busy || S.researchDraft.unconfirmed || S.config.webResearch?.enabled !== true) return;
    S.researchDraft = { question: 'Report the latest OpenClaw release tag and publication date from this source. State whether release notes appear in the supplied excerpt, and identify missing or truncated coverage.', urls: 'https://api.github.com/repos/openclaw/openclaw/releases/latest', consent: false, unconfirmed: false };
    render(); $('#research-question')?.focus(); return;
  }
  if (action === 'prepare-research-retry') { S.researchDraft.unconfirmed = false; S.researchDraft.consent = false; render(); return; }
  if (action === 'review-outcomes') {
    if (!signedIn() || element.dataset.scope !== scopeKey(S.session.scope)) return;
    const shown = parseReviewed(element.dataset.ids);
    const next = new Set([...reviewedOutcomes, ...shown].slice(-5000));
    try { localStorage.setItem(reviewedKey(S.session.scope), JSON.stringify([...next])); }
    catch { notify('Review status could not be saved in this browser. Your saved work is unchanged.', true); return; }
    reviewedOutcomes = next; render(); notify('Runs marked reviewed in this browser.'); return;
  }
  if (element.dataset.view && action !== 'command-view') { go(element.dataset.view); return; }
  if (!action) return;
  if (action === 'connect') { openConnection('nft'); return; }
  if (action === 'connect-account') { openConnection('account'); return; }
  if (action === 'command') { openDialog('#command-dialog'); return; }
  if (action === 'close-dialog') { element.closest('dialog')?.close(); return; }
  if (action === 'sidebar') { openSidebar(); return; }
  if (action === 'close-sidebar') { closeSidebar(); return; }
  if (action === 'toggle-inspector') {
    const panel = $('#context-panel'), shell = $('.app-shell'), narrow = matchMedia('(max-width:1080px)').matches;
    const show = narrow ? !panel.classList.contains('open') : shell.classList.contains('inspector-hidden');
    panel.classList.toggle('open', narrow && show); shell.classList.toggle('inspector-hidden', !narrow && !show);
    element.setAttribute('aria-expanded', String(show)); return;
  }
  if (action === 'theme') { setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); return; }
  if (action === 'command-view') { go(element.dataset.view); return; }
  if (action === 'logout') { clearPrivate(); $('#connect-dialog').close(); notify('Signed out. Private content was cleared from this tab.'); return; }
  if (action === 'refresh') { await refresh(); return; }
  if (action === 'discover-agents') { if (openConnection('nft')) await connect({ discoverOnly: true }); return; }
  if (action === 'select-agent') { if (element.dataset.token === S.session?.scope.tokenId) return; if (openConnection('nft')) await connect({ preferredToken: element.dataset.token }); return; }
  if (action === 'switch-network') {
    try { bindProvider(window.ethereum); if (!provider) throw new Error('JEFF_WALLET_UNAVAILABLE'); await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: `0x${S.config.chainId.toString(16)}` }] }); put('#connect-status', 'Network switched. Connect your wallet again.'); }
    catch (error) { put('#connect-status', friendly(error)); } return;
  }
  if (!signedIn()) return;
  if (action === 'apply-chat-action' || action === 'dismiss-chat-action') { await resolveChatAction(element.dataset.id, action === 'apply-chat-action' ? 'apply' : 'dismiss'); return; }
  if (action === 'check-chat-action') {
    if (S.busy) return;
    const version = S.version, jobId = element.dataset.id;
    if (await refresh({ quiet: true }) && version === S.version) notify(chatActionOutcome(jobId));
    return;
  }
  if (action === 'open-chat-action') { if (['memory', 'schedules', 'activity'].includes(element.dataset.target)) go(element.dataset.target); return; }
  if (action === 'new-session') { if (S.busy) return; S.draft = ''; S.draftVersion++; await mutate(() => newConversation(), 'New conversation created.'); go('chat'); return; }
  if (action === 'suggestion') { S.draft = element.dataset.prompt; S.draftVersion++; render(); $('#composer-input')?.focus(); return; }
  if (action === 'reset-settings-draft') { if (S.busy) return; S.settingsDraft = null; render(); notify('Latest saved settings loaded.'); return; }
  if (action === 'keep-settings-draft') {
    if (S.busy || !S.settingsDraft) return;
    S.settingsDraft = { ...S.settingsDraft, revision: S.workspace.revision, savedSettings: settingsSnapshot(S.workspace.settings), conflict: false };
    render(); notify('Your draft is preserved. Review it, then save when ready.'); return;
  }
  if (action === 'pause') { await mutate(() => api('/api/workspace/settings', { method: 'PATCH', body: { revision: S.workspace.revision, paused: !S.workspace.settings.paused } }), S.workspace.settings.paused ? 'Future runs resumed.' : 'Future runs paused. Active work is controlled with Stop.'); return; }
  if (action === 'delete-conversation') {
    if (!conversation() || !confirm('Delete this conversation from the workspace? Saved runs remain in Activity.')) return;
    const selected = conversation(); await mutate(async () => {
      await api(`/api/conversations/${selected.id}`, { method: 'DELETE' });
      if (S.admitted?.conversationId === selected.id) S.admitted = null;
      if (S.submission?.conversationId === selected.id) S.submission = null;
    }, 'Conversation removed.'); return;
  }
  if (action === 'toggle-skill') { const skill = S.workspace.skills.find(item => item.id === element.dataset.id); if (skill) await mutate(() => api('/api/workspace/skills', { method: 'PATCH', body: { id: skill.id, enabled: !skill.enabled } }), 'Prompt recipe saved.'); return; }
  if (action === 'edit-memory') { const memory = S.workspace.memories.find(item => item.id === element.dataset.id); if (memory) { S.memoryDraft = { id: memory.id, title: memory.title, text: memory.text }; render(); $('#memory-title')?.focus(); } return; }
  if (action === 'cancel-memory-edit') { S.memoryDraft = { title: '', text: '' }; render(); return; }
  if (action === 'delete-memory') { if (confirm('Delete this user memory?')) await mutate(async () => { await api(`/api/memory/${element.dataset.id}`, { method: 'DELETE' }); if (S.memoryDraft.id === element.dataset.id) S.memoryDraft = { title: '', text: '' }; }, 'Memory deleted.'); return; }
  if (action === 'claim-free-pass') { await mutate(() => api('/api/hosting/free-pass', { method: 'POST', body: {} }), 'Free hosting month claimed.'); return; }
  if (action === 'create-invoice') { await createInvoice(); return; }
  if (action === 'pay-invoice') { await payInvoice(); return; }
  if (action === 'download-invoice') { if (S.invoice) download({ invoice: S.invoice, transactionHash: S.paymentHash || null }, `jeff-invoice-${S.invoice.id}.json`); return; }
  if (action === 'cancel-schedule') { await mutate(() => api(`/api/schedules/${element.dataset.id}`, { method: 'DELETE' }), 'Schedule cancelled. Future occurrences will not start.'); return; }
  const job = S.jobs.find(item => item.id === element.dataset.id);
  if (action === 'open-job') {
    if (!job) { notify('This run is not available in the current job history. Refresh the workspace.', true); return; }
    openReceipt(job); return;
  }
  if (!job) return;
  if (action === 'copy-result') { await copy(job.text); return; }
  if (action === 'download-result') { download(job, `jeff-${job.id}.json`); return; }
  if (action === 'stop-job') {
    await mutate(async () => {
      const result = await api(`/api/jobs/${job.id}/stop`, { method: 'POST', body: {} });
      notifyRun(job.id, result.stopRequested ? 'Stop requested. Waiting for this run to end.' : 'This run is no longer active. Refreshing its saved status.', result.stopRequested === true);
    }); return;
  }
  if (action === 'retry-save') { await mutate(() => api(`/api/jobs/${job.id}/retry-save`, { method: 'POST' }), 'Save retried without another model run.'); }
});
function openReceipt(job) {
  const dialog = node('dialog', 'receipt-dialog'); dialog.setAttribute('aria-label', 'Saved run receipt');
  const close = button('Close receipt', 'close-dialog', 'close', 'button button-outline'); dialog.append(close, resultMessage(job, true));
  dialog.addEventListener('close', () => dialog.remove(), { once: true }); document.body.append(dialog); dialog.showModal();
}
$('#sidebar-backdrop').addEventListener('click', () => closeSidebar());
$('#connect-form').addEventListener('submit', event => { event.preventDefault(); connect(); });
$('#connect-mode').addEventListener('change', event => {
  if (S.authBusy) return;
  const selectedMode = event.target.value === 'account' ? 'account' : 'nft';
  if (S.session) clearPrivate();
  S.mode = selectedMode; S.inventory = null; put('#connect-status', ''); renderConnection();
});
$('#command-search').addEventListener('input', renderCommands);
document.addEventListener('input', event => {
  const element = event.target;
  if (element.closest('#research-form')) S.researchDraft = { ...S.researchDraft, question: $('#research-question').value, urls: $('#research-urls').value, consent: $('#research-consent').checked };
  if (element.id === 'composer-input') { S.draft = element.value; S.draftVersion++; const send = $('[data-action="send-task"]'); if (send) send.disabled = S.busy || Boolean(allowanceReason()) || !S.draft.trim(); element.style.height = 'auto'; element.style.height = `${Math.min(160, element.scrollHeight)}px`; }
  if (['memory-title', 'memory-text'].includes(element.id)) S.memoryDraft[element.id === 'memory-title' ? 'title' : 'text'] = element.value;
  if (element.id === 'payment-hash') { S.paymentHash = element.value; if (element.value.trim()) S.paymentSubmitted = true; }
  if (element.closest('#settings-form')) S.settingsDraft = { revision: S.settingsDraft?.revision ?? S.workspace.revision,
    savedSettings: S.settingsDraft?.savedSettings || settingsSnapshot(S.workspace.settings), conflict: S.settingsDraft?.conflict === true,
    name: $('#settings-name').value, model: $('#settings-model').value, budget: $('#settings-budget').value, paused: $('#settings-paused').checked };
  if (element.closest('#schedule-form')) S.scheduleDraft = { objective: $('#schedule-objective').value, interval: $('#schedule-interval').value, maxRuns: $('#schedule-max-runs').value, expiry: $('#schedule-expiry').value, consent: $('#schedule-consent').checked };
});
document.addEventListener('change', event => {
  if (event.target.dataset.chatActionConsent) {
    const jobId = event.target.dataset.chatActionConsent;
    event.target.checked ? S.actionConsent.add(jobId) : S.actionConsent.delete(jobId);
    render(); return;
  }
  if (event.target.id === 'conversation-select') { S.conversationId = event.target.value; S.draft = ''; S.draftVersion++; render(); }
  if (event.target.closest('#settings-form') || event.target.closest('#schedule-form')) event.target.dispatchEvent(new Event('input', { bubbles: true }));
});
document.addEventListener('submit', async event => {
  if (event.target.id === 'research-form') {
    event.preventDefault();
    if (!signedIn() || S.busy || allowanceReason() || S.config.webResearch?.enabled !== true || S.researchDraft.unconfirmed) return;
    const draft = { ...S.researchDraft }, urls = draft.urls.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    if (!draft.consent || !draft.question.trim()) return;
    if (urls.length < 1 || urls.length > Math.min(3, S.config.webResearch.maxSources || 3) || urls.some(value => { try { const url = new URL(value); return url.protocol !== 'https:' || Boolean(url.username || url.password); } catch { return true; } })) { notify('Enter 1 to 3 public HTTPS links, one per line, without embedded credentials.', true); return; }
    const version = S.version, scope = S.session.scope, selected = conversation();
    S.researchDraft.consent = false;
    await mutate(async () => {
      try {
        const record = await api('/api/jobs', { method: 'POST', body: { objective: draft.question.trim(), timeZone: browserTimeZone(), research: { urls, consent: true }, ...(selected ? { conversationId: selected.id } : {}) } });
        await validateRecord(record, scope);
        if (version !== S.version) return;
        if (!JOB_ID.test(record.conversationId)) throw new Error('JEFF_RESULT_INVALID');
        S.conversationId = record.conversationId; S.admitted = record; S.jobs = [record, ...S.jobs.filter(job => job.id !== record.id)];
        notifyRun(record.id, 'Source-reading run admitted. Its result will appear here.'); go('chat');
      } catch (error) {
        if (version === S.version && (temporaryConnectionError(error) || error.message === 'JEFF_RESULT_INVALID')) S.researchDraft.unconfirmed = true;
        throw error;
      }
    });
    return;
  }
  if (event.target.id === 'composer-form') { await sendTask(event); return; }
  if (!['memory-form', 'settings-form', 'schedule-form', 'payment-form'].includes(event.target.id)) return;
  event.preventDefault();
  if (!signedIn() || S.busy) return;
  if (event.target.id === 'memory-form') { const draft = { ...S.memoryDraft }; await mutate(async () => { await api('/api/memory', { method: 'POST', body: draft }); S.memoryDraft = { title: '', text: '' }; }, 'Memory saved.'); }
  if (event.target.id === 'settings-form') {
    if (S.settingsDraft?.conflict) return;
    try { const settings = { revision: S.settingsDraft?.revision ?? S.workspace.revision, name: $('#settings-name').value.trim(), model: $('#settings-model').value, dailyBudgetMicros: parseBudget($('#settings-budget').value), paused: $('#settings-paused').checked }; await mutate(async () => {
      try { await api('/api/workspace/settings', { method: 'PATCH', body: settings }); }
      catch (error) {
        if (error.message === 'JEFF_WORKSPACE_CONFLICT' && !await refresh({ quiet: true })) error.refreshHandled = true;
        throw error;
      }
      S.settingsDraft = null;
    }, 'Agent settings saved.'); }
    catch (error) { notify(friendly(error), true); }
  }
  if (event.target.id === 'schedule-form') {
    const draft = S.scheduleDraft || { objective: $('#schedule-objective').value, interval: $('#schedule-interval').value, maxRuns: $('#schedule-max-runs').value, expiry: $('#schedule-expiry').value, consent: $('#schedule-consent').checked };
    if (!draft.consent) return;
    const intervalMinutes = Number(draft.interval), maxRuns = Number(draft.maxRuns), expiry = Number(draft.expiry);
    if (![intervalMinutes, maxRuns, expiry].every(Number.isSafeInteger) || intervalMinutes < 1 || intervalMinutes > 10080 || maxRuns < 1 || maxRuns > 24 || expiry < 1 || expiry > 168 || !draft.objective.trim()) { notify(friendly(new Error('JEFF_SCHEDULE_INVALID')), true); return; }
    await mutate(async () => { const selected = conversation() || await newConversation('Scheduled work'); await api('/api/schedules', { method: 'POST', body: { objective: draft.objective.trim(), conversationId: selected.id, intervalMinutes, maxRuns, expiresAt: new Date(Date.now() + expiry * 3600000).toISOString() } }); S.scheduleDraft = null; }, 'Recurring work authorized. Review or cancel it here.');
  }
  if (event.target.id === 'payment-form') {
    if (!S.invoice || !/^0x[a-fA-F0-9]{64}$/.test(S.paymentHash.trim())) return;
    await mutate(() => api('/api/hosting/activate', { method: 'POST', body: { invoiceId: S.invoice.id, transactionHash: S.paymentHash.trim() } }), 'Payment verified. Hosting details refreshed.');
  }
});
document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); openDialog('#command-dialog'); return; }
  if (event.key === 'Escape') { if ($('#sidebar').classList.contains('open')) { event.preventDefault(); closeSidebar(); } $('#context-panel').classList.remove('open'); return; }
  if (event.target.id === 'composer-input' && event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('#composer-form')?.requestSubmit(); }
  if (event.key === 'Tab' && mobile.matches && $('#sidebar').classList.contains('open')) {
    const items = $$('button:not(:disabled),a[href]', $('#sidebar')).filter(element => !element.hidden && element.offsetParent !== null);
    if (!items.length) return;
    const first = items[0], last = items.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  if (event.target.closest('#command-dialog') && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
    const items = $$('button.command-result', $('#command-results')); if (!items.length) return;
    const current = items.indexOf(document.activeElement); event.preventDefault(); items[(current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
  }
});
window.addEventListener('hashchange', () => { const next = location.hash.slice(1); if (pages.some(([id]) => id === next)) { S.view = next; render(); } });
mobile.addEventListener('change', () => closeSidebar({ restoreFocus: false }));
document.addEventListener('visibilitychange', () => {
  clearTimeout(pollTimer);
  if (document.visibilityState === 'visible' && S.session) refresh({ quiet: true });
});

async function initialize() {
  try { const theme = localStorage.getItem(THEME_KEY); setTheme(['light', 'dark'].includes(theme) ? theme : 'light'); } catch { setTheme('light'); }
  if (pages.some(([id]) => id === location.hash.slice(1))) S.view = location.hash.slice(1);
  render();
  try {
    const config = await api('/api/config', { authenticated: false });
    if (!Number.isSafeInteger(config.chainId) || !/^0x[a-f0-9]{40}$/i.test(config.collection) || !Array.isArray(config.allowedModels) || !config.allowedModels.length || config.allowedModels.some(model => typeof model !== 'string')) throw new Error('JEFF_SERVICE_UNAVAILABLE');
    S.config = config; bindProvider(window.ethereum);
    let cached;
    try { cached = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch {}
    if (validSession(cached, config)) {
      S.session = cached; S.wallet = cached.scope.owner; S.mode = cached.scope.kind === 'account' ? 'account' : 'nft';
      if (provider) { try { await walletBinding(S.wallet, S.version); } catch { clearPrivate(); notify('Connect your current wallet to reopen the private workspace.'); } }
      if (S.session) { scheduleExpiry(); await refresh({ quiet: true }); }
    } else saveSession();
    if(new URL(location.href).searchParams.get('github')==='connection_failed'){
      notify('GitHub authorization could not complete. Refresh the connection and try again when ready. No read was started.',true);
      const cleaned=new URL(location.href);cleaned.searchParams.delete('github');history.replaceState(null,'',cleaned.pathname+cleaned.search+cleaned.hash);
    }
    render(); renderConnection();
  } catch (error) { notify(friendly(error), true); put('#runtime-copy', 'The service could not be reached. Check the connection and reload.'); render(); }
}
initialize();
