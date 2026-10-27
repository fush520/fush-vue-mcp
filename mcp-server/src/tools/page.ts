// ============== 页面基础（信息/存储/执行/截图/DOM/交互/导航/Cookie/请求头） ==============
// P0-2 拆分自 index.ts——工具注册文本原样搬运，逻辑零改动。

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "fs";
// V4.9.42（验收 Y4）：`currentPort` 的唯一使用者是被删的 get_connection_status —— 死 import 一并移除
import { browserState, sendToBrowserRetry, sendToBrowser, isBrowserConnected } from "../transport.js";

export function register_page_tools(server: McpServer): void {
// 2. 获取当前页面信息
server.tool(
  "get_page_info",
  "获取浏览器页面的基本信息（URL、标题、域名等）。默认活动标签页；可传 tab_id/hostname 指定目标",
  {
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用活动标签页）"),
    hostname: z.string().optional().describe("按域名定位目标标签页（如 example.com）")
  },
  async ({ tab_id: tabId, hostname }) => {
    try {
      const pageInfo = await sendToBrowser("GET_PAGE_INFO", { tabId, hostname });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(pageInfo, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `获取页面信息失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);
// 3. 获取网络请求列表（V4.9.18 两段式：默认精简列表——先扫列表挑可疑 requestId，再 get_network_request_detail 拉单条）
server.tool(
  "get_network_requests",
  "获取页面的网络请求/API调用记录【默认**精简列表**：url/method/状态/时间/requestId 概览】。看完整请求头/响应头加 detail=true；归并请求体/响应体加 include_body=true（隐含 detail）；看单条详情用 get_network_request_detail。**加密站点**：页面启用 Crypto_Capture 脚本时，带 body 的记录自动附 `requestPlaintext`/`responsePlaintext`（密文↔明文对照——直接看到加密参数的真实内容）。**恢复记录**：SW 被浏览器回收后从落盘恢复的较老记录不含头，条目带 `headersOmitted:true`（≠ 原请求本来没有 Cookie/Authorization）。可传 tab_id 只看该标签页的请求",
  {
    limit: z.number().int().min(1).max(1000).optional().describe("返回的最大请求数量，默认50（bug-hunt：原无约束——limit=0 会因 slice(-0) 返回全量、负数变偏移量）"),
    filter: z.string().optional().describe("URL过滤关键词（大小写不敏感）"),
    method: z.string().optional().describe("HTTP方法过滤（GET, POST等）"),
    tab_id: z.number().int().optional().describe("只看该标签页产生的请求（webRequest 全局采集，按 tabId 过滤）"),
    hostname: z.string().optional().describe("按域名定位标签页（与 tab_id 二选一；二者都传时以 tab_id 为准）"),
    detail: z.boolean().optional().describe("true=返回完整请求头/响应头（含 Cookie/Authorization/真实 UA 等 12-16 个头）。默认 false 只回精简列表——全量头 × 50 条会压满模型上下文"),
    include_body: z.boolean().optional().describe("归并请求体/响应体（页面 hook 全量捕获 fetch/XHR；调用时自动注入 hook——之后触发的请求才有 body，先调本参数再操作页面）；隐含 detail=true")
  },
  async ({ limit = 50, filter, method, tab_id: tabId, hostname, detail = false, include_body: includeBody = false }) => {
    try {
      const requests = await sendToBrowser("GET_NETWORK_REQUESTS", { limit, filter, method, tabId, hostname, detail, includeBody });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(requests, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `获取网络请求失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);
// 49. 获取 Burp 格式网络请求
server.tool(
  "get_network_requests_burp",
  "获取网络请求并转换为 Burp Suite 格式（完整请求头/响应头/请求体/响应体——真实可重放）。输出条目的 `request` 字段是标准 raw HTTP 请求，**可直接作为 mcp__burp__http_send_request 的输入**做重放/改包/爆破（无需人工复制到 Repeater）；`response` 字段含真实响应原文。**恢复记录**：缺头的包内带 `X-ADB-Headers-Omitted` 注头 + 条目 `warn` 字段——重放前需自行补 Cookie/Authorization",
  {
    filter: z.string().optional().describe("URL过滤关键词（大小写不敏感）"),
    limit: z.number().int().min(1).max(1000).optional().describe("返回的最大数量，默认50"),
    tab_id: z.number().int().optional().describe("只看该标签页的请求（多标签场景建议必传——body 归并依赖页面 hook，需指明目标标签）")
  },
  async ({ filter, limit = 50, tab_id: tabId }) => {
    try {
      const result = await sendToBrowser("GET_NETWORK_REQUESTS_BURP", { filter, limit, tabId });
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
// 49b. 获取单条网络请求的完整详情（V4.9.18 两段式第二段）
server.tool(
  "get_network_request_detail",
  "获取**单条**网络请求的完整详情（完整请求头/响应头 + 请求体/响应体归并 + 密文↔明文对照[需页面启用 Crypto_Capture]）。配合 get_network_requests 的精简列表使用：先扫列表挑可疑 requestId，再拉这一条的详情",
  {
    request_id: z.string().describe("get_network_requests 返回条目的 requestId"),
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用记录自身的 tabId）")
  },
  async ({ request_id: requestId, tab_id: tabId }) => {
    try {
      const result = await sendToBrowser("GET_NETWORK_REQUEST_DETAIL", { requestId, tabId });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `获取请求详情失败: ${error.message}` }],
        isError: true
      };
    }
  }
);
// 10. 获取LocalStorage
server.tool(
  "get_local_storage",
  "获取当前页面的LocalStorage数据",
  {
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用活动标签页）"),
    hostname: z.string().optional().describe("目标 hostname（在该域名的标签页上执行）"),
    key: z.string().optional().describe("键名过滤")
  },
  async ({ key, tab_id: tabId, hostname }) => {
    try {
      const storage = await sendToBrowser("GET_LOCAL_STORAGE", { key, tabId, hostname });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(storage, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `获取LocalStorage失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);
// 11. 获取SessionStorage
server.tool(
  "get_session_storage",
  "获取当前页面的SessionStorage数据",
  {
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用活动标签页）"),
    hostname: z.string().optional().describe("目标 hostname（在该域名的标签页上执行）"),
    key: z.string().optional().describe("键名过滤")
  },
  async ({ key, tab_id: tabId, hostname }) => {
    try {
      const storage = await sendToBrowser("GET_SESSION_STORAGE", { key, tabId, hostname });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(storage, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `获取SessionStorage失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);
// 12. 执行JavaScript代码
server.tool(
  "execute_script",
  "在页面上下文中执行JavaScript代码。默认活动标签页；可传 tab_id/hostname 指定目标。【证据边界】返回成功仅代表脚本执行未抛异常，不代表页面状态符合预期（副作用可能被页面拦截/异步回滚）；返回失败或超时也不代表副作用未发生——关键写操作后用 get_semantic_dom/screenshot 复核状态",
  {
    code: z.string().describe("要执行的JavaScript代码"),
    world: z.enum(["MAIN", "ISOLATED"]).optional().describe("执行环境：MAIN(页面主世界)或ISOLATED(隔离环境)"),
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用活动标签页）"),
    hostname: z.string().optional().describe("按域名定位目标标签页（如 example.com）")
  },
  async ({ code, world = "MAIN", tab_id: tabId, hostname }) => {
    try {
      // V4.9.11（验收修复 S2）：retries=0——EXECUTE_SCRIPT 可执行任意代码（含写请求/点击），
      // 超时后自动重发会**双重执行**，与 V4.9.11 自己引入的"超时≠未执行"语义直接冲突。
      // 对照同文件的 HOOK_ROUTE_ARRAY 早已显式传 0 禁用重试（防二次 enable 冲突）。
      const result = await sendToBrowserRetry("EXECUTE_SCRIPT", { code, world, tabId, hostname }, 30000, 0);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            result
          }, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `执行脚本失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);
// 17. 截图（4.5.0：返回 image content，AI 可直接查看；fullPage/selector 由扩展端 CDP 实现）
server.tool(
  "take_screenshot",
  "截取页面的屏幕截图并返回图像（AI 可直接查看）；fullPage 截取整个页面，selector 截取指定元素。默认活动标签页；可传 tab_id/hostname 指定目标",
  {
    fullPage: z.boolean().optional().describe("是否截取整个页面（CDP captureBeyondViewport，无视口限制）"),
    selector: z.string().optional().describe("要截取的元素选择器"),
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用活动标签页）"),
    hostname: z.string().optional().describe("按域名定位目标标签页（如 example.com）")
  },
  async ({ fullPage = false, selector, tab_id: tabId, hostname }) => {
    try {
      const result = await sendToBrowser("TAKE_SCREENSHOT", { fullPage, selector, tabId, hostname });
      const base64 = (result?.dataUrl || '').replace(/^data:image\/png;base64,/, '');
      if (!base64) {
        return {
          content: [{ type: "text", text: "截图失败：扩展未返回图像数据" }],
          isError: true
        };
      }
      return {
        content: [
          { type: "image", data: base64, mimeType: "image/png" },
          { type: "text", text: JSON.stringify({ mode: result.mode || 'viewport', format: result.format }, null, 2) }
        ]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `截图失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);
// 84. 语义 DOM 快照（4.5.0 新增：提取页面全部可交互元素为紧凑索引清单，AI 据此选择定位方式）
server.tool(
  "get_semantic_dom",
  "获取页面可交互元素语义快照（按钮/输入框/链接/下拉等，含推荐选择器、可见文本、坐标）——操作页面前先拍快照",
  {
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用活动标签页）"),
    hostname: z.string().optional().describe("目标 hostname（在该域名的标签页上执行）"),
    filter: z.string().optional().describe("关键字过滤（匹配 tag/id/name/class/text，如 '登录'、'search'）"),
    limit: z.number().int().min(1).max(500).optional().describe("最多返回元素数（默认 150）")
  },
  async ({ filter = "", limit = 150, tab_id: tabId, hostname }) => {
    try {
      const result = await sendToBrowser("GET_SEMANTIC_DOM", { filter, limit, tabId, hostname }, 15000);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 1) }] };
    } catch (error: any) {
      return { content: [{ type: "text", text: `语义快照失败: ${error.message}` }], isError: true };
    }
  }
);
// 85. 真实点击（CDP，isTrusted=true）
server.tool(
  "real_click",
  "真实点击页面元素（chrome.debugger CDP 级输入，isTrusted=true，可穿透防自动化校验）；支持 ref（a11y 快照引用，最可靠）或 text= 语法按文本定位。返回含实际命中元素文本（element.text）与动作后验证 actionVerify（是否引发导航 navigatedToUrl / 对话框 dialogOpened）；warning（多命中）/ occlusionWarning（遮挡）/ clickWillMissWarning（候选点全不可命中）/ outOfViewportWarning（视口外）/ clickPointNote（自动换点）任一出现即可能点错目标，先核对——**无警告≠点对**（检查基于候选点 elementFromPoint，动画/异步布局可能漏检）。【证据边界】点击事件送达≠业务动作完成（异步提交可能失败/被校验拦截）；超时≠未点击——勿直接重试（有重复提交风险），先确认页面状态；**被节流的标签（长时间后台 / 浏览器窗口不在前台）会导致 CDP 输入被静默吞掉、页面 setTimeout 被拉长（100ms 定时器延迟到秒级——actionVerify 因此可能显示 navigated:false 而稍后才真跳）——返回 success 但页面无反应时，先把该标签激活（或把浏览器窗口带到前台）再操作；refresh_page 不能解除节流（按标签累积、导航/重载不重置，2026-10-13 实测）**",
  {
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用活动标签页）"),
    hostname: z.string().optional().describe("目标 hostname（在该域名的标签页上执行）"),
    ref: z.string().optional().describe("a11y 快照元素引用（如 \"2_5\"，来自 take_a11y_snapshot 的 uid=）——无选择器歧义，优先于 selector/坐标。注意覆盖边界：ref 只含 a11y 认定的可交互/有语义节点，<div onclick> 等无 role/name 的元素没有 uid（需回退 selector/text=）"),
    selector: z.string().optional().describe("CSS 选择器，或 text=登录 按文本定位"),
    x: z.number().optional().describe("视口坐标 x（与 y 一起用，替代 selector）"),
    y: z.number().optional().describe("视口坐标 y"),
    index: z.number().int().min(0).optional().describe("选择器命中多个时取第几个（默认 0）"),
    dblClick: z.boolean().optional().describe("是否双击"),
    on_dialog: z.enum(["accept", "dismiss"]).optional().describe("点击触发 JS 对话框（alert/confirm）时的**会话内**处理策略：accept=确认 / dismiss=取消；省略=仅报告不处理（会话结束后浏览器按取消处置）。对话框只与弹框时的会话关联——事后用 handle_dialog 接管不了（2026-10-13 实测），必须在动作会话内处理；防调试 alert 场景建议 accept"),
    wait: z.number().min(0).optional().describe("等待元素出现超时毫秒（默认 3000；传 0 或负数会回落为 1000ms 而非\"不等待\"）")
  },
  async ({ ref, selector, x, y, index = 0, dblClick = false, on_dialog: onDialog, wait = 3000, tab_id: tabId, hostname }) => {
    try {
      // ref 路径额外开销（attach + Page.enable + 250ms 收尾窗 + getFrameTree ×2 + resolveNode + callFunctionOn）——第四批审计 L2
      const result = await sendToBrowser("REAL_CLICK", { ref, selector, x, y, index, dblClick, onDialog, wait, tabId, hostname }, 15000 + (wait || 3000) + (ref ? 2000 : 0));
      return { content: [{ type: "text", text: JSON.stringify(result, null, 1) }] };
    } catch (error: any) {
      return { content: [{ type: "text", text: `真实点击失败: ${error.message}` }], isError: true };
    }
  }
);
// 86. 真实键入（CDP 逐字符，模拟人工输入节奏）
server.tool(
  "real_type",
  "真实键入文本到输入框（CDP isTrusted=true，触发完整 keydown/input 事件链，兼容 React 受控组件）；submit=true 键入后回车",
  {
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用活动标签页）"),
    hostname: z.string().optional().describe("目标 hostname（在该域名的标签页上执行）"),
    selector: z.string().describe("目标输入框选择器（先真实点击聚焦）"),
    index: z.number().int().min(0).optional().describe("选择器命中多个时聚焦第几个（默认 0）"),
    text: z.string().describe("要键入的文本（含中文时自动改用 CDP insertText）"),
    delay: z.number().optional().describe("逐字符间隔毫秒（默认 60，模拟人工节奏）"),
    submit: z.boolean().optional().describe("键入后是否按 Enter 提交"),
    clear: z.boolean().optional().describe("键入前是否清空（默认 true）"),
    wait: z.number().min(0).optional().describe("等待元素出现超时毫秒（默认 3000；传 0 或负数会回落为 1000ms 而非\"不等待\"）")
  },
  async ({ selector, index = 0, text, delay = 60, submit = false, clear = true, wait = 3000, tab_id: tabId, hostname }) => {
    try {
      const result = await sendToBrowser("REAL_TYPE", { selector, index, text, delay, submit, clear, wait, tabId, hostname }, 20000 + (wait || 3000) + text.length * (delay || 60));
      return { content: [{ type: "text", text: JSON.stringify(result, null, 1) }] };
    } catch (error: any) {
      return { content: [{ type: "text", text: `真实键入失败: ${error.message}` }], isError: true };
    }
  }
);
// 87. 真实按键（CDP）
server.tool(
  "real_key",
  "发送真实按键（CDP isTrusted=true）：enter/tab/escape/backspace/delete/arrowup/arrowdown/arrowleft/arrowright/home/end/pageup/pagedown/space",
  {
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用活动标签页）"),
    hostname: z.string().optional().describe("目标 hostname（在该域名的标签页上执行）"),
    key: z.string().describe("按键名（enter/tab/escape/backspace/delete/arrowup/arrowdown/arrowleft/arrowright/home/end/pageup/pagedown/space）"),
    selector: z.string().optional().describe("可选：先真实点击聚焦该元素再按键"),
    index: z.number().int().min(0).optional().describe("selector 命中多个时聚焦第几个（默认 0）")
  },
  async ({ key, selector, index = 0, tab_id: tabId, hostname }) => {
    try {
      const result = await sendToBrowser("REAL_KEY", { key, selector, index, tabId, hostname }, 15000);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 1) }] };
    } catch (error: any) {
      return { content: [{ type: "text", text: `真实按键失败: ${error.message}` }], isError: true };
    }
  }
);
// 88. 真实悬停（CDP）
server.tool(
  "real_hover",
  "真实悬停在页面元素上（CDP isTrusted=true，触发 hover 菜单/提示）；支持 text= 语法。返回值含命中元素摘要（element.text）；warning（多命中）/ hoverWillMissWarning（候选点全灭）/ clickPointNote（自动换点）/ outOfViewportWarning（视口外）/ emptyPointWarning（坐标点空白）任一出现即可能悬停到错误元素（如挂错菜单），先核对",
  {
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用活动标签页）"),
    hostname: z.string().optional().describe("目标 hostname（在该域名的标签页上执行）"),
    selector: z.string().optional().describe("CSS 选择器，或 text= 语法"),
    x: z.number().optional().describe("视口坐标 x"),
    y: z.number().optional().describe("视口坐标 y"),
    index: z.number().int().min(0).optional().describe("选择器命中多个时取第几个（默认 0）"),
    wait: z.number().min(0).optional().describe("等待元素出现超时毫秒（默认 3000；传 0 或负数会回落为 1000ms 而非\"不等待\"）")
  },
  async ({ selector, x, y, index = 0, wait = 3000, tab_id: tabId, hostname }) => {
    try {
      const result = await sendToBrowser("REAL_HOVER", { selector, x, y, index, wait, tabId, hostname }, 15000 + (wait || 3000));
      return { content: [{ type: "text", text: JSON.stringify(result, null, 1) }] };
    } catch (error: any) {
      return { content: [{ type: "text", text: `真实悬停失败: ${error.message}` }], isError: true };
    }
  }
);
// 89. 真实拖拽（CDP 鼠标级，isTrusted=true）——滑块验证码 / rc-slider / 拖拽排序
server.tool(
  "real_drag",
  "真实鼠标拖拽（chrome.debugger CDP 级输入，isTrusted=true）：按下 → 带拟人轨迹移动 → 释放。**专门补上滑块验证码（rc-slider-captcha / 极验拖动 / 阿里滑块）这类像素级拖拽能力**——合成 DOM 事件（dispatchEvent）的 isTrusted=false，滑块普遍检测这个。起点用 selector 或 x/y；**终点三选一、只能给一种**（混用会被拒绝）：`to_selector`（拖到元素中心；解析它会滚动页面，V4.9.40 起自动用元素文档坐标校正起点并在返回体标 scrollAdjusted）/ `to_x`+`to_y`（绝对视口坐标，必须成对）/ `dx`(+`dy`)（相对起点偏移，**滑块最常用：dx = 缺口X - 滑块X**）。轨迹默认 human 缓动（慢起-加速-减速停）+ 正态抖动（默认 1.5px，**逐点衰减**——越接近终点越稳）+ **每步间隔 ±30% 随机化**（总时长仍按 duration_ms；被节流的标签会自动截断并返回 trajectoryTruncated）——直线匀速是最容易被判定为机器人的特征。【工作流】先 take_screenshot 看缺口位置（或 get_element_info 拿滑块 box），算出 dx 再调本工具；返回含 from/to/distance/trajectory/elapsedMs/tabActive 与 actionVerify（是否触发导航/对话框）+ afterRequests（动作后新请求摘要）。【证据边界】success=true 只代表鼠标序列已送达≠验证已通过（验证结果看页面反馈——通常还有一次 verify 接口，用 get_network_requests 查）；拖到一半超时可能已移动（勿盲目重试）；被节流的标签 CDP 输入会被静默吞掉（先把标签激活/窗口前台）；纯坐标起点 + to_selector 会被明确拒绝（滚动后坐标无法校正）",
  {
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用活动标签页）"),
    hostname: z.string().optional().describe("目标 hostname（在该域名的标签页上执行）"),
    selector: z.string().optional().describe("起点元素选择器（或 text= 语法）；与 x/y 二选一"),
    x: z.number().optional().describe("起点视口坐标 x（与 y 一起用）"),
    y: z.number().optional().describe("起点视口坐标 y"),
    to_selector: z.string().optional().describe("终点元素选择器（拖到其中心）"),
    to_x: z.number().optional().describe("终点绝对视口坐标 x（需与 to_y 一起）"),
    to_y: z.number().optional().describe("终点绝对视口坐标 y"),
    dx: z.number().optional().describe("终点相对起点的水平偏移（滑块最常用：缺口X - 滑块X；为正表示向右）"),
    dy: z.number().optional().describe("终点相对起点的垂直偏移（滑块通常为 0 或极小）"),
    steps: z.number().int().min(1).max(200).optional().describe("轨迹中间点数（默认 24；越多越平滑、越慢）"),
    duration_ms: z.number().min(0).max(10000).optional().describe("拖拽总时长毫秒（默认 800；真人约 500~1500，太快易被判定机器人）"),
    easing: z.enum(["human", "linear", "easeOut"]).optional().describe("速度曲线（默认 human=慢起-加速-减速停；linear 仅在目标站点不校验轨迹时用）"),
    jitter: z.number().min(0).max(20).optional().describe("轨迹抖动像素（默认 1.5，0=无抖动；拟人关键参数，但仍要逐点衰减）"),
    button: z.enum(["left", "right", "middle"]).optional().describe("鼠标键（默认 left）"),
    wait: z.number().min(0).optional().describe("等待起点元素出现超时毫秒（默认 3000）"),
    index: z.number().int().min(0).optional().describe("起点选择器命中多个时取第几个（默认 0）"),
    hold_before_release_ms: z.number().min(0).max(5000).optional().describe("到达终点后停留多久再松手（默认 0；部分滑块需要停留才能判定）"),
    on_dialog: z.enum(["accept", "dismiss"]).optional().describe("拖拽触发 JS 对话框时的会话内处理策略（同 real_click）")
  },
  async ({ selector, x, y, to_selector: toSelector, to_x: toX, to_y: toY, dx, dy, steps = 24, duration_ms: durationMs = 800, easing = "human", jitter = 1.5, button = "left", wait = 3000, index = 0, hold_before_release_ms: holdBeforeReleaseMs = 0, on_dialog: onDialog, tab_id: tabId, hostname }) => {
    try {
      // V4.9.39 实测：被节流的标签会让每步 setTimeout 被拉长（600ms 轨迹跑成 23s）——
      // 客户端有"硬期限跳终点"保护，服务端超时也必须覆盖该期限，否则会先超时、
      // 让 AI 拿到"超时≠未发生"却看不到截断警告。
      const dragTimeout = 30000 + (wait || 3000) + Math.max(5000, (durationMs || 800) * 3 + 3000) + steps * 20;
      const result = await sendToBrowser("REAL_DRAG", { selector, x, y, toSelector, toX, toY, dx, dy, steps, durationMs, easing, jitter, button, wait, index, holdBeforeReleaseMs, onDialog, tabId, hostname }, dragTimeout);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 1) }] };
    } catch (error: any) {
      return { content: [{ type: "text", text: `真实拖拽失败: ${error.message}` }], isError: true };
    }
  }
);
// 90. 低层鼠标原语（滑块分步调试）
server.tool(
  "mouse_control",
  "低层鼠标原语（CDP isTrusted=true）：move / down / up / drag 分别发送。**用于需要精细控制的场景**——例如滑块验证码：先 `down` 按住滑块，`move` 观察页面反馈（可多次微调），最后 `up` 释放；或一次 `drag` 完成坐标级拖拽（不做元素解析）。与 real_drag 的分工：real_drag 是「一键完成 + 元素定位 + 动作后验证」，本工具是「手动分步、完全按坐标」。【证据边界】down 之后若页面重载/崩溃，按下状态可能丢失（重新 down 即可）；move/up 的坐标是视口坐标，视口外无效",
  {
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用活动标签页）"),
    hostname: z.string().optional().describe("目标 hostname（在该域名的标签页上执行）"),
    action: z.enum(["move", "down", "up", "drag"]).describe("动作：move=移动 / down=按下 / up=释放 / drag=一次完成按下+拟人移动+释放（drag 需 to_x/to_y）"),
    x: z.number().optional().describe("当前坐标 x（move/down/up 的目标点；drag 的起点）"),
    y: z.number().optional().describe("当前坐标 y"),
    to_x: z.number().optional().describe("drag 的终点 x"),
    to_y: z.number().optional().describe("drag 的终点 y"),
    steps: z.number().int().min(1).max(200).optional().describe("drag 的轨迹点数（默认 24）"),
    duration_ms: z.number().min(0).max(10000).optional().describe("drag 的总时长毫秒（默认 800）"),
    easing: z.enum(["human", "linear", "easeOut"]).optional().describe("drag 的速度曲线（默认 human）"),
    jitter: z.number().min(0).max(20).optional().describe("drag 的轨迹抖动像素（默认 1.5）"),
    button: z.enum(["left", "right", "middle"]).optional().describe("鼠标键（默认 left）"),
    click_count: z.number().int().min(1).max(3).optional().describe("按下/松开时的 clickCount（默认 1；双击拖拽场景可传 2）")
  },
  async ({ action, x, y, to_x: toX, to_y: toY, steps = 24, duration_ms: durationMs = 800, easing = "human", jitter = 1.5, button = "left", click_count: clickCount = 1, tab_id: tabId, hostname }) => {
    try {
      const result = await sendToBrowser("MOUSE_CONTROL", { action, x, y, toX, toY, steps, durationMs, easing, jitter, button, clickCount, tabId, hostname }, 20000 + (durationMs || 800) + steps * 20);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 1) }] };
    } catch (error: any) {
      return { content: [{ type: "text", text: `鼠标原语失败: ${error.message}` }], isError: true };
    }
  }
);
// 91. 新建标签页（多标签并行测试 / 需要干净页面时）
server.tool(
  "new_tab",
  "新建标签页并可选打开 URL（默认后台打开 active=false，**不抢用户焦点**）。用途：多标签并行测试、拖拽/滑块类验证需要干净页面、避免改动用户正在用的标签。【证据边界】返回 tabId 供后续工具显式指定；页面加载是异步的——紧接着操作前先 get_page_info 或 wait_for_selector 确认已就绪",
  {
    url: z.string().describe("要打开的 URL（http(s):// 或 file://；**必填**——V4.9.40 起 about:blank 被拒绝：它不会被页面工具接管且无法自动关闭）"),
    active: z.boolean().optional().describe("是否前台激活（默认 false=后台开，不抢焦点）")
  },
  async ({ url, active = false }) => {
    try {
      const result = await sendToBrowser("NEW_TAB", { url, active }, 15000);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 1) }] };
    } catch (error: any) {
      return { content: [{ type: "text", text: `新建标签失败: ${error.message}` }], isError: true };
    }
  }
);
// 92. 标签页管理（V4.9.41，对齐 chrome-devtools 的 list/select/close_page）
server.tool(
  "tab_manage",
  "标签页管理：action=list（列出全部标签，含 tabId/url/title/active）/ select（切换激活）/ close（关闭）。**V4.9.41 新增**——此前只能 new_tab，测试完的标签关不掉、多标签测试看不到全貌。select/close 用 tabId 或 index（list 返回的顺序下标）",
  {
    action: z.enum(["list", "select", "close"]).describe("list=列出 / select=切换激活 / close=关闭"),
    tab_id: z.number().int().optional().describe("目标标签页 ID（select/close 用；与 index 二选一）"),
    index: z.number().int().min(0).optional().describe("list 结果里的下标（select/close 用；与 tab_id 二选一）")
  },
  async ({ action, tab_id: tabId, index }) => {
    try {
      const result = await sendToBrowser("TAB_MANAGE", { action, tabId, index }, 15000);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 1) }] };
    } catch (error: any) {
      return { content: [{ type: "text", text: `标签管理失败: ${error.message}` }], isError: true };
    }
  }
);
// 93. 文件上传（V4.9.41，对齐 chrome-devtools 的 upload_file）
server.tool(
  "upload_file",
  "把本地文件注入 input[type=file]（CDP `DOM.setFileInputFiles`，真实文件注入——走 DOM 层，不需要用户手势）。**上传点测试第一步**：图片马/后缀绕过/.htaccess 等场景先把文件塞进 input，再用 real_click 点上传按钮、get_network_requests 看服务端响应。files 支持单个路径或数组（多文件上传）。【证据边界】注入后 Chrome 会派发 input/change；若页面用自定义上传组件（非原生 input），可能不触发其逻辑——此时改用 execute_script 直接调组件方法，或 real_click 后观察",
  {
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用活动标签页）"),
    hostname: z.string().optional().describe("目标 hostname（在该域名的标签页上执行）"),
    selector: z.string().describe("文件输入框选择器（如 input[type=file]；隐藏的 input 也能注入）"),
    files: z.array(z.string()).describe("本地文件绝对路径（单个或多个）")
  },
  async ({ selector, files, tab_id: tabId, hostname }) => {
    try {
      // V4.9.42（独立验收 Y2）：服务端先校验文件存在且是普通文件。
      // 不校验的后果（验收实测）：不存在的路径/目录/相对路径都会 success:true，而 CDP 造出的是
      // **size:0 的 File**——AI 会把"服务端拒收 0 字节"误判成 WAF/上传校验，方向从一开始就错。
      const bad: string[] = [];
      for (const f of files) {
        try {
          const st = fs.statSync(f);
          if (!st.isFile()) bad.push(`${f}（不是普通文件）`);
        } catch (e: any) {
          bad.push(`${f}（${e && e.code === "ENOENT" ? "不存在" : (e && e.message) || e}）`);
        }
      }
      if (bad.length) {
        return {
          content: [{ type: "text", text: `文件校验失败（未发起注入）：\n${bad.join("\n")}\n\n请传**本地绝对路径**且文件存在（Windows 例：D:\\\\work\\\\shell\\\\1.jsp）` }],
          isError: true
        };
      }
      const result = await sendToBrowser("UPLOAD_FILE", { selector, files, tabId, hostname }, 20000);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 1) }] };
    } catch (error: any) {
      return { content: [{ type: "text", text: `文件上传失败: ${error.message}` }], isError: true };
    }
  }
);
// 94. 环境模拟（V4.9.41，对齐 chrome-devtools 的 emulate + resize_page）
server.tool(
  "emulate",
  "环境模拟（CDP Emulation/Network 域）：视口尺寸/设备像素比/移动端、User-Agent/平台/语言、时区、地理位置、网络限速/离线。**V4.9.41 新增**——渗透用途：弱网测试、移动端 UA 绕过、响应式布局、地理位置相关逻辑。模拟只对当前标签生效；`reset=true` 一键清除全部模拟",
  {
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用活动标签页）"),
    hostname: z.string().optional().describe("目标 hostname（在该域名的标签页上执行）"),
    width: z.number().int().min(1).optional().describe("视口宽（CSS 像素）"),
    height: z.number().int().min(1).optional().describe("视口高（CSS 像素）"),
    deviceScaleFactor: z.number().min(0.1).optional().describe("设备像素比（默认 1；移动端模拟常用 2/3）"),
    mobile: z.boolean().optional().describe("是否模拟移动端（影响 viewport meta 行为）"),
    userAgent: z.string().optional().describe("User-Agent 字符串（传空串以外的值即生效）"),
    platform: z.string().optional().describe("navigator.platform（如 Win32 / iPhone）"),
    acceptLanguage: z.string().optional().describe("Accept-Language（如 zh-CN,zh;q=0.9）"),
    timezone: z.string().optional().describe("时区 ID（如 Asia/Shanghai / America/New_York）"),
    latitude: z.number().min(-90).max(90).optional().describe("地理纬度（与 longitude 一起用）"),
    longitude: z.number().min(-180).max(180).optional().describe("地理经度"),
    accuracy: z.number().min(0).optional().describe("地理精度（米，默认 100）"),
    offline: z.boolean().optional().describe("是否离线"),
    latency: z.number().min(0).optional().describe("网络延迟毫秒（如 500 模拟弱网）"),
    downloadThroughput: z.number().optional().describe("下载吞吐（字节/秒；-1 表示不限速）"),
    uploadThroughput: z.number().optional().describe("上传吞吐（字节/秒；-1 表示不限速）"),
    reset: z.boolean().optional().describe("是否清除全部模拟（true 时忽略其它参数）")
  },
  async ({ width, height, deviceScaleFactor, mobile, userAgent, platform, acceptLanguage, timezone, latitude, longitude, accuracy, offline, latency, downloadThroughput, uploadThroughput, reset, tab_id: tabId, hostname }) => {
    try {
      const result = await sendToBrowser("EMULATE", {
        width, height, deviceScaleFactor, mobile, userAgent, platform, acceptLanguage,
        timezone, latitude, longitude, accuracy, offline, latency, downloadThroughput, uploadThroughput, reset, tabId, hostname
      }, 20000);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 1) }] };
    } catch (error: any) {
      return { content: [{ type: "text", text: `环境模拟失败: ${error.message}` }], isError: true };
    }
  }
);
// 95. 页面 console 全量（V4.9.41，对齐 chrome-devtools 的 list_console_messages）
server.tool(
  "console_log",
  "页面 console 全量捕获：action=start（安装捕获器）/ read（读日志，默认）/ clear（清空）。**V4.9.41 新增**——与 get_console_messages（hook 桥，只含命中关键词且 ≤4000 字符）互补，本工具是全量（level/时间戳/消息）。【证据边界】注入时刻**之前**的 console 日志拿不到（浏览器协议限制，DevTools 同样如此）——要看完整早期日志：先 action=start，再刷新页面。read 时若未安装会自动安装（从此刻开始捕获）",
  {
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用活动标签页）"),
    hostname: z.string().optional().describe("目标 hostname（在该域名的标签页上执行）"),
    action: z.enum(["start", "read", "clear"]).optional().describe("start=安装捕获器 / read=读日志（默认）/ clear=清空"),
    limit: z.number().int().min(1).max(1000).optional().describe("read 返回最近多少条（默认 200，上限 1000）")
  },
  async ({ action = "read", limit = 200, tab_id: tabId, hostname }) => {
    try {
      const result = await sendToBrowser("CONSOLE_LOG", { action, limit, tabId, hostname }, 15000);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 1) }] };
    } catch (error: any) {
      return { content: [{ type: "text", text: `console 读取失败: ${error.message}` }], isError: true };
    }
  }
);
// 89. 处理 JavaScript 对话框（2026-10-13 审计 M5：探针能报 dialogOpened，需配套的处理手段）
server.tool(
  "handle_dialog",
  "处理页面弹出的 JavaScript 对话框（alert/confirm/prompt）——对话框会阻塞页面渲染进程（防调试 alert/confirm 常见），阻塞期间注入/截图/点击全部无效；real_click 返回 actionVerify.dialogOpened 或后续操作莫名无响应时用它逃生",
  {
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用活动标签页）"),
    hostname: z.string().optional().describe("目标 hostname（在该域名的标签页上执行）"),
    accept: z.boolean().optional().describe("true=确认（点确定）/ false=取消（点取消），默认 true"),
    promptText: z.string().optional().describe("prompt 对话框的输入文本（仅对 prompt 有效）")
  },
  async ({ accept = true, promptText, tab_id: tabId, hostname }) => {
    try {
      const result = await sendToBrowser("HANDLE_DIALOG", { accept, promptText, tabId, hostname }, 15000);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 1) }] };
    } catch (error: any) {
      return { content: [{ type: "text", text: `处理对话框失败: ${error.message}` }], isError: true };
    }
  }
);
// 90. a11y 树快照（带 ref 元素引用）
server.tool(
  "take_a11y_snapshot",
  "获取页面无障碍（a11y）树快照——每个可交互/有语义的元素带 ref 编号（如 uid=2_5），之后用 real_click / click_element 的 ref 参数精确操作：**无选择器歧义、无遮挡问题，是元素定位最可靠的方式**（AI 先快照拿 ref → 再用 ref 操作；**覆盖边界**：只含 a11y 认定的可交互/有语义节点——<div onclick> 等无 role/name 的元素没有 uid，此时回退 selector/text=）。同一页面内 ref 跨多次快照稳定（可多轮引用）；页面导航/刷新后旧 ref 失效（操作时会明确报错，重新快照即可）。输出为缩进文本树：uid + role + \"名称\" + 关键状态（checked/disabled/expanded 等）",
  {
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用活动标签页）"),
    hostname: z.string().optional().describe("目标 hostname（在该域名的标签页上执行）"),
    filter: z.string().optional().describe("只保留 role 或名称包含该关键词的节点（收窄输出，如 filter=button）"),
    limit: z.number().int().min(1).max(500).optional().describe("最多输出节点数（默认 200，防超大页面打爆上下文）")
  },
  async ({ filter = '', limit = 200, tab_id: tabId, hostname }) => {
    try {
      const result = await sendToBrowser("TAKE_A11Y_SNAPSHOT", { filter, limit, tabId, hostname }, 20000);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 1) }] };
    } catch (error: any) {
      return { content: [{ type: "text", text: `a11y 快照失败: ${error.message}` }], isError: true };
    }
  }
);
// 91. 重载扩展自身
server.tool(
  "reload_extension",
  "重载浏览器扩展（chrome.runtime.reload）——扩展侧代码改动后无需手动到 chrome://extensions 刷新。扩展会先返回本响应、约 0.8 秒后重载（WS 短暂中断后自动重连）。注意：重载清空扩展内存态（a11y ref 表/缓存等），页面内已注入脚本不受影响",
  {},
  async () => {
    try {
      const result = await sendToBrowser("RELOAD_EXTENSION", {}, 10000);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 1) }] };
    } catch (error: any) {
      // 扩展重载瞬间 WS 断开，响应可能丢失——这不是失败
      return { content: [{ type: "text", text: `重载指令已发出（响应丢失属正常：扩展正在重启）。${error.message}` }] };
    }
  }
);
// 18. 点击元素
server.tool(
  "click_element",
  "点击页面元素（合成 click 事件直达元素，不依赖坐标——元素被浮层遮挡也能点到）。支持 ref（a11y 快照引用，最可靠）/ CSS 选择器 / text= 文本定位；返回体含 text（实际命中元素文本）、matchedCount（命中总数）与 domMutations（点击引发的 DOM 变化数，0 = 页面无反应；写操作后建议读回验证页面状态）。命中多个时务必核对 text 并用 index 指定第 N 个（选择器歧义是点错元素的头号原因）。合成事件不触发 isTrusted 校验，个别防作弊页面会忽略",
  {
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用活动标签页）"),
    hostname: z.string().optional().describe("目标 hostname（在该域名的标签页上执行）"),
    ref: z.string().optional().describe("a11y 快照元素引用（如 \"2_5\"，来自 take_a11y_snapshot 的 uid=）——无选择器歧义，优先于 selector/坐标。注意覆盖边界：ref 只含 a11y 认定的可交互/有语义节点，<div onclick> 等无 role/name 的元素没有 uid（需回退 selector/text=）"),
    selector: z.string().optional().describe("CSS选择器"),
    x: z.number().optional().describe("X坐标"),
    y: z.number().optional().describe("Y坐标"),
    index: z.number().int().min(0).optional().describe("选择器命中多个时取第几个（默认 0）"),
    dblClick: z.boolean().optional().describe("是否双击"),
    on_dialog: z.enum(["accept", "dismiss"]).optional().describe("点击触发 JS 对话框（alert/confirm）时的**会话内**处理策略：accept=确认 / dismiss=取消；省略=仅报告不处理（会话结束后浏览器按取消处置）。对话框只与弹框时的会话关联——事后用 handle_dialog 接管不了（2026-10-13 实测）")
  },
  async ({ ref, selector, x, y, index = 0, dblClick = false, on_dialog: onDialog, tab_id: tabId, hostname }) => {
    try {
      const result = await sendToBrowser("CLICK_ELEMENT", { ref, selector, x, y, index, dblClick, onDialog, tabId, hostname });
      // N1（2026-10-13 审计）：client 定位失败是**返回** {error} 而非抛错——此处对 AI 置 isError，
      // 否则只看 isError 标记的调用方会把"选择器没命中"当成功漏读
      const isErr = !!(result && result.error);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }],
        ...(isErr ? { isError: true } : {})
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `点击失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);
// 19. 填充输入框
server.tool(
  "fill_input",
  "在输入框中填充文本",
  {
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用活动标签页）"),
    hostname: z.string().optional().describe("目标 hostname（在该域名的标签页上执行）"),
    selector: z.string().describe("输入框的CSS选择器"),
    value: z.string().describe("要填充的值"),
    clear: z.boolean().optional().describe("是否先清空（默认true）")
  },
  async ({ selector, value, clear = true, tab_id: tabId, hostname }) => {
    try {
      const result = await sendToBrowser("FILL_INPUT", { selector, value, clear, tabId, hostname });
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
          text: `填充失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);
// 20. 按键
server.tool(
  "press_key",
  "模拟按键操作",
  {
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用活动标签页）"),
    hostname: z.string().optional().describe("目标 hostname（在该域名的标签页上执行）"),
    key: z.string().describe("按键（如 Enter, Tab, Escape, ArrowDown 等）"),
    modifiers: z.array(z.enum(["Control", "Ctrl", "Shift", "Alt", "Meta", "Command"])).optional().describe("修饰键")
  },
  async ({ key, modifiers = [], tab_id: tabId, hostname }) => {
    try {
      const result = await sendToBrowser("PRESS_KEY", { key, modifiers, tabId, hostname });
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
          text: `按键失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);
// 22. 滚动页面
server.tool(
  "scroll_page",
  "滚动页面到指定位置或元素",
  {
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用活动标签页）"),
    hostname: z.string().optional().describe("目标 hostname（在该域名的标签页上执行）"),
    x: z.number().optional().describe("水平滚动位置"),
    y: z.number().optional().describe("垂直滚动位置"),
    selector: z.string().optional().describe("滚动到指定元素"),
    behavior: z.enum(["smooth", "instant", "auto"]).optional().describe("滚动行为")
  },
  async ({ x = 0, y = 0, selector, behavior = "smooth", tab_id: tabId, hostname }) => {
    try {
      const result = await sendToBrowser("SCROLL_PAGE", { x, y, selector, behavior, tabId, hostname });
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
          text: `滚动失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);
// 23. 等待条件（选择器或文本）
server.tool(
  "wait_for_selector",
  "等待页面满足条件（V4.9.41：selector 与 text 二选一）——等元素出现/可见，或等页面文本出现。text 模式用于等「加载中消失后出现 xxx」「登录成功后出现工作台」这类无稳定选择器的场景",
  {
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用活动标签页）"),
    hostname: z.string().optional().describe("目标 hostname（在该域名的标签页上执行）"),
    selector: z.string().optional().describe("CSS 选择器（与 text 二选一）"),
    text: z.string().optional().describe("等待页面 innerText 出现该文本（与 selector 二选一）"),
    timeout: z.number().optional().describe("超时时间（毫秒），默认5000"),
    visible: z.boolean().optional().describe("是否要求元素可见（仅 selector 模式）")
  },
  async ({ selector, text, timeout = 5000, visible = true, tab_id: tabId, hostname }) => {
    try {
      const result = await sendToBrowser("WAIT_FOR_SELECTOR", { selector, text, timeout, visible, tabId, hostname });
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
          text: `等待失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);
// 24. 获取元素信息
server.tool(
  "get_element_info",
  "获取页面元素的详细信息",
  {
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用活动标签页）"),
    hostname: z.string().optional().describe("目标 hostname（在该域名的标签页上执行）"),
    selector: z.string().describe("CSS选择器")
  },
  async ({ selector, tab_id: tabId, hostname }) => {
    try {
      const info = await sendToBrowser("GET_ELEMENT_INFO", { selector, tabId, hostname });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(info, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `获取元素信息失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);
// 13. 获取DOM元素信息
server.tool(
  "get_dom_info",
  "获取页面DOM结构信息。默认活动标签页；可传 tab_id/hostname 指定目标",
  {
    selector: z.string().optional().describe("CSS选择器，不填则获取body"),
    depth: z.number().optional().describe("遍历深度，默认3"),
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用活动标签页）"),
    hostname: z.string().optional().describe("按域名定位目标标签页（如 example.com）")
  },
  async ({ selector = "body", depth = 3, tab_id: tabId, hostname }) => {
    try {
      const domInfo = await sendToBrowser("GET_DOM_INFO", { selector, depth, tabId, hostname });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(domInfo, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `获取DOM信息失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);
// 42. 自动填充表单
server.tool(
  "auto_fill_form",
  "自动填充指定表单的输入框",
  {
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用活动标签页）"),
    hostname: z.string().optional().describe("目标 hostname（在该域名的标签页上执行）"),
    formIndex: z.number().optional().describe("表单索引，默认0"),
    values: z.record(z.string()).describe("要填充的值，格式: {选择器: 值}")
  },
  async ({ formIndex = 0, values, tab_id: tabId, hostname }) => {
    try {
      const result = await sendToBrowser("AUTO_FILL_FORM", { formIndex, values, tabId, hostname });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `填充失败: ${error.message}` }],
        isError: true
      };
    }
  }
);

// ============== 智能化功能：WebSocket监控 ==============
// 45. 提取页面数据
server.tool(
  "extract_page_data",
  "根据选择器提取页面结构化数据",
  {
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用活动标签页）"),
    hostname: z.string().optional().describe("目标 hostname（在该域名的标签页上执行）"),
    selectors: z.record(z.string()).describe("选择器映射，格式: {名称: CSS选择器}")
  },
  async ({ selectors, tab_id: tabId, hostname }) => {
    try {
      const result = await sendToBrowser("EXTRACT_PAGE_DATA", { selectors, tabId, hostname });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `提取失败: ${error.message}` }],
        isError: true
      };
    }
  }
);

// ============== 综合功能：一键分析页面 ==============
// 8. 导航到指定URL
server.tool(
  "navigate_to",
  "导航到指定 URL / 路由，或执行浏览器历史导航（V4.9.41 扩展：action=url/back/forward/reload，对齐 chrome-devtools 的 navigate_page）",
  {
    action: z.enum(["url", "back", "forward", "reload"]).optional().describe("导航动作：url=打开 URL（默认）/ back=后退 / forward=前进 / reload=刷新"),
    url: z.string().optional().describe("目标URL或路由路径（action=url 时必填）"),
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用活动标签页）"),
    hostname: z.string().optional().describe("按域名定位目标标签页（如 example.com）")
  },
  async ({ action = "url", url, tab_id: tabId, hostname }) => {
    try {
      const result = await sendToBrowser("NAVIGATE_TO", { action, url, tabId, hostname });
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
          text: `导航失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);
// 16. 刷新页面
server.tool(
  "refresh_page",
  "刷新页面。默认活动标签页；可传 tab_id/hostname 指定目标",
  {
    hardRefresh: z.boolean().optional().describe("是否强制刷新（清除缓存）"),
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用活动标签页）"),
    hostname: z.string().optional().describe("按域名定位目标标签页（如 example.com）")
  },
  async ({ hardRefresh = false, tab_id: tabId, hostname }) => {
    try {
      await sendToBrowser("REFRESH_PAGE", { hardRefresh, tabId, hostname });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            message: hardRefresh ? "页面已强制刷新" : "页面已刷新"
          }, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `刷新页面失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// ============== 新增：浏览器控制功能 ==============
// 9. 获取Cookie
server.tool(
  "get_cookies",
  "获取当前页面的Cookie（含 httpOnly Cookie，通过 chrome.cookies API）。支持输出 json / curl / burp / cookie-header 格式，方便给 Burp/Yakit 重放或做 auth_diff。",
  {
    name: z.string().optional().describe("Cookie名称过滤"),
    httpOnly: z.boolean().optional().describe("仅返回 httpOnly Cookie（登录态核心，document.cookie 拿不到），默认false"),
    format: z.enum(["json", "curl", "burp", "cookie-header"]).optional().describe("输出格式：json=完整字段；curl=curl -H 'Cookie:...'；burp=Burp 请求头复制；cookie-header=纯 Cookie 头值。默认json"),
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用活动标签页）"),
    hostname: z.string().optional().describe("目标 hostname（在该域名的标签页上执行）")
  },
  async ({ name, httpOnly = false, format = "json", tab_id: tabId, hostname }) => {
    try {
      const cookies = await sendToBrowser("GET_COOKIES", { name, httpOnly, tabId, hostname });

      if (format === "json" || !Array.isArray(cookies)) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify(cookies, null, 2)
          }]
        };
      }

      // 生成 Cookie 头字符串
      const cookieHeader = cookies
        .map(c => `${c.name}=${c.value}`)
        .join('; ');

      let output = "";
      if (format === "cookie-header") {
        output = cookieHeader;
      } else if (format === "curl") {
        output = `curl -H 'Cookie: ${cookieHeader.replace(/'/g, "'\\''")}' <URL>`;
      } else if (format === "burp") {
        output = `Cookie: ${cookieHeader}`;
      }

      return {
        content: [{
          type: "text",
          text: output
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `获取Cookie失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);
// 57. 获取请求头配置
server.tool(
  "get_headers_config",
  "获取当前所有请求头组和请求头的配置信息",
  {},
  async () => {
    try {
      const result = await sendToBrowser("GET_HEADERS_CONFIG", {});
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `获取请求头配置失败: ${error.message}` }],
        isError: true
      };
    }
  }
);
// 61. 添加请求头
server.tool(
  "add_header",
  "向指定请求头组添加一个请求头",
  {
    groupId: z.string().describe("请求头组ID"),
    name: z.string().describe("请求头名称（如 Authorization, X-Token 等）"),
    value: z.string().describe("请求头值"),
    enabled: z.boolean().optional().describe("是否启用，默认true")
  },
  async ({ groupId, name, value, enabled = true }) => {
    try {
      const result = await sendToBrowser("ADD_HEADER", { groupId, name, value, enabled });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `添加请求头失败: ${error.message}` }],
        isError: true
      };
    }
  }
);
// 63. 删除请求头
server.tool(
  "delete_header",
  "从请求头组中删除指定的请求头",
  {
    groupId: z.string().describe("请求头组ID"),
    headerId: z.string().describe("请求头ID")
  },
  async ({ groupId, headerId }) => {
    try {
      const result = await sendToBrowser("DELETE_HEADER", { groupId, headerId });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `删除请求头失败: ${error.message}` }],
        isError: true
      };
    }
  }
);
// 64. 切换请求头启用状态
server.tool(
  "toggle_header",
  "启用或禁用指定的请求头",
  {
    groupId: z.string().describe("请求头组ID"),
    headerId: z.string().describe("请求头ID"),
    enabled: z.boolean().describe("是否启用")
  },
  async ({ groupId, headerId, enabled }) => {
    try {
      const result = await sendToBrowser("TOGGLE_HEADER", { groupId, headerId, enabled });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `切换请求头状态失败: ${error.message}` }],
        isError: true
      };
    }
  }
);
// 65. 批量更新请求头
server.tool(
  "batch_update_headers",
  "批量更新请求头组中的所有请求头（替换原有请求头）",
  {
    groupId: z.string().describe("请求头组ID"),
    headers: z.array(z.object({
      id: z.string().optional().describe("请求头ID（可选，不传则生成新ID）"),
      name: z.string().describe("请求头名称"),
      value: z.string().describe("请求头值"),
      enabled: z.boolean().optional().describe("是否启用，默认true")
    })).describe("请求头列表")
  },
  async ({ groupId, headers }) => {
    try {
      const result = await sendToBrowser("BATCH_UPDATE_HEADERS", { groupId, headers });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `批量更新请求头失败: ${error.message}` }],
        isError: true
      };
    }
  }
);
// 58. 创建请求头组
server.tool(
  "create_header_group",
  "创建一个新的请求头组。**作用域**：`target_domains` 省略 = **全站注入**（该组所有头会随请求发往**所有**站点——含 Authorization/Cookie 这类凭据头，务必想清楚再用）；传了就只对这些域生效",
  {
    name: z.string().describe("请求头组名称"),
    headers: z.array(z.object({
      name: z.string().describe("请求头名称"),
      value: z.string().describe("请求头值"),
      enabled: z.boolean().optional().describe("是否启用，默认true")
    })).optional().describe("初始请求头列表"),
    target_domains: z.array(z.string()).optional().describe("作用域：只对这些域（**含其所有子域**）注入——如 ['example.com'] 会同时命中 api.example.com。省略 = 全站注入")
  },
  async ({ name, headers = [], target_domains: targetDomains }) => {
    try {
      const result = await sendToBrowser("CREATE_HEADER_GROUP", { name, headers, targetDomains });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `创建请求头组失败: ${error.message}` }],
        isError: true
      };
    }
  }
);
// 59. 删除请求头组
server.tool(
  "delete_header_group",
  "删除指定的请求头组",
  {
    groupId: z.string().describe("请求头组ID")
  },
  async ({ groupId }) => {
    try {
      const result = await sendToBrowser("DELETE_HEADER_GROUP", { groupId });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `删除请求头组失败: ${error.message}` }],
        isError: true
      };
    }
  }
);
// 60. 切换当前请求头组
server.tool(
  "switch_header_group",
  "切换到指定的请求头组（启用该组的请求头），传空字符串禁用所有请求头",
  {
    groupId: z.string().describe("请求头组ID，传空字符串禁用所有请求头")
  },
  async ({ groupId }) => {
    try {
      const result = await sendToBrowser("SWITCH_HEADER_GROUP", { groupId: groupId || null });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `切换请求头组失败: ${error.message}` }],
        isError: true
      };
    }
  }
);
// 62. 更新请求头
server.tool(
  "update_header",
  "更新指定请求头的名称、值或启用状态",
  {
    groupId: z.string().describe("请求头组ID"),
    headerId: z.string().describe("请求头ID"),
    name: z.string().optional().describe("新的请求头名称"),
    value: z.string().optional().describe("新的请求头值"),
    enabled: z.boolean().optional().describe("是否启用")
  },
  async ({ groupId, headerId, name, value, enabled }) => {
    try {
      const result = await sendToBrowser("UPDATE_HEADER", { groupId, headerId, name, value, enabled });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `更新请求头失败: ${error.message}` }],
        isError: true
      };
    }
  }
);
// 66. 快速设置请求头（创建组+添加请求头+启用）
server.tool(
  "quick_set_headers",
  "快速设置请求头：创建新组并添加请求头，然后立即启用该组。**作用域**：`target_domains` 省略 = **全站注入**（含凭据头时会发往所有站点），建议测试类改包一律传目标域",
  {
    groupName: z.string().describe("请求头组名称"),
    headers: z.array(z.object({
      name: z.string().describe("请求头名称"),
      value: z.string().describe("请求头值")
    })).describe("请求头列表"),
    target_domains: z.array(z.string()).optional().describe("作用域：只对这些域（**含其所有子域**）注入。省略 = 全站注入")
  },
  async ({ groupName, headers, target_domains: targetDomains }) => {
    try {
      // 1. 创建新组
      const createResult = await sendToBrowser("CREATE_HEADER_GROUP", {
        name: groupName,
        headers: headers.map(h => ({ ...h, enabled: true })),
        targetDomains
      });
      
      if (!createResult.success) {
        throw new Error("创建请求头组失败");
      }
      
      // 2. 切换到该组
      const switchResult = await sendToBrowser("SWITCH_HEADER_GROUP", { 
        groupId: createResult.groupId 
      });
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            groupId: createResult.groupId,
            groupName,
            headersCount: headers.length,
            message: `已创建请求头组 "${groupName}" 并启用 ${headers.length} 个请求头`,
            headers: headers
          }, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `快速设置请求头失败: ${error.message}` }],
        isError: true
      };
    }
  }
);

// ============== 智能场景协调功能 ==============

/**
 * 场景配置：定义用户意图到脚本的映射关系
 * 当用户描述他们的需求时，MCP可以自动启用相关脚本
 */
// 21. 获取控制台消息
server.tool(
  "get_console_messages",
  "获取控制台消息。**注意覆盖范围**：数据源是 hook_console_bridge 脚本中转的日志，**只含命中关键词（加密/签名/token/cookie/XHR/fetch 等）且 ≤4000 字符的 log/warn/error/info**——不是页面 console 的全量输出，为空**不代表**页面没有输出。返回体的 `coverage` 字段如实标注桥是否启用、命中总数与来源标签页",
  {
    limit: z.number().int().min(1).max(1000).optional().describe("返回的最大消息数量"),
    // V4.9.23（缺陷🟡-1 配套）：移除 "debug"——桥只包装 log/warn/error/info，debug 恒为空。
    // 留着它等于给 AI 一个"永远返回空"的选项，会被读成"页面没有 debug 输出"（假阴性）
    types: z.array(z.enum(["log", "warn", "error", "info"])).optional().describe("消息类型过滤（debug 不被桥转发，故不在枚举内）"),
    tab_id: z.number().int().optional().describe("只看该标签页的 console 记录（省略则返回全部标签页，每条带 tabId 标明来源）")
  },
  async ({ limit = 50, types = [], tab_id: tabId }) => {
    try {
      const messages = await sendToBrowser("GET_CONSOLE_MESSAGES", { limit, types, tabId });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(messages, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `获取控制台消息失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

  // V4.9.21（性能优化 1.1）：网络请求 / Hook 数据改为**实时向扩展拉取**。
  // 原实现依赖扩展逐条推送 + server 侧缓冲（browserState.networkRequests / hookData）——
  // 全项目检索确认那两个数组只写不读、唯一读取点就是本 resource，推送流纯属无用功（已移除）。
  // 改动后本 resource 数据反而**更新鲜**：实时快照 vs 原先最多 500ms 前的推送缓存。
  server.resource(
    "browser-state",
    "browser://state",
    async (uri) => {
      let networkRequests: any[] = [];
      let hookData: any[] = [];
      // V4.9.21（审计⚪-1）：离线时**跳过两次 pull**——否则 sendToBrowser 先 await waitForBrowser()
      // 再各等 8s 命令超时，单次 resource 读取最坏 ~16s（改动前是即时返回）。离线态由下方
      // browserState.connected 如实反映，调用方看得出"是离线导致空"，不算静默降级。
      if (isBrowserConnected()) {
        // 拉取失败（超时等）不阻断其它字段——降级为空数组，与既有连通性字段语义一致。
        // 审计⚪-1 附：条数收窄（200/100 → 50/50）——本 resource 是"总览"性质，
        // 满缓冲时 200 条精简列表 ≈50KB 上下文负担，与它的用途不匹配
        try {
          // V4.9.34：**显式声明作用域**——本 resource 是"浏览器状态总览"，无调用方传入的目标，
          // 语义上就该用活动标签页。但"隐式省略"与"忘了传"在代码里长得一模一样（这正是本项目
          // 反复出问题的地方），所以按类型契约**显式写出 undefined**，让意图可读、也让类型可查。
          const net = await sendToBrowser("GET_NETWORK_REQUESTS", { limit: 50, detail: false, tabId: undefined, hostname: undefined }, 8000);
          if (Array.isArray(net)) networkRequests = net;
        } catch (e) { /* 降级：保持空数组 */ }
        try {
          const hook = await sendToBrowser("GET_HOOK_DATA", { limit: 50 }, 8000);
          if (Array.isArray(hook)) hookData = hook;
        } catch (e) { /* 降级：保持空数组 */ }
      }
      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify({ ...browserState, networkRequests, hookData }, null, 2)
        }]
      };
    }
  );
}
