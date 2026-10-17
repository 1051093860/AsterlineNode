import {fakeRcloneProgram} from './helpers/fake-rclone.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawnSync} from 'node:child_process';
import {Store} from '../src/store.ts';
import {loadRuntimeSettings,saveRuntimeSetting,normalizeRuntimeSetting} from '../src/runtime-settings.ts';
import {createAdmin} from '../src/admin.ts';

function fixture(){
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'asterline-config-'));
 const workspace=path.join(base,'workspace'),project=path.join(workspace,'project'),trusted=path.join(base,'trusted');
 fs.mkdirSync(project,{recursive:true});fs.mkdirSync(trusted);
 const data=path.join(base,'state'),store=new Store(data);
 const c={data,workspaceRoot:workspace,sandboxieStart:'',sandboxieBox:'AsterlinePlugins',sandboxieBoxRoot:'',sandboxConfirmed:false,gotify:'http://127.0.0.1:8780',maxPluginSeconds:30,password:'X'.repeat(30),emails:new Set(['owner@example.org']),adminAud:'',teamDomain:'',publicHost:'mcpadmin.asterline.dev',localAdminPort:0,publicAdminPort:0};
 return {base,workspace,project,trusted,data,store,c,close(){store.close();fs.rmSync(base,{recursive:true,force:true});}};
}
async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));return port;}

test('Runtime settings persist in SQLite, apply immediately and override bootstrap env',()=>{
 const f=fixture();try{
  assert.throws(()=>saveRuntimeSetting(f.c,f.store,'allowedPrograms','git.exe','admin:test'),/未知/);
  assert.throws(()=>saveRuntimeSetting(f.c,f.store,'execDirs',f.trusted,'admin:test'),/未知/);
  saveRuntimeSetting(f.c,f.store,'maxPluginSeconds','17','admin:test');
  assert.equal(f.c.maxPluginSeconds,17);
  const c2={...f.c,maxPluginSeconds:30};
  loadRuntimeSettings(c2,f.store);
  assert.equal(c2.maxPluginSeconds,17);
 }finally{f.close();}
});

test('Reject obsolete executable allowlists and invalid runtime keys; changing workspace invalidates work authorization',()=>{
 const f=fixture();try{
  assert.throws(()=>normalizeRuntimeSetting('arbitrary_key','123',f.c),/未知/);
  assert.throws(()=>saveRuntimeSetting(f.c,f.store,'execDirs',f.project,'admin:test'),/未知/);
  assert.throws(()=>saveRuntimeSetting(f.c,f.store,'rcloneRemote','gdrive:../private','admin:test'),/rclone/);
  const request=f.store.requestWork('owner@example.org','test','开发任务','project',['fs_write'],'testing');
  assert.ok(f.store.decideWorkRequest(request,true));
  assert.ok(f.store.currentWorkSession('owner@example.org'));
  const target=path.join(f.base,'next-workspace');fs.mkdirSync(target);
  saveRuntimeSetting(f.c,f.store,'workspaceRoot',target,'admin:test');
  assert.equal(f.store.currentWorkSession('owner@example.org'),null);
  assert.equal(f.c.workspaceRoot,target);
 }finally{f.close();}
});

test('Changing Sandboxie path clears confirmation even after a restart',()=>{
 const f=fixture();try{
  f.c.sandboxConfirmed=true;
  saveRuntimeSetting(f.c,f.store,'sandboxieBox','AsterlineQATest','admin:test');
  assert.equal(f.c.sandboxConfirmed,false);
  const next={...f.c,sandboxConfirmed:true};loadRuntimeSettings(next,f.store);
  assert.equal(next.sandboxConfirmed,false);
  assert.equal(next.sandboxieBox,'AsterlineQATest');
 }finally{f.close();}
});

test('Admin /settings is Basic-authenticated, Origin + CSRF protected, and saves without restart',async()=>{
 const f=fixture();let server;
 try{
  f.c.localAdminPort=await freePort();
  const service=createAdmin(f.c,f.store,{verify:async()=>{throw Error('unused');}},{jobs:{cancel(){}},preflight:async()=>{},install:async()=>{},sandboxReady:()=>false});
  server=service.start().local;await new Promise(r=>server.listening?r():server.once('listening',r));
  const root=`http://127.0.0.1:${f.c.localAdminPort}`,auth='Basic '+Buffer.from(`admin:${f.c.password}`).toString('base64');
  assert.equal((await fetch(root+'/settings')).status,401);
  const page=await fetch(root+'/settings',{headers:{Authorization:auth}});assert.equal(page.status,200);
  const html=await page.text();assert.match(html,/工具设置/);
  const csrf=html.match(/name="csrf" value="([a-f0-9]{64})"/)?.[1];assert.ok(csrf);
  const post=async(origin,token)=>fetch(root+'/action',{method:'POST',redirect:'manual',headers:{Authorization:auth,Origin:origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf:token,kind:'save_setting',id:'maxPluginSeconds',value:'22'})});
  assert.equal((await post('https://evil.invalid',csrf)).status,403);
  assert.equal((await post(root,'bad')).status,403);
  assert.equal((await post(root,csrf)).status,303);
  assert.equal(f.c.maxPluginSeconds,22);
  assert.equal(f.store.runtimeSetting('maxPluginSeconds'),'22');
 }finally{if(server)await new Promise(r=>server.close(r));f.close();}
});

test('CLI cloud reads the same SQLite setting as Admin without requiring LIBRARY_RCLONE_REMOTE in .env',{skip:process.platform==='win32'?'POSIX fake rclone is not executable reliably under Windows':false},()=>{
 const f=fixture();try{
  const fakeInfo=fakeRcloneProgram(path.join(f.base,'rclone'),{echo:true});const fake=fakeInfo.executable;
  fs.writeFileSync(fake,'#!/bin/sh\nprintf "ARGS:%s\\n" "$*"\n',{mode:0o755});
  saveRuntimeSetting(f.c,f.store,'rcloneRemote','gdrive:Asterline','admin:test');
  saveRuntimeSetting(f.c,f.store,'rcloneExe',fake,'admin:test');
  const p=spawnSync(process.execPath,['scripts/library-cli.mjs','cloud','ls'],{cwd:path.resolve('.'),env:{...process.env,...fakeInfo.env,MCP_DATA_DIR:f.data,LIBRARY_RCLONE_REMOTE:'',LIBRARY_RCLONE_EXE:''},encoding:'utf8',timeout:10000});
  assert.equal(p.status,0,p.stderr);assert.match(p.stdout,/ARGS:lsf gdrive:Asterline/);
 }finally{f.close();}
});

test('Library host policy is admin-persisted, survives restart and rejects unsafe rules',()=>{
 const f=fixture();try{
  const old=['*.oaiusercontent.com','*.openai.com','*.chatgpt.com'];f.c.libraryFileHosts=old;
  const requested='*.chatgpt.com,files.oaiusercontent.com';
  assert.equal(saveRuntimeSetting(f.c,f.store,'libraryFileHosts',requested,'admin:test'),requested);
  assert.deepEqual(f.c.libraryFileHosts,['*.chatgpt.com','files.oaiusercontent.com']);
  const fresh={...f.c,libraryFileHosts:old};loadRuntimeSettings(fresh,f.store);
  assert.deepEqual(fresh.libraryFileHosts,['*.chatgpt.com','files.oaiusercontent.com']);
  assert.equal(f.store.runtimeSetting('libraryFileHosts'),requested);
  for(const host of ['localhost','*.com','http://files.oaiusercontent.com','evil.com:443','127.0.0.1'])
   assert.throws(()=>saveRuntimeSetting(f.c,f.store,'libraryFileHosts',host,'admin:test'));
  assert.deepEqual(f.c.libraryFileHosts,['*.chatgpt.com','files.oaiusercontent.com']);
 }finally{f.close();}
});
