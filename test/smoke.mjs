/** Paid headless acceptance, NEVER part of npm test. Human authorization required.
 * Usage: npm run smoke -- --authorize-model-cost [--quick]
 * Profile provisioning must have been separately authorized/completed beforehand.
 * Injected metadata exercises bridge ownership; this is NOT actual Codex chat proof.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {CallToolResultSchema} from '@modelcontextprotocol/sdk/types.js';
import {repoRoot} from '../lib/paths.js';import {resolveRuntime} from '../lib/dsh-profile.js';
import {checkGuardian} from '../scripts/check-guardian.js';
if(!process.argv.includes('--authorize-model-cost')) {
 console.error('Refused: this smoke spends real model credits. Obtain separate user approval, then supply --authorize-model-cost. No DSH task was started.');process.exit(2);
}
console.log('PAID smoke explicitly enabled. Injected _meta is NOT actual Codex multi-chat acceptance.');
await checkGuardian(); // Fail before calling a model if token/state supervision is unavailable.
const runtime=resolveRuntime(),base=path.join(repoRoot(),'test','.tmp');fs.mkdirSync(base,{recursive:true});
const scratch=fs.mkdtempSync(path.join(base,'paid-smoke-')),root=path.join(scratch,'shared-state'),workspace=path.join(scratch,'project');fs.mkdirSync(workspace);
const env={...runtime.env,CODEX_DSH_MCP_STATE:root};delete env.CODEX_DSH_MCP_ALLOW_PROVISION;delete env.CODEX_DSH_MCP_CONVERSATION;delete env.CODEX_DSH_MCP_MULTIPLEX;
const bridges=[];
async function start(){const transport=new StdioClientTransport({command:process.execPath,args:[path.join(repoRoot(),'bin','codex-dsh-mcp.js')],cwd:workspace,env,stderr:'pipe'});let stderr='';transport.stderr?.on('data',b=>{stderr=(stderr+b.toString('utf8')).slice(-32768);});const client=new Client({name:'authorized-paid-smoke',version:'0.1.1'},{capabilities:{}});await client.connect(transport);const bridge={client,transport,stderr:()=>stderr};bridges.push(bridge);return bridge;}
const toolAudit=path.join(scratch,'mcp-calls.ndjson');let callSequence=0,paidTaskAttempts=0;
function audit(record){const fd=fs.openSync(toolAudit,'a',0o600);try{fs.writeFileSync(fd,JSON.stringify({timestamp:new Date().toISOString(),...record})+'\n','utf8');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
async function call(bridge,name,args,threadId){
 if(name==='dsh_task'&&paidTaskAttempts>=2)throw new Error('Paid smoke task budget exhausted; no further task was submitted.');
 const callId=++callSequence;
 // Write the request before dispatch so a crash cannot hide a charged attempt.
 audit({phase:'request',call_id:callId,tool:name,thread_id:threadId,arguments:args});
 if(name==='dsh_task')paidTaskAttempts++;
 try{const result=await bridge.client.request({method:'tools/call',params:{name,arguments:args,_meta:{threadId}}},CallToolResultSchema,{timeout:45000,resetTimeoutOnProgress:false});audit({phase:'response',call_id:callId,tool:name,thread_id:threadId,result});return result;}
 catch(error){audit({phase:'error',call_id:callId,tool:name,thread_id:threadId,error:{name:error.name,message:error.message,code:error.code}});throw error;}
}
function text(r){return (r.content ?? []).filter(c=>c.type==='text').map(c=>c.text).join('\n');}
async function submitAndWait(bridge,prompt,threadId,options={}){
 const started=await call(bridge,'dsh_task',{prompt,workspace,sandbox_mode:'read-only',timeout_ms:600000,background:true,...options},threadId);
 assert.notEqual(started.isError,true,text(started));const id=started.structuredContent.task_id;let cursor=0,answer='',reports=[],task;
 const until=Date.now()+620000;
 while(Date.now()<until){const page=await call(bridge,'dsh_status',{task_id:id,cursor,wait_ms:30000,limit:200},threadId);assert.notEqual(page.isError,true,text(page));task=page.structuredContent;reports.push(...(task.reports ?? []));cursor=task.cursor;answer=task.answer ?? answer;if(['completed','failed','timeout','cancelled','interrupted'].includes(task.state)&&!task.has_more)break;}
 assert.equal(task?.state,'completed',JSON.stringify(task));return {id,task,answer,reports};
}
try {
 const bridge=await start(),other=await start(),thread='Smoke-Thread-'+crypto.randomUUID(),otherThread=thread.toLowerCase();
 const self=await call(bridge,'dsh_self_check',{},thread);assert.notEqual(self.isError,true,text(self));assert.match(text(self),/profile ready: true/,'Authorize and complete --bootstrap separately; smoke will not provision.');
 const token='DSH-MEMORY-'+crypto.randomBytes(8).toString('hex');
 const first=await submitAndWait(bridge,'Remember this token for my next message: '+token+'. Do not run shell commands, read secrets, modify files or spawn subagents. Call report with kind="progress", text="paid-smoke-progress" and data={"token":"'+token+'"}; then answer SMOKE-DONE.',thread,{new_session:true});
 assert.match(first.answer,/SMOKE-DONE/);assert.ok(first.reports.some(r=>r.text.includes('paid-smoke-progress')));assert.ok(first.task.session_id);
 const otherSelf=await call(other,'dsh_self_check',{},otherThread);assert.notEqual(otherSelf.isError,true,text(otherSelf));
 const denied=await call(other,'dsh_status',{task_id:first.id},otherThread);assert.equal(denied.isError,true);assert.ok(!text(denied).includes(token));
 const cross=await call(bridge,'dsh_self_check',{},otherThread);assert.equal(cross.isError,true);assert.ok(!text(cross).includes(first.id));
 if(!process.argv.includes('--quick')){const follow=await submitAndWait(bridge,'What token did I ask you to remember? Answer only the exact token. Do not call shell, change files or create subagents.',thread);assert.equal(follow.task.session_id,first.task.session_id);assert.ok(follow.answer.includes(token));}
 console.log(JSON.stringify({paidHeadless:true,sessionResume:!process.argv.includes('--quick'),sameStateRoot:true,sameDshHome:true,caseSensitiveOwnerIsolation:true,actualCodexMultiChatVerified:false,paidTaskAttempts,toolAudit,artifacts:scratch},null,2));
} finally {for(const bridge of bridges){await bridge.client.close().catch(()=>{});await bridge.transport.close().catch(()=>{});if(bridge.stderr())console.error(bridge.stderr());}console.log('Owned smoke logs/session state retained for inspection: '+scratch);}
