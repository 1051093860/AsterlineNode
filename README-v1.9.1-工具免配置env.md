# Asterline v1.9.1 · 工具设置无需编辑 .env

这版将日常工具配置从 `.env` 迁入 `.state-node/asterline.sqlite3` 的 `js_runtime_settings` 表，并增加受保护的 `/settings` 页面。

## 升级

1. 备份 `.env` 与 `.state-node`；停止 Asterline Node。
2. 解压覆盖 `src/`、`public/`、`scripts/`，保留 `.env` 和数据库。
3. 运行 `pnpm run check`、`pnpm test`，再启动 `pnpm start`。
4. 登录 `https://mcpadmin.asterline.dev/settings`（或本地 `/settings`）。
5. 在后台保存工作区、可信程序、Sandboxie 安装路径、Gotify 本地地址和 rclone 云盘参数。保存后立即使用，不需要重启。

旧 `.env` 中已有的同类值会继续作为**未保存过的配置项的初始值**。管理员首次保存后以 SQLite 为准，重启不会反向覆盖。

## 哪些不必再写到 .env？

- `MCP_WORKSPACE_ROOT` → 工作区目录
- v1.9.2 起 `MCP_ALLOWED_PROGRAMS` / `MCP_EXEC_DIRS` 不再需要，旧值忽略；执行宿主程序仍需审批
- `SANDBOXIE_START` / `SANDBOXIE_BOX` / `SANDBOXIE_BOX_ROOT` → 沙箱程序与物理目录
- `GOTIFY_LOCAL_URL` → Gotify 本地连接
- `MAX_PLUGIN_SECONDS` → 插件最大运行时长
- `LIBRARY_RCLONE_REMOTE` / `LIBRARY_CLOUD_LOCAL_ROOT` / `LIBRARY_RCLONE_EXE` → 云盘设置

CLI 如 `pnpm library cloud ls` 和 `pnpm library cloud sync --direction up` 会读取同一份 SQLite 数据。要授权 Google Drive 等云盘仍需要首次执行 `rclone config`，此过程由 rclone 管理，不是 Asterline `.env`。

## 仍属于启动安全配置

`ADMIN_PASSWORD`、`CF_TEAM_DOMAIN`、`CF_ACCESS_AUD`、`CF_ADMIN_AUD`、`MCP_ALLOWED_EMAILS`、端口和 `MCP_DATA_DIR` 保留在启动配置里，避免登录身份、认证密钥、数据库位置被在线页面随意修改。Gotify token 也仍作为机密配置单独保存，不会明文写进 SQLite。

安全机制：改变工作区时立即撤销已有开发授权、未消费的一次性票据和未审批申请；修改可信可执行目录会撤销旧后台任务票据；变更 Sandboxie 路径会取消沙箱安全确认。重新通过 Windows QA 验收后，可在后台手动输入确认语句重新启用，不需修改 `.env`。该声明不能代替真实的隔离检测。不能仅通过后台改配置绕过 Sandboxie 隔离或批准身份。

新注册工具只要求刷新不支持变更通知的 MCP 客户端的工具列表，**不需要编辑 `.env`**。

## 检查

```powershell
cd C:\Users\YourName\Desktop\AsterlineNode
pnpm run check
pnpm test
pnpm start
# 浏览器登录 https://mcpadmin.asterline.dev/settings
# 修改 rcloneRemote，再执行 pnpm library cloud ls
```

注意：Sandboxie 的安全确认可在受保护的后台进行，但必须先实际通过 OS-only 文件、网络和残留进程 QA；它只替代以往的手动编辑 `SANDBOX_POLICY_CONFIRMED`。原生 ChatGPT Library 授权仍需在 ChatGPT 内确认。
