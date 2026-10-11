import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {CallToolResultSchema} from '@modelcontextprotocol/sdk/types.js';
import {initializeAcceptance,authorizeAcceptance,reserveAcceptance,createAcceptanceController,acceptanceStateRoot,stopAcceptance} from '../lib/acceptance.js';
import {sha256,canonicalJson,readJsonFile} from '../lib/joint-artifacts.js';
import {createBridgeServer} from '../lib/server.js';
import {installPolicyGuard} from '../dsh-plugin/policy.js';
import {tempDir,isolatedEnv} from './helpers.js';
const candidate={fingerprint:'a'.repeat(64),manifestSha256:'b'.repeat(64),profileFingerprint:'c'.repeat(64)};
function setup(t) {
  const temp=tempDir('acceptance');t.after(temp.cleanup);const root=temp.dir;
  const cases=[...Array.from({length:8},(_,i)=>['D'+(i+1),'dsh']),...Array.from({length:8},(_,i)=>['H'+(i+1),'host']),...Array.from({length:3},(_,i)=>['X'+(i+1),'high'])].map(([id,batch])=>({id,batch,chat:'A',identity:batch==='dsh'?'Full-Case-ID':null,args:{prompt:id,workspace:root,new_session:true,background:true,sandbox_mode:'read-only',timeout_ms:600000},expectedStates:['completed'],observation:{maxChildren:0,fixtureRoots:[root]}}));
  const plan={version:1,candidate,home:root,stateRoot:path.join(root,'state'),cases};initializeAcceptance(root,plan);
  const proof={passed:true,candidateFingerprint:candidate.fingerprint,profileFingerprint:candidate.profileFingerprint,hostRoutingVerified:true,requestTimeoutMs:45000};
  const auth=(batch='dsh',extra={})=>authorizeAcceptance(root,batch,{reference:'synthetic unit authorization; no model',expiresAt:Date.now()+60000,explicitCostAuthorization:true,identities:{A:'Host-Case-ID'},setupProof:proof,...extra});
  const request=(id='D1',batch='dsh',extra={})=>({batch,identity:batch==='dsh'?'Full-Case-ID':'Host-Case-ID',source:batch==='dsh'?'CODEX_DSH_MCP_CONVERSATION':'_meta.threadId',args:cases.find(c=>c.id===id).args,correlationId:'synthetic-correlation',candidate,processInfo:{pid:process.pid},...extra});
  return {root,plan,auth,request};
}
test('acceptance defaults off and initial planning caps do not authorize a task',t=> {
  assert.equal(createAcceptanceController({env:{},stateRoot:'unused'}),null);const h=setup(t);const zero=readJsonFile(path.join(h.root,'budgets.initial.json'));assert.deepEqual(zero.authorized,{dsh:0,host:0,high:0});assert.throws(()=>reserveAcceptance(h.root,h.request()),e=>e.code==='ACCEPTANCE_AUTHORIZATION_REQUIRED');
});
test('durable reservation consumes exactly one slot, including unknown submit outcomes',t=> {
  const h=setup(t);h.auth();const r=reserveAcceptance(h.root,h.request());assert.equal(r.caseId,'D1');assert.equal(readJsonFile(path.join(h.root,'batches/dsh/reservations/D1.json')).correlationId,'synthetic-correlation');assert.throws(()=>reserveAcceptance(h.root,h.request()),e=>e.code==='ACCEPTANCE_REPLAY_REFUSED');
});
test('case-sensitive identity, task parameters, candidate and provider drift reject before reservation',t=> {
  const h=setup(t);h.auth();for(const patch of [{identity:'full-case-id'},{args:{...h.request().args,prompt:'changed'}},{candidate:{...candidate,fingerprint:'d'.repeat(64)}},{args:{...h.request().args,provider:'override',model:'override'}}]) assert.throws(()=>reserveAcceptance(h.root,h.request('D1','dsh',patch)));assert.equal(fs.readdirSync(path.join(h.root,'batches/dsh/reservations')).length,0);
});
test('expired authorization and backwards time fail closed',t=> {
  const h=setup(t),auth=h.auth();assert.throws(()=>reserveAcceptance(h.root,h.request('D1','dsh',{now:auth.expiresAt})),e=>e.code==='ACCEPTANCE_AUTHORIZATION_EXPIRED');assert.throws(()=>reserveAcceptance(h.root,h.request('D1','dsh',{now:auth.issuedAt-1})),e=>e.code==='ACCEPTANCE_AUTHORIZATION_EXPIRED');
});
test('host and high stages require prior batch proof and separately scoped authorization',t=> {
  const h=setup(t);assert.throws(()=>h.auth('host'),e=>e.code==='ACCEPTANCE_PREVIOUS_BATCH_REQUIRED');assert.throws(()=>h.auth('high'),e=>e.code==='ACCEPTANCE_DANGER_AUTHORIZATION_REQUIRED');assert.throws(()=>authorizeAcceptance(h.root,'dsh',{reference:'not authorized'}),e=>e.code==='ACCEPTANCE_AUTHORIZATION_REQUIRED');
  h.auth('host',{previousProofs:[{batch:'dsh',passed:true,candidateFingerprint:candidate.fingerprint,casesPassed:8}]});assert.throws(()=>reserveAcceptance(h.root,h.request('H1','host',{source:'CODEX_DSH_MCP_CONVERSATION'})),e=>e.code==='ACCEPTANCE_HOST_IDENTITY_REQUIRED');
});
test('one failed case stops the entire run without reclaiming unused slots',t=> {
  const h=setup(t);h.auth();reserveAcceptance(h.root,h.request());stopAcceptance(h.root,{caseId:'D1',synthetic:true});assert.throws(()=>reserveAcceptance(h.root,h.request('D2')),e=>e.code==='ACCEPTANCE_STOPPED');assert.ok(fs.existsSync(path.join(h.root,'batches/dsh/reservations/D1.json')));
});
test('cross-process duplicate attempts reserve once, never replay after the winner exits',async t=> {
  const h=setup(t);h.auth();const entry=fileURLToPath(new URL('./fixtures/acceptance-worker.mjs',import.meta.url));
  function worker(){return new Promise((resolve,reject)=>{const c=spawn(process.execPath,[entry,h.root,JSON.stringify(h.request())],{windowsHide:true});let out='',err='';c.stdout.on('data',b=>out+=b);c.stderr.on('data',b=>err+=b);c.on('error',reject);c.on('exit',code=>{if(code)reject(new Error(err));else resolve(JSON.parse(out));});});}
  const results=await Promise.all(Array.from({length:4},worker));assert.equal(results.filter(r=>r.accepted).length,1);assert.equal(results.filter(r=>r.code==='ACCEPTANCE_REPLAY_REFUSED').length,3);assert.throws(()=>reserveAcceptance(h.root,h.request()),e=>e.code==='ACCEPTANCE_REPLAY_REFUSED');
});
test('MCP acceptance rejection never calls installer or task runner and preserves the five public schemas',async t=> {
  const temp=tempDir('acceptance-mcp');t.after(temp.cleanup);let runs=0,reservations=0;
  const controller={request:()=> 'c',response(){},describe:()=>[],health(){},reserve(){reservations++;throw Object.assign(new Error('Synthetic zero budget'),{code:'ACCEPTANCE_AUTHORIZATION_REQUIRED'});}};
  const bridge=createBridgeServer({env:isolatedEnv(temp.dir),runTaskImpl:async()=>{runs++;throw new Error('must not run');},acceptanceController:controller});
  const [a,b]=InMemoryTransport.createLinkedPair();const client=new Client({name:'unit-no-model',version:'1'});await Promise.all([bridge.server.connect(a),client.connect(b)]);t.after(async()=>{await client.close();await bridge.server.close();});
  const tools=await client.listTools();assert.equal(tools.tools.length,5);const r=await client.request({method:'tools/call',params:{name:'dsh_task',arguments:{prompt:'D1'},_meta:{threadId:'Real-Case'}}},CallToolResultSchema);assert.equal(r.isError,true);assert.equal(r.structuredContent.error.code,'ACCEPTANCE_AUTHORIZATION_REQUIRED');assert.equal(runs,0);assert.equal(reservations,1);assert.equal(bridge.scheduler.jobs.size,0);
  const golden=readJsonFile(fileURLToPath(new URL('./fixtures/public-tools-0.1.1.json',import.meta.url)));
  assert.equal(canonicalJson(tools.tools.map(({name,inputSchema,outputSchema})=>({name,inputSchema,outputSchema}))),canonicalJson(golden));
});
function policyHarness(t,enabled=true,maxChildren=2,expectedModel) {
  const temp=tempDir('acceptance-policy');t.after(temp.cleanup);const listeners=new Map(),guards=[];let flushed=0;
  const ctx={on(n,f){const a=listeners.get(n)??[];a.push(f);listeners.set(n,a);},tools:{guard(f){guards.push(f);}},sandboxPolicy:{resolve({session}){return {mode:session.mode};}},approval:{effectivePolicy:s=>s.approval},sessions:{async flush(){flushed++;return true;}}};
  const env=enabled?{CODEX_DSH_MCP_ACCEPTANCE_TASK:JSON.stringify({version:1,taskId:'t',identity:'Full-Case',caseId:'D3',correlationId:'corr',observation:{maxChildren,fixtureRoots:[temp.dir],expectedModel}})}:{};
  const state=installPolicyGuard(ctx,{dir:temp.dir,workspace:temp.dir,sandboxMode:'read-only',taskId:'t',conversationKey:'Full-Case',acceptanceEnv:env},{setSandboxMode(s,m){s.mode=m;},setApprovalPolicy(s,p){s.approval=p;}});
  const agent=(id,parent)=>({id,session:{id,header:{cwd:temp.dir,...(parent?{parentSession:parent,origin:'subagent'}:{})},mode:'danger-full-access',approval:'never'},cancel(){this.cancelled=true;},async whenIdle(){}});
  const announce=async a=>{for(const fn of listeners.get('agent/created')??[])await fn({agent:a});};
  return {dir:temp.dir,listeners,guards,state,agent,announce,flushed:()=>flushed};
}
test('opt-in policy evidence precedes actual model/tool entry after durable pinning',async t=> {
  const h=policyHarness(t),a=h.agent('main');await h.announce(a);let entered=false;await h.listeners.get('agent/pre-step')[0]({agent:a},async()=>{assert.equal(h.flushed(),1);entered=true;});assert.ok(entered);assert.equal(h.guards[0]({agent:a,name:'read',callId:'call',arguments:{file_path:'synthetic.txt'}}),undefined);
  const records=fs.readFileSync(path.join(h.dir,'acceptance-events.ndjson'),'utf8').trim().split('\n').map(JSON.parse);assert.deepEqual(records.map(r=>r.event),['permission-created','permission-pre-model','permission-pre-tool']);assert.deepEqual(records.map(r=>r.seq),[1,2,3]);assert.ok(records.every(r=>r.sandboxMode==='read-only'&&r.verified));assert.ok(!JSON.stringify(records).includes('unrelated-metadata'));
});
test('default-off observation creates no audit and preserves original policy behavior',async t=> {
  const h=policyHarness(t,false),a=h.agent('main');await h.announce(a);assert.equal(h.state.observer,null);assert.equal(fs.existsSync(path.join(h.dir,'acceptance-events.ndjson')),false);assert.equal(h.guards[0]({agent:a}),undefined);
});
test('unexpected actual descendant count cancels only this task before extra model entry',async t=> {
  const h=policyHarness(t,true,0),main=h.agent('main'),child=h.agent('child','main');await h.announce(main);await assert.rejects(h.announce(child),/unexpected subagent count/);assert.equal(main.cancelled,true);assert.equal(child.cancelled,true);assert.ok(fs.readFileSync(path.join(h.dir,'acceptance-events.ndjson'),'utf8').includes('acceptance-violation'));
});
test('observation records only action hashes and bounded synthetic policy facts, not result secrets',async t=> {
  const h=policyHarness(t),a=h.agent('main');await h.announce(a);for(const f of h.listeners.get('tools/result')??[])f({agent:a,name:'pwsh',callId:'call',arguments:{command:'not a fixture secret'}},{isError:false,value:{kind:'foreground',exitCode:1,stdout:{text:'credentials-must-not-be-saved'},sandbox:{mode:'read-only',denied:true}}});const s=fs.readFileSync(path.join(h.dir,'acceptance-events.ndjson'),'utf8');assert.ok(!s.includes('credentials-must-not-be-saved'));assert.ok(!s.includes('not a fixture secret'));assert.ok(s.includes('"denied":true'));
});

test('one stage cannot continue before the prior case has independently verified evidence',t=> {
  const h=setup(t);h.plan.cases.find(c=>c.id==='D2').predecessors=['D1'];fs.writeFileSync(path.join(h.root,'plan.json'),JSON.stringify(h.plan));h.auth();assert.throws(()=>reserveAcceptance(h.root,h.request('D2')),e=>e.code==='ACCEPTANCE_PREVIOUS_CASE_REQUIRED');
  reserveAcceptance(h.root,h.request('D1'));assert.throws(()=>reserveAcceptance(h.root,h.request('D2')),e=>e.code==='ACCEPTANCE_PREVIOUS_CASE_REQUIRED');
  fs.mkdirSync(path.join(h.root,'results'));fs.writeFileSync(path.join(h.root,'results/D1.json'),JSON.stringify({caseId:'D1',passed:true,candidateFingerprint:candidate.fingerprint,evidenceLevel:'synthetic unit primitive only'}));assert.equal(reserveAcceptance(h.root,h.request('D2')).caseId,'D2');
});
test('paired host attempts need a truly active peer, not a reservation or queued submission',t=> {
  const h=setup(t);h.plan.cases.find(c=>c.id==='H2').predecessors=['active:H1'];fs.writeFileSync(path.join(h.root,'plan.json'),JSON.stringify(h.plan));h.auth('host',{previousProofs:[{batch:'dsh',passed:true,candidateFingerprint:candidate.fingerprint,casesPassed:8}]});assert.throws(()=>reserveAcceptance(h.root,h.request('H2','host')),e=>e.code==='ACCEPTANCE_PREVIOUS_CASE_REQUIRED');
  reserveAcceptance(h.root,h.request('H1','host'));assert.throws(()=>reserveAcceptance(h.root,h.request('H2','host')),e=>e.code==='ACCEPTANCE_PREVIOUS_CASE_REQUIRED');
});
test('observed resolved model routing cannot log secrets or authorize a fallback selection',async t=> {
  const h=policyHarness(t,true,2,{provider:'deepseek-official',model:'deepseek-flash'}),main=h.agent('main');await h.announce(main);const hook=h.listeners.get('agent/request')[0];const secret='must-not-log-model-key';await assert.rejects(hook({agent:main},async()=>({provider:secret,model:secret,apiKey:secret})),/default model selection/);const s=fs.readFileSync(path.join(h.dir,'acceptance-events.ndjson'),'utf8');assert.ok(s.includes('permission-model-request'));assert.ok(!s.includes(secret));
});
test('an aborted MCP acceptance never reaches a budget reservation or runner',async t=> {
  const temp=tempDir('acceptance-aborted');t.after(temp.cleanup);let reserves=0,runs=0;const bridge=createBridgeServer({env:isolatedEnv(temp.dir),runTaskImpl:async()=>{runs++;},acceptanceController:{request:()=> 'c',response(){},describe:()=>[],health(){},reserve(){reserves++;}}});const handler=bridge.server._registeredTools.dsh_task.handler;
  const control=new AbortController();control.abort();const result=await handler({prompt:'synthetic'}, {signal:control.signal,_meta:{threadId:'Unit-Aborted'}});assert.equal(result.isError,true);assert.equal(reserves,0);assert.equal(runs,0);await bridge.server.close();
});

 test('an authorized identity parameter refusal stops the batch without allowing a corrected replay',t=> {
  const h=setup(t);h.auth();const controlFile=path.join(h.root,'control.json');
  fs.writeFileSync(controlFile,JSON.stringify({version:1,enabled:true,root:h.root,batch:'dsh',candidate,stateRoot:h.plan.stateRoot,home:h.plan.home}));
  const controller=createAcceptanceController({env:{CODEX_DSH_MCP_ACCEPTANCE_CONTROL:controlFile},stateRoot:h.plan.stateRoot});
  const identity={key:'Full-Case-ID',source:'CODEX_DSH_MCP_CONVERSATION',threadId:null,sessionId:null};
  const args={...h.request().args,prompt:'parameter drift before any runner/model'};
  const correlation=controller.request('dsh_task',args,{requestId:'synthetic-drift'},identity,{name:'unit-test',version:'0'});
  controller.response(correlation,'dsh_task',{isError:true,content:[{type:'text',text:'parameters drift'}],structuredContent:{error:{code:'ACCEPTANCE_PARAMETERS_DRIFT'}}});
  assert.equal(readJsonFile(path.join(h.root,'STOP.json')).reason.parametersMatched,false);
  assert.equal(fs.readdirSync(path.join(h.root,'batches/dsh/reservations')).length,0);
  assert.throws(()=>reserveAcceptance(h.root,h.request()),e=>e.code==='ACCEPTANCE_STOPPED');
});

test('private candidate/home/state drift fails before context recovery, audit or task startup',t=> {
  const h=setup(t),file=path.join(h.root,'binding-control.json');
  const control={version:1,enabled:true,root:h.root,batch:'dsh',candidate,stateRoot:h.plan.stateRoot,home:h.plan.home};
  const env={...isolatedEnv(h.root),CODEX_DSH_MCP_ACCEPTANCE_CONTROL:file};
  for(const patch of [{stateRoot:path.join(h.root,'drift-state')},{home:path.join(h.root,'drift-home')},{candidate:{...candidate,fingerprint:'d'.repeat(64)}}]) {
    fs.writeFileSync(file,JSON.stringify({...control,...patch}));
    assert.throws(()=>acceptanceStateRoot(env,'fallback'),e=>e.code==='ACCEPTANCE_BINDING_FAILED');
    assert.throws(()=>createBridgeServer({env}),e=>e.code==='ACCEPTANCE_BINDING_FAILED');
    assert.equal(fs.existsSync(path.join(h.root,'audit')),false);
    assert.equal(fs.existsSync(path.join(h.root,'drift-state')),false);
  }
  fs.writeFileSync(file,JSON.stringify(control));
  assert.throws(()=>createAcceptanceController({env,stateRoot:path.join(h.root,'drift-state')}),e=>e.code==='ACCEPTANCE_BINDING_FAILED');
  fs.writeFileSync(file,JSON.stringify({...control,enabled:false,stateRoot:'invalid'}));
  assert.equal(acceptanceStateRoot(env,'fallback'),'fallback');
});
