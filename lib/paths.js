/**
 * Filesystem locations used by the bridge.
 *
 * Everything the bridge writes is derived from one state root, so an operator can
 * wipe or relocate the entire footprint with a single environment variable.
 * @module dsh-mcp/paths
 */

import crypto from 'node:crypto';
import {runtimeEnv} from './config.js';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Absolute path of this module's directory.
 *
 * `import.meta.dirname` is the primary source; the `fileURLToPath` fallback keeps
 * the module usable on runtimes that do not expose it.
 * @returns {string} absolute directory path.
 */
export function moduleDir() {
  if (import.meta.dirname !== undefined) return import.meta.dirname;
  return path.dirname(fileURLToPath(import.meta.url));
}

/** Absolute path of the repository root (the directory holding `package.json`). */
export function repoRoot() {
  return path.resolve(moduleDir(), '..');
}

/** Absolute path of the bundled DSH-side plugin package. */
export function pluginPackageDir() {
  return path.join(repoRoot(), 'dsh-plugin');
}

/**
 * Root directory holding per-conversation state.
 *
 * Windows uses `%LOCALAPPDATA%`; other platforms follow the XDG-ish convention of
 * `~/.local/state`. `DSH_MCP_STATE` overrides both.
 * @returns {string} absolute directory path.
 */
export function stateRoot(env = process.env) {
  env=runtimeEnv(env);
  const override = env.DSH_MCP_STATE;
  if (override !== undefined && override.trim() !== '') return path.resolve(override);
  const base = process.platform === 'win32'
    ? (env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'))
    : path.join(os.homedir(), '.local', 'state');
  return process.platform === 'win32' ? path.join(base, 'dsh-mcp', 'state') : path.join(base, 'dsh-mcp');
}

/**
 * Resolve the state directory for one conversation key.
 *
 * The complete, case-sensitive identity is hashed. Owner validation protects each
 * index, task and report; Windows case folding never aliases raw thread keys.
 * @param {string} conversationKey - stable per-conversation identity.
 * @param {string} [root] - override for the state root.
 * @returns {string} absolute directory path.
 */
export function conversationDir(conversationKey, root) {
  if (typeof conversationKey !== 'string' || !conversationKey.length) throw new TypeError('conversation key is required');
  return path.join(root ?? stateRoot(), 'v2-c-' + crypto.createHash('sha256').update(conversationKey, 'utf8').digest('hex'));
}

/**
 * Percent-encode every character that is not safe in a path component.
 *
 * Encoding rather than stripping is deliberate: this is the physical half of the
 * cross-conversation isolation guarantee, task IDs remain safe single components. Conversation identities use hashing.
 * @param {string} value - raw conversation key.
 * @returns {string} filesystem-safe, collision-free component.
 */
export function encodeKey(value) {
  if (typeof value !== 'string' || value === '') throw new TypeError('encodeKey: value must be a non-empty string');
  let out = '';
  for (const char of value) {
    if (/[A-Za-z0-9._-]/.test(char)) {
      out += char;
      continue;
    }
    const code = char.codePointAt(0);
    for (const byte of Buffer.from(String.fromCodePoint(code), 'utf8')) {
      out += `%${byte.toString(16).padStart(2, '0').toUpperCase()}`;
    }
  }
  // A component that is only dots would resolve to a parent directory.
  if (/^\.+$/.test(out)) {
    out = out.replace(/\./g, '%2E');
  }
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(out)) out = '%' + out.charCodeAt(0).toString(16).toUpperCase() + out.slice(1);
  out = out.replace(/\.+$/, dots => dots.replace(/\./g, '%2E'));
  return out;
}

/** @typedef {object} TaskPaths
 * @property {string} dir task directory.
 * @property {string} overlay per-task loader patch overlay.
 * @property {string} reportLog append-only NDJSON of every event DSH emitted.
 * @property {string} stderrLog captured DSH stderr.
 * @property {string} inbox channel file carrying reports and steering.
 * @property {string} storages per-task projection-cache root.
 * @property {string} sessions default session-log root for a standalone task.
 */

/**
 * Resolve every path belonging to one task.
 * @param {string} conversationKey - stable per-conversation identity.
 * @param {string} taskId - task identifier.
 * @param {string} [root] - override for the state root.
 * @returns {TaskPaths} task paths.
 */
export function taskPaths(conversationKey, taskId, root) {
  return taskPathsIn(conversationDir(conversationKey, root), taskId);
}

/**
 * Resolve every path belonging to one task under an explicit conversation directory.
 *
 * This is the single definition of the task layout: a caller that already knows the
 * conversation directory uses it directly rather than recomputing the paths.
 * @param {string} conversationPath - conversation state directory.
 * @param {string} taskId - task identifier.
 * @returns {TaskPaths} task paths.
 */
export function taskPathsIn(conversationPath, taskId) {
  const dir = path.join(conversationPath, 'tasks', encodeKey(taskId));
  return {
    dir,
    overlay: path.join(dir, 'overlay.yml'),
    reportLog: path.join(dir, 'events.ndjson'),
    stderrLog: path.join(dir, 'dsh.stderr.log'),
    inbox: path.join(dir, 'inbox.json'),
    control: path.join(dir, 'control.json'),
    result: path.join(dir, 'result.json'),
    reports: path.join(dir, 'reports'),
    steering: path.join(dir, 'steering.ndjson'),
    storages: path.join(dir, 'storages'),
    sessions: path.join(dir, 'sessions'),
  };
}

/**
 * Diagnostic log recording one line per bridge lifecycle decision.
 * @param {string} conversationKey - stable per-conversation identity.
 * @param {string} [root] - override for the state root.
 * @returns {string} absolute file path.
 */
export function bridgeLogPath(conversationKey, root) {
  return path.join(conversationDir(conversationKey, root), 'bridge.log');
}

/**
 * Session-log root shared by every task in one conversation.
 *
 * Sessions are per conversation and not per task, because DSH adopts a persisted
 * session by id and needs to find its log: a follow-up task that continued a session
 * stored in its own directory would fail with "session does not exist". Sharing the
 * root is safe because the bridge runs one task at a time per conversation.
 * @param {string} conversationKey - stable per-conversation identity.
 * @param {string} [root] - override for the state root.
 * @returns {string} absolute directory path.
 */
export function conversationSessionRoot(conversationKey, root) {
  return path.join(conversationDir(conversationKey, root), 'sessions');
}
