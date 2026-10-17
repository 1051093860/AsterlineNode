import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../src/store.ts';
import {executeHostTerminal,stopHostTerminalJobs} from '../src/terminal.ts';

const EMAIL='owner@example.org';
function setup(){
  const tmp=mkdtempSync(path.join(os.tmpdir(),'asterline-terminal-'));
  const store=new Store(tmp);
  const conf={data:tmp,maxPluginSeconds:5,gotify:'http://127.0.0.1:8780',gotifyToken:''};
  return {tmp,store,conf,close(){store.close();rmSync(tmp,{recursive:true,force:true});}};
}

test('terminal requires exact verified owner lease, and does not run when absent',async()=>{
  const f=setup();try{
    await assert.rejects(executeHostTerminal(f.conf,f.store,EMAIL,{shell:'exec',command:process.execPath,args:['--version']}),/administrator-issued/);
    const lease=f.store.grantHostHour(EMAIL);
    await assert.rejects(executeHostTerminal(f.conf,f.store,'other@example.org',{shell:'exec',command:process.execPath,args:['--version']}),/administrator-issued/);
    const r=await executeHostTerminal(f.conf,f.store,EMAIL,{shell:'exec',command:process.execPath,args:['--version'],timeout_seconds:10});
    assert.equal(r.exit_code,0);assert.match(r.stdout,/^v\d+/);
    assert.equal(r.execution,'host_direct_terminal');
    assert.equal(f.store.db.prepare('SELECT plugin,state FROM js_runs WHERE id=?').get(r.task_id).plugin,'@terminal_exec');
    f.store.revokeHostPass(lease);stopHostTerminalJobs(lease);
    await assert.rejects(executeHostTerminal(f.conf,f.store,EMAIL,{shell:'exec',command:process.execPath,args:['--version']}),/administrator-issued/);
  } finally {f.close();}
});

test('terminal accepts argv without shell interpolation; nonzero exit gets captured',async()=>{
  const f=setup();try{
    f.store.grantHostHour(EMAIL);
    const r=await executeHostTerminal(f.conf,f.store,EMAIL,{
      shell:'exec',command:process.execPath,args:['-e','console.log(process.argv[1]);console.error("warn");process.exit(7)','two words & chars']
    });
    assert.equal(r.exit_code,7);assert.match(r.stdout,/two words & chars/);assert.match(r.stderr,/warn/);
    assert.equal(f.store.db.prepare('SELECT state FROM js_runs WHERE id=?').get(r.task_id).state,'failed');
  }finally{f.close();}
});

test('terminal output is bounded, invalid input is denied',async()=>{
  const f=setup();try{
    f.store.grantHostHour(EMAIL);
    await assert.rejects(executeHostTerminal(f.conf,f.store,EMAIL,{shell:'exec',command:process.execPath,timeout_seconds:121}),/timeout/);
    await assert.rejects(executeHostTerminal(f.conf,f.store,EMAIL,{shell:'cmd',command:'echo hi',args:['unwanted']}),/argv only allowed/);
    const r=await executeHostTerminal(f.conf,f.store,EMAIL,{shell:'exec',command:process.execPath,args:['-e','process.stdout.write("a".repeat(100000))']});
    assert.equal(r.truncated,true);assert.ok(Buffer.byteLength(r.stdout)<=24576);
  }finally{f.close();}
});

test('revoking one-hour host privilege terminates in-flight terminal command',async()=>{
  const f=setup();try{
    const lease=f.store.grantHostHour(EMAIL);
    const run=executeHostTerminal(f.conf,f.store,EMAIL,{
      shell:'exec',command:process.execPath,args:['-e','setInterval(()=>{},1000)'],timeout_seconds:30
    });
    await new Promise(r=>setTimeout(r,350));
    f.store.revokeHostPass(lease);stopHostTerminalJobs(lease);
    await assert.rejects(run,/revoked/);
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS count FROM js_runs WHERE plugin='@terminal_exec' AND state='failed'").get().count,1);
  }finally{f.close();}
});

test('terminal cannot return success when the lease expires while command runs',async()=>{
  const f=setup();try{
    const lease=f.store.grantHostHour(EMAIL);
    // Lease has less than 400ms remaining, so the running process must be stopped.
    const t=Date.now()-3600000+300;
    f.store.db.prepare('UPDATE js_host_direct_leases SET created=?, expires=? WHERE id=?').run(t,t+3600000,lease);
    const run=executeHostTerminal(f.conf,f.store,EMAIL,{
      shell:'exec',command:process.execPath,args:['-e','setInterval(()=>{},1000)'],timeout_seconds:10
    });
    await assert.rejects(run,/expired|time limit/);
  }finally{f.close();}
});
