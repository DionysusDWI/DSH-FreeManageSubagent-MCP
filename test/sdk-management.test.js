import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {normalizeTaskConfiguration as config,REASONING_EFFORTS} from '../lib/task-config.js';
import {buildOverlayPatches} from '../lib/overlay.js';
import {SdkRpcPeer,SdkObservation} from '../lib/sdk-rpc.js';
import {GuardianInput,MAX_INPUT_BYTES,INPUT_CHUNK_BYTES} from '../lib/guardian-protocol.js';
import {runTask} from '../lib/task-runner.js';
import {taskPaths} from '../lib/paths.js';
import {syntheticSupervise} from './fixtures/synthetic-sdk.mjs';
import {tempDir,isolatedEnv} from './helpers.js';
test('task defaults do not inherit a caller full-access declaration implicitly',()=>{
  const value=config({upstream_permission_mode:'full-access'});
  assert.deepEqual(value.resolved,{provider:'deepseek-official',model:'deepseek-flash',reasoningEffort:null,permissionMode:'workspace-write',questionPolicy:'pause',questionTimeoutSeconds:null});
  assert.equal(value.requested.upstreamDeclarationVerified,false);
});
test('three explicit presets and inherit mappings are independent of caller declarations',()=>{
  for(const mode of ['read-only','workspace-write','auto'])assert.equal(config({permission_mode:mode,upstream_permission_mode:'read-only'}).resolved.permissionMode,mode);
  for(const [upstream,expected] of Object.entries({'read-only':'read-only','workspace-write':'workspace-write','full-access':'auto'})){
    const value=config({permission_mode:'inherit',upstream_permission_mode:upstream});assert.equal(value.resolved.permissionMode,expected);assert.equal(value.requested.permissionMode,'inherit');
  }
  assert.throws(()=>config({permission_mode:'inherit'}),/requires/);
});
test('legacy direct Full access and conflicting fields reject rather than silently selecting Auto',()=>{
  for(const value of ['danger-full-access','full-access','full'])assert.throws(()=>config({sandbox_mode:value}),/Direct Full access/);
  for(const value of ['danger-full-access','full-access'])assert.throws(()=>config({permission_mode:value}),/permission_mode/);
  assert.throws(()=>config({sandbox_mode:'read-only',permission_mode:'auto'}),/mutually exclusive/);
  assert.equal(config({sandbox_mode:'read-only'}).resolved.permissionMode,'read-only');
});
test('reasoning and questionnaires are strict; whole native config rows preserve route',()=>{
  for(const reasoning_effort of REASONING_EFFORTS){
    const configuration=config({reasoning_effort}),rows=buildOverlayPatches({workspace:process.cwd(),storageRoot:'storage',sessionRoot:'sessions',configuration});
    assert.deepEqual(rows.find(r=>r.id==='agent-default-model').config,{provider:'deepseek-official',model:'deepseek-flash',reasoningEffort:reasoning_effort});
  }
  for(const reasoning_effort of ['log','medium','HIGH'])assert.throws(()=>config({reasoning_effort}),/off, low, high or max/);
  assert.throws(()=>config({provider:'custom'}),/together/);
  assert.equal(config({question_policy:'continue'}).resolved.questionTimeoutSeconds,120);
  assert.equal(config({question_policy:'continue',question_timeout_seconds:7}).resolved.questionTimeoutSeconds,7);
  for(const args of [{question_timeout_seconds:1},{question_policy:'continue',question_timeout_seconds:-1},{question_policy:'continue',question_timeout_seconds:0}])assert.throws(()=>config(args));
});
test('guardian stdin is credit-bounded, byte-exact and cannot mistake a pipe ACK for native application',async()=>{
  const frames=[],input=new GuardianInput(frame=>frames.push(frame)),data=Buffer.from('中文🙂'.repeat(16000));let written=false;
  const write=input.write(data).then(()=>written=true);const end=input.end();
  assert.equal(frames.length,1);assert.equal(frames[0].type,'stdin');assert.equal(Buffer.from(frames[0].data,'base64').length,INPUT_CHUNK_BYTES);assert.equal(written,false);
  const out=[];while(input.queue.length){const frame=frames.at(-1);if(frame.type==='stdin')out.push(Buffer.from(frame.data,'base64'));input.acknowledge({id:frame.id});}
  await Promise.all([write,end]);assert.deepEqual(Buffer.concat(out),data);assert.equal(input.bytes,0);assert.equal(frames.at(-1).type,'stdin-end');
  await assert.rejects(input.write('late'),/closed/);assert.throws(()=>input.acknowledge({id:1}),{code:'GUARDIAN_PROTOCOL_MISMATCH'});
});
test('guardian blocked input has a hard queue limit and cancellation rejects every pending write',async()=>{
  const input=new GuardianInput(()=>{});const pending=input.write(Buffer.alloc(MAX_INPUT_BYTES));pending.catch(()=>{});
  await assert.rejects(input.write('excess'),{code:'GUARDIAN_INPUT_LIMIT'});assert.equal(input.bytes,MAX_INPUT_BYTES);
  const eof=input.end();eof.catch(()=>{});input.fail(new Error('cancelled pipe'));await assert.rejects(pending,/cancelled pipe/);await assert.rejects(eof,/cancelled pipe/);assert.equal(input.bytes,0);
});
test('SDK NDJSON handles fragmented UTF-8 and correlates responses without spawning',async()=>{
  const sent=[],events=[],peer=new SdkRpcPeer({onNotification:(...args)=>events.push(args)});peer.attach({write:async bytes=>sent.push(JSON.parse(bytes))});
  const pending=peer.request('initialize',{});const bytes=Buffer.from(JSON.stringify({jsonrpc:'2.0',method:'event',params:{text:'中文🙂'}})+'\n'+JSON.stringify({jsonrpc:'2.0',id:1,result:{ok:true}})+'\n');
  for(const byte of bytes)peer.write(Buffer.from([byte]));assert.deepEqual(await pending,{ok:true});assert.equal(sent[0].method,'initialize');assert.equal(events[0][1].text,'中文🙂');peer.finish();peer.close();
});
test('invalid SDK responses retain rejectable promises; malformed frames and EOF fail closed',async()=>{
  for(const frame of [{jsonrpc:'2.0',id:1},{jsonrpc:'2.0',id:1,error:null}]) {
    const peer=new SdkRpcPeer();peer.attach({write:async()=>{}});const pending=peer.request('initialize',{});pending.catch(()=>{});
    assert.throws(()=>peer.write(Buffer.from(JSON.stringify(frame)+'\n')),/response shape/);assert.equal(peer.pending.size,1);peer.close(new Error('bad response'));await assert.rejects(pending,/bad response/);
  }
  const truncated=new SdkRpcPeer();truncated.write(Buffer.from('{'));assert.throws(()=>truncated.finish(),/Truncated/);truncated.close();
  const small=new SdkRpcPeer({maxFrameBytes:8});assert.throws(()=>small.write(Buffer.from('123456789')),/safety limit/);small.close();
});
test('SDK idle, exit zero and even an old end event cannot prove a successful native round',()=>{
  const observer=new SdkObservation('s'),proof={admissionClosed:true,persisted:true,terminal:{seq:2,reason:{kind:'completed'}}};
  assert.equal(observer.outcome({exitCode:0,proof}).state,'failed');
  observer.notification('session.event',{sessionId:'s',event:{seq:2,type:'turn/end',data:{reason:{kind:'completed'}}}});
  assert.equal(observer.outcome({exitCode:0,proof}).state,'failed');
  observer.notification('session.event',{sessionId:'s',event:{seq:3,type:'turn/start',data:{}}});observer.notification('session.event',{sessionId:'s',event:{seq:4,type:'turn/end',data:{reason:{kind:'completed'}}}});
  assert.equal(observer.outcome({exitCode:0,proof}).state,'failed');proof.terminal.seq=4;assert.equal(observer.outcome({exitCode:0,proof}).state,'completed');
});
test('runner bounds stalled SDK initialization with the total deadline and proves tree exit',async t=>{
  const temp=tempDir('sdk-init-deadline');t.after(temp.cleanup);const paths=taskPaths('sdk','t',path.join(temp.dir,'state'));let phase;
  const value=await runTask({conversationKey:'sdk',taskId:'t',paths,workspace:temp.dir,prompt:'no model',timeoutMs:250,
    runtime:{launcher:{command:process.execPath,prefixArgs:[],launcherScript:'fixture'},home:path.join(temp.dir,'home'),version:'0.2.1-rc.2',env:isolatedEnv(temp.dir)},
    ensureProfileImpl:async()=>({name:'fixture',fingerprint:'fixture'}),superviseImpl:syntheticSupervise({stall:'initialize'}),onPhase:value=>phase=value});
  assert.equal(value.state,'timeout');assert.equal(value.treeExited,true);assert.equal(value.sessionId,null);assert.equal(phase,'initializing-sdk');assert.ok(fs.existsSync(paths.reportLog));
});

test('real guardian duplex input cancellation remains responsive while child stdin is blocked', {timeout:30000},async t=>{
  const {supervise}=await import('../lib/supervisor.js'),temp=tempDir('duplex-blocked');t.after(temp.cleanup);
  const controller=new AbortController();let input,accepted=false,timer;
  try {
    const exit=await supervise({command:process.execPath,args:['-e','process.stdin.pause();setInterval(()=>{},1000)'],cwd:temp.dir,stateDir:temp.dir,env:process.env,signal:controller.signal,duplex:true,graceMs:30,
      onTransport:transport=>{input=transport.write(Buffer.alloc(MAX_INPUT_BYTES)).then(()=>accepted=true);input.catch(()=>{});timer=setTimeout(()=>controller.abort({kind:'cancelled',message:'blocked stdin fixture'}),60);}});
    assert.equal(exit.treeExited,true);assert.equal(accepted,false);await assert.rejects(input,/exited|closed|pipe|stdin|stopped/i);
  }finally{clearTimeout(timer);controller.abort();}
});
