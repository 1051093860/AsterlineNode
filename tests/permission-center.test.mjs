import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {Store} from '../src/store.ts';
import {authorizeFileWrite,authorizeBackgroundJob,authorizeSandboxPlugin,hasWorkPermission,validateWorkRoot,validateWorkCapabilities} from '../src/permission-center.ts';
import {paramsHash} from '../src/policy.ts';
import {createAdmin} from '../src/admin.ts';

const fixture=()=>{
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'asterline-v19-'));const workspace=path.join(base,'workspace');
 fs.mkdirSync(path.join(workspace,'project'),{recursive:true});fs.mkdirSync(path.join(workspace,'other'));fs.mkdirSync(path.join(workspace,'project','nested'));
 const conf={data:path.join(base,'state'),workspaceRoot:workspace,password:'z'.repeat(32),emails:new Set(['alice@example.org','bob@example.org']),publicHost:'mcpadmin.asterline.dev',teamDomain:'',adminAud:'',sandboxieBox:'QA',sandboxieStart:'',sandboxConfirmed:false,gotifyToken:''};
 const store=new Store(conf.data);return {base,workspace,conf,store,close(){store.close();fs.rmSync(base,{recursive:true,force:true});}};
};
function request(x,opts={}){return x.store.requestWork(opts.owner||'alice@example.org','ChatGPT (unverified label)',opts.title||'修复项目并测试','project',opts.caps||['fs_write','sandbox_plugin'],'修复预期内的问题');}
async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
test('Work requests are pending, scoped to verified owner; approval lasts fixed one hour',()=>{
 const x=fixture();try{
  assert.equal(validateWorkRoot(x.conf,'project'),'project');assert.deepEqual(validateWorkCapabilities(['fs_write']),['fs_write']);
  assert.throws(()=>validateWorkCapabilities(['fs_write','fs_write']),/Invalid/);
  assert.throws(()=>validateWorkRoot(x.conf,'../outside'),/escapes/);
  const id=request(x);assert.equal(x.store.workRequest(id).state,'pending');
  assert.equal(x.store.currentWorkSession('alice@example.org'),null);
  const lease=x.store.decideWorkRequest(id,true,'admin:test');assert.ok(lease);
  const row=x.store.currentWorkSession('alice@example.org');assert.equal(row.id,lease);assert.equal(row.expires-row.created,3_600_000);
  assert.equal(row.request_id,id);assert.equal(x.store.workStatus(id,'alice@example.org').state,'active');
  assert.equal(x.store.workStatus(id,'bob@example.org').state,'not_found');
  assert.equal(x.store.currentWorkSession('bob@example.org'),null);
  assert.throws(()=>x.store.decideWorkRequest(id,true),/already decided/);
  assert.throws(()=>request(x),/still in progress/);
  x.store.revokeWorkSession(lease,'admin:test');assert.equal(x.store.currentWorkSession('alice@example.org'),null);
  assert.equal(x.store.workStatus(id,'alice@example.org').state,'revoked');
  assert.throws(()=>request(x),/still in progress/,'revocation must not permit time extension');
 }finally{x.close();}
});
test('Only approved paths are writable; no global approval_required bypass',()=>{
 const x=fixture();try{
  const approval=request(x,{caps:['fs_write']});
  assert.throws(()=>authorizeFileWrite(x.store,x.conf,'alice@example.org','project/nested/file.txt','hello'),/No project/);
  x.store.decideWorkRequest(approval,true);
  assert.equal(authorizeFileWrite(x.store,x.conf,'alice@example.org','project/nested/file.txt','hello'),'work_session');
  assert.throws(()=>authorizeFileWrite(x.store,x.conf,'alice@example.org','other/file.txt','hello'),/No project/);
  assert.throws(()=>authorizeFileWrite(x.store,x.conf,'bob@example.org','project/file.txt','hello'),/No project/);
  assert.throws(()=>authorizeFileWrite(x.store,x.conf,'alice@example.org','../outside','hello'),/escapes/);
  assert.throws(()=>authorizeFileWrite(x.store,x.conf,'alice@example.org','project/../../other/out.txt','hello'),/escapes/);
  x.store.setFlag('approval_required',false);
  assert.throws(()=>authorizeFileWrite(x.store,x.conf,'bob@example.org','project/any.txt','hello'),/No project/);
  const link=path.join(x.workspace,'project','escape');fs.symlinkSync(x.base,link,'dir');
  assert.throws(()=>authorizeFileWrite(x.store,x.conf,'alice@example.org','project/escape/secret.txt','hello'),/Symbolic links/);
 }finally{x.close();}
});
test('Ticket is never ignored even with an active project session',()=>{
 const x=fixture();try{
  x.store.decideWorkRequest(request(x,{caps:['fs_write','sandbox_plugin']}),true);
  x.store.setFlag('file_write',true);
  const ap=x.store.request('alice@example.org','@fs_write',paramsHash({path:'project/test.txt',content:'hello'}),'{}','one time');x.store.decide(ap,true);
  assert.throws(()=>authorizeFileWrite(x.store,x.conf,'alice@example.org','project/test.txt','hello','BAD-TICKET'),/Missing, mismatched/);
  assert.equal(authorizeFileWrite(x.store,x.conf,'alice@example.org','project/test.txt','hello',ap),'one_time');
  assert.throws(()=>authorizeFileWrite(x.store,x.conf,'alice@example.org','project/test.txt','hello',ap),/Missing, mismatched/);
  assert.equal(hasWorkPermission(x.store,x.conf,'alice@example.org','sandbox_plugin'),true);
  assert.equal(authorizeSandboxPlugin(x.store,x.conf,'alice@example.org','published','{}'),'work_session');
  assert.throws(()=>authorizeSandboxPlugin(x.store,x.conf,'alice@example.org','published','{}','BAD-TICKET'),/Missing, mismatched/);
 }finally{x.close();}
});
test('Host background tasks cannot be authorized by dev session or obsolete approval flag',()=>{
 const x=fixture();try{
  x.store.decideWorkRequest(request(x),true);x.store.setFlag('command_exec',true);x.store.setFlag('approval_required',false);
  const args={program:'git.exe',args:['status'],cwd:'project',label:''};
  assert.throws(()=>authorizeBackgroundJob(x.store,'alice@example.org',args),/one-time approval/);
  const ap=x.store.request('alice@example.org','@task_start',paramsHash(args),'{}','one time');x.store.decide(ap,true);
  assert.equal(authorizeBackgroundJob(x.store,'alice@example.org',args,ap),'one_time');
  assert.throws(()=>authorizeBackgroundJob(x.store,'alice@example.org',args,ap),/Missing, mismatched/);
 }finally{x.close();}
});
test('Expired, denied, and revoked work never grants access; DB reopening preserves original expiry',()=>{
 const x=fixture();try{
  const denied=request(x);x.store.decideWorkRequest(denied,false);assert.equal(x.store.currentWorkSession('alice@example.org'),null);
  const valid=request(x);const id=x.store.decideWorkRequest(valid,true);
  assert.ok(x.store.currentWorkSession('alice@example.org'));
  const db2=new Store(x.conf.data);assert.equal(db2.currentWorkSession('alice@example.org').id,id);db2.close();
  x.store.db.prepare('UPDATE js_work_sessions SET created=created-3600000,expires=expires-3600000 WHERE id=?').run(id);
  assert.equal(x.store.currentWorkSession('alice@example.org'),null);
  assert.equal(x.store.workStatus(valid,'alice@example.org').state,'expired');
  assert.equal(hasWorkPermission(x.store,x.conf,'alice@example.org','fs_write','project/file'),false);
 }finally{x.close();}
});
test('Admin /access enforces Basic, CSRF, allowed email and sandbox readiness',async()=>{
 const x=fixture();let svc;try{
  const requestId=request(x);x.conf.localAdminPort=await freePort();x.conf.publicAdminPort=0;
  let ready=false;const admin=createAdmin(x.conf,x.store,{verify:async()=>{throw Error('unused')}},{jobs:{cancel(){}},preflight:async()=>{},install:async()=>{},sandboxReady:()=>ready});
  svc=admin.start().local;await new Promise(r=>svc.listening?r():svc.once('listening',r));
  const root='http://127.0.0.1:'+x.conf.localAdminPort,Authorization='Basic '+Buffer.from('admin:'+x.conf.password).toString('base64');
  assert.equal((await fetch(root+'/access')).status,401);
  const r=await fetch(root+'/access',{headers:{Authorization}});const html=await r.text();assert.equal(r.status,200);assert.match(html,/修复项目并测试/);assert.match(html,/项目文件写入/);
  const csrf=html.match(/name="csrf" value="([a-f0-9]{64})"/)[1];
  const post=(headers,kind='approve_work',id=requestId,token=csrf)=>fetch(root+'/action',{method:'POST',redirect:'manual',headers:{Authorization,'Content-Type':'application/x-www-form-urlencoded',...headers},body:new URLSearchParams({csrf:token,kind,id})});
  assert.equal((await post({Origin:'https://evil.example.org'})).status,403);
  assert.equal((await post({Origin:root},'approve_work',requestId,'bad')).status,403);
  assert.equal((await post({Origin:root})).status,409,'Plugin execution requested but Sandboxie is not ready');
  ready=true;assert.equal((await post({Origin:root})).status,303);
  assert.equal(x.store.currentWorkSession('alice@example.org').workspace,'project');
  const lease=x.store.currentWorkSession('alice@example.org').id;
  assert.equal((await post({Origin:root},'revoke_work',lease)).status,303);assert.equal(x.store.currentWorkSession('alice@example.org'),null);
 }finally{if(svc)await new Promise(r=>svc.close(r));x.close();}
});
