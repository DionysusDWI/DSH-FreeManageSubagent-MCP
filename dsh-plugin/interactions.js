/** Durable bidirectional requests. Requests, submissions, native receipts and lifecycle are distinct facts. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {readJson,writeJsonAtomic,appendJsonLine,assertOwner,boundUtf8} from './io.js';
import {withFileLockSync} from './file-lock.js';
export function canonicalJson(value) {
  if(value===null || typeof value!=='object')return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(canonicalJson).join(',')+']';
  return '{'+Object.keys(value).filter(key=>value[key]!==undefined).sort().map(key=>JSON.stringify(key)+':'+canonicalJson(value[key])).join(',')+'}';
}
export const digestOf=value=>crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
const error=(message,code='INTERACTION_INVALID')=>Object.assign(new Error(message),{code});
const id=value=>{if(typeof value!=='string'||!/^i-[a-f0-9]{32}$/.test(value))throw error('Invalid interaction request ID.');return value;};
const finalStates=new Set(['settled','cancelled','expired']);
export function validateResponse(request,payload) {
  if(request.type==='approval') {
    if(!payload || Object.keys(payload).length!==1 || !['allowed-once','rejected','cancelled'].includes(payload.decision))throw error('Approval accepts only a native allowed-once, rejected or cancelled decision.');
    return {decision:payload.decision};
  }
  if(request.type!=='questionnaire'||!payload || Object.keys(payload).length!==1||!Array.isArray(payload.answers))throw error('A complete structured answers array is required.');
  const questions=request.detail.questions,answers=payload.answers;
  if(answers.length!==questions.length||new Set(answers.map(a=>a?.id)).size!==answers.length)throw error('Answer each native question ID exactly once.');
  const normalized=questions.map(question=>{
    const answer=answers.find(a=>a?.id===question.id);
    if(!answer||Object.keys(answer).some(key=>!['id','selected','custom'].includes(key))||!Array.isArray(answer.selected)||answer.selected.some(s=>typeof s!=='string')||new Set(answer.selected).size!==answer.selected.length||answer.custom!==undefined&&typeof answer.custom!=='string')throw error('Invalid answer for '+question.id+'.');
    const options=question.options??[];
    if(answer.selected.some(label=>!options.some(option=>option.label===label)))throw error('Unknown native option label for '+question.id+'.');
    if(!question.multiSelect&&(answer.selected.length>1||answer.selected.length&&answer.custom?.trim()))throw error('Single-select questions accept one selection or a custom answer.');
    return {id:question.id,selected:[...answer.selected],...(answer.custom===undefined?{}:{custom:answer.custom})};
  });
  return {answers:normalized};
}
export class InteractionStore {
  constructor(dir,owner) {this.baseDir=path.resolve(dir);this.dir=path.join(this.baseDir,'interactions');this.owner={conversationKey:owner.conversationKey,taskId:owner.taskId};this.lock=path.join(this.dir,'.lock');}
  safe(file) {
    for(const target of [this.baseDir,this.dir,path.dirname(file),file])try{if(fs.lstatSync(target).isSymbolicLink())throw error('Linked interaction state is refused.','INTERACTION_CORRUPT');}catch(e){if(e.code!=='ENOENT')throw e;}
    return file;
  }
  file(kind,requestId){if(!['requests','states','responses','receipts'].includes(kind))throw error('Unknown interaction record kind.');return this.safe(path.join(this.dir,kind,id(requestId)+'.json'));}
  read(kind,requestId) {
    const value=readJson(this.file(kind,requestId),{optional:true});
    if(value){assertOwner(value,this.owner.conversationKey,this.owner.taskId);if(value.requestId!==requestId)throw error('Interaction record identity mismatch.','INTERACTION_CORRUPT');
      if(kind==='responses'&&digestOf(value.payload)!==value.responseDigest)throw error('Interaction submission digest mismatch.','INTERACTION_CORRUPT');}
    return value;
  }
  request(requestId) {
    const value=this.read('requests',requestId);if(!value)throw error('No interaction request matches this task.','INTERACTION_NOT_FOUND');
    const {requestDigest,...body}=value;if(digestOf(body)!==requestDigest)throw error('Interaction request digest verification failed.','INTERACTION_CORRUPT');return value;
  }
  snapshot(requestId) {
    const request=this.request(requestId),state=this.read('states',requestId)??{status:'open'},response=this.read('responses',requestId),receipt=this.read('receipts',requestId);
    if(response&&(response.requestDigest!==request.requestDigest||response.type!==request.type)||receipt&&(!response||receipt.responseDigest!==response.responseDigest))throw error('Interaction record binding mismatch.','INTERACTION_CORRUPT');
    return {request,state,response,receipt};
  }
  create({requestId='i-'+crypto.randomBytes(16).toString('hex'),...data}) {
    return withFileLockSync(this.lock,()=>{
      if(this.read('requests',requestId))throw error('Request identity already exists.');
      const body={version:1,...this.owner,requestId,createdAt:Date.now(),...data};
      const bytes=Buffer.byteLength(canonicalJson(body));if(bytes>8*1024*1024)throw error('Complete native interaction exceeds the 8 MiB storage limit; execution is refused, not truncated.');
      const request={...body,requestDigest:digestOf(body)};writeJsonAtomic(this.file('requests',requestId),request);
      this.writeState(requestId,{status:'open'});return request;
    });
  }
  writeState(requestId,patch) {
    const previous=this.read('states',requestId);const value={version:1,...this.owner,requestId,...previous,...patch,revision:(previous?.revision??0)+1,updatedAt:Date.now()};
    appendJsonLine(path.join(this.dir,'lifecycle.ndjson'),value,{separateTornTail:true});writeJsonAtomic(this.file('states',requestId),value);return value;
  }
  transition(requestId,status,extra={}) {return withFileLockSync(this.lock,()=>{const {state}=this.snapshot(requestId);if(finalStates.has(state.status)&&state.status!==status)return state;if(state.status===status&&Object.keys(extra).every(key=>canonicalJson(state[key])===canonicalJson(extra[key])))return state;return this.writeState(requestId,{status,...extra});});}
  admission(taskId) {
    if(typeof taskId!=='string'||!/^[A-Za-z0-9._-]+$/.test(taskId))throw error('Invalid delivery task ID.');
    const value=readJson(this.safe(path.join(this.dir,'admissions',taskId+'.json')),{optional:true});if(value){assertOwner(value,this.owner.conversationKey,this.owner.taskId);if(value.deliveryTaskId!==taskId||typeof value.open!=='boolean')throw error('Interaction admission identity mismatch.','INTERACTION_CORRUPT');}return value;
  }
  setAdmission(taskId,open,extra={}) {return withFileLockSync(this.lock,()=>{
    this.admission(taskId);const value={version:1,...this.owner,deliveryTaskId:taskId,open,...extra,updatedAt:Date.now()};
    writeJsonAtomic(path.join(this.dir,'admissions',taskId+'.json'),value);return value;
  });}
  tryCloseAdmission(taskId) {return withFileLockSync(this.lock,()=>{
    const pending=this.all().some(s=>s.response?.deliveryTaskId===taskId&&!s.receipt&&!finalStates.has(s.state.status));
    if(pending)return false;
    const value={version:1,...this.owner,deliveryTaskId:taskId,open:false,updatedAt:Date.now()};
    writeJsonAtomic(path.join(this.dir,'admissions',taskId+'.json'),value);return true;
  });}
  rejectResponse(requestId,message,nativeEvent=null) {return withFileLockSync(this.lock,()=>{
    const {response,receipt}=this.snapshot(requestId);if(receipt||!response)return receipt;
    const value={version:1,...this.owner,requestId,responseDigest:response.responseDigest,applied:false,error:String(message),nativeEvent,recordedAt:Date.now()};
    writeJsonAtomic(this.file('receipts',requestId),value);this.writeState(requestId,{status:'cancelled',reason:String(message)});return value;
  });}
  submit({requestId,requestDigest,type,payload},route) {
    return withFileLockSync(this.lock,()=>{
      const snapshot=this.snapshot(requestId),{request,state}=snapshot;
      if(request.requestDigest!==requestDigest||request.type!==type)throw error('Request digest or type mismatch.','INTERACTION_MISMATCH');
      const normalized=validateResponse(request,payload);if(Buffer.byteLength(canonicalJson(normalized))>8*1024*1024)throw error('Structured response exceeds the 8 MiB storage limit.');const responseDigest=digestOf(normalized);
      if(snapshot.response) {
        if(snapshot.response.responseDigest!==responseDigest)throw error('A conflicting response is already persisted.','INTERACTION_CONFLICT');
        return {...snapshot,reused:true};
      }
      if(finalStates.has(state.status)||request.expiresAt!==null&&request.expiresAt!==undefined&&Date.now()>=request.expiresAt)throw error('Request has expired, settled or been cancelled.','INTERACTION_CLOSED');
      // Route selection occurs under the same lock as native admission closure.
      const delivery=route(snapshot);
      const response={version:1,...this.owner,requestId,requestDigest,type,responseDigest,payload:normalized,submittedAt:Date.now(),...delivery};
      writeJsonAtomic(this.file('responses',requestId),response);
      appendJsonLine(path.join(this.dir,'submissions.ndjson'),response,{separateTornTail:true});
      return {...snapshot,response,reused:false};
    });
  }
  receipt(requestId,{responseDigest,nativeEvent,persisted,outcome}) {
    if(persisted!==true||!nativeEvent||!Number.isSafeInteger(nativeEvent.seq))throw error('Native application ACK requires a persisted native event.');
    return withFileLockSync(this.lock,()=>{
      const {response,receipt}=this.snapshot(requestId);if(!response||response.responseDigest!==responseDigest)throw error('Native receipt does not match its submission.');
      if(receipt)return receipt;
      const value={version:1,...this.owner,requestId,responseDigest,applied:true,nativeEvent,outcome,acknowledgedAt:Date.now()};
      writeJsonAtomic(this.file('receipts',requestId),value);appendJsonLine(path.join(this.dir,'acknowledgements.ndjson'),value,{separateTornTail:true});
      this.writeState(requestId,{status:'settled'});return value;
    });
  }
  all() {
    const dir=path.join(this.dir,'requests');if(!fs.existsSync(dir))return [];
    return fs.readdirSync(dir).filter(name=>/^i-[a-f0-9]{32}\.json$/.test(name)).map(name=>this.snapshot(name.slice(0,-5)))
      .sort((a,b)=>a.request.createdAt-b.request.createdAt||a.request.requestId.localeCompare(b.request.requestId));
  }
  pending() {return this.all().filter(s=>!finalStates.has(s.state.status));}
  summary(snapshot) {
    const {request:r,state,response,receipt}=snapshot;
    return {request_id:r.requestId,request_digest:r.requestDigest,type:r.type,session_id:r.sessionId,call_id:r.callId??null,
      status:state.status,summary:boundUtf8(r.summary??r.type,240).text,submitted:!!response,acknowledged:receipt?.applied===true,
      continuation_task_id:response?.continuationTaskId??null,created_at:r.createdAt};
  }
  page({requestId,offset=0,limit=50,detailOffset=0,detailLimit=16384}={}) {
    if(requestId) {
      if(!Number.isSafeInteger(detailOffset)||detailOffset<0||!Number.isSafeInteger(detailLimit)||detailLimit<1||detailLimit>16384)throw error('Invalid detail byte page.');
      const snapshot=this.snapshot(requestId),bytes=Buffer.from(canonicalJson(snapshot.request));if(detailOffset>bytes.length)throw error('Detail offset exceeds request size.');
      const end=Math.min(bytes.length,detailOffset+detailLimit);
      return {...this.summary(snapshot),detail_encoding:'base64-utf8-json',detail_base64:bytes.subarray(detailOffset,end).toString('base64'),detail_bytes:bytes.length,
        detail_offset:detailOffset,next_detail_offset:end,has_more:end<bytes.length,receipt:snapshot.receipt};
    }
    if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>100)throw error('Invalid interactions page.');
    const all=this.all();return {interactions:all.slice(offset,offset+limit).map(s=>this.summary(s)),cursor:Math.min(all.length,offset+limit),has_more:offset+limit<all.length};
  }
}
