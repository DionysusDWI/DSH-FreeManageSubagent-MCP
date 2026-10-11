/** Deployment configuration only: no client or chat metadata participates in ownership. */
import path from 'node:path';
export const LEGACY_ALIASES=Object.freeze({CODEX_DSH_MCP_STATE:'DSH_MCP_STATE',CODEX_DSH_MCP_DSH:'DSH_MCP_DSH',CODEX_DSH_MCP_WORKSPACE:'DSH_MCP_WORKSPACE',CODEX_DSH_CSC:'DSH_MCP_CSC',CODEX_DSH_MCP_BUILD_STAGE:'DSH_MCP_BUILD_STAGE',CODEX_DSH_MCP_RELEASE_STAGE:'DSH_MCP_RELEASE_STAGE'});
export function runtimeEnv(source=process.env){
 const env={...source};for(const [old,name] of Object.entries(LEGACY_ALIASES)){if(env[old]===undefined)continue;const value=env[old];if(typeof value!=='string'||!value.trim())throw Object.assign(new Error('Empty deprecated configuration: '+old),{code:'CONFIG_CONFLICT'});if(env[name]!==undefined&&env[name]!==value)throw Object.assign(new Error('Conflicting configuration: '+name+' and '+old),{code:'CONFIG_CONFLICT'});if(env[name]===undefined)env[name]=value;}
 // These old flags are deliberately not aliases, even if present in a parent environment.
 for(const key of Object.keys(env))if(key.startsWith('CODEX_DSH')&&!Object.keys(LEGACY_ALIASES).includes(key))delete env[key];
 for(const [key,value] of Object.entries(env))if(key.startsWith('DSH_MCP_')&&(typeof value!=='string'||value.includes('\0')))throw new TypeError('Invalid environment value: '+key);
 return env;
}
export function deploymentNamespace(env=process.env){const name=runtimeEnv(env).DSH_MCP_NAMESPACE??'local';if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name))throw new TypeError('DSH_MCP_NAMESPACE must be 1–128 ASCII letters, digits, dots, underscores or hyphens, starting with a letter or digit.');return name;}
export function absoluteInstallRoot(value){const root=path.resolve(value);if(root.includes('\0'))throw new TypeError('Invalid installation path.');return root;}
