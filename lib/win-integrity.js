/**
 * Windows integrity-label support for the DSH-side guardian.
 *
 * DSH's Windows sandbox grants write access to an authorized root by adding a
 * capability-SID allow ACE, an environmental deny on parent deletion, and a
 * **Low mandatory label** (S-1-16-4096) that the lowered sandbox token must
 * match. The label is inheritable, so every object created under such a root
 * carries it, and Windows starts a process created from a Low-labeled image at
 * Low integrity. A Low-integrity guardian can never write an ordinary (Medium)
 * task-state directory, which is exactly the GUARDIAN_STATE_NOT_WRITABLE
 * refusal.
 *
 * The guardian executable therefore has to be *placed* without inheriting that
 * label. Copying it into the labeled tree cannot work — a new file inherits its
 * parent directory's label — so this module places the artifact by hard link
 * from a same-volume stage directory outside the labeled scope. A hard link is
 * the same file object, so there is no inheritance to reason about, and the
 * resulting artifact is also no longer writable by a Low-integrity sandbox
 * process.
 *
 * Nothing here changes a label, an owner or any other security metadata; it only
 * reads labels, it never runs elevated, and it never calls a model.
 * @module dsh-mcp/win-integrity
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

/** Error code reported when the stage directory cannot be used. */
export const STAGE_UNUSABLE = 'GUARDIAN_BUILD_STAGE_UNUSABLE';
/** Error code reported when the guardian image itself carries a Low label. */
export const IMAGE_LOW = 'GUARDIAN_IMAGE_LOW_INTEGRITY';
/** Error code reported when placement or verification could not be proven. */
export const LABEL_UNVERIFIED = 'GUARDIAN_LABEL_UNVERIFIED';
/** Error code reported when the no-model probe cannot reach a verdict. */
export const PROBE_INCONCLUSIVE = 'GUARDIAN_PROBE_INCONCLUSIVE';

/** Integrity level names and their SIDs, as `icacls` renders them. */
const LABEL_LEVELS = Object.freeze([
  ['Low Mandatory Level', 'low'], ['S-1-16-4096', 'low'],
  ['Medium Mandatory Level', 'medium'], ['S-1-16-8192', 'medium'],
  ['High Mandatory Level', 'high'], ['S-1-16-12288', 'high'],
  ['System Mandatory Level', 'system'], ['S-1-16-16384', 'system'],
]);

/**
 * Build an error carrying a stable guardian code.
 * @param {string} code - stable error code.
 * @param {string} message - operator-facing explanation.
 * @returns {Error} the coded error.
 */
export function guardianError(code, message) {
  return Object.assign(new Error(message), { code });
}

/**
 * Absolute path of the system `icacls`, or null off Windows.
 * @returns {string|null} command path.
 */
function icaclsPath() {
  if (process.platform !== 'win32') return null;
  return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe');
}

/**
 * Parse a mandatory label out of `icacls` output text.
 *
 * Matching the level name and the raw SID keeps the reading usable when the
 * console language changes; an object with no label at all is `unlabeled`,
 * which is the desired state for the guardian image.
 * @param {string} text - combined stdout and stderr of one `icacls` invocation.
 * @returns {{level: 'low'|'medium'|'high'|'system'|'unlabeled'|'unknown', raw: string, detail: string|null}} verdict.
 */
export function parseIntegrityLabel(text) {
  const line = String(text ?? '').split(/\r?\n/).find(value => /mandatory label/i.test(value)) ?? '';
  if (line === '') return { level: 'unlabeled', raw: '', detail: 'No mandatory label ACE is present.' };
  for (const [needle, level] of LABEL_LEVELS) if (line.includes(needle)) return { level, raw: line.trim(), detail: null };
  return { level: 'unknown', raw: line.trim(), detail: 'Unrecognized mandatory label line; the behavioral probe decides instead.' };
}

/**
 * Read one object's mandatory integrity label.
 *
 * An object with no mandatory-label ACE is reported as `unlabeled`: that is the
 * desired state for the guardian image, because Windows then starts a process
 * from it at its token's own integrity level.
 * @param {string} target - file or directory to read.
 * @returns {{level: 'low'|'medium'|'high'|'system'|'unlabeled'|'unknown', raw: string, detail: string|null}} verdict.
 */
export function readIntegrityLabel(target) {
  const command = icaclsPath();
  if (command === null) return { level: 'unknown', raw: '', detail: 'Mandatory integrity labels are a Windows concept.' };
  const resolved = path.resolve(target);
  if (!fs.existsSync(resolved)) return { level: 'unknown', raw: '', detail: 'The path does not exist: ' + resolved };
  let result;
  // `icacls` accepts only a few switches: `/nologo` and `/q` are rejected as an
  // invalid parameter, which would silently look like "no label" here.
  try { result = spawnSync(command, [resolved], { encoding: 'utf8', windowsHide: true, timeout: 30000 }); }
  catch (error) { return { level: 'unknown', raw: '', detail: error.message }; }
  if (result.error) return { level: 'unknown', raw: '', detail: result.error.message };
  const text = String(result.stdout ?? '') + String(result.stderr ?? '');
  const verdict = parseIntegrityLabel(text);
  if (verdict.level === 'unlabeled' && result.status !== 0) return { level: 'unknown', raw: '', detail: 'icacls exited with ' + result.status + ': ' + text.trim().slice(0, 200) };
  return verdict;
}

/**
 * Whether a verdict proves the object is Low-labeled.
 * @param {{level: string}} label - verdict from {@link readIntegrityLabel}.
 * @returns {boolean} true when the object carries the Low label.
 */
export function isLowLabeled(label) {
  return label?.level === 'low';
}

/**
 * Read the integrity level of the calling process's own token.
 *
 * A Low-integrity bridge or guardian cannot write ordinary task state no matter
 * how its image is labeled, so this is reported separately from the image label.
 * @returns {{level: 'low'|'medium'|'high'|'system'|'unlabeled'|'unknown', raw: string, detail: string|null}} verdict.
 */
export function readTokenIntegrity() {
  if (process.platform !== 'win32') return { level: 'unknown', raw: '', detail: 'Mandatory integrity labels are a Windows concept.' };
  const command = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe');
  let result;
  try { result = spawnSync(command, ['/groups'], { encoding: 'utf8', windowsHide: true, timeout: 30000 }); }
  catch (error) { return { level: 'unknown', raw: '', detail: error.message }; }
  if (result.error) return { level: 'unknown', raw: '', detail: result.error.message };
  const text = String(result.stdout ?? '') + String(result.stderr ?? '');
  const line = text.split(/\r?\n/).find(value => /mandatory label/i.test(value)) ?? '';
  if (line === '') return { level: 'unknown', raw: '', detail: 'The token groups did not report a mandatory label.' };
  for (const [needle, level] of LABEL_LEVELS) if (line.includes(needle)) return { level, raw: line.trim(), detail: null };
  return { level: 'unknown', raw: line.trim(), detail: 'Unrecognized mandatory label line.' };
}

/**
 * Decide whether a guardian image must be refused before anything is launched.
 *
 * Extracted so the decision is unit-testable without forging a Windows
 * mandatory label: a Low-labeled image is started at Low integrity by Windows,
 * so it can never write an ordinary task-state directory.
 * @param {{level: string}} imageLabel - verdict from {@link readIntegrityLabel}.
 * @param {string} helperPath - guardian executable being checked.
 * @param {string} stateDir - task-state directory the guardian would have to write.
 * @returns {Error|null} refusal error with code {@link IMAGE_LOW}, or null when acceptable.
 */
export function guardianRefusal(imageLabel, helperPath, stateDir) {
  if (!isLowLabeled(imageLabel)) return null;
  return guardianError(IMAGE_LOW, 'The Windows guardian at ' + helperPath + ' carries a Low mandatory label (' + (imageLabel.raw || 'Low Mandatory Level') + '), so Windows starts it at Low integrity and it cannot write ' + stateDir + '. Rebuild it with "npm run build:native" from an unconfined session; do not remove the workspace label or elevate.');
}

/**
 * Create and validate a same-volume stage directory outside the labeled scope.
 *
 * A stage on another volume cannot be hard-linked into place, and a copy would
 * silently re-inherit the workspace label, so a different volume is refused
 * rather than degraded.
 * @param {string} stageDir - requested stage directory.
 * @param {string} destFile - final artifact path the stage must share a volume with.
 * @returns {string} the resolved stage directory.
 * @throws {Error} with code {@link STAGE_UNUSABLE}.
 */
export function ensureStageDir(stageDir, destFile) {
  if (process.platform !== 'win32') throw guardianError(STAGE_UNUSABLE, 'The Windows guardian stage is only meaningful on Windows.');
  const stage = path.resolve(stageDir), dest = path.resolve(destFile);
  if (path.parse(stage).root.toLowerCase() !== path.parse(dest).root.toLowerCase()) {
    throw guardianError(STAGE_UNUSABLE, 'The guardian stage must share a volume with ' + dest + ' so the artifact can be linked rather than copied; a copy would re-inherit the workspace integrity label.');
  }
  try { fs.mkdirSync(stage, { recursive: true }); }
  catch (error) { throw guardianError(STAGE_UNUSABLE, 'The guardian stage directory could not be created: ' + stage + ' (' + error.code + '). Run this build from an unconfined session; a Low-integrity sandboxed build cannot produce a non-Low artifact.'); }
  const probe = path.join(stage, 'stage-write-probe-' + crypto.randomUUID());
  try { fs.writeFileSync(probe, 'stage write probe', 'utf8'); }
  catch (error) { throw guardianError(STAGE_UNUSABLE, 'The guardian stage directory is not writable with the current token: ' + stage + ' (' + error.code + '). Run this build from an unconfined (Medium-integrity) session.'); }
  finally { try { fs.unlinkSync(probe); } catch { /* the probe is best-effort cleanup */ } }
  return stage;
}

/**
 * Place a staged artifact at its destination by hard link, never by copy.
 *
 * The previous artifact is preserved beside the stage file so the operator can
 * restore it, and every failure path restores the destination instead of
 * leaving a Low-labeled or missing guardian behind.
 * @param {object} options - placement options.
 * @param {string} options.stageFile - verified artifact inside the stage directory.
 * @param {string} options.destFile - final artifact path.
 * @returns {{dest: string, stage: string, previous: string|null, label: object}} placement result.
 * @throws {Error} with code {@link STAGE_UNUSABLE}, {@link IMAGE_LOW} or {@link LABEL_UNVERIFIED}.
 */
export function placeWithoutLowLabel({ stageFile, destFile }) {
  const stage = path.resolve(stageFile), dest = path.resolve(destFile);
  if (path.parse(stage).root.toLowerCase() !== path.parse(dest).root.toLowerCase()) {
    throw guardianError(STAGE_UNUSABLE, 'The staged guardian must share a volume with ' + dest + '; it cannot be linked across volumes and must not be copied.');
  }
  if (!fs.existsSync(stage) || fs.lstatSync(stage).isSymbolicLink()) throw guardianError(LABEL_UNVERIFIED, 'The staged guardian is missing or is a link: ' + stage);
  const previous = path.join(path.dirname(stage), 'previous-' + path.basename(dest));
  const restore = () => {
    try { if (fs.existsSync(dest)) fs.unlinkSync(dest); } catch { /* the destination may already be gone */ }
    try { if (fs.existsSync(previous)) fs.linkSync(previous, dest); } catch { /* the backup stays for manual recovery */ }
  };
  try {
    if (fs.existsSync(previous)) fs.unlinkSync(previous);
    if (fs.existsSync(dest)) fs.renameSync(dest, previous);
    fs.linkSync(stage, dest);
  } catch (error) {
    restore();
    throw guardianError(LABEL_UNVERIFIED, 'The guardian could not be placed without inheriting the workspace integrity label: ' + error.message);
  }
  const label = readIntegrityLabel(dest);
  if (isLowLabeled(label)) {
    restore();
    throw guardianError(IMAGE_LOW, 'The placed guardian still carries a Low mandatory label; it would run at Low integrity and could not write ordinary task state. Nothing was replaced.');
  }
  return { dest, stage, previous: fs.existsSync(previous) ? previous : null, label };
}

/**
 * Turn the guardian's IPC events into a probe verdict.
 *
 * Extracted from the transport so the decision is unit-testable with synthetic
 * events: a refusal the guardian itself reported keeps its own code, while a
 * missing start, an unsettled tree or a missing marker file is never a pass.
 * @param {object} input - verdict inputs.
 * @param {object[]} [input.events] - decoded guardian IPC events.
 * @param {boolean} [input.wrote] - whether the probe child wrote its marker.
 * @param {string} [input.stderr] - captured guardian stderr.
 * @param {boolean} [input.timedOut] - whether the probe timed out.
 * @param {string|null} [input.probeDir] - probe directory used.
 * @param {object|null} [input.label] - integrity label of the probe directory.
 * @returns {{ok: boolean, code: string|null, detail: string|null, events: object[], probeDir: string|null, label: object|null}} verdict.
 */
export function verdictFromGuardianEvents({ events = [], wrote = false, stderr = '', timedOut = false, probeDir = null, label = null } = {}) {
  if (timedOut) return { ok: false, code: LABEL_UNVERIFIED, detail: 'The guardian probe timed out.', events, probeDir, label };
  const failure = events.find(event => event.type === 'error');
  if (failure) return { ok: false, code: failure.code ?? LABEL_UNVERIFIED, detail: failure.message ?? 'The guardian refused the probe.', events, probeDir, label };
  if(events[0]?.type!=='hello'||events[0].protocol!==2||events[0].stdin!==true)return {ok:false,code:'GUARDIAN_PROTOCOL_MISMATCH',detail:'The guardian did not negotiate duplex protocol 2.',events,probeDir,label};
  const started = events.some(event => event.type === 'started'&&event.protocol===2);
  const settled = events.some(event => event.type === 'exit' && event.treeExited === true);
  if (!started || !settled || !wrote) return { ok: false, code: LABEL_UNVERIFIED, detail: 'The guardian did not start, write and settle a real child tree (started=' + started + ', settled=' + settled + ', wrote=' + wrote + (stderr ? ', stderr=' + stderr.slice(0, 512) : '') + ').', events, probeDir, label };
  return { ok: true, code: null, detail: null, events, probeDir, label };
}

/**
 * Run the guardian's own state-write preflight without any model call.
 *
 * This is the authoritative verdict: the guardian is started exactly as a real
 * task starts it, asked to write its preflight file into `probeDir`, and must
 * launch, write and settle a real child tree. A Low-labeled image, or a
 * Low-integrity token, fails here the same way a real task would. The helper's
 * stdin is held open until the tree settles, because closing it early is a
 * cancellation, not a completion.
 * @param {string} helperPath - guardian executable to probe.
 * @param {object} [options] - probe options.
 * @param {string} [options.probeDir] - directory the guardian must be able to write; defaults to a fresh directory under the system temp root.
 * @param {number} [options.timeoutMs] - probe timeout.
 * @param {string} [options.nodePath] - interpreter asked to write the marker.
 * @returns {Promise<{ok: boolean, code: string|null, detail: string|null, events: object[], probeDir: string|null, label: object}>} probe verdict.
 */
export function probeGuardianWrite(helperPath, options = {}) {
  if (process.platform !== 'win32') return Promise.resolve({ ok: false, code: PROBE_INCONCLUSIVE, detail: 'The guardian probe is a Windows-only check.', events: [], probeDir: null, label: { level: 'unknown', raw: '', detail: null } });
  const owned = options.probeDir === undefined;
  let probeDir;
  try { probeDir = path.resolve(options.probeDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mcp-guardian-probe-'))); }
  catch (error) { return Promise.resolve({ ok: false, code: PROBE_INCONCLUSIVE, detail: 'No probe directory could be created: ' + error.message, events: [], probeDir: null, label: { level: 'unknown', raw: '', detail: null } }); }
  if (owned) fs.mkdirSync(probeDir, { recursive: true });
  const label = readIntegrityLabel(probeDir);
  const cleanup = () => { if (!owned) return; try { fs.rmSync(probeDir, { recursive: true, force: true }); } catch { /* keep the evidence rather than failing the probe */ } };
  // A probe directory that is itself Low-labeled can never distinguish a Low
  // guardian from a Medium one, so refuse to guess.
  if (isLowLabeled(label)) { const verdict = { ok: false, code: PROBE_INCONCLUSIVE, detail: 'The probe directory carries a Low mandatory label, so the result could not distinguish a Low guardian from a Medium one. Run this check from an unconfined session.', events: [], probeDir, label }; cleanup(); return Promise.resolve(verdict); }

  const marker = path.join(probeDir, 'guardian-probe-marker.txt');
  const request = { protocol:2, duplex:false, command: options.nodePath ?? process.execPath, args: ['-e', 'require("node:fs").writeFileSync(' + JSON.stringify(marker) + ',"guardian-probe-ok")'], cwd: probeDir,
    env: { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows', PATH: process.env.PATH ?? '', TEMP: probeDir, TMP: probeDir, USERPROFILE: process.env.USERPROFILE ?? '' }, stateDir: probeDir };

  return new Promise(resolve => {
    let child;
    try { child = spawn(helperPath, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); }
    catch (error) { const verdict = { ok: false, code: LABEL_UNVERIFIED, detail: 'The guardian could not be started: ' + error.message, events: [], probeDir, label }; cleanup(); resolve(verdict); return; }
    let buffer = '', stderr = '', events = [], settled = false, launchSent=false;
    const wrote = () => { try { return fs.readFileSync(marker, 'utf8') === 'guardian-probe-ok'; } catch { return false; } };
    const finish = () => { if (settled) return; settled = true; clearTimeout(timer); try { child.stdin.end(); } catch { /* already closed */ } try { child.kill(); } catch { /* already gone */ } const verdict = verdictFromGuardianEvents({ events, wrote: wrote(), stderr, probeDir, label }); cleanup(); resolve(verdict); };
    const timer = setTimeout(() => { if (settled) return; settled = true; clearTimeout(timer); try { child.stdin.end(); } catch { /* already closed */ } try { child.kill(); } catch { /* already gone */ } cleanup(); resolve(verdictFromGuardianEvents({ events, timedOut: true, probeDir, label })); }, options.timeoutMs ?? 60000);
    child.on('error', error => { if (settled) return; settled = true; clearTimeout(timer); try { child.kill(); } catch { /* already gone */ } const verdict = { ok: false, code: LABEL_UNVERIFIED, detail: 'The guardian could not be started: ' + error.message, events, probeDir, label }; cleanup(); resolve(verdict); });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 1024 * 1024) { events.push({ type: 'error', code: LABEL_UNVERIFIED, message: 'The guardian emitted more than 1 MiB of IPC before settling.' }); finish(); return; }
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (line.trim() === '') continue;
        try {
          const event=JSON.parse(line);events.push(event);
          if(event.type==='hello'&&!launchSent&&event.protocol===2&&event.stdin===true) {
            launchSent=true;child.stdin.write(JSON.stringify(request)+'\n');
          } else if(!launchSent||event.type==='hello')throw new Error('Unexpected guardian handshake.');
        }catch(error){events.push({type:'error',code:'GUARDIAN_PROTOCOL_MISMATCH',message:'Guardian protocol 2 required: '+error.message});}
      }
      if (events.some(event => event.type === 'exit' || event.type === 'error')) finish();
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2048); });
    child.on('close', () => finish());
    child.stdin.on('error', () => { /* the guardian may close stdin while it settles */ });
    // Never send launch data to an older helper that has not negotiated protocol 2.
  });
}

/**
 * Verify one guardian artifact: label read plus the behavioral probe.
 * @param {string} helperPath - guardian executable.
 * @param {object} [options] - passed through to {@link probeGuardianWrite}.
 * @returns {Promise<{ok: boolean, helper: string, image: object, probe: object}>} verification verdict.
 */
export async function verifyGuardianArtifact(helperPath, options = {}) {
  const helper = path.resolve(helperPath);
  if (!fs.existsSync(helper)) return { ok: false, helper, image: { level: 'unknown', raw: '', detail: 'The guardian executable is missing.' }, probe: { ok: false, code: 'GUARDIAN_MISSING', detail: 'The guardian executable is missing.', events: [], probeDir: null, label: { level: 'unknown', raw: '', detail: null } } };
  const image = readIntegrityLabel(helper);
  const probe = await probeGuardianWrite(helper, options);
  return { ok: !isLowLabeled(image) && probe.ok, helper, image, probe };
}
