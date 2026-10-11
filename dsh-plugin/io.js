/** Crash-safe file utilities. All communication logs are append-only. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function readJson(file, { optional = false } = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
}
export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + process.pid + '.' + crypto.randomUUID() + '.tmp';
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n', 'utf8');
    fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, file);
  } finally { if (fd !== undefined) fs.closeSync(fd); if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
export function appendJsonLine(file, value, { sync = true, separateTornTail = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, separateTornTail ? 'a+' : 'a', 0o600);
  try {
    if(separateTornTail){const size=fs.fstatSync(fd).size;if(size){const last=Buffer.alloc(1);fs.readSync(fd,last,0,1,size-1);if(last[0]!==10)fs.writeFileSync(fd,'\n','utf8');}}
    fs.writeFileSync(fd, JSON.stringify(value) + '\n', 'utf8'); if (sync) fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}
export function assertOwner(value, conversationKey, taskId) {
  if (!value || value.conversationKey !== conversationKey || (taskId !== undefined && value.taskId !== taskId)) {
    const error = new Error('State ownership mismatch; refusing to reuse or expose this state.');
    error.code = 'STATE_OWNER_MISMATCH'; throw error;
  }
}
/** Incremental byte reader: incomplete lines (including UTF-8 fragments) survive polls. */
export class JsonLineReader {
  constructor(file, { onMalformed = () => {}, maxLineBytes = 64 * 1024 * 1024, offset = 0 } = {}) {
    this.file = file; this.offset = offset; this.lineOffset = offset; this.pending = Buffer.alloc(0);
    this.onMalformed = onMalformed; this.maxLineBytes = maxLineBytes;
  }
  poll(visit, { maxBytes = Infinity, maxRecords = Infinity } = {}) {
    let records=0;
    let fd;
    try { fd = fs.openSync(this.file, 'r'); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    try {
      const size = fs.fstatSync(fd).size;
      if (size < this.offset) throw new Error('Append-only log was truncated: ' + this.file);
      const target = Math.min(size, this.offset + maxBytes);
      const chunk = Buffer.alloc(Math.min(64 * 1024, Math.max(1, target - this.offset)));
      while (this.offset < target) {
        const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, target - this.offset), this.offset);
        if (!n) break;
        this.offset += n;
        const bytes = this.pending.length ? Buffer.concat([this.pending, chunk.subarray(0, n)]) : chunk.subarray(0, n);
        let start = 0, end;
        while ((end = bytes.indexOf(10, start)) !== -1) {
          const line = bytes.subarray(start, end); start = end + 1;
          if (!line.length) continue;
          if (line.length > this.maxLineBytes) throw new Error('Log record exceeds the safety limit: ' + this.file);
          let value;
          try { value = JSON.parse(line.toString('utf8')); }
          catch (error) { this.onMalformed(error, this.offset - (bytes.length - end)); continue; }
          this.lineOffset = this.offset - (bytes.length - end - 1);
          const proceed=visit(value);
          records++;
          if(proceed===false || records>=maxRecords) { this.offset=this.lineOffset;this.pending=Buffer.alloc(0);return; }
        }
        this.pending = Buffer.from(bytes.subarray(start));
        if (this.pending.length > this.maxLineBytes) throw new Error('Unterminated log record exceeds the safety limit: ' + this.file);
      }
    } finally { fs.closeSync(fd); }
  }
}
export function scanJsonLines(file, visit, options) { const reader = new JsonLineReader(file, options); reader.poll(visit); return reader; }
export function boundUtf8(value, maxBytes) {
  const text = typeof value === 'string' ? value : value == null ? '' : String(value);
  if (Buffer.byteLength(text) <= maxBytes) return { text, truncated: false };
  let bytes = Buffer.from(text).subarray(0, Math.max(0, maxBytes));
  let end = bytes.length;
  while (end > 0 && (bytes[end - 1] & 0xc0) === 0x80) end--;
  if (end < bytes.length) {
    const lead = bytes[end - 1]; const needed = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : 2;
    if (bytes.length - (end - 1) < needed) bytes = bytes.subarray(0, end - 1);
  } else if (end && bytes[end - 1] >= 0xc0) bytes = bytes.subarray(0, end - 1);
  return { text: bytes.toString('utf8'), truncated: true };
}
