// ============== Vue 专项（路由/深链/路由数组 Hook/store/权限矩阵/框架检测） ==============
// P0-2 拆分自 index.ts——工具注册文本原样搬运，逻辑零改动。

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sendToBrowserRetry, SIDE_EFFECT_CMDS, sendToBrowser } from "../transport.js";
import {
  fetchChunkText,
} from "../helpers.js";

export function register_vue_tools(server: McpServer): void {
// 4. 获取Vue Router信息
server.tool(
  "get_vue_routes",
  "获取页面的Vue Router路由信息（需要先启用获取路由脚本）。默认活动标签页；可传 tab_id/hostname 指定目标。【证据边界】status:timeout 只说明在等待窗口内未观测到数据，不构成\"该站无 Vue 路由\"的结论——慢站可加大 timeout_ms 重试；返回的 status 字段（found/timeout）标明结论来源",
  {
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用活动标签页）"),
    hostname: z.string().optional().describe("按域名定位目标标签页（如 example.com）"),
    timeout_ms: z.number().int().min(1000).max(30000).optional().describe("等待 Vue 数据就绪的最长时间（默认 6000ms；慢站/刚登录后加大：数据未就绪时扩展侧会请求页面重扫并轮询）")
  },
  async ({ tab_id: tabId, hostname, timeout_ms: timeoutMs }) => {
    try {
      // 服务端超时需覆盖扩展侧轮询窗口 + 护栏缓冲（storage/message 各 1.5s）
      const wait = timeoutMs || 6000;
      const vueData = await sendToBrowser("GET_VUE_ROUTER_DATA", { tabId, hostname, timeoutMs }, wait + 8000);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(vueData, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `获取Vue路由失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);
// V4.9：navigate_vue_route——按路由 path/name/完整 URL 语义跳转（竞品能力吸收）。
// 设计约束：歧义（多个不同 path 命中）时返回候选列表不擅自跳转；URL 目标匹配不到已发现路由时按原 URL 跳并附 warning
// （渗透场景需要访问"未加载路由"，与竞品"只跳已发现路由"的保守策略不同）。
server.tool(
  "navigate_vue_route",
  "跳转到已发现的 Vue 路由（按路由 path、name 或完整 URL）。歧义时返回候选列表不擅自跳转。需先启用「获取路由」脚本",
  {
    target: z.string().describe("路由 path（如 /system/user）、路由 name（如 User）或完整 URL"),
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用活动标签页）"),
    hostname: z.string().optional().describe("按域名定位目标标签页（如 example.com）")
  },
  async ({ target, tab_id: tabId, hostname }) => {
    try {
      const vueData: any = await sendToBrowserRetry("GET_VUE_ROUTER_DATA", { tabId, hostname }, 30000);
      if (!vueData || vueData.notFound) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              error: "未获取到路由数据（需先启用「获取路由」脚本并刷新页面）",
              detail: vueData?.hint || vueData?.debugStep || null
            }, null, 1)
          }],
          isError: true
        };
      }

      // 汇总全部路由（顶层旧格式 + instances 多实例格式 + 动态/pinia 来源），附带实例元信息
      type RouteEntry = { path: string; name?: string; source: string; baseUrl?: string; routerBase?: string; routerMode?: string; instanceIndex?: number };
      const entries: RouteEntry[] = [];
      const pushRoutes = (arr: any[], source: string, meta: Partial<RouteEntry> = {}) => {
        if (!Array.isArray(arr)) return;
        for (const r of arr) {
          if (!r || typeof r.path !== 'string') continue;
          entries.push({ path: r.path, name: typeof r.name === 'string' ? r.name : undefined, source, ...meta });
        }
      };
      const topMeta = { baseUrl: vueData.baseUrl, routerBase: vueData.routerBase, routerMode: vueData.routerMode };
      pushRoutes(vueData.routes || [], 'static', topMeta);
      pushRoutes(vueData.dynamicRoutes || [], 'dynamic', topMeta);
      pushRoutes(vueData.piniaMenus || [], 'pinia', topMeta);
      (vueData.instances || []).forEach((inst: any, i: number) => {
        const meta = { baseUrl: inst.baseUrl, routerBase: inst.routerBase, routerMode: inst.routerMode, instanceIndex: i + 1 };
        pushRoutes(inst.routes || [], 'static', meta);
        pushRoutes(inst.dynamicRoutes || [], 'dynamic', meta);
        pushRoutes(inst.piniaMenus || [], 'pinia', meta);
      });

      const uniq = new Map<string, RouteEntry>();
      for (const e of entries) { const k = e.path + '|' + (e.name || ''); if (!uniq.has(k)) uniq.set(k, e); }
      const all = [...uniq.values()];
      const norm = (p: string) => (p.startsWith('/') ? p : '/' + p);

      // 匹配：完整 URL / path / name
      let matched: RouteEntry[] = [];
      let matchedBy = '';
      let urlTarget = '';
      if (/^https?:\/\//i.test(target)) {
        matchedBy = 'url';
        urlTarget = target;
        let targetPath = '';
        try {
          const u = new URL(target);
          targetPath = u.hash ? u.hash.replace(/^#/, '') : u.pathname;
        } catch { /* 非法 URL 走原样跳转 */ }
        const pathOnly = targetPath.split('?')[0];
        if (pathOnly) matched = all.filter(e => e.path === pathOnly || norm(e.path) === norm(pathOnly));
      } else if (target.startsWith('/')) {
        matchedBy = 'path';
        matched = all.filter(e => e.path === target || norm(e.path) === target);
      } else {
        const byName = all.filter(e => e.name && e.name === target);
        if (byName.length) { matchedBy = 'name'; matched = byName; }
        else { matchedBy = 'path'; matched = all.filter(e => e.path === norm(target)); }
      }

      // URL 目标：始终按原 URL 跳转（保留 host/query 原样，避免静默改写——审计 M1 修复），
      // 路由表命中仅作信息附加（mode/name 供 AI 判断落点）
      if (urlTarget) {
        const hitInfo = matched.length > 0
          ? { path: matched[0].path, name: matched[0].name, mode: matched[0].routerMode || 'unknown', source: matched[0].source }
          : undefined;
        const navResult = await sendToBrowser("NAVIGATE_TO", { url: urlTarget, tabId, hostname }, 20000);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              navigated: true, url: urlTarget, matchedBy,
              matched: hitInfo,
              warning: hitInfo ? undefined : "该 URL 的路径未在已发现路由中匹配（可能是未加载路由/懒加载路由），已按原 URL 跳转",
              browserResult: navResult
            }, null, 1)
          }]
        };
      }

      if (matched.length === 0) {
        const similar = all
          .filter(e => e.path.includes(target) || (e.name || '').toLowerCase().includes(target.toLowerCase()))
          .slice(0, 15)
          .map(e => ({ path: e.path, name: e.name, source: e.source }));
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              error: `未找到匹配 "${target}" 的路由`,
              matchedBy, totalRoutes: all.length, similar,
              hint: "可用 get_vue_routes 查看全部路由；name 匹配失败时请改用完整 path"
            }, null, 1)
          }],
          isError: true
        };
      }

      // 歧义：多个不同 path 命中 → 返回候选，不擅自跳转
      const uniqPaths = [...new Set(matched.map(e => e.path))];
      if (uniqPaths.length > 1) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ambiguous: true,
              message: `匹配到 ${uniqPaths.length} 个不同路由，请用完整 path 精确指定`,
              candidates: matched.slice(0, 20).map(e => ({ path: e.path, name: e.name, source: e.source }))
            }, null, 1)
          }]
        };
      }

      // 唯一命中 → 构造完整 URL（hash/history 兼容，含 routerBase 与部署子路径）
      const hit = matched[0];
      let origin = hit.baseUrl || '';
      let deployPath = '';
      try {
        const info: any = await sendToBrowser("GET_PAGE_INFO", { tabId, hostname }, 10000);
        const pageUrl = new URL(info.url);
        if (!origin) origin = pageUrl.origin;
        if (hit.routerMode === 'hash') {
          // hash 模式下路由在 # 之后，pathname 即部署路径。目录型（/app/）取目录部分；
          // 页面文件型（/index.html）保留完整文件名——少数站无默认文档，截断成 / 会 404
          // （实测 course.example.edu.cn 部署在 /index.html 下）
          deployPath = /\.html?$/i.test(pageUrl.pathname)
            ? pageUrl.pathname
            : pageUrl.pathname.replace(/[^/]*$/, '');
        }
      } catch { /* 拿不到页面信息时用 baseUrl 兜底 */ }
      if (!origin) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "无法确定站点 origin（请传 tab_id/hostname 指定目标标签页）" }, null, 1) }],
          isError: true
        };
      }

      const path = norm(hit.path);
      let fullUrl: string;
      if (hit.routerMode === 'hash') {
        fullUrl = `${origin}${deployPath}#${path}`;
      } else {
        const routerBase = (hit.routerBase || '').replace(/\/$/, '');
        fullUrl = `${origin}${routerBase}${path}`;
      }

      const navResult = await sendToBrowser("NAVIGATE_TO", { url: fullUrl, tabId, hostname }, 20000);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            navigated: true, url: fullUrl, matchedBy,
            matched: { path: hit.path, name: hit.name, mode: hit.routerMode || 'unknown', source: hit.source, instanceIndex: hit.instanceIndex },
            browserResult: navResult
          }, null, 1)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `navigate_vue_route 失败: ${error.message}` }],
        isError: true
      };
    }
  }
);
// 92. 深链绕过探针（V4.5：清路由独享守卫 + Hook 导航记录弹回源，AI 据此判断绕过路线）
server.tool(
  "deep_link_probe",
  "深链绕过探针：未登录场景下清掉路由独享守卫（beforeEnter/redirect）并 Hook push/replace，深链跳转目标路径后报告落点与弹回调用源（区分守卫型/afterEach 型/watcher 型弹回）。需先启用 Clear_vue_Navigation_Guards 清全局守卫",
  {
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用活动标签页）"),
    hostname: z.string().optional().describe("目标 hostname（在该域名的标签页上执行）"),
    target_path: z.string().describe("目标路由路径，如 /system/user"),
    wait: z.number().int().min(500).max(10000).optional().describe("跳转后观察时长 ms（默认 2500）"),
    patch_bounce: z.boolean().optional().describe("拦截 push('/login') 型弹回（axios 401 interceptor/watcher 型站点的克星，默认 false；开启后页面停留在目标路径，组件请求可被 get_network_requests 捕获）")
  },
  async ({ target_path, wait = 2500, patch_bounce = false, tab_id: tabId, hostname }) => {
    try {
      // V4.9.11（复验补漏）：retries=0——DEEP_LINK_PROBE 已被列入 SIDE_EFFECT_CMDS，
      // 且 SW 侧会**删除所有路由的 beforeEnter/redirect 守卫**（真实状态副作用），
      // 超时后自动重发与"超时≠未执行"语义冲突（与 S2 同类）
      const result = await sendToBrowserRetry("DEEP_LINK_PROBE", { targetPath: target_path, wait, patchBounce: patch_bounce, tabId, hostname }, wait + 20000, 0);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 1) }] };
    } catch (error: any) {
      return { content: [{ type: "text", text: `深链探针失败: ${error.message}` }], isError: true };
    }
  }
);
// 98. 路由数组 Hook 替换（V4.8 动态路由攻击面自动化，源自实战打法：chunk 里未加载路由数组
// 静态存在——手工打法是 DevTools Local Overrides 替换返回点后刷新。工具只负责执行替换，
// 找返回点/定变量名的分析判断交给 AI）
server.tool(
  "hook_route_array",
  "路由数组 Hook 替换（动态路由攻击面自动化）：通过 CDP 拦截指定 chunk 的网络响应，把 from_str 替换为 to_str 后放行，页面重新加载时被替换的代码即生效。典型打法：先用 get_chunk_source 找到「已加载路由数组的返回点」（如 return Ue）和「未加载路由数组变量名」（如 Ee，同样是 path+component 定义但不在当前路由表里），然后 from_str='return Ue' → to_str='return Ue.concat(Ee)'，刷新后未加载路由全部注册，再深链测未授权。也可用于其他 chunk 代码篡改场景（改权限判断/改条件分支）",
  {
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用活动标签页）"),
    hostname: z.string().optional().describe("目标 hostname（在该域名的标签页上执行）"),
    url_keyword: z.string().describe("chunk URL 关键词，如 'index-rWWQ'，取自 get_js_chunks 返回"),
    from_str: z.string().describe("被替换的源码片段——必须与 get_chunk_source 读到的原文逐字符一致（压缩变量名区分大小写），如 'return Ue'"),
    to_str: z.string().describe("替换后的内容，如 'return Ue.concat(Ee)'（Ee 为未加载路由数组变量名）；空串表示删除"),
    once: z.boolean().optional().describe("仅替换首个命中响应（默认 true）"),
    reload: z.boolean().optional().describe("拦截就绪后自动刷新页面（默认 true——不刷新 chunk 不会重新请求）")
  },
  async ({ url_keyword, from_str, to_str, once = true, reload = true, tab_id: tabId, hostname }) => {
    try {
      // hook 是有状态操作（Fetch 拦截已挂上）——禁用重试防二次 enable 冲突；超时由 client 侧 20s 守护 + 此处 25s 兜底
      const result = await sendToBrowserRetry("HOOK_ROUTE_ARRAY", { urlKeyword: url_keyword, fromStr: from_str, toStr: to_str, once, reload, tabId, hostname }, 25000, 0);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ...result,
            aiHint: "替换成功后三步：① get_vue_routes / get_page_info 确认新路由已注册 ② 对新路由逐个 deep_link_probe（patch_bounce=true）③ 用 check_unauthorized / unauthorized_sweep 做未授权判定。若 replacements=0 或超时，多为 from_str 与源码不一致或 chunk 被强缓存——重新用 get_chunk_source 核对原文"
          }, null, 1)
        }]
      };
    } catch (error: any) {
      return { content: [{ type: "text", text: `路由数组 Hook 失败: ${error.message}` }], isError: true };
    }
  }
);
// 89. Vue store 全量 dump（V4.3：Pinia/Vuex 状态 = 权限矩阵的身份基准 + 敏感信息泄露源）
server.tool(
  "vue_store_dump",
  "提取 Vue 应用的 Pinia/Vuex 全量 store 状态（token/用户信息/权限码/角色/菜单，自动标记敏感键）。需先启用 Get_Store_Dump 脚本并刷新页面（登录后数据更完整）",
  {
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用活动标签页）"),
    hostname: z.string().optional().describe("目标 hostname（在该域名的标签页上执行）"),
  },
  async ({ tab_id: tabId, hostname }) => {
    try {
      const result = await sendToBrowser("GET_STORE_DUMP", { tabId, hostname }, 10000);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 1) }] };
    } catch (error: any) {
      return { content: [{ type: "text", text: `store dump 失败: ${error.message}` }], isError: true };
    }
  }
);
// 91. Vue 前端权限矩阵（V4.3：meta.roles/permissions + store 当前身份 + chunk 按钮权限码 → 越权测试靶单）
server.tool(
  "vue_permission_matrix",
  "生成 Vue 后台越权测试矩阵：路由 meta.roles/permissions 保护清单 + store dump 的当前身份权限 + chunk 源码按钮权限码（v-hasPermi/hasPermi/checkPermi）。输出'当前身份不应可见/可访问'的精确靶单，喂给 batch_unauthorized_api",
  {
    includeChunkPermScan: z.boolean().optional().describe("是否扫描 chunk 源码提取按钮级权限码（默认 true，较耗时）"),
    maxChunks: z.number().int().min(1).max(100).optional().describe("chunk 扫描上限（默认 30）"),
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用活动标签页）"),
    hostname: z.string().optional().describe("目标 hostname（在该域名的标签页上执行）")
  },
  async ({ includeChunkPermScan = true, maxChunks = 30, tab_id: tabId, hostname }) => {
    try {
      // 1. 路由数据（含 V4.3 保留的 meta）
      const vueData = await sendToBrowser("GET_VUE_ROUTER_DATA", { tabId, hostname }, 30000);

      // 2. 提取受保护路由（meta 带 roles/permissions/permission 的）
      // 批2审计 M4：携带父路径前缀——children 的相对 path（如 'user'）需拼成 '/system/user'，
      // 否则矩阵输出的相对路径深链/喂 batch 全部落空；去重键也要用拼好的完整路径
      const collectRoutes = (arr: any[], source: string, out: any[], parentPath = '') => {
        if (!Array.isArray(arr)) return;
        for (const r of arr) {
          if (r && typeof r === 'object') {
            const meta = r.meta || {};
            const required: string[] = [];
            for (const key of ['roles', 'permissions', 'permission']) {
              const v = meta[key] ?? r[key];
              if (Array.isArray(v)) required.push(...v.filter((x: any) => typeof x === 'string'));
              else if (typeof v === 'string') required.push(v);
            }
            const rawPath = r.path || r.url || '';
            const path = rawPath && !rawPath.startsWith('/') && parentPath
              ? (parentPath.replace(/\/$/, '') + '/' + rawPath)
              : rawPath;
            if (path && (required.length > 0 || meta.title)) {
              out.push({ path, name: r.name || r.title || '', requiredPerms: [...new Set(required)], source });
            }
            if (r.children) collectRoutes(r.children, source, out, path || parentPath);
          }
        }
      };
      const protectedRoutes: any[] = [];
      collectRoutes(vueData.routes || [], 'static', protectedRoutes);
      collectRoutes(vueData.dynamicRoutes || [], 'dynamic', protectedRoutes);
      collectRoutes(vueData.piniaMenus || [], 'pinia', protectedRoutes);
      for (const inst of vueData.instances || []) {
        collectRoutes(inst?.routes || [], 'static', protectedRoutes);
        collectRoutes(inst?.dynamicRoutes || [], 'dynamic', protectedRoutes);
        collectRoutes(inst?.piniaMenus || [], 'pinia', protectedRoutes);
      }

      // 3. 当前身份：store dump 中的权限码/角色
      let identity: any = { storeDump: false };
      try {
        const dump = await sendToBrowser("GET_STORE_DUMP", { tabId, hostname }, 10000);
        if (!dump.notFound) {
          identity = { storeDump: true, framework: dump.framework, sensitiveKeys: [], permissionHints: [] };
          const stores = [...(dump.pinia?.stores || []), ...(dump.vuex?.stores || [])];
          for (const s of stores) {
            identity.sensitiveKeys.push(...(s.sensitiveKeys || []).map((k: string) => `${s.storeName}.${k}`));
            // 从状态里抽权限/角色值（permission/role 键下的字符串/数组）
            const scanPerms = (o: any, path: string, depth: number) => {
              if (!o || typeof o !== 'object' || depth > 4) return;
              for (const k of Object.keys(o)) {
                if (/permission|perm|role/i.test(k)) {
                  const v = o[k];
                  if (typeof v === 'string') identity.permissionHints.push(v);
                  else if (Array.isArray(v)) identity.permissionHints.push(...v.filter((x: any) => typeof x === 'string'));
                }
                if (o[k] && typeof o[k] === 'object' && !Array.isArray(o[k])) scanPerms(o[k], `${path}${k}.`, depth + 1);
              }
            };
            scanPerms(s.state, '', 0);
          }
          identity.permissionHints = [...new Set(identity.permissionHints)].slice(0, 100);
        }
      } catch (e: any) { identity.error = e.message; }

      // 4. chunk 源码按钮权限码扫描（v-hasPermi / hasPermi( / checkPermi( 等 Vue 后台惯用法）
      let chunkPermCodes: string[] = [];
          let chunkScanError: string | null = null;
      let totalChunks = 0;
      if (includeChunkPermScan) {
        try {
          const chunks = await sendToBrowserRetry("GET_JS_CHUNKS", { tabId, hostname }, 15000);
          totalChunks = (chunks?.chunks || []).length;
          const chunkList = (chunks?.chunks || []).slice(0, maxChunks);
          // 覆盖若依系两大主流用法：
          // 指令式 v-hasPermi="['x']"（= + 外层引号 + 数组）与 v-hasPermi=['x']（无外层引号）
          // 调用式 hasPermi(['x']) / hasPermi('x') / checkPermi(['x'])
          // 外层引号 (?:["'`]\s*)? 可选消耗，避免数组元素内层引号结构对不上
          const PERM_CODE_RE = /(?:v-hasPermi|checkPermi|hasPermi|v-permission|checkPermission)\s*[=(]\s*(?:["'`]\s*)?(?:\[\s*)?["'`]([^"'`]{2,60})["'`]/g;
          // 批2审计 M3：分批并发（每批 5 个）——原实现 maxChunks=100 时对目标站瞬时 100 并发
          // （实测 5 并发 33 分钟即触发封 IP），且 100×8MB 文本驻留内存尖峰
          const chunkResults: any[] = [];
          for (let bi = 0; bi < chunkList.length; bi += 5) {
            const batch = chunkList.slice(bi, bi + 5);
            const rs = await Promise.all(batch.map((c: any) => fetchChunkText(c.url)));
            chunkResults.push(...rs);
          }
          for (const cr of chunkResults) {
            if (!cr.code) continue;
            PERM_CODE_RE.lastIndex = 0; // 每个 chunk 重置（前一个 chunk break 退出时会残留位置）
            let m: RegExpExecArray | null;
            while ((m = PERM_CODE_RE.exec(cr.code)) !== null) {
              chunkPermCodes.push(m[1]);
              if (chunkPermCodes.length > 200) break;
            }
          }
          chunkPermCodes = [...new Set(chunkPermCodes)];
        } catch (e: any) {
          chunkScanError = e.message;  // 批2审计 L3：错误单独承载，不混进数据数组被当权限码消费
        }
      }

      // 5. 矩阵：受保护路由 vs 当前身份 → 越权测试建议（同 path 去重：三源合并只保留首个）
      const hints = identity.permissionHints || [];
      const seenPaths = new Set<string>();
      const SUPER_PERM_RE = /^\*(?::\*|\*|\*:[\w:]+)*$/; // 若依类超管通配（*:*:*、*:*:*:read、*:*:*:write 等）
      const hasSuperPerm = hints.some((h: string) => SUPER_PERM_RE.test(h));
      const matrix = protectedRoutes
        .filter(r => {
          const dedupeKey = `${r.path}|${r.name}|${r.source || ''}`;
          if (seenPaths.has(dedupeKey)) return false;
          seenPaths.add(dedupeKey);
          return true;
        })
        .map(r => ({
          ...r,
          identityHasPerm: r.requiredPerms.length === 0 || hasSuperPerm
            ? (r.requiredPerms.length === 0 ? null : true) // 超管通配短路：不生成该路由的越权靶单
            : r.requiredPerms.some((p: string) => hints.some((h: string) => h === p || h.split(':').join('.') === p.split(':').join('.'))),
          testSuggestion: r.requiredPerms.length > 0
            ? (hints.length === 0 ? '匿名/低权直接访问该路由对应 API' : '用低于要求权限的身份访问并对比')
            : null
        }));

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            protectedRouteCount: protectedRoutes.length,
            identity,
            chunkPermCodeCount: chunkPermCodes.length,
            chunkScanError,  // 批2审计 L3：chunk 扫描失败单独承载（原混在数据数组里）
            chunkScanCoverage: totalChunks > maxChunks
              ? `已扫描 ${maxChunks}/${totalChunks} 个 chunk（未覆盖，可用 maxChunks 参数提高上限）`
              : `已扫描全部 ${totalChunks} 个 chunk`,
            chunkPermCodes: chunkPermCodes.slice(0, 60),
            matrix,
            workflow: '将 matrix 中受保护路由对应的 API（可用 route_api_graph 关联）喂给 batch_unauthorized_api 实测'
          }, null, 1)
        }]
      };
    } catch (error: any) {
      return { content: [{ type: "text", text: `权限矩阵生成失败: ${error.message}` }], isError: true };
    }
  }
);
// 74. 检测站点类型（Vue/React/其他）
server.tool(
  "detect_site_framework",
  "检测当前站点使用的前端框架（Vue、React等），用于判断可以使用哪些功能",
  {
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用活动标签页）"),
    hostname: z.string().optional().describe("目标 hostname（在该域名的标签页上执行）")
  },
  async ({ tab_id: tabId, hostname }) => {
    try {
      const results: any = {
        frameworks: {
          vue: false,
          react: false,
          nuxt: false,
          angular: false,
          jquery: false
        },
        vueVersion: null,
        reactVersion: null,
        nuxtVersion: null,
        angularVersion: null,   // V4.9.12：原实现只有占位 false，无任何检测分支（实测 Angular 21 站漏报）
        hasRouter: false,
        availableFeatures: []
      };

      // 检测Vue
      try {
        const vueData = await sendToBrowser("EXTRACT_VUE_DATA", { tabId, hostname });
        if (vueData && !vueData.error && (vueData.version || vueData.hasVue)) {
          results.frameworks.vue = true;
          results.vueVersion = vueData.version;
          // V4.9.5：hasRouter 直接取探测结果（BFS 多实例优先带 router——修复 news.example.edu 类误报），附路由数/挂载点
          if (vueData.hasRouter || vueData.routes || vueData.router) {
            results.hasRouter = true;
            if (vueData.routeCount) {
              results.routeCount = vueData.routeCount;
              // V4.9.31：**标注来源**——这个数字来自 EXTRACT_VUE_DATA（**直读页面 Vue 实例**），
              // 与 get_vue_routes 走的**页面脚本通路**（脚本上报→content.js→storage）相互独立。
              // 实测（portal.example.com，Vue 2.7.16）：本工具报 routeCount:23、get_vue_routes 却 timeout
              // ——**两条通路一个通一个不通**。不标注的话，AI 会以为"这里说有路由 → get_vue_routes
              // 应该也能用"，进而把后者的 timeout 误读成"该站没有 Vue 路由"而放弃整条链路。
              (results as any).routeCountSource = 'page-instance-direct';
              (results as any).routeCountNote = '该数字由**直读页面 Vue 实例**得到，与 get_vue_routes 的页面脚本通路相互独立。'
                + '若 get_vue_routes 报 timeout 而此处有 routeCount，说明**路由确实存在、只是那条通路取不到**'
                + '（最常见于扩展刚重载——需刷新页面让 content script 恢复），**不要**据此认为该站没有 Vue 路由';
            }
          }
          if (vueData.mountEl) results.mountEl = vueData.mountEl;
        }
      } catch (e) {
        // V4.9.32：**区分"不是 Vue"与"没测成"**——原实现空吞，AI 从 frameworks.vue:false
        // 无法判断是"该站不用 Vue"还是"探测本身失败了"（后者在扩展刚重载、通道断时很常见）。
        // 与 V4.9.28/4.9.31 修的是同一类"没测成伪装成没有"。
        (results as any).detectErrors = (results as any).detectErrors || {};
        (results as any).detectErrors.vue = String((e as any)?.message || e);
      }

      // 检测React
      try {
        const reactData = await sendToBrowser("EXTRACT_REACT_DATA", { tabId, hostname });
        if (reactData && !reactData.error && (reactData.version || reactData.hasReact)) {
          results.frameworks.react = true;
          results.reactVersion = reactData.version;
        }
      } catch (e) {
        // V4.9.32：同 Vue 检测——留痕以区分"不是 React"与"没测成"
        (results as any).detectErrors = (results as any).detectErrors || {};
        (results as any).detectErrors.react = String((e as any)?.message || e);
      }

      // 检测Nuxt（无 vue-router 实例，需专门识别）
      // V4.9.11（验收核对）：此处 EXECUTE_SCRIPT 是**纯只读**探测（只读 window.__NUXT__ 等特征，
      // 无任何写操作），故刻意保留默认重试以提高鲁棒性——与 execute_script 工具的 retries=0 不同。
      // 后续若改动此段代码引入副作用，必须同步改为 retries=0。
      try {
        const nuxtCheck = await sendToBrowserRetry("EXECUTE_SCRIPT", {
          code: `(() => {
            try {
              const hasNuxt2 = !!window.__NUXT__;
              const hasNuxt3 = !!window.__NUXT_DATA__ || !!document.querySelector('#__NUXT_DATA__');
              const useNuxtApp = typeof window.useNuxtApp === 'function';
              const nuxtAssets = document.querySelectorAll('script[src*="/_nuxt/"], link[href*="/_nuxt/"]').length > 0;
              return { hasNuxt2, hasNuxt3, useNuxtApp, nuxtAssets };
            } catch (e) { return { error: String(e) }; }
          })()`,
          tabId, hostname
        });
        if (nuxtCheck && !nuxtCheck.error) {
          if (nuxtCheck.useNuxtApp || nuxtCheck.hasNuxt3) {
            results.frameworks.nuxt = true;
            results.nuxtVersion = "Nuxt 3+";
          } else if (nuxtCheck.hasNuxt2) {
            results.frameworks.nuxt = true;
            results.nuxtVersion = "Nuxt 2";
          }
        }
      } catch (e) {
        // V4.9.32：同 Vue/React——留痕以区分"不是 Nuxt"与"没测成"
        (results as any).detectErrors = (results as any).detectErrors || {};
        (results as any).detectErrors.nuxt = String((e as any)?.message || e);
      }

      // 检测Angular（V4.9.12：原实现 frameworks.angular 是**恒为 false 的占位符**，
      // 全文件搜不到任何检测分支——实测 Angular 21 站（ng-alain.com）被报成"非Vue/React/Nuxt站点"）。
      // 判据用 **ng-version 属性**：生产构建下 window.ng 不暴露（实测该站为 undefined），
      // 但该属性由框架编译产物自身注入，任意 Angular 版本、任意渲染阶段都在，比全局变量可靠。
      // 与上方 Nuxt 探测同样为**纯只读**（只读 DOM 属性），故同样用带重试的调用。
      try {
        const ngCheck = await sendToBrowserRetry("EXECUTE_SCRIPT", {
          code: `(() => {
            try {
              const withVer = document.querySelector('[ng-version]');
              if (withVer) {
                return {
                  version: withVer.getAttribute('ng-version'),
                  mountEl: withVer.tagName.toLowerCase(),
                  appRoot: !!document.querySelector('app-root'),
                  hasNgGlobal: typeof window.ng !== 'undefined'
                };
              }
              // 兜底：早期 AngularJS(1.x) 与尚未完成引导的站点
              const ngApp = document.querySelector('[ng-app], ng-app');
              if (ngApp) return { version: null, mountEl: ngApp.tagName.toLowerCase(), legacy: true };
              return null;
            } catch (e) { return { error: String(e) }; }
          })()`,
          tabId, hostname
        });
        if (ngCheck && !ngCheck.error && (ngCheck.version || ngCheck.legacy)) {
          results.frameworks.angular = true;
          results.angularVersion = ngCheck.version;
          if (ngCheck.mountEl) results.angularMountEl = ngCheck.mountEl;
        }
      } catch (e) {
        // V4.9.32：同前三处——留痕以区分"不是 Angular"与"没测成"
        (results as any).detectErrors = (results as any).detectErrors || {};
        (results as any).detectErrors.angular = String((e as any)?.message || e);
      }

      // 根据检测结果设置可用功能
      // V4.9.12：改为**互斥 if/else 链**——原实现 Nuxt 分支独立于后续 if/else 链之外，
      // 若该站同时被识别为 Vue（Nuxt 站点通常确实有 vue 特征），Nuxt 的功能清单会被后面的分支
      // 覆盖掉，等于 Nuxt 专属功能提示从未生效（与 R3 同类的"清单被错误分支吃掉"问题）。
      if (results.frameworks.nuxt) {
        results.availableFeatures = [
          "✅ Nuxt 数据提取（启用 Get_Nuxt 脚本）",
          "✅ Nuxt payload 探测 (nuxt_payload_probe) — CVE-2026-71316 检测",
          "✅ 加密解密分析 (analyze_page_encryption)",
          "✅ API请求分析 (get_network_requests)",
          "✅ 敏感数据检测 (scan_sensitive_data)"
        ];
      }
      else if (results.frameworks.vue && results.hasRouter) {
        results.availableFeatures = [
          "✅ Vue路由未授权测试 (unauthorized_sweep)",
          "✅ Vue路由分析 (quick_vue_analysis)",
          "✅ 路由守卫清除",
          "✅ 大屏页面扫描",
          "✅ 加密解密分析",
          "✅ API请求分析",
          "✅ 敏感数据检测"
        ];
      } else if (results.frameworks.vue) {
        results.availableFeatures = [
          "⚠️ Vue站点但无Router，功能受限",
          "✅ 加密解密分析",
          "✅ API请求分析",
          "✅ 敏感数据检测"
        ];
      } else if (results.frameworks.react) {
        // V4.9.11（验收修复 R3）：React 站点补专属功能提示——原实现落到最后的 else，
        // 一律显示"❌ 非Vue站点，Vue相关功能不可用"，让 AI 以为 React 站没有可用能力。
        // （React 18 识别修好后，这里同步给出对应清单）
        results.availableFeatures = [
          "✅ React组件数据提取 (extract_react_data)",
          "✅ 加密解密分析 (analyze_page_encryption)",
          "✅ API请求分析 (get_network_requests)",
          "✅ 反调试绕过 (auto_bypass_anti_debug)",
          "✅ 敏感数据检测 (scan_sensitive_data)"
        ];
      } else if (results.frameworks.angular) {
        // V4.9.12：Angular 分支——原实现落到最后的 else，显示"❌ 非Vue站点，Vue相关功能不可用"，
        // 与 R3 修 React 时是同一个坑：让 AI 以为此站无可用能力。Angular 暂无专属数据提取器
        //（组件实例挂在编译后的 Ivy 视图上，无 Vue/React 那样的全局 fiber 入口），
        // 但**通用能力照常可用**，必须如实列出，否则工具被误判为不适用。
        results.availableFeatures = [
          `ℹ️ Angular ${results.angularVersion || ''} 站点：无专属数据提取器（Vue/React 功能不适用）`,
          "✅ 通用能力照常可用，建议走：",
          "✅ API请求分析 (get_network_requests) / 路由图谱 (route_api_graph)",
          "✅ 加密解密分析 (analyze_page_encryption)",
          "✅ 反调试绕过 (auto_bypass_anti_debug)",
          "✅ 敏感数据检测 (scan_sensitive_data)"
        ];
      } else {
        results.availableFeatures = [
          "❌ 非Vue站点，Vue相关功能不可用",
          "✅ 加密解密分析 (analyze_page_encryption)",
          "✅ API请求分析 (get_network_requests)",
          "✅ 反调试绕过 (auto_bypass_anti_debug)",
          "✅ 敏感数据检测 (scan_sensitive_data)"
        ];
      }
      
      // V4.9.12（实测 vben.pro 驱动）：与 R3（React 的 "React React 站点"）**完全同类**的重复前缀——
      // SW 侧 vueVersion 字面量是 "Vue 3"/"Vue 2"（**自带 Vue 前缀**），原实现无条件再拼一个 "Vue "，
      // 输出 "Vue Vue 3 站点（有Router）"。R3 当时只修了 React 分支，Vue 分支漏了。
      const vueLabel = (results.vueVersion && /^vue/i.test(String(results.vueVersion)))
        ? String(results.vueVersion)
        : `Vue${results.vueVersion ? ' ' + results.vueVersion : ''}`;

      results.summary = results.frameworks.nuxt
        ? `${results.nuxtVersion || 'Nuxt'} 站点（无 vue-router 实例，使用 Nuxt 专属功能）`
        : results.frameworks.vue
          ? `${vueLabel} 站点${results.hasRouter ? '（有Router）' : '（无Router）'}`
          : results.frameworks.react
            // V4.9.11（验收修复 R3）：SW 侧返回的 reactVersion 字面量就是 'React'（它是"识别到
            // React"的标记，不含真实版本号），直接拼接会输出"React React 站点"。这里仅在拿到
            // 与 'React' 不同的真实版本号时才追加
            ? `React 站点${results.reactVersion && results.reactVersion !== 'React' ? ` ${results.reactVersion}` : ''}`
            // V4.9.12：Angular 分支（版本号可能为 null——AngularJS 1.x 的 ng-app 兜底无版本属性）
            : results.frameworks.angular
              ? `Angular${results.angularVersion ? ` ${results.angularVersion}` : ''} 站点（无专属提取器，走通用能力）`
              : "非Vue/React/Nuxt/Angular站点";
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify(results, null, 2)
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
// 38. 提取Vue数据
server.tool(
  "extract_vue_data",
  "提取页面Vue组件的data、computed、methods等数据。默认活动标签页；可传 tab_id/hostname 指定目标",
  {
    selector: z.string().optional().describe("目标元素选择器，默认为#app（不存在时自动全文档探测）"),
    // V4.9.12：补目标指定——与其余页面类工具对齐（SW 侧 resolveTab 早已支持，只是这里没暴露）
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用活动标签页）"),
    hostname: z.string().optional().describe("按域名定位目标标签页（如 example.com）")
  },
  async ({ selector, tab_id: tabId, hostname }) => {
    try {
      const result = await sendToBrowser("EXTRACT_VUE_DATA", { selector, tabId, hostname });
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
// 39. 提取React数据
server.tool(
  "extract_react_data",
  "提取页面React组件的props、state等数据。默认活动标签页；可传 tab_id/hostname 指定目标",
  {
    selector: z.string().optional().describe("目标元素选择器，默认为#root"),
    // V4.9.12：与 extract_vue_data 同批补目标指定
    tab_id: z.number().int().optional().describe("目标标签页 ID（省略则用活动标签页）"),
    hostname: z.string().optional().describe("按域名定位目标标签页（如 example.com）")
  },
  async ({ selector, tab_id: tabId, hostname }) => {
    try {
      const result = await sendToBrowser("EXTRACT_REACT_DATA", { selector, tabId, hostname });
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

// ============== 智能化功能：认证分析 ==============
}
