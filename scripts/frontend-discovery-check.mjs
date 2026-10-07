import { chromium } from 'file:///D:/agentmanagerworks/AI/node_modules/playwright/index.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const output=resolve('evidence/nft-discovery');await mkdir(resolve(output,'browser-temp'),{recursive:true});
const context=await chromium.launchPersistentContext(resolve(output,'browser-profile'),{executablePath:'D:/agentmanagerworks/_playwright-cache/chromium-1223/chrome-win64/chrome.exe',headless:true,viewport:{width:1440,height:1000},env:{...process.env,TEMP:resolve(output,'browser-temp'),TMP:resolve(output,'browser-temp')}});
const checks=[],errors=[],base='http://127.0.0.1:8788',wallet='0x'+'11'.repeat(20),otherWallet='0x'+'22'.repeat(20),collection='0x'+'33'.repeat(20);
async function scenario(overrides={}){
  const state={ids:['35'],complete:true,lookupFailure:false,challengeDenied:false,discoveries:0,challenges:0,verifies:0,selected:undefined,pendingDiscovery:undefined,entered:undefined,...overrides};
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  let challenge,scope;
  await page.route('**/api/**',async route=>{
    const request=route.request(),path=new URL(request.url()).pathname;let value;
    if(path==='/api/config')value={chainId:4663,collection,modelConfigured:true,billingEnabled:false,continuousHosting:true,standaloneAccounts:true,toolsEnabled:false,plan:{usdCents:1000,currency:'USD',periodDays:30,tasksIncluded:100}};
    else if(path==='/api/auth/nfts'){
      state.discoveries++;const body=request.postDataJSON();assert.deepEqual(Object.keys(body),['wallet']);
      if(state.lookupFailure==='transport')return route.abort('failed');
      if(state.lookupFailure)return route.fulfill({status:503,json:{error:'JEFF_DISCOVERY_UNAVAILABLE'}});
      value={chainId:4663,collection,wallet:body.wallet,tokenIds:[...state.ids],balance:state.ids.length,blockNumber:'81741824',complete:state.complete,...state.invalid};
      if(state.pendingDiscovery){const gate=state.pendingDiscovery;state.pendingDiscovery=undefined;state.entered?.();await gate;}
    }else if(path.endsWith('/auth/challenge')){
      state.challenges++;const body=request.postDataJSON();
      if(state.challengeDenied)return route.fulfill({status:401,json:{error:'JEFF_OWNER_REQUIRED'}});
      const account=path.startsWith('/api/account/');state.selected=body.tokenId;
      assert.deepEqual(Object.keys(body).sort(),account?['wallet']:['tokenId','wallet']);
      scope=account?{kind:'account',chainId:4663,owner:body.wallet}:{chainId:4663,collection,tokenId:body.tokenId,owner:body.wallet,ownerEpoch:0};
      challenge='Fixture login for '+(account?'account':body.tokenId);value={nonce:'fixture-only',message:challenge};
    }else if(path.endsWith('/auth/verify')){state.verifies++;assert.deepEqual(request.postDataJSON(),{nonce:'fixture-only',signature:'fixture-signature'});value={token:'aa'.repeat(32),scope,expiresAt:new Date(Date.now()+3600000).toISOString()};}
    else if(path==='/api/auth/logout')value={loggedOut:true};
    else if(path==='/api/hosting')value={active:false,source:null,expiresAt:null,periodDays:30,checkoutEnabled:false,token:'0x'+'44'.repeat(20),amount:null,plan:{usdCents:1000,currency:'USD',periodDays:30,tasksIncluded:100},recipient:null,chainId:4663,automaticRenewal:false,
      usage:{unit:'tasks',limit:100,used:0,remaining:0,periodStartsAt:null,resetsAt:null,source:null,hourlyLimit:10,hourlyRemaining:10,hourlyResetsAt:null},freePass:scope.kind==='account'?null:{state:'unavailable',periodDays:30,tasksIncluded:100,startsAt:null,expiresAt:null,consumedAt:null}};
    else if(path==='/api/jobs')value={jobs:[]};else throw Error('Unexpected discovery route '+path);
    return route.fulfill({status:200,json:value}).catch(error=>{if(!/closed|abort/i.test(error.message))throw error;});
  });
  await page.addInitScript(({wallet,holdConnect})=>{
    const events={};window.__walletEvents=events;window.__wallet=wallet;window.__connected=false;window.__chain='0x1237';window.__signatures=[];window.__connects=0;window.__holdConnect=holdConnect;
    window.ethereum={on(name,handler){events[name]=handler;},removeListener(name){delete events[name];},async request({method,params}){
      if(method==='eth_accounts')return window.__connected?[window.__wallet]:[];
      if(method==='eth_chainId')return window.__chain;
      if(method==='eth_requestAccounts'){
        window.__connects++;const requested=window.__wallet;
        if(window.__holdConnect)await new Promise(resolveConnect=>{window.__releaseConnect=resolveConnect;});
        if(!window.__connected){window.__wallet=requested;window.__connected=true;events.accountsChanged?.([requested]);}
        return [requested];
      }
      if(method==='personal_sign'){
        const bytes=Uint8Array.from(params[0].slice(2).match(/.{2}/g),byte=>parseInt(byte,16));window.__signatures.push({message:new TextDecoder().decode(bytes),wallet:params[1]});return 'fixture-signature';
      }
      throw Error('Unexpected discovery wallet method '+method);
    }};
  },{wallet,holdConnect:state.holdConnect||false});
  await page.goto(base+'/?mode=nft');await page.locator('#login').filter({hasText:'Connect wallet & sign in'}).waitFor();
  return {page,state};
}
try{
  let item=await scenario();
  assert.equal(await item.page.locator('#token-field').isHidden(),true);assert.equal(await item.page.locator('input[name="tokenId"]').count(),0);
  await item.page.locator('#login').click();await item.page.locator('#agent-name').filter({hasText:'Room #35'}).waitFor();
  assert.equal(item.state.discoveries,1);assert.equal(item.state.selected,'35');assert.equal(item.state.verifies,1);
  assert.equal(await item.page.evaluate(()=>window.__connects),1);assert.equal(await item.page.evaluate(()=>window.__signatures.length),1);
  checks.push('No token-ID input is shown; a sole verified NFT signs in in one connect flow including the normal first accountsChanged event');await item.page.close();
  item=await scenario({ids:['35','36']});await item.page.locator('#login').click();await item.page.locator('#token-field').waitFor();
  assert.equal(item.state.challenges,0);assert.equal(await item.page.locator('#login').isDisabled(),true);
  assert.equal(await item.page.evaluate(()=>document.activeElement.id),'token-id');
  await item.page.evaluate(()=>window.__walletEvents.accountsChanged([window.__wallet]));
  assert.equal(await item.page.locator('#token-field').isVisible(),true);
  await item.page.setViewportSize({width:320,height:900});assert.equal(await item.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await item.page.locator('#access').screenshot({path:resolve(output,'multiple-nfts-mobile.png')});
  await item.page.locator('#token-id').selectOption('36');await item.page.locator('#login').click();await item.page.locator('#agent-name').filter({hasText:'Room #36'}).waitFor();
  assert.equal(item.state.selected,'36');assert.equal(await item.page.evaluate(()=>window.__connects),1);assert.equal(item.state.discoveries,1);
  checks.push('Multiple NFTs focus an accessible selector and sign in only to the chosen NFT without reconnecting');await item.page.close();
  item=await scenario({ids:[]});await item.page.locator('#login').click();await item.page.locator('#wallet-discovery-copy').filter({hasText:'No Clockers Rooms found'}).waitFor();
  assert.equal(item.state.challenges,0);assert.equal(await item.page.locator('#token-field').isHidden(),true);
  checks.push('A complete zero-NFT lookup gives an empty-wallet message without requesting a signature');
  item.state.ids=['35'];await item.page.locator('#login').click();await item.page.locator('#agent-name').filter({hasText:'Room #35'}).waitFor();
  assert.equal(item.state.discoveries,2);assert.equal(item.state.challenges,1);
  checks.push('Retrying an empty wallet performs fresh discovery and signs in to a newly received NFT without an extra click');await item.page.close();
  item=await scenario({lookupFailure:true});await item.page.locator('#login').click();await item.page.getByText("Couldn't check this wallet's Rooms. Try again.",{exact:true}).waitFor();
  assert.equal(item.state.challenges,0);assert.equal(await item.page.locator('#token-field').isHidden(),true);
  item.state.lookupFailure=false;await item.page.locator('#login').click();await item.page.locator('#agent-name').filter({hasText:'Room #35'}).waitFor();
  checks.push('RPC failure stays distinct from no NFTs; retry loads a fresh list before signing');await item.page.close();
  item=await scenario({lookupFailure:'transport'});await item.page.locator('#login').click();await item.page.getByText("Couldn't check this wallet's Rooms. Try again.",{exact:true}).waitFor();
  assert.equal(item.state.challenges,0);assert.equal(await item.page.locator('#login').textContent(),'Retry');
  item.state.lookupFailure=false;await item.page.locator('#login').click();await item.page.locator('#agent-name').filter({hasText:'Room #35'}).waitFor();
  assert.equal(item.state.discoveries,2);assert.equal(item.state.challenges,1);
  checks.push('A discovery transport failure shows Retry and recovers with a fresh lookup before signing');await item.page.close();
  for(const invalid of[{complete:false},{wallet:otherWallet},{chainId:1},{tokenIds:['35','35'],balance:2}]){
    item=await scenario({invalid});await item.page.locator('#login').click();await item.page.locator('#notice.error').waitFor();
    assert.equal(item.state.challenges,0);assert.equal(await item.page.locator('#token-field').isHidden(),true);await item.page.close();
  }
  checks.push('Incomplete, wrong-wallet, wrong-chain and duplicate inventory responses never enable a picker or signature');
  item=await scenario({ids:['35','36']});await item.page.locator('#login').click();await item.page.locator('#token-field').waitFor();
  await item.page.evaluate(value=>{window.__wallet=value;window.__walletEvents.accountsChanged([value]);},otherWallet);
  assert.equal(await item.page.locator('#token-field').isHidden(),true);assert.equal(await item.page.locator('#token-id option').count(),1);assert.equal(item.state.challenges,0);
  checks.push('Wallet changes clear an open multi-NFT picker before any challenge');await item.page.close();
  item=await scenario({ids:['35','36']});await item.page.locator('#login').click();await item.page.locator('#token-field').waitFor();
  await item.page.evaluate(()=>{window.__chain='0x1';window.__walletEvents.chainChanged('0x1');});assert.equal(await item.page.locator('#token-field').isHidden(),true);
  checks.push('Network changes clear the selected inventory');await item.page.close();
  for(const change of['wallet','chain']){
    item=await scenario({holdConnect:true});await item.page.locator('#login').click();await item.page.waitForFunction(()=>typeof window.__releaseConnect==='function');
    await item.page.evaluate(({change,otherWallet})=>{if(change==='wallet'){window.__wallet=otherWallet;window.__connected=true;window.__walletEvents.accountsChanged([otherWallet]);}else{window.__chain='0x1';window.__walletEvents.chainChanged('0x1');}window.__releaseConnect();},{change,otherWallet});
    await item.page.waitForTimeout(100);assert.equal(item.state.discoveries,0);assert.equal(item.state.challenges,0);assert.equal(await item.page.locator('#token-field').isHidden(),true);await item.page.close();
  }
  checks.push('Wallet or network change during the first connect request suppresses the late account result');
  for(const change of['wallet','mode']){
    let release,entered;const gate=new Promise(resolveGate=>{release=resolveGate;});const lookupEntered=new Promise(resolveEntered=>{entered=resolveEntered;});
    item=await scenario({ids:['35','36'],pendingDiscovery:gate,entered});await item.page.locator('#login').click();await lookupEntered;
    if(change==='wallet')await item.page.evaluate(value=>{window.__wallet=value;window.__walletEvents.accountsChanged([value]);},otherWallet);
    else await item.page.locator('#standalone-mode').click();
    release();await item.page.waitForTimeout(100);assert.equal(await item.page.locator('#token-field').isHidden(),true);assert.equal(item.state.challenges,0);
    if(change==='mode'){await item.page.locator('#login').click();await item.page.locator('#agent-name').filter({hasText:'My JEFF'}).waitFor();assert.equal(item.state.discoveries,1);}
    await item.page.close();
  }
  checks.push('Late inventory cannot repopulate after wallet or access-mode changes; standalone login bypasses discovery');
  item=await scenario({challengeDenied:true});await item.page.locator('#login').click();await item.page.getByText('This wallet does not currently hold that NFT. Choose an NFT you own.',{exact:true}).waitFor();
  assert.equal(item.state.verifies,0);assert.equal(await item.page.evaluate(()=>window.__signatures.length),0);assert.equal(await item.page.locator('#token-field').isHidden(),true);
  checks.push('Discovery never bypasses fresh holder ownership rejection at the signing challenge');await item.page.close();
  assert.deepEqual(errors,[]);
  await writeFile(resolve(output,'browser-check.json'),JSON.stringify({checkedAt:new Date().toISOString(),checks,browserErrors:errors,proof:'Wallet/API fixtures only; no real wallet signature, model, payment or pass use'},null,2));
  console.log(JSON.stringify({passed:checks.length,errors,evidence:output,proof:'Fixtures only'}));
}finally{await context.close();}
