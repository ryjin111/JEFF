import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createJeffOpenClawNftBridge } from 'jeff-agent-nft/openclaw';
import { prepareExport, downloadAndVerify, restoreSavedEnvelope } from '../scripts/backup-export-client.mjs';
import { prepareStartupBackup } from '../src/startup-backup.mjs';
import { captureBackup } from '../src/backup.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const identity = { RAILWAY_PROJECT_ID:'11111111-1111-1111-1111-111111111111',
  RAILWAY_ENVIRONMENT_ID:'22222222-2222-2222-2222-222222222222',
  RAILWAY_SERVICE_ID:'33333333-3333-3333-3333-333333333333',
  JEFF_PUBLIC_ORIGIN:'https://stage.invalid', JEFF_RELEASE_SHA:'1'.repeat(40), RAILWAY_VOLUME_MOUNT_PATH:'/data' };

async function fixture(t, { captureTime = Date.now(), deepDatabase = false } = {}) {
  const root = await mkdtemp(resolve(tmpdir(),'jeff-backup-export-client-'));
  let backup;
  t.after(async()=>{ backup?.dispose(); await rm(root,{recursive:true,force:true}); });
  const source = resolve(root,'source'); await mkdir(source);
  const prepared = await prepareExport({identity,root:resolve(root,'private'),now:captureTime});
  const local = JSON.parse(await readFile(prepared.keyFile,'utf8'));
  const scope = {chainId:4663,collection:'0xf4127ac7e73a807060cbdd08fc2c776b2e78ce67',tokenId:'35',
    owner:'0x'+'11'.repeat(20),ownerEpoch:0};
  const operatorRoot = resolve(source,'operator-verification');
  const bridge = createJeffOpenClawNftBridge({dataRoot:operatorRoot,resolveOwner:async()=>scope,
    runAgent:async()=>({text:'Disposable saved operator result.',model:'fixture'})});
  const job = await bridge.run(scope,'Fixture objective');
  await writeFile(resolve(operatorRoot,'hosted-proof.json'),JSON.stringify({scope,jobId:job.id,textSha256:job.textSha256,
    observedAt:new Date().toISOString(),simulatedModel:true}));
  const db = new DatabaseSync(resolve(source,'fixture.sqlite'));
  try { db.exec('CREATE TABLE notes(value TEXT); INSERT INTO notes VALUES (\'fixture only\');'); }
  finally { db.close(); }
  if(deepDatabase) {
    // A Linux checkpoint may contain a database that fits the recovered path
    // but crosses SQLite's Windows limit with a redundant long wrapper name.
    const restoredPrefixLength=resolve(root,'recoveries').length+1+8+1+27+1;
    const directoryLength=245-restoredPrefixLength-'/deep.sqlite'.length;
    assert.ok(directoryLength>0);
    const directory=resolve(source,'d'.repeat(directoryLength));await mkdir(directory);
    const deepDb=new DatabaseSync(resolve(directory,'deep.sqlite'));
    try {deepDb.exec('CREATE TABLE checkpoint(value TEXT);');}finally{deepDb.close();}
  }
  backup = await prepareStartupBackup({env:{...identity,JEFF_DATA_ROOT:'/data',JEFF_STARTUP_BACKUP_EXPORT:JSON.stringify(local.config)},
    now:()=>captureTime,
    capture:async options=>({...await captureBackup({...options,dataRoot:source}),sourceRoot:'/data',capturedAt:new Date(captureTime).toISOString()})});
  let envelopeBytes;
  backup.handleRequest({method:'GET',url:`/api/operator/backup/${local.config.nonce}`,headers:{authorization:'Bearer '+local.token}},
    {setHeader(){},writeHead(status){assert.equal(status,200);},end(bytes){envelopeBytes=bytes;}});
  const fetchImpl = async (url, options) => {
    assert.equal(url,`${identity.JEFF_PUBLIC_ORIGIN}/api/operator/backup/${local.config.nonce}`);
    assert.equal(options.redirect,'error');
    assert.equal(options.headers.authorization,'Bearer '+local.token);
    assert.ok(options.signal instanceof AbortSignal);
    return new Response(envelopeBytes,{status:200,headers:{'cache-control':'no-store, private'}});
  };
  return {root,source,prepared,local,envelopeBytes,fetchImpl,job};
}

test('client verifies encrypted off-host archive and isolates a saved operator result without runtime calls', async t => {
  const f = await fixture(t), evidenceFile=resolve(f.root,'receipt.json');
  const result = await downloadAndVerify({...f.prepared,evidenceFile,fetchImpl:f.fetchImpl});
  assert.equal(result.jobsRetrieved,1);
  assert.equal(result.databasesQuickChecked,1);
  assert.equal(result.operatorJob.jobId,f.job.id);
  assert.equal(result.modelCalls,0);
  assert.equal(result.runtimeLaunched,false);
  assert.equal(result.liveDataOverwritten,false);
  assert.equal(result.cloudRuntimeRestoreVerified,false);
  assert.equal(result.holderSessionUsed,false);
  assert.equal(result.recurringBackupEnabled,false);
  assert.notEqual(result.restoredRoot,f.source);
  assert.equal(sha(await readFile(result.encryptedOffHostArchive)),sha(f.envelopeBytes));
  assert.equal((await readFile(resolve(result.restoredRoot,'hosting/restore-guard.json'),'utf8')).includes('freePassesBlocked'),true);
  const evidence = await readFile(evidenceFile,'utf8');
  for(const secret of [f.local.token,f.local.privateKey,'Disposable saved operator result.']) assert.equal(evidence.includes(secret),false);
  assert.deepEqual(JSON.parse(evidence),result);
});

test('client rejects changed metadata, corrupt ciphertext and a wrong wrapped key before writing archives', async t => {
  const f = await fixture(t), original=JSON.parse(f.envelopeBytes);
  const mutations = [
    value=>{value.nonce='0'.repeat(32);},
    value=>{value.releaseSha='0'.repeat(40);},
    value=>{value.expiresAt=new Date(Date.parse(value.expiresAt)+1).toISOString();},
    value=>{value.keyId='0'.repeat(64);},
    value=>{value.capturedAt=new Date(Date.parse(value.capturedAt)+1).toISOString();},
    value=>{value.wrappedKey=randomBytes(384).toString('base64');},
    value=>{const bytes=Buffer.from(value.archive,'base64');bytes[bytes.length-1]^=1;value.archive=bytes.toString('base64');value.archiveSha256=sha(bytes);},
  ];
  for(const mutate of mutations) {
    const envelope=structuredClone(original); mutate(envelope);
    await assert.rejects(downloadAndVerify({...f.prepared,evidenceFile:resolve(f.root,'receipt.json'),
      fetchImpl:async()=>new Response(JSON.stringify(envelope),{status:200,headers:{'cache-control':'no-store'}})}));
    assert.deepEqual(await readdir(f.prepared.archiveRoot),[]);
  }
});

test('client rejects unsuccessful or cacheable download responses before archive persistence', async t => {
  const f = await fixture(t);
  for(const response of [new Response(null,{status:302,headers:{location:'https://other.invalid'}}),
    new Response(f.envelopeBytes,{status:200,headers:{'cache-control':'public'}})]) {
    await assert.rejects(downloadAndVerify({...f.prepared,evidenceFile:resolve(f.root,'receipt.json'),fetchImpl:async()=>response}),/JEFF_BACKUP_EXPORT_DOWNLOAD_FAILED/);
    assert.deepEqual(await readdir(f.prepared.archiveRoot),[]);
  }
});

test('saved expired checkpoint restores offline with its guard while live download stays expired', async t => {
  const f=await fixture(t,{captureTime:Date.now()-86400000});
  const envelopeFile=resolve(f.root,'saved.jeffenvelope'), parent=resolve(f.root,'recoveries'), evidenceFile=resolve(f.root,'offline-receipt.json');
  await writeFile(envelopeFile,f.envelopeBytes); await mkdir(parent);
  const originalManifest=(await captureBackup({dataRoot:f.source,writersQuiesced:true})).manifestSha256;
  let networkCalls=0;
  t.mock.method(globalThis,'fetch',async()=>{networkCalls++;throw new Error('Offline recovery cannot fetch');});
  await assert.rejects(downloadAndVerify({...f.prepared,evidenceFile:resolve(f.root,'expired-download.json'),
    fetchImpl:async()=>{networkCalls++;throw new Error('Expired download cannot fetch');}}),/JEFF_BACKUP_CLIENT_CONFIG_INVALID/);
  const result=await restoreSavedEnvelope({envelopeFile,keyFile:f.prepared.keyFile,parent,evidenceFile});
  assert.equal(result.offlineRecovery,true);
  assert.equal(result.exportExpiredAtRecovery,true);
  assert.equal(result.operatorJob.jobId,f.job.id);
  assert.equal(result.operatorJob.textSha256,f.job.textSha256);
  assert.equal(result.jobsRetrieved,1); assert.equal(result.databasesQuickChecked,1);
  assert.equal(result.modelCalls,0); assert.equal(result.runtimeLaunched,false); assert.equal(result.liveDataOverwritten,false);
  assert.equal(result.restoreGuardPresent,true); assert.equal(result.reconciliationRequired,true);
  assert.equal(result.cloudRuntimeRestoreVerified,false);
  assert.equal(networkCalls,0);
  assert.ok(await readFile(resolve(result.restoredRoot,'hosting/restore-guard.json')));
  assert.equal(sha(await readFile(envelopeFile)),sha(f.envelopeBytes));
  assert.equal((await captureBackup({dataRoot:f.source,writersQuiesced:true})).manifestSha256,originalManifest);
  const receipt=await readFile(evidenceFile,'utf8');
  assert.deepEqual(JSON.parse(receipt),result);
  for(const secret of [f.local.token,f.local.privateKey,'Disposable saved operator result.']) assert.equal(receipt.includes(secret),false);
  const cliOutput=execFileSync(process.execPath,[resolve('scripts/backup-export-client.mjs'),'restore',envelopeFile,
    f.prepared.keyFile,parent,resolve(f.root,'cli-receipt.json')],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']});
  const cliResult=JSON.parse(cliOutput);
  assert.notEqual(cliResult.restoredRoot,result.restoredRoot);
  assert.equal(cliResult.exportExpiredAtRecovery,true); assert.equal(cliResult.restoreGuardPresent,true);
  assert.equal(cliResult.modelCalls,0);
  for(const secret of [f.local.token,f.local.privateKey,'Disposable saved operator result.']) assert.equal(cliOutput.includes(secret),false);
});

test('offline recovery rejects tampering and another recipient before creating a decrypted tree', async t => {
  const f=await fixture(t), original=JSON.parse(f.envelopeBytes), parent=resolve(f.root,'recoveries');
  const envelopeFile=resolve(f.root,'saved.jeffenvelope'), evidenceFile=resolve(f.root,'offline-receipt.json');
  await mkdir(parent);
  const mutations=[
    value=>{value.releaseSha='0'.repeat(40);},
    value=>{value.expiresAt=new Date(Date.parse(value.expiresAt)+1).toISOString();},
    value=>{value.capturedAt=new Date(Date.parse(value.capturedAt)+1).toISOString();},
    value=>{const bytes=Buffer.from(value.archive,'base64');bytes[bytes.length-1]^=1;value.archive=bytes.toString('base64');value.archiveSha256=sha(bytes);},
    value=>{value.wrappedKey=randomBytes(384).toString('base64');},
  ];
  for(const mutate of mutations) {
    const envelope=structuredClone(original);mutate(envelope);
    await writeFile(envelopeFile,JSON.stringify(envelope));
    await assert.rejects(restoreSavedEnvelope({envelopeFile,keyFile:f.prepared.keyFile,parent,evidenceFile}));
    assert.deepEqual(await readdir(parent),[]);
    await assert.rejects(readFile(evidenceFile),{code:'ENOENT'});
  }
  const other=await prepareExport({identity,root:resolve(f.root,'other-recipient')});
  const otherKey=JSON.parse(await readFile(other.keyFile,'utf8'));
  const wrongKeyFile=resolve(f.root,'wrong-recipient.json');
  await writeFile(wrongKeyFile,JSON.stringify({...f.local,privateKey:otherKey.privateKey}));
  await writeFile(envelopeFile,f.envelopeBytes);
  await assert.rejects(restoreSavedEnvelope({envelopeFile,keyFile:wrongKeyFile,parent,evidenceFile}),/JEFF_BACKUP_ENVELOPE_INVALID/);
  assert.deepEqual(await readdir(parent),[]);
  await assert.rejects(readFile(evidenceFile),{code:'ENOENT'});
});

test('offline recovery verifies deep SQLite paths without a redundant long directory prefix', async t => {
  const f=await fixture(t,{deepDatabase:true}),envelopeFile=resolve(f.root,'saved.jeffenvelope'),parent=resolve(f.root,'recoveries');
  await writeFile(envelopeFile,f.envelopeBytes);await mkdir(parent);
  const result=await restoreSavedEnvelope({envelopeFile,keyFile:f.prepared.keyFile,parent,evidenceFile:resolve(f.root,'deep-receipt.json')});
  assert.equal(result.databasesQuickChecked,2);
  assert.equal(result.modelCalls,0);
  assert.equal(result.restoreGuardPresent,true);
});
