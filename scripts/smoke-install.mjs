import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {resolvePaths,requireApplication} from './paths.mjs';

const sources=requireApplication(resolvePaths());
await fs.mkdir('.local',{recursive:true});
const root=await fs.mkdtemp(path.resolve('.local/install-smoke-'));
const application=path.join(root,'app'),home=path.join(root,'home'),state=path.join(root,'state');
const profile=path.join(home,'profiles','desktop'),sidebar=path.join(profile,'node_modules','dsh-better-sidebar');
const digest=b=>createHash('sha256').update(b).digest('hex');
const env={...process.env,DSH_APP_DIR:application,DSH_HOME:home,DSH_STATE_DIR:state,DSH_SIDEBAR:sidebar};
function command(action){const p=spawnSync(process.execPath,['scripts/manage.mjs',action],{env,encoding:'utf8',windowsHide:true,timeout:60000});if(p.status!==0)throw new Error(p.stdout+p.stderr);return p.stdout;}
try{
  await fs.mkdir(path.join(application,'resources'),{recursive:true});await fs.mkdir(path.join(sidebar,'lib'),{recursive:true});
  const orig=await fs.readFile(sources.sourceArchive);
  await fs.writeFile(path.join(application,'resources','app.asar'),orig);
  for(const name of ['package.json','lib/client.js','lib/client-registry.js'])await fs.copyFile((name==='package.json'?sources.sidebar:sources.sourceSidebar)+'/'+name,path.join(sidebar,name));
  const profileData={name:'fixture',dependencies:{'dsh-better-sidebar':'0.28.0'},dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','dsh-better-sidebar']}}};
  await fs.writeFile(path.join(profile,'package.json'),JSON.stringify(profileData));
  assert(command('status').includes('Not installed'));
  command('install');assert(command('status').includes('"appOk": true'));
  const updated=JSON.parse(await fs.readFile(path.join(profile,'package.json'),'utf8'));updated.userAdded='preserve me';await fs.writeFile(path.join(profile,'package.json'),JSON.stringify(updated));
  const installedHash=digest(await fs.readFile(path.join(application,'resources','app.asar')));
  const backupArchive=path.join(state,'backup','app.asar');
  await fs.writeFile(backupArchive,'damaged backup');
  assert.throws(()=>command('uninstall'),/backup is damaged/);
  assert.equal(digest(await fs.readFile(path.join(application,'resources','app.asar'))),installedHash);
  await fs.writeFile(backupArchive,orig);
  command('uninstall');
  assert.equal(digest(await fs.readFile(path.join(application,'resources','app.asar'))),digest(orig));
  const restored=JSON.parse(await fs.readFile(path.join(profile,'package.json'),'utf8'));assert.equal(restored.userAdded,'preserve me');assert.deepEqual(restored.dsh.profile.bundles,profileData.dsh.profile.bundles);
  await assert.rejects(fs.access(path.join(profile,'node_modules','dsh-delete-session')));
  console.log('PASS: isolated install/status/uninstall, damaged-backup refusal, byte-exact restoration, and later profile edits preserved.');
}finally{await fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
