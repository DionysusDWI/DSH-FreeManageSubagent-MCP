/** Bind native approval/question services to complete durable bridge requests. No stdout reconstruction. */
import path from 'node:path';
import {InteractionStore,digestOf,canonicalJson} from './interactions.js';
import {readJson,writeJsonAtomic,assertOwner} from './io.js';
const key=(agentId,callId)=>agentId+'/'+callId;
const eventRef=event=>({type:event.type,seq:event.seq});
const clone=value=>JSON.parse(JSON.stringify(value));
export function installInteractions(ctx,{state,channel,dir,configuration,deadline,source,continuationRequestId,onFailure,beforeSettle=async()=>{}}) {
  const owner=source?.owner??channel,store=new InteractionStore(source?.dir??dir,owner);
  const waits=new Map(),operations=new Map(),delivering=new Set();
  let confirmations=Promise.resolve(),polling=false,disposed=false,failed=false;
  store.setAdmission(channel.taskId,true,{pid:process.pid});
  const failure=error=>{failed=true;try{writeJsonAtomic(path.join(dir,'bridge-failure.json'),{message:error.message,taskId:channel.taskId,conversationKey:channel.conversationKey});}catch{}state.closeAdmission();try{store.setAdmission(channel.taskId,false,{error:error.message});}catch{}onFailure(error);};
  const defer=work=>{confirmations=confirmations.then(work).catch(failure);return confirmations;};
  let operationBytes=0;
  ctx.on('tools/pre-execute',async(exec,next)=>{
    let operationKey=null,bytes=0;
    if(exec.agent&&state.agents.has(exec.agent.id)) {
      const definition=ctx.tools.get(exec.name,exec.agent);
      operationKey=key(exec.agent.id,exec.callId);
      const operation={toolName:exec.name,callId:exec.callId,rootCallId:exec.rootCallId,
        nested:exec.parent!==undefined,arguments:clone(exec.arguments),schema:definition?clone({name:definition.name,description:definition.description,parameters:definition.parameters,output:definition.output?.schema}):null,
        effectiveWorkingDirectory:ctx.workingDirectory.get(exec.agent.session)};
      bytes=Buffer.byteLength(JSON.stringify(operation));
      if(operations.size>=128||operationBytes+bytes>32*1024*1024)throw new Error('Native operation snapshot budget exceeded; interactive admission is refused.');
      operations.set(operationKey,operation);operationBytes+=bytes;
    }
    try{return await next();}catch(error){if(operationKey){operations.delete(operationKey);operationBytes-=bytes;}throw error;}
  },{prepend:true});
  ctx.on('tools/result',(exec)=>{const operationKey=key(exec.agent?.id,exec.callId),operation=operations.get(operationKey);if(operation){operationBytes-=Buffer.byteLength(JSON.stringify(operation));operations.delete(operationKey);}});
  function createWait(request,type,extra) {
    const agent=request.agent;state.verify(agent);
    const callId=request.callId??request.wait?.callId??request.questions?.find(q=>q.intent?.callId)?.intent.callId;
    const operation=operations.get(key(agent.id,callId));
    if(!callId||!operation)throw new Error('Full native operation identity is unavailable; interactive execution is refused.');
    let nativeApprovalId;
    if(type==='approval') {
      const asked=[...agent.session.log].reverse().find(event=>event.type==='approval/asked'&&event.data.toolName===request.toolName&&event.data.callId===callId);
      if(!asked)throw new Error('Native approval audit identity is missing.');nativeApprovalId=asked.data.id;
    }
    const timed=type==='questionnaire'&&request.wait?.timed===true;
    if(timed&&configuration.questionPolicy!=='continue')throw new Error('Native questionnaire bypassed the task pause policy.');
    const saved=store.create({type,createdInTaskId:channel.taskId,sessionId:agent.session.id,agentId:agent.id,callId,nativeApprovalId:nativeApprovalId??null,
      expiresAt:timed?null:deadline,summary:type==='approval'?'Approve '+request.toolName:request.questions.map(q=>q.question).join(' / '),
      detail:{operation,...extra,...(type==='questionnaire'?{questions:clone(request.questions),nativeTimed:timed,questionPolicy:timed?'continue':'pause'}:{})}});
    return new Promise((resolve,reject)=>{
      const waiter={saved,agent,resolve,reject,sent:null,signal:request.signal};waits.set(saved.requestId,waiter);
      const aborted=()=>{
        waits.delete(saved.requestId);request.signal?.removeEventListener('abort',aborted);
        const timeout=timed&&request.signal?.reason?.code==='ASK_TIMED_OUT';
        try{if(!timeout)store.transition(saved.requestId,'cancelled');}catch(error){failure(error);}
        if(type==='approval')resolve('cancelled');else reject(request.signal?.reason??Object.assign(new Error('Native question cancelled'),{code:'ASK_ABORTED'}));
      };
      waiter.removeAbort=()=>request.signal?.removeEventListener('abort',aborted);
      request.signal?.addEventListener('abort',aborted,{once:true});if(request.signal?.aborted)aborted();
    });
  }
  function receive(request,type,extra){try{return createWait(request,type,extra);}catch(error){failure(error);throw error;}}
  ctx.on('approval/request',request=>receive(request,'approval',{reason:request.reason??null,displayReason:request.displayReason??null}));
  ctx.on('user-questions/request',request=>receive(request,'questionnaire',{}));
  function nativeQuestionView(session) {return ctx.sessionProjections.stateOf(session,'userQuestions')?.questions;}
  function successfulResult(event) {return event.type==='tool/ptc-dispatch'?!event.data.isError:event.type==='tool/result'&&event.data.message?.isError!==true&&!event.data.error;}
  async function committed(session,event) {
    const matches=store.all().filter(s=>s.request.sessionId===session.id);
    if(!matches.length)return;
    if(!await ctx.sessions.flush(session))throw new Error('Native interaction event could not be persisted; no ACK was issued.');
    const questions=nativeQuestionView(session);
    for(const snapshot of matches) {
      const {request:r,response,receipt}=snapshot;
      if(r.type==='approval'&&event.type==='approval/decided'&&event.data.id===r.nativeApprovalId) {
        if(response&&!receipt&&response.payload.decision===event.data.outcome)store.receipt(r.requestId,{responseDigest:response.responseDigest,nativeEvent:eventRef(event),persisted:true,outcome:event.data.outcome});
        else {if(response&&!receipt)store.rejectResponse(r.requestId,'Native approval did not apply the submitted outcome.',eventRef(event));store.transition(r.requestId,'cancelled');}
        continue;
      }
      if(r.type!=='questionnaire')continue;
      const active=questions?.active.find(q=>q.callId===r.callId),settled=questions?.settled.find(q=>q.callId===r.callId);
      if(active?.state==='continued')store.transition(r.requestId,'continued');
      const matchingResult=event.type==='tool/result'&&event.data.message?.toolCallId===r.callId||event.type==='tool/ptc-dispatch'&&event.data.subCallId===r.callId;
      const lateReply=event.type==='user/message'&&event.data.source?.kind==='user-question-reply'&&event.data.source.callId===r.callId;
      const directReply=matchingResult&&successfulResult(event)&&waits.get(r.requestId)?.sent===response?.responseDigest;
      if(response&&!receipt&&(lateReply||directReply)) {
        // For timed calls the native projection validates the durable admitted batch too.
        if(lateReply&&(!settled||canonicalJson(settled.answers)!==canonicalJson(response.payload.answers)))throw new Error('Native settled question differs from the submitted batch.');
        store.receipt(r.requestId,{responseDigest:response.responseDigest,nativeEvent:eventRef(event),persisted:true,outcome:'answered'});
      } else if(matchingResult&&!active&&!settled&&!directReply) {
        if(response&&!receipt)store.rejectResponse(r.requestId,'Native question did not admit this answer.',eventRef(event));
        store.transition(r.requestId,'cancelled');
      }
      if(matchingResult||lateReply){waits.get(r.requestId)?.removeAbort?.();waits.delete(r.requestId);delivering.delete(r.requestId);}
    }
  }
  ctx.on('session/event',(session,event)=>{
    if(['approval/decided','tool/result','tool/ptc-dispatch','user/message'].includes(event.type))setImmediate(()=>{if(!disposed)defer(()=>committed(session,event));});
  });
  async function deliver() {
    for(const snapshot of store.pending()) {
      const {request:r,response,receipt}=snapshot;
      if(!response||receipt||response.deliveryTaskId!==channel.taskId||delivering.has(r.requestId))continue;
      if(r.expiresAt!==null&&r.expiresAt!==undefined&&Date.now()>=r.expiresAt) {
        store.rejectResponse(r.requestId,'Request expired before native application.');
        throw new Error('Expired interaction delivery was refused.');
      }
      const agent=state.agents.get(r.agentId);
      if(!agent||agent.session.id!==r.sessionId)continue;
      state.verify(agent);
      const waiter=waits.get(r.requestId);
      if(waiter) {
        waiter.sent=response.responseDigest;delivering.add(r.requestId);waiter.removeAbort?.();
        waiter.resolve(r.type==='approval'?response.payload.decision:response.payload);
      } else if(r.type==='questionnaire'&&snapshot.state.status==='continued') {
        const active=nativeQuestionView(agent.session)?.active.find(q=>q.callId===r.callId&&q.state==='continued');
        if(!active)throw new Error('Native continued question no longer matches this request.');
        delivering.add(r.requestId);
        try {if(ctx.userQuestions.answer(agent,r.callId,response.payload)!==true)throw new Error('Native answer service rejected the continued question.');}
        catch(error){store.rejectResponse(r.requestId,error.message);throw error;}
      } else if(continuationRequestId===r.requestId)throw new Error('Only a native continued questionnaire can create an answer continuation.');
    }
  }
  async function poll() {
    if(polling||disposed||failed)return;polling=true;
    try {
      await deliver();
      const command=readJson(path.join(dir,'bridge-control.json'),{optional:true});
      if(!failed&&command?.type==='settle'&&!readJson(path.join(dir,'bridge-settled.json'),{optional:true})) {
        assertOwner(command,channel.conversationKey,channel.taskId);
        // Native session listeners queue persistence work with setImmediate. Drain that
        // admission turn before reading the promise tail or retiring continued questions.
        await new Promise(resolve=>setImmediate(resolve));
        await confirmations;await beforeSettle();if(failed)return;
        const agents=[...state.agents.values()];
        if(agents.some(agent=>agent.status!=='idle'))return;
        if(!store.tryCloseAdmission(channel.taskId))return;
        state.closeAdmission();
        for(const agent of agents)if(!await ctx.sessions.flush(agent.session))throw new Error('Final native session flush failed.');
        const main=state.agents.get(state.mainAgentId);
        const terminal=[...main.session.log].reverse().find(event=>event.type==='turn/end');
        writeJsonAtomic(path.join(dir,'bridge-settled.json'),{version:1,conversationKey:channel.conversationKey,taskId:channel.taskId,sessionId:main.session.id,
          admissionClosed:true,persisted:true,terminal:terminal?{...eventRef(terminal),reason:terminal.data.reason}:null,sessionSeq:main.session.seq,
          effectiveWorkingDirectory:ctx.workingDirectory.get(main.session),ts:Date.now()});
      }
    }catch(error){failure(error);}finally{polling=false;}
  }
  const timer=setInterval(()=>{void poll();},50);timer.unref?.();
  ctx.on('dispose',async()=>{
    disposed=true;clearInterval(timer);state.closeAdmission();store.setAdmission(channel.taskId,false);await confirmations;
    for(const snapshot of store.pending()) {
      // Only durably continued native calls survive a normal process shutdown.
      if(snapshot.state.status!=='continued')store.transition(snapshot.request.requestId,'cancelled');
    }
    for(const waiter of waits.values()){waiter.removeAbort?.();waiter.reject(new Error('Bridge interaction runtime disposed.'));}waits.clear();
  });
  return {store,poll};
}
