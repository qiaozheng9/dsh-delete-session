import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {resolvePaths,requireApplication} from './paths.mjs';
import {optionalSidebar} from './sidebar.mjs';

const sources=requireApplication(resolvePaths());
await fs.mkdir('.local',{recursive:true});
const root=await fs.mkdtemp(path.resolve('.local/install-smoke-'));
const digest=b=>createHash('sha256').update(b).digest('hex');
const extension=await optionalSidebar(sources.sidebar);
const variants=extension?[false,true]:[false];
try {
  const orig=await fs.readFile(sources.sourceArchive);
  for(const withExtension of variants) {
    const base=path.join(root,withExtension?'with-extension':'native-only');
    const application=path.join(base,'app'),home=path.join(base,'home'),state=path.join(base,'state');
    const profile=path.join(home,'profiles','desktop'),sidebar=path.join(profile,'node_modules','dsh-better-sidebar');
    const env={...process.env,DSH_APP_DIR:application,DSH_HOME:home,DSH_STATE_DIR:state,DSH_SIDEBAR:sidebar};
    function command(action){const p=spawnSync(process.execPath,['scripts/manage.mjs',action],{env,encoding:'utf8',windowsHide:true,timeout:60000});if(p.status!==0)throw new Error(p.stdout+p.stderr);return p.stdout;}
    await fs.mkdir(path.join(application,'resources'),{recursive:true});await fs.mkdir(profile,{recursive:true});
    await fs.writeFile(path.join(application,'resources','app.asar'),orig);
    if(withExtension) {
      await fs.mkdir(path.join(sidebar,'lib'),{recursive:true});
      for(const name of ['package.json','lib/client.js','lib/client-registry.js'])await fs.copyFile((name==='package.json'?sources.sidebar:sources.sourceSidebar)+'/'+name,path.join(sidebar,name));
    }
    const profileData={name:'fixture',dependencies:withExtension?{'dsh-better-sidebar':extension.version}:{},dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app',...(withExtension?['dsh-better-sidebar']:[])]}}};
    await fs.writeFile(path.join(profile,'package.json'),JSON.stringify(profileData));
    assert(command('status').includes('Not installed'));
    command('install');assert(command('status').includes('"appOk": true'));
    const installation=JSON.parse(await fs.readFile(path.join(state,'installed.json'),'utf8'));
    assert.equal(Object.keys(installation.sidebar).length,withExtension?2:0);
    if(!withExtension)await assert.rejects(fs.access(sidebar));
    const updated=JSON.parse(await fs.readFile(path.join(profile,'package.json'),'utf8'));updated.userAdded='preserve me';await fs.writeFile(path.join(profile,'package.json'),JSON.stringify(updated));
    const installedHash=digest(await fs.readFile(path.join(application,'resources','app.asar')));
    const backupArchive=path.join(state,'backup','app.asar');
    await fs.writeFile(backupArchive,'damaged backup');
    assert.throws(()=>command('uninstall'),/backup is damaged/);
    assert.equal(digest(await fs.readFile(path.join(application,'resources','app.asar'))),installedHash);
    await fs.writeFile(backupArchive,orig);
    command('uninstall');
    assert.equal(digest(await fs.readFile(path.join(application,'resources','app.asar'))),digest(orig));
    const restored=JSON.parse(await fs.readFile(path.join(profile,'package.json'),'utf8'));assert.equal(restored.userAdded,'preserve me');assert.deepEqual(restored.dsh.profile.bundles,profileData.dsh.profile.bundles);assert.deepEqual(restored.dependencies,profileData.dependencies);
    await assert.rejects(fs.access(path.join(profile,'node_modules','dsh-delete-session')));
    if(!withExtension)await assert.rejects(fs.access(sidebar));
    console.log('PASS: '+(withExtension?'optional extension installed':'no sidebar extension')+'; install/status/uninstall, damaged-backup refusal, restoration and profile preservation.');
    if(!withExtension&&extension) {
      await fs.mkdir(path.join(sidebar,'lib'),{recursive:true});
      for(const name of ['package.json','lib/client.js','lib/client-registry.js'])await fs.copyFile((name==='package.json'?sources.sidebar:sources.sourceSidebar)+'/'+name,path.join(sidebar,name));
      restored.dependencies['dsh-better-sidebar']=extension.version;restored.dsh.profile.bundles.push('dsh-better-sidebar');
      await fs.writeFile(path.join(profile,'package.json'),JSON.stringify(restored));
      command('install');assert(command('status').includes('"sidebarOk": true'));command('uninstall');
      assert.equal(digest(await fs.readFile(path.join(application,'resources','app.asar'))),digest(orig));
      assert.deepEqual(JSON.parse(await fs.readFile(path.join(profile,'package.json'),'utf8')),restored);
      console.log('PASS: reinstallation after adding an optional extension reuses existing backups.');
    }
    if(withExtension) {
      command('install');
      if(!path.resolve(sidebar).startsWith(path.resolve(base)+path.sep))throw new Error('Unexpected extension fixture');
      await fs.rm(sidebar,{recursive:true,force:true});
      const remaining=JSON.parse(await fs.readFile(path.join(profile,'package.json'),'utf8'));
      delete remaining.dependencies['dsh-better-sidebar'];remaining.dsh.profile.bundles=remaining.dsh.profile.bundles.filter(name=>name!=='dsh-better-sidebar');
      await fs.writeFile(path.join(profile,'package.json'),JSON.stringify(remaining));
      assert(command('status').includes('"appOk": true'));command('uninstall');
      await assert.rejects(fs.access(sidebar));
      assert.equal(digest(await fs.readFile(path.join(application,'resources','app.asar'))),digest(orig));
      console.log('PASS: removing the optional extension does not block status or uninstall, or recreate it.');
    }
  }
} finally {
  const expectedParent=path.resolve('.local')+path.sep;
  if(!path.resolve(root).startsWith(expectedParent))throw new Error('Unexpected test cleanup target');
  await fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
