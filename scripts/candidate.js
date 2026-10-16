/** Exact-artifact provenance. Promotion never compiles or rewrites a candidate. */
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
export const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
export function prepareCandidate(dir,env=process.env){
 const manifest=JSON.parse(fs.readFileSync(path.join(dir,'release-manifest.json'),'utf8'));
 const names=fs.readdirSync(dir),zip=names.find(n=>n.endsWith('.zip')&&!n.endsWith('-source.zip'));
 if(!zip)throw new Error('Runtime ZIP missing');
 const result={version:1,repository:env.GITHUB_REPOSITORY,runId:String(env.GITHUB_RUN_ID),runAttempt:String(env.GITHUB_RUN_ATTEMPT),sourceCommit:manifest.sourceCommit,packageFingerprint:manifest.fingerprint,zip,zipSha256:sha(fs.readFileSync(path.join(dir,zip))),manifestSha256:sha(fs.readFileSync(path.join(dir,'release-manifest.json'))),checksumsSha256:sha(fs.readFileSync(path.join(dir,'SHA256SUMS')))};
 if(!result.repository||!/^\d+$/.test(result.runId)||!/^\d+$/.test(result.runAttempt))throw new Error('Candidate requires Actions provenance');
 fs.writeFileSync(path.join(dir,'candidate.json'),JSON.stringify(result,null,2)+'\n');return result;
}
export function validateAcceptance(candidate,receipt){
 const keys=['sourceCommit','packageFingerprint','zipSha256'];
 for(const key of keys)if(candidate[key]!==receipt[key])throw new Error('Acceptance '+key+' mismatch');
 if(receipt.candidateRunId!==candidate.runId||!/^\d+$/.test(receipt.candidateArtifactId??'')||!/^sha256:[a-f0-9]{64}$/.test(receipt.candidateArtifactDigest??''))throw new Error('Acceptance artifact provenance missing');
 if(receipt.schemaVersion!==1||receipt.result!=='passed'||receipt.submittedTasks!==1||receipt.answer!=='DSH_V013_SMOKE_OK'||receipt.permissionVerified!==true||receipt.treeExited!==true||receipt.reportsDrained!==true||receipt.newQuarantines!==0||receipt.legacyRecoveryAudited!==true||receipt.modelCalls!==null)throw new Error('Acceptance requirements not met');
 if(!/^t-[A-Za-z0-9-]+$/.test(receipt.taskId??'')||!/^\d{4}-\d\d-\d\dT.*Z$/.test(receipt.checkedAt??''))throw new Error('Acceptance task/time identity invalid');
 const allowed=['schemaVersion','candidateRunId','candidateArtifactId','candidateArtifactDigest',...keys,'result','submittedTasks','modelCalls','answer','permissionVerified','treeExited','reportsDrained','newQuarantines','legacyRecoveryAudited','taskId','checkedAt','provider','model','usage'];
 if(Object.keys(receipt).some(key=>!allowed.includes(key)))throw new Error('Acceptance has non-public fields');
 const text=JSON.stringify(receipt);if(text.length>8192||/[A-Za-z]:[\\/]|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{24}/.test(text))throw new Error('Acceptance contains private paths or credential-like content');
 return true;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(prepareCandidate(path.resolve(process.argv[2])),null,2));
