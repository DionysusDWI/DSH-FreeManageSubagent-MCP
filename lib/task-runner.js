/** DSH execution under a guardian. No task-local report mirror is retained. */
import fs from 'node:fs';
import path from 'node:path';
import { DshStreamParser, deriveOutcome } from './dsh-stream.js';
import { buildOverlayPatches, normalizeSandboxMode, serializeOverlay } from './overlay.js';
import { taskPaths, repoRoot } from './paths.js';
import { ensureBridgeProfile, resolveRuntime, assertCompatibleRuntime } from './dsh-profile.js';
import { createTaskId } from './store.js';
import { assertOwner, readJson, writeJsonAtomic } from './io.js';
import { normalizeWorkspace, canonicalWorkspace } from './workspace-lock.js';
import { supervise } from './supervisor.js';
import { appendGuidance, createChannel, ReportShardReader, requestCancellation } from '../dsh-plugin/channel.js';
export const DEFAULT_TIMEOUT_MS=20*60*1000;
export function readTail(file,maxBytes=4000) {
  let fd;
  try { fd=fs.openSync(file,'r'); const size=fs.fstatSync(fd).size, bytes=Buffer.alloc(Math.min(size,maxBytes)); fs.readSync(fd,bytes,0,bytes.length,Math.max(0,size-bytes.length)); return bytes.toString('utf8').replace(/^\uFFFD+/, ''); }
  catch(error) { if(error.code==='ENOENT') return ''; throw error; }
  finally { if(fd!==undefined) fs.closeSync(fd); }
}
export function appendSteering(conversationKey,taskId,message,stateRoot) {
  const paths=taskPaths(conversationKey,taskId,stateRoot); createChannel(paths.inbox,{conversationKey,taskId});
  const record=appendGuidance(paths.inbox,message,{owner:{conversationKey,taskId}}); return {...record,path:paths.inbox};
}
export async function runTask(input) {
  const createdAt=input.createdAt ?? Date.now(), deadline=input.deadline ?? createdAt+(input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const taskId=input.taskId ?? createTaskId(), owner={conversationKey:input.conversationKey,taskId};
  if(typeof input.prompt!=='string' || !input.prompt.trim()) throw new TypeError('Prompt must be non-empty.');
  const workspace=normalizeWorkspace(input.workspace), sandboxMode=normalizeSandboxMode(input.sandboxMode);
  // Validate model pairing before provisioning or launching any process.
  const paths=input.paths ?? taskPaths(input.conversationKey,taskId,input.stateRoot);
  const patches=buildOverlayPatches({workspace,storageRoot:paths.storages,sessionRoot:input.sessionRoot ?? paths.sessions,sandboxMode,provider:input.provider,model:input.model});
  if(process.platform==='win32' && !fs.existsSync(path.join(repoRoot(),'native','windows-job-host.exe'))) throw Object.assign(new Error('Windows guardian is missing. Unsupervised DSH execution is refused.'),{code:'GUARDIAN_MISSING'});
  const controller=new AbortController(), abort=()=>controller.abort(input.signal.reason);
  input.signal?.addEventListener('abort',abort,{once:true}); if(input.signal?.aborted) abort();
  const timer=setTimeout(()=>controller.abort({kind:'timeout',message:'Task deadline exceeded, including preparation and queue time.'}),Math.max(1,deadline-Date.now()));
  let eventsFd,stderrFd,pollTimer,ioError=null,parser,exit=null,streamSeq=0,capturedSession=null;
  const note=input.onDiagnostic ?? (()=>{});
  const onReport=input.onReport ?? (()=>{});
  try {
    if(Date.now()>=deadline&&!controller.signal.aborted) controller.abort({kind:'timeout',message:'Task deadline exceeded before DSH launch.'});
    if(controller.signal.aborted) throw controller.signal.reason;
    const runtime=input.runtime ?? resolveRuntime(input.sourceEnv ?? process.env);
    if(!input.ensureProfileImpl) assertCompatibleRuntime(runtime);
    input.onPhase?.('provisioning');
    const profile=await (input.ensureProfileImpl ?? ensureBridgeProfile)({env:runtime.env,runtime,signal:controller.signal,deadline,onDiagnostic:note});
    if(controller.signal.aborted) throw controller.signal.reason;
    input.onRuntime?.({launcher:runtime.launcher,home:runtime.home,version:runtime.version,profile:profile.name,profileFingerprint:profile.fingerprint});
    fs.mkdirSync(paths.dir,{recursive:true}); createChannel(paths.inbox,owner);
    fs.writeFileSync(paths.overlay,serializeOverlay(patches),'utf8');
    eventsFd=fs.openSync(paths.reportLog,'a',0o600); stderrFd=fs.openSync(paths.stderrLog,'a',0o600);
    const shards=new ReportShardReader(paths.inbox,owner,{onMalformed:()=>note('Malformed report shard bytes are retained on disk; valid subsequent events continue.')});
    function captureSession(sessionId,cwd) {
      const proof=readJson(path.join(paths.dir,'policy.json'),{optional:true});if(!proof)throw Object.assign(new Error('DSH permission verification proof is missing; unverified execution is refused.'),{code:'PERMISSION_VERIFICATION_FAILED'}); assertOwner(proof,owner.conversationKey,owner.taskId);
      if(cwd && canonicalWorkspace(cwd)!==canonicalWorkspace(workspace)) throw new Error('DSH session event workspace mismatch.');
      if(proof.verified!==true || proof.agentRole!=='main' || proof.agentId!==sessionId || proof.approvalPolicy!==(sandboxMode==='danger-full-access'?'never':'ask') || proof.sessionId!==sessionId || proof.sandboxMode!==sandboxMode || canonicalWorkspace(proof.workspace)!==canonicalWorkspace(workspace)) throw Object.assign(new Error('DSH permission verification proof is missing or mismatched; execution stopped.'),{code:'PERMISSION_VERIFICATION_FAILED'});
      if(capturedSession&&capturedSession!==sessionId) throw new Error('Main session identity changed within one task.');
      if(!capturedSession) {
        capturedSession=sessionId;
        writeJsonAtomic(path.join(paths.dir,'session.json'),{version:2,...owner,sessionId,cwd:cwd ?? workspace,verified:true,ts:Date.now()});
        input.onSession?.(sessionId,cwd ?? workspace,{verified:true}); input.onPhase?.('executing');
      }
    }
    parser=new DshStreamParser({canonicalReports:true,
      onReport:report=>onReport({...report,eventId:taskId+':stream:'+(++streamSeq),agentId:capturedSession ?? parser.sessionId ?? undefined,agentRole:'main'}),
      onSession:captureSession,onMalformed:line=>note('DSH emitted malformed JSON ('+Buffer.byteLength(line)+' bytes; raw event log preserved).')});
    function poll() { try { if(!capturedSession){const proof=readJson(path.join(paths.dir,'policy.json'),{optional:true});if(proof) captureSession(proof.sessionId,proof.workspace);} shards.poll(onReport); } catch(error) { ioError ??= error; controller.abort({kind:'error',message:error.message}); } }
    pollTimer=setInterval(poll,100);
    controller.signal.addEventListener('abort',()=> { try { requestCancellation(paths.inbox,controller.signal.reason ?? {kind:'cancelled'},owner); } catch(e) { ioError ??= e; } },{once:true});
    const args=['--profile',profile.name,'--patch',paths.overlay,'--json'];
    if(input.sessionId) args.push('--session-id',input.sessionId);
    args.push('--',input.prompt);
    exit=await (input.superviseImpl ?? supervise)({command:runtime.launcher.command,args:[...runtime.launcher.prefixArgs,runtime.launcher.launcherScript,...args],cwd:workspace,
      env:{...runtime.env,DSH_MCP_ACCEPTANCE_TASK:input.acceptance?JSON.stringify({...input.acceptance,taskId}):'',DSH_MCP_CHANNEL:paths.inbox,DSH_MCP_TASK:taskId,DSH_MCP_SCOPE:owner.conversationKey,DSH_MCP_WORKSPACE:workspace,DSH_MCP_SANDBOX:sandboxMode},
      channel:paths.inbox,owner,signal:controller.signal,deadline:input.deadline,stateDir:paths.dir,onDiagnostic:note,onSupervision:input.onSupervision,authorizeLaunch:input.authorizeLaunch,
      onStarted:event=> { input.onProcess?.(event); input.onPhase?.('starting'); },
      onStdout:chunk=> { fs.writeFileSync(eventsFd,chunk); parser.write(chunk); }, onStderr:chunk=>fs.writeFileSync(stderrFd,chunk)});
    if(!exit.treeExited) throw Object.assign(new Error('Process-tree exit was not confirmed.'),{code:'TREE_EXIT_UNCONFIRMED'});
    parser.flush(); poll(); if(ioError) throw ioError;
    for(const fd of [eventsFd,stderrFd]) fs.fsyncSync(fd);
    const reason=controller.signal.reason;
    const outcome=deriveOutcome({parser,exitCode:exit.code,cancelled:controller.signal.aborted&&reason?.kind!=='timeout',timedOut:controller.signal.aborted&&reason?.kind==='timeout'});
    if(outcome.state==='completed'&&!capturedSession)throw Object.assign(new Error('DSH returned an answer without a verified main-session permission proof.'),{code:'PERMISSION_VERIFICATION_FAILED'});
    if(controller.signal.aborted&&reason?.kind==='error') Object.assign(outcome,{state:'failed',reason});
    return {...owner,...outcome,exitCode:exit.code,sessionId:capturedSession ?? parser.sessionId,cwd:parser.cwd,workspace,sandboxMode,adoptedSessionId:input.sessionId ?? null,
      durationMs:Date.now()-createdAt,stderrTail:readTail(paths.stderrLog),paths,treeExited:true};
  } catch(error) { if(exit?.treeExited && error && typeof error==='object') error.treeExited=true; throw error; } finally {
    clearTimeout(timer); clearInterval(pollTimer); input.signal?.removeEventListener('abort',abort);
    for(const fd of [eventsFd,stderrFd]) if(fd!==undefined) fs.closeSync(fd);
  }
}
