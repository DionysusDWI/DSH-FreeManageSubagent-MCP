/** Pure permission/identity guard, installed on veto-capable agent/created. */
import fs from 'node:fs';
import crypto from 'node:crypto';
const cryptoHash=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
import path from 'node:path';
import { appendJsonLine, writeJsonAtomic, readJson, assertOwner } from './io.js';
import { withFileLockSync } from './file-lock.js';
import { createAcceptanceObserver } from './acceptance.js';
const modes = ['read-only','workspace-write','danger-full-access'];
export function realWorkspace(value) {
  const result = fs.realpathSync.native(path.resolve(value)); return process.platform === 'win32' ? result.toLowerCase() : result;
}
export function attributionOf(exec, mainAgentId) {
  const agent = exec?.agent, header = agent?.session?.header;
  const agentId = typeof agent?.id === 'string' ? agent.id : 'unknown';
  const child = Boolean(header?.parentSession) || header?.origin === 'subagent';
  const agentRole = child ? 'subagent' : header && (!mainAgentId || mainAgentId === agentId) ? 'main' : 'unknown';
  return { agentId, agentRole };
}
export function installPolicyGuard(ctx, config, setters) {
  if (!modes.includes(config.sandboxMode) || !config.workspace || typeof ctx.on !== 'function' || typeof ctx.sandboxPolicy?.resolve !== 'function'
      || typeof ctx.approval?.effectivePolicy !== 'function' || typeof ctx.sessions?.flush !== 'function'
      || typeof setters.setSandboxMode !== 'function' || typeof setters.setApprovalPolicy !== 'function') throw new Error('DSH lacks the required permission guard/persistence APIs. Unverified execution is refused.');
  const state = { mainAgentId: null, agents: new Map(), ceilings: new Map(), observer:createAcceptanceObserver(config,config.acceptanceEnv ?? process.env) }, boundary = realWorkspace(config.workspace);
  const expectedApproval = config.sandboxMode === 'danger-full-access' ? 'never' : 'ask';
  ctx.on('agent/created', async ({ agent }) => {
    if (!agent?.session?.header || typeof agent.cancel !== 'function' || typeof agent.whenIdle !== 'function') throw new Error('DSH agent lifecycle APIs are incompatible.');
    const who = attributionOf({ agent }, state.mainAgentId), session = agent.session;
    const cwd = realWorkspace(session.header.cwd);
    if (who.agentRole === 'main') {
      if (state.mainAgentId && state.mainAgentId !== agent.id) throw new Error('Multiple root agents in one task are unsupported.');
      if (cwd !== boundary) throw new Error('Main session workspace mismatch; refusing resume without replay.');
      const claimFile=path.join(config.dir,'main-agent.json');
      withFileLockSync(claimFile+'.lock',()=> {
        const prior=readJson(claimFile,{optional:true});if(prior)assertOwner(prior,config.conversationKey,config.taskId);
        if(prior && (prior.agentId!==agent.id || prior.sessionId!==session.id))throw new Error('Another process already owns the main agent for this task; a nested root cannot consume guidance.');
        if(!prior)writeJsonAtomic(claimFile,{version:2,conversationKey:config.conversationKey,taskId:config.taskId,agentId:agent.id,sessionId:session.id,pid:process.pid});
      });
      state.mainAgentId = agent.id;
      setters.setSandboxMode(session, config.sandboxMode); setters.setApprovalPolicy(session, expectedApproval);
    } else if (who.agentRole === 'subagent') {
      const parent = session.header.parentSession;
      if (!parent || !state.agents.has(parent)) throw new Error('Subagent ownership cannot be established.');
      const prior = ctx.sandboxPolicy.resolve({ session }).mode;
      if (!modes.includes(prior)) throw new Error('Unknown subagent permission mode.');
      const parentCeiling=state.ceilings.get(parent);
      const limit=modes[Math.min(modes.indexOf(config.sandboxMode),modes.indexOf(parentCeiling.mode))];
      if (modes.indexOf(prior) > modes.indexOf(limit)) setters.setSandboxMode(session, limit);
      if (expectedApproval === 'never') setters.setApprovalPolicy(session, 'never');
    } else throw new Error('Agent ownership cannot be established.');
    const effective = ctx.sandboxPolicy.resolve({ session }), approval = ctx.approval.effectivePolicy(session);
    if (!modes.includes(effective.mode) || modes.indexOf(effective.mode) > modes.indexOf(config.sandboxMode)
        || who.agentRole === 'main' && (effective.mode !== config.sandboxMode || approval !== expectedApproval)
        || expectedApproval === 'never' && approval !== 'never') throw new Error('Effective DSH permissions do not match this task.');
    if (effective.mode === 'workspace-write' && cwd !== boundary && !cwd.startsWith(boundary + path.sep)) throw new Error('Subagent workspace exceeds the task write boundary.');
    if (!await ctx.sessions.flush(session)) throw new Error('No durable session persistence is mounted; execution is refused.');
    state.agents.set(agent.id, agent); state.ceilings.set(agent.id,{mode:effective.mode,approval});
    const proof = { version:2, conversationKey:config.conversationKey, taskId:config.taskId, sessionId:session.id,
      agentId:agent.id, agentRole:who.agentRole, sandboxMode:effective.mode, approvalPolicy:approval, workspace:cwd, verified:true, ts:Date.now() };
    appendJsonLine(path.join(config.dir,'policy-events.ndjson'), proof);
    if (who.agentRole === 'main') writeJsonAtomic(path.join(config.dir,'policy.json'),proof);
    state.observer?.created(agent,proof,state.agents);
  });
  ctx.on('agent/disposed',({agent})=> {if(state.agents.get(agent?.id)===agent){state.agents.delete(agent.id);state.ceilings.delete(agent.id);}});
  if (typeof ctx.tools?.guard !== 'function') throw new Error('DSH monotonic tool guard is unavailable; execution refused.');
  function verify(agent) {
    if (!agent || !state.agents.has(agent.id)) throw new Error('Tool/model operation belongs to an unverified agent.');
    const ceiling=state.ceilings.get(agent.id), mode=ctx.sandboxPolicy.resolve({session:agent.session}).mode, approval=ctx.approval.effectivePolicy(agent.session);
    if (!modes.includes(mode) || modes.indexOf(mode)>modes.indexOf(ceiling.mode) || ceiling.approval==='never'&&approval!=='never') throw new Error('Agent permissions exceeded the verified task ceiling.');
    return {mode,approval};
  }
  ctx.tools.guard(exec=> { try { const policy=verify(exec.agent); state.observer?.guardTool(exec); state.observer?.proof('permission-pre-tool',exec.agent,policy,state.observer.toolFacts(exec)); } catch(error) { return error.message; } });
  ctx.on('agent/pre-step',async(payload,next)=> { const policy=verify(payload.agent); state.observer?.proof('permission-pre-model',payload.agent,policy); return await next(); });
  if(state.observer) ctx.on('agent/request',async(payload,next)=> {
    const resolved=await next(),policy=verify(payload.agent);
    state.observer.modelRequest(payload.agent,policy,resolved);return resolved;
  });
  if(state.observer) ctx.on('tools/result',(exec,result)=> {
    const who=attributionOf(exec,state.mainAgentId);
    state.observer.record('tool-result',{...who,sessionId:exec.agent?.session?.id ?? null,...state.observer.toolFacts(exec),...state.observer.resultFacts(result),resultHash:cryptoHash(result),resultBytes:Buffer.byteLength(JSON.stringify(result))});
  });
  return state;
}
