#!/usr/bin/env node
/** Asterline Library CLI. No ChatGPT session cookies and no private ChatGPT API. */
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {LibraryBridge} from '../src/library-bridge.mjs';
import {DatabaseSync} from 'node:sqlite';
const loadEnv=()=>{const f=path.resolve('.env');if(!fs.existsSync(f))return;for(const line of fs.readFileSync(f,'utf8').split(/\r?\n/)){const m=/^\s*([A-Z][A-Z0-9_]*)=(.*)\s*$/.exec(line);if(m&&process.env[m[1]]===undefined)process.env[m[1]]=m[2].trim().replace(/^(\"|')(.*)\1$/,'$2');}};
loadEnv();
const [mode,op,...rest]=process.argv.slice(2);
function opt(name,fallback=''){const p=rest.indexOf(name);return p>=0?rest[p+1]??'':fallback;}
const positional=rest.filter((a,i)=>!(a.startsWith('--')||a==='-o'||(i>0&&['--owner','--to','--direction','-o'].includes(rest[i-1]))));
function owner(){const allowed=(process.env.MCP_ALLOWED_EMAILS||'').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean);const requested=opt('--owner',process.env.LIBRARY_OWNER_EMAIL|| (allowed.length===1?allowed[0]:'' )).toLowerCase();if(!requested||!allowed.includes(requested))throw Error('Specify --owner <email>, which must appear in MCP_ALLOWED_EMAILS');return requested;}
function print(o){process.stdout.write((typeof o==='string'?o:JSON.stringify(o,null,2))+'\n');}
const data=path.resolve(process.env.MCP_DATA_DIR||'.state-node');
const bridge=()=>new LibraryBridge(data);
function configured(name,fallback){
  const dbFile=path.join(data,'asterline.sqlite3');if(!fs.existsSync(dbFile))return fallback;
  let db;try{db=new DatabaseSync(dbFile,{readOnly:true});
    const row=db.prepare('SELECT value FROM js_runtime_settings WHERE name=?').get(name);return row?.value??fallback;
  }catch(e){if(/no such table/i.test(String(e)))return fallback;throw e;}
  finally{db?.close();}
}
function relative(name){if(typeof name!=='string'||!name||path.isAbsolute(name)||/^[A-Za-z]:/.test(name)||name.includes('\\')||name.includes(':')||name.includes('\0')||name.split('/').some(p=>!p||p==='.'||p==='..'))throw Error('Cloud path must be relative without traversal');return name;}
function cloudConfig(){const remote=configured('rcloneRemote',process.env.LIBRARY_RCLONE_REMOTE||''),local=path.resolve(configured('rcloneLocal',process.env.LIBRARY_CLOUD_LOCAL_ROOT||'library-sync'));if(!/^[\w-]+:[^\r\n]*$/.test(remote)||!remote.split(':',2)[1])throw Error('Open mcpadmin /settings and configure the rclone remote (e.g. gdrive:Asterline)');const exe=configured('rcloneExe',process.env.LIBRARY_RCLONE_EXE||'rclone');return {remote:remote.replace(/\/$/,''),local,exe};}
function rclone(args){const {exe}=cloudConfig();const r=spawnSync(exe,args,{shell:false,encoding:'utf8',timeout:30*60*1000,maxBuffer:1024*1024,windowsHide:true,stdio:['ignore','pipe','pipe']});if(r.error)throw r.error;process.stdout.write((r.stdout||'').slice(0,100000));if(r.status!==0)throw Error(`rclone exited ${r.status}: ${(r.stderr||'').slice(0,1500)}`);return r.status;}
function runCloud(){const c=cloudConfig();const flags=['--transfers','2','--checkers','4','--stats-one-line','--exclude','**/.env','--exclude','**/.env.*','--exclude','**/.state-node/**'];
 if(op==='ls')return rclone(['lsf',c.remote,'--max-depth','2']);
 if(op==='push'){const src=path.resolve(positional[0]||'');if(!fs.existsSync(src)||!fs.statSync(src).isFile())throw Error('Local source file not found');const key=relative(opt('--to',path.basename(src)));return rclone(['copyto',src,c.remote+'/'+key,...flags]);}
 if(op==='pull'){const key=relative(positional[0]);const dir=path.resolve(opt('-o','.'));if(!fs.statSync(dir).isDirectory())throw Error('Destination directory missing');const dest=path.join(dir,path.basename(key));if(fs.existsSync(dest))throw Error('Destination exists; refusing overwrite');return rclone(['copyto',c.remote+'/'+key,dest,...flags]);}
 if(op==='sync'){const dir=path.resolve(c.local);if(!fs.existsSync(dir))fs.mkdirSync(dir,{recursive:true});if(fs.lstatSync(dir).isSymbolicLink())throw Error('Symlink sync root denied');const direction=opt('--direction','up');if(!['up','down'].includes(direction))throw Error('Use --direction up|down');const source=direction==='up'?dir:c.remote,dest=direction==='up'?c.remote:dir;return rclone(['copy',source,dest,...flags,...(rest.includes('--dry-run')?['--dry-run']:[])]);}
 throw Error('cloud commands: ls | push <file> [--to relative/name] | pull <remote/key> [-o folder] | sync [--direction up|down] [--dry-run]');
}
try{
 if(mode==='cloud')runCloud();
 else if(mode==='library'){
  if(op==='push')print(bridge().stagePush(positional[0],owner()));
  else if(op==='jobs')print(bridge().list(owner()));
  else if(op==='pull')print(bridge().pull(positional[0],owner(),opt('-o','.')));
  else throw Error('library commands: push <file> [--owner email] | jobs [--owner email] | pull <transfer-id> [-o folder]');
 }else print('Asterline Library Bridge\n  node scripts/library-cli.mjs library push ./file.zip\n  node scripts/library-cli.mjs library jobs\n  node scripts/library-cli.mjs library pull <transfer-id> -o ./downloads\n  node scripts/library-cli.mjs cloud ls\n  node scripts/library-cli.mjs cloud push ./file.zip --to folder/file.zip\n  node scripts/library-cli.mjs cloud pull folder/file.zip -o ./downloads\n  node scripts/library-cli.mjs cloud sync --direction up --dry-run');
}catch(e){console.error('Error:',e.message);process.exitCode=1;}
