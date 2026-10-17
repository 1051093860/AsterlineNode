import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {Store} from '../src/store.ts';
import {createAdmin} from '../src/admin.ts';

async function port(){const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const p=socket.address().port;await new Promise(r=>socket.close(r));return p;}
test('Cloudflare must not rewrite Access identity in select or audit output',async()=>{
  const root=mkdtempSync(path.join(tmpdir(),'asterline-email-ui-'));
  const store=new Store(root),p=await port();
  const manifest={id:'greeting_v1',name:'Greeting JS',tool:{name:'greet_custom',description:'greet',requireApproval:true},dependencies:{}};
  store.create({id:'greeting_v1',name:'Greeting JS',owner:'owner@example.org',manifest:JSON.stringify(manifest),source:'export function run(){return 1}',digest:'test'});
  store.transition('greeting_v1',['draft'],'reviewed','{}');
  store.transition('greeting_v1',['reviewed'],'installed');
  store.transition('greeting_v1',['installed'],'active');
  const cfg={password:'f'.repeat(32),localAdminPort:p,publicAdminPort:0,publicHost:'mcpadmin.asterline.dev',adminAud:'',teamDomain:'',emails:new Set(['owner@example.org']),sandboxConfirmed:false,sandboxieStart:'',sandboxieBox:'AsterlineQATest'};
  const service=createAdmin(cfg,store,{verify:async()=>{throw Error('not used')}},{jobs:{cancel(){}},preflight:async()=>{},install:async()=>{},sandboxReady:()=>false});
  const {local}=service.start();
  try{
    if(!local.listening)await new Promise(resolve=>local.once('listening',resolve));
    const Authorization='Basic '+Buffer.from('admin:'+cfg.password).toString('base64');
    for(const uri of ['/sandboxes','/permissions']){
      const res=await fetch(`http://127.0.0.1:${p}${uri}`,{headers:{Authorization}});
      const html=await res.text();
      assert.equal(res.status,200,uri);
      assert.match(res.headers.get('cache-control')||'',/no-transform/);
      assert.ok(html.includes('<option value="owner@example.org"><!--email_off-->owner@example.org<!--/email_off--></option>'), uri+' must render unmodified option');
      assert.doesNotMatch(html,/__cf_email__|cdn-cgi\/l\/email-protection/);
    }
  }finally{await new Promise(resolve=>local.close(resolve));store.close();rmSync(root,{recursive:true,force:true});}
});
