/** Explicit no-model compatibility probe; never provisions the operator profile. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolveRuntime, assertCompatibleRuntime } from '../lib/dsh-profile.js';
import { supervise } from '../lib/supervisor.js';
import { repoRoot } from '../lib/paths.js';
import { resolveCredentialEnvironment } from '../lib/credential-environment.js';
const checkCredentials=process.argv.includes('--credentials');
if(process.argv.slice(2).some(arg=>arg!=='--credentials'))throw new Error('Usage: check-dsh-contract.js [--credentials] (no model requests).');
const runtime=resolveRuntime();assertCompatibleRuntime(runtime);
const credentials=checkCredentials?resolveCredentialEnvironment(runtime.env):null;
if(credentials && credentials.diagnosis.refs.some(ref=>!ref.present))throw new Error('Requested credential environment references are missing. Only presence was checked; no model was called.');if(!runtime.launcher.archive)throw new Error('This probe needs an installed desktop ASAR.');
const tempBase=path.resolve(os.tmpdir()),sandbox=fs.mkdtempSync(path.join(tempBase,'dsh-mcp-contract-'));
const controller=new AbortController(),timer=setTimeout(()=>controller.abort({kind:'timeout',message:'No-model DSH contract timed out'}),90000);
const metadata={launcher:runtime.launcher,version:runtime.version,launcherFingerprint:runtime.launcherFingerprint};
let stdout='',stderr='',treeExited=false;const ownedProcesses=[];
try {
  const result=await supervise({command:runtime.launcher.command,args:['--expose-internals',path.join(repoRoot(),'scripts','dsh-contract-child.mjs'),runtime.launcher.archive,sandbox,JSON.stringify(metadata),JSON.stringify(credentials?.diagnosis.refs.map(ref=>ref.name)??[])],cwd:repoRoot(),stateDir:sandbox,env:{...(credentials?.env??runtime.env),DSH_HOME:path.join(sandbox,'home')},signal:controller.signal,
    onStarted:event=>ownedProcesses.push(event),onStdout:chunk=>stdout+=chunk.toString('utf8'),onStderr:chunk=>stderr+=chunk.toString('utf8')});
  treeExited=result.treeExited===true;
  if(controller.signal.aborted)throw new Error(controller.signal.reason.message);
  if(result.code!==0)throw new Error(checkCredentials?'DSH credential contract failed. Raw output was withheld to protect credential values; no model was called.':'DSH no-model contract failed: '+stderr+'\n'+stdout);
  let parsed;try{parsed=JSON.parse(stdout.trim());}catch{throw new Error('DSH contract output was not valid JSON. Raw output was withheld.');}
  console.log(JSON.stringify({...parsed,...(credentials?{credentialEnvironment:credentials.diagnosis}:{}),treeExited,ownedProcesses}));
} catch(error) {
  treeExited ||= error.treeExited===true;
  if(!treeExited)console.error('Exit unconfirmed; isolated probe data retained: '+sandbox);
  throw error;
} finally {
  clearTimeout(timer);
  if(path.dirname(path.resolve(sandbox))!==tempBase || !path.basename(sandbox).startsWith('dsh-mcp-contract-'))throw new Error('Unsafe cleanup');
  if(treeExited)fs.rmSync(sandbox,{recursive:true,force:true});
}
