/** Staged acceptance. Default budget ZERO; no bootstrap or automatic retries. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
export function parseArguments(argv) {
  const [mode,...rest]=argv;if(!['prepare','dsh','host','high','seal'].includes(mode))throw new Error('Mode: prepare | dsh | host | high | seal');
  const bool=new Set(['authorize-model-cost','authorize-danger-full-access','verify-only','preflight','watch']);
  const values=new Set(['candidate','evidence','control-root','fixtures-root','authorization-ref','expires-ms','watch-ms','case','suite']);
  const options={mode};
  for(let i=0;i<rest.length;i++) {
    const key=rest[i].replace(/^--/,'');if(!rest[i].startsWith('--')||Object.hasOwn(options,key)||!bool.has(key)&&!values.has(key))throw new Error('Unknown/duplicate option: '+rest[i]);
    if(bool.has(key))options[key]=true;else {const value=rest[++i];if(!value||value.startsWith('--'))throw new Error('Missing --'+key+' value.');options[key]=value;}
  }
  options.suite ??= 'full';
  if(!['full','smoke4'].includes(options.suite))throw new Error('--suite must be full or smoke4.');
  if(options.suite==='smoke4'&&options['authorize-danger-full-access'])throw new Error('smoke4 never authorizes full access.');
  if(options.suite==='smoke4'&&['dsh','high'].includes(mode))throw new Error('smoke4 is host-only; dsh/high stages are forbidden.');
  for(const key of ['candidate','evidence','control-root']) if(!options[key]||!path.isAbsolute(options[key]))throw new Error('--'+key+' must be an absolute path.');
  if(options['fixtures-root']&&!path.isAbsolute(options['fixtures-root']))throw new Error('--fixtures-root must be absolute.');
  if(options.case&&(!options['verify-only']||!(options.suite==='smoke4'?/^S[1-4]$/:/^[DHX][1-8]$/).test(options.case)))throw new Error('--case requires verification-only and a valid matrix case.');
  const paid=['dsh','host','high'].includes(mode)&&!options['verify-only']&&!options.preflight;
  if(paid&&(!options['authorize-model-cost']||!options['authorization-ref']))throw new Error('Refused: stage-specific new human model-cost authorization is required; no task was submitted.');
  if(paid&&mode==='high'&&!options['authorize-danger-full-access'])throw new Error('Refused: FULL ACCESS is not constrained by fixtures. Separate danger-full-access authorization is required.');
  if(['prepare','seal'].includes(mode)&&(options['authorize-model-cost']||options['authorize-danger-full-access']))throw new Error('Preparation/sealing cannot consume a paid authorization.');
  if(options['verify-only']&&options['authorize-model-cost'])throw new Error('Verification must not issue a new authorization.');
  return options;
}
export function assertUnfrozenEvidence(evidence) {
  let current=path.resolve(evidence);
  while(true) {
    if(fs.existsSync(current)&&fs.lstatSync(current).isSymbolicLink())throw new Error('Linked evidence ancestor refused.');
    if(fs.existsSync(path.join(current,'evidence-sha256.txt'))||fs.existsSync(current+'.sha256'))throw new Error('Frozen evidence ancestor cannot receive new files. Use a NEW independent evidence directory.');
    const parent=path.dirname(current);if(parent===current)return;current=parent;
  }
}
export async function main(argv=process.argv.slice(2)) {
  const o=parseArguments(argv),candidateRoot=fs.realpathSync.native(o.candidate),node=path.join(candidateRoot,'runtime','node.exe'),entry=path.join(candidateRoot,'test','joint-acceptance.mjs');
  // Source entry only dispatches. ALL actual work runs the frozen candidate entry/runtime.
  if(path.resolve(process.execPath)!==node||path.resolve(fileURLToPath(import.meta.url))!==entry) {
    if(!fs.existsSync(node)||!fs.existsSync(entry))throw new Error('Candidate lacks its bundled runtime / acceptance entry. Build a new independent candidate.');
    const env={...process.env};for(const k of ['NODE_OPTIONS','NODE_PATH','CODEX_DSH_MCP_ALLOW_PROVISION','CODEX_DSH_MCP_ACCEPTANCE_TASK','CODEX_DSH_MCP_ACCEPTANCE_CONTROL'])delete env[k];
    const r=spawnSync(node,[entry,...argv],{cwd:os.tmpdir(),env,stdio:'inherit',windowsHide:true});if(r.error)throw r.error;if(r.status!==0)throw new Error('Candidate acceptance exited '+r.status);return;
  }
  const load=rel=>import(pathToFileURL(path.join(candidateRoot,rel)).href);
  const artifacts=await load('lib/joint-artifacts.js'),budget=await load('lib/acceptance.js'),baseMatrix=await load('lib/joint-matrix.js'),profileLib=await load('lib/dsh-profile.js'),integrity=await load('lib/win-integrity.js'),lock=await load('lib/file-lock.js');
  const smoke=o.suite==='smoke4'?await load('lib/smoke4-matrix.js'):null;
  const matrix=smoke?{...baseMatrix,createMatrix:smoke.createSmoke4Matrix,verifyCase:smoke.verifySmoke4Case}:baseMatrix;
  const {verifyCandidate,readJsonFile,writeExclusiveJson,appendDurableJson,shaFile,sha256,collectHashes,canonicalJson}=artifacts;
  const candidate=verifyCandidate(candidateRoot),root=path.resolve(o['control-root']),evidence=path.resolve(o.evidence);
  if(evidence.startsWith(candidateRoot+path.sep)||root.startsWith(candidateRoot+path.sep))throw new Error('Frozen candidate directories cannot receive controls or evidence.');
  if(fs.existsSync(path.join(evidence,'evidence-sha256.txt'))||fs.existsSync(evidence+'.sha256'))throw new Error('Frozen evidence cannot be reopened for writing. Use a NEW evidence directory.');
  assertUnfrozenEvidence(evidence);
  fs.mkdirSync(evidence,{recursive:true});
  const cleanEnv=()=>{const env={...process.env};for(const k of ['NODE_PATH','NODE_OPTIONS','CODEX_DSH_MCP_ALLOW_PROVISION','CODEX_DSH_MCP_ACCEPTANCE_TASK','CODEX_DSH_MCP_ACCEPTANCE_CONTROL','CODEX_DSH_MCP_CONVERSATION','CODEX_DSH_MCP_MULTIPLEX'])delete env[k];return env;};
  const save=(name,value)=>writeExclusiveJson(path.join(evidence,name),value);
  async function probeInstalled(installed,expected=candidate) {
    const copy=verifyCandidate(installed,expected),env=cleanEnv(),results={root:copy.root,fingerprint:copy.fingerprint,manifestSha256:copy.manifestSha256,files:copy.fileCount,runtime:process.execPath};
    for(const [name,file,args] of [['guardian','scripts/check-guardian.js',[]],['api','scripts/check-dsh-contract.js',[]],['package','scripts/validate-package.js',[]],['offline','scripts/check-release.js',[copy.root]]]) {
      const r=spawnSync(path.join(copy.root,'runtime/node.exe'),[path.join(copy.root,file),...args],{cwd:os.tmpdir(),env,encoding:'utf8',windowsHide:true,timeout:180000,maxBuffer:16*1024*1024});
      if(r.error||r.status!==0)throw new Error('Candidate/installed '+name+' no-model gate failed: '+(r.error?.message ?? r.stderr));
      results[name]=JSON.parse(r.stdout.trim());
    }
    results.guardianLabel=integrity.readIntegrityLabel(path.join(copy.root,'native/windows-job-host.exe'));results.runtimeLabel=integrity.readIntegrityLabel(path.join(copy.root,'runtime/node.exe'));
    if(results.guardianLabel.level==='low'||results.runtimeLabel.level==='low'||!results.guardian.stateWritable||!results.guardian.treeExited)throw new Error('Installed runtime/guardian label or real write probe failed.');
    return results;
  }
  function checkStateSettled(plan) {
    const tasks=[];if(!fs.existsSync(plan.stateRoot))return tasks;
    function walk(dir){for(const name of fs.readdirSync(dir)){const f=path.join(dir,name),s=fs.lstatSync(f);if(s.isSymbolicLink()||/quarantine|\.lock(?:$|\.claim-)/i.test(name))throw new Error('Unknown retained state/lock/quarantine; stop WITHOUT clearing: '+f);if(s.isDirectory())walk(f);else if(name==='task.json'){const t=readJsonFile(f);if(!['completed','cancelled','timeout','failed'].includes(t.state)||t.treeExited!==true)throw new Error('Prior state is not safely settled.');for(const k of ['processPid','workerPid','guardianPid'])if(t[k]!==undefined&&lock.processAlive(t[k])!==false)throw new Error('Prior PID is live or unknown; no killing or retry.');tasks.push({taskId:t.taskId,state:t.state,sessionId:t.sessionId});}}}
    walk(plan.stateRoot);return tasks;
  }
  function verifyDefaultModel(runtime) {
    const {readAsarFile}=asarModule,base=readAsarFile(runtime.launcher.archive,'dsh/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml').toString('utf8');
    const block=base.match(/- id: agent-default-model\s+name: [^\n]+\s+config:\s+provider: ([^\s]+)\s+model: ([^\s]+)/);
    if(!block||block[1]!=='deepseek-official'||block[2]!=='deepseek-flash')throw new Error('Required existing default provider/model missing or changed. No fallback is permitted.');
    const patch=path.join(runtime.home,'cordis.patch.yml');if(fs.existsSync(patch)&&/agent-default-model|provider\s*:|model\s*:/i.test(fs.readFileSync(patch,'utf8')))throw new Error('Home-level model configuration needs review; do not override it.');
    if(!fs.existsSync(path.join(runtime.home,'.credentials.yaml'))&&!Object.keys(process.env).some(k=>/DEEPSEEK.*(?:KEY|TOKEN)/.test(k)))throw new Error('Missing default-model credential configuration. No task will be submitted.');
    return {provider:block[1],model:block[2],source:'installed immutable base bundle; no managed/home model override',bundleSha256:sha256(base),credentialsAvailable:true,credentialsRecorded:false,providerModelOverride:false};
  }
  const asarModule=await load('lib/asar.js');
  if(o.mode==='prepare') {
    if(fs.existsSync(path.join(root,'plan.json')))throw new Error('An existing acceptance plan cannot be reset.');
    const probe=await probeInstalled(candidateRoot);save('candidate-no-model.json',probe);
    const env=cleanEnv(),runtime=profileLib.resolveRuntime(env);profileLib.assertCompatibleRuntime(runtime);const p=profileLib.inspectBridgeProfile({env:runtime.env,runtime});
    const fixtures=path.resolve(o['fixtures-root'] ?? path.join(path.dirname(root),'fixtures-'+path.basename(root)));
    if(fixtures===root||root.startsWith(fixtures+path.sep)||fixtures.startsWith(root+path.sep)||fs.existsSync(fixtures))throw new Error('New, independent fixtures must not overlap the budget root or an existing directory.');
    const plan=matrix.createMatrix({root:fixtures,candidate,home:runtime.home,profileFingerprint:p.fingerprint});
    const defaultModel=verifyDefaultModel(runtime);plan.defaultModel=defaultModel;for(const c of plan.cases)c.observation.expectedModel={provider:defaultModel.provider,model:defaultModel.model};
    budget.initializeAcceptance(root,plan);fs.mkdirSync(plan.stateRoot,{recursive:true});
    const budgetLabel=integrity.readIntegrityLabel(root);if(budgetLabel.level==='low')throw new Error('Private budget root must be outside the Low-inherited repository and fixture write roots.');
    const controls={};for(const batch of Object.keys(budget.acceptanceCaps(plan)).filter(b=>budget.acceptanceCaps(plan)[b]>0)){const file=path.join(root,'control-templates',batch+'.json');const control={version:1,suite:o.suite,enabled:true,root,batch,candidate:plan.candidate,stateRoot:plan.stateRoot,home:plan.home,hostPreflight:plan.hostPreflight===true};writeExclusiveJson(file,control);controls[batch]=file;}
    save('prepared-plan.json',plan);save('prepared-zero-budget.json',{at:Date.now(),suite:o.suite,planningCaps:budget.acceptanceCaps(plan),candidateRoot,entry,runtime:process.execPath,sdkSource:path.join(candidateRoot,'node_modules/@modelcontextprotocol/sdk/dist/esm'),profile:{name:p.name,fingerprint:p.fingerprint,ready:p.ready},bootstrapPerformed:false,modelCalls:0,newTopLevelAttempts:0,authorized:{dsh:0,host:0,high:0},budgetLabel,controlRoot:root,controls,fixtureRoot:fixtures,defaultModel});
    fs.writeFileSync(path.join(evidence,'host-steps.md'),renderHostSteps(plan,controls));
    console.log(JSON.stringify({prepared:true,suite:o.suite,planningCaps:budget.acceptanceCaps(plan),initialBudget:0,profile:p.name,ready:p.ready,root,modelCalls:0,entry,runtime:process.execPath,userUiInstallationPending:true},null,2));return;
  }
  const plan=readJsonFile(path.join(root,'plan.json'));
  if(budget.suiteOf(plan)!==o.suite)throw new Error('CLI suite differs from immutable plan; no evidence or authorization may be reused across suites.');
  verifyCandidate(candidateRoot,plan.candidate);
  const runtime=profileLib.resolveRuntime({...cleanEnv(),DSH_HOME:plan.home}),p=profileLib.inspectBridgeProfile({runtime,env:runtime.env});
  if(o.mode==='seal') {
    const states=checkStateSettled(plan),records=matrix.auditRecords(root),caps=budget.acceptanceCaps(plan),summary={version:'0.1.1',suite:o.suite,qualification:'candidate-not-release-qualified',candidate:{directory:candidateRoot,fingerprint:candidate.fingerprint,manifestSha256:candidate.manifestSha256},profile:{name:p.name,fingerprint:p.fingerprint,ready:p.ready},states,planningCaps:caps,authorized:{},reserved:{},results:{},sourceEvidenceLevels:['no-model-API','managed-process','real-model','real-host'],automaticRetries:0};
    for(const batch of Object.keys(caps)){const base=path.join(root,'batches',batch);summary.authorized[batch]=fs.existsSync(path.join(base,'authorization.json'))?readJsonFile(path.join(base,'authorization.json')).cap:0;summary.reserved[batch]=fs.readdirSync(path.join(base,'reservations')).filter(n=>n.endsWith('.json')).length;summary.results[batch]=fs.existsSync(path.join(root,'results',batch+'-batch.json'))?readJsonFile(path.join(root,'results',batch+'-batch.json')):{passed:false,pending:true};}
    save('staged-summary.json',summary);snapshot(root,path.join(evidence,'private-control-snapshot'));if(fs.existsSync(plan.stateRoot))snapshot(plan.stateRoot,path.join(evidence,'state-snapshot'));save('synthetic-sentinel-hashes.json',Object.fromEntries(Object.keys(plan.syntheticFiles).map(f=>[f,fs.existsSync(f)?shaFile(f):null])));
    const hashes=collectHashes(evidence),text=Object.entries(hashes).map(([rel,v])=>v.sha256+'  '+rel).join('\n')+'\n';const fd=fs.openSync(path.join(evidence,'evidence-sha256.txt'),'wx');try{fs.writeFileSync(fd,text);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.writeFileSync(evidence+'.sha256',shaFile(path.join(evidence,'evidence-sha256.txt'))+'  evidence-sha256.txt\n',{flag:'wx'});console.log(JSON.stringify({sealed:true,evidence,files:Object.keys(hashes).length,summary},null,2));return;
  }
  if(o.preflight) {
    const routing=matrix.verifyHostRouting(root,plan),installed=[];const roots=[...new Set(matrix.auditRecords(root).filter(r=>r.event==='health').map(r=>r.runtimeInfo.bridgeRoot))];
    for(const installedRoot of roots)installed.push(await probeInstalled(installedRoot,plan.candidate));
    const passed=routing.passed&&p.ready&&p.fingerprint===plan.candidate.profileFingerprint&&installed.length>0;const proof={...routing,suite:o.suite,passed,profileReady:p.ready,installed,defaultModel:verifyDefaultModel(runtime),verifiedAt:Date.now()};
    save('setup-verification.json',proof);if(passed)writeExclusiveJson(path.join(root,'setup-verification.json'),proof);console.log(JSON.stringify(proof,null,2));if(!passed)throw new Error('Host/profile/bootstrap/installed no-model preflight is pending; zero model tasks accepted.');return;
  }
  const batch=o.mode==='high'?'high':o.mode;
  if(!o['verify-only']) {
    if(!p.ready||p.fingerprint!==plan.candidate.profileFingerprint)throw new Error('New immutable profile must be separately authorized and bootstrapped before any paid stage.');
    verifyDefaultModel(runtime);checkStateSettled(plan);
    const setup=readJsonFile(path.join(root,'setup-verification.json')),previous=(o.suite==='smoke4'?[]:['dsh','host']).filter(b=>batch==='high'||batch==='host'&&b==='dsh').map(b=>readJsonFile(path.join(root,'results',b+'-batch.json')));
    const auth=budget.authorizeAcceptance(root,batch,{reference:o['authorization-ref'],expiresAt:Date.now()+Number(o['expires-ms'] ?? 7200000),explicitCostAuthorization:o['authorize-model-cost']===true,explicitDangerAuthorization:o['authorize-danger-full-access']===true,setupProof:setup,identities:setup.identities,previousProofs:previous});save(batch+'-authorization.json',auth);
  }
  if(batch==='dsh'&&!o['verify-only'])await executeDshBatch();
  else if(!o['verify-only']){fs.writeFileSync(path.join(evidence,batch+'-manual-steps.md'),renderHostSteps(plan,{host:path.join(root,'control-templates','host.json'),high:path.join(root,'control-templates','high.json')},batch));console.log('Stage authorized ONCE. Actual dsh_task calls must be made by the real user-operated host; this driver will not inject metadata or emit host tasks.');if(!o.watch)return;}
  if(o.watch)await watchHost();
  if(o.case) {
    const selected=plan.cases.find(c=>c.id===o.case&&c.batch===batch);if(!selected)throw new Error('Case is not in this stage.');
    const result=matrix.verifyCase(root,plan,o.case);save(o.case+'-verification.json',result);
    if(!result.passed){budget.stopAcceptance(root,{caseId:o.case,kind:'evidence-insufficient',errors:result.errors});throw new Error('Case evidence failed; stop without replay.');}
    const target=path.join(root,'results',o.case+'.json');if(!fs.existsSync(target))writeExclusiveJson(target,result);console.log(JSON.stringify(result,null,2));return;
  }
  const results=plan.cases.filter(c=>c.batch===batch).map(c=>matrix.verifyCase(root,plan,c.id));
  const complete=results.every(r=>r.passed),proof={suite:o.suite,batch,passed:complete,casesPassed:results.filter(r=>r.passed).length,candidateFingerprint:candidate.fingerprint,results,verifiedAt:Date.now()};save(batch+'-batch-verification.json',proof);
  if(!complete){budget.stopAcceptance(root,{batch,kind:'matrix-evidence-failed',results});throw new Error('Matrix failed/incomplete. Stop this and all later batches; no automatic retries.');}
  if(!fs.existsSync(path.join(root,'results',batch+'-batch.json')))writeExclusiveJson(path.join(root,'results',batch+'-batch.json'),proof);console.log(JSON.stringify(proof,null,2));
  async function observeCase(c,task) {
    const events=matrix.readNdjson(path.join(task.paths.dir,'acceptance-events.ndjson')),waiting=events.findLast(e=>e.event==='permission-pre-tool'&&e.toolName==='pwsh'&&e.commandHash===c.observation.waitCommandHash&&!events.some(r=>r.event==='tool-result'&&r.callId===e.callId));
    const tree=matrix.captureProcessTree([task.processPid,task.guardianPid,task.workerPid].filter(v=>Number.isSafeInteger(v)&&v>0));
    const record={...tree,caseId:c.id,taskId:task.taskId,waitCallId:waiting?.callId ?? null,waitCommandHash:waiting?.commandHash ?? null};appendDurableJson(path.join(root,'process-observations',c.id+'.ndjson'),record);return record;
  }
  async function watchHost() {
    const until=Date.now()+Number(o['watch-ms'] ?? 700000);
    while(Date.now()<until) {
      if(fs.existsSync(path.join(root,'STOP.json')))throw new Error('Acceptance STOP record exists; inspect original evidence.');
      const records=matrix.auditRecords(root),accepted=records.filter(r=>r.event==='task-lifecycle'&&r.phase==='accepted'&&plan.cases.some(c=>c.id===r.caseId&&c.batch===batch));
      for(const a of accepted){
        const c=plan.cases.find(c=>c.id===a.caseId),taskFile=path.join(a.paths.dir,'task.json');if(!fs.existsSync(taskFile))continue;const task=readJsonFile(taskFile);
        if(task.processPid&&task.phase!=='settled'){
          const observed=await observeCase(c,task);
          if(c.observation.waitRequired&&Date.now()-task.processStartedAt>c.observation.waitObservationBudgetMs&&!matrix.readNdjson(path.join(root,'process-observations',c.id+'.ndjson')).some(o=>o.waitCallId&&o.processes.some(p=>/^(?:pwsh|powershell)(?:\.exe)?$/i.test(p.name)))){budget.stopAcceptance(root,{caseId:c.id,kind:'wait-process-timing-failure'});throw new Error('60-second shell timing gate failed; owned acceptance tasks will stop.');}
        }
        if(task.phase==='settled'&&!fs.existsSync(path.join(root,'results',c.id+'.json'))){
          const peer={S1:'S2',S2:'S1',H1:'H2',H2:'H1',H4:'H5',H5:'H4',H6:'H7',H7:'H6',X1:'X2',X2:'X1'}[c.id];
          if(peer&&!records.some(r=>r.caseId===peer&&r.phase==='settled'))continue;
          const result=matrix.verifyCase(root,plan,c.id),collectLater=/cross-chat query|Report paging|Reports not drained|Cursor report sequence|Cursor request|Reconnect did not retain/;
          if(result.passed){writeExclusiveJson(path.join(root,'results',c.id+'.json'),result);console.log(c.id+' verified; no task replay.');}
          else if(result.errors.some(e=>!collectLater.test(e))){budget.stopAcceptance(root,{caseId:c.id,kind:'fixed-evidence-failed',errors:result.errors});throw new Error('Actual host evidence failed; preserve original records.');}
        }
      }
      if(accepted.length===budget.acceptanceCaps(plan)[batch]&&accepted.every(a=>fs.existsSync(path.join(root,'results',a.caseId+'.json'))))return;
      await lock.delay(1000);
    }
    budget.stopAcceptance(root,{batch,suite:o.suite,kind:'watcher-expired-no-replay'});
    throw new Error('Host watcher expired without complete evidence. Inspect, cancel only owned tasks if needed; never resubmit a task.');
  }
  async function executeDshBatch() {
    const {Client}=await load('node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js'),{StdioClientTransport}=await load('node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js'),{CallToolResultSchema}=await load('node_modules/@modelcontextprotocol/sdk/dist/esm/types.js'),paths=await load('lib/paths.js');
    const owned=[],results=[];let callSeq=0;
    async function open(identity) {
      const env={...cleanEnv(),DSH_HOME:plan.home,CODEX_DSH_MCP_STATE:plan.stateRoot,CODEX_DSH_MCP_CONVERSATION:identity,CODEX_DSH_MCP_ACCEPTANCE_CONTROL:path.join(root,'control-templates/dsh.json')};
      const transport=new StdioClientTransport({command:node,args:[path.join(candidateRoot,'bin/codex-dsh-mcp.js')],cwd:os.tmpdir(),env,stderr:'pipe'}),client=new Client({name:'joint-acceptance-script-identity-not-host',version:'0.1.1'});await client.connect(transport);const b={client,transport,pid:transport.pid,identity};owned.push(b);appendDurableJson(path.join(evidence,'owned-bridges.ndjson'),{pid:b.pid,identity,at:Date.now(),runtime:node,bridge:path.join(candidateRoot,'bin/codex-dsh-mcp.js')});transport.stderr?.on('data',bytes=>appendDurableJson(path.join(evidence,'bridge-stderr.ndjson'),{pid:b.pid,text:bytes.toString('utf8')}));return b;
    }
    async function call(b,name,args,c) {
      const seq=++callSeq;
      if(name==='dsh_task')writeExclusiveJson(path.join(root,'client-attempts',c.id+'.json'),{version:1,at:Date.now(),caseId:c.id,candidate:plan.candidate,identity:b.identity,request:args,requestHash:sha256(canonicalJson(args)),topLevelAttempt:1});
      appendDurableJson(path.join(evidence,'mcp-calls.ndjson'),{phase:'request',seq,at:Date.now(),caseId:c?.id,identity:b.identity,name,args});
      try {const result=await b.client.request({method:'tools/call',params:{name,arguments:args}},CallToolResultSchema,{timeout:45000,resetTimeoutOnProgress:false});appendDurableJson(path.join(evidence,'mcp-calls.ndjson'),{phase:'response',seq,at:Date.now(),result});if(result.isError&&name!=='dsh_status')throw new Error('Tool refused: '+name+' '+JSON.stringify(result.structuredContent));return result;}
      catch(error){appendDurableJson(path.join(evidence,'mcp-calls.ndjson'),{phase:'error',seq,at:Date.now(),message:error.message,code:error.code});throw error;}
    }
    for(const c of plan.cases.filter(c=>c.batch==='dsh')) {
      let primary,other,taskId,observer,closed=false;
      try {
        primary=await open(c.identity);other=await open(c.identity.toLowerCase());await call(primary,'dsh_self_check',{},c);await call(other,'dsh_self_check',{},c);
        const initial=await call(primary,'dsh_task',c.args,c);taskId=initial.structuredContent.task_id;
        const taskPaths=paths.taskPaths(c.identity,taskId,plan.stateRoot),file=path.join(taskPaths.dir,'task.json');let shellSeen=false,observationError=null;
        observer=setInterval(()=>{try{if(fs.existsSync(file)){const task=readJsonFile(file);if(task.processPid&&task.phase!=='settled')observeCase(c,task).then(r=>{if(r.waitCallId&&r.processes.some(p=>/^(?:pwsh|powershell)(?:\.exe)?$/i.test(p.name)))shellSeen=true;}).catch(e=>observationError=e);}}catch(e){observationError=e;}},1000);
        if(c.id==='D3')await call(primary,'dsh_steer',{task_id:taskId,message:'Synthetic guidance: main agent must acknowledge this complete unique instruction after persisting its tool result. JOINT-GUIDANCE-'+crypto.randomUUID()},c);
        if(c.observation.waitRequired) {const until=Date.now()+60000;while(!shellSeen&&Date.now()<until){if(observationError)throw observationError;await lock.delay(250);}if(!shellSeen)throw new Error('Timing failure: real foreground wait not observed within 60 seconds; NOT execution-timeout success.');}
        if(c.id==='D4')await call(primary,'dsh_cancel',{task_id:taskId},c);
        if(c.id==='D8') {
          const process=primary.transport._process;if(!process?.stdin||process.pid!==primary.pid)throw new Error('Owned bridge stdin cannot be verified; no fake EOF.');appendDurableJson(path.join(root,'external-events.ndjson'),{event:'eof-stdin-closed',caseId:'D8',taskId,at:Date.now(),pid:primary.pid});process.stdin.end();closed=true;
          const until=Date.now()+30000;while(Date.now()<until&&(!fs.existsSync(file)||readJsonFile(file).phase!=='settled'||lock.processAlive(primary.pid)!==false))await lock.delay(100);if(lock.processAlive(primary.pid)!==false||readJsonFile(file).treeExited!==true)throw new Error('EOF exit unconfirmed within 30 seconds; retain quarantine.');primary=await open(c.identity);
        }
        let cursor=initial.structuredContent.cursor ?? 0,view;
        const until=Date.now()+c.args.timeout_ms+30000;
        while(Date.now()<until){if(observationError)throw observationError;const page=await call(primary,'dsh_status',{task_id:taskId,cursor,wait_ms:30000,limit:200},c);view=page.structuredContent;if(view.cursor<cursor)throw new Error('Cursor moved backwards.');cursor=view.cursor;if(['completed','failed','cancelled','timeout','interrupted'].includes(view.state)&&!view.has_more)break;}
        if(!view||!c.expectedStates.includes(view.state)||view.has_more)throw new Error('Unexpected terminal state or undrained reports.');
        const isolation=await other.client.request({method:'tools/call',params:{name:'dsh_status',arguments:{task_id:taskId,cursor:0,wait_ms:0,limit:200}}},CallToolResultSchema,{timeout:45000});appendDurableJson(path.join(evidence,'owner-isolation.ndjson'),{caseId:c.id,taskId,identity:other.identity,result:isolation});if(!isolation.isError||c.expectedMarker&&c.expectedMarker!=='DONE'&&JSON.stringify(isolation).includes(c.expectedMarker))throw new Error('Case-sensitive owner isolation failed.');
        clearInterval(observer);const result=matrix.verifyCase(root,plan,c.id,{write:true});save(c.id+'-verification.json',result);results.push(result);if(!result.passed)throw new Error('Evidence insufficient: '+result.errors.join('; '));
      } catch(error) {
        budget.stopAcceptance(root,{caseId:c.id,kind:'driver-failed-or-ambiguous',message:error.message});save(c.id+'-failure.json',{caseId:c.id,message:error.message,taskId:taskId ?? null,noReplay:true});throw error;
      } finally {
        clearInterval(observer);
        for(const b of [primary,other].filter(Boolean)){try{await b.client.close();await b.transport.close();}catch{}const until=Date.now()+30000;while(lock.processAlive(b.pid)!==false&&Date.now()<until)await lock.delay(100);appendDurableJson(path.join(evidence,'owned-exit.ndjson'),{pid:b.pid,identity:b.identity,exited:lock.processAlive(b.pid)===false,at:Date.now()});if(lock.processAlive(b.pid)!==false){budget.stopAcceptance(root,{caseId:c.id,kind:'bridge-exit-unconfirmed'});throw new Error('Owned bridge exit unconfirmed; do not kill unknown PIDs.');}}
      }
    }
  }
  function snapshot(from,to){if(fs.existsSync(to))throw new Error('Snapshot destination already exists.');fs.cpSync(from,to,{recursive:true,force:false,errorOnExist:true,filter:file=>{if(fs.lstatSync(file).isSymbolicLink())throw new Error('Linked evidence refused.');return true;}});}
}
export function renderHostSteps(plan,controls,batch='host') {
  if(plan.suite==='smoke4')return renderSmoke4HostSteps(plan,controls);
  const rows=plan.cases.filter(c=>c.batch===batch).map(c=>`### ${c.id} — chat ${c.chat}\n\nExact dsh_task arguments (one attempt only):\n\n\`\`\`json\n${JSON.stringify(c.args,null,2)}\n\`\`\`\n\nRequired evidence: ${c.requirements.join(', ')}\n`);
  return `# Real-host staged acceptance: ${batch}\n\nInitial budget is ZERO. 8+8+3 is planning only, not authorization. Do not submit a task until separate stage approval is recorded. No automatic retries, replacement cases, provider/model switches, state copies or manual session injection.\n\n1. User installs/enables the independent candidate through the app UI and creates test chats A/B. Do not edit a frozen package.\n2. In each chat, call only dsh_self_check first. Read actual PLUGIN_ROOT/PLUGIN_DATA. Put the host control template ${controls[batch] ?? controls.host} into each actual PLUGIN_DATA/acceptance/control.json with exclusive creation, then reconnect the idle plugin. Control selects this fresh shared state root: ${plan.stateRoot}; DSH_HOME: ${plan.home}. It does not enable multiplex automatically.\n3. Separately authorize/bootstrap the NEW immutable profile fingerprint ${plan.candidate.profileFingerprint}; old profiles remain untouched. Diagnose afterward and compare installed contents. Do not enable ongoing provisioning.\n4. Obtain three actual health calls per chat spanning an idle reconnect. In the private control root create host-chat-A.json/B.json containing version=1, userUi=true, the exact real threadId, reconnectAt (epoch milliseconds), requestTimeoutMs >=45000 and the actual inspected timeout configuration/proof. Do not inject metadata or fixed identities. Run host --preflight; missing routing/runtime/probe/timeout proof STOPS.\n5. Identify per-chat process vs shared process. For unsafe shared routing STOP. MULTIPLEX=1 needs explicit confirmation and a NEW independently built candidate; never modify this frozen one.\n6. Normal DSH stage first (8 separately authorized tasks); actual host stage next (8 separately authorized tasks). H1/H2 overlap; explicitly cancel H2, drain H1, query the other's task from both chats with {task_id:<other>,cursor:0,wait_ms:0,limit:200} and prove denial/no marker leak. H3: call health in B after H2 settles; idle disable/enable, call health again in B and create host-H3-reconnect.json in the private control root with userUi=true, exact threadId, disconnectedAt/reconnectedAt epoch milliseconds; then resume H2 in B. H4/H5 overlap workspaces (H4 launch first); H6/H7 disjoint (prove actual overlap). For H8 user cancels FRONTEND before 30-second detach. If propagation fails, mark compatibility failure; explicit dsh_cancel may only clean up, not turn it into a pass.\n7. Host calls use the exact task parameters below, 45-second verified RPC timeout, dsh_status wait_ms=30000, limit=200 and monotonic cursor until terminal AND has_more=false. Run the driver watcher concurrently to capture real descendant process observations. Send one synthetic guidance to H1 while active and drain ACK evidence. The watcher (or host --verify-only --case H1/H2, etc., using NEW evidence paths) must verify each settled predecessor/pair before the next case is accepted; missing evidence never releases a budget slot.\n8. High stage only after both previous stages pass and separate full-access + 3-task authorization. FULL ACCESS is NOT limited by the synthetic fixture locations. X1 starts first, X2 must wait even in a disjoint root; X3 resumes X1 read-only and must be pinned before any model/tool action.\n\nCandidate fingerprint: ${plan.candidate.fingerprint}\nManifest SHA-256: ${plan.candidate.manifestSha256}\n\n${rows.join('\n')}`;
}
export function renderSmoke4HostSteps(plan,controls) {
  const rows=plan.cases.map(c=>'### '+c.id+' — chat '+c.chat+'\n\nExact dsh_task arguments; ONE attempt only:\n\n'+ '\x60\x60\x60json\n'+JSON.stringify(c.args,null,2)+'\n\x60\x60\x60\n\nRequired evidence: '+c.requirements.join(', '));
  return '# Real-host smoke4: four top-level attempts, not a complete release gate\n\n'+
    'Initial live budget is ZERO. The human approved at most 4 attempts, including S3 continuation and any failed/unknown submit. Only activate that authorization AFTER real-host preflight. Never retry, replace a failed case, reuse a spent receipt, override a model, spawn children, provision automatically or use full access.\n\n'+
    '1. User manually installs/enables this NEW candidate in Codex and prepares chats A/B. In each chat call ONLY dsh_self_check initially. Record actual PLUGIN_ROOT/PLUGIN_DATA; do not fabricate metadata. Place the private control template '+controls.host+' into each actual PLUGIN_DATA/acceptance/control.json using exclusive creation, then reconnect only while idle. Both chats must use state '+plan.stateRoot+' and DSH_HOME '+plan.home+'. Do not overwrite an existing control.\n'+
    '2. Reuse the already-ready immutable profile '+plan.candidate.profileFingerprint+' only after diagnosis/content verification. If unready or changed STOP and obtain separate bootstrap permission; this four-attempt grant does not authorize provisioning.\n'+
    '3. New smoke4 self_check performs a zero-model native state-write probe and a >=45s diagnostic round trip. Capture three actual dsh_self_check calls per chat across an idle reconnect. Write host-chat-A.json/B.json in the PRIVATE control root with version=1, userUi=true, exact observed threadId, reconnectAt Unix milliseconds, requestTimeoutMs>=45000, and timeoutConfiguration={path:<actual config>,sha256:<actual file hash>,section:<actual mcp_servers.*dsh section>}. For the new private hostPreflight=true plan, rpcProof={kind:observed-host-round-trip,correlationId:<actual successful 45s health correlation>,receipt:{source:codex-persisted-mcp-result,threadId:<actual thread>,calledAt:<exact event timestamp>,resultAt:<exact event timestamp>,callPayload:<exact native function_call>,resultPayload:<exact native function_call_output>}} replaces unsupported plugin timeout overrides, and requestTimeoutMs=45000 records only the OBSERVED lower bound, not a configured value. No synthetic clients, guessed IDs or unsupported config keys. Missing effective timeout/routing proof STOPS before cost. Shared unsafe routing STOPS; never enable multiplex automatically.\n'+
    '4. Run host --suite smoke4 --preflight using the candidate bundled runtime and NEW evidence directory. Only after it passes, activate the four-item human grant ONCE with host --suite smoke4 --authorize-model-cost --authorization-ref <this user authorization> --watch. The driver NEVER submits real-host tasks or injects thread metadata. Restart observation with --verify-only --watch, never a second authorization.\n'+
    '5. Chat A submits S1 once, background=false. Its actual first 45-second wait must cross the 30-second detach. Preserve task_id and returned cursor. Chat B submits S2 once only after the observer proves S1 completed its real initial 45-second shell wait successfully and remains active (a started preparation process alone is refused). While A waits, B writes only synthetic fixtures.\n'+
    '6. When S2 reports ready-for-steer, send exactly ONE dsh_steer with message: '+JSON.stringify(plan.guidance.message)+'. The agent waits 30 seconds then checks its inbox once; missing guidance is a failure, not permission to retry. Wait for durable main ACK and observation of its genuine 180-second shell, then dsh_cancel exactly that owned task. Confirm all descendants exited within 30 seconds.\n'+
    '7. A must let the three small S1 reports accumulate AFTER detach before polling with limit=1. Continue its returned cursor, wait_ms<=30000, drain through terminal and has_more=false. Other owned polling can use limit=200. For both A and B, query the OTHER task with {task_id:<other>,cursor:0,wait_ms:0,limit:200}; retain actual denial and nonleakage. Never count these no-model status calls as extra tasks.\n'+
    '8. The watcher verifies S1/S2 as a pair. AFTER both are settled and verified, call health in B, manually disable/re-enable the idle plugin, call health again in B. Record host-S3-reconnect.json with version=1,userUi=true, exact B threadId, disconnectedAt/reconnectedAt Unix milliseconds; the reconnect must be AFTER both tasks exited, and health records must span different bridge instances. Then B submits S3 once, read-only and new_session=false, exact S2 workspace. Do not supply the remembered marker, inject a session ID, replay work or replace failed continuation with a new session.\n'+
    '9. Only after S3 verifies, A submits S4 once. Do NOT cancel it: observe the real foreground 180-second pwsh within 60 seconds and the 120-second TOP-LEVEL execution deadline, not startup/queue or shell-tool timeout. Confirm tree exit, preserve cursor and drain status.\n'+
    '10. Any unexpected failure, ambiguous response, missing fixed evidence or unknown PID STOPS future paid submissions. Only cancel known owned tasks; never clear locks/quarantine. Seal only after every PID has a confirmed exit. This proves only smoke4; child/full-access/write-lock/frontend-cancel/EOF/real-large-report gates remain pending. Four attempts are not four model requests or a monetary hard cap.\n\n'+
    'Candidate fingerprint: '+plan.candidate.fingerprint+'\nManifest SHA-256: '+plan.candidate.manifestSha256+'\n\n'+rows.join('\n\n');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try{await main();}catch(error){console.error('joint-acceptance: '+error.message);process.exitCode=1;}
}
