import { chromium } from 'file:///D:/agentmanagerworks/AI/node_modules/playwright/index.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { scopeKey } from '../public/client.js';
const output=resolve('evidence/free-pass');
await mkdir(resolve(output,'browser-temp'),{recursive:true});
const context=await chromium.launchPersistentContext(resolve(output,'state-profile'),{
  executablePath:'D:/agentmanagerworks/_playwright-cache/chromium-1223/chrome-win64/chrome.exe',headless:true,
  viewport:{width:1440,height:1000},env:{...process.env,TEMP:resolve(output,'browser-temp'),TMP:resolve(output,'browser-temp')}
});
const checks=[],errors=[];
const base='http://127.0.0.1:8788';
try{
  const page=context.pages()[0]||await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  let scope={chainId:4663,collection:'0x'+'33'.repeat(20),tokenId:'35',owner:'0x'+'11'.repeat(20),ownerEpoch:0};
  const now=Date.now(),termStart=new Date(now-10*86400000).toISOString(),termEnd=new Date(now+20*86400000).toISOString();
  let totalEnd=new Date(now+50*86400000).toISOString(),active=true,source='paid',used=35;
  let pass={state:'available',periodDays:30,tasksIncluded:100,startsAt:totalEnd,expiresAt:new Date(now+80*86400000).toISOString(),consumedAt:null};
  let statusFailure=false,postMode='success',postCount=0,releasePost,postEntered,pendingPost,releaseStatus,statusEntered,pendingStatus;
  const text='Saved work stays visible while applying the free month.';
  const id='12345678-1234-1234-1234-123456789abc';
  const record=()=>({schema:'jeff-openclaw-job-v1',id,scope,status:'completed',objective:'Saved task',text,textSha256:createHash('sha256').update(text).digest('hex'),saved:true,finishedAt:new Date(now).toISOString(),model:'pass-ui-fixture',externalActionsAuthorized:false});
  const hosting=()=>({active,source:active?source:null,expiresAt:active?totalEnd:null,periodDays:30,checkoutEnabled:false,token:'0x'+'44'.repeat(20),amount:null,plan:{usdCents:1000,currency:'USD',periodDays:30,tasksIncluded:100},recipient:null,chainId:4663,automaticRenewal:false,
    usage:{unit:'tasks',limit:100,used,remaining:active?100-used:0,periodStartsAt:active?(source==='free-pass'?pass.startsAt:termStart):null,resetsAt:active?(source==='free-pass'?pass.expiresAt:termEnd):null,source:active?source:null,hourlyLimit:10,hourlyRemaining:10,hourlyResetsAt:null},
    freePass:scope.kind==='account'?null:{...pass}});
  const consume=()=>{pass={...pass,state:'consumed',consumedAt:new Date().toISOString()};totalEnd=pass.expiresAt;if(!active){active=true;source='free-pass';used=0;}};
  await page.route('**/api/**',async route=>{
    const request=route.request(),path=new URL(request.url()).pathname;
    let value;
    if(path==='/api/config')value={chainId:4663,collection:scope.collection||'0x'+'33'.repeat(20),modelConfigured:true,billingEnabled:false,continuousHosting:true,standaloneAccounts:true,toolsEnabled:false,plan:{usdCents:1000,currency:'USD',periodDays:30,tasksIncluded:100}};
    else if(path==='/api/auth/logout')value={loggedOut:true};
    else{
      assert.equal(request.headers().authorization,'Bearer '+'aa'.repeat(32));
      if(path==='/api/hosting'){
        if(statusFailure)return route.abort('failed');
        value=hosting();
        if(pendingStatus){const gate=pendingStatus;pendingStatus=undefined;statusEntered?.();await gate;}
      }else if(path==='/api/hosting/free-pass'){
        postCount++;assert.equal(request.method(),'POST');assert.deepEqual(request.postDataJSON(),{});
        if(pendingPost){const gate=pendingPost;pendingPost=undefined;postEntered?.();await gate;}
        if(postMode==='consume-abort'){consume();return route.abort('failed');}
        if(postMode==='abort')return route.abort('failed');
        if(postMode==='owner-denied')return route.fulfill({status:401,contentType:'application/json',body:JSON.stringify({error:'JEFF_OWNER_REQUIRED'})});
        consume();value=hosting();
      }else if(path==='/api/jobs')value={jobs:[record()]};
      else if(path===`/api/jobs/${id}`)value=record();
      else throw Error('Unexpected pass route '+path);
    }
    return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(value)}).catch(error=>{if(!/closed|abort/i.test(error.message))throw error;});
  });
  await page.addInitScript(()=>{const events={};window.__walletEvents=events;window.__walletCalls=0;window.ethereum={on(name,handler){events[name]=handler;},removeListener(name){delete events[name];},async request(){window.__walletCalls++;throw Error('Free pass must not request a wallet transaction');}};});
  const signIn=async()=>{
    await page.evaluate(value=>sessionStorage.setItem('simple-jeff:session:v1',JSON.stringify(value)),{token:'aa'.repeat(32),scope,expiresAt:new Date(Date.now()+3600000).toISOString()});
    await page.reload();await page.getByText('Saved to workspace',{exact:true}).waitFor();
  };
  await page.goto(base+'/?mode=nft');await page.locator('#model-status').filter({hasText:'Model connection configured'}).waitFor();
  assert.equal(await page.locator('#free-pass-card').isHidden(),true);
  checks.push('Signed-out NFT entry never displays an unverified pass');
  await signIn();await page.locator('#free-pass-card').waitFor();
  assert.equal(await page.locator('#free-pass-detail').textContent(),'100 tasks. One use per NFT. Unused tasks expire.');
  assert.match(await page.locator('#free-pass-warning').textContent(),/permanently consumes/);
  assert.match(await page.locator('#free-pass-start').textContent(),/UTC$/);
  assert.match(await page.locator('#free-pass-end').textContent(),/UTC$/);
  assert.equal(await page.locator('#allowance-remaining').textContent(),'65 tasks');
  for(const width of[320,390,768,1440]){await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);}
  await page.setViewportSize({width:320,height:900});await page.locator('#free-pass-card').screenshot({path:resolve(output,'wired-available-mobile.png')});
  await page.setViewportSize({width:1440,height:1000});
  checks.push('Confirmed eligible holder sees irreversible-use copy and server-proposed queued dates without mobile overflow');
  pass={...pass,state:'unavailable',startsAt:null,expiresAt:null};
  await page.locator('#refresh-hosting').click();await page.waitForFunction(()=>document.getElementById('free-pass-card').hidden);
  pass={...pass,state:'available',startsAt:totalEnd,expiresAt:new Date(Date.parse(totalEnd)+30*86400000).toISOString()};
  await page.locator('#refresh-hosting').click();await page.locator('#use-free-pass').waitFor();
  checks.push('Server-unavailable pass is hidden and only a fresh eligible status restores it');
  const invoiceKey='simple-jeff:invoice:v1:'+scopeKey(scope),invoiceReference='preserved-paid-invoice-reference';
  await page.evaluate(({key,value})=>localStorage.setItem(key,value),{key:invoiceKey,value:invoiceReference});
  pendingStatus=new Promise(resolveGate=>{releaseStatus=resolveGate;});
  const oldReadEntered=new Promise(resolveEntered=>{statusEntered=resolveEntered;});
  await page.locator('#refresh-hosting').click();await oldReadEntered;
  pendingPost=new Promise(resolveGate=>{releasePost=resolveGate;});
  const entered=new Promise(resolveEntered=>{postEntered=resolveEntered;});
  await page.locator('#use-free-pass').click();await entered;
  assert.equal(await page.locator('#use-free-pass').isDisabled(),true);
  await page.locator('#use-free-pass').evaluate(button=>button.dispatchEvent(new MouseEvent('click',{bubbles:true})));
  assert.equal(postCount,1);
  releasePost();await page.getByText(/Free month applied:/).waitFor();
  assert.equal(await page.locator('#free-pass-card').isHidden(),true);
  assert.equal(await page.locator('#allowance-remaining').textContent(),'65 tasks');
  assert.equal(await page.locator('#result-text').textContent(),text);
  assert.equal(await page.evaluate(key=>localStorage.getItem(key),invoiceKey),invoiceReference);
  releaseStatus();await page.waitForTimeout(100);
  assert.equal(await page.locator('#free-pass-card').isHidden(),true);
  assert.equal(await page.evaluate(()=>window.__walletCalls),0);
  checks.push('One activation consumes the pass and extends hosting without resetting usage, clearing saved output or changing the paid invoice');
  checks.push('Double click is blocked and a pre-redemption status response cannot restore the consumed card');
  await page.reload();await page.getByText('Saved to workspace',{exact:true}).waitFor();assert.equal(await page.locator('#free-pass-card').isHidden(),true);assert.equal(postCount,1);
  scope={...scope,owner:'0x'+'22'.repeat(20),ownerEpoch:1};await signIn();assert.equal(await page.locator('#free-pass-card').isHidden(),true);
  checks.push('Reload and a new holder session use server-consumed state without repeating redemption');
  scope={kind:'account',chainId:4663,owner:scope.owner};await signIn();assert.equal(await page.locator('#free-pass-card').isHidden(),true);
  checks.push('Standalone sessions hide the NFT pass even when hosting is active');
  scope={chainId:4663,collection:'0x'+'33'.repeat(20),tokenId:'36',owner:scope.owner,ownerEpoch:0};active=false;source=null;used=0;
  const freeStart=Date.now();
  pass={state:'available',periodDays:30,tasksIncluded:100,startsAt:new Date(freeStart).toISOString(),expiresAt:new Date(freeStart+30*86400000).toISOString(),consumedAt:null};
  await signIn();await page.locator('#use-free-pass').click();await page.getByText(/Free month applied:/).waitFor();
  assert.equal(await page.locator('#hosting-plan').textContent(),'Free 30-day pass');assert.equal(await page.locator('#allowance-remaining').textContent(),'100 tasks');
  assert.equal(await page.locator('#run').isEnabled(),true);
  checks.push('Inactive holder redemption activates a free-pass period and accepts its authoritative 100-task allowance');
  scope={...scope,tokenId:'37'};active=false;source=null;used=0;pass={...pass,state:'available',consumedAt:null};postMode='abort';await signIn();
  const beforeRetry=postCount;await page.locator('#use-free-pass').click();await page.getByText('The NFT pass is still available. No free month was confirmed; you can try again.',{exact:true}).waitFor();
  assert.equal(await page.locator('#use-free-pass').isEnabled(),true);assert.equal(postCount,beforeRetry+1);
  checks.push('Uncertain unconsumed response refreshes eligibility before enabling an explicit retry and never repeats POST automatically');
  postMode='consume-abort';statusFailure=true;await page.locator('#use-free-pass').click();
  await page.getByText('Free month activation is not confirmed. Refresh hosting before trying again.',{exact:true}).waitFor();
  assert.equal(await page.locator('#free-pass-card').isHidden(),true);assert.equal(await page.locator('#retrieve').isEnabled(),true);
  const uncertainPosts=postCount;statusFailure=false;await page.locator('#refresh-hosting').click();await page.getByText(/Free month applied:/).waitFor();
  assert.equal(await page.locator('#free-pass-card').isHidden(),true);assert.equal(postCount,uncertainPosts);
  checks.push('Lost consumption response plus failed status check keeps activation unavailable; manual status recovery confirms consumption without another POST');
  scope={...scope,tokenId:'38'};active=false;source=null;used=0;pass={...pass,state:'available',consumedAt:null};postMode='success';await signIn();
  pendingPost=new Promise(resolveGate=>{releasePost=resolveGate;});const lateEntered=new Promise(resolveEntered=>{postEntered=resolveEntered;});
  await page.locator('#use-free-pass').click();await lateEntered;
  await page.evaluate(()=>window.__walletEvents.accountsChanged(['0x'+'33'.repeat(20)]));
  releasePost();await page.waitForTimeout(150);
  assert.equal(await page.locator('#free-pass-card').isHidden(),true);assert.equal(await page.locator('#result-text').textContent(),'');
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('simple-jeff:session:v1')),null);
  checks.push('Wallet change during activation clears private state and suppresses the late success response');
  scope={...scope,tokenId:'39'};active=false;source=null;used=0;pass={...pass,state:'available',consumedAt:null};postMode='owner-denied';await signIn();
  await page.locator('#use-free-pass').click();await page.getByText('This wallet does not currently hold that NFT. Choose an NFT you own.',{exact:true}).waitFor();
  assert.equal(await page.locator('#free-pass-card').isHidden(),true);assert.equal(await page.locator('#result-text').textContent(),'');
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('simple-jeff:session:v1')),null);
  checks.push('Fresh owner rejection invalidates the stale holder session and withholds private output');
  assert.deepEqual(errors,[]);
  await writeFile(resolve(output,'browser-check.json'),JSON.stringify({checkedAt:new Date().toISOString(),checks,browserErrors:errors,proof:'Fixtures only; no real wallet, model, payment or pass consumption'},null,2));
  console.log(JSON.stringify({passed:checks.length,errors,evidence:output,proof:'Fixtures only'}));
}finally{await context.close();}
