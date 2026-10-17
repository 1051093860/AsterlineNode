# Asterline v1.7.1 — 管理后台应用化 + PWA

这是一轮 UI/PWA 升级，不修改 MCP 插件协议、Sandboxie、SQLite 表、Cloudflare OAuth、Host / Basic / JWT / CSRF 验证与一小时宿主直通策略。

**体验**：桌面侧栏分组、运行概况、手机底部快捷导航、可展开的侧边栏、审批卡片、搜索页面（Ctrl+K）、暗亮主题、操作完成提示、操作失败页、服务在线状态检查。

**PWA**：独立窗口显示、主屏幕图标（192/512/Maskable）、manifest、Service Worker、通用离线提示。所有静态文件在本机提供，不使用 CDN。

## 升级方法（推荐增量包）

1. 停止运行中的 Node Asterline MCP；备份 `C:\Users\YourName\Desktop\AsterlineNode`，特别是 `.env` 和 `.state-node`。
2. 下载 **升级补丁 ZIP**，解压覆盖到原项目。文件范围：`src/admin.ts`、`public/`、`scripts/check-pwa.mjs`、`tests/pwa-ui.test.mjs`、`package.json` 和本说明。不会覆盖数据库与 `.env`。
3. 在 PowerShell 中运行：

```powershell
cd C:\Users\YourName\Desktop\AsterlineNode
pnpm run check
pnpm test
pnpm start
```

4. 另开终端执行 `pnpm run check:pwa`。检查本机管理入口 `http://127.0.0.1:8865/` （如 `.env` 指定其他 `ADMIN_LOCAL_PORT`，以实际值为准）。
5. 验证公网 `https://mcpadmin.asterline.dev/`。原 Cloudflare Tunnel 和 Access 配置不需要改动。

## 安装成 PWA

- Android Chrome：先通过 Cloudflare Access / WAF / Basic 认证，进入管理首页，再点击右上角安装图标或 Chrome 的「安装应用／添加到主屏幕」。
- iOS Safari：打开管理首页 → 分享 → 添加到主屏幕。iOS 不支持 Chromium `beforeinstallprompt`，右上角按钮会显示操作说明。
- 桌面 Chrome / Edge：使用地址栏安装按钮或后台右上角安装图标。
- 已安装应用仍需联网和登录；Cloudflare Access/WAF 挑战可能在独立窗口里要求重新登录，先从浏览器认证再返回 PWA 即可。

## 安全限制（特意保留）

- SW 只缓存固定的 CSS、JS、图标和 `offline.html`；**绝不缓存** `/action`、`/status.json`、`/approvals`、`/plugins`、`/sandboxes` 及任何后台 HTML 页面。
- 已登录后断网只能看到通用离线说明，不能离线审批、执行命令、开启权限或读取上次的管理记录。
- 静态缓存内容只包含重新构造的正文和 Content-Type，不保留原始认证或 `Set-Cookie` 响应头。
- 原管理员 Host、Cloudflare Access JWT、Basic、Origin、CSRF 与 `Cache-Control: no-store` 依旧生效。
- 唯一保存到浏览器 localStorage 的内容是暗色／亮色主题偏好。

## 验收情况

在本地构建环境检查 JavaScript 和 TypeScript 语法，运行 26 项 Node 回归（24 项原有 + 2 项 PWA），包括管理员资源鉴权和 PWA 静态缓存边界。当前环境未完成真实 Chromium PWA 安装、真实安卓安装和 Cloudflare 端到端实机测试，请在 Windows 上复验。

如果更新后仍是旧页面：先重启 Node 并强制刷新页面；如已安装 PWA，使用 Chrome DevTools → Application → Service Workers → Update / Update on reload，再打开应用。请不要为了刷新 UI 清空生产数据库。
