/** Exact-artifact provenance. Promotion never compiles, rewrites, or reuses 0.1.3 acceptance. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {BRIDGE_VERSION,DSH_BASELINE,DSH_SOURCE_COMMIT,PROFILE_GENERATION,SDK_WIRE_VERSION} from '../lib/compatibility.js';
export const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
export const ACCEPTANCE_FEATURES=Object.freeze(['sdkInitializeResumeWait','nativePresetsAndAuto','reasoningResolution','effectiveWorkingDirectory','launchCredentialSource','approvalPersistence','questionnaireLifecycles','lateAnswerResume','duplexSupervisionAndQuarantine']);
const hex=(value,length)=>typeof value==='string'&&new RegExp('^[a-f0-9]{'+length+'}$').test(value);
function nativeIdentity(value){return value.bridgeVersion===BRIDGE_VERSION&&value.dshVersion===DSH_BASELINE&&value.upstreamCommit===DSH_SOURCE_COMMIT&&value.profileGeneration===PROFILE_GENERATION&&value.guardianProtocol===2&&value.sdkWireVersion===SDK_WIRE_VERSION;}
export function prepareCandidate(dir,env=process.env){
  const manifest=JSON.parse(fs.readFileSync(path.join(dir,'release-manifest.json'),'utf8'));
  const identity={bridgeVersion:manifest.version,dshVersion:manifest.dshBaseline,upstreamCommit:manifest.upstreamCommit,profileGeneration:manifest.profileGeneration,guardianProtocol:manifest.guardianProtocol,sdkWireVersion:manifest.sdkWireVersion};
  if(!nativeIdentity(identity)||!hex(manifest.sourceCommit,40)||!hex(manifest.fingerprint,64))throw new Error('Candidate must identify the v0.1.4 pinned SDK/native profile.');
  const zips=fs.readdirSync(dir).filter(n=>n.endsWith('.zip')&&!n.endsWith('-source.zip'));
  if(zips.length!==1)throw new Error('Exactly one immutable runtime ZIP is required.');
  const zip=zips[0],result={version:2,...identity,repository:env.GITHUB_REPOSITORY,runId:String(env.GITHUB_RUN_ID),runAttempt:String(env.GITHUB_RUN_ATTEMPT),sourceCommit:manifest.sourceCommit,packageFingerprint:manifest.fingerprint,zip,
    zipSha256:sha(fs.readFileSync(path.join(dir,zip))),manifestSha256:sha(fs.readFileSync(path.join(dir,'release-manifest.json'))),checksumsSha256:sha(fs.readFileSync(path.join(dir,'SHA256SUMS')))};
  if(!result.repository||!/^\d+$/.test(result.runId)||!/^\d+$/.test(result.runAttempt))throw new Error('Candidate requires Actions provenance.');
  fs.writeFileSync(path.join(dir,'candidate.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});return result;
}
export function validateAcceptance(candidate,receipt){
  if(candidate.version!==2||!nativeIdentity(candidate)||receipt.schemaVersion!==2||!nativeIdentity(receipt))throw new Error('Fresh v0.1.4 SDK/profile acceptance is required; legacy receipts cannot be promoted.');
  const keys=['sourceCommit','packageFingerprint','zipSha256'];
  for(const key of keys)if(!hex(candidate[key],key==='sourceCommit'?40:64)||candidate[key]!==receipt[key])throw new Error('Acceptance '+key+' mismatch.');
  if(receipt.candidateRunId!==candidate.runId||!/^\d+$/.test(receipt.candidateArtifactId??'')||!/^sha256:[a-f0-9]{64}$/.test(receipt.candidateArtifactDigest??''))throw new Error('Acceptance artifact provenance missing.');
  if(!hex(receipt.profileFingerprint,64)||receipt.result!=='passed'||receipt.answer!=='DSH_V014_SMOKE_OK'||receipt.permissionVerified!==true||receipt.treeExited!==true||receipt.reportsDrained!==true||receipt.newQuarantines!==0||receipt.legacyRecoveryAudited!==true)throw new Error('Acceptance requirements not met.');
  const ids=receipt.taskIds,continued=receipt.continuationTaskIds;
  if(!Number.isSafeInteger(receipt.submittedTasks)||receipt.submittedTasks<1||!Array.isArray(ids)||ids.length!==receipt.submittedTasks||new Set(ids).size!==ids.length||ids.some(id=>!/^t-[A-Za-z0-9-]+$/.test(id))||!Array.isArray(continued)||new Set(continued).size!==continued.length||continued.some(id=>!ids.includes(id)))throw new Error('Acceptance task/continuation ledger mismatch.');
  const checks=receipt.featureChecks;
  if(!checks||Object.keys(checks).length!==ACCEPTANCE_FEATURES.length||ACCEPTANCE_FEATURES.some(key=>checks[key]!==true))throw new Error('The SDK management feature matrix is incomplete.');
  const counts=receipt.modelRequests,names=['agent','autoReview','other','total'];
  if(!counts||Object.keys(counts).some(key=>!['source',...names].includes(key))||!['unavailable','observed-provider-dispatch'].includes(counts.source))throw new Error('Model request accounting source is required.');
  if(counts.source==='unavailable'&&names.some(key=>counts[key]!==null)||counts.source==='observed-provider-dispatch'&&(names.some(key=>!Number.isSafeInteger(counts[key])||counts[key]<0)||counts.total!==counts.agent+counts.autoReview+counts.other))throw new Error('Model counts must be observed separately, never inferred from submitted tasks.');
  if(!/^\d{4}-\d\d-\d\dT.*Z$/.test(receipt.checkedAt??'')||Number.isNaN(Date.parse(receipt.checkedAt)))throw new Error('Acceptance time identity invalid.');
  const allowed=['schemaVersion','bridgeVersion','dshVersion','upstreamCommit','profileGeneration','guardianProtocol','sdkWireVersion','profileFingerprint','candidateRunId','candidateArtifactId','candidateArtifactDigest',...keys,'result','submittedTasks','modelRequests','answer','permissionVerified','treeExited','reportsDrained','newQuarantines','legacyRecoveryAudited','taskIds','continuationTaskIds','featureChecks','checkedAt','provider','model','usage'];
  if(Object.keys(receipt).some(key=>!allowed.includes(key)))throw new Error('Acceptance has non-public fields.');
  const text=JSON.stringify(receipt);if(text.length>16384||/[A-Za-z]:[\\/]|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{24}/.test(text))throw new Error('Acceptance contains private paths or credential-like content.');
  return true;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(prepareCandidate(path.resolve(process.argv[2])),null,2));
