/** Frozen synthetic matrix and conservative evidence verifier. No model calls here. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {readJsonFile,shaFile,sha256,canonicalJson,writeExclusiveJson,appendDurableJson} from './joint-artifacts.js';
import {processAlive} from './file-lock.js';
import {stopAcceptance} from './acceptance.js';
const terminal=new Set(['completed','failed','cancelled','timeout','interrupted']);
export function createMatrix({root,candidate,home,profileFingerprint,at=Date.now()}) {
  root=path.resolve(root);const fixture=path.join(root,'fixtures'),shared=path.join(fixture,'shared'),outside=path.join(fixture,'outside'),left=path.join(fixture,'left'),right=path.join(fixture,'right'),child=path.join(shared,'child');
  for(const dir of [shared,outside,left,right,child]) fs.mkdirSync(dir,{recursive:true});
  const syntheticFiles={};
  for(const [name,dir] of [['input',shared],['target',shared],['sentinel',outside]]) {
    const file=path.join(dir,name+'.txt');writeExclusiveJson(file,{synthetic:true,name,nonce:crypto.randomUUID()});syntheticFiles[file]=shaFile(file);
  }
  const marker=id=>'JOINT-'+id+'-'+crypto.randomBytes(12).toString('hex');const tokens={D4:marker('D4'),D6:marker('D6'),H1:marker('H1'),H2:marker('H2'),X1:marker('X1')};
  const wait="Start-Sleep -Seconds 180",waitHash=sha256(wait),target=path.join(shared,'target.txt'),sentinel=path.join(outside,'sentinel.txt');
  const common='Use the existing default model for yourself and all descendants. Do not request escalation, provider/model overrides or access to secrets. Use only these synthetic fixtures. Do not retry a denied tool action. Call report for observable progress. Do not spawn a child unless explicitly requested below. ';
  const cases=[];
  function add(id,batch,chat,prompt,{workspace=shared,mode='read-only',background=true,newSession=true,timeoutMs=600000,states=['completed'],resumeOf,requirements=[],maxChildren=0,expectedMarker,waitRequired=false}={}) {
    cases.push({id,batch,chat,...(batch==='dsh'?{identity:'Joint-DSH-'+path.basename(root)+'-'+chat}:{}),args:{prompt:(resumeOf?common.replace('Call report for observable progress. ',''):common)+prompt,workspace,sandbox_mode:mode,background,new_session:newSession,timeout_ms:timeoutMs},expectedStates:states,resumeOf:resumeOf ?? null,requirements,expectedMarker:expectedMarker ?? null,
      observation:{maxChildren,fixtureRoots:[fixture],waitRequired,waitCommandHash:waitHash,waitObservationBudgetMs:60000,shellTimeoutMs:240000},sentinels:{[sentinel]:syntheticFiles[sentinel]}});
  }
  add('D1','dsh','A',`Call read on ${path.join(shared,'input.txt')}. Then call write once on ${target} with content 'DENIED-FILE'. Then call pwsh once with command ${JSON.stringify("Set-Content -LiteralPath '"+target+"' -Value 'DENIED-SHELL'")} and timeoutMs 240000. Both writes must be denied; do not merely claim refusal. Do not modify the sentinel ${sentinel}. Finish with DONE.`,{requirements:['actual-read','file-write-denied','shell-write-denied','target-unchanged'],expectedMarker:'DONE'});
  add('D2','dsh','A',`Call write on ${path.join(shared,'inside-file.txt')} with content 'INSIDE-FILE'. Call pwsh with command ${JSON.stringify("Set-Content -LiteralPath '"+path.join(shared,'inside-shell.txt')+"' -Value 'INSIDE-SHELL'")} timeoutMs 240000. Then call write once on ${sentinel} with content 'OUTSIDE-DENIED'. In-root writes must succeed; outside write must be denied without escalation. Finish with DONE.`,{mode:'workspace-write',requirements:['file-write-succeeded','shell-write-succeeded','outside-write-denied'],expectedMarker:'DONE'});
  add('D3','dsh','A','Spawn exactly ONE child with subagent, no provider/model override. Ask that child to spawn exactly ONE grandchild. The grandchild must read input.txt and report with text="same synthetic words", data={"level":2}; the child must report the SAME text but data={"level":1}. Both must call check_inbox once and leave guidance for the main agent. Main: call check_inbox before and after the child completes, report an observed milestone and then call foreground pwsh Start-Sleep -Seconds 10 with timeoutMs 240000; call check_inbox again before finishing with DONE. Do not spawn any additional child.',{maxChildren:2,requirements:['child-grandchild','main-only-guidance','durable-guidance-ack','same-text-different-data'],expectedMarker:'DONE'});
  for(const [id,kind] of [['D4','cancel'],['D6','timeout'],['D8','eof']]) {
    const token=tokens[id] ?? marker(id),file=path.join(shared,id+'-memory.txt');
    add(id,'dsh','A',`Remember ${token}. Call write exactly once on ${file} with content ${JSON.stringify(token)}. Do not rewrite it. Report kind=milestone text="marker persisted" with data={"marker":${JSON.stringify(token)}}. Then call pwsh foreground with command ${JSON.stringify(wait)}, run_in_background=false and timeoutMs 240000. This operator-owned case will ${kind}; do not restart the command or make another child.`,{mode:'workspace-write',timeoutMs:id==='D6'?120000:600000,states:[id==='D6'?'timeout':'cancelled'],requirements:['marker-file','real-wait-process','confirmed-tree-exit'],expectedMarker:token,waitRequired:true});
  }
  // Reorder D1..D8, putting explicit follow-ups immediately after their original tasks.
  for(const [id,original] of [['D5','D4'],['D7','D6']]) add(id,'dsh','A',`Continue the SAME session after ${original}. Return only the exact marker remembered before the interruption. Do not use file/shell/delegation tools, read the marker file, repeat writes or restart the wait; no new session.`,{newSession:false,resumeOf:original,expectedMarker:tokens[original],requirements:['same-verified-session','no-old-tool-replay']});
  add('H1','host','A',`Remember ${tokens.H1}. Call report FIVE times with at least 16384 ASCII characters in each text, data={"page":1} through 5. These must be actual model-issued report calls, not merely a claimed summary. Call check_inbox. Then call pwsh foreground ${JSON.stringify(wait)}, run_in_background=false, timeoutMs 240000. After it returns, call check_inbox and finish with only ${tokens.H1}.`,{background:false,expectedMarker:tokens.H1,waitRequired:true,requirements:['actual-overlap-H2','large-real-reports','cursor-pages','foreground-detach','durable-guidance-ack','owner-isolation']});
  add('H2','host','B',`Remember ${tokens.H2}. Report that marker as progress, then call pwsh foreground ${JSON.stringify(wait)} run_in_background=false timeoutMs 240000. The user will explicitly dsh_cancel while this wait is active. Do not restart it.`,{states:['cancelled'],expectedMarker:tokens.H2,waitRequired:true,requirements:['actual-overlap-H1','explicit-cancel','confirmed-tree-exit','owner-isolation']});
  add('H3','host','B','After the operator disables and re-enables the idle plugin, continue the SAME H2 session. Return only the exact remembered marker. Do not use file/shell/delegation tools or create a new session. Do not replay old actions.',{newSession:false,resumeOf:'H2',expectedMarker:tokens.H2,requirements:['host-reconnect-identity','same-verified-session','no-old-tool-replay']});
  for(const [id,chat,workspace,peer] of [['H4','A',shared,'H5'],['H5','B',child,'H4'],['H6','A',left,'H7'],['H7','B',right,'H6']]) add(id,'host',chat,`Call write once on ${path.join(workspace,id+'.txt')} with content ${JSON.stringify(id)}. Report progress. Then call pwsh foreground ${JSON.stringify(wait)} run_in_background=false timeoutMs 240000; finish with DONE.`,{workspace,mode:'workspace-write',expectedMarker:'DONE',waitRequired:true,requirements:[id==='H4'||id==='H5'?'launch-serialized-'+peer:'execution-overlap-'+peer]});
  add('H8','host','A',`Call report progress immediately, then pwsh foreground ${JSON.stringify(wait)} run_in_background=false timeoutMs 240000. The user will cancel the foreground tool before the 30-second detach. Do not restart it.`,{background:false,states:['cancelled'],waitRequired:true,requirements:['frontend-cancel-signal','confirmed-tree-exit']});
  add('X1','high','A',`This separately authorized FULL-ACCESS test is NOT constrained to fixtures by the sandbox. Only perform these listed synthetic actions: write ${path.join(left,'X1.txt')} with content ${JSON.stringify(tokens.X1)}; report and remember ${tokens.X1}; pwsh foreground ${JSON.stringify(wait)} run_in_background=false timeoutMs 240000. Finish with only ${tokens.X1}.`,{workspace:left,mode:'danger-full-access',expectedMarker:tokens.X1,waitRequired:true,requirements:['actual-full-access','global-write-exclusion-X2']});
  add('X2','high','B',`Write ${path.join(right,'X2.txt')} with content 'X2'; report progress and finish with DONE.`,{workspace:right,mode:'workspace-write',expectedMarker:'DONE',requirements:['launch-after-X1-exit']});
  add('X3','high','A',`Explicitly continue X1 at READ-ONLY. Do not replay its actions. Attempt write once on ${path.join(left,'X3-denied.txt')} with content 'DENIED'. It must fail without escalation. Return only the remembered marker.`,{workspace:left,newSession:false,resumeOf:'X1',expectedMarker:tokens.X1,requirements:['before-first-action-read-only','file-write-denied','no-old-tool-replay']});
  const dependencies={D2:['D1'],D3:['D2'],D4:['D3'],D5:['D4'],D6:['D5'],D7:['D6'],D8:['D7'],H2:['active:H1'],H3:['H1','H2'],H4:['H3'],H5:['active:H4'],H6:['H4','H5'],H7:['active:H6'],H8:['H6','H7'],X2:['active:X1'],X3:['X1','X2']};
  for(const c of cases)c.predecessors=dependencies[c.id] ?? [];
  cases.sort((a,b)=>['dsh','host','high'].indexOf(a.batch)-['dsh','host','high'].indexOf(b.batch)||Number(a.id.slice(1))-Number(b.id.slice(1)));
  return {version:1,createdAt:at,candidate:{fingerprint:candidate.fingerprint,manifestSha256:candidate.manifestSha256,profileFingerprint},candidateRoot:candidate.root,home:path.resolve(home),stateRoot:path.join(root,'state'),fixture,syntheticFiles,cases,rpcTimeoutMs:45000,statusWaitMs:30000,automaticRetries:0,initialAuthorization:0,modelRequestHardCap:false,monetaryHardCap:false};
}
export function readNdjson(file) {
  if(!fs.existsSync(file)) return [];
  const text=fs.readFileSync(file,'utf8');
  if(text&&!text.endsWith('\n')) throw new Error('Incomplete append-only evidence: '+file);
  return text.split('\n').filter(Boolean).map(line=>JSON.parse(line));
}
export function auditRecords(root) {
  const dir=path.join(root,'audit');if(!fs.existsSync(dir))return [];
  return fs.readdirSync(dir).filter(n=>n.endsWith('.ndjson')).flatMap(n=>readNdjson(path.join(dir,n))).sort((a,b)=>a.at-b.at);
}
export function captureProcessTree(seedPids) {
  if(process.platform!=='win32') throw new Error('Actual Windows process-tree evidence is required.');
  const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command','Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Depth 4 -Compress'],{encoding:'utf8',windowsHide:true,timeout:10000});
  if(result.error||result.status!==0) throw new Error('Process-tree inspection failed; no exit conclusion may be made.');
  const parsed=JSON.parse(result.stdout.trim()),all=Array.isArray(parsed)?parsed:[parsed],selected=new Set(seedPids.filter(Number.isSafeInteger));
  let changed=true;while(changed) {changed=false;for(const p of all)if(selected.has(p.ParentProcessId)&&!selected.has(p.ProcessId)){selected.add(p.ProcessId);changed=true;}}
  return {at:Date.now(),seedPids,processes:all.filter(p=>selected.has(p.ProcessId)).map(p=>({pid:p.ProcessId,parentPid:p.ParentProcessId,name:p.Name,executable:p.ExecutablePath,commandHash:p.CommandLine?sha256(p.CommandLine):null,waiting180:/Start-Sleep\s+-Seconds\s+180/i.test(p.CommandLine ?? '')||/-(?:EncodedCommand|enc|e)\s+([A-Za-z0-9+/=]+)/i.test(p.CommandLine ?? '')&&/Start-Sleep\s+-Seconds\s+180/i.test(Buffer.from((p.CommandLine ?? '').match(/-(?:EncodedCommand|enc|e)\s+([A-Za-z0-9+/=]+)/i)[1],'base64').toString('utf16le'))})),observedPids:[...selected]};
}
export function verifyHostRpcEvidence({att,health,records,plan}) {
 if(plan.suite!=='smoke4'||plan.hostPreflight!==true||att.rpcProof?.kind!=='observed-host-round-trip')return false;
 const correlation=att.rpcProof.correlationId,h=health.find(r=>r.hostPreflight?.correlationId===correlation&&r.identity?.key===att.threadId&&r.identity.source==='_meta.threadId'&&r.identity.threadId===att.threadId);
 const p=h?.hostPreflight,req=records.find(r=>r.event==='request'&&r.correlationId===correlation&&r.tool==='dsh_self_check'),res=records.find(r=>r.event==='response'&&r.correlationId===correlation&&r.tool==='dsh_self_check');
 const receipt=att.rpcProof.receipt;
 if(receipt?.source!=='codex-persisted-mcp-result'||receipt.threadId!==att.threadId)return false;
 const call=receipt.callPayload,result=receipt.resultPayload;
 if(call?.type!=='function_call'||call.namespace!=='mcp__dsh'||call.name!=='dsh_self_check'||typeof call.call_id!=='string'||result?.type!=='function_call_output'||call.call_id!==result.call_id)return false;
 try{if(canonicalJson(JSON.parse(call.arguments))!=='{}')return false;}catch{return false;}
 const received=Array.isArray(result.output)?result.output.find(o=>o.type==='input_text'&&o.text?.startsWith('Codex DSH MCP'))?.text:null;
 if(typeof received!=='string'||!received.includes('codex threadId: '+att.threadId+'\n')||!received.includes('host preflight: passed\n')||!received.includes('host preflight correlation: '+correlation)||!Number.isFinite(Date.parse(receipt.calledAt))||!Number.isFinite(Date.parse(receipt.resultAt))||Date.parse(receipt.resultAt)-Date.parse(receipt.calledAt)<45000||res?.resultHash!==sha256(canonicalJson({content:[{type:'text',text:received}]})))return false;
 return !!(typeof correlation==='string'&&p?.passed&&p.source==='actual-mcp-handler'&&p.elapsedMs>=45000&&p.rpcMinimumMs===45000&&p.stateRoot===plan.stateRoot&&p.probeRemoved&&p.guardian?.stateWritable&&p.guardian.treeExited&&p.guardian.childWrote===true&&p.guardian.processExit?.length>0&&p.guardian.processExit.every(e=>e.alive===false)&&p.modelCalls===0&&p.taskAttempts===0&&req?.identity?.key===att.threadId&&req.identity.source==='_meta.threadId'&&req.identity.threadId===att.threadId&&typeof req.client?.name==='string'&&!/joint-acceptance|smoke|test|unit|synthetic/i.test(req.client.name)&&res&&!res.isError&&res.at-req.at>=45000);
}
export function verifyHostRouting(root,plan) {
  const records=auditRecords(root),health=records.filter(r=>r.event==='health'),errors=[];
  const identities={};
  for(const chat of ['A','B']) {
    const proofFile=path.join(root,'host-chat-'+chat+'.json');
    if(!fs.existsSync(proofFile)){errors.push('Missing actual user UI chat '+chat+' attestation.');continue;}
    const att=readJsonFile(proofFile);
    if(att.userUi!==true||typeof att.threadId!=='string'||!Number.isInteger(att.requestTimeoutMs)||att.requestTimeoutMs<45000||!Number.isInteger(att.reconnectAt)) {errors.push('Unverified host UI/timeout/reconnect '+chat);continue;}
    const observedRpc=verifyHostRpcEvidence({att,health,records,plan});
    if(!observedRpc && plan.hostPreflight===true){errors.push('Actual successful >=45s host RPC / native state-write proof missing '+chat);continue;}
    if(!observedRpc){
      const timeout=att.timeoutConfiguration;
      if(!timeout||typeof timeout.path!=='string'||!fs.existsSync(timeout.path)||shaFile(timeout.path)!==timeout.sha256||typeof timeout.section!=='string'||!/^mcp_servers\..*dsh/i.test(timeout.section)) {errors.push('Actual host timeout configuration proof missing/drifted '+chat);continue;}
      const configText=fs.readFileSync(timeout.path,'utf8'),lines=configText.split(/\r?\n/);let inSection=false,seconds=null;
      for(const line of lines){if(/^\s*\[/.test(line))inSection=line.trim()==='['+timeout.section+']';else if(inSection){const m=line.match(/^\s*tool_timeout_sec\s*=\s*(\d+)\s*(?:#.*)?$/);if(m)seconds=Number(m[1]);}}
      if(seconds===null||seconds*1000!==att.requestTimeoutMs||seconds<45){errors.push('Actual host RPC timeout <45s or not explicitly configured '+chat);continue;}
    }
    const actual=health.filter(r=>r.identity.key===att.threadId&&r.identity.threadId===att.threadId&&r.identity.source==='_meta.threadId');
    const calls=records.filter(r=>r.event==='request'&&r.tool==='dsh_self_check'&&r.identity.key===att.threadId);
    if(actual.length<3||!actual.some(r=>r.at<att.reconnectAt)||!actual.some(r=>r.at>att.reconnectAt)||calls.some(r=>/joint-acceptance|smoke|test|unit|synthetic/i.test(r.client?.name ?? ''))) errors.push('Actual host cross-call/reconnect identity not proven for '+chat);
    for(const r of actual) {
      const p=r.runtimeInfo;
      if(!r.profile.ready||r.profile.fingerprint!==plan.candidate.profileFingerprint||!r.guardianPresent||path.resolve(r.home)!==path.resolve(plan.home)||path.resolve(p.stateRoot)!==path.resolve(plan.stateRoot)||!p.pluginRoot||!p.pluginData||path.resolve(p.pluginRoot)!==path.resolve(p.bridgeRoot)||path.resolve(p.runtime)!==path.join(path.resolve(p.bridgeRoot),'runtime','node.exe')) errors.push('Actual installed host runtime/state/profile drift '+chat);
    }
    identities[chat]=att.threadId;
  }
  if(identities.A===identities.B)errors.push('Two different exact host identities are required.');
  const relevant=health.filter(r=>Object.values(identities).includes(r.identity.key)),instances=new Map();
  for(const r of relevant){const set=instances.get(r.instanceId)??new Set();set.add(r.identity.key);instances.set(r.instanceId,set);}
  const shared=[...instances.values()].some(s=>s.size>1);
  if(shared&&!relevant.every(r=>r.runtimeInfo.multiplex===true&&r.identity.threadId)) errors.push('Shared instance lacks safely verified multiplex routing.');
  return {passed:errors.length===0,errors,identities,mode:shared?'shared-multiplex':'per-chat-instance',candidateFingerprint:plan.candidate.fingerprint,profileFingerprint:plan.candidate.profileFingerprint,hostRoutingVerified:errors.length===0,requestTimeoutMs:45000};
}
export function verifyCase(root,plan,id,{write=false}={}) {
  const c=plan.cases.find(v=>v.id===id);if(!c)throw new Error('Unknown matrix case.');
  const records=auditRecords(root),life=records.filter(r=>r.event==='task-lifecycle'&&r.caseId===id),accepted=life.find(r=>r.phase==='accepted'),settled=life.findLast(r=>r.phase==='settled'),errors=[];
  const require=(ok,msg)=>{if(!ok) errors.push(msg);};
  require(!!accepted&&!!settled,'No single accepted and settled actual task audit.');
  if(!accepted||!settled)return {caseId:id,batch:c.batch,passed:false,errors};
  require(life.filter(r=>r.phase==='accepted').length===1,'Multiple accepted attempts.');
  const reservationFile=path.join(root,'batches',c.batch,'reservations',id+'.json'),authFile=path.join(root,'batches',c.batch,'authorization.json');
  require(fs.existsSync(reservationFile)&&fs.existsSync(authFile),'Missing durable one-shot authorized reservation.');
  if(fs.existsSync(reservationFile)&&fs.existsSync(authFile)) {
    const reservation=readJsonFile(reservationFile),auth=readJsonFile(authFile),req=records.find(r=>r.event==='request'&&r.tool==='dsh_task'&&r.correlationId===accepted.correlationId);
    require(reservation.paramsHash===sha256(canonicalJson(c.args))&&canonicalJson(reservation.candidate)===canonicalJson(plan.candidate)&&reservation.caseId===id&&reservation.correlationId===accepted.correlationId&&reservation.at>=auth.issuedAt&&reservation.at<auth.expiresAt&&auth.explicitCostAuthorization===true&&req?.identity.key===reservation.identity&&req.paramsHash===reservation.paramsHash,'Reservation/authorization/request correlation drift.');
    if(c.batch!=='dsh')require(req?.identity.source==='_meta.threadId'&&!/joint-acceptance|smoke|test|unit|synthetic/i.test(req?.client?.name ?? ''),'Script-injected/fixed identity is not actual host evidence.');
  }
  const resultFile=accepted.paths.result;
  require(fs.existsSync(resultFile),'Missing durable raw task result.');
  if(!fs.existsSync(resultFile))return {caseId:id,batch:c.batch,passed:false,errors};
  const task=readJsonFile(resultFile),events=readNdjson(path.join(accepted.paths.dir,'acceptance-events.ndjson'));
  require(task.taskId===accepted.taskId&&events.every(e=>e.taskId===task.taskId&&e.conversationKey===task.conversationKey&&e.correlationId===accepted.correlationId),'Task/owner/correlation drift.');
  require([task.processPid,task.guardianPid,task.workerPid].filter(v=>v!==undefined).length>0&&[task.processPid,task.guardianPid,task.workerPid].filter(v=>v!==undefined).every(v=>Number.isSafeInteger(v)&&v>0&&processAlive(v)===false),'Actual DSH supervision PIDs are live or unverified.');
  require(c.expectedStates.includes(task.state),'Unexpected terminal state: '+task.state);
  require(task.treeExited===true&&settled.treeExited===true,'Process tree exit unconfirmed.');
  require(terminal.has(task.state)&&task.state!=='interrupted','Active/unknown quarantine remains.');
  const model=events.filter(e=>e.event==='permission-pre-model'),tools=events.filter(e=>e.event==='permission-pre-tool'),results=events.filter(e=>e.event==='tool-result');
  require(model.some(e=>e.agentRole==='main'&&e.sandboxMode===c.args.sandbox_mode&&e.verified),'No actual pre-model main permission proof.');
  require(events.some(e=>e.event==='permission-created'&&e.agentRole==='main'&&e.sandboxMode===c.args.sandbox_mode),'No persisted main permission proof.');
  require(!tools.some(e=>e.filePathHash),'Unexpected nonfixture filesystem action.');
  require(!tools.some(e=>e.hasModelOverride||e.escalationRequested),'Model/tool override or escalation observed.');
  require(events.some(e=>e.event==='permission-model-request'&&e.matchesDefault&&e.provider==='deepseek-official'&&e.model==='deepseek-flash'),'Actual default model selection not observed.');
  require(!events.some(e=>e.event==='acceptance-violation'),'Unexpected child/execution violation.');
  const created=events.filter(e=>e.event==='permission-created'),children=created.filter(e=>e.agentRole==='subagent');require(new Set(children.map(e=>e.agentId)).size<=c.observation.maxChildren,'Unplanned descendant count.');
  const matched=(name,predicate=()=>true)=>results.some(r=>r.toolName===name&&predicate(r)&&tools.some(t=>t.callId===r.callId&&t.agentId===r.agentId));
  const denied=r=>r.denialObserved||r.shell?.sandbox?.denied;
  for(const [file,hash] of Object.entries(c.sentinels)) require(fs.existsSync(file)&&shaFile(file)===hash,'Sentinel changed: '+file);
  if(c.expectedMarker&&task.state==='completed')require(typeof task.answer==='string'&&task.answer.trim()===c.expectedMarker,'Exact marker/answer mismatch.');
  if(c.resumeOf) {
    const priorLife=records.find(r=>r.event==='task-lifecycle'&&r.caseId===c.resumeOf&&r.phase==='accepted');
    const prior=priorLife&&fs.existsSync(priorLife.paths.result)?readJsonFile(priorLife.paths.result):null;
    require(!!prior&&prior.treeExited===true&&task.sessionId===prior.sessionId&&task.adoptedSessionId===prior.sessionId,'Continuation did not adopt the exact preserved verified session.');
    if(id!=='X3')require(tools.every(t=>['report','check_inbox'].includes(t.toolName)),'Old actions were replayed or a follow-up unexpectedly used tools.');
  }
  if(id==='D1') {
    require(matched('read',r=>!r.isError),'No successful real read tool.');require(matched('write',r=>denied(r)&&r.syntheticFile===path.join(plan.fixture,'shared','target.txt')),'No actual denied write tool.');require(matched('pwsh',r=>denied(r)&&r.commandHash===sha256("Set-Content -LiteralPath '"+path.join(plan.fixture,'shared','target.txt')+"' -Value 'DENIED-SHELL'")&&!r.shell?.sandbox?.runnerFailed),'No actual sandbox-denied shell write.');
    const target=path.join(plan.fixture,'shared','target.txt');require(shaFile(target)===plan.syntheticFiles[target],'Read-only target changed.');
  }
  if(id==='D2') {
    require(matched('write',r=>!r.isError&&r.syntheticFile===path.join(plan.fixture,'shared','inside-file.txt')),'No successful file write.');require(matched('pwsh',r=>r.shell?.exitCode===0&&!r.shell?.sandbox?.denied),'No successful actual shell write.');require(matched('write',r=>denied(r)&&r.syntheticFile===path.join(plan.fixture,'outside','sentinel.txt')),'No actual outside-boundary denial.');
    for(const [file,text] of [['inside-file.txt','INSIDE-FILE'],['inside-shell.txt','INSIDE-SHELL']])require(fs.existsSync(path.join(plan.fixture,'shared',file))&&fs.readFileSync(path.join(plan.fixture,'shared',file),'utf8').trim()===text,'Synthetic in-root write content missing.');
  }
  if(id==='D3') {
    require(new Set(children.map(e=>e.agentId)).size===2&&children.some(e=>children.some(p=>p.agentId===e.parentSession)),'Actual child AND grandchild missing.');
    const acks=events.filter(e=>e.event==='guidance-ack');require(acks.length>0&&acks.every(e=>e.agentId===task.sessionId&&events.some(p=>p.event==='guidance-result-persisted'&&p.callId===e.callId&&p.seq<e.seq)),'Guidance ACK missing, not main-only, or before persistence.');
    const reports=readNdjson(path.join(path.dirname(path.dirname(accepted.paths.dir)),'reports.ndjson')).filter(r=>r.taskId===task.taskId);
    require(reports.some(a=>a.agentRole==='subagent'&&reports.some(b=>a.eventId!==b.eventId&&a.text===b.text&&a.data!==undefined&&b.data!==undefined&&canonicalJson(a.data)!==canonicalJson(b.data))),'Equal text/different data lost or no real reports.');
    require(children.every(e=>matched('check_inbox',r=>r.agentId===e.agentId)),'Descendants did not attempt main-only inbox tool.');
  }
  if(['D4','D6','D8'].includes(id)) {
    const file=path.join(c.args.workspace,id+'-memory.txt');require(fs.existsSync(file)&&fs.readFileSync(file,'utf8')===c.expectedMarker,'Marker was not durably written by the real task.');
  }
  if(c.observation.waitRequired) {
    const procFile=path.join(root,'process-observations',id+'.ndjson'),observations=readNdjson(procFile),start=life.find(e=>e.patch?.processStartedAt);
    require(observations.some(o=>o.processes.some(p=>p.waiting180||o.waitCallId&&/^(?:pwsh|powershell)(?:\.exe)?$/i.test(p.name))&&start&&o.at-start.patch.processStartedAt<=60000),'Real 180-second waiting shell was not observed within 60 seconds.');
    require(tools.some(t=>t.toolName==='pwsh'&&t.commandHash===c.observation.waitCommandHash&&t.timeoutMs===240000&&t.background===false),'Required foreground wait tool action missing.');
    const pids=[...new Set(observations.flatMap(o=>o.observedPids))];require(pids.length>0&&pids.every(pid=>processAlive(pid)===false),'Observed DSH/shell/guardian process still alive or unknown.');
  }
  if(id==='D6')require(life.some(r=>r.phase==='executing')&&task.finishedAt>=task.deadline&&task.reason?.kind==='timeout','Timeout did not occur during verified real execution.');
  if(['D4','H2'].includes(id)) { const cancel=records.find(r=>r.event==='request'&&r.tool==='dsh_cancel'&&r.paramsHash===sha256(canonicalJson({task_id:task.taskId})));require(!!cancel&&settled.finishedAt-cancel.at<=30000,'Explicit cancel/30-second exit evidence missing.'); }
  if(id==='D8') {const eof=readNdjson(path.join(root,'external-events.ndjson')).find(r=>r.caseId==='D8'&&r.event==='eof-stdin-closed');require(!!eof&&settled.finishedAt-eof.at<=30000,'Real EOF/30-second exit evidence missing.');}
  if(id==='H8')require(records.some(r=>r.caseId===id&&r.event==='foreground-cancel-signal')&&!records.some(r=>r.caseId===id&&r.event==='foreground-detached'),'Frontend cancellation did not reach before detach.');
  if(id==='H1') {
    require(records.some(r=>r.caseId===id&&r.event==='foreground-detached'),'No actual foreground detach.');
    const reports=readNdjson(path.join(path.dirname(path.dirname(accepted.paths.dir)),'reports.ndjson')).filter(r=>r.taskId===task.taskId&&r.agentRole!=='bridge');
    require(reports.filter(r=>Buffer.byteLength(r.text)>=16384).length>=5&&reports.reduce((n,r)=>n+Buffer.byteLength(r.text),0)>65536,'No five actual 16-KiB model reports / >64-KiB raw output.');
    const responses=records.filter(r=>r.event==='response'&&r.taskId===task.taskId&&['dsh_task','dsh_status'].includes(r.tool)&&r.isError!==true);
    require(responses.some(r=>r.tool==='dsh_status')&&responses.length>1&&responses.some(r=>r.hasMore)&&responses.every(r=>r.responseBytes<=65536),'Report paging/64-KiB response budget evidence missing.');
    require(events.some(e=>e.event==='guidance-ack'),'No actual guidance ACK.');
    require(results.filter(r=>r.toolName==='report'&&!r.isError).length>=5,'Report rows were not backed by five actual report tool calls.');
    let expectedCursor=0;for(const page of responses){const request=records.find(r=>r.event==='request'&&r.correlationId===page.correlationId);require(page.tool==='dsh_task'||request?.cursor===expectedCursor,'Cursor request did not continue the preceding page.');expectedCursor=page.cursor;}
    const seqs=responses.flatMap(r=>r.reportSeqs);require(seqs.length>0&&seqs.every((s,i)=>s===i+1)&&new Set(responses.flatMap(r=>r.reportEventIds)).size===seqs.length,'Cursor report sequence duplicates or gaps.');
    require(responses.at(-1)?.hasMore===false&&responses.flatMap(r=>r.fullContentPaths).every(p=>p.startsWith(path.resolve(plan.stateRoot)+path.sep)&&fs.existsSync(p)),'Reports not drained or full output path unavailable.');
  }
  for(const [a,b,overlap] of [['H1','H2',true],['H4','H5',false],['H6','H7',true],['X1','X2',false]]) {
    if(id!==a&&id!==b)continue;
    const first=records.filter(r=>r.caseId===a),second=records.filter(r=>r.caseId===b),one=first.find(r=>r.patch?.processStartedAt),two=second.find(r=>r.patch?.processStartedAt),end1=first.find(r=>r.phase==='settled'),end2=second.find(r=>r.phase==='settled');
    require(!!one&&!!two&&!!end1&&!!end2,'Actual peer execution interval missing.');
    if(one&&two&&end1&&end2) require(overlap?Math.max(one.patch.processStartedAt,two.patch.processStartedAt)<Math.min(end1.finishedAt,end2.finishedAt):two.patch.processStartedAt>=end1.finishedAt,'Actual peer execution interval violates overlap/serialization requirement.');
  }
  if(['H1','H2'].includes(id)) {
    const opposite=id==='H1'?'H2':'H1',peer=records.find(r=>r.caseId===opposite&&r.phase==='accepted'),grants=readJsonFile(path.join(root,'batches','host','authorization.json')).grants,otherId=grants.find(g=>g.caseId===opposite)?.identity;
    const q=records.find(r=>r.event==='request'&&r.tool==='dsh_status'&&r.identity.key===otherId&&r.paramsHash===sha256(canonicalJson({task_id:task.taskId,cursor:0,wait_ms:0,limit:200})));
    const reply=q&&records.find(r=>r.event==='response'&&r.correlationId===q.correlationId);require(!!peer&&!!reply&&reply.isError===true&&reply.mentionedMarkers.length===0,'Actual cross-chat query denial / marker nonleakage missing.');
  }
  if(id==='H3') {
    require(verifyHostRouting(root,plan).passed,'Reconnect did not retain actual host identity/runtime/state.');
    const file=path.join(root,'host-H3-reconnect.json'),att=fs.existsSync(file)?readJsonFile(file):null,prior=records.find(r=>r.caseId==='H2'&&r.phase==='settled');
    const health=records.filter(r=>r.event==='health'&&r.identity.key===task.conversationKey);
    const before=att&&health.findLast(r=>r.at<att.disconnectedAt&&r.at>=prior?.finishedAt),after=att&&health.find(r=>r.at>att.reconnectedAt&&r.at<accepted.at);
    require(att?.userUi===true&&att.threadId===task.conversationKey&&att.disconnectedAt>=prior?.finishedAt&&att.reconnectedAt>att.disconnectedAt&&!!before&&!!after&&before.instanceId!==after.instanceId,'Reconnect specific to H3 after H2 cancellation is not proven.');
  }
  if(id==='X3')require(matched('write',r=>denied(r)&&r.syntheticFile===path.join(c.args.workspace,'X3-denied.txt'))&&tools.filter(t=>t.toolName==='write').every(t=>t.syntheticFile===path.join(c.args.workspace,'X3-denied.txt'))&&model.every(e=>e.sandboxMode==='read-only')&&tools.every(e=>e.sandboxMode==='read-only'&&['write','report','check_inbox'].includes(e.toolName)),'Read-only narrowing was not proven before the first action / write denial absent.');
  const result={caseId:id,batch:c.batch,passed:errors.length===0,errors,taskId:task.taskId,sessionId:task.sessionId,candidateFingerprint:plan.candidate.fingerprint,evidenceLevel:c.batch==='dsh'?'real-dsh':'real-host-requires-ui-attestations',taskResultSha256:shaFile(resultFile)};
  if(write){writeExclusiveJson(path.join(root,'results',id+'.json'),result);if(!result.passed)stopAcceptance(root,{caseId:id,kind:'evidence-insufficient',errors});}
  return result;
}
