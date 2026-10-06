import { chromium } from 'file:///D:/agentmanagerworks/AI/node_modules/playwright/index.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const output = resolve('evidence/frontend');
await mkdir(resolve(output, 'browser-temp'), { recursive: true });
const context = await chromium.launchPersistentContext(resolve(output, 'browser-profile'), {
  executablePath: 'D:/agentmanagerworks/_playwright-cache/chromium-1223/chrome-win64/chrome.exe',
  headless: true, viewport: { width: 1440, height: 1000 },
  env: { ...process.env, TEMP: resolve(output, 'browser-temp'), TMP: resolve(output, 'browser-temp') },
});
const page = context.pages()[0] || await context.newPage();
const errors = []; page.on('pageerror', error => errors.push(error.message));
const checks = [];
const base = 'http://127.0.0.1:8788';
try {
  await page.goto(base);
  await page.locator('#model-status').filter({ hasText: /Model connection (needed|configured)/ }).waitFor();
  assert.equal(await page.locator('#run').isDisabled(), true);
  assert.equal(await page.locator('#login').isEnabled(), true);
  await page.screenshot({ path: resolve(output, 'live-desktop.png'), fullPage: true });
  checks.push('Live service readiness is displayed; signed-out tasks are disabled and login is available');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.screenshot({ path: resolve(output, 'live-mobile.png'), fullPage: true });
  checks.push('390px page has no horizontal overflow');
  await page.setViewportSize({ width: 1440, height: 1000 });

  const scope = { chainId: 4663, collection: '0x' + '33'.repeat(20), tokenId: '35', owner: '0x' + '11'.repeat(20), ownerEpoch: 0 };
  const id = '12345678-1234-1234-1234-123456789abc';
  const text = '<script>window.injected = true</script>\nFixture checklist: 1. Review access. 2. Save a useful result.';
  const record = { schema: 'jeff-openclaw-job-v1', id, scope, status: 'completed', objective: 'Fixture task', text,
    textSha256: createHash('sha256').update(text).digest('hex'), saved: true, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), model: 'frontend-test-fixture', externalActionsAuthorized: false };
  const running = { schema: record.schema, id, scope, objective: record.objective, status: 'running', saved: true, startedAt: record.startedAt, externalActionsAuthorized: false };
  let jobRequests = 0, retrievals = 0, logoutRequests = 0, revoked = false, pendingJob, pollEntered, jobCreated = false, unsaved = false, retrySaves = 0, failSave = false;
  const challenge = 'Fixture holder login\nNo transaction authorization.';
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    let value;
    if (path === '/api/config') value = { chainId: scope.chainId, collection: scope.collection, modelConfigured: true, billingEnabled: false, continuousHosting: false, toolsEnabled: false };
    else if (path === '/api/auth/challenge') { assert.deepEqual(request.postDataJSON(), { wallet: scope.owner, tokenId: '35' }); value = { nonce: 'test-only', message: challenge }; }
    else if (path === '/api/auth/verify') value = { token: 'aa'.repeat(32), scope, expiresAt: new Date(Date.now() + 3600000).toISOString() };
    else if (path === '/api/auth/logout') { logoutRequests++; value = { loggedOut: true }; }
    else {
      assert.equal(request.headers().authorization, 'Bearer ' + 'aa'.repeat(32));
      if (revoked) return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'JEFF_SESSION_REVOKED' }) });
      if (path === '/api/jobs' && request.method() === 'POST') { jobRequests++; jobCreated = true; assert.equal(request.postDataJSON().objective, 'Fixture task'); return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify(running) }); }
      else if (path === '/api/jobs') value = { jobs: jobCreated ? [unsaved ? { ...record, status: 'completed_unsaved', saved: false } : record] : [] };
      else if (path === `/api/jobs/${id}`) { retrievals++; if (pendingJob) { pollEntered?.(); await pendingJob; } value = unsaved ? { ...record, status: 'completed_unsaved', saved: false } : record; }
      else if (path === `/api/jobs/${id}/retry-save`) { retrySaves++; if (failSave) return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'JEFF_SERVICE_UNAVAILABLE'})}); unsaved = false; value = record; }
      else throw Error('Unexpected route: ' + path);
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) }).catch(error => { if (!/closed|abort/i.test(error.message)) throw error; });
  });
  await page.addInitScript(({ wallet, challengeText }) => {
    const events = {};
    window.__walletEvents = events;
    window.ethereum = {
      on(name, handler) { events[name] = handler; },
      removeListener(name) { delete events[name]; },
      async request({ method, params }) {
        if (method === 'eth_requestAccounts') { events.accountsChanged?.([wallet]); return [wallet]; }
        if (method === 'personal_sign') {
          const bytes = Uint8Array.from(params[0].slice(2).match(/.{2}/g), byte => parseInt(byte, 16));
          if (new TextDecoder().decode(bytes) !== challengeText || params[1] !== wallet) throw Error('Wrong login signature input');
          return 'test-only-signature';
        }
        throw Error('Unexpected wallet method');
      },
    };
  }, { wallet: scope.owner, challengeText: challenge });
  await page.reload();
  await page.locator('#token-id').fill('35'); await page.locator('#login').click();
  await page.locator('#logout').waitFor();
  await page.locator('#objective').fill('Fixture task'); await page.locator('#run').click();
  await page.getByText('Saved to workspace', { exact: true }).waitFor();
  assert.equal(await page.locator('#result-text script').count(), 0);
  assert.equal(await page.evaluate(() => window.injected), undefined);
  assert.equal(await page.evaluate(() => Object.values(localStorage).some(value => value.includes('Fixture checklist'))), false);
  assert.equal(jobRequests, 1);
  checks.push('Fixture wallet signs exact challenge; 202 job ID polls to saved output rendered as plain text');
  await page.screenshot({ path: resolve(output, 'fixture-result-desktop.png'), fullPage: true });
  await page.evaluate(() => localStorage.clear());
  await page.reload(); await page.getByText('Task complete. Your result is saved and can be retrieved later.', { exact: true }).waitFor();
  assert.ok(retrievals >= 1); assert.equal(jobRequests, 1);
  checks.push('Reload discovers the durable result through server history even without a browser job index');
  unsaved = true; await page.locator('#refresh').click();
  await page.getByText('Not saved yet', { exact: true }).waitFor();
  assert.equal(await page.locator('#result-text').textContent(), text);
  failSave = true; await page.locator('#retry-save').click();
  await page.getByText('The service is unavailable. Check the connection before trying again.', { exact: true }).waitFor();
  assert.equal(await page.locator('#result-text').textContent(), text);
  assert.equal(await page.locator('#saved-state').textContent(), 'Not saved yet');
  failSave = false;
  await page.locator('#retry-save').click(); await page.getByText('Saved to workspace', { exact: true }).waitFor();
  assert.equal(jobRequests, 1); assert.equal(retrySaves, 2);
  checks.push('Failed save retry preserves output; a successful retry persists it without another model request');
  revoked = true; await page.locator('#refresh').click();
  await page.getByText('NFT ownership changed. Sign in again to access your current workspace.', { exact: true }).waitFor();
  assert.equal(await page.locator('#result').isHidden(), true);
  assert.equal(await page.locator('#result-text').textContent(), '');
  assert.equal(await page.evaluate(() => sessionStorage.getItem('simple-jeff:session:v1')), null);
  checks.push('Transfer revocation clears session and private output');
  revoked = false;
  await page.locator('#token-id').fill('35'); await page.locator('#login').click();
  await page.getByText('Task complete. Your result is saved and can be retrieved later.', { exact: true }).waitFor();
  let release; pendingJob = new Promise(resolveJob => { release = resolveJob; });
  const entered = new Promise(resolveEntered => { pollEntered = resolveEntered; });
  await page.locator('#objective').fill('Fixture task'); await page.locator('#run').click();
  await page.getByText(`JEFF is working. Job ID: ${id}. You can return to this task from server history.`, { exact: true }).waitFor();
  await entered;
  await page.locator('#logout').click(); release();
  await page.waitForTimeout(100);
  assert.equal(await page.locator('#result').isHidden(), true);
  assert.equal(await page.locator('#result-text').textContent(), '');
  assert.ok(logoutRequests >= 1);
  checks.push('Logout during a job clears private UI and suppresses a late response');
  assert.deepEqual(errors, []);
  await writeFile(resolve(output, 'browser-check.json'), JSON.stringify({ checkedAt: new Date().toISOString(), checks, browserErrors: errors, modelProof: 'Not tested: workflow checks use an explicit fixture', realHolderProof: 'Not tested: fixture wallet' }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, errors, evidence: output, modelProof: 'fixture only' }));
} finally { await context.close(); }
