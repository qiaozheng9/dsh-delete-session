// @ts-nocheck
import { DeleteEngine } from './engine.ts';
import { createDriver } from './driver.ts';
import { gate } from './gate.ts';

export const name='delete-session';
export const inject=['sessionPersistence','sessions','agents','workspaceRegistry','sessionQuery','sessionProjectionCache','connection','webServer'];

export async function apply(ctx) {
  const peers=new Set();
  const completed=new Set(gate.deleted);
  const encoder=new TextEncoder();
  const publish=ids=>{
    ids.forEach(id=>completed.add(id));
    const data=encoder.encode(`data: ${JSON.stringify({type:'deleted',sessionIds:ids})}\n\n`);
    for(const peer of [...peers]) try { peer.enqueue(data); } catch { peers.delete(peer); }
  };
  const engine=new DeleteEngine(createDriver(ctx,publish));
  await engine.recover();
  function route(path,methods,fetch) {
    ctx.connection.fetch.register({path:'/api/delete-session/'+path,methods,requestBody:methods.includes('GET')?'buffered':'streaming',fetch});
  }
  async function body(req) {
    if(!req.headers.get('content-type')?.startsWith('application/json')) throw new Error('请求必须为 JSON');
    const reader=req.body?.getReader(); if(!reader) throw new Error('缺少请求正文');
    const chunks=[];let length=0;
    try { for(;;) { const item=await reader.read(); if(item.done) break; length+=item.value.length; if(length>4096) throw new Error('请求过大'); chunks.push(item.value); } }
    finally { await reader.cancel(); }
    const b=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(!b || typeof b.sessionId !== 'string' || !b.sessionId || b.sessionId.length>512) throw new Error('无效会话 ID');
    return b;
  }
  for(const method of ['preview','execute']) route(method,['POST'],async req=>{
    try {
      const b=await body(req);
      if(Object.keys(b).some(k=>!['sessionId','token','stopActivity'].includes(k))) throw new Error('请求包含不支持的字段');
      let value;
      if(method==='preview') value=await engine.preview(b.sessionId);
      else {
        if(typeof b.token!=='string'||!/^[a-f0-9]{64}$/.test(b.token)||typeof b.stopActivity!=='boolean') throw new Error('缺少有效删除确认');
        value={sessionIds:await engine.execute(b.sessionId,b.token,b.stopActivity)};
      }
      return Response.json({ok:true,value},{headers:{'cache-control':'no-store'}});
    } catch(e) {
      return Response.json({ok:false,error:{code:'delete-incomplete',message:e instanceof Error?e.message:String(e)}},{status:409,headers:{'cache-control':'no-store'}});
    }
  });
  route('events',['GET'],req=>{
    let controller;
    const stream=new ReadableStream({
      start(c) { controller=c;peers.add(c);c.enqueue(encoder.encode(`data: ${JSON.stringify({type:'deleted',sessionIds:[...completed]})}\n\n`)); },
      cancel() { peers.delete(controller); }
    });
    const abort=()=>{peers.delete(controller);try {controller.close();} catch {}};
    req.signal.addEventListener('abort',abort,{once:true});
    return new Response(stream,{headers:{'content-type':'text/event-stream','cache-control':'no-store','x-accel-buffering':'no'}});
  });
  ctx.effect(()=>()=>{for(const p of peers) try {p.close();} catch {} peers.clear();});
}
