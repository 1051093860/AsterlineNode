import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {LibraryBridge,CHUNK,validateLibraryUrl,normalizeLibraryHosts,DEFAULT_LIBRARY_FILE_HOSTS} from '../src/library-bridge.mjs';
import {spawnSync} from 'node:child_process';
import {fakeRcloneProgram} from './helpers/fake-rclone.mjs';
const init=()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'asterline-lib-'));const bridge=new LibraryBridge(root);return {root,bridge,close(){fs.rmSync(root,{recursive:true,force:true});}};};
const alice='a@example.com',bob='b@example.com';
test('push/owner isolation/chunk boundary/checksum/client reported completed',()=>{const x=init();try{
 const local=path.join(x.root,'example.txt');fs.writeFileSync(local,Buffer.alloc(CHUNK+20,7));const job=x.bridge.stagePush(local,alice);assert.equal(job.state,'waiting_user');assert.equal(x.bridge.list(bob).length,0);
 assert.throws(()=>x.bridge.chunk(job.id,bob,0));assert.throws(()=>x.bridge.chunk(job.id,alice,1));assert.throws(()=>x.bridge.chunk(job.id,alice,-1));assert.equal(x.bridge.chunk(job.id,alice,0).bytes,CHUNK);assert.equal(x.bridge.chunk(job.id,alice,CHUNK).bytes,20);
 assert.throws(()=>x.bridge.markUploaded(job.id,bob,'file_anything123'));assert.equal(x.bridge.markUploaded(job.id,alice,'file_abcd1234').state,'client_reported_uploaded');assert.throws(()=>x.bridge.markUploaded(job.id,alice,'file_abcd1234'));
 const x2=new LibraryBridge(x.root);assert.equal(x2.list(alice)[0].state,'client_reported_uploaded');
 }finally{x.close();}});
test('prevent directory and oversized upload and symlink staging',()=>{const x=init();try{
 assert.throws(()=>x.bridge.stagePush(x.root,alice));const big=path.join(x.root,'big');fs.writeFileSync(big,Buffer.alloc(201));const y=new LibraryBridge(x.root,{maxOutbound:200});assert.throws(()=>y.stagePush(big,alice));
 const link=path.join(x.root,'link');fs.symlinkSync(big,link);assert.throws(()=>y.stagePush(link,alice));
 }finally{x.close();}});
test('reject arbitrary download destinations, URL schemes, redirects, and enforce size',async()=>{const x=init();try{
 for(const url of ['http://files.oaiusercontent.com/a','https://localhost/x','https://127.0.0.1/x','https://example.com/x','https://openai.com.evil.org/x','https://user:pwd@openai.com/x'])assert.throws(()=>validateLibraryUrl(url,['*.oaiusercontent.com','openai.com']));
 assert.equal(validateLibraryUrl('https://files.oaiusercontent.com/a?sig=123',['*.oaiusercontent.com']).startsWith('https://'),true);
 const file={file_id:'file_abc',file_name:'data.txt',download_url:'https://files.oaiusercontent.com/example'};
 await assert.rejects(x.bridge.importLibraryFile(alice,file,{allowedHosts:['*.oaiusercontent.com'],fetchImpl:async()=>new Response('',{status:302})}));
 await assert.rejects(x.bridge.importLibraryFile(alice,{...file,file_name:'../oops'},{allowedHosts:['*.oaiusercontent.com'],fetchImpl:async()=>new Response('contents')}));
 const tiny=new LibraryBridge(x.root,{maxInbound:3});await assert.rejects(tiny.importLibraryFile(alice,file,{allowedHosts:['*.oaiusercontent.com'],fetchImpl:async()=>new Response('contents')}));
 assert.equal(tiny.list(alice).length,0);
 }finally{x.close();}});
test('authorized import -> CLI pull, checksum and no overwrites',async()=>{const x=init();try{
 const file={file_id:'file_AAAAAAAAA',file_name:'document.txt',download_url:'https://files.oaiusercontent.com/a?sig=secret'};
 const j=await x.bridge.importLibraryFile(alice,file,{allowedHosts:['*.oaiusercontent.com'],fetchImpl:async()=>new Response('HELLO WORLD')});assert.equal(j.size,11);assert.equal(x.bridge.list(bob).length,0);
 const dir=path.join(x.root,'received');fs.mkdirSync(dir);assert.throws(()=>x.bridge.pull(j.id,bob,dir));const r=x.bridge.pull(j.id,alice,dir);assert.equal(fs.readFileSync(r.file,'utf8'),'HELLO WORLD');assert.throws(()=>x.bridge.pull(j.id,alice,dir));
 const another=await x.bridge.importLibraryFile(alice,{...file,file_name:'another.txt'},{allowedHosts:['*.oaiusercontent.com'],fetchImpl:async()=>new Response('HI')});fs.writeFileSync(path.join(x.root,'library-bridge','in',another.id),'tampered');assert.throws(()=>x.bridge.pull(another.id,alice,dir));
 }finally{x.close();}});
test('CLI reads configured queue and rejects unapproved identity',()=>{const x=init();try{
 const src=path.join(x.root,'test.txt');fs.writeFileSync(src,'hello');const env={...process.env,MCP_DATA_DIR:x.root,MCP_ALLOWED_EMAILS:alice};const cli=(args)=>spawnSync(process.execPath,['scripts/library-cli.mjs',...args],{cwd:path.resolve('.'),env,encoding:'utf8'});
 const a=cli(['library','push',src]);assert.equal(a.status,0,a.stderr);const b=cli(['library','jobs']);assert.equal(b.status,0,b.stderr);assert.match(b.stdout,/waiting_user/);const c=cli(['library','jobs','--owner',bob]);assert.notEqual(c.status,0);
 }finally{x.close();}});

test('rclone cloud CLI: trusted executable, scoped remote, no shell arguments, no delete on sync',()=>{const x=init();try{
 const local=path.join(x.root,'sync');fs.mkdirSync(local);fs.writeFileSync(path.join(local,'sample.txt'),'SAFE');
 const capture=path.join(x.root,'rclone-args.json');const fakeInfo=fakeRcloneProgram(path.join(x.root,'fake-rclone'),{captureFile:capture});const fake=fakeInfo.executable;
 const env={...process.env,...fakeInfo.env,LIBRARY_RCLONE_EXE:fake,LIBRARY_RCLONE_REMOTE:'gdrive:Asterline',LIBRARY_CLOUD_LOCAL_ROOT:local};
 const invoke=(...args)=>spawnSync(process.execPath,['scripts/library-cli.mjs','cloud',...args],{cwd:path.resolve('.'),env,encoding:'utf8'});
 assert.equal(invoke('sync','--direction','up','--dry-run').status,0);let args=JSON.parse(fs.readFileSync(capture));assert.equal(args[0],'copy');assert.ok(args.includes('--dry-run'));assert.ok(!args.includes('sync'));assert.equal(args[2],'gdrive:Asterline');
 assert.equal(invoke('push',path.join(local,'sample.txt'),'--to','folder/sample.txt').status,0);args=JSON.parse(fs.readFileSync(capture));assert.equal(args[0],'copyto');assert.equal(args[2],'gdrive:Asterline/folder/sample.txt');
 const blocked=invoke('pull','../secrets.txt','-o',local);assert.notEqual(blocked.status,0);assert.equal(invoke('pull','safe.txt','-o',local).status,0);
 }finally{x.close();}});


test('ChatGPT official apex/subdomain links work under legacy wildcard and updated default',()=>{
 for(const host of ['chatgpt.com','sub.chatgpt.com','openai.com','api.openai.com','oaiusercontent.com','files.oaiusercontent.com','oaistatic.com']){
  assert.equal(new URL(validateLibraryUrl(`https://${host}/files/download?token=private`,DEFAULT_LIBRARY_FILE_HOSTS.split(','))).hostname,host);
 }
 // Older env overrides with only wildcards must continue to work for apex domains.
 assert.ok(validateLibraryUrl('https://chatgpt.com/backend-api/files/download',['*.chatgpt.com']));
});
test('Domain diagnostics show only a public host and never the signed URL',()=>{
 const signed='https://unknown-file-host.example.net/a?signature=top-secret';
 assert.throws(()=>validateLibraryUrl(signed,DEFAULT_LIBRARY_FILE_HOSTS.split(',')),e=>{
  assert.match(String(e),/hostname: unknown-file-host\.example\.net/);
  assert.doesNotMatch(String(e),/top-secret|\/a\?/);return true;
 });
 for(const pattern of ['*.com','localhost','*.local','127.0.0.1','http://evil.com','evil.com:443','example.com@chatgpt.com','internal.home.arpa'])assert.throws(()=>normalizeLibraryHosts(pattern));
 assert.equal(normalizeLibraryHosts('ChatGPT.com, *.chatgpt.com,chatgpt.com'),'chatgpt.com,*.chatgpt.com');
 for(const url of ['https://evilchatgpt.com/','https://chatgpt.com.evil.org/','https://sub.chatgpt.com.evil.org/','http://chatgpt.com/','https://127.0.0.1/'])assert.throws(()=>validateLibraryUrl(url,['*.chatgpt.com']));
});
