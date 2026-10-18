import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {InteractionStore,digestOf,canonicalJson,validateResponse} from '../dsh-plugin/interactions.js';
import {installInteractions} from '../dsh-plugin/interaction-runtime.js';
import {writeJsonAtomic} from '../lib/io.js';
import {tempDir} from './helpers.js';
const owner={conversationKey:'scope',taskId:'task'};
const questions=[{id:'one',question:'Choose one',options:[{label:'A'},{label:'B'}],intent:{kind:'plan-review',callId:'plan'}},
  {id:'many',question:'Choose several',multiSelect:true,options:[{label:'X'},{label:'Y'}]}];
const answers=[{id:'one',selected:['A']},{id:'many',selected:['X','Y'],custom:'more'}];
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function until(predicate){const end=Date.now()+5000;while(!predicate()){assert.ok(Date.now()<end,'interaction fixture timed out');await new Promise(resolve=>setTimeout(resolve,10));}}
function storeFixture(t){const temp=tempDir('interactions');t.after(temp.cleanup);return {dir:temp.dir,store:new InteractionStore(temp.dir,owner)};}
function makeRequest(store,type='approval',extra={}) {return store.create({type,createdInTaskId:owner.taskId,sessionId:'native-session',agentId:'native-session',callId:'call',nativeApprovalId:type==='approval'?'audit-id':null,
  summary:'Complete native request',expiresAt:Date.now()+60000,detail:{operation:{arguments:{file:'target'},schema:{name:'tool'}},...(type==='questionnaire'?{questions}:{} )},...extra});}
function submit(store,request,payload,route=()=>({deliveryTaskId:owner.taskId,continuationTaskId:null})){return store.submit({requestId:request.requestId,requestDigest:request.requestDigest,type:request.type,payload},route);}
test('request digests cover complete native operation, including fields beyond a response page',()=>{
  assert.equal(digestOf({b:2,a:{c:1}}),digestOf({a:{c:1},b:2}));assert.notEqual(digestOf({a:1}),digestOf({a:2}));
});
test('full request detail pages reassemble exact UTF-8 bytes and preserve plan-review intent',t=>{
  const {store}=storeFixture(t),request=makeRequest(store,'questionnaire',{detail:{questions,operation:{arguments:{text:'中文🙂'.repeat(20000)},schema:{description:'complete'}}}}),pages=[];let offset=0;
  do{const page=store.page({requestId:request.requestId,detailOffset:offset,detailLimit:4093});assert.equal(page.detail_encoding,'base64-utf8-json');assert.equal(page.request_digest,request.requestDigest);pages.push(Buffer.from(page.detail_base64,'base64'));offset=page.next_detail_offset;if(!page.has_more)break;}while(true);
  const recovered=JSON.parse(Buffer.concat(pages).toString('utf8'));assert.deepEqual(recovered,JSON.parse(canonicalJson(request)));assert.equal(recovered.detail.questions[0].intent.kind,'plan-review');assert.ok(Buffer.concat(pages).length>128*1024);
  assert.throws(()=>store.page({requestId:request.requestId,detailOffset:offset+1}),/exceeds/);
});
test('submission, native persistence and ACK are distinct; identical submissions are idempotent',t=>{
  const {store}=storeFixture(t),request=makeRequest(store),first=submit(store,request,{decision:'allowed-once'});
  assert.equal(first.receipt,null);assert.equal(store.snapshot(request.requestId).state.status,'open');
  let routed=0;assert.equal(submit(store,request,{decision:'allowed-once'},()=>{routed++;}).reused,true);assert.equal(routed,0);
  assert.throws(()=>submit(store,request,{decision:'rejected'}),{code:'INTERACTION_CONFLICT'});
  assert.throws(()=>store.receipt(request.requestId,{responseDigest:first.response.responseDigest,nativeEvent:{seq:1},persisted:false}),/persisted native event/);
  assert.equal(store.snapshot(request.requestId).receipt,null);
  const ack=store.receipt(request.requestId,{responseDigest:first.response.responseDigest,nativeEvent:{seq:3,type:'approval/decided'},persisted:true,outcome:'allowed-once'});
  assert.equal(ack.applied,true);assert.equal(store.pending().length,0);assert.equal(submit(store,request,{decision:'allowed-once'}).reused,true);
  for(const name of ['submissions.ndjson','acknowledgements.ndjson','lifecycle.ndjson'])assert.ok(fs.statSync(path.join(store.dir,name)).size>0);
});
test('scope, type, digest, stale, cancelled and over-budget requests refuse before routing',t=>{
  const {store,dir}=storeFixture(t),request=makeRequest(store);let routes=0;
  const data={requestId:request.requestId,requestDigest:request.requestDigest,type:'approval',payload:{decision:'allowed-once'}};
  for(const patch of [{requestDigest:'0'.repeat(64)},{type:'questionnaire'}])assert.throws(()=>store.submit({...data,...patch},()=>routes++),{code:'INTERACTION_MISMATCH'});
  assert.throws(()=>new InteractionStore(dir,{conversationKey:'other',taskId:'task'}).request(request.requestId),{code:'STATE_OWNER_MISMATCH'});
  const expired=makeRequest(store,'approval',{expiresAt:Date.now()-1}),cancelled=makeRequest(store);store.transition(cancelled.requestId,'cancelled');
  for(const r of [expired,cancelled])assert.throws(()=>submit(store,r,{decision:'allowed-once'},()=>routes++),{code:'INTERACTION_CLOSED'});
  assert.equal(routes,0);assert.throws(()=>makeRequest(store,'approval',{detail:{operation:{text:'x'.repeat(8*1024*1024)}}}),/not truncated/);
  const file=store.file('requests',request.requestId),value=JSON.parse(fs.readFileSync(file));value.detail.operation.arguments.file='different';writeJsonAtomic(file,value);assert.throws(()=>store.request(request.requestId),{code:'INTERACTION_CORRUPT'});
});
test('question responses retain native IDs, selection/custom shape; no permanent approval mode',t=>{
  const {store}=storeFixture(t),q=makeRequest(store,'questionnaire');assert.deepEqual(validateResponse(q,{answers:[...answers].reverse()}),{answers});
  for(const bad of [{answers:[]},{answers:[answers[0],answers[0]]},{answers:[{id:'one',selected:['A','B']},answers[1]]},{answers:[{id:'one',selected:['A'],custom:'both'},answers[1]]},{answers:[{id:'one',selected:['unknown']},answers[1]]}])assert.throws(()=>validateResponse(q,bad));
  const a=makeRequest(store);for(const decision of ['always','allowed-session','full-access'])assert.throws(()=>validateResponse(a,{decision}));
  assert.deepEqual(validateResponse(q,{answers:[{id:'one',selected:[],custom:'custom one'},answers[1]]}).answers[0].custom,'custom one');
});
test('delivery gate closure and response routing are atomic; rejection is never an ACK',t=>{
  const {store}=storeFixture(t),r=makeRequest(store);store.setAdmission('task',true);const value=submit(store,r,{decision:'cancelled'});
  assert.equal(store.tryCloseAdmission('task'),false);assert.equal(store.admission('task').open,true);
  const receipt=store.rejectResponse(r.requestId,'native disconnected');assert.equal(receipt.applied,false);assert.equal(store.snapshot(r.requestId).state.status,'cancelled');assert.equal(store.tryCloseAdmission('task'),true);assert.equal(store.admission('task').open,false);assert.ok(value.response.responseDigest);
});
function runtimeFixture(t,{policy='pause',flush=async()=>true,answer}={}) {
  const {dir,store}=storeFixture(t),listeners=new Map(),session={id:'native-session',log:[],seq:0};let projection={questions:{active:[],settled:[]}},failure;
  const agent={id:session.id,session,status:'idle'},state={agents:new Map([[agent.id,agent]]),mainAgentId:agent.id,accepting:true,closeAdmission(){this.accepting=false;},verify(a){if(!this.accepting||a!==agent)throw new Error('closed or unverified');}};
  const ctx={on(name,handler){if(!listeners.has(name))listeners.set(name,[]);listeners.get(name).push(handler);},
    tools:{get:()=>({name:'native-tool',description:'complete definition',parameters:{payload:{type:'string'}}})},workingDirectory:{get:()=>dir},sessions:{flush},
    sessionProjections:{stateOf:()=>projection},userQuestions:{answer:answer??(()=>true)}};
  const runtime=installInteractions(ctx,{state,channel:owner,dir,configuration:{questionPolicy:policy},deadline:Date.now()+60000,onFailure:error=>failure=error});
  t.after(async()=>{for(const handler of listeners.get('dispose')??[])await handler();});
  async function request(type='questionnaire',{timed=false,callId='call',controller=new AbortController(),intent}={}) {
    await listeners.get('tools/pre-execute')[0]({agent,name:type==='approval'?'native-tool':'ask_user_question',callId,arguments:{payload:'full payload'},rootCallId:'root',parent:{callId:'ptc'}},async()=>({kind:'allow'}));
    if(type==='approval')session.log.push({seq:++session.seq,type:'approval/asked',data:{id:'audit-id',toolName:'native-tool',callId}});
    const pending=listeners.get(type==='approval'?'approval/request':'user-questions/request')[0]({agent,callId,toolName:'native-tool',signal:controller.signal,
      ...(type==='questionnaire'?{questions:intent?[{...questions[0],intent}]:questions,wait:{timed,callId}}:{})});pending.catch(()=>{});
    const saved=store.all().at(-1).request;return {pending,saved,controller};
  }
  async function emit(type,data) {const event={seq:++session.seq,type,data};session.log.push(event);for(const handler of listeners.get('session/event')??[])handler(session,event);await tick();await tick();return event;}
  return {dir,store,state,session,agent,runtime,request,emit,projection:value=>projection=value,get failure(){return failure;}};
}
test('runtime ACKs approval only after the matching native audit is successfully flushed',async t=>{
  let allowFlush=false;const f=runtimeFixture(t,{flush:async()=>allowFlush}),r=await f.request('approval');
  const submitted=submit(f.store,r.saved,{decision:'allowed-once'});await f.runtime.poll();assert.equal(await r.pending,'allowed-once');assert.equal(f.store.read('receipts',r.saved.requestId),null);
  await f.emit('approval/decided',{id:'audit-id',outcome:'allowed-once'});await until(()=>f.failure);assert.match(f.failure.message,/no ACK/);assert.equal(f.store.read('receipts',r.saved.requestId),null);assert.equal(f.state.accepting,false);assert.ok(submitted.response);
});
test('pause waits until answer/cancel, and a successful PTC inner result supplies a durable ACK',async t=>{
  const f=runtimeFixture(t),r=await f.request('questionnaire');const submitted=submit(f.store,r.saved,{answers});await f.runtime.poll();assert.deepEqual(await r.pending,{answers});assert.equal(f.store.read('receipts',r.saved.requestId),null);
  await f.emit('tool/ptc-dispatch',{subCallId:'call',isError:false});await until(()=>f.store.read('receipts',r.saved.requestId));assert.equal(f.store.read('receipts',r.saved.requestId).applied,true);assert.equal(submitted.response.responseDigest,f.store.read('receipts',r.saved.requestId).responseDigest);
});
test('continued-question timeout does not cancel the durable request or invent a skipped answer',async t=>{
  const f=runtimeFixture(t,{policy:'continue'}),r=await f.request('questionnaire',{timed:true});r.controller.abort(Object.assign(new Error('elapsed'),{code:'ASK_TIMED_OUT'}));await assert.rejects(r.pending,/elapsed/);
  f.projection({questions:{active:[{callId:'call',state:'continued',questions}],settled:[]}});await f.emit('tool/result',{message:{toolCallId:'call',isError:false,content:[]}});await until(()=>f.store.snapshot(r.saved.requestId).state.status==='continued');
  assert.equal(f.store.read('receipts',r.saved.requestId),null);assert.equal(f.store.snapshot(r.saved.requestId).response,null);
  submit(f.store,r.saved,{answers});await f.runtime.poll();assert.equal(f.store.read('receipts',r.saved.requestId),null);
  f.projection({questions:{active:[],settled:[{callId:'call',answers}]}});await f.emit('user/message',{source:{kind:'user-question-reply',callId:'call'}});await until(()=>f.store.read('receipts',r.saved.requestId));assert.equal(f.store.read('receipts',r.saved.requestId).applied,true);
});
test('pause strategy refuses timed tool bypass; cancellation and plan intent remain distinct',async t=>{
  const f=runtimeFixture(t);await assert.rejects(f.request('questionnaire',{timed:true}),/pause policy/);assert.equal(f.state.accepting,false);assert.ok(f.failure);
});
test('native plan-review intent survives intact and an abort does not approve any tool',async t=>{
  const f=runtimeFixture(t),intent={kind:'plan-review',callId:'plan-call',plan:'original native intent'},r=await f.request('questionnaire',{intent});assert.deepEqual(r.saved.detail.questions[0].intent,intent);
  r.controller.abort(new Error('cancelled by task'));await assert.rejects(r.pending,/cancelled/);assert.equal(f.store.snapshot(r.saved.requestId).state.status,'cancelled');assert.equal(f.store.read('receipts',r.saved.requestId),null);
});

test('submission and receipt persistence failures cannot manufacture a durable native ACK',t=>{
  const {store}=storeFixture(t),request=makeRequest(store),rename=fs.renameSync;
  function failing(kind,work){const target=store.file(kind,request.requestId);fs.renameSync=function(from,to){if(to===target)throw Object.assign(new Error('injected interaction disk failure'),{code:'EIO'});return rename.call(this,from,to);};try{return work();}finally{fs.renameSync=rename;}}
  assert.throws(()=>failing('responses',()=>submit(store,request,{decision:'allowed-once'})),{code:'EIO'});assert.equal(store.read('responses',request.requestId),null);assert.equal(store.read('receipts',request.requestId),null);
  const queued=submit(store,request,{decision:'allowed-once'});
  assert.throws(()=>failing('receipts',()=>store.receipt(request.requestId,{responseDigest:queued.response.responseDigest,nativeEvent:{seq:3,type:'approval/decided'},persisted:true,outcome:'allowed-once'})),{code:'EIO'});
  assert.equal(store.read('receipts',request.requestId),null);assert.equal(store.snapshot(request.requestId).state.status,'open');assert.equal(store.pending().length,1);
});
test('an accepted response that expires before native delivery closes execution without applying it',async t=>{
  const f=runtimeFixture(t),r=await f.request('approval');submit(f.store,r.saved,{decision:'allowed-once'});
  const now=Date.now;Date.now=()=>r.saved.expiresAt+1;
  try{await f.runtime.poll();}finally{Date.now=now;}
  assert.match(f.failure.message,/Expired/);assert.equal(f.state.accepting,false);assert.equal(f.store.read('receipts',r.saved.requestId).applied,false);
  let applied=false;r.pending.then(()=>applied=true,()=>{});await tick();assert.equal(applied,false);
});

test('settlement drains queued native lifecycle events before closing interaction admission',async t=>{
  const f=runtimeFixture(t,{policy:'continue'}),r=await f.request('questionnaire',{timed:true});
  r.controller.abort(Object.assign(new Error('elapsed'),{code:'ASK_TIMED_OUT'}));await assert.rejects(r.pending,/elapsed/);
  f.projection({questions:{active:[{callId:'call',state:'continued',questions}],settled:[]}});
  const event=f.emit('tool/result',{message:{toolCallId:'call',isError:false,content:[]}});
  writeJsonAtomic(path.join(f.dir,'bridge-control.json'),{...owner,type:'settle'});
  await f.runtime.poll();assert.equal(f.store.snapshot(r.saved.requestId).state.status,'continued');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir,'bridge-settled.json'))).admissionClosed,true);assert.equal(f.state.accepting,false);await event;
});
