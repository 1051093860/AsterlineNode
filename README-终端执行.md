# Asterline MCP v1.6.4 — 终端执行增量补丁

这是 **v1.6.3 宿主直通一小时** 的增量补丁，不包含或替换之前的 Sandboxie 结果桥、npm 审核等代码。补丁新增 MCP 工具 `terminal_exec`，能通过 Cloudflare Access 验证身份后，在管理员明确开启的**宿主直通一小时**有效期内运行 PowerShell、CMD 或直接程序。

**极高风险：** 此工具不经过 Sandboxie、不启用 Node 权限模型、不受普通工作空间限制。它以运行 Asterline 服务器的 Windows 账户执行命令（不是自动获得 SYSTEM/管理员）。单次超时和一小时租约无法撤销已经发生的文件更改、网络泄漏或持久化行为。只给你信任的 Agent 身份开启。切勿用 Windows 管理员身份运行 Node 服务。

## 安装

1. 停止 Node MCP 进程；备份现有项目和 `.state-node`（尤其是 SQLite 数据库）。
2. 将补丁内容按目录覆盖到 `C:\Users\YourName\Desktop\AsterlineNode`。只修改 `src/server.ts`、`src/admin.ts`，新增 `src/terminal.ts`、`tests/terminal-hour.test.mjs`、`scripts/check-terminal.mjs`。**不覆盖 `.env`、`src/store.ts`、`src/runner.ts`、`src/host-direct.ts`、数据库及 Sandboxie 配置。**
3. 执行：

```powershell
cd C:\Users\YourName\Desktop\AsterlineNode
pnpm run check
pnpm test
npm start
```

新开终端执行：

```powershell
node scripts/check-terminal.mjs
```

脚本只检查 `terminal_exec` 出现在 `tools/list`，以及匿名本地请求被拒绝，**不会执行系统命令**。成功后，再在受 Cloudflare Access 保护的管理面板开通你的登录邮箱的宿主直通授权：`https://mcpadmin.asterline.dev/sandboxes`（前提是该公网域名已配置完毕），或使用本机 `http://127.0.0.1:8865/sandboxes`。选择邮箱、输入既有风险确认短语并勾选复核。不要将 Cloudflare JWT、管理员密码或终端工具授权给不可信 Agent。

## MCP 工具参数

`terminal_exec`：

```json
{
  "shell": "powershell",
  "command": "Get-Location; node --version",
  "timeout_seconds": 30
}
```

使用 CMD：

```json
{"shell":"cmd","command":"ver","timeout_seconds":20}
```

无需 Shell 的直接程序执行（防止命令被 Shell 重新解释）：

```json
{"shell":"exec","command":"node.exe","args":["--version"],"cwd":"C:\\Users\\YourName\\Desktop\\AsterlineNode"}
```

返回结构包含 `task_id`、`execution=host_direct_terminal`、`exit_code`、`stdout`、`stderr`、`truncated`、`cwd`。成功和非零退出均记录到原 `js_runs` 表；通过现有 `task_status(task_id)` 按身份查询。每路输出最多保留 24KiB，单次命令超时 1–120 秒，默认 30 秒；也受一小时权限的剩余时间约束。此功能是**一次性短命令**，不是交互式 PTY，不支持需要手工输入的终端会话。

管理员在 `/sandboxes` 提前撤销该邮箱宿主直通后，服务会尝试使用 Windows `taskkill /PID ... /T /F` 结束正在运行的终端进程树。未授权、授权到期或使用其他邮箱身份的 Agent 会被拒绝。Agent 无法通过 MCP 发放或续期该权限。

命令内容不会写入 `js_audit`（可能含口令），仅记录命令 SHA256 摘要、任务 ID、Shell、退出码等；结果会写入任务状态记录，**因此也不要在命令输出中打印机密**。实际命令及参数仍可能出现在 Windows 进程命令行或系统审计中。

## 验证范围

- 当前构建环境使用 Node.js 22 的类型擦除模式运行了新增与旧有的 **18/18** 单元/集成测试（包括过期、提前撤销和权限拒绝）。
- 新增 TypeScript 文件已通过 Node 语法检查。
- 当前环境没有安装官方 MCP SDK 的依赖，未能执行整个项目的 `pnpm run check`，也无法验证 Windows PowerShell/CMD、Cloudflare 身份接入或真实 Windows 子进程树终止。这些需要你在 Node.js 24 Windows 实例上完成。
- 已在运行的 Python 旧版 MCP 不会自动获得此工具；正式通过 Cloudflare 转到新版 Node 服务后，ChatGPT 可能还需要重新发现工具目录。

## 注意

如果你只是想让 Agent 在 Windows 上运行命令，不需要再发布一个绕过审批的 JS 插件；`terminal_exec` 是内置工具。但若不想开启完整的一小时宿主直通，当前补丁**不会**允许它运行。后续可以增加每条终端命令的精确参数单次审批模式。
