import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {credentialEnvironmentConfig, resolveCredentialEnvironment, diagnoseCredentialEnvironment, readWindowsUserCredentials} from '../lib/credential-environment.js';
import {clientConfiguration} from '../lib/client-config.js';
import {runTask} from '../lib/task-runner.js';
import {taskPaths} from '../lib/paths.js';
import {writeJsonAtomic} from '../lib/io.js';
import {supervise} from '../lib/supervisor.js';
import {tempDir, isolatedEnv} from './helpers.js';
import {connect, call, text} from './mcp-helpers.js';

const userConfig = {DSH_MCP_CREDENTIAL_ENV_SOURCE:'windows-user', DSH_MCP_CREDENTIAL_ENV_REFS:'DEEPSEEK_API_KEY'};
const secret = 'synthetic-credential-never-use-as-a-real-api-key';
function fixture(t, label) {const temp=tempDir(label);t.after(temp.cleanup);return temp;}
function contents(dir) {
  const rows=[];
  function walk(base){for(const entry of fs.readdirSync(base,{withFileTypes:true})){const file=path.join(base,entry.name);if(entry.isDirectory())walk(file);else rows.push(fs.readFileSync(file,'utf8'));}}
  walk(dir);return rows.join('\n');
}

test('default credential environment inherits process only and never reads Windows User data', () => {
  let reads=0;const source={DEEPSEEK_API_KEY:secret},before={...source};
  const value=resolveCredentialEnvironment(source,{platform:'win32',readUserImpl(){reads++;}});
  assert.deepEqual(source,before);assert.equal(reads,0);assert.equal(value.env.DEEPSEEK_API_KEY,secret);
  assert.deepEqual(value.diagnosis.refs,[{name:'DEEPSEEK_API_KEY',present:true,source:'process'}]);
  assert.equal(JSON.stringify(value.diagnosis).includes(secret),false);
  assert.equal(resolveCredentialEnvironment({},{platform:'win32'}).diagnosis.refs[0].source,'missing');
});

test('Windows User credentials require an explicit narrow allowlist and cannot import runtime controls', () => {
  for(const env of [
    {DSH_MCP_CREDENTIAL_ENV_SOURCE:'windows-user'},
    {DSH_MCP_CREDENTIAL_ENV_SOURCE:'automatic'},
    {...userConfig,DSH_MCP_CREDENTIAL_ENV_REFS:''},
    {...userConfig,DSH_MCP_CREDENTIAL_ENV_REFS:'DEEPSEEK_API_KEY,deepseek_api_key'},
    ...['PATH','NODE_OPTIONS','ELECTRON_RUN_AS_NODE','DSH_HOME','USERPROFILE','TEMP',"KEY';Write-Host hacked;#"].map(ref=>({...userConfig,DSH_MCP_CREDENTIAL_ENV_REFS:ref})),
  ])assert.throws(()=>credentialEnvironmentConfig(env),{code:'CREDENTIAL_ENV_CONFIG_INVALID'});
  assert.throws(()=>resolveCredentialEnvironment(userConfig,{platform:'linux'}),{code:'CREDENTIAL_ENV_UNSUPPORTED'});
});

test('explicit Windows User lookup fills only missing references, reloads rotations and does not change source', () => {
  const source={...userConfig,OTHER_SECRET:'keep'},calls=[];let key=secret;
  const options={platform:'win32',readUserImpl:refs=>{calls.push(refs);return {DEEPSEEK_API_KEY:key,UNLISTED_SECRET:'never-import'};}};
  const first=resolveCredentialEnvironment(source,options);key='rotated-fixture';const second=resolveCredentialEnvironment(source,options);
  assert.deepEqual(calls,[['DEEPSEEK_API_KEY'],['DEEPSEEK_API_KEY']]);assert.equal(source.DEEPSEEK_API_KEY,undefined);
  assert.equal(first.env.DEEPSEEK_API_KEY,secret);assert.equal(second.env.DEEPSEEK_API_KEY,key);assert.equal(first.env.UNLISTED_SECRET,undefined);
  assert.deepEqual(first.diagnosis.refs,[{name:'DEEPSEEK_API_KEY',present:true,source:'windows-user'}]);
  assert.equal(JSON.stringify(first.diagnosis).includes(secret),false);
});

test('process values including an explicit blank override User lookup with Windows case folding', () => {
  for(const key of [secret,'']){
    const result=resolveCredentialEnvironment({...userConfig,deepseek_api_key:key},{platform:'win32',readUserImpl(){assert.fail('Must not override process intent');}});
    assert.equal(result.env.deepseek_api_key,key);assert.equal(result.env.DEEPSEEK_API_KEY,undefined);
    assert.equal(result.diagnosis.refs[0].source,key?'process':'process-empty');
  }
});

test('missing User references stay absent; malformed data and helper errors never expose a secret', () => {
  assert.equal(resolveCredentialEnvironment(userConfig,{platform:'win32',readUserImpl:()=>({DEEPSEEK_API_KEY:null})}).diagnosis.refs[0].source,'missing');
  for(const readUserImpl of [()=>{throw new Error(secret);},()=>({DEEPSEEK_API_KEY:{key:secret}}),()=>({DEEPSEEK_API_KEY:'unsafe\0value'})]){
    const result=diagnoseCredentialEnvironment(userConfig,{platform:'win32',readUserImpl});
    assert.equal(result.error.code,'CREDENTIAL_ENV_UNAVAILABLE');assert.equal(JSON.stringify(result).includes(secret),false);
  }
  assert.equal(JSON.stringify(diagnoseCredentialEnvironment({DSH_MCP_CREDENTIAL_ENV_SOURCE:secret})).includes(secret),false);
});

test('Windows User reader names only allowed refs, hides its window and suppresses secret error output', () => {
  const result=readWindowsUserCredentials(['DEEPSEEK_API_KEY'],{spawnImpl:(command,args,options)=>{
    assert.match(command,/WindowsPowerShell[\\/]v1.0[\\/]powershell.exe$/);assert.equal(options.windowsHide,true);assert.deepEqual(options.stdio,['ignore','pipe','ignore']);
    const script=Buffer.from(args.at(-1),'base64').toString('utf16le');assert.match(script,/GetEnvironmentVariable\('DEEPSEEK_API_KEY','User'\)/);assert.doesNotMatch(script,/GetEnvironmentVariables\(/);
    return {status:0,stdout:JSON.stringify({DEEPSEEK_API_KEY:secret})};
  }});assert.equal(result.DEEPSEEK_API_KEY,secret);
  for(const run of [{status:1,stdout:secret,stderr:secret},{status:0,stdout:secret},{status:0,stdout:JSON.stringify({DEEPSEEK_API_KEY:secret,EXTRA:secret})}]){
    assert.throws(()=>readWindowsUserCredentials(['DEEPSEEK_API_KEY'],{spawnImpl:()=>run}),error=>error.code==='CREDENTIAL_ENV_UNAVAILABLE'&&!error.message.includes(secret)&&error.cause===undefined);
  }
});

test('generated MCP configs carry only credential source and reference names, not credential values', () => {
  const value=clientConfiguration({env:{...process.env,DEEPSEEK_API_KEY:secret},format:'server-json',credentialEnvSource:'windows-user',credentialEnvRefs:'DEEPSEEK_API_KEY'});
  const server=JSON.parse(value);assert.equal(server.env.DSH_MCP_CREDENTIAL_ENV_SOURCE,'windows-user');assert.equal(server.env.DSH_MCP_CREDENTIAL_ENV_REFS,'DEEPSEEK_API_KEY');
  assert.equal(server.env.DEEPSEEK_API_KEY,undefined);assert.equal(value.includes(secret),false);
});

test('self-check diagnoses the bridge environment without starting tasks or initializing state', async t => {
  const temp=fixture(t,'credential-self-check'),env=isolatedEnv(temp.dir,{...userConfig});delete env.DEEPSEEK_API_KEY;
  const bridge=await connect({sourceEnv:{},env,stateRoot:path.join(temp.dir,'state'),credentialEnvironmentOptions:{platform:'win32',readUserImpl:()=>({DEEPSEEK_API_KEY:secret})}});
  t.after(()=>bridge.close());const report=text(await call(bridge.client,'dsh_self_check'));
  assert.match(report,/"source":"windows-user"/);assert.match(report,/not credential availability or authorization/);assert.match(report,/independent of Desktop profile/);assert.equal(report.includes(secret),false);
  assert.equal(fs.existsSync(path.join(temp.dir,'state')),false);assert.equal(bridge.scheduler.jobs.size,0);
});

test('task execution receives explicit User credentials without persisting a value or changing default model', async t => {
  const temp=fixture(t,'credential-runner'),paths=taskPaths('credential-scope','credential-task',path.join(temp.dir,'state'));
  const env=isolatedEnv(temp.dir,userConfig);delete env.DEEPSEEK_API_KEY;
  let observed,metadata;
  const value=await runTask({conversationKey:'credential-scope',taskId:'credential-task',paths,workspace:temp.dir,prompt:'Synthetic runner; no model.',
    runtime:{launcher:{command:process.execPath,prefixArgs:[],launcherScript:'not-a-real-cli'},home:path.join(temp.dir,'home'),version:'0.2.0-rc.2',env},
    credentialEnvironmentOptions:{platform:'win32',readUserImpl:()=>({DEEPSEEK_API_KEY:secret})},ensureProfileImpl:async()=>({name:'synthetic',fingerprint:'synthetic'}),onRuntime:r=>metadata=r,
    superviseImpl:async options=>{observed=options;assert.equal(options.env.DEEPSEEK_API_KEY,secret);writeJsonAtomic(path.join(paths.dir,'policy.json'),{version:2,conversationKey:'credential-scope',taskId:'credential-task',sessionId:'credential-session',agentId:'credential-session',agentRole:'main',workspace:temp.dir,sandboxMode:'workspace-write',approvalPolicy:'ask',verified:true});options.onStdout(Buffer.from(JSON.stringify({type:'session',sessionId:'credential-session',cwd:temp.dir})+'\n'+JSON.stringify({type:'final',text:'fixture-only'})+'\n'));return {code:0,treeExited:true};}});
  assert.equal(value.state,'completed');assert.equal(metadata.credentialEnvironment.refs[0].source,'windows-user');assert.equal(JSON.stringify(metadata).includes(secret),false);
  assert.equal(contents(temp.dir).includes(secret),false);assert.doesNotMatch(fs.readFileSync(paths.overlay,'utf8'),/agent-default-model/);assert.equal(env.DEEPSEEK_API_KEY,undefined);assert.ok(observed);
});

test('real Windows Guardian forwards a synthetic credential and evidence never stores it', {skip:process.platform!=='win32'}, async t => {
  const temp=fixture(t,'credential-guardian');let output='';
  const env={...process.env,...userConfig};for(const key of Object.keys(env))if(key.toUpperCase()==='DEEPSEEK_API_KEY')delete env[key];
  const resolved=resolveCredentialEnvironment(env,{readUserImpl:()=>({DEEPSEEK_API_KEY:secret})});
  const result=await supervise({command:process.execPath,args:['-e','if(process.env.DEEPSEEK_API_KEY!=="'+secret+'")process.exit(2);process.stdout.write("CREDENTIAL_TRANSIT_OK")'],cwd:temp.dir,stateDir:temp.dir,env:resolved.env,onStdout:b=>output+=b});
  assert.equal(result.code,0);assert.equal(result.treeExited,true);assert.equal(output,'CREDENTIAL_TRANSIT_OK');assert.equal(contents(temp.dir).includes(secret),false);
});
