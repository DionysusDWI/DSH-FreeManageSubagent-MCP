/** Immutable, content-addressed DSH profiles. User profiles are never edited. */
import crypto from 'node:crypto';
import {runtimeEnv} from './config.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pluginPackageDir } from './paths.js';
import { locateDsh, launcherFingerprint, readHarnessVersion } from './dsh-locate.js';
import { readJson, writeJsonAtomic, boundUtf8 } from './io.js';
import { acquireFileLock } from './file-lock.js';
import { supervise } from './supervisor.js';
export const BRIDGE_PROFILE_NAME = 'dsh-mcp-bridge';
export const BRIDGE_PROFILE_BUNDLES = Object.freeze(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless']);
export const BRIDGE_PLUGIN_NAME = 'dsh-mcp-plugin';
export const BRIDGE_PLUGIN_ENTRY_ID = 'dsh-mcp-bridge-reporter';
export function resolveDshHome(env = process.env) {
  const explicit = env.DSH_HOME;
  if (explicit !== undefined && explicit.trim() !== '') {
    return { home: path.resolve(explicit), source: 'DSH_HOME' };
  }

  const candidates = [
    path.join(os.homedir(), '.dsh'),
    path.join(env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'dsh'),
    path.join(env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'dsh'),
  ];

  for (const candidate of candidates) {
    if (looksLikeDshHome(candidate)) return { home: candidate, source: 'existing-home' };
  }
  return { home: candidates[0], source: 'default' };
}

/**
 * Whether a directory holds the markers of a DSH home.
 * @param {string} dir - candidate directory.
 * @returns {boolean} true when it looks like a DSH home.
 */
function looksLikeDshHome(dir) {
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
  } catch {
    return false;
  }
  for (const marker of ['profiles', 'sessions', '.credentials.yaml']) {
    try {
      fs.statSync(path.join(dir, marker));
      return true;
    } catch {
      // keep probing
    }
  }
  return false;
}


export function buildProfileManifest(existing, pluginDir) {
  return { ...existing, name: existing?.name ?? 'dsh-profile-dsh-mcp-bridge', private: true, type: 'module',
    dependencies: { ...existing?.dependencies, [BRIDGE_PLUGIN_NAME]: 'file:' + pluginDir },
    dsh: { ...existing?.dsh, profile: { ...existing?.dsh?.profile, bundles: existing?.dsh?.profile?.bundles ?? [...BRIDGE_PROFILE_BUNDLES] } } };
}
export function buildProfilePatch() { return '# Managed immutable DSH MCP bridge snapshot.\n- insert:\n    - id: ' + BRIDGE_PLUGIN_ENTRY_ID + '\n      name: ' + BRIDGE_PLUGIN_NAME + '\n'; }
export function buildPnpmWorkspace() { return 'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n'; }
export function fingerprintPlugin(dir = pluginPackageDir()) {
  const files = {}, hash = crypto.createHash('sha256');
  function walk(base, prefix = '') {
    for (const name of fs.readdirSync(base).sort()) {
      if (['node_modules', '.git'].includes(name)) continue;
      const file = path.join(base, name), rel = prefix + name, stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error('Plugin snapshots cannot contain links.');
      if (stat.isDirectory()) walk(file, rel + '/');
      else { const digest = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); files[rel] = digest; hash.update(rel + '\0' + digest + '\n'); }
    }
  }
  walk(dir); return { fingerprint: hash.digest('hex'), files, dir };
}
export function resolveRuntime(env = process.env) {
  env=runtimeEnv(env);
  const launcher = locateDsh({ env }), home = resolveDshHome(env);
  return { launcher, home: home.home, homeSource: home.source, version: readHarnessVersion(launcher), launcherFingerprint: launcherFingerprint(launcher), env: { ...env, ...launcher.env, DSH_HOME: home.home } };
}
export function assertCompatibleRuntime(runtime) {
  if(runtime.version!=='0.2.0-rc.2') throw Object.assign(new Error('Unvalidated DSH version '+(runtime.version ?? 'unknown')+'. This candidate requires the tested 0.2.0-rc.2 extension APIs; it will not fall back to unverified execution.'),{code:'DSH_CAPABILITY_UNVERIFIED'});
}
// DSH 0.2.0-rc.2 prepareProfile writes these exact UTF-8/LF bytes on every boot.
// Generate the canonical root upfront; never normalize a modified snapshot.
const PROFILE_ROOT_CONFIG = "# dsh profile root — an empty entry list. The tree is composed as patches:\n"
  + "# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any\n"
  + "# --patch overlays. Edit cordis.patch.yml, not this file.\n[]\n";
function managedProfileConfigs() {return { 'package.json': JSON.stringify(buildProfileManifest(null, './vendor/' + BRIDGE_PLUGIN_NAME), null, 2) + '\n', 'cordis.yml': PROFILE_ROOT_CONFIG, 'cordis.patch.yml': buildProfilePatch(), 'pnpm-workspace.yaml': buildPnpmWorkspace() };}
export function profileTarget({ env = process.env, runtime = resolveRuntime(env), pluginDir = pluginPackageDir() } = {}) {
  const plugin = fingerprintPlugin(pluginDir);
  const fingerprint = crypto.createHash('sha256').update('profile-v2\0' + runtime.launcherFingerprint + '\0' + plugin.fingerprint + '\0' + JSON.stringify(managedProfileConfigs())).digest('hex');
  const name = BRIDGE_PROFILE_NAME + '-' + fingerprint.slice(0, 24);
  return { name, dir: path.join(runtime.home, 'profiles', name), dshHome: runtime.home, dshHomeSource: runtime.homeSource, fingerprint, pluginFingerprint: plugin.fingerprint, plugin, runtime };
}
function verifyFiles(dir, files) {
  try {
    if (!fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink()) return false;
    for (const [rel, digest] of Object.entries(files)) {
      const file = path.join(dir, ...rel.split('/')), stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== digest) return false;
    }
    return true;
  } catch { return false; }
}
// Classification is private: the public inspection result retains its shape.
function readProfileState(target) {
  let marker = null;
  const invalid = reason => ({ marker, ready: false, reason, integrityFailed: true });
  if (!fs.existsSync(target.dir)) return { marker, ready: false, reason: 'Immutable profile is missing; explicit provisioning required.', integrityFailed: false };
  try {
    const stat = fs.lstatSync(target.dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return invalid('Profile directory is not an owned regular snapshot.');
    marker = readJson(path.join(target.dir, '.bridge-profile.json'), { optional: true });
  } catch { return invalid('Profile marker cannot be verified: .bridge-profile.json.'); }
  if (!marker || marker.managedBy !== 'dsh-mcp' || marker.version !== 2
      || marker.fingerprint !== target.fingerprint || marker.pluginFingerprint !== target.pluginFingerprint
      || marker.launcherFingerprint !== target.runtime.launcherFingerprint || !['building', 'ready'].includes(marker.state)) {
    return invalid('Profile marker ownership, format or fingerprint mismatch: .bridge-profile.json.');
  }
  for (const [file, expected] of Object.entries(managedProfileConfigs())) {
    try {
      const name = path.join(target.dir, file), stat = fs.lstatSync(name);
      if (!stat.isFile() || stat.isSymbolicLink() || fs.readFileSync(name, 'utf8') !== expected) return invalid('Managed configuration content mismatch: ' + file + '.');
    } catch (error) {
      if (error.code === 'ENOENT' && marker.state === 'building') continue;
      return invalid('Managed configuration cannot be verified: ' + file + '.');
    }
  }
  const vendor = path.join(target.dir, 'vendor', BRIDGE_PLUGIN_NAME);
  if ((marker.state === 'ready' || fs.existsSync(vendor)) && !verifyFiles(vendor, target.plugin.files)) return invalid('Vendor plugin content mismatch.');
  if (marker.state === 'building') return { marker, ready: false, reason: 'Managed profile build is incomplete; explicit provisioning required.', integrityFailed: false };
  if (!verifyFiles(path.join(target.dir, 'node_modules', BRIDGE_PLUGIN_NAME), target.plugin.files)) return invalid('Installed plugin content mismatch.');
  return { marker, ready: true, reason: null, integrityFailed: false };
}
function assertProfileIntegrity(status) {
  if (status.integrityFailed) throw Object.assign(new Error(status.reason + ' Immutable content was not overwritten; use a new snapshot or explicit manual recovery.'), { code: 'PROFILE_INTEGRITY_FAILED' });
}
export function inspectBridgeProfile(options = {}) {
  const target = profileTarget(options), { marker, ready, reason } = readProfileState(target);
  return { ...target, marker, ready, reason };
}
export function isBridgeProfileReady(options = {}) { try { return inspectBridgeProfile(options).ready; } catch { return false; } }
export async function runDsh(options) {
  const runtime = options.runtime ?? resolveRuntime(options.env), controller = new AbortController();
  const abort = () => controller.abort(options.signal.reason);
  options.signal?.addEventListener('abort', abort, { once: true }); if (options.signal?.aborted) abort();
  const timer = setTimeout(() => controller.abort({ kind: 'timeout', message: 'DSH provisioning deadline exceeded' }), options.timeoutMs ?? 180000);
  let stdout = '', stderr = '', truncated = false;
  const capture = (field, chunk) => { const value = boundUtf8((field === 'stdout' ? stdout : stderr) + chunk.toString('utf8'), 65536); truncated ||= value.truncated; if(field==='stdout') stdout=value.text; else stderr=value.text; };
  try {
    const outcome = await supervise({ command: runtime.launcher.command, args: [...runtime.launcher.prefixArgs, runtime.launcher.launcherScript, ...options.args],
      env: runtime.env, cwd: options.cwd ?? runtime.home,stateDir:options.cwd ?? runtime.home, signal: controller.signal, onStdout: chunk => capture('stdout',chunk), onStderr: chunk => capture('stderr',chunk), onDiagnostic: options.onDiagnostic });
    if (controller.signal.aborted) throw Object.assign(new Error(controller.signal.reason?.message ?? 'Provisioning cancelled'), { code: 'PROVISION_CANCELLED' });
    return { code: outcome.code, stdout, stderr, truncated };
  } finally { clearTimeout(timer); options.signal?.removeEventListener('abort',abort); }
}
export async function ensureBridgeProfile(options = {}) {
  const target = profileTarget(options), note = options.onDiagnostic ?? (() => {});
  const initial = readProfileState(target);
  if (initial.ready) return { ...target, changed: false };
  assertProfileIntegrity(initial);
  if (options.allowProvision !== true) {
    throw Object.assign(new Error(initial.reason + ' Authorize provisioning with --bootstrap or setup before delegating a model task.'), { code: 'PROVISION_AUTHORIZATION_REQUIRED' });
  }
  const release = await acquireFileLock(path.join(target.runtime.home, 'profiles', '.dsh-mcp-provision.lock'), { signal: options.signal, deadline: options.deadline });
  try {
    const status = readProfileState(target);
    if (status.ready) return { ...target, changed: false };
    assertProfileIntegrity(status);
    if (options.signal?.aborted) throw options.signal.reason;
    fs.mkdirSync(target.dir, { recursive: true });
    const vendor = path.join(target.dir, 'vendor', BRIDGE_PLUGIN_NAME);
    if (!fs.existsSync(vendor)) fs.cpSync(target.plugin.dir, vendor, { recursive: true, errorOnExist: true, force: false, filter: src => !['node_modules','.git'].includes(path.basename(src)) });
    if (!verifyFiles(vendor, target.plugin.files)) throw Object.assign(new Error('Vendor plugin changed during provisioning.'), { code: 'PROFILE_INTEGRITY_FAILED' });
    const configs = managedProfileConfigs();
    for (const [file,text] of Object.entries(configs)) {
      const dest=path.join(target.dir,file); if (fs.existsSync(dest) && fs.readFileSync(dest,'utf8') !== text) throw Object.assign(new Error('Managed configuration content mismatch: ' + file + '. Refusing to overwrite it.'), { code: 'PROFILE_INTEGRITY_FAILED' });
      if (!fs.existsSync(dest)) fs.writeFileSync(dest,text,'utf8');
    }
    const marker = { managedBy:'dsh-mcp',version:2,fingerprint:target.fingerprint,pluginFingerprint:target.pluginFingerprint,launcherFingerprint:target.runtime.launcherFingerprint,state:'building' };
    writeJsonAtomic(path.join(target.dir,'.bridge-profile.json'),marker);
    note('Provisioning immutable profile ' + target.name);
    const install = options.runDshImpl ?? runDsh;
    const result = await install({ runtime: target.runtime, args:['plugin','--profile',target.name,'install'], cwd:target.dir, signal:options.signal,
      timeoutMs: Math.min(180000, Math.max(1,(options.deadline ?? Infinity)-Date.now())), onDiagnostic:note });
    if (result.code !== 0) throw Object.assign(new Error('Profile installation failed (exit ' + result.code + '): ' + result.stderr),{code:'PLUGIN_INSTALL_FAILED'});
    if (!verifyFiles(path.join(target.dir,'node_modules',BRIDGE_PLUGIN_NAME),target.plugin.files)) throw Object.assign(new Error('Installed plugin is a stale or incomplete file: copy; content verification failed.'),{code:'PLUGIN_CONTENT_MISMATCH'});
    writeJsonAtomic(path.join(target.dir,'.bridge-profile.json'),{...marker,state:'ready',createdAt:Date.now()});
    if (!inspectBridgeProfile({ ...options,runtime:target.runtime }).ready) throw new Error('Profile final integrity validation failed');
    return { ...target, changed:true };
  } finally { release(); }
}
