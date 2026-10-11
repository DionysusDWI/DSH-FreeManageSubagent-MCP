/** Conversation metadata is accepted from the host, not manufactured here.
 * Strict binding is fail-closed; optional multiplexing requires threadId on every
 * call. Tests with injected metadata are not actual Codex interoperability proof.
 * Full exact identities map to hashed, owner-checked state directories.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ReportQueue } from './report-queue.js';
import { prepareConversationDirectory } from './migrate.js';
import { TaskStore } from './store.js';
import { bridgeLogPath, conversationDir, taskPathsIn } from './paths.js';


/** Environment variable pinning the conversation key. */
export const CONVERSATION_ENV = 'CODEX_DSH_MCP_CONVERSATION';

/** `_meta` key Codex uses for the thread (conversation) id. */
export const META_THREAD_KEY = 'threadId';

/** `_meta` key Codex uses for the session id. */
export const META_SESSION_KEY = 'sessionId';

/**
 * Extract a non-empty string from a metadata object.
 * @param {unknown} meta - candidate metadata.
 * @param {string} key - key to read.
 * @returns {string|null} the value, or null.
 */
function readMetaString(meta, key) {
  if (meta === null || typeof meta !== 'object') return null;
  const value = /** @type {Record<string, unknown>} */ (meta)[key];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * Derive the conversation key for one request.
 *
 * @param {object} options - resolution options.
 * @param {object} [options.meta] - the request's `_meta` object.
 * @param {NodeJS.ProcessEnv} [options.env] - environment to consult.
 * @param {string} options.instanceKey - per-process fallback id.
 * @returns {{key: string, source: string, threadId: string|null, sessionId: string|null}} resolution.
 */
export function deriveConversationKey(options) {
  const threadId = readMetaString(options.meta, META_THREAD_KEY);
  const sessionId = readMetaString(options.meta, META_SESSION_KEY);

  if (threadId !== null) return { key: threadId, source: `_meta.${META_THREAD_KEY}`, threadId, sessionId };
  if (sessionId !== null) return { key: sessionId, source: `_meta.${META_SESSION_KEY}`, threadId, sessionId };

  const pinned = options.env?.[CONVERSATION_ENV];
  if (typeof pinned === 'string' && pinned.trim() !== '') {
    return { key: pinned, source: CONVERSATION_ENV, threadId, sessionId };
  }

  return { key: options.instanceKey, source: 'process-instance', threadId, sessionId };
}

/**
 * Generate a per-process conversation key.
 * @returns {string} key such as `local-9f3a1c2b4d5e`.
 */
export function createInstanceKey() {
  return `local-${crypto.randomBytes(6).toString('hex')}`;
}

/**
 * Owns the report queue, task store, and diagnostic log for one conversation.
 */
export class ConversationContext {
  /**
   * @param {object} options - context options.
   * @param {string} options.key - conversation key.
   * @param {string} options.source - how the key was resolved.
   * @param {string|null} options.threadId - Codex thread id, when supplied.
   * @param {string|null} options.sessionId - Codex session id, when supplied.
   * @param {string} [options.stateRoot] - override for the state root; the tests
   *   use it so an isolated run never touches the operator's real state.
   */
  constructor(options) {
    this.key = options.key;
    this.source = options.source;
    this.threadId = options.threadId;
    this.sessionId = options.sessionId;
    this.stateRoot = options.stateRoot;
    this.dir = prepareConversationDirectory(this.key, this.stateRoot);
    this.logPath = bridgeLogPath(this.key, this.stateRoot);
    fs.mkdirSync(this.dir, { recursive: true });
    this.queue = new ReportQueue({
      conversationKey: this.key,
      logPath: path.join(this.dir, 'reports.ndjson'),
      onDiagnostic: (line) => this.diagnostic(line),
    });
    this.store = new TaskStore({
      conversationKey: this.key,
      dir: this.dir,
      onDiagnostic: (line) => this.diagnostic(line),
    });
    /** @type {Map<string, AbortController>} taskId -> cancellation controller. */
    this.controllers = new Map();
    /** @type {Promise<unknown>} tail of the per-conversation task queue. */
    this.taskChain = Promise.resolve();
  }

  /**
   * Run `work` after every task already queued for this conversation.
   *
   * Tasks in one conversation share a session-log root, and DSH takes a kernel lock
   * on a session log, so two concurrent tasks in the same conversation could refuse
   * each other. Serializing here also matches how the session is meant to behave: one
   * DSH conversation advances one task at a time. Different conversations have
   * different chains and still run concurrently.
   * @param {() => Promise<T>} work - the task body.
   * @template T
   * @returns {Promise<T>} the task's result.
   */
  async runExclusive(work) {
    const run = this.taskChain.then(work, work);
    // Keep the chain alive whatever the task does, so one failure cannot wedge it.
    this.taskChain = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * Append one line to the conversation's diagnostic log.
   *
   * Diagnostics never throw: they are the last thing that should ever take down a
   * running task.
   * @param {string} line - message text.
   * @returns {void}
   */
  diagnostic(line) {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.appendFileSync(this.logPath, `${new Date().toISOString()} ${line}\n`, 'utf8');
    } catch {
      // Deliberately ignored.
    }
  }

  /**
   * Paths belonging to one task in this conversation.
   * @param {string} taskId - task identifier.
   * @returns {import('./paths.js').TaskPaths} task paths.
   */
  taskPaths(taskId) {
    return taskPathsIn(this.dir, taskId);
  }

  /**
   * The session-log root shared by this conversation's tasks.
   * @returns {string} absolute directory path.
   */
  sessionRoot() {
    return path.join(this.dir, 'sessions');
  }
}

/**
 * Binds one MCP server instance to one conversation.
 */
export class ConversationRegistry {
  /**
   * @param {object} [options] - registry options.
   * @param {NodeJS.ProcessEnv} [options.env] - environment to consult.
   * @param {string} [options.stateRoot] - override for the state root.
   */
  constructor(options = {}) {
    this.env = options.env ?? process.env;
    this.stateRoot = options.stateRoot;
    this.instanceKey = createInstanceKey();
    this.allowMultiplex = options.allowMultiplex === true;
    this.contexts = new Map();
    /** @type {ConversationContext|null} */
    this.context = null;
    /** @type {object|null} */
    this.lastMeta = null;
  }

  /**
   * Resolve the conversation context for one request, binding on first use.
   *
   * @param {object} [meta] - the request's `_meta` object.
   * @returns {ConversationContext} the bound context.
   * @throws {Error} when the request names a different conversation than the bound one.
   */
  resolve(meta) {
    if (meta !== null && typeof meta === 'object') this.lastMeta = meta;
    const resolution = deriveConversationKey({
      meta,
      env: this.env,
      instanceKey: this.instanceKey,
    });

    if (this.allowMultiplex) {
      if (resolution.threadId === null) throw Object.assign(new Error('Metadata multiplexing requires a threadId on every call; identity-less access is refused.'), { code: 'CONVERSATION_METADATA_REQUIRED' });
      let context = this.contexts.get(resolution.key);
      if (!context) { context = new ConversationContext({ ...resolution, stateRoot: this.stateRoot }); this.contexts.set(resolution.key,context); }
      this.context = context; return context;
    }
    if (this.context === null) {
      this.context = new ConversationContext({ ...resolution, stateRoot: this.stateRoot });
      this.context.diagnostic(
        `bound conversation "${resolution.key}" via ${resolution.source}`
        + ` (threadId=${resolution.threadId ?? '-'} sessionId=${resolution.sessionId ?? '-'})`,
      );
      return this.context;
    }

    if (resolution.key !== this.context.key) {
      const error = new Error('Conversation identity mismatch. Refusing to cross conversations or expose another conversation’s state; use a separate bridge or enable explicit metadata multiplexing.');
      error.code = 'CONVERSATION_MISMATCH';
      this.context.diagnostic(`REJECTED request for conversation "${resolution.key}" via ${resolution.source}`);
      throw error;
    }

    return this.context;
  }

  /**
   * The bound context, when a request has already established it.
   * @returns {ConversationContext|null} bound context, or null.
   */
  current() {
    return this.context;
  }
}
