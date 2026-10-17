/** Explicit, name-scoped credential inheritance. Secret values never enter diagnostics. */
import path from 'node:path';
import {spawnSync} from 'node:child_process';

export const CREDENTIAL_SOURCE_ENV = 'DSH_MCP_CREDENTIAL_ENV_SOURCE';
export const CREDENTIAL_REFS_ENV = 'DSH_MCP_CREDENTIAL_ENV_REFS';
const refPattern = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const reserved = /^(?:DSH(?:_|$)|CODEX(?:_|$)|NODE(?:_|$)|ELECTRON(?:_|$)|PATH$|PATHEXT$|COMSPEC$|SYSTEMROOT$|WINDIR$|HOME$|USERPROFILE$|APPDATA$|LOCALAPPDATA$|TEMP$|TMP$)/i;
const fail = (message, code='CREDENTIAL_ENV_CONFIG_INVALID') => Object.assign(new Error(message), {code});

export function credentialEnvironmentConfig(env = process.env) {
  const source = env[CREDENTIAL_SOURCE_ENV] ?? 'process';
  if (!['process', 'windows-user'].includes(source)) throw fail(CREDENTIAL_SOURCE_ENV+' must be process or windows-user.');
  const raw = env[CREDENTIAL_REFS_ENV];
  if (source === 'windows-user' && raw === undefined) throw fail('windows-user requires an explicit '+CREDENTIAL_REFS_ENV+' allowlist.');
  const refs = raw === undefined ? ['DEEPSEEK_API_KEY'] : typeof raw === 'string' ? raw.split(',').map(name => name.trim()) : [];
  if (!refs.length || refs.length > 16 || refs.some(name => !refPattern.test(name) || reserved.test(name)) || new Set(refs.map(name => name.toUpperCase())).size !== refs.length) {
    throw fail(CREDENTIAL_REFS_ENV+' must list 1–16 distinct credential references, not runtime/control variables.');
  }
  return {source, refs, explicitRefs:raw !== undefined};
}

/** Read exactly the requested Windows User variables. Do not enumerate the registry. */
export function readWindowsUserCredentials(refs, {timeoutMs=5000, spawnImpl=spawnSync} = {}) {
  // Validate even direct callers before constructing PowerShell code.
  credentialEnvironmentConfig({[CREDENTIAL_SOURCE_ENV]:'windows-user', [CREDENTIAL_REFS_ENV]:refs.join(',')});
  const script = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $values=@{}; " + refs.map(name => "$values['"+name+"']=[Environment]::GetEnvironmentVariable('"+name+"','User'); ").join('') + '$values | ConvertTo-Json -Compress';
  const command = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  let run;
  try {
    run = spawnImpl(command, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script,'utf16le').toString('base64')], {encoding:'utf8', windowsHide:true, timeout:Math.max(1,Math.min(5000,timeoutMs)), maxBuffer:1024*1024, stdio:['ignore','pipe','ignore']});
    if (run.error || run.status !== 0) throw new Error();
    const result = JSON.parse(run.stdout);
    if (!result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).some(name => !refs.includes(name))) throw new Error();
    for (const name of refs) if (!Object.hasOwn(result,name) || result[name] !== null && (typeof result[name] !== 'string' || result[name].includes('\0') || result[name].length > 32767)) throw new Error();
    return result;
  } catch {
    // Helper stdout can contain credentials; never include output or cause in an error.
    throw fail('The explicitly requested Windows User credential environment could not be read. No credentials were persisted or alternate provider selected.', 'CREDENTIAL_ENV_UNAVAILABLE');
  }
}

export function resolveCredentialEnvironment(source = process.env, {platform=process.platform, readUserImpl=readWindowsUserCredentials, timeoutMs} = {}) {
  const config = credentialEnvironmentConfig(source), env = {...source};
  if (config.source === 'windows-user' && platform !== 'win32') throw fail('windows-user credential inheritance is supported only on Windows.', 'CREDENTIAL_ENV_UNSUPPORTED');
  const keyFor = name => Object.keys(env).find(key => platform === 'win32' ? key.toUpperCase() === name.toUpperCase() : key === name);
  const missing = config.refs.filter(name => keyFor(name) === undefined);
  const imported = new Set();
  if (config.source === 'windows-user' && missing.length) {
    let values;
    try { values = readUserImpl(missing, {timeoutMs}); } catch { throw fail('The explicitly requested Windows User credential environment could not be read. No alternate provider was selected.', 'CREDENTIAL_ENV_UNAVAILABLE'); }
    for (const name of missing) {
      const value = values?.[name];
      if (value === null || value === undefined || value === '') continue;
      if (typeof value !== 'string' || value.includes('\0') || value.length > 32767) throw fail('Windows User credential data is invalid.', 'CREDENTIAL_ENV_UNAVAILABLE');
      env[name] = value; imported.add(name);
    }
  }
  const diagnosis = {mode:config.source, scope:'environment-presence-only', refs:config.refs.map(name => {
    const key = keyFor(name), present = key !== undefined && typeof env[key] === 'string' && env[key].length > 0;
    return {name, present, source:imported.has(name) ? 'windows-user' : key === undefined ? 'missing' : present ? 'process' : 'process-empty'};
  })};
  return {env, diagnosis};
}

export function diagnoseCredentialEnvironment(env, options) {
  try { return resolveCredentialEnvironment(env, options).diagnosis; }
  catch (error) { return {mode:['process','windows-user'].includes(env[CREDENTIAL_SOURCE_ENV]??'process')?(env[CREDENTIAL_SOURCE_ENV]??'process'):'invalid', scope:'environment-presence-only', error:{code:error.code, message:error.message}}; }
}
