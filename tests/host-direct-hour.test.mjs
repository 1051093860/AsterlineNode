import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {Store} from '../src/store.ts';
import {createAdmin} from '../src/admin.ts';
import {executeHostDirect,stopHostPassJobs} from '../src/host-direct.ts';

const ID='host_test_plugin', EMAIL='owner@example.org';
function fixture(){
  const tmp=mkdtempSync(path.join(os.tmpdir(),'asterline-host-hour-'));
  const store=new Store(tmp);
  const manifest={id:ID,name:'Host test plugin',entry:'javascript',tool:{name:'host_test_tool',description:'test',requireApproval:true},dependencies:{}};
  store.create({id:ID,name:'Host test plugin',owner:EMAIL,manifest:JSON.stringify(manifest),source:'export async function run(input) { return {echo:input.ping}; }',digest:'test'});
  store.transition(ID,['draft'],'reviewed','{}');store.transition(ID,['reviewed'],'installed');store.transition(ID,['installed'],'active');
  const release=path.join(tmp,'releases',ID);mkdirSync(release,{recursive:true});
  writeFileSync(path.join(release,'tool.mjs'),'export async function run(input){ return {echo:input.ping, mode:"host"}; }');
  const conf={data:tmp,nodeExe:process.execPath,maxPluginSeconds:3,gotifyToken:'',gotify:'http://127.0.0.1:8780'};
  return {tmp,store,conf,cleanup(){store.close();rmSync(tmp,{recursive:true,force:true});}};
}

test('one-hour host-direct grant: owner scoped, absolute expiry and deny renewal',()=>{
  const f=fixture();try{
    assert.equal(f.store.currentHostPass(EMAIL),null);
    assert.throws(()=>f.store.grantHostHour('bad'),/Invalid verified email/);
    const id=f.store.grantHostHour(EMAIL,'admin:local');
    const row=f.store.currentHostPass(EMAIL);
    assert.equal(row.expires-row.created,3600000);
    assert.equal(f.store.currentHostPass('other@example.org'),null);
    assert.equal(f.store.currentHostPass(EMAIL,row.expires),null);
    assert.throws(()=>f.store.grantHostHour(EMAIL),/already had a host-direct hour/);
    const reopen=new Store(f.tmp);
    assert.equal(reopen.currentHostPass(EMAIL).id,id);reopen.close();
    f.store.revokeHostPass(id);
    assert.equal(f.store.currentHostPass(EMAIL),null);
    assert.throws(()=>f.store.revokeHostPass(id),/expired, revoked/);
    assert.throws(()=>f.store.grantHostHour(EMAIL),/already had a host-direct hour/);
    assert.equal(f.store.hostPasses().length,0);
  }finally{f.cleanup();}
});

test('expiry causes denial without interval; no false time extension',()=>{
  const f=fixture();try{
    const id=f.store.grantHostHour(EMAIL);
    f.store.db.prepare('UPDATE js_host_direct_leases SET created=created-3600000,expires=expires-3600000 WHERE id=?').run(id);
    assert.equal(f.store.currentHostPass(EMAIL),null);
    assert.notEqual(f.store.grantHostHour(EMAIL),id);
  }finally{f.cleanup();}
});

test('admin cannot enable host direct without Basic + Origin + CSRF + typed phrase + checkbox',async()=>{
  const f=fixture();let server;
  try {
    const reserv=net.createServer();await new Promise(r=>reserv.listen(0,'127.0.0.1',r));
    const port=reserv.address().port;await new Promise(r=>reserv.close(r));
    const c={...f.conf,password:'a'.repeat(32),localAdminPort:port,publicAdminPort:0,publicHost:'mcpadmin.asterline.dev',adminAud:'',teamDomain:'',emails:new Set([EMAIL]),sandboxConfirmed:false,sandboxieBox:'TestBox',sandboxieStart:''};
    const {local}=createAdmin(c,f.store,{verify:async()=>{throw Error('not used');}},{preflight:async()=>{},install:async()=>{},sandboxReady:()=>false,cancelHostPass:stopHostPassJobs}).start();
    server=local;await new Promise(r=>server.listening?r():server.once('listening',r));
    const url=`http://127.0.0.1:${port}`;
    const basic='Basic '+Buffer.from('admin:'+c.password).toString('base64');
    assert.equal((await fetch(url+'/sandboxes')).status,401);
    const html=await (await fetch(url+'/sandboxes',{headers:{Authorization:basic}})).text();
    assert.match(html,/完全开放执行权限/);
    const csrf=html.match(/name="csrf" value="([a-f0-9]{64})"/)[1];
    const post=(a={})=>fetch(url+'/action',{method:'POST',redirect:'manual',headers:{Authorization:basic,Origin:a.origin??url,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({kind:'grant_host_hour',owner:EMAIL,csrf:a.csrf??csrf,confirm:a.confirm??'我确认完全开放宿主机1小时',ack:a.ack??'yes'})});
    assert.equal((await post({origin:'https://attacker.example'})).status,403);
    assert.equal((await post({csrf:'wrong'})).status,403);
    assert.equal((await post({confirm:'我确认'})).status,409);
    assert.equal((await post({ack:'no'})).status,409);
    assert.equal(f.store.hostPasses().length,0);
    assert.equal((await post()).status,303);
    assert.equal(f.store.hostPasses().length,1);
    assert.equal((await post()).status,409);
    const id=f.store.currentHostPass(EMAIL).id;
    assert.equal((await fetch(url+'/action',{method:'POST',redirect:'manual',headers:{Authorization:basic,Origin:url,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({kind:'revoke_host_hour',csrf,id})})).status,303);
    assert.equal(f.store.hostPasses().length,0);
    assert.equal((await post()).status,409);
  } finally {if(server?.listening)await new Promise(r=>server.close(r));f.cleanup();}
});

test('unsandboxed worker runs only under correct unexpired owner pass',async()=>{
  const f=fixture();try{
    await assert.rejects(executeHostDirect(f.conf,f.store,EMAIL,ID,{ping:'x'},'unknown'),/expired or revoked/);
    const lease=f.store.grantHostHour(EMAIL);
    await assert.rejects(executeHostDirect(f.conf,f.store,'other@example.org',ID,{ping:'x'},lease),/expired or revoked/);
    const r=await executeHostDirect(f.conf,f.store,EMAIL,ID,{ping:'hello'},lease);
    assert.deepEqual(r.result,{echo:'hello',mode:'host'});
    assert.equal(r.execution,'host_direct');
    const dbRun=f.store.db.prepare('SELECT state FROM js_runs WHERE id=?').get(r.task_id);
    assert.equal(dbRun.state,'finished');
    f.store.revokeHostPass(lease);stopHostPassJobs(lease);
    await assert.rejects(executeHostDirect(f.conf,f.store,EMAIL,ID,{ping:'x'},lease),/expired or revoked/);
  }finally{f.cleanup();}
});

test('revoking active lease interrupts a running host worker',async()=>{
  const f=fixture();try{
    writeFileSync(path.join(f.tmp,'releases',ID,'tool.mjs'),
      'export async function run(){await new Promise(r=>setTimeout(r,8000));return {late:true};}');
    const lease=f.store.grantHostHour(EMAIL);
    const start=Date.now();
    const task=executeHostDirect({...f.conf,maxPluginSeconds:10},f.store,EMAIL,ID,{},lease);
    await new Promise(r=>setTimeout(r,250));
    f.store.revokeHostPass(lease);stopHostPassJobs(lease);
    await assert.rejects(task,/revoked/);
    assert.ok(Date.now()-start<6000,'revoke must interrupt rather than await the full worker duration');
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM js_runs WHERE state='failed'").get().n,1);
  }finally{f.cleanup();}
});
