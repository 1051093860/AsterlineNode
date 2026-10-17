import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {LibraryBridge} from '../src/library-bridge.mjs';
import {agentStagePath} from '../src/library-stage.mjs';
const owner='test@example.com';
function fixture(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'ast-agentlib-'));const work=path.join(root,'work');fs.mkdirSync(work);return {root,work,done:()=>fs.rmSync(root,{force:true,recursive:true})};}
test('agent stages authorized workspace file, retrieves bytes and verifies SHA256',()=>{const x=fixture();try{
 const bin=Buffer.from([0,255,1,2,3,4,128,13]);fs.mkdirSync(path.join(x.work,'documents'));fs.writeFileSync(path.join(x.work,'documents','test.bin'),bin);const p=agentStagePath(x.work,'documents\\test.bin');const bridge=new LibraryBridge(x.root);const job=bridge.stagePush(p,owner);const chunk=bridge.chunk(job.id,owner,0);assert.deepEqual(Buffer.from(chunk.base64,'base64'),bin);assert.equal(chunk.sha256,job.sha256);assert.equal(bridge.list('other@example.com').length,0);
}finally{x.done();}});
test('blocks workspace escape, symlink, secret paths, and non-files',()=>{const x=fixture();try{
 fs.writeFileSync(path.join(x.work,'safe.txt'),'SAFE');fs.writeFileSync(path.join(x.root,'outside.txt'),'OUTSIDE');fs.mkdirSync(path.join(x.work,'docs'));fs.symlinkSync(path.join(x.root,'outside.txt'),path.join(x.work,'link.txt'));
 for(const p of ['../outside.txt','./safe.txt','/etc/passwd','C:/windows/win.ini','.env','.env.local','.git/config','.state-node/index.json','docs','link.txt','id_rsa','cert.pem','credentials.json','node_modules/dep.js','docs/../safe.txt'])assert.throws(()=>agentStagePath(x.work,p),undefined,p);
 assert.equal(agentStagePath(x.work,'safe.txt'),path.join(x.work,'safe.txt'));
}finally{x.done();}});
test('max outbound enforced and no staging of unrelated user files',()=>{const x=fixture();try{
 const secret=path.join(x.root,'other-user-file.txt');fs.writeFileSync(secret,'x');assert.throws(()=>agentStagePath(x.work,secret));const big=path.join(x.work,'big.bin');fs.writeFileSync(big,Buffer.alloc(33));const bridge=new LibraryBridge(x.root,{maxOutbound:32});assert.throws(()=>bridge.stagePush(agentStagePath(x.work,'big.bin'),owner));
}finally{x.done();}});
test('MCP registers library_stage with per-owner privileged gate and audit',()=>{const code=fs.readFileSync(new URL('../src/server.ts',import.meta.url),'utf8');assert.match(code,/server\.registerTool\('library_stage'/);assert.match(code,/const who=privileged\(\);const checked=agentStagePath/);assert.match(code,/store\.audit\(who,'library_stage'/);assert.match(code,/library_bridge_chunk/);});
