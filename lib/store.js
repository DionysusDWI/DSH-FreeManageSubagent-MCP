/** Versioned, owner-checked conversation persistence. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { conversationDir, encodeKey } from './paths.js';
import { assertOwner, readJson, writeJsonAtomic } from './io.js';
import { confirmedDead, supervisedPids } from './workspace-lock.js';
import { processAlive, withFileLockSync } from './file-lock.js';
export { writeJsonAtomic } from './io.js';
export const TERMINAL_STATES = new Set(['completed', 'failed', 'timeout', 'cancelled', 'interrupted']);
export function createTaskId(now = new Date()) {
  return 't-' + now.toISOString().replace(/[-:.]/g, '').slice(0, 15) + '-' + crypto.randomBytes(6).toString('hex');
}
export class TaskStore {
  constructor(options) {
    if (typeof options?.conversationKey !== 'string' || !options.conversationKey) throw new TypeError('TaskStore requires an owner');
    this.version = options.version ?? 2; this.namespace = options.namespace;this.storageKey=options.storageKey;
    this.conversationKey = options.conversationKey; this.dir = options.dir ?? conversationDir(this.conversationKey);
    this.onDiagnostic = options.onDiagnostic ?? (() => {}); this.indexPath = path.join(this.dir, 'tasks.json');
    this.lockPath = path.join(this.dir, '.store.lock');
    withFileLockSync(this.lockPath, () => {
      const ownerFile = path.join(this.dir, 'owner.json');
      const owner = readJson(ownerFile, { optional: true });
      if (owner) { assertOwner(owner, this.conversationKey); if(owner.version!==this.version||this.version===3&&(owner.namespace!==this.namespace||owner.storageKey!==this.storageKey))throw new Error('Unsupported/corrupt owner record.'); }
      else {
        if (fs.existsSync(this.indexPath)) throw Object.assign(new Error('Unversioned state requires explicit ownership migration.'), { code: 'MIGRATION_REQUIRED' });
        writeJsonAtomic(ownerFile, { version: this.version, conversationKey: this.conversationKey,...(this.version===3?{namespace:this.namespace,storageKey:this.storageKey}:{}) });
      }
      if (!fs.existsSync(this.indexPath)) this.writeIndex(this.emptyIndex()); else this.readIndex();
    });
  }
  emptyIndex() { return { version: this.version, conversationKey: this.conversationKey,...(this.version===3?{namespace:this.namespace,storageKey:this.storageKey}:{}), order: [], sessionId: null, sessionWorkspace: null, sessionVerified: false }; }
  readIndex() {
    const raw = readJson(this.indexPath, { optional: true }); if (!raw) return this.emptyIndex();
    assertOwner(raw, this.conversationKey);
    if (raw.version !== this.version || !Array.isArray(raw.order)||this.version===3&&(new Set(raw.order).size!==raw.order.length||raw.order.some(id=>typeof id!=='string'||!id)||raw.namespace!==this.namespace||raw.storageKey!==this.storageKey)) throw new Error('Unsupported/corrupt task index.');
    return { ...raw, order: [...new Set(raw.order.filter(id => typeof id === 'string' && id.length))] };
  }
  writeIndex(index) { assertOwner(index, this.conversationKey); writeJsonAtomic(this.indexPath, { ...index, version: this.version }); }
  taskDir(taskId) { return path.join(this.dir, 'tasks', encodeKey(taskId)); }
  getTask(taskId) {
    let raw;
    try { raw = readJson(path.join(this.taskDir(taskId), 'task.json'), { optional: true }); }
    catch (e) { this.onDiagnostic('Unreadable task record: ' + e.message); return null; }
    if (!raw || raw.taskId !== taskId || raw.conversationKey !== this.conversationKey) return null;
    if(this.version===3&&(raw.version!==3||raw.namespace!==this.namespace||raw.storageKey!==this.storageKey))throw new Error('Unsupported/corrupt task record.');
    return raw;
  }
  putTask(record) {
    assertOwner(record, this.conversationKey);
    return withFileLockSync(this.lockPath, () => {
      const index = this.readIndex();
      const priorRaw = readJson(path.join(this.taskDir(record.taskId), 'task.json'), { optional: true });
      if(priorRaw) assertOwner(priorRaw,this.conversationKey,record.taskId);
      const prior = this.getTask(record.taskId);
      if (prior && TERMINAL_STATES.has(prior.state) && prior.state !== record.state) throw new Error('Cannot reopen a terminal task.');
      writeJsonAtomic(path.join(this.taskDir(record.taskId), 'task.json'), { ...record, version: this.version });
      if (!index.order.includes(record.taskId)) { index.order.push(record.taskId); this.writeIndex(index); }
      return record;
    });
  }
  listTasks({ limit = Infinity } = {}) {
    const records = [];
    for (const taskId of this.readIndex().order.slice().reverse()) {
      const task = this.getTask(taskId); if (task) records.push(task);
      if (records.length >= Math.max(1, limit)) break;
    }
    return records;
  }
  latestTask() { return this.listTasks({ limit: 1 })[0] ?? null; }
  readSession() {
    const index = this.readIndex();
    return { sessionId: index.sessionId ?? null, workspace: index.sessionWorkspace ?? null, verified: index.sessionVerified === true, taskId: index.sessionTaskId ?? null };
  }
  writeSession(sessionId, workspace, { taskId = null, verified = true } = {}) {
    if (typeof sessionId !== 'string' || !sessionId) throw new TypeError('Session ID required');
    withFileLockSync(this.lockPath, () => {
      const index = this.readIndex();
      Object.assign(index, { sessionId, sessionWorkspace: workspace, sessionVerified: verified, sessionTaskId: taskId }); this.writeIndex(index);
    });
  }
  clearSession() { withFileLockSync(this.lockPath, () => { const index = this.readIndex(); Object.assign(index, { sessionId: null, sessionWorkspace: null, sessionVerified: false, sessionTaskId: null }); this.writeIndex(index); }); }
  recoverInterrupted() {
    for (const task of this.listTasks()) {
      if (TERMINAL_STATES.has(task.state) || processAlive(task.executorPid) === true) continue;
      const now = Date.now(),pids=supervisedPids(task),treeExited=task.state==='queued'||confirmedDead(pids);
      if(!treeExited) {
        const file=path.join(this.dir,'.execution-quarantine.json');
        withFileLockSync(file+'.lock',()=> {
          const prior=readJson(file,{optional:true});if(prior)assertOwner(prior,this.conversationKey);
          const processPids=prior?(prior.processPids?.length&&pids.length?[...new Set([...prior.processPids,...pids])]:[]):pids;
          writeJsonAtomic(file,{version:2,conversationKey:this.conversationKey,taskId:task.taskId,taskIds:[...new Set([...(prior?.taskIds ?? []),...(prior?.taskId?[prior.taskId]:[]),task.taskId])],processPids,createdAt:prior?.createdAt ?? now});
        });
      }
      this.putTask({ ...task, state: 'interrupted', phase: 'settled', updatedAt: now,finishedAt:now,treeExited,quarantined:!treeExited,durationMs: now - task.createdAt,
        reason: { kind: 'interrupted', code: 'BRIDGE_EXITED', message: 'The previous bridge exited before this task settled. It was not replayed.' } });
    }
  }
}
