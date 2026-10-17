# Asterline Node v1.9.3 — 紧凑管理后台

基于 v1.9.2，**本版本只调整管理员 UI 和交互路径**。不修改 MCP 工具行为、SQLite 表结构、Sandboxie 执行器、Cloudflare Access 身份检查和宿主直通的风险确认。

## 主要变化

- 左侧主导航由 13 个平铺入口变为 **8 个常用入口**：概览、审批与授权、插件、任务、文件桥、工具设置、运行环境、审计记录；其他 5 项折叠在「高级功能」。原路由仍可直接访问。
- **`/access` 是唯一日常审批收件箱**：任务级请求和单次操作请求按申请时间统一排列，并显示独立风险类型；同页查看有效开发授权、单插件临时授权和宿主直通及撤销。为了不回跳，来自此页的审批和撤销操作完成后仍返回 `/access`。
- 首页移除了大幅装饰 Hero、重复的快捷入口及冗余说明；保留 4 个统计、待办和沙箱/宿主高权限状态。
- `/settings` 各项配置改为行式表格，每个设置仍有独立保存动作，避免无意覆盖其它字段；异常沙箱验收入口折叠，并始终显示「已确认」或「未确认 / 锁定」。
- `/sandboxes` 不再重复列出最近任务，改为链接到唯一的 `/jobs` 列表。
- 修复旧交互：在 `/settings` 保存时更新当前页；统一收件箱不会在批准一次性请求后跳回旧版 `/approvals`。
- PWA 静态缓存版本更新到 `v193`。管理员 HTML、审批 POST、status.json 和其它敏感信息仍不参与离线缓存。

## 升级

1. 备份 `C:\Users\YourName\Desktop\AsterlineNode` 和 `.state-node`。
2. 停止当前 Asterline Node 服务。
3. **增量包解压覆盖**该项目目录。不要覆盖 `.env`、数据库、个人工作区或 Sandboxie 配置。
4. 在项目 PowerShell 执行：

```powershell
cd C:\Users\YourName\Desktop\AsterlineNode
pnpm run check
pnpm test
pnpm start
```

5. 打开 `https://mcpadmin.asterline.dev/access`。桌面可以 `Ctrl+Shift+R` 刷新静态缓存；PWA 手机安装版完全退出再打开（Service Worker 激活后才会换静态资源）。

> 不需要新的环境变量、Cloudflare Tunnel 路由或权限迁移。原有 `/approvals`、`/permissions`、`/operations`、`/dependencies`、`/notifications` 页面依旧可用。高风险授权仍必须在原有服务器校验下完成。

## 本地测试与未覆盖项

在容器 Node 22 兼容测试环境运行 `node --experimental-strip-types --test tests/*.test.mjs`，**57 / 57 通过**。其中 3 项为新增 UI 专项测试，验证主导航、同页两类审批、原有 `/action` 的精确审批及原地返回路径，以及设置行式表单。使用本机 Chromium 离线渲染桌面 1440px、手机 390px 的概览、审批和设置页，均未出现水平溢出。

**未验证**：实际 Windows Node 24 的完整 TypeScript `pnpm run check`、Cloudflare Access 公网、安卓 PWA 安装和真实数据规模下的交互性能。上线前先验证本地管理入口，再核验公网与移动端。不把视觉快照或离线回归当作真实部署成功。
