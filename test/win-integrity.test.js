/**
 * Guardian integrity-label handling: label parsing, fail-closed placement,
 * probe verdicts and the Low-image refusal. No model call, no network.
 *
 * The mechanism these tests pin down: DSH's Windows sandbox labels its
 * authorized roots Low, so an artifact built inside such a root inherits the
 * label, and a process started from a Low-labeled image runs at Low integrity
 * and cannot write ordinary task state.
 * @module test/win-integrity.test
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { repoRoot } from '../lib/paths.js';
import { tempDir } from './helpers.js';
import {
  parseIntegrityLabel, readIntegrityLabel, readTokenIntegrity, isLowLabeled, guardianRefusal,
  ensureStageDir, placeWithoutLowLabel, probeGuardianWrite, verifyGuardianArtifact, verdictFromGuardianEvents,
  STAGE_UNUSABLE, IMAGE_LOW, LABEL_UNVERIFIED,
} from '../lib/win-integrity.js';

const win32 = process.platform === 'win32';
const guardian = () => path.join(repoRoot(), 'native', 'windows-job-host.exe');

test('mandatory label lines are parsed by level name and by raw SID', () => {
  assert.equal(parseIntegrityLabel('Mandatory Label\\Low Mandatory Level:(I)(NW)').level, 'low');
  assert.equal(parseIntegrityLabel('Mandatory Label\\Low Mandatory Level:(OI)(CI)(NW)').level, 'low');
  assert.equal(parseIntegrityLabel('Mandatory Label\\S-1-16-4096:(I)(NW)').level, 'low');
  assert.equal(parseIntegrityLabel('Mandatory Label\\Medium Mandatory Level Label S-1-16-8192').level, 'medium');
  assert.equal(parseIntegrityLabel('Mandatory Label\\High Mandatory Level:(I)(NW)').level, 'high');
});

test('a listing without a mandatory label is reported as unlabeled, not as Low', () => {
  const listing = 'C:\\work\\file.txt NT AUTHORITY\\SYSTEM:(I)(F)\r\n                BUILTIN\\Users:(I)(RX)\r\n';
  const verdict = parseIntegrityLabel(listing);
  assert.equal(verdict.level, 'unlabeled');
  assert.equal(isLowLabeled(verdict), false);
});

test('an unrecognized label line is unknown rather than a silent pass', () => {
  const verdict = parseIntegrityLabel('Mandatory Label\\Some New Level:(I)(NW)');
  assert.equal(verdict.level, 'unknown');
  assert.equal(isLowLabeled(verdict), false);
  assert.match(verdict.detail, /Unrecognized/);
});

test('a missing path never reads as unlabeled', () => {
  const { dir, cleanup } = tempDir('win-label-missing');
  try {
    const verdict = readIntegrityLabel(path.join(dir, 'absent.exe'));
    assert.equal(verdict.level, 'unknown');
    assert.match(verdict.detail, /does not exist/);
  } finally { cleanup(); }
});

test('an existing object on Windows reads a concrete integrity verdict', { skip: !win32 }, () => {
  const { dir, cleanup } = tempDir('win-label-present');
  try {
    const verdict = readIntegrityLabel(dir);
    assert.ok(['unlabeled', 'medium', 'high'].includes(verdict.level), 'unexpected verdict ' + JSON.stringify(verdict));
    assert.equal(isLowLabeled(verdict), false);
    const token = readTokenIntegrity();
    assert.ok(['low', 'medium', 'high', 'system', 'unknown'].includes(token.level));
  } finally { cleanup(); }
});

test('a Low guardian image is refused before anything is launched', () => {
  const low = { level: 'low', raw: 'Mandatory Label\\Low Mandatory Level:(I)(NW)', detail: null };
  const refusal = guardianRefusal(low, 'C:\\p\\native\\windows-job-host.exe', 'C:\\state');
  assert.ok(refusal, 'a Low image must be refused');
  assert.equal(refusal.code, IMAGE_LOW);
  assert.match(refusal.message, /rebuild it with "npm run build:native"/i);
  assert.equal(guardianRefusal({ level: 'unlabeled', raw: '', detail: null }, 'helper', 'state'), null);
  assert.equal(guardianRefusal({ level: 'medium', raw: '', detail: null }, 'helper', 'state'), null);
  assert.equal(guardianRefusal({ level: 'unknown', raw: '', detail: 'x' }, 'helper', 'state'), null);
});

test('probe verdicts fail closed on refusal, missing start, unsettled tree and timeout', () => {
  const refusal = verdictFromGuardianEvents({ events: [{ type: 'error', code: 'GUARDIAN_STATE_NOT_WRITABLE', message: 'cannot write' }, { type: 'exit', code: 1, treeExited: true }] });
  assert.equal(refusal.ok, false);
  assert.equal(refusal.code, 'GUARDIAN_STATE_NOT_WRITABLE');
  for (const events of [[], [{ type: 'started' }], [{ type: 'started' }, { type: 'exit', code: 0, treeExited: false }]]) {
    const verdict = verdictFromGuardianEvents({ events, wrote: true });
    assert.equal(verdict.ok, false, 'incomplete evidence must not pass: ' + JSON.stringify(events));
    assert.ok([LABEL_UNVERIFIED,'GUARDIAN_PROTOCOL_MISMATCH'].includes(verdict.code));
  }
  assert.equal(verdictFromGuardianEvents({ events: [{ type: 'started' }, { type: 'exit', code: 0, treeExited: true }], wrote: false }).ok, false);
  assert.equal(verdictFromGuardianEvents({ events: [{ type: 'started' }, { type: 'exit', code: 0, treeExited: true }], wrote: false, timedOut: true }).detail, 'The guardian probe timed out.');
  const healthy = verdictFromGuardianEvents({ events: [{type:'hello',protocol:2,stdin:true},{ type: 'started',protocol:2 }, { type: 'exit', code: 0, treeExited: true }], wrote: true });
  assert.equal(healthy.ok, true);
  assert.equal(healthy.code, null);
});

test('the guardian probe reports a spawn failure instead of claiming success', { skip: !win32 }, async () => {
  const { dir, cleanup } = tempDir('win-probe-missing');
  try {
    const verdict = await probeGuardianWrite(path.join(dir, 'absent-guardian.exe'), { timeoutMs: 15000 });
    assert.equal(verdict.ok, false);
    assert.ok([LABEL_UNVERIFIED, 'ENOENT'].includes(verdict.code) || /ENOENT|could not be started/i.test(verdict.detail), JSON.stringify(verdict));
  } finally { cleanup(); }
});

test('the stage directory must share a volume with the artifact and be writable', () => {
  const { dir, cleanup } = tempDir('win-stage');
  try {
    const dest = path.join(dir, 'windows-job-host.exe');
    const stage = ensureStageDir(path.join(dir, 'stage'), dest);
    assert.equal(stage, path.join(dir, 'stage'));
    assert.ok(fs.existsSync(stage));
    assert.equal(fs.readdirSync(stage).length, 0, 'the write probe must clean up after itself');
    const file = path.join(dir, 'not-a-directory');
    fs.writeFileSync(file, 'x');
    assert.throws(() => ensureStageDir(path.join(file, 'stage'), dest), error => error.code === STAGE_UNUSABLE);
    if (win32) {
      const other = path.parse(dest).root.toLowerCase() === 'c:\\' ? 'D:\\' : 'C:\\';
      if (fs.existsSync(other)) assert.throws(() => ensureStageDir(path.join(other, 'codex-dsh-stage-probe'), dest), error => error.code === STAGE_UNUSABLE);
    }
  } finally { cleanup(); }
});

test('placement links the staged artifact instead of copying it and keeps the previous one', () => {
  const { dir, cleanup } = tempDir('win-place');
  try {
    const stage = path.join(dir, 'stage'), dest = path.join(dir, 'out', 'windows-job-host.exe');
    fs.mkdirSync(stage, { recursive: true }); fs.mkdirSync(path.dirname(dest), { recursive: true });
    const staged = path.join(stage, 'windows-job-host.exe');
    fs.writeFileSync(staged, 'first-bytes');
    const first = placeWithoutLowLabel({ stageFile: staged, destFile: dest });
    assert.equal(fs.readFileSync(dest, 'utf8'), 'first-bytes');
    assert.equal(first.previous, null);
    assert.notEqual(first.label.level, 'low');
    assert.equal(fs.statSync(dest).ino, fs.statSync(staged).ino, 'the destination must be the staged file object, not a copy');
    // The stage path and the placed artifact are the same object, so a rebuild
    // must drop the stale entry before writing again — otherwise it would mutate
    // the live guardian in place. build-native.js does exactly this.
    fs.unlinkSync(staged);
    fs.writeFileSync(staged, 'second-bytes');
    const second = placeWithoutLowLabel({ stageFile: staged, destFile: dest });
    assert.equal(fs.readFileSync(dest, 'utf8'), 'second-bytes');
    assert.ok(second.previous, 'the replaced artifact must be preserved');
    assert.equal(fs.readFileSync(second.previous, 'utf8'), 'first-bytes');
  } finally { cleanup(); }
});

test('placement refuses a missing or linked source', () => {
  const { dir, cleanup } = tempDir('win-place-refuse');
  try {
    const dest = path.join(dir, 'windows-job-host.exe');
    assert.throws(() => placeWithoutLowLabel({ stageFile: path.join(dir, 'absent.exe'), destFile: dest }), error => error.code === LABEL_UNVERIFIED);
    const real = path.join(dir, 'real.exe'); fs.writeFileSync(real, 'bytes');
    const link = path.join(dir, 'link.exe');
    try { fs.symlinkSync(real, link); assert.throws(() => placeWithoutLowLabel({ stageFile: link, destFile: dest }), error => error.code === LABEL_UNVERIFIED); }
    catch (error) { if (error.code !== 'EPERM') throw error; }
  } finally { cleanup(); }
});

test('the built guardian is not Low-labeled and passes its own write preflight', { skip: !win32 }, async () => {
  const helper = guardian();
  if (!fs.existsSync(helper)) return; // the guardian tests in supervisor.test.js already require a built helper
  const verdict = await verifyGuardianArtifact(helper, { timeoutMs: 60000 });
  assert.notEqual(verdict.image.level, 'low', 'the guardian image inherited a Low label; rebuild it with npm run build:native from an unconfined session');
  assert.equal(verdict.ok, true, JSON.stringify({ image: verdict.image, probe: { ok: verdict.probe.ok, code: verdict.probe.code, detail: verdict.probe.detail } }));
});

test('a copy that inherits the Low label is refused and probed as unusable', { skip: !win32 }, async t => {
  const helper = guardian();
  if (!fs.existsSync(helper)) return;
  const { dir, cleanup } = tempDir('win-low-copy');
  // A file created inside a Low-labeled tree inherits the label, so the copy has
  // to be made where the workspace root is labeled — not in the unlabeled test
  // scratch directory. Copying the good guardian there reproduces exactly the
  // defect this work removes.
  const prefix = '.guardian-low-probe-';
  const removeLeftovers = () => {
    for (const name of fs.readdirSync(repoRoot())) if (name.startsWith(prefix) && name.endsWith('.exe')) { try { fs.rmSync(path.join(repoRoot(), name), { force: true }); } catch { /* a running image refuses removal until it exits */ } }
  };
  const removeWithRetry = async target => {
    for (let attempt = 0; attempt < 20; attempt++) {
      try { fs.rmSync(target, { force: true }); } catch { /* retry below */ }
      if (!fs.existsSync(target)) return true;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return !fs.existsSync(target);
  };
  removeLeftovers();
  const copy = path.join(repoRoot(), prefix + process.pid + '.exe');
  try {
    fs.copyFileSync(helper, copy);
    const label = readIntegrityLabel(copy);
    if (label.level !== 'low') { t.diagnostic('the workspace root does not apply Low inheritance here (verdict: ' + label.level + '), so the negative case cannot be reproduced on this machine'); return; }
    const refusal = guardianRefusal(label, copy, dir);
    assert.equal(refusal?.code, IMAGE_LOW);
    const probe = await probeGuardianWrite(copy, { timeoutMs: 60000 });
    assert.equal(probe.ok, false, 'a Low-labeled guardian must never pass the state-write preflight');
  } finally {
    if (!await removeWithRetry(copy)) t.diagnostic('a killed guardian image kept ' + copy + ' locked; the next run removes it');
    cleanup();
  }
});
