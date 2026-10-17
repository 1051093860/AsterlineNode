# Asterline v1.8 — ChatGPT Library 双模式文件桥

基于 v1.7.3 Sandboxie QA 加固版与管理员邮箱修复。**没有使用 ChatGPT Cookie、反向工程私有接口、OpenAI API Files 代替 Library。**

## 先理解两个互不混淆的通道

1. **原生 ChatGPT Library**：Windows CLI 暂存待上传文件 → ChatGPT 中运行 `library_bridge` 插件 UI → 用户点击确认后 `window.openai.uploadFile(file, {library:true})`。反向则在 ChatGPT 组件中使用 `window.openai.selectFiles()` 和 `getFileDownloadUrl()`，经受限 MCP 文件导入到本地收件箱，最后通过 CLI `pull`。**每次需要人在 ChatGPT UI 中确认或选择，绝非纯 CLI 无人值守。**
2. **云盘无人值守**：CLI 调用 [rclone](https://rclone.org/) 已授权的 Google Drive 远端，支持增量 `copy`、`ls`、单文件上传下载。Google Drive 文件保持存储在 Drive；在 ChatGPT 连接 Google Drive 且有相应权限时，它们可以显示在 Library 的“连接文件”中，**不属于原生 ChatGPT Library 存储**。

ChatGPT UI 扩展接口来源： https://developers.openai.com/plugins/reference 。当 UI 不提供这些可选接口时会给出不可用提示。

## 安装

- 在 Windows 备份 `C:\Users\YourName\Desktop\AsterlineNode`、`.state-node` 和 `.env`。停止 Node 服务，将 **v1.8 增量补丁**解压覆盖至该项目。补丁不会包含或覆盖本地 `.env`、数据库。
- 编辑 `.env`：保留原来的 `CF_*` 和管理密码；添加下面设置。Cloudflare Tunnel 仍按原方式转发 `mcp.asterline.dev` 至 MCP 服务端口。`mcpadmin.asterline.dev` 不变。
- 新开 PowerShell 执行：

```powershell
cd C:\Users\YourName\Desktop\AsterlineNode
pnpm run check
pnpm run test:library
node scripts/library-doctor.mjs
pnpm start
```

在 ChatGPT 的 Asterline 插件刷新工具列表，调用 `library_bridge`，检查是否出现文件操作组件。此版本需要由 ChatGPT 主机支持可选的 Library 文件扩展接口；在开发机无法测试其真实行为。

建议配置：

```ini
# CLI 默认属主：有多个邮箱时必须显式 --owner
LIBRARY_OWNER_EMAIL=you@example.com
# 可从官方文件链接实际域名调整到更严格的精确 hostname
LIBRARY_FILE_HOSTS=*.oaiusercontent.com,*.openai.com,*.chatgpt.com
LIBRARY_RCLONE_EXE=rclone
LIBRARY_RCLONE_REMOTE=gdrive:Asterline
LIBRARY_CLOUD_LOCAL_ROOT=C:\Users\YourName\Desktop\AsterlineLibrarySync
```

**不要在配置文件、日志或 ChatGPT 聊天中粘贴 rclone OAuth refresh token、Cloudflare JWT、ChatGPT Cookie。** `rclone config` 存储凭据于 rclone 自己的配置文件，由 Windows 用户权限保护。

## 模式 A：原生 ChatGPT Library（需交互）

在电脑 CLI 排队：

```powershell
node scripts/library-cli.mjs library push "C:\Users\YourName\Desktop\project.zip"
node scripts/library-cli.mjs library jobs
```

然后在 ChatGPT 里打开 Asterline 的 `library_bridge` 工具卡片，找到待上传文件并点击 **确认上传**。状态变为 `client_reported_uploaded` 表示 UI 反馈了 ChatGPT fileId，不代表本地服务器能独立验证云端文件完整性。

下载：ChatGPT 卡片 → **从 Library 选择** → 选择文件 → 服务端导入 → 将回显的 transfer ID 在电脑执行：

```powershell
mkdir .\downloads -ErrorAction SilentlyContinue
node scripts/library-cli.mjs library jobs
node scripts/library-cli.mjs library pull 12345678-1234-1234-1234-1234567890ab -o .\downloads
```

这里 UUID 只是**格式例子**，替换为真实 transfer ID。文件同名时拒绝覆盖，文件下载后检查 SHA-256。

**用户直接从浏览器本机选择文件的上传**使用真正的 `<input type=file>`，是 ChatGPT UI 扩展支持的标准路径。**从远程 Asterline CLI 预先暂存的文件**会由 Widget 通过经过认证的 MCP 分块读取后构造 `File`，这种合成 `File` 的上传是否被 ChatGPT 主机接受，需在你的 ChatGPT 客户端上实测；若主机要求实际文件选择，则手动使用 Widget 里的文件输入上传，CLI 暂存不能自动完成原生 Library 上传。

默认限制：本机待上传文件 **16 MiB**，从 ChatGPT URL 导入文件 **32 MiB**，MCP 每块 **96 KiB**。超出大小的文件请优先使用云盘模式。不提供对整个 ChatGPT Library 的无交互遍历、枚举或批量自动同步。

如果导入失败并提示下载域名不允许，**先核实来源确为 ChatGPT 返回的 URL**，再将这个 URL 的**精确 hostname** 写进 `LIBRARY_FILE_HOSTS`，不要放行整个外部 CDN 或关闭校验；不必分享含签名的完整 URL。

文件系统存储：`.state-node/library-bridge/{out,in,index.json}`。避免把 `.state-node` 放入共享目录；不要给沙箱插件访问这一路径。Windows 下 Node 的 POSIX `0600` 只是一层提示，建议用 NTFS ACL 仅授予运行 Asterline 的 Windows 账户访问。

## 模式 B：rclone Google Drive（无人值守 CLI）

安装 rclone：https://rclone.org/downloads/ 。首次执行 `rclone config` 配置名称为 `gdrive` 的远端。可以在不启动 ChatGPT 的 Windows 命令行执行：

```powershell
node scripts/library-cli.mjs cloud ls
node scripts/library-cli.mjs cloud push ".\project.zip" --to "Builds/project.zip"
node scripts/library-cli.mjs cloud pull "Builds/project.zip" -o ".\downloads"
node scripts/library-cli.mjs cloud sync --direction up --dry-run
node scripts/library-cli.mjs cloud sync --direction up
node scripts/library-cli.mjs cloud sync --direction down
```

`sync` 实现使用 `rclone copy`，**不删除**源端或目标端的额外文件，但同步时可能覆盖目标端同名文件。方向 `up/down` 必须显式指定，文件范围被固定在 `LIBRARY_CLOUD_LOCAL_ROOT` 与 `LIBRARY_RCLONE_REMOTE`（例如 `gdrive:Asterline`）。默认限制传输并发，不使用 shell 拼接命令；排除 `.env` 与 `.state-node`，并非任意云备份工具。

要定时无人值守，在 Windows “任务计划程序”创建任务：程序为 `C:\Program Files\nodejs\node.exe`，参数为 `scripts/library-cli.mjs cloud sync --direction up`，起始目录为 `C:\Users\YourName\Desktop\AsterlineNode`，以**配置了 rclone 的同一个低权限 Windows 账户**运行。先手动验证 OAuth token 可自动续期和 `cloud sync --dry-run`。

## 风险和能力边界

- Library UI 不是服务器侧的通用 Library API；CLI 不能自行突破 ChatGPT 文件授权边界。
- Library 文件下载使用临时授权 URL，必须经过可信 hostname 白名单、HTTPS、无重定向、大小限制；不要打开任意域名下载功能。
- 任意应用层 URL 约束不等于内核级网络沙箱，请在受管网络条件下部署。
- 入站文件不是可执行代码。**不要自动解压后执行或接入已发布插件**；插件仍走原来的人工审核。
- 该补丁**不启用 Sandboxie 或宿主直通**，不改变 `SANDBOX_POLICY_CONFIRMED=0`。
- MCP 工具层已集成，ChatGPT 原生 UI 扩展在此环境不能做端到端验收；真正 rclone OAuth/Drive 上传也必须在 Windows 上验收。

## 测试和故障排查

```powershell
node --test tests/library-bridge.test.mjs
pnpm run check
pnpm test
node scripts/library-doctor.mjs
```

若 ChatGPT 不出现 `library_bridge`，刷新插件的 MCP 工具列表（ChatGPT 可能缓存）。若出现工具但没有交互卡片，先核实已注册的 `ui://asterline/library-bridge.html` MCP resource、`text/html;profile=mcp-app` 类型和 ChatGPT 插件 UI 功能开关。`/library` 是管理员状态页，不是 ChatGPT Widget，不能在该页面直接调用 `window.openai`。
