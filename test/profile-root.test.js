import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { resolveRuntime, profileTarget, ensureBridgeProfile, inspectBridgeProfile, BRIDGE_PLUGIN_NAME } from '../lib/dsh-profile.js';
import { acquireFileLock } from '../lib/file-lock.js';
import { runTask } from '../lib/task-runner.js';
import { tempDir, isolatedEnv } from './helpers.js';
const ROOT = "# dsh profile root — an empty entry list. The tree is composed as patches:\n"
  + "# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any\n"
  + "# --patch overlays. Edit cordis.patch.yml, not this file.\n[]\n";
function fixture(t) {
  const temp = tempDir('profile-root'); t.after(temp.cleanup);
  const cli = path.join(temp.dir, 'cli.js'); fs.writeFileSync(cli, '// fixture');
  const env = isolatedEnv(temp.dir, { DSH_HOME: path.join(temp.dir, 'home'), DSH_MCP_DSH: cli });
  const runtime = resolveRuntime(env); runtime.version = '0.2.0-rc.2';
  let installs = 0;
  const opts = { env, runtime, allowProvision: true, runDshImpl: async () => {
    installs++; const target = profileTarget({ env, runtime });
    fs.cpSync(path.join(target.dir, 'vendor', BRIDGE_PLUGIN_NAME), path.join(target.dir, 'node_modules', BRIDGE_PLUGIN_NAME), { recursive: true });
    return { code: 0 };
  } };
  return { ...temp, env, runtime, opts, installs: () => installs };
}
async function ready(t) { const f = fixture(t); return { ...f, profile: await ensureBridgeProfile(f.opts) }; }
async function rejectsWithoutInstall(f, expectedMessage) {
  const count = f.installs();
  for (const allowProvision of [false, true]) {
    await assert.rejects(ensureBridgeProfile({ ...f.opts, allowProvision }), error => {
      assert.equal(error.code, 'PROFILE_INTEGRITY_FAILED');
      if (expectedMessage) assert.match(error.message, expectedMessage);
      assert.ok(!error.message.includes('fixture-secret-value')); return true;
    });
  }
  assert.equal(f.installs(), count);
}
test('canonical DSH root bytes and profile-v2 fingerprint are stable over repeated preparation', async t => {
  const f = await ready(t), root = path.join(f.profile.dir, 'cordis.yml');
  assert.equal(Buffer.byteLength(ROOT), 223); assert.equal(fs.readFileSync(root, 'utf8'), ROOT);
  const marker = JSON.parse(fs.readFileSync(path.join(f.profile.dir, '.bridge-profile.json'))); assert.equal(marker.version, 2);
  for (let i = 0; i < 2; i++) { fs.writeFileSync(root, ROOT); assert.equal(inspectBridgeProfile(f.opts).ready, true); assert.equal((await ensureBridgeProfile({ ...f.opts, allowProvision: false })).changed, false); }
  assert.equal(f.installs(), 1);
  const names = ['package.json', 'cordis.yml', 'cordis.patch.yml', 'pnpm-workspace.yaml'];
  const oldConfigs = Object.fromEntries(names.map(n => [n, n === 'cordis.yml' ? '[]\n' : fs.readFileSync(path.join(f.profile.dir, n), 'utf8')]));
  const old = crypto.createHash('sha256').update('profile-v2\0' + f.runtime.launcherFingerprint + '\0' + f.profile.pluginFingerprint + '\0' + JSON.stringify(oldConfigs)).digest('hex');
  assert.notEqual(old, f.profile.fingerprint);
  const legacy = path.join(f.runtime.home, 'profiles', 'dsh-mcp-bridge-' + old.slice(0, 24)); fs.mkdirSync(legacy); fs.writeFileSync(path.join(legacy, 'cordis.yml'), ROOT);
  await ensureBridgeProfile(f.opts); assert.equal(fs.readFileSync(path.join(legacy, 'cordis.yml'), 'utf8'), ROOT);
});
test('legacy short root and YAML-equivalent or actual edits are rejected without rewriting', async t => {
  const f = await ready(t), root = path.join(f.profile.dir, 'cordis.yml');
  for (const value of ['[]\n', ROOT.replace('empty entry', 'empty  entry'), ROOT.replaceAll('\n', '\r\n'), ROOT + '# fixture-secret-value\n', '- name: unexpected\n', '---\n[]\n---\n[]\n']) {
    fs.writeFileSync(root, value); assert.equal(inspectBridgeProfile(f.opts).ready, false);
    await rejectsWithoutInstall(f, /cordis\.yml/); assert.equal(fs.readFileSync(root, 'utf8'), value);
  }
});
test('ready snapshots with missing root fail integrity even when provisioning is authorized', async t => {
  const f = await ready(t), root = path.join(f.profile.dir, 'cordis.yml'); fs.unlinkSync(root);
  await rejectsWithoutInstall(f, /cordis\.yml/); assert.equal(fs.existsSync(root), false);
});
test('all other managed config and vendor/installed copy edits remain fail closed', async t => {
  const f = await ready(t);
  for (const rel of ['package.json', 'cordis.patch.yml', 'pnpm-workspace.yaml', 'vendor/' + BRIDGE_PLUGIN_NAME + '/index.js', 'node_modules/' + BRIDGE_PLUGIN_NAME + '/index.js']) {
    const file = path.join(f.profile.dir, rel), original = fs.readFileSync(file); fs.writeFileSync(file, 'fixture-secret-value');
    await rejectsWithoutInstall(f); assert.equal(fs.readFileSync(file, 'utf8'), 'fixture-secret-value'); fs.writeFileSync(file, original);
  }
});
test('unmanaged, malformed, wrong-format and mismatched markers are integrity errors before authorization', async t => {
  const f = await ready(t), file = path.join(f.profile.dir, '.bridge-profile.json'), original = JSON.parse(fs.readFileSync(file));
  for (const value of ['{fixture-secret-value', { ...original, managedBy: 'human' }, { ...original, version: 3 }, { ...original, fingerprint: 'wrong' }, { ...original, pluginFingerprint: 'wrong' }, { ...original, launcherFingerprint: 'wrong' }, { ...original, state: 'unknown' }]) {
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); await rejectsWithoutInstall(f, /marker/);
  }
  fs.unlinkSync(file); await rejectsWithoutInstall(f, /marker/);
});
test('missing snapshots need authorization and interrupted managed builds can explicitly continue', async t => {
  const f = fixture(t); await assert.rejects(ensureBridgeProfile({ ...f.opts, allowProvision: false }), { code: 'PROVISION_AUTHORIZATION_REQUIRED' });
  assert.equal(f.installs(), 0); assert.equal(fs.existsSync(profileTarget(f.opts).dir), false);
  await assert.rejects(ensureBridgeProfile({ ...f.opts, runDshImpl: async () => ({ code: 1, stderr: 'test interruption' }) }), { code: 'PLUGIN_INSTALL_FAILED' });
  await assert.rejects(ensureBridgeProfile({ ...f.opts, allowProvision: false }), { code: 'PROVISION_AUTHORIZATION_REQUIRED' });
  const done = await ensureBridgeProfile(f.opts); assert.equal(inspectBridgeProfile(f.opts).ready, true); assert.equal(done.changed, true); assert.equal(f.installs(), 1);
});
test('profile integrity is rechecked after waiting for the provisioning lock', async t => {
  const f = fixture(t), target = profileTarget(f.opts), lock = path.join(f.runtime.home, 'profiles', '.dsh-mcp-provision.lock');
  const release = await acquireFileLock(lock); const pending = ensureBridgeProfile(f.opts);
  fs.mkdirSync(target.dir); fs.writeFileSync(path.join(target.dir, '.bridge-profile.json'), '{"user":"human"}'); release();
  await assert.rejects(pending, { code: 'PROFILE_INTEGRITY_FAILED' }); assert.equal(f.installs(), 0);
});
test('provisioning cancellation and lock deadlines remain bounded and do not create snapshots', async t => {
  const f = fixture(t), lock = path.join(f.runtime.home, 'profiles', '.dsh-mcp-provision.lock'), release = await acquireFileLock(lock);
  try {
    const controller = new AbortController(), reason = new Error('cancelled'); controller.abort(reason);
    await assert.rejects(ensureBridgeProfile({ ...f.opts, signal: controller.signal }), error => error === reason);
    await assert.rejects(ensureBridgeProfile({ ...f.opts, deadline: Date.now() }), { code: 'LOCK_TIMEOUT' });
    assert.equal(fs.existsSync(profileTarget(f.opts).dir), false); assert.equal(f.installs(), 0);
  } finally { release(); }
});
test('integrity failure prevents task supervision and keeps session/adoption input untouched', async t => {
  const f = await ready(t); fs.writeFileSync(path.join(f.profile.dir, 'cordis.yml'), '[]\n'); let starts = 0;
  const input = { prompt: 'fixture', taskId: 't-profile-root', conversationKey: 'owner', workspace: f.dir, sandboxMode: 'read-only', sessionId: 'session-original', runtime: f.runtime, stateRoot: f.env.CODEX_DSH_MCP_STATE, superviseImpl: async () => { starts++; assert.fail('must not launch'); } };
  await assert.rejects(runTask(input), { code: 'PROFILE_INTEGRITY_FAILED' }); assert.equal(starts, 0); assert.equal(input.sessionId, 'session-original'); assert.equal(f.installs(), 1);
});
test('config permission errors are not retried and inspection preserves its public shape', async t => {
  const f = await ready(t), root = path.join(f.profile.dir, 'cordis.yml'), original = fs.readFileSync; let reads = 0;
  t.mock.method(fs, 'readFileSync', function(file, ...args) { if (file === root) { reads++; throw Object.assign(new Error('fixture-secret-value'), { code: 'EPERM' }); } return original.call(this, file, ...args); });
  const state = inspectBridgeProfile(f.opts); assert.equal(state.ready, false); assert.match(state.reason, /cordis\.yml/); assert.ok(!state.reason.includes('fixture-secret-value')); assert.equal(reads, 1); assert.equal('integrityFailed' in state, false);
});
