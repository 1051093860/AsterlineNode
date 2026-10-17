/** Unified, fail-closed permission decisions for the Asterline work session.
 * The MCP identity is a verified Access email. A self-reported Agent name
 * is never an authorization key: two clients sharing a CF login share scope.
 */
import path from 'node:path';
import {lstatSync} from 'node:fs';
import type {Config} from './config.ts';
import type {Store} from './store.ts';
import {workspacePath} from './workspace.ts';
import {paramsHash} from './policy.ts';

export const WORK_CAPABILITIES=['fs_write','sandbox_plugin'] as const;
export type WorkCapability=typeof WORK_CAPABILITIES[number];
export const WORK_HOUR_MS=3_600_000;
export const WORK_REQUEST_MS=1_800_000;

const under=(root:string,target:string)=>{
  const rel=path.relative(root,target);
  return rel===''||(!path.isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+path.sep));
};
export function validateWorkRoot(c:Config,input:string):string {
  if(typeof input!=='string'||input.length>1024)throw Error('Invalid workspace scope');
  const full=workspacePath(c,input);
  if(!lstatSync(full).isDirectory())throw Error('Work scope must be an existing directory');
  return path.relative(workspacePath(c,'.'),full)||'.';
}
export function validateWorkCapabilities(caps:unknown):WorkCapability[] {
  if(!Array.isArray(caps)||caps.length<1||caps.length>2||new Set(caps).size!==caps.length||
    !caps.every(c=>WORK_CAPABILITIES.includes(c)))throw Error('Invalid work capabilities');
  return caps as WorkCapability[];
}
export function hasWorkPermission(store:Store,c:Config,owner:string,cap:WorkCapability,inputPath?:string):boolean {
  const session=store.currentWorkSession(owner);
  if(!session||!session.capabilities.includes(cap))return false;
  if(cap==='fs_write'){
    if(typeof inputPath!=='string')return false;
    const root=workspacePath(c,session.workspace);
    const target=workspacePath(c,inputPath,false);
    if(!under(root,target))return false;
  }
  store.audit(owner,'work_scope_used',`${session.id}: ${cap}`);
  return true;
}
export function authorizeFileWrite(store:Store,c:Config,owner:string,pathName:string,content:string,approvalId?:string):'one_time'|'work_session' {
  workspacePath(c,pathName,false);
  if(approvalId){
    if(!store.flag('file_write'))throw Error('Legacy file-write switch is disabled');
    store.consume(approvalId,owner,'@fs_write',paramsHash({path:pathName,content}));
    return 'one_time';
  }
  if(hasWorkPermission(store,c,owner,'fs_write',pathName))return 'work_session';
  throw Error('No project authorization. Request a work session with work_request or use a one-time approved request');
}
export function authorizeBackgroundJob(store:Store,owner:string,params:unknown,approvalId?:string):'one_time' {
  // task_start is native Windows host execution, not Sandboxie execution, even without a program allowlist.
  // Never let a development session or an obsolete global approval flag authorize it.
  if(!store.flag('command_exec'))throw Error('Host background process switch disabled');
  if(!approvalId)throw Error('Host background process requires an exact one-time approval');
  store.consume(approvalId,owner,'@task_start',paramsHash(params));
  return 'one_time';
}
export function authorizeSandboxPlugin(store:Store,c:Config,owner:string,pluginId:string,input:unknown,approvalId?:string):'one_time'|'work_session'|'plugin_lease' {
  if(approvalId){store.consume(approvalId,owner,pluginId,paramsHash(input));return 'one_time';}
  if(hasWorkPermission(store,c,owner,'sandbox_plugin'))return 'work_session';
  store.authorizePluginCall(owner,pluginId,paramsHash(input));
  return 'plugin_lease';
}
