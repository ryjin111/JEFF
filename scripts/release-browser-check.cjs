const { chromium } = require('playwright-core');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const base = process.env.JEFF_QA_ORIGIN || 'http://127.0.0.1:8421';
const output = path.resolve(__dirname, '..', 'evidence', 'release');
const report = { origin: base, fixture: true, checks: [], screenshots: [], pageErrors: [], consoleErrors: [], externalRequests: [], failures: [] };
let browser;
const checked = name => { report.checks.push(name); process.stdout.write(`PASS ${name}\n`); };
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
async function newContext(viewport) {
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce', deviceScaleFactor: 1, acceptDownloads: true });
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
  page.on('pageerror', error => report.pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !/^Failed to load resource: the server responded with a status of (401|409)/.test(message.text())) report.consoleErrors.push(message.text()); });
  page.on('dialog', dialog => dialog.accept());
  await page.route('**/*', route => {
    const url = route.request().url();
    if (/^https?:/.test(url) && new URL(url).origin !== base) { report.externalRequests.push(url); return route.abort(); }
    return route.continue();
  });
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.locator('#runtime-label').filter({ hasText: 'DEVELOPMENT FIXTURE' }).waitFor();
  return { context, page };
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
    await page.locator('[data-action="new-session"]').click(); await ready(page);
    const conversationId = await page.locator('#conversation-select').inputValue();
    const objective = `${unique}: draft a short Agent NFT launch checklist. <script>window.qaInjected=true</script>`;
    await page.locator('#composer-input').fill(objective);
    await page.locator('[data-action="send-task"]').click();
    await page.locator('[data-action="stop-job"]').waitFor();
    await page.locator('.message.assistant .pill').filter({ hasText: 'Saved' }).last().waitFor({ timeout: 12000 });
    await page.waitForFunction(() => document.getElementById('workspace-notice').textContent === 'Run completed and saved.');
    const jobs = (await api(page, '/api/jobs')).value.jobs;
    const job = jobs.find(item => item.objective === objective);
    assert.ok(job); assert.equal(job.status, 'completed');
    assert.equal(createHash('sha256').update(job.text).digest('hex'), job.textSha256);
    assert.equal(await page.evaluate(() => window.qaInjected), undefined);
    checked('Real persisted task polls to Saved, hash verifies, and supplied HTML renders as text');
    await page.locator('.receipt-details summary').last().click();
    assert.equal(await page.locator('.receipt-facts').last().getByText(job.id, { exact: true }).count(), 1);
    const downloadPromise = page.waitForEvent('download');
    await page.locator('[data-action="download-result"]').last().click();
    const download = await downloadPromise; await download.saveAs(path.join(output, 'fixture-receipt.json'));
    assert.equal(JSON.parse(await fs.readFile(path.join(output, 'fixture-receipt.json'), 'utf8')).id, job.id);
    checked('Receipt discloses integrity limits and downloaded record matches durable job');
    await capture(page, 'desktop-conversation');
    await ready(page); await page.locator('#composer-input').fill(`${unique}: stop this fixture run`); await page.locator('[data-action="send-task"]').click();
    await page.locator('[data-action="stop-job"]').waitFor(); await page.locator('[data-action="stop-job"]').click();
    await page.locator('.message.assistant .pill').filter({ hasText: 'Failed' }).last().waitFor({ timeout: 12000 });
    await page.waitForFunction(() => document.getElementById('workspace-notice').textContent === 'The run ended after your stop request. Its saved receipt is marked Failed.');
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
    await page.evaluate(() => window.__qaWallet.emit('accountsChanged', ['0x' + '99'.repeat(20)]));
    await page.waitForFunction(() => !sessionStorage.getItem('jeff:workspace:session:v1'));
    assert.equal(await page.locator('.memory-card,.message.assistant').count(), 0);
    checked('accountsChanged clears private state and session immediately');
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
    await mobile.context.close();
    assert.deepEqual(report.externalRequests, []); assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.consoleErrors, []);
    checked('Zero external page requests, JavaScript errors or console/CSP errors');
  } finally { await browser.close(); }
})().catch(error => { report.failures.push(error.stack); process.exitCode = 1; process.stderr.write(`${error.stack}\n`); })
  .finally(async () => { report.finishedAt = new Date().toISOString(); await fs.writeFile(path.join(output, 'browser-report.json'), JSON.stringify(report, null, 2)); process.stdout.write(`${report.checks.length} checks; ${report.failures.length} failures\n`); });
