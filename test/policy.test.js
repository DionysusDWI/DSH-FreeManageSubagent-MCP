import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { attributionOf,installPolicyGuard } from '../dsh-plugin/policy.js';
import {resultContainsGuidance} from '../dsh-plugin/guidance-result.js';
import { tempDir } from './helpers.js';
function agent(id,cwd,patch={}) {return {id,session:{id,header:{id,cwd,...patch},mode:'danger-full-access',approval:'never'},cancel(){},async whenIdle(){}};}
function harness() {
  const listeners=new Map(), guards=[];
  const ctx={on(name,fn){const list=listeners.get(name)??[];list.push(fn);listeners.set(name,list);},tools:{guard(fn){guards.push(fn);}},sandboxPolicy:{resolve({session}){return {mode:session.mode,workspaceRoot:session.header.cwd};}},approval:{effectivePolicy(session){return session.approval;}},sessions:{async flush(){return true;}}};
  return {ctx,listeners,guards,async announce(agent){for(const fn of listeners.get('agent/created') ?? [])await fn({agent});}};
}
const setters={setSandboxMode(session,mode){session.mode=mode;},setApprovalPolicy(session,policy){session.approval=policy;}};
test('child IDs equal session IDs but attribution uses parentSession and origin',()=> {
  const child=agent('child',process.cwd(),{origin:'subagent',parentSession:'main'});
  assert.deepEqual(attributionOf({agent:child},'main'),{agentId:'child',agentRole:'subagent'});
  assert.equal(attributionOf({agent:agent('main',process.cwd())},'main').agentRole,'main');
});
test('fresh and reused high-permission main sessions are durably pinned before model entry',async t=> {
  const {dir,cleanup}=tempDir('policy-pin');t.after(cleanup);const h=harness();const main=agent('main',dir);let flushes=0;h.ctx.sessions.flush=async()=>{flushes++;return true;};
  const state=installPolicyGuard(h.ctx,{sandboxMode:'read-only',workspace:dir,conversationKey:'c',taskId:'t',dir},setters);
  await h.announce(main);assert.equal(main.session.mode,'read-only');assert.equal(main.session.approval,'ask');assert.equal(state.mainAgentId,'main');assert.equal(flushes,1);
  const proof=JSON.parse(fs.readFileSync(path.join(dir,'policy.json'),'utf8'));assert.equal(proof.verified,true);assert.equal(proof.sandboxMode,'read-only');
});
test('stricter children are preserved, wider child permissions are clamped, later expansion is denied',async t=> {
  const {dir,cleanup}=tempDir('policy-child');t.after(cleanup);const h=harness(),main=agent('main',dir);installPolicyGuard(h.ctx,{sandboxMode:'workspace-write',workspace:dir,conversationKey:'c',taskId:'t',dir},setters);await h.announce(main);
  const strict=agent('strict',dir,{origin:'subagent',parentSession:'main'});strict.session.mode='read-only';strict.session.approval='never';await h.announce(strict);assert.equal(strict.session.mode,'read-only');assert.equal(strict.session.approval,'never');
  const descendant=agent('descendant',dir,{origin:'subagent',parentSession:'strict'});await h.announce(descendant);assert.equal(descendant.session.mode,'read-only');
  const wide=agent('wide',dir,{origin:'subagent',parentSession:'main'});await h.announce(wide);assert.equal(wide.session.mode,'workspace-write');
  strict.session.mode='workspace-write';assert.match(h.guards[0]({agent:strict}),/ceiling/);
  await assert.rejects(h.listeners.get('agent/pre-step')[0]({agent:strict},async()=>({kind:'enter'})),/ceiling/);
});
test('unknown ownership, missing persistence or incompatible capabilities fail closed',async t=> {
  const {dir,cleanup}=tempDir('policy-fail');t.after(cleanup);const h=harness();installPolicyGuard(h.ctx,{sandboxMode:'read-only',workspace:dir,conversationKey:'c',taskId:'t',dir},setters);
  await assert.rejects(h.announce(agent('child',dir,{origin:'subagent',parentSession:'unknown'})),/ownership/);
  h.ctx.sessions.flush=async()=>false;await assert.rejects(h.announce(agent('main',dir)),/persistence/);
  const other=harness();delete other.ctx.tools.guard;assert.throws(()=>installPolicyGuard(other.ctx,{sandboxMode:'read-only',workspace:dir,conversationKey:'c',taskId:'t',dir},setters),/guard/);
});

test('a second plugin context cannot claim another root as main and steal the task guidance',async t=> {
 const {dir,cleanup}=tempDir('main-claim');t.after(cleanup);const config={sandboxMode:'read-only',workspace:dir,conversationKey:'c',taskId:'t',dir},a=harness(),b=harness();
 installPolicyGuard(a.ctx,config,setters);installPolicyGuard(b.ctx,config,setters);await a.announce(agent('main',dir));await assert.rejects(b.announce(agent('nested-root',dir)),/already owns the main/);
 assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'main-agent.json'),'utf8')).agentId,'main');
});

test('guidance result header containing every ID cannot acknowledge omitted/truncated message bodies',()=> {
 const messages=[{messageId:'first',seq:1,text:'same words'},{messageId:'second',seq:2,text:'same words'}];
 const event={data:{message:{content:[{type:'text',text:'Guidance receipt: first,second\n[first] same words'}]}}};
 assert.equal(resultContainsGuidance(event,messages),false);
 event.data.message.content[0].text+='\n[second] same words';assert.equal(resultContainsGuidance(event,messages),true);
});
test('guidance confirmation verifies indexed full text after restart, including UTF-8 and escaped lines',()=> {
 const full={messageId:'stable',seq:1,text:'中文😀\n"quoted" \\path'},messages=[{messageId:'stable',seq:1}],event={data:{message:{content:[{type:'text',text:'[stable] '+full.text}]}}};
 assert.equal(resultContainsGuidance(event,messages,id=>id==='stable'?full:null),true);
 assert.equal(resultContainsGuidance(event,messages,()=>({...full,text:full.text+'missing'})),false);
});
test('failed DSH tool results never confirm steering even if the full receipt is present',()=> {
 const messages=[{messageId:'stable',seq:1,text:'do it'}];assert.equal(resultContainsGuidance({data:{message:{isError:true,content:[{type:'text',text:'[stable] do it'}]}}},messages),false);
});
