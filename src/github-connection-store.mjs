import {createCipheriv,createDecipheriv,randomBytes,randomUUID,createHash} from 'node:crypto';
import {mkdir,lstat,readFile,open,rename,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {scopeId} from './scope.mjs';
const schema='jeff-github-secret-v1';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fail=()=>{throw new Error('JEFF_GITHUB_STORAGE_UNAVAILABLE');};
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));

// Single-replica store, matching the hosted application's volume contract.
export function createGithubConnectionStore({dataRoot,key}) {
  if(!dataRoot||!Buffer.isBuffer(key)||key.length!==32)throw new Error('JEFF_GITHUB_CONFIG_INVALID');
  key=Buffer.from(key);
  const directory=resolve(dataRoot,'connectors','github');let queue=Promise.resolve();
  const serialize=work=>{const result=queue.then(work);queue=result.catch(()=>{});return result;};
  async function prepare(){
    for(const path of [resolve(dataRoot,'connectors'),directory]){
      await mkdir(path,{recursive:true,mode:0o700});const stat=await lstat(path);if(!stat.isDirectory()||stat.isSymbolicLink())fail();
    }
  }
  const aad=(id,generation)=>Buffer.from(schema+':'+id+':'+generation);
  async function load(id){
    await prepare();const file=join(directory,id+'.json');
    try{
      const stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>32768)fail();
      const envelope=JSON.parse(await readFile(file,'utf8'));
      if(!exact(envelope,['schema','scopeId','generation','nonce','tag','ciphertext'])||envelope.schema!==schema||envelope.scopeId!==id||!uuid.test(envelope.generation)
        ||! /^[a-f0-9]{24}$/.test(envelope.nonce)||! /^[a-f0-9]{32}$/.test(envelope.tag)||typeof envelope.ciphertext!=='string')fail();
      const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(envelope.nonce,'hex'));decipher.setAAD(aad(id,envelope.generation));decipher.setAuthTag(Buffer.from(envelope.tag,'hex'));
      const bytes=Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext,'base64')),decipher.final()]);let credential;
      try{credential=JSON.parse(bytes.toString('utf8'));}finally{bytes.fill(0);}
      if(!(credential===null||(typeof credential==='object'&&!Array.isArray(credential))))fail();
      return{generation:envelope.generation,credential};
    }catch(error){if(error.code==='ENOENT')return{generation:null,credential:null};fail();}
  }
  async function save(id,value,beforeCommit){
    await prepare();const file=join(directory,id+'.json'),temporary=file+'.'+randomUUID()+'.tmp';
    const plaintext=Buffer.from(JSON.stringify(value.credential));if(plaintext.length>16384){plaintext.fill(0);fail();}
    const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(aad(id,value.generation));let ciphertext;
    try{ciphertext=Buffer.concat([cipher.update(plaintext),cipher.final()]);}finally{plaintext.fill(0);}
    const envelope={schema,scopeId:id,generation:value.generation,nonce:nonce.toString('hex'),tag:cipher.getAuthTag().toString('hex'),ciphertext:ciphertext.toString('base64')};
    let handle;
    try{
      try{handle=await open(temporary,'wx',0o600);await handle.writeFile(JSON.stringify(envelope));await handle.sync();await handle.close();handle=undefined;}
      catch{fail();}
      if(beforeCommit)await beforeCommit();
      try{await rename(temporary,file);}catch{fail();}
    }
    finally{if(handle)await handle.close().catch(()=>{});await rm(temporary,{force:true}).catch(()=>{});ciphertext.fill(0);}
  }
  return Object.freeze({
    read(scope){const id=scopeId(scope);return serialize(()=>load(id));},
    guard(scope,generation,work){const id=scopeId(scope);return serialize(async()=>{
      const value=await load(id);if(value.generation!==generation||!value.credential)throw new Error('JEFF_GITHUB_CONNECTION_CHANGED');
      return work(structuredClone(value));
    });},
    replace(scope,generation,credential,{beforeCommit}={}){const id=scopeId(scope),copy=structuredClone(credential);return serialize(async()=>{
      const prior=await load(id);if(prior.generation!==generation)throw new Error('JEFF_GITHUB_CONNECTION_CHANGED');
      if(!copy||typeof copy!=='object'||Array.isArray(copy))throw new Error('JEFF_GITHUB_CREDENTIAL_INVALID');
      if(beforeCommit!==undefined&&typeof beforeCommit!=='function')throw new Error('JEFF_GITHUB_CONFIG_INVALID');
      const next={generation:randomUUID(),credential:copy};await save(id,next,beforeCommit);return structuredClone(next);
    });},
    disconnect(scope){const id=scopeId(scope);return serialize(async()=>{
      const prior=await load(id),next={generation:randomUUID(),credential:null};await save(id,next);
      return{generation:next.generation,credential:prior.credential};
    });},
  });
}

export function createGithubAuthorizationStates({now=()=>Date.now(),limit=1000}={}){
  if(!Number.isSafeInteger(limit)||limit<1||limit>1000)throw new Error('JEFF_GITHUB_CONFIG_INVALID');
  const pending=new Map(),hash=value=>createHash('sha256').update(value).digest('hex');
  const prune=()=>{for(const[state,value]of pending)if(value.expiresAt<=now())pending.delete(state);};
  return Object.freeze({
    issue({scope,session,generation}){
      prune();if(typeof session!=='string'||!session||session.length>256)throw new Error('JEFF_SESSION_REQUIRED');
      if(pending.size>=limit)throw new Error('JEFF_GITHUB_BUSY');
      const state=randomBytes(32).toString('base64url'),verifier=randomBytes(32).toString('base64url'),expiresAt=now()+300000;
      pending.set(hash(state),{scope:structuredClone(scope),scopeId:scopeId(scope),sessionHash:hash(session),generation,verifier,expiresAt});
      return{state,codeChallenge:createHash('sha256').update(verifier).digest('base64url'),codeChallengeMethod:'S256',expiresAt:new Date(expiresAt).toISOString()};
    },
    consume({state,scope,session}){
      prune();if(typeof state!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(state))throw new Error('JEFF_GITHUB_STATE_INVALID');
      const id=hash(state),value=pending.get(id);pending.delete(id);
      if(!value||value.scopeId!==scopeId(scope)||typeof session!=='string'||value.sessionHash!==hash(session))throw new Error('JEFF_GITHUB_STATE_INVALID');
      return{scope:structuredClone(value.scope),generation:value.generation,verifier:value.verifier};
    },
  });
}
