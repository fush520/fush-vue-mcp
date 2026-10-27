// ============== 加密捕获（Hook/登录加密/密钥注册表/解密） ==============
// P0-2 拆分自 index.ts——工具注册文本原样搬运，逻辑零改动。

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sendToBrowser } from "../transport.js";

export function register_crypto_tools(server: McpServer): void {
// 28. 启用加密 Hook 脚本
server.tool(
  "enable_encryption_hooks",
  "启用 RSA 和 CryptoJS 加密 Hook 脚本，用于捕获加密数据",
  {
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用活动标签页）"),
    hostname: z.string().optional().describe("目标 hostname（在该域名的标签页上执行）"),
  },
  async ({ tab_id: tabId, hostname }) => {
    try {
      const result = await sendToBrowser("ENABLE_ENCRYPTION_HOOKS", { tabId, hostname });
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
          text: `启用加密Hook失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);
// 29. 分析页面加密
server.tool(
  "analyze_page_encryption",
  "分析当前页面使用的加密库，并尝试从**内联脚本**里提取 PEM 密钥。`detectedEncryption` 由已探到的加密库证据推导（JSEncrypt/CryptoJS/forge/sjcl/aesjs/sm2/sm4 + 内联 RSA 密钥），不再是「只有搜到内联公钥才有值」。**覆盖范围有限**：密钥提取只扫内联脚本——密钥常由后端下发或藏在外链 bundle 里，`null`/未提取到**不代表**页面不加密，看返回体的 `scanCoverage`",
  {
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用活动标签页）"),
    hostname: z.string().optional().describe("目标 hostname（在该域名的标签页上执行）"),
  },
  async ({ tab_id: tabId, hostname }) => {
    try {
      const result = await sendToBrowser("ANALYZE_PAGE_ENCRYPTION", { tabId, hostname });
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
          text: `分析加密失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);
// 30. 自动登录并捕获加密数据
server.tool(
  "auto_login_and_capture",
  "自动填写登录表单并捕获加密数据（密码加密前后的值）",
  {
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用活动标签页）"),
    hostname: z.string().optional().describe("目标 hostname（在该域名的标签页上执行）"),
    username: z.string().describe("用户名"),
    password: z.string().describe("密码"),
    usernameSelector: z.string().optional().describe("用户名输入框选择器"),
    passwordSelector: z.string().optional().describe("密码输入框选择器"),
    submitSelector: z.string().optional().describe("登录按钮选择器"),
    waitTime: z.number().optional().describe("等待时间(毫秒)")
  },
  async ({ username, password, usernameSelector, passwordSelector, submitSelector, waitTime = 3000, tab_id: tabId, hostname }) => {
    try {
      const result = await sendToBrowser("AUTO_LOGIN_AND_CAPTURE", {
        username, password, usernameSelector, passwordSelector, submitSelector, waitTime, tabId, hostname }, waitTime + 5000);
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
          text: `自动登录失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);
// 32. RSA 解密
server.tool(
  "decrypt_rsa",
  "使用私钥解密 RSA 加密的数据",
  {
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用活动标签页）"),
    hostname: z.string().optional().describe("目标 hostname（在该域名的标签页上执行）"),
    encryptedData: z.string().describe("Base64编码的加密数据"),
    privateKey: z.string().describe("RSA私钥")
  },
  async ({ encryptedData, privateKey, tab_id: tabId, hostname }) => {
    try {
      const result = await sendToBrowser("DECRYPT_RSA", { encryptedData, privateKey, tabId, hostname });
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
          text: `RSA解密失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// 33. 从JS文件提取密钥 → 已由 V4.5 extract_keys_from_js（全 chunk 扫描版，定义在浏览器控制功能区）覆盖

// ============== V3.1：密码学能力注册表 + 签名重放 + 响应解密 ==============
// 33.5 列出页面捕获的密码学能力
server.tool(
  "crypto_registry",
  "列出页面内 Crypto_Capture 捕获的密码学能力（算法/密钥/函数引用）。sign_payload 重放前先调此工具查看可用的能力 ID 与密钥状态",
  {
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用活动标签页）"),
    hostname: z.string().optional().describe("目标 hostname（在该域名的标签页上执行）"),
  },
  async ({ tab_id: tabId, hostname }) => {
    try {
      const result = await sendToBrowser("GET_CRYPTO_REGISTRY", { tabId, hostname });
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
          text: `获取密码学能力失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);
// 33.6 签名重放（改参重放核心）
server.tool(
  "sign_payload",
  "使用页面捕获的密钥/加密函数对任意明文重算签名或加密——改参重放核心工具（密钥不出浏览器，直接调用页面内原始加密函数）。sign/encrypt/hash 时 payload 为明文字符串（JSON 对象请先 JSON.stringify）；decrypt 时 payload 为密文（hex/base64 字符串）",
  {
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用活动标签页）"),
    hostname: z.string().optional().describe("目标 hostname（在该域名的标签页上执行）"),
    payload: z.string().describe("要计算的内容：sign/encrypt/hash 传明文字符串；decrypt 传密文（hex 或 base64）"),
    capabilityId: z.string().optional().describe("能力ID（来自 crypto_registry 的 capabilities[].id）。不传则自动选择最近使用且与操作匹配的能力"),
    operation: z.enum(["sign", "encrypt", "decrypt", "hash"]).optional().describe("操作类型：sign=签名/HMAC，encrypt=加密，decrypt=解密，hash=哈希。默认 sign")
  },
  async ({ payload, capabilityId, operation, tab_id: tabId, hostname }) => {
    try {
      const result = await sendToBrowser("SIGN_PAYLOAD", { payload, capabilityId, operation: operation || "sign", tabId, hostname });
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
          text: `签名重放失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);
// 34. 一键分析登录加密（综合功能）
server.tool(
  "analyze_login_encryption",
  "一键分析登录页面的密码加密方式：启用Hook -> 自动登录 -> 捕获加密数据 -> 提取密钥 -> 尝试解密",
  {
    username: z.string().describe("测试用户名"),
    password: z.string().describe("测试密码"),
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用活动标签页）"),
    hostname: z.string().optional().describe("目标 hostname（在该域名的标签页上执行）")
  },
  async ({ username, password, tab_id: tabId, hostname }) => {
    try {
      const results: any = { steps: [] };

      // 步骤1: 启用加密Hook
      results.steps.push({ step: 1, action: "启用加密Hook" });
      await sendToBrowser("ENABLE_ENCRYPTION_HOOKS", { tabId, hostname });

      // 步骤2: 刷新页面
      results.steps.push({ step: 2, action: "刷新页面" });
      await sendToBrowser("REFRESH_PAGE", { hardRefresh: true, tabId, hostname });
      await new Promise(r => setTimeout(r, 2000));

      // 步骤3: 注入加密捕获器
      results.steps.push({ step: 3, action: "注入加密捕获器" });
      await sendToBrowser("INJECT_ENCRYPTION_CAPTURE", { tabId, hostname });

      // 步骤4: 分析页面加密
      results.steps.push({ step: 4, action: "分析页面加密库" });
      results.pageAnalysis = await sendToBrowser("ANALYZE_PAGE_ENCRYPTION", { tabId, hostname });

      // 步骤5: 自动登录
      results.steps.push({ step: 5, action: "自动登录并捕获" });
      results.loginResult = await sendToBrowser("AUTO_LOGIN_AND_CAPTURE", {
        username, password, waitTime: 3000, tabId, hostname
      }, 10000);

      // 步骤6: 获取捕获的加密数据
      results.steps.push({ step: 6, action: "获取加密数据" });
      results.encryptionData = await sendToBrowser("GET_CAPTURED_ENCRYPTION", { tabId, hostname });
      
      // 分析结果
      results.summary = {
        encryptionMethod: results.pageAnalysis?.detectedEncryption || "未知",
        hasPublicKey: !!results.pageAnalysis?.keys?.publicKey,
        hasPrivateKey: !!results.pageAnalysis?.keys?.privateKey,
        capturedDataCount: results.encryptionData?.length || 0
      };
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify(results, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `分析失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// ============== 智能化功能：反调试 ==============
}
