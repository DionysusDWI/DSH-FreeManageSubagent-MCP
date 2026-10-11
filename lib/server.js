/** Five MCP tools, structured results, bounded waits and real cancellation. */
import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SANDBOX_MODES } from './overlay.js';
import { ConversationRegistry } from './conversation.js';
import { TaskScheduler } from './scheduler.js';
import { TERMINAL_STATES } from './store.js';
import { DEFAULT_TIMEOUT_MS, appendSteering } from './task-runner.js';
import { inspectBridgeProfile, resolveRuntime } from './dsh-profile.js';
import { stateRoot, repoRoot } from './paths.js';
import { delay } from './file-lock.js';
import { taskResponse, toolError, diagnosticResponse } from './response.js';
import {createAcceptanceController,acceptanceStateRoot} from './acceptance.js';
import {runHostPreflight} from './host-preflight.js';
export const BRIDGE_VERSION='0.1.1';
export const MAX_WAIT_MS=30000;
const taskOutput={task_id:z.string().nullable(),state:z.string().nullable(),session_id:z.string().nullable(),cursor:z.number().int().nonnegative(),has_more:z.boolean(),
  reports:z.array(z.object({seq:z.number(),event_id:z.string(),kind:z.string(),text:z.string()}).passthrough()).optional(),answer:z.string().optional(),error:z.object({message:z.string().optional(),code:z.string().optional()}).passthrough().optional(),
  phase:z.string().optional(),duration_ms:z.number().optional(),report_count:z.number().optional(),full_content_path:z.string().optional(),output_persisted:z.boolean().optional(),truncated:z.boolean().optional(),answer_truncated:z.boolean().optional(),message_id:z.string().optional(),guidance_seq:z.number().optional()};
const errorResult=error=>toolError(error?.message ?? String(error),error?.code ?? 'BRIDGE_ERROR');
export function createBridgeServer(options={}) {
  const env={...(options.sourceEnv ?? process.env),...(options.env ?? {})}, root=options.stateRoot ?? acceptanceStateRoot(env,stateRoot(env));
  const registry=new ConversationRegistry({env,stateRoot:root,allowMultiplex:options.allowMultiplex ?? env.CODEX_DSH_MCP_MULTIPLEX==='1'}), diagnostics=[];
  const note=message=> {diagnostics.push(message);if(diagnostics.length>100) diagnostics.shift();options.onDiagnostic?.(message);};
  const scheduler=new TaskScheduler({env,stateRoot:root,defaultWorkspace:options.defaultWorkspace ?? env.CODEX_DSH_MCP_WORKSPACE ?? process.cwd(),runTaskImpl:options.runTaskImpl,note});
  const server=new McpServer({name:'codex-dsh-mcp',version:BRIDGE_VERSION},{instructions:'Delegate only user-authorized work to DSH. Foreground calls wait at most 30 seconds, then detach: poll dsh_status with task_id and cursor. Steering is queued, not confirmed delivered. Never infer an approval prompt from silence or raise access automatically. MCP disconnect stops all tasks; later explicit follow-up may resume verified sessions, never replay original work.'});
  const context=extra=>scheduler.attach(registry.resolve(extra?._meta));
  const acceptance=options.acceptanceController ?? createAcceptanceController({env,stateRoot:root}),requests=new WeakMap();
  function audited(name,handler) { return async(args,extra)=> {
    let correlationId,result;
    try {
      if(acceptance) { const ctx=context(extra);correlationId=acceptance.request(name,args,extra,ctx,server.server.getClientVersion?.());requests.set(extra,{ctx,correlationId}); }
      result=await handler(args,extra);
    } catch(error) { result=errorResult(error); }
    try { if(correlationId) acceptance.response(correlationId,name,result); } catch(error) { result=errorResult(error); }
    if(extra)requests.delete(extra);return result;
  }; }
  function taskFor(ctx,id) { const selected=id ?? ctx.store.latestTask()?.taskId;const task=selected?scheduler.getTask(ctx,selected):null; if(!task) throw Object.assign(new Error('No task owned by this conversation matches the request.'),{code:'TASK_NOT_FOUND'});return task; }
  function register(name,description,inputSchema,handler) {
    server.registerTool(name,{description,inputSchema,outputSchema:taskOutput},audited(name,handler));
  }
  register('dsh_task','Delegate an explicitly authorized coding task to DeepSeek Harness. At most 30 seconds foreground waiting; unfinished work returns a task ID/cursor and continues under supervision. timeout_ms includes queue and provisioning time.',
    {prompt:z.string().min(1),workspace:z.string().optional(),sandbox_mode:z.enum(SANDBOX_MODES).optional(),provider:z.string().min(1).optional(),model:z.string().min(1).optional(),timeout_ms:z.number().int().min(1).max(86400000).optional(),background:z.boolean().optional(),new_session:z.boolean().optional()},
    async(args,extra)=> {
      if(extra.signal?.aborted) throw new Error('Request was cancelled before task acceptance.');
      const ctx=context(extra),request=requests.get(extra),receipt=await acceptance?.reserve(ctx,args,request.correlationId,extra.signal);
      const job=scheduler.submit(ctx,args,receipt?{receipt,lifecycle:event=>acceptance.lifecycle(receipt,event),stopReason:()=>acceptance.stopReason()}:undefined);
      if(args.background) return taskResponse(ctx,job.record,{message:'Started task '+job.record.taskId+' in the background. Use dsh_status with this task ID and cursor.',dispatch:true});
      let foreground=true,timer;
      const cancel=()=> {if(foreground) {try{if(receipt)acceptance.foregroundEvent(receipt,'foreground-cancel-signal');}catch(error){note('Acceptance cancel audit failed: '+error.message);} job.controller.abort({kind:'cancelled',message:'MCP foreground request cancelled.'});}};
      extra.signal?.addEventListener('abort',cancel,{once:true});if(extra.signal?.aborted) cancel();
      try {
        const detached=Symbol('detached');
        const settled=await Promise.race([job.promise,new Promise(resolve=> {timer=setTimeout(()=>resolve(detached),Math.min(MAX_WAIT_MS,options.foregroundWaitMs ?? MAX_WAIT_MS));})]);
        // Atomically end the request association before returning a background handle.
        foreground=false;extra.signal?.removeEventListener('abort',cancel);if(settled===detached&&receipt)acceptance.foregroundEvent(receipt,'foreground-detached');
        const task=settled===detached?(scheduler.getTask(ctx,job.record.taskId) ?? job.record):settled;
        return taskResponse(ctx,task,{dispatch:true,isError:task.state==='failed'||task.state==='timeout'||task.state==='interrupted',
          message:settled===detached?'Foreground wait budget reached. Task '+task.taskId+' continues in the background; poll dsh_status.':''});
      } finally {foreground=false;clearTimeout(timer);extra.signal?.removeEventListener('abort',cancel);}
    });
  register('dsh_status','Read the latest persisted task state and a byte-budgeted page of reports. Existing unread reports return immediately; wait_ms is capped at 30 seconds. A failed task is a successful status query, not a tool error.',
    {task_id:z.string().optional(),cursor:z.number().int().nonnegative().optional(),limit:z.number().int().min(1).max(200).optional(),wait_ms:z.number().int().nonnegative().optional()},
    async(args,extra)=> {
      const ctx=context(extra),initial=taskFor(ctx,args.task_id),cursor=args.cursor ?? 0,until=Date.now()+Math.min(args.wait_ms ?? 0,MAX_WAIT_MS);
      while(Date.now()<until && ctx.queue.latestSeq(initial.taskId)<=cursor) {
        const current=taskFor(ctx,initial.taskId);if(TERMINAL_STATES.has(current.state)) break;
        await delay(Math.min(100,until-Date.now()),extra.signal);
      }
      return taskResponse(ctx,taskFor(ctx,initial.taskId),{since:cursor,limit:args.limit ?? 50});
    });
  register('dsh_steer','Append operator guidance with a stable message ID. Only the main DSH agent may consume it. This acknowledges durable queueing, not delivery; DSH confirms after persisting the receiving tool result.',
    {task_id:z.string().optional(),message:z.string().min(1).max(16384)},
    async(args,extra)=> {
      const ctx=context(extra),task=taskFor(ctx,args.task_id);if(TERMINAL_STATES.has(task.state)) throw new Error('Task is already '+task.state+'; guidance was not queued. Submit a follow-up explicitly.');
      const guidance=appendSteering(ctx.key,task.taskId,args.message,root);
      const result=taskResponse(ctx,task,{message:'Queued guidance '+guidance.messageId+' (seq '+guidance.seq+') for task '+task.taskId+'. Delivery is pending.'});
      result.structuredContent.message_id=guidance.messageId;result.structuredContent.guidance_seq=guidance.seq;return result;
    });
  register('dsh_cancel','Request cooperative cancellation, save a session when possible, then terminate the supervised process tree. Cancelled is returned only after exit is confirmed. Queued work is removed without launching DSH.',
    {task_id:z.string().optional()},
    async(args,extra)=> {
      const ctx=context(extra),task=taskFor(ctx,args.task_id);
      if(TERMINAL_STATES.has(task.state)) return taskResponse(ctx,task,{message:task.state==='interrupted'?'Task is interrupted; inspect the recorded supervision failure. No automatic retry.':'Task is already '+task.state+'; no running process to stop.',isError:task.state==='interrupted'});
      scheduler.cancel(ctx,task.taskId);
      const current=await scheduler.waitForTerminal(ctx,task.taskId,Math.min(MAX_WAIT_MS,options.cancelWaitMs ?? MAX_WAIT_MS),extra.signal) ?? task;
      const confirmed=current.state==='cancelled'&&current.treeExited===true;
      return taskResponse(ctx,current,{message:confirmed?'Task '+current.taskId+' cancelled after confirmed process-tree exit.':TERMINAL_STATES.has(current.state)?'Cancellation settled as '+current.state+'.':'Cancellation requested; process exit is still pending. No confirmed cancellation yet.',isError:!confirmed&&current.state!=='completed'});
    });
  server.registerTool('dsh_self_check',{description:'Normally read-only health diagnosis: launcher, DSH home, immutable profile and recent tasks. The private smoke4 control opt-in also runs an isolated zero-model state-write/exit probe and >=45s RPC diagnostic. Never provisions or runs a model.',inputSchema:{}},audited('dsh_self_check',async(_args,extra)=> {
    try {
      const ctx=context(extra);let runtime=null,profile=null,error=null;
      try {runtime=resolveRuntime(env);profile=inspectBridgeProfile({env,runtime});} catch(e) {error=e.message;}
      const tasks=ctx.store.listTasks({limit:5}).map(task=>scheduler.getTask(ctx,task.taskId) ?? task),session=ctx.store.readSession(),guardian=process.platform!=='win32'||fs.existsSync(path.join(repoRoot(),'native','windows-job-host.exe'));
      const lines=['Codex DSH MCP v'+BRIDGE_VERSION,'conversation: '+ctx.key,'binding: '+ctx.source,'codex threadId: '+(ctx.threadId ?? '-'),'codex sessionId: '+(ctx.sessionId ?? '-'),
        'state directory: '+ctx.dir,'state root: '+path.resolve(root),'bridge root: '+repoRoot(),'bundled runtime path: '+process.execPath,'PLUGIN_ROOT: '+(env.CODEX_DSH_MCP_PLUGIN_ROOT ?? '-'),'PLUGIN_DATA: '+(env.CODEX_DSH_MCP_PLUGIN_DATA ?? '-'),'dsh launcher: '+(runtime?.launcher.command ?? 'unavailable'),'launcher script: '+(runtime?.launcher.launcherScript ?? '-'),'DSH version: '+(runtime?.version ?? 'unknown'),'DSH baseline supported: '+(runtime?.version==='0.2.0-rc.2'),
        'DSH home: '+(runtime?.home ?? '-'),'profile: '+(profile?.name ?? '-'),'profile ready: '+Boolean(profile?.ready),'profile readiness: content validation only; execution still requires permission/token preflight','profile fingerprint: '+(profile?.fingerprint ?? '-'),
        'installed profile fingerprint: '+(profile?.marker?.fingerprint ?? '-'),'guardian present: '+guardian,'guardian execution: token/state write preflight required before task launch','metadata multiplexing: '+registry.allowMultiplex,
        'recorded dsh session: '+(session.sessionId ?? '-'),'recent tasks: '+(tasks.map(t=>t.taskId+' ['+t.state+'/'+t.phase+']').join(', ') || 'none')];
      if(acceptance) {
        let hostPreflight=null;
        try {if(acceptance.control?.hostPreflight===true&&acceptance.stopReason())throw Object.assign(new Error('Acceptance stopped; no diagnostic probe will be started.'),{code:'ACCEPTANCE_STOPPED'});hostPreflight=await runHostPreflight({ctx,control:acceptance.control,signal:extra.signal,correlationId:requests.get(extra)?.correlationId});}
        catch(error){acceptance.preflightFailed?.(error);acceptance.health(ctx,runtime,profile,guardian,{passed:false,error:error.message,code:error.code??null});throw error;}
        acceptance.health(ctx,runtime,profile,guardian,hostPreflight);lines.push(...acceptance.describe());
        if(hostPreflight)lines.push('host preflight: passed','host RPC probe ms: '+hostPreflight.elapsedMs,'host preflight correlation: '+hostPreflight.correlationId,'host guardian state write: '+hostPreflight.guardian.stateWritable,'host guardian tree exited: '+hostPreflight.guardian.treeExited);
      }
      if(error) lines.push('diagnostic: '+error);if(profile&&!profile.ready) lines.push('diagnostic: '+profile.reason);
      for(const task of tasks) if(task.reason?.message&&task.state!=='completed') lines.push(task.taskId+': '+task.reason.message);
      return diagnosticResponse(lines.join('\n'));
    } catch(error) {return errorResult(error);}
  }));
  server.server.onclose=()=> {scheduler.shutdown().catch(error=>note('Shutdown failed: '+error.message));};
  const close=server.close.bind(server);server.close=async()=> {await scheduler.shutdown();await close();};
  return {server,registry,scheduler,diagnostics,shutdown:()=>scheduler.shutdown()};
}
