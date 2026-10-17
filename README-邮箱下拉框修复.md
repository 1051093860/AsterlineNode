# Asterline v1.7.3 · Cloudflare 邮箱/下拉框修复

修复截图中「宿主直通身份」下拉框空白、授权记录出现 `[email protected]` 的问题。

## 修改文件

- `src/admin.ts`：管理员响应添加 `Cache-Control: no-store, no-transform`；对显示中的邮箱使用 Cloudflare `email_off` 标记，保持 `<option value>` 不变；服务端 CSRF、Access JWT、Basic 与邮箱白名单仍照旧。
- `public/admin.css`：Windows/Chromium 原生下拉框选项增加明确的亮/暗色文字和底色。
- `public/sw.js`：更新静态资源缓存版本，防止安装版 PWA 继续读取旧 CSS。
- `tests/admin-email-ui.test.mjs`：两条管理页邮箱选项的回归断言。

## 安装

先备份 `src/admin.ts`、`public/admin.css`、`public/sw.js`，停止 Node 服务后解压覆盖项目根目录。不要覆盖 `.env` 或 `.state-node`。

```powershell
cd C:\Users\YourName\Desktop\AsterlineNode
pnpm run check
pnpm test
pnpm start
```

在 `https://mcpadmin.asterline.dev/sandboxes` 硬刷新（Ctrl+Shift+R），PWA 关闭后重新启动。

## Cloudflare 上更彻底的修复（推荐）

Cloudflare Dashboard → 选择 `asterline.dev` → Rules → Configuration Rules → Create rule。

表达式：

```
(http.host eq "mcpadmin.asterline.dev")
```

将 **Email Obfuscation = Off**。仅禁用该管理子域名的邮箱改写，不关闭 Access、WAF Challenge 或任何其他安全措施。可与源码补丁并用。

## 验证

在浏览器开发者工具 Network 里查看 `/sandboxes` 的原始响应：`Cache-Control` 应含 `no-transform`；下拉框文本应正常可见、没有 `__cf_email__` 元素及 `/cdn-cgi/l/email-protection` 链接。

终端可用：

```powershell
pnpm test
```

**不要因为选项变空而先点“启用宿主直通”测试**。确认邮箱显示正确再作高权限操作。
