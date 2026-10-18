/** Deterministic SDK protocol fixture. Not a model or an upstream conformance proof. */
import fs from 'node:fs';
import path from 'node:path';
import {StringDecoder} from 'node:string_decoder';
import {writeJsonAtomic} from '../../lib/io.js';
export function syntheticSdk({env,emit,onShutdown=()=>{},stderr=()=>{},settings={}}) {
  const dir=path.dirname(env.DSH_MCP_CHANNEL),config=JSON.parse(env.DSH_MCP_CONFIGURATION);
  const workspace=env.DSH_MCP_WORKSPACE,owner={conversationKey:env.DSH_MCP_SCOPE,taskId:env.DSH_MCP_TASK};
  const decoder=new StringDecoder('utf8');let buffer='',sessionId,seq=0,terminal=null,stopped=false,settled=false;
  const methods=[];
  const send=frame=>emit(Buffer.from(JSON.stringify({jsonrpc:'2.0',...frame})+'\n'));
  const event=(type,data)=>{const value={type,data,seq:++seq};send({method:'session.event',params:{sessionId,event:value}});return value;};
  function proof() {
    if(settings.missingProof)return;
    writeJsonAtomic(path.join(dir,'policy.json'),{version:3,...owner,sessionId,agentId:sessionId,agentRole:'main',
      permissionMode:config.permissionMode,nativePreset:config.permissionMode,sandboxMode:config.permissionMode==='auto'?'danger-full-access':config.permissionMode,
      approvalPolicy:'ask',workspace,originalProject:workspace,effectiveWorkingDirectory:workspace,
      modelConfiguration:{provider:config.provider,model:config.model,reasoningEffort:config.reasoningEffort??'high'},verified:true});
  }
  function settle() {
    if(settled||!sessionId||!fs.existsSync(path.join(dir,'bridge-control.json')))return;
    writeJsonAtomic(path.join(dir,'bridge-settled.json'),{version:1,...owner,sessionId,admissionClosed:true,persisted:!settings.unpersisted,
      terminal:terminal?{seq:terminal.seq,reason:terminal.data.reason}:null,effectiveWorkingDirectory:workspace});settled=true;
  }
  const timer=setInterval(settle,5);
  function stop(){if(stopped)return;stopped=true;clearInterval(timer);}
  function accept(frame) {
    const {id,method,params}=frame;methods.push({method,params});settings.onMethod?.(method,params);
    const reply=result=>send({id,result});
    if(settings.stall===method)return;
    switch(method) {
      case 'initialize':reply({serverInfo:{name:'deepseek-harness-sdk-runtime',version:'0.0.1'}});break;
      case 'session/resume':sessionId=params.sessionId;reply({sessionId});break;
      case 'session/working-directory/get':sessionId=params.sessionId;proof();reply({cwd:workspace});break;
      case 'session/prompt':
        if(settings.rejectPrompt)throw new Error('Answer continuation must not fabricate a normal prompt.');
        event('turn/start',{});
        if(!settings.missingTurn) {
          event('assistant/message',{message:{content:[{type:'text',text:settings.answer??'answer'}]}});
          terminal=event('turn/end',{reason:{kind:'completed'}});
        }
        reply({messageId:'synthetic-enqueued'});break;
      case 'session/wait':reply({status:'idle'});break;
      case 'shutdown':stderr(Buffer.from('SYNTHETIC_STDERR_TAIL\n'));reply({});stop();setImmediate(onShutdown);break;
      default:throw new Error('Unexpected synthetic SDK method '+method);
    }
  }
  function write(bytes) {
    buffer+=decoder.write(bytes);let end;
    while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(line.trim())accept(JSON.parse(line));}
    return Promise.resolve();
  }
  return {write,stop,methods};
}
export function syntheticSupervise(settings={}) {
  return async options=> {
    settings.inspect?.(options);
    let resolve,reject;const done=new Promise((yes,no)=>{resolve=yes;reject=no;});
    const runtime=syntheticSdk({env:options.env,emit:options.onStdout,stderr:options.onStderr,settings,
      onShutdown:()=>resolve({code:0,treeExited:true})});
    const abort=()=>{runtime.stop();resolve({code:137,treeExited:true});};
    options.signal?.addEventListener('abort',abort,{once:true});
    options.onStarted?.({pid:process.pid,supervision:'synthetic'});
    options.onTransport({write:bytes=>{try{return runtime.write(bytes);}catch(error){runtime.stop();reject(error);return Promise.reject(error);}},end:async()=>{}});
    if(options.signal?.aborted)abort();
    try{return await done;}finally{runtime.stop();options.signal?.removeEventListener('abort',abort);}
  };
}
