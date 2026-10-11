/** Immutable internal suite limits. Legacy plans remain the complete full suite. */
export const SUITE_CAPS = Object.freeze({
  full: Object.freeze({dsh:8,host:8,high:3}),
  smoke4: Object.freeze({dsh:0,host:4,high:0}),
});
export function suiteOf(value) {
  const suite=value?.suite ?? 'full';
  if(!Object.hasOwn(SUITE_CAPS,suite)) throw new Error('Unknown acceptance suite; expected full or smoke4.');
  return suite;
}
export function acceptanceCaps(plan) { return SUITE_CAPS[suiteOf(plan)]; }
export function validateAcceptancePlan(plan) {
  const suite=suiteOf(plan),caps=acceptanceCaps(plan),hex=/^[0-9a-f]{64}$/;
  if(plan.version!==1||!['fingerprint','manifestSha256','profileFingerprint'].every(k=>hex.test(plan.candidate?.[k]))) throw new Error('Invalid acceptance plan binding.');
  const count=Object.values(caps).reduce((a,b)=>a+b,0);
  if(!Array.isArray(plan.cases)||plan.cases.length!==count||new Set(plan.cases.map(c=>c.id)).size!==count) throw new Error('A complete '+count+'-case '+suite+' plan is required.');
  for(const [batch,cap] of Object.entries(caps)) {
    const cases=plan.cases.filter(c=>c.batch===batch),prefix=suite==='smoke4'?'S':{dsh:'D',host:'H',high:'X'}[batch];
    if(cases.length!==cap||cases.some((_,i)=>!cases.some(c=>c.id===prefix+(i+1)))||cases.some(c=>!c.args||c.args.provider||c.args.model||!Array.isArray(c.expectedStates))) throw new Error('Invalid bounded matrix cases.');
  }
  if(suite==='smoke4') {
    const expected={S1:['A','read-only',true,600000,'completed',[]],S2:['B','workspace-write',true,600000,'cancelled',['active:S1']],S3:['B','read-only',false,600000,'completed',['S1','S2']],S4:['A','read-only',true,120000,'timeout',['S3']]};
    for(const c of plan.cases) {
      const e=expected[c.id],a=c.args;
      if(c.identity||c.chat!==e[0]||a.sandbox_mode!==e[1]||a.new_session!==e[2]||a.timeout_ms!==e[3]||c.expectedStates.length!==1||c.expectedStates[0]!==e[4]||JSON.stringify(c.predecessors)!==JSON.stringify(e[5])||c.observation?.maxChildren!==0||c.resumeOf!==(c.id==='S3'?'S2':null)||a.background!==(c.id!=='S1')) throw new Error('smoke4 is restricted to the exact four host cases, no children, overrides or full access.');
    }
    const get=id=>plan.cases.find(c=>c.id===id);
    if(get('S1').args.workspace!==get('S4').args.workspace||get('S2').args.workspace!==get('S3').args.workspace||get('S1').args.workspace===get('S2').args.workspace) throw new Error('smoke4 requires distinct A/B workspaces and exact continuation workspace.');
  }
  return {suite,caps};
}
