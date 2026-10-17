# Asterline Control Center v1.7.2 — 即时反馈 / 无整页重载

这个增量补丁以 **v1.7.1 PWA** 为基线。不会修改 `.env`、`.state-node`、Sandboxie 配置、Cloudflare Access 或 MCP 工具 API。

## 变化

- 管理页面内部导航采用同源 `fetch` 获取新的 HTML，原地更新页面内容与侧栏状态；点击立刻显示“正在打开页面”，避免等待整页重载才有反馈。
- `/action` 保留原有 POST + Origin + CSRF + Cloudflare Access JWT + Basic 验证。支持 AJAX JSON 响应；普通表单依然得到 303 重定向（无 JS 可用）。
- `preflight` 与 `install` 通过 HTTP 202 接收操作，再由 `GET /ui-operation?id=...` 返回状态。任务在服务端执行；浏览器显示经过时间和完成/失败结果。对同一个插件，重复预检或安装会得到 HTTP 409 而非执行两次。
- 审批、停用、设置和权限撤销直接显示“处理中”，防重复点击，完成后在当前应用中刷新相关内容。**没有乐观模拟批准/撤销**：只有服务端确认后才提示成功。
- 页面和授权数据始终 `Cache-Control: no-store`；PWA 缓存版本更新为 `v172`，仅保留白名单中的静态资源。

## 安装

1. 关闭目前的 Node.js Asterline 服务，备份 `C:\Users\YourName\Desktop\AsterlineNode`。
2. 将增量 ZIP 解压覆盖到 `C:\Users\YourName\Desktop\AsterlineNode`。不要修改 `.env` 和 `.state-node`。
3. PowerShell：

```powershell
cd C:\Users\YourName\Desktop\AsterlineNode
pnpm run check
pnpm test
pnpm start
```

4. 重启后，在另一个窗口执行：

```powershell
pnpm run check:pwa
```

5. 浏览器打开 `https://mcpadmin.asterline.dev/`，按 `Ctrl+Shift+R` 强制更新一次；安装的 PWA 可完全退出再重开。管理员点击时应立即出现顶部进度条和「处理中」状态。

## 验收项目

- 点击侧栏「插件」「审批」页面应立刻出现顶部加载提示，结束后不需要整页刷新。
- 使用测试插件执行 `preflight`，浏览器应在很短时间内收到 202，看到持续的耗时提示；完成后刷新状态并可继续审批。
- 安装依赖应先返回受理确认，后台继续安装；不能重复提交；网络中断时出现“不确定”提示，不要立即重试。
- 测试审批、拒绝、停用，按钮应立刻禁用并提示处理；出现错误时不会显示成功。
- 主动断开网络，确认不会离线审批，PWA 只提供离线说明。

## 安全限制和待做事项

- UI 任务状态保存于运行中的 Node.js 进程内存。如果 Node 服务重启或管理页面关闭，任务状态可能丢失；应在插件列表核对最终状态。生产级断点恢复需要将任务队列持久化到 SQLite。
- 任务状态只报告 `running/succeeded/failed` 和已耗时秒数，**不是 npm 安装百分比**。
- 无法消除 Cloudflare Access 登录本身的认证延迟，也不会绕过 CF/WAF 验证。
- 目前仅改善 UI 请求链路及页面切换，尚未实测你的 Windows/Cloudflare/PWA 手机上的真实延迟。

## 已完成的自动测试

28/28 Node 本地测试通过（含 v1.7 旧功能及新增 HTTP 202、身份隔离、CSRF、重复提交、状态查询、旧式表单 303 行为）。

如需进一步提升安装速度，应另行做依赖缓存、工作队列及服务器性能采样，不能用 UI 反馈替代真实性能优化。
