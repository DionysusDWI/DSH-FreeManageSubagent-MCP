/**
 * The isolation guarantee: a report published into one conversation must be
 * unreachable from another, and the physical state directories must not collide.
 * @module test/isolation.test
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { ConversationRegistry } from '../lib/conversation.js';
import { ReportQueue } from '../lib/report-queue.js';
import { TaskStore, createTaskId } from '../lib/store.js';
import { conversationDir, encodeKey } from '../lib/paths.js';
import { isolatedEnv, tempDir } from './helpers.js';

test('a queue exposes only the reports of its own conversation', () => {
  const { dir, cleanup } = tempDir('queue');
  try {
    const a = new ReportQueue({ conversationKey: 'thread-a', logPath: path.join(dir, 'a.ndjson') });
    const b = new ReportQueue({ conversationKey: 'thread-b', logPath: path.join(dir, 'b.ndjson') });

    a.push({ taskId: 't1', kind: 'progress', text: 'a-only' });
    b.push({ taskId: 't1', kind: 'progress', text: 'b-only' });

    assert.deepEqual(a.list().map((report) => report.text), ['a-only']);
    assert.deepEqual(b.list().map((report) => report.text), ['b-only']);

    // Even asking for the same task id cannot reach the other conversation.
    assert.deepEqual(a.list({ taskId: 't1' }).map((report) => report.text), ['a-only']);
  } finally {
    cleanup();
  }
});

test('a queue rejects construction without an owner', () => {
  assert.throws(() => new ReportQueue({ conversationKey: '', logPath: 'x' }), TypeError);
  assert.throws(() => new ReportQueue({ conversationKey: 'k', logPath: '' }), TypeError);
});

test('report sequence numbers are per task and monotonic', () => {
  const { dir, cleanup } = tempDir('seq');
  try {
    const queue = new ReportQueue({ conversationKey: 'c', logPath: path.join(dir, 'r.ndjson') });
    queue.push({ taskId: 't1', text: 'one' });
    queue.push({ taskId: 't1', text: 'two' });
    queue.push({ taskId: 't2', text: 'other' });

    assert.deepEqual(queue.list({ taskId: 't1' }).map((report) => report.seq), [1, 2]);
    assert.deepEqual(queue.list({ taskId: 't2' }).map((report) => report.seq), [1]);
    assert.equal(queue.latestSeq('t1'), 2);
    assert.equal(queue.latestSeq('missing'), 0);
  } finally {
    cleanup();
  }
});

test('cursor reads return only newer reports', () => {
  const { dir, cleanup } = tempDir('cursor');
  try {
    const queue = new ReportQueue({ conversationKey: 'c', logPath: path.join(dir, 'r.ndjson') });
    for (const text of ['a', 'b', 'c']) queue.push({ taskId: 't1', text });

    assert.deepEqual(queue.list({ taskId: 't1', since: 1 }).map((report) => report.text), ['b', 'c']);
    assert.deepEqual(queue.list({ taskId: 't1', since: 3 }), []);
    assert.deepEqual(queue.list({ taskId: 't1', limit: 2 }).map((report) => report.text), ['a', 'b']);
    assert.deepEqual(queue.list({ taskId: 't1', kinds: ['progress'] }).length, 3);
    assert.deepEqual(queue.list({ taskId: 't1', kinds: ['blocker'] }), []);
  } finally {
    cleanup();
  }
});

test('the same stable event ID from two sources collapses into one entry', () => {
  const { dir, cleanup } = tempDir('dedup');
  try {
    const queue = new ReportQueue({ conversationKey: 'c', logPath: path.join(dir, 'r.ndjson') });
    const report = { taskId: 't1', eventId: 'stable-call-1', kind: 'milestone', text: 'same', agentId: 'session-1', agentRole: 'main' };

    assert.ok(queue.pushIfNew(report) !== null, 'the first observation is published');
    assert.equal(queue.pushIfNew({ ...report, ts: Date.now() + 5 }), null, 'the same content is suppressed');
    assert.equal(queue.list({ taskId: 't1' }).length, 1);

    // A retransmission of the same stable event is deduplicated, not equal text.
    // Agent-authored reports are ingested canonically from the durable channel.
    assert.equal(
      queue.pushIfNew({ ...report, agentId: 'session-2', agentRole: 'subagent' }),
      null,
      'the same text from the channel collapses onto the stream observation',
    );
    assert.equal(queue.list({ taskId: 't1' }).length, 1);

    // Different text or a different kind is a distinct report.
    assert.ok(queue.pushIfNew({ ...report, eventId: 'stable-call-2', text: 'different' }) !== null);
    assert.ok(queue.pushIfNew({ ...report, eventId: 'stable-call-3', kind: 'blocker' }) !== null);
    assert.equal(queue.list({ taskId: 't1' }).length, 3);

    // A different task is unaffected by the other task's dedup keys.
    assert.ok(queue.pushIfNew({ ...report, taskId: 't2' }) !== null);
  } finally {
    cleanup();
  }
});

test('long report text is bounded and flagged', () => {
  const { dir, cleanup } = tempDir('bound');
  try {
    const queue = new ReportQueue({ conversationKey: 'c', logPath: path.join(dir, 'r.ndjson'), maxTextBytes: 32 });
    const report = queue.push({ taskId: 't1', text: 'x'.repeat(200) });
    assert.equal(Buffer.byteLength(report.text, 'utf8') <= 32, true);
    assert.equal(report.truncated, true);
  } finally {
    cleanup();
  }
});

test('reports are persisted to the log for post-hoc reading', () => {
  const { dir, cleanup } = tempDir('log');
  try {
    const logPath = path.join(dir, 'reports.ndjson');
    const queue = new ReportQueue({ conversationKey: 'c', logPath });
    queue.push({ taskId: 't1', kind: 'blocker', text: 'need input' });

    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]);
    assert.equal(record.text, 'need input');
    assert.equal(record.kind, 'blocker');
    assert.equal(record.conversationKey, 'c');
  } finally {
    cleanup();
  }
});

test('a task store refuses a record planted from another conversation', () => {
  const { dir, cleanup } = tempDir('store');
  try {
    const root = path.join(dir, 'state');
    const a = new TaskStore({ conversationKey: 'thread-a', dir: path.join(root, 'thread-a') });
    const b = new TaskStore({ conversationKey: 'thread-b', dir: path.join(root, 'thread-b') });
    assert.notEqual(a.dir, b.dir);

    const taskId = createTaskId();
    a.putTask({
      taskId,
      conversationKey: 'thread-a',
      prompt: 'p',
      workspace: 'D:\\work',
      sandboxMode: 'workspace-write',
      state: 'completed',
      createdAt: 1,
      updatedAt: 2,
      sessionId: 'session-1',
      answer: 'a',
      exitCode: 0,
      reason: null,
      reportCount: 0,
    });

    assert.ok(a.getTask(taskId) !== null);
    assert.equal(b.getTask(taskId), null, 'another conversation cannot read the record');
    assert.deepEqual(b.listTasks(), []);
  } finally {
    cleanup();
  }
});

test('conversation keys map to distinct directories even when illegal on Windows', () => {
  const { dir, cleanup } = tempDir('paths');
  try {
    // The state root is passed in rather than set on `process.env`, so this test
    // cannot leak a state directory into another test file.
    const root = path.join(dir, 'state');
    const keys = ['a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a b', 'a\u0000b', '..', '.'];
    const dirs = keys.map((key) => conversationDir(key, root));
    assert.equal(new Set(dirs).size, keys.length, 'every key maps to its own directory');
    for (const mapped of dirs) {
      // Each mapping must stay a single component inside the state root.
      assert.equal(path.dirname(mapped), root);
    }
    assert.notEqual(encodeKey('a/b'), encodeKey('a\\b'));
    assert.equal(encodeKey('a/b').includes('/'), false);
  } finally {
    cleanup();
  }
});

test('a registry binds once and refuses a second conversation', () => {
  const { dir, cleanup } = tempDir('registry');
  try {
    const registry = new ConversationRegistry({
      env: isolatedEnv(dir),
      stateRoot: path.join(dir, 'state'),
    });

    const first = registry.resolve({ threadId: 'thread-a', sessionId: 'session-a' });
    assert.equal(first.key, 'thread-a');
    assert.equal(first.source, '_meta.threadId');
    assert.equal(first.threadId, 'thread-a');

    // The same thread, again, stays bound.
    assert.equal(registry.resolve({ threadId: 'thread-a' }).key, 'thread-a');

    // A different thread is refused rather than served.
    assert.throws(() => registry.resolve({ threadId: 'thread-b' }), (error) => error.code === 'CONVERSATION_MISMATCH');
    assert.equal(registry.current().key, 'thread-a');
  } finally {
    cleanup();
  }
});

test('conversation resolution falls back in the documented order', () => {
  const { dir, cleanup } = tempDir('fallback');
  try {
    const pinned = new ConversationRegistry({
      env: isolatedEnv(dir, { CODEX_DSH_MCP_CONVERSATION: 'pinned' }),
      stateRoot: path.join(dir, 'state'),
    });
    assert.equal(pinned.resolve({}).key, 'pinned');
    assert.equal(pinned.current().source, 'CODEX_DSH_MCP_CONVERSATION');

    const generated = new ConversationRegistry({ env: isolatedEnv(dir), stateRoot: path.join(dir, 'state') });
    const context = generated.resolve({});
    assert.match(context.key, /^local-[0-9a-f]{12}$/);

    // sessionId is used when the thread id is absent.
    const viaSession = new ConversationRegistry({ env: isolatedEnv(dir), stateRoot: path.join(dir, 'state') });
    assert.equal(viaSession.resolve({ sessionId: 'session-z' }).key, 'session-z');
    assert.equal(viaSession.current().threadId, null);
  } finally {
    cleanup();
  }
});

test('two conversations keep entirely separate state and queues', () => {
  const { dir, cleanup } = tempDir('twoconv');
  try {
    const env = isolatedEnv(dir);
    const stateRoot = path.join(dir, 'state');
    const a = new ConversationRegistry({ env, stateRoot });
    const b = new ConversationRegistry({ env, stateRoot });

    const contextA = a.resolve({ threadId: 'thread-a' });
    const contextB = b.resolve({ threadId: 'thread-b' });

    assert.notEqual(contextA.dir, contextB.dir);
    assert.notEqual(contextA.queue, contextB.queue);

    contextA.queue.push({ taskId: 'shared-id', text: 'from A' });
    contextB.queue.push({ taskId: 'shared-id', text: 'from B' });

    assert.deepEqual(contextA.queue.list().map((r) => r.text), ['from A']);
    assert.deepEqual(contextB.queue.list().map((r) => r.text), ['from B']);
  } finally {
    cleanup();
  }
});
