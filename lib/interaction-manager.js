/** MCP-side interaction routing. A late answer is an explicit new task, never a fabricated prompt. */
import fs from 'node:fs';
import path from 'node:path';
import {InteractionStore} from '../dsh-plugin/interactions.js';
import {createTaskId,TERMINAL_STATES} from './store.js';
import {processAlive,delay} from './file-lock.js';
import {assertWorkspaceNotQuarantined} from './workspace-lock.js';
const fail=(message,code='INTERACTION_CLOSED')=>{throw Object.assign(new Error(message),{code});};
export function interactionContext(manager,taskId,{writable=false}={}) {
  const ctx=writable?manager.taskContext(taskId):manager.readTaskContext(taskId),task=ctx.store.getTask(taskId);
  if(!task)fail('No task matches this namespace.','TASK_NOT_FOUND');
  const sourceId=task.interactionSourceTaskId??taskId,source=ctx.store.getTask(sourceId);
  if(!source||source.conversationKey!==ctx.key)fail('Interaction source task is not owned by this scope.','INTERACTION_MISMATCH');
  return {ctx,task,source,store:new InteractionStore(ctx.taskPaths(sourceId).dir,{conversationKey:ctx.key,taskId:sourceId})};
}
export async function respondToInteraction({manager,scheduler,args,signal}) {
  const {ctx,source,store}=interactionContext(manager,args.task_id,{writable:true});
  if(signal?.aborted)throw new Error('Response request cancelled before queueing.');
  if(source.quarantined||fs.existsSync(path.join(ctx.dir,'.execution-quarantine.json')))fail('Explicit quarantine recovery is required before answering.','EXECUTION_QUARANTINED');
  assertWorkspaceNotQuarantined(manager.stateRoot,source.workspace,source.sandboxMode);
  let continuation=null;
  const submission=store.submit({requestId:args.request_id,requestDigest:args.request_digest,type:args.type,
    payload:args.type==='approval'?{decision:args.decision}:{answers:args.answers}},snapshot=>{
    const {request,state}=snapshot;
    // Never continue a failed/crashed attempt, including a confirmed-exit failure.
    const currentSource=ctx.store.getTask(source.taskId);
    if(TERMINAL_STATES.has(currentSource.state)&&currentSource.state!=='completed')fail('This task was not completed normally; pending requests cannot replay it.');
    const candidates=[currentSource,...[...scheduler.jobs.values()].filter(job=>job.context.key===ctx.key&&job.record.interactionSourceTaskId===source.taskId).map(job=>job.record)];
    const live=candidates.find(task=>!TERMINAL_STATES.has(task.state)&&task.sessionId===request.sessionId&&processAlive(task.executorPid)===true&&store.admission(task.taskId)?.open===true);
    if(live)return {deliveryTaskId:live.taskId,continuationTaskId:null};
    if(request.type!=='questionnaire'||state.status!=='continued'||currentSource.sessionId!==request.sessionId)fail('Only a durably continued native questionnaire can be answered after its agent exits.');
    if(!source.resolvedConfiguration||!source.requestedConfiguration)fail('Historical task configuration cannot be inferred; no automatic upgrade/replay.');
    manager.requireSession(request.sessionId,source.workspace);
    const taskId=createTaskId();
    continuation={_taskId:taskId,_continuationRequestId:request.requestId,_interactionSourceTaskId:source.taskId,
      _configuration:{requested:source.requestedConfiguration,resolved:source.resolvedConfiguration},workspace:source.workspace,session_id:request.sessionId,
      timeout_ms:Math.min(86400000,Math.max(1,source.deadline-source.createdAt))};
    return {deliveryTaskId:taskId,continuationTaskId:taskId};
  });
  if(continuation) {
    try {scheduler.submit(scheduler.attach(ctx),continuation);}
    catch(error){store.rejectResponse(args.request_id,'Continuation could not be accepted: '+error.message);throw error;}
  }
  const until=Date.now()+Math.min(30000,args.wait_ms??0);
  let receipt=store.read('receipts',args.request_id);
  while(!receipt&&Date.now()<until&&!signal?.aborted) {await delay(25,signal);receipt=store.read('receipts',args.request_id);}
  const response=submission.response;
  const missingContinuation=response.continuationTaskId&&!ctx.store.getTask(response.continuationTaskId);
  return {task_id:source.taskId,request_id:args.request_id,request_digest:args.request_digest,type:args.type,
    state:receipt?.applied===true?'acknowledged':receipt?'not-applied':'submitted',queued:true,acknowledged:receipt?.applied===true,
    idempotent:submission.reused,continuation_task_id:response.continuationTaskId??null,response_digest:response.responseDigest,
    recovery_required:!!missingContinuation,...(receipt?{receipt}:{})};
}
