import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { Config } from './config.ts';

export type Manifest={id:string;name:string;description:string;entry:'javascript';dependencies:Record<string,string>;tool:{name:string;description:string;requireApproval:boolean}};
const ID=/^[a-z][a-z0-9_-]{2,47}$/;
const PACKAGE=/^(?:@[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*|[a-z0-9][\w.-]*)$/;
// A numeric, pinned release; no npm ranges, tags, aliases, git, file, URL, prereleases.
const PIN=/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/;
export function validateManifest(raw:unknown):Manifest {
  if(!raw || typeof raw!=='object') throw Error('Expected manifest object');
  const m=raw as Record<string,any>;
  if(!ID.test(m.id)||!ID.test(m.tool?.name)) throw Error('Invalid plugin or tool ID');
  if(!['javascript'].includes(m.entry)||typeof m.name!=='string'||m.name.length>80||typeof m.description!=='string'||m.description.length>500) throw Error('Invalid manifest');
  if(typeof m.tool.description!=='string'||m.tool.description.length>500 ||typeof m.tool.requireApproval!=='boolean') throw Error('Explicit approval policy required');
  if(m.tool.requireApproval!==true)throw Error('Plugin execution requires per-call mobile approval in this preview');
  const deps=m.dependencies;
  if(!deps||typeof deps!=='object'||Array.isArray(deps)||Object.keys(deps).length>12) throw Error('Invalid dependency map');
  for(const [name,version] of Object.entries(deps)) if(!PACKAGE.test(name)||typeof version!=='string'||!PIN.test(version)) throw Error(`Dependency must pin an exact registry version: ${name}`);
  return {id:m.id,name:m.name,description:m.description,entry:'javascript',dependencies:deps,tool:m.tool};
}
export function validateSource(code:string) {if(typeof code!=='string'||code.length<1||code.length>64000||code.includes('\u0000')) throw Error('Invalid source length');}
export function canonical(obj:unknown):string {
  if(Array.isArray(obj)) return '['+obj.map(canonical).join(',')+']';
  if(obj && typeof obj==='object') return '{'+Object.keys(obj).sort().map(k=>JSON.stringify(k)+':'+canonical((obj as Record<string,unknown>)[k])).join(',')+'}';
  return JSON.stringify(obj);
}
export const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
export const paramsHash=(p:unknown)=>hash(canonical(p));
export function verifyAdminBasic(h:string|undefined,pw:string):boolean {
  if(pw.length<20||!h?.startsWith('Basic '))return false;
  let credentials=''; try{credentials=Buffer.from(h.slice(6),'base64').toString('utf8');}catch{return false;}
  const pos=credentials.indexOf(':');if(pos<0||credentials.slice(0,pos)!=='admin')return false;
  const a=Buffer.from(credentials.slice(pos+1)),b=Buffer.from(pw);
  return a.length===b.length&&timingSafeEqual(a,b);
}
export function checkOrigin(h:Record<string,string|string[]|undefined>,host:string) {
  const origin=h['origin'];const referer=h['referer'];
  if(typeof origin==='string') {if(origin==='null')return false;try{return new URL(origin).host===host&&new URL(origin).protocol===(host.startsWith('127.')||host.startsWith('localhost')?'http:':'https:');}catch{return false;}}
  if(typeof referer==='string') {try{const u=new URL(referer);return u.host===host&&u.protocol===(host.startsWith('127.')||host.startsWith('localhost')?'http:':'https:');}catch{return false;}}
  return false;
}
export function safeGotifyUrl(url:string){try{const x=new URL(url);return x.protocol==='http:' && (x.hostname==='127.0.0.1'||x.hostname==='localhost'||x.hostname==='[::1]')&&!x.username&&!x.password&&!x.search&&!x.hash;}catch{return false;}}
export function isPublicHostCorrect(host:string|undefined,c:Config){return host===c.publicHost;}
