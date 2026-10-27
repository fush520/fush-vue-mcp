// ==UserScript==
// @name         Get_Vue_Dynamic (addRoute + Pinia 菜单提取)
// @namespace    https://github.com/0xsdeo/AntiDebug_Breaker
// @version      2026-08-27
// @description  提取 addRoute 动态注册的路由 + Pinia state 中的菜单映射（管理后台常见模式：登录接口返回菜单→存Pinia→addRoute注册）
// @author       0xsdeo / fusheng
// @run-at       document-start
// @match        *
// @grant        none
// ==/UserScript==

// 提取动态路由（addRoute）与 Pinia 菜单映射（管理后台标准模式）
(function () {
    // 全局执行锁
    const LOCK_KEY = '__VUE_DYNAMIC_HOOK__';
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

    const hookedRouters = new WeakSet();
    let dynamicRoutes = [];     // addRoute 注册的路由
    let piniaMenus = [];        // Pinia state 中提取的菜单
    let appFound = false;
    let lastReportTime = 0;
    const REPORT_COOLDOWN = 2000; // 上报冷却 2 秒

    // 发送数据到插件（复用 VUE_ROUTER_DATA 通道）
    function sendToExtension(data) {
        try {
            window.postMessage({
                type: 'VUE_ROUTER_DATA',
                source: 'get-vue-dynamic-script',
                data: data
            }, '*');
        } catch (e) {
            console.warn('[VueDynamic] postMessage 发送失败:', e);
        }
    }

    // 合并上报：动态路由 + Pinia 菜单
    function reportData(reason) {
        const now = Date.now();
        if (lastReportTime > 0 && now - lastReportTime < REPORT_COOLDOWN) return;
        lastReportTime = now;
        console.log(`[VueDynamic] 上报数据 (${reason})：动态路由 ${dynamicRoutes.length} 条，Pinia 菜单 ${piniaMenus.length} 条`);
        sendToExtension({
            type: 'DYNAMIC_ROUTES_PINIA',
            dynamicRoutes: dynamicRoutes.slice(0, 500),
            piniaMenus: piniaMenus.slice(0, 500),
            timestamp: now
        });
    }

    // ========== 1. Hook router.addRoute / removeRoute ==========
    function hookRouter(router) {
        if (!router || hookedRouters.has(router)) return;
        hookedRouters.add(router);

        try {
            if (typeof router.addRoute === 'function') {
                const origAdd = router.addRoute.bind(router);
                router.addRoute = function (...args) {
                    // 两种签名：addRoute(route) 或 addRoute(parentName, route)
                    const route = args.length >= 2 ? args[1] : args[0];
                    try {
                        if (route && typeof route === 'object' && route.path) {
                            dynamicRoutes.push({
                                name: route.name,
                                path: route.path,
                                meta: route.meta,
                                children: route.children || [],
                                via: 'addRoute'
                            });
                            console.log(`[VueDynamic] 📥 addRoute 捕获: ${route.name || '(unnamed)'} -> ${route.path}`);
                            reportData('addRoute');
                        }
                    } catch (e) { /* 忽略单条解析错误 */ }
                    return origAdd(...args);
                };
            }

            if (typeof router.removeRoute === 'function') {
                const origRemove = router.removeRoute.bind(router);
                router.removeRoute = function (...args) {
                    const name = args[0];
                    try {
                        if (name !== undefined) {
                            dynamicRoutes = dynamicRoutes.filter(r => r.name !== name);
                            console.log(`[VueDynamic] 🗑️ removeRoute 捕获: ${name}`);
                        }
                    } catch (e) { /* 忽略 */ }
                    return origRemove(...args);
                };
            }
        } catch (e) {
            console.warn('[VueDynamic] Hook router 失败:', e);
        }
    }

    // ========== 2. 提取 Pinia 菜单映射 ==========
    // 从 Vue app 实例中获取 pinia
    function getPiniaFromApp(app) {
        try {
            const provides = app && app._context && app._context.provides;
            if (provides) {
                // pinia 实例特征：_s 是 Map（store 表）、_a 是 App
                for (const key of Object.getOwnPropertySymbols(provides)) {
                    const v = provides[key];
                    if (v && v._s instanceof Map) return v;
                }
                for (const key of Object.keys(provides)) {
                    const v = provides[key];
                    if (v && v._s instanceof Map) return v;
                }
            }
            // 新版本 pinia 挂在 window.__pinia
            if (window.__pinia && window.__pinia._s instanceof Map) return window.__pinia;
        } catch (e) { /* 忽略 */ }
        return null;
    }

    // 菜单项 sanitize：浅拷贝可序列化字段，剥离函数/循环引用
    function sanitizeMenuItem(item, depth, seen) {
        const out = {};
        try {
            for (const key of ['path', 'url', 'name', 'title', 'component', 'redirect', 'meta', 'icon', 'hidden', 'type', 'id', 'code', 'perm', 'permission']) {
                const v = item[key];
                if (v === undefined || v === null) continue;
                if (typeof v === 'function') continue;
                if (typeof v === 'object') {
                    // 简单对象（如 meta）浅拷贝；跳过复杂嵌套
                    try {
                        out[key] = JSON.parse(JSON.stringify(v, (k, val) => {
                            if (typeof val === 'function') return undefined;
                            return val;
                        }));
                    } catch (e) {
                        out[key] = String(v);
                    }
                } else {
                    out[key] = v;
                }
            }
            // 子菜单
            if (Array.isArray(item.children)) {
                out.children = [];
                for (const child of item.children) {
                    if (child && typeof child === 'object') {
                        out.children.push(sanitizeMenuItem(child, depth + 1, seen));
                    }
                }
            }
        } catch (e) { /* 忽略 */ }
        return out;
    }

    // 深度搜索 Pinia state 中的菜单数组
    function deepFindMenus(obj, depth, seen) {
        if (!obj || depth > 6 || typeof obj !== 'object') return [];
        if (seen.has(obj)) return [];
        seen.add(obj);

        const results = [];
        try {
            if (Array.isArray(obj)) {
                for (const item of obj) {
                    if (!item || typeof item !== 'object') continue;
                    const keys = Object.keys(item);
                    // 菜单项特征：含 path/url 且含 name/title/component 之一
                    const hasPath = keys.includes('path') || keys.includes('url');
                    const hasLabel = keys.includes('name') || keys.includes('title') || keys.includes('component');
                    if (hasPath && hasLabel) {
                        results.push(sanitizeMenuItem(item, depth, seen));
                    } else if (Array.isArray(item.children) && item.children.length > 0) {
                        for (const r of deepFindMenus(item, depth + 1, seen)) results.push(r);
                    }
                }
            } else {
                for (const key of Object.keys(obj)) {
                    if (['$state', 'state', '_value', 'value', '__state'].includes(key)) continue; // pinia 内部结构
                    const v = obj[key];
                    if (!v || typeof v !== 'object') continue;
                    // 优先从语义化字段进入
                    if (['menus', 'menuList', 'menu', 'routes', 'asyncRoutes', 'menuRoutes', 'permissionList', 'authMenu', 'navList'].includes(key) && Array.isArray(v)) {
                        for (const r of deepFindMenus(v, depth + 1, seen)) results.push(r);
                    } else if (typeof v === 'object') {
                        for (const r of deepFindMenus(v, depth + 1, seen)) results.push(r);
                    }
                }
            }
        } catch (e) { /* 忽略 */ }
        return results;
    }

    // 遍历所有 pinia store，提取菜单
    function extractPiniaMenus(pinia) {
        const found = [];
        const seen = new WeakSet();
        try {
            const stores = pinia._s; // Map<id, store>
            for (const [storeId, store] of stores) {
                try {
                    const state = store.$state || store.state;
                    const menus = deepFindMenus(state, 0, seen);
                    for (const m of menus) {
                        if (!m.storeId) m.storeId = storeId;
                        found.push(m);
                    }
                } catch (e) { /* 跳过单个 store */ }
            }
        } catch (e) {
            console.warn('[VueDynamic] 提取 Pinia 菜单失败:', e);
        }
        return found;
    }

    // 菜单去重（按 path+name+title 指纹）
    function dedupeMenus(list) {
        const seenKeys = new Set();
        return list.filter(m => {
            const key = `${m.path || ''}|${m.name || ''}|${m.title || ''}|${m.storeId || ''}`;
            if (seenKeys.has(key)) return false;
            seenKeys.add(key);
            return true;
        });
    }

    // ========== 3. 查找 Vue app 并持续监控 ==========
    function findVueApps() {
        if (!document.body) return [];
        const apps = [];
        // 轻量扫描：优先检查常见挂载点，避免全 DOM BFS 的性能开销
        const candidates = [document.body, document.getElementById('app'), document.getElementById('root')];
        const seenNodes = new Set();
        for (const root of candidates) {
            if (!root || seenNodes.has(root)) continue;
            seenNodes.add(root);
            const all = root.querySelectorAll('*');
            for (let i = 0; i < all.length; i++) {
                if (all[i].__vue_app__) {
                    apps.push(all[i].__vue_app__);
                    break; // 每棵子树找到一个即可
                }
            }
            if (root.__vue_app__) apps.push(root.__vue_app__);
        }
        return apps;
    }

    function findRouterFromApp(app) {
        try {
            if (app.config && app.config.globalProperties && app.config.globalProperties.$router) {
                return app.config.globalProperties.$router;
            }
            const instance = app._instance;
            if (instance && instance.appContext && instance.appContext.config.globalProperties.$router) {
                return instance.appContext.config.globalProperties.$router;
            }
            if (instance && instance.ctx && instance.ctx.$router) {
                return instance.ctx.$router;
            }
        } catch (e) { /* 忽略 */ }
        return null;
    }

    function scanOnce(reason) {
        const apps = findVueApps();
        for (const app of apps) {
            appFound = true;
            const router = findRouterFromApp(app);
            if (router) hookRouter(router);

            const pinia = getPiniaFromApp(app);
            if (pinia) {
                const menus = dedupeMenus(extractPiniaMenus(pinia));
                if (menus.length > 0) {
                    // 有新增则替换并上报
                    const newKeys = menus.map(m => `${m.path}|${m.name}|${m.title}`);
                    const oldKeys = new Set(piniaMenus.map(m => `${m.path}|${m.name}|${m.title}`));
                    const hasNew = newKeys.some(k => !oldKeys.has(k));
                    if (hasNew || menus.length !== piniaMenus.length) {
                        piniaMenus = menus;
                        console.log(`[VueDynamic] 🍍 Pinia 菜单提取: ${menus.length} 条`);
                        reportData('pinia-update');
                    }
                }
            }
        }
        // 首次发现 app 后上报一次
        if (appFound && dynamicRoutes.length > 0 && lastReportTime === 0) {
            reportData('initial');
        }
    }

    // 轮询：前 20 秒每 1.5 秒一次，之后每 5 秒一次（登录后菜单异步加载）
    let pollCount = 0;
    let pollTimer = null;
    function startPolling() {
        const interval = pollCount < 13 ? 1500 : 5000;
        pollCount++;
        pollTimer = setTimeout(() => {
            scanOnce('poll');
            startPolling();
        }, interval);
    }

    // 监听重扫描请求（与 Get_Vue 保持一致）
    window.addEventListener('message', (event) => {
        if (event.source !== window) return;
        if (event.data && event.data.type === 'MANUAL_RESCAN_VUE' && event.data.source === 'antidebug-extension') {
            scanOnce('manual-rescan');
        }
    });

    // 启动
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            scanOnce('init');
            startPolling();
        });
    } else {
        scanOnce('init');
        startPolling();
    }
})();
