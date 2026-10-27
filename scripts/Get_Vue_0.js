// ==UserScript==
// @name         Get_Vue
// @namespace    https://github.com/0xsdeo/Hook_JS
// @version      2025-10-05
// @description  try to take over the world!
// @author       0xsdeo
// @run-at       document-start
// @match        *
// @icon         data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==
// @grant        none
// ==/UserScript==

// Vue实例和Router获取函数（DOM监控版 - 适用于油猴脚本）
(function() {
    // 更强的全局执行锁
    const LOCK_KEY = '__VUE_GETTER_RUNNING__';
    if (window[LOCK_KEY]) {
        console.warn('⚠️ Vue获取脚本已在运行中，跳过本次执行');
        return;
    }

    // 使用不可配置的属性作为锁
    try {
        Object.defineProperty(window, LOCK_KEY, {
            value: true,
            writable: false,
            configurable: false
        });
    } catch (e) {
        // 如果无法设置，说明已经在运行
        console.warn('⚠️ 无法设置执行锁，脚本可能已在运行');
        return;
    }

    let observer = null;
    let allTimeoutIds = []; // 收集所有定时器ID
    const validInstancesCache = []; // 缓存所有找到的有效实例
    let hasOutputResult = false; // 标记是否已经输出过结果

// 发送数据到插件
// 深度序列化清洗：剥离函数/Symbol/循环引用（seen 用 delete 支持共享引用展开，仅真循环标 [Circular]）。
// 场景（原项目 issue #25）：路由 meta.beforeEnter 等函数触发 DataCloneError 导致整包数据丢失——
// 清洗后可保住 meta.roles/permissions/title 等可序列化字段（权限矩阵的数据源）
function sanitizeForClone(obj, depth, seen) {
    depth = depth || 0;
    seen = seen || new Set();
    if (obj === null || (typeof obj !== 'object' && typeof obj !== 'function')) {
        return typeof obj === 'symbol' ? undefined : obj;
    }
    if (typeof obj === 'function') return undefined;
    if (depth > 12) return '[MaxDepth]';
    if (seen.has(obj)) return '[Circular]';
    seen.add(obj);
    try {
        if (Array.isArray(obj)) {
            const out = [];
            for (const v of obj) {
                const s = sanitizeForClone(v, depth + 1, seen);
                if (s !== undefined) out.push(s);
            }
            return out;
        }
        const out = {};
        for (const k of Object.keys(obj)) {
            const s = sanitizeForClone(obj[k], depth + 1, seen);
            if (s !== undefined) out[k] = s;
        }
        return out;
    } finally {
        seen.delete(obj);
    }
}

function sendToExtension(data) {
    try {
        window.postMessage({
            type: 'VUE_ROUTER_DATA',
            source: 'get-vue-script',
            data: data
        }, '*');
    } catch (error) {
        // ✅ 捕获 DataCloneError（原项目 issue #25 修复：清洗重发而非整包丢弃）
        if (error.name === 'DataCloneError' || error.message.includes('could not be cloned')) {
            try {
                window.postMessage({
                    type: 'VUE_ROUTER_DATA',
                    source: 'get-vue-script',
                    data: sanitizeForClone(data, 0, new Set())
                }, '*');
                console.warn('[AntiDebug] 路由数据含不可序列化字段（函数/Symbol，常见为 meta.beforeEnter），已剥离后重发');
            } catch (e2) {
                console.error('[AntiDebug] 清洗后仍无法传递，请查看控制台输出的路由列表');
                // 发送错误消息给插件
                try {
                    window.postMessage({
                        type: 'VUE_ROUTER_DATA',
                        source: 'get-vue-script',
                        data: {
                            serializationError: true,
                            errorType: 'DataCloneError',
                            errorMessage: '路由数据无法序列化（清洗后仍失败），请查看控制台输出'
                        }
                    }, '*');
                } catch (e3) {
                    console.error('[AntiDebug] 发送错误消息也失败:', e3);
                }
            }
        } else {
            console.error('[AntiDebug] postMessage发送失败:', error);
        }
    }
}

    // 🆕 重扫描功能：清理资源并重新开始扫描
    function restartScanning() {
        console.log('🔄 开始重新扫描Vue实例...');
        
        // 清理现有资源
        allTimeoutIds.forEach(id => clearTimeout(id));
        allTimeoutIds = [];
        if (observer) {
            observer.disconnect();
            observer = null;
        }
        
        // 重置状态（但保留缓存的实例）
        hasOutputResult = false;
        
        // 重新开始扫描
        startDOMObserver();
        startPollingRetry();
    }

            // 监听来自插件的请求
        window.addEventListener('message', (event) => {
            // 只接受来自同一窗口的消息
            if (event.source !== window) return;
            
            // 🆕 检查是否是重扫描请求
            if (event.data && event.data.type === 'MANUAL_RESCAN_VUE' && event.data.source === 'antidebug-extension') {
                restartScanning();
                return;
            }
            
            // 检查是否是请求Vue数据的消息
            if (event.data && event.data.type === 'REQUEST_VUE_ROUTER_DATA' && event.data.source === 'antidebug-extension') {
                // V4.9.11（吸收上游"请求即重扫"）：缓存为空 = 脚本注入早于框架挂载（慢站常见），
                // 此刻先同步观测一次再回答——免去 AI 端"刷新页面后重试"的往返。
                // 注意：restartScanning 只有 popup 手动触发路径可达（MCP 侧发不出去），此处补上 MCP 路径
                if (validInstancesCache.length === 0 && document.body) {
                    try { tryGetInstances(); } catch (e) { /* 观测失败仍按原逻辑回 notFound */ }
                }
                // 从缓存的实例中获取最新数据
                if (validInstancesCache.length > 0) {
                    // 一次性收集所有实例数据
                    const allInstancesData = validInstancesCache.map((cached, index) => {
                        try {
                            const latestRoutes = listAllRoutes(cached.routerInstance);
                            const latestVersion = getVueVersion(cached.element);
                            const latestMode = getRouterMode(cached.routerInstance);
                            
                            return {
                                vueVersion: latestVersion,
                                routerMode: latestMode,
                                routes: latestRoutes,
                                instanceIndex: index + 1,
                                baseUrl: window.location.origin,
                                routerBase: extractRouterBase(cached.routerInstance)
                            };
                        } catch (e) {
                            console.warn('获取Router最新数据时出错:', e);
                            return null;
                        }
                    }).filter(data => data !== null);
                    
                    // 一次性发送所有实例
                    sendToExtension({
                        type: 'MULTIPLE_INSTANCES',
                        instances: allInstancesData,
                        totalCount: allInstancesData.length
                    });
                } else {
                    // 没有缓存的实例，发送未找到消息
                    sendToExtension({
                        vueVersion: null,
                        routerMode: null,
                        routes: null,
                        notFound: true
                    });
                }
            }
        });

    // 获取Vue版本
    function getVueVersion(vueRoot) {
        let version = vueRoot.__vue_app__?.version ||
            vueRoot.__vue__?.$root?.$options?._base?.version;

        if (!version || version === 'unknown') {
            // 尝试从全局Vue对象获取
            if (window.Vue && window.Vue.version) {
                version = window.Vue.version;
            }
            // 尝试从Vue DevTools获取
            else if (window.__VUE_DEVTOOLS_GLOBAL_HOOK__ &&
                window.__VUE_DEVTOOLS_GLOBAL_HOOK__.Vue) {
                version = window.__VUE_DEVTOOLS_GLOBAL_HOOK__.Vue.version;
            }
        }

        return version || 'unknown';
    }

    // 检测路由器历史模式
    function getRouterMode(router) {
        try {
            // Vue Router 2/3: 直接从 mode 属性获取
            if (router.mode) {
                return router.mode; // 'hash', 'history', 'abstract'
            }

            // Vue Router 2/3: 从 options 获取
            if (router.options?.mode) {
                return router.options.mode;
            }

            let historyObj = router.history || router.options?.history;
            // Vue Router 4: 通过 history 对象的类型判断

            // 🆕 通过 base 属性判断（备用方案）
            if (historyObj && typeof historyObj.base === 'string') {
                if (historyObj.base.endsWith('/#') || historyObj.base.includes('/#')) {
                    return 'hash';
                }
                if (historyObj.base === '' || historyObj.base === '/') {
                    return 'history';
                }
            }

            if (historyObj) {
                const historyType = historyObj.constructor?.name || '';
                
                if (historyType.toLowerCase().includes('hash')) {
                    return 'hash';
                }
                if (historyType.toLowerCase().includes('html5') || 
                    historyType.toLowerCase().includes('web') && !historyType.toLowerCase().includes('hash')) {
                    return 'history';
                }
                if (historyType.toLowerCase().includes('memory')) {
                    return 'abstract';
                }

                // 备用方案：检查当前URL是否有hash
                if (window.location.hash && window.location.hash.startsWith('#/')) {
                    return 'hash';
                }
            }

            // 默认返回 history 模式
            return 'history';
        } catch (e) {
            console.warn('检测路由模式时出错:', e);
            return 'history';
        }
    }

        // 提取Router基础路径
        function extractRouterBase(router) {
            try {
                // Vue Router 2/3: 从 options.base 获取
                if (router.options?.base) {
                    return router.options.base;
                }
                // Vue Router 4: 从 history.base 获取
                if (router.history?.base) {
                    return router.history.base;
                }
                // Vue Router 4: 从 options.history.base 获取
                if (router.options?.history?.base) {
                    return router.options.history.base;
                }
            } catch (e) {
                console.warn('提取Router基础路径时出错:', e);
            }
            return '';
        }

    // 路径拼接函数
    function joinPath(base, path) {
        if (!path) return base || '/';
        if (path.startsWith('/')) return path;
        if (!base || base === '/') return '/' + path;
        return (base.endsWith('/') ? base.slice(0, -1) : base) + '/' + path;
    }

    // 列出所有路由
    function listAllRoutes(router) {
        const list = [];
        try {
            // Vue Router 4
            if (typeof router.getRoutes === 'function') {
                router.getRoutes().forEach(r => {
                    list.push({
                        name: r.name,
                        path: r.path,
                        meta: r.meta
                    });
                });
                return list;
            }

            // Vue Router 2/3
            if (router.options?.routes) {
                // V4.9.11（验收修复 B8）：加 visited 去重 + 深度上限——原递归没有任何保护，
                // 畸形路由配置（children 自引用/成环）会无限递归直至栈溢出、卡死页面主线程。
                // 正常站点是树结构触发不到，但这是零成本的兜底
                const __adbVisited = new Set();
                function traverse(routes, basePath = '', depth = 0) {
                    if (depth > 30 || !Array.isArray(routes)) return;
                    routes.forEach(r => {
                        if (!r || typeof r !== 'object' || __adbVisited.has(r)) return;
                        __adbVisited.add(r);
                        const fullPath = joinPath(basePath, r.path);
                        list.push({ name: r.name, path: fullPath, meta: r.meta });
                        if (Array.isArray(r.children) && r.children.length) {
                            traverse(r.children, fullPath, depth + 1);
                        }
                    });
                }
                traverse(router.options.routes);
                return list;
            }

            // 从matcher获取
            if (router.matcher?.getRoutes) {
                const routes = router.matcher.getRoutes();
                routes.forEach(r => {
                    list.push({ name: r.name, path: r.path, meta: r.meta });
                });
                return list;
            }

            // 从历史记录获取
            if (router.history?.current?.matched) {
                router.history.current.matched.forEach(r => {
                    list.push({ name: r.name, path: r.path, meta: r.meta });
                });
                return list;
            }

            console.warn('🚫 无法列出路由信息');
        } catch (e) {
            console.warn('获取路由列表时出错:', e);
        }

        return list;
    }

    // 获取所有Vue根实例的核心函数（带深度限制的BFS扫描）
    function getAllVueRootInstances() {
        // 如果 body 不存在，返回空数组，等待下次轮询重试
        if (!document.body) {
            return [];
        }

        const instances = [];
        const maxDepth = 1000; // 最大搜索深度
        const queue = [{ node: document.body, depth: 0 }];
        const visited = new Set(); // 防止重复访问

        while (queue.length > 0) {
            const { node, depth } = queue.shift();

            // 节点为空，跳过
            if (!node) {
                continue;
            }

            // 超过最大深度，跳过
            if (depth > maxDepth) {
                continue;
            }

            // 已访问过，跳过
            if (visited.has(node)) {
                continue;
            }
            visited.add(node);

            // 只处理元素节点
            if (node.nodeType !== 1) {
                continue;
            }

            // 检查 Vue 3
            if (node.__vue_app__) {
                instances.push({ element: node, app: node.__vue_app__, version: 3 });
            }
            // 检查 Vue 2
            else if (node.__vue__) {
                instances.push({ element: node, app: node.__vue__, version: 2 });
            }

            // 将子节点加入队列
            if (node.childNodes && node.childNodes.length > 0) {
                for (let i = 0; i < node.childNodes.length; i++) {
                    queue.push({ node: node.childNodes[i], depth: depth + 1 });
                }
            }
        }

        return instances;
    }

    // 定位 Vue Router 实例
    function findVueRouter(vueRoot) {
        try {
            if (vueRoot.__vue_app__) {
                // Vue3 + Router4
                const app = vueRoot.__vue_app__;

                if (app.config?.globalProperties?.$router) {
                    return app.config.globalProperties.$router;
                }

                const instance = app._instance;
                if (instance?.appContext?.config?.globalProperties?.$router) {
                    return instance.appContext.config.globalProperties.$router;
                }

                if (instance?.ctx?.$router) {
                    return instance.ctx.$router;
                }
            }

            if (vueRoot.__vue__) {
                // Vue2 + Router2/3
                const vue = vueRoot.__vue__;
                return vue.$router ||
                    vue.$root?.$router ||
                    vue.$root?.$options?.router ||
                    vue._router;
            }
        } catch (e) {
            console.warn('获取Router实例时出错:', e);
        }
        return null;
    }

    // 尝试获取实例并返回有Router的结果
    function tryGetInstances() {
        const instances = getAllVueRootInstances();

        if (instances.length === 0) {
            return null;
        }

        const validInstances = [];

        // 遍历所有实例，找出有Router的
        for (const { element, app, version } of instances) {
            const routerInstance = findVueRouter(element);

            if (routerInstance) {
                // 检查是否已经在缓存中（通过routerInstance引用判断，避免重复）
                const alreadyCached = validInstancesCache.some(cached => cached.routerInstance === routerInstance);

                if (!alreadyCached) {
                    // 获取所有路由
                    const allRoutes = listAllRoutes(routerInstance);

                    // 获取具体版本号
                    const vueVersion = getVueVersion(element);

                    // 获取路由模式
                    const routerMode = getRouterMode(routerInstance);

                    const instanceInfo = {
                        element: element,
                        vueInstance: app,
                        routerInstance: routerInstance,
                        version: version,
                        vueVersion: vueVersion,
                        routerMode: routerMode,
                        routes: allRoutes
                    };

                    validInstances.push(instanceInfo);
                    validInstancesCache.push(instanceInfo); // 加入缓存

                    // 立即输出新发现的Router（仅控制台）
                    const instanceIndex = validInstancesCache.length;
                    console.log(`\n📋 Vue Router 路由列表 [实例 ${instanceIndex} - Vue ${vueVersion} - ${routerMode} 模式]：`);
                    console.table(allRoutes.map(route => ({
                        Name: route.name || '(unnamed)',
                        Path: route.path
                    })));
                    console.log(`\n🔗 Vue Router 实例 [${instanceIndex}]：`);
                    console.log(routerInstance);
                }
            }
        }

        return validInstances.length > 0 ? validInstances : null;
    }

    // DOM变化监控函数
    function startDOMObserver() {
        // 立即尝试一次完整遍历
        tryGetInstances();

        // 创建 MutationObserver 持续监控 DOM 变化
        observer = new MutationObserver((mutations) => {
            if (hasOutputResult) {
                return; // 检测已结束，跳过后续监控
            }

            // 检查是否有新增的元素节点
            let hasNewNodes = false;
            for (const mutation of mutations) {
                if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                    hasNewNodes = true;
                    break;
                }
            }

            if (hasNewNodes) {
                // 有新节点添加，尝试获取实例（会自动输出新发现的Router）
                tryGetInstances();
            }
        });

        // 开始观察整个 document
        observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: false,
            characterData: false
        });
    }

    // 清理资源
    function cleanupResources() {
        if (hasOutputResult) {
            return; // 已经清理过，跳过
        }

        hasOutputResult = true;

        // 清理所有定时器并停止监控
        allTimeoutIds.forEach(id => clearTimeout(id));
        allTimeoutIds = [];
        if (observer) {
            observer.disconnect();
            observer = null;
        }

        // 输出检测结束信息
        if (validInstancesCache.length === 0) {
            console.log('❌ 未找到任何含Router的Vue实例');
        }
    }

    // 后备轮询重试机制
    function startPollingRetry() {
        let delay = 100;
        // V4.9.4：探测窗口延长（原 5 次指数退避 ≈ 3s，慢加载站 Vue 挂载晚导致探测失败——
        // 实测 lib.example.edu.cn 8s 挂载、news.example.edu.cn（122 个 script）45s+ 才挂载）
        let detectRemainingTries = 8;
        const scanStartTime = Date.now();

        function executeDetection() {
            // 尝试获取（会自动输出新发现的Router）
            tryGetInstances();

            // 基础 8 次；页面仍在加载（readyState != complete）时按绝对时间续期（上限 60s），
            // 间隔封顶 1500ms——慢站（40s+ 加载）也能覆盖；正常站加载完 ~7.5s 内收尾
            const pageStillLoading = document.readyState !== 'complete';
            const elapsed = Date.now() - scanStartTime;
            const canContinue = detectRemainingTries > 0 || (pageStillLoading && elapsed < 60000);
            if (canContinue) {
                detectRemainingTries--;
                const timeoutId = setTimeout(() => {
                    executeDetection();
                }, delay);
                allTimeoutIds.push(timeoutId);
                delay = Math.min(delay * 2, 1500);
            } else {
                // 达到最大重试次数，清理资源
                cleanupResources();
            }
        }

        // 延迟100ms后开始轮询
        const initialTimeoutId = setTimeout(() => {
            executeDetection();
        }, 100);
        allTimeoutIds.push(initialTimeoutId);
    }

    // 主执行逻辑
    function init() {
        // 如果 DOM 还在加载
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => {
                startDOMObserver();
                startPollingRetry();
            });
        } else {
            // DOM 已经加载完成，立即开始
            startDOMObserver();
            startPollingRetry();
        }
    }

    // 启动
    init();
})();
