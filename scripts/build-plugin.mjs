import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

/** Source-only build: no DSH installation or user profile is needed. */
export async function buildPlugin() {
  await fs.mkdir('dist/plugin/lib',{recursive:true});
  await build({entryPoints:['src/host.ts'],outfile:'dist/plugin/lib/index.js',bundle:true,platform:'node',format:'esm',target:'node24'});
  await build({entryPoints:['src/bridge.ts'],outfile:'dist/bridge.mjs',bundle:true,platform:'node',format:'esm',target:'node24'});
  for(const name of ['engine','driver'])await build({entryPoints:['src/'+name+'.ts'],outfile:'dist/'+name+'.mjs',bundle:true,platform:'node',format:'esm',target:'node24'});
  await build({entryPoints:['src/client.ts'],outfile:'dist/plugin/lib/client.js',bundle:true,platform:'browser',format:'cjs',target:'chrome140',external:['react','react-dom','@deepseek-ai/*'],
    banner:{js:`window.__ModuleLoader__.load({id:'dsh-delete-session',factory:(require)=>{var module={exports:{}};var exports=module.exports;`},
    footer:{js:'return module.exports;}});'}});
  for(const name of ['package.json','cordis.patch.yml','README.md'])await fs.copyFile('plugin/'+name,'dist/plugin/'+name);
  await fs.copyFile('LICENSE','dist/plugin/LICENSE');
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  await buildPlugin();console.log('Built runtime plugin. Installing it alone does not install the required DSH patches.');
}
