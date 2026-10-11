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
export function writesConflict(a,b) { return a.mode==='danger-full-access' || b.mode==='danger-full-access' || workspacesOverlap(a.workspace,b.workspace); }
export async function acquireWorkspaceLock(options) {
  assertWorkspaceNotQuarantined(options.stateRoot,options.workspace,options.mode);
  if(options.mode==='read-only') return ()=>{};
  const dir=path.join(options.stateRoot,'_locks','workspaces'); fs.mkdirSync(dir,{recursive:true});
  const token=crypto.randomUUID(), file=path.join(dir,token+'.json'), gate=path.join(dir,'.registry.lock');
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
          if(item.state==='quarantined' ? confirmedDead(item.processPids) : ownerDead && (item.state==='waiting' || confirmedDead(item.processPids))) { fs.unlinkSync(claimFile); continue; }
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
          claim.processPids=supervisedPids(record); writeJsonAtomic(file,claim);
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
 const canonical=canonicalWorkspace(workspace),dir=path.join(stateRoot,'_locks','workspace-quarantines'),file=path.join(dir,crypto.createHash('sha256').update(canonical).digest('hex')+'.json');
 withFileLockSync(file+'.lock',()=>{const prior=readJson(file,{optional:true});if(prior&&(prior.version!==3||prior.workspace!==canonical))throw new Error('Corrupt workspace quarantine.');writeJsonAtomic(file,{version:3,workspace:canonical,scopeKey,taskId,processPids:prior?.processPids?.length&&processPids?.length?[...new Set([...prior.processPids,...processPids])]:processPids??[],createdAt:prior?.createdAt??Date.now()});});
}
export function assertWorkspaceNotQuarantined(root,workspace,mode='read-only'){
 const dir=path.join(root,'_locks','workspace-quarantines');if(!fs.existsSync(dir))return;const canonical=canonicalWorkspace(workspace);
 for(const name of fs.readdirSync(dir)){if(!name.endsWith('.json'))continue;const item=readJson(path.join(dir,name));if(item.version!==3||typeof item.workspace!=='string')throw new Error('Corrupt workspace quarantine.');if(mode==='danger-full-access'||workspacesOverlap(canonical,item.workspace))throw Object.assign(new Error('Workspace is quarantined after an unconfirmed process-tree exit. No automatic lock clearing.'),{code:'WORKSPACE_QUARANTINED'});}
}
