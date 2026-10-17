/**
 * QA-only full gateway -> approval -> Sandboxie E2E.
 * Uses ephemeral loopback JWKS signed RS256 JWT with an isolated staging process.
 * Never uses a production Access token or edits production .env / DB.
 */
import {createServer as createHttpsServer} from 'node:https';
import {createServer as createTcpServer} from 'node:net';
import {generateKeyPairSync, randomBytes} from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {SignJWT} from 'jose';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {Store} from '../../src/store.ts';
import {canonical, hash, paramsHash} from '../../src/policy.ts';

const base=resolve('.');
const sandboxExe='C:\\Program Files\\Sandboxie-Plus\\Start.exe';
const opensslExe='C:\\Program Files\\Git\\usr\\bin\\openssl.exe';
const nodeExe='C:\\Program Files\\nodejs\\node.exe';
const stage=mkdtempSync(join(tmpdir(),'asterline-qa-e2e-'));
const stamp=new Date().toISOString().replace(/[:.]/g,'-');
const reportPath=join(base,'qa-reports','e2e-'+stamp+'.json');
const report={started:new Date().toISOString(),scope:'isolated staged MCP, synthetic verified JWT, dedicated AsterlineQATest',checks:[],failures:[]};
const mark=(name,detail='')=>{report.checks.push({name,detail});console.log('[PASS] '+name+(detail?' - '+detail:''));};
const requireTrue=(v,msg)=>{if(!v)throw Error(msg);};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
let child=null,jwksServer=null,startedSandbox=false,safeToTerminate=false;
function listPids(){
 const r=spawnSync(sandboxExe,['/box:AsterlineQATest','/listpids'],{cwd:base,encoding:'utf8',windowsHide:true,timeout:6000});
 if(r.status!==0)throw Error('Cannot check QA box: '+String(r.stderr||r.error));
 const v=String(r.stdout).trim().split(/\s+/).filter(Boolean).map(Number);
 if(!v.length||v.some(x=>!Number.isSafeInteger(x))||v[0]!==v.length-1)throw Error('Bad Sandboxie PID listing '+r.stdout);
 return v.slice(1);
}
const reservePort=async()=>{
 const s=createTcpServer();await new Promise((ok,fail)=>{s.once('error',fail);s.listen(0,'127.0.0.1',ok);});
 const port=s.address().port;await new Promise(ok=>s.close(ok));return port;
};
const decode=(body)=>{
 if(body.trimStart().startsWith('{'))return JSON.parse(body);
 for(const fragment of body.split(/\r?\n\r?\n/)){
  const data=fragment.split(/\r?\n/).filter(x=>x.startsWith('data:')).map(x=>x.slice(5).trimStart()).join('\n');
  if(data){try{return JSON.parse(data)}catch{}}
 }
 throw Error('Cannot parse MCP transport '+body.slice(0,120));
};
let reqId=0,token='',mcpPort=0,adminPort=0,adminPassword='';
async function mcp(method,params={},withAuth=true){
 const headers={'content-type':'application/json','accept':'application/json, text/event-stream'};
 if(withAuth)headers['cf-access-jwt-assertion']=token;
 const res=await fetch('http://127.0.0.1:'+mcpPort+'/',{
  method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:++reqId,method,params}),signal:AbortSignal.timeout(30000)
 });
 const body=await res.text();
 return {status:res.status,message:res.ok?decode(body):{error:body.slice(0,200)}};
}
async function callTool(name,args={},withAuth=true){
 const {status,message}=await mcp('tools/call',{name,arguments:args},withAuth);
 requireTrue(status===200&&!message.error,'MCP call failed '+name+': '+status+' '+JSON.stringify(message.error));
 return message.result;
}
function resultObject(result){
 const t=result.content?.find(x=>x.type==='text')?.text;
 if(typeof t!=='string')throw Error('Missing MCP tool text');
 try {return JSON.parse(t)}catch {throw Error('Unparsable tool response '+t.slice(0,300))}
}
async function admin(pathName,opts={}){
 const headers={Authorization:'Basic '+Buffer.from('admin:'+adminPassword).toString('base64'),...opts.headers};
 return await fetch('http://127.0.0.1:'+adminPort+pathName,{method:opts.method||'GET',headers,body:opts.body,redirect:'manual',signal:AbortSignal.timeout(75000)});
}
let csrf='';
async function action(kind,id){
 const res=await admin('/action',{method:'POST',headers:{Origin:'http://127.0.0.1:'+adminPort,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,kind,id}).toString()});
 const txt=await res.text();
 requireTrue(res.status===303,'Admin action '+kind+' failed: '+res.status+' '+txt.slice(0,400));
}
async function waitForStage(){
 for(let i=0;i<125;i++){
  if(child.exitCode!==null)throw Error('Staging process exited '+child.exitCode);
  try{const res=await fetch('http://127.0.0.1:'+adminPort+'/',{signal:AbortSignal.timeout(400)});if(res.status===401)return;}catch{}
  await delay(150);
 }
 throw Error('Staging server startup timeout');
}
async function run(){
 requireTrue(!listPids().length,'Dedicated QA sandbox not initially empty; refusing test');
 safeToTerminate=true;
 const certFile=join(stage,'ca.crt'),keyFile=join(stage,'ca.key');
 const openssl=spawnSync(opensslExe,['req','-x509','-newkey','rsa:2048','-sha256','-nodes','-days','1','-keyout',keyFile,'-out',certFile,'-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1','-addext','basicConstraints=critical,CA:TRUE'],{encoding:'utf8',windowsHide:true,timeout:15000});
 requireTrue(openssl.status===0&&existsSync(certFile),'Ephemeral local cert generation failed: '+(openssl.stderr||'').slice(-200));
 const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
 const jwk=publicKey.export({format:'jwk'}),kid='qa-e2e-'+randomBytes(4).toString('hex');
 Object.assign(jwk,{kid,use:'sig',alg:'RS256'});
 jwksServer=createHttpsServer({key:readFileSync(keyFile),cert:readFileSync(certFile)},(req,res)=>{
  if(req.url!=='/cdn-cgi/access/certs'){res.writeHead(404).end();return;}
  res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({keys:[jwk]}));
 });
 await new Promise((ok,fail)=>{jwksServer.once('error',fail);jwksServer.listen(0,'127.0.0.1',ok)});
 const issuer='https://127.0.0.1:'+jwksServer.address().port;
 const audience='qa-e2e-aud';
 const owner='qa-e2e@example.test';
 token=await new SignJWT({email:owner}).setProtectedHeader({alg:'RS256',kid}).setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime('10m').sign(privateKey);
 mark('Ephemeral test identity provisioned','RS256 JWKS over localhost TLS; no production credentials');

 const workspace=join(stage,'workspace'),dataDir=join(stage,'store');
 mkdirSync(workspace,{recursive:true});mkdirSync(dataDir,{recursive:true});
 mcpPort=await reservePort();adminPort=await reservePort();const publicPort=await reservePort();
 adminPassword=randomBytes(32).toString('hex');
 const env={};
 for(const k of ['PATH','Path','SystemRoot','WINDIR','TEMP','TMP','USERPROFILE','HOME','APPDATA','LOCALAPPDATA','ProgramFiles','ProgramFiles(x86)','COMSPEC','PATHEXT'])if(process.env[k])env[k]=process.env[k];
 Object.assign(env,{
  MCP_PORT:String(mcpPort),ADMIN_LOCAL_PORT:String(adminPort),ADMIN_PUBLIC_PORT:String(publicPort),
  ADMIN_PUBLIC_HOST:'mcpadmin.asterline.dev',ADMIN_PASSWORD:adminPassword,MCP_DATA_DIR:dataDir,MCP_WORKSPACE_ROOT:workspace,
  CF_TEAM_DOMAIN:issuer,CF_ACCESS_AUD:audience,CF_ADMIN_AUD:'',MCP_ALLOWED_EMAILS:owner,
  GOTIFY_APP_TOKEN:'',GOTIFY_LOCAL_URL:'http://127.0.0.1:1',
  SANDBOX_POLICY_CONFIRMED:'1',SANDBOXIE_START:sandboxExe,SANDBOXIE_BOX:'AsterlineQATest',
   SANDBOXIE_BOX_ROOT:process.env.SANDBOXIE_BOX_ROOT||join('C:\\Sandbox',process.env.USERNAME||'YourName','AsterlineQATest'),NODE_EXE:nodeExe,MAX_PLUGIN_SECONDS:'15',
  NODE_EXTRA_CA_CERTS:certFile
 });
 const output=[];
 child=spawn(nodeExe,['src/server.ts'],{cwd:base,env,windowsHide:true,stdio:['ignore','pipe','pipe'],shell:false});
 for(const fd of [child.stdout,child.stderr])fd.on('data',data=>{output.push(data.toString().slice(0,1500));if(output.length>20)output.shift();});
 await waitForStage();
 mark('Isolated real MCP server started','unique ports and temporary workspace/DB; sandboxReady expected');
 let sr=await admin('/status.json');
 requireTrue(sr.status===200,'Staging admin status failed');
 const status=await sr.json();
 requireTrue(status.sandboxReady===true&&status.features.approval_required===true,'Staging sandbox or approvals not active');
 mark('Staging sandbox is ready while production remains untouched');

 const noJwt=await callTool('plugin_catalog',{},false);
 requireTrue(noJwt.isError===true,'Unverified MCP identity was accepted');
 const bogus=await fetch('http://127.0.0.1:'+mcpPort+'/',{
  method:'POST',headers:{'content-type':'application/json','accept':'application/json','cf-access-jwt-assertion':'not-a-valid-jwt'},
  body:JSON.stringify({jsonrpc:'2.0',id:++reqId,method:'tools/list',params:{}})
 });
 requireTrue(bogus.status===401,'Invalid JWT accepted by gateway: '+bogus.status);
 mark('Missing/invalid Access identity rejected');

 const catalog=await callTool('plugin_catalog');
 requireTrue(resultObject(catalog).plugins.length===0,'Staging catalog not empty');
 mark('Real signed JWT authenticated against isolated JWKS');

 const manifest=readFileSync('examples/qa/zod.manifest.json','utf8');
 const source=readFileSync('examples/qa/zod.mjs','utf8');
 const proposed=await callTool('plugin_propose',{manifest_json:manifest,source});
 requireTrue(resultObject(proposed).status==='draft','Propose did not create draft');
 mark('MCP plugin_propose created draft');

 const response=await admin('/plugins');
 const html=await response.text();
 csrf=html.match(/name="csrf" value="([a-f0-9]{64})"/)?.[1];
 requireTrue(response.status===200&&csrf,'Admin CSRF token missing');
 await action('preflight','qa_zod_v1');
 await action('install','qa_zod_v1');
 mark('Admin npm preflight + audited pinned install completed');
 await action('publish','qa_zod_v1');
 const tools=(await mcp('tools/list')).message.result.tools;
 requireTrue(tools.some(x=>x.name==='qa_zod_parse'),'Published plugin not discovered');
 mark('Admin hot-publish discovered over authenticated MCP');
 const input={label:'QA E2E through Sandboxie'};
 const unauthorized=await callTool('qa_zod_parse',{input});
 requireTrue(unauthorized.isError===true,'Plugin unexpectedly ran without approval');
 const req=await callTool('approval_request',{plugin_id:'qa_zod_v1',parameters_json:JSON.stringify(input),reason:'QA-only verified end-to-end sandbox plugin call'});
 const approvalId=resultObject(req).approval_id;
 requireTrue(!!approvalId,'No approval ticket');
 const firstStatus=resultObject(await callTool('approval_status',{approval_id:approvalId}));
 requireTrue(firstStatus.state==='pending','Approval not pending');
 await action('approve',approvalId);
 requireTrue(resultObject(await callTool('approval_status',{approval_id:approvalId})).state==='approved','Admin approval did not take');
 mark('One-time exact plugin approval via real MCP + admin page');

 const wrong=await callTool('qa_zod_parse',{input:{label:'tampered'},approval_id:approvalId});
 requireTrue(wrong.isError===true,'Mismatched approval allowed plugin call');
 requireTrue(resultObject(await callTool('approval_status',{approval_id:approvalId})).state==='approved','Mismatched input consumed valid ticket');
 mark('Wrong parameters rejected without consuming ticket');

 startedSandbox=true;
 const done=await callTool('qa_zod_parse',{input,approval_id:approvalId});
 requireTrue(!done.isError,'Sandbox plugin failed: '+JSON.stringify(done).slice(0,650));
 const doneObj=resultObject(done);
 requireTrue(doneObj?.result?.label===input.label,'Sandbox result incorrect: '+JSON.stringify(doneObj));
 requireTrue(typeof doneObj.task_id==='string','Sandbox returned no run ID');
 mark('Approved MCP plugin invoked real Sandboxie and returned result','run '+doneObj.task_id);
 requireTrue(resultObject(await callTool('approval_status',{approval_id:approvalId})).state==='consumed','Approval not consumed');
 const replay=await callTool('qa_zod_parse',{input,approval_id:approvalId});
 requireTrue(replay.isError===true,'Approval replay accepted');
 mark('Consumed ticket rejected on replay');
 await action('disable','qa_zod_v1');
 const afterward=(await mcp('tools/list')).message.result.tools;
 requireTrue(!afterward.some(t=>t.name==='qa_zod_parse'),'Disabled plugin still exposed');
 mark('Admin hot-disable removed dynamic MCP tool');
 const runs=new Store(dataDir);
 try {
  const row=runs.db.prepare('SELECT state,owner FROM js_runs WHERE id=?').get(doneObj.task_id);
  requireTrue(row?.state==='finished'&&row?.owner===owner,'Staging run record incorrect');
 } finally {runs.close();}
 requireTrue(listPids().length===0,'QA sandbox left processes after execution');
 mark('Staging run record and sandbox process cleanup verified');
}
try {await run()}catch(error){
 const msg=String(error?.stack||error);
 report.failures.push(msg.slice(0,2500));
 console.error('[FAIL] '+msg.slice(0,2500));
 process.exitCode=1;
}finally{
 if(child&&child.exitCode===null){
  child.kill('SIGTERM');
  await Promise.race([new Promise(ok=>child.once('close',ok)),delay(3500)]);
  if(child.exitCode===null){child.kill('SIGKILL');await delay(400);}
 }
 if(jwksServer)await new Promise(ok=>jwksServer.close(()=>ok()));
 if(safeToTerminate){
  try{
   let p=listPids();
   if(p.length){console.log('[CLEANUP] stopping '+p.length+' QA sandbox processes');
    const r=spawnSync(sandboxExe,['/box:AsterlineQATest','/terminate'],{timeout:10000,encoding:'utf8'});
    requireTrue(r.status===0,'QA sandbox termination command failed');
    await delay(650);p=listPids();
   }
   requireTrue(p.length===0,'QA sandbox cleanup not verified; residual '+p);
   mark('Final QA sandbox empty');
  }catch(e){report.failures.push('QA cleanup: '+String(e));process.exitCode=1;console.error('[FAIL] '+String(e))}
 }
 report.finished=new Date().toISOString();
 try{
  mkdirSync(join(base,'qa-reports'),{recursive:true});
  writeFileSync(reportPath,JSON.stringify(report,null,2));
  console.log('REPORT='+reportPath);
 }catch(e){console.error('Report save failed '+e);process.exitCode=1}
 try{rmSync(stage,{recursive:true,force:true});console.log('STAGING_TEMP_CLEANED=true');}
 catch(e){console.error('Staging cleanup failed '+e);process.exitCode=1}
 console.log('SUMMARY='+JSON.stringify({passed:report.checks.length,failed:report.failures.length}));
}
