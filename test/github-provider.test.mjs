import test from 'node:test';
import assert from 'node:assert/strict';
import {createGithubProvider,githubTransport} from '../src/github-provider.mjs';
const accessToken='ghu_'+'a'.repeat(40);
const config={clientId:'Iv123456789',clientSecret:'s'.repeat(40),appId:'123',callbackUrl:'https://jeff.test/api/connectors/github/callback'};
function fixture(overrides={}){
  const calls=[];
  const values={
    '/login/oauth/access_token':{access_token:accessToken,token_type:'bearer',scope:'',expires_in:28800},
    '/user':{id:7,login:'holder'},
    '/user/installations?per_page=5&page=1':{total_count:1,installations:[{id:9,app_id:123,client_id:config.clientId,permissions:{metadata:'read',contents:'read'}}]},
    '/user/installations/9/repositories?per_page=5&page=1':{total_count:1,repositories:[{id:11,owner:{login:'owner'},name:'repo',full_name:'owner/repo'}]},
    '/repos/owner/repo/releases/latest':{tag_name:'v1/2',name:'release',body:'b'.repeat(3000),published_at:'2026-10-10T00:00:00Z',draft:false,prerelease:false},
    ...overrides,
  };
  const provider=createGithubProvider({...config,now:()=>0,transport:async input=>{calls.push(input);const url=new URL(input.url),key=url.pathname+url.search;const value=values[key];if(value?.status)return value;return{status:input.method==='DELETE'?204:200,json:value??null};}});
  return{provider,calls};
}
test('authorization uses fixed origin, PKCE and no secret',()=>{
  const {provider}=fixture(),url=new URL(provider.authorization({state:'a'.repeat(43),codeChallenge:'b'.repeat(43)}));
  assert.equal(url.origin,'https://github.com');assert.equal(url.searchParams.get('code_challenge_method'),'S256');assert.equal(url.searchParams.get('scope'),null);assert.ok(!url.href.includes(config.clientSecret));
});
test('exchange verifies identity and granular grant; retains no refresh token',async()=>{
  const {provider,calls}=fixture();const value=await provider.exchange({code:'code',verifier:'v'.repeat(43)});
  assert.deepEqual(value.account,{id:'7',login:'holder'});assert.equal(value.expiresAt,28800000);assert.equal(value.refreshToken,undefined);
  assert.equal(calls.length,4);assert.equal(new URL(calls[0].url).origin,'https://github.com');assert.ok(calls.slice(1).every(value=>new URL(value.url).origin==='https://api.github.com'));
});
test('write grants, malformed identity and OAuth scope fail closed',async()=>{
  for(const overrides of [
    {'/user/installations?per_page=5&page=1':{total_count:1,installations:[{id:9,app_id:123,client_id:config.clientId,permissions:{metadata:'read',contents:'write'}}]}},
    {'/user':{id:'7',login:'holder'}},
    {'/login/oauth/access_token':{access_token:accessToken,token_type:'bearer',scope:'repo',expires_in:28800}},
  ])await assert.rejects(fixture(overrides).provider.exchange({code:'code',verifier:'v'.repeat(43)}),/JEFF_GITHUB_/);
});
test('selected repository must be provider-listed before release request',async()=>{
  const {provider,calls}=fixture();await assert.rejects(provider.latest(accessToken,'12'),/REPOSITORY_UNAVAILABLE/);assert.equal(calls.length,2);
  await assert.rejects(provider.latest(accessToken,'../11'),/REPOSITORY_INVALID/);assert.equal(calls.length,2);
});
test('bounded evidence builds its own source URL and excludes credentials',async()=>{
  const {provider}=fixture();const result=await provider.latest(accessToken,'11');assert.equal(result.url,'https://github.com/owner/repo/releases/tag/v1%2F2');assert.equal(result.truncated,true);assert.ok(result.excerpt.length<2400);assert.ok(!JSON.stringify(result).includes(accessToken));
});
test('provider denial exposes only fixed error and revocation uses exact lifecycle route',async()=>{
  const {provider,calls}=fixture({'/user/installations?per_page=5&page=1':{status:401,json:{message:'secret'}}});
  await assert.rejects(provider.repositories(accessToken),{message:'JEFF_GITHUB_RECONNECT_REQUIRED'});
  assert.equal(await provider.revoke(accessToken),true);const last=calls.at(-1);assert.equal(last.url,'https://api.github.com/applications/Iv123456789/token');assert.equal(last.method,'DELETE');assert.ok(last.headers.authorization.startsWith('Basic '));
});
test('native transport denies arbitrary routes and mixed private DNS before request',async()=>{
  let requests=0;const options={lookup:async()=>[{family:4,address:'140.82.112.5'},{family:4,address:'127.0.0.1'}],request:()=>requests++};
  await assert.rejects(githubTransport({url:'https://api.github.com/user'},options),/ADDRESS_DENIED/);
  for(const url of ['https://evil.test/user','https://api.github.com/repos/owner/repo/issues','https://github.com/login/oauth/access_token?x=1','https://api.github.com/user?redirect=evil'])await assert.rejects(githubTransport({url},options),/DESTINATION_DENIED/);
  assert.equal(requests,0);
});
test('unverified installation cannot label permissions verified',async()=>{
 const {provider}=fixture({'/user/installations?per_page=5&page=1':{total_count:0,installations:[]}});
 await assert.rejects(provider.exchange({code:'code',verifier:'v'.repeat(43)}),/PERMISSIONS_UNVERIFIED/);
});
test('serialized excerpt stays bounded when JSON escaping expands control characters',async()=>{
 const {provider}=fixture({'/repos/owner/repo/releases/latest':{tag_name:'v1',name:'release',body:'\u0001'.repeat(1600),published_at:'2026-10-10T00:00:00Z',draft:false,prerelease:false}});
 const result=await provider.latest(accessToken,'11');assert.ok(result.excerpt.length<=2400);assert.equal(result.excerptTruncated,true);assert.doesNotThrow(()=>JSON.parse(result.excerpt));
});
