import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {command} from '../src/runner.ts';
import {inspectQaPolicy} from '../scripts/qa/sandbox-policy.mjs';
import {parseSandboxPids,terminateAndVerifyBox} from '../src/sandbox-supervisor.ts';
test('QA sandbox policy requires a full network deny and no automatic recovery',()=>{
  const txt=readFileSync('examples/qa/AsterlineQATest.sandboxie.ini','utf8');
  assert(inspectQaPolicy(txt).ok);
  assert(!inspectQaPolicy(txt.replace('AutoRecover=n','AutoRecover=y')).ok);
  assert(!inspectQaPolicy(txt.replace('AllowNetworkAccess=n','AllowNetworkAccess=y')).ok);
});
test('box termination must verify no survivor PIDs',async()=>{
  const i=()=>({code:0,timedOut:false,closed:true,out:'1\n30'});
  await assert.rejects(terminateAndVerifyBox('QA',async()=>i(),2,1),/remain/);
  assert.throws(()=>parseSandboxPids(''),/numeric/);
});
test('real local command reports timeout distinctly',async()=>{
  const folder=mkdtempSync(join(tmpdir(),'asterline-sandbox-hard-'));
  try{
    const res=await command(process.execPath,['-e','setTimeout(()=>{},10000)'],folder,90);
    assert.equal(res.timedOut,true);
  }finally{rmSync(folder,{recursive:true,force:true});}
});
