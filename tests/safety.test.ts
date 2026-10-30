import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,symlink,readFile,rm } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { checkedPath,removeTree } from '../src/safety.ts';
import { DeleteEngine,parsePlan } from '../src/engine.ts';

test('rejects root deletion, traversal, and symlink descendants; accepts a configured root junction',async t=>{
  const base=await mkdtemp(join(process.env.DSH_TEST_TMP??tmpdir(),'dsh-delete-safety-'));
  t.after(()=>rm(base,{recursive:true,force:true}));
  const data=join(base,'data'),outside=join(base,'outside');await mkdir(data);await mkdir(outside);
  await writeFile(join(outside,'keep'),'project data');
  await assert.rejects(checkedPath(data,data),/root/);
  await assert.rejects(checkedPath(data,join(data,'..','outside')),/root/);
  await symlink(outside,join(data,'evil'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(removeTree(data,join(data,'evil')),/linked/);
  assert.equal(await readFile(join(outside,'keep'),'utf8'),'project data');
  await symlink(data,join(base,'root-alias'),process.platform==='win32'?'junction':'dir');
  await mkdir(join(data,'owned'));await writeFile(join(data,'owned','file'),'owned');
  await removeTree(join(base,'root-alias'),join(base,'root-alias','owned'));
});
test('journal parser strips payloads and refuses non-hash artifact paths',()=>{
  assert.throws(()=>parsePlan({version:1,rootId:'a',headers:[{id:'a',createdAt:0,version:4,isSeeded:false}],objects:['../../project'],spillNames:[]}));
  const p=parsePlan({version:1,rootId:'a',headers:[{id:'a',createdAt:0,version:4,isSeeded:false,message:'secret'}],objects:[],spillNames:[]});
  assert(!JSON.stringify(p).includes('secret'));
});
