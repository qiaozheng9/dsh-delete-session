import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { openArchive } from './asar.mjs';
import { repack } from './repack.mjs';
import {resolvePaths,requireApplication,samePath} from './paths.mjs';

const project=fileURLToPath(new URL('../',import.meta.url));
const dist=path.join(project,'dist');
const targets=requireApplication(resolvePaths());
const {application,home,profile,sidebar,stateDir,stateFile,archive:archivePath}=targets;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const exists=async p=>fs.stat(p).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;});
const mode=process.argv[2]??'status';

async function atomicWrite(file,bytes) {
  const temporary=file+'.delete-session-next';
  if(await exists(temporary))throw new Error(`An earlier installation needs review: ${temporary}`);
  await fs.writeFile(temporary,bytes,{flag:'wx'});
  try {await fs.rename(temporary,file);}catch(e){await fs.unlink(temporary).catch(()=>{});throw e;}
}
async function requireStopped() {
  if(process.platform!=='win32')return;
  const executable=path.join(application,'DeepSeek Harness.exe').replaceAll("'","''");
  const query=`@(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Where-Object { -not $_.Path -or $_.Path -eq '${executable}' }).Count`;
  const result=spawnSync('powershell.exe',['-NoProfile','-Command',query],{encoding:'utf8',windowsHide:true});
  if(result.error)throw result.error;
  if(result.status!==0)throw new Error('Could not check desktop process state');
  if(Number(result.stdout.trim())>0)throw new Error('请先从托盘菜单完全退出 DeepSeek Harness，再运行安装。安装器不会终止真实对话。');
}
async function validateOriginal(manifest) {
  if(hash(await fs.readFile(archivePath))!==manifest.appHash)throw new Error('安装包哈希不匹配，拒绝应用补丁；请针对当前版本重新审查适配。');
  const a=openArchive(archivePath);
  try {
    if(JSON.parse(a.read('package.json')).version!==manifest.appVersion)throw new Error('Application version mismatch');
    for(const [p,entry]of Object.entries(manifest.files))if(hash(a.read(p))!==entry.original)throw new Error(`原始模块哈希不匹配：${p}`);
  }finally{a.close();}
  if((await json(path.join(sidebar,'package.json'))).version!==manifest.sidebarVersion)throw new Error('Better Sidebar version mismatch');
  for(const [p,entry]of Object.entries(manifest.sidebar))if(hash(await fs.readFile(path.join(sidebar,p)))!==entry.original)throw new Error(`侧栏模块哈希不匹配：${p}`);
  if(hash(await fs.readFile(path.join(dist,'bridge.mjs')))!==manifest.bridgeHash)throw new Error('Bridge artifact hash mismatch');
}
async function prepare(manifest) {
  await validateOriginal(manifest);
  const stage=path.join(stateDir,'patched-app.asar');
  await fs.mkdir(stateDir,{recursive:true});
  if(await exists(stage)) {
    // A build is deterministic. Only replace our own staging artifact.
    await fs.unlink(stage);
  }
  const replacements=new Map();
  for(const [p,e]of Object.entries(manifest.files)) {
    const bytes=await fs.readFile(path.join(dist,'patches',e.patch));
    if(hash(bytes)!==e.patched)throw new Error(`Patched module hash mismatch: ${p}`);
    replacements.set(p,bytes);
  }
  replacements.set('lib/delete-session-bridge.mjs',await fs.readFile(path.join(dist,'bridge.mjs')));
  await repack(archivePath,stage,replacements);
  if(await exists(archivePath+'.unpacked'))await fs.cp(archivePath+'.unpacked',stage+'.unpacked',{recursive:true,force:true});
  const check=openArchive(stage);
  try{for(const [p,b]of replacements)if(hash(check.read(p))!==hash(b))throw new Error(`Archive verification failed: ${p}`);}
  finally{check.close();}
  console.log('Prepared and verified version-pinned archive.');
  return stage;
}

async function install(manifest) {
  if(await exists(stateFile))throw new Error('Installation state already exists; run status or uninstall first.');
  const stage=await prepare(manifest);
  await requireStopped();
  const backup=path.join(stateDir,'backup');
  const previousBackup=await exists(backup);
  if(previousBackup) {
    if(hash(await fs.readFile(path.join(backup,'app.asar')))!==manifest.appHash)throw new Error('现有备份与当前支持版本不一致，拒绝覆盖备份');
    for(const[p,e]of Object.entries(manifest.sidebar))if(hash(await fs.readFile(path.join(backup,'sidebar',p)))!==e.original)throw new Error('现有侧栏备份不匹配');
  } else {
    await fs.mkdir(backup,{recursive:true});
    await fs.copyFile(archivePath,path.join(backup,'app.asar'));
  }
  const originalProfile=await fs.readFile(path.join(profile,'package.json'));
  await fs.writeFile(path.join(backup,previousBackup?'profile-before-install-'+Date.now()+'.json':'profile.json'),originalProfile);
  for(const p of previousBackup?[]:Object.keys(manifest.sidebar)) {
    await fs.mkdir(path.dirname(path.join(backup,'sidebar',p)),{recursive:true});
    await fs.copyFile(path.join(sidebar,p),path.join(backup,'sidebar',p));
  }
  const pluginDir=path.join(profile,'node_modules','dsh-delete-session');
  if(await exists(pluginDir))throw new Error('插件目录已存在，拒绝覆盖未知文件');
  const profilePackage=JSON.parse(originalProfile);
  profilePackage.dependencies??={};
  profilePackage.dependencies['dsh-delete-session']='file:'+path.join(dist,'plugin').replaceAll('\\','/');
  profilePackage.dsh.profile.bundles.push('dsh-delete-session');
  const pluginHashes={};
  for(const p of ['package.json','cordis.patch.yml','README.md','LICENSE','lib/index.js','lib/client.js'])pluginHashes[p]=hash(await fs.readFile(path.join(dist,'plugin',p)));
  const state={version:1,status:'installing',application,home,archiveHash:hash(await fs.readFile(stage)),originalArchiveHash:manifest.appHash,
    pluginHashes,
    originalProfileHash:hash(originalProfile),pluginDir,sidebar:manifest.sidebar,backup};
  await fs.writeFile(stateFile,JSON.stringify(state,null,2));
  try {
    // The local package has no npm dependencies: all host code is bundled and
    // client dependencies resolve through DSH's existing module loader.
    await fs.cp(path.join(dist,'plugin'),pluginDir,{recursive:true,errorOnExist:true,force:false});
    await atomicWrite(archivePath,await fs.readFile(stage));
    for(const [p,e]of Object.entries(manifest.sidebar))await atomicWrite(path.join(sidebar,p),await fs.readFile(path.join(dist,'patches',e.patch)));
    const profileBytes=Buffer.from(JSON.stringify(profilePackage,null,2)+'\n');
    await atomicWrite(path.join(profile,'package.json'),profileBytes);
    state.profileHash=hash(profileBytes);state.status='installed';
    await fs.writeFile(stateFile,JSON.stringify(state,null,2));
    console.log('Installed. Restart DeepSeek Harness; no conversation data was modified.');
  } catch(e) {
    console.error('Installation incomplete. Run uninstall:local to restore the saved program files.');
    throw e;
  }
}
async function uninstall() {
  await requireStopped();
  const state=await json(stateFile);
  if(!samePath(state.application,application)||!samePath(state.home,home))throw new Error('Installation target mismatch');
  const journal=path.join(home,'delete-session-journal');
  if(await exists(journal))if((await fs.readdir(journal)).some(n=>/^[a-f0-9]{64}\.json$/.test(n)))throw new Error('有未完成的删除，请先重试完成，再卸载增强包。');
  const aHash=hash(await fs.readFile(archivePath));
  if(aHash!==state.archiveHash&&aHash!==state.originalArchiveHash)throw new Error('应用已更新或被修改，拒绝覆盖当前程序。');
  const current=await json(path.join(profile,'package.json'));
  // Remove only our package and bundle; preserve later user configuration changes.
  current.dsh.profile.bundles=current.dsh.profile.bundles.filter(x=>x!=='dsh-delete-session');
  delete current.dependencies?.['dsh-delete-session'];
  for(const [p,e]of Object.entries(state.sidebar)) {
    const actual=hash(await fs.readFile(path.join(sidebar,p)));
    if(actual!==e.patched&&actual!==e.original)throw new Error('Better Sidebar 已更新或被修改，拒绝覆盖。');
  }
  if(hash(await fs.readFile(path.join(state.backup,'app.asar')))!==state.originalArchiveHash)throw new Error('Application backup is damaged; refusing restoration.');
  for(const [p,e]of Object.entries(state.sidebar))if(hash(await fs.readFile(path.join(state.backup,'sidebar',p)))!==e.original)throw new Error('Better Sidebar backup is damaged; refusing restoration.');
  const expected=path.resolve(profile,'node_modules','dsh-delete-session');
  if(path.resolve(state.pluginDir)!==expected)throw new Error('Unexpected plugin directory');
  if(state.status==='installed')for(const[p,h]of Object.entries(state.pluginHashes))if(hash(await fs.readFile(path.join(expected,p)))!==h)throw new Error('增强包文件已被修改，拒绝删除用户修改。');
  await atomicWrite(archivePath,await fs.readFile(path.join(state.backup,'app.asar')));
  for(const p of Object.keys(state.sidebar))await atomicWrite(path.join(sidebar,p),await fs.readFile(path.join(state.backup,'sidebar',p)));
  await atomicWrite(path.join(profile,'package.json'),Buffer.from(JSON.stringify(current,null,2)+'\n'));
  // The only recursive removal is the exact plugin directory created by this installer.
  await fs.rm(expected,{recursive:true,force:true});
  await fs.rename(stateFile,stateFile+'.uninstalled-'+Date.now());
  console.log('Program changes restored. Deleted conversations remain deleted.');
}

try {
  if(mode==='uninstall')await uninstall();
  else {
    const manifest=await json(path.join(dist,'manifest.json'));
    if(mode==='prepare')await prepare(manifest);
    else if(mode==='install')await install(manifest);
    else if(mode==='status') {
      if(await exists(stateFile)) {
        const state=await json(stateFile);
        if(!samePath(state.application,application)||!samePath(state.home,home))throw new Error('Installation target mismatch');
        const appOk=hash(await fs.readFile(archivePath))===state.archiveHash;
        const sidebarChecks=await Promise.all(Object.entries(state.sidebar).map(async([p,e])=>hash(await fs.readFile(path.join(sidebar,p)))===e.patched));
        const pluginChecks=await Promise.all(Object.entries(state.pluginHashes).map(async([p,h])=>hash(await fs.readFile(path.join(state.pluginDir,p)))===h));
        const configured=(await json(path.join(profile,'package.json'))).dsh.profile.bundles.includes('dsh-delete-session');
        console.log(JSON.stringify({status:state.status,appOk,sidebarOk:sidebarChecks.every(Boolean),pluginOk:pluginChecks.every(Boolean),configured},null,2));
        if(!appOk||!sidebarChecks.every(Boolean)||!pluginChecks.every(Boolean)||!configured)process.exitCode=1;
      } else {await validateOriginal(manifest);console.log('Not installed. Application and sidebar match the supported build.');}
    } else throw new Error('Usage: manage.mjs prepare|install|status|uninstall');
  }
}catch(e){console.error(e.message);process.exitCode=1;}
