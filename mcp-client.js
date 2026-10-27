// ============================================================================
// mcp-client.js —— 加载器（V4.9.37 拆分后）
//
// 拆分前这里是 7,861 行的单文件。按作者自己的分节横幅拆成 5 个文件，
// **本文件保留原名**，于是 background.js 的 `importScripts('mcp-client.js')`
// 与所有既有引用都不用改。
//
// 为什么用 importScripts 多文件而不是 ES module：
//   转模块会改变作用域模型（模块作用域 ≠ 全局作用域）并引入严格模式，
//   而本文件与 background.js **刻意共享同一个 SW 全局作用域**
//   （见 background.js 里"两文件同处一个 SW 全局作用域"的注释）。
//   多文件 importScripts 保持该模型一字不变，只是文件边界移动了。
//
// ⚠️ 顺序即语义：这些脚本按序求值，且**加载期有立即执行的顶层代码**
//   （chrome.*.addListener 注册、末尾的 self.mcpClient 导出与 initMCPConnection()）。
//   **改动顺序前先想清楚**。
//
// 拆分自证：5 段拼接与原文件**逐字节相同**（temp/_split.py 里带断言）。
// ============================================================================

importScripts(
    'mcp-client-core.js',      // 配置/状态/WS/保活/持久化/命令派发
    'mcp-client-page.js',      // 作用域/DOM/网络抓取基础
    'mcp-client-cdp.js',       // 浏览器控制/CDP交互/断点/动作验证/a11y
    'mcp-client-analysis.js',  // 加密/图谱/智能/Vue/表单/Burp/敏感数据
    'mcp-client-events.js'     // 事件监听/请求头管理/场景协调/导出+init
);
