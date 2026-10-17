> **v1.9.2 更新**：宿主 `task_start` 支持任意已安装可执行程序（完整路径或 PATH 名称），不再需要程序白名单；仍需要宿主任务开关与精确人工批准。详见 [README-v1.9.2-任意程序执行.md](README-v1.9.2-任意程序执行.md)。

> **v1.9 更新**：新权限中心说明见 [README-v1.9-Permission-Center.md](README-v1.9-Permission-Center.md)。原 v1.8 文档中逐次审批的描述只针对旧接口；新开发会话优先使用 `work_request`。

# Asterline Node v1.6.1 — Sandboxie result bridge 修复（测试版）

这是 **v1.6.0-preview.1 的增量补丁**，解决 Sandboxie 虚拟化文件后，主进程读取不到 `result.json` 的问题。不会修改 Sandboxie ini、Cloudflare、生产数据库或 `.env`。覆盖文件：

- `src/config.ts` — 新增显式 `SANDBOXIE_BOX_ROOT`（生产配置，默认空）。
- `src/sandbox-bridge.ts` — 宿主仅从指定沙箱 FileRootPath 读取特定任务的 JSON。
- `src/runner.ts` — `/silent /wait` 后，从沙箱内部提取结果（校验任务 ID、随机 nonce、大小、文件类型、路径范围）。
- `src/plugin-worker.mjs` — 输出受限大小的带标识 JSON 信封。
- `scripts/qa/main.mjs` — QA 专用沙箱根与生产根分别配置。
- `scripts/qa/bridge-recover.mjs` — 安全的单任务端到端结果提取验证。

**重要：这不是已在真实 Windows 上验证成功的修复**。它基于 Sandboxie 官方默认文件布局，仍需在 AsterlineQATest 运行验证。切勿因此启用生产沙箱。

## 1. 安装补丁

备份上述源文件，解压本包到 `C:\Users\YourName\Desktop\AsterlineNode`，只覆盖上面列出的文件。不要覆盖 `.env`、`node_modules`、数据库或其他 QA 文件。确保当前没有未完成的任务；更新 TypeScript 源码后重启 Node 预览服务。

## 2. 找出 QA 沙箱的 FileRootPath（不是沙箱内虚拟路径）

在 Sandboxie Plus 选择 `AsterlineQATest` → **Explore Contents**，进入该沙箱的物理容器文件夹。应能找到 `user`、`drive`、`RegHive` 等内容。**复制这个文件夹本身的完整路径**，而不是 `drive\C`、`user\current` 或 `AsterlineNode` 项目路径。

从 Sandboxie 官方文档可知，默认 FileRootPath 可能是 `C:\Sandbox\<WindowsUser>\AsterlineQATest`，但实际路径受用户配置影响。不要照抄示例；务必从 UI 核实。

> 注意：如果容器内容根目录刚好没有文件，Sandboxie 文件布局仍可检查。`SeparateUserFolders=n` 时会映射到 `drive\C\Users\...`；补丁会检查这两种常见路径。非默认卷序列号映射暂不支持，会**拒绝执行**，不会自动开放宿主文件权限。

## 3. 在 QA 专用终端执行

```powershell
cd C:\Users\YourName\Desktop\AsterlineNode
$env:QA_POLICY_CONFIRMED = '1'
$env:QA_SANDBOX_ROOT = 'C:\这里填写实际的 AsterlineQATest 文件容器根目录'

node scripts/qa/bridge-recover.mjs
.\QA-Run.ps1 -Mode sandbox -Sandbox

Remove-Item Env:\QA_SANDBOX_ROOT,Env:\QA_POLICY_CONFIRMED -ErrorAction SilentlyContinue
```

首个脚本只运行合成 JS，不发送网络请求，不改数据库、不修改生产权限。正确结果应显示 `[PASS] QA-only sandbox virtual result recovered and verified`。第二条运行完整的文件/网络隔离和插件 Worker 测试；预期显示 `real Sandboxie + Node permission` 通过。

如果失败，复制脚本末尾的候选物理路径，以及 Sandboxie 沙箱内容目录的真实位置。不要尝试将 `Desktop`、用户目录、项目目录加入 Direct/Full Access。

## 4. 后续正式启用（现在先不要执行）

生产环境应新建独立 `AsterlinePlugins` 沙箱，验证其文件、网络和宿主写入隔离，再配置：

```ini
SANDBOXIE_BOX=AsterlinePlugins
SANDBOXIE_BOX_ROOT=这里填写经核实的 AsterlinePlugins 文件容器根目录
SANDBOX_POLICY_CONFIRMED=0
```

只有新旧功能、隔离规则、结果桥、沙箱进程清理全部验收通过，才考虑改为 `SANDBOX_POLICY_CONFIRMED=1`。

## 5. 安全边界与剩余工作

- `SANDBOXIE_BOX_ROOT` 是 **只读提取路径**，不是授权沙箱访问宿主文件的例外。
- 主进程只读取 16KB 以内、固定任务 ID/nonce 的 `result.json`；检查文件类型和路径，取回后删除单个结果文件。
- 仍未实现 Job Objects 限制、完整进程树退出确认、可执行代码的强化恶意输入测试。因此即便这次 QA 通过，也不代表已具备运行任意恶意插件的完整安全保障。
- 测试输出 `exit=0` 只代表启动器的成功退出；必须同时验证 JSON 才算通过。
- 真实用户环境可能使用不同的 Sandboxie 文件布局；若候选位置都不存在，请据实修复路径映射，不要放宽安全策略。


## v1.9.4 Agent 自主 Library 拉取

参阅 [README-v1.9.4-Agent-拉取到Library.md](README-v1.9.4-Agent-拉取到Library.md)。
