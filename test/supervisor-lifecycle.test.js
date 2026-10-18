import assert from 'node:assert/strict';
import test from 'node:test';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {supervise} from '../lib/supervisor.js';
import {saveStage, loadEvidence, exitProof} from '../lib/supervision-evidence.js';

// Yield to promise observers without assuming how many milliseconds IPC takes.
const checkpoint = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, callbacks = {}) {
  const tempRoot = path.resolve(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(tempRoot, 'dsh-supervisor-lifecycle-'));
  const trace = [], sent = [], kills = [];
  const worker = new EventEmitter();
  // This PID is borrowed ONLY for the parent's creation-time identity query.
  // No process is forked, signalled, or otherwise controlled by this fixture.
  Object.assign(worker, {
    pid: process.pid,
    connected: true,
    exitCode: null,
    signalCode: null,
    stderr: new EventEmitter(),
    send(message, callback) {
      sent.push(message);
      queueMicrotask(() => callback?.(null));
      return true;
    },
    disconnect() {
      if (!worker.connected) return;
      worker.connected = false;
      trace.push('worker:disconnect');
      worker.emit('disconnect');
    },
    kill(signal) {
      kills.push(signal);
      return true;
    },
  });
  let closed = false, metadata, settlement;
  let channelRefs = 0;
  worker.channel = {ref() { channelRefs++; }};
  const close = () => {
    if (closed) return;
    closed = true;
    worker.disconnect();
    worker.stderr.emit('end');
    worker.stderr.emit('close');
    trace.push('worker:close');
    worker.emit('close', worker.exitCode, worker.signalCode);
  };
  t.after(() => {
    // Also clears the supervisor's disconnect timer if an assertion fails.
    close();
    const target = path.resolve(dir);
    assert.equal(path.dirname(target), tempRoot);
    assert.ok(path.basename(target).startsWith('dsh-supervisor-lifecycle-'));
    fs.rmSync(target, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
  });

  const running = supervise({
    command: process.execPath,
    args: [],
    cwd: dir,
    stateDir: dir,
    env: {},
    ...callbacks,
    forkImpl: () => worker,
    onSupervision: event => { metadata = {...metadata, ...event}; },
  });
  // Observe both outcomes immediately: a deliberately broken implementation
  // must fail assertions, not create an unhandled rejection or stop the driver.
  const completion = running.then(
    value => { trace.push('fulfilled'); return settlement = {status: 'fulfilled', value}; },
    error => { trace.push('rejected'); return settlement = {status: 'rejected', error}; },
  );
  const message = event => {
    trace.push('message:' + event.type);
    worker.emit('message', event);
  };
  const output = (type, bytes) => message({type, data: Buffer.from(bytes).toString('base64')});
  const writeExitEvidence = code => {
    assert.ok(metadata?.worker?.creationTime, 'fixture needs the registered worker identity');
    assert.equal(metadata.worker.pid, process.pid);
    assert.equal(metadata.worker.status, 'alive');
    assert.equal(metadata.supervisionDir, path.join(dir, 'supervision', metadata.attemptId));
    assert.equal(sent.filter(event => event.type === 'launch').length, 1);
    const {attemptId, jobId, supervisionDir} = metadata;
    const common = {attemptId, jobId};
    const workerIdentity = {...metadata.worker};
    // A separate, synthetic helper identity, never queried or spawned. Use the
    // current process's actual creationTime, not a guessed Windows timestamp.
    const helperIdentity = {pid: process.pid + 1, creationTime: workerIdentity.creationTime};
    saveStage(supervisionDir, 'worker', {
      ...common, stage: 'exited', launchRequested: true,
      worker: workerIdentity, helper: helperIdentity,
    });
    saveStage(supervisionDir, 'helper', {
      ...common, stage: 'job-empty', helper: helperIdentity,
      proof: 'job-empty', activeProcesses: 0, exitCode: code,
    });
    const records = loadEvidence(supervisionDir, attemptId, jobId);
    assert.equal(records.bridge.authorized, true);
    assert.deepEqual(exitProof(records), {verified: true, kind: 'job-empty', code});
  };
  const exit = () => {
    worker.exitCode = 0;
    trace.push('worker:exit');
    worker.emit('exit', 0, null);
  };
  const pendingAt = async (label, observations) => {
    await checkpoint();
    observations.push([label, settlement?.status ?? 'pending']);
  };
  return {
    dir, worker, trace, sent, kills, completion, message, output, exit, close,
    writeExitEvidence, pendingAt,
    get metadata() { return metadata; },
    get settlement() { return settlement; },
    get channelRefs() { return channelRefs; },
  };
}

test('supervise drains stdout/stderr and the exit IPC tail before the full relay-close barrier', {timeout: 30000}, async t => {
  const stdout = [], stderr = [], diagnostics = [], pending = [];
  const f = fixture(t, {
    onStdout: bytes => { f.trace.push('callback:stdout'); stdout.push(bytes); },
    onStderr: bytes => { f.trace.push('callback:stderr'); stderr.push(bytes); },
    onDiagnostic: text => { f.trace.push('callback:diagnostic'); diagnostics.push(text); },
  });
  const final = JSON.stringify({type: 'final', text: 'tail survived worker exit'}) + '\n';
  const warning = 'late stderr after worker exit\n';
  const guardianStderr = 'late guardian diagnostic\n';
  // Deliberately differs from the worker process's own zero exit code.
  const outcome = {type: 'exit', code: 23, signal: null, treeExited: true};
  f.message({type: 'started', pid: process.pid});
  f.writeExitEvidence(outcome.code);
  f.exit();
  await f.pendingAt('worker exit with valid independent proof', pending);

  f.output('stdout', final);
  await f.pendingAt('late stdout', pending);
  f.output('stderr', warning);
  await f.pendingAt('late stderr', pending);
  f.worker.stderr.emit('data', Buffer.from(guardianStderr));
  await f.pendingAt('late guardian stderr', pending);
  f.message(outcome);
  await f.pendingAt('late exit IPC', pending);
  f.worker.disconnect();
  await f.pendingAt('IPC disconnect without close', pending);
  f.close();
  await checkpoint();

  assert.ok(f.settlement, 'worker close must settle supervision');
  const settled = await f.completion;
  assert.deepEqual(pending, [
    ['worker exit with valid independent proof', 'pending'],
    ['late stdout', 'pending'],
    ['late stderr', 'pending'],
    ['late guardian stderr', 'pending'],
    ['late exit IPC', 'pending'],
    ['IPC disconnect without close', 'pending'],
  ], 'neither exit, tail IPC nor disconnect may settle before close');
  assert.equal(settled.status, 'fulfilled');
  assert.equal(stdout.length, 1);
  assert.equal(stderr.length, 1);
  assert.ok(stdout.every(Buffer.isBuffer));
  assert.ok(stderr.every(Buffer.isBuffer));
  assert.equal(Buffer.concat(stdout).toString(), final);
  assert.equal(Buffer.concat(stderr).toString(), warning);
  assert.equal(diagnostics.length, 1);
  assert.equal(fs.readFileSync(path.join(f.metadata.supervisionDir, 'guardian.stderr.log'), 'utf8'), guardianStderr);
  for (const [key, value] of Object.entries(outcome)) assert.equal(settled.value[key], value);
  for (const key of ['attemptId', 'jobId', 'supervisionDir']) assert.equal(settled.value[key], f.metadata[key]);
  assert.equal(settled.value.started, true);
  assert.deepEqual(settled.value.exitProof, {verified: true, kind: 'job-empty', code: 23});
  assert.deepEqual(f.trace, [
    'message:started', 'worker:exit',
    'message:stdout', 'callback:stdout',
    'message:stderr', 'callback:stderr', 'callback:diagnostic',
    'message:exit', 'worker:disconnect', 'worker:close', 'fulfilled',
  ]);
  assert.deepEqual(f.kills, []);
  assert.equal(f.channelRefs, 1, 'keep the IPC handle alive until the relay closes');
});

for (const stream of ['stdout', 'stderr']) {
  test(`supervise rejects with the original late ${stream} callback error instead of swallowing it after resolve`, {timeout: 30000}, async t => {
    const original = Object.assign(new Error(`late ${stream} write failed`), {code: 'EBADF', syscall: 'write'});
    const pending = [], received = [];
    const f = fixture(t, {
      [stream === 'stdout' ? 'onStdout' : 'onStderr']: bytes => {
        f.trace.push('callback:' + stream);
        received.push(bytes);
        throw original;
      },
    });
    const tail = `${stream} tail that throws\n`;
    f.message({type: 'started', pid: process.pid});
    f.writeExitEvidence(0);
    f.exit();
    await f.pendingAt('worker exit', pending);
    // Always drive the tail even on the old implementation: its already-fulfilled
    // promise must not hide the callback exception caught by the message handler.
    f.output(stream, tail);
    await f.pendingAt('throwing tail callback', pending);
    f.message({type: 'exit', code: 0, signal: null, treeExited: true});
    await f.pendingAt('late exit IPC after callback failure', pending);
    f.worker.disconnect();
    await f.pendingAt('IPC disconnect without close', pending);
    f.close();
    await checkpoint();

    assert.ok(f.settlement, 'worker close must settle the callback failure');
    const settled = await f.completion;
    assert.equal(settled.status, 'rejected', 'late callback error must reject, not leave an earlier resolve in place');
    assert.strictEqual(settled.error, original, 'preserve the original Error object, not just its message');
    assert.equal(settled.error.code, 'EBADF');
    assert.equal(settled.error.syscall, 'write');
    assert.equal(settled.error.treeExited, true);
    assert.equal(settled.error.exitStatus, 'confirmed');
    assert.deepEqual(settled.error.exitProof, {verified: true, kind: 'job-empty', code: 0});
    for (const key of ['attemptId', 'jobId', 'supervisionDir']) assert.equal(settled.error[key], f.metadata[key]);
    assert.deepEqual(pending, [
      ['worker exit', 'pending'],
      ['throwing tail callback', 'pending'],
      ['late exit IPC after callback failure', 'pending'],
      ['IPC disconnect without close', 'pending'],
    ]);
    assert.equal(received.length, 1);
    assert.ok(Buffer.isBuffer(received[0]));
    assert.equal(received[0].toString(), tail);
    assert.deepEqual(f.trace.slice(-3), ['worker:disconnect', 'worker:close', 'rejected']);
    const diagnostics = fs.readFileSync(path.join(f.metadata.supervisionDir, 'diagnostics.ndjson'), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line));
    assert.ok(diagnostics.some(event => event.stage === 'failure' && event.code === 'EBADF' && event.message === original.message));
    assert.deepEqual(f.kills, []);
  });
}


test('explicit disconnect settles after process exit and stderr close even without ChildProcess close', {timeout:30000}, async t => {
  const f = fixture(t);
  const pending = [];
  f.message({type:'started', pid:process.pid});
  f.writeExitEvidence(0);
  f.message({type:'exit', code:0, treeExited:true});
  f.worker.disconnect();
  await f.pendingAt('disconnect alone', pending);
  f.exit();
  await f.pendingAt('process exit while stderr remains open', pending);
  f.worker.stderr.emit('close');
  await checkpoint();
  assert.deepEqual(pending, [['disconnect alone', 'pending'], ['process exit while stderr remains open', 'pending']]);
  assert.equal(f.trace.includes('worker:close'), false);
  assert.equal(f.settlement?.status, 'fulfilled');
  assert.equal((await f.completion).value.treeExited, true);
  assert.deepEqual(f.kills, []);
});

test('duplex supervision refuses an older worker before launch authorization', {timeout:30000},async t=>{
  const f=fixture(t,{duplex:true});assert.equal(f.sent.some(e=>e.type==='launch'),false);
  f.message({type:'hello',protocol:1,stdin:false});f.exit();f.close();const settled=await f.completion;
  assert.equal(f.sent.some(e=>e.type==='launch'),false);assert.equal(settled.status,'rejected');assert.equal(settled.error.code,'GUARDIAN_PROTOCOL_MISMATCH');
});
test('duplex protocol 2 authorizes once and rejects a mismatched started handshake', {timeout:30000},async t=>{
  const f=fixture(t,{duplex:true});f.message({type:'hello',protocol:2,stdin:true});assert.equal(f.sent.filter(e=>e.type==='launch').length,1);
  f.message({type:'started',protocol:1,pid:process.pid});f.writeExitEvidence(0);f.exit();f.close();const settled=await f.completion;assert.equal(settled.status,'rejected');assert.equal(settled.error.code,'GUARDIAN_PROTOCOL_MISMATCH');
});
