import { _electron as electron } from 'playwright-core';
import assert from 'node:assert/strict';
import {resolvePaths,requireApplication} from './paths.mjs';
const environment={...process.env};delete environment.ELECTRON_RUN_AS_NODE;
let app;let page;let fixtureId;
try {
  app=await electron.launch({executablePath:requireApplication(resolvePaths()).electron,env:environment,timeout:45000});
  page=await app.firstWindow({timeout:45000});
  await page.waitForURL(/dsh-app:\/\/app\//,{timeout:45000});
  await page.waitForFunction(()=>window.__DSH_BOOT__&&window.__ModuleLoader__?.mode==='live',{timeout:45000});
  const probe=await page.evaluate(async()=>{
    const r=await fetch(new URL('api/delete-session/preview',document.baseURI),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sessionId:'delete-session-nonexistent-smoke-probe'})});
    const body=await r.json();
    return {status:r.status,code:body.error?.code,message:body.error?.message,clientRegistered:JSON.stringify(window.__DSH_BOOT__).includes('dsh-delete-session')};
  });
  assert.equal(probe.status,409);assert.equal(probe.code,'delete-incomplete');assert.equal(probe.clientRegistered,true);
  await page.addInitScript(()=>{
    let loader;
    Object.defineProperty(window,'__ModuleLoader__',{configurable:true,get:()=>loader,set:value=>{
      loader=value;const original=value.create;
      value.create=function(options){
        const c=options.staticModules?.['@deepseek-ai/cordis'];
        if(c?.Service)options={...options,staticModules:{...options.staticModules,'@deepseek-ai/cordis':{...c,Service:new Proxy(c.Service,{construct(target,args,newTarget){
          const instance=Reflect.construct(target,args,newTarget);window.__DELETE_SMOKE_CTX__=args[0]?.root;return instance;
        }})}}};
        return original.call(this,options);
      };
    }});
  });
  await page.reload();
  await page.waitForFunction(()=>window.__DELETE_SMOKE_CTX__?.get('sessions')&&window.__DELETE_SMOKE_CTX__?.get('uiWorkspace'),{timeout:30000});
  await page.waitForFunction(()=>window.__DELETE_SMOKE_CTX__.get('workspaces').list.getSnapshot().phase==='ready',{timeout:30000});
  fixtureId=await page.evaluate(async()=>{
    const ctx=window.__DELETE_SMOKE_CTX__;
    const workspace=ctx.get('workspaces').list.getSnapshot().items[0];
    if(!workspace)throw new Error('No workspace for the acceptance fixture');
    const id=await ctx.get('sessions').create({workspaceId:workspace.workspaceId});
    if(typeof id!=='string'||!id)throw new Error('Test session creation failed');
    window.__DELETE_SMOKE_CREATED_ID__=id;
    const renamed=await ctx.get('sessions').manager.rename(id,'永久删除功能验收（自动测试）');
    if(!renamed.ok)throw new Error('Test session rename failed');
    await ctx.get('uiWorkspace').openSession(id);
    // Expose the menu on this test-only title record without making a model
    // request. This changes its client presentation, never persisted history.
    const sessions=ctx.get('sessions');
    const summary=sessions.manager.summaries.find(s=>s.sessionId===id);
    sessions.manager.recordMutation({kind:'upsert',summary:{...summary,blank:false}});
    sessions.manager.sessions.get(id)?.handleBlank(false);
    sessions.projectList();
    return id;
  });
  await page.getByRole('button',{name:/^(会话“永久删除功能验收（自动测试）”的操作|Session actions for 永久删除功能验收（自动测试）)$/}).click({force:true,timeout:15000});
  await page.getByText('永久删除',{exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'永久删除对话？',exact:true});
  await dialog.getByRole('button',{name:'永久删除',exact:true}).waitFor();
  assert.equal(await dialog.locator('.dsh-delete-target-title').textContent(),'永久删除功能验收（自动测试）');
  const contents=await dialog.textContent();
  assert(!contents.includes('[object Object]'));assert(!contents.includes('0 个'));assert(!contents.includes('独立分支'));
  await dialog.screenshot({path:'.local/delete-dialog-native.png'});
  // Only the newly minted, clearly labelled test conversation is confirmed.
  await dialog.getByRole('button',{name:'永久删除',exact:true}).click();
  await dialog.waitFor({state:'detached',timeout:15000});
  await page.waitForFunction(id=>window.__DSH_DELETED_SESSIONS__?.has(id),fixtureId,{timeout:15000});
  await page.waitForFunction(id=>!window.__DELETE_SMOKE_CTX__.get('sessions').list.getSnapshot().byId[id],fixtureId,{timeout:15000});
  const cleared=await page.evaluate(id=>{const c=window.__DELETE_SMOKE_CTX__;return !c.get('sessions').manager.sessions.has(id)&&c.get('uiWorkspace').mainReference?.sessionId!==id;},fixtureId);
  assert(cleared,'Deleted active conversation must leave neither a resident session nor a main-view binding');
  console.log('PASS: installed desktop starts, authenticated API works, and a freshly created acceptance conversation is permanently deleted and removed from the actual client. No existing conversation was deleted.');
} finally {
  if(page)try {
    await page.evaluate(async()=>{
      const id=window.__DELETE_SMOKE_CREATED_ID__;
      if(!id||window.__DSH_DELETED_SESSIONS__?.has(id))return;
      const post=async(name,payload)=>{
        const r=await fetch(new URL('api/delete-session/'+name,document.baseURI),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});return r.json();
      };
      const p=await post('preview',{sessionId:id});
      if(p.ok)await post('execute',{sessionId:id,token:p.value.token,stopActivity:true});
    });
  } catch{}
  if(app)await app.close();
}
