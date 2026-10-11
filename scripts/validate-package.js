/** Portable Agent Plugins 1.0.0 manifests; no network, provisioning or models. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import yaml from 'js-yaml';
import {repoRoot} from '../lib/paths.js';
export function validatePackage(root=repoRoot()) {
  root=path.resolve(root);
  const ajv=new Ajv2020({allErrors:true,strict:true,validateFormats:false});
  for(const name of ['plugin','mcp']) {
    const schema=JSON.parse(fs.readFileSync(path.join(root,'docs','schemas',name+'.schema.json'),'utf8'));
    const document=JSON.parse(fs.readFileSync(path.join(root,name+'.json'),'utf8'));
    const check=ajv.compile(schema); if(!check(document))throw new Error(name+'.json: '+ajv.errorsText(check.errors));
  }
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'plugin.json'),'utf8'));
  const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
  if(manifest.version!==pkg.version)throw new Error('Plugin/package version mismatch.');
  const onboarding=manifest.extensions?.['com.openai']?.onboardingSkill;
  if(typeof onboarding!=='string'||!onboarding.startsWith('./'))throw new Error('Onboarding skill must be plugin-relative.');
  const onboardingFile=path.resolve(root,onboarding);if(!onboardingFile.startsWith(root+path.sep)||!fs.statSync(onboardingFile).isFile())throw new Error('Invalid onboarding skill path.');
  const config=JSON.parse(fs.readFileSync(path.join(root,'mcp.json'),'utf8'));
  for(const server of Object.values(config.mcpServers)) {
    if(server.type!=='stdio')throw new Error('This local plugin must use stdio.');
    if(server.command.startsWith('./')){const exe=path.resolve(root,server.command);if(!exe.startsWith(root+path.sep)||!fs.statSync(exe).isFile())throw new Error('Bundled executable missing or out of bounds.');}
    for(const text of [...(server.args ?? []),server.cwd ?? '',...Object.values(server.env ?? {})]) {
      if(/\$\{(?!PLUGIN_ROOT\}|PLUGIN_DATA\})/.test(text))throw new Error('Unknown portable manifest variable.');
      if(text.includes('\0'))throw new Error('NUL in portable config.');
      if(/(^|[\\/])\.\.([\\/]|$)/.test(text))throw new Error('Parent traversal in portable config.');
    }
  }
  const skills=[];
  for(const name of fs.readdirSync(path.join(root,'skills'))) {
    const file=path.join(root,'skills',name,'SKILL.md');if(!fs.existsSync(file))continue;
    const text=fs.readFileSync(file,'utf8'),front=/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    if(!front)throw new Error('Skill frontmatter missing: '+name);
    const meta=yaml.load(front[1]);if(meta.name!==name||!/^[a-z0-9-]{1,64}$/.test(name)||typeof meta.description!=='string'||!meta.description.trim())throw new Error('Invalid skill metadata: '+name);
    if(/\b(?:TODO|TBD)\b/.test(text))throw new Error('Unfinished skill: '+name);
    skills.push(name);
  }
  if(!skills.includes('dsh-setup')||!skills.includes('dsh-delegate'))throw new Error('Required setup/delegation skills missing.');
  return {version:pkg.version,manifestSchema:'Agent Plugins 1.0.0',servers:Object.keys(config.mcpServers),skills};
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) console.log(JSON.stringify(validatePackage(process.argv[2]),null,2));
