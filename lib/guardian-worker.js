/** Per-task guardian worker, not a daemon. Loss of parent IPC stops its tree. */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { repoRoot } from './paths.js';
import {saveStage} from './supervision-evidence.js';
import {processIdentity} from './process-evidence.js';
import { requestCancellation } from '../dsh-plugin/channel.js';
let child, input, stopped = false, done = false, timer, exitTimer, drainTimer;
let evidence;
function stage(patch){Object.assign(evidence,patch);saveStage(input.supervisionDir,'worker',evidence);}
let pendingBytes = 0, pendingMessages = 0, outputPaused = false;
const HIGH_WATER = 1024 * 1024, LOW_WATER = 256 * 1024;
function flow() {
  if (!child) return;
  const pause = process.connected && pendingBytes >= HIGH_WATER;
  if (pause && !outputPaused) { outputPaused = true; child.stdout?.pause(); child.stderr?.pause(); }
  else if (outputPaused && (!process.connected || pendingBytes <= LOW_WATER)) { outputPaused = false; child.stdout?.resume(); child.stderr?.resume(); }
}
function disconnectWhenDrained() {
  if (done && pendingMessages === 0) { clearTimeout(drainTimer); if (process.connected) process.disconnect(); }
}
function emit(event) {
  if (!process.connected) return;
  const size = Buffer.byteLength(JSON.stringify(event)); pendingBytes += size; pendingMessages++;
  let settled = false;
  const complete = error => {
    if (settled) return; settled = true; pendingBytes -= size; pendingMessages--;
    if (error) stop({ kind: 'interrupted', message: 'Parent IPC unavailable' });
    flow(); disconnectWhenDrained();
  };
  try { process.send(event, complete); } catch (error) { complete(error); }
  flow();
}
function cancellation(reason) {
  if (!input?.channel) return;
  try { requestCancellation(input.channel, reason, input.owner); }
  catch (e) { emit({ type: 'error', message: 'Cannot persist cancellation: ' + e.message }); }
}
function force() {
  if (!child || done) return;
  if (process.platform === 'win32') {
    try { child.stdin.write(JSON.stringify({ type: 'kill' }) + '\n', e => { if (e) emit({ type: 'error', message: 'Guardian kill IPC failed: ' + e.message }); }); }
    catch (e) { emit({ type: 'error', message: e.message }); }
    // Killing the helper closes the Job handle and is an OS-enforced fallback, never taskkill.
    exitTimer = setTimeout(() => { if (!done) child.kill(); }, 5000);
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') emit({ type: 'error', message: e.message }); }
  }
}
function stop(reason) {
  if (stopped || done) return; stopped = true; cancellation(reason);
  if (!child) return;
  timer = setTimeout(force, input.graceMs ?? 2000);
}
function finish(code, signal) {
  if(done)return; done = true; clearTimeout(timer); clearTimeout(exitTimer);
  if (process.platform !== 'win32' && child?.pid) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') emit({ type: 'error', message: e.message }); }
    emit({ type: 'exit', code, signal, treeExited: true });
  }
  // Do not disconnect before the final stdout/stderr/exit IPC messages have drained.
  if (pendingMessages) drainTimer = setTimeout(() => { if (process.connected) process.disconnect(); }, 30000);
  disconnectWhenDrained();
}
process.on('disconnect', () => { flow(); stop({ kind: 'interrupted', message: 'Bridge connection closed' }); if (!child) process.exit(0); });
process.on('message', message => {
  if (message.type === 'cancel') { stop(message.reason); return; }
  if (message.type !== 'launch' || input) return;
  input = message;
  evidence={attemptId:input.attemptId,jobId:input.jobId,launchRequested:false,stage:'worker-ready'};
  if (stopped || !process.connected) {evidence.worker=processIdentity(process.pid);stage({proof:'not-started',stage:'not-started'});emit({type:'exit',code:null,treeExited:true,cancelledBeforeLaunch:true});finish(null,null);return;}
  try {
    stage({worker:processIdentity(process.pid)});
    if (process.platform === 'win32') {
      const helper = message.helper ?? path.join(repoRoot(), 'native', 'windows-job-host.exe');
      if (!fs.existsSync(helper)) throw new Error('Windows Job guardian is unavailable. Run npm run build:native or use a complete release package. Unsupervised launch is refused.');
      child = spawn(helper, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      child.on('error',error=>{emit({type:'error',message:error.message});finish(null,null);});
      child.on('close',finish);
      stage({stage:'helper-spawned',helper:{pid:child.pid}});
      const helperIdentity=processIdentity(child.pid);
      if(helperIdentity.status!=='alive'||!helperIdentity.creationTime)throw new Error('Helper identity unverified before launch request');
      stage({stage:'helper-registered',helper:helperIdentity});
      let pending = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        pending += chunk;
        if (pending.length > 128 * 1024) { emit({ type: 'error', message: 'Malformed guardian IPC' }); child.kill(); return; }
        let newline;
        while ((newline = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
          try { const event=JSON.parse(line); if(event.type==='started')event.guardianPid=child.pid; emit(event); } catch (e) { emit({ type: 'error', message: 'Invalid guardian IPC: ' + e.message }); child.kill(); }
        }
      });
      child.stderr.on('data', chunk => {fs.appendFileSync(path.join(input.supervisionDir,'helper.stderr.log'),chunk);emit({type:'error',message:'Helper stderr captured',code:'GUARDIAN_STDERR'});});
      child.stdin.on('error', error => { emit({ type: 'error', message: 'Guardian stdin: ' + error.message }); stop({ kind: 'error', message: error.message }); });
      if(stopped||!process.connected){stage({proof:'not-started',stage:'not-started'});child.stdin.end();return;}
      stage({launchRequested:true,stage:'launch-requested'});
      child.stdin.write(JSON.stringify({attemptId:input.attemptId,jobId:input.jobId,supervisionDir:input.supervisionDir, command: input.command, args: input.args, cwd: input.cwd, env: input.env, ...((input.stateDir ?? (input.channel ? path.dirname(input.channel) : null)) ? {stateDir:input.stateDir ?? path.dirname(input.channel)} : {}) }) + '\n');
    } else {
      stage({launchRequested:true,stage:'launch-requested'});
      child = spawn(input.command, input.args, { cwd: input.cwd, env: input.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      child.once('spawn', () => emit({ type: 'started', pid: child.pid, supervision: 'posix-process-group' }));
      child.stdout.on('data', chunk => emit({ type: 'stdout', data: chunk.toString('base64') }));
      child.stderr.on('data', chunk => emit({ type: 'stderr', data: chunk.toString('base64') }));
    }
    child.on('error', error => { emit({ type: 'error', message: error.message });if(!child.pid)emit({type:'exit',code:1,treeExited:true,launchRefused:true});finish(null, null); });
    child.on('close', finish);
  } catch (error) { try{stage({stage:'failed',...(evidence.launchRequested?{}:{proof:'not-started'})});}catch{} if(child&&process.platform==='win32'){child.stdin?.end();} emit({ type: 'error', message: error.message });if(!child?.pid)emit({type:'exit',code:1,treeExited:true,launchRefused:true});finish(null, null); }
});
process.on('SIGTERM', () => stop({ kind: 'interrupted', message: 'Guardian worker terminated' }));
