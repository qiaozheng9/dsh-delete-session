import { posix } from 'node:path';

export const prefix = 'dsh/node_modules/@deepseek-ai/';
export const patchFiles = [
  'dsh-session-persistence-jsonl/lib/index.js','dsh-workspace/lib/index.js',
  'dsh-session-projection-cache/lib/index.js','dsh-session-query-sqlite/lib/index.js',
  'dsh-agent/lib/index.js','dsh-agent-loop/lib/index.js','dsh-api-session-controller/lib/index.js','dsh-client-file-upload/lib/index.js'
].map(x=>prefix+x);

function once(source, from, to) {
  if(source.split(from).length !== 2) throw new Error(`Patch anchor is not unique: ${from.slice(0,90)}`);
  return source.replace(from,to);
}
export function patchSource(file, original) {
  let s=original;
  const imports=new Set();
  let suffix='';
  if(file === prefix+'dsh-session-persistence-jsonl/lib/index.js') {
    imports.add('initializeGate');imports.add('installPersistence');
    s=once(s,'this.root = resolve(config.root);','this.root = resolve(config.root);\n\t\tinitializeGate(this.root);');
    suffix+='installPersistence(JsonlSessionPersistence.prototype, {sessionDir, SessionWriteLease});';
  } else if(file === prefix+'dsh-workspace/lib/index.js') {
    imports.add('installWorkspace');suffix+='installWorkspace(WorkspaceRegistry.prototype);';
  } else if(file === prefix+'dsh-session-projection-cache/lib/index.js') {
    imports.add('installProjection');suffix+='installProjection(SessionProjectionCache.prototype);';
  } else if(file === prefix+'dsh-session-query-sqlite/lib/index.js') {
    imports.add('installQuery');suffix+='installQuery(SqliteSessionQueryEngine.prototype);';
  } else if(file === prefix+'dsh-agent/lib/index.js') {
    imports.add('installAgentRegistry');suffix+='installAgentRegistry(AgentRegistry.prototype);';
  } else if(file === prefix+'dsh-agent-loop/lib/index.js') {
    imports.add('gate');
    s=once(s,'\t\t\t\t\t\treturn {\n\t\t\t\t\t\t\tagent,\n\t\t\t\t\t\t\tdispose',
      '\t\t\t\t\t\tgate.disposers.set(agent, dispose);\n\t\t\t\t\t\treturn {\n\t\t\t\t\t\t\tagent,\n\t\t\t\t\t\t\tdispose');
    s=once(s,'\tsend(message, target, wakeup) {','\tsend(message, target, wakeup) {\n\t\tgate.assert([this.id]);');
  } else if(file === prefix+'dsh-api-session-controller/lib/index.js') {
    imports.add('installApiCommands');imports.add('gate');suffix+='installApiCommands(SessionCommandController.prototype);';
    s=once(s,'if (ctx.sessions.get(agent.id) === agent.session) ctx.emit("api-session/added", this.listState.summaryFor(agent.session));',
      'if (!gate.blocked.has(agent.id) && !gate.deleted.has(agent.id) && ctx.sessions.get(agent.id) === agent.session) ctx.emit("api-session/added", this.listState.summaryFor(agent.session));');
    s=once(s,'function underArchivedSession(ctx, agent) {','function underArchivedSession(ctx, agent) {\n\tif (gate.blocked.has(agent.id) || gate.deleted.has(agent.id)) return true;');
  } else if(file === prefix+'dsh-client-file-upload/lib/index.js') {
    imports.add('installUploads');suffix+='installUploads(FileUploads.prototype);';
  } else throw new Error(`Unknown patch target ${file}`);
  const relative=posix.relative(posix.dirname(file),'lib/delete-session-bridge.mjs');
  return `import { ${[...imports].join(', ')} } from '${relative}';\n${s}\n${suffix}\n`;
}
