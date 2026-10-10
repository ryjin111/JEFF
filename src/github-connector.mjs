import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import {createGithubAuthorizationStates} from './github-connection-store.mjs';
import {scopeId} from './scope.mjs';
const failure=code=>new Error('JEFF_GITHUB_'+code);
const hash=value=>createHash('sha256').update(value).digest();
const cookieName='__Host-jeff-github';
export const githubClearCookie=cookieName+'=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
export function githubJobRequest(input){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==3||!Object.keys(input).every(key=>['repositoryId','generation','consent'].includes(key))||input.consent!==true||typeof input.repositoryId!=='string'||! /^[1-9][0-9]{0,15}$/.test(input.repositoryId)||typeof input.generation!=='string'||! /^[a-f0-9-]{36}$/.test(input.generation))throw failure('CONSENT_INVALID');
  return{repositoryId:input.repositoryId,generation:input.generation,consent:true};
}
// Pending bearer tokens live only in this process for the five-minute exchange.
// The browser receives an independent HttpOnly binding, never its bearer in a URL.
export function createGithubConnector({store,provider,authenticate,authorizeScope,requireExecution=()=>{},cancel=()=>{},now=()=>Date.now()}){
  const states=createGithubAuthorizationStates({now}),pending=new Map();
  const prune=()=>{for(const[key,value]of pending)if(value.expiresAt<=now())pending.delete(key);};
  const authority=async(scope,session)=>{
    if(session){const current=await authenticate(session);if(scopeId(current)!==scopeId(scope))throw failure('AUTHORITY_CHANGED');}
    await authorizeScope(scope);
  };
  const configured=()=>{if(!store||!provider)throw failure('NOT_CONFIGURED');};
  const usable=value=>{
    if(!value.credential)throw failure('NOT_CONNECTED');
    if(value.credential.reconnectRequired||!Number.isFinite(value.credential.expiresAt)||value.credential.expiresAt<=now())throw failure('RECONNECT_REQUIRED');
  };
  async function assert(scope,generation,session){configured();requireExecution();await authority(scope,session);const value=await store.read(scope);if(value.generation!==generation)throw failure('CONNECTION_CHANGED');usable(value);return value;}
  async function providerRead(scope,value,work){
    try{return await work();}
    catch(error){
      if(['JEFF_GITHUB_RECONNECT_REQUIRED','JEFF_GITHUB_ACCESS_UNAVAILABLE','JEFF_GITHUB_PERMISSIONS_INVALID','JEFF_GITHUB_PERMISSIONS_UNVERIFIED'].includes(error.message))await store.replace(scope,value.generation,{...value.credential,reconnectRequired:true}).catch(()=>{});
      throw error;
    }
  }
  return Object.freeze({
    async status(scope){
      await authority(scope);
      if(!provider||!store)return{status:'not_configured',account:null,permissions:null,generation:null};
      try{const value=await store.read(scope);return{status:!value.credential?'not_connected':value.credential.reconnectRequired||value.credential.expiresAt<=now()?'reconnect_required':'connected',account:value.credential?.account??null,permissions:value.credential?.permissions??null,generation:value.generation};}
      catch{return{status:'unavailable',account:null,permissions:null,generation:null};}
    },
    async authorize(scope,session){
      configured();requireExecution();await authority(scope,session);prune();
      const value=await store.read(scope),attempt=states.issue({scope,session,generation:value.generation}),binding=randomBytes(32).toString('base64url');
      pending.set(attempt.state,{scope:structuredClone(scope),session,bindingHash:hash(binding),expiresAt:Date.parse(attempt.expiresAt)});
      return{authorizationUrl:provider.authorization(attempt),expiresAt:attempt.expiresAt,cookie:cookieName+'='+binding+'; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=300'};
    },
    async callback({state,code,cookie,denied=false}){
      configured();prune();const context=pending.get(state);pending.delete(state);
      if(!context)throw failure('STATE_INVALID');
      // Consume even a denied or incorrectly bound callback before any awaits.
      const attempt=states.consume({state,scope:context.scope,session:context.session});
      const cookies=typeof cookie==='string'?cookie.split(';').map(value=>value.trim()).filter(value=>value.startsWith(cookieName+'=')):[];
      const binding=cookies.length===1?cookies[0].slice(cookieName.length+1):'';
      if(denied||! /^[A-Za-z0-9_-]{43}$/.test(binding)||!timingSafeEqual(hash(binding),context.bindingHash))throw failure('STATE_INVALID');
      requireExecution();await authority(context.scope,context.session);
      const prior=await store.read(context.scope);if(prior.generation!==attempt.generation)throw failure('CONNECTION_CHANGED');
      const credential=await provider.exchange({code,verifier:attempt.verifier});
      try{requireExecution();await authority(context.scope,context.session);await store.replace(context.scope,attempt.generation,credential);}
      catch(error){await provider.revoke(credential.accessToken).catch(()=>{});throw error;}
      return true;
    },
    assert,
    async repositories(scope,session){
      configured();const value=await store.read(scope);await assert(scope,value.generation,session);
      const result=await providerRead(scope,value,()=>provider.repositories(value.credential.accessToken));
      await assert(scope,value.generation,session);return{generation:value.generation,...result};
    },
    async read(scope,input,{session,signal}={}){
      const request=githubJobRequest(input),value=await assert(scope,request.generation,session);
      const result=await providerRead(scope,value,()=>provider.latest(value.credential.accessToken,request.repositoryId,signal));
      await assert(scope,request.generation,session);if(signal?.aborted)throw failure('CANCELLED');return result;
    },
    async commit(scope,generation,work,session){
      configured();requireExecution();await authority(scope,session);
      return store.guard(scope,generation,async value=>{usable(value);requireExecution();await authority(scope,session);return work();});
    },
    async disconnect(scope,session){
      configured();await authority(scope,session);
      const value=await store.disconnect(scope);cancel(scope);
      for(const[key,context]of pending)if(scopeId(context.scope)===scopeId(scope))pending.delete(key);
      let providerRevoked=false;if(value.credential)try{providerRevoked=await provider.revoke(value.credential.accessToken)===true;}catch{}
      return{localDisconnected:true,providerRevoked};
    },
  });
}
