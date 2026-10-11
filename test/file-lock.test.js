import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { acquireFileLock, withFileLockSync } from '../dsh-plugin/file-lock.js';
import { tempDir } from './helpers.js';

const win32 = process.platform === 'win32';
function fixture(t, pid = process.pid) {
  const temp = tempDir('file-lock');
  t.after(temp.cleanup);
  const file = path.join(temp.dir, 'state.lock');
  const ownerFile = path.join(file, 'test-owner.json');
  const ownerText = JSON.stringify({ version: 1, pid, token: 'test-owner', createdAt: Date.now() });
  fs.mkdirSync(file);
  fs.writeFileSync(ownerFile, ownerText);
  return { ...temp, file, ownerFile, ownerText };
}
function inspectionError(code, file) {
  return Object.assign(new Error(code + ': scandir ' + file), { code, syscall: 'scandir', path: file });
}
function mockRead(t, file, read) {
  const original = fs.readdirSync;
  t.mock.method(fs, 'readdirSync', (target, ...args) => target === file
    ? read(original, target, ...args) : original(target, ...args));
}
function mockWait(t) {
  const waits = [];
  t.mock.method(Atomics, 'wait', (_array, _index, _value, timeout) => { waits.push(timeout); return 'timed-out'; });
  return waits;
}
function releaseFixture(f) { fs.unlinkSync(f.ownerFile); fs.rmdirSync(f.file); }
function assertOwnerUnchanged(f) { assert.equal(fs.readFileSync(f.ownerFile, 'utf8'), f.ownerText); }

// Each test mocks only its own lock path; no ACLs, labels or live processes change.
test('Windows lock inspection retries a transient EPERM before a successful listing', t => {
  const f = fixture(t), denied = inspectionError('EPERM', f.file);
  const waits = mockWait(t);
  let reads = 0, ran = false;
  mockRead(t, f.file, (original, target) => {
    if (++reads === 1) throw denied;
    const names = original(target);
    releaseFixture(f); // The old owner releases between listing and owner read.
    return names;
  });
  const work = () => { ran = true; return 'acquired'; };
  if (win32) {
    assert.equal(withFileLockSync(f.file, work), 'acquired');
    assert.equal(reads, 2);
    assert.ok(waits.every(ms => ms === 10));
    assert.equal(fs.existsSync(f.file), false);
  } else {
    assert.throws(() => withFileLockSync(f.file, work), error => error === denied);
    assert.equal(reads, 1);
    assert.equal(ran, false);
    assertOwnerUnchanged(f);
  }
});

test('Windows EPERM followed by a disappearing lock returns to normal acquisition', t => {
  const f = fixture(t), denied = inspectionError('EPERM', f.file);
  mockWait(t);
  let reads = 0;
  mockRead(t, f.file, (original, target) => {
    if (++reads === 1) throw denied;
    releaseFixture(f);
    return original(target); // ENOENT after the first EPERM is contention, not failure.
  });
  if (win32) {
    assert.equal(withFileLockSync(f.file, () => 'acquired'), 'acquired');
    assert.equal(reads, 2);
    assert.equal(fs.existsSync(f.file), false);
  } else {
    assert.throws(() => withFileLockSync(f.file, () => assert.fail('must not acquire')), error => error === denied);
    assert.equal(reads, 1);
    assertOwnerUnchanged(f);
  }
});

test('an immediately disappearing lock does not spend the EPERM retry budget', t => {
  const f = fixture(t);
  mockWait(t);
  let reads = 0;
  mockRead(t, f.file, (original, target) => {
    reads++;
    releaseFixture(f);
    return original(target);
  });
  assert.equal(withFileLockSync(f.file, () => 'acquired'), 'acquired');
  assert.equal(reads, 1);
  assert.equal(fs.existsSync(f.file), false);
});

test('persistent lock inspection EPERM has three Windows attempts and preserves the original error', t => {
  const f = fixture(t), denied = inspectionError('EPERM', f.file), waits = mockWait(t);
  let reads = 0;
  mockRead(t, f.file, () => { reads++; throw denied; });
  assert.throws(() => withFileLockSync(f.file, () => assert.fail('must not acquire')), error => error === denied);
  assert.equal(reads, win32 ? 3 : 1);
  assert.deepEqual(waits, win32 ? [10, 10] : []);
  assert.equal(denied.code, 'EPERM');
  assert.equal(denied.syscall, 'scandir');
  assert.equal(denied.path, f.file);
  assertOwnerUnchanged(f);
});

test('non-EPERM inspection failures are not retried or converted to lock timeouts', t => {
  const f = fixture(t), denied = inspectionError('EACCES', f.file), waits = mockWait(t);
  let reads = 0;
  mockRead(t, f.file, () => { reads++; throw denied; });
  assert.throws(() => withFileLockSync(f.file, () => assert.fail('must not acquire')), error => error === denied);
  assert.equal(reads, 1);
  assert.deepEqual(waits, []);
  assertOwnerUnchanged(f);
});

test('EPERM from candidate cleanup is not covered by directory-inspection retries', t => {
  const f = fixture(t), denied = Object.assign(new Error('candidate unlink denied'), { code: 'EPERM', syscall: 'unlink' });
  const original = fs.unlinkSync, waits = mockWait(t);
  let unlinks = 0;
  t.mock.method(fs, 'unlinkSync', target => {
    if (path.dirname(target).startsWith(f.file + '.claim-')) { unlinks++; throw denied; }
    return original(target);
  });
  assert.throws(() => withFileLockSync(f.file, () => assert.fail('must not acquire')), error => error === denied);
  assert.equal(unlinks, 1);
  assert.deepEqual(waits, []);
  assertOwnerUnchanged(f);
});

test('live and unknown lock owners are never removed or stolen', t => {
  for (const pid of [process.pid, 0, 'unverified']) {
    const f = fixture(t, pid);
    assert.throws(() => withFileLockSync(f.file, () => assert.fail('must not steal'), { timeoutMs: 0 }), { code: 'LOCK_TIMEOUT' });
    assertOwnerUnchanged(f);
    assert.deepEqual(fs.readdirSync(f.dir), ['state.lock']);
  }
});

test('sync and async lock deadlines still fail closed while an owner is alive', async t => {
  const f = fixture(t);
  assert.throws(() => withFileLockSync(f.file, () => assert.fail('must not acquire'), { timeoutMs: 0 }), { code: 'LOCK_TIMEOUT' });
  await assert.rejects(acquireFileLock(f.file, { deadline: Date.now() }), { code: 'LOCK_TIMEOUT' });
  assertOwnerUnchanged(f);
});

test('already-aborted and waiting async lock acquisition preserve cancellation and ownership', async t => {
  const f = fixture(t), reason = new Error('operator cancelled'), first = new AbortController();
  first.abort(reason);
  await assert.rejects(acquireFileLock(f.file, { signal: first.signal }), error => error === reason);
  const waiting = new AbortController();
  mockRead(t, f.file, (original, target) => { waiting.abort(reason); return original(target); });
  await assert.rejects(acquireFileLock(f.file, { signal: waiting.signal, deadline: Date.now() + 1000 }), error => error === reason);
  assertOwnerUnchanged(f);
});
