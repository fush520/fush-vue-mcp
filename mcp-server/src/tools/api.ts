// ============== API 面（chunk 挖掘/未授权流水线/泄露扫描/密钥提取/Nuxt） ==============
// P0-2 拆分自 index.ts——工具注册文本原样搬运，逻辑零改动。

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isBrowserConnected, sendToBrowserRetry, sendToBrowser } from "../transport.js";
import {
  judgeUnauthorized,
  FRAMEWORK_FINGERPRINTS,
  SENSITIVE_ROUTE_RE,
  MODULE_PATH_RE,
  API_PATH_RE,
  RESOURCE_EXT_RE,
  NOISE_PATH_RE,
  normalizePath,
  getJSChunksCached,
  BASE_CFG_RE,
  normalizeBaseCfg,
  safeFetch,
  anonFetchWithServerFallback,
  fetchChunkText,
  detectSaasProducts,
  isWriteLikeApi,
  extractLazyChunkNames,
  extractChunkKeysFromCode,
} from "../helpers.js";

export function register_api_tools(server: McpServer): void {
// 33.8 路由→API 关联图谱 + 后台框架指纹
server.tool(
  "route_api_graph",
  "构建 路由→JS chunk→API 关联图谱：收集页面已加载的全部 JS chunk，提取 API 端点与组件模块路径，与 Vue 路由/Pinia 菜单（含若依类动态路由）关联，并用后台框架指纹字典（若依/renren/eladmin/pig 等）识别框架。输出敏感路由清单（用户/角色/菜单管理类，未授权测试优先目标）和未关联路由的公共 API（登录/验证码/上传等）",
  {
    // V4.9.11（验收修复 B15）：补 int/min 约束——原为裸 z.number()，传负数会走 slice(0, -5)
    // 静默丢掉尾部 chunk（不报错、结果看似正常但少扫）
    maxChunks: z.number().int().min(1).max(500).optional().describe("最多分析的 chunk 数，默认 100，最大 500"),
    minChunkSize: z.number().optional().describe("跳过小于该字节数的 chunk（过滤空文件），默认 100"),
    includeLazyChunks: z.boolean().optional().describe("递归挖掘懒加载业务 chunk（V4.6 默认开启：vite 单入口站业务 API 全在懒加载 chunk，实测 3 条→83 条）"),
    lazyChunkLimit: z.number().int().min(1).max(200).optional().describe("懒加载 chunk 拉取上限（默认 150）"),
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用活动标签页）"),
    hostname: z.string().optional().describe("目标 hostname（在该域名的标签页上执行）")
  },
  async ({ maxChunks, minChunkSize, includeLazyChunks = true, lazyChunkLimit = 150, tab_id: tabId, hostname }) => {
    try {
      const maxN = Math.min(maxChunks || 100, 500);
      const minSize = minChunkSize || 100;

      // 1. 获取路由数据（静态 + 动态 + Pinia 菜单）
      let vueData: any = {};
      try {
        vueData = await sendToBrowser("GET_VUE_ROUTER_DATA", { tabId, hostname });
      } catch (e: any) {
        // 无路由数据不阻断，继续做 chunk 分析
        vueData = { notFound: true, error: e.message };
      }

      const routes: Array<{ path: string; name?: string; component?: string; meta?: any; source: string }> = [];
      const addRoute = (r: any, source: string) => {
        if (!r) return;
        const path = r.path || r.url || r.name || '';
        if (!path || typeof path !== 'string') return;
        if (routes.some(x => x.path === path && x.component === r.component)) return;
        // V4.3：保留 meta（roles/permissions/permission/title 等）——权限矩阵与越权测试的靶单来源，
        // 旧版在这里把 meta 丢弃导致前端权限模型无法提取
        routes.push({ path, name: r.name || r.title || undefined, component: r.component || undefined, meta: r.meta || undefined, source });
      };
      (Array.isArray(vueData.routes) ? vueData.routes : []).forEach((r: any) => addRoute(r, 'static'));
      (Array.isArray(vueData.dynamicRoutes) ? vueData.dynamicRoutes : []).forEach((r: any) => addRoute(r, 'dynamic'));
      (Array.isArray(vueData.piniaMenus) ? vueData.piniaMenus : []).forEach((r: any) => addRoute(r, 'pinia'));
      // 递归处理嵌套菜单
      const walkMenus = (arr: any[], source: string) => {
        if (!Array.isArray(arr)) return;
        for (const m of arr) {
          addRoute(m, source);
          if (m && m.children) walkMenus(m.children, source);
        }
      };
      walkMenus(vueData.piniaMenus || [], 'pinia');
      walkMenus(vueData.dynamicRoutes || [], 'dynamic');
      // 兼容 Get_Vue_0 上报的 MULTIPLE_INSTANCES 结构（Vue2/3 站点主格式：instances[].routes）
      const insts = Array.isArray(vueData.instances) ? vueData.instances : [];
      for (const inst of insts) {
        if (!inst || typeof inst !== 'object') continue;
        (Array.isArray(inst.routes) ? inst.routes : []).forEach((r: any) => addRoute(r, 'static'));
        (Array.isArray(inst.dynamicRoutes) ? inst.dynamicRoutes : []).forEach((r: any) => addRoute(r, 'dynamic'));
        walkMenus(inst.piniaMenus || [], 'pinia');
      }

      // 2. 获取页面已加载的 JS chunk 列表
      const chunkList = await sendToBrowserRetry("GET_JS_CHUNKS", { maxChunks: maxN, tabId, hostname }, 30000);

      // 3. node 侧并发拉取并分析 chunk
      const chunksToFetch = (chunkList?.chunks || []).slice(0, maxN);
      const analyzed: Array<{ url: string; size: number; apiPaths: string[]; modulePaths: string[] }> = [];
      const failures: Array<{ url: string; error: string }> = [];
      const allApiPaths = new Set<string>();
      const baseCfgPaths = new Set<string>();   // V4.9.11：chunk 里 base_url 配置提取到的前缀（完整 URL 归一化后）
      // V4.9.5：产品化 SaaS 指纹检测样本——chunk URL 列表（CDN 厂商域名本身即强指纹，如
      // fe-static-yuketang.yuketang.cn 雨课堂 / cdn.vipslib.com 维普）+ 后续收集的成功 chunk 源码
      const saasTexts: string[] = [chunksToFetch.map((c: any) => c.url).join('\n')];
      // chunk 为空提示：GET_JS_CHUNKS 实时读活动标签页的 performance resource 记录，
      // 目标页非活动标签/未加载完成时为空——实测发现的误导场景（静默空结果像"无 API"）
      const chunkHint = chunksToFetch.length === 0
        ? '当前活动标签页没有 JS 资源记录。请确认目标页面是活动标签且已加载完成（必要时刷新页面），再重新调用本工具'
        : null;
      // 注入函数诊断（totalEntries/jsEntries 与页面实际 performance 对比，定位注入环境异常）
      const chunkDiag = chunksToFetch.length === 0 ? {
        rawCount: chunkList?.count,
        rawError: chunkList?.error,
        totalEntries: chunkList?.totalEntries,
        jsEntries: chunkList?.jsEntries,
        pageUrl: chunkList?.pageUrl
      } : null;

      const CONCURRENCY = 8;
      for (let i = 0; i < chunksToFetch.length; i += CONCURRENCY) {
        const batch = chunksToFetch.slice(i, i + CONCURRENCY);
        const results = await Promise.all(batch.map((c: any) => fetchChunkText(c.url)));
        for (const r of results) {
          if (r.error || !r.code) {
            failures.push({ url: r.url, error: r.error || '空内容' });
            continue;
          }
          const apiPaths = new Set<string>();
          let m: RegExpExecArray | null;
          API_PATH_RE.lastIndex = 0;
          while ((m = API_PATH_RE.exec(r.code)) !== null && apiPaths.size < 100) {
            const p = m[1];
            if (p.length < 4 || RESOURCE_EXT_RE.test(p) || NOISE_PATH_RE.test(p)) continue;
            apiPaths.add(p);
          }
          const modulePaths = new Set<string>();
          MODULE_PATH_RE.lastIndex = 0;
          while ((m = MODULE_PATH_RE.exec(r.code)) !== null && modulePaths.size < 200) {
            modulePaths.add(m[1]);
          }
          // base 配置提取（V4.9.11）：芋道等框架的 base 是完整 URL 形态，路径正则拿不到
          BASE_CFG_RE.lastIndex = 0;
          while ((m = BASE_CFG_RE.exec(r.code)) !== null && baseCfgPaths.size < 20) {
            const clean = normalizeBaseCfg(m[1]);
            if (clean) baseCfgPaths.add(clean);
          }
          const size = chunksToFetch.find((c: any) => c.url === r.url)?.size || r.code.length;
          if (r.code.length < minSize) continue;
          const entry = {
            url: r.url,
            size,
            apiPaths: Array.from(apiPaths),
            modulePaths: Array.from(modulePaths)
          };
          analyzed.push(entry);
          apiPaths.forEach(p => allApiPaths.add(p));
          if (saasTexts.length < 40) saasTexts.push(r.code.slice(0, 120000)); // V4.9.5：产品指纹样本
        }
      }

      // 3.5 拼接型 API 组合提取（V4.5：vite/webpack minify 站实测痛点——
      // 代码里接口是 `base + path` 拼接，如 X="/api/backend"、fetch(X+"/system/menu-list")，
      // 正则只能拿到片段。把 base 前缀候选 × 业务路径片段组合成候选清单）
      const BASE_LIKE_RE = /^\/(?:api|prod-api|dev-api|admin-api|apis|gateway|base-api)(?:\/(?:backend|gateway|base|admin|web|api|v\d+))?\/?$/; // /api、/api/backend、/prod-api——第二段限基础设施词，排除 /prod-api/login|getInfo 类端点误判（实测靶场候选 7→1 的根因）
      const collected = [...allApiPaths];
      // V4.9.11：并入 base 配置提取到的前缀（完整 URL 形态归一化后）——否则芋道类站点
      // （base_url:"https://host/admin-api"）的 combinedApis 恒空（实测该站）
      const baseLike = [...new Set([...collected.filter(p => BASE_LIKE_RE.test(p)), ...baseCfgPaths])];
      const pathLike = collected.filter(p => !BASE_LIKE_RE.test(p) && /^\/[a-zA-Z]/.test(p) && !RESOURCE_EXT_RE.test(p));
      const combinedApis: string[] = [];
      if (baseLike.length > 0 && pathLike.length > 0) {
        for (const b of baseLike) {
          const prefix = b.endsWith('/') ? b.slice(0, -1) : b;
          for (const p of pathLike) {
            // V4.9.11（验收修复 R2）：跳过**自身已带该前缀**的片段——BASE_LIKE_RE 只认"纯前缀"
            //（/prod-api），像 /prod-api/common/upload 这种已含前缀的完整路径会被归入 pathLike，
            // 无条件拼接就产出 /prod-api/prod-api/common/upload 这类重复前缀的无效候选
            //（实测若依站）。白占 60 条配额，还会让 AI 误以为该路径真实存在
            if (p === prefix || p.startsWith(prefix + '/')) continue;
            const combo = prefix + p;
            if (!combinedApis.includes(combo) && !collected.includes(combo)) combinedApis.push(combo);
            if (combinedApis.length >= 60) break;
          }
          if (combinedApis.length >= 60) break;
        }
      }

      // 3.6 懒加载 chunk 递归挖掘（V4.6：vite 单入口站业务 API 全在懒加载 chunk，
      // 实测 admin.example.com 主 chunk 只暴露 3 条，78 个懒加载 chunk 里有 83 条业务接口）。
      // V4.9.4：vite + webpack 双形态提取（webpack runtime 的 chunk URL 构造函数解析）
      const CALL_API_RE = /\.(get|post|put|delete|request)\s*\(\s*["'`](\/[a-zA-Z0-9_\-\/]{3,70})["'`]/g;
      const URL_FIELD_RE = /url\s*:\s*["'`](\/[a-zA-Z0-9_\-\/]{3,70})["'`]/g;
      const lazyChunkApis: Array<{ api: string; methods: string[]; chunk: string }> = [];
      if (includeLazyChunks) {
      const lazyNames = new Set<string>();
      // V4.9.11（实站实测 app.example.com 驱动）：从**前 20 个 chunk** 提取懒加载清单，不再只认最大 2 个——
      // 原注释假设"主 chunk = 路由表所在，通常是最大者"，实测该站最大的是 form-designer（2MB）
      // 而非主入口 index（1.67MB），于是 817 个懒加载引用只挖出 1 个（92% 接口面不可见）
      const seedChunks = [...chunksToFetch].sort((a: any, b: any) => (b.size || 0) - (a.size || 0)).slice(0, 20);
      // V4.9.11（验收修复 A18）：分批 8 个抓取——原实现一次性 Promise.all 20 个 2-8MB 大 chunk，
      // 内存尖峰约 160MB（同文件其余路径都是 8 个一批，此处漏了）
      const seeds: any[] = [];
      for (let si = 0; si < seedChunks.length; si += 8) {
        seeds.push(...await Promise.all(seedChunks.slice(si, si + 8).map((c: any) => fetchChunkText(c.url))));
      }
        // V4.9.11（验收修复 A16）：懒加载名按**来源 chunk 各自的目录**拼完整 URL——
        // 原实现用单个 chunk（chunksToFetch[0]）的目录拼所有名字，多目录站点
        //（/assets/ 与 /static/js/ 并存、vite+webpack 子应用混布）会把其他 chunk 提取的名字
        // 拼到错误目录 → 全部 404 → 懒加载接口面静默丢失（正是 V4.9.11 想修问题的一半）。
        // info_leak_scan 按种子各自 dirOf 拼接才是对的，此处与之对齐
        const dirOf = (u: string) => { try { return new URL('.', u).href; } catch (e) { return ''; } };
        const lazyUrlOf = new Map<string, string>();   // 名字 -> 带各自目录的完整 URL
        for (const seed of seeds) {
          if (!seed.code) continue;
          const seedDir = dirOf(seed.url || '');
          for (const n of extractLazyChunkNames(seed.code, lazyChunkLimit - lazyNames.size)) {
            if (lazyNames.has(n)) continue;
            lazyNames.add(n);
            if (seedDir) lazyUrlOf.set(n, seedDir + n);
          }
        }
        if (lazyUrlOf.size > 0) {
          const lazyUrls = [...lazyUrlOf.values()].filter(u => !RESOURCE_EXT_RE.test(u.slice(-5)) || u.endsWith('.js'));
          const CONC_LAZY = 8;
          for (let i = 0; i < lazyUrls.length; i += CONC_LAZY) {
            const results = await Promise.all(lazyUrls.slice(i, i + CONC_LAZY).map((u: string) => fetchChunkText(u)));
            for (const cr of results) {
              if (!cr.code) continue;
              const chunkName = cr.url.split('/').pop() || cr.url;
              let cm: RegExpExecArray | null;
              CALL_API_RE.lastIndex = 0;
              while ((cm = CALL_API_RE.exec(cr.code)) !== null && lazyChunkApis.length < 150) {
                const method = cm[1].toUpperCase();
                const api = cm[2];
                const exist = lazyChunkApis.find(x => x.api === api);
                if (exist) { if (!exist.methods.includes(method)) exist.methods.push(method); }
                else lazyChunkApis.push({ api, methods: [method], chunk: chunkName });
              }
              URL_FIELD_RE.lastIndex = 0;
              while ((cm = URL_FIELD_RE.exec(cr.code)) !== null && lazyChunkApis.length < 150) {
                const api = cm[1];
                if (!lazyChunkApis.find(x => x.api === api)) lazyChunkApis.push({ api, methods: ['GET?'], chunk: chunkName });
              }
            }
          }
          // 组合进 allApiPaths（供敏感判定/后续探测）
          for (const la of lazyChunkApis) {
            for (const b of baseLike) allApiPaths.add((b.endsWith('/') ? b.slice(0, -1) : b) + la.api);
            allApiPaths.add(la.api);
          }
        }
      }

      // 4. 路由↔chunk 关联
      // 主策略：vue-cli 懒加载 chunk 文件名前缀 = 组件名 = route.name（如 Home.8bce025e.js ↔ name:'Home'；
      // 组合 chunk A~B~C.hash.js 含多组件名）。辅策略：chunk 内模块路径字符串匹配（dev 模式/sourcemap 场景）。
      const routeApiMap: Array<{ route: string; name?: string; component?: string; source: string; sensitive: boolean; apis: string[]; chunkUrls: string[] }> = [];
      const matchedModulePaths = new Set<string>();

      const chunkNameOf = (url: string): string => {
        try {
          const base = String(url).split('/').pop() || '';
          return base.split('.')[0] || '';
        } catch { return ''; }
      };
      const routeNameMatchesChunk = (routeName: string, chunkName: string): boolean => {
        if (!routeName || !chunkName) return false;
        const parts = chunkName.split('~');
        return parts.includes(routeName);
      };

      for (const route of routes) {
        const routeKey = normalizePath(route.path);
        const componentKey = route.component ? normalizePath(route.component) : null;
        const keys = [routeKey, componentKey].filter(Boolean) as string[];
        const apis = new Set<string>();
        const chunkUrls: string[] = [];
        let matched = false;
        for (const chunk of analyzed) {
          let chunkMatched = false;
          // 主策略：chunk 文件名前缀 ↔ 路由名
          if (route.name && routeNameMatchesChunk(String(route.name), chunkNameOf(chunk.url))) {
            chunkMatched = true;
          }
          // 辅策略：chunk 内模块路径字符串
          if (!chunkMatched) {
            for (const mp of chunk.modulePaths) {
              const mpNorm = normalizePath(mp);
              if (keys.some(k => k.length >= 3 && (mpNorm.includes(k) || mpNorm.endsWith(k)))) {
                chunkMatched = true;
                matchedModulePaths.add(mp);
                break;
              }
            }
          }
          if (chunkMatched) {
            matched = true;
            if (chunkUrls.length < 5) chunkUrls.push(chunk.url);
            chunk.apiPaths.forEach(a => apis.add(a));
          }
        }
        if (matched || (route.path && SENSITIVE_ROUTE_RE.test(route.path))) {
          routeApiMap.push({
            route: route.path,
            name: route.name,
            component: route.component,
            source: route.source,
            sensitive: SENSITIVE_ROUTE_RE.test(route.path || ''),
            apis: Array.from(apis).slice(0, 30),
            chunkUrls
          });
        }
      }

      // 未关联到任何路由的 API（公共接口：登录/验证码/上传等）
      const mappedApis = new Set<string>();
      routeApiMap.forEach(r => r.apis.forEach(a => mappedApis.add(a)));
      const unmappedApis = Array.from(allApiPaths).filter(a => !mappedApis.has(a)).slice(0, 100);

      // 5. 框架指纹匹配
      const routeKeys = new Set<string>();
      routes.forEach(r => routeKeys.add(normalizePath(r.path)));
      const detection: Array<{ name: string; score: number; evidence: string[]; note: string }> = [];
      for (const fp of FRAMEWORK_FINGERPRINTS) {
        const evidence: string[] = [];
        let score = 0;
        for (const prefix of fp.routePrefixes) {
          const hit = Array.from(routeKeys).filter(k => k.includes(prefix));
          if (hit.length > 0) {
            score += 2;
            evidence.push(`路由命中: ${prefix} (${hit.slice(0, 2).join(', ')})`);
          }
        }
        for (const re of fp.apiPatterns) {
          const hitApis = Array.from(allApiPaths).filter(a => re.test(a));
          if (hitApis.length > 0) {
            score += 1;
            evidence.push(`API 命中: ${re.source} (${hitApis.slice(0, 2).join(', ')})`);
          }
        }
        if (score > 0) detection.push({ name: fp.name, score, evidence: evidence.slice(0, 6), note: fp.note });
      }
      detection.sort((a, b) => b.score - a.score);
      const best = detection[0];
      const framework = {
        detected: detection.map(d => ({
          name: d.name,
          confidence: d.score >= 6 ? 'high' : d.score >= 3 ? 'medium' : 'low',
          evidence: d.evidence,
          note: d.note
        })),
        bestGuess: best ? best.name : null,
        noMatch: detection.length === 0 ? '未命中已知后台框架指纹' : undefined
      };

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            pageUrl: chunkList?.pageUrl,
            framework,
            stats: {
              totalRoutes: routes.length,
              routesWithApis: routeApiMap.length,
              totalChunks: chunkList?.count || 0,
              analyzedChunks: analyzed.length,
              failedChunks: failures.length,
              totalApiPaths: allApiPaths.size,
              uniqueUnmappedApis: unmappedApis.length
            },
            chunkHint,
            chunkDiag,
            productHints: (() => { const h = detectSaasProducts(saasTexts); return h.length ? h : undefined; })(),
            productHintsNote: (() => { const h = detectSaasProducts(saasTexts); return h.length ? '命中产品化 SaaS 指纹——同一产品常部署于多所院校/单位，漏洞影响面 = 所有部署单位（汇报定级时建议注明）' : undefined; })(),
            lazyChunkApis: lazyChunkApis.slice(0, 120),
            routeApiMap: routeApiMap.slice(0, 100),
            unmappedApis,
            combinedApis: combinedApis.slice(0, 60),
            failures: failures.slice(0, 10),
            // V4.9.12（实测 ng-alain.com 驱动）：路由未识别时如实警示——该站 Angular 路由为 0，
            // 100 条 unmappedApis **全是**侧边栏菜单配置里的页面路径（`{title:"介绍", url:"/docs/x"}`），
            // 而原文案把它们断言为"公共接口（登录/验证码/上传等）"并让 AI "先测这两类"，
            // 等于主动把 AI 引向一堆 HTML 页面。**不加过滤**（漏报真 API 比误报严重得多），
            // 只把判断权交回 AI——这也正是插件该做的：给事实，不给错误结论。
            // V4.9.12 补（实测 vben.pro 驱动）：**上一版警示本身会误导**——它断言"totalRoutes=0
            // ⇒ unmappedApis 里混入大量页面导航路径"，而 vben.pro（Vue3 + vite）每一条 unmappedApis
            // 都是**真接口**（/auth/login、/system/user/list…），只是静态路由提取没跑出来
            //（同一页面运行时探测得到 8 条路由）。照旧文案，AI 会**跳过真正的攻击面**——
            // 这比原来的"把菜单当接口"更糟。故改为：陈述"静态未识别"这一事实 + 给出**两种可能**的
            // 区分特征，由 AI 自行判断，并显式写"别仅凭本条警示跳过"。
            usage: `敏感路由（sensitive:true）是未授权测试优先目标；unmappedApis 是不在路由组件里的公共接口（登录/验证码/上传等），先测这两类。${routeApiMap.length === 0 ? '⚠️ 本次 totalRoutes=0（页面路由未被**静态识别**）——注意：**这既不等于"该站没有路由"，也不等于 unmappedApis 里都是页面路径**。Vue3+vite 等构建形态下静态提取可能失败（实测 vben.pro：同一页面运行时探测得到 8 条路由、静态为 0），此时 unmappedApis 里装的正是**真接口**；而 Angular / 非 SPA 站才会混入**页面导航路径**（侧边栏菜单的 url: 字段；特征：同组路径高度同构、带 /zh /en 等语言段）。请按特征甄别，**别仅凭本条警示就跳过 unmappedApis**。' : ''}需要完整 API 列表时用 get_hook_data 或 Burp recon_js_endpoints 交叉验证。`
          }, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `构建路由-API图谱失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);
// 95. 未授权一键扫描（V4.6 流水线：chunk 挖掘含懒加载递归 → 候选组合 → 匿名判定，admin.example.com 全流程自动化）
server.tool(
  "unauthorized_sweep",
  "Vue 后台未授权一键扫描：自动收集页面 chunk（含懒加载业务 chunk 递归挖掘）→ 提取全部 API 端点（直串 + base×片段组合）→ 过滤登录类接口 → 匿名 GET 逐个判定（三态）。无账号场景的核心武器，替代手工 route_api_graph + batch_unauthorized_api 两步。【证据边界】BYPASSED=匿名拿到响应，不等于有漏洞——bodySample 需人工确认数据有效性；过滤掉的写接口可在 filteredOut 里复核",
  {
    max_apis: z.number().int().min(5).max(80).optional().describe("最多探测接口数（默认 40，并发 2 每接口一次 GET）"),
    include_lazy: z.boolean().optional().describe("递归挖掘懒加载业务 chunk（默认 true）"),
    lazy_chunk_limit: z.number().int().min(1).max(150).optional().describe("懒加载 chunk 拉取上限（默认 120）"),
    base_prefix: z.string().optional().describe("只探测该前缀的接口（如 /api/backend）"),
    method: z.enum(["GET", "POST"]).optional().describe("探测方法（默认 GET）"),
    allow_write: z.boolean().optional().describe("允许用 POST 探测（默认 false）。⚠️ POST 是**真实写请求**——匿名全自动扫描下若某接口恰好无鉴权且非只读，会真实创建/变更生产数据，不可逆"),
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用活动标签页）"),
    hostname: z.string().optional().describe("目标 hostname（在该域名的标签页上执行）")
  },
  async ({ max_apis = 40, include_lazy = true, lazy_chunk_limit = 120, base_prefix, method = "GET", allow_write: allowWrite = false, tab_id: tabId, hostname }) => {
    try {
      // V4.9.11（复验补漏，S0 同型）：POST 必须显式 allow_write 开启——原实现只在描述里写
      // "POST 仅用于查询型 list 接口"（靠调用方自觉，非技术约束），而安全阀 addCand 只查路径，
      // method:"POST" + 路径无写动词即可绕过。现与 batch_unauthorized_api 的安全阀语义对齐
      if (method === 'POST' && !allowWrite) {
        return {
          content: [{
            type: "text",
            text: "❌ 安全阀拦截：method=POST 会对目标发出**真实写请求**——本工具是匿名全自动扫描，若某接口恰好无鉴权又非只读，会真实创建/变更生产数据（不可逆，且无法预知）。\n如已确认目标接口均为查询型只读接口，显式传 allow_write=true 重试。"
          }],
          isError: true
        };
      }
      // 1. chunk 清单
      const chunkList: any = await sendToBrowserRetry("GET_JS_CHUNKS", { maxChunks: 80, tabId, hostname }, 30000);
      const chunksToFetch = (chunkList?.chunks || []).slice(0, 80);
      if (chunksToFetch.length === 0) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "当前活动标签页无 JS 资源记录，请确认目标页为活动标签且已加载" }, null, 1) }] };
      }
      const isNoise = (p: string) => /\.(js|css|png|jpe?g|gif|svg|ico|woff2?|ttf|map|html?)(\?|#|$)/i.test(p) || /\/(assets|static|node_modules|img|images|fonts)\//i.test(p);
      const API_RE = /["'`](\/[a-zA-Z][a-zA-Z0-9_\-\/.{:$]{3,80})["'`]/g;
      const CALL_RE = /\.(get|post|put|delete|request)\s*\(\s*["'`](\/[a-zA-Z0-9_\-\/]{3,70})["'`]/g;

      // 2. 拉取 + 提取
      const directApis = new Set<string>();
      const lazyNames = new Set<string>();
      // V4.9.11（实站实测 app.example.com 驱动）：base 前缀的**完整 URL 形态**——
      // 芋道等框架把后端地址配成 {base_url:"https://api.example.com/admin-api"}（构建后为字面量），
      // 而原 baseLike 正则只认路径形态（/admin-api）→ 提取不到 → 所有 API 被拼成
      // https://app.example.com/system/dict（打到 SPA fallback，拿 200 HTML）而非真实后端路径
      const baseCfgPaths = new Set<string>();
      let maxChunkUrl = "";
      let maxChunkSize = 0;
      for (const c of chunksToFetch) { if ((c.size || 0) > maxChunkSize) { maxChunkSize = c.size || 0; maxChunkUrl = c.url; } }
      const CONC = 8;
      for (let i = 0; i < chunksToFetch.length; i += CONC) {
        const results = await Promise.all(chunksToFetch.slice(i, i + CONC).map((c: any) => fetchChunkText(c.url)));
        for (const cr of results) {
          if (!cr.code) continue;
          let m: RegExpExecArray | null;
          API_RE.lastIndex = 0;
          while ((m = API_RE.exec(cr.code)) !== null && directApis.size < 200) {
            const p = m[1];
            if (!isNoise(p) && p.split("/").length >= 2) directApis.add(p);
          }
          // base 配置提取：完整 URL 取其 pathname，路径形态直接用（统一成 /admin-api 这类前缀）
          BASE_CFG_RE.lastIndex = 0;
          while ((m = BASE_CFG_RE.exec(cr.code)) !== null && baseCfgPaths.size < 20) {
            const clean = normalizeBaseCfg(m[1]);
            if (clean) baseCfgPaths.add(clean);
          }
          // V4.9.11（实站实测 app.example.com 驱动）：对**所有 chunk** 提取，不再只认 maxChunkUrl——
          // 原实现假设"最大的 chunk = 主入口"，实测该站最大的是 form-designer（2MB）而非主入口
          // index（1.67MB），导致 817 个懒加载引用只挖出 1 个（命中率 0.12%，92% 的接口面不可见）
          if (include_lazy) {
            // V4.9.4：vite + webpack 双形态提取（原仅 vite 正则，webpack 站懒加载清单恒空）
            for (const n of extractLazyChunkNames(cr.code, lazy_chunk_limit - lazyNames.size)) lazyNames.add(n);
          }
        }
      }

      // 3. 懒加载业务 chunk 递归（一层）
      const lazyApis = new Map<string, Set<string>>();
      const dirOf = (() => { try { return new URL(".", maxChunkUrl).href; } catch (e) { return ""; } })();
      if (include_lazy && dirOf && lazyNames.size > 0) {
        const lazyUrls = [...lazyNames].map(n => dirOf + n);
        for (let i = 0; i < lazyUrls.length; i += CONC) {
          const results = await Promise.all(lazyUrls.slice(i, i + CONC).map((u: string) => fetchChunkText(u)));
          for (const cr of results) {
            if (!cr.code) continue;
            let m: RegExpExecArray | null;
            CALL_RE.lastIndex = 0;
            while ((m = CALL_RE.exec(cr.code)) !== null && lazyApis.size < 150) {
              const api = m[2], meth = m[1].toUpperCase();
              if (!lazyApis.has(api)) lazyApis.set(api, new Set());
              lazyApis.get(api)!.add(meth);
            }
          }
        }
      }

      // 4. 候选组装：直串 + base×片段组合，过滤登录类
      const baseLike = [...new Set([
        ...[...directApis].filter(p => /^\/(?:api|prod-api|dev-api|admin-api|apis|gateway|base-api)(?:\/(?:backend|gateway|base|admin|web|api|v\d+))?\/?$/.test(p)),
        ...baseCfgPaths,   // V4.9.11：chunk 里 base_url 配置提取到的前缀（完整 URL 已归一为路径形态）
      ])];
      const candidates = new Set<string>();
      const filteredOut: string[] = []; // 被过滤候选报告给 AI（判断是否需要人工深挖，不静默丢弃）
      const addCand = (p: string, isComplete: boolean) => {
        if (isNoise(p) || /\/(login|logout|captcha|register)$/i.test(p)) { filteredOut.push(p + ' (登录类/静态资源)'); return; }
        if (/^\/(src|node_modules|@)\//i.test(p) || /\.(vue|jsx|tsx|ts)$/i.test(p)) { filteredOut.push(p + ' (vite模块路径)'); return; } // vite 模块路径
        if (base_prefix && !p.startsWith(base_prefix)) { filteredOut.push(p + ' (base前缀不符)'); return; }
        // V4.9.5：写操作安全阀——全自动扫描硬过滤写接口（防 AI 误触发不可逆写副作用）
        if (isWriteLikeApi(p)) { filteredOut.push(p + ' (写操作接口已跳过——安全阀)'); return; }
        // 无 base 前缀的片段必须组合后测：裸测相对片段会打 SPA fallback（200 HTML 假 BYPASSED 源）
        if (!isComplete && baseLike.length > 0 && !baseLike.some(b => p.startsWith(b))) { filteredOut.push(p + ' (裸片段待组合)'); return; }
        candidates.add(p);
      };
      for (const p of directApis) {
        if (p.split("/").length < 3) continue;
        const complete = baseLike.some(b => p.startsWith(b));
        addCand(p, complete);
        // V4.9.11：裸片段（不以 base 开头）也要与 base 组合——原实现只有 lazyApis 走组合，
        // directApis 里 /system/dict 这类路径要么被丢弃、要么裸测（打 SPA fallback 拿假 200 HTML）
        if (!complete && baseLike.length > 0) {
          for (const b of baseLike) addCand((b.endsWith("/") ? b.slice(0, -1) : b) + p, true);
        }
      }
      for (const [api] of lazyApis) {
        const complete = baseLike.some(b => api.startsWith(b));
        addCand(api, complete);
        // V4.9.11（验收修复 R2，与 route_api_graph 同一问题）：`complete` 上面算出来了却没用，
        // 已含 base 前缀的懒加载路径会被再拼一次前缀 → 产出 /prod-api/prod-api/xxx 这类无效候选
        // （上面 directApis 那处已有 `!complete` 守卫，此处补齐）
        for (const b of baseLike) {
          const prefix = b.endsWith("/") ? b.slice(0, -1) : b;
          if (api === prefix || api.startsWith(prefix + "/")) continue;
          addCand(prefix + api, true);
        }
      }
      const targets = [...candidates].slice(0, max_apis);

      // 5. 匿名判定（复用 batch 逻辑：并发 2，每接口一次）
      const pageInfo: any = await sendToBrowser("GET_PAGE_INFO", { tabId, hostname }, 15000);
      const origin = (() => { try { return new URL(pageInfo.url).origin; } catch (e) { return ""; } })();
      const queue = [...targets];
      const results: any[] = [];
      const summary = { bypassed: 0, enforced: 0, unclear: 0 };
      const worker = async () => {
        while (queue.length > 0) {
          if (!isBrowserConnected()) { queue.length = 0; break; }
          const api = queue.shift()!;
          const fullUrl = api.startsWith("http") ? api : origin + api;
          try {
            const anon = await anonFetchWithServerFallback(fullUrl, method, undefined, null, 25000, { tabId, hostname });
            const verdict = judgeUnauthorized(anon);
            summary[verdict.verdict === "BYPASSED" ? "bypassed" : verdict.verdict === "ENFORCED" ? "enforced" : "unclear"]++;
            // V4.9.22（复验🟡-2 残句）：补 `evidence` —— 另两个调用点（batch_unauthorized_api:667 /
            // smart_unauthorized_test:603）都带，只有这里漏了。缺它的后果：写方法"不重发"时
            // AI 只看到 rule（"页面侧未执行/未回读"）而**看不到**"服务端可能已受理——先用查询接口核对"
            // 这句操作指令，恰恰是防误重试的那半句。
            results.push({ api: fullUrl, verdict: verdict.verdict, confidence: verdict.confidence, rule: verdict.rule, evidence: verdict.evidence, status: anon.status, contentType: anon.contentType, bodySample: (anon.bodySample || "").slice(0, 600) });
          } catch (e: any) {
            summary.unclear++;
            results.push({ api: fullUrl, verdict: "UNCLEAR", evidence: e.message });
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(2, queue.length) }, worker));

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            method, candidates: targets.length, tested: results.length, summary,
            diag: { chunks: chunksToFetch.length, directApis: directApis.size, lazyChunks: lazyNames.size, lazyApis: lazyApis.size, baseLike: baseLike,
              // V4.9.11：透出 chunk 来源——cdp-performance 为权威来源，webrequest-buffer(fallback) 表示
              // 走了降级（可能混入历史记录，结果可信度下降，建议重跑一次）
              chunkSource: (chunkList && chunkList.source) || 'unknown' },
            highRisk: results.filter(r => r.verdict === "BYPASSED" && r.confidence === "high"),
            baseCandidates: baseLike,
            filteredOut: [...new Set(filteredOut)].slice(0, 30),
            results
          }, null, 1)
        }]
      };
    } catch (error: any) {
      return { content: [{ type: "text", text: `未授权扫描失败: ${error.message}` }], isError: true };
    }
  }
);
// 90. API 级未授权批量验证（V4.3：国内后台真正的洞在 API 层——匿名打 JSON 接口，200+数据即实锤）
server.tool(
  "batch_unauthorized_api",
  "API 级批量验证（匿名 + 认证态双模式）：对 API 清单逐个发请求，三态判定 BYPASSED/ENFORCED/UNCLEAR。默认**匿名视角**（不带 cookie）；传 bearer_token/tenant_id 后切换为**认证态视角**——渗透中 token 常来自攻击链本身（未授权注册/接口泄露/爆破），拿到即用。API 清单先用 route_api_graph 获取（allApiPaths/unmappedApis）。安全阀：默认过滤写操作接口（save/delete/import 等）**及非只读 HTTP 方法**（POST/PUT/DELETE/PATCH），显式 allow_write=true 才测写。【证据边界】BYPASSED 只代表拿到了响应——返回数据是否有效/是否含真实业务信息需人工判读后再定级；UNCLEAR 不构成任何证据；报漏洞前必须复核 bodySample",
  {
    apis: z.array(z.string()).min(1).describe("API 路径列表（相对路径如 /prod-api/system/user/list，或完整 URL）"),
    method: z.enum(["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"]).optional().describe("HTTP 方法（默认 GET；POST/PUT/DELETE 测写操作越权——注意：非只读方法默认被安全阀拦截，需同时传 allow_write=true）"),
    body: z.string().optional().describe("POST/PUT 请求体（JSON 字符串）"),
    maxTest: z.number().int().min(1).max(50).optional().describe("最多测试数量（默认 20，防止刷爆）"),
    concurrency: z.number().int().min(1).max(5).optional().describe("并发数（默认 2，过高可能触发风控）"),
    allow_write: z.boolean().optional().describe("允许测试写操作类接口（默认 false——安全阀过滤 save/delete/import 等；仅在明确知道接口幂等/无副作用时开启）"),
    bearer_token: z.string().optional().describe("可选：访问令牌（不必带 Bearer 前缀，会自动补）。带上即切换为**认证态测试**——同一接口匿名 vs 认证的响应差异就是越权证据；若认证态能读到匿名读不到的数据，即为漏洞"),
    tenant_id: z.string().optional().describe("可选：租户 ID（多租户框架如芋道/若依用 tenant-id 头区分租户）。换不同 tenant_id 可验证**跨租户越权**——注意跨租户测试可能触碰其他单位的数据，需在授权范围内"),
    allow_cross_origin: z.boolean().optional().describe("可选：显式允许跨源请求携带认证头（默认拦截——防 token 发往非预期主机）。前后端分离且 API host 与页面 host 不同源时**必须开启**，但请核对 URL 确属当前测试目标"),
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用活动标签页）"),
    hostname: z.string().optional().describe("目标 hostname（在该域名的标签页上执行）")
  },
  async ({ apis, method = 'GET', body, maxTest = 20, concurrency = 2, allow_write: allowWrite = false, bearer_token: bearerToken, tenant_id: tenantId, allow_cross_origin: allowCrossOrigin = false, tab_id: tabId, hostname }) => {
    try {
      // V4.9.11（黑盒实测驱动）：认证态注入——token/租户头由调用方提供。
      // 渗透中"拿到一个 token"常是攻击链的第一环（未授权注册/接口泄露/爆破），
      // 拿到后应能立刻做系统化测试（而不是让 AI 手写脚本逐个发）
      const authHdrs: Record<string, string> = {};
      if (bearerToken) authHdrs['Authorization'] = /^Bearer\s/i.test(bearerToken) ? bearerToken : `Bearer ${bearerToken}`;
      if (tenantId) authHdrs['tenant-id'] = tenantId;
      const extraHeaders = Object.keys(authHdrs).length > 0 ? authHdrs : null;

      // 拼接 baseURL：相对路径需要当前页面 origin
      const pageInfo = await sendToBrowser("GET_PAGE_INFO", { tabId, hostname }, 10000);
      const origin = (() => {
        try { return new URL(pageInfo.url).origin; } catch (e) { return ''; }
      })();

      // V4.9.5：写操作安全阀——默认过滤写接口（防 AI 误发不可逆请求），被过滤项在结果中明示
      // V4.9.11（验收修复 S0）：安全阀补上 **method 维度**——原实现只查路径（isWriteLikeApi 只接受 URL 一个参数），
      // method:"DELETE" + 路径不含写动词（如 /api/v1/users/42）可**完全绕过**安全阀发出真实破坏性请求，
      // 与工具描述"显式 allow_write=true 才测写"直接矛盾
      const normalizedMethod = String(method || 'GET').toUpperCase();
      const isReadMethod = normalizedMethod === 'GET' || normalizedMethod === 'HEAD';
      const writeSkipped: string[] = [];
      let targets = apis.slice(0, maxTest);
      if (!allowWrite) {
        targets = targets.filter(a => {
          if (!isReadMethod) { writeSkipped.push(`${normalizedMethod} ${a}`); return false; }
          if (isWriteLikeApi(a)) { writeSkipped.push(a); return false; }
          return true;
        });
      }
      const results: any[] = [];
      const summary = { bypassed: 0, enforced: 0, unclear: 0 };

      // 小并发批处理（避免串行太慢、也避免并发过高触发风控）
      const queue = [...targets];
      const worker = async () => {
        while (queue.length > 0) {
          if (!isBrowserConnected()) {
            results.push({ api: queue.join(','), verdict: 'ABORTED', evidence: '浏览器扩展连接断开，剩余未测' });
            queue.length = 0;
            break;
          }
          const api = queue.shift()!;
          const fullUrl = api.startsWith('http') ? api : `${origin}${api.startsWith('/') ? '' : '/'}${api}`;
          // 批2审计 M1：跨 host + 认证头组合闸——多目标会话中 AI 把上一目标的 URL/清单混入
          // 当前调用时，有效 token 会原样发往无关第三方主机（落对方日志）。allow_write 时更升级为
          // 带认证的写请求打错 host。fullUrl 与当前页 origin 同源则不拦（前后端分离的合法形态）
          let crossOrigin = false;
          try { crossOrigin = new URL(fullUrl).origin !== new URL(origin || fullUrl).origin; } catch { /* 解析失败按同源处理 */ }
          if (extraHeaders && crossOrigin && !allowCrossOrigin) {
            results.push({ api, verdict: 'SKIPPED', evidence: `⚠️ 跨源请求（${new URL(fullUrl).origin}）携带认证头且未显式 allow_cross_origin=true——防止 token 发往非预期主机` });
            continue;
          }
          try {
            const anon = await anonFetchWithServerFallback(fullUrl, normalizedMethod, body, extraHeaders, 25000, { tabId, hostname });
            const verdict = judgeUnauthorized(anon);
            summary[verdict.verdict === 'BYPASSED' ? 'bypassed' : verdict.verdict === 'ENFORCED' ? 'enforced' : 'unclear']++;
            results.push({
              api: fullUrl,
              authMode: extraHeaders ? 'authenticated' : 'anonymous',   // V4.9.11：标明本次请求的视角
              verdict: verdict.verdict,
              confidence: verdict.confidence,
              // V4.9.11：认证态测试时，规则文案里的"匿名"措辞不再适用（会误导 AI 判读），
              // 统一替换为"当前身份"——视角由上层 authMode 字段标明
              // V4.9.11（验收修复 B18）：认证态下 401 要如实提示——原实现一律回"HTTP 401 显式拒绝"
              // （ENFORCED），但带着 token 仍 401 说明**token 无效/已过期**，与"接口已鉴权"是两码事，
              // 会误导 AI 认为该接口防护到位而放弃。加提示让其换有效 token 重测
              rule: (extraHeaders ? verdict.rule.replace(/匿名/g, '当前身份') : verdict.rule)
                + (extraHeaders && anon.status === 401
                    ? '（⚠️ 认证态返回 401：说明本次 token 无效/已过期——这不代表接口已鉴权，请换有效 token 重测）'
                    : ''),
              evidence: verdict.evidence,
              status: anon.status,
              sensitiveHits: anon.sensitiveHits || [],
              bodySample: (anon.bodySample || '').slice(0, 600),
              contentType: anon.contentType
            });
          } catch (e: any) {
            summary.unclear++;
            results.push({ api: fullUrl, verdict: 'UNCLEAR', evidence: e.message });
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            method: normalizedMethod, tested: targets.length, summary,
            authMode: extraHeaders ? 'authenticated' : 'anonymous',   // V4.9.11：本次测试视角（匿名/认证态）
            tenantId: tenantId || undefined,
            writeSkipped: writeSkipped.length > 0 ? writeSkipped : undefined,
            writeSkippedNote: writeSkipped.length > 0 ? '安全阀已跳过上述目标（路径含写动词，或 HTTP 方法非只读 GET/HEAD；如确需测试且确认接口幂等/无副作用，加 allow_write=true）' : undefined,
            highRisk: results.filter(r => r.verdict === 'BYPASSED' && r.confidence === 'high'),
            results
          }, null, 1)
        }]
      };
    } catch (error: any) {
      return { content: [{ type: "text", text: `批量未授权验证失败: ${error.message}` }], isError: true };
    }
  }
);
// 97. 信息泄露一键扫描（V4.7：chunk 源码硬编码敏感信息挖掘——内网 IP/默认口令/第三方Key/环境变量残留/硬编码token）
server.tool(
  "info_leak_scan",
  "前端信息泄露一键扫描：拉取页面全部 JS chunk 源码，挖掘硬编码敏感信息——内网 IP/域名、默认或硬编码口令、第三方服务 Key（高德/阿里云/OSS/微信/钉钉等）、环境变量残留（VITE_/VUE_APP_/REACT_APP_）、硬编码 Bearer token、邮箱。按类型分组输出样例",
  {
    max_chunks: z.number().int().min(1).max(200).optional().describe("chunk 扫描上限（默认 120）"),
    per_type_limit: z.number().int().min(1).max(50).optional().describe("每类样例上限（默认 10）"),
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用活动标签页）"),
    hostname: z.string().optional().describe("目标 hostname（在该域名的标签页上执行）")
  },
  async ({ max_chunks = 120, per_type_limit = 10, tab_id: tabId, hostname }) => {
    try {
      const chunkList: any = await sendToBrowserRetry("GET_JS_CHUNKS", { maxChunks: max_chunks, tabId, hostname }, 30000);
      const chunks = (chunkList?.chunks || []).slice(0, max_chunks);
      if (chunks.length === 0) return { content: [{ type: "text", text: JSON.stringify({ scanned: 0, totalFindings: 0, note: "当前活动标签页无 JS 资源记录" }, null, 1) }] };

      const LEAK_PATTERNS: Array<{ type: string; re: RegExp; group: number }> = [
        { type: "内网IP/地址", re: /https?:\/\/(?:10\.\d{1,3}|192\.168\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}[.\d:\/\-a-zA-Z]*/g, group: 0 },
        { type: "第三方Key/AppId", re: /(?:amap|gaode|bdapp|baidu|bmap|qqmap|aliyun|aliyunoss|cos|qcloud|wechat|wx|weixin|dingtalk|feishu|qq|sentry|umeng|bugly)["']?_?(?:key|appid|app_id|secret|corpid|agentid|dsn)["']?\s*[:=]\s*["']([A-Za-z0-9_\-]{8,64})["']/gi, group: 1 },
        { type: "环境变量残留", re: /((?:VITE|REACT_APP|VUE_APP|NEXT_PUBLIC)_[A-Z0-9_]{2,40})\s*[:=]\s*["']([^"']{1,120})["']/g, group: 0 },
        { type: "硬编码Token", re: /["'](Bearer\s+[A-Za-z0-9_\-.]{20,200})["']/g, group: 1 },
        { type: "硬编码口令", re: /(?:password|passwd|pwd)["']?\s*[:=]\s*["']([^"']{6,40})["']/gi, group: 1 },
        { type: "邮箱", re: /["']([a-zA-Z0-9._%+-]+@(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,10})["']/g, group: 1 },
        { type: "内网域名", re: /["']([a-z0-9-]+\.(?:internal|local|intranet|corp|lan|svc))["']/gi, group: 1 }
      ];
      const grouped: Record<string, Array<{ sample: string; chunk: string }>> = {};
      const CONC = 8;
      // 懒加载业务 chunk 递归（V4.7：业务 chunk 才是敏感信息主产地，zb 实测 78 个懒加载 vs 主文档 2 个）
      // V4.9.4：vite + webpack 双形态提取（webpack runtime 的 chunk URL 构造函数解析）
      let maxChunkUrl = "";
      let maxSz = 0;
      for (const c of chunks) { if ((c.size || 0) > maxSz) { maxSz = c.size || 0; maxChunkUrl = c.url; } }
      let targets: string[] = chunks.map((c: any) => c.url);
      // V4.9.11（实站实测 app.example.com 驱动）：从**多个种子 chunk**（按大小取前 20）提取懒加载清单，
      // 不再只认 maxChunkUrl——原实现假设"最大 chunk = 主入口"，实测该站最大的是 form-designer（2MB）
      // 而非主入口 index（1.67MB），817 个懒加载引用只挖出 1 个
      // V4.9.11（验收修复 S3）：懒加载展开加**总量上限**——原实现是 20 个种子 × 每种子 max_chunks(120)，
      // 最坏 2400-4000 个 URL 全部进 targets 逐个拉取（失败还重试一次），实测大站单次扫描可达 5000+ 请求，
      // 是 sweep(120)/route_api_graph(150) 的 16-20 倍，有触发目标封 IP 的实际风险（用户环境已知
      // 5 并发持续 33 分钟即触发封禁）。语义澄清为：max_chunks 是本次扫描**全部懒加载 chunk 的总配额**
      if (maxChunkUrl) {
        const seedChunks = [...chunks].sort((a: any, b: any) => (b.size || 0) - (a.size || 0)).slice(0, 20);
        const lazySet = new Set<string>();
        const lazyCap = Math.max(1, max_chunks);
        for (let i = 0; i < seedChunks.length; i += 8) {
          if (lazySet.size >= lazyCap) break;   // 配额用尽，不再抓取后续种子
          const batch = seedChunks.slice(i, i + 8);
          const fetched = await Promise.all(batch.map(async (sc: any) => {
            try { const resp = await safeFetch(sc.url, {}, 35000); return resp.ok ? { url: sc.url, code: await resp.text() } : null; }
            catch (e) { return null; }
          }));
          for (const fr of fetched) {
            if (!fr) continue;
            const quota = Math.min(max_chunks, lazyCap - lazySet.size);
            if (quota <= 0) break;
            const dirOf = (() => { try { return new URL(".", fr.url).href; } catch (e) { return ""; } })();
            for (const n of extractLazyChunkNames(fr.code, quota)) {
              lazySet.add(dirOf + n);
              if (lazySet.size >= lazyCap) break;
            }
          }
        }
        // 去重：懒加载 URL 可能与已列出的 chunk 重复（同一 chunk 被多个种子引用）
        targets = [...new Set([...targets, ...lazySet])];
      }
      // V4.9.24（清单🟡-11）：拉取失败的 chunk 原为**静默跳过**，而 `scannedChunks` 报的是**尝试数**
      // → "120 个 chunk 扫完，没有敏感信息"里可能有一半根本没拉到。同项目 `extract_chunk_keys` 早有
      // `failures[]` 范式，这两个工具漏了
      const failures: Array<{ url: string; error: string }> = [];
      let fetchedOk = 0;
      for (let i = 0; i < targets.length; i += CONC) {
        const results = await Promise.all(targets.slice(i, i + CONC).map((u: string) => fetchChunkText(u)));
        for (const cr of results) {
          if (!cr.code) { failures.push({ url: cr.url, error: cr.error || '空内容' }); continue; }
          fetchedOk++;
          const chunkName = cr.url.split("/").pop() || cr.url;
          // V4.9.11（实站实测 app.example.com）：本地化文件整体跳过——i18n 文案必然包含 password/密码 等词
          // （实测 zh-CN-*.js 单文件产出 10 条"硬编码口令"全误报），扫描它只有噪声
          if (/(?:^|[/\-_.])(?:zh-CN|zh_CN|en-US|en_US|ja-JP|ko-KR|locale|i18n|langs?)(?:[/\-_.]|$)/i.test(chunkName)) continue;
          for (const { type, re, group } of LEAK_PATTERNS) {
            if (!grouped[type]) grouped[type] = [];
            if (grouped[type].length >= per_type_limit) { re.lastIndex = 0; continue; }
            re.lastIndex = 0;
            let m: RegExpExecArray | null;
            while ((m = re.exec(cr.code)) !== null && grouped[type].length < per_type_limit) {
              const sample = (m[group] || m[0] || "").slice(0, 150);
              // 口令类过滤明显占位/样例值
              if (type === "硬编码口令") {
                if (/^(?:password|passwd|pwd|123456abcdef|x{3,}|\*+)$/i.test(sample)) continue;  // 占位词
                if (/^[a-zA-Z]{3,10}$/.test(sample)) continue;                                   // 纯字母短值（refresh/admin 等）
                // V4.9.11（实站实测）：i18n 文案误报——password:"锁屏密码"（「锁屏密码」的
                // Unicode 转义）被当成口令。真实口令不可能是转义序列，也不可能是中外文界面文案
                if (/^\\u[0-9a-fA-F]{4}/.test(sample)) continue;                                 // Unicode 转义序列
                if (/[一-龥]/.test(sample)) continue;                                    // 含中文（界面文案）
              }
              grouped[type].push({ sample, chunk: chunkName });
            }
          }
        }
      }
      const totalFindings = Object.values(grouped).reduce((n, arr) => n + arr.length, 0);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            attemptedChunks: targets.length,     // 尝试拉取数
            scannedChunks: fetchedOk,            // **实际扫到源码的**数量（原实现报的是尝试数）
            failedChunks: failures.length,
            totalFindings,
            byType: Object.fromEntries(Object.entries(grouped).map(([t, arr]) => [t, arr.length])),
            findings: grouped,
            failures: failures.slice(0, 10),
            note: "样例截断 150 字符。口令/邮箱类含样例值误报可能，报漏洞前需人工确认。内网 IP/第三方 Key/环境变量残留命中即为有价值线索"
              + (failures.length > 0 ? `。⚠️ **${failures.length}/${targets.length} 个 chunk 未拉到**（见 failures）——这些文件**未被扫描**，"无发现"不等于"没有"` : "")
          }, null, 1)
        }]
      };
    } catch (error: any) {
      return { content: [{ type: "text", text: `信息泄露扫描失败: ${error.message}` }], isError: true };
    }
  }
);
// 96b. chunk 源码原文（V4.7.1 定位校准：原料型工具——AI 直接阅读源码比正则提取能发现更多
// 业务逻辑/注释/隐藏接口/参数结构。工具只负责取数，判断交给 AI）
server.tool(
  "get_chunk_source",
  "获取页面已加载 JS chunk 的源码原文供 AI 直接阅读分析（业务逻辑/注释/隐藏接口/参数结构/硬编码密钥——正则提取抓不到的都靠读源码）。源码超长时用 offset 分段读取。**读的是 tab_id/hostname 指定标签页已加载的 chunk**",
  {
    url_keyword: z.string().describe("chunk URL 关键词，如 'index-rWWQ' 或 'login'，取自 GET_JS_CHUNKS 返回的 url"),
    offset: z.number().int().min(0).optional().describe("起始偏移，默认 0（配合返回的 nextOffset 分段读完整个 chunk）"),
    length: z.number().int().min(1000).max(300000).optional().describe("本次读取长度（默认 120000 字符）"),
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用活动标签页）"),
    hostname: z.string().optional().describe("目标 hostname（在该域名的标签页上执行）")
  },
  async ({ url_keyword, offset = 0, length = 120000, tab_id: tabId, hostname }) => {
    try {
      const chunkList = await getJSChunksCached(200, { tabId, hostname });
      const chunks = chunkList.chunks;
      const matched = chunks.filter((c: any) => c.url.includes(url_keyword));
      if (matched.length === 0) {
        return { content: [{ type: "text", text: JSON.stringify({ error: `未找到 URL 含 '${url_keyword}' 的 chunk`, availableChunks: chunks.map((c: any) => c.url.split("/").pop()) }, null, 1) }] };
      }
      const cr = await fetchChunkText(matched[0].url);
      if (!cr.code) return { content: [{ type: "text", text: JSON.stringify({ error: `chunk 拉取失败: ${cr.error}` }, null, 1) }] };
      const total = cr.code.length;
      const seg = cr.code.slice(offset, offset + length);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            url: cr.url, totalLength: total,
            offset, returnedLength: seg.length,
            nextOffset: offset + seg.length < total ? offset + seg.length : null,
            code: seg,
            // V4.9.28：降级路径未按 hostname 过滤时，命中的 chunk 可能根本不属于目标站
            ...(chunkList.hostFilterDisabled ? {
              hostFilterNote: "⚠️ 本次 chunk 清单**未按 hostname 过滤**（webRequest 缓冲降级路径）——上面 url 可能不是目标站的资源，读源码前请先核对 hostname"
            } : {}),
            aiHint: "阅读重点建议：axios/fetch 调用的参数结构、条件分支里的隐藏接口、硬编码凭据、注释、路由配置、权限判断逻辑"
          }, null, 1)
        }]
      };
    } catch (error: any) {
      return { content: [{ type: "text", text: `chunk 源码获取失败: ${error.message}` }], isError: true };
    }
  }
);
// 93. JS 静态密钥提取（V4.5，竞品缺口：拉 chunk 源码正则挖 PEM/RSA/JWKS/AK-SK/AES 密钥）
server.tool(
  "extract_keys_from_js",
  "静态密钥提取：拉取页面已加载 JS chunk 源码，正则挖掘 PEM 公私钥、JSEncrypt setPublicKey/setPrivateKey、JWKS、AK/SK、AES key/iv 等硬编码密钥。签名还原的前置捷径（动态 Hook 抓运行时密钥，本工具补静态盲区）",
  {
    max_chunks: z.number().int().min(1).max(100).optional().describe("chunk 扫描上限（默认 30）"),
    filter: z.string().optional().describe("chunk URL 关键词过滤"),
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用活动标签页）"),
    hostname: z.string().optional().describe("目标 hostname（在该域名的标签页上执行）")
  },
  async ({ max_chunks = 30, filter, tab_id: tabId, hostname }) => {
    try {
      let chunkList: any = await sendToBrowserRetry("GET_JS_CHUNKS", { maxChunks: max_chunks, tabId, hostname });
      let chunks: any[] = (chunkList?.chunks || []).filter((c: any) => !filter || c.url.includes(filter)).slice(0, max_chunks);
      if (chunks.length === 0) return { content: [{ type: "text", text: JSON.stringify({ scannedChunks: 0, findingCount: 0, findings: [], note: "当前活动标签页没有 JS 资源记录，请确认目标页为活动标签且已加载" }, null, 1) }] };

      const KEY_PATTERNS: Array<{ type: string; re: RegExp; group: number }> = [
        { type: "PEM_KEY", re: /-----BEGIN (?:[A-Z ]+ )?KEY-----[\s\S]{20,800}?-----END [A-Z ]+ KEY-----/g, group: 0 },
        { type: "JSENCRYPT_KEY", re: /set(?:Public|Private)Key\s*\(\s*["'`]([A-Za-z0-9+/=\n\r_-]{40,600})["'`]/g, group: 1 },
        { type: "JWKS", re: /["']?kty["']?\s*:\s*["'](RSA|EC|oct)["'][\s\S]{10,400}?["']?(?:n|e|kid)["']?\s*:\s*["'][A-Za-z0-9_-]{8,200}["']/g, group: 0 },
        { type: "AK_SK", re: /["']?(?:accessKey(?:Secret|Id)?|secretKey|access_key|secret_key)["']?\s*[:=]\s*["']([A-Za-z0-9+/=_-]{12,128})["']/gi, group: 1 }, // 删 ak|sk 短键：minify bundle 上 task:/mask:/risk: 等误命中挤掉真密钥
        { type: "AES_KEY", re: /["']?(?:aesKey|aes_key|secretKey|decryptKey)["']?\s*[:=]\s*["']([A-Za-z0-9+/=]{16,64})["']/gi, group: 1 },
        { type: "HMAC_SECRET", re: /["']?(?:hmacSecret|hmac_key|signKey|sign_key)["']?\s*[:=]\s*["']([A-Za-z0-9+/=_-]{16,128})["']/gi, group: 1 }
      ];
      const findings: Array<{ url: string; type: string; sample: string }> = [];
      const seenSample = new Set<string>();
      // V4.9.24（清单🟡-11）：同 info_leak_scan——失败 chunk 原静默跳过，`scannedChunks` 报的是**候选数**
      const failures: Array<{ url: string; error: string }> = [];
      let fetchedOk = 0;
      const CONCURRENCY = 8;
      for (let i = 0; i < chunks.length; i += CONCURRENCY) {
        const results = await Promise.all(chunks.slice(i, i + CONCURRENCY).map((c: any) => fetchChunkText(c.url)));
        for (const cr of results) {
          if (!cr.code) { failures.push({ url: cr.url, error: cr.error || '空内容' }); continue; }
          fetchedOk++;
          for (const { type, re, group } of KEY_PATTERNS) {
            re.lastIndex = 0;
            let m: RegExpExecArray | null;
            while ((m = re.exec(cr.code)) !== null && findings.length < 100) {
              const sample = (m[group] || m[0] || "").slice(0, 220);
              const dedupe = type + ":" + sample.slice(0, 80);
              if (seenSample.has(dedupe)) continue;
              seenSample.add(dedupe);
              findings.push({ url: cr.url, type, sample });
            }
          }
        }
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            attemptedChunks: chunks.length,   // 候选数
            scannedChunks: fetchedOk,         // **实际扫到源码的**数量（原实现报的是候选数）
            failedChunks: failures.length,
            findingCount: findings.length,
            findings,
            failures: failures.slice(0, 10),
            note: "sample 截断至 220 字符。PUBLIC key/IV 本身不算漏洞，PRIVATE key/AK/SK 硬编码按认钥闸判定（无效密钥不报）"
              + (failures.length > 0 ? `。⚠️ **${failures.length}/${chunks.length} 个 chunk 未拉到**（见 failures）——这些文件**未被扫描**，密钥可能就在其中` : "")
          }, null, 1)
        }]
      };
    } catch (error: any) {
      return { content: [{ type: "text", text: `密钥提取失败: ${error.message}` }], isError: true };
    }
  }
);

// 94. WS 消息查询 → 已合并至 44 号 get_ws_messages（V4.5 改调 hook_websocket 新链路 GET_WS_FRAMES）
server.tool(
  "extract_chunk_keys",
  "批量提取页面已加载 JS chunk 中的硬编码密钥（secretKey/aesKey/signKey 等赋值、32/48/64位 hex 密钥特征），可选下载 source map 恢复源码文件清单定位密钥所在文件。与 route_api_graph 互补：后者出路由→API 图谱，本工具出密钥清单（改参重放/解密前置）",
  {
    maxChunks: z.number().int().min(1).max(200).optional().describe("最多分析的 chunk 数，默认 30，最大 200"),
    withSourceMap: z.boolean().optional().describe("是否下载 source map 恢复源码文件清单（默认 false，耗时且部分站点不暴露 .map）"),
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用活动标签页）"),
    hostname: z.string().optional().describe("目标 hostname（在该域名的标签页上执行）")
  },
  async ({ maxChunks, withSourceMap = false, tab_id: tabId, hostname }) => {
    try {
      const maxN = Math.min(maxChunks || 30, 200);
      const chunkList = await sendToBrowserRetry("GET_JS_CHUNKS", { maxChunks: maxN, tabId, hostname });
      const chunksToFetch = (chunkList?.chunks || []).slice(0, maxN);
      const CONCURRENCY = 8;
      const findings: Array<{ chunkUrl: string; size: number; keys: Array<{ type: string; name?: string; value: string; context: string }>; sourceFiles?: string[] }> = [];
      const failures: Array<{ url: string; error: string }> = [];
      const allKeys = new Set<string>();

      for (let i = 0; i < chunksToFetch.length; i += CONCURRENCY) {
        const batch = chunksToFetch.slice(i, i + CONCURRENCY);
        const results = await Promise.all(batch.map((c: any) => fetchChunkText(c.url)));
        for (const r of results) {
          if (r.error || !r.code) { failures.push({ url: r.url, error: r.error || '空内容' }); continue; }
          const { keys, sourceMapUrl } = extractChunkKeysFromCode(r.code, r.url);
          if (keys.length === 0 && !sourceMapUrl) continue;
          const size = chunksToFetch.find((c: any) => c.url === r.url)?.size || r.code.length;
          const entry: any = { chunkUrl: r.url, size, keys };
          if (withSourceMap && sourceMapUrl) {
            try {
              const mapUrl = new URL(sourceMapUrl, r.url).toString();
              const mapResp = await fetchChunkText(mapUrl, 8000);
              if (mapResp.code) {
                const mapJson = JSON.parse(mapResp.code);
                if (Array.isArray(mapJson.sources)) {
                  entry.sourceFiles = mapJson.sources.filter((s: string) => !s.includes('node_modules') && !s.includes('webpack')).slice(0, 40);
                }
              }
            } catch { /* .map 不存在或解析失败不影响主流程 */ }
          }
          keys.forEach(k => allKeys.add(k.value));
          findings.push(entry);
        }
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            pageUrl: chunkList?.pageUrl || null,
            stats: { totalChunks: chunksToFetch.length, chunksWithKeys: findings.length, failedChunks: failures.length },
            uniqueKeys: Array.from(allKeys).slice(0, 100),
            findings: findings.slice(0, 50),
            failures: failures.slice(0, 10),
            usage: 'uniqueKeys 是全局去重后的密钥清单（先看 assignment 类型的硬编码；hex 类型需结合算法判断是密钥还是哈希值）；context 是密钥在压缩代码中的上下文；sourceFiles 是 source map 恢复的源码路径（定位密钥所在 .vue/.js 文件）。拿到密钥后可配 sign_payload 重算或 node crypto 解密改参重放。'
          }, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `提取 chunk 密钥失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);
// 75. Nuxt /_payload.json 探测（CVE-2026-71316 检测）
server.tool(
  "nuxt_payload_probe",
  "探测 Nuxt 站点 /_payload.json 端点（CVE-2026-71316 类漏洞：Nuxt 运行时 payload 按路径缓存，未认证用户可能读到跨用户 SSR 数据）。以匿名身份（不带 cookie）请求每个路由的 _payload.json，报告是否可匿名读取及是否含敏感字段。paths 不传时自动使用 Get_Nuxt 脚本提取的页面路径。",
  {
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用活动标签页）"),
    hostname: z.string().optional().describe("目标 hostname（在该域名的标签页上执行）"),
    paths: z.array(z.string()).optional().describe("要探测的页面路径列表（如 /user/profile）。不传则自动从已提取的 Nuxt 数据中获取"),
    waitMs: z.number().optional().describe("每个请求之间的间隔毫秒数，默认300，避免打爆目标")
  },
  async ({ paths, waitMs = 300, tab_id: tabId, hostname }) => {
    try {
      let probePaths = paths || [];

      // 未指定路径时，从已提取的 Nuxt 数据自动获取
      if (probePaths.length === 0) {
        try {
          const vueData = await sendToBrowser("GET_VUE_ROUTER_DATA", { tabId, hostname });
          const nuxtPaths = vueData?.nuxtData?.paths;
          if (Array.isArray(nuxtPaths) && nuxtPaths.length > 0) {
            probePaths = nuxtPaths.slice(0, 50);
          }
        } catch (e) { /* 继续，下面会报错 */ }
      }

      if (probePaths.length === 0) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              message: "未提供路径且未提取到 Nuxt 数据。请先启用 Get_Nuxt 脚本并刷新页面，或手动传入 paths 参数。",
              paths: [],
              results: []
            }, null, 2)
          }]
        };
      }

      const probeResult = await sendToBrowser("NUXT_PAYLOAD_PROBE", {
        paths: probePaths,
        waitMs: Math.max(100, waitMs), tabId, hostname }, 60000);

      return {
        content: [{
          type: "text",
          text: JSON.stringify(probeResult, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `探测失败: ${error.message}` }],
        isError: true
      };
    }
  }
);
// 96. sourcemap 泄露探测（V4.7：vite/webpack 忘关 sourcemap = 全量源码泄露，常见真实漏洞）
server.tool(
  "check_sourcemaps",
  "sourcemap 泄露探测：对页面全部 JS chunk 逐个匿名探测 .map 文件（200 + JSON sourcemap 结构 = 源码泄露，可还原全部前端源码含接口/逻辑/注释）。构建时未关 sourcemap 是生产环境常见漏配。返回体区分**三态**：`checked`（真探到结论）/ `failed`（探测失败=**未验证**）/ `leakedCount`——failed 的 chunk 不等于安全，别把整体结论读成\"全站没有泄露\"",
  {
    max_chunks: z.number().int().min(1).max(200).optional().describe("chunk 探测**总量**上限（默认 60）——含懒加载展开，是本次扫描的总配额而非每个种子的配额（防止大站展开出数千请求）"),
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用活动标签页）"),
    hostname: z.string().optional().describe("目标 hostname（在该域名的标签页上执行）")
  },
  async ({ max_chunks = 60, tab_id: tabId, hostname }) => {
    try {
      const chunkList: any = await sendToBrowserRetry("GET_JS_CHUNKS", { maxChunks: max_chunks, tabId, hostname }, 30000);
      const chunks = (chunkList?.chunks || []).slice(0, max_chunks);
      if (chunks.length === 0) return { content: [{ type: "text", text: JSON.stringify({ scanned: 0, leaked: 0, note: "当前活动标签页无 JS 资源记录" }, null, 1) }] };

      const dirOf = (() => { try { return new URL(".", chunks[0].url).href; } catch (e) { return ""; } })();
      // V4.9.24（清单🟡-10）：加 `probeError` 第三态——原把**探测失败**和**确认无泄露**挤进同一个
      // `leaked:false`，于是 `safe = results.length - leaked.length` 把"没测成"算成了"安全"，
      // note 还断言"未发现 sourcemap 泄露"。**"没测成"报成"没有漏洞"是渗透工具最危险的输出形态**
      const results: Array<{ chunk: string; mapUrl: string; leaked: boolean; sourcesCount?: number; sampleSource?: string; probeError?: string }> = [];
      const CONC = 8;
      for (let i = 0; i < chunks.length; i += CONC) {
        await Promise.all(chunks.slice(i, i + CONC).map(async (c: any) => {
          // V4.9.11（验收修复 B17）：拼接前剥掉 query/hash——`index.js?v=1` 直接 + ".map" 会
          // 得到 `index.js?v=1.map`（必然 404），把真实的 sourcemap 泄露漏掉。
          // 配套：SW 侧 GET_JS_CHUNKS 的过滤已从 endsWith('.js') 改为正则，带 query 的 chunk 才进得来
          const mapUrl = c.url.replace(/[?#].*$/, "") + ".map";
          try {
            const resp = await safeFetch(mapUrl, { redirect: "manual" }, 15000);
            if (resp.status !== 200) { results.push({ chunk: c.url.split("/").pop(), mapUrl, leaked: false }); return; }
            const ct = resp.headers.get("content-type") || "";
            if (/html/i.test(ct)) { results.push({ chunk: c.url.split("/").pop(), mapUrl, leaked: false }); return; }
            const body = await resp.text();
            let parsed: any = null;
            try { parsed = JSON.parse(body); } catch (e) { results.push({ chunk: c.url.split("/").pop(), mapUrl, leaked: false }); return; }
            const isSourceMap = parsed && (Array.isArray(parsed.sources) || parsed.version === 3 || parsed.mappings);
            const sampleSource = isSourceMap && Array.isArray(parsed.sources) && parsed.sources.length ? String(parsed.sources[0]).slice(0, 120) : undefined;
            results.push({ chunk: c.url.split("/").pop(), mapUrl: mapUrl.replace(dirOf, ""), leaked: !!isSourceMap, sourcesCount: isSourceMap && Array.isArray(parsed.sources) ? parsed.sources.length : undefined, sampleSource });
          } catch (e: any) {
            // 探测本身失败（超时/网络中断/被限流）——**未知**，既非泄露也非安全
            results.push({ chunk: c.url.split("/").pop(), mapUrl, leaked: false, probeError: (e && e.message) || String(e) });
          }
        }));
      }
      const leaked = results.filter(r => r.leaked);
      const failed = results.filter(r => r.probeError);
      const checked = results.filter(r => !r.probeError);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            scanned: results.length,
            checked: checked.length,          // 真正**探到了结论**的数量（200/404/非 JSON 均算）
            failed: failed.length,            // 探测失败 = 未验证
            leakedCount: leaked.length,
            leakedMaps: leaked,
            safe: checked.length - leaked.length,
            failedChunks: failed.slice(0, 10),
            note: leaked.length > 0
              ? "发现可访问的 sourcemap：可下载还原全部前端源码（含接口/逻辑/注释），属信息泄露漏洞"
              : (failed.length > 0
                ? `未发现泄露，但 **${failed.length}/${results.length} 个 chunk 探测失败**（超时/网络中断/限流）——这些 chunk **未被验证**，不等于安全；可重试或缩小 max_chunks`
                : "全部 chunk 均探测成功，未发现 sourcemap 泄露")
          }, null, 1)
        }]
      };
    } catch (error: any) {
      return { content: [{ type: "text", text: `sourcemap 探测失败: ${error.message}` }], isError: true };
    }
  }
);
// 74.5 JWT 解析与越权攻击面分析
server.tool(
  "jwt_analyze",
  "解析 JWT（JSON Web Token）并分析越权攻击面：从 cookie/localStorage/请求头自动提取 JWT，解码 header 与 payload，高亮权限字段（role/userId/tenantId/exp 等），产出候选篡改项（水平越权、提权、alg:none、RS→HS 混淆）与重放验证建议。",
  {
    jwt: z.string().optional().describe("手动传入 JWT 字符串。不传则自动从当前页面 cookie/localStorage 中提取"),
    autoExtract: z.boolean().optional().describe("是否自动从页面提取 JWT，默认true"),
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用活动标签页）"),
    hostname: z.string().optional().describe("目标 hostname（在该域名的标签页上执行）")
  },
  async ({ jwt, autoExtract = true, tab_id: tabId, hostname }) => {
    try {
      // JWT 三段 base64url 特征
      // 批2审计 M5：第三段（签名）允许为空——alg:none token 的签名常为空字符串，
// 原三段 ≥8 字符要求提取不到 alg:none token，与工具宣称的 alg 攻击面检测直接矛盾
const JWT_PATTERN = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/;

      const found: Array<{ source: string; jwt: string }> = [];

      if (jwt) {
        found.push({ source: 'manual', jwt });
      } else if (autoExtract) {
        // 1) cookie 中提取
        try {
          // V4.9.22（修复🟡，审计指出）：**去掉 httpOnly 过滤**——该参数语义是"**仅**返回 httpOnly Cookie"
          // （mcp-client.js 的 getCookies 内 `filter(c => c.httpOnly === true)`），于是 token 存在**普通**
          // cookie 里的站点会被报"未找到 JWT"，而工具描述并未限定"仅 httpOnly"。chrome.cookies 本就能读全部。
          const cookies = await sendToBrowser("GET_COOKIES", { tabId, hostname });
          for (const c of cookies || []) {
            if (JWT_PATTERN.test(c.value || '')) {
              found.push({ source: `cookie: ${c.name}${c.httpOnly ? ' (httpOnly)' : ''}`, jwt: c.value });
            }
          }
        } catch (e) { /* 忽略 */ }

        // 2) localStorage 提取
        try {
          const storage = await sendToBrowser("GET_LOCAL_STORAGE", { tabId, hostname });
          const entries = Array.isArray(storage) ? storage : Object.entries(storage || {});
          for (const [k, v] of entries as any) {
            const val = typeof v === 'string' ? v : (v && v.value ? String(v.value) : '');
            if (JWT_PATTERN.test(val || '')) {
              found.push({ source: `localStorage: ${k}`, jwt: val });
            }
          }
        } catch (e) { /* 忽略 */ }

        // 3) 网络请求头中提取（最近捕获的请求）
        // V4.9.22（修复）：原实现**从未生效**，两处叠加——
        //  ① 以默认 detail=false 调 GET_NETWORK_REQUESTS，而精简投影**不含任何头字段** → headers 恒为 {};
        //  ② 即便拿到头，webRequest 侧是 [{name,value}] **数组**形态，Object.entries 会把每项打成
        //     "[object Object]"（JWT 正则永远匹配不上）。
        // 现改为 detail=true + 三形态归一（数组/对象/文本串——与 mcp-client.js 的 normHeaders 同口径）。
        try {
          const netData = await sendToBrowser("GET_NETWORK_REQUESTS", { limit: 50, detail: true, tabId, hostname });
          const reqs = netData?.requests || netData || [];
          for (const req of reqs) {
            const raw = req?.requestHeaders || req?.headers;
            const pairs: Array<[string, string]> = [];
            if (Array.isArray(raw)) {
              for (const h of raw) {
                if (h && h.name != null) pairs.push([String(h.name), h.value == null ? '' : String(h.value)]);
              }
            } else if (raw && typeof raw === 'object') {
              for (const [k, v] of Object.entries(raw)) pairs.push([k, v == null ? '' : String(v)]);
            } else if (typeof raw === 'string') {
              for (const line of String(raw).split('\n')) {
                const t = line.trim(); const i = t.indexOf(':');
                if (i > 0) pairs.push([t.slice(0, i).trim(), t.slice(i + 1).trim()]);
              }
            }
            for (const [hn, hv] of pairs) {
              if (JWT_PATTERN.test(hv || '')) {
                found.push({ source: `header: ${hn} (${req.url || req.method || '?'})`, jwt: hv });
              }
            }
          }
        } catch (e) { /* 忽略 */ }
      }

      if (found.length === 0) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              message: "未找到 JWT。可手动传入 jwt 参数，或确认页面已登录（token 在 httpOnly cookie 中时自动提取已覆盖）。",
              found: []
            }, null, 2)
          }]
        };
      }

      // 解码与去重
      const base64UrlDecode = (seg: string): any => {
        try {
          const pad = seg.replace(/-/g, '+').replace(/_/g, '/');
          const decoded = Buffer.from(pad, 'base64').toString('utf8');
          return JSON.parse(decoded);
        } catch (e) {
          return { raw: seg, decodeError: String(e) };
        }
      };

      const seen = new Set<string>();
      const analyses: any[] = [];

      for (const item of found) {
        if (seen.has(item.jwt)) continue;
        seen.add(item.jwt);

        const parts = item.jwt.split('.');
        if (parts.length !== 3) {
          analyses.push({ source: item.source, valid: false, reason: '非标准三段 JWT' });
          continue;
        }

        const header = base64UrlDecode(parts[0]);
        const payload = base64UrlDecode(parts[1]);
        const signature = parts[2];

        // 权限字段分析
        const permissionFields: any[] = [];
        const payloadObj = payload && typeof payload === 'object' && !payload.decodeError ? payload : {};
        const fieldRules: Array<[RegExp, string, string]> = [
          [/^(role|roles|roleId|role_id|userRole|authority|authorities|permission|permissions|scope)$/i, '角色/权限', '提权尝试：改为 admin/administrator/superadmin/root 或高权限角色名，重新签名或直接替换后重放'],
          [/^(userId|uid|user_id|id|sub)$/i, '用户标识', '水平越权：改为其他用户 ID，观察是否返回他人数据（配合响应差异确认 IDOR）'],
          [/^(tenantId|tenant_id|orgId|org_id|companyId|deptId|group_id)$/i, '租户/组织', '跨租户越权：改为其他租户 ID，尝试访问横向数据'],
          [/^(exp|nbf)$/i, '有效期', '过期检查：exp 已过期则需重新登录获取；注意服务端是否实际校验 exp']
        ];
        for (const [pattern, label, suggestion] of fieldRules) {
          for (const [k, v] of Object.entries(payloadObj)) {
            if (pattern.test(k)) {
              permissionFields.push({
                field: k,
                value: v,
                label,
                attackSuggestion: suggestion
              });
            }
          }
        }

        // alg 攻击面
        const algHints: string[] = [];
        const alg = (header && typeof header === 'object' && header.alg) || 'unknown';
        if (alg === 'none') {
          algHints.push('⚠️ alg=none：直接去除签名段重放（服务端若接受则签名失效）');
        } else if (alg === 'HS256' || alg === 'HS384' || alg === 'HS512') {
          algHints.push('HS 系列：尝试弱密钥爆破（jwt_tool/字典：secret、key、password、123456 等）');
        } else if (alg.startsWith('RS') || alg.startsWith('ES') || alg.startsWith('PS')) {
          algHints.push('非对称签名：检查服务端是否错误信任 HS256（RS→HS 混淆攻击：用公钥当 HMAC 密钥重新签名）');
        }
        if (!header || header.decodeError) {
          algHints.push('header 解码失败，检查 token 是否被截断');
        }

        // exp 检查
        const now = Math.floor(Date.now() / 1000);
        const expInfo = payloadObj.exp
          ? (payloadObj.exp < now ? `已过期（${new Date(payloadObj.exp * 1000).toISOString()}）` : `有效至 ${new Date(payloadObj.exp * 1000).toISOString()}`)
          : '无 exp 字段（token 永不过期，注意风险）';

        analyses.push({
          source: item.source,
          valid: true,
          alg,
          header,
          payload: payloadObj,
          signaturePreview: signature.slice(0, 20) + '...',
          expInfo,
          permissionFields,
          algHints,
          replaySuggestions: [
            "使用 quick_set_headers 或 Headers 板块注入组替换 Authorization/Bearer 头后重放",
            "改字段后用页内 fetch 重放（签名在页内可用时）——execute_script 中调用原站请求",
            "使用 analyze_authentication 对比不同身份响应的差异确认越权成立"
          ]
        });
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            totalFound: analyses.length,
            analyses,
            summary: analyses.map(a => a.valid
              ? `${a.source}: alg=${a.alg}, 权限字段=${a.permissionFields.length} 个, ${a.expInfo}`
              : `${a.source}: 无效（${a.reason}）`)
          }, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `JWT 分析失败: ${error.message}` }],
        isError: true
      };
    }
  }
);
}
