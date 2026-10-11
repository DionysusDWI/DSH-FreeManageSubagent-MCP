/** Launch from outside the checkout, with ONLY bundled runtime/dependencies. NO model. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {verifyManifest} from './verify-manifest.js';
import {validatePackage} from './validate-package.js';
import {readIntegrityLabel} from '../lib/win-integrity.js';
export async function checkRelease(root) {
  root=path.resolve(root);validatePackage(root);const manifestProof=verifyManifest(root);
  const guardianLabel=readIntegrityLabel(path.join(root,'native','windows-job-host.exe'));
  const runtimeLabel=readIntegrityLabel(path.join(root,'runtime',process.platform==='win32'?'node.exe':'node'));
  const tempBase=path.resolve(os.tmpdir()),scratch=fs.mkdtempSync(path.join(tempBase,'dsh-mcp-release-'));
  if(path.dirname(scratch)!==tempBase)throw new Error('Unsafe release test path.');
  let transport,client;
  try {
    const isolated=path.join(scratch,'portable-plugin'),cwd=path.join(scratch,'empty-working-directory');
    fs.cpSync(root,isolated,{recursive:true,errorOnExist:true,force:false});fs.mkdirSync(cwd);
    const runtime=path.join(isolated,'runtime',process.platform==='win32'?'node.exe':'node');
    const env=Object.fromEntries(Object.entries(process.env).filter(([key,value])=>value!==undefined && !['NODE_PATH','NODE_OPTIONS','ELECTRON_RUN_AS_NODE'].includes(key)));
    for(const key of Object.keys(env))if(key.startsWith('CODEX_DSH')||['PLUGIN_ROOT','PLUGIN_DATA'].includes(key))delete env[key];
    env.DSH_MCP_STATE=path.join(scratch,'state');env.DSH_MCP_NAMESPACE='release-probe';
    transport=new StdioClientTransport({command:runtime,args:[path.join(isolated,'bin','dsh-mcp.js')],cwd,env,stderr:'pipe'});
    let stderr='';transport.stderr?.on('data',chunk=>{stderr=(stderr+chunk.toString('utf8')).slice(-8192);});
    client=new Client({name:'release-no-model-probe',version:'1.0.0'},{capabilities:{}});
    await client.connect(transport);const tools=await client.listTools({}, {timeout:10000});
    const names=tools.tools.map(t=>t.name).sort();
    if(JSON.stringify(names)!==JSON.stringify(['dsh_cancel','dsh_self_check','dsh_sessions','dsh_status','dsh_steer','dsh_task']))throw new Error('Packaged MCP tools missing. '+stderr);
    if(tools.tools.filter(t=>t.name!=='dsh_self_check').some(t=>!t.outputSchema))throw new Error('Packaged outputSchema missing.');
    const health=await client.callTool({name:'dsh_self_check',arguments:{}},{}, {timeout:10000});if(health.isError)throw new Error('Packaged self-check failed.');
    const sessions=await client.callTool({name:'dsh_sessions',arguments:{}},{},{timeout:10000});if(sessions.isError||sessions.structuredContent?.sessions?.length!==0)throw new Error('Packaged empty session catalog failed.');
    if(fs.existsSync(path.join(scratch,'state')))throw new Error('Read-only protocol checks initialized state.');
    return {manifestProof,externalCwd:true,readOnlyHealth:true,emptyManagedSessions:true,isolatedFromCheckoutDependencies:true,bundledRuntime:true,tools:names,modelCalls:0,guardianImageIntegrity:guardianLabel.level,guardianLabelVerified:guardianLabel.raw==='',runtimeImageIntegrity:runtimeLabel.level,runtimeLabelVerified:runtimeLabel.raw===''};
  } finally {
    await client?.close().catch(()=>{});await transport?.close().catch(()=>{});
    if(path.dirname(path.resolve(scratch))!==tempBase || !path.basename(scratch).startsWith('dsh-mcp-release-'))throw new Error('Unsafe release test cleanup.');
    fs.rmSync(scratch,{recursive:true,force:true});
  }
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if(!process.argv[2])throw new Error('Usage: node scripts/check-release.js <release-directory>');
  console.log(JSON.stringify(await checkRelease(process.argv[2]),null,2));
}
