/** Production stdio lifecycle; also exercised by the no-model bridge fixture. */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
export async function serveStdio(server,{onDiagnostic=()=>{},shutdownMs=12000}={}) {
  const transport=new StdioServerTransport();let stopping=false;
  async function shutdown(reason) {
    if(stopping)return;stopping=true;onDiagnostic('stopping: '+reason);
    const deadline=setTimeout(()=>{onDiagnostic('Shutdown budget exceeded; guardian IPC will close.');process.exit(1);},shutdownMs);deadline.unref();
    try{await server.close();}catch(error){onDiagnostic('shutdown: '+error.message);process.exitCode=1;}finally{clearTimeout(deadline);}
  }
  process.stdin.once('end',()=>shutdown('stdin EOF'));process.stdin.once('error',error=>shutdown('stdin error: '+error.message));process.stdout.once('error',error=>shutdown('stdout error: '+error.message));
  process.once('SIGINT',()=>shutdown('SIGINT'));process.once('SIGTERM',()=>shutdown('SIGTERM'));
  process.once('uncaughtException',error=>{process.exitCode=1;shutdown('uncaught exception: '+error.message);});
  process.once('unhandledRejection',error=>{process.exitCode=1;shutdown('unhandled rejection: '+(error?.message ?? String(error)));});
  await server.connect(transport);return {transport,shutdown};
}
