/** Public source/package allowlists. Never recursively copy docs or local evidence. */
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const top=new Set(['.gitignore','LICENSE','README.md','CHANGELOG.md','package.json','package-lock.json','plugin.json','mcp.json']);
const forbidden=/(^|\/)(?:verification|\.doc-cache|\.agents|\.git|node_modules|dist|\.tmp|_staging)(\/|$)|(?:^|\/)(?:windows-job-host\.exe|\.env(?:\..*)?|[^/]+\.(?:local\.(?:json|log)|log|db|sqlite[0-9]*))$/i;
export function isPublicSource(rel){
 rel=rel.replaceAll('\\','/');if(forbidden.test(rel)||rel.includes('..')||rel.startsWith('/'))return false;
 if(top.has(rel))return true;
 if(/^(?:bin|lib|scripts|dsh-plugin)\/[A-Za-z0-9_.\/-]+\.(?:js|mjs)$/.test(rel))return true;
 if(rel==='dsh-plugin/package.json')return true;
 if(/^test\/(?:[A-Za-z0-9_.-]+\.(?:js|mjs)|fixtures\/[A-Za-z0-9_.-]+\.(?:mjs|json))$/.test(rel))return true;
 if(/^native\/[A-Za-z0-9_-]+\.cs$/.test(rel))return true;
 if(/^skills\/[a-z0-9-]+\/SKILL\.md$/.test(rel))return true;
 if(/^docs\/(?:public|releases|schemas)\/[A-Za-z0-9_.-]+\.(?:md|json)$/.test(rel))return true;
 if(['docs/architecture.md','docs/release-and-acceptance.md'].includes(rel))return true;
 return /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(rel);
}
export function publicSourceFiles(root){
 const files=[];function walk(dir,prefix=''){for(const name of fs.readdirSync(dir).sort()){const file=path.join(dir,name),rel=prefix+name;if(forbidden.test(rel))continue;const stat=fs.lstatSync(file);if(stat.isSymbolicLink())throw new Error('Source symlink refused: '+rel);if(stat.isDirectory())walk(file,rel+'/');else if(isPublicSource(rel))files.push(rel);}}
 walk(root);return files;
}
export function publicPackageFiles(root){
 const old=['lib/conversation.js','lib/migrate.js','lib/acceptance.js','lib/acceptance-suite.js','lib/host-preflight.js','lib/joint-artifacts.js','lib/joint-matrix.js','lib/smoke4-matrix.js'];
 return publicSourceFiles(root).filter(rel=>!['.github/','test/','scripts/','native/','skills/','docs/schemas/'].some(prefix=>rel.startsWith(prefix))&&!old.includes(rel));
}
export function scanPublicFiles(root,files=publicSourceFiles(root)){
 const failures=[];const rules=[['private key',/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],['credential token',/(?:gh[pousr]_[A-Za-z0-9]{24,}|github_pat_[A-Za-z0-9_]{24,}|sk-[A-Za-z0-9_-]{24,})/],['machine path',/C:[\\/]Users[\\/]TravisAD|D:[\\/]_AI_[\\/]Codex-Project/i]];
 for(const rel of files){if(!isPublicSource(rel))throw new Error('Not allowlisted: '+rel);const text=fs.readFileSync(path.join(root,rel),'utf8');if(text.includes('\0'))failures.push({file:rel,rule:'binary data'});for(const [rule,re] of rules)if(re.test(text))failures.push({file:rel,rule});}
 if(failures.length)throw new Error('Public content scan rejected files: '+JSON.stringify(failures));return {files:files.length,allowlisted:true,secretScan:'passed',rawEvidenceExcluded:true};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){const root=path.resolve(process.argv[2]??'.');console.log(JSON.stringify(scanPublicFiles(root),null,2));}

export function publicSourceFingerprint(root){const hashes=publicSourceFiles(root).map(rel=>[rel,crypto.createHash('sha256').update(fs.readFileSync(path.join(root,rel))).digest('hex')]);return crypto.createHash('sha256').update(JSON.stringify(hashes)).digest('hex');}
