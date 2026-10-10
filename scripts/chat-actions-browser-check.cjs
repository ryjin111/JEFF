const { chromium } = require('playwright-core');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { privateKeyToAccount } = require('viem/accounts');
const target = new URL(process.env.JEFF_QA_ORIGIN || 'http://127.0.0.1:8421');
if (!['http:', 'https:'].includes(target.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)
  || target.username || target.password || target.pathname !== '/' || target.search || target.hash) throw Error('Chat-action browser checks require a loopback fixture origin');
const base = target.origin;
const output = path.resolve(process.env.JEFF_QA_OUTPUT || path.join(__dirname, '..', 'evidence', 'release'));
const fixtureWallet = privateKeyToAccount('0x' + '12'.repeat(32)).address.toLowerCase(); // Public disposable preview key.
const report = { origin: base, fixture: true, providerCalls: false, liveHolderData: false,
  checks: [], pageErrors: [], consoleErrors: [], externalRequests: [], injectedFailures: [], failures: [] };
let browser, suppressNetworkErrors = false;
const check = label => { report.checks.push(label); process.stdout.write('PASS ' + label + '\n'); };
async function nav(page, view) {
  if (await page.locator('[data-action="sidebar"]').isVisible() && !await page.locator('#sidebar').evaluate(el => el.classList.contains('open'))) await page.locator('[data-action="sidebar"]').click();
  await page.locator('#sidebar [data-view="' + view + '"]').click();
  await page.waitForFunction(view => document.querySelector('#sidebar [data-view="' + view + '"]')?.getAttribute('aria-current') === 'page', view);
}
async function api(page, endpoint, method = 'GET', input) {
  return page.evaluate(async ({ endpoint, method, input }) => {
    const session = JSON.parse(sessionStorage.getItem('jeff:workspace:session:v1'));
    const response = await fetch(endpoint, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.token }, body: input === undefined ? undefined : JSON.stringify(input) });
    return { status: response.status, value: await response.json() };
  }, { endpoint, method, input });
}
async function signIn(page, token) {
  await page.locator('#runtime-banner [data-action="connect"]').click();
  await page.locator('#connect-submit').click();
  await page.locator('#token-picker').waitFor({ state: 'visible' });
  await page.locator('#connect-token').selectOption(token);
  await page.locator('#connect-submit').click();
  await page.waitForFunction(() => !document.getElementById('connect-dialog').open);
  if (!await page.locator('#composer-input').count()) await nav(page, 'chat');
  await page.locator('#composer-input').waitFor();
}
async function send(page, objective) {
  await page.locator('#composer-input').fill(objective);
  const responsePromise = page.waitForResponse(r => new URL(r.url()).pathname === '/api/jobs' && r.request().method() === 'POST');
  await page.locator('#composer-form button[type="submit"]').click();
  const response = await responsePromise;
  assert.equal(response.status(), 202);
  const job = await response.json();
  const message = page.locator('#chat-feed .message.assistant[data-job-id="' + job.id + '"]');
  await message.locator('.pill').filter({ hasText: /^Saved$/ }).waitFor({ timeout: 20000 });
  return { id: job.id, message, card: message.locator('.chat-action-card') };
}
async function refresh(page) { await page.locator('[data-action="refresh"]').first().click(); }
async function geometry(page) {
  const measured = await page.evaluate(() => ({ viewport: innerWidth, page: document.documentElement.scrollWidth,
    content: document.getElementById('workspace-content').clientWidth, scroll: document.getElementById('workspace-content').scrollWidth }));
  assert.ok(measured.page <= measured.viewport && measured.scroll <= measured.content + 1, JSON.stringify(measured));
}
(async () => {
  try {
    await fs.mkdir(output, { recursive: true });
    const configResponse = await fetch(base + '/api/config', { redirect: 'error' });
    assert.equal(configResponse.ok, true);
    const config = await configResponse.json();
    assert.equal(config.fixture, true, 'Refuse nonfixture signed flows');
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', timezoneId: 'Asia/Taipei' });
    const page = await context.newPage();
    page.on('pageerror', e => report.pageErrors.push(e.message));
    page.on('console', m => {
      if (m.type() === 'error' && !/^Failed to load resource: the server responded with a status of 401/.test(m.text())) {
        if (suppressNetworkErrors && /Failed to load resource|ERR_FAILED|503|409/.test(m.text())) report.injectedFailures.push(m.text());
        else report.consoleErrors.push(m.text());
      }
    });
    const actionPosts = [], jobPosts = [];
    page.on('request', r => {
      const route = new URL(r.url()).pathname;
      if (r.method() === 'POST' && route.startsWith('/api/chat/actions/')) actionPosts.push({ route, body: r.postDataJSON() });
      if (r.method() === 'POST' && route === '/api/jobs') jobPosts.push(r.postDataJSON());
    });
    await page.route('**/*', route => {
      const url = route.request().url();
      if (/^https?:/.test(url) && new URL(url).origin !== base) { report.externalRequests.push(url); return route.abort(); }
      return route.continue();
    });
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.locator('#runtime-label').filter({ hasText: 'DEVELOPMENT FIXTURE' }).waitFor();
    assert.deepEqual(await page.evaluate(async () => (await window.ethereum.request({ method: 'eth_accounts' })).map(value => value.toLowerCase())), [fixtureWallet], 'Only the public disposable preview wallet may sign');
    await signIn(page, '35');

    const memory = await send(page, 'Fixture action: memory draft');
    await memory.card.locator('[data-action="apply-chat-action"]').waitFor();
    assert.equal(await memory.card.getAttribute('data-action-status'), 'pending');
    assert.match(await memory.card.textContent(), /Use short replies\.\n<img src=x onerror=window.qaActionInjected=true>/);
    assert.equal(await memory.card.locator('img,script').count(), 0);
    assert.equal(await page.evaluate(() => window.qaActionInjected), undefined);
    let state = (await api(page, '/api/workspace/state')).value;
    assert.equal(state.workspace.memories.length, 0);
    assert.equal(jobPosts.at(-1).timeZone, 'Asia/Taipei');
    check('Pending memory shows exact safe text and sends browser timezone; no note exists before confirmation');

    await page.locator('#composer-input').fill('A draft to keep while saving.');
    const selected = await page.locator('#conversation-select').inputValue();
    await memory.card.locator('[data-action="apply-chat-action"]').evaluate(el => { el.click(); el.click(); });
    await memory.card.filter({ has: page.locator('h3', { hasText: /^Saved to memory$/ }) }).waitFor();
    assert.equal(actionPosts.filter(p => p.route.includes(memory.id)).length, 1);
    assert.equal(await page.locator('#composer-input').inputValue(), 'A draft to keep while saving.');
    assert.equal(await page.locator('#conversation-select').inputValue(), selected);
    state = (await api(page, '/api/workspace/state')).value;
    assert.equal(state.workspace.memories.length, 1);
    assert.equal(state.workspace.memories[0].text, state.workspace.jobBindings[memory.id].action.parameters.text);
    check('Memory confirmation saves once despite duplicate clicks and preserves conversation selection and composer draft');

    await page.reload();
    await memory.card.locator('[data-action="open-chat-action"]').waitFor();
    assert.equal(await memory.card.getAttribute('data-action-status'), 'applied');
    await memory.card.locator('[data-action="open-chat-action"]').click();
    await page.locator('.memory-card').filter({ hasText: 'A saved preference' }).waitFor();
    await nav(page, 'chat');
    check('Applied memory card survives reload and opens the saved Memory view');

    const literal = await send(page, 'Remember this: My project verification word is blue lantern.');
    await literal.card.locator('h3', { hasText: /^Saved to memory$/ }).waitFor();
    assert.equal(await literal.card.locator('[data-action="apply-chat-action"]').count(), 0);
    assert.equal(actionPosts.filter(p => p.route.includes(literal.id)).length, 0);
    state = (await api(page, '/api/workspace/state')).value;
    assert.equal(state.workspace.memories.filter(note => note.text === 'My project verification word is blue lantern.').length, 1);
    await page.reload();
    await page.locator('#composer-input').waitFor();
    await page.locator('[data-action="new-session"]').first().click();
    const recalled = await send(page, 'Fixture action: recall memory');
    assert.match(await recalled.message.locator('.message-markdown').textContent(), /My project verification word is blue lantern/);
    assert.equal(await recalled.card.count(), 0);
    check('Literal current-user Remember this saves automatically once and supplies the note to a fresh conversation after reload');

    const schedule = await send(page, 'Fixture action: schedule draft');
    await schedule.card.locator('input[type="checkbox"]').waitFor();
    assert.equal(await schedule.card.locator('input').isChecked(), false);
    assert.equal(await schedule.card.locator('[data-action="apply-chat-action"]').isDisabled(), true);
    assert.match(await schedule.card.textContent(), /Every 60 minutes after the previous run completes/);
    assert.match(await schedule.card.textContent(), /Maximum runs2/);
    assert.match(await schedule.card.textContent(), /Time zoneAsia\/Taipei/);
    assert.match(await schedule.card.textContent(), /DeliverySaved in this workspace/);
    assert.equal(await schedule.card.locator('img,script').count(), 0);
    assert.equal((await api(page, '/api/schedules')).value.schedules.length, 0);
    check('Schedule draft shows task, actual start, interval, limit, expiry, timezone and workspace delivery; unchecked consent blocks creation');
    await page.screenshot({ path: path.join(output, 'memory-and-schedule-chat.png'), fullPage: true });

    await schedule.card.locator('input').check();
    await page.reload();
    await schedule.card.locator('input').waitFor();
    assert.equal(await schedule.card.locator('input').isChecked(), false);
    assert.equal(await schedule.card.getAttribute('data-action-status'), 'pending');
    check('Pending schedule survives reload but consent must be given again');
    await page.locator('#composer-input').fill('Another preserved draft.');
    await schedule.card.locator('input').check();
    await schedule.card.locator('[data-action="apply-chat-action"]').evaluate(el => { el.click(); el.click(); });
    await schedule.card.locator('h3', { hasText: /^Scheduled$/ }).waitFor();
    assert.equal(actionPosts.filter(p => p.route.includes(schedule.id)).length, 1);
    const schedules = (await api(page, '/api/schedules')).value.schedules;
    assert.equal(schedules.length, 1);
    state = (await api(page, '/api/workspace/state')).value;
    assert.equal(schedules[0].firstRunAt, state.workspace.jobBindings[schedule.id].action.parameters.firstRunAt);
    assert.equal(await page.locator('#composer-input').inputValue(), 'Another preserved draft.');
    await schedule.card.locator('[data-action="open-chat-action"]').click();
    await page.locator('.schedule-card').filter({ hasText: 'Prepare a brief project update.' }).waitFor();
    await nav(page, 'chat');
    check('Explicit schedule authorization creates exactly one immutable schedule and opens Scheduled work without losing draft');
    let responsibility = page.locator('.personal-context details.personal-context-section').first();
    assert.equal(await responsibility.evaluate(el => el.open), true);
    assert.match(await responsibility.textContent(), /Next check-in:.*Asia\/Taipei/);
    assert.match(await responsibility.textContent(), /0\/2 runs used/);
    assert.equal(await responsibility.locator('img').count(), 0);
    await responsibility.locator('summary').click();
    await refresh(page);
    responsibility = page.locator('.personal-context details.personal-context-section').first();
    assert.equal(await responsibility.evaluate(el => el.open), false);
    await responsibility.locator('summary').click();
    await refresh(page);
    assert.equal(await page.locator('.personal-context details.personal-context-section').first().evaluate(el => el.open), true);
    await page.setViewportSize({ width: 390, height: 844 });
    await geometry(page);
    await page.screenshot({ path: path.join(output, 'personal-context-mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    check('Responsibility shows safe task text, local next check-in and run cap; explicit expansion survives refresh and fits mobile');

    const dismissed = await send(page, 'Fixture action: one-off draft');
    assert.match(await dismissed.card.textContent(), /One run/);
    assert.match(await dismissed.card.textContent(), /10 minutes after authorization/);
    await dismissed.card.locator('[data-action="dismiss-chat-action"]').click();
    await dismissed.card.locator('h3', { hasText: /^Schedule suggestion dismissed$/ }).waitFor();
    await page.reload();
    await dismissed.card.locator('h3', { hasText: /^Schedule suggestion dismissed$/ }).waitFor();
    assert.equal((await api(page, '/api/schedules')).value.schedules.length, 1);
    check('One-off timing is explicit and dismissal persists without creating another schedule');

    const uncertain = await send(page, 'Fixture action: memory draft');
    suppressNetworkErrors = true;
    await page.route('**/api/chat/actions/' + uncertain.id + '/apply', async route => {
      const response = await route.fetch(); assert.equal(response.status(), 200); await route.abort('failed');
    });
    await uncertain.card.locator('[data-action="apply-chat-action"]').click();
    await uncertain.card.locator('h3', { hasText: /^Saved to memory$/ }).waitFor({ timeout: 12000 });
    assert.equal(actionPosts.filter(p => p.route.includes(uncertain.id)).length, 1);
    await page.unroute('**/api/chat/actions/' + uncertain.id + '/apply');
    suppressNetworkErrors = false;
    check('Lost apply response recovers persisted success with GET and never replays the POST');

    const accepted = await send(page, 'Fixture action: memory draft');
    await page.locator('#composer-input').fill('Keep this during refresh failure.');
    await nav(page, 'activity');
    await page.locator('[data-action="open-job"][data-id="' + accepted.id + '"]').click();
    const acceptedDialog = page.locator('.receipt-dialog[open]');
    suppressNetworkErrors = true;
    await page.route('**/api/workspace/state', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'JEFF_SERVICE_UNAVAILABLE' }) }));
    await acceptedDialog.locator('[data-action="apply-chat-action"]').click();
    await page.locator('#workspace-notice').filter({ hasText: /accepted, but its saved status could not refresh/ }).waitFor();
    assert.equal(await acceptedDialog.locator('[data-action="apply-chat-action"]').isDisabled(), true);
    await acceptedDialog.locator('[data-action="check-chat-action"]').waitFor();
    assert.equal(actionPosts.filter(p => p.route.includes(accepted.id)).length, 1);
    await page.unroute('**/api/workspace/state');
    await acceptedDialog.locator('[data-action="check-chat-action"]').click();
    await acceptedDialog.locator('h3', { hasText: /^Saved to memory$/ }).waitFor();
    await acceptedDialog.locator('[data-action="close-dialog"]').click();
    await nav(page, 'chat');
    await accepted.card.locator('h3', { hasText: /^Saved to memory$/ }).waitFor();
    assert.equal(await page.locator('#composer-input').inputValue(), 'Keep this during refresh failure.');
    suppressNetworkErrors = false;
    assert.equal(actionPosts.filter(p => p.route.includes(accepted.id)).length, 1);
    check('Activity modal recovers an accepted action through its inline GET-only status check without repeating its POST or losing the draft');

    const conflicted = await send(page, 'Fixture action: memory draft');
    suppressNetworkErrors = true;
    await page.route('**/api/chat/actions/' + conflicted.id + '/apply', async route => {
      const applied = await route.fetch(); assert.equal(applied.status(), 200);
      await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'JEFF_WORKSPACE_CONFLICT' }) });
    });
    await conflicted.card.locator('[data-action="apply-chat-action"]').click();
    await conflicted.card.locator('h3', { hasText: /^Saved to memory$/ }).waitFor();
    assert.equal(await page.locator('#workspace-notice').textContent(), 'Memory saved.');
    assert.equal(actionPosts.filter(p => p.route.includes(conflicted.id)).length, 1);
    await page.unroute('**/api/chat/actions/' + conflicted.id + '/apply');
    suppressNetworkErrors = false;
    check('A concurrent conflict reconciles the actual saved action with GET and removes stale Pending controls without settings-conflict wording');

    const noRoom = await send(page, 'Fixture action: one-off draft');
    state = (await api(page, '/api/workspace/state')).value;
    await page.clock.setFixedTime(new Date(Date.parse(state.workspace.jobBindings[noRoom.id].action.parameters.expiresAt) - 5 * 60000));
    await refresh(page);
    await noRoom.card.locator('.preview-info', { hasText: /proposal has expired/ }).waitFor();
    assert.equal(await noRoom.card.locator('[data-action="apply-chat-action"]').isDisabled(), true);
    assert.match(await noRoom.card.textContent(), /proposal has expired/);
    await page.clock.setFixedTime(new Date());
    await refresh(page);
    const missedStart = await send(page, 'Fixture action: schedule draft');
    state = (await api(page, '/api/workspace/state')).value;
    await page.clock.setFixedTime(new Date(Date.parse(state.workspace.jobBindings[missedStart.id].action.parameters.firstRunAt) + 60000));
    await refresh(page);
    await missedStart.card.locator('.preview-info', { hasText: /proposal has expired/ }).waitFor();
    assert.equal(await missedStart.card.locator('[data-action="apply-chat-action"]').isDisabled(), true);
    assert.match(await missedStart.card.textContent(), /proposal has expired/);
    assert.equal(actionPosts.filter(p => p.route.includes(noRoom.id) || p.route.includes(missedStart.id)).length, 0);
    await page.clock.setFixedTime(new Date());
    await refresh(page);
    check('Missed absolute starts and relative first runs that no longer fit before expiry cannot be authorized');

    assert.equal((await api(page, '/api/workspace/settings', 'PATCH', { paused: true })).status, 200);
    await refresh(page);
    await missedStart.card.locator('.preview-info', { hasText: /This agent is paused/ }).waitFor();
    assert.equal(await missedStart.card.locator('[data-action="apply-chat-action"]').isDisabled(), true);
    assert.equal((await api(page, '/api/workspace/settings', 'PATCH', { paused: false })).status, 200);
    await refresh(page);
    for (const [configuration, explanation] of [
      [{ restoreBlocked: true }, /restored storage is verified/],
      [{ modelConfigured: false }, /model connection is unavailable/],
      [{ schedulesEnabled: false }, /Scheduled work is currently unavailable/],
    ]) {
      await page.route('**/api/config', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...config, ...configuration }) }));
      await page.reload();
      await missedStart.card.locator('.preview-info', { hasText: explanation }).waitFor();
      assert.equal(await missedStart.card.locator('[data-action="apply-chat-action"]').isDisabled(), true);
      await page.unroute('**/api/config');
    }
    await page.reload();
    await missedStart.card.locator('[data-action="apply-chat-action"]').waitFor();
    check('Disabled authorization explains paused agents, restore verification, missing models and disabled scheduling beside its controls');

    await nav(page, 'activity');
    await page.locator('[data-action="open-job"][data-id="' + missedStart.id + '"]').click();
    const dialog = page.locator('.receipt-dialog[open]');
    assert.equal(await dialog.locator('[data-action="apply-chat-action"]').isDisabled(), true);
    await dialog.locator('[data-chat-action-consent]').check();
    await page.waitForFunction(() => !document.querySelector('.receipt-dialog[open] [data-action="apply-chat-action"]')?.disabled);
    await dialog.locator('[data-action="dismiss-chat-action"]').click();
    await dialog.locator('h3', { hasText: /^Schedule suggestion dismissed$/ }).waitFor();
    await dialog.locator('[data-action="close-dialog"]').click();
    await nav(page, 'chat');
    check('Activity run dialog refreshes consent and saved action status without stale authorization controls');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#chat-feed').evaluate(el => { el.scrollTop = el.scrollHeight; });
    await geometry(page);
    await page.screenshot({ path: path.join(output, 'chat-actions-mobile.png'), fullPage: true });
    check('Memory and schedule action cards fit a 390px mobile viewport without horizontal overflow');

    await page.setViewportSize({ width: 1440, height: 1000 });
    await nav(page, 'settings');
    await page.locator('#workspace-content [data-action="logout"]').click();
    assert.equal(await page.locator('.chat-action-card').count(), 0);
    await signIn(page, '128');
    assert.equal(await page.locator('.chat-action-card').count(), 0);
    assert.equal((await api(page, '/api/workspace/state')).value.workspace.memories.length, 0);
    check('Sign-out clears private cards and Room #128 receives no Room #35 proposals or saved memory');

    assert.deepEqual(actionPosts.map(p => p.body), actionPosts.map(() => ({})));
    assert.deepEqual(report.pageErrors, []);
    assert.deepEqual(report.consoleErrors, []);
    assert.deepEqual(report.externalRequests, []);
    check('All confirmations send only an empty body; no JavaScript errors, injected elements or external requests');
  } catch (error) { report.failures.push(error.stack || error.message); process.exitCode = 1; }
  finally {
    if (browser) await browser.close();
    report.finishedAt = new Date().toISOString();
    await fs.mkdir(output, { recursive: true });
    await fs.writeFile(path.join(output, 'chat-actions-browser.json'), JSON.stringify(report, null, 2));
    if (report.failures.length) process.stderr.write(report.failures.join('\n') + '\n');
  }
})();
