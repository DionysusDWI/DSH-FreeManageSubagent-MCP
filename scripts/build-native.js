/**
 * Build the Windows Job guardian so that it does NOT inherit the workspace's
 * Low integrity label.
 *
 * DSH's Windows sandbox labels every authorized root Low (S-1-16-4096) and
 * starts a process created from a Low-labeled image at Low integrity. A guardian
 * built inside this checkout therefore inherits that label and can never write
 * an ordinary (Medium) task-state directory, which is the
 * GUARDIAN_STATE_NOT_WRITABLE refusal. This script compiles into a same-volume
 * stage directory outside the labeled scope, verifies the artifact there, and
 * places it at `native/windows-job-host.exe` by hard link — never by copy, which
 * would re-inherit the label.
 *
 * Run it from an unconfined (Medium-integrity) session: a Low sandboxed build
 * cannot produce a non-Low artifact, and this script fails closed instead of
 * leaving a guardian that cannot run.
 */
import fs from 'node:fs';
import {runtimeEnv} from '../lib/config.js';
const env=runtimeEnv(process.env);
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { repoRoot } from '../lib/paths.js';
import { ensureStageDir, placeWithoutLowLabel, verifyGuardianArtifact, guardianError, IMAGE_LOW, LABEL_UNVERIFIED } from '../lib/win-integrity.js';

if (process.platform !== 'win32') { console.log('Windows helper compilation skipped on this platform.'); process.exit(0); }
const root = repoRoot(), source = path.join(root, 'native', 'windows-job-host.cs'), output = path.join(root, 'native', 'windows-job-host.exe');
const compiler = env.DSH_MCP_CSC ?? path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
if (!fs.existsSync(compiler)) throw new Error('Windows Job helper requires the .NET Framework compiler or a prebuilt release helper.');
if (!fs.existsSync(source)) throw new Error('The Windows guardian source is missing: ' + source);

const stage = ensureStageDir(process.argv[2] ?? env.DSH_MCP_BUILD_STAGE ?? path.join(path.dirname(root), '.dsh-mcp-build'), output);
const staged = path.join(stage, 'windows-job-host.exe');
// The staged path and the placed artifact are one file object after a successful
// build. Compiling into that path again would overwrite the live guardian in
// place before it is verified, so drop the stale directory entry first: the
// object stays reachable through native\\windows-job-host.exe and the compiler
// then creates a genuinely new file.
try { if (fs.existsSync(staged)) fs.unlinkSync(staged); } catch (error) { throw guardianError(LABEL_UNVERIFIED, 'A stale staged guardian could not be removed: ' + error.message); }
const compiled = spawnSync(compiler, ['/nologo', '/optimize+', '/target:exe', '/r:System.Web.Extensions.dll', '/out:' + staged, source], { encoding: 'utf8', windowsHide: true });
if (compiled.error) throw compiled.error;
if (compiled.status !== 0) throw new Error(compiled.stdout + compiled.stderr);
if (!fs.existsSync(staged)) throw guardianError(LABEL_UNVERIFIED, 'The compiler did not produce ' + staged);

const stagedVerdict = await verifyGuardianArtifact(staged);
if (!stagedVerdict.ok) throw guardianError(stagedVerdict.image.level === 'low' ? IMAGE_LOW : (stagedVerdict.probe.code ?? LABEL_UNVERIFIED),
  'The staged guardian failed verification, so nothing was placed at ' + output + '. image=' + stagedVerdict.image.level + ' probe=' + (stagedVerdict.probe.code ?? 'ok') + ' (' + (stagedVerdict.probe.detail ?? '') + ')');

const placement = placeWithoutLowLabel({ stageFile: staged, destFile: output });
const verdict = await verifyGuardianArtifact(output);
if (!verdict.ok) throw guardianError(verdict.image.level === 'low' ? IMAGE_LOW : (verdict.probe.code ?? LABEL_UNVERIFIED),
  'The placed guardian failed verification: image=' + verdict.image.level + ' probe=' + (verdict.probe.code ?? 'ok') + ' (' + (verdict.probe.detail ?? '') + ')');
console.log('Built ' + output + ' (image integrity: ' + verdict.image.level + ')');
console.log(JSON.stringify({ output, stagedFrom: staged, imageIntegrity: verdict.image.level, imageLabel: verdict.image.raw || null,
  probe: { ok: verdict.probe.ok, code: verdict.probe.code, probeDir: verdict.probe.probeDir }, previousArtifact: placement.previous, stage }, null, 2));
