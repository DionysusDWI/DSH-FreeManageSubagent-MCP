/**
 * End-to-end MCP flow: the real server, a real client, and a stubbed task runner.
 *
 * This exercises the parts that unit tests cannot: tool registration, argument
 * validation, conversation binding from request `_meta`, result rendering, and the
 * refusal to cross conversations.
 * @module test/mcp-flow.test
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';

import { createBridgeServer } from '../lib/server.js';
import { taskPaths, conversationDir } from '../lib/paths.js';
import { appendChannelRecord, channelPaths } from '../dsh-plugin/channel.js';
import { isolatedEnv, tempDir } from './helpers.js';

/**
 * Run one tool call, returning its text content.
 *
 * The call goes through `request` rather than `callTool` because the bridge reads
 * the Codex thread identity from the request's `_meta`, which only the raw request
 * path can carry.
 * @param {Client} client - connected client.
 * @param {string} name - tool name.
 * @param {object} args - tool arguments.
 * @param {object|null} meta - request `_meta`.
 * @returns {Promise<{text: string, isError: boolean, raw: object}>} the call result.
 */
async function call(client, name, args = {}, meta = null) {
  const result = await client.request(
    { method: 'tools/call', params: { name, arguments: args, ...(meta === null ? {} : { _meta: meta }) } },
    CallToolResultSchema,
  );
  const text = (result.content ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('\n');
  return { text, isError: result.isError === true, raw: result };
}

/**
 * Connect a client to a freshly built bridge server.
 *
 * The state root is passed explicitly rather than through `process.env`, so a test
 * file that mutates the environment cannot leak its state into this one.
 * @param {object} options - wiring options.
 * @param {NodeJS.ProcessEnv} options.env - environment.
 * @param {string} options.stateRoot - per-conversation state root.
 * @param {Function} [options.runTaskImpl] - task runner stub.
 * @returns {Promise<{client: Client, close: () => Promise<void>, diagnostics: string[]}>} connected pair.
 */
async function connect(options) {
  const { server, diagnostics } = createBridgeServer({
    env: options.env,
    stateRoot: options.stateRoot,
    runTaskImpl: options.runTaskImpl,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return {
    client,
    diagnostics,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/**
 * A task-runner stub that reports twice and completes.
 * @param {object} input - runner input.
 * @returns {Promise<object>} a settled task result.
 */
async function stubMediator(input) {
  input.onReport({ kind: 'progress', text: 'starting the parser work' });
  input.onReport({ kind: 'milestone', text: 'parser ported', agentId: 'child-1', agentRole: 'subagent' });
  return {
    taskId: input.taskId,
    conversationKey: input.conversationKey,
    state: 'completed',
    answer: 'the parser is ported',
    reason: { kind: 'completed' },
    exitCode: 0,
    sessionId: 'session-stub',
    cwd: input.workspace,
    adoptedSessionId: input.sessionId ?? null,
    workspace: input.workspace,
    sandboxMode: input.sandboxMode ?? 'workspace-write',
    durationMs: 12,
    reports: [],
    stderrTail: '',
    paths: { dir: '/tmp' },
  };
}

test('the tool surface is exactly the five documented tools', async () => {
  const { dir, cleanup } = tempDir('mcp-tools');
  try {
    const { client, close } = await connect({ env: isolatedEnv(dir), stateRoot: path.join(dir, 'state') });
    try {
      const { tools } = await client.listTools();
      assert.deepEqual(
        tools.map((tool) => tool.name).sort(),
        ['dsh_cancel', 'dsh_self_check', 'dsh_status', 'dsh_steer', 'dsh_task'],
      );
      for (const tool of tools) {
        assert.equal(typeof tool.description, 'string');
        assert.ok(tool.description.length > 20, `${tool.name} needs a real description`);
      }
    } finally {
      await close();
    }
  } finally {
    cleanup();
  }
});

test('a task runs, reports are returned, and status is readable', async () => {
  const { dir, cleanup } = tempDir('mcp-task');
  try {
    const { client, close } = await connect({ env: isolatedEnv(dir), stateRoot: path.join(dir, 'state'), runTaskImpl: stubMediator });
    try {
      const result = await call(client, 'dsh_task', { prompt: 'port the parser' }, { threadId: 'thread-1' });
      assert.equal(result.isError, false);
      assert.match(result.text, /completed in/);
      assert.match(result.text, /starting the parser work/);
      assert.match(result.text, /parser ported/);
      assert.match(result.text, /the parser is ported/);
      assert.match(result.text, /subagent/, 'a subagent report is attributed');

      const status = await call(client, 'dsh_status', {}, { threadId: 'thread-1' });
      assert.equal(status.isError, false);
      assert.match(status.text, /completed/);
      assert.match(status.text, /cursor: \d+/);
    } finally {
      await close();
    }
  } finally {
    cleanup();
  }
});

test('status returns only reports after the cursor', async () => {
  const { dir, cleanup } = tempDir('mcp-cursor');
  try {
    const { client, close } = await connect({ env: isolatedEnv(dir), stateRoot: path.join(dir, 'state'), runTaskImpl: stubMediator });
    try {
      await call(client, 'dsh_task', { prompt: 'work' }, { threadId: 'thread-1' });

      const all = await call(client, 'dsh_status', { cursor: 0 }, { threadId: 'thread-1' });
      const cursor = Number(/cursor: (\d+)/.exec(all.text)?.[1]);
      assert.ok(Number.isInteger(cursor) && cursor >= 2);

      const after = await call(client, 'dsh_status', { cursor }, { threadId: 'thread-1' });
      assert.match(after.text, /reports: none since the requested cursor/);
    } finally {
      await close();
    }
  } finally {
    cleanup();
  }
});

test('two servers bound to different threads never see each other', async () => {
  const { dir, cleanup } = tempDir('mcp-isolation');
  try {
    const env = isolatedEnv(dir);
    const stateRoot = path.join(dir, 'state');
    const a = await connect({ env, stateRoot, runTaskImpl: stubMediator });
    const b = await connect({ env, stateRoot, runTaskImpl: stubMediator });
    try {
      await call(a.client, 'dsh_task', { prompt: 'work for A' }, { threadId: 'thread-a' });
      await call(b.client, 'dsh_task', { prompt: 'work for B' }, { threadId: 'thread-b' });

      const statusA = await call(a.client, 'dsh_status', {}, { threadId: 'thread-a' });
      const statusB = await call(b.client, 'dsh_status', {}, { threadId: 'thread-b' });
      assert.match(statusA.text, /work|completed/);
      assert.match(statusB.text, /work|completed/);

      // Neither conversation's state directory exists under the other's key.
      const recentA = await call(a.client, 'dsh_self_check', {}, { threadId: 'thread-a' });
      assert.match(recentA.text, /conversation: thread-a/);
      assert.equal(recentA.text.includes('thread-b'), false);
    } finally {
      await a.close();
      await b.close();
    }
  } finally {
    cleanup();
  }
});

test('a call from a different thread is refused, not served', async () => {
  const { dir, cleanup } = tempDir('mcp-mismatch');
  try {
    const { client, close } = await connect({ env: isolatedEnv(dir), stateRoot: path.join(dir, 'state'), runTaskImpl: stubMediator });
    try {
      await call(client, 'dsh_task', { prompt: 'first' }, { threadId: 'thread-a' });
      const refused = await call(client, 'dsh_status', {}, { threadId: 'thread-b' });
      assert.equal(refused.isError, true);
      assert.match(refused.text, /Refusing to cross conversations/);
    } finally {
      await close();
    }
  } finally {
    cleanup();
  }
});

test('a task without a prompt is refused by input validation', async () => {
  const { dir, cleanup } = tempDir('mcp-validation');
  try {
    const { client, close } = await connect({ env: isolatedEnv(dir), stateRoot: path.join(dir, 'state'), runTaskImpl: stubMediator });
    try {
      const refused = await call(client, 'dsh_task', {}, { threadId: 'thread-1' });
      assert.equal(refused.isError, true);
      assert.match(refused.text, /input validation error/i);
      assert.match(refused.text, /prompt/);
    } finally {
      await close();
    }
  } finally {
    cleanup();
  }
});

test('steering reaches the task channel while the task is still running', async () => {
  const { dir, cleanup } = tempDir('mcp-steer');
  const stateRoot = path.join(dir, 'state');
  try {
    /** @type {() => void} */
    let release = () => {};
    const gate = new Promise((resolve) => { release = resolve; });
    /** @type {object|null} */
    let captured = null;

    /**
     * A runner that stays running until the test releases it.
     * @param {object} input - runner input.
     * @returns {Promise<object>} settled result.
     */
    const slowRunner = async (input) => {
      captured = input;
      input.onReport({ kind: 'progress', text: 'working' });
      await gate;
      return stubMediator({ ...input, signal: undefined });
    };

    const { client, close } = await connect({ env: isolatedEnv(dir), stateRoot, runTaskImpl: slowRunner });
    try {
      const dispatched = await call(client, 'dsh_task', { prompt: 'long job', background: true }, { threadId: 'thread-1' });
      assert.match(dispatched.text, /background/i);
      const taskId = /task (t-[\w-]+) in the background/.exec(dispatched.text)?.[1];
      assert.ok(taskId !== undefined, `background dispatch names its task: ${dispatched.text}`);

      // Wait for the runner to actually start before steering it.
      for (let attempt = 0; attempt < 40 && captured === null; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.ok(captured !== null, 'the background runner started');

      const steered = await call(client, 'dsh_steer', { message: 'use the staging database' }, { threadId: 'thread-1' });
      assert.equal(steered.isError, false);
      assert.match(steered.text, /Queued guidance/);

      // The guidance landed in this task's channel, addressed to it.
      const channel = channelPaths(taskPaths('thread-1', taskId, stateRoot).inbox).guidance;
      const records = fs.readFileSync(channel, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      const steer = records.find((record) => record.type === 'steer');
      assert.equal(steer.text, 'use the staging database');
      assert.equal(steer.seq, 1);

      release();
      // Let the background task settle before closing the server.
      for (let attempt = 0; attempt < 40 && captured !== null && captured.signal.aborted !== true; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        const settled = await call(client, 'dsh_status', { task_id: taskId }, { threadId: 'thread-1' });
        if (settled.text.includes('· completed')) break;
      }
    } finally {
      release();
      await close();
    }
  } finally {
    cleanup();
  }
});

test('the same update observed twice is published once', async () => {
  const { dir, cleanup } = tempDir('mcp-dedup');
  const stateRoot = path.join(dir, 'state');
  try {
    /**
     * A runner that reports one update through both paths at once: the live stream
     * callback, and the channel file the plugin appends to.
     * @param {object} input - runner input.
     * @returns {Promise<object>} settled result.
     */
    const doubleReportingRunner = async (input) => {
      input.onReport({ eventId: 'stable-main-call', kind: 'milestone', text: 'phase-one-done' });
      appendChannelRecord(path.join(input.paths.dir, 'inbox.json'), {
        type: 'report',
        eventId: 'stable-main-call',
        taskId: input.taskId,
        kind: 'milestone',
        text: 'phase-one-done',
        agentId: 'session-stub',
        agentRole: 'main',
        ts: Date.now(),
      });
      return stubMediator(input);
    };

    // The stub names its own paths; give it the real task directory.
    const runner = async (input) => doubleReportingRunner({
      ...input,
      paths: taskPaths('thread-dedup', input.taskId, stateRoot),
    });

    const { client, close } = await connect({ env: isolatedEnv(dir), stateRoot, runTaskImpl: runner });
    try {
      const result = await call(client, 'dsh_task', { prompt: 'work' }, { threadId: 'thread-dedup' });
      const status = await call(client, 'dsh_status', { cursor: 0 }, { threadId: 'thread-dedup' });

      const occurrences = status.text.split('phase-one-done').length - 1;
      assert.equal(occurrences, 1, `the update appears once, not twice:\n${status.text}`);
      assert.equal(result.isError, false);
    } finally {
      await close();
    }
  } finally {
    cleanup();
  }
});

test('cancelling a settled task is a no-op, not an error', async () => {
  const { dir, cleanup } = tempDir('mcp-cancel');
  try {
    const { client, close } = await connect({ env: isolatedEnv(dir), stateRoot: path.join(dir, 'state'), runTaskImpl: stubMediator });
    try {
      await call(client, 'dsh_task', { prompt: 'quick' }, { threadId: 'thread-1' });
      const cancelled = await call(client, 'dsh_cancel', {}, { threadId: 'thread-1' });
      assert.equal(cancelled.isError, false);
      assert.match(cancelled.text, /no running process to stop/);
    } finally {
      await close();
    }
  } finally {
    cleanup();
  }
});

test('self check reports the binding and resolves without DSH installed', async () => {
  const { dir, cleanup } = tempDir('mcp-selfcheck');
  try {
    const { client, close } = await connect({ env: isolatedEnv(dir), stateRoot: path.join(dir, 'state') });
    try {
      const result = await call(client, 'dsh_self_check', {}, { threadId: 'thread-self', sessionId: 'session-self' });
      assert.equal(result.isError, false);
      assert.match(result.text, /conversation: thread-self/);
      assert.match(result.text, /codex threadId: thread-self/);
      assert.match(result.text, /codex sessionId: session-self/);
      assert.match(result.text, /state directory: /);
      assert.match(result.text, /profile ready: /);
    } finally {
      await close();
    }
  } finally {
    cleanup();
  }
});

test('tasks are recorded per conversation on disk', async () => {
  const { dir, cleanup } = tempDir('mcp-store');
  const stateRoot = path.join(dir, 'state');
  try {
    const { client, close } = await connect({ env: isolatedEnv(dir), stateRoot, runTaskImpl: stubMediator });
    try {
      await call(client, 'dsh_task', { prompt: 'recorded' }, { threadId: 'thread-record' });
      const result = await call(client, 'dsh_self_check', {}, { threadId: 'thread-record' });
      const reported = /state directory: (.+)/.exec(result.text)?.[1]?.trim();
      assert.equal(reported, conversationDir('thread-record', stateRoot));
      assert.match(result.text, /recent tasks: t-/);

      // The record really is on disk under this conversation, and only this one.
      const record = path.join(conversationDir('thread-record', stateRoot), 'tasks.json');
      assert.equal(fs.existsSync(record), true);
      assert.equal(fs.existsSync(conversationDir('thread-other', stateRoot)), false);
    } finally {
      await close();
    }
  } finally {
    cleanup();
  }
});
