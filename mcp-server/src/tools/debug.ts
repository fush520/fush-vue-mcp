// ============== CDP 调试（断点/暂停态/调用帧） ==============
// P0-2 拆分自 index.ts——工具注册文本原样搬运，逻辑零改动。

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sendToBrowser } from "../transport.js";

export function register_debug_tools(server: McpServer): void {
// V4.9.11（吸收上游 adb_debug）：CDP 断点调试——在目标 JS 的加密函数/关键分支暂停，读调用帧与局部变量
server.tool(
  "debug_control",
  "CDP 断点调试控制（Debugger 域）：pause/resume/step_into/step_over/step_out/set_breakpoint/remove_breakpoint/list_breakpoints/detach。在目标 JS 的加密函数/关键分支下断点，配合 get_debug_state 读调用栈与局部变量（还原加密逻辑、看签名入参的最直接手段）。断点调试为长驻调试会话（断点不随单次调用失效），用 detach 结束。【证据边界】paused 请求发出≠已暂停（等 1-2 秒再读状态）；断点命中≠停在预期行（JIT/内联可能错位）；set_breakpoint 的 locations 为空≠断点无效（脚本可能尚未加载）；remove_breakpoint 不会自动恢复执行。⚠️ 暂停期间页面冻结——其它页面操作类工具会挂起，分析完必须 resume",
  {
    action: z.enum(["pause", "resume", "step_into", "step_over", "step_out", "set_breakpoint", "remove_breakpoint", "list_breakpoints", "detach"]),
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则活动页）"),
    url_regex: z.string().optional().describe("set_breakpoint 用：脚本 URL 正则，如 .*encrypt.*\\.js（CDP 侧为 JS 正则语义）"),
    line_number: z.number().int().min(1).optional().describe("set_breakpoint 用：行号（1-based，内部自动转 CDP 0-based）"),
    column_number: z.number().int().min(1).optional().describe("set_breakpoint 用：列号（1-based，可省略）"),
    breakpoint_id: z.string().optional().describe("remove_breakpoint 用：set_breakpoint 返回的 breakpointId")
  },
  async ({ action, tab_id: tabId, url_regex: urlRegex, line_number: lineNumber, column_number: columnNumber, breakpoint_id: breakpointId }) => {
    try {
      const r = await sendToBrowser("DEBUG_CONTROL", { action, tabId, urlRegex, lineNumber, columnNumber, breakpointId }, 20000);
      return { content: [{ type: "text", text: JSON.stringify(r, null, 1) }] };
    } catch (error: any) {
      return { content: [{ type: "text", text: `断点调试失败: ${error.message}` }], isError: true };
    }
  }
);
// V4.9.11：读取 CDP 暂停状态（调用帧 + 作用域变量）
server.tool(
  "get_debug_state",
  "读取 CDP 暂停状态：调用帧列表（函数名/URL/行号/作用域类型）+ 指定作用域的变量值（scope_index 可选，2 通常是 local）。需先 debug_control 的 pause 或断点命中。【证据边界】返回 paused:false 只说明此刻无暂停，不构成\"代码没执行\"的证据；callFrameId 每次暂停都变化，旧 ID 不可复用；变量值可能被截断（长字符串 300 字符）",
  {
    tab_id: z.number().int().optional().describe("指定读哪个标签页的暂停态（省略则取最近一次暂停的标签页；暂停态按标签页分别记录，互不覆盖）"),
    call_frame_index: z.number().int().min(0).optional().describe("第几个调用帧（默认 0 = 最内层/出错点）"),
    scope_index: z.number().int().min(0).optional().describe("读哪个作用域的变量（先看 callFrames[].scopes 的类型列表再选，如 3=local）"),
    max_vars: z.number().int().min(1).max(100).optional().describe("最多返回变量数（默认 30）")
  },
  async ({ tab_id: tabId, call_frame_index: callFrameIndex, scope_index: scopeIndex, max_vars: maxVars }) => {
    try {
      const r = await sendToBrowser("GET_DEBUG_STATE", { tabId, callFrameIndex, scopeIndex, maxVars }, 15000);
      return { content: [{ type: "text", text: JSON.stringify(r, null, 1) }] };
    } catch (error: any) {
      return { content: [{ type: "text", text: `读取调试状态失败: ${error.message}` }], isError: true };
    }
  }
);
}
