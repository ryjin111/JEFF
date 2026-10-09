import { JOB_ID, scopeKey, validSession, validateRecord, validateNftDiscovery, errorLabel } from './client.js';
import { validateHosting, validateInvoice, formatTokenAmount, formatUsdCents, transferData } from './billing.js';

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
  inventory: null, wallet: null, mode: 'nft', view: 'chat', conversationId: null, draft: '', busy: false, authBusy: false,
  memoryDraft: { title: '', text: '' }, settingsDraft: null, scheduleDraft: null, invoice: null, decimals: null,
  paymentHash: '', paymentSubmitted: false, version: 0, notice: '', noticeError: false, runNotice: null, commands: [] };
let provider, pollTimer, expiryTimer, toastTimer, refreshSequence = 0, sidebarReturnFocus;
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
const prepaid = () => S.usage?.enabled === true && ['prepaid', 'prepaid-credits'].includes(S.usage.mode);
const conversation = () => S.workspace?.conversations.find(item => item.id === S.conversationId);
const running = () => S.jobs.some(job => job.status === 'running');
const signedIn = () => Boolean(S.session && S.workspace);
function allowanceReason() {
  if (!S.session) return 'Connect your Agent NFT to start a conversation.';
  if (!S.workspace || !S.hosting) return 'Loading your private workspace…';
  if (!S.config?.modelConfigured) return 'The model connection is unavailable. Saved work remains accessible.';
  if (S.workspace.settings.paused) return 'Future runs are paused. Resume this agent to send a task.';
  if (!S.hosting.active || Date.parse(S.hosting.expiresAt) <= Date.now()) return S.session.scope.kind === 'account'
    ? 'This wallet account has no active hosting. Open your Agent NFT to use its hosting.'
    : 'Activate hosting to run tasks. Your saved work remains accessible.';
  if (!S.hosting.usage || S.hosting.usage.remaining === 0) return 'Your included task allowance is used up. Check Hosting for the next period.';
  if (S.hosting.usage.hourlyRemaining === 0) return 'The hourly task limit was reached. Check Usage for the next available time.';
  if (prepaid() && (!S.usage.balance || S.usage.balance.availableMicros <= 0 || S.usage.balance.paused || S.usage.balance.restoreBlocked)) return 'Inference credits are unavailable. Check Usage & credits before running.';
  if (running()) return 'Your agent is working. You can close this page and return to the saved job.';
  return '';
}
function notify(message, error = false) {
  S.notice = message; S.noticeError = error; S.runNotice = null;
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
    || S.noticeError || S.notice !== tracked.message) return;
  const job = S.jobs.find(item => item.id === tracked.jobId);
  if (!job || job.status === 'running') return;
  if (job.status === 'completed') notify('Run completed and saved.');
  else if (job.status === 'completed_unsaved') notify('Run completed, but its output is not saved. Retry save to keep the existing result.', true);
  else if (job.status === 'failed') notify(tracked.stopRequested
    ? 'The run ended after your stop request. Its saved receipt is marked Failed.'
    : 'Run failed. No completed result was saved. Review its receipt before starting another run.', true);
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
    JEFF_INFERENCE_INSUFFICIENT_CREDITS: 'There are not enough available inference credits for this run.',
    JEFF_INFERENCE_INSUFFICIENT: 'There are not enough available inference credits for this run.',
    JEFF_INFERENCE_BALANCE_INSUFFICIENT: 'There are not enough available inference credits for this run.',
    JEFF_INFERENCE_DAILY_LIMIT: 'This run would exceed the daily inference budget.',
    JEFF_INFERENCE_DAILY_LIMIT_EXCEEDED: 'This run would exceed the daily inference budget.',
    JEFF_SCHEDULE_INVALID: 'Check the task, interval, run count and expiry. Schedules allow at most 24 runs over seven days.',
    JEFF_SCHEDULE_LIMIT: 'The schedule limit was reached. Cancel an unused schedule first.',
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
  for (const controller of pending) controller.abort(); pending.clear();
  S.session = null; S.workspace = null; S.jobs = []; S.hosting = null; S.schedules = []; S.usage = null;
  S.conversationId = null; S.draft = ''; S.memoryDraft = { title: '', text: '' }; S.settingsDraft = null; S.scheduleDraft = null;
  S.invoice = null; S.decimals = null; S.paymentHash = ''; S.paymentSubmitted = false; S.busy = false; S.authBusy = false; S.runNotice = null;
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
async function refresh({ quiet = false } = {}) {
  if (!S.session) return;
  const version = S.version, sequence = ++refreshSequence, scope = S.session.scope;
  try {
    const value = await api('/api/workspace/state');
    const workspace = validateWorkspace(value.workspace, scope);
    if (!Array.isArray(value.jobs) || value.jobs.length > 5000 || !Array.isArray(value.schedules)) throw new Error('JEFF_RESULT_INVALID');
    const jobs = await Promise.all(value.jobs.map(job => validateRecord(job, scope)));
    const hosting = validateHosting(value.hosting, scope);
    const usage = validateUsage(value.usage);
    if (version !== S.version || sequence !== refreshSequence) return;
    S.workspace = workspace; S.jobs = jobs; S.hosting = hosting; S.usage = usage; S.schedules = value.schedules;
    updateRunNotice();
    if (!workspace.conversations.some(item => item.id === S.conversationId)) S.conversationId = workspace.conversations.at(-1)?.id || null;
    render(); schedulePoll();
    if (!quiet) notify('Workspace refreshed.');
    return true;
  } catch (error) { if (error.message !== 'JEFF_REQUEST_SUPERSEDED') { notify(friendly(error), true); render(); } return false; }
}
function schedulePoll() {
  clearTimeout(pollTimer);
  if (!S.session) return;
  const delay = running() ? 2000 : S.schedules.some(item => item.status === 'active') ? 10000 : 30000;
  pollTimer = setTimeout(() => refresh({ quiet: true }), delay);
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
  } catch (error) { if (error.message !== 'JEFF_REQUEST_SUPERSEDED') notify(friendly(error), true); }
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
    const element = button(S.workspace?.settings.name || 'My JEFF', 'connect-account', 'spark', 'agent-item active');
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
  put('#agent-title', settings?.name || 'Your JEFF');
  put('#agent-subtitle', S.session ? account ? 'Wallet account' : `Room #${S.session.scope.tokenId}` : 'Agent NFT workspace');
  const status = $('#agent-status'); status.replaceChildren(node('span', `status-dot${settings?.paused ? ' is-paused' : running() ? ' is-working' : ''}`), document.createTextNode(
    !S.session ? 'Not connected' : !S.workspace ? 'Loading' : settings.paused ? 'Paused' : running() ? 'Working' : allowanceReason() ? 'Limited' : 'Ready'));
  status.classList.toggle('is-paused', Boolean(settings?.paused));
  put('#context-agent-name', settings?.name || 'Your JEFF');
  put('#context-agent-room', S.session ? account ? `Account · ${shortWallet(S.session.scope.owner)}` : `Clockers Room #${S.session.scope.tokenId}` : 'Connect an Agent NFT');
  $('#ownership-mark').hidden = !S.session || account;
  put('#context-owner-note', S.session ? account ? 'Private workspace controlled by your wallet' : `Holder epoch ${S.session.scope.ownerEpoch} · ${shortWallet(S.session.scope.owner)}` : 'Your wallet proves ownership');
  put('#context-model', settings?.model?.replace(/^bankr\//, '') || '—');
  put('#context-last-run', S.jobs.length ? when(S.jobs[0].startedAt) : 'No runs yet');
  put('#context-host', S.config?.continuousHosting ? 'Simple JEFF · cloud' : 'Simple JEFF · local');
  put('#context-engine', S.config?.fixture ? 'Test fixture' : 'OpenClaw');
  put('#runtime-mode', !S.config ? 'CONNECTING' : S.config.fixture ? 'FIXTURE' : S.config.modelConfigured ? 'CONNECTED' : 'UNAVAILABLE');
  put('#runtime-label', S.config?.fixture ? 'DEVELOPMENT FIXTURE' : 'JEFF WORKSPACE');
  put('#runtime-copy', !S.config ? 'Connecting to the OpenClaw runtime…' : S.config.fixture ? 'Explicit test runtime. Responses and funding are fixtures, not live AI or payments.' : !S.config.modelConfigured ? 'Model unavailable. Sign in to manage your agent and reopen saved work.' : S.config.continuousHosting ? 'Hosted by Simple JEFF. Your Agent NFT’s private workspace.' : 'Your local OpenClaw workspace for Agent NFTs.');
  $('#runtime-banner').classList.toggle('fixture-banner', S.config?.fixture === true);
  const pause = $('#pause-agent'); pause.disabled = !signedIn() || S.busy;
  $('span', pause).textContent = settings?.paused ? 'Resume future runs' : 'Pause future runs';
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

function resultMessage(job) {
  const message = node('article', 'message assistant'); message.dataset.jobId = job.id;
  const avatar = node('span', 'message-avatar'); avatar.append(icon('spark'));
  const body = node('div', 'message-body'), heading = node('div', 'message-header');
  heading.append(node('strong', '', S.workspace.settings.name), node('span', 'message-time', when(job.finishedAt || job.startedAt)));
  const states = { running: 'Working', completed: 'Saved', completed_unsaved: 'Not saved yet', failed: 'Failed', interrupted: 'Interrupted' };
  heading.append(pill(states[job.status] || job.status, job.status === 'completed' ? 'success' : ''));
  body.append(heading);
  const card = node('div', 'report-card live-report');
  if (job.status === 'running') {
    card.append(node('div', 'running-indicator', 'OpenClaw is working on your request.'), node('p', 'preview-info', 'Your job is registered on the server. Closing this page does not resubmit or cancel it.'));
    const stop = button('Stop this run', 'stop-job', 'pause', 'button button-outline', { id: job.id }); stop.disabled = S.busy; card.append(stop);
  } else if (job.status === 'completed' || job.status === 'completed_unsaved') {
    card.append(node('div', 'message-text', job.text));
    if (job.status === 'completed_unsaved') {
      card.append(node('p', 'state-notice', 'This output has not been saved. It can be lost if the server restarts. Retry save reuses this output without running the model again.'), button('Retry save', 'retry-save', 'download', 'button button-primary', { id: job.id }));
    }
  } else card.append(node('p', 'message-text', job.status === 'interrupted' ? 'The server restarted before this run finished. JEFF did not automatically run the task again.' : 'This run did not complete. Review the task before deciding whether to submit a new run.'));
  const receipt = node('details', 'work-disclosure receipt-details'); const summary = node('summary'); summary.append(icon('shield'), document.createTextNode('Run receipt'));
  const facts = node('dl', 'receipt-facts');
  for (const [label, value] of [['Job ID', job.id], ['Runtime', job.runtime], ['Model', job.model || 'Not returned'], ['Started', when(job.startedAt)], ['Content hash', job.textSha256 || 'Available after completion']]) {
    const part = node('div'); part.append(node('dt', '', label), node('dd', '', value)); facts.append(part);
  }
  receipt.append(summary, facts, node('p', 'preview-info', 'The content hash checks saved text integrity. It is not a signed proof of provider execution.'));
  card.append(receipt);
  const actions = node('div', 'message-actions');
  if (job.text) actions.append(button('Copy answer', 'copy-result', 'copy', 'text-button', { id: job.id }));
  actions.append(button('Download receipt', 'download-result', 'download', 'text-button', { id: job.id }));
  card.append(actions); body.append(card); message.append(avatar, body); return message;
}
function renderChat() {
  const view = node('section', 'workspace-view chat-view');
  if (!signedIn()) { view.append(empty(S.session ? 'Opening your workspace…' : 'A home for your Agent NFT.', S.session ? 'Checking ownership and loading saved work.' : 'Give your agent useful work. Keep conversations and memories together, and return to the results whenever you need them.', S.session ? null : ['Connect an Agent NFT', 'connect'])); return view; }
  const toolbar = node('div', 'conversation-toolbar');
  const selector = node('select', 'field conversation-select'); selector.id = 'conversation-select'; selector.setAttribute('aria-label', 'Open a saved conversation');
  if (!S.workspace.conversations.length) selector.append(node('option', '', 'Start your first conversation'));
  for (const item of S.workspace.conversations.slice().reverse()) { const option = node('option', '', item.title); option.value = item.id; option.selected = item.id === S.conversationId; selector.append(option); }
  selector.disabled = S.busy || !S.workspace.conversations.length;
  toolbar.append(selector, button('Refresh', 'refresh', 'activity', 'button button-subtle'));
  if (conversation()) { const del = button('Delete conversation', 'delete-conversation', 'close', 'icon-button'); del.replaceChildren(icon('close')); del.setAttribute('aria-label', 'Delete this conversation'); del.disabled = S.busy || running(); toolbar.append(del); }
  view.append(toolbar);
  const feed = node('div', 'chat-feed'); feed.id = 'chat-feed'; feed.setAttribute('aria-live', running() ? 'off' : 'polite');
  const selected = conversation();
  const selectedJobs = selected ? selected.jobIds.map(id => S.jobs.find(job => job.id === id)).filter(Boolean) : [];
  if (!selectedJobs.length) feed.append(empty(selected ? 'What are we working on?' : 'Your first conversation starts here.', 'Bring an idea, a question, or material to work through. JEFF can write, analyze and plan from what you provide.'));
  for (const job of selectedJobs) {
    const user = node('article', 'message user'), body = node('div', 'message-body'), heading = node('div', 'message-header');
    heading.append(node('strong', '', 'You'), node('span', 'message-time', when(job.startedAt))); body.append(heading, node('p', 'user-bubble message-text', job.objective)); user.append(body); feed.append(user, resultMessage(job));
  }
  view.append(feed);
  const composerWrap = node('div', 'composer-wrap');
  const suggestions = node('div', 'prompt-suggestions');
  for (const [title, prompt, iconName] of [['Plan a project', 'Help me plan a project. Ask me about my goal, constraints and deadline.', 'clock'], ['Shape an idea', 'Help me examine an idea. Ask me for the context and compare the main options.', 'spark'], ['Draft an update', 'Help me draft a community update. Ask me for the information and tone to use.', 'book']]) suggestions.append(button(title, 'suggestion', iconName, 'suggestion-chip', { prompt }));
  const form = node('form', 'composer'); form.id = 'composer-form';
  const input = node('textarea'); input.id = 'composer-input'; input.name = 'objective'; input.placeholder = `Give ${S.workspace.settings.name} something to work on…`; input.maxLength = 4000; input.rows = 2; input.required = true; input.value = S.draft;
  const reason = allowanceReason(); input.disabled = Boolean(reason) || S.busy;
  const lower = node('div', 'composer-bottom'), meta = node('div', 'composer-meta'); meta.append(icon('spark'), node('span', '', S.workspace.settings.model.replace(/^bankr\//, '')), pill('PRIVATE WORKSPACE'));
  const send = button('Send task', 'send-task', 'send', 'send-button'); send.type = 'submit'; send.setAttribute('aria-label', 'Send task'); send.disabled = Boolean(reason) || S.busy || !S.draft.trim();
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
    const copy = node('div', 'activity-copy'); copy.append(node('strong', '', job.objective), node('span', 'muted', `${when(job.startedAt)} · ${job.model || 'OpenClaw'} · ${job.id}`));
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
  const view = page('Give your agent direction.', 'Choose the prompt recipes JEFF uses to approach your work. These guide its responses; they do not grant access to websites, shell commands or messaging.', 'SKILLS & TOOLS');
  const grid = node('div', 'skills-grid');
  for (const skill of S.workspace.skills) {
    const card = node('article', 'skill-card'), top = node('div', 'skill-card-top'), glyph = node('span', 'skill-icon'); glyph.append(icon(skill.id === 'writing' ? 'book' : skill.id === 'analysis' ? 'search' : 'clock'));
    const toggle = button(`${skill.enabled ? 'Disable' : 'Enable'} ${skill.name}`, 'toggle-skill', null, 'toggle-switch', { id: skill.id }); toggle.replaceChildren(); toggle.setAttribute('role', 'switch'); toggle.setAttribute('aria-checked', String(skill.enabled)); toggle.setAttribute('aria-label', `${skill.name} prompt recipe`); toggle.disabled = S.busy;
    top.append(glyph, toggle); card.append(top, node('span', 'eyebrow', 'PROMPT RECIPE'), node('h2', '', skill.name), node('p', '', skill.description), pill(skill.enabled ? 'Enabled' : 'Disabled')); grid.append(card);
  }
  view.append(grid, node('p', 'state-notice tools-notice', 'External tools, shell execution, wallet spending and outbound messages are disabled in this hosted release. Turning on a recipe does not grant these capabilities.'));
  return view;
}
function renderMemory() {
  const view = page('A little context goes a long way.', 'Save the information you want this agent to remember. Memories are explicit user notes, included as untrusted context in future runs for this holder workspace.', 'MEMORY');
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
  const text = field('What should JEFF remember?', 'memory-text', { type: 'textarea', value: S.memoryDraft.text, maxLength: 4000, rows: 5 });
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
  const name = field('Agent name', 'settings-name', { value: settings.name, maxLength: 80 });
  const modelWrap = node('div', 'form-field'); const label = node('label', 'field-label', 'Model'); label.htmlFor = 'settings-model';
  const select = node('select', 'field'); select.id = 'settings-model'; select.name = 'settings-model';
  for (const model of S.config.allowedModels) { const option = node('option', '', model.replace(/^bankr\//, '')); option.value = model; option.selected = model === settings.model; select.append(option); }
  modelWrap.append(label, select);
  const budget = field('Daily inference budget (USD)', 'settings-budget', { value: settings.budget, maxLength: 14 }); budget.input.inputMode = 'decimal';
  form.append(name.wrap, modelWrap, budget.wrap, node('p', 'preview-info', prepaid() ? 'Prepaid inference admission enforces this agent’s rolling 24-hour usage limit. Amounts use exact microdollar units.' : 'Saved for prepaid mode. Current operator-funded task allowances do not enforce a dollar cap on provider billing.'));
  const paused = node('label', 'checkbox-row'); const checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.id = 'settings-paused'; checkbox.checked = settings.paused; paused.append(checkbox, node('span', '', 'Pause future manual and scheduled runs')); form.append(paused);
  const save = button('Save settings', 'save-settings', 'check', 'button button-primary'); save.type = 'submit'; save.disabled = S.busy; form.append(save);
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
  if (S.busy) $$('form input, form textarea, form select', content).forEach(element => { element.disabled = true; });
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
    if (error.message !== 'JEFF_REQUEST_SUPERSEDED') {
      put('#connect-status', friendly(error)); notify(friendly(error), true);
      if (error.message === 'JEFF_WALLET_NETWORK_MISMATCH') $('#switch-network').hidden = false;
    }
  } finally { if (version === S.version) { S.authBusy = false; renderConnection(); render(); } }
}
async function newConversation(title) {
  const item = await api('/api/conversations', { method: 'POST', body: title ? { title } : {} });
  if (!JOB_ID.test(item?.id)) throw new Error('JEFF_WORKSPACE_STORAGE_UNAVAILABLE');
  S.conversationId = item.id; return item;
}
async function sendTask(event) {
  event.preventDefault();
  const objective = S.draft.trim();
  if (!objective || objective.length > 4000 || S.busy || allowanceReason()) return;
  await mutate(async () => {
    const selected = conversation() || await newConversation(objective.slice(0, 80));
    const record = await api('/api/jobs', { method: 'POST', body: { objective, conversationId: selected.id } });
    await validateRecord(record, S.session.scope);
    S.draft = ''; S.jobs = [record, ...S.jobs.filter(job => job.id !== record.id)];
    notifyRun(record.id, 'Run admitted. Its result will appear here.');
  });
  $('#chat-feed')?.scrollTo({ top: $('#chat-feed').scrollHeight });
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
  catch { notify('Clipboard access is unavailable. Download the receipt to keep a copy.', true); }
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
    } catch (error) { notify(`${friendly(error)} The invoice is available; wallet payment remains disabled.`, true); }
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
    } catch (error) { if (Number(error.code) === 4001) S.paymentSubmitted = false; throw error; }
  });
}

document.addEventListener('click', async event => {
  const element = event.target.closest('button'); if (!element || element.disabled) return;
  const action = element.dataset.action;
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
  if (action === 'new-session') { S.draft = ''; await mutate(() => newConversation(), 'New conversation created.'); go('chat'); return; }
  if (action === 'suggestion') { S.draft = element.dataset.prompt; render(); $('#composer-input')?.focus(); return; }
  if (action === 'pause') { await mutate(() => api('/api/workspace/settings', { method: 'PATCH', body: { revision: S.workspace.revision, paused: !S.workspace.settings.paused } }), S.workspace.settings.paused ? 'Future runs resumed.' : 'Future runs paused. Active work is controlled with Stop.'); return; }
  if (action === 'delete-conversation') {
    if (!conversation() || !confirm('Delete this conversation from the workspace? Saved job receipts remain in Activity.')) return;
    const selected = conversation(); await mutate(() => api(`/api/conversations/${selected.id}`, { method: 'DELETE' }), 'Conversation removed.'); return;
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
    const selected = S.workspace.conversations.find(item => item.jobIds.includes(job.id));
    if (selected) { S.conversationId = selected.id; go('chat'); $(`[data-job-id="${job.id}"]`)?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion:reduce)').matches ? 'auto' : 'smooth', block: 'start' }); }
    else { openReceipt(job); } return;
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
  const close = button('Close receipt', 'close-dialog', 'close', 'button button-outline'); dialog.append(close, resultMessage(job));
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
  if (element.id === 'composer-input') { S.draft = element.value; const send = $('[data-action="send-task"]'); if (send) send.disabled = S.busy || Boolean(allowanceReason()) || !S.draft.trim(); element.style.height = 'auto'; element.style.height = `${Math.min(160, element.scrollHeight)}px`; }
  if (['memory-title', 'memory-text'].includes(element.id)) S.memoryDraft[element.id === 'memory-title' ? 'title' : 'text'] = element.value;
  if (element.id === 'payment-hash') { S.paymentHash = element.value; if (element.value.trim()) S.paymentSubmitted = true; }
  if (element.closest('#settings-form')) S.settingsDraft = { revision: S.settingsDraft?.revision ?? S.workspace.revision, name: $('#settings-name').value, model: $('#settings-model').value, budget: $('#settings-budget').value, paused: $('#settings-paused').checked };
  if (element.closest('#schedule-form')) S.scheduleDraft = { objective: $('#schedule-objective').value, interval: $('#schedule-interval').value, maxRuns: $('#schedule-max-runs').value, expiry: $('#schedule-expiry').value, consent: $('#schedule-consent').checked };
});
document.addEventListener('change', event => {
  if (event.target.id === 'conversation-select') { S.conversationId = event.target.value; S.draft = ''; render(); }
  if (event.target.closest('#settings-form') || event.target.closest('#schedule-form')) event.target.dispatchEvent(new Event('input', { bubbles: true }));
});
document.addEventListener('submit', async event => {
  if (event.target.id === 'composer-form') { await sendTask(event); return; }
  if (!['memory-form', 'settings-form', 'schedule-form', 'payment-form'].includes(event.target.id)) return;
  event.preventDefault();
  if (!signedIn() || S.busy) return;
  if (event.target.id === 'memory-form') { const draft = { ...S.memoryDraft }; await mutate(async () => { await api('/api/memory', { method: 'POST', body: draft }); S.memoryDraft = { title: '', text: '' }; }, 'Memory saved.'); }
  if (event.target.id === 'settings-form') {
    try { const settings = { revision: S.settingsDraft?.revision ?? S.workspace.revision, name: $('#settings-name').value.trim(), model: $('#settings-model').value, dailyBudgetMicros: parseBudget($('#settings-budget').value), paused: $('#settings-paused').checked }; await mutate(async () => { await api('/api/workspace/settings', { method: 'PATCH', body: settings }); S.settingsDraft = null; }, 'Agent settings saved.'); }
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
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.session) refresh({ quiet: true }); });

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
    render(); renderConnection();
  } catch (error) { notify(friendly(error), true); put('#runtime-copy', 'The service could not be reached. Check the connection and reload.'); render(); }
}
initialize();
