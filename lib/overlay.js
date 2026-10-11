/**
 * Per-task DSH loader-patch overlay.
 *
 * Each task gets its own overlay file so that nothing about one task is reachable
 * from another: the projection-cache root, session-log root, sandbox root, and
 * selected model are all stated per task rather than inherited from a shared
 * profile. Every value is written as a YAML literal — no `!!js` expressions — so a
 * path containing spaces, backslashes, or quotes cannot change what the loader
 * evaluates.
 * @module codex-dsh-mcp/overlay
 */

import yaml from 'js-yaml';

/** Sandbox modes DSH accepts, strongest last. */
export const SANDBOX_MODES = Object.freeze(['read-only', 'workspace-write', 'danger-full-access']);

/** Default sandbox mode: writes allowed inside the task workspace, escalation asks. */
export const DEFAULT_SANDBOX_MODE = 'workspace-write';

/**
 * Whether a value is a non-empty string.
 * @param {unknown} value - candidate.
 * @returns {boolean} true when usable.
 */
function isFilledString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Normalize a requested sandbox mode.
 * @param {unknown} mode - requested mode.
 * @returns {string} a member of {@link SANDBOX_MODES}.
 * @throws {TypeError} when the mode is present but not recognized.
 */
export function normalizeSandboxMode(mode) {
  if (mode === undefined || mode === null || mode === '') return DEFAULT_SANDBOX_MODE;
  if (typeof mode !== 'string' || !SANDBOX_MODES.includes(mode)) {
    throw new TypeError(`sandbox_mode must be one of ${SANDBOX_MODES.join(', ')}; received ${JSON.stringify(mode)}`);
  }
  return mode;
}

/**
 * The approval policy that pairs with a sandbox mode.
 *
 * `danger-full-access` pairs with `never` so an unattended task cannot stall on a
 * prompt nobody can answer; every narrower mode keeps `ask`.
 * @param {string} sandboxMode - normalized sandbox mode.
 * @returns {'ask'|'never'} approval policy.
 */
export function approvalPolicyFor(sandboxMode) {
  return sandboxMode === 'danger-full-access' ? 'never' : 'ask';
}

/**
 * Build the overlay patch list for one task.
 *
 * @param {object} options - task options.
 * @param {string} options.workspace - absolute workspace path the sandbox is rooted at.
 * @param {string} options.storageRoot - per-task projection-cache root.
 * @param {string} options.sessionRoot - per-task session-log root.
 * @param {string} [options.sandboxMode] - sandbox mode, defaults to `workspace-write`.
 * @param {string} [options.provider] - LLM provider id; requires `model`.
 * @param {string} [options.model] - LLM model id; requires `provider`.
 * @returns {object[]} loader patch entries.
 * @throws {TypeError} when a required path is missing or a model pair is half-specified.
 */
export function buildOverlayPatches(options) {
  if (!isFilledString(options?.workspace)) throw new TypeError('buildOverlayPatches: workspace must be a non-empty string');
  if (!isFilledString(options?.storageRoot)) throw new TypeError('buildOverlayPatches: storageRoot must be a non-empty string');
  if (!isFilledString(options?.sessionRoot)) throw new TypeError('buildOverlayPatches: sessionRoot must be a non-empty string');

  const sandboxMode = normalizeSandboxMode(options.sandboxMode);
  const hasProvider = isFilledString(options.provider);
  const hasModel = isFilledString(options.model);
  if (hasProvider !== hasModel) {
    throw new TypeError('buildOverlayPatches: provider and model must be supplied together');
  }

  /** @type {object[]} */
  const patches = [
    // Keep the projection cache out of the shared storage root: two concurrent
    // DSH processes writing one JSON storage unit have no cross-process locking.
    { id: 'storage-json', config: { root: options.storageRoot } },
    // Keep session logs task-local so concurrent tasks never contend on one root.
    { id: 'session-persistence-jsonl', config: { root: options.sessionRoot } },
    { id: 'sandbox-policy', config: { mode: sandboxMode, workspaceRoot: options.workspace } },
    { id: 'approval', config: { policy: approvalPolicyFor(sandboxMode) } },
    { id: 'permission', config: { defaultPreset: sandboxMode, presets: {
      'read-only': { sandbox: 'read-only', approval: 'ask' },
      'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
      'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
    } } },
  ];

  if (hasProvider) {
    patches.push({ id: 'agent-default-model', config: { provider: options.provider, model: options.model } });
  }

  return patches;
}

/**
 * Serialize a patch list as overlay YAML.
 *
 * `forceQuotes` keeps every scalar a string literal, which is what makes a value
 * such as `read-only` or `C:\a b\c` inert rather than a YAML type or an escape.
 * @param {object[]} patches - loader patch entries.
 * @returns {string} YAML document text.
 */
export function serializeOverlay(patches) {
  return yaml.dump(patches, {
    forceQuotes: true,
    lineWidth: 120,
    noRefs: true,
    sortKeys: false,
  });
}

/**
 * Build and serialize one task's overlay in a single call.
 * @param {object} options - see {@link buildOverlayPatches}.
 * @returns {{patches: object[], yaml: string}} the patch list and its serialization.
 */
export function renderOverlay(options) {
  const patches = buildOverlayPatches(options);
  return { patches, yaml: serializeOverlay(patches) };
}
