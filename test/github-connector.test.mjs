import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {resolve} from 'node:path';import {randomBytes} from 'node:crypto';
import {createGithubConnectionStore} from '../src/github-connection-store.mjs';import {createGithubConnector} from '../src/github-connector.mjs';
const scope={chainId:4663,collection:'0x'+'33'.repeat(20),tokenId:'35',owner:'0x'+'12'.repeat(20),ownerEpoch:0};
async function fixture(t){
 const root=await mkdtemp(resolve('test','.github-controller-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const store=createGithubConnectionStore({dataRoot:root,key:randomBytes(32)}),calls=[];let authorized=true,sessionActive=true,readHook=async()=>{};
 const credential={accessToken:'ghu_'+'a'.repeat(40),expiresAt:Date.now()+3600000,account:{id:'1',login:'holder'},permissions:{metadata:'read',contents:'read'}};
 const provider={authorization:attempt=>'https://github.com/login/oauth/authorize?state='+attempt.state,exchange:async()=>{calls.push('exchange');return credential;},revoke:async()=>{calls.push('revoke');return true;},repositories:async()=>({repositories:[],coverage:{shown:0,hasMore:false}}),latest:async()=>{calls.push('latest');await readHook();return{excerpt:'release'};}};
 const connector=createGithubConnector({store,provider,authenticate:async()=>{if(!sessionActive)throw Error('SESSION_REVOKED');return scope;},authorizeScope:async()=>{if(!authorized)throw Error('OWNER_REVOKED');},cancel:()=>calls.push('cancel')});
 const authorize=()=>connector.authorize(scope,'session');const complete=attempt=>connector.callback({state:new URL(attempt.authorizationUrl).searchParams.get('state'),code:'code',cookie:attempt.cookie.split(';')[0]});
 return{store,connector,provider,calls,credential,authorize,complete,revokeOwner:()=>authorized=false,revokeSession:()=>sessionActive=false,setReadHook:value=>readHook=value};
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
