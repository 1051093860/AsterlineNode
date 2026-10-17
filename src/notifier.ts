/** Durable Gotify outbox. Pending messages survive restart and exponential retry. */
import type { Config } from './config.ts';
import type { Store } from './store.ts';
import {safeGotifyUrl} from './policy.ts';
let outbox: {c:Config;store:Store}|undefined;
let pump:NodeJS.Timeout|undefined;
async function deliver(c:Config,title:string,message:string,priority:number):Promise<{ok:boolean;error:string}>{
  if(!c.gotifyToken||!safeGotifyUrl(c.gotify))return {ok:false,error:'Gotify not configured'};
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),4000);
  try{
    const res=await fetch(c.gotify.replace(/\/$/,'')+'/message',{method:'POST',headers:{'X-Gotify-Key':c.gotifyToken,'Content-Type':'application/json'},body:JSON.stringify({title,message,priority}),signal:controller.signal});
    return {ok:res.ok,error:res.ok?'':`HTTP ${res.status}`};
  }catch(e){return {ok:false,error:String(e).slice(0,180)};}finally{clearTimeout(timeout);}
}
export function initNotifications(c:Config,store:Store){
  if(pump)clearInterval(pump);
  outbox={c,store};
  // Manual notification trigger is rate-limited in MCP endpoint, not here.
  const cycle=()=>{void processOutbox(c,store).catch(e=>store.audit('system','gotify_worker_error',String(e).slice(0,100)));};
  pump=setInterval(cycle,5000);pump.unref();setTimeout(cycle,1000).unref();
}
export function stopNotifications(){if(pump)clearInterval(pump);pump=undefined;outbox=undefined;}
export async function processOutbox(c:Config,store:Store){
  if(!c.gotifyToken||!safeGotifyUrl(c.gotify))return false;
  const row=store.takeNotification();if(!row)return false;
  const result=await deliver(c,row.title,row.body,row.priority);
  store.finishNotification(row.id,result.ok,result.error);
  return result.ok;
}
/** Queues when configured; returns false only if not configured. Does not assert delivery. */
export async function notify(c:Config,title:string,message:string,priority=5,event='system'){
  if(!c.gotifyToken||!safeGotifyUrl(c.gotify))return false;
  if(outbox&&outbox.c===c){outbox.store.queueNotification(event,title,message,priority);return true;}
  return (await deliver(c,title,message,priority)).ok;
}
