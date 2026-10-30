import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir,mkdtemp,writeFile,rm,readFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
// @ts-ignore script is also used by the installation command
import { repack } from '../scripts/repack.mjs';
// @ts-ignore
import { openArchive } from '../scripts/asar.mjs';
// @ts-ignore
import asar from '@electron/asar';

test('repacking preserves untouched files, updates integrity, and adds the bridge',async t=>{
  await mkdir('.local',{recursive:true});const root=await mkdtemp(resolve('.local','archive-test-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const input=join(root,'input');await mkdir(input);await writeFile(join(input,'keep.txt'),'unchanged');await writeFile(join(input,'change.js'),'old');
  const before=join(root,'before.asar'),after=join(root,'after.asar');await asar.createPackage(input,before);
  await repack(before,after,new Map([['change.js',Buffer.from('new code')],['lib/bridge.mjs',Buffer.from('export const x=1;')]]));
  const read=openArchive(after);
  try {
    assert.equal(read.read('keep.txt').toString(),'unchanged');assert.equal(read.read('change.js').toString(),'new code');
    assert.equal(asar.extractFile(after,'lib/bridge.mjs').toString(),'export const x=1;');
    const entry=asar.statFile(after,'change.js') as {integrity:{hash:string}};
    assert.equal(entry.integrity.hash,read.tree.files['change.js'].integrity.hash);
  } finally { read.close(); }
});
