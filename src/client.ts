// @ts-nocheck
// Client imports are supplied by DSH's module loader, never bundled twice.
import React, { useSyncExternalStore } from 'react';
import { Modal, Button, MenuItemButton, IconTrashOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';
import { titleText } from './title.ts';

const h=React.createElement;
export const inject=['slots','sessions','uiWorkspace'];
export function apply(ctx) {
  let state=null;
  const listeners=new Set();
  const subscribe=fn=>{listeners.add(fn);return()=>listeners.delete(fn);};
  const set=next=>{state=next;for(const fn of listeners)fn();};
  const abort=new AbortController();
  const deleted=window.__DSH_DELETED_SESSIONS__ ??= new Set();
  const route=name=>new URL('api/delete-session/'+name,document.baseURI).href;
  async function call(name,payload) {
    const response=await fetch(route(name),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
    const data=await response.json();
    if(!response.ok||data.ok!==true) throw new Error(data.error?.message ?? `HTTP ${response.status}`);
    return data.value;
  }
  async function request(id,displayTitle) {
    const title=titleText(displayTitle);
    set({sessionId:id,title,loading:true});
    try {
      const preview=await call('preview',{sessionId:id});
      if(state?.sessionId===id)set({...preview,title:titleText(preview.title,title)});
    } catch(e) { if(state?.sessionId===id)set({sessionId:id,title,error:e.message}); }
  }
  function MenuItem({sessionId,displayTitle,useMenuOpenState}) {
    const [,close]=useMenuOpenState();
    return h(MenuItemButton,{danger:true,separatorBefore:true,icon:h(IconTrashOutlineRegular,{size:14}),
      onSelect:()=>{close(false);void request(sessionId,displayTitle);}},'永久删除');
  }
  function Dialog() {
    const current=useSyncExternalStore(subscribe,()=>state);
    if(!current)return null;
    const cancel=()=>{if(!state?.busy)set(null);};
    async function confirm() {
      const old=state;if(!old?.token||old.busy)return;
      set({...old,busy:true,error:undefined});
      try {
        const value=await call('execute',{sessionId:old.sessionId,token:old.token,stopActivity:true});
        await cleanup(value.sessionIds);set(null);
      } catch(e) {
        let latest;
        try {latest=await call('preview',{sessionId:old.sessionId});}catch{}
        set({...old,...latest,title:titleText(latest?.title,old.title),busy:false,error:'删除未完成，可重试：'+e.message});
      }
    }
    return h(Modal,{open:true,onClose:cancel,closeLabel:'关闭',title:'永久删除对话？',className:'dsh-delete-modal',
      footer:h(React.Fragment,null,
        h(Button,{variant:'outline',disabled:current.busy,onClick:cancel,'data-modal-autofocus':true},'取消'),
        h(Button,{variant:'primary',className:'dsh-delete-confirm',disabled:current.loading||current.busy||!current.token,onClick:confirm},
          current.busy?'正在删除…':current.retry?'重试永久删除':current.running?'停止并永久删除':'永久删除'))},
      h('div',{className:'dsh-delete-target'},
        h('span',{className:'dsh-delete-target-icon','aria-hidden':true},h(IconTrashOutlineRegular,{size:18})),
        h('span',{className:'dsh-delete-target-title',title:titleText(current.title)},titleText(current.title))),
      current.loading?h('p',{className:'dsh-delete-copy',role:'status'},'正在检查关联数据…'):
        current.token&&h('p',{className:'dsh-delete-copy'},
          current.descendantCount>0?`此对话及其 ${current.descendantCount} 个子代理对话的记录与专属数据将被永久删除，无法恢复。`:
            '此对话的聊天记录与专属数据将被永久删除，无法恢复。'),
      current.running&&h('p',{className:'dsh-delete-running'},'运行中和已排期的任务将先停止。'),
      h('p',{className:'dsh-delete-hint'},'项目文件和其他对话不受影响。'),
      current.error&&h('p',{role:'alert',className:'dsh-delete-error'},current.error));
  }

  let cleaning=Promise.resolve();
  function cleanup(ids) {
    cleaning=cleaning.then(async()=>{
      ids=ids.filter(id=>typeof id==='string'&&!deleted.has(id));
      if(!ids.length)return;
      ids.forEach(id=>deleted.add(id));
      if(ids.includes(ctx.uiWorkspace.mainReference?.sessionId))ctx.uiWorkspace.clearMain();
      window.dispatchEvent(new CustomEvent('dsh:session-deleted',{detail:{sessionIds:ids}}));
      if(typeof ctx.sessions.deleteSessionRecords!=='function')throw new Error('客户端删除补丁未安装');
      await ctx.sessions.deleteSessionRecords(ids);
      // Scope disposal releases composers and image URLs before persisted drafts disappear.
      for(const id of ids) {
        localStorage.removeItem('dsh.conversation.'+id);
        localStorage.removeItem('dsh-sidebar:v1:'+id);
      }
      if(ids.includes(state?.sessionId)&&!state?.busy)set(null);
    });
    return cleaning;
  }
  async function events() {
    while(!abort.signal.aborted) {
      try {
        const response=await fetch(route('events'),{signal:abort.signal});
        if(!response.ok||!response.body)throw new Error('删除通知连接失败');
        const reader=response.body.getReader();let buffer='';const decoder=new TextDecoder();
        try { for(;;) {
          const item=await reader.read();if(item.done)break;
          buffer+=decoder.decode(item.value,{stream:true});
          let end;
          while((end=buffer.indexOf('\n\n'))>=0) {
            const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);
            if(frame.startsWith('data: ')) { const data=JSON.parse(frame.slice(6));if(data.type==='deleted')await cleanup(data.sessionIds); }
          }
        }}finally{await reader.cancel().catch(()=>{});}
      } catch(e) { if(!abort.signal.aborted)console.warn('[delete-session] notifications:',e.message); }
      if(!abort.signal.aborted)await new Promise(resolve=>{const timer=setTimeout(resolve,1500);abort.signal.addEventListener('abort',()=>{clearTimeout(timer);resolve();},{once:true});});
    }
  }
  ctx.slots.inject('sidebar.workspaces.session.menu.item',()=>ctx.slots.register({name:'sidebar.workspaces.session.menu.item',id:'permanent-delete',order:500},MenuItem));
  ctx.slots.inject('shell.overlay',()=>ctx.slots.register({name:'shell.overlay',id:'delete-session.confirm'},Dialog));
  ctx.effect(()=>{
    const style=document.createElement('style');
    style.dataset.dshDeleteSession='';
    style.textContent=`
      .dsh-delete-modal{width:min(420px,calc(100vw - 32px));font-family:inherit}
      .dsh-delete-target{display:flex;align-items:center;gap:10px;min-width:0;padding:12px;border:1px solid var(--dsw-alias-border-l1,#e8e8e8);border-radius:10px;background:var(--dsw-alias-bg-layer-1,#f7f7f8)}
      .dsh-delete-target-icon{display:flex;flex:none;color:var(--dsw-alias-label-secondary,#777)}
      .dsh-delete-target-title{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden;overflow-wrap:anywhere;font-size:14px;line-height:21px;font-weight:500;color:var(--dsw-alias-label-primary,#202020)}
      .dsh-delete-copy{margin:16px 0 0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary,#202020)}
      .dsh-delete-running{margin:8px 0 0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary,#737373)}
      .dsh-delete-hint{margin:8px 0 0;font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary,#737373)}
      .dsh-delete-error{margin:12px 0 0;padding:10px 12px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover-danger,#fdf0f0);color:var(--dsw-alias-state-error-primary,#d9363e);font-size:13px;line-height:20px;overflow-wrap:anywhere}
      .dsh-delete-modal button.dsh-delete-confirm{background:var(--dsw-alias-state-error-primary,#d9363e);border-color:transparent;color:#fff}
      .dsh-delete-modal button.dsh-delete-confirm:hover:not(:disabled){filter:brightness(.94)}
    `;
    document.head.append(style);return()=>style.remove();
  });
  ctx.effect(()=>{void events();return()=>{abort.abort();set(null);};});
}
