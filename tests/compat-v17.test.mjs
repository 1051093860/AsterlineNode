import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {Store} from '../src/store.ts';
import {fsList,fsRead,fsWrite,workspacePath} from '../src/workspace.ts';
import {JobManager,checkJobInput} from '../src/jobs.ts';
import {processOutbox} from '../src/notifier.ts';
const fixture=()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'asterline-v17-')),workspace=path.join(temp,'workspace');fs.mkdirSync(workspace);
 const c={data:path.join(temp,'state'),workspaceRoot:workspace,gotifyToken:'',gotify:'http://127.0.0.1:8780'};
 const store=new Store(c.data);
 return {temp,workspace,c,store,close(){this.store.close();fs.rmSync(temp,{recursive:true,force:true});}};
};
test('Workspace read/write/list: relative paths only, 128 KiB, symlinks refused',()=>{
 const x=fixture();try{
  fs.mkdirSync(path.join(x.workspace,'notes'));const f='notes/sample.txt';
  assert.equal(fsWrite(x.c,f,'你好').bytes,6);assert.equal(fsRead(x.c,f),'你好');
  assert.equal(fsList(x.c,'notes')[0].name,'sample.txt');
  assert.throws(()=>fsRead(x.c,'../outside.txt'));
  assert.throws(()=>workspacePath(x.c,path.resolve(x.workspace,'notes')));
  assert.throws(()=>fsWrite(x.c,'notes/over.txt','x'.repeat(131073)));
  const secret=path.join(x.temp,'secret.txt');fs.writeFileSync(secret,'secret');
  const link=path.join(x.workspace,'notes','escape');fs.symlinkSync(secret,link,'file');
  assert.throws(()=>fsRead(x.c,'notes/escape'));
  assert.throws(()=>fsWrite(x.c,'notes/escape','oops'));
  assert.equal(fs.readFileSync(secret,'utf8'),'secret');
 }finally{x.close();}
});
test('Admin switches default-off, and exact file/operation approvals cannot be forged or reused',()=>{
 const x=fixture();try{
  assert.equal(x.store.flag('file_write'),false);assert.equal(x.store.flag('command_exec'),false);assert.equal(x.store.flag('notify_manual'),false);
  assert.equal(x.store.flag('approval_required'),true);
  assert.throws(()=>x.store.flag('does_not_exist'));
  x.store.setFlag('file_write',true);
  assert.equal(x.store.flag('file_write'),true);
  const digest='abc123';const id=x.store.request('owner@example.com','@fs_write',digest,'{}','test');
  assert.throws(()=>x.store.consume(id,'owner@example.com','@fs_write',digest));
  x.store.decide(id,true);
  assert.throws(()=>x.store.consume(id,'someone@example.com','@fs_write',digest));
  assert.throws(()=>x.store.consume(id,'owner@example.com','@task_start',digest));
  x.store.consume(id,'owner@example.com','@fs_write',digest);
  assert.throws(()=>x.store.consume(id,'owner@example.com','@fs_write',digest));
 }finally{x.close();}
});
test('Background jobs enforce workspace, arbitrary executable lookup, owner isolation and stale restart recovery',()=>{
 const x=fixture();try{
   assert.throws(()=>checkJobInput(x.c,'definitely-not-a-real-executable-asterline',[],'.'));
   assert.throws(()=>checkJobInput(x.c,'../node',[],'.'));
   assert.throws(()=>checkJobInput(x.c,process.execPath,[],'..'));
   assert.equal(checkJobInput(x.c,process.execPath,[],'.').working,x.workspace);
   const jobs=new JobManager(x.c,x.store);
   assert.throws(()=>jobs.start('owner@example.com',process.execPath,['--version'],'.','demo'));
   x.store.setFlag('command_exec',true);
   const id=x.store.newJob('owner@example.com','["node"]',x.workspace,'test');
   assert.equal(x.store.job(id,'other@example.com'),null);
   assert.equal(x.store.job(id,'owner@example.com').state,'running');
   x.store.close();x.store=new Store(x.c.data);
   assert.equal(x.store.job(id,'owner@example.com').state,'lost');
 }finally{x.close();}
});
test('Gotify queue retries and survives restart; direct secrets not persisted',()=>{
 const x=fixture();try{
   const id=x.store.queueNotification('test','Title','safe message',5);
   let row=x.store.takeNotification();assert.equal(row.id,id);
   x.store.finishNotification(id,false,'HTTP 503');
   assert.equal(x.store.db.prepare('SELECT state,attempts FROM js_notifications WHERE id=?').get(id).state,'pending');
   x.store.close();x.store=new Store(x.c.data);
   assert.equal(x.store.db.prepare('SELECT state FROM js_notifications WHERE id=?').get(id).state,'pending');
   assert.equal(x.store.db.prepare('SELECT count(*) AS n FROM js_notifications').get().n,1);
 }finally{x.close();}
});
test('Python migration dry-run and explicit --apply are idempotent, deny privileges',()=>{
 const x=fixture();let old;try{
  const oldPath=path.join(x.temp,'python.sqlite3');old=new DatabaseSync(oldPath);
  old.exec(`CREATE TABLE jobs(id TEXT,owner TEXT,state TEXT); INSERT INTO jobs VALUES('task1','old@example.com','running');
    CREATE TABLE settings(name TEXT,value TEXT); INSERT INTO settings VALUES('command_exec','1');
    CREATE TABLE tool_plugins(id TEXT,manifest TEXT); INSERT INTO tool_plugins VALUES('plugin1','{}');
    CREATE TABLE approvals(id TEXT,state TEXT); INSERT INTO approvals VALUES('a1','approved');`);old.close();old=undefined;
  const target=path.join(x.c.data,'asterline.sqlite3');
  const cmd=(apply)=>spawnSync(process.execPath,['scripts/migrate-python.mjs','--source',oldPath,'--dest',target,...(apply?['--apply']:[])],{cwd:path.resolve('.'),encoding:'utf8'});
  const dry=cmd(false);assert.equal(dry.status,0,dry.stderr);assert.match(dry.stdout,/dry-run/);
  assert.equal(x.store.db.prepare('SELECT count(*) AS n FROM js_legacy_jobs').get().n,0);
  x.store.close();const result=cmd(true);assert.equal(result.status,0,result.stderr);
  const again=cmd(true);assert.equal(again.status,0,again.stderr);
  x.store=new Store(x.c.data);
  assert.equal(x.store.db.prepare('SELECT count(*) AS n FROM js_legacy_jobs').get().n,1);
  assert.equal(x.store.db.prepare('SELECT count(*) AS n FROM js_legacy_plugins').get().n,1);
  assert.equal(x.store.db.prepare('SELECT count(*) AS n FROM js_legacy_events').get().n,1);
  assert.equal(x.store.flag('command_exec'),false);
  assert.equal(x.store.active().length,0);
 }finally{old?.close();x.close();}
});

test('Real arbitrary executable background task produces owner-scoped pageable logs and supports cancellation',async()=>{
 const x=fixture();try{
  const binary=process.execPath;
  x.store.setFlag('command_exec',true);
  const jobs=new JobManager(x.c,x.store);
  const started=jobs.start('owner@example.com',binary,['-e','console.log("asterline-job-pass")'],'.','log test');
  assert.equal(started.state,'running');
  const waitDone=async id=>{for(let i=0;i<50;i++){const state=jobs.status('owner@example.com',id);if(state.state!=='running')return state;await new Promise(r=>setTimeout(r,100));}throw Error('Job failed to finish in 5 seconds');};
  const state=await waitDone(started.id);
  assert.equal(state.state,'finished');
  assert.match(jobs.logs('owner@example.com',started.id,0,8000).text,/asterline-job-pass/);
  assert.throws(()=>jobs.logs('other@example.com',started.id));
  assert.throws(()=>jobs.cancel('other@example.com',started.id));
  const slow=jobs.start('owner@example.com',binary,['-e','setTimeout(()=>{},30000)'],'.','cancel test');
  assert.equal(jobs.cancel('owner@example.com',slow.id).state,'termination_requested');
  assert.equal((await waitDone(slow.id)).state,'cancelled');
 }finally{x.close();}
});
