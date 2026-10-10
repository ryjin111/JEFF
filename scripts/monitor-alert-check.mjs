import {pathToFileURL} from 'node:url';
import {createMonitorAlerts} from './monitor-alerts.mjs';

// One explicit synthetic pair, independent of the running monitor and its state.
export async function checkAlertDelivery({env,sendTest=false,fetchImpl=fetch,now=()=>new Date().toISOString()}){
  const report={configured:false,testRequested:sendTest,failureAccepted:false,recoveryAccepted:false,verified:false,secretValuesIncluded:false};
  let alerts,origin;
  try{
    alerts=createMonitorAlerts({url:env.JEFF_ALERT_WEBHOOK,bearer:env.JEFF_ALERT_BEARER,fetchImpl});
    report.configured=alerts.configured;
    if(!alerts.configured)return{...report,error:'JEFF_ALERT_DESTINATION_REQUIRED'};
    const target=new URL(env.JEFF_ALERT_TEST_ORIGIN||JSON.parse(env.JEFF_MONITOR_CONFIG||'{}').origin);
    if(target.protocol!=='https:'||target.username||target.password||target.pathname!=='/'||target.search||target.hash)throw Error();origin=target.origin;
  }catch{return{...report,error:'JEFF_ALERT_CONFIG_INVALID'};}
  if(!sendTest)return report;
  try{
    report.failureAccepted=await alerts.send({event:'test-failure',origin,observedAt:now(),failedChecks:['synthetic-test']})===true;
    if(!report.failureAccepted)throw Error();
    report.recoveryAccepted=await alerts.send({event:'test-recovery',origin,observedAt:now(),failedChecks:[]})===true;
    report.verified=report.failureAccepted&&report.recoveryAccepted;
    if(!report.verified)throw Error();return report;
  }catch{return{...report,error:'JEFF_ALERT_TEST_DELIVERY_FAILED'};}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const args=process.argv.slice(2);
  if(args.some(value=>value!=='--send-test')){console.error('JEFF_ALERT_CHECK_ARGUMENT_INVALID');process.exitCode=1;}
  else{
    const report=await checkAlertDelivery({env:process.env,sendTest:args.includes('--send-test')});console.log(JSON.stringify(report,null,2));
    if(report.error||(report.testRequested&&!report.verified))process.exitCode=1;
  }
}
