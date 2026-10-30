import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { openArchive } from './asar.mjs';
const require=createRequire(import.meta.url);
const {Pickle}=require('@electron/asar/lib/pickle.js');

export function integrity(bytes) {
  const blockSize=4194304;
  const digest=b=>createHash('sha256').update(b).digest('hex');
  const blocks=[];
  for(let i=0;i<bytes.length;i+=blockSize)blocks.push(digest(bytes.subarray(i,i+blockSize)));
  if(!blocks.length)blocks.push(digest(Buffer.alloc(0)));
  return {algorithm:'SHA256',hash:digest(bytes),blockSize,blocks};
}

/** Preserve every unpacked/link entry and rebuild packed offsets and integrity. */
export async function repack(source,destination,replacements) {
  const original=openArchive(source);
  const tree=structuredClone(original.tree);
  for(const [name,data]of replacements) {
    const parts=name.split('/');let parent=tree;
    for(const part of parts.slice(0,-1))parent=parent.files[part]??={files:{}};
    parent.files[parts.at(-1)]={size:data.length,offset:'0',integrity:integrity(data)};
  }
  const entries=[];let offset=0;
  function walk(node,prefix='') {
    for(const [name,e]of Object.entries(node.files??{})) {
      const p=prefix?`${prefix}/${name}`:name;
      if(e.files)walk(e,p);
      else if(!e.unpacked&&!e.link){e.offset=String(offset);offset+=e.size;entries.push([p,e]);}
    }
  }
  walk(tree);
  const header=new Pickle();header.writeString(JSON.stringify(tree));
  const headerBytes=header.toBuffer();
  const size=new Pickle();size.writeUInt32(headerBytes.length);
  const fd=await fs.open(destination,'wx');
  try {
    await fd.write(size.toBuffer());await fd.write(headerBytes);
    for(const [p]of entries)await fd.write(replacements.get(p)??original.read(p));
    await fd.sync();
  } finally {await fd.close();original.close();}
}
