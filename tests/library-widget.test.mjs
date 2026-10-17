import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createHash,webcrypto} from 'node:crypto';

const html=fs.readFileSync(new URL('../public/widget/library-bridge.html',import.meta.url),'utf8');
class Element {
 constructor(tag='div'){this.tag=tag;this.children=[];this.hidden=false;this.disabled=false;this.style={};this.attributes={};this.files=[];}
 append(...nodes){this.children.push(...nodes);}
 before(...nodes){this.beforeNodes=(this.beforeNodes||[]).concat(nodes);}
 replaceChildren(...nodes){this.children=nodes;}
 setAttribute(key,value){this.attributes[key]=value;}
 removeAttribute(key){delete this.attributes[key];}
 focus(){}
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
async function harness({bytes=Buffer.from('staged content'),uploadError,markError,corrupt=false,uploadFile=true}={}){
 const ids=Object.fromEntries(['log','queue','history','refresh','select','upload','file'].map(id=>[id,new Element()]));
 const job={id:'test-transfer',name:'staged.bin',size:bytes.length,direction:'to_chatgpt',state:'waiting_user',sha256:createHash('sha256').update(bytes).digest('hex')};
 const calls=[];let uploaded;
 const sdk={callTool:async(name,args)=>{calls.push([name,args]);let value;
 if(name==='library_bridge_list')value={jobs:[job]};
 if(name==='library_bridge_chunk'){const chunk=bytes.subarray(args.offset,args.offset+98304);value={offset:args.offset,bytes:chunk.length,base64:chunk.toString('base64')};if(corrupt)value.bytes++;}
 if(name==='library_bridge_mark'){if(markError)throw Error(markError);job.state='client_reported_uploaded';value={};}
 return {structuredContent:value};}};
 if(uploadFile)sdk.uploadFile=async file=>{uploaded=file;if(uploadError)throw Error(uploadError);return {fileId:'file_test123456'};};
 vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1],{document:{getElementById:id=>ids[id],createElement:tag=>new Element(tag)},window:{openai:sdk},File,Uint8Array,atob,crypto:webcrypto,URL});
 await flush();const [panel,progress]=ids.log.beforeNodes;
 return {ids,panel,progress,calls,job,get uploaded(){return uploaded;},start:()=>ids.queue.children[0].children[1].onclick()};
}
test('component confirmation cancels without reading or uploading',async()=>{
 const h=await harness();const pending=h.start();assert.equal(h.panel.hidden,false);h.panel.children[2].onclick();await pending;
 assert.equal(h.uploaded,undefined);assert.equal(h.calls.filter(([n])=>n==='library_bridge_chunk').length,0);assert.match(h.ids.log.textContent,/已取消/);
});
test('confirmed multi-chunk transfer verifies bytes and records upload',async()=>{
 const bytes=Buffer.alloc(98304+31,42),h=await harness({bytes});const pending=h.start();h.panel.children[1].onclick();await pending;
 assert.deepEqual(Buffer.from(await h.uploaded.arrayBuffer()),bytes);assert.equal(h.job.state,'client_reported_uploaded');assert.equal(h.progress.value,100);assert.equal(h.ids.refresh.disabled,false);
});
test('empty staged files upload successfully',async()=>{const h=await harness({bytes:Buffer.alloc(0)});const p=h.start();h.panel.children[1].onclick();await p;assert.equal(h.uploaded.size,0);});
test('invalid chunk fails visibly before upload',async()=>{const h=await harness({corrupt:true});const p=h.start();h.panel.children[1].onclick();await p;assert.equal(h.uploaded,undefined);assert.match(h.ids.log.textContent,/失败.*分块/);assert.equal(h.job.state,'waiting_user');});
test('SDK rejection preserves pending task and releases controls',async()=>{const h=await harness({uploadError:'network failure'});const p=h.start();h.panel.children[1].onclick();await p;assert.match(h.ids.log.textContent,/失败.*network failure/);assert.equal(h.job.state,'waiting_user');assert.equal(h.ids.refresh.disabled,false);});
test('mark failure includes uploaded ID and warns against duplicate upload',async()=>{const h=await harness({markError:'offline'});const p=h.start();h.panel.children[1].onclick();await p;assert.match(h.ids.log.textContent,/file_test123456.*请勿重复上传/);});
test('missing native SDK fails visibly',async()=>{const h=await harness({uploadFile:false});await h.start();assert.match(h.ids.log.textContent,/失败.*没有 Library 上传能力/);});
test('duplicate clicks do not start another upload',async()=>{const h=await harness();h.ids.file.files=[new File(['other'],'other.txt')];const p=h.start();await h.ids.upload.onclick();assert.match(h.ids.log.textContent,/已有上传正在进行/);assert.equal(h.panel.hidden,false);h.panel.children[2].onclick();await p;assert.equal(h.uploaded,undefined);});

// Opt-in read-only regression against this installation's existing staged bytes.
// The SDK remains a test double: this never uploads or marks production jobs.
if(process.env.ASTERLINE_TEST_STAGED==='1'){
 const index=new URL('../.state-node/library-bridge/index.json',import.meta.url),before=fs.readFileSync(index,'utf8');
 const jobs=JSON.parse(before).jobs.filter(j=>j.direction==='to_chatgpt'&&j.state==='waiting_user');
 for(const job of jobs)test(`existing staged task ${job.id}: integrity and widget transfer`,async()=>{
  const bytes=fs.readFileSync(new URL(`../.state-node/library-bridge/out/${job.id}`,import.meta.url));
  assert.equal(bytes.length,job.size);assert.equal(createHash('sha256').update(bytes).digest('hex'),job.sha256);
  const h=await harness({bytes});const p=h.start();h.panel.children[1].onclick();await p;
  assert.equal(h.job.state,'client_reported_uploaded');assert.deepEqual(Buffer.from(await h.uploaded.arrayBuffer()),bytes);
  assert.equal(fs.readFileSync(index,'utf8'),before,'production queue must stay unchanged');
 });
}
