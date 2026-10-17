/** Executed by installed Electron in Node mode: NO CLI, NO adapters, NO model. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL,fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';
const archive=process.argv[2],sandbox=process.argv[3],moduleBase=path.join(archive,'dsh','node_modules');
const isolatedHome=path.join(sandbox,'home');
process.env.DSH_HOME=isolatedHome;delete process.env.DSH_MCP_ALLOW_PROVISION;
registerHooks({resolve(specifier,context,nextResolve){
  if(specifier.startsWith('@deepseek-ai/')) {
    const parts=specifier.split('/'),pkg=parts.slice(0,2).join('/'),tail=parts.slice(2).join('/'),root=path.join(moduleBase,...pkg.split('/'));
    const manifest=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
    const key=tail?'./'+tail:'.',exports=manifest.exports?.[key];let target=typeof exports==='string'?exports:exports?.default ?? exports?.import;
    if(!target && !tail)target=manifest.main ?? 'index.js';
    if(target)return {url:pathToFileURL(path.join(root,target)).href,shortCircuit:true};
  }
  return nextResolve(specifier,context);
}});
const {Context}=await import('@deepseek-ai/cordis');
const {default:SessionStore}=await import('@deepseek-ai/dsh-session');
const {default:ProjectionRegistry}=await import('@deepseek-ai/dsh-session-projection');
const {default:SandboxPolicy,setSandboxMode}=await import('@deepseek-ai/dsh-sandbox-policy');
const {default:Approval,setApprovalPolicy}=await import('@deepseek-ai/dsh-user-approval');
const {default:Persistence}=await import('@deepseek-ai/dsh-session-persistence-jsonl');
const {default:FileSandbox}=await import('@deepseek-ai/dsh-fs-sandbox');
const {installPolicyGuard,attributionOf}=await import('../dsh-plugin/policy.js');
const {createChannel}=await import('../dsh-plugin/channel.js');
const {apply:applyPlugin}=await import('../dsh-plugin/index.js');
assert.equal(typeof setSandboxMode,'function');assert.equal(typeof setApprovalPolicy,'function');
const ctx=new Context();new SessionStore(ctx);new ProjectionRegistry(ctx);new SandboxPolicy(ctx,{mode:'danger-full-access',workspaceRoot:sandbox});new Approval(ctx,{policy:'never'});
await new Promise(resolve=>setTimeout(resolve,20));
const guards=[];ctx.provide('tools');ctx.provide('agents');ctx.provide('permissionPresets');ctx.set('tools',{guard(fn){guards.push(fn);},register(tool){assert.equal(typeof tool.execute,'function');}});ctx.set('agents',{});ctx.set('permissionPresets',{});
const persistence=new Persistence(ctx,{root:path.join(sandbox,'sessions'),compression:'none'});
const fileSandbox=new FileSandbox(ctx,{cwd:sandbox,diffBasisMaxBytes:1024*1024});
const file=path.join(sandbox,'inbox.json');createChannel(file,{conversationKey:'contract',taskId:'contract-task'});
const env={DSH_MCP_CHANNEL:file,DSH_MCP_TASK:'contract-task',DSH_MCP_SCOPE:'contract',DSH_MCP_WORKSPACE:sandbox,DSH_MCP_SANDBOX:'read-only'};
env.DSH_MCP_ACCEPTANCE_TASK=JSON.stringify({version:1,taskId:'contract-task',identity:'contract',caseId:'D3',correlationId:'no-model-real-API-probe',observation:{maxChildren:2,fixtureRoots:[sandbox],expectedModel:{provider:'deepseek-official',model:'deepseek-flash'}}});
applyPlugin(ctx,{env});
const session=ctx.sessions.create('contract-main',{meta:{cwd:sandbox}});
const durable=await persistence.create(session.header);
setSandboxMode(session,'danger-full-access');setApprovalPolicy(session,'never');
const main={id:session.id,session,cancel(){},async whenIdle(){}};
await ctx.serial('agent/created',{agent:main});
assert.equal(ctx.sandboxPolicy.resolve({session}).mode,'read-only');assert.equal(ctx.approval.effectivePolicy(session),'ask');
await ctx.waterfall(main,'agent/request',{agent:main},()=>Promise.resolve({provider:'deepseek-official',model:'deepseek-flash'}));
await ctx.waterfall(main,'agent/pre-step',{agent:main},()=>Promise.resolve({kind:'no-model-probe-only'}));
assert.equal(guards[0]({agent:main,name:'read',callId:'no-model-probe-tool',arguments:{file_path:'synthetic-no-model.txt'}}),undefined);
const observation=fs.readFileSync(path.join(sandbox,'acceptance-events.ndjson'),'utf8').trim().split('\n').map(JSON.parse);
assert.deepEqual(observation.map(e=>e.event),['permission-created','permission-model-request','permission-pre-model','permission-pre-tool']);
assert.ok(observation.every(e=>e.verified&&e.sandboxMode==='read-only'));

const target=await fileSandbox.resolve('read-only-denied.txt');
await assert.rejects(fileSandbox.writeText(target,'must not write',undefined,undefined,ctx.sandboxPolicy.resolve({session})),error=>error.code==='FS_SANDBOX_DENIED');
assert.equal(fs.existsSync(path.join(sandbox,'read-only-denied.txt')),false);
await durable.close();
const stored=await persistence.open(session.id,'read');const restored=await stored.read();await stored.close();
const snapshot=restored.events.map(e=>structuredClone(e));const header=structuredClone(session.header);
const resume=ctx.sessions.create('contract-resume',{seed:snapshot,meta:{cwd:sandbox}});
// Verify the actual persisted permission projection still outranks a different deployment default.
assert.equal(ctx.sandboxPolicy.resolve({session:resume}).mode,'read-only');
const restoreTarget=await fileSandbox.resolve('restored-read-only-denied.txt');await assert.rejects(fileSandbox.writeText(restoreTarget,'not allowed',undefined,undefined,ctx.sandboxPolicy.resolve({session:resume})),error=>error.code==='FS_SANDBOX_DENIED');
const child=ctx.sessions.create('contract-child',{meta:{cwd:sandbox,origin:'subagent',parentSession:session.id,depth:1}});
const childDurable=await persistence.create(child.header);
setSandboxMode(child,'workspace-write');const childAgent={id:child.id,session:child,cancel(){},async whenIdle(){}};
await ctx.serial('agent/created',{agent:childAgent});assert.equal(ctx.sandboxPolicy.resolve({session:child}).mode,'read-only');assert.equal(attributionOf({agent:childAgent},session.id).agentRole,'subagent');
assert.ok(guards.length);setSandboxMode(child,'danger-full-access');assert.match(guards[0]({agent:childAgent}),/ceiling/);
// A distinct authorized workspace-write task; never expand the read-only agent's ceiling.
const writeCtx=new Context();new SessionStore(writeCtx);new ProjectionRegistry(writeCtx);new SandboxPolicy(writeCtx,{mode:'danger-full-access',workspaceRoot:sandbox});new Approval(writeCtx,{policy:'never'});
await new Promise(resolve=>setTimeout(resolve,20));
writeCtx.provide('tools');writeCtx.provide('agents');writeCtx.provide('permissionPresets');writeCtx.set('tools',{guard(fn){assert.equal(typeof fn,'function');},register(tool){assert.equal(typeof tool.execute,'function');}});writeCtx.set('agents',{});writeCtx.set('permissionPresets',{});
const writePersistence=new Persistence(writeCtx,{root:path.join(sandbox,'write-sessions'),compression:'none'}),writeFs=new FileSandbox(writeCtx,{cwd:sandbox,diffBasisMaxBytes:1024*1024});
const writeDir=path.join(sandbox,'write-task');fs.mkdirSync(writeDir);const writeChannel=path.join(writeDir,'inbox.json');createChannel(writeChannel,{conversationKey:'contract',taskId:'write-task'});
applyPlugin(writeCtx,{env:{...env,DSH_MCP_ACCEPTANCE_TASK:'',DSH_MCP_CHANNEL:writeChannel,DSH_MCP_TASK:'write-task',DSH_MCP_SANDBOX:'workspace-write'}});
const writeSession=writeCtx.sessions.create('contract-write',{meta:{cwd:sandbox}}),writeDurable=await writePersistence.create(writeSession.header);
setSandboxMode(writeSession,'danger-full-access');setApprovalPolicy(writeSession,'never');
await writeCtx.serial('agent/created',{agent:{id:writeSession.id,session:writeSession,cancel(){},async whenIdle(){}}});
assert.equal(writeCtx.sandboxPolicy.resolve({session:writeSession}).mode,'workspace-write');assert.equal(writeCtx.approval.effectivePolicy(writeSession),'ask');
const writeTarget=await writeFs.resolve('workspace-write-allowed.txt');await writeFs.writeText(writeTarget,'actual DSH sandbox write',undefined,undefined,writeCtx.sandboxPolicy.resolve({session:writeSession}));assert.equal(fs.readFileSync(path.join(sandbox,'workspace-write-allowed.txt'),'utf8'),'actual DSH sandbox write');
await writeDurable.close();await writeCtx.emit('dispose');await childDurable.close();
// smoke4 uses the actual installed DSH lifecycle/persistence APIs, but NO model
// or shell execution. Exercise allow/deny hooks and the zero-child veto directly.
const smokeCtx=new Context();new SessionStore(smokeCtx);new ProjectionRegistry(smokeCtx);new SandboxPolicy(smokeCtx,{mode:'danger-full-access',workspaceRoot:sandbox});new Approval(smokeCtx,{policy:'never'});
await new Promise(resolve=>setTimeout(resolve,20));const smokeGuards=[];
smokeCtx.provide('tools');smokeCtx.provide('agents');smokeCtx.provide('permissionPresets');smokeCtx.set('tools',{guard(fn){smokeGuards.push(fn);},register(tool){assert.equal(typeof tool.execute,'function');}});smokeCtx.set('agents',{});smokeCtx.set('permissionPresets',{});
const smokePersistence=new Persistence(smokeCtx,{root:path.join(sandbox,'smoke4-sessions'),compression:'none'}),smokeDir=path.join(sandbox,'smoke4-task');fs.mkdirSync(smokeDir);
const smokeChannel=path.join(smokeDir,'inbox.json');createChannel(smokeChannel,{conversationKey:'contract',taskId:'smoke4-task'});
const smokeCommand='Start-Sleep -Seconds 180',smokeHash=(await import('node:crypto')).createHash('sha256').update(smokeCommand).digest('hex'),smokeFile=path.join(sandbox,'workspace-write-allowed.txt');
const smokeReceipt={version:1,suite:'smoke4',taskId:'smoke4-task',identity:'contract',caseId:'S1',correlationId:'no-model-smoke4-real-api',observation:{maxChildren:0,fixtureRoots:[sandbox],toolPolicy:{allowedTools:['read','pwsh','report'],files:[smokeFile],commandHashes:[smokeHash],commandTargets:{[smokeHash]:[]}}}};
applyPlugin(smokeCtx,{env:{...env,DSH_MCP_CHANNEL:smokeChannel,DSH_MCP_TASK:'smoke4-task',DSH_MCP_SANDBOX:'read-only',DSH_MCP_ACCEPTANCE_TASK:JSON.stringify(smokeReceipt)}});
const smokeSession=smokeCtx.sessions.create('contract-smoke4',{meta:{cwd:sandbox}}),smokeDurable=await smokePersistence.create(smokeSession.header);
let smokeCancelled=false;const smokeAgent={id:smokeSession.id,session:smokeSession,cancel(){smokeCancelled=true;},async whenIdle(){}};
await smokeCtx.serial('agent/created',{agent:smokeAgent});
assert.equal(smokeGuards[0]({agent:smokeAgent,name:'read',callId:'allow-read',arguments:{file_path:smokeFile}}),undefined);
assert.equal(smokeGuards[0]({agent:smokeAgent,name:'pwsh',callId:'allow-command',arguments:{command:smokeCommand,run_in_background:false,timeoutMs:240000}}),undefined);
assert.match(smokeGuards[0]({agent:smokeAgent,name:'read',callId:'reject-outside',arguments:{file_path:path.join(path.dirname(sandbox),'unapproved-synthetic.txt')}}),/allowlist/);
assert.equal(smokeCancelled,true);
assert.match(smokeGuards[0]({agent:smokeAgent,name:'pwsh',callId:'reject-command',arguments:{command:'unplanned synthetic command',run_in_background:false,timeoutMs:240000}}),/allowlist/);
const smokeChild=smokeCtx.sessions.create('contract-smoke4-child',{meta:{cwd:sandbox,origin:'subagent',parentSession:smokeSession.id,depth:1}}),smokeChildDurable=await smokePersistence.create(smokeChild.header);
let smokeChildCancelled=false;await assert.rejects(smokeCtx.serial('agent/created',{agent:{id:smokeChild.id,session:smokeChild,cancel(){smokeChildCancelled=true;},async whenIdle(){}}}),/unexpected subagent count/);assert.equal(smokeChildCancelled,true);
const smoke4ActionPolicy={actualDshLifecycleHooks:true,persistedReadOnly:true,exactSyntheticReadAndCommandAllowed:true,outsideReadDeniedBeforeExecution:true,unplannedCommandDeniedBeforeExecution:true,childCreationVetoBeforeModelEntry:true,actualModelCalls:0,actualToolExecutionCalls:0};
await smokeChildDurable.close();await smokeDurable.close();await smokeCtx.emit('dispose');
// Exercise the real CLI configuration preparation, without booting an app,
// mounting adapters, invoking runProfile, or running a plugin installer.
const { prepareProfile } = await import('@deepseek-ai/dsh/profile-boot');
const { resolveDshHome } = await import('@deepseek-ai/dsh-home-paths');
const { ensureBridgeProfile, inspectBridgeProfile, profileTarget, BRIDGE_PLUGIN_NAME, assertCompatibleRuntime } = await import('../lib/dsh-profile.js');
assert.equal(path.resolve(resolveDshHome()), path.resolve(isolatedHome));
const probeRuntime={...JSON.parse(process.argv[4]),home:isolatedHome,homeSource:'isolated-probe',env:{...process.env,DSH_HOME:isolatedHome}};
assertCompatibleRuntime(probeRuntime);
let mockInstalls=0;
const profileOptions={runtime:probeRuntime,env:probeRuntime.env,allowProvision:true,runDshImpl:async()=>{
  mockInstalls++;const target=profileTarget({runtime:probeRuntime,env:probeRuntime.env});
  fs.cpSync(path.join(target.dir,'vendor',BRIDGE_PLUGIN_NAME),path.join(target.dir,'node_modules',BRIDGE_PLUGIN_NAME),{recursive:true});
  return {code:0};
}};
const profileSnapshot=await ensureBridgeProfile(profileOptions),rootFile=path.join(profileSnapshot.dir,'cordis.yml'),rootBefore=fs.readFileSync(rootFile);
assert.ok(profileSnapshot.dir.startsWith(path.resolve(isolatedHome)+path.sep));assert.equal(rootBefore.length,223);
const prepareResults=[];
for(let call=1;call<=2;call++){
  const actual=prepareProfile(profileSnapshot.name);
  assert.equal(path.resolve(actual.dir),path.resolve(profileSnapshot.dir));
  assert.deepEqual(fs.readFileSync(rootFile),rootBefore);
  assert.equal(inspectBridgeProfile(profileOptions).ready,true);
  prepareResults.push({call,rootBytes:rootBefore.length,bytesUnchanged:true,ready:true});
}
assert.equal(mockInstalls,1);
const profilePreparation={profile:profileSnapshot.name,fingerprint:profileSnapshot.fingerprint,isolatedHome:true,realPrepareCalls:2,results:prepareResults,mockInstallation:true,realPluginInstallCalls:0,runProfileCalls:0,modelCalls:0};
const {verifyNativeSessions}=await import('../lib/session-verify.js');
const nativeSessionVerification=await verifyNativeSessions({runtime:probeRuntime,env:probeRuntime.env,sessionRoot:path.join(sandbox,'sessions'),sessions:[{sessionId:session.id,workspace:sandbox}]});
// Exercise the shipped credentials resolver without mounting an adapter or making a request.
const {LocalCredentialProvider}=await import('@deepseek-ai/dsh-credentials-local');
const {credentialRef}=await import('@deepseek-ai/dsh-credentials');
const {createLaunchEnvironmentSnapshot}=await import('@deepseek-ai/dsh-launch-environment');
const credentialCtx=new Context();credentialCtx.provide('launchEnvironment');
const testRef='DSH_MCP_CONTRACT_API_KEY',fixtureKey='synthetic-no-model-contract-credential';
credentialCtx.set('launchEnvironment',createLaunchEnvironmentSnapshot([{source:'process',values:{[testRef]:fixtureKey}}]));
const credentials=new LocalCredentialProvider(credentialCtx,{dshHome:isolatedHome,watch:false});
const resolvedCredential=await credentials.resolve(credentialRef(testRef));
assert.equal(resolvedCredential.value,fixtureKey);assert.equal(resolvedCredential.source,'env');
credentialCtx.set('launchEnvironment',createLaunchEnvironmentSnapshot([{source:'process',values:{}}]));
assert.equal(await credentials.resolve(credentialRef(testRef)),undefined);
const credentialResolution={realProvider:true,inheritedEnvironmentResolved:true,missingEnvironmentStaysAbsent:true,secretValuesEmitted:false,modelCalls:0};
await credentialCtx.emit('dispose');
// Optional operator probe: resolve only explicitly named environment references in
// an isolated home. Never mount an LLM adapter, use the real store, or print values.
const probeRefs=JSON.parse(process.argv[5]??'[]');
const credentialEnvironmentProbe={requested:probeRefs.length>0,isolatedHome:true,realStoreAccessed:false,refs:[],providerAuthorization:'not-tested',modelCalls:0};
if(probeRefs.length){
  const probeCtx=new Context();probeCtx.provide('launchEnvironment');
  const values={};for(const name of probeRefs)values[name]=process.env[name];
  probeCtx.set('launchEnvironment',createLaunchEnvironmentSnapshot([{source:'process',values}]));
  const provider=new LocalCredentialProvider(probeCtx,{dshHome:isolatedHome,watch:false});
  try{
    for(const name of probeRefs){
      const credential=await provider.resolve(credentialRef(name));
      const present=typeof credential?.value==='string'&&credential.value.length>0;
      if(!present||credential.source!=='env')throw new Error('Credential environment contract failed (value withheld).');
      credentialEnvironmentProbe.refs.push({name,present,source:credential.source});
    }
  }finally{await probeCtx.emit('dispose');}
}
console.log(JSON.stringify({credentialResolution,credentialEnvironmentProbe,nativeSessionVerification,persistedRestore:true,fileReadOnlyDenied:true,fileWorkspaceWriteAllowed:true,baseline:'0.2.0-rc.2',mainMode:ctx.sandboxPolicy.resolve({session}).mode,mainApproval:ctx.approval.effectivePolicy(session),childRole:'subagent',pluginLoaded:true,smoke4ActionPolicy,acceptanceObservation:{defaultOffForWriteProbe:true,realPolicyHookOrderVerified:true,events:observation.map(e=>e.event),actualModelCalls:0,actualToolExecutionCalls:0},profilePreparation,modelCalls:0}));
await ctx.emit('dispose');
