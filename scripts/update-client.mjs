// Apply a client-only revision without replacing a running desktop's backend.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {resolvePaths} from './paths.mjs';

const project=fileURLToPath(new URL('../',import.meta.url));
const {stateFile,stateDir}=resolvePaths();
const state=JSON.parse(await fs.readFile(stateFile,'utf8'));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const expected=path.resolve(state.home,'profiles','desktop','node_modules','dsh-delete-session');
if(state.status!=='installed'||path.resolve(state.pluginDir)!==expected)throw new Error('Unexpected installation target');
for(const [name,digest]of Object.entries(state.pluginHashes)) {
  const current=await fs.readFile(path.join(expected,name));
  if(hash(current)!==digest)throw new Error(`Installed file changed: ${name}`);
  if(name!=='lib/client.js'&&hash(await fs.readFile(path.join(project,'dist','plugin',name)))!==digest) {
    throw new Error('This revision also changes backend/configuration; use the full installer.');
  }
}
const file=path.join(expected,'lib','client.js');
const bytes=await fs.readFile(path.join(project,'dist','plugin','lib','client.js'));
const oldHash=state.pluginHashes['lib/client.js'];
if(hash(bytes)===oldHash){console.log('Client is already current.');process.exit(0);}
const revisions=path.join(stateDir,'client-revisions');
await fs.mkdir(revisions,{recursive:true});
await fs.copyFile(file,path.join(revisions,oldHash+'.js'));
await fs.writeFile(file+'.next',bytes,{flag:'wx'});
await fs.rename(file+'.next',file);
state.pluginHashes['lib/client.js']=hash(bytes);
await fs.writeFile(stateFile+'.next',JSON.stringify(state,null,2),{flag:'wx'});
await fs.rename(stateFile+'.next',stateFile);
console.log('Updated client only. Reopen DeepSeek Harness to reload the menu.');
