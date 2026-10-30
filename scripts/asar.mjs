import fs from 'node:fs';

/** Read packed files without loading or executing any application module. */
export function openArchive(file) {
  const fd = fs.openSync(file, 'r');
  const prefix = Buffer.alloc(16);
  fs.readSync(fd, prefix, 0, 16, 0);
  const json = Buffer.alloc(prefix.readUInt32LE(12));
  fs.readSync(fd, json, 0, json.length, 16);
  const tree = JSON.parse(json.toString());
  const base = 8 + prefix.readUInt32LE(4);
  function entry(path) {
    let result = tree;
    for (const part of path.split('/')) result = result.files[part];
    return result;
  }
  return {
    tree,
    read(path) {
      const item = entry(path);
      if (item.unpacked) return fs.readFileSync(`${file}.unpacked/${path}`);
      const data = Buffer.alloc(item.size);
      fs.readSync(fd, data, 0, data.length, base + Number(item.offset));
      return data;
    },
    close() { fs.closeSync(fd); }
  };
}
