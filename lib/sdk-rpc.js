/** Official SDK JSON-RPC wire peer. Uses the already supervised stdio, never spawns a client process. */
import {StringDecoder} from 'node:string_decoder';
export class SdkRpcPeer {
  constructor({onNotification=()=>{},onFailure=()=>{},maxFrameBytes=8*1024*1024}={}) {
    this.onNotification=onNotification;this.onFailure=onFailure;this.maxFrameBytes=maxFrameBytes;
    this.decoder=new StringDecoder('utf8');this.buffer='';this.pending=new Map();this.next=0;this.transport=null;this.closed=false;
  }
  attach(transport){if(this.transport)throw new Error('SDK transport already attached');this.transport=transport;}
  async request(method,params,{timeoutMs=30000}={}) {
    if(this.closed||!this.transport)throw new Error('SDK transport is unavailable.');
    if(this.pending.size>=16)throw new Error('SDK request concurrency limit.');
    const id=++this.next,frame=JSON.stringify({jsonrpc:'2.0',id,method,...(params===undefined?{}:{params})})+'\n';
    if(Buffer.byteLength(frame)>this.maxFrameBytes)throw new Error('SDK frame exceeds safety limit.');
    let timer;
    const result=new Promise((resolve,reject)=>{
      timer=setTimeout(()=>{this.pending.delete(id);reject(Object.assign(new Error('SDK '+method+' timed out.'),{code:'SDK_REQUEST_TIMEOUT'}));},Math.max(1,timeoutMs));
      this.pending.set(id,{resolve,reject,timer});
    });
    // Register rejection immediately: a pipe failure must not create an unhandled response rejection.
    result.catch(()=>{});
    try {await this.transport.write(Buffer.from(frame));}catch(error){clearTimeout(timer);this.pending.delete(id);throw error;}
    return result;
  }
  write(bytes) {
    if(this.closed)throw new Error('SDK emitted bytes after protocol closure.');
    this.buffer+=this.decoder.write(bytes);
    let end;
    while((end=this.buffer.indexOf('\n'))>=0) {
      const line=this.buffer.slice(0,end);this.buffer=this.buffer.slice(end+1);
      if(!line.trim())continue;
      if(Buffer.byteLength(line)>this.maxFrameBytes)throw new Error('SDK response frame exceeds safety limit.');
      let frame;try{frame=JSON.parse(line);}catch{throw Object.assign(new Error('Malformed SDK JSON-RPC frame.'),{code:'SDK_PROTOCOL_ERROR'});}
      if(!frame||frame.jsonrpc!=='2.0'||Array.isArray(frame))throw new Error('Invalid SDK JSON-RPC envelope.');
      if(frame.id!==undefined) {
        const pending=this.pending.get(frame.id);if(!pending)throw new Error('Unsolicited SDK response identity.');
        if(frame.method!==undefined||Object.hasOwn(frame,'result')===Object.hasOwn(frame,'error')||Object.hasOwn(frame,'error')&&(!frame.error||typeof frame.error.message!=='string'||!Number.isInteger(frame.error.code)))throw new Error('Invalid SDK response shape.');
        this.pending.delete(frame.id);clearTimeout(pending.timer);
        if(frame.error)pending.reject(Object.assign(new Error('SDK: '+frame.error.message),{code:'SDK_RPC_ERROR',rpcCode:frame.error.code}));
        else if(Object.hasOwn(frame,'result'))pending.resolve(frame.result);else throw new Error('SDK response has no result or error.');
      } else if(typeof frame.method==='string')this.onNotification(frame.method,frame.params);
      else throw new Error('Invalid SDK notification.');
    }
    if(Buffer.byteLength(this.buffer)>this.maxFrameBytes)throw new Error('Unterminated SDK frame exceeds safety limit.');
  }
  finish() {
    this.buffer+=this.decoder.end();if(this.buffer.trim())throw new Error('Truncated SDK frame at EOF.');
    if(this.pending.size)throw new Error('SDK exited with unanswered requests.');
  }
  close(error=new Error('SDK process exited.')) {this.closed=true;for(const item of this.pending.values()){clearTimeout(item.timer);item.reject(error);}this.pending.clear();}
}
export class SdkObservation {
  constructor(sessionId,onReport=()=>{}){this.sessionId=sessionId;this.onReport=onReport;this.terminal=null;this.answer=null;this.turns=0;this.lastSeq=-1;}
  notification(method,params) {
    if(method!=='session.event'||params?.sessionId!==this.sessionId)return;
    const event=params.event;
    if(!event||!Number.isSafeInteger(event.seq)||event.seq<=this.lastSeq)throw new Error('SDK session event sequence is invalid.');
    this.lastSeq=event.seq;
    if(event.type==='turn/start'){this.turns++;this.terminal=null;}
    if(event.type==='turn/end')this.terminal={seq:event.seq,reason:event.data.reason};
    if(event.type==='assistant/message') {
      const blocks=event.data.message?.content??[];
      const text=blocks.filter(block=>block.type==='text').map(block=>block.text).join('');
      if(text.trim()){this.answer=text;this.onReport({kind:'progress',text,eventId:'sdk:'+this.sessionId+':'+event.seq,agentId:this.sessionId,agentRole:'main'});}
    }
  }
  outcome({exitCode,proof,cancelled,timedOut}) {
    if(timedOut)return {state:'timeout',answer:this.answer,reason:{kind:'timeout',message:'DSH task deadline exceeded.'}};
    if(cancelled)return {state:'cancelled',answer:this.answer,reason:{kind:'cancelled',message:'DSH task cancelled.'}};
    if(this.turns===0||this.terminal?.reason?.kind!=='completed')return {state:'failed',answer:this.answer,reason:this.turns>0&&this.terminal?.reason?this.terminal.reason:{kind:'aborted',message:'DSH exited without a successful native turn.'}};
    if(exitCode!==0||proof?.admissionClosed!==true||proof?.persisted!==true||proof.terminal?.seq!==this.terminal.seq||proof.terminal?.reason?.kind!=='completed')return {state:'failed',answer:this.answer,reason:{kind:'error',code:'SDK_COMPLETION_UNPROVEN',message:'SDK idle/exit 0 is insufficient: native success, final persistence and closed admission must agree.'}};
    return {state:'completed',answer:this.answer,reason:{kind:'completed'}};
  }
}
