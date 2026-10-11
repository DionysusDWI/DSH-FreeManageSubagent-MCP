/** Resolve one authoritative launcher. Invalid explicit overrides fail closed. */
import crypto from 'node:crypto';
import {runtimeEnv} from './config.js';
import fs from 'node:fs';
import path from 'node:path';
import { readAsarFile } from './asar.js';
export const DSH_PATH_ENV = 'DSH_MCP_DSH';
const INNER = 'dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js';
export function isFile(file) { try { return fs.statSync(file).isFile(); } catch { return false; } }
export function isDir(file) { try { return fs.statSync(file).isDirectory(); } catch { return false; } }
function fromRoot(root) {
  root = path.resolve(root);
  const archive = path.join(root, 'resources', 'app.asar');
  const command = path.join(root, process.platform === 'win32' ? 'DeepSeek Harness.exe' : 'DeepSeek Harness');
  if (!isFile(archive) || !isFile(command)) return null;
  try { readAsarFile(archive, INNER); } catch { return null; }
  return { command, prefixArgs: ['--expose-internals'], launcherScript: path.join(archive, ...INNER.split('/')), env: { ELECTRON_RUN_AS_NODE: '1' }, installRoot: root, archive, source: 'install-root' };
}
function explicit(value) {
  const resolved = path.resolve(value), normalized = resolved.replaceAll('\\','/');
  const mark = normalized.toLowerCase().indexOf('/resources/app.asar/');
  if (mark >= 0) {
    const root = normalized.slice(0, mark), inner = normalized.slice(mark + '/resources/app.asar/'.length), spec = fromRoot(root);
    if (!spec || inner !== INNER) return null; return spec;
  }
  if (isDir(resolved)) return fromRoot(resolved);
  if (!isFile(resolved)) return null;
  if (/\.exe$/i.test(resolved)) { const spec = fromRoot(path.dirname(resolved)); return spec && spec.command.toLowerCase() === resolved.toLowerCase() ? spec : null; }
  if (/\.cmd$/i.test(resolved)) {
    // Resolve a known install layout, never execute a shell shim with task text.
    let dir = path.dirname(resolved); for (let i=0; i<7; i++) { const spec = fromRoot(dir); if (spec) return spec; const next = path.dirname(dir); if (dir === next) break; dir = next; }
    const text = fs.readFileSync(resolved,'utf8'), match = /%dp0%[\\/]([^"\r\n]*cli\.js)/i.exec(text);
    if (match) { const cli = path.resolve(path.dirname(resolved), match[1].replaceAll('\\','/')); if (isFile(cli)) return { command: process.execPath, prefixArgs: [], launcherScript: cli, env: {}, installRoot: path.dirname(cli), source: 'node-shim' }; }
    return null;
  }
  if (/cli\.(?:m?js)$/i.test(resolved)) return { command: process.execPath, prefixArgs: [], launcherScript: resolved, env: {}, installRoot: path.dirname(resolved), source: 'node-script' };
  return null;
}
function roots(env) {
  if (process.platform !== 'win32') return ['/opt/DeepSeek Harness', '/usr/lib/deepseek-harness', '/Applications/DeepSeek Harness.app/Contents/Resources'];
  const dirs = [env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs'), env.LOCALAPPDATA, env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean), out = [];
  for (const dir of dirs) { let names; try { names = fs.readdirSync(dir); } catch { continue; } for (const name of names) if (/deepseek\s*harness/i.test(name)) out.push(path.join(dir,name)); }
  return out;
}
export function locateDsh({ env = process.env } = {}) {
  env=runtimeEnv(env);
  if (env[DSH_PATH_ENV] !== undefined) {
    if(typeof env[DSH_PATH_ENV]!=='string'||!env[DSH_PATH_ENV].trim())throw Object.assign(new Error('Explicit launcher override is empty or invalid; no fallback was attempted.'),{code:'INVALID_DSH_PATH'});
    const spec = explicit(env[DSH_PATH_ENV]);
    if (!spec) throw Object.assign(new Error('Explicit ' + DSH_PATH_ENV + ' does not resolve to a valid DSH launcher; no fallback was attempted.'), { code: 'INVALID_DSH_PATH' });
    return { ...spec, source: DSH_PATH_ENV };
  }
  for (const root of roots(env)) { const spec = fromRoot(root); if (spec) return spec; }
  throw Object.assign(new Error('DSH launcher not found. Install DeepSeek Harness or explicitly set ' + DSH_PATH_ENV + '.'), { code: 'DSH_NOT_FOUND' });
}
export function tryLocateDsh(options) { try { return locateDsh(options); } catch { return null; } }
export function readHarnessVersion(spec) {
  try {
    if (spec.archive) return JSON.parse(readAsarFile(spec.archive,'dsh/node_modules/@deepseek-ai/dsh-headless/package.json').toString('utf8')).version;
    const manifest = JSON.parse(fs.readFileSync(path.resolve(path.dirname(spec.launcherScript),'..','package.json'),'utf8')); return manifest.version ?? null;
  } catch { return null; }
}
export function launcherFingerprint(spec) {
  const hash = crypto.createHash('sha256'); hash.update(JSON.stringify({command:spec.command, launcher:spec.launcherScript, version:readHarnessVersion(spec)}));
  for (const file of [spec.command, spec.archive ?? spec.launcherScript]) { const stat = fs.statSync(file); hash.update(stat.size + ':' + stat.mtimeMs); }
  return hash.digest('hex');
}
