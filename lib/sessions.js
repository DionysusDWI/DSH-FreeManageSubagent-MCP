/** A namespace-scoped, atomic catalog of bridge-managed native DSH sessions.
 * The randomly allocated storage key is private bookkeeping, NEVER a session_id.
 * Channel v2 owner fields remain an internal disk protocol, not client identity. */
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {TaskStore,TERMINAL_STATES} from './store.js';import {ReportQueue} from './report-queue.js';
import {readJson,writeJsonAtomic,assertOwner} from './io.js';import {withFileLockSync} from './file-lock.js';
import {taskPathsIn} from './paths.js';import {canonicalWorkspace,normalizeWorkspace,quarantineWorkspace,supervisedPids,assertWorkspaceNotQuarantined} from './workspace-lock.js';
import {deploymentNamespace} from './config.js';import {MAX_RESPONSE_BYTES} from './response.js';
const hash=text=>crypto.createHash('sha256').update(text).digest('hex');
const fail=(message,code='SESSION_STATE_CORRUPT')=>{throw Object.assign(new Error(message),{code});};
export function nativeSessionId(id){if(typeof id!=='string'||!id||Buffer.byteLength(id)>512||/[\x00-\x1f]/.test(id)||['__proto__','constructor','prototype'].includes(id))fail('Invalid native DSH session ID.','SESSION_ID_INVALID');return id;}
export function namespaceDirectory(root,name){return path.join(path.resolve(root),'v3-n-'+hash(name));}
function assertPlainMap(map){if(!map||Array.isArray(map)||typeof map!=='object')fail('Corrupt catalog map.');}
export function refuseLinks(root,target){
 const relative=path.relative(path.resolve(root),path.resolve(target));if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))fail('Managed path escaped its state root.');
 let current=path.resolve(root);for(const part of ['',...relative.split(path.sep).filter(Boolean)]){if(part)current=path.join(current,part);try{if(fs.lstatSync(current).isSymbolicLink())fail('Managed path contains a symlink or junction.');}catch(error){if(error.code!=='ENOENT')throw error;}}
}
export class SessionContext {
 constructor(manager,group,{readOnly=false}={}){
  this.readOnly=readOnly;
  this.manager=manager;this.group=group;this.key=group.scopeKey;this.namespace=manager.namespace;this.stateRoot=manager.stateRoot;this.dir=manager.groupDirectory(group.storageKey);
  const metadata=readJson(path.join(this.dir,'scope.json'));if(metadata.version!==3||metadata.namespace!==this.namespace||metadata.scopeKey!==this.key||metadata.storageKey!==group.storageKey)fail('Corrupt session scope.');
  this.logPath=path.join(this.dir,'bridge.log');this.controllers=new Map();this.taskChain=Promise.resolve();
  this.queue=new ReportQueue({conversationKey:this.key,logPath:path.join(this.dir,'reports.ndjson'),onDiagnostic:line=>this.diagnostic(line)});
  this.store=new TaskStore({conversationKey:this.key,dir:this.dir,version:3,namespace:this.namespace,storageKey:group.storageKey,readOnly,onDiagnostic:line=>this.diagnostic(line)});
  const put=this.store.putTask.bind(this.store),writeSession=this.store.writeSession.bind(this.store),recover=this.store.recoverInterrupted.bind(this.store);
  this.store.recoverInterrupted=()=>{recover();for(const task of this.store.listTasks())if(task.quarantined===true&&task.treeExited!==true&&!task.recoveryReceipt)quarantineWorkspace({stateRoot:this.stateRoot,workspace:task.workspace,scopeKey:this.key,taskId:task.taskId,processPids:supervisedPids(task)});};
  this.store.putTask=record=>{record.version=3;record.namespace=this.namespace;record.storageKey=group.storageKey;const saved=put(record);manager.recordTask(group.storageKey,saved);return saved;};
  this.store.writeSession=(id,workspace,options)=>{writeSession(id,workspace,options);manager.registerSession(group.storageKey,id,workspace,options);};
 }
 diagnostic(line){if(this.readOnly)return;try{fs.appendFileSync(this.logPath,new Date().toISOString()+' '+line+'\n');}catch{}}
 taskPaths(id){return taskPathsIn(this.dir,id);}
 sessionRoot(){return path.join(this.dir,'sessions');}
 runExclusive(work){const run=this.taskChain.then(work,work);this.taskChain=run.then(()=>{},()=>{});return run;}
 assertExecution(args,workspace){
  const cat=this.manager.readCatalog(),group=cat.groups[this.group.storageKey];if(!group||group.scopeKey!==this.key)fail('Session scope changed.');
  if(fs.existsSync(path.join(this.dir,'.execution-quarantine.json')))fail('Session has an unconfirmed process-tree exit. No lock is cleared automatically.','EXECUTION_QUARANTINED');
  if(args.session_id!==undefined){const record=this.manager.requireSession(args.session_id,workspace);if(record.storageKey!==group.storageKey)fail('Selected session changed.');const stored=this.store.readSession();if(stored.sessionId!==args.session_id||!stored.verified)fail('Native session record does not match its catalog.');}
 }
}
export class SessionManager {
 constructor({stateRoot,env=process.env,namespace}={}){this.stateRoot=path.resolve(stateRoot);this.namespace=namespace??deploymentNamespace(env);deploymentNamespace({DSH_MCP_NAMESPACE:this.namespace});this.dir=namespaceDirectory(this.stateRoot,this.namespace);this.catalogPath=path.join(this.dir,'catalog.json');this.lockPath=path.join(this.dir,'.catalog.lock');this.contexts=new Map();}
 emptyCatalog(){return {version:3,namespace:this.namespace,revision:0,groups:{},sessions:{},sessionOrder:[],tasks:{},taskOrder:[],migrations:{}};}
 readCatalog(){
  refuseLinks(this.stateRoot,this.catalogPath);const cat=readJson(this.catalogPath,{optional:true});if(!cat)return this.emptyCatalog();
  if(cat.version!==3||cat.namespace!==this.namespace||!Number.isSafeInteger(cat.revision)||!Array.isArray(cat.sessionOrder)||!Array.isArray(cat.taskOrder))fail('Unsupported or corrupt namespace catalog.');
  for(const key of ['groups','sessions','tasks','migrations'])assertPlainMap(cat[key]);
  if(new Set(cat.sessionOrder).size!==cat.sessionOrder.length||new Set(cat.taskOrder).size!==cat.taskOrder.length)fail('Duplicate catalog entries.');
  for(const id of cat.sessionOrder){nativeSessionId(id);const item=cat.sessions[id];if(!Object.hasOwn(cat.sessions,id)||item.sessionId!==id||!Object.hasOwn(cat.groups,item.storageKey)||typeof item.workspace!=='string'||typeof item.workspaceCanonical!=='string')fail('Corrupt native session index.');}
  for(const id of cat.taskOrder){const item=cat.tasks[id];if(typeof id!=='string'||!Object.hasOwn(cat.tasks,id)||item.taskId!==id||!Object.hasOwn(cat.groups,item.storageKey))fail('Corrupt task index.');}
  return cat;
 }
 mutate(work){refuseLinks(this.stateRoot,this.lockPath);return withFileLockSync(this.lockPath,()=>{const cat=this.readCatalog(),value=work(cat);cat.revision++;writeJsonAtomic(this.catalogPath,cat);return value;});}
 groupDirectory(key){if(typeof key!=='string'||!/^[a-f0-9-]{36}$/.test(key))fail('Invalid storage key.');const dir=path.join(this.dir,'sessions',key);refuseLinks(this.stateRoot,dir);return dir;}
 context(key){const cat=this.readCatalog(),group=cat.groups[key];if(!Object.hasOwn(cat.groups,key)||!group||group.storageKey!==key||typeof group.scopeKey!=='string')fail('Unknown or corrupt session scope.');let ctx=this.contexts.get(key);if(!ctx){ctx=new SessionContext(this,group);this.contexts.set(key,ctx);}return ctx;}
 createContext(workspace){
  workspace=normalizeWorkspace(workspace);const storageKey=crypto.randomUUID(),scopeKey='namespace:'+hash(this.namespace)+':scope:'+storageKey;
  this.mutate(cat=>{const dir=this.groupDirectory(storageKey);fs.mkdirSync(path.join(dir,'sessions'),{recursive:true});writeJsonAtomic(path.join(dir,'scope.json'),{version:3,namespace:this.namespace,storageKey,scopeKey});cat.groups[storageKey]={storageKey,scopeKey,workspace,workspaceCanonical:canonicalWorkspace(workspace),createdAt:Date.now(),nativeSessionId:null};});
  return this.context(storageKey);
 }
 select(args){
  if(typeof args.workspace!=='string'||!args.workspace.trim()||!path.isAbsolute(args.workspace))fail('An explicit absolute workspace is required.','WORKSPACE_REQUIRED');
  const workspace=normalizeWorkspace(args.workspace);if(Buffer.byteLength(workspace)>8192)fail('Workspace path is too large.','WORKSPACE_INVALID');
  if(args.new_session===true&&args.session_id!==undefined)fail('new_session=true cannot be combined with session_id.','SESSION_ARGUMENT_CONFLICT');
  if(args.new_session===false&&args.session_id===undefined)fail('Deprecated new_session=false requires an explicit session_id.','SESSION_ARGUMENT_CONFLICT');
  assertWorkspaceNotQuarantined(this.stateRoot,workspace,args.sandbox_mode??'workspace-write');
  const ctx=args.session_id===undefined?this.createContext(workspace):this.context(this.requireSession(args.session_id,workspace).storageKey);
  return {ctx,args:{...args,workspace,new_session:args.session_id===undefined}};
 }
 requireSession(id,workspace){
  nativeSessionId(id);const cat=this.readCatalog();if(!Object.hasOwn(cat.sessions,id))fail('No managed native session matches this namespace.','SESSION_NOT_FOUND');
  const item=cat.sessions[id];if(item.verified!==true)fail('Session is not verified.','SESSION_UNVERIFIED');
  const dir=this.groupDirectory(item.storageKey),group=cat.groups[item.storageKey];
  if(group.nativeSessionId!==id||group.workspaceCanonical!==item.workspaceCanonical)fail('Native session scope/index mismatch.');
  if(canonicalWorkspace(item.workspace)!==item.workspaceCanonical||workspace!==undefined&&canonicalWorkspace(workspace)!==item.workspaceCanonical)fail('Session workspace differs or has drifted.','SESSION_WORKSPACE_MISMATCH');
  const owner=readJson(path.join(dir,'owner.json')),index=readJson(path.join(dir,'tasks.json'));assertOwner(owner,group.scopeKey);assertOwner(index,group.scopeKey);
  if(owner.version!==3||index.version!==3||owner.namespace!==this.namespace||index.namespace!==this.namespace||owner.storageKey!==item.storageKey||index.storageKey!==item.storageKey||index.sessionId!==id||index.sessionVerified!==true||canonicalWorkspace(index.sessionWorkspace)!==item.workspaceCanonical)fail('Stored native session is corrupt.');
  const last=item.lastTaskId?this.taskMetadata(cat,item.lastTaskId):null;if(!last||last.session_id!==id||last.workspace!==item.workspace)fail('Native session task proof/index mismatch.');
  if(fs.existsSync(path.join(dir,'.execution-quarantine.json')))fail('Session is quarantined after an unconfirmed exit.','EXECUTION_QUARANTINED');
  refuseLinks(this.stateRoot,path.join(dir,'sessions'));if(!fs.existsSync(path.join(dir,'sessions')))fail('Native session storage is missing.','SESSION_UNVERIFIED');
  return item;
 }
 registerSession(key,id,workspace,{taskId=null,verified=true}={}){
  nativeSessionId(id);const canonical=canonicalWorkspace(workspace);
  this.mutate(cat=>{const group=cat.groups[key];if(!group||group.workspaceCanonical!==canonical)fail('Captured session workspace changed.');if(group.nativeSessionId&&group.nativeSessionId!==id)fail('Native session identity changed in a managed scope.');if(Object.hasOwn(cat.sessions,id)&&cat.sessions[id].storageKey!==key)fail('Native session ID collision.','SESSION_ID_CONFLICT');if(!Object.hasOwn(cat.sessions,id))cat.sessionOrder.push(id);group.nativeSessionId=id;cat.sessions[id]={sessionId:id,storageKey:key,workspace,workspaceCanonical:canonical,verified:verified===true,createdAt:cat.sessions[id]?.createdAt??Date.now(),updatedAt:Date.now(),lastTaskId:taskId};});
 }
 recordTask(key,record){this.mutate(cat=>{if(!Object.hasOwn(cat.groups,key))fail('Task scope disappeared.');if(Object.hasOwn(cat.tasks,record.taskId)&&cat.tasks[record.taskId].storageKey!==key)fail('Task ID collision.');if(!Object.hasOwn(cat.tasks,record.taskId))cat.taskOrder.push(record.taskId);cat.tasks[record.taskId]={taskId:record.taskId,storageKey:key,createdAt:record.createdAt};if(record.sessionId&&Object.hasOwn(cat.sessions,record.sessionId)){cat.sessions[record.sessionId].lastTaskId=record.taskId;cat.sessions[record.sessionId].updatedAt=record.updatedAt;}});}
 readTaskContext(id){const cat=this.readCatalog();if(!Object.hasOwn(cat.tasks,id))fail('No task matches this namespace.','TASK_NOT_FOUND');refuseLinks(this.stateRoot,taskPathsIn(this.groupDirectory(cat.tasks[id].storageKey),id).dir);return new SessionContext(this,cat.groups[cat.tasks[id].storageKey],{readOnly:true});}
 taskContext(id){const cat=this.readCatalog();if(typeof id!=='string'||!Object.hasOwn(cat.tasks,id))fail('No task matches this namespace.','TASK_NOT_FOUND');return this.context(cat.tasks[id].storageKey);}
 taskMetadata(cat,id){const ref=cat.tasks[id],group=cat.groups[ref.storageKey],file=taskPathsIn(this.groupDirectory(ref.storageKey),id).dir;refuseLinks(this.stateRoot,file);const task=readJson(path.join(file,'task.json'));assertOwner(task,group.scopeKey,id);if(task.version!==3||task.namespace!==this.namespace||task.storageKey!==ref.storageKey)fail('Corrupt task metadata.');return {task_id:id,session_id:task.sessionId??task.adoptedSessionId??null,state:task.state,phase:task.phase,workspace:task.workspace,sandbox_mode:task.sandboxMode,created_at:task.createdAt,finished_at:task.finishedAt??null,tree_exited:task.treeExited??null,quarantined:task.quarantined===true};}
 list({session_id,cursor,limit=50}={}){
  if(!Number.isSafeInteger(limit)||limit<1||limit>200)throw new TypeError('limit must be 1–200.');
  const cat=this.readCatalog(),mode=session_id===undefined?'sessions':'tasks';if(session_id!==undefined){nativeSessionId(session_id);if(!Object.hasOwn(cat.sessions,session_id))fail('No managed native session matches this namespace.','SESSION_NOT_FOUND');}
  const selected=mode==='sessions'?cat.sessionOrder:cat.taskOrder.filter(id=>cat.tasks[id].storageKey===cat.sessions[session_id].storageKey);
  const query=hash(this.namespace+'\0'+mode+'\0'+(session_id??''));let offset=0,upper=selected.length;
  if(cursor!==undefined){try{if(typeof cursor!=='string'||cursor.length>4096)throw new Error();const raw=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));const signature=raw.checksum;delete raw.checksum;if(raw.version!==1||raw.query!==query||signature!==hash(JSON.stringify(raw))||!Number.isSafeInteger(raw.offset)||!Number.isSafeInteger(raw.upper)||raw.offset<0||raw.offset>raw.upper||raw.upper>selected.length)throw new Error();offset=raw.offset;upper=raw.upper;}catch{fail('Invalid cursor for this namespace/query.','CURSOR_INVALID');}}
  const rows=[];let next=offset;while(next<upper&&rows.length<limit){const id=selected[next],row=mode==='tasks'?this.taskMetadata(cat,id):(()=>{const item=cat.sessions[id];return {session_id:id,workspace:item.workspace,verified:item.verified===true,created_at:item.createdAt,updated_at:item.updatedAt,last_task_id:item.lastTaskId,task_count:cat.taskOrder.filter(t=>cat.tasks[t].storageKey===item.storageKey).length,quarantined:fs.existsSync(path.join(this.groupDirectory(item.storageKey),'.execution-quarantine.json'))};})();if(Buffer.byteLength(JSON.stringify(rows.concat(row)))>MAX_RESPONSE_BYTES-8192){if(!rows.length)fail('A session metadata record exceeds the response limit.');break;}rows.push(row);next++;}
  const has_more=next<upper;let nextCursor=null;if(has_more){const token={version:1,query,offset:next,upper};token.checksum=hash(JSON.stringify(token));nextCursor=Buffer.from(JSON.stringify(token)).toString('base64url');}
  return {namespace:this.namespace,...(session_id===undefined?{sessions:rows}:{session_id,tasks:rows}),cursor:nextCursor,has_more};
 }
}
