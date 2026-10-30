import { lstat, realpath, readdir, rm, unlink } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep, join } from 'node:path';

export function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/** The root may be a user-configured junction. Descendants may never be links. */
export async function checkedPath(root: string, target: string): Promise<string> {
  const lexicalRoot = resolve(root);
  let canonicalRoot: string;
  try { canonicalRoot = await realpath(lexicalRoot); }
  catch (error) { if (isMissing(error)) canonicalRoot=lexicalRoot; else throw error; }
  const outside=(rel:string)=>!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  let rel=relative(lexicalRoot,resolve(target));
  if(outside(rel))rel=relative(canonicalRoot,resolve(target));
  if(outside(rel))throw new Error('Refusing a deletion outside its data root, or of the root itself');
  let current = canonicalRoot;
  for (const part of rel.split(sep)) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`Refusing linked data path: ${current}`);
    } catch (error) { if (!isMissing(error)) throw error; }
  }
  return current;
}

export async function checkTree(root: string, target: string): Promise<string> {
  const checked = await checkedPath(root, target);
  let info;
  try { info = await lstat(checked); }
  catch (error) { if (isMissing(error)) return checked; throw error; }
  if (info.isDirectory()) {
    for (const item of await readdir(checked)) await checkTree(root, join(checked, item));
  }
  return checked;
}

export async function removeTree(root: string, target: string, keep?: string): Promise<void> {
  const checked = await checkTree(root, target);
  try {
    if (keep) {
      for (const item of await readdir(checked)) {
        if (item !== keep) await rm(await checkTree(root, join(checked, item)), { recursive: true, force: true });
      }
    } else await rm(checked, { recursive: true, force: true });
  } catch (error) { if (!isMissing(error)) throw error; }
}

export async function removeFile(root: string, target: string): Promise<void> {
  try { await unlink(await checkedPath(root, target)); }
  catch (error) { if (!isMissing(error)) throw error; }
}
