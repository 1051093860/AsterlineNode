/** Static, deliberately conservative QA-only Sandboxie.ini checker.
 * It cannot prove effective settings after templates/inheritance, service
 * reload, or an adversarial bypass: always pair with actual OS-only probes.
 */
import {readFileSync} from 'node:fs';
function getSections(iniText) {
  const sections=new Map();let section='';
  for(let line of iniText.replace(/^\uFEFF/,'').split(/\r?\n/)) {
    line=line.trim();if(!line||line.startsWith('#')||line.startsWith(';'))continue;
    const group=line.match(/^\[([^\]]+)\]$/);
    if(group){section=group[1].toLowerCase();if(!sections.has(section))sections.set(section,new Map());continue;}
    if(!section)continue;
    const pos=line.indexOf('=');if(pos<1)continue;
    const key=line.slice(0,pos).trim().toLowerCase(),val=line.slice(pos+1).trim();
    const dict=sections.get(section);dict.set(key,[...(dict.get(key)||[]),val]);
  }
  return sections;
}
export function inspectQaPolicy(text,boxName='AsterlineQATest') {
  const sections=getSections(text),section=sections.get(boxName.toLowerCase()),global=sections.get('globalsettings');
  const errors=[],warnings=[];
  if(!section)return {ok:false,errors:[`Sandbox section [${boxName}] not found`],warnings};
  const values=(s,key)=>s?.get(key.toLowerCase())||[];
  const effective=(key)=>{const box=values(section,key);return (box.length?box:values(global,key)).at(-1)?.toLowerCase()??'';};
  for(const [key,wanted] of [['AutoRecover','n'],['BlockNetworkFiles','y'],['AllowNetworkAccess','n'],['BlockLocalLoop','y']]) {
    const found=effective(key);
    if(found!==wanted)errors.push(`${key} must be ${wanted} (effective: ${found||'<missing>'})`);
    for(const val of values(section,key))if(val.toLowerCase()!==wanted)errors.push(`${key} has conflicting box-specific value: ${val}`);
  }
  if((values(global,'NetworkEnableWFP').at(-1)||'').toLowerCase()!=='y'||values(global,'NetworkEnableWFP').some(x=>x.toLowerCase()!=='y'))errors.push('NetworkEnableWFP=y must be explicitly enabled without contradictory entries under [GlobalSettings]');
  for(const val of [...values(global,'AllowNetworkAccess'),...values(section,'AllowNetworkAccess')]){
    if(val.toLowerCase()!=='n')errors.push(`AllowNetworkAccess exception or conflicting value: ${val}`);
  }
  const network=[...values(global,'NetworkAccess'),...values(section,'NetworkAccess')].map(x=>x.replace(/\s+/g,'').toLowerCase());
  if(!network.includes('*,block'))errors.push('NetworkAccess=*,Block is required');
  for(const rule of network){if(/,allow(\b|;|$)/i.test(rule))errors.push(`Potential network allow rule: ${rule}`);}
  // An allow rule inherited from any template cannot be determined reliably
  // without parsing full template expansion. Fail closed for QA verification.
  for(const name of ['Template','Tmpl','UseFileDeleteV2']) {
    if(name==='UseFileDeleteV2')continue;
    if(values(section,name).length)errors.push(`${name} is present: inherited rules need manual effective-policy review`);
  }
  if(values(section,'OpenFilePath').length||values(section,'OpenPipePath').length)
    warnings.push('Open file/pipe path rules exist; audit them separately for QA marker and output isolation');
  warnings.push('Static INI check cannot prove that the running Sandboxie service loaded these rules; run OS-only probes after restarting sandbox processes.');
  warnings.push('BlockNetworkFiles blocks network shares, not TCP/UDP; WFP and socket probes are tested separately.');
  return {ok:errors.length===0,errors,warnings};
}
export function checkQaPolicyFile(file,boxName='AsterlineQATest'){
  return inspectQaPolicy(readFileSync(file,'utf8'),boxName);
}
