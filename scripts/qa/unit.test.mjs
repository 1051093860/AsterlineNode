/** QA-only offline tests. Does NOT need Sandboxie or npm network access. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync,mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {Store} from '../../src/store.ts';
import {validateManifest,validateSource,hash,canonical,paramsHash} from '../../src/policy.ts';
import {validateLock,command} from '../../src/runner.ts';
import {parseSandboxPids,terminateAndVerifyBox,ensureEmptyBox} from '../../src/sandbox-supervisor.ts';
import {inspectQaPolicy} from './sandbox-policy.mjs';
const fixture=name=>{
  const dir=path.resolve('examples','qa');
  const raw=readFileSync(path.join(dir,`${name}.manifest.json`),'utf8');
  const source=readFileSync(path.join(dir,`${name}.mjs`),'utf8');
  validateSource(source);return {manifest:validateManifest(JSON.parse(raw)),source};
};
test('all QA fixtures exist and pass manifest/source validation',()=>{
  for(const name of ['probe','zod','hang']){
    const dir=path.resolve('examples','qa');
    assert(existsSync(path.join(dir,`${name}.mjs`)));
    const source=readFileSync(path.join(dir,`${name}.mjs`),'utf8');
    validateSource(source);
    assert(validateManifest(JSON.parse(readFileSync(path.join(dir,`${name}.manifest.json`)))).tool.requireApproval);
  }
});
test('pinned dependencies and lock reject scripts and nonregistry sources',()=>{
  const manifest=JSON.parse(readFileSync('examples/qa/zod.manifest.json'));
  assert.equal(validateManifest(manifest).dependencies.zod,'4.1.12');
  assert.throws(()=>validateManifest({...manifest,dependencies:{zod:'^4.1.12'}}));
  assert.throws(()=>validateLock({packages:{'':{},'node_modules/x':{resolved:'https://evil.test/',integrity:'sha512-a'}}}));
  assert.throws(()=>validateLock({packages:{'':{},'node_modules/x':{resolved:'https://registry.npmjs.org/x/-/x.tgz',integrity:'sha512-a',hasInstallScript:true}}}));
});
test('approval remains exact-argument, exact-owner, single-use',()=>{
  const temp=mkdtempSync(path.join(os.tmpdir(),'asterline-qa-unit-'));
  const store=new Store(temp);
  try{
    const {manifest}=fixture('probe');
    const source=readFileSync('examples/qa/probe.mjs','utf8');
    store.create({id:manifest.id,name:manifest.name,owner:'qa@example.test',manifest:canonical(manifest),source,digest:hash(canonical(manifest)+'\n'+source)});
    const params={file:'qa'};const approval=store.request('qa@example.test',manifest.id,paramsHash(params),canonical(params),'QA',300);
    assert.throws(()=>store.consume(approval,'qa@example.test',manifest.id,paramsHash(params)));
    store.decide(approval,true);
    assert.throws(()=>store.consume(approval,'wrong@example.test',manifest.id,paramsHash(params)));
    assert.throws(()=>store.consume(approval,'qa@example.test',manifest.id,paramsHash({file:'changed'})));
    store.consume(approval,'qa@example.test',manifest.id,paramsHash(params));
    assert.throws(()=>store.consume(approval,'qa@example.test',manifest.id,paramsHash(params)));
  }finally{store.close();rmSync(temp,{recursive:true,force:true});}
});
test('policy guard rejects autorecover, share-only networking and missing WFP',()=>{
  const good=readFileSync('examples/qa/AsterlineQATest.sandboxie.ini','utf8');
  assert.equal(inspectQaPolicy(good).ok,true);
  assert(inspectQaPolicy(good.replace('AutoRecover=n','AutoRecover=y')).errors.some(x=>x.includes('AutoRecover')));
  assert(!inspectQaPolicy(good.replace('NetworkAccess=*,Block',';network rule missing')).ok);
  assert(!inspectQaPolicy(good.replace('NetworkEnableWFP=y','NetworkEnableWFP=n')).ok);
  assert(!inspectQaPolicy(good.replace('NetworkAccess=*,Block','NetworkAccess=*,Block\nNetworkAccess=*,Allow')).ok);
});
test('Sandboxie PID enumeration and stop proof are strict',async()=>{
  assert.deepEqual(parseSandboxPids('0\r\n'),[]);
  assert.deepEqual(parseSandboxPids('2\r\n1234\r\n5678\r\n'),[1234,5678]);
  assert.throws(()=>parseSandboxPids(''),/numeric/);
  assert.throws(()=>parseSandboxPids('0\n9999'),/count/);
  await assert.rejects(ensureEmptyBox('AsterlineQATest',async()=>({code:0,timedOut:false,closed:true,out:'1\n42'})),/not empty/);
  const seen=[];
  const replies=[{code:0,timedOut:false,closed:true,out:''},{code:0,timedOut:false,closed:true,out:'1\n42'}, {code:0,timedOut:false,closed:true,out:'0'}];
  await terminateAndVerifyBox('AsterlineQATest',async args=>{seen.push(args.join(' '));return replies.shift();},3,1);
  assert(seen[0].includes('/terminate'));
  assert(seen[1].includes('/listpids'));
  await assert.rejects(terminateAndVerifyBox('AsterlineQATest',async()=>({code:0,timedOut:false,closed:true,out:'1\n42'}),2,1),/processes remain/);
});
test('process timeouts are recorded independently of exit code',async()=>{
  const temp=mkdtempSync(path.join(os.tmpdir(),'asterline-command-'));
  try{
    const result=await command(process.execPath,['-e','setTimeout(()=>{},15000)'],temp,75,500);
    assert.equal(result.timedOut,true);
    assert.equal(result.closed,true);
    const quick=await command(process.execPath,['-e','process.stdout.write("ok")'],temp,5000,500);
    assert.equal(quick.timedOut,false);assert.equal(quick.code,0);
  }finally{rmSync(temp,{recursive:true,force:true});}
});
