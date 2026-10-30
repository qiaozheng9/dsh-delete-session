import fs from 'node:fs/promises';
import path from 'node:path';

/** The extension is optional; a broken installation is not treated as absent. */
export async function optionalSidebar(directory) {
  try {return JSON.parse(await fs.readFile(path.join(directory,'package.json'),'utf8'));}
  catch(error) {
    if(error.code!=='ENOENT')throw error;
    try {await fs.stat(directory);}catch(missing){if(missing.code==='ENOENT')return undefined;throw missing;}
    throw new Error('检测到不完整的侧栏扩展安装，请先修复或移除该扩展。');
  }
}

export async function sidebarPlan(directory,manifest) {
  const installed=await optionalSidebar(directory);
  if(!installed)return {};
  if(!manifest.sidebarVersion||!Object.keys(manifest.sidebar).length)throw new Error('检测到侧栏扩展，请重新构建以启用兼容适配。');
  if(installed.version!==manifest.sidebarVersion)throw new Error('侧栏扩展版本尚未适配。');
  return manifest.sidebar;
}
