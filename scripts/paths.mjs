import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const projectRoot=fileURLToPath(new URL('../',import.meta.url));

function readJson(file) {
  try {return JSON.parse(fs.readFileSync(file,'utf8'));}
  catch(error){if(error.code==='ENOENT')return undefined;throw error;}
}
function absolute(value,label) {
  if(typeof value!=='string'||!path.isAbsolute(value))throw new Error(`${label} must be an absolute path`);
  return path.resolve(value);
}
function canonical(value) {
  try{return fs.realpathSync(value);}catch(error){if(error.code==='ENOENT')return value;throw error;}
}
export function samePath(left,right) {
  const normalize=p=>process.platform==='win32'?path.resolve(p).toLowerCase():path.resolve(p);
  return normalize(left)===normalize(right);
}

/** Local settings never belong in a published source archive. */
export function resolvePaths({project=projectRoot,env=process.env,config:givenConfig,installed:givenInstalled}={}) {
  const config=givenConfig??readJson(path.join(project,'local.config.json'))??{};
  if(!config||typeof config!=='object'||Array.isArray(config))throw new Error('local.config.json must be an object');
  const stateDir=absolute(env.DSH_STATE_DIR??path.join(project,'.local'),'DSH_STATE_DIR');
  const installed=givenInstalled??readJson(path.join(stateDir,'installed.json'));
  const programs=env.LOCALAPPDATA&&path.join(env.LOCALAPPDATA,'Programs','DeepSeek Harness');
  const candidates=[programs,env.ProgramFiles&&path.join(env.ProgramFiles,'DeepSeek Harness'),
    'D:/software/DeepSeek Harness','D:/software/dsh'].filter(Boolean);
  const detected=candidates.find(p=>fs.existsSync(path.join(p,'resources','app.asar')));
  const selected=env.DSH_APP_DIR??config.appDir??installed?.application??detected;
  const application=selected?absolute(selected,'DSH_APP_DIR / appDir'):undefined;
  const home=canonical(absolute(env.DSH_HOME??config.home??installed?.home??path.join(os.homedir(),'.dsh'),'DSH_HOME / home'));
  const sidebar=absolute(env.DSH_SIDEBAR??path.join(home,'profiles','desktop','node_modules','dsh-better-sidebar'),'DSH_SIDEBAR');
  const archive=application&&path.join(application,'resources','app.asar');
  return {project,stateDir,stateFile:path.join(stateDir,'installed.json'),installed,application,home,
    profile:path.join(home,'profiles','desktop'),sidebar,archive,
    sourceArchive:env.DSH_ASAR?absolute(env.DSH_ASAR,'DSH_ASAR'):installed?path.join(installed.backup,'app.asar'):archive,
    sourceSidebar:env.DSH_SIDEBAR?sidebar:installed&&Object.keys(installed.sidebar??{}).length?path.join(installed.backup,'sidebar'):sidebar,
    electron:env.DSH_ELECTRON?absolute(env.DSH_ELECTRON,'DSH_ELECTRON'):application&&path.join(application,'DeepSeek Harness.exe')};
}
export function requireApplication(paths) {
  if(!paths.application)throw new Error('DeepSeek Harness not found. Set DSH_APP_DIR or copy local.config.example.json to local.config.json.');
  return paths;
}
export function browserExecutable(env=process.env) {
  if(env.DSH_TEST_BROWSER)return absolute(env.DSH_TEST_BROWSER,'DSH_TEST_BROWSER');
  const candidates=[
    env['ProgramFiles(x86)']&&path.join(env['ProgramFiles(x86)'],'Microsoft','Edge','Application','msedge.exe'),
    env.ProgramFiles&&path.join(env.ProgramFiles,'Google','Chrome','Application','chrome.exe'),
    env.LOCALAPPDATA&&path.join(env.LOCALAPPDATA,'Google','Chrome','Application','chrome.exe')
  ].filter(Boolean);
  const found=candidates.find(p=>fs.existsSync(p));
  if(!found)throw new Error('Set DSH_TEST_BROWSER to an installed Chromium browser executable.');
  return found;
}
