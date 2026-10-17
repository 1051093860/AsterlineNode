/**
 * Dedicated AsterlineQATest result-bridge probe. No host access grants, no DB.
 * Requires QA_POLICY_CONFIRMED=1 and QA_SANDBOX_ROOT=<FileRootPath>.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync,mkdirSync,writeFileSync,rmSync } from 'node:fs';
import { resolve,join } from 'node:path';
import {loadDotEnv,configFromEnv} from '../../src/config.ts';
import { recoverSandboxEnvelope,sandboxOutputCandidates,removeRecoveredSandboxEnvelope } from '../../src/sandbox-bridge.ts';
const cwd=resolve('.');
if(process.platform!=='win32')throw Error('Windows only');
if(process.env.QA_POLICY_CONFIRMED!=='1')throw Error('Set QA_POLICY_CONFIRMED=1 in this terminal only');
if((process.env.QA_SANDBOX_BOX||'AsterlineQATest')!=='AsterlineQATest')throw Error('QA box must be AsterlineQATest');
const root=(process.env.QA_SANDBOX_ROOT||'').trim();
if(!root||!existsSync(root))throw Error('Set QA_SANDBOX_ROOT to the exact Sandboxie FileRootPath of AsterlineQATest');
loadDotEnv();const c=configFromEnv();
if(!existsSync(c.sandboxieStart)||!existsSync(c.nodeExe))throw Error('Sandboxie Start.exe or node.exe not found');
const id=randomUUID(),nonce=randomUUID();
const base=join(cwd,'.qa-sandbox-bridge-recover',id);
const outputDir=join(base,'out');const script=join(base,'probe.mjs');const output=join(outputDir,'result.json');
mkdirSync(outputDir,{recursive:true});
writeFileSync(script,`import {writeFileSync} from 'node:fs';\nconst [file,task_id,nonce]=process.argv.slice(2);\nwriteFileSync(file,JSON.stringify({ok:true,task_id,nonce,result:{tag:'BRIDGE_OK'}}),{flag:'wx'});\n`);
const env={};for(const k of ['PATH','Path','SystemRoot','TEMP','TMP','HOME','USERPROFILE','WINDIR'])if(process.env[k])env[k]=process.env[k];
const args=['/box:AsterlineQATest','/silent','/wait',c.nodeExe,'--permission','--no-addons',`--allow-fs-read=${script}`,`--allow-fs-write=${outputDir}`,script,output,id,nonce];
let exitCode=null,log='';
try {
  const r=await new Promise((ok,fail)=>{
    const child=spawn(c.sandboxieStart,args,{cwd:base,env,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
    const timer=setTimeout(()=>{child.kill();},20000);
    child.stdout.on('data',x=>log+=String(x).slice(0,500));child.stderr.on('data',x=>log+=String(x).slice(0,500));
    child.once('error',e=>{clearTimeout(timer);fail(e)});
    child.once('close',code=>{clearTimeout(timer);ok(code)});
  });
  exitCode=r;console.log('Sandboxie /silent /wait exit:',exitCode);
  console.log('Host direct output present:',existsSync(output));
  if(exitCode!==0)throw Error('Worker startup failed. Inspect Sandboxie process messages.');
  const {envelope,physicalPath}=recoverSandboxEnvelope(root,output,process.env.USERPROFILE||'',id,nonce);
  if(!envelope.ok||envelope.result?.tag!=='BRIDGE_OK')throw Error('Bridge envelope contents invalid');
  console.log('[PASS] QA-only sandbox virtual result recovered and verified');
  console.log('Physical output:',physicalPath);
  removeRecoveredSandboxEnvelope(physicalPath);
  console.log('[PASS] recovered result removed from box storage');
} catch(e) {
  console.error('[FAIL]',String(e));
  console.error('Deterministic candidates inside FileRootPath:');
  try{for(const p of sandboxOutputCandidates(root,output,process.env.USERPROFILE||''))console.error(' ',p);}catch{}
  process.exitCode=1;
} finally {
  rmSync(base,{recursive:true,force:true});
}
