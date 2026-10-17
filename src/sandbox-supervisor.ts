/**
 * Sandboxie box cleanup validation. Start.exe /wait exit != process-tree proof.
 * The box MUST be dedicated to this worker (one job at a time).
 * Sandboxie documents /box:NAME /listpids and /box:NAME /terminate.
 */
export type CliResult={code:number|null;out:string;timedOut:boolean;closed?:boolean};
export type Invoke=(args:string[],timeoutMs:number)=>Promise<CliResult>;
export function parseSandboxPids(stdout:string):number[]{
  const numbers=stdout.trim().split(/\s+/);
  if(!numbers.length||!/^\d+$/.test(numbers[0]))throw Error('Sandboxie /listpids did not return a numeric process count');
  const count=Number(numbers[0]);
  if(!Number.isSafeInteger(count)||count<0||count>10000||numbers.length!==count+1)throw Error('Sandboxie /listpids count does not match PID list');
  const pids=numbers.slice(1).map(x=>{if(!/^\d+$/.test(x))throw Error('Invalid Sandboxie process ID');return Number(x);});
  if(pids.some(p=>!Number.isSafeInteger(p)||p<=0))throw Error('Invalid Sandboxie process ID');
  return pids;
}
export async function listBoxPids(box:string, invoke:Invoke):Promise<number[]>{
  const r=await invoke([`/box:${box}`,'/listpids'],4000);
  if(r.timedOut||r.code!==0||r.closed===false)throw Error(`Sandboxie /listpids unverified (exit=${r.code}, timedOut=${r.timedOut})`);
  return parseSandboxPids(r.out);
}
export async function ensureEmptyBox(box:string,invoke:Invoke):Promise<void>{
  const pids=await listBoxPids(box,invoke);
  if(pids.length)throw Error(`Sandboxie box ${box} not empty (${pids.length} process(es)); refusing to start another job`);
}
export async function terminateAndVerifyBox(box:string,invoke:Invoke,attempts=8,delayMs=350):Promise<void>{
  const killed=await invoke([`/box:${box}`,'/terminate'],7000);
  if(killed.timedOut||killed.code!==0||killed.closed===false)
    throw Error(`Sandboxie /terminate command failed or timed out (exit=${killed.code})`);
  let latest:number[]=[];
  for(let i=0;i<attempts;i++){
    latest=await listBoxPids(box,invoke);
    if(!latest.length)return;
    if(i+1<attempts)await new Promise(r=>setTimeout(r,delayMs));
  }
  throw Error(`Sandboxie processes remain after terminate: ${latest.join(', ')}`);
}
