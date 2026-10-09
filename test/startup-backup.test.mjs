import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, privateDecrypt, randomBytes, constants } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { prepareStartupBackup } from '../src/startup-backup.mjs';
import { captureBackup, decryptBackup, restoreBackup } from '../src/backup.mjs';
import { createJeffApplication } from '../src/application.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
const pem = publicKey.export({type:'spki',format:'pem'});
const baseEnv = { JEFF_DATA_ROOT:'/data', RAILWAY_VOLUME_MOUNT_PATH:'/data', JEFF_PUBLIC_ORIGIN:'https://stage.invalid', JEFF_RELEASE_SHA:'1'.repeat(40),
  RAILWAY_PROJECT_ID:'11111111-1111-1111-1111-111111111111', RAILWAY_ENVIRONMENT_ID:'22222222-2222-2222-2222-222222222222', RAILWAY_SERVICE_ID:'33333333-3333-3333-3333-333333333333' };
function configuration(time = Date.now()) {
  const token = randomBytes(32).toString('base64url'), nonce = randomBytes(16).toString('hex');
  const expected = Object.fromEntries(Object.entries(baseEnv).filter(([key]) => key !== 'JEFF_DATA_ROOT'));
  return { token, config:{schema:'jeff-startup-backup-export-v1',nonce,tokenSha256:sha(token),publicKey:pem,expiresAt:new Date(time+300000).toISOString(),expected} };
}
function response() {
  return {headers:{},status:null,body:null,setHeader(key,value){this.headers[key]=value;},writeHead(status,headers){this.status=status;Object.assign(this.headers,headers);},end(body){this.body=body;}};
}

test('startup export is disabled by default and after expiry without touching storage', async () => {
  let captures = 0;
  const capture = async () => { captures++; throw new Error('must not capture'); };
  assert.equal(await prepareStartupBackup({env:baseEnv,capture}),null);
  const {config} = configuration(0);
  assert.equal(await prepareStartupBackup({env:{...baseEnv,JEFF_STARTUP_BACKUP_EXPORT:JSON.stringify(config)},now:()=>1000000,capture}),null);
  assert.equal(captures,0);
});

test('invalid config, wrong identity, unexpected mount and invalid recipient fail before capture', async () => {
  const {config} = configuration();
  const capture = async () => { throw new Error('capture reached'); };
  const cases = [null,[],{...config,other:true},{...config,tokenSha256:'bad'},{...config,publicKey:'bad'},
    {...config,expected:{...config.expected,RAILWAY_SERVICE_ID:'4'.repeat(36)}},
    {...config,expiresAt:new Date(Date.now()+900000).toISOString()},
    {...config,publicKey:generateKeyPairSync('rsa',{modulusLength:2048}).publicKey.export({type:'spki',format:'pem'})}];
  for(const value of cases) await assert.rejects(prepareStartupBackup({env:{...baseEnv,JEFF_STARTUP_BACKUP_EXPORT:JSON.stringify(value)},capture}),/JEFF_BACKUP_EXPORT_CONFIG_INVALID/);
  await assert.rejects(prepareStartupBackup({env:{...baseEnv,RAILWAY_VOLUME_MOUNT_PATH:'/wrong',JEFF_STARTUP_BACKUP_EXPORT:JSON.stringify(config)},capture}),/JEFF_BACKUP_EXPORT_CONFIG_INVALID/);
});

test('startup snapshot downloads only with scoped auth, decrypts and restores without altering source', async t => {
  const root = await mkdtemp(resolve(tmpdir(),'jeff-startup-backup-')), source = resolve(root,'source'), parent = resolve(root,'restores');
  t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(source); await mkdir(parent);
  const privateText = 'Private saved text: 中文 🦉';
  await writeFile(resolve(source,'private.txt'),privateText);
  let captures = 0, time = Date.now();
  const {config,token} = configuration(time), env={...baseEnv,JEFF_STARTUP_BACKUP_EXPORT:JSON.stringify(config)};
  const backup = await prepareStartupBackup({env,now:()=>time,capture:async options=>{captures++;assert.equal(options.writersQuiesced,true);return captureBackup({...options,dataRoot:source});}});
  t.after(()=>backup.dispose());
  const path = `/api/operator/backup/${config.nonce}`;
  for(const [method,url,headers] of [['GET',path,{}],['GET',path,{authorization:'Bearer '+randomBytes(32).toString('base64url')}],
    ['POST',path,{authorization:'Bearer '+token}],['HEAD',path,{authorization:'Bearer '+token}],
    ['GET',path+'?key=x',{authorization:'Bearer '+token}],['GET',path,{authorization:'Bearer '+token,origin:'https://other.invalid'}],
    ['GET',env.JEFF_PUBLIC_ORIGIN+path,{authorization:'Bearer '+token}]]) {
    const result=response();assert.equal(backup.handleRequest({method,url,headers},result),true);assert.equal(result.status,404);
  }
  assert.equal(backup.handleRequest({method:'GET',url:'/api/jobs',headers:{}},response()),false);
  assert.equal(backup.handleRequest({method:'GET',url:'http://[',headers:{}},response()),false);
  const result=response();backup.handleRequest({method:'GET',url:path,headers:{authorization:'Bearer '+token}},result);
  assert.equal(result.status,200);assert.equal(result.headers['Cache-Control'],'no-store, private');
  assert.equal(result.body.includes(Buffer.from(privateText)),false);
  const envelope=JSON.parse(result.body), archive=Buffer.from(envelope.archive,'base64');
  assert.equal(sha(result.body),backup.receipt.envelopeSha256);assert.equal(sha(archive),envelope.archiveSha256);
  const key=privateDecrypt({key:privateKey,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},Buffer.from(envelope.wrappedKey,'base64'));
  const snapshot=decryptBackup(archive,key);
  assert.deepEqual(snapshot.export,{nonce:config.nonce,releaseSha:env.JEFF_RELEASE_SHA,expiresAt:config.expiresAt,keyId:envelope.keyId});
  const restored=await restoreBackup({archive,key,parent});
  assert.equal(await readFile(resolve(restored.root,'private.txt'),'utf8'),privateText);
  assert.equal(await readFile(resolve(source,'private.txt'),'utf8'),privateText);
  assert.ok(await readFile(resolve(restored.root,'hosting/restore-guard.json')));
  assert.equal(JSON.stringify(backup.receipt).includes(privateText),false);
  assert.equal(JSON.stringify(backup.receipt).includes(token),false);
  time=Date.parse(config.expiresAt);const expired=response();backup.handleRequest({method:'GET',url:path,headers:{authorization:'Bearer '+token}},expired);assert.equal(expired.status,404);
  assert.equal(captures,1);
});

test('encrypted route uses a real HTTP request and never starts another capture', async t => {
  const {config,token}=configuration();let captures=0;
  const snapshot={schema:'simple-jeff-backup-v1',sourceRoot:'/data',capturedAt:new Date().toISOString(),consistency:'all-service-writers-quiesced-and-stable-reread',files:[],manifestSha256:sha('[]')};
  const backup=await prepareStartupBackup({env:{...baseEnv,JEFF_STARTUP_BACKUP_EXPORT:JSON.stringify(config)},capture:async()=>{captures++;return snapshot;}});
  const server=createServer((req,res)=>{if(!backup.handleRequest(req,res)){res.writeHead(404);res.end();}});
  t.after(async()=>{backup.dispose();await new Promise(done=>server.close(done));});
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  const url=`http://127.0.0.1:${server.address().port}/api/operator/backup/${config.nonce}`;
  assert.equal((await fetch(url)).status,404);
  assert.equal((await fetch(url,{headers:{authorization:'Bearer '+token}})).status,200);
  backup.dispose();assert.equal((await fetch(url,{headers:{authorization:'Bearer '+token}})).status,404);
  assert.equal(captures,1);
});

test('capture limits fail before reading oversized files or excessively large trees', async t => {
  const root=await mkdtemp(resolve(tmpdir(),'jeff-backup-limits-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(resolve(root,'one.txt'),'12345');await writeFile(resolve(root,'two.txt'),'67890');
  for(const limits of [{maxBytes:9},{maxFileBytes:4},{maxFiles:1}]) await assert.rejects(captureBackup({dataRoot:root,writersQuiesced:true,...limits}),/JEFF_BACKUP_TOO_LARGE/);
  await mkdir(resolve(root,'a/b/c'),{recursive:true});
  await assert.rejects(captureBackup({dataRoot:root,writersQuiesced:true,maxDepth:1}),/JEFF_BACKUP_TOO_LARGE/);
  await assert.rejects(captureBackup({dataRoot:root,writersQuiesced:true,maxBytes:0}),/JEFF_BACKUP_LIMIT_INVALID/);
});

test('failed or expired captures never produce a downloadable export', async () => {
  let time = Date.now(), captures = 0;
  const {config} = configuration(time), env = {...baseEnv,JEFF_STARTUP_BACKUP_EXPORT:JSON.stringify(config)};
  await assert.rejects(prepareStartupBackup({env,now:()=>time,capture:async()=>{
    captures++;
    throw new Error('JEFF_BACKUP_SOURCE_CHANGED');
  }}), /JEFF_BACKUP_SOURCE_CHANGED/);
  await assert.rejects(prepareStartupBackup({env,now:()=>time,capture:async()=>{
    captures++;
    time = Date.parse(config.expiresAt);
    return {schema:'simple-jeff-backup-v1',files:[],capturedAt:new Date(time).toISOString(),manifestSha256:sha('[]')};
  }}), /JEFF_BACKUP_EXPORT_EXPIRED/);
  assert.equal(captures,2);
});

test('application serves only the cached encrypted export before its maintenance gate', async t => {
  const root = await mkdtemp(resolve(tmpdir(),'jeff-startup-backup-app-'));
  let app, backup;
  t.after(async()=>{
    backup?.dispose();
    app?.server.closeAllConnections();
    try { await app?.close(); }
    finally { await rm(root,{recursive:true,force:true}); }
  });
  let time = Date.now(), captures = 0, modelCalls = 0;
  const {config,token} = configuration(time), env = {...baseEnv,JEFF_STARTUP_BACKUP_EXPORT:JSON.stringify(config)};
  const snapshot = {schema:'simple-jeff-backup-v1',sourceRoot:'/data',capturedAt:new Date(time).toISOString(),
    consistency:'all-service-writers-quiesced-and-stable-reread',files:[],manifestSha256:sha('[]')};
  backup = await prepareStartupBackup({env,now:()=>time,capture:async()=>{captures++;return snapshot;}});
  app = await createJeffApplication({env,dataRoot:root,startScheduler:false,fixture:true,backupExport:backup,
    runAgent:async()=>{modelCalls++;throw new Error('must not run');},
    resolveOwner:async()=>{throw new Error('must not request ownership');},
    discoverNfts:async()=>{throw new Error('must not discover NFTs');}});
  await new Promise(done=>app.server.listen(0,'127.0.0.1',done));
  const origin = `http://127.0.0.1:${app.server.address().port}`, path = `/api/operator/backup/${config.nonce}`;
  assert.equal((await fetch(origin+'/health')).status,200);
  await app.maintenance.pause();
  assert.equal((await fetch(origin+'/health')).status,503);
  assert.equal((await fetch(origin+path)).status,404);
  assert.equal((await fetch(origin+path,{headers:{authorization:'Bearer '+token,origin:'https://other.invalid'}})).status,404);
  const downloaded = await fetch(origin+path,{headers:{authorization:'Bearer '+token}});
  assert.equal(downloaded.status,200);
  assert.equal(sha(Buffer.from(await downloaded.arrayBuffer())),backup.receipt.envelopeSha256);
  assert.deepEqual(app.maintenance.status(),{blocked:true,phase:'paused',activeRequests:0,pendingTasks:0,failures:[]});
  time = Date.parse(config.expiresAt);
  assert.equal((await fetch(origin+path,{headers:{authorization:'Bearer '+token}})).status,404);
  assert.equal(captures,1);
  assert.equal(modelCalls,0);
});
