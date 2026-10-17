# Asterline v1.9.4 — Agent 自主拉取文件到 ChatGPT Library

## 问题

原本只能 `library push` 由 Windows CLI 先排队，然后用户在 ChatGPT App UI 中手工完成上传。新版本增加 `library_stage`，Agent 直接按工作区相对路径请求暂存指定文件（包括非 UTF-8 二进制），然后用 `library_bridge_chunk` 获取文件内容。

**重要：** Asterline MCP 服务器自身没有 ChatGPT 原生 Library 的后台上传凭据；它不能绕过 ChatGPT 的文件管理权限。要实现 *无需手动点击组件* 的完整上传，ChatGPT 当前会话必须具备原生 Library 写入能力（例如 files.manage_library），由助手使用该工具保存完整校验后的文件。在不支持此能力的客户端仍需原来的 Library Bridge 组件。

## 使用

1. 后台 `/settings` 检查 **工作区根目录**（不是整台电脑的无限制文件系统）。无需更改 `.env`。
2. 覆盖增量补丁后重启 Asterline Node 服务；在 ChatGPT `Refresh tools`。
3. 告诉 ChatGPT：`查看 Asterline 工作区 docs，挑出需要的 PDF 并拉取到 ChatGPT Library 的 /Asterline/ 文档夹`。
4. Agent 调用 `fs_list` 检查文件，随后对所选文件调用 `library_stage({path:"docs/filename.pdf"})`。
5. Agent 用 `library_bridge_chunk({transfer_id,offset})` 按 `98304` 字节递增读取（允许 0 字节文件）；拼接二进制文件、验证 `size` 和 `sha256`。
6. 在有原生 Library 写入工具的 ChatGPT 会话中，Agent 将校验文件提交到 Library；**仅在 Library 上传操作明确成功后**，才调用 `library_bridge_mark` 记录上传后的文件 ID。列表的 `client_reported_uploaded` 是回报状态，不能替代 ChatGPT Library 的文件记录。

## 安全与边界

- `library_stage` 只能选择经 Cloudflare Access 验证的身份在 Asterline **配置工作区**内可读的普通文件。拒绝绝对路径、`..`、符号链接/重解析点、工作区外文件。
- 默认拒绝 `.env`、`.state-node`、`.git`、`.ssh`、`credentials`、`secrets`、`*.key`、`*.pem` 等明显敏感路径；**并不保证所有可能包含敏感信息的普通文件都能识别**，仍应按用户任务意图选择。
- 每个文件最多 16 MiB；每个 MCP chunk 96 KiB。大文件传输在聊天中分块开销很大，实际推荐云盘 rclone/既有 UI 路径。
- 本机只做工作区到 Asterline spool 的暂存；上传 ChatGPT Library 是 ChatGPT 原生文件工具的操作，不通过可疑登录 Cookie 或隐藏接口。
- 传输作用域按已验证 Cloudflare 邮箱隔离，并在 Asterline 审计日志中记录 stage ID、文件名、大小；**不能由 Agent 自己声明其他邮箱**。
- 不会自动把所有文件上报 Library，也不会递归同步整个磁盘。

## Windows 升级

备份 `.state-node` 和项目目录，停止服务；将增量包解压覆盖到 `C:\Users\YourName\Desktop\AsterlineNode`。**不要覆盖 `.env` 或 `.state-node`**。

```powershell
cd C:\Users\YourName\Desktop\AsterlineNode
pnpm run check
pnpm test
pnpm start
```

重启后 Refresh tools，确认出现 `library_stage`。原有 `library_bridge`、`library_bridge_import`、`library_bridge_list`、`library_bridge_mark`、`library_bridge_chunk` 工具保持兼容。

## 验收状况

本地 `npm test` 64/64 通过，`node --experimental-strip-types --check src/server.ts` 语法检查通过。未在用户 Windows 上部署本版，也未验证新版 MCP 文件分块导出到 Library 的真实端到端运行；无需先改 Cloudflare Tunnel 或 `.env`。
