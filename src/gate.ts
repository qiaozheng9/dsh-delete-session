import { AsyncLocalStorage } from 'node:async_hooks';

export class DeletionGate {
  readonly blocked = new Set<string>();
  readonly deleted = new Set<string>();
  private readonly bypass = new AsyncLocalStorage<boolean>();
  private readonly operations = new Set<{ ids: string[]; done: Promise<unknown> }>();
  readonly disposers = new WeakMap<object, () => Promise<void>>();
  private readonly referencing = new AsyncLocalStorage<boolean>();
  private readonly referenceOperations = new Set<Promise<unknown>>();
  private collecting?: Promise<void>;

  assert(ids: (string | undefined)[]): void {
    if (this.bypass.getStore()) return;
    if (ids.some(id => id !== undefined && (this.blocked.has(id) || this.deleted.has(id)))) {
      throw new Error('该对话正在永久删除或已被删除，不能恢复或写入');
    }
  }
  async run<T>(ids: (string | undefined)[], operation: () => Promise<T>): Promise<T> {
    this.assert(ids);
    if (this.bypass.getStore()) return operation();
    const result = Promise.resolve().then(operation);
    const record = { ids: ids.filter((id): id is string => id !== undefined), done: result };
    this.operations.add(record);
    try { return await result; } finally { this.operations.delete(record); }
  }
  async drain(ids: Set<string>): Promise<void> {
    await Promise.allSettled([...this.operations].filter(op => op.ids.some(id => ids.has(id))).map(op => op.done));
  }
  internal<T>(operation: () => T): T { return this.bypass.run(true, operation); }
  async referenceMutation<T>(operation: () => Promise<T>): Promise<T> {
    if(this.referencing.getStore())return operation();
    while(this.collecting)await this.collecting;
    const result=this.referencing.run(true,()=>Promise.resolve().then(operation));
    this.referenceOperations.add(result);
    try{return await result;}finally{this.referenceOperations.delete(result);}
  }
  async collect<T>(operation: () => Promise<T>): Promise<T> {
    while(this.collecting)await this.collecting;
    let release!:()=>void;
    this.collecting=new Promise<void>(resolve=>{release=resolve;});
    try{await Promise.allSettled([...this.referenceOperations]);return await operation();}
    finally{this.collecting=undefined;release();}
  }
}

const key = Symbol.for('dsh-delete-session.bridge.v1');
const globals = globalThis as typeof globalThis & { [key]?: DeletionGate };
export const gate = globals[key] ??= new DeletionGate();

export function guardMethods(prototype: Record<string, unknown>, names: string[], ids: (name: string, args: unknown[]) => (string | undefined)[]): void {
  for (const name of names) {
    const original = prototype[name];
    if (typeof original !== 'function') throw new Error(`Deletion compatibility hook missing: ${name}`);
    prototype[name] = function(this: unknown, ...args: unknown[]) {
      return gate.run(ids(name, args), () => original.apply(this, args));
    };
  }
}
