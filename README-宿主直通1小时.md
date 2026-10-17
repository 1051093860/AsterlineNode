# Asterline MCP Node v1.6.3 — 完全开放沙箱 1 小时（宿主直通）

> **警告：极高风险。** 这不是“扩大 Sandboxie 容器权限”，而是**完全不经过 Sandboxie**。获授权的 Agent 使用已发布 JS 插件时，插件会作为 Windows 宿主机 `node.exe` 进程运行，能够以运行 MCP 服务的 Windows 用户权限访问文件、网络、系统命令和进程。此模式不能隔离恶意插件。请只在你明确了解将运行的插件源代码和作用时启用。

## 安装条件

- 本补丁基于 **v1.6.1 Sandbox Result Bridge + v1.6.2 临时权限补丁**。安装前确保旧版能启动，`pnpm test` 正常。
- 管理员已配置 `ADMIN_PASSWORD`。公网入口需 Cloudflare Access JWT + 管理员密码，且 `MCP_ALLOWED_EMAILS` 只包含可信邮箱。
- **不要求将 `SANDBOX_POLICY_CONFIRMED` 改为 `1`。** 此次功能使用独立的宿主直通授权，不会修改 Sandboxie 配置；无有效直通授权时，常规隔离模式仍按原安全锁检查。

## 升级文件

停止 Node 服务，备份项目源码和 `.state-node`（特别是 `asterline.sqlite3*`，关闭进程后一起备份）。将 ZIP 按目录结构解压覆盖到 `C:\Users\YourName\Desktop\AsterlineNode`。补丁包含：

- `src/store.ts`：新增 `js_host_direct_leases` SQLite 授权表，自动建表迁移；不覆盖原授权记录。
- `src/admin.ts`：管理员 `/sandboxes` 页面增加宿主直通 1 小时、确认、查看余量、撤销。
- `src/server.ts`：已发布工具根据 Access 邮箱身份和有效授权选择独立宿主 Worker，而非 Sandboxie。
- `src/host-direct.ts`（新增）：独立 Node Worker、带任务 ID/随机校验 JSON、任务计时、任务状态及撤销终止。
- `public/admin.css`：移动端风险确认表单样式。
- `tests/host-direct-hour.test.mjs`：5 个安全逻辑及执行集成测试。

**不覆盖** `.env`、既有的 `src/runner.ts`、`src/sandbox-bridge.ts`、`src/plugin-worker.mjs`、`src/config.ts`、`package.json`、任何 SQLite 数据库及 Sandboxie 配置。

## Windows 测试

```powershell
cd C:\Users\YourName\Desktop\AsterlineNode
pnpm run check
pnpm test
node --test tests/host-direct-hour.test.mjs
npm start
```

本地管理面板：`http://127.0.0.1:8865/sandboxes`（端口以 `.env` 为准）。

手机公网管理面板：`https://mcpadmin.asterline.dev/sandboxes`（你的 Cloudflare Tunnel / Access 正确部署后）。

1. 在 **完全开放执行权限 · 1 小时** 区域选择授权邮箱。
2. 输入 `我确认完全开放宿主机1小时`，勾选风险确认，点击 **启用宿主直通**。
3. 该邮箱下的 Agent 在一个小时内调用**已安装并发布**的 JS 插件，绕过 Sandboxie 和逐次手机审批；当次不需要 `approval_id`。如果显式传入 `approval_id`，仍须验证这个票据，避免错误票据被忽略。
4. 管理页面显示到期时间及剩余分钟；可以提前点击 **立即撤销宿主直通**。
5. 授权到期时，服务器拒绝之后的新调用；已经启动的插件任务在默认 `MAX_PLUGIN_SECONDS`（通常 30 秒）与授权剩余时间两者中较短的期限内运行。手工撤销将尝试结束该授权下运行中的插件进程及其已知子进程（Windows 使用 `taskkill /T /F`）。

## 安全边界及不保证事项

- 只放开**一个 `MCP_ALLOWED_EMAILS` 中的身份**，不是匿名 Agent。共享同一个 Cloudflare 登录邮箱的所有 Agent 都能共享这段授权。
- 不允许 Agent 通过 MCP 自己开启、撤销或延长宿主直通；管理员 POST 需要 Basic、Cloudflare JWT（公网）、Origin、CSRF 和固定风险确认语句。
- SQLite 记录的有效期绝对为 3600000ms，重启不会重新计时。已提前撤销也不能在原有效期内再次授予同一邮箱。
- **不会自动批准 npm 安装、插件发布、工具草案；不会提供新 MCP shell 或文件管理工具**。但已发布插件在宿主机内可以运行代码，包括调用 Windows 命令或读取当前 Windows 账户可读的所有文件。
- **到期或撤销不保证清除或终止不受控的孙进程、计划任务、持久化、自启动项，也不能撤回已泄露数据或恢复已修改文件。** 不要在管理员权限下运行 Asterline 服务；建议专门的非管理员 Windows 账户和操作前备份。
- 测试环境验证的进程取消是在 Linux 上模拟的信号终止。Windows `taskkill /T /F`、Cloudflare 浏览器身份、真实沙箱与全链路执行需要在用户 Windows 上最终验证。
- 若确认模式不再需要，立即在 `/sandboxes` 撤销授权，并重启 MCP 服务检查是否有残留进程。

## 验证记录

构建环境 Node.js v22 原生 TypeScript 擦除模式：新测试 **5/5 通过**；与此前离线测试合并执行 **13/13 通过**。已验证：授权时间与身份、过期重试拒绝、管理员 Basic/Origin/CSRF、二次确认、独立宿主 Worker、提前撤销终止。在 Windows Node.js v24 + Sandboxie 上的实际效果仍待实测。
