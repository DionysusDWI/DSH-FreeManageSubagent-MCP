import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main, preflightResume, createAuditedCaller, resumeWithClients, finalExit } from './resume-smoke.mjs';
import { conversationDir, taskPaths } from '../lib/paths.js';
import { canonicalWorkspace } from '../lib/workspace-lock.js';
import { tempDir } from './helpers.js';
const TOKEN='DSH-MEMORY-0123456789abcdef';
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const write=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n');};
function fixture(t){
  const temp=tempDir('resume-smoke');t.after(temp.cleanup);
  const sourceEvidence=path.join(temp.dir,'frozen'),scratch=path.join(temp.dir,'scratch'),releaseRoot=path.join(temp.dir,'candidate'),workspace=path.join(scratch,'project'),stateRoot=path.join(scratch,'shared-state'),thread='Smoke-Unit-Case',sessionId='session-frozen',firstId='t-first',ownerDir=conversationDir(thread,stateRoot),first=taskPaths(thread,firstId,stateRoot);
  fs.mkdirSync(workspace,{recursive:true});fs.mkdirSync(releaseRoot);
  write(path.join(ownerDir,'owner.json'),{version:2,conversationKey:thread});
  write(path.join(ownerDir,'tasks.json'),{version:2,conversationKey:thread,order:[firstId],sessionId,sessionWorkspace:workspace,sessionVerified:true,sessionTaskId:firstId});
  write(path.join(first.dir,'task.json'),{version:2,taskId:firstId,conversationKey:thread,state:'completed',phase:'settled',treeExited:true,sessionId,executorPid:123456});
  const policy={version:2,conversationKey:thread,taskId:firstId,sessionId,agentId:sessionId,agentRole:'main',sandboxMode:'read-only',approvalPolicy:'ask',workspace:canonicalWorkspace(workspace),verified:true};write(path.join(first.dir,'policy.json'),policy);
  write(path.join(ownerDir,'sessions','workspace',sessionId,'session.v4.jsonl.zstd'),'fixture persisted session bytes');
  write(path.join(scratch,'mcp-calls.ndjson'),JSON.stringify({phase:'request',tool:'dsh_task',thread_id:thread,arguments:{new_session:true,workspace,prompt:'Remember this token for my next message: '+TOKEN+'.'}})+'\n');
  write(path.join(sourceEvidence,'paid-summary.json'),{newSession:{passed:true,sessionVerified:true,sessionId,taskId:firstId}});
  write(path.join(sourceEvidence,'paid-preflight.json'),{home:path.join(temp.dir,'home'),defaultModel:{provider:'fixture',model:'fixture'}});
  write(path.join(sourceEvidence,'protected-files.before.json'),[]);
  write(path.join(sourceEvidence,'diagnose.after-bootstrap.json'),{home:path.join(temp.dir,'home'),launcher:{installRoot:path.join(temp.dir,'dsh-install')}});
  for(const rel of ['runtime/node.exe','bin/codex-dsh-mcp.js','lib/dsh-profile.js','native/windows-job-host.exe','scripts/check-guardian.js'])write(path.join(releaseRoot,rel),'fixture '+rel);
  const files={};for(const rel of ['runtime/node.exe','bin/codex-dsh-mcp.js','lib/dsh-profile.js','native/windows-job-host.exe','scripts/check-guardian.js']){const bytes=fs.readFileSync(path.join(releaseRoot,rel));files[rel]={bytes:bytes.length,sha256:digest(bytes)};}
  write(path.join(releaseRoot,'release-manifest.json'),{version:'0.1.1',phase:'candidate',platform:process.platform,arch:process.arch,files,fingerprint:digest(JSON.stringify(files)),guardianImageIntegrity:'unlabeled',runtimeImageIntegrity:'unlabeled',guardianLabelVerified:true,runtimeWriteVerified:true});
  function seal(){const rows=[];function scan(dir,prefix=''){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const rel=prefix+entry.name,file=path.join(dir,entry.name);if(entry.isDirectory())scan(file,rel+'/');else if(rel!=='evidence-sha256.txt')rows.push(digest(fs.readFileSync(file))+'  '+rel);}}scan(sourceEvidence);write(path.join(sourceEvidence,'evidence-sha256.txt'),rows.join('\n')+'\n');}
  function refresh(){const rows=[];function scan(dir,prefix=''){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const rel=prefix+entry.name,file=path.join(dir,entry.name);if(entry.isDirectory())scan(file,rel+'/');else{const bytes=fs.readFileSync(file);rows.push({file:rel,bytes:bytes.length,sha256:digest(bytes)});write(path.join(sourceEvidence,'paid-smoke',rel),bytes.toString('utf8'));}}}scan(scratch);write(path.join(sourceEvidence,'paid-artifacts.json'),{source:scratch,files:rows});seal();}
  refresh();const opts={sourceEvidence,releaseRoot};const alive=()=>false;
  return {...temp,sourceEvidence,scratch,releaseRoot,workspace,stateRoot,thread,sessionId,ownerDir,firstId,first,policy,opts,seal,refresh,alive,context:()=>preflightResume(opts,{alive})};
}
function completion(f,{pages,session,answer,policyEdit,recordEdit}={}){
  const ctx=f.context(),id='t-resumed',paths=taskPaths(ctx.thread,id,ctx.stateRoot),seen=[];
  write(path.join(paths.dir,'task.json'),{conversationKey:ctx.thread,taskId:id,state:'completed',phase:'settled',treeExited:true,sessionId:ctx.sessionId,adoptedSessionId:ctx.sessionId,...recordEdit});
  write(path.join(paths.dir,'policy.json'),{...f.policy,taskId:id,...policyEdit});
  const status=pages??[{task_id:id,state:'completed',session_id:session??ctx.sessionId,answer:answer??(' '+TOKEN+'\n'),cursor:1,has_more:false,reports:[{seq:1}]}];let page=0;
  const bridge={client:{request:async(request,_schema,options)=>{const {name,arguments:args,_meta}=request.params;seen.push({name,args,options,thread:_meta.threadId});
    if(name==='dsh_self_check')return _meta.threadId===ctx.thread?{content:[{type:'text',text:'profile ready: true'}]}:{isError:true,content:[{type:'text',text:'Owner refused'}]};
    if(name==='dsh_task')return {structuredContent:{task_id:id,state:'queued'}};
    if(name==='dsh_status')return {structuredContent:status[page++]};assert.fail('unexpected tool');}}};
  const other={client:{request:async()=>({isError:true,content:[{type:'text',text:'Owner refused'}]})}};
  const evidence=path.join(f.dir,'new-evidence');fs.mkdirSync(evidence);const caller=createAuditedCaller(evidence);
  return {ctx,bridge,other,caller,seen,evidence,id};
}
test('resume entry refuses missing NEW authorization before reading paths or starting any bridge',async t=>{
  t.mock.method(console,'error',()=>{});assert.equal(await main(['--source-evidence','missing','--release-root','missing','--evidence-dir','missing']),2);
  const entry=fileURLToPath(new URL('./resume-smoke.mjs',import.meta.url)),result=spawnSync(process.execPath,[entry],{encoding:'utf8',windowsHide:true});assert.equal(result.status,2);assert.match(result.stderr,/No bridge or DSH task was started/);assert.equal(result.stdout,'');
});
test('retained session preflight verifies evidence, owner, workspace and persistence without modifying state',t=>{
  const f=fixture(t),before=fs.readFileSync(path.join(f.sourceEvidence,'evidence-sha256.txt'),'utf8'),ctx=f.context();assert.equal(ctx.sessionId,f.sessionId);assert.equal(ctx.thread,f.thread);assert.equal(ctx.expectedToken,TOKEN);assert.equal(ctx.release.runtime,path.join(f.releaseRoot,'runtime','node.exe'));assert.equal(fs.readFileSync(path.join(f.sourceEvidence,'evidence-sha256.txt'),'utf8'),before);
});
test('frozen evidence, original artifact and candidate drift all refuse before submission',t=>{
  for(const kind of ['frozen','original','candidate']){const f=fixture(t);const file=kind==='frozen'?path.join(f.sourceEvidence,'paid-summary.json'):kind==='original'?path.join(f.scratch,'mcp-calls.ndjson'):path.join(f.releaseRoot,'lib','dsh-profile.js');fs.appendFileSync(file,'changed');assert.throws(()=>f.context(),/changed|drift/);}
});
test('escaped manifest paths are refused rather than read outside their root',t=>{
  const f=fixture(t),file=path.join(f.sourceEvidence,'paid-artifacts.json'),manifest=JSON.parse(fs.readFileSync(file));manifest.files.unshift({file:'../../outside',bytes:0,sha256:'x'});write(file,manifest);f.seal();assert.throws(()=>f.context(),/escaped/);
});
test('case-changed owner, unverified session, changed session ID and workspace drift refuse preflight',t=>{
  for(const edit of [{conversationKey:'smoke-unit-case'},{sessionVerified:false},{sessionId:'session-other'},{sessionWorkspace:process.cwd()}]){const f=fixture(t),file=path.join(f.ownerDir,'tasks.json');write(file,{...JSON.parse(fs.readFileSync(file)),...edit});f.refresh();assert.throws(()=>f.context(),/mismatch/);}
});
test('missing or changed persisted session is never replaced by a new session',t=>{
  const f=fixture(t),file=path.join(f.ownerDir,'sessions','workspace',f.sessionId,'session.v4.jsonl.zstd');fs.unlinkSync(file);assert.throws(()=>f.context());assert.equal(fs.existsSync(file),false);
});
test('active/interrupted tasks, execution locks, quarantine and unknown/live PIDs fail without clearing them',t=>{
  for(const kind of ['active','interrupted','lock','quarantine','live','unknown']){const f=fixture(t),file=path.join(f.first.dir,'task.json');
    if(kind==='active'||kind==='interrupted')write(file,{...JSON.parse(fs.readFileSync(file)),state:kind==='active'?'running':'interrupted'});
    if(kind==='lock')fs.mkdirSync(path.join(f.ownerDir,'.execution.lock'));
    if(kind==='quarantine')write(path.join(f.ownerDir,'.execution-quarantine.json'),{processPids:[]});
    f.refresh();const alive=kind==='live'?()=>true:kind==='unknown'?()=>null:f.alive;
    assert.throws(()=>preflightResume(f.opts,{alive}),{code:'RESUME_STATE_UNSAFE'});if(kind==='lock')assert.ok(fs.existsSync(path.join(f.ownerDir,'.execution.lock')));if(kind==='quarantine')assert.ok(fs.existsSync(path.join(f.ownerDir,'.execution-quarantine.json')));
  }
});
test('one-task gate fsyncs guard and request BEFORE dispatch, preserving cursor timeout settings',async t=>{
  const temp=tempDir('resume-budget');t.after(temp.cleanup);let calls=0;const caller=createAuditedCaller(temp.dir),bridge={client:{request:async(request,_schema,options)=>{calls++;assert.ok(fs.existsSync(path.join(temp.dir,'submit-once.json')));assert.equal(JSON.parse(fs.readFileSync(path.join(temp.dir,'mcp-calls.ndjson'),'utf8').trim()).phase,'request');assert.equal(options.timeout,45000);assert.equal(options.resetTimeoutOnProgress,false);return {content:[]};}}};
  await caller.call(bridge,'dsh_task',{new_session:false},'owner');await assert.rejects(caller.call(bridge,'dsh_task',{},'owner'),{code:'PAID_TASK_BUDGET_EXHAUSTED'});assert.equal(calls,1);assert.equal(caller.stats().actualTopLevelTaskAttempts,1);
  await assert.rejects(createAuditedCaller(temp.dir).call(bridge,'dsh_task',{},'owner'),{code:'EEXIST'});assert.equal(calls,1);
});
test('an ambiguous RPC timeout consumes its single attempt and is never automatically retried',async t=>{
  const temp=tempDir('resume-timeout');t.after(temp.cleanup);let calls=0;const caller=createAuditedCaller(temp.dir),bridge={client:{request:async()=>{calls++;throw Object.assign(new Error('response unknown'),{code:'ETIMEDOUT'});}}};
  await assert.rejects(caller.call(bridge,'dsh_task',{},'owner'),{code:'ETIMEDOUT'});await assert.rejects(caller.call(bridge,'dsh_task',{},'owner'),{code:'PAID_TASK_BUDGET_EXHAUSTED'});assert.equal(calls,1);assert.equal(caller.stats().automaticRetries,0);assert.match(fs.readFileSync(path.join(temp.dir,'mcp-calls.ndjson'),'utf8'),/"phase":"error"/);
});
test('concurrent submissions share a single one-task reservation',async t=>{
  const temp=tempDir('resume-concurrent');t.after(temp.cleanup);let calls=0;const caller=createAuditedCaller(temp.dir),bridge={client:{request:async()=>{calls++;await new Promise(r=>setTimeout(r,10));return {content:[]};}}};
  const result=await Promise.allSettled([caller.call(bridge,'dsh_task',{},'owner'),caller.call(bridge,'dsh_task',{},'owner')]);assert.equal(result.filter(x=>x.status==='fulfilled').length,1);assert.equal(calls,1);
});
test('not-ready profile and leaking owner denials fail BEFORE a paid request',async t=>{
  for(const kind of ['not-ready','leak']){const f=fixture(t),x=completion(f);if(kind==='not-ready')x.bridge.client.request=async()=>({content:[{type:'text',text:'profile ready: false'}]});else x.other.client.request=async()=>({isError:true,content:[{type:'text',text:TOKEN}]});await assert.rejects(resumeWithClients(x.ctx,x.bridge,x.other,x.caller));assert.equal(x.caller.stats().actualTopLevelTaskAttempts,0);assert.equal(fs.existsSync(path.join(x.evidence,'submit-once.json')),false);}
});
test('successful mocked continuation uses candidate identity, original session, strict marker and drains every page',async t=>{
  const f=fixture(t),id='t-resumed',x=completion(f,{pages:[{task_id:id,state:'completed',session_id:f.sessionId,answer:TOKEN,cursor:1,has_more:true,reports:[{seq:1}]},{task_id:id,state:'completed',session_id:f.sessionId,answer:' '+TOKEN+'\n',cursor:2,has_more:false,reports:[{seq:2}]}]});
  const result=await resumeWithClients(x.ctx,x.bridge,x.other,x.caller);assert.equal(result.sessionId,f.sessionId);assert.equal(result.cursor,2);assert.equal(result.reports.length,2);assert.equal(x.caller.stats().actualTopLevelTaskAttempts,1);
  const submit=x.seen.find(row=>row.name==='dsh_task');assert.equal(submit.args.new_session,false);assert.equal(submit.args.timeout_ms,600000);assert.equal(submit.args.background,true);assert.equal(submit.args.sandbox_mode,'read-only');assert.equal(submit.args.workspace,f.workspace);assert.ok(!('provider' in submit.args));assert.ok(!('model' in submit.args));assert.ok(!submit.args.prompt.includes(TOKEN));assert.equal(submit.thread,f.thread);assert.deepEqual(x.seen.filter(row=>row.name==='dsh_status').map(row=>row.args.cursor),[0,1]);assert.ok(x.seen.filter(row=>row.name==='dsh_status').every(row=>row.args.wait_ms===30000));
});
test('new session, incorrect marker or invalid durable policy/tree proof never count as success',async t=>{
  for(const edit of [{session:'session-other'},{answer:TOKEN+' extra'},{policyEdit:{sandboxMode:'danger-full-access'}},{policyEdit:{agentRole:'subagent'}},{recordEdit:{treeExited:false}},{recordEdit:{adoptedSessionId:'session-other'}}]){const f=fixture(t),x=completion(f,edit);await assert.rejects(resumeWithClients(x.ctx,x.bridge,x.other,x.caller));assert.equal(x.caller.stats().actualTopLevelTaskAttempts,1);}
});
test('failed terminal task pages are drained, then the harness stops without replay',async t=>{
  const f=fixture(t),id='t-resumed',x=completion(f,{pages:[{task_id:id,state:'failed',cursor:1,has_more:true,reports:[{seq:1}]},{task_id:id,state:'failed',cursor:2,has_more:false,reports:[{seq:2}]}]});await assert.rejects(resumeWithClients(x.ctx,x.bridge,x.other,x.caller),{code:'RESUME_TASK_FAILED'});assert.equal(x.seen.filter(row=>row.name==='dsh_status').length,2);assert.equal(x.caller.stats().actualTopLevelTaskAttempts,1);
});

test('ambiguous submission with no durable task never claims the process tree exited', async t => {
  const f = fixture(t), ctx = f.context();
  assert.equal((await finalExit(ctx, { timeoutMs: 0, alive: f.alive })).confirmed, true);
  const result = await finalExit(ctx, { attempted: true, timeoutMs: 0, alive: f.alive });
  assert.equal(result.confirmed, false); assert.equal(result.retained, true); assert.match(result.reason, /unknown/);
});
test('exit confirmation retains interrupted/unknown PID or unreadable evidence without stopping processes', async t => {
  for (const kind of ['dead', 'interrupted', 'unknown', 'invalid', 'unreadable']) {
    const f = fixture(t), ctx = f.context(), id = 't-exit', indexFile = path.join(f.ownerDir, 'tasks.json');
    write(indexFile, { ...JSON.parse(fs.readFileSync(indexFile)), order: [...ctx.originalTaskIds, id] });
    write(path.join(taskPaths(f.thread, id, f.stateRoot).dir, 'task.json'), {
      taskId: id, prompt: 'What token did I ask you to remember? Answer only the exact token. Do not run shell commands, read secrets, change files or create subagents.',
      state: kind === 'interrupted' ? 'interrupted' : 'completed', phase: 'settled', treeExited: true, processPid: kind === 'invalid' ? -1 : 123456,
    });
    if (kind === 'unreadable') write(indexFile, '{ malformed');
    const result = await finalExit(ctx, { attempted: true, timeoutMs: 0, alive: kind === 'unknown' ? () => null : f.alive });
    assert.equal(result.confirmed, kind === 'dead');
    if (kind !== 'dead') assert.equal(result.retained, true);
  }
});
