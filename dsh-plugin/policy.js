/** Admission is a native preset invariant, never an ordering of sandbox strings. */
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {appendJsonLine,writeJsonAtomic,readJson,assertOwner} from './io.js';
import {withFileLockSync} from './file-lock.js';
import {createAcceptanceObserver} from './acceptance.js';
export function realWorkspace(value) { const result=fs.realpathSync.native(path.resolve(value));return process.platform==='win32'?result.toLowerCase():result; }
export function attributionOf(exec,mainAgentId) {
  const agent=exec?.agent,header=agent?.session?.header,agentId=typeof agent?.id==='string'?agent.id:'unknown';
  const child=Boolean(header?.parentSession)||header?.origin==='subagent';
  return {agentId,agentRole:child?'subagent':header&&(!mainAgentId||mainAgentId===agentId)?'main':'unknown'};
}
export function installPolicyGuard(ctx,config,setters={}) {
  const requested=config.permissionMode??config.sandboxMode;
  if(!['read-only','workspace-write','auto'].includes(requested)||!config.workspace||typeof ctx.sessions?.flush!=='function'
    ||typeof ctx.permissionPresets?.set!=='function'||typeof ctx.permissionPresets?.current!=='function'
    ||typeof ctx.workingDirectory?.ensure!=='function'||typeof ctx.workingDirectory?.get!=='function'
    ||typeof ctx.tools?.guard!=='function')throw new Error('DSH lacks the required native preset, tool guard, working-directory or persistence APIs.');
  const state={mainAgentId:null,agents:new Map(),ceilings:new Map(),accepting:true,
    observer:createAcceptanceObserver({...config,workingDirectory:session=>ctx.workingDirectory.get(session)},config.acceptanceEnv??process.env)};
  const boundary=realWorkspace(config.workspace);
  function autoAvailable() {if(requested==='auto'&&!ctx.permissionPresets.names?.includes('auto'))throw new Error('Native Auto review integration is missing or was disposed. New execution is closed.');}
  state.closeAdmission=()=>{state.accepting=false;};
  state.verify=agent=>{
    if(!state.accepting)throw new Error('Bridge execution admission is closed.');
    autoAvailable();
    const expected=state.ceilings.get(agent?.id);
    if(!expected||state.agents.get(agent.id)!==agent)throw new Error('Operation belongs to an unverified native agent.');
    const mode=ctx.sandboxPolicy.resolve({session:agent.session}).mode;
    const approval=ctx.approval.effectivePolicy(agent.session),preset=ctx.permissionPresets.current(agent.session);
    // Delegated narrow presets deliberately use native `never` (reject, not allow).
    if(expected.preset==='auto') {
      if(preset!=='auto'||mode!=='danger-full-access'||approval!==expected.approval)throw new Error('Native Auto review identity changed; execution is closed.');
    } else if(mode!==expected.mode||approval!==expected.approval)throw new Error('Native permission preset changed during the task.');
    return {mode,approval,preset};
  };
  ctx.on('agent/created',async({agent})=>{
    if(!state.accepting)throw new Error('Bridge admission is closed.');autoAvailable();
    if(!agent?.session?.header||typeof agent.cancel!=='function'||typeof agent.whenIdle!=='function')throw new Error('Incompatible native agent lifecycle.');
    const who=attributionOf({agent},state.mainAgentId),session=agent.session;
    const original=realWorkspace(session.header.cwd),cwd=await ctx.workingDirectory.ensure(agent);
    if(who.agentRole==='main') {
      if(state.mainAgentId&&state.mainAgentId!==agent.id)throw new Error('Multiple root agents in one task.');
      if(original!==boundary)throw new Error('Original project differs from the fixed task boundary.');
      withFileLockSync(path.join(config.dir,'main-agent.json.lock'),()=>{
        const file=path.join(config.dir,'main-agent.json'),prior=readJson(file,{optional:true});
        if(prior){assertOwner(prior,config.conversationKey,config.taskId);if(prior.agentId!==agent.id||prior.sessionId!==session.id)throw new Error('Native main-agent ownership conflict.');}
        else writeJsonAtomic(file,{version:2,conversationKey:config.conversationKey,taskId:config.taskId,agentId:agent.id,sessionId:session.id,pid:process.pid});
      });
      state.mainAgentId=agent.id;
      ctx.permissionPresets.set(session,requested);
    } else if(who.agentRole==='subagent') {
      if(!state.agents.has(session.header.parentSession))throw new Error('Subagent ownership/lineage is not established.');
      const mode=ctx.sandboxPolicy.resolve({session}).mode,approval=ctx.approval.effectivePolicy(session);
      const parent=state.ceilings.get(session.header.parentSession);
      const desired=parent.mode==='read-only'||requested==='read-only'||mode==='read-only'?'read-only':requested==='auto'&&mode==='danger-full-access'?'auto':'workspace-write';
      ctx.permissionPresets.set(session,desired);
      if(approval==='never') {
        if(typeof setters.setApprovalPolicy!=='function')throw new Error('Cannot preserve native delegated never policy.');
        setters.setApprovalPolicy(session,'never');
      }
    } else throw new Error('Unverified agent ownership.');
    const effective=ctx.sandboxPolicy.resolve({session}),approval=ctx.approval.effectivePolicy(session),preset=ctx.permissionPresets.current(session);
    if(effective.workspaceRoot&&realWorkspace(effective.workspaceRoot)!==boundary)throw new Error('Native sandbox boundary drifted from the task workspace.');
    state.agents.set(agent.id,agent);state.ceilings.set(agent.id,{mode:effective.mode,approval,preset:requested==='auto'&&effective.mode==='danger-full-access'?'auto':effective.mode});
    state.verify(agent);
    let modelConfig=null;
    if(who.agentRole==='main'&&config.modelConfiguration) {
      if(typeof ctx.llm?.resolveCallConfig!=='function')throw new Error('Native model resolver is missing.');
      const selection=config.modelConfiguration;
      const resolved=await ctx.llm.resolveCallConfig({provider:selection.provider,model:selection.model,...(selection.reasoningEffort===null?{}:{reasoningEffort:selection.reasoningEffort})});
      modelConfig={provider:resolved.provider,model:resolved.model,reasoningEffort:resolved.reasoningEffort??null};
      if(selection.reasoningEffort!==null&&modelConfig.reasoningEffort!==selection.reasoningEffort)throw new Error('Native reasoning effort differs; silent fallback is refused.');
    }
    if(!await ctx.sessions.flush(session))throw new Error('Native session persistence is unavailable.');
    const proof={version:3,conversationKey:config.conversationKey,taskId:config.taskId,sessionId:session.id,agentId:agent.id,agentRole:who.agentRole,
      permissionMode:requested,nativePreset:preset,sandboxMode:effective.mode,approvalPolicy:approval,workspace:config.workspace,originalProject:session.header.cwd,
      effectiveWorkingDirectory:cwd,modelConfiguration:modelConfig,verified:true,ts:Date.now()};
    appendJsonLine(path.join(config.dir,'policy-events.ndjson'),proof);if(who.agentRole==='main')writeJsonAtomic(path.join(config.dir,'policy.json'),proof);
    state.observer?.created(agent,proof,state.agents);
  });
  ctx.on('agent/disposed',({agent})=>{state.agents.delete(agent?.id);state.ceilings.delete(agent?.id);});
  ctx.tools.guard(exec=>{try{
    const policy=state.verify(exec.agent);
    if(exec.name==='ask_user_question'&&exec.arguments?.timeout!==undefined&&exec.arguments.timeout!==(config.questionPolicy==='continue'?config.questionTimeoutSeconds:-1))throw new Error('Task questionnaire strategy cannot be overridden by tool arguments.');
    state.observer?.guardTool(exec);state.observer?.proof('permission-pre-tool',exec.agent,policy,state.observer.toolFacts(exec));
  }catch(error){return error.message;}});
  ctx.on('agent/pre-step',async(payload,next)=>{const policy=state.verify(payload.agent);state.observer?.proof('permission-pre-model',payload.agent,policy);return next();});
  if(state.observer) {
    ctx.on('agent/request',async(payload,next)=>{const resolved=await next(),policy=state.verify(payload.agent);state.observer.modelRequest(payload.agent,policy,resolved);return resolved;});
    ctx.on('tools/result',(exec,result)=>{state.observer.record('tool-result',{...attributionOf(exec,state.mainAgentId),sessionId:exec.agent?.session?.id??null,...state.observer.toolFacts(exec),...state.observer.resultFacts(result),resultHash:crypto.createHash('sha256').update(JSON.stringify(result)).digest('hex'),resultBytes:Buffer.byteLength(JSON.stringify(result))});});
  }
  ctx.on('dispose',state.closeAdmission);
  return state;
}
