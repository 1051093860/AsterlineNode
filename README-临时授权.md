# Asterline Node v1.6.2 · 管理员 1 小时临时权限

适用：已经部署 v1.6.1 Sandbox Result Bridge 的 `AsterlineNode`。这是**增量覆盖补丁**，无需重新安装 npm 包，也不会修改 `.env`、现有 SQLite 记录或 Sandboxie 规则。

## 做了什么

- 管理面板新增 **临时权限** `/permissions`，本地 `http://127.0.0.1:8865/permissions`；配置 Cloudflare Access 后可从 `https://mcpadmin.asterline.dev/permissions` 进入。
- 授权**精确到插件 ID + Cloudflare Access 邮箱身份**，固定 **3600 秒**，不可以修改成永久、不可续期。重新点击不能延长已有授权；要提前结束用“立即撤销”。
- 只允许免除该插件在这 1 小时内的**逐次手机审批**；原本的一次性 `approval_id` 继续可用。传入无效 `approval_id` 时绝不会改用临时授权兜底。
- SQLite 表 `js_permission_leases` 自动创建。服务重启**不延长**有效期。服务器对每次调用动态核对当前时间（无须依赖后台定时器）。到期后自动按原逻辑拒绝调用。
- 插件停用时撤销所有关联租约；重新发布不复活原授权。授予、使用、撤销、随插件停用撤销均写入 `js_audit`。
- HTTP POST 继续要求管理员 Basic、Origin/Referer 和 CSRF 校验；公网管理端仍需 Cloudflare Access JWT。

## 很重要：权限边界

此功能**不能**直接修改 `SANDBOX_POLICY_CONFIRMED`，不能绕过 `sandboxReady()`，也不授予 npm 依赖安装、插件发布、主机命令、主机文件或 Windows 全盘访问权限。

**必须先通过完整 Sandboxie Worker + 结果回传测试**，再由管理员人工确认 Sandboxie 防护确实正确，方可考虑在生产 `.env` 配置 `SANDBOX_POLICY_CONFIRMED=1` 和 `SANDBOXIE_BOX_ROOT`。若沙箱仍处于关闭状态，管理页面可查看权限但不允许发放新临时授权。不要为了点亮按钮而盲目设为 1。

这版按邮箱绑定。共享同一 Cloudflare Access 邮箱的多个 Agent 会共享这一授权；尚不支持区分每一个 Agent 进程。

## 安装

1. 停止正在运行的 Node MCP 服务，备份 `src`、`public/admin.css`、`tests` 和 `.state-node` 数据目录。
2. 将补丁 ZIP 以“**保留目录结构**”的方式解压到 `C:\Users\YourName\Desktop\AsterlineNode`，只覆盖下列文件：
   - `src/admin.ts`
   - `src/store.ts`
   - `src/server.ts`
   - `public/admin.css`
   - `tests/hour-permissions.test.mjs`（新增）
3. 不要覆盖 v1.6.1 的 `src/runner.ts`、`src/sandbox-bridge.ts`、`src/config.ts`、`src/plugin-worker.mjs`，不要替换 `.env`。
4. 测试、启动：

```powershell
cd C:\Users\YourName\Desktop\AsterlineNode
pnpm run check
pnpm test
node --test tests/hour-permissions.test.mjs
npm start
```

如果你习惯 pnpm，也可以统一执行 `pnpm start`。本地管理入口端口以你的 `.env` 为准（预览版默认为 8865）。

## 使用

打开 `/permissions`，选择一个**已发布插件**和一个已允许的 Cloudflare Access 邮箱，点击“允许此工具调用 1 小时”。页面显示精确到期时间和剩余分钟，并提供“立即撤销”。

调用工具时，在有效期内不必传入 `approval_id`；其它调用参数不变。到期、手动撤销、插件停用或沙箱变成未就绪后都不能继续靠这个授权调用。

## 测试情况

已在当前构建环境使用 Node.js 22 的 TypeScript 擦除器及 Node SQLite 执行：现有五组离线测试 + 新增三组授权和管理员 HTTP 测试，**8/8 通过**；三个修改的 TS 文件通过原生语法检查。**尚未在用户的 Windows、Sandboxie、ChatGPT OAuth 上验收**。用户需在本机再执行 `pnpm run check`、`pnpm test`，确认无 TypeScript 类型错误。
