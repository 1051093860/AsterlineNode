/** Admin-managed operational settings. Authentication and signing secrets are bootstrap-only.
 * No Agent-facing MCP method can mutate these values. All edits are verified by
 * Admin Basic + (public) Cloudflare JWT + Origin + CSRF checks in admin.ts.
 */
import path from 'node:path';
import {lstatSync, realpathSync, existsSync} from 'node:fs';
import type {Config} from './config.ts';
import type {Store} from './store.ts';
import {safeGotifyUrl} from './policy.ts';
// @ts-ignore - Node-only JS URL-host policy used by Library Bridge
import {normalizeLibraryHosts} from './library-bridge.mjs';

export const RUNTIME_KEYS = [
  'workspaceRoot',
  'sandboxieStart','sandboxieBox','sandboxieBoxRoot',
  'gotify','rcloneRemote','rcloneLocal','rcloneExe','maxPluginSeconds','libraryFileHosts'
] as const;
export type RuntimeKey = typeof RUNTIME_KEYS[number];
export const RUNTIME_LABELS: Record<RuntimeKey,string> = {
  workspaceRoot:'工作区根目录',
  sandboxieStart:'Sandboxie Start.exe 路径',sandboxieBox:'Sandboxie 名称',
  sandboxieBoxRoot:'Sandboxie 物理存储根目录',gotify:'Gotify 服务地址',
  rcloneRemote:'rclone 云盘远端（例如 gdrive:Asterline）',rcloneLocal:'本机云盘同步目录',
  rcloneExe:'rclone 可执行程序',maxPluginSeconds:'插件最长运行秒数',libraryFileHosts:'Library 下载域名白名单'
};
const pathExists=existsSync;
function fullPath(input:string,allowMissing=false){
  if(!path.isAbsolute(input)||input.includes('\0')||input.length>1024)throw Error('必须输入绝对路径');
  const normalized=path.normalize(input);
  if(!allowMissing || pathExists(normalized)){
    const st=lstatSync(normalized);if(st.isSymbolicLink())throw Error('不能选择链接目录或链接文件');
  }
  return normalized;
}
export function normalizeRuntimeSetting(key:string,raw:string,c:Config):string{
  if(!RUNTIME_KEYS.includes(key as RuntimeKey))throw Error('未知运行参数');
  if(typeof raw!=='string'||raw.length>4096||raw.includes('\0'))throw Error('配置值不合法或太长');
  const value=raw.trim();
  switch(key){
    case 'workspaceRoot':{
      const full=fullPath(value);if(!lstatSync(full).isDirectory())throw Error('工作区必须是已存在目录');
      const root=realpathSync(full);
      return root;
    }
    case 'sandboxieStart':{
      if(!value)return '';const full=fullPath(value);if(!lstatSync(full).isFile()||path.basename(full).toLowerCase()!=='start.exe')throw Error('必须指向 Sandboxie Start.exe');return full;
    }
    case 'sandboxieBox':{
      if(!/^[A-Za-z0-9_-]{3,40}$/.test(value))throw Error('沙箱名称只能包含英数、下划线、短横线');return value;
    }
    case 'sandboxieBoxRoot':{
      if(!value)return '';const dir=fullPath(value);if(!lstatSync(dir).isDirectory())throw Error('沙箱物理目录不存在');return realpathSync(dir);
    }
    case 'gotify':{
      if(!safeGotifyUrl(value))throw Error('仅支持安全的本机 Gotify 地址');return value.replace(/\/$/,'');
    }
    case 'rcloneRemote':{
      if(value && (!/^[A-Za-z][A-Za-z0-9_-]{0,60}:[^\r\n]{1,500}$/.test(value)||/\.\.|[\x00-\x1f]/.test(value)))throw Error('rclone 远端必须是 remote:受限子目录，不能包含 ..');
      return value.replace(/\/$/,'');
    }
    case 'rcloneLocal':{
      if(!value)return '';const dir=fullPath(value,true); // May be created by rclone CLI later
      return dir;
    }
    case 'rcloneExe':{
      if(value==='rclone')return value;
      const full=fullPath(value);if(!lstatSync(full).isFile()||!/^rclone(?:\.exe)?$/i.test(path.basename(full)))throw Error('只能指定 rclone.exe 或 rclone');return full;
    }
    case 'libraryFileHosts':{
      return normalizeLibraryHosts(value);
    }
    case 'maxPluginSeconds':{
      if(!/^[0-9]{1,3}$/.test(value)||+value<2||+value>120)throw Error('运行时限必须为 2–120 秒');return String(+value);
    }
    default:throw Error('未知运行参数');
  }
}
export function applyRuntimeSetting(c:Config,key:RuntimeKey,value:string){
  switch(key){
    case 'workspaceRoot':c.workspaceRoot=value;break;
    case 'sandboxieStart':c.sandboxieStart=value;break;
    case 'sandboxieBox':c.sandboxieBox=value;break;
    case 'sandboxieBoxRoot':c.sandboxieBoxRoot=value;break;
    case 'gotify':c.gotify=value;break;
    case 'libraryFileHosts':c.libraryFileHosts=value.split(',');break;
    case 'maxPluginSeconds':c.maxPluginSeconds=Number(value);break;
    // rclone is a separate CLI process. It reads the persisted SQLite config.
    case 'rcloneRemote':case 'rcloneLocal':case 'rcloneExe':break;
  }
}
export function loadRuntimeSettings(c:Config,store:Store){
  const sandboxAttestation=store.runtimeSetting('sandboxConfirmed');
  if(sandboxAttestation==='0')c.sandboxConfirmed=false;
  if(sandboxAttestation==='1')c.sandboxConfirmed=true;
  const saved=store.runtimeSettings();
  const keys=RUNTIME_KEYS.filter(k=>Object.hasOwn(saved,k));
  // Resolve the persisted workspace before other path settings.
  for(const key of ['workspaceRoot',...keys.filter(k=>k!=='workspaceRoot')] as RuntimeKey[]){
    if(!Object.hasOwn(saved,key))continue;
    const value=saved[key];
    if(!RUNTIME_KEYS.includes(key as RuntimeKey))continue;
    try{const checked=normalizeRuntimeSetting(key,value,c);applyRuntimeSetting(c,key,checked);}
    catch(e){
      store.audit('system','runtime_setting_invalid',`${key}: ${String(e).slice(0,120)}`);
      if(key==='workspaceRoot')throw Error('Previously saved workspace is unavailable. Refusing to boot with a different root. '+String(e));
      if(key==='sandboxieBox'||key==='sandboxieStart'||key==='sandboxieBoxRoot')c.sandboxConfirmed=false;
    }
  }
}
export function saveRuntimeSetting(c:Config,store:Store,key:string,value:string,actor:string){
  const normalized=normalizeRuntimeSetting(key,value,c), k=key as RuntimeKey;
  if(k==='workspaceRoot'||k==='sandboxieStart'||k==='sandboxieBox'||k==='sandboxieBoxRoot'){
    const busy=(store.db.prepare("SELECT count(*) AS n FROM js_jobs WHERE state='running'").get() as {n:number}).n+
      (store.db.prepare("SELECT count(*) AS n FROM js_runs WHERE state='running'").get() as {n:number}).n;
    if(busy)throw Error('有任务仍在运行，暂时不能修改工作区或沙箱边界');
  }
  const changed=(k==='workspaceRoot'||k==='sandboxieStart'||k==='sandboxieBox'||k==='sandboxieBoxRoot');
  // Changing the trust boundary invalidates the existing session and sandbox confirmation.
  store.setRuntimeSetting(k,normalized,actor);
  applyRuntimeSetting(c,k,normalized);
  if(k==='workspaceRoot'){
    store.db.prepare("UPDATE js_approvals SET state='denied' WHERE state IN ('pending','approved')").run();
    store.db.prepare('UPDATE js_work_sessions SET revoked=? WHERE revoked IS NULL AND expires>?').run(Date.now(),Date.now());
    store.db.prepare("UPDATE js_work_requests SET state='denied',decided=? WHERE state='pending'").run(Date.now());
    store.audit(actor,'work_sessions_invalidated','workspaceRoot changed');
  }
  if(changed && k!=='workspaceRoot'){
    // Old grants must not carry across a different sandbox boundary.
    store.db.prepare('UPDATE js_work_sessions SET revoked=? WHERE revoked IS NULL AND expires>?').run(Date.now(),Date.now());
    store.db.prepare("UPDATE js_permission_leases SET revoked=? WHERE revoked IS NULL AND expires>?").run(Date.now(),Date.now());
    c.sandboxConfirmed=false;
    store.setRuntimeSetting('sandboxConfirmed','0',actor);
  }
  return normalized;
}
