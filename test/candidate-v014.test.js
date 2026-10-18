// Sanitized fixtures only. These are neither paid tasks nor an acceptance receipt.
import test from 'node:test';import assert from 'node:assert/strict';
import {validateAcceptance,ACCEPTANCE_FEATURES} from '../scripts/candidate.js';
const identity={bridgeVersion:'0.1.4',dshVersion:'0.2.1-rc.2',upstreamCommit:'687f282e8625c6b8d11ff58211a90524be2e4317',profileGeneration:'profile-v3-sdk-687f282e',guardianProtocol:2,sdkWireVersion:'0.0.1'};
const candidate={version:2,...identity,runId:'123',sourceCommit:'a'.repeat(40),packageFingerprint:'b'.repeat(64),zipSha256:'c'.repeat(64)};
function receipt(){return {schemaVersion:2,...identity,profileFingerprint:'e'.repeat(64),candidateRunId:'123',candidateArtifactId:'456',candidateArtifactDigest:'sha256:'+'d'.repeat(64),sourceCommit:candidate.sourceCommit,packageFingerprint:candidate.packageFingerprint,zipSha256:candidate.zipSha256,result:'passed',submittedTasks:1,
  modelRequests:{source:'unavailable',agent:null,autoReview:null,other:null,total:null},answer:'DSH_V014_SMOKE_OK',permissionVerified:true,treeExited:true,reportsDrained:true,newQuarantines:0,legacyRecoveryAudited:true,taskIds:['t-fixture'],continuationTaskIds:[],featureChecks:Object.fromEntries(ACCEPTANCE_FEATURES.map(k=>[k,true])),checkedAt:'2026-10-18T00:00:00.000Z',provider:null,model:null,usage:null};}
test('promotion binds fresh SDK/native/profile acceptance to the exact candidate',()=>assert.equal(validateAcceptance(candidate,receipt()),true));
test('promotion rejects legacy receipt/profile, changed artifact, incomplete features and unknown exit',()=>{
  for(const patch of [{schemaVersion:1},{bridgeVersion:'0.1.3'},{dshVersion:'0.2.0-rc.2'},{profileGeneration:'headless-v2'},{guardianProtocol:1},{profileFingerprint:null},{answer:'DSH_V013_SMOKE_OK'},{zipSha256:'e'.repeat(64)},{submittedTasks:2},{treeExited:false},{newQuarantines:1},{permissionVerified:false},{candidateArtifactDigest:null},{localPath:'private'},{featureChecks:{sdkInitializeResumeWait:true}}])assert.throws(()=>validateAcceptance(candidate,{...receipt(),...patch}));
});
test('task/continuation counts are distinct from native Auto extra model requests',()=>{
  const value={...receipt(),submittedTasks:2,taskIds:['t-fixture','t-late-answer'],continuationTaskIds:['t-late-answer'],modelRequests:{source:'observed-provider-dispatch',agent:4,autoReview:6,other:0,total:10}};assert.equal(validateAcceptance(candidate,value),true);
  for(const patch of [{modelRequests:{source:'unavailable',agent:1,autoReview:0,other:0,total:1}},{modelRequests:{source:'observed-provider-dispatch',agent:4,autoReview:6,other:0,total:2}},{continuationTaskIds:['t-foreign']}])assert.throws(()=>validateAcceptance(candidate,{...value,...patch}));
});
