import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,writeFile,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {privateKeyToAccount} from 'viem/accounts';
import {createJeffApplication} from '../src/application.mjs';
import {scopeId} from '../src/scope.mjs';

const signer=privateKeyToAccount('0x'+'12'.repeat(32));
const collection='0x'+'33'.repeat(20);
async function fixture(t,mode){
  const root=await mkdtemp(resolve('test','.github-application-race-'));
  let app,session,readFinished=false,runnerFinished=false,invalidated=false,modelCalls=0;
  const owner={owner:signer.address.toLowerCase(),ownerEpoch:0};
  const resultDirectory=()=>resolve(root,scopeId(session.scope),'results');
  const provider={
    authorization:attempt=>'https://github.com/login/oauth/authorize?state='+attempt.state,
    exchange:async()=>({accessToken:'ghu_'+'a'.repeat(40),expiresAt:Date.now()+3600000,account:{id:'7',login:'holder'},permissions:{metadata:'read',contents:'read'}}),
    repositories:async()=>({repositories:[{id:'11',name:'owner/repo'}],coverage:{shown:1,hasMore:false}}),
    latest:async()=>{readFinished=true;return{url:'https://github.com/owner/repo/releases/tag/v1',retrievedAt:new Date().toISOString(),excerpt:'{"tag":"v1"}',format:'json',excerptTruncated:false};},
    revoke:async()=>true,
  };
  const hosting={enabled:false,freePassEnabled:false,plan:{tasksIncluded:100},status:async()=>({active:true}),requireActive:async()=>{},startJob:async(_scope,start)=>start()};
  app=await createJeffApplication({dataRoot:root,origin:'http://127.0.0.1:8788',startScheduler:false,githubProvider:provider,hosting,onRequestError:()=>{},
    env:{JEFF_CHAIN_ID:'4663',JEFF_COLLECTION:collection,JEFF_MODEL:'bankr/fixture-model',JEFF_GITHUB_ENABLED:'true',JEFF_GITHUB_ENCRYPTION_KEY:'ab'.repeat(32),JEFF_MAX_CONCURRENT_JOBS:'1'},
    resolveOwner:async()=>{
      if(!invalidated&&session){
        let atBoundary=mode==='scheduler'&&readFinished&&new Error().stack.includes('scheduler.mjs');
        if(mode==='save'&&runnerFinished){
          // A completed temp receipt establishes that model execution and the
          // initial checks ended. Revoke during the authority read before rename.
          const files=await readdir(resultDirectory()).catch(()=>[]);
          for(const file of files.filter(value=>value.endsWith('.tmp'))){
            const record=JSON.parse(await readFile(resolve(resultDirectory(),file),'utf8'));
            if(record.status==='completed'){atBoundary=true;break;}
          }
        }
        if(atBoundary){invalidated=true;app.sessions.logout(session.token);}
      }
      return{...owner};
    },
    runAgent:async()=>{modelCalls++;runnerFinished=true;return{text:'Private release answer',model:'bankr/fixture-model'};},
  });
  await new Promise(done=>app.server.listen(0,'127.0.0.1',done));
  const base='http://127.0.0.1:'+app.server.address().port;
  async function api(path,{method='GET',input,auth=session}={}){
    const response=await fetch(base+path,{method,headers:{'content-type':'application/json',...(auth?{authorization:'Bearer '+auth.token}:{})},body:input===undefined?undefined:JSON.stringify(input)});
    return{status:response.status,value:await response.json()};
  }
  async function login(){
    const challenge=await api('/api/auth/challenge',{method:'POST',input:{wallet:signer.address,tokenId:'35'},auth:null});
    const signature=await signer.signMessage({message:challenge.value.message});
    const response=await api('/api/auth/verify',{method:'POST',input:{nonce:challenge.value.nonce,signature},auth:null});
    assert.equal(response.status,200);session=response.value;
  }
  await login();
  t.after(async()=>{
    // If a regression strands the original running receipt, release only the
    // disposable fixture's waiter after assertions, keeping failed tests quick.
    for(const file of await readdir(resultDirectory()).catch(()=>[])){
      if(!file.endsWith('.json'))continue;
      const path=resolve(resultDirectory(),file),record=JSON.parse(await readFile(path,'utf8'));
      if(record.status==='running')await writeFile(path,JSON.stringify({...record,status:'failed',saved:true,error:'FIXTURE_CLEANUP'}));
    }
    await delay(110);await app.close();await rm(root,{recursive:true,force:true});
  });
  const initiated=await fetch(base+'/api/connectors/github/authorize',{method:'POST',headers:{authorization:'Bearer '+session.token,'content-type':'application/json'},body:'{}'});
  const attempt=await initiated.json(),state=new URL(attempt.authorizationUrl).searchParams.get('state');
  const callback=await fetch(base+'/api/connectors/github/callback?state='+state+'&code=code',{headers:{cookie:initiated.headers.get('set-cookie').split(';')[0]},redirect:'manual'});
  assert.equal(callback.headers.get('location'),'/#skills');
  const connection=(await api('/api/connectors/github')).value;
  const started=await api('/api/jobs',{method:'POST',input:{objective:'Read release',github:{repositoryId:'11',generation:connection.generation,consent:true}}});
  assert.equal(started.status,202);
  async function durable(){return JSON.parse(await readFile(resolve(resultDirectory(),started.value.id+'.json'),'utf8'));}
  async function waitTerminal(){
    for(let i=0;i<100;i++){const record=await durable();if(record.status!=='running')return record;await delay(10);}
    assert.fail('Invalidated GitHub work remained running on disk');
  }
  return{api,login,durable,waitTerminal,app,id:started.value.id,get invalidated(){return invalidated;},get modelCalls(){return modelCalls;}};
}

test('logout during scheduler reads after GitHub retrieval prevents the paid model call',async t=>{
  const f=await fixture(t,'scheduler');
  const receipt=await f.waitTerminal();assert.equal(f.invalidated,true);assert.equal(f.modelCalls,0);
  assert.equal(receipt.status,'failed');assert.equal(receipt.saved,true);assert.equal(receipt.text,undefined);
});

test('logout before the completed GitHub receipt rename saves failure and releases capacity',async t=>{
  const f=await fixture(t,'save');
  const receipt=await f.waitTerminal();assert.equal(f.invalidated,true);assert.equal(f.modelCalls,1);
  assert.equal(receipt.status,'failed');assert.equal(receipt.saved,true);assert.equal(receipt.text,undefined);
  await f.login();
  assert.equal((await f.api('/api/jobs/'+f.id)).value.status,'failed');
  assert.equal((await f.api('/api/jobs/'+f.id+'/retry-save',{method:'POST',input:{}})).value.status,'failed');
  for(let i=0;i<50&&f.app.maintenance.status().pendingTasks;i++)await delay(10);
  assert.equal(f.app.maintenance.status().pendingTasks,0);
  const another=await f.api('/api/jobs',{method:'POST',input:{objective:'Another question'}});
  assert.equal(another.status,202);assert.deepEqual(f.app.maintenance.status().failures,[]);
});
