/** Independent UNSANDBOXED host processes. Any executable, explicit host-operation approval required. */
import {spawn,type ChildProcess} from 'node:child_process';
import {existsSync, mkdirSync, openSync, closeSync, statSync, readSync, realpathSync} from 'node:fs';
import {join,basename,isAbsolute,delimiter,extname} from 'node:path';
import type {Config} from './config.ts';
import type {Store} from './store.ts';
import {workspacePath} from './workspace.ts';
import {notify} from './notifier.ts';
const MAX_JOBS=4,MAX_SEC=3600,MAX_LOG=10_000_000;
type Running={owner:string;child:ChildProcess;cancelled:boolean;reason?:string;timer:NodeJS.Timeout;log:number};
const active=new Map<string,Running>();
/** Resolve a named executable from the server PATH, never from the agent-selected cwd.
 * An explicit absolute executable path is also permitted; the resolved path is
 * included in the one-time approval digest to prevent post-approval retargeting.
 * Windows batch scripts require a shell, and intentionally cannot be spawn()ed
 * by task_start with shell:false. Use terminal_exec shell=cmd/powershell instead.
 */
export function resolveJobExecutable(program:string):string{
  if(typeof program!=='string'||!program.trim()||program!==program.trim()||program.length>2048||/[\x00-\x1f]/.test(program))throw Error('Invalid executable');
  const absolute=isAbsolute(program);
  if(!absolute && (program==='.'||program==='..'||/[\\/]/.test(program)))throw Error('Use a full absolute executable path or a bare PATH program name');
  if(process.platform==='win32' && /\.(?:cmd|bat)$/i.test(program))throw Error('Batch files require terminal_exec with shell=cmd or an explicitly approved cmd.exe command');
  const suffixes=process.platform==='win32' && !extname(program)?['.exe','.com']:[''];
  const pathEntries=(process.env.PATH||process.env.Path||'').split(delimiter)
    .map(dir=>dir.trim().replace(/^"(.*)"$/,'$1')).filter(dir=>isAbsolute(dir));
  const roots=absolute?['']:[...pathEntries];
  for(const dir of roots)for(const ext of suffixes){
    const candidate=absolute?program+ext:join(dir,program+ext);
    try{
      const target=realpathSync(candidate);const st=statSync(target);
      if(!st.isFile())continue;
      if(process.platform!=='win32' && (st.mode&0o111)===0)continue;
      return target;
    }catch{/* Try next PATH location. */}
  }
  throw Error('Executable not found on the service PATH or at the supplied absolute path: '+program);
}
export type JobInput={program:string;args:string[];cwd:string;label:string;working:string;executable:string;fileSize:number;fileMtimeMs:number};
export function checkJobInput(c:Config,program:string,args:string[]=[],cwd='.',label=''):JobInput{
  if(!Array.isArray(args)||args.length>40||args.some(x=>typeof x!=='string'||x.includes('\0'))||args.join('').length>8192)throw Error('Invalid program arguments');
  if(typeof label!=='string'||label.length>80||/[\x00-\x1f]/.test(label))throw Error('Invalid task label');
  const executable=resolveJobExecutable(program);
  const st=statSync(executable);
  const working=workspacePath(c,cwd);
  if(!statSync(working).isDirectory())throw Error('Invalid working directory');
  return {program,args,cwd,label,working,executable,fileSize:st.size,fileMtimeMs:st.mtimeMs};
}
/** Bind the binary selection and file identity to the exact one-time approval.
 * Existing v1.9.1 task tickets are intentionally not upgraded to v1.9.2.
 */
export function jobAuthorizationParams(params:{program:string;args:string[];cwd:string;label:string},input:JobInput){
  return {...params,resolved_executable:input.executable,executable_size:input.fileSize,executable_mtime_ms:input.fileMtimeMs};
}
function childEnv():NodeJS.ProcessEnv{
  return Object.fromEntries(['PATH','PATHEXT','SystemRoot','WINDIR','TEMP','TMP','USERPROFILE','HOME','APPDATA','LOCALAPPDATA']
    .filter(k=>typeof process.env[k]==='string').map(k=>[k,process.env[k]!])) as NodeJS.ProcessEnv;
}
function killTree(child:ChildProcess){
  if(!child.pid)return;
  if(process.platform==='win32'){
    const exe=join(process.env.SystemRoot||'C:\\Windows','System32','taskkill.exe');
    const p=spawn(exe,['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true,shell:false});p.on('error',()=>child.kill());
  }else child.kill('SIGKILL');
}
export class JobManager {
  private c:Config; private store:Store;
  constructor(c:Config,store:Store){this.c=c;this.store=store;}
  start(owner:string,program:string,args:string[]=[],cwd='.',label='',approved?:JobInput){
    if(!this.store.flag('command_exec'))throw Error('Command execution disabled by administrator');
    const cmd=checkJobInput(this.c,program,args,cwd,label);
    if(approved && (approved.executable!==cmd.executable||approved.fileSize!==cmd.fileSize||approved.fileMtimeMs!==cmd.fileMtimeMs))
      throw Error('Executable changed after approval; request a new authorization');
    if(active.size>=MAX_JOBS)throw Error('Maximum of four active background tasks reached');
    const id=this.store.newJob(owner,JSON.stringify([program,...args]),cmd.working,label);
    const logs=join(this.c.data,'job-logs');mkdirSync(logs,{recursive:true});
    const logPath=join(logs,id+'.log');let handle:number;
    try{handle=openSync(logPath,'wx',0o600);}catch(e){this.store.finishJob(id,'failed',null);throw e;}
    let child:ChildProcess;
    try{child=spawn(cmd.executable,args,{cwd:cmd.working,env:childEnv(),shell:false,windowsHide:true,stdio:['ignore',handle,handle]});}
    catch(e){closeSync(handle);this.store.finishJob(id,'failed',null);throw e;}
    closeSync(handle);
    // Child keeps inherited log HANDLE. Node does not relay arbitrary stdout to MCP memory.
    this.store.jobStarted(id,child.pid??null,logPath);
    const holder:Running={owner,child,cancelled:false,log:0,timer:setInterval(()=>{
      try{if(existsSync(logPath)&&statSync(logPath).size>MAX_LOG){holder.reason='log_limit_exceeded';killTree(child);}}
      catch{}},1000)};
    active.set(id,holder);
    const stop=setTimeout(()=>{holder.reason='timed_out';killTree(child);},MAX_SEC*1000);stop.unref();
    const finalize=(code:number|null)=>{
      if(!active.has(id))return;
      clearTimeout(stop);clearInterval(holder.timer);active.delete(id);
      const state=holder.reason||(holder.cancelled?'cancelled':code===0?'finished':'failed');
      this.store.finishJob(id,state,code);
      this.store.audit(owner,'task_finish',`${id} ${state} exit=${code??'null'}`);
      if(this.store.flag('notify_task_end'))void notify(this.c,'Asterline · 后台任务结束',`${label||program} ${state} (${id})`,state==='finished'?5:8);
    };
    child.on('error',e=>{this.store.audit(owner,'task_error',`${id} ${String(e).slice(0,150)}`);finalize(null);});
    child.on('close',finalize);
    this.store.audit(owner,'task_start',`${id} ${program}`);
    if(this.store.flag('notify_task_start'))void notify(this.c,'Asterline · 后台任务启动',`${label||program} (${id})`,4);
    return {id,state:'running',pid:child.pid??null,label,log_path:undefined};
  }
  cancel(owner:string,id:string,admin=false){
    const row=this.store.job(id,admin?undefined:owner);
    if(!row)throw Error('Unknown task');
    if(row.state!=='running')return {id,state:row.state};
    const h=active.get(id);
    if(!h){this.store.finishJob(id,'lost',null);return {id,state:'lost'};}
    h.cancelled=true;killTree(h.child);this.store.audit(owner,'task_cancel_requested',id);
    return {id,state:'termination_requested'};
  }
  logs(owner:string,id:string,offset=0,limit=8000){
    const row=this.store.job(id,owner);if(!row)throw Error('Unknown task');
    if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>64_000)throw Error('Invalid log range');
    if(!row.log_path||!existsSync(row.log_path))return {task_id:id,text:'',next_offset:offset};
    const fd=openSync(row.log_path,'r');try{const size=statSync(row.log_path).size;const n=Math.max(0,Math.min(limit,size-offset));const buf=Buffer.alloc(n);const count=readSync(fd,buf,0,n,offset);return {task_id:id,text:buf.subarray(0,count).toString('utf8'),next_offset:offset+count};}finally{closeSync(fd);}
  }
  status(owner:string,id:string){const j=this.store.job(id,owner);if(j)return {id:j.id,state:j.state,pid:j.pid,exit_code:j.exit_code,started:j.started,finished:j.finished,command:j.command,label:j.label};
    const run=this.store.db.prepare('SELECT * FROM js_runs WHERE id=? AND owner=?').get(id,owner);return run||{error:'not_found'};
  }
  activeCount(){return active.size;}
}
