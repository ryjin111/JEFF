import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createJeffOpenClawNftBridge, createJeffOpenClawAccountBridge,
  jeffOpenClawWorkspaceId } from 'jeff-agent-nft/openclaw';

const nft=Object.freeze({chainId:4663,collection:'0x'+'22'.repeat(20),tokenId:'35',owner:'0x'+'11'.repeat(20),ownerEpoch:7});
const account=Object.freeze({kind:'account',chainId:4663,owner:nft.owner});
const otherOwner='0x'+'33'.repeat(20);
const hash=value=>createHash('sha256').update(value).digest('hex');
const model=async()=>({text:'Synthetic selected history fixture.',model:'fixture'});
const invalidBatch=/JEFF_OPENCLAW_(?:JOB_IDS|BATCH|JOB_ID)_INVALID/;

async function fixture(t){
  const root=await mkdtemp(resolve('test','.history-batch-'));
  t.after(()=>rm(root,{recursive:true,force:true}));return root;
}
function record(scope,index=0){
  const text=`Synthetic saved history ${index}.`;
  return{schema:'jeff-openclaw-job-v1',id:randomUUID(),scope,objective:'Synthetic fixture input',status:'completed',saved:true,
    startedAt:new Date(1700000000000+index).toISOString(),finishedAt:'2023-11-14T22:14:00.000Z',runtime:'openclaw',
    externalActionsAuthorized:false,text,textSha256:hash(text),model:'fixture'};
}
async function seed(root,scope,records){
  const workspace=scope.kind==='account'?hash(JSON.stringify(scope)):jeffOpenClawWorkspaceId(scope);
  const directory=resolve(root,workspace,'results');await mkdir(directory,{recursive:true});
  for(const r of records)await writeFile(resolve(directory,r.id+'.json'),JSON.stringify(r));return directory;
}
function create(kind,root,options={}){
  const {authorize=async()=>kind==='account'?true:nft,...rest}=options;
  return(kind==='account'?createJeffOpenClawAccountBridge:createJeffOpenClawNftBridge)({dataRoot:root,runAgent:model,
    ...(kind==='account'?{resolveAccount:authorize}:{resolveOwner:authorize}),...rest});
}

for(const kind of['nft','account']){
  const scope=kind==='account'?account:nft;
  test(`${kind} selected history preserves order and duplicates with two authorization checks`,async t=>{
    const root=await fixture(t),records=Array.from({length:8},(_,i)=>record(scope,i));await seed(root,scope,records);let checks=0;
    const bridge=create(kind,root,{authorize:async()=>{checks++;return kind==='account'?true:nft;}});
    const ids=[records[6].id,records[1].id,records[6].id,records[0].id,records[7].id,records[2].id,records[4].id,records[3].id];
    const result=await bridge.retrieveMany(scope,ids);assert.equal(checks,2);assert.deepEqual(result.map(x=>x.id),ids);
    assert.equal(result[0].text,records[6].text);result[0].text='Caller mutation';result[0].scope.owner=otherOwner;
    assert.equal(result[2].text,records[6].text);assert.equal(result[2].scope.owner,scope.owner);
    assert.equal((await bridge.retrieve(scope,records[6].id)).text,records[6].text);
    assert.equal(Object.hasOwn(bridge,'readRecord'),false);
  });
  test(`${kind} empty SDK batch releases nothing and still checks both boundaries`,async t=>{
    const root=await fixture(t);let checks=0;const bridge=create(kind,root,{authorize:async()=>{checks++;return kind==='account'?true:nft;}});
    assert.deepEqual(await bridge.retrieveMany(scope,[]),[]);assert.equal(checks,2);
  });
  test(`${kind} selected IDs are snapshotted before asynchronous authorization`,async t=>{
    const root=await fixture(t),first=record(scope),second=record(scope,1);await seed(root,scope,[first,second]);
    const ids=[first.id];let checks=0;
    const bridge=create(kind,root,{authorize:async()=>{if(++checks===1)ids[0]=second.id;return kind==='account'?true:nft;}});
    assert.deepEqual((await bridge.retrieveMany(scope,ids)).map(x=>x.id),[first.id]);assert.equal(checks,2);
  });
  test(`${kind} initial denial precedes result access`,async t=>{
    const root=await fixture(t);let checks=0;
    const bridge=create(kind,root,{authorize:async()=>{checks++;return kind==='account'?false:{...nft,owner:otherOwner};}});
    await assert.rejects(bridge.retrieveMany(scope,[randomUUID()]),kind==='account'?/JEFF_OPENCLAW_ACCOUNT_DENIED/:/JEFF_OPENCLAW_OWNER_REVOKED/);assert.equal(checks,1);
  });
  for(const change of kind==='account'?['registration']:['owner','epoch'])test(`${kind} final ${change} revocation withholds the entire selected batch`,async t=>{
    const root=await fixture(t),records=[record(scope),record(scope,1)];await seed(root,scope,records);let checks=0;
    const bridge=create(kind,root,{authorize:async()=>{
      checks++;if(checks===1)return kind==='account'?true:nft;
      return kind==='account'?false:{...nft,...(change==='owner'?{owner:otherOwner}:{ownerEpoch:nft.ownerEpoch+1})};
    }});
    await assert.rejects(bridge.retrieveMany(scope,records.map(x=>x.id)),kind==='account'?/JEFF_OPENCLAW_ACCOUNT_DENIED/:/JEFF_OPENCLAW_OWNER_REVOKED/);assert.equal(checks,2);
  });
  test(`${kind} selected reads ignore unrelated corrupt records`,async t=>{
    const root=await fixture(t),r=record(scope),directory=await seed(root,scope,[r]);
    await writeFile(resolve(directory,randomUUID()+'.json'),'{invalid unselected fixture');
    const bridge=create(kind,root);assert.deepEqual((await bridge.retrieveMany(scope,[r.id])).map(x=>x.id),[r.id]);
  });
  for(const corruption of['scope','id','schema','textSha256','json','missing'])test(`${kind} selected ${corruption} error returns no partial history`,async t=>{
    const root=await fixture(t),first=record(scope),second=record(scope,1),directory=await seed(root,scope,[first]);
    const requestedId=second.id;
    if(corruption==='scope')second.scope={...scope,owner:otherOwner};
    if(corruption==='id')second.id=randomUUID();
    if(corruption==='schema')second.schema='wrong-schema';
    if(corruption==='textSha256')second.textSha256='0'.repeat(64);
    if(corruption!=='missing')await writeFile(resolve(directory,requestedId+'.json'),corruption==='json'?'{':JSON.stringify(second));
    const bridge=create(kind,root);await assert.rejects(bridge.retrieveMany(scope,[first.id,requestedId]),
      ['json','missing'].includes(corruption)?/JEFF_OPENCLAW_RESULT_NOT_FOUND/:/JEFF_OPENCLAW_RESULT_INVALID/);
  });
  test(`${kind} invalid batch types, counts and path-like IDs are rejected`,async t=>{
    const root=await fixture(t),bridge=create(kind,root);
    for(const ids of[null,undefined,{},'not-an-array',Array.from({length:9},()=>randomUUID()),['../escape'],[null],[123],[{}],[''],new Array(1)]){
      await assert.rejects(bridge.retrieveMany(scope,ids),invalidBatch);
    }
  });
  test(`${kind} unsaved overlays remain available without rerunning the model`,async t=>{
    const root=await fixture(t);let calls=0,refuse=true;
    const bridge=create(kind,root,{runAgent:async()=>{calls++;return model();},persistRecord:async(directory,r)=>{
      if(r.status==='completed'&&refuse)throw Error('Synthetic persistence failure');
      await mkdir(directory,{recursive:true});await writeFile(resolve(directory,r.id+'.json'),JSON.stringify(r));
    }});
    const r=await bridge.run(scope,'Synthetic unsaved history');assert.equal(r.status,'completed_unsaved');
    const result=await bridge.retrieveMany(scope,[r.id,r.id]);assert.deepEqual(result.map(x=>x.status),['completed_unsaved','completed_unsaved']);
    assert.equal(result[0].textSha256,r.textSha256);result[0].text='Caller mutation';assert.equal(result[1].text,r.text);
    refuse=false;await bridge.retrySave(scope,r.id);assert.equal((await bridge.retrieveMany(scope,[r.id]))[0].status,'completed');assert.equal(calls,1);
  });
  test(`${kind} selected running records preserve interruption status after a process restart`,async t=>{
    const root=await fixture(t);let entered,release;
    const began=new Promise(r=>{entered=r;}),finish=new Promise(r=>{release=r;});
    const bridge=create(kind,root,{runAgent:async()=>{entered();await finish;return model();}});
    const operation=bridge.run(scope,'Synthetic running history');await began;
    try{
      const current=(await bridge.list(scope))[0];assert.equal((await bridge.retrieveMany(scope,[current.id]))[0].status,'running');
      const restarted=create(kind,root),interrupted=(await restarted.retrieveMany(scope,[current.id]))[0];
      assert.equal(interrupted.status,'interrupted');assert.equal(interrupted.error,'JEFF_OPENCLAW_PROCESS_RESTARTED');
    }finally{release();await operation;}
  });
}
