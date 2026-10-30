import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
// @ts-ignore shared with the local installer
import {optionalSidebar,sidebarPlan} from '../scripts/sidebar.mjs';

test('the extension is optional even when build artifacts include its adapter',async t=>{
  const root=await mkdtemp(join(tmpdir(),'dsh-delete-optional-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const directory=join(root,'absent');
  assert.equal(await optionalSidebar(directory),undefined);
  assert.deepEqual(await sidebarPlan(directory,{sidebarVersion:'0.28.0',sidebar:{'lib/client.js':{original:'original'}}}),{});
  assert.deepEqual(await sidebarPlan(directory,{sidebarVersion:null,sidebar:{}}),{});
});

test('an installed extension requires its adapter; damaged installs cannot silently skip cleanup',async t=>{
  const root=await mkdtemp(join(tmpdir(),'dsh-delete-adapter-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const directory=join(root,'extension');await mkdir(directory);
  await assert.rejects(optionalSidebar(directory),/不完整/);
  await writeFile(join(directory,'package.json'),JSON.stringify({version:'0.28.0'}));
  await assert.rejects(sidebarPlan(directory,{sidebarVersion:null,sidebar:{}}),/重新构建/);
  await assert.rejects(sidebarPlan(directory,{sidebarVersion:'0.29.0',sidebar:{file:{}}}),/版本/);
  const adapter={file:{original:'original',patched:'patched'}};
  assert.deepEqual(await sidebarPlan(directory,{sidebarVersion:'0.28.0',sidebar:adapter}),adapter);
});
