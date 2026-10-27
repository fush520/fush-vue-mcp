// ============== 命令实现 ==============

// 确保目标 tab 处于活动状态：Edge 睡眠标签页会冻结渲染进程（tabs API 无任何可检测标记，
// status 仍是 complete——实测 executeScript 对冻结 tab 挂死 30s+，EXECUTE_SCRIPT/GET_JS_CHUNKS 全中招）。
// 激活该 tab（切前台）即解冻进程，页面状态保留；保守等待 1.2s 给解冻留时间
// ============== V4.9.9.3：焦点恢复（租约制，审计 Medium 竞态修复） ==============
// 状态：单一对象（同一时刻只维护一组恢复目标——修复"多标签连续操作恢复到错误标签"的竞态）。
// - prevActiveId 保持**最早值**（用户真正的原标签；后续激活 T2/T3 不再覆盖恢复目标）
// - lastOpAt 租约：AI 连续操作时不断刷新，操作不停就不恢复（修复"操作中途被切走"）
// - 用户主动切走（onActivated 观察到非 AI 激活的标签）→ 立即放弃恢复（不再抢用户焦点）
let focusRestore = null;
// V4.9.10.2（审计 Low-2）：AI 自激活标记——区分"AI 激活标签（自触发 onActivated）"与"用户切标签"，
// 防止 AI 连续激活冻结标签时，自己的 onActivated 被当"用户切走"而误杀焦点恢复（prevActiveId 退化）
const selfActivateMark = new Map(); // tabId -> at（2 秒窗口）

function scheduleFocusRestore(activatedTabId, prevActiveId) {
    if (!focusRestore) {
        focusRestore = { activatedTabId, prevActiveId, lastOpAt: Date.now(), timer: null };
    } else {
        focusRestore.activatedTabId = activatedTabId; // 最新激活的标签（切回判据用）
        focusRestore.lastOpAt = Date.now();           // 刷新租约
        // prevActiveId 保持最早值（不覆盖）
    }
    if (focusRestore.timer) clearTimeout(focusRestore.timer);
    focusRestore.timer = setTimeout(tryFocusRestore, 8000);
}

async function tryFocusRestore() {
    const fr = focusRestore;
    if (!fr) return;
    // 租约检查：距最后一次操作不足 8 秒 → AI 仍在操作，继续等待
    const remain = 8000 - (Date.now() - fr.lastOpAt);
    if (remain > 0) {
        fr.timer = setTimeout(tryFocusRestore, remain + 100);
        return;
    }
    focusRestore = null;
    try {
        const [cur] = await chrome.tabs.query({ active: true, currentWindow: true });
        // 仅当焦点仍停在 AI 激活的标签（用户没切走）才恢复
        if (cur && cur.id === fr.activatedTabId) {
            await chrome.tabs.update(fr.prevActiveId, { active: true });
        }
    } catch (e) { /* 标签/窗口可能已关闭——忽略 */ }
}

async function ensureTabAwake(tab) {
    if (!tab) return tab;
    // V4.9.8：已是活动标签 → 无需激活、无需等待。原实现无条件 update({active:true}) + 固定等 2.5s：
    // 对已活动标签纯属空转（每次页面工具白等 2.5 秒）；且"回退场景激活他人"是
    // "切标签被弹回"事故的根源（详见 getActiveTab 的 noActivate）。
    if (tab.active) {
        // V4.9.9.3：连续操作同一标签时刷新焦点恢复租约（避免操作中途被切走）
        if (focusRestore && focusRestore.activatedTabId === tab.id) focusRestore.lastOpAt = Date.now();
        return tab;
    }

    // V4.9.9：后台优先——AI 操作非活动标签时**不激活**（用户正在浏览的标签焦点不受打扰）。
    // CDP 可操作非活动标签，唯一例外是"冻结标签"（Edge 睡眠）会挂死——先做幂等活性探测：
    //   活着 → 直接返回（全程后台，用户无感）
    //   冻结 → 激活解冻（罕见）→ 交焦点恢复调度（租约制，见 scheduleFocusRestore）
    if (await probeTabAlive(tab.id)) return tab;

    let prevActiveId = null;
    try {
        const [cur] = await chrome.tabs.query({ active: true, currentWindow: true });
        prevActiveId = cur && cur.id;
    } catch (e) { /* 忽略 */ }
    try { await chrome.tabs.update(tab.id, { active: true }); } catch (e) { /* 忽略 */ }
    selfActivateMark.set(tab.id, Date.now()); // V4.9.10.2：标记自激活（onActivated 消费，防误杀焦点恢复）
    // Edge 冻结 tab 解冻实测需 2s+（193MB 页面更久），1.2s 不够
    await new Promise((r) => setTimeout(r, 2500));
    if (prevActiveId && prevActiveId !== tab.id) {
        scheduleFocusRestore(tab.id, prevActiveId);
    }
    return tab;
}

// 获取当前活动标签页（noActivate=true：只查询不激活——只读数据/被动上报场景用）
async function getActiveTab(noActivate = false) {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const cur = tabs[0];
    if (cur && cur.url && /^https?:/i.test(cur.url)) return ensureTabAwake(cur);
    // 活动 tab 是浏览器内部页（edge://extensions、chrome://newtab 等）时回退到最近聚焦的 http(s) 页——
    // 实测：扩展管理页开着时，所有页面工具（executeScript/注入/抓包）会静默打到内部页（超时或空数据）
    // ⚠️ V4.9.8：回退分支会返回"非当前活动"的标签——noActivate=true 时绝不激活它！
    // （原实现无条件 ensureTabAwake → 用户在 newtab/内部页切标签时被强制弹回该 http 标签：
    //   "开新标签页停不住 / 点 2/3/4 标签回到第 5 个"事故的根因）
    const focused = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
    const httpFocused = (focused || []).filter(t => t.url && /^https?:/i.test(t.url));
    if (httpFocused.length) return noActivate ? httpFocused[0] : ensureTabAwake(httpFocused[0]);
    const allHttp = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] }).catch(() => []);
    if (allHttp.length) return noActivate ? allHttp[0] : ensureTabAwake(allHttp[0]);
    return cur;
}

// V4.9：跨标签页目标解析——显式 tabId → hostname 匹配 → 回退活动标签页。
// 页面类工具从"只认活动标签页"升级为可指定目标（多标签并行测试场景）。
// 注意：指定了目标但不存在时明确报错，不静默回退（防止测试打到错误页面）。
async function resolveTab(data = {}, noActivate = false) {
    const d = data || {};
    if (typeof d.tabId === 'number') {
        let t;
        try { t = await chrome.tabs.get(d.tabId); } catch (e) { throw new Error(`指定的标签页 ${d.tabId} 不存在或已关闭`); }
        if (!t || !t.url || !/^https?:/i.test(t.url)) {
            throw new Error(`指定的标签页 ${d.tabId} 不是 http(s) 页面（当前: ${(t && t.url) || 'unknown'}）`);
        }
        return noActivate ? t : (t.active ? t : ensureTabAwake(t));
    }
    if (typeof d.hostname === 'string' && d.hostname) {
        const ts = await chrome.tabs.query({}).catch(() => []);
        const want = d.hostname.toLowerCase();
        const match = (ts || []).filter(t => {
            if (!t.url || !/^https?:/i.test(t.url)) return false;
            try { return new URL(t.url).hostname.toLowerCase() === want; } catch (e2) { return false; }
        });
        if (match.length === 0) throw new Error(`未找到 hostname 为 ${d.hostname} 的标签页`);
        // M-安全 修复：命中多个不同 origin（同 host 不同端口/协议 = 不同源）时歧义报错——
        // 原 hostname 匹配会把数据/操作静默落到"活动标签或第一个"（可能是另一应用的标签）
        const origins = [...new Set(match.map(t => { try { return new URL(t.url).origin; } catch (e2) { return '?'; } }))];
        if (origins.length > 1) {
            throw new Error(`hostname ${d.hostname} 命中 ${match.length} 个不同 origin 的标签页（${origins.join(', ')}）——请用 tab_id 精确指定目标`);
        }
        const target = match.find(t => t.active) || match[0];
        return noActivate ? target : (target.active ? target : ensureTabAwake(target));
    }
    return getActiveTab(noActivate);
}

// V4.9.33：**守卫收敛**——把 50 处手写的「resolveTab + 判空 + 抛」收成一个点。
// 原先每个工具函数都复制这两三行，其中 2 处还漂移成了 `return { success:false }`
// （`startSensitiveMonitor` / `getSensitiveAlerts`——那两处是**有意**的结构化错误返回，
// 已在原处保留并注释，故本函数只服务"应该抛"的场合）。
// 收敛的收益不是少几行，而是**出错面从 50 个点变成一个点**：判据要改（比如加 url 检查）
// 只改这里。判据取原先两种写法的**更严者**（`!tab || !tab.url`）——`resolveTab` 本就
// 保证返回的标签页是 http(s) 且带 url，收紧不会误伤，只是把不变量显式化。
async function requireTab(data = {}, noActivate = false) {
    const tab = await resolveTab(data, noActivate);
    if (!tab || !tab.url) throw new Error('无法获取当前标签页');
    return tab;
}

// 获取页面信息（V4.9.8：noActivate——纯查询（tabs API 直读 url/title），绝不抢焦点。
// 该函数同时是 sendCurrentPageInfo 被动上报（切标签/加载完成触发）的执行体——原激活行为
// 导致"用户切到 newtab 被弹回 http 标签"事故）
async function getPageInfo(data = {}) {
    const tab = await requireTab(data, true);
    
    try {
        const url = new URL(tab.url);
        return {
            url: tab.url,
            title: tab.title,
            hostname: url.hostname,
            protocol: url.protocol,
            pathname: url.pathname,
            search: url.search,
            hash: url.hash,
            tabId: tab.id,
            isActive: !!tab.active, // V4.9.9.3（审计）：回退场景可能返回非活动标签——标记供 AI 判断"当前页"语义
            webRequestDiag: webRequestDiag
        };
    } catch (e) {
        return {
            url: tab.url,
            title: tab.title,
            tabId: tab.id
        };
    }
}

// 获取网络请求
// V4.9.17（批次1-B1）：归并返回层截断兜底——页面 hook 侧已带截断标记，此处防旧格式数据/异常路径
// （原实现 20000/50000 无标记切片 = 静默损坏证据；分散在归并处难以察觉）
// V4.9.19（批次4 明文对照）：对记录中的请求体/响应体反查"密文→明文"（页面 Crypto_Capture 的
// decryptMap——来源含 解密调用 与 加密产物 两条）。页面未启用 Crypto_Capture 时静默跳过（增强非依赖）。
async function attachPlaintextMatches(records, tabId) {
    try {
        let tid = tabId;
        if (typeof tid !== 'number') { const t = await resolveTab({}); tid = t && t.id; }
        if (typeof tid !== 'number') return;
        const texts = [];
        const slots = [];
        for (let i = 0; i < records.length; i++) {
            const r = records[i];
            if (!r) continue;
            if (typeof r.requestBody === 'string' && r.requestBody.length >= 16 && r.requestBody.charAt(0) !== '[') { texts.push(r.requestBody); slots.push([i, 'request']); }
            if (typeof r.responseBody === 'string' && r.responseBody.length >= 16 && r.responseBody.charAt(0) !== '[') { texts.push(r.responseBody); slots.push([i, 'response']); }
        }
        if (texts.length === 0) return;
        // V4.9.25（清单🟡-17）：原实现只查前 50 个 text 且全部失败路径**静默 return**——
        // 后半记录**永远不做**密文→明文反查，而调用方无从分辨"查了没匹配"与"根本没查"，
        // 会把"没有明文对照"读成"这些请求本来就是明文"。现两条路径都给记录打标（信息随数据走）
        const LOOKUP_CAP = 50;
        const markAll = (note) => {
            for (const [ri, kind] of slots) {
                if (kind === 'request') records[ri].plaintextLookupUnavailable = note;
                else records[ri].plaintextLookupUnavailable = note;
            }
        };
        // 超出单次上限的记录：明确标"未查"，rather than 留空让人以为查过
        const skippedSlots = new Set();
        for (let k = LOOKUP_CAP; k < slots.length; k++) skippedSlots.add(slots[k][0]);
        for (const ri of skippedSlots) {
            records[ri].plaintextLookupSkipped = `超出单次反查上限 ${LOOKUP_CAP} 条（本次候选 ${slots.length} 条）——**未做**密文→明文反查，不代表没有明文`;
        }

        const results = await adbExecuteScript({
            target: { tabId: tid },
            func: (payload) => {
                try {
                    if (!window.__ADB_CRYPTO__ || typeof window.__ADB_CRYPTO__.lookupBatch !== 'function') return null;
                    return window.__ADB_CRYPTO__.lookupBatch(payload);
                } catch (e) { return null; }
            },
            args: [texts.slice(0, LOOKUP_CAP)],
            world: 'MAIN'
        });
        const hits = results && results[0] && results[0].result;
        if (!Array.isArray(hits)) {
            // null = 页面没有 Crypto_Capture 的注册表（脚本未启用/未刷新/注入失败）
            markAll('页面未启用 Crypto_Capture（或脚本未生效/未刷新）——**未做**密文→明文反查，无明文对照不代表请求是明文');
            return;
        }
        for (let k = 0; k < slots.length && k < hits.length; k++) {
            const h = hits[k];
            if (!h || !h.plaintext) continue;
            const [ri, kind] = slots[k];
            if (kind === 'request') records[ri].requestPlaintext = h;
            else records[ri].responsePlaintext = h;
        }
    } catch (e) {
        // V4.9.25：执行异常同样留痕（原为空 catch——"页面冻结/注入超时"与"没有明文"不可分）
        try {
            for (const r of records) {
                if (r && (typeof r.requestBody === 'string' || typeof r.responseBody === 'string')) {
                    r.plaintextLookupUnavailable = `明文反查执行失败（${(e && e.message) || e}）——无明文对照不代表请求是明文`;
                }
            }
        } catch (e2) { /* 打标失败不影响主流程 */ }
    }
}

const BODY_RETURN_CAP = 200000;
function truncForReturn(v) {
    if (v == null) return undefined;
    const s = String(v);
    // V4.9.17（验收🟡1）：幂等守卫——hook 侧已截断并带标记的字符串不再二次截断。
    // 原实现在 hook 标记（含"原始 N 字符"）之外再切一刀：把 N 整段切掉换成自己的计数，
    // 2,000,026 被报成 200,027（低估 10 倍）——恰是本批次要消灭的"假报告"缺陷类型
    if (/\[ADB 截断/.test(s)) return s;
    return s.length > BODY_RETURN_CAP
        ? s.slice(0, BODY_RETURN_CAP) + '\n...[ADB 截断: 原始 ' + s.length + ' 字符]'
        : s;
}

// V4.9.10：include_body=true 时归并页面 hook 的请求体/响应体（一拉出全包，像 DevTools Network 面板）
// V4.9.18（批次2 两段式）：detail=false（默认）返回精简列表；detail=true 或 include_body=true 才给完整头/体
async function getNetworkRequests({ limit = 50, filter, method, tabId, hostname, includeBody = false, detail = false } = {}) {
    let requests = [...networkRequests];

    // V4.9.26（子代理审计抓出）：**原签名不收 hostname**——工具层现在会同时传 tabId 与 hostname，
    // hostname 被静默丢弃（tabId 有效、hostname 无效，且调用方看不到任何信号）= 假参数。
    // 有 hostname 而无 tabId 时先解析出 tab.id，复用同一条过滤逻辑；解析失败**直接上抛**，不静默不收窄。
    if (typeof tabId !== 'number' && typeof hostname === 'string' && hostname) {
        const t = await resolveTab({ hostname }, true);
        if (t) tabId = t.id;
    }

    // V4.9：跨标签页——按 tabId 过滤（webRequest 数据自带 tabId 字段；-1 为无法归属的请求）
    if (typeof tabId === 'number') {
        requests = requests.filter(r => r.tabId === tabId);
    }

    if (filter) {
        // V4.9.17（验收🟡2）：大小写不敏感——原 includes 大小写敏感，大写过滤器静默返回空；
        // 且与 getNetworkRequestsBurp 降级路径的 toLowerCase 语义不一致（同一函数两条路径两种行为）
        const fLow = filter.toLowerCase();
        requests = requests.filter(r => (r.url || '').toLowerCase().includes(fLow));
    }

    if (method) {
        // V4.9.21（复验 B-2）：`r.method` 可能为 undefined——分层落盘恢复的坏条目投影
        // （toPersistMeta 的空值守卫只返回 {headersOmitted:true}，无 method）走到这里会 TypeError。
        // 原实现直接 .toUpperCase() 是既有的锋利边缘，本次空值守卫放大了触发面，一并收口
        requests = requests.filter(r => String((r && r.method) || '').toUpperCase() === method.toUpperCase());
    }

    // V4.9.10：body 归并——页面 hook（GET_NETWORK_REQUESTS_WITH_BODY 注入的 fetch/XHR 全量 hook）按
    // method+url+时间窗（±10s，同机同钟）匹配到本缓冲记录。注入失败（页面冻结等）不阻断元数据返回。
    // V4.9.25（清单🟡-16）：失败原因记下来，出参时给每条记录打标（禁静默降级）
    let bodyMergeUnavailable = null;
    if (includeBody) {
        try {
            const bodyList = await getNetworkRequestsWithBody({ limit: 100, tabId: typeof tabId === 'number' ? tabId : undefined });
            if (Array.isArray(bodyList) && bodyList.length > 0) {
                const matched = new Set();
                requests = requests.map(e => {
                    const t = e.timestamp || 0;
                    let eOrigin = ''; try { eOrigin = new URL(e.url).origin; } catch (_) { /* 非绝对 URL 忽略 */ }
                    // V4.9.10.2（审计 L-4）：取时间差**最小**的候选——原 find 取窗口内首个，
                    // hook 缺早期记录时会张冠李戴（t=1s 的元数据贴上 t=6s 的 body）
                    let b = null, bestDt = Infinity;
                    for (const x of bodyList) {
                        if (matched.has(x)) continue;
                        if (String(x.method || '').toUpperCase() !== String(e.method || '').toUpperCase()) continue;
                        const dt = Math.abs((x.startTime || 0) - t);
                        if (dt >= 10000 || dt >= bestDt) continue;
                        // V4.9.10.1（实测修复）：hook 记录的是 fetch 原始入参——相对路径（fetch('/x')）
                        // 需用记录侧 origin 补全后比较；V4.9.10.2：URL 对象场景 String 兜底
                        let xu = String(x.url || '');
                        if (eOrigin && !/^https?:/i.test(xu)) { try { xu = new URL(xu, eOrigin).href; } catch (_) { /* 保持原值 */ } }
                        if (xu !== e.url) continue;
                        b = x; bestDt = dt;
                    }
                    if (!b) return e;
                    matched.add(b);
                    return {
                        ...e,
                        requestBody: truncForReturn(b.requestBody),
                        responseBody: truncForReturn(b.responseBody),
                        bodyMatched: true,
                        // V4.9.18（复盘C1）：暴露匹配时间差——归并是启发式（method+url+时间窗），差越小越可信；
                        // 同 URL 高频轮询场景 AI 可据此判断是否可能错配
                        matchDeltaMs: Math.round(bestDt),
                        source: 'webRequest+page-hook',
                        // V4.9.17（审计#6）：旧版本 hook 警示随记录传播（打标在 hook 记录上，归并需搬运）
                        ...(b.hookStale ? { hookStale: b.hookStale } : {}),
                        ...(b.bodyPlaceholder ? { bodyPlaceholder: b.bodyPlaceholder } : {}),
                        // V4.9.18（验收⚪4）：hook 侧错误也搬运（原 error 不参与归并——"永久[读取中]且无解释"）
                        ...(b.error ? { error: b.error } : {}),
                        // V4.9.18（验收⚪5c）：搬 startTime/endTime——Burp 输出的 duration 原恒为 N/A
                        ...(b.startTime ? { startTime: b.startTime, endTime: b.endTime } : {})
                    };
                });
                // V4.9.18（复盘A2）：并集——hook 有而元数据没有的记录也输出（扩展重载后 SW 缓冲清空、
                // 页面 hook 数据仍在时，原实现这些 body 完全不可见）。截最近 20 条防列表被孤儿淹没
                let orphans = bodyList.filter(x => !matched.has(x));
                // V4.9.18（烟测修复）：孤儿记录同样受 filter/method 约束——原实现直接 concat，
                // 绕过 filter 导致"过滤形同虚设"（实测：filter='smoke' 仍涌出全量孤儿）
                if (filter) { const fLow = filter.toLowerCase(); orphans = orphans.filter(x => String(x.url || '').toLowerCase().includes(fLow)); }
                if (method) { orphans = orphans.filter(x => String(x.method || '').toUpperCase() === method.toUpperCase()); }
                if (orphans.length > 0) {
                    requests = requests.concat(orphans.slice(-20).map(b => ({
                        url: b.url,
                        tabId: typeof tabId === 'number' ? tabId : undefined,
                        method: b.method,
                        type: 'page-hook',
                        statusCode: b.statusCode,
                        timestamp: b.startTime,
                        requestBody: truncForReturn(b.requestBody),
                        responseBody: truncForReturn(b.responseBody),
                        bodyMatched: true,
                        source: 'page-hook',
                        note: '无 webRequest 元数据（可能扩展重载后缓冲清空）——以页面 hook 记录呈现',
                        ...(b.hookStale ? { hookStale: b.hookStale } : {}),
                        ...(b.bodyPlaceholder ? { bodyPlaceholder: b.bodyPlaceholder } : {})
                    })));
                }
            }
        } catch (err) {
            // 页面 hook 不可用——仅元数据（不阻断）
            // V4.9.25（清单🟡-16）：**降级必须留标记**——原实现静默吞掉，调用方拿到"没有 requestBody/
            // responseBody 字段"的记录，无法区分"这条请求本来就没有 body"与"归并整体不可用"
            bodyMergeUnavailable = (err && err.message) || String(err);
        }
    }

    const out = requests.slice(-limit);

    // V4.9.18（批次2 两段式输出，对齐 chrome-devtools 的 list/detail）：批次 1 后每条记录带 12-16 个
    // 真实头（含 Cookie 全串）× 50 条 = 40-80KB，单次调用即压满模型上下文。精简列表同条数 ≈ 几 KB。
    // 看完整头/体：detail=true（本工具）或 include_body=true；看单条：get_network_request_detail
    if (!detail && !includeBody) {
        return out.map(r => ({
            url: r.url,
            method: r.method,
            type: r.type,
            statusCode: r.statusCode,
            timestamp: r.timestamp,
            tabId: r.tabId,
            requestId: r.requestId,
            error: r.error,
            completed: r.completed,
            // V4.9.20：重定向链是概览级信息（跳转过程），精简模式也带（原被裁掉——302 记录了却看不到去向）
            ...(r.redirects ? { redirects: r.redirects } : {}),
            hasRequestHeaders: !!(r.requestHeaders && r.requestHeaders.length),
            hasResponseHeaders: !!(r.responseHeaders && r.responseHeaders.length),
            // V4.9.21（性能优化 1.2 配套）：SW 回收后从分层落盘恢复的记录不含头——如实标记，
            // 防"查不到 Cookie/头"被误读为"该请求本来就没有"（禁静默降级纪律）
            ...(r.headersOmitted ? { headersOmitted: true } : {})
        }));
    }

    // V4.9.19（批次4 明文对照）：页面启用 Crypto_Capture 时，为带 body 的记录附"密文→明文"
    // （requestPlaintext / responsePlaintext 字段）——加密站渗透直接看明文参数，无需手工 hook
    if (includeBody) { await attachPlaintextMatches(out, tabId); }

    // V4.9.17（审计#5）：单次返回 body 总预算——防 50 条 × (200KB+200KB) = 20MB 单条工具结果撑爆模型上下文。
    // 从**最新**记录往前分配（渗透场景关心最近的请求），超预算的旧记录只留标记（不静默丢）
    {
        const BODY_TOTAL_BUDGET = 2 * 1024 * 1024;
        let used = 0;
        for (let i = out.length - 1; i >= 0; i--) {
            const r = out[i];
            if (!r || !r.bodyMatched) continue;
            const sz = (r.requestBody ? r.requestBody.length : 0) + (r.responseBody ? r.responseBody.length : 0);
            if (used + sz > BODY_TOTAL_BUDGET) {
                const note = '[body 省略: 单次返回总预算 2MB 已达——用 filter 缩小范围或调小 limit 重取]';
                if (r.requestBody) r.requestBody = note;
                if (r.responseBody) r.responseBody = note;
            } else {
                used += sz;
            }
        }
    }

    // V4.9.25（清单🟡-16）：归并整体失败时给**每条**记录打标——否则"记录上没有 requestBody 字段"
    // 会被读成"这条请求本来就没有 body"（对齐本项目 `X-ADB-Body-Truncated` 的既有点名范式）
    if (bodyMergeUnavailable) {
        for (const r of out) {
            if (!r || typeof r !== 'object') continue;
            r.bodyMergeFailed = true;
            r.bodyMergeError = bodyMergeUnavailable;
            r.bodyMergeNote = 'body 归并整体不可用（页面 hook 未注入/页面未刷新）——本次为**纯元数据**，缺 body **并非该请求本来就没有 body**';
        }
    }

    return out;
}

// 获取Vue Router数据（V4.9.8：noActivate——读 storage 数据，不需要页面操作/焦点）
async function getVueRouterData(data = {}) {
    const tab = await requireTab(data, true);

    const hostname = new URL(tab.url).hostname;
    const storageKey = `${hostname}_vue_data`;

    // V4.9.11（子代理对标上游发现）：读侧慢站语义对齐——原实现"首读 storage → 请求页面重扫 →
    // 固定等 1000ms → 再读一次"，慢站（实测 news.example.edu.cn 45s+ 才挂载 Vue）必然误报 notFound。
    // 改为**轮询至超时** + 可配 timeout_ms（默认 6000，上限 30000），返回体带 status 枚举说明结论来源。
    const timeoutMs = Math.min(Math.max(Number(data.timeoutMs) || 6000, 1000), 30000);
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // 带超时的等待（V4.9.11 审计 L5：输方定时器必须清掉——原 Promise.race 的 sleep 从不 clearTimeout，
    // 30s 窗口会累积约 40 个悬挂定时器）
    const withTimeout = (p, ms) => {
        let t;
        return Promise.race([
            p,
            new Promise((resolve) => { t = setTimeout(() => resolve(null), ms); })
        ]).finally(() => clearTimeout(t));
    };

    // 单次 storage 读（1.5s 护栏：登录后上报高峰 storage 回调曾长时间不触发，防单次读取挂死整个命令）
    const readStorage = () => withTimeout(
        new Promise((resolve) => {
            chrome.storage.local.get([storageKey], (result) => resolve(result[storageKey] || null));
        }), 1500);

    // "就绪"判定（V4.9.11 独立审计 H2）：有 instances/routes 且不是 notFound 观测记录才算拿到数据。
    // 原实现把任何 truthy 值都当成功——刚被"请求即重扫"写下的 notFound 记录会被当成 found 返回，
    // 恰好是本改动要消灭的误报形态（且会让服务端相信 status:found）
    const isReady = (d) => !!d && !d.notFound && (
        (Array.isArray(d.instances) && d.instances.length > 0) ||
        (Array.isArray(d.routes) && d.routes.length > 0) ||
        // V4.9.11（复核 ❌-1）：Nuxt 站与"只有动态/Pinia 数据"的站不写 instances/routes——
        // 不认这些 payload 会白等满超时，且超时出口曾把数据整体丢弃（nuxt_payload_probe 等消费方失效）
        !!d.nuxtData ||
        (Array.isArray(d.dynamicRoutes) && d.dynamicRoutes.length > 0) ||
        (Array.isArray(d.piniaMenus) && d.piniaMenus.length > 0)
    );

    // 请求页面采集（content.js:175 转发为带 source 的 postMessage；脚本 REQUEST 分支已支持"请求即重扫"）
    // V4.9.31：**让失败显形**——原实现两个出口（同步抛 / 回调）都静默 `resolve()`，
    // 请求根本没送达时连痕迹都不留。实测（portal.example.com，Vue 2.7.16 站点）首采
    // 15s 必超时，而**在页面里直接 postMessage 立刻就能拿到 23 条路由** → 断点就在这一跳；
    // 但静默吞让根因完全不可见（这正是本项目反复在修的那类缺陷）。
    // 现回传错误字符串（成功为空串），由调用方并入超时返回体。
    const requestRescan = () => new Promise((resolve) => {
        try {
            chrome.tabs.sendMessage(tab.id, { type: 'REQUEST_VUE_ROUTER_DATA' }, () => {
                const le = chrome.runtime.lastError;
                resolve(le ? String(le.message || le) : '');
            });
        } catch (e) { resolve(String((e && e.message) || e)); }
    });

    // V4.9.11（复核 ⚠️-4）：返回前剔除内部字段 `__srcTab`，并在数据来自**别的**标签页时明确标注——
    // 同域多标签场景下 loading 清理已不再跨标签误删，首读可能命中另一个标签页采集的数据，
    // 不标注会让 AI 把 A 的数据当成 B 的现状（两个标签可能不同账号/角色）
    const stripInternal = (d) => { const { __srcTab, ...r } = d || {}; return r; };
    const shapeReady = (d, how) => {
        const srcTab = d && d.__srcTab;
        const sameTab = typeof srcTab !== 'number' || srcTab === tab.id;
        return {
            ...stripInternal(d),
            status: 'found',
            source: sameTab ? how : 'storage_other_tab',
            srcTab: sameTab ? undefined : srcTab,
            waitedMs: Date.now() - startedAt
        };
    };

    let last = await readStorage();
    if (isReady(last)) return shapeReady(last, 'storage');

    // V4.9.11 独立审计 H2：页面脚本**只在收到 REQUEST 时才上报**（不会自发写 storage），
    // 所以"轮询"必须配合**周期性重发请求**——只发一次的话，慢站等到超时也不会有新数据产生。
    let rescanAttempts = 0;
    let rescanError = '';
    while (Date.now() < deadline) {
        const e = await withTimeout(requestRescan(), 1500);
        rescanAttempts++;
        if (e === null) rescanError = rescanError || 'tabs.sendMessage 无响应（1.5s 超时）';
        else if (typeof e === 'string' && e) rescanError = e;
        last = await readStorage();
        if (isReady(last)) return shapeReady(last, 'rescan');
        await sleep(700);
    }

    // 超时出口：如实标注 timeout——即便曾读到 notFound 记录也不谎报 found
    // （复核 ❌-1：展开 last——超时前读到的任何部分数据都比整个丢弃有用；notFound 放后面覆盖）
    return {
        ...stripInternal(last),
        notFound: true,
        status: 'timeout',
        waitedMs: Date.now() - startedAt,
        rescanAttempts,
        // V4.9.31：**区分"该站没有路由"与"我们的通道断了"**——这两者原先在输出里完全同形，
        // AI 只会看到 timeout 就去下"该站非 Vue / 没有路由"的结论。实测：这个站有 23 条路由、
        // detect_site_framework 能读到，但采集请求这一跳送不到页面脚本。
        ...(rescanError ? {
            rescanError,
            rescanNote: `向页面转发采集请求失败（${rescanAttempts} 次尝试）：${rescanError}。`
                + `这**不是**「该站没有 Vue 路由」，而是**扩展与页面脚本的通道断了**——`
                + `可先刷新页面再重试；并用 detect_site_framework 交叉验证（它能直读页面实例，`
                + `若它报出 routeCount，则说明路由确实存在、只是本条通路取不到）`
        } : {}),
        lastObservation: last && last.notFound ? 'script_reported_not_found' : (last ? 'stale_data_without_routes' : 'no_data'),
        hint: `等待 ${timeoutMs}ms 未取到有效的 Vue 路由数据（扩展侧每约 2 秒重发一次采集请求）。可能原因：① 「获取路由」脚本未启用/未注入 ② 站点非 Vue 或实例尚未挂载 ③ 页面极慢（可加大 timeout_ms 重试，最大 30000）`
    };
}

// V4.5 深链绕过探针：清路由独享守卫(beforeEnter/redirect) → Hook push/replace 记录弹回源 → 深链 → 落点判定。
// 实测（admin.example.com）：全局 beforeEach 被清后站点仍弹回登录页（afterEach/watcher 型），
// 原版清守卫脚本对这类站点静默失效——本探针把弹回源暴露给 AI 判断走哪条绕过路线
async function deepLinkProbe({ targetPath, wait = 2500, patchBounce = false, tabId, hostname } = {}) {
    // V4.7.1：改走 executeScript 的 CDP 通道（func+args 通道对部分 tab 状态永不 settle）
    const tab = await requireTab({ tabId, hostname });
    if (!targetPath) throw new Error('缺少 target_path 参数');

    const params = JSON.stringify({ targetPath, wait, patchBounce });
    return executeScript({
        world: 'MAIN',
        // V4.9.26（作用域收尾，验收脚本抓出）：上面刚解析出目标 tab，这里却**没把 tab.id 传下去**
        // ——executeScript 会用自己的 resolveTab({undefined}) 回退到**活动标签页**，
        // 于是"解析校验的是目标页、实际探测跑在活动页"，半程生效且调用方看不出来。
        tabId: tab.id,
        code: `(async function(){
    const app = document.querySelector('#app') || document.querySelector('[data-v-app]');
    const rt = app && app.__vue_app__ ? app.__vue_app__.config.globalProperties.$router : null;
    if (!rt) return JSON.stringify({ error: '未找到 Vue Router 实例（非 Vue 站或脚本未注入）' });
    const __p = ${params};
    const targetPath = __p.targetPath, wait = __p.wait, patchBounce = __p.patchBounce;
    const removedBeforeEnter = [];
    const removedRedirects = [];
    rt.getRoutes().forEach((r) => {
        if (r.record && r.record.beforeEnter) { removedBeforeEnter.push(r.path); delete r.record.beforeEnter; }
        if (r.record && r.record.redirect) { removedRedirects.push(r.path); delete r.record.redirect; }
    });
    if (!Array.isArray(window.__adbNavLog)) window.__adbNavLog = [];
    const navLog = window.__adbNavLog;
    // 批2审计 M1：本次调用基线——navLog 跨调用复用（wrapper 幂等不重装），bounces 过滤全量
    // 会把上一次探测的弹回记到本次头上，误判绕过路线
    const navLogBaseline = navLog.length;
    const wrapNav = (orig, name) => function (loc) {
        try {
            const st = (new Error().stack || '').split('\\n').slice(1, 5).map(s => s.trim().slice(0, 140));
            navLog.push({ via: name, to: typeof loc === 'string' ? loc : (loc && loc.path) || String(loc), stack: st });
            if (navLog.length > 50) navLog.splice(0, navLog.length - 50);
        } catch (e) { /* 忽略 */ }
        return orig.apply(this, arguments);
    };
    if (!rt.push.__adbWrapped) {
        rt.push = wrapNav(rt.push, 'push'); rt.push.__adbWrapped = true;
        rt.replace = wrapNav(rt.replace, 'replace'); rt.replace.__adbWrapped = true;
    }
    let bouncePatched = false;
    let bouncePatchInstalledNow = false;
    if (patchBounce) {
        const dropLogin = (orig, name) => function (loc) {
            const to = typeof loc === 'string' ? loc : (loc && loc.path) || '';
            if (/login|signin/i.test(to) && to.length <= 10) {
                navLog.push({ via: 'patched-drop-' + name, to: to, stack: ['patchBounce: 拦截弹回（axios 401 interceptor 型）'] });
                return Promise.resolve();
            }
            return orig.apply(this, arguments);
        };
        if (!rt.push.__adbPatched) {
            rt.push = dropLogin(rt.push, 'push'); rt.push.__adbPatched = true;
            rt.replace = dropLogin(rt.replace, 'replace'); rt.replace.__adbPatched = true;
            bouncePatchInstalledNow = true;
        }
        // V4.9.25（清单🟡-13）：bouncePatched 原只在【本次新装】时为 true——而补丁一旦装上就
        // 一直挂在 rt.push 上（__adbPatched 幂等守卫会跳过重装），于是【第二次调用恒报 false】。
        // AI 读成"补丁没打上"→ 放弃一条【实际仍在生效】的绕过路线。现如实上报【生效状态】
        bouncePatched = !!rt.push.__adbPatched;
    }
    const from = rt.currentRoute.value.path;
    await rt.push(targetPath).catch(() => {});
    await new Promise((r) => setTimeout(r, wait));
    const landed = rt.currentRoute.value.path;
    const bypassed = landed === targetPath || landed.startsWith(targetPath + '/');
    // 只取本次调用新增的切片（M1 修复）
    const bounces = navLog.slice(navLogBaseline).filter(n => /login|signin|auth/i.test(n.to) && !(n.to === targetPath || targetPath.includes(n.to)));
    return JSON.stringify({
        targetPath, fromPath: from, landedPath: landed, bypassed, bouncePatched,
        // V4.9.25：区分"本次新装"与"此前已装、当前仍在生效"——bouncePatched:true 且
        // bouncePatchInstalledNow:false 表示补丁是上一次调用打的，此刻依然在拦
        bouncePatchInstalledNow,
        removedBeforeEnter, removedRedirects, navLog: navLog.slice(-12), bounces
    });
})()`
    });
}

// V4.5 读取 WS 监控帧（hook_websocket 脚本上报的连接/收发帧，环形 200 条）
async function getWSFrames({ limit = 100, filter, tabId, hostname: targetHostname } = {}) {
    const tab = await requireTab({ tabId, hostname: targetHostname }, true);
    const hostname = new URL(tab.url).hostname;
    return new Promise((resolve) => {
        chrome.storage.local.get([`${hostname}_ws_frames`], (result) => {
            let frames = result[`${hostname}_ws_frames`];
            if (!Array.isArray(frames) || frames.length === 0) {
                resolve({ notFound: true, hint: '未发现 WS 帧数据。请先启用 hook_websocket 脚本并刷新页面（目标站需有 WebSocket 通信）' });
                return;
            }
            if (filter) frames = frames.filter(f => JSON.stringify(f).includes(filter));
            // V4.9.20（审计🟡-6 + 复验⚪）：排序键 (timestamp, seq)——timestamp 为主键（跨标签页可比：
            // 存储按 hostname 隔离，同站多标签页的 seq 各自从 1 开始会交叉，纯 seq 排序会错乱且
            // slice(-limit) 可能丢最新帧）；同毫秒再以 seq 破平（异步上报的乱序已被 seq 正确表达）
            frames = frames.slice().sort((a, b) => {
                const ta = a.timestamp || 0, tb = b.timestamp || 0;
                if (ta !== tb) return ta - tb;
                if (a.seq == null || b.seq == null) return 0;
                return a.seq - b.seq;
            });
            resolve({ frames: frames.slice(-limit), total: frames.length });
        });
    });
}

// V4.8 路由数组 Hook 替换（动态路由实战打法自动化，替代手工 Local Overrides）：
// chunk 源码里常有"未加载路由数组"（如 dynamicRoutes/asyncRoutes 变量，path+component 完整但未注册）。
// AI 工作流：get_js_chunks → get_chunk_source 定位「已加载数组返回点」（如 return Ue）
// 和「未加载数组变量名」（如 Ee）→ 本工具拦截该 chunk 响应做字节级替换
// （from_str='return Ue' → to_str='return Ue.concat(Ee)'）→ 自动刷新 → 未加载路由变已加载
// → get_vue_routes 确认 → deep_link_probe / unauthorized_sweep 逐个测未授权
async function hookRouteArray({ urlKeyword, fromStr, toStr, once = true, reload = true, tabId, hostname } = {}) {
    const tab = await requireTab({ tabId, hostname });
    if (!urlKeyword || !fromStr || toStr === undefined || toStr === null) {
        throw new Error('缺少 url_keyword / from_str / to_str 参数');
    }

    return withDebugger(tab.id, () => {
        return new Promise((resolve, reject) => {
            let settled = false;
            let passthrough = 0;
            const pattern = '*' + urlKeyword + '*';

            const cleanup = () => {
                chrome.debugger.onEvent.removeListener(onEvent);
                cdpSend(tab.id, 'Fetch.disable', {}).catch(() => { });
            };
            const finish = (fn, arg) => {
                if (settled) return;
                settled = true;
                cleanup();
                fn(arg);
            };

            const onEvent = async (source, method, params) => {
                if (!source || source.tabId !== tab.id || method !== 'Fetch.requestPaused') return;
                const requestId = params.requestId;
                try {
                    const resp = await cdpSend(tab.id, 'Fetch.getResponseBody', { requestId });
                    // atob 得到 binary string（每字符=一字节）。from_str/to_str 为 ASCII 标识符时
                    // 字节级替换安全：UTF-8 多字节序列的续字节均 >= 0x80，不会与 ASCII 撞车
                    const bodyText = resp.base64Encoded ? atob(resp.body) : resp.body;
                    // V4.9.25（清单🟡-12）：单次替换上限**必须标注**——原实现硬上限 50 且无任何标记：
                    // 目标串在 chunk 中出现超过 50 次时，后半仍是**原文**，返回体却只说"替换已生效"，
                    // 调用方会以为改全了（路由仍注册不上却找不到原因）
                    const MAX_REPL = 50;
                    let n = 0, idx = 0, out = '';
                    while (n < MAX_REPL) {
                        const found = bodyText.indexOf(fromStr, idx);
                        if (found === -1) break;
                        out += bodyText.slice(idx, found) + toStr;
                        idx = found + fromStr.length;
                        n++;
                    }
                    const hitCap = n >= MAX_REPL && bodyText.indexOf(fromStr, idx) !== -1;
                    if (n === 0) {
                        // 响应不含目标串（url_keyword 匹配到多个资源）：原样放行
                        passthrough++;
                        await cdpSend(tab.id, 'Fetch.continueResponse', { requestId })
                            .catch(() => cdpSend(tab.id, 'Fetch.continueRequest', { requestId }));
                        if (once && passthrough > 30) finish(reject, new Error('连续放行 30 个匹配响应均不含 from_str，已中止（检查 from_str 是否为源码原文）'));
                        return;
                    }
                    out += bodyText.slice(idx);
                    const headers = (params.responseHeaders || [])
                        .filter(h => !/^content-(encoding|length)$/i.test(h.name))
                        .map(h => ({ name: h.name, value: h.value }));
                    await cdpSend(tab.id, 'Fetch.fulfillRequest', {
                        requestId,
                        responseCode: 200,
                        responseHeaders: headers,
                        body: btoa(out)
                    });
                    finish(resolve, {
                        success: true,
                        url: params.request.url,
                        replacements: n,
                        oldLength: bodyText.length,
                        newLength: out.length,
                        from: fromStr,
                        to: toStr,
                        ...(hitCap ? {
                            replacementCapped: true,
                            replacementCapNote: `替换次数达单次上限 ${MAX_REPL}，且原文中**仍有未替换的匹配**——该 chunk 里 "${fromStr}" 出现超过 ${MAX_REPL} 次，本次只改了前 ${MAX_REPL} 处，其余仍是原文（可换更精确的 from_str 缩短匹配面，或分次处理）`
                        } : {}),
                        note: '替换已生效。页面后续加载将使用替换后的 chunk——请重新执行 get_vue_routes / get_page_info 查看新注册路由，再深链探测。注意：若站点对 chunk 配置了 SRI 校验则替换会被浏览器拒绝（少见）'
                    });
                } catch (e) {
                    finish(reject, new Error('替换失败: ' + e.message));
                }
            };
            chrome.debugger.onEvent.addListener(onEvent);

            // bug-hunt M5（2026-10-13）：超时守卫提前安装——原在 Fetch.enable 成功后才装，
            // 冻结/挂起标签下 Fetch.enable 永不返回 → 监听器永久累积、withDebugger 计数永不归零
            setTimeout(() => {
                finish(reject, new Error('超时 20s：未拦截到含 from_str 的响应。排查：① url_keyword 是否匹配 chunk URL（get_js_chunks 查询）② from_str 是否与 get_chunk_source 读到的源码逐字符一致（压缩变量名区分大小写）③ 该 chunk 是否已被浏览器强缓存（reload 不重新请求，可换 hard 刷新或等会话过期）'));
            }, 20000);

            (async () => {
                try {
                    await cdpSend(tab.id, 'Fetch.enable', { patterns: [{ urlPattern: pattern, requestStage: 'Response' }] });
                    if (reload) chrome.tabs.reload(tab.id).catch(() => { });
                } catch (e) {
                    finish(reject, e);
                }
            })();
        });
    });
}

// V4.3 读取 store dump（Get_Store_Dump 脚本上报的 Pinia/Vuex 全量状态）
async function getStoreDump({ tabId, hostname: targetHostname } = {}) {
    const tab = await requireTab({ tabId, hostname: targetHostname }, true);

    const hostname = new URL(tab.url).hostname;
    return new Promise((resolve) => {
        chrome.storage.local.get([`${hostname}_store_dump`], (result) => {
            const dump = result[`${hostname}_store_dump`];
            if (dump) {
                resolve(dump);
            } else {
                // 未启用脚本时给出可执行指引
                resolve({
                    notFound: true,
                    hint: '未发现 store dump 数据。请先通过 MCP toggle_script 或 popup 启用 Get_Store_Dump 脚本并刷新页面（登录后数据更完整）。'
                });
            }
        });
    });
}

// 匿名请求（未授权测试基线）：service worker 中的 fetch 不携带页面 cookie
// 天然以"未认证用户"视角请求目标 URL，用于与认证访问对比判定未授权
// V4.9.11（验收修复 S4）：给可能**永不 settle** 的 Promise 加硬超时。
// 场景：chrome.scripting.executeScript 对睡眠冻结/导航中的标签 Promise 永不 settle
// （见本文件 830-832、1776-1778 行的实测记录），而 anonFetch 的 resolveTab 用 noActivate=true
// 绕过了 ensureTabAwake 的解冻——原实现无超时会导致批量扫描在目标标签冻结时每条请求挂死 30s+
// 且永不回退 SW fetch。超时抛错后被 catch 接住，正好落到 SW 网络栈兜底（SW 不依赖渲染进程）
function withHardTimeout(promise, ms, message) {
    let timer = null;
    return Promise.race([
        promise,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })
    ]).finally(() => { if (timer) clearTimeout(timer); });
}

// V4.9.14：chrome.scripting.executeScript 统一代理——根治 V4.7 漏网的睡眠/冻结 tab 挂死残余。
// 快路径：原生 API 包 8s 硬超时（活跃页面毫秒级完成，无感）；超时（永不 settle 型）转慢路径：
// func.toString() 序列化 + args JSON 注入 → CDP Runtime.evaluate（func 本就要求自包含，
// toString+args 注入与原生序列化语义等价），返回值包装回 InjectionResult[] 形态。
// 原生调用仅剩 2 处有意保留：probeTabAlive 活性探测（设计不碰 debugger）、本代理内部快路径。
// 局限声明：慢路径 ISOLATED 调用点（anonFetch）在页面主世界执行——anonFetch 调用方 catch 后
// 走 SW fetch 兜底，不依赖慢路径结果；慢路径 Runtime.evaluate 包 25s 硬超时 + terminateExecution
// （与 executeScript 封装 MAIN 路径同款，防挂死占住调试计数——审计 M2）。
async function adbExecuteScript(opts) {
    // S3（bug-hunt 2026-10-13）：提前持有快路径 promise——withHardTimeout 只 clearTimeout、**不取消**
    // 已在飞的注入；超时后若慢路径命中"双执行令牌"的输家标记，需回头等它落地（唯一能拿到真实结果的来源）。
    // 兜底 catch 防它在超时后迟到的 rejection 变成 unhandledrejection（收尾路径会另行 await 处理）
    const fastPromise = chrome.scripting.executeScript(opts);
    fastPromise.catch(() => { /* 防 unhandled；真实处理见下方收尾路径 */ });
    // V4.9.37（M-4 修复）：快路径超时**按世界分开**。
    //
    // 为什么 MAIN 可以早退：MAIN 的慢路径（CDP Runtime.evaluate）**能用**，早退只是换个
    // 通道、结果一样；而 ISOLATED 的慢路径是 **fail-fast**（不重放，见下方 effWorld 判定），
    // 早退会把**本该成功**的调用变成报错 —— 所以 ISOLATED 保持 8s 不动。
    //
    // 为什么要早退（实测数据）：被后台节流的标签上，快路径**从不返回**——
    //   节流标签：注入 8061/8071ms，且 3 秒内 100ms 定时器只触发 3 次（正常应 30 次）
    //   正常标签：同一时刻注入 9/7ms，定时器触发 30 次
    // 于是每个注入类工具在节流标签上都要**白等满 8 秒**才落慢路径。正常情况是 ~10ms
    // ——2 秒已是它的 **200 倍**余量；真出现"页面长任务把注入堵住 2 秒"的罕见情况，
    // 也只是多走一次 CDP 慢路径，**结果不变**（不存在"改坏了"的形态）。
    //
    // ⚠️ 别把 ISOLATED 也一起降：那会让 anonFetch 在节流标签上从"能成功"变成"报错"。
    const FAST_PATH_TIMEOUT_MAIN = 2000;
    const FAST_PATH_TIMEOUT_ISOLATED = 8000;
    const fastTimeout = opts.world === 'MAIN' ? FAST_PATH_TIMEOUT_MAIN : FAST_PATH_TIMEOUT_ISOLATED;
    try {
        return await withHardTimeout(fastPromise, fastTimeout, '__adb_exec_timeout__');
    } catch (e) {
        if (!String(e && e.message).includes('__adb_exec_timeout__')) throw e;
        const { func, args = [], target, world } = opts;
        const tabId = target && target.tabId;
        if (typeof tabId !== 'number' || typeof func !== 'function') throw e;
        // V4.9.36（M-4）：快路径超时**此前不留任何痕迹** —— 结果是"部分标签上 13 个工具
        // 固定 8 秒延迟"这件事，在标签被切走之后就**完全无法事后诊断**（我据此提出的
        // "窗口失焦/标签冻结"根因假设，已被实测推翻：hasFocus:false + visibility:hidden
        // 的标签上注入只要 6~10ms）。既然它只在**开了很久的实战标签**上出现、新建标签
        // 从不复现，那就装个记录器，等它在真实使用中自然发生时把现场留下。
        // 看的地方：edge://extensions → Fush → 服务工作进程 → 控制台，
        // 过滤 `[adb-slowpath]`。
        try {
            const t = await chrome.tabs.get(tabId);
            console.warn(`[adb-slowpath] 快路径超时(8s)→转CDP慢路径 ｜ tab=${tabId} ｜ world=${world === 'MAIN' ? 'MAIN' : 'ISOLATED(缺省)'} ｜ status=${(t && t.status) || '?'} ｜ active=${(t && t.active) || '?'} ｜ url=${(t && t.url) || '?'}`);
        } catch (e2) {
            console.warn(`[adb-slowpath] 快路径超时(8s)→转CDP慢路径 ｜ tab=${tabId} ｜ （tab 信息取不到：${(e2 && e2.message) || e2}）`);
        }
        // bug-hunt M8（2026-10-13）：缺省 world 时快路径默认走 ISOLATED，而慢路径（Runtime.evaluate）
        // 恒为 MAIN——原判 `world === 'ISOLATED'` 对 undefined 为 false → getDOMInfo（唯一未传 world
        // 的调用点）慢路径跨世界执行（防污染意图被绕过、结果语义随耗时为两种世界漂移）。归一化判定
        const effWorld = world === 'MAIN' ? 'MAIN' : 'ISOLATED';
        if (effWorld !== 'MAIN') {
            // 审计 M1：慢路径无法维持 ISOLATED 隔离（Runtime.evaluate 在主世界）——
            // 匿名请求语义不容页面 fetch hook 污染，fail-fast 交回调用方兜底（anonFetch 有 SW fetch 降级）
            throw new Error('adbExecuteScript: ISOLATED 慢路径不支持（防主世界污染），调用方应走各自兜底');
        }
        // S3 边角 4（bug-hunt）：慢路径只打顶层帧——allFrames/frameIds 下快路径打全帧、慢路径打顶层，
        // 双执行令牌只在顶层帧共享会失配（其余帧仍双执行）。fail-fast（当前无调用点使用这两参数）
        if (target.allFrames || target.frameIds) {
            throw new Error('adbExecuteScript: 慢路径不支持 allFrames/frameIds（双执行令牌只在顶层帧成立）');
        }
        // callExpr 本身即完整调用表达式（求值即返回值）——审计 P0：不得再包一层 ()
        const callExpr = `(${func.toString()})(${args.map(a => JSON.stringify(a === undefined ? null : a)).join(',')})`;
        return withDebugger(tabId, async () => {
            let r;
            try {
                // 外层 async + await callExpr：兼容 async func（返回 Promise 的 func 必须等待，否则被序列化为 {}——审计 M1）
                // 2026-10-13 修复：原写 `tab.id`——本作用域变量是 tabId（number），tab 未定义 →
                // 慢路径每次都在此处抛 ReferenceError（"tab is not defined"），**CDP 兜底从未真正生效**
                // （快路径 8s 内完成的活跃页面测不出来，只有睡眠/冻结 tab 才走到这条路径）
                r = await withHardTimeout(cdpSend(tabId, 'Runtime.evaluate', {
                    expression: `(async function(){try{const __r = await (${callExpr}); return JSON.stringify({__adb:true,__value:__r===undefined?null:__r});}catch(__e){return JSON.stringify({__adb:true,__error:String((__e&&__e.message)||__e)});}})()`,
                    returnByValue: true,
                    awaitPromise: true,
                    userGesture: true
                }), 25000, 'CDP 代理执行超时（页面内 25s 未返回）');
            } catch (e3) {
                // 超时后终止页面内仍在跑的执行，防幽灵任务占住调试计数（审计 M2）
                try { await cdpSend(tabId, 'Runtime.terminateExecution'); } catch (e4) { /* 已结束或宿主不支持 */ }
                throw e3;
            }
            let payload;
            try { payload = JSON.parse(r && r.result && r.result.value); } catch (e2) {
                throw new Error('CDP 代理执行返回异常: ' + JSON.stringify(r && r.result).slice(0, 200));
            }
            if (payload.__error) throw new Error(payload.__error);
            const v = payload.__value;
            // S3 收尾（bug-hunt 核心要求）：慢路径命中了令牌"输家"标记 → 副作用已由另一条路径执行，
            // 回等快路径的真实结果（有界 5s）；仍不落地则把"冻结标签永不 settle"收成一个可读错误
            // （否则调用方会把标记对象当成功结果）
            if (v && typeof v === 'object' && v.__adbDupSkipped) {
                try {
                    return await withHardTimeout(fastPromise, 5000, '__adb_gap_timeout__');
                } catch (gapErr) {
                    throw new Error('操作已在页面内执行但结果不可读（双路径竞态 + 标签被节流）——勿直接重试，先用 get_page_info / get_semantic_dom / take_screenshot 核对是否已生效');
                }
            }
            return [{ result: v, frameId: 0 }];
        });
    }
}

async function anonFetch({ url, method = 'GET', body = null, timeout = 15000, tabId, authHeaders = null } = {}) {
    if (!url) {
        throw new Error('缺少 url 参数');
    }
    const httpMethod = (method || 'GET').toUpperCase();
    // V4.9.22（修复🔴，审计补充）：写方法**任何页面侧出口都不降级重发**。
    // 审计指出首版修复只挡住了 4 个出口中的 1 个——注入抛错/超时（catch 分支）、注入成功但 result
    // 为空、以及下游 server 侧兜底（helpers.ts 的 anonFetchWithServerFallback 在 status===0 时
    // 无条件重发，那处已同步加 method 判断）——三个合起来，一个 POST 最多被真实发出 3 次。
    // 本 helper 供各出口统一返回"未执行/未回读 + 副作用警示"，**刻意不带 status 字段**：
    // 补 status:0 会命中 server 侧兜底条件反而触发重发（判定层已特判 sideEffectWarning，见 helpers.ts）。
    const isReadOnlyMethod = /^(GET|HEAD)$/i.test(httpMethod);
    const pageSideUnresolved = (why) => ({
        error: `页面上下文请求${why}，且**未**自动降级——写方法（${httpMethod}）不重发以防重复副作用`,
        url, method: httpMethod, via: 'page_context',
        sideEffectWarning: '服务端**可能已受理**本次写请求——勿直接重试；先用查询接口核对是否已生效'
    });
    if (!['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'].includes(httpMethod)) {
        throw new Error(`不支持的 HTTP 方法: ${method}`);
    }

    // ===== V4.9.11（实站实测 app.example.com 驱动）：优先走目标站点的**页面上下文** =====
    // 扩展 SW 的网络栈不共享用户对该站点的证书例外——实测：目标证书 altname 不匹配时
    // （服务器返回 *.example.com 的证书，访问的是 app.example.com），页面内 fetch 正常返回 200 JSON，
    // 而 SW fetch 一律 "Failed to fetch" → 全部匿名测试（unauthorized_sweep /
    // batch_unauthorized_api / smart_unauthorized_test）在证书异常站点上整体失效，
    // 而证书异常在生产环境很常见（配置错误/自签/内网系统/国产 CA）。
    // 页面上下文还顺带消除跨域限制，语义上也更贴近"真实浏览器匿名访问"。
    const reqBody = (body && httpMethod !== 'GET' && httpMethod !== 'HEAD')
        ? (typeof body === 'string' ? body : JSON.stringify(body))
        : null;
    // V4.9.11（黑盒实测驱动）：可选的**认证态注入**——渗透中"拿到一个 token"常是攻击链的第一环
    // （未授权注册/接口泄露/爆破），拿到后应能立刻做系统化测试。注意 credentials 仍为 omit
    // （不带 cookie），只靠显式头表达身份，语义清晰：这是"纯 token 视角"而非"浏览器登录态视角"
    const sendHeaders = { 'Accept': 'text/html,application/json,*/*' };
    if (reqBody) sendHeaders['Content-Type'] = 'application/json';
    if (authHeaders && typeof authHeaders === 'object') {
        for (const [k, v] of Object.entries(authHeaders)) {
            if (typeof k === 'string' && k && typeof v === 'string') sendHeaders[k] = v;
        }
    }
    let hostTab = null;
    try {
        const target = new URL(url);
        hostTab = typeof tabId === 'number'
            ? await resolveTab({ tabId }, true)
            : await resolveTab({ hostname: target.hostname }, true);
        // V4.9.11（验收修复 A14）：显式指定的 tabId 若与目标 URL **不同源**，页面上下文 fetch
        // 会被 CORS 拦（"Failed to fetch"），而下面的 r.error 分支是**不回退 SW** 的
        // （SW 网络栈不受 CORS 限制，本可成功）→ 只能白白失败。故不同源时直接弃用页面上下文
        if (hostTab && typeof tabId === 'number') {
            try {
                if (new URL(hostTab.url).hostname !== target.hostname) hostTab = null;
            } catch (e2) { /* hostTab.url 异常则维持原样 */ }
        }
    } catch (e) {
        // V4.9.11（验收修复 A14）：显式传的 tabId 无效时**如实抛错**，不再静默吞成 null——
        // resolveTab 对不存在的标签会抛"指定的标签页 N 不存在或已关闭"，原实现 catch 后置 null，
        // 调用方只能看到笼统失败，无法自查是参数写错还是网络问题
        if (typeof tabId === 'number') throw e;
        hostTab = null;
    }
    if (hostTab) {
        try {
            // V4.9.11（验收修复 S4）：整体包 withHardTimeout——chrome.scripting.executeScript 对
            // 睡眠冻结/导航中的标签 Promise **永不 settle**（本文件 830-832、1776-1778 行有实测记录），
            // 而上面 resolveTab 用了 noActivate=true、绕过了 ensureTabAwake 的解冻。原实现无超时 →
            // 目标标签冻结时每条请求挂死 30s+ 且永不回退 SW fetch，unauthorized_sweep /
            // batch_unauthorized_api 整批瘫痪。超时抛错后由下方 catch 落到 SW fetch 兜底
            const injected = await withHardTimeout(adbExecuteScript({
                target: { tabId: hostTab.id },
                world: 'ISOLATED',   // 隔离世界：同样走页面网络栈，且不受页面自身 fetch hook 干扰
                args: [url, httpMethod, reqBody, timeout, sendHeaders],
                func: async (u, m, b, t, h) => {
                    const controller = new AbortController();
                    const timer = setTimeout(() => controller.abort(), t);
                    try {
                        const opts = {
                            method: m,
                            credentials: 'omit',    // 匿名视角（不带任何 cookie；认证态靠显式头表达）
                            // V4.9.11（验收修复 A11）：manual → follow。fetch 规范下 'manual' 返回
                            // opaqueredirect（status=0、location 不可读），实测把真实 302 全报成
                            // "网络错误"，服务端"302 跳登录页 → ENFORCED"规则永不触发。
                            // follow 后可拿到 redirected + 最终 URL，判定引擎据此识别登录跳转
                            redirect: 'follow',
                            headers: h || { 'Accept': 'text/html,application/json,*/*' },
                            signal: controller.signal
                        };
                        if (b) opts.body = b;
                        const resp = await fetch(u, opts);
                        let bodyText = '';
                        let bodyReadError = '';
                        try { bodyText = await resp.text(); } catch (e) { bodyReadError = String((e && e.message) || e); }
                        return {
                            ok: true,
                            status: resp.status,
                            redirected: !!resp.redirected,   // A11：是否发生过重定向
                            finalUrl: resp.url || '',        // A11：重定向终点（判定是否跳登录页）
                            contentType: resp.headers.get('content-type') || '',
                            location: resp.headers.get('location') || '',
                            // V4.9.28：读体失败必须留标记——原实现静默忽略，于是 bodySize:0 /
                            // bodySample:'' 与"响应体本来就是空"完全同形，judgeUnauthorized 会落到
                            // 规则7 报"可能是 SPA 空壳"（把"没读到"错误归因成"内容少"，AI 据此放弃深挖）。
                            ...(bodyReadError ? { bodyReadError } : {}),
                            // V4.9.24（清单🟡-14）：**单位是字符（UTF-16 code unit），不是字节**——
                            // 服务端 `judgeUnauthorized` 的证据文案原先误写作"字节"（已同步改正）。
                            // 消费该字段时按"字符"理解：中文响应下真实字节数约为其 3 倍
                            bodySize: bodyText.length,
                            bodySample: bodyText.slice(0, 8000)
                        };
                    } catch (e) {
                        return { ok: false, error: (e && e.name === 'AbortError') ? '请求超时' : String((e && e.message) || e) };
                    } finally {
                        clearTimeout(timer);
                    }
                }
            }), timeout + 3000, '页面上下文注入超时（标签可能被冻结/导航中），已回退 SW 网络栈');
            const r = injected && injected[0] && injected[0].result;
            if (r && r.ok) {
                const sensPattern = /"(?:user|username|email|phone|mobile|token|jwt|session|password|idcard|card|account|nickname|openid|realName)"\s*:\s*"[^"]{1,200}"/gi;
                return {
                    url, status: r.status, contentType: r.contentType, location: r.location,
                    redirected: !!r.redirected, finalUrl: r.finalUrl || '',   // A11：重定向观测
                    bodySize: r.bodySize, bodySample: r.bodySample,
                    sensitiveHits: (r.bodySample.match(sensPattern) || []).slice(0, 10),
                    anonymous: true, via: 'page_context'
                };
            }
            if (r && r.error) {
                // 页面侧失败降级到 SW fetch —— **只对只读方法**。
                // 写方法（POST/PUT/DELETE/PATCH）失败时**服务端可能已受理**（超时/中断尤甚），
                // 这里无条件重发＝重复增删改，而调用方毫不知情；那与本项目 SIDE_EFFECT_CMDS 的
                // "超时≠未发生、勿直接重试"纪律直接矛盾（工具不该替 AI 重试）。
                // 为什么只读方法要降级、不降级什么后果 → INTERNALS.md「anonFetch 的降级重发」。
                if (!isReadOnlyMethod) return pageSideUnresolved('失败（' + r.error + '）');
                console.warn('[MCP Client] 页面上下文请求失败，降级 SW fetch:', r.error);
                // 不 return，落到下方 SW fetch
            } else if (!(r && r.ok) && !isReadOnlyMethod) {
                // V4.9.22（审计补充 + 复验⚪收口）：注入成功但**没有结果对象**（脚本被页面拦截/返回
                // undefined），或返回了"既无 ok 也无 error"的异形对象——原实现这些情况两分支都不进
                // → 静默落到 SW fetch 重发。用 `!(r && r.ok)` 覆盖全部非成功形态（复验指出
                // 首版 `!r` 只挡了"空值"，留了一个理论口子）
                return pageSideUnresolved('未返回成功结果');
            }
        } catch (e) {
            // 注入失败（受限页面/权限）→ 只读方法退回下方 SW fetch；
            // V4.9.22（审计补充）：**写方法不退回**（页面侧可能仍在飞、服务端可能已受理）
            if (!isReadOnlyMethod) return pageSideUnresolved('执行异常（' + ((e && e.message) || String(e)) + '）');
        }
    }

    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);

        // method 参数支持 PUT/POST/DELETE/PATCH：写操作未授权（越权增删改）同样可测
        const fetchOptions = {
            method: httpMethod,
            credentials: 'omit', // 匿名视角（不带任何 cookie；认证态靠显式头表达）
            // V4.9.11（验收修复 A11）：manual → follow，与页面路径保持一致。
            // 实测 manual 对真实 302 返回 opaqueredirect（status=0），被服务端判成"网络错误"
            redirect: 'follow',
            headers: sendHeaders,   // Accept + 可选 Content-Type + 可选认证头（V4.9.11）
            signal: controller.signal
        };
        if (reqBody) fetchOptions.body = reqBody;
        const resp = await fetch(url, fetchOptions);
        clearTimeout(timer);

        const status = resp.status;
        const contentType = resp.headers.get('content-type') || '';
        const location = resp.headers.get('location') || '';

        // 只取前 8KB 用于判定
        let bodySample = '';
        let bodySize = 0;
        let bodyReadError = '';
        try {
            const text = await resp.text();
            bodySize = text.length;
            bodySample = text.slice(0, 8000);
        } catch (e) {
            // V4.9.28：读体失败必须留标记（同 anonFetch 页面分支）——静默忽略会让
            // bodySize:0/bodySample:'' 与"响应体本来就是空"同形，判定层错误归因
            bodyReadError = String((e && e.message) || e);
        }

        // 敏感字段启发式命中
        const sensPattern = /"(?:user|username|email|phone|mobile|token|jwt|session|password|idcard|card|account|nickname|openid|realName)"\s*:\s*"[^"]{1,200}"/gi;
        const sensitiveHits = (bodySample.match(sensPattern) || []).slice(0, 10);

        return {
            url,
            status,
            contentType,
            location,
            redirected: !!resp.redirected,   // A11：是否发生过重定向
            finalUrl: resp.url || '',        // A11：重定向终点（判定是否跳登录页）
            ...(bodyReadError ? { bodyReadError } : {}),   // V4.9.28：同 anonFetch 页面分支
            bodySize,
            bodySample,
            sensitiveHits,
            anonymous: true // SW fetch 不带 cookie
        };
    } catch (e) {
        return {
            url,
            status: 0,
            error: e.name === 'AbortError' ? '请求超时' : (e.message || String(e)),
            anonymous: true,
            // V4.9.22（复验⚪）：写方法在 SW 侧失败时同样给副作用提示——请求确实只发了一次（无重复），
            // 但"服务端可能已受理"的语义与该纪律对齐，且判定层（helpers.ts judgeUnauthorized）会据此
            // 输出 UNCLEAR + 完整证据，而不是笼统的"网络错误"（AI 就少了手工重跑的风险）
            ...(!isReadOnlyMethod ? { sideEffectWarning: '服务端**可能已受理**本次写请求——勿直接重试；先用查询接口核对是否已生效' } : {})
        };
    }
}

// Nuxt /_payload.json 探测（CVE-2026-71316 类：Nuxt 运行时 payload 缓存泄露）
// 关键：service worker 中的 fetch 不携带页面 cookie —— 天然匿名请求，
// 正好用来验证"未认证用户能否读到 SSR payload"
async function nuxtPayloadProbe({ paths = [], waitMs = 300, tabId, hostname } = {}) {
    const tab = await requireTab({ tabId, hostname });

    const origin = new URL(tab.url).origin;
    const results = [];

    for (const p of paths) {
        // V4.9.12（实测 ui.nuxt.com 驱动）：**先规范化再拼 URL**——原实现对入参直接拼 `/_payload.json`，
        // 当 path 带尾斜杠时（**包括根路径 '/'**）候选一变成 `//_payload.json` 形式的坏 URL，而候选二
        // 指向**同一资源** → 同一资源被探测两次、结果里出现重复条目（实测根路径返回两条一模一样的
        // 结果，还白等一个 waitMs）。Nuxt 的 payload 端点只有 `{路由}/_payload.json` 一种形态，
        // 规范化后单候选即可全覆盖：`/`、`/docs`、`/docs/` 分别得到 `/_payload.json`、
        // `/docs/_payload.json`、`/docs/_payload.json`。
        const norm = ('/' + String(p).replace(/^\/+/, '')).replace(/\/+$/, '');
        const urls = [`${origin}${norm}/_payload.json`];

        for (const url of urls) {
            try {
                // SW fetch：无 cookie、无认证头 → 未认证视角
                const resp = await fetch(url, {
                    method: 'GET',
                    credentials: 'omit',
                    headers: { 'Accept': 'application/json' }
                });

                const status = resp.status;
                let bodySample = '';
                let bodySize = 0;
                let sensitiveHits = [];

                if (status === 200) {
                    const text = await resp.text();
                    bodySize = text.length;
                    bodySample = text.slice(0, 500);

                    // 敏感字段启发式
                    const sensPattern = /"(user|email|phone|token|jwt|session|password|idcard|mobile|nickname|openid)"\s*:\s*"[^"]{1,200}"/gi;
                    const m = text.match(sensPattern);
                    if (m) sensitiveHits = m.slice(0, 10);
                }

                results.push({
                    path: norm || '/',   // 根路径规范化后为空串，展示时还原成 '/'
                    url,
                    status,
                    bodySize,
                    bodySample,
                    sensitiveHits,
                    verdict: status === 200 && bodySize > 50
                        ? '⚠️ 匿名可读 payload（潜在数据泄露，结合页面上下文确认是否含跨用户数据）'
                        : (status === 200 ? '匿名可访问但内容极少（可能是空缓存）' : `HTTP ${status}（未匿名泄露）`)
                });
            } catch (e) {
                results.push({ path: norm || '/', url, status: 0, error: e.message || String(e) });
            }
            // 节流，避免打爆目标
            await new Promise(r => setTimeout(r, waitMs));
        }
    }

    return { probeType: 'nuxt_payload', totalPaths: paths.length, results };
}

// 获取Hook数据
// V4.9.23（缺陷🟡-2 配套）：支持按 tabId 过滤。record 现在带 tabId 归属，但**窗口是在过滤前截的**
// ——不加过滤时，一个话痨的后台标签页能把目标站的记录整个挤出 limit 窗口（AI 看到的是"目标页没数据"）
async function getHookData({ scriptId, limit = 50, clear = false, tabId } = {}) {
    let data = [...hookDataBuffer];

    if (scriptId) {
        data = data.filter(d => d.scriptId === scriptId);
    }

    if (typeof tabId === 'number') {
        data = data.filter(d => d.tabId === tabId);
    }

    if (clear) {
        if (scriptId || typeof tabId === 'number') {
            // 清掉的正好是本函数刚刚返回的那批（scriptId/tabId 条件与上方过滤一致）
            hookDataBuffer = hookDataBuffer.filter(d =>
                !((!scriptId || d.scriptId === scriptId) && (typeof tabId !== 'number' || d.tabId === tabId))
            );
        } else {
            hookDataBuffer = [];
        }
        // 同步清空 session 镜像，防止 SW 重启后恢复出已清除的数据
        schedulePersistBuffers();
    }
    
    return data.slice(-limit);
}

// 获取已启用的脚本
async function getEnabledScripts({ tabId, hostname: targetHostname } = {}) {
    const tab = await resolveTab({ tabId, hostname: targetHostname }, true);
    if (!tab || !tab.url) {
        return { enabledScripts: [], mode: 'unknown' };
    }
    
    const hostname = new URL(tab.url).hostname;
    
    return new Promise((resolve) => {
        chrome.storage.local.get(['antidebug_mode', 'global_scripts', hostname], (result) => {
            const mode = result.antidebug_mode || 'standard';
            let enabledScripts;
            
            if (mode === 'global') {
                enabledScripts = result.global_scripts || [];
            } else {
                enabledScripts = result[hostname] || [];
            }
            
            resolve({
                mode,
                hostname,
                enabledScripts
            });
        });
    });
}

// 切换脚本启用状态
async function toggleScript({ scriptId, enabled, tabId, hostname: targetHostname } ) {
    const tab = await requireTab({ tabId, hostname: targetHostname });
    
    const hostname = new URL(tab.url).hostname;
    
    const cfgKey = `${scriptId}_config`;
    return new Promise((resolve, reject) => {
        chrome.storage.local.get(['antidebug_mode', 'global_scripts', hostname, cfgKey], (result) => {
            const mode = result.antidebug_mode || 'standard';
            let enabledScripts;
            let storageKey;
            
            if (mode === 'global') {
                enabledScripts = result.global_scripts || [];
                storageKey = 'global_scripts';
            } else {
                enabledScripts = result[hostname] || [];
                storageKey = hostname;
            }
            
            if (enabled) {
                if (!enabledScripts.includes(scriptId)) {
                    enabledScripts.push(scriptId);
                }
            } else {
                enabledScripts = enabledScripts.filter(id => id !== scriptId);
            }
            
            // V4.9.38（批 3 审计 S-R4 🔴）：启用时必须确保 `<scriptId>_config` 存在——
            // content.js 用 `if (config)` 门控 HOOK_CONFIG_READY 与 localStorage 配置同步，
            // 原实现只写启用列表，于是经 MCP 的 toggle_script / batch_enable_scripts 启用的
            // 21 个 config-gated Hook 永不初始化（工具却回 success:true）。
            // 与 popup 的 handleHookScriptToggle 同构补一份最小默认配置；已存在则不动（保留用户配置）。
            const writePayload = { [storageKey]: enabledScripts };
            if (enabled && !result[cfgKey]) {
                writePayload[cfgKey] = {
                    param: [],                    // has_Param 脚本的关键字列表（空 = 不过滤）
                    keyword_filter_enabled: false,
                    flag: 0,                      // 0 = 记录全部（hook 脚本的 else 分支才是过滤模式）
                    debugger: 0,
                    stack: 0,
                    value: '0'                    // fixed_variate 脚本初值（hook_random/Hook_Date_now 默认即 0）
                };
            }
            chrome.storage.local.set(writePayload, async () => {
                // V4.9.30：改为**直接调用并 await** registerScripts——本文件经 importScripts 与
                // background.js 同处一个 SW 全局作用域（见本文件 L307 的说明），registerScripts
                // 是它的顶层函数，可直接调用。
                // 原实现发 sendMessage，注释自承是"死消息"（sendMessage 不投递给发送者所在上下文），
                // 真正的注册靠 background 的 storage.onChanged 兜底；而那条兜底要求 key 含 '.'
                //（background.js:276/314），**hostname 不含点（localhost、内网单标签名）时两边都
                // 不注册，却仍 resolve success:true**——正是本项目反复在修的"假成功"。
                // 与 V4.9.11 修请求头那次是同一个坑：那次只补了请求头一条路径，这三条漏了。
                let registration;
                try {
                    await registerScripts(mode === 'global' ? '*' : hostname, enabledScripts, mode === 'global');
                    registration = { ok: true };
                } catch (e) {
                    registration = { error: String((e && e.message) || e) };
                }
                resolve({
                    success: true,
                    scriptId,
                    enabled,
                    enabledScripts,
                    registration
                });
            });
        });
    });
}

// 新建标签页（V4.9.39）：此前只能改已有标签，没有"开新标签"能力。
// 用途：多标签并行测试、拖拽/滑块类验证需要干净页面、避免改动用户正在用的标签。
// V4.9.40（独立验收 Y3）：**必须给 url**——默认 about:blank 是死路：
// resolveTab 只接受 http(s)，navigate_to 等页面工具接不上，而且当前没有 close_tab 可关。
async function newTab({ url, active = false } = {}) {
    if (!url) {
        throw new Error('new_tab 必须提供 url（V4.9.40 验收：about:blank 标签不会被页面工具接管——resolveTab 只接受 http(s)，且没有 close_tab 可关，只能手动关）');
    }
    const target = String(url);
    // 只允许 http(s) / file——防误传 javascript:/about:blank 等 scheme
    //（chrome.tabs.create 本身会拒绝，但错误信息不直观；这里提前给可读报错）
    if (!/^(https?:\/\/|file:\/\/)/i.test(target)) {
        throw new Error('new_tab 只接受 http(s):// 或 file:// 的 URL（收到: ' + target.slice(0, 80) + '）');
    }
    const tab = await chrome.tabs.create({ url: target, active: !!active });
    return {
        success: true,
        tabId: tab.id,
        url: tab.url || target,
        pendingUrl: tab.pendingUrl || '',
        active: !!active,
        note: '页面加载是异步的——紧接着操作前先 get_page_info/wait_for_selector 确认已就绪'
    };
}

// 标签页管理（V4.9.41，对齐 chrome-devtools 的 list_pages/select_page/close_page）：
// 此前只有 new_tab——测试完的标签关不掉、多标签测试看不到全貌（FINDINGS.manual M-15 记录）。
async function tabManage({ action, tabId, index } = {}) {
    const snap = async (id) => {
        try { const t = await chrome.tabs.get(id); return { tabId: t.id, url: t.url || t.pendingUrl || '', title: (t.title || '').slice(0, 120), active: !!t.active }; }
        catch (e) { return null; }
    };
    if (action === 'list') {
        const tabs = await chrome.tabs.query({});
        return {
            success: true,
            count: tabs.length,
            tabs: tabs.map(t => ({
                tabId: t.id, url: t.url || t.pendingUrl || '', title: (t.title || '').slice(0, 120),
                active: !!t.active, windowId: t.windowId, status: t.status || ''
            })),
            note: 'select/close 用 tabId 或 index（本列表下标）'
        };
    }
    let targetId = tabId;
    if (targetId === undefined && index !== undefined) {
        const tabs = await chrome.tabs.query({});
        if (!tabs[index]) throw new Error(`index ${index} 超出范围（当前共 ${tabs.length} 个标签，先 action=list 看清单）`);
        targetId = tabs[index].id;
    }
    if (targetId === undefined) throw new Error('select/close 需要 tabId 或 index（先 action=list）');
    if (action === 'select') {
        const before = await chrome.tabs.get(targetId);
        await chrome.tabs.update(targetId, { active: true });
        try { await chrome.windows.update(before.windowId, { focused: true }); } catch (e) { /* 忽略 */ }
        return { success: true, action, tab: await snap(targetId) };
    }
    if (action === 'close') {
        const before = await snap(targetId);
        await chrome.tabs.remove(targetId);
        return { success: true, action, closed: before };
    }
    throw new Error(`未知 action: ${String(action)}（支持 list / select / close）`);
}

// 页面 console 捕获（V4.9.41，对齐 chrome-devtools 的 list_console_messages）：
// 注入 console.* 捕获器 → start/read/clear。与 get_console_messages（hook 桥，**只含命中关键词且 ≤4000 字符**）
// 互补：本工具是全量，但**注入时刻之前**的日志拿不到（DevTools 协议本身也只从监听时刻开始）。
async function consoleLog({ action = 'read', limit = 200, tabId, hostname } = {}) {
    const tab = await requireTab({ tabId, hostname });
    // 双执行守卫（test_double_exec 要求）：快慢路径竞态会重复执行注入 → console 被覆盖两层、
    // 日志重复记录。令牌保证同一次 action 只装一次钩子。
    const dupTok = '__adbcl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const injectFn = (__tok) => {
        if (window[__tok]) return { __adbDupSkipped: true };
        try { window[__tok] = 1; } catch (e) { /* window 冻结：fail-open */ }
        if (window.__ADB_CONSOLE_HOOKED) return { already: true, count: (window.__ADB_CONSOLE || []).length };
        window.__ADB_CONSOLE = [];
        window.__ADB_CONSOLE_HOOKED = true;
        var fmt = function (a) { try { return typeof a === 'string' ? a : JSON.stringify(a); } catch (e) { return String(a); } };
        ['log', 'info', 'warn', 'error', 'debug'].forEach(function (lv) {
            var orig = console[lv] ? console[lv].bind(console) : function () { };
            console[lv] = function () {
                try {
                    var args = Array.prototype.slice.call(arguments);
                    window.__ADB_CONSOLE.push({ level: lv, ts: Date.now(), msg: args.map(fmt).join(' ').slice(0, 2000) });
                    if (window.__ADB_CONSOLE.length > 1000) window.__ADB_CONSOLE.shift();
                } catch (e) { /* 忽略 */ }
                return orig.apply(console, arguments);
            };
        });
        return { hooked: true };
    };
    if (action === 'start') {
        const r = await adbExecuteScript({ target: { tabId: tab.id }, func: injectFn, args: [dupTok], world: 'MAIN' });
        return { success: true, action, result: (r && r[0] && r[0].result) || null, note: '已开始捕获；用 action=read 读日志、action=clear 清空' };
    }
    if (action === 'clear') {
        const r = await adbExecuteScript({
            target: { tabId: tab.id }, world: 'MAIN',
            func: () => { const n = (window.__ADB_CONSOLE || []).length; window.__ADB_CONSOLE = []; return { cleared: n }; }
        });
        return { success: true, action, result: (r && r[0] && r[0].result) || null };
    }
    // read（默认）
    const r = await adbExecuteScript({
        target: { tabId: tab.id },
        func: (lim) => {
            const hooked = !!window.__ADB_CONSOLE_HOOKED;
            const all = window.__ADB_CONSOLE || [];
            return { hooked: hooked, total: all.length, logs: all.slice(-lim) };
        },
        args: [Math.max(1, Math.min(1000, Number(limit) || 200))],
        world: 'MAIN'
    });
    const data = (r && r[0] && r[0].result) || { hooked: false, total: 0, logs: [] };
    let autoStarted = false;
    if (!data.hooked) {
        try { await adbExecuteScript({ target: { tabId: tab.id }, func: injectFn, args: [dupTok], world: 'MAIN' }); autoStarted = true; } catch (e) { /* 忽略 */ }
    }
    return {
        success: true, action: 'read',
        total: data.total, returned: data.logs.length, logs: data.logs,
        coverage: autoStarted ? 'capture-installed-now' : 'capture-active',
        note: '注入时刻**之前**的 console 日志拿不到（浏览器协议限制）。要看完整早期日志：先 action=start 再刷新页面'
    };
}

// 导航到URL（V4.9.41 扩展：action = url / back / forward / reload——对齐 chrome-devtools 的 navigate_page）
async function navigateTo({ url, action = 'url', tabId, hostname }) {
    const tab = await requireTab({ tabId, hostname });
    const curUrl = async () => { try { const t = await chrome.tabs.get(tab.id); return t.url || t.pendingUrl || ''; } catch (e) { return ''; } };
    if (action === 'back') { await chrome.tabs.goBack(tab.id); return { success: true, action, url: await curUrl() }; }
    if (action === 'forward') { await chrome.tabs.goForward(tab.id); return { success: true, action, url: await curUrl() }; }
    if (action === 'reload') { await chrome.tabs.reload(tab.id); return { success: true, action, url: await curUrl() }; }
    if (action !== 'url') throw new Error(`未知 action: ${String(action)}（支持 url / back / forward / reload）`);
    if (!url) throw new Error('action=url 时必须提供 url（back/forward/reload 不需要）');

    // 如果是相对路径，拼接完整URL
    let targetUrl = url;
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
        const currentUrl = new URL(tab.url);
        if (url.startsWith('/')) {
            targetUrl = currentUrl.origin + url;
        } else if (url.startsWith('#')) {
            targetUrl = currentUrl.origin + currentUrl.pathname + url;
        } else {
            targetUrl = currentUrl.origin + '/' + url;
        }
    }

    await chrome.tabs.update(tab.id, { url: targetUrl });
    return { success: true, action: 'url', url: targetUrl };
}

// 获取Cookie（chrome.cookies API 天然包含 httpOnly Cookie）
async function getCookies({ name, httpOnly = false, tabId, hostname } = {}) {
    // V4.9.8：noActivate——仅用 tab.url 经 cookies API 查询，无需页面操作/焦点
    const tab = await requireTab({ tabId, hostname }, true);

    const url = new URL(tab.url);
    const cookies = await chrome.cookies.getAll({ domain: url.hostname });

    let result = cookies.map(c => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        expires: c.expirationDate,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: c.sameSite // no_restriction / lax / strict / unspecified
    }));

    if (httpOnly) {
        result = result.filter(c => c.httpOnly === true);
    }

    if (name) {
        result = result.filter(c => c.name.includes(name));
    }

    return result;
}

// 获取LocalStorage
async function getLocalStorage({ key, tabId, hostname } = {}) {
    // V4.9.12：改走 CDP executeScript 封装——chrome.scripting.executeScript 对部分 tab 状态
    // 永不 settle（V4.7 根治的漏网残余，zb 实测挂 30s），localStorage 在 MAIN world 可读
    const filterKey = key || '';
    const result = await executeScript({
        code: `(function(){const out={};for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i);if(!${JSON.stringify(filterKey)}||k.includes(${JSON.stringify(filterKey)})){out[k]=localStorage.getItem(k);}}return out;})()`,
        world: 'MAIN', tabId, hostname
    });
    return typeof result === 'string' ? JSON.parse(result) : (result || {});
}

// 获取SessionStorage
async function getSessionStorage({ key, tabId, hostname } = {}) {
    // V4.9.12：同 getLocalStorage——迁 CDP executeScript 封装
    const filterKey = key || '';
    const result = await executeScript({
        code: `(function(){const out={};for(let i=0;i<sessionStorage.length;i++){const k=sessionStorage.key(i);if(!${JSON.stringify(filterKey)}||k.includes(${JSON.stringify(filterKey)})){out[k]=sessionStorage.getItem(k);}}return out;})()`,
        world: 'MAIN', tabId, hostname
    });
    return typeof result === 'string' ? JSON.parse(result) : (result || {});
}

// 执行脚本
async function executeScript({ code, world = 'MAIN', tabId, hostname }) {
    const tab = await requireTab({ tabId, hostname });

    // V4.7.1：统一走 CDP Runtime.evaluate——executeScript API 对部分 tab 状态
    // （睡眠冻结/导航中/frozen）Promise 永不 settle（实测挂 40s+，MAIN/ISOLATED 双中招），
    // CDP 通道（take_screenshot/real_click 同源）长期稳定。
    // ISOLATED 亦走 MAIN：localStorage/sessionStorage/DOM 均共享，无行为差异（除 content-script 专有 API，本工具未用）
    if (world === 'MAIN' || world === 'ISOLATED') {
        return withDebugger(tab.id, async () => {
            const expression = `(async function(){try{const __adb_r = await eval(${JSON.stringify(code)});return JSON.stringify({__adb:true,__value:__adb_r===undefined?null:__adb_r});}catch(e){return JSON.stringify({__adb:true,__error:String((e&&e.message)||e)});}})()`;
            // V4.9.11（验收修复 A12）：`Runtime.evaluate` 带 awaitPromise 却**没有超时**——
            // 注入 `await new Promise(()=>{})`（等事件/条件满足的测试代码很常见）会让 evaluate
            // 永不返回 → withDebugger 的 finally 永不执行 → 该 tab 的 CDP 计数永久 +1；
            // 用户点掉调试横幅后 onDetach 只回收 debugSessionTabs 那一份，**幽灵计数无任何回收路径**
            // （调试横幅常驻，每次挂起注入再累加一次）。此处加硬超时，并在超时后终止页面内执行。
            // 25s 略早于服务端 30s，保证调用方拿到的是这条明确原因而非笼统的服务端超时
            let r;
            try {
                r = await withHardTimeout(cdpSend(tab.id, 'Runtime.evaluate', {
                    expression,
                    returnByValue: true,
                    awaitPromise: true,
                    userGesture: true
                }), 25000, '代码执行超时（页面内 await 未返回，例如 await new Promise(()=>{})）——已终止等待并释放调试计数');
            } catch (e) {
                // 超时后主动终止页面内仍在跑的执行，避免那个 await 一直挂着
                try { await cdpSend(tab.id, 'Runtime.terminateExecution'); } catch (e2) { /* 已结束或宿主不支持则忽略 */ }
                // 2026-10-13（学习通实站驱动）：页面导航/加载中时，注入执行上下文已随旧页面销毁——
                // 表现为超时或 "Cannot read properties of null" 类错误，AI 无从判断原因。
                // 从扩展侧 API 取 tab status（纯扩展调用，不注入页面，导航中也能用）给出可读提示
                let navHint = '';
                try {
                    const t = await chrome.tabs.get(tab.id);
                    if (t && t.status === 'loading') {
                        navHint = '当前标签页正在导航/加载中（tab status=loading）——执行上下文可能已随旧页面销毁，建议等待加载完成（2-3 秒或先 wait_for_selector）后重试';
                    }
                } catch (e3) { /* tabs.get 失败（tab 已关等）则不加提示 */ }
                throw navHint ? new Error(`${navHint}。原错误：${(e && e.message) || e}`) : e;
            }
            let payload;
            try { payload = JSON.parse(r && r.result && r.result.value); } catch (e) {
                throw new Error('CDP 执行返回异常: ' + JSON.stringify(r && r.result).slice(0, 200));
            }
            if (payload.__error) throw new Error(payload.__error);
            return payload.__value;
        });
    }

    return new Promise((resolve, reject) => {
        adbExecuteScript({
            target: { tabId: tab.id },
            func: (jsCode) => {
                try {
                    return eval(jsCode);
                } catch (e) {
                    return { error: e.message };
                }
            },
            args: [code],
            world: world
        }).then(results => {
            resolve(results[0]?.result);
        }).catch(reject);
    });
}

// 获取DOM信息
async function getDOMInfo({ selector = 'body', depth = 3, tabId, hostname } = {}) {
    const tab = await requireTab({ tabId, hostname });
    
    return new Promise((resolve, reject) => {
        adbExecuteScript({
            target: { tabId: tab.id },
            func: (sel, maxDepth) => {
                function getElementInfo(el, currentDepth) {
                    if (currentDepth > maxDepth) return null;
                    
                    const info = {
                        tag: el.tagName.toLowerCase(),
                        id: el.id || undefined,
                        // V4.9.36：SVG 元素的 className 是 **SVGAnimatedString 对象**，不是字符串——
                        // 原写法 `el.className ? el.className.split(' ')` 在对它调 .split 时抛
                        // TypeError，整个注入函数炸掉。深度内只要有一个 SVG（图标/logo 极常见）就中招，
                        // 实测在真实站点上 100% 复现。正确写法项目里本就有（见 getSemanticDom 的
                        // describeNode / resolveInteractionTarget），此处照抄，不再另创。
                        classes: (typeof el.className === 'string' && el.className) ? el.className.split(' ').filter(c => c) : undefined,
                        text: el.childNodes.length === 1 && el.childNodes[0].nodeType === 3
                            ? el.textContent.trim().substring(0, 100)
                            : undefined
                    };
                    
                    if (currentDepth < maxDepth && el.children.length > 0) {
                        info.children = Array.from(el.children)
                            .slice(0, 20) // 限制子元素数量
                            .map(child => getElementInfo(child, currentDepth + 1))
                            .filter(c => c);
                    }
                    
                    return info;
                }
                
                const element = document.querySelector(sel);
                if (!element) {
                    return { error: `未找到元素: ${sel}` };
                }
                
                return getElementInfo(element, 0);
            },
            // V4.9.36：补 world:'MAIN' —— 这是 38 个 adbExecuteScript 调用点里**唯一漏掉**的一处。
            // 后果不是"少个参数"，是**该工具彻底不可用**：快路径（chrome.scripting，缺省 ISOLATED）
            // 一旦超时（冻结/节流标签实测必超时 8s），慢路径按 effWorld 判定拒绝执行——
            // 报 "ISOLATED 慢路径不支持"，而其余 37 个调用点都能落到 CDP 慢路径活下来。
            // 实测：同一标签同一时刻，本工具 8004ms 报错，而 get_element_info / get_page_forms
            // 都是 8020ms 拿到正确数据。
            // 选 'MAIN' 而非"ISOLATED + MAIN 兜底"：DOM 在两个世界共享，读 DOM 无隔离损失；
            // 且项目内所有 DOM 读取类调用点（getElementInfo/getSemanticDom/getPageForms）一致用 'MAIN'。
            world: 'MAIN',
            // V4.9.36：原为 `depth || 3`——传 depth:0（"只要这个元素、不要子节点"，合法用法）
            // 会被静默改成 3。改用 ?? 后 0 得以保留（服务端已默认 3，undefined 仍得 3）。
            args: [selector || 'body', depth ?? 3]
        }).then(results => {
            resolve(results[0]?.result);
        }).catch(reject);
    });
}

// 配置Hook
async function configureHook({ scriptId, config }) {
    const hookConfig = {};
    
    if (config.keywords) {
        hookConfig.param = config.keywords;
        hookConfig.flag = config.keywords.length > 0 ? 1 : 0;
        hookConfig.keyword_filter_enabled = config.keywords.length > 0;
    }
    
    if (config.enableDebugger !== undefined) {
        hookConfig.debugger = config.enableDebugger ? 1 : 0;
    }
    
    if (config.enableStack !== undefined) {
        hookConfig.stack = config.enableStack ? 1 : 0;
    }
    
    if (config.fixedValue !== undefined) {
        hookConfig.value = config.fixedValue;
    }
    
    return new Promise((resolve) => {
        const configKey = `${scriptId}_config`;
        chrome.storage.local.get([configKey], (result) => {
            const existingConfig = result[configKey] || {};
            const newConfig = { ...existingConfig, ...hookConfig };
            
            chrome.storage.local.set({ [configKey]: newConfig }, () => {
                resolve({
                    success: true,
                    scriptId,
                    config: newConfig
                });
            });
        });
    });
}

// 列出可用脚本
async function listAvailableScripts({ category = 'all' } = {}) {
    return new Promise((resolve, reject) => {
        fetch(chrome.runtime.getURL('scripts.json'))
            .then(response => response.json())
            .then(scripts => {
                if (category !== 'all') {
                    scripts = scripts.filter(s => s.category === category);
                }
                resolve(scripts);
            })
            .catch((e) => {
                // V4.9.30：拉取/解析脚本清单失败**必须上抛**——原实现 resolve([]) 与"这个扩展
                // 确实没有任何脚本"完全同形，AI 会读成"没有可用脚本"而放弃整条工作流
                //（smart_enable_scenario / toggle_script 等都以它为前提）。
                reject(new Error('脚本清单读取失败: ' + String((e && e.message) || e)));
            });
    });
}

// 刷新页面
async function refreshPage({ hardRefresh = false, tabId, hostname } = {}) {
    const tab = await requireTab({ tabId, hostname });
    
    await chrome.tabs.reload(tab.id, { bypassCache: hardRefresh });
    return { success: true };
}
