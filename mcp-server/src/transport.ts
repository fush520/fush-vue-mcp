// ============== 传输层（WS 浏览器桥 + 命令通道） ==============
// P0-2 拆分自 index.ts——纯机械搬运，逻辑零改动。
// 职责：WS 服务器（9527）、浏览器消息处理、命令收发（sendToBrowser/Retry）、全局状态。

import { WebSocketServer, WebSocket } from "ws";
import type * as Payloads from "./payloads.js";
import { createConnection as netConnect } from "node:net";

// ============== 类型定义 ==============
interface PageInfo {
  url: string;
  title: string;
  hostname: string;
  protocol: string;
  pathname: string;
}

// V4.9.21（复验⚪）：NetworkRequest / VueRouterData / HookData 三个 interface 已零引用
// （其对应的数据流在本次 1.1 / ⚪-2 中移除）——一并删除，避免"看着像协议文档、实际无人消费"。

// V4.9.21（审计⚪-2）：移除只写不读的遗留字段——networkRequests/hookData 的逐条推送已删（1.1），
// vueRouterData/cookies/localStorage/sessionStorage 全项目零发送方。这些空值会在 browser://state
// 里以 `[]`/`{}` 呈现，反而误导调用方以为"确实没有捕获到数据"。
interface BrowserState {
  connected: boolean;
  pageInfo?: PageInfo;
  enabledScripts: string[];
}

// ============== 全局状态 ==============
export let browserState: BrowserState = {
  connected: false,
  enabledScripts: []
};

export let browserClient: WebSocket | null = null;
export let pendingRequests = new Map<string, {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  timeout: NodeJS.Timeout;
}>();

// ============== WebSocket 服务器 ==============
// 从环境变量读取端口配置，默认9527
export const WS_PORT = process.env.MCP_PORT ? parseInt(process.env.MCP_PORT, 10) : 9527;
// V4.9：HTTP 模式端口（--http 时启用；仅监听 127.0.0.1）
export const HTTP_PORT = process.env.MCP_HTTP_PORT ? parseInt(process.env.MCP_HTTP_PORT, 10) : 18080;
// V4.9：WS 端口被占时的重试计数（容忍旧实例退出中的短暂占用，重试耗尽后退出进程）
export let wsPortRetries = 0;
// V4.9.1：WS 就绪信号（审计 L5）——端口冲突重试期间不 resolve，main() 据此避免"先报已启动再退出"的假启动窗口
export let resolveWsReady: (() => void) | null = null;
export const wsReady = new Promise<void>((r) => { resolveWsReady = r; });

// V4.9.1：TCP 级端口占用探测——Windows 下"绑定 127.0.0.1"与既有的"0.0.0.0 绑定"可共存，
// 仅靠 EADDRINUSE 检测不到旧版实例占着 0.0.0.0 的场景。探测仅建立 TCP 连接后立即断开、
// 不发任何数据（不触发 WebSocketServer 的 connection 事件），对运行中的实例零影响。
export function probePortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v: boolean) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* 忽略 */ }
      resolve(v);
    };
    const sock = netConnect({ port, host: '127.0.0.1' });
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));
    setTimeout(() => finish(false), 1500);
  });
}

// V4.9：WS 端口冲突处理——重试 3 次（2s 间隔），耗尽后明确退出（僵尸修复）
export function handleWsPortConflict(): void {
  if (wsPortRetries < 3) {
    wsPortRetries++;
    console.error(`[MCP] ⚠️ 端口 ${currentPort} 被占用，2 秒后重试 (${wsPortRetries}/3)...`);
    setTimeout(() => { initWebSocketServer(); }, 2000);
    return;
  }

  console.error(`[MCP] ❌ 端口 ${currentPort} 被占用（重试 3 次仍失败）——另一个 MCP 服务器实例正在运行。`);
  console.error(`[MCP]    多个 AI 客户端（Claude/ZCode/Qoder 等）同时启动会各自拉起本服务端进程，`);
  console.error(`[MCP]    只有第一个进程能绑定端口并提供浏览器桥，其余进程的浏览器类工具不可用。`);
  console.error(`[MCP]    正确做法：`);
  console.error(`[MCP]      ① 推荐——只启动一个「HTTP 模式」实例（node dist/index.js --http），所有 AI 客户端都连接它；`);
  console.error(`[MCP]      ② 或只保留一个 stdio 客户端使用浏览器工具，关闭其他会话；`);
  console.error(`[MCP]      ③ 或设置环境变量 MCP_PORT 使用其他端口（同时需在插件 popup 中修改端口）。`);
  console.error(`[MCP]    本进程即将退出——避免成为无法连接浏览器的僵尸实例（僵尸表现为"心跳正常但工具全挂"）。`);
  process.exit(1);
}
export let wss: WebSocketServer | null = null;
export let currentPort = WS_PORT;
export let serverHeartbeat: NodeJS.Timeout | null = null;

// 输出端口配置信息
console.error(`[MCP] 配置端口: ${WS_PORT}${process.env.MCP_PORT ? ' (来自环境变量 MCP_PORT)' : ' (默认)'}`);

// 初始化WebSocket服务器
export async function initWebSocketServer() {
  try {
    // V4.9.1：绑定前 TCP 探测（Windows 下 127.0.0.1 与既有 0.0.0.0 绑定可共存，仅靠 EADDRINUSE
    // 检测不到旧版实例占着 0.0.0.0 的场景；探测不发数据，不影响运行中实例的扩展连接）
    if (await probePortInUse(WS_PORT)) {
      handleWsPortConflict();
      return;
    }
    // V4.9.1：只绑本机回环（审计 L6）——浏览器扩展恒在本机，避免同网段主机直连桥冒充扩展
    wss = new WebSocketServer({ port: WS_PORT, host: '127.0.0.1' });
    currentPort = WS_PORT;
    // V4.9.1：绑定成功才发就绪信号（审计 L5）
    wss.on('listening', () => { resolveWsReady?.(); });

    console.error(`[MCP] WebSocket服务器启动在端口 ${WS_PORT}`);

    // V4.9.15：WS 命令面鉴权（可选启用）——server 设 ADB_WS_TOKEN 环境变量后，扩展连接 URL
    // 必须带 ?token=<同值>（扩展侧由 chrome.storage.local 的 adb_ws_token 提供，见 mcp-client.js）。
    // 防本机进程伪造 Origin 头抢占 browserClient 位（Origin 头在 ws 库客户端可任意伪造）。
    // 未设置该变量时行为与旧版一致（仅 Origin 校验）。
    const WS_TOKEN = String(process.env.ADB_WS_TOKEN || '').trim();

    // V4.9.38（批 3 审计 D-13）：WS 来源白名单——默认本扩展（manifest.json 的 key 固定了扩展 ID），
    // 可用环境变量 ADB_ALLOWED_EXT_IDS 覆盖（逗号分隔，兼容自打包/改 key 的场景）。
    const ALLOWED_EXT_IDS = String(process.env.ADB_ALLOWED_EXT_IDS || 'gehffcnnfpebmbemfnkoflchkobghjeh')
      .split(',').map((s: string) => s.trim().toLowerCase()).filter(Boolean);

    wss.on("connection", (ws: any, req: any) => {
      // V4.9.2：来源校验——浏览器扩展的 WS 连接必带 Origin: chrome-extension://<id>。
      // 恶意网页可 new WebSocket('ws://127.0.0.1:9527') 抢占连接位/窥探命令/伪造响应，
      // 无 Origin 或非扩展来源一律拒绝（HTTP 模式的 18080 已有 Host/Origin 校验，此处补齐 WS 面）。
      const origin = String((req && req.headers && req.headers.origin) || '');
      // V4.9.38（批 3 审计 D-13 🔴）：**从"是某个扩展"收紧到"是本扩展"**——原实现只校验
      // `chrome-extension://` 前缀，于是用户装的任意其它扩展都能连上来抢占 browserClient 位
      // （新连接会主动关闭旧连接）并伪造工具返回。现在校验具体的扩展 ID 白名单。
      const extMatch = /^(?:chrome|moz|safari-web)-extension:\/\/([a-z0-9_-]+)\/?$/i.exec(origin);
      const extId = extMatch ? extMatch[1].toLowerCase() : '';
      if (!extId || !ALLOWED_EXT_IDS.includes(extId)) {
        console.error(`[MCP] ⚠️ 拒绝非本扩展来源的 WebSocket 连接（Origin: ${origin || '(空)'}）——防其它扩展/恶意网页冒充`);
        try { ws.close(4403, 'origin not allowed'); } catch (e) { /* 忽略 */ }
        return;
      }

      // WS token 校验（V4.9.15，可选启用）
      if (WS_TOKEN) {
        const url = new URL(req.url || '/', 'http://localhost');
        const clientToken = String(url.searchParams.get('token') || '');
        if (clientToken !== WS_TOKEN) {
          console.error('[MCP] ⛔ 拒绝无有效 token 的扩展连接（ADB_WS_TOKEN 校验失败）');
          try { ws.close(4401, 'token mismatch'); } catch (e) { /* 忽略 */ }
          return;
        }
      }

      // 单 browserClient 模型：新连接到来时主动关闭旧连接。
      // 否则旧 socket 可能 lingering：PING/PONG 依旧正常但命令发向死通道，
      // 表现为"心跳正常却命令失联"的假连接。
      if (browserClient && browserClient !== ws) {
        console.error("[MCP] 检测到新扩展连接，主动关闭旧连接");
        const oldWs = browserClient as any;
        try { oldWs.close(4000, "replaced by new connection"); } catch (e) { /* 忽略 */ }
        try { oldWs.terminate(); } catch (e) { /* 忽略 */ }
        // 挂起请求都是发给旧 socket 的，立即拒绝让 MCP 侧重试
        rejectAllPending("浏览器扩展连接已被新连接替换，请重试");
      }
      console.error("[MCP] 浏览器扩展已连接");
      browserClient = ws;
      browserState.connected = true;
      ws.isAlive = true;
      ws.missedPings = 0;
      ws.on("pong", () => { ws.isAlive = true; });

      ws.on("message", (data: WebSocket.RawData) => {
        try {
          const message = JSON.parse(data.toString());

          // 处理心跳消息
          if (message.type === 'PING') {
            ws.send(JSON.stringify({ type: 'PONG', timestamp: Date.now() }));
            return;
          }

          handleBrowserMessage(message);
        } catch (e) {
          console.error("[MCP] 解析消息失败:", e);
        }
      });

      ws.on("close", () => {
        console.error("[MCP] 浏览器扩展断开连接");
        // 仅当断开的是当前连接时才清理状态与拒绝挂起请求。
        // 被新连接替换的旧 socket 其挂起请求已在替换时被拒绝，
        // 此处若无条件 rejectAllPending 会误拒新连接刚注册的请求。
        if (browserClient === ws) {
          browserClient = null;
          browserState.connected = false;
          // 立即拒绝所有挂起的请求，避免 Claude 干等超时
          rejectAllPending("浏览器扩展连接已断开");
        }
      });

      ws.on("error", (error: Error) => {
        console.error("[MCP] WebSocket错误:", error);
        if (browserClient === ws) {
          browserClient = null;
          browserState.connected = false;
          rejectAllPending("浏览器扩展连接错误");
        }
      });
    });

    // 服务器协议级心跳：每 10 秒 ping 一次，连续 2 次未响应才终止。
    // MV3 service worker 被浏览器节流/机器睡眠时单次 pong 延迟很常见，
    // 一次未响应就 terminate 会造成"server 杀连接 → 扩展慢速重连"的断连循环。
    // 注意：服务器 ping 对浏览器来说是入站消息，可协助保持扩展
    // service worker 存活（Chrome 116+ 入站 WS 消息会重置 SW 空闲计时器）
    serverHeartbeat = setInterval(() => {
      if (!wss) return;
      wss.clients.forEach((ws: any) => {
        if (ws.isAlive === false) {
          ws.missedPings = (ws.missedPings || 0) + 1;
          if (ws.missedPings >= 2) {
            console.error("[MCP] 连续 2 次未响应 ping，判定死连接，终止");
            ws.terminate();
            return;
          }
          console.error("[MCP] 一次 ping 未响应（容错窗口内，暂不终止）");
        } else {
          ws.missedPings = 0;
        }
        ws.isAlive = false;
        try {
          ws.ping();
        } catch (e) { /* 忽略 */ }
      });
    }, 10000);

    wss.on("close", () => {
      if (serverHeartbeat) {
        clearInterval(serverHeartbeat);
        serverHeartbeat = null;
      }
    });

    wss.on("error", (error: any) => {
      if (error.code === 'EADDRINUSE') {
        // EADDRINUSE 是异步 error 事件，wss 已处于半初始化状态：
        // 必须主动关闭并停掉心跳定时器，否则心跳在空 server 上空转
        if (serverHeartbeat) {
          clearInterval(serverHeartbeat);
          serverHeartbeat = null;
        }
        try { wss?.close(); } catch (e) { /* 忽略 */ }
        wss = null;

        // V4.9：重试 3 次（每次间隔 2 秒，容忍旧实例退出中的短暂占用），耗尽后明确退出（僵尸修复）
        handleWsPortConflict();
      } else {
        console.error("[MCP] WebSocket服务器错误:", error);
        // V4.9.1：非端口冲突错误不阻塞启动（保持原行为：继续运行但无法与浏览器扩展通信）
        resolveWsReady?.();
      }
    });

  } catch (error: any) {
    console.error(`[MCP] ❌ WebSocket服务器启动失败: ${error.message}`);
    console.error("[MCP] MCP服务器将继续运行，但无法与浏览器扩展通信");
    resolveWsReady?.();
  }
}

// 立即拒绝所有挂起的请求（浏览器断开时调用）
export function rejectAllPending(reason: string) {
  if (pendingRequests.size === 0) return;
  console.error(`[MCP] 浏览器断开，拒绝 ${pendingRequests.size} 个挂起请求`);
  for (const [id, pending] of pendingRequests) {
    clearTimeout(pending.timeout);
    pending.reject(new Error(reason));
    pendingRequests.delete(id);
  }
}

// 处理来自浏览器的消息
export function handleBrowserMessage(message: any) {
  const { type, requestId, data, error } = message;

  // 处理请求响应
  if (requestId && pendingRequests.has(requestId)) {
    const pending = pendingRequests.get(requestId)!;
    clearTimeout(pending.timeout);
    pendingRequests.delete(requestId);

    if (error) {
      pending.reject(new Error(error));
    } else {
      pending.resolve(data);
    }
    return;
  }
  // bug-hunt（2026-10-13）：超时后**迟到**的响应（requestId 已清理）静默丢弃——
  // 原实现会落到下方 switch 打 "未知消息类型: RESPONSE" 噪音日志
  if (requestId) return;

  // 处理推送消息
  switch (type) {
    case "PAGE_INFO":
      browserState.pageInfo = data;
      break;

    // V4.9.21（性能优化 1.1）：NETWORK_REQUEST / HOOK_DATA 两个逐条推送分支已移除。
    // 它们写入的 browserState.networkRequests / hookData **全项目只写不读**——唯一读取点是
    // page.ts 的 browser://state resource，该 resource 已改为向扩展**实时拉取**（数据反而更新鲜）。
    // 原推送流对每条数据都要 stringify + 一个 WS 帧 + 满额后 O(n) 数组复制，属纯无用功。
    // （若版本不匹配的旧扩展仍在推送，会落到下方 default 打一条"未知消息类型"——可见的信号。）
    //
    // V4.9.21（审计⚪-2）：按同一"只写不读即删"判据清掉两个死分支——
    // VUE_ROUTER_DATA（该数据实际走 content.js → background.js → storage.local，**从不进 server**）
    // 与 STORAGE_DATA（全项目零发送方）。

    case "SCRIPTS_UPDATED":
      browserState.enabledScripts = data.enabledScripts || [];
      break;

    default:
      console.error("[MCP] 未知消息类型:", type);
  }
}

// 浏览器重连等待配置：service worker 被挂起后需要几秒才能被唤醒重连
export const BROWSER_WAIT_TIMEOUT = 8000;  // 最多等待浏览器重连 8 秒
export const BROWSER_WAIT_INTERVAL = 400; // 每 400ms 检查一次

// 浏览器是否已连接
export function isBrowserConnected(): boolean {
  return !!browserClient && browserClient.readyState === WebSocket.OPEN;
}

// 等待浏览器扩展连接（service worker 被挂起后，给其唤醒重连的时间）
export function waitForBrowser(timeoutMs: number = BROWSER_WAIT_TIMEOUT): Promise<void> {
  return new Promise((resolve, reject) => {
    if (isBrowserConnected()) {
      resolve();
      return;
    }

    console.error(`[MCP] 浏览器未连接，等待扩展重连（最多 ${timeoutMs/1000} 秒）...`);

    const start = Date.now();
    const timer = setInterval(() => {
      if (isBrowserConnected()) {
        clearInterval(timer);
        console.error(`[MCP] 浏览器已重新连接（等待 ${Date.now() - start}ms）`);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        reject(new Error(
          "[RETRYABLE] 浏览器扩展暂未连接（已等待重连 8 秒）。扩展每 30 秒自动唤醒重连，请稍后重试本工具调用。" +
          "若持续失败请确认：1) Edge/Chrome 浏览器已打开 2) 插件已启用且 MCP 开关已打开 3) MCP 服务器端口与插件端口一致"
        ));
      }
    }, BROWSER_WAIT_INTERVAL);
  });
}

// 发送请求到浏览器并等待响应
// 默认超时 10s→30s（实测：登录后扩展 SW 处于数据上报高峰，命令响应可能迟到，
// 10s 会把本可成功的调用判死——route_api_graph 的 chunk 扫描在靶场实测中因此空结果）
// 带一次重试的浏览器命令调用（实测 GET_JS_CHUNKS 在页面导航中注入会偶发挂起超时——重试即恢复）
export function sendToBrowserRetry<K extends keyof ScopedCommands>(
    type: K, data: ScopedCommands[K], timeout?: number, retries?: number
): Promise<any>;
export function sendToBrowserRetry<K extends UnscopedCommands>(
    type: K, data?: any, timeout?: number, retries?: number
): Promise<any>;
export async function sendToBrowserRetry(type: string, data?: any, timeout = 30000, retries = 1): Promise<any> {
  try {
    return await sendToBrowser(type as any, data, timeout);
  } catch (e: any) {
    if (retries <= 0) throw e;
    await new Promise((r) => setTimeout(r, 1500));
    return sendToBrowserRetry(type as any, data, timeout, retries - 1);
  }
}

// V4.9.11（吸收上游"超时≠取消"语义）：有副作用的命令超时后可能已部分/全部执行——
// 错误信息明确标注 mayHaveExecuted，防止 AI 直接重试造成重复点击/重复提交（业务逻辑测试时的真实副作用）。
export const SIDE_EFFECT_CMDS = new Set([
  'REAL_CLICK', 'REAL_TYPE', 'REAL_KEY', 'FILL_INPUT', 'CLICK_ELEMENT',
  // V4.9.39：拖拽/鼠标原语同样有副作用——拖到一半超时的"已执行"无法重放（可能已移动了滑块/元素）
  'REAL_DRAG', 'MOUSE_CONTROL',
  // V4.9.39：新建标签也是副作用（超时重发会开出两个标签）
  'NEW_TAB',
  // V4.9.41：上传文件/环境模拟/标签关闭/console 注入都会改状态——超时后不能盲目重发
  'UPLOAD_FILE', 'EMULATE', 'TAB_MANAGE', 'CONSOLE_LOG',
  'NAVIGATE_TO', 'REFRESH_PAGE', 'AUTO_FILL_FORM', 'AUTO_LOGIN_AND_CAPTURE',
  // V4.9.11：调试控制改变页面状态（暂停/改断点/分离）——超时后可能已生效，不能盲目重发
  'DEBUG_CONTROL',
  // 2026-10-13（第四批审计 L2）：对话框处理同样改变页面状态（确认/取消的结果无法重放）——超时≠未执行
  'HANDLE_DIALOG',
  // V4.9.11（验收修复 A5）：补齐漏网的写操作/有状态命令。它们超时后原本提示"查询类命令，
  // 可安全重试"，与 V4.9.11 自己引入的"超时≠未执行"语义直接冲突，会诱导 AI 重发。
  // 最讽刺的是 HOOK_ROUTE_ARRAY——它的调用点自己传了 retries=0 禁用自动重试（防二次 enable
  // 冲突），却仍被归进"可安全重试"文案。
  // ① 任意代码 / 按键 / 点击类（副作用取决于注入内容或页面反应）
  'EXECUTE_SCRIPT', 'PRESS_KEY', 'REAL_HOVER', 'SCROLL_PAGE', 'CLICK_AND_CAPTURE', 'CLICK_AND_GET_BURP',
  // ② 脚本与钩子开关（写 storage + 重注入；二次执行叠加监听器/冲突）
  'TOGGLE_SCRIPT', 'BATCH_ENABLE_SCRIPTS', 'DISABLE_ALL_SCRIPTS', 'CONFIGURE_HOOK',
  'ENABLE_ENCRYPTION_HOOKS', 'INJECT_ENCRYPTION_CAPTURE', 'AUTO_BYPASS_ANTI_DEBUG', 'HOOK_ROUTE_ARRAY',
  // ③ 请求头管理（改 DNR 规则，影响后续所有请求）
  'CREATE_HEADER_GROUP', 'DELETE_HEADER_GROUP', 'SWITCH_HEADER_GROUP', 'ADD_HEADER',
  'UPDATE_HEADER', 'DELETE_HEADER', 'TOGGLE_HEADER', 'BATCH_UPDATE_HEADERS',
  // ④ 其他有状态 / 导航类
  'START_SENSITIVE_MONITOR', 'LOGIN_AND_GET_BURP', 'DEEP_LINK_PROBE', 'SCAN_ROUTE_FOR_API',
  'PREPARE_ROUTE_ACCESS'
]);

// 超时文案判定：Set 命中，或 ANON_FETCH 带着**非只读方法**（写请求超时同样可能已执行——
// 这类请求由 allow_write 安全阀管控是否发出，但超时后是否可重试是另一回事，不能笼统说"可安全重试"）
export function isSideEffectCommand(type: string, data?: any): boolean {
  if (SIDE_EFFECT_CMDS.has(type)) return true;
  if (type === 'ANON_FETCH' && data && typeof data.method === 'string'
      && !/^(GET|HEAD)$/i.test(data.method.trim())) return true;
  return false;
}

// ============================================================================
// V4.9.34：作用域类型契约 —— 让"参数在链上丢失"变成**编译错误**
//
// 为什么需要：本项目反复修同一类缺陷——作用域（tabId/hostname）在某一跳丢了，
// 工具于是**静默作用到用户的活动标签页**（V4.9.26 补 22 个工具、V4.9.27 抓到
// get_chunk_source 三层断头、V4.9.30 抓到派发跳漏传 data，一天内四次"只修一半"）。
// 根因不是不认真，是**每一跳都手写、没有契约**：104 工具 × 4~5 跳，人工同步不过来。
//
// 这个类型就是把契约钉在**唯一出口** sendToBrowser 上：
//   · 漏传整个作用域对象  → 编译错误（`{}` 与 `{其他字段}` 都不满足 TabScope）
//   · 命令名拼错          → 编译错误（不再是运行时的 "未知命令"）
//   · data 整个漏传       → 编译错误（第二个参数必填）
// 同时**不误伤**合法调用：`{tabId}`、`{hostname}`、`{tabId, hostname}` 都允许，
// 值本身是 undefined 也允许（那是"未指定 → 用活动标签页"的正常语义）。
//
// 为什么用联合类型而不是可选字段：`tabId?: number` 会让 `{}` 也通过——那正是
// get_chunk_source 当年的形态（payload 里压根没有这两个键）。要求"至少写一个键"，
// 才能把"忘了整块传"拦下来而对"值确实没指定"放行。
// ============================================================================
export type TabScope =
    | { tabId: number | undefined; hostname: string | undefined }
    | { tabId: number | undefined }
    | { hostname: string | undefined };

/**
 * 客户端**确实接收作用域**的命令（58 个，由客户端 handler 签名反查得出）。
 * `& Record<string, any>` 让各命令自己的业务字段保持宽松——本轮**只强制作用域**，
 * 不强制逐字段定型（那是下一步，避免一次收紧太多产生噪音）。
 *
 * ⚠️ 新增作用于页面的命令时，**必须登记到这里**；否则它不会受类型保护
 * （`test_tabid_scope.js` 会从工具层反向检查，两边互为兜底）。
 */
export interface ScopedCommands {
    ANALYZE_API_SIGNATURE: TabScope & Payloads.AnalyzeApiSignaturePayload;
    ANALYZE_AUTHENTICATION: TabScope & Payloads.AnalyzeAuthenticationPayload;
    ANALYZE_PAGE_ENCRYPTION: TabScope & Payloads.AnalyzePageEncryptionPayload;
    ANON_FETCH: TabScope & Payloads.AnonFetchPayload;
    AUTO_BYPASS_ANTI_DEBUG: TabScope & Payloads.AutoBypassAntiDebugPayload;
    AUTO_FILL_FORM: TabScope & Payloads.AutoFillFormPayload;
    AUTO_LOGIN_AND_CAPTURE: TabScope & Payloads.AutoLoginAndCapturePayload;
    BATCH_ENABLE_SCRIPTS: TabScope & Payloads.BatchEnableScriptsPayload;    CLICK_ELEMENT: TabScope & Payloads.ClickElementPayload;
    DEBUG_CONTROL: TabScope & Payloads.DebugControlPayload;
    DECRYPT_RSA: TabScope & Payloads.DecryptRsaPayload;
    DEEP_LINK_PROBE: TabScope & Payloads.DeepLinkProbePayload;
    DETECT_ANTI_DEBUG: TabScope & Payloads.DetectAntiDebugPayload;
    DISABLE_ALL_SCRIPTS: TabScope & Payloads.DisableAllScriptsPayload;
    ENABLE_ENCRYPTION_HOOKS: TabScope & Payloads.EnableEncryptionHooksPayload;
    // V4.9.35：以下 5 个**原先被我错归入 UnscopedCommands**（宽松、无保护）——
    // 独立验收指出：它们的客户端 handler **体内确实调 resolveTab/requireTab 定位标签页**
    //（EXECUTE_SCRIPT `mcp-client.js:2307`、GET_COOKIES `:2255`、GET_ENABLED_SCRIPTS `:2148`、
    // GET_LOCAL_STORAGE `:2287`、GET_SESSION_STORAGE `:2298` 经 executeScript 间接）。
    // 漏传作用域时 tsc **不报错** ⇒ 保护是空的，下一个人漏传即静默打到活动标签页。
    // 而它们恰是**最高危**的几个：任意 JS 执行、cookie/storage 读取。
    // 当前工具层调用点恰好都传了（无活缺陷），但不能靠"恰好"。
    EXECUTE_SCRIPT: TabScope & Payloads.ExecuteScriptPayload;
    GET_COOKIES: TabScope & Payloads.GetCookiesPayload;
    GET_ENABLED_SCRIPTS: TabScope & Payloads.GetEnabledScriptsPayload;
    GET_LOCAL_STORAGE: TabScope & Payloads.GetLocalStoragePayload;
    GET_SESSION_STORAGE: TabScope & Payloads.GetSessionStoragePayload;
    EXTRACT_PAGE_DATA: TabScope & Payloads.ExtractPageDataPayload;
    EXTRACT_REACT_DATA: TabScope & Payloads.ExtractReactDataPayload;    EXTRACT_VUE_DATA: TabScope & Payloads.ExtractVueDataPayload;
    FILL_INPUT: TabScope & Payloads.FillInputPayload;
    GET_CAPTURED_ENCRYPTION: TabScope & Payloads.GetCapturedEncryptionPayload;
    GET_CONSOLE_MESSAGES: TabScope & Payloads.GetConsoleMessagesPayload;
    GET_CRYPTO_REGISTRY: TabScope & Payloads.GetCryptoRegistryPayload;
    GET_DEBUG_STATE: TabScope & Payloads.GetDebugStatePayload;
    GET_DECRYPTED_RESPONSES: TabScope & Payloads.GetDecryptedResponsesPayload;
    GET_DOM_INFO: TabScope & Payloads.GetDomInfoPayload;
    GET_ELEMENT_INFO: TabScope & Payloads.GetElementInfoPayload;
    GET_JS_CHUNKS: TabScope & Payloads.GetJsChunksPayload;
    GET_NETWORK_REQUESTS: TabScope & Payloads.GetNetworkRequestsPayload;
    GET_NETWORK_REQUESTS_BURP: TabScope & Payloads.GetNetworkRequestsBurpPayload;
    GET_NETWORK_REQUESTS_WITH_BODY: TabScope & Payloads.GetNetworkRequestsWithBodyPayload;
    GET_NETWORK_REQUEST_DETAIL: TabScope & Payloads.GetNetworkRequestDetailPayload;    GET_PAGE_INFO: TabScope & Payloads.GetPageInfoPayload;
    GET_SEMANTIC_DOM: TabScope & Payloads.GetSemanticDomPayload;
    GET_SENSITIVE_ALERTS: TabScope & Payloads.GetSensitiveAlertsPayload;
    GET_STORE_DUMP: TabScope & Payloads.GetStoreDumpPayload;
    GET_VUE_ROUTER_DATA: TabScope & Payloads.GetVueRouterDataPayload;
    GET_WS_FRAMES: TabScope & Payloads.GetWsFramesPayload;
    HANDLE_DIALOG: TabScope & Payloads.HandleDialogPayload;
    HOOK_ROUTE_ARRAY: TabScope & Payloads.HookRouteArrayPayload;
    // V4.9.41：对齐 chrome-devtools 的工具面 —— 标签管理 / 文件上传 / 环境模拟 / 页面 console 全量
    TAB_MANAGE: TabScope & Payloads.TabManagePayload;
    UPLOAD_FILE: TabScope & Payloads.UploadFilePayload;
    EMULATE: TabScope & Payloads.EmulatePayload;
    CONSOLE_LOG: TabScope & Payloads.ConsoleLogPayload;
    INJECT_ENCRYPTION_CAPTURE: TabScope & Payloads.InjectEncryptionCapturePayload;    NAVIGATE_TO: TabScope & Payloads.NavigateToPayload;
    NUXT_PAYLOAD_PROBE: TabScope & Payloads.NuxtPayloadProbePayload;    PRESS_KEY: TabScope & Payloads.PressKeyPayload;
    REAL_CLICK: TabScope & Payloads.RealClickPayload;
    // V4.9.39：鼠标级拖拽（滑块验证码 / rc-slider / 拖拽排序）+ 低层鼠标原语
    REAL_DRAG: TabScope & Payloads.RealDragPayload;
    MOUSE_CONTROL: TabScope & Payloads.MouseControlPayload;
    REAL_HOVER: TabScope & Payloads.RealHoverPayload;
    REAL_KEY: TabScope & Payloads.RealKeyPayload;
    REAL_TYPE: TabScope & Payloads.RealTypePayload;
    REFRESH_PAGE: TabScope & Payloads.RefreshPagePayload;    SCROLL_PAGE: TabScope & Payloads.ScrollPagePayload;
    SIGN_PAYLOAD: TabScope & Payloads.SignPayloadPayload;
    START_SENSITIVE_MONITOR: TabScope & Payloads.StartSensitiveMonitorPayload;
    TAKE_A11Y_SNAPSHOT: TabScope & Payloads.TakeA11ySnapshotPayload;
    TAKE_SCREENSHOT: TabScope & Payloads.TakeScreenshotPayload;
    TOGGLE_SCRIPT: TabScope & Payloads.ToggleScriptPayload;
    WAIT_FOR_SELECTOR: TabScope & Payloads.WaitForSelectorPayload;
}

/**
 * **不作用于页面**的命令（请求头组配置、脚本清单、扩展重载等——作用域是 storage 或全局）。
 * 列出来是为了让下面两个重载**互斥且完备**：
 *   重载① 管 `ScopedCommands`（严格）｜重载② 管这里（宽松）｜两者之外 ⇒ 命令名拼错 ⇒ 编译错误
 *
 * ⚠️ 第一版重载写成了 `(type: string, data?: any)`，结果**宽松重载吃掉了所有调用**，
 * 漏传作用域一样编译通过——自证样本立刻识破（那正是"绿灯不等于有效"）。TS 做不到
 * "string 但不含这些字面量"，所以必须**枚举**而非用 `Exclude`。
 */
type UnscopedCommands =
    | 'ADD_HEADER' | 'BATCH_UPDATE_HEADERS' | 'CONFIGURE_HOOK' | 'CREATE_HEADER_GROUP'
    | 'DELETE_HEADER' | 'DELETE_HEADER_GROUP'
    | 'GET_HEADERS_CONFIG' | 'GET_HOOK_DATA'
    | 'LIST_AVAILABLE_SCRIPTS' | 'RELOAD_EXTENSION'
    // V4.9.39：新建标签不作用于某个既有页面（因此无需 TabScope）——由 chrome.tabs.create 在后台开
    | 'NEW_TAB'
    | 'SWITCH_HEADER_GROUP' | 'TOGGLE_HEADER' | 'UPDATE_HEADER';

/** 严格重载：作用于页面的命令 → payload 必须满足 `TabScope` */
export function sendToBrowser<K extends keyof ScopedCommands>(
    type: K,
    data: ScopedCommands[K],
    timeout?: number
): Promise<any>;
/** 宽松重载：不作用于页面的命令 */
export function sendToBrowser<K extends UnscopedCommands>(
    type: K,
    data?: any,
    timeout?: number
): Promise<any>;
export async function sendToBrowser(type: string, data?: any, timeout = 30000): Promise<any> {
  // 浏览器未连接时先等待其重连（修复 SW 休眠导致工具调用失败的问题）
  await waitForBrowser();

  if (!isBrowserConnected()) {
    throw new Error("浏览器扩展未连接。请确保Chrome扩展已加载并打开了目标页面。");
  }

  return new Promise((resolve, reject) => {
    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    const timeoutHandle = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error(isSideEffectCommand(type, data)
        ? `请求超时: ${type}（⚠️ 操作可能已执行——超时≠未发生。勿直接重试；先用 get_semantic_dom / take_screenshot / get_network_requests 确认页面实际状态后再决定）`
        : `请求超时: ${type}（查询类命令，可安全重试）`));
    }, timeout);

    pendingRequests.set(requestId, { resolve, reject, timeout: timeoutHandle });

    try {
      browserClient!.send(JSON.stringify({
        type,
        requestId,
        data
      }));
    } catch (sendErr: any) {
      // bug-hunt（2026-10-13）：send 同步抛出时清理表项与定时器（原实现残留到 timeout 才回收）
      clearTimeout(timeoutHandle);
      pendingRequests.delete(requestId);
      reject(new Error(`发送失败: ${(sendErr && sendErr.message) || sendErr}`));
    }
  });
}