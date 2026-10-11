/** Explicitly authorized ONE-task continuation; never part of npm test. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { resolveRuntime } from '../lib/dsh-profile.js';
import { conversationDir, taskPaths } from '../lib/paths.js';
import { canonicalWorkspace } from '../lib/workspace-lock.js';
import { processAlive, delay } from '../lib/file-lock.js';
import { supervise } from '../lib/supervisor.js';
const TERMINAL = new Set(['completed', 'failed', 'timeout', 'cancelled', 'interrupted']);
const FOLLOW_PROMPT = 'What token did I ask you to remember? Answer only the exact token. Do not run shell commands, read secrets, change files or create subagents.';
function fail(message, code = 'RESUME_PREFLIGHT_FAILED') { throw Object.assign(new Error(message), { code }); }
function json(file) { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
function hash(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function inside(root, rel) {
  if (typeof rel !== 'string' || !rel || path.isAbsolute(rel)) fail('Non-relative manifest path.');
  const file = path.resolve(root, rel), base = path.resolve(root);
  if (!file.startsWith(base + path.sep)) fail('Manifest path escaped its root.');
  let next = base;
  for (const part of path.relative(base, file).split(path.sep)) {
    next = path.join(next, part);
    if (fs.lstatSync(next).isSymbolicLink()) fail('Linked artifact refused.');
  }
  if (!fs.lstatSync(file).isFile()) fail('Artifact is not a regular file.');
  return file;
}
function absoluteDirectory(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) fail('Explicit absolute directories are required.');
  if (fs.lstatSync(value).isSymbolicLink() || !fs.statSync(value).isDirectory()) fail('Directory is not a regular owned location.');
  return fs.realpathSync.native(value);
}
function samePath(a, b) { const x = path.resolve(a), y = path.resolve(b); return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y; }
function overlaps(a, b) { const x = process.platform === 'win32' ? a.toLowerCase() : a, y = process.platform === 'win32' ? b.toLowerCase() : b; return x === y || x.startsWith(y + path.sep) || y.startsWith(x + path.sep); }
export function verifyEvidence(root) {
  root = absoluteDirectory(root);
  const seal = fs.readFileSync(path.join(root, 'evidence-sha256.txt'), 'utf8');
  const seen = new Set();
  for (const line of seal.trim().split(/\r?\n/)) {
    const match = line.match(/^([a-f0-9]{64})  (.+)$/);
    if (!match || seen.has(match[2])) fail('Invalid or duplicate evidence seal row.');
    seen.add(match[2]); if (hash(inside(root, match[2])) !== match[1]) fail('Frozen source evidence changed: ' + match[2]);
  }
  for (const name of ['paid-artifacts.json', 'paid-summary.json', 'paid-preflight.json', 'protected-files.before.json', 'diagnose.after-bootstrap.json']) if (!seen.has(name)) fail('Required evidence is not sealed: ' + name);
  return root;
}
export function verifyRelease(root) {
  root = absoluteDirectory(root); const manifest = json(inside(root, 'release-manifest.json'));
  if (manifest.version !== '0.1.1' || manifest.phase !== 'candidate' || manifest.platform !== process.platform || manifest.arch !== process.arch) fail('Unexpected candidate version/platform.');
  if (!manifest.files || crypto.createHash('sha256').update(JSON.stringify(manifest.files)).digest('hex') !== manifest.fingerprint) fail('Candidate manifest fingerprint mismatch.');
  for (const [rel, expected] of Object.entries(manifest.files)) {
    const file = inside(root, rel); if (fs.statSync(file).size !== expected.bytes || hash(file) !== expected.sha256) fail('Candidate content changed: ' + rel);
  }
  for (const name of ['runtime/node.exe', 'bin/codex-dsh-mcp.js', 'lib/dsh-profile.js', 'native/windows-job-host.exe', 'scripts/check-guardian.js']) if (!manifest.files[name]) fail('Candidate lacks a required bundled component.');
  if (manifest.guardianImageIntegrity !== 'unlabeled' || manifest.runtimeImageIntegrity !== 'unlabeled' || manifest.guardianLabelVerified !== true || manifest.runtimeWriteVerified !== true) fail('Candidate has no successful integrity/write attestation.');
  return { root, manifest, manifestSha256: hash(path.join(root, 'release-manifest.json')), runtime: path.join(root, 'runtime', 'node.exe'), bridge: path.join(root, 'bin', 'codex-dsh-mcp.js') };
}
function inspectExecution(root, alive) {
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) fail('Linked state refused.');
      if (/quarantine/i.test(entry.name) || entry.isDirectory() && /\.lock(?:$|\.claim-)/.test(entry.name)) fail('Execution lock/quarantine retained; manual review required.', 'RESUME_STATE_UNSAFE');
      if (entry.isDirectory()) walk(file);
      else if (entry.name === 'task.json') {
        const task = json(file);
        if (!TERMINAL.has(task.state) || task.state === 'interrupted' || task.phase !== 'settled' || task.treeExited !== true) fail('A previous task is not safely settled.', 'RESUME_STATE_UNSAFE');
        for (const key of ['processPid', 'guardianPid', 'workerPid', 'executorPid']) {
          if (task[key] != null && (!Number.isSafeInteger(task[key]) || task[key] <= 0 || alive(task[key]) !== false)) fail('A registered PID is live or unverified; it was not stopped.', 'RESUME_STATE_UNSAFE');
        }
      } else if (file.includes(path.sep + '_locks' + path.sep) && entry.name.endsWith('.json')) fail('Write-lock state retained; it was not cleared.', 'RESUME_STATE_UNSAFE');
    }
  }
  walk(root);
}
export function preflightResume({ sourceEvidence, releaseRoot }, { alive = processAlive } = {}) {
  sourceEvidence = verifyEvidence(sourceEvidence); const release = verifyRelease(releaseRoot);
  const manifest = json(path.join(sourceEvidence, 'paid-artifacts.json')), paid = json(path.join(sourceEvidence, 'paid-summary.json')), prior = json(path.join(sourceEvidence, 'paid-preflight.json'));
  if (paid.newSession?.passed !== true || paid.newSession.sessionVerified !== true || typeof paid.newSession.sessionId !== 'string' || !paid.newSession.sessionId) fail('No verified completed source session.');
  const scratch = absoluteDirectory(manifest.source), stateRoot = absoluteDirectory(path.join(scratch, 'shared-state'));
  if (!Array.isArray(manifest.files) || !manifest.files.length) fail('Empty original artifact manifest.');
  const names = new Set();
  for (const row of manifest.files) {
    if (names.has(row.file)) fail('Duplicate original artifact.'); names.add(row.file);
    const original = inside(scratch, row.file), archived = inside(path.join(sourceEvidence, 'paid-smoke'), row.file);
    if (fs.statSync(original).size !== row.bytes || hash(original) !== row.sha256 || hash(archived) !== row.sha256) fail('Original or archived artifact drift: ' + row.file);
  }
  if (!names.has('mcp-calls.ndjson')) fail('Original call audit is missing.');
  const audit = fs.readFileSync(path.join(scratch, 'mcp-calls.ndjson'), 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
  const request = audit.find(row => row.phase === 'request' && row.tool === 'dsh_task' && row.arguments?.new_session === true);
  const match = request?.arguments?.prompt?.match(/Remember this token for my next message: (DSH-MEMORY-[0-9a-f]{16})\./);
  if (!request || !match || typeof request.thread_id !== 'string' || !request.thread_id || request.thread_id === request.thread_id.toLowerCase()) fail('Source identity/marker could not be unambiguously recovered.');
  const thread = request.thread_id, workspace = absoluteDirectory(request.arguments.workspace), ownerDir = conversationDir(thread, stateRoot), owner = json(path.join(ownerDir, 'owner.json')), index = json(path.join(ownerDir, 'tasks.json'));
  if (!samePath(workspace, path.join(scratch, 'project')) || owner.version !== 2 || owner.conversationKey !== thread || index.version !== 2 || index.conversationKey !== thread || index.sessionVerified !== true || index.sessionId !== paid.newSession.sessionId || !samePath(index.sessionWorkspace, workspace) || index.sessionTaskId !== paid.newSession.taskId || !Array.isArray(index.order)) fail('Owner/workspace/verified session index mismatch.');
  inspectExecution(stateRoot, alive);
  const first = json(path.join(taskPaths(thread, paid.newSession.taskId, stateRoot).dir, 'task.json'));
  if (first.conversationKey !== thread || first.taskId !== paid.newSession.taskId || first.state !== 'completed' || first.sessionId !== index.sessionId || !index.order.includes(first.taskId)) fail('Source completed task does not match its session index.');
  const ownerRel = path.relative(scratch, ownerDir).replaceAll('\\', '/');
  const sessions = manifest.files.filter(row => row.file.startsWith(ownerRel + '/sessions/') && row.file.endsWith('/' + index.sessionId + '/session.v4.jsonl.zstd'));
  if (sessions.length !== 1 || sessions[0].bytes <= 0) fail('Original persisted session is absent or ambiguous.');
  const policy = json(path.join(taskPaths(thread, first.taskId, stateRoot).dir, 'policy.json'));
  if (policy.verified !== true || policy.conversationKey !== thread || policy.taskId !== first.taskId || policy.sessionId !== index.sessionId || policy.agentId !== index.sessionId || policy.agentRole !== 'main' || policy.sandboxMode !== 'read-only' || policy.approvalPolicy !== 'ask' || canonicalWorkspace(policy.workspace) !== canonicalWorkspace(workspace)) fail('Source session policy proof mismatch.');
  return { sourceEvidence, release, scratch, stateRoot, ownerDir, thread, otherThread: thread.toLowerCase(), workspace, sessionId: index.sessionId, expectedToken: match[1], originalTaskIds: [...index.order], home: prior.home, priorDefaultModel: prior.defaultModel };
}
function syncJsonNew(file, value) { const fd = fs.openSync(file, 'wx', 0o600); try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
export function createAuditedCaller(evidenceDir) {
  let sequence = 0, attempts = 0, reserved = false;
  function audit(record) { const fd = fs.openSync(path.join(evidenceDir, 'mcp-calls.ndjson'), 'a', 0o600); try { fs.writeFileSync(fd, JSON.stringify({ timestamp: new Date().toISOString(), ...record }) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
  async function call(bridge, tool, args, thread) {
    if (tool === 'dsh_task') {
      if (reserved || attempts) fail('One-task continuation budget exhausted; no replay.', 'PAID_TASK_BUDGET_EXHAUSTED');
      syncJsonNew(path.join(evidenceDir, 'submit-once.json'), { maximumTopLevelTaskAttempts: 1, reservedAt: new Date().toISOString(), tool, thread, arguments: args }); reserved = true;
    }
    const callId = ++sequence; audit({ phase: 'request', call_id: callId, tool, thread_id: thread, arguments: args });
    if (tool === 'dsh_task') attempts++;
    try { const result = await bridge.client.request({ method: 'tools/call', params: { name: tool, arguments: args, _meta: { threadId: thread } } }, CallToolResultSchema, { timeout: 45000, resetTimeoutOnProgress: false }); audit({ phase: 'response', call_id: callId, tool, thread_id: thread, result }); return result; }
    catch (error) { audit({ phase: 'error', call_id: callId, tool, thread_id: thread, error: { name: error.name, message: error.message, code: error.code } }); throw error; }
  }
  return { call, stats: () => ({ actualTopLevelTaskAttempts: attempts, reserved, maximumTopLevelTaskAttempts: 1, automaticRetries: 0 }) };
}
function text(value) { return (value.content ?? []).filter(row => row.type === 'text').map(row => row.text).join('\n'); }
export async function resumeWithClients(ctx, bridge, other, caller, { now = Date.now } = {}) {
  const self = await caller.call(bridge, 'dsh_self_check', {}, ctx.thread);
  if (self.isError || !/profile ready: true/.test(text(self))) fail('New profile is not ready; separate authorized bootstrap is required.', 'PROFILE_NOT_READY');
  const denied = await caller.call(other, 'dsh_status', { task_id: ctx.originalTaskIds[0] }, ctx.otherThread);
  const cross = await caller.call(bridge, 'dsh_self_check', {}, ctx.otherThread);
  for (const result of [denied, cross]) if (result.isError !== true || JSON.stringify(result).includes(ctx.expectedToken) || JSON.stringify(result).includes(ctx.sessionId) || JSON.stringify(result).includes(ctx.originalTaskIds[0])) fail('Scripted owner isolation failed before submission.');
  const started = await caller.call(bridge, 'dsh_task', { prompt: FOLLOW_PROMPT, workspace: ctx.workspace, new_session: false, sandbox_mode: 'read-only', background: true, timeout_ms: 600000 }, ctx.thread);
  if (started.isError || !started.structuredContent?.task_id) fail('Continuation submission failed; no retry will be made.', 'RESUME_TASK_FAILED');
  const id = started.structuredContent.task_id; let cursor = 0, task; const until = now() + 620000, reports = [];
  while (now() < until) {
    const page = await caller.call(bridge, 'dsh_status', { task_id: id, cursor, wait_ms: 30000, limit: 200 }, ctx.thread);
    if (page.isError || !page.structuredContent) fail('Continuation status failed; no task will be resubmitted.');
    task = page.structuredContent; if (task.task_id !== id || !Number.isSafeInteger(task.cursor) || task.cursor < cursor) fail('Status identity/cursor mismatch.');
    cursor = task.cursor; reports.push(...(task.reports ?? [])); if (TERMINAL.has(task.state) && task.has_more === false) break;
  }
  if (task?.state !== 'completed' || task.has_more !== false) fail('Continuation did not complete and drain; no retry will be made.', 'RESUME_TASK_FAILED');
  if (task.session_id !== ctx.sessionId || (task.answer ?? '').trim() !== ctx.expectedToken) fail('Continuation did not return the exact marker in the original session.');
  const paths = taskPaths(ctx.thread, id, ctx.stateRoot), record = json(path.join(paths.dir, 'task.json')), policy = json(path.join(paths.dir, 'policy.json'));
  if (record.conversationKey !== ctx.thread || record.taskId !== id || record.state !== 'completed' || record.phase !== 'settled' || record.treeExited !== true || record.adoptedSessionId !== ctx.sessionId || record.sessionId !== ctx.sessionId) fail('Durable continuation/session/tree proof mismatch.');
  if (policy.verified !== true || policy.conversationKey !== ctx.thread || policy.taskId !== id || policy.sessionId !== ctx.sessionId || policy.agentId !== ctx.sessionId || policy.agentRole !== 'main' || policy.sandboxMode !== 'read-only' || policy.approvalPolicy !== 'ask' || canonicalWorkspace(policy.workspace) !== canonicalWorkspace(ctx.workspace)) fail('Actual resumed main-session policy proof mismatch.');
  const deniedNew = await caller.call(other, 'dsh_status', { task_id: id }, ctx.otherThread);
  if (deniedNew.isError !== true || JSON.stringify(deniedNew).includes(ctx.expectedToken) || JSON.stringify(deniedNew).includes(ctx.sessionId)) fail('Scripted continuation owner isolation failed.');
  return { passed: true, taskId: id, sessionId: task.session_id, cursor, hasMore: false, reports, scriptedOwnerIsolation: true, actualCodexMultiChatVerified: false, treeExited: true };
}
function parseOptions(argv) {
  const result = {}; const flags = { '--source-evidence': 'sourceEvidence', '--release-root': 'releaseRoot', '--evidence-dir': 'evidenceDir' };
  for (let i = 0; i < argv.length; i++) { if (argv[i] === '--authorize-model-cost') continue; const key = flags[argv[i]]; if (!key || !argv[i + 1] || argv[i + 1].startsWith('--') || result[key]) fail('Usage: npm run smoke:resume -- --authorize-model-cost --source-evidence <absolute old run> --release-root <absolute candidate> --evidence-dir <absolute new run>'); result[key] = argv[++i]; }
  for (const key of Object.values(flags)) if (!result[key]) fail('Missing explicit continuation path: ' + key);
  return result;
}
function outputDirectory(value, ctx) {
  if (!path.isAbsolute(value)) fail('An absolute output directory is required.');
  let parent = path.resolve(value), tail = [];
  while (!fs.existsSync(parent)) { tail.unshift(path.basename(parent)); parent = path.dirname(parent); }
  const physical = path.join(fs.realpathSync.native(parent), ...tail);
  for (const protectedRoot of [ctx.sourceEvidence, ctx.scratch, ctx.release.root]) if (overlaps(physical, protectedRoot)) fail('New evidence cannot overlap frozen evidence, original state or immutable candidate.');
  fs.mkdirSync(physical, { recursive: true }); return absoluteDirectory(physical);
}
function configuredRuntime(ctx) {
  const env = { ...process.env, DSH_HOME: ctx.home }; delete env.CODEX_DSH_MCP_ALLOW_PROVISION; delete env.CODEX_DSH_MCP_CONVERSATION; delete env.CODEX_DSH_MCP_MULTIPLEX; delete env.NODE_OPTIONS; delete env.NODE_PATH;
  const source = json(path.join(ctx.sourceEvidence, 'diagnose.after-bootstrap.json'));
  if (!source.launcher?.installRoot || source.home !== ctx.home) fail('Original DSH installation/home are ambiguous.');
  env.CODEX_DSH_MCP_DSH = source.launcher.installRoot;
  const runtime = resolveRuntime(env);
  if (runtime.version !== '0.2.0-rc.2' || !samePath(runtime.home, ctx.home)) fail('DSH installation/home drift; no model was called.');
  const protectedFiles = json(path.join(ctx.sourceEvidence, 'protected-files.before.json'));
  for (const target of [runtime.launcher.archive, path.join(runtime.home, '.credentials.yaml')]) {
    const saved = protectedFiles.find(row => samePath(row.path, target));
    if (!saved || saved.length <= 0 || fs.statSync(target).size !== saved.length || hash(target) !== saved.sha256) fail('Default model credentials/installation are missing or changed; review before spending credits.');
  }
  if (!ctx.priorDefaultModel?.provider || !ctx.priorDefaultModel?.model) fail('Original default model configuration was not recorded.');
  const homePatch = path.join(runtime.home, 'cordis.patch.yml');
  if (fs.existsSync(homePatch) && /default(?:Model|Provider)|model-provider/i.test(fs.readFileSync(homePatch, 'utf8'))) fail('Home-level model configuration needs explicit review; no provider/model was selected.');
  return runtime;
}
async function candidateCheck(ctx, runtime, args, evidenceDir, label) {
  let stdout = '', stderr = ''; const controller = new AbortController(), timer = setTimeout(() => controller.abort({ kind: 'timeout', message: 'Candidate preflight timed out' }), 30000);
  try {
    const result = await supervise({ command: ctx.release.runtime, args, cwd: ctx.workspace, stateDir: evidenceDir, env: runtime.env, signal: controller.signal, onStdout: b => stdout += b.toString('utf8'), onStderr: b => stderr += b.toString('utf8') });
    fs.writeFileSync(path.join(evidenceDir, label + '.stdout.log'), stdout); fs.writeFileSync(path.join(evidenceDir, label + '.stderr.log'), stderr);
    if (result.code !== 0 || result.treeExited !== true || controller.signal.aborted) fail('Candidate preflight failed: ' + label);
    return JSON.parse(stdout.trim());
  } finally { clearTimeout(timer); }
}
export async function finalExit(ctx, { attempted = false, timeoutMs = 10000, now = Date.now, alive = processAlive } = {}) {
  const until = now() + timeoutMs;
  try {
    while (true) {
      const index = json(path.join(ctx.ownerDir, 'tasks.json'));
      const ids = index.order.filter(id => !ctx.originalTaskIds.includes(id));
      const records = ids.map(id => json(path.join(taskPaths(ctx.thread, id, ctx.stateRoot).dir, 'task.json')));
      // An empty index after an ambiguous paid RPC is NOT proof that no tree exists.
      const expectedCount = attempted ? ids.length === 1 : ids.length === 0;
      const confirmed = expectedCount && records.every(row => row.prompt === FOLLOW_PROMPT && TERMINAL.has(row.state) && row.state !== 'interrupted' && row.phase === 'settled' && row.treeExited === true && ['processPid', 'guardianPid', 'workerPid', 'executorPid'].every(key => row[key] == null || Number.isSafeInteger(row[key]) && row[key] > 0 && alive(row[key]) === false));
      if (confirmed) return { confirmed: true, tasks: records.map(row => ({ taskId: row.taskId, state: row.state, treeExited: row.treeExited, pids: [row.processPid, row.guardianPid, row.workerPid, row.executorPid].filter(Boolean) })) };
      if (now() >= until) return { confirmed: false, taskIds: ids, retained: true, reason: attempted && ids.length === 0 ? 'Submission outcome unknown; no durable task proof.' : 'Owned task/PID exit not verified.' };
      await delay(100);
    }
  } catch (error) {
    return { confirmed: false, retained: true, reason: 'Exit evidence cannot be verified.', error: { code: error.code, message: error.message } };
  }
}
export async function main(argv = process.argv.slice(2)) {
  if (!argv.includes('--authorize-model-cost')) { console.error('Refused: a NEW one-task model-cost authorization is required. Previous two attempts are exhausted. No bridge or DSH task was started.'); return 2; }
  const options = parseOptions(argv), ctx = preflightResume(options), runtime = configuredRuntime(ctx), evidenceDir = outputDirectory(options.evidenceDir, ctx), bridges = [];
  syncJsonNew(path.join(evidenceDir, 'resume-run.json'), { startedAt: new Date().toISOString(), sourceEvidence: ctx.sourceEvidence, candidate: ctx.release.root, candidateManifestSha256: ctx.release.manifestSha256, maximumTopLevelTaskAttempts: 1, newAuthorizationRequired: true, actualCodexMultiChatVerified: false });
  const caller = createAuditedCaller(evidenceDir); let outcome = null, error = null, exit = null;
  try {
    const guardian = await candidateCheck(ctx, runtime, [path.join(ctx.release.root, 'scripts', 'check-guardian.js')], evidenceDir, 'candidate-guardian');
    if (guardian.stateWritable !== true || guardian.treeExited !== true) fail('Candidate guardian did not pass.');
    const diagnosis = await candidateCheck(ctx, runtime, [ctx.release.bridge, '--diagnose'], evidenceDir, 'candidate-diagnose');
    if (diagnosis.ready !== true || diagnosis.dshBaselineSupported !== true || !samePath(diagnosis.home, ctx.home)) fail('New candidate profile is not ready; obtain separate bootstrap authorization.', 'PROFILE_NOT_READY');
    for (let i = 0; i < 2; i++) {
      const transport = new StdioClientTransport({ command: ctx.release.runtime, args: [ctx.release.bridge], cwd: ctx.workspace, env: { ...runtime.env, CODEX_DSH_MCP_STATE: ctx.stateRoot }, stderr: 'pipe' });
      const client = new Client({ name: 'authorized-one-task-resume-smoke', version: '0.1.1' }, { capabilities: {} });
      const bridge = { client, transport, stderr: '' }; bridges.push(bridge); transport.stderr?.on('data', b => bridge.stderr = (bridge.stderr + b.toString('utf8')).slice(-32768)); await client.connect(transport);
    }
    outcome = await resumeWithClients(ctx, bridges[0], bridges[1], caller);
  } catch (caught) { error = { code: caught.code, message: caught.message }; }
  finally {
    for (const [i, bridge] of bridges.entries()) { await bridge.client.close().catch(() => {}); await bridge.transport.close().catch(() => {}); fs.writeFileSync(path.join(evidenceDir, 'bridge-' + i + '.stderr.log'), bridge.stderr); }
    exit = await finalExit(ctx, { attempted: caller.stats().actualTopLevelTaskAttempts > 0 });
    const summary = { ...caller.stats(), passed: !!outcome && !error && exit.confirmed, outcome, error, exit, sourceEvidence: ctx.sourceEvidence, candidate: ctx.release.root, candidateManifestSha256: ctx.release.manifestSha256, expectedSessionId: ctx.sessionId, monetaryHardCapClaimed: false, modelRequestCount: null, billedAmount: null, actualCodexMultiChatVerified: false, finishedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(evidenceDir, 'resume-summary.json'), JSON.stringify(summary, null, 2) + '\n');
    console.log(JSON.stringify({ passed: summary.passed, actualTopLevelTaskAttempts: summary.actualTopLevelTaskAttempts, treeExitConfirmed: exit.confirmed, evidenceDir }, null, 2));
  }
  return outcome && !error && exit.confirmed ? 0 : 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(); } catch (error) { console.error((error.code ? error.code + ': ' : '') + error.message); process.exitCode = 1; }
}
