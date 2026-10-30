export function patchNativeClient(source) {
  const anchor='\t\texports.apply = apply;';
  if(source.split(anchor).length!==2)throw new Error('Native client ABI changed');
  return source.replace(anchor,`
    ClientSessions.prototype.deleteSessionRecords = async function(ids) {
      for (const id of ids) {
        this.manager.recordMutation({kind:'remove', sessionId:id});
        const record=this.scopes.get(id);
        if(record) this.retireScope(id,record);
        else {
          const resident=this.manager.sessions.get(id);
          if(resident) await this.manager.drop(id,resident);
        }
        this.manager.projectionStores.delete(id);
        this.manager.projectionLoads.delete(id);
        this.manager.projectionInflight.delete(id);
        this.manager.addresses.delete(id);
        this.manager.entryCache.delete(id);
        this.manager.engagedSessions.delete(id);
        this.retainObservers.delete(id);
      }
      await this.drainScopeDrops();
      this.projectList();
    };
${anchor}`).replace('retain(target, options) {',`retain(target, options) {
      const deleted=window.__DSH_DELETED_SESSIONS__;
      const targetId=typeof target==='string'?target:target?.sessionId??target?.childSessionId;
      if(deleted?.has(targetId))throw new Error('该对话已永久删除');`);
}

export function patchSidebar(source) {
  const anchor='\t\t\tconst nativeRecords = createNativeTabRecords();';
  if(source.split(anchor).length!==2)throw new Error('Better Sidebar ABI changed');
  let s=source.replace(anchor,`${anchor}
      ctx.effect(() => {
        const deleted=new Set();
        const prune=(node)=> {
          if(node.kind==='leaf') {
            const tabs=node.tabs.filter(tab=>!deleted.has(tab.meta?.threadId));
            return {...node,tabs,active:tabs.some(t=>t.id===node.active)?node.active:tabs[0]?.id??null};
          }
          return {...node,children:node.children.map(prune)};
        };
        const onDelete=e=>{
          const ids=e.detail.sessionIds;ids.forEach(id=>deleted.add(id));
          loadLastThreads();
          if(lastThreadsWrite!==undefined)window.clearTimeout(lastThreadsWrite);
          lastThreadsWrite=undefined;
          for(const [seat,thread] of lastThreadBySession)if(deleted.has(seat)||deleted.has(thread))lastThreadBySession.delete(seat);
          if(deleted.has(parkedReopen))parkedReopen=undefined;
          localStorage.setItem(LAST_THREAD_KEY,JSON.stringify(Object.fromEntries(lastThreadBySession)));
          nativeRecords.deleteSessions(deleted,(id,scope)=>service.closeTab(id,scope));
          // Update other seats before removing target seats: side-chat tabs can live elsewhere.
          for(const [seat,state] of sidebarStore.getSessionStates())if(!deleted.has(seat))sidebarStore.reduceFor(seat,s=>({...s,bottomSplits:prune(s.bottomSplits)}));
          for(const id of ids){
            const timer=sidebarStore.persistTimers.get(id);if(timer!==undefined)window.clearTimeout(timer);
            sidebarStore.persistTimers.delete(id);sidebarStore.bySession.delete(id);
            localStorage.removeItem('dsh-sidebar:v1:'+id);
          }
          sidebarStore.sessionStatesCache=undefined;
          if(deleted.has(sidebarStore.snapshot.sessionId))sidebarStore.setSession(undefined);
          sidebarStore.notify();
          // Persisted inactive seats also may contain a side-chat reference.
          for(const key of Object.keys(localStorage))if(key.startsWith('dsh-sidebar:v1:')&&key!==LAST_THREAD_KEY){
            let value;try{value=JSON.parse(localStorage.getItem(key));}catch{continue;}
            if(value?.bottomSplits)localStorage.setItem(key,JSON.stringify({...value,bottomSplits:prune(value.bottomSplits)}));
          }
        };
        window.addEventListener('dsh:session-deleted',onDelete);
        return()=>window.removeEventListener('dsh:session-deleted',onDelete);
      },'delete-session: Better Sidebar cache cleanup');`);
  const field='get: (sessionId, id) => views.get(viewKey(sessionId, id)),';
  if(s.split(field).length!==2)throw new Error('Better Sidebar native records ABI changed');
  s=s.replace(field,`${field}
      deleteSessions(ids, close) {
        for(const [key,entry] of [...views])if(ids.has(entry.seat)||ids.has(entry.scope.sessionId)||ids.has(entry.tab.meta?.threadId)) {
          close(entry.tab.id,entry.scope); views.delete(key); navigationRevisions.delete(key);
        }
        notify();
      },`);
  return s;
}
