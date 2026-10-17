/** Scope and secret-file guard for agent-initiated ChatGPT Library exports.
 * Never grant access outside the already-configured Asterline workspace.
 */
import fs from 'node:fs';
import path from 'node:path';
const forbidden=new Set(['.env','.git','.ssh','.state-node','node_modules','secrets','credentials']);
const dangerousName=/^(?:id_(?:rsa|ed25519|ecdsa)|.*\.(?:pem|p12|pfx|key|kdbx)|.*\.env(?:\..*)?|.*(?:secret|token|credential)[s]?(?:\.|$))/i;
const within=(root,target)=>{const rel=path.relative(root,target);return rel===''||(!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel));};
export function agentStagePath(workspaceRoot,relativePath){
 if(typeof relativePath!=='string'||!relativePath||relativePath.length>2048||relativePath.includes('\0')||path.isAbsolute(relativePath)||/^[a-zA-Z]:/.test(relativePath))throw Error('Agent export requires a relative workspace path');
 const parts=relativePath.split(/[\\/]+/);
 if(parts.some(p=>!p||p==='.'||p==='..'||forbidden.has(p.toLowerCase())||dangerousName.test(p)))throw Error('Restricted file or directory name in Library export');
 const root=fs.realpathSync(workspaceRoot); const full=path.resolve(root,...parts);
 if(!within(root,full))throw Error('Path escapes configured workspace');
 let cur=root;
 for(const p of parts){cur=path.join(cur,p);const st=fs.lstatSync(cur);if(st.isSymbolicLink())throw Error('Symlink/reparse path denied');const real=fs.realpathSync(cur);if(!within(root,real))throw Error('Path resolves outside workspace');}
 if(!fs.lstatSync(full).isFile())throw Error('Library export requires a regular file');
 return full;
}
