import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import {buildPlugin} from './build-plugin.mjs';
import {resolvePaths,requireApplication} from './paths.mjs';
import { openArchive } from './asar.mjs';
import { patchFiles,patchSource,prefix } from './patches.mjs';
import { patchNativeClient,patchSidebar } from './client-patches.mjs';

const hash=b=>createHash('sha256').update(b).digest('hex');
const targets=requireApplication(resolvePaths());
const app=targets.sourceArchive;
const sidebar=targets.sidebar;
const sidebarSources=targets.sourceSidebar;
const supported=JSON.parse(await fs.readFile('compatibility.json','utf8'));
const archive=openArchive(app);
const manifest={version:1,appVersion:JSON.parse(archive.read('package.json')).version,appHash:hash(await fs.readFile(app)),files:{},sidebarVersion:JSON.parse(await fs.readFile(sidebar+'/package.json','utf8')).version,sidebar:{}};
if(manifest.appVersion!==supported.appVersion||manifest.appHash!==supported.appHash||manifest.sidebarVersion!==supported.sidebarVersion)throw new Error('Unsupported desktop build. See compatibility.json; matching version text alone is insufficient.');
await buildPlugin();
await fs.mkdir('dist/patches',{recursive:true});
for(const p of [...patchFiles,prefix+'dsh-api-session-controller/lib/client.js']){
  const original=archive.read(p);
  if(hash(original)!==supported.modules[p])throw new Error('Unsupported original module: '+p);
  const text=p.endsWith('/client.js')?patchNativeClient(original.toString()):patchSource(p,original.toString());
  const name=hash(p)+'.js';await fs.writeFile('dist/patches/'+name,text);
  // Parsing catches a renamed private class or malformed edit before installation.
  await build({stdin:{contents:text,sourcefile:p},write:false,logLevel:'silent',platform:'node',format:p.endsWith('/client.js')?'iife':'esm'});
  manifest.files[p]={original:hash(original),patched:hash(text),patch:name};
}
archive.close();
for(const p of ['lib/client.js','lib/client-registry.js']){
  const original=await fs.readFile(sidebarSources+'/'+p);const text=patchSidebar(original.toString());
  if(hash(original)!==supported.sidebar[p])throw new Error('Unsupported Better Sidebar module: '+p);
  const name=hash('sidebar/'+p)+'.js';await fs.writeFile('dist/patches/'+name,text);
  await build({stdin:{contents:text},write:false,logLevel:'silent'});
  manifest.sidebar[p]={original:hash(original),patched:hash(text),patch:name};
}
manifest.bridgeHash=hash(await fs.readFile('dist/bridge.mjs'));
await fs.writeFile('dist/manifest.json',JSON.stringify(manifest,null,2));
console.log('Built plugin and version-pinned patches; all patched JavaScript parsed successfully.');
