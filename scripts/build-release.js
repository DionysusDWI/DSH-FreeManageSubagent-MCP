/** Build a private/local Windows candidate; never publish, bootstrap or run a model. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync,execFileSync} from 'node:child_process';
import {repoRoot} from '../lib/paths.js';
import {ensureStageDir,placeWithoutLowLabel,verifyGuardianArtifact,readIntegrityLabel,guardianError,IMAGE_LOW,LABEL_UNVERIFIED} from '../lib/win-integrity.js';
import {validatePackage} from './validate-package.js';
import {checkRelease} from './check-release.js';
import {publicPackageFiles,scanPublicFiles} from './public-files.js';
if(process.platform!=='win32')throw new Error('This candidate packages the Windows Job Object guardian. Other platforms are not release-qualified.');
const root=repoRoot(),dist=path.join(root,'dist'),pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
if(process.version!=='v24.19.0'||process.arch!=='x64')throw new Error('Release requires Node 24.19.0 Windows x64.');
const sourceCommit=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
if(execFileSync('git',['status','--porcelain','--untracked-files=no'],{cwd:root,encoding:'utf8'}).trim())throw new Error('Commit public source changes before packaging.');
scanPublicFiles(root);validatePackage(root);fs.mkdirSync(dist,{recursive:true});
const helper=path.join(root,'native','windows-job-host.exe'),source=path.join(root,'native','windows-job-host.cs');
if(!fs.existsSync(helper)||fs.statSync(helper).mtimeMs<fs.statSync(source).mtimeMs)throw new Error('Run npm run build:native before packaging; missing/stale guardian is refused.');
const nodeLicense=path.join(root,'docs','.doc-cache','node-'+process.version+'-LICENSE');
if(!fs.existsSync(nodeLicense))throw new Error('The matching official Node '+process.version+' LICENSE is required in docs/.doc-cache for redistribution.');
const staging=path.join(dist,'.building-'+crypto.randomUUID());fs.mkdirSync(staging);
function contained(target){const full=path.resolve(target);if(!full.startsWith(dist+path.sep))throw new Error('Release path escaped dist.');return full;}
function copy(rel){fs.cpSync(path.join(root,rel),contained(path.join(staging,rel)),{recursive:true,force:false,errorOnExist:true,filter:src=>{if(fs.lstatSync(src).isSymbolicLink())throw new Error('Source link refused: '+src);return !['.doc-cache','node_modules','.git'].includes(path.basename(src));}});}
for(const rel of publicPackageFiles(root)){fs.mkdirSync(path.dirname(path.join(staging,rel)),{recursive:true});copy(rel);}
fs.mkdirSync(path.join(staging,'test'));copy('test/joint-acceptance.mjs');
fs.mkdirSync(path.join(staging,'native'));
// dist/ lives inside the (possibly) Low-labeled workspace, so a plain copy of the
// guardian would re-inherit the Low label and the candidate would refuse to run
// in place. Verify a copy made outside that scope, then link it into the
// candidate; the stage entry is dropped afterwards so a later build can never
// mutate a released candidate through the shared file object.
const packagedHelper=contained(path.join(staging,'native','windows-job-host.exe'));
const releaseStage=ensureStageDir(process.env.CODEX_DSH_MCP_RELEASE_STAGE ?? path.join(path.dirname(root),'.codex-dsh-mcp-build-release'),packagedHelper);
const stagedHelper=path.join(releaseStage,'windows-job-host.exe');
fs.copyFileSync(helper,stagedHelper);
const stagedGuardian=await verifyGuardianArtifact(stagedHelper);
if(!stagedGuardian.ok)throw guardianError(stagedGuardian.image.level==='low'?IMAGE_LOW:(stagedGuardian.probe.code??LABEL_UNVERIFIED),'The release guardian failed verification before packaging: image='+stagedGuardian.image.level+' probe='+(stagedGuardian.probe.code??'ok')+' ('+(stagedGuardian.probe.detail??'')+')');
placeWithoutLowLabel({stageFile:stagedHelper,destFile:packagedHelper});
fs.copyFileSync(source,path.join(staging,'native','windows-job-host.cs'));
const guardianVerdict=await verifyGuardianArtifact(packagedHelper);
if(!guardianVerdict.ok)throw guardianError(guardianVerdict.image.level==='low'?IMAGE_LOW:(guardianVerdict.probe.code??LABEL_UNVERIFIED),'The packaged guardian failed verification: image='+guardianVerdict.image.level+' probe='+(guardianVerdict.probe.code??'ok'));
fs.unlinkSync(stagedHelper);
fs.mkdirSync(path.join(staging,'scripts'));
for(const name of ['validate-package.js','check-release.js','check-guardian.js','check-dsh-contract.js','dsh-contract-child.mjs','public-files.js'])fs.copyFileSync(path.join(root,'scripts',name),path.join(staging,'scripts',name));
const packaged=structuredClone(pkg);packaged.scripts={start:'runtime/node.exe ./bin/codex-dsh-mcp.js',bootstrap:'runtime/node.exe ./bin/codex-dsh-mcp.js --bootstrap',diagnose:'runtime/node.exe ./bin/codex-dsh-mcp.js --diagnose','check:guardian':'runtime/node.exe scripts/check-guardian.js','check:dsh-contract':'runtime/node.exe scripts/check-dsh-contract.js','validate:package':'runtime/node.exe scripts/validate-package.js'};fs.writeFileSync(path.join(staging,'package.json'),JSON.stringify(packaged,null,2)+'\n');
fs.mkdirSync(path.join(staging,'runtime'));
// The bundled runtime is a binary too: a copy made inside dist/ would inherit the
// Low label and then EVERY process the candidate starts — including the guardian —
// would run at Low integrity. Place it the same way and prove it can write.
const packagedNode=contained(path.join(staging,'runtime','node.exe'));
const stagedNode=path.join(releaseStage,'node'+path.extname(process.execPath));
fs.copyFileSync(process.execPath,stagedNode);
placeWithoutLowLabel({stageFile:stagedNode,destFile:packagedNode});
fs.unlinkSync(stagedNode);
const runtimeProbeDir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-dsh-runtime-probe-'));
const runtimeMarker=path.join(runtimeProbeDir,'marker.txt');
const runtimeProbe=spawnSync(packagedNode,['-e','require("node:fs").writeFileSync('+JSON.stringify(runtimeMarker)+',"runtime-probe-ok")'],{encoding:'utf8',windowsHide:true,timeout:60000});
const nodeLabel=readIntegrityLabel(packagedNode),runtimeWrote=fs.existsSync(runtimeMarker);
try{fs.rmSync(runtimeProbeDir,{recursive:true,force:true});}catch{}
if(runtimeProbe.status!==0||!runtimeWrote||nodeLabel.level==='low')throw guardianError(nodeLabel.level==='low'?IMAGE_LOW:LABEL_UNVERIFIED,'The packaged runtime cannot run or write outside the labeled tree: label='+nodeLabel.level+' status='+runtimeProbe.status+' wrote='+runtimeWrote+' ('+String(runtimeProbe.stderr??'').slice(0,200)+')');
fs.copyFileSync(nodeLicense,path.join(staging,'runtime','LICENSE.txt'));
const config=JSON.parse(fs.readFileSync(path.join(staging,'mcp.json'),'utf8'));config.mcpServers.dsh.command='./runtime/node.exe';fs.writeFileSync(path.join(staging,'mcp.json'),JSON.stringify(config,null,2)+'\n');
const lock=JSON.parse(fs.readFileSync(path.join(root,'package-lock.json'),'utf8')), notices=['# Bundled third-party software','', 'Node '+process.version+': runtime/LICENSE.txt (full upstream notices).','', 'Dependencies retain their upstream license files inside node_modules. The package is a prerelease; no model verification is implied.',''];
fs.mkdirSync(path.join(staging,'node_modules'));
for(const rel of Object.keys(lock.packages).filter(rel=>rel.startsWith('node_modules/') && rel.split('/node_modules/').length===1)) {
  const dep=lock.packages[rel];if(dep.dev||dep.link)throw new Error('Unexpected development or linked dependency in release closure: '+rel);
  const from=path.join(root,rel),to=contained(path.join(staging,rel));
  if(!fs.existsSync(from))throw new Error('Missing locked dependency: '+rel);
  const info=JSON.parse(fs.readFileSync(path.join(from,'package.json'),'utf8'));if(info.version!==dep.version)throw new Error('Installed/locked dependency version mismatch: '+rel);
  fs.cpSync(from,to,{recursive:true,errorOnExist:true,force:false,filter:src=>{if(fs.lstatSync(src).isSymbolicLink())throw new Error('Unexpected dependency link: '+src);return true;}});
  notices.push('- '+info.name+'@'+info.version+' — '+(typeof info.license==='string'?info.license:'see package notices')+' ('+rel+')');
}
fs.writeFileSync(path.join(staging,'THIRD-PARTY-NOTICES.md'),notices.join('\n')+'\n');
function sha(file){const h=crypto.createHash('sha256'),fd=fs.openSync(file,'r'),b=Buffer.alloc(128*1024);try{let n;while((n=fs.readSync(fd,b,0,b.length,null))>0)h.update(b.subarray(0,n));}finally{fs.closeSync(fd);}return h.digest('hex');}
const junit=fs.readFileSync(path.join(root,'test','.tmp','unit-results-latest.xml'),'utf8');
const attr=name=>Number(new RegExp('<!-- '+name+' ([0-9]+) -->').exec(junit)?.[1]??NaN);
const summary={version:pkg.version,sourceCommit,modelCalls:0,tests:attr('tests'),failures:attr('fail'),errors:(junit.match(/<error\b/g)??[]).length,skipped:attr('skipped'),scope:'Zero-model unit/protocol/synthetic process checks; installed DSH API is separately probed locally.'};
if(!Number.isFinite(summary.tests)||summary.failures!==0||summary.errors!==0||summary.skipped!==0)throw new Error('A passing no-model JUnit report is required.');
fs.writeFileSync(path.join(staging,'test-summary.json'),JSON.stringify(summary,null,2)+'\n');
const files={};function walk(dir,prefix=''){for(const name of fs.readdirSync(dir).sort()){const file=path.join(dir,name),rel=prefix+name,stat=fs.lstatSync(file);if(stat.isSymbolicLink())throw new Error('Release link refused.');if(stat.isDirectory())walk(file,rel+'/');else files[rel]={bytes:stat.size,sha256:sha(file)};}}
walk(staging);const fingerprint=crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex');
const target=contained(path.join(dist,'codex-dsh-mcp-'+pkg.version+'-win32-'+process.arch+'-'+fingerprint.slice(0,12)));
if(fs.existsSync(target))throw new Error('Immutable release already exists: '+target+'; it was not overwritten.');
fs.writeFileSync(path.join(staging,'release-manifest.json'),JSON.stringify({version:pkg.version,phase:'prerelease',sourceCommit,platform:process.platform,arch:process.arch,node:process.version,createdAt:new Date().toISOString(),fingerprint,files,guardianImageIntegrity:guardianVerdict.image.level,guardianLabelVerified:!guardianVerdict.image.raw,guardianProbe:'state-write-preflight',runtimeImageIntegrity:nodeLabel.level,runtimeWriteVerified:runtimeWrote,qualification:'Zero-model checks only. Paid models and specific host installations are unverified.'},null,2)+'\n');
validatePackage(staging);
const probe=await checkRelease(staging);fs.renameSync(staging,target);
const archive=contained(target+'.zip');if(fs.existsSync(archive))throw new Error('Archive exists and was not overwritten.');
const zipped=spawnSync(path.join(process.env.SystemRoot ?? 'C:\\Windows','System32','tar.exe'),['-a','-cf',archive,'-C',dist,path.basename(target)],{encoding:'utf8',windowsHide:true});
if(zipped.error||zipped.status!==0)throw new Error('Candidate directory is intact; ZIP failed: '+(zipped.error?.message ?? zipped.stderr));
fs.writeFileSync(archive+'.sha256',sha(archive)+'  '+path.basename(archive)+'\n');
console.log(JSON.stringify({directory:target,archive,fingerprint,probe},null,2));
