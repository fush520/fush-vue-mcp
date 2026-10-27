document.addEventListener('DOMContentLoaded', () => {
    // ========== 版本徽章：动态读 manifest ==========
    // V4.9.22（UI 未同步更新问题）：popup.html 里原先**硬编码** `V4.9.14`——落后 8 个版本无人察觉，
    // 因为每次升版本只改 manifest/package/index.ts/README 四处，**没有任何机制保证 UI 跟上**。
    // 改为从 `chrome.runtime.getManifest().version` 动态读取：manifest.json 是版本的唯一事实源，
    // 以后升版本**无需再手动同步 UI**（硬编码的展示值是这类漂移的通用源头，一次改成动态源更值）。
    try {
        const badge = document.getElementById('ext-version-badge');
        if (badge) {
            const v = 'V' + chrome.runtime.getManifest().version;
            badge.textContent = v;
            badge.title = v;
        }
    } catch (e) { /* 取不到（非扩展环境）则保留占位文本 */ }

    // ========== Toast提示功能（仅用于固定值保存） ==========
    function showToast(message = '已保存') {
        const toast = document.getElementById('toast');
        if (!toast) return;
        
        const toastMessage = toast.querySelector('.toast-message');
        if (toastMessage) {
            toastMessage.textContent = message;
        }
        
        toast.classList.add('show');
        
        // 2秒后自动隐藏
        setTimeout(() => {
            toast.classList.remove('show');
        }, 2000);
    }
    // ========================================================

    // ========== MCP连接管理 ==========
    const mcpToggle = document.getElementById('mcp-toggle');
    const mcpIndicator = document.getElementById('mcp-indicator');
    const mcpStatusText = document.getElementById('mcp-status-text');

    // 初始化MCP状态
    function initMCPStatus() {
        chrome.storage.local.get(['mcp_enabled'], (result) => {
            const enabled = result.mcp_enabled === true;
            if (mcpToggle) {
                mcpToggle.checked = enabled;
            }
            updateMCPStatusUI();
        });
    }

    // 更新MCP状态UI
    function updateMCPStatusUI() {
        chrome.runtime.sendMessage({ type: 'GET_MCP_STATUS' }, (response) => {
            if (chrome.runtime.lastError) {
                // 忽略错误
                return;
            }

            if (response) {
                const { connected, enabled, connecting, port, reconnectAttempts, reconnectDelay } = response;

                // 侧边栏指示点
                if (mcpIndicator) {
                    mcpIndicator.classList.remove('connected', 'error', 'connecting');
                    if (!enabled) {
                        mcpIndicator.classList.add('error');
                    } else if (connected) {
                        mcpIndicator.classList.add('connected');
                    } else {
                        mcpIndicator.classList.add('connecting');
                    }
                }

                // 状态大卡片：主状态文字
                if (mcpStatusText) {
                    // 移除所有状态类名
                    mcpStatusText.classList.remove('status-connected', 'status-error', 'status-disabled', 'status-connecting');

                    if (!enabled) {
                        mcpStatusText.textContent = '状态：已禁用';
                        mcpStatusText.classList.add('status-disabled');
                    } else if (connected) {
                        mcpStatusText.textContent = '状态：已连接';
                        mcpStatusText.classList.add('status-connected');
                    } else if (connecting) {
                        mcpStatusText.textContent = '状态：连接中...';
                        mcpStatusText.classList.add('status-connecting');
                    } else {
                        // 无限重连中
                        const attemptsInfo = reconnectAttempts > 0 ? ` · 第${reconnectAttempts}次重试` : '';
                        mcpStatusText.textContent = `状态：等待连接${attemptsInfo}`;
                        mcpStatusText.classList.add('status-connecting');
                    }
                }

                // 状态大卡片：详情行
                const statusDetail = document.getElementById('mcp-status-detail');
                if (statusDetail) {
                    if (!enabled) {
                        statusDetail.textContent = '打开下方「启用 MCP」开关开始使用';
                    } else if (connected) {
                        statusDetail.textContent = `ws://localhost:${port} · 心跳正常 · 断线自愈已启用`;
                    } else if (connecting) {
                        statusDetail.textContent = `正在连接 ws://localhost:${port} ...`;
                    } else {
                        const delaySec = Math.ceil((reconnectDelay || 2000) / 1000);
                        statusDetail.textContent = `ws://localhost:${port} · ${delaySec}s 后自动重试（无限重连）`;
                    }
                }

                // 状态大卡片配色
                const statusCard = document.getElementById('mcp-status-card');
                if (statusCard) {
                    statusCard.classList.remove('status-card-connected', 'status-card-error', 'status-card-connecting');
                    if (!enabled) {
                        statusCard.classList.add('status-card-error');
                    } else if (connected) {
                        statusCard.classList.add('status-card-connected');
                    } else {
                        statusCard.classList.add('status-card-connecting');
                    }
                }

                // 顶部状态芯片
                const chip = document.getElementById('mcp-status-chip');
                const chipDot = document.getElementById('chip-dot');
                const chipText = document.getElementById('chip-text');
                if (chip && chipDot && chipText) {
                    chip.classList.remove('chip-connected', 'chip-error', 'chip-connecting');
                    if (!enabled) {
                        chipText.textContent = 'MCP 已禁用';
                        chip.classList.add('chip-error');
                    } else if (connected) {
                        chipText.textContent = 'MCP 已连接';
                        chip.classList.add('chip-connected');
                    } else {
                        chipText.textContent = 'MCP 未连接';
                        chip.classList.add('chip-connecting');
                    }
                }
            }
        });
    }

    // MCP开关事件
    if (mcpToggle) {
        mcpToggle.addEventListener('change', (e) => {
            const enabled = e.target.checked;
            chrome.storage.local.set({ mcp_enabled: enabled }, () => {
                updateMCPStatusUI();
                showToast(enabled ? 'MCP已启用' : 'MCP已禁用');
            });
        });
    }

    // MCP全局操作模式开关
    const mcpGlobalToggleEl = document.getElementById('mcp-global-toggle');
    
    // 初始化MCP全局操作模式
    function initMCPGlobalMode() {
        chrome.storage.local.get(['mcp_global_mode'], (result) => {
            const globalMode = result.mcp_global_mode === true;
            if (mcpGlobalToggleEl) {
                mcpGlobalToggleEl.checked = globalMode;
            }
        });
    }
    
    if (mcpGlobalToggleEl) {
        mcpGlobalToggleEl.addEventListener('change', (e) => {
            const enabled = e.target.checked;
            chrome.storage.local.set({ mcp_global_mode: enabled }, () => {
                showToast(enabled ? '全局操作模式已启用' : '全局操作模式已禁用');
            });
        });
    }
    
    // 初始化MCP全局模式
    initMCPGlobalMode();

    // 初始化MCP
    initMCPStatus();

    // ========== MCP 立即重连按钮 ==========
    const mcpReconnectBtn = document.getElementById('mcp-reconnect-btn');
    if (mcpReconnectBtn) {
        mcpReconnectBtn.addEventListener('click', () => {
            mcpReconnectBtn.disabled = true;
            mcpReconnectBtn.classList.add('reconnecting');
            chrome.runtime.sendMessage({ type: 'RECONNECT_MCP' }, () => {
                if (chrome.runtime.lastError) {
                    // 忽略错误
                }
                showToast('已请求重新连接');
                setTimeout(() => {
                    mcpReconnectBtn.disabled = false;
                    mcpReconnectBtn.classList.remove('reconnecting');
                    updateMCPStatusUI();
                }, 800);
            });
        });
    }

    // ========== 顶部状态芯片：点击跳转 MCP 板块 ==========
    const mcpStatusChip = document.getElementById('mcp-status-chip');
    if (mcpStatusChip) {
        mcpStatusChip.addEventListener('click', () => {
            const mcpNavBtn = document.querySelector('.nav-item[data-tab="mcp"]');
            if (mcpNavBtn) {
                mcpNavBtn.click();
            }
        });
    }

    // ========== MCP端口配置 ==========
    const mcpPortInput = document.getElementById('mcp-port-input');
    const mcpPortSaveBtn = document.getElementById('mcp-port-save');
    
    // 初始化MCP端口
    function initMCPPort() {
        chrome.storage.local.get(['mcp_port'], (result) => {
            const port = result.mcp_port || 9527;
            if (mcpPortInput) {
                mcpPortInput.value = port;
            }
        });
    }
    
    // 保存端口配置
    function saveMCPPort() {
        if (!mcpPortInput) return;
        
        let port = parseInt(mcpPortInput.value, 10);
        
        // 验证端口范围
        if (isNaN(port) || port < 1024 || port > 65535) {
            showToast('端口无效 (1024-65535)');
            return;
        }
        
        chrome.storage.local.set({ mcp_port: port }, () => {
            showToast(`端口已设置为 ${port}`);
            // 重新初始化MCP连接
            chrome.storage.local.get(['mcp_enabled'], (result) => {
                if (result.mcp_enabled) {
                    // 通知background重新连接
                    chrome.runtime.sendMessage({ type: 'RECONNECT_MCP' }, () => {
                        if (chrome.runtime.lastError) {
                            // 忽略错误
                        }
                    });
                }
            });
        });
    }
    
    // 端口保存按钮点击事件
    if (mcpPortSaveBtn) {
        mcpPortSaveBtn.addEventListener('click', saveMCPPort);
    }
    
    // 端口输入框回车事件
    if (mcpPortInput) {
        mcpPortInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                saveMCPPort();
            }
        });
    }
    
    // 初始化端口配置
    initMCPPort();
    // ========================================================

    // 定期更新MCP状态
    setInterval(updateMCPStatusUI, 3000);
    // ========================================================
    
    // 🆕 自动触发Vue重扫描
    function triggerVueRescan() {
        try {
            // 向页面发送重扫描消息
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                if (tabs[0]) {
                    chrome.tabs.sendMessage(tabs[0].id, {
                        type: 'TRIGGER_VUE_RESCAN',
                        source: 'antidebug-extension'
                    }, () => {
                        // 忽略错误，某些页面可能没有content script
                        if (chrome.runtime.lastError) {
                            // 静默处理错误
                        }
                    });
                }
            });
        } catch (error) {
            console.warn('触发Vue重扫描失败:', error);
        }
    }

    // popup打开时自动触发重扫描
    triggerVueRescan();

    // ========== Base模式偏好设置（全局持久化） ==========
    function getBaseModePreference() {
        try {
            return localStorage.getItem('antidebug_base_mode') || 'with-base';
        } catch (e) {
            return 'with-base';
        }
    }

    function setBaseModePreference(mode) {
        try {
            localStorage.setItem('antidebug_base_mode', mode);
        } catch (e) {
            console.warn('保存base模式偏好失败:', e);
        }
    }
    // ========================================================

    const scriptsGrid = document.querySelector('.scripts-grid');
    const hookContent = document.querySelector('.hook-content');
    const vueContent = document.querySelector('.vue-content');
    const mcpContent = document.querySelector('.mcp-content');
    const headersContent = document.querySelector('.headers-content');
    const vueScriptsList = document.querySelector('.vue-scripts-list');
    const vueRouterData = document.querySelector('.vue-router-data');
    const vueVersionBadge = document.querySelector('.vue-version-badge');
    const versionValue = document.querySelector('.vue-version-badge .version-value');
    const routesInfoBar = document.querySelector('.routes-info-bar');
    const vueTabsList = document.querySelector('.vue-tabs-list');
    const vueScriptsPanel = document.querySelector('.vue-scripts-panel');
    const vueRoutesPanel = document.querySelector('.vue-routes-panel');
    const vueEmptyHint = document.querySelector('.vue-empty-hint');
    const routesListContainer = document.querySelector('.routes-list-container');
    const noResults = document.querySelector('.no-results');
    const searchSection = document.querySelector('.search-section');
    const searchInput = document.getElementById('search-input');
    const hookNoticeContainer = document.querySelector('.hook-notice-container');
    const hookFilterEnabledBtn = document.getElementById('hook-filter-enabled');
    const hookFilterDisabledBtn = document.getElementById('hook-filter-disabled');
    const tabBtns = document.querySelectorAll('.nav-item');
    // 新的紧凑布局元素
    const vueInlineInfo = document.querySelector('.vue-inline-info');
    const routesModeInfo = document.querySelector('.routes-mode-info');
    const vueVersionInline = document.querySelector('.vue-version-inline .version-value');
    const routeToolbar = document.querySelector('.route-toolbar');
    const vueRouteSearchInput = document.getElementById('vue-route-search-input');
    const routesActionsFooter = document.querySelector('.vue-routes-panel > .routes-actions-footer');
    const copyAllPathsBtn = document.querySelector('.copy-all-paths-btn');
    const copyAllUrlsBtn = document.querySelector('.copy-all-urls-btn');
    
    // MCP全局操作模式
    const mcpGlobalToggle = document.getElementById('mcp-global-toggle');

    // 🆕 全局模式相关DOM元素
    const globalModeToggle = document.getElementById('global-mode-toggle');
    const modeText = document.querySelector('.mode-text');

    let currentTab = 'mcp'; // 当前选中的标签（V4.9.44：MCP 提到第一位并设为默认）
    let allScripts = []; // 所有脚本数据
    let enabledScripts = []; // 启用的脚本
    let hostname = '';
    let currentTab_obj = null;
    let cachedVueDataList = []; // 在popup中缓存所有Vue实例数据（改为数组）
    let currentInstanceIndex = 0; // 当前选中的实例索引
    let isFirstVueDataDisplay = true; // 🆕 标记是否是首次显示Vue路由数据

    // 🆕 全局模式状态管理
    let isGlobalMode = false; // 当前是否为全局模式
    let globalEnabledScripts = []; // 全局模式下启用的脚本

    // 🆕 Hook板块筛选状态（'enabled' | 'disabled' | null）
    let hookFilterState = null;
    
    // 🆕 Vue路由搜索相关全局变量
    let currentVueRoutes = []; // 当前显示的所有路由
    let currentVueBaseUrl = ''; // 当前的baseUrl
    let currentVueRouterMode = 'history'; // 当前路由模式
    let currentCustomBaseValue = ''; // 当前自定义base值
    
    // 🆕 全局搜索函数（供 HTML oninput 调用）
    window.handleVueRouteSearch = function(searchValue) {
        const searchTerm = (searchValue || '').toLowerCase().trim();
        
        if (currentVueRoutes.length === 0) {
            console.log('[Vue Search] 没有路由数据');
            return;
        }
        
        console.log('[Vue Search] 搜索:', searchTerm, '路由数量:', currentVueRoutes.length);
        
        if (!searchTerm) {
            // 显示所有路由
            renderVueRoutesGlobal(currentVueRoutes);
        } else {
            // 过滤路由
            const filteredRoutes = currentVueRoutes.filter(route => {
                const path = route.path.toLowerCase();
                const name = (route.name || '').toLowerCase();
                return path.includes(searchTerm) || name.includes(searchTerm);
            });
            console.log('[Vue Search] 过滤后:', filteredRoutes.length);
            renderVueRoutesGlobal(filteredRoutes);
        }
    };

    // 🆕 全局模式存储键名
    const GLOBAL_MODE_KEY = 'antidebug_mode';
    const GLOBAL_SCRIPTS_KEY = 'global_scripts';
    
    // 🆕 全局请求头存储键名
    const HEADERS_GROUPS_KEY = 'global_headers_groups';
    const HEADERS_DATA_KEY = 'global_headers_data';
    
    // 🆕 全局请求头状态
    let headersGroups = []; // [{id, name}]
    let headersData = {}; // {groupId: [{id, name, value, enabled}]}
    let currentHeadersGroupId = null;
    
    // 常用请求头列表（用于自动补全）
    const COMMON_HEADERS = [
        'Accept',
        'Accept-Charset',
        'Accept-Encoding',
        'Accept-Language',
        'Authorization',
        'Cache-Control',
        'Connection',
        'Content-Disposition',
        'Content-Encoding',
        'Content-Language',
        'Content-Length',
        'Content-Type',
        'Cookie',
        'Date',
        'DNT',
        'Host',
        'If-Match',
        'If-Modified-Since',
        'If-None-Match',
        'If-Range',
        'If-Unmodified-Since',
        'Origin',
        'Pragma',
        'Proxy-Authorization',
        'Range',
        'Referer',
        'Sec-Fetch-Dest',
        'Sec-Fetch-Mode',
        'Sec-Fetch-Site',
        'TE',
        'Transfer-Encoding',
        'Upgrade',
        'Upgrade-Insecure-Requests',
        'User-Agent',
        'Via',
        'Warning',
        'X-Api-Key',
        'X-Auth-Token',
        'X-Content-Type-Options',
        'X-Correlation-ID',
        'X-CSRF-Token',
        'X-Custom-Header',
        'X-Forwarded-For',
        'X-Forwarded-Host',
        'X-Forwarded-Port',
        'X-Forwarded-Proto',
        'X-Frame-Options',
        'X-Real-IP',
        'X-Request-ID',
        'X-Requested-With',
        'X-Token',
        'X-Trace-ID',
        'X-XSS-Protection'
    ]; // 当前选中的标签组ID

    // 🆕 初始化全局模式状态
    function initializeGlobalMode() {
        chrome.storage.local.get([GLOBAL_MODE_KEY, GLOBAL_SCRIPTS_KEY], (result) => {
            // 获取模式状态，默认为标准模式
            const mode = result[GLOBAL_MODE_KEY] || 'standard';
            isGlobalMode = (mode === 'global');
            
            // 获取全局脚本列表，默认为空数组
            globalEnabledScripts = result[GLOBAL_SCRIPTS_KEY] || [];
            
            // 如果没有模式键值，创建默认配置
            if (!result[GLOBAL_MODE_KEY]) {
                chrome.storage.local.set({
                    [GLOBAL_MODE_KEY]: 'standard',
                    [GLOBAL_SCRIPTS_KEY]: []
                });
            }
            
            // 更新UI状态
            updateModeUI();
            
            // 如果是全局模式，使用全局脚本列表
            if (isGlobalMode) {
                enabledScripts = [...globalEnabledScripts];
            }
        });
    }

    // 🆕 更新模式UI显示
    function updateModeUI() {
        globalModeToggle.checked = isGlobalMode;
        modeText.textContent = isGlobalMode ? '全局模式' : '标准模式';
    }

    // 🆕 模式切换处理（修复bug：添加旧模式脚本清理）
    function handleModeToggle(newGlobalMode) {
        const oldGlobalMode = isGlobalMode;
        isGlobalMode = newGlobalMode;
        
        // 保存模式状态
        const mode = isGlobalMode ? 'global' : 'standard';
        chrome.storage.local.set({ [GLOBAL_MODE_KEY]: mode });
        
        // 🔧 关键修复：先清理旧模式的脚本注册
        if (oldGlobalMode !== newGlobalMode) {
            clearOldModeScripts(oldGlobalMode);
        }
        
        if (isGlobalMode) {
            // 切换到全局模式
            enabledScripts = [...globalEnabledScripts];
        } else {
            // 切换到标准模式
            // 检查当前URL是否为web网站
            if (currentTab_obj && currentTab_obj.url && 
                (currentTab_obj.url.startsWith('http://') || currentTab_obj.url.startsWith('https://'))) {
                
                // 读取当前域名的脚本配置
                chrome.storage.local.get([hostname], (result) => {
                    if (result[hostname]) {
                        // 存在配置，使用该配置
                        enabledScripts = result[hostname] || [];
                    } else {
                        // 不存在配置，创建空配置
                        enabledScripts = [];
                        chrome.storage.local.set({ [hostname]: [] });
                    }
                    
                    // 更新UI显示和脚本注册
                    updateModeUI();
                    renderCurrentTab();
                    updateScriptRegistration();
                });
                return;
            } else {
                // 不是web网站，清空脚本
                enabledScripts = [];
            }
        }
        
        // 更新UI显示和脚本注册
        updateModeUI();
        renderCurrentTab();
        updateScriptRegistration();
    }

    // 🔧 新增：清理旧模式脚本的函数
    function clearOldModeScripts(wasGlobalMode) {
        chrome.runtime.sendMessage({
            type: 'clear_mode_scripts',
            clearGlobalMode: wasGlobalMode
        });
    }

    // 🆕 检查是否为有效的web网站
    function isValidWebsite(url) {
        return url && (url.startsWith('http://') || url.startsWith('https://'));
    }

    // V4.9.38（批 3 审计 R-1 🔴）：脚本注册的**真实结果**必须回到人眼前。
    // background 早在 V4.9.30（M-bg4）就改成异步回传 {success:false, error}，但 popup 这个
    // 唯一的人机入口从来没读它——注册失败时开关照样变绿，用户/AI 以为 hook 已生效。
    function reportRegistrationResult(resp) {
        try {
            if (chrome.runtime.lastError) {
                showToast('脚本注册失败：' + chrome.runtime.lastError.message);
                return;
            }
            if (resp && resp.success === false) {
                showToast('脚本注册失败：' + (resp.error || '未知错误'));
            }
        } catch (e) { /* 读 lastError 在无错误时会抛，忽略 */ }
    }

    // 🆕 更新脚本注册（通知background）
    function updateScriptRegistration() {
        chrome.runtime.sendMessage({
            type: 'update_scripts_registration',
            hostname: isGlobalMode ? '*' : hostname,
            enabledScripts: enabledScripts,
            isGlobalMode: isGlobalMode
        }, reportRegistrationResult);
    }

    // 🆕 V3.0: 把动态路由/Pinia 菜单合并进当前实例的路由列表
    // V4.9.38（批 4 审计 R-4 🔴）：动态路由 / Pinia 菜单 / Nuxt 的 baseUrl 必须是**目标页**的 origin。
    // 原实现取 window.location.origin —— 在 popup 里那是 chrome-extension://<扩展ID>，
    // 于是这三类数据的路由列表/复制/打开全是假 URL（点"打开"必然 404，动态路由功能实质不可用）。
    // 目标页 origin 从 currentTab_obj（popup 打开时 chrome.tabs.query 得到的标签）取；
    // 取不到时返回空串——宁可给出相对路径，也不伪造一个 chrome-extension:// 的 origin。
    function getPageOrigin() {
        try {
            if (currentTab_obj && currentTab_obj.url) return new URL(currentTab_obj.url).origin;
        } catch (e) { /* URL 解析失败 → 返回空串 */ }
        return '';
    }

    function mergeDynamicData(data) {
        const dyn = (data.dynamicRoutes || []).map(r => ({
            name: r.name || '(动态路由)',
            path: r.path,
            meta: { ...(r.meta || {}), dynamic: true, via: 'addRoute' }
        }));
        const menus = (data.piniaMenus || []).map(m => ({
            name: m.name || m.title || '(Pinia菜单)',
            path: m.path || m.url,
            meta: { ...(m.meta || {}), fromPinia: true, storeId: m.storeId || '' }
        }));
        const merged = [...dyn, ...menus].filter(r => r.path);
        if (merged.length === 0) return;

        if (cachedVueDataList.length === 0 || !cachedVueDataList[0].routes) {
            cachedVueDataList = [{
                vueVersion: 'Vue (动态路由)',
                routerMode: 'unknown',
                routes: merged,
                instanceIndex: 1,
                baseUrl: getPageOrigin(),
                routerBase: ''
            }];
        } else {
            // 合并进第一个实例（去重）
            const inst = cachedVueDataList[0];
            const existing = new Set((inst.routes || []).map(r => r.path));
            for (const r of merged) {
                if (!existing.has(r.path)) {
                    inst.routes.push(r);
                    existing.add(r.path);
                }
            }
        }
        currentInstanceIndex = 0;
        displayMultipleInstances();
    }

    // 🆕 V3.0: Nuxt payload 数据 → 路由列表
    function mergeNuxtData(data) {
        const nuxt = data.nuxt || {};
        const routes = (nuxt.paths || []).map(p => ({
            name: '(Nuxt页面)',
            path: p,
            meta: { fromNuxt: true }
        }));
        if (routes.length === 0) return;

        if (cachedVueDataList.length === 0 || !cachedVueDataList[0].routes) {
            cachedVueDataList = [{
                vueVersion: `${nuxt.version || 'Nuxt'} (payload提取)`,
                routerMode: 'history',
                routes: routes,
                instanceIndex: 1,
                baseUrl: getPageOrigin(),
                routerBase: ''
            }];
        } else {
            const inst = cachedVueDataList[0];
            const existing = new Set((inst.routes || []).map(r => r.path));
            for (const r of routes) {
                if (!existing.has(r.path)) {
                    inst.routes.push(r);
                    existing.add(r.path);
                }
            }
        }
        currentInstanceIndex = 0;
        displayMultipleInstances();
    }

    // 监听来自 background 的 Vue Router 数据更新
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.type === 'VUE_ROUTER_DATA_UPDATE' && message.hostname === hostname) {
            const data = message.data;

            // 处理多实例数据
            if (data.type === 'MULTIPLE_INSTANCES' && data.instances) {
                cachedVueDataList = data.instances;
                currentInstanceIndex = 0; // 默认选中第一个

                // 保存到 storage
                // V4.9.11（验收修复 A8）：**popup 不再写 storage**。
                // 这里的数据来自 background 转发的 VUE_ROUTER_DATA_UPDATE，而 background 早已在自己的
                // 串行写链（vueDataWriteChain）里写入了一份；popup 再写一遍等于在写链**之外**开第二条
                // 写入路径——它的 get→set 窗口与链内的 dynamicRoutes/Pinia/Nuxt 写入交错时，会把
                // background 刚写入的内容用旧快照覆盖掉（本组改动想修的问题的另一条残留路径）。
                // 依据：content.js 上报用的是 `VUE_ROUTER_DATA`，而 popup 只监听 `VUE_ROUTER_DATA_UPDATE`，
                // 故到达 popup 的数据**必定经过 background**，移除这里的写入不会丢数据。
                // popup 的职责收窄为：只更新 UI（下方 displayMultipleInstances）

                // 显示多实例
                displayMultipleInstances();
            }
            // V3.0: 动态路由 + Pinia 菜单数据 → 合并显示
            else if (data.type === 'DYNAMIC_ROUTES_PINIA') {
                mergeDynamicData(data);
            }
            // V3.0: Nuxt payload 数据 → 路由列表显示
            else if (data.type === 'NUXT_DATA') {
                mergeNuxtData(data);
            }
            // 兼容单实例或未找到的情况
            else {
                cachedVueDataList = [data];
                currentInstanceIndex = 0;

                // 保存到 storage（V4.9.11：合并写入，不抹掉动态/Pinia/Nuxt 数据）
                // V4.9.11（验收修复 A8）：同 MULTIPLE 分支——popup 只更新 UI，不写 storage
                // （数据必定经由 background 写入，第二条写入路径只会在链外交错覆盖）

                // 显示单实例
                displayMultipleInstances();
            }
        }
    });

    // 请求页面的Vue Router数据
    function requestVueRouterData() {
        if (currentTab_obj && currentTab_obj.id) {
            chrome.tabs.sendMessage(currentTab_obj.id, {
                type: 'REQUEST_VUE_ROUTER_DATA'
            }).catch(err => {
                console.warn('请求Vue数据失败:', err);
            });
        }
    }

    // 获取当前标签页的域名
    chrome.tabs.query({
        active: true,
        currentWindow: true
    }, (tabs) => {
        const tab = tabs[0];
        if (!tab || !tab.url) return;

        hostname = new URL(tab.url).hostname;
        currentTab_obj = tab;

        // 🆕 初始化全局模式
        initializeGlobalMode();

        // 加载脚本元数据
        fetch(chrome.runtime.getURL('scripts.json'))
            .then(response => response.json())
            .then(scripts => {
                allScripts = scripts;

                // 🆕 根据模式获取启用状态
                const getInitialScripts = () => {
                    if (isGlobalMode) {
                        return globalEnabledScripts;
                    } else {
                        // 标准模式：获取该域名下的启用状态
                        chrome.storage.local.get([hostname, 'last_active_tab'], (result) => {
                            enabledScripts = result[hostname] || [];

                            // 恢复上次打开的板块
                            if (result.last_active_tab) {
                                currentTab = result.last_active_tab;
                                // 更新UI中的按钮状态
                                tabBtns.forEach(b => {
                                    if (b.dataset.tab === currentTab) {
                                        b.classList.add('active');
                                    } else {
                                        b.classList.remove('active');
                                    }
                                });
                            }

                            renderCurrentTab();

                            // 检查是否启用了 Get_Vue_0 或 Get_Vue_1 脚本
                            const hasVueScript = enabledScripts.includes('Get_Vue_0') ||
                                enabledScripts.includes('Get_Vue_1');

                            // 如果启用了Vue脚本，立即请求数据
                            if (hasVueScript) {
                                requestVueRouterData();
                            }
                        });
                        return [];
                    }
                };

                // 延迟获取脚本，确保模式状态已初始化
                setTimeout(() => {
                    if (isGlobalMode) {
                        // 🔧 修复：全局模式下也需要恢复上次打开的板块
                        chrome.storage.local.get(['last_active_tab'], (result) => {
                            // 恢复上次打开的板块
                            if (result.last_active_tab) {
                                currentTab = result.last_active_tab;
                                // 更新UI中的按钮状态
                                tabBtns.forEach(b => {
                                    if (b.dataset.tab === currentTab) {
                                        b.classList.add('active');
                                    } else {
                                        b.classList.remove('active');
                                    }
                                });
                            }
                            
                            enabledScripts = [...globalEnabledScripts];
                            renderCurrentTab();
                            
                            // 检查Vue脚本
                            const hasVueScript = enabledScripts.includes('Get_Vue_0') ||
                                enabledScripts.includes('Get_Vue_1');
                            if (hasVueScript) {
                                requestVueRouterData();
                            }
                        });
                    } else {
                        getInitialScripts();
                    }
                }, 100);

                // 搜索功能
                searchInput.addEventListener('input', (e) => {
                    const searchTerm = e.target.value.toLowerCase();
                    
                    if (currentTab === 'antidebug') {
                    const filteredScripts = getScriptsForCurrentTab().filter(script =>
                        script.name.toLowerCase().includes(searchTerm) ||
                        script.description.toLowerCase().includes(searchTerm)
                    );
                        renderAntiDebugScripts(filteredScripts);
                    } else if (currentTab === 'hook') {
                        // Hook板块：只检索脚本名
                        let filteredScripts = getScriptsForCurrentTab().filter(script =>
                            script.name.toLowerCase().includes(searchTerm)
                        );
                        // 🆕 应用筛选（已开启/未开启）
                        filteredScripts = applyHookFilter(filteredScripts);
                        renderHookScripts(filteredScripts);
                    }
                });
                
                // 🆕 Vue路由搜索功能（全局事件监听）
                const vueSearchInput = document.getElementById('vue-route-search-input');
                if (vueSearchInput) {
                    vueSearchInput.addEventListener('input', (e) => {
                        const searchTerm = e.target.value.toLowerCase().trim();
                        if (currentVueRoutes.length === 0) return;
                        
                        if (!searchTerm) {
                            // 显示所有路由
                            renderVueRoutesGlobal(currentVueRoutes);
                        } else {
                            // 过滤路由
                            const filteredRoutes = currentVueRoutes.filter(route => {
                                const path = route.path.toLowerCase();
                                const name = (route.name || '').toLowerCase();
                                return path.includes(searchTerm) || name.includes(searchTerm);
                            });
                            renderVueRoutesGlobal(filteredRoutes);
                        }
                    });
                }
            });
    });

    // 🆕 全局模式开关事件监听
    globalModeToggle.addEventListener('change', (e) => {
        handleModeToggle(e.target.checked);
    });

    // 标签切换事件
    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            // 更新按钮状态
            tabBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            // 更新当前标签
            currentTab = btn.dataset.tab;

            // 清空搜索
            searchInput.value = '';

            // 渲染对应内容
            renderCurrentTab();

            // 保存当前板块到storage
            chrome.storage.local.set({
                'last_active_tab': currentTab
            });
        });
    });

    // 🆕 Hook板块筛选按钮点击事件
    if (hookFilterEnabledBtn && hookFilterDisabledBtn) {
        hookFilterEnabledBtn.addEventListener('click', () => {
            if (hookFilterState === 'enabled') {
                // 如果已选中，则取消筛选
                saveHookFilterState(null);
                hookFilterEnabledBtn.classList.remove('active');
            } else {
                // 选中"已开启"
                saveHookFilterState('enabled');
                hookFilterEnabledBtn.classList.add('active');
                hookFilterDisabledBtn.classList.remove('active');
            }
            // 重新渲染Hook脚本
            if (currentTab === 'hook') {
                const scriptsToShow = getScriptsForCurrentTab();
                renderHookScripts(scriptsToShow);
            }
        });

        hookFilterDisabledBtn.addEventListener('click', () => {
            if (hookFilterState === 'disabled') {
                // 如果已选中，则取消筛选
                saveHookFilterState(null);
                hookFilterDisabledBtn.classList.remove('active');
            } else {
                // 选中"未开启"
                saveHookFilterState('disabled');
                hookFilterDisabledBtn.classList.add('active');
                hookFilterEnabledBtn.classList.remove('active');
            }
            // 重新渲染Hook脚本
            if (currentTab === 'hook') {
                const scriptsToShow = getScriptsForCurrentTab();
                renderHookScripts(scriptsToShow);
            }
        });
    }

    // 根据当前标签获取要显示的脚本
    function getScriptsForCurrentTab() {
        return allScripts.filter(script => script.category === currentTab);
    }

    // 渲染当前标签的内容
    function renderCurrentTab() {
        const scriptsToShow = getScriptsForCurrentTab();

        // 隐藏所有内容区域
        scriptsGrid.style.display = 'none';
        hookContent.style.display = 'none';
        vueContent.style.display = 'none';
        if (mcpContent) mcpContent.style.display = 'none';
        if (headersContent) headersContent.style.display = 'none';

        if (currentTab === 'antidebug') {
            // 显示反调试板块
            if (searchSection) searchSection.style.display = 'block';
            if (hookNoticeContainer) hookNoticeContainer.style.display = 'none';
            scriptsGrid.style.display = 'grid';
            renderAntiDebugScripts(scriptsToShow);
        } else if (currentTab === 'hook') {
            // 显示Hook板块
            if (searchSection) searchSection.style.display = 'block';
            if (hookNoticeContainer) hookNoticeContainer.style.display = 'flex';
            hookContent.style.display = 'flex';
            // 🆕 读取筛选状态并更新按钮
            loadHookFilterState().then(() => {
                updateHookFilterButtons();
                renderHookScripts(scriptsToShow);
            });
        } else if (currentTab === 'vue') {
            // 显示Vue板块
            if (searchSection) searchSection.style.display = 'none';
            if (hookNoticeContainer) hookNoticeContainer.style.display = 'none';
            vueContent.style.display = 'flex';
            renderVueScripts(scriptsToShow);
            // 生成实例标签并显示数据
            displayMultipleInstances();
            // 确保默认显示脚本控制面板
            if (currentVueTab === 'scripts') {
                switchVueTab('scripts');
            }
        } else if (currentTab === 'headers') {
            // 显示Headers板块
            if (searchSection) searchSection.style.display = 'none';
            if (hookNoticeContainer) hookNoticeContainer.style.display = 'none';
            if (headersContent) headersContent.style.display = 'flex';
            initHeadersPanel();
        } else if (currentTab === 'mcp') {
            // 显示MCP板块
            if (searchSection) searchSection.style.display = 'none';
            if (hookNoticeContainer) hookNoticeContainer.style.display = 'none';
            if (mcpContent) mcpContent.style.display = 'flex';
        }
    }

    // 渲染反调试脚本（3列网格）
    function renderAntiDebugScripts(scripts) {
        scriptsGrid.innerHTML = '';
        noResults.style.display = 'none';

        if (scripts.length === 0) {
            noResults.style.display = 'flex';
            return;
        }

        scripts.forEach(script => {
            if (typeof script.id !== 'string' || !script.id.trim()) {
                console.error('Invalid script ID:', script);
                return;
            }

            const isEnabled = enabledScripts.includes(script.id);
            const scriptItem = document.createElement('div');
            scriptItem.className = `script-item ${isEnabled ? 'active' : ''}`;

            let description = script.description;

            scriptItem.innerHTML = `
                <div class="script-content">
                    <div class="script-header">
                        <div class="script-name">${script.name}</div>
                        <label class="switch">
                            <input type="checkbox" ${isEnabled ? 'checked' : ''} data-id="${script.id}">
                            <span class="slider"></span>
                        </label>
                    </div>
                    <div class="script-description-wrapper">
                        <div class="script-description">${description}</div>
                        <button class="expand-description-btn" style="display: none;">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <polyline points="6 9 12 15 18 9"></polyline>
                            </svg>
                        </button>
                    </div>
                </div>
            `;

            scriptsGrid.appendChild(scriptItem);

            const checkbox = scriptItem.querySelector('input[type="checkbox"]');
            checkbox.addEventListener('change', (e) => {
                handleScriptToggle(script.id, e.target.checked, scriptItem);
            });

            // 🆕 检查描述是否需要展开按钮
            const descriptionEl = scriptItem.querySelector('.script-description');
            const expandBtn = scriptItem.querySelector('.expand-description-btn');
            
            // 使用 setTimeout 确保 DOM 渲染完成后再检查
            setTimeout(() => {
                // 临时移除line-clamp限制来准确测量完整高度
                const originalDisplay = descriptionEl.style.display;
                const originalWebkitLineClamp = descriptionEl.style.webkitLineClamp;
                const originalOverflow = descriptionEl.style.overflow;
                
                // 临时设置为block以获取完整高度
                descriptionEl.style.display = 'block';
                descriptionEl.style.webkitLineClamp = 'unset';
                descriptionEl.style.overflow = 'visible';
                
                const fullHeight = descriptionEl.scrollHeight;
                
                // 恢复原始样式
                descriptionEl.style.display = originalDisplay || '';
                descriptionEl.style.webkitLineClamp = originalWebkitLineClamp || '';
                descriptionEl.style.overflow = originalOverflow || '';
                
                // 计算3行的高度（line-height * 3）
                const computedStyle = getComputedStyle(descriptionEl);
                const lineHeight = parseFloat(computedStyle.lineHeight) || 15.4; // 默认值：11px * 1.4
                const maxHeight = lineHeight * 3;
                
                // 如果完整高度超过3行高度，显示展开按钮
                if (fullHeight > maxHeight + 2) { // 加2px容差
                    expandBtn.style.display = 'flex';
                }
            }, 10);

            // 🆕 展开/收起按钮点击事件
            expandBtn.addEventListener('click', (e) => {
                e.stopPropagation(); // 阻止事件冒泡
                const isExpanded = scriptItem.classList.contains('expanded');
                
                if (isExpanded) {
                    // 收起
                    scriptItem.classList.remove('expanded');
                    expandBtn.querySelector('svg').style.transform = 'rotate(0deg)';
                } else {
                    // 展开
                    scriptItem.classList.add('expanded');
                    expandBtn.querySelector('svg').style.transform = 'rotate(180deg)';
                }
            });
        });
    }

    // 渲染Vue脚本（横向列表，支持父子关系）
    function renderVueScripts(scripts) {
        vueScriptsList.innerHTML = '';

        // 过滤出父脚本（没有 parentScript 字段的）
        const parentScripts = scripts.filter(script => !script.parentScript);

        if (parentScripts.length === 0 && scripts.length === 0) {
            vueScriptsList.innerHTML = '<div class="empty-state">暂无 Vue 脚本</div>';
            return;
        }

        parentScripts.forEach(parentScript => {
            if (typeof parentScript.id !== 'string' || !parentScript.id.trim()) {
                console.error('Invalid script ID:', parentScript);
                return;
            }

            // 渲染父脚本
            const isParentEnabled = enabledScripts.includes(parentScript.id) ||
                scripts.some(s => s.parentScript === parentScript.id && enabledScripts.includes(s.id));
            const parentItem = createVueScriptItem(parentScript, isParentEnabled, false);
            vueScriptsList.appendChild(parentItem);

            // 查找子脚本
            const childScripts = scripts.filter(s => s.parentScript === parentScript.id);

            // 如果父脚本开启（或子脚本开启），显示子脚本
            if (isParentEnabled && childScripts.length > 0) {
                childScripts.forEach(childScript => {
                    const isChildEnabled = enabledScripts.includes(childScript.id);
                    const childItem = createVueScriptItem(childScript, isChildEnabled, true);
                    vueScriptsList.appendChild(childItem);
                });
            }
        });
    }

    // 创建Vue脚本项
    function createVueScriptItem(script, isEnabled, isChild) {
        const scriptItem = document.createElement('div');
        scriptItem.className = `vue-script-item ${isEnabled ? 'active' : ''} ${isChild ? 'child-script' : ''}`;
        scriptItem.dataset.scriptId = script.id;

        scriptItem.innerHTML = `
            <div class="vue-script-name">${script.name}</div>
            <label class="vue-script-switch">
                <input type="checkbox" ${isEnabled ? 'checked' : ''} data-id="${script.id}">
                <span class="slider"></span>
            </label>
            <div class="vue-script-info">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="12" r="10"></circle>
                    <line x1="12" y1="16" x2="12" y2="12"></line>
                    <line x1="12" y1="8" x2="12.01" y2="8"></line>
                </svg>
                <div class="tooltip">${script.description}</div>
            </div>
        `;

        const checkbox = scriptItem.querySelector('input[type="checkbox"]');
        checkbox.addEventListener('change', (e) => {
            handleVueScriptToggle(script, e.target.checked);
        });

        return scriptItem;
    }

    // 🆕 读取Hook筛选状态
    function loadHookFilterState() {
        return new Promise((resolve) => {
            chrome.storage.local.get(['hook_filter_state'], (result) => {
                hookFilterState = result.hook_filter_state || null;
                resolve(hookFilterState);
            });
        });
    }

    // 🆕 保存Hook筛选状态
    function saveHookFilterState(state) {
        hookFilterState = state;
        chrome.storage.local.set({ hook_filter_state: state });
    }

    // 🆕 更新筛选按钮状态
    function updateHookFilterButtons() {
        if (hookFilterEnabledBtn && hookFilterDisabledBtn) {
            hookFilterEnabledBtn.classList.toggle('active', hookFilterState === 'enabled');
            hookFilterDisabledBtn.classList.toggle('active', hookFilterState === 'disabled');
        }
    }

    // 🆕 应用Hook筛选
    function applyHookFilter(scripts) {
        if (!hookFilterState) {
            return scripts; // 无筛选，返回所有脚本
        }
        
        return scripts.filter(script => {
            const isEnabled = enabledScripts.includes(script.id);
            if (hookFilterState === 'enabled') {
                return isEnabled;
            } else if (hookFilterState === 'disabled') {
                return !isEnabled;
            }
            return true;
        });
    }

    // 渲染Hook脚本
    function renderHookScripts(scripts) {
        // 🔧 修复：如果当前在 Hook 板块且有搜索词，应用搜索过滤
        if (currentTab === 'hook' && searchInput && searchInput.value.trim()) {
            const searchTerm = searchInput.value.toLowerCase();
            scripts = scripts.filter(script =>
                script.name.toLowerCase().includes(searchTerm)
            );
        }
        
        // 🆕 应用筛选（已开启/未开启）
        scripts = applyHookFilter(scripts);
        
        // 🔧 修复：先批量加载所有配置，配置加载完成后再清空并渲染，避免闪烁
        if (scripts.length === 0) {
            hookContent.innerHTML = '<div class="empty-state">暂无 Hook 脚本</div>';
            return;
        }
        
        // 先批量加载所有配置（不清空容器，保持旧内容显示）
        const configPromises = scripts.map(script => {
            if (typeof script.id !== 'string' || !script.id.trim()) {
                console.error('Invalid script ID:', script);
                return null;
            }
            return loadHookConfig(script.id).then(config => ({
                script,
                config
            }));
        }).filter(p => p !== null);
        
        // 等待所有配置加载完成
        Promise.all(configPromises).then(results => {
            // 配置加载完成后，再清空容器并同步渲染所有脚本项
            hookContent.innerHTML = '';
            
            results.forEach(({ script, config }) => {
                const isEnabled = enabledScripts.includes(script.id);
                const isFixedVariate = script.fixed_variate === 1;
                const hasParam = script.has_Param === 1;
                
                // 如果脚本已启用，确保配置正确初始化
                if (isEnabled && !isFixedVariate) {
                    if (hasParam) {
                        // has_Param=1：必须创建param（即使为空数组）和flag
                        if (config.param === undefined) {
                            config.param = [];
                        }
                        // 🔧 新增：初始化关键字检索开关（默认为关闭，即 false）
                        if (config.keyword_filter_enabled === undefined) {
                            config.keyword_filter_enabled = false;
                        }
                        // 🔧 修改：如果开关关闭，强制 flag=0；如果开关开启，根据关键字数量设置 flag
                        if (config.flag === undefined) {
                            if (config.keyword_filter_enabled) {
                                config.flag = config.param.length > 0 ? 1 : 0;
                            } else {
                                config.flag = 0; // 开关关闭时，flag 必须为 0
                                // 🔧 修复：不清空关键字，保留存储的关键字
                            }
                        } else if (!config.keyword_filter_enabled) {
                            // 🔧 修复：如果开关关闭，只设置 flag=0，不清空存储的关键字
                            config.flag = 0;
                        }
                        if (Object.keys(config).length > 0) {
                            saveHookConfig(script.id, config);
                        }
                    } else {
                        // has_Param=0：必须创建flag=0
                        if (config.flag === undefined) {
                            config.flag = 0;
                            saveHookConfig(script.id, config);
                        }
                    }
                }
                
                const scriptItem = createHookScriptItem(script, isEnabled, isFixedVariate, hasParam, config);
                hookContent.appendChild(scriptItem);
            });
        });
    }
    
    // 创建Hook脚本项
    function createHookScriptItem(script, isEnabled, isFixedVariate, hasParam, config) {
        const scriptItem = document.createElement('div');
        scriptItem.className = `hook-script-item ${isEnabled ? 'enabled' : 'disabled'}`;
        scriptItem.dataset.scriptId = script.id;
        
        // 获取动态开关（debugger, stack等）
        const dynamicSwitches = [];
        Object.keys(script).forEach(key => {
            if (!['id', 'name', 'description', 'category', 'fixed_variate', 'has_Param', 'parentScript'].includes(key)) {
                if (script[key] === 1) {
                    dynamicSwitches.push(key);
                }
            }
        });
        
        // 构建输入区域
        let inputArea = '';
        if (isFixedVariate) {
            // 固定变量脚本：显示固定值输入
            // 优先使用配置中的值，如果没有则使用scripts.json中的默认值
            const value = config?.value || script.value || '';
            inputArea = `
                <div class="hook-input-group">
                    <label class="hook-input-label">固定值：</label>
                    <div class="hook-input-wrapper hook-value-input-wrapper">
                        <input type="text" class="hook-value-input" 
                               value="${value}" 
                               placeholder="输入固定值后按Enter保存" 
                               ${!isEnabled ? 'disabled' : ''}>
                        <div class="hook-value-tooltip">输入固定值后按Enter保存</div>
                    </div>
                </div>
            `;
        } else {
            // 非固定变量脚本
            if (hasParam) {
                // 支持关键字过滤
                // 🔧 新增：检查关键字检索开关状态（默认为关闭，即 false）
                const keywordFilterEnabled = config?.keyword_filter_enabled !== undefined ? config.keyword_filter_enabled : false;
                
                // 🔧 修改：如果开关关闭，只隐藏关键字显示（UI层面），不清空存储的关键字
                let keywords = config?.param || [];
                if (!keywordFilterEnabled) {
                    keywords = []; // 只用于UI显示，不修改 config.param
                    if (config && config.flag !== 0) {
                        config.flag = 0; // 确保 flag=0
                    }
                }
                
                const keywordList = keywords.map((kw, idx) => `
                    <div class="keyword-item">
                        <span>${kw}</span>
                        <button class="keyword-remove-btn" data-index="${idx}" ${!isEnabled || !keywordFilterEnabled ? 'disabled' : ''}>×</button>
                    </div>
                `).join('');
                
                inputArea = `
                    <div class="hook-input-group">
                        <div class="hook-input-label-row">
                            <label class="hook-input-label">关键字：</label>
                            <div class="hook-keyword-filter-switch">
                                <label class="hook-keyword-filter-switch-label">
                                    <input type="checkbox" class="hook-keyword-filter-checkbox" ${keywordFilterEnabled ? 'checked' : ''} ${!isEnabled ? 'disabled' : ''} data-script-id="${script.id}">
                                    <span class="hook-keyword-filter-slider"></span>
                                </label>
                                <span class="hook-keyword-filter-label-text">检索关键字</span>
                            </div>
                        </div>
                        <div class="hook-keywords-container ${!keywordFilterEnabled ? 'keyword-filter-disabled' : ''}">
                            ${keywordList}
                            <div class="hook-input-wrapper">
                                <input type="text" class="hook-keyword-input" 
                                       placeholder="输入关键字后按Enter添加" 
                                       ${!isEnabled || !keywordFilterEnabled ? 'disabled' : ''}>
                            </div>
                        </div>
                    </div>
                `;
            } else {
                // 不支持关键字过滤，不显示输入框
                inputArea = '';
            }
        }
        
        // 构建动态开关
        const switchesHtml = dynamicSwitches.map(switchKey => {
            const switchValue = config?.[switchKey] || 0;
            return `
                <button class="hook-switch-btn ${switchValue === 1 ? 'active' : ''}" 
                        data-switch="${switchKey}" 
                        ${!isEnabled ? 'disabled' : ''}>
                    ${switchKey}
                </button>
            `;
        }).join('');
        
        scriptItem.innerHTML = `
            <div class="hook-script-header">
                <div class="hook-script-name">${script.name}</div>
                <div class="vue-script-info">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <circle cx="12" cy="12" r="10"></circle>
                        <line x1="12" y1="16" x2="12" y2="12"></line>
                        <line x1="12" y1="8" x2="12.01" y2="8"></line>
                    </svg>
                    <div class="tooltip">${script.description || '暂无描述'}</div>
                </div>
                <label class="hook-main-switch">
                    <input type="checkbox" ${isEnabled ? 'checked' : ''} data-id="${script.id}">
                    <span class="hook-slider"></span>
                </label>
            </div>
            ${inputArea}
            <div class="hook-script-actions">
                <span class="hook-action-label">开启</span>
                ${switchesHtml}
            </div>
        `;
        
        // 绑定事件
        const checkbox = scriptItem.querySelector('input[type="checkbox"]');
        checkbox.addEventListener('change', (e) => {
            handleHookScriptToggle(script, e.target.checked, scriptItem);
        });
        
        // 固定值输入框事件（使用Enter键保存）
        if (isFixedVariate) {
            const valueInput = scriptItem.querySelector('.hook-value-input');
            const tooltip = scriptItem.querySelector('.hook-value-tooltip');
            const inputWrapper = scriptItem.querySelector('.hook-value-input-wrapper');
            
            // 获得焦点时显示提示框
            valueInput.addEventListener('focus', () => {
                inputWrapper.classList.add('show-tooltip');
            });
            
            // 失去焦点时隐藏提示框
            valueInput.addEventListener('blur', () => {
                inputWrapper.classList.remove('show-tooltip');
            });
            
            valueInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter' && isEnabled) {
                    const value = e.target.value.trim();
                    if (value) {
                        // 保存固定值
                        saveHookConfigValue(script.id, value);
                        showToast('已保存');
                    } else {
                        // 如果输入为空，清空固定值
                        saveHookConfigValue(script.id, '');
                        showToast('已清空');
                    }
                }
            });
        }
        
        // 关键字输入框事件（非固定变量且支持关键字）
        if (!isFixedVariate && hasParam) {
            const keywordInput = scriptItem.querySelector('.hook-keyword-input');
            const keywordsContainer = scriptItem.querySelector('.hook-keywords-container');
            const keywordFilterCheckbox = scriptItem.querySelector('.hook-keyword-filter-checkbox');
            
            // 🔧 新增：关键字检索开关切换事件
            if (keywordFilterCheckbox) {
                keywordFilterCheckbox.addEventListener('change', (e) => {
                    handleKeywordFilterToggle(script.id, e.target.checked, scriptItem, isEnabled);
                });
            }
            
            keywordInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter' && e.target.value.trim()) {
                    // 🔧 修改：检查开关状态
                    loadHookConfig(script.id).then(config => {
                        if (config?.keyword_filter_enabled) {
                            addKeyword(script.id, e.target.value.trim(), keywordsContainer, isEnabled);
                            e.target.value = '';
                        }
                    });
                }
            });
            
            // 绑定删除关键字按钮
            scriptItem.querySelectorAll('.keyword-remove-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    // 🔧 修改：检查开关状态
                    loadHookConfig(script.id).then(config => {
                        if (config?.keyword_filter_enabled) {
                            const index = parseInt(e.target.dataset.index);
                            removeKeyword(script.id, index, keywordsContainer, isEnabled);
                        }
                    });
                });
            });
        }
        
        // 动态开关事件
        scriptItem.querySelectorAll('.hook-switch-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                if (isEnabled) {
                    const switchKey = e.target.dataset.switch;
                    // 🔧 修复：根据按钮的当前状态（active类）来判断当前值，而不是依赖闭包中的config
                    const isActive = e.target.classList.contains('active');
                    const newValue = isActive ? 0 : 1;
                    toggleHookSwitch(script.id, switchKey, newValue, e.target);
                }
            });
        });
        
        return scriptItem;
    }
    
    // 加载Hook脚本配置
    function loadHookConfig(scriptId) {
        return new Promise((resolve) => {
            const configKey = `${scriptId}_config`;
            chrome.storage.local.get([configKey], (result) => {
                resolve(result[configKey] || {});
            });
        });
    }
    
    // 保存Hook脚本配置
    function saveHookConfig(scriptId, config) {
        const configKey = `${scriptId}_config`;
        chrome.storage.local.set({
            [configKey]: config
        }, () => {
            // 🔧 修改：用户修改配置时只保存到chrome.storage.local，不发送消息
            // 等下次刷新页面后，content.js会在页面加载时自动同步并发送消息
        });
    }
    
    // 保存固定值
    function saveHookConfigValue(scriptId, value) {
        loadHookConfig(scriptId).then(config => {
            config.value = value;
            saveHookConfig(scriptId, config);
        });
    }
    
    // 🔧 新增：处理关键字检索开关切换
    function handleKeywordFilterToggle(scriptId, enabled, scriptItem, isEnabled) {
        loadHookConfig(scriptId).then(config => {
            config.keyword_filter_enabled = enabled;
            
            if (!enabled) {
                // 🔧 修改：关闭开关时，只设置 flag=0，不清空存储的关键字
                config.flag = 0;
            } else {
                // 开启开关：根据关键字数量设置 flag
                if (!config.param) {
                    config.param = [];
                }
                config.flag = config.param.length > 0 ? 1 : 0;
            }
            
            saveHookConfig(scriptId, config);
            
            // 更新UI状态
            const keywordsContainer = scriptItem.querySelector('.hook-keywords-container');
            const keywordInput = scriptItem.querySelector('.hook-keyword-input');
            const keywordRemoveBtns = scriptItem.querySelectorAll('.keyword-remove-btn');
            
            if (enabled) {
                // 开启：启用输入框和删除按钮，重新显示关键字
                keywordsContainer.classList.remove('keyword-filter-disabled');
                if (keywordInput) keywordInput.disabled = !isEnabled;
                keywordRemoveBtns.forEach(btn => {
                    btn.disabled = !isEnabled;
                });
                
                // 🔧 修改：重新渲染关键字列表（从存储中恢复）
                const existingKeywords = config.param || [];
                const inputWrapper = keywordsContainer.querySelector('.hook-input-wrapper');
                // 清空现有显示的关键字
                keywordsContainer.querySelectorAll('.keyword-item').forEach(item => item.remove());
                // 重新添加关键字
                existingKeywords.forEach((kw, idx) => {
                    const keywordItem = document.createElement('div');
                    keywordItem.className = 'keyword-item';
                    keywordItem.innerHTML = `
                        <span>${kw}</span>
                        <button class="keyword-remove-btn" data-index="${idx}" ${!isEnabled ? 'disabled' : ''}>×</button>
                    `;
                    inputWrapper.parentNode.insertBefore(keywordItem, inputWrapper);
                });
                
                // 重新绑定删除按钮事件
                keywordsContainer.querySelectorAll('.keyword-remove-btn').forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        if (isEnabled && config.keyword_filter_enabled) {
                            const index = parseInt(e.target.dataset.index);
                            removeKeyword(scriptId, index, keywordsContainer, isEnabled);
                        }
                    });
                });
            } else {
                // 🔧 修改：关闭：禁用输入框和删除按钮，隐藏关键字列表（不清空存储）
                keywordsContainer.classList.add('keyword-filter-disabled');
                if (keywordInput) keywordInput.disabled = true;
                keywordRemoveBtns.forEach(btn => {
                    btn.disabled = true;
                });
                
                // 🔧 修改：只隐藏关键字列表UI，不清空存储
                const keywordItems = keywordsContainer.querySelectorAll('.keyword-item');
                keywordItems.forEach(item => item.remove());
            }
        });
    }
    
    // 添加关键字
    function addKeyword(scriptId, keyword, container, isEnabled) {
        loadHookConfig(scriptId).then(config => {
            // 🔧 修改：检查开关状态
            if (!config.keyword_filter_enabled) {
                return; // 开关关闭时不允许添加关键字
            }
            
            if (!config.param) {
                config.param = [];
            }
            if (config.param.indexOf(keyword) === -1) {
                config.param.push(keyword);
                // 🔧 修改：根据关键字数量设置 flag
                config.flag = config.param.length > 0 ? 1 : 0;
                saveHookConfig(scriptId, config);
                
                // 更新UI
                const keywordItem = document.createElement('div');
                keywordItem.className = 'keyword-item';
                keywordItem.innerHTML = `
                    <span>${keyword}</span>
                    <button class="keyword-remove-btn" data-index="${config.param.length - 1}" ${!isEnabled ? 'disabled' : ''}>×</button>
                `;
                const inputWrapper = container.querySelector('.hook-input-wrapper');
                container.insertBefore(keywordItem, inputWrapper);
                
                // 绑定删除事件
                keywordItem.querySelector('.keyword-remove-btn').addEventListener('click', (e) => {
                    loadHookConfig(scriptId).then(cfg => {
                        if (cfg?.keyword_filter_enabled) {
                            const index = parseInt(e.target.dataset.index);
                            removeKeyword(scriptId, index, container, isEnabled);
                        }
                    });
                });
            }
        });
    }
    
    // 删除关键字
    function removeKeyword(scriptId, index, container, isEnabled) {
        loadHookConfig(scriptId).then(config => {
            // 🔧 修改：检查开关状态
            if (!config.keyword_filter_enabled) {
                return; // 开关关闭时不允许删除关键字
            }
            
            if (config.param && config.param.length > index) {
                config.param.splice(index, 1);
                // 🔧 修改：根据关键字数量设置 flag
                if (config.param.length === 0) {
                    config.flag = 0; // 没有关键字时设置flag为0
                    config.param = []; // 保持为空数组
                } else {
                    config.flag = 1; // 还有关键字时保持 flag=1
                }
                saveHookConfig(scriptId, config);
                
                // 重新渲染关键字列表
                const keywordItems = container.querySelectorAll('.keyword-item');
                keywordItems[index].remove();
                
                // 更新所有删除按钮的索引
                container.querySelectorAll('.keyword-remove-btn').forEach((btn, idx) => {
                    btn.dataset.index = idx;
                });
            }
        });
    }
    
    // 切换Hook动态开关
    function toggleHookSwitch(scriptId, switchKey, value, buttonElement) {
        loadHookConfig(scriptId).then(config => {
            config[switchKey] = value;
            saveHookConfig(scriptId, config);
            
            // 更新UI
            if (value === 1) {
                buttonElement.classList.add('active');
            } else {
                buttonElement.classList.remove('active');
            }
        });
    }
    
    // 处理Hook脚本开关切换
    function handleHookScriptToggle(script, isChecked, scriptItem) {
        if (isChecked) {
            if (!enabledScripts.includes(script.id)) {
                enabledScripts.push(script.id);
            }
            scriptItem.classList.add('enabled');
            scriptItem.classList.remove('disabled');
            
            // 初始化配置（如果不存在）
            loadHookConfig(script.id).then(config => {
                const isFixedVariate = script.fixed_variate === 1;
                const hasParam = script.has_Param === 1;
                
                // 固定变量脚本：如果配置中没有值，使用scripts.json中的默认值
                if (isFixedVariate) {
                    // 检查scripts.json中是否有默认值
                    if (script.value !== undefined && script.value !== null) {
                        // 如果配置中没有保存的值，使用默认值
                        if (config.value === undefined || config.value === '') {
                            config.value = script.value;
                            saveHookConfig(script.id, config);
                            
                            // 更新输入框显示
                            const valueInput = scriptItem.querySelector('.hook-value-input');
                            if (valueInput) {
                                valueInput.value = script.value;
                            }
                        }
                    }
                } else {
                    // 非固定变量脚本：确保flag和param存在
                    if (hasParam) {
                        // has_Param=1：必须创建param（即使为空数组）和flag
                        if (config.param === undefined) {
                            config.param = [];
                        }
                        // 🔧 新增：初始化关键字检索开关（默认为关闭，即 false）
                        if (config.keyword_filter_enabled === undefined) {
                            config.keyword_filter_enabled = false;
                        }
                        // 🔧 修改：如果开关关闭，强制 flag=0；如果开关开启，根据关键字数量设置 flag
                        if (config.flag === undefined) {
                            if (config.keyword_filter_enabled) {
                                config.flag = config.param.length > 0 ? 1 : 0;
                            } else {
                                config.flag = 0; // 开关关闭时，flag 必须为 0
                                // 🔧 修复：不清空关键字，保留存储的关键字
                            }
                        } else if (!config.keyword_filter_enabled) {
                            // 🔧 修复：如果开关关闭，只设置 flag=0，不清空存储的关键字
                            config.flag = 0;
                        }
                    } else {
                        // has_Param=0：必须创建flag=0，不创建param
                        if (config.flag === undefined) {
                            config.flag = 0;
                        }
                    }
                    saveHookConfig(script.id, config);
                }
                
                // 🔧 修改：根据关键字检索开关状态启用/禁用控件
                if (hasParam && !isFixedVariate) {
                    const keywordFilterEnabled = config?.keyword_filter_enabled !== undefined ? config.keyword_filter_enabled : false;
                    const keywordInput = scriptItem.querySelector('.hook-keyword-input');
                    const keywordRemoveBtns = scriptItem.querySelectorAll('.keyword-remove-btn');
                    const keywordsContainer = scriptItem.querySelector('.hook-keywords-container');
                    
                    if (keywordFilterEnabled) {
                        // 开启：启用关键字输入框和删除按钮
                        if (keywordInput) keywordInput.disabled = false;
                        keywordRemoveBtns.forEach(btn => {
                            btn.disabled = false;
                        });
                        if (keywordsContainer) keywordsContainer.classList.remove('keyword-filter-disabled');
                    } else {
                        // 关闭：禁用关键字输入框和删除按钮
                        if (keywordInput) keywordInput.disabled = true;
                        keywordRemoveBtns.forEach(btn => {
                            btn.disabled = true;
                        });
                        if (keywordsContainer) keywordsContainer.classList.add('keyword-filter-disabled');
                    }
                } else {
                    // 其他控件正常启用
                    scriptItem.querySelectorAll('input:not(.hook-keyword-input), button:not(.keyword-remove-btn)').forEach(el => {
                        el.disabled = false;
                    });
                }
                
                // 🔧 修改：用户修改配置时只保存到chrome.storage.local，不发送消息
                // 等下次刷新页面后，content.js会在页面加载时自动同步并发送消息
            });
        } else {
            enabledScripts = enabledScripts.filter(id => id !== script.id);
            scriptItem.classList.remove('enabled');
            scriptItem.classList.add('disabled');
            
            // 禁用所有控件（除了主开关）
            scriptItem.querySelectorAll('input:not([type="checkbox"]), button:not(.hook-main-switch input)').forEach(el => {
                el.disabled = true;
            });
        }
        
        updateStorage(enabledScripts);
        
        // 🆕 如果当前有筛选状态，重新渲染Hook脚本列表以应用筛选
        if (currentTab === 'hook' && hookFilterState) {
            const scriptsToShow = getScriptsForCurrentTab();
            renderHookScripts(scriptsToShow);
        }
    }
    
    // 同步Hook配置到页面localStorage
    function syncHookConfigToPage(scriptId, config) {
        if (!currentTab_obj || !currentTab_obj.id) return;
        
        // 获取脚本信息以判断类型
        const script = allScripts.find(s => s.id === scriptId);
        if (!script) return;
        
        const scriptName = scriptId; // 脚本文件名
        const baseKey = `Antidebug_breaker_${scriptName}`;
        
        // 构建要同步的localStorage数据
        const localStorageData = {};
        
        const isFixedVariate = script.fixed_variate === 1;
        const hasParam = script.has_Param === 1;
        
        // 固定变量脚本
        if (isFixedVariate) {
            if (config.value !== undefined) {
                localStorageData[`${baseKey}_value`] = config.value;
            }
        } else {
            // 非固定变量脚本
            // has_Param=0：必须创建flag=0
            // has_Param=1：必须创建flag和param（即使为空数组）
            if (hasParam) {
                // 必须创建param（即使为空数组）
                localStorageData[`${baseKey}_param`] = JSON.stringify(config.param || []);
                // 必须创建flag
                localStorageData[`${baseKey}_flag`] = (config.flag !== undefined ? config.flag : (config.param && config.param.length > 0 ? 1 : 0)).toString();
            } else {
                // has_Param=0：必须创建flag=0
                localStorageData[`${baseKey}_flag`] = '0';
            }
        }
        
        // 动态开关（debugger, stack等）
        Object.keys(config).forEach(key => {
            // 🔧 修改：排除 keyword_filter_enabled，它只是插件UI的控制开关，不需要同步到页面
            if (!['value', 'flag', 'param', 'keyword_filter_enabled'].includes(key)) {
                localStorageData[`${baseKey}_${key}`] = (config[key] || 0).toString();
            }
        });
        
        // 发送消息到content script同步
        chrome.tabs.sendMessage(currentTab_obj.id, {
            type: 'SYNC_HOOK_CONFIG',
            scriptId: scriptId,
            config: localStorageData
        }).catch(err => {
            console.warn('同步Hook配置失败:', err);
        });
    }

    // 当前选中的Vue标签页
    let currentVueTab = 'scripts';

    // 显示多个Vue实例（新增函数）
    function displayMultipleInstances() {
        if (!vueTabsList) return;
        
        // 🔧 保存当前用户选择的标签，避免切换脚本时跳转
        const previousTab = currentVueTab;
        
        // 清空除了"脚本控制"以外的标签
        const existingTabs = vueTabsList.querySelectorAll('.vue-tab-item:not([data-vue-tab="scripts"])');
        existingTabs.forEach(tab => tab.remove());
        
        // 没有数据
        if (!cachedVueDataList || cachedVueDataList.length === 0) {
            if (vueEmptyHint) vueEmptyHint.style.display = 'flex';
            if (vueRoutesPanel) vueRoutesPanel.style.display = 'none';
            displayVueRouterData(null);
            return;
        }
        
        // 检查是否有有效的路由数据
        const validInstances = cachedVueDataList.filter(d => d && !d.notFound && d.routes && d.routes.length > 0);
        
        if (validInstances.length === 0) {
            // 没有有效路由数据，但可能有版本信息
            if (vueEmptyHint) vueEmptyHint.style.display = 'flex';
            if (vueRoutesPanel) vueRoutesPanel.style.display = 'none';
            displayVueRouterData(cachedVueDataList[0]); // 尝试显示第一个实例（可能有版本信息）
            return;
        }
        
        if (vueEmptyHint) vueEmptyHint.style.display = 'none';
        
        // 🆕 只有一个有效实例时，直接显示路由列表，不需要点击标签
        if (validInstances.length === 1) {
            // 创建路由列表标签
            const firstValidIndex = cachedVueDataList.findIndex(d => d && !d.notFound && d.routes && d.routes.length > 0);
            const instance = cachedVueDataList[firstValidIndex];
            const routeCount = instance.routes.length;
            
            // 🔧 根据用户当前选择决定标签的激活状态
            const shouldActivateRoutes = previousTab !== 'scripts';
            
            const tabBtn = document.createElement('button');
            tabBtn.className = `vue-tab-item ${shouldActivateRoutes ? 'active' : ''}`;
            tabBtn.dataset.vueTab = `instance-${firstValidIndex}`;
            tabBtn.dataset.instanceIndex = firstValidIndex;
            tabBtn.innerHTML = `
                <span>路由列表</span>
                <span class="tab-badge">${routeCount}</span>
            `;
            tabBtn.onclick = () => switchVueTab(`instance-${firstValidIndex}`, firstValidIndex);
            vueTabsList.appendChild(tabBtn);
            
            // 🔧 更新脚本控制标签的激活状态
            const scriptsTab = vueTabsList.querySelector('[data-vue-tab="scripts"]');
            if (scriptsTab) {
                scriptsTab.classList.toggle('active', previousTab === 'scripts');
            }
            
            // 🔧 根据用户当前选择决定显示哪个面板
            if (previousTab === 'scripts') {
                // 保持在脚本控制面板
                if (vueScriptsPanel) {
                    vueScriptsPanel.classList.add('active');
                    vueScriptsPanel.style.display = 'flex';
                }
                if (vueRoutesPanel) {
                    vueRoutesPanel.classList.remove('active');
                    vueRoutesPanel.style.display = 'none';
                }
                currentVueTab = 'scripts';
            } else {
                // 显示路由面板
                if (vueScriptsPanel) {
                    vueScriptsPanel.classList.remove('active');
                    vueScriptsPanel.style.display = 'none';
                }
                if (vueRoutesPanel) {
                    vueRoutesPanel.classList.add('active');
                    vueRoutesPanel.style.display = 'flex';
                }
                currentVueTab = `instance-${firstValidIndex}`;
                currentInstanceIndex = firstValidIndex;
                displayVueRouterData(instance);
            }
            return;
        }
        
        // 多实例场景：为每个有效实例生成标签
        cachedVueDataList.forEach((instance, index) => {
            if (!instance || instance.notFound || !instance.routes || instance.routes.length === 0) {
                return;
            }
            
            const routeCount = instance.routes.length;
            const tabBtn = document.createElement('button');
            tabBtn.className = 'vue-tab-item';
            tabBtn.dataset.vueTab = `instance-${index}`;
            tabBtn.dataset.instanceIndex = index;
            
            tabBtn.innerHTML = `
                <span>实例 ${index + 1}</span>
                <span class="tab-badge">${routeCount}</span>
            `;
            
            tabBtn.onclick = () => switchVueTab(`instance-${index}`, index);
            vueTabsList.appendChild(tabBtn);
        });
        
        // 🔧 根据用户当前选择决定是否自动切换到路由面板
        const firstValidIndex = cachedVueDataList.findIndex(d => d && !d.notFound && d.routes && d.routes.length > 0);
        if (firstValidIndex >= 0) {
            if (previousTab === 'scripts') {
                // 🔧 用户在脚本控制面板，保持不动
                const scriptsTab = vueTabsList.querySelector('[data-vue-tab="scripts"]');
                if (scriptsTab) scriptsTab.classList.add('active');
                
                if (vueScriptsPanel) {
                    vueScriptsPanel.classList.add('active');
                    vueScriptsPanel.style.display = 'flex';
                }
                if (vueRoutesPanel) {
                    vueRoutesPanel.classList.remove('active');
                    vueRoutesPanel.style.display = 'none';
                }
                currentVueTab = 'scripts';
            } else {
                // 激活第一个标签
                const firstTab = vueTabsList.querySelector(`[data-vue-tab="instance-${firstValidIndex}"]`);
                if (firstTab) firstTab.classList.add('active');
                
                // 显示路由面板
                if (vueScriptsPanel) {
                    vueScriptsPanel.classList.remove('active');
                    vueScriptsPanel.style.display = 'none';
                }
                if (vueRoutesPanel) {
                    vueRoutesPanel.classList.add('active');
                    vueRoutesPanel.style.display = 'flex';
                }
                
                currentVueTab = `instance-${firstValidIndex}`;
                currentInstanceIndex = firstValidIndex;
                displayVueRouterData(cachedVueDataList[firstValidIndex]);
            }
        }
    }
    
    // 切换Vue标签页
    function switchVueTab(tabId, instanceIndex = null) {
        currentVueTab = tabId;
        
        // 更新标签激活状态
        if (vueTabsList) {
            vueTabsList.querySelectorAll('.vue-tab-item').forEach(tab => {
                tab.classList.toggle('active', tab.dataset.vueTab === tabId);
            });
        }
        
        // 切换面板
        if (tabId === 'scripts') {
            if (vueScriptsPanel) {
                vueScriptsPanel.classList.add('active');
                vueScriptsPanel.style.display = 'flex';
            }
            if (vueRoutesPanel) {
                vueRoutesPanel.classList.remove('active');
                vueRoutesPanel.style.display = 'none';
            }
            if (vueEmptyHint) vueEmptyHint.style.display = 'none';
        } else if (tabId.startsWith('instance-') && instanceIndex !== null) {
            if (vueScriptsPanel) {
                vueScriptsPanel.classList.remove('active');
                vueScriptsPanel.style.display = 'none';
            }
            if (vueRoutesPanel) {
                vueRoutesPanel.classList.add('active');
                vueRoutesPanel.style.display = 'flex';
            }
            if (vueEmptyHint) vueEmptyHint.style.display = 'none';
            
            currentInstanceIndex = instanceIndex;
            if (cachedVueDataList[instanceIndex]) {
                displayVueRouterData(cachedVueDataList[instanceIndex]);
            }
        }
    }
    
    // 初始化Vue标签页点击事件
    function initVueTabsEvents() {
        if (!vueTabsList) return;
        
        const scriptsTab = vueTabsList.querySelector('[data-vue-tab="scripts"]');
        if (scriptsTab) {
            scriptsTab.onclick = () => switchVueTab('scripts');
        }
    }
    
    // 初始化
    initVueTabsEvents();
    
    // 🆕 全局路由渲染函数（供搜索使用）
    function renderVueRoutesGlobal(routesToShow) {
        if (!routesListContainer) return;
        routesListContainer.innerHTML = '';
        
        // 路径规范化函数
        const normalizePath = (path) => {
            if (!path || path.trim() === '') return '/';
            if (!path.startsWith('/')) return '/' + path;
            return path;
        };
        
        // URL清理函数
        const cleanUrl = (url) => {
            return url.replace(/([^:]\/)\/+/g, '$1').replace(/\/$/, '');
        };
        
        routesToShow.forEach(route => {
            const normalizedPath = normalizePath(route.path);
            let fullUrl;
            
            // 使用全局变量构建URL
            if (currentCustomBaseValue && currentCustomBaseValue.trim() !== '') {
                const cleanBase = currentCustomBaseValue.endsWith('/') ? currentCustomBaseValue.slice(0, -1) : currentCustomBaseValue;
                if (currentVueRouterMode === 'hash') {
                    const baseUrlWithoutHash = currentVueBaseUrl.endsWith('#') ? currentVueBaseUrl.slice(0, -1) : currentVueBaseUrl;
                    fullUrl = cleanUrl(baseUrlWithoutHash + cleanBase + '/#' + normalizedPath);
                } else {
                    fullUrl = cleanUrl(currentVueBaseUrl + cleanBase + normalizedPath);
                }
            } else {
                if (currentVueRouterMode === 'hash') {
                    const cleanPath = normalizedPath.startsWith('/') ? normalizedPath.substring(1) : normalizedPath;
                    if (currentVueBaseUrl.endsWith('#')) {
                        fullUrl = currentVueBaseUrl + '/' + cleanPath;
                    } else if (currentVueBaseUrl.endsWith('#/')) {
                        fullUrl = currentVueBaseUrl + cleanPath;
                    } else {
                        fullUrl = currentVueBaseUrl + '#/' + cleanPath;
                    }
                    fullUrl = cleanUrl(fullUrl);
                } else {
                    fullUrl = currentVueBaseUrl + normalizedPath;
                }
            }
            
            const routeItem = document.createElement('div');
            routeItem.className = 'route-item';
            routeItem.innerHTML = `
                <div class="route-url" title="${fullUrl}">${fullUrl}</div>
                <div class="route-actions">
                    <button class="route-btn copy-btn" data-url="${fullUrl}">复制</button>
                    <button class="route-btn open-btn" data-url="${fullUrl}">打开</button>
                </div>
            `;
            
            // 绑定事件
            const copyBtn = routeItem.querySelector('.copy-btn');
            const openBtn = routeItem.querySelector('.open-btn');
            
            copyBtn.onclick = () => {
                navigator.clipboard.writeText(fullUrl).then(() => {
                    copyBtn.textContent = '已复制';
                    copyBtn.style.background = 'var(--success)';
                    setTimeout(() => {
                        copyBtn.textContent = '复制';
                        copyBtn.style.background = '';
                    }, 1500);
                });
            };
            
            openBtn.onclick = () => {
                chrome.tabs.create({ url: fullUrl });
            };
            
            routesListContainer.appendChild(routeItem);
        });
        
        // 显示空状态
        if (routesToShow.length === 0) {
            routesListContainer.innerHTML = '<div class="empty-state">没有匹配的路由</div>';
        }
    }

                // 显示 Vue Router 数据
            // 显示 Vue Router 数据
    function displayVueRouterData(vueRouterInfo) {
        // 路径规范化函数：确保路径以 / 开头
        const normalizePath = (path) => {
            // 如果路径为空或只有空格，返回根路径
            if (!path || path.trim() === '') {
                return '/';
            }
            // 如果路径不以 / 开头，加上 /
            if (!path.startsWith('/')) {
                return '/' + path;
            }
            return path;
        };

        // URL清理函数：清理多余斜杠和尾部斜杠
        const cleanUrl = (url) => {
            return url.replace(/([^:]\/)\/+/g, '$1').replace(/\/$/, '');
        };

        // 默认隐藏工具栏和内联信息
        if (routeToolbar) {
            routeToolbar.style.display = 'none';
        }
        if (vueInlineInfo) {
            vueInlineInfo.style.display = 'none';
        }

        if (!vueRouterInfo) {
            routesListContainer.innerHTML = '<div class="empty-state">等待检测 Vue Router（如需检测请打开<strong>获取路由</strong>并刷新网站）</div>';
            return;
        }

        // 未找到Router
        if (vueRouterInfo.notFound) {
            routesListContainer.innerHTML = '<div class="empty-state">❌ 未检测到 Vue Router（可尝试重新打开插件）</div>';
            return;
        }

        // ✅ 新增：序列化错误处理
        if (vueRouterInfo.serializationError) {
            routesListContainer.innerHTML = '<div class="empty-state">❌ 路由数据传输失败，请查看控制台（F12）输出的路由信息！</div>';
            return;
        }

        // 显示Vue版本和路由信息（内联到标签栏）
        if (vueRouterInfo.vueVersion) {
            // 更新新的内联版本显示
            if (vueVersionInline) vueVersionInline.textContent = vueRouterInfo.vueVersion;
            // 兼容旧版本显示
            if (versionValue) versionValue.textContent = vueRouterInfo.vueVersion;

            // 显示内联信息
            if (vueInlineInfo) {
                vueInlineInfo.style.display = 'flex';
                if (routesModeInfo) {
            if (!vueRouterInfo.routes || vueRouterInfo.routes.length === 0) {
                        routesModeInfo.textContent = '路由表为空';
            } else {
                const routerMode = vueRouterInfo.routerMode || 'history';
                        routesModeInfo.textContent = `${routerMode}模式`;
                    }
                }
            }
        }

        // 显示路由列表
        if (!vueRouterInfo.routes || vueRouterInfo.routes.length === 0) {
            routesListContainer.innerHTML = '<div class="empty-state">⚠️ 路由表为空</div>';
            return;
        }

        // 显示工具栏（有路由时才显示）
        if (routeToolbar) routeToolbar.style.display = 'flex';

        let baseUrl = vueRouterInfo.baseUrl || getPageOrigin();
        const routerMode = vueRouterInfo.routerMode || 'history';
        const detectedBase = vueRouterInfo.routerBase || ''; // 检测到的base（只用于显示）
        const allRoutes = vueRouterInfo.routes;
        
        // 🆕 设置全局变量供搜索使用
        currentVueRoutes = allRoutes;
        currentVueBaseUrl = baseUrl;
        currentVueRouterMode = routerMode;

        // ✅ 从当前标签页URL提取真实的baseUrl（包含子路径和#）
        if (currentTab_obj && currentTab_obj.url) {
            try {
                const currentUrl = currentTab_obj.url;
                if (routerMode === 'hash' && (currentUrl.includes('#/') || currentUrl.includes('#'))) {
                    const hashIndex = currentUrl.indexOf('#');
                    if (hashIndex > 0) {
                        baseUrl = currentUrl.substring(0, hashIndex + 1);
                    }
                }
            } catch (e) {
                console.warn('[AntiDebug] 提取baseUrl时出错:', e);
            }
        }

        // ✅ 过滤无效的检测结果（完整URL或包含#的base）
        let shouldShowBaseInput = false;
        let cleanDetectedBase = '';
        
        if (detectedBase && detectedBase.trim() !== '') {
            // 如果是完整URL或包含#，不显示输入框
            if (detectedBase.startsWith('http://') || detectedBase.startsWith('https://') || detectedBase.includes('#')) {
                console.warn('[AntiDebug] 检测到的base无效，已忽略:', detectedBase);
            } else {
                // 清理尾部斜杠
                cleanDetectedBase = detectedBase.endsWith('/') ? detectedBase.slice(0, -1) : detectedBase;
                if (cleanDetectedBase !== '/' && cleanDetectedBase !== '') {
                    shouldShowBaseInput = true;
                }
            }
        }

        // ✅ 自定义base逻辑（使用下拉选择框）
        const baseSelect = document.getElementById('base-select');
        const baseCount = document.querySelector('.route-toolbar .base-count');
        const customBaseInput = document.getElementById('custom-base-input');
        const clearBaseBtn = document.querySelector('.route-toolbar .clear-base-btn');

        let currentCustomBase = ''; // 当前选中的base
        const storageKey = `${hostname}_custom_base`;
        const baseListKey = `${hostname}_base_list`; // 存储用户添加的base列表

        // 更新数量显示
        function updateBaseCount() {
            if (!baseCount || !baseSelect) return;
            const count = baseSelect.options.length;
            baseCount.textContent = `+${count}`;
        }

        // 初始化下拉选择框
        function initBaseSelect() {
            if (!baseSelect) return;
            
            // 从storage读取用户添加的base列表和当前选中值
            chrome.storage.local.get([baseListKey, storageKey], (result) => {
                const savedBaseList = result[baseListKey] || [];
                currentCustomBase = result[storageKey] || '';
                currentCustomBaseValue = currentCustomBase;
                
                // 清空并重新填充选项
                baseSelect.innerHTML = '';
                
                // 首先添加"空置"选项
                const noneOption = document.createElement('option');
                noneOption.value = '';
                noneOption.textContent = '空置';
                baseSelect.appendChild(noneOption);
                
                // 如果检测到base，添加到列表
                if (cleanDetectedBase && cleanDetectedBase !== '') {
                    const option = document.createElement('option');
                    option.value = cleanDetectedBase;
                    option.textContent = cleanDetectedBase;
                    baseSelect.appendChild(option);
                }
                
                // 添加用户保存的base（去重）
                savedBaseList.forEach(base => {
                    if (base && base !== cleanDetectedBase && base !== '') {
                        const option = document.createElement('option');
                        option.value = base;
                        option.textContent = base;
                        baseSelect.appendChild(option);
                    }
                });
                
                // 设置当前选中值（默认选"空置"）
                baseSelect.value = currentCustomBase;
                
                // 更新数量显示
                updateBaseCount();
                
                // 初始渲染
                renderRoutes(allRoutes);
            });
        }

        // 显示工具栏
        if (routeToolbar) {
            routeToolbar.style.display = 'flex';
        }
        
        // 初始化下拉框
        initBaseSelect();

        // 下拉选择框变化事件
        if (baseSelect) {
            baseSelect.onchange = (e) => {
                currentCustomBase = e.target.value;
                currentCustomBaseValue = currentCustomBase;
                
                // 保存当前选中值
                chrome.storage.local.set({ [storageKey]: currentCustomBase });
                
                // 重新渲染
                renderRoutesWithSearch();
            };
        }

        // 输入框实时应用
        if (customBaseInput) {
            customBaseInput.oninput = (e) => {
                const newBase = e.target.value.trim();
                if (!newBase) {
                    // 空值时使用下拉框的值
                    currentCustomBase = baseSelect ? baseSelect.value : '';
                } else {
                    // 确保以/开头
                    currentCustomBase = newBase.startsWith('/') ? newBase : '/' + newBase;
                }
                currentCustomBaseValue = currentCustomBase;
                
                // 重新渲染
                renderRoutesWithSearch();
            };
            
            // 回车键保存到列表
            customBaseInput.onkeypress = (e) => {
                if (e.key === 'Enter') {
                    const newBase = customBaseInput.value.trim();
                    if (!newBase) return;
                    
                    const cleanBase = newBase.startsWith('/') ? newBase : '/' + newBase;
                    
                    // 检查是否已存在
                    const exists = Array.from(baseSelect.options).some(opt => opt.value === cleanBase);
                    if (!exists) {
                        // 添加新选项
                        const option = document.createElement('option');
                        option.value = cleanBase;
                        option.textContent = cleanBase;
                        baseSelect.appendChild(option);
                        
                        // 保存到storage
                        chrome.storage.local.get([baseListKey], (result) => {
                            const baseList = result[baseListKey] || [];
                            if (!baseList.includes(cleanBase)) {
                                baseList.push(cleanBase);
                                chrome.storage.local.set({ [baseListKey]: baseList });
                            }
                        });
                        
                        // 更新数量
                        updateBaseCount();
                    }
                    
                    // 选中该选项
                    baseSelect.value = cleanBase;
                    currentCustomBase = cleanBase;
                    currentCustomBaseValue = currentCustomBase;
                    chrome.storage.local.set({ [storageKey]: currentCustomBase });
                    
                    // 清空输入框
                    customBaseInput.value = '';
                    renderRoutesWithSearch();
                }
            };
        }

        // 清空按钮 - 清空输入框，选中"空置"
        if (clearBaseBtn) {
            clearBaseBtn.onclick = () => {
                // 清空输入框
                if (customBaseInput) customBaseInput.value = '';
                
                // 选中"空置"
                baseSelect.value = '';
                currentCustomBase = '';
                currentCustomBaseValue = '';
                
                // 保存到storage
                chrome.storage.local.set({ [storageKey]: '' });
                
                // 重新渲染
                renderRoutesWithSearch();
            };
        }

        // ✅ 渲染路由列表（考虑搜索框）的辅助函数
        function renderRoutesWithSearch() {
            const searchInputEl = document.getElementById('vue-route-search-input');
            const searchTerm = searchInputEl ? searchInputEl.value.toLowerCase().trim() : '';
            if (searchTerm) {
                const filteredRoutes = allRoutes.filter(route => {
                    const path = route.path.toLowerCase();
                    const name = (route.name || '').toLowerCase();
                    const fullUrl = (baseUrl + normalizePath(route.path)).toLowerCase();
                    return path.includes(searchTerm) || name.includes(searchTerm) || fullUrl.includes(searchTerm);
                });
                renderRoutes(filteredRoutes);
            } else {
                renderRoutes(allRoutes);
            }
        };
    
        // 渲染路由列表的函数
        function renderRoutes(routesToShow) {
            routesListContainer.innerHTML = '';

            routesToShow.forEach(route => {
                // 规范化路径
                const normalizedPath = normalizePath(route.path);
                
                // 根据路由模式拼接URL
                let fullUrl;
                
                // ✅ 使用用户输入的base（如果有）
                if (currentCustomBase && currentCustomBase.trim() !== '') {
                    // 用户自定义了base
                    const cleanBase = currentCustomBase.endsWith('/') ? currentCustomBase.slice(0, -1) : currentCustomBase;
                    
                    if (routerMode === 'hash') {
                        const baseUrlWithoutHash = baseUrl.endsWith('#') ? baseUrl.slice(0, -1) : baseUrl;
                        fullUrl = cleanUrl(baseUrlWithoutHash + cleanBase + '/#' + normalizedPath);
                    } else {
                        fullUrl = cleanUrl(baseUrl + cleanBase + normalizedPath);
                    }
                } else {
                    // 标准路径（无base）
                    if (routerMode === 'hash') {
                        const cleanPath = normalizedPath.startsWith('/') ? normalizedPath.substring(1) : normalizedPath;
                        
                        if (baseUrl.endsWith('#')) {
                            fullUrl = baseUrl + '/' + cleanPath;
                        } else if (baseUrl.endsWith('#/')) {
                            fullUrl = baseUrl + cleanPath;
                        } else {
                            fullUrl = baseUrl + '#/' + cleanPath;
                        }
                        
                        fullUrl = cleanUrl(fullUrl);
                    } else {
                        fullUrl = baseUrl + normalizedPath;
                    }
                }

                const routeItem = document.createElement('div');
                routeItem.className = 'route-item';

                routeItem.innerHTML = `
                    <div class="route-url" title="${fullUrl}">${fullUrl}</div>
                    <div class="route-actions">
                        <button class="route-btn copy-btn" data-url="${fullUrl}">复制</button>
                        <button class="route-btn open-btn" data-url="${fullUrl}">打开</button>
                    </div>
                `;

                routesListContainer.appendChild(routeItem);

                // 复制按钮
                const copyBtn = routeItem.querySelector('.copy-btn');
                copyBtn.addEventListener('click', () => {
                    navigator.clipboard.writeText(fullUrl).then(() => {
                        const originalText = copyBtn.textContent;
                        copyBtn.textContent = '✓ 已复制';
                        setTimeout(() => {
                            copyBtn.textContent = originalText;
                        }, 1500);
                    }).catch(err => {
                        console.error('复制失败:', err);
                    });
                });

                // 打开按钮
                const openBtn = routeItem.querySelector('.open-btn');
                openBtn.addEventListener('click', () => {
                    // 🆕 保存当前打开的路由URL到存储（仅当开启了Get_Vue_0或Get_Vue_1脚本时）
                    const hasVueScript = enabledScripts.includes('Get_Vue_0') || enabledScripts.includes('Get_Vue_1');
                    if (hasVueScript && vueRouterInfo && vueRouterInfo.routes && vueRouterInfo.routes.length > 0) {
                        const storageKey = `${hostname}_last_opened_route`;
                        chrome.storage.local.set({
                            [storageKey]: fullUrl
                        });
                    }
                    
                    chrome.tabs.update(currentTab_obj.id, {
                        url: fullUrl
                    });
                });
            });
            
            // 🆕 渲染完成后，检查是否有保存的路由并滚动到该位置
            // 仅当首次打开插件时执行跳转，切换脚本时不执行
            // 仅当开启了Get_Vue_0或Get_Vue_1脚本且成功获取到路由数据时才执行
            // 🔧 如果用户正在搜索，则不执行跳转
            const hasVueScript = enabledScripts.includes('Get_Vue_0') || enabledScripts.includes('Get_Vue_1');
            const searchInputEl = document.getElementById('vue-route-search-input');
            const isSearching = searchInputEl && searchInputEl.value.trim() !== '';
            
            // 🔧 仅在首次显示Vue路由数据时执行跳转
            if (isFirstVueDataDisplay && hasVueScript && vueRouterInfo && vueRouterInfo.routes && vueRouterInfo.routes.length > 0 && !isSearching) {
                chrome.storage.local.get([`${hostname}_last_opened_route`], (result) => {
                    const lastOpenedRoute = result[`${hostname}_last_opened_route`];
                    if (lastOpenedRoute) {
                        // 检查该路由是否在当前显示的路由列表中
                        const targetRouteItem = Array.from(routesListContainer.querySelectorAll('.route-item')).find(item => {
                            const openBtn = item.querySelector('.open-btn');
                            return openBtn && openBtn.dataset.url === lastOpenedRoute;
                        });
                        
                        if (targetRouteItem) {
                            // 路由存在，直接跳转到该位置并高亮闪烁
                            setTimeout(() => {
                                targetRouteItem.scrollIntoView({
                                    behavior: 'auto',
                                    block: 'center'
                                });
                                
                                // 🆕 添加高亮动画类（柔和淡出效果）
                                targetRouteItem.classList.add('highlight-last-opened');
                                
                                // 动画完成后移除类（1.5秒淡出）
                                setTimeout(() => {
                                    targetRouteItem.classList.remove('highlight-last-opened');
                                }, 1500);
                            }, 100);
                        }
                    }
                });
                // 标记已经执行过跳转，后续不再执行
                isFirstVueDataDisplay = false;
            }
        };

        // 🆕 搜索功能已移至外部全局事件监听
        // 如果搜索框已有内容，立即执行搜索过滤
        const searchInputEl = document.getElementById('vue-route-search-input');
        if (searchInputEl && searchInputEl.value.trim()) {
            const searchTerm = searchInputEl.value.toLowerCase().trim();
            const filteredRoutes = allRoutes.filter(route => {
                const path = route.path.toLowerCase();
                const name = (route.name || '').toLowerCase();
                return path.includes(searchTerm) || name.includes(searchTerm);
            });
            renderRoutes(filteredRoutes);
        }

        // 批量复制功能 - 根据当前用户输入的base复制
        copyAllPathsBtn.onclick = () => {
            const allPaths = allRoutes.map(route => {
                const normalizedPath = normalizePath(route.path);
                
                if (currentCustomBase && currentCustomBase.trim() !== '') {
                    const cleanBase = currentCustomBase.endsWith('/') ? currentCustomBase.slice(0, -1) : currentCustomBase;
                    return cleanBase + normalizedPath;
                }
                return normalizedPath;
            }).join('\n');
            
            navigator.clipboard.writeText(allPaths).then(() => {
                const originalText = copyAllPathsBtn.textContent;
                copyAllPathsBtn.textContent = '✓ 已复制';
                setTimeout(() => {
                    copyAllPathsBtn.textContent = originalText;
                }, 1500);
            }).catch(err => {
                console.error('复制失败:', err);
            });
        };

        copyAllUrlsBtn.onclick = () => {
            const allUrls = allRoutes.map(route => {
                const normalizedPath = normalizePath(route.path);
                let fullUrl;
                
                if (currentCustomBase && currentCustomBase.trim() !== '') {
                    const cleanBase = currentCustomBase.endsWith('/') ? currentCustomBase.slice(0, -1) : currentCustomBase;
                    
                    if (routerMode === 'hash') {
                        const baseUrlWithoutHash = baseUrl.endsWith('#') ? baseUrl.slice(0, -1) : baseUrl;
                        fullUrl = cleanUrl(baseUrlWithoutHash + cleanBase + '/#' + normalizedPath);
                    } else {
                        fullUrl = cleanUrl(baseUrl + cleanBase + normalizedPath);
                    }
                } else {
                    if (routerMode === 'hash') {
                        const cleanPath = normalizedPath.startsWith('/') ? normalizedPath.substring(1) : normalizedPath;
                        
                        if (baseUrl.endsWith('#')) {
                            fullUrl = baseUrl + '/' + cleanPath;
                        } else if (baseUrl.endsWith('#/')) {
                            fullUrl = baseUrl + cleanPath;
                        } else {
                            fullUrl = baseUrl + '#/' + cleanPath;
                        }
                        
                        fullUrl = cleanUrl(fullUrl);
                    } else {
                        fullUrl = baseUrl + normalizedPath;
                    }
                }
                
                return fullUrl;
            }).join('\n');

            navigator.clipboard.writeText(allUrls).then(() => {
                const originalText = copyAllUrlsBtn.textContent;
                copyAllUrlsBtn.textContent = '✓ 已复制';
                setTimeout(() => {
                    copyAllUrlsBtn.textContent = originalText;
                }, 1500);
            }).catch(err => {
                console.error('复制失败:', err);
            });
        };
    }

    // 🆕 处理反调试脚本开关切换（支持全局模式）
    function handleScriptToggle(scriptId, isChecked, scriptItem) {
        if (typeof scriptId !== 'string' || !scriptId.trim()) {
            console.error('Invalid script ID in change event:', scriptId);
            return;
        }

        if (isChecked) {
            if (!enabledScripts.includes(scriptId)) {
                enabledScripts.push(scriptId);
                scriptItem.classList.add('active');
            }
        } else {
            enabledScripts = enabledScripts.filter(id => id !== scriptId);
            scriptItem.classList.remove('active');
        }

        updateStorage(enabledScripts);
    }

    // 🆕 处理Vue脚本开关切换（含父子逻辑，支持全局模式）
    function handleVueScriptToggle(script, isChecked) {
        // 如果是父脚本
        if (!script.parentScript) {
            if (isChecked) {
                // 开启父脚本：添加父脚本ID
                if (!enabledScripts.includes(script.id)) {
                    enabledScripts.push(script.id);
                }
            } else {
                // 关闭父脚本：同时移除父脚本和所有子脚本
                const childScripts = allScripts.filter(s => s.parentScript === script.id);
                enabledScripts = enabledScripts.filter(id => {
                    if (id === script.id) return false;
                    if (childScripts.some(child => child.id === id)) return false;
                    return true;
                });
            }
        }
        // 如果是子脚本
        else {
            if (isChecked) {
                // 开启子脚本：移除父脚本，只保留子脚本
                enabledScripts = enabledScripts.filter(id => id !== script.parentScript);
                if (!enabledScripts.includes(script.id)) {
                    enabledScripts.push(script.id);
                }
            } else {
                // 关闭子脚本：移除子脚本，恢复父脚本
                enabledScripts = enabledScripts.filter(id => id !== script.id);
                if (!enabledScripts.includes(script.parentScript)) {
                    enabledScripts.push(script.parentScript);
                }
            }
        }

        updateStorage(enabledScripts);
    }

    // 🆕 统一的存储更新函数（支持全局模式）
    function updateStorage(enabled) {
        if (isGlobalMode) {
            // 全局模式：更新全局脚本列表
            globalEnabledScripts = [...enabled];
            chrome.storage.local.set({
                [GLOBAL_SCRIPTS_KEY]: globalEnabledScripts
            }, () => {
                // 通知后台更新脚本注册（全局模式）
                chrome.runtime.sendMessage({
                    type: 'update_scripts_registration',
                    hostname: '*',
                    enabledScripts: enabled,
                    isGlobalMode: true
                }, reportRegistrationResult);

                // 通知标签页更新状态
                chrome.tabs.sendMessage(currentTab_obj.id, {
                    type: 'scripts_updated',
                    hostname: hostname,
                    enabledScripts: enabled
                });

                // 更新本地状态并重新渲染
                enabledScripts = enabled;
                renderCurrentTab();
            });
        } else {
            // 标准模式：更新当前域名配置
            chrome.storage.local.set({
                [hostname]: enabled
            }, () => {
                // 通知后台更新脚本注册（标准模式）
                chrome.runtime.sendMessage({
                    type: 'update_scripts_registration',
                    hostname: hostname,
                    enabledScripts: enabled,
                    isGlobalMode: false
                }, reportRegistrationResult);

                // 通知标签页更新状态
                chrome.tabs.sendMessage(currentTab_obj.id, {
                    type: 'scripts_updated',
                    hostname: hostname,
                    enabledScripts: enabled
                });

                // 更新本地状态并重新渲染
                enabledScripts = enabled;
                renderCurrentTab();
            });
        }
    }
    
    // ========== 全局请求头功能 ==========
    
    // 生成唯一ID
    function generateHeaderId() {
        return `hdr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    }
    
    // 初始化Headers面板
    function initHeadersPanel() {
        loadHeadersData().then(() => {
            renderHeadersGroups();
            if (headersGroups.length > 0 && !currentHeadersGroupId) {
                currentHeadersGroupId = headersGroups[0].id;
            }
            renderHeadersItems();
            bindHeadersEvents();
        });
    }
    
    // 加载Headers数据
    function loadHeadersData() {
        return new Promise((resolve) => {
            chrome.storage.local.get([HEADERS_GROUPS_KEY, HEADERS_DATA_KEY, 'current_headers_group'], (result) => {
                headersGroups = result[HEADERS_GROUPS_KEY] || [];
                headersData = result[HEADERS_DATA_KEY] || {};
                // 恢复上次选中的组
                const savedGroupId = result['current_headers_group'];
                if (savedGroupId && headersGroups.find(g => g.id === savedGroupId)) {
                    currentHeadersGroupId = savedGroupId;
                } else if (headersGroups.length > 0) {
                    currentHeadersGroupId = headersGroups[0].id;
                }
                resolve();
            });
        });
    }
    
    // 保存Headers数据
    function saveHeadersData() {
        chrome.storage.local.set({
            [HEADERS_GROUPS_KEY]: headersGroups,
            [HEADERS_DATA_KEY]: headersData
        }, () => {
            // 通知background更新请求头注入
            notifyHeadersUpdate();
        });
    }
    
    // 通知background更新请求头（只使用当前选中组的请求头）
    function notifyHeadersUpdate() {
        // 只收集当前选中组的启用请求头
        const enabledHeaders = [];
        
        if (currentHeadersGroupId) {
            const items = headersData[currentHeadersGroupId] || [];
            // V4.9.38（批 3 审计 A-4）：**不要打印请求头实值**——Authorization/Cookie 明文进
            // popup 控制台与截图/共享控制台都会泄露；只打名字与长度。
            console.log('[AntiDebug] 当前组:', currentHeadersGroupId, '，条目数:', items.length);
            
            items.forEach(item => {
                if (item.enabled && item.name && item.name.trim()) {
                    console.log('[AntiDebug] 添加请求头:', item.name, '= <' + String((item.value || '').length) + ' 字符，已隐去>');
                    enabledHeaders.push({
                        name: item.name.trim(),
                        value: item.value || ''
                    });
                }
            });
        }
        
        console.log('[AntiDebug] 发送到 background 的请求头数量:', enabledHeaders.length);

        // V4.9.24：带上当前组的**作用域**——此前只发 headers，background 侧也没接收第二参，
        // 于是 UI 改的头恒为"全站注入"。两条入参路径（popup 消息 / mcp-client.applyGlobalHeaders）
        // 已同时打通，任一入口改都能落到 DNR 的 requestDomains 上
        const curGroup = headersGroups.find(g => g && g.id === currentHeadersGroupId);
        const targetDomains = (curGroup && Array.isArray(curGroup.targetDomains) && curGroup.targetDomains.length > 0)
            ? curGroup.targetDomains : undefined;

        chrome.runtime.sendMessage({
            type: 'UPDATE_GLOBAL_HEADERS',
            headers: enabledHeaders,
            targetDomains,
            groupId: currentHeadersGroupId
        });
    }
    
    // 渲染标签组列表（标签式布局）
    function renderHeadersGroups() {
        const container = document.getElementById('headers-tabs-list');
        if (!container) return;
        
        container.innerHTML = '';
        
        if (headersGroups.length === 0) {
            // 没有标签组时不显示任何内容
            return;
        }
        
        headersGroups.forEach(group => {
            const items = headersData[group.id] || [];
            const enabledCount = items.filter(i => i.enabled).length;
            const totalCount = items.length;
            const isActive = currentHeadersGroupId === group.id;
            
            const tabEl = document.createElement('div');
            tabEl.className = `headers-tab-item ${isActive ? 'active' : 'inactive'}`;
            tabEl.dataset.groupId = group.id;
            
            // 显示名称和启用数量/总数量
            tabEl.innerHTML = `
                <span class="tab-name">${group.name}</span>
                <span class="tab-count ${enabledCount > 0 ? 'has-enabled' : ''}">${enabledCount}/${totalCount}</span>
                <button class="tab-delete" title="删除">×</button>
            `;
            
            // 点击选中标签组
            tabEl.addEventListener('click', (e) => {
                if (e.target.classList.contains('tab-delete')) return;
                if (e.target.classList.contains('tab-name-input')) return;
                currentHeadersGroupId = group.id;
                renderHeadersGroups();
                renderHeadersItems();
                // 保存当前选中的组
                // V4.9.38（批 4 审计 R-3 🔴）：切组后必须**重放 DNR 规则**——原实现只写 storage，
                // 而 background 的 storage.onChanged 不监听 current_headers_group，于是 UI 显示新组、
                // 实际注入的仍是旧组的请求头（用错身份/凭据发错组，用户零感知）。
                // MCP 工具路径 switchHeaderGroup 本来就有重放（mcp-client-events.js），popup 这条漏了。
                chrome.storage.local.set({ 'current_headers_group': group.id }, () => {
                    notifyHeadersUpdate();
                });
            });
            
            // 双击编辑名称
            const nameEl = tabEl.querySelector('.tab-name');
            nameEl.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                startEditGroupName(group.id, tabEl, nameEl);
            });
            
            // 删除按钮
            const deleteBtn = tabEl.querySelector('.tab-delete');
            deleteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                deleteHeadersGroup(group.id);
            });
            
            container.appendChild(tabEl);
        });
    }
    
    // 开始编辑标签组名称
    function startEditGroupName(groupId, tabEl, nameEl) {
        const group = headersGroups.find(g => g.id === groupId);
        if (!group) return;
        
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'tab-name-input';
        input.value = group.name;
        
        nameEl.replaceWith(input);
        input.focus();
        input.select();
        
        const finishEdit = () => {
            const newName = input.value.trim() || '未命名';
            group.name = newName;
            saveHeadersData();
            renderHeadersGroups();
        };
        
        input.addEventListener('blur', finishEdit);
        input.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                input.blur();
            }
        });
        input.addEventListener('click', (e) => {
            e.stopPropagation();
        });
    }
    
    // 添加标签组
    function addHeadersGroup() {
        // 使用更好的默认命名：配置A、配置B、配置C...
        const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        let nextIndex = 0;
        const usedNames = headersGroups.map(g => g.name);
        
        // 找到下一个可用的字母
        while (nextIndex < letters.length && usedNames.includes(`配置${letters[nextIndex]}`)) {
            nextIndex++;
        }
        
        const name = nextIndex < letters.length ? `配置${letters[nextIndex]}` : `配置${headersGroups.length + 1}`;
        
        const newGroup = {
            id: generateHeaderId(),
            name: name
        };
        headersGroups.push(newGroup);
        headersData[newGroup.id] = [];
        currentHeadersGroupId = newGroup.id;
        saveHeadersData();
        renderHeadersGroups();
        renderHeadersItems();
    }
    
    // 删除标签组
    function deleteHeadersGroup(groupId) {
        headersGroups = headersGroups.filter(g => g.id !== groupId);
        delete headersData[groupId];
        
        if (currentHeadersGroupId === groupId) {
            currentHeadersGroupId = headersGroups.length > 0 ? headersGroups[0].id : null;
        }
        
        saveHeadersData();
        renderHeadersGroups();
        renderHeadersItems();
    }
    
    // ===== V4.9.24：请求头作用域（targetDomains）=====
    // 语义：组上**不设** targetDomains = 全站注入（与改动前完全一致，老组零迁移）；
    // 设了则只对 requestDomains 命中者注入——注意 DNR 语义为"域**及其所有子域**"。
    // 归一化表达式与 background.js / mcp-client.js **同一份**（三处必须一致，temp/test_dnr_scope_v4924.js 防漂移）
    function normTargetDomains(targetDomains) {
        const normDomains = (Array.isArray(targetDomains) ? targetDomains : [])
            .map(d => String(d == null ? '' : d).trim().toLowerCase()
                .replace(/^[a-z]+:\/\//, '')
                .replace(/[/?#].*$/, '')
                .replace(/:\d+$/, ''))
            .filter(d => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d));
        return normDomains;
    }

    function getCurrentHeadersGroup() {
        return headersGroups.find(g => g && g.id === currentHeadersGroupId) || null;
    }

    // 当前活动标签页的 hostname（"用当前站点"按钮 / "仅当前站点"选项用）
    function getActiveTabHost() {
        return new Promise((resolve) => {
            try {
                chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                    const t = tabs && tabs[0];
                    let host = '';
                    try { host = (t && t.url) ? new URL(t.url).hostname : ''; } catch (e) { host = ''; }
                    resolve(host || '');
                });
            } catch (e) { resolve(''); }
        });
    }

    // 把作用域写回当前组并生效（saveHeadersData 会触发 notifyHeadersUpdate 重写 DNR 规则）
    function setGroupScope(domains) {
        const group = getCurrentHeadersGroup();
        if (!group) return;
        const norm = normTargetDomains(domains);
        if (norm.length > 0) group.targetDomains = norm;
        else delete group.targetDomains;   // 空 = 全站（不写空数组，保持"字段不存在即全局"的零迁移语义）
        saveHeadersData();
        syncScopeUI();
    }

    function syncScopeUI() {
        const row = document.getElementById('headers-scope-row');
        const sel = document.getElementById('headers-scope-select');
        const inp = document.getElementById('headers-scope-input');
        const warn = document.getElementById('headers-scope-warn');
        if (!row || !sel || !inp) return;

        const group = getCurrentHeadersGroup();
        if (!group) {
            row.style.display = 'none';
            if (warn) warn.style.display = 'none';
            return;
        }
        row.style.display = 'flex';

        const doms = Array.isArray(group.targetDomains) ? group.targetDomains : [];
        if (doms.length === 0) {
            sel.value = 'all';
            inp.value = '';
        } else {
            sel.value = 'custom';
            inp.value = doms.join(', ');
        }
        inp.style.display = sel.value === 'custom' ? 'block' : 'none';
        if (warn) warn.style.display = sel.value === 'all' ? 'block' : 'none';
    }

    function bindScopeEvents() {
        const sel = document.getElementById('headers-scope-select');
        const inp = document.getElementById('headers-scope-input');
        const btn = document.getElementById('headers-scope-current');

        if (sel) {
            sel.onchange = async () => {
                if (sel.value === 'all') { setGroupScope([]); return; }
                if (sel.value === 'current') {
                    const host = await getActiveTabHost();
                    if (!host) { sel.value = 'custom'; inp.style.display = 'block'; return; }
                    setGroupScope([host]);
                    return;
                }
                inp.style.display = 'block';
                inp.focus();
            };
        }
        if (inp) {
            inp.onchange = () => setGroupScope(inp.value.split(/[,\s]+/));
            inp.onblur = () => setGroupScope(inp.value.split(/[,\s]+/));
        }
        if (btn) {
            btn.onclick = async () => {
                const host = await getActiveTabHost();
                if (!host) return;
                const group = getCurrentHeadersGroup();
                const cur = (group && Array.isArray(group.targetDomains)) ? group.targetDomains : [];
                if (!cur.includes(host)) cur.push(host);
                setGroupScope(cur);
            };
        }
    }

    // 渲染请求头列表
    function renderHeadersItems() {
        const container = document.getElementById('headers-items-list');
        const emptyHint = document.getElementById('headers-empty-hint');
        const titleEl = document.getElementById('current-group-name');
        const addBtn = document.getElementById('add-header-btn');
        
        if (!container) return;

        // V4.9.24：作用域行随当前组同步（含"无组/未选组"时隐藏）
        syncScopeUI();

        // 更新标题
        if (titleEl) {
            const group = headersGroups.find(g => g.id === currentHeadersGroupId);
            titleEl.textContent = group ? group.name : '请求头';
        }
        
        // 如果没有标签组
        if (headersGroups.length === 0) {
            container.style.display = 'none';
            if (addBtn) addBtn.style.display = 'none';
            if (emptyHint) {
                emptyHint.style.display = 'flex';
                emptyHint.querySelector('p').textContent = '点击上方 + 添加标签组';
            }
            return;
        }
        
        // 如果没有选中的标签组
        if (!currentHeadersGroupId) {
            container.style.display = 'none';
            if (addBtn) addBtn.style.display = 'none';
            if (emptyHint) {
                emptyHint.style.display = 'flex';
                emptyHint.querySelector('p').textContent = '选择一个标签组';
            }
            return;
        }
        
        if (addBtn) addBtn.style.display = 'flex';
        
        const items = headersData[currentHeadersGroupId] || [];
        
        if (items.length === 0) {
            container.style.display = 'none';
            if (emptyHint) {
                emptyHint.style.display = 'flex';
                emptyHint.querySelector('p').textContent = '点击「添加请求头」按钮添加';
            }
            return;
        }
        
        container.style.display = 'flex';
        if (emptyHint) emptyHint.style.display = 'none';
        
        container.innerHTML = '';
        
        items.forEach((item, index) => {
            const itemEl = document.createElement('div');
            itemEl.className = `header-item ${item.enabled ? 'enabled' : ''}`;
            itemEl.dataset.itemId = item.id;
            
            itemEl.innerHTML = `
                <input type="checkbox" class="header-checkbox" ${item.enabled ? 'checked' : ''}>
                <div class="header-inputs">
                    <input type="text" class="header-name-input" placeholder="Name" value="${item.name || ''}" list="header-suggestions-${item.id}" autocomplete="off">
                    <datalist id="header-suggestions-${item.id}"></datalist>
                    <input type="text" class="header-value-input" placeholder="Value" value="${item.value || ''}">
                </div>
                <button class="header-delete-btn">×</button>
            `;
            
            // 绑定事件
            const checkbox = itemEl.querySelector('.header-checkbox');
            const nameInput = itemEl.querySelector('.header-name-input');
            const valueInput = itemEl.querySelector('.header-value-input');
            const deleteBtn = itemEl.querySelector('.header-delete-btn');
            
            checkbox.addEventListener('change', (e) => {
                item.enabled = e.target.checked;
                itemEl.classList.toggle('enabled', item.enabled);
                saveHeadersData();
                renderHeadersGroups(); // 更新指示灯
            });
            
            // 自动补全逻辑
            const datalist = itemEl.querySelector(`#header-suggestions-${item.id}`);
            
            function updateSuggestions(inputValue) {
                if (!datalist) return;
                datalist.innerHTML = '';
                
                if (!inputValue || inputValue.length === 0) return;
                
                const lowerInput = inputValue.toLowerCase();
                const matches = COMMON_HEADERS.filter(h => 
                    h.toLowerCase().includes(lowerInput)
                );
                
                matches.forEach(match => {
                    const option = document.createElement('option');
                    option.value = match;
                    datalist.appendChild(option);
                });
            }
            
            nameInput.addEventListener('input', (e) => {
                item.name = e.target.value;
                updateSuggestions(e.target.value);
            });
            
            nameInput.addEventListener('focus', (e) => {
                updateSuggestions(e.target.value);
            });
            
            nameInput.addEventListener('blur', () => {
                saveHeadersData();
            });
            
            valueInput.addEventListener('input', (e) => {
                item.value = e.target.value;
            });
            
            valueInput.addEventListener('blur', () => {
                saveHeadersData();
            });
            
            deleteBtn.addEventListener('click', () => {
                deleteHeaderItem(item.id);
            });
            
            container.appendChild(itemEl);
        });
    }
    
    // 添加请求头
    function addHeaderItem() {
        if (!currentHeadersGroupId) {
            showToast('请先选择或创建标签组');
            return;
        }
        
        if (!headersData[currentHeadersGroupId]) {
            headersData[currentHeadersGroupId] = [];
        }
        
        const newItem = {
            id: generateHeaderId(),
            name: '',
            value: '',
            enabled: true
        };
        
        headersData[currentHeadersGroupId].push(newItem);
        saveHeadersData();
        renderHeadersItems();
        renderHeadersGroups();
        
        // 自动聚焦到新添加的输入框
        setTimeout(() => {
            const container = document.getElementById('headers-items-list');
            const lastItem = container.lastElementChild;
            if (lastItem) {
                const nameInput = lastItem.querySelector('.header-name-input');
                if (nameInput) nameInput.focus();
            }
        }, 50);
    }
    
    // 删除请求头
    function deleteHeaderItem(itemId) {
        if (!currentHeadersGroupId) return;
        
        headersData[currentHeadersGroupId] = (headersData[currentHeadersGroupId] || []).filter(i => i.id !== itemId);
        saveHeadersData();
        renderHeadersItems();
        renderHeadersGroups();
    }
    
    // 绑定Headers按钮事件
    function bindHeadersEvents() {
        const addGroupBtn = document.getElementById('add-group-btn');
        const addHeaderBtn = document.getElementById('add-header-btn');

        bindScopeEvents();   // V4.9.24：作用域控件

        if (addGroupBtn) {
            addGroupBtn.onclick = addHeadersGroup;
        }
        
        if (addHeaderBtn) {
            addHeaderBtn.onclick = addHeaderItem;
        }
    }
    
    // ========== 全局请求头功能结束 ==========
});
