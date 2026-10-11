/**
 * The steering protocol shared by the bridge and the DSH plugin.
 *
 * The property that matters is at-most-once delivery: guidance must reach the agent
 * exactly once even across a DSH restart, and an empty channel must be cheap.
 * @module test/channel.test
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  appendChannelRecord,
  channelReportToPayload,
  drainSteering,
  highestSteerSeq,
  readChannelRecords,
} from '../dsh-plugin/channel.js';
import { appendSteering } from '../lib/task-runner.js';
import { tempDir } from './helpers.js';

test('a missing channel file reads as empty', () => {
  const { dir, cleanup } = tempDir('channel-missing');
  try {
    assert.deepEqual(readChannelRecords(path.join(dir, 'nope.ndjson')), []);
    assert.deepEqual(drainSteering(path.join(dir, 'nope.ndjson')), []);
  } finally {
    cleanup();
  }
});

test('torn lines are skipped without losing later records', () => {
  const { dir, cleanup } = tempDir('channel-torn');
  try {
    const file = path.join(dir, 'c.ndjson');
    fs.writeFileSync(file, [
      '{"type":"report","text":"first"}',
      '{"type":"report","text":"ab',
      '{"type":"report","text":"second"}',
      '',
    ].join('\n'), 'utf8');

    assert.deepEqual(readChannelRecords(file).map((record) => record.text), ['first', 'second']);
  } finally {
    cleanup();
  }
});

test('steering is delivered once and then marked delivered', () => {
  const { dir, cleanup } = tempDir('channel-steer');
  try {
    const file = path.join(dir, 'c.ndjson');
    appendChannelRecord(file, { type: 'steer', seq: 1, text: 'use the staging database', ts: 1 });
    appendChannelRecord(file, { type: 'steer', seq: 2, text: 'and skip the migration', ts: 2 });

    const first = drainSteering(file);
    assert.deepEqual(first.map((message) => message.text), ['use the staging database', 'and skip the migration']);

    // A second read finds nothing: the cursor survived the drain.
    assert.deepEqual(drainSteering(file), []);

    // New guidance after the cursor is delivered.
    appendChannelRecord(file, { type: 'steer', seq: 3, text: 'third', ts: 3 });
    assert.deepEqual(drainSteering(file).map((message) => message.text), ['third']);

    assert.equal(highestSteerSeq(readChannelRecords(file)), 3);
  } finally {
    cleanup();
  }
});

test('an empty-text steering record is not delivered', () => {
  const { dir, cleanup } = tempDir('channel-empty-steer');
  try {
    const file = path.join(dir, 'c.ndjson');
    appendChannelRecord(file, { type: 'steer', seq: 1, text: '', ts: 1 });
    assert.deepEqual(drainSteering(file), []);
  } finally {
    cleanup();
  }
});

test('reports and steering coexist in one channel without confusing either direction', () => {
  const { dir, cleanup } = tempDir('channel-mixed');
  try {
    const file = path.join(dir, 'c.ndjson');
    appendChannelRecord(file, { type: 'report', taskId: 't1', kind: 'progress', text: 'working', ts: 1 });
    appendChannelRecord(file, { type: 'steer', seq: 1, text: 'guidance', ts: 2 });
    appendChannelRecord(file, { type: 'report', taskId: 't1', kind: 'final', text: 'done', ts: 3 });

    assert.deepEqual(drainSteering(file).map((message) => message.text), ['guidance']);

    const reports = readChannelRecords(file)
      .map((record) => channelReportToPayload(record))
      .filter((payload) => payload !== null);
    assert.deepEqual(reports.map((report) => report.kind), ['progress', 'final']);
    assert.equal(reports[0].taskId, undefined, 'the report payload does not leak protocol fields');
  } finally {
    cleanup();
  }
});

test('channelReportToPayload normalizes and rejects', () => {
  assert.equal(channelReportToPayload({ type: 'steer', seq: 1, text: 'x' }), null);
  assert.equal(channelReportToPayload(null), null);

  const payload = channelReportToPayload({
    type: 'report',
    kind: 'blocker',
    text: 'stuck',
    data: { needs: 'credentials' },
    agentId: 'session-1',
    agentRole: 'main',
    ts: 42,
  });
  assert.deepEqual(payload, {
    kind: 'blocker',
    text: 'stuck',
    data: { needs: 'credentials' },
    agentId: 'session-1',
    agentRole: 'main',
    ts: 42,
  });
});

test('the bridge steering writer assigns increasing sequences', () => {
  const { dir, cleanup } = tempDir('channel-writer');
  try {
    const stateRoot = path.join(dir, 'state');
    const first = appendSteering('thread-a', 'task-1', 'first', stateRoot);
    const second = appendSteering('thread-a', 'task-1', 'second', stateRoot);
    assert.equal(first.seq, 1);
    assert.equal(second.seq, 2);
    assert.deepEqual(drainSteering(first.path).map((message) => message.text), ['first', 'second']);
    assert.throws(() => appendSteering('thread-a', 'task-1', '   ', stateRoot), TypeError);
  } finally {
    cleanup();
  }
});
