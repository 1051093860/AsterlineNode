import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../src/store.ts';
import {validateManifest,paramsHash,canonical,hash,verifyAdminBasic,checkOrigin} from '../src/policy.ts';
import {validateLock,sandboxReady} from '../src/runner.ts';
const good={id:'greeting_v1',name:'Greeter',description:'Demo',entry:'javascript',dependencies:{'zod':'4.1.0'},tool:{name:'greet_custom',description:'Custom greeting',requireApproval:true}};
test('Dependency sources must be pinned registry packages',()=>{
  assert.equal(validateManifest(good).dependencies.zod,'4.1.0');
  for(const bad of ['latest','^4.1.0','file:../bad','https://example.com/a.tgz','git+ssh://x'])
    assert.throws(()=>validateManifest({...good,dependencies:{evil:bad}}));
});
test('Dependency lock rejects scripts, links, unsafe origins',()=>{
  const safe={packages:{'':{},'node_modules/zod':{resolved:'https://registry.npmjs.org/zod/-/zod-4.1.0.tgz',integrity:'sha512-example'}}};
  assert.doesNotThrow(()=>validateLock(safe));
  assert.throws(()=>validateLock({packages:{...safe.packages,'node_modules/evil':{resolved:'https://evil.com/a',integrity:'sha512-foo'}}}));
  assert.throws(()=>validateLock({packages:{...safe.packages,'node_modules/evil':{resolved:'https://registry.npmjs.org/evil/-/a.tgz',integrity:'sha512-foo',hasInstallScript:true}}}));
});
test('Approvals bound to exact request, owner and single use',()=>{
  const tmp=mkdtempSync(path.join(os.tmpdir(),'asterline-test-'));
  const db=new Store(tmp);
  try{
    db.create({id:good.id,name:good.name,owner:'me@example.com',manifest:canonical(good),source:'export async function run(x){return x}',digest:hash('src')});
    assert.equal(db.get(good.id).state,'draft');
    assert.throws(()=>db.transition(good.id,['reviewed'],'active'));
    db.transition(good.id,['draft'],'reviewed',JSON.stringify({ok:true}));
    db.transition(good.id,['reviewed'],'installed');
    db.transition(good.id,['installed'],'active');
    assert.equal(db.revision(),1);
    const params={name:'a',number:1}; const id=db.request('me@example.com',good.id,paramsHash(params),canonical(params),'run',1800);
    assert.throws(()=>db.consume(id,'me@example.com',good.id,paramsHash(params)));
    db.decide(id,true);
    assert.throws(()=>db.consume(id,'stranger@example.com',good.id,paramsHash(params)));
    assert.throws(()=>db.consume(id,'me@example.com',good.id,paramsHash({name:'b',number:1})));
    db.consume(id,'me@example.com',good.id,paramsHash({number:1,name:'a'}));
    assert.throws(()=>db.consume(id,'me@example.com',good.id,paramsHash(params)));
    db.transition(good.id,['active'],'disabled');assert.equal(db.revision(),2);
  }finally{db.close();rmSync(tmp,{recursive:true,force:true});}
});
test('Strict Origin and password boundary',()=>{
  const h='Basic '+Buffer.from('admin:'.concat('x'.repeat(32))).toString('base64');
  assert.equal(verifyAdminBasic(h,'x'.repeat(32)),true);
  assert.equal(verifyAdminBasic(h,'a'.repeat(32)),false);
  assert.equal(checkOrigin({'origin':'https://mcpadmin.asterline.dev'},'mcpadmin.asterline.dev'),true);
  assert.equal(checkOrigin({'origin':'null'},'mcpadmin.asterline.dev'),false);
  assert.equal(checkOrigin({'origin':'https://evil.com'},'mcpadmin.asterline.dev'),false);
});
test('Sandbox execution fails closed without Windows Sandboxie configuration',()=>{
  const c={sandboxConfirmed:false,sandboxieStart:'',sandboxieBox:'TestBox',nodeExe:process.execPath};
  assert.equal(sandboxReady(c),false);
});
