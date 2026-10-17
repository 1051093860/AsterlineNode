/**
 * Read ONE bounded output envelope from a Sandboxie box's file container.
 * This module does not grant the box direct access to host paths.
 *
 * Sandboxie typically redirects profile writes to FileRootPath/user/current/...
 * and other volume writes to FileRootPath/drive/<letter>/.... The administrator
 * supplies FileRootPath explicitly, so we do not guess it from USERPROFILE.
 */
import { existsSync, lstatSync, readFileSync, realpathSync, unlinkSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';

const MAX_ENVELOPE_BYTES = 16_384;
export type SandboxEnvelope = { ok:true; task_id:string; nonce:string; result:unknown } | { ok:false; task_id:string; nonce:string; error:string };
function inside(root:string, child:string):boolean {
  const rel=relative(root,child);
  return rel!=='' && rel!=='..' && !rel.startsWith('..'+sep) && !isAbsolute(rel);
}
function safeSegments(rel:string):string[] {
  const parts=rel.split(/[\\/]+/).filter(Boolean);
  if(parts.some(x=>x==='.'||x==='..'||x.includes(':')||!x))throw Error('Invalid sandbox virtual path segment');
  return parts;
}
/** Returns only deterministic candidates for the exact logical file. No directory walking. */
export function sandboxOutputCandidates(boxRoot:string, logicalPath:string, profileRoot:string):string[] {
  if(process.platform!=='win32')throw Error('Sandbox result bridge requires Windows');
  if(!boxRoot||!win32.isAbsolute(boxRoot)||!win32.isAbsolute(logicalPath)||!win32.isAbsolute(profileRoot))
    throw Error('Configure SANDBOXIE_BOX_ROOT as the absolute Sandboxie FileRootPath');
  const volume=win32.parse(logicalPath).root;
  if(!/^[A-Za-z]:\\$/.test(volume))throw Error('Only local drive-letter output paths supported');
  const drive=volume[0].toUpperCase();
  const whole=win32.resolve(logicalPath);
  const candidates:string[]=[];
  const relProfile=win32.relative(win32.resolve(profileRoot),whole);
  if(relProfile && !relProfile.startsWith('..\\') && relProfile!=='..' && !win32.isAbsolute(relProfile)) {
    candidates.push(win32.resolve(boxRoot,'user','current',...safeSegments(relProfile)));
  }
  const relDrive=whole.slice(volume.length);
  candidates.push(win32.resolve(boxRoot,'drive',drive,...safeSegments(relDrive)));
  return [...new Set(candidates)];
}
/** Reject sandbox-created symlinks/junctions/reparse paths, including ancestors. */
function readPlainFileInside(boxRoot:string, filename:string):string {
  const root=realpathSync(resolve(boxRoot));
  const candidate=resolve(filename);
  if(!inside(root,candidate))throw Error('Sandbox output candidate outside sandbox container');
  const rel=relative(root,candidate);
  let walk=root;
  for(const seg of safeSegments(rel)) {
    walk=join(walk,seg);
    const st=lstatSync(walk);
    if(st.isSymbolicLink())throw Error('Sandbox output contains a symbolic link / junction');
  }
  const actual=realpathSync(candidate);
  if(!inside(root,actual))throw Error('Sandbox output resolves outside sandbox container');
  const stat=lstatSync(candidate);
  if(!stat.isFile()||stat.size<2||stat.size>MAX_ENVELOPE_BYTES)throw Error('Sandbox result is not a bounded regular file');
  return readFileSync(candidate,'utf8');
}
/** Fails closed on no file, multiple files, wrong id/nonce, invalid JSON, or unsafe path. */
export function recoverSandboxEnvelope(boxRoot:string,logicalPath:string,profileRoot:string,taskId:string,nonce:string):{envelope:SandboxEnvelope;physicalPath:string} {
  const candidates=sandboxOutputCandidates(boxRoot,logicalPath,profileRoot);
  // A logical sandbox write appearing directly on the host indicates a dangerous
  // Direct/Open file-access rule. Do not accept it as a valid sandbox result.
  if(existsSync(logicalPath))throw Error('Unsafe sandbox policy: result appeared in host working directory');
  const existing=candidates.filter(existsSync);
  if(existing.length!==1)throw Error(`Expected one virtualized result; found ${existing.length}. Check SANDBOXIE_BOX_ROOT and Sandboxie user/current vs drive layout. Locations: ${candidates.join(' | ')}`);
  const text=readPlainFileInside(boxRoot,existing[0]);
  let value:unknown;
  try{value=JSON.parse(text);}catch{throw Error('Sandbox result is not valid JSON');}
  if(!value||typeof value!=='object')throw Error('Sandbox result envelope must be an object');
  const env=value as Record<string,unknown>;
  if(env.task_id!==taskId||env.nonce!==nonce||typeof env.ok!=='boolean')throw Error('Sandbox result task/nonce mismatch');
  if(env.ok===true&&!Object.prototype.hasOwnProperty.call(env,'result'))throw Error('Sandbox success envelope missing result');
  if(env.ok===false&&typeof env.error!=='string')throw Error('Sandbox error envelope missing error');
  if(env.ok===false)env.error=(env.error as string).slice(0,500);
  return {envelope:env as SandboxEnvelope,physicalPath:existing[0]};
}
/** Remove only the one verified result. No directories and no recursive deletion. */
export function removeRecoveredSandboxEnvelope(physicalPath:string):void { unlinkSync(physicalPath); }
