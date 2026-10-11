#!/usr/bin/env node
import { serveStdio } from '../lib/stdio-lifecycle.js';
import { createBridgeServer, BRIDGE_VERSION } from '../lib/server.js';
import { ensureBridgeProfile, resolveRuntime, inspectBridgeProfile, assertCompatibleRuntime } from '../lib/dsh-profile.js';
function note(message) { try {process.stderr.write('codex-dsh-mcp: '+message+'\n');} catch {} }
async function bootstrap() {
  try {
    const runtime=resolveRuntime();assertCompatibleRuntime(runtime);note('DSH '+(runtime.version ?? 'unknown')+' launcher: '+runtime.launcher.command);note('DSH home: '+runtime.home);
    const profile=await ensureBridgeProfile({runtime,env:runtime.env,allowProvision:true,onDiagnostic:note});
    note('profile ready: '+profile.dir);note('profile fingerprint: '+profile.fingerprint);return 0;
  } catch(error) {note('bootstrap failed: '+error.message);return 1;}
}
async function serve() {
  const {server}=createBridgeServer({onDiagnostic:note});await serveStdio(server,{onDiagnostic:note});note('v'+BRIDGE_VERSION+' listening on stdio');
}
if(process.argv.includes('--bootstrap')||process.argv.includes('bootstrap')) process.exitCode=await bootstrap();
else if(process.argv.includes('--diagnose')) {
  try { const runtime=resolveRuntime(),profile=inspectBridgeProfile({runtime,env:runtime.env}); if(!profile.ready)note(profile.reason); console.log(JSON.stringify({version:BRIDGE_VERSION,launcher:runtime.launcher,home:runtime.home,dshVersion:runtime.version,profile:profile.name,fingerprint:profile.fingerprint,ready:profile.ready,readinessScope:'profile-content-only',dshBaselineSupported:runtime.version==='0.2.0-rc.2',guardianPreflight:'not-run'},null,2)); }
  catch(error){note(error.message);process.exitCode=1;}
} else {try{await serve();}catch(error){note('startup failed: '+error.message);process.exitCode=1;}}
