/** Parent interface with durable launch authorization and independent exit evidence. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {GUARDIAN_PROTOCOL,GuardianInput} from './guardian-protocol.js';
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
    let worker,outcome=null,failure=null,started=false,settled=false,workerExited=false,ipcClosed=false,stderrClosed=false,startupTimer,killTimer;
    const stdin=new GuardianInput(message=>{if(!worker?.connected)throw new Error('Guardian IPC closed');send(message);});
    let workerHandshake=false,launchAuthorized=false,inputAborted=false;
    const diagnostic=(stage,error)=>{
      try {fs.appendFileSync(path.join(dir,'diagnostics.ndjson'),JSON.stringify({ts:new Date().toISOString(),attemptId,stage,code:error?.code??null,message:String(error?.message??stage).slice(0,4096)})+'\n');}catch(e){failure??=e;}
    };
    function remember(error,code){failure??=Object.assign(error instanceof Error?error:new Error(String(error)),{code:error?.code??code});diagnostic('failure',failure);}
    function send(message){if(!worker?.connected)return;try{worker.send(message,error=>{if(error){remember(error,'GUARDIAN_IPC_FAILED');if(worker.connected)worker.disconnect();}});}catch(error){remember(error,'GUARDIAN_IPC_FAILED');if(worker.connected)worker.disconnect();}}
    function cancel(){inputAborted=true;stdin.fail(new Error('Supervised execution stopped'));send({type:'cancel',reason:{kind:options.signal?.reason?.kind??'cancelled',message:'Supervised execution stopped'}});}
    function relayClosed(){if(settled)return;diagnostic('relay-closed');settle();}
    function maybeRelayClosed(){if(workerExited&&ipcClosed&&stderrClosed)relayClosed();}
    function settle(){
      if(settled)return;settled=true;stdin.fail();
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
      // Keep IPC referenced until EOF; the process handle can close before its
      // queued messages reach this event loop (also in standalone CLI probes).
      worker.channel?.ref();
      // Persist the PID before querying its stronger creation-time identity.
      record.worker={pid:worker.pid};record.stage='worker-forked';
      worker.stderr.on('data',chunk=>{try{fs.appendFileSync(path.join(dir,'guardian.stderr.log'),chunk);options.onDiagnostic?.('Guardian stderr captured for attempt '+attemptId);}catch(error){remember(error,'DIAGNOSTIC_WRITE_FAILED');cancel();}});
      stderrClosed=!worker.stderr;ipcClosed=!worker.connected;
      worker.stderr?.once('close',()=>{stderrClosed=true;maybeRelayClosed();});
      worker.on('error',error=>remember(error,'GUARDIAN_FORK_FAILED'));
      worker.on('disconnect',()=>{ipcClosed=true;if(!settled&&!workerExited)killTimer=setTimeout(()=>{if(worker.exitCode===null)worker.kill();},18000);maybeRelayClosed();});
      worker.on('message',event=>{
        try {
          if(event.type==='hello'){
            if(event.protocol!==GUARDIAN_PROTOCOL||event.stdin!==true)throw Object.assign(new Error('Guardian duplex protocol mismatch.'),{code:'GUARDIAN_PROTOCOL_MISMATCH'});
            workerHandshake=true;if(options.duplex){if(options.authorizeLaunch)options.authorizeLaunch(authorize);else authorize();}
          }
          else if(event.type==='stdin-ack'){if(!inputAborted)stdin.acknowledge(event);}
          else if(event.type==='started'){
            if(options.duplex&&(!workerHandshake||event.protocol!==GUARDIAN_PROTOCOL))throw Object.assign(new Error('Old guardian cannot carry SDK stdin.'),{code:'GUARDIAN_PROTOCOL_MISMATCH'});
            started=true;clearTimeout(startupTimer);options.onStarted?.({...event,workerPid:worker.pid,...metadata});if(options.duplex)options.onTransport?.(stdin);}
          else if(event.type==='stdout'||event.type==='stderr')options[event.type==='stdout'?'onStdout':'onStderr']?.(Buffer.from(event.data,'base64'));
          else if(event.type==='error'&&inputAborted&&event.code==='GUARDIAN_INPUT_FAILED'){diagnostic('stdin-closed-during-stop');}
          else if(event.type==='error'){remember(Object.assign(new Error(event.message),{code:String(event.code??'GUARDIAN_FAILED')}));cancel();}
          else if(event.type==='exit')outcome=event;
        }catch(error){remember(error,'SUPERVISION_CALLBACK_FAILED');cancel();}
      });
      // Process exit is not a stream barrier: Node can deliver queued IPC messages
      // after 'exit'. Keep task logs/parser alive until 'close' has drained the
      // worker's stdio AND IPC channel, including the terminal DSH events.
      // Explicit parent-side disconnect can omit ChildProcess 'close' on Node
      // 24. Also accept its full equivalent: process exit + IPC disconnect +
      // stderr close. No stdout/stderr callbacks can remain at that barrier.
      worker.once('exit',()=>{workerExited=true;clearTimeout(startupTimer);clearTimeout(killTimer);diagnostic('worker-exited');maybeRelayClosed();});
      worker.once('close',relayClosed);
      saveStage(dir,'bridge',record);
      record.worker=processIdentity(worker.pid);
      if(record.worker.status!=='alive'||!record.worker.creationTime)throw Object.assign(new Error('Worker identity cannot be verified before authorization'),{code:'IDENTITY_UNVERIFIED'});
      record.stage='worker-registered';saveStage(dir,'bridge',record);options.onSupervision?.({...metadata,worker:record.worker,workerPid:worker.pid});
      options.signal?.addEventListener('abort',cancel,{once:true});
      const remaining=Math.max(1,Math.min(began+(options.startupTimeoutMs??15000),options.deadline??Infinity)-Date.now());
      startupTimer=setTimeout(()=>{remember(new Error('Guardian startup handshake timed out'),'GUARDIAN_STARTUP_TIMEOUT');if(worker.connected)worker.disconnect();},remaining);
      if(options.signal?.aborted){worker.disconnect();return;}
      function authorize(){
        if(launchAuthorized)return;launchAuthorized=true;
        if(options.signal?.aborted)return worker.disconnect();
        if(Date.now()>=(options.deadline??Infinity)||Date.now()>=began+(options.startupTimeoutMs??15000))throw Object.assign(new Error('Guardian startup handshake timed out before authorization'),{code:'GUARDIAN_STARTUP_TIMEOUT'});
        record.authorized=true;record.stage='launch-authorized';saveStage(dir,'bridge',record);diagnostic(record.stage);
        const launch={type:'launch',protocol:GUARDIAN_PROTOCOL,duplex:options.duplex===true,attemptId,jobId,supervisionDir:dir};
        for(const key of ['command','args','cwd','env','channel','owner','helper','stateDir','graceMs'])if(options[key]!==undefined)launch[key]=options[key];
        send(launch);
      };
      if(!options.duplex){if(options.authorizeLaunch)options.authorizeLaunch(authorize);else authorize();}
    }catch(error){remember(error,'GUARDIAN_PREPARE_FAILED');if(worker){if(worker.connected)worker.disconnect();}else settle();}
  });
}
