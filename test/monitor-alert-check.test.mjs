import test from 'node:test';import assert from 'node:assert/strict';
import {checkAlertDelivery} from '../scripts/monitor-alert-check.mjs';
const env={JEFF_ALERT_WEBHOOK:'https://alerts.example/private-token',JEFF_ALERT_BEARER:'private-bearer',JEFF_ALERT_TEST_ORIGIN:'https://jeff.example'};
test('missing destination and configuration-only checks send zero messages',async()=>{
 let calls=0;const fetchImpl=async()=>{calls++;throw Error();};
 assert.equal((await checkAlertDelivery({env:{},sendTest:true,fetchImpl})).error,'JEFF_ALERT_DESTINATION_REQUIRED');
 const configured=await checkAlertDelivery({env,fetchImpl});assert.equal(configured.configured,true);assert.equal(configured.verified,false);assert.equal(calls,0);
});
test('explicit check sends exactly one synthetic failure/recovery pair and no secret in report or payload',async()=>{
 const events=[];const report=await checkAlertDelivery({env,sendTest:true,fetchImpl:async(url,options)=>{
  assert.equal(url,env.JEFF_ALERT_WEBHOOK);assert.equal(options.headers.authorization,'Bearer '+env.JEFF_ALERT_BEARER);assert.equal(options.redirect,'error');events.push(JSON.parse(options.body));return new Response(null,{status:204});
 }});
 assert.equal(report.verified,true);assert.equal(events.length,2);assert.match(events[0].text,/test-failure/);assert.match(events[1].text,/test-recovery/);assert.ok(!JSON.stringify({report,events}).includes('private-'));
});
test('failed failure delivery sends no recovery and does not echo provider exceptions',async()=>{
 let calls=0;const report=await checkAlertDelivery({env,sendTest:true,fetchImpl:async()=>{calls++;throw Error(env.JEFF_ALERT_WEBHOOK+env.JEFF_ALERT_BEARER);}});
 assert.equal(calls,1);assert.equal(report.verified,false);assert.equal(report.error,'JEFF_ALERT_TEST_DELIVERY_FAILED');assert.ok(!JSON.stringify(report).includes('private-'));
});
test('partial delivery is reported truthfully without retry or monitor state mutation',async()=>{
 let calls=0;const report=await checkAlertDelivery({env,sendTest:true,fetchImpl:async()=>new Response(null,{status:++calls===1?204:503})});
 assert.equal(calls,2);assert.equal(report.failureAccepted,true);assert.equal(report.recoveryAccepted,false);assert.equal(report.verified,false);
});
