/** GitHub draft -> verified uploads -> public prerelease. No overwrite or credentials in logs. */
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {execFileSync} from 'node:child_process';
const repo='DionysusDWI/DSH-FreeManageSubagent-MCP',base='https://api.github.com/repos/'+repo;
const token=process.env.GITHUB_TOKEN;if(!token)throw new Error('GITHUB_TOKEN is required; do not read third-party credential databases.');
const pkg=JSON.parse(fs.readFileSync('package.json','utf8')),tag='v'+pkg.version,commit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const out=path.resolve(process.argv[2]??path.join('dist','public-'+tag));
const hashes=new Map(fs.readFileSync(path.join(out,'SHA256SUMS'),'utf8').trim().split('\n').map(line=>{const match=/^([a-f0-9]{64})  ([A-Za-z0-9_.-]+)$/.exec(line);if(!match)throw new Error('Invalid checksums.');return [match[2],match[1]];}));
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
for(const [name,hash] of hashes)if(sha(fs.readFileSync(path.join(out,name)))!==hash)throw new Error('Asset hash mismatch: '+name);
const manifest=JSON.parse(fs.readFileSync(path.join(out,'release-manifest.json'),'utf8')),summary=JSON.parse(fs.readFileSync(path.join(out,'test-summary.json'),'utf8'));
if(manifest.sourceCommit!==commit||manifest.version!==pkg.version||summary.sourceCommit!==commit||summary.modelCalls!==0||summary.failures||summary.errors||summary.skipped)throw new Error('Source/version/test provenance mismatch.');
if(execFileSync('git',['cat-file','-t',tag],{encoding:'utf8'}).trim()!=='tag'||execFileSync('git',['rev-parse',tag+'^{}'],{encoding:'utf8'}).trim()!==commit)throw new Error('An annotated matching tag is required.');
async function api(url,opts={}){const response=await fetch(url,{...opts,headers:{Authorization:'Bearer '+token,'X-GitHub-Api-Version':'2022-11-28',Accept:'application/vnd.github+json',...opts.headers}});if(!response.ok)throw new Error('GitHub API '+response.status+' '+new URL(url).pathname);return response;}
const main=await (await api(base+'/git/ref/heads/main')).json();if(main.object.sha!==commit)throw new Error('Remote main changed; release stopped.');
const releases=await (await api(base+'/releases?per_page=100')).json();if(releases.some(r=>r.tag_name===tag))throw new Error('Release already exists; refusing conflict.');
const body=fs.readFileSync(path.join('docs','releases',tag+'.md'),'utf8');
const release=await (await api(base+'/releases',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tag_name:tag,target_commitish:commit,name:pkg.name+' '+tag,draft:true,prerelease:true,body})})).json();
console.log('Draft created: '+release.html_url);
for(const name of [...hashes.keys(),'SHA256SUMS']){const bytes=fs.readFileSync(path.join(out,name));const asset=await (await api(release.upload_url.replace(/\{.*$/,'')+'?name='+encodeURIComponent(name),{method:'POST',headers:{'Content-Type':name.endsWith('.zip')?'application/zip':'application/octet-stream'},body:bytes})).json();if(asset.name!==name||asset.size!==bytes.length)throw new Error('Upload metadata mismatch: '+name);const downloaded=Buffer.from(await (await api(asset.url,{headers:{Accept:'application/octet-stream'}})).arrayBuffer());if(sha(downloaded)!==sha(bytes))throw new Error('Downloaded asset checksum mismatch: '+name);console.log('Verified '+name);}
const again=await (await api(base+'/git/ref/heads/main')).json();if(again.object.sha!==commit)throw new Error('Remote main changed during upload; draft preserved.');
const published=await (await api(base+'/releases/'+release.id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({draft:false,prerelease:true})})).json();if(published.draft||!published.prerelease)throw new Error('Unexpected release state.');console.log('Published '+published.html_url);
