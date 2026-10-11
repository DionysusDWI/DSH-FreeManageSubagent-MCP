/** Protocol v2: independent append-only logs, durable receipts, stable IDs.
 * Guidance is at-least-once. Only a persisted main-agent tool result confirms it.
 * Legacy helpers remain for offline migration/tests; they never rewrite a log.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { appendJsonLine, assertOwner, JsonLineReader, readJson, scanJsonLines, writeJsonAtomic } from './io.js';
import { withFileLockSync } from './file-lock.js';
export const PROTOCOL_VERSION = 2;
const shard = process.pid + '-' + crypto.randomUUID();
export function readChannelRecords(file) {
  const out = []; scanJsonLines(file, value => out.push(value)); return out;
}
export function createChannel(file, owner) {
  return withFileLockSync(file + '.init.lock', () => {
    const prior = readJson(file, { optional: true });
    if (prior) { assertOwner(prior, owner.conversationKey, owner.taskId); if (prior.version !== 2) throw new Error('Unsupported channel protocol.'); return prior; }
    const descriptor = { version: 2, conversationKey: owner.conversationKey, taskId: owner.taskId };
    writeJsonAtomic(file, descriptor); return descriptor;
  });
}
export function channelDescriptor(file, expected) {
  let value;
  try { value = readJson(file, { optional: true }); } catch (e) { if (e instanceof SyntaxError) return null; throw e; }
  if (!value || value.version !== 2 || !value.conversationKey || !value.taskId) return null;
  if (expected) assertOwner(value, expected.conversationKey, expected.taskId);
  return value;
}
export function channelPaths(file) {
  const dir = path.dirname(file);
  return { reports: path.join(dir, 'reports'), guidance: path.join(dir, 'steering.ndjson'), receipts: path.join(dir, 'steering.receipts.ndjson'), ack: path.join(dir, 'steering.ack.json'), control: path.join(dir, 'control.json'), guidanceState:path.join(dir,'steering.state.json'), messageDir:path.join(dir,'steering.messages'), receiptDir:path.join(dir,'steering.confirmed') };
}
export function appendChannelRecord(file, value) {
  const owner = channelDescriptor(file);
  if (!owner) { appendJsonLine(file, value); return value; }
  if (value.taskId !== undefined && value.taskId !== owner.taskId || value.conversationKey !== undefined && value.conversationKey !== owner.conversationKey) throw new Error('Channel ownership mismatch.');
  if (value.type === 'steer') return appendGuidance(file, value.text, { ...value, owner });
  if (value.type !== 'report') throw new Error('Protocol v2 does not permit mixed cursor/control records.');
  const record = { ...value, version: 2, conversationKey: owner.conversationKey, taskId: owner.taskId, eventId: value.eventId ?? crypto.randomUUID(), ts: value.ts ?? Date.now() };
  appendJsonLine(path.join(channelPaths(file).reports, 'report-' + shard + '.ndjson'), record, {separateTornTail:true}); return record;
}
export function highestSteerSeq(records) { return records.reduce((n, value) => value.type === 'steer' && Number.isSafeInteger(value.seq) ? Math.max(n, value.seq) : n, 0); }
export function channelReportToPayload(record) {
  if (!record || record.type !== 'report' || typeof record.text !== 'string') return null;
  const payload = { kind: typeof record.kind === 'string' ? record.kind : 'progress', text: record.text };
  for (const name of ['eventId', 'data', 'agentId', 'agentRole', 'ts']) if (record[name] !== undefined) payload[name] = record[name];
  return payload;
}
function idFile(dir,id) {return path.join(dir,crypto.createHash('sha256').update(id).digest('hex')+'.json');}
function checkedGuidance(value,owner) {
  assertOwner(value,owner.conversationKey,owner.taskId);
  if(value.version!==2||value.type!=='steer'||!Number.isSafeInteger(value.seq)||value.seq<1||typeof value.messageId!=='string'||typeof value.text!=='string'||!value.text.trim())throw new Error('Invalid guidance record.');
}
function guidanceReader(file,offset=0) {return new JsonLineReader(file,{offset,onMalformed:()=>{throw new Error('Corrupt guidance line was retained on disk; refusing to skip an operator message.');}});}
export function appendGuidance(file,text,options={}) {
  if(typeof text!=='string'||!text.trim())throw new TypeError('Guidance must be non-empty.');
  const owner=channelDescriptor(file,options.owner);if(!owner)throw new Error('A versioned channel is required.');const files=channelPaths(file);
  return withFileLockSync(files.guidance+'.lock',()=> {
    const messageId=options.messageId ?? crypto.randomUUID(),prior=readJson(idFile(files.messageDir,messageId),{optional:true});
    if(prior) {assertOwner(prior,owner.conversationKey,owner.taskId);if(prior.messageId!==messageId||prior.text!==text)throw new Error('Guidance message ID conflict.');return prior;}
    const state=readJson(files.guidanceState,{optional:true});if(state)assertOwner(state,owner.conversationKey,owner.taskId);
    if(state&&(!Number.isSafeInteger(state.lastSeq)||state.lastSeq<0||!Number.isSafeInteger(state.byteOffset)||state.byteOffset<0))throw new Error('Invalid guidance sender checkpoint.');
    let seq=state?.lastSeq ?? 0;const reader=guidanceReader(files.guidance,state?.byteOffset ?? 0);
    reader.poll(value=>{checkedGuidance(value,owner);if(value.seq!==seq+1)throw new Error('Guidance sequence gap.');seq=value.seq;const priorMessage=readJson(idFile(files.messageDir,value.messageId),{optional:true});if(priorMessage){assertOwner(priorMessage,owner.conversationKey,owner.taskId);if(priorMessage.seq!==value.seq||priorMessage.text!==value.text)throw new Error('Guidance ID was reused with a different sequence or content.');}writeJsonAtomic(idFile(files.messageDir,value.messageId),{...value,byteOffset:reader.lineOffset});});
    if(reader.pending.length)throw new Error('Guidance has an unconfirmed half line; original bytes preserved. Complete/recover the sender before appending.');
    const recovered=readJson(idFile(files.messageDir,messageId),{optional:true});if(recovered){assertOwner(recovered,owner.conversationKey,owner.taskId);if(recovered.messageId!==messageId||recovered.text!==text)throw new Error('Guidance message ID conflict.');return recovered;}
    if(seq>=Number.MAX_SAFE_INTEGER)throw new Error('Guidance sequence exhausted.');
    const record={...owner,type:'steer',messageId,seq:seq+1,text,ts:Date.now()};appendJsonLine(files.guidance,record);
    const full={...record,byteOffset:fs.statSync(files.guidance).size};writeJsonAtomic(idFile(files.messageDir,messageId),full);
    writeJsonAtomic(files.guidanceState,{...owner,lastSeq:record.seq,byteOffset:full.byteOffset});return full;
  });
}
function readAck(files,owner) {
  const ack=readJson(files.ack,{optional:true});if(ack)assertOwner(ack,owner.conversationKey,owner.taskId);
  if(ack&&(!Number.isSafeInteger(ack.cursor)||ack.cursor<0||ack.byteOffset!==undefined&&(!Number.isSafeInteger(ack.byteOffset)||ack.byteOffset<0)))throw new Error('Invalid guidance confirmation cursor.');
  if(ack&&ack.byteOffset===undefined) {
    const reader=guidanceReader(files.guidance);let offset=0;
    reader.poll(value=>{checkedGuidance(value,owner);if(value.seq<=ack.cursor)offset=reader.lineOffset;return value.seq<ack.cursor;});ack.byteOffset=offset;
  }
  return ack ?? {...owner,cursor:0,byteOffset:0};
}
export function guidanceMessage(file,messageId,expected){const owner=channelDescriptor(file,expected);if(!owner)throw new Error('Versioned guidance index required.');const value=readJson(idFile(channelPaths(file).messageDir,messageId),{optional:true});if(!value)return null;checkedGuidance(value,owner);if(value.messageId!==messageId)throw new Error('Guidance index identity mismatch.');return value;}
export function steeringCheckpoint(file, expected) {const owner=channelDescriptor(file,expected);if(!owner)throw new Error('Guidance checkpoint requires protocol v2.');return readAck(channelPaths(file),owner);}
export function prepareSteering(file,options={}) {
  const owner=channelDescriptor(file,options.owner);if(!owner||options.agentRole!=='main')return [];const files=channelPaths(file);
  return withFileLockSync(files.ack+'.lock',()=> {
    const ack=readAck(files,owner),reader=guidanceReader(files.guidance,ack.byteOffset),messages=[];let seq=ack.cursor;
    reader.poll(value=>{checkedGuidance(value,owner);if(value.seq!==seq+1)throw new Error('Guidance sequence gap.');seq=value.seq;
      const message={...value,byteOffset:reader.lineOffset};messages.push(message);
      if(!fs.existsSync(idFile(files.messageDir,value.messageId)))writeJsonAtomic(idFile(files.messageDir,value.messageId),message);
    },{maxRecords:Math.max(1,Math.min(20,options.maxMessages ?? 20))});
    if(messages.length)appendJsonLine(files.receipts,{...owner,type:'received',agentId:options.agentId,callId:options.callId,
      messages:messages.map(m=>({messageId:m.messageId,seq:m.seq,byteOffset:m.byteOffset})),ts:Date.now()});
    return messages; // no ACK until the main-agent result has really persisted
  });
}
export function confirmSteering(file,messages,options={}) {
  const owner=channelDescriptor(file,options.owner);if(!owner)throw new Error('A versioned channel is required.');
  if(options.agentRole!=='main'||!options.persisted)throw new Error('Only a persisted main-agent result may confirm guidance.');const files=channelPaths(file);
  return withFileLockSync(files.ack+'.lock',()=> {
    for(const m of messages) {const known=readJson(idFile(files.messageDir,m.messageId));assertOwner(known,owner.conversationKey,owner.taskId);if(known.messageId!==m.messageId||known.seq!==m.seq)throw new Error('Unknown guidance receipt.');}
    appendJsonLine(files.receipts,{...owner,type:'confirmed',agentId:options.agentId,callId:options.callId,messages:messages.map(m=>({messageId:m.messageId,seq:m.seq})),ts:Date.now()});
    for(const m of messages)writeJsonAtomic(idFile(files.receiptDir,m.messageId),{...owner,messageId:m.messageId,seq:m.seq,callId:options.callId,agentId:options.agentId,confirmed:true});
    const ack=readAck(files,owner),reader=guidanceReader(files.guidance,ack.byteOffset);let cursor=ack.cursor,byteOffset=ack.byteOffset;
    reader.poll(value=> {checkedGuidance(value,owner);if(value.seq!==cursor+1)throw new Error('Guidance sequence gap.');
      const confirmed=readJson(idFile(files.receiptDir,value.messageId),{optional:true});if(!confirmed?.confirmed)return false;
      assertOwner(confirmed,owner.conversationKey,owner.taskId);if(confirmed.seq!==value.seq)throw new Error('Confirmation sequence mismatch.');cursor=value.seq;byteOffset=reader.lineOffset;
    });
    writeJsonAtomic(files.ack,{...owner,cursor,byteOffset,updatedAt:Date.now()});return cursor;
  });
}
/** Compatibility sink: durable receive + immediate confirmation. The DSH plugin uses prepare/confirm separately. */
export function drainSteering(file, options = {}) {
  if (channelDescriptor(file)) {
    const opts = { ...options, agentId: options.agentId ?? 'offline-sink', agentRole: 'main', callId: options.callId ?? crypto.randomUUID() };
    const messages = prepareSteering(file, opts); if (messages.length) confirmSteering(file, messages, { ...opts, persisted: true }); return messages;
  }
  return withFileLockSync(file + '.consume.lock', () => {
    const all = readChannelRecords(file);
    const cursor = all.reduce((n, value) => value.type === 'cursor' ? Math.max(n, value.seq ?? value.lastDeliveredSeq ?? 0) : n, 0);
    const pending = all.filter(r => r.type === 'steer' && r.seq > cursor && typeof r.text === 'string' && r.text.trim()).sort((a,b) => a.seq - b.seq).slice(0, Math.min(20, options.maxMessages ?? 20));
    if (pending.length) appendJsonLine(file, { type: 'cursor', seq: pending.at(-1).seq, lastDeliveredSeq: pending.at(-1).seq, ts: Date.now() });
    return pending;
  });
}
export class ReportShardReader {
  constructor(file, owner, { onMalformed = () => {} } = {}) { this.file = file; this.owner = owner; this.readers = new Map(); this.onMalformed = onMalformed; }
  poll(visit) {
    const descriptor = channelDescriptor(this.file, this.owner); if (!descriptor) return;
    const dir = channelPaths(this.file).reports; if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir).sort()) {
      if (!/^report-[a-zA-Z0-9-]+\.ndjson$/.test(name)) continue;
      let reader = this.readers.get(name); if (!reader) { reader = new JsonLineReader(path.join(dir, name), { onMalformed: this.onMalformed }); this.readers.set(name, reader); }
      reader.poll(record => { assertOwner(record, this.owner.conversationKey, this.owner.taskId); if (record.version !== 2 || !record.eventId) throw new Error('Invalid report protocol.'); const payload = channelReportToPayload(record); if (payload) visit(payload); });
    }
  }
}
export function requestCancellation(file, reason, expected) {
  const owner = channelDescriptor(file, expected); if (!owner) throw new Error('Versioned channel required for cancellation.');
  writeJsonAtomic(channelPaths(file).control, { ...owner, cancel: { ...reason, requestedAt: Date.now() } });
}
export function readCancellation(file, expected) {
  const value = readJson(channelPaths(file).control, { optional: true }); if (!value) return null;
  assertOwner(value, expected.conversationKey, expected.taskId); return value.cancel ?? null;
}
