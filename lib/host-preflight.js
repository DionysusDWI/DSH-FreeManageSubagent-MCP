/** Private smoke4-only, zero-model host token/state and >=45s RPC diagnostic. */
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {performance} from 'node:perf_hooks';
import {taskPathsIn} from './paths.js';import {createTaskId} from './store.js';
import {checkGuardian} from '../scripts/check-guardian.js';
export const HOST_RPC_PROBE_MS=45000;
const abortIf=signal=>{if(signal?.aborted)throw Object.assign(new Error('Host preflight aborted/cancelled; no model was launched.'),{code:'ACCEPTANCE_PREFLIGHT_CANCELLED'});};
function noLinks(dir){for(let p=path.resolve(dir);;p=path.dirname(p)){if(fs.existsSync(p)&&fs.lstatSync(p).isSymbolicLink())throw new Error('Linked host state refused: '+p);if(path.dirname(p)===p)break;}}
export async function runHostPreflight({ctx,control,signal,correlationId},{probe=checkGuardian,now=()=>performance.now(),wait=(ms,s)=>delay(ms+10,undefined,{signal:s})}={}){
 if(control?.suite!=='smoke4'||control.hostPreflight!==true)return null;
 abortIf(signal);
 if(ctx.source!=='_meta.threadId'||!ctx.threadId||ctx.threadId!==ctx.key)throw new Error('Actual host thread metadata is required for the zero-model probe.');
 if(path.resolve(path.dirname(ctx.dir))!==path.resolve(control.stateRoot))throw new Error('Host probe state-root drift.');
 noLinks(ctx.dir);
 const started=now(),parent=path.join(ctx.dir,'probes'),representative=taskPathsIn(ctx.dir,createTaskId()).dir;
 const length=representative.length-parent.length-1,name=('p-'+crypto.randomBytes(12).toString('hex')).padEnd(length,'x');
 if(name.length!==length)throw new Error('Representative task-path layout is too short for a unique probe.');
 const base=path.join(parent,name);fs.mkdirSync(parent,{recursive:true});noLinks(parent);fs.mkdirSync(base);
 let confirmed=false,result;const controller=new AbortController(),cancel=()=>controller.abort(signal?.reason);
 signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
 const timer=setTimeout(()=>controller.abort(new Error('Zero-model native probe deadline reached')),20000);
 try{result=await probe({base,owner:{conversationKey:ctx.key,taskId:name},signal:controller.signal});confirmed=result?.treeExited===true;
  if(controller.signal.aborted||!result?.stateWritable||!confirmed||result.modelCalls!==0)throw Object.assign(new Error('Guardian state write or tree exit was not confirmed.'),{code:'ACCEPTANCE_HOST_PROBE_FAILED',treeExited:confirmed});
 }catch(error){confirmed=error.treeExited===true;throw error;}
 finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);if(confirmed){if(path.dirname(base)!==parent||!path.basename(base).startsWith('p-'))throw new Error('Unsafe host probe cleanup');fs.rmdirSync(base);try{fs.rmdirSync(parent);}catch(e){if(!['ENOTEMPTY','ENOENT'].includes(e.code))throw e;}}}
 abortIf(signal);await wait(Math.max(0,HOST_RPC_PROBE_MS-(now()-started)),signal);abortIf(signal);
 const elapsedMs=Math.floor(now()-started);if(elapsedMs<HOST_RPC_PROBE_MS)throw new Error('Host RPC diagnostic did not reach the 45-second minimum.');
 return {passed:true,source:'actual-mcp-handler',correlationId,elapsedMs,rpcMinimumMs:HOST_RPC_PROBE_MS,stateRoot:control.stateRoot,conversationPath:ctx.dir,representativeTaskPathLength:representative.length,probePath:base,probeRemoved:!fs.existsSync(base),guardian:result,modelCalls:0,taskAttempts:0};
}
