/** Attempt-scoped evidence, independent of parent/worker IPC. Never stores launch payloads. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {readJson,writeJsonAtomic} from './io.js';
export const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
export function saveStage(dir,actor,record) {
  writeJsonAtomic(path.join(dir,actor+'.json'),{version:1,...record,updatedAt:new Date().toISOString()});
}
export function loadEvidence(dir,attemptId,jobId) {
  const records={};
  for(const actor of ['bridge','worker','helper']){
    const raw=readJson(path.join(dir,actor+'.json'),{optional:true});
    if(!raw)continue;
    if(raw.version!==1||raw.attemptId!==attemptId||raw.jobId!==jobId)throw Object.assign(new Error('Supervision evidence identity mismatch'),{code:'EVIDENCE_CORRUPT'});
    records[actor]=raw;
  }
  return records;
}
export function exitProof(records) {
  const {bridge,worker,helper}=records;
  if(!bridge)return {verified:false,kind:'missing-launch-intent'};
  if(bridge.authorized===false)return {verified:true,kind:'not-authorized'};
  const same=(a,b)=>a?.pid===b?.pid&&a?.creationTime&&a.creationTime===b?.creationTime;
  if(!same(bridge.worker,worker?.worker))return {verified:false,kind:'worker-identity-missing'};
  const helperMatches=same(worker?.helper,helper?.helper);
  if(helperMatches&&helper?.proof==='job-empty'&&helper.activeProcesses===0&&helper.jobId&&helper.helper?.creationTime)return {verified:true,kind:'job-empty',code:helper.exitCode};
  if(helperMatches&&helper?.proof==='not-started'&&helper.childMayExist===false)return {verified:true,kind:'not-started',code:helper.exitCode};
  if(worker?.proof==='not-started'&&worker.launchRequested===false)return {verified:true,kind:'not-started'};
  return {verified:false,kind:'exit-unconfirmed'};
}
export function evidenceFiles(dir) {
  if(!dir||!fs.existsSync(dir))return [];
  return ['bridge','worker','helper'].map(actor=>path.join(dir,actor+'.json')).filter(file=>fs.existsSync(file));
}
