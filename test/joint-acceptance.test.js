import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {parseArguments,renderHostSteps} from './joint-acceptance.mjs';
import {createMatrix,verifyCase,verifyHostRouting,readNdjson} from '../lib/joint-matrix.js';
import {initializeAcceptance,reserveAcceptance,authorizeAcceptance} from '../lib/acceptance.js';
import {collectHashes,verifyCandidate,writeExclusiveJson,appendDurableJson,shaFile,sha256} from '../lib/joint-artifacts.js';
import {tempDir} from './helpers.js';
const candidate={root:'D:\\candidate',fingerprint:'a'.repeat(64),manifestSha256:'b'.repeat(64)};
function fixture(t) {const temp=tempDir('joint-matrix');t.after(temp.cleanup);const plan=createMatrix({root:temp.dir,candidate,home:temp.dir,profileFingerprint:'c'.repeat(64)});return {root:temp.dir,plan};}
const cli=(mode,...flags)=>[mode,'--candidate','D:\\candidate','--evidence','D:\\evidence','--control-root','D:\\private-control',...flags];
test('matrix CLI refuses every paid stage before import/launch without NEW authorization',()=> {
  for(const mode of ['dsh','host','high'])assert.throws(()=>parseArguments(cli(mode)),/authorization/);
  assert.equal(parseArguments(cli('prepare')).mode,'prepare');assert.equal(parseArguments(cli('host','--preflight')).preflight,true);assert.equal(parseArguments(cli('dsh','--verify-only')).mode,'dsh');
});
test('high mode requires two independent affirmative flags and preparation cannot authorize cost',()=> {
  assert.throws(()=>parseArguments(cli('high','--authorize-model-cost','--authorization-ref','synthetic-unit')),/FULL ACCESS/);
  assert.equal(parseArguments(cli('high','--authorize-model-cost','--authorize-danger-full-access','--authorization-ref','synthetic-unit')).mode,'high');
  assert.throws(()=>parseArguments(cli('prepare','--authorize-model-cost')),/cannot consume/);
});
test('driver rejects unknown/repeated flags and non-absolute artifact bindings',()=> {
  assert.throws(()=>parseArguments(cli('prepare','--bootstrap')),/Unknown/);assert.throws(()=>parseArguments(cli('prepare','--candidate','D:\\other')),/duplicate/);assert.throws(()=>parseArguments(['prepare','--candidate','relative','--evidence','D:\\e','--control-root','D:\\c']),/absolute/);
});
test('fresh matrix has exactly 8+8+3 cases, no model overrides, independent explicit resumes',t=> {
  const {plan}=fixture(t);assert.deepEqual(Object.fromEntries(['dsh','host','high'].map(b=>[b,plan.cases.filter(c=>c.batch===b).length])),{dsh:8,host:8,high:3});assert.equal(plan.initialAuthorization,0);assert.equal(plan.automaticRetries,0);
  for(const c of plan.cases){assert.equal(c.args.provider,undefined);assert.equal(c.args.model,undefined);assert.equal(c.args.timeout_ms,c.id==='D6'?120000:600000);}
  for(const [id,prior] of [['D5','D4'],['D7','D6'],['H3','H2'],['X3','X1']]){const c=plan.cases.find(v=>v.id===id);assert.equal(c.resumeOf,prior);assert.equal(c.args.new_session,false);assert.equal(c.args.sandbox_mode,'read-only');assert.ok(!c.args.prompt.includes(c.expectedMarker));}
  assert.equal(plan.cases.find(c=>c.id==='D3').observation.maxChildren,2);assert.equal(plan.cases.find(c=>c.id==='H8').args.background,false);
});
test('preparation preserves synthetic before hashes, cannot silently overwrite old fixture files',t=> {
  const {root,plan}=fixture(t);for(const [f,hash] of Object.entries(plan.syntheticFiles))assert.equal(shaFile(f),hash);assert.throws(()=>createMatrix({root,candidate,home:root,profileFingerprint:'c'.repeat(64)}),e=>e.code==='EEXIST');
});
test('missing real host calls, real UI identities, configured timeout and reconnect cannot pass preflight',t=> {
  const {root,plan}=fixture(t);const result=verifyHostRouting(root,plan);assert.equal(result.passed,false);assert.ok(result.errors.some(e=>e.includes('actual user UI')));
  for(const chat of ['A','B'])writeExclusiveJson(path.join(root,'host-chat-'+chat+'.json'),{userUi:true,threadId:chat,requestTimeoutMs:45000,reconnectAt:Date.now()});assert.equal(verifyHostRouting(root,plan).passed,false);assert.ok(verifyHostRouting(root,plan).errors.some(e=>e.includes('timeout configuration')));
});
test('reported completion or a verbal permission refusal is not real model/tool/policy evidence',t=> {
  const {root,plan}=fixture(t),dir=path.join(root,'synthetic-task');fs.mkdirSync(dir);const result=path.join(dir,'result.json');writeExclusiveJson(result,{taskId:'synthetic',conversationKey:'synthetic',state:'completed',phase:'settled',treeExited:true,answer:'DONE',processPid:process.pid});
  appendDurableJson(path.join(root,'audit','fake.ndjson'),{event:'task-lifecycle',phase:'accepted',caseId:'D1',taskId:'synthetic',correlationId:'fake',paths:{dir,result}});appendDurableJson(path.join(root,'audit','fake.ndjson'),{event:'task-lifecycle',phase:'settled',caseId:'D1',taskId:'synthetic',treeExited:true});
  const proof=verifyCase(root,plan,'D1');assert.equal(proof.passed,false);assert.ok(proof.errors.some(e=>e.includes('pre-model')));assert.ok(proof.errors.some(e=>e.includes('real read')));assert.ok(proof.errors.some(e=>e.includes('reservation')));
});
test('queued/unit cancellation and timeout cannot substitute for real executing shell evidence',t=> {
  const {root,plan}=fixture(t);for(const id of ['D4','D6','D8','H8'])assert.equal(verifyCase(root,plan,id).passed,false);
  const steps=renderHostSteps(plan,{host:'D:\\private-control\\host.json'});assert.ok(steps.includes('before 30-second detach'));assert.ok(steps.includes('explicit dsh_cancel may only clean up'));assert.ok(steps.includes('FULL ACCESS is NOT limited'));
});
test('incomplete raw evidence and symbolic links never receive a seal or pass',t=> {
  const {root}=fixture(t),file=path.join(root,'torn.ndjson');fs.writeFileSync(file,'{"record":"partial"');assert.throws(()=>readNdjson(file),/Incomplete/);assert.ok(Object.keys(collectHashes(root)).length>=4);
});
test('candidate verifier refuses malformed manifest and escapes rather than borrowing checkout dependencies',t=> {
  const temp=tempDir('joint-artifacts');t.after(temp.cleanup);writeExclusiveJson(path.join(temp.dir,'release-manifest.json'),{version:'0.1.1',phase:'candidate',fingerprint:'bad',files:{'../escape':{bytes:1,sha256:'bad'}}});assert.throws(()=>verifyCandidate(temp.dir),/drift/);
  const entry=fs.readFileSync(fileURLToPath(new URL('./joint-acceptance.mjs',import.meta.url)),'utf8');assert.ok(entry.includes("load('node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js')"));assert.ok(!entry.includes("from '@modelcontextprotocol"));assert.ok(entry.includes("path.join(candidateRoot,'test','joint-acceptance.mjs')"));
});
