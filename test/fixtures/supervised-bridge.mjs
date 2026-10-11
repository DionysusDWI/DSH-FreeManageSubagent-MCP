/** Real stdio lifecycle and Job guardian, but ONLY local Node children. */
import { createBridgeServer } from '../../lib/server.js';
import { serveStdio } from '../../lib/stdio-lifecycle.js';
import { supervise } from '../../lib/supervisor.js';
const bridge=createBridgeServer({env:process.env,runTaskImpl:async input=> {
  const script='const {spawn}=require("node:child_process");const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});console.log("grandchild="+child.pid);setInterval(()=>{},1000);';let ids;
  const outcome=await supervise({command:process.execPath,args:['-e',script],cwd:input.workspace,env:process.env,signal:input.signal,graceMs:50,
    onStarted:started=>{ids=started;input.onProcess(started);},onStdout:bytes=>{const m=/grandchild=(\d+)/.exec(bytes.toString('utf8'));if(m) input.onReport({eventId:'pids',text:'test process tree',data:{pid:ids.pid,grandchild:Number(m[1]),worker:ids.workerPid,guardian:ids.guardianPid}});}});
  return {state:input.signal.aborted?'cancelled':'completed',reason:{kind:input.signal.aborted?'cancelled':'completed'},treeExited:outcome.treeExited,exitCode:outcome.code};
}});
await serveStdio(bridge.server);
