import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {resolve} from 'node:path';import {randomBytes} from 'node:crypto';
import {createGithubConnectionStore} from '../src/github-connection-store.mjs';import {createGithubConnector} from '../src/github-connector.mjs';
import {createGithubProvider} from '../src/github-provider.mjs';
const scope={chainId:4663,collection:'0x'+'33'.repeat(20),tokenId:'35',owner:'0x'+'12'.repeat(20),ownerEpoch:0};
async function fixture(t){
 const root=await mkdtemp(resolve('test','.github-controller-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const store=createGithubConnectionStore({dataRoot:root,key:randomBytes(32)}),calls=[];let authorized=true,sessionActive=true,executionAllowed=true,authenticationHook=()=>{},readHook=async()=>{};
 const credential={accessToken:'ghu_'+'a'.repeat(40),expiresAt:Date.now()+3600000,account:{id:'1',login:'holder'},permissions:{metadata:'read',contents:'read'}};
 const provider={authorization:attempt=>'https://github.com/login/oauth/authorize?state='+attempt.state,exchange:async()=>{calls.push('exchange');return credential;},revoke:async()=>{calls.push('revoke');return true;},repositories:async()=>({repositories:[],coverage:{shown:0,hasMore:false}}),latest:async()=>{calls.push('latest');await readHook();return{excerpt:'release'};}};
 const connector=createGithubConnector({store,provider,authenticate:async()=>{if(!sessionActive)throw Error('SESSION_REVOKED');authenticationHook();return scope;},authorizeScope:async()=>{if(!authorized)throw Error('OWNER_REVOKED');},requireExecution:()=>{if(!executionAllowed)throw Error('JEFF_SERVICE_MAINTENANCE');},cancel:()=>calls.push('cancel')});
 const authorize=()=>connector.authorize(scope,'session');const complete=attempt=>connector.callback({state:new URL(attempt.authorizationUrl).searchParams.get('state'),code:'code',cookie:attempt.cookie.split(';')[0]});
 return{store,connector,provider,calls,credential,authorize,complete,revokeOwner:()=>authorized=false,revokeSession:()=>sessionActive=false,pause:()=>executionAllowed=false,setAuthenticationHook:value=>authenticationHook=value,setReadHook:value=>readHook=value};
}
test('configuration absent is truthful and initiates zero provider operations',async()=>{
 const connector=createGithubConnector({authorizeScope:async()=>{}});assert.equal((await connector.status(scope)).status,'not_configured');await assert.rejects(connector.authorize(scope,'session'),/NOT_CONFIGURED/);
});
test('callback requires browser binding and consumes even a rejected attempt',async t=>{
 const f=await fixture(t),attempt=await f.authorize(),state=new URL(attempt.authorizationUrl).searchParams.get('state');
 assert.ok(attempt.cookie.includes('HttpOnly; Secure; SameSite=Lax'));await assert.rejects(f.connector.callback({state,code:'code',cookie:''}),/STATE_INVALID/);await assert.rejects(f.complete(attempt),/STATE_INVALID/);assert.deepEqual(f.calls,[]);
});
test('callback persists verified grant once and does not replay',async t=>{
 const f=await fixture(t),attempt=await f.authorize();assert.equal(await f.complete(attempt),true);assert.equal((await f.connector.status(scope)).status,'connected');await assert.rejects(f.complete(attempt),/STATE_INVALID/);assert.deepEqual(f.calls,['exchange']);
});
test('logout and ownership transfer block callback before exchange',async t=>{
 for(const revoke of ['revokeOwner','revokeSession']){const f=await fixture(t),attempt=await f.authorize();f[revoke]();await assert.rejects(f.complete(attempt));assert.deepEqual(f.calls,[]);}
});
test('disconnect invalidates pending callback and stale displayed generation before reads',async t=>{
 const f=await fixture(t);await f.complete(await f.authorize());const old=await f.connector.status(scope),attempt=await f.authorize();const result=await f.connector.disconnect(scope,'session');assert.deepEqual(result,{localDisconnected:true,providerRevoked:true});await assert.rejects(f.complete(attempt),/STATE_INVALID/);
 await f.complete(await f.authorize());await assert.rejects(f.connector.read(scope,{repositoryId:'1',generation:old.generation,consent:true}),/CONNECTION_CHANGED/);assert.ok(!f.calls.includes('latest'));
});
test('disconnect during provider read prevents return and durable commit',async t=>{
 const f=await fixture(t);await f.complete(await f.authorize());const old=await f.connector.status(scope);f.setReadHook(()=>f.connector.disconnect(scope,'session'));
 await assert.rejects(f.connector.read(scope,{repositoryId:'1',generation:old.generation,consent:true}),/CONNECTION_CHANGED/);
 let committed=false;await assert.rejects(f.connector.commit(scope,old.generation,()=>{committed=true;}),/CONNECTION_CHANGED/);assert.equal(committed,false);
});
test('commit and disconnect serialize so no old result commits after disconnect returns',async t=>{
 const f=await fixture(t);await f.complete(await f.authorize());const old=await f.connector.status(scope),events=[];let release;
 const blocked=new Promise(resolve=>release=resolve);let entered;const started=new Promise(resolve=>entered=resolve);
 const commit=f.connector.commit(scope,old.generation,async()=>{entered();await blocked;events.push('commit');});await started;
 const disconnect=f.connector.disconnect(scope,'session').then(()=>events.push('disconnect'));release();await Promise.all([commit,disconnect]);assert.deepEqual(events,['commit','disconnect']);
});
test('logout while waiting for the durable commit guard prevents persistence',async t=>{
 const f=await fixture(t);await f.complete(await f.authorize());const old=await f.connector.status(scope);let release,entered,committed=false;
 const blocked=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
 const hold=f.store.guard(scope,old.generation,async()=>{entered();await blocked;});await started;
 const commit=f.connector.commit(scope,old.generation,()=>{committed=true;},'session');
 const rejection=assert.rejects(commit,/SESSION_REVOKED/);await new Promise(resolve=>setImmediate(resolve));f.revokeSession();release();await hold;await rejection;assert.equal(committed,false);
});
test('provider denial persists reconnect_required across status reads without replay',async t=>{
 const f=await fixture(t);await f.complete(await f.authorize());const old=await f.connector.status(scope);let attempts=0;
 f.provider.repositories=async()=>{attempts++;throw Error('JEFF_GITHUB_RECONNECT_REQUIRED');};
 await assert.rejects(f.connector.repositories(scope,'session'),/RECONNECT_REQUIRED/);const current=await f.connector.status(scope);assert.equal(current.status,'reconnect_required');assert.notEqual(current.generation,old.generation);
 await assert.rejects(f.connector.repositories(scope,'session'),/RECONNECT_REQUIRED/);assert.equal(attempts,1);assert.equal((await f.connector.disconnect(scope,'session')).localDisconnected,true);
});

test('logout while the exchanged callback grant waits for storage prevents persistence and revokes it',async t=>{
 const f=await fixture(t);await f.complete(await f.authorize());const old=await f.connector.status(scope),attempt=await f.authorize();
 let exchangeEntered,releaseExchange,guardEntered,releaseGuard;
 const exchanging=new Promise(resolve=>exchangeEntered=resolve),exchangeGate=new Promise(resolve=>releaseExchange=resolve);
 const guarding=new Promise(resolve=>guardEntered=resolve),guardGate=new Promise(resolve=>releaseGuard=resolve);
 f.provider.exchange=async()=>{f.calls.push('exchange');exchangeEntered();await exchangeGate;return{...f.credential,account:{id:'2',login:'other'}};};
 const callback=f.complete(attempt);await exchanging;
 const hold=f.store.guard(scope,old.generation,async()=>{guardEntered();await guardGate;});await guarding;
 releaseExchange();await new Promise(resolve=>setImmediate(resolve));f.revokeSession();
 const rejected=assert.rejects(callback,/SESSION_REVOKED/);releaseGuard();await hold;await rejected;
 const after=await f.store.read(scope);assert.equal(after.generation,old.generation);assert.equal(after.credential.account.id,'1');
 assert.equal(f.calls.filter(value=>value==='revoke').length,1);
});

test('maintenance beginning during the callback final authority read prevents grant rename',async t=>{
 const f=await fixture(t),attempt=await f.authorize();let authenticated=0;
 f.setAuthenticationHook(()=>{if(++authenticated===3)f.pause();});
 await assert.rejects(f.complete(attempt),/JEFF_SERVICE_MAINTENANCE/);
 assert.equal(authenticated,3);assert.deepEqual(await f.store.read(scope),{generation:null,credential:null});
 assert.deepEqual(f.calls,['exchange','revoke']);
});

test('maintenance beginning during the durable commit final authority read prevents rename',async t=>{
 const f=await fixture(t);await f.complete(await f.authorize());const prior=await f.connector.status(scope);let authenticated=0,committed=false;
 f.setAuthenticationHook(()=>{if(++authenticated===2)f.pause();});
 await assert.rejects(f.connector.commit(scope,prior.generation,()=>{committed=true;},'session'),/JEFF_SERVICE_MAINTENANCE/);
 assert.equal(authenticated,2);assert.equal(committed,false);
});

test('disconnect aborts a held repository listing before any follow-on read even when revocation fails',async t=>{
 const f=await fixture(t);await f.complete(await f.authorize());let entered,release;const requests=[];
 const started=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
 Object.assign(f.provider,createGithubProvider({clientId:'Iv123456789',clientSecret:'s'.repeat(40),appId:'123',callbackUrl:'https://jeff.test/api/connectors/github/callback',transport:async input=>{
   requests.push(input);if(input.method==='DELETE')return{status:503,json:null};
   entered();await gate;return{status:200,json:{total_count:1,installations:[{id:9,app_id:123,permissions:{metadata:'read',contents:'read'}}]}};
 }}));
 const listing=f.connector.repositories(scope,'session');await started;
 const rejected=assert.rejects(listing,/CANCELLED/);
 assert.deepEqual(await f.connector.disconnect(scope,'session'),{localDisconnected:true,providerRevoked:false});
 assert.equal(requests[0].signal.aborted,true);release();await rejected;
 assert.deepEqual(requests.map(value=>new URL(value.url).pathname),['/user/installations','/applications/Iv123456789/token']);
});

test('logout during a held repository listing prevents the next private provider request',async t=>{
 const f=await fixture(t);await f.complete(await f.authorize());let entered,release;const requests=[];
 const started=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
 Object.assign(f.provider,createGithubProvider({clientId:'Iv123456789',clientSecret:'s'.repeat(40),appId:'123',callbackUrl:'https://jeff.test/api/connectors/github/callback',transport:async input=>{
   requests.push(input);entered();await gate;return{status:200,json:{total_count:1,installations:[{id:9,app_id:123,permissions:{metadata:'read',contents:'read'}}]}};
 }}));
 const listing=f.connector.repositories(scope,'session');await started;const rejected=assert.rejects(listing,/SESSION_REVOKED/);
 f.revokeSession();release();await rejected;assert.equal(requests.length,1);
});

test('logout while a listing checkpoint waits behind a real storage guard prevents the next read',async t=>{
 const f=await fixture(t);await f.complete(await f.authorize());const original=await f.store.read(scope);
 let sessionActive=true,queueHeld=false,enterProvider,releaseProvider,enterGuard,releaseGuard,enterQueuedRead;
 const providerEntered=new Promise(resolve=>enterProvider=resolve),providerGate=new Promise(resolve=>releaseProvider=resolve);
 const guardEntered=new Promise(resolve=>enterGuard=resolve),guardGate=new Promise(resolve=>releaseGuard=resolve);
 const queuedReadEntered=new Promise(resolve=>enterQueuedRead=resolve),requests=[];
 const store={...f.store,read(input){if(queueHeld)enterQueuedRead();return f.store.read(input);}};
 const provider=createGithubProvider({clientId:'Iv123456789',clientSecret:'s'.repeat(40),appId:'123',callbackUrl:'https://jeff.test/api/connectors/github/callback',transport:async input=>{
   requests.push(input);enterProvider();await providerGate;
   return{status:200,json:{total_count:1,installations:[{id:9,app_id:123,permissions:{metadata:'read',contents:'read'}}]}};
 }});
 const connector=createGithubConnector({store,provider,authenticate:async()=>{if(!sessionActive)throw Error('SESSION_REVOKED');return scope;},authorizeScope:async()=>{}});
 const listing=connector.repositories(scope,'session');await providerEntered;
 const hold=f.store.guard(scope,original.generation,async()=>{queueHeld=true;enterGuard();await guardGate;});await guardEntered;
 releaseProvider();await queuedReadEntered;sessionActive=false;
 const rejected=assert.rejects(listing,/SESSION_REVOKED/);queueHeld=false;releaseGuard();await hold;await rejected;
 assert.equal(requests.length,1);assert.equal(new URL(requests[0].url).pathname,'/user/installations');
});

test('execution blocked during the final admission authority read prevents a provider call',async t=>{
 const f=await fixture(t);await f.complete(await f.authorize());const prior=await f.connector.status(scope);let authenticated=0;
 f.setAuthenticationHook(()=>{if(++authenticated===2)f.pause();});
 await assert.rejects(f.connector.read(scope,{repositoryId:'1',generation:prior.generation,consent:true},{session:'session'}),/JEFF_SERVICE_MAINTENANCE/);
 assert.equal(authenticated,2);assert.equal(f.calls.includes('latest'),false);
});
