// Run with the application's Electron Node runtime, never against a real DSH_HOME.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL,fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import {resolvePaths} from './paths.mjs';

const project=fileURLToPath(new URL('../',import.meta.url));
const archive=path.join(resolvePaths().stateDir,'patched-app.asar');
const require=createRequire(pathToFileURL(archive+'/dsh/package.json'));
const mod=async name=>import(pathToFileURL(require.resolve('@deepseek-ai/'+name)).href);
const {Context}=await mod('cordis');
const root=await fs.mkdtemp(path.join(project,'.local','runtime-smoke-'));
const ctx=new Context();
const mount=async(name,config)=>{const m=await mod(name);const p=ctx.plugin(m.default??m,config);await p.await();};
let engine;
try {
  await mount('dsh-session');
  await mount('dsh-session-persistence-jsonl',{root:path.join(root,'sessions'),compression:'zstd',listConcurrency:4});
  await mount('dsh-storage');
  await mount('dsh-storage-json',{root:path.join(root,'storages')});
  await mount('dsh-storage-domain',{backend:'json'});
  await mount('dsh-session-projection');
  await mount('dsh-session-projection-cache',{writeEveryEvents:50,writeIntervalMs:10000});
  await mount('dsh-session-title',{fallbackMaxWords:12,fallbackMaxBytes:100,maxTitleBytes:200});
  await mount('dsh-workspace');
  await mount('dsh-session-query-sqlite',{path:path.join(root,'cache','query.sqlite'),openAt:'startup'});
  await mount('dsh-attachment-local',{dshHome:root});
  await mount('dsh-spill-local',{root:path.join(root,'spills'),cleanupPeriodDays:0});
  await mount('dsh-agent');
  await mount('dsh-llm');
  await mount('dsh-system-prompt');
  await mount('dsh-tools');
  await mount('dsh-agent-loop',{maxParallelToolCalls:4,agents:[]});
  // Import the real factory and API modules as well, verifying every installed ABI hook.
  await mod('dsh-agent');await mod('dsh-agent-loop');await mod('dsh-api-session-controller');await mod('dsh-client-file-upload');
  console.log('Real persistence, projection, workspace, SQLite, attachment and spill providers mounted.');
  const ids={root:'session-'+randomUUID(),child:'session-'+randomUUID(),grand:'session-'+randomUUID(),fork:'session-'+randomUUID()};
  const shaUnique=createHash('sha256').update('unique').digest('hex');
  const shaShared=createHash('sha256').update('shared').digest('hex');
  const p=ctx.sessionPersistence;
  const {createUserMessage}=await mod('dsh-llm');
  const references=new Map([[ids.root,[shaUnique,shaShared]],[ids.fork,[shaShared]]]);
  for(const [kind,id]of Object.entries(ids)) {
    const header={id,version:4,createdAt:Date.now(),cwd:root,isSeeded:kind==='fork',delegationDepth:kind==='grand'?2:kind==='child'?1:0,
      ...(kind==='child'?{origin:'subagent',parentSession:ids.root}:kind==='grand'?{origin:'subagent',parentSession:ids.child}:kind==='fork'?{parentSession:ids.root}:{})};
    const h=await p.create(header,kind==='fork'?{inheritedEventCount:1}:undefined);
    const title={type:'session/title',seq:0,time:Date.now(),data:{title:'smoke-'+kind,messageSeqs:[],source:{kind:'user'}}};
    const marker=kind==='fork'?[{type:'session/end-seed',seq:1,time:title.time,data:{inherited:true}}]:[];
    const message={type:'user/message',seq:1+marker.length,time:Date.now(),surfaceOp:'append',data:createUserMessage({content:[{type:'text',text:'smoketest '+kind}],source:{kind:'user'}})};
    const extra=(references.get(id)??[]).map((sha,index)=>({type:'plugin:delete-smoke/reference',ignorable:true,seq:index+2+marker.length,time:Date.now(),data:{attachmentId:'sha256:'+sha}}));
    await h.append([title,...marker,message,...extra]);await h.flush();await h.close();
  }
  for(const sha of [shaShared,shaUnique]) {
    const f=path.join(ctx.attachments.root,'file-objects',sha.slice(0,2),sha);await fs.mkdir(path.dirname(f),{recursive:true});await fs.writeFile(f,'attachment');
  }
  const spill=path.join(ctx.spillStore.root,'session-'+createHash('sha256').update(ids.root).digest('hex').slice(0,12));
  await fs.mkdir(spill,{recursive:true});await fs.writeFile(path.join(spill,'result.txt'),'private tool output');
  const ws=await ctx.workspaceRegistry.create(root);
  for(const id of Object.values(ids))await ws.attachSession(id);
  await ctx.workspaceRegistry.pinSession(ids.root);
  const search=await ctx.sessionQuery.searchSessions({query:'smoketest'});
  assert.equal(search.items.length,4);
  console.log('Seeded real compressed logs and indexed sessions:',search.items.length);
  // Exercise the true native cross-backend write lock before deletion.
  const second=new Context();
  try {
    const module=await mod('dsh-session-persistence-jsonl');
    await second.plugin(module,{root:path.join(root,'sessions'),compression:'zstd',listConcurrency:4}).await();
    const held=await second.sessionPersistence.open(ids.root,'write');
    try {await assert.rejects(p.deleteSessionAcquire([(await p.stat(ids.root)).header]),/owned|占用/);}
    finally {await held.close();}
  } finally {await second.fiber.dispose();}
  // Use the shipped host bundle to avoid a second copy of runtime adapter code.
  const {DeleteEngine}=await import(pathToFileURL(path.join(project,'dist','engine.mjs')).href);
  const {createDriver}=await import(pathToFileURL(path.join(project,'dist','driver.mjs')).href);
  const notifications=[];
  // A genuine live Agent owns the root's write handle. Deletion must dispose
  // its factory lifecycle rather than forcibly closing an active writer.
  const live=await ctx.agents.resume({resumeSessionId:ids.root});
  assert(ctx.agents.get(ids.root));
  engine=new DeleteEngine(createDriver(ctx,ids=>notifications.push(ids)));
  const preview=await engine.preview(ids.root);assert.equal(preview.descendantCount,2);
  assert.equal(preview.title,'smoke-root');
  await engine.execute(ids.root,preview.token,true);
  assert.equal(ctx.agents.get(ids.root),undefined);
  for(const id of [ids.root,ids.child,ids.grand]) {
    assert.equal((await p.list()).some(x=>x.header.id===id),false);
    assert.equal(ctx.workspaceRegistry.pinnedSessionIds.includes(id),false);
    assert.equal(ws.sessionIds.includes(id),false);
    await assert.rejects(p.open(id,'write'),/删除/);
  }
  assert((await p.list()).some(x=>x.header.id===ids.fork));
  assert.equal((await ctx.sessionQuery.searchSessions({query:'smoketest'})).items.length,1);
  await fs.access(path.join(ctx.attachments.root,'file-objects',shaShared.slice(0,2),shaShared));
  await assert.rejects(fs.access(path.join(ctx.attachments.root,'file-objects',shaUnique.slice(0,2),shaUnique)));
  await assert.rejects(fs.access(spill));
  assert.equal(notifications.length,1);
  console.log('PASS: real compressed logs + native locks + SQLite + workspace metadata + exclusive/shared attachments + spill cleanup.');
}finally {
  await ctx.fiber.dispose();
  await fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
