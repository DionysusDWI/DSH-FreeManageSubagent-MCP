/** Versioned, credit-based parent -> guardian input. ACK means bytes reached the child pipe, not native application. */
export const GUARDIAN_PROTOCOL = 2;
export const INPUT_CHUNK_BYTES = 32768;
export const MAX_INPUT_BYTES = 1024 * 1024;
export class GuardianInput {
  constructor(send) { this.send=send; this.queue=[]; this.bytes=0; this.next=0; this.inflight=null; this.closed=false; }
  write(value) {
    const data=Buffer.from(value);
    if (this.closed) return Promise.reject(new Error('Guardian input is closed.'));
    if (this.bytes+data.length>MAX_INPUT_BYTES) return Promise.reject(Object.assign(new Error('Guardian stdin backpressure budget exceeded.'),{code:'GUARDIAN_INPUT_LIMIT'}));
    if (!data.length) return Promise.resolve();
    return new Promise((resolve,reject)=> { this.queue.push({data,offset:0,resolve,reject}); this.bytes+=data.length; this.pump(); });
  }
  end() {
    if(this.closed)return Promise.reject(new Error('Guardian input is closed.'));
    this.closed=true;
    return new Promise((resolve,reject)=> {this.queue.push({eof:true,resolve,reject});this.pump();});
  }
  pump() {
    if(this.inflight || !this.queue.length)return;
    const entry=this.queue[0], id=++this.next;
    const chunk=entry.eof?null:entry.data.subarray(entry.offset,entry.offset+INPUT_CHUNK_BYTES);
    this.inflight={id,size:chunk?.length??0,entry};
    try { this.send({type:entry.eof?'stdin-end':'stdin',id,...(chunk?{data:chunk.toString('base64')}:{})}); }
    catch(error){this.fail(error);}
  }
  acknowledge(event) {
    if(!this.inflight || event.id!==this.inflight.id)throw Object.assign(new Error('Unexpected guardian stdin acknowledgement.'),{code:'GUARDIAN_PROTOCOL_MISMATCH'});
    const {size,entry}=this.inflight;this.inflight=null;
    if(event.error){this.fail(new Error('Guardian stdin: '+event.error));return;}
    entry.offset=(entry.offset??0)+size;this.bytes-=size;
    if(entry.eof || entry.offset===entry.data.length){this.queue.shift();entry.resolve();}
    this.pump();
  }
  fail(error=new Error('Guardian process exited before input drained.')) {this.closed=true;this.inflight=null;for(const entry of this.queue.splice(0))entry.reject(error);this.bytes=0;}
}
