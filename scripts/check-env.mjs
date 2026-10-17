import fs from 'node:fs';
import path from 'node:path';
const major=Number(process.versions.node.split('.')[0]);
console.log(`Node ${process.version} / ${process.platform}`);
if(major<24){console.error('Node.js 24.12+ required for this preview');process.exitCode=1;}
const file=path.resolve('.env');
if(!fs.existsSync(file)){console.log('.env missing; copy .env.example and configure it first.');process.exitCode=1;}
else{
  const lines=Object.fromEntries(fs.readFileSync(file,'utf8').split(/\r?\n/).map(l=>l.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean).map(m=>[m[1],m[2]]));
  for(const key of ['ADMIN_PASSWORD','CF_TEAM_DOMAIN','CF_ACCESS_AUD','CF_ADMIN_AUD','MCP_ALLOWED_EMAILS']){
    const value=lines[key]||'';
    console.log(`${key}: ${value&& !value.startsWith('REPLACE')?'configured':'MISSING'}`);
  }
  console.log(`ADMIN_PUBLIC_HOST: ${lines.ADMIN_PUBLIC_HOST||'mcpadmin.asterline.dev'}`);
  console.log(`SANDBOX_POLICY_CONFIRMED: ${lines.SANDBOX_POLICY_CONFIRMED||'0'} (must be manually reviewed)`);
}
