// Asterline MCP smoke test: summarize *all* tool names (no 1200-char truncation).
const root = process.env.MCP_TEST_URL || 'http://127.0.0.1:8100/';
let requestId = 1;

function parseReply(body, contentType) {
  if (contentType.includes('application/json') || body.trimStart().startsWith('{')) {
    return JSON.parse(body);
  }
  // MCP Streamable HTTP may return SSE, even when JSON is requested.
  const eventBlocks = body.split(/\r?\n\r?\n/);
  for (const eventBlock of eventBlocks) {
    const lines = eventBlock.split(/\r?\n/);
    const dataLines = lines.filter(line => line.startsWith('data:'));
    if (!dataLines.length) continue;
    const data = dataLines.map(line => line.slice(5).trimStart()).join('\n');
    if (data === '[DONE]') continue;
    try {
      const value = JSON.parse(data);
      if (value.result || value.error) return value;
    } catch { /* Ignore non-JSON SSE keepalives. */ }
  }
  throw new Error('Could not parse MCP JSON/SSE response');
}

async function post(method, params = {}) {
  const response = await fetch(root, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream'
    },
    body: JSON.stringify({jsonrpc: '2.0', id: requestId++, method, params})
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.slice(0, 500)}`);
  const message = parseReply(body, response.headers.get('content-type') || '');
  if (message.error) throw new Error(`MCP ${method} error: ${JSON.stringify(message.error)}`);
  return message.result;
}

const toolList = await post('tools/list');
if (!Array.isArray(toolList?.tools)) throw new Error('tools/list returned no tools array');
const names = toolList.tools.map(tool => tool.name);
console.log(`tools/list (${names.length} tools):\n  ${names.join('\n  ')}`);
console.log(`greet_custom: ${names.includes('greet_custom') ? 'FOUND (published)' : 'NOT FOUND (check plugin state in /plugins)'}`);

const hello = await post('tools/call', {name: 'hello', arguments: {name: 'ChatGPT'}});
const greeting = hello?.content?.filter(item => item.type === 'text').map(item => item.text).join('\n');
console.log(`hello: ${greeting || JSON.stringify(hello)}`);
