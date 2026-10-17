/**
 * EXPLICIT UNSANDBOXED HOST EXECUTION.
 * Admin-only one-hour lease for one Cloudflare-verified email, only for already
 * published plugins. This does NOT provide OS privilege escalation.
 * It DOES permit ordinary Windows account read/write/network/process access.
 * Treat approved JS as fully trusted during this window.
 *
 * Expiry/revocation denies new calls; tasks are time limited and cancellation
 * attempts to terminate descendants, but arbitrary code can persist outside
 * the lifespan of any process. No sandbox can guarantee rollback of effects.
 */
import {spawn, type ChildProcess} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdirSync,readFileSync,rmSync,existsSync,lstatSync} from 'node:fs';
import {join,resolve} from 'node:path';
import type {Config} from './config.ts';
import type {Store} from './store.ts';
import {notify} from './notifier.ts';

const running=new Map<string,Set<{cancel:(why:string)=>void}>>();
const MAX_OUT=16_384;

/** Stop all in-flight plugin workers for a particular grant after admin revocation. */
export function stopHostPassJobs(leaseId:string):void {
  for(const job of running.get(leaseId)??[])job.cancel('Host-direct permission revoked');
}

// Do NOT forward MCP, Cloudflare or Gotify secrets into the unconfined process.
function minimalEnv():NodeJS.ProcessEnv {
  return Object.fromEntries(['SystemRoot','WINDIR','PATH','TEMP','TMP','USERPROFILE','HOME','APPDATA','LOCALAPPDATA']
    .filter(x=>typeof process.env[x]==='string').map(x=>[x,process.env[x]!]));
}

function killTree(child:ChildProcess) {
  if(!child.pid)return;
  // Windows taskkill attempts to terminate the child and all its current descendants.
  // It cannot undo writes, network traffic or persistence already established.
  if(process.platform==='win32') {
    const tool=join(process.env.SystemRoot||'C:\\Windows','System32','taskkill.exe');
    const killer=spawn(tool,['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore',shell:false});
    killer.on('error',()=>child.kill());
  } else child.kill('SIGKILL');
}

export async function executeHostDirect(
  c:Config,store:Store,owner:string,plugin:string,params:unknown,leaseId:string
):Promise<{task_id:string;result:unknown;execution:'host_direct'}> {
  const lease=store.currentHostPass(owner);
  if(!lease||lease.id!==leaseId)throw Error('Host-direct hour expired or revoked');
  const record=store.get(plugin);
  if(!record||record.state!=='active')throw Error('Plugin not published');
  const input=JSON.stringify(params??{});
  if(!input||Buffer.byteLength(input)>24_000)throw Error('Plugin input too large');
  const release=join(c.data,'releases',record.id);
  const tool=join(release,'tool.mjs');
  if(!existsSync(tool))throw Error('Approved plugin release is missing');

  const taskId=store.newRun(owner,record.id), nonce=randomUUID();
  const scratch=join(c.data,'host-direct-output',taskId);
  mkdirSync(scratch,{recursive:true});
  const resultFile=join(scratch,'result.json');
  const runner=resolve('src','plugin-worker.mjs');
  let state='failed',code:number|null=null,summary='';
  const startedAt=Date.now();
  const remaining=lease.expires-startedAt;
  if(remaining<=0){store.finishRun(taskId,'failed',null,'Grant expired');throw Error('Grant expired');}
  const runtimeMs=Math.min(c.maxPluginSeconds*1000,remaining);
  const deadline=Date.now()+runtimeMs;
  let terminate:(reason:string)=>void=()=>{};
  const job={cancel:(reason:string)=>terminate(reason)};
  if(!running.has(leaseId))running.set(leaseId,new Set());
  running.get(leaseId)!.add(job);
  try {
    // No --permission and no Sandboxie by ADMINISTRATOR CHOICE.
    // No shell, no inherited stdin, no sensitive environment variables.
    const outcome=await new Promise<{exit:number|null;error:string;timedOut:boolean}>((done)=>{
      let child:ChildProcess;
      try {
        child=spawn(c.nodeExe,[runner,tool,resultFile,input,taskId,nonce],{
          cwd:release,shell:false,windowsHide:true,env:minimalEnv(),stdio:['ignore','ignore','pipe']
        });
      }catch(e){done({exit:null,error:String(e),timedOut:false});return;}
      let settled=false,cancelled='',stderr='';
      let watchdog:NodeJS.Timeout|undefined;
      const finish=(exit:number|null,error:string,timedOut:boolean)=>{
        if(settled)return;settled=true;if(watchdog)clearTimeout(watchdog);
        done({exit,error:cancelled||error||stderr.slice(-600),timedOut});
      };
      terminate=(reason:string)=>{if(settled||cancelled)return;cancelled=reason;killTree(child);};
      child.stderr?.on('data',(chunk:Buffer)=>{stderr=(stderr+String(chunk)).slice(-800);});
      child.on('error',e=>finish(null,String(e),false));
      child.on('close',exit=>finish(exit,stderr,false));
      // Hard cap at lease deadline. If killTree cannot close quickly, resolve
      // anyway, mark failure, and never accept any result for that task.
      watchdog=setTimeout(()=>{
        terminate('Host-direct execution timed out or hour expired');
        setTimeout(()=>finish(null,'Terminating direct execution exceeded deadline',true),3000).unref();
      },Math.max(1,deadline-Date.now()));
    });
    code=outcome.exit;
    if(outcome.timedOut||outcome.error.startsWith('Host-direct permission revoked')||
       outcome.error.startsWith('Host-direct execution timed out'))throw Error(outcome.error);
    // Admin may revoke while the worker runs; do not return success afterward.
    if(!store.currentHostPass(owner)||store.currentHostPass(owner)!.id!==leaseId)
      throw Error('Host-direct grant expired or revoked during execution');
    if(code!==0)throw Error(`Unconfined worker exited ${code}: ${outcome.error.slice(-300)}`);
    if(!existsSync(resultFile))throw Error('Worker returned no output');
    const stat=lstatSync(resultFile);
    if(!stat.isFile()||stat.size<2||stat.size>MAX_OUT)throw Error('Invalid output file');
    const envelope=JSON.parse(readFileSync(resultFile,'utf8')) as Record<string,unknown>;
    if(envelope.task_id!==taskId||envelope.nonce!==nonce||envelope.ok!==true||
       !Object.hasOwn(envelope,'result'))throw Error('Invalid worker envelope');
    summary=JSON.stringify(envelope.result);
    if(!summary||Buffer.byteLength(summary)>12000)throw Error('Oversized response');
    state='finished';
    return {task_id:taskId,result:envelope.result,execution:'host_direct'};
  }catch(e){summary=String(e).slice(0,1800);throw e;}
  finally {
    const jobs=running.get(leaseId);jobs?.delete(job);if(jobs?.size===0)running.delete(leaseId);
    store.finishRun(taskId,state,code,summary);
    // Remove only this one private task scratch directory; do not touch plugin files.
    rmSync(scratch,{recursive:true,force:true});
    void notify(c,`Asterline · 宿主直通任务${state==='finished'?'完成':'失败'}`,`插件 ${record.name}，任务 ${taskId}`,state==='finished'?6:8);
  }
}
