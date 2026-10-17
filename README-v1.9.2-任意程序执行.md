# Asterline Node v1.9.2 — 任意程序执行

此补丁基于 v1.9.1 Runtime Settings，取消 `task_start` 的程序名和可信目录白名单。**不代表直接取消执行权限验证。**

## 运行方式

- `task_start` 接受 `program: "git.exe"`、`program: "node"`、`program: "C:\\Program Files\\...\\tool.exe"` 等，自动从 **Asterline 服务进程自己的 PATH** 或精确绝对路径解析。程序不会从 Agent 设置的工作目录隐式搜索，防止假冒可执行文件。
- `task_start` 仍需管理员在 `/operations` 启用宿主后台任务，并通过 `approval_request(operation=task_start)` 对**完全相同**的 `program/args/cwd/label` 发起一次性审批。管理员审批后用 `task_start(..., approval_id=...)` 调用。
- 审批现在绑定实际解析后的可执行文件完整路径、大小和最后修改时间。程序解析结果发生变化时，原审批不再有效。升级前尚未消费的旧后台任务审批可能需要重新申请。
- `terminal_exec` 不受程序白名单限制，在管理员明确批准的**宿主直通 1 小时**内执行任意 CLI、CMD 或 PowerShell 命令；单次 120 秒限制仍保留。
- **普通开发工作会话不包含宿主原生程序执行**。若要在开发工作模式连续运行任意程序且不授予宿主权限，还需要下一阶段实现独立的 Sandboxie 通用命令执行器。
- 不执行程序文本的 `eval`，普通后台进程使用 `spawn(..., shell:false)`，参数数组不会被拼接进 Shell。对于 `.bat`、`.cmd` 或 `.ps1` 等脚本，请显式选择相应解释器；Windows 上的 `.cmd/.bat` 不会由 `task_start` 暗中切换到 shell 模式。

## 升级方法

1. 备份 `C:\Users\YourName\Desktop\AsterlineNode`，特别是 `.env` 和 `.state-node`。停止当前 Node 服务。
2. 解压 **v1.9.2 增量升级包**，覆盖源码、管理后台模板和测试文件；不要覆盖旧 `.env` 或生产数据库。
3. 运行：

```powershell
cd C:\Users\YourName\Desktop\AsterlineNode
pnpm run check
pnpm test
pnpm start
```

无需再设置 `MCP_ALLOWED_PROGRAMS` 或 `MCP_EXEC_DIRS`。旧环境变量和旧 SQLite 设置会被忽略；后台 `/settings` 也不再显示这两个输入框。

## MCP 调用示例（需授权）

先调用 `approval_request`：

```json
{
  "operation": "task_start",
  "parameters_json": "{\"program\":\"git.exe\",\"args\":[\"status\"],\"cwd\":\".\",\"label\":\"查看状态\"}",
  "reason": "查看 Git 工作区状态"
}
```

管理员在 `/approvals` 批准后调用：

```json
{
  "program": "git.exe",
  "args": ["status"],
  "cwd": ".",
  "label": "查看状态",
  "approval_id": "<批准的 ID>"
}
```

路径型命令使用 `program: "C:\\Program Files\\Git\\cmd\\git.exe"`（JSON 中反斜杠需要转义）。`cwd` 依旧限定在已配置的工作区中。

## 边界与风险

- 执行权限属于运行 Asterline 的 Windows 用户；不是 SYSTEM，也不是自动获得管理员权限。
- 没有名称白名单后，管理员应仔细核对审批页的实际可执行文件路径，避免批准了非预期程序。
- 任务有并发数、日志大小、超时限制；后台宿主任务的副作用无法全部回滚。
- Windows 桌面 GUI 程序可能受运行账户与交互式会话限制，不保证弹出可见窗口。
- 不自动修改 Cloudflare Tunnel、管理员凭据、Sandboxie 隔离策略或已有工作权限。
- 真实 Windows PATH 解析、PowerShell/CMD、ChatGPT MCP 工具发现仍需实机验收。

## 已验证

在 Linux Node 22 的兼容测试环境运行全套 `node --experimental-strip-types --test tests/*.test.mjs`；类型检查需要具备项目的 Node 类型声明与 SDK 依赖。**这不等于 Windows 端到端测试已通过。**
