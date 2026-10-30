// @ts-nocheck
// Version-pinned adapter to the installed 0.2.1-rc.5 private ABI. The patcher
// verifies every original byte before these hooks can be installed.
import { readdirSync, readFileSync, existsSync, lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readdir, rmdir } from 'node:fs/promises';
import { gate, guardMethods } from './gate.ts';
import { parsePlan, journalName } from './engine.ts';
import { checkTree, checkedPath, removeTree, removeFile, isMissing } from './safety.ts';
export { gate, guardMethods };

export function initializeGate(root) {
  const journalRoot = join(dirname(root), 'delete-session-journal');
  if (!existsSync(journalRoot)) return;
  if (lstatSync(journalRoot).isSymbolicLink()) throw new Error('Refusing linked deletion journal');
  const completed=join(journalRoot,'completed.json');
  if(existsSync(completed)) {
    if(lstatSync(completed).isSymbolicLink())throw new Error('Refusing linked deletion receipt');
    const ids=JSON.parse(readFileSync(completed,'utf8'));
    if(!Array.isArray(ids)||!ids.every(id=>typeof id==='string'&&id.length>0&&id.length<=512))throw new Error('Invalid deletion receipt');
    ids.forEach(id=>gate.deleted.add(id));
  }
  for (const name of readdirSync(journalRoot)) if (/^[a-f0-9]{64}\.json$/.test(name)) {
    if (lstatSync(join(journalRoot,name)).isSymbolicLink()) throw new Error('Refusing linked deletion journal');
    const p = parsePlan(JSON.parse(readFileSync(join(journalRoot,name),'utf8')));
    if(name !== journalName(p.rootId)) throw new Error('Invalid deletion journal identity');
    for (const h of p.headers) gate.blocked.add(h.id);
  }
}

export function installPersistence(proto, { sessionDir, SessionWriteLease }) {
  guardMethods(proto,['create','open','stat'],(name,args) => name === 'create' ? [args[0].id,args[0].parentSession] : [args[0]]);
  proto.deleteSessionDirectory = function(header) { return sessionDir(this.root,header.cwd,header.id); };
  proto.deleteSessionPreflight = async function(headers) {
    for(const h of headers) {
      await checkTree(this.root,this.deleteSessionDirectory(h));
      const current=await gate.internal(()=>this.stat(h.id));
      if(current && (current.header.createdAt!==h.createdAt || current.header.cwd!==h.cwd))throw new Error('会话存储身份发生变化，请重新确认删除');
    }
  };
  proto.deleteSessionAcquire = async function(headers) {
    const held = [];
    try {
      for(const h of [...headers].sort((a,b)=>a.id.localeCompare(b.id))) {
        if(this.tracker.writers.has(h.id)) throw new Error(`对话仍有写入器占用：${h.id}`);
        for(const handle of [...this.tracker.openHandles]) if(handle.id === h.id) await handle.close();
        const dir = await checkedPath(this.root,this.deleteSessionDirectory(h));
        held.push({id:h.id,dir,lease:await SessionWriteLease.acquire(dir,h.id)});
      }
    } catch(e) { for(const h of held.reverse()) await h.lease.release(); throw e; }
    return async () => {
      for(const item of held.reverse()) {
        await item.lease.release();
        // Only prune an empty directory. If another process created data, never remove it.
        try {
          const names = await readdir(item.dir);
          if(names.length === 1 && names[0] === 'session.lock') await removeFile(this.root,join(item.dir,'session.lock'));
          if((await readdir(item.dir)).length === 0) await rmdir(item.dir);
        } catch(e) { if(!isMissing(e)) throw e; }
      }
    };
  };
  proto.deleteSessionFiles = async function(headers) {
    for(const h of headers) {
      this.migrationPreparations.get(h.id)?.controller.abort();
      this.migrationPreparations.delete(h.id); this.coldLogMemo.delete(h.id);
      await removeTree(this.root,this.deleteSessionDirectory(h),'session.lock');
      this.tracker.pending.delete(h.id);
    }
  };
}

export function installWorkspace(proto) {
  proto.deleteSessionRecords = function(ids) {
    const set = new Set(ids);
    return this.enqueueOperation(async () => {
      // detachSession uses the domain write queue, keeping memory and disk coherent.
      for(const entity of this.entities.values()) for(const id of ids) await entity.detachSession(id);
      const state = this.requireState();
      await this.setState({...state, archivedSessionIds:state.archivedSessionIds.filter(id=>!set.has(id)),
        pinnedSessionIds:state.pinnedSessionIds.filter(id=>!set.has(id))});
      for(const id of ids) { this.headers.delete(id); this.sessionPaths.delete(id); this.missingSessionPaths.delete(id); this.invalidSessionPaths.delete(id); }
    });
  };
}

export function installProjection(proto) {
  guardMethods(proto,['put'],(_name,args)=>[args[0]]);
  proto.deleteSessionRecords = async function(ids) {
    for(const [session,state] of this.dirty) if(ids.includes(session.id)) {
      if(state.timer !== undefined) clearTimeout(state.timer);
      this.dirty.delete(session);
    }
    for(const id of ids) await this.requireTable().delete(id);
  };
}

export function installQuery(proto) {
  proto.deleteSessionRecords = async function(ids) {
    await this._serialized(undefined,async()=>{
      await this._ensureReady(undefined);
      const db=this._requireDb();
      db.exec('BEGIN IMMEDIATE');
      try {
        for(const id of ids) { this._deleteSession('persisted',id); this._deleteSession('live',id); this._observations.cache.delete(id); }
        db.prepare('UPDATE search_state SET global_generation = global_generation + 1 WHERE singleton = 1').run();
        db.exec('COMMIT'); this._globalGeneration++; this._localGeneration++;
      } catch(e) { db.exec('ROLLBACK'); throw e; }
    });
  };
}

export function installAgentRegistry(proto) {
  guardMethods(proto,['create','resume'],(name,args)=>[name==='resume'?args[0].resumeSessionId:args[0].sessionId,args[0].meta?.parentSession,args[0].parentAgent?.id]);
}

export function installApiCommands(proto) {
  // These admission guards include fork before it snapshots the parent's history.
  guardMethods(proto,['fork','prompt','rename'],(_name,args)=>[args[0].sessionId]);
  for(const name of ['fork','prompt']) {
    const original=proto[name];
    proto[name]=function(...args){return gate.referenceMutation(()=>original.apply(this,args));};
  }
}

export function installUploads(proto) {
  guardMethods(proto,['commit'],(_name,args)=>[args[0].id]);
  const original=proto.commit;
  proto.commit=function(...args){return gate.referenceMutation(()=>original.apply(this,args));};
}
