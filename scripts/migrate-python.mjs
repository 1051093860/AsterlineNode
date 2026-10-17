/** Read-only Python v1.5 SQLite -> archived Node metadata; no privileges migrate. */
import {DatabaseSync} from 'node:sqlite';
import {existsSync,mkdirSync,copyFileSync} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
const arg=(name)=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1];};
const source=arg('--source'),dest=arg('--dest'),apply=process.argv.includes('--apply');
if(!source||!dest){console.error('Usage: node scripts/migrate-python.mjs --source <Python .state/asterline.sqlite3> --dest <Node .state-node/asterline.sqlite3> [--apply]');process.exit(2);}
const src=path.resolve(source),dst=path.resolve(dest);
if(!existsSync(src)||src===dst){console.error('Source must exist and differ from destination');process.exit(2);}
const old=new DatabaseSync(src,{readOnly:true});
const tables=new Set(old.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name));
const list=['jobs','audit','tool_plugins','approvals','notifications','settings'];
const counts=Object.fromEntries(list.map(t=>[t,tables.has(t)?old.prepare(`SELECT count(*) AS n FROM ${t}`).get().n:0]));
console.log(JSON.stringify({source:src,destination:dst,mode:apply?'apply':'dry-run',counts,notes:['No high-risk switches or grants imported','Old Python plugins archived, not executable JS releases','Old approvals archived, never reactivated','Pending notifications archived, not resent']},null,2));
if(!apply){old.close();console.log('Dry run only. Add --apply after backing up Node .state-node.');process.exit(0);}
if(!existsSync(dst)){old.close();console.error('Destination Node DB must already exist (start Node v1.7 once), then stop the service before migration.');process.exit(2);}
const backup=dst+'.backup-'+new Date().toISOString().replace(/[:.]/g,'-');copyFileSync(dst,backup);console.log('Node backup:',backup);
const neo=new DatabaseSync(dst);neo.exec('PRAGMA busy_timeout=5000;');
neo.exec(`CREATE TABLE IF NOT EXISTS js_legacy_jobs(id TEXT PRIMARY KEY,source TEXT NOT NULL,payload TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS js_legacy_plugins(id TEXT PRIMARY KEY,source TEXT NOT NULL,payload TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS js_legacy_notifications(id TEXT PRIMARY KEY,source TEXT NOT NULL,payload TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS js_legacy_events(id TEXT PRIMARY KEY,source TEXT NOT NULL,payload TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS js_legacy_settings(name TEXT PRIMARY KEY,value TEXT NOT NULL);`);
const targets={jobs:'js_legacy_jobs',tool_plugins:'js_legacy_plugins',notifications:'js_legacy_notifications',audit:'js_legacy_events',approvals:'js_legacy_events'};
let imported=0;
try{neo.exec('BEGIN IMMEDIATE');
 for(const [table,target] of Object.entries(targets)){
   if(!tables.has(table))continue;
   const insert=neo.prepare(`INSERT OR IGNORE INTO ${target}(id,source,payload) VALUES(?,?,?)`);
   for(const row of old.prepare(`SELECT * FROM ${table}`).iterate()){
     const id=table+':'+String(row.id ?? randomUUID());
     // Avoid duplicating potentially sensitive data in a visible migration log.
     imported+=insert.run(id,table,JSON.stringify(row)).changes;
   }
 }
 if(tables.has('settings')){
   const insert=neo.prepare('INSERT OR IGNORE INTO js_legacy_settings(name,value) VALUES(?,?)');
   for(const r of old.prepare('SELECT name,value FROM settings').iterate())imported+=insert.run(r.name,r.value).changes;
 }
 neo.exec('COMMIT');
 console.log(JSON.stringify({imported,backup,reminder:'js_settings remain default-deny for file_write, command_exec and notify_manual; active Python tool plugins are NOT executed.'}));
}catch(e){try{neo.exec('ROLLBACK');}catch{}console.error(String(e));process.exitCode=1;}
finally{old.close();neo.close();}
