/** One task state machine for accept/queue/start/settle/cancel. */
import fs from 'node:fs';
import path from 'node:path';
import { createTaskId, TERMINAL_STATES } from './store.js';
import { DEFAULT_TIMEOUT_MS, runTask } from './task-runner.js';
import { normalizeSandboxMode } from './overlay.js';
import { normalizeWorkspace, canonicalWorkspace, acquireWorkspaceLock, confirmedDead, supervisedPids, quarantineWorkspace, assertWorkspaceNotQuarantined } from './workspace-lock.js';
import { acquireFileLock, delay } from './file-lock.js';
import { writeJsonAtomic, readJson, assertOwner, boundUtf8 } from './io.js';
import {verifyNativeSessions} from './session-verify.js';
import { createChannel, readCancellation, requestCancellation, ReportShardReader } from '../dsh-plugin/channel.js';
export class TaskScheduler {
  constructor(options) { this.options=options; this.jobs=new Map();this.persistenceFailures=new Map(); this.contexts=new Set(); this.closed=false; this.shutdownPromise=null; }
  attach(context) { if(!this.contexts.has(context)) { context.store.recoverInterrupted(); this.contexts.add(context); } return context; }
  submit(context,args,acceptance) {
    if(this.closed) throw new Error('Bridge connection is closed; new tasks are refused.'); this.attach(context);
    if(typeof args.prompt!=='string'||!args.prompt.trim()||args.prompt.includes('\0')) throw new TypeError('Prompt must be non-empty.');
    if(Boolean(args.provider)!==Boolean(args.model)) throw new TypeError('provider and model must be supplied together.');
    const workspace=normalizeWorkspace(args.workspace ?? this.options.defaultWorkspace), sandboxMode=normalizeSandboxMode(args.sandbox_mode);
    const timeoutMs=args.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>86400000) throw new TypeError('timeout_ms must be an integer between 1 and 86400000.');
    const createdAt=Date.now(), taskId=createTaskId(), deadline=createdAt+timeoutMs, paths=context.taskPaths(taskId);
    const record={version:context.store.version??2,taskId,conversationKey:context.key,prompt:args.prompt,workspace,sandboxMode,state:'queued',phase:'accepted',createdAt,updatedAt:createdAt,deadline,
      sessionId:null,adoptedSessionId:null,answer:null,exitCode:null,reason:null,reportCount:0,executorPid:process.pid,paths};
    acceptance?.lifecycle({phase:'accepted',taskId,paths,workspace,sandboxMode,state:record.state});
    createChannel(paths.inbox,{conversationKey:context.key,taskId}); context.store.putTask(record);
    const controller=new AbortController(); let resolve;
    const promise=new Promise(done=> {resolve=done;});
    const job={context,record,paths,args,controller,promise,resolve,started:false,launched:false,finished:false,acceptance};
    this.jobs.set(taskId,job); context.controllers.set(taskId,controller);
    job.timer=setTimeout(()=>controller.abort({kind:'timeout',message:'Task deadline exceeded (queue, provisioning and execution share one budget).'}),Math.max(1,deadline-Date.now()));
    job.controlPoll=setInterval(()=> { try { const request=job.acceptance?.stopReason?.() ?? readCancellation(paths.inbox,{conversationKey:context.key,taskId}); if(request&&!controller.signal.aborted) controller.abort(request); }
      catch(error) { controller.abort({kind:'error',message:'Control channel failed: '+error.message}); } },100);
    controller.signal.addEventListener('abort',()=> {
      if(!job.started&&!job.finished) this.finish(job,{state:controller.signal.reason?.kind==='timeout'?'timeout':controller.signal.reason?.kind==='error'?'failed':'cancelled',reason:controller.signal.reason,treeExited:true});
    },{once:true});
    context.runExclusive(async()=> { if(!job.finished) await this.execute(job); }).catch(error=> { if(!job.finished) this.finish(job,{state:'failed',reason:{kind:'error',message:error.message}}); });
    return job;
  }
  getTask(context,taskId) {const cached=this.persistenceFailures.get(taskId);return cached?.conversationKey===context.key?cached:context.store.getTask(taskId);}
  update(job,patch) { if(job.finished) return; Object.assign(job.record,patch,{updatedAt:Date.now()}); job.context.store.putTask(job.record); job.acceptance?.lifecycle({phase:patch.phase ?? job.record.phase,taskId:job.record.taskId,state:job.record.state,sessionId:job.record.sessionId,patch}); }
  async execute(job) {
    const {context,record,controller,paths,args}=job; job.started=true; let releaseConversation,releaseWorkspace;
    try {
      this.update(job,{phase:context.manager?'waiting-session':'waiting-conversation'});
      releaseConversation=await acquireFileLock(path.join(context.dir,'.execution.lock'),{signal:controller.signal,deadline:record.deadline});
      context.assertExecution?.(args,record.workspace);
      const quarantineFile=path.join(context.dir,'.execution-quarantine.json'), quarantine=readJson(quarantineFile,{optional:true});
      if(quarantine) {
        assertOwner(quarantine,context.key);
        if(!confirmedDead(quarantine.processPids)) throw Object.assign(new Error('A prior task has an unconfirmed process-tree exit. No new execution or session reuse is allowed until termination is verified.'),{code:'EXECUTION_QUARANTINED'});
        fs.unlinkSync(quarantineFile);
      }
      if(Date.now()>=record.deadline&&!controller.signal.aborted) controller.abort({kind:'timeout',message:'Task deadline exceeded before execution.'});
      if(controller.signal.aborted) throw controller.signal.reason;
      this.update(job,{phase:'waiting-workspace'});
      releaseWorkspace=await acquireWorkspaceLock({stateRoot:this.options.stateRoot,conversationKey:context.key,taskId:record.taskId,workspace:record.workspace,mode:record.sandboxMode,createdAt:record.createdAt,deadline:record.deadline,signal:controller.signal});
      if(controller.signal.aborted) throw controller.signal.reason;
      if(context.manager)assertWorkspaceNotQuarantined(this.options.stateRoot,record.workspace,record.sandboxMode);
      const session=context.store.readSession();
      if(args.session_id!==undefined&&session.sessionId!==args.session_id)throw Object.assign(new Error('Explicit session selection no longer matches persisted state.'),{code:'SESSION_STATE_CORRUPT'});
      if(!args.new_session && session.sessionId) {
        if(!session.verified) throw Object.assign(new Error('Stored session cannot be verified; request new_session explicitly. The original task was not replayed.'),{code:'SESSION_UNVERIFIED'});
        if(!session.workspace || canonicalWorkspace(session.workspace)!==canonicalWorkspace(record.workspace)) throw Object.assign(new Error('Stored session workspace differs; use new_session for a different workspace. No task was replayed.'),{code:'SESSION_WORKSPACE_MISMATCH'});
        record.adoptedSessionId=session.sessionId;
      }
      this.update(job,{state:'preparing',phase:'preparing',startedAt:Date.now(),adoptedSessionId:record.adoptedSessionId});
      if(context.manager&&record.adoptedSessionId){this.update(job,{phase:'validating-session'});const verify=this.options.verifySessionImpl??(this.options.runTaskImpl?async()=>({verified:true,synthetic:true}):verifyNativeSessions);await verify({sessionRoot:context.sessionRoot(),sessions:[{sessionId:record.adoptedSessionId,workspace:record.workspace}],env:this.options.env,signal:controller.signal,deadline:record.deadline});}
      const report=(payload)=> {
        if(job.finished) return;
        const stored=context.queue.pushIfNew({...payload,taskId:record.taskId});
        if(stored) this.update(job,{reportCount:context.queue.latestSeq(record.taskId)});
      };
      const captureSession=(sessionId,cwd,{verified=true}={})=> {
        if(job.finished) return;
        if(canonicalWorkspace(cwd ?? record.workspace)!==canonicalWorkspace(record.workspace)) throw new Error('Captured session workspace mismatch.');
        context.store.writeSession(sessionId,record.workspace,{taskId:record.taskId,verified});
        this.update(job,{sessionId,sessionVerified:verified});
      };
      const result=await (this.options.runTaskImpl ?? runTask)({taskId:record.taskId,conversationKey:context.key,prompt:record.prompt,workspace:record.workspace,sandboxMode:record.sandboxMode,
        provider:args.provider,model:args.model,createdAt:record.createdAt,deadline:record.deadline,timeoutMs:record.deadline-Date.now(),sessionId:record.adoptedSessionId,
        stateRoot:this.options.stateRoot,sessionRoot:context.sessionRoot(),paths,sourceEnv:this.options.env,signal:controller.signal,acceptance:job.acceptance?.receipt,
        onReport:report,onDiagnostic:line=> { context.diagnostic(line); this.options.note?.(line); },onSession:captureSession,
        onProcess:event=> {job.launched=true;const patch={state:'running',phase:'starting',processPid:event.pid,guardianPid:event.guardianPid,workerPid:event.workerPid,supervision:event.supervision,processStartedAt:Date.now()};Object.assign(record,patch);releaseWorkspace?.track?.(record);this.update(job,patch);},
        onPhase:phase=>this.update(job,{phase}),onRuntime:runtime=>this.update(job,{runtime})});
      if(result.treeExited===false||job.launched&&result.treeExited!==true)throw Object.assign(new Error('Runner did not confirm process-tree exit.'),{code:'TREE_EXIT_UNCONFIRMED',treeExited:false});
      if(result.conversationKey!==undefined && result.conversationKey!==context.key) throw new Error('Runner result ownership mismatch.');
      // Injected test runners need not expose a live process; a returned result means they settled.
      if(result.sessionId&&!record.sessionId) captureSession(result.sessionId,result.cwd ?? record.workspace);
      const shards=new ReportShardReader(paths.inbox,{conversationKey:context.key,taskId:record.taskId}); shards.poll(report);
      if(controller.signal.aborted && result.treeExited!==false) {
        const reason=controller.signal.reason, state=reason?.kind==='timeout'?'timeout':reason?.kind==='error'?'failed':'cancelled';
        Object.assign(result,{state,reason});
      }
      job.result={...result};
    } catch(error) {
      const aborted=controller.signal.aborted, unconfirmed=error?.code==='TREE_EXIT_UNCONFIRMED'||job.launched&&error?.treeExited!==true;
      job.result={state:unconfirmed?'interrupted':aborted?(controller.signal.reason?.kind==='timeout'?'timeout':controller.signal.reason?.kind==='error'?'failed':'cancelled'):'failed',
        reason:{kind:unconfirmed?'interrupted':aborted?controller.signal.reason?.kind ?? 'cancelled':'error',code:error?.code,
          message:unconfirmed?'Process-tree exit was not confirmed: '+(error.message ?? 'termination failure'):error.message ?? controller.signal.reason?.message ?? String(error)},treeExited:!unconfirmed&&!job.launched || error?.treeExited===true};
    } finally {
      if(job.result?.state==='interrupted' && job.result?.treeExited!==true) {
        const processPids=supervisedPids(record);
        try {
          writeJsonAtomic(path.join(context.dir,'.execution-quarantine.json'),{version:2,conversationKey:context.key,taskId:record.taskId,processPids,createdAt:Date.now()});
          releaseWorkspace?.quarantine?.(processPids); if(context.manager)quarantineWorkspace({stateRoot:this.options.stateRoot,workspace:record.workspace,scopeKey:context.key,taskId:record.taskId,processPids});record.quarantined=true;
          // Keep the durable claim. Never permit overlapping writers on an unconfirmed exit.
          releaseWorkspace=undefined;
        } catch(error) { job.result={...job.result,state:'interrupted',reason:{kind:'interrupted',code:'QUARANTINE_WRITE_FAILED',message:error.message}}; this.options.note?.(error.message); } finally { releaseWorkspace=undefined; }
      }
      for (const release of [releaseWorkspace,releaseConversation]) {
        try { release?.(); } catch(error) { job.result={...job.result,state:'failed',reason:{kind:'error',code:'LOCK_RELEASE_FAILED',message:error.message}}; this.options.note?.(error.message); }
      }
      this.finish(job,job.result);
    }
  }
  finish(job,result={}) {
    if(job.finished) return; job.finished=true;
    clearTimeout(job.timer); clearInterval(job.controlPoll);
    const {context,record}=job, now=Date.now();
    Object.assign(record,{state:TERMINAL_STATES.has(result.state)?result.state:'failed',phase:'settled',updatedAt:now,finishedAt:now,durationMs:now-record.createdAt,
      answer:result.answer ?? null,reason:result.reason ?? {kind:'error',message:'Task did not produce a terminal state'},exitCode:result.exitCode ?? null,
      sessionId:result.sessionId ?? record.sessionId,stderrTail:result.stderrTail ?? '',treeExited:result.treeExited ?? !job.launched});
    let outputPersisted=false;
    try {
      context.queue.pushIfNew({taskId:record.taskId,eventId:record.taskId+':terminal',kind:record.state==='completed'?'final':'system',agentRole:'bridge',
        text:record.state==='completed'?'Task completed.': 'Task '+record.state+': '+(record.reason?.message ?? record.reason?.kind ?? 'unknown'),data:{state:record.state}});
      record.reportCount=context.queue.latestSeq(record.taskId);
      writeJsonAtomic(job.paths.result,{...record});outputPersisted=true;context.store.putTask(record);
    } catch(error) {
      record.state='failed';record.reason={kind:'error',code:'STATE_WRITE_FAILED',message:'Task persistence failed: '+error.message};
      context.diagnostic(record.reason.message);this.options.note?.(record.reason.message);
      try {writeJsonAtomic(job.paths.result,{...record});outputPersisted=true;} catch {}
      record.fullContentAvailable=outputPersisted;
      try {context.store.putTask(record);} catch {
        // Only failed persistence needs volatile fallback. Never retain full answers/prompts.
        this.persistenceFailures.set(record.taskId,{...record,prompt:undefined,answer:null,stderrTail:boundUtf8(record.stderrTail,4000).text,reason:{...record.reason,message:boundUtf8(record.reason.message,8192).text}});
        if(this.persistenceFailures.size>128)this.persistenceFailures.delete(this.persistenceFailures.keys().next().value);
      }
    } finally {
      try {job.acceptance?.lifecycle({phase:'settled',taskId:record.taskId,state:record.state,sessionId:record.sessionId,treeExited:record.treeExited,processPid:record.processPid,guardianPid:record.guardianPid,workerPid:record.workerPid,finishedAt:record.finishedAt,paths});}
      catch(error) {this.options.note?.('Acceptance audit failed: '+error.message);}
      context.controllers.delete(record.taskId);this.jobs.delete(record.taskId);job.resolve({...record});
    }
  }
  cancel(context,taskId,reason={kind:'cancelled',message:'Cancelled by MCP controller'}) {
    const job=this.jobs.get(taskId);
    if(job) { if(job.context!==context) throw new Error('Task owner mismatch'); job.controller.abort(reason); }
    else requestCancellation(context.taskPaths(taskId).inbox,reason,{conversationKey:context.key,taskId});
  }
  async waitForTerminal(context,taskId,budget=30000,signal) {
    const until=Date.now()+budget;
    while(true) { const task=this.getTask(context,taskId); if(!task || TERMINAL_STATES.has(task.state) || Date.now()>=until) return task; await delay(25,signal); }
  }
  shutdown() {
    if(this.shutdownPromise) return this.shutdownPromise; this.closed=true;
    const pending=[...this.jobs.values()]; for(const job of pending) job.controller.abort({kind:'cancelled',message:'MCP connection closed; guardian is stopping the task.'});
    this.shutdownPromise=Promise.all(pending.map(job=>job.promise)).then(()=>undefined); return this.shutdownPromise;
  }
}
