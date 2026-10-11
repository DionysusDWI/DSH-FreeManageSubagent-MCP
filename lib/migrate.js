/** Copy-only migration. Ambiguous legacy Windows directories are never reused. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { conversationDir, encodeKey, stateRoot } from './paths.js';
import { assertOwner, readJson, scanJsonLines, writeJsonAtomic } from './io.js';
import { withFileLockSync,processAlive } from './file-lock.js';
function ambiguous() { return Object.assign(new Error('Legacy state ownership is ambiguous. Original data was preserved; use a new state root or explicitly resolve the legacy ownership.'), { code: 'AMBIGUOUS_LEGACY_STATE' }); }
function inspectTree(dir) {
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name), stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw ambiguous();
    if (stat.isDirectory()) inspectTree(file);
  }
}
export function prepareConversationDirectory(key, root = stateRoot()) {
  const target = conversationDir(key, root);
  return withFileLockSync(path.join(root, '.migration.lock'), () => {
    if (fs.existsSync(target)) { assertOwner(readJson(path.join(target, 'owner.json')), key); return target; }
    const legacy = path.join(root, encodeKey(key));
    if (!fs.existsSync(legacy)) {
      fs.mkdirSync(target, { recursive: true }); writeJsonAtomic(path.join(target, 'owner.json'), { version: 2, conversationKey: key }); return target;
    }
    inspectTree(legacy);
    let index;
    try { index = readJson(path.join(legacy, 'tasks.json')); } catch { throw ambiguous(); }
    if (!index || !Array.isArray(index.order)) throw ambiguous();
    if (index.conversationKey !== undefined && index.conversationKey !== key) throw ambiguous();
    const tasksDir = path.join(legacy, 'tasks'), records = [];
    if (fs.existsSync(tasksDir)) for (const name of fs.readdirSync(tasksDir)) {
      const record = readJson(path.join(tasksDir, name, 'task.json'), { optional: true });
      if (!record || record.conversationKey !== key || encodeKey(record.taskId) !== name) throw ambiguous();
      if(!['completed','failed','timeout','cancelled','interrupted'].includes(record.state)) throw ambiguous();
      records.push(record);
    }
    if (!records.length || index.order.some(id => !records.some(t => t.taskId === id))) throw ambiguous();
    if (index.sessionId && !records.some(t => t.sessionId === index.sessionId)) throw ambiguous();
    scanJsonLines(path.join(legacy, 'reports.ndjson'), record => { if (record.conversationKey !== key) throw ambiguous(); }, { onMalformed: () => { throw ambiguous(); } });
    // No source file is modified or removed. A unique staging directory is renamed only after validation.
    const temp = target + '.migration-' + crypto.randomUUID();
    fs.cpSync(legacy, temp, { recursive: true, errorOnExist: true, force: false, dereference: false });
    writeJsonAtomic(path.join(temp, 'owner.json'), { version: 2, conversationKey: key, migratedFrom: legacy });
    writeJsonAtomic(path.join(temp, 'tasks.json'), { ...index, version: 2, conversationKey: key,
      sessionVerified: Boolean(index.sessionId), sessionTaskId: records.find(t => t.sessionId === index.sessionId)?.taskId ?? null });
    fs.renameSync(temp, target); return target;
  });
}
