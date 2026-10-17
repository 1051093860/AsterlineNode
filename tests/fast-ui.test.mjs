import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {Store} from '../src/store.ts';
import {createAdmin} from '../src/admin.ts';

const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function freePort(){const s=net.createServer();await new Promise(f=>s.listen(0,'127.0.0.1',f));const n=s.address().port;await new Promise(f=>s.close(f));return n;}

test('UI actions: immediate 202, identity-bound poll, duplicate protection, CSRF, classic redirect',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'asterline-ui172-'));
 const store=new Store(dir);let checks=0;const port=await freePort();
 store.create({id:'qa_plugin',name:'QA',owner:'tester@example.com',manifest:JSON.stringify({id:'qa_plugin',name:'QA',dependencies:{},tool:{name:'qa_tool',description:'QA',requireApproval:true}}),source:'export async function run(){}',digest:'qa'});
 const cfg={password:'b'.repeat(32),localAdminPort:port,publicAdminPort:0,publicHost:'mcpadmin.asterline.dev',adminAud:'',teamDomain:'',emails:new Set(['tester@example.com']),gotifyToken:'',gotify:'',sandboxieBox:'QA',sandboxieStart:'',sandboxConfirmed:false};
 const svc=createAdmin(cfg,store,{verify:async()=>{throw Error('not used')}},{jobs:{cancel(){}},preflight:async id=>{checks++;await pause(200);store.transition(id,['draft'],'reviewed');},install:async()=>{},sandboxReady:()=>false});
 const server=svc.start().local;if(!server.listening)await new Promise(r=>server.once('listening',r));
 const root='http://127.0.0.1:'+port,authorization='Basic '+Buffer.from('admin:'+cfg.password).toString('base64');
 const headers={Authorization:authorization,Origin:root,'X-Asterline-Async':'1',Accept:'application/json','Content-Type':'application/x-www-form-urlencoded'};
 try{
  const page=await fetch(root+'/plugins',{headers:{Authorization:authorization}});const html=await page.text();const token=/name="csrf" value="([a-f0-9]+)"/.exec(html)?.[1];assert.ok(token);
  const post=(csrf=token,extras={})=>fetch(root+'/action',{method:'POST',headers:{...headers,...extras},body:new URLSearchParams({csrf,kind:'preflight',id:'qa_plugin'})});
  assert.equal((await post('invalid')).status,403,'Bad CSRF must fail');
  assert.equal((await fetch(root+'/ui-operation?id=random')).status,401,'Anonymous polling must fail');
  let start=Date.now(),r=await post();assert.equal(r.status,202);assert.ok(Date.now()-start<190,'202 should precede 200ms task completion');
  const data=await r.json();assert.ok(data.id);assert.equal((await post()).status,409,'Duplicate work must fail');
  let result=null;for(let i=0;i<15;i++){await pause(40);let p=await fetch(root+'/ui-operation?id='+data.id,{headers:{Authorization:authorization}});assert.equal(p.status,200);result=await p.json();if(result.state!=='running')break;}
  assert.equal(result?.state,'succeeded');assert.equal(checks,1);assert.equal(store.get('qa_plugin').state,'reviewed');
  // Old HTML form remains available for clients with JavaScript disabled.
  const classic=await fetch(root+'/action',{method:'POST',redirect:'manual',headers:{Authorization:authorization,Origin:root,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf:token,kind:'reject',id:'qa_plugin'})});
  assert.equal(classic.status,303);assert.ok(classic.headers.get('location')?.includes('/plugins'));
 }finally{await new Promise(f=>server.close(f));store.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('PWA static cache changes version, does not cache operations or admin HTML',()=>{
 const sw=fs.readFileSync('public/sw.js','utf8');assert.match(sw,/asterline-ui-static-v\d+/);assert.doesNotMatch(sw,/\['\/ui-operation'/);assert.doesNotMatch(sw,/\['\/action'/);
 const js=fs.readFileSync('public/admin.js','utf8');assert.match(js,/X-Asterline-Async/);assert.match(js,/ui-operation/);assert.match(js,/aria-busy/);
});
