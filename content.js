// 在document_start阶段执行
(() => {
    // ============== 上行通道可靠性 ==============
    // chrome.runtime.sendMessage 失败（SW 忙碌丢消息 / 扩展重载后旧页面 context 失效）时，
    // hook/路由数据原本静默丢失且不可恢复。此处改为：失败落盘 localStorage 备份，
    // 下次页面加载新 content script 注入时补推（flushPendingUplink），保证数据最终送达。
    const UPLINK_KEY = '__ADB_PENDING_UPLINK__';
    const UPLINK_MAX = 50;

    function queueUplink(message) {
        try {
            const arr = JSON.parse(localStorage.getItem(UPLINK_KEY) || '[]');
            arr.push(message);
            localStorage.setItem(UPLINK_KEY, JSON.stringify(arr.slice(-UPLINK_MAX)));
        } catch (e) {
            // localStorage 不可用（隐私模式等）或 payload 不可 JSON 序列化：仅告警
            console.warn('[AntiDebug] 上行数据备份失败，本条将丢弃:', e && e.message);
        }
    }

    function sendUplink(message) {
        try {
            chrome.runtime.sendMessage(message).catch(() => {
                queueUplink(message);
            });
        } catch (e) {
            // 扩展重载后旧页面的 chrome.runtime 已失效，访问即同步抛 "Extension context invalidated"
            queueUplink(message);
            console.warn('[AntiDebug] 扩展已重载，本页 Hook 数据上报已暂停——请刷新页面恢复（积压数据会在刷新后自动补推）');
        }
    }

    function flushPendingUplink() {
        try {
            const raw = localStorage.getItem(UPLINK_KEY);
            if (!raw) return;
            localStorage.removeItem(UPLINK_KEY);
            const pending = JSON.parse(raw);
            if (Array.isArray(pending) && pending.length > 0) {
                pending.forEach((msg) => sendUplink(msg));
                console.log(`[AntiDebug] 已补推上次会话积压的 ${pending.length} 条 Hook 数据`);
            }
        } catch (e) {
            // 备份数据损坏则清掉，避免永久卡积压
            try { localStorage.removeItem(UPLINK_KEY); } catch (e2) { /* 忽略 */ }
        }
    }

    // 🆕 Hook板块：在脚本注入前设置localStorage（必须在最顶部）
    try {
        const hostname = window.location.hostname;
        chrome.storage.local.get([hostname, 'antidebug_mode', 'global_scripts'], (result) => {
            // 判断是全局模式还是标准模式
            const mode = result['antidebug_mode'] || 'standard';
            let enabledScripts = [];
            
            if (mode === 'global') {
                enabledScripts = result['global_scripts'] || [];
            } else {
                enabledScripts = result[hostname] || [];
            }
            
            // 遍历所有启用的脚本，检查是否有Hook配置（有配置的就是Hook脚本）
            if (enabledScripts.length > 0) {
                const configKeys = enabledScripts.map(id => `${id}_config`);
                chrome.storage.local.get(configKeys, (configResult) => {
                    const hookScriptsReady = [];
                    
                    enabledScripts.forEach(scriptId => {
                        const config = configResult[`${scriptId}_config`];
                        // 只同步有配置的脚本（Hook脚本才会有配置）
                        if (config) {
                            const baseKey = `Antidebug_breaker_${scriptId}`;
                            
                            try {
                                // 固定变量脚本
                                if (config.value !== undefined) {
                                    localStorage.setItem(`${baseKey}_value`, config.value);
                                }
                                
                                // 非固定变量脚本
                                if (config.flag !== undefined) {
                                    localStorage.setItem(`${baseKey}_flag`, config.flag.toString());
                                }
                                if (config.param !== undefined) {
                                    localStorage.setItem(`${baseKey}_param`, JSON.stringify(config.param));
                                }
                                
                                // 动态开关（debugger, stack等）
                                Object.keys(config).forEach(key => {
                                    // 🔧 修改：排除 keyword_filter_enabled，它只是插件UI的控制开关，不需要同步到页面
                                    if (!['value', 'flag', 'param', 'keyword_filter_enabled'].includes(key)) {
                                        localStorage.setItem(`${baseKey}_${key}`, (config[key] || 0).toString());
                                    }
                                });
                                
                                // 记录已就绪的Hook脚本
                                hookScriptsReady.push(scriptId);
                            } catch (e) {
                                console.warn(`[AntiDebug] Failed to set localStorage for ${scriptId}:`, e);
                            }
                        }
                    });
                    
                    // 🔧 方案二：配置设置完成后，通知所有Hook脚本配置已就绪
                    if (hookScriptsReady.length > 0) {
                        // 发送通知到页面主世界，告知Hook脚本配置已就绪
                        window.postMessage({
                            type: 'HOOK_CONFIG_READY',
                            source: 'antidebug-extension',
                            scriptIds: hookScriptsReady
                        }, '*');
                    }
                });
            }
        });
    } catch (e) {
        console.warn('[AntiDebug] Failed to sync Hook config to localStorage', e);
    }
    
    // 优先从本地存储获取启用状态
    const getEnabledScripts = () => {
        try {
            const hostname = window.location.hostname;
            const storageData = localStorage.getItem('AntiDebug_Breaker');
            if (storageData) {
                const parsed = JSON.parse(storageData);
                return parsed[hostname] || [];
            }
        } catch (e) {
            console.warn('[AntiDebug] Failed to read localStorage', e);
        }
        return [];
    };

    // 从扩展存储获取最新状态并更新本地 localStorage
    // （hostname 为外层声明，下方 onMessage listener 也使用）
    const hostname = window.location.hostname;
    chrome.storage.local.get([hostname], (result) => {
        const latestEnabledScripts = result[hostname] || [];
        try {
            const storageData = localStorage.getItem('AntiDebug_Breaker') || '{}';
            const parsed = JSON.parse(storageData);
            parsed[hostname] = latestEnabledScripts.filter(
                id => typeof id === 'string' && id.trim() !== ''
            );
            localStorage.setItem('AntiDebug_Breaker', JSON.stringify(parsed));
        } catch (e) {
            console.warn('[AntiDebug] Failed to update localStorage', e);
        }
    });

    // 监听来自popup的更新
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        // V4.9.9.2：活性探测 ping——SW 用 tabs.sendMessage 判断标签是否"活着"（非冻结），
        // 替代 CDP attach 探测（不抢用户 DevTools）。冻结标签的 content script 不响应 → SW 侧超时判冻。
        if (message.type === 'ADB_PING') {
            sendResponse({ pong: true });
            return;
        }

        if (message.type === 'scripts_updated' && message.hostname === hostname) {
            // 更新本地存储
            try {
                const storageData = localStorage.getItem('AntiDebug_Breaker') || '{}';
                const parsed = JSON.parse(storageData);
                parsed[hostname] = message.enabledScripts;
                localStorage.setItem('AntiDebug_Breaker', JSON.stringify(parsed));
            } catch (e) {
                console.warn('[AntiDebug] Failed to update localStorage', e);
            }
            // V4.9.11（验收修复 B4）：补 sendResponse——原实现不响应这个分支，但函数末尾
            // 无条件 `return true`（宣称"我会异步响应"），导致通道保持开放等一个永不到来的响应：
            // popup 每次开关脚本都泄漏一个悬挂 message port，直到页面刷新
            sendResponse({ success: true });
        }
        
        // 监听popup请求Vue数据
        if (message.type === 'REQUEST_VUE_ROUTER_DATA') {
            // 转发请求到页面脚本
            window.postMessage({
                type: 'REQUEST_VUE_ROUTER_DATA',
                source: 'antidebug-extension'
            }, '*');
            sendResponse({success: true});
        }
        
        // 🆕 监听popup触发Vue重扫描请求
        if (message.type === 'TRIGGER_VUE_RESCAN') {
            // 转发重扫描请求到页面脚本
            window.postMessage({
                type: 'MANUAL_RESCAN_VUE',
                source: 'antidebug-extension'
            }, '*');
            sendResponse({success: true});
        }
        
        
        return true;
    });

    // 监听来自页面脚本的 Vue Router 数据
    window.addEventListener('message', (event) => {
        // 只接受来自同一窗口的消息
        if (event.source !== window) return;

        // 检查消息类型（get-vue-script：静态路由；get-vue-dynamic-script：动态路由+Pinia菜单；get-nuxt-script：Nuxt payload）
        if (event.data && event.data.type === 'VUE_ROUTER_DATA' &&
            (event.data.source === 'get-vue-script' || event.data.source === 'get-vue-dynamic-script' || event.data.source === 'get-nuxt-script')) {
            // V4.9.11（验收修复 B5）：加**结构校验**——`event.source === window` 拦不住页面自身的 JS，
            // 被测站点只要 postMessage 一个 {type:'VUE_ROUTER_DATA', source:'get-vue-script'} 就能污染
            // storage 里的路由数据、误导后续分析（对比 CRYPTO_DATA 分支本就有结构校验）。
            // 说明：这抬高的是"误报与随手污染"的门槛，**挡不住蓄意伪造**（页面仍可构造合法结构）——
            // 彻底防护需要页面脚本 ↔ 扩展的随机 token 机制（记为后续安全增强项）
            const d = event.data.data;
            const okShape = !!d && typeof d === 'object' && (
                d.notFound === true ||                                                    // 允许"未找到"瞬时观测
                (Array.isArray(d.instances) && d.instances.length > 0) ||
                (Array.isArray(d.dynamicRoutes) && d.dynamicRoutes.length > 0) ||
                (Array.isArray(d.piniaMenus) && d.piniaMenus.length > 0) ||
                (d.nuxt && typeof d.nuxt === 'object')
            );
            if (!okShape) return;
            // 转发到 background/popup
            sendUplink({
                type: 'VUE_ROUTER_DATA',
                data: d
            });
        }

        // Hook 数据桥：页面内 Hook 脚本的 console 输出 → MCP get_hook_data
        if (event.data && event.data.type === 'CONSOLE_LOG' && event.data.source === 'hook-console-bridge') {
            sendUplink({
                type: 'MCP_HOOK_DATA',
                data: {
                    scriptId: 'console',
                    level: event.data.level || 'log',
                    message: event.data.text,
                    pageTimestamp: event.data.timestamp
                }
            });
        }

        // 🆕 V3.1 密码学能力上报（Crypto_Capture 脚本）：注册能力/解密响应 → MCP get_hook_data
        if (event.data && event.data.type === 'CRYPTO_DATA' && event.data.source === 'crypto-capture') {
            try {
                const payload = event.data.data || {};
                // 结构校验：防页面伪造消息污染 get_hook_data
                const events = Array.isArray(payload.events) ? payload.events : [];
                if (events.length === 0) return;
                const validEvents = events.filter(ev => {
                    if (!ev || typeof ev !== 'object') return false;
                    if (ev.event === 'capability') {
                        const c = ev.capability;
                        return !!c && typeof c === 'object' && typeof c.kind === 'string' && typeof c.algorithm === 'string';
                    }
                    if (ev.event === 'decrypt_response') {
                        return typeof ev.url === 'string' && typeof ev.algorithm === 'string';
                    }
                    return false;
                });
                if (validEvents.length === 0) return;
                sendUplink({
                    type: 'MCP_HOOK_DATA',
                    data: {
                        scriptId: 'crypto_capture',
                        level: 'info',
                        message: JSON.stringify({ events: validEvents, timestamp: payload.timestamp }),
                        pageTimestamp: event.data.timestamp
                    }
                });
            } catch (e) {
                // JSON 序列化失败忽略
            }
        }

        // V4.3 store dump（Get_Store_Dump 脚本）：Pinia/Vuex 全量状态 → background 存储
        // V4.5：WS 监控帧上报（hook_websocket 脚本 → get_ws_messages 查询）
        if (event.data && event.data.type === 'WS_FRAME_DATA' && event.data.source === 'ws-monitor-script') {
            const frame = event.data.data || {};
            if (frame && frame.url) {
                sendUplink({
                    type: 'WS_FRAME_DATA',
                    data: frame,
                    timestamp: event.data.timestamp
                });
            }
        }
        if (event.data && event.data.type === 'STORE_DUMP_DATA' && event.data.source === 'store-dump-script') {
            const dump = event.data.data || {};
            if (dump && dump.totalStores > 0) {
                sendUplink({
                    type: 'STORE_DUMP_DATA',
                    data: dump,
                    timestamp: event.data.timestamp
                });
            }
        }
    });

    // 页面加载完成后补推上次会话积压的数据（扩展重载/断联期间落盘的部分）
    flushPendingUplink();
})();
