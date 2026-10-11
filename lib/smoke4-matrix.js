/** Four host-only paid attempts; pure matrix/evidence checks never submit model work. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {sha256,shaFile,canonicalJson,writeExclusiveJson,readJsonFile} from './joint-artifacts.js';
import {auditRecords,readNdjson,verifyCase,verifyHostRouting} from './joint-matrix.js';
import {processAlive} from './file-lock.js';
import {stopAcceptance} from './acceptance.js';
import {suiteOf,validateAcceptancePlan} from './acceptance-suite.js';
export function createSmoke4Matrix({root,candidate,home,profileFingerprint,at=Date.now()}) {
  root=path.resolve(root);const fixture=path.join(root,'fixtures'),left=path.join(fixture,'left'),right=path.join(fixture,'right'),outside=path.join(fixture,'outside');
  for(const dir of [left,right,outside])fs.mkdirSync(dir,{recursive:true});
  const files={input:path.join(left,'input.txt'),target:path.join(left,'target.txt'),sentinel:path.join(outside,'sentinel.txt'),memory:path.join(right,'S2-memory.txt'),shell:path.join(right,'inside-shell.txt')},syntheticFiles={};
  for(const [name,file] of Object.entries(files).slice(0,3)){writeExclusiveJson(file,{synthetic:true,name,nonce:crypto.randomUUID()});syntheticFiles[file]=shaFile(file);}
  const token=id=>'JOINT-'+id+'-'+crypto.randomBytes(12).toString('hex'),markers={S1:token('S1'),S2:token('S2')},guide='GUIDE-'+crypto.randomBytes(12).toString('hex');
  const commands={initial:'Start-Sleep -Seconds 45',handoff:'Start-Sleep -Seconds 30',wait:'Start-Sleep -Seconds 180',deniedShell:"Set-Content -LiteralPath '"+files.target+"' -Value 'DENIED-SHELL'",insideShell:"Set-Content -LiteralPath '"+files.shell+"' -Value 'INSIDE-SHELL'"};
  const common='Use the existing default model; do not override provider/model, escalate permissions, spawn subagents, access secrets or real project files. Only the listed synthetic actions are authorized. Do not retry any action or a denied operation. ';
  const cases=[];
  function add(id,chat,prompt,{mode='read-only',workspace=left,background=true,newSession=true,timeoutMs=600000,state='completed',resumeOf=null,expectedMarker=null,predecessors=[],requirements=[],allowedFiles=[],allowedCommands=[],waitRequired=false}={}) {
    cases.push({id,batch:'host',chat,args:{prompt:common+prompt,workspace,sandbox_mode:mode,background,new_session:newSession,timeout_ms:timeoutMs},expectedStates:[state],resumeOf,expectedMarker,predecessors,requirements,
      observation:{maxChildren:0,fixtureRoots:[fixture],waitRequired,waitCommandHash:sha256(commands.wait),waitObservationBudgetMs:60000,shellTimeoutMs:240000},sentinels:{[files.sentinel]:syntheticFiles[files.sentinel]},allowedFiles,allowedCommandHashes:allowedCommands.map(sha256)});
  }
  add('S1','A',
    'First call pwsh with command '+JSON.stringify(commands.initial)+' run_in_background=false timeoutMs=240000. After that call read on '+files.input+'. Call write exactly once on '+files.target+' with content DENIED-FILE, then pwsh exactly once with command '+JSON.stringify(commands.deniedShell)+' run_in_background=false timeoutMs=240000. Both writes must actually be denied; do not merely refuse verbally. Then call report THREE times, with data={"smoke4Page":1}, then 2, then 3; each text must be at most 1024 UTF-8 bytes and include '+markers.S1+'. These reports must come AFTER the initial wait. Then pwsh '+JSON.stringify(commands.wait)+' run_in_background=false timeoutMs=240000 to keep the overlap window open. Finish with ONLY '+markers.S1+'.',
    {background:false,expectedMarker:markers.S1,allowedFiles:[files.input,files.target],allowedCommands:[commands.initial,commands.deniedShell,commands.wait],requirements:['real-read-and-write-denials','foreground-detach','small-report-cursor-pages','execution-overlap-S2','owner-isolation']});
  add('S2','B',
    'Remember '+markers.S2+'. Call write exactly once on '+files.memory+' with content '+JSON.stringify(markers.S2)+'. Call pwsh '+JSON.stringify(commands.insideShell)+' run_in_background=false timeoutMs=240000. Call write exactly once on '+files.sentinel+' with content OUTSIDE-DENIED; it must be denied without escalation. Report kind=milestone text="ready-for-steer" data={"smoke4":"ready-for-steer"}. Call pwsh '+JSON.stringify(commands.handoff)+' run_in_background=false timeoutMs=240000 to allow operator guidance. Then call check_inbox exactly once and follow the synthetic guidance to report its receipt token. If no guidance is returned, report a blocker and stop without retrying. Once guidance is consumed, call pwsh '+JSON.stringify(commands.wait)+' run_in_background=false timeoutMs=240000. The operator will explicitly cancel during this wait; do not restart it.',
    {workspace:right,mode:'workspace-write',state:'cancelled',expectedMarker:markers.S2,predecessors:['active:S1'],allowedFiles:[files.memory,files.sentinel],allowedCommands:[commands.insideShell,commands.handoff,commands.wait],requirements:['in-root-file-and-shell-write','outside-write-denied','durable-main-guidance-ack','real-wait-before-explicit-cancel','confirmed-tree-exit','execution-overlap-S1','owner-isolation']});
  add('S3','B',
    'After the operator reconnects the idle plugin, continue the SAME preserved S2 session, now READ-ONLY. Return ONLY the exact marker remembered before cancellation. The marker is deliberately not repeated here. Do not use any tools, read marker files, write anything, restart a wait, create another session or replay earlier actions.',
    {workspace:right,newSession:false,resumeOf:'S2',expectedMarker:markers.S2,predecessors:['S1','S2'],requirements:['reconnect-preserves-host-identity','same-verified-session','read-only-before-first-model-step','no-old-action-replay']});
  add('S4','A',
    'Call report once with text="timeout-ready". Then immediately call pwsh '+JSON.stringify(commands.wait)+' run_in_background=false timeoutMs=240000. The top-level 120-second deadline must interrupt this real foreground wait before its own 240-second tool timeout. Do not retry or stop it yourself.',
    {timeoutMs:120000,state:'timeout',predecessors:['S3'],allowedCommands:[commands.wait],waitRequired:true,requirements:['real-wait-within-60-seconds','execution-deadline-not-preparation-timeout','confirmed-tree-exit']});
  for(const c of cases)c.observation.toolPolicy={allowedTools:{S1:['read','write','pwsh','report'],S2:['write','pwsh','report','check_inbox'],S3:[],S4:['pwsh','report']}[c.id],files:c.allowedFiles,commandHashes:c.allowedCommandHashes,commandTargets:Object.fromEntries(c.allowedCommandHashes.map(hash=>[hash,hash===sha256(commands.deniedShell)?[files.target]:hash===sha256(commands.insideShell)?[files.shell]:[]]))};
  const plan={version:1,suite:'smoke4',hostPreflight:true,createdAt:at,candidate:{fingerprint:candidate.fingerprint,manifestSha256:candidate.manifestSha256,profileFingerprint},candidateRoot:candidate.root,home:path.resolve(home),stateRoot:path.join(root,'state'),fixture,syntheticFiles,files,commands,cases,
    guidance:{caseId:'S2',message:'Synthetic guidance only: report the receipt token '+guide+' once, then continue the already authorized wait. Remember the original S2 marker unchanged. Do not add any file, shell, model or delegation actions.',token:guide},
    rpcTimeoutMs:45000,statusWaitMs:30000,automaticRetries:0,initialAuthorization:0,modelRequestHardCap:false,monetaryHardCap:false};
  validateAcceptancePlan(plan);return plan;
}
export function smoke4BehaviorErrors({root,plan,c,task,events,records,accepted,settled,observations=[],reports=[]}) {
  const errors=[],need=(ok,msg)=>{if(!ok)errors.push(msg);},tools=events.filter(e=>e.event==='permission-pre-tool'),results=events.filter(e=>e.event==='tool-result');
  const matched=(name,predicate)=>results.some(r=>r.toolName===name&&predicate(r)&&tools.some(t=>t.callId===r.callId&&t.agentId===r.agentId));
  const denied=r=>r.denialObserved===true||r.shell?.sandbox?.denied===true;
  const allowed={S1:['read','write','pwsh','report'],S2:['write','pwsh','report','check_inbox'],S3:[],S4:['pwsh','report']}[c.id];
  need(tools.every(t=>allowed.includes(t.toolName)&&(!t.syntheticFile||c.allowedFiles.includes(t.syntheticFile))&&(t.toolName!=='pwsh'||c.allowedCommandHashes.includes(t.commandHash))),'Unplanned smoke4 tool/file/shell action.');
  need(events.some(e=>e.event==='permission-created'&&e.agentRole==='main'&&e.syntheticActionPolicy===true),'Missing smoke4 pre-tool synthetic action policy.');
  need(!events.some(e=>e.agentRole==='subagent'||e.event==='acceptance-violation'),'No paid descendant is authorized.');
  const hostIdentity=(r,key)=>typeof key==='string'&&r?.identity?.key===key&&r.identity.source==='_meta.threadId'&&r.identity.threadId===key;
  const hostRequest=(r,key)=>hostIdentity(r,key)&&typeof r.client?.name==='string'&&!/joint-acceptance|smoke|test|unit|synthetic/i.test(r.client.name);
  const pages=records.filter(r=>r.event==='response'&&r.taskId===task.taskId&&!r.isError&&['dsh_task','dsh_status'].includes(r.tool));
  need(pages.every(p=>hostRequest(records.find(r=>r.event==='request'&&r.correlationId===p.correlationId),task.conversationKey)),'Paging must come from the actual owning host thread, not a fixed or script-injected identity.');
  need(pages.length>0&&pages.at(-1)?.hasMore===false&&['completed','cancelled','timeout'].includes(pages.at(-1)?.state),'Reports not drained through a terminal owner status.');
  if(c.id==='S1') {
    const detach=records.find(r=>r.caseId==='S1'&&r.event==='foreground-detached'),first=tools[0];
    need(!!detach&&first?.toolName==='pwsh'&&first.commandHash===sha256(plan.commands.initial)&&first.background===false,'No real initial wait / foreground detach.');
    need(matched('pwsh',r=>r.callId===first?.callId&&r.shell?.exitCode===0&&!r.shell?.timedOut&&r.ts-first.ts>=44000),'Initial 45-second nonwriting wait was not successfully executed.');
    need(matched('read',r=>!r.isError&&r.syntheticFile===plan.files.input),'No successful real read tool.');
    need(matched('write',r=>denied(r)&&r.syntheticFile===plan.files.target&&r.contentHash===sha256('DENIED-FILE')),'No actual denied file write.');
    need(matched('pwsh',r=>denied(r)&&r.commandHash===sha256(plan.commands.deniedShell)&&!r.shell?.sandbox?.runnerFailed),'No actual sandbox-denied shell write.');
    need(fs.existsSync(plan.files.target)&&shaFile(plan.files.target)===plan.syntheticFiles[plan.files.target],'Read-only target changed.');
    need(matched('pwsh',r=>r.commandHash===sha256(plan.commands.wait)&&r.shell?.exitCode===0),'Required successful overlap wait is absent.');
    const genuine=reports.filter(r=>r.agentRole==='main'&&r.taskId===task.taskId&&[1,2,3].includes(r.data?.smoke4Page));
    need(genuine.length===3&&new Set(genuine.map(r=>r.data.smoke4Page)).size===3&&genuine.every(r=>r.ts>=detach?.at&&Buffer.byteLength(r.text)<=1024&&r.text.includes(c.expectedMarker))&&results.filter(r=>r.toolName==='report'&&!r.isError&&r.ts>=detach?.at).length>=3,'No three actual small model reports after foreground detach.');
    const statuses=pages.filter(r=>r.tool==='dsh_status');
    need(statuses.length>=3&&statuses.some(r=>r.hasMore)&&statuses.every(r=>records.some(q=>q.event==='request'&&q.correlationId===r.correlationId&&q.limit===1)),'Report paging with limit=1 missing.');
    let cursor=0;for(const p of pages){const q=records.find(r=>r.event==='request'&&r.correlationId===p.correlationId);need(p.tool==='dsh_task'||q?.cursor===cursor,'Cursor request did not continue preceding page.');need(p.cursor>=cursor&&p.responseBytes<=65536,'Cursor regressed or response exceeded 64-KiB.');cursor=p.cursor;}
    const seqs=pages.flatMap(p=>p.reportSeqs??[]),ids=pages.flatMap(p=>p.reportEventIds??[]);
    need(seqs.length>0&&seqs.every((s,i)=>s===i+1)&&new Set(ids).size===seqs.length,'Cursor report sequence duplicates or gaps.');
    need(pages.flatMap(p=>p.fullContentPaths??[]).every(f=>f.startsWith(path.resolve(plan.stateRoot)+path.sep)&&fs.existsSync(f)),'Reports not drained or owned full output missing.');
  }
  if(c.id==='S2') {
    need(matched('write',r=>!r.isError&&r.syntheticFile===plan.files.memory&&r.contentHash===sha256(c.expectedMarker)),'No successful synthetic marker file write.');
    need(fs.existsSync(plan.files.memory)&&fs.readFileSync(plan.files.memory,'utf8')===c.expectedMarker,'Synthetic marker content missing.');
    need(matched('pwsh',r=>r.commandHash===sha256(plan.commands.insideShell)&&r.shell?.exitCode===0&&!r.shell?.sandbox?.denied),'No successful actual in-root shell write.');
    need(fs.existsSync(plan.files.shell)&&fs.readFileSync(plan.files.shell,'utf8').trim()==='INSIDE-SHELL','Synthetic shell content missing.');
    need(matched('write',r=>denied(r)&&r.syntheticFile===plan.files.sentinel&&r.contentHash===sha256('OUTSIDE-DENIED')),'No actual outside-boundary denial.');
    const steer=records.find(r=>r.event==='request'&&r.tool==='dsh_steer'&&hostRequest(r,task.conversationKey)&&r.paramsHash===sha256(canonicalJson({task_id:task.taskId,message:plan.guidance.message}))),reply=steer&&records.find(r=>r.event==='response'&&r.correlationId===steer.correlationId&&!r.isError),wait=tools.find(t=>t.toolName==='pwsh'&&t.commandHash===c.observation.waitCommandHash);
    const acks=events.filter(e=>e.event==='guidance-ack');
    need(!!reply?.messageId&&acks.some(e=>e.agentId===task.sessionId&&e.messageIds?.includes(reply.messageId)&&e.seq<wait?.seq&&events.some(p=>p.event==='guidance-result-persisted'&&p.callId===e.callId&&p.messageIds?.includes(reply.messageId)&&p.seq<e.seq)),'Guidance ACK missing, not main-only, or before persistence / after wait.');
    need(reports.some(r=>r.agentRole==='main'&&r.text.includes(plan.guidance.token)),'Guidance receipt token was not reported by the main agent.');
    const cancel=records.find(r=>r.event==='request'&&r.tool==='dsh_cancel'&&hostRequest(r,task.conversationKey)&&r.paramsHash===sha256(canonicalJson({task_id:task.taskId})));
    need(!!wait&&wait.background===false&&wait.timeoutMs===240000&&observations.some(o=>o.waitCallId===wait.callId&&o.waitCommandHash===wait.commandHash&&o.at<=cancel?.at&&o.processes.some(p=>/^(?:pwsh|powershell)(?:\.exe)?$/i.test(p.name))),'Real foreground waiting shell before cancel missing.');
    need(!!cancel&&settled.finishedAt>=cancel.at&&settled.finishedAt-cancel.at<=30000,'Explicit cancel/30-second exit evidence missing.');
    need(observations.length>0&&observations.flatMap(o=>o.observedPids).every(pid=>processAlive(pid)===false),'Observed cancellation descendant exit unconfirmed.');
  }
  if(['S1','S2'].includes(c.id)) {
    const peerId=c.id==='S1'?'S2':'S1',peerLife=records.filter(r=>r.caseId===peerId&&r.event==='task-lifecycle'),ownLife=records.filter(r=>r.caseId===c.id&&r.event==='task-lifecycle'),one=ownLife.find(r=>r.patch?.processStartedAt),two=peerLife.find(r=>r.patch?.processStartedAt),peerEnd=peerLife.find(r=>r.phase==='settled'),peerAccepted=peerLife.find(r=>r.phase==='accepted');
    const peerEvents=peerAccepted?.paths?.dir?readNdjson(path.join(peerAccepted.paths.dir,'acceptance-events.ndjson')):[],ownStart=tools.find(e=>e.agentRole==='main')?.ts,peerStart=peerEvents.find(e=>e.event==='permission-pre-tool'&&e.agentRole==='main')?.ts;
    need(!!one&&!!two&&!!peerEnd&&Number.isFinite(ownStart)&&Number.isFinite(peerStart)&&Math.max(ownStart,peerStart)<Math.min(settled.finishedAt,peerEnd.finishedAt),'Actual peer tool execution interval missing or not overlapping; preparation-process overlap is insufficient.');
    const peerTask=peerAccepted&&fs.existsSync(peerAccepted.paths.result)?readJsonFile(peerAccepted.paths.result):null;
    need(!!peerTask&&task.sessionId!==peerTask.sessionId&&task.conversationKey!==peerTask.conversationKey,'A/B session or owner isolation failed.');
    const q=records.find(r=>r.event==='request'&&r.tool==='dsh_status'&&hostRequest(r,peerTask?.conversationKey)&&r.paramsHash===sha256(canonicalJson({task_id:task.taskId,cursor:0,wait_ms:0,limit:200}))),reply=q&&records.find(r=>r.event==='response'&&r.correlationId===q.correlationId);
    need(!!reply&&reply.isError===true&&reply.errorCode==='TASK_NOT_FOUND'&&reply.mentionedMarkers?.length===0,'Actual cross-chat query denial / marker nonleakage missing.');
    const peerMarker=plan.cases.find(v=>v.id===peerId).expectedMarker;
    need(reports.every(r=>!JSON.stringify(r).includes(peerMarker)),'Peer synthetic marker leaked into owned reports.');
  }
  if(c.id==='S3') {
    need(tools.length===0,'Continuation replayed old actions or used a tool.');
    const created=events.find(e=>e.event==='permission-created'&&e.agentRole==='main'),actions=events.filter(e=>['permission-pre-model','permission-pre-tool','permission-model-request'].includes(e.event));
    need(!!created&&created.sandboxMode==='read-only'&&actions.length>0&&actions.every(e=>e.sandboxMode==='read-only'&&e.seq>created.seq),'Read-only narrowing was not proven before the first model/tool action.');
    const file=path.join(root,'host-S3-reconnect.json'),att=fs.existsSync(file)?readJsonFile(file):null,prior=records.find(r=>r.caseId==='S2'&&r.phase==='settled'),first=records.find(r=>r.caseId==='S1'&&r.phase==='settled'),health=records.filter(r=>r.event==='health'&&hostIdentity(r,task.conversationKey)),before=att&&health.findLast(r=>r.at<att.disconnectedAt&&r.at>=Math.max(prior?.finishedAt??Infinity,first?.finishedAt??Infinity)),after=att&&health.find(r=>r.at>att.reconnectedAt&&r.at<accepted.at);
    need(att?.userUi===true&&att.threadId===task.conversationKey&&att.disconnectedAt>=Math.max(prior?.finishedAt??Infinity,first?.finishedAt??Infinity)&&att.reconnectedAt>att.disconnectedAt&&!!before&&!!after&&before.instanceId!==after.instanceId,'Reconnect specific to S3 after both tasks exit is not proven.');
  }
  if(c.id==='S4') {
    const life=records.filter(r=>r.caseId==='S4'&&r.event==='task-lifecycle'),start=life.find(r=>r.patch?.processStartedAt),wait=tools.find(t=>t.toolName==='pwsh'&&t.commandHash===c.observation.waitCommandHash);
    need(!!start&&!!wait&&wait.background===false&&wait.timeoutMs===240000&&observations.some(o=>o.waitCallId===wait.callId&&o.waitCommandHash===wait.commandHash&&o.at>=start.patch.processStartedAt&&o.at-start.patch.processStartedAt<=60000&&o.processes.some(p=>/^(?:pwsh|powershell)(?:\.exe)?$/i.test(p.name))),'Real 180-second waiting shell was not observed within 60 seconds.');
    need(observations.length>0&&observations.flatMap(o=>o.observedPids).every(pid=>processAlive(pid)===false),'Observed timeout descendant exit unconfirmed.');
    need(life.some(r=>r.phase==='executing')&&task.finishedAt>=task.deadline&&task.finishedAt-task.deadline<=30000&&task.reason?.kind==='timeout','Timeout did not occur during verified real execution.');
    need(!records.some(r=>r.event==='request'&&r.tool==='dsh_cancel'&&r.taskId===task.taskId)&&!records.some(r=>r.event==='foreground-cancel-signal'&&r.caseId==='S4'),'S4 was explicitly cancelled instead of timing out.');
    need(!results.some(r=>r.toolName==='pwsh'&&r.shell?.timedOut&&r.ts<task.deadline),'Shell tool timeout cannot substitute for top-level execution timeout.');
  }
  return errors;
}
export function verifySmoke4Case(root,plan,id,{write=false}={}) {
  if(suiteOf(plan)!=='smoke4'||!/^S[1-4]$/.test(id))throw new Error('smoke4 verifier rejects full-suite or unknown cases.');
  validateAcceptancePlan(plan);const proof=verifyCase(root,plan,id),c=plan.cases.find(c=>c.id===id),records=auditRecords(root),life=records.filter(r=>r.caseId===id&&r.event==='task-lifecycle'),accepted=life.find(r=>r.phase==='accepted'),settled=life.findLast(r=>r.phase==='settled');
  if(accepted&&settled&&fs.existsSync(accepted.paths.result)) {
    const task=readJsonFile(accepted.paths.result),events=readNdjson(path.join(accepted.paths.dir,'acceptance-events.ndjson')),observations=readNdjson(path.join(root,'process-observations',id+'.ndjson')),reports=readNdjson(path.join(path.dirname(path.dirname(accepted.paths.dir)),'reports.ndjson')).filter(r=>r.taskId===task.taskId);
    proof.errors.push(...smoke4BehaviorErrors({root,plan,c,task,events,records,accepted,settled,observations,reports}));
    const reservationFile=path.join(root,'batches','host','reservations',id+'.json'),authFile=path.join(root,'batches','host','authorization.json');
    if(fs.existsSync(reservationFile)&&fs.existsSync(authFile)){const reservation=readJsonFile(reservationFile),auth=readJsonFile(authFile);if(suiteOf(reservation)!=='smoke4'||suiteOf(auth)!=='smoke4'||auth.cap!==4)proof.errors.push('Reservation/authorization suite drift.');}
    if(id==='S3'&&!verifyHostRouting(root,plan).passed)proof.errors.push('Reconnect did not retain actual host identity/runtime/state.');
  }
  proof.suite='smoke4';proof.passed=proof.errors.length===0;
  if(write){writeExclusiveJson(path.join(root,'results',id+'.json'),proof);if(!proof.passed)stopAcceptance(root,{caseId:id,kind:'smoke4-evidence-insufficient',errors:proof.errors});}return proof;
}
