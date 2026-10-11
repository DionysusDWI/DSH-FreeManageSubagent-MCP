/** Explicit no-model compatibility probe; never provisions the operator profile. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolveRuntime, assertCompatibleRuntime } from '../lib/dsh-profile.js';
import { supervise } from '../lib/supervisor.js';
import { repoRoot } from '../lib/paths.js';
const runtime=resolveRuntime();assertCompatibleRuntime(runtime);if(!runtime.launcher.archive)throw new Error('This probe needs an installed desktop ASAR.');
const tempBase=path.resolve(os.tmpdir()),sandbox=fs.mkdtempSync(path.join(tempBase,'dsh-mcp-contract-'));
const controller=new AbortController(),timer=setTimeout(()=>controller.abort({kind:'timeout',message:'No-model DSH contract timed out'}),15000);
const metadata={launcher:runtime.launcher,version:runtime.version,launcherFingerprint:runtime.launcherFingerprint};
let stdout='',stderr='',treeExited=false;const ownedProcesses=[];
try {
  const result=await supervise({command:runtime.launcher.command,args:['--expose-internals',path.join(repoRoot(),'scripts','dsh-contract-child.mjs'),runtime.launcher.archive,sandbox,JSON.stringify(metadata)],cwd:repoRoot(),stateDir:sandbox,env:{...runtime.env,DSH_HOME:path.join(sandbox,'home')},signal:controller.signal,
    onStarted:event=>ownedProcesses.push(event),onStdout:chunk=>stdout+=chunk.toString('utf8'),onStderr:chunk=>stderr+=chunk.toString('utf8')});
  treeExited=result.treeExited===true;
  if(controller.signal.aborted)throw new Error(controller.signal.reason.message);
  if(result.code!==0)throw new Error('DSH no-model contract failed: '+stderr+'\n'+stdout);
  console.log(JSON.stringify({...JSON.parse(stdout.trim()),treeExited,ownedProcesses}));
} catch(error) {
  treeExited ||= error.treeExited===true;
  if(!treeExited)console.error('Exit unconfirmed; isolated probe data retained: '+sandbox);
  throw error;
} finally {
  clearTimeout(timer);
  if(path.dirname(path.resolve(sandbox))!==tempBase || !path.basename(sandbox).startsWith('dsh-mcp-contract-'))throw new Error('Unsafe cleanup');
  if(treeExited)fs.rmSync(sandbox,{recursive:true,force:true});
}
