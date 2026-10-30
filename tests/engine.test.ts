import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, access } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { DeleteEngine, descendants, token, journalName, type Header, type Plan, type Driver } from '../src/engine.ts';
import { DeletionGate } from '../src/gate.ts';
import { objectReferences } from '../src/references.ts';

const header=(id:string,more:Partial<Header>={}):Header=>({id,version:4,createdAt:1,isSeeded:false,...more});
async function fixture(t:test.TestContext) {
  await mkdir('.local',{recursive:true});
  const root=await mkdtemp(resolve('.local','engine-test-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const gate=new DeletionGate();
  const all=[header('root'),header('child',{origin:'subagent',parentSession:'root'}),header('grandchild',{origin:'subagent',parentSession:'child'}),header('fork',{parentSession:'root',isSeeded:true})];
  for(const h of all){await mkdir(join(root,h.id));await writeFile(join(root,h.id,'session.v4.jsonl.zstd'),'secret transcript');await writeFile(join(root,h.id,'session.v3.jsonl'),'old transcript');}
  const calls:string[]=[];
  let fail=false,owned=false,running=false;
  const driver:Driver={
    gate,journalRoot:join(root,'journal'),
    async plan(id){return {version:1,rootId:id,headers:descendants(all,id),objects:[],spillNames:[]};},
    title:()=> '测试对话', activity:async()=>running,
    preflight:async()=>{calls.push('preflight');},
    stop:async()=>{calls.push('stop');running=false;},
    acquire:async()=>{calls.push('acquire');if(owned)throw new Error('foreign writer');return async()=>{calls.push('release');};},
    clean:async plan=>{calls.push('clean');for(const h of plan.headers)await rm(join(root,h.id),{recursive:true,force:true});if(fail)throw new Error('disk failure');},
    notify:async()=>{calls.push('notify');}
  };
  return {root,gate,all,calls,driver,engine:new DeleteEngine(driver),failure:(v:boolean)=>{fail=v;},ownership:(v:boolean)=>{owned=v;},running:(v:boolean)=>{running=v;}};
}
test('subtree includes nested subagents and leaves independent forks intact',()=>{
  assert.deepEqual(descendants([header('a'),header('b',{origin:'subagent',parentSession:'a'}),header('c',{origin:'subagent',parentSession:'b'}),header('d',{parentSession:'a'})],'a').map(x=>x.id),['a','b','c']);
});
test('hard delete removes all generations, keeps independent conversation, and records IDs only',async t=>{
  const f=await fixture(t);const preview=await f.engine.preview('root');
  assert.equal(preview.descendantCount,2);
  await f.engine.execute('root',preview.token,true);
  assert.equal(await readFile(join(f.root,'fork','session.v3.jsonl'),'utf8'),'old transcript');
  await assert.rejects(access(join(f.root,'root')));
  assert(f.calls.indexOf('stop')<f.calls.indexOf('acquire'));
  assert(f.calls.indexOf('release')<f.calls.indexOf('notify'));
  assert.deepEqual(await readdir(f.driver.journalRoot),['completed.json']);
  const receipt=await readFile(join(f.driver.journalRoot,'completed.json'),'utf8');
  assert(!receipt.includes('secret'));assert.deepEqual(JSON.parse(receipt).sort(),['child','grandchild','root']);
  assert.throws(()=>f.gate.assert(['root']),/删除/);
});
test('changed membership invalidates confirmation before stopping or deleting',async t=>{
  const f=await fixture(t);const p=await f.engine.preview('root');
  f.all.push(header('new-child',{origin:'subagent',parentSession:'root'}));
  await assert.rejects(f.engine.execute('root',p.token,true),/重新确认/);
  assert(!f.calls.includes('stop'));assert.equal(f.gate.blocked.size,0);
});
test('running work requires explicit stop flag, cancellation is side effect free',async t=>{
  const f=await fixture(t);f.running(true);const p=await f.engine.preview('root');
  assert(p.running);await assert.rejects(f.engine.execute('root',p.token,false),/停止/);
  assert(!f.calls.includes('stop'));assert.equal(f.gate.blocked.size,0);
  await assert.rejects(access(f.driver.journalRoot));
});
test('foreign writer lock rejects deletion and leaves a retryable journal',async t=>{
  const f=await fixture(t);f.ownership(true);const p=await f.engine.preview('root');
  await assert.rejects(f.engine.execute('root',p.token,true),/foreign writer/);
  assert(!f.calls.includes('clean'));assert(f.gate.blocked.has('root'));
  const retry=await f.engine.preview('root');assert(retry.retry);
  const journal=await readFile(join(f.driver.journalRoot,journalName('root')),'utf8');
  assert(!journal.includes('secret transcript'));
  f.ownership(false);await f.engine.execute('root',retry.token,true);
});
test('a crash after file removal retries missing files, clears metadata, and only then notifies',async t=>{
  const f=await fixture(t);f.failure(true);const p=await f.engine.preview('root');
  await assert.rejects(f.engine.execute('root',p.token,true),/disk failure/);
  assert(!f.calls.includes('notify'));assert(f.gate.blocked.has('root'));
  f.failure(false);f.calls.length=0;
  await new DeleteEngine(f.driver).recover();
  assert(f.calls.includes('clean'));assert(f.calls.includes('notify'));
  assert.deepEqual(await readdir(f.driver.journalRoot),['completed.json']);
});
test('waits for already admitted work and rechecks the descendant graph',async t=>{
  const f=await fixture(t);const p=await f.engine.preview('root');
  let done!:()=>void;const ready=new Promise<void>(r=>{done=r;});
  const pending=f.gate.run(['root'],async()=>{await ready;f.all.push(header('late',{origin:'subagent',parentSession:'root'}));});
  const deleting=f.engine.execute('root',p.token,true);
  await new Promise(r=>setTimeout(r,20));assert(!f.calls.includes('stop'));
  done();await pending;await assert.rejects(deleting,/重新确认/);
  assert.equal(f.gate.blocked.size,0);
});
test('captures resources produced during cancellation before deleting',async t=>{
  const f=await fixture(t);const sha='a'.repeat(64);let seen:Plan|undefined;
  f.driver.refresh=async p=>({...p,objects:[sha]});
  f.driver.clean=async p=>{seen=p;};
  const p=await f.engine.preview('root');await f.engine.execute('root',p.token,true);
  assert.deepEqual(seen?.objects,[sha]);
});
test('reference collection waits for admitted uploads, including nested admissions',async()=>{
  const gate=new DeletionGate();const order:string[]=[];let release!:()=>void;
  const wait=new Promise<void>(r=>{release=r;});
  const uploading=gate.referenceMutation(async()=>{await wait;await gate.referenceMutation(async()=>{order.push('nested');});order.push('upload');});
  const gc=gate.collect(async()=>{order.push('gc');});
  const late=gate.referenceMutation(async()=>{order.push('late');});
  release();await Promise.all([uploading,gc,late]);
  assert.deepEqual(order,['nested','upload','gc','late']);
});
test('reference scanning sees shared attachment IDs in logs and staged receipt maps',()=>{
  const shared='a'.repeat(64),unique='b'.repeat(64);
  const receipts=new Map([['receipt',{file:{attachmentId:'sha256:'+shared}}]]);
  assert.deepEqual([...objectReferences({logs:[{text:JSON.stringify({attachmentId:'sha256:'+unique})}],receipts})].sort(),[shared,unique]);
});
