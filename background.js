// ====== MCP 客户端集成 ====== //
importScripts('mcp-client.js');

// ====== 脚本注册管理 ====== //
const scriptRegistry = new Map(); // 存储: [hostname|scriptId] => 注册ID
let isInitialized = false;

// 🆕 全局模式存储键名
const GLOBAL_MODE_KEY = 'antidebug_mode';
const GLOBAL_SCRIPTS_KEY = 'global_scripts';

// 🆕 全局请求头存储键名
const HEADERS_ENABLED_KEY = 'global_headers_enabled';

// V4.9.30：值同样是**数组**、但不是 hostname 的 storage 键——用于 storage.onChanged /
// 初始化遍历时判别"这个键是不是 hostname"。
// 原先的判据是 `key.includes('.')`，本意就是排除这两个；但它**顺便把不含点的 hostname
// （localhost、内网单标签名）也排除了**，而 registerScripts 的注释明写"支持 localhost、
// 内部服务名"——两处口径矛盾，实际从未支持过。
// ⚠️ 新增"值是数组的非 hostname 键"时**必须登记到这里**，否则会被当成 hostname 去注册
// content script（非法 match pattern 会被 Chrome 拒绝并抛错）。
const NON_HOSTNAME_ARRAY_KEYS = new Set([GLOBAL_SCRIPTS_KEY, 'global_headers_groups']);

// 确定性注册 id：同 hostname|scriptId 组合永远生成同一个 id。
// 旧版用随机 id（ad_时间戳_随机串）+ 内存表去重——SW 每次唤醒内存表清空而持久注册仍在，
// 导致每次唤醒"全量注销→全量重注册"churn（空窗期页面拿不到 hook，注册数随唤醒次数膨胀）。
// 确定性 id 下重复注册天然幂等，内存表可通过 getRegisteredContentScripts 对账重建。
function scriptRegId(keyPrefix, scriptId) {
    // chrome.scripting 注册 id 仅允许字母数字下划线，sanitize hostname 等输入
    return `ad_${(`${keyPrefix}_${scriptId}`).replace(/[^a-zA-Z0-9_]/g, '_')}`.slice(0, 250);
}

// 内存注册表与浏览器持久注册对账：SW 唤醒后内存表为空，从持久注册重建映射。
// 重建依据：注册对象的 js 路径（scripts/<scriptId>.js → scriptId）与 matches（*://<hostname>/* → hostname，
// <all_urls> → global）——不从 id 反推（hostname 的点号被 sanitize + 脚本 id 自身含下划线，反推不可靠）
let registrySynced = false;
let wsFrameWriteChain = Promise.resolve(); // WS 帧写入串行化链（防并发 get/set 互相覆盖丢帧）
// V4.9.11（独立审计 L6）：Vue 路由数据同理由——三个上报分支（静态/动态/Nuxt）是不同脚本的不同消息，
// 并发到达时 get→set 会互相覆盖（static 读到旧 prev 写回，把刚合并的 dynamicRoutes 又抹掉）
let vueDataWriteChain = Promise.resolve();

// V4.6：站点侦察缓存 TTL 清理（_vue_data/_store_dump/_ws_frames 按 hostname 累积，
// 长期使用会撞 storage.local 配额导致新数据写入静默失败）——48h 未更新的键清除
const SITE_DATA_TTL_MS = 48 * 60 * 60 * 1000;
const SITE_DATA_SUFFIXES = ['_vue_data', '_store_dump', '_ws_frames'];
async function cleanupStaleSiteData() {
    try {
        const all = await chrome.storage.local.get(null);
        const now = Date.now();
        const toRemove = [];
        for (const [k, v] of Object.entries(all)) {
            if (!SITE_DATA_SUFFIXES.some(s => k.endsWith(s))) continue;
            const ts = Array.isArray(v) ? (v[v.length - 1] && v[v.length - 1].timestamp) : (v && v.timestamp);
            if (!ts || now - ts > SITE_DATA_TTL_MS) toRemove.push(k);
        }
        if (toRemove.length) {
            await chrome.storage.local.remove(toRemove);
            console.log('[AntiDebug] 已清理过期站点缓存:', toRemove.length, '个键');
        }
    } catch (e) { /* 清理失败不影响主流程 */ }
}
cleanupStaleSiteData();
async function syncRegistryFromBrowser() {
    if (registrySynced) return;
    try {
        const registered = await chrome.scripting.getRegisteredContentScripts();
        registered.forEach(script => {
            const jsPath = (script.js && script.js[0]) || '';
            const m = /^scripts\/(.+)\.js$/.exec(jsPath);
            if (!m) return;
            const scriptId = m[1];
            const matches = script.matches || [];
            for (const pattern of matches) {
                if (pattern === '<all_urls>') {
                    scriptRegistry.set(`global|${scriptId}`, script.id);
                } else {
                    // *://example.com/* → example.com
                    const host = /^\*:\/\/([^/]+)\/\*$/.exec(pattern);
                    if (host) scriptRegistry.set(`${host[1]}|${scriptId}`, script.id);
                }
            }
        });
        registrySynced = true;
    } catch (error) {
        console.error('[AntiDebug] 注册表对账失败:', error);
    }
}

// 🔧 新增：清理指定模式的所有脚本注册
async function clearModeScripts(isGlobalMode) {
    const keysToRemove = [];
    const keyPrefix = isGlobalMode ? 'global' : '';
    
    for (const [key, regId] of scriptRegistry) {
        if (isGlobalMode) {
            // 清理全局模式：移除所有以"global|"开头的键
            if (key.startsWith('global|')) {
                keysToRemove.push(key);
            }
        } else {
            // 清理标准模式：移除所有不以"global|"开头的键（即域名键）
            if (!key.startsWith('global|') && key.includes('|')) {
                keysToRemove.push(key);
            }
        }
    }

    if (keysToRemove.length > 0) {
        const removeIds = keysToRemove.map(key => scriptRegistry.get(key));

        try {
            await chrome.scripting.unregisterContentScripts({
                ids: removeIds
            });
            console.log(`[AntiDebug] Cleared ${isGlobalMode ? 'global' : 'standard'} mode scripts:`, keysToRemove);

            // 清理注册表
            keysToRemove.forEach(key => scriptRegistry.delete(key));
        } catch (error) {
            if (!error.message.includes('Nonexistent')) {
                console.error('[AntiDebug] Failed to clear mode scripts:', error);
            }
        }
    }
}

// 🆕 注册脚本到主世界（支持全局模式）
	async function registerScripts(hostname, scriptIds, isGlobalMode = false) {
	    // 🆕 全局模式允许特殊的hostname值
	    if (!isGlobalMode) {
	        // 支持 localhost、内部服务名、含特殊字符的 hostname（横线、下划线）
	        if (!hostname || typeof hostname !== 'string' || hostname.trim() === '') {
	            console.warn('[AntiDebug] 无效 hostname，跳过注册');
	            return [];
	        }
	        // 长度限制（253 字符，符合浏览器约束），超长不报错但可能截断
	        if (hostname.length > 253) {
	            console.warn(`[AntiDebug] hostname 超长（${hostname.length} > 253），可能截断`);
	        }
	    }

    // 过滤有效脚本ID
    const validScriptIds = scriptIds.filter(
        id => typeof id === 'string' && id.trim() !== ''
    );

    // 🆕 创建当前应存在的键集合（支持全局模式）
    const currentKeys = new Set();
    const keyPrefix = isGlobalMode ? 'global' : hostname;
    validScriptIds.forEach(id => {
        currentKeys.add(`${keyPrefix}|${id}`);
    });

    // === 1. 注销不再需要的脚本 ===
    const keysToRemove = [];
    for (const [key, regId] of scriptRegistry) {
        if (key.startsWith(`${keyPrefix}|`) && !currentKeys.has(key)) {
            keysToRemove.push(key);
        }
    }

    if (keysToRemove.length > 0) {
        const removeIds = keysToRemove.map(key => scriptRegistry.get(key));

        try {
            await chrome.scripting.unregisterContentScripts({
                ids: removeIds
            });
            // console.log(`[AntiDebug] Unregistered scripts for ${keyPrefix}:`, keysToRemove);

            // 清理注册表
            keysToRemove.forEach(key => scriptRegistry.delete(key));
        } catch (error) {
            if (!error.message.includes('Nonexistent')) {
                // console.error('[AntiDebug] Failed to unregister old scripts:', error);
            }
        }
    }

    // === 2. 注册新脚本 ===
    const scriptsToRegister = [];

    // 先对账：确保内存表反映浏览器真实注册状态（SW 唤醒场景）
    await syncRegistryFromBrowser();

    validScriptIds.forEach(id => {
        const key = `${keyPrefix}|${id}`;

        // 如果尚未注册，则创建新注册项（对账后 has 检查真实有效）
        if (!scriptRegistry.has(key)) {
            const regId = scriptRegId(keyPrefix, id);
            scriptRegistry.set(key, regId);

            // 🆕 根据模式设置matches
            const matches = isGlobalMode ? ['<all_urls>'] : [`*://${hostname}/*`];

            scriptsToRegister.push({
                id: regId,
                js: [`scripts/${id}.js`],
                matches: matches,
                runAt: 'document_start',
                world: 'MAIN'
            });
        }
    });

    if (scriptsToRegister.length > 0) {
        try {
            await chrome.scripting.registerContentScripts(scriptsToRegister);
            // console.log(`[AntiDebug] Registered new scripts for ${keyPrefix}:`,
            //     scriptsToRegister.map(s => s.id));
        } catch (error) {
            // 确定性 id 已被注册（对账窗口期外的竞态）：幂等跳过，不视为错误
            if (error.message.includes('Duplicate id')) {
                /* 幂等，忽略 */
            } else {
                // V4.9.38（批 3 审计 R-1 🔴）：**必须向上抛**。原实现只 console.error 就正常返回，
                // 于是 registerScripts 永不 reject → background 的 `success:false` 分支
                //（V4.9.30 M-bg4 专门修的"注册失败如实回报"）永远不会触发，popup 也只看 UI 重画。
                // 注册失败 = hook 实际未注入，而开关显示已启用 —— 正是本项目最警惕的"假成功"。
                console.error(`[AntiDebug] Failed to register scripts for ${keyPrefix}:`, error);
                throw error;
            }
        }
    }
}

// 初始化时清除所有旧注册
async function initializeScriptRegistry() {
    if (isInitialized) return;

    try {
        // 清除所有旧注册
        const registered = await chrome.scripting.getRegisteredContentScripts();
        const ourScripts = registered.filter(script => script.id.startsWith('ad_'));

        if (ourScripts.length > 0) {
            await chrome.scripting.unregisterContentScripts({
                ids: ourScripts.map(s => s.id)
            });
            // console.log('[AntiDebug] Cleared old script registrations');
        }

        isInitialized = true;
    } catch (error) {
        console.error('[AntiDebug] Initialization failed:', error);
    }
}

// ====== 初始化及原有徽章管理 ====== //
// 全量清理旧注册仅在扩展安装/更新时执行。
// 确定性 id + 对账机制下，SW 每次唤醒不需要任何注册动作（持久注册跨 SW 休眠与浏览器重启均有效）。
// 注意：不挂 onStartup 全量注销——注册跨浏览器重启持久，注销后无重建会让所有 hook 静默失效（旧版回归）。
chrome.runtime.onInstalled.addListener(async () => {
    // V4.9.15：生成安装级 WS token（可选启用机制的一端）——server 设 ADB_WS_TOKEN 环境变量
    // 且与此处生成的 token 一致时，WS 连接校验生效（默认不设环境变量则无校验，行为同旧版）
    try {
        const stored = await chrome.storage.local.get(['adb_ws_token']);
        if (!stored.adb_ws_token) {
            const buf = new Uint8Array(32);
            crypto.getRandomValues(buf);
            const token = Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
            await chrome.storage.local.set({ adb_ws_token: token });
            console.error('[AntiDebug] 已生成安装级 WS token（ adb_ws_token ）');
        }
    } catch (e) {
        console.error('[AntiDebug] WS token 生成失败:', e);
    }
    // 安装/更新语境：先全量清理（含旧版本的随机 id 注册），再按当前配置串行重建。
    // 两个动作必须串行（注销与注册并发会互相清掉对方刚完成的写入）
    try {
        await initializeScriptRegistry();
        await rebuildAllRegistrations();
    } catch (error) {
        console.error('[AntiDebug] onInstalled rebuild failed:', error);
    }
});

// 安装/更新后按当前配置全量重注册 + 初始化徽章（仅在 onInstalled 语境执行）
async function rebuildAllRegistrations() {
    try {
        const data = await chrome.storage.local.get(null);
        const mode = data[GLOBAL_MODE_KEY] || 'standard';
        const globalScripts = data[GLOBAL_SCRIPTS_KEY] || [];

        if (mode === 'global' && globalScripts.length > 0) {
            await registerScripts('*', globalScripts, true);
        }

        const promises = [];
        Object.keys(data).forEach(hostname => {
            // V4.9.30：判据由 `hostname.includes('.')` 改为显式排除非 hostname 数组键
            //（原判据把 localhost/内网单标签名一并排除，见 NON_HOSTNAME_ARRAY_KEYS 的说明）
            if (Array.isArray(data[hostname]) && !NON_HOSTNAME_ARRAY_KEYS.has(hostname)) {
                const validCount = data[hostname].filter(
                    id => typeof id === 'string' && id.trim() !== ''
                ).length;

                updateBadgeForHostname(hostname, validCount);

                // 🆕 只在标准模式下初始化脚本注册
                if (mode === 'standard') {
                    // M-bg3 修复：纳入 await 链——原 fire-and-forget 在 SW 被杀时注册半途丢失且无重试路径
                    promises.push(registerScripts(hostname, data[hostname], false));
                }
            }
        });
        await Promise.all(promises);
    } catch (error) {
        console.error('[AntiDebug] rebuildAllRegistrations failed:', error);
    }
}

// 监听存储变化并同步
chrome.storage.onChanged.addListener(async (changes, namespace) => {
    for (let [key, {newValue}] of Object.entries(changes)) {
        if (namespace === 'local') {
            // 🆕 处理全局模式变化
            if (key === GLOBAL_MODE_KEY) {
                // 模式切换时重新初始化所有脚本
                // 这里可以根据需要添加更多逻辑
                continue;
            }
            
            // 🆕 处理全局脚本变化
            if (key === GLOBAL_SCRIPTS_KEY && Array.isArray(newValue)) {
                // 更新全局脚本注册
                await registerScripts('*', newValue, true);
                continue;
            }
            
            if (Array.isArray(newValue) && !NON_HOSTNAME_ARRAY_KEYS.has(key)) {
                // 更新标准模式脚本注册
                await registerScripts(key, newValue, false);

                // 同步到所有标签页的localStorage
                // V4.9.22（修复）：原实现是 fire-and-forget——executeScript 的 Promise 既不 await 也不 catch。
                // 对**冻结/睡眠标签**该 Promise 永不 settle（项目 V4.7.1 就记录过的已知坑，也是 executeScript
                // 工具迁 CDP 的原因），于是广播**静默失效**：popup 里改了脚本开关，那类标签不生效且无任何提示
                // （用户以为改成功了，实际要等刷新）。现加硬超时 + 失败留痕（禁静默降级；
                // withHardTimeout 来自 mcp-client.js——两文件同处一个 SW 全局作用域，importScripts 同步加载）
                chrome.tabs.query({}, (tabs) => {
                    tabs.forEach(tab => {
                        if (tab.url) {
                            try {
                                const tabHostname = new URL(tab.url).hostname;
                                if (tabHostname === key) {
                                    withHardTimeout(chrome.scripting.executeScript({
                                        target: {tabId: tab.id},
                                        func: (hostname, scripts) => {
                                            try {
                                                const storageData = localStorage.getItem('AntiDebug_Breaker') || '{}';
                                                const parsed = JSON.parse(storageData);
                                                parsed[hostname] = scripts;
                                                localStorage.setItem('AntiDebug_Breaker', JSON.stringify(parsed));
                                            } catch (e) {
                                                console.warn('[AntiDebug] Failed to update localStorage', e);
                                            }
                                        },
                                        args: [key, newValue]
                                    }), 8000, '__adb_broadcast_timeout__')
                                        .catch((e) => {
                                            console.warn(`[AntiDebug] 脚本状态广播到 tab ${tab.id} 失败（该标签可能已冻结/睡眠）——刷新该页即可生效:`, (e && e.message) || e);
                                        });
                                }
                            } catch (e) {
                                // 忽略URL解析错误
                            }
                        }
                    });
                });
            }
        }
    }
});

// 监听来自 content script 的消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // 🔧 新增：处理清理旧模式脚本的请求
    if (message.type === 'clear_mode_scripts') {
        clearModeScripts(message.clearGlobalMode);
        sendResponse({success: true});
        return false;   // V4.9.11（验收修复 B10）：已同步响应，必须返回 false——return true 会保持通道开放等一个永不到来的响应
    }
    
    // 🆕 处理全局请求头更新
    if (message.type === 'UPDATE_GLOBAL_HEADERS') {
        // V4.9.24：**透传作用域**——popup 发来的 targetDomains 原被整个丢掉，于是从 UI 改的头
        // 永远是"全站注入"（这条链与 mcp-client 的 applyGlobalHeaders 是两条独立入参路径，都要通）
        updateGlobalHeaders(message.headers, message.targetDomains);
        // 更新扩展图标徽章显示请求头数量
        updateHeadersBadge(message.headers ? message.headers.length : 0);
        sendResponse({success: true});
        return false;   // V4.9.11（验收修复 B10）：已同步响应，必须返回 false——return true 会保持通道开放等一个永不到来的响应
    }
    
    // 🆕 处理脚本注册更新请求（支持全局模式）
    if (message.type === 'update_scripts_registration') {
        const isGlobalMode = message.isGlobalMode || false;
        const hostname = message.hostname;
        const enabledScripts = message.enabledScripts;
        
        // M-bg4 修复：await 实际结果——原 fire-and-forget + 无条件 success 是假成功（注册失败被吞）
        registerScripts(hostname, enabledScripts, isGlobalMode)
            .then(() => sendResponse({ success: true }))
            .catch((err) => sendResponse({ success: false, error: String((err && err.message) || err) }));
        return true;  // 异步响应（修复后需要等 registerScripts 完成）
    }
    
    // 处理 Vue Router 数据
    if (message.type === 'VUE_ROUTER_DATA' && sender.tab) {
        try {
            const hostname = new URL(sender.tab.url).hostname;
            const storageKey = `${hostname}_vue_data`;

            // V4.9.11（独立审计 L6）：三个分支都是 get→set 非事务读改写——static 与 DYNAMIC/NUXT
            // 并发上报时会读到同一 prev，后者整体覆盖前者（又丢 dynamicRoutes，即本组改动想修的问题）。
            // 复用 WS 帧的链式串行化模式：同一时间只有一个分支在读改写
            const chainWrite = (writer) => {
                vueDataWriteChain = vueDataWriteChain
                    .then(() => new Promise((done) => {
                        // V4.9.11（复核 ⚠️-2）：done 必须被调用——writer 体抛异常会让这个 Promise 永挂，
                        // 整条链（全 hostname 共用）随之卡死、后续所有 Vue 写入静默丢失。故异常兜底 + 超时兜底
                        // V4.9.11（验收修复 B6）：兜底 timer 保存下来并在正常完成时 clear——
                        // 原实现每次都挂一个永不清除的 setTimeout，使 MV3 SW 每笔写入延寿最多 3 秒
                        let settled = false;
                        let guardTimer = null;
                        const once = () => {
                            if (settled) return;
                            settled = true;
                            if (guardTimer) clearTimeout(guardTimer);
                            done();
                        };
                        try { writer(once); } catch (e) { once(); }
                        guardTimer = setTimeout(once, 3000);
                    }))
                    .catch(() => {});
            };

            // 动态路由/Pinia 数据（Get_Vue_Dynamic 脚本）→ 合并存储，避免覆盖静态路由数据
            if (message.data && message.data.type === 'DYNAMIC_ROUTES_PINIA') {
                chainWrite((done) => {
                    chrome.storage.local.get([storageKey], (old) => {
                        const prev = old[storageKey] || {};
                        chrome.storage.local.set({
                            [storageKey]: {
                                ...prev,
                                dynamicRoutes: message.data.dynamicRoutes || [],
                                piniaMenus: message.data.piniaMenus || [],
                                dynamicTimestamp: message.data.timestamp,
                                // V4.9.11：记录来源标签页——页面 loading 时的清理据此判断"是不是别人的数据"（见 tabs.onUpdated）
                                __srcTab: sender.tab.id,
                                timestamp: Date.now()
                            }
                        }, () => done());
                    });
                });
            } else if (message.data && message.data.type === 'NUXT_DATA') {
                // Nuxt payload 数据（Get_Nuxt 脚本）→ 合并存储
                chainWrite((done) => {
                    chrome.storage.local.get([storageKey], (old) => {
                        const prev = old[storageKey] || {};
                        chrome.storage.local.set({
                            [storageKey]: {
                                ...prev,
                                nuxtData: message.data.nuxt,
                                nuxtTimestamp: message.data.timestamp,
                                __srcTab: sender.tab.id,   // V4.9.11：来源标签页（loading 清理判据）
                                timestamp: Date.now()
                            }
                        }, () => done());
                    });
                });
            } else {
                // 静态路由数据（Get_Vue_0 脚本）→ 合并存储
                // V4.9.11（子代理调查发现）：原为整键覆盖 [storageKey]: {...message.data}——
                // Get_Vue_0 有最多 8 次/60s 的轮询重试，一旦在 Get_Vue_Dynamic/Get_Nuxt 之后落地，
                // 会把已合并的 dynamicRoutes/piniaMenus/nuxtData 整个抹掉（route_api_graph 菜单关联丢数据）。
                // 改为与上面两个分支同样的合并语义：静态键刷新、动态键保留。
                // V4.9.11（独立审计 H1）：notFound 上报是**瞬时观测**（routes/vueVersion/routerMode 全为 null），
                // 纯合并会让这些 null 覆盖已有有效数据、且 notFound:true 永久粘滞（成功上报体不带该键，
                // 无法自动清除）→ navigate_vue_route 被锁死在"未获取到路由数据"。故分隔处理：
                //   · notFound 上报：只刷 timestamp，仅在本地无数据时记标记，绝不覆盖已有数据
                //   · 成功上报：清除粘滞标记（delete notFound）
                chainWrite((done) => {
                    chrome.storage.local.get([storageKey], (old) => {
                        const prev = old[storageKey] || {};
                        const incoming = message.data || {};
                        const hasInstances = Array.isArray(incoming.instances) && incoming.instances.length > 0;
                        let merged;
                        if (incoming.notFound && !hasInstances) {
                            merged = { ...prev, timestamp: Date.now() };
                            // 复核补充：已有**任何**数据时 notFound 标记无意义，一律清掉（含修前写入的历史记录，
                            // 否则老记录会一直粘滞到页面导航）。判据要宽——只看 instances 会让"只有动态路由/
                            // Pinia/Nuxt"的站落成 {dynamicRoutes:[...], notFound:true}，读侧 isReady 据此拒绝、
                            // navigate_vue_route 报"无路由数据"
                            const prevHasAny = (Array.isArray(prev.instances) && prev.instances.length > 0) ||
                                (Array.isArray(prev.dynamicRoutes) && prev.dynamicRoutes.length > 0) ||
                                (Array.isArray(prev.piniaMenus) && prev.piniaMenus.length > 0) ||
                                !!prev.nuxtData;
                            // V4.9.11（验收修复 A6）：notFound 是**瞬时观测、本身不含任何数据**，
                            // 因此**不覆盖 __srcTab**——原实现在 if/else 之外无条件赋值，会让
                            // "无数据的 tab B 上报 notFound"抢走 tab A 的数据归属权：此后 B 导航
                            // 会删掉 A 正在用的数据，或 A 关闭时数据无人认领而永久滞留。
                            // prev 无数据时 __srcTab 本就是 undefined，无需显式设置
                            if (prevHasAny) delete merged.notFound;
                            else merged.notFound = true;
                        } else {
                            merged = { ...prev, ...incoming, timestamp: Date.now() };
                            delete merged.notFound;
                            merged.__srcTab = sender.tab.id;   // V4.9.11：来源标签页（loading 清理判据）——仅真实数据上报才更新归属
                        }
                        chrome.storage.local.set({ [storageKey]: merged }, () => done());
                    });
                });
            }
            // 转发给所有打开的popup（如果有的话）
            chrome.runtime.sendMessage({
                type: 'VUE_ROUTER_DATA_UPDATE',
                hostname: hostname,
                data: message.data
            }).catch(() => {
                // popup未打开，忽略错误
            });
        } catch (e) {
            console.error('[AntiDebug] Failed to store Vue Router data:', e);
        }

        sendResponse({success: true});
        return false;   // V4.9.11（验收修复 B10）：已同步响应，必须返回 false——return true 会保持通道开放等一个永不到来的响应
    }

    // 🆕 V4.3 处理 store dump 数据（Get_Store_Dump 脚本）：Pinia/Vuex 全量状态按 hostname 独立存储
    // V4.5：WS 监控帧入库（环形 200 条，按 hostname 隔离）。
    // 写侧 promise 链串行化：get→push→set 非事务，两帧并发到达时后者会覆盖前者丢帧
    if (message.type === 'WS_FRAME_DATA' && sender.tab) {
        try {
            const hostname = new URL(sender.tab.url).hostname;
            const key = `${hostname}_ws_frames`;
            const frame = { ...message.data, timestamp: message.data.timestamp || Date.now() };
            wsFrameWriteChain = wsFrameWriteChain.then(() =>
                new Promise((resolve) => {
                    chrome.storage.local.get([key], (result) => {
                        const frames = Array.isArray(result[key]) ? result[key] : [];
                        frames.push(frame);
                        const obj = {};
                        obj[key] = frames.slice(-200);
                        chrome.storage.local.set(obj, () => resolve());
                    });
                }).catch(() => {})
            );
        } catch (e) {
            console.error('[AntiDebug] Failed to store ws frame:', e);
        }
        sendResponse({success: true});
        return;
    }
    if (message.type === 'STORE_DUMP_DATA' && sender.tab) {
        try {
            const hostname = new URL(sender.tab.url).hostname;
            chrome.storage.local.set({
                [`${hostname}_store_dump`]: {
                    ...message.data,
                    timestamp: Date.now()
                }
            });
        } catch (e) {
            console.error('[AntiDebug] Failed to store dump data:', e);
        }
        sendResponse({success: true});
        return false;   // V4.9.11（验收修复 B10）：已同步响应，必须返回 false——return true 会保持通道开放等一个永不到来的响应
    }

    // 未匹配任何已知消息类型：不保持响应通道开放（返回 undefined），
    // 避免其他上下文（如 popup/content）的无关消息 promise 挂起到 SW 生命周期结束
});

// 监听标签切换事件
chrome.tabs.onActivated.addListener((activeInfo) => {
    chrome.tabs.get(activeInfo.tabId, (tab) => {
        if (tab.url) {
            updateBadgeForTab(tab);
        }
    });
});

// 监听标签URL变化 - 关键修改：只在页面加载完成后更新徽章
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // 只在页面加载完成后更新徽章
    if (changeInfo.status === 'complete') {
        updateBadgeForTab(tab);
    }
    
    // 当页面开始加载时，清除旧的 Vue Router 数据
    if (changeInfo.status === 'loading' && tab.url) {
        try {
            const hostname = new URL(tab.url).hostname;
            const storageKey = `${hostname}_vue_data`;
            // V4.9.11（独立审计发现）：原为无条件 remove——storage 按 hostname 存，同域多标签场景下
            // tab A 刷新会把 tab B 刚采集的数据一并清掉（AI 随即读到 timeout）。改为按来源标签页判断：
            // 数据来自别的、且仍存活的标签页 → 保留（那份数据对那个页面仍有效）；
            // 来源标签页已关闭、或标记缺失（旧数据/popup 写入）→ 照常清除
            chrome.storage.local.get([storageKey], (r) => {
                const prev = r && r[storageKey];
                const srcTab = prev && prev.__srcTab;
                if (srcTab === undefined || srcTab === tabId) {
                    chrome.storage.local.remove(storageKey);
                    return;
                }
                chrome.tabs.get(srcTab, () => {
                    if (chrome.runtime.lastError) chrome.storage.local.remove(storageKey);   // 来源标签已关 → 陈旧数据
                    // 来源标签仍在 → 保留它的数据
                });
            });
        } catch (e) {
            // 忽略错误
        }
    }
});

// 处理消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'tab_updated') {
        updateBadgeForTab(message.tab);
    }
});

// 🆕 更新标签页徽章（支持全局模式）
function updateBadgeForTab(tab) {
    if (!tab.url) return;

    try {
        // 🆕 获取全局模式状态
        chrome.storage.local.get([GLOBAL_MODE_KEY, GLOBAL_SCRIPTS_KEY], (result) => {
            const mode = result[GLOBAL_MODE_KEY] || 'standard';
            
            if (mode === 'global') {
                // 全局模式：显示全局脚本数量
                const globalScripts = result[GLOBAL_SCRIPTS_KEY] || [];
                const validCount = globalScripts.filter(
                    id => typeof id === 'string' && id.trim() !== ''
                ).length;
                updateBadge(tab.id, validCount);
            } else {
                // 标准模式：显示当前域名脚本数量
                const hostname = new URL(tab.url).hostname;
                chrome.storage.local.get([hostname], (domainResult) => {
                    const enabledScripts = domainResult[hostname] || [];
                    const validCount = enabledScripts.filter(
                        id => typeof id === 'string' && id.trim() !== ''
                    ).length;
                    updateBadge(tab.id, validCount);
                });
            }
        });
    } catch (error) {
        console.error('Error updating badge for tab:', tab, error);
    }
}

// 更新特定域名的徽章
function updateBadgeForHostname(hostname, count) {
    chrome.tabs.query({}, (tabs) => {
        tabs.forEach(tab => {
            if (tab.url) {
                try {
                    const tabHostname = new URL(tab.url).hostname;
                    if (tabHostname === hostname) {
                        updateBadge(tab.id, count);
                    }
                } catch (e) {
                    // 忽略URL解析错误
                }
            }
        });
    });
}

// 🆕 全局请求头数量缓存
let globalHeadersCount = 0;

// 设置徽章文本（脚本数量 + 请求头数量）
function updateBadge(tabId, scriptCount) {
    const totalCount = scriptCount + globalHeadersCount;
    console.log('[AntiDebug] updateBadge: tabId=', tabId, ', scriptCount=', scriptCount, ', globalHeadersCount=', globalHeadersCount, ', total=', totalCount);
    if (totalCount > 0) {
        chrome.action.setBadgeText({text: totalCount.toString(), tabId});
        // 如果有请求头用绿色，否则用蓝色
        const color = globalHeadersCount > 0 ? '#00c853' : '#4688F1';
        chrome.action.setBadgeBackgroundColor({color: color, tabId});
    } else {
        chrome.action.setBadgeText({text: '', tabId});
    }
}

// 🆕 更新全局请求头徽章
function updateHeadersBadge(count) {
    globalHeadersCount = count;
    console.log('[AntiDebug] 更新请求头徽章, 数量:', count, ', globalHeadersCount:', globalHeadersCount);
    
    // 更新所有标签页的徽章
    chrome.tabs.query({}, (tabs) => {
        console.log('[AntiDebug] 更新', tabs.length, '个标签页的徽章');
        tabs.forEach(tab => {
            if (tab.url) {
                updateBadgeForTab(tab);
            }
        });
    });
}

// 🆕 更新全局请求头 - 双重方案：declarativeNetRequest + content script hook
// V4.9.11（验收修复 A3）：header 规则的"清空全部 → 添加"是**两步非原子**操作。
// 并发调用（AI 并行下发两个 header 工具、或用户快速切组）会交错成
// A移除 → B移除 → B添加 → A添加，结果是**先发起的反而生效**，与调用方的预期相反，
// 且 UI 显示的组与实际生效的规则不一致。用串行链保证同一时刻只有一笔规则写入在跑
// （与 vueDataWriteChain 同款模式）。注意链上只捕获、不抛出——header 写入失败不应
// 卡死后续写入，具体错误由 doUpdateGlobalHeaders 内部记录
let headerRuleWriteChain = Promise.resolve();

async function updateGlobalHeaders(headers, targetDomains) {
    // V4.9.22（修复🔴）：第二参**必须透传**——原实现把 targetDomains 丢在链上（`doUpdateGlobalHeaders(headers)`），
    // 而下游 condition IIFE 引用了这个**未绑定的自由变量** → 任何带 header 的写入都抛
    // `ReferenceError: targetDomains is not defined`（已用 chrome stub 实跑复现）；又因"先 remove 再 add"
    // 是两次独立调用，移除已成功而添加抛错 = **断头**（旧规则清光、新规则没写——用着 header 的站点反而丢头）。
    // 8 个调用点全是 `.catch(() => {})` 吞错 → "全局请求头"功能整体静默失效（只有事后 get_headers_config
    // 的 lastError 能看到痕迹）。修法：透传第二参；原子化改造见 temp/20261014_DNR作用域_调研.md（下轮随作用域一并做）。
    const run = headerRuleWriteChain.then(() => doUpdateGlobalHeaders(headers, targetDomains));
    // 链本身必须吞错（否则一次失败会污染整条链，后续写入全被跳过），
    // 但**返回给调用方的 promise 保留 rejection**——A2 依赖它来判定"规则到底生效没有"
    headerRuleWriteChain = run.catch(() => { /* 已由 run 的调用方处理 */ });
    return run;
}

async function doUpdateGlobalHeaders(headers, targetDomains) {
    const hasHeaders = headers && headers.length > 0;

    console.log('[AntiDebug] updateGlobalHeaders 被调用, headers:', JSON.stringify(headers));

    // 使用 declarativeNetRequest API（和 ModHeader 一样）
    try {
        // V4.9.24：**原子写入**——原实现"先 remove 再 add"是**两次独立调用**，add 一旦失败就留下
        // "旧规则已清光、新规则没写"的**断头**状态（用着 header 的站点反而丢头）。V4.9.22 修掉的
        // ReferenceError 是同一根因的另一半：那次是 add 根本没执行到，这次是 add 可能执行失败。
        // `updateDynamicRules` 单次调用本身是原子的——remove 与 add 一起提交，要么都生效要么都不生效
        const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
        const ruleIdsToRemove = existingRules.map(rule => rule.id);

        // 目标域归一化：小写 → 去 scheme/路径/端口 → 去空
        // 一个非法域名会让**整批** addRules 被拒（一个坏值 = 全组头一起失效），故先严格清洗
        const normDomains = (Array.isArray(targetDomains) ? targetDomains : [])
            .map(d => String(d == null ? '' : d).trim().toLowerCase()
                .replace(/^[a-z]+:\/\//, '')      // 去 scheme
                .replace(/[/?#].*$/, '')          // 去路径/查询/锚
                .replace(/:\d+$/, ''))            // 去端口
            .filter(d => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d));

        const addRules = [];
        if (hasHeaders) {
            const validHeaders = headers.filter(h => h.name && h.name.trim());

            if (validHeaders.length > 0) {
                // 为每个请求头创建操作
                const requestHeaders = validHeaders.map(h => ({
                    header: h.name.trim(),
                    operation: 'set',
                    value: h.value || ''
                }));

                const condition = {
                    resourceTypes: ['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest', 'ping', 'media', 'websocket', 'other']
                };
                // H-bg1 修复：带目标域白名单时限定作用域（headers 含凭据时不至于发往全站）；
                // 未指定 domains 保持旧的全站行为（向后兼容）——但打告警日志明示
                if (normDomains.length > 0) {
                    // 注意：requestDomains 匹配"域 **及其所有子域**"（官方语义），无法表达"仅精确主机"
                    condition.requestDomains = normDomains;
                } else {
                    console.error('[AntiDebug] ⚠️ 全局请求头为【全站注入】模式（未指定目标域）——凭据类 header 会随请求发给所有站点');
                }

                addRules.push({
                    id: 1,
                    priority: 1,
                    action: {
                        type: 'modifyHeaders',
                        requestHeaders: requestHeaders
                    },
                    condition
                });
            }
        }

        console.log('[AntiDebug] 原子写入 DNR：remove', ruleIdsToRemove.length, '条，add', addRules.length, '条，作用域',
            normDomains.length > 0 ? normDomains.join(', ') : '全站');

        await chrome.declarativeNetRequest.updateDynamicRules({
            removeRuleIds: ruleIdsToRemove,
            addRules
        });

        if (addRules.length > 0) {
            // 验证规则是否添加成功
            const currentRules = await chrome.declarativeNetRequest.getDynamicRules();
            console.log('[AntiDebug] ✅ 当前活动规则数量:', currentRules.length);
        } else {
            console.log('[AntiDebug] 已清除所有请求头规则');
        }
    } catch (error) {
        console.error('[AntiDebug] ❌ declarativeNetRequest 失败:', error.message, error.stack);
        // V4.9.11（验收修复 A2）：**向上抛出**——原实现只打日志就结束，调用方（applyGlobalHeaders）
        // 无从得知失败，于是 MCP 工具回报 success 而规则实际没生效（用户/AI 基于错误前提测试）。
        // 现在由 applyGlobalHeaders 记录到 storage，并经 get_headers_config 的 lastError 回显
        throw error;
    }

}

// 🆕 初始化时加载全局请求头配置（只使用当前选中组）
async function initGlobalHeaders() {
    try {
        const result = await chrome.storage.local.get(['global_headers_groups', 'global_headers_data', 'current_headers_group']);
        const data = result.global_headers_data || {};
        const currentGroupId = result.current_headers_group;
        
        // 只收集当前选中组的启用请求头
        const enabledHeaders = [];
        
        if (currentGroupId && data[currentGroupId]) {
            const items = data[currentGroupId] || [];
            items.forEach(item => {
                if (item.enabled && item.name && item.name.trim()) {
                    enabledHeaders.push({
                        name: item.name.trim(),
                        value: item.value || ''
                    });
                }
            });
        }
        
        // 无论有无请求头都更新规则（确保清理旧规则）
        // V4.9.38（批 4 审计 R-2 🔴）：第二参**必须透传**——原实现只传 headers，
        // 于是 SW 每次启动都会把 DNR 规则重写为"全站注入"（不设 condition.requestDomains）。
        // 而 popup 的作用域 UI 读的是 storage 里的 targetDomains，会继续显示"仅当前站点"。
        // MCP 开启时 SW 有 30s 保活、休眠/唤醒频繁 → 作用域在常态下失效，凭据头（Authorization/Cookie）
        // 会发往所有站点且用户零感知。与 applyGlobalHeaders / popup notifyHeadersUpdate 是三条独立
        // 入参路径，任何一条丢第二参都等于作用域失效。
        const groups = result.global_headers_groups || [];
        const curGroup = groups.find((g) => g && g.id === currentGroupId);
        const targetDomains = (curGroup && Array.isArray(curGroup.targetDomains) && curGroup.targetDomains.length > 0)
            ? curGroup.targetDomains
            : undefined;

        await updateGlobalHeaders(enabledHeaders, targetDomains);
        
        // 更新图标徽章
        updateHeadersBadge(enabledHeaders.length);
    } catch (error) {
        console.error('[AntiDebug] 初始化全局请求头失败:', error);
    }
}

// 在初始化时调用
initGlobalHeaders();
