# Asterline v1.9 Permission Center（Node.js + TypeScript）

基于 Asterline v1.8 Library Bridge 的权限模型升级。**不是**现有 Python 服务或 Node v1.8 公网实例的自动更新。此版本保留 MCP 根路径 `/`、Cloudflare Access、Sandboxie、插件/npm 审批、Gotify、Windows 终端和 ChatGPT Library Bridge。

## 核心变化

- 新增 `work_request`：已验证的 Cloudflare 登录身份向管理员申请**固定 60 分钟**的开发授权。申请包含工作标题、工作区相对目录、能力列表和原因；申请默认 30 分钟内需审批。
- 新增 `work_status`：按申请者身份返回 `pending / active / denied / revoked / expired`，包括有效期。Agent 不用手动复制每次操作的 `approval_id`。
- 新增 `work_revoke`：申请者主动放弃开发授权。
- 新增管理页 `/access`：统一显示待审任务、活跃会话、剩余时间、风险边界和撤销入口。手机 PWA 底部入口改为权限中心。
- 作用范围只允许 `fs_write`（**指定工作区子目录内**）和 `sandbox_plugin`（**已发布 JS 插件，仍在 Sandboxie 中执行**）。
- 原先的 `approval_required` 全局配置不再能让 `fs_write` 或 `task_start` 绕过批准。保留旧设置行仅为数据兼容，不再参与实际授权决策。
- 旧的单次 `approval_id`、单插件时限授权，以及单独的**宿主直通一小时**仍保持；不会转换或自动继承为新的开发任务授权。

**重要：** 目前的 `task_start` 仍在宿主机运行，只能走管理员 `command_exec` 开关和单次精确审批；`terminal_exec` 仍然需要单独的宿主直通授权。**开发任务模式不会给予 Windows Shell、任意 npm 安装、全盘访问、插件发布或跳过沙箱的权限。** 在未来有专门的 Sandboxie 命令执行器并完成验收前，不会将“允许测试和构建”错误地映射到宿主进程。

## 安装

1. 备份整个 `C:\Users\YourName\Desktop\AsterlineNode`、`.env` 和 `.state-node`；停止 Node MCP 实例。
2. 从 **v1.8** 升级，请解压 `asterline-node-v1.9-permission-center-upgrade.zip` 覆盖原项目。也可以把完整项目包部署到单独的新目录，不要把压缩包中的文件误拷到正在运行的 Python `Cloud` 目录。
3. 保留 `.env` 和 `.state-node`，尤其保留既有 `ADMIN_PUBLIC_HOST=mcpadmin.asterline.dev`、Access AUD 和已验证的 Sandboxie 设置。
4. 执行：

```powershell
cd C:\Users\YourName\Desktop\AsterlineNode
pnpm install --ignore-scripts
pnpm run check
pnpm test
pnpm run test:permissions
pnpm start
```

5. 浏览器打开 `http://127.0.0.1:8865/access`（如果本机后台配置了此端口），或已配置好的 `https://mcpadmin.asterline.dev/access`。首次在手机 PWA 更新后完全关闭重开或刷新，让新版 Service Worker 生效。
6. 在 ChatGPT 中刷新 Asterline MCP 工具目录，检查新增 `work_request`、`work_status`、`work_revoke`。旧的 `fs_write`、插件、终端和通知工具仍可发现。

此版本创建独立 SQLite 表 `js_work_requests` 和 `js_work_sessions`，**不会**执行旧权限的批量迁移，也不会覆盖现有授权。请仍先备份，再部署升级。

## 使用示例

Agent 发起申请（工具参数）：

```json
{
  "title": "修复 Asterline UI",
  "workspace": "AsterlineNode",
  "capabilities": ["fs_write", "sandbox_plugin"],
  "reason": "检查并修复界面逻辑，运行已审核的沙箱测试插件",
  "agent_label": "ChatGPT"
}
```

`workspace` 是 `MCP_WORKSPACE_ROOT` 下的**现有相对目录**，不是绝对路径。如果 `MCP_WORKSPACE_ROOT` 已经指向项目自身，应使用 `"workspace": "."`。`agent_label` 只是未经验证的展示文字，不作为权限凭据。建议将 `MCP_WORKSPACE_ROOT` 指向精确的允许工作区，避免将整个用户目录作为工作区根路径。

管理员收到 Gotify 提醒 → 手机打开 `/access` → 查看请求的目录、权限和原因 → 批准一次。批准后，该身份可以使用 `fs_write` 修改授权目录内的文件，或调用已发布的 Sandboxie 插件，不需要为每个文件和调用再次申请票据。Agent 可以通过 `work_status({"request_id":"..."})` 判断是否可以继续。

授权会固定到 `批准时间 + 3600 秒`；服务重启不延长；重复批准会被拒绝；撤销不能在剩余有效期内重新批准续时。完成后管理员可以点“立即撤销”，Agent 也可以通过 `work_revoke` 自行撤销。已开始执行的任务可能不能被回滚，外部副作用不会因到期自动撤销。

### 兼容用法

- 单次 `approval_request` + `approval_id` 仍然支持；**如果显式传入无效票据，会立即拒绝，不会回退到开发会话**。
- 旧的 `/permissions` 单插件一小时授权及 `/sandboxes` 宿主直通继续可用，位于“高级设置”。
- 旧版 `file_write` 开关仍用于旧的**一次性**文件审批流程，但并非开发会话的第二个必需开关。
- 原生 ChatGPT Library 的交互授权和 rclone 云盘同步与本次权限改造无关，不会扩大到宿主终端操作。

## 边界与限制

1. Cloudflare Access 当前验证的是**邮箱身份**。多个 Agent 共用该邮箱时将共享开发授权，即使自报的 `agent_label` 不同。要真正区分 Agent，需要以后给每个客户端独立、可验证的身份，不可把自由填写的名称作为安全依据。
2. 这版任务模式授权的是**连续工具使用的权限窗口**，不是一条被拦截请求的后台自动重放。Agent 在授权后继续调用即可，无须携带逐次票据。不要理解为批准后会自动执行此前失败的命令。
3. `sandbox_plugin` 只有管理员在审批时确认了 Sandboxie 就绪才可授权；每次实际运行仍通过现有 Sandboxie 强制检查。沙箱不可用时故障关闭。
4. `fs_write` 按 Node 的 `workspacePath()` 拒绝绝对路径、`..` 越界以及符号链接/重解析点。新的授权只进一步缩小写入范围，不提供访问其他目录的能力。
5. 由于宿主原生 `task_start` 不在沙箱内，它仍需单次精确审批；宿主直通是独立的高风险授权。
6. 尚未实现跨多个不同已验证 OAuth 客户端的精确 Agent 身份隔离、已阻塞调用自动重放、运行中外部任务的强制回滚，以及 Windows 上的真实端到端测试。

## 验证记录

交付构建环境用 Node 22 的内建 TS 类型擦除器与 SQLite 运行本地测试：**44 项通过**（其中新权限专项 6 项）。检查了 PWA JS 语法和 ZIP。当前环境没有缓存 MCP SDK npm 包，无法运行完整 `pnpm run check`、真实 MCP SDK 握手、Windows Sandboxie 驱动测试或公网 ChatGPT OAuth 测试。以上需在你的 Windows 本机核验，结果在本地通过前不要切换生产入口。
