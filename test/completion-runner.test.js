import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {runTask} from '../lib/task-runner.js';
import {taskPaths} from '../lib/paths.js';
import {tempDir} from './helpers.js';

// Unlike parser stubs, these tests traverse the actual worker, Windows Job
// helper (or POSIX group), IPC, log descriptors and task outcome derivation.
const cli = fileURLToPath(new URL('./fixtures/synthetic-completion-cli.mjs', import.meta.url));
for (const size of ['small', 'large', 'missing']) {
  test(`real Guardian drains ${size} completion through runner before closing task logs`, {timeout:30000}, async t => {
    const temp = tempDir('completion-runner');
    t.after(temp.cleanup);
    const paths = taskPaths('synthetic-completion', 'synthetic-task', path.join(temp.dir, 'state'));
    let progress = 0;
    const result = await runTask({
      conversationKey:'synthetic-completion', taskId:'synthetic-task', paths,
      workspace:temp.dir, prompt:'local synthetic fixture only', sandboxMode:'read-only', timeoutMs:20000,
      runtime:{
        launcher:{command:process.execPath, prefixArgs:[], launcherScript:cli},
        home:path.join(temp.dir, 'home'), version:'0.2.0-rc.2',
        env:{...(process.env.SystemRoot ? {SystemRoot:process.env.SystemRoot} : {}),
          DSH_HOME:path.join(temp.dir, 'home'), SYNTHETIC_ANSWER:size,
          SYNTHETIC_END_MODE:size === 'missing' ? 'omit-final' : 'final'},
      },
      ensureProfileImpl:async () => ({name:'synthetic-profile', fingerprint:'synthetic'}),
      onReport:() => {
        progress++;
        // Make the parent busy while the real worker exits with IPC in flight.
        // Deterministic lifecycle tests separately control the exact ordering.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
      },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.treeExited, true);
    assert.equal(result.sessionId, 'session-synthetic-completion');
    assert.equal(progress, 1);
    const events = fs.readFileSync(paths.reportLog, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(events.at(-1).type, size === 'missing' ? 'status' : 'final');
    assert.equal(events.at(-1).phase, size === 'missing' ? 'turn_end' : undefined);
    assert.equal(fs.readFileSync(paths.stderrLog, 'utf8'), 'SYNTHETIC_STDERR_TAIL\n');
    assert.equal(result.stderrTail, 'SYNTHETIC_STDERR_TAIL\n');
    if (size === 'missing') {
      assert.equal(result.state, 'failed');
      assert.equal(result.answer, null);
      assert.match(result.reason.message, /without successful completion/);
    } else {
      const answer = size === 'large' ? 'SYNTHETIC_COMPLETE:' + 'ёж✓'.repeat(20000) : 'SYNTHETIC_COMPLETE';
      assert.equal(result.state, 'completed');
      assert.equal(result.answer, answer);
      assert.equal(events.at(-1).text, answer);
      if (size === 'large') assert.ok(Buffer.byteLength(answer) > 128 * 1024);
    }
    const stages = fs.readdirSync(path.join(paths.dir, 'supervision'));
    assert.equal(stages.length, 1);
    const diagnostics = fs.readFileSync(path.join(paths.dir, 'supervision', stages[0], 'diagnostics.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(diagnostics.slice(-2).map(e => e.stage), ['worker-exited', 'relay-closed']);
    assert.equal(diagnostics.some(e => e.code), false, 'no late EBADF or swallowed relay error');
  });
}


test('standalone supervisor retains IPC without an unrelated timer or server handle', {timeout:30000}, async t => {
  const temp = tempDir('standalone-completion');
  t.after(temp.cleanup);
  const script = `
    import assert from 'node:assert/strict';
    import {supervise} from ${JSON.stringify(new URL('../lib/supervisor.js', import.meta.url).href)};
    let output = '', busy = false;
    const result = await supervise({
      command:process.execPath, args:['-e', 'console.log("head");setTimeout(()=>console.log("tail"),20)'],
      cwd:${JSON.stringify(temp.dir)}, stateDir:${JSON.stringify(temp.dir)}, env:process.env.SystemRoot ? {SystemRoot:process.env.SystemRoot} : {},
      onStdout:chunk => {
        output += chunk.toString();
        if (!busy) { busy = true; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200); }
      },
    });
    assert.equal(result.treeExited, true);
    assert.equal(result.code, 0);
    assert.equal(output, 'head' + String.fromCharCode(10) + 'tail' + String.fromCharCode(10));
    console.log('STANDALONE_DRAIN_OK');
  `;
  const {stdout, stderr} = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
    cwd:temp.dir, windowsHide:true, timeout:20000,
    env:process.env.SystemRoot ? {SystemRoot:process.env.SystemRoot} : {},
  });
  assert.equal(stdout.trim(), 'STANDALONE_DRAIN_OK');
  assert.equal(stderr, '');
});
