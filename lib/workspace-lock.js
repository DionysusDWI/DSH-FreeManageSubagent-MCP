/** Cross-MCP write scheduling over real filesystem boundaries. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJsonAtomic } from './io.js';
import { delay, processAlive, withFileLockSync } from './file-lock.js';
export function normalizeWorkspace(value) {
  const resolved=fs.realpathSync.native(path.resolve(value)); if(!fs.statSync(resolved).isDirectory()) throw new TypeError('Workspace must be an existing directory.'); return resolved;
}
export function canonicalWorkspace(value) { const real=normalizeWorkspace(value); return process.platform==='win32'?real.toLowerCase():real; }
export function workspacesOverlap(a,b) { return a===b || a.startsWith(b.endsWith(path.sep)?b:b+path.sep) || b.startsWith(a.endsWith(path.sep)?a:a+path.sep); }
// An unknown PID set is intentionally not considered proof of termination.
export function confirmedDead(pids) { return Array.isArray(pids) && pids.length > 0 && pids.every(pid => Number.isSafeInteger(pid) && pid > 0 && processAlive(pid) === false); }
export function supervisedPids(record) { return [...new Set([record.processPid, record.guardianPid, record.workerPid].filter(pid => Number.isSafeInteger(pid) && pid > 0))]; }
export function writesConflict(a,b) { if(a.mode==='read-only'||b.mode==='read-only')return false;return a.mode==='danger-full-access' || b.mode==='danger-full-access' || workspacesOverlap(a.workspace,b.workspace); }
export async function acquireWorkspaceLock(options) {
  assertWorkspaceNotQuarantined(options.stateRoot,options.workspace,options.mode);
  const dir=path.join(options.stateRoot,'_locks','workspaces'); fs.mkdirSync(dir,{recursive:true});
  const token=crypto.randomUUID(), file=path.join(dir,token+'.json'), gate=path.join(options.stateRoot,'_locks','supervision-registry.lock');
  const claim={version:1,token,pid:process.pid,workspace:canonicalWorkspace(options.workspace),mode:options.mode,taskId:options.taskId,conversationKey:options.conversationKey,createdAt:options.createdAt ?? Date.now(),state:'waiting'};
  withFileLockSync(gate,()=>writeJsonAtomic(file,claim));
  function remove() { withFileLockSync(gate,()=> { const prior=readJson(file,{optional:true}); if(prior && prior.token!==token) throw new Error('Write-lock owner changed.'); if(prior) fs.unlinkSync(file); }); }
  try {
    while(true) {
      if(options.signal?.aborted) throw options.signal.reason;
      const acquired=withFileLockSync(gate,()=> {
        const claims=[];
        for(const name of fs.readdirSync(dir)) {
          if(!name.endsWith('.json')) continue;
          const claimFile=path.join(dir,name), item=readJson(claimFile);
          if(item.version!==1 || !item.token || !item.workspace || !item.mode || !Number.isSafeInteger(item.pid)) throw new Error('Unknown write-lock owner; refusing concurrent writes.');
          if(!['waiting','active','quarantined'].includes(item.state)) throw new Error('Unknown write-lock state; refusing concurrent writes.');
          const ownerDead=processAlive(item.pid)===false;
          if(item.state==='waiting' && ownerDead) { fs.unlinkSync(claimFile); continue; }
          if(ownerDead && item.state==='active') { item.state='quarantined'; writeJsonAtomic(claimFile,item); }
          claims.push(item);
        }
        const before=(item)=>item.createdAt<claim.createdAt || item.createdAt===claim.createdAt && item.token<token;
        if(claims.some(item=>item.token!==token && writesConflict(item,claim) && (item.state==='active'||item.state==='quarantined'||before(item)))) return false;
        claim.state='active'; writeJsonAtomic(file,claim); return true;
      });
      if(acquired) {
        remove.track = record => withFileLockSync(gate, () => {
          const prior=readJson(file); if(prior.token!==token) throw new Error('Write-lock owner changed.');
          claim.processPids=supervisedPids(record);claim.attemptId=record.attemptId;claim.supervisionDir=record.supervisionDir;claim.jobId=record.jobId; writeJsonAtomic(file,claim);
        });
        remove.quarantine = processPids => withFileLockSync(gate, () => {
          const prior = readJson(file); if (prior.token !== token) throw new Error('Write-lock owner changed.');
          Object.assign(claim, {state:'quarantined',processPids,quarantinedAt:Date.now()}); writeJsonAtomic(file, claim);
        });
        return remove;
      }
      if(Date.now()>=(options.deadline ?? Infinity)) throw {kind:'timeout',message:'Task deadline exceeded while waiting for the workspace write lock.'};
      await delay(30,options.signal);
    }
  } catch(error) { remove(); throw error; }
}

/** Durable quarantine is separate from normal write claims and also blocks read-only starts. */
export function quarantineWorkspace({stateRoot,workspace,scopeKey,taskId,processPids}){
 const canonical=canonicalWorkspace(workspace),dir=path.join(stateRoot,'_locks','workspace-quarantines');
 const file=path.join(dir,crypto.createHash('sha256').update(canonical+'\0'+taskId).digest('hex')+'.json');
 withFileLockSync(path.join(stateRoot,'_locks','supervision-registry.lock'),()=>{
  const prior=readJson(file,{optional:true});
  if(prior){if(prior.version!==3||prior.workspace!==canonical||prior.taskId!==taskId)throw new Error('Corrupt workspace quarantine.');return;}
  writeJsonAtomic(file,{version:3,workspace:canonical,scopeKey,taskId,processPids:processPids??[],createdAt:Date.now()});
 });
}
export function assertWorkspaceNotQuarantined(root,workspace,mode='read-only'){
 const canonical=canonicalWorkspace(workspace),dirs=[['workspace-quarantines',null],['recoveries','pending'],['workspaces','claim']];
 for(const [name,kind] of dirs){
  const dir=path.join(root,'_locks',name);if(!fs.existsSync(dir))continue;
  for(const entry of fs.readdirSync(dir)){
   if(!entry.endsWith('.json'))continue;
   const item=readJson(path.join(dir,entry));
   if(kind==='pending'&&item.state==='committed')continue;
   if(kind==='claim'&&(item.state==='waiting'||item.state==='active'&&processAlive(item.pid)===true))continue;
   if(typeof item.workspace!=='string'||!kind&&item.version!==3)throw Object.assign(new Error('Corrupt supervision registry.'),{code:'QUARANTINE_CORRUPT'});
   if(mode==='danger-full-access'||workspacesOverlap(canonical,item.workspace))throw Object.assign(new Error('Workspace requires explicit quarantine recovery after an unconfirmed exit.'),{code:'WORKSPACE_QUARANTINED'});
  }
 }
}
