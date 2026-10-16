/** Scheduler -> real Guardian integration. Child processes only run local Node fixtures. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { connect, call, result } from './mcp-helpers.js';
import { tempDir, isolatedEnv } from './helpers.js';
import { supervise } from '../lib/supervisor.js';
import { exitProof, loadEvidence } from '../lib/supervision-evidence.js';
import { quarantineWorkspace } from '../lib/workspace-lock.js';

async function fixture(t, runTaskImpl) {
  const temp = tempDir('scheduler-supervision');
  const bridge = await connect({
    env: isolatedEnv(temp.dir), stateRoot: path.join(temp.dir, 'state'),
    defaultWorkspace: temp.dir, runTaskImpl,
  });
  t.after(async () => { await bridge.close(); temp.cleanup(); });
  return { ...bridge, dir: temp.dir };
}

async function submitAndSettle(bridge) {
  const reply = await call(bridge.client, 'dsh_task', {
    prompt: 'Local Node fixture only; never call DSH or a model.',
    sandbox_mode: 'read-only', background: true, timeout_ms: 20000,
  });
  assert.notEqual(reply.isError, true);
  const id = reply.structuredContent.task_id;
  const context = bridge.manager.taskContext(id);
  await bridge.scheduler.waitForTerminal(context, id, 15000);
  return { record: context.store.getTask(id), context };
}

function supervision(input, extra = {}) {
  return supervise({
    command: process.execPath,
    args: ['-e', 'process.stdout.write("SCHEDULER_GUARDIAN_FIXTURE_OK")'],
    cwd: input.workspace, env: process.env, stateDir: input.paths.dir,
    signal: input.signal, deadline: input.deadline,
    onSupervision: input.onSupervision, onStarted: input.onProcess,
    authorizeLaunch: input.authorizeLaunch, ...extra,
  });
}

test('scheduler authorizes a real local child under both locks with long v3 evidence paths', async t => {
  let authorized = false, output = '', outcome;
  const bridge = await fixture(t, async input => {
    outcome = await supervision(input, {
      authorizeLaunch: work => input.authorizeLaunch(() => {
        const scope = path.dirname(path.dirname(input.paths.dir));
        assert.ok(fs.existsSync(path.join(scope, '.execution.lock')));
        assert.ok(fs.existsSync(path.join(input.stateRoot, '_locks', 'supervision-registry.lock')));
        authorized = true;
        work();
      }),
      onStdout: bytes => { output += bytes; },
    });
    return result(input, { sessionId: null, answer: output, treeExited: outcome.treeExited });
  });
  const { record, context } = await submitAndSettle(bridge);
  assert.equal(record.state, 'completed', JSON.stringify(record.reason));
  assert.equal(authorized, true);
  assert.equal(output, 'SCHEDULER_GUARDIAN_FIXTURE_OK');
  assert.equal(record.treeExited, true);
  assert.equal(outcome.code, 0);
  const evidence = loadEvidence(record.supervisionDir, record.attemptId, record.jobId);
  assert.equal(evidence.bridge.authorized, true);
  assert.ok(path.join(record.supervisionDir, 'helper.json').length > 260);
  if (process.platform === 'win32') assert.equal(exitProof(evidence).kind, 'job-empty');
  assert.equal(fs.existsSync(path.join(context.dir, '.execution-quarantine.json')), false);
  assert.equal(fs.existsSync(path.join(bridge.manager.stateRoot, '_locks', 'supervision-registry.lock')), false);
});

test('scheduler final authorization refuses quarantine added during preparation', async t => {
  let started = false;
  const bridge = await fixture(t, async input => {
    quarantineWorkspace({
      stateRoot: input.stateRoot, workspace: input.workspace,
      scopeKey: input.conversationKey, taskId: 'other-incident', processPids: [],
    });
    await supervision(input, { onStarted: () => { started = true; } });
    assert.fail('A quarantined launch must not run');
  });
  const { record, context } = await submitAndSettle(bridge);
  assert.equal(record.state, 'failed');
  assert.equal(record.reason.code, 'WORKSPACE_QUARANTINED');
  assert.equal(record.treeExited, true);
  assert.equal(started, false);
  const evidence = loadEvidence(record.supervisionDir, record.attemptId, record.jobId);
  assert.equal(evidence.bridge.authorized, false);
  assert.equal(exitProof(evidence).kind, 'not-authorized');
  assert.equal(fs.existsSync(path.join(context.dir, '.execution-quarantine.json')), false);
  const dir = path.join(bridge.manager.stateRoot, '_locks', 'workspace-quarantines');
  const incidents = fs.readdirSync(dir).filter(file => file.endsWith('.json'));
  assert.equal(incidents.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, incidents[0]), 'utf8')).taskId, 'other-incident');
});
