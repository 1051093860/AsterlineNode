import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../src/store.ts';
import {checkJobInput,jobAuthorizationParams,resolveJobExecutable} from '../src/jobs.ts';
import {authorizeBackgroundJob} from '../src/permission-center.ts';
import {paramsHash} from '../src/policy.ts';
import {loadRuntimeSettings} from '../src/runtime-settings.ts';

test('Arbitrary absolute program resolves without an allowlist; workdir is still workspace-scoped',()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'asterline-abs-'));
 try{
  const c={workspaceRoot:home};
  const got=checkJobInput(c,process.execPath,['--version'],'.','Node');
  assert.equal(got.executable,fs.realpathSync(process.execPath));
  assert.equal(got.working,home);
  assert.equal(got.fileSize,fs.statSync(process.execPath).size);
  assert.throws(()=>checkJobInput(c,process.execPath,[],'..'),/escapes/);
  assert.throws(()=>checkJobInput(c,'../evil',[],'.'),/full absolute/);
  assert.throws(()=>resolveJobExecutable('missing-asterline-exe-please'),/not found/);
 }finally{fs.rmSync(home,{recursive:true,force:true});}
});
test('PATH discovery never falls back to cwd; bare names use service PATH',()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'asterline-path-'));
 const fake=path.join(home,process.platform==='win32'?'safe-tool.exe':'safe-tool');if(process.platform==='win32')fs.copyFileSync(process.execPath,fake);else fs.writeFileSync(fake,'#!/bin/sh\n',{mode:0o755});
 const original=process.env.PATH;
 try{
  process.env.PATH=home;
  assert.equal(resolveJobExecutable('safe-tool'),fs.realpathSync(fake));
  process.env.PATH='';
  assert.throws(()=>resolveJobExecutable('safe-tool'),/not found/);
 }finally{process.env.PATH=original;fs.rmSync(home,{recursive:true,force:true});}
});
test('Task approval binds actual executable and file identity, old approval digests fail closed',()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'asterline-digest-'));
 const store=new Store(path.join(home,'state'));
 try{
  const c={workspaceRoot:home};const params={program:process.execPath,args:['--version'],cwd:'.',label:''};
  const selected=checkJobInput(c,params.program,params.args,params.cwd,params.label);
  const signed=jobAuthorizationParams(params,selected);
  assert.equal(signed.resolved_executable,fs.realpathSync(process.execPath));
  assert.notEqual(paramsHash(params),paramsHash(signed));
  store.setFlag('command_exec',true);
  const old=store.request('person@example.org','@task_start',paramsHash(params),'{}','old');store.decide(old,true);
  assert.throws(()=>authorizeBackgroundJob(store,'person@example.org',signed,old),/Missing, mismatched/);
  const good=store.request('person@example.org','@task_start',paramsHash(signed),'{}','exact');store.decide(good,true);
  assert.equal(authorizeBackgroundJob(store,'person@example.org',signed,good),'one_time');
  assert.throws(()=>authorizeBackgroundJob(store,'person@example.org',signed,good),/Missing, mismatched/);
 }finally{store.close();fs.rmSync(home,{recursive:true,force:true});}
});
test('Old runtime executable allowlist database settings are inert after upgrade',()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'asterline-migrate-'));
 const store=new Store(path.join(home,'state'));
 try{
  store.setRuntimeSetting('allowedPrograms','not-real.exe','admin:test');
  store.setRuntimeSetting('execDirs',home,'admin:test');
  const c={workspaceRoot:home,maxPluginSeconds:30, sandboxConfirmed:false};
  loadRuntimeSettings(c,store);
  assert.equal(Object.hasOwn(c,'allowedPrograms'),false);
  assert.equal(resolveJobExecutable(process.execPath),fs.realpathSync(process.execPath));
 }finally{store.close();fs.rmSync(home,{recursive:true,force:true});}
});

test('Admin settings no longer render a program allowlist or trusted-path form',async()=>{
 const source=fs.readFileSync(new URL('../src/admin.ts',import.meta.url),'utf8');
 assert.doesNotMatch(source,/entry\('allowedPrograms'/);
 assert.doesNotMatch(source,/entry\('execDirs'/);
 assert.match(source,/不再要求程序名称白名单/);
});
