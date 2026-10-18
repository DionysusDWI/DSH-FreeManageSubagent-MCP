/** Read-only capability inventory, deliberately separate from provisioning and active probes. */
import fs from 'node:fs';
import path from 'node:path';
import {resolveRuntime,inspectBridgeProfile} from './dsh-profile.js';
import {readAsarFile} from './asar.js';
import {repoRoot} from './paths.js';
import {diagnoseCredentialEnvironment} from './credential-environment.js';
import {PERMISSION_MODES,UPSTREAM_PERMISSION_MODES,REASONING_EFFORTS,QUESTION_POLICIES,DEFAULT_ROUTE} from './task-config.js';
import {BRIDGE_VERSION,DSH_BASELINE,DSH_SOURCE_COMMIT,PROFILE_GENERATION,SDK_WIRE_VERSION} from './compatibility.js';
export {DSH_BASELINE,DSH_SOURCE_COMMIT};
export function capabilities({env=process.env,credentialEnvironmentOptions}={}) {
  let runtime=null,profile=null,diagnostic=null;
  try {runtime=resolveRuntime(env);profile=inspectBridgeProfile({env,runtime});}catch(error){diagnostic=error.message;}
  const packages={};
  for(const name of ['sdk-app','sdk-jsonrpc-server','experimental-auto-review','user-questions','working-directory']) {
    try {const manifest=JSON.parse(readAsarFile(runtime.launcher.archive,'dsh/node_modules/@deepseek-ai/dsh-'+name+'/package.json').toString('utf8'));packages[name]={present:true,version:manifest.version};}
    catch{packages[name]={present:false,version:null};}
  }
  return {
    bridge_version:BRIDGE_VERSION,profile_generation:PROFILE_GENERATION,dsh_version:runtime?.version??null,baseline:{version:DSH_BASELINE,commit:DSH_SOURCE_COMMIT,supported:runtime?.version===DSH_BASELINE},
    transport:{name:'official-sdk-jsonrpc',wire_version:SDK_WIRE_VERSION,guardian_protocol:2,duplex:true,listener:false,per_task_process:true},
    permission_modes:[...PERMISSION_MODES],default_permission_mode:'workspace-write',upstream_permission_modes:[...UPSTREAM_PERMISSION_MODES],
    upstream_declaration_verified:false,inherit_mapping:{'read-only':'read-only','workspace-write':'workspace-write','full-access':'auto'},
    direct_full_access_selectable:false,native_reviewed_full_access_allowed:true,approval_outcomes:['allowed-once','rejected','cancelled'],
    reasoning_efforts:[...REASONING_EFFORTS],default_route:DEFAULT_ROUTE,reasoning_default:'native-model-default',unsupported_reasoning:'error-no-downgrade',
    question_policies:[...QUESTION_POLICIES],default_question_policy:'pause',continue_timeout_seconds:120,
    native_plan_review:'blocking-with-original-intent',late_answers:'explicit-session-resume-task',configuration_updates:'start-or-explicit-continuation-only',
    verification:{profile:{ready:profile?.ready??false,fingerprint:profile?.fingerprint??null,reason:profile?.reason??diagnostic},
      packages,features:{available:runtime?.version===DSH_BASELINE&&Object.values(packages).every(p=>p.present),
        runtime_verified:false,required:'SDK initialize, native preset/Auto registration and persistence must be verified at each launch; inventory is not an active probe.'},
      guardian:{present:fs.existsSync(path.join(repoRoot(),'native','windows-job-host.exe')),verified:false,required:'protocol handshake and OS-token preflight'},
      credentials:diagnoseCredentialEnvironment(env,credentialEnvironmentOptions),credential_authorization_verified:false},
    limits:{mcp_response_bytes:65536,request_detail_page_bytes:16384,native_interaction_storage_bytes:8388608,guardian_input_bytes:1048576},
    costs:{submitted_tasks_are_model_requests:false,auto_review:'Native Auto may issue additional reviewer requests for supported tools/started PTC inner calls; run_code transport is not separately reviewed. Actual counts require provider-dispatch observation.',late_answer:'An explicit continuation can start new agent model requests.',unobserved_model_request_counts:null},
    provisioning_performed:false,model_calls:0,...(diagnostic?{diagnostic}:{})};
}
