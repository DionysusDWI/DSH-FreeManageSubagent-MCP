/** Parent interface with durable launch authorization and independent exit evidence. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {fork} from 'node:child_process';
import {repoRoot} from './paths.js';
import {saveStage,loadEvidence,exitProof} from './supervision-evidence.js';
import {processIdentity} from './process-evidence.js';
export function supervise(options) {
  for(const value of [options.command,options.cwd,...(options.stateDir===undefined?[]:[options.stateDir]),...(options.args??[])])if(typeof value!=='string'||value.includes('\0'))return Promise.reject(new TypeError('Launcher command, cwd and arguments must be NUL-free strings.'));
  for(const [key,value] of Object.entries(options.env??{}))if(key.includes('\0')||key.includes('=')||typeof value!=='string'||value.includes('\0'))return Promise.reject(new TypeError('Invalid launcher environment entry.'));
  if(options.signal?.aborted)return Promise.reject(options.signal.reason??new Error('Cancelled before launch'));
  return new Promise((resolve,reject)=>{
    const attemptId=crypto.randomUUID(),jobId='Local\\dsh-mcp-'+attemptId;
    const dir=path.join(options.stateDir??(options.channel?path.dirname(options.channel):fs.mkdtempSync(path.join(os.tmpdir(),'dsh-supervision-'))),'supervision',attemptId);
    const began=Date.now();
    const record={attemptId,jobId,stage:'intent',authorized:false,createdAt:new Date().toISOString()},metadata={attemptId,jobId,supervisionDir:dir};
    let worker,outcome=null,failure=null,started=false,startupTimer,killTimer;
    const diagnostic=(stage,error)=>{
      try {fs.appendFileSync(path.join(dir,'diagnostics.ndjson'),JSON.stringify({ts:new Date().toISOString(),attemptId,stage,code:error?.code??null,message:String(error?.message??stage).slice(0,4096)})+'\n');}catch(e){failure??=e;}
    };
    function remember(error,code){failure??=Object.assign(error instanceof Error?error:new Error(String(error)),{code:error?.code??code});diagnostic('failure',failure);}
    function send(message){if(!worker?.connected)return;try{worker.send(message,error=>{if(error){remember(error,'GUARDIAN_IPC_FAILED');if(worker.connected)worker.disconnect();}});}catch(error){remember(error,'GUARDIAN_IPC_FAILED');if(worker.connected)worker.disconnect();}}
    function cancel(){send({type:'cancel',reason:{kind:options.signal?.reason?.kind??'cancelled',message:'Supervised execution stopped'}});}
    function settle(){
      clearTimeout(startupTimer);clearTimeout(killTimer);options.signal?.removeEventListener('abort',cancel);
      let proof={verified:false,kind:'evidence-unavailable'};
      try{proof=exitProof(loadEvidence(dir,attemptId,jobId));}catch(error){remember(error,'EVIDENCE_CORRUPT');}
      // POSIX retains its existing process-group exit contract; Windows requires durable Job proof.
      const treeExited=proof.verified||(process.platform!=='win32'&&outcome?.treeExited===true);
      if(failure){Object.assign(failure,{...metadata,treeExited,exitProof:proof,exitStatus:treeExited?'confirmed':'TREE_EXIT_UNCONFIRMED'});reject(failure);return;}
      if(!treeExited){reject(Object.assign(new Error('Guardian exited without confirming verified tree termination.'),{code:'TREE_EXIT_UNCONFIRMED',...metadata,treeExited:false,exitProof:proof}));return;}
      resolve({...outcome,...metadata,code:outcome?.code??proof.code??null,started,treeExited:true,exitProof:proof});
    }
    try {
      saveStage(dir,'bridge',record);diagnostic('intent');options.onSupervision?.(metadata);
      worker=(options.forkImpl??fork)(path.join(repoRoot(),'lib','guardian-worker.js'),[],{stdio:['ignore','ignore','pipe','ipc'],windowsHide:true,execArgv:[]});
      // Persist the PID before querying its stronger creation-time identity.
      record.worker={pid:worker.pid};record.stage='worker-forked';
      worker.stderr.on('data',chunk=>{try{fs.appendFileSync(path.join(dir,'guardian.stderr.log'),chunk);options.onDiagnostic?.('Guardian stderr captured for attempt '+attemptId);}catch(error){remember(error,'DIAGNOSTIC_WRITE_FAILED');cancel();}});
      worker.on('error',error=>remember(error,'GUARDIAN_FORK_FAILED'));
      worker.on('disconnect',()=>{killTimer=setTimeout(()=>{if(worker.exitCode===null)worker.kill();},18000);});
      worker.on('message',event=>{
        try {
          if(event.type==='started'){started=true;clearTimeout(startupTimer);options.onStarted?.({...event,workerPid:worker.pid,...metadata});}
          else if(event.type==='stdout'||event.type==='stderr')options[event.type==='stdout'?'onStdout':'onStderr']?.(Buffer.from(event.data,'base64'));
          else if(event.type==='error'){remember(Object.assign(new Error(event.message),{code:String(event.code??'GUARDIAN_FAILED')}));cancel();}
          else if(event.type==='exit')outcome=event;
        }catch(error){remember(error,'SUPERVISION_CALLBACK_FAILED');cancel();}
      });
      worker.on('exit',settle);
      saveStage(dir,'bridge',record);
      record.worker=processIdentity(worker.pid);
      if(record.worker.status!=='alive'||!record.worker.creationTime)throw Object.assign(new Error('Worker identity cannot be verified before authorization'),{code:'IDENTITY_UNVERIFIED'});
      record.stage='worker-registered';saveStage(dir,'bridge',record);options.onSupervision?.({...metadata,worker:record.worker,workerPid:worker.pid});
      options.signal?.addEventListener('abort',cancel,{once:true});
      const remaining=Math.max(1,Math.min(began+(options.startupTimeoutMs??15000),options.deadline??Infinity)-Date.now());
      startupTimer=setTimeout(()=>{remember(new Error('Guardian startup handshake timed out'),'GUARDIAN_STARTUP_TIMEOUT');if(worker.connected)worker.disconnect();},remaining);
      if(options.signal?.aborted){worker.disconnect();return;}
      const authorize=()=>{
        if(options.signal?.aborted)return worker.disconnect();
        if(Date.now()>=(options.deadline??Infinity)||Date.now()>=began+(options.startupTimeoutMs??15000))throw Object.assign(new Error('Guardian startup handshake timed out before authorization'),{code:'GUARDIAN_STARTUP_TIMEOUT'});
        record.authorized=true;record.stage='launch-authorized';saveStage(dir,'bridge',record);diagnostic(record.stage);
        const launch={type:'launch',attemptId,jobId,supervisionDir:dir};
        for(const key of ['command','args','cwd','env','channel','owner','helper','stateDir','graceMs'])if(options[key]!==undefined)launch[key]=options[key];
        send(launch);
      };
      if(options.authorizeLaunch)options.authorizeLaunch(authorize);else authorize();
    }catch(error){remember(error,'GUARDIAN_PREPARE_FAILED');if(worker){if(worker.connected)worker.disconnect();}else settle();}
  });
}
