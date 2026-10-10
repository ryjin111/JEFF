import {lookup as dnsLookup} from 'node:dns/promises';
import {request as httpsRequest} from 'node:https';
import {publicIPv4} from './web-research.mjs';

const failure=code=>new Error('JEFF_GITHUB_'+code);
const id=value=>Number.isSafeInteger(value)&&value>0?String(value):null;
const login=value=>typeof value==='string'&&/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(value);
const repository=value=>typeof value==='string'&&/^[A-Za-z0-9_.-]{1,100}$/.test(value)&&!['.','..'].includes(value);
const token=value=>typeof value==='string'&&/^ghu_[A-Za-z0-9_]{20,255}$/.test(value);

// No proxy environment, redirects, shared sockets, or caller-selected destinations.
export async function githubTransport({url,method='GET',headers={},body,signal},{lookup=dnsLookup,request=httpsRequest}={}){
  const target=new URL(url);
  if(!['github.com','api.github.com'].includes(target.hostname)||target.protocol!=='https:'||target.port||target.username||target.password||target.hash)throw failure('DESTINATION_DENIED');
  const allowed=target.hostname==='github.com'
    ?method==='POST'&&target.pathname==='/login/oauth/access_token'&&!target.search
    :(method==='GET'&&(/^\/user$/.test(target.pathname)||/^\/user\/installations$/.test(target.pathname)||/^\/user\/installations\/[1-9][0-9]*\/repositories$/.test(target.pathname)||/^\/repos\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+\/releases\/latest$/.test(target.pathname)))
      ||method==='DELETE'&&/^\/applications\/[A-Za-z0-9_]+\/token$/.test(target.pathname)&&!target.search;
  if(!allowed||[...target.searchParams].some(([key,value])=>!['per_page','page'].includes(key)||!/^\d{1,2}$/.test(value)))throw failure('DESTINATION_DENIED');
  const combined=AbortSignal.any([AbortSignal.timeout(8000),...(signal?[signal]:[])]);
  let abortLookup;
  let addresses;
  try{addresses=await Promise.race([lookup(target.hostname,{family:4,all:true}),new Promise((_,reject)=>{abortLookup=()=>reject(failure('CANCELLED'));combined.addEventListener('abort',abortLookup,{once:true});if(combined.aborted)abortLookup();})]);}
  catch{throw failure(combined.aborted?'CANCELLED':'UNAVAILABLE');}
  finally{combined.removeEventListener('abort',abortLookup);}
  if(!addresses?.length||addresses.some(value=>value.family!==4||!publicIPv4(value.address)))throw failure('ADDRESS_DENIED');
  if(combined.aborted)throw failure('CANCELLED');
  return new Promise((resolve,reject)=>{
    let req,settled=false;
    const finish=(error,result)=>{if(settled)return;settled=true;combined.removeEventListener('abort',abort);error?reject(error):resolve(result);};
    const abort=()=>{finish(failure('CANCELLED'));req?.destroy();};
    combined.addEventListener('abort',abort,{once:true});
    try{
      req=request(target,{method,agent:false,maxHeaderSize:8192,headers:{accept:'application/json','accept-encoding':'identity','user-agent':'Jeff-read-only-connector',...headers},lookup:(_host,options,callback)=>options?.all?callback(null,[addresses[0]]):callback(null,addresses[0].address,4)},res=>{
        if(res.statusCode>=300&&res.statusCode<400){finish(failure('REDIRECT_DENIED'));res.destroy();return;}
        if(res.headers['content-encoding']&&res.headers['content-encoding']!=='identity'){finish(failure('DATA_INVALID'));res.destroy();return;}
        const chunks=[];let size=0;
        res.on('data',chunk=>{size+=chunk.length;if(size>131072){finish(failure('RESPONSE_TOO_LARGE'));res.destroy();}else chunks.push(chunk);});
        res.on('error',()=>finish(failure('UNAVAILABLE')));
        res.on('end',()=>{if(settled)return;try{const bytes=Buffer.concat(chunks);const json=bytes.length?JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)):null;finish(null,{status:res.statusCode,json});}catch{finish(failure('DATA_INVALID'));}});
      });
      req.on('error',()=>finish(failure('UNAVAILABLE')));req.end(body);
      if(combined.aborted)abort();
    }catch{finish(failure('UNAVAILABLE'));}
  });
}

export function createGithubProvider({clientId,clientSecret,appId,callbackUrl,transport=githubTransport,now=()=>Date.now()}){
  if(typeof clientId!=='string'||!/^Iv[0-9A-Za-z_.]{5,100}$/.test(clientId)||typeof clientSecret!=='string'||clientSecret.length<20||!/^\d{1,16}$/.test(String(appId)))throw failure('CONFIG_INVALID');
  const callback=new URL(callbackUrl);
  if(callback.protocol!=='https:'||callback.username||callback.password||callback.search||callback.hash||callback.pathname!=='/api/connectors/github/callback')throw failure('CONFIG_INVALID');
  async function call(path,{accessToken,method='GET',body,basic=false,signal,allow404=false}={}){
    if(accessToken&&!token(accessToken))throw failure('CREDENTIAL_INVALID');
    const response=await transport({url:(path==='/login/oauth/access_token'?'https://github.com':'https://api.github.com')+path,method,signal,body,
      headers:{...(accessToken?{authorization:'Bearer '+accessToken}:{}),...(basic?{authorization:'Basic '+Buffer.from(clientId+':'+clientSecret).toString('base64')}:{}),...(body?{'content-type':path==='/login/oauth/access_token'?'application/x-www-form-urlencoded':'application/json'}:{})}});
    if(response.status===401)throw failure('RECONNECT_REQUIRED');
    if(response.status===403||response.status===429)throw failure('ACCESS_UNAVAILABLE');
    if(response.status===404&&allow404)return null;
    if(response.status<200||response.status>=300)throw failure('UNAVAILABLE');
    return response.json;
  }
  async function repositories(accessToken,signal){
    const result=await call('/user/installations?per_page=5&page=1',{accessToken,signal});
    if(!Array.isArray(result?.installations)||result.installations.length>5||!Number.isSafeInteger(result.total_count)||result.total_count<result.installations.length)throw failure('DATA_INVALID');
    const found=[];let hasMore=result.total_count>result.installations.length,verifiedInstallations=0;
    for(const installation of result.installations){
      if(String(installation.app_id)!==String(appId))continue;
      if(!id(installation.id)||installation.client_id!==clientId||!installation.permissions||Object.entries(installation.permissions).some(([key,value])=>!['metadata','contents'].includes(key)||value!=='read')||installation.permissions.metadata!=='read'||installation.permissions.contents!=='read')throw failure('PERMISSIONS_INVALID');
      verifiedInstallations++;
      const page=await call('/user/installations/'+id(installation.id)+'/repositories?per_page=5&page=1',{accessToken,signal});
      if(!Array.isArray(page?.repositories)||page.repositories.length>5||!Number.isSafeInteger(page.total_count)||page.total_count<page.repositories.length)throw failure('DATA_INVALID');
      hasMore ||= page.total_count>page.repositories.length;
      for(const item of page.repositories){
        if(!id(item.id)||!login(item.owner?.login)||!repository(item.name)||item.full_name!==item.owner.login+'/'+item.name)throw failure('DATA_INVALID');
        if(!found.some(value=>value.id===id(item.id)))found.push({id:id(item.id),name:item.full_name});
      }
    }
    if(!verifiedInstallations)throw failure('PERMISSIONS_UNVERIFIED');
    return{repositories:found,coverage:{shown:found.length,hasMore}};
  }
  return Object.freeze({
    authorization({state,codeChallenge}){
      if(!/^[A-Za-z0-9_-]{43}$/.test(state)||!/^[A-Za-z0-9_-]{43}$/.test(codeChallenge))throw failure('STATE_INVALID');
      const url=new URL('https://github.com/login/oauth/authorize');url.search=new URLSearchParams({client_id:clientId,redirect_uri:callback.href,state,code_challenge:codeChallenge,code_challenge_method:'S256',allow_signup:'false'}).toString();return url.href;
    },
    async exchange({code,verifier,signal}){
      if(typeof code!=='string'||! /^[A-Za-z0-9_-]{1,512}$/.test(code)||! /^[A-Za-z0-9_-]{43}$/.test(verifier))throw failure('STATE_INVALID');
      const value=await call('/login/oauth/access_token',{method:'POST',signal,body:new URLSearchParams({client_id:clientId,client_secret:clientSecret,code,redirect_uri:callback.href,code_verifier:verifier}).toString()});
      if(!token(value?.access_token)||value.token_type!=='bearer'||value.scope!==''||!Number.isSafeInteger(value.expires_in)||value.expires_in<1||value.expires_in>28800)throw failure('TOKEN_INVALID');
      try{
        const user=await call('/user',{accessToken:value.access_token,signal});
        if(!id(user?.id)||!login(user.login))throw failure('IDENTITY_INVALID');
        await repositories(value.access_token,signal);
        return{accessToken:value.access_token,expiresAt:now()+value.expires_in*1000,account:{id:id(user.id),login:user.login},permissions:{metadata:'read',contents:'read'}};
      }catch(error){await call('/applications/'+clientId+'/token',{method:'DELETE',basic:true,body:JSON.stringify({access_token:value.access_token})}).catch(()=>{});throw error;}
    },
    repositories,
    async latest(accessToken,repositoryId,signal){
      if(typeof repositoryId!=='string'||! /^[1-9][0-9]{0,15}$/.test(repositoryId))throw failure('REPOSITORY_INVALID');
      const grant=await repositories(accessToken,signal),selected=grant.repositories.find(value=>value.id===repositoryId);
      if(!selected)throw failure('REPOSITORY_UNAVAILABLE');
      const release=await call('/repos/'+selected.name+'/releases/latest',{accessToken,signal,allow404:true});
      if(!release)throw failure('RELEASE_UNAVAILABLE');
      if(typeof release.tag_name!=='string'||!release.tag_name||release.tag_name.length>256||typeof release.name!=='string'&&release.name!==null||typeof release.body!=='string'&&release.body!==null||typeof release.published_at!=='string'||!Number.isFinite(Date.parse(release.published_at))||release.draft!==false||release.prerelease!==false)throw failure('DATA_INVALID');
      const fields={tag:release.tag_name,name:release.name?.slice(0,256),publishedAt:release.published_at,body:release.body?.slice(0,1600)};
      let excerpt=JSON.stringify(fields),excerptTruncated=(release.body?.length??0)>1600;
      while(excerpt.length>2400){excerptTruncated=true;if(fields.body?.length)fields.body=fields.body.slice(0,Math.max(0,fields.body.length-128));else if(fields.name?.length)fields.name=fields.name.slice(0,Math.max(0,fields.name.length-64));else if(fields.tag.length)fields.tag=fields.tag.slice(0,Math.max(0,fields.tag.length-64));else throw failure('DATA_INVALID');excerpt=JSON.stringify(fields);}
      return{url:'https://github.com/'+selected.name+'/releases/tag/'+encodeURIComponent(release.tag_name),retrievedAt:new Date(now()).toISOString(),excerpt,format:'json',excerptTruncated,truncated:excerptTruncated,coverage:'Latest published release only; serialized excerpt limited to 2400 characters.'};
    },
    async revoke(accessToken,signal){if(!token(accessToken))throw failure('CREDENTIAL_INVALID');await call('/applications/'+clientId+'/token',{method:'DELETE',basic:true,body:JSON.stringify({access_token:accessToken}),signal});return true;},
  });
}
