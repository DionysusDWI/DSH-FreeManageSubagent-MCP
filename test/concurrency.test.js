import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fork,spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers.js';
import { acquireWorkspaceLock,canonicalWorkspace } from '../lib/workspace-lock.js';
import { delay } from '../lib/file-lock.js';
import { ReportQueue } from '../lib/report-queue.js';
import { taskPaths } from '../lib/paths.js';
import { createChannel,ReportShardReader,drainSteering } from '../dsh-plugin/channel.js';
const fixture=fileURLToPath(new URL('./fixtures/concurrent-worker.mjs',import.meta.url));
function worker(t) {
 const child=fork(fixture,[],{stdio:['ignore','ignore','pipe','ipc'],execArgv:[],windowsHide:true});const events=[];let stderr='';child.stderr.on('data',b=>stderr+=b);child.on('message',e=>events.push(e));
 t.after(()=>{if(child.connected)child.disconnect();if(child.exitCode===null)child.kill();});
 return {child,events,send:m=>child.send(m),async wait(type){const end=Date.now()+5000;while(!events.some(e=>e.type===type)){const err=events.find(e=>e.type==='error');if(err)throw new Error(err.message);if(Date.now()>end)throw new Error('worker wait timed out: '+type+' '+stderr);await delay(10);}return events.find(e=>e.type===type);}};
}
function root(t,label){const temp=tempDir(label);t.after(temp.cleanup);return temp.dir;}
test('two MCP processes writing the same real workspace serialize',async t=> {
 const dir=root(t,'process-lock'),a=worker(t),b=worker(t),base={type:'lock',stateRoot:path.join(dir,'state'),workspace:dir,mode:'workspace-write',deadline:Date.now()+10000};
 a.send({...base,taskId:'a',conversationKey:'a'});await a.wait('acquired');b.send({...base,taskId:'b',conversationKey:'b'});await b.wait('waiting');await delay(100);assert.equal(b.events.some(e=>e.type==='acquired'),false);a.send({type:'release'});await b.wait('acquired');b.send({type:'release'});await b.wait('released');
});
test('parent/child workspace writes conflict across processes',async t=> {
 const dir=root(t,'overlap-lock'),sub=path.join(dir,'project');fs.mkdirSync(sub);const a=worker(t),b=worker(t),base={type:'lock',stateRoot:path.join(dir,'state'),mode:'workspace-write'};
 a.send({...base,workspace:dir,taskId:'a',conversationKey:'a'});await a.wait('acquired');b.send({...base,workspace:sub,taskId:'b',conversationKey:'b'});await b.wait('waiting');await delay(100);assert.equal(b.events.some(e=>e.type==='acquired'),false);a.send({type:'release'});await b.wait('acquired');b.send({type:'release'});await b.wait('released');
});
test('disjoint writes and read-only tasks are concurrent, full-access conflicts with all writes',async t=> {
 const dir=root(t,'parallel-lock'),one=path.join(dir,'one'),two=path.join(dir,'two');fs.mkdirSync(one);fs.mkdirSync(two);const a=worker(t),b=worker(t),reader=worker(t),danger=worker(t),base={type:'lock',stateRoot:path.join(dir,'state')};
 a.send({...base,workspace:one,mode:'workspace-write',taskId:'a',conversationKey:'a'});await a.wait('acquired');b.send({...base,workspace:two,mode:'workspace-write',taskId:'b',conversationKey:'b'});await b.wait('acquired');reader.send({...base,workspace:one,mode:'read-only',taskId:'r',conversationKey:'r'});await reader.wait('acquired');
 danger.send({...base,workspace:two,mode:'danger-full-access',taskId:'danger',conversationKey:'d'});await danger.wait('waiting');await delay(100);assert.equal(danger.events.some(e=>e.type==='acquired'),false);
 a.send({type:'release'});b.send({type:'release'});await danger.wait('acquired');danger.send({type:'release'});reader.send({type:'release'});await danger.wait('released');
});
test('concurrent report writers preserve all disk events and independent shards',async t=> {
 const dir=root(t,'process-report'),paths=taskPaths('owner','task',path.join(dir,'state')),owner={conversationKey:'owner',taskId:'task'},logPath=path.join(dir,'reports.ndjson');createChannel(paths.inbox,owner);
 const workers=Array.from({length:3},()=>worker(t));for(const w of workers)w.send({type:'reports',owner,channel:paths.inbox,logPath,count:12});await Promise.all(workers.map(w=>w.wait('done')));
 const q=new ReportQueue({conversationKey:owner.conversationKey,logPath,maxHotReports:4}),all=q.list({taskId:'task'});assert.equal(all.length,36);assert.deepEqual(all.map(r=>r.seq),Array.from({length:36},(_,i)=>i+1));assert.equal(new Set(all.map(r=>r.eventId)).size,36);
 const reports=[];new ReportShardReader(paths.inbox,owner).poll(r=>reports.push(r));assert.equal(reports.length,36);const shards=fs.readdirSync(paths.reports).length;assert.equal(shards,3);
 const evidence=process.env.CODEX_DSH_MCP_CONCURRENCY_EVIDENCE;
 if(evidence){
   const dest=path.resolve(evidence);assert.ok(path.isAbsolute(evidence)&&!dest.startsWith(path.resolve(dir)+path.sep)&&!fs.existsSync(dest),'Independent exclusive concurrency evidence destination required.');
   fs.cpSync(dir,dest,{recursive:true,force:false,errorOnExist:true,filter:file=>{assert.equal(fs.lstatSync(file).isSymbolicLink(),false);return true;}});
   fs.writeFileSync(path.join(dest,'round-verification.json'),JSON.stringify({evidenceLevel:'cross-process-no-model',events:36,uniqueEvents:36,sequences:all.map(r=>r.seq),eventIds:all.map(r=>r.eventId),shards:3,shardEvents:36,workerPids:workers.map(w=>w.child.pid),rawRecordsRetained:true},null,2)+'\n',{flag:'wx'});
 }
 t.diagnostic('concurrent-report-evidence '+JSON.stringify({events:all.length,uniqueEvents:new Set(all.map(r=>r.eventId)).size,sequences:all.map(r=>r.seq),shardEvents:reports.length,shards}));
});
test('concurrent guidance appenders assign unique monotonic sequences without rewrite',async t=> {
 const dir=root(t,'process-guidance'),paths=taskPaths('owner','task',path.join(dir,'state')),owner={conversationKey:'owner',taskId:'task'};createChannel(paths.inbox,owner);
 const workers=Array.from({length:3},()=>worker(t));for(const w of workers)w.send({type:'guidance',channel:paths.inbox,count:11});await Promise.all(workers.map(w=>w.wait('done')));
 const batches=[...drainSteering(paths.inbox),...drainSteering(paths.inbox)];assert.equal(batches.length,33);assert.equal(new Set(batches.map(m=>m.messageId)).size,33);assert.deepEqual(batches.map(m=>m.seq),Array.from({length:33},(_,i)=>i+1));
});

test('unconfirmed termination keeps a durable write quarantine while any monitored PID is alive',async t=> {
 const dir=root(t,'quarantine-write'),stateRoot=path.join(dir,'state');
 const release=await acquireWorkspaceLock({stateRoot,workspace:dir,mode:'workspace-write',taskId:'unknown',conversationKey:'a'});release.quarantine([process.pid]);
 await assert.rejects(acquireWorkspaceLock({stateRoot,workspace:dir,mode:'workspace-write',taskId:'next',conversationKey:'b',deadline:Date.now()+80}),e=>e.kind==='timeout');
 const readRelease=await acquireWorkspaceLock({stateRoot,workspace:dir,mode:'read-only',taskId:'read',conversationKey:'b'});readRelease();
 assert.ok(fs.readdirSync(path.join(stateRoot,'_locks','workspaces')).some(name=>name.endsWith('.json')));
});
test('crashed active claims without known child PIDs are quarantined, not silently reclaimed',async t=> {
 const dir=root(t,'unknown-crash-lock'),stateRoot=path.join(dir,'state'),locks=path.join(stateRoot,'_locks','workspaces');fs.mkdirSync(locks,{recursive:true});
 const gone=spawnSync(process.execPath,['-e',''],{windowsHide:true});assert.ifError(gone.error);
 const file=path.join(locks,'orphan.json');fs.writeFileSync(file,JSON.stringify({version:1,token:'orphan',pid:gone.pid,workspace:canonicalWorkspace(dir),mode:'workspace-write',taskId:'old',conversationKey:'a',createdAt:1,state:'active'}));
 await assert.rejects(acquireWorkspaceLock({stateRoot,workspace:dir,mode:'workspace-write',taskId:'next',conversationKey:'b',deadline:Date.now()+80}),e=>e.kind==='timeout');
 assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).state,'quarantined');
});
