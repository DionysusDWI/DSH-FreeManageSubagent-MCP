/** Private, opt-in cross-process acceptance budget. Not a public MCP surface. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {withFileLockSync,processAlive} from './file-lock.js';
import {canonicalJson,sha256,shaFile,readJsonFile,writeExclusiveJson,appendDurableJson,verifyCandidate} from './joint-artifacts.js';
import {repoRoot} from './paths.js';
import {resolveRuntime,ensureBridgeProfile} from './dsh-profile.js';
import {suiteOf,acceptanceCaps,validateAcceptancePlan} from './acceptance-suite.js';
export {suiteOf,acceptanceCaps} from './acceptance-suite.js';
export const ACCEPTANCE_CAPS=Object.freeze({dsh:8,host:8,high:3});
export const CONTROL_ENV='CODEX_DSH_MCP_ACCEPTANCE_CONTROL';
const fail=(code,message)=>Object.assign(new Error(message),{code});
const batchPath=(root,batch)=>{
  if(!Object.hasOwn(ACCEPTANCE_CAPS,batch)) throw fail('ACCEPTANCE_BATCH_INVALID','Unknown acceptance batch.');
  return path.join(root,'batches',batch);
};
export function initializeAcceptance(root,plan) {
  root=path.resolve(root);
  const {suite,caps}=validateAcceptancePlan(plan);
  writeExclusiveJson(path.join(root,'plan.json'),plan);
  writeExclusiveJson(path.join(root,'budgets.initial.json'),{version:1,at:Date.now(),suite,caps,authorized:{dsh:0,host:0,high:0},attempts:0,qualification:'Planning caps only; no paid or bootstrap authorization.'});
  for(const batch of Object.keys(caps)) fs.mkdirSync(path.join(batchPath(root,batch),'reservations'),{recursive:true});
  return {root,planSha256:shaFile(path.join(root,'plan.json'))};
}
export function stopAcceptance(root,reason) {
  const file=path.join(root,'STOP.json');
  try { writeExclusiveJson(file,{version:1,at:Date.now(),reason}); }
  catch(error) { if(error.code!=='EEXIST') throw error; }
}
export function authorizeAcceptance(root,batch,{reference,expiresAt,identities,explicitCostAuthorization=false,explicitDangerAuthorization=false,setupProof,previousProofs=[]}={}) {
  if(!explicitCostAuthorization||typeof reference!=='string'||!reference.trim()) throw fail('ACCEPTANCE_AUTHORIZATION_REQUIRED','A new, explicit human model-cost authorization reference is required.');
  if(batch==='high'&&!explicitDangerAuthorization) throw fail('ACCEPTANCE_DANGER_AUTHORIZATION_REQUIRED','Full access is not restricted by the fixture. Separate danger-full-access authorization is required.');
  if(!Number.isSafeInteger(expiresAt)||expiresAt<=Date.now()||expiresAt>Date.now()+12*3600000) throw new Error('Authorization expiry must be in the next 12 hours.');
  return withFileLockSync(path.join(root,'.budget.lock'),()=> {
    if(fs.existsSync(path.join(root,'STOP.json'))) throw fail('ACCEPTANCE_STOPPED','This acceptance run has stopped; no remaining slot may be reused.');
    const plan=readJsonFile(path.join(root,'plan.json')),cases=plan.cases.filter(c=>c.batch===batch);
    batchPath(root,batch);
    const {suite,caps}=validateAcceptancePlan(plan),cap=caps[batch];
    if(!cap) throw fail('ACCEPTANCE_BATCH_INVALID','This suite does not authorize this batch.');
    if(suiteOf(setupProof)!==suite) throw fail('ACCEPTANCE_BINDING_FAILED','Setup proof belongs to a different suite.');
    if(!setupProof?.passed||setupProof.candidateFingerprint!==plan.candidate.fingerprint||setupProof.profileFingerprint!==plan.candidate.profileFingerprint||setupProof.hostRoutingVerified!==true||setupProof.requestTimeoutMs<45000) throw fail('ACCEPTANCE_SETUP_REQUIRED','Verified profile, candidate, guardian and real-host routing preflight are required.');
    const required=suite==='smoke4'?[]:batch==='host'?['dsh']:batch==='high'?['dsh','host']:[];
    for(const prior of required) if(!previousProofs.some(p=>suiteOf(p)==='full'&&p.batch===prior&&p.passed===true&&p.candidateFingerprint===plan.candidate.fingerprint&&p.casesPassed===caps[prior])) throw fail('ACCEPTANCE_PREVIOUS_BATCH_REQUIRED','The prior acceptance batch is not verified.');
    const grants=cases.map(c=>{
      const identity=c.identity ?? identities?.[c.chat];
      if(typeof identity!=='string'||!identity.trim()) throw new Error('Exact, case-sensitive identity is missing for '+c.id);
      return {caseId:c.id,identity,paramsHash:sha256(canonicalJson(c.args)),expectedStates:c.expectedStates};
    });
    const record={version:1,suite,batch,cap,reference,issuedAt:Date.now(),expiresAt,planSha256:shaFile(path.join(root,'plan.json')),candidate:plan.candidate,stateRoot:plan.stateRoot,home:plan.home,
      explicitCostAuthorization:true,explicitDangerAuthorization:batch==='high',setupProofSha256:sha256(canonicalJson(setupProof)),previousProofsSha256:sha256(canonicalJson(previousProofs)),grants};
    writeExclusiveJson(path.join(batchPath(root,batch),'authorization.json'),record);
    return record;
  });
}
export function reserveAcceptance(root,{batch,identity,source,args,correlationId,candidate,processInfo,now=Date.now()}) {
  return withFileLockSync(path.join(root,'.budget.lock'),()=> {
    const base=batchPath(root,batch),authFile=path.join(base,'authorization.json');
    if(fs.existsSync(path.join(root,'STOP.json'))) throw fail('ACCEPTANCE_STOPPED','This batch or an earlier batch failed; no further task will be accepted.');
    if(!fs.existsSync(authFile)) throw fail('ACCEPTANCE_AUTHORIZATION_REQUIRED','The acceptance budget is zero; obtain a new stage-specific human authorization.');
    const planFile=path.join(root,'plan.json'),plan=readJsonFile(planFile),auth=readJsonFile(authFile);
    const {suite,caps}=validateAcceptancePlan(plan);
    if(!caps[batch]) throw fail('ACCEPTANCE_BATCH_INVALID','This suite does not authorize this batch.');
    if(auth.version!==1||suiteOf(auth)!==suite||auth.batch!==batch||auth.cap!==caps[batch]||auth.explicitCostAuthorization!==true||batch==='high'&&auth.explicitDangerAuthorization!==true||auth.planSha256!==shaFile(planFile)||canonicalJson(auth.candidate)!==canonicalJson(plan.candidate)||canonicalJson(candidate)!==canonicalJson(plan.candidate)) throw fail('ACCEPTANCE_BINDING_FAILED','Acceptance authorization/candidate binding drift.');
    if(!Number.isSafeInteger(auth.expiresAt)||now>=auth.expiresAt||now<auth.issuedAt) throw fail('ACCEPTANCE_AUTHORIZATION_EXPIRED','Acceptance authorization expired or its clock moved backwards.');
    if(suite==='smoke4'&&fs.readdirSync(path.join(base,'reservations')).filter(n=>n.endsWith('.json')).length>=4) throw fail('ACCEPTANCE_BUDGET_EXHAUSTED','The four top-level attempt budget is exhausted; continuation/unknown outcomes are not refunded.');
    if((batch==='host'||batch==='high')&&source!=='_meta.threadId') throw fail('ACCEPTANCE_HOST_IDENTITY_REQUIRED','Real host acceptance requires threadId from the actual host call, not a fixed environment identity.');
    if(args.provider||args.model) throw fail('ACCEPTANCE_PARAMETERS_DRIFT','Provider/model overrides are forbidden for acceptance tasks.');
    const paramsHash=sha256(canonicalJson(args)),grants=auth.grants.filter(g=>g.identity===identity&&g.paramsHash===paramsHash);
    if(grants.length!==1) throw fail('ACCEPTANCE_PARAMETERS_DRIFT','Request does not match one authorized case and its full case-sensitive identity.');
    const grant=grants[0],planned=plan.cases.find(c=>c.id===grant.caseId&&c.batch===batch);
    if(!planned||sha256(canonicalJson(planned.args))!==paramsHash||canonicalJson(planned.expectedStates)!==canonicalJson(grant.expectedStates)) throw fail('ACCEPTANCE_BINDING_FAILED','Case parameters or expected outcome drift.');
    for(const dependency of planned.predecessors ?? []) {
      const [kind,id]=dependency.startsWith('active:')?['active',dependency.slice(7)]:['passed',dependency];
      const prior=plan.cases.find(c=>c.id===id);
      if(!prior)throw fail('ACCEPTANCE_PREVIOUS_CASE_REQUIRED','Missing predecessor case.');
      if(kind==='active') {
        const dir=path.join(root,'audit'),records=fs.existsSync(dir)?fs.readdirSync(dir).filter(n=>n.endsWith('.ndjson')).flatMap(n=>{const text=fs.readFileSync(path.join(dir,n),'utf8');return text.split('\n').slice(0,-1).filter(Boolean).map(JSON.parse);}):[];
        const live=records.findLast(r=>r.event==='task-lifecycle'&&r.caseId===id&&r.patch?.processStartedAt);
        if(!live||records.some(r=>r.caseId===id&&r.phase==='settled')||processAlive(live.patch.processPid)!==true)throw fail('ACCEPTANCE_PREVIOUS_CASE_REQUIRED','The required concurrent peer is not actually active.');
        if(suite==='smoke4') {
          const accepted=records.find(r=>r.caseId===id&&r.event==='task-lifecycle'&&r.phase==='accepted'),file=accepted?.paths?.dir&&path.join(accepted.paths.dir,'acceptance-events.ndjson');
          const events=file&&fs.existsSync(file)?fs.readFileSync(file,'utf8').split('\n').filter(Boolean).map(JSON.parse):[];
          const initialHash=sha256(plan.commands.initial),tool=events.find(e=>e.event==='permission-pre-tool'&&e.agentRole==='main'&&e.toolName==='pwsh'&&e.commandHash===initialHash&&e.background===false);
          if(!tool||!events.some(e=>e.event==='tool-result'&&e.callId===tool.callId&&e.agentId===tool.agentId&&!e.isError&&e.shell?.exitCode===0&&!e.shell?.timedOut&&e.ts-tool.ts>=44000))throw fail('ACCEPTANCE_PREVIOUS_CASE_REQUIRED','S1 must prove its real successful 45-second tool wait, not merely a started preparation process.');
        }
      } else {
        const file=path.join(root,'results',id+'.json');
        if(!fs.existsSync(file))throw fail('ACCEPTANCE_PREVIOUS_CASE_REQUIRED','Verify the prior case before accepting another attempt.');
        const proof=readJsonFile(file);if(suiteOf(proof)!==suite||proof.passed!==true||proof.caseId!==id||proof.candidateFingerprint!==candidate.fingerprint)throw fail('ACCEPTANCE_PREVIOUS_CASE_REQUIRED','The previous case failed or its evidence is incomplete.');
      }
    }
    const files=fs.readdirSync(path.join(base,'reservations')).filter(n=>n.endsWith('.json'));
    if(files.includes(grant.caseId+'.json')) throw fail('ACCEPTANCE_REPLAY_REFUSED','This case already reserved its only attempt, including ambiguous or failed submissions.');
    if(files.length>=auth.cap) throw fail('ACCEPTANCE_BUDGET_EXHAUSTED','The stage top-level attempt budget is exhausted.');
    const receipt={version:1,suite,batch,caseId:grant.caseId,identity,source,correlationId,paramsHash,expectedStates:grant.expectedStates,candidate,at:now,processInfo,observation:planned.observation ?? {maxChildren:0,fixtureRoots:[]}};
    // Durable BEFORE scheduler.submit. A crash consumes this slot; never remove it.
    writeExclusiveJson(path.join(base,'reservations',grant.caseId+'.json'),receipt);
    return receipt;
  });
}
function validateControlBinding(control) {
  if(control.version!==1||!Object.hasOwn(ACCEPTANCE_CAPS,control.batch)||!control.candidate||
    !['root','home','stateRoot'].every(k=>typeof control[k]==='string'&&path.isAbsolute(control[k])))
    throw fail('ACCEPTANCE_BINDING_FAILED','Invalid private acceptance control binding.');
  const root=fs.realpathSync.native(control.root),plan=readJsonFile(path.join(root,'plan.json'));
  validateAcceptancePlan(plan);
  if(suiteOf(control)!==suiteOf(plan)||!acceptanceCaps(plan)[control.batch]) throw fail('ACCEPTANCE_BINDING_FAILED','Control suite/batch differs from the immutable plan.');
  if(plan.version!==1||canonicalJson(control.candidate)!==canonicalJson(plan.candidate)||
    path.resolve(control.home)!==path.resolve(plan.home)||path.resolve(control.stateRoot)!==path.resolve(plan.stateRoot)||Boolean(control.hostPreflight)!==Boolean(plan.hostPreflight))
    throw fail('ACCEPTANCE_BINDING_FAILED','Private acceptance candidate, DSH_HOME or state root differs from the immutable plan; do not modify/copy old state.');
  return root;
}
export function acceptanceStateRoot(env,fallback) {
  const file=env[CONTROL_ENV];if(!file||!fs.existsSync(file)) return fallback;
  const control=readJsonFile(file);if(control.enabled!==true)return fallback;
  validateControlBinding(control);
  return control.stateRoot;
}
export function createAcceptanceController({env,stateRoot}) {
  const file=env[CONTROL_ENV];
  if(!file||!fs.existsSync(file)) return null; // Default off; no acceptance files in shipped candidates.
  const control=readJsonFile(file);
  if(control.enabled!==true) return null;
  const root=validateControlBinding(control);
  if(path.resolve(stateRoot)!==path.resolve(control.stateRoot))throw fail('ACCEPTANCE_BINDING_FAILED','Actual acceptance state root differs from the immutable plan.');
  const instanceId=crypto.randomUUID(),auditFile=path.join(root,'audit',instanceId+'.ndjson'),pendingRequests=new Map();
  const audit=record=>withFileLockSync(auditFile+'.lock',()=>appendDurableJson(auditFile,{version:1,at:Date.now(),instanceId,pid:process.pid,...record}));
  const runtimeInfo={runtime:process.execPath,bridgeRoot:repoRoot(),pluginRoot:env.CODEX_DSH_MCP_PLUGIN_ROOT ?? null,pluginData:env.CODEX_DSH_MCP_PLUGIN_DATA ?? null,stateRoot:path.resolve(stateRoot),cwd:process.cwd(),multiplex:env.CODEX_DSH_MCP_MULTIPLEX==='1'};
  audit({event:'instance-start',suite:suiteOf(control),batch:control.batch,runtimeInfo,candidate:control.candidate,evidenceLevel:control.batch==='dsh'?'real-dsh-script-identity':'host-origin-requires-user-ui-verification'});
  return {
    root,control,instanceId,
    describe:()=>['internal acceptance: enabled (zero budget unless explicitly authorized)','acceptance suite: '+suiteOf(control),'acceptance batch: '+control.batch,'acceptance instance: '+instanceId,'acceptance audit: '+auditFile],
    request(name,args,extra,identity,client) {
      const correlationId=crypto.randomUUID();
      pendingRequests.set(correlationId,{name,identity:identity.key,paramsHash:sha256(canonicalJson(args))});
      audit({event:'request',correlationId,tool:name,requestId:typeof extra?.requestId==='string'||typeof extra?.requestId==='number'?extra.requestId:null,
        identity:{key:identity.key,source:identity.source,threadId:identity.threadId,sessionId:identity.sessionId},paramsHash:sha256(canonicalJson(args)),taskId:name!=='dsh_task'?args.task_id ?? null:null,cursor:name==='dsh_status'?args.cursor ?? 0:null,waitMs:name==='dsh_status'?args.wait_ms ?? 0:null,limit:name==='dsh_status'?args.limit ?? 50:null,
        client:client?{name:client.name,version:client.version}:null,runtimeInfo});
      return correlationId;
    },
    response(correlationId,name,result) {
      const request=pendingRequests.get(correlationId);pendingRequests.delete(correlationId);
      if(name==='dsh_task'&&result?.isError){
        const file=path.join(batchPath(root,control.batch),'authorization.json');
        const auth=fs.existsSync(file)?readJsonFile(file):null,ownedGrants=auth?.grants?.filter(g=>g.identity===request?.identity) ?? [];
        const grant=ownedGrants.find(g=>g.paramsHash===request?.paramsHash);
        // A drifted request by an authorized identity is a failed case attempt,
        // not permission to correct parameters and spend another slot.
        if(ownedGrants.length)stopAcceptance(root,{caseId:grant?.caseId ?? null,kind:'authorized-request-refused-or-ambiguous',parametersMatched:!!grant});
      }
      const view=result?.structuredContent, serialized=JSON.stringify(result),plan=readJsonFile(path.join(root,'plan.json'));
      const mentionedMarkers=plan.cases.filter(c=>typeof c.expectedMarker==='string'&&c.expectedMarker.startsWith('JOINT-')&&serialized.includes(c.expectedMarker)).map(c=>c.id);
      audit({event:'response',correlationId,tool:name,isError:result?.isError===true,taskId:view?.task_id ?? null,sessionId:view?.session_id ?? null,state:view?.state ?? null,cursor:view?.cursor ?? null,hasMore:view?.has_more ?? null,messageId:view?.message_id ?? null,responseBytes:Buffer.byteLength(JSON.stringify(result)),resultHash:sha256(canonicalJson(result)),errorCode:view?.error?.code ?? null,reportSeqs:(view?.reports ?? []).map(r=>r.seq),reportEventIds:(view?.reports ?? []).map(r=>r.event_id),fullContentPaths:[view?.full_content_path,...(view?.reports ?? []).map(r=>r.full_content_path)].filter(Boolean),mentionedMarkers});
    },
    stopReason() {return fs.existsSync(path.join(root,'STOP.json'))?{kind:'error',code:'ACCEPTANCE_STOPPED',message:'This acceptance batch stopped; cancel only its owned task and preserve all evidence.'}:null;},
    foregroundEvent(receipt,phase) { audit({event:phase,correlationId:receipt.correlationId,caseId:receipt.caseId}); },
    preflightFailed(error) {stopAcceptance(root,{kind:'zero-model-actual-host-preflight-failed',code:error.code??null,message:error.message});},
    health(identity,runtime,profile,guardian,hostPreflight=null) { audit({event:'health',identity:{key:identity.key,source:identity.source,threadId:identity.threadId,sessionId:identity.sessionId},runtimeInfo,home:runtime?.home ?? null,profile:{name:profile?.name ?? null,fingerprint:profile?.fingerprint ?? null,ready:profile?.ready===true},guardianPresent:guardian,hostPreflight}); },
    async reserve(identity,args,correlationId,signal) {
      const candidate=verifyCandidate(repoRoot(),control.candidate), runtime=resolveRuntime(env);
      // Reuse the existing strict failure classifier. NEVER provision from acceptance.
      const profile=await ensureBridgeProfile({env:runtime.env,runtime,allowProvision:false,signal});
      if(path.resolve(process.execPath)!==path.join(candidate.root,'runtime','node.exe')) throw fail('ACCEPTANCE_RUNTIME_DRIFT','Acceptance must use the installed candidate bundled runtime, not source or system dependencies.');
      if(path.resolve(stateRoot)!==path.resolve(control.stateRoot)||path.resolve(runtime.home)!==path.resolve(control.home)) throw fail('ACCEPTANCE_BINDING_FAILED','Acceptance state root/DSH_HOME drift.');
      if(!profile.ready||profile.fingerprint!==control.candidate.profileFingerprint) throw fail('PROFILE_INTEGRITY_FAILED','Acceptance profile is unready or has a different immutable fingerprint; diagnose and obtain separate bootstrap authorization.');
      if(signal?.aborted)throw fail('ACCEPTANCE_CANCELLED','Request cancelled before the exclusive task reservation.');
      return reserveAcceptance(root,{batch:control.batch,identity:identity.key,source:identity.source,args,correlationId,candidate:control.candidate,processInfo:runtimeInfo});
    },
    lifecycle(receipt,event) {
      try {audit({event:'task-lifecycle',caseId:receipt.caseId,correlationId:receipt.correlationId,...event});}
      catch(error) { stopAcceptance(root,{caseId:receipt.caseId,kind:'audit-failed'});throw error; }
      if(event.phase==='settled'&&!receipt.expectedStates.includes(event.state)) stopAcceptance(root,{caseId:receipt.caseId,kind:'unexpected-terminal-state',state:event.state});
    },
  };
}
