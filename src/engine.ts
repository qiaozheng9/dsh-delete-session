import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readdir, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { checkedPath, isMissing, removeFile } from './safety.ts';
import { type DeletionGate } from './gate.ts';

export interface Header { id: string; cwd?: string; origin?: string; parentSession?: string; createdAt: number; version: number; isSeeded: boolean; delegationDepth?: number }
export interface Plan { version: 1; rootId: string; headers: Header[]; objects: string[]; spillNames: string[] }
export interface Preview { sessionId: string; token: string; title: string; descendantCount: number; running: boolean; retry: boolean }
export interface Driver {
  journalRoot: string;
  gate: DeletionGate;
  plan(id: string): Promise<Plan>;
  title(id: string): string;
  activity(ids: string[]): Promise<boolean>;
  preflight(plan: Plan): Promise<void>;
  stop(ids: string[]): Promise<void>;
  refresh?(plan: Plan): Promise<Plan>;
  acquire(plan: Plan): Promise<() => Promise<void>>;
  clean(plan: Plan): Promise<void>;
  notify(ids: string[]): Promise<void>;
}

export function descendants(headers: Header[], root: string): Header[] {
  const map = new Map(headers.map(h => [h.id, h]));
  const result = new Set([root]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const h of headers) if (h.origin === 'subagent' && h.parentSession && result.has(h.parentSession) && !result.has(h.id)) {
      result.add(h.id); changed = true;
    }
  }
  return [...result].map(id => map.get(id)).filter((h): h is Header => h !== undefined).sort((a,b) => a.id.localeCompare(b.id));
}

export function token(plan: Plan): string {
  // Content may grow while a dialog is open. Confirm identity and subtree membership, not mutable messages.
  return createHash('sha256').update(JSON.stringify(plan.headers.map(h => [h.id,h.createdAt,h.origin,h.parentSession]).sort())).digest('hex');
}
export function journalName(id: string): string { return createHash('sha256').update(id).digest('hex') + '.json'; }

export function parsePlan(value: unknown): Plan {
  if (!value || typeof value !== 'object') throw new Error('Invalid deletion journal');
  const p = value as Partial<Plan>;
  if (p.version !== 1 || typeof p.rootId !== 'string' || !p.rootId || !Array.isArray(p.headers) || !p.headers.length ||
      !Array.isArray(p.objects) || !p.objects.every(x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x)) ||
      !Array.isArray(p.spillNames) || !p.spillNames.every(x => typeof x === 'string' && /^session-[a-f0-9]{12}$/.test(x))) throw new Error('Invalid deletion journal');
  const headers = p.headers.map(h => {
    if (!h || typeof h.id !== 'string' || !h.id || typeof h.createdAt !== 'number' || !Number.isSafeInteger(h.createdAt) ||
        typeof h.version !== 'number' || typeof h.isSeeded !== 'boolean' ||
        (h.cwd !== undefined && typeof h.cwd !== 'string') || (h.origin !== undefined && typeof h.origin !== 'string') ||
        (h.parentSession !== undefined && typeof h.parentSession !== 'string')) throw new Error('Invalid deletion journal header');
    return { id: h.id, createdAt: h.createdAt, version: h.version, isSeeded: h.isSeeded,
      ...(h.cwd === undefined ? {} : {cwd:h.cwd}), ...(h.origin === undefined ? {} : {origin:h.origin}),
      ...(h.parentSession === undefined ? {} : {parentSession:h.parentSession}), ...(h.delegationDepth === undefined ? {} : {delegationDepth:h.delegationDepth}) };
  });
  if (!headers.some(h => h.id === p.rootId) || new Set(headers.map(h => h.id)).size !== headers.length) throw new Error('Invalid deletion journal membership');
  return { version:1, rootId:p.rootId, headers, objects:p.objects, spillNames:p.spillNames };
}

export class DeleteEngine {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(readonly driver: Driver) {}
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const op = this.tail.then(fn); this.tail = op.catch(() => {}); return op;
  }
  private async pending(id: string): Promise<Plan | undefined> {
    await this.journalSafety();
    try { return parsePlan(JSON.parse(await readFile(await checkedPath(this.driver.journalRoot, join(this.driver.journalRoot,journalName(id))), 'utf8'))); }
    catch(e) { if(isMissing(e)) return; throw e; }
  }
  async preview(id: string): Promise<Preview> {
    return this.serial(async () => {
      const pending = await this.pending(id);
      const plan = pending ?? await this.driver.plan(id);
      return { sessionId:id, token:token(plan), title:this.driver.title(id), descendantCount:plan.headers.length-1,
        running:await this.driver.activity(plan.headers.map(h=>h.id)), retry:pending !== undefined };
    });
  }
  execute(id: string, expected: string, stopActivity: boolean): Promise<string[]> {
    return this.serial(async () => {
      const pending = await this.pending(id);
      let plan = pending ?? await this.driver.plan(id);
      if (token(plan) !== expected) throw new Error('对话关联范围已变化，请重新确认删除');
      const ids = new Set(plan.headers.map(h=>h.id));
      for(const id of ids) this.driver.gate.blocked.add(id);
      let durable = pending !== undefined;
      try {
        await this.driver.gate.drain(ids);
        if (!pending) {
          const fresh = await this.driver.plan(id);
          if (token(fresh) !== expected) throw new Error('对话关联范围已变化，请重新确认删除');
          plan = fresh;
        }
        await this.driver.preflight(plan);
        if (!stopActivity && await this.driver.activity([...ids])) throw new Error('对话正在运行，请选择停止并永久删除');
        await this.save(plan); durable = true;
        await this.finish(plan);
        return [...ids];
      } finally {
        if (!durable) for(const id of ids) this.driver.gate.blocked.delete(id);
      }
    });
  }
  async recover(): Promise<void> {
    await this.journalSafety();
    let names: string[];
    try { names = await readdir(this.driver.journalRoot); } catch(e) { if(isMissing(e)) return; throw e; }
    for (const name of names.filter(n=>/^[a-f0-9]{64}\.json$/.test(n))) {
      const p = parsePlan(JSON.parse(await readFile(await checkedPath(this.driver.journalRoot,join(this.driver.journalRoot,name)),'utf8')));
      if(name !== journalName(p.rootId)) throw new Error('Deletion journal identity mismatch');
      for(const h of p.headers) this.driver.gate.blocked.add(h.id);
      await this.serial(() => this.finish(p));
    }
  }
  private async save(plan: Plan): Promise<void> {
    await this.journalSafety();
    await mkdir(this.driver.journalRoot,{recursive:true,mode:0o700});
    const file = await checkedPath(this.driver.journalRoot,join(this.driver.journalRoot,journalName(plan.rootId)));
    const temp = await checkedPath(this.driver.journalRoot,file+'.tmp');
    const fd = await open(temp,'w',0o600);
    try { await fd.writeFile(JSON.stringify(plan)); await fd.sync(); } finally { await fd.close(); }
    await rename(temp,file);
  }
  private async journalSafety(): Promise<void> {
    try { if((await lstat(this.driver.journalRoot)).isSymbolicLink())throw new Error('Refusing linked deletion journal directory'); }
    catch(e){if(!isMissing(e))throw e;}
  }
  private async completed(ids: string[]): Promise<void> {
    await this.journalSafety();
    const file=await checkedPath(this.driver.journalRoot,join(this.driver.journalRoot,'completed.json'));
    let previous: unknown=[];
    try{previous=JSON.parse(await readFile(file,'utf8'));}catch(e){if(!isMissing(e))throw e;}
    if(!Array.isArray(previous)||!previous.every(id=>typeof id==='string'&&id.length>0&&id.length<=512))throw new Error('Invalid deletion completion receipt');
    const temp=await checkedPath(this.driver.journalRoot,file+'.tmp');
    const handle=await open(temp,'w',0o600);
    try{await handle.writeFile(JSON.stringify([...new Set([...previous,...ids])]));await handle.sync();}finally{await handle.close();}
    await rename(temp,file);
  }
  private async finish(plan: Plan): Promise<void> {
    const ids = plan.headers.map(h=>h.id);
    await this.driver.preflight(plan);
    await this.driver.stop(ids);
    if(this.driver.refresh) {
      plan=await this.driver.refresh(plan);
      await this.save(plan);
      await this.driver.preflight(plan);
    }
    const release = await this.driver.acquire(plan);
    try { await this.driver.clean(plan); } finally { await release(); }
    // IDs only: reconnecting/offline windows can purge their own stale drafts,
    // and a delayed delivery cannot recreate a previously deleted identity.
    await this.completed(ids);
    for(const id of ids) { this.driver.gate.deleted.add(id); this.driver.gate.blocked.delete(id); }
    await this.driver.notify(ids);
    await removeFile(this.driver.journalRoot,join(this.driver.journalRoot,journalName(plan.rootId)));
  }
}
