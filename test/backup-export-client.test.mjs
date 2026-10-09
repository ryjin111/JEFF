import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createJeffOpenClawNftBridge } from 'jeff-agent-nft/openclaw';
import { prepareExport, downloadAndVerify } from '../scripts/backup-export-client.mjs';
import { prepareStartupBackup } from '../src/startup-backup.mjs';
import { captureBackup } from '../src/backup.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const identity = { RAILWAY_PROJECT_ID:'11111111-1111-1111-1111-111111111111',
  RAILWAY_ENVIRONMENT_ID:'22222222-2222-2222-2222-222222222222',
  RAILWAY_SERVICE_ID:'33333333-3333-3333-3333-333333333333',
  JEFF_PUBLIC_ORIGIN:'https://stage.invalid', JEFF_RELEASE_SHA:'1'.repeat(40), RAILWAY_VOLUME_MOUNT_PATH:'/data' };

async function fixture(t) {
  const root = await mkdtemp(resolve(tmpdir(),'jeff-backup-export-client-'));
  let backup;
  t.after(async()=>{ backup?.dispose(); await rm(root,{recursive:true,force:true}); });
  const source = resolve(root,'source'); await mkdir(source);
  const prepared = await prepareExport({identity,root:resolve(root,'private')});
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
  backup = await prepareStartupBackup({env:{...identity,JEFF_DATA_ROOT:'/data',JEFF_STARTUP_BACKUP_EXPORT:JSON.stringify(local.config)},
    capture:async options=>({...await captureBackup({...options,dataRoot:source}),sourceRoot:'/data'})});
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
