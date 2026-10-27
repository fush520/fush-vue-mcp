// ============== 共享辅助函数与判定引擎 ==============
// P0-2 拆分自 index.ts——纯机械搬运，逻辑零改动。
// 判定引擎（三态：BYPASSED / ENFORCED / UNCLEAR）、chunk 抓取、TLS 降级、
// base 归一化、SaaS 指纹、敏感信息模式。工具注册（index.ts）按需 import。

import { sendToBrowserRetry, sendToBrowser, type TabScope } from "./transport.js";

export let jsChunksCache: { chunks: any[]; at: number; origin: string; key: string } | null = null;

export let insecureTlsRefs = 0;


// 登录墙识别：200 但返回的是登录页/登录表单 → 实际是 ENFORCED（防"200 假放行"）
export function detectLoginWall(body: string): { isLoginWall: boolean; evidence: string[] } {
  if (!body) return { isLoginWall: false, evidence: [] };
  const lower = body.toLowerCase();
  const isHtml = /<html|type="password"|<form/i.test(body);
  const keywords = ['password', 'passwd', '请输入密码', '验证码', 'captcha', 'verifycode', '登录', 'signin', 'sign in', 'loginform', 'userlogin'];
  const hits = keywords.filter(k => lower.includes(k));
  // HTML 页面 + ≥2 个登录特征 = 登录墙
  return { isLoginWall: isHtml && hits.length >= 2, evidence: hits };
}



// JSON 结构扁平化（path=类型），剔除易变字段值，只比较结构
export function flattenJsonPaths(obj: any, prefix = '', out: Set<string> = new Set()): Set<string> {
  const walk = (o: any, p: string) => {
    if (o === null || o === undefined) { out.add(p + '=null'); return; }
    if (typeof o !== 'object') { out.add(`${p}=${typeof o}`); return; }
    if (Array.isArray(o)) {
      out.add(p + '=array');
      if (o.length > 0) walk(o[0], p + '[]');
      return;
    }
    for (const k of Object.keys(o)) {
      // 易变字段：时间戳/uuid/随机值/csrf —— 仅记录存在性（=volatile）
      if (/^(timestamp|time|date|createdAt|updatedAt|uuid|id|_id|csrf|nonce|requestId|sign|signature|random)$/i.test(k)) {
        out.add(`${p}.${k}=volatile`);
        continue;
      }
      walk(o[k], p ? `${p}.${k}` : k);
    }
  };
  walk(obj, prefix);
  return out;
}



// JSON 结构相似度（Jaccard）
export function jsonSimilarity(a: any, b: any): number {
  try {
    const pa = flattenJsonPaths(a);
    const pb = flattenJsonPaths(b);
    let inter = 0;
    for (const x of pa) if (pb.has(x)) inter++;
    const union = pa.size + pb.size - inter;
    return union === 0 ? 0 : inter / union;
  } catch (e) {
    return -1;
  }
}



// 尝试解析 JSON（截断样本可能不完整）
export function tryParseJson(body: string): any | null {
  if (!body) return null;
  try { return JSON.parse(body); } catch (e) { /* 截断样本解析失败 */ }
  // 截断样本：尝试从 HTML 中提取内联 JSON？不，保持简单
  return null;
}

interface UnauthorizedVerdict {
  verdict: "BYPASSED" | "ENFORCED" | "UNCLEAR";
  confidence: "high" | "medium" | "low";
  rule: string;
  evidence: string;
}



// 判定规则链（基于匿名请求结果）
export function judgeUnauthorized(anonResult: any): UnauthorizedVerdict {
  // V4.9.22（修复🟡-2，审计指出）：页面侧"写方法不重发"的如实错误**必须先特判**——该错误对象
  // **故意不带 status**（带了 status:0 会命中 anonFetchWithServerFallback 的重发条件，见 mcp-client.js
  // 的 pageSideUnresolved 注释），若不特判就会一路落到末尾兜底、输出 "状态码 undefined, undefined 字节"，
  // 把 error 正文与 sideEffectWarning（"服务端可能已受理"）全抹掉——AI 反而更容易手工重跑那个写请求。
  if (anonResult && anonResult.sideEffectWarning) {
    return {
      verdict: "UNCLEAR", confidence: "low",
      rule: "页面侧未执行/未回读（写方法不重发以防重复副作用）",
      evidence: `${anonResult.error || '未知原因'} | ${anonResult.sideEffectWarning}`
    };
  }

  // V4.9.24（清单🟡-14）：`bodySize` 是**字符数**（生产侧一律 `text.length`），而下方证据文案原写作
  // "字节"——中文响应下二者差约 3 倍，AI 会把 200 字符的短响应读成"600 字节，有内容"。
  // 这里**只修口径不改数值**：阈值（2000/500/200）本就是按字符调出来的，且"内容够不够"用字符衡量
  // 更贴语义（真实字节数会因中文编码虚高 3 倍，反而把短响应判成实质内容）。改字节属**口径变更**，
  // 会让既有判定翻转，不在本轮范围。
  const { status, contentType, location, bodySize, bodySample, sensitiveHits } = anonResult;

  // 规则0（V4.9.28）：**响应体读取失败**——这是**证据不足**，必须与"内容本来就少"区分开。
  // 生产侧（mcp-client.js 的 anonFetch 两个分支）原先静默忽略读体失败，于是
  // bodySize:0 / bodySample:'' 与"响应体确实是空"完全同形，本函数会一路落到规则7
  // 报「可能是 SPA 空壳，需页内渲染后确认」——把"没读到"错误归因成"内容少"，
  // AI 据此放弃深挖。注意**不是** ENFORCED：响应确实返回了（status 有值），
  // 只是内容未知，所以定 UNCLEAR 并在证据里写明"勿据此认为没有数据泄露"。
  if (anonResult.bodyReadError) {
    return {
      verdict: "UNCLEAR", confidence: "low",
      rule: "响应体读取失败（非内容为空）",
      evidence: `HTTP ${status} 已返回，但读取响应体时异常：${anonResult.bodyReadError}——本次**无法判断**响应内容`
    };
  }

  // 规则1：网络失败/超时
  if (status === 0) {
    return { verdict: "UNCLEAR", confidence: "low", rule: "网络错误", evidence: anonResult.error || "请求失败" };
  }

  // 规则2：显式拒绝状态码
  if ([401, 403, 407].includes(status)) {
    return { verdict: "ENFORCED", confidence: "high", rule: `HTTP ${status} 显式拒绝`, evidence: `状态码 ${status}` };
  }
  if (status === 404) {
    return { verdict: "ENFORCED", confidence: "high", rule: "HTTP 404 不存在", evidence: "状态码 404（路由不存在或未启用）" };
  }

  // 规则3：3xx 重定向（可能跳登录页）。保留兼容——SW 侧改为 follow 后正常不会走到这里
  if (status >= 300 && status < 400) {
    const toLogin = /login|signin|auth|sso/i.test(location || '');
    return toLogin
      ? { verdict: "ENFORCED", confidence: "high", rule: "302 重定向到登录页", evidence: `Location: ${location}` }
      : { verdict: "UNCLEAR", confidence: "medium", rule: `HTTP ${status} 重定向`, evidence: `Location: ${location || '未知'}` };
  }

  // 规则3.5（V4.9.11 验收修复 A11）：**跟随重定向后的落点判定**。
  // 背景：fetch 的 redirect:'manual' 在规范下返回 opaqueredirect（status=0、location 不可读），
  // 实测把真实 302 全报成"网络错误"——规则3 因此永不触发，"302 跳登录页"这一最明确的
  // 未授权信号被吞掉。SW 侧已改 redirect:'follow'，这里用 redirected + finalUrl 把它复原。
  // 注意：落点**非登录页**时**不提前返回**——后续可能仍返回真实数据（如 302 到业务页再吐数据），
  // 提前 return UNCLEAR 会造成漏报，交由后续规则继续判
  if (anonResult.redirected && anonResult.finalUrl) {
    // 批2审计 M1：词表收紧为**路径段匹配**——原子串匹配把落点为 /api/auth/userinfo 这类
    // 带 auth 字样的数据接口也当登录页压掉（真数据被吞，漏报方向）。
    // auth 词命中时降 medium（可能仍需人工看），login/signin/sso/passport 词保持 high。
    const finalUrl = anonResult.finalUrl;
    const strongLogin = /(?:^|\/)(?:login|signin|sso|passport)(?:[\/?#]|$)/i.test(finalUrl);
    const weakAuth = /(?:^|\/)auth(?:[\/?#]|$)/i.test(finalUrl);
    if (strongLogin || weakAuth) {
      return {
        verdict: "ENFORCED", confidence: strongLogin ? "high" : "medium",
        rule: "重定向到登录页（跟随重定向后的落点）",
        evidence: `最终 URL: ${finalUrl}`
      };
    }
  }

  // 规则4：200 但实际是登录墙（200 假放行）
  const loginWall = detectLoginWall(bodySample || '');
  if (loginWall.isLoginWall) {
    return { verdict: "ENFORCED", confidence: "high", rule: "200 但返回登录页（登录墙）", evidence: `命中登录特征: ${loginWall.evidence.join(', ')}` };
  }

  // 规则4.5（V4.9.2 修复）：HTTP 200 + JSON 业务层拒绝——若依/国产框架惯用
  // "HTTP 200 + body.code=401/403" 表达认证失败。实测 某高校（a.example.edu.cn）sweep：
  // 7 个接口返回 {"code":401,"msg":"认证失败，无法访问系统资源"} 被规则5.5 误判 BYPASSED/high（假阳性）。
  // 拒绝响应通常极短（<2000 字节），长度限制防正常数据含"无权限"字样被误伤。
  if (status === 200 && /json/i.test(contentType || '') && (bodySize || 0) < 2000) {
    let parsed: any = null;
    try { parsed = JSON.parse((bodySample || '').trim()); } catch { /* 截断样本解析失败，走文案兜底 */ }
    const bizCode = parsed && (parsed.code ?? parsed.status ?? parsed.state);
    if ([401, 403, '401', '403'].includes(bizCode)) {
      return { verdict: "ENFORCED", confidence: "high", rule: `200 + 业务层 ${bizCode} 拒绝`, evidence: `body.code=${bizCode}` };
    }
    // V4.9.11（验收修复 A10）：拒绝文案**优先限定在 msg/message 等文案字段内**匹配——
    // 原实现在**整个响应体**做子串匹配：真泄露的数据里若含"未登录/无权限"字样（用户列表的备注、
    // 工单标题、公告正文等），会被判 ENFORCED → **把真漏洞判没**。这是"宁可误报不可漏报"的
    // 反面案例，对渗透测试是致命的。解析出文案字段时只看该字段（high）；无文案字段时才回退
    // 全文匹配并**降为 medium**（medium 不进 highRisk 列表，不会污染高危结论）
    const rejectionWords = ['认证失败', '未登录', '请先登录', '登录已过期', 'token失效', 'token 失效', 'token过期', '无权限', '权限不足', '未授权', 'unauthorized', 'not logged in', 'authentication failed', 'access denied', 'invalid token', 'token expired', 'permission denied', 'no permission'];
    const msgFieldText = parsed
      ? [parsed.msg, parsed.message, parsed.error, parsed.errorMessage, parsed.errMsg]
          .filter((v: any) => typeof v === 'string').join(' ')
      : '';
    const hasMsgField = msgFieldText.length > 0;
    // 无文案字段时的全文兜底：**仅限极短响应**（<200 字节——真正的拒绝响应都短）。
    // 否则跳过本规则、交给后续的敏感字段/JSON 特征规则——避免"响应数据里恰好含拒绝词"
    // 压过数据泄露判定（那正是本函数要防的漏报方向）。
    // 本规则跑在规则5(敏感字段)之前，若不设这个闸，{"data":[{"remark":"未登录"}]} 类响应会被判 ENFORCED
    const allowFullTextFallback = !hasMsgField && (bodySize || 0) < 200;
    if (hasMsgField || allowFullTextFallback) {
      const matchScope = hasMsgField ? msgFieldText : (bodySample || '');
      const hitWords = rejectionWords.filter(w => matchScope.toLowerCase().includes(w.toLowerCase()));
      if (hitWords.length > 0) {
        // 批2审计 M4：data 非空时**不提前 return**——{"error":"token失效","data":[真实数据]} 类
        // 矛盾响应里数据是真的（部分数据接口的常见形态），ENFORCED/high 会把真漏洞判没。
        // 空数据照旧 ENFORCED/high；非空时跳过本规则交给规则5（敏感字段判定）
        const dataNotEmpty = !!parsed && parsed.data != null &&
          !(typeof parsed.data === 'object' && !Array.isArray(parsed.data) && Object.keys(parsed.data).length === 0) &&
          !(Array.isArray(parsed.data) && parsed.data.length === 0);
        if (!dataNotEmpty) {
          return {
            verdict: "ENFORCED",
            confidence: hasMsgField ? "high" : "medium",
            rule: hasMsgField ? "200 + 业务层拒绝文案（msg 字段）" : "200 + 业务层拒绝文案（全文匹配，短响应兜底）",
            evidence: `命中: ${hitWords.join(', ')}`
          };
        }
        // data 非空：响应含拒绝文案但确有数据——落入规则5 判敏感字段；此处不 return
      }
    }
    // V4.9.11（实站实测 app.example.com）：业务层**错误码**识别——实测登录接口返回
    // {"code":400,"msg":"请求参数不正确:密码长度为 4-16 位"} / {"code":500,"msg":"系统异常"}，
    // 被规则 5.5 判成 BYPASSED/high 假高危。参数校验失败/服务端异常说明请求根本没进入业务逻辑，
    // 且 data 为 null（无任何数据）——不构成"匿名可读 JSON API 数据"，如实标 UNCLEAR
    // V4.9.11（验收修复 A15）：字符串码补齐 '502'/'503'——原列表只到 '500'，
    // 网关返回 {"code":"502","msg":"bad gateway","data":null} 会漏到规则 5.5 被抬成 BYPASSED/high 假高危
    // V4.9.11（验收修复 A19）：空 data 判据放宽到"null / 空对象 / 空数组"——部分框架把错误
    // 序列化成 data:{}，原来只认 == null 会漏过，同样被抬成 BYPASSED/high
    // 注：**不**动 code=200 + data=null 的情况——那是"接口存在但无数据"，判 BYPASSED/medium
    // 有信息价值（接口面探测），一律降 UNCLEAR 反而会漏报接口存在性
    // V4.9.11（实战驱动修复 S6-b）：补"空分页结构"——实测该站分页接口在无数据时返回
    // {"code":0,"data":{"list":[],"total":0}}，data 本身是**非空对象**（有 list/total 两个键），
    // 原先的 isEmptyData 判不到，被抬成 BYPASSED/high 假高危（零权限账号在该模块无数据而已）
    const isEmptyPagedData = !!parsed && parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data)
      && Array.isArray(parsed.data.list) && parsed.data.list.length === 0
      && (parsed.data.total === 0 || parsed.data.total === undefined);
    const isEmptyData = !!parsed && (
      parsed.data == null ||
      (typeof parsed.data === 'object' && !Array.isArray(parsed.data) && Object.keys(parsed.data).length === 0) ||
      (Array.isArray(parsed.data) && parsed.data.length === 0) ||
      isEmptyPagedData
    );
    // V4.9.11（实战驱动修复 S6）：补 404 与"成功码 + 空数据"两种形态——实测 app.example.com 认证态扫描时，
    //   · {"code":404,"msg":"请求地址不存在:admin-api/mall/home"}          → 被抬成 BYPASSED/high 假高危
    //   · {"code":0,"data":[],"msg":"操作成功"}（账号在该模块无数据）      → 同上
    // 两者都无任何数据可泄露。404 是"接口不存在"，空 data 是"没数据"，都不构成"可读 JSON 数据"
    // 含 0/'0'（成功码）：`isEmptyData` 已保证 data 为空（null/{} /[]），故"成功但无数据"同样
    // 无可泄露——注意 data 非空时 isEmptyData 为 false，本分支不会命中，不影响正常判定
    // 含 501（实测该站用它表示"模块已禁用"，如 [CRM 模块 ylc-module-crm - 已禁用]——同样 data:null 无数据）
    if (isEmptyData && [0, 400, 404, 422, 500, 501, 502, 503, '0', '400', '404', '422', '500', '501', '502', '503'].includes(bizCode)) {
      const isSuccessCode = bizCode === 0 || bizCode === '0';
      return {
        verdict: "UNCLEAR", confidence: "medium",
        rule: isSuccessCode
          ? "响应成功但数据为空（无内容可泄露——如账号在该模块无数据）"
          : `业务层错误码 ${bizCode}（请求未进入业务逻辑，非数据泄露）`,
        evidence: `body.code=${bizCode}, msg=${String(parsed.msg || parsed.message || '').slice(0, 80)}`
      };
    }
  }

  // 规则4.6：200 + HTML 文档 = SPA fallback/前端路由——HTML 响应不是 API 数据。
  // 批2审计 H2：本规则**必须先于规则5（敏感字段）执行**——原顺序下 200 HTML 页内嵌的
  // JSON-LD/内联 state（键带引号，命中敏感字段正则）会在规则5 被判 BYPASSED/high，
  // 规则4.6 的 HTML 降级被架空。同时放宽起始判据（前置注释/BOM 开头的 SPA 壳，批2审计 L1/L3）
  if (status === 200 && /html/i.test(contentType || "") && /^\s*(?:\ufeff|<!--[\s\S]{0,200}?-->\s*)*<(!doctype|html|head|body)/i.test((bodySample || "").trimStart())) {
    return { verdict: "UNCLEAR", confidence: "low", rule: "200 HTML 页面（SPA fallback，非 API 端点）", evidence: `content-type ${contentType}，响应为 HTML 文档` };
  }

  // 规则5：200 + JSON 数据 + 敏感字段命中
  if (status === 200 && sensitiveHits && sensitiveHits.length > 0) {
    return {
      verdict: "BYPASSED", confidence: "high",
      rule: "匿名可读且响应含敏感字段", evidence: `命中 ${sensitiveHits.length} 个敏感字段，如: ${sensitiveHits.slice(0, 3).join(' | ')}`
    };
  }

  // 规则5.5：200 + 结构化 JSON API 响应——SPA 空壳是 HTML（<!DOCTYPE 开头），合法 JSON 数据接口
  // 几乎不可能是空壳。修复实测发现的误伤：375 字节的 JSON 配置接口被"内容极少"规则错判 UNCLEAR
  if (status === 200 && /json/i.test(contentType || '') && (bodySample || '').trimStart().startsWith('{')) {
    // 批2审计 H1/L2：**结构性闸**——解析成功且 data 为空（null/空对象/空数组/空分页）时，
    // 无论 code 是什么值（含 -1/405/任意字符串码/无 code 字段），都无数据可泄露：
    //   · code 非成功值 → UNCLEAR（业务层拒绝/错误，非泄露）
    //   · code 是成功值（0/200/无 code 但 success:true）→ BYPASSED 但**降 medium**（接口面价值有限）
    // 白名单枚举式修法（A15/A19/S6）追不完长尾，这是结构性收口。
    let parsed55: any = null;
    try { parsed55 = JSON.parse((bodySample || '').trim()); } catch { /* 截断样本 */ }
    if (parsed55 && typeof parsed55 === 'object') {
      const code55 = parsed55.code ?? parsed55.status ?? parsed55.state;
      const d55 = parsed55.data;
      const emptyPaged55 = !!d55 && typeof d55 === 'object' && !Array.isArray(d55)
        && Array.isArray(d55.list) && d55.list.length === 0 && (d55.total === 0 || d55.total === undefined);
      const empty55 = d55 == null
        || (typeof d55 === 'object' && !Array.isArray(d55) && Object.keys(d55).length === 0)
        || (Array.isArray(d55) && d55.length === 0)
        || emptyPaged55;
      const isOkCode = code55 === undefined || code55 === 0 || code55 === 200 || code55 === '0' || code55 === '200'
        || code55 === 'success' || parsed55.success === true;
      if (empty55 && !isOkCode) {
        return {
          verdict: "UNCLEAR", confidence: "medium",
          rule: `业务层码 ${String(code55)} + 空数据（无内容可泄露）`,
          evidence: `body.code=${String(code55)}, msg=${String(parsed55.msg || parsed55.message || '').slice(0, 80)}`
        };
      }
      if (empty55 && isOkCode) {
        return {
          verdict: "BYPASSED", confidence: "medium",
          rule: "匿名可读 JSON API 数据（响应成功但数据为空）",
          evidence: `HTTP 200 JSON 响应，data 为空，${bodySize} 字符`
        };
      }
    }
    const apiKeys = ['"code"', '"data"', '"rows"', '"msg"', '"list"', '"total"', '"records"', '"success"', '"result"', '"items"', '"token"'];
    const keyHits = apiKeys.filter(k => (bodySample || '').includes(k));
    if (keyHits.length >= 1) {
      return {
        verdict: "BYPASSED",
        confidence: keyHits.length >= 2 ? "high" : "medium",
        rule: "匿名可读 JSON API 数据",
        evidence: `HTTP 200 JSON 响应含 API 特征键: ${keyHits.slice(0, 4).join(', ')}，${bodySize} 字符`
      };
    }
  }

  // 规则6：200 + 实质内容（非空壳、非静态资源误判）
  if (status === 200 && (bodySize || 0) > 500) {
    // 批2审计 M2：原实现对 contentType 测文件扩展名（恒 false 死检查）——改测 URL 路径 + MIME 前缀
    const urlForStatic = String(anonResult.finalUrl || anonResult.url || '');
    const isStatic = /\.(js|css|png|jpg|svg|woff|ico)(\?|#|$)/i.test(urlForStatic) || /(?:javascript|image\/|font\/|text\/css)/i.test(contentType || '');
    if (!isStatic) {
      return {
        verdict: "BYPASSED", confidence: "medium",
        rule: "匿名可访问且返回实质内容", evidence: `HTTP 200, ${bodySize} 字符, ${contentType || '未知类型'}（需人工确认是否应为受保护资源）`
      };
    }
  }

  // 规则7：200 但内容极少（可能是空壳/加载中页面）
  if (status === 200) {
    return { verdict: "UNCLEAR", confidence: "low", rule: "200 但内容极少", evidence: `仅 ${bodySize} 字符（可能是 SPA 空壳，需页内渲染后确认）` };
  }

  return { verdict: "UNCLEAR", confidence: "low", rule: `HTTP ${status} 未覆盖`, evidence: `状态码 ${status}, ${bodySize} 字符` };
}



// 后台框架路由指纹字典（路由前缀 + API 特征 → 框架识别）
export const FRAMEWORK_FINGERPRINTS: Array<{
  name: string;
  routePrefixes: string[];
  apiPatterns: RegExp[];
  note: string;
}> = [
  {
    name: '若依 RuoYi (Vue2/Vue3)',
    routePrefixes: ['system/user', 'system/role', 'system/menu', 'system/dept', 'monitor/online', 'monitor/job', 'tool/gen'],
    apiPatterns: [/\/prod-api\//, /\/dev-api\//],
    note: '常见管理后台：/system/user 用户管理、/system/role 角色管理、/monitor/online 在线用户、/tool/gen 代码生成'
  },
  {
    name: 'renren-fast',
    routePrefixes: ['sys/user', 'sys/role', 'sys/menu', 'sys/log', 'sys/config'],
    apiPatterns: [/\/sys\/login/, /\/renren-fast\//],
    note: '人人开源后台'
  },
  {
    name: 'eladmin',
    routePrefixes: ['system/user', 'system/menu', 'system/dept', 'system/job', 'monitor/log'],
    apiPatterns: [/\/api\/system\//, /\/auth\/code/, /\/auth\/login/],
    note: 'eladmin 后台：前端 vue-element-admin 风格，后端 /api/system/*'
  },
  {
    name: 'pig / pigx',
    routePrefixes: ['admin/user', 'admin/menu', 'admin/role', 'admin/dept', 'admin/tenant'],
    apiPatterns: [/\/auth\/oauth\//, /\/admin\/user/],
    note: 'pig 微服务后台（Spring Cloud）'
  },
  {
    name: 'jeecg-boot',
    routePrefixes: ['system/user', 'system/roleList', 'system/depart', 'jeecg/', 'jmreport/'],
    apiPatterns: [/\/jeecg-boot\//, /\/sys\/randomImage/],
    note: 'JeecgBoot 低代码平台'
  },
  {
    name: 'vue-element-admin',
    routePrefixes: ['permission', 'table/complex', 'example', 'nested/menu', 'form/index'],
    apiPatterns: [/\/vue-element-admin\//, /\/v1\.0\//],
    note: 'vue-element-admin 演示/二次开发框架'
  },
  {
    name: 'gin-vue-admin',
    routePrefixes: ['system/user', 'system/menu', 'example', 'superAdmin'],
    apiPatterns: [/\/base\/login/, /\/api\/getSystemConfig/],
    note: 'Gin-Vue-Admin（Go 后端）'
  },
  {
    name: 'avue-cli',
    routePrefixes: ['system/user', 'system/role', 'system/menu', 'wel/index'],
    apiPatterns: [/\/admin\//],
    note: 'avue 低代码后台（若依系）'
  }
];



// 敏感路由模式（用户/权限管理类，未授权测试优先目标）
export const SENSITIVE_ROUTE_RE = /(system|sys|admin|monitor|tool|permission|auth)\/(user|role|menu|dept|dict|config|job|notice|log|online|gen|tenant|account|perm)/i;



// chunk 内模块路径提取（组件文件路径，用于路由关联）
export const MODULE_PATH_RE = /["'`]((?:\.\.?\/|@\/|~\/|src\/)?(?:views|pages|components|layout|layouts)\/[a-zA-Z0-9_\-@/]+\.(?:vue|jsx|tsx|js|ts))["'`]/g;



// chunk 内 API 路径提取
export const API_PATH_RE = /["'`](\/(?:api|prod-api|dev-api|admin-api|apis|auth|oauth|v1|v2|v3|sys|system|monitor|tool|gen|common|login|logout|user|role|menu|dept|dict|config|job|notice|log|permission|profile|register|captcha|upload|tenant)[/a-zA-Z0-9_.\-{}:$]{1,100})["'`]/g;



export const RESOURCE_EXT_RE = /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|map|html?)(\?|$)/i;


export const NOISE_PATH_RE = /(\/vendor\/|\/static\/|\/node_modules\/|\/assets\/|\/_nuxt\/|\/chunk-|\/chunks\/|\/img\/|\/images\/)/i;



// 归一化路径：去 ./ @/ src/ 前缀、去 .vue 等后缀、反斜杠转正斜杠、去首尾斜杠
export function normalizePath(p: string): string {
  return String(p || '')
    .replace(/\\/g, '/')
    .replace(/^\.\.?\//, '')
    .replace(/^[@~]?\//, '')
    .replace(/^src\//, '')
    .replace(/^views\//, '')
    .replace(/^pages\//, '')
    .replace(/\.(vue|jsx|tsx|js|ts)$/i, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}


// V4.9.27（作用域补漏）：收 scope 并**全程透传**——原签名只收 maxChunks，两个出站调用
//（GET_PAGE_INFO / GET_JS_CHUNKS）都拿不到作用域，于是 `get_chunk_source` 永远作用于
// 活动标签。而客户端 getJSChunks 在 V4.9.26 已经具备"显式指定失败即上抛、不静默降级"的
// 能力，工具层却传不进 tabId——那段修复**在链上不可达**，正是本项目反复批判的
//「修复在半路被架空」。这里是断头的第二跳（第一跳：工具 schema 未暴露参数）。
export async function getJSChunksCached(
  maxChunks = 200,
  scope: { tabId?: number; hostname?: string } = {}
): Promise<{ chunks: any[]; hostFilterDisabled?: boolean; hostFilterNote?: string }> {
  // 批2审计 M3：缓存键加当前页 origin——原实现只有 60s TTL，跨站切换（导航/换标签）后
  // 60s 内返回 A 站的 chunk 清单，API 提取整体作废且不报错
  let pageOrigin = '';
  let pageTabId: number | undefined;
  try {
    // V4.9.27：作用域随 GET_PAGE_INFO 一起传——否则 origin 取的是**活动标签**的 URL，
    // 后面的缓存键与来源判断会照着错误的标签页计算（noActivate 语义不变）
    const info = await sendToBrowserRetry("GET_PAGE_INFO", { tabId: scope.tabId, hostname: scope.hostname }, 15000, 0);
    pageOrigin = String(info?.url || '').replace(/^(https?:\/\/[^/]+).*$/, '$1');
    pageTabId = typeof info?.tabId === 'number' ? info.tabId : undefined;
  } catch { /* 取不到页面信息就跳过缓存命中判断的 origin 部分 */ }
  // V4.9.27（缓存键补漏）：原键只有 origin，而 origin 来自上面那次调用——它一旦失败
  // pageOrigin 就是空串，两个**不同**标签页的调用会双双命中同一个空键缓存（跨标签页
  // 误用 chunk 清单且不报错）。现纳入标签页身份，且**拿不到 origin 就不读也不写缓存**：
  // 宁可多拉一次，不可跨标签页误用。
  const cacheKey = `${pageOrigin}|${pageTabId ?? scope.tabId ?? ''}|${scope.hostname || ''}`;
  if (pageOrigin && jsChunksCache && Date.now() - jsChunksCache.at < 60000
      && jsChunksCache.chunks.length > 0 && jsChunksCache.key === cacheKey) return jsChunksCache;
  const list: any = await sendToBrowserRetry("GET_JS_CHUNKS", { maxChunks, tabId: scope.tabId, hostname: scope.hostname }, 30000, 2);
  const chunks = list?.chunks || [];
  if (pageOrigin) jsChunksCache = { chunks, at: Date.now(), origin: pageOrigin, key: cacheKey };
  return {
    chunks,
    // V4.9.28：降级路径"hostname 过滤未生效"的标记必须**透传给调用方**——
    // 客户端标了、这里丢掉，就等于没修（本项目反复踩的"修复在半路被架空"）
    ...(list?.hostFilterDisabled
      ? { hostFilterDisabled: true, hostFilterNote: list.hostFilterNote }
      : {})
  };
}


export const _tlsEnvPrev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;


export function enterInsecureTls() {
  insecureTlsRefs++;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}


export function exitInsecureTls() {
  insecureTlsRefs = Math.max(0, insecureTlsRefs - 1);
  if (insecureTlsRefs === 0) {
    if (_tlsEnvPrev === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = _tlsEnvPrev;
  }
}


export const TLS_ERR_RE = /certificate|altname|self.signed|unable to verify|CERT_|SSL|TLS/i;


// V4.9.11（实站实测 app.example.com）：base 前缀的**完整 URL 形态**——芋道等框架把后端地址配成
// {base_url:"https://api.example.com/admin-api"}（构建后为字面量），而原 baseLike 正则只认路径形态
// （/admin-api）→ 提取不到 → 候选 URL 拼错（打到 SPA fallback 拿假 200 HTML）。两处共用（未授权扫描 / 路由图谱）
// V4.9.11（验收修复 A20）：补常见命名 VITE_API_URL / VITE_BASE_URL / VITE_APP_API_URL / API_BASE_URL——
// 原列表漏它们，用这些命名的站点提不到 base（影响=候选变少，不是出错）
export const BASE_CFG_RE = /(?:base_url|baseURL|baseUrl|base_api|baseApi|VITE_APP_BASE_API|VITE_GLOB_API_URL|VITE_API_URL|VITE_BASE_URL|VITE_APP_API_URL|API_BASE_URL)\s*[:=]\s*["'`]([^"'`\s]{2,120})["'`]/g;


// V4.9.12（实测 ng-alain.com 驱动）：第三方 CDN / 静态资源站的地址是**资源加载基址**
//（TinyMCE 的 baseURL: "https://cdnjs.cloudflare.com/ajax/libs/tinymce/4.9.2/"、Monaco loader 的
// paths），不是 API 后端前缀。被当成 base 参与组合会产出
// `/ajax/libs/tinymce/4.9.2/user/:id`、`/npm/monaco-editor/min/docs/xxx` 这类垃圾候选
//（该站 38 条），白占 60 条配额，还会让 AI 以为这些路径真实存在。
// 判据用 **host** 而非路径词表：芋道类站点的 base 是**异域业务域名**（api.example.com/admin-api，
// 与被测站不同源但必须保留），只有"公共 CDN"这一条能干净地区分二者。
export const CDN_ASSET_HOST_RE = /(?:^|\.)(?:unpkg\.com|jsdelivr\.net|cdnjs\.cloudflare\.com|bootcdn\.net|staticfile\.org|googleapis\.com|gstatic\.com|jquery\.com|bootstrapcdn\.com|alicdn\.com)$/i;


// 从 base 配置值归一化出路径前缀：完整 URL 取 pathname，路径形态直接用
export function normalizeBaseCfg(raw: string): string {
  try {
    let bp = raw;
    // V4.9.11（验收修复 A20）：**协议相对值**（`//host/api`）也要按 URL 解析取 pathname——
    // 原判据只认 ^https?://，`//x` 会原样返回，后续拼成 `origin + "//x/..."` 的坏 URL，候选全废
    // V4.9.12：两个分支合并；解析失败改为**丢弃**（原实现保持原样，正是 A20 要修的那种坏值来源）
    if (/^https?:\/\//i.test(raw) || /^\/\//.test(raw)) {
      const u = new URL(/^\/\//.test(raw) ? 'https:' + raw : raw);
      if (CDN_ASSET_HOST_RE.test(u.hostname)) return '';
      bp = u.pathname;
    }
    const clean = (bp || '').replace(/\/$/, '');
    if (clean && clean !== '/' && clean.length <= 60 && clean.startsWith('/')) return clean;
  } catch (e) { /* 非法值忽略 */ }
  return '';
}


// 错误详情透传：原实现只取 e.message（浏览器的 fetch 恒为 "fetch failed"），
// 真实原因（ERR_TLS_CERT_ALTNAME_INVALID / ECONNREFUSED / DNS 失败）全被吞掉，排查困难
export function errDetail(e: any): string {
  const cause = e && e.cause && (e.cause.message || e.cause.code);
  const base = e && e.name === 'AbortError' ? '超时' : String((e && e.message) || e);
  return cause ? `${base} (${cause})` : base;
}


// 带 TLS 降级的 fetch：首次失败若是证书类问题 → 自动降级重试一次
// V4.9.22（复验⚪）：**不变量——本函数内部会对"证书类错误"自动降级重试一次，调用方不得传入非只读 method**。
// 该不变量当前成立，只因为唯一带 method 的调用点（anonFetchWithServerFallback）已被 isReadOnlyMethod 闸住，
// 其余 3 个调用点（fetchChunkText / chunk 源码 / sourcemap 探测）全是 GET。**未来新增调用点务必遵守**。
export async function safeFetch(url: string, opts: any = {}, timeoutMs = 35000): Promise<any> {
  const doFetch = async (insecure: boolean) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (insecure) enterInsecureTls();
    try {
      return await fetch(url, { ...opts, signal: controller.signal });
    } finally {
      clearTimeout(timer);
      if (insecure) exitInsecureTls();
    }
  };
  try {
    return await doFetch(false);
  } catch (e: any) {
    if (!TLS_ERR_RE.test(errDetail(e))) throw e;
    return await doFetch(true);   // 证书类错误：降级重试一次即终局
  }
}



// V4.9.11（实测驱动修复 S7）：匿名请求的**服务端兜底**。
// 背景：页面上下文与扩展 SW **都走 Chrome 网络栈**，对"服务端要求 post-handshake TLS 重新协商"
// 的站点会集体挂起 / 报 "Failed to fetch"（Chrome 从 v60 起拒绝该行为，属防 DoS 的安全策略）。
// 实测 app.example.com：同一批接口**时好时坏**——取决于当次协商到 TLS 1.2（挂）还是 1.3（通），
// 是最难排查的一类故障；同参数 curl（schannel 支持重新协商）3~6 秒即 200。
// 而**服务端**走 Node/OpenSSL 网络栈不受此限制，故浏览器侧返回 status 0 时在此兜底重试一次。
// 注：S5（SW 侧降级页面→SW）已被实测证伪——SW 同样受 Chrome 网络栈限制，只有服务端能真正绕过。
// V4.9.34：**收作用域并全程透传**——原签名不收，`ANON_FETCH` 于是永远作用于**活动标签页**：
// 工具层（unauthorized_sweep / batch_unauthorized_api / smart_unauthorized_test）**都已有
// tab_id**，但中间这一层没收、也传不下去 → 客户端 anonFetch 的 `resolveTab({})` 回退到活动标签。
// **与 V4.9.27 的 get_chunk_source 完全同构的三层断头**（工具层有 → helpers 层丢 → 客户端拿不到），
// 只是这次是类型系统把它揪出来的（`ANON_FETCH` 在 ScopedCommands 里，漏传 tabId 编译不过）。
// 影响面不小：这三个是批量发匿名请求的工具，用户焦点不在目标站时，请求会带着**别的页面**的上下文发出。
export async function anonFetchWithServerFallback(
  fullUrl: string,
  method: string,
  body: string | undefined,
  extraHeaders: Record<string, string> | null,
  timeoutMs: number,
  scope: TabScope
): Promise<any> {
  const anon = await sendToBrowser("ANON_FETCH", { url: fullUrl, method, body, authHeaders: extraHeaders, ...scope }, timeoutMs);
  // V4.9.22（修复🔴，审计补充）：**写方法不在服务端兜底重发**——浏览器侧报 status 0 是"网络层失败"，
  // 但服务端**可能已受理**（超时/中断尤甚），Node 侧重发 = 第二次真实写操作（且 safeFetch 遇证书类
  // 错误自己还会再降级重试一次，合计最多 3 次）。只读方法才兜底；写方法原样返回，由调用方判断。
  const isReadOnlyMethod = /^(GET|HEAD)$/i.test(String(method || 'GET'));
  if (anon && anon.status === 0 && isReadOnlyMethod) {
    try {
      const hdrs: Record<string, string> = { 'Accept': 'text/html,application/json,*/*', ...(extraHeaders || {}) };
      const useBody = method !== 'GET' && method !== 'HEAD' && body;
      if (useBody) hdrs['Content-Type'] = 'application/json';
      const r = await safeFetch(fullUrl, {
        method, headers: hdrs,
        body: useBody ? body : undefined,
        redirect: 'follow'
      }, timeoutMs);
      // V4.9.29：读体失败必须留标记——原实现 `await r.text().catch(() => '')` 静默得到空串，
      // 于是 bodySize:0 / bodySample:'' 与"响应体本来就是空"完全同形，judgeUnauthorized 会
      // 落到规则7 报「可能是 SPA 空壳」，把「没读到」错误归因成「内容少」。
      // ⚠️ **这是 V4.9.28 的漏网之鱼**：那一批只修了客户端 anonFetch 的**两个分支**，
      // 服务端这条直连兜底路径（浏览器侧 status 0 且只读方法时走这里）没被覆盖——
      // 同类缺陷的"所有实例"必须一起扫，否则就是本项目最警惕的「修复做一半」。
      let text = '';
      let bodyReadError = '';
      try { text = await r.text(); } catch (e: any) { bodyReadError = errDetail(e); }
      const sensPattern = /"(?:user|username|email|phone|mobile|token|jwt|session|password|idcard|card|account|nickname|openid|realName)"\s*:\s*"[^"]{1,200}"/gi;
      return {
        url: fullUrl,
        status: r.status,
        contentType: r.headers.get('content-type') || '',
        location: r.headers.get('location') || '',
        redirected: !!r.redirected,
        finalUrl: r.url || '',
        ...(bodyReadError ? { bodyReadError } : {}),   // 判定引擎规则0 认这个标记
        bodySize: text.length,   // 单位：**字符**（与页面侧 anonFetch 同口径，见 judgeUnauthorized 顶部注释）
        bodySample: text.slice(0, 8000),
        sensitiveHits: (text.match(sensPattern) || []).slice(0, 10),
        anonymous: true,
        via: 'server-fetch(浏览器侧失败兜底)'
      };
    } catch (e) { /* 兜底也失败：保留浏览器侧结果如实返回 */ }
  }
  return anon;
}



export async function fetchChunkText(url: string, timeoutMs = 35000): Promise<{ url: string; code?: string; error?: string }> {
  const fetchOnce = async (): Promise<{ url: string; code?: string; error?: string }> => {
    try {
      const resp = await safeFetch(url, { redirect: 'follow' }, timeoutMs);
      if (!resp.ok) return { url, error: `HTTP ${resp.status}` };
      const ct = resp.headers.get('content-type') || '';
      if (/html/i.test(ct)) return { url, error: 'content-type html（可能是错误页）' };
      const text = await resp.text();
      // 上限 8MB：实测 vite 单入口后台主 chunk（全部业务代码打进 index-xxx.js）常达 2-5MB，
      // 旧 2MB 上限会跳过主 chunk 导致 API 提取全空（admin.example.com 实测）
      if (text.length > 8_000_000) return { url, error: '超过 8MB 上限，跳过', code: '' };
      return { url, code: text };
    } catch (e: any) {
      return { url, error: errDetail(e) };
    }
  };

  const first = await fetchOnce();
  if (!first.error) return first;
  // HTTP 类错误重试无意义（404/500 不会自愈）
  if (first.error.startsWith('HTTP ')) return first;
  // V4.9.3：并发拉取下大 chunk 易超时——实测 course.example.edu.cn（334KB chunk-vendors）并发 8 时
  // 9/10 失败、单发全部成功。失败后单发重试一次（不占并发额度，成功率显著提升）。
  const retry = await fetchOnce();
  return retry.error ? first : retry;
}


// 实测发现模式（2026-09-14 多所高校实测）：维普智慧图书馆（lib.aaa/lib.bbb/lib.ccc 路由完全一致）、
// 雨课堂（courses.aaa 841 路由）、Epxing 智慧校园框架（rs.bbb）——产品化系统同一套代码部署于多所院校，
// 漏洞影响面 = 所有部署单位。识别出产品名后，汇报/定级时应提示"批量影响"。
export const SAAS_PRODUCT_FINGERPRINTS: Array<{ name: string; patterns: RegExp[] }> = [
  { name: '维普智慧图书馆 (vipslib)', patterns: [/vipslib\.com/i, /cdn\.vipslib/i, /\/smartqa\//i] },
  { name: '雨课堂/学堂在线 (yuketang)', patterns: [/yuketang\.cn/i, /xuetangonline\.com/i, /fe-static-yuketang/i] },
  { name: 'Epxing 智慧校园框架', patterns: [/epxing-frame/i, /epxing\./i] },
  { name: '超星学习通/泛雅 (chaoxing)', patterns: [/chaoxing\.com/i, /fanya/i, /\/ananas\//i] },
  { name: '正方教务 (zfsoft)', patterns: [/zfsoft/i, /jwglxt/i] },
  { name: '强智教务 (qzdatasoft)', patterns: [/qzdatasoft/i, /newjw\./i] },
  { name: '金智教育/今日校园 (wisedu)', patterns: [/wisedu\.com/i, /epay\.wisedu/i, /today\.wisedu/i] },
  { name: 'Coremail 邮件系统', patterns: [/coremail/i] },
  { name: '泛微 OA (weaver)', patterns: [/weaver\.com\.cn/i, /\/ecology\//i] },
  { name: '万户 OA (whir)', patterns: [/whir\./i, /\/defaultroot\//i] },
  { name: '宏景 HR (hjsoft)', patterns: [/hjsoft/i] },
  { name: 'Blackboard 教学平台', patterns: [/blackboard/i, /\/webapps\/blackboard/i] },
  { name: 'Moodle', patterns: [/moodle/i] },
  { name: '帆软报表 (fanruan)', patterns: [/fanruan/i, /FineReport|FineBI/i] },
  { name: '若依系 (RuoYi)', patterns: [/\/prod-api\/system\//i, /ruoyi/i, /\/tool\/gen/i, /\/monitor\/job/i, /\/system\/user\/list/i] },
  { name: 'JeecgBoot', patterns: [/jeecg/i, /\/sys\/common\/queryTableData/i] },
  { name: 'SiteGray 建站系统', patterns: [/sitegray/i, /\/system\/resource\/js\/counter/i] },
];



export function detectSaasProducts(texts: string[]): string[] {
  if (texts.length === 0) return [];
  const blob = texts.join('\n').slice(0, 3_000_000); // 防超大拼接（chunk 源码样本通常已截断）
  const hits: string[] = [];
  for (const fp of SAAS_PRODUCT_FINGERPRINTS) {
    if (fp.patterns.some(re => re.test(blob))) hits.push(fp.name);
  }
  return hits;
}


// 探测类工具默认只测读操作——防 AI 误触发不可逆写副作用（CLAUDE.md 案例：空 POST 触发真实解绑账号）。
// 采用**宽匹配**（动词出现在路径任意位置即算）：国产后台驼峰/连写命名普遍（importData/resetPwd/editzg），
// 边界感知正则大量漏网（首版 12/17）。宁可误伤读接口（结果中有 writeSkipped 明示，可人工复核），
// 不可漏网写接口。歧义词（approve/reject/check 等"待办/状态"语义）不入表——防 waitApprove 类读接口误伤。
// export/download/preview 属读操作（渗透关注点），不入表。
export function isWriteLikeApi(api: string): boolean {
  const p = api.toLowerCase();
  const WRITE_RE = /(?:import|upload|save|create|insert|update|edit|modify|delete|remove|reset|change|switch|enable|disable|unbind|allot|grant|revoke|submit|execute|generate|sync|clear|batch|add|del|send|push|copy|move|bind|merge|split|confirm|pass|cancel|close|publish|unpublish|activate|deactivate|freeze|unfreeze|audit|lock|unlock|rollback|restore)/i;
  return WRITE_RE.test(p);
}


// 形态 A（vite）：源码里 "xxx-8位hash.js" 直串（import() 参数）——原有正则
// 形态 B（webpack 4 runtime）：chunk URL 构造函数（实测 course.example.edu.cn runtime 样本）：
//   return u.p+"index/js/"+({home:"home",loginPage:"loginPage"}[e]||e)+"."+{"chunk-2d216214":"0bbc55e6",...,home:"434b77a2"}[e]+".js"
// 返回"相对文件名"（如 home.434b77a2.js），调用处用当前 chunk 的目录（dirOf）拼接完整 URL。
export function extractLazyChunkNames(code: string, limit: number): string[] {
  const names = new Set<string>();
  // V4.9.11（实站实测 app.example.com）：过滤语言包/纯样式类 chunk——它们占引用列表的大头
  // （en-*/zh-CN-*/ja-* 等）但不含任何 API，白白占用 limit 额度
  const SKIP_RE = /^(?:en|zh-CN|zh-TW|zh-HK|ja|ko|ru|ar|fr|de|es|pt|vi|th|id|it|nl|pl|tr|uk)-[A-Za-z0-9_-]{8}\.js$/;
  // 形态 A：vite
  const LAZY_RE = /["'(]\.?\/?([A-Za-z0-9_-]+-[A-Za-z0-9_-]{8}\.js)["')]/g;
  let m: RegExpExecArray | null;
  while ((m = LAZY_RE.exec(code)) !== null && names.size < limit) {
    if (!SKIP_RE.test(m[1])) names.add(m[1]);
  }

  // 形态 B：webpack runtime 的 URL 构造函数（name 映射 + hash 映射）
  if (names.size < limit) {
    const WB_RE = /return\s+[\w$.]+\s*\+\s*"([^"]{0,80})"\s*\+\s*\(\s*(\{[^{}]{2,8000}\})\s*\[\s*[\w$.]+\s*\]\s*(?:\|\|\s*[\w$.]+\s*)?\)\s*\+\s*"\."\s*\+\s*(\{[^{}]{2,8000}\})\s*\[\s*[\w$.]+\s*\]\s*\+\s*"\.js"/;
    const wb = code.match(WB_RE);
    if (wb) {
      const parsePairs = (s: string): Record<string, string> => {
        const out: Record<string, string> = {};
        // key 支持带引号字符串与无引号标识符（webpack 产物常见 home:"hash" 简写——实测 dcourses 样本）
        const re = /(?:["']([^"']{1,80})["']|([A-Za-z_$][\w$]{0,79}))\s*:\s*["']([^"']{1,80})["']/g;
        let p: RegExpExecArray | null;
        while ((p = re.exec(s)) !== null) out[p[1] || p[2]] = p[3];
        return out;
      };
      const nameMap = parsePairs(wb[2]);
      const hashMap = parsePairs(wb[3]);
      for (const [id, hash] of Object.entries(hashMap)) {
        if (names.size >= limit) break;
        const nm = nameMap[id] || id;
        names.add(`${nm}.${hash}.js`);
      }
    }
  }
  return [...names];
}



// 33.9 批量 chunk 硬编码密钥提取（静态扫描：密钥赋值 + hex 密钥特征 + sourcemap 恢复源码清单）
export const KEY_ASSIGN_RE = /(?:secret|secretkey|appsecret|app_key|appkey|apikey|api_key|aeskey|aes_key|encryptkey|encrypt_key|signkey|sign_key|hmackey|hmac_key|deskey|sm4key|accesskey|access_key|privatekey|private_key)\s*[:=]\s*["']([A-Za-z0-9+/=_-]{8,128})["']/gi;


export const HEX_KEY_RE = /["']([0-9a-f]{32}|[0-9a-f]{48}|[0-9a-f]{64})["']/g;


export const SOURCEMAP_RE = /\/\/#\s*sourceMappingURL=([^\s*"']+)/;



export function extractChunkKeysFromCode(code: string, chunkUrl: string) {
  const keys: Array<{ type: string; name?: string; value: string; context: string }> = [];
  const seen = new Set<string>();
  const pushKey = (type: string, value: string, name: string | undefined, idx: number) => {
    const dedup = type + '|' + value;
    if (seen.has(dedup) || value.length > 128) return;
    seen.add(dedup);
    keys.push({
      type,
      name,
      value,
      context: code.slice(Math.max(0, idx - 35), idx + value.length + 35).replace(/\s+/g, ' ').slice(0, 160)
    });
  };
  let m: RegExpExecArray | null;
  KEY_ASSIGN_RE.lastIndex = 0;
  while ((m = KEY_ASSIGN_RE.exec(code)) !== null && keys.length < 60) {
    pushKey('assignment', m[1], m[0].split(/[:=]/)[0].trim(), m.index);
  }
  HEX_KEY_RE.lastIndex = 0;
  while ((m = HEX_KEY_RE.exec(code)) !== null && keys.length < 60) {
    pushKey('hex', m[1], undefined, m.index);
  }
  const sm = SOURCEMAP_RE.exec(code);
  return { keys, sourceMapUrl: sm ? sm[1] : null };
}



// 中文姓名检测的停用词（常见界面文案，不可能是姓名）
// V4.9.24：原先内联在 analyzeSensitiveData 里，且**算出的过滤结果没被使用**（见下方注释）；
// 提升为模块级常量，便于单测覆盖
export const CHINESE_NAME_STOPWORDS = [
  '用户名', '密码', '登录', '注册', '确认', '取消', '提交', '返回', '首页', '管理',
  '姓名', '名字', '用户', '账号', '账户', '设置', '修改', '删除', '添加', '查询',
  '成功', '失败', '错误', '提示', '系统', '状态', '详情', '列表', '全部', '选择'
];

// 敏感数据正则表达式定义
export const SENSITIVE_PATTERNS = {
  // 身份证号（18位/15位）
  idCard: {
    pattern: /\b[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b|\b[1-9]\d{5}\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}\b/g,
    severity: "critical",
    description: "身份证号"
  },
  // 手机号
  phone: {
    pattern: /\b1[3-9]\d{9}\b/g,
    severity: "high", 
    description: "手机号"
  },
  // 银行卡号（16-19位）
  bankCard: {
    pattern: /\b(?:62|4[0-9]|5[1-5]|6[2-6])\d{14,17}\b/g,
    severity: "critical",
    description: "银行卡号"
  },
  // 邮箱
  email: {
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    severity: "medium",
    description: "邮箱地址"
  },
  // 中文姓名（V4.9.24：改为**锚点式**——只在"姓名类字段的值"位置命中）
  // 原 `2-4 个汉字` 的宽正则会命中"北京""登录""成功"等**任何**中文词——中文站上等于把整段文案
  // 都报成"疑似姓名"，把真发现淹没。同一形态早已被 `start_sensitive_monitor` 以"幻觉数据"为由
  // 移除（其工具描述白纸黑字写着），却漏改了在用的这三个工具 → **同一代码库自相矛盾**。
  // 现改为锚点式：宁可漏（裸姓名数组 `["张三","李四"]` 抓不到），不制造幻觉数据。
  chineseName: {
    pattern: /(?<=["']?(?:姓名|名字|真实姓名|用户姓名|联系人|收货人|name|realName|real_name|userName|user_name|nickName|nick_name|contactName|contact)["']?\s*[:=：]\s*["']?)[\u4e00-\u9fa5]{2,4}(?=["'\s&,;，。}<>]|$)/gi,
    severity: "low",
    description: "中文姓名(疑似，仅限姓名字段的值)"
  },
  // 密码字段
  password: {
    pattern: /"(?:password|passwd|pwd|pass|secret|token|key)"\s*:\s*"[^"]+"/gi,
    severity: "critical",
    description: "密码/密钥字段"
  },
  // IP地址
  ipAddress: {
    pattern: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g,
    severity: "low",
    description: "IP地址"
  },
  // JWT Token
  jwt: {
    pattern: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    severity: "high",
    description: "JWT Token"
  },
  // 社保号/公积金号
  socialSecurity: {
    pattern: /\b[A-Z]{1}\d{7,9}\b/g,
    severity: "high",
    description: "社保/公积金号(疑似)"
  }
};



// 敏感数据分析函数
export function analyzeSensitiveData(text: string, enabledPatterns: string[] = [], opts: { mask?: boolean } = {}): {
  hasSensitiveData: boolean;
  severity: string;
  findings: Array<{
    type: string;
    description: string;
    severity: string;
    matches: string[];
    count: number;
    valuesRaw?: boolean;
    valuesRawNote?: string;
    maskedBy?: string;
  }>;
  summary: {
    critical: number;
    high: number;
    medium: number;
    low: number;
  };
} {
  // V4.9.25（清单🟡-22）：**默认不再脱敏**。原实现无条件 `maskSensitiveData` 且输出无任何标记 →
  // 报告里会把"我方工具脱的敏"读成"**目标系统有 PII 脱敏设计**"，而定级恰恰靠这个区分
  // （项目的证据纪律：响应内容原样照录、禁止脱敏改写；且原始值用 get_network_requests(include_body)
  // 一次调用就能拿到——这里的脱敏挡不住任何人，只制造证据混淆）。需要脱敏时显式传 mask:true。
  const shouldMask = opts.mask === true;
  const findings: Array<{
    type: string;
    description: string;
    severity: string;
    matches: string[];
    count: number;
  }> = [];
  
  const summary = { critical: 0, high: 0, medium: 0, low: 0 };
  
  // 默认检测高风险字段
  const patternsToCheck = enabledPatterns.length > 0 
    ? enabledPatterns 
    : ['idCard', 'phone', 'bankCard', 'password', 'jwt'];
  
  for (const [key, config] of Object.entries(SENSITIVE_PATTERNS)) {
    if (patternsToCheck.includes(key) || patternsToCheck.includes('all')) {
      const matches = text.match(config.pattern);
      if (matches && matches.length > 0) {
        // 去重并限制数量
        let uniqueMatches = [...new Set(matches)].slice(0, 10);

        // V4.9.24（清单🟡）：**这段停用词过滤原先是死的**——算出的 `filtered` 只用于 `continue`
        // 判断，紧接着 push 的仍是**未过滤**的 `uniqueMatches`，"登录""密码"照样进结果输出。
        // 又一处"修复在半路被架空"（同 V4.9.22 的凭据回显、V4.9.23 的 cookie JWT）。现改为**就地生效**。
        // 说明：锚点化之后本过滤已近乎冗余，保留作兜底（`"userName":"用户名"` 这类仍可能命中）
        if (key === 'chineseName') {
          uniqueMatches = uniqueMatches.filter(m => !CHINESE_NAME_STOPWORDS.includes(m));
          if (uniqueMatches.length === 0) continue;
        }

        findings.push({
          type: key,
          description: config.description,
          severity: config.severity,
          matches: shouldMask ? uniqueMatches.map(m => maskSensitiveData(m, key)) : uniqueMatches,
          count: matches.length,
          // 取值来源必须可辨：否则"我方脱敏"与"目标脱敏"在输出里长得一模一样
          ...(shouldMask
            ? { maskedBy: 'antidebug-mcp（**我方工具**脱敏，非目标系统行为——勿据此判断目标有 PII 脱敏设计）' }
            : { valuesRaw: true, valuesRawNote: '原样取自响应体未经加工；若值本身带 *** 那是**目标系统**自己的脱敏' })
        });
        
        summary[config.severity as keyof typeof summary]++;
      }
    }
  }
  
  // 确定最高严重级别
  let maxSeverity = 'none';
  if (summary.critical > 0) maxSeverity = 'critical';
  else if (summary.high > 0) maxSeverity = 'high';
  else if (summary.medium > 0) maxSeverity = 'medium';
  else if (summary.low > 0) maxSeverity = 'low';
  
  return {
    hasSensitiveData: findings.length > 0,
    severity: maxSeverity,
    findings,
    summary
  };
}



// 敏感数据脱敏函数
export function maskSensitiveData(data: string, type: string): string {
  switch (type) {
    case 'idCard':
      return data.slice(0, 6) + '****' + data.slice(-4);
    case 'phone':
      return data.slice(0, 3) + '****' + data.slice(-4);
    case 'bankCard':
      return data.slice(0, 4) + '****' + data.slice(-4);
    case 'email':
      const [local, domain] = data.split('@');
      return local.slice(0, 2) + '***@' + domain;
    case 'password':
      return data.replace(/"[^"]+"/g, '"***"');
    default:
      return data;
  }
}

