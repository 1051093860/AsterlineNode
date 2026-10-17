import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {Store} from '../src/store.ts';
import {createAdmin} from '../src/admin.ts';

const manifest={id:'greeting_v1',name:'Greeting JS',tool:{name:'greet_custom',description:'greet',requireApproval:true},dependencies:{}};
function fixture(){
  const tmp=mkdtempSync(path.join(os.tmpdir(),'asterline-hour-permission-'));
  const db=new Store(tmp);
  db.create({id:manifest.id,name:manifest.name,owner:'alice@example.org',manifest:JSON.stringify(manifest),source:'export async function run() {}',digest:'test'});
  db.transition(manifest.id,['draft'],'reviewed','{}');
  db.transition(manifest.id,['reviewed'],'installed');
  db.transition(manifest.id,['installed'],'active');
  return {db,tmp,cleanup(){db.close();rmSync(tmp,{recursive:true,force:true});}};
}
test('One-hour grant binds plugin and identity, persists, and expires without timers',()=>{
  const f=fixture();
  try {
    assert.equal(f.db.hasLease('alice@example.org','greeting_v1'),false);
    const id=f.db.grantHour('alice@example.org','greeting_v1','admin:test');
    const row=f.db.db.prepare('SELECT * FROM js_permission_leases WHERE id=?').get(id);
    assert.equal(row.expires-row.created,3600000);
    assert.equal(f.db.hasLease('alice@example.org','greeting_v1'),true);
    assert.equal(f.db.authorizePluginCall('alice@example.org','greeting_v1','hash123'),'hour_lease');
    assert.throws(()=>f.db.authorizePluginCall('bob@example.org','greeting_v1','hash123'),/Request mobile approval/);
    assert.throws(()=>f.db.authorizePluginCall('alice@example.org','greeting_v1','hash123','invalid-ticket'),/Missing, mismatched/);
    assert.equal(f.db.hasLease('bob@example.org','greeting_v1'),false);
    assert.equal(f.db.hasLease('alice@example.org','wrong_plugin'),false);
    assert.equal(f.db.hasLease('alice@example.org','greeting_v1',row.expires),false);
    assert.throws(()=>f.db.grantHour('alice@example.org','greeting_v1'),/already exists/);
    const db2=new Store(f.tmp);
    assert.equal(db2.hasLease('alice@example.org','greeting_v1'),true);
    db2.close();
    f.db.revokeLease(id);
    assert.equal(f.db.hasLease('alice@example.org','greeting_v1'),false);
    assert.throws(()=>f.db.authorizePluginCall('alice@example.org','greeting_v1','hash123'),/Request mobile approval/);
    assert.throws(()=>f.db.revokeLease(id),/expired, revoked/);
    assert.equal(f.db.currentLeases().length,0);
    assert.notEqual(f.db.grantHour('alice@example.org','greeting_v1'),id);
    assert.equal(f.db.currentLeases().length,1);
    f.db.transition('greeting_v1',['active'],'disabled');
    assert.equal(f.db.currentLeases().length,0);
    f.db.transition('greeting_v1',['disabled'],'active');
    assert.equal(f.db.hasLease('alice@example.org','greeting_v1'),false);
  } finally {f.cleanup();}
});
test('Fail-closed invalid identity, inactive plugin and expiration boundary',()=>{
  const f=fixture();
  try {
    assert.throws(()=>f.db.grantHour('not-email','greeting_v1'),/Invalid verified email/);
    assert.throws(()=>f.db.grantHour('a@example.org','no_plugin'),/Only active/);
    const id=f.db.grantHour('alice@example.org','greeting_v1');
    f.db.db.prepare('UPDATE js_permission_leases SET created=created-3600000,expires=expires-3600000 WHERE id=?').run(id);
    assert.equal(f.db.hasLease('alice@example.org','greeting_v1'),false);
    assert.equal(f.db.currentLeases().length,0);
    assert.notEqual(f.db.grantHour('alice@example.org','greeting_v1'),id);
  } finally {f.cleanup();}
});
test('Admin dashboard scoped grant requires sandbox readiness, Basic auth, Origin and CSRF',async()=>{
  const f=fixture();
  let server;
  try {
    // Reserve an ephemeral local port, then bind the production-style Host check to it.
    const reservation=net.createServer();
    await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
    const allocatedPort=reservation.address().port;
    await new Promise(resolve=>reservation.close(resolve));
    const conf={password:'x'.repeat(32),localAdminPort:allocatedPort,publicAdminPort:0,publicHost:'mcpadmin.asterline.dev',adminAud:'',teamDomain:'',emails:new Set(['alice@example.org']),sandboxConfirmed:false,sandboxieBox:'AsterlineQATest',sandboxieStart:'',};
    let ready=false;
    const admin=createAdmin(conf,f.db,{verify:async()=>{throw Error('not used')}} ,{preflight:async()=>{},install:async()=>{},sandboxReady:()=>ready});
    ({local:server}=admin.start());
    await new Promise(resolve=>server.listening?resolve():server.once('listening',resolve));
    const port=server.address().port;
    const root=`http://127.0.0.1:${port}`;
    const Authorization='Basic '+Buffer.from('admin:'+conf.password).toString('base64');
    let result=await fetch(root+'/permissions'); assert.equal(result.status,401);
    result=await fetch(root+'/permissions',{headers:{Authorization}}); assert.equal(result.status,200);
    const html=await result.text();
    assert.match(html,/临时权限/);
    assert.match(html,/disabled/);
    const token=html.match(/name="csrf" value="([a-f0-9]{64})"/)[1];
    const post=(origin,csrfValue=token,owner='alice@example.org')=>fetch(root+'/action',{method:'POST',redirect:'manual',headers:{Authorization,'Origin':origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf:csrfValue,kind:'grant_hour',id:'greeting_v1',owner})});
    result=await post('https://evil.example');assert.equal(result.status,403);
    result=await post(root,'bad-token');assert.equal(result.status,403);
    result=await post(root);assert.equal(result.status,409);assert.equal(f.db.currentLeases().length,0);
    ready=true;
    result=await post(root,token,'unlisted@example.org');assert.equal(result.status,409);
    result=await post(root);assert.equal(result.status,303);assert.equal(f.db.currentLeases().length,1);
    result=await post(root);assert.equal(result.status,409);assert.equal(f.db.currentLeases().length,1);
    result=await fetch(root+'/permissions',{headers:{Authorization}});
    assert.match(await result.text(),/立即撤销/);
    const id=f.db.currentLeases()[0].id;
    result=await fetch(root+'/action',{method:'POST',redirect:'manual',headers:{Authorization,'Origin':root,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf:token,kind:'revoke_hour',id})});
    assert.equal(result.status,303);assert.equal(f.db.currentLeases().length,0);
    assert.equal(f.db.db.prepare("SELECT count(*) AS n FROM js_audit WHERE action='permission_grant_hour'").get().n,1);
  } finally {
    if(server?.listening)await new Promise(resolve=>server.close(resolve));
    f.cleanup();
  }
});
