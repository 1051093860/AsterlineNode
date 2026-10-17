import { createServer } from 'node:http';
import { readFileSync,existsSync } from 'node:fs';
import { resolve } from 'node:path';
import os from 'node:os';
import { McpServer,createMcpHandler } from '@modelcontextprotocol/server';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import * as z from 'zod/v4';
import { loadDotEnv,configFromEnv } from './config.ts';
import { Store } from './store.ts';
import {loadRuntimeSettings} from './runtime-settings.ts';
import {AccessAuth} from './auth.ts';
import {validateManifest,validateSource,hash,canonical,paramsHash} from './policy.ts';
import {executeSandbox,sandboxReady,preflight,installApproved} from './runner.ts';
import {notify,initNotifications,stopNotifications} from './notifier.ts';
import {fsList,fsRead,fsWrite,diskInfo,workspaceRoot,workspacePath} from './workspace.ts';
import {JobManager,checkJobInput,jobAuthorizationParams} from './jobs.ts';
import {createAdmin} from './admin.ts';
import {executeHostDirect,stopHostPassJobs} from './host-direct.ts';
import {executeHostTerminal,stopHostTerminalJobs} from './terminal.ts';
import {validateWorkRoot,validateWorkCapabilities,authorizeFileWrite,authorizeBackgroundJob,authorizeSandboxPlugin} from './permission-center.ts';
// @ts-ignore — JS module with testable Node-only transfer spool
import {LibraryBridge} from './library-bridge.mjs';
import {agentStagePath} from './library-stage.mjs';

loadDotEnv();
const conf=configFromEnv();
const store=new Store(conf.data);
loadRuntimeSettings(conf,store);
const auth=new AccessAuth(conf);
initNotifications(conf,store);
const jobs=new JobManager(conf,store);
const library=new LibraryBridge(conf.data);
const reserved=new Set(['hello','system_info','plugin_catalog','plugin_propose','approval_request','approval_status','task_status','notify_send','terminal_exec','fs_list','fs_read','fs_write','task_start','task_logs','task_cancel','library_bridge','library_bridge_list','library_bridge_chunk','library_bridge_mark','library_bridge_import','library_stage','work_request','work_status','work_revoke']);
const text=(s:unknown)=>({content:[{type:'text' as const,text:typeof s==='string'?s:JSON.stringify(s)}]});
const toolError=(e:unknown)=>({content:[{type:'text' as const,text:'Error: '+String(e).slice(0,1000)}],isError:true});

const factory=({authInfo}:any)=>{
  const owner=String(authInfo?.clientId||'');
  const privileged=()=>{if(!owner)throw Error('Verified Cloudflare Access identity required');return owner;};
  const server=new McpServer({name:'Asterline MCP Node',version:'1.9.4-preview.1'}, {capabilities:{tools:{listChanged:true}}});
  const widgetHtml=readFileSync(resolve('public/widget/library-bridge.html'),'utf8');
  const widgetUri=`ui://asterline/library-bridge-${hash(widgetHtml).slice(0,16)}.html`;
  server.registerResource('Asterline Library Bridge',widgetUri,{},async()=>({contents:[{uri:widgetUri,mimeType:'text/html;profile=mcp-app',text:widgetHtml,_meta:{ui:{prefersBorder:true},'openai/widgetDescription':'在 ChatGPT 中手动选择原生 Library 文件，并与 Windows Asterline CLI 传输。'}}]}));
  server.registerTool('hello',{description:'Say hello to a person or agent.',inputSchema:z.object({name:z.string().default('world')})},async({name})=>text(`Hello, ${name}! 来自 Asterline Hello MCP。`));
  server.registerTool('library_bridge',{title:'Asterline Library Bridge',description:'Open the authorized, interactive ChatGPT Library ↔ Windows CLI transfer widget. Library access requires a user action; cloud sync is managed separately by rclone CLI.',inputSchema:z.object({}),_meta:{ui:{resourceUri:widgetUri},'openai/outputTemplate':widgetUri}},async()=>{
    try{const who=privileged();return {...text({mode:'interactive',owner:who,pending:library.list(who).filter((j:any)=>j.state==='waiting_user').length}),structuredContent:{mode:'interactive',pending:library.list(who).filter((j:any)=>j.state==='waiting_user').length}};}catch(e){return toolError(e);}
  });
  server.registerTool('library_stage',{title:'Stage a workspace file for ChatGPT Library',description:'Choose an existing non-secret regular file within the authorized Asterline workspace for transfer into the same user’s ChatGPT Library. Returns a transfer ID and SHA-256; then retrieve the bytes with library_bridge_chunk and upload with ChatGPT Library file tools. No host-wide access or upload to external services.',inputSchema:z.object({path:z.string().min(1).max(2048)})},async({path})=>{
    try{const who=privileged();const checked=agentStagePath(workspaceRoot(conf),path);const job=library.stagePush(checked,who);store.audit(who,'library_stage',`${job.id} ${job.name} (${job.size} bytes)`);return text({transfer_id:job.id,name:job.name,size:job.size,sha256:job.sha256,chunk_bytes:98304,state:job.state,source:'authorized_workspace',next:'Call library_bridge_chunk at offsets 0, 98304, ...; verify SHA-256 before saving into ChatGPT Library.'});}catch(e){return toolError(e);}
  });
  server.registerTool('library_bridge_list',{title:'List owned Library transfers',description:'List Asterline local queue metadata for authenticated owner only; does not enumerate all ChatGPT Library files.',inputSchema:z.object({}),_meta:{'openai/widgetAccessible':true}},async()=>{
    try{const who=privileged();return text({jobs:library.list(who)});}catch(e){return toolError(e);}
  });
  server.registerTool('library_bridge_chunk',{title:'Read staged Asterline file chunk',description:'Read a limited byte-range of a file staged by its owner or by authorized workspace library_stage. Agent may save verified bytes into native ChatGPT Library when supported.',inputSchema:z.object({transfer_id:z.string().uuid(),offset:z.number().int().min(0)}),_meta:{'openai/widgetAccessible':true}},async({transfer_id,offset})=>{
    try{return text(library.chunk(transfer_id,privileged(),offset));}catch(e){return toolError(e);}
  });
  server.registerTool('library_bridge_mark',{title:'Mark client-reported ChatGPT Library upload',description:'Record that the interactive ChatGPT widget reported an upload; not a server-verified ChatGPT Library audit.',inputSchema:z.object({transfer_id:z.string().uuid(),file_id:z.string().max(170)}),_meta:{'openai/widgetAccessible':true}},async({transfer_id,file_id})=>{
    try{return text(library.markUploaded(transfer_id,privileged(),file_id));}catch(e){return toolError(e);}
  });
  server.registerTool('library_bridge_import',{title:'Import authorized ChatGPT file',description:'Receive an explicitly user-selected ChatGPT Library file into the Asterline inbox, for subsequent Windows CLI download. URL host must match server allowlist.',inputSchema:z.object({file:z.object({download_url:z.string().url(),file_id:z.string(),mime_type:z.string().optional(),file_name:z.string().optional()})}),_meta:{'openai/fileParams':['file'],'openai/widgetAccessible':true}},async({file})=>{
    try{const who=privileged();const allowed=conf.libraryFileHosts;const result=await library.importLibraryFile(who,file,{allowedHosts:allowed});store.audit(who,'library_import',`${result.id} ${result.name}`);return text(result);}catch(e){return toolError(e);}
  });

  server.registerTool('system_info',{description:'Read authenticated host, workspace and disk information.',inputSchema:z.object({})},async()=>{try{const who=privileged();store.audit(who,'system_info');return text({host:os.hostname(),platform:process.platform,node:process.version,workspace:workspaceRoot(conf),...diskInfo(conf),catalogRevision:store.revision()});}catch(e){return toolError(e);}});
  server.registerTool('plugin_catalog',{description:'List plugin releases and catalog revision.',inputSchema:z.object({})},async()=>{
    try{privileged();return text({revision:store.revision(),plugins:store.list().map(p=>({id:p.id,tool:JSON.parse(p.manifest).tool.name,state:p.state,revision:p.revision}))});}catch(e){return toolError(e);}
  });
  server.registerTool('plugin_propose',{description:'Submit JS tool source and pinned package manifest for human review; never installs or publishes immediately.',inputSchema:z.object({manifest_json:z.string().max(15000),source:z.string().max(64000)})},async({manifest_json,source})=>{
    try{const who=privileged();const m=validateManifest(JSON.parse(manifest_json));validateSource(source);
      if(reserved.has(m.tool.name)||store.active().some(p=>JSON.parse(p.manifest).tool.name===m.tool.name))throw Error('Duplicate/reserved tool name');
      store.create({id:m.id,name:m.name,owner:who,manifest:canonical(m),source,digest:hash(canonical(m)+'\n'+source)});
      await notify(conf,'Asterline · 插件待审',`${m.name} (${m.id})，打开 https://${conf.publicHost}/plugins`,7);
      return text({id:m.id,status:'draft',requiresAdminReview:true});
    }catch(e){return toolError(e);}
  });
  server.registerTool('work_request',{description:'Request a 60-minute project-scoped development session. Admin approves once; subsequent scoped fs_write and published sandboxed plugin calls do not need approval_id. Not host terminal access.',inputSchema:z.object({
    title:z.string().min(3).max(120),workspace:z.string().max(1024).default('.'),
    capabilities:z.array(z.enum(['fs_write','sandbox_plugin'])).min(1).max(2),
    reason:z.string().min(3).max(800),agent_label:z.string().max(80).default('')
  })},async({title,workspace,capabilities,reason,agent_label})=>{
    try{const who=privileged();const relative=validateWorkRoot(conf,workspace);const caps=validateWorkCapabilities(capabilities);
      const request_id=store.requestWork(who,agent_label,title,relative,caps,reason);
      await notify(conf,'Asterline · 开发任务待审批',`${title}，打开 https://${conf.publicHost}/access`,8,'approval');
      return text({request_id,state:'pending',expires_in:1800,scope:{workspace:relative,capabilities:caps},next:'Use work_status to check. Admin must approve in /access.'});
    }catch(e){return toolError(e);}
  });
  server.registerTool('work_status',{description:'Read own task authorization state and expiration; only the verified owner can read it.',inputSchema:z.object({request_id:z.string().uuid()})},async({request_id})=>{
    try{const who=privileged();return text(store.workStatus(request_id,who));
    }catch(e){return toolError(e);}
  });
  server.registerTool('work_revoke',{description:'Voluntarily revoke own active development session before its fixed expiry.',inputSchema:z.object({})},async()=>{
    try{const who=privileged();const active=store.currentWorkSession(who);if(!active)return text({state:'no_active_session'});
      store.revokeWorkSession(active.id,who);return text({state:'revoked',session_id:active.id});
    }catch(e){return toolError(e);}
  });
  server.registerTool('approval_request',{description:'Request one-time mobile approval for exact plugin or fs_write/task_start arguments.',inputSchema:z.object({plugin_id:z.string().optional(),operation:z.enum(['fs_write','task_start']).optional(),parameters_json:z.string().max(24000),reason:z.string().max(800)})},async({plugin_id,operation,parameters_json,reason})=>{
    try{const who=privileged();
      if(Boolean(plugin_id)===Boolean(operation))throw Error('Specify exactly one of plugin_id or operation');
      const params=JSON.parse(parameters_json);if(!params||typeof params!=='object'||Array.isArray(params))throw Error('Parameters must be JSON object');
      let kind='',display='';
      let approvedParams=params;
      if(plugin_id){const p=store.get(plugin_id);if(!p||p.state!=='active')throw Error('Plugin not active');kind=plugin_id;display=p.name;}
      else if(operation==='fs_write'){
        if(!store.flag('file_write'))throw Error('Legacy file-write switch is disabled');
        if(typeof params.path!=='string'||typeof params.content!=='string'||Buffer.byteLength(params.content)>131072)throw Error('Invalid file request');
        workspacePath(conf,params.path,false);kind='@fs_write';display='fs_write';
      }else if(operation==='task_start'){
        if(!store.flag('command_exec'))throw Error('Host background process switch is disabled');
        const program=checkJobInput(conf,params.program,params.args??[],params.cwd??'.',params.label??'');
        approvedParams=jobAuthorizationParams({program:params.program,args:params.args??[],cwd:params.cwd??'.',label:params.label??''},program);
        kind='@task_start';display='task_start';
      }else throw Error('Unsupported operation');
      const id=store.request(who,kind,paramsHash(approvedParams),canonical(approvedParams),reason,1800);
      await notify(conf,'Asterline · 操作待授权',`${display}，打开 https://${conf.publicHost}/approvals`,8,'approval');
      return text({approval_id:id,state:'pending',expires_in:1800});
    }catch(e){return toolError(e);}
  });
  server.registerTool('approval_status',{description:'Check approval state for a request owned by this identity.',inputSchema:z.object({approval_id:z.string()})},async({approval_id})=>{
    try{const who=privileged();const r=store.db.prepare('SELECT id,state,expires FROM js_approvals WHERE id=? AND owner=?').get(approval_id,who);return text(r||{state:'not_found'});}catch(e){return toolError(e);}
  });
  server.registerTool('fs_list',{description:'List up to 200 workspace items (authenticated).',inputSchema:z.object({path:z.string().default('.')})},async({path})=>{
    try{const who=privileged();const data=fsList(conf,path);store.audit(who,'fs_list',path);return text(data);}catch(e){return toolError(e);}
  });
  server.registerTool('fs_read',{description:'Read UTF-8 file in workspace up to 128 KiB (authenticated).',inputSchema:z.object({path:z.string()})},async({path})=>{
    try{const who=privileged();const data=fsRead(conf,path);store.audit(who,'fs_read',path);return text(data);}catch(e){return toolError(e);}
  });
  server.registerTool('fs_write',{description:'Write UTF-8 inside the authorized project scope. Accepts an active admin-approved work session or an exact one-time approval.',inputSchema:z.object({path:z.string(),content:z.string().max(131072),approval_id:z.string().optional()})},async({path,content,approval_id})=>{
    try{const who=privileged();const via=authorizeFileWrite(store,conf,who,path,content,approval_id);
      const result=fsWrite(conf,path,content);store.audit(who,'fs_write',`${path} via ${via}`);return text({...result,authorization:via});
    }catch(e){return toolError(e);}
  });
  server.registerTool('task_start',{description:'Start any installed host executable by absolute path or PATH program name. Requires the host-task admin switch and exact one-time approval. Development work sessions do NOT grant host execution.',inputSchema:z.object({program:z.string(),args:z.array(z.string()).default([]),cwd:z.string().default('.'),label:z.string().max(80).default(''),approval_id:z.string().optional()})},async({program,args,cwd,label,approval_id})=>{
    try{const who=privileged();const checked=checkJobInput(conf,program,args,cwd,label);
      authorizeBackgroundJob(store,who,jobAuthorizationParams({program,args,cwd,label},checked),approval_id);
      return text(jobs.start(who,program,args,cwd,label,checked));
    }catch(e){return toolError(e);}
  });
  server.registerTool('task_status',{description:'Read own background task or plugin execution state.',inputSchema:z.object({task_id:z.string()})},async({task_id})=>{
    try{return text(jobs.status(privileged(),task_id));}catch(e){return toolError(e);}
  });
  server.registerTool('task_logs',{description:'Read own background task logs using byte offset pagination.',inputSchema:z.object({task_id:z.string(),offset:z.number().int().min(0).default(0),limit:z.number().int().min(1).max(64000).default(8000)})},async({task_id,offset,limit})=>{
    try{return text(jobs.logs(privileged(),task_id,offset,limit));}catch(e){return toolError(e);}
  });
  server.registerTool('task_cancel',{description:'Request termination of own background task.',inputSchema:z.object({task_id:z.string()})},async({task_id})=>{
    try{return text(jobs.cancel(privileged(),task_id));}catch(e){return toolError(e);}
  });
  server.registerTool('notify_send',{description:'Queue a manual Gotify notification when administrator enables notifications.',inputSchema:z.object({title:z.string().max(80).default('Asterline'),message:z.string().min(1).max(1500),priority:z.number().int().min(0).max(10).default(5)})},async({title,message,priority})=>{
    try{const who=privileged();if(!store.flag('notify_manual'))throw Error('Manual notifications disabled');
      const recent=(store.db.prepare("SELECT count(*) AS n FROM js_notifications WHERE event='manual' AND created>?").get(Date.now()-300_000) as {n:number}).n;
      if(recent>=10)throw Error('Rate limit: 10 manual notifications per five minutes');
      if(!conf.gotifyToken)throw Error('Gotify not configured');
      const ok=await notify(conf,title,message,priority,'manual');store.audit(who,'notify_send',ok?'queued':'failed');return text({queued:ok});
    }catch(e){return toolError(e);}
  });
  // Public discovery is harmless; execution is only possible while this exact
  // Access-authenticated identity has an administrator-granted host-direct hour.
  server.registerTool('terminal_exec',{description:'Execute a bounded Windows terminal command only during an active admin-issued 1-hour host-direct grant. Uses the MCP server Windows user, not SYSTEM. 120s hard cap per call.',inputSchema:z.object({
    shell:z.enum(['powershell','cmd','exec']).default('powershell'),
    command:z.string().min(1).max(4000),
    args:z.array(z.string().max(4000)).max(64).default([]),
    cwd:z.string().max(2048).optional(),
    timeout_seconds:z.number().int().min(1).max(120).default(30)
  })},async(input)=>{
    try{const who=privileged();return text(await executeHostTerminal(conf,store,who,input));}
    catch(e){return toolError(e);}
  });
  for(const row of store.active()){
    const manifest=validateManifest(JSON.parse(row.manifest));
    server.registerTool(manifest.tool.name,{description:manifest.tool.description,
      inputSchema:z.object({input:z.record(z.string(),z.unknown()),approval_id:z.string().optional()})},async({input,approval_id})=>{
        try{
          const who=privileged();
          if(!manifest.tool.requireApproval)throw Error('Explicit plugin approval policy required');
          const direct=store.currentHostPass(who);
          // An explicit approval ticket is ALWAYS checked, even during host-direct.
          // Development scope never bypasses Sandboxie or authorizes host execution.
          if(approval_id)store.consume(approval_id,who,row.id,paramsHash(input));
          else if(!direct)authorizeSandboxPlugin(store,conf,who,row.id,input);
          if(direct){
            store.audit(who,'host_direct_tool_call',`${row.id} via ${direct.id}`);
            return text(await executeHostDirect(conf,store,who,row.id,input,direct.id));
          }
          return text(await executeSandbox(conf,store,who,row.id,input));
        }catch(e){return toolError(e);}
      });
  }
  return server;
};

// JSON response mode retains compatibility with your Cloudflare Tunnel and original ChatGPT plugin.
const handler=createMcpHandler(factory,{responseMode:'json'});
const app=createMcpExpressApp({host:'127.0.0.1',allowedHosts:['localhost','127.0.0.1','mcp.asterline.dev']});
const nodeHandler=toNodeHandler(handler);
app.all('/',async(req,res)=>{
  const raw=req.headers['cf-access-jwt-assertion'];
  let email='';
  if(raw){try{email=await auth.verify(String(raw),conf.mcpAud);}catch{res.status(401).send('Invalid Cloudflare Access identity');return;}}
  // Public request must arrive via CF Access. In local preview, read-only tools
  // still work without a JWT. No privileged tool executes unauthenticated.
  if(email)(req as any).auth={token:String(raw),clientId:email,scopes:['asterline:user']};
  void nodeHandler(req,res,req.body);
});
// No other MCP path; matches the original FastMCP path="/".
app.listen(conf.mcpPort,'127.0.0.1',()=>console.log(`MCP http://127.0.0.1:${conf.mcpPort}/`));
const admin=createAdmin(conf,store,auth,{jobs,preflight:(id)=>preflight(conf,store,store.get(id)!),install:(id)=>installApproved(conf,store,id),sandboxReady:()=>sandboxReady(conf),cancelHostPass:(id)=>{stopHostPassJobs(id);stopHostTerminalJobs(id);}});
admin.start();
for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>{void handler.close().finally(()=>{stopNotifications();store.close();process.exit(0);});});
