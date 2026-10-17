#!/usr/bin/env node
import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';import {DatabaseSync} from 'node:sqlite';
const f=path.resolve('.env');if(fs.existsSync(f))for(const l of fs.readFileSync(f,'utf8').split(/\r?\n/)){const m=/^\s*([A-Z][A-Z0-9_]*)=(.*)\s*$/.exec(l);if(m&&process.env[m[1]]===undefined)process.env[m[1]]=m[2].trim().replace(/^("|')(.*)\1$/,'$2');}
const emit=(ok,name,detail)=>console.log(`${ok?'[OK]':'[WARN]'} ${name}: ${detail}`);
const allowed=(process.env.MCP_ALLOWED_EMAILS||'').split(',').map(x=>x.trim()).filter(Boolean);
emit(Number(process.versions.node.split('.')[0])>=24,'Node',process.version+' (project requires 24.12+)');
emit(allowed.length>0,'Library identities',allowed.length+' allowlisted identities (email values omitted)');
const data=path.resolve(process.env.MCP_DATA_DIR||'.state-node');
emit(!fs.existsSync(data)||fs.statSync(data).isDirectory(),'State directory',data);
const host=(process.env.LIBRARY_FILE_HOSTS||'oaiusercontent.com,*.oaiusercontent.com,chatgpt.com,*.chatgpt.com,openai.com,*.openai.com,oaistatic.com,*.oaistatic.com').split(',').filter(Boolean);
emit(host.length>0,'Library download host allowlist',host.length+' rule(s)');
const configured=(key, fallback)=>{const f=path.join(data,'asterline.sqlite3');if(!fs.existsSync(f))return fallback;let db;try{db=new DatabaseSync(f,{readOnly:true});return db.prepare('SELECT value FROM js_runtime_settings WHERE name=?').get(key)?.value??fallback;}catch(e){if(/no such table/i.test(String(e)))return fallback;throw e;}finally{db?.close();}};
const remote=configured('rcloneRemote',process.env.LIBRARY_RCLONE_REMOTE||'');
emit(/^\w[\w-]*:.+/.test(remote),'rclone remote',remote?'configured (name omitted)':'not configured');
const r=spawnSync(configured('rcloneExe',process.env.LIBRARY_RCLONE_EXE||'rclone'),['version'],{encoding:'utf8',timeout:5000,windowsHide:true});
emit(r.status===0,'rclone executable',r.status===0?(r.stdout||'').split('\n')[0]:'missing, not in PATH, or failed');
console.log('ChatGPT native Library helpers are available only inside a ChatGPT plugin widget and must be tested interactively.');
