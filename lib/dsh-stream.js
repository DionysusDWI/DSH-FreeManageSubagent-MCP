import { StringDecoder } from 'node:string_decoder';
/**
 * Parser for the `dsh headless --json` newline-delimited event stream.
 *
 * The parser is deliberately tolerant: DSH may add event types in a future
 * release, so unknown types are passed through as `unknown` instead of failing a
 * running task. What it guarantees is the contract the bridge depends on — the
 * `session` event is captured exactly once, the terminal `final`/`error` outcome
 * is captured, and a malformed line never throws.
 * @module codex-dsh-mcp/dsh-stream
 */

/** Bridge-side report kind for each DSH stream event type. */
const REPORT_KIND_BY_EVENT = Object.freeze({
  text: 'progress',
});

/** The tool name the DSH-side plugin registers for agent-authored reports. */
export const REPORT_TOOL_NAME = 'report';

/** The tool name the DSH-side plugin registers for reading queued steering. */
export const INBOX_TOOL_NAME = 'check_inbox';

/** @typedef {object} DshStreamEvent
 * @property {string} type one of the DSH event types, or `unknown`.
 * @property {object} raw the original decoded object.
 */

/**
 * Decode one NDJSON line.
 * @param {string} line - raw line, with or without its terminator.
 * @returns {object | null} the decoded object, or null when unusable.
 */
export function decodeLine(line) {
  const trimmed = typeof line === 'string' ? line.trim() : '';
  if (trimmed === '') return null;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
}

/**
 * Normalize one decoded DSH event.
 * @param {object} raw - decoded event object.
 * @returns {DshStreamEvent} normalized event.
 */
export function normalizeEvent(raw) {
  const type = typeof raw.type === 'string' && raw.type !== '' ? raw.type : 'unknown';
  return { type, raw };
}

/**
 * Whether a stream event should become a model-facing report.
 *
 * Only the agent's own prose and its explicit `report` tool calls qualify. Every
 * other tool call is real work being done, and forwarding those would bury the
 * signal the caller asked for.
 * @param {DshStreamEvent} event - normalized event.
 * @returns {boolean} true when the event is reportable.
 */
export function isReportable(event) {
  if (event.type === 'text') return true;
  if (event.type === 'tool_call') return event.raw.tool === REPORT_TOOL_NAME;
  return false;
}

/**
 * Convert a reportable event into a report payload.
 * @param {DshStreamEvent} event - normalized reportable event.
 * @param {object} [context] - attribution context.
 * @param {string} [context.agentRole] - `main` when known.
 * @returns {{kind: string, text: string, data?: unknown, agentId?: string}|null} report payload, or null.
 */
export function eventToReport(event, context = {}) {
  if (event.type === 'text') {
    const text = typeof event.raw.text === 'string' ? event.raw.text : '';
    if (text.trim() === '') return null;
    return andRole({ kind: REPORT_KIND_BY_EVENT.text, text }, context);
  }

  if (event.type === 'tool_call' && event.raw.tool === REPORT_TOOL_NAME) {
    const input = event.raw.input !== null && typeof event.raw.input === 'object' && !Array.isArray(event.raw.input)
      ? event.raw.input
      : {};
    const text = typeof input.text === 'string' ? input.text : '';
    const kind = typeof input.kind === 'string' ? input.kind : 'progress';
    /** @type {{kind: string, text: string, data?: unknown}} */
    const payload = { kind, text };
    if (input.data !== undefined) payload.data = input.data;
    return andRole(payload, context);
  }

  return null;
}

/**
 * Attach optional attribution fields to a report payload.
 * @param {object} payload - report payload.
 * @param {object} context - attribution context.
 * @returns {object} the payload, possibly extended.
 */
function andRole(payload, context) {
  return context.agentRole === undefined ? payload : { ...payload, agentRole: context.agentRole };
}

/**
 * Incremental parser state for one DSH task's stdout.
 */
export class DshStreamParser {
  /**
   * @param {object} [options] - parser options.
   * @param {(event: DshStreamEvent) => void} [options.onEvent] - every normalized event.
   * @param {(line: string) => void} [options.onMalformed] - called for a line that is not JSON.
   * @param {(report: object) => void} [options.onReport] - called for each reportable event.
   * @param {(sessionId: string, cwd: string|undefined) => void} [options.onSession] - first `session` event.
   * @param {(outcome: object) => void} [options.onFinal] - terminal `final` event.
   * @param {(error: object) => void} [options.onError] - terminal `error` event.
   */
  constructor(options = {}) {
    this.onEvent = options.onEvent ?? (() => {});
    this.onMalformed = options.onMalformed ?? (() => {});
    this.onReport = options.onReport ?? (() => {});
    this.onSession = options.onSession ?? (() => {});
    this.onFinal = options.onFinal ?? (() => {});
    this.onError = options.onError ?? (() => {});

    this.buffer = '';
    this.decoder = new StringDecoder('utf8');
    this.canonicalReports = options.canonicalReports === true;
    this.errorOutcome = null; this.turnEndReason = null; this.maxLineBytes = options.maxLineBytes ?? 64 * 1024 * 1024;
    /** @type {string | null} */
    this.sessionId = null;
    /** @type {string | null} */
    this.cwd = null;
    /** @type {{type: string, text?: string, message?: string} | null} */
    this.outcome = null;
    this.sawFinal = false;
    this.sawError = false;
    this.malformedLines = 0;
    /** @type {Map<string, string>} callId -> tool name, for result correlation. */
    this.calls = new Map();
  }

  /**
   * Feed a chunk of stdout.
   * @param {string} chunk - decoded chunk.
   * @returns {void}
   */
  write(chunk) {
    if (Buffer.isBuffer(chunk)) chunk = this.decoder.write(chunk);
    if (typeof chunk !== 'string' || chunk === '') return;
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > this.maxLineBytes) throw new Error('DSH stream line exceeds safety limit; full output is retained in events.ndjson.');
    let index = this.buffer.indexOf('\n');
    while (index !== -1) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      this.#handleLine(line);
      index = this.buffer.indexOf('\n');
    }
  }

  /**
   * Flush a trailing line without a newline terminator.
   * @returns {void}
   */
  flush() {
    this.buffer += this.decoder.end();
    if (this.buffer.trim() === '') {
      this.buffer = '';
      return;
    }
    const line = this.buffer;
    this.buffer = '';
    this.#handleLine(line);
  }

  /**
   * Decode and dispatch one line.
   * @param {string} line - raw line.
   * @returns {void}
   */
  #handleLine(line) {
    const raw = decodeLine(line);
    if (raw === null) {
      if (line.trim() !== '') {
        this.malformedLines += 1;
        this.onMalformed(line);
      }
      return;
    }

    const event = normalizeEvent(raw);

    if (event.type === 'session') {
      if (this.sessionId === null) {
        this.sessionId = typeof raw.sessionId === 'string' ? raw.sessionId : null;
        this.cwd = typeof raw.cwd === 'string' ? raw.cwd : null;
        if (this.sessionId !== null) this.onSession(this.sessionId, this.cwd ?? undefined);
      }
      this.onEvent(event);
      return;
    }

    if (event.type === 'tool_call') {
      if (typeof raw.callId === 'string' && typeof raw.tool === 'string') this.calls.set(raw.callId, raw.tool);
      if(this.calls.size>4096) throw new Error('Too many unclosed DSH tool calls; stream correlation limit exceeded.');
    } else if (event.type === 'tool_result') {
      if (typeof raw.callId === 'string') this.calls.delete(raw.callId);
    }

    this.onEvent(event);

    if (event.type === 'status' && raw.phase === 'turn_end' && raw.reason?.kind && raw.reason.kind !== 'completed') this.turnEndReason = raw.reason;

    if (isReportable(event) && !(this.canonicalReports && event.type === 'tool_call')) {
      const report = eventToReport(event, { agentRole: 'main' });
      if (report !== null) this.onReport(report);
      return;
    }

    if (event.type === 'final') {
      const text = typeof raw.text === 'string' ? raw.text : '';
      this.sawFinal = true;
      this.outcome = { type: 'final', text };
      this.onFinal(this.outcome);
      return;
    }

    if (event.type === 'error') {
      const message = typeof raw.message === 'string' ? raw.message : 'unknown DSH error';
      this.sawError = true;
      this.outcome = { type: 'error', message };
      this.errorOutcome = this.outcome;
      this.onError(this.outcome);
    }
  }
}

/**
 * Derive a task's terminal state from a parsed stream plus the process exit code.
 *
 * The exit code is the authority, because a well-formed stream can still describe
 * a failed run: DSH emits a `final` event (often empty) for an in-turn failure.
 * @param {object} input - derivation input.
 * @param {DshStreamParser} input.parser - the parser that consumed the stream.
 * @param {number | null} input.exitCode - process exit code, or null when killed.
 * @param {boolean} [input.timedOut] - whether the bridge killed the task on timeout.
 * @param {boolean} [input.cancelled] - whether the bridge cancelled the task.
 * @returns {{state: string, answer: string, reason: object|null, exitCode: number|null}} derived outcome.
 */
export function deriveOutcome({ parser, exitCode, cancelled = false, timedOut = false }) {
  const answer = parser.sawFinal && parser.outcome?.type === 'final' ? parser.outcome.text : null;
  if (cancelled) return { state: 'cancelled', answer, reason: { kind: 'cancelled', message: 'Cancelled by the caller.' } };
  if (timedOut) return { state: 'timeout', answer, reason: { kind: 'timeout', message: 'Task deadline exceeded.' } };
  if (parser.turnEndReason) return { state: 'failed', answer, reason: parser.turnEndReason };
  if (parser.sawError) return { state: 'failed', answer, reason: { kind: 'error', message: parser.errorOutcome?.message ?? 'DSH reported an error' } };
  if (exitCode === 0 && parser.sawFinal) return { state: 'completed', answer, reason: { kind: 'completed' } };
  return { state: 'failed', answer, reason: { kind: 'aborted', message: 'DSH exited without successful completion (exit ' + exitCode + ').' } };
}
