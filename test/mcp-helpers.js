import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { createBridgeServer } from '../lib/server.js';
const gates=new Set(),workspaces=new WeakMap();
export function deferred() {let complete;const promise=new Promise(done=>complete=done);const resolve=()=>{gates.delete(resolve);complete();};gates.add(resolve);return {promise,resolve};}
export function releaseAllTestGates(){for(const resolve of gates)resolve();}
export function result(input,patch={}) {return {taskId:input.taskId,conversationKey:input.conversationKey,state:'completed',answer:'done',reason:{kind:'completed'},sessionId:input.sessionId??'session-'+input.taskId,workspace:input.workspace,cwd:input.workspace,sandboxMode:input.sandboxMode,exitCode:0,treeExited:true,...patch};}
export async function connect(options) {
  const bridge=createBridgeServer(options),[clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  const client=new Client({name:'regression-client',version:'1'},{capabilities:{}});await Promise.all([bridge.server.connect(serverTransport),client.connect(clientTransport)]);
  workspaces.set(client,options.defaultWorkspace);
  return {...bridge,client,clientTransport,serverTransport,close:async()=>{await client.close();await bridge.server.close();}};
}
export async function call(client,name,args={},meta={threadId:'thread'},options={}) {if(name==='dsh_task'&&args.workspace===undefined&&workspaces.get(client))args={...args,workspace:workspaces.get(client)};return client.request({method:'tools/call',params:{name,arguments:args,...(meta==null?{}:{_meta:meta})}},CallToolResultSchema,{timeout:5000,...options});}
export const text=raw=>(raw.content ?? []).filter(b=>b.type==='text').map(b=>b.text).join('\n');
