/** Generic distribution validation. No provisioning, process probe or model. */
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {repoRoot} from '../lib/paths.js';
export function validatePackage(root=repoRoot()){
 root=path.resolve(root);const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')),lock=JSON.parse(fs.readFileSync(path.join(root,'package-lock.json'),'utf8'));
 if(pkg.name!=='dsh-mcp'||pkg.version!=='0.1.3'||lock.name!==pkg.name||lock.version!==pkg.version)throw new Error('Generic package/lock identity mismatch.');
 for(const file of ['plugin.json','mcp.json'])if(fs.existsSync(path.join(root,file)))throw new Error('Codex distribution entry must not be present: '+file);
 for(const [name,entry] of Object.entries(pkg.bin??{})){if(!['dsh-mcp','codex-dsh-mcp'].includes(name)||!entry.startsWith('./bin/'))throw new Error('Invalid CLI entry.');const full=path.resolve(root,entry);if(!full.startsWith(root+path.sep)||!fs.statSync(full).isFile())throw new Error('CLI entry missing or escaped.');}
 if(pkg.bin?.['dsh-mcp']!=='./bin/dsh-mcp.js')throw new Error('Primary CLI missing.');
 const plugin=JSON.parse(fs.readFileSync(path.join(root,'dsh-plugin','package.json'),'utf8'));if(plugin.name!=='dsh-mcp-plugin'||plugin.version!==pkg.version)throw new Error('DSH execution plugin identity mismatch.');
 const entry=fs.readFileSync(path.join(root,'bin','dsh-mcp.js'),'utf8');if(/PLUGIN_ROOT|PLUGIN_DATA/.test(entry))throw new Error('Client plugin variable dependency.');
 if(fs.existsSync(path.join(root,'release-manifest.json'))){const manifest=JSON.parse(fs.readFileSync(path.join(root,'release-manifest.json'),'utf8'));if(manifest.node!=='v24.19.0'||manifest.arch!=='x64'||manifest.platform!=='win32'||!/^[a-f0-9]{40}$/.test(manifest.sourceCommit))throw new Error('Invalid release provenance.');if(!fs.existsSync(path.join(root,'runtime','node.exe'))||!fs.existsSync(path.join(root,'runtime','LICENSE.txt'))||!fs.existsSync(path.join(root,'native','windows-job-host.exe')))throw new Error('Self-contained runtime/guardian/license missing.');}
 return {name:pkg.name,version:pkg.version,transport:'stdio',servers:['dsh-mcp'],tools:8,automaticProvisioning:false};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(validatePackage(process.argv[2]),null,2));
