import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export type PluginState = 'draft' | 'reviewed' | 'installed' | 'active' | 'disabled' | 'rejected';
export interface PluginRecord { id:string; name:string; owner:string; manifest:string; source:string; state:PluginState; report:string | null; digest:string; revision:number; updated:string; }
export class Store {
  db: DatabaseSync;
  constructor(dir:string) {
    mkdirSync(dir, {recursive:true});
    this.db = new DatabaseSync(path.join(dir, 'asterline.sqlite3'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS js_plugins(id TEXT PRIMARY KEY, name TEXT NOT NULL, owner TEXT NOT NULL,
        manifest TEXT NOT NULL, source TEXT NOT NULL, state TEXT NOT NULL, report TEXT,
        digest TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, updated TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS js_approvals(id TEXT PRIMARY KEY, owner TEXT NOT NULL, plugin TEXT NOT NULL,
        params_hash TEXT NOT NULL, params TEXT NOT NULL, reason TEXT NOT NULL, state TEXT NOT NULL,
        created INTEGER NOT NULL, expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS js_runs(id TEXT PRIMARY KEY, owner TEXT NOT NULL, plugin TEXT NOT NULL,
        state TEXT NOT NULL, started INTEGER NOT NULL, finished INTEGER, exit_code INTEGER,
        output TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS js_audit(id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL,
        actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS js_permission_leases (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, plugin TEXT NOT NULL,
        actor TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL,
        revoked INTEGER DEFAULT NULL,
        CHECK(expires = created + 3600000)
      );
      CREATE INDEX IF NOT EXISTS idx_permission_leases_active ON js_permission_leases(owner,plugin,expires);
      CREATE TABLE IF NOT EXISTS js_host_direct_leases (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, actor TEXT NOT NULL,
        created INTEGER NOT NULL, expires INTEGER NOT NULL, revoked INTEGER DEFAULT NULL,
        CHECK(expires = created + 3600000)
      );
      CREATE INDEX IF NOT EXISTS idx_host_direct_owner_expires ON js_host_direct_leases(owner,expires);
      CREATE TABLE IF NOT EXISTS js_work_requests (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, agent_label TEXT NOT NULL,
        title TEXT NOT NULL, workspace TEXT NOT NULL, capabilities TEXT NOT NULL,
        reason TEXT NOT NULL, state TEXT NOT NULL, created INTEGER NOT NULL,
        expires INTEGER NOT NULL, decided INTEGER DEFAULT NULL, actor TEXT DEFAULT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_js_work_req_state ON js_work_requests(state,expires);
      CREATE TABLE IF NOT EXISTS js_work_sessions (
        id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, owner TEXT NOT NULL,
        title TEXT NOT NULL, workspace TEXT NOT NULL, capabilities TEXT NOT NULL,
        actor TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL,
        revoked INTEGER DEFAULT NULL,
        CHECK(expires = created + 3600000)
      );
      CREATE INDEX IF NOT EXISTS idx_js_work_sessions_owner ON js_work_sessions(owner,expires);
      CREATE TABLE IF NOT EXISTS js_settings(name TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS js_runtime_settings(name TEXT PRIMARY KEY,value TEXT NOT NULL,updated INTEGER NOT NULL);
      INSERT OR IGNORE INTO js_settings(name,value) VALUES
        ('file_write','0'),('command_exec','0'),('notify_task_start','1'),
        ('notify_task_end','1'),('notify_manual','0'),('approval_required','1');
      CREATE TABLE IF NOT EXISTS js_jobs(id TEXT PRIMARY KEY,owner TEXT NOT NULL,command TEXT NOT NULL,
        cwd TEXT NOT NULL,state TEXT NOT NULL,pid INTEGER,exit_code INTEGER,
        started INTEGER NOT NULL,finished INTEGER,log_path TEXT NOT NULL DEFAULT '',label TEXT NOT NULL DEFAULT '');
      CREATE INDEX IF NOT EXISTS idx_js_jobs_owner ON js_jobs(owner,started);
      CREATE TABLE IF NOT EXISTS js_notifications(id INTEGER PRIMARY KEY AUTOINCREMENT,
        event TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,priority INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,
        created INTEGER NOT NULL,sent_at INTEGER,next_attempt INTEGER NOT NULL,last_error TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS js_legacy_jobs(id TEXT PRIMARY KEY,source TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS js_legacy_plugins(id TEXT PRIMARY KEY,source TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS js_legacy_notifications(id TEXT PRIMARY KEY,source TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS js_meta(name TEXT PRIMARY KEY,value TEXT NOT NULL);
      INSERT OR IGNORE INTO js_meta(name,value) VALUES('catalog_revision','0');`);
    this.db.exec("UPDATE js_jobs SET state='lost',finished=strftime('%s','now')*1000 WHERE state='running'; UPDATE js_notifications SET state='pending' WHERE state='sending';");
  }
  runtimeSettings():Record<string,string> {
    return Object.fromEntries((this.db.prepare('SELECT name,value FROM js_runtime_settings').all() as {name:string;value:string}[]).map(x=>[x.name,x.value]));
  }
  runtimeSetting(key:string):string|undefined{
    return (this.db.prepare('SELECT value FROM js_runtime_settings WHERE name=?').get(key) as {value:string}|undefined)?.value;
  }
  setRuntimeSetting(key:string,value:string,actor='admin'){
    this.db.prepare('INSERT INTO js_runtime_settings(name,value,updated) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value,updated=excluded.updated').run(key,value,Date.now());
    this.audit(actor,'runtime_setting_changed',key); // never log potentially sensitive paths or values
  }
  flag(name:string):boolean {
    if(!['file_write','command_exec','notify_task_start','notify_task_end','notify_manual','approval_required'].includes(name))throw Error('Invalid flag');
    return (this.db.prepare('SELECT value FROM js_settings WHERE name=?').get(name) as {value:string}|undefined)?.value==='1';
  }
  setFlag(name:string,value:boolean,actor='admin'){
    if(!['file_write','command_exec','notify_task_start','notify_task_end','notify_manual','approval_required'].includes(name))throw Error('Invalid flag');
    this.db.prepare('UPDATE js_settings SET value=? WHERE name=?').run(value?'1':'0',name);
    this.audit(actor,'setting_changed',name+'='+Number(value));
  }
  newJob(owner:string,command:string,cwd:string,label:string){const id=randomUUID();
    this.db.prepare('INSERT INTO js_jobs(id,owner,command,cwd,state,started,label) VALUES(?,?,?,?,?,?,?)')
      .run(id,owner,command,cwd,'running',Date.now(),label);return id;
  }
  jobStarted(id:string,pid:number|null,logPath:string){this.db.prepare('UPDATE js_jobs SET pid=?,log_path=? WHERE id=?').run(pid,logPath,id);}
  finishJob(id:string,state:string,code:number|null){this.db.prepare('UPDATE js_jobs SET state=?,exit_code=?,finished=? WHERE id=? AND state=?').run(state,code,Date.now(),id,'running');}
  job(id:string,owner?:string):any{return this.db.prepare('SELECT * FROM js_jobs WHERE id=?'+(owner?' AND owner=?':'')).get(...(owner?[id,owner]:[id]))||null;}
  queueNotification(event:string,title:string,body:string,priority=5){
    const created=Date.now();const r=this.db.prepare('INSERT INTO js_notifications(event,title,body,priority,created,next_attempt) VALUES(?,?,?,?,?,?)')
      .run(event,title.slice(0,120),body.slice(0,2000),priority,created,created);
    return Number(r.lastInsertRowid);
  }
  takeNotification():null|{id:number;title:string;body:string;priority:number}{
    const row=this.db.prepare("SELECT id,title,body,priority FROM js_notifications WHERE state='pending' AND next_attempt<=? ORDER BY id LIMIT 1").get(Date.now()) as any;
    if(!row)return null;
    const r=this.db.prepare("UPDATE js_notifications SET state='sending',attempts=attempts+1 WHERE id=? AND state='pending'").run(row.id);
    return r.changes===1?row:null;
  }
  finishNotification(id:number,ok:boolean,error=''){
    const attempts=(this.db.prepare('SELECT attempts FROM js_notifications WHERE id=?').get(id) as {attempts:number}|undefined)?.attempts??6;
    const delay=Math.min(3600000,5000*2**Math.min(attempts,10));
    this.db.prepare('UPDATE js_notifications SET state=?,sent_at=?,next_attempt=?,last_error=? WHERE id=?')
      .run(ok?'sent':attempts>=6?'failed':'pending',ok?Date.now():null,Date.now()+delay,error.slice(0,300),id);
  }
  audit(actor:string, action:string, detail='') { this.db.prepare('INSERT INTO js_audit(at,actor,action,detail) VALUES(?,?,?,?)').run(new Date().toISOString(),actor.slice(0,120),action.slice(0,80),detail.slice(0,400)); }
  list():PluginRecord[] { return this.db.prepare('SELECT * FROM js_plugins ORDER BY updated DESC').all() as unknown as PluginRecord[]; }
  get(id:string):PluginRecord | null {return (this.db.prepare('SELECT * FROM js_plugins WHERE id=?').get(id) as unknown as PluginRecord)||null;}
  revision():number {return Number((this.db.prepare("SELECT value FROM js_meta WHERE name='catalog_revision'").get() as {value:string}).value);}
  bump() {this.db.prepare("UPDATE js_meta SET value=CAST(value AS INTEGER)+1 WHERE name='catalog_revision'").run();}
  create(p: Omit<PluginRecord, 'revision'|'updated'|'report'|'state'>) {
    if (this.get(p.id)) throw Error('Plugin ID already exists; use a new immutable version ID');
    this.db.prepare('INSERT INTO js_plugins(id,name,owner,manifest,source,state,report,digest,revision,updated) VALUES(?,?,?,?,?,?,?,?,1,?)')
      .run(p.id,p.name,p.owner,p.manifest,p.source,'draft',null,p.digest,new Date().toISOString());
    this.audit(p.owner,'plugin_propose',p.id);
  }
  transition(id:string, from:PluginState[], to:PluginState, report?:string) {
    const row=this.get(id); if(!row||!from.includes(row.state)) throw Error(`Invalid transition to ${to}`);
    const res=this.db.prepare('UPDATE js_plugins SET state=?,report=COALESCE(?,report),revision=revision+1,updated=? WHERE id=? AND state=?')
      .run(to,report??null,new Date().toISOString(),id,row.state);
    if(res.changes!==1) throw Error('Concurrent plugin update');
    if(to==='active'||row.state==='active') this.bump();
    if(row.state==='active' && to!=='active') {
      const count=this.db.prepare('UPDATE js_permission_leases SET revoked=? WHERE plugin=? AND revoked IS NULL AND expires>?').run(Date.now(),id,Date.now()).changes;
      if(count>0)this.audit('system','lease_revoke_on_disable',`${id}: ${count} leases`);
    }
    this.audit('admin','plugin_state',`${id}: ${row.state} => ${to}`);
  }
  active():PluginRecord[] {return this.list().filter(r=>r.state==='active');}
  request(owner:string,plugin:string,params_hash:string,params:string,reason:string,ttlSec=1800):string {
    const id=randomUUID(), t=Date.now();
    this.db.prepare('INSERT INTO js_approvals(id,owner,plugin,params_hash,params,reason,state,created,expires) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id,owner,plugin,params_hash,params,reason.slice(0,800),'pending',t,t+ttlSec*1000);
    this.audit(owner,'approval_request',id+':'+plugin);
    return id;
  }
  pending() {return this.db.prepare("SELECT * FROM js_approvals WHERE state='pending' ORDER BY created DESC").all();}
  decide(id:string,accept:boolean) {
    const res=this.db.prepare("UPDATE js_approvals SET state=? WHERE id=? AND state='pending' AND expires>?")
      .run(accept?'approved':'denied',id,Date.now());
    if(res.changes!==1) throw Error('Approval expired, already decided, or not found');
    this.audit('admin','approval_decision',id+':'+(accept?'approved':'denied'));
  }
  consume(id:string,owner:string,plugin:string,hash:string) {
    // This is atomic and fail-closed. Single use even if runner later fails.
    const res=this.db.prepare("UPDATE js_approvals SET used=1,state='consumed' WHERE id=? AND owner=? AND plugin=? AND params_hash=? AND state='approved' AND used=0 AND expires>?")
      .run(id,owner,plugin,hash,Date.now());
    if(res.changes!==1) throw Error('Missing, mismatched, expired or consumed approval');
    this.audit(owner,'approval_consumed',id+':'+plugin);
  }
  // Every temporary privilege is scoped to an exact plugin and Cloudflare-verified email.
  // Expiration is checked at each tool call, so no timer, background task or restart is required.
  grantHour(owner:string, plugin:string, actor='admin'):string {
    const p=this.get(plugin);
    if(!p||p.state!=='active')throw Error('Only active plugins can receive temporary permissions');
    if(!owner||owner.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(owner))throw Error('Invalid verified email identity');
    const now=Date.now();
    if(this.hasLease(owner,plugin,now))throw Error('An active lease already exists; revoke it instead of extending its expiration');
    const id=randomUUID();
    this.db.prepare('INSERT INTO js_permission_leases(id,owner,plugin,actor,created,expires) VALUES(?,?,?,?,?,?)')
      .run(id,owner,plugin,actor,now,now+3600000);
    this.audit(actor,'permission_grant_hour',`${id}: ${plugin} -> ${owner} until ${new Date(now+3600000).toISOString()}`);
    return id;
  }
  hasLease(owner:string,plugin:string,now=Date.now()):boolean {
    return Boolean(this.db.prepare(`SELECT l.id FROM js_permission_leases l
      JOIN js_plugins p ON p.id=l.plugin
      WHERE l.owner=? AND l.plugin=? AND l.revoked IS NULL AND l.expires>? AND p.state='active'
      LIMIT 1`).get(owner,plugin,now));
  }
  authorizePluginCall(owner:string,plugin:string,hash:string,approvalId?:string):'one_time'|'hour_lease' {
    // An explicitly supplied ticket never falls back to a broader hour grant.
    if(approvalId){this.consume(approvalId,owner,plugin,hash);return 'one_time';}
    if(!this.hasLease(owner,plugin))throw Error('Request mobile approval via approval_request, or ask admin for a one-hour scoped permission grant');
    this.audit(owner,'permission_lease_used',plugin);
    return 'hour_lease';
  }
  currentLeases(now=Date.now()) {
    return this.db.prepare(`SELECT l.*,p.name AS plugin_name FROM js_permission_leases l
      JOIN js_plugins p ON p.id=l.plugin
      WHERE l.revoked IS NULL AND l.expires>? AND p.state='active'
      ORDER BY l.expires ASC`).all(now) as unknown as Array<{id:string;owner:string;plugin:string;plugin_name:string;created:number;expires:number;actor:string}>;
  }
  revokeLease(id:string,actor='admin') {
    const result=this.db.prepare('UPDATE js_permission_leases SET revoked=? WHERE id=? AND revoked IS NULL AND expires>?')
      .run(Date.now(),id,Date.now());
    if(result.changes!==1)throw Error('Lease expired, revoked, or not found');
    this.audit(actor,'permission_revoke',id);
  }
  // Explicitly dangerous host execution grant: all ACTIVE + reviewed JS plugins,
  // one verified Cloudflare email, no Sandboxie and no per-call mobile approval.
  // Revocation and expiry always block NEW calls; running children are managed
  // separately by host-direct.ts. Revoked grants cannot be re-issued within
  // the original hour (prevents click-to-extend / accidental renewal).
  grantHostHour(owner:string,actor='admin'):string {
    if(!owner||owner.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(owner))throw Error('Invalid verified email identity');
    const now=Date.now();
    const recent=this.db.prepare('SELECT id FROM js_host_direct_leases WHERE owner=? AND expires>? LIMIT 1').get(owner,now);
    if(recent)throw Error('This identity already had a host-direct hour in progress; wait until its original expiration');
    const id=randomUUID();
    this.db.prepare('INSERT INTO js_host_direct_leases(id,owner,actor,created,expires) VALUES(?,?,?,?,?)')
      .run(id,owner,actor,now,now+3600000);
    this.audit(actor,'host_direct_grant',`${id} -> ${owner}, expires ${new Date(now+3600000).toISOString()}`);
    return id;
  }
  currentHostPass(owner:string,now=Date.now()):null|{id:string;owner:string;created:number;expires:number;actor:string} {
    return (this.db.prepare(`SELECT id,owner,created,expires,actor FROM js_host_direct_leases
      WHERE owner=? AND revoked IS NULL AND expires>? ORDER BY created DESC LIMIT 1`).get(owner,now) as any)||null;
  }
  hostPasses(now=Date.now()):Array<{id:string;owner:string;created:number;expires:number;actor:string}> {
    return this.db.prepare(`SELECT id,owner,created,expires,actor FROM js_host_direct_leases
      WHERE revoked IS NULL AND expires>? ORDER BY expires ASC`).all(now) as any;
  }
  revokeHostPass(id:string,actor='admin') {
    const res=this.db.prepare(`UPDATE js_host_direct_leases SET revoked=?
      WHERE id=? AND revoked IS NULL AND expires>?`).run(Date.now(),id,Date.now());
    if(res.changes!==1)throw Error('Host-direct grant expired, revoked or not found');
    this.audit(actor,'host_direct_revoke',id);
  }

  requestWork(owner:string,agentLabel:string,title:string,workspace:string,capabilities:string[],reason:string):string {
    if(!owner||owner.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(owner))throw Error('Verified email required');
    if(typeof title!=='string'||title.trim().length<3||title.length>120||
       typeof reason!=='string'||reason.trim().length<3||reason.length>800)throw Error('Task name and reason are required');
    if(typeof agentLabel!=='string'||agentLabel.length>80)throw Error('Invalid agent label');
    if(typeof workspace!=='string'||workspace.length>1024||!Array.isArray(capabilities)||
      capabilities.length<1||capabilities.length>2||new Set(capabilities).size!==capabilities.length||
      !capabilities.every(x=>['fs_write','sandbox_plugin'].includes(x)))throw Error('Invalid scope or capabilities');
    const now=Date.now();
    const active=this.db.prepare('SELECT id FROM js_work_sessions WHERE owner=? AND expires>? LIMIT 1').get(owner,now);
    if(active)throw Error('An existing work hour is still in progress; revoke or wait until expiry');
    const duplicate=this.db.prepare("SELECT id FROM js_work_requests WHERE owner=? AND state='pending' AND expires>? LIMIT 1").get(owner,now);
    if(duplicate)throw Error('A work request for this identity is already pending');
    const id=randomUUID();
    this.db.prepare(`INSERT INTO js_work_requests(id,owner,agent_label,title,workspace,capabilities,reason,state,created,expires)
      VALUES(?,?,?,?,?,?,?,'pending',?,?)`).run(id,owner,agentLabel,title.trim(),workspace,JSON.stringify(capabilities),reason.trim(),now,now+1800000);
    this.audit(owner,'work_request',id);
    return id;
  }
  workRequest(id:string,owner?:string):any {
    return this.db.prepare('SELECT * FROM js_work_requests WHERE id=?'+(owner?' AND owner=?':'')).get(...(owner?[id,owner]:[id]))||null;
  }
  workStatus(id:string,owner:string,now=Date.now()):{request_id:string;state:string;workspace?:string;capabilities?:string[];session?:{id:string;expires:number}|null} {
    const r=this.workRequest(id,owner);if(!r)return {request_id:id,state:'not_found'};
    let state=r.state;
    let session:null|{id:string;expires:number}=null;
    if(state==='pending'&&r.expires<=now)state='expired';
    if(state==='approved'){
      const x=this.db.prepare('SELECT id,expires,revoked FROM js_work_sessions WHERE request_id=? AND owner=?').get(id,owner) as any;
      if(!x)state='invalid';
      else if(x.revoked!==null)state='revoked';
      else if(x.expires<=now)state='expired';
      else {state='active';session={id:x.id,expires:x.expires};}
    }
    return {request_id:id,state,workspace:r.workspace,capabilities:JSON.parse(r.capabilities),session};
  }
  pendingWorkRequests(now=Date.now()):any[] {
    return this.db.prepare("SELECT * FROM js_work_requests WHERE state='pending' AND expires>? ORDER BY created DESC").all(now) as any[];
  }
  decideWorkRequest(id:string,approve:boolean,actor='admin'):string|null {
    const now=Date.now();this.db.exec('BEGIN IMMEDIATE');
    try{
      const req=this.workRequest(id);
      if(!req||req.state!=='pending'||req.expires<=now)throw Error('Work request already decided or expired');
      let sessionId:string|null=null;
      if(approve){
        // Check every grant (including revoked) until its ORIGINAL expiry so
        // revocation/re-approval cannot silently extend a 60-minute window.
        const existing=this.db.prepare('SELECT id FROM js_work_sessions WHERE owner=? AND expires>? LIMIT 1').get(req.owner,now);
        if(existing)throw Error('An hour has already been issued to this owner; cannot extend it');
        sessionId=randomUUID();
        this.db.prepare(`INSERT INTO js_work_sessions(id,request_id,owner,title,workspace,capabilities,actor,created,expires)
          VALUES(?,?,?,?,?,?,?,?,?)`).run(sessionId,id,req.owner,req.title,req.workspace,req.capabilities,actor,now,now+3600000);
      }
      const r=this.db.prepare("UPDATE js_work_requests SET state=?,decided=?,actor=? WHERE id=? AND state='pending' AND expires>?")
        .run(approve?'approved':'denied',now,actor,id,now);
      if(r.changes!==1)throw Error('Concurrent work request change');
      this.audit(actor,'work_decision',`${id}: ${approve?'approved':'denied'}`);
      this.db.exec('COMMIT');return sessionId;
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  currentWorkSession(owner:string,now=Date.now()):null|{id:string;request_id:string;owner:string;title:string;workspace:string;capabilities:string[];created:number;expires:number;actor:string} {
    const row=this.db.prepare('SELECT * FROM js_work_sessions WHERE owner=? AND revoked IS NULL AND expires>? ORDER BY created DESC LIMIT 1').get(owner,now) as any;
    return row?{...row,capabilities:JSON.parse(row.capabilities),request_id:row.request_id}:null;
  }
  activeWorkSessions(now=Date.now()):Array<any>{
    return (this.db.prepare('SELECT * FROM js_work_sessions WHERE revoked IS NULL AND expires>? ORDER BY expires').all(now) as any[])
      .map(x=>({...x,capabilities:JSON.parse(x.capabilities)}));
  }
  revokeWorkSession(id:string,actor='admin') {
    const r=this.db.prepare('UPDATE js_work_sessions SET revoked=? WHERE id=? AND revoked IS NULL AND expires>?').run(Date.now(),id,Date.now());
    if(r.changes!==1)throw Error('Work session expired, revoked, or absent');
    this.audit(actor,'work_session_revoke',id);
  }
  newRun(owner:string, plugin:string) {const id=randomUUID();this.db.prepare("INSERT INTO js_runs(id,owner,plugin,state,started) VALUES(?,?,?,?,?)").run(id,owner,plugin,'running',Date.now());return id;}
  finishRun(id:string, state:string,exitCode:number|null,output:string) {this.db.prepare('UPDATE js_runs SET state=?,finished=?,exit_code=?,output=? WHERE id=?').run(state,Date.now(),exitCode,output.slice(0,16000),id);}
  close() {this.db.close();}
}
