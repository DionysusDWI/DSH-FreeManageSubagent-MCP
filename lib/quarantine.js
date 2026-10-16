/** Explicit quarantine recovery. Queries never acquire locks or mutate state. */
import fs from 'node:fs';
import path from 'node:path';
import {readJson,writeJsonAtomic} from './io.js';
import {acquireFileLock,withFileLockSync,processAlive} from './file-lock.js';
import {loadEvidence,exitProof,evidenceFiles,hash} from './supervision-evidence.js';
import {identityStatus,processIdentity,relevantProcesses} from './process-evidence.js';
import {supervisedPids,canonicalWorkspace} from './workspace-lock.js';
import {refuseLinks} from './sessions.js';
import {TERMINAL_STATES} from './store.js';
const refuse=(message,code='RECOVERY_REFUSED')=>{throw Object.assign(new Error(message),{code});};
function bytes(file){try{return fs.readFileSync(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
function filesIn(dir){return fs.existsSync(dir)?fs.readdirSync(dir).filter(n=>n.endsWith('.json')).sort().map(n=>path.join(dir,n)):[];}
function taskView(manager,id){const ctx=manager.readTaskContext(id),task=ctx.store.getTask(id);if(!task)refuse('Task record is unavailable.','TASK_NOT_FOUND');return {ctx,task};}
function belongs(item,id){return item.taskId===id||item.taskIds?.includes(id);}
function collect(manager,ctx,task){
 const lockRoot=path.join(manager.stateRoot,'_locks'),registry=[...filesIn(path.join(lockRoot,'workspace-quarantines')),...filesIn(path.join(lockRoot,'workspaces'))];
 const associated=[];
 for(const file of registry){const item=readJson(file);if(!item||typeof item.workspace!=='string'||!item.taskId)refuse('Corrupt registry entry.','QUARANTINE_CORRUPT');if(belongs(item,task.taskId))associated.push(file);}
 const scope=path.join(ctx.dir,'.execution-quarantine.json'),q=readJson(scope,{optional:true});
 if(q){if(q.conversationKey!==ctx.key||!q.taskId)refuse('Corrupt scope quarantine.','QUARANTINE_CORRUPT');if(belongs(q,task.taskId))associated.push(scope);}
 if(task.supervisionDir)refuseLinks(manager.stateRoot,task.supervisionDir);
 const evidence=task.supervisionDir?evidenceFiles(task.supervisionDir):[];
 for(const file of [...registry,...evidence])refuseLinks(manager.stateRoot,file);
 if(task.supervisionDir&&path.resolve(task.supervisionDir)!==path.join(ctx.taskPaths(task.taskId).dir,'supervision',task.attemptId??''))refuse('Evidence path escaped task attempt.','EVIDENCE_CORRUPT');
 const taskFile=path.join(ctx.taskPaths(task.taskId).dir,'task.json');
 const all=[...new Set([...registry,...associated,...evidence,taskFile])].sort();
 const snapshot=all.map(file=>({file,sha256:hash(bytes(file))}));
 const expectedDigest=hash(JSON.stringify(snapshot));
 let records={},proof={verified:false,kind:'legacy-evidence-missing'};
 if(task.attemptId){records=loadEvidence(task.supervisionDir,task.attemptId,task.jobId);proof=exitProof(records);}
 const identities=[records.bridge?.worker,records.worker?.helper,records.helper?.helper,records.helper?.child].filter(Boolean);
 const known=new Set(identities.map(i=>i.pid));
 for(const pid of supervisedPids(task))if(!known.has(pid))identities.push({pid});
 for(const file of associated)for(const pid of readJson(file).processPids??[])if(!identities.some(i=>i.pid===pid))identities.push({pid});
 if(identities.some(i=>!Number.isSafeInteger(i.pid)||i.pid<1))refuse('Invalid recorded process identity.','QUARANTINE_CORRUPT');
 const processes=identities.map(i=>({...i,observed:identityStatus(i)}));
 const transactions=filesIn(path.join(lockRoot,'recoveries')).map(file=>({...readJson(file),file})).filter(t=>t.taskId===task.taskId);
 return {associated,snapshot,expectedDigest,records,proof,processes,transactions,taskFile};
}
export function inspectQuarantine(manager,id){
 const {ctx,task}=taskView(manager,id),data=collect(manager,ctx,task),active=data.associated.length>0||data.transactions.some(t=>t.state!=='committed');
 const live=data.processes.some(p=>['alive','unknown'].includes(p.observed.status));
 const recoveryRequired=!TERMINAL_STATES.has(task.state)&&processAlive(task.executorPid)!==true;
 const result={task_id:id,active,recovery_required:active||recoveryRequired,expected_digest:data.expectedDigest,
  state:task.state,tree_exited:task.treeExited??null,workspace:task.workspace,scope:ctx.key,
  impact:{overlapping_workspaces:'all sandbox modes',all_full_access_tasks:true,state_root:manager.stateRoot},
  quarantines:data.associated.map(file=>({path:file,sha256:hash(bytes(file))})),snapshot:data.snapshot,
  evidence:{attempt_id:task.attemptId??null,job_id:task.jobId??null,proof:data.proof,processes:data.processes},
  recovery_methods:{verified:active&&data.proof.verified&&!live,operator_cli:active&&!live,instruction:'quarantine release --task-id ID --expected-digest DIGEST --reason TEXT [--operator-verified] --apply'},
  external_release:!active&&task.quarantined===false&&task.treeExited===false&&!task.recoveryReceipt,
  receipt:task.recoveryReceipt??null,pending_transactions:data.transactions.filter(t=>t.state!=='committed').map(t=>({id:t.id,expected_digest:t.expectedDigest})),checked_at:new Date().toISOString()};
 if(Buffer.byteLength(JSON.stringify(result))>24000)refuse('Snapshot exceeds response budget; inspect local files.','RESPONSE_BUDGET_EXCEEDED');
 return result;
}
export async function releaseQuarantine(manager,{task_id,expected_digest,reason,apply=false,operatorVerified=false,cli=false,faultAfter}={}){
 if(typeof reason!=='string'||!reason.trim()||reason.length>2048)refuse('A bounded recovery reason is required.');
 if(!/^[a-f0-9]{64}$/.test(expected_digest??''))refuse('Expected SHA-256 snapshot digest is required.');
 if(operatorVerified&&!cli)refuse('Operator attestation is available only from the CLI.');
 const {ctx}=taskView(manager,task_id);
 // Every recovery and execution acquires scope first, registry second.
 const unlock=await acquireFileLock(path.join(ctx.dir,'.execution.lock'),{deadline:Date.now()+10000});
 try{return withFileLockSync(path.join(manager.stateRoot,'_locks','supervision-registry.lock'),()=>{
  const {task}=taskView(manager,task_id),data=collect(manager,ctx,task);
  const existing=data.transactions.find(t=>t.expectedDigest===expected_digest);
  if(existing?.state==='committed')return {task_id,released:true,idempotent:true,receipt:existing.receipt};
  if(!existing&&expected_digest!==data.expectedDigest)refuse('Snapshot changed; inspect and review the new digest.','SNAPSHOT_CHANGED');
  const orphan=!TERMINAL_STATES.has(task.state)&&processAlive(task.executorPid)===false;
  if(!existing&&!data.associated.length&&!orphan)refuse('No active quarantine for this incident.','NO_ACTIVE_QUARANTINE');
  if(!TERMINAL_STATES.has(task.state)&&!orphan)refuse('Task must be explicitly settled before quarantine release.','TASK_NOT_TERMINAL');
  if(data.processes.some(p=>['alive','unknown'].includes(p.observed.status)))refuse('A related process is alive or its identity cannot be verified.','PROCESS_EXIT_UNVERIFIED');
  const manual=existing?existing.receipt.method==='operator-attested':operatorVerified;
  if(manual&&!operatorVerified)refuse('Resuming an operator transaction requires --operator-verified.');
  if(!manual&&!data.proof.verified)refuse('Matching attempt exit proof is unavailable. Inspect locally; CLI --operator-verified requires an explicit operator verification.','EXIT_EVIDENCE_INSUFFICIENT');
  if(manual){const scan=relevantProcesses(task.workspace,ctx.taskPaths(task_id).dir);if(!scan.verified||scan.processes.length)refuse('OS process inventory is unavailable or related live processes were found.','PROCESS_EXIT_UNVERIFIED');}
  if(!apply)return {task_id,dry_run:true,can_release:true,method:manual?'operator-attested':'evidence-verified',expected_digest};
  let tx=existing,txFile=existing?.file;
  if(!tx){
   const id=hash(task_id+'\0'+expected_digest),receipt={id,task_id,method:manual?'operator-attested':'evidence-verified',reason:reason.trim(),expected_digest,attempt_id:task.attemptId??null,proof:manual?null:data.proof,released_at:new Date().toISOString(),historical_tree_exited:task.treeExited??null};
   const changes=[];
   const add=(file,next)=>{const before=bytes(file);changes.push({file,before:before?.toString('base64')??null,beforeHash:before?hash(before):null,after:next===null?null:Buffer.from(JSON.stringify(next,null,2)+'\n').toString('base64')});};
   for(const file of data.associated){
    const item=readJson(file),ids=[...new Set([item.taskId,...item.taskIds??[]])].filter(id=>id!==task_id);
    add(file,ids.length?{...item,taskId:ids[0],taskIds:ids}:null);
   }
   add(data.taskFile,{...task,...(orphan?{state:'interrupted',phase:'settled',finishedAt:Date.now(),reason:task.reason??{kind:'interrupted',code:'BRIDGE_EXITED',message:'Explicit recovery settled the abandoned task without replay.'}}:{}),quarantined:false,recoveryReceipt:receipt});
   const resultFile=ctx.taskPaths(task_id).result,result=readJson(resultFile,{optional:true});
   if(result){if(result.taskId!==task_id||result.conversationKey!==ctx.key)refuse('Result ownership mismatch.','QUARANTINE_CORRUPT');add(resultFile,{...result,quarantined:false,recoveryReceipt:receipt});}
   tx={version:1,id,taskId:task_id,workspace:canonicalWorkspace(task.workspace),scopeKey:ctx.key,expectedDigest:expected_digest,state:'pending',receipt,changes,originalSnapshot:data.snapshot};
   txFile=path.join(manager.stateRoot,'_locks','recoveries',id+'.json');
   // This pending receipt also blocks starts until every write is committed.
   writeJsonAtomic(txFile,tx);
  }
  let count=0;
  if(tx.version!==1||tx.taskId!==task_id||tx.scopeKey!==ctx.key||!Array.isArray(tx.changes))refuse('Corrupt recovery transaction.','QUARANTINE_CORRUPT');
  for(const change of tx.changes){
   const target=path.resolve(change.file);refuseLinks(manager.stateRoot,target);
   if(target!==data.taskFile&&target!==ctx.taskPaths(task_id).result&&target!==path.join(ctx.dir,'.execution-quarantine.json')&&![path.join(manager.stateRoot,'_locks','workspaces'),path.join(manager.stateRoot,'_locks','workspace-quarantines')].includes(path.dirname(target)))refuse('Invalid transaction target.','QUARANTINE_CORRUPT');
   const current=bytes(change.file),currentHash=current?hash(current):null,after=change.after===null?null:Buffer.from(change.after,'base64'),afterHash=after?hash(after):null;
   if(currentHash===afterHash)continue;
   if(currentHash!==change.beforeHash){
    // A new incident may share the scope file. Never delete or restore over it.
    const registryTarget=change.file!==data.taskFile&&change.file!==ctx.taskPaths(task_id).result;
    if(registryTarget&&current){
     const item=JSON.parse(current);
     if(!belongs(item,task_id))continue;
     const remaining=[...new Set([item.taskId,...item.taskIds??[]])].filter(id=>id!==task_id);
     if(remaining.length){writeJsonAtomic(change.file,{...item,taskId:remaining[0],taskIds:remaining});continue;}
    }
    refuse('Recovery target changed; pending transaction retained.','RECOVERY_CONFLICT');
   }
   if(after){writeJsonAtomic(change.file,JSON.parse(after));}else if(current)fs.unlinkSync(change.file);
   if(++count===faultAfter)throw new Error('Injected recovery interruption');
  }
  tx.state='committed';tx.committedAt=new Date().toISOString();delete tx.file;writeJsonAtomic(txFile,tx);
  return {task_id,released:true,idempotent:!!existing,receipt:tx.receipt};
 });}finally{unlock();}
}
