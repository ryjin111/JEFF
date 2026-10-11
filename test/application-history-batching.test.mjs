import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { createJeffApplication } from '../src/application.mjs';
import { createAccountSessions } from '../src/account-auth.mjs';
import { scopeDirectory } from '../src/scope.mjs';

const wallet=privateKeyToAccount('0x'+'12'.repeat(32)); // Disposable offline signing fixture.
const collection='0x'+'33'.repeat(20),origin='https://history-fixture.invalid';
const hash=value=>createHash('sha256').update(value).digest('hex');
async function fixture(t,kind,count,{corrupt=false}={}){
  const dataRoot=await mkdtemp(resolve('test','.application-history-'));
  let reads=0;const calls=[];
  let scope={chainId:4663,collection,tokenId:'35',owner:wallet.address.toLowerCase(),ownerEpoch:0};
  if(kind==='account'){
    const sessions=createAccountSessions({origin,chainId:4663,dataRoot});
    const challenge=await sessions.challenge({wallet:wallet.address});
    const signed=await sessions.verify({nonce:challenge.nonce,signature:await wallet.signMessage({message:challenge.message})});scope=signed.scope;
  }
  const app=await createJeffApplication({dataRoot,origin,startScheduler:false,fixture:true,
    env:{JEFF_CHAIN_ID:'4663',JEFF_COLLECTION:collection,JEFF_MODEL:'bankr/fixture-model'},
    hosting:{enabled:false,status:async()=>({active:true}),requireActive:async()=>{},startJob:async(_scope,start)=>start()},
    resolveOwner:async()=>{reads++;return {owner:wallet.address.toLowerCase(),ownerEpoch:0};},
    runAgent:async args=>{calls.push({history:args.executionContext.history,reads});return{text:'Synthetic fixture answer.',model:'bankr/fixture-model'};}});
  t.after(async()=>{await app.close();await rm(dataRoot,{recursive:true,force:true});});
  const conversation=await app.workspace.createConversation(scope,{title:'Selected history fixture'}),records=[];
  const directory=resolve(scopeDirectory(dataRoot,scope),'results');await mkdir(directory,{recursive:true});
  for(let index=0;index<count;index++){
    const text=`Synthetic previous answer ${index}. `+'a'.repeat(6500),objective=`Synthetic previous input ${index}. `+'q'.repeat(2500);
    const r={schema:'jeff-openclaw-job-v1',id:randomUUID(),scope,objective,status:index===1?'failed':'completed',saved:true,
      startedAt:new Date(1700000000000+index).toISOString(),finishedAt:'2023-11-14T22:14:00.000Z',runtime:'openclaw',
      externalActionsAuthorized:false,text,textSha256:hash(text),model:'fixture'};
    await app.workspace.bindJob(scope,{jobId:r.id,conversationId:conversation.id,objective,source:'manual'});
    await writeFile(resolve(directory,r.id+'.json'),JSON.stringify(corrupt&&index===count-1?{...r,textSha256:'0'.repeat(64)}:r));records.push(r);
  }
  reads=0;
  return{app,scope,conversation,records,calls,async submit(){return (await app.submit(scope,{objective:'Synthetic current question',conversationId:conversation.id})).completion;}};
}

for(const count of[0,4,9])test(`holder application batches ${count} prior jobs while preserving bounded conversation history`,async t=>{
  const f=await fixture(t,'nft',count),result=await f.submit();assert.equal(result.status,'completed');assert.equal(f.calls.length,1);
  const expected=f.records.slice(-7).filter(r=>r.status==='completed').map(r=>({objective:r.objective.slice(0,2000),text:r.text.slice(0,6000)}));
  assert.deepEqual(f.calls[0].history,expected);
  // Admission/context/schedules retain their checks. History adds two checks
  // for a nonempty batch, regardless of the number of selected prior records.
  assert.equal(f.calls[0].reads,count===0?10:12);
});

test('standalone account application uses the same selected history API',async t=>{
  const f=await fixture(t,'account',4),result=await f.submit();assert.equal(result.status,'completed');assert.equal(f.calls.length,1);
  assert.deepEqual(f.calls[0].history,f.records.filter(r=>r.status==='completed').map(r=>({objective:r.objective.slice(0,2000),text:r.text.slice(0,6000)})));
  assert.equal(f.calls[0].reads,0,'standalone history does not make NFT ownership calls');
});

test('a corrupt selected historical receipt prevents the application model invocation',async t=>{
  const f=await fixture(t,'nft',4,{corrupt:true}),result=await f.submit();assert.equal(result.status,'failed');assert.equal(f.calls.length,0);
});
