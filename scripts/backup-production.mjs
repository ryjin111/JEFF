import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { decryptBackup } from '../src/backup.mjs';
import { verifyIsolatedRestore } from '../scripts/backup-restore.mjs';

const root = resolve(import.meta.dirname, '..');
const [sshTarget, sshKey, knownHosts] = process.argv.slice(2);
if (!sshTarget || !sshKey || !knownHosts) throw new Error('Usage: node scripts/backup-production.mjs SSH_TARGET SSH_KEY KNOWN_HOSTS');
await mkdir(resolve(root, '.private'), { recursive: true, mode: 0o700 });
const keyPath = resolve(root, '.private/backup-key.bin');
let key;
try { key = await readFile(keyPath); }
catch (error) { if (error.code !== 'ENOENT') throw error; key = randomBytes(32); await writeFile(keyPath, key, { flag: 'wx', mode: 0o600 }); }
function restrictWindows(path, directory = false) {
  if(process.platform!=='win32') return;
  const identity=process.env.USERDOMAIN+'\\'+process.env.USERNAME;
  execFileSync('icacls.exe',[path,'/inheritance:r','/grant:r',identity+':'+(directory?'(OI)(CI)(F)':'(F)')],{stdio:['ignore','pipe','pipe'],windowsHide:true});
}
restrictWindows(keyPath);
const moduleSource = await readFile(resolve(root, 'src/backup.mjs'), 'utf8');
const program = `
import { readdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
const backup = await import('data:text/javascript;base64,${Buffer.from(moduleSource).toString('base64')}');
async function processes() {
  const found=[];
  for (const name of await readdir('/proc')) {
    if (!/^\\d+$/.test(name)) continue;
    try {
      const args=(await readFile('/proc/'+name+'/cmdline','utf8')).split('\\0');
      const status=await readFile('/proc/'+name+'/status','utf8');
      found.push({pid:Number(name),parent:Number(status.match(/^PPid:\\s+(\\d+)/m)[1]),state:status.match(/^State:\\s+(\\w)/m)?.[1],args});
    } catch {}
  }
  return found;
}
const servers=(await processes()).filter(p=>p.args.some(a=>/^(?:\\/app\\/)?src\\/server\\.mjs$/.test(a)));
if (servers.length!==1) throw new Error('BACKUP_SINGLE_SERVER_REQUIRED');
const server=servers[0];
await readFile('/app/src/maintenance.mjs');
const status=await readFile('/proc/'+server.pid+'/status','utf8');
if(!(BigInt('0x'+status.match(/^SigCgt:\\s+(\\w+)/m)[1]) & (1n<<11n))) throw new Error('BACKUP_MAINTENANCE_HANDLER_REQUIRED');
try { await readFile('/tmp/simple-jeff-maintenance.json'); throw new Error('BACKUP_ALREADY_IN_MAINTENANCE'); }
catch(error) { if(error.code!=='ENOENT') throw error; }
const watchdog=spawn(process.execPath,['-e','setTimeout(()=>{try{process.kill('+server.pid+',"SIGCONT")}catch{}},30000)'],{detached:true,stdio:'ignore'});
watchdog.unref();
let snapshot,pausedAt,resumedAt;
try {
  process.kill(server.pid,'SIGUSR2'); pausedAt=new Date().toISOString();
  let ready=false;
  for(let attempt=0;attempt<100;attempt++) {
    try { ready=JSON.parse(await readFile('/tmp/simple-jeff-maintenance.json','utf8')).status==='ready'; } catch {}
    if(ready) break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  if(!ready) throw new Error('BACKUP_MAINTENANCE_NOT_READY');
  const procs=await processes();
  if (procs.some(p=>p.state!=='Z' && (p.parent===server.pid || p.args.some(a=>a.includes('openclaw.mjs'))))) throw new Error('BACKUP_RUNTIME_WRITER_ACTIVE');
  if (!process.env.JEFF_DATA_ROOT || process.env.JEFF_DATA_ROOT!=='/data') throw new Error('BACKUP_DATA_ROOT_UNEXPECTED');
  snapshot=await backup.captureBackup({dataRoot:'/data',writersQuiesced:true});
  if(Date.now()-Date.parse(pausedAt)>25000) throw new Error('BACKUP_WINDOW_EXCEEDED');
} finally {
  process.kill(server.pid,'SIGCONT');
  let resumed=false;
  for(let attempt=0;attempt<50;attempt++) {
    try { resumed=(await fetch('http://127.0.0.1:'+(process.env.PORT||8788)+'/health',{signal:AbortSignal.timeout(500)})).status===200; } catch {}
    if(resumed) break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  if(!resumed) throw new Error('BACKUP_RESUME_NOT_VERIFIED');
  resumedAt=new Date().toISOString();
  try { process.kill(watchdog.pid); } catch {}
}
const key=Buffer.from('${key.toString('base64')}','base64');
console.log(JSON.stringify({archiveBase64:backup.encryptBackup(snapshot,key).toString('base64'),pausedAt,resumedAt,serverPid:server.pid,releaseSha:process.env.JEFF_RELEASE_SHA,sourceUnchanged:true}));
`;
const raw = execFileSync(process.platform==='win32' ? 'C:/Windows/System32/OpenSSH/ssh.exe' : 'ssh', ['-T', '-i', resolve(sshKey),
  '-o','BatchMode=yes','-o','ConnectTimeout=15','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile='+resolve(knownHosts),
  sshTarget,'node --input-type=module'],
  {input:program,encoding:'utf8',windowsHide:true,stdio:['pipe','pipe','pipe'],timeout:45000,maxBuffer:128*1024*1024});
const remote=JSON.parse(raw.trim());
const archive=Buffer.from(remote.archiveBase64,'base64');
const snapshot=decryptBackup(archive,key);
const backupDirectory=resolve(root,'.private/backups');
await mkdir(backupDirectory,{recursive:true,mode:0o700});
restrictWindows(backupDirectory,true);
const archivePath=resolve(backupDirectory,'production-'+snapshot.capturedAt.replaceAll(/[:.]/g,'-')+'.jeffbk');
await writeFile(archivePath,archive,{flag:'wx',mode:0o600});
const storedArchive=await readFile(archivePath);
if(!storedArchive.equals(archive)) throw new Error('BACKUP_OFF_HOST_WRITE_FAILED');
const restored=await verifyIsolatedRestore({archive:storedArchive,key:await readFile(keyPath),parent:backupDirectory});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const evidence={...restored,productionBackup:true,encryptedOffHostArchive:archivePath,archiveSha256:sha(archive),archiveBytes:archive.length,
  releaseSha:remote.releaseSha,sourceUnchangedDuringCapture:remote.sourceUnchanged,
  pausedAt:remote.pausedAt,resumedAt:remote.resumedAt,pauseMs:Date.parse(remote.resumedAt)-Date.parse(remote.pausedAt),
  sourceManifest:snapshot.files.map(({path,size,sha256})=>({path,size,sha256})),
  excludedPaths:snapshot.excludedPaths,
  configBackupIncluded:false,recurringBackupEnabled:false,
  limitations:['Service variables and provider credentials require separate secure configuration recovery.','This is a one-time drill. Recurring backup and post-checkpoint payment reconciliation are not configured.']};
await writeFile(resolve(root,'evidence/production-backup-restore.json'),JSON.stringify(evidence,null,2));
console.log(JSON.stringify({...evidence,sourceManifest:undefined}));
