import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { TaskStore } from '../lib/store.js';
import { conversationDir, taskPaths, encodeKey } from '../lib/paths.js';
import { prepareConversationDirectory } from '../lib/migrate.js';
import { ReportQueue } from '../lib/report-queue.js';
import { JsonLineReader, writeJsonAtomic } from '../lib/io.js';
import { createChannel, appendChannelRecord, appendGuidance, channelPaths, prepareSteering, confirmSteering, drainSteering, ReportShardReader, readChannelRecords } from '../dsh-plugin/channel.js';
import { tempDir } from './helpers.js';
function setup(t,label) { const temp=tempDir(label);t.after(temp.cleanup);return temp.dir; }
function record(key,id,patch={}) { return {taskId:id,conversationKey:key,state:'completed',workspace:process.cwd(),createdAt:Date.now(),sessionId:null,...patch}; }
test('latest task and limited list choose newest tasks before slicing',t=> {
  const dir=setup(t,'latest'),store=new TaskStore({conversationKey:'c',dir});
  for(const id of ['old','middle','new']) store.putTask(record('c',id));
  assert.equal(store.latestTask().taskId,'new');assert.deepEqual(store.listTasks({limit:2}).map(t=>t.taskId),['new','middle']);
});
test('case-distinct conversation keys stay isolated in one state root and home',t=> {
  const root=setup(t,'case');const a=conversationDir('Thread-X',root),b=conversationDir('thread-x',root);
  assert.notEqual(a.toLowerCase(),b.toLowerCase());
  const sa=new TaskStore({conversationKey:'Thread-X',dir:a}),sb=new TaskStore({conversationKey:'thread-x',dir:b});
  sa.writeSession('private-session',process.cwd());assert.equal(sb.readSession().sessionId,null);
  assert.throws(()=>new TaskStore({conversationKey:'thread-x',dir:a}),{code:'STATE_OWNER_MISMATCH'});
});
test('planted index and report ownership are rejected without disclosing their values',t=> {
  const dir=setup(t,'planted'),store=new TaskStore({conversationKey:'owner',dir});
  writeJsonAtomic(store.indexPath,{version:2,conversationKey:'private-other',order:[],sessionId:'private-session'});
  assert.throws(()=>store.readSession(),e=>e.code==='STATE_OWNER_MISMATCH'&&!e.message.includes('private'));
  const log=path.join(dir,'bad.ndjson');fs.writeFileSync(log,JSON.stringify({seq:1,taskId:'t',conversationKey:'private-other',text:'secret'})+'\n');
  assert.throws(()=>new ReportQueue({conversationKey:'owner',logPath:log}),{code:'STATE_OWNER_MISMATCH'});
});
test('unambiguous legacy migration copies data and retains the original byte-for-byte',t=> {
  const root=setup(t,'migration'),old=path.join(root,encodeKey('owner'));fs.mkdirSync(path.join(old,'tasks','t1'),{recursive:true});
  const task=record('owner','t1',{sessionId:'session'});const index={version:1,order:['t1'],sessionId:'session',sessionWorkspace:process.cwd()};
  fs.writeFileSync(path.join(old,'tasks.json'),JSON.stringify(index));fs.writeFileSync(path.join(old,'tasks','t1','task.json'),JSON.stringify(task));
  const original=fs.readFileSync(path.join(old,'tasks.json'));const target=prepareConversationDirectory('owner',root);
  assert.notEqual(target,old);assert.deepEqual(fs.readFileSync(path.join(old,'tasks.json')),original);
  const store=new TaskStore({conversationKey:'owner',dir:target});assert.equal(store.readSession().sessionId,'session');assert.equal(store.getTask('t1').taskId,'t1');
});
test('mixed-owner legacy migration refuses reuse and preserves source files',t=> {
  const root=setup(t,'ambiguous'),old=path.join(root,encodeKey('owner'));fs.mkdirSync(path.join(old,'tasks','t1'),{recursive:true});
  fs.writeFileSync(path.join(old,'tasks.json'),JSON.stringify({version:1,order:['t1'],sessionId:'secret'}));
  fs.writeFileSync(path.join(old,'tasks','t1','task.json'),JSON.stringify(record('Owner','t1')));
  assert.throws(()=>prepareConversationDirectory('owner',root),{code:'AMBIGUOUS_LEGACY_STATE'});assert.equal(fs.existsSync(path.join(old,'tasks.json')),true);assert.equal(fs.existsSync(conversationDir('owner',root)),false);
});
test('abandoned queued/preparing/running tasks become interrupted, not replayed',t=> {
  const dir=setup(t,'recover-task'),store=new TaskStore({conversationKey:'c',dir});
  for(const state of ['queued','preparing','running'])store.putTask(record('c',state,{state}));
  store.recoverInterrupted();assert.deepEqual(store.listTasks().map(t=>t.state),['interrupted','interrupted','interrupted']);
});
test('report restart restores cursor, event identity, and history beyond hot cache',t=> {
  const dir=setup(t,'recover-report'),logPath=path.join(dir,'reports.ndjson');let q=new ReportQueue({conversationKey:'c',logPath,maxHotReports:2,maxReportsPerTask:2});
  for(let i=1;i<=6;i++)q.push({taskId:'t',eventId:'e'+i,text:'same',agentId:'agent'+i,data:{i}});
  q=new ReportQueue({conversationKey:'c',logPath,maxHotReports:2,maxReportsPerTask:2});assert.equal(q.latestSeq('t'),6);assert.equal(q.list({taskId:'t'}).length,6);
  assert.equal(q.pushIfNew({taskId:'t',eventId:'e1',text:'same',agentId:'agent1',data:{i:1}}),null);
  assert.equal(q.push({taskId:'t',eventId:'e7',text:'same'}).seq,7);q.forget('t');assert.equal(q.latestSeq('t'),7);assert.ok(q.hotCount<=2);
});
test('equal wording from different agents or with different data is preserved',t=> {
  const dir=setup(t,'data-dedup'),q=new ReportQueue({conversationKey:'c',logPath:path.join(dir,'r.ndjson')});
  q.push({taskId:'t',eventId:'main:1',text:'done',agentId:'main',data:{x:1}});q.push({taskId:'t',eventId:'child:1',text:'done',agentId:'child',data:{x:1}});q.push({taskId:'t',eventId:'main:2',text:'done',agentId:'main',data:{x:2}});
  assert.deepEqual(q.list().map(r=>r.data.x),[1,1,2]);
});
test('full report text/data are retained on disk while the hot view is explicitly bounded',t=> {
  const dir=setup(t,'full-disk'),logPath=path.join(dir,'r.ndjson'),q=new ReportQueue({conversationKey:'c',logPath,maxTextBytes:32});
  const input={taskId:'t',text:'中文'.repeat(100),data:{huge:'x'.repeat(1000)}};const output=q.push(input);assert.equal(output.truncated,true);assert.equal(output.dataTruncated,true);
  const raw=JSON.parse(fs.readFileSync(logPath,'utf8'));assert.equal(raw.text,input.text);assert.deepEqual(raw.data,input.data);
});
test('incremental byte reader retains a half line and a split UTF-8 character',t=> {
  const dir=setup(t,'utf8'),file=path.join(dir,'bytes.ndjson'),bytes=Buffer.from(JSON.stringify({text:'中😀文'})+'\n');const reader=new JsonLineReader(file),seen=[];
  const index=bytes.indexOf(Buffer.from('😀'))+2;fs.writeFileSync(file,bytes.subarray(0,index));reader.poll(r=>seen.push(r));assert.equal(seen.length,0);
  fs.appendFileSync(file,bytes.subarray(index));reader.poll(r=>seen.push(r));reader.poll(r=>seen.push(r));assert.deepEqual(seen,[{text:'中😀文'}]);
});
test('25 guidance messages survive batch limits and independent report writes',t=> {
  const root=setup(t,'25-steers'),paths=taskPaths('c','t',root),owner={conversationKey:'c',taskId:'t'};createChannel(paths.inbox,owner);
  for(let i=1;i<=25;i++)appendGuidance(paths.inbox,'message '+i);
  appendChannelRecord(paths.inbox,{type:'report',text:'report before consume',eventId:'r1'});
  assert.deepEqual(drainSteering(paths.inbox).map(m=>m.seq),Array.from({length:20},(_,i)=>i+1));
  appendGuidance(paths.inbox,'message 26');appendChannelRecord(paths.inbox,{type:'report',text:'report during consume',eventId:'r2'});
  assert.deepEqual(drainSteering(paths.inbox).map(m=>m.seq),[21,22,23,24,25,26]);
  const reports=[];new ReportShardReader(paths.inbox,owner).poll(r=>reports.push(r));assert.deepEqual(reports.map(r=>r.eventId),['r1','r2']);
});
test('crash before confirmation redelivers stable guidance IDs; persisted confirmation advances only actual batch',t=> {
  const root=setup(t,'receipt'),paths=taskPaths('c','t',root),owner={conversationKey:'c',taskId:'t'};createChannel(paths.inbox,owner);
  for(let i=0;i<25;i++)appendGuidance(paths.inbox,'message '+i);
  const opts={owner,agentRole:'main',agentId:'main',callId:'call1'},first=prepareSteering(paths.inbox,opts);
  assert.equal(first.length,20);assert.deepEqual(prepareSteering(paths.inbox,{...opts,callId:'after-crash'}).map(m=>m.messageId),first.map(m=>m.messageId));
  assert.throws(()=>confirmSteering(paths.inbox,first,{...opts,persisted:false}));
  confirmSteering(paths.inbox,first,{...opts,persisted:true});const remaining=prepareSteering(paths.inbox,{...opts,callId:'call2'});
  assert.equal(remaining.length,5);confirmSteering(paths.inbox,remaining,{...opts,persisted:true});assert.deepEqual(prepareSteering(paths.inbox,opts),[]);
});
test('children cannot receive or confirm main-agent steering',t=> {
  const root=setup(t,'main-steer'),paths=taskPaths('c','t',root),owner={conversationKey:'c',taskId:'t'};createChannel(paths.inbox,owner);appendGuidance(paths.inbox,'main only');
  assert.deepEqual(prepareSteering(paths.inbox,{owner,agentRole:'subagent',agentId:'child'}),[]);
  const batch=prepareSteering(paths.inbox,{owner,agentRole:'main',agentId:'main',callId:'1'});
  assert.throws(()=>confirmSteering(paths.inbox,batch,{owner,agentRole:'subagent',persisted:true}));assert.equal(batch.length,1);
});
test('legacy draining appends a cursor and never rewrites or loses the >20 backlog',t=> {
  const dir=setup(t,'legacy-drain'),file=path.join(dir,'legacy.ndjson');for(let i=1;i<=25;i++)appendChannelRecord(file,{type:'steer',seq:i,text:'s'+i});
  const prefix=fs.readFileSync(file);assert.equal(drainSteering(file).length,20);assert.deepEqual(fs.readFileSync(file).subarray(0,prefix.length),prefix);assert.equal(drainSteering(file).length,5);
});
test('report shards do not shift offsets when steering is acknowledged',t=> {
  const root=setup(t,'shard-offset'),paths=taskPaths('c','t',root),owner={conversationKey:'c',taskId:'t'};createChannel(paths.inbox,owner);
  const reader=new ReportShardReader(paths.inbox,owner),reports=[];appendChannelRecord(paths.inbox,{type:'report',eventId:'1',text:'first'});reader.poll(r=>reports.push(r));
  appendGuidance(paths.inbox,'guide');drainSteering(paths.inbox);appendChannelRecord(paths.inbox,{type:'report',eventId:'2',text:'second'});reader.poll(r=>reports.push(r));reader.poll(r=>reports.push(r));assert.deepEqual(reports.map(r=>r.eventId),['1','2']);
});

test('sender crash after log append but before ID checkpoint retries the same guidance ID without duplicating',async t=> {
 const {dir,cleanup}=tempDir('guidance-sender-crash');t.after(cleanup);const file=path.join(dir,'inbox.json'),owner={conversationKey:'c',taskId:'t'};createChannel(file,owner);
 const log=path.join(dir,'steering.ndjson'),original=JSON.stringify({version:2,...owner,type:'steer',messageId:'stable-retry',seq:1,text:'same retry',ts:1})+'\n';fs.writeFileSync(log,original);
 const retry=appendGuidance(file,'same retry',{messageId:'stable-retry'});assert.equal(retry.seq,1);assert.equal(fs.readFileSync(log,'utf8'),original);
 const next=appendGuidance(file,'next',{messageId:'next'});assert.equal(next.seq,2);const messages=drainSteering(file);assert.deepEqual(messages.map(m=>m.messageId),['stable-retry','next']);
});

test('recovered process-bearing task fixes duration and prevents reuse while a monitored PID remains alive',t=> {
 const dir=setup(t,'recover-quarantine'),store=new TaskStore({conversationKey:'c',dir});store.putTask(record('c','old',{state:'running',executorPid:null,processPid:process.pid}));store.recoverInterrupted();
 const task=store.getTask('old');assert.equal(task.state,'interrupted');assert.ok(Number.isFinite(task.finishedAt));assert.equal(task.treeExited,false);assert.equal(task.quarantined,true);
 const q=JSON.parse(fs.readFileSync(path.join(dir,'.execution-quarantine.json'),'utf8'));assert.equal(q.conversationKey,'c');assert.deepEqual(q.processPids,[process.pid]);
});

test('report writer retries after a torn append preserve the old bytes and keep the new event parseable',t=> {
 const dir=setup(t,'report-writer-torn'),file=path.join(dir,'inbox.json'),owner={conversationKey:'c',taskId:'t'};createChannel(file,owner);appendChannelRecord(file,{type:'report',eventId:'first',text:'first'});
 const shard=path.join(dir,'reports',fs.readdirSync(path.join(dir,'reports'))[0]),before=fs.readFileSync(shard);fs.appendFileSync(shard,'{"version":2,"broken":');appendChannelRecord(file,{type:'report',eventId:'after-fault',text:'valid retry'});
 const reports=[];new ReportShardReader(file,owner).poll(r=>reports.push(r));assert.deepEqual(reports.map(r=>r.eventId),['first','after-fault']);assert.ok(fs.readFileSync(shard).subarray(0,before.length).equals(before));assert.match(fs.readFileSync(shard,'utf8'),/broken/);
});
