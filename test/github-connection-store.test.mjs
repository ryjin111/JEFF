import test from 'node:test';import assert from 'node:assert/strict';
import{mkdtemp,rm,readFile,writeFile,copyFile,readdir}from'node:fs/promises';import{resolve}from'node:path';import{randomBytes,createHash}from'node:crypto';
import{createGithubConnectionStore,createGithubAuthorizationStates}from'../src/github-connection-store.mjs';import{scopeId}from'../src/scope.mjs';
const scope={chainId:4663,collection:'0x'+'33'.repeat(20),tokenId:'35',owner:'0x'+'12'.repeat(20),ownerEpoch:0};
const transferred={...scope,owner:'0x'+'34'.repeat(20),ownerEpoch:1};
async function fixture(t){const dataRoot=await mkdtemp(resolve('test','.github-store-'));t.after(()=>rm(dataRoot,{recursive:true,force:true}));const key=randomBytes(32);return{dataRoot,key,store:createGithubConnectionStore({dataRoot,key}),file:s=>resolve(dataRoot,'connectors/github',scopeId(s)+'.json')};}
const credential={accessToken:'ghu_private_fixture_token',providerUserId:'42',login:'octocat',expiresAt:'2026-10-10T18:00:00Z'};
test('credentials persist encrypted and a different epoch sees no connection',async t=>{
 const f=await fixture(t),saved=await f.store.replace(scope,null,credential),disk=await readFile(f.file(scope),'utf8');assert.equal(disk.includes(credential.accessToken),false);assert.equal(disk.includes('octocat'),false);
 assert.deepEqual(await createGithubConnectionStore({dataRoot:f.dataRoot,key:f.key}).read(scope),saved);assert.deepEqual(await f.store.read(transferred),{generation:null,credential:null});
});
test('swapped scope, altered generation, ciphertext and wrong key cannot be read or overwritten',async t=>{
 const f=await fixture(t);await f.store.replace(scope,null,credential);const original=await readFile(f.file(scope),'utf8');
 await copyFile(f.file(scope),f.file(transferred));await assert.rejects(f.store.read(transferred),/STORAGE_UNAVAILABLE/);
 for(const field of ['generation','ciphertext']){const envelope=JSON.parse(original);envelope[field]=field==='generation'?'00000000-0000-4000-8000-000000000000':Buffer.alloc(24).toString('base64');await writeFile(f.file(scope),JSON.stringify(envelope));await assert.rejects(f.store.read(scope),/STORAGE_UNAVAILABLE/);await assert.rejects(f.store.replace(scope,null,credential),/STORAGE_UNAVAILABLE/);}
 await writeFile(f.file(scope),original);await assert.rejects(createGithubConnectionStore({dataRoot:f.dataRoot,key:randomBytes(32)}).read(scope),/STORAGE_UNAVAILABLE/);
});
test('disconnect tombstone survives restart and prevents stale pending authorization from committing',async t=>{
 const f=await fixture(t),disconnected=await f.store.disconnect(scope);assert.ok(disconnected.generation);const restarted=createGithubConnectionStore({dataRoot:f.dataRoot,key:f.key});await assert.rejects(restarted.replace(scope,null,credential),/CONNECTION_CHANGED/);
 const saved=await restarted.replace(scope,disconnected.generation,credential);await restarted.disconnect(scope);await assert.rejects(restarted.replace(scope,saved.generation,credential),/CONNECTION_CHANGED/);assert.equal((await restarted.read(scope)).credential,null);
});
test('concurrent grants with the same generation have one winner',async t=>{
 const f=await fixture(t),outcomes=await Promise.allSettled([f.store.replace(scope,null,credential),f.store.replace(scope,null,{...credential,login:'another'})]);assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);assert.equal(outcomes.filter(x=>x.status==='rejected').length,1);
});

test('grant authority is checked after temporary sync and denial preserves the previous grant',async t=>{
 const f=await fixture(t),prior=await f.store.replace(scope,null,credential),original=await readFile(f.file(scope),'utf8'),directory=resolve(f.dataRoot,'connectors/github');let checked=false;
 await assert.rejects(f.store.replace(scope,prior.generation,{...credential,login:'other'},{beforeCommit:async()=>{
   checked=true;assert.ok((await readdir(directory)).some(file=>file.endsWith('.tmp')));
   assert.equal(await readFile(f.file(scope),'utf8'),original);throw new Error('JEFF_SESSION_REVOKED');
 }}),/JEFF_SESSION_REVOKED/);
 assert.equal(checked,true);assert.deepEqual(await f.store.read(scope),prior);assert.equal((await readdir(directory)).length,1);
});
test('authorization state binds session and epoch, supplies S256 and is consumed once',()=>{
 const states=createGithubAuthorizationStates(),issued=states.issue({scope,session:'session-a',generation:null}),consumed=states.consume({state:issued.state,scope,session:'session-a'});
 assert.equal(createHash('sha256').update(consumed.verifier).digest('base64url'),issued.codeChallenge);assert.equal(issued.codeChallengeMethod,'S256');assert.equal(JSON.stringify(issued).includes(consumed.verifier),false);
 assert.throws(()=>states.consume({state:issued.state,scope,session:'session-a'}),/STATE_INVALID/);
 for(const wrong of [{scope:transferred,session:'session-a'},{scope,session:'session-b'}]){const attempt=states.issue({scope,session:'session-a',generation:null});assert.throws(()=>states.consume({state:attempt.state,...wrong}),/STATE_INVALID/);assert.throws(()=>states.consume({state:attempt.state,scope,session:'session-a'}),/STATE_INVALID/);}
});
test('authorization expiry and capacity fail before a verifier can be used',()=>{
 let time=100000;const states=createGithubAuthorizationStates({now:()=>time,limit:1}),issued=states.issue({scope,session:'session-a',generation:null});assert.throws(()=>states.issue({scope,session:'session-a',generation:null}),/BUSY/);time+=300001;assert.throws(()=>states.consume({state:issued.state,scope,session:'session-a'}),/STATE_INVALID/);assert.ok(states.issue({scope,session:'session-a',generation:null}).state);
});
