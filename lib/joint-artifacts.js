/** Private acceptance artifacts. Never imports dependencies from a source checkout. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
export const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
export function shaFile(file) {
  const fd=fs.openSync(file,'r'), hash=crypto.createHash('sha256'), buffer=Buffer.alloc(128*1024);
  try { let n; while((n=fs.readSync(fd,buffer,0,buffer.length,null))>0) hash.update(buffer.subarray(0,n)); }
  finally { fs.closeSync(fd); }
  return hash.digest('hex');
}
export function readJsonFile(file) { return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'')); }
export function canonicalJson(value) {
  function sort(v) {
    if(v===null || typeof v==='string' || typeof v==='boolean') return v;
    if(typeof v==='number' && Number.isFinite(v)) return v;
    if(Array.isArray(v)) return v.map(x=>x===undefined?null:sort(x));
    if(v && typeof v==='object' && [Object.prototype,null].includes(Object.getPrototypeOf(v))) {
      return Object.fromEntries(Object.keys(v).filter(k=>v[k]!==undefined).sort().map(k=>[k,sort(v[k])]));
    }
    throw new TypeError('Acceptance records must contain only JSON values.');
  }
  return JSON.stringify(sort(value));
}
export function writeExclusiveJson(file,value) {
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const fd=fs.openSync(file,'wx',0o600);
  try { fs.writeFileSync(fd,JSON.stringify(value,null,2)+'\n','utf8'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}
export function appendDurableJson(file,value) {
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const fd=fs.openSync(file,'a',0o600);
  try { fs.writeFileSync(fd,JSON.stringify(value)+'\n','utf8'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}
export function containedPath(root,rel) {
  if(typeof rel!=='string'||!rel||rel.includes('\\')||path.isAbsolute(rel)||rel.split('/').some(v=>v==='..'||v==='.'||!v)) throw new Error('Unsafe manifest path.');
  const file=path.resolve(root,rel), base=path.resolve(root)+path.sep;
  if(!file.startsWith(base)) throw new Error('Manifest path escapes its candidate.');
  return file;
}
export function verifyCandidate(root,expected={}) {
  root=fs.realpathSync.native(root);
  const manifestFile=path.join(root,'release-manifest.json'), manifest=readJsonFile(manifestFile), manifestSha256=shaFile(manifestFile);
  if(manifest.phase!=='candidate'||manifest.version!=='0.1.1'||!manifest.files||!Object.keys(manifest.files).length) throw new Error('Not an independent 0.1.1 candidate.');
  const fingerprint=sha256(JSON.stringify(manifest.files));
  if(fingerprint!==manifest.fingerprint||expected.fingerprint&&fingerprint!==expected.fingerprint||expected.manifestSha256&&manifestSha256!==expected.manifestSha256) throw new Error('Candidate manifest/fingerprint drift.');
  for(const [rel,item] of Object.entries(manifest.files)) {
    const file=containedPath(root,rel);
    for(let dir=file;dir!==root;dir=path.dirname(dir)) if(fs.lstatSync(dir).isSymbolicLink()) throw new Error('Candidate links are refused: '+rel);
    const stat=fs.statSync(file);
    if(!stat.isFile()||stat.size!==item.bytes||shaFile(file)!==item.sha256) throw new Error('Candidate content drift: '+rel);
  }
  for(const rel of ['runtime/node.exe','bin/codex-dsh-mcp.js','native/windows-job-host.exe','node_modules/@modelcontextprotocol/sdk/package.json']) {
    if(!manifest.files[rel]) throw new Error('Candidate is missing its bundled closure: '+rel);
  }
  return {root,fingerprint,manifestSha256,fileCount:Object.keys(manifest.files).length+1,manifest};
}
export function collectHashes(root,{exclude=[]}={}) {
  const files={};
  function walk(dir,prefix='') { for(const name of fs.readdirSync(dir).sort()) {
    const rel=prefix+name; if(exclude.includes(rel)) continue;
    const file=path.join(dir,name), stat=fs.lstatSync(file);
    if(stat.isSymbolicLink()) throw new Error('Evidence links are refused: '+rel);
    if(stat.isDirectory()) walk(file,rel+'/'); else if(stat.isFile()) files[rel]={bytes:stat.size,sha256:shaFile(file)};
  } }
  walk(root); return files;
}
