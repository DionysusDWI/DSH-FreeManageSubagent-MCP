import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {connect,call,result,deferred,releaseAllTestGates} from './mcp-helpers.js';
import {tempDir,isolatedEnv} from './helpers.js';
import {InteractionStore} from '../dsh-plugin/interactions.js';
import {interactionContext} from '../lib/interaction-manager.js';
import {delay} from '../lib/file-lock.js';
const questions=[{id:'q',question:'Continue?',options:[{label:'yes'},{label:'no'}]}],answers=[{id:'q',selected:['yes']}];
async function until(predicate){const end=Date.now()+5000;while(!predicate()){assert.ok(Date.now()<end,'MCP interaction fixture timed out');await delay(10);}}
async function fixture(t,runner){const temp=tempDir('mcp-interactions'),bridge=await connect({env:isolatedEnv(temp.dir),sourceEnv:{},stateRoot:path.join(temp.dir,'state'),defaultWorkspace:temp.dir,runTaskImpl:runner});t.after(async()=>{releaseAllTestGates();await bridge.close();temp.cleanup();});return {...bridge,dir:temp.dir};}
function requestFor(input,store,type='questionnaire',extra={}){return store.create({type,createdInTaskId:input.taskId,sessionId:input.sessionId??'session-'+input.taskId,agentId:input.sessionId??'session-'+input.taskId,callId:'native-call',nativeApprovalId:type==='approval'?'native-audit':null,expiresAt:type==='approval'?input.deadline:null,summary:'Native request',detail:{operation:{arguments:{payload:'complete'},schema:{name:'native-tool'}},...(type==='questionnaire'?{questions}:{})},...extra});}
const responseArgs=(taskId,request,type=request.type)=>({task_id:taskId,request_id:request.requestId,request_digest:request.requestDigest,type,...(type==='approval'?{decision:'allowed-once'}:{answers})});
test('capabilities and all eleven typed tools are read-only inventory, never profile or state provisioning',async t=>{
  let launches=0;const b=await fixture(t,async input=>{launches++;return result(input);});
  const listed=await b.client.listTools();assert.equal(listed.tools.length,11);for(const name of ['dsh_capabilities','dsh_interactions','dsh_respond'])assert.ok(listed.tools.find(tool=>tool.name===name).outputSchema);
  const schema=listed.tools.find(tool=>tool.name==='dsh_task').inputSchema.properties;
  assert.deepEqual(schema.reasoning_effort.enum,['off','low','high','max']);assert.deepEqual(schema.permission_mode.enum,['read-only','workspace-write','auto','inherit']);assert.deepEqual(schema.sandbox_mode.enum,['read-only','workspace-write']);
  const value=(await call(b.client,'dsh_capabilities')).structuredContent;assert.equal(value.bridge_version,'0.1.4');assert.equal(value.baseline.commit,'687f282e8625c6b8d11ff58211a90524be2e4317');assert.equal(value.direct_full_access_selectable,false);assert.equal(value.native_reviewed_full_access_allowed,true);assert.equal(value.provisioning_performed,false);assert.equal(value.verification.features.runtime_verified,false);assert.equal(launches,0);assert.equal(fs.existsSync(b.manager.stateRoot),false);
});
test('MCP validates permissions before acceptance; requested and native effective configurations are visible',async t=>{
  let received,calls=0;const b=await fixture(t,async input=>{received=input;calls++;input.onEffectiveConfiguration({...input.configuration.resolved,reasoningEffort:'high',nativePreset:input.configuration.resolved.permissionMode,nativeSandboxMode:'danger-full-access'});return result(input);});
  for(const args of [{sandbox_mode:'danger-full-access'},{permission_mode:'full-access'},{permission_mode:'inherit'},{sandbox_mode:'read-only',permission_mode:'auto'},{reasoning_effort:'log'}])assert.equal((await call(b.client,'dsh_task',{prompt:'refuse',...args})).isError,true);
  assert.equal(calls,0);assert.equal(b.manager.readCatalog().taskOrder.length,0);
  const task=await call(b.client,'dsh_task',{prompt:'explicit inherited Auto',permission_mode:'inherit',upstream_permission_mode:'full-access'});assert.notEqual(task.isError,true);assert.equal(received.configuration.resolved.permissionMode,'auto');assert.equal(task.structuredContent.requested_configuration.permissionMode,'inherit');assert.equal(task.structuredContent.effective_configuration.nativePreset,'auto');assert.equal(task.structuredContent.effective_configuration.nativeSandboxMode,'danger-full-access');
});
test('live approval routes to the original agent, exposes waiting status, and only persisted audit is ACK',async t=>{
  const apply=deferred();let request,store;const b=await fixture(t,async input=>{
    if(input.prompt==='unrelated')return result(input);
    input.onSession('session-'+input.taskId,input.workspace);store=new InteractionStore(input.paths.dir,{conversationKey:input.conversationKey,taskId:input.taskId});store.setAdmission(input.taskId,true);request=requestFor(input,store,'approval');
    await apply.promise;const response=store.read('responses',request.requestId);assert.ok(response);store.receipt(request.requestId,{responseDigest:response.responseDigest,persisted:true,nativeEvent:{type:'approval/decided',seq:9},outcome:'allowed-once'});return result(input);
  });
  const started=await call(b.client,'dsh_task',{prompt:'approval',permission_mode:'read-only',background:true}),id=started.structuredContent.task_id;await until(()=>request);
  const status=(await call(b.client,'dsh_status',{task_id:id})).structuredContent;assert.equal(status.waiting_phase,'approval');assert.equal(status.pending_interaction_count,1);
  const page=(await call(b.client,'dsh_interactions',{task_id:id})).structuredContent;assert.equal(page.interactions[0].request_digest,request.requestDigest);
  const detail=(await call(b.client,'dsh_interactions',{task_id:id,request_id:request.requestId})).structuredContent;assert.deepEqual(JSON.parse(Buffer.from(detail.detail_base64,'base64')).detail.operation,request.detail.operation);
  const queued=(await call(b.client,'dsh_respond',responseArgs(id,request))).structuredContent;assert.equal(queued.state,'submitted');assert.equal(queued.acknowledged,false);assert.equal(queued.continuation_task_id,null);
  const unrelated=await call(b.client,'dsh_task',{prompt:'unrelated',permission_mode:'read-only'});assert.equal((await call(b.client,'dsh_respond',responseArgs(unrelated.structuredContent.task_id,request))).isError,true);
  apply.resolve();await b.scheduler.waitForTerminal(b.manager.taskContext(id),id,5000);
  const ack=(await call(b.client,'dsh_respond',responseArgs(id,request))).structuredContent;assert.equal(ack.acknowledged,true);assert.equal(ack.idempotent,true);
  assert.equal((await call(b.client,'dsh_respond',{...responseArgs(id,request),decision:'rejected'})).isError,true);assert.equal((await call(b.client,'dsh_respond',{...responseArgs(id,request),request_digest:'f'.repeat(64)})).isError,true);
});
test('late answer explicitly creates exactly one same-session continuation and never a prompt',async t=>{
  let request,store,continuations=0;const b=await fixture(t,async input=>{
    if(!input.continuationRequestId){store=new InteractionStore(input.paths.dir,{conversationKey:input.conversationKey,taskId:input.taskId});request=requestFor(input,store);store.transition(request.requestId,'continued');return result(input);}
    continuations++;assert.equal(input.prompt,null);assert.equal(input.continuationRequestId,request.requestId);assert.equal(input.sessionId,request.sessionId);assert.equal(input.interactionSource.owner.taskId,store.owner.taskId);assert.equal(input.configuration.resolved.questionPolicy,'continue');
    const response=store.read('responses',request.requestId);assert.equal(response.deliveryTaskId,input.taskId);store.receipt(request.requestId,{responseDigest:response.responseDigest,persisted:true,nativeEvent:{type:'user/message',seq:18},outcome:'answered'});return result(input);
  });
  const origin=await call(b.client,'dsh_task',{prompt:'ask then continue',question_policy:'continue',permission_mode:'read-only'}),id=origin.structuredContent.task_id;assert.equal(origin.structuredContent.state,'completed');assert.equal(origin.structuredContent.pending_interaction_count,1);
  const first=(await call(b.client,'dsh_respond',responseArgs(id,request))).structuredContent;assert.ok(first.continuation_task_id);assert.notEqual(first.continuation_task_id,id);
  const repeated=(await call(b.client,'dsh_respond',responseArgs(id,request))).structuredContent;assert.equal(repeated.continuation_task_id,first.continuation_task_id);assert.equal(repeated.idempotent,true);
  await b.scheduler.waitForTerminal(b.manager.taskContext(first.continuation_task_id),first.continuation_task_id,5000);assert.equal(continuations,1);
  const ack=(await call(b.client,'dsh_respond',responseArgs(id,request))).structuredContent;assert.equal(ack.acknowledged,true);assert.equal(b.manager.readCatalog().taskOrder.length,2);
});
test('quarantine and normally failed origin tasks refuse late answers without accepting a new task',async t=>{
  let request;const b=await fixture(t,async input=>{const store=new InteractionStore(input.paths.dir,{conversationKey:input.conversationKey,taskId:input.taskId});request=requestFor(input,store);store.transition(request.requestId,'continued');return result(input,{state:'failed',reason:{kind:'error',message:'synthetic failure'}});});
  const origin=await call(b.client,'dsh_task',{prompt:'failure',question_policy:'continue'}),id=origin.structuredContent.task_id;const response=await call(b.client,'dsh_respond',responseArgs(id,request));assert.equal(response.isError,true);assert.equal(b.manager.readCatalog().taskOrder.length,1);
  // A completed task with an externally active quarantine is also blocked, including explicit continuations.
  const ctx=b.manager.taskContext(id);fs.writeFileSync(path.join(ctx.dir,'.execution-quarantine.json'),JSON.stringify({taskId:id}));assert.equal((await call(b.client,'dsh_respond',responseArgs(id,request))).structuredContent.error.code,'EXECUTION_QUARANTINED');assert.equal(b.manager.readCatalog().taskOrder.length,1);
});
test('connection loss cancels the blocked original without an approval and leaves no active controllers',async t=>{
  let request,store;const b=await fixture(t,async input=>{input.onSession('session-'+input.taskId,input.workspace);store=new InteractionStore(input.paths.dir,{conversationKey:input.conversationKey,taskId:input.taskId});store.setAdmission(input.taskId,true);request=requestFor(input,store,'approval');await delay(60000,input.signal);return result(input);});
  const origin=await call(b.client,'dsh_task',{prompt:'wait for approval',background:true}),id=origin.structuredContent.task_id;await until(()=>request);await b.close();assert.equal(b.scheduler.jobs.size,0);assert.equal(b.manager.taskContext(id).store.getTask(id).state,'cancelled');assert.equal(store.snapshot(request.requestId).state.status,'cancelled');assert.equal(store.snapshot(request.requestId).response,null);
});

test('answer accepted after admission closes waits for normal origin completion; no replay on failure',async t=>{
  const release=deferred();let request,store,continuations=0;const b=await fixture(t,async input=>{
    if(input.continuationRequestId){continuations++;return result(input);}
    input.onSession('session-'+input.taskId,input.workspace);store=new InteractionStore(input.paths.dir,{conversationKey:input.conversationKey,taskId:input.taskId});request=requestFor(input,store);store.transition(request.requestId,'continued');store.setAdmission(input.taskId,false);await release.promise;
    return result(input,{state:'failed',reason:{kind:'error',message:'Origin failed after closing admission'}});
  });
  const task=await call(b.client,'dsh_task',{prompt:'late race',question_policy:'continue',background:true}),id=task.structuredContent.task_id;await until(()=>request);
  const accepted=(await call(b.client,'dsh_respond',responseArgs(id,request))).structuredContent;assert.ok(accepted.continuation_task_id);release.resolve();
  await b.scheduler.waitForTerminal(b.manager.taskContext(accepted.continuation_task_id),accepted.continuation_task_id,5000);assert.equal(continuations,0);assert.equal(b.manager.taskContext(accepted.continuation_task_id).store.getTask(accepted.continuation_task_id).state,'failed');assert.equal(store.snapshot(request.requestId).receipt?.applied===true,false);
});
test('interaction persistence failure never downgrades an unconfirmed tree or releases quarantine',async t=>{
  const rename=fs.renameSync;let armed=false;const b=await fixture(t,async input=>{input.onProcess({pid:process.pid,workerPid:process.pid,supervision:'synthetic-unknown'});armed=true;throw Object.assign(new Error('Tree exit is unknown'),{code:'TREE_EXIT_UNCONFIRMED',treeExited:false});});
  fs.renameSync=function(from,to){if(armed&&typeof to==='string'&&/[\\/]interactions[\\/]admissions[\\/]/.test(to))throw Object.assign(new Error('interaction disk failure'),{code:'EIO'});return rename.call(this,from,to);};
  try {const value=(await call(b.client,'dsh_task',{prompt:'unknown tree'})).structuredContent;assert.equal(value.state,'interrupted');assert.equal(value.recovery_required,true);const ctx=b.manager.taskContext(value.task_id);assert.equal(ctx.store.getTask(value.task_id).treeExited,false);assert.ok(fs.existsSync(path.join(ctx.dir,'.execution-quarantine.json')));}
  finally{fs.renameSync=rename;}
});

test('missing interaction task has a stable not-found result without a writable lookup',()=>{
  let writes=0;const manager={readTaskContext:()=>({store:{getTask:()=>null}}),taskContext:()=>{writes++;throw new Error('write lookup');}};
  assert.throws(()=>interactionContext(manager,'missing'),{code:'TASK_NOT_FOUND'});assert.equal(writes,0);
});
test('reconnected interaction/status readers preserve every state file and directory without locks',async t=>{
  let request;const b=await fixture(t,async input=>{const store=new InteractionStore(input.paths.dir,{conversationKey:input.conversationKey,taskId:input.taskId});request=requestFor(input,store);store.transition(request.requestId,'continued');return result(input);});
  const origin=await call(b.client,'dsh_task',{prompt:'durable pending question',question_policy:'continue'}),id=origin.structuredContent.task_id;await b.close();
  function snapshot(root){const rows=[];function walk(dir,relative=''){for(const name of fs.readdirSync(dir).sort()){const file=path.join(dir,name),rel=relative+name,stat=fs.lstatSync(file);rows.push([rel,stat.isDirectory()?'directory':'file',stat.mtimeMs,stat.isFile()?fs.readFileSync(file).toString('base64'):null]);if(stat.isDirectory())walk(file,rel+'/');}}walk(root);return rows;}
  const before=snapshot(b.manager.stateRoot);let launches=0;
  const reader=await connect({env:isolatedEnv(b.dir),sourceEnv:{},stateRoot:b.manager.stateRoot,defaultWorkspace:b.dir,runTaskImpl:async input=>{launches++;return result(input);}});t.after(()=>reader.close());
  const page=(await call(reader.client,'dsh_interactions',{task_id:id})).structuredContent;assert.equal(page.interactions[0].status,'continued');
  const detail=(await call(reader.client,'dsh_interactions',{task_id:id,request_id:request.requestId})).structuredContent;assert.equal(detail.request_digest,request.requestDigest);
  assert.equal((await call(reader.client,'dsh_status',{task_id:id})).structuredContent.pending_interaction_count,1);
  assert.deepEqual(snapshot(b.manager.stateRoot),before);assert.equal(launches,0);
});
test('persisted continuation intent with no registered task requires recovery and never auto-replays',async t=>{
  let request,store,launches=0;const b=await fixture(t,async input=>{launches++;store=new InteractionStore(input.paths.dir,{conversationKey:input.conversationKey,taskId:input.taskId});request=requestFor(input,store);store.transition(request.requestId,'continued');return result(input);});
  const origin=await call(b.client,'dsh_task',{prompt:'continued before simulated crash',question_policy:'continue'}),id=origin.structuredContent.task_id;
  store.submit({requestId:request.requestId,requestDigest:request.requestDigest,type:'questionnaire',payload:{answers}},()=>({deliveryTaskId:'t-missing-continuation',continuationTaskId:'t-missing-continuation'}));
  for(let i=0;i<2;i++){const value=(await call(b.client,'dsh_respond',responseArgs(id,request))).structuredContent;assert.equal(value.recovery_required,true);assert.equal(value.idempotent,true);assert.equal(value.acknowledged,false);assert.equal(value.continuation_task_id,'t-missing-continuation');}
  assert.equal(launches,1);assert.equal(b.manager.readCatalog().taskOrder.length,1);assert.equal(store.read('receipts',request.requestId),null);
});
