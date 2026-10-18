/**
 * Overlay generation: every value must survive a YAML round trip as a literal,
 * because a task's workspace path is the one thing the sandbox depends on.
 * @module test/overlay.test
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import yaml from 'js-yaml';

import {
  DEFAULT_SANDBOX_MODE,
  SANDBOX_MODES,
  approvalPolicyFor,
  buildOverlayPatches,
  normalizeSandboxMode,
  renderOverlay,
  serializeOverlay,
} from '../lib/overlay.js';

const BASE = {
  workspace: 'D:\\work\\a project',
  storageRoot: 'C:\\state\\s',
  sessionRoot: 'C:\\state\\sessions',
};

test('overlay always states the per-task isolation roots', () => {
  const patches = buildOverlayPatches(BASE);
  const byId = new Map(patches.map((patch) => [patch.id, patch.config]));

  assert.deepEqual(byId.get('storage-json'), { root: BASE.storageRoot });
  assert.deepEqual(byId.get('session-persistence-jsonl'), { root: BASE.sessionRoot });
  assert.deepEqual(byId.get('sandbox-policy'), { mode: DEFAULT_SANDBOX_MODE, workspaceRoot: BASE.workspace });
  assert.deepEqual(byId.get('approval'), { policy: 'ask' });
  assert.deepEqual(byId.get('agent-default-model'),{provider:'deepseek-official',model:'deepseek-flash'});
  assert.deepEqual(byId.get('sdk-jsonrpc-server'),{maxTokensAsSuccess:false});
});

test('legacy public sandbox policy never exposes direct full access', () => {
  assert.equal(approvalPolicyFor('read-only'), 'ask');
  assert.equal(approvalPolicyFor('workspace-write'), 'ask');
  assert.throws(()=>approvalPolicyFor('danger-full-access'),/Full access/);
});

test('sandbox mode is validated rather than passed through', () => {
  assert.equal(normalizeSandboxMode(undefined), DEFAULT_SANDBOX_MODE);
  assert.equal(normalizeSandboxMode('read-only'), 'read-only');
  assert.throws(() => normalizeSandboxMode('yolo'), TypeError);
  for (const mode of SANDBOX_MODES) assert.equal(normalizeSandboxMode(mode), mode);
});

test('model override requires a provider', () => {
  assert.throws(() => buildOverlayPatches({ ...BASE, model: 'deepseek-flash' }), TypeError);
  assert.throws(() => buildOverlayPatches({ ...BASE, provider: 'deepseek-official' }), TypeError);
  const patches = buildOverlayPatches({ ...BASE, provider: 'deepseek-official', model: 'deepseek-flash' });
  const model = patches.find((patch) => patch.id === 'agent-default-model');
  assert.deepEqual(model.config, { provider: 'deepseek-official', model: 'deepseek-flash' });
});

test('missing isolation roots are rejected', () => {
  assert.throws(() => buildOverlayPatches({ ...BASE, workspace: '' }), TypeError);
  assert.throws(() => buildOverlayPatches({ ...BASE, storageRoot: undefined }), TypeError);
  assert.throws(() => buildOverlayPatches({ ...BASE, sessionRoot: '' }), TypeError);
});

test('serialized overlay round-trips as literals, including awkward Windows paths', () => {
  const workspace = 'D:\\a b\\c:d\\#hash & "quote"\\-dash';
  const { yaml: text } = renderOverlay({
    workspace,
    storageRoot: 'C:\\state root\\s',
    sessionRoot: 'C:\\state root\\sessions',
    sandboxMode: 'workspace-write',
  });

  // No executable or tagged YAML may appear in an overlay.
  assert.equal(/!!js|!js|__jsExpr/.test(text), false, 'overlay must contain only literal scalars');

  const parsed = yaml.load(text);
  assert.ok(Array.isArray(parsed));
  const byId = new Map(parsed.map((patch) => [patch.id, patch.config]));
  assert.equal(byId.get('sandbox-policy').workspaceRoot, workspace);
  assert.equal(byId.get('sandbox-policy').mode, 'workspace-write');
  assert.equal(byId.get('storage-json').root, 'C:\\state root\\s');
  assert.equal(byId.get('session-persistence-jsonl').root, 'C:\\state root\\sessions');
  assert.equal(byId.get('approval').policy, 'ask');
});

test('a mode value is never coerced into a YAML boolean or null', () => {
  const text = serializeOverlay(buildOverlayPatches({ ...BASE, sandboxMode: 'read-only' }));
  const parsed = yaml.load(text);
  const sandbox = parsed.find((patch) => patch.id === 'sandbox-policy');
  assert.equal(typeof sandbox.config.mode, 'string');
  assert.equal(sandbox.config.mode, 'read-only');
});
