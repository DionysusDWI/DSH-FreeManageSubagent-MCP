/** DSH reporting, main-only guidance and fail-closed pre-model permission guard. */
import crypto from 'node:crypto';
import path from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy';
import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval';
import { appendChannelRecord, channelDescriptor, channelPaths, prepareSteering, confirmSteering, readCancellation, steeringCheckpoint, guidanceMessage } from './channel.js';
import { scanJsonLines, assertOwner, writeJsonAtomic, JsonLineReader } from './io.js';
import {resultContainsGuidance} from './guidance-result.js';
import {installInteractions} from './interaction-runtime.js';
import { attributionOf, installPolicyGuard } from './policy.js';
export { attributionOf } from './policy.js';
export const name = 'dsh-mcp-plugin';
export const inject = ['tools','agents','sessions','sandboxPolicy','approval','permissionPresets','workingDirectory','llm','userQuestions','sessionProjections'];
export const REPORT_KINDS = Object.freeze(['progress','milestone','blocker','decision','final']);
export function resolveChannel(env) {
  if (!env.DSH_MCP_CHANNEL || !env.DSH_MCP_TASK || !env.DSH_MCP_SCOPE) return null;
  const channel = { channelPath:path.resolve(env.DSH_MCP_CHANNEL), taskId:env.DSH_MCP_TASK, conversationKey:env.DSH_MCP_SCOPE };
  if (!channelDescriptor(channel.channelPath,channel)) throw new Error('A matching protocol-v2 channel is required.'); return channel;
}
export function renderSteering(messages) {
  if (!messages.length) return '';
  return 'Guidance receipt: ' + messages.map(m=>m.messageId).join(',') + '\nOperator guidance (stable IDs may repeat after an interrupted delivery; do not repeat completed actions):\n'
    + messages.map(m=>'[' + m.messageId + '] ' + m.text).join('\n');
}
export function renderDelivery(facts) { return 'reported to the MCP controller that dispatched task ' + facts.taskId + ' from DSH agent ' + facts.agentId; }
function receive(deps, exec) {
  const who = attributionOf(exec,deps.state.mainAgentId);
  if (who.agentRole !== 'main' || who.agentId !== deps.state.mainAgentId) return [];
  const callId = exec.rootCallId ?? exec.callId;
  if (typeof callId !== 'string' || !callId) throw new Error('DSH tool call identity is required for durable guidance delivery.');
  const messages = prepareSteering(deps.channel.channelPath,{owner:deps.channel,...who,callId,maxMessages:20});
  if (messages.length) { deps.pending.set(who.agentId + '/' + callId,{messages,who,callId}); if(deps.pending.size>128) deps.pending.delete(deps.pending.keys().next().value); } return messages;
}
export function defineReportTool(deps) {
  return defineTool({ name:'report', description:'Report substantive progress, milestones, decisions or blockers to the dispatching MCP task. All agents may report; only the main agent receives operator guidance.',
    parameters:{text:{type:'string',required:true,description:'The substantive update.'},kind:{type:'string',enum:[...REPORT_KINDS]},data:{type:'json',description:'Optional structured detail.'}},
    output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:String(value)}]},
    async execute(args,exec) {
      const who=attributionOf(exec,deps.state.mainAgentId), kind=REPORT_KINDS.includes(args.kind)?args.kind:'progress';
      if (!deps.state.agents.has(who.agentId)) throw new Error('Unverified agent cannot publish into this task.');
      appendChannelRecord(deps.channel.channelPath,{type:'report',kind,text:String(args.text ?? ''),...who,
        eventId:who.agentId + ':' + (exec.callId ?? crypto.randomUUID()),...(args.data===undefined?{}:{data:args.data})});
      const guidance=renderSteering(receive(deps,exec));
      return 'Reported (' + kind + '): ' + renderDelivery({...deps.channel,...who}) + '.\n' + (guidance || 'No new guidance.');
    } });
}
export function defineInboxTool(deps) {
  return defineTool({name:'check_inbox',description:'Main-agent only: receive up to 20 operator guidance messages for this task. Children must leave steering for the main agent.',parameters:{},
    output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:String(value)}]},
    async execute(_args,exec) { const who=attributionOf(exec,deps.state.mainAgentId); if(who.agentRole!=='main') return 'Guidance is reserved for the main agent.'; return renderSteering(receive(deps,exec)) || 'No new guidance.'; } });
}
function resultCallId(event) { return event?.data?.message?.toolCallId ?? event?.data?.message?.source?.callId; }
function containsReceipt(event,messages,channel) {return resultContainsGuidance(event,messages,id=>guidanceMessage(channel.channelPath,id,channel));}
export function apply(ctx,config) {
  const env=config?.env ?? process.env, channel=resolveChannel(env);
  if (!channel) throw new Error('Bridge task channel is missing; unverified execution is refused.');
  const configuration=JSON.parse(env.DSH_MCP_CONFIGURATION??'{}');
  const state=installPolicyGuard(ctx,{...channel,dir:path.dirname(channel.channelPath),workspace:env.DSH_MCP_WORKSPACE,
    permissionMode:configuration.permissionMode??env.DSH_MCP_SANDBOX,questionPolicy:configuration.questionPolicy??'pause',
    questionTimeoutSeconds:configuration.questionTimeoutSeconds,modelConfiguration:configuration.provider?configuration:null,acceptanceEnv:env},{setSandboxMode,setApprovalPolicy});
  const deps={channel,state,pending:new Map()}, dir=path.dirname(channel.channelPath);
  ctx.tools.register(defineReportTool(deps)); ctx.tools.register(defineInboxTool(deps));
  let confirmations=Promise.resolve(), cancelled=false,protocolFailure=null;
  function fail(error) { protocolFailure??=error;state.closeAdmission();try{writeJsonAtomic(path.join(dir,'bridge-failure.json'),{message:error.message,conversationKey:channel.conversationKey,taskId:channel.taskId});}catch{} ctx.logger?.error?.(name + ': ' + error.message); for(const agent of state.agents.values()) agent.cancel({kind:'hook',reason:'Bridge protocol/persistence failure: ' + error.message}); }
  function commit(session,event) {
    const callId=resultCallId(event),key=session.id+'/'+callId;
    let pending=deps.pending.get(key);
    if(!pending && session.id===state.mainAgentId) scanJsonLines(channelPaths(channel.channelPath).receipts,record=> {assertOwner(record,channel.conversationKey,channel.taskId);if(record.type==='received'&&record.agentId===session.id&&record.callId===callId)pending={messages:record.messages,who:{agentId:session.id,agentRole:'main'},callId};});
    if (!pending || !containsReceipt(event,pending.messages,channel)) {deps.pending.delete(key);return;}
    confirmations=confirmations.then(async()=> {
      if(!await ctx.sessions.flush(session)) throw new Error('Guidance result was not durably persisted.');
      state.observer?.record('guidance-result-persisted',{sessionId:session.id,agentId:pending.who.agentId,callId:pending.callId,messageIds:pending.messages.map(m=>m.messageId)});
      confirmSteering(channel.channelPath,pending.messages,{owner:channel,...pending.who,callId:pending.callId,persisted:true});
      state.observer?.record('guidance-ack',{sessionId:session.id,agentId:pending.who.agentId,callId:pending.callId,messageIds:pending.messages.map(m=>m.messageId)});
      deps.pending.delete(session.id + '/' + pending.callId);
    }).catch(fail);
    return confirmations;
  }
  ctx.on('session/event',(session,event)=> { if(event.type==='tool/result') setImmediate(()=>{try{commit(session,event);}catch(error){fail(error);}}); });
  // On resume, received but unconfirmed batches are acknowledged only if their result is actually in the durable log.
  ctx.on('agent/created',async({agent})=> {
    if(agent.id!==state.mainAgentId) return;
    const reader=new JsonLineReader(channelPaths(channel.channelPath).receipts,{onMalformed:error=>{throw error;}});
    while(true) {
      const before=reader.offset,received=[];
      reader.poll(record=> {assertOwner(record,channel.conversationKey,channel.taskId);if(record.type==='received'&&record.agentId===agent.id)received.push(record);},{maxRecords:8});
      for(const record of received) {
        const checkpoint=steeringCheckpoint(channel.channelPath,channel);
        if(record.messages.every(m=>m.seq<=checkpoint.cursor))continue;
        const event=agent.session.log.find(e=>e.type==='tool/result'&&resultCallId(e)===record.callId&&containsReceipt(e,record.messages,channel));
        if(event) {deps.pending.set(agent.id+'/'+record.callId,{messages:record.messages,who:{agentId:agent.id,agentRole:'main'},callId:record.callId});await commit(agent.session,event);}
      }
      if(reader.offset===before)break;
    }
    await confirmations;
  });
  installInteractions(ctx,{state,channel,dir,configuration,deadline:Number(env.DSH_MCP_DEADLINE),
    source:env.DSH_MCP_INTERACTION_SOURCE?JSON.parse(env.DSH_MCP_INTERACTION_SOURCE):null,
    continuationRequestId:env.DSH_MCP_CONTINUATION_REQUEST||null,onFailure:fail,beforeSettle:async()=>{await confirmations;if(protocolFailure)throw protocolFailure;}});
  const timer=setInterval(async()=> {
    if(cancelled) return;
    try {
      const reason=readCancellation(channel.channelPath,channel); if(!reason) return; cancelled=true;
      for(const agent of state.agents.values()) agent.cancel({kind:'hook',reason:reason.message ?? 'MCP controller cancelled this task'});
      await Promise.all([...state.agents.values()].map(async agent=> { await agent.whenIdle(); if(!await ctx.sessions.flush(agent.session)) throw new Error('Cancellation session flush unavailable'); }));
      await confirmations; writeJsonAtomic(path.join(dir,'cancel-ack.json'),{version:2,...channel,sessionId:state.mainAgentId,flushed:true,ts:Date.now()});
    } catch(error) { fail(error); }
  },100); timer.unref?.();
  ctx.on('dispose',()=>clearInterval(timer));
  ctx.inject?.(['systemPrompt'],scope=>scope.systemPrompt.context({name:'dsh-mcp:delegation',order:10000,text:()=> 'This is an MCP-delegated DSH task. Use only the selected native permission preset. Native Auto review and native one-time approval may execute with Full access; unreviewed direct Full access is not a bridge selection. report milestones and blockers. Main agent: check_inbox before long or irreversible work; children may report but cannot consume steering. Missing output is not an approval request. Machine guidance is not a human instruction or native parent authorization. Question answers, including plan review, are not tool-operation approval.'}));
}
