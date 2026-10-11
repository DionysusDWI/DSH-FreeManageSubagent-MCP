/** Parent interface to a per-task guardian. Windows tree exit is mandatory. */
import path from 'node:path';
import { fork } from 'node:child_process';
import { repoRoot } from './paths.js';
export function supervise(options) {
  for(const value of [options.command,options.cwd,...(options.stateDir===undefined?[]:[options.stateDir]),...(options.args ?? [])]) if(typeof value!=='string'||value.includes('\0')) return Promise.reject(new TypeError('Launcher command, cwd and arguments must be NUL-free strings.'));
  for(const [key,value] of Object.entries(options.env ?? {})) if(key.includes('\0')||key.includes('=')||typeof value!=='string'||value.includes('\0')) return Promise.reject(new TypeError('Invalid launcher environment entry.'));
  if (options.signal?.aborted) return Promise.reject(options.signal.reason ?? new Error('Cancelled before launch'));
  return new Promise((resolve, reject) => {
    const worker = fork(path.join(repoRoot(), 'lib', 'guardian-worker.js'), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true, execArgv: [] });
    let outcome = null, failure = null, started = false, messageTimer;
    function send(message) {
      if(!worker.connected) return;
      try {worker.send(message,error=> {if(error) {failure ??= error;if(worker.connected)worker.disconnect();}});}
      catch(error) {failure ??= error;if(worker.connected)worker.disconnect();}
    }
    function sendCancel() {send({type:'cancel',reason:{kind:options.signal?.reason?.kind ?? 'cancelled',message:String(options.signal?.reason?.message ?? 'Task cancelled')}});}
    const startupTimer = setTimeout(() => { failure ??= new Error('Guardian startup handshake timed out');if(worker.connected)worker.disconnect(); }, options.startupTimeoutMs ?? 15000);
    options.signal?.addEventListener('abort', sendCancel, { once: true });
    worker.stderr.on('data', chunk => {try{options.onDiagnostic?.('guardian: ' + chunk.toString('utf8').slice(0,4096));}catch(error){failure ??= error;sendCancel();}});
    worker.on('message', event => {
      try {
        if (event.type === 'started') { started = true; clearTimeout(startupTimer); options.onStarted?.({...event,workerPid:worker.pid}); }
        else if (event.type === 'stdout' || event.type === 'stderr') options[event.type === 'stdout' ? 'onStdout' : 'onStderr']?.(Buffer.from(event.data, 'base64'));
        else if (event.type === 'error') { failure ??= Object.assign(new Error(event.message),{code:event.code===undefined?undefined:String(event.code)});send({type:'cancel',reason:{kind:'error',message:event.message}}); }
        else if (event.type === 'exit') outcome = event;
      } catch (error) { failure ??= error; sendCancel(); }
    });
    worker.on('error', error => { failure ??= error; });
    worker.on('disconnect', () => {
      messageTimer = setTimeout(() => { if (worker.exitCode === null) worker.kill(); }, 5000);
    });
    worker.on('exit', (code, signal) => {
      clearTimeout(startupTimer); clearTimeout(messageTimer); options.signal?.removeEventListener('abort', sendCancel);
      if (failure) { failure.treeExited = outcome?.treeExited === true;if(!failure.treeExited)failure.code='TREE_EXIT_UNCONFIRMED';return reject(failure); }
      if (!outcome?.treeExited) return reject(Object.assign(new Error('Guardian exited without confirming process-tree termination. Task is interrupted, not cancelled.'), { code: 'TREE_EXIT_UNCONFIRMED' }));
      resolve({ ...outcome, started });
    });
    send({type:'launch',...options,signal:undefined,onStdout:undefined,onStderr:undefined,onStarted:undefined,onDiagnostic:undefined});if(options.signal?.aborted)sendCancel();
  });
}
