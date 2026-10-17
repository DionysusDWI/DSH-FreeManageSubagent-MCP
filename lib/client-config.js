/** Emit portable client configuration using real absolute install paths; never edit a client. */
import fs from 'node:fs';import path from 'node:path';import {credentialEnvironmentConfig,CREDENTIAL_SOURCE_ENV,CREDENTIAL_REFS_ENV} from './credential-environment.js';import {repoRoot,stateRoot} from './paths.js';import {runtimeEnv,deploymentNamespace} from './config.js';
export function clientConfiguration({root=repoRoot(),env=process.env,namespace,state,dsh,dshHome,credentialEnvSource,credentialEnvRefs,format='mcp-json'}={}){
 env=runtimeEnv(env);root=fs.realpathSync.native(path.resolve(root));const entry=path.join(root,'bin','dsh-mcp.js');if(!fs.statSync(entry).isFile())throw new Error('Installed dsh-mcp entry is missing.');
 const bundled=path.join(root,'runtime',process.platform==='win32'?'node.exe':'node'),command=fs.existsSync(bundled)?fs.realpathSync.native(bundled):fs.realpathSync.native(process.execPath);
 const variables={DSH_MCP_NAMESPACE:namespace??deploymentNamespace(env),DSH_MCP_STATE:path.resolve(state??stateRoot(env))};deploymentNamespace(variables);
 if(dsh!==undefined)variables.DSH_MCP_DSH=path.resolve(dsh);else if(env.DSH_MCP_DSH)variables.DSH_MCP_DSH=path.resolve(env.DSH_MCP_DSH);
 if(dshHome!==undefined)variables.DSH_HOME=path.resolve(dshHome);else if(env.DSH_HOME)variables.DSH_HOME=path.resolve(env.DSH_HOME);
 const credentialEnv={...env,...(credentialEnvSource===undefined?{}:{[CREDENTIAL_SOURCE_ENV]:credentialEnvSource}),...(credentialEnvRefs===undefined?{}:{[CREDENTIAL_REFS_ENV]:credentialEnvRefs})};
 credentialEnvironmentConfig(credentialEnv);
 for(const key of [CREDENTIAL_SOURCE_ENV,CREDENTIAL_REFS_ENV])if(credentialEnv[key]!==undefined)variables[key]=credentialEnv[key];
 const server={command,args:[entry],env:variables};
 if(format==='server-json')return JSON.stringify(server,null,2)+'\n';
 if(format==='mcp-json')return JSON.stringify({mcpServers:{'dsh-mcp':server}},null,2)+'\n';
 if(format==='toml'){const lines=['[mcp_servers."dsh-mcp"]','command = '+JSON.stringify(command),'args = '+JSON.stringify(server.args),'','[mcp_servers."dsh-mcp".env]'];for(const [key,value] of Object.entries(variables))lines.push(key+' = '+JSON.stringify(value));return lines.join('\n')+'\n';}
 throw new TypeError('format must be server-json, mcp-json or toml.');
}
