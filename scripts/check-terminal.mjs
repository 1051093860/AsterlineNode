// Read-only/deny-only smoke test for v1.6.4 terminal_exec; never runs shell commands.
const url=process.env.MCP_TEST_URL||'http://127.0.0.1:8100/';
let id=1;
function parse(body){
  if(body.trimStart().startsWith('{'))return JSON.parse(body);
  for(const block of body.split(/\r?\n\r?\n/)){
    const line=block.split(/\r?\n/).filter(s=>s.startsWith('data:')).map(s=>s.slice(5).trim()).join('\n');
    if(!line||line==='[DONE]')continue;
    try{const value=JSON.parse(line);if(value.result||value.error)return value;}catch{}
  }
  throw Error('No MCP result in JSON/SSE reply');
}
async function call(method,params){
  const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:id++,method,params})});
  const data=parse(await r.text());
  if(!r.ok||data.error)throw Error(`MCP ${method}: ${JSON.stringify(data.error??r.status)}`);
  return data.result;
}
const tools=await call('tools/list',{});
if(!tools.tools.some(t=>t.name==='terminal_exec'))throw Error('terminal_exec missing from MCP tool list');
console.log('[PASS] terminal_exec published as a built-in tool');
// The server's untrusted-local request must never get to execute this command.
const res=await call('tools/call',{name:'terminal_exec',arguments:{shell:'exec',command:'echo',args:['should-not-run']}});
if(!res.isError||!JSON.stringify(res.content).includes('Verified Cloudflare Access identity required'))
  throw Error('Anonymous terminal call did not fail closed');
console.log('[PASS] anonymous terminal call denied without execution');
