import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { call } from './mcp-helpers.js';
import { processAlive,delay } from '../lib/file-lock.js';
import { supervise } from '../lib/supervisor.js';
import { tempDir,isolatedEnv } from './helpers.js';
const fixture=fileURLToPath(new URL('./fixtures/supervised-bridge.mjs',import.meta.url));
async function tree(t) {
 const {dir,cleanup}=tempDir('stdio-tree');const transport=new StdioClientTransport({command:process.execPath,args:[fixture],cwd:process.cwd(),env:isolatedEnv(dir,{CODEX_DSH_MCP_WORKSPACE:dir}),stderr:'pipe'}),client=new Client({name:'lifecycle-client',version:'1'});let stderr='';transport.stderr.on('data',b=>stderr+=b);
 await client.connect(transport);t.after(async()=>{try{await client.close();}finally{cleanup();}});
 const task=await call(client,'dsh_task',{prompt:'local non-model tree',background:true});let ids;const deadline=Date.now()+5000;
 while(!ids&&Date.now()<deadline) {const status=await call(client,'dsh_status',{task_id:task.structuredContent.task_id,cursor:0,wait_ms:100});ids=status.structuredContent?.reports?.find(r=>r.event_id==='pids')?.data;}
 assert.ok(ids,stderr);return {client,transport,ids,pid:transport.pid};
}
async function assertGone(ids) {const pids=Object.values(ids).filter(Number.isInteger),deadline=Date.now()+12000;while(pids.some(pid=>processAlive(pid)!==false)&&Date.now()<deadline)await delay(25);for(const pid of pids)assert.equal(processAlive(pid),false,'orphan PID '+pid);}
test('stdio stdin EOF stops the bridge and all managed children/grandchildren',async t=> {
 const info=await tree(t);info.transport._process.stdin.end();await assertGone({...info.ids,bridge:info.pid});
});
test('forcibly ending the bridge closes guardian IPC and leaves no managed subtree',async t=> {
 const info=await tree(t);process.kill(info.pid,'SIGKILL');await assertGone({...info.ids,bridge:info.pid});
});
test('killing the Windows Job guardian closes its handle and kills children without false cancellation', {skip:process.platform!=='win32'},async()=> {
 const controller=new AbortController();let ids,grandchild;
 const script='const c=require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});console.log("grandchild="+c.pid);setInterval(()=>{},1000);';
 const running=supervise({command:process.execPath,args:['-e',script],cwd:process.cwd(),env:process.env,signal:controller.signal,onStarted:event=>ids=event,onStdout:b=>{const m=/grandchild=(\d+)/.exec(b.toString());if(m)grandchild=Number(m[1]);}});
 try {const end=Date.now()+5000;while(!grandchild&&Date.now()<end)await delay(20);assert.ok(grandchild);process.kill(ids.guardianPid,'SIGKILL');await assert.rejects(running,/without confirming/);await assertGone({pid:ids.pid,grandchild,worker:ids.workerPid,guardian:ids.guardianPid});}
 finally{controller.abort();await running.catch(()=>{});}
});
test('a missing Windows guardian never falls back to unsupervised execution',{skip:process.platform!=='win32'},async()=> {
 let started=false;await assert.rejects(supervise({command:process.execPath,args:['-e','console.log("should not run")'],cwd:process.cwd(),env:process.env,helper:path.join(process.cwd(),'native','missing.exe'),onStarted:()=>started=true}),/unavailable/);assert.equal(started,false);
});
