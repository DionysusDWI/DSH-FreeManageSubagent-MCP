/** Cooperative cross-process locks. Unknown owners are never stolen. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readJson } from './io.js';

export function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'ESRCH' ? false : true; }
}
const sleeper = new Int32Array(new SharedArrayBuffer(4));
// A Windows lock directory can briefly be delete-pending while its owner
// releases it. Only retry EPERM from this directory inspection, never a write,
// rename or owner-removal error. A persistent denial keeps its original error.
function readLockNames(file) {
  for (let attempt = 1; ; attempt++) {
    try { return fs.readdirSync(file); }
    catch (error) {
      if (error.code === 'ENOENT') return null;
      if (process.platform !== 'win32' || error.code !== 'EPERM' || attempt >= 3) throw error;
      Atomics.wait(sleeper, 0, 0, 10);
    }
  }
}
function tryAcquire(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const token = crypto.randomUUID();
  const candidate = file + '.claim-' + token;
  const ownerName = token + '.json';
  fs.mkdirSync(candidate);
  const ownerPath = path.join(candidate, ownerName);
  let claimed = false;
  try {
    const fd = fs.openSync(ownerPath, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ version: 1, pid: process.pid, token, createdAt: Date.now() })); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    // Rename a NONEMPTY directory: another claim cannot replace it on any platform.
    try { fs.renameSync(candidate, file); claimed = true; }
    catch (e) { if (!fs.existsSync(file) && !['ENOENT','EEXIST','ENOTEMPTY','EPERM','EACCES'].includes(e.code)) throw e; }
  } finally {
    if (!claimed) { if (fs.existsSync(ownerPath)) fs.unlinkSync(ownerPath); fs.rmdirSync(candidate); }
  }
  if (claimed) return () => {
    const owned = path.join(file, ownerName);
    const owner = readJson(owned);
    if (owner.token !== token) throw new Error('Lock ownership changed.');
    fs.unlinkSync(owned); fs.rmdirSync(file);
  };
  const names = readLockNames(file);
  if (names === null) return null;
  if (names.length !== 1 || !names[0].endsWith('.json')) return null;
  const owned = path.join(file, names[0]);
  let owner;
  try { owner = readJson(owned); } catch { return null; }
  if (processAlive(owner.pid) === false) {
    // Delete only the unique dead owner's file, never a replacement owner's path.
    try { fs.unlinkSync(owned); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    try { fs.rmdirSync(file); } catch (e) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(e.code)) throw e; }
  }
  return null;
}
export function withFileLockSync(file, work, { timeoutMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const release = tryAcquire(file);
    if (release) { try { return work(); } finally { release(); } }
    if (Date.now() >= deadline) { const e = new Error('Timed out acquiring state lock.'); e.code = 'LOCK_TIMEOUT'; throw e; }
    Atomics.wait(sleeper, 0, 0, 10);
  }
}
export function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('Cancelled'));
    const timer = setTimeout(done, ms);
    function done() { signal?.removeEventListener('abort', abort); resolve(); }
    function abort() { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason ?? new Error('Cancelled')); }
    signal?.addEventListener('abort', abort, { once: true });
  });
}
export async function acquireFileLock(file, { signal, deadline = Infinity, pollMs = 25 } = {}) {
  while (true) {
    if (signal?.aborted) throw signal.reason ?? new Error('Cancelled');
    const release = tryAcquire(file); if (release) return release;
    if (Date.now() >= deadline) { const e = new Error('Deadline exceeded acquiring state lock.'); e.code = 'LOCK_TIMEOUT'; throw e; }
    await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())), signal);
  }
}
