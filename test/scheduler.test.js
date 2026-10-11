import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { connect,call,result,deferred,text,releaseAllTestGates } from './mcp-helpers.js';
import { delay } from '../lib/file-lock.js';
import { ReportQueue } from '../lib/report-queue.js';
import { conversationDir } from '../lib/paths.js';
import { MAX_RESPONSE_BYTES } from '../lib/response.js';
import { tempDir,isolatedEnv } from './helpers.js';
async function fixture(t,runner,options={}) { const {dir,cleanup}=tempDir('scheduler');const bridge=await connect({env:isolatedEnv(dir,{DSH_HOME:path.join(dir,'shared-dsh-home')}),stateRoot:path.join(dir,'state'),defaultWorkspace:dir,runTaskImpl:runner,...options});t.after(async()=>{releaseAllTestGates();try{await bridge.close();}finally{cleanup();}});return {...bridge,dir}; }
async function until(check,timeout=3000) {const deadline=Date.now()+timeout;while(!check()){if(Date.now()>deadline)throw new Error('condition timed out');await delay(10);}}
test('all task tools publish outputSchema and structured control fields',async t=> {
  const b=await fixture(t,async input=>result(input)),tools=await b.client.listTools();
  for(const tool of tools.tools.filter(t=>t.name!=='dsh_self_check'))assert.ok(tool.outputSchema);
  const task=await call(b.client,'dsh_task',{prompt:'work'});for(const key of ['task_id','state','session_id','cursor','has_more'])assert.ok(key in task.structuredContent);
});
test('queued tasks read the previous session at execution, not submission',async t=> {
  const gate=deferred(),sessions=[];const b=await fixture(t,async input=>{sessions.push(input.sessionId);if(sessions.length===1)await gate.promise;return result(input,{sessionId:'shared-session'});});
  const a=await call(b.client,'dsh_task',{prompt:'first',background:true}),second=await call(b.client,'dsh_task',{prompt:'second',background:true});
  await until(()=>sessions.length===1);gate.resolve();await b.scheduler.waitForTerminal(b.registry.current(),second.structuredContent.task_id,3000);
  assert.deepEqual(sessions,[null,'shared-session']);assert.equal(b.registry.current().controllers.size,0);
});
test('captured session survives cancellation and is adopted by the next task',async t=> {
  const sessions=[];const b=await fixture(t,async input=>{sessions.push(input.sessionId);if(sessions.length===1){input.onSession('cancel-session',input.workspace,{verified:true});await new Promise(resolve=>input.signal.addEventListener('abort',resolve,{once:true}));return result(input,{state:'cancelled',sessionId:'cancel-session'});}return result(input);});
  const started=await call(b.client,'dsh_task',{prompt:'first',background:true});await until(()=>sessions.length===1);
  const cancelled=await call(b.client,'dsh_cancel',{task_id:started.structuredContent.task_id});assert.equal(cancelled.structuredContent.state,'cancelled');
  await call(b.client,'dsh_task',{prompt:'follow up'});assert.deepEqual(sessions,[null,'cancel-session']);
});
test('queued cancellation settles immediately without launching or leaking controllers',async t=> {
  const gate=deferred();let calls=0;const b=await fixture(t,async input=>{calls++;await gate.promise;return result(input);});
  await call(b.client,'dsh_task',{prompt:'first',background:true});await until(()=>calls===1);
  const second=await call(b.client,'dsh_task',{prompt:'second',background:true});const id=second.structuredContent.task_id;
  const cancelled=await call(b.client,'dsh_cancel',{task_id:id});assert.equal(cancelled.structuredContent.state,'cancelled');assert.equal(b.registry.current().controllers.has(id),false);assert.equal(calls,1);gate.resolve();
});
test('task deadline includes time waiting in the conversation queue',async t=> {
  const gate=deferred();let calls=0;const b=await fixture(t,async input=>{calls++;await gate.promise;return result(input);});
  await call(b.client,'dsh_task',{prompt:'first',background:true});await until(()=>calls===1);
  const timed=await call(b.client,'dsh_task',{prompt:'queued',timeout_ms:40});assert.equal(timed.isError,true);assert.equal(timed.structuredContent.state,'timeout');assert.equal(calls,1);
  const status=await call(b.client,'dsh_status',{task_id:timed.structuredContent.task_id});assert.notEqual(status.isError,true);assert.equal(status.structuredContent.state,'timeout');gate.resolve();
});
test('foreground auto-detach removes the originating request cancellation association',async t=> {
  const gate=deferred(),request=new AbortController();let captured;const b=await fixture(t,async input=>{captured=input;await gate.promise;return result(input);},{foregroundWaitMs:20});
  const task=await call(b.client,'dsh_task',{prompt:'long'},undefined,{signal:request.signal});assert.ok(['queued','preparing','running'].includes(task.structuredContent.state));assert.match(text(task),/continues in the background/);
  request.abort();await delay(30);assert.equal(captured.signal.aborted,false);gate.resolve();await b.scheduler.waitForTerminal(b.registry.current(),task.structuredContent.task_id,3000);
});
test('MCP foreground request cancellation reaches the actual task controller',async t=> {
  const request=new AbortController();let captured;const b=await fixture(t,async input=>{captured=input;await new Promise(resolve=>input.signal.addEventListener('abort',resolve,{once:true}));return result(input,{state:'cancelled'});});
  const pending=call(b.client,'dsh_task',{prompt:'cancel me'},undefined,{signal:request.signal});await until(()=>captured);request.abort();await assert.rejects(pending);
  await until(()=>b.scheduler.jobs.size===0);assert.equal(captured.signal.aborted,true);assert.equal(b.registry.current().store.latestTask().state,'cancelled');
});
test('MCP transport close stops background tasks and releases controllers',async t=> {
  let captured;const b=await fixture(t,async input=>{captured=input;await new Promise(resolve=>input.signal.addEventListener('abort',resolve,{once:true}));return result(input,{state:'cancelled'});});
  await call(b.client,'dsh_task',{prompt:'background',background:true});await until(()=>captured);await b.client.close();await b.shutdown();assert.equal(captured.signal.aborted,true);assert.equal(b.registry.current().controllers.size,0);
});
test('long polling rereads the task after completion and returns its answer',async t=> {
  const gate=deferred();let captured;const b=await fixture(t,async input=>{captured=input;await gate.promise;return result(input,{answer:'fresh terminal answer'});});
  const started=await call(b.client,'dsh_task',{prompt:'work',background:true});await until(()=>captured);
  const poll=call(b.client,'dsh_status',{task_id:started.structuredContent.task_id,cursor:0,wait_ms:1000});setTimeout(gate.resolve,40);const status=await poll;
  assert.equal(status.structuredContent.state,'completed');assert.equal(status.structuredContent.answer,'fresh terminal answer');
});
test('existing unread reports return immediately rather than waiting for future changes',async t=> {
  const gate=deferred();let captured;const b=await fixture(t,async input=>{captured=input;input.onReport({eventId:'available',text:'already available'});await gate.promise;return result(input);});
  const started=await call(b.client,'dsh_task',{prompt:'work',background:true});await until(()=>captured);const now=Date.now();const status=await call(b.client,'dsh_status',{cursor:0,wait_ms:1000});assert.ok(Date.now()-now<500);assert.match(text(status),/already available/);gate.resolve();
});
test('latest-task defaults for status, steering and cancellation never target the oldest task',async t=> {
  const gates=[deferred(),deferred()];let count=0;const b=await fixture(t,async input=>{const index=count++;await gates[index].promise;return result(input);});
  const first=await call(b.client,'dsh_task',{prompt:'old',background:true});await until(()=>count===1);const newer=await call(b.client,'dsh_task',{prompt:'new',background:true});
  const status=await call(b.client,'dsh_status');assert.equal(status.structuredContent.task_id,newer.structuredContent.task_id);
  const steer=await call(b.client,'dsh_steer',{message:'new only'});assert.equal(steer.structuredContent.task_id,newer.structuredContent.task_id);
  const cancelled=await call(b.client,'dsh_cancel');assert.equal(cancelled.structuredContent.task_id,newer.structuredContent.task_id);assert.equal(cancelled.structuredContent.state,'cancelled');assert.notEqual(first.structuredContent.task_id,newer.structuredContent.task_id);gates[0].resolve();
});
test('failed execution is a tool error but successful status queries are not',async t=> {
  const b=await fixture(t,async input=>result(input,{state:'failed',reason:{kind:'error',code:'REAL_ERROR',message:'real DSH reason'},answer:null,exitCode:1}));
  const task=await call(b.client,'dsh_task',{prompt:'failure'});assert.equal(task.isError,true);assert.equal(task.structuredContent.error.code,'REAL_ERROR');
  const status=await call(b.client,'dsh_status');assert.notEqual(status.isError,true);assert.equal(status.structuredContent.state,'failed');
});
test('failed tree termination is interrupted and never reported as confirmed cancelled',async t=> {
  let captured;const b=await fixture(t,async input=>{captured=input;input.onProcess({pid:process.pid,supervision:'test'});await new Promise(resolve=>input.signal.addEventListener('abort',resolve,{once:true}));throw Object.assign(new Error('guardian lost'),{code:'TREE_EXIT_UNCONFIRMED'});});
  await call(b.client,'dsh_task',{prompt:'work',background:true});await until(()=>captured);const cancelled=await call(b.client,'dsh_cancel');assert.equal(cancelled.isError,true);assert.equal(cancelled.structuredContent.state,'interrupted');assert.doesNotMatch(text(cancelled),/cancelled after confirmed/);
  const retry=await call(b.client,'dsh_task',{prompt:'must not overlap',new_session:true});assert.equal(retry.isError,true);assert.equal(retry.structuredContent.error.code,'EXECUTION_QUARANTINED');
});
test('wrong-conversation self-check fails without revealing binding or task IDs',async t=> {
  const b=await fixture(t,async input=>result(input));const task=await call(b.client,'dsh_task',{prompt:'private'}, {threadId:'PRIVATE_BOUND_CONVERSATION'});
  const check=await call(b.client,'dsh_self_check',{}, {threadId:'other'});assert.equal(check.isError,true);assert.ok(!text(check).includes('PRIVATE_BOUND_CONVERSATION'));assert.ok(!text(check).includes(task.structuredContent.task_id));
});
test('responses page by the combined 64 KiB budget, with explicit truncation and full disk content',async t=> {
  const answer='中文😀'.repeat(10000);const b=await fixture(t,async input=>{for(let i=0;i<55;i++)input.onReport({eventId:'large-'+i,text:'same 中文'.repeat(1000),data:{i,huge:'x'.repeat(30000)}});return result(input,{answer});});
  const run=await call(b.client,'dsh_task',{prompt:'large'});assert.ok(Buffer.byteLength(JSON.stringify(run))<=MAX_RESPONSE_BYTES);assert.equal(run.structuredContent.truncated,true);
  const raw=JSON.parse(fs.readFileSync(b.registry.current().taskPaths(run.structuredContent.task_id).result,'utf8'));assert.equal(raw.answer,answer);
  let cursor=0,seen=[];
  while(true){const page=await call(b.client,'dsh_status',{cursor,limit:200});assert.ok(Buffer.byteLength(JSON.stringify(page))<=MAX_RESPONSE_BYTES);seen.push(...page.structuredContent.reports.map(r=>r.seq));assert.ok(page.structuredContent.cursor>=cursor);cursor=page.structuredContent.cursor;if(!page.structuredContent.has_more)break;}
  assert.deepEqual(seen,Array.from({length:56},(_,i)=>i+1));
});
test('session workspace mismatch fails explicitly without silently rerunning or adopting',async t=> {
  let count=0;const b=await fixture(t,async input=>{count++;return result(input,{sessionId:'old-workspace-session'});});await call(b.client,'dsh_task',{prompt:'initial'});
  const other=path.join(b.dir,'other');fs.mkdirSync(other);const fail=await call(b.client,'dsh_task',{prompt:'next',workspace:other});assert.equal(fail.isError,true);assert.equal(fail.structuredContent.error.code,'SESSION_WORKSPACE_MISMATCH');assert.equal(count,1);
  const fresh=await call(b.client,'dsh_task',{prompt:'explicit new',workspace:other,new_session:true});assert.equal(fresh.structuredContent.state,'completed');assert.equal(count,2);
});
test('explicit metadata multiplexing serves distinct threads without shared tasks or sessions',async t=> {
  const adopted=[];const b=await fixture(t,async input=>{adopted.push([input.conversationKey,input.sessionId]);await delay(30);return result(input,{sessionId:'s-'+input.conversationKey});},{allowMultiplex:true});
  const [a,bResult]=await Promise.all([call(b.client,'dsh_task',{prompt:'A',sandbox_mode:'read-only'},{threadId:'Thread-A'}),call(b.client,'dsh_task',{prompt:'B',sandbox_mode:'read-only'},{threadId:'thread-a'})]);
  assert.deepEqual(adopted.map(x=>x[1]),[null,null]);assert.notEqual(a.structuredContent.task_id,bResult.structuredContent.task_id);
  const rejected=await call(b.client,'dsh_status',{task_id:a.structuredContent.task_id},{threadId:'thread-a'});assert.equal(rejected.isError,true);
  const unknown=await call(b.client,'dsh_self_check',{},{});assert.equal(unknown.isError,true);assert.equal(b.registry.contexts.size,2);
});

test('explicit source environment remains authoritative instead of being overlaid by process.env',async t=> {
 let captured;const b=await fixture(t,async input=>{captured=input.sourceEnv;return result(input);},{env:undefined,sourceEnv:{...process.env,SystemRoot:'source-only-system-root'}});
 const task=await call(b.client,'dsh_task',{prompt:'environment check'});assert.equal(task.structuredContent.state,'completed');assert.equal(captured.SystemRoot,'source-only-system-root');
});

test('oversized execution error is explicitly truncated with full persisted reason and string code',async t=> {
 const message='错误说明'.repeat(20000);const b=await fixture(t,async input=>result(input,{state:'failed',answer:null,reason:{kind:'error',message,error:{code:400,detail:'d'.repeat(40000)}},exitCode:1}));
 const task=await call(b.client,'dsh_task',{prompt:'error budget'});assert.equal(task.isError,true);assert.equal(task.structuredContent.truncated,true);assert.equal(task.structuredContent.error.truncated,true);assert.equal(task.structuredContent.error.code,'400');assert.ok(Buffer.byteLength(JSON.stringify(task))<=MAX_RESPONSE_BYTES);
 const full=JSON.parse(fs.readFileSync(b.registry.current().taskPaths(task.structuredContent.task_id).result,'utf8'));assert.equal(full.reason.message,message);
 const status=await call(b.client,'dsh_status',{task_id:task.structuredContent.task_id});assert.notEqual(status.isError,true);assert.equal(status.structuredContent.truncated,true);
});
