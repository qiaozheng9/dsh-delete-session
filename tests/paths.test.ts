import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
// @ts-ignore shared with the native installation commands
import {resolvePaths,requireApplication,samePath} from '../scripts/paths.mjs';

test('portable settings prefer explicit environment and preserve recorded installation targets',async t=>{
  const root=await mkdtemp(join(tmpdir(),'dsh-delete-settings-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const installed={application:join(root,'original-app'),home:join(root,'original-home'),backup:join(root,'backup')};
  const defaults=resolvePaths({project:root,env:{},config:{},installed});
  assert.equal(defaults.application,installed.application);
  assert.equal(defaults.home,installed.home);
  assert.equal(defaults.sourceArchive,join(installed.backup,'app.asar'));
  const overridden=resolvePaths({project:root,env:{DSH_APP_DIR:join(root,'env-app'),DSH_HOME:join(root,'env-home'),DSH_STATE_DIR:join(root,'state')},config:{appDir:join(root,'config-app')},installed});
  assert.equal(overridden.application,join(root,'env-app'));
  assert.equal(overridden.home,join(root,'env-home'));
  assert.equal(overridden.stateFile,join(root,'state','installed.json'));
  assert(samePath(defaults.application,resolve(installed.application,'.')));
  assert(!samePath(defaults.home,overridden.home));
});

test('settings refuse relative paths and explain how to specify a missing application',()=>{
  assert.throws(()=>resolvePaths({env:{DSH_APP_DIR:'relative-app'},config:{},installed:{}}),/absolute path/);
  assert.throws(()=>resolvePaths({env:{DSH_HOME:'relative-home'},config:{},installed:{application:resolve('app'),backup:resolve('backup')}}),/absolute path/);
  assert.throws(()=>requireApplication({}),/DSH_APP_DIR/);
});
