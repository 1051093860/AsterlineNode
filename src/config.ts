import path from 'node:path';
import fs from 'node:fs';

export function loadDotEnv(file = path.resolve('.env')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z][A-Z0-9_]*)=(.*)\s*$/.exec(line);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].trim().replace(/^(["'])(.*)\1$/, '$2');
  }
}
export function configFromEnv() {
  const data = path.resolve(process.env.MCP_DATA_DIR || '.state-node');
  const positivePort = (v: string | undefined, fallback: number) => {
    const n = Number(v || fallback);
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw Error('Invalid port');
    return n;
  };
  return {
    data,
    libraryFileHosts:(process.env.LIBRARY_FILE_HOSTS||'oaiusercontent.com,*.oaiusercontent.com,chatgpt.com,*.chatgpt.com,openai.com,*.openai.com,oaistatic.com,*.oaistatic.com').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean),
    workspaceRoot: path.resolve(process.env.MCP_WORKSPACE_ROOT || '.'),
    mcpPort: positivePort(process.env.MCP_PORT, 8100),
    localAdminPort: positivePort(process.env.ADMIN_LOCAL_PORT, 8765),
    publicAdminPort: positivePort(process.env.ADMIN_PUBLIC_PORT, 8766),
    publicHost: (process.env.ADMIN_PUBLIC_HOST || 'mcpadmin.asterline.dev').toLowerCase(),
    password: process.env.ADMIN_PASSWORD || '',
    teamDomain: (process.env.CF_TEAM_DOMAIN || '').replace(/\/$/, ''),
    mcpAud: process.env.CF_ACCESS_AUD || '',
    adminAud: process.env.CF_ADMIN_AUD || '',
    emails: new Set((process.env.MCP_ALLOWED_EMAILS || '').toLowerCase().split(',').map(s=>s.trim()).filter(Boolean)),
    gotify: process.env.GOTIFY_LOCAL_URL || 'http://127.0.0.1:8780',
    gotifyToken: process.env.GOTIFY_APP_TOKEN || '',
    sandboxieStart: process.env.SANDBOXIE_START || '',
    sandboxieBox: process.env.SANDBOXIE_BOX || 'AsterlinePlugins',
    // The on-disk FileRootPath for this box (not the project or workspace).
    // Must be configured by an administrator; never inferred from the user's home folder.
    sandboxieBoxRoot: process.env.SANDBOXIE_BOX_ROOT || '',
    sandboxConfirmed: process.env.SANDBOX_POLICY_CONFIRMED === '1',
    nodeExe: process.env.NODE_EXE || process.execPath,
    npmExe: process.env.NPM_EXE || (process.platform === 'win32' ? 'npm.cmd' : 'npm'),
    maxPluginSeconds: Math.max(2, Math.min(120, Number(process.env.MAX_PLUGIN_SECONDS || 30)))
  };
}
export type Config = ReturnType<typeof configFromEnv>;
