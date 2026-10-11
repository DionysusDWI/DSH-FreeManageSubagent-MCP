/** No-model token/state/integrity preflight. Does not alter ACLs, labels or installed DSH. */
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {repoRoot} from '../lib/paths.js';import {processAlive} from '../lib/file-lock.js';
import {supervise} from '../lib/supervisor.js';import {createChannel} from '../dsh-plugin/channel.js';
import {readIntegrityLabel,readTokenIntegrity,guardianRefusal} from '../lib/win-integrity.js';
export async function checkGuardian(options={}) {
 const base=path.resolve(options.base ?? os.tmpdir()),dir=fs.mkdtempSync(path.join(base,'dsh-mcp-guardian-')),channel=path.join(dir,'inbox.json'),owner=options.owner ?? {conversationKey:'guardian-probe',taskId:'guardian-probe'};
 const helper=path.join(repoRoot(),'native','windows-job-host.exe'),token=readTokenIntegrity(),image=readIntegrityLabel(helper),state=readIntegrityLabel(dir);
 let confirmed=false;try {
  // Report the exact cause instead of the downstream write failure: a Low-labeled
  // guardian image is started at Low integrity by Windows and can never write an
  // ordinary (Medium) task-state directory.
  const refusal=process.platform==='win32'?guardianRefusal(image,helper,dir):null;if(refusal)throw refusal;
  createChannel(channel,owner);let stdout='',started=null;const marker=path.join(dir,'node-write-probe.txt');
  const exit=await supervise({command:process.execPath,args:['-e','require("node:fs").writeFileSync('+JSON.stringify(marker)+',"guardian-ok");process.stdout.write("guardian-ok")'],cwd:dir,env:process.env,channel,owner,signal:options.signal,onStarted:e=>{started=e;},onStdout:b=>stdout+=b.toString('utf8')});
  confirmed=exit.treeExited===true;if(exit.code!==0||stdout!=='guardian-ok'||!confirmed||fs.readFileSync(marker,'utf8')!=='guardian-ok')throw Object.assign(new Error('Guardian no-model probe did not settle correctly.'),{treeExited:confirmed});
  const processPids=[...new Set([started?.pid,started?.workerPid,started?.guardianPid].filter(Number.isInteger))],processExit=processPids.map(pid=>({pid,alive:processAlive(pid)}));if(!processPids.length||processExit.some(p=>p.alive!==false))throw Object.assign(new Error('Probe process exit is unknown; evidence retained.'),{treeExited:false});
  return {stateWritable:true,childWrote:true,treeExited:true,processPids,processExit,modelCalls:0,helper,imageIntegrity:image.level,tokenIntegrity:token.level,stateDir:dir,stateDirLabel:state.level};
 } catch(error) { if(error.treeExited===false)confirmed=false;else if(error.treeExited===true||String(error.message).includes('No DSH process was launched'))confirmed=true;error.treeExited=confirmed;throw error; }
 finally {if(confirmed){if(path.dirname(path.resolve(dir))!==base||!path.basename(dir).startsWith('dsh-mcp-guardian-'))throw new Error('Unsafe probe cleanup');fs.rmSync(dir,{recursive:true,force:true});}else console.error('Unconfirmed probe state preserved: '+dir);}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){try{console.log(JSON.stringify(await checkGuardian(),null,2));}catch(error){console.error((error.code?error.code+': ':'')+error.message);process.exitCode=1;}}
