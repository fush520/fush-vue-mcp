// ============== 安全扫描（敏感数据监控/Burp 集成/认证分析） ==============
// P0-2 拆分自 index.ts——工具注册文本原样搬运，逻辑零改动。

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sendToBrowser } from "../transport.js";
import {
  analyzeSensitiveData,
} from "../helpers.js";

export function register_security_tools(server: McpServer): void {
// 52. 扫描 API 响应敏感数据
server.tool(
  "scan_sensitive_data",
  "扫描最近的API响应中是否包含敏感数据（身份证、手机号、银行卡、密码等）",
  {
    filter: z.string().optional().describe("URL过滤关键词"),
    patterns: z.array(z.enum(['idCard', 'phone', 'bankCard', 'email', 'chineseName', 'password', 'ipAddress', 'jwt', 'socialSecurity', 'all']))
      .optional()
      .describe("要检测的敏感数据类型，默认检测高风险类型。注：chineseName 为**锚点式**——只认姓名字段（姓名/realName/userName/contact 等）的值，不认任意中文词（裸姓名数组抓不到，这是刻意的：宽正则会把整段中文文案都报成疑似姓名）"),
    limit: z.number().int().min(1).max(1000).optional().describe("扫描的最大请求数量，默认20"),
    mask: z.boolean().optional().describe("是否对命中的取值脱敏，默认 **false**（原样返回——证据纪律：脱敏会让「我方打码」与「目标自己打码」在输出里分不清，而定级靠这个区分）。传 true 时输出会带 `maskedBy` 标明是谁脱的敏"),
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用活动标签页）"),
    hostname: z.string().optional().describe("目标 hostname（在该域名的标签页上执行）")
  },
  async ({ filter, patterns = ['idCard', 'phone', 'bankCard', 'password', 'jwt'], limit = 20, mask = false, tab_id: tabId, hostname }) => {
    try {
      // 获取网络请求（包含响应体）
      const requests = await sendToBrowser("GET_NETWORK_REQUESTS_WITH_BODY", { filter, limit, tabId, hostname });
      
      const results: Array<{
        url: string;
        method: string;
        status: number;
        sensitiveData: ReturnType<typeof analyzeSensitiveData>;
        alertLevel: string;
      }> = [];
      
      let totalCritical = 0;
      let totalHigh = 0;
      
      for (const req of requests) {
        // 分析响应体
        const responseBody = req.responseBody || '';
        const analysis = analyzeSensitiveData(responseBody, patterns, { mask });
        
        if (analysis.hasSensitiveData) {
          results.push({
            url: req.url,
            method: req.method,
            status: req.statusCode,
            sensitiveData: analysis,
            alertLevel: analysis.severity
          });
          
          totalCritical += analysis.summary.critical;
          totalHigh += analysis.summary.high;
        }
      }
      
      // 生成报告
      const report = {
        scanTime: new Date().toISOString(),
        totalScanned: requests.length,
        issuesFound: results.length,
        severity: {
          critical: totalCritical,
          high: totalHigh
        },
        alert: totalCritical > 0 ? "🚨 严重警告：发现敏感数据泄露！" : 
               totalHigh > 0 ? "⚠️ 警告：发现潜在敏感数据" : 
               "✅ 未发现敏感数据泄露",
        findings: results
      };
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify(report, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `扫描失败: ${error.message}` }],
        isError: true
      };
    }
  }
);
// 55. 实时监控敏感数据（开启监控模式）
server.tool(
  "start_sensitive_monitor",
  "开始实时监控所有API响应中的敏感数据泄露",
  {
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用活动标签页）"),
    hostname: z.string().optional().describe("目标 hostname（在该域名的标签页上执行）"),
    patterns: z.array(z.enum(['idCard', 'phone', 'bankCard', 'email', 'password', 'ipAddress', 'jwt', 'socialSecurity', 'all'])).optional().describe("要监控的敏感数据类型（all = 全部支持类型）。注：chineseName 已移除——中文姓名无可靠正则，'2-4 个汉字'会把常见词全算命中（幻觉数据）"),
    alertOnCritical: z.boolean().optional().describe("发现严重泄露时是否立即告警，默认true")
  },
  async ({ patterns = ['idCard', 'phone', 'bankCard', 'password'], alertOnCritical = true, tab_id: tabId, hostname }) => {
    try {
      const result = await sendToBrowser("START_SENSITIVE_MONITOR", { patterns, alertOnCritical, tabId, hostname });
      return {
        content: [{
          type: "text",
          // V4.9.22（修复）：原实现硬编码 success/message 并回显**用户传入的** patterns——
          // 传了不支持的类型时 AI 读到"已启动 + monitoringPatterns 含该类型"，而实际一个都没监控
          // （白名单陷阱）。现以 **client 返回为准**（它给 effectivePatterns / unsupportedPatterns / coverage）。
          text: JSON.stringify({
            alertOnCritical,
            ...result
          }, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `启动监控失败: ${error.message}` }],
        isError: true
      };
    }
  }
);
// 56. 获取敏感数据监控告警
server.tool(
  "get_sensitive_alerts",
  "获取敏感数据监控产生的告警信息",
  {
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用活动标签页）"),
    hostname: z.string().optional().describe("目标 hostname（在该域名的标签页上执行）"),
    limit: z.number().int().min(1).max(500).optional().describe("返回的最大告警数量，默认50"),
    severityFilter: z.enum(['critical', 'high', 'medium', 'low', 'all']).optional().describe("严重级别过滤")
  },
  async ({ limit = 50, severityFilter = 'all', tab_id: tabId, hostname }) => {
    try {
      const result = await sendToBrowser("GET_SENSITIVE_ALERTS", { limit, severityFilter, tabId, hostname });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `获取告警失败: ${error.message}` }],
        isError: true
      };
    }
  }
);


// ============== 敏感数据泄露检测功能 ==============
// 40. 分析认证机制
server.tool(
  "analyze_authentication",
  "分析页面的认证机制（Cookie、localStorage中的token、JWT解析等）",
  {
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用活动标签页）"),
    hostname: z.string().optional().describe("目标 hostname（在该域名的标签页上执行）"),
  },
  async ({ tab_id: tabId, hostname }) => {
    try {
      const result = await sendToBrowser("ANALYZE_AUTHENTICATION", { tabId, hostname });
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

// ============== 智能化功能：表单自动化 ==============
}
