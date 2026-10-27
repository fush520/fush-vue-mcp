<h1 align="center">
  <img src="../icons/icon128.png" width="48" height="48" alt="logo" style="vertical-align: middle;">
  Fush
</h1>

<p align="center">
  <strong>🛡️ 前端 JavaScript 逆向 & 渗透测试辅助工具</strong>
</p>

<p align="center">
  <a href="#-功能特性">功能特性</a> •
  <a href="#-安装方法">安装方法</a> •
  <a href="#-使用说明">使用说明</a> •
  <a href="#-mcp-提示词与案例">MCP 提示词</a> •
  <a href="#-致谢">致谢</a>
</p>

<p align="center">
    <img src="https://img.shields.io/badge/Chrome-Extension-green?logo=googlechrome" alt="Chrome Extension">
  <img src="https://img.shields.io/badge/Version-4.9.44-blue" alt="Version">
  <a href="../LICENSE.md"><img src="https://img.shields.io/badge/License-See_LICENSE.md-lightgrey" alt="License"></a>
</p>

---

## 📖 简介

Fush Vue MCP 是一款专为前端 JavaScript 逆向工程和渗透测试设计的 Chrome 浏览器扩展。

> 🔧 **关于 MCP 设计**：工具面的接口形态参考了若干浏览器 MCP 项目的通用能力（如 chrome-devtools MCP 的常用工具形态），**实现独立**；`scripts/` 下的 Hook 脚本参考了若干开源实现，各脚本头部保留原作者 `@author` 署名。

基于 [Hook_JS](https://github.com/AntSwordProject/Hook_JS) 库开发，提供强大的反调试绕过、API Hook、Vue 路由获取等功能。

---

## ✨ 功能特性

### 🔓 AntiDebug - 反调试绕过

绕过各种前端反调试机制，让逆向分析更加顺畅。

| 脚本名称 | 功能描述 |
|---------|---------|
| **Bypass Debugger** | 绕过无限 Debugger，覆盖 eval、Function、Function.prototype.constructor |
| **hook log** | 防止 JS 重写 console.log 等方法 |
| **Hook table** | 绕过 JS 检测运行时间差的反调试 |
| **hook clear** | 禁止 JS 清除控制台数据 |
| **hook close** | 避免网站反调试关闭当前页面 |
| **hook history** | 避免网站反调试返回历史页面 |
| **Fixed window size** | 固定浏览器窗口大小，绕过控制台检测 |
| **Hook CryptoJS** | Hook CryptoJS 所有对称/哈希/HMAC 算法 |
| **Hook JSEncrypt RSA** | Hook JSEncrypt 库的 RSA 加解密 |
| **页面跳转定位** | 定位页面跳转的 JS 代码位置 |

### 🪝 Hook - API 拦截

拦截并监控各种浏览器 API 调用，快速定位关键代码。

| 脚本名称 | 功能描述 |
|---------|---------|
| **document.cookie** | 监控 Cookie 设置操作 |
| **XMLHttpRequest.setRequestHeader** | 监控请求头设置 |
| **XMLHttpRequest.open** | 监控 XHR 请求初始化 |
| **localStorage.setItem/getItem/removeItem/clear** | 监控 localStorage 操作 |
| **sessionStorage.setItem/getItem/removeItem/clear** | 监控 sessionStorage 操作 |
| **fetch** | 监控 fetch 请求 |
| **JSON.parse / JSON.stringify** | 监控 JSON 解析和序列化 |
| **Promise** | 监控 Promise resolve，定位异步回调 |
| **Math.random** | 固定随机数返回值 |
| **Date.now** | 固定时间戳返回值 |

**Hook 板块特性：**
- 🔍 **关键字过滤**：只捕获包含指定关键字的内容
- 🐛 **Debugger 断点**：捕获时自动触发断点
- 📚 **堆栈追踪**：打印完整调用堆栈

### 🌐 Vue - 路由分析

针对 Vue.js 框架的专属功能，快速获取和分析路由信息。

| 脚本名称 | 功能描述 |
|---------|---------|
| **获取路由** | 获取 Vue Router 中所有已加载的路由 |
| **清除跳转** | 清除 Vue Router 的跳转方法 |
| **清除路由守卫** | 清除 beforeEach 和 beforeResolve 守卫 |
| **激活 Vue Devtools** | 强制激活 Vue Devtools 调试工具 |

**Vue 板块特性：**
- 📋 **路由列表**：一键查看所有路由，支持搜索过滤
- 🔗 **快速操作**：复制路由、直接打开页面
- 📦 **批量导出**：一键复制所有路径或完整 URL
- 🎯 **自定义前置路由**：灵活配置路由前缀

### 📝 Headers - 请求头管理

全局请求头注入功能，类似 ModHeader 扩展，支持分组管理。

| 功能 | 说明 |
|------|------|
| **请求头分组** | 创建多个请求头组，快速切换不同环境配置 |
| **全局注入** | 请求头自动添加到所有 HTTP 请求 |
| **启用/禁用** | 单独控制每个请求头的启用状态 |
| **MCP 集成** | 通过 AI 工具管理请求头配置 |

**使用场景：**
- 🔐 添加认证 Token（Authorization、X-Token 等）
- 🏢 切换租户 ID（tenant-id）
- 🧪 测试不同环境的请求头配置
- 🔧 调试 API 接口

### 🤖 MCP - AI 集成

🔗 支持 Model Context Protocol (MCP)，可通过 Codex AI 直接控制浏览器。

**MCP 功能：**
- 🔌 与 Codex AI / Claude / Trae 等编辑器无缝集成
- 🌍 全局操作模式：通过页面标题匹配操作任意标签页
- 🛠️ 91 个专用工具：页面分析、网络监控、加密捕获、请求头管理等

---

## 📥 安装方法

> ⚠️ **本文件此前是旧版 README 的整份拷贝**（还残留 `Version 4.0.0` 与 `License-MIT` 两个错误徽章）。
> 它的「安装方法」章节只有一张指向三个教程的表格，而 **Codex 那一行指向的正是本文件自己**——
> 死循环，全文**没有一个安装步骤**。V4.9.36 已更正徽章与本节。
>
> 本文件保留的是**功能清单**（下面的脚本/工具表格仍然有效）；
> **安装步骤请看 [README 的「安装方法」](../README.md#-安装方法)** ——那里有完整的通用四步
> （加载扩展到浏览器 → 装依赖并自动构建 → 配置 MCP 客户端 → 可选装 Native Launcher）。

### Codex 专有部分

与 Qoder / Trae 教程**完全一致**，只是配置文件的入口不同：

1. Codex 右上角 **设置 → MCP 服务 → 添加**，它会为你打开该编辑器的 `mcp.json`
2. 填入与 [Qoder 教程](./qoder安装教程.md) 第三节**相同**的 `mcpServers` 配置块
   （`command` 用 `node`，`args` 指向 `<本仓库路径>/mcp-server/dist/index.bundle.cjs`，
   `env` 里 `MCP_PORT` 与插件设置一致）
3. 保存后重载 Codex 窗口，在 MCP 面板确认 `Fush` 已连接且**工具数为 104**

---

## 📖 使用说明

### ⚡ 基本操作

1. **开启脚本**：点击对应脚本的开关按钮
2. **刷新页面**：脚本生效需要刷新目标页面
3. **查看结果**：打开 F12 控制台查看 Hook 输出

### 🔄 模式切换

- **标准模式**（默认）：脚本仅注入到当前网站
- **全局模式**：脚本注入到所有网站

> ⚠️ 对于 `file://` 协议或 `localhost` 页面，必须开启全局模式

### 🪝 Hook 板块使用

1. **基础使用**：开启脚本后，所有相关操作都会打印到控制台
2. **关键字过滤**：开启「检索关键字」，添加关键字后只捕获匹配内容
3. **断点调试**：开启 `debugger` 按钮，捕获时自动断点
4. **堆栈追踪**：开启 `stack` 按钮，打印完整调用堆栈

### 🌐 Vue 路由获取

1. 开启「获取路由」脚本
2. 刷新目标 Vue 网站
3. 返回插件查看「路由列表」标签页
4. 点击「复制」或「打开」操作路由

### 📝 请求头管理

1. 点击左侧「Headers」菜单进入请求头管理
2. 点击「新建分组」创建请求头组
3. 在分组中添加请求头（名称和值）
4. 点击分组右侧的「启用」按钮激活该组请求头
5. 所有 HTTP 请求都会自动携带已启用的请求头

**使用技巧：**
- 🔄 **快速切换**：创建多个分组（如"开发环境"、"测试环境"），一键切换
- ✅ **单独控制**：每个请求头可单独启用/禁用
- 🤖 **MCP 管理**：通过 AI 工具快速配置请求头

---

## 🤖 MCP 提示词与案例

### 💬 常用提示词

> 📝 **使用说明：** 将 `{网站title}` 替换为目标网站的实际标题

#### 🔍 一键分析页面

```
请帮我调用 Fush 分析 {网站title} 页面，检测反调试机制、前端框架、加密方式和认证机制
```

#### 🔐 加密算法逆向

```
请帮我调用 Fush 分析 {网站title} 
输入内容"你好啊"后会触发 API 接口：
https://xxxx.com/translate/key?mysticTime=xxx&token=xxx&sign=xxx
帮我还原出 sign 的加密算法，并进行发包验证
```

#### 🔥 综合渗透测试

```
请帮我调用 Fush 对 {网站title} 进行完整的前端安全分析：
1. 检测并绕过反调试
2. 获取所有 Vue 路由
3. 批量访问路由收集 API
4. 扫描敏感数据泄露
5. 分析加密和认证机制
```

#### 🛡️ 后台系统测试

```
请帮我调用 Fush 对 {网站title} 测试后台系统的前端安全：
1. 获取所有路由
2. 检测未授权访问
3. 扫描敏感信息泄露
4. 分析接口签名
```

---

### 📚 实战案例

> 🚧 **案例正在整理中，敬请期待...**

---

## ⚠️ 注意事项

| ⚠️ | 说明 |
|---|------|
| 🦊 | 本插件目前 **不支持火狐浏览器** |
| 🔄 | 开启/关闭脚本后需 **刷新页面** 才能生效 |
| 📍 | 本插件 **无法自动添加** 未加载的 Vue 路由 |
| 🗑️ | 更新插件时请 **先移除旧版本** 再导入新版 |

---

## 🙏 致谢

### 👥 贡献者

感谢以下贡献者的付出：

- Fush（本项目作者）：https://github.com/fush520
- [CC11001100](https://github.com/CC11001100)
- [Dexter](https://github.com/mingheyan)]
- [d1sbb](https://github.com/d1sbb)
- [Yosan](https://github.com/lyousan)

### 📚 引用项目

| 项目 | 链接 |
|-----|------|
| VueCrack | [https://github.com/AntSwordProject/VueCrack](https://github.com/AntSwordProject/VueCrack) |
| FakeCryptoJS | [https://github.com/AntSwordProject/FakeCryptoJS](https://github.com/AntSwordProject/FakeCryptoJS) |
| vue-force-dev | [https://github.com/AntSwordProject/vue-force-dev](https://github.com/AntSwordProject/vue-force-dev) |
| Hook_JS | [https://github.com/AntSwordProject/Hook_JS](https://github.com/AntSwordProject/Hook_JS) |
| ModHeader - Modify HTTP headers | [https://chromewebstore.google.com/detail/idgpnmonknjnojddfkpgkljpfnnfcklj](https://chromewebstore.google.com/detail/idgpnmonknjnojddfkpgkljpfnnfcklj) |
