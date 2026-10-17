/** Bounded workspace operations. Never intentionally follow symlinks/reparse points. */
import {realpathSync, lstatSync, readdirSync, readFileSync, writeFileSync, renameSync, rmSync, openSync, closeSync, statfsSync} from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import type {Config} from './config.ts';
const MAX_TEXT=128*1024;
function within(root:string, target:string){
  const relative=path.relative(root,target);
  return relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative));
}
export function workspaceRoot(c:Config):string {return realpathSync(c.workspaceRoot);}
export function workspacePath(c:Config,input='.',existing=true):string {
  if(typeof input!=='string'||!input||input.includes('\0')||path.isAbsolute(input)||input.length>2048)throw Error('Path must be a relative workspace path');
  const root=workspaceRoot(c), full=path.resolve(root,input);
  if(!within(root,full))throw Error('Path escapes workspace');
  const rel=path.relative(root,full);
  let cur=root;
  for(const component of rel.split(path.sep).filter(Boolean)){
    cur=path.join(cur,component);
    let stat;
    try{stat=lstatSync(cur);}catch(e:any){if(e?.code==='ENOENT'&&!existing&&cur===full)break;throw e;}
    if(stat.isSymbolicLink())throw Error('Symbolic links/reparse points are denied');
    // Windows junctions are exposed to Node as symlinks. Refuse unexpected re-rooting.
    const real=realpathSync(cur);
    if(!within(root,real))throw Error('Path resolves outside workspace');
  }
  return full;
}
export function fsList(c:Config,input='.'){
  const folder=workspacePath(c,input);
  if(!lstatSync(folder).isDirectory())throw Error('Not a directory');
  return readdirSync(folder,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).slice(0,200).map(e=>{
    const p=path.join(folder,e.name);
    const st=lstatSync(p);
    return {name:e.name,type:st.isSymbolicLink()?'symlink':st.isDirectory()?'directory':'file',size:st.isFile()?st.size:null};
  });
}
export function fsRead(c:Config,input:string){
  const target=workspacePath(c,input),st=lstatSync(target);
  if(!st.isFile()||st.size>MAX_TEXT)throw Error('File missing or exceeds 128 KiB');
  const bytes=readFileSync(target);
  if(bytes.length>MAX_TEXT)throw Error('File exceeds 128 KiB');
  const result=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  return result;
}
export function fsWrite(c:Config,input:string,content:string){
  if(typeof content!=='string')throw Error('UTF-8 content required');
  const buf=Buffer.from(content,'utf8');if(buf.length>MAX_TEXT)throw Error('Content exceeds 128 KiB');
  const target=workspacePath(c,input,false),parent=workspacePath(c,path.dirname(input));
  if(!lstatSync(parent).isDirectory())throw Error('Destination parent not a directory');
  let exists=false;try{const st=lstatSync(target);exists=true;if(!st.isFile())throw Error('Destination not a regular file');}catch(e:any){if(e?.code!=='ENOENT')throw e;}
  const tmp=path.join(parent,'.asterline-'+randomBytes(12).toString('hex')+'.tmp');
  let fd:number|undefined;
  try{fd=openSync(tmp,'wx',0o600);writeFileSync(fd,buf);closeSync(fd);fd=undefined;
    // Guard against newly introduced symlinks between resolution and commit.
    workspacePath(c,path.dirname(input));if(exists)workspacePath(c,input);
    renameSync(tmp,target);
  }finally{if(fd!==undefined)closeSync(fd);rmSync(tmp,{force:true});}
  return {path:input,bytes:buf.length};
}
export function diskInfo(c:Config){const s=statfsSync(workspaceRoot(c),{bigint:true});return {disk_total_bytes:(s.blocks*s.bsize).toString(),disk_free_bytes:(s.bavail*s.bsize).toString()};}
