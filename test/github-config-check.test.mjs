import test from 'node:test';import assert from 'node:assert/strict';
import {checkGithubConfiguration} from '../scripts/github-config-check.mjs';
const configured={JEFF_PUBLIC_ORIGIN:'https://jeff.test',JEFF_GITHUB_APP_ID:'123',JEFF_GITHUB_CLIENT_ID:'Iv123456789',JEFF_GITHUB_CLIENT_SECRET:'private-secret-value-123456789',JEFF_GITHUB_ENCRYPTION_KEY:'ab'.repeat(32)};
test('preflight reports missing names without claiming real acceptance',()=>{
 const value=checkGithubConfiguration({});assert.equal(value.configurationValid,false);assert.equal(value.missing.length,5);assert.equal(value.providerContacted,false);assert.equal(value.realAuthorizationVerified,false);assert.equal(value.independentKeyRetentionVerified,false);
});
test('valid disabled configuration exposes only the fixed callback and no secret values',()=>{
 const value=checkGithubConfiguration(configured);assert.equal(value.configurationValid,true);assert.equal(value.enabled,false);assert.equal(value.callbackUrl,'https://jeff.test/api/connectors/github/callback');for(const key of ['JEFF_GITHUB_CLIENT_SECRET','JEFF_GITHUB_ENCRYPTION_KEY','JEFF_GITHUB_CLIENT_ID'])assert.ok(!JSON.stringify(value).includes(configured[key]));
});
test('malformed secret and origin diagnostics do not echo submitted values',()=>{
 const env={...configured,JEFF_PUBLIC_ORIGIN:'https://private-password@jeff.test/path',JEFF_GITHUB_ENCRYPTION_KEY:'private-bad-key',JEFF_GITHUB_CLIENT_SECRET:'private-bad-secret'};
 const value=checkGithubConfiguration(env);assert.equal(value.configurationValid,false);assert.equal(value.callbackUrl,null);assert.ok(value.invalid.includes('JEFF_PUBLIC_ORIGIN'));assert.ok(!JSON.stringify(value).includes('private-'));
});
