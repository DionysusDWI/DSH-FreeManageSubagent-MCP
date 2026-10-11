/** Durable event-ID queue. Disk is authoritative; hot data is strictly bounded. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { appendJsonLine, assertOwner, boundUtf8, JsonLineReader, readJson, scanJsonLines, writeJsonAtomic } from './io.js';
import { withFileLockSync } from './file-lock.js';
export const REPORT_KINDS = Object.freeze(['progress', 'milestone', 'blocker', 'decision', 'final', 'system']);
export function normalizeKind(kind) { return REPORT_KINDS.includes(kind) ? kind : 'progress'; }
export class ReportQueue {
  constructor(options) {
    if (typeof options?.conversationKey !== 'string' || !options.conversationKey || typeof options.logPath !== 'string' || !options.logPath) throw new TypeError('ReportQueue requires owner and logPath');
    this.conversationKey = options.conversationKey; this.logPath = options.logPath;
    this.maxTextBytes = options.maxTextBytes ?? 16 * 1024; this.maxReportsPerTask = options.maxReportsPerTask ?? 2000;
    this.maxHotReports = options.maxHotReports ?? 2000; this.maxHotTasks = options.maxHotTasks ?? 256;
    this.onDiagnostic = options.onDiagnostic ?? (() => {});
    this.byTask = new Map(); this.seqByTask = new Map(); this.seen = new Set(); this.listeners = new Set(); this.hotCount = 0;
    this.reader = new JsonLineReader(this.logPath, { onMalformed: () => this.onDiagnostic('Incomplete/corrupt report record retained on disk; not treated as delivered.') });
    this.refresh();
  }
  eventId(record) { return typeof record.eventId === 'string' && record.eventId ? record.eventId : 'legacy:' + crypto.createHash('sha256').update(JSON.stringify(record)).digest('hex'); }
  key(taskId, eventId) { return taskId + '\0' + eventId; }
  eventPath(taskId, eventId) { return path.join(this.logPath + '.events', crypto.createHash('sha256').update(this.key(taskId, eventId)).digest('hex') + '.json'); }
  display(raw) {
    const bounded = boundUtf8(raw.text, this.maxTextBytes);
    const report = { ...raw, text: bounded.text, eventId: this.eventId(raw) };
    if (bounded.truncated) { report.truncated = true; report.fullContentPath = this.logPath; }
    if (raw.data !== undefined && Buffer.byteLength(JSON.stringify(raw.data)) > this.maxTextBytes) {
      report.data = { truncated: true, full_content_path: this.logPath }; report.dataTruncated = true;
    }
    return report;
  }
  remember(raw) {
    assertOwner(raw, this.conversationKey);
    if (!Number.isSafeInteger(raw.seq) || raw.seq < 1 || typeof raw.taskId !== 'string') throw new Error('Invalid persisted report sequence.');
    this.seqByTask.set(raw.taskId, Math.max(raw.seq, this.seqByTask.get(raw.taskId) ?? 0));
    if (this.seqByTask.size > this.maxHotTasks) this.seqByTask.delete(this.seqByTask.keys().next().value);
    const id = this.key(raw.taskId, this.eventId(raw));
    this.seen.add(id); if (this.seen.size > this.maxHotReports * 2) this.seen.delete(this.seen.values().next().value);
    let bucket = this.byTask.get(raw.taskId);
    if (!bucket) { bucket = []; this.byTask.set(raw.taskId, bucket); }
    bucket.push(this.display(raw)); this.hotCount++;
    while (bucket.length > this.maxReportsPerTask) { bucket.shift(); this.hotCount--; }
    while (this.hotCount > this.maxHotReports || this.byTask.size > this.maxHotTasks) {
      const [task, oldest] = this.byTask.entries().next().value;
      oldest.shift(); this.hotCount--; if (!oldest.length) this.byTask.delete(task);
    }
  }
  refresh() { this.reader.poll(raw => this.remember(raw)); }
  exists(taskId, eventId) {
    if (this.seen.has(this.key(taskId, eventId))) return true;
    const marker = readJson(this.eventPath(taskId, eventId), { optional: true });
    if (marker) { assertOwner(marker, this.conversationKey, taskId); if (marker.eventId !== eventId) throw new Error('Event index collision.'); return true; }
    let found = false;
    scanJsonLines(this.logPath, raw => { assertOwner(raw, this.conversationKey); if (raw.taskId === taskId && this.eventId(raw) === eventId) found = true; });
    return found;
  }
  pushIfNew(input) {
    if (typeof input?.taskId !== 'string' || !input.taskId) throw new TypeError('report requires a taskId');
    if (input.conversationKey !== undefined) assertOwner(input, this.conversationKey);
    const eventId = typeof input.eventId === 'string' && input.eventId ? input.eventId : crypto.randomUUID();
    return withFileLockSync(this.logPath + '.lock', () => {
      this.refresh(); if (this.exists(input.taskId, eventId)) return null;
      const seq = this.latestSeq(input.taskId) + 1;
      const report = { version: 2, conversationKey: this.conversationKey, taskId: input.taskId, eventId, seq,
        kind: normalizeKind(input.kind), text: typeof input.text === 'string' ? input.text : String(input.text ?? ''), ts: Number.isFinite(input.ts) ? input.ts : Date.now() };
      for (const name of ['data', 'agentId', 'agentRole']) if (input[name] !== undefined) report[name] = input[name];
      // A crash-tail is left untouched. A new separator prevents it swallowing the next valid event.
      if (this.reader.pending.length) fs.appendFileSync(this.logPath, '\n');
      appendJsonLine(this.logPath, report);
      writeJsonAtomic(this.eventPath(input.taskId, eventId), { version: 2, conversationKey: this.conversationKey, taskId: input.taskId, eventId, seq });
      this.refresh(); const display = this.display(report);
      for (const listener of this.listeners) { try { listener(display); } catch (e) { this.onDiagnostic('Report listener failed: ' + e.message); } }
      return display;
    });
  }
  push(input) { return this.pushIfNew(input); }
  list({ taskId, since = 0, limit = Infinity, kinds } = {}) {
    this.refresh(); const out = [], selected = kinds?.length ? new Set(kinds) : null;
    scanJsonLines(this.logPath, raw => {
      assertOwner(raw, this.conversationKey);
      if ((taskId === undefined || raw.taskId === taskId) && raw.seq > since && (!selected || selected.has(raw.kind)) && out.length < limit) out.push(this.display(raw));
    });
    return out;
  }
  latestSeq(taskId) {
    this.refresh(); if (this.seqByTask.has(taskId)) return this.seqByTask.get(taskId);
    let seq = 0; scanJsonLines(this.logPath, raw => { assertOwner(raw, this.conversationKey); if (raw.taskId === taskId) seq = Math.max(seq, raw.seq); }); return seq;
  }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  forget(taskId) { const bucket = this.byTask.get(taskId); if (bucket) this.hotCount -= bucket.length; this.byTask.delete(taskId); /* never reset the durable cursor */ }
}
export { boundUtf8 as __boundTextForTests } from './io.js';
