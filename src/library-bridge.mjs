/** Asterline Library Bridge — persistent local transfer spool, no ChatGPT cookies/API tokens. */
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {Readable,Transform} from 'node:stream';
import {isIP} from 'node:net';

/** Official ChatGPT/OpenAI host family, apex and subdomains. Does not authorize arbitrary CDNs. */
export const DEFAULT_LIBRARY_FILE_HOSTS='oaiusercontent.com,*.oaiusercontent.com,chatgpt.com,*.chatgpt.com,openai.com,*.openai.com,oaistatic.com,*.oaistatic.com';
export function normalizeLibraryHosts(input){
 const entries=String(input||'').split(/[,\r\n]+/).map(x=>x.trim().toLowerCase()).filter(Boolean);
 if(!entries.length||entries.length>30)throw Error('Need 1–30 Library download host patterns');
 const normalized=[];
 for(const host of entries){
  const wild=host.startsWith('*.');const domain=wild?host.slice(2):host;
  if(domain.length>253||domain.split('.').length<2||isIP(domain)||/\.(?:local|localhost|internal|lan|home|test|invalid|arpa)$/.test(domain)||
   !domain.split('.').every(label=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))throw Error('Invalid public Library domain pattern: '+host.slice(0,120));
  if(!normalized.includes(host))normalized.push(host);
 }
 return normalized.join(',');
}


export const MAX_OUTBOUND=16*1024*1024; // bounded UI chunking (not a general-purpose bulk-upload protocol)
export const MAX_INBOUND=32*1024*1024;
export const CHUNK=96*1024;
const stateFile='index.json';
const validId=s=>typeof s==='string'&&/^[0-9a-f-]{36}$/.test(s);
const sha256=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const parseOwner=o=>{if(typeof o!=='string'||!/^\S+@\S+\.\S+$/.test(o)||o.length>255)throw Error('A verified email owner is required');return o.toLowerCase();};
const cleanName=name=>{if(typeof name!=='string'||!name||name.length>180||name==='.'||name==='..'||/[\\/:*?"<>|\x00-\x1f]/.test(name)||/[. ]$/.test(name)||/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name))throw Error('Invalid filename');return name;};
function atomicJson(file,obj){const temp=file+'.'+randomUUID()+'.tmp';fs.writeFileSync(temp,JSON.stringify(obj,null,2),{flag:'wx',mode:0o600});fs.renameSync(temp,file);}
function checkedDir(parent){fs.mkdirSync(parent,{recursive:true,mode:0o700});if(fs.lstatSync(parent).isSymbolicLink())throw Error('Symlink transfer directory denied');}
export class LibraryBridge {
 constructor(data,{maxOutbound=MAX_OUTBOUND,maxInbound=MAX_INBOUND}={}){
   this.root=path.resolve(data,'library-bridge');this.out=path.join(this.root,'out');this.in=path.join(this.root,'in');this.maxOutbound=maxOutbound;this.maxInbound=maxInbound;
   for(const p of [this.root,this.out,this.in])checkedDir(p);
   this.index=path.join(this.root,stateFile);if(!fs.existsSync(this.index))atomicJson(this.index,{schema:1,jobs:[]});
 }
 load(){const data=JSON.parse(fs.readFileSync(this.index,'utf8'));if(data.schema!==1||!Array.isArray(data.jobs))throw Error('Transfer registry version mismatch');return data;}
 save(data){atomicJson(this.index,data);}
 mutate(fn){
  const lock=this.index+'.lock',start=Date.now();let fd;
  while(fd===undefined){try{fd=fs.openSync(lock,'wx',0o600);}catch(e){if(e.code!=='EEXIST')throw e;if(Date.now()-start>2500)throw Error('Library transfer queue locked, retry later');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30);}}
  try{const db=this.load(),result=fn(db);this.save(db);return result;}finally{fs.closeSync(fd);fs.rmSync(lock,{force:true});}
 }
 assertOwner(owner){return parseOwner(owner);}
 get(id,owner){if(!validId(id))throw Error('Invalid transfer ID');const job=this.load().jobs.find(j=>j.id===id&&j.owner===this.assertOwner(owner));if(!job)throw Error('Transfer not found');return job;}
 list(owner){const o=this.assertOwner(owner);return this.load().jobs.filter(j=>j.owner===o).map(({id,direction,name,size,sha256,created,state,fileId})=>({id,direction,name,size,sha256,created,state,...(fileId?{fileId}:{})}));}
 stagePush(localFile,owner){
   const o=this.assertOwner(owner),src=path.resolve(localFile),name=cleanName(path.basename(src));
   // Read through an opened descriptor. Do not copy by source pathname after checking it:
   // otherwise an attacker modifying a writable workspace could swap a symlink mid-copy.
   const before=fs.lstatSync(src);
   if(!before.isFile()||before.isSymbolicLink()||before.size<0||before.size>this.maxOutbound)throw Error(`Only regular files up to ${this.maxOutbound} bytes are supported for Library exports`);
   const sourceFd=fs.openSync(src,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
   const id=randomUUID(),dst=path.join(this.out,id);let destinationFd,bytes=0;
   try{
     const opened=fs.fstatSync(sourceFd);
     if(!opened.isFile()||opened.dev!==before.dev||opened.ino!==before.ino||opened.size>this.maxOutbound)throw Error('Source changed during staging');
     destinationFd=fs.openSync(dst,'wx',0o600);
     const block=Buffer.alloc(64*1024);
     while(true){const n=fs.readSync(sourceFd,block,0,block.length,null);if(!n)break;bytes+=n;if(bytes>this.maxOutbound)throw Error('Source file grew beyond transfer limit');let off=0;while(off<n)off+=fs.writeSync(destinationFd,block,off,n-off);}
     const after=fs.fstatSync(sourceFd);
     if(after.size!==bytes||after.size!==opened.size||after.mtimeMs!==opened.mtimeMs)throw Error('Source changed during staging');
     fs.closeSync(destinationFd);destinationFd=undefined;
     const job={id,direction:'to_chatgpt',owner:o,name,size:bytes,sha256:sha256(dst),created:Date.now(),state:'waiting_user'};
     this.mutate(db=>db.jobs.push(job));return job;
   }catch(e){
     if(destinationFd!==undefined){try{fs.closeSync(destinationFd);}catch{}destinationFd=undefined;}
     fs.rmSync(dst,{force:true});throw e;
   }finally{fs.closeSync(sourceFd);if(destinationFd!==undefined)fs.closeSync(destinationFd);}
 }
 chunk(id,owner,offset=0){const job=this.get(id,owner);if(job.direction!=='to_chatgpt'||job.state!=='waiting_user')throw Error('Not an outstanding upload');if(!Number.isSafeInteger(offset)||offset<0||offset>job.size||offset%CHUNK!==0)throw Error('Invalid chunk offset');
   const p=path.join(this.out,id);const f=fs.openSync(p,'r');try{const bytes=Buffer.alloc(Math.min(CHUNK,job.size-offset));const n=fs.readSync(f,bytes,0,bytes.length,offset);return {id,offset,bytes:n,base64:bytes.subarray(0,n).toString('base64'),total:job.size,sha256:job.sha256,name:job.name};}finally{fs.closeSync(f);}
 }
 markUploaded(id,owner,fileId){if(!/^file_[\w-]{6,160}$/.test(fileId||''))throw Error('Invalid ChatGPT file id');return this.mutate(db=>{const job=db.jobs.find(j=>j.id===id&&j.owner===this.assertOwner(owner));if(!job||job.direction!=='to_chatgpt'||job.state!=='waiting_user')throw Error('Transfer not awaiting upload');job.state='client_reported_uploaded';job.fileId=fileId;job.finished=Date.now();return {id,state:job.state,fileId};});}
 // No external URL enters this method without an explicit public-domain allowlist.
 async importLibraryFile(owner,file,{allowedHosts=[],fetchImpl=fetch}={}){
   const o=this.assertOwner(owner),id=randomUUID(),name=cleanName(file.file_name||`${file.file_id}.bin`),url=validateLibraryUrl(file.download_url,allowedHosts),temp=path.join(this.in,id+'.part'),out=path.join(this.in,id);
   const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),90000);let size=0,digest=createHash('sha256'),maxInbound=this.maxInbound;
   try{
    const r=await fetchImpl(url,{method:'GET',redirect:'manual',signal:controller.signal,headers:{Accept:'application/octet-stream'}});
    if(r.status!==200||!r.body)throw Error(`ChatGPT download failed (HTTP ${r.status})`);
    const n=Number(r.headers.get('content-length')||0);if(n>this.maxInbound)throw Error('Remote file exceeds configured size limit');
    const sink=fs.createWriteStream(temp,{flags:'wx',mode:0o600});
    await pipeline(Readable.fromWeb(r.body),new Transform({transform(chunk,_,done){size+=chunk.length;if(size>maxInbound)return done(Error('File exceeds download limit'));digest.update(chunk);done(null,chunk);}}),sink); // size checked on streaming bytes
    fs.renameSync(temp,out);
    const job={id,direction:'from_chatgpt',owner:o,name,size,sha256:digest.digest('hex'),created:Date.now(),state:'ready_for_cli',fileId:String(file.file_id).slice(0,170)};
    this.mutate(db=>db.jobs.push(job));return {id,name,size,sha256:job.sha256,state:job.state};
   }catch(e){fs.rmSync(temp,{force:true});fs.rmSync(out,{force:true});throw e;}finally{clearTimeout(timer);}
 }
 pull(id,owner,destinationDir){const job=this.get(id,owner);if(job.direction!=='from_chatgpt'||job.state!=='ready_for_cli')throw Error('No downloaded Library file available');
  const targetRoot=path.resolve(destinationDir),target=path.join(targetRoot,cleanName(job.name));if(!fs.statSync(targetRoot).isDirectory()||fs.lstatSync(targetRoot).isSymbolicLink())throw Error('Output must be a real directory');if(fs.existsSync(target))throw Error('Destination already exists; refusing overwrite');
  const src=path.join(this.in,id);if(!fs.lstatSync(src).isFile()||sha256(src)!==job.sha256)throw Error('Downloaded file integrity failed');fs.copyFileSync(src,target,fs.constants.COPYFILE_EXCL);return {file:target,sha256:job.sha256,size:job.size};
 }
}
// Additional file download URL hosts are admin-configured (not supplied by Agent or widget).
export function validateLibraryUrl(input,allowedHosts){
 let u;try{u=new URL(input);}catch{throw Error('Invalid ChatGPT download URL');}
 if(u.protocol!=='https:'||u.username||u.password||u.port||!u.hostname.includes('.'))throw Error('HTTPS public host required');
 const h=u.hostname.toLowerCase();
 if(isIP(h)||!/^\w[\w.-]*$/.test(h)||h.endsWith('.local')||h.endsWith('.internal'))throw Error('Unsafe hostname');
 const hosts=normalizeLibraryHosts(allowedHosts.join(',')).split(',');
 // Wildcards include the apex, to preserve compatibility with v1.8/v1.9 .env values.
 const allowed=hosts.some(s=>s.startsWith('*.')?(h===s.slice(2)||h.endsWith('.'+s.slice(2))):h===s);
 if(!allowed)throw Error(`Download host not on configured OpenAI file-domain allowlist (hostname: ${h}). Set this exact host in Admin → 工具设置 → Library 下载域名 after verifying its provider. Do not share the signed URL.`);
 return u.toString();
}
