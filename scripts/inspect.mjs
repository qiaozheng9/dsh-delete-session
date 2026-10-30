import fs from 'node:fs';
import path from 'node:path';
import { openArchive } from './asar.mjs';
import {resolvePaths,requireApplication} from './paths.mjs';

const archive = openArchive(requireApplication(resolvePaths()).sourceArchive);
const wanted = /@deepseek-ai\/dsh-(session|session-persistence|session-persistence-jsonl|session-query|session-query-sqlite|session-projection-cache|workspace|api-workspace-controller|api-session-controller|agent|agent-loop|jobs|jobs-local|subagent|schedule|attachment|attachment-local|spill-local|api-gateway|api-remotes|client-ui-workspace|client-ui-conversation|client-ui-slots|home-paths|storage-json|client-connection|host-webserver|api-job-controller|client-file-upload|output-retention|session-log-deepseek)(?:\/|$)/;
function visit(node, prefix = '') {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const p = prefix ? `${prefix}/${name}` : name;
    if (entry.files) visit(entry, p);
    else if (wanted.test(p) && /\.(?:js|ts|json|yml)$/.test(p)) {
      const dest = path.join('.reference', p.replace('dsh/node_modules/@deepseek-ai/', ''));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, archive.read(p));
    }
  }
}
visit(archive.tree);
archive.close();
console.log('Extracted reference modules to .reference (application data was not read).');
