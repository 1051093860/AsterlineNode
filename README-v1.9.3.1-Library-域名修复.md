# Asterline v1.9.3.1 — ChatGPT Library 下载地址白名单修复

## 原因
`library_bridge_import` 接到 ChatGPT 的临时下载 URL 后会严格检查 hostname。此前 `*.chatgpt.com` 等规则不涵盖 `chatgpt.com` 本身，另外有些临时 URL 的实际 hostname 可能与预置域名不同。

## 修改
- 官方 OpenAI/ChatGPT 域名默认增加主域名与子域名；兼容旧 `.env` 中的 `*.chatgpt.com` 规则：通配符现同时包含主域名。
- 被拒绝时只报告 `hostname`，**不会记录或输出完整 URL、query、签名**。
- 管理后台 `/settings` 新增 **Library 下载域名白名单**，可在界面保存即时生效，优先于旧 `.env`。只添加来自 ChatGPT `getFileDownloadUrl` 的确切 hostname，勿添加未知通用 CDN 通配符。
- Widget 显示实际下载 hostname 便于排查。
- 保留必须 HTTPS、无登录信息、无非标准端口、无自动跟随重定向、大小与时间限制。

## 升级
停止 Asterline 服务，备份目录和 `.state-node`，将补丁覆盖现有项目根目录，运行 `pnpm run check`、`pnpm test` 并重启。**不需要编辑 `.env`**。首次回到 ChatGPT，Refresh tools 后重新打开 Asterline Library Bridge，重新选择测试文件。

如果仍失败，错误会出现 `(hostname: example.net)`，请只提供该 hostname，不要提供带有签名的 download URL。确认来源后可在管理后台 `/settings` 的 Library 下载域名白名单中补充精确 hostname。

所有下载仍受独立的来源白名单保护；不得直接允许任意 HTTPS 下载。

## 测试范围
已在本地对旧 wildcard、官方 apex、恶意相似域名、敏感 query 的错误泄露、大小和重定向做回归；Windows + ChatGPT 实际临时 URL 的联调须在部署后重新执行。
