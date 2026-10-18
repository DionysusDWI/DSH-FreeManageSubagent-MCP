/** Public task configuration. Native Full access is an implementation detail, not a selectable preset. */
export const PERMISSION_MODES = Object.freeze(['read-only', 'workspace-write', 'auto', 'inherit']);
export const UPSTREAM_PERMISSION_MODES = Object.freeze(['read-only', 'workspace-write', 'full-access']);
export const REASONING_EFFORTS = Object.freeze(['off', 'low', 'high', 'max']);
export const QUESTION_POLICIES = Object.freeze(['pause', 'continue']);
export const DEFAULT_ROUTE = Object.freeze({provider:'deepseek-official', model:'deepseek-flash'});
const fail = message => { throw new TypeError(message); };
export function normalizeTaskConfiguration(args = {}) {
  if (args.sandbox_mode !== undefined && args.permission_mode !== undefined) fail('sandbox_mode and permission_mode are mutually exclusive.');
  if (args.sandbox_mode !== undefined && !['read-only','workspace-write'].includes(args.sandbox_mode)) {
    fail('Direct Full access is not a public MCP option. Select permission_mode="auto" for native per-call review; legacy sandbox_mode accepts read-only or workspace-write only.');
  }
  const requestedPermission = args.permission_mode ?? args.sandbox_mode ?? 'workspace-write';
  if (!PERMISSION_MODES.includes(requestedPermission)) fail('permission_mode must be read-only, workspace-write, auto or inherit.');
  if (args.upstream_permission_mode !== undefined && !UPSTREAM_PERMISSION_MODES.includes(args.upstream_permission_mode)) fail('Invalid upstream_permission_mode declaration.');
  if (requestedPermission === 'inherit' && args.upstream_permission_mode === undefined) fail('inherit requires upstream_permission_mode (a caller declaration, not verified authorization).');
  const permission = requestedPermission === 'inherit'
    ? ({'read-only':'read-only','workspace-write':'workspace-write','full-access':'auto'})[args.upstream_permission_mode]
    : requestedPermission;
  if (Boolean(args.provider) !== Boolean(args.model)) fail('provider and model must be supplied together.');
  for (const key of ['provider','model']) if (args[key] !== undefined && (typeof args[key] !== 'string' || !args[key].trim() || args[key].includes('\0'))) fail('Invalid '+key+'.');
  if (args.reasoning_effort !== undefined && !REASONING_EFFORTS.includes(args.reasoning_effort)) fail('reasoning_effort must be off, low, high or max; log is not an alias.');
  const questionPolicy = args.question_policy ?? 'pause';
  if (!QUESTION_POLICIES.includes(questionPolicy)) fail('question_policy must be pause or continue.');
  if (questionPolicy === 'pause' && args.question_timeout_seconds !== undefined) fail('question_timeout_seconds is only valid with question_policy="continue".');
  const seconds = questionPolicy === 'continue' ? args.question_timeout_seconds ?? 120 : -1;
  if (!Number.isSafeInteger(seconds) || questionPolicy === 'continue' && (seconds < 1 || seconds > 2147483)) fail('question_timeout_seconds must be an integer from 1 to 2147483.');
  const route = {provider:args.provider ?? DEFAULT_ROUTE.provider, model:args.model ?? DEFAULT_ROUTE.model};
  return {
    requested:{...route, reasoningEffort:args.reasoning_effort ?? null, permissionMode:requestedPermission,
      upstreamPermissionMode:args.upstream_permission_mode ?? null, upstreamDeclarationVerified:false,
      questionPolicy, questionTimeoutSeconds:seconds === -1 ? null : seconds},
    resolved:{...route, reasoningEffort:args.reasoning_effort ?? null, permissionMode:permission,
      questionPolicy, questionTimeoutSeconds:seconds === -1 ? null : seconds},
  };
}
