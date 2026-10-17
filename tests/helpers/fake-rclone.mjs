import fs from 'node:fs';
import path from 'node:path';

// Test-only stand-in for rclone. Windows cannot directly execute POSIX shebang files.
export function fakeRcloneProgram(base, {captureFile, echo=false}={}) {
  if(process.platform!=='win32') {
    const code=captureFile
      ? `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(captureFile)},JSON.stringify(process.argv.slice(2)));\n`
      : '#!/bin/sh\nprintf "ARGS:%s\\n" "$*"\n';
    fs.writeFileSync(base,code,{mode:0o755});
    return {executable:base,env:{}};
  }
  const executable=base+'.exe';
  const preload=base+'-preload.cjs';
  fs.copyFileSync(process.execPath,executable);
  const body=`const fs=require('node:fs'), path=require('node:path');\n`
    +`if(path.resolve(process.execPath).toLowerCase()===${JSON.stringify(path.resolve(executable).toLowerCase())}) {\n`
    +` const args=process.argv.slice(1); if(args.length)args[0]=path.basename(args[0]);\n`
    +(captureFile?` fs.writeFileSync(${JSON.stringify(captureFile)},JSON.stringify(args));\n`:'' )
    +(echo?` process.stdout.write('ARGS:'+args.join(' ')+'\\n');\n`:'' )
    +` process.exit(0);\n}\n`;
  fs.writeFileSync(preload,body);
  return {executable,env:{NODE_OPTIONS:[process.env.NODE_OPTIONS||'',`--require="${preload.replaceAll('\\','/')}"`].filter(Boolean).join(' ')}};
}
