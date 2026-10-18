import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {syntheticSupervise} from './fixtures/synthetic-sdk.mjs';
import { runTask } from '../lib/task-runner.js';
import { taskPaths } from '../lib/paths.js';
import { writeJsonAtomic } from '../lib/io.js';
import { delay } from '../lib/file-lock.js';
import { TaskStore } from '../lib/store.js';
import { connect,call,result } from './mcp-helpers.js';
import { createChannel,appendGuidance,prepareSteering,confirmSteering,channelPaths } from '../dsh-plugin/channel.js';
import { tempDir,isolatedEnv } from './helpers.js';
function runnerFixture(t) {const temp=tempDir('runner-fault');t.after(temp.cleanup);const paths=taskPaths('c','task',path.join(temp.dir,'state')),env=isolatedEnv(temp.dir,{DSH_HOME:path.join(temp.dir,'home')});return {temp,paths,input:{conversationKey:'c',taskId:'task',workspace:temp.dir,prompt:'no-model stub',stateRoot:path.join(temp.dir,'state'),paths,runtime:{launcher:{command:process.execPath,prefixArgs:[],launcherScript:'fake-cli'},home:env.DSH_HOME,version:'0.2.1-rc.2',env},ensureProfileImpl:async()=>({name:'verified-fake-profile',fingerprint:'fake'})}};}
test('runner uses the exact resolved launcher, environment, home and immutable profile throughout',async t=> {
 const f=runnerFixture(t);let session;const input={...f.input,onSession:id=>session=id};input.superviseImpl=syntheticSupervise({inspect:options=>{assert.equal(options.command,input.runtime.launcher.command);assert.equal(options.env.DSH_HOME,input.runtime.home);assert.equal(options.env.DSH_MCP_WORKSPACE,input.workspace);assert.ok(options.args.includes('verified-fake-profile'));}});
 const value=await runTask(input);assert.equal(value.state,'completed');assert.match(session,/^[a-f0-9-]{36}$/);assert.equal(value.reports,undefined);assert.equal(value.answer,'answer');
});
test('cancelled before preparation or expired acceptance deadline never spawns or provisions',async t=> {
 const f=runnerFixture(t),controller=new AbortController();controller.abort({kind:'cancelled',message:'already cancelled'});let calls=0;
 await assert.rejects(runTask({...f.input,signal:controller.signal,ensureProfileImpl:async()=>{calls++;},superviseImpl:async()=>{calls++;}}));assert.equal(calls,0);
 await assert.rejects(runTask({...f.input,deadline:Date.now()-1,ensureProfileImpl:async()=>{calls++;}}));assert.equal(calls,0);
});
test('standalone task timeout covers provisioning instead of starting after it',async t=> {
 const f=runnerFixture(t);let launched=false;const now=Date.now();await assert.rejects(runTask({...f.input,timeoutMs:30,ensureProfileImpl:async options=>{await delay(1000,options.signal);},superviseImpl:async()=>{launched=true;}}));assert.equal(launched,false);assert.ok(Date.now()-now<500);
});
test('missing effective-permission proof refuses the task rather than running unverified',async t=> {
 const f=runnerFixture(t);const value=await runTask({...f.input,superviseImpl:syntheticSupervise({missingProof:true})});assert.equal(value.state,'failed');assert.match(value.reason.message,/proof is missing/);
});
test('timeout preserves captured main session before terminating the runner',async t=> {
 const f=runnerFixture(t);let captured;const value=await runTask({...f.input,timeoutMs:80,onSession:id=>captured=id,superviseImpl:syntheticSupervise({stall:'session/prompt'})});
 assert.equal(value.state,'timeout');assert.match(captured,/^[a-f0-9-]{36}$/);assert.equal(value.sessionId,captured);
});
test('log write failure is explicit and closes both owned descriptors',async t=> {
 const f=runnerFixture(t),open=fs.openSync,write=fs.writeFileSync,descriptors=[];
 fs.openSync=function(file,...args){const fd=open.call(this,file,...args);if(file===f.paths.reportLog||file===f.paths.stderrLog)descriptors.push(fd);return fd;};
 fs.writeFileSync=function(file,...args){if(typeof file==='number'&&descriptors.includes(file))throw Object.assign(new Error('disk full'),{code:'ENOSPC'});return write.call(this,file,...args);};
 try{await assert.rejects(runTask({...f.input,superviseImpl:syntheticSupervise()}),/disk full/);}
 finally{fs.openSync=open;fs.writeFileSync=write;}
 assert.equal(descriptors.length,2);for(const fd of descriptors)assert.throws(()=>fs.fstatSync(fd),{code:'EBADF'});
});
test('failed report persistence yields a tool error and releases every controller',async t=> {
 const temp=tempDir('queue-disk-fault');let b;const open=fs.openSync,write=fs.writeFileSync,close=fs.closeSync,bad=new Set();
 try{b=await connect({env:isolatedEnv(temp.dir),stateRoot:path.join(temp.dir,'state'),defaultWorkspace:temp.dir,runTaskImpl:async input=>{input.onReport({text:'should persist'});return result(input);}});
  fs.openSync=function(file,flags,...args){const fd=open.call(this,file,flags,...args);if(typeof file==='string'&&file.endsWith('reports.ndjson')&&flags==='a')bad.add(fd);return fd;};
  fs.writeFileSync=function(file,...args){if(bad.has(file))throw Object.assign(new Error('disk full'),{code:'ENOSPC'});return write.call(this,file,...args);};
  fs.closeSync=function(fd){bad.delete(fd);return close.call(this,fd);};
  const task=await call(b.client,'dsh_task',{prompt:'disk failure'});assert.equal(task.isError,true);assert.equal(task.structuredContent.state,'failed');assert.equal([...b.manager.contexts.values()].reduce((sum,c)=>sum+c.controllers.size,0),0);
 }finally{fs.openSync=open;fs.writeFileSync=write;fs.closeSync=close;await b?.close();temp.cleanup();}
});
test('crash after confirmation journal but before ACK redelivers, never loses a guidance batch',t=> {
 const temp=tempDir('ack-crash');t.after(temp.cleanup);const paths=taskPaths('c','t',path.join(temp.dir,'state')),owner={conversationKey:'c',taskId:'t'};createChannel(paths.inbox,owner);for(let i=0;i<25;i++)appendGuidance(paths.inbox,'guide '+i);
 const opts={owner,agentRole:'main',agentId:'main',callId:'call'},batch=prepareSteering(paths.inbox,opts),rename=fs.renameSync,ack=channelPaths(paths.inbox).ack;
 fs.renameSync=function(source,dest){if(dest===ack)throw Object.assign(new Error('crash before ack'),{code:'EIO'});return rename.call(this,source,dest);};
 try{assert.throws(()=>confirmSteering(paths.inbox,batch,{...opts,persisted:true}),/crash before ack/);}finally{fs.renameSync=rename;}
 const retry=prepareSteering(paths.inbox,{...opts,callId:'retry'});assert.deepEqual(retry.map(m=>m.messageId),batch.map(m=>m.messageId));confirmSteering(paths.inbox,retry,{...opts,persisted:true});assert.equal(prepareSteering(paths.inbox,opts).length,5);
});
test('task terminal state cannot be reopened or silently overwritten with another terminal state',t=> {
 const temp=tempDir('terminal-once');t.after(temp.cleanup);const store=new TaskStore({conversationKey:'c',dir:temp.dir}),task={taskId:'t',conversationKey:'c',state:'completed'};store.putTask(task);
 assert.throws(()=>store.putTask({...task,state:'running'}),/terminal/);assert.throws(()=>store.putTask({...task,state:'cancelled'}),/terminal/);
});

test('final-only stdout cannot bypass main-session permission verification',async t=> {
 const f=runnerFixture(t);await assert.rejects(runTask({...f.input,superviseImpl:async options=>{options.onStdout(Buffer.from('{"type":"final","text":"unverified"}\n'));return {code:0,treeExited:true};}}),/Malformed SDK|JSON-RPC/);
});

test('terminal task-record write failure returns a real failure instead of a stale preparing/running snapshot',async t=> {
 const temp=tempDir('terminal-write-fault');let b;const rename=fs.renameSync;
 try {
  b=await connect({env:isolatedEnv(temp.dir),stateRoot:path.join(temp.dir,'state'),defaultWorkspace:temp.dir,runTaskImpl:async input=>result(input)});
  fs.renameSync=function(source,dest){if(typeof dest==='string'&&dest.endsWith('task.json')){const value=JSON.parse(fs.readFileSync(source,'utf8'));if(['completed','failed','timeout','cancelled','interrupted'].includes(value.state))throw Object.assign(new Error('cannot persist terminal record'),{code:'EIO'});}return rename.call(this,source,dest);};
  const task=await call(b.client,'dsh_task',{prompt:'metadata write failure'});assert.equal(task.isError,true);assert.equal(task.structuredContent.state,'failed');assert.equal(task.structuredContent.error.code,'STATE_WRITE_FAILED');
  const status=await call(b.client,'dsh_status',{task_id:task.structuredContent.task_id});assert.notEqual(status.isError,true);assert.equal(status.structuredContent.state,'failed');assert.equal(status.structuredContent.error.code,'STATE_WRITE_FAILED');assert.equal(b.scheduler.jobs.size,0);assert.equal([...b.manager.contexts.values()].reduce((sum,c)=>sum+c.controllers.size,0),0);
 }finally{fs.renameSync=rename;await b?.close();temp.cleanup();}
});
