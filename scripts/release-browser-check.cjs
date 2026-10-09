const { chromium } = require('playwright-core');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const base = process.env.JEFF_QA_ORIGIN || 'http://127.0.0.1:8421';
const output = path.resolve(__dirname, '..', 'evidence', 'release');
const report = { origin: base, fixture: true, checks: [], screenshots: [], pageErrors: [], consoleErrors: [], externalRequests: [], injectedFailures: [], failures: [] };
const expectedHttpErrors = new WeakMap();
let browser;
const checked = name => { report.checks.push(name); process.stdout.write(`PASS ${name}\n`); };
async function bounded(promise, label, milliseconds = 10000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
async function capture(page, name) {
  const file = `${name}.png`; await page.screenshot({ path: path.join(output, file), fullPage: true }); report.screenshots.push(file);
}
async function api(page, endpoint, method = 'GET', input) {
  return page.evaluate(async ({ endpoint, method, input }) => {
    const session = JSON.parse(sessionStorage.getItem('jeff:workspace:session:v1'));
    const response = await fetch(endpoint, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` },
      body: input === undefined ? undefined : JSON.stringify(input) });
    return { status: response.status, value: await response.json() };
  }, { endpoint, method, input });
}
async function fixtureUnavailable(page, route, phase) {
  const failure = { path: new URL(route.request().url()).pathname, status: 503, phase, consoleObserved: false };
  report.injectedFailures.push(failure); expectedHttpErrors.get(page).push(failure);
  await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'JEFF_SERVICE_UNAVAILABLE' }) });
}
async function formattedReply(page, job, viewport) {
  const reply = page.locator(`.message.assistant[data-job-id="${job.id}"] .message-markdown`).first();
  await reply.waitFor();
  assert.deepEqual(await reply.locator('h1').allTextContents(), ['Local verification result']);
  assert.deepEqual(await reply.locator('h2').allTextContents(), ['Launch checklist']);
  assert.equal(await reply.locator('strong').filter({ hasText: 'Room #35' }).count(), 1);
  assert.ok(await reply.locator('ul > li').count() >= 3);
  assert.ok(await reply.locator('ul li ul li').count() >= 1);
  assert.deepEqual(await reply.locator('ol > li').allTextContents(), ['Connect your wallet', 'Open your Agent NFT']);
  assert.equal(await reply.locator('code').filter({ hasText: /^roomId$/ }).count(), 1);
  assert.equal((await reply.locator('pre > code').textContent()).trim(), 'const room = 35;');
  assert.match(await reply.locator('blockquote').textContent(), /Check saved work before sending another task/);
  assert.deepEqual(await reply.locator('th').allTextContents(), ['Check', 'Status']);
  assert.deepEqual(await reply.locator('td').allTextContents(), ['Ownership', 'Verified', 'Reply', 'Saved']);
  const safeLink = reply.getByRole('link', { name: 'Safe HTTPS link', exact: true });
  assert.equal(await safeLink.getAttribute('href'), 'https://example.com/jeff-docs');
  assert.equal(await safeLink.getAttribute('target'), '_blank');
  const rel = (await safeLink.getAttribute('rel')).split(/\s+/);
  assert.ok(rel.includes('noopener') && rel.includes('noreferrer'));
  assert.equal(await safeLink.getAttribute('referrerpolicy'), 'no-referrer');
  assert.equal(await reply.getByRole('link', { name: 'unsafe link', exact: true }).count(), 0);
  assert.equal(await reply.locator('img,script,iframe,object,embed,svg,style,link').count(), 0);
  const security = await reply.evaluate(element => ({
    unsafeAttributes: [...element.querySelectorAll('*')].flatMap(child => [...child.attributes].filter(attribute => /^on/i.test(attribute.name)).map(attribute => attribute.name)),
    unsafeLinks: [...element.querySelectorAll('a')].filter(link => !['http:', 'https:'].includes(new URL(link.href).protocol)).map(link => link.href),
    imageAltPresent: element.textContent.includes('Tracking image'),
    literalScriptPresent: element.textContent.includes('<script>window.qaReplyInjected=true</script>'),
    literalImagePresent: element.textContent.includes('<img src=x onerror=window.qaReplyInjected=true>'),
  }));
  assert.deepEqual(security.unsafeAttributes, []); assert.deepEqual(security.unsafeLinks, []);
  assert.equal(security.imageAltPresent, true); assert.equal(security.literalScriptPresent, true); assert.equal(security.literalImagePresent, true);
  assert.equal(await page.evaluate(() => window.qaInjected || window.qaReplyInjected), undefined);
  const layout = await reply.evaluate(element => {
    const paragraph = element.querySelector('p'), heading = element.querySelector('h1'), table = element.querySelector('.markdown-table');
    const bodyStyle = getComputedStyle(paragraph), headingStyle = getComputedStyle(heading);
    return { pageWidth: document.documentElement.scrollWidth, viewport: innerWidth, replyWidth: element.clientWidth,
      replyScrollWidth: element.scrollWidth, bodyFont: parseFloat(bodyStyle.fontSize), lineHeight: parseFloat(bodyStyle.lineHeight),
      headingFont: parseFloat(headingStyle.fontSize), whiteSpace: getComputedStyle(element).whiteSpace,
      tableOverflow: table && getComputedStyle(table).overflowX };
  });
  assert.ok(layout.pageWidth <= layout.viewport, JSON.stringify(layout));
  assert.ok(layout.replyScrollWidth <= layout.replyWidth + 1, JSON.stringify(layout));
  assert.ok(layout.bodyFont >= 12 && layout.lineHeight / layout.bodyFont >= 1.45, JSON.stringify(layout));
  assert.ok(layout.headingFont > layout.bodyFont, JSON.stringify(layout));
  assert.equal(layout.whiteSpace, 'normal'); assert.equal(layout.tableOverflow, 'auto');
  report.replyFormatting ||= {}; report.replyFormatting[viewport] = { semanticMarkdown: true, unsafeHtmlLiteral: true,
    remoteImagesSuppressed: true, unsafeLinksSuppressed: true, safeLinkProtected: true, layout };
  return reply;
}
async function nav(page, view) {
  if (await page.locator('[data-action="sidebar"]').isVisible() && !await page.locator('#sidebar').evaluate(e => e.classList.contains('open'))) await page.locator('[data-action="sidebar"]').click();
  await page.locator(`#sidebar [data-view="${view}"]`).click();
  await page.waitForFunction(view => document.querySelector(`#sidebar [data-view="${view}"]`)?.getAttribute('aria-current') === 'page', view);
}
async function ready(page) {
  await page.locator('#composer-input').waitFor();
  await page.waitForFunction(() => !document.querySelector('#composer-input')?.disabled);
}
async function refresh(page) {
  if (await page.locator('[data-action="refresh"]').count()) await page.locator('[data-action="refresh"]').first().click();
  else { await nav(page, 'chat'); await page.locator('[data-action="refresh"]').click(); }
  await page.waitForTimeout(100);
}
async function sidebarAction(page, selector, keyboard = false) {
  if (await page.locator('[data-action="sidebar"]').isVisible() && !await page.locator('#sidebar').evaluate(e => e.classList.contains('open'))) await page.locator('[data-action="sidebar"]').click();
  const target = page.locator(`#sidebar ${selector}`).first();
  if (keyboard) { await target.focus(); await page.keyboard.press('Enter'); }
  else await target.click();
}
async function signatureMessages(page) {
  return (await page.evaluate(() => window.__qaWallet.signatures.map(item => item.message))).map(message => Buffer.from(message.slice(2), 'hex').toString('utf8'));
}
async function signStandalone(page) {
  assert.equal(await page.locator('#account-mode-option').isDisabled(), false);
  await page.locator('#connect-mode').selectOption('account');
  await page.locator('#connect-submit').click();
  await page.waitForFunction(() => !document.getElementById('connect-dialog').open);
  await nav(page, 'chat');
  await page.locator('#composer-input').waitFor();
  assert.equal((await api(page, '/api/workspace')).value.scope.kind, 'account');
}
async function signPickedRoom(page, tokenId = '35') {
  assert.equal(await page.locator('#connect-mode').inputValue(), 'nft');
  await page.locator('#token-picker').waitFor({ state: 'visible' });
  await page.locator('#connect-token').selectOption(tokenId);
  await page.locator('#connect-submit').click();
  await page.waitForFunction(() => !document.getElementById('connect-dialog').open);
  await nav(page, 'chat');
  await ready(page);
  const workspace = (await api(page, '/api/workspace')).value;
  assert.equal(workspace.scope.kind, undefined);
  assert.equal(workspace.scope.tokenId, tokenId);
  assert.equal((await api(page, '/api/hosting')).value.active, true);
}
async function connect(page, tokenId = '35') {
  if (!await page.locator('#connect-dialog').evaluate(e => e.open)) {
    const center = page.locator('#workspace-content [data-action="connect"]').first();
    if (await center.count() && await center.isVisible()) await center.click();
    else if (await page.locator('#runtime-banner [data-action="connect"]').isVisible()) await page.locator('#runtime-banner [data-action="connect"]').click();
    else { await page.locator('[data-action="sidebar"]').click(); await page.locator('#sidebar [data-action="connect"]').first().click(); }
  }
  await page.locator('#connect-submit').click();
  await page.locator('#token-picker').waitFor({ state: 'visible' });
  assert.deepEqual(await page.locator('#connect-token option').evaluateAll(nodes => nodes.map(n => n.value)), ['35', '128', '207']);
  await page.locator('#connect-token').selectOption(tokenId);
  await page.locator('#connect-submit').click();
  await page.waitForFunction(() => !document.getElementById('connect-dialog').open);
  await page.locator('#composer-input').waitFor();
}
async function switchNft(page, tokenId) {
  await nav(page, 'chat');
  const choice = page.locator(`[data-action="select-agent"][data-token="${tokenId}"]`);
  if (await choice.count()) await choice.click();
  else {
    await page.locator('[data-action="discover-agents"]').click();
    await page.locator('#token-picker').waitFor({ state: 'visible' });
    await page.locator('#connect-token').selectOption(tokenId); await page.locator('#connect-submit').click();
  }
  await page.waitForFunction(() => !document.getElementById('connect-dialog').open);
  await page.locator('#composer-input').waitFor();
}
async function newContext(viewport, cachedSession, configure) {
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce', deviceScaleFactor: 1, acceptDownloads: true });
  if (cachedSession) await context.addInitScript(session => sessionStorage.setItem('jeff:workspace:session:v1', JSON.stringify(session)), cachedSession);
  await context.addInitScript(() => {
    const listeners = {}, signatures = [];
    let wallet;
    window.__qaWallet = { listeners, signatures, accounts: null, chain: null,
      emit(event, value) { for (const handler of listeners[event] || []) handler(value); } };
    Object.defineProperty(window, 'ethereum', { configurable: true, get: () => wallet, set(value) {
      wallet = value;
      const request = wallet.request.bind(wallet), on = wallet.on?.bind(wallet), remove = wallet.removeListener?.bind(wallet);
      wallet.request = async parameters => {
        if (['eth_accounts', 'eth_requestAccounts'].includes(parameters.method) && window.__qaWallet.accounts) return window.__qaWallet.accounts;
        if (parameters.method === 'eth_chainId' && window.__qaWallet.chain) return window.__qaWallet.chain;
        if (parameters.method === 'personal_sign') signatures.push({ message: parameters.params[0] });
        return request(parameters);
      };
      wallet.on = (event, handler) => { (listeners[event] ||= []).push(handler); return on?.(event, handler); };
      wallet.removeListener = (event, handler) => { listeners[event] = (listeners[event] || []).filter(fn => fn !== handler); return remove?.(event, handler); };
    } });
  });
  const page = await context.newPage();
  expectedHttpErrors.set(page, []);
  page.on('pageerror', error => report.pageErrors.push(error.message));
  page.on('console', message => {
    if (message.type() !== 'error' || /^Failed to load resource: the server responded with a status of (401|409)/.test(message.text())) return;
    const expected = expectedHttpErrors.get(page).find(item => !item.consoleObserved && message.location().url === new URL(item.path, base).href
      && /^Failed to load resource: the server responded with a status of 503/.test(message.text()));
    if (expected) expected.consoleObserved = true;
    else report.consoleErrors.push(message.text());
  });
  page.on('dialog', dialog => dialog.accept());
  await page.route('**/*', route => {
    const url = route.request().url();
    if (/^https?:/.test(url) && new URL(url).origin !== base) { report.externalRequests.push(url); return route.abort(); }
    return route.continue();
  });
  if (configure) await configure(page);
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.locator('#runtime-label').filter({ hasText: 'DEVELOPMENT FIXTURE' }).waitFor();
  return { context, page };
}

async function settingsConcurrency(page, memoryTitle) {
  const cached = await page.evaluate(() => JSON.parse(sessionStorage.getItem('jeff:workspace:session:v1')));
  const second = await newContext({ width: 1440, height: 1000 }, cached);
  const other = second.page;
  const original = (await api(page, '/api/workspace')).value.settings;
  const patches = [];
  const observe = request => { if (request.method() === 'PATCH' && new URL(request.url()).pathname === '/api/workspace/settings') patches.push(request.postDataJSON()); };
  page.on('request', observe);
  async function reloadState(target) {
    await nav(target, 'activity');
    const response = target.waitForResponse(item => new URL(item.url()).pathname === '/api/workspace/state' && item.request().method() === 'GET');
    await target.locator('[data-action="refresh"]').click(); await response;
    await target.waitForFunction(() => document.querySelector('#workspace-notice').textContent === 'Workspace refreshed.');
    await nav(target, 'settings');
  }
  async function save(target, status = 200) {
    const response = target.waitForResponse(item => new URL(item.url()).pathname === '/api/workspace/settings' && item.request().method() === 'PATCH');
    await target.locator('#settings-form button[type="submit"]').click();
    assert.equal((await response).status(), status);
    await target.waitForFunction(() => !document.querySelector('#settings-name').disabled);
  }
  try {
    await nav(page, 'settings');
    await page.locator('#settings-name').fill('Draft after an unrelated update');
    await nav(other, 'memory');
    const memory = other.locator('.memory-card').filter({ hasText: memoryTitle });
    await memory.locator('[data-action="edit-memory"]').click();
    await other.locator('#memory-text').fill('This account memory was edited in another tab.');
    await other.locator('#memory-form button[type="submit"]').click();
    await memory.getByText('This account memory was edited in another tab.', { exact: true }).waitFor();
    await reloadState(page);
    assert.equal(await page.locator('#settings-name').inputValue(), 'Draft after an unrelated update');
    assert.equal(await page.locator('.settings-conflict').count(), 0);
    await save(page);
    assert.equal((await api(page, '/api/workspace')).value.settings.name, 'Draft after an unrelated update');
    checked('Unrelated memory updates rebase the settings revision and preserve the unsaved draft');

    await page.locator('#settings-name').fill('My preserved draft');
    await page.locator('#settings-budget').fill('0.000007');
    await reloadState(other);
    await other.locator('#settings-name').fill('Saved in another tab');
    await other.locator('#settings-budget').fill('0.000009'); await save(other);
    let conflictGetFailures = 0;
    const conflictRoute = async route => {
      if (!conflictGetFailures++) await fixtureUnavailable(page, route, 'settings-conflict-refresh');
      else await route.continue();
    };
    await page.route('**/api/workspace/state', conflictRoute);
    await save(page, 409);
    assert.match(await page.locator('#workspace-notice').textContent(), /Reconnecting to check saved work/);
    assert.equal(await page.locator('#settings-name').inputValue(), 'My preserved draft');
    await page.locator('.settings-conflict').waitFor();
    await page.waitForFunction(() => document.querySelector('#workspace-notice').textContent === 'Connection restored. Saved work is up to date.');
    await page.unroute('**/api/workspace/state', conflictRoute);
    assert.equal(conflictGetFailures, 2);
    assert.equal(await page.locator('#settings-name').inputValue(), 'My preserved draft');
    assert.equal(await page.locator('#settings-budget').inputValue(), '0.000007');
    assert.match(await page.locator('.settings-conflict').textContent(), /Saved in another tab/);
    assert.match(await page.locator('.settings-conflict').textContent(), /\$0\.000009/);
    assert.equal(await page.locator('#settings-form button[type="submit"]').isDisabled(), true);
    assert.equal((await api(page, '/api/workspace')).value.settings.name, 'Saved in another tab');
    const beforeChoice = patches.length;
    await page.locator('[data-action="keep-settings-draft"]').click();
    assert.equal(patches.length, beforeChoice, 'Choosing a draft must not automatically save it');
    assert.equal(await page.locator('#settings-name').inputValue(), 'My preserved draft');
    assert.equal(await page.locator('#settings-form button[type="submit"]').isDisabled(), false);
    await save(page);
    const kept = (await api(page, '/api/workspace')).value.settings;
    assert.equal(kept.name, 'My preserved draft'); assert.equal(kept.dailyBudgetMicros, 7);
    checked('Conflicting settings preserve both versions and require explicit review before a new save');

    await page.locator('#settings-name').fill('A draft to discard');
    await reloadState(other);
    await other.locator('#settings-name').fill('Use this saved version'); await save(other);
    await reloadState(page); await page.locator('.settings-conflict').waitFor();
    const beforeReset = patches.length;
    await page.locator('[data-action="reset-settings-draft"]').click();
    assert.equal(patches.length, beforeReset);
    assert.equal(await page.locator('#settings-name').inputValue(), 'Use this saved version');
    assert.equal(await page.locator('#settings-budget').inputValue(), '0.000007');
    assert.equal(await page.locator('.settings-conflict').count(), 0);
    assert.equal((await api(page, '/api/workspace')).value.settings.name, 'Use this saved version');
    checked('Using saved settings discards only the local draft without an extra mutation');
    await page.locator('#settings-name').fill(original.name);
    await page.locator('#settings-model').selectOption(original.model);
    await page.locator('#settings-budget').fill(String(original.dailyBudgetMicros / 1000000));
    await page.locator('#settings-paused').setChecked(original.paused); await save(page);
    report.settingsConcurrency = { unrelatedRevisionRebased: true, conflictingDraftPreserved: true, latestValuesShown: true, conflictGetFailureRecovered: true,
      explicitKeepRequiresSave: true, resetDoesNotMutate: true, authSignaturesAdded: (await signatureMessages(other)).length };
    assert.equal(report.settingsConcurrency.authSignaturesAdded, 0);
  } finally { page.off('request', observe); await second.context.close(); }
}

async function walletCallbackIsolation() {
  let invoiceIndex = 0;
  const paymentHash = '0x' + 'aa'.repeat(32);
  const isolated = await newContext({ width: 1440, height: 1000 }, undefined, async page => {
    // Checkout is disabled in the fixture service. These page-local invoices and
    // wallet promises exercise UI isolation without sending any chain request.
    await page.route('**/api/config', async route => {
      const value = await (await route.fetch()).json(); value.billingEnabled = true; await route.fulfill({ json: value });
    });
    await page.route('**/api/workspace/state', async route => {
      const value = await (await route.fetch()).json();
      Object.assign(value.hosting, { checkoutEnabled: true, recipient: '0x' + '55'.repeat(20), amount: null });
      await route.fulfill({ json: value });
    });
    await page.route('**/api/hosting/invoice', async route => {
      const session = await page.evaluate(() => JSON.parse(sessionStorage.getItem('jeff:workspace:session:v1')));
      await route.fulfill({ json: { id: (++invoiceIndex).toString(16).padStart(8, '0') + '-1234-1234-1234-123456789abc',
        scope: session.scope, chainId: session.scope.chainId, token: '0x' + '44'.repeat(20), recipient: '0x' + '55'.repeat(20),
        amount: '1000000000000000000', periodDays: 30, tasksIncluded: 100,
        issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 900000).toISOString() } });
    });
  });
  const page = isolated.page, requests = [];
  page.on('request', request => requests.push({ method: request.method(), path: new URL(request.url()).pathname }));
  async function signAccount() {
    await nav(page, 'chat'); await page.locator('#workspace-content [data-action="connect"]').click(); await signStandalone(page);
  }
  async function logout() {
    await nav(page, 'settings'); await page.locator('#workspace-content [data-action="logout"]').click();
    assert.equal(await page.evaluate(() => sessionStorage.getItem('jeff:workspace:session:v1')), null);
  }
  async function createInvoice() {
    await nav(page, 'hosting'); await page.locator('[data-action="create-invoice"]').click();
    await page.waitForFunction(() => !document.querySelector('[data-action="pay-invoice"]')?.disabled);
  }
  try {
    await signAccount();
    await page.evaluate(({ paymentHash }) => {
      const original = ethereum.request.bind(ethereum);
      const prompts = window.__qaWalletPrompts = { transactions: [], holdDecimals: true, holdPayment: false, holdSignature: false };
      const hold = key => new Promise((resolve, reject) => { prompts[key] = () => reject(Object.assign(new Error('Fixture wallet request rejected'), { code: 4001 })); });
      ethereum.request = parameters => {
        if (parameters.method === 'eth_call') {
          if (prompts.holdDecimals) { prompts.holdDecimals = false; return hold('rejectDecimals'); }
          return Promise.resolve('0x12');
        }
        if (parameters.method === 'eth_sendTransaction') {
          prompts.transactions.push(parameters.params[0]);
          if (prompts.holdPayment) { prompts.holdPayment = false; return hold('rejectPayment'); }
          return Promise.resolve(paymentHash);
        }
        if (parameters.method === 'personal_sign' && prompts.holdSignature) { prompts.holdSignature = false; return hold('rejectSignature'); }
        return original(parameters);
      };
    }, { paymentHash });
    await nav(page, 'hosting'); await page.locator('[data-action="create-invoice"]').click();
    await page.waitForFunction(() => typeof window.__qaWalletPrompts.rejectDecimals === 'function');
    await logout();
    const logoutNotice = await page.locator('#workspace-notice').textContent();
    const beforeLateDecimals = requests.filter(item => item.path === '/api/workspace/state').length;
    await page.evaluate(() => window.__qaWalletPrompts.rejectDecimals()); await page.waitForTimeout(100);
    assert.equal(await page.locator('#workspace-notice').textContent(), logoutNotice);
    assert.equal(await page.locator('[data-action="pay-invoice"]').count(), 0);
    assert.equal(requests.filter(item => item.path === '/api/workspace/state').length, beforeLateDecimals);
    checked('A rejected invoice wallet read after sign-out cannot restore old invoice notices or private state');

    await signAccount(); await createInvoice();
    await page.evaluate(() => { window.__qaWalletPrompts.holdPayment = true; });
    await page.locator('[data-action="pay-invoice"]').click();
    await page.waitForFunction(() => typeof window.__qaWalletPrompts.rejectPayment === 'function');
    await logout(); await nav(page, 'chat'); await connect(page, '207'); await ready(page); await createInvoice();
    await page.locator('[data-action="pay-invoice"]').click();
    await page.waitForFunction(hash => document.querySelector('#payment-hash')?.value === hash && !document.querySelector('#payment-hash').disabled, paymentHash);
    assert.equal(await page.locator('[data-action="pay-invoice"]').isDisabled(), true);
    await page.evaluate(() => window.__qaWalletPrompts.rejectPayment()); await page.waitForTimeout(100);
    const refreshed = page.waitForResponse(item => new URL(item.url()).pathname === '/api/workspace/state');
    await page.locator('[data-action="refresh"]').click(); await refreshed;
    await page.waitForFunction(() => document.querySelector('#workspace-notice').textContent === 'Workspace refreshed.');
    assert.equal(await page.locator('[data-action="pay-invoice"]').isDisabled(), true);
    assert.equal(await page.locator('[data-action="create-invoice"]').isDisabled(), true);
    assert.equal(await page.locator('#payment-hash').inputValue(), paymentHash);
    await page.locator('[data-action="pay-invoice"]').evaluate(element => element.click());
    const transactions = await page.evaluate(() => window.__qaWalletPrompts.transactions);
    assert.equal(transactions.length, 2, 'An old declined prompt must not allow a third payment');
    for (const transaction of transactions) {
      assert.equal(transaction.to, '0x' + '44'.repeat(20)); assert.equal(transaction.value, '0x0');
      assert.equal(transaction.data, '0xa9059cbb' + '55'.repeat(20).padStart(64, '0') + BigInt('1000000000000000000').toString(16).padStart(64, '0'));
    }
    checked('A late declined payment from an old session cannot unlock the new NFT session payment or alter its transaction hash');

    await logout(); await nav(page, 'chat'); await page.locator('#workspace-content [data-action="connect"]').click();
    await page.locator('#connect-mode').selectOption('account');
    await page.evaluate(() => { window.__qaWalletPrompts.holdSignature = true; });
    await page.locator('#connect-submit').click();
    await page.waitForFunction(() => typeof window.__qaWalletPrompts.rejectSignature === 'function');
    await page.evaluate(() => window.__qaWallet.emit('chainChanged', '0x1'));
    const changedNotice = await page.locator('#workspace-notice').textContent();
    assert.match(changedNotice, /Wallet network changed/);
    const beforeVerify = requests.filter(item => /\/api\/(account\/)?auth\/verify$/.test(item.path)).length;
    await page.evaluate(() => window.__qaWalletPrompts.rejectSignature()); await page.waitForTimeout(100);
    assert.equal(await page.locator('#workspace-notice').textContent(), changedNotice);
    assert.equal(await page.locator('#connect-submit').isDisabled(), false);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('jeff:workspace:session:v1')), null);
    assert.equal(requests.filter(item => /\/api\/(account\/)?auth\/verify$/.test(item.path)).length, beforeVerify);
    assert.equal(requests.filter(item => item.method === 'POST' && ['/api/jobs', '/api/conversations', '/api/hosting/activate'].includes(item.path)).length, 0);
    checked('A late declined login signature cannot overwrite wallet-change feedback, restore a session or verify the old login');
    report.walletCallbackIsolation = { invoiceReadNoticePreserved: true, newScopePaymentLockPreserved: true, transactionHashPreserved: true,
      lateLoginNoticePreserved: true, simulatedTransactionRequests: transactions.length, actualChainRequests: 0, jobsCreated: 0 };
  } finally { await isolated.context.close(); }
}

(async () => {
  await fs.mkdir(output, { recursive: true });
  const fixtureResponse = await fetch(new URL('/api/config', base));
  assert.equal(fixtureResponse.status, 200, 'QA requires a reachable development fixture');
  assert.equal((await fixtureResponse.json()).fixture, true, 'QA refuses signed flows and mutations on a live runtime');
  const browserPath = process.env.JEFF_QA_BROWSER || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : null);
  browser = await chromium.launch({ ...(browserPath ? { executablePath: browserPath } : { channel: 'chrome' }), headless: true });
  const desktop = await newContext({ width: 1440, height: 1000 });
  const page = desktop.page;
  try {
    // Reproduce a saved standalone login, then deliberately open an NFT workspace.
    // An NFT pilot must never fund the account or silently change its authentication scope.
    const accountCase = await newContext({ width: 1440, height: 1000 });
    const ap = accountCase.page;
    try {
      await ap.locator('#workspace-content [data-action="connect"]').click();
      assert.equal(await ap.locator('#connect-mode').inputValue(), 'nft');
      await signStandalone(ap);
      assert.equal((await api(ap, '/api/hosting')).value.active, false);
      assert.equal(await ap.locator('#composer-input').isDisabled(), true);
      assert.equal(await ap.locator('#workspace-content [data-action="connect"]').isVisible(), true);
      assert.match((await signatureMessages(ap))[0], /^Simple JEFF standalone account login\n/);
      checked('Explicit standalone login stays account scoped and cannot consume Room35 pilot hosting');

      const accountNote = `Account-only QA ${Date.now()}`;
      await nav(ap, 'memory');
      await ap.locator('#memory-title').fill(accountNote); await ap.locator('#memory-text').fill('This private note belongs only to the standalone wallet account.');
      await ap.locator('#memory-form button[type="submit"]').click();
      await ap.locator('.memory-card').filter({ hasText: accountNote }).waitFor();
      await ap.reload();
      await ap.locator('.memory-card').filter({ hasText: accountNote }).waitFor();
      assert.equal((await api(ap, '/api/workspace')).value.scope.kind, 'account');
      assert.equal((await signatureMessages(ap)).length, 0);
      checked('Reload restores the signed standalone account and its private memory without a new signature');

      await settingsConcurrency(ap, accountNote);

      await sidebarAction(ap, '[data-action="connect-account"]', true);
      assert.equal(await ap.locator('#connect-mode').inputValue(), 'account');
      await ap.keyboard.press('Escape');
      await sidebarAction(ap, '.sidebar-section-heading [data-action="connect"]', true);
      assert.equal(await ap.locator('#connect-mode').inputValue(), 'nft');
      assert.equal((await signatureMessages(ap)).length, 0);
      await ap.keyboard.press('Escape');
      checked('Keyboard account entry remains explicit while Agent NFT plus resets restored account mode');

      await sidebarAction(ap, '[data-action="discover-agents"]');
      await ap.locator('#token-picker').waitFor({ state: 'visible' });
      assert.equal(await ap.locator('#connect-mode').inputValue(), 'nft');
      assert.deepEqual(await ap.locator('#connect-token option').evaluateAll(nodes => nodes.map(n => n.value)), ['35', '128', '207']);
      assert.equal((await signatureMessages(ap)).length, 0);
      checked('Account Room discovery requests NFT inventory without making a standalone personal_sign');

      await signPickedRoom(ap);
      assert.deepEqual((await signatureMessages(ap)).map(message => message.split('\n')[0]), ['Simple JEFF holder login']);
      assert.match((await signatureMessages(ap))[0], /\nToken: 35\n/);
      await nav(ap, 'memory');
      assert.equal(await ap.locator('.memory-card').filter({ hasText: accountNote }).count(), 0);
      checked('Room35 requires a fresh NFT signature, activates its pilot composer and receives no account memory');

      await sidebarAction(ap, '.sidebar-section-heading [data-action="connect"]');
      await signStandalone(ap);
      await nav(ap, 'memory');
      const accountMemory = ap.locator('.memory-card').filter({ hasText: accountNote });
      await accountMemory.waitFor();
      await accountMemory.locator('[data-action="delete-memory"]').click();
      await accountMemory.waitFor({ state: 'detached' });
      await nav(ap, 'chat');
      await ap.locator('#workspace-content [data-action="connect"]').click();
      assert.equal(await ap.locator('#connect-mode').inputValue(), 'nft');
      await ap.keyboard.press('Escape');
      checked('Standalone remains reachable through the dropdown and inactive account offers an explicit NFT switch');
    } finally { await accountCase.context.close(); }

    await walletCallbackIsolation();

    assert.match(await page.locator('#runtime-copy').textContent(), /simulated|fixture|no live/i);
    assert.equal(await page.locator('#composer-input').count(), 0);
    checked('Signed-out view contains no private conversation and fixture is explicit');
    await capture(page, 'desktop-signed-out');
    await connect(page);
    checked('Real signed fixture login discovers three NFTs and verifies chosen Room35');
    const initial = await api(page, '/api/workspace');
    assert.equal(initial.value.scope.tokenId, '35');
    // Leave preexisting fixture work untouched; only remove records created by this run.
    const unique = `QA ${Date.now()}`;
    assert.deepEqual(initial.value.conversations, [], 'First-send regression requires an empty isolated Room35 fixture workspace');
    await ready(page);
    const objective = `${unique}: draft a short Agent NFT launch checklist. **literal user prompt** <script>window.qaInjected=true</script>`;
    const submissions = [];
    const signaturesBeforeAdmission = await signatureMessages(page), recoveryRequests = [], rejectedPostRecoveryRequests = [];
    let rejectedFirstSubmission = false, acceptedRecord, failedAcceptedRefresh = false, rejectedRefreshesRemaining = 0, conversationPosts = 0;
    const observeSubmission = request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/jobs') submissions.push(request.postDataJSON());
    };
    page.on('request', observeSubmission);
    const conversationRoute = async route => {
      if (route.request().method() !== 'POST') return route.continue();
      conversationPosts++;
      return fixtureUnavailable(page, route, 'obsolete split first-send conversation request');
    };
    const jobsRoute = async route => {
      if (route.request().method() !== 'POST') return route.continue();
      if (!rejectedFirstSubmission) { rejectedFirstSubmission = true; return fixtureUnavailable(page, route, 'initial job admission'); }
      const response = await route.fetch();
      if (response.status() === 202) { acceptedRecord = await response.json(); rejectedRefreshesRemaining = 3; }
      return route.fulfill({ response });
    };
    const stateRoute = async route => {
      if (route.request().method() === 'GET' && rejectedFirstSubmission && !acceptedRecord) rejectedPostRecoveryRequests.push({ method: 'GET', at: Date.now() });
      if (route.request().method() === 'GET' && acceptedRecord) {
        recoveryRequests.push({ method: 'GET', at: Date.now(), rejected: rejectedRefreshesRemaining > 0 });
        if (rejectedRefreshesRemaining > 0) {
          rejectedRefreshesRemaining--; failedAcceptedRefresh = true;
          return fixtureUnavailable(page, route, 'workspace refresh after accepted job');
        }
      }
      return route.continue();
    };
    await page.route('**/api/conversations', conversationRoute);
    await page.route('**/api/jobs', jobsRoute);
    await page.route('**/api/workspace/state', stateRoute);
    await page.locator('#composer-input').fill(objective);
    await page.locator('[data-action="send-task"]').click();
    await page.waitForFunction(() => /service is unavailable/i.test(document.getElementById('workspace-notice').textContent));
    await ready(page);
    assert.equal(await page.locator('#composer-input').inputValue(), objective);
    assert.deepEqual((await api(page, '/api/workspace')).value.conversations, []);
    assert.equal((await api(page, '/api/jobs')).value.jobs.some(item => item.objective === objective), false);
    assert.equal(submissions.length, 1);
    assert.equal(conversationPosts, 0);
    checked('Rejected first send reports its 503, keeps the draft and creates no conversation, job or automatic retry');
    await page.waitForFunction(() => document.getElementById('workspace-notice').textContent === 'Connection restored. Review saved work before retrying.', null, { timeout: 7000 });
    assert.ok(rejectedPostRecoveryRequests.length >= 1);
    assert.equal(await page.locator('#composer-input').inputValue(), objective);
    assert.equal(await page.locator('#workspace-notice').evaluate(element => element.classList.contains('is-error')), false);
    assert.deepEqual((await api(page, '/api/workspace')).value.conversations, []);
    assert.equal((await api(page, '/api/jobs')).value.jobs.some(item => item.objective === objective), false);
    assert.deepEqual(await signatureMessages(page), signaturesBeforeAdmission);
    assert.equal(submissions.length, 1); assert.equal(conversationPosts, 0);
    report.rejectedPostRecovery = { automaticWorkspaceGets: rejectedPostRecoveryRequests.length,
      draftPreserved: true, conversationsCreated: 0, jobsCreated: 0, additionalJobPosts: 0, authSignaturesAdded: 0,
      restoredBanner: 'Connection restored. Review saved work before retrying.' };
    checked('Rejected task POST recovers its connection banner through GET only while preserving the draft and creating no job');

    await page.locator('[data-action="send-task"]').click();
    await page.waitForFunction(() => /accepted|admitted/i.test(document.getElementById('workspace-notice').textContent)
      && /refresh|reload/i.test(document.getElementById('workspace-notice').textContent));
    const acceptedView = await page.evaluate(() => ({ draft: document.getElementById('composer-input').value,
      composerDisabled: document.getElementById('composer-input').disabled, sendDisabled: document.querySelector('[data-action="send-task"]').disabled,
      noticeError: document.getElementById('workspace-notice').classList.contains('is-error'), notice: document.getElementById('workspace-notice').textContent }));
    assert.equal(failedAcceptedRefresh, true);
    assert.ok(acceptedRecord?.id); assert.ok(acceptedRecord?.conversationId);
    assert.equal(acceptedView.draft, ''); assert.equal(acceptedView.composerDisabled, false); assert.equal(acceptedView.sendDisabled, true);
    assert.equal(acceptedView.noticeError, true);
    assert.match(acceptedView.notice, new RegExp(acceptedRecord.id));
    assert.equal(submissions.length, 2);
    assert.ok(submissions.every(input => input.objective === objective && !Object.hasOwn(input, 'conversationId')));
    assert.equal(conversationPosts, 0);
    assert.equal((await api(page, '/api/jobs')).value.jobs.filter(item => item.objective === objective).length, 1);
    checked('Accepted first send survives a refresh 503 with its job ID, cleared draft and no duplicate or split conversation POST');

    // Restore only the GET endpoint after three failures; the page must recover itself.
    await page.locator('.message.assistant .pill').filter({ hasText: 'Saved' }).last().waitFor({ timeout: 35000 });
    await page.waitForFunction(() => document.getElementById('workspace-notice').textContent === 'Run completed and saved.');
    assert.equal(recoveryRequests.filter(item => item.rejected).length, 3);
    assert.ok(recoveryRequests.length >= 4);
    assert.equal(recoveryRequests.at(-1).rejected, false);
    const recoveryIntervalsMs = recoveryRequests.slice(1).map((request, index) => request.at - recoveryRequests[index].at);
    assert.ok(recoveryIntervalsMs.every(interval => interval >= 1000), `GET recovery must avoid rapid retry loops: ${recoveryIntervalsMs}`);
    assert.deepEqual(await signatureMessages(page), signaturesBeforeAdmission);
    assert.equal(submissions.length, 2); assert.equal(conversationPosts, 0);
    assert.equal(await page.locator('#workspace-notice').evaluate(element => element.classList.contains('is-error')), false);
    report.pollRecovery = { rejectedWorkspaceGets: 3, automaticWorkspaceGets: recoveryRequests.length,
      requests: recoveryRequests.map(request => ({ ...request })), recoveryIntervalsMs, manualRefreshes: 0, reloadsBeforeRecovery: 0, authSignaturesAdded: 0,
      jobPostAttempts: submissions.length, additionalJobPosts: 0, conversationPosts };
    checked('Repeated workspace GET failures recover automatically to the saved job without Refresh, signatures or additional mutation requests');
    const jobs = (await api(page, '/api/jobs')).value.jobs;
    const job = jobs.find(item => item.objective === objective);
    assert.ok(job); assert.equal(job.status, 'completed');
    const conversationId = acceptedRecord.conversationId;
    const persistedWorkspace = (await api(page, '/api/workspace')).value;
    assert.equal(persistedWorkspace.conversations.length, 1);
    assert.deepEqual(persistedWorkspace.conversations[0].jobIds, [job.id]);
    assert.equal(persistedWorkspace.conversations[0].id, conversationId);
    assert.equal(await page.locator('#conversation-select').inputValue(), conversationId);
    assert.equal(job.id, acceptedRecord.id);
    assert.equal(createHash('sha256').update(job.text).digest('hex'), job.textSha256);
    assert.equal(await page.evaluate(() => window.qaInjected), undefined);
    checked('Real persisted task polls to Saved, hash verifies, and supplied HTML renders as text');
    await page.reload(); await ready(page);
    await page.locator('.message.assistant .pill').filter({ hasText: 'Saved' }).last().waitFor();
    assert.equal(await page.locator('#conversation-select').inputValue(), conversationId);
    assert.deepEqual(await page.locator('.message.user .user-bubble').evaluateAll(nodes => nodes.map(element => element.textContent)), [objective]);
    assert.equal((await api(page, '/api/jobs')).value.jobs.filter(item => item.objective === objective).length, 1);
    assert.equal(submissions.length, 2); assert.equal(conversationPosts, 0);
    report.firstSend = { initialConversations: 0, jobPostAttempts: submissions.length, rejectedAdmissions: 1, acceptedJobs: 1,
      conversationPostRequests: conversationPosts, injectedRefreshFailures: recoveryRequests.filter(item => item.rejected).length, jobId: job.id, conversationId,
      persistedConversationJobIds: persistedWorkspace.conversations[0].jobIds, reloadRestoredHistory: true, automaticResubmissions: 0 };
    checked('Atomic first send binds one saved job to one conversation and reload restores its history without rerunning');
    assert.equal(await page.locator('.message.user .user-bubble strong,.message.user .user-bubble script,.message.user .user-bubble a').count(), 0);
    const desktopReply = await formattedReply(page, job, 'desktop');
    await page.locator('#chat-feed').evaluate(element => { element.scrollTop = 0; });
    await capture(page, 'desktop-markdown-reply');
    await desktopReply.locator('pre').evaluate(element => element.scrollIntoView({ block: 'start' }));
    await capture(page, 'desktop-markdown-code-table');
    checked('Desktop saved reply renders readable Markdown while user prompts stay literal and unsafe HTML, links and images remain inert');
    await desktop.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
    await page.evaluate(() => {
      const write = navigator.clipboard.writeText.bind(navigator.clipboard);
      window.__qaClipboardWrites = [];
      navigator.clipboard.writeText = async text => { window.__qaClipboardWrites.push(text); return write(text); };
    });
    await page.locator(`[data-action="copy-result"][data-id="${job.id}"]`).click();
    await page.waitForFunction(async expected => (await navigator.clipboard.readText()).replace(/\r\n/g, '\n') === expected.replace(/\r\n/g, '\n'), job.text);
    const nativeClipboardText = await page.evaluate(() => navigator.clipboard.readText());
    assert.equal(nativeClipboardText.replace(/\r\n/g, '\n'), job.text.replace(/\r\n/g, '\n'));
    assert.deepEqual(await page.evaluate(() => window.__qaClipboardWrites), [job.text]);
    assert.equal(submissions.length, 2); assert.equal(conversationPosts, 0);
    await page.unroute('**/api/conversations', conversationRoute);
    await page.unroute('**/api/jobs', jobsRoute);
    await page.unroute('**/api/workspace/state', stateRoute);
    page.off('request', observeSubmission);
    assert.equal(await page.locator('#chat-feed .receipt-details,#chat-feed [data-action="download-result"]').count(), 0);
    await nav(page, 'activity');
    await page.locator(`[data-action="open-job"][data-id="${job.id}"]`).click();
    await page.locator('.receipt-dialog[open]').waitFor();
    await page.locator('.receipt-details summary').last().click();
    assert.equal(await page.locator('.receipt-facts').last().getByText(job.id, { exact: true }).count(), 1);
    assert.equal(await page.locator('.receipt-facts').last().getByText(job.runtime, { exact: true }).count(), 1);
    assert.equal(job.runtime, 'openclaw'); assert.equal(job.model, 'bankr/fixture-model');
    const downloadPromise = page.waitForEvent('download');
    await page.locator('[data-action="download-result"]').last().click();
    const download = await downloadPromise; await download.saveAs(path.join(output, 'fixture-receipt.json'));
    const exportedReceipt = JSON.parse(await fs.readFile(path.join(output, 'fixture-receipt.json'), 'utf8'));
    assert.equal(exportedReceipt.id, job.id); assert.equal(exportedReceipt.runtime, job.runtime); assert.equal(exportedReceipt.model, job.model);
    assert.equal(exportedReceipt.text, job.text); assert.equal(exportedReceipt.textSha256, job.textSha256);
    assert.equal(createHash('sha256').update(exportedReceipt.text).digest('hex'), job.textSha256);
    const unchangedRecord = (await api(page, `/api/jobs/${job.id}`)).value;
    assert.equal(unchangedRecord.text, job.text); assert.equal(unchangedRecord.textSha256, job.textSha256);
    await page.keyboard.press('Escape');
    await nav(page, 'chat');
    report.replyFormatting.rawSource = { copiedMarkdownPreserved: true, downloadedMarkdownPreserved: true,
      clipboardWriteArgumentByteExact: true, nativeClipboardNormalizedLineEndings: nativeClipboardText !== job.text,
      storedTextSha256Preserved: true, textSha256: job.textSha256, modelReruns: 0 };
    checked('Formatting leaves raw copied and downloaded Markdown, stored response and text SHA unchanged without rerunning the task');
    checked('Chat omits receipt controls; Activity receipt discloses integrity limits and exports the durable job');
    await capture(page, 'desktop-conversation');

    // Delay acknowledgement and refresh separately, while the real fixture job runs.
    // Typing must remain responsive without allowing a second task submission.
    const admissionObjective = `${unique}: verify responsive task admission`;
    const pendingDraft = 'Draft the next message while JEFF works.';
    const workingDraft = `${pendingDraft} Please keep this draft.`;
    const admissionPosts = [], admissionConversationPosts = [];
    let admissionRecord, postHeldAt, postReleasedAt, stateHeldAt, stateReleasedAt;
    let releasePost, releaseState, acceptedPost, requestedState;
    const postGate = new Promise(resolve => { releasePost = resolve; });
    const stateGate = new Promise(resolve => { releaseState = resolve; });
    const postAccepted = new Promise(resolve => { acceptedPost = resolve; });
    const stateRequested = new Promise(resolve => { requestedState = resolve; });
    const observeAdmission = request => {
      const endpoint = new URL(request.url()).pathname;
      if (request.method() === 'POST' && endpoint === '/api/jobs') admissionPosts.push(request.postDataJSON());
      if (request.method() === 'POST' && endpoint === '/api/conversations') admissionConversationPosts.push(request.postDataJSON());
    };
    const admissionRoute = async route => {
      if (route.request().method() !== 'POST' || route.request().postDataJSON()?.objective !== admissionObjective) return route.continue();
      const response = await route.fetch();
      assert.equal(response.status(), 202);
      admissionRecord = await response.json(); postHeldAt = Date.now(); acceptedPost();
      await postGate;
      return route.fulfill({ response });
    };
    let heldAdmissionState = false;
    const admissionStateRoute = async route => {
      if (route.request().method() !== 'GET' || !admissionRecord || heldAdmissionState) return route.continue();
      heldAdmissionState = true;
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      stateHeldAt = Date.now(); requestedState();
      await stateGate;
      return route.fulfill({ response });
    };
    page.on('request', observeAdmission);
    await page.route('**/api/jobs', admissionRoute);
    await page.route('**/api/workspace/state', admissionStateRoute);
    try {
      await ready(page); await page.locator('#composer-input').fill(admissionObjective);
      await page.locator('[data-action="send-task"]').click();
      await page.waitForFunction(() => /sending/i.test(document.querySelector('[data-action="send-task"]')?.getAttribute('aria-label') || ''));
      await bounded(postAccepted, 'fixture job admission behind the held response');
      assert.equal(await page.locator('#composer-input').isDisabled(), false);
      assert.equal(await page.locator('[data-action="send-task"]').isDisabled(), true);
      assert.ok((await page.locator('#chat-feed').textContent()).includes(admissionObjective), 'The submitted task must be visible before acknowledgement');
      await page.locator('#composer-input').fill(pendingDraft);
      await page.keyboard.press('Enter');
      assert.equal(admissionPosts.length, 1);
      assert.deepEqual(admissionPosts[0], { objective: admissionObjective, conversationId });
      assert.equal(await page.locator('#composer-input').inputValue(), pendingDraft);
      await page.waitForTimeout(1500);
      postReleasedAt = Date.now(); releasePost();
      await bounded(stateRequested, 'held workspace state response after admission');
      await page.locator(`.message.assistant[data-job-id="${admissionRecord.id}"] .running-indicator`).waitFor();
      assert.equal(await page.locator('#composer-input').isDisabled(), false);
      assert.equal(await page.locator('#composer-input').inputValue(), pendingDraft);
      assert.equal(await page.locator('[data-action="send-task"]').isDisabled(), true);
      assert.deepEqual(await page.evaluate(() => ({ focused: document.activeElement?.id,
        start: document.getElementById('composer-input').selectionStart, end: document.getElementById('composer-input').selectionEnd })),
      { focused: 'composer-input', start: pendingDraft.length, end: pendingDraft.length });
      await page.keyboard.type(' Please keep this draft.');
      await page.locator('#composer-input').evaluate(element => element.setSelectionRange(6, 18));
      assert.equal(await page.locator('#composer-input').inputValue(), workingDraft);
      await page.waitForTimeout(1200);
      stateReleasedAt = Date.now(); releaseState();
      await page.locator(`.message.assistant[data-job-id="${admissionRecord.id}"] .pill`).filter({ hasText: 'Saved' }).waitFor({ timeout: 12000 });
      await ready(page);
      assert.deepEqual(await page.evaluate(() => ({ draft: document.getElementById('composer-input').value, focused: document.activeElement?.id,
        start: document.getElementById('composer-input').selectionStart, end: document.getElementById('composer-input').selectionEnd })),
      { draft: workingDraft, focused: 'composer-input', start: 6, end: 18 });
      assert.equal(admissionPosts.length, 1); assert.deepEqual(admissionConversationPosts, []);
      const admittedReceipt = (await api(page, `/api/jobs/${admissionRecord.id}`)).value;
      assert.equal(admittedReceipt.status, 'completed'); assert.equal(admittedReceipt.objective, admissionObjective);
      assert.equal(createHash('sha256').update(admittedReceipt.text).digest('hex'), admittedReceipt.textSha256);
      const admittedWorkspace = (await api(page, '/api/workspace')).value;
      assert.ok(admittedWorkspace.conversations.find(item => item.id === conversationId)?.jobIds.includes(admissionRecord.id));
      assert.equal((await api(page, '/api/jobs')).value.jobs.filter(item => item.objective === admissionObjective).length, 1);
      report.admissionResponsiveness = { pendingFeedbackBeforeAcknowledgement: true, postDeliveryHeldMs: postReleasedAt - postHeldAt,
        stateDeliveryHeldMs: stateReleasedAt - stateHeldAt, draftTypingDuringAdmission: true, draftTypingDuringWork: true,
        submittedObjectivePreserved: true, nextDraftPreserved: true, focusAndSelectionPreserved: true,
        visibleAdmittedJobBeforeStateResponse: true, taskPosts: admissionPosts.length, conversationPosts: 0,
        savedJobId: admissionRecord.id, conversationId };
      checked('Delayed task acknowledgement and refresh keep typing responsive, preserve the next draft and selection, and save exactly one submitted task');
    } finally {
      releasePost(); releaseState();
      await page.unroute('**/api/jobs', admissionRoute);
      await page.unroute('**/api/workspace/state', admissionStateRoute);
      page.off('request', observeAdmission);
    }

    const rejectedSuggestionObjective = `${unique}: keep a replacement suggestion after rejected admission`;
    const suggestionJobsBefore = (await api(page, '/api/jobs')).value.jobs.length;
    const suggestionSignaturesBefore = await signatureMessages(page), suggestionFailurePosts = [];
    let releaseSuggestionFailure, requestedSuggestionFailure;
    const suggestionFailureGate = new Promise(resolve => { releaseSuggestionFailure = resolve; });
    const suggestionFailureRequested = new Promise(resolve => { requestedSuggestionFailure = resolve; });
    const observeSuggestionFailure = request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/jobs') suggestionFailurePosts.push(request.postDataJSON());
    };
    const suggestionFailureRoute = async route => {
      if (route.request().method() !== 'POST' || route.request().postDataJSON()?.objective !== rejectedSuggestionObjective) return route.continue();
      requestedSuggestionFailure(); await suggestionFailureGate;
      return fixtureUnavailable(page, route, 'rejected admission after a suggestion replaced the draft');
    };
    page.on('request', observeSuggestionFailure);
    await page.route('**/api/jobs', suggestionFailureRoute);
    try {
      await ready(page); await page.locator('#composer-input').fill(rejectedSuggestionObjective);
      await page.locator('[data-action="send-task"]').click();
      await bounded(suggestionFailureRequested, 'held rejected admission before choosing a suggestion');
      await page.locator('[data-pending-message="sending"]').waitFor();
      const suggestion = page.locator('[data-action="suggestion"]').first();
      const suggestedDraft = await suggestion.getAttribute('data-prompt');
      await suggestion.click();
      assert.equal(await page.locator('#composer-input').inputValue(), suggestedDraft);
      releaseSuggestionFailure();
      await page.locator('[data-pending-message="unconfirmed"]').waitFor();
      assert.equal(await page.locator('[data-pending-message="unconfirmed"] .user-bubble').textContent(), rejectedSuggestionObjective);
      assert.equal(await page.locator('#composer-input').inputValue(), suggestedDraft);
      assert.equal((await api(page, '/api/jobs')).value.jobs.length, suggestionJobsBefore);
      await page.waitForFunction(() => document.getElementById('workspace-notice').textContent === 'Connection restored. Review saved work before retrying.', null, { timeout: 7000 });
      assert.equal(await page.locator('#composer-input').inputValue(), suggestedDraft);
      assert.equal(await page.locator('[data-pending-message="unconfirmed"] .user-bubble').textContent(), rejectedSuggestionObjective);
      assert.equal(suggestionFailurePosts.length, 1);
      assert.deepEqual(suggestionFailurePosts[0], { objective: rejectedSuggestionObjective, conversationId });
      assert.equal((await api(page, '/api/jobs')).value.jobs.length, suggestionJobsBefore);
      assert.equal((await api(page, '/api/jobs')).value.jobs.some(item => item.objective === rejectedSuggestionObjective), false);
      assert.deepEqual(await signatureMessages(page), suggestionSignaturesBefore);
      report.suggestionDuringRejectedAdmission = { replacementSuggestionPreserved: true, originalSubmissionMarkedUnconfirmed: true,
        automaticGetRecoveryPreservedDraft: true, taskPostAttempts: suggestionFailurePosts.length, createdJobs: 0,
        automaticTaskResubmissions: 0, addedWalletSignatures: 0 };
      checked('A suggestion replacing the draft during rejected admission survives error and GET recovery while the original send stays unconfirmed without a new job');
    } finally {
      releaseSuggestionFailure(); await page.unroute('**/api/jobs', suggestionFailureRoute);
      page.off('request', observeSuggestionFailure);
    }
    await ready(page); await page.locator('#composer-input').fill(`${unique}: stop this fixture run`); await page.locator('[data-action="send-task"]').click();
    await page.locator('[data-action="stop-job"]').waitFor();
    const workingLabel = `${await page.locator('#agent-title').textContent()} is working on your request.`;
    assert.equal(await page.locator('.running-indicator').textContent(), workingLabel);
    assert.equal(await page.locator('#context-engine').textContent(), 'Test fixture');
    report.branding = { runningIndicator: workingLabel, receiptRuntime: job.runtime, receiptModel: job.model, fixturePresentation: 'Test fixture' };
    await page.locator('[data-action="stop-job"]').click();
    await page.locator('.message.assistant .pill').filter({ hasText: 'Failed' }).last().waitFor({ timeout: 12000 });
    await page.waitForFunction(() => document.getElementById('workspace-notice').textContent === 'The run ended after your stop request. Its saved status is Failed.');
    checked('Stop requests owned cancellation and UI reports actual failed terminal state');
    for (const view of ['activity', 'skills', 'memory', 'usage', 'schedules', 'hosting', 'settings', 'chat']) {
      await nav(page, view); assert.ok((await page.locator('#workspace-content').textContent()).trim());
    }
    checked('All eight workspace views render from persistent backend state');
    await nav(page, 'memory');
    await page.locator('#memory-title').fill(unique); await page.locator('#memory-text').fill('Private QA note. <img src=x onerror=window.qaInjected=true>');
    await page.locator('#memory-form button[type="submit"]').click();
    await page.locator('.memory-card').filter({ hasText: unique }).waitFor();
    const memoryCard = page.locator('.memory-card').filter({ hasText: unique });
    await memoryCard.locator('[data-action="edit-memory"]').click(); await page.locator('#memory-text').fill('Private QA note edited.');
    await page.locator('#memory-form button[type="submit"]').click(); await memoryCard.getByText('Private QA note edited.', { exact: true }).waitFor();
    await page.reload(); await page.locator('.memory-card').filter({ hasText: unique }).waitFor();
    checked('Memory create/edit survives reload through real API');
    await nav(page, 'skills');
    const toggle = page.locator('[data-action="toggle-skill"][data-id="writing"]');
    const enabled = await toggle.getAttribute('aria-checked'); await toggle.click();
    await page.waitForFunction(original => document.querySelector('[data-id="writing"]').getAttribute('aria-checked') !== original, enabled);
    assert.equal((await api(page, '/api/workspace')).value.skills.find(s => s.id === 'writing').enabled, enabled !== 'true');
    await toggle.click(); await page.waitForFunction(original => document.querySelector('[data-id="writing"]').getAttribute('aria-checked') === original, enabled);
    checked('Prompt recipe switches persist without enabling external tools');
    await nav(page, 'settings');
    const originalSettings = (await api(page, '/api/workspace')).value.settings;
    await page.locator('#settings-name').fill('QA Room ' + 'W'.repeat(40)); await page.locator('#settings-budget').fill('0.000001');
    await page.locator('#settings-form button[type="submit"]').click();
    await page.waitForFunction(() => document.getElementById('agent-title').textContent.startsWith('QA Room'));
    const settings = (await api(page, '/api/workspace')).value.settings;
    assert.equal(settings.dailyBudgetMicros, 1);
    await page.locator('#settings-paused').check(); await page.locator('#settings-form button[type="submit"]').click();
    await page.waitForFunction(() => document.getElementById('agent-status').textContent.includes('Paused'));
    await nav(page, 'chat'); assert.equal(await page.locator('#composer-input').isDisabled(), true);
    await page.locator('#pause-agent').click(); await ready(page);
    checked('Exact microdollar settings roundtrip and pause/resume controls block future submissions');
    await nav(page, 'usage');
    assert.match(await page.locator('#workspace-content').textContent(), /operator funded|operator-funded/i);
    assert.match(await page.locator('#workspace-content').textContent(), /not.*dollar.*balance|No prepaid inference wallet/i);
    checked('Operator-funded usage makes no invented prepaid balance or provider budget claim');
    await capture(page, 'desktop-usage');
    await nav(page, 'hosting');
    assert.match(await page.locator('#workspace-content').textContent(), /Paid checkout is unavailable/);
    assert.equal(await page.locator('[data-action="pay-invoice"]').count(), 0);
    assert.equal(await page.locator('[data-action="claim-free-pass"]').count(), 0);
    checked('Disabled checkout and free-pass claims remain honest and request no payment');
    await nav(page, 'schedules');
    await page.locator('#schedule-objective').fill(`${unique}: scheduled planning`);
    await page.locator('#schedule-interval').fill('60'); await page.locator('#schedule-max-runs').fill('2');
    assert.equal(await page.locator('#schedule-consent').isChecked(), false);
    const beforeSchedules = (await api(page, '/api/schedules')).value.schedules.length;
    await page.locator('#schedule-form button[type="submit"]').click();
    assert.equal((await api(page, '/api/schedules')).value.schedules.length, beforeSchedules);
    await page.locator('#schedule-consent').check(); await page.locator('#schedule-form button[type="submit"]').click();
    const scheduleCard = page.locator('.schedule-card').filter({ hasText: `${unique}: scheduled planning` }); await scheduleCard.waitFor();
    const schedule = (await api(page, '/api/schedules')).value.schedules.find(item => item.objective.startsWith(unique));
    assert.equal(schedule.maxRuns, 2); assert.equal(schedule.scope.tokenId, '35');
    await scheduleCard.locator('[data-action="cancel-schedule"]').click(); await scheduleCard.locator('.pill').filter({ hasText: 'cancelled' }).waitFor();
    checked('Recurring grant requires explicit consent, enforces bounds, and cancels through actual API');
    await capture(page, 'desktop-schedules');
    await page.keyboard.press('Control+k'); await page.locator('#command-dialog[open]').waitFor();
    await page.locator('#command-search').fill('Memory'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
    await page.locator('#memory-form').waitFor();
    checked('Ctrl+K palette supports search, arrow navigation and Enter activation');
    // A second NFT requires a fresh signature and receives an isolated workspace.
    const signaturesBefore = await page.evaluate(() => window.__qaWallet.signatures.length);
    await switchNft(page, '128');
    assert.equal((await api(page, '/api/workspace')).value.scope.tokenId, '128');
    assert.ok((await page.evaluate(() => window.__qaWallet.signatures.length)) > signaturesBefore);
    await nav(page, 'memory'); assert.equal(await page.locator('.memory-card').filter({ hasText: unique }).count(), 0);
    checked('NFT switch requests a fresh signature and clears previous NFT private memory');
    await switchNft(page, '35');
    await nav(page, 'memory'); await page.locator('.memory-card').filter({ hasText: unique }).waitFor();
    await page.locator('.memory-card').filter({ hasText: unique }).locator('[data-action="delete-memory"]').click();
    await page.locator('.memory-card').filter({ hasText: unique }).waitFor({ state: 'detached' });
    checked('Returning to an NFT restores its saved memory; deletion persists');
    await nav(page, 'chat'); await page.locator('#conversation-select').selectOption(conversationId);
    await page.locator('[data-action="delete-conversation"]').click();
    await page.waitForFunction(id => ![...document.querySelectorAll('#conversation-select option')].some(o => o.value === id), conversationId);
    assert.equal((await api(page, '/api/jobs')).value.jobs.some(item => item.id === job.id), true);
    checked('Conversation removal keeps saved run receipts available in Activity');
    await nav(page, 'activity'); await page.locator(`[data-action="open-job"][data-id="${job.id}"]`).click();
    await page.locator('.receipt-dialog[open]').waitFor(); await page.keyboard.press('Escape');
    checked('Orphaned saved run opens a receipt after conversation deletion');
    // Wallet events clear private content immediately without changing fixture chain state.
    let invalidatedRecoveryGets = 0;
    const signaturesBeforeInvalidation = await signatureMessages(page), invalidatedMutations = [];
    const invalidationRoute = async route => {
      if (route.request().method() !== 'GET') return route.continue();
      invalidatedRecoveryGets++;
      return fixtureUnavailable(page, route, 'queued GET recovery before wallet scope invalidation');
    };
    const observeInvalidatedMutation = request => {
      if (request.method() === 'POST' && ['/api/jobs', '/api/conversations', '/api/auth/challenge', '/api/account/auth/challenge'].includes(new URL(request.url()).pathname)) invalidatedMutations.push(new URL(request.url()).pathname);
    };
    page.on('request', observeInvalidatedMutation);
    await page.route('**/api/workspace/state', invalidationRoute);
    await page.locator('[data-action="refresh"]').click();
    await page.waitForFunction(() => document.getElementById('workspace-notice').classList.contains('is-error'));
    assert.equal(invalidatedRecoveryGets, 1);
    await page.evaluate(() => window.__qaWallet.emit('accountsChanged', ['0x' + '99'.repeat(20)]));
    await page.waitForFunction(() => !sessionStorage.getItem('jeff:workspace:session:v1'));
    assert.equal(await page.locator('.memory-card,.message.assistant').count(), 0);
    checked('accountsChanged clears private state and session immediately');
    await page.waitForTimeout(3100);
    assert.equal(invalidatedRecoveryGets, 1);
    assert.deepEqual(await signatureMessages(page), signaturesBeforeInvalidation);
    assert.deepEqual(invalidatedMutations, []);
    report.invalidatedRecovery = { injectedWorkspaceGetFailures: 1, workspaceGetsAfterPrivateClear: 0,
      observedAfterClearMs: 3100, authSignaturesAdded: 0, jobConversationOrChallengePosts: 0 };
    checked('Wallet scope invalidation cancels the queued GET recovery without further requests, signatures or jobs');
    await page.unroute('**/api/workspace/state', invalidationRoute);
    page.off('request', observeInvalidatedMutation);
    await nav(page, 'chat'); await connect(page);
    await page.evaluate(() => window.__qaWallet.emit('chainChanged', '0x1'));
    await page.waitForFunction(() => !sessionStorage.getItem('jeff:workspace:session:v1'));
    assert.equal(await page.locator('.message.assistant').count(), 0);
    checked('chainChanged clears private state and requires a new connection');
    await connect(page); await nav(page, 'settings');
    await page.locator('#settings-name').fill(originalSettings.name); await page.locator('#settings-budget').fill(String(originalSettings.dailyBudgetMicros / 1000000));
    await page.locator('#settings-form button[type="submit"]').click(); await page.waitForFunction(name => document.getElementById('agent-title').textContent === name, originalSettings.name);
    await nav(page, 'chat'); await capture(page, 'desktop-final');
    await page.locator('[data-action="theme"]').click(); assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark'); await capture(page, 'desktop-dark');
    await page.locator('[data-action="theme"]').click();
    await page.setViewportSize({ width: 1024, height: 600 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.locator('#sidebar [data-view="settings"]').scrollIntoViewIfNeeded();
    assert.ok(await page.locator('#sidebar [data-view="settings"]').evaluate(e => {
      const rect = e.getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= innerHeight;
    }), 'Short-window navigation must remain reachable by scrolling');
    await page.locator('#sidebar').evaluate(e => { e.scrollTop = 0; });
    await capture(page, 'short-workspace');
    checked('1024×600 workspace fits without horizontal overflow');
    await desktop.context.close();

    const mobile = await newContext({ width: 390, height: 844 }); const mp = mobile.page;
    await connect(mp); await capture(mp, 'mobile-workspace');
    const mobileJobsBeforeFormatting = (await api(mp, '/api/jobs')).value.jobs.length;
    await nav(mp, 'activity'); await mp.locator(`[data-action="open-job"][data-id="${job.id}"]`).click();
    await mp.locator('.receipt-dialog[open]').waitFor();
    const mobileReply = await formattedReply(mp, job, 'mobile');
    assert.equal((await api(mp, `/api/jobs/${job.id}`)).value.textSha256, job.textSha256);
    assert.equal((await api(mp, '/api/jobs')).value.jobs.length, mobileJobsBeforeFormatting);
    await capture(mp, 'mobile-markdown-reply');
    await mobileReply.locator('pre').evaluate(element => element.scrollIntoView({ block: 'start' }));
    await capture(mp, 'mobile-markdown-code-table'); await mp.keyboard.press('Escape'); await nav(mp, 'chat');
    checked('The same saved Markdown renders safely in a readable mobile receipt without page overflow or a new model run');
    await mp.locator('[data-action="sidebar"]').click(); assert.equal(await mp.locator('#workspace-content').evaluate(e => e.inert), true);
    const first = mp.locator('#sidebar a[href]').first(); await first.focus(); await mp.keyboard.press('Shift+Tab');
    assert.equal(await mp.evaluate(() => document.activeElement.closest('#sidebar') !== null), true);
    for (let i = 0; i < 30; i++) await mp.keyboard.press('Tab');
    assert.equal(await mp.evaluate(() => document.activeElement.closest('#sidebar') !== null), true);
    await capture(mp, 'mobile-navigation'); await mp.keyboard.press('Escape');
    assert.equal(await mp.locator('#workspace-content').evaluate(e => e.inert), false);
    checked('Mobile drawer traps keyboard focus, makes content inert and restores on Escape');
    await nav(mp, 'settings'); await mp.locator('#settings-name').fill('W'.repeat(80)); await mp.locator('#settings-form button[type="submit"]').click();
    await mp.waitForFunction(() => document.getElementById('agent-title').textContent.length === 80);
    const geometry = await mp.evaluate(() => {
      const title = document.getElementById('agent-title').getBoundingClientRect(), actions = document.querySelector('.header-actions').getBoundingClientRect();
      return { titleRight: title.right, actionsLeft: actions.left, actionsRight: actions.right, viewport: innerWidth, pageWidth: document.documentElement.scrollWidth };
    });
    assert.ok(geometry.titleRight <= geometry.actionsLeft + 1, JSON.stringify(geometry)); assert.ok(geometry.actionsRight <= geometry.viewport + 1); assert.equal(geometry.pageWidth, geometry.viewport);
    checked('80-character name keeps mobile header actions visible without overflow');
    await mp.locator('#settings-name').fill(originalSettings.name); await mp.locator('#settings-form button[type="submit"]').click(); await mp.waitForFunction(name => document.getElementById('agent-title').textContent === name, originalSettings.name);
    for (const view of ['chat', 'activity', 'skills', 'memory', 'usage', 'schedules', 'hosting', 'settings']) {
      await nav(mp, view); assert.ok(await mp.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Mobile overflow: ${view}`);
    }
    checked('All eight mobile views fit 390px width');
    await nav(mp, 'chat'); await mp.locator('[data-action="toggle-inspector"]').click(); await capture(mp, 'mobile-agent-details'); await mp.keyboard.press('Escape');
    await mp.locator('[data-action="theme"]').click(); assert.equal(await mp.locator('html').getAttribute('data-theme'), 'dark'); await capture(mp, 'mobile-dark');
    checked('Mobile agent details and theme switch remain usable');
    await mp.locator('[data-action="theme"]').click();
    await sidebarAction(mp, '.sidebar-section-heading [data-action="connect"]');
    await signStandalone(mp);
    await mp.reload(); await mp.locator('#composer-input').waitFor();
    assert.equal(await mp.locator('#composer-input').isDisabled(), true);
    assert.equal((await api(mp, '/api/workspace')).value.scope.kind, 'account');
    await sidebarAction(mp, '.sidebar-section-heading [data-action="connect"]', true);
    assert.equal(await mp.locator('#connect-mode').inputValue(), 'nft');
    await mp.keyboard.press('Escape');
    assert.ok(await mp.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await mp.locator('#workspace-content [data-action="connect"]').click();
    assert.equal(await mp.locator('#connect-mode').inputValue(), 'nft');
    await mp.locator('#connect-submit').click();
    await mp.locator('#token-picker').waitFor({ state: 'visible' });
    assert.equal((await signatureMessages(mp)).length, 0);
    await signPickedRoom(mp);
    assert.deepEqual((await signatureMessages(mp)).map(message => message.split('\n')[0]), ['Simple JEFF holder login']);
    assert.ok(await mp.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await capture(mp, 'mobile-account-to-nft');
    checked('Mobile restored account switches to signed Room35 through NFT controls without overflow or account signing');
    await mobile.context.close();
    assert.deepEqual(report.externalRequests, []); assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.consoleErrors, []);
    checked('Zero external page requests, JavaScript errors or console/CSP errors');
  } finally { await browser.close(); }
})().catch(error => { report.failures.push(error.stack); process.exitCode = 1; process.stderr.write(`${error.stack}\n`); })
  .finally(async () => { report.finishedAt = new Date().toISOString(); await fs.writeFile(path.join(output, 'browser-report.json'), JSON.stringify(report, null, 2)); process.stdout.write(`${report.checks.length} checks; ${report.failures.length} failures\n`); });
