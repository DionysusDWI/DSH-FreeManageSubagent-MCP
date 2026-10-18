/** Default-off permission/action timing evidence for synthetic acceptance only. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {withFileLockSync} from './file-lock.js';
import {appendJsonLine} from './io.js';
const digest=v=>crypto.createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');
export function createAcceptanceObserver(config,env=process.env) {
  if(!env.DSH_MCP_ACCEPTANCE_TASK) return null;
  const receipt=JSON.parse(env.DSH_MCP_ACCEPTANCE_TASK);
  if(receipt.version!==2||receipt.bridgeVersion!=='0.1.4'||receipt.taskId!==config.taskId||receipt.identity!==config.conversationKey||typeof receipt.correlationId!=='string'||typeof receipt.caseId!=='string'||!Number.isInteger(receipt.observation?.maxChildren)) throw new Error('Acceptance task observation owner/correlation mismatch.');
  const file=path.join(config.dir,'acceptance-events.ndjson'),children=new Set(),policy=receipt.suite==='smoke4'?receipt.observation.toolPolicy:null;
  if(receipt.suite==='smoke4'&&(!policy||!['allowedTools','files','commandHashes'].every(k=>Array.isArray(policy[k]))||!policy.commandTargets||typeof policy.commandTargets!=='object'||policy.commandHashes.some(hash=>!Array.isArray(policy.commandTargets[hash])))) throw new Error('smoke4 requires a bound pre-tool action policy; execution is refused.');
  function record(event,details={}) {
    withFileLockSync(file+'.lock',()=> {
      let seq=0;
      if(fs.existsSync(file)) {
        const lines=fs.readFileSync(file,'utf8').trimEnd().split('\n').filter(Boolean);
        if(lines.length) {const last=JSON.parse(lines.at(-1));if(last.taskId!==config.taskId||last.conversationKey!==config.conversationKey)throw new Error('Acceptance evidence owner drift.');seq=last.seq;}
      }
      appendJsonLine(file,{version:2,bridgeVersion:'0.1.4',seq:seq+1,event,eventId:crypto.randomUUID(),ts:Date.now(),pid:process.pid,...details,version:2,taskId:config.taskId,conversationKey:config.conversationKey,caseId:receipt.caseId,correlationId:receipt.correlationId});
    });
  }
  function toolFacts(exec) {
    const args=exec.arguments ?? {},toolName=typeof exec.name==='string'?exec.name:'unknown';
    const facts={toolName,callId:exec.callId ?? null,rootCallId:exec.rootCallId ?? null,argumentsHash:digest(args),hasModelOverride:args.provider!==undefined||args.model!==undefined,
      escalationRequested:Object.keys(args).some(k=>/escalat|permission|sandbox/i.test(k)),background:args.background ?? args.run_in_background ?? null,timeoutMs:args.timeoutMs ?? null};
    if(typeof args.command==='string') facts.commandHash=digest(args.command);
    if(typeof args.content==='string') facts.contentHash=digest(args.content);
    if(typeof args.file_path==='string') {
      const resolved=path.resolve((config.workingDirectory?.(exec.agent.session)??exec.agent.session.header.cwd),args.file_path);
      if((receipt.observation.fixtureRoots ?? []).some(r=>resolved===path.resolve(r)||resolved.startsWith(path.resolve(r)+path.sep))) facts.syntheticFile=resolved;
      else facts.filePathHash=digest(resolved);
    }
    return facts;
  }
  const normalized=p=>process.platform==='win32'?path.resolve(p).toLowerCase():path.resolve(p);
  function realActionPath(file) {
    let existing=path.resolve(file),tail=[];
    while(!fs.existsSync(existing)){const parent=path.dirname(existing);if(parent===existing)throw new Error('No verified path ancestor');tail.unshift(path.basename(existing));existing=parent;}
    return path.join(fs.realpathSync.native(existing),...tail);
  }
  return {record,toolFacts,
    guardTool(exec) {
      if(!policy)return;
      const args=exec.arguments ?? {},facts=toolFacts(exec);let denied=!policy.allowedTools.includes(exec.name)||facts.hasModelOverride||facts.escalationRequested;
      if(['read','write'].includes(exec.name)) {
        if(typeof args.file_path!=='string')denied=true;
        else {const resolved=path.resolve(exec.agent.session.header.cwd,args.file_path);try{denied ||= !policy.files.some(f=>normalized(f)===normalized(resolved))||normalized(realActionPath(resolved))!==normalized(resolved);}catch{denied=true;}}
      }
      if(exec.name==='pwsh') {
        const hash=typeof args.command==='string'?digest(args.command):null,targets=hash&&policy.commandTargets[hash];
        denied ||= !hash||!policy.commandHashes.includes(hash)||facts.background!==false||args.timeoutMs!==240000||!Array.isArray(targets);
        if(Array.isArray(targets))for(const target of targets){try{denied ||= typeof target!=='string'||normalized(realActionPath(target))!==normalized(target);}catch{denied=true;}}
      }
      if(denied){record('acceptance-violation',{kind:'smoke4-pre-tool-action-refused',...facts});exec.agent.cancel({kind:'hook',reason:'smoke4 refused an unplanned action before tool execution.'});throw new Error('smoke4 action is outside its synthetic pre-tool allowlist; no retry or escalation is authorized.');}
    },
    resultFacts(result) {
      const value=result?.isError?null:result?.value;
      const facts={isError:result?.isError===true,denialObserved:result?.isError===true&&/denied|not permitted|read-only|permission|sandbox.*(?:deny|block)/i.test(result?.error?.message ?? '')};
      if(value&&typeof value==='object'&&value.kind) {
        facts.shell={kind:value.kind,exitCode:value.exitCode ?? null,timedOut:value.timedOut===true,aborted:value.aborted===true,sandbox:value.sandbox?{mode:value.sandbox.mode,denied:value.sandbox.denied===true,runnerFailed:value.sandbox.runnerFailed===true}:null};
      }
      return facts;
    },
    created(agent,proof,agents) {
      record('permission-created',{...proof,parentSession:agent.session.header.parentSession ?? null,syntheticActionPolicy:!!policy});
      if(proof.agentRole==='subagent') {
        children.add(agent.id);
        if(children.size>receipt.observation.maxChildren) {
          record('acceptance-violation',{kind:'unplanned-subagent-count',count:children.size,max:receipt.observation.maxChildren});
          for(const known of agents.values()) known.cancel({kind:'hook',reason:'Acceptance stopped: unexpected subagent count.'});
          throw new Error('Acceptance stopped: unexpected subagent count; no extra model attempt is authorized.');
        }
      }
    },
    modelRequest(agent,policy,resolved) {
      const expected=receipt.observation.expectedModel,selected={provider:resolved?.provider ?? null,model:resolved?.model ?? null};
      const matchesDefault=!!expected&&selected.provider===expected.provider&&selected.model===expected.model;
      this.proof('permission-model-request',agent,policy,{selectionHash:digest(selected),matchesDefault,provider:matchesDefault?expected.provider:null,model:matchesDefault?expected.model:null});
      if(expected&&!matchesDefault){record('acceptance-violation',{kind:'default-model-selection-drift',agentId:agent.id});throw new Error('Acceptance default model selection is missing or changed; no fallback or override is permitted.');}
    },
    proof(phase,agent,policy,extra={}) {
      record(phase,{agentId:agent.id,sessionId:agent.session.id,agentRole:agent.session.header.parentSession?'subagent':'main',parentSession:agent.session.header.parentSession ?? null,sandboxMode:policy.mode,approvalPolicy:policy.approval,workspace:config.workspace,effectiveWorkingDirectory:config.workingDirectory?.(agent.session)??agent.session.header.cwd,nativePreset:policy.preset??null,permissionMode:config.permissionMode??config.sandboxMode,verified:true,...extra});
    },
  };
}
