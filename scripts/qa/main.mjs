/**
 * Asterline Node v1.6 QA suite.
 * Default run NEVER talks to Cloudflare, installs npm packages, executes plugins,
 * changes a production DB, or enables Sandboxie.
 * Run from repo root: node scripts/qa/main.mjs all [--online] [--sandbox]
 */
import {spawn,execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir,homedir} from 'node:os';
import path,{resolve,join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {throws as assertThrows} from 'node:assert/strict';
import {createServer as createTcpServer,connect as netConnect} from 'node:net';
import {createServer as createHttpServer} from 'node:http';
import dgram from 'node:dgram';
import {loadDotEnv,configFromEnv} from '../../src/config.ts';
import {Store} from '../../src/store.ts';
import {validateManifest,validateSource,canonical,hash,paramsHash} from '../../src/policy.ts';
import {notify} from '../../src/notifier.ts';
import {executeSandbox,sandboxReady,command} from '../../src/runner.ts';
import {listBoxPids} from '../../src/sandbox-supervisor.ts';
import {checkQaPolicyFile} from './sandbox-policy.mjs';
const root=resolve('.');
const commands=new Set(['all','unit','staging','diagnose','sandbox']);
const argv=process.argv.slice(2);const mode=commands.has(argv[0])?argv[0]:'all';
const online=argv.includes('--online'),sandbox=argv.includes('--sandbox');
const keep=argv.includes('--keep');const notifyFlag=argv.includes('--notify');
const report={timestamp:new Date().toISOString(),mode,online,sandbox,checks:[],skipped:[],errors:[]};
const record=(name,result,note='')=>{report.checks.push({name,result,note});console.log(`${result==='PASS'?'[PASS]':result==='SKIP'?'[SKIP]':'[FAIL]'} ${name}${note?' — '+note:''}`);if(result==='FAIL')report.errors.push({name,note});};
const skip=(name,note)=>{report.skipped.push({name,note});record(name,'SKIP',note);};
const assert=(cond,msg)=>{if(!cond)throw Error(msg);};
function fixture(name){const dir=join(root,'examples','qa');return {manifest:validateManifest(JSON.parse(readFileSync(join(dir,`${name}.manifest.json`),'utf8'))),source:readFileSync(join(dir,`${name}.mjs`),'utf8')};}
function seed(db,name){const {manifest,source}=fixture(name);validateSource(source);db.create({id:manifest.id,name:manifest.name,owner:'qa-staging-only',manifest:canonical(manifest),source,digest:hash(canonical(manifest)+'\n'+source)});return manifest;}
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function freePort(){return await new Promise((ok,fail)=>{const s=createTcpServer();s.once('error',fail);s.listen(0,'127.0.0.1',()=>{const {port}=s.address();s.close(()=>ok(port));});});}
async function runUnit(){const {code,output}=await launch(process.execPath,[...(Number(process.versions.node.split('.')[0])<24?['--experimental-strip-types']:[]),'--test','scripts/qa/unit.test.mjs'],root,process.env,40000);console.log(output.slice(-5000));assert(code===0,'Unit tests failed');record('offline unit + approval + manifest + lockfile','PASS');}
function launch(program,args,cwd,env,timeout){return new Promise((ok,fail)=>{const child=spawn(program,args,{cwd,env,windowsHide:true,stdio:['ignore','pipe','pipe'],shell:false});let output='';const timer=setTimeout(()=>{child.kill();},timeout);child.stdout.on('data',c=>output+=c.toString().slice(0,10000));child.stderr.on('data',c=>output+=c.toString().slice(0,10000));child.once('error',e=>{clearTimeout(timer);fail(e);});child.once('close',code=>{clearTimeout(timer);ok({code,output:output.slice(-20000)});});});}
function parseMcp(body){if(body.trimStart().startsWith('{'))return JSON.parse(body);for(const block of body.split(/\r?\n\r?\n/)){const ds=block.split(/\r?\n/).filter(s=>s.startsWith('data:')).map(x=>x.slice(5).trimStart()).join('\n');if(!ds)continue;try{const obj=JSON.parse(ds);if(obj.result||obj.error)return obj;}catch{}}throw Error('Cannot decode MCP JSON/SSE');}
let reqID=0;
async function mcp(port,method,params={}){const r=await fetch(`http://127.0.0.1:${port}/`,{method:'POST',headers:{'content-type':'application/json','accept':'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:++reqID,method,params}),signal:AbortSignal.timeout(20000)});const body=await r.text();assert(r.ok,`MCP HTTP ${r.status}: ${body.slice(0,300)}`);const msg=parseMcp(body);assert(!msg.error,`MCP error: ${JSON.stringify(msg.error)}`);return msg.result;}
async function adminFetch(port,pw,pathName,options={}){const headers={Authorization:'Basic '+Buffer.from('admin:'+pw).toString('base64'),...options.headers};return fetch(`http://127.0.0.1:${port}${pathName}`,{method:options.method||'GET',headers,body:options.body,redirect:'manual',signal:AbortSignal.timeout(options.timeout||20000)});}
async function postAction(port,pw,csrf,kind,id){const r=await adminFetch(port,pw,'/action',{method:'POST',headers:{Origin:`http://127.0.0.1:${port}`,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,kind,id}).toString(),timeout:360000});const b=await r.text();assert(r.status===303,`${kind} failed HTTP ${r.status}: ${b.slice(0,1200)}`);return r;}
async function waitForServer(port,child,output){for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error('staging server exited: '+output());try{const r=await fetch(`http://127.0.0.1:${port}/`,{signal:AbortSignal.timeout(600)});if(r.status===401)return;}catch{}await pause(150);}throw Error('Staging server did not start: '+output());}
async function runStaging(){
  const stageRoot=mkdtempSync(join(tmpdir(),'asterline-qa-stage-'));
  const mcpPort=await freePort(),adminPort=await freePort(),publicPort=await freePort();
  const pw=randomBytes(32).toString('hex');
  const db=new Store(stageRoot);try{seed(db,online?'zod':'probe');}finally{db.close();}
  const env={};for(const k of ['PATH','Path','SystemRoot','WINDIR','TEMP','TMP','USERPROFILE','HOME','APPDATA','LOCALAPPDATA','ProgramFiles','ProgramFiles(x86)','COMSPEC','PATHEXT'])if(process.env[k])env[k]=process.env[k];
  Object.assign(env,{MCP_PORT:String(mcpPort),ADMIN_LOCAL_PORT:String(adminPort),ADMIN_PUBLIC_PORT:String(publicPort),ADMIN_PUBLIC_HOST:'mcpadmin.asterline.dev',ADMIN_PASSWORD:pw,MCP_DATA_DIR:stageRoot,CF_TEAM_DOMAIN:'',CF_ACCESS_AUD:'',CF_ADMIN_AUD:'',MCP_ALLOWED_EMAILS:'',GOTIFY_APP_TOKEN:'',GOTIFY_LOCAL_URL:'http://127.0.0.1:1',SANDBOX_POLICY_CONFIRMED:'0',SANDBOXIE_START:'',NODE_EXE:process.execPath});
  let logs='';const child=spawn(process.execPath,[...(Number(process.versions.node.split('.')[0])<24?['--experimental-strip-types']:[]),'src/server.ts'],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe'],shell:false});
  child.stdout.on('data',x=>{logs+=x.toString().slice(0,10000);});child.stderr.on('data',x=>{logs+=x.toString().slice(0,10000);});
  try{
    await waitForServer(adminPort,child,()=>logs);
    record('separate local staging instance','PASS',`temporary DB, ports ${mcpPort}/${adminPort}; sandbox disabled`);
    let r=await fetch(`http://127.0.0.1:${adminPort}/`);assert(r.status===401,`Unauth admin should be 401, got ${r.status}`);
    r=await adminFetch(adminPort,pw,'/plugins');assert(r.status===200,'Admin Basic sign-in failed');
    const html=await r.text(), csrf=html.match(/name="csrf" value="([a-f0-9]{64})"/)?.[1];assert(csrf,'CSRF hidden form token missing');
    record('admin Basic + CSRF form discovery','PASS');
    r=await adminFetch(adminPort,pw,'/action',{method:'POST',headers:{Origin:'https://evil.example','content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,kind:'preflight',id:'qa_zod_v1'})});assert(r.status===403,'Forged Origin was accepted');
    r=await adminFetch(adminPort,pw,'/action',{method:'POST',headers:{Origin:`http://127.0.0.1:${adminPort}`,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf:'wrong',kind:'preflight',id:'qa_zod_v1'})});assert(r.status===403,'Invalid CSRF was accepted');
    record('admin cross-site request controls','PASS');
    const list1=await mcp(mcpPort,'tools/list');assert(!list1.tools.some(x=>x.name==='qa_zod_parse'||x.name==='qa_sandbox_probe'),'Unpublished plugin visible');
    const hello=await mcp(mcpPort,'tools/call',{name:'hello',arguments:{name:'QA'}});assert(JSON.stringify(hello).includes('Hello, QA!'),'Hello failed');
    const blocked=await mcp(mcpPort,'tools/call',{name:'plugin_catalog',arguments:{}});assert(blocked.isError===true,'Unauthenticated private catalog should be blocked');
    record('MCP anonymous hello + unpublished tool + privilege guard','PASS');
    r=await adminFetch(adminPort,pw,'/sandboxes');const sandboxHtml=await r.text();assert(sandboxHtml.includes('未解锁')||sandboxHtml.includes('锁定'),'Staging sandbox unexpectedly enabled');
    record('stage sandbox default locked','PASS');
    // Exercise the real admin /approvals form using a staging-only synthetic request.
    const fakeParams={name:'stage-only'};
    let approvalId;
    {const s=new Store(stageRoot);try{approvalId=s.request('qa-staging-agent','qa_fake_plugin',paramsHash(fakeParams),canonical(fakeParams),'Automated QA approval',300);}finally{s.close();}}
    r=await adminFetch(adminPort,pw,'/approvals');const apPage=await r.text();assert(apPage.includes(approvalId),'Staging approval not shown to admin');
    await postAction(adminPort,pw,csrf,'approve',approvalId);
    {const s=new Store(stageRoot);try{s.consume(approvalId,'qa-staging-agent','qa_fake_plugin',paramsHash(fakeParams));assertThrows(()=>s.consume(approvalId,'qa-staging-agent','qa_fake_plugin',paramsHash(fakeParams)), /consumed|approved|expired|mismatched|Missing/i, 'One-time approval must reject a second use');}finally{s.close();}}
    record('admin mobile approval page → approve → one-time consume','PASS');
    if(online){
      const id='qa_zod_v1';
      await postAction(adminPort,pw,csrf,'preflight',id);record('real npm lockfile + audit preflight','PASS');
      {const s=new Store(stageRoot);try{const p=s.get(id);assert(p?.state==='reviewed','Plugin not reviewed');const report=JSON.parse(p.report);assert(report.count>=1,'Dependency list empty');assert(report.lockHash?.length===64,'Lock hash missing');}finally{s.close();}}
      await postAction(adminPort,pw,csrf,'install',id);record('approved npm ci --ignore-scripts','PASS');
      {const s=new Store(stageRoot);try{assert(s.get(id)?.state==='installed','Not installed');}finally{s.close();}}
      await postAction(adminPort,pw,csrf,'publish',id);
      const list2=await mcp(mcpPort,'tools/list');assert(list2.tools.some(x=>x.name==='qa_zod_parse'),'Published dynamic tool missing');
      const noApproval=await mcp(mcpPort,'tools/call',{name:'qa_zod_parse',arguments:{input:{label:'qa'}}});assert(noApproval.isError===true,'QA plugin ran without approval!');
      record('hot publish + tool catalog + approval required','PASS');
      await postAction(adminPort,pw,csrf,'disable',id);
      const list3=await mcp(mcpPort,'tools/list');assert(!list3.tools.some(x=>x.name==='qa_zod_parse'),'Disabled tool still visible');
      record('hot disable without restart','PASS');
    }else skip('npm online preflight, install, hot publish','Add --online; uses isolated staging DB and official npm Registry');
    return {stageRoot,logs:logs.slice(-3000)};
  }finally{
    child.kill();await Promise.race([new Promise(r=>child.once('close',r)),pause(5000)]);
    if(keep){record('keep QA staging data','PASS',stageRoot);}else rmSync(stageRoot,{recursive:true,force:true});
  }
}
async function diagnose(){loadDotEnv();const conf=configFromEnv();
  console.log(`Node ${process.version} · ${process.platform}; project ${root}`);
  record('server version / root','PASS',`Node ${process.version}`);
  record('sandbox policy',conf.sandboxConfirmed?'PASS':'SKIP',conf.sandboxConfirmed?'Enabled by user':'Disabled (safe default)');
  if(!conf.sandboxConfirmed)report.skipped.push({name:'sandbox policy',note:'Disabled'});
  console.log('Configured paths only; passwords, Access JWTs and Gotify tokens are NOT displayed.');
  console.log(`Sandboxie binary exists: ${Boolean(conf.sandboxieStart&&existsSync(conf.sandboxieStart))}; named box: ${conf.sandboxieBox}`);
  const port=conf.localAdminPort;
  try{const r=await fetch(`http://127.0.0.1:${port}/`,{signal:AbortSignal.timeout(1600)});record('existing local admin reachable',r.status===401?'PASS':'FAIL',`HTTP ${r.status} on ${port}`);}catch{skip('existing local admin',`Not reachable on ${port} (not a blocker for isolated staging)`);}
}
async function runSandbox(){
  if(!sandbox){skip('Sandboxie live probe','Explicit --sandbox required');return;}
  loadDotEnv();const conf=configFromEnv();const qaBox=process.env.QA_SANDBOX_BOX||'AsterlineQATest';
  assert(qaBox==='AsterlineQATest','QA_SANDBOX_BOX must be AsterlineQATest; dedicated sandbox required');
  assert(process.env.QA_POLICY_CONFIRMED==='1','After manually reviewing the dedicated QA box, set QA_POLICY_CONFIRMED=1 only in this PowerShell session. Keep SANDBOX_POLICY_CONFIRMED=0 in .env.');
  // An explicit QA-only box root is verified below, before executing the worker.
  assert(Boolean(conf.sandboxieStart&&existsSync(conf.sandboxieStart)&&existsSync(conf.nodeExe)),'Sandboxie Start.exe or node.exe missing');
  const policyFile=(process.env.QA_SANDBOX_INI||'').trim();
  assert(policyFile&&existsSync(policyFile),'Set QA_SANDBOX_INI to the active Sandboxie.ini before live sandbox tests; never use SandMan.ini');
  const policy=checkQaPolicyFile(policyFile,qaBox);
  assert(policy.ok,'Sandboxie.ini QA baseline failed: '+policy.errors.join(' | '));
  record('QA sandbox static hardening baseline','PASS','AutoRecover off; network deny + WFP configured; active probes still required');
  const qaRoot=(process.env.QA_SANDBOX_ROOT||'').trim();
  assert(qaRoot&&existsSync(qaRoot),'Set QA_SANDBOX_ROOT to the physical FileRootPath of AsterlineQATest (Sandboxie UI -> Explore Contents), without changing production policy.');
  // Unique directory per invocation: no stale result collisions or unsafe recursive cleanup.
  const work=mkdtempSync(join(root,'.qa-sandbox-runtime-'));
  const privateDir=join(homedir(),'AsterlineQA_Private');mkdirSync(privateDir,{recursive:true});
  const marker=join(privateDir,`.qa-private-denied-${randomBytes(6).toString('hex')}.txt`);
  const forbidden=join(privateDir,`.qa-should-not-persist-${randomBytes(6).toString('hex')}.txt`);
  writeFileSync(marker,'DO_NOT_LEAK_QA_MARKER');
  const netServer=createHttpServer((req,res)=>{res.writeHead(200);res.end('QA_NETWORK_REACHABLE');});
  await new Promise(r=>netServer.listen(0,'127.0.0.1',r));
  const probeUrl=`http://127.0.0.1:${netServer.address().port}/probe`;
  const udpServer=dgram.createSocket('udp4');
  udpServer.on('message',(m,r)=>{if(m.toString()==='QA_PING')udpServer.send('QA_PONG',r.port,r.address);});
  await new Promise((ok,fail)=>{udpServer.once('error',fail);udpServer.bind(0,'127.0.0.1',ok);});
  const udpPort=udpServer.address().port;
  const c={...conf,data:work,sandboxieBox:qaBox,sandboxieBoxRoot:qaRoot,sandboxConfirmed:true,gotifyToken:'',gotify:'http://127.0.0.1:1',maxPluginSeconds:15};
  try{
    // OS-only probe: run via Sandboxie WITHOUT Node --permission, so this checks actual Sandboxie resource rules.
    const cleanEnv={};for(const k of ['PATH','Path','SystemRoot','WINDIR','TEMP','TMP','USERPROFILE','HOME','APPDATA','LOCALAPPDATA'])if(process.env[k])cleanEnv[k]=process.env[k];
    const externalHost=process.env.QA_EXTERNAL_HOST||'1.1.1.1',externalPort=Number(process.env.QA_EXTERNAL_PORT||'443');
    assert(!/^(127\.|localhost$|::1$)/i.test(externalHost)&&Number.isInteger(externalPort)&&externalPort>0&&externalPort<65536,'Choose a non-loopback reachable QA_EXTERNAL_HOST and port');
    const hostCanConnect=await new Promise(ok=>{const socket=netConnect({host:externalHost,port:externalPort});let done=false;const end=v=>{if(done)return;done=true;socket.destroy();ok(v);};socket.once('connect',()=>end(true));socket.once('error',()=>end(false));socket.setTimeout(2500,()=>end(false));});
    assert(hostCanConnect,`Host cannot connect to ${externalHost}:${externalPort}: sandbox denial would be inconclusive. Choose a reachable non-loopback target.`);
    record('non-loopback network positive control','PASS',`${externalHost}:${externalPort} reachable on host before sandbox denial`);
    const osProbe=await launch(conf.sandboxieStart,[`/box:${qaBox}`,'/wait',conf.nodeExe,join(root,'scripts','qa','sandbox-os-probe.mjs'),marker,forbidden,probeUrl,externalHost,String(externalPort),String(udpPort)],root,cleanEnv,20000);
    assert(osProbe.code===16,`Sandboxie OS boundary probe failed (exit=${osProbe.code}, expected 16; +1=private file readable, +2=loopback TCP, +4=external TCP, +8=loopback UDP reachable). ${osProbe.output.slice(0,400)}`);
    assert(!existsSync(forbidden),'OS-only sandbox write appeared on host outside sandbox');
    record('Sandboxie OS-only: private marker, loopback TCP+UDP, external TCP, host-write denial','PASS');
    const s=new Store(c.data);
    try{
      const m=seed(s,'probe');s.transition(m.id,['draft'],'reviewed',JSON.stringify({qaOnly:true}));s.transition(m.id,['reviewed'],'installed');s.transition(m.id,['installed'],'active');
      const release=join(c.data,'releases',m.id);mkdirSync(release,{recursive:true});writeFileSync(join(release,'tool.mjs'),fixture('probe').source);
      // This directly tests the runner only. The gateway's mobile approval is separately tested by unit tests.
      const response=await executeSandbox(c,s,'qa-local-direct-runner',m.id,{markerFile:marker,forbiddenOutput:forbidden,probeUrl});
      const v=response.result;assert(v?.readBlocked===true,'QA private marker was readable');assert(v?.networkBlocked===true,'QA loopback network probe was reachable');
      assert(!existsSync(forbidden),'Sandbox write appeared on host outside scratch');
      record('real Sandboxie + Node permission: marker/network/write denial','PASS',`task ${response.task_id}`);
      // Force a genuine timeout to test /terminate + /listpids, not only launcher kill.
      const hang=seed(s,'hang');s.transition(hang.id,['draft'],'reviewed',JSON.stringify({qaOnly:true}));
      s.transition(hang.id,['reviewed'],'installed');s.transition(hang.id,['installed'],'active');
      const hangDir=join(c.data,'releases',hang.id);mkdirSync(hangDir,{recursive:true});
      writeFileSync(join(hangDir,'tool.mjs'),fixture('hang').source);
      let timeoutError='';
      try{await executeSandbox({...c,maxPluginSeconds:3},s,'qa-timeout-owner',hang.id,{});}catch(e){timeoutError=String(e);}
      assert(/timed_out/.test(timeoutError),`Timed-out QA worker not reported as timed_out: ${timeoutError.slice(0,300)}`);
      const row=s.db.prepare('SELECT state FROM js_runs WHERE plugin=? ORDER BY started DESC LIMIT 1').get(hang.id);
      assert(row?.state==='timed_out',`Timeout run state not persisted (got ${row?.state})`);
      const pids=await listBoxPids(qaBox,(args,ms)=>command(c.sandboxieStart,args,root,ms,4000));
      assert(pids.length===0,`Sandbox still contains processes after timeout: ${pids.join(',')}`);
      record('real timed-out Node worker: /terminate and empty /listpids','PASS');
    }finally{s.close();}
    console.log('OS-only probe tests Sandboxie itself; runner probe separately tests Sandboxie plus Node permissions.');
  }finally{netServer.close();udpServer.close();if(existsSync(marker))rmSync(marker);if(existsSync(forbidden))rmSync(forbidden);if(!keep)rmSync(work,{recursive:true,force:true});}
}
async function sendTestNotification(){
  if(!notifyFlag)return;
  loadDotEnv();const c=configFromEnv();
  if(!c.gotifyToken){skip('Gotify test notification','No GOTIFY_APP_TOKEN configured');return;}
  const ok=await notify(c,'Asterline · QA 测试','Node v1.6 QA 明确请求的测试通知；无需操作。',3);
  assert(ok,'Gotify did not accept QA test notification on local origin');record('Gotify local notification','PASS');
}
async function main(){try{
  if(mode==='all'||mode==='diagnose')await diagnose();
  if(mode==='all'||mode==='unit')await runUnit();
  if(mode==='all'||mode==='staging')await runStaging();
  if(mode==='all'||mode==='sandbox')await runSandbox();
  if(mode==='all')await sendTestNotification();
}catch(e){record('suite stopped','FAIL',String(e?.stack||e).slice(0,1300));process.exitCode=1;}
finally{const dir=join(root,'qa-reports');mkdirSync(dir,{recursive:true});const file=join(dir,`qa-${new Date().toISOString().replace(/[:.]/g,'-')}.json`);writeFileSync(file,JSON.stringify(report,null,2));console.log(`\nReport: ${file}`);console.log(`Summary: ${report.checks.filter(x=>x.result==='PASS').length} passed, ${report.errors.length} failed, ${report.skipped.length} skipped`);if(report.errors.length)process.exitCode=1;}}
await main();
