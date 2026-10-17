// Read-only/deny-only MCP contract probe. Never executes privileged operations.
const root=process.env.MCP_TEST_URL||'http://127.0.0.1:8100/';
let id=1;
function parse(body){if(body.trimStart().startsWith('{'))return JSON.parse(body);
  for(const block of body.split(/\r?\n\r?\n/)){
    const data=block.split(/\r?\n/).filter(x=>x.startsWith('data:')).map(x=>x.slice(5).trim()).join('\n');
    if(!data||data==='[DONE]')continue;try{const v=JSON.parse(data);if(v.result||v.error)return v;}catch{}
  }throw Error('No MCP JSON/SSE reply');
}
async function call(method,params){const response=await fetch(root,{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:id++,method,params})});const payload=parse(await response.text());if(!response.ok||payload.error)throw Error(`${method}: HTTP ${response.status}`);return payload.result;}
const result=await call('tools/list',{}), names=new Set(result.tools.map(t=>t.name));
const required=['hello','system_info','fs_list','fs_read','fs_write','terminal_exec','task_start','task_status','task_logs','task_cancel','notify_send','approval_request','approval_status','plugin_propose','plugin_catalog'];
let ok=true;for(const tool of required){const found=names.has(tool);console.log(found?'[PASS]':'[FAIL]',tool);if(!found)ok=false;}
const denied=await call('tools/call',{name:'fs_write',arguments:{path:'should-not-write.txt',content:'unsafe'}});
if(!denied?.isError){console.error('[FAIL] unauthenticated fs_write not blocked');ok=false;}else console.log('[PASS] unauthenticated fs_write denied');
const hello=await call('tools/call',{name:'hello',arguments:{name:'QA'}});
if(hello?.isError||!JSON.stringify(hello).includes('Hello, QA!')){console.error('[FAIL] hello');ok=false;}else console.log('[PASS] hello');
if(!ok)process.exitCode=1;
