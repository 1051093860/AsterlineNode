/* Responsive Asterline Control — server remains authority for auth, CSRF, approval. */
(()=>{'use strict';
const $=q=>document.querySelector(q);let installer,toastTimeout,navAbort,submitting=false;
const sidebar=$('#sidebar'),scrim=$('#scrim'),modal=$('#commandModal'),input=$('#commandInput');
const labels={preflight:'依赖预检',install:'依赖安装',publish:'发布工具',disable:'停用工具',approve:'批准请求',deny:'拒绝请求',approve_work:'批准开发任务',deny_work:'拒绝开发任务',revoke_work:'撤销开发权限',grant_hour:'授权一小时',revoke_hour:'撤销授权',grant_host_hour:'启用宿主直通',revoke_host_hour:'撤销宿主直通',set_flag:'更新设置',job_cancel:'终止任务',notify_test:'发送通知',reject:'拒绝插件'};
function toast(message,bad=false){const el=$('#toast');if(!el)return;clearTimeout(toastTimeout);el.textContent=message;el.classList.toggle('is-error',bad);el.hidden=false;toastTimeout=setTimeout(()=>el.hidden=true,5500);}
function status(message){let bar=$('#uiProgress');if(!bar){bar=document.createElement('div');bar.id='uiProgress';bar.className='ui-progress';bar.setAttribute('role','status');bar.setAttribute('aria-live','polite');bar.innerHTML='<div class="ui-progress-bar"></div><span></span>';document.body.appendChild(bar);}bar.hidden=!message;if(message)bar.lastElementChild.textContent=message;}
function drawer(open){sidebar?.classList.toggle('open',open);if(scrim)scrim.hidden=!open;$('#menu')?.setAttribute('aria-expanded',String(open));}
function filter(){let q=(input?.value||'').toLowerCase().trim();document.querySelectorAll('.command-links a').forEach(a=>a.hidden=!(a.dataset.keyword||'').toLowerCase().includes(q));}
function commands(open){if(!modal)return;modal.hidden=!open;if(open){input.value='';filter();input.focus();}}
async function navigate(url,{historyChange=true}={}){
 const dest=new URL(url,location.href);if(dest.origin!==location.origin){location.assign(dest.href);return;}
 navAbort?.abort();const ctrl=new AbortController();navAbort=ctrl;const timer=setTimeout(()=>ctrl.abort(),20000);status('正在打开页面…');
 try{
  const res=await fetch(dest.pathname+dest.search,{cache:'no-store',credentials:'same-origin',signal:ctrl.signal,headers:{Accept:'text/html'}});
  const type=res.headers.get('content-type')||'';
  if(res.status===401||res.status===403||res.redirected||res.url&&new URL(res.url).origin!==location.origin){location.assign(dest.href);return;}
  if(!res.ok||!type.includes('text/html'))throw Error('HTTP '+res.status);
  const doc=new DOMParser().parseFromString(await res.text(),'text/html');
  for(const sel of ['.content','#sidebar','.mobile-tabs','.breadcrumb'])if(!doc.querySelector(sel)||!$(sel))throw Error('管理登录可能已失效');
  for(const sel of ['.content','#sidebar','.mobile-tabs','.breadcrumb'])$(sel).innerHTML=doc.querySelector(sel).innerHTML;
  document.title=doc.title;drawer(false);commands(false);if(historyChange)history.pushState({},'',dest.pathname+dest.search);window.scrollTo(0,0);
  if(dest.searchParams.has('done')){history.replaceState({},'',dest.pathname);toast('操作已完成');}
 }catch(e){if(!ctrl.signal.aborted||navAbort===ctrl)toast('页面加载失败，请重试：'+String(e.message||e),true);}
 finally{clearTimeout(timer);if(navAbort===ctrl){navAbort=null;status('');}}
}
const risky={disable:'确认停用插件？',reject:'拒绝插件草案？',revoke_work:'立即撤销开发任务权限？',revoke_host_hour:'立即撤销宿主直通？',job_cancel:'终止后台任务？'};
let pendingConfirmation=false;
function confirmAction(message){if(pendingConfirmation)return Promise.resolve(false);pendingConfirmation=true;const panel=document.createElement('dialog'),text=document.createElement('p'),yes=document.createElement('button'),no=document.createElement('button');text.textContent=message;yes.textContent='确认';no.textContent='取消';panel.setAttribute('aria-label','确认操作');panel.append(text,yes,no);document.body.append(panel);return new Promise(resolve=>{const finish=value=>{pendingConfirmation=false;panel.close();panel.remove();resolve(value);};yes.onclick=()=>finish(true);no.onclick=()=>finish(false);panel.oncancel=e=>{e.preventDefault();finish(false);};panel.showModal();no.focus();});}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function submit(form,ev){
 const kind=form.querySelector('[name=kind]')?.value||'';
 if(risky[kind]&&!await confirmAction(risky[kind]))return;
 if(submitting){toast('已有操作正在执行，请等待',true);return;}
 // Capture parameters before disabling any controls: disabled values are not submitted.
 const body=new URLSearchParams(new FormData(form)),buttons=[...form.querySelectorAll('button[type=submit]')],prev=buttons.map(b=>[b,b.disabled,b.textContent]);
 buttons.forEach(b=>{b.disabled=true;b.classList.add('is-processing');b.textContent='处理中…';});form.setAttribute('aria-busy','true');submitting=true;
 const started=Date.now(),verb=labels[kind]||'提交操作',update=()=>status(`正在${verb} · ${Math.floor((Date.now()-started)/1000)} 秒`);update();const ticker=setInterval(update,1000);
 try{
  const res=await fetch('/action',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8','Accept':'application/json','X-Asterline-Async':'1'},body});
  if(!(res.headers.get('content-type')||'').includes('application/json'))throw Error(res.status===401||res.status===403?'登录已失效，请刷新页面重新验证':'结果暂时无法确认，请先查看页面状态，避免重复提交');
  const data=await res.json();if(!res.ok||!data.ok)throw Error(data.error||`HTTP ${res.status}`);
  if(res.status===202){
   let failures=0;while(true){await sleep(1300);let poll;
    try{let r=await fetch('/ui-operation?id='+encodeURIComponent(data.id),{cache:'no-store',credentials:'same-origin',headers:{Accept:'application/json'}});if(!r.ok)throw Error('HTTP '+r.status);poll=await r.json();failures=0;}
    catch{if(++failures>=3)throw Error('无法确认任务状态。安装可能仍在进行，请不要重复点击。');continue;}
    if(poll.state==='running')continue;
    if(poll.state==='failed')throw Error(poll.error||'后台任务失败');
    if(poll.state==='succeeded')break;
    throw Error('后台任务状态异常');
   }
  }
  if(location.pathname===(new URL(form.action)).pathname||['/plugins','/approvals','/access','/sandboxes','/permissions','/jobs','/operations','/notifications','/settings'].includes(location.pathname))await navigate(data.redirect||location.pathname,{historyChange:data.redirect!==location.pathname});
  toast(`${verb}已完成`);
 }catch(e){toast(String(e.message||e),true);}
 finally{clearInterval(ticker);for(const [b,disabled,label] of prev){b.disabled=disabled;b.textContent=label;b.classList.remove('is-processing');}form.removeAttribute('aria-busy');submitting=false;status('');}
}
// Event delegation survives partial page updates.
document.addEventListener('submit',e=>{if(e.target?.matches?.('form[action="/action"]')){e.preventDefault();void submit(e.target,e);}});
document.addEventListener('click',e=>{
 const target=e.target.closest?.('button,a');if(!target)return;
 const id=target.id;
 if(id==='menu'||id==='moreButton'){drawer(id==='moreButton'||!sidebar.classList.contains('open'));return;}
 if(id==='scrim'){drawer(false);return;}
 if(id==='searchButton'){commands(true);return;}
 if(target.hasAttribute('data-close')){commands(false);return;}
 if(id==='themeButton'){const v=document.documentElement.dataset.theme==='light'?'dark':'light';document.documentElement.dataset.theme=v;try{localStorage.setItem('asterline-theme',v);}catch{}return;}
 if(id==='installButton'){void(async()=>{if(matchMedia('(display-mode: standalone)').matches){toast('已在应用窗口中运行');return;}if(installer){const event=installer;installer=null;await event.prompt();return;}toast(/iPhone|iPad|iPod/.test(navigator.userAgent)?'Safari：分享 → 添加到主屏幕':'浏览器菜单 → 安装应用');})();return;}
 if(target.tagName==='A'&&!e.defaultPrevented&&e.button===0&&!e.ctrlKey&&!e.metaKey&&!e.shiftKey&&!e.altKey&&!target.hasAttribute('download')&&!target.target){let u=new URL(target.href,location.href);if(u.origin===location.origin&&u.pathname!==location.pathname&&u.pathname!=='/sw.js'&&!u.pathname.startsWith('/assets/')){e.preventDefault();void navigate(u.href);}}
});
input?.addEventListener('input',filter);
document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();commands(true);}if(e.key==='Escape'){commands(false);drawer(false);}});
window.addEventListener('popstate',()=>void navigate(location.href,{historyChange:false}));
try{const theme=localStorage.getItem('asterline-theme');if(['light','dark'].includes(theme))document.documentElement.dataset.theme=theme;}catch{}
const done=new URL(location.href).searchParams.get('done');if(done){toast('操作已完成');history.replaceState({},'',location.pathname);}
async function health(){const pill=$('#connectPill');if(!pill)return;let text='离线',online=false;try{if(navigator.onLine){const r=await fetch('/status.json',{cache:'no-store',headers:{Accept:'application/json'}});online=r.ok&&(r.headers.get('content-type')||'').includes('application/json');text=online?'管理服务在线':'需要登录';}}catch{text='连接中断';}pill.classList.toggle('offline',!online);pill.lastElementChild.textContent=text;}
void health();setInterval(()=>{if(!document.hidden)void health();},60000);
window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();installer=e;});
if('serviceWorker'in navigator&&(location.protocol==='https:'||['127.0.0.1','localhost'].includes(location.hostname)))window.addEventListener('load',()=>navigator.serviceWorker.register('/sw.js',{scope:'/'}).catch(()=>{}));
})();
