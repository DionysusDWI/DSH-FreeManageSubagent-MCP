/**
 * Stream parsing: the bridge's view of a running task depends entirely on this
 * module, so the tests pin the event vocabulary and the failure modes.
 * @module test/dsh-stream.test
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { DshStreamParser, decodeLine, deriveOutcome, eventToReport, isReportable } from '../lib/dsh-stream.js';

/**
 * Collect everything a parser observes for one input string.
 * @param {string} input - raw stdout text.
 * @returns {object} captured callbacks.
 */
function parse(input) {
  const seen = { events: [], reports: [], malformed: [], session: null, finals: [], errors: [] };
  const parser = new DshStreamParser({
    onEvent: (event) => seen.events.push(event),
    onReport: (report) => seen.reports.push(report),
    onMalformed: (line) => seen.malformed.push(line),
    onSession: (sessionId, cwd) => { seen.session = { sessionId, cwd }; },
    onFinal: (outcome) => seen.finals.push(outcome),
    onError: (outcome) => seen.errors.push(outcome),
  });
  parser.write(input);
  parser.flush();
  return { parser, seen };
}

test('decodeLine rejects unusable input without throwing', () => {
  assert.equal(decodeLine(''), null);
  assert.equal(decodeLine('   '), null);
  assert.equal(decodeLine('not json'), null);
  assert.equal(decodeLine('[1,2]'), null);
  assert.equal(decodeLine('null'), null);
  assert.deepEqual(decodeLine('{"type":"text","text":"hi"}'), { type: 'text', text: 'hi' });
});

test('a real task transcript yields a session, reports, and a final answer', () => {
  const { parser, seen } = parse([
    '{"type":"session","sessionId":"session-1","cwd":"D:\\\\work"}',
    '{"type":"status","phase":"turn_start","turn":1}',
    '{"type":"thinking","text":"hmm"}',
    '{"type":"text","text":"looking at the parser"}',
    '{"type":"tool_call","callId":"c1","tool":"report","input":{"kind":"milestone","text":"read the parser","data":{"files":2}}}',
    '{"type":"tool_result","callId":"c1","status":"completed","result":"Reported."}',
    '{"type":"tool_call","callId":"c2","tool":"read_file","input":{"path":"a.js"}}',
    '{"type":"tool_result","callId":"c2","status":"completed","result":"contents"}',
    '{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}',
    '{"type":"final","text":"done"}',
    '',
  ].join('\n'));

  assert.deepEqual(seen.session, { sessionId: 'session-1', cwd: 'D:\\work' });
  assert.equal(parser.sessionId, 'session-1');
  assert.equal(parser.outcome.type, 'final');
  assert.equal(parser.outcome.text, 'done');
  assert.equal(parser.sawFinal, true);

  // Only the prose and the explicit report become reports; the read_file call does not.
  assert.equal(seen.reports.length, 2);
  assert.deepEqual(seen.reports[0], { kind: 'progress', text: 'looking at the parser', agentRole: 'main' });
  assert.deepEqual(seen.reports[1], {
    kind: 'milestone',
    text: 'read the parser',
    data: { files: 2 },
    agentRole: 'main',
  });
  assert.equal(seen.malformed.length, 0);
});

test('the session event is captured once even if repeated', () => {
  const { parser } = parse([
    '{"type":"session","sessionId":"session-1","cwd":"D:\\\\a"}',
    '{"type":"session","sessionId":"session-2","cwd":"D:\\\\b"}',
  ].join('\n'));
  assert.equal(parser.sessionId, 'session-1');
});

test('an event split across chunks is reassembled', () => {
  const { parser, seen } = parse('');
  parser.write('{"type":"text","te');
  parser.write('xt":"split"}');
  parser.write('\n');
  assert.deepEqual(seen.reports, [{ kind: 'progress', text: 'split', agentRole: 'main' }]);
});

test('a trailing line without a newline is handled by flush', () => {
  const { seen } = parse('{"type":"text","text":"no newline"}');
  assert.deepEqual(seen.reports, [{ kind: 'progress', text: 'no newline', agentRole: 'main' }]);
});

test('malformed lines are reported and skipped without losing later events', () => {
  const { seen } = parse([
    '{"type":"text","text":"first"}',
    'this is not json',
    '{"type":"text","text":"second"}',
  ].join('\n'));
  assert.equal(seen.malformed.length, 1);
  assert.deepEqual(seen.reports.map((report) => report.text), ['first', 'second']);
});

test('an empty text event produces no report', () => {
  const { seen } = parse('{"type":"text","text":"   "}\n');
  assert.equal(seen.reports.length, 0);
});

test('an error event is a terminal outcome', () => {
  const { parser, seen } = parse('{"type":"error","message":"boom"}\n');
  assert.equal(parser.sawError, true);
  assert.deepEqual(seen.errors, [{ type: 'error', message: 'boom' }]);
});

test('unknown event types pass through without breaking the stream', () => {
  const { seen } = parse([
    '{"type":"future-thing","payload":{"a":1}}',
    '{"type":"text","text":"still working"}',
  ].join('\n'));
  assert.equal(seen.events[0].type, 'future-thing');
  assert.deepEqual(seen.reports.map((report) => report.text), ['still working']);
});

test('reportability is limited to prose and explicit report calls', () => {
  assert.equal(isReportable({ type: 'text', raw: {} }), true);
  assert.equal(isReportable({ type: 'tool_call', raw: { tool: 'report' } }), true);
  assert.equal(isReportable({ type: 'tool_call', raw: { tool: 'run_tests' } }), false);
  assert.equal(isReportable({ type: 'thinking', raw: {} }), false);
  assert.equal(isReportable({ type: 'status', raw: {} }), false);
});

test('eventToReport tolerates malformed report arguments', () => {
  assert.equal(eventToReport({ type: 'tool_call', raw: { tool: 'report', input: 'not-an-object' } }).kind, 'progress');
  assert.equal(eventToReport({ type: 'tool_call', raw: { tool: 'report' } }).text, '');
  assert.equal(eventToReport({ type: 'thinking', raw: {} }), null);
});

test('outcome derivation trusts the exit code over the stream shape', () => {
  const completed = new DshStreamParser({});
  completed.write('{"type":"final","text":"ok"}\n');
  assert.equal(deriveOutcome({ parser: completed, exitCode: 0 }).state, 'completed');
  assert.equal(deriveOutcome({ parser: completed, exitCode: 0 }).answer, 'ok');

  // A well-formed stream still describes a failed run when the exit code says so.
  assert.equal(deriveOutcome({ parser: completed, exitCode: 1 }).state, 'failed');

  const errored = new DshStreamParser({});
  errored.write('{"type":"error","message":"nope"}\n');
  const derived = deriveOutcome({ parser: errored, exitCode: 1 });
  assert.equal(derived.state, 'failed');
  assert.equal(derived.reason.message, 'nope');

  const empty = new DshStreamParser({});
  assert.equal(deriveOutcome({ parser: empty, exitCode: 1 }).state, 'failed');
  assert.equal(deriveOutcome({ parser: empty, exitCode: 1 }).reason.kind, 'aborted');
  assert.equal(deriveOutcome({ parser: empty, exitCode: null, timedOut: true }).state, 'timeout');
  assert.equal(deriveOutcome({ parser: empty, exitCode: null, cancelled: true }).state, 'cancelled');

  // Cancellation outranks a timeout, because the caller chose to stop.
  assert.equal(deriveOutcome({ parser: empty, exitCode: null, timedOut: true, cancelled: true }).state, 'cancelled');
});

test('turn_end retains the real error even when DSH subsequently emits final',()=> {const p=new DshStreamParser();p.write(JSON.stringify({type:'status',phase:'turn_end',reason:{kind:'error',code:'QUOTA',message:'actual DSH reason'}})+'\n'+JSON.stringify({type:'final',text:''})+'\n');const r=deriveOutcome({parser:p,exitCode:1});assert.equal(r.reason.code,'QUOTA');assert.equal(r.reason.message,'actual DSH reason');});
test('an error before final cannot be mistaken for completion with exit zero',()=> {const p=new DshStreamParser();p.write('{"type":"error","message":"real failure"}\n{"type":"final","text":"partial"}\n');const r=deriveOutcome({parser:p,exitCode:0});assert.equal(r.state,'failed');assert.equal(r.reason.message,'real failure');});
test('canonical report mode ignores uncommitted or truncated stdout report tool input',()=> {const seen=[],p=new DshStreamParser({canonicalReports:true,onReport:r=>seen.push(r)});p.write('{"type":"tool_call","tool":"report","callId":"c","input":{"text":"truncated"}}\n');assert.equal(seen.length,0);});
