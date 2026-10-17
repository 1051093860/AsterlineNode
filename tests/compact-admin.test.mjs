import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {Store} from '../src/store.ts';
import {createAdmin} from '../src/admin.ts';

async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function fixture(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'asterline-ui-compact-'));
 const workspace=path.join(dir,'workspace');fs.mkdirSync(path.join(workspace,'project'),{recursive:true});
 const store=new Store(path.join(dir,'data'));
 const config={data:path.join(dir,'data'),workspaceRoot:workspace,password:'x'.repeat(32),localAdminPort:await freePort(),publicAdminPort:0,publicHost:'mcpadmin.asterline.dev',adminAud:'',teamDomain:'',emails:new Set(['alice@example.org']),gotifyToken:'',gotify:'',sandboxieBox:'AsterlineQATest',sandboxieStart:'',sandboxieBoxRoot:'',sandboxConfirmed:false,maxPluginSeconds:60};
 const work=store.requestWork('alice@example.org','ChatGPT','修复项目','project',['fs_write'],'修复代码');
 const single=store.request('alice@example.org','terminal_exec','hash-xyz','{"command":"node --version"}','运行版本检查');
 const srv=createAdmin(config,store,{verify:async()=>{throw Error('unused')}},{jobs:{cancel(){}},preflight:async()=>{},install:async()=>{},sandboxReady:()=>false}).start().local;
 if(!srv.listening)await new Promise(r=>srv.once('listening',r));
 const root=`http://127.0.0.1:${config.localAdminPort}`;
 const headers={Authorization:'Basic '+Buffer.from('admin:'+config.password).toString('base64')};
 return {store,work,single,root,headers,async close(){await new Promise(r=>srv.close(r));store.close();fs.rmSync(dir,{recursive:true,force:true});}};
}
test('Compact navigation keeps every old route accessible and puts only eight in daily sections',async()=>{
 const f=await fixture();try{
  const html=await(await fetch(f.root+'/',{headers:f.headers})).text();
  const visible=html.match(/class="nav-section"/g)||[];assert.equal(visible.length,2);
  assert.equal((html.match(/class="nav-link /g)||[]).length,13); // 8 primary + 5 collapsed
  assert.match(html,/<details class="nav-more"/);
  assert.match(html,/href="\/dependencies"/);
  assert.doesNotMatch(html,/class="quick-panel"/);
  assert.doesNotMatch(html,/class="hero-art"/);
  assert.match(html,/处理 2 项待办/);
 }finally{await f.close();}
});
test('Unified access page shows work and one-time requests with original params on demand',async()=>{
 const f=await fixture();try{
  const r=await fetch(f.root+'/access',{headers:f.headers});assert.equal(r.status,200);
  const html=await r.text();assert.match(html,/修复项目/);assert.match(html,/运行版本检查/);
  assert.match(html,/开发授权 · 60 分钟/);assert.match(html,/单次操作 · 精确参数/);
  assert.match(html,/name="return_to" value="\/access"/);
  assert.doesNotMatch(html,/class="permission-modes"/);
  const csrf=html.match(/name="csrf" value="([a-f0-9]{64})"/)[1];
  const response=await fetch(f.root+'/action',{method:'POST',redirect:'manual',headers:{...f.headers,Origin:f.root,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,kind:'approve',id:f.single,return_to:'/access'})});
  assert.equal(response.status,303);assert.match(response.headers.get('location'),/^\/access\?done=approve/);
  assert.equal(f.store.pending().length,0);
 }finally{await f.close();}
});
test('Settings use compact groups and the same protected action API',async()=>{
 const f=await fixture();try{
  const html=await(await fetch(f.root+'/settings',{headers:f.headers})).text();
  assert.match(html,/class="setting-row"/);assert.match(html,/class="setting-section"/);
  assert.match(html,/name="kind" value="save_setting"/);
  assert.doesNotMatch(html,/class="panel setting-row"/);
  const js=fs.readFileSync(new URL('../public/admin.js',import.meta.url),'utf8');
  assert.match(js,/'\/settings'\]\.includes\(location.pathname\)/);
 }finally{await f.close();}
});
