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
  await page.locator('#standalone-mode').click();
  assert.equal(await page.locator('#token-field').isHidden(),true);
  const liveConfig = await page.evaluate(async () => (await fetch('/api/config')).json());
  assert.equal(await page.locator('#login').isDisabled(),liveConfig.standaloneAccounts !== true);
  await page.screenshot({path:resolve(output,'standalone-entry.png'),fullPage:true});
  await page.locator('#holder-mode').click();
  assert.equal(await page.locator('#token-field').isVisible(),true);
  checks.push('Standalone entry hides the NFT field and reflects its backend availability flag');
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
  let jobRequests = 0, retrievals = 0, logoutRequests = 0, revoked = false, pendingJob, pollEntered, jobCreated = false, unsaved = false, retrySaves = 0, failSave = false, hostingActive = true, checkoutEnabled = false, payments = 0, invoices = 0, activations = 0, confirming = false;
  const quote = { id, scope, chainId: 4663, token: '0x' + '44'.repeat(20), recipient: '0x' + '55'.repeat(20), amount: '1000000000000000001', periodDays: 30, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 900000).toISOString() };
  const hostStatus = () => ({ active: hostingActive, source: hostingActive ? 'pilot' : null, expiresAt: hostingActive ? new Date(Date.now() + 86400000).toISOString() : null, periodDays: 30, checkoutEnabled, token: quote.token, amount: checkoutEnabled ? quote.amount : null, recipient: checkoutEnabled ? quote.recipient : null, chainId: 4663, automaticRenewal: false });
  const challenge = 'Fixture holder login\nNo transaction authorization.';
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    let value;
    if (path === '/api/config') value = { chainId: scope.chainId, collection: scope.collection, modelConfigured: true, billingEnabled: checkoutEnabled, continuousHosting: true, toolsEnabled: false };
    else if (path === '/api/auth/challenge') { assert.deepEqual(request.postDataJSON(), { wallet: scope.owner, tokenId: '35' }); value = { nonce: 'test-only', message: challenge }; }
    else if (path === '/api/auth/verify') value = { token: 'aa'.repeat(32), scope, expiresAt: new Date(Date.now() + 3600000).toISOString() };
    else if (path === '/api/auth/logout') { logoutRequests++; value = { loggedOut: true }; }
    else {
      assert.equal(request.headers().authorization, 'Bearer ' + 'aa'.repeat(32));
      if (revoked) return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'JEFF_SESSION_REVOKED' }) });
      if (path === '/api/hosting') value = hostStatus();
      else if (path === '/api/hosting/invoice') { invoices++; assert.equal(checkoutEnabled,true); value=quote; }
      else if (path === '/api/hosting/activate') { activations++; assert.deepEqual(request.postDataJSON(),{invoiceId:id,transactionHash:'0x'+'bb'.repeat(32)}); if(confirming) return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'JEFF_PAYMENT_CONFIRMING'})});hostingActive=true;value=hostStatus(); }
      else if (path === '/api/jobs' && request.method() === 'POST') { jobRequests++; jobCreated = true; assert.equal(request.postDataJSON().objective, 'Fixture task'); return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify(running) }); }
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
        if (method === 'eth_accounts') return [wallet];
        if (method === 'eth_chainId') return '0x1237';
        if (method === 'eth_call') return '0x12';
        if (method === 'eth_sendTransaction') {window.__payments=(window.__payments||0)+1;window.__transfer=params[0];return '0x'+'bb'.repeat(32);}
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
  await page.locator('#hosting-status').filter({hasText:'Active'}).waitFor();
  assert.equal(await page.locator('#stage').textContent(),'HOSTED PILOT');
  assert.equal(await page.locator('#create-invoice').isHidden(),true);
  checks.push('Hosted flags replace local labels; pilot entitlement is visible and unconfigured checkout stays hidden');
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
  assert.notEqual(await page.evaluate(() => document.activeElement.id), 'result-heading');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.history-item').first().press('Enter');
  await page.waitForFunction(() => document.activeElement.id === 'result-heading');
  assert.equal(await page.locator('#result-text').textContent(), text);
  const resultHeading = await page.locator('#result-heading').boundingBox();
  assert.ok(resultHeading.y >= 0 && resultHeading.y + resultHeading.height <= 844);
  await page.screenshot({ path: resolve(output, 'retrieved-result-mobile.png'), fullPage: false });
  await page.locator('#job-id').fill(id); await page.locator('#job-id').press('Enter');
  await page.waitForFunction(() => document.activeElement.id === 'result-heading');
  assert.equal(jobRequests, 1);
  checks.push('Explicit history and job-ID retrieval focus the visible result on mobile; automatic reload leaves focus unchanged');
  await page.setViewportSize({ width: 1440, height: 1000 });
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
  hostingActive=false;await page.locator('#refresh-hosting').click();await page.locator('#hosting-status').filter({hasText:'Inactive'}).waitFor();
  assert.equal(await page.locator('#run').isDisabled(),true);assert.equal(await page.locator('#retrieve').isEnabled(),true);
  checks.push('Inactive hosting blocks new tasks while saved result retrieval remains available');
  checkoutEnabled=true;await page.reload();await page.getByText('Task complete. Your result is saved and can be retrieved later.',{exact:true}).waitFor();
  await page.locator('#create-invoice').click();await page.locator('#pay-invoice').filter({hasText:'Pay 1.000000000000000001 $CLOCKERS'}).waitFor();
  assert.equal(invoices,1);assert.equal(await page.evaluate(()=>window.__payments||0),0);
  confirming=true;await page.locator('#pay-invoice').click();await page.getByText('The payment is waiting for chain confirmations. Keep the same transaction reference; do not pay again.',{exact:true}).waitFor();
  assert.equal(await page.locator('#pay-invoice').isDisabled(),true);assert.equal(await page.locator('#hosting-status').textContent(),'Inactive');
  assert.equal(await page.evaluate(()=>window.__payments),1);
  await page.reload();await page.getByText('Task complete. Your result is saved and can be retrieved later.',{exact:true}).waitFor();
  assert.equal(await page.locator('#transaction-hash').inputValue(),'0x'+'bb'.repeat(32));
  confirming=false;await page.locator('#activate').click();await page.getByText('Payment verified. Hosting is active; the expiry above includes your new term.',{exact:true}).waitFor();
  assert.equal(activations,2);assert.equal(await page.locator('#hosting-status').textContent(),'Active');
  checks.push('Fixture invoice displays exact amount; one wallet transfer stays inactive until verified and its reference survives reload');
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
  const accountPage = await context.newPage();
  accountPage.on('pageerror',error=>errors.push(error.message));
  const accountScope = {kind:'account',chainId:4663,owner:scope.owner};
  const accountId = 'abcdefab-1234-1234-1234-123456789abc';
  const accountText = 'Private standalone account result';
  const accountRecord = {...record,id:accountId,scope:accountScope,objective:'Account task',text:accountText,textSha256:createHash('sha256').update(accountText).digest('hex')};
  let accountActive=false,accountRuns=0,accountRetrievals=0;
  const accountChallenge='Fixture standalone account login\nNo NFT required.';
  await accountPage.route('**/api/**',async route=>{
    const request=route.request(),path=new URL(request.url()).pathname;
    let value;
    if(path==='/api/config')value={chainId:4663,collection:scope.collection,modelConfigured:true,billingEnabled:false,continuousHosting:true,standaloneAccounts:true,toolsEnabled:false};
    else if(path==='/api/account/auth/challenge'){assert.deepEqual(request.postDataJSON(),{wallet:scope.owner});value={nonce:'account-only',message:accountChallenge};}
    else if(path==='/api/account/auth/verify')value={token:'cc'.repeat(32),scope:accountScope,expiresAt:new Date(Date.now()+3600000).toISOString()};
    else if(path==='/api/auth/logout')value={loggedOut:true};
    else{
      assert.equal(request.headers().authorization,'Bearer '+'cc'.repeat(32));
      if(path==='/api/hosting')value={...hostStatus(),active:accountActive,source:accountActive?'paid':null,expiresAt:accountActive?new Date(Date.now()+86400000).toISOString():null,checkoutEnabled:false};
      else if(path==='/api/jobs'&&request.method()==='GET')value={jobs:accountRuns?[accountRecord]:[]};
      else if(path==='/api/jobs'&&request.method()==='POST'){accountRuns++;assert.equal(request.postDataJSON().objective,'Account task');return route.fulfill({status:202,contentType:'application/json',body:JSON.stringify({...running,id:accountId,scope:accountScope,objective:'Account task'})});}
      else if(path===`/api/jobs/${accountId}`){accountRetrievals++;value=accountRecord;}
      else if(path===`/api/jobs/${id}`)value=record;
      else throw Error('Unexpected account route '+path);
    }
    return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(value)});
  });
  await accountPage.addInitScript(({wallet,challenge})=>{
    window.ethereum={async request({method,params}){
      if(method==='eth_requestAccounts')return[wallet];
      if(method==='personal_sign'){
        const bytes=Uint8Array.from(params[0].slice(2).match(/.{2}/g),byte=>parseInt(byte,16));
        if(new TextDecoder().decode(bytes)!==challenge)throw Error('Wrong account signature');
        return 'account-fixture-signature';
      }
      throw Error('Unexpected account wallet method');
    }};
  },{wallet:scope.owner,challenge:accountChallenge});
  await accountPage.goto(base+'/?mode=standalone');
  await accountPage.locator('#login').filter({hasText:'Connect wallet & sign in'}).waitFor();
  assert.equal(await accountPage.locator('#token-field').isHidden(),true);
  await accountPage.locator('#login').click();await accountPage.locator('#hosting-status').filter({hasText:'Inactive'}).waitFor();
  assert.equal(await accountPage.locator('#agent-name').textContent(),'My JEFF');
  assert.equal(await accountPage.locator('#epoch-field').isHidden(),true);
  assert.equal(await accountPage.locator('#run').isDisabled(),true);
  assert.equal(await accountPage.locator('#retrieve').isEnabled(),true);
  assert.equal(await accountPage.locator('.history-item').count(),0);
  checks.push('Standalone wallet signup signs the account challenge without any NFT input; inactive account cannot run tasks');
  accountActive=true;await accountPage.locator('#refresh-hosting').click();
  await accountPage.locator('#run').waitFor();
  await accountPage.locator('#objective').fill('Account task');await accountPage.locator('#run').click();
  await accountPage.getByText('Saved to workspace',{exact:true}).waitFor();
  await accountPage.reload();await accountPage.getByText('Task complete. Your result is saved and can be retrieved later.',{exact:true}).waitFor();
  assert.equal(accountRuns,1);assert.ok(accountRetrievals>=1);
  assert.equal(await accountPage.locator('#result-text').textContent(),accountText);
  assert.equal(await accountPage.locator('.history-item').count(),1);
  checks.push('Entitled standalone account runs and retrieves its own result without loading NFT history');
  await accountPage.setViewportSize({width:390,height:844});
  assert.equal(await accountPage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await accountPage.screenshot({path:resolve(output,'standalone-account-mobile.png'),fullPage:true});
  await accountPage.locator('#job-id').fill(id);await accountPage.locator('#retrieve').click();
  await accountPage.getByText('This result did not match the current workspace or pass the integrity check. It was withheld.',{exact:true}).waitFor();
  assert.equal(await accountPage.locator('#result').isHidden(),true);
  checks.push('Cross-scope NFT response is withheld from standalone account UI');
  await accountPage.locator('#logout').click();assert.equal(await accountPage.locator('#result-text').textContent(),'');
  assert.deepEqual(errors, []);
  await writeFile(resolve(output, 'browser-check.json'), JSON.stringify({ checkedAt: new Date().toISOString(), checks, browserErrors: errors, modelProof: 'Not tested: workflow checks use an explicit fixture', realHolderProof: 'Not tested: fixture wallet' }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, errors, evidence: output, modelProof: 'fixture only' }));
} finally { await context.close(); }
