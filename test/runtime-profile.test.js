import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { locateDsh } from '../lib/dsh-locate.js';
import { resolveRuntime,profileTarget,ensureBridgeProfile,isBridgeProfileReady,BRIDGE_PLUGIN_NAME,buildProfileManifest } from '../lib/dsh-profile.js';
import { tempDir,isolatedEnv } from './helpers.js';
function asar(file) {
  const code=Buffer.from('// test launcher'),entry={files:{}};let node=entry;
  const parts=['dsh','node_modules','@deepseek-ai','dsh-desktop-host','lib','cli.js'];
  for(const name of parts.slice(0,-1)) {node.files[name]={files:{}};node=node.files[name];}
  node.files['cli.js']={size:code.length,offset:'0'};
  const header=Buffer.from(JSON.stringify(entry)),first=Buffer.alloc(16);first.writeUInt32LE(4,0);first.writeUInt32LE(header.length+8,4);first.writeUInt32LE(header.length+4,8);first.writeUInt32LE(header.length,12);
  fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,Buffer.concat([first,header,code]));
}
function fixture(t) {const {dir,cleanup}=tempDir('runtime-profile');t.after(cleanup);const script=path.join(dir,'cli.js');fs.writeFileSync(script,'// test');const env=isolatedEnv(dir,{DSH_HOME:path.join(dir,'shared-home'),DSH_MCP_DSH:script});return {dir,env,runtime:resolveRuntime(env)};}
test('explicit install root, executable and archive CLI all resolve the pinned installation',t=> {
  const {dir,cleanup}=tempDir('launcher');t.after(cleanup);const root=path.join(dir,'install'),exe=path.join(root,'DeepSeek Harness.exe'),archive=path.join(root,'resources','app.asar');fs.mkdirSync(root);fs.writeFileSync(exe,'fake');asar(archive);
  const cli=path.join(archive,'dsh','node_modules','@deepseek-ai','dsh-desktop-host','lib','cli.js');
  for(const pin of [root,exe,cli]) {const spec=locateDsh({env:{DSH_MCP_DSH:pin}});assert.equal(spec.installRoot,root);assert.equal(spec.command,exe);assert.equal(spec.source,'DSH_MCP_DSH');}
});
test('invalid explicit launcher fails instead of using another installed version',()=> {
  assert.throws(()=>locateDsh({env:{...process.env,DSH_MCP_DSH:path.join(process.cwd(),'missing-launcher.exe')}}),{code:'INVALID_DSH_PATH'});
});
test('launcher discovery uses the supplied environment and does not probe the real process environment',t=> {
  const f=fixture(t);assert.equal(f.runtime.launcher.launcherScript,path.join(f.dir,'cli.js'));assert.equal(f.runtime.env.DSH_HOME,path.join(f.dir,'shared-home'));assert.equal(f.runtime.home,f.runtime.env.DSH_HOME);
});
test('manual legacy profiles are not overwritten and missing authorization blocks provisioning',async t=> {
  const f=fixture(t),legacy=path.join(f.runtime.home,'profiles','dsh-mcp-bridge');fs.mkdirSync(legacy,{recursive:true});const marker='{"user":"maintained"}';fs.writeFileSync(path.join(legacy,'package.json'),marker);
  await assert.rejects(ensureBridgeProfile({env:f.env,runtime:f.runtime}),{code:'PROVISION_AUTHORIZATION_REQUIRED'});assert.equal(fs.readFileSync(path.join(legacy,'package.json'),'utf8'),marker);
});
test('concurrent provisioning installs once, validates actual copy, and reuses immutable snapshot',async t=> {
  const f=fixture(t);let installs=0;
  async function install(options) {installs++;assert.equal(options.runtime,f.runtime);const target=profileTarget({env:f.env,runtime:f.runtime});assert.ok(options.args.includes(target.name));await new Promise(r=>setTimeout(r,30));fs.cpSync(path.join(target.dir,'vendor',BRIDGE_PLUGIN_NAME),path.join(target.dir,'node_modules',BRIDGE_PLUGIN_NAME),{recursive:true});return {code:0,stderr:'',stdout:''};}
  const opts={env:f.env,runtime:f.runtime,allowProvision:true,runDshImpl:install};const [a,b]=await Promise.all([ensureBridgeProfile(opts),ensureBridgeProfile(opts)]);
  assert.equal(installs,1);assert.equal(a.fingerprint,b.fingerprint);assert.equal(isBridgeProfileReady(opts),true);const again=await ensureBridgeProfile(opts);assert.equal(again.changed,false);assert.equal(installs,1);
});
test('stale file: installed copy is not ready and cannot overwrite an active immutable profile',async t=> {
  const f=fixture(t);const opts={env:f.env,runtime:f.runtime,allowProvision:true,runDshImpl:async()=> {const target=profileTarget({env:f.env,runtime:f.runtime});fs.cpSync(path.join(target.dir,'vendor',BRIDGE_PLUGIN_NAME),path.join(target.dir,'node_modules',BRIDGE_PLUGIN_NAME),{recursive:true});return {code:0};}};
  const profile=await ensureBridgeProfile(opts),installed=path.join(profile.dir,'node_modules',BRIDGE_PLUGIN_NAME,'index.js');fs.writeFileSync(installed,'// stale version');
  assert.equal(isBridgeProfileReady(opts),false);await assert.rejects(ensureBridgeProfile(opts),{code:'PROFILE_INTEGRITY_FAILED'});assert.equal(fs.readFileSync(installed,'utf8'),'// stale version');
});
test('profile update produces a new immutable snapshot without changing the previous plugin copy',async t=> {
  const f=fixture(t),pluginDir=path.join(f.dir,'plugin');fs.mkdirSync(pluginDir);fs.writeFileSync(path.join(pluginDir,'package.json'),JSON.stringify({name:BRIDGE_PLUGIN_NAME,version:'1',type:'module'}));fs.writeFileSync(path.join(pluginDir,'index.js'),'// v1');
  const opts={env:f.env,runtime:f.runtime,pluginDir,allowProvision:true,runDshImpl:async()=> {const target=profileTarget({env:f.env,runtime:f.runtime,pluginDir});fs.cpSync(path.join(target.dir,'vendor',BRIDGE_PLUGIN_NAME),path.join(target.dir,'node_modules',BRIDGE_PLUGIN_NAME),{recursive:true});return {code:0};}};
  const first=await ensureBridgeProfile(opts);fs.writeFileSync(path.join(pluginDir,'index.js'),'// v2');const second=await ensureBridgeProfile(opts);assert.notEqual(first.dir,second.dir);assert.equal(fs.readFileSync(path.join(first.dir,'node_modules',BRIDGE_PLUGIN_NAME,'index.js'),'utf8'),'// v1');
});
test('manifest builder preserves human extra metadata and dependency fields',()=> {
  const manifest=buildProfileManifest({name:'manual',description:'keep',engines:{node:'>=20'},dependencies:{other:'1'},dsh:{extra:true,profile:{custom:1,bundles:['bundle']}}},'./plugin');assert.equal(manifest.description,'keep');assert.equal(manifest.dependencies.other,'1');assert.equal(manifest.dsh.extra,true);assert.equal(manifest.dsh.profile.custom,1);
});

test('empty explicit launcher overrides do not fall back to an installed copy',()=> {for(const value of ['', '   '])assert.throws(()=>locateDsh({env:{...process.env,DSH_MCP_DSH:value}}),{code:'INVALID_DSH_PATH'});});
