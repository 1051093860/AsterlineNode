import {checkQaPolicyFile} from './sandbox-policy.mjs';
import {existsSync} from 'node:fs';
const ini=(process.env.QA_SANDBOX_INI||process.argv[2]||'').trim();
const box=process.env.QA_SANDBOX_BOX||'AsterlineQATest';
if(!ini||!existsSync(ini)){
  console.error('Missing QA_SANDBOX_INI: set it to the real Sandboxie.ini (not SandMan.ini), or pass its absolute path.');
  process.exitCode=2;
}else{
  const report=checkQaPolicyFile(ini,box);
  for(const s of report.errors)console.error('[FAIL] '+s);
  for(const s of report.warnings)console.log('[NOTE] '+s);
  console.log(report.ok?'[PASS] QA Sandboxie.ini baseline':'[FAIL] QA Sandboxie.ini baseline');
  if(!report.ok)process.exitCode=1;
}
