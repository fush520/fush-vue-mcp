// ============== 脚本管理（Hook 脚本开关/配置/WS 监控/路由访问准备） ==============
import { sendToBrowser } from "../transport.js";
// P0-2 拆分自 index.ts——工具注册文本原样搬运，逻辑零改动。

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";


export function register_scripts_tools(server: McpServer): void {
// 7. 启用/禁用脚本
server.tool(
  "toggle_script",
  "启用或禁用指定的脚本",
  {
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用活动标签页）"),
    hostname: z.string().optional().describe("目标 hostname（在该域名的标签页上执行）"),
    script_id: z.string().describe("脚本ID，如 'hook_xhr_open', 'Get_Vue_0' 等"),
    enabled: z.boolean().describe("是否启用")
  },
  async ({ script_id: scriptId, enabled, tab_id: tabId, hostname }) => {
    try {
      const result = await sendToBrowser("TOGGLE_SCRIPT", { scriptId, enabled, tabId, hostname });
      // V4.9.30：**注册结果必须透出**——原实现把客户端的 result **整个丢弃**，只用入参回显
      //（`success` 硬编码 true、`message` 由入参拼出），于是"开关状态写入了但内容脚本没注册"
      // 这种情况 AI 完全看不见（hostname 不含点、被 DevTools 占用等场景下 hook 根本不生效）。
      // 客户端已改为直接调用 registerScripts 并回填 registration，这里必须把它透出来，
      // 否则又是一次"修复在半路被架空"。
      const reg: any = (result && typeof result === "object") ? (result as any).registration : undefined;
      const regErr = reg && reg.error ? String(reg.error) : "";
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,          // 语义：脚本开关状态**已写入** storage（非"注册成功"）
            scriptId,
            enabled,
            ...(reg ? { registration: reg } : {}),
            ...(regErr ? {
              warning: `脚本状态已保存，但**内容脚本注册失败**：${regErr}——hook 不会生效。`
                + `常见原因：目标标签页被 DevTools 或其它扩展占用；或 hostname 无法解析。`
                + `可改用 tab_id 精确指定标签页后重试。`
            } : {}),
            message: regErr
              ? `脚本 ${scriptId} 状态已保存，但注册失败（hook 未生效）`
              : `脚本 ${scriptId} 已${enabled ? "启用" : "禁用"}，刷新页面后生效`
          }, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `切换脚本失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);
// 6. 获取已启用的脚本列表
server.tool(
  "get_enabled_scripts",
  "获取指定标签页（或活动标签页）当前已启用的脚本列表",
  {
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用活动标签页）"),
    hostname: z.string().optional().describe("目标 hostname（在该域名的标签页上执行）"),
  },
  async ({ tab_id: tabId, hostname }) => {
    try {
      // V4.9.23（缺陷🟡-15）：原调用**一个参数都没传**（schema 声明了 tab_id/hostname 却是摆设）
      // → 永远落到活动标签页：多标签下拿到的是别的站点的脚本开关状态
      const scripts = await sendToBrowser("GET_ENABLED_SCRIPTS", { tabId, hostname });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(scripts, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `获取脚本列表失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);
// 15. 获取可用脚本列表
server.tool(
  "list_available_scripts",
  "获取所有可用的脚本列表及其描述",
  {
    category: z.enum(["antidebug", "hook", "vue", "all"]).optional().describe("脚本分类")
  },
  async ({ category = "all" }) => {
    try {
      const scripts = await sendToBrowser("LIST_AVAILABLE_SCRIPTS", { category });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(scripts, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `获取脚本列表失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);
// 14. 配置Hook脚本参数
server.tool(
  "configure_hook",
  "配置Hook脚本的参数（如关键字过滤、debugger开关等）",
  {
    script_id: z.string().describe("脚本ID"),
    config: z.object({
      keywords: z.array(z.string()).optional().describe("关键字过滤列表"),
      enableDebugger: z.boolean().optional().describe("是否启用debugger断点"),
      enableStack: z.boolean().optional().describe("是否打印调用堆栈"),
      fixedValue: z.string().optional().describe("固定返回值（用于Math.random等）")
    }).describe("配置选项")
  },
  async ({ script_id: scriptId, config }) => {
    try {
      const result = await sendToBrowser("CONFIGURE_HOOK", { scriptId, config });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            scriptId,
            config,
            message: "Hook配置已更新"
          }, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `配置Hook失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);
// 5. 获取Hook捕获的数据
server.tool(
  "get_hook_data",
  "获取Hook脚本捕获的数据（cookie、localStorage、XHR等）。**script_id 的真实语义（V4.9.38 批 3 审计 S-R1 如实交代）**：Hook 脚本的输出经 hook_console_bridge 统一以 `scriptId:'console'` 上报（44 个脚本没有一个上报自身 id），Crypto_Capture 的能力/解密数据以 `scriptId:'crypto_capture'` 上报；因此按 Hook 脚本名（hook_xhr_open 之类）过滤**恒为空数组**——那不代表没抓到，数据在 'console' 下，按 Hook 名查请改用 get_console_messages。**恢复记录**：SW 被浏览器回收后从落盘恢复的条目单条上限 16384 **字符**，其中带 `[落盘截断: 落盘前 N 字符]` 标记（其尾部可能还跟一个 `[ADB 截断]`）；内存缓冲中的原始消息不受影响，仅落盘副本截断",
  {
    script_id: z.string().optional().describe("数据源 id：只支持 `crypto_capture`（加密能力/解密上报）与 `console`（全部 Hook 脚本的 console 输出）。传 hook_* 脚本名会得到空数组（数据归在 console 下，改用 get_console_messages）"),
    limit: z.number().int().min(1).max(500).optional().describe("返回的最大数据条数，默认50（bug-hunt：原无约束会因 slice(-limit) 语义反转）"),
    clear: z.boolean().optional().describe("获取后是否清空数据（配合 tab_id 时只清该标签页的）"),
    tab_id: z.number().int().optional().describe("只看该标签页的 Hook 数据（省略则返回全部标签页，每条带 tabId 标明来源）")
  },
  async ({ script_id: scriptId, limit = 50, clear = false, tab_id: tabId }) => {
    try {
      const hookData = await sendToBrowser("GET_HOOK_DATA", { scriptId, limit, clear, tabId });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(hookData, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `获取Hook数据失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);
// 76. 批量启用脚本
server.tool(
  "batch_enable_scripts",
  "批量启用或禁用多个脚本",
  {
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用活动标签页）"),
    hostname: z.string().optional().describe("目标 hostname（在该域名的标签页上执行）"),
    script_ids: z.array(z.string()).describe("要启用的脚本ID列表"),
    enabled: z.boolean().optional().describe("是否启用，默认true"),
    auto_refresh: z.boolean().optional().describe("是否自动刷新页面，默认false")
  },
  async ({ script_ids: scriptIds, enabled = true, auto_refresh: autoRefresh, tab_id: tabId, hostname }) => {
    try {
      const result = await sendToBrowser("BATCH_ENABLE_SCRIPTS", { 
        scriptIds, 
        enabled,
        autoRefresh, tabId, hostname });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `批量操作失败: ${error.message}` }],
        isError: true
      };
    }
  }
);
// 74. 禁用所有脚本
server.tool(
  "disable_all_scripts",
  "禁用当前页面的所有已启用脚本",
  {
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用活动标签页）"),
    hostname: z.string().optional().describe("目标 hostname（在该域名的标签页上执行）"),
    autoRefresh: z.boolean().optional().describe("是否自动刷新页面，默认false")
  },
  async ({ autoRefresh = false, tab_id: tabId, hostname }) => {
    try {
      const result = await sendToBrowser("DISABLE_ALL_SCRIPTS", { autoRefresh, tabId, hostname });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `禁用失败: ${error.message}` }],
        isError: true
      };
    }
  }
);

// ============== 资源定义 ==============


// 26. 扫描路由收集API


// 27. 批量扫描路由收集API



// 44. 获取WebSocket消息（V4.5：改调 hook_websocket 新链路 GET_WS_FRAMES，环形 200 条）

// 44. 获取WebSocket消息（V4.5：改调 hook_websocket 新链路 GET_WS_FRAMES，环形 200 条）
server.tool(
  "get_ws_messages",
  "读取 WebSocket 监控帧：hook_websocket 脚本捕获的 WS 连接与收发帧（文本帧截断 2048 字符；**二进制帧以 `[binary NB b64] <base64前2048字符>` 上报**（protobuf/自定义协议可解）；带 seq 序号已按线上顺序排列；环形 200 条）。需先启用 hook_websocket 脚本并刷新页面",
  {
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用活动标签页）"),
    hostname: z.string().optional().describe("目标 hostname（在该域名的标签页上执行）"),
    limit: z.number().int().min(1).max(200).optional().describe("返回条数（默认 100）"),
    filter: z.string().optional().describe("帧内容关键词过滤（原始子串匹配——二进制帧只有 base64 形态，明文关键词搜不到）")
  },
  async ({ limit = 100, filter, tab_id: tabId, hostname }) => {
    try {
      const result = await sendToBrowser("GET_WS_FRAMES", { limit, filter, tabId, hostname });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `获取失败: ${error.message}` }],
        isError: true
      };
    }
  }
);

// 33.7 获取自动解密的响应
server.tool(
  "get_decrypted_responses",
  "获取自动解密匹配到的响应（Crypto_Capture 捕获 密文→明文 映射后与 fetch 响应体指纹匹配，包括 JSON 内嵌密文字段）",
  {
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用活动标签页）"),
    hostname: z.string().optional().describe("目标 hostname（在该域名的标签页上执行）"),
    limit: z.number().int().min(1).max(200).optional().describe("返回条数（1-200），默认 50")
  },
  async ({ limit, tab_id: tabId, hostname }) => {
    try {
      const result = await sendToBrowser("GET_DECRYPTED_RESPONSES", { limit: limit || 50, tabId, hostname });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `获取解密响应失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

}
