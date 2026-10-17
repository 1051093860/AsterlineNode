// QA fixture. Runs only in the dedicated AsterlineQATest sandbox.
import { readFile } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import net from 'node:net';
async function canConnect(host, port, timeoutMs = 1500) {
  return await new Promise(resolve => {
    const socket = net.createConnection({host, port});
    let settled = false;
    const finish = (ok) => {if(settled)return;settled=true;socket.destroy();resolve(ok);};
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}
export async function run(input) {
  let readBlocked = false, networkBlocked = false, writeBlocked = false;
  try { await readFile(input.markerFile); } catch { readBlocked = true; }
  const u = new URL(input.probeUrl);
  networkBlocked = !(await canConnect(u.hostname, Number(u.port) || 80));
  try { await writeFile(input.forbiddenOutput, 'SANDBOX_QA_ONLY'); } catch { writeBlocked = true; }
  return {readBlocked, networkBlocked, writeBlocked};
}
