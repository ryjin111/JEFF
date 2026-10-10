import {pathToFileURL} from 'node:url';
import {createGithubProvider} from '../src/github-provider.mjs';

// Configuration diagnostics only. Never call GitHub, print values, or enable access.
export function checkGithubConfiguration(env){
  const keys=['JEFF_PUBLIC_ORIGIN','JEFF_GITHUB_APP_ID','JEFF_GITHUB_CLIENT_ID','JEFF_GITHUB_CLIENT_SECRET','JEFF_GITHUB_ENCRYPTION_KEY'];
  const missing=keys.filter(key=>typeof env[key]!=='string'||!env[key].trim());
  const invalid=[];let callbackUrl=null;
  if(!missing.includes('JEFF_GITHUB_ENCRYPTION_KEY')&&!/^[a-fA-F0-9]{64}$/.test(env.JEFF_GITHUB_ENCRYPTION_KEY))invalid.push('JEFF_GITHUB_ENCRYPTION_KEY');
  if(!missing.includes('JEFF_PUBLIC_ORIGIN')){
    try{const origin=new URL(env.JEFF_PUBLIC_ORIGIN);if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw Error();callbackUrl=origin.origin+'/api/connectors/github/callback';}
    catch{invalid.push('JEFF_PUBLIC_ORIGIN');}
  }
  if(!missing.includes('JEFF_GITHUB_APP_ID')&&!/^[0-9]{1,16}$/.test(env.JEFF_GITHUB_APP_ID))invalid.push('JEFF_GITHUB_APP_ID');
  if(!missing.includes('JEFF_GITHUB_CLIENT_ID')&&!/^Iv[0-9A-Za-z_.]{5,100}$/.test(env.JEFF_GITHUB_CLIENT_ID))invalid.push('JEFF_GITHUB_CLIENT_ID');
  if(!missing.includes('JEFF_GITHUB_CLIENT_SECRET')&&env.JEFF_GITHUB_CLIENT_SECRET.length<20)invalid.push('JEFF_GITHUB_CLIENT_SECRET');
  if(!missing.length&&!invalid.length){
    try{createGithubProvider({clientId:env.JEFF_GITHUB_CLIENT_ID,clientSecret:env.JEFF_GITHUB_CLIENT_SECRET,appId:env.JEFF_GITHUB_APP_ID,callbackUrl});}
    catch{invalid.push('JEFF_GITHUB_PROVIDER_CONFIG');}
  }
  return{configurationValid:!missing.length&&!invalid.length,enabled:env.JEFF_GITHUB_ENABLED==='true',missing,invalid,callbackUrl,
    providerContacted:false,realAuthorizationVerified:false,independentKeyRetentionVerified:false,secretValuesIncluded:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const report=checkGithubConfiguration(process.env);console.log(JSON.stringify(report,null,2));if(!report.configurationValid)process.exitCode=1;
}
