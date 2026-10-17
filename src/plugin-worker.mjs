// Runs only inside an approved Sandboxie box. No MCP or host secrets.
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const [moduleUrl,outputFile,paramsText,taskId,nonce] = process.argv.slice(2);
if (!moduleUrl || !outputFile || !paramsText || paramsText.length>24000 ||
    !/^[0-9a-f-]{36}$/i.test(taskId||'') || !/^[0-9a-f-]{36}$/i.test(nonce||'')) process.exit(2);
let envelope;
try {
  const mod = await import(pathToFileURL(moduleUrl).href);
  if (typeof mod.run!=='function') throw Error('Plugin must export async function run(input)');
  const result = await mod.run(JSON.parse(paramsText));
  envelope = {ok:true,task_id:taskId,nonce,result};
} catch(e) {
  envelope = {ok:false,task_id:taskId,nonce,error:String(e).slice(0,500)};
  process.exitCode=1;
}
try {
  const text=JSON.stringify(envelope);
  if(!text || Buffer.byteLength(text)>15000)throw Error('Worker output too large');
  writeFileSync(outputFile,text+'\n',{flag:'wx',encoding:'utf8'});
} catch(e) {
  process.stderr.write('Worker cannot write sandbox result: '+String(e).slice(0,200));
  process.exitCode=3;
}
