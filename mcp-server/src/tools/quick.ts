// ============== 场景编排（一键分析/智能场景/反调试绕过） ==============
// P0-2 拆分自 index.ts——工具注册文本原样搬运，逻辑零改动。

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sendToBrowser } from "../transport.js";
import {
  judgeUnauthorized,
  anonFetchWithServerFallback,} from "../helpers.js";

export function register_quick_tools(server: McpServer): void {
// 69. 快捷工具：加密分析（一键启用加密相关Hook + 分析）
server.tool(
  "quick_vue_analysis",
  "一键Vue分析：启用路由获取脚本，获取路由信息并可选择清除路由守卫。`summary.guardsCleared` 是**回查启用清单**的正证据式结论（true=确认已启用／false=未请求或确认没启用／null=请求了但未能核实）——原为参数回显，注入失败也报\"已清除\"",
  {
    clearGuards: z.boolean().optional().describe("是否同时清除路由守卫，默认false"),
    autoRefresh: z.boolean().optional().describe("是否自动刷新页面，默认true"),
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用活动标签页）"),
    hostname: z.string().optional().describe("目标 hostname（在该域名的标签页上执行）"),
  },
  async ({ clearGuards = false, autoRefresh = true, tab_id: tabId, hostname }) => {
    try {
      const results: any = { steps: [] };
      
      // 步骤1: 启用Vue脚本
      const scripts = ["Get_Vue_0", "detectorExec"];
      if (clearGuards) {
        scripts.push("Get_Vue_1", "Clear_vue_Navigation_Guards");
      }
      
      results.steps.push({ step: 1, action: "启用Vue分析脚本" });
      let batchOk = true;
      let batchError: string | null = null;
      try {
        const br: any = await sendToBrowser("BATCH_ENABLE_SCRIPTS", {
          scriptIds: scripts,
          autoRefresh,
          tabId, hostname
        });
        // 客户端如实返回失败原因（V4.9.22 修过该链路）；这里不再吞掉
        if (br && br.success === false) { batchOk = false; batchError = br.error || br.message || '批量启用返回失败'; }
      } catch (e: any) {
        batchOk = false; batchError = e?.message || String(e);
      }
      if (!batchOk) results.enableError = `启用脚本失败：${batchError}`;

      if (autoRefresh) {
        results.steps.push({ step: 2, action: "等待页面刷新" });
        await new Promise(r => setTimeout(r, 2000));
      }
      
      // 步骤3: 获取Vue路由数据
      results.steps.push({ step: 3, action: "获取Vue路由" });
      try {
        results.vueData = await sendToBrowser("GET_VUE_ROUTER_DATA", { tabId, hostname });
      } catch (e) {
        results.vueData = { error: "获取失败，可能页面未使用Vue Router" };
      }
      
      // V4.9.25（清单🟡-20）：**正证据式**判断守卫是否真的启用——原实现 `guardsCleared: clearGuards`
      // 是**参数回显**：注入失败、脚本没注册、批量启用整体报错，照样回一句"已清除"（假成功）。
      // 现实际回查启用清单，取到证据才下结论
      const GUARDS_SCRIPT = "Clear_vue_Navigation_Guards";
      let enabledNow: string[] | null = null;
      try {
        const st: any = await sendToBrowser("GET_ENABLED_SCRIPTS", { tabId, hostname });
        if (st && Array.isArray(st.enabledScripts)) enabledNow = st.enabledScripts;
      } catch (e) { /* 查不到就如实报"未验证"，不猜 */ }

      const guardsCleared = !clearGuards
        ? false
        : (enabledNow === null ? null : enabledNow.includes(GUARDS_SCRIPT));

      results.summary = {
        enabled: scripts,
        guardsRequested: clearGuards,
        // true=已确认在启用清单里｜false=未请求或确认**不在**｜null=请求了但**未能核实**
        guardsCleared,
        guardsClearedNote: !clearGuards
          ? "未请求清除守卫"
          : (guardsCleared === true
            ? `已确认 ${GUARDS_SCRIPT} 在启用清单中（页面刷新后接管路由守卫）`
            : (guardsCleared === null
              ? `**未能核实** ${GUARDS_SCRIPT} 是否启用（回查启用清单失败）——不要当作已清除`
              : `⚠️ ${GUARDS_SCRIPT} **不在**启用清单中：清除守卫**没有生效**，路由跳转仍会被拦`)),
        // V4.9.31：message 必须反映**数据是否真取到**。原实现只看 clearGuards——脚本一启用成功
        // 就写"Vue路由分析已就绪"，而**同一次返回体里的 vueData 可能 status:'timeout' / notFound:true**。
        // 实测（portal.example.com，Vue 2.7.16）：summary 说"已就绪"、vueData 说"超时"，同一份返回体
        // 自相矛盾；AI 若只读 summary（很自然的做法）就会以为路由拿到了，进而放弃本可走通的链路。
        message: (results.vueData && !results.vueData.notFound && results.vueData.status === "found")
          ? (guardsCleared === true ? "Vue路由分析已就绪，路由守卫已清除" : "Vue路由分析已就绪")
          : `⚠️ 脚本已启用，但**未取到路由数据**（vueData.status=${results.vueData && results.vueData.status}）——`
            + `不要当作"分析已就绪"；详见 vueData 的 notFound/rescanError/hint 字段`,
        tips: [
          "Get_Vue_0: 获取已加载的路由",
          "detectorExec: 激活Vue Devtools",
          clearGuards ? "已清除路由守卫，可自由访问各页面" : "如需清除路由守卫，设置 clearGuards: true"
        ]
      };
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify(results, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Vue分析启用失败: ${error.message}` }],
        isError: true
      };
    }
  }
);
// 67. 智能场景启用工具
// ============== Burp Suite 格式网络请求 ==============
// 35. 检测反调试机制
server.tool(
  "detect_anti_debug",
  "检测页面中的反调试机制（debugger语句、控制台检测、窗口大小检测等）。**覆盖范围有限**：只扫**内联** `<script>`，外链脚本的 textContent 为空、扫不到——SPA 的反调试多打包在外链 bundle 里，所以「未检测到」**不代表**该站没有反调试；返回体的 `scanCoverage` 会如实标注未扫数量，外链 bundle 请改用 info_leak_scan / get_chunk_source 读源码搜索",
  {
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用活动标签页）"),
    hostname: z.string().optional().describe("目标 hostname（在该域名的标签页上执行）"),
  },
  async ({ tab_id: tabId, hostname }) => {
    try {
      const result = await sendToBrowser("DETECT_ANTI_DEBUG", { tabId, hostname });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `检测失败: ${error.message}` }],
        isError: true
      };
    }
  }
);
// 37. 分析API签名
server.tool(
  "analyze_api_signature",
  "分析最近的API请求：提取 **URL 查询参数中的签名参数**（sign/token/timestamp/nonce 等）与 **认证请求头**（Authorization/Cookie/X-*-Token 等，含值预览与来源 URL，每种最多 10 条去重）。注意：**不解析 body 参数**——body 里的签名/加密参数请用 get_network_requests include_body=true 查看；密文↔明文对照见 Crypto_Capture 脚本 + get_decrypted_responses",
  {
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用活动标签页）"),
    hostname: z.string().optional().describe("目标 hostname（在该域名的标签页上执行）"),
  },
  async ({ tab_id: tabId, hostname }) => {
    try {
      const result = await sendToBrowser("ANALYZE_API_SIGNATURE", { tabId, hostname });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `分析失败: ${error.message}` }],
        isError: true
      };
    }
  }
);

// ============== 智能化功能：框架数据提取 ==============
// 36. 自动绕过反调试
server.tool(
  "auto_bypass_anti_debug",
  "检测并自动启用相应的反调试绕过脚本",
  {
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用活动标签页）"),
    hostname: z.string().optional().describe("目标 hostname（在该域名的标签页上执行）"),
  },
  async ({ tab_id: tabId, hostname }) => {
    try {
      const result = await sendToBrowser("AUTO_BYPASS_ANTI_DEBUG", { tabId, hostname });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `绕过失败: ${error.message}` }],
        isError: true
      };
    }
  }
);

// ============== 智能化功能：API分析 ==============
}
