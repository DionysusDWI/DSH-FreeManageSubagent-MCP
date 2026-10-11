import assert from 'node:assert/strict';
import test from 'node:test';
import { supervise } from '../lib/supervisor.js';
import { delay, processAlive } from '../lib/file-lock.js';
const node = process.execPath;
test('guardian launches a non-model child and confirms the whole tree exited', async () => {
  let stdout = '', supervision;
  const result = await supervise({ command: node, args: ['-e', 'console.log("child ready")'], cwd: process.cwd(), env: process.env,
    onStarted: event => { supervision = event.supervision; }, onStdout: chunk => { stdout += chunk; } });
  assert.equal(result.code, 0); assert.equal(result.treeExited, true); assert.match(stdout, /child ready/);
  if (process.platform === 'win32') assert.equal(supervision, 'windows-job-kill-on-close');
});
test('cancel waits for confirmed child and grandchild termination', async () => {
  const controller = new AbortController(); let pid, grandchild, stderr = '';
  const script = 'const {spawn}=require("node:child_process"); const c=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"}); console.log("grandchild="+c.pid); setInterval(()=>{},1000);';
  const running = supervise({ command: node, args: ['-e',script], cwd: process.cwd(), env: process.env, signal: controller.signal, graceMs: 30,
    onStarted: event => { pid = event.pid; }, onStdout: chunk => { const m=/grandchild=(\d+)/.exec(chunk.toString()); if(m) grandchild=Number(m[1]); }, onStderr: chunk => { stderr += chunk; } });
  try {
    for (let i=0; i<300 && !grandchild; i++) await delay(20);
    assert.ok(pid); assert.ok(grandchild, stderr);
    controller.abort({ kind: 'cancelled', message: 'test cancellation' });
    const result = await running; assert.equal(result.treeExited, true);
    assert.equal(processAlive(pid), false); assert.equal(processAlive(grandchild), false);
  } finally { controller.abort(); await running.catch(() => {}); }
});

test('guardian applies output backpressure and drains every byte before disconnecting', async () => {
  let stdout=0,stderr=0;
  const bytes=4*1024*1024;
  const result=await supervise({command:node,args:['-e', 'process.stdout.write(Buffer.alloc('+bytes+',65));process.stderr.write(Buffer.alloc('+bytes+',66));'],cwd:process.cwd(),env:process.env,
    onStdout:chunk=>{stdout+=chunk.length;},onStderr:chunk=>{stderr+=chunk.length;}});
  assert.equal(result.treeExited,true);assert.equal(result.code,0);assert.equal(stdout,bytes);assert.equal(stderr,bytes);
});

test('cancellation racing before launch acknowledges no child instead of waiting for startup timeout', async () => {
  const controller=new AbortController(),add=controller.signal.addEventListener.bind(controller.signal);let started=false;
  controller.signal.addEventListener=(...args)=>{add(...args);controller.abort({kind:'cancelled',message:'before launch IPC'});};
  const now=Date.now();const result=await supervise({command:node,args:['-e','setInterval(()=>{},1000)'],cwd:process.cwd(),env:process.env,signal:controller.signal,onStarted:()=>{started=true;}});
  assert.equal(result.treeExited,true);assert.equal(started,false);assert.ok(Date.now()-now<3000);
});
