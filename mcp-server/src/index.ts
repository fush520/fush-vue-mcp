#!/usr/bin/env node
/**
 * Fush Vue MCP Server
 * 
 * 这个MCP服务器允许Codex通过Chrome扩展来分析和控制浏览器页面
 * 
 * 功能：
 * - 获取当前页面信息（URL、标题、DOM结构等）
 * - 获取网络请求/API调用记录
 * - 获取Vue Router路由信息
 * - 注入和管理Hook脚本
 * - 获取Hook捕获的数据
 * - 控制页面导航
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createServer as createHttpServer } from "node:http";
import { createConnection as netConnect } from "node:net";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { WebSocketServer, WebSocket } from "ws";
import {browserState, browserClient, pendingRequests, WS_PORT, HTTP_PORT, wsPortRetries, resolveWsReady, wsReady, probePortInUse, handleWsPortConflict, wss, currentPort, serverHeartbeat, initWebSocketServer, rejectAllPending, handleBrowserMessage, BROWSER_WAIT_TIMEOUT, BROWSER_WAIT_INTERVAL, isBrowserConnected, waitForBrowser, sendToBrowserRetry, SIDE_EFFECT_CMDS, isSideEffectCommand, sendToBrowser } from "./transport.js";
import {
  detectLoginWall,
  flattenJsonPaths,
  jsonSimilarity,
  tryParseJson,
  judgeUnauthorized,
  FRAMEWORK_FINGERPRINTS,
  SENSITIVE_ROUTE_RE,
  MODULE_PATH_RE,
  API_PATH_RE,
  RESOURCE_EXT_RE,
  NOISE_PATH_RE,
  normalizePath,
  getJSChunksCached,
  _tlsEnvPrev,
  enterInsecureTls,
  exitInsecureTls,
  TLS_ERR_RE,
  BASE_CFG_RE,
  CDN_ASSET_HOST_RE,
  normalizeBaseCfg,
  errDetail,
  safeFetch,
  anonFetchWithServerFallback,
  fetchChunkText,
  SAAS_PRODUCT_FINGERPRINTS,
  detectSaasProducts,
  isWriteLikeApi,
  extractLazyChunkNames,
  KEY_ASSIGN_RE,
  HEX_KEY_RE,
  SOURCEMAP_RE,
  extractChunkKeysFromCode,
  SENSITIVE_PATTERNS,
  analyzeSensitiveData,
  maskSensitiveData,
} from "./helpers.js";

import { register_page_tools } from "./tools/page.js";
import { register_vue_tools } from "./tools/vue.js";
import { register_api_tools } from "./tools/api.js";
import { register_security_tools } from "./tools/security.js";
import { register_scripts_tools } from "./tools/scripts.js";
import { register_crypto_tools } from "./tools/crypto.js";
import { register_quick_tools } from "./tools/quick.js";
import { register_debug_tools } from "./tools/debug.js";



// ============== MCP 服务器 ==============
// V4.9.38：服务端版本单一事实源——MCP serverInfo 与 /health 共用。
// 版本六处之一定义在这里（tool_findings.js 的 --check 会校验它）；
// 改版本时只改这一处 + manifest/package/README/dist（build 生成）。
const SERVER_VERSION = "4.9.44";

// V4.9：工厂化——每个 MCP 会话持有独立 McpServer 实例（stdio 单会话 / HTTP 多会话），
// 共享模块级 browserState 与浏览器 WebSocket 桥；解决多个 AI 客户端抢 9527 单例的问题。
function createServer(): McpServer {
    const server = new McpServer({
        // serverInfo.name —— MCP 握手时自报的身份，客户端（Claude/Codex/Trae）连接信息里显示的就是它。
        // 与 package.json / 仓库名 / manifest 显示名保持一致。
        name: "fush-vue-mcp",
        version: SERVER_VERSION
    });

    // ============== 工具注册（按域分文件，见 tools/*.ts） ==============
register_page_tools(server);
register_vue_tools(server);
register_api_tools(server);
register_security_tools(server);
register_scripts_tools(server);
register_crypto_tools(server);
register_quick_tools(server);
register_debug_tools(server);

return server;
}

// ============== V4.9：Streamable HTTP 传输（多 AI 客户端共享一个服务端实例） ==============
// 竞品架构吸收：MCP 服务支持常驻 HTTP 模式，多个客户端（Claude Code 多会话 / Codex / Codex 等）
// 各自建立独立 MCP 会话（session），共享同一个浏览器 WebSocket 桥——根治多会话抢 9527 的问题。
// 启动方式：node dist/index.js --http  （或环境变量 MCP_HTTP=1）
// 端口：MCP_HTTP_PORT 环境变量，默认 18080。仅监听 127.0.0.1。
const httpSessions = new Map<string, StreamableHTTPServerTransport>();
// V4.9.1：会话活跃时间（审计 L4——回收失联客户端残留的会话）
const httpSessionActivity = new Map<string, number>();

async function startHttpMcpServer(): Promise<void> {
  // 会话回收：每 10 分钟清理 30 分钟无请求的会话（客户端崩溃/Ctrl+C 不发 DELETE 的残留）
  const reaper = setInterval(() => {
    const now = Date.now();
    for (const [sid, at] of httpSessionActivity) {
      if (now - at > 30 * 60 * 1000) {
        const t = httpSessions.get(sid);
        try { t?.close(); } catch { /* 忽略 */ }
        httpSessions.delete(sid);
        httpSessionActivity.delete(sid);
        console.error(`[MCP-HTTP] 回收空闲会话 ${sid.slice(0, 8)}...`);
      }
    }
  }, 10 * 60 * 1000);
  (reaper as any).unref?.();

  // V4.9.12：HTTP 端点 token 认证（可选启用）——设 ADB_HTTP_TOKEN 环境变量后，
    // /mcp 要求 Authorization: Bearer <token>（/health 豁免）。未设置时保持匿名可用（本机回环 +
    // Host/Origin 校验已挡外部与恶意网页），启动日志会提示。适配配置见 README「安全」节。
  const HTTP_TOKEN = String(process.env.ADB_HTTP_TOKEN || '').trim();
  if (HTTP_TOKEN) {
        console.log(`[MCP-HTTP] ✅ Token 认证已启用（Bearer 校验，/health 豁免）`);
  } else {
        console.log(`[MCP-HTTP] ⚠️ 未设 ADB_HTTP_TOKEN——/mcp 匿名可用（仅 Host/Origin 校验，本机任意进程可直连）`);
  }

  const httpServer = createHttpServer(async (req, res) => {
        // V4.9.1：DNS rebinding 防护（审计 M2）——Host 必须为本机，Origin（若存在）必须为本机来源。
        // 防恶意网页通过域名重绑定直连 /mcp 调用 execute_script 等工具。
    const hostHeader = String(req.headers.host || '');
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(hostHeader)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden: invalid Host header' }));
      return;
    }
    const originHeader = req.headers.origin;
    if (originHeader && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(String(originHeader))) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden: cross-origin request rejected' }));
      return;
    }

        // Token 认证（V4.9.12，可选）：设 ADB_HTTP_TOKEN 后 /mcp 需 Bearer；/health 与 OPTIONS 预检豁免
    const isHealthPath = req.url === '/health' || req.url?.startsWith('/health?');
    if (HTTP_TOKEN && !isHealthPath && req.method !== 'OPTIONS') {
      const auth = String(req.headers.authorization || '');
      const expected = `Bearer ${HTTP_TOKEN}`;
      // 恒时比较（防时序侧信道；timingSafeEqual 要求等长，长度不等直接判否）
      const authBuf = Buffer.from(auth);
      const expBuf = Buffer.from(expected);
      const tokenOk = authBuf.length === expBuf.length && timingSafeEqual(authBuf, expBuf);
      if (!tokenOk) {
                console.error(`[MCP-HTTP] ⛔ 拒绝无有效 token 的请求（${req.method} ${req.url}）`);
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized: missing or invalid Bearer token (set ADB_HTTP_TOKEN on server, send Authorization: Bearer <token>)' }));
        return;
      }
    }

        // 健康检查（供用户/脚本确认服务与扩展连接状态）
    if (req.url === '/health' || req.url?.startsWith('/health?')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        // V4.9.38（批 4 审计 D-01 🔴）：/health 必须带 **version + pid**——
        // native launcher 原来只认 HTTP 200，于是"旧进程还在跑"与"新版本已生效"同形，
        // 新 build 静默不生效（START_HERE:61 记过同型事故：六处已是 4.9.34，运行中仍返 4.9.33）。
        // 现在 launcher 会拿这里的 version 与 mcp-server/package.json 比对，不一致就报 version-mismatch。
        version: SERVER_VERSION,
        pid: process.pid,
        browserConnected: browserState.connected,
        wsPort: currentPort,
        activeSessions: httpSessions.size,
        mode: 'http'
      }));
      return;
    }

    if (!req.url?.startsWith('/mcp')) {
            // V4.9.6.2：404 一律返回 JSON——实测 Claude Code 的 OAuth 探测拿到纯文本 404 会当
            // "OAuth 错误响应"去 JSON.parse 并报 "SDK auth failed: ... Unexpected identifier Not" 噪音
            // （功能不受影响，但 /mcp 面板显示不干净）。JSON 404 让无 OAuth 的判定干净落定。
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'not_found',
        message: 'This MCP server uses no OAuth (local anonymous). Use POST /mcp (Streamable HTTP).',
        mcp_endpoint: '/mcp',
        health: '/health'
      }));
      return;
    }

        // 读取请求体
    let body: any = undefined;
    if (req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      if (chunks.length > 0) {
                    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      }
    }

    try {
      const sid = req.headers['mcp-session-id'] as string | undefined;
      let transport = sid ? httpSessions.get(sid) : undefined;
      if (sid && transport) httpSessionActivity.set(sid, Date.now());

      if (!transport) {
        if (req.method === 'POST' && isInitializeRequest(body)) {
                    // 新会话：独立的 transport + 独立的 McpServer 实例（工具集相同，共享浏览器桥与全局状态）
          const newTransport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id: string) => {
              httpSessions.set(id, newTransport);
              httpSessionActivity.set(id, Date.now());
            }
          });
          newTransport.onclose = () => {
            if (newTransport.sessionId) {
              httpSessions.delete(newTransport.sessionId);
              httpSessionActivity.delete(newTransport.sessionId);
            }
          };
          const sessionServer = createServer();
          await sessionServer.connect(newTransport);
          transport = newTransport;
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
            id: null
          }));
          return;
        }
      }

      await transport.handleRequest(req, res, body);
    } catch (error: any) {
      console.error('[MCP-HTTP] 请求处理失败:', error);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null
        }));
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.on('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
                console.error(`[MCP] ❌ HTTP 端口 ${HTTP_PORT} 被占用——可能已有另一个 HTTP 模式实例在运行。`);
        console.error(`[MCP]    多客户端请共享同一实例；或设置环境变量 MCP_HTTP_PORT 使用其他端口。`);
        process.exit(1);
      }
      reject(err);
    });
    httpServer.listen(HTTP_PORT, '127.0.0.1', () => resolve());
  });
}

// ============== 启动服务器 ==============
async function main() {
    // 先初始化WebSocket服务器（stdio 模式下后台进行，不阻塞 MCP 握手——Claude Code 的握手超时很短，
  // 若因端口冲突重试导致握手延迟，会被判超时放弃连接，进程则沦为无人连接的孤儿）
  const wsInit = initWebSocketServer();

  const useHttp = process.argv.includes('--http') || process.env.MCP_HTTP === '1';
  if (useHttp) {
        // HTTP 模式：等 WS 就绪再对外服务（HTTP 客户端容忍度高；也避免"先报已启动后退出"的假窗口，审计 L5）
    await wsInit;
    await wsReady;
    await startHttpMcpServer();
        console.error("[MCP] Fush Vue MCP 服务器已启动 (HTTP 模式，多客户端共享)");
        console.error(`[MCP] MCP 端点: http://127.0.0.1:${HTTP_PORT}/mcp  健康检查: http://127.0.0.1:${HTTP_PORT}/health`);
    console.error("[MCP] 等待浏览器扩展连接到 ws://localhost:" + currentPort);
    return;
  }

  // stdio 模式：立即连接（协议握手优先），WS 绑定/重试在后台继续；
    // 若端口最终冲突失败，handleWsPortConflict 会 exit(1)——stdio 随之断开，客户端可感知
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[MCP] Fush Vue MCP 服务器已启动 (stdio 模式)");
  console.error("[MCP] 等待浏览器扩展连接到 ws://localhost:" + currentPort);
}

main().catch((error) => {
  console.error("[MCP] 启动失败:", error);
  process.exit(1);
});
