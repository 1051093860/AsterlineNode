import { spawn } from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {recoverSandboxEnvelope,removeRecoveredSandboxEnvelope} from './sandbox-bridge.ts';
import { existsSync,mkdirSync,readFileSync,writeFileSync,copyFileSync,rmSync } from 'node:fs';
import { join,resolve } from 'node:path';
import {ensureEmptyBox,listBoxPids,terminateAndVerifyBox,type CliResult} from './sandbox-supervisor.ts';
import { hash,validateManifest,type Manifest } from './policy.ts';
import type { Config } from './config.ts';
import type { Store,PluginRecord } from './store.ts';
import {notify} from './notifier.ts';

export type CommandResult = CliResult;
/** Preserve timeout independently from exit code (SIGKILL can return null or non-null).
 * stdout/stderr are bounded; child termination is best effort. For a Sandboxie
 * process, executeSandbox additionally terminates/verifies the whole box.
 */
export async function command(program:string,args:string[],cwd:string,timeout=90000,maxBytes=30000):Promise<CommandResult> {
  if(!Array.isArray(args)||!args.every(a=>typeof a==='string'))throw Error('args invalid');
  return new Promise((ok,fail)=>{
    let out='',settled=false,timedOut=false,closed=false;
    const child=spawn(program,args,{cwd,windowsHide:true,shell:false,env:{PATH:process.env.PATH||'',SystemRoot:process.env.SystemRoot||'',TEMP:process.env.TEMP||'',TMP:process.env.TMP||'',HOME:process.env.HOME||'',USERPROFILE:process.env.USERPROFILE||''},stdio:['ignore','pipe','pipe']});
    let timer:NodeJS.Timeout|undefined,watchdog:NodeJS.Timeout|undefined;
    const clear=()=>{if(timer)clearTimeout(timer);if(watchdog)clearTimeout(watchdog);};
    const finish=(code:number|null)=>{if(settled)return;settled=true;clear();ok({code,out:out.slice(0,maxBytes),timedOut,closed});};
    const collect=(chunk:Buffer)=>{if(out.length<maxBytes)out+=chunk.toString('utf8').slice(0,maxBytes-out.length);};
    child.stdout.on('data',collect);child.stderr.on('data',collect);
    child.once('error',e=>{if(!settled){settled=true;clear();fail(e);}});
    child.once('close',code=>{closed=true;finish(code);});
    timer=setTimeout(()=>{
      if(settled)return;
      timedOut=true;
      try{child.kill('SIGKILL');}catch{}
      // A stuck launcher must not prevent sandbox /terminate and verification.
      watchdog=setTimeout(()=>finish(null),4000);
    },Math.max(1,timeout));
  });
}
// npm.cmd cannot be invoked directly by spawn(shell:false) on Windows. Resolve installed npm CLI script.
export function npmCli(c:Config){
  const nodeDir=resolve(c.nodeExe,'..');
  const candidates=[join(nodeDir,'node_modules','npm','bin','npm-cli.js'),join(nodeDir,'..','node_modules','npm','bin','npm-cli.js')];
  const f=candidates.find(existsSync);if(!f)throw Error('npm-cli.js not found beside Node.js; set a standard Node.js installation');
  return f;
}
async function npm(c:Config,args:string[],cwd:string,ms=90000){
  return command(c.nodeExe,[npmCli(c),...args],cwd,ms);
}
const reg='https://registry.npmjs.org/';
export function validateLock(lock:unknown){
  if(!lock||typeof lock!=='object')throw Error('Missing lockfile');
  const p=(lock as any).packages;
  if(!p||typeof p!=='object'||Object.keys(p).length>700)throw Error('Unexpected dependency graph');
  for(const [name,meta] of Object.entries(p) as [string,any][]){
    if(!name)continue;
    if(!name.startsWith('node_modules/')||!meta||typeof meta!=='object')throw Error('Invalid lock package');
    if(meta.link||meta.hasInstallScript)throw Error(`Lifecycle scripts or symlink package blocked: ${name}`);
    if(typeof meta.resolved!=='string'||!meta.resolved.startsWith(reg)||!/^sha(512|384)-/.test(String(meta.integrity||'')))throw Error(`Unsafe registry URL or integrity: ${name}`);
    if(meta.optional && (meta.os||meta.cpu)) continue;
  }
}
export interface ReviewReport{digest:string;lockHash:string;count:number;packages:{name:string;version:string;integrity:string}[];vulnerabilities:Record<string,number>;warnings:string[];reviewedAt:string}
export async function preflight(c:Config,store:Store,record:PluginRecord):Promise<ReviewReport>{
  if(record.state!=='draft')throw Error('Preflight allowed only for drafts');
  const m=validateManifest(JSON.parse(record.manifest));
  const dir=join(c.data,'review',record.id);mkdirSync(dir,{recursive:true});
  writeFileSync(join(dir,'package.json'),JSON.stringify({name:'asterline-plugin-'+m.id,version:'0.0.0',type:'module',private:true,dependencies:m.dependencies},null,2));
  writeFileSync(join(dir,'tool.mjs'),record.source);
  const result=await npm(c,['install','--package-lock-only','--ignore-scripts','--no-fund','--registry='+reg,'--package-lock=true'],dir,120000);
  if(result.code!==0)throw Error('Dependency resolution failed: '+result.out.slice(-2000));
  const text=readFileSync(join(dir,'package-lock.json'),'utf8');
  const lock=JSON.parse(text);validateLock(lock);
  const audit=await command(c.nodeExe,[npmCli(c),'audit','--json','--package-lock-only','--registry='+reg],dir,120000,2000000);
  let info:any;
  try{info=JSON.parse(audit.out);}catch{throw Error('npm audit output could not be parsed; fail closed');}
  if(!info?.metadata?.vulnerabilities)throw Error('npm audit did not produce vulnerability summary');
  const vulnerabilities=info.metadata.vulnerabilities as Record<string,number>;
  if((vulnerabilities.high||0)+(vulnerabilities.critical||0)>0)throw Error('Known high/critical npm vulnerabilities block review');
  const packages=Object.entries(lock.packages).filter(([name])=>name!=='').map(([name,meta]:any)=>({name,version:String(meta.version||''),integrity:String(meta.integrity||'').slice(0,30)+'…'}));
  const report:ReviewReport={digest:record.digest,lockHash:hash(text),count:packages.length,packages,vulnerabilities,warnings:[],reviewedAt:new Date().toISOString()};
  store.transition(record.id,['draft'],'reviewed',JSON.stringify(report));
  return report;
}
export async function installApproved(c:Config,store:Store,id:string){
  const r=store.get(id);if(!r||r.state!=='reviewed'||!r.report)throw Error('Plugin not preflighted');
  const report=JSON.parse(r.report) as ReviewReport;
  if(report.digest!==r.digest)throw Error('Source digest changed after review');
  const reviewDir=join(c.data,'review',id),dir=join(c.data,'releases',id);
  const lockText=readFileSync(join(reviewDir,'package-lock.json'),'utf8');
  if(hash(lockText)!==report.lockHash)throw Error('Lockfile changed since review');
  if(existsSync(dir))throw Error('Release path already exists');
  mkdirSync(dir,{recursive:true});
  for(const f of ['package.json','package-lock.json'])copyFileSync(join(reviewDir,f),join(dir,f));
  writeFileSync(join(dir,'tool.mjs'),r.source);
  try{
    const result=await npm(c,['ci','--ignore-scripts','--no-audit','--no-fund','--registry='+reg],dir,180000);
    if(result.code!==0)throw Error('npm ci failed: '+result.out.slice(-2000));
    validateLock(JSON.parse(readFileSync(join(dir,'package-lock.json'),'utf8')));
    if(hash(readFileSync(join(dir,'package-lock.json'),'utf8'))!==report.lockHash)throw Error('Installed lockfile differs from reviewed lock');
    store.transition(id,['reviewed'],'installed');
  }catch(e){rmSync(dir,{recursive:true,force:true});throw e;}
}
export function sandboxReady(c:Config){return process.platform==='win32'&&c.sandboxConfirmed&&existsSync(c.sandboxieStart)&&existsSync(c.nodeExe)&&Boolean(c.sandboxieBoxRoot)&&existsSync(c.sandboxieBoxRoot)&&/^[A-Za-z0-9_-]{3,40}$/.test(c.sandboxieBox);}
let activeSandboxJob=false; // One job per dedicated box; /terminate affects the entire box.
export async function executeSandbox(c:Config,store:Store,owner:string,plugin:string,params:unknown){
  const r=store.get(plugin);if(!r||r.state!=='active')throw Error('Plugin not published');
  if(!sandboxReady(c))throw Error('Sandboxie disabled/incomplete: Start.exe, hardened box, SANDBOXIE_BOX_ROOT and confirmation required');
  if(activeSandboxJob)throw Error('Sandbox box busy; retry later');
  const interlock=join(c.data,`sandbox-interlock-${c.sandboxieBox}.json`);
  if(existsSync(interlock))throw Error('Sandbox cleanup previously unverified: administrator must inspect box before clearing interlock');
  activeSandboxJob=true;
  const dir=join(c.data,'releases',r.id);
  const invoke=(args:string[],ms:number)=>command(c.sandboxieStart,args,dir,ms,5000);
  let id:string|null=null,nonce='',out='',code:number|null=null;
  let state='failed',cleanupVerified=false,preflightComplete=false,launched=false;
  let failure:unknown=null;
  try{
    // A reused box with leftovers is not safe to /terminate: fail closed
    // rather than killing unrelated processes owned by this box.
    await ensureEmptyBox(c.sandboxieBox,invoke);
    preflightComplete=true;
    id=store.newRun(owner,r.id);nonce=randomUUID();
    await notify(c,'Asterline · 任务开始',`插件 ${r.name}，任务 ${id}`,3);
    const scratch=join(c.data,'sandbox-output',id);mkdirSync(scratch,{recursive:true});
    const outputFile=join(scratch,'result.json');
    const runner=resolve('src','plugin-worker.mjs');
    const args=[`/box:${c.sandboxieBox}`,'/silent','/wait',c.nodeExe,'--permission','--no-addons',`--allow-fs-read=${dir}`,`--allow-fs-read=${runner}`,`--allow-fs-write=${scratch}`,runner,join(dir,'tool.mjs'),outputFile,JSON.stringify(params??{}),id,nonce];
    launched=true;
    const res=await command(c.sandboxieStart,args,dir,c.maxPluginSeconds*1000);
    code=res.code;out=res.out;
    if(res.timedOut){
      state='timed_out';
      try{await terminateAndVerifyBox(c.sandboxieBox,invoke);cleanupVerified=true;}
      catch(e){throw Error(`Plugin timed out; sandbox cleanup NOT VERIFIED: ${String(e)}`);}
      throw Error(`Plugin exceeded ${c.maxPluginSeconds}s timeout; sandbox process list confirmed empty`);
    }
    if(res.closed===false||res.code===null){
      state='launcher_error';
      await terminateAndVerifyBox(c.sandboxieBox,invoke);cleanupVerified=true;
      throw Error('Sandboxie launcher did not close normally; sandbox processes terminated');
    }
    // A launcher exit does not prove all sandboxed children have exited.
    const remaining=await listBoxPids(c.sandboxieBox,invoke);
    if(remaining.length){
      state='orphaned';
      await terminateAndVerifyBox(c.sandboxieBox,invoke);cleanupVerified=true;
      throw Error(`Sandboxie child process(es) survived launcher exit: ${remaining.join(', ')}`);
    }
    cleanupVerified=true;
    let recovered;
    try{recovered=recoverSandboxEnvelope(c.sandboxieBoxRoot,outputFile,process.env.USERPROFILE||'',id,nonce);}
    catch(e){throw Error('Sandbox output recovery failed: '+String(e));}
    removeRecoveredSandboxEnvelope(recovered.physicalPath);
    if(!recovered.envelope.ok)throw Error('Worker returned error: '+recovered.envelope.error);
    out=JSON.stringify(recovered.envelope.result);
    if(out===undefined||out.length>12000)throw Error('Invalid or oversized plugin output');
    if(code!==0)throw Error('Sandboxie child returned nonzero exit '+code);
    state='finished';
  }catch(e){
    failure=e;
    out=String(e).slice(0,2000);
    // Never terminate somebody else's pre-existing QA sandbox processes.
    // A failed preflight creates a sticky interlock but does NOT invoke /terminate.
    if(!preflightComplete){
      try{writeFileSync(interlock,JSON.stringify({at:new Date().toISOString(),box:c.sandboxieBox,reason:out.slice(0,400)}),{flag:'wx'});}catch{}
    }
    if(!cleanupVerified && preflightComplete && launched){
      try{
        const pids=await listBoxPids(c.sandboxieBox,invoke);
        if(pids.length)await terminateAndVerifyBox(c.sandboxieBox,invoke);
        cleanupVerified=true;
      }catch(cleanErr){
        const detail=`${out}; cleanup uncertain: ${String(cleanErr)}`;
        out=detail.slice(0,2000);
        try{writeFileSync(interlock,JSON.stringify({at:new Date().toISOString(),box:c.sandboxieBox,reason:detail.slice(0,400)}),{flag:'wx'});}catch{}
      }
    }
  }finally{activeSandboxJob=false;}
  if(id){
    store.finishRun(id,state,code,out);
    await notify(c,`Asterline · 任务${state==='finished'?'完成':state==='timed_out'?'超时':'失败'}`,`插件 ${r.name}，任务 ${id}`,state==='finished'?5:8);
  }
  if(failure)throw Error(`Sandbox run failed [${id||'not-started'}] (${state}): ${out}`);
  return {task_id:id!,result:JSON.parse(out)};
}
