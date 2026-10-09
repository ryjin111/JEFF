import { createHash, generateKeyPairSync, privateDecrypt, createPublicKey, randomBytes, constants } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { decryptBackup } from '../src/backup.mjs';
import { verifyIsolatedRestore } from './backup-restore.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
function restrict(path) {
  if (process.platform === 'win32') execFileSync('icacls.exe', [path, '/inheritance:r', '/grant:r',
    `${process.env.USERDOMAIN}\\${process.env.USERNAME}:(OI)(CI)(F)`], {stdio:'pipe',windowsHide:true});
}

export async function prepareExport({ identity, root = resolve('.private'), now = Date.now(), ttlMs = 600000 }) {
  const fields=['RAILWAY_PROJECT_ID','RAILWAY_ENVIRONMENT_ID','RAILWAY_SERVICE_ID','JEFF_PUBLIC_ORIGIN','JEFF_RELEASE_SHA','RAILWAY_VOLUME_MOUNT_PATH'];
  try {
    const origin=new URL(identity.JEFF_PUBLIC_ORIGIN);
    if(Object.keys(identity).length!==fields.length || fields.some(key=>typeof identity[key]!=='string')
      || fields.slice(0,3).some(key=>!/^[a-f0-9-]{36}$/.test(identity[key]))
      || !/^[a-f0-9]{40}$/.test(identity.JEFF_RELEASE_SHA) || identity.RAILWAY_VOLUME_MOUNT_PATH!=='/data'
      || origin.protocol!=='https:' || origin.origin!==identity.JEFF_PUBLIC_ORIGIN || !Number.isFinite(now)
      || !Number.isSafeInteger(ttlMs) || ttlMs < 60000 || ttlMs > 600000)throw new Error();
  }catch{throw new Error('JEFF_BACKUP_CLIENT_IDENTITY_INVALID');}
  const keyRoot = resolve(root,'backup-keys'), archiveRoot=resolve(root,'backups');
  await mkdir(keyRoot,{recursive:true,mode:0o700});restrict(keyRoot);
  await mkdir(archiveRoot,{recursive:true,mode:0o700});restrict(archiveRoot);
  const nonce=randomBytes(16).toString('hex'),token=randomBytes(32).toString('base64url');
  const {publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:3072});
  const config={schema:'jeff-startup-backup-export-v1',nonce,tokenSha256:sha(token),
    publicKey:publicKey.export({type:'spki',format:'pem'}),expiresAt:new Date(now+ttlMs).toISOString(),expected:identity};
  const keyFile=resolve(keyRoot,`${nonce}.json`), configFile=resolve(keyRoot,`${nonce}.public.json`);
  await writeFile(keyFile,JSON.stringify({schema:'jeff-backup-local-key-v1',config,token,privateKey:privateKey.export({type:'pkcs8',format:'pem'})}),{flag:'wx',mode:0o600});
  await writeFile(configFile,JSON.stringify(config),{flag:'wx',mode:0o600});
  return {keyFile,configFile,archiveRoot,expiresAt:config.expiresAt};
}

export async function downloadAndVerify({keyFile,archiveRoot,evidenceFile,fetchImpl=fetch}) {
  const local=JSON.parse(await readFile(keyFile,'utf8')), config=local.config;
  const origin=config.expected.JEFF_PUBLIC_ORIGIN;
  if (local.schema!=='jeff-backup-local-key-v1' || new URL(origin).origin!==origin || !origin.startsWith('https://')
    || !/^[a-f0-9]{32}$/.test(config.nonce) || !Number.isFinite(Date.parse(config.expiresAt)) || Date.parse(config.expiresAt)<=Date.now()
    || !/^[A-Za-z0-9_-]{43}$/.test(local.token) || sha(local.token)!==config.tokenSha256) throw new Error('JEFF_BACKUP_CLIENT_CONFIG_INVALID');
  const response=await fetchImpl(`${origin}/api/operator/backup/${config.nonce}`,{headers:{authorization:`Bearer ${local.token}`},redirect:'error',signal:AbortSignal.timeout(45000)});
  if(response.status!==200 || !response.headers.get('cache-control')?.includes('no-store')) throw new Error('JEFF_BACKUP_EXPORT_DOWNLOAD_FAILED');
  const chunks=[];let size=0;
  for await(const chunk of response.body){size+=chunk.length;if(size>128*1024*1024)throw new Error('JEFF_BACKUP_EXPORT_TOO_LARGE');chunks.push(chunk);}
  const bytes=Buffer.concat(chunks,size), envelope=JSON.parse(bytes);
  if(envelope.schema!=='jeff-encrypted-backup-envelope-v1' || envelope.nonce!==config.nonce || envelope.releaseSha!==config.expected.JEFF_RELEASE_SHA
    || envelope.expiresAt!==config.expiresAt || envelope.keyAlgorithm!=='RSA-OAEP-SHA256' || envelope.archiveAlgorithm!=='AES-256-GCM') throw new Error('JEFF_BACKUP_ENVELOPE_INVALID');
  const keyId=sha(createPublicKey(local.privateKey).export({type:'spki',format:'der'}));
  if(envelope.keyId!==keyId)throw new Error('JEFF_BACKUP_ENVELOPE_INVALID');
  const archive=Buffer.from(envelope.archive,'base64');
  if(sha(archive)!==envelope.archiveSha256)throw new Error('JEFF_BACKUP_ENVELOPE_INVALID');
  const key=privateDecrypt({key:local.privateKey,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},Buffer.from(envelope.wrappedKey,'base64'));
  try {
    const snapshot=decryptBackup(archive,key);
    if(snapshot.sourceRoot!=='/data' || snapshot.capturedAt!==envelope.capturedAt || snapshot.export?.nonce!==config.nonce
      || snapshot.export.releaseSha!==envelope.releaseSha || snapshot.export.keyId!==keyId || snapshot.export.expiresAt!==envelope.expiresAt)throw new Error('JEFF_BACKUP_ENVELOPE_INVALID');
    await mkdir(archiveRoot,{recursive:true,mode:0o700});restrict(archiveRoot);
    const archiveFile=resolve(archiveRoot,`staging-${config.nonce}.jeffenvelope`);
    await writeFile(archiveFile,bytes,{flag:'wx',mode:0o600});
    if(sha(await readFile(archiveFile))!==sha(bytes))throw new Error('JEFF_BACKUP_OFF_HOST_WRITE_FAILED');
    const proof=await verifyIsolatedRestore({archive,key,parent:archiveRoot});
    if(!proof.operatorJob || proof.jobsRetrieved<1)throw new Error('JEFF_BACKUP_OPERATOR_RESULT_REQUIRED');
    const receipt={...proof,stageOnly:true,origin,releaseSha:envelope.releaseSha,encryptedOffHostArchive:archiveFile,
      archiveSha256:sha(archive),archiveBytes:archive.length,envelopeSha256:sha(bytes),envelopeBytes:bytes.length,
      transport:'verified HTTPS, no redirects, independent short-lived bearer hash',capturePhase:'before application startup',
      privateKeySentToServer:false,secretsPrinted:false,holderSessionUsed:false,recurringBackupEnabled:false,
      restoredIn:'isolated restricted local directory',cloudRuntimeRestoreVerified:false,
      keyStorage:'separate restricted directory on this workstation; independently retain recovery key before relying on this archive',
      limitations:['Service variables and credentials require separate secure recovery.','This one-time drill does not verify a cloud runtime restore or recurring off-machine backup policy.','Post-checkpoint financial/schedule reconciliation remains mandatory before removing a restore guard.']};
    await writeFile(evidenceFile,JSON.stringify(receipt,null,2)+'\n');
    return receipt;
  } finally {key.fill(0);}
}

if(process.argv[1]===import.meta.filename){
  try {
    const [command,...args]=process.argv.slice(2);
    if(command==='prepare'){
      const identity=JSON.parse(await readFile(args[0],'utf8'));
      console.log(JSON.stringify(await prepareExport({identity})));
    }else if(command==='download'){
      const result=await downloadAndVerify({keyFile:resolve(args[0]),archiveRoot:resolve(args[1]),evidenceFile:resolve(args[2])});
      console.log(JSON.stringify({filesVerified:result.filesVerified,databasesQuickChecked:result.databasesQuickChecked,jobsRetrieved:result.jobsRetrieved,manifestSha256:result.manifestSha256,archiveSha256:result.archiveSha256,releaseSha:result.releaseSha,modelCalls:result.modelCalls,liveDataOverwritten:result.liveDataOverwritten,cloudRuntimeRestoreVerified:false}));
    }else throw new Error('JEFF_BACKUP_CLIENT_COMMAND_INVALID');
  }catch(error){console.error(/^JEFF_[A-Z_]+$/.test(error.message)?error.message:'JEFF_BACKUP_CLIENT_FAILED');process.exitCode=1;}
}
