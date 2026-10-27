# 安全策略

## 报告安全问题

如果你发现**本项目自身**的安全问题（例如：扩展权限滥用、MCP 服务端可被远程利用、凭据/隐私泄露、发布资产被篡改），请**私下**报告：

- **GitHub Security Advisories（推荐）**：仓库 → `Security` → `Report a vulnerability`
- 或通过 GitHub Issue 先联系维护者（不要贴利用细节）

请**不要**在公开 Issue 中披露未修复的安全问题。

## 在范围内

- 扩展本体：`background.js` / `content.js` / `mcp-client-*.js` / `popup/`
- MCP 服务端：`mcp-server/`（含 HTTP / WS 端点、工具实现）
- 发布资产：GitHub Release 里的 zip

## 不在范围内

- **第三方依赖库**自身的漏洞 → 请向对应上游报告
- **使用本工具对其它系统测试得到的"发现"** → 那是使用场景，不是本项目漏洞
- 本项目**设计上就存在**的能力（扩展会 Hook 页面、MCP 会让 AI 操作浏览器、服务端在本机执行工具）——这些是功能不是漏洞；但**越权/逃逸出设计边界**的情况算漏洞

## 安全设计说明

- MCP 服务端默认**只监听 `127.0.0.1`**（不对外网开放）；HTTP 端口 `18080`、WS 桥 `9527`
- 扩展与 MCP 服务端**全部本地运行，不收集、不上报任何用户数据**
- 扩展权限遵循最小化原则（见 `manifest.json` 的 `permissions`）
- 扩展 ID 由 `manifest.key` 固定，`native messaging` 的 `allowed_origins` 只允许本扩展

## 维护者自查

版本发布前会执行（见 `RELEASE.md`）：隐私审计（真实域名/本机路径/凭据零残留）、21 套回归、CI 全绿。

## 联系方式

- GitHub：[@fush520](https://github.com/fush520)
- 邮箱：3079047615@qq.com
- 项目：<https://github.com/fush520/fush-vue-mcp>
