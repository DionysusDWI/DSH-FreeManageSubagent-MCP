/** Synthetic CLI for the real Guardian/runner contract. No DSH SDK or model. */
import fs from 'node:fs';
import path from 'node:path';
const {DSH_MCP_CHANNEL:channel, DSH_MCP_SCOPE:conversationKey, DSH_MCP_TASK:taskId,
  DSH_MCP_WORKSPACE:workspace, DSH_MCP_SANDBOX:sandboxMode} = process.env;
const sessionId = 'session-synthetic-completion';
fs.writeFileSync(path.join(path.dirname(channel), 'policy.json'), JSON.stringify({
  version:2, conversationKey, taskId, sessionId, agentId:sessionId, agentRole:'main',
  approvalPolicy:sandboxMode === 'danger-full-access' ? 'never' : 'ask',
  workspace, sandboxMode, verified:true,
}));
const write = event => process.stdout.write(JSON.stringify(event) + '\n');
write({type:'session', sessionId, cwd:workspace});
write({type:'status', phase:'turn_start', turn:1});
write({type:'status', phase:'step_start', turn:1, step:1});
write({type:'text', text:'synthetic progress, not a final answer', truncated:true});
setTimeout(() => {
  process.stderr.write('SYNTHETIC_STDERR_TAIL\n');
  write({type:'status', phase:'step_end', turn:1, step:1});
  write({type:'status', phase:'turn_end', turn:1, reason:{kind:'completed'}});
  if (process.env.SYNTHETIC_END_MODE !== 'omit-final') {
    const text = process.env.SYNTHETIC_ANSWER === 'large'
      ? 'SYNTHETIC_COMPLETE:' + 'ёж✓'.repeat(20000) : 'SYNTHETIC_COMPLETE';
    write({type:'final', text});
  }
}, 20);
