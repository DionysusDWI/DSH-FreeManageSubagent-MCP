/** Installed rc.2 contract with local deterministic adapters. Network/model calls are forbidden. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {registerHooks} from 'node:module';
import {createChannel} from '../dsh-plugin/channel.js';
import {InteractionStore} from '../dsh-plugin/interactions.js';
import {buildProfilePatch,BRIDGE_PROFILE_BUNDLES} from '../lib/dsh-profile.js';
const [archive,sandbox,metadataJson,credentialRefsJson]=process.argv.slice(2),moduleBase=path.join(archive,'dsh','node_modules');
process.env.DSH_HOME=path.join(sandbox,'home');delete process.env.DSH_MCP_ALLOW_PROVISION;
let networkCalls=0,syntheticAdapterCalls=0,syntheticReviewCalls=0;
globalThis.fetch=async()=>{networkCalls++;throw new Error('Network forbidden in the no-model contract.');};
registerHooks({resolve(specifier,context,next){
  if(specifier.startsWith('@deepseek-ai/')) {
    const parts=specifier.split('/'),root=path.join(moduleBase,...parts.slice(0,2)),tail=parts.slice(2).join('/');
    const manifest=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')),entry=manifest.exports?.[tail?'./'+tail:'.'];
    const target=typeof entry==='string'?entry:entry?.default??entry?.import??(!tail?manifest.main??'index.js':null);
    if(target)return {url:pathToFileURL(path.join(root,target)).href,shortCircuit:true};
  }
  return next(specifier,context);
}});
const {Context}=await import('@deepseek-ai/cordis');
const {default:LlmRuntime,LlmAdapter}=await import('@deepseek-ai/dsh-llm');
const modules={};
for(const name of ['session','session-projection','system-prompt','fs-sandbox','working-directory','tools','agent','sandbox-policy','user-approval','permission-presets','user-questions','session-persistence-jsonl','agent-loop'])modules[name]=await import('@deepseek-ai/dsh-'+name);
const Auto=await import('@deepseek-ai/dsh-experimental-auto-review');
const Deepseek=await import('@deepseek-ai/dsh-llm-deepseek-api-key');
const Ask=await import('@deepseek-ai/dsh-tool-ask-user');
const {approveEscalation}=await import('@deepseek-ai/dsh-sandbox');
const {PtcRuntime}=await import('@deepseek-ai/dsh-ptc-runtime');
class ContractPtcRuntime extends PtcRuntime {
  language='typescript';isolation='synthetic';
  resolve(request){return {...request,cwd:request.cwd??sandbox,timeoutMs:request.timeoutMs??10000};}
  async run(request){return this.behavior(request);}
}
const {HarnessSdkJsonRpcServer}=await import('@deepseek-ai/dsh-sdk-jsonrpc-server');
const {apply:applyBridge}=await import('../dsh-plugin/index.js');
let plannedTool=null;
class LocalAdapter extends LlmAdapter {
  async resolveModel(provider,model){return {provider,id:model,name:model};}
  async *stream(options) {
    const review=options.system?.startsWith('REVIEW_POLICY');
    if(review)syntheticReviewCalls++;else syntheticAdapterCalls++;
    if(!review&&plannedTool) {
      const tool=plannedTool;plannedTool=null;
      yield {type:'block-start',index:0,blockType:'tool-call'};
      yield {type:'block-end',index:0,block:{type:'tool-call',id:tool.id,name:tool.name,arguments:JSON.stringify(tool.args)}};
      yield {type:'finish',reason:{kind:'tool-calls'}};return;
    }
    const text=review?'\{"risk":"low","decision":"allow"\}':'local contract answer';
    yield {type:'block-start',index:0,blockType:'text'};
    yield {type:'text-delta',index:0,text};
    yield {type:'block-end',index:0,block:{type:'text',text}};
    yield {type:'finish',reason:{kind:'stop'}};
  }
}
const keepAlive=setInterval(()=>{},1000);
const cases=[];
async function make(mode,questionPolicy='pause',seconds=null,index='',options={}) {
  const dir=path.join(sandbox,mode+index);fs.mkdirSync(dir,{recursive:true});
  const ctx=new Context();
  await ctx.plugin(LlmRuntime);
  for(const name of ['session','session-projection','system-prompt'])await ctx.plugin(modules[name].default,{});
  await ctx.plugin(modules['sandbox-policy'].default,{mode:'workspace-write',workspaceRoot:sandbox});
  await ctx.plugin(modules['fs-sandbox'].default,{cwd:sandbox});
  await ctx.plugin(modules['working-directory'].default,{defaultDirectory:sandbox});
  if(options.ptc)await ctx.plugin(ContractPtcRuntime);
  await ctx.plugin(modules.tools.default,{mode:options.ptc?'ptc':'native'});await ctx.plugin(modules.agent.default);
  await ctx.plugin(modules['user-approval'].default,{policy:'ask'});
  ctx.provide('shell');ctx.set('shell',{sandboxMode:'workspace-write'});
  await ctx.plugin(modules['permission-presets'].default,{defaultPreset:'workspace-write',presets:{'read-only':{sandbox:'read-only',approval:'ask'},'workspace-write':{sandbox:'workspace-write',approval:'ask'},'danger-full-access':{sandbox:'danger-full-access',approval:'never'}}});
  await ctx.plugin(modules['user-questions'].default,{});
  await ctx.plugin(modules['session-persistence-jsonl'],{root:options.sessionRoot??path.join(dir,'sessions'),compression:'none'});
  await ctx.plugin(modules['agent-loop'].default,{agents:[]});
  ctx.llm.registerAdapter(['contract-local'],new LocalAdapter());
  const auto=await ctx.plugin(Auto);assert.ok(ctx.permissionPresets.names.includes('auto'));
  await ctx.plugin(Ask,{mode:'timed',timeout:questionPolicy==='pause'?-1:seconds});
  const channel=path.join(dir,'inbox.json'),owner={conversationKey:'contract',taskId:'contract-'+mode+index};createChannel(channel,owner);
  const configuration={provider:'contract-local',model:'local',reasoningEffort:null,permissionMode:mode,questionPolicy,questionTimeoutSeconds:seconds};
  applyBridge(ctx,{env:{DSH_MCP_CHANNEL:channel,DSH_MCP_SCOPE:owner.conversationKey,DSH_MCP_TASK:owner.taskId,DSH_MCP_WORKSPACE:sandbox,DSH_MCP_CONFIGURATION:JSON.stringify(configuration),DSH_MCP_DEADLINE:String(Date.now()+60000),...(options.source?{DSH_MCP_INTERACTION_SOURCE:JSON.stringify(options.source),DSH_MCP_CONTINUATION_REQUEST:options.requestId}:{})}});
  const notifications=[],sdk=new HarnessSdkJsonRpcServer(ctx,{notify(method,params){notifications.push({method,params});}},{maxTokensAsSuccess:false});
  await sdk.initialize({cwd:sandbox,provider:'contract-local',model:'local'});
  return {ctx,sdk,dir,owner,auto,store:new InteractionStore(options.source?.dir??dir,options.source?.owner??owner),notifications};
}
async function until(check,timeout=5000) {const end=Date.now()+timeout;while(!check()){if(Date.now()>end)throw new Error('Native contract condition timed out.');await new Promise(r=>setTimeout(r,10));}}
for(const mode of ['read-only','workspace-write','auto']) {
  const f=await make(mode),sid='native-'+mode;
  try {
    await f.sdk.getWorkingDirectory({sessionId:sid});
    const proof=JSON.parse(fs.readFileSync(path.join(f.dir,'policy.json'),'utf8'));
    assert.equal(proof.permissionMode,mode);assert.equal(proof.nativePreset,mode);assert.equal(proof.sandboxMode,mode==='auto'?'danger-full-access':mode);
    if(mode==='auto') {
      const {defineTool}=modules.tools;
      f.ctx.tools.register(defineTool({name:'contract_operation',description:'Contract-local operation',parameters:{},output:{schema:{type:'string'},render:(_a,v)=>[{type:'text',text:v}]},async execute(_args,exec){assert.equal(f.ctx.permissionPresets.current(exec.agent.session),'auto');assert.equal(f.ctx.sandboxPolicy.resolve({session:exec.agent.session}).mode,'danger-full-access');return 'reviewed full access allowed';}}));
      plannedTool={id:'native-auto-tool',name:'contract_operation',args:{}};
    }
    await f.sdk.prompt({sessionId:sid,contentBlocks:[{type:'text',text:'No-model local contract turn.'}]});await f.sdk.wait({sessionId:sid});
    assert.equal(f.ctx.agents.get(sid).session.log.at(-1).data.reason.kind,'completed');
    if(mode==='auto')assert.ok(syntheticReviewCalls>0);
    const changed=path.join(sandbox,'effective-directory');fs.mkdirSync(changed,{recursive:true});
    assert.equal((await f.sdk.setWorkingDirectory({sessionId:sid,path:changed})).cwd,changed);
    assert.equal(f.ctx.agents.get(sid).session.header.cwd,sandbox);
    assert.equal(f.ctx.sandboxPolicy.resolve({session:f.ctx.agents.get(sid).session}).workspaceRoot,sandbox);
    await f.ctx.sessions.flush(f.ctx.agents.get(sid).session);
    await f.sdk.shutdown();
    // Restore using the official no-prompt path; it must not add a user turn.
    const resumed=new HarnessSdkJsonRpcServer(f.ctx,{notify(){}},{maxTokensAsSuccess:false});await resumed.initialize({cwd:sandbox,provider:'contract-local',model:'local'});
    await resumed.resume({sessionId:sid});await resumed.wait({sessionId:sid});
    assert.equal((await resumed.getWorkingDirectory({sessionId:sid})).cwd,changed);
    await resumed.shutdown();cases.push({case:mode,presetVerified:true,resumeWithoutPrompt:true,workingDirectoryProjection:true});
  }finally {await f.ctx.fiber.dispose();}
}
// Native one-shot approvals use the complete operation and durably audited outcome.
for(const decision of ['allowed-once','rejected','cancelled']) {
  const f=await make('read-only','pause',null,'-'+decision),sid='approval-'+decision;let executed=0;
  try {
    f.ctx.tools.register(modules.tools.defineTool({name:'contract_operation',description:'A native one-shot full-access fixture',parameters:{sandbox_permissions:{type:'string',required:true},justification:{type:'string',required:true}},output:{schema:{type:'string'},render:(_a,v)=>[{type:'text',text:v}]},async execute(args,exec){
      const granted=await approveEscalation({requestedMode:args.sandbox_permissions,effectiveMode:f.ctx.sandboxPolicy.resolve({session:exec.agent.session}).mode,justification:args.justification,subject:'operation'},
        {approver:f.ctx.approval,agent:exec.agent,callId:exec.callId,toolName:exec.name,signal:exec.signal});
      assert.equal(granted,'danger-full-access');assert.equal(f.ctx.permissionPresets.current(exec.agent.session),'read-only');executed++;return 'allowed body';}}));
    plannedTool={id:'approval-call-'+decision,name:'contract_operation',args:{sandbox_permissions:'danger-full-access',justification:'Local deterministic native approval contract.'}};
    await f.sdk.prompt({sessionId:sid,contentBlocks:[{type:'text',text:'Local approval fixture.'}]});
    await until(()=>f.store.pending().length===1);
    const request=f.store.pending()[0].request;assert.equal(request.type,'approval');assert.ok(request.detail.operation.schema);
    const response=f.store.submit({requestId:request.requestId,requestDigest:request.requestDigest,type:'approval',payload:{decision}},()=>({deliveryTaskId:f.owner.taskId,continuationTaskId:null}));
    assert.equal(response.receipt,null);await f.sdk.wait({sessionId:sid});
    await until(()=>f.store.read('receipts',request.requestId)?.applied===true);
    assert.equal(executed,decision==='allowed-once'?1:0);
    cases.push({case:'approval-'+decision,nativeAuditAck:true,fullAccessBody:decision==='allowed-once',standingPresetUnchanged:true});
  }finally{await f.sdk.shutdown();await f.ctx.fiber.dispose();}
}
const questions=[{id:'single',question:'Pick one',options:[{label:'A'},{label:'B'}]},
  {id:'multi',question:'Pick several or add text',multi_select:true,options:[{label:'X'},{label:'Y'}]}];
const answers=[{id:'single',selected:['A']},{id:'multi',selected:['X','Y'],custom:'custom detail'}];
{
  const f=await make('workspace-write','pause',null,'-pause'),sid='question-pause';
  try {
    plannedTool={id:'question-pause-call',name:'ask_user_question',args:{questions}};
    await f.sdk.prompt({sessionId:sid,contentBlocks:[{type:'text',text:'Local pause questionnaire.'}]});
    await until(()=>f.store.pending().length===1);const request=f.store.pending()[0].request;
    assert.equal(request.detail.nativeTimed,false);
    f.store.submit({requestId:request.requestId,requestDigest:request.requestDigest,type:'questionnaire',payload:{answers}},()=>({deliveryTaskId:f.owner.taskId,continuationTaskId:null}));
    await f.sdk.wait({sessionId:sid});await until(()=>f.store.read('receipts',request.requestId)?.applied===true);
    cases.push({case:'pause-questionnaire',nativeAnswerAck:true});
  }finally{await f.sdk.shutdown();await f.ctx.fiber.dispose();}
}
{
  const first=await make('workspace-write','continue',1,'-continue'),sid='question-continued';let request;
  try {
    plannedTool={id:'question-continued-call',name:'ask_user_question',args:{questions}};
    await first.sdk.prompt({sessionId:sid,contentBlocks:[{type:'text',text:'Local timed questionnaire.'}]});
    await first.sdk.wait({sessionId:sid});await until(()=>first.store.pending()[0]?.state.status==='continued');request=first.store.pending()[0].request;
    await first.ctx.sessions.flush(first.ctx.agents.get(sid).session);
  }finally{await first.sdk.shutdown();await first.ctx.fiber.dispose();}
  const source={dir:first.dir,owner:first.owner},second=await make('workspace-write','continue',1,'-late',{sessionRoot:path.join(first.dir,'sessions'),source,requestId:request.requestId});
  try {
    second.store.submit({requestId:request.requestId,requestDigest:request.requestDigest,type:'questionnaire',payload:{answers}},()=>({deliveryTaskId:second.owner.taskId,continuationTaskId:second.owner.taskId}));
    await second.sdk.resume({sessionId:sid});
    await until(()=>second.store.read('receipts',request.requestId)?.applied===true);await second.sdk.wait({sessionId:sid});
    const native=second.ctx.agents.get(sid).session.log;
    assert.ok(native.some(event=>event.type==='user/message'&&event.data.source.kind==='user-question-reply'));
    assert.equal(native.filter(event=>event.type==='user/message'&&event.data.source.kind==='user').length,1);
    cases.push({case:'continued-late-answer',freshRuntime:true,resumeWithoutPrompt:true,nativeAnswerAck:true});
  }finally{await second.sdk.shutdown();await second.ctx.fiber.dispose();}
}
// Real native PTC orchestration over a deterministic substrate: inner calls pass the same gate.
{
  const f=await make('auto','pause',null,'-ptc',{ptc:true}),sid='native-ptc-auto';let bodies=0;
  try {
    f.ctx.tools.register(modules.tools.defineTool({name:'contract_operation',description:'Reviewed PTC inner operation',parameters:{},output:{schema:{type:'string'},render:(_a,v)=>[{type:'text',text:v}]},async execute(){bodies++;return 'inner';}}));
    f.ctx.ptcRuntime.behavior=async request=>({logs:[],value:await request.bindings[0].functions.contract_operation({})});
    const reviews=syntheticReviewCalls;plannedTool={id:'outer-auto-ptc',name:'run_code',args:{code:'deterministic native bindings',description:'PTC inner gate contract'}};
    await f.sdk.prompt({sessionId:sid,contentBlocks:[{type:'text',text:'Local deterministic PTC review.'}]});await f.sdk.wait({sessionId:sid});
    assert.equal(bodies,1);assert.equal(syntheticReviewCalls,reviews+1,'official Auto reviews the started inner call, not the run_code transport');assert.ok(f.ctx.agents.get(sid).session.log.some(e=>e.type==='tool/ptc-dispatch'));
    cases.push({case:'native-ptc-auto',innerReviewed:true,outerTransportUsesNativeSemantics:true,syntheticSubstrate:true});
  }finally{await f.sdk.shutdown();await f.ctx.fiber.dispose();}
}
{
  const f=await make('workspace-write','pause',null,'-ptc-question',{ptc:true}),sid='native-ptc-question';
  try {
    f.ctx.ptcRuntime.behavior=async request=>({logs:[],value:await request.bindings[0].functions.ask_user_question({questions})});
    plannedTool={id:'outer-question-ptc',name:'run_code',args:{code:'deterministic native question binding',description:'PTC structured-question contract'}};
    await f.sdk.prompt({sessionId:sid,contentBlocks:[{type:'text',text:'Local PTC questionnaire.'}]});await until(()=>f.store.pending().length===1);
    const request=f.store.pending()[0].request;assert.equal(request.detail.operation.nested,true);
    f.store.submit({requestId:request.requestId,requestDigest:request.requestDigest,type:'questionnaire',payload:{answers}},()=>({deliveryTaskId:f.owner.taskId,continuationTaskId:null}));
    await f.sdk.wait({sessionId:sid});await until(()=>f.store.read('receipts',request.requestId)?.applied===true);
    assert.equal(f.store.read('receipts',request.requestId).nativeEvent.type,'tool/ptc-dispatch');cases.push({case:'native-ptc-question',nativeAnswerAck:true,syntheticSubstrate:true});
  }finally{await f.sdk.shutdown();await f.ctx.fiber.dispose();}
}
{
  const f=await make('auto','pause',null,'-dispose'),sid='native-auto-dispose';let bodies=0;
  try {
    await f.sdk.getWorkingDirectory({sessionId:sid});const agent=f.ctx.agents.get(sid);await f.auto.dispose();
    assert.equal(f.ctx.permissionPresets.current(agent.session),'danger-full-access');
    f.ctx.tools.register(modules.tools.defineTool({name:'contract_operation',description:'Must never run after Auto unload',parameters:{},output:{schema:{type:'string'},render:(_a,v)=>[{type:'text',text:v}]},async execute(){bodies++;return 'unexpected';}}));
    const denied=await f.ctx.tools.execute({agent,name:'contract_operation',callId:'unloaded-auto-call',arguments:{},signal:new AbortController().signal});
    assert.equal(denied.isError,true);assert.equal(bodies,0);cases.push({case:'auto-unload',nativeFullAccessFallbackObserved:true,newExecutionRefused:true});
  }finally{await f.sdk.shutdown();await f.ctx.fiber.dispose();}
}
// Resolve the real official adapter catalog and reasoning defaults; never call stream/discovery/auth.
const resolver=new Context();await resolver.plugin(LlmRuntime);await resolver.plugin(Deepseek,{});
const reasoning={};for(const effort of ['off','low','high','max'])reasoning[effort]=(await resolver.llm.resolveCallConfig({provider:'deepseek-official',model:'deepseek-flash',reasoningEffort:effort})).reasoningEffort;
assert.deepEqual(Object.values(reasoning),['off','low','high','max']);
await assert.rejects(resolver.llm.resolveCallConfig({provider:'deepseek-official',model:'deepseek-flash',reasoningEffort:'log'}));
const defaultReasoning=(await resolver.llm.resolveCallConfig({provider:'deepseek-official',model:'deepseek-flash'})).reasoningEffort;
await resolver.fiber.dispose();
assert.deepEqual(BRIDGE_PROFILE_BUNDLES,['@deepseek-ai/dsh-base','@deepseek-ai/dsh-sdk-app']);
const patch=buildProfilePatch();assert.ok(patch.includes('@deepseek-ai/dsh-experimental-auto-review'));for(const name of ['credentials','authorization','deepseek-account'])assert.ok(patch.includes('- id: '+name+'\n  disabled: true'));
assert.equal(networkCalls,0);
const refs=JSON.parse(credentialRefsJson??'[]');
clearInterval(keepAlive);
console.log(JSON.stringify({verified:true,bridgeVersion:'0.1.4',dshVersion:JSON.parse(metadataJson).version,baselineCommit:'687f282e8625c6b8d11ff58211a90524be2e4317',modelCalls:0,networkCalls,syntheticAdapterCalls,syntheticReviewCalls,cases,reasoning,defaultReasoning,credentials:{strategy:'launch-environment-only',references:refs.map(name=>({name,present:!!process.env[name]}))},profile:{bundles:BRIDGE_PROFILE_BUNDLES,auto:'official',credentialsStoreDisabled:true},limitations:['No paid-model or packaged immutable-profile launch acceptance.','Local adapters exercise the installed native runtime without contacting a model.','PTC orchestration uses a synthetic substrate; persistent process enforcement is not certified by this probe.']}));
