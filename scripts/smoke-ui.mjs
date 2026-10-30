import {createServer} from 'node:http';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {chromium} from 'playwright-core';
import {patchSidebar} from './client-patches.mjs';
import {resolvePaths,browserExecutable} from './paths.mjs';
import {optionalSidebar} from './sidebar.mjs';

const paths=resolvePaths();
const extension=await optionalSidebar(paths.sidebar);
let adapter='';
if(extension) {
  const original=await fs.readFile(paths.sourceSidebar+'/lib/client.js','utf8');
  const patched=patchSidebar(original);
  const start=patched.indexOf("ctx.effect(() => {\n        const deleted=new Set();");
  const finish=patched.indexOf("},'delete-session: Better Sidebar cache cleanup');",start)+"},'delete-session: Better Sidebar cache cleanup');".length;
  assert(start>0&&finish>start);
  adapter=patched.slice(start,finish);
}
const harness=`
import React from 'react';import{createRoot}from'react-dom/client';import{createPortal}from'react-dom';
const root=createRoot(document.getElementById('app'));const components=[];
window.__calls={clear:0,records:[],sidebarWrites:0};
const sidebarStore={persistTimers:new Map(),bySession:new Map([['root',{bottomSplits:{kind:'leaf',tabs:[],active:null}}],['other',{bottomSplits:{kind:'leaf',tabs:[{id:'side',meta:{threadId:'root'}},{id:'keep',meta:{threadId:'keep-thread'}}],active:'side'}}]]),
snapshot:{sessionId:'root'},getSessionStates(){return this.bySession},reduceFor(id,fn){this.bySession.set(id,fn(this.bySession.get(id)))},setSession(id){this.snapshot.sessionId=id},notify(){}};
const service={closeTab(){}};const nativeRecords={deleteSessions(){}};
const lastThreadBySession=new Map();let lastThreadsWrite;let parkedReopen='root';const LAST_THREAD_KEY='dsh-sidebar:v1:sidechat-thread';let lastThreadsLoaded=false;
localStorage.setItem(LAST_THREAD_KEY,JSON.stringify({root:'root',other:'root',untouched:'keep-thread'}));
function loadLastThreads(){if(lastThreadsLoaded)return;lastThreadsLoaded=true;for(const[k,v]of Object.entries(JSON.parse(localStorage.getItem(LAST_THREAD_KEY))))lastThreadBySession.set(k,v);}
const render=()=>root.render(React.createElement(React.Fragment,null,...components.map((C,i)=>React.createElement(C,i?{key:i}:{key:i,sessionId:'root',useMenuOpenState:()=>[true,()=>{}]}))));
const ctx={effect(fn){fn();},slots:{inject(_n,fn){fn();},register(spec,C){components.push(C);render();return()=>{};}},
uiWorkspace:{mainReference:{sessionId:'root'},clearMain(){window.__calls.clear++;this.mainReference=undefined;}},
sessions:{async deleteSessionRecords(ids){window.__calls.records.push(...ids);}}};
localStorage.setItem('dsh.conversation.root','private draft');localStorage.setItem('dsh.conversation.other','keep draft');localStorage.setItem('dsh-sidebar:v1:root','private layout');
if(${Boolean(extension)})sidebarStore.persistTimers.set('root',setTimeout(()=>{window.__calls.sidebarWrites++;localStorage.setItem('dsh-sidebar:v1:root','resurrected');},15000));
${adapter}
window.__sidebar=sidebarStore;
const primitives={
 MenuItemButton:props=>React.createElement('button',{onClick:props.onSelect},props.children),
 IconTrashOutlineRegular:({size})=>React.createElement('svg',{width:size,height:size,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','aria-hidden':true},React.createElement('path',{d:'M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6'})),
 Button:({variant,className,...props})=>React.createElement('button',{...props,className:'native-button '+(className??'')}),
 Modal:({open,onClose,title,closeLabel,children,footer,className})=>open?createPortal(React.createElement('div',{className:'native-root'},React.createElement('div',{className:'native-mask',onClick:onClose}),React.createElement('section',{role:'dialog','aria-modal':true,'aria-label':title,className:'native-modal '+className},React.createElement('header',null,React.createElement('h2',null,title),React.createElement('button',{'aria-label':closeLabel,onClick:onClose},'×')),React.createElement('main',null,children),React.createElement('footer',null,footer))),document.body):null
};
window.__ModuleLoader__={load({factory}){const plugin=factory(name=>name==='react'?React:name==='@deepseek-ai/dsh-client-ui-primitives'?primitives:(()=>{throw new Error(name)})());plugin.apply(ctx);}};
`;
const {outputFiles}=await build({stdin:{contents:harness,resolveDir:process.cwd()},bundle:true,write:false,format:'iife',platform:'browser'});
const bundle=outputFiles[0].text;
const client=await fs.readFile('dist/plugin/lib/client.js','utf8');
const peers=new Set();let executions=0;let previews=0;let descendants=2;
const server=createServer(async(req,res)=>{
  const p=new URL(req.url,'http://local').pathname;
  if(p==='/'){res.setHeader('content-type','text/html');res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Permanent deletion UI smoke</title><style>body{font:14px system-ui;margin:32px}button{cursor:pointer}.native-root{position:fixed;inset:0;display:grid;place-items:center;padding:16px}.native-mask{position:absolute;inset:0;background:#0004;backdrop-filter:blur(3px)}.native-modal{position:relative;box-sizing:border-box;border-radius:16px;background:#fff;padding-bottom:24px;box-shadow:0 16px 64px #0002}.native-modal header{display:flex;align-items:center;justify-content:space-between;padding:22px 18px 12px 24px}.native-modal h2{font-size:16px;line-height:24px;font-weight:500;margin:0}.native-modal header button{border:0;background:transparent;color:#777;font-size:20px}.native-modal main{margin-top:20px;padding:0 24px}.native-modal footer{display:flex;justify-content:flex-end;gap:8px;padding:20px 24px 0}.native-button{font:inherit;min-height:34px;padding:7px 16px;border:1px solid #ddd;border-radius:8px;background:white}</style><div id="app"></div><script src="/harness.js"></script><script src="/client.js"></script></html>');return;}
  if(p==='/harness.js'||p==='/client.js'){res.setHeader('content-type','application/javascript');res.end(p==='/harness.js'?bundle:client);return;}
  if(p==='/api/delete-session/events') {res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: {"type":"deleted","sessionIds":[]}\n\n');peers.add(res);req.on('close',()=>peers.delete(res));return;}
  if(!p.startsWith('/api/delete-session/')){res.statusCode=404;res.end();return;}
  const body=JSON.parse(await Array.fromAsync(req).then(parts=>Buffer.concat(parts).toString()));
  assert.equal(body.sessionId,'root');res.setHeader('content-type','application/json');
  if(p.endsWith('/preview')){previews++;res.end(JSON.stringify({ok:true,value:{sessionId:'root',token:'a'.repeat(64),title:{title:'测试对话 <script>',source:{kind:'user'}},descendantCount:descendants,running:descendants>0,retry:executions>0}}));return;}
  if(p.endsWith('/execute')){
    assert.equal(body.stopActivity,true);assert.equal(body.token,'a'.repeat(64));executions++;
    if(executions===1){res.statusCode=409;res.end(JSON.stringify({ok:false,error:{message:'测试磁盘占用'}}));return;}
    for(const peer of peers)peer.write('data: {"type":"deleted","sessionIds":["root","child","grandchild"]}\n\n');
    res.end(JSON.stringify({ok:true,value:{sessionIds:['root','child','grandchild']}}));return;
  }
  res.statusCode=404;res.end();
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try{
  browser=await chromium.launch({executablePath:browserExecutable(),headless:true});
  const page=await browser.newPage({viewport:{width:1100,height:760}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:'+server.address().port);
  await page.getByRole('button',{name:'永久删除',exact:true}).click();
  await page.getByRole('button',{name:'停止并永久删除',exact:true}).waitFor();
  assert(await page.getByRole('dialog').isVisible());
  assert((await page.getByRole('dialog').textContent()).includes('2 个子代理'));
  assert((await page.getByRole('dialog').textContent()).includes('<script>'));
  assert(!(await page.getByRole('dialog').textContent()).includes('[object Object]'));
  assert(!(await page.getByRole('dialog').textContent()).includes('独立分支'));
  await page.screenshot({path:'.local/delete-dialog-new.png'});
  await page.getByRole('button',{name:'取消',exact:true}).click();assert.equal(executions,0);
  await page.getByRole('button',{name:'永久删除',exact:true}).click();
  await page.getByRole('button',{name:'停止并永久删除',exact:true}).click();
  await page.getByRole('alert').waitFor();assert((await page.getByRole('alert').textContent()).includes('测试磁盘占用'));
  assert.equal(await page.evaluate(()=>localStorage.getItem('dsh.conversation.root')),'private draft');
  await page.getByRole('button',{name:'重试永久删除',exact:true}).click();
  await page.getByRole('dialog').waitFor({state:'detached'});
  const state=await page.evaluate(()=>({calls:window.__calls,draft:localStorage.getItem('dsh.conversation.root'),layout:localStorage.getItem('dsh-sidebar:v1:root'),keep:localStorage.getItem('dsh.conversation.other'),timer:window.__sidebar.persistTimers.has('root'),other:window.__sidebar.bySession.get('other').bottomSplits.tabs.map(x=>x.id),remembered:JSON.parse(localStorage.getItem('dsh-sidebar:v1:sidechat-thread'))}));
  assert.equal(state.calls.clear,1);assert.equal(state.draft,null);assert.equal(state.layout,null);assert.equal(state.keep,'keep draft');assert.equal(state.timer,false);
  if(extension){assert.deepEqual(state.other,['keep']);assert.deepEqual(state.remembered,{untouched:'keep-thread'});}
  assert.equal(executions,2);assert.deepEqual(errors,[]);
  descendants=0;
  await page.getByRole('button',{name:'永久删除',exact:true}).click();
  await page.getByRole('button',{name:'重试永久删除',exact:true}).waitFor();
  assert(!(await page.getByRole('dialog').textContent()).includes('0 个'));
  await page.getByRole('button',{name:'取消',exact:true}).click();
  console.log('PASS: real Edge menu, modal, safe title text, cancel, failure/retry, deletion events and draft cleanup'+(extension?', including optional extension cache cleanup.':', with no sidebar extension installed.'));
}finally{if(browser)await browser.close();for(const res of peers)res.end();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
