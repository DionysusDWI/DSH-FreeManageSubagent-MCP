/** Whole-row DSH config overlays. A partial config would discard provider/model. */
import yaml from 'js-yaml';
import {normalizeTaskConfiguration} from './task-config.js';
export const SANDBOX_MODES = Object.freeze(['read-only', 'workspace-write']);
export const DEFAULT_SANDBOX_MODE = 'workspace-write';
export function normalizeSandboxMode(mode) {
  if (mode === undefined || mode === null || mode === '') return DEFAULT_SANDBOX_MODE;
  if (!SANDBOX_MODES.includes(mode)) throw new TypeError('sandbox_mode accepts read-only or workspace-write only; direct Full access is not exposed.');
  return mode;
}
export function approvalPolicyFor(mode) { normalizeSandboxMode(mode); return 'ask'; }
export function buildOverlayPatches(options) {
  for (const key of ['workspace','storageRoot','sessionRoot']) if (typeof options?.[key] !== 'string' || !options[key].trim()) throw new TypeError('buildOverlayPatches: '+key+' must be a non-empty string');
  const configuration = options.configuration ?? normalizeTaskConfiguration({sandbox_mode:options.sandboxMode, permission_mode:options.permissionMode,
    provider:options.provider, model:options.model, reasoning_effort:options.reasoningEffort,
    question_policy:options.questionPolicy, question_timeout_seconds:options.questionTimeoutSeconds});
  const config = configuration.resolved;
  const compression = options.sessionCompression ?? 'zstd';
  if (!['none','zstd'].includes(compression)) throw new TypeError('Unsupported native session compression.');
  // Auto is selected through permissionPresets.set after its official integration is ready.
  const initial = config.permissionMode === 'auto' ? 'workspace-write' : config.permissionMode;
  return [
    {id:'storage-json',config:{root:options.storageRoot}},
    {id:'session-persistence-jsonl',config:{root:options.sessionRoot,compression}},
    {id:'sandbox-policy',config:{mode:initial,workspaceRoot:options.workspace}},
    {id:'approval',config:{policy:'ask'}},
    {id:'permission',config:{defaultPreset:initial,presets:{
      'read-only':{sandbox:'read-only',approval:'ask'},
      'workspace-write':{sandbox:'workspace-write',approval:'ask'},
      // Required by native Auto disposal, not exposed by the bridge's selection API.
      'danger-full-access':{sandbox:'danger-full-access',approval:'never'},
    }}},
    {id:'agent-default-model',config:{provider:config.provider,model:config.model,...(config.reasoningEffort === null ? {} : {reasoningEffort:config.reasoningEffort})}},
    {id:'sdk-jsonrpc-server',config:{maxTokensAsSuccess:false}},
    {id:'tool-ask-user',config:{mode:'timed',timeout:config.questionPolicy === 'pause' ? -1 : config.questionTimeoutSeconds}},
  ];
}
export function serializeOverlay(patches) { return yaml.dump(patches,{forceQuotes:true,lineWidth:120,noRefs:true,sortKeys:false}); }
export function renderOverlay(options) { const patches=buildOverlayPatches(options); return {patches,yaml:serializeOverlay(patches)}; }
