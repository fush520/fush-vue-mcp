// ===== 新增：浏览器控制功能 =====

// ============== CDP 真实交互（chrome.debugger）==============
// 合成事件（dispatchEvent）isTrusted=false，对带可信校验的站点（防自动化按钮、
// 受控组件）无效。chrome.debugger（CDP）产生的输入与真人操作同级（isTrusted=true），
// 并解锁全页截图能力。代价：attach 期间页面顶部短暂显示"正在调试"横幅——渗透场景可接受。
// 设计参照 chrome-devtools-mcp / mcp-chrome 的做法（CDP 真实输入 + 语义 DOM 快照）。

// 统一定位 helper：支持 text= 语法、等待出现、滚动到可见、返回中心坐标（供 CDP 使用）
async function resolveInteractionTarget({ selector, x, y, wait = 3000, index = 0, tab: presetTab, tabId, hostname }) {
    // V4.9.1：支持外部传入已解析的目标 tab（审计 M3）——避免"坐标在活动页测量、操作却在目标页执行"的跨窗口错位
    // V4.9.33：收敛到 requireTab（`||` 短路语义不变——presetTab 有值时不调用）
    const tab = presetTab || await requireTab({ tabId, hostname });

    // 纯坐标模式：坐标是视口坐标，CDP 直接可用。审计 L4（2026-10-13）：回填 elementFromPoint 摘要
    // ——坐标点击正是"点错"高发形态（学习通记录 #1），原实现返回体无任何自检信号；
    // 坐标为空白处时标 emptyPoint（不报错——hover 移开鼠标等"点空白"是合法操作，决策留给调用方）
    if (x !== undefined && y !== undefined) {
        try {
            // 审计 L4（2026-10-13）：摘要只是锦上添花——冻结页最坏 8s+25s 会拖垮纯坐标点击本身，
            // 单独包 2s 短超时，超时即回退"无摘要"原行为
            const results = await withHardTimeout(adbExecuteScript({
                target: { tabId: tab.id },
                func: (px, py) => {
                    const at = document.elementFromPoint(px, py);
                    if (!at) return { found: false };
                    return {
                        found: true, tag: at.tagName, id: at.id || '',
                        className: String(at.className || '').slice(0, 60),
                        text: ((at.textContent || '') + '').trim().slice(0, 60)
                    };
                },
                args: [x, y],
                world: 'MAIN'
            }), 2000, '坐标摘要注入超时');
            const info = results[0]?.result;
            if (info && info.found) return { tab, x, y, via: 'coordinate', element: info };
            return { tab, x, y, via: 'coordinate', element: null, emptyPoint: true };
        } catch (e) {
            // 注入失败（页面冻结等）不阻塞纯坐标点击——回退原行为（无摘要）
            return { tab, x, y, via: 'coordinate' };
        }
    }
    if (!selector) throw new Error('必须提供 selector 或 x/y 坐标');
    // bug-hunt M1（2026-10-13）：空 text= 查询（"text=" / "text=  "）在 findByText 里
    // ''.includes('') === true → 命中所有带文本元素并**真实点击第一个**——外层快速失败
    if (typeof selector === 'string' && selector.startsWith('text=') && !selector.slice(5).trim()) {
        throw new Error('text= 缺少查询文本（用法：text=登录）');
    }

    const results = await adbExecuteScript({
        target: { tabId: tab.id },
        func: async (sel, waitMs, nth, isTextSel) => {
            const textQuery = isTextSel ? sel.slice(5).trim().toLowerCase() : null;
            const start = Date.now();

            const findByText = () => {
                const out = [];
                const normQuery = textQuery.replace(/\s+/g, ''); // 查询串去空白：兼容"登 录"这类带空格的按钮文本
                // 审计 M4（2026-10-13）：此列表必须与 clickElement 的 text= 分支、getSemanticDom 保持一致
                //（曾不一致：14 项 vs 11 项 → 同一 text= 在两工具命中不同元素、index 空间不同）
                const all = document.querySelectorAll('a, button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [onclick], [type="submit"], [type="button"], [contenteditable="true"], summary, label');
                all.forEach(el => {
                    const t = ((el.textContent || el.value || el.placeholder || '')).trim().toLowerCase().replace(/\s+/g, '');
                    if (t && t.includes(normQuery)) out.push(el);
                });
                return out;
            };

            let element = null;
            let matchCount = 0; // 2026-10-13：最后一次查询的命中数——区分"无匹配"与"index 超范围"
            // 等待元素出现（默认 3 秒，支持页面延迟渲染）
            while (Date.now() - start < waitMs) {
                if (textQuery !== null) {
                    const matches = findByText();
                    matchCount = matches.length;
                    element = matches[nth] || null;
                } else {
                    const matches = document.querySelectorAll(sel);
                    matchCount = matches.length;
                    element = matches[nth] || null;
                }
                if (element) {
                    const rect = element.getBoundingClientRect();
                    if (rect.width > 0 && rect.height > 0) break;
                    element = null; // 存在但不可见（display:none 等），继续等
                }
                await new Promise(r => setTimeout(r, 200));
            }

            if (!element) return { found: false, selector: sel, matchCount };

            // 滚动到可见区域（真实点击前必须让元素进入视口，否则坐标点不到）
            // behavior:'instant' 强制即时滚动：页面设 scroll-behavior:smooth 时动画超时会导致坐标漂移
            try { element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (e) { /* 忽略 */ }
            await new Promise(r => setTimeout(r, 200)); // 等待滚动/渲染稳定

            // 元素文本摘要（2026-10-13 审计 L2）：原取值链对复杂控件误导——select 拼接全部 option、
            // checkbox 恒 "on"、纯图标按钮（aria-label/title/img alt）为空。核对"点对了没有"靠这个字段，必须准
            // SYNC:pickText-v1（四处副本需同步修改）
            const pickText = (el) => {
                if (!el) return '';
                try {
                    const tag = el.tagName;
                    if (tag === 'SELECT') {
                        const so = el.selectedOptions && el.selectedOptions[0];
                        return String((so && so.textContent) || el.value || '').trim().slice(0, 60);
                    }
                    if (tag === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
                        const lb = el.labels && el.labels[0] ? el.labels[0].textContent : '';
                        return String(el.getAttribute('aria-label') || lb || el.value || '').trim().slice(0, 60);
                    }
                    const im = el.querySelector ? el.querySelector('img[alt]') : null;
                    return String(
                        el.getAttribute('aria-label') || el.getAttribute('title') ||
                        el.textContent || el.value || el.placeholder ||
                        (im ? im.getAttribute('alt') : '') || ''
                    ).trim().slice(0, 60);
                } catch (e) { return ''; }
            };

            // ===== 候选点取点（2026-10-13 调研落地 + 审计 M1/M2 修复）=====
            // 中心优先；不可用则按 四角 → 边中点 顺序找"点击确实作用在目标上"的点。
            // 有效点判定：elementFromPoint 命中元素**自身或其后代**——**命中祖先不算**（审计 M1：
            // 事件 target 会是祖先、元素不在事件路径上 = 点丢了；典型：visibility:hidden /
            // pointer-events:none / ::after 蒙层 / 换行 inline 元素的 bbox 中心落在行间空隙）。
            // 视口外候选点跳过（审计 M2：CDP 对越界坐标会静默派发，既不报遮挡也报不了越界）
            const rect = element.getBoundingClientRect();
            const inset = 2;
            const cx0 = Math.round(rect.left + rect.width / 2);
            const cy0 = Math.round(rect.top + rect.height / 2);
            const cand = [
                [cx0, cy0],
                [Math.round(rect.left + inset), Math.round(rect.top + inset)],
                [Math.round(rect.right - inset), Math.round(rect.top + inset)],
                [Math.round(rect.left + inset), Math.round(rect.bottom - inset)],
                [Math.round(rect.right - inset), Math.round(rect.bottom - inset)],
                [cx0, Math.round(rect.top + inset)],
                [cx0, Math.round(rect.bottom - inset)],
                [Math.round(rect.left + inset), cy0],
                [Math.round(rect.right - inset), cy0]
            ];
            const vw = window.innerWidth || 0, vh = window.innerHeight || 0;
            let pick = null, occludedBy = null, inViewportTried = 0;
            for (const c of cand) {
                const px = c[0], py = c[1];
                if (!(px >= 0 && py >= 0 && px < vw && py < vh)) continue;   // 视口外跳过
                inViewportTried++;
                let at = null;
                try { at = document.elementFromPoint(px, py); } catch (e) { /* 个别上下文不可用 */ }
                if (at && (at === element || element.contains(at))) { pick = { x: px, y: py }; break; }
                if (!occludedBy && at && at !== element) {
                    occludedBy = {
                        tag: at.tagName, id: at.id || '',
                        className: String(at.className || '').slice(0, 60),
                        text: pickText(at),
                        isAncestor: at.contains(element)   // 祖先命中：点击落到祖先上、元素收不到事件（审计 M1）
                    };
                }
            }
            const clickX = pick ? pick.x : cx0;
            const clickY = pick ? pick.y : cy0;

            return {
                found: true,
                x: clickX,
                y: clickY,
                matchCount,
                altPointUsed: !!pick && !(pick.x === cx0 && pick.y === cy0),   // 用了非中心候选点（换行 inline/局部遮挡的自动回退）
                clickWillMiss: !pick,                    // 九点均不可命中——点击大概率落空/落到别处（隐藏元素/全遮挡/越界）
                outOfViewport: inViewportTried === 0,    // 所有候选点都在视口外（审计 M2）
                occludedBy,
                // 文档坐标包围盒（视口坐标 + 滚动偏移）：供截图 clip 使用（captureScreenshot 的 clip 是文档坐标系）
                box: {
                    x: Math.round(rect.left + window.scrollX),
                    y: Math.round(rect.top + window.scrollY),
                    width: Math.round(rect.width),
                    height: Math.round(rect.height)
                },
                tag: element.tagName,
                id: element.id || '',
                type: element.type || '',
                text: pickText(element),
                disabled: element.disabled === true || element.getAttribute('aria-disabled') === 'true'
            };
        },
        // 审计 L1：wait 传负数时循环一次都不跑（误报"无匹配"）——非正数一律回落 1000ms
        args: [selector || '', (typeof wait === 'number' && wait > 0) ? wait : 1000, index || 0, typeof selector === 'string' && selector.startsWith('text=')],
        world: 'MAIN'
    });

    const info = results[0]?.result;
    if (!info || info.found === false) {
        // 2026-10-13：区分四种失败——index 非法 / 无匹配 / index 超范围 / 命中但不可见。
        // 原先一律报"未找到可见元素"，AI 无从判断是选择器写错、索引越界还是元素被隐藏
        let extra;
        if (index < 0) {
            extra = `（index=${index} 无效——应为 0 到 ${Math.max(0, ((info && info.matchCount) || 1) - 1)} 之间的整数）`;
        } else if (!info || !info.matchCount) {
            extra = `（无匹配，等待 ${wait}ms）`;
        } else if (info.matchCount <= index) {
            extra = `（选择器命中 ${info.matchCount} 个元素，index=${index} 超出范围，可选 0-${info.matchCount - 1}）`;
        } else {
            extra = `（第 ${index + 1} 个匹配存在但不可见——display:none / 尺寸为 0，等待 ${wait}ms 超时）`;
        }
        throw new Error(`未找到可见元素: ${selector}${extra}`);
    }
    if (info.disabled) {
        throw new Error(`元素处于禁用状态: ${info.tag} "${info.text}"`);
    }
    return { tab, x: info.x, y: info.y, box: info.box, element: info, occludedBy: info.occludedBy || null, via: 'selector' };
}

// CDP attach 管理（引用计数）：
// - 同一 tab 重复 attach 会报错 → cdpAttachPromises 存 attach Promise，并发调用共享同一次 attach
// - 嵌套/并发使用（realKey 内嵌 realClick、两个工具并行同 tab）→ cdpUseCount 计数，归零才 detach
// - 用户点掉调试横幅/关 tab 导致被动 detach → onDetach 监听清理脏状态，下次重新 attach
const cdpAttachPromises = new Map(); // tabId -> Promise<attach>
const cdpUseCount = new Map();       // tabId -> 活跃使用计数

// V4.9.11：CDP 断点调试的调试会话（Debugger 域）——
// 与"用完即 detach"的 withDebugger 不同，断点调试必须**长驻 attach**：
// 断点与暂停态都绑定在调试会话上，detach 即断点全失效、暂停中的页面恢复执行。
// 故 debugSessionTabs 内的 tab 在引用计数上保持 +1，直到显式 detach / 被动分离才释放。
const debugSessionTabs = new Set();  // tabId：长驻调试会话
const cdpBreakpoints = new Map();    // breakpointId -> { tabId, urlRegex, line, at }（CDP 侧断点，随 detach 失效）
// V4.9.11（独立审计 M4）：暂停态按标签页存——原为单例，两个标签各有调试会话时，
// A 暂停 → B 暂停会覆盖 A 的调用帧；B resume 又把 A 的状态一并清掉（get_debug_state 谎报 paused:false）
const debuggerPausedStates = new Map();  // tabId -> 暂停快照 { at, tabId, reason, hitBreakpoints, callFrames }

// 用户取消调试横幅、页面关闭等被动 detach：清理 attach 状态，下次调用重新 attach。
// 注意：只删 attachPromises 不删 useCount——持有方各自通过 release 递减归零清理，
// 若在此处清计数会导致旧持有方的 release 误清后来新会话的计数（竞态误杀）
chrome.debugger.onDetach.addListener((source) => {
    if (source && source.tabId !== undefined) {
        cdpAttachPromises.delete(source.tabId);
        // V4.9.11：被动分离（用户点黄色横幅"取消"/关标签）→ 调试会话与断点全部失效，必须同步清理，
        // 否则 ensureDebugSession 误判"会话仍在"（不再重新 attach）、断点 Map 展示幽灵条目
        if (debugSessionTabs.delete(source.tabId)) {
            // 关键：长驻会话持有的那次计数必须在此回收。否则下次 attach 后计数永不归零——
            // 其它工具的 withDebugger 释放后仍剩 1（调试横幅常驻），而 debugSessionTabs 已被清、
            // releaseDebugSession 有 has 检查 → 再也无法经 detach 释放（计数永久泄漏）
            const n = (cdpUseCount.get(source.tabId) || 1) - 1;
            if (n <= 0) cdpUseCount.delete(source.tabId); else cdpUseCount.set(source.tabId, n);
        }
        for (const [id, v] of [...cdpBreakpoints]) if (v.tabId === source.tabId) cdpBreakpoints.delete(id);
        debuggerPausedStates.delete(source.tabId);
    }
});

async function cdpAcquire(tabId) {
    cdpUseCount.set(tabId, (cdpUseCount.get(tabId) || 0) + 1);
    if (!cdpAttachPromises.has(tabId)) {
        // 同步检查+写入，JS 单线程下此区间原子，并发调用共享同一 attach Promise
        const attachPromise = chrome.debugger.attach({ tabId }, '1.3');
        cdpAttachPromises.set(tabId, attachPromise);
        try {
            await attachPromise;
        } catch (e) {
            cdpAttachPromises.delete(tabId);
            // V4.9.11（独立审计 L7）：先与浏览器侧真实状态对账——SW 被回收（如 MCP 关闭期间）会丢掉
            // 全部内存态（attachPromises/计数/会话标记），而浏览器可能仍持有 attach。此时重复 attach 报
            // "Another debugger is already attached"，且 debugSessionTabs 无条目 → 既 detach 不掉也
            // attach 不上（只能用户手动点掉黄色横幅）。对账确认"确实仍附着"则视为成功，补登已解析占位
            if (await isOurAttach(tabId)) {
                cdpAttachPromises.set(tabId, Promise.resolve());
                return;
            }
            // V4.9.9.3（审计 High 修复）：attach 失败必须回滚计数——原实现计数永久 +1 →
            // cdpRelease 永不归零 → detach 永不执行（"正在调试"横幅常驻、用户 F12 报
            // "Another debugger is already attached"，只能关标签恢复）
            const n = (cdpUseCount.get(tabId) || 1) - 1;
            if (n <= 0) cdpUseCount.delete(tabId); else cdpUseCount.set(tabId, n);
            throw e;
        }
    } else {
        await cdpAttachPromises.get(tabId).catch(() => { /* 失败由首个调用者回滚，下面自行核对 */ });
        // V4.9.11（验收修复 A4）：**并发调用不能假装成功**——原实现把 attach 失败整个吞掉，
        // 第二个并发调用者的计数已 +1 却以为附着成功，直到后续 cdpSend 才报
        // "Debugger is not attached"（真因是 **attach 失败**，不是"未 attach"），误导排查方向。
        // 判据：失败时首个调用者会删除 attachPromises 记录（成功或采纳残留会话则保留）
        if (!cdpAttachPromises.has(tabId)) {
            const n = (cdpUseCount.get(tabId) || 1) - 1;
            if (n <= 0) cdpUseCount.delete(tabId); else cdpUseCount.set(tabId, n);
            throw new Error('调试器附着失败（该标签可能已被 DevTools 或其它扩展占用）');
        }
    }
}

// V4.9.11（复核 ⚠️-3）：判断"附着是不是我们自己的"——不能只看 targets[].attached，
// 那是 target 级排他标志，用户开着 DevTools/其它扩展调试时同样为 true（而这是 attach 失败最常见的原因），
// 误判会把别人的调试器当成"SW 重启残留"采纳 → 幽灵会话（has() 短路后续所有 pause/set_breakpoint）。
// 发一条无副作用命令探归属：命令通 = 确是我们的残留会话；报 not attached = 被别的调试器占用
async function isOurAttach(tabId) {
    try {
        const targets = await chrome.debugger.getTargets();
        const t = (targets || []).find(x => x.tabId === tabId);
        if (!t || !t.attached) return false;
        try {
            await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', { expression: '1', returnByValue: true });
            return true;
        } catch (e) {
            return false;
        }
    } catch (e) {
        return false;
    }
}

async function cdpRelease(tabId) {
    const n = (cdpUseCount.get(tabId) || 1) - 1;
    if (n <= 0) {
        cdpUseCount.delete(tabId);
        cdpAttachPromises.delete(tabId);
        try { await chrome.debugger.detach({ tabId }); } catch (e) { /* 已分离则忽略 */ }
    } else {
        cdpUseCount.set(tabId, n);
    }
}

// V4.9.9.2：探测标签是否"活着"（非冻结）——content script ping 优先 + executeScript 兜底，
// **不再走 CDP attach**（原 CDP 探测会挤掉用户的 F12 调试会话；勿再把 attach 引回本函数）。
// 用途：ensureTabAwake 的"后台优先"判定——活着就不激活标签（用户焦点不被打扰）；
// 冻结（Edge 睡眠标签，脚本注入与 CDP 均会挂死）才走激活解冻。
const probeAliveCache = new Map(); // tabId -> { at }（V4.9.9.3：仅缓存"活"结果，TTL 3 秒——连续操作省重复探测；"冻"不缓存，解冻后立即可用）
async function probeTabAlive(tabId, timeoutMs = 1500) {
    // V4.9.9.2：改用 content script ping 探测（更轻——零副作用、不 attach、绝不抢占用户 DevTools；
    // 冻结标签的 content script 不响应 → 超时判冻）。原 CDP attach 探测会挤掉用户的 F12 调试会话。
    // V4.9.9.3：活结果 TTL 缓存（3 秒）。
    const cached = probeAliveCache.get(tabId);
    if (cached && Date.now() - cached.at < 3000) return true;
    try {
        const pingOk = await Promise.race([
            new Promise((resolve) => {
                try {
                    chrome.tabs.sendMessage(tabId, { type: 'ADB_PING' }, (resp) => {
                        if (chrome.runtime.lastError) { resolve(false); return; }
                        resolve(!!(resp && resp.pong));
                    });
                } catch (e) { resolve(false); }
            }),
            new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs))
        ]);
        if (pingOk) { probeAliveCache.set(tabId, { at: Date.now() }); return true; }
    } catch (e) { /* 继续兜底 */ }

    // 兜底：executeScript 注入幂等表达式（content script 未注入的场景；仍不抢 DevTools；
    // 冻结标签的注入会挂起 → race 超时判冻）。1+1 无任何副作用。
    try {
        const injectOk = await Promise.race([
            chrome.scripting.executeScript({ target: { tabId }, func: () => 1 + 1, world: 'MAIN' }).then(() => true),
            new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs))
        ]);
        if (injectOk === true) { probeAliveCache.set(tabId, { at: Date.now() }); return true; }
        return false;
    } catch (e) {
        return false;
    }
}

// 发送 CDP 命令（需在 withDebugger 内使用）。会话失效时清理状态供下次重试
async function cdpSend(tabId, method, params = {}) {
    try {
        return await chrome.debugger.sendCommand({ tabId }, method, params);
    } catch (e) {
        // V4.9.11（独立审计 M2）：只有**会话真失效**才清理 attach 状态。原实现"任何错误都删"，
        // 在"用完即 detach"时代无害；断点调试引入长驻会话后，一个良性命令错误（如未暂停时
        // Debugger.resume、作用域对象已回收）会误删 attach 记录 → 下次 cdpAcquire 重复 attach →
        // "Another debugger is already attached" → real_click/take_screenshot/get_debug_state 等
        // 全部 CDP 工具失败，直到用户手动取消黄色横幅。非长驻会话保持原语义不变（那里误删代价小、自愈快）
        const msg = String((e && e.message) || e);
        if (!debugSessionTabs.has(tabId) || /detach|not attached|no tab with|target closed/i.test(msg)) {
            cdpAttachPromises.delete(tabId);
        }
        throw e;
    }
}

// 用完即 detach 的执行包装（引用计数支持并发/嵌套；缩短调试横幅显示时间）
async function withDebugger(tabId, fn) {
    // V4.9.9.3（审计 High 修复）：acquire 移入 try——原实现在 try 之外，acquire 抛出时
    // 计数已 +1 却不会走 release（与 cdpAcquire 内部回滚双保险）
    let acquired = false;
    try {
        await cdpAcquire(tabId);
        acquired = true;
        return await fn();
    } finally {
        if (acquired) await cdpRelease(tabId);
    }
}

// ============== V4.9.11：CDP 断点调试（Debugger 域，吸收上游 adb_debug） ==============
// 与 withDebugger 的"用完即 detach"不同，这里用 ensureDebugSession/releaseDebugSession 维持长驻 attach。
async function ensureDebugSession(tabId) {
    // V4.9.11（独立审计 M1）：**先同步占位再 await acquire**——原实现是 check-then-act，
    // 两个并发的 debug_control（如 pause 与 set_breakpoint 并行下发）都会通过 has() 判定后各自
    // acquire：计数 +2 而 Set 只有 1 条 → detach 只减到 1 → 永不释放（调试横幅常驻、用户 F12 报
    // "Another debugger is already attached"）；且 Set 条目已删 → 后续 detach 因 has() 为假直接跳过，
    // 再无回收路径。占位写法让第二个调用在 await 前就看见标记，直接复用同一会话
    if (debugSessionTabs.has(tabId)) {
        // V4.9.11（复核 ⚠️-1）：复用占位时必须**等在飞 attach 完成**——直接返回会让紧接的 cdpSend
        // 撞上 "Debugger is not attached"（attach 尚未完成），而该错又命中 cdpSend 的会话失效守卫，
        // 把 attach 记录误删（形成"Set 有条目、记录缺失"的偏态，后续工具会重复 attach）
        const p = cdpAttachPromises.get(tabId);
        if (p) await p.catch(() => {});
        // V4.9.30：**复用分支也要核对 attach 结果**——V4.9.11 给并发分支补过同样的核对
        //（见 cdpAcquire 里"并发调用不能假装成功"那段），但这里只补了"等 attach 完成"，
        // 失败仍被静默吞成"会话已建立"。后果：紧接的 cdpSend 抛 Chrome 原文
        // "Debugger is not attached"，**真因是 attach 失败**（用户开着 F12 / 被其它扩展占用），
        // AI 会按"没 attach"去排查，方向从一开始就是错的。
        // 判据与并发分支一致：失败时首个调用者会删除 attachPromises 记录（成功则保留）。
        if (!cdpAttachPromises.has(tabId)) {
            throw new Error('调试器附着失败（该标签页可能被 DevTools 或其它扩展占用）——请关闭该页的 F12 后重试');
        }
        return;
    }
    debugSessionTabs.add(tabId);
    try {
        await cdpAcquire(tabId);
    } catch (e) {
        debugSessionTabs.delete(tabId);   // 占位回滚（attach 失败：用户 F12 占用、tab 已关等）
        throw e;
    }
    // 占位期间被 onDetach 回收的极端时序：onDetach 已按"占位存在"回收了计数，此处若继续持有
    // 会留下无主计数（无人能释放）——主动释放并如实报错
    if (!debugSessionTabs.has(tabId)) {
        try { await cdpRelease(tabId); } catch (e) { /* 已分离：忽略 */ }
        throw new Error('调试会话在建立过程中被分离（用户取消了调试横幅？），请重试');
    }
}

async function releaseDebugSession(tabId) {
    if (debugSessionTabs.has(tabId)) {
        debugSessionTabs.delete(tabId);
        await cdpRelease(tabId);
    }
}

// 暂停事件监听：全局注册一次（CDP 事件只在 attach 期间到达；暂停态按 tabId 存 Map）
chrome.debugger.onEvent.addListener((source, method, params) => {
    try {
        const tabId = source && source.tabId;
        if (method === 'Debugger.paused') {
            debuggerPausedStates.set(tabId, {
                at: Date.now(), tabId,
                reason: params.reason,
                hitBreakpoints: params.hitBreakpoints || [],
                callFrames: (params.callFrames || []).slice(0, 25).map((f) => ({
                    callFrameId: f.callFrameId,
                    functionName: f.functionName || '(anonymous)',
                    url: f.url || '',
                    line: ((f.location && f.location.lineNumber) || 0) + 1,   // CDP 0-based → 对外 1-based
                    column: ((f.location && f.location.columnNumber) || 0) + 1,
                    scopeChain: (f.scopeChain || []).map(s => ({ type: s.type, objectId: s.object && s.object.objectId }))
                }))
            });
        } else if (method === 'Debugger.resumed') {
            debuggerPausedStates.delete(tabId);   // M4：只清该标签页的（不连坐其它标签的暂停态）
        } else if (method === 'Page.frameStartedNavigating' || method === 'Page.frameRequestedNavigation') {
            // 2026-10-13：动作后验证探针（调研落地）。审计 M1 修正——
            // · 原 `sameDocument` 过滤是**死代码**：两事件的参数表都没有该字段（frameStartedNavigating 是
            //   {frameId,url,loaderId,navigationType}，frameRequestedNavigation 是 {frameId,reason,url,disposition}）
            // · 按主 frameId 过滤：子帧（广告/统计 iframe）导航不算本次动作
            // · 同文档判据改用 navigationType；frameRequestedNavigation 按 disposition 排除下载/新标签
            //   （当前页根本没动，写进 navigatedToUrl 是证据污染）
            const p = actionProbes.get(tabId);
            if (p) {
                const isMain = !p.mainFrameId || (params && params.frameId === p.mainFrameId);
                const sameDoc = !!(params && (params.sameDocument === true || params.navigationType === 'sameDocument'));
                const notCurrentTab = !!(params && params.disposition && params.disposition !== 'currentTab');
                if (isMain && !sameDoc && !notCurrentTab) {
                    p.navEvents.push({ url: (params && params.url) || '', at: Date.now() });
                } else if (isMain && sameDoc) {
                    // bug-hunt M7（2026-10-13）：SPA 同文档路由跳转（pushState/hash）单独标记——
                    // 点击 router-link 是最常被依赖的场景，不能并入 navigated:false 的"无导航"
                    p.sameDocNav = true;
                }
            }
        } else if (method === 'Page.javascriptDialogOpening') {
            // 对话框会阻塞渲染进程（防调试 alert/confirm 常见）——动作后能立即告知 AI，避免后续操作无响应
            const p = actionProbes.get(tabId);
            if (p) {
                p.dialogs.push({ type: (params && params.type) || '', message: String((params && params.message) || '').slice(0, 120) });
                // on_dialog 策略（bug-hunt 实测驱动 2026-10-13）：对话框只与"弹框时刻活着的 session"关联——
                // 事后新 attach（含补 Page.enable）接管不了（实测 "No dialog is showing"）。**必须在探针
                // 会话内处理**。默认（无策略）也处理——按"取消"：不处理会阻塞渲染进程导致探针的 await 链
                // 永远走不到 finally（会话永不结束、对话框永久悬挂 = 页面死锁，对照实测超时复现）。
                // dismiss 对 alert 与 accept 等效（单按钮），对 confirm 是"安全侧"（不执行危险操作）
                const accept = p.dialogPolicy === 'accept';
                cdpSend(tabId, 'Page.handleJavaScriptDialog', { accept })
                    .then(() => { p.dialogHandled = p.dialogPolicy ? (accept ? 'accepted' : 'dismissed') : 'dismissed-by-default'; })
                    .catch((e) => { p.dialogHandled = 'failed: ' + String((e && e.message) || e); });
            }
        }
    } catch (e) { /* 事件处理绝不抛——抛异常会污染整个调试器链路 */ }
});

// ===== 2026-10-13：动作后验证（调研落地——chrome-devtools-mcp waitForEventsAfterAction 简化版）=====
// 背景：原 real_click 返回"事件已派发"即止，页面是否导航/弹窗/DOM 变化全靠 AI 猜（学习通实测：
// 点击后需人工"延时 2.6s 读回"）。本探针在动作前 arm、动作后汇总，让返回体带上"页面发生了什么"。
// arm 用 cdpAcquire 持有 attach 引用跨动作——CDP 事件只在 attach 期间到达，中间 detach 会断流；
// 嵌套的 withDebugger 会各自增减计数，整体保持附着。
const actionProbes = new Map(); // tabId -> { navEvents: [], dialogs: [] }

// V4.9.18（复盘B1）：动作内联摘要——"点一下直接带回产生了哪些请求"（原要再调一次抓包工具：
// 多一次往返、AI 可能忘了查而遗漏关键请求）。读 webRequest 缓冲增量（动作时刻起的新 API 请求）。
// V4.9.28：`errOut` 把"摘要失败"回传给调用方——原实现 catch 后静默返回 []，于是
// "动作后确实没有新请求"与"摘要功能挂了"在返回值上完全同形。两处调用点都受影响：
// withActionProbe 的 afterRequests、clickAndCapture 的 newRequestCount。
// 同时 filter 加 `r &&`——networkRequests 里混入 null 条目是这里最常见的抛错源。
function summarizeAfter(sinceTs, tabId, max = 8, errOut) {
    try {
        return networkRequests
            .filter(r => r && (r.timestamp || 0) >= sinceTs && (typeof tabId !== 'number' || r.tabId === tabId))
            .slice(-max)
            .map(r => ({
                url: (r.url || '').length > 200 ? (r.url || '').slice(0, 200) + '…' : r.url,
                method: r.method,
                statusCode: r.statusCode,
                requestId: r.requestId,
                ...(r.error ? { error: r.error } : {})
            }));
    } catch (e) {
        if (errOut) errOut.error = String((e && e.message) || e);
        return [];
    }
}

async function withActionProbe(tabId, actionFn, { settleMs = 250, dialogPolicy = '' } = {}) {
    const actionStart = Date.now();   // V4.9.18（B1）：动作起点——收集"本次动作产生的新请求"用
    const probe = { navEvents: [], dialogs: [], mainFrameId: '', sameDocNav: false, dialogPolicy: dialogPolicy || '', dialogHandled: '' };
    actionProbes.set(tabId, probe);
    let armed = false;
    try {
        await cdpAcquire(tabId);          // 持引用（失败自带回滚，见 cdpAcquire 注释）
        armed = true;
        await cdpSend(tabId, 'Page.enable');   // Page 域事件（幂等；detach 后失效，下次 arm 重新 enable）
        // 审计 M1（2026-10-13）：取主 frameId——frameStartedNavigating/frameRequestedNavigation 对
        // **子帧**（广告/统计 iframe）同样触发，不按帧过滤会把 ad 跳转当"本次动作引发的导航"写进
        // navigatedToUrl（AI 信任的证据字段不能被污染）。取不到则不按帧过滤（降级为全帧，注释在事件处理侧）
        try {
            const tree = await cdpSend(tabId, 'Page.getFrameTree');
            probe.mainFrameId = (tree && tree.frameTree && tree.frameTree.frame && tree.frameTree.frame.id) || '';
        } catch (e) {
            // V4.9.28：取不到主 frameId 时，事件侧会退化为**全帧收录**——广告/统计 iframe 的
            // 跳转同样会被写进 verify.navigatedToUrl。必须在 verify 里留标记：那是 AI 最信任
            // 的证据字段，它无从知道这次没有按帧过滤。
            probe.frameFilterDisabled = true;
        }
    } catch (e) { /* 探针不可用不阻塞动作本身——验证是增强不是依赖 */ }
    try {
        const result = await actionFn();
        if (armed) {
            // 收尾窗口（2026-10-13 实测改进）：默认 250ms——"点击 → 100ms 后延迟跳转"（表单提交、
            // SPA 路由的常见模式）在旧 100ms 窗口外会漏报 navigated（测试页实测命中）；
            // 有事件到达则立即提前结束——无导航的普通点击最多多等约 150ms，导航场景几乎零等待
            const t0 = Date.now();
            while (Date.now() - t0 < settleMs && !probe.navEvents.length && !probe.dialogs.length) {
                await new Promise(r => setTimeout(r, 25));
            }
        }
        const nav = probe.navEvents;
        const lastUrl = nav.length ? nav[nav.length - 1].url : '';
        // 对话框策略已触发时，等其处理结果落地（有界 2s——handleJavaScriptDialog 通常毫秒级返回）
        if (probe.dialogs.length && (probe.dialogPolicy === 'accept' || probe.dialogPolicy === 'dismiss')) {
            const t0d = Date.now();
            while (!probe.dialogHandled && Date.now() - t0d < 2000) await new Promise(r => setTimeout(r, 25));
        }
        // armed=false 时探针没装上——verify 置 null（不返回"未导航"的假信号，区分"没导航"与"没探针"）
        const verify = armed ? {
            navigated: nav.length > 0,
            ...(lastUrl ? { navigatedToUrl: lastUrl } : {}),
            ...(probe.sameDocNav && !nav.length ? { sameDocumentNav: true } : {}),   // bug-hunt M7：SPA 路由跳转
            ...(probe.frameFilterDisabled ? { frameFilterDisabled: true } : {}),     // V4.9.28：未按帧过滤（导航可能来自 iframe）
            ...(probe.dialogs.length ? {
                dialogOpened: probe.dialogs[0],
                ...(probe.dialogHandled ? { dialogHandled: probe.dialogHandled } : {})
            } : {})
        } : null;
        // V4.9.18（复盘B1）：把"本次动作后的新请求摘要"并入返回体（对象形态才挂；摘要失败不影响动作返回）
        try {
            if (result && typeof result === 'object' && !Array.isArray(result)) {
                const sumErr = {};
                const after = summarizeAfter(actionStart, tabId, 8, sumErr);
                if (after.length) result.afterRequests = after;
                // V4.9.28：摘要失败必须留标记——否则 result 里没有 afterRequests
                // 就等于告诉 AI「动作后没有新请求」，与"摘要挂了"无法区分
                if (sumErr.error) result.afterRequestsUnavailable = sumErr.error;
            }
        } catch (e) { /* 写标记本身失败不再上抛（能做的标记上一行已给出） */ }
        return { result, verify };
    } finally {
        // bug-hunt M2（2026-10-13）：只删自己的探针——原无条件 delete 会让并发动作中"早结束方"
        // 抹掉"仍在飞方"的探针（其 verify 被静默降级为假 navigated:false）
        if (actionProbes.get(tabId) === probe) actionProbes.delete(tabId);
        if (armed) { try { await cdpRelease(tabId); } catch (e) { /* 已分离 */ } }
    }
}

async function debugControl({ action, tabId, urlRegex, lineNumber, columnNumber, breakpointId } = {}) {
    // 纯本地读，不需要 attach
    if (action === 'list_breakpoints') {
        return {
            breakpoints: [...cdpBreakpoints.entries()].map(([id, v]) => ({ breakpointId: id, ...v })),
            debugSessions: [...debugSessionTabs]
        };
    }
    // V4.9.11（独立审计 M3）：noActivate=true——调试目标常处于 CDP 暂停态（渲染进程主线程冻结），
    // 活性探测必然判"冻"→ 把标签抢到前台（打脸 V4.9.9 焦点不打扰体系）+ 白等两轮探测约 5.5s。
    // CDP 通道独立于渲染主线程，暂停不影响命令下发
    const tab = await requireTab({ tabId }, true);
    const tid = tab.id;

    // V4.9.11（独立审计 L1）：需要既有调试会话的动作先做前置检查——原实现直接下发 CDP 命令，
    // 未 attach 时抛 Chrome 原文（"Debugger is not attached to the tab with id: N."），对 AI 无指导性
    const requireSession = () => {
        if (!debugSessionTabs.has(tid)) {
            throw new Error(`标签页 ${tid} 当前没有调试会话，无法执行 ${action}——请先 debug_control(set_breakpoint) 或 debug_control(pause) 建立会话`);
        }
    };

    switch (action) {
        case 'pause': {
            await ensureDebugSession(tid);
            await cdpSend(tid, 'Debugger.enable');
            await cdpSend(tid, 'Debugger.pause');
            return { paused_requested: true, tabId: tid, hint: '等 1-2 秒后 get_debug_state 读调用帧。⚠️ 暂停期间页面冻结，其它页面操作类工具会挂起——分析完必须 resume' };
        }
        case 'resume':
            requireSession();
            await cdpSend(tid, 'Debugger.resume');
            return { resumed: true, tabId: tid, hint: '暂停已解除；已设断点仍有效，再次命中需再次 resume' };
        case 'step_into':
        case 'step_over':
        case 'step_out': {
            requireSession();
            const m = { step_into: 'Debugger.stepInto', step_over: 'Debugger.stepOver', step_out: 'Debugger.stepOut' }[action];
            await cdpSend(tid, m);
            return { stepped: action.replace('step_', ''), tabId: tid, hint: '新暂停后 callFrameId 全部变化，用 get_debug_state 重新读' };
        }
        case 'set_breakpoint': {
            if (!urlRegex) throw new Error('set_breakpoint 需要 url_regex（如 ".*encrypt.*\\.js"）');
            if (!lineNumber) throw new Error('set_breakpoint 需要 line_number（1-based）');
            await ensureDebugSession(tid);
            await cdpSend(tid, 'Debugger.enable');
            const r = await cdpSend(tid, 'Debugger.setBreakpointByUrl', {
                urlRegex, lineNumber: lineNumber - 1, columnNumber: columnNumber ? columnNumber - 1 : 0
            });
            cdpBreakpoints.set(r.breakpointId, { tabId: tid, urlRegex, line: lineNumber, at: Date.now() });
            return {
                breakpointId: r.breakpointId,
                locations: (r.locations || []).map(l => ({ scriptId: l.scriptId, line: ((l.lineNumber || 0) + 1), column: ((l.columnNumber || 0) + 1) })),
                tabId: tid,
                hint: 'locations 为空 = 当前无已加载脚本匹配该正则（页面后续加载仍会生效，非错误）。命中后用 get_debug_state 读变量'
            };
        }
        case 'remove_breakpoint': {
            if (!breakpointId) throw new Error('remove_breakpoint 需要 breakpoint_id');
            requireSession();
            // V4.9.11（独立审计 L3）：本地条目必删（finally）——原实现 CDP 报错时本地残留幽灵条目，
            // onDetach 只按 tab 整体清、覆盖不到这种漂移；而断点已失效时删除 Map 条目本就是幂等的
            try {
                await cdpSend(tid, 'Debugger.removeBreakpoint', { breakpointId });
            } finally {
                cdpBreakpoints.delete(breakpointId);
            }
            return { removed: true, hint: '删除断点不会自动恢复执行——若正暂停需 resume' };
        }
        case 'detach': {
            // 显式结束调试会话：先 resume（若暂停中）再 disable，最后释放计数（黄色调试横幅消失）
            const hadSession = debugSessionTabs.has(tid);   // V4.9.11（验收修复 B2）：先记录"是否真有过会话"
            // 批2审计 M3：SW 重启后 debugSessionTabs（纯内存态）清零，但浏览器侧 attach 仍在
            // （调试横幅常驻）——对账确认是本扩展的 attach 则强制回收，否则 AI 永远无法清理
            let orphanAttach = false;
            if (!hadSession) {
                try { orphanAttach = await isOurAttach(tid); } catch (e) { orphanAttach = false; }
            }
            try { await cdpSend(tid, 'Debugger.resume'); } catch (e) { /* 未暂停时报错忽略 */ }
            try { await cdpSend(tid, 'Debugger.disable'); } catch (e) { /* 忽略 */ }
            for (const [id, v] of [...cdpBreakpoints]) if (v.tabId === tid) cdpBreakpoints.delete(id);
            debuggerPausedStates.delete(tid);
            await releaseDebugSession(tid);
            // V4.9.11（独立审计 L2）：如实回报释放结果——计数未归零时（截图/chunk 收集等 CDP 操作在飞）
            // 调试横幅不会立刻消失，原实现恒报"横幅消失"，与用户实际观察不符
            // V4.9.11（验收修复 B2，实测确认）：`detached` 还必须反映**是否真的结束过一个会话**——
            // 原实现只看 remaining===0，在"从来就没有会话"时也回报"调试会话已结束、调试横幅消失"，
            // 是虚假陈述（会让 AI 以为已清理）。现按三种情况如实区分
            const remaining = cdpUseCount.get(tid) || 0;
            return {
                detached: (hadSession || orphanAttach) && remaining === 0,
                hadSession,
                orphanAttach,
                remainingCdpUsers: remaining,
                hint: (!hadSession && !orphanAttach)
                    ? '该标签页此前没有活动的 CDP 调试会话（本次无事可解除）。若页面仍显示调试横幅，可能来自其它扩展或已打开的 DevTools'
                    : (!hadSession && orphanAttach
                        ? '已回收 SW 重启后残留的孤儿调试会话（横幅应已消失）'
                        : (remaining === 0
                        ? '调试会话已结束：断点全部清除、页面恢复执行、调试横幅消失'
                        : `调试会话已释放，但仍有 ${remaining} 个 CDP 操作在飞（截图/chunk 收集等），调试横幅可能稍后才消失`))
            };
        }
        default:
            throw new Error(`未知 debug action: ${action}`);
    }
}

async function getDebugState({ tabId, callFrameIndex = 0, scopeIndex, maxVars = 30 } = {}) {
    // V4.9.11（独立审计 M4）：优先取指定标签页的暂停态，未指定则取最近一次暂停（多标签调试各自独立）
    const requestedTab = typeof tabId === 'number' ? tabId : null;
    let st = null;
    if (requestedTab !== null) st = debuggerPausedStates.get(requestedTab) || null;
    // V4.9.25（清单🟡-23）：**回退必须显式标注**——指定了 tab 却在该 tab 无暂停时静默改用
    // 别的标签页的暂停态，调用方会以为帧/变量来自目标标签页（多标签调试各自独立，两者毫无关系）
    const fellBackToOtherTab = requestedTab !== null && !st;
    if (!st) {
        for (const v of debuggerPausedStates.values()) if (!st || v.at > st.at) st = v;
    }
    if (!st) {
        return {
            paused: false,
            pausedTabs: [...debuggerPausedStates.keys()],
            hint: typeof tabId === 'number'
                ? `标签页 ${tabId} 当前无暂停。debug_control(pause) 主动暂停，或 set_breakpoint 后触发命中`
                : '当前无暂停。debug_control(pause) 主动暂停，或 set_breakpoint 后触发命中'
        };
    }
    const out = {
        ...(fellBackToOtherTab ? {
            fallback: true,
            fallbackNote: `标签页 ${requestedTab} **当前无暂停**；以下是**标签页 ${st.tabId}** 的暂停态——帧/变量属于另一个页面，与请求的标签页无关`
        } : {}),
        paused: true, reason: st.reason, tabId: st.tabId, hitBreakpoints: st.hitBreakpoints,
        callFrames: st.callFrames.map(f => ({
            callFrameId: f.callFrameId, functionName: f.functionName, url: f.url,
            line: f.line, column: f.column, scopes: f.scopeChain.map(s => s.type)
        }))
    };
    if (typeof scopeIndex === 'number') {
        const frame = st.callFrames[callFrameIndex];
        if (!frame) throw new Error(`callFrameIndex ${callFrameIndex} 越界（共 ${st.callFrames.length} 帧）`);
        const scope = frame.scopeChain[scopeIndex];
        if (!scope || !scope.objectId) throw new Error(`scopeIndex ${scopeIndex} 无对象（该作用域可能无变量或被回收）`);
        // 读变量用 withDebugger（长驻会话在时计数不归零；不在则临时 attach 也够用）
        const props = await withDebugger(st.tabId, async () =>
            cdpSend(st.tabId, 'Runtime.getProperties', { objectId: scope.objectId, ownProperties: true }));
        out.scope = scope.type;
        out.variables = (props.result || []).slice(0, maxVars).map(p => {
            const v = p.value || {};
            let val = v.value;
            if (val === undefined && v.type === 'object') val = v.description || v.className || '[object]';
            if (typeof val === 'string' && val.length > 300) val = val.slice(0, 300) + '…';
            return { name: p.name, type: v.type, value: val };
        });
    }
    return out;
}

// 点击类返回体的"点错风险"警告构建（realClick 与 realClickByRef 共用——2026-10-13 抽出自消除重复）。
// target 形如 resolveInteractionTarget 的返回：{ x, y, element, occludedBy, emptyPoint? }
function applyClickWarnings(out, target, index = 0) {
    const el = target && target.element;
    if (target && target.emptyPoint) {
        out.emptyPointWarning = `坐标 (${target.x}, ${target.y}) 处没有元素（空白区域或视口外）——点击已派发但可能无任何效果`;
    }
    if (el && el.matchCount > 1) {
        out.warning = `选择器命中 ${el.matchCount} 个元素，本次操作第 ${index + 1} 个（index=${index}）——请核对 element.text 是否为预期目标；如需其它元素请调整 index`;
    }
    if (el && el.altPointUsed) {
        out.clickPointNote = `元素中心点不可用（被局部遮挡或换行布局），已自动改用元素内的候选点 (${target.x}, ${target.y}) 点击——element.text 仍为目标元素文本`;
    }
    // 审计 M3（2026-10-13）：occlusionWarning 只在九点全灭时报——altPointUsed 成功回退时实际点击点没被遮挡，
    // 再报"被遮挡"与 clickPointNote 自相矛盾（还会把 AI 推向更弱的合成点击）
    if (el && el.clickWillMiss) {
        const oc = target.occludedBy;
        out.clickWillMissWarning = `目标元素的九个候选点均无法命中其自身（元素隐藏 / 被浮层完全覆盖 / 在视口外）——本次点击大概率落在其它元素上而非目标` +
            (oc ? `（候选点命中处是 <${oc.tag}${oc.id ? '#' + oc.id : ''}>${oc.text ? ` text:"${oc.text}"` : ''}${oc.isAncestor ? '，它是目标的祖先元素（事件不会到达目标）' : ''}）` : '') +
            `，请核对页面状态或用 click_element（合成事件直达元素）`;
    }
    if (el && el.outOfViewport) {
        out.outOfViewportWarning = `元素所有候选点都在视口外（元素过大或被滚动出屏）——CDP 已按越界坐标派发（通常无效），建议先 scroll_page 滚动到元素可见处再点击`;
    }
    return out;
}

// ref 路径的真实点击（2026-10-13，映射 chrome-devtools-mcp 的 uid 点击）：a11y 快照引用 → 元素 →
// 与 selector 路径一致的滚动/取点/派发行为。取点逻辑（中心优先、九点候选、祖先命中不算、视口外跳过）
// 与 resolveInteractionTarget 的注入**保持同步——修改任一处需同时改另一处**。
async function realClickByRef({ ref, dblClick = false, onDialog, tabId, hostname }) {
    const tab = await requireTab({ tabId, hostname });
    const { result: out, verify } = await withActionProbe(tab.id, () => withDebugger(tab.id, async () => {
        const { objectId } = await resolveAxRef(tab.id, ref);
        // 在元素上执行"滚动 + 九点取点"（callFunctionOn 的 this = 元素本身）
        const fnSrc = `async function () {
            const element = this;
            if (!element || element.nodeType !== 1) return JSON.stringify({ error: 'ref 指向的不是元素节点（可能是文本节点，请对父元素快照取 ref）' });
            if (element.disabled === true || element.getAttribute('aria-disabled') === 'true') return JSON.stringify({ error: '元素处于禁用状态（disabled）——点击不会生效' });
            // SYNC:pickText-v1（四处副本需同步修改）
            const pickText = (el) => {
                if (!el) return '';
                try {
                    const tag = el.tagName;
                    if (tag === 'SELECT') {
                        const so = el.selectedOptions && el.selectedOptions[0];
                        return String((so && so.textContent) || el.value || '').trim().slice(0, 60);
                    }
                    if (tag === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
                        const lb = el.labels && el.labels[0] ? el.labels[0].textContent : '';
                        return String(el.getAttribute('aria-label') || lb || el.value || '').trim().slice(0, 60);
                    }
                    const im = el.querySelector ? el.querySelector('img[alt]') : null;
                    return String(
                        el.getAttribute('aria-label') || el.getAttribute('title') ||
                        el.textContent || el.value || el.placeholder ||
                        (im ? im.getAttribute('alt') : '') || ''
                    ).trim().slice(0, 60);
                } catch (e) { return ''; }
            };
            try { element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (e) { /* 忽略 */ }
            await new Promise(r => setTimeout(r, 200));
            const rect = element.getBoundingClientRect();
            const inset = 2;
            const cx0 = Math.round(rect.left + rect.width / 2);
            const cy0 = Math.round(rect.top + rect.height / 2);
            const cand = [
                [cx0, cy0],
                [Math.round(rect.left + inset), Math.round(rect.top + inset)],
                [Math.round(rect.right - inset), Math.round(rect.top + inset)],
                [Math.round(rect.left + inset), Math.round(rect.bottom - inset)],
                [Math.round(rect.right - inset), Math.round(rect.bottom - inset)],
                [cx0, Math.round(rect.top + inset)],
                [cx0, Math.round(rect.bottom - inset)],
                [Math.round(rect.left + inset), cy0],
                [Math.round(rect.right - inset), cy0]
            ];
            const vw = window.innerWidth || 0, vh = window.innerHeight || 0;
            let pick = null, occludedBy = null, inViewportTried = 0;
            for (const c of cand) {
                const px = c[0], py = c[1];
                if (!(px >= 0 && py >= 0 && px < vw && py < vh)) continue;
                inViewportTried++;
                let at = null;
                try { at = document.elementFromPoint(px, py); } catch (e) { /* 忽略 */ }
                if (at && (at === element || element.contains(at))) { pick = { x: px, y: py }; break; }
                if (!occludedBy && at && at !== element) {
                    occludedBy = {
                        tag: at.tagName, id: at.id || '',
                        className: String(at.className || '').slice(0, 60),
                        text: pickText(at),
                        isAncestor: at.contains(element)
                    };
                }
            }
            const clickX = pick ? pick.x : cx0;
            const clickY = pick ? pick.y : cy0;
            const cls = element.className;
            return JSON.stringify({
                found: true, x: clickX, y: clickY,
                altPointUsed: !!pick && !(pick.x === cx0 && pick.y === cy0),
                clickWillMiss: !pick,
                outOfViewport: inViewportTried === 0,
                occludedBy,
                box: {
                    x: Math.round(rect.left + window.scrollX),
                    y: Math.round(rect.top + window.scrollY),
                    width: Math.round(rect.width),
                    height: Math.round(rect.height)
                },
                tag: element.tagName, id: element.id || '',
                className: typeof cls === 'string' ? cls : String((cls && cls.baseVal) || ''),
                text: pickText(element)
            });
        }`;
        let probe;
        try {
            probe = await cdpSend(tab.id, 'Runtime.callFunctionOn', {
                objectId,
                functionDeclaration: fnSrc,
                awaitPromise: true,
                returnByValue: true
            });
        } finally {
            // 远程对象用完即释放（防 objectId 泄漏）——释放失败（上下文已销毁等）无碍
            try { await cdpSend(tab.id, 'Runtime.releaseObject', { objectId }); } catch (e) { /* 忽略 */ }
        }
        let info = null;
        try { info = JSON.parse((probe && probe.result && probe.result.value) || ''); } catch (e) { /* 下方统一报错 */ }
        if (!info || info.error) {
            throw new Error('ref 取点失败: ' + ((info && info.error) || JSON.stringify((probe && probe.result) || {}).slice(0, 200)));
        }
        // 派发点击（与 selector 路径同序列：mousemove → press → release）
        const opts = { x: info.x, y: info.y, button: 'left' };
        await cdpSend(tab.id, 'Input.dispatchMouseEvent', { type: 'mouseMoved', ...opts, clickCount: 0 });
        if (dblClick) {
            await cdpSend(tab.id, 'Input.dispatchMouseEvent', { ...opts, type: 'mousePressed', buttons: 1, clickCount: 1 });
            await cdpSend(tab.id, 'Input.dispatchMouseEvent', { ...opts, type: 'mouseReleased', buttons: 0, clickCount: 1 });
            await cdpSend(tab.id, 'Input.dispatchMouseEvent', { ...opts, type: 'mousePressed', buttons: 1, clickCount: 2 });
            await cdpSend(tab.id, 'Input.dispatchMouseEvent', { ...opts, type: 'mouseReleased', buttons: 0, clickCount: 2 });
        } else {
            await cdpSend(tab.id, 'Input.dispatchMouseEvent', { ...opts, type: 'mousePressed', buttons: 1, clickCount: 1 });
            await cdpSend(tab.id, 'Input.dispatchMouseEvent', { ...opts, type: 'mouseReleased', buttons: 0, clickCount: 1 });
        }
        const out = {
            success: true,
            method: 'CDP 真实点击（isTrusted=true，ref 定位）',
            ref, x: info.x, y: info.y,
            element: info,
            dblClick
        };
        applyClickWarnings(out, { x: info.x, y: info.y, element: info, occludedBy: info.occludedBy || null }, 0);
        return out;
    }), { dialogPolicy: onDialog });
    if (verify) out.actionVerify = verify;
    return out;
}

// 真实点击（isTrusted=true）：mousemove → mousedown → mouseup 完整序列；
// 双击为两段式 press/release（clickCount 1→2），与真实双击事件流一致
async function realClick({ selector, x, y, ref, dblClick = false, wait = 3000, index = 0, onDialog, tabId, hostname}) {
    // ref 路径（2026-10-13）：a11y 快照引用——无选择器歧义，优先于 selector/坐标
    if (ref) {
        return realClickByRef({ ref, dblClick, onDialog, tabId, hostname });
    }
    const target = await resolveInteractionTarget({ selector, x, y, wait, index, tabId, hostname });
    // 2026-10-13：动作后验证（调研落地）——withActionProbe 持 attach 跨整个动作收集导航/对话框事件；
    // 嵌套的 withDebugger 自行增减计数，整体保持附着（见 withActionProbe 注释）
    const { result: out, verify } = await withActionProbe(target.tab.id, () => withDebugger(target.tab.id, async () => {
        const opts = { x: target.x, y: target.y, button: 'left' };
        if (target.via === 'selector') {
            await cdpSend(target.tab.id, 'Input.dispatchMouseEvent', { type: 'mouseMoved', ...opts, clickCount: 0 });
        }
        if (dblClick) {
            await cdpSend(target.tab.id, 'Input.dispatchMouseEvent', { ...opts, type: 'mousePressed', buttons: 1, clickCount: 1 });
            await cdpSend(target.tab.id, 'Input.dispatchMouseEvent', { ...opts, type: 'mouseReleased', buttons: 0, clickCount: 1 });
            await cdpSend(target.tab.id, 'Input.dispatchMouseEvent', { ...opts, type: 'mousePressed', buttons: 1, clickCount: 2 });
            await cdpSend(target.tab.id, 'Input.dispatchMouseEvent', { ...opts, type: 'mouseReleased', buttons: 0, clickCount: 2 });
        } else {
            await cdpSend(target.tab.id, 'Input.dispatchMouseEvent', { ...opts, type: 'mousePressed', buttons: 1, clickCount: 1 });
            await cdpSend(target.tab.id, 'Input.dispatchMouseEvent', { ...opts, type: 'mouseReleased', buttons: 0, clickCount: 1 });
        }
        // 2026-10-13（学习通场景驱动 + 审计 M1/M2/L3/M3）：点错风险自检信号统一由 applyClickWarnings 构建
        const out = {
            success: true,
            method: 'CDP 真实点击（isTrusted=true）',
            x: target.x, y: target.y,
            element: target.element || null,
            dblClick
        };
        applyClickWarnings(out, target, index);
        return out;
    }), { dialogPolicy: onDialog });
    if (verify) out.actionVerify = verify;   // 动作后验证：是否引发导航/对话框（armed 失败时不返回，避免假信号）
    return out;
}

// 真实悬停
async function realHover({ selector, x, y, wait = 3000, index = 0 , tabId, hostname}) {
    const target = await resolveInteractionTarget({ selector, x, y, wait, index, tabId, hostname });
    return withDebugger(target.tab.id, async () => {
        await cdpSend(target.tab.id, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y });
        // 审计 L5（2026-10-13）：悬停挂错菜单是同类"点错"问题——resolveInteractionTarget 已算好
        // 各信号，透传成本为零
        const out = { success: true, method: 'CDP 真实悬停（isTrusted=true）', x: target.x, y: target.y, element: target.element || null };
        if (target.emptyPoint) {
            out.emptyPointWarning = `坐标 (${target.x}, ${target.y}) 处没有元素（移开鼠标式悬停可能正是意图，仅提示）`;
        }
        if (target.element && target.element.matchCount > 1) {
            out.warning = `选择器命中 ${target.element.matchCount} 个元素，本次悬停第 ${index + 1} 个（index=${index}）——请核对 element.text 是否为预期目标；如需其它元素请调整 index`;
        }
        if (target.element && target.element.altPointUsed) {
            out.clickPointNote = `元素中心点不可用（被局部遮挡或换行布局），已改用元素内候选点 (${target.x}, ${target.y}) 悬停`;
        }
        // 审计 M3：同 realClick——occludedBy 只在九点全灭时报（altPointUsed 回退成功即不外报遮挡）
        if (target.element && target.element.clickWillMiss) {
            const oc = target.occludedBy;
            out.hoverWillMissWarning = `目标元素的九个候选点均无法命中其自身（隐藏 / 被浮层完全覆盖 / 视口外）——悬停大概率作用在其它元素上` +
                (oc ? `（候选点命中处是 <${oc.tag}${oc.id ? '#' + oc.id : ''}>${oc.isAncestor ? '，它是目标的祖先元素' : ''}）` : '');
        }
        if (target.element && target.element.outOfViewport) {
            out.outOfViewportWarning = `元素所有候选点都在视口外——建议先 scroll_page 滚动后再悬停`;
        }
        return out;
    });
}

// ============== V4.9.39：鼠标级拖拽（滑块验证码 / rc-slider / 拖拽排序） ==============
// 为什么补这组能力：此前只有 click / hover / type——**没有"按住 → 移动 → 释放"的完整鼠标序列**，
// rc-slider-captcha 这类像素级滑块做不了。且滑块验证码普遍检测 isTrusted，合成 DOM 事件
// （dispatchEvent(new MouseEvent)）isTrusted=false 会被识破，必须走 CDP Input 域。
//
// 拟人化：真实人类拖动的速度曲线是"慢起 → 加速 → 减速停"，轨迹带微小抖动。
// 直线匀速是最容易被判定为机器人的特征之一——所以默认 human 缓动 + 正态抖动，
// 每步延迟也带 ±30% 随机。抖动逐点衰减（越接近终点越稳，像人对准时收手）。

// Box-Muller 正态分布（mean=0, stddev=1）——抖动用它而不是均匀分布，更接近人手微颤
function randn() {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// 缓动曲线：human = easeInOutQuad（慢起-中段快-慢收，滑块手势的典型形态）
function applyEasing(t, kind) {
    if (kind === 'linear') return t;
    if (kind === 'easeOut') return 1 - Math.pow(1 - t, 3);        // 快速启动、慢收尾
    return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // human（默认）
}

// 生成拖拽轨迹（纯计算，不含 IO）：从 (x0,y0) 到 (x1,y1)，steps 个中间点 + 精确终点
function buildDragPath(x0, y0, x1, y1, { steps = 24, easing = 'human', jitter = 1.5 } = {}) {
    const pts = [];
    const n = Math.max(1, Math.min(200, Math.round(steps)));
    for (let i = 1; i <= n; i++) {
        const t = i / n;
        const e = applyEasing(t, easing);
        const decay = 1 - e * 0.7;                 // 越接近终点抖动越小
        const jx = jitter > 0 ? randn() * jitter * decay : 0;
        const jy = jitter > 0 ? randn() * jitter * decay : 0;
        pts.push({
            x: Math.round(x0 + (x1 - x0) * e + jx),
            y: Math.round(y0 + (y1 - y0) * e + jy),
            t
        });
    }
    // 终点必须精确落位（抖动量归零）——滑块松手的落点差 1-2px 就可能判定失败
    pts.push({ x: Math.round(x1), y: Math.round(y1), t: 1 });
    return pts;
}

// V4.9.40（验收 R1 根修）：用 CDP Runtime.evaluate 取元素的**视口中心**——**不滚动页面**。
// 为什么不用 resolveInteractionTarget：它为九点取点会 scrollIntoView(block:'center')，
// 解析终点时会把已经测好的起点顶出视口/顶偏（验收 🔴：目标本来可见也滚 72px，
// 按下的不再是起点元素，工具仍 success=true）。终点只需要中心点，读 getBoundingClientRect 即可。
async function getSelectorViewportCenter(tabId, selector) {
    const expr = `(() => {
        let el = null;
        try { el = document.querySelector(${JSON.stringify(selector)}); } catch (e) { return { found: false, error: 'invalid-selector' }; }
        if (!el) return { found: false };
        const r = el.getBoundingClientRect();
        return {
            found: true,
            x: Math.round(r.left + r.width / 2),
            y: Math.round(r.top + r.height / 2),
            visible: r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth,
            box: { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), width: Math.round(r.width), height: Math.round(r.height) },
            tag: el.tagName, id: el.id || '',
            text: ((el.textContent || '') + '').trim().slice(0, 60)
        };
    })()`;
    return await withDebugger(tabId, async () => {
        const r = await cdpSend(tabId, 'Runtime.evaluate', { expression: expr, returnByValue: true });
        return (r && r.result && r.result.value) || { found: false };
    });
}

// 真实拖拽（CDP isTrusted=true）：mouseMoved → mousePressed → N×mouseMoved(buttons=1) → mouseReleased
// 起点：selector / x,y（ref 不在本工具范围——拖拽目标通常是可见的滑块元素）
// 终点：to_selector（拖到元素中心）/ to_x+to_y（绝对视口坐标）/ dx(+dy)（相对起点的偏移，
//       滑块最常用：dx = 缺口X - 滑块X）
// 失败安全：一旦按下鼠标，无论后续哪一步抛错都**保证发出 mouseReleased**——否则页面会卡在
// "按住"状态，后续所有交互都乱（这是合成拖拽最常见的坑）。
async function realDrag({ selector, x, y, toSelector, toX, toY, dx, dy, steps = 24, durationMs = 800, easing = 'human', jitter = 1.5, button = 'left', wait = 3000, index = 0, holdBeforeReleaseMs = 0, onDialog, tabId, hostname }) {
    const t0All = Date.now();
    // V4.9.40（独立验收 R1/Y6）：**终点形式必须恰好一种**——原实现按 if/else 优先级静默取值，
    // 混用（如给 to_x 又给 dy）时被忽略的参数不报错、语义被悄悄改写（实测 to_x=500 + dy=0 → 原地不动）。
    const toForms = [
        toSelector ? 'to_selector' : null,
        (toX !== undefined || toY !== undefined) ? 'to_x/to_y' : null,
        (dx !== undefined || dy !== undefined) ? 'dx/dy' : null
    ].filter(Boolean);
    if (toForms.length > 1) {
        throw new Error(`终点参数只能给一种形式（收到: ${toForms.join(' + ')}）——to_selector / to_x+to_y / dx(+dy) 三选一；混用会被静默改写，故直接拒绝`);
    }
    if (toForms.length === 0) {
        throw new Error('缺少拖拽终点：请提供 to_selector / to_x+to_y / dx(+dy) 之一');
    }

    const from = await resolveInteractionTarget({ selector, x, y, wait, index, tabId, hostname });
    // selector / ref 模式会带 box（**文档坐标**，= rect + 当时的 scroll）——R1 用它反算视口坐标
    const fromBox = (from.element && from.element.box) ? from.element.box : null;

    // ---- 终点解析 ----
    // V4.9.40（验收 R1 根修）：终点优先用 CDP 直接取视口中心（**零滚动**）——不再走会 scrollIntoView 的
    // resolveInteractionTarget。text= 语法无法用 querySelector，才回退旧路径（下方用 box 文档坐标反算校正）。
    let ex, ey, toInfo = null, toBox = null;
    if (toSelector) {
        let cv = null;
        if (!/^text=/.test(toSelector)) {
            try { cv = await getSelectorViewportCenter(from.tab.id, toSelector); } catch (e) { cv = null; }
        }
        if (cv && cv.found) {
            ex = cv.x; ey = cv.y;
            toBox = cv.box || null;
            toInfo = { tag: cv.tag, id: cv.id, text: cv.text, matchCount: 1, box: cv.box, found: true };
            if (!cv.visible) {
                // 终点在视口外：CDP 坐标会落到视口外（无效或打到别的元素）→ 明确拒绝，不静默
                throw new Error(`终点元素不在视口内（${toSelector} 视口位置 ${cv.x},${cv.y}）——请先滚动到它能看见，或改用 to_x/to_y 视口坐标`);
            }
        } else {
            const t = await resolveInteractionTarget({ selector: toSelector, wait, index: 0, tabId, hostname });
            ex = t.x; ey = t.y; toInfo = t.element || null;
            toBox = (t.element && t.element.box) ? t.element.box : null;
        }
    } else if (toX !== undefined || toY !== undefined) {
        if (toX === undefined || toY === undefined) throw new Error('to_x 与 to_y 必须同时提供（只给一个会被静默忽略）');
        ex = toX; ey = toY;
    } else {
        ex = from.x + (Number.isFinite(dx) ? dx : 0);
        ey = from.y + (Number.isFinite(dy) ? dy : 0);
    }

    const { result: out, verify } = await withActionProbe(from.tab.id, () => withDebugger(from.tab.id, async () => {
        // V4.9.40（独立验收 Y4）：先把标签带到前台（后台标签的 CDP 输入会被吞），
        // 但**必须套用项目的焦点恢复租约**（V4.9.9 设计：AI 连续操作不打扰、8s 后恢复用户原标签）——
        // 原实现裸调 Page.bringToFront，会直接把用户正在看的标签切走且永不恢复。
        let prevActiveId = null;
        try { const [cur] = await chrome.tabs.query({ active: true, currentWindow: true }); prevActiveId = cur && cur.id; } catch (e) { /* 忽略 */ }
        try { await cdpSend(from.tab.id, 'Page.bringToFront'); } catch (e) { /* 忽略 */ }
        if (prevActiveId && prevActiveId !== from.tab.id) {
            try { selfActivateMark.set(from.tab.id, Date.now()); } catch (e) { /* 忽略 */ }
            try { scheduleFocusRestore(from.tab.id, prevActiveId); } catch (e) { /* 忽略 */ }
        }

        // 一次取：视口尺寸 + **当前滚动位置**（Page.getLayoutMetrics 的 pageX/pageY 即滚动偏移）
        let vw = 0, vh = 0, scrollX = 0, scrollY = 0;
        try {
            const lm = await cdpSend(from.tab.id, 'Page.getLayoutMetrics');
            const css = (lm && lm.cssLayoutViewport) || (lm && lm.layoutViewport) || null;
            if (css) {
                vw = Number(css.clientWidth || 0); vh = Number(css.clientHeight || 0);
                scrollX = Number(css.pageX || 0); scrollY = Number(css.pageY || 0);
            }
        } catch (e) { /* 取不到视口就按原值派发 */ }

        // ---- R1 修复：起点坐标按当前滚动校正 ----
        let sx = from.x, sy = from.y;
        let scrollAdjusted = false;
        if (fromBox) {
            // box 是元素**左上角**的文档坐标（resolveInteractionTarget 里 rect + scroll 算的）→
            // 视口中心 = (left + w/2 - scrollX, top + h/2 - scrollY)。原版误用左上角，差半个元素尺寸。
            const nx = Math.round(fromBox.x + (fromBox.width || 0) / 2 - scrollX);
            const ny = Math.round(fromBox.y + (fromBox.height || 0) / 2 - scrollY);
            if (Math.abs(nx - sx) > 1 || Math.abs(ny - sy) > 1) { sx = nx; sy = ny; scrollAdjusted = true; }
        } else if (toSelector) {
            // 纯坐标起点 + to_selector：解析终点会滚动，而坐标起点无从反算 → 明确拒绝，
            // 不能"按错元素还返回 success"（验收 R1 的核心教训）
            throw new Error('起点是纯坐标、终点是 to_selector：解析终点会滚动页面，坐标起点无法校正。请改用 selector 起点，或把 to_selector 换成 to_x/to_y（视口坐标）');
        }
        // 坐标起点 + to_x/to_y：页面若因起点解析滚过，to_x/to_y 的视口含义也变了 → 明确提示（no silent）
        let coordWarn = '';
        if (!fromBox && !toSelector && (toX !== undefined || toY !== undefined) && (scrollY !== 0 || scrollX !== 0)) {
            coordWarn = '起点/终点都用了视口坐标，而页面当前已滚动（scroll=' + scrollX + ',' + scrollY + '）——坐标以当前视口为准，若按滚动前截图取的坐标请重新取';
        }

        // ---- 终点坐标校正（to_selector 用 box 反算，不受滚动影响）----
        let tx = ex, ty = ey;
        if (toBox) {
            tx = Math.round(toBox.x + toBox.width / 2 - scrollX);
            ty = Math.round(toBox.y + toBox.height / 2 - scrollY);
        } else if (toX === undefined && (dx !== undefined || dy !== undefined)) {
            // dx/dy 相对**校正后的起点**（自动继承校正）
            tx = sx + (Number.isFinite(dx) ? dx : 0);
            ty = sy + (Number.isFinite(dy) ? dy : 0);
        }

        // 视口钳制
        let fx = tx, fy = ty;
        if (vw > 0 && vh > 0) {
            fx = Math.max(0, Math.min(vw - 1, fx));
            fy = Math.max(0, Math.min(vh - 1, fy));
        }

        const path = buildDragPath(sx, sy, fx, fy, { steps: Number.isFinite(steps) ? steps : 24, easing, jitter });
        const stepDelay = Math.max(0, durationMs) / Math.max(1, path.length);
        let lastPt = path[path.length - 1];
        let pressed = false;
        let truncated = false;
        const t0 = Date.now();
        // 被节流的标签会让每步 setTimeout 被拉长到秒级（实测 600ms 的轨迹跑成 23s 并撞服务端超时，
        // 且 mouseReleased 可能因此没发出去 → 页面停在"按住"状态）。给轨迹一个硬期限：
        // 超期就**跳到终点并立即释放**——宁可少几个中间点，也要保证 down/up 配对完整。
        const hardDeadline = Date.now() + Math.max(5000, durationMs * 3 + 3000);
        try {
            // 拖动前先 hover 到起点（真实操作必有这一步；也能让悬停态组件先响应）
            // V4.9.40（验收 C2）：`pressed = true` 提到 await **之前**——mousePressed 可能
            // "已派发但 Promise 拒绝"（会话抖动），原顺序会让兜底 release 不执行、鼠标停在按下态。
            // 对未按下的鼠标发 release 是空操作，提前置位无副作用。
            pressed = true;
            await cdpSend(from.tab.id, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: sx, y: sy, button, clickCount: 0 });
            await cdpSend(from.tab.id, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: sx, y: sy, button, buttons: 1, clickCount: 1 });
            for (const p of path) {
                await cdpSend(from.tab.id, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button, buttons: 1, clickCount: 0 });
                // 硬期限检查：被节流时单步 setTimeout 会被拉长到秒级，继续逐点发会撞服务端超时
                if (Date.now() > hardDeadline) { truncated = true; break; }
                if (stepDelay > 0) {
                    await new Promise(r => setTimeout(r, Math.max(1, Math.round(stepDelay * (0.7 + Math.random() * 0.6)))));
                }
            }
            if (truncated) {
                // 截断也要把轨迹补到终点（保证 mouseReleased 的落点正确）
                await cdpSend(from.tab.id, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: lastPt.x, y: lastPt.y, button, buttons: 1, clickCount: 0 });
            }
            if (holdBeforeReleaseMs > 0) await new Promise(r => setTimeout(r, holdBeforeReleaseMs));
            await cdpSend(from.tab.id, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: lastPt.x, y: lastPt.y, button, buttons: 0, clickCount: 1 });
            pressed = false;
            // V4.9.40（验收 Y1）：tabActive 要**拖拽后重新取**——原实现读的是解析起点时的旧快照，
            // 而上面已经 bringToFront 激活了标签，于是"完整成功"的拖拽仍报 tabActive=false + 假警告。
            let tabActiveAfter = null;
            try { const t = await chrome.tabs.get(from.tab.id); tabActiveAfter = !!t.active; } catch (e) { /* 取不到则 null=未知 */ }
            const result = {
                success: true,
                method: 'CDP 真实拖拽（isTrusted=true）',
                from: { x: sx, y: sy },
                to: { x: lastPt.x, y: lastPt.y },
                distance: { dx: lastPt.x - sx, dy: lastPt.y - sy },
                trajectory: { steps: path.length - 1, durationMs, easing, jitter: jitter > 0 ? jitter : 0 },
                element: from.element || null,
                ...(toInfo ? { toElement: toInfo } : {}),
                // V4.9.40（验收 Y7）：改名口径——elapsedMs 是**整个调用**耗时（含解析起点/终点/激活/attach），
                // 不是"轨迹耗时"；轨迹耗时是 trajectory.durationMs（目标值，节流时会超）
                elapsedMs: Date.now() - t0All,
                trajectoryMs: Date.now() - t0,
                ...(scrollAdjusted ? { scrollAdjusted: true, scrollNote: '解析终点时页面发生滚动，起点已用元素文档坐标反算校正（V4.9.40 R1 修复）' } : {}),
                ...(coordWarn ? { coordinateWarning: coordWarn } : {}),
                ...(truncated
                    ? {
                        trajectoryTruncated: true,
                        throttleWarning: '轨迹被提前截断（耗时超过硬期限）——目标标签/浏览器窗口很可能被节流（后台标签或窗口失焦）。事件可能不完整（实测可能出现 move/up 到了但 down 丢失），先把标签和浏览器窗口带到前台再重试'
                    }
                    : {}),
                // tabActive 三态：true=拖拽后确认激活 / false=后台 / null=取不到（不猜）
                tabActive: tabActiveAfter,
                ...(tabActiveAfter === false
                    ? { throttleWarning: '目标标签在后台（active=false）——Chrome 会节流后台标签：CDP 输入可能被静默吞掉、定时器被拉长（实测后台标签拖拽事件全丢、超时）。需要可靠拖拽请先激活该标签（new_tab 的 active=true，或手动点一下该标签）后重试' }
                    : {})
            };
            applyClickWarnings(result, from, index);
            return result;
        } catch (e) {
            // 按下后中途失败：必须把鼠标放开（否则页面卡在按住状态）
            if (pressed) {
                try { await cdpSend(from.tab.id, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: sx, y: sy, button, buttons: 0, clickCount: 1 }); } catch (e2) { /* 忽略 */ }
            }
            throw e;
        }
    }), { dialogPolicy: onDialog });
    if (verify) out.actionVerify = verify;
    return out;
}

// V4.9.40：分步拖拽的"按下状态"记忆（tabId 集合）。
// 为什么需要：down 之后同一标签的 move **必须带 buttons=1**——部分滑块/拖拽组件在 mousemove 里检查
// event.buttons/which 判断是否处于拖拽态；原实现 move 不传 buttons（CDP 默认 0），分步拖拽可能完全无效。
// 显式维护比依赖"CDP 跨 detach 保留按键状态"更可靠（后者正是验收的待确认项）。
const mousePressedTabs = new Set();

// 低层鼠标原语（滑块验证码调试用）：move / down / up / drag 分别发送。
// 使用场景：需要"先按住 → 看页面反馈 → 分几次微调"——一次 real_drag 做不到的精细控制。
// V4.9.40（独立验收 Y2/N4 + 实现者自查 S1）：
//  · 补 bringToFront + 焦点恢复租约（后台标签的输入会被吞，与 real_drag 同策略）
//  · 补硬期限 / drag 视口钳制 / tabActive 警告 —— 原实现隐藏窗口下 down/move/up **全 success 但页面什么都没收到**，且无任何警告
//  · move 带 buttons=1（按下态记忆），见 mousePressedTabs
async function mouseControl({ action, x, y, toX, toY, steps = 24, durationMs = 800, easing = 'human', jitter = 1.5, button = 'left', clickCount = 1, tabId, hostname }) {
    const tab = await requireTab({ tabId, hostname });
    const px = Number.isFinite(x) ? x : 0;
    const py = Number.isFinite(y) ? y : 0;
    const t0 = Date.now();
    return withDebugger(tab.id, async () => {
        // 激活标签 + 焦点恢复租约（与 real_drag 一致：会恢复用户原标签，不硬抢）
        let prevActiveId = null;
        try { const [cur] = await chrome.tabs.query({ active: true, currentWindow: true }); prevActiveId = cur && cur.id; } catch (e) { /* 忽略 */ }
        try { await cdpSend(tab.id, 'Page.bringToFront'); } catch (e) { /* 忽略 */ }
        if (prevActiveId && prevActiveId !== tab.id) {
            try { selfActivateMark.set(tab.id, Date.now()); } catch (e) { /* 忽略 */ }
            try { scheduleFocusRestore(tab.id, prevActiveId); } catch (e) { /* 忽略 */ }
        }
        // 视口 + 滚动（drag 钳制用）
        let vw = 0, vh = 0, scrollX = 0, scrollY = 0;
        try {
            const lm = await cdpSend(tab.id, 'Page.getLayoutMetrics');
            const css = (lm && lm.cssLayoutViewport) || (lm && lm.layoutViewport) || null;
            if (css) {
                vw = Number(css.clientWidth || 0); vh = Number(css.clientHeight || 0);
                scrollX = Number(css.pageX || 0); scrollY = Number(css.pageY || 0);
            }
        } catch (e) { /* 忽略 */ }
        // 拖拽后的真实激活态（非旧快照；取不到为 null=未知，不猜）
        let tabActiveAfter = null;
        try { const t = await chrome.tabs.get(tab.id); tabActiveAfter = !!(t && t.active); } catch (e) { tabActiveAfter = null; }
        const finish = (payload) => ({
            ...payload,
            tabActive: tabActiveAfter,
            elapsedMs: Date.now() - t0,
            ...(tabActiveAfter === false
                ? { throttleWarning: '目标标签在后台（active=false）——CDP 输入可能被节流吞掉（实测隐藏窗口下 down/up 均未投递）；先激活标签/窗口再重试' }
                : {})
        });

        if (action === 'move') {
            const held = mousePressedTabs.has(tab.id);
            await cdpSend(tab.id, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py, button, buttons: held ? 1 : 0, clickCount: 0 });
            return finish({ success: true, action, x: px, y: py, buttons: held ? 1 : 0, pressedState: held ? 'held' : 'released' });
        }
        if (action === 'down') {
            mousePressedTabs.add(tab.id);
            await cdpSend(tab.id, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: px, y: py, button, buttons: 1, clickCount });
            return finish({ success: true, action, x: px, y: py, note: '已按下——后续 move 会带 buttons=1（V4.9.40 状态记忆），up 释放' });
        }
        if (action === 'up') {
            await cdpSend(tab.id, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: px, y: py, button, buttons: 0, clickCount });
            mousePressedTabs.delete(tab.id);
            return finish({ success: true, action, x: px, y: py });
        }
        if (action === 'drag') {
            // 低层 drag：一次完成 down → 拟人 move → up（不做元素解析；坐标由调用方给）
            const tx0 = Number.isFinite(toX) ? toX : px;
            const ty0 = Number.isFinite(toY) ? toY : py;
            let tx = tx0, ty = ty0;
            if (vw > 0 && vh > 0) {   // V4.9.40（验收 N4/S6）：与 real_drag 一致做视口钳制
                tx = Math.max(0, Math.min(vw - 1, tx));
                ty = Math.max(0, Math.min(vh - 1, ty));
            }
            const path = buildDragPath(px, py, tx, ty, { steps: Number.isFinite(steps) ? steps : 24, easing, jitter });
            const stepDelay = Math.max(0, durationMs) / Math.max(1, path.length);
            const lastPt = path[path.length - 1];
            let pressed = false;
            let truncated = false;
            // V4.9.40（验收 N4）：与 real_drag 同一套硬期限，防节流标签上撞服务端超时且迟迟不释放
            const hardDeadline = Date.now() + Math.max(5000, durationMs * 3 + 3000);
            try {
                pressed = true;
                mousePressedTabs.add(tab.id);
                await cdpSend(tab.id, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: px, y: py, button, buttons: 1, clickCount: 1 });
                for (const p of path) {
                    await cdpSend(tab.id, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button, buttons: 1, clickCount: 0 });
                    if (Date.now() > hardDeadline) { truncated = true; break; }
                    if (stepDelay > 0) await new Promise(r => setTimeout(r, Math.max(1, Math.round(stepDelay * (0.7 + Math.random() * 0.6)))));
                }
                if (truncated) {
                    await cdpSend(tab.id, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: lastPt.x, y: lastPt.y, button, buttons: 1, clickCount: 0 });
                }
                await cdpSend(tab.id, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: lastPt.x, y: lastPt.y, button, buttons: 0, clickCount: 1 });
                pressed = false;
                mousePressedTabs.delete(tab.id);
                return finish({
                    success: true, action: 'drag',
                    from: { x: px, y: py }, to: { x: lastPt.x, y: lastPt.y },
                    trajectory: { steps: path.length - 1, durationMs, easing, jitter: jitter > 0 ? jitter : 0 },
                    ...(truncated ? { trajectoryTruncated: true } : {})
                });
            } catch (e) {
                if (pressed) { try { await cdpSend(tab.id, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: px, y: py, button, buttons: 0, clickCount: 1 }); } catch (e2) { /* 忽略 */ } }
                mousePressedTabs.delete(tab.id);
                throw e;
            }
        }
        throw new Error(`未知 action: ${action}（支持 move / down / up / drag）`);
    });
}

// CDP 键码映射（常用按键的 windowsVirtualKeyCode）
const CDP_KEY_MAP = {
    'enter': { key: 'Enter', code: 'Enter', vk: 13 },
    'tab': { key: 'Tab', code: 'Tab', vk: 9 },
    'escape': { key: 'Escape', code: 'Escape', vk: 27 },
    'esc': { key: 'Escape', code: 'Escape', vk: 27 },
    'backspace': { key: 'Backspace', code: 'Backspace', vk: 8 },
    'delete': { key: 'Delete', code: 'Delete', vk: 46 },
    'arrowup': { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
    'arrowdown': { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
    'arrowleft': { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
    'arrowright': { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
    'home': { key: 'Home', code: 'Home', vk: 36 },
    'end': { key: 'End', code: 'End', vk: 35 },
    'pageup': { key: 'PageUp', code: 'PageUp', vk: 33 },
    'pagedown': { key: 'PageDown', code: 'PageDown', vk: 34 },
    'space': { key: ' ', code: 'Space', vk: 32 },
};

// 真实按键（Enter/Tab/Escape/方向键等）：rawKeyDown → keyUp
async function realKey({ key, selector, wait = 3000, index = 0, tabId, hostname }) {
    if (!key) throw new Error('必须提供 key');
    const mapped = CDP_KEY_MAP[key.toLowerCase()];
    if (!mapped) throw new Error(`不支持的按键: ${key}（支持：${Object.keys(CDP_KEY_MAP).join('/')}）`);

    const tab = await requireTab({ tabId, hostname });

    // 指定 selector 时先点击聚焦该元素（真实点击保证焦点）
    // 2026-10-13 审计 L6：透传目标 tab——原实现不带参数，内部点击落在**活动标签页**
    //（多标签场景点错页面）；审计 L3：透传 index；点错风险警告一并带回（原被静默吞掉）
    let focusClick = null;
    if (selector) {
        focusClick = await realClick({ selector, wait, index, tabId: tab.id });
    }
    return withDebugger(tab.id, async () => {
        const base = { key: mapped.key, code: mapped.code, windowsVirtualKeyCode: mapped.vk, nativeVirtualKeyCode: mapped.vk };
        // Enter 需带 text:'\r'（触发 keypress/表单提交）、Space 需带 text:' '（在输入框中插入空格）；
        // 纯控制键用 rawKeyDown（与 Puppeteer 一致：无 text 时不派发字符）
        const isEnter = mapped.key === 'Enter';
        const isSpace = mapped.key === ' ';
        const downParams = isEnter ? { ...base, text: '\r' }
            : isSpace ? { ...base, text: ' ' }
            : base;
        await cdpSend(tab.id, 'Input.dispatchKeyEvent', { type: isEnter || isSpace ? 'keyDown' : 'rawKeyDown', ...downParams });
        await cdpSend(tab.id, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });
        const out = { success: true, method: 'CDP 真实按键（isTrusted=true）', key: mapped.key, focusedViaSelector: !!selector };
        if (focusClick) {
            const fw = {};
            for (const k of ['warning', 'occlusionWarning', 'clickPointNote', 'clickWillMissWarning', 'outOfViewportWarning', 'emptyPointWarning', 'actionVerify']) {
                if (focusClick[k]) fw[k] = focusClick[k];
            }
            if (Object.keys(fw).length) out.focusClickWarnings = fw;
        }
        return out;
    });
}

// 真实键入：逐字符 CDP 输入（isTrusted=true，触发页面 keydown/input 全链路）
// ASCII 可打印字符 → keyDown(text)+keyUp 逐字符（可带 delay 模拟人工节奏）；
// 非 ASCII（中文等）→ CDP Input.insertText 整段插入（同样 isTrusted=true）
async function realType({ selector, text, delay = 60, submit = false, clear = true, wait = 3000, index = 0, tabId, hostname }) {
    if (!text && text !== '') throw new Error('必须提供 text');

    const tab = await requireTab({ tabId, hostname });

    // 先真实点击聚焦输入框（2026-10-13 审计 L6：透传目标 tab——原实现不带参数，
    // 聚焦点击落在**活动标签页**，多标签场景点错页面；审计 L3：透传 index；点错风险警告一并带回）
    let focusClick = null;
    if (selector) {
        focusClick = await realClick({ selector, wait, index, tabId: tab.id });
    }

    return withDebugger(tab.id, async () => {
        // 清空已有内容：真实键盘路径 Ctrl+A → Backspace（isTrusted=true，
        // 天然支持 text=/index 定位的元素——旧版 executeScript querySelector 对 text= 会抛 SyntaxError）
        if (selector && clear) {
            const keyA = { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 }; // modifiers:2 = Ctrl
            await cdpSend(tab.id, 'Input.dispatchKeyEvent', { type: 'keyDown', ...keyA, text: 'a', unmodifiedText: 'a' });
            await cdpSend(tab.id, 'Input.dispatchKeyEvent', { type: 'keyUp', ...keyA });
            const backspace = CDP_KEY_MAP['backspace'];
            const bsBase = { key: backspace.key, code: backspace.code, windowsVirtualKeyCode: backspace.vk, nativeVirtualKeyCode: backspace.vk };
            await cdpSend(tab.id, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', ...bsBase });
            await cdpSend(tab.id, 'Input.dispatchKeyEvent', { type: 'keyUp', ...bsBase });
        }

        const hasNonAscii = /[^\x20-\x7E]/.test(text);
        if (hasNonAscii) {
            // 含中文等非 ASCII：整段 insertText（逐字符 keydown 无法生成 IME 文本）
            await cdpSend(tab.id, 'Input.insertText', { text });
        } else {
            for (const ch of text) {
                const base = { key: ch, code: '', windowsVirtualKeyCode: ch.charCodeAt(0), nativeVirtualKeyCode: ch.charCodeAt(0) };
                await cdpSend(tab.id, 'Input.dispatchKeyEvent', { type: 'keyDown', ...base, text: ch, unmodifiedText: ch });
                await cdpSend(tab.id, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });
                if (delay > 0) await new Promise(r => setTimeout(r, delay));
            }
        }

        if (submit) {
            const enter = CDP_KEY_MAP['enter'];
            const base = { key: enter.key, code: enter.code, windowsVirtualKeyCode: enter.vk, nativeVirtualKeyCode: enter.vk };
            await cdpSend(tab.id, 'Input.dispatchKeyEvent', { type: 'keyDown', ...base, text: '\r' });
            await cdpSend(tab.id, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });
        }
        const out = {
            success: true,
            method: 'CDP 真实键入（isTrusted=true）',
            length: text.length,
            mode: hasNonAscii ? 'insertText（含非 ASCII 字符）' : `逐字符键入（delay=${delay}ms）`,
            submitted: !!submit,
            cleared: !!selector && clear
        };
        if (focusClick) {
            const fw = {};
            for (const k of ['warning', 'occlusionWarning', 'clickPointNote', 'clickWillMissWarning', 'outOfViewportWarning', 'emptyPointWarning', 'actionVerify']) {
                if (focusClick[k]) fw[k] = focusClick[k];
            }
            if (Object.keys(fw).length) out.focusClickWarnings = fw;
        }
        return out;
    });
}

// 处理 JavaScript 对话框（2026-10-13 审计 M5）：探针能报 dialogOpened 但项目原本没有处理手段——
// 对话框阻塞渲染进程，期间所有注入/截图/慢路径全部停摆（防调试 alert 是渗透站常客）。
// 这是"确认/取消"的逃生口。不要求 Page.enable（handleJavaScriptDialog 是命令不是事件）
async function handleDialog({ accept = true, promptText, tabId, hostname } = {}) {
    const tab = await requireTab({ tabId, hostname });
    return withDebugger(tab.id, async () => {
        try {
            // 2026-10-13 实测结论：对话框只与"弹框时刻活着的 CDP 会话"关联——事后新 attach 接管不了
            // （"No dialog is showing"；补 Page.enable 也无效，已实测）。本工具只在"探针会话仍挂着"的
            // 窗口有效（cdpAcquire 经 isOurAttach 采纳残留会话——同日 M5 的成功正是此路径）。
            // 根治方案：real_click / click_element 的 on_dialog 参数（在动作会话内处理）
            const params = { accept: accept !== false };
            // bug-hunt（2026-10-13）：判据改 !== undefined——原"空串当未提供"会把 promptText:""
            // （意图=清空后确认）静默降级成"用页面预填值确认"，副作用语义被悄悄改写
            if (promptText !== undefined && promptText !== null) params.promptText = String(promptText);
            await cdpSend(tab.id, 'Page.handleJavaScriptDialog', params);
            return { success: true, method: 'CDP Page.handleJavaScriptDialog', accepted: accept !== false, ...(params.promptText ? { promptText: params.promptText } : {}) };
        } catch (e) {
            throw new Error(`处理对话框失败: ${String((e && e.message) || e)}。注意（2026-10-13 实测）：对话框只与"弹出它时活着的 CDP 会话"关联——页面在无会话期间弹出的对话框，本工具（新会话）接管不了。请在 real_click / click_element 上用 on_dialog 参数在**动作会话内**处理；若触发对话框的动作刚超时返回（探针会话可能仍挂着），可**立即重试本工具**（会谈上残留会话）`);
        }
    });
}

// ===== 2026-10-13：a11y 树 ref 元素定位（映射自 chrome-devtools-mcp 的 uid 机制）=====
// 背景：CSS selector 歧义是"点错元素"的头号原因（学习通实测）。三大主流浏览器 MCP 的共识——
// 用 a11y 树给元素分配机器编号（ref），AI 先快照拿 ref 再操作，从根本上消灭选择器歧义。
// 实现映射自 ChromeDevTools/chrome-devtools-mcp 源码（Accessibility.ts / TextSnapshot.ts / McpPage.ts）：
//   · 身份键 `frameId_backendNodeId` 挂 page 级 Map（跨快照存活）→ 同 document 同节点复用旧 ref
//     （跨多轮操作稳定：AI 快照一次可多轮引用，不因中间重新快照而指向别的元素）
//   · 每次快照未见到的键删除（节点消失后重现会分新 ref）
//   · 防误指三件套（PR #2788 形态）：① 无效节点（backendNodeId 缺失/≤0、frameId 缺失）不给 ref
//     （issue #2960 教训）② 重复 key **歧义作废**、不共享 ref ③ 解析前后双重 loaderId 校验；
//     解析失败一律显式报错"请重新快照"，绝不静默落到别的元素
//   · 树 = Accessibility.getFullAXTree 的扁平数组按 childIds 连接（CDP 不返回现成树）
const axRefTables = new Map(); // tabId -> { byBackendKey: Map, byRef: Map, snapshotCounter, loaderId }

// 过滤判据的角色表（照抄 isInteresting）
const AX_CONTROL_ROLES = new Set(['button', 'checkbox', 'ColorWell', 'combobox', 'DisclosureTriangle', 'listbox', 'menu', 'menubar', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'radio', 'scrollbar', 'searchbox', 'slider', 'spinbutton', 'switch', 'tab', 'textbox', 'tree', 'treeitem']);
const AX_LANDMARK_ROLES = new Set(['banner', 'complementary', 'contentinfo', 'form', 'main', 'navigation', 'region', 'search']);
const AX_LEAF_ROLES = new Set(['LineBreak', 'text', 'InlineTextBox', 'StaticText']);
const AX_SHOW_PROPS = new Set(['checked', 'disabled', 'expanded', 'selected', 'focused', 'required', 'pressed', 'valuetext', 'value', 'level', 'haspopup']);

// a11y 树快照（带 ref）——AI 先快照，再用 ref 操作元素
async function takeA11ySnapshot({ filter = '', limit = 200, tabId, hostname } = {}) {
    const tab = await requireTab({ tabId, hostname });

    return withDebugger(tab.id, async () => {
        // 当前 loaderId（供 ref 失效校验——存表对照）
        let curLoaderId = '';
        try {
            const ft = await cdpSend(tab.id, 'Page.getFrameTree');
            curLoaderId = (ft && ft.frameTree && ft.frameTree.frame && ft.frameTree.frame.loaderId) || '';
        } catch (e) { /* 取不到则不校验 loaderId（frameId 键仍能防跨导航复用） */ }

        // DOM agent 激活（2026-10-13 实测：未激活时 getFullAXTree 的节点普遍没有 backendDOMNodeId，
        // 只有 document 根（固定 bnode）有 → ref 分不出来。源实现背后是 Puppeteer 会话常驻 DOM enabled，
        // 裸 CDP 需要自己激活；DOM.getDocument 一次调用即可）
        await cdpSend(tab.id, 'DOM.getDocument', { depth: 0 });
        await cdpSend(tab.id, 'Accessibility.enable');
        let nodes = [];
        try {
            const r = await cdpSend(tab.id, 'Accessibility.getFullAXTree', {});
            nodes = (r && r.nodes) || [];
        } finally {
            // 及时 disable：AX 树持续计算有开销；DOM.resolveNode 等解析命令不依赖本域
            try { await cdpSend(tab.id, 'Accessibility.disable'); } catch (e) { /* 忽略 */ }
        }
        if (!nodes.length) throw new Error('a11y 树为空（页面可能无内容或尚未加载完成）');

        // 建树：nodeId → 节点 map，按 parentId 归位（与 childIds 等价——CDP 只给扁平数组；N3 措辞修正）
        const byId = new Map();
        for (const n of nodes) { n.__adbkids = []; byId.set(n.nodeId, n); }
        let root = null;
        for (const n of nodes) {
            if (n.parentId && byId.has(n.parentId)) byId.get(n.parentId).__adbkids.push(n);
            else if (!root) root = n;
            else root.__adbkids.push(n);   // L5（第四批审计）：孤儿节点（parentId 不在响应里）挂到 root，防静默丢弃
        }
        if (!root) root = nodes[0];

        // ref 表（page 级、跨快照存活）
        let tbl = axRefTables.get(tab.id);
        if (!tbl) { tbl = { byBackendKey: new Map(), byRef: new Map(), snapshotCounter: 0, loaderId: '' }; axRefTables.set(tab.id, tbl); }
        tbl.snapshotCounter += 1;
        tbl.loaderId = curLoaderId;
        const snapshotId = tbl.snapshotCounter;
        let counter = 0;
        const seenKeys = new Set();

        const propsOf = (n) => {
            const out = {};
            for (const p of (n.properties || [])) { if (p && p.name) out[p.name] = p.value ? p.value.value : undefined; }
            return out;
        };
        // 过滤判据（非 interesting 节点不上行、**子节点深度上提**）。角色表与 Chromium 的
        // kControlRoles/kLandmarkRoles/kLeafRoles 一致——上游 chrome-devtools-mcp 把过滤交给
        // Puppeteer/Chromium 侧，我们裸 CDP 自实现同一语义（第四批审计 N1 出处修正）
        const isInteresting = (n) => {
            const role = (n.role && n.role.value) || '';
            const p = propsOf(n);
            if (n.ignored === true || role === 'Ignored' || role === 'none' || p.hidden === true) return false;
            if (AX_LANDMARK_ROLES.has(role)) return true;
            if (p.focusable || p.richlyEditable || p.busy || (p.live && p.live !== 'off') || p.modal || p.roledescription) return true;
            if (AX_CONTROL_ROLES.has(role)) return true;
            if (p.insideControl) return false;
            const isLeaf = p.plainTextField || AX_LEAF_ROLES.has(role);
            return !!(isLeaf && ((n.name && n.name.value) || (n.description && n.description.value)));
        };
        // 节点身份键（issue #2960 教训：backendDOMNodeId 缺失/非法会使 key 退化撞键——verbose 下
        // 所有 InlineTextBox 曾共用一个 uid、点击报"元素不存在"）。bnode 缺失必须拒绝（无法 resolveNode）；
        // frameId 缺失退化为 'mf'（主帧）——跨帧撞键由下方"重复作废"兜底，不会误指。
        // N2（第四批审计）：键用 frameId 而非上游的 loaderId——裸 CDP 的 AXNode **不携带 loaderId**
        // （那是 Puppeteer 从 frameNavigated 自补的），硬用会退化成 #2960 的撞键形态；
        // 导航隔离改由 byRef 条目里的创建世代（loaderId 字段）+ 世代校验承担（见 assignRef / resolveAxRef）
        const axNodeKey = (n) => {
            const bnode = n.backendDOMNodeId;
            if (typeof bnode !== 'number' || bnode <= 0) return '';
            const fid = n.frameId || 'mf';
            return `${fid}_${bnode}`;
        };
        // PR #2788 形态：全树先统计 key 频次——**重复 key 直接作废**（不共享 ref、不回落，防撞键误指）。
        // diag 计数用于定位"拿不到 ref"的真实原因（2026-10-13 首测只有根节点有 ref 的排查）
        const diag = { noBnode: 0, noFrame: 0, dupKey: 0 };
        const keyCounts = new Map();
        const collectKeys = (n) => {
            if (isInteresting(n)) {
                const bnode = n.backendDOMNodeId;
                if (typeof bnode !== 'number' || bnode <= 0) diag.noBnode++;
                else if (!n.frameId) diag.noFrame++;
                const k = axNodeKey(n);
                if (k) keyCounts.set(k, (keyCounts.get(k) || 0) + 1);
            }
            for (const c of n.__adbkids) collectKeys(c);
        };
        collectKeys(root);
        for (const cnt of keyCounts.values()) if (cnt > 1) diag.dupKey++;

        const assignRef = (n) => {
            const key = axNodeKey(n);
            if (!key) return '';
            if ((keyCounts.get(key) || 0) > 1) return '';   // 歧义作废（PR #2788 形态）
            // M1 修复（第四批审计实测复现）：键命中但**世代不符**（跨文档导航后 frameId 不变、同键节点
            // 可能撞车——上游用 loaderId 作键天然隔离，我们的 frameId 键没有）→ 当新节点处理：
            // 作废旧 ref、发新 ref——防止"重新快照后旧 ref 字符串被原样复用、静默指向新文档同键节点"
            const gen = tbl.loaderId || '';
            let ref = tbl.byBackendKey.get(key);
            if (ref) {
                const ent = tbl.byRef.get(ref);
                if (ent && ent.loaderId && gen && ent.loaderId !== gen) {
                    tbl.byRef.delete(ref);
                    ref = null;
                }
            }
            if (!ref) {
                ref = `${snapshotId}_${++counter}`;
                tbl.byBackendKey.set(key, ref);
                tbl.byRef.set(ref, {
                    backendNodeId: n.backendDOMNodeId, frameId: n.frameId || '',
                    loaderId: gen,
                    role: (n.role && n.role.value) || '',
                    name: ((n.name && n.name.value) || '').slice(0, 80)
                });
            }
            return ref;
        };

        const fLow = String(filter || '').toLowerCase();
        const lines = [];
        let emitted = 0, truncated = 0;
        const walk = (n, depth, parentRole) => {
            const role = (n.role && n.role.value) || '';
            const name = (n.name && n.name.value) || '';
            // 冗余削减（源项目 #2895/#2896 同款）：StaticText 下的 InlineTextBox 不重复输出
            //（其文本与父行相同——否则每个文本在树里出现两遍）
            const redundantInline = role === 'InlineTextBox' && parentRole === 'StaticText';
            let nextDepth = depth;
            if (isInteresting(n)) {
                if (!redundantInline) {
                    const k = axNodeKey(n);
                    if (k) seenKeys.add(k);
                    const hitFilter = !fLow || role.toLowerCase().includes(fLow) || name.toLowerCase().includes(fLow);
                    if (hitFilter) {
                        if (emitted >= limit) { truncated++; }
                        else {
                            const ref = assignRef(n);
                            const attrs = [];
                            if (ref) attrs.push(`uid=${ref}`);
                            if (role && role !== 'StaticText') attrs.push(role);
                            // N4（第四批审计）：引号转义——页面可控的 name 可塞引号伪造 uid token 样式（换行已折叠）
                            if (name) attrs.push(`"${name.replace(/\s+/g, ' ').replace(/"/g, "'").slice(0, 100)}"`);
                            const p = propsOf(n);
                            for (const k of AX_SHOW_PROPS) {
                                if (p[k] === undefined) continue;
                                if (typeof p[k] === 'boolean') { if (p[k]) attrs.push(k); }
                                else if (p[k] !== '') attrs.push(`${k}="${String(p[k]).slice(0, 40)}"`);
                            }
                            lines.push(`${' '.repeat(depth * 2)}${attrs.join(' ')}`);
                            emitted++;
                        }
                    }
                }
                nextDepth = depth + 1;
            }
            for (const c of n.__adbkids) walk(c, nextDepth, role);
        };
        walk(root, 0, '');

        // 清理：本次未见到的键删除（照抄 TextSnapshot 的清理语义）
        for (const key of [...tbl.byBackendKey.keys()]) {
            if (!seenKeys.has(key)) {
                const ref = tbl.byBackendKey.get(key);
                tbl.byBackendKey.delete(key);
                tbl.byRef.delete(ref);
            }
        }

        return {
            success: true,
            snapshotId,
            liveRefs: tbl.byRef.size,   // 表内总存活 ref 数（跨快照累计）；shown 是本次输出数（第四批审计 L6）
            shown: emitted,
            ...(truncated ? { truncated, note: `已按 limit=${limit} 截断 ${truncated} 个节点（提高 limit 或用 filter 收窄）` } : {}),
            ...((diag.noBnode || diag.noFrame || diag.dupKey) ? { diag } : {}),
            ...(diag.noFrame ? { frameNote: `${diag.noFrame} 个节点缺 frameId（按主帧处理）——同键撞车已按歧义作废（树中无 uid 的行即因此没有 ref）` } : {}),
            ...(tbl.loaderId ? {} : { loaderNote: '未取到当前文档 loaderId（页面冻结等）——ref 的跨导航失效保护本次不可用' }),
            tree: lines.join('\n'),
            usage: '用 ref 操作：real_click / click_element 传 ref 参数（如 "2_5"）；页面导航/刷新后旧 ref 失效（操作时明确报错，重新快照即可）。注意：ref 只覆盖 a11y 认定的可交互/有语义节点——<div onclick> 等无 role/name 的元素没有 uid，请回退 selector 或 text='
        };
    });
}

// ref → 元素解析（realClick / clickElement 共用）。
// 失效语义（照抄 chrome-devtools-mcp 的防护）：显式报错、**绝不回落**——
// 回落"同 role/name 的另一元素"是该机制最危险的事故形态（点错人）
async function resolveAxRef(tabId, ref) {
    const tbl = axRefTables.get(tabId);
    const entry = tbl && tbl.byRef.get(ref);
    if (!entry) {
        throw new Error(`ref "${ref}" 不在该标签页的快照表中——请先调用 take_a11y_snapshot 获取有效引用（页面导航/刷新后旧 ref 会全部失效）`);
    }
    // 条目级 loaderId 校验（第四批审计 M1 修订）：比对**该 ref 创建时的文档世代**——表级 tbl.loaderId
    // 在"导航后重新快照"时已被更新为新世代，拦不住"旧 ref 指向新文档同键节点"（审计实测 S7）
    try {
        const ft = await cdpSend(tabId, 'Page.getFrameTree');
        const cur = (ft && ft.frameTree && ft.frameTree.frame && ft.frameTree.frame.loaderId) || '';
        if (cur && entry.loaderId && cur !== entry.loaderId) {
            throw new Error(`ref "${ref}" 已失效（属于导航前的旧文档——该 ref 创建时的文档世代与当前不符）——请重新 take_a11y_snapshot`);
        }
    } catch (e) { if (String((e && e.message) || '').includes('已失效')) throw e; /* 取不到则跳过此防线 */ }
    // 解析回元素（DOM.resolveNode——与 chrome-devtools-mcp 的 adoptBackendNode 同源）
    let objectId = null;
    try {
        const r = await cdpSend(tabId, 'DOM.resolveNode', { backendNodeId: entry.backendNodeId });
        objectId = r && r.object && r.object.objectId;
    } catch (e) { /* 节点已不存在 → 下方统一报错（快速失败——源项目 issue #2994 教训：别拖成等待超时） */ }
    if (!objectId) {
        throw new Error(`ref "${ref}" 已失效（元素已从页面移除或 DOM 已重建）——请重新 take_a11y_snapshot`);
    }
    // 解析后二次校验（PR #2788 形态：resolve 期间 document 可能已变化，旧 ref 会解析到替换后的 renderer）。
    // 同样用**条目级**世代比对
    try {
        const ft2 = await cdpSend(tabId, 'Page.getFrameTree');
        const cur2 = (ft2 && ft2.frameTree && ft2.frameTree.frame && ft2.frameTree.frame.loaderId) || '';
        if (cur2 && entry.loaderId && cur2 !== entry.loaderId) {
            try { await cdpSend(tabId, 'Runtime.releaseObject', { objectId }); } catch (e) { /* 释放失败无碍 */ }
            throw new Error(`ref "${ref}" 在解析期间失效（页面发生了导航）——请重新 take_a11y_snapshot`);
        }
    } catch (e) { if (String((e && e.message) || '').includes('失效')) throw e; /* 校验调用自身失败则跳过（不阻塞正常操作） */ }
    return { objectId, entry };
}

// 重载扩展自身（2026-10-13 用户驱动）：chrome.runtime.reload 封装——**先返回响应、延迟 0.8s 再重载**
// （SW 重启、WS 自动重连；页面侧已注入的 hook/脚本不受影响）。用途：client 侧代码改动后 AI 自行闭环重载
async function reloadExtension() {
    setTimeout(() => { try { chrome.runtime.reload(); } catch (e) { /* reload 失败仅日志 */ } }, 800);
    return { success: true, note: '扩展将在约 0.8 秒后重载（SW 重启、MCP 自动重连）——短暂的连接中断属正常现象；重载会清空扩展内存态（a11y ref 表/缓存等），页面内已注入脚本不受影响' };
}

// 语义 DOM 快照：提取页面全部可交互元素为紧凑索引清单（AI 先拍快照，再用 selector/坐标操作）
// 设计借鉴 chrome-devtools-mcp 的 DOM snapshot + mcp-chrome 的内容分析
async function getSemanticDom({ filter = '', limit = 150, tabId, hostname } = {}) {
    const tab = await requireTab({ tabId, hostname });

    const results = await adbExecuteScript({
        target: { tabId: tab.id },
        func: (kw, maxItems) => {
            const selector = 'a, button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="switch"], [onclick], [contenteditable="true"], summary, label';
            const seen = new Set();
            const items = [];
            const selOf = (el) => {
                if (el.id) return `#${el.id}`;
                if (el.name) return `${el.tagName.toLowerCase()}[name="${el.name}"]`;
                if (el.type === 'password') return 'input[type="password"]';
                if (el.type === 'submit') return '[type="submit"]';
                return null; // 无稳定定位时由 text= 兜底
            };
            document.querySelectorAll(selector).forEach(el => {
                if (items.length >= maxItems) return;
                if (seen.has(el)) return;
                seen.add(el);
                const rect = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                const visible = rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
                if (!visible) return;

                const item = {
                    tag: el.tagName.toLowerCase(),
                    type: el.type || (el.getAttribute('role') || ''),
                    id: el.id || '',
                    name: el.name || '',
                    cls: (typeof el.className === 'string' ? el.className : '').split(/\s+/).slice(0, 3).join('.').slice(0, 60),
                    text: ((el.textContent || el.value || el.placeholder || '') + '').trim().replace(/\s+/g, ' ').slice(0, 50),
                    placeholder: el.placeholder || '',
                    disabled: el.disabled === true,
                    rect: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) },
                    sel: selOf(el)
                };
                if (el.tagName === 'SELECT') {
                    item.options = Array.from(el.options || []).slice(0, 20).map(o => o.text.trim().slice(0, 30));
                }
                // 关键字过滤（tag/id/name/text/placeholder 任意命中）
                if (kw) {
                    const hay = `${item.tag} ${item.id} ${item.name} ${item.cls} ${item.text} ${item.placeholder}`.toLowerCase();
                    if (!hay.includes(kw.toLowerCase())) return;
                }
                items.push(item);
            });
            return { url: location.href, title: document.title, count: items.length, truncated: items.length >= maxItems, items };
        },
        args: [filter || '', limit],
        world: 'MAIN'
    });

    const snap = results[0]?.result;
    if (!snap) throw new Error('语义快照提取失败');
    return {
        success: true,
        ...snap,
        hint: 'text= 语法按可见文本定位（自动忽略空格差异）；rect 为视口坐标可直接用于坐标点击；React/Vue 合成事件的 div/span 按钮不在快照中，此类元素用 x/y 坐标点击'
    };
}

// 截取屏幕（增强版：fullPage 走 CDP captureBeyondViewport，全页完整；AI 可直接看到图像）
async function takeScreenshot({ fullPage = false, selector, tabId, hostname } = {}) {
    const tab = await requireTab({ tabId, hostname });

    // 窗口最小化时 CDP captureScreenshot 报 "image readback failed"、captureVisibleTab 拿到黑图
    // ——先恢复窗口（不聚焦不抢前台）再截
    try {
        const win = await chrome.windows.get(tab.windowId);
        if (win.state === 'minimized') {
            await chrome.windows.update(tab.windowId, { state: 'normal' });
            await new Promise((r) => setTimeout(r, 300));
        }
    } catch (e) { /* 窗口可能已关闭，走原逻辑自然报错 */ }

    // 全页/元素截图走 CDP（captureVisibleTab 只能截可见区）
    if (fullPage || selector) {
        let clip;
        if (selector) {
            // 复用统一定位 helper：支持 text= 语法与 index 第 N 匹配（旧版 querySelector 对 text= 会抛错）
            // V4.9.1：传入已解析的 tab（审计 M3）——元素坐标必须在目标标签页上测量，而非活动标签页
            const target = await resolveInteractionTarget({ selector, wait: 3000, tab });
            if (!target.box || target.via !== 'selector') {
                throw new Error(`元素截图需要 selector 定位（坐标模式不支持）: ${selector}`);
            }
            // clip 是文档坐标系：resolveInteractionTarget 已含 scroll 偏移（旧版裸视口坐标在有滚动时错位）
            clip = { x: target.box.x, y: target.box.y, width: target.box.width, height: target.box.height, scale: 1 };
        }

        return withDebugger(tab.id, async () => {
            const shot = await cdpSend(tab.id, 'Page.captureScreenshot', {
                format: 'png',
                ...(clip ? { clip } : { captureBeyondViewport: true })
            });
            return {
                success: true,
                dataUrl: `data:image/png;base64,${shot.data}`,
                format: 'png',
                mode: selector ? 'element' : 'fullPage',
                timestamp: Date.now()
            };
        });
    }

    // 可视区截图：captureVisibleTab 在窗口被完全遮挡/特定 GPU 合成场景报 "image readback failed"
    // （实测 zb 站窗口正常可见也复现）——失败时降级 CDP（默认截视口，对窗口状态宽容）
    // V4.9.9.3（审计 High 修复）：captureVisibleTab(windowId) 截的是**该窗口的活动标签**——
    // V4.9.9 后台优先后目标标签不再被激活，直接调用会静默截到别的页面（success:true 无感知）。
    // 非活动目标直接走 CDP Page.captureScreenshot（按 tabId，与可见区截图等效且不受窗口状态影响）。
    let needCdpViewport = false;
    try {
        const [winActive] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
        needCdpViewport = !(winActive && winActive.id === tab.id);
    } catch (e) {
        // V4.9.28：查询失败**必须走 CDP**（按 tabId 精确截图）。原实现在这里保持 false、
        // 并注释成"保守走 captureVisibleTab 原路径"——那恰恰**不保守**：captureVisibleTab
        // 截的是该**窗口的活动标签**，而后台优先模式下目标通常不是活动标签，于是 AI 拿到
        // 的是**另一个页面**的截图，返回却仍是 success:true / mode:'viewport'，无任何标记。
        needCdpViewport = true;
    }
    if (needCdpViewport) {
        return withDebugger(tab.id, async () => {
            const shot = await cdpSend(tab.id, 'Page.captureScreenshot', { format: 'png' });
            return {
                success: true,
                dataUrl: `data:image/png;base64,${shot.data}`,
                format: 'png',
                mode: 'viewport(cdp)',
                timestamp: Date.now()
            };
        });
    }
    try {
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
        return {
            success: true,
            dataUrl,
            format: 'png',
            mode: 'viewport',
            timestamp: Date.now()
        };
    } catch (e) {
        return withDebugger(tab.id, async () => {
            const shot = await cdpSend(tab.id, 'Page.captureScreenshot', { format: 'png' });
            return {
                success: true,
                dataUrl: `data:image/png;base64,${shot.data}`,
                format: 'png',
                mode: 'viewport-cdp-fallback',
                fallbackReason: e.message,
                timestamp: Date.now()
            };
        });
    }
}

// 点击元素
async function clickElement({ selector, x, y, ref, dblClick = false, index = 0, onDialog, tabId, hostname }) {
    if (!ref && !selector && (x === undefined || y === undefined)) {
        // M5 修复：缺参时旧实现静默点击 (0,0)（页面左上角元素）——真实副作用风险
        throw new Error('必须提供 ref、selector 或完整 x/y 坐标（三者缺一会误点页面左上角）');
    }
    const tab = await requireTab({ tabId, hostname });

    // ref 路径（2026-10-13）：a11y 快照引用 → 合成事件直达元素（不受遮挡影响）
    if (ref) {
        const { result, verify } = await withActionProbe(tab.id, () => withDebugger(tab.id, async () => {
            const { objectId } = await resolveAxRef(tab.id, ref);
            // pickText / DOM 探测逻辑与 clickElement 的 selector 注入**保持同步（修改需两处一起）**
            const fnSrc = `async function () {
                const element = this;
                if (!element || element.nodeType !== 1) return JSON.stringify({ error: 'ref 指向的不是元素节点（请对父元素快照取 ref）' });
                if (element.disabled === true || element.getAttribute('aria-disabled') === 'true') return JSON.stringify({ error: '元素处于禁用状态（disabled）——点击不会生效' });
                // SYNC:pickText-v1（四处副本需同步修改）
                const pickText = (el) => {
                    if (!el) return '';
                    try {
                        const tag = el.tagName;
                        if (tag === 'SELECT') {
                            const so = el.selectedOptions && el.selectedOptions[0];
                            return String((so && so.textContent) || el.value || '').trim().slice(0, 60);
                        }
                        if (tag === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
                            const lb = el.labels && el.labels[0] ? el.labels[0].textContent : '';
                            return String(el.getAttribute('aria-label') || lb || el.value || '').trim().slice(0, 60);
                        }
                        const im = el.querySelector ? el.querySelector('img[alt]') : null;
                        return String(
                            el.getAttribute('aria-label') || el.getAttribute('title') ||
                            el.textContent || el.value || el.placeholder ||
                            (im ? im.getAttribute('alt') : '') || ''
                        ).trim().slice(0, 60);
                    } catch (e) { return ''; }
                };
                let muts = 0, ob = null, lastMutAt = 0;
                try {
                    ob = new MutationObserver((recs) => { muts += (recs ? recs.length : 1); lastMutAt = Date.now(); });
                    ob.observe(document.body || document.documentElement, { childList: true, subtree: true, attributes: true });
                } catch (e) { /* 观察不可用则跳过探测 */ }
                const r = element.getBoundingClientRect();
                const ev = new MouseEvent(${JSON.stringify(dblClick === true ? 'dblclick' : 'click')}, {
                    bubbles: true, cancelable: true, view: window, composed: true, detail: 1,
                    clientX: Math.round(r.left + r.width / 2), clientY: Math.round(r.top + r.height / 2)
                });
                element.dispatchEvent(ev);
                if (ob) {
                    await new Promise(res => {
                        const t0 = Date.now();
                        const tick = () => {
                            if (Date.now() - t0 >= 150) return res();
                            if (lastMutAt && Date.now() - lastMutAt >= 60) return res();
                            setTimeout(tick, 20);
                        };
                        setTimeout(tick, 20);
                    });
                    try { ob.disconnect(); } catch (e) { /* 已断开 */ }
                }
                const cls = element.className;
                return JSON.stringify({
                    success: true, element: element.tagName, id: element.id,
                    className: typeof cls === 'string' ? cls : String((cls && cls.baseVal) || ''),
                    text: pickText(element), matchedCount: 1, domMutations: muts
                });
            }`;
            let probe;
            try {
                probe = await cdpSend(tab.id, 'Runtime.callFunctionOn', { objectId, functionDeclaration: fnSrc, awaitPromise: true, returnByValue: true });
            } finally {
                // 远程对象用完即释放（防 objectId 泄漏）——释放失败无碍
                try { await cdpSend(tab.id, 'Runtime.releaseObject', { objectId }); } catch (e) { /* 忽略 */ }
            }
            let out = null;
            try { out = JSON.parse((probe && probe.result && probe.result.value) || ''); } catch (e) { /* 下方统一报错 */ }
            if (!out || out.error) {
                throw new Error('ref 点击失败: ' + ((out && out.error) || JSON.stringify((probe && probe.result) || {}).slice(0, 200)));
            }
            out.ref = ref;
            return out;
        }), { dialogPolicy: onDialog });
        if (verify) result.actionVerify = verify;
        return result;
    }

    return new Promise((resolve, reject) => {
        // 2026-10-13（审计 M2 实测驱动）：动作后验证包裹合成点击——点击引发导航时注入结果会随
        // 页面上下文销毁（实测：chrome.scripting 返回空结果，既不 hang 也不 reject、慢路径不启动、
        // **无双点**）；但返回字面"执行失败"会误导 AI 重试——**重试才是双点的真实来源**。
        // 用探针的 navigatedToUrl 补齐"结果不可读但导航了"的信息真空
        // S3 双执行守卫（bug-hunt 2026-10-13）：防"合成点击"双执行
        const dupTok = '__adbk_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        withActionProbe(tab.id, () => adbExecuteScript({
            target: { tabId: tab.id },
            // 2026-10-13（学习通实站驱动 + 审计修复）：增强——
            // ① index 参数：selector 命中多个时可选第 N 个（原实现只能取第一个，AI 遇歧义无解）
            // ② 返回 text + matchedCount：AI 事后能核对"点的是不是我要的元素"（选择器歧义是点错头号原因）
            // ③ MouseEvent 补 clientX/clientY：原实现坐标恒为 (0,0)，页面若用坐标做命中判定会判错
            // ④ text= 文本定位（审计 L3：real_click 的遮挡警告让"改用 click_element"，但对文本场景原不可用）
            // ⑤ domMutations（调研落地）：点击是否引发 DOM 变化——观察者先于点击装上（捕捉同步变化），
            //    点击后 150ms 收集；注入函数相应改 async（快慢路径都支持）
            // ⑥ pickText 取值链增强（审计 L2：select 拼全部 option / checkbox 恒 "on" / 图标按钮为空）
            func: async (__tok, sel, coordX, coordY, isDouble, nth) => {
                // S3 双执行守卫（bug-hunt 2026-10-13）
                if (window[__tok]) return { __adbDupSkipped: true };
                try { window[__tok] = 1; } catch (e) { /* window 冻结：fail-open 放行 */ }
                let element;
                let matchedCount = 0;
                if (sel) {
                    if (typeof sel === 'string' && sel.startsWith('text=')) {
                        const q = sel.slice(5).trim().toLowerCase().replace(/\s+/g, '');
                        if (!q) return { error: 'text= 文本定位缺少查询文本（用法：text=登录）' };
                        // 审计 M4/L7：此列表与 resolveInteractionTarget 的 findByText 保持一致；
                        // getSemanticDom 有独立的语义列表（含 role=checkbox/switch 等），刻意不同——勿盲目对齐
                        const all = document.querySelectorAll('a, button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [onclick], [type="submit"], [type="button"], [contenteditable="true"], summary, label');
                        const matches = [];
                        all.forEach(el => {
                            const t = ((el.textContent || el.value || el.placeholder || '')).trim().toLowerCase().replace(/\s+/g, '');
                            if (t && t.includes(q)) matches.push(el);
                        });
                        matchedCount = matches.length;
                        element = matches[nth] || null;
                    } else {
                        const matches = document.querySelectorAll(sel);
                        matchedCount = matches.length;
                        element = matches[nth] || null;
                    }
                    if (!element) {
                        return {
                            error: matchedCount > 0
                                ? `选择器命中 ${matchedCount} 个元素，但 index=${nth} 超出范围（可选 0-${matchedCount - 1}）：${sel}`
                                : `未找到元素: ${sel}`
                        };
                    }
                } else if (coordX !== undefined && coordY !== undefined) {
                    element = document.elementFromPoint(coordX, coordY);
                    matchedCount = 1;
                    if (!element) {
                        return { error: `坐标 (${coordX}, ${coordY}) 处没有元素` };
                    }
                } else {
                    return { error: '必须提供 selector 或 x/y 坐标' };
                }

                // 元素文本摘要（审计 L2 取值链）
                // SYNC:pickText-v1（四处副本需同步修改）
                const pickText = (el) => {
                    if (!el) return '';
                    try {
                        const tag = el.tagName;
                        if (tag === 'SELECT') {
                            const so = el.selectedOptions && el.selectedOptions[0];
                            return String((so && so.textContent) || el.value || '').trim().slice(0, 60);
                        }
                        if (tag === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
                            const lb = el.labels && el.labels[0] ? el.labels[0].textContent : '';
                            return String(el.getAttribute('aria-label') || lb || el.value || '').trim().slice(0, 60);
                        }
                        const im = el.querySelector ? el.querySelector('img[alt]') : null;
                        return String(
                            el.getAttribute('aria-label') || el.getAttribute('title') ||
                            el.textContent || el.value || el.placeholder ||
                            (im ? im.getAttribute('alt') : '') || ''
                        ).trim().slice(0, 60);
                    } catch (e) { return ''; }
                };

                // 动作后 DOM 探测：观察者**先于点击**装上（捕捉 onclick 内的同步 DOM 变化）。
                // 审计 L1：累加 records 数（原实现数回调批次，"变化数"名不副实）；记录最后变化时刻供静默判定
                let muts = 0, ob = null, lastMutAt = 0;
                try {
                    ob = new MutationObserver((recs) => { muts += (recs ? recs.length : 1); lastMutAt = Date.now(); });
                    ob.observe(document.body || document.documentElement, { childList: true, subtree: true, attributes: true });
                } catch (e) { /* 观察不可用则跳过探测 */ }

                const r = element.getBoundingClientRect();
                const clickEvent = new MouseEvent(isDouble ? 'dblclick' : 'click', {
                    bubbles: true,
                    cancelable: true,
                    view: window,
                    composed: true,   // 审计 L7：穿透 shadow DOM 边界（默认 false 时 shadow 内目标静默收不到）
                    detail: 1,        // 标准 click 的单击计数
                    clientX: Math.round(r.left + r.width / 2),
                    clientY: Math.round(r.top + r.height / 2)
                });
                element.dispatchEvent(clickEvent);

                if (ob) {
                    // 收集窗口（审计 L2）：上限 150ms；一旦出现变化且静默 60ms 即提前结束——批量点击省时。
                    // 注意：页面自身动画/计时器造成的非 0 只代表"DOM 有变化"，不代表"点击生效"（判定归 AI 层）
                    await new Promise(res => {
                        const t0 = Date.now();
                        const tick = () => {
                            if (Date.now() - t0 >= 150) return res();
                            if (lastMutAt && Date.now() - lastMutAt >= 60) return res();
                            setTimeout(tick, 20);
                        };
                        setTimeout(tick, 20);
                    });
                    try { ob.disconnect(); } catch (e) { /* 已断开 */ }
                }

                const cls = element.className;   // 审计 L6：SVG 的 className 是 SVGAnimatedString，直接序列化为 {}
                const out = {
                    success: true,
                    element: element.tagName,
                    id: element.id,
                    className: typeof cls === 'string' ? cls : String((cls && cls.baseVal) || ''),
                    text: pickText(element),
                    matchedCount,
                    domMutations: muts
                };
                if (matchedCount > 1) {
                    out.warning = `选择器命中 ${matchedCount} 个元素，本次点击第 ${nth + 1} 个（index=${nth}）——请用 text 字段核对是否为预期目标；如需点击其它元素请调整 index`;
                }
                return out;
            },
            args: [dupTok, selector || '', x ?? 0, y ?? 0, dblClick === true, index || 0],
            world: 'MAIN'
        }), { dialogPolicy: onDialog }).then(({ result: results, verify }) => {
            const r = results && results[0] ? results[0].result : undefined;
            const out = (r !== undefined && r !== null) ? r : {
                // 实测（2026-10-13）：点击引发导航/刷新时执行上下文销毁 → 结果不可读（空结果）。
                // 此时点击大概率**已成功**——如实标注，防止 AI 把"读不到结果"当"没点成功"而重试
                warning: '注入结果不可读——页面可能在点击后立即导航/刷新（执行上下文已销毁）。点击可能已成功，勿直接重试；先核对页面状态（get_page_info 看 URL / get_semantic_dom 看 DOM 变化）'
            };
            if (verify) out.actionVerify = verify;   // 探针补齐：结果不可读时 navigatedToUrl 仍能告诉你跳哪了
            resolve(out);
        }).catch(reject);
    });
}

// 填充输入框
async function fillInput({ selector, value, clear = true, tabId, hostname }) {
    const tab = await requireTab({ tabId, hostname });
    
    return new Promise((resolve, reject) => {
        // S3 双执行守卫（bug-hunt 2026-10-13）：快慢路径竞态下保证"填值"只执行一次
        const dupTok = '__adbk_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        adbExecuteScript({
            target: { tabId: tab.id },
            func: (__tok, sel, val, shouldClear) => {
                if (window[__tok]) return { __adbDupSkipped: true };
                try { window[__tok] = 1; } catch (e) { /* window 冻结：fail-open 放行 */ }
                const element = document.querySelector(sel);
                if (!element) {
                    return { error: `未找到元素: ${sel}` };
                }
                
                if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
                    element.focus();
                    // V4.9.41（fill_input 对 Vue v-model 不生效问题）：改用**原型上的原生 value setter**——
                    // ① 绕过 React 的 value tracker（直接 el.value= 会被 React 判为"未变更"而丢事件）；
                    // ② Vue 的 v-model 在 input 事件里读 event.target.value，setter 写进去后能读到；
                    // ③ 事件用 InputEvent（带 data/inputType），部分组件库检查事件类型。
                    const proto = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
                    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
                    const setVal = (v) => { if (desc && desc.set) desc.set.call(element, v); else element.value = v; };
                    if (shouldClear) setVal('');
                    setVal(val);
                    let ev;
                    try {
                        ev = new InputEvent('input', { bubbles: true, data: val, inputType: 'insertText' });
                    } catch (e) {
                        ev = new Event('input', { bubbles: true });
                    }
                    element.dispatchEvent(ev);
                    element.dispatchEvent(new Event('change', { bubbles: true }));
                    // 兼容 Vue2 的 $emit('input') 路径（v-model 有时依赖组件的 input 事件而非原生）
                    try {
                        if (element.__vue__ && typeof element.__vue__.$emit === 'function') element.__vue__.$emit('input', val);
                    } catch (e) { /* 忽略 */ }
                    return { success: true, value: element.value, method: 'native-value-setter + InputEvent' };
                } else if (element.tagName === 'SELECT') {
                    const sdesc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
                    if (sdesc && sdesc.set) sdesc.set.call(element, val); else element.value = val;
                    element.dispatchEvent(new Event('change', { bubbles: true }));
                    return { success: true, value: element.value };
                } else if (element.isContentEditable) {
                    element.focus();
                    if (shouldClear) {
                        element.textContent = '';
                    }
                    element.textContent = val;
                    element.dispatchEvent(new Event('input', { bubbles: true }));
                    return { success: true, value: element.textContent };
                }
                
                return { error: '元素不可编辑' };
            },
            args: [dupTok, selector || '', value ?? '', clear === true],
            world: 'MAIN'
        }).then(results => {
            resolve(results[0]?.result || { error: '执行失败' });
        }).catch(reject);
    });
}

// 按键
async function pressKey({ key, modifiers = [], tabId, hostname }) {
    const tab = await requireTab({ tabId, hostname });
    
    return new Promise((resolve, reject) => {
        // V4.9.36 双执行守卫（补漏）：本函数是**唯一漏网的「有副作用 + world:'MAIN'」调用点**。
        // 8s 快路径超时**不取消**已在飞的注入，CDP 慢路径会把**同一次按键再发一遍** ——
        // 而按键**不是幂等**的：回车可能提交两次表单、快捷键触发两次。
        // 全项目扫过一遍（temp/tool_double_exec_audit.js）：同族的 clickElement / fillInput /
        // autoFillForm / clickAndCapture / loginAndGetBurp / autoLoginAndCapture /
        // injectEncryptionCapture 共 7 处早已有守卫；scrollPage 虽也无守卫但
        // scrollTo / scrollIntoView **幂等**（重跑终态相同），故不加。
        // anonFetch / executeScript 走 ISOLATED，慢路径直接 fail-fast、不会重放；
        // decryptRSA / signPayload 是纯计算，重跑结果一样。
        const dupTok = '__adbk_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        adbExecuteScript({
            target: { tabId: tab.id },
            func: (__tok, k, mods) => {
                if (window[__tok]) return { __adbDupSkipped: true };
                try { window[__tok] = 1; } catch (e) { /* window 冻结：fail-open 放行 */ }
                const eventInit = {
                    key: k,
                    code: k,
                    bubbles: true,
                    cancelable: true,
                    ctrlKey: mods.includes('Control') || mods.includes('Ctrl'),
                    shiftKey: mods.includes('Shift'),
                    altKey: mods.includes('Alt'),
                    metaKey: mods.includes('Meta') || mods.includes('Command')
                };
                
                const activeElement = document.activeElement || document.body;
                activeElement.dispatchEvent(new KeyboardEvent('keydown', eventInit));
                activeElement.dispatchEvent(new KeyboardEvent('keypress', eventInit));
                activeElement.dispatchEvent(new KeyboardEvent('keyup', eventInit));
                
                return { success: true, key: k, modifiers: mods };
            },
            args: [dupTok, key || '', modifiers || ''],
            world: 'MAIN'
        }).then(results => {
            resolve(results[0]?.result || { error: '执行失败' });
        }).catch(reject);
    });
}

// 获取控制台消息
// ⚠️ 数据源是 **hookDataBuffer 里 scriptId==='console' 的记录**，不是 `consoleMessages` 数组
// ——后者全项目**只有声明与读取、零写入点**，读它**永远返回空数组**（AI 会把"数据源不存在"
// 读成"页面控制台没有输出"）。未启用 hook_console_bridge 时返回**带 note 的空结果**：
// 必须区分"没输出"与"桥没开"。
// ⚠️ **空 ≠ 页面无输出**：桥只转发命中关键词且 ≤4000 字符的 log/warn/error/info，
// 普通日志根本不进来。**有数据时同样要说清覆盖范围**（否则 AI 把"我看到的"当成全量）。
// 完整来龙去脉（原实现为什么永远为空、note 曾是过度承诺）→ INTERNALS.md「getConsoleMessages」。
const CONSOLE_BRIDGE_LEVELS = ['log', 'warn', 'error', 'info'];   // 桥包装的 console 方法（debug 未包）
async function getConsoleMessages({ limit = 50, types = [], tabId } = {}) {
    // 记录来源过滤：hookDataBuffer 全标签页共享（未指定 tabId 时不做过滤，但每条带 tabId 可自行区分）
    let records = hookDataBuffer.filter((d) => d && d.scriptId === 'console');
    if (typeof tabId === 'number') {
        records = records.filter((d) => d.tabId === tabId);
    }

    let messages = records.map((d) => ({
        type: d.level || 'log',
        text: d.message,
        timestamp: d.pageTimestamp || d.timestamp,
        ...(typeof d.tabId === 'number' ? { tabId: d.tabId } : {})
    }));

    const matchedTotal = messages.length;   // 过滤 types 之前的命中数（用于如实标注截断）
    if (types.length > 0) {
        messages = messages.filter((m) => types.includes(m.type));
    }
    messages = messages.slice(-limit);

    // 探测桥的启用状态：区分"桥没开"与"开了但没命中"——两者此前都只得到一句"页面没输出"
    let bridgeEnabled = null;   // null = 未探明（无 http(s) 标签页等）
    try {
        const tab = await resolveTab({ tabId }, true);
        if (tab && tab.url) {
            const host = new URL(tab.url).hostname;
            const st = await chrome.storage.local.get(['antidebug_mode', 'global_scripts', host]);
            const list = ((st.antidebug_mode || 'standard') === 'global' ? st.global_scripts : st[host]) || [];
            bridgeEnabled = list.includes('hook_console_bridge');
        }
    } catch (e) { /* 探测失败保持 null（不猜） */ }

    const coverage = {
        source: 'hook_console_bridge 脚本（劫持页面 console → content.js 转发）',
        forwardedLevels: CONSOLE_BRIDGE_LEVELS,
        filtered: '仅转发命中关键词（加密/签名/token/cookie/XHR/fetch 等）且 ≤4000 字符的日志',
        bridgeEnabled,
        scope: typeof tabId === 'number'
            ? `仅 tab ${tabId}`
            : '全部标签页（每条的 tabId 字段标明来源）',
        matchedTotal,
        returned: messages.length,
        ...(matchedTotal > messages.length ? { truncated: true } : {})
    };

    let note;
    if (messages.length === 0) {
        if (bridgeEnabled === false) {
            note = 'hook_console_bridge **未对该页启用**——请先 toggle_script 启用并刷新页面。当前为空**不代表**页面没有 console 输出';
        } else if (bridgeEnabled === true) {
            note = '桥已启用但缓冲中无命中记录。桥**只转发命中关键词且 ≤4000 字符的 log/warn/error/info**——为空**不代表**页面没有 console 输出（多数普通日志不会进来）';
        } else {
            note = '无命中记录；且未能探明桥是否启用（无 http(s) 活动标签页）。桥只转发命中关键词的日志，为空**不代表**页面无输出';
        }
    } else {
        note = '以上是 hook_console_bridge **过滤后**的日志（关键词命中 + ≤4000 字符 + 仅 log/warn/error/info），**不是**页面 console 的全量输出';
    }
    if (types.some(t => !CONSOLE_BRIDGE_LEVELS.includes(t))) {
        note += '；注意：请求的等级中含桥不转发的类型（debug），该类恒为空、不代表页面没有';
    }

    return { messages, coverage, note };
}

// 滚动页面
async function scrollPage({ x = 0, y = 0, selector, behavior = 'smooth', tabId, hostname }) {
    const tab = await requireTab({ tabId, hostname });
    
    return new Promise((resolve, reject) => {
        adbExecuteScript({
            target: { tabId: tab.id },
            func: (scrollX, scrollY, sel, scrollBehavior) => {
                if (sel) {
                    const element = document.querySelector(sel);
                    if (element) {
                        element.scrollIntoView({ behavior: scrollBehavior, block: 'center' });
                        return { success: true, scrolledTo: sel };
                    }
                    return { error: `未找到元素: ${sel}` };
                }
                
                window.scrollTo({ left: scrollX, top: scrollY, behavior: scrollBehavior });
                return { success: true, scrollX, scrollY };
            },
            args: [x ?? 0, y ?? 0, selector || null, behavior || 'auto'],
            world: 'MAIN'
        }).then(results => {
            resolve(results[0]?.result || { error: '执行失败' });
        }).catch(reject);
    });
}

// 等待条件（V4.9.41 扩展：selector 或 text 二选一——对齐 chrome-devtools 的 wait_for）
async function waitForSelector({ selector, text, timeout = 5000, visible = true, tabId, hostname }) {
    const tab = await requireTab({ tabId, hostname });
    const isText = typeof text === 'string' && text.trim().length > 0;
    if (!selector && !isText) throw new Error('必须提供 selector 或 text（二选一）');
    if (selector && isText) throw new Error('selector 与 text 只能给一个');

    return new Promise((resolve, reject) => {
        adbExecuteScript({
            target: { tabId: tab.id },
            func: async (sel, txt, timeoutMs, shouldBeVisible) => {
                const deadline = Date.now() + timeoutMs;
                while (Date.now() < deadline) {
                    if (txt) {
                        // text 模式：等 body.innerText 出现该文本
                        const bodyText = (document.body && document.body.innerText) || '';
                        if (bodyText.indexOf(txt) !== -1) return { success: true, found: true, mode: 'text', text: txt };
                    } else {
                        const element = document.querySelector(sel);
                        if (element) {
                            if (!shouldBeVisible) return { success: true, found: true, mode: 'selector' };
                            const rect = element.getBoundingClientRect();
                            const isVisible = rect.width > 0 && rect.height > 0 &&
                                window.getComputedStyle(element).display !== 'none' &&
                                window.getComputedStyle(element).visibility !== 'hidden';
                            if (isVisible) return { success: true, found: true, visible: true, mode: 'selector' };
                        }
                    }
                    await new Promise(r => setTimeout(r, 100));
                }
                return { success: false, found: false, timeout: true, mode: txt ? 'text' : 'selector' };
            },
            args: [selector || '', isText ? String(text) : '', timeout || 3000, visible !== false],
            world: 'MAIN'
        }).then(results => {
            resolve(results[0]?.result || { error: '执行失败' });
        }).catch(reject);
    });
}

// 文件上传（V4.9.41，对齐 chrome-devtools 的 upload_file）：CDP `DOM.setFileInputFiles` 把本地文件
// **直接注入** input[type=file]——走的是真实文件选择的 DOM 层，isTrusted 不适用（也不需要）。
// 渗透场景：上传点测试（图片马/后缀绕过/.htaccess）第一步就是把文件塞进 input。
async function uploadFile({ selector, files, tabId, hostname }) {
    const list = Array.isArray(files) ? files.filter(Boolean) : (files ? [files] : []);
    if (!list.length) throw new Error('必须提供 files（本地绝对路径，字符串或数组）');
    const tab = await requireTab({ tabId, hostname });
    return withDebugger(tab.id, async () => {
        await cdpSend(tab.id, 'DOM.enable');
        const doc = await cdpSend(tab.id, 'DOM.getDocument', { depth: -1, pierce: true });
        const q = await cdpSend(tab.id, 'DOM.querySelector', { nodeId: doc.root.nodeId, selector });
        if (!q || !q.nodeId) {
            throw new Error(`未找到文件输入框: ${selector}（确认选择器指向 input[type=file]；隐藏 input 也能注入，但选择器必须对）`);
        }
        await cdpSend(tab.id, 'DOM.setFileInputFiles', { files: list, nodeId: q.nodeId });
        return {
            success: true,
            method: 'CDP DOM.setFileInputFiles（真实文件注入）',
            selector,
            files: list,
            note: '文件已注入 input[type=file]，Chrome 会派发 input/change；若页面有自定义上传逻辑，接着用 real_click 点上传按钮'
        };
    });
}

// 环境模拟（V4.9.41，对齐 chrome-devtools 的 emulate + resize_page）：视口/设备/UA/时区/地理位置/网络限速。
// 渗透用途：弱网测试、移动端 UA 绕过、响应式布局、地理位置相关逻辑。
// V4.9.42（验收 Y1 补充）：emulate **自己建立**的长驻会话集合。
// `reset` 的语义是"清除模拟并释放"——但只能释放自己建的；如果标签上原有的是 debug_control 的
// 断点会话，释放它会让断点全失效。用归属集合区分，而不是只看"进入时有没有会话"。
const emulateOwnedTabs = new Set();

async function emulate({ width, height, deviceScaleFactor, mobile, userAgent, platform, acceptLanguage, timezone, latitude, longitude, accuracy, offline, latency, downloadThroughput, uploadThroughput, reset, tabId, hostname }) {
    const tab = await requireTab({ tabId, hostname });
    // V4.9.41 真机实测：CDP 的 Emulation/Network 覆盖在 **detach 时会被 Chrome 清除**——
    // 用 withDebugger（用完即 detach）会"返回 success 但页面读回原值"（UA/视口/时区全不生效）。
    // 因此改用**长驻调试会话**（与 debug_control 同一机制）：设置保持，直到 reset=true 释放。
    // V4.9.42（独立验收 Y1 🔴）：记录进入前是否**已有**长驻会话——失败分支不能无条件 release，
    // 否则 AI 一个参数写错的 `emulate {}` 就会拆掉别人的断点调试会话（断点全失效、模拟被清，
    // 还会遗留幽灵暂停态）。只释放"自己新建的"会话。
    const hadSession = debugSessionTabs.has(tab.id);
    await ensureDebugSession(tab.id);
    if (!hadSession) emulateOwnedTabs.add(tab.id);   // 本次新建 → 记归属，reset 时可释放
    try {
        if (reset) {
            const cleared = [];
            const resets = [
                ['viewport', 'Emulation.clearDeviceMetricsOverride', {}],
                ['userAgent', 'Emulation.setUserAgentOverride', { userAgent: '' }],
                ['timezone', 'Emulation.setTimezoneOverride', { timezoneId: '' }],
                ['geolocation', 'Emulation.clearGeolocationOverride', {}],
                ['network', 'Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }],
            ];
            for (const [name, method, params] of resets) {
                try { await cdpSend(tab.id, method, params); cleared.push(name); } catch (e) { /* 单项失败不影响其它 */ }
            }
            // V4.9.42（验收 Y1）：释放**归属自己的**会话；别人（debug_control）的不动
            const owned = emulateOwnedTabs.has(tab.id);
            if (owned) { await releaseDebugSession(tab.id); emulateOwnedTabs.delete(tab.id); }
            return {
                success: true, reset: true, cleared,
                releasedSession: owned,
                note: owned
                    ? '已清除视口/UA/时区/地理位置/网络模拟，并释放 emulate 建立的调试会话'
                    : '已清除视口/UA/时区/地理位置/网络模拟；该标签**原有长驻调试会话未被释放**（可能仍有断点），需要释放请用 debug_control detach'
            };
        }
        const applied = {};
        if (width !== undefined || height !== undefined) {
            const vp = {
                width: Math.max(1, Number(width) || 1280),
                height: Math.max(1, Number(height) || 720),
                deviceScaleFactor: Number(deviceScaleFactor) || 1,
                mobile: !!mobile
            };
            await cdpSend(tab.id, 'Emulation.setDeviceMetricsOverride', vp);
            applied.viewport = vp;
        }
        if (userAgent) {
            const p = { userAgent: String(userAgent) };
            if (platform) p.platform = String(platform);
            if (acceptLanguage) p.acceptLanguage = String(acceptLanguage);
            await cdpSend(tab.id, 'Emulation.setUserAgentOverride', p);
            applied.userAgent = p;
        }
        if (timezone) {
            await cdpSend(tab.id, 'Emulation.setTimezoneOverride', { timezoneId: String(timezone) });
            applied.timezone = String(timezone);
        }
        if (latitude !== undefined && longitude !== undefined) {
            const geo = { latitude: Number(latitude), longitude: Number(longitude), accuracy: Number(accuracy) || 100 };
            await cdpSend(tab.id, 'Emulation.setGeolocationOverride', geo);
            applied.geolocation = geo;
        }
        if (offline !== undefined || latency !== undefined || downloadThroughput !== undefined || uploadThroughput !== undefined) {
            await cdpSend(tab.id, 'Network.enable');
            const cond = {
                offline: !!offline,
                latency: Number(latency) || 0,
                downloadThroughput: downloadThroughput !== undefined ? Number(downloadThroughput) : -1,
                uploadThroughput: uploadThroughput !== undefined ? Number(uploadThroughput) : -1
            };
            await cdpSend(tab.id, 'Network.emulateNetworkConditions', cond);
            applied.network = cond;
        }
        if (!Object.keys(applied).length) {
            // V4.9.42（验收 Y1）：只在**本次调用新建**了会话时才释放——已有会话是别人的（断点调试等）
            if (!hadSession) { await releaseDebugSession(tab.id).catch(() => { /* 释放失败不掩盖原错误 */ }); emulateOwnedTabs.delete(tab.id); }
            throw new Error('没有需要应用的模拟项——提供 width/height、userAgent、timezone、latitude+longitude、offline/latency/downloadThroughput 之一，或 reset=true 清除'
                + (hadSession ? '（注意：该标签已有长驻调试会话，本次未改动它）' : ''));
        }
        return {
            success: true, applied,
            note: '模拟**保持中**（CDP 长驻调试会话，该标签会显示"正在调试"黄条）——用 reset=true 清除并释放，或 debug_control detach'
        };
    } catch (e) {
        throw e;
    }
}

// 获取元素信息
async function getElementInfo({ selector, tabId, hostname }) {
    const tab = await requireTab({ tabId, hostname });
    
    return new Promise((resolve, reject) => {
        adbExecuteScript({
            target: { tabId: tab.id },
            func: (sel) => {
                const element = document.querySelector(sel);
                if (!element) {
                    return { error: `未找到元素: ${sel}` };
                }
                
                const rect = element.getBoundingClientRect();
                const styles = window.getComputedStyle(element);
                
                return {
                    tag: element.tagName.toLowerCase(),
                    id: element.id || null,
                    className: element.className || null,
                    text: element.textContent?.trim().substring(0, 200) || null,
                    value: element.value || null,
                    href: element.href || null,
                    src: element.src || null,
                    type: element.type || null,
                    placeholder: element.placeholder || null,
                    disabled: element.disabled || false,
                    checked: element.checked || false,
                    rect: {
                        x: rect.x,
                        y: rect.y,
                        width: rect.width,
                        height: rect.height,
                        top: rect.top,
                        left: rect.left
                    },
                    visible: rect.width > 0 && rect.height > 0 && 
                        styles.display !== 'none' && styles.visibility !== 'hidden',
                    attributes: Array.from(element.attributes).reduce((acc, attr) => {
                        acc[attr.name] = attr.value;
                        return acc;
                    }, {})
                };
            },
            args: [selector || ''],
            world: 'MAIN'
        }).then(results => {
            resolve(results[0]?.result || { error: '执行失败' });
        }).catch(reject);
    });
}

// 准备路由访问（启用清除路由守卫和清除跳转脚本）
async function prepareRouteAccess({ tabId, hostname } = {}) {
    // V4.9.26（作用域收尾）：同 enableEncryptionHooks——签名不收作用域且没往下传，
    // 于是永远改的是**活动标签页**对应站点的脚本开关
    const scriptsToEnable = [
        'Get_Vue_0',                    // 获取路由
        'Get_Vue_1',                    // 清除跳转
        'Clear_vue_Navigation_Guards'   // 清除路由守卫
    ];

    const results = [];
    for (const scriptId of scriptsToEnable) {
        const result = await toggleScript({ scriptId, enabled: true, tabId, hostname });
        results.push({ scriptId, ...result });
    }
    
    return {
        success: true,
        enabledScripts: scriptsToEnable,
        results,
        message: '已启用路由访问所需脚本，请刷新页面后生效'
    };
}

// 扫描路由收集API
async function scanRouteForAPI({ route, waitTime = 3000, tabId, hostname }) {
    // V4.9.26（作用域收尾）：原签名不收作用域 → 导航落在**活动标签页**上；
    // 且下面按时间窗捞 networkRequests 时**不区分标签**，会把其它标签页这几秒的请求算进来
    const tab = await requireTab({ tabId, hostname });

    // 清空网络请求记录
    // H-逻辑3 修复：时间戳窗口替代下标窗口——networkRequests 是环形缓冲（上限 1000），
    // 缓冲满时下标窗口 slice(length) 恒为空，扫描结果静默作废
    const windowStart = Date.now();

    // 导航到路由（显式带上已解析的 tab.id，不用再让 navigateTo 自己解析一次）
    await navigateTo({ url: route, tabId: tab.id });

    // 等待页面加载和API请求
    await new Promise(resolve => setTimeout(resolve, waitTime));

    // 获取新增的网络请求（时间窗 + **标签页**双过滤）
    const newRequests = networkRequests.filter(r =>
        (r.timestamp || 0) >= windowStart && r.tabId === tab.id);

    // 过滤出API请求（通常是XHR/fetch，且URL包含api关键字或特定模式）
    const apiRequests = newRequests.filter(r => {
        const url = r.url.toLowerCase();
        return r.type === 'xmlhttprequest' || 
               r.type === 'fetch' ||
               url.includes('/api/') ||
               url.includes('/api.') ||
               url.includes('.json') ||
               (r.method === 'POST' && !url.endsWith('.js') && !url.endsWith('.css'));
    });
    
    return {
        route,
        totalRequests: newRequests.length,
        apiRequests: apiRequests.map(r => ({
            url: r.url,
            method: r.method,
            type: r.type,
            statusCode: r.statusCode
        })),
        apiCount: apiRequests.length
    };
}
