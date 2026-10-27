// ==UserScript==
// @name         Get_Store_Dump (Pinia/Vuex 全量状态提取)
// @namespace    https://github.com/0xsdeo/AntiDebug_Breaker
// @version      2026-09-04
// @description  全量 dump Pinia/Vuex store 状态（token/用户信息/权限码/角色/菜单），Vue 权限矩阵与越权测试的身份基准。补位 Get_Vue_Dynamic 不支持 Vuex 的空白（老若依 Vue2 后台主流）
// @author       0xsdeo / fusheng
// @run-at       document-start
// @match        *
// @grant        none
// ==/UserScript==

// Pinia/Vuex store 全量 dump（Vue 权限矩阵的身份基准 + 敏感信息泄露源）
// 上报通道：postMessage STORE_DUMP_DATA → content.js → background（${hostname}_vue_data 合并存储）
(function () {
    // 全局执行锁（防止重复注入——与 hook_console_bridge 同一防重入模式）
    const LOCK_KEY = '__ADB_STORE_DUMP__';
    if (window[LOCK_KEY]) return;
    try {
        Object.defineProperty(window, LOCK_KEY, {
            value: true,
            writable: false,
            configurable: false
        });
    } catch (e) {
        return;
    }

    const REPORT_COOLDOWN = 2000; // 上报冷却 2 秒
    let lastReportAt = 0;
    let pendingReason = null;
    let cooldownTimer = null;

    function safePostMessage(payload) {
        try {
            window.postMessage({
                type: 'STORE_DUMP_DATA',
                source: 'store-dump-script',
                data: payload,
                timestamp: Date.now()
            }, '*');
            return true;
        } catch (e) {
            console.warn('[StoreDump] postMessage 发送失败:', e);
            return false;
        }
    }

    // 合并上报（冷却窗口内的多次触发合并为一次，窗口结束兜底 flush）
    function reportData(reason) {
        const now = Date.now();
        if (now - lastReportAt < REPORT_COOLDOWN) {
            pendingReason = reason;
            if (!cooldownTimer) {
                cooldownTimer = setTimeout(() => {
                    cooldownTimer = null;
                    if (pendingReason) {
                        const r = pendingReason;
                        pendingReason = null;
                        reportData(r + '-flush');
                    }
                }, REPORT_COOLDOWN);
            }
            return;
        }
        lastReportAt = now;
        const dump = collectAllStores();
        if (!dump || dump.totalStores === 0) return;
        console.log(`[StoreDump] 上报 (${reason})：Pinia ${dump.pinia.storeCount} 个 store，Vuex ${dump.vuex.storeCount} 个模块`);
        safePostMessage(dump);
    }

    // 序列化安全：过滤函数/循环引用，深度受限
    function safeClone(obj, depth, seen) {
        if (depth > 6) return '[MaxDepth]';
        if (obj === null || obj === undefined) return obj;
        const t = typeof obj;
        if (t === 'function') return undefined;
        if (t !== 'object') return obj;
        if (seen.has(obj)) return '[Circular]';
        seen.add(obj);
        try {
            if (Array.isArray(obj)) {
                return obj.slice(0, 50).map(v => safeClone(v, depth + 1, seen));
            }
            const out = {};
            for (const key of Object.keys(obj).slice(0, 80)) {
                const v = safeClone(obj[key], depth + 1, seen);
                if (v !== undefined) out[key] = v;
            }
            return out;
        } catch (e) {
            return '[SerializeError]';
        } finally {
            seen.delete(obj);
        }
    }

    // 敏感键标记：token/权限/角色/用户信息（权限矩阵的身份基准就在这里）
    const SENSITIVE_KEY_RE = /token|permission|perm|role|auth|user|userinfo|profile|menu|login|session|jwt|authorization/i;

    function annotateStore(name, state) {
        const cloned = safeClone(state, 0, new Set());
        const sensitiveKeys = [];
        try {
            const scan = (o, path, depth) => {
                if (!o || typeof o !== 'object' || depth > 3) return;
                for (const k of Object.keys(o)) {
                    if (SENSITIVE_KEY_RE.test(k)) sensitiveKeys.push(path + k);
                    if (o[k] && typeof o[k] === 'object') scan(o[k], path + k + '.', depth + 1);
                }
            };
            scan(cloned, '', 0);
        } catch (e) { /* 忽略 */ }
        return { storeName: name, state: cloned, sensitiveKeys: sensitiveKeys.slice(0, 50) };
    }

    // ===== Pinia：app._context.provides 找 pinia（复用 Get_Vue_Dynamic 的发现逻辑） =====
    function findPinia(app) {
        try {
            const provides = app && app._context && app._context.provides;
            if (!provides) return null;
            for (const symbol of Object.getOwnPropertySymbols(provides)) {
                const v = provides[symbol];
                if (v && v._s instanceof Map) return v;
            }
            for (const key of Object.keys(provides)) {
                const v = provides[key];
                if (v && v._s instanceof Map) return v;
            }
        } catch (e) { /* 忽略 */ }
        return (window.__pinia && window.__pinia._s instanceof Map) ? window.__pinia : null;
    }

    function dumpPinia(app) {
        const pinia = findPinia(app);
        if (!pinia) return { storeCount: 0, stores: [] };
        const stores = [];
        try {
            pinia._s.forEach((store, name) => {
                try {
                    // store.$state 取全量状态；getters 求值风险大（可能有副作用），只列键名
                    const entry = annotateStore(name, store.$state || {});
                    entry.getterKeys = Object.keys(store || {}).filter(k => !['$id', '$onAction', '$reset', '$subscribe', '$patch', '$dispose', '$state', '_customProperties', '$pinia'].includes(k)).slice(0, 30);
                    stores.push(entry);
                } catch (e) { /* 单个 store 失败不阻断 */ }
            });
        } catch (e) { /* 忽略 */ }
        return { storeCount: stores.length, stores };
    }

    // ===== Vuex：__vue__.$store.state 递归 dump（补位老若依 Vue2 后台） =====
    function dumpVuex(vueRoot) {
        try {
            const store = vueRoot && vueRoot.$store;
            if (!store || !store.state) return { storeCount: 0, stores: [] };
            const stores = [];
            // 顶层 state + 各注册模块（若依等把菜单/权限放 permission 模块）
            const topLevel = annotateStore('root', store.state);
            stores.push(topLevel);
            const moduleNames = store._modules && store._modules.root
                ? Object.keys(store._modules.root._children || {})
                : Object.keys(store.state).filter(k => store.state[k] && typeof store.state[k] === 'object');
            moduleNames.slice(0, 30).forEach(name => {
                try {
                    stores.push(annotateStore(name, store.state[name] || {}));
                } catch (e) { /* 单模块失败不阻断 */ }
            });
            return { storeCount: stores.length, stores };
        } catch (e) {
            return { storeCount: 0, stores: [] };
        }
    }

    // ===== 全量收集：遍历 DOM 找 Vue 根实例（Vue2 __vue__ / Vue3 __vue_app__） =====
    function collectAllStores() {
        const result = {
            framework: null,
            pinia: { storeCount: 0, stores: [] },
            vuex: { storeCount: 0, stores: [] },
            totalStores: 0
        };

        // Vue3：__vue_app__（挂在挂载容器上）
        const candidates = [document.body, document.getElementById('app'), document.getElementById('root'), document.documentElement];
        for (const root of candidates) {
            if (!root) continue;
            const app = root.__vue_app__;
            if (app) {
                result.framework = 'vue3';
                result.pinia = dumpPinia(app);
                break;
            }
            const vue2Root = root.__vue__;
            if (vue2Root) {
                result.framework = 'vue2';
                result.vuex = dumpVuex(vue2Root);
                break;
            }
        }
        result.totalStores = result.pinia.storeCount + result.vuex.storeCount;
        return result;
    }

    // ===== 发现实例：轮询 + MutationObserver（与 Get_Vue_Dynamic 同策略） =====
    let appFound = false;
    function tryReport() {
        if (appFound) return;
        const dump = collectAllStores();
        if (dump.totalStores > 0) {
            appFound = true;
            reportData('first-found');
        }
    }

    // 启动轮询（Vue 异步挂载，最长 20 秒）
    let pollCount = 0;
    const pollTimer = setInterval(() => {
        pollCount++;
        tryReport();
        if (appFound || pollCount > 40) clearInterval(pollTimer);
    }, 500);

    // DOM 变化时重新探测（SPA 异步挂载/登录取数后 store 更新）。
    // 资源约束：MutationObserver 设上限（30 次上报后 disconnect），避免高频 SPA 上每 2s 一次主线程深拷贝
    try {
        let mutationReports = 0;
        const MAX_MUTATION_REPORTS = 30;
        const observer = new MutationObserver(() => {
            if (!appFound) {
                tryReport();
            } else if (mutationReports < MAX_MUTATION_REPORTS) {
                // 已发现后 store 内容更新（登录/拉权限）：冷却合并上报
                mutationReports++;
                reportData('mutation');
                if (mutationReports >= MAX_MUTATION_REPORTS) {
                    observer.disconnect();
                    console.log('[StoreDump] 已达上报上限，停止监听 DOM 变化');
                }
            }
        });
        observer.observe(document.documentElement || document, { childList: true, subtree: true });
    } catch (e) { /* 忽略 */ }
})();
