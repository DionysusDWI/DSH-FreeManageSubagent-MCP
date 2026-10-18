/** SDK execution inside the existing per-task guardian; durable interactions remain a separate control channel. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {SdkRpcPeer,SdkObservation} from './sdk-rpc.js';
import {buildOverlayPatches,serializeOverlay} from './overlay.js';
import {normalizeTaskConfiguration} from './task-config.js';
import {taskPaths,repoRoot} from './paths.js';
import {ensureBridgeProfile,resolveRuntime,assertCompatibleRuntime} from './dsh-profile.js';
import {createTaskId} from './store.js';
import {assertOwner,readJson,writeJsonAtomic} from './io.js';
import {normalizeWorkspace,canonicalWorkspace} from './workspace-lock.js';
import {supervise} from './supervisor.js';
import {resolveCredentialEnvironment} from './credential-environment.js';
import {delay} from './file-lock.js';
import {InteractionStore} from '../dsh-plugin/interactions.js';
import {appendGuidance,createChannel,ReportShardReader,requestCancellation} from '../dsh-plugin/channel.js';
export const DEFAULT_TIMEOUT_MS=20*60*1000;
export function readTail(file,maxBytes=4000) {
  let fd;try{fd=fs.openSync(file,'r');const size=fs.fstatSync(fd).size,bytes=Buffer.alloc(Math.min(size,maxBytes));fs.readSync(fd,bytes,0,bytes.length,Math.max(0,size-bytes.length));return bytes.toString('utf8').replace(/^\uFFFD+/,'');}
  catch(error){if(error.code==='ENOENT')return '';throw error;}finally{if(fd!==undefined)fs.closeSync(fd);}
}
export function appendSteering(conversationKey,taskId,message,stateRoot) {
  const paths=taskPaths(conversationKey,taskId,stateRoot);createChannel(paths.inbox,{conversationKey,taskId});
  return {...appendGuidance(paths.inbox,message,{owner:{conversationKey,taskId}}),path:paths.inbox};
}
export async function runTask(input) {
  const createdAt=input.createdAt??Date.now(),deadline=input.deadline??createdAt+(input.timeoutMs??DEFAULT_TIMEOUT_MS);
  const taskId=input.taskId??createTaskId(),owner={conversationKey:input.conversationKey,taskId};
  if(!input.continuationRequestId&&(typeof input.prompt!=='string'||!input.prompt.trim()))throw new TypeError('Prompt must be non-empty.');
  if(input.continuationRequestId&&!input.sessionId)throw new Error('Questionnaire continuation requires an explicit native session.');
  const workspace=normalizeWorkspace(input.workspace),configuration=input.configuration??normalizeTaskConfiguration({sandbox_mode:input.sandboxMode,permission_mode:input.permissionMode,
    provider:input.provider,model:input.model,reasoning_effort:input.reasoningEffort,question_policy:input.questionPolicy,question_timeout_seconds:input.questionTimeoutSeconds});
  const selected=configuration.resolved,paths=input.paths??taskPaths(input.conversationKey,taskId,input.stateRoot);
  const patches=buildOverlayPatches({workspace,storageRoot:paths.storages,sessionRoot:input.sessionRoot??paths.sessions,configuration});
  if(process.platform==='win32'&&!fs.existsSync(path.join(repoRoot(),'native','windows-job-host.exe')))throw Object.assign(new Error('Windows guardian is missing. Unsupervised DSH execution refused.'),{code:'GUARDIAN_MISSING'});
  const controller=new AbortController(),abort=()=>controller.abort(input.signal.reason);
  input.signal?.addEventListener('abort',abort,{once:true});if(input.signal?.aborted)abort();
  const timer=setTimeout(()=>controller.abort({kind:'timeout',message:'Task deadline exceeded, including preparation and queue time.'}),Math.max(1,deadline-Date.now()));
  const sessionId=input.sessionId??crypto.randomUUID(),note=input.onDiagnostic??(()=>{}),onReport=input.onReport??(()=>{});
  let eventsFd,stderrFd,pollTimer,ioError=null,exit=null,capturedSession=null,driver=null,driverFinished=false,settlement=null,effectiveConfiguration=null;
  const observation=new SdkObservation(sessionId,onReport);
  const peer=new SdkRpcPeer({onNotification:(method,params)=>observation.notification(method,params)});
  const interactionOwner=input.interactionSource?.owner??owner;
  const interactions=new InteractionStore(input.interactionSource?.dir??paths.dir,interactionOwner);
  const fail=error=>{ioError??=error;controller.abort(error.code==='SDK_REQUEST_TIMEOUT'&&Date.now()>=deadline-1?{kind:'timeout',message:'Task total deadline reached during SDK wait.'}:{kind:'error',code:error.code,message:error.message});};
  async function rpc(method,params,limit=Infinity) {return peer.request(method,params,{timeoutMs:Math.max(1,Math.min(limit,deadline-Date.now()))});}
  function captureSession() {
    const proof=readJson(path.join(paths.dir,'policy.json'),{optional:true});
    if(!proof)throw new Error('Native preset verification proof is missing.');assertOwner(proof,owner.conversationKey,taskId);
    const nativeMode=selected.permissionMode==='auto'?'danger-full-access':selected.permissionMode;
    if(proof.version!==3||proof.verified!==true||proof.agentRole!=='main'||proof.agentId!==sessionId||proof.sessionId!==sessionId||proof.permissionMode!==selected.permissionMode
      ||proof.nativePreset!==selected.permissionMode||proof.sandboxMode!==nativeMode||proof.approvalPolicy!=='ask'||canonicalWorkspace(proof.workspace)!==canonicalWorkspace(workspace))throw Object.assign(new Error('Native preset proof mismatch.'),{code:'PERMISSION_VERIFICATION_FAILED'});
    effectiveConfiguration={...selected,...proof.modelConfiguration,nativePreset:proof.nativePreset,nativeSandboxMode:proof.sandboxMode,nativeApprovalPolicy:proof.approvalPolicy,
      originalProject:proof.originalProject,effectiveWorkingDirectory:proof.effectiveWorkingDirectory};
    capturedSession=sessionId;writeJsonAtomic(path.join(paths.dir,'session.json'),{version:3,...owner,sessionId,workspace,cwd:proof.effectiveWorkingDirectory,verified:true,ts:Date.now()});
    input.onSession?.(sessionId,workspace,{verified:true,effectiveWorkingDirectory:proof.effectiveWorkingDirectory});input.onEffectiveConfiguration?.(effectiveConfiguration);input.onPhase?.('executing');
  }
  async function drive(transport) {
    peer.attach(transport);
    const initialized=await rpc('initialize',{cwd:workspace,provider:selected.provider,model:selected.model,...(selected.reasoningEffort===null?{}:{reasoningEffort:selected.reasoningEffort})},15000);
    if(initialized?.serverInfo?.name!=='deepseek-harness-sdk-runtime'||initialized.serverInfo.version!=='0.0.1')throw new Error('Unsupported official SDK protocol identity.');
    if(input.sessionId)await rpc('session/resume',{sessionId});
    const current=await rpc('session/working-directory/get',{sessionId});
    captureSession();if(current.cwd!==effectiveConfiguration.effectiveWorkingDirectory)throw new Error('SDK working directory disagrees with native projection proof.');
    if(input.continuationRequestId) {
      input.onPhase?.('applying-answer');
      while(true) {
        const receipt=interactions.read('receipts',input.continuationRequestId);
        if(receipt){if(receipt.applied!==true)throw new Error(receipt.error??'Native answer application failed.');break;}
        controller.signal.throwIfAborted();await delay(25,controller.signal);
      }
    } else {
      const receipt=await rpc('session/prompt',{sessionId,contentBlocks:[{type:'text',text:input.prompt}]});
      if(typeof receipt.messageId!=='string'||!receipt.messageId)throw new Error('SDK prompt has no durable enqueue receipt.');
    }
    await rpc('session/wait',{sessionId});
    writeJsonAtomic(path.join(paths.dir,'bridge-control.json'),{version:1,...owner,type:'settle'});
    while(!(settlement=readJson(path.join(paths.dir,'bridge-settled.json'),{optional:true}))) {controller.signal.throwIfAborted();await delay(25,controller.signal);}
    assertOwner(settlement,owner.conversationKey,taskId);
    if(settlement.sessionId!==sessionId)throw new Error('Native settlement session mismatch.');
    effectiveConfiguration.effectiveWorkingDirectory=settlement.effectiveWorkingDirectory;input.onEffectiveConfiguration?.(effectiveConfiguration);
    await rpc('session/wait',{sessionId});
    input.onPhase?.('persisting');await rpc('shutdown',undefined,10000);
  }
  try {
    if(Date.now()>=deadline&&!controller.signal.aborted)controller.abort({kind:'timeout',message:'Task deadline expired before preparation.'});
    controller.signal.throwIfAborted();
    const baseRuntime=input.runtime??resolveRuntime(input.sourceEnv??process.env);
    const credentials=resolveCredentialEnvironment(baseRuntime.env,{...input.credentialEnvironmentOptions,timeoutMs:Math.max(1,deadline-Date.now())});
    const runtime={...baseRuntime,env:credentials.env};if(!input.ensureProfileImpl)assertCompatibleRuntime(runtime);
    input.onPhase?.('provisioning');const profile=await(input.ensureProfileImpl??ensureBridgeProfile)({env:runtime.env,runtime,signal:controller.signal,deadline,onDiagnostic:note});
    controller.signal.throwIfAborted();
    input.onRuntime?.({launcher:runtime.launcher,home:runtime.home,version:runtime.version,profile:profile.name,profileFingerprint:profile.fingerprint,transport:'sdk-jsonrpc',credentialEnvironment:credentials.diagnosis});
    fs.mkdirSync(paths.dir,{recursive:true});createChannel(paths.inbox,owner);fs.writeFileSync(paths.overlay,serializeOverlay(patches),'utf8');
    eventsFd=fs.openSync(paths.reportLog,'a',0o600);stderrFd=fs.openSync(paths.stderrLog,'a',0o600);
    const shards=new ReportShardReader(paths.inbox,owner,{onMalformed:()=>note('Malformed report shard retained; subsequent valid records continue.')});
    function poll() {try {
      shards.poll(onReport);
      const failure=readJson(path.join(paths.dir,'bridge-failure.json'),{optional:true});if(failure)throw new Error(failure.message);
      const pending=interactions.pending().filter(s=>!s.response||s.response.deliveryTaskId===taskId);
      const summaries=pending.map(s=>interactions.summary(s));input.onInteractions?.(summaries);
      if(pending.some(s=>s.state.status==='open'&&!s.response))input.onPhase?.(pending.some(s=>s.request.type==='approval')?'waiting-approval':'waiting-questionnaire');
      else if(capturedSession&&!settlement)input.onPhase?.('executing');
    }catch(error){fail(error);}}
    pollTimer=setInterval(poll,100);
    controller.signal.addEventListener('abort',()=>{try{requestCancellation(paths.inbox,controller.signal.reason??{kind:'cancelled'},owner);}catch(error){ioError??=error;}peer.close(new Error('DSH task aborted.'));},{once:true});
    const args=['--profile',profile.name,'--patch',paths.overlay];
    exit=await(input.superviseImpl??supervise)({command:runtime.launcher.command,args:[...runtime.launcher.prefixArgs,runtime.launcher.launcherScript,...args],cwd:workspace,
      env:{...runtime.env,DSH_MCP_ACCEPTANCE_TASK:input.acceptance?JSON.stringify({...input.acceptance,taskId}):'',DSH_MCP_CHANNEL:paths.inbox,DSH_MCP_TASK:taskId,
        DSH_MCP_SCOPE:owner.conversationKey,DSH_MCP_WORKSPACE:workspace,DSH_MCP_CONFIGURATION:JSON.stringify(selected),DSH_MCP_DEADLINE:String(deadline),
        DSH_MCP_INTERACTION_SOURCE:input.interactionSource?JSON.stringify(input.interactionSource):'',DSH_MCP_CONTINUATION_REQUEST:input.continuationRequestId??''},
      duplex:true,channel:paths.inbox,owner,signal:controller.signal,deadline,stateDir:paths.dir,onDiagnostic:note,onSupervision:input.onSupervision,authorizeLaunch:input.authorizeLaunch,
      onStarted:event=>{input.onProcess?.(event);input.onPhase?.('initializing-sdk');},
      onTransport:transport=>{driver=drive(transport);driver.then(()=>{driverFinished=true;},error=>{if(!controller.signal.aborted)fail(error);});},
      onStdout:chunk=>{fs.writeFileSync(eventsFd,chunk);peer.write(chunk);},onStderr:chunk=>fs.writeFileSync(stderrFd,chunk)});
    if(!exit.treeExited)throw Object.assign(new Error('Process-tree exit unconfirmed.'),{code:'TREE_EXIT_UNCONFIRMED',treeExited:false});
    if(!driver&&!controller.signal.aborted)throw new Error('Guardian never negotiated SDK input.');
    // Settle protocol promises before closing log descriptors, including an unexpectedly early EOF.
    if(!driverFinished&&!controller.signal.aborted)fail(new Error('DSH exited before SDK shutdown completed.'));
    if(peer.pending.size)peer.close(new Error('DSH exited before the SDK protocol completed.'));
    await driver?.catch(error=>{if(!controller.signal.aborted)ioError??=error;});
    if(!controller.signal.aborted)peer.finish();poll();for(const fd of[eventsFd,stderrFd])fs.fsyncSync(fd);
    const reason=controller.signal.reason;
    const outcome=observation.outcome({exitCode:exit.code,proof:settlement,cancelled:controller.signal.aborted&&reason?.kind!=='timeout',timedOut:controller.signal.aborted&&reason?.kind==='timeout'});
    if(ioError&&reason?.kind!=='timeout')Object.assign(outcome,{state:'failed',reason:{kind:'error',code:ioError.code,message:ioError.message}});
    if(outcome.state==='completed'&&!capturedSession)throw new Error('No verified main session.');
    return {...owner,...outcome,exitCode:exit.code,sessionId:capturedSession,cwd:effectiveConfiguration?.effectiveWorkingDirectory,workspace,
      sandboxMode:selected.permissionMode,requestedConfiguration:configuration.requested,effectiveConfiguration,adoptedSessionId:input.sessionId??null,
      durationMs:Date.now()-createdAt,stderrTail:readTail(paths.stderrLog),paths,treeExited:true};
  }catch(error){if(!controller.signal.aborted)controller.abort({kind:'error',code:error?.code,message:error?.message??String(error)});if(exit?.treeExited&&error&&typeof error==='object')error.treeExited=true;throw error;}
  finally{clearTimeout(timer);clearInterval(pollTimer);peer.close();await driver?.catch(()=>{});input.signal?.removeEventListener('abort',abort);for(const fd of[eventsFd,stderrFd])if(fd!==undefined)fs.closeSync(fd);}
}
