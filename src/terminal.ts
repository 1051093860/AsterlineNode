/**
 * An explicitly unsandboxed Windows terminal, available ONLY during an
 * administrator-issued, Cloudflare-identity-bound host-direct hour.
 * This is not a sandbox; it runs with the MCP service account's authority.
 * Never pass auth/JWT/Gotify variables to child processes, never inherit stdin.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import type { Config } from './config.ts';
import type { Store } from './store.ts';
import { notify } from './notifier.ts';

type Shell = 'powershell' | 'cmd' | 'exec';
export interface TerminalRequest {
  shell: Shell;
  command: string;
  args?: string[];
  cwd?: string;
  timeout_seconds?: number;
}
export interface TerminalResult {
  task_id: string;
  execution: 'host_direct_terminal';
  exit_code: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  cwd: string;
}
const MAX_STREAM_BYTES = 24 * 1024;
const active = new Map<string,Set<(reason:string)=>void>>();

export function stopHostTerminalJobs(leaseId:string) {
  for (const cancel of active.get(leaseId)??[]) cancel('Host-direct permission revoked');
}
function childEnv():NodeJS.ProcessEnv {
  const allowed=['SystemRoot','WINDIR','PATH','PATHEXT','TEMP','TMP','USERPROFILE','HOME','APPDATA','LOCALAPPDATA'];
  return Object.fromEntries(allowed.filter(k=>typeof process.env[k]==='string').map(k=>[k,process.env[k]!]));
}
function terminateTree(child:ChildProcess) {
  if(!child.pid)return;
  if(process.platform==='win32') {
    const exe=join(process.env.SystemRoot||'C:\\Windows','System32','taskkill.exe');
    const killer=spawn(exe,['/PID',String(child.pid),'/T','/F'],{shell:false,stdio:'ignore',windowsHide:true});
    killer.on('error',()=>child.kill());
  } else child.kill('SIGKILL');
}
function commandToSpawn(req:TerminalRequest):{file:string;args:string[]} {
  if(!['powershell','cmd','exec'].includes(req.shell))throw Error('Unsupported terminal shell');
  if(typeof req.command!=='string'||!req.command.trim()||req.command.length>4000||req.command.includes('\0'))throw Error('Invalid command');
  if(!Array.isArray(req.args??[])||(req.args??[]).length>64||!(req.args??[]).every(a=>typeof a==='string'&&a.length<=4000&&!a.includes('\0')))throw Error('Invalid argv');
  if(req.shell!=='exec' && (req.args?.length??0)!==0)throw Error('argv only allowed with shell=exec');
  if(req.shell==='exec')return {file:req.command,args:req.args??[]};
  if(process.platform!=='win32')throw Error('PowerShell and CMD terminal modes require Windows');
  const root=process.env.SystemRoot||'C:\\Windows';
  if(req.shell==='powershell')return {
    file:join(root,'System32','WindowsPowerShell','v1.0','powershell.exe'),
    args:['-NoLogo','-NoProfile','-NonInteractive','-Command',req.command]
  };
  return {file:join(root,'System32','cmd.exe'),args:['/D','/Q','/C',req.command]};
}
function capture(limit:number) {
  const chunks:Buffer[]=[];let count=0,truncated=false;
  return {
    add(b:Buffer){ if(count>=limit){truncated=true;return;}
      const part=b.subarray(0,limit-count);chunks.push(part);count+=part.length;
      if(part.length<b.length)truncated=true;
    },
    get text(){return Buffer.concat(chunks).toString('utf8');},
    get truncated(){return truncated;}
  };
}
export async function executeHostTerminal(
  c:Config,store:Store,owner:string,request:TerminalRequest
):Promise<TerminalResult> {
  const lease=store.currentHostPass(owner);
  if(!lease)throw Error('Active administrator-issued host-direct hour required');
  const parsed=commandToSpawn(request);
  const cwd=resolve(request.cwd?.trim()||process.cwd());
  if(typeof request.cwd==='string'&&(request.cwd.length>2048||request.cwd.includes('\0')))throw Error('Invalid working directory');
  const seconds=request.timeout_seconds??30;
  if(!Number.isInteger(seconds)||seconds<1||seconds>120)throw Error('Terminal timeout must be 1–120 seconds');
  const left=lease.expires-Date.now();
  if(left<=0)throw Error('Host-direct hour expired');
  const runtimeMs=Math.min(seconds*1000,left);
  const id=store.newRun(owner,'@terminal_exec');
  const sha=createHash('sha256').update(request.shell+'\n'+request.command+'\n'+JSON.stringify(request.args??[])).digest('hex');
  // No command text in audit: might contain credentials. ID + hash support forensics.
  store.audit(owner,'terminal_started',`${id} ${request.shell} sha256=${sha.slice(0,24)}`);
  const out=capture(MAX_STREAM_BYTES),err=capture(MAX_STREAM_BYTES);
  let state='failed',code:number|null=null,reason='';
  let cancel=(_why:string)=>{};
  try {
    const outcome=await new Promise<{code:number|null;reason:string}>((done)=>{
      let child:ChildProcess;
      try{child=spawn(parsed.file,parsed.args,{cwd,env:childEnv(),shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});}
      catch(e){done({code:null,reason:String(e)});return;}
      let finished=false,stopReason='',watchdog:NodeJS.Timeout|undefined,force:NodeJS.Timeout|undefined;
      const finish=(result:number|null,msg:string)=>{
        if(finished)return;finished=true;if(watchdog)clearTimeout(watchdog);if(force)clearTimeout(force);
        done({code:result,reason:stopReason||msg});
      };
      cancel=(why:string)=>{
        if(finished||stopReason)return;
        stopReason=why;terminateTree(child);
        // A child or descendants might evade closure; never wait indefinitely.
        force=setTimeout(()=>finish(null,stopReason),3000);
        force.unref();
      };
      if(!active.has(lease.id))active.set(lease.id,new Set());
      active.get(lease.id)!.add(cancel);
      child.stdout?.on('data',(b:Buffer)=>out.add(b));
      child.stderr?.on('data',(b:Buffer)=>err.add(b));
      child.on('error',e=>finish(null,String(e)));
      child.on('close',exit=>finish(exit,''));
      watchdog=setTimeout(()=>cancel('Terminal time limit or one-hour permission expired'),Math.max(1,runtimeMs));
    });
    code=outcome.code;reason=outcome.reason;
    if(reason)throw Error(reason);
    const valid=store.currentHostPass(owner);
    if(!valid||valid.id!==lease.id)throw Error('Host-direct hour expired or revoked during execution');
    state=code===0?'finished':'failed';
    store.audit(owner,'terminal_completed',`${id} exit=${code}`);
    return {task_id:id,execution:'host_direct_terminal',exit_code:code,
      stdout:out.text,stderr:err.text,truncated:out.truncated||err.truncated,cwd};
  } catch(e) {
    reason=String(e).slice(0,400);
    store.audit(owner,'terminal_failed',`${id} ${reason}`);
    throw e;
  } finally {
    active.get(lease.id)?.delete(cancel);
    if(active.get(lease.id)?.size===0)active.delete(lease.id);
    store.finishRun(id,state,code,JSON.stringify({stdout:out.text.slice(0,3000),stderr:err.text.slice(0,3000),reason}).slice(0,16000));
    void notify(c,`Asterline · 终端任务${state==='finished'?'完成':'结束'}`,`任务 ${id}，退出码 ${code??'N/A'}`,state==='finished'?5:8);
  }
}
