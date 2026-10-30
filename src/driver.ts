// @ts-nocheck
// Binding for the exact, hash-checked installed DSH service ABI. Persistence,
// lifecycle and storage-domain queues remain owned by the original providers.
import { createHash } from 'node:crypto';
import { join, dirname, basename } from 'node:path';
import { readdir, lstat, readFile } from 'node:fs/promises';
import { gate } from './gate.ts';
import { descendants, parsePlan } from './engine.ts';
import { objectReferences } from './references.ts';
import { titleText } from './title.ts';
import { checkTree, checkedPath, removeTree, removeFile, isMissing } from './safety.ts';

export function createDriver(ctx, notify) {
  const persistence=ctx.sessionPersistence;
  const home=dirname(persistence.root);
  const titles=new Map();
  if(typeof persistence.deleteSessionAcquire !== 'function') throw new Error('永久删除存储补丁未安装，请重新安装增强包');
  const spillName=id=>'session-'+createHash('sha256').update(id).digest('hex').slice(0,12);
  const internal=fn=>gate.internal(fn);
  async function headers() {
    const all=new Map((await internal(()=>persistence.list())).map(item=>[item.header.id,item.header]));
    for(const s of ctx.sessions.list()) all.set(s.id,s.header);
    // Stale workspace rows are still removable after their log has vanished.
    for(const [id,h] of ctx.workspaceRegistry.headers) if(!all.has(id)) all.set(id,h);
    for(const entity of ctx.workspaceRegistry.entities.values())for(const id of entity.record.sessionIds)if(!all.has(id))all.set(id,{id,version:4,createdAt:0,isSeeded:false,cwd:entity.path});
    for(const id of [...ctx.workspaceRegistry.archivedSessionIds,...ctx.workspaceRegistry.pinnedSessionIds])if(!all.has(id))all.set(id,{id,version:4,createdAt:0,isSeeded:false});
    return [...all.values()];
  }
  async function events(h) {
    const live=ctx.sessions.get(h.id);
    if(live) return live.log;
    const stored=await internal(()=>persistence.stat(h.id));
    if(!stored) return [];
    const handle=await internal(()=>persistence.open(h.id,'read'));
    try { return (await handle.read()).events; } finally { await handle.close(); }
  }
  async function survivors(plan) {
    const deleting=new Set(plan.headers.map(h=>h.id));
    const refs=new Set();
    const spillRefs=new Set();
    for(const h of await headers()) if(!deleting.has(h.id)) {
      if(plan.spillNames.includes(spillName(h.id)))spillRefs.add(spillName(h.id));
      const content=await events(h);
      objectReferences(content,refs);
      const text=JSON.stringify(content);
      for(const name of plan.spillNames) if(text.includes(name)) spillRefs.add(name);
    }
    // Upload receipts not yet committed to a prompt also own their attachment.
    const uploads=ctx.get('fileUploads');
    if(uploads) for(const s of ctx.sessions.list()) if(!deleting.has(s.id)) objectReferences(uploads.stagedFiles.get(s),refs);
    return {refs,spillRefs};
  }
  async function spillRoots() {
    const store=ctx.get('spillStore');
    if(!store) return [];
    if(typeof store.gatherRoots !== 'function') throw new Error('不支持的工具输出存储，不能保证完整清理');
    return (await store.gatherRoots(message=>ctx.logger.warn(message))).map(x=>x.path);
  }
  async function projectionBackups(plan, remove) {
    const root=join(home,'storages','session_projcache','sessions');
    let names;
    try { names=await readdir(root); } catch(e) { if(isMissing(e)) return; throw e; }
    // Released JSON storage encodes UUID-like session ids literally. Nonliteral
    // ids are handled by the domain table; reject ambiguous backup ownership.
    for(const h of plan.headers) {
      if(!/^[A-Za-z0-9_-]+$/.test(h.id)) {
        if(names.some(n=>n.includes('.bak.'))) throw new Error('无法确认历史投影备份归属，请先修复该数据');
        continue;
      }
      for(const name of names) if(name === h.id+'.json' || name.startsWith(h.id+'.json.bak.')) {
        const path=join(root,name); await checkTree(root,path);
        if(remove) await removeFile(root,path);
      }
    }
  }
  return {
    gate, journalRoot:join(home,'delete-session-journal'),
    async plan(id) {
      const all=await headers();
      const hs=descendants(all,id);
      if(!hs.some(h=>h.id===id)) throw new Error('找不到该对话及其残余记录');
      const root=hs.find(h=>h.id===id);
      const stat=await internal(()=>persistence.stat(id));
      if(!stat && ctx.sessions.get(id)?.log.length===0) throw new Error('空白对话尚未持久化');
      const objects=new Set();
      for(const h of hs) {
        objectReferences(await events(h),objects);
        const live=ctx.sessions.get(h.id);
        if(live)objectReferences(ctx.get('fileUploads')?.stagedFiles.get(live),objects);
      }
      try { titles.set(id,titleText(await internal(()=>ctx.sessionQuery.readTitle(id)))); }
      catch { titles.set(id,'未命名对话'); }
      return parsePlan({version:1,rootId:id,headers:hs,objects:[...objects].sort(),spillNames:hs.map(h=>spillName(h.id)).sort()});
    },
    title:id=>titles.get(id) ?? '未命名对话',
    async activity(ids) {
      for(const id of ids) {
        const activity=await ctx.waterfall('workspace/session-activity',{sessionId:id},()=>Promise.resolve([]));
        if(activity.length) return true;
      }
      return false;
    },
    async preflight(plan) {
      await persistence.deleteSessionPreflight(plan.headers);
      await projectionBackups(plan,false);
      for(const root of await spillRoots()) for(const name of plan.spillNames) await checkTree(root,join(root,name));
      const attachments=ctx.get('attachments');
      if(attachments && (!attachments.root || !attachments.cacheRoot)) throw new Error('不支持的附件存储，不能保证完整清理');
      if(attachments) for(const sha of plan.objects) {
        for(const dir of ['objects','file-objects','files']) await checkTree(attachments.root,join(attachments.root,dir,sha.slice(0,2),sha));
      }
      if(attachments&&plan.objects.length)await checkTree(attachments.cacheRoot,join(attachments.cacheRoot,'request-images'));
      // All surviving histories must be readable before reference-based GC.
      await survivors(plan);
    },
    async stop(ids) {
      // Stop schedules first; this awaits deletion from their durable task table.
      for(const id of ids) await ctx.parallel('workspace/session-stop',{sessionId:id});
      for(const id of [...ids].reverse()) {
        const agent=ctx.agents.get(id);
        if(agent) {
          const dispose=gate.disposers.get(agent);
          if(!dispose) throw new Error(`该对话由不支持的运行器持有，未删除：${id}`);
          await dispose();
        }
        if(ctx.sessions.get(id)) throw new Error(`对话仍被其他组件持有，未删除：${id}`);
      }
      // Do not proceed after a provider merely logs a failed kill.
      for(const id of ids) {
        const activity=await ctx.waterfall('workspace/session-activity',{sessionId:id},()=>Promise.resolve([]));
        if(activity.length) throw new Error('相关后台任务尚未停止，删除未完成，可重试');
      }
      await gate.drain(new Set(ids));
    },
    acquire:plan=>persistence.deleteSessionAcquire(plan.headers),
    async refresh(plan) {
      const objects=new Set(plan.objects);
      for(const h of plan.headers)objectReferences(await events(h),objects);
      return {...plan,objects:[...objects].sort()};
    },
    async clean(plan) {
      return gate.collect(async()=>{
      const ids=plan.headers.map(h=>h.id);
      const {refs,spillRefs}=await survivors(plan);
      const attachments=ctx.get('attachments');
      if(attachments) {
        for(const sha of plan.objects) if(!refs.has(sha)) {
          await removeFile(attachments.root,join(attachments.root,'objects',sha.slice(0,2),sha));
          await removeFile(attachments.root,join(attachments.root,'file-objects',sha.slice(0,2),sha));
          await removeTree(attachments.root,join(attachments.root,'files',sha.slice(0,2),sha));
        }
        // Old request-image caches have no reverse index. They are disposable
        // derivatives; invalidate them rather than leave unidentified copies.
        if(plan.objects.length) {
          await Promise.allSettled([...attachments.requestInflight.values()].map(x=>x.promise));
          await removeTree(attachments.cacheRoot,join(attachments.cacheRoot,'request-images'));
        }
      }
      for(const root of await spillRoots()) for(const name of plan.spillNames) if(!spillRefs.has(name)) await removeTree(root,join(root,name));
      await ctx.sessionProjectionCache.deleteSessionRecords(ids);
      await projectionBackups(plan,true);
      await persistence.deleteSessionFiles(plan.headers);
      await ctx.sessionQuery.deleteSessionRecords(ids);
      await ctx.workspaceRegistry.deleteSessionRecords(ids);
      });
    },
    async notify(ids) {
      for(const id of ids) ctx.emit('api-session/removed',id);
      await notify(ids);
    }
  };
}
