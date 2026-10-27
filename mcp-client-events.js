// ============== 发送当前页面信息 ==============
async function sendCurrentPageInfo() {
    try {
        const pageInfo = await getPageInfo();
        sendToMCP('PAGE_INFO', pageInfo);
    } catch (e) {
        console.warn('[MCP Client] 发送页面信息失败:', e);
    }
}

// ============== Hook数据收集 ==============
function addHookData(data, tabId) {
    // 总闸：三态门控（同 webRequest——pending 态默认收，避免唤醒窗口丢首批数据）
    if (mcpInitState === 'disabled') return;
    // 单条 message 截断：防止极端大输出（如 base64 密文流）撑爆缓冲与 session 配额
    if (data && typeof data.message === 'string' && data.message.length > 65536) {
        data = { ...data, message: data.message.slice(0, 65536) + '...[ADB 截断]' };
    }
    const entry = {
        ...data,
        timestamp: Date.now()
    };
    // V4.9.23（缺陷🟡-2）：记录**来源标签页**——hookDataBuffer 是全体标签页共享的，
    // 而 content.js 上报时 sender.tab 一直现成可用、此前被整个丢弃 → console/hook 记录无归属，
    // 多标签下 get_console_messages 会把 A 站的日志混进 B 站的结论里（且无从分辨）。
    // 上报体自带 tabId 时以其为准（页面侧更权威），否则用 sender.tab.id
    if (typeof entry.tabId !== 'number' && typeof tabId === 'number') entry.tabId = tabId;
    hookDataBuffer.push(entry);

    // 限制缓冲区大小
    if (hookDataBuffer.length > 500) {
        hookDataBuffer = hookDataBuffer.slice(-500);
    }

    schedulePersistBuffers();
    // V4.9.21（性能优化 1.1）：删除逐条推送——同 addNetworkRequest。server 侧 browserState.hookData
    // 同样只写不读（唯一读取点 browser://state resource 已改为实时拉取），而推送流单条最大 64KB
    // （base64 密文流），逐条走 stringify + WS 帧 + server 侧满 500 后 O(n) 复制，代价更大。
}

// ============== 网络请求拦截 ==============
// requestId → 缓冲条目对象引用的 Map：onCompleted 用 O(1) 命中更新。
// 存对象引用（而非下标）：环形裁剪导致数组位移时引用依然有效，无需重索引
const networkRequestIndex = new Map();

// V4.9.20（审计🟡-1）：重定向链按 requestId **引用共享**——webRequest 每次重定向跳都会重新触发
// onBeforeRequest（跳转目标永远匹配 <all_urls>），每跳各成一条记录；若只在单条上 push，链会碎片化
// （没有任何一条持有完整链、每条最多 1 跳）。同 requestId 的所有条目共享同一数组引用。
const redirectChains = new Map();

function addNetworkRequest(request) {
    // 限制缓冲区大小：环形裁剪（splice 原地删除），替代 slice 全量复制
    if (networkRequests.length >= 1000) {
        const removed = networkRequests.splice(0, networkRequests.length - 999);
        removed.forEach(r => networkRequestIndex.delete(r.requestId));
    }

    const entry = {
        ...request,
        timestamp: Date.now()
    };
    networkRequests.push(entry);
    if (request.requestId !== undefined) {
        networkRequestIndex.set(request.requestId, entry);
        // V4.9.20（审计🟡-1）：同 requestId 已有重定向链 → 新条目共享同一链引用（任一跳都能看到完整链）
        const chain = redirectChains.get(request.requestId);
        if (chain) entry.redirects = chain;
    }

    schedulePersistBuffers();
    // V4.9.21（性能优化 1.1）：删除逐条推送——全项目检索确认 server 侧 browserState.networkRequests
    // **只写不读**（唯一读取点是 browser://state resource，已改为实时拉取）。
    // 原实现每条请求一次 JSON.stringify + 一个 WS 帧 + server 侧满 1000 后每条复制 1000 元素数组。
}

// 使用 chrome.webRequest 监听所有网络请求
// webRequest 诊断计数（GET_PAGE_INFO 返回，定位回调是否触发/ResourceType 分布）
const webRequestDiag = { seen: 0, captured: 0, types: {}, lastUrl: '', listenerRegisteredAt: Date.now() };

chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
        // 总闸：三态门控——pending（SW 刚唤醒、storage 未回）默认抓，disabled 才丢。
        // 旧版 !mcpEnabled 门控会丢弃 SW 唤醒瞬间的第一批请求（实测回归）
        if (mcpInitState === 'disabled') return;
        webRequestDiag.seen++;
        webRequestDiag.types[details.type] = (webRequestDiag.types[details.type] || 0) + 1;
        webRequestDiag.lastUrl = (details.url || '').slice(0, 120);
        // 只捕获 API 请求（XHR/fetch）。
        // 注：webRequest 里 fetch 请求的 type 就是 xmlhttprequest，'fetch' 分支为兼容性保留（永假）
        if (details.type === 'xmlhttprequest' || details.type === 'fetch') {
            webRequestDiag.captured++;
            addNetworkRequest({
                url: details.url,
                method: details.method,
                type: details.type,
                tabId: details.tabId,
                requestId: details.requestId,
                initiator: details.initiator
            });
        }
    },
    { urls: ['<all_urls>'] }
);

// 监听请求完成，获取响应状态
chrome.webRequest.onCompleted.addListener(
    (details) => {
        if (mcpInitState === 'disabled') return;
        if (details.type === 'xmlhttprequest' || details.type === 'fetch') {
            // O(1) 命中更新（Map 存对象引用，环形裁剪不影响）
            const entry = networkRequestIndex.get(details.requestId);
            if (entry) {
                entry.statusCode = details.statusCode;
                entry.completed = true;
                schedulePersistBuffers();
            } else {
                // 未命中（SW 重启后 Map 清空等）：退回线性查找补录
                // V4.9.20（审计🟡-2）：取**最后一条**（最新跳）——原 find 取首条，重定向场景下
                // SW 重启后会把最终状态码写到第一跳上（同 requestId 多条目互相矛盾）
                let existing = null;
                for (let i = networkRequests.length - 1; i >= 0; i--) {
                    if (networkRequests[i].requestId === details.requestId) { existing = networkRequests[i]; break; }
                }
                if (existing) {
                    existing.statusCode = details.statusCode;
                    existing.completed = true;
                    networkRequestIndex.set(details.requestId, existing);
                    schedulePersistBuffers();
                }
            }
        }
    },
    { urls: ['<all_urls>'] }
);

// ===== V4.9.17（抓包优化）：请求头采集 =====
// extraHeaders opt-in（第三参数，非阻塞只读——无需 webRequestBlocking）：
// Cookie / Referer / Accept-Language 等浏览器自动头仅在 extraHeaders 下可见。
// Authorization / 签名头等 JS 显式头 webRequest 侧拿不到 → 由页面 hook 侧补充（两源互补）。
chrome.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
        if (mcpInitState === 'disabled') return;
        if (details.type !== 'xmlhttprequest' && details.type !== 'fetch') return;
        webRequestDiag.hdrSeen = (webRequestDiag.hdrSeen || 0) + 1;
        webRequestDiag.lastHeaderNames = (details.requestHeaders || []).map(h => h.name);
        const entry = networkRequestIndex.get(details.requestId);
        if (entry) {
            entry.requestHeaders = (details.requestHeaders || []).map(h => ({ name: h.name, value: h.value }));
        }
    },
    { urls: ['<all_urls>'] },
    ['requestHeaders', 'extraHeaders']
);

// 响应头采集（responseHeaders + extraHeaders → Set-Cookie / 安全头 / 自定义头可见）。
// 比 onCompleted 更早触发且重定向每跳都有——同时兜底 statusCode（onCompleted 兜不到的失败前跳）
chrome.webRequest.onHeadersReceived.addListener(
    (details) => {
        if (mcpInitState === 'disabled') return;
        if (details.type !== 'xmlhttprequest' && details.type !== 'fetch') return;
        const entry = networkRequestIndex.get(details.requestId);
        if (entry) {
            entry.statusCode = details.statusCode;
            entry.responseHeaders = (details.responseHeaders || []).map(h => ({ name: h.name, value: h.value }));
        }
    },
    { urls: ['<all_urls>'] },
    ['responseHeaders', 'extraHeaders']
);

// 失败请求采集（网络层失败：DNS/CORS/断连/超时——原实现这类请求永远 completed:false 无声消失）
chrome.webRequest.onErrorOccurred.addListener(
    (details) => {
        if (mcpInitState === 'disabled') return;
        if (details.type !== 'xmlhttprequest' && details.type !== 'fetch') return;
        const entry = networkRequestIndex.get(details.requestId);
        if (entry) {
            entry.error = details.error;
            entry.completed = true;
        } else {
            addNetworkRequest({
                url: details.url,
                method: details.method,
                type: details.type,
                tabId: details.tabId,
                requestId: details.requestId,
                initiator: details.initiator,
                error: details.error,
                completed: true
            });
        }
    },
    { urls: ['<all_urls>'] }
);

// V4.9.20：重定向链采集——按 requestId 引用共享（见 redirectChains 注释；审计🟡-1 修复：
// 原"每条目 push"因每跳重触发 onBeforeRequest 而碎片化，链不完整）
// 渗透场景：登录跳转 / SSO 链路 / 开放重定向探测
chrome.webRequest.onBeforeRedirect.addListener(
    (details) => {
        if (mcpInitState === 'disabled') return;   // 审计⚪-5：计数移到闸后（与 seen/hdrSeen 同口径——原闸前计数致"关闭时 redirectSeen>0 但 seen=0"的矛盾诊断）
        if (details.type !== 'xmlhttprequest' && details.type !== 'fetch') return;
        webRequestDiag.redirectSeen = (webRequestDiag.redirectSeen || 0) + 1;   // 诊断计数
        // V4.9.20（审计🟡-3）：URL 上限 300→1500 且带显式标记——SSO/OAuth 回调的 code/token/JWT
        // 常把 URL 撑到千级，原 300 静默切掉最该看的部分（违背"禁静默截断"纪律）
        const clipUrl = (u) => {
            const s = String(u || '');
            return s.length > 1500 ? s.slice(0, 1500) + '...[ADB 截断: 原始 ' + s.length + ' 字符]' : s;
        };
        const rid = details.requestId;
        let chain = redirectChains.get(rid);
        if (!chain) {
            chain = [];
            redirectChains.set(rid, chain);
            if (redirectChains.size > 500) {   // 链映射容量上限（防 requestId 无限增长）
                const firstKey = redirectChains.keys().next().value;
                if (firstKey !== undefined) redirectChains.delete(firstKey);
            }
        }
        chain.push({ from: clipUrl(details.url), to: clipUrl(details.redirectUrl), statusCode: details.statusCode });
        if (chain.length > 10) chain.shift();
        const applyTo = (entry) => {
            if (!entry) return;
            entry.redirects = chain;
            entry.completed = true;      // 审计🟡-2：该跳生命周期终止于重定向（原缺 completed 像"仍在飞行"）
            entry.redirected = true;
        };
        applyTo(networkRequestIndex.get(rid));
        // 审计🟡-2：Map 未命中（SW 重启等）→ 线性回退（与 onCompleted 同款兜底，防静默丢弃）
        if (!networkRequestIndex.has(rid)) {
            networkRequests.filter(r => r.requestId === rid).forEach(applyTo);
        }
    },
    { urls: ['<all_urls>'] }
);

// ============== 监听来自content script的消息 ==============
// 注：mcp_enabled/mcp_port/脚本状态变化的监听统一在 setupStorageWatcher()（SW 启动时注册），
// 此处不再重复注册第二个 storage.onChanged 监听器（旧版重复响应 mcp_enabled，
// 两次触发连接逻辑，仅靠 connectToMCP 的幂等守卫避免双连接）。

// ============== 监听来自content script的消息 ==============
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // 处理Hook数据
    if (message.type === 'MCP_HOOK_DATA') {
        // V4.9.23（缺陷🟡-2）：透传 sender.tab.id 作为记录归属
        addHookData(message.data, sender && sender.tab ? sender.tab.id : undefined);
        sendResponse({ success: true });
        return true;
    }
    
    // 处理网络请求
    if (message.type === 'MCP_NETWORK_REQUEST') {
        addNetworkRequest(message.data);
        sendResponse({ success: true });
        return true;
    }
    
    // 获取MCP连接状态（实时检查）
    if (message.type === 'GET_MCP_STATUS') {
        // 实时检查 WebSocket 状态
        const actuallyConnected = ws && ws.readyState === WebSocket.OPEN && isConnected;
        const isConnecting = ws && ws.readyState === WebSocket.CONNECTING;

        // 如果状态不一致，同步更新
        if (isConnected && !actuallyConnected) {
            console.log('[MCP Client] 状态不一致，更新为断开');
            handleDisconnect();
            scheduleReconnect();
        }

        // 等待重连中：已启用、未连接、且存在重连定时器
        const isWaitingReconnect = mcpEnabled && !actuallyConnected && !isConnecting && reconnectTimer !== null;

        sendResponse({
            connected: actuallyConnected,
            enabled: mcpEnabled,
            connecting: isConnecting,
            error: false, // 无限重连，不再有"重连次数用尽"的失败态
            waitingReconnect: isWaitingReconnect,
            wsUrl: getMCPWsUrl(),
            port: mcpPort,
            wsState: ws ? ws.readyState : -1, // 0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED
            reconnectAttempts: reconnectAttempts,
            reconnectDelay: reconnectDelay,
            lastPongTime: lastPongTime
        });
        return true;
    }

    // 重新连接MCP（端口变更时调用）
    if (message.type === 'RECONNECT_MCP') {
        console.log('[MCP Client] 收到重连请求');

        // 先断开现有连接
        disconnectFromMCP();

        // 重新读取配置并连接
        chrome.storage.local.get(['mcp_enabled', 'mcp_port'], (result) => {
            mcpEnabled = result.mcp_enabled === true;
            mcpPort = result.mcp_port || MCP_DEFAULT_PORT;
            mcpInitState = mcpEnabled ? 'enabled' : 'disabled';

            console.log('[MCP Client] 重新连接，端口:', mcpPort);

            if (mcpEnabled) {
                reconnectAttempts = 0; // 重置重连计数
                reconnectDelay = RECONNECT_BASE_DELAY;
                connectToMCP();
            }
        });

        sendResponse({ success: true });
        return true;
    }
    
    return false;
});

// ============== 监听标签页变化 ==============
chrome.tabs.onActivated.addListener((activeInfo) => {
    // V4.9.10.2（审计 Low-2）：先辨别来源——AI 自激活（白名单，2 秒窗口）不取消恢复；
    // 只有"用户主动切到其他标签"才取消（V4.9.9.3 语义，配合白名单防自误杀）
    const markAt = activeInfo ? selfActivateMark.get(activeInfo.tabId) : undefined;
    if (markAt && Date.now() - markAt < 2000) {
        selfActivateMark.delete(activeInfo.tabId);
    } else if (focusRestore && activeInfo && activeInfo.tabId !== focusRestore.activatedTabId) {
        if (focusRestore.timer) clearTimeout(focusRestore.timer);
        focusRestore = null;
    }
    probeAliveCache.delete(activeInfo ? activeInfo.tabId : -1); // V4.9.10.2：切换后该标签活性需重探（保守失效）
    if (isConnected) {
        sendCurrentPageInfo();
    }
});
// V4.9.10.2（审计 Note-7）：标签关闭时清理探测缓存
chrome.tabs.onRemoved.addListener((tabId) => {
    probeAliveCache.delete(tabId);
    axRefTables.delete(tabId);   // bug-hunt（2026-10-13）：a11y ref 表同样按标签清理（防标签关闭后的表残留）
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    // V4.9.11（独立审计 L4）：页面刷新/导航后暂停态即失效（CDP 不发 Debugger.resumed）——
    // 不清会让 get_debug_state 谎报 paused:true 并给出已死的 callFrameId
    if (changeInfo.status === 'loading') {
        debuggerPausedStates.delete(tabId);
    }
    if (changeInfo.status === 'complete' && isConnected) {
        sendCurrentPageInfo();
    }
});

// ===== 请求头管理功能 =====

// 获取请求头配置
async function getHeadersConfig() {
    return new Promise((resolve) => {
        chrome.storage.local.get(['global_headers_groups', 'global_headers_data', 'current_headers_group', 'global_headers_last_error'], (result) => {
            const groups = result.global_headers_groups || [];
            const data = result.global_headers_data || {};
            const currentGroupId = result.current_headers_group || null;
            const lastError = result.global_headers_last_error || null;

            // 构建完整的配置信息
            const config = {
                currentGroupId,
                groups: groups.map(g => ({
                    ...g,
                    headers: data[g.id] || [],
                    isCurrent: g.id === currentGroupId
                })),
                totalGroups: groups.length,
                totalHeaders: Object.values(data).flat().length,
                // V4.9.11（验收修复 A2）：回显最近一次 DNR 规则写入失败——原实现下这种失败是
                // **完全静默**的（调用方收到 success，用户以为头设好了，实际规则没生效）。
                // 有该字段说明配置与生效状态不一致，需按 message 修正（如头名非法）
                lastError: lastError ? {
                    at: new Date(lastError.at).toISOString(),
                    count: lastError.count,
                    message: lastError.message,
                    hint: '最近一次请求头规则写入失败：配置已保存但**未生效**，请检查头名/值是否合法（如含空格、非法字符或为浏览器保留头）'
                } : null
            };

            resolve(config);
        });
    });
}

// 创建请求头组
async function createHeaderGroup({ name, headers = [], targetDomains }) {
    return new Promise((resolve, reject) => {
        if (!name || !name.trim()) {
            reject(new Error('请求头组名称不能为空'));
            return;
        }

        chrome.storage.local.get(['global_headers_groups', 'global_headers_data'], (result) => {
            const groups = result.global_headers_groups || [];
            const data = result.global_headers_data || {};

            // 生成唯一ID
            const groupId = `hg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

            // V4.9.24：作用域挂在**组**上（缺省 = 全局，老配置零迁移）。
            // 归一化与 background 侧同口径，只存干净值——一个非法域名会让整批 DNR 规则被拒
            const normDomains = (Array.isArray(targetDomains) ? targetDomains : [])
                .map(d => String(d == null ? '' : d).trim().toLowerCase()
                    .replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, ''))
                .filter(d => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d));

            // 添加新组
            const newGroup = {
                id: groupId,
                name: name.trim(),
                createdAt: Date.now(),
                ...(normDomains.length > 0 ? { targetDomains: normDomains } : {})
            };
            groups.push(newGroup);
            
            // 初始化请求头数据
            data[groupId] = headers.map((h, index) => ({
                id: `h_${Date.now()}_${index}`,
                name: h.name || '',
                value: h.value || '',
                enabled: h.enabled !== false
            }));
            
            chrome.storage.local.set({
                global_headers_groups: groups,
                global_headers_data: data
            }, () => {
                resolve({
                    success: true,
                    groupId,
                    group: newGroup,
                    // 如实回显作用域：全站注入时必须说清楚（凭据头会发往所有站点）
                    scope: normDomains.length > 0 ? normDomains : 'all-sites（全站注入——含凭据头时请务必确认）',
                    message: `请求头组 "${name}" 创建成功`
                });
            });
        });
    });
}

// 删除请求头组
async function deleteHeaderGroup({ groupId }) {
    return new Promise((resolve, reject) => {
        if (!groupId) {
            reject(new Error('请求头组ID不能为空'));
            return;
        }
        
        chrome.storage.local.get(['global_headers_groups', 'global_headers_data', 'current_headers_group'], (result) => {
            let groups = result.global_headers_groups || [];
            const data = result.global_headers_data || {};
            let currentGroupId = result.current_headers_group;
            
            // 查找并删除组
            const groupIndex = groups.findIndex(g => g.id === groupId);
            if (groupIndex === -1) {
                reject(new Error(`未找到请求头组: ${groupId}`));
                return;
            }
            
            const deletedGroup = groups[groupIndex];
            groups = groups.filter(g => g.id !== groupId);
            delete data[groupId];
            
            // 如果删除的是当前组，清空当前选择
            if (currentGroupId === groupId) {
                currentGroupId = null;
                // 清除所有请求头规则
                applyGlobalHeaders([]).catch(() => { /* 失败原因已记入 storage，见 get_headers_config 的 lastError */ });
            }
            
            chrome.storage.local.set({
                global_headers_groups: groups,
                global_headers_data: data,
                current_headers_group: currentGroupId
            }, () => {
                resolve({
                    success: true,
                    deletedGroupId: groupId,
                    deletedGroupName: deletedGroup.name,
                    message: `请求头组 "${deletedGroup.name}" 已删除`
                });
            });
        });
    });
}

// 切换当前请求头组
async function switchHeaderGroup({ groupId }) {
    return new Promise((resolve, reject) => {
        chrome.storage.local.get(['global_headers_groups', 'global_headers_data', 'current_headers_group'], (result) => {
            const groups = result.global_headers_groups || [];
            const data = result.global_headers_data || {};
            
            // 如果 groupId 为 null 或空，则禁用所有请求头
            if (!groupId) {
                chrome.storage.local.set({ current_headers_group: null }, () => {
                    applyGlobalHeaders([]).catch(() => { /* 失败原因已记入 storage，见 get_headers_config 的 lastError */ });
                    resolve({
                        success: true,
                        currentGroupId: null,
                        message: '已禁用所有请求头'
                    });
                });
                return;
            }
            
            // 验证组是否存在
            const group = groups.find(g => g.id === groupId);
            if (!group) {
                reject(new Error(`未找到请求头组: ${groupId}`));
                return;
            }
            
            // 获取该组的启用请求头
            const groupHeaders = data[groupId] || [];
            const enabledHeaders = groupHeaders
                .filter(h => h.enabled && h.name && h.name.trim())
                .map(h => ({ name: h.name.trim(), value: h.value || '' }));
            
            // 更新当前组
            chrome.storage.local.set({ current_headers_group: groupId }, () => {
                // 通知 background 更新请求头规则
                applyGlobalHeaders(enabledHeaders).catch(() => { /* 失败原因已记入 storage，见 get_headers_config 的 lastError */ });

                resolve({
                    success: true,
                    currentGroupId: groupId,
                    groupName: group.name,
                    enabledHeaders: enabledHeaders.length,
                    message: `已切换到请求头组 "${group.name}"，${enabledHeaders.length} 个请求头已启用`
                });
            });
        });
    });
}

// 添加单个请求头
async function addHeader({ groupId, name, value, enabled = true }) {
    return new Promise((resolve, reject) => {
        if (!groupId) {
            reject(new Error('请求头组ID不能为空'));
            return;
        }
        if (!name || !name.trim()) {
            reject(new Error('请求头名称不能为空'));
            return;
        }
        
        chrome.storage.local.get(['global_headers_groups', 'global_headers_data', 'current_headers_group'], (result) => {
            const groups = result.global_headers_groups || [];
            const data = result.global_headers_data || {};
            const currentGroupId = result.current_headers_group;
            
            // 验证组是否存在
            const group = groups.find(g => g.id === groupId);
            if (!group) {
                reject(new Error(`未找到请求头组: ${groupId}`));
                return;
            }
            
            // 添加请求头
            const headerId = `h_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
            const newHeader = {
                id: headerId,
                name: name.trim(),
                value: value || '',
                enabled: enabled
            };
            
            if (!data[groupId]) {
                data[groupId] = [];
            }
            data[groupId].push(newHeader);
            
            chrome.storage.local.set({ global_headers_data: data }, () => {
                // 如果是当前组，立即更新规则
                if (groupId === currentGroupId) {
                    const enabledHeaders = data[groupId]
                        .filter(h => h.enabled && h.name && h.name.trim())
                        .map(h => ({ name: h.name.trim(), value: h.value || '' }));
                    
                    applyGlobalHeaders(enabledHeaders).catch(() => { /* 失败原因已记入 storage，见 get_headers_config 的 lastError */ });
                }
                
                resolve({
                    success: true,
                    headerId,
                    header: newHeader,
                    groupId,
                    message: `请求头 "${name}" 添加成功`
                });
            });
        });
    });
}

// 更新请求头
async function updateHeader({ groupId, headerId, name, value, enabled }) {
    return new Promise((resolve, reject) => {
        if (!groupId || !headerId) {
            reject(new Error('请求头组ID和请求头ID不能为空'));
            return;
        }
        
        chrome.storage.local.get(['global_headers_data', 'current_headers_group'], (result) => {
            const data = result.global_headers_data || {};
            const currentGroupId = result.current_headers_group;
            
            if (!data[groupId]) {
                reject(new Error(`未找到请求头组: ${groupId}`));
                return;
            }
            
            const headerIndex = data[groupId].findIndex(h => h.id === headerId);
            if (headerIndex === -1) {
                reject(new Error(`未找到请求头: ${headerId}`));
                return;
            }
            
            // 更新请求头
            const header = data[groupId][headerIndex];
            if (name !== undefined) header.name = name.trim();
            if (value !== undefined) header.value = value;
            if (enabled !== undefined) header.enabled = enabled;
            
            chrome.storage.local.set({ global_headers_data: data }, () => {
                // 如果是当前组，立即更新规则
                if (groupId === currentGroupId) {
                    const enabledHeaders = data[groupId]
                        .filter(h => h.enabled && h.name && h.name.trim())
                        .map(h => ({ name: h.name.trim(), value: h.value || '' }));
                    
                    applyGlobalHeaders(enabledHeaders).catch(() => { /* 失败原因已记入 storage，见 get_headers_config 的 lastError */ });
                }
                
                resolve({
                    success: true,
                    header: data[groupId][headerIndex],
                    message: `请求头已更新`
                });
            });
        });
    });
}

// 删除请求头
async function deleteHeader({ groupId, headerId }) {
    return new Promise((resolve, reject) => {
        if (!groupId || !headerId) {
            reject(new Error('请求头组ID和请求头ID不能为空'));
            return;
        }
        
        chrome.storage.local.get(['global_headers_data', 'current_headers_group'], (result) => {
            const data = result.global_headers_data || {};
            const currentGroupId = result.current_headers_group;
            
            if (!data[groupId]) {
                reject(new Error(`未找到请求头组: ${groupId}`));
                return;
            }
            
            const headerIndex = data[groupId].findIndex(h => h.id === headerId);
            if (headerIndex === -1) {
                reject(new Error(`未找到请求头: ${headerId}`));
                return;
            }
            
            const deletedHeader = data[groupId][headerIndex];
            data[groupId].splice(headerIndex, 1);
            
            chrome.storage.local.set({ global_headers_data: data }, () => {
                // 如果是当前组，立即更新规则
                if (groupId === currentGroupId) {
                    const enabledHeaders = data[groupId]
                        .filter(h => h.enabled && h.name && h.name.trim())
                        .map(h => ({ name: h.name.trim(), value: h.value || '' }));
                    
                    applyGlobalHeaders(enabledHeaders).catch(() => { /* 失败原因已记入 storage，见 get_headers_config 的 lastError */ });
                }
                
                resolve({
                    success: true,
                    deletedHeader,
                    message: `请求头 "${deletedHeader.name}" 已删除`
                });
            });
        });
    });
}

// 切换请求头启用状态
async function toggleHeader({ groupId, headerId, enabled }) {
    return updateHeader({ groupId, headerId, enabled });
}

// 批量更新请求头（替换整个组的请求头）
async function batchUpdateHeaders({ groupId, headers }) {
    return new Promise((resolve, reject) => {
        if (!groupId) {
            reject(new Error('请求头组ID不能为空'));
            return;
        }
        if (!Array.isArray(headers)) {
            reject(new Error('headers 必须是数组'));
            return;
        }
        
        chrome.storage.local.get(['global_headers_groups', 'global_headers_data', 'current_headers_group'], (result) => {
            const groups = result.global_headers_groups || [];
            const data = result.global_headers_data || {};
            const currentGroupId = result.current_headers_group;
            
            // 验证组是否存在
            const group = groups.find(g => g.id === groupId);
            if (!group) {
                reject(new Error(`未找到请求头组: ${groupId}`));
                return;
            }
            
            // 替换请求头
            data[groupId] = headers.map((h, index) => ({
                id: h.id || `h_${Date.now()}_${index}`,
                name: (h.name || '').trim(),
                value: h.value || '',
                enabled: h.enabled !== false
            }));
            
            chrome.storage.local.set({ global_headers_data: data }, () => {
                // 如果是当前组，立即更新规则
                if (groupId === currentGroupId) {
                    const enabledHeaders = data[groupId]
                        .filter(h => h.enabled && h.name && h.name.trim())
                        .map(h => ({ name: h.name.trim(), value: h.value || '' }));
                    
                    applyGlobalHeaders(enabledHeaders).catch(() => { /* 失败原因已记入 storage，见 get_headers_config 的 lastError */ });
                }
                
                resolve({
                    success: true,
                    groupId,
                    headersCount: data[groupId].length,
                    message: `请求头组 "${group.name}" 已更新，共 ${data[groupId].length} 个请求头`
                });
            });
        });
    });
}

// ============== 智能场景协调功能 ==============

// 批量启用脚本
async function batchEnableScripts({ scriptIds, enabled = true, autoRefresh = false, tabId, hostname: targetHostname } ) {
    const tab = await requireTab({ tabId, hostname: targetHostname });
    
    const hostname = new URL(tab.url).hostname;
    
    return new Promise((resolve, reject) => {
        // V4.9.38（批 3 审计 S-R4 🔴）：批量启用时同样要读各自的 `<id>_config`
        const cfgKeys = (Array.isArray(scriptIds) ? scriptIds : []).map(id => `${id}_config`);
        chrome.storage.local.get(['antidebug_mode', 'global_scripts', hostname, ...cfgKeys], (result) => {
            const mode = result.antidebug_mode || 'standard';
            let currentScripts;
            let storageKey;
            
            if (mode === 'global') {
                currentScripts = result.global_scripts || [];
                storageKey = 'global_scripts';
            } else {
                currentScripts = result[hostname] || [];
                storageKey = hostname;
            }
            
            const enabledBefore = currentScripts.length;
            
            if (enabled) {
                // 添加脚本（去重）
                for (const scriptId of scriptIds) {
                    if (!currentScripts.includes(scriptId)) {
                        currentScripts.push(scriptId);
                    }
                }
            } else {
                // 移除脚本
                currentScripts = currentScripts.filter(id => !scriptIds.includes(id));
            }
            
            // V4.9.38（批 3 审计 S-R4 🔴）：与 toggleScript 同因——content.js 用 `if (config)` 门控
            // HOOK_CONFIG_READY 与 localStorage 配置同步，批量启用时若不补 config，
            // 这批 config-gated Hook 永不初始化（工具却回 success:true）。
            const writePayload = { [storageKey]: currentScripts };
            if (enabled) {
                for (const sid of (Array.isArray(scriptIds) ? scriptIds : [])) {
                    const k = `${sid}_config`;
                    if (!result[k]) {
                        writePayload[k] = {
                            param: [],
                            keyword_filter_enabled: false,
                            flag: 0,
                            debugger: 0,
                            stack: 0,
                            value: '0'
                        };
                    }
                }
            }
            chrome.storage.local.set(writePayload, async () => {
                // V4.9.30：直接调用并 await registerScripts（原 sendMessage 是死消息——它不投递给
                // 发送者所在上下文；storage.onChanged 兜底又要求 hostname 含点，不含点时不注册却报成功）
                let registration;
                try {
                    await registerScripts(mode === 'global' ? '*' : hostname, currentScripts, mode === 'global');
                    registration = { ok: true };
                } catch (e) {
                    registration = { error: String((e && e.message) || e) };
                }
                
                const result = {
                    success: true,
                    mode,
                    hostname: mode === 'global' ? '*' : hostname,
                    scriptIds,
                    enabled,
                    enabledBefore,
                    enabledAfter: currentScripts.length,
                    currentScripts,
                    registration,
                    message: enabled 
                        ? `已启用 ${scriptIds.length} 个脚本`
                        : `已禁用 ${scriptIds.length} 个脚本`
                };
                
                if (autoRefresh) {
                    // 自动刷新页面
                    chrome.tabs.reload(tab.id, { bypassCache: true }, () => {
                        result.refreshed = true;
                        result.message += '，页面已刷新';
                        resolve(result);
                    });
                } else {
                    result.refreshed = false;
                    result.message += '，刷新页面后生效';
                    resolve(result);
                }
            });
        });
    });
}

// 禁用所有脚本
async function disableAllScripts({ autoRefresh = false, tabId, hostname: targetHostname } = {}) {
    const tab = await requireTab({ tabId, hostname: targetHostname });
    
    const hostname = new URL(tab.url).hostname;
    
    return new Promise((resolve, reject) => {
        chrome.storage.local.get(['antidebug_mode', 'global_scripts', hostname], (result) => {
            const mode = result.antidebug_mode || 'standard';
            let storageKey;
            let previousScripts;
            
            if (mode === 'global') {
                previousScripts = result.global_scripts || [];
                storageKey = 'global_scripts';
            } else {
                previousScripts = result[hostname] || [];
                storageKey = hostname;
            }
            
            // 清空脚本列表
            chrome.storage.local.set({ [storageKey]: [] }, async () => {
                // V4.9.30：直接调用并 await registerScripts（原 sendMessage 是死消息——它不投递给
                // 发送者所在上下文；storage.onChanged 兜底又要求 hostname 含点，不含点时不注册却报成功）
                let registration;
                try {
                    await registerScripts(mode === 'global' ? '*' : hostname, [], mode === 'global');
                    registration = { ok: true };
                } catch (e) {
                    registration = { error: String((e && e.message) || e) };
                }
                
                const resultData = {
                    success: true,
                    mode,
                    hostname: mode === 'global' ? '*' : hostname,
                    previousScripts,
                    registration,
                    disabledCount: previousScripts.length,
                    message: `已禁用 ${previousScripts.length} 个脚本`
                };
                
                if (autoRefresh) {
                    chrome.tabs.reload(tab.id, { bypassCache: true }, () => {
                        resultData.refreshed = true;
                        resultData.message += '，页面已刷新';
                        resolve(resultData);
                    });
                } else {
                    resultData.refreshed = false;
                    resultData.message += '，刷新页面后生效';
                    resolve(resultData);
                }
            });
        });
    });
}

// ============== 导出函数供background.js使用 ==============
// 注意：在Service Worker中，这些函数通过全局作用域访问
self.mcpClient = {
    init: initMCPConnection,
    connect: connectToMCP,
    disconnect: disconnectFromMCP,
    ensureConnected: ensureMCPConnection,
    isConnected: () => isConnected,
    addHookData,
    addNetworkRequest
};

// 初始化
initMCPConnection();
