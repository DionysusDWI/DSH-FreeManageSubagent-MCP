import {processAlive} from './file-lock.js';
/** A 64-KiB budget covers BOTH readable and structured tool content. */
import { boundUtf8 } from './io.js';
import { TERMINAL_STATES } from './store.js';
export const MAX_RESPONSE_BYTES=64*1024;
const SAFE_BUDGET=MAX_RESPONSE_BYTES-512;
const bytes=value=>Buffer.byteLength(JSON.stringify(value),'utf8');
function reportView(report,fullPath,maxText=8192) {
  const text=boundUtf8(report.text,maxText);
  const value={seq:report.seq,event_id:report.eventId,kind:report.kind,text:text.text,ts:report.ts};
  if(report.agentId) value.agent_id=report.agentId; if(report.agentRole) value.agent_role=report.agentRole;
  if(report.data!==undefined) {
    if(bytes(report.data)>8192) value.data_truncated=true; else value.data=report.data;
  }
  if(text.truncated||report.truncated||report.dataTruncated||value.data_truncated) {value.truncated=true;value.full_content_path=report.fullContentPath ?? fullPath;}
  return value;
}
function render(view,task,message,dispatch) {
  const lines=['task_id: '+view.task_id,'state: '+view.state,'session_id: '+(view.session_id ?? 'unknown'),'cursor: '+view.cursor,'has_more: '+view.has_more];
  if(message) lines.push('',message);
  lines.push('',dispatch?'DSH task '+task.taskId+' '+task.state+' in '+Math.round(view.duration_ms/1000)+'s (sandbox '+task.sandboxMode+').'
    :'task '+task.taskId+' · '+task.state+' · '+Math.round(view.duration_ms/1000)+'s');
  if(view.reports?.length) {lines.push('','reports:');for(const r of view.reports) lines.push('['+r.seq+' '+r.kind+(r.agent_role==='subagent'?' subagent':'')+'] '+r.text+(r.data===undefined?'':' '+JSON.stringify(r.data))+(r.truncated?' …[truncated; full record on disk]':''));}
  else lines.push('','reports: none since the requested cursor.');
  if(view.has_more) lines.push('More reports available; call dsh_status with this cursor.');
  if(view.answer) lines.push('','final answer:',view.answer);
  if(view.error) lines.push('','failure: '+view.error.message);
  if(view.output_persisted===false)lines.push('','[persistence failed] Complete output could not be saved; do not assume the artifact exists.');
  if(view.truncated) lines.push('',view.full_content_path?'[truncated] Full content: '+view.full_content_path:'[truncated] Full output is unavailable because persistence failed.');
  return lines.join('\n');
}
export function taskResponse(context,task,{since=0,limit=50,message='',dispatch=false,isError=false}={}) {
  const latest=context.queue.latestSeq(task.taskId), candidates=context.queue.list({taskId:task.taskId,since,limit:limit+1});
  const reasonText=task.reason&&task.state!=='completed'?boundUtf8(task.reason.message ?? task.reason.error?.message ?? task.reason.kind ?? task.state,4096):null;
  let reason=reasonText?{...task.reason,message:reasonText.text,...(reasonText.truncated?{truncated:true,full_content_path:context.taskPaths(task.taskId).result}:{})}:undefined;
  if(reason?.code!==undefined)reason.code=String(reason.code);
  if(reason&&bytes(reason)>8192) reason={kind:task.reason.kind,code:task.reason.code ?? task.reason.error?.code,message:reason.message,truncated:true,full_content_path:context.taskPaths(task.taskId).result};
  const view={task_id:task.taskId,state:task.state,session_id:task.sessionId ?? null,cursor:since,has_more:latest>since,
    recovery_required:task.quarantined===true||(!TERMINAL_STATES.has(task.state)&&processAlive(task.executorPid)!==true),phase:task.phase ?? task.state,duration_ms:Math.max(0,(task.finishedAt ?? Date.now())-task.createdAt),report_count:latest,
    reports:[],full_content_path:context.taskPaths(task.taskId).result};
  if(task.fullContentAvailable===false){delete view.full_content_path;view.output_persisted=false;if(reason)delete reason.full_content_path;}
  if(reason) {if(reason.code!==undefined)reason.code=String(reason.code);view.error=reason;if(reason.truncated)view.truncated=true;}
  if(TERMINAL_STATES.has(task.state)&&task.answer) {const answer=boundUtf8(task.answer,20000);view.answer=answer.text;if(answer.truncated){view.truncated=true;view.answer_truncated=true;}}
  message=boundUtf8(message,2048).text;
  function response() {return {content:[{type:'text',text:render(view,task,message,dispatch)}],structuredContent:view,...(isError?{isError:true}:{})};}
  // Reserve a working response before adding reports; shorten an oversized answer first.
  while(bytes(response())>SAFE_BUDGET && view.answer?.length) {view.answer=boundUtf8(view.answer,Math.floor(Buffer.byteLength(view.answer)/2)).text;view.truncated=true;view.answer_truncated=true;}
  for(const candidate of candidates.slice(0,limit)) {
    const report=reportView(candidate,context.queue.logPath);
    view.reports.push(report);view.cursor=report.seq;view.has_more=latest>view.cursor;
    if(bytes(response())>SAFE_BUDGET) {
      view.reports.pop();view.cursor=view.reports.at(-1)?.seq ?? since;view.has_more=latest>view.cursor;
      if(!view.reports.length) {
        const minimal=reportView(candidate,context.queue.logPath,1024);delete minimal.data;minimal.truncated=true;minimal.data_truncated=candidate.data!==undefined;minimal.full_content_path=context.queue.logPath;
        view.reports.push(minimal);view.cursor=minimal.seq;view.has_more=latest>view.cursor;view.truncated=true;
      }
      break;
    }
  }
  if(view.reports.some(r=>r.truncated)) view.truncated=true;
  const result=response();
  if(bytes(result)>SAFE_BUDGET) return toolError('Response control fields exceed the response budget; full task output remains on disk.','RESPONSE_BUDGET_EXCEEDED');
  return result;
}
export function toolError(message,code='BRIDGE_ERROR') {
  const text=boundUtf8(message,8192);return {content:[{type:'text',text:text.text+(text.truncated?' …[truncated]':'')}],isError:true,
    structuredContent:{task_id:null,state:null,session_id:null,cursor:0,has_more:false,error:{code,message:text.text},truncated:text.truncated}};
}
export function diagnosticResponse(text,structuredContent) {
  const bounded=boundUtf8(text,24000); const result={content:[{type:'text',text:bounded.text+(bounded.truncated?'\n[truncated]':'')}],...(structuredContent?{structuredContent}: {})};
  if(bytes(result)>SAFE_BUDGET) return {content:[{type:'text',text:bounded.text}],truncated:true}; return result;
}
