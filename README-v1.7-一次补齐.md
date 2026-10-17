# Asterline Node v1.7 — Python 功能覆盖升级

此包基于已合并的 Node v1.6.4、v1.6.3 宿主直通、v1.6.2 小时授权及 v1.6.1 沙箱结果桥，**不是独立重新开始的项目**。保留原有插件表 `js_plugins`、审批表、现有一小时宿主授权和 Sandboxie 逻辑。

## 1. 新增工具 / 运维入口

| 组件 | 内容 / 边界 |
|---|---|
| `system_info` | 需要 Cloudflare Access JWT，读取工作区与磁盘信息 |
| `fs_list` | 200 项，工作区内，拒绝目录跳出和符号链接 |
| `fs_read` | 工作区内 UTF-8，至多 128 KiB |
| `fs_write` | 管理员 `file_write` 开关 + 可配置的单次精确审批；原子替换 |
| `task_start` | 管理员 `command_exec` 开关 + 可配置的单次精确审批；执行程序必须在显式可信目录和名称白名单内 |
| `task_status` | 兼容原插件运行记录，并读取后台任务 |
| `task_logs` | 64 KiB 单次分页（默认 8 KiB），仅属主 |
| `task_cancel` | 仅属主请求终止自己任务；管理员可在 `/jobs` 终止 |
| `notify_send` | Gotify 持久队列、6 次重试、5 分钟最多 10 次；管理员开关 |
| 其他 | `hello`、JS 插件、安装前审核、插件热发布、一次性审批、沙箱、指定插件一小时授权、宿主直通一小时、`terminal_exec` 保留 |

面板：`/operations` 功能开关，`/jobs` 后台任务，`/notifications` Gotify 发送队列，`/status.json` 运维状态（仅管理员）。原 `/plugins /dependencies /approvals /permissions /sandboxes /audit` 保留。

### 风险边界

- `task_start` 是**受管理员授权的 Windows 本机进程执行**，不是 Sandboxie；`command_exec` 默认关闭，且单次批准默认开启。**不要将 `MCP_EXEC_DIRS` 指向可由 Agent 写入的工作区。**
- `terminal_exec` 保留 v1.6.4 的一小时宿主直通门槛；不会因 `command_exec` 开关而自动打开。
- `file_write` 不因宿主直通权限存在就自动启用；必须另外打开写入开关。
- 关闭一小时授权不会撤销已经写入的文件，无法保证消除所有持久化副作用。
- 路径防护通过 `lstat`/`realpath` 检查，有共享文件系统竞争窗口；避免把高信任目录开放给敌对本地进程。
- 旧 Python **可信 Python 插件**不会被 `import` 到 Node 主服务；此包保留原始定义用于人工移植，不自动执行。

## 2. 在 Windows 安装

1. **先停止新 Node 服务**，备份整个 `AsterlineNode` 和 `.state-node`。Python 服务和 `.state` 保持不变。
2. 将完整 ZIP 解压到独立目录进行测试；若增量安装，使用补丁 ZIP 覆盖同名文件，保留旧 `.env`、数据库和 `releases/`。
3. 将以下设置补入 `.env`（路径须按自己的电脑实际安装情况更改）：

```ini
MCP_WORKSPACE_ROOT=C:\Users\YourName\Desktop\Cloud\workspace
MCP_ALLOWED_PROGRAMS=git.exe,node.exe,adb.exe
MCP_EXEC_DIRS=C:\Program Files\Git\cmd;C:\Program Files\nodejs;C:\Users\YourName\AppData\Local\Android\Sdk\platform-tools
```

`MCP_EXEC_DIRS` **不能只是 PATH**；允许列表里的程序必须确实存在于其中某个目录。Shell 脚本请不要加入该名称列表；若需要 PowerShell，请使用仅在已授权宿主直通期间可调用的 `terminal_exec`。

4. 使用 Node.js 24.18.1 和安装依赖（根据本地实际选择 npm 或 pnpm）：

```powershell
cd C:\Users\YourName\Desktop\AsterlineNode
pnpm install --ignore-scripts
pnpm run check
pnpm test
pnpm start
```

5. 另开终端执行：

```powershell
node scripts/verify-compat.mjs
npm run smoke
```

工具列表至少应有表中 15 个原有 MCP 工具；不登录 Cloudflare 的本地冒烟测试只允许 `hello` 等只读/发现操作，拒绝任何写入或执行。

6. 管理员地址仍为 `http://127.0.0.1:8865/`，公网目标仍为 `https://mcpadmin.asterline.dev/`。检查 `/operations`、`/jobs`、`/notifications`、`/permissions`、`/sandboxes`。

## 3. Python 数据迁移（安全归档）

使用 Node 环境，在**停止 Node 服务并备份**后执行。Python 旧数据库始终以只读方式打开；迁移工具默认只生成清单：

```powershell
node scripts/migrate-python.mjs --source "C:\Users\YourName\Desktop\Cloud\.state\asterline.sqlite3" --dest "C:\Users\YourName\Desktop\AsterlineNode\.state-node\asterline.sqlite3"
```

确认备份、停机和数量后，显式添加 `--apply` 真正写入。迁移会再次备份目标 Node SQLite（`.backup-时间戳`）；历史 `jobs`、`tool_plugins`、`approvals`、`notifications`、`audit`、`settings` 被归档到 `js_legacy_*`，不会重激活 Python 插件、通知任务、旧审批或高危设置。多次导入不会重复记录。由于旧 Python 插件行为与 JS 插件契约不同，需人工迁移代码 / 工具声明后另行审批发布。

安全注意：历史授权参数可能包含个人数据，备份/归档数据库请勿公开分享。

## 4. 测试范围与尚需实机确认

在本次构建环境里：离线/核心测试 **24/24** 通过；包括真实 Node 子进程、日志、终止、迁移 dry-run/apply 幂等、文件逃逸和审批。

**尚未通过构建环境验证**：npm 下载后完整 `tsc --noEmit`、真实 SDK MCP 运行、Windows 进程树杀死、Sandboxie + Node Worker 实机、Gotify Android 推送、Cloudflare Access / ChatGPT 公网 OAuth。由于 Registry 网络无法访问，不能把这些标记为通过。

先在独立端口 `8100 / 8865 / 8866` 核对，通过以后再考虑 Cloudflare Tunnel 的正式切换。原 Python 实例继续运行在原端口。
