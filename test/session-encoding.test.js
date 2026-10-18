import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {detectSessionCompression} from '../lib/session-encoding.js';
import {buildOverlayPatches} from '../lib/overlay.js';
import {writeJsonAtomic} from '../dsh-plugin/io.js';
import {tempDir} from './helpers.js';
for(const [suffix,expected] of [['.jsonl.zstd','zstd'],['.jsonl','none']])test('native copied-root encoding '+expected+' is selected without decoding or writes',t=>{
  const f=tempDir('encoding-'+expected);t.after(f.cleanup);
  const dir=path.join(f.dir,'project','session-id');fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,'session.v4'+suffix),bytes=Buffer.from([0,255,1,128]);fs.writeFileSync(file,bytes);
  assert.equal(detectSessionCompression(f.dir),expected);assert.deepEqual(fs.readFileSync(file),bytes);
});
test('mixed native encodings fail without converting or selecting a fallback',t=>{
  const f=tempDir('encoding-mixed');t.after(f.cleanup);
  for(const name of ['session.v4.jsonl','session.v4.jsonl.zstd'])fs.writeFileSync(path.join(f.dir,name),'untouched');
  assert.throws(()=>detectSessionCompression(f.dir),{code:'SESSION_ENCODING_MIXED'});
  for(const name of fs.readdirSync(f.dir))assert.equal(fs.readFileSync(path.join(f.dir,name),'utf8'),'untouched');
});
test('empty copied roots match pinned native Zstandard default',t=>{const f=tempDir('encoding-empty');t.after(f.cleanup);assert.equal(detectSessionCompression(f.dir),'zstd');});
test('copied-root detector rejects links instead of following external storage',t=>{
  const f=tempDir('encoding-link');t.after(f.cleanup);const target=path.join(f.dir,'target'),root=path.join(f.dir,'root');fs.mkdirSync(target);fs.mkdirSync(root);fs.symlinkSync(target,path.join(root,'linked'),process.platform==='win32'?'junction':'dir');assert.throws(()=>detectSessionCompression(root),/links are refused/);
});
test('whole native persistence row preserves detected encoding and defaults to Zstandard',()=>{
  const options={workspace:process.cwd(),storageRoot:'storage',sessionRoot:'sessions'};
  for(const value of ['none','zstd'])assert.deepEqual(buildOverlayPatches({...options,sessionCompression:value}).find(p=>p.id==='session-persistence-jsonl').config,{root:'sessions',compression:value});
  assert.equal(buildOverlayPatches(options).find(p=>p.id==='session-persistence-jsonl').config.compression,'zstd');
  assert.throws(()=>buildOverlayPatches({...options,sessionCompression:'auto'}),/Unsupported/);
});
test('atomic replace retries only transient Windows sharing errors and retains JSON',t=>{
  const f=tempDir('replace-sharing');t.after(f.cleanup);const file=path.join(f.dir,'control.json');writeJsonAtomic(file,{old:true});const rename=fs.renameSync;let calls=0;
  t.mock.method(fs,'renameSync',(a,b)=>{calls++;if(calls<3)throw Object.assign(new Error('sharing lock'),{code:'EPERM'});return rename(a,b);});
  if(process.platform==='win32'){writeJsonAtomic(file,{cancel:true});assert.equal(calls,3);assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),{cancel:true});}
  else {assert.throws(()=>writeJsonAtomic(file,{cancel:true}),{code:'EPERM'});assert.equal(calls,1);}
  assert.equal(fs.readdirSync(f.dir).length,1);
});
for(const code of ['EACCES','EIO'])test('atomic replace '+code+' remains bounded and never changes ACLs or old content',t=>{
  const f=tempDir('replace-fail-'+code);t.after(f.cleanup);const file=path.join(f.dir,'control.json');writeJsonAtomic(file,{old:true});let calls=0;
  t.mock.method(fs,'renameSync',()=>{calls++;throw Object.assign(new Error('persistent failure'),{code});});assert.throws(()=>writeJsonAtomic(file,{cancel:true}),{code});assert.equal(calls,code==='EACCES'&&process.platform==='win32'?8:1);assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),{old:true});assert.equal(fs.readdirSync(f.dir).length,1);
});
