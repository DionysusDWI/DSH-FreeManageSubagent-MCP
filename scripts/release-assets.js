/** Assemble immutable public assets from one built package and a clean Git commit. */
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {execFileSync} from 'node:child_process';
const root=process.cwd(),pkg=JSON.parse(fs.readFileSync('package.json','utf8'));
const commit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const candidates=fs.readdirSync('dist').filter(n=>n.startsWith(pkg.name+'-'+pkg.version+'-win32-x64-')&&!n.endsWith('.zip')&&!n.endsWith('.sha256'));
const matching=candidates.filter(n=>JSON.parse(fs.readFileSync(path.join('dist',n,'release-manifest.json'),'utf8')).sourceCommit===commit);
if(matching.length!==1)throw new Error('Exactly one package for this source commit is required.');
const dir=path.join(root,'dist',matching[0]),out=path.join(root,'dist','public-v'+pkg.version);
if(fs.existsSync(out))throw new Error('Asset directory already exists; refusing overwrite.');fs.mkdirSync(out);
const zip=path.basename(dir)+'.zip';fs.copyFileSync(dir+'.zip',path.join(out,zip));
fs.copyFileSync(path.join(dir,'release-manifest.json'),path.join(out,'release-manifest.json'));
fs.copyFileSync(path.join(dir,'test-summary.json'),path.join(out,'test-summary.json'));
execFileSync('git',['archive','--format=zip','--output='+path.join(out,pkg.name+'-'+pkg.version+'-source.zip'),commit],{stdio:'pipe'});
const names=fs.readdirSync(out).sort(),checksum=names.map(n=>crypto.createHash('sha256').update(fs.readFileSync(path.join(out,n))).digest('hex')+'  '+n).join('\n')+'\n';
fs.writeFileSync(path.join(out,'SHA256SUMS'),checksum);console.log(out);
