import http, {type IncomingMessage,type ServerResponse} from 'node:http';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import type{Config}from './config.ts';
import type{Store}from './store.ts';
import type{AccessAuth}from './auth.ts';
import type{JobManager}from './jobs.ts';
import{safeGotifyUrl}from './policy.ts';
import{notify}from './notifier.ts';
import{verifyAdminBasic,checkOrigin}from './policy.ts';
import{validateWorkRoot,validateWorkCapabilities}from './permission-center.ts';
import{RUNTIME_LABELS,saveRuntimeSetting}from './runtime-settings.ts';
// @ts-ignore — intentionally small JS transfer spool
import {LibraryBridge} from './library-bridge.mjs';

const escape=(s:unknown)=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
// Cloudflare email obfuscation can corrupt <option> text; protect only displayed identities.
const identityText=(s:unknown)=>`<!--email_off-->${escape(s)}<!--/email_off-->`;
const csrf=randomBytes(32).toString('hex');
const statusMap:Record<string,string>={draft:'待预检',reviewed:'待安装批准',installed:'可发布',active:'已发布',disabled:'已停用',rejected:'已拒绝'};
const iconPaths:Record<string,string>={
 grid:'<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
 shield:'<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/>',
 layers:'<path d="m12 2 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5M3 17l9 5 9-5"/>',
 box:'<path d="m12 2 9 5-9 5-9-5 9-5Z"/><path d="M3 7v10l9 5 9-5V7M12 12v10"/>',
 clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
 settings:'<path d="M3 6h18M3 12h18M3 18h18"/><circle cx="8" cy="6" r="2"/><circle cx="16" cy="12" r="2"/>',
 bell:'<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
 terminal:'<rect x="2" y="3" width="20" height="18" rx="3"/><path d="m6 9 3 3-3 3m6 0h5"/>',
 list:'<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
 search:'<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
 moon:'<path d="M20.9 13a9 9 0 0 1-9.9-9.9A9 9 0 1 0 20.9 13Z"/>',
 download:'<path d="M12 3v12m-4-4 4 4 4-4M4 17v3h16v-3"/>',
 arrow:'<path d="M5 12h14m-7-7 7 7-7 7"/>'};
const ico=(x:string,n=18)=>`<svg class="icon" aria-hidden="true" width="${n}" height="${n}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${iconPaths[x]||iconPaths.grid}</svg>`;
const navGroups=[
 ['工作台',[['/','概览','grid'],['/access','审批与授权','shield'],['/plugins','插件','layers'],['/jobs','任务','terminal'],['/library','文件桥','download']]],
 ['系统',[['/settings','工具设置','settings'],['/sandboxes','运行环境','box'],['/audit','审计记录','list']]]
] as const;
// Old routes stay available by URL and from the advanced drawer, but not in daily navigation.
const advancedLinks=[['/approvals','单次审批','clock'],['/permissions','单插件临时授权','clock'],['/operations','功能开关','settings'],['/dependencies','依赖详情','box'],['/notifications','通知队列','bell']] as const;
const pageRoutes:Record<string,string>={'概览':'/','权限中心':'/access','授权':'/approvals','插件':'/plugins','任务':'/jobs','文件桥':'/library','工具设置':'/settings','沙箱':'/sandboxes','日志':'/audit','临时权限':'/permissions','运维':'/operations','依赖':'/dependencies','通知':'/notifications'};
const base=(c:Config,store:Store,page:string,inner:string,publicMode:boolean)=>{
 const pending=store.pending().length+store.pendingWorkRequests().length;
 const current=pageRoutes[page]||'/';
 const navLink=(href:string,label:string,icon:string)=>`<a class="nav-link ${href===current?'active':''}" href="${href}" ${href===current?'aria-current="page"':''}>${ico(icon)}<span>${escape(label)}</span>${href==='/access'&&pending?`<span class="counter">${pending}</span>`:''}</a>`;
 const nav=navGroups.map(([group,links])=>`<section class="nav-section"><div class="nav-caption">${group}</div>${links.map(([href,label,icon])=>navLink(href,label,icon)).join('')}</section>`).join('');
 const extra=`<details class="nav-more" ${advancedLinks.some(([href])=>href===current)?'open':''}><summary>${ico('settings',16)}<span>高级功能</span>${ico('arrow',14)}</summary><div class="nav-more-links">${advancedLinks.map(([href,label,icon])=>navLink(href,label,icon)).join('')}</div></details>`;
 const bottom=[['/','概览','grid'],['/access','审批','shield'],['/jobs','任务','terminal'],['/plugins','插件','layers']] as const;
 const commands=[...navGroups.flatMap(([,links])=>links.map(([href,label,icon]):readonly [string,string,string]=>[href,label,icon])),...advancedLinks].map(([href,label,icon])=>`<a href="${href}" data-keyword="${label}">${ico(icon)}<span>${label}</span>${ico('arrow',16)}</a>`).join('');
 return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#101827"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><meta name="description" content="Asterline MCP 授权、插件与运行任务管理中心"><title>${escape(page)} · Asterline Control</title><link rel="manifest" href="/manifest.webmanifest"><link rel="icon" type="image/svg+xml" href="/assets/icon.svg"><link rel="apple-touch-icon" href="/assets/icon-192.png"><link rel="stylesheet" href="/assets/admin.css"><script src="/assets/admin.js" defer></script></head><body><div class="app-shell"><aside class="sidebar" id="sidebar"><a href="/" class="brand"><span class="brand-icon"><img src="/assets/icon.svg" alt=""></span><span><strong>Asterline</strong><small>CONTROL CENTER</small></span></a><div class="instance"><span class="signal"></span><span><b>运行实例</b><small>${publicMode?'Cloudflare Access 保护':'本机管理员通道'}</small></span></div><nav class="side-nav" aria-label="管理导航">${nav}${extra}</nav><div class="side-foot">${ico('shield',16)} 权限由服务端强制校验<br><small>Node v1.9.3 · Catalog r${store.revision()}</small></div></aside><button class="scrim" id="scrim" type="button" aria-label="关闭导航" hidden></button><div class="workarea"><header class="topbar"><div class="top-left"><button type="button" class="icon-button mobile-menu" id="menu" aria-label="打开导航" aria-expanded="false">${ico('settings')}</button><div class="breadcrumb"><span>控制中心</span><span class="slash">/</span><strong>${escape(page)}</strong></div></div><div class="top-actions"><button id="searchButton" type="button" class="search-button">${ico('search')}<span>快速查找</span><kbd>Ctrl K</kbd></button><span class="connect-pill" id="connectPill"><span class="signal"></span><span>正在检测</span></span><button type="button" class="icon-button" id="themeButton" aria-label="切换主题">${ico('moon')}</button><button type="button" class="icon-button" id="installButton" aria-label="安装为应用">${ico('download')}</button></div></header><main class="content">${inner}<footer><span>${ico('shield',15)} 管理数据不参与离线缓存</span><span>Catalog r${store.revision()}</span></footer></main></div><nav class="mobile-tabs">${bottom.map(([url,label,ic])=>`<a href="${url}" class="${current===url?'current':''}">${ico(ic,20)}<span>${label}</span>${url==='/access'&&pending?'<i class="notice-dot"></i>':''}</a>`).join('')}<button type="button" id="moreButton">${ico('settings',20)}<span>更多</span></button></nav><div class="command-modal" id="commandModal" hidden><button class="command-scrim" type="button" data-close aria-label="关闭搜索"></button><section role="dialog" aria-modal="true" aria-label="快速查找" class="command-dialog"><div class="command-input">${ico('search')}<input id="commandInput" type="search" placeholder="搜索页面…" autocomplete="off"><button type="button" data-close>×</button></div><div class="command-links">${commands}</div><small>Esc 关闭 · Ctrl K 打开</small></section></div><div id="toast" class="toast" hidden role="status" aria-live="polite"></div></div></body></html>`;
};
const action=(name:string,id:string,label:string,style='',returnTo='')=>`<form method="post" action="/action" class="inline"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="kind" value="${escape(name)}"><input type="hidden" name="id" value="${escape(id)}">${returnTo?`<input type="hidden" name="return_to" value="${escape(returnTo)}">`:''}<button class="${style}" type="submit">${escape(label)}</button></form>`;
function render(c:Config,store:Store,path:string,publicMode:boolean,sandboxReady:boolean){
  const plugins=store.list();const pending=store.pending() as any[];const pendingWork=store.pendingWorkRequests() as any[];
  if(path==='/'){
   const active=plugins.filter(p=>p.state==='active').length,waiting=plugins.filter(p=>['draft','reviewed'].includes(p.state)).length;
   const running=(store.db.prepare("SELECT count(*) AS n FROM js_jobs WHERE state='running'").get() as {n:number}).n;
   const passes=store.hostPasses(Date.now());
   const todo=[...pendingWork.map(x=>({label:'开发任务',title:x.title,reason:x.reason})),...pending.map(x=>({label:'单次操作',title:x.plugin,reason:x.reason}))];
   return base(c,store,'概览',`<section class="compact-welcome"><div><span class="eyebrow">ASTERLINE / CONTROL</span><h1>工作台</h1><p>${todo.length?`有 ${todo.length} 项请求等待审批。`:'当前没有待审批请求。'}</p></div><a class="hero-primary" href="/access">${todo.length?`处理 ${todo.length} 项待办`:'查看授权'} ${ico('arrow',16)}</a></section>
   <section class="metrics" aria-label="运行概况"><a class="stat" href="/plugins"><span class="stat-symbol">${ico('layers')}</span><label>已发布插件</label><b>${active}</b></a><a class="stat" href="/plugins"><span class="stat-symbol amber">${ico('box')}</span><label>待审插件</label><b>${waiting}</b></a><a class="stat" href="/access"><span class="stat-symbol purple">${ico('shield')}</span><label>待审批请求</label><b>${todo.length}</b></a><a class="stat" href="/jobs"><span class="stat-symbol mint">${ico('terminal')}</span><label>运行中任务</label><b>${running}</b></a></section>
   <div class="dashboard-cols"><section class="panel"><div class="panel-title"><h2>待办</h2><a href="/access" class="link">进入审批中心 →</a></div>${todo.length?todo.slice(0,5).map(x=>`<a href="/access" class="queue-row"><span class="queue-icon">${ico('shield')}</span><span><b>${escape(x.title)} <small class="row-inline-muted">· ${x.label}</small></b><small>${escape(x.reason)}</small></span>${ico('arrow',16)}</a>`).join(''):`<div class="empty-state compact-empty"><span>${ico('shield',22)}</span><strong>没有需要处理的请求</strong></div>`}</section>
   <section class="panel"><div class="panel-title"><h2>运行安全</h2><a href="/sandboxes" class="link">运行环境 →</a></div><a href="/sandboxes" class="state-row"><span>${ico('box')}</span><div><b>Sandboxie 隔离</b><small>${sandboxReady?'可执行已审核沙箱插件':'未启用或未验证'}</small></div><em class="${sandboxReady?'':'warn'}">${sandboxReady?'就绪':'锁定'}</em></a><a href="/sandboxes" class="state-row"><span>${ico('shield')}</span><div><b>宿主直通</b><small>${passes.length?`${passes.length} 个有效高权限授权`:'无有效直通授权'}</small></div><em class="${passes.length?'warn':''}">${passes.length?'高风险':'关闭'}</em></a></section></div>`,publicMode);
  }
  if(path==='/library'){
    const jobs=new LibraryBridge(c.data).load().jobs.slice(-80).reverse();
    return base(c,store,'文件桥',`<section class="heading"><div><p>LIBRARY BRIDGE</p><h1>ChatGPT Library · 文件桥</h1><span>原生 Library 必须通过 ChatGPT 中的交互工具确认；云盘同步通过 Windows CLI 的 rclone 独立运行。</span></div></section><section class="panel"><h2>命令行</h2><pre>node scripts/library-cli.mjs library push .\example.zip
node scripts/library-cli.mjs library jobs
node scripts/library-cli.mjs library pull &lt;id&gt; -o .\downloads
node scripts/library-cli.mjs cloud sync --direction up --dry-run</pre><p>不要把 ChatGPT 登录凭据放进 .env。只有验证过的 Cloudflare 身份才能读取其自己的传输队列。</p></section><section class="panel table-wrap"><h2>本机传输记录</h2><table><thead><tr><th>ID</th><th>属主</th><th>文件</th><th>方向 / 状态</th></tr></thead><tbody>${jobs.map((j:any)=>`<tr><td><code>${escape(j.id)}</code></td><td>${identityText(j.owner)}</td><td>${escape(j.name)}<small>${escape(j.size)} bytes</small></td><td>${escape(j.direction)} · ${escape(j.state)}</td></tr>`).join('')||'<tr><td colspan="4">暂无传输</td></tr>'}</tbody></table></section>`,publicMode);
  }
  if(path==='/plugins')return base(c,store,'插件',`<section class="heading"><div><p>PLUGIN REGISTRY</p><h1>工具插件</h1><span>审查依赖锁文件和安全报告后再安装。不执行 npm 生命周期脚本。</span></div><div class="chip">${plugins.length} 个版本</div></section><section class="panel"><h2>插件列表</h2><div class="table-wrap"><table><thead><tr><th>插件 / MCP 工具</th><th>状态</th><th>依赖</th><th>操作</th></tr></thead><tbody>${plugins.map(p=>{const m=JSON.parse(p.manifest);return `<tr><td><strong>${escape(p.name)}</strong><small>${escape(p.id)} · ${escape(m.tool.name)}</small></td><td><span class="tag">${escape(statusMap[p.state]||p.state)}</span></td><td>${Object.keys(m.dependencies||{}).length} packages</td><td>${p.state==='draft'?action('preflight',p.id,'预检依赖'):''}${p.state==='reviewed'?action('install',p.id,'批准并安装','primary'):''}${p.state==='installed'?action('publish',p.id,'发布工具','primary'):''}${p.state==='active'?action('disable',p.id,'停用','danger'):''}${p.state==='disabled'?action('publish',p.id,'重新发布'):''}${['draft','reviewed'].includes(p.state)?action('reject',p.id,'拒绝','danger'):''}</td></tr>${p.report?`<tr><td colspan="4"><details><summary>查看预检报告 / 完整依赖树 / 源代码</summary><pre>${escape(JSON.stringify(JSON.parse(p.report),null,2))}</pre><h3>工具代码（人工审查后再批准安装）</h3><pre>${escape(p.source)}</pre><small>源版本 SHA256：${escape(p.digest)}</small></details></td></tr>`:''}`;}).join('')||'<tr><td colspan="4">暂无插件。使用 Agent 的 plugin_propose 提交草案。</td></tr>'}</tbody></table></div></section>`,publicMode);
  if(path==='/dependencies')return base(c,store,'依赖',`<section class="heading"><div><p>DEPENDENCY REGISTRY</p><h1>已申报依赖</h1><span>已预审插件的完整依赖树和 SHA256 锁文件证明。</span></div></section><section class="panel table-wrap"><table><thead><tr><th>插件版本</th><th>直接依赖</th><th>锁文件哈希 / 已知漏洞</th></tr></thead><tbody>${plugins.map(p=>{const m=JSON.parse(p.manifest);const r=p.report?JSON.parse(p.report):null;return `<tr><td><strong>${escape(p.name)}</strong><small>${escape(p.id)} · ${escape(p.state)}</small></td><td>${Object.entries(m.dependencies||{}).map(([n,v])=>`<code>${escape(n)}@${escape(v)}</code>`).join('<br>')||'无'}</td><td>${r?`<small>SHA256 ${escape(r.lockHash)}</small><small>High: ${Number(r.vulnerabilities.high||0)} / Critical: ${Number(r.vulnerabilities.critical||0)}</small><details><summary>${r.count} 个锁定包</summary><pre>${escape(JSON.stringify(r.packages,null,2))}</pre></details>`:'等待预检'}</td></tr>`;}).join('')}</tbody></table></section>`,publicMode);
  if(path==='/access'){
    const now=Date.now(),sessions=store.activeWorkSessions(now),hosts=store.hostPasses(now),leases=store.currentLeases(now);
    const cards=[
      ...pendingWork.map(r=>{
        let caps:string[];try{caps=JSON.parse(r.capabilities);}catch{caps=[];}
        return {created:Number(r.created)||0,html:`<article class="access-request"><div class="access-request-heading"><div><span class="request-type">开发授权 · 60 分钟</span><strong>${escape(r.title)}</strong><small>${identityText(r.owner)} · ${escape(r.agent_label||'未提供客户端标签')}</small></div><span class="tag">待审批</span></div><p>${escape(r.reason)}</p><div class="access-chips"><span>目录：<code>${escape(r.workspace)}</code></span>${caps.map(x=>`<span>${x==='fs_write'?'项目文件写入':'已发布插件沙箱执行'}</span>`).join('')}</div><div class="actions">${action('approve_work',r.id,'批准 60 分钟','primary','/access')}${action('deny_work',r.id,'拒绝','danger','/access')}</div></article>`};
      }),
      ...pending.map(r=>({created:Number(r.created)||0,html:`<article class="access-request"><div class="access-request-heading"><div><span class="request-type">单次操作 · 精确参数</span><strong>${escape(r.plugin)}</strong><small>${identityText(r.owner)} · ${new Date(r.created).toLocaleString('zh-CN')}</small></div><span class="tag">待审批</span></div><p>${escape(r.reason)}</p><details class="request-parameters"><summary>查看完整参数</summary><pre>${escape(r.params)}</pre></details><div class="actions">${action('approve',r.id,'批准一次','primary','/access')}${action('deny',r.id,'拒绝','danger','/access')}</div></article>`}))
    ].sort((a,b)=>b.created-a.created);
    return base(c,store,'权限中心',`<section class="heading compact-heading"><div><h1>审批与授权</h1><span>所有待审批请求与有效授权集中管理。</span></div><div class="chip">${cards.length} 项待处理</div></section>
    <div class="access-layout"><section class="panel access-inbox"><div class="panel-title"><h2>待处理请求 <span class="inline-count">${cards.length}</span></h2></div>${cards.map(x=>x.html).join('')||'<div class="empty-state compact-empty"><strong>当前没有待审批请求</strong><p>Agent 可以通过 work_request 申请指定范围的开发权限。</p></div>'}</section>
    <section class="access-sidebar"><section class="panel"><div class="panel-title"><h2>有效授权</h2><span class="tag">${sessions.length+leases.length+hosts.length}</span></div>${sessions.map(l=>`<div class="lease-entry"><b>${escape(l.title)}</b><small>${identityText(l.owner)}</small><small>目录：${escape(l.workspace)}</small><small>剩余 ${Math.max(0,Math.ceil((l.expires-now)/60000))} 分钟 · ${l.capabilities.map((x:string)=>x==='fs_write'?'文件写入':'沙箱插件').join(' / ')}</small>${action('revoke_work',l.id,'撤销开发授权','danger','/access')}</div>`).join('')}${leases.map(l=>`<div class="lease-entry"><b>插件：${escape(l.plugin_name)}</b><small>${identityText(l.owner)} · 剩余 ${Math.max(0,Math.ceil((l.expires-now)/60000))} 分钟</small>${action('revoke_hour',l.id,'撤销插件授权','danger','/access')}</div>`).join('')}${hosts.map(l=>`<div class="lease-entry host-lease"><b>宿主直通 · 高风险</b><small>${identityText(l.owner)} · 剩余 ${Math.max(0,Math.ceil((l.expires-now)/60000))} 分钟</small>${action('revoke_host_hour',l.id,'立即撤销宿主直通','danger','/access')}</div>`).join('')||((sessions.length+leases.length)?'':'<p class="empty-line">当前没有有效授权。</p>')}<div class="inline-link-row"><a href="/permissions">单插件授权 →</a><a href="/sandboxes">宿主直通 →</a></div></section><section class="panel"><h2>隔离状态</h2><div class="kv"><span>Sandboxie</span><strong>${sandboxReady?'就绪':'锁定'}</strong></div><div class="kv"><span>宿主直通</span><strong class="${hosts.length?'risk-text':''}">${hosts.length?'生效中':'关闭'}</strong></div><a href="/sandboxes" class="link">运行环境详情 →</a></section></section></div>
    <details class="help-disclosure"><summary>了解授权范围与高级设置</summary><div><p>开发授权固定 60 分钟，仅允许指定目录写入和已发布插件的沙箱执行；单次审批严格绑定原始请求参数。宿主直通独立授权，拥有服务账户权限。</p><p>目前授权身份绑定已验证的 Cloudflare 邮箱；共享同一邮箱的 Agent 可能共享授权范围。撤销不能回滚已经发生的外部副作用。</p><div class="inline-link-row"><a href="/approvals">旧版单次审批页面</a><a href="/operations">功能开关</a><a href="/audit">审计记录</a></div></div></details>`,publicMode);
  }
  if(path==='/approvals')return base(c,store,'授权',`<section class="heading"><div><p>AUTHORIZATION QUEUE</p><h1>手机授权</h1><span>只批准精确参数的一次调用，30 分钟内有效。</span></div></section><div class="cards">${pending.map(p=>`<section class="panel"><div class="cardtop"><b>${escape(p.plugin)}</b><span class="tag">待处理</span></div><p>${escape(p.reason)}</p><details><summary>检查请求参数</summary><pre>${escape(p.params)}</pre><small>申请者：${identityText(p.owner)} · ${new Date(p.created).toLocaleString('zh-CN')}</small></details><div class="actions">${action('approve',p.id,'同意一次','primary')}${action('deny',p.id,'拒绝','danger')}</div></section>`).join('')||'<section class="panel">当前没有待审核的操作。</section>'}</div>`,publicMode);
  if(path==='/permissions'){
    const now=Date.now(),leases=store.currentLeases(now),active=plugins.filter(p=>p.state==='active');
    const ready=sandboxReady;
    const choices=[...c.emails].sort().map(email=>`<option value="${escape(email)}">${identityText(email)}</option>`).join('');
    const grantForm=active.length?`<form method="post" action="/action" class="lease-form">
      <input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="kind" value="grant_hour">
      <label for="lease-plugin">授权工具</label><select id="lease-plugin" name="id" required>${active.map(p=>`<option value="${escape(p.id)}">${escape(p.name)} (${escape(p.id)})</option>`).join('')}</select>
      <label for="lease-email">授权身份（Cloudflare Access 邮箱）</label><select id="lease-email" name="owner" required>${choices}</select>
      <p>有效期固定为 60 分钟，不自动续期；已存在的授权不能通过重复点击延长。仅豁免此身份调用此插件时的逐次审批。</p>
      <button class="primary" type="submit" ${ready?'':'disabled'}>允许此工具调用 1 小时</button></form>`:'<p>暂无已发布插件。</p>';
    return base(c,store,'临时权限',`<section class="heading"><div><p>TIME-LIMITED PERMISSIONS</p><h1>临时权限 · 1 小时</h1><span>只授权指定身份调用指定插件。到期自动失效；管理员可以提前撤销。</span></div></section>
      <div class="cols"><section class="panel"><h2>授予临时权限</h2>
      ${ready?'':'<p class="security-note">执行环境未就绪：必须先在工具设置中配置 Sandboxie，并完成隔离测试与人工验收确认，才能发放权限。</p>'}
      ${grantForm}<p class="fineprint">此项不授予 npm 安装、插件发布、Windows 宿主文件、终端或全盘访问权限；也不会关闭沙箱安全检查。</p></section>
      <section class="panel"><h2>当前有效授权</h2>${leases.length?leases.map(l=>`<div class="lease-entry"><b>${escape(l.plugin_name)}</b><small>${identityText(l.owner)}</small><small>到期时间：${escape(new Date(l.expires).toLocaleString('zh-CN',{hour12:false}))} · 剩余 ${Math.max(0,Math.ceil((l.expires-now)/60000))} 分钟</small>${action('revoke_hour',l.id,'立即撤销','danger')}</div>`).join(''):'<p>没有有效的临时权限。</p>'}<p class="fineprint">页面每次刷新都会重新计算剩余时间。到期后无需操作，服务端自动拒绝使用已过期的权限。</p></section></div>
      <section class="panel"><h2>权限边界</h2><p>同一 Cloudflare 登录邮箱如果由多个 Agent 共用，临时授权也会被它们共同使用。可继续使用原有一次性 approval_id；停用插件会撤销其所有临时授权。</p></section>`,publicMode);
  }
  if(path==='/sandboxes'){
    const now=Date.now(),passes=store.hostPasses(now);
    const options=[...c.emails].sort().map(x=>`<option value="${escape(x)}">${identityText(x)}</option>`).join('');
    const dangerous=options?`<form action="/action" method="post" class="lease-form host-open-form">
      <input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="kind" value="grant_host_hour">
      <label for="direct-owner">宿主直通身份（Cloudflare 邮箱）</label>
      <select name="owner" id="direct-owner" required>${options}</select>
      <p>开启后，该身份可在 60 分钟内调用所有已发布 JS 插件，且可直接调用 <code>terminal_exec</code> 执行 PowerShell / CMD / 程序命令；<strong>均不经过 Sandboxie、Node Permission Model 或逐次手机审批</strong>。命令获得运行 Asterline 的 Windows 账户所拥有的文件、进程和网络权限。</p>
      <p class="security-note">极高风险：Agent 在这一小时内可直接运行 Windows 命令；文件删除、网络传输、计划任务、持久化及已创建的子进程不能保证因到期而撤销。单次命令最多运行 120 秒；过期拒绝新调用，提前撤销尝试终止正在运行的进程树。</p>
      <label for="danger-phrase">请输入「${'我确认完全开放宿主机1小时'}」</label>
      <input id="danger-phrase" name="confirm" autocomplete="off" spellcheck="false" required placeholder="请输入完整确认语句">
      <label class="acknowledge"><input type="checkbox" name="ack" value="yes" required> 我理解插件及 PowerShell/CMD 命令可以直接在宿主机运行，可能无法回滚其副作用</label>
      <button type="submit" class="danger">启用宿主直通 · 固定 60 分钟</button>
    </form>`:'<p>必须先配置允许的 Access 邮箱身份。</p>';
    return base(c,store,'沙箱',`<section class="heading"><div><p>SANDBOX / HOST EXECUTION</p><h1>沙箱运行时</h1><span>常规执行继续使用 Sandboxie。宿主直通为单独的高风险管理员授权。</span></div><div class="chip">${sandboxReady?'✓ 沙箱就绪':'○ 沙箱未就绪'}</div></section>
      <section class="panel sandbox-summary"><h2>沙箱状态</h2><div class="sandbox-facts"><div class="kv"><span>Box</span><code>${escape(c.sandboxieBox)}</code></div><div class="kv"><span>Start.exe</span><code>${escape(c.sandboxieStart||'Not set')}</code></div><div class="kv"><span>隔离确认</span><strong>${c.sandboxConfirmed?'已确认':'未确认'}</strong></div></div><a href="/settings" class="link">沙箱配置与验收 →</a><a href="/jobs" class="link">运行任务 →</a></section>
      <section class="panel high-risk"><h2>完全开放执行权限 · 1 小时</h2><p>包含已发布插件和 terminal_exec 终端命令</p>${dangerous}</section>
      <section class="panel"><h2>当前宿主直通授权</h2>${passes.length?passes.map(l=>`<div class="lease-entry"><b>${identityText(l.owner)}</b><small>授权人：${identityText(l.actor)}</small><small>到期：${escape(new Date(l.expires).toLocaleString('zh-CN',{hour12:false}))}，剩余 ${Math.max(0,Math.ceil((l.expires-now)/60000))} 分钟</small>${action('revoke_host_hour',l.id,'立即撤销宿主直通','danger')}</div>`).join(''):'<p>宿主直通已关闭；没有有效授权。</p>'}<p class="fineprint">每次调用检查身份与到期时间。禁止自动续期；手动撤销后同一小时内也不能再次开启。</p></section>`,publicMode);
  }
  if(path==='/settings'){
    const persist=store.runtimeSettings();
    const v=(key:string,defaultValue:string)=>persist[key]??defaultValue;
    const entry=(key:keyof typeof RUNTIME_LABELS,value:string,desc:string,large=false)=>`<form class="setting-row" method="post" action="/action"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="kind" value="save_setting"><input type="hidden" name="id" value="${escape(key)}"><label for="setting-${escape(key)}"><strong>${escape(RUNTIME_LABELS[key])}</strong><small>${escape(desc)}</small></label>${large?`<textarea id="setting-${escape(key)}" name="value" rows="2" spellcheck="false" maxlength="4000">${escape(value)}</textarea>`:`<input id="setting-${escape(key)}" name="value" value="${escape(value)}" maxlength="4000" autocomplete="off" spellcheck="false">`}<button type="submit">保存并应用</button></form>`;
    return base(c,store,'工具设置',`<section class="heading"><div><p>TOOL CONFIGURATION</p><h1>工具设置</h1><span>工作区、沙箱、通知与云盘配置。工具调用仍受权限中心控制。</span></div></section>
      <p class="settings-note">无需编辑 .env 或维护程序白名单；不再要求程序名称白名单。修改工作区会撤销旧授权，修改沙箱路径需重新验收。</p>
      <div class="setting-section"><h2>工作区与受控任务</h2>${entry('workspaceRoot',c.workspaceRoot,'必须存在；新工作区需要重新批准开发任务')}${entry('maxPluginSeconds',String(c.maxPluginSeconds),'2–120 秒')}</div>
<div class="setting-section"><h2>沙箱路径</h2>${entry('sandboxieStart',c.sandboxieStart,'已安装 Sandboxie Plus 的 Start.exe')}${entry('sandboxieBox',c.sandboxieBox,'例如 AsterlinePlugins')}${entry('sandboxieBoxRoot',c.sandboxieBoxRoot,'Sandboxie 的物理容器根目录；修改会锁定沙箱，需要重新验收')}</div>
      <section class="panel qa-panel"><details><summary class="qa-summary"><span>沙箱隔离验收</span><strong class="${c.sandboxConfirmed?'qa-good':'qa-locked'}">${c.sandboxConfirmed?'已确认':'未确认 / 锁定'}</strong></summary><div class="qa-details"><p>必须先在 Windows 上完成 Sandboxie 隔离 QA，确认 WFP 和文件访问限制，再手动验收。调整沙箱路径后验收自动失效。</p>${c.sandboxConfirmed?action('lock_sandbox','','立即锁定沙箱','danger'):`<form class="lease-form" method="post" action="/action"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="kind" value="confirm_sandbox"><label for="confirm-sandbox">输入「我已验证Sandboxie隔离」</label><input id="confirm-sandbox" name="confirm" required autocomplete="off"><button type="submit" class="danger">确认 QA 完成并解锁</button></form>`}</div></details></section>
            <div class="setting-section"><h2>通知与云盘</h2>${entry('gotify',c.gotify,'本机 Gotify 服务地址；访问令牌仍属于机密配置')}${entry('rcloneRemote',v('rcloneRemote',process.env.LIBRARY_RCLONE_REMOTE||''),'先用 rclone config 授权，再在此选择现有远端子目录')}${entry('rcloneLocal',v('rcloneLocal',process.env.LIBRARY_CLOUD_LOCAL_ROOT||resolve('library-sync')),'同步的本机绝对路径')}${entry('rcloneExe',v('rcloneExe',process.env.LIBRARY_RCLONE_EXE||'rclone'),'rclone 或已安装的 rclone.exe 绝对路径')}</div><div class="setting-section"><h2>ChatGPT Library 下载来源</h2>${entry('libraryFileHosts',c.libraryFileHosts?.join(',')||'*.oaiusercontent.com,*.openai.com,*.chatgpt.com','默认支持 ChatGPT/OpenAI 官方域名。若报错，只添加确认来自 ChatGPT 的精确主机名，禁止直接填写签名 URL。',true)}</div>`,publicMode);
  }
  if(path==='/operations'){
    const names:[string,string][]=[['file_write','旧版单次文件写入'],['command_exec','宿主后台任务（单次审批）'],['notify_task_start','任务开始通知'],['notify_task_end','任务结束通知'],['notify_manual','手动通知']];
    return base(c,store,'运维',`<section class="heading"><div><p>RUNTIME OPERATIONS</p><h1>功能开关</h1><span>危险能力独立开关，默认关闭。旧版开关只适用于旧接口。开发工作授权由权限中心独立审核；旧全局 approval_required 不再用于绕过审批。</span></div></section><section class="panel"><h2>受控操作</h2>${names.map(([id,label])=>`<div class="kv"><span>${escape(label)} · ${escape(id)}</span><b>${store.flag(id)?'已开启':'已关闭'}</b>${action('set_flag',id,store.flag(id)?'关闭':'开启',store.flag(id)?'danger':'')}</div>`).join('')}<p class="security-note">已批准的一次性操作只允许精确匹配的文件内容或命令参数；终端宿主直通依然走独立的一小时高风险授权。</p></section>`,publicMode);
  }
  if(path==='/jobs'){
    const jobs=store.db.prepare('SELECT * FROM js_jobs ORDER BY started DESC LIMIT 80').all() as any[];
    return base(c,store,'任务',`<section class="heading"><div><p>BACKGROUND JOBS</p><h1>后台任务</h1></div></section><section class="panel table-wrap"><table><thead><tr><th>ID / 标签</th><th>属主</th><th>状态</th><th>时间 / 操作</th></tr></thead><tbody>${jobs.map(j=>`<tr><td>${escape(j.id)}<small>${escape(j.label)}</small></td><td>${identityText(j.owner)}</td><td>${escape(j.state)}</td><td>${escape(new Date(j.started).toLocaleString('zh-CN'))}${j.state==='running'?action('job_cancel',j.id,'终止任务','danger'):''}</td></tr>`).join('')||'<tr><td colspan="4">暂无任务</td></tr>'}</tbody></table></section>`,publicMode);
  }
  if(path==='/notifications'){
    const rows=store.db.prepare('SELECT * FROM js_notifications ORDER BY id DESC LIMIT 80').all() as any[];
    return base(c,store,'通知',`<section class="heading"><div><p>GOTIFY OUTBOX</p><h1>通知队列</h1><span>持久化、指数退避重试（最多六次），重启后恢复待发消息。</span></div></section><section class="panel"><h2>通道</h2><p>${c.gotifyToken&&safeGotifyUrl(c.gotify)?'已配置':'未配置'} · ${escape(c.gotify)}</p>${action('notify_test','','发送测试消息')}</section><section class="panel table-wrap"><table><thead><tr><th>ID</th><th>事件 / 标题</th><th>状态</th><th>次数</th></tr></thead><tbody>${rows.map(n=>`<tr><td>${escape(n.id)}</td><td>${escape(n.event)} · ${escape(n.title)}</td><td>${escape(n.state)}</td><td>${escape(n.attempts)}</td></tr>`).join('')||'<tr><td colspan="4">暂无通知</td></tr>'}</tbody></table></section>`,publicMode);
  }
  if(path==='/audit'){const rows=store.db.prepare('SELECT * FROM js_audit ORDER BY id DESC LIMIT 100').all() as any[];return base(c,store,'日志',`<section class="heading"><div><p>AUDIT TRAIL</p><h1>审计记录</h1></div></section><section class="panel table-wrap"><table><thead><tr><th>时间</th><th>用户</th><th>操作</th><th>详情</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${escape(r.at)}</td><td>${identityText(r.actor)}</td><td>${escape(r.action)}</td><td>${escape(r.detail)}</td></tr>`).join('')}</tbody></table></section>`,publicMode);}
  return null;
}
export function createAdmin(c:Config,store:Store,auth:AccessAuth,ops:{jobs:JobManager;preflight:(id:string)=>Promise<unknown>;install:(id:string)=>Promise<unknown>;sandboxReady:()=>boolean;cancelHostPass?:(id:string)=>void}){
  type UiJob={id:string;actor:string;pluginId:string;kind:'preflight'|'install';state:'running'|'succeeded'|'failed';started:number;finished?:number;error?:string};
  const jobs=new Map<string,UiJob>(),running=new Set<string>();
  const destination=(k:string)=>['approve_work','deny_work','revoke_work'].includes(k)?'/access':['save_setting','confirm_sandbox','lock_sandbox'].includes(k)?'/settings':k==='set_flag'?'/operations':k==='job_cancel'?'/jobs':k==='notify_test'?'/notifications':['approve','deny'].includes(k)?'/approvals':['grant_hour','revoke_hour'].includes(k)?'/permissions':['grant_host_hour','revoke_host_hour'].includes(k)?'/sandboxes':'/plugins';
  async function pluginOperation(k:'preflight'|'install',id:string){if(!id||!store.get(id))throw Error('Unknown plugin');if(running.has(id))throw Error('This plugin is already being processed');running.add(id);try{if(k==='preflight')await ops.preflight(id);else await ops.install(id);}finally{running.delete(id);}}
  function prune(){for(const [id,j] of jobs)if(j.finished&&Date.now()-j.finished>600000)jobs.delete(id);}

  async function handle(req:IncomingMessage,res:ServerResponse,publicMode:boolean){
    const headers={'Cache-Control':'no-store, no-transform','Referrer-Policy':'same-origin','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Content-Security-Policy':"default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"};
    function respond(code:number,body:string|Buffer,type='text/plain; charset=utf-8') {res.writeHead(code,{...headers,'Content-Type':type});res.end(body);}
    const expectedHost=publicMode?c.publicHost:`127.0.0.1:${c.localAdminPort}`;
    const allowedLocal=new Set([expectedHost,`localhost:${c.localAdminPort}`]);
    if(typeof req.headers.host!=='string'||(publicMode?req.headers.host!==expectedHost:!allowedLocal.has(req.headers.host)))return respond(403,'Bad Host');
    let adminActor='admin:local';
    if(publicMode){try{adminActor='admin:'+await auth.verify(String(req.headers['cf-access-jwt-assertion']||''),c.adminAud);}catch{return respond(403,'Access identity required');}}
    if(!verifyAdminBasic(req.headers.authorization,c.password)){res.writeHead(401,{'WWW-Authenticate':'Basic realm="Asterline Control Center"','Cache-Control':'no-store, no-transform'});return res.end('Admin password required');}
    const pathname=new URL(req.url||'/',`http://${expectedHost}`).pathname;
    if(req.method==='GET'){
      if(pathname==='/ui-operation'){
        prune();const job=jobs.get(new URL(req.url||'/',`http://${expectedHost}`).searchParams.get('id')||'');
        if(!job||job.actor!==adminActor)return respond(404,JSON.stringify({ok:false,error:'Unknown or expired operation'}),'application/json; charset=utf-8');
        return respond(200,JSON.stringify({ok:true,state:job.state,started:job.started,finished:job.finished,error:job.error,kind:job.kind,redirect:destination(job.kind)}),'application/json; charset=utf-8');
      }
      if(pathname==='/status.json'){
        const jobs=store.db.prepare("SELECT count(*) AS n FROM js_jobs WHERE state='running'").get() as {n:number};
        const alerts=store.db.prepare("SELECT count(*) AS n FROM js_notifications WHERE state='pending'").get() as {n:number};
        return respond(200,JSON.stringify({catalogRevision:store.revision(),activePlugins:store.active().length,pendingApprovals:store.pending().length+store.pendingWorkRequests().length,activeWorkSessions:store.activeWorkSessions().length,activeJobs:jobs.n,pendingNotifications:alerts.n,sandboxReady:ops.sandboxReady(),features:Object.fromEntries(['file_write','command_exec','notify_task_start','notify_task_end','notify_manual'].map(x=>[x,store.flag(x)]))}), 'application/json; charset=utf-8');
      }
      const assets:Record<string,[string,string]>={
       '/assets/admin.css':['admin.css','text/css; charset=utf-8'], '/assets/admin.js':['admin.js','text/javascript; charset=utf-8'],
       '/assets/icon.svg':['icon.svg','image/svg+xml'], '/assets/icon-192.png':['icon-192.png','image/png'],
       '/assets/icon-512.png':['icon-512.png','image/png'], '/assets/icon-maskable-512.png':['icon-maskable-512.png','image/png'],
       '/manifest.webmanifest':['manifest.webmanifest','application/manifest+json; charset=utf-8'],
       '/sw.js':['sw.js','text/javascript; charset=utf-8'], '/offline.html':['offline.html','text/html; charset=utf-8']};
      const asset=assets[pathname];if(asset){
       if(pathname==='/sw.js')res.setHeader('Service-Worker-Allowed','/');
       if(!existsSync(resolve('public',asset[0])))return respond(404,'Not found');
       return respond(200,readFileSync(resolve('public',asset[0])),asset[1]);
      }
      const html=render(c,store,pathname,publicMode,ops.sandboxReady());return html?respond(200,html,'text/html; charset=utf-8'):respond(404,'Not found');
    }
    if(req.method!=='POST'||pathname!=='/action')return respond(405,'Method not allowed');
    if(!checkOrigin(req.headers,String(req.headers.host)))return respond(403,'Bad Origin');
    let raw='';try{for await(const chunk of req){raw+=chunk;if(raw.length>10000)throw Error('Body too large');}}catch{return respond(413,'Body too large');}
    const form=new URLSearchParams(raw);
    if(form.get('csrf')!==csrf)return respond(403,'Bad CSRF');
    const kind=form.get('kind'),id=form.get('id')||'';
    const jsonUi=req.headers['x-asterline-async']==='1';
    if(jsonUi&&(kind==='preflight'||kind==='install')){
      if(!id||!store.get(id))return respond(404,JSON.stringify({ok:false,error:'Unknown plugin'}),'application/json; charset=utf-8');
      if(running.has(id))return respond(409,JSON.stringify({ok:false,error:'该插件已有操作正在执行'}),'application/json; charset=utf-8');
      prune();if(jobs.size>=100)return respond(503,JSON.stringify({ok:false,error:'Too many recent operations'}),'application/json; charset=utf-8');
      running.add(id);const job:UiJob={id:randomUUID(),actor:adminActor,pluginId:id,kind,started:Date.now(),state:'running'};jobs.set(job.id,job);
      queueMicrotask(()=>{void(async()=>{try{if(kind==='preflight')await ops.preflight(id);else await ops.install(id);job.state='succeeded';}catch(e){job.state='failed';job.error=String(e).slice(0,500);}finally{job.finished=Date.now();running.delete(id);}})();});
      return respond(202,JSON.stringify({ok:true,state:'running',id:job.id,kind,redirect:destination(kind)}),'application/json; charset=utf-8');
    }
    try{
      switch(kind){
        case 'preflight':await pluginOperation('preflight',id);break;
        case 'install':await pluginOperation('install',id);break;
        case 'publish':{const target=store.get(id);if(!target)throw Error('Missing plugin');const name=JSON.parse(target.manifest).tool.name;if(store.active().some(r=>r.id!==id&&JSON.parse(r.manifest).tool.name===name))throw Error('Tool name is already active');store.transition(id,['installed','disabled'],'active');break;}
        case 'disable':store.transition(id,['active'],'disabled');break;
        case 'reject':store.transition(id,['draft','reviewed'],'rejected');break;
        case 'approve_work':{
          const row=store.workRequest(id);if(!row)throw Error('Unknown task request');
          if(!c.emails.has(row.owner))throw Error('Owner no longer allowed');
          validateWorkRoot(c,row.workspace);const caps=validateWorkCapabilities(JSON.parse(row.capabilities));
          if(caps.includes('sandbox_plugin')&&!ops.sandboxReady())throw Error('Sandboxie not ready: cannot approve sandbox plugin execution');
          store.decideWorkRequest(id,true,adminActor);break;
        }
        case 'deny_work':store.decideWorkRequest(id,false,adminActor);break;
        case 'revoke_work':store.revokeWorkSession(id,adminActor);break;
        case 'grant_hour':{
          if(!ops.sandboxReady())throw Error('Sandboxie runtime is not confirmed/ready; one-hour permission cannot override sandbox safety');
          const owner=String(form.get('owner')||'').toLowerCase();
          if(!c.emails.has(owner))throw Error('Unknown or unapproved Access identity');
          store.grantHour(owner,id,adminActor);break;
        }
        case 'revoke_hour':store.revokeLease(id,adminActor);break;
        case 'grant_host_hour':{
          const owner=String(form.get('owner')||'').trim().toLowerCase();
          if(!c.emails.has(owner))throw Error('Unknown or unapproved Access identity');
          if(form.get('confirm')!=='我确认完全开放宿主机1小时'||form.get('ack')!=='yes')
            throw Error('Explicit host execution risk acknowledgment required');
          store.grantHostHour(owner,adminActor);break;
        }
        case 'revoke_host_hour':store.revokeHostPass(id,adminActor);ops.cancelHostPass?.(id);break;
        case 'confirm_sandbox':{
          if(form.get('confirm')!=='我已验证Sandboxie隔离')throw Error('需要手动输入沙箱 QA 确认语句');
          if(process.platform!=='win32'||!c.sandboxieStart||!existsSync(c.sandboxieStart)||
             !c.sandboxieBoxRoot||!existsSync(c.sandboxieBoxRoot)||
             !/^[A-Za-z0-9_-]{3,40}$/.test(c.sandboxieBox))throw Error('Sandboxie 未安装或配置不完整');
          store.setRuntimeSetting('sandboxConfirmed','1',adminActor);
          c.sandboxConfirmed=true;
          break;
        }
        case 'lock_sandbox':{
          store.setRuntimeSetting('sandboxConfirmed','0',adminActor);
          c.sandboxConfirmed=false;
          break;
        }
        case 'save_setting':{saveRuntimeSetting(c,store,id,String(form.get('value')??''),adminActor);break;}
        case 'set_flag':store.setFlag(id,!store.flag(id),adminActor);break;
        case 'job_cancel':ops.jobs.cancel(adminActor,id,true);break;
        case 'notify_test':{
          if(!c.gotifyToken||!safeGotifyUrl(c.gotify))throw Error('Gotify not configured');
          await notify(c,'Asterline · 测试通知','管理员面板测试通知',5,'test');break;
        }
        case 'approve':store.decide(id,true);break;
        case 'deny':store.decide(id,false);break;
        default:return respond(400,'Invalid action');
      }
    }catch(e){if(jsonUi)return respond(409,JSON.stringify({ok:false,error:String(e).slice(0,700)}),'application/json; charset=utf-8');return respond(409,base(c,store,'操作失败',`<section class="panel error-card"><h1>操作未完成</h1><p>服务端未完成该操作。请检查下方原因，返回重试。</p><pre>Action failed: ${escape(String(e).slice(0,700))}</pre><a class="hero-primary" href="/">返回工作台 →</a></section>`,publicMode),'text/html; charset=utf-8');}
    const dest=form.get('return_to')==='/access'&&['approve_work','deny_work','approve','deny','revoke_work','revoke_hour','revoke_host_hour'].includes(String(kind))?'/access':destination(String(kind));if(jsonUi)return respond(200,JSON.stringify({ok:true,kind,redirect:dest}),'application/json; charset=utf-8');res.writeHead(303,{...headers,Location:dest+'?done='+encodeURIComponent(String(kind))});res.end();
  }
  return {start(){
    if(c.password.length<20){console.error('Admin disabled: ADMIN_PASSWORD must contain at least 20 characters');return;}
    const local=http.createServer((req,res)=>{void handle(req,res,false);}).listen(c.localAdminPort,'127.0.0.1',()=>console.log(`Local admin http://127.0.0.1:${c.localAdminPort}/`));
    let publicServer:ReturnType<typeof http.createServer>|undefined;
    if(c.adminAud&&c.teamDomain.startsWith('https://')&&c.emails.size){publicServer=http.createServer((req,res)=>{void handle(req,res,true);}).listen(c.publicAdminPort,'127.0.0.1',()=>console.log(`Cloudflare admin origin 127.0.0.1:${c.publicAdminPort} host ${c.publicHost}`));}
    return {local,publicServer};
  }};
}
