/**
 * Sandboxie-only QA test, deliberately does NOT use --permission.
 * Exit code 16 means private marker unreadable, loopback and nonloopback
 * TCP connects denied/unreachable. 17=marker readable, 18=loopback reachable,
 * 20=nonloopback reachable, 24=UDP loopback reachable (bits can add).
 * A timeout to an external endpoint alone is NOT proof of an OS deny policy:
 * also run check-sandbox-policy.mjs against effective Sandboxie.ini.
 */
import {readFileSync,writeFileSync} from 'node:fs';
import net from 'node:net';
import dgram from 'node:dgram';
const [marker, forbiddenOutput, loopbackUrl, externalHost = '1.1.1.1', externalPortText='443',udpPortText='']=process.argv.slice(2);
if(!marker||!forbiddenOutput||!loopbackUrl)process.exit(2);
const canConnect=(host,port)=>new Promise(resolve=>{
  const socket=net.createConnection({host,port});let done=false;
  const finish=v=>{if(done)return;done=true;socket.destroy();resolve(v);};
  socket.once('connect',()=>finish(true));socket.once('error',()=>finish(false));
  socket.setTimeout(1600,()=>finish(false));
});
const udpReceivesReply=port=>new Promise(resolve=>{
  const socket=dgram.createSocket('udp4');let done=false;
  const end=v=>{if(done)return;done=true;socket.close();resolve(v);};
  const timer=setTimeout(()=>end(false),1300);
  socket.once('message',msg=>{clearTimeout(timer);end(msg.toString()==='QA_PONG');});
  socket.once('error',()=>{clearTimeout(timer);end(false);});
  socket.send(Buffer.from('QA_PING'),port,'127.0.0.1',e=>{if(e){clearTimeout(timer);end(false);}});
});
let bits=0;
try {readFileSync(marker);bits|=1;} catch {}
try {writeFileSync(forbiddenOutput,'QA_SANDBOX_VIRTUAL_WRITE');}catch{}
try {const u=new URL(loopbackUrl);if(await canConnect(u.hostname,Number(u.port)||80))bits|=2;}catch{}
if(await canConnect(externalHost,Number(externalPortText)))bits|=4;
if(udpPortText&&await udpReceivesReply(Number(udpPortText)))bits|=8;
process.exit(16+bits);
