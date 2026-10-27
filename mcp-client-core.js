/**
 * MCP Client - Chrome扩展与MCP服务器通信模块
 * 
 * 这个模块负责：
 * 1. 连接到MCP服务器的WebSocket
 * 2. 处理来自MCP的命令
 * 3. 收集页面数据并发送给MCP
 */

// ============== 配置 ==============
const MCP_DEFAULT_PORT = 9527;
const RECONNECT_BASE_DELAY = 2000;   // 首次重连延迟（毫秒）
const RECONNECT_MAX_DELAY = 30000;   // 重连延迟上限（毫秒，指数退避封顶）

// ============== 状态 ==============
let ws = null;
let isConnected = false;
let reconnectAttempts = 0;
let reconnectDelay = RECONNECT_BASE_DELAY; // 当前退避延迟
let reconnectTimer = null;            // 重连定时器（去重，防止双重重连）
let mcpEnabled = false;
// SW 唤醒瞬间的初始化状态：storage 回调是异步的，唤醒后 mcpEnabled 仍是 false——
// 实测这个窗口会丢弃"静默后第一批请求"（渗透场景最珍贵的用户操作流量）。
// pending 态默认放行抓取，只有明确 disabled 才丢
let mcpInitState = 'pending';
let mcpPort = MCP_DEFAULT_PORT; // 当前使用的端口
let networkRequests = []; // 存储网络请求
let hookDataBuffer = []; // 存储Hook捕获的数据
let heartbeatInterval = null; // 心跳定时器
let lastPongTime = 0; // 最后收到 pong 的时间
let pingSentAt = 0;   // 最近一次发送 PING 的时间
let awaitingPong = false; // 是否正在等待 PONG 响应
let missedPongs = 0;      // 连续 PONG 超时次数（达到 PONG_MAX_MISSED 才强断）
let commandInFlight = 0;  // 正在处理的 MCP 命令数（心跳放宽判据——bug-hunt S1：原实现引用 pendingRequests 是 server 端概念，扩展侧不存在，每 5s 抛 ReferenceError）
const HEARTBEAT_INTERVAL = 5000;  // 心跳间隔 5 秒
const PONG_TIMEOUT = 20000;       // 等待 PONG 超时 20 秒（server 单线程执行耗时命令时 PONG 会排队，阈值过低会误杀健康连接）
const PONG_MAX_MISSED = 2;        // 连续超时次数达到该值才判定死连接（进一步防误杀）
const KEEPALIVE_ALARM = 'ad_mcp_keepalive'; // SW 保活 alarm 名称

// 获取当前MCP WebSocket URL
function getMCPWsUrl() {
    return `ws://localhost:${mcpPort}`;
}

// ============== WebSocket 连接管理 ==============

// V4.9.6：HTTP 服务按需启动——MCP 开关打开 / SW 初始化时，通过 Native Messaging 叫醒启动器：
// 服务没跑则自动拉起（启动器调用后即退、不常驻；不开机自启——"要干活时打开插件开关即自动启动"）。
// host 名 com.adb.http_launcher（安装：install-native-launcher.bat 注册到 HKCU）。
// V4.9.6.1（审计 L-1）：防抖落 storage.session——SW 冷启动内存归零，纯内存防抖在 SW 维度无效。
function ensureHttpService() {
    try {
        if (!chrome.runtime || typeof chrome.runtime.sendNativeMessage !== 'function') return;
        const now = Date.now();
        chrome.storage.session.get(['adb_last_ensure'], (r) => {
            const last = (r && r.adb_last_ensure) || 0;
            if (now - last < 8000) return; // 防抖：8 秒内不重复叫醒（重连风暴场景）
            chrome.storage.session.set({ adb_last_ensure: now });
            chrome.runtime.sendNativeMessage('com.adb.http_launcher', { cmd: 'ensure', ts: now }, (resp) => {
                if (chrome.runtime.lastError) {
                    // host 未安装/被拒绝——静默降级，不影响既有连接流程
                    const msg = String(chrome.runtime.lastError.message || '');
                    const hint = /forbidden|not allowed|Access/i.test(msg)
                        ? '扩展 ID 与 allowed_origins 不匹配（目录迁移后扩展 ID 变化？更新 native-messaging-host.json 并重跑安装脚本）'
                        : '未安装？（运行 install-native-launcher.bat）';
                    console.warn('[MCP Client] 服务启动器不可用：' + hint + ' | 原始错误: ' + msg);
                    return;
                }
                // V4.9.6.1（审计 M-2）：完整输出（含 error/note），失败态用 warn 突出
                const st = resp && resp.status;
                if (st === 'start-failed' || st === 'started-unconfirmed' || st === 'start-cooldown') {
                    console.warn('[MCP Client] 服务启动异常:', JSON.stringify(resp));
                } else {
                    console.log('[MCP Client] 服务启动器响应:', st);
                }
            });
        });
    } catch (e) {
        console.warn('[MCP Client] ensureHttpService 异常:', e && e.message);
    }
}

// 初始化MCP连接（SW 启动 / 被事件唤醒重新加载脚本时调用）
function initMCPConnection() {
    // 检查是否启用了MCP，并获取端口配置
    chrome.storage.local.get(['mcp_enabled', 'mcp_port'], (result) => {
        mcpEnabled = result.mcp_enabled === true;
        mcpPort = result.mcp_port || MCP_DEFAULT_PORT;
        mcpInitState = mcpEnabled ? 'enabled' : 'disabled';

        console.log('[MCP Client] 配置端口:', mcpPort);

        // 以下动作依赖 mcpEnabled 的真实值，必须在 storage 回调内执行
        // （SW 冷启动时全局初始值为 false，回调外调用会误判）
        if (mcpEnabled) {
            ensureHttpService(); // V4.9.6：叫醒 HTTP 服务（没跑就拉起）
            connectToMCP();
        }

        // 注册 SW 保活 alarm（仅启用时创建；关闭时清除，让 SW 正常休眠）
        setupKeepAliveAlarm();

        // 恢复上一轮 SW 生命周期遗留的抓包/hook 缓冲（仅启用时有意义）
        if (mcpEnabled) {
            restoreBuffersFromSession();
        }
    });

    // 监听 MCP 开关/端口变化，实时响应（popup 切换开关立即生效）
    setupStorageWatcher();
}

// ============== SW 保活与存储监听 ==============

// 每 30 秒唤醒一次 SW，确保 WebSocket 始终存活
// 解决 MV3 service worker 空闲 30 秒被浏览器挂起导致 MCP 断连的问题。
// 性能设计：仅在 mcpEnabled 时创建——MCP 关闭时 SW 可正常休眠（否则每天 2880 次无意义唤醒，
// 每次唤醒都执行全量脚本解析 + 启动链）。WS 已连接时 5s 心跳本身就会重置 SW 空闲计时器，
// alarm 仅作"SW 意外死亡后的重连兜底"。
// onAlarm 监听器在顶层注册一次（MV3 要求；注册在 storage 回调内会异步化，可能错过唤醒事件且重复注册）
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === KEEPALIVE_ALARM) {
        ensureMCPConnection();
    }
});

function setupKeepAliveAlarm() {
    try {
        if (!mcpEnabled) {
            chrome.alarms.clear(KEEPALIVE_ALARM, () => {});
            return;
        }
        chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
        console.log('[MCP Client] SW 保活 alarm 已启动（每30秒）');
    } catch (e) {
        console.warn('[MCP Client] 启动保活 alarm 失败:', e);
    }
}

// 确保 MCP 连接存活（alarm 唤醒时调用）
function ensureMCPConnection() {
    if (!mcpEnabled) return;

    const alive = ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING);
    if (!alive) {
        // 连接不存在或已断开：立即重连（清掉旧的退避定时器）
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        reconnectDelay = RECONNECT_BASE_DELAY;
        connectToMCP();
    } else if (ws.readyState === WebSocket.OPEN) {
        // 连接仍在：主动 ping 确认（同时产生出入站流量，协助 SW 保活）
        try {
            ws.send(JSON.stringify({ type: 'PING', timestamp: Date.now() }));
        } catch (e) { /* 发送失败由 onclose 处理 */ }
    }
}

// 监听 mcp_enabled / mcp_port 变化：popup 里切换开关立即生效
function setupStorageWatcher() {
    chrome.storage.onChanged.addListener((changes, namespace) => {
        if (namespace !== 'local') return;

        // MCP 开关变化
        if (changes.mcp_enabled) {
            mcpEnabled = changes.mcp_enabled.newValue === true;
            mcpInitState = mcpEnabled ? 'enabled' : 'disabled';
            console.log('[MCP Client] MCP 开关变化:', mcpEnabled);

            if (mcpEnabled) {
                ensureHttpService(); // V4.9.6：打开 MCP 开关时叫醒 HTTP 服务（重启电脑后的主触发点）
                reconnectAttempts = 0;
                reconnectDelay = RECONNECT_BASE_DELAY;
                connectToMCP();
            } else {
                disconnectFromMCP();
            }
            // 同步保活 alarm 生命周期（关闭时清除让 SW 休眠，开启时重建兜底重连）
            setupKeepAliveAlarm();
        }

        // 端口变化
        if (changes.mcp_port && changes.mcp_port.newValue !== mcpPort) {
            mcpPort = changes.mcp_port.newValue || MCP_DEFAULT_PORT;
            console.log('[MCP Client] MCP 端口变化:', mcpPort);
            if (mcpEnabled) {
                // 断开旧连接并立即用新端口连接
                if (reconnectTimer) {
                    clearTimeout(reconnectTimer);
                    reconnectTimer = null;
                }
                disconnectFromMCP();
                reconnectAttempts = 0;
                reconnectDelay = RECONNECT_BASE_DELAY;
                connectToMCP();
            }
        }

        // 脚本启用状态变化（global_scripts 或任意 hostname 键）→ 向 server 推送最新脚本清单
        if (changes.global_scripts || Object.keys(changes).some(k => k.includes('.'))) {
            if (isConnected) {
                getEnabledScripts().then(scripts => {
                    sendToMCP('SCRIPTS_UPDATED', scripts);
                });
            }
        }
    });
}

// ============== 缓冲区持久化（storage.session）==============
// MV3 SW 被浏览器休眠/重启后内存缓冲清零，server 重启窗口期抓到的包和 hook 命中会永久丢失。
// 这里把 networkRequests / hookDataBuffer 镜像到 storage.session（SW 关闭仍保留，浏览器重启才清），
// SW 冷启动时恢复，保证 GET_NETWORK_REQUESTS / GET_HOOK_DATA 跨 SW 生命周期可读。
const SESSION_BUF_KEYS = { NET: 'adb_buf_network', HOOK: 'adb_buf_hook' };
let bufferPersistTimer = null;

// V4.9.21（性能优化 1.2）：**分层落盘**——原实现每次把 networkRequests.slice(-1000) 全量落盘，
// 单条含 15-20 个完整头（Cookie 全串）≈1.5-2KB → **每次写 ~2-3MB JSON 序列化 + IPC**，
// 抓包活跃时每 500ms 一次（持续数 MB/s 的序列化压在 SW 主线程上），且逼近 storage.session 10MB 配额。
// 分层后：最近 PERSIST_FULL_NET 条**完整**（含头——SW 回收后最可能被查看的部分），
// 更老的只存元数据并打 headersOmitted 标记（禁静默降级：消费方能看见"头未落盘"）。
// 体积 ≈ 100×2KB + 900×0.2KB ≈ 380KB（降 ~85%），**恢复能力实质不降**。
const PERSIST_META_NET = 1000;    // 落盘网络记录总条数
const PERSIST_FULL_NET = 100;     // 其中最近 N 条保留完整头
const PERSIST_HOOK_MAX = 200;     // hook 落盘条数
const PERSIST_HOOK_CLIP = 16384;  // hook 落盘副本单条截断（内存缓冲不受影响，截断带显式标记）

// 元数据投影：保留恢复后仍被消费的字段，剥掉体积大头（requestHeaders/responseHeaders）
function toPersistMeta(r) {
    // V4.9.21（审计🟡-2）：非对象条目守卫——原实现直接取 r.url，一条 null/undefined 就让
    // buildPersistPayload 同步抛错、被空 catch 吞掉 → **落盘整体静默停摆**（此后每次触发同样失败，
    // 要等坏记录被挤出 1000 条缓冲才自愈）。审计实测：[null, ...150 条] → TypeError（100 条以内不复现，潜伏型）
    if (!r || typeof r !== 'object') return { headersOmitted: true };
    return {
        url: r.url, method: r.method, type: r.type, tabId: r.tabId,
        requestId: r.requestId, timestamp: r.timestamp, initiator: r.initiator,
        statusCode: r.statusCode, completed: r.completed, error: r.error,
        ...(r.redirects ? { redirects: r.redirects } : {}),
        ...(r.redirected ? { redirected: r.redirected } : {}),
        headersOmitted: true
    };
}

function buildPersistPayload() {
    const netTail = networkRequests.slice(-PERSIST_META_NET);
    const fullFrom = Math.max(0, netTail.length - PERSIST_FULL_NET);
    const net = netTail.map((r, i) => (i >= fullFrom ? r : toPersistMeta(r)));
    const hook = hookDataBuffer.slice(-PERSIST_HOOK_MAX).map((h) => {
        if (h && typeof h.message === 'string' && h.message.length > PERSIST_HOOK_CLIP) {
            // V4.9.21（复验 B-1）：幂等守卫——SW 重启会把**已截断的落盘副本**回填进缓冲，若不设防，
            // 此后第一次活动就重跑本函数、对回填副本（16416 > 16384）再裁一刀，把
            // "落盘前 65547 字符"改写成副本自身长度（证据降解；对齐 truncForReturn:1135 的幂等范式）。
            // `[落盘截断:` 是落盘副本专属标记，内存侧消息不可能带 → 命中即可安全跳过
            if (h.message.indexOf('[落盘截断:') !== -1) return h;
            // V4.9.21（审计🟡-3）：内存侧截断标记（`[ADB 截断: 原始 N 字符]`）写在**尾部**，而落盘裁剪
            // 取**首部**——直接切会把"原始长度"这一证据切走（与 V4.9.17 验收🟡1 被修掉的缺陷同类）。
            // 此处先摘出尾部标记追回，并让落盘标记自带截断前长度
            const tailMark = /\[ADB 截断[^\]]*\]/.exec(h.message.slice(-120));
            return { ...h, message: h.message.slice(0, PERSIST_HOOK_CLIP) + '...[落盘截断: 落盘前 ' + h.message.length + ' 字符]' + (tailMark ? ' ' + tailMark[0] : '') };
        }
        return h;
    });
    return { [SESSION_BUF_KEYS.NET]: net, [SESSION_BUF_KEYS.HOOK]: hook };
}

// 防抖落盘：网络请求/hook 命中可能高频触发，500ms 合并一次写入
function schedulePersistBuffers() {
    if (bufferPersistTimer) return;
    bufferPersistTimer = setTimeout(() => {
        bufferPersistTimer = null;
        try {
            chrome.storage.session.set(buildPersistPayload()).catch((e) => {
                // 配额超限等异步失败：仅告警不中断，降级为纯内存模式
                console.warn('[MCP Client] 缓冲落盘失败:', e);
            });
        } catch (e) {
            // storage.session 不可用时降级为纯内存模式。
            // V4.9.21（审计🟡-2）：原为空 catch——构建抛错会让落盘**静默整体停摆**且无迹可查；
            // 与异步失败路径（上方 console.warn）对齐，至少留一条可诊断的日志
            console.warn('[MCP Client] 缓冲落盘构建失败（本轮降级为纯内存）:', e);
        }
    }, 500);
}

// SW 冷启动恢复：仅当内存缓冲为空时回填，避免覆盖本轮已收集的数据
function restoreBuffersFromSession() {
    try {
        chrome.storage.session.get([SESSION_BUF_KEYS.NET, SESSION_BUF_KEYS.HOOK], (result) => {
            if (chrome.runtime.lastError) return;
            const net = result[SESSION_BUF_KEYS.NET];
            const hook = result[SESSION_BUF_KEYS.HOOK];
            if (Array.isArray(net) && net.length > 0 && networkRequests.length === 0) {
                networkRequests = net;
                console.log(`[MCP Client] 已从 session 恢复网络请求缓冲 ${net.length} 条`);
            }
            if (Array.isArray(hook) && hook.length > 0 && hookDataBuffer.length === 0) {
                hookDataBuffer = hook;
                console.log(`[MCP Client] 已从 session 恢复 Hook 数据缓冲 ${hook.length} 条`);
            }
        });
    } catch (e) { /* 忽略 */ }
}

// 直接更新全局请求头 DNR 规则
// ⚠️ 本脚本与 background.js **同处一个 SW 全局作用域**，可直接调用那边的
// updateGlobalHeaders / updateHeadersBadge。**不要改用 chrome.runtime.sendMessage 通知**
// ——它不投递给发送者所在上下文，消息永远无人接收、操作静默失效。
// ⚠️ 必须是 async 且**失败要落盘**：原实现 fire-and-forget，DNR 拒绝规则时
// （非法头名、超配额）工具仍回报"已启用 N 个请求头"——用户/AI 会基于错误前提去测试。
// 历史与取舍（为何不改成 8 个调用点全异步等待）→ INTERNALS.md「请求头 DNR 更新」。
async function applyGlobalHeaders(headers) {
    try {
        // V4.9.24：**作用域透传**——从当前组读 `targetDomains` 交给 DNR 的 `requestDomains`。
        // 以前这里恒传 `undefined` → 每个组都是"把 header（可能含 Authorization/Cookie）发给
        // **所有**站点"。底层第二参 V4.9.22 就修通了，只差这一处入参。
        // 老配置没有该字段 → 自动视为全局，**零数据迁移**、行为不变。
        let targetDomains;
        try {
            const st = await chrome.storage.local.get(['current_headers_group', 'global_headers_groups']);
            const cur = st.current_headers_group;
            const grp = (st.global_headers_groups || []).find(g => g && g.id === cur);
            if (grp && Array.isArray(grp.targetDomains) && grp.targetDomains.length > 0) {
                targetDomains = grp.targetDomains;
            }
        } catch (e) { /* 读取失败按全局处理——与改动前行为一致，不会静默收窄 */ }

        await updateGlobalHeaders(headers, targetDomains);
        updateHeadersBadge(headers ? headers.length : 0);
        // 成功后清掉上一次的失败标记
        try { await chrome.storage.local.set({ global_headers_last_error: null }); } catch (e) { /* 忽略 */ }
        return {
            success: true,
            // 回显生效作用域（调用方可据此如实汇报，而不是让用户以为还在全站生效）
            scope: (Array.isArray(targetDomains) && targetDomains.length > 0) ? targetDomains : 'all-sites'
        };
    } catch (e) {
        const msg = String((e && e.message) || e);
        try {
            await chrome.storage.local.set({
                global_headers_last_error: { at: Date.now(), count: headers ? headers.length : 0, message: msg }
            });
        } catch (e2) { /* 忽略 */ }
        console.error('[MCP Client] 更新全局请求头失败:', msg);
        throw e;
    }
}

// 连接到MCP服务器
async function connectToMCP() {
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
        return;
    }

    // 未启用时不连接
    if (!mcpEnabled) {
        return;
    }

    // V4.9.15：WS token（可选启用）——扩展 onInstalled 生成安装级随机 token 存 chrome.storage.local
    // （adb_ws_token），连接 URL 附带 ?token=；server 端设 ADB_WS_TOKEN 后校验（两端都配置才生效，
    // 与 ADB_HTTP_TOKEN 同模式）。防本机进程伪造 Origin 抢占 browserClient 位。
    const wsUrl0 = getMCPWsUrl();
    console.log('[MCP Client] 正在连接到MCP服务器:', wsUrl0);

    try {
        let wsUrl = wsUrl0;
        try {
            const stored = await new Promise((res) => chrome.storage.local.get(['adb_ws_token'], (r) => res(r)));
            const token = stored && stored.adb_ws_token;
            if (token) wsUrl = wsUrl0 + '?token=' + encodeURIComponent(token);
        } catch (e) { /* storage 读取失败按无 token 连接 */ }
        ws = new WebSocket(wsUrl);
        const thisWs = ws; // 捕获本次连接的 socket 引用：事件回调里据此判断是否"当前连接"

        ws.onopen = () => {
            console.log('[MCP Client] 已连接到MCP服务器');
            isConnected = true;
            reconnectAttempts = 0;
            reconnectDelay = RECONNECT_BASE_DELAY; // 连接成功，重置退避
            lastPongTime = Date.now();
            awaitingPong = false;
            missedPongs = 0;

            // 启动心跳检测
            startHeartbeat();

            // 发送初始页面信息
            sendCurrentPageInfo();
        };

        ws.onmessage = (event) => {
            // 迟到消息守卫：旧 socket 的残留消息不处理，防止响应错发到新连接
            if (ws !== thisWs) return;
            try {
                const message = JSON.parse(event.data);
                // 处理心跳响应
                if (message.type === 'PONG') {
                    lastPongTime = Date.now();
                    awaitingPong = false;
                    missedPongs = 0;
                    return;
                }
                handleMCPMessage(message);
            } catch (e) {
                console.error('[MCP Client] 解析消息失败:', e);
            }
        };

        ws.onclose = () => {
            // 迟到 close 守卫：popup 改端口等场景会先 disconnect 再新建连接，
            // 旧 socket 的 onclose 异步到达时全局 ws 已指向新连接，此时
            // 若仍执行 handleDisconnect 会把新建连接置空并关闭（靠重连定时器才自愈）
            if (ws !== thisWs) return;
            console.log('[MCP Client] 与MCP服务器断开连接');
            handleDisconnect();
            ensureHttpService(); // V4.9.6：连接断开时叫醒服务（覆盖"服务中途被杀"场景；防抖 8s）
            scheduleReconnect(); // 无限重连
        };

        ws.onerror = (error) => {
            console.error('[MCP Client] WebSocket错误:', error);
            // 只记录日志，等待 onclose 统一处理重连（避免双重重连）
        };
    } catch (e) {
        console.error('[MCP Client] 创建WebSocket失败:', e);
        handleDisconnect();
        ensureHttpService(); // V4.9.6：服务没跑时创建连接必失败——叫醒启动器拉起服务
        scheduleReconnect();
    }
}

// 调度重连（指数退避，无限重试，定时器去重）
function scheduleReconnect() {
    if (reconnectTimer || !mcpEnabled) {
        return;
    }

    reconnectAttempts++;
    const delay = reconnectDelay;
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_DELAY);

    console.log(`[MCP Client] ${delay/1000}秒后重连 (第${reconnectAttempts}次)`);
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectToMCP();
    }, delay);
}

// 处理断开连接
function handleDisconnect() {
    isConnected = false;
    stopHeartbeat();
    awaitingPong = false;
    missedPongs = 0;

    const oldWs = ws;
    ws = null;
    // 确保旧 socket 被关闭，释放资源
    if (oldWs) {
        try {
            oldWs.close();
        } catch (e) { /* 忽略 */ }
    }
}

// 启动心跳检测
function startHeartbeat() {
    stopHeartbeat(); // 先清除旧的

    heartbeatInterval = setInterval(() => {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            console.log('[MCP Client] 心跳检测：连接已断开');
            handleDisconnect();
            scheduleReconnect();
            return;
        }

        // 上次 PING 还没收到 PONG 且已超时：累计未响应次数，连续超 PONG_MAX_MISSED 次才判定死连接
        // （server 单线程执行耗时命令时 PONG 排队延迟属正常现象，单次超时不代表连接已死）
        if (awaitingPong && Date.now() - pingSentAt > PONG_TIMEOUT) {
            // 有命令在飞时放宽——server 单线程执行长命令（如 nuxt_payload_probe 串行 45s+）
            // 期间 PONG 排队属正常，不计 missedPongs（避免命令完成但响应丢失）。
            // bug-hunt S1 修复（2026-10-13）：原实现引用 pendingRequests（server 端概念，扩展侧不存在）
            // → 每 5s 抛 ReferenceError、死连接判定失效、PING 不再发出。改判扩展侧的在飞命令计数
            if (commandInFlight > 0) {
                return;
            }
            missedPongs++;
            if (missedPongs >= PONG_MAX_MISSED) {
                console.log(`[MCP Client] PONG 连续 ${missedPongs} 次超时，判定连接已断开，强制重连`);
                handleDisconnect();
                scheduleReconnect();
                return;
            }
            console.warn(`[MCP Client] PONG 第 ${missedPongs} 次超时，暂不断开（容错 ${PONG_MAX_MISSED} 次）`);
        }

        // 发送心跳 PING
        try {
            ws.send(JSON.stringify({ type: 'PING', timestamp: Date.now() }));
            pingSentAt = Date.now();
            awaitingPong = true;
        } catch (e) {
            console.error('[MCP Client] 发送心跳失败:', e);
            handleDisconnect();
            scheduleReconnect();
        }
    }, HEARTBEAT_INTERVAL);
}

// 停止心跳检测
function stopHeartbeat() {
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
    }
}

// 主动断开MCP连接（用户关闭开关时调用）
function disconnectFromMCP() {
    stopHeartbeat();

    // 取消待执行的重连定时器
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    if (ws) {
        try {
            ws.close();
        } catch (e) { /* 忽略 */ }
        ws = null;
    }
    isConnected = false;
    awaitingPong = false;
    missedPongs = 0;
}

// 发送消息到MCP服务器
function sendToMCP(type, data, requestId = null) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.warn('[MCP Client] 未连接到MCP服务器');
        return false;
    }

    try {
        ws.send(JSON.stringify({
            type,
            requestId,
            data
        }));
        return true;
    } catch (e) {
        console.error('[MCP Client] 发送消息失败:', e);
        return false;
    }
}

// 发送命令响应（单帧协议：{type:'RESPONSE', requestId, data|error}）
// server 端按 requestId 匹配挂起请求：带 error 字段则 reject，否则 resolve(data)
function sendResponse(requestId, data, error = null) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        // 命令执行期间连接断开：响应无法送达。
        // server 检测到断开会 rejectAllPending，这里不再发送避免抛异常
        console.warn(`[MCP Client] 响应无法送达（连接已断开）requestId=${requestId}`);
        return;
    }
    try {
        const frame = error
            ? { type: 'RESPONSE', requestId, error: error.message || String(error) }
            : { type: 'RESPONSE', requestId, data };
        ws.send(JSON.stringify(frame));
    } catch (e) {
        console.error(`[MCP Client] 发送响应失败 requestId=${requestId}:`, e);
    }
}

// ============== 处理MCP命令 ==============

async function handleMCPMessage(message) {
    const { type, requestId, data } = message;
    commandInFlight++;   // bug-hunt S1：心跳放宽判据（finally 保证配对递减）
    try {
        let result;
        
        switch (type) {
            case 'GET_PAGE_INFO':
                result = await getPageInfo(data);
                break;
                
            case 'GET_NETWORK_REQUESTS':
                result = await getNetworkRequests(data);
                break;

            case 'GET_NETWORK_REQUEST_DETAIL':   // V4.9.18（批次2）：单条全量（配合精简列表使用）
                result = await getNetworkRequestDetail(data || {});
                break;
                
            case 'GET_VUE_ROUTER_DATA':
                result = await getVueRouterData(data);
                break;

            case 'GET_STORE_DUMP':
                result = await getStoreDump(data || {});
                break;

            case 'DEEP_LINK_PROBE':
                result = await deepLinkProbe(data);
                break;

            case 'GET_WS_FRAMES':
                result = await getWSFrames(data || {});
                break;

            case 'NUXT_PAYLOAD_PROBE':
                result = await nuxtPayloadProbe(data);
                break;

            // ===== V4.9.11：CDP 断点调试（Debugger 域）=====
            case 'DEBUG_CONTROL':
                result = await debugControl(data);
                break;

            case 'GET_DEBUG_STATE':
                result = await getDebugState(data || {});
                break;

            case 'ANON_FETCH':
                result = await anonFetch(data);
                break;

            case 'GET_HOOK_DATA':
                result = await getHookData(data);
                break;
                
            case 'GET_ENABLED_SCRIPTS':
                result = await getEnabledScripts(data || {});
                break;
                
            case 'TOGGLE_SCRIPT':
                result = await toggleScript(data);
                break;
                
            case 'NAVIGATE_TO':
                result = await navigateTo(data);
                break;
                
            case 'GET_COOKIES':
                result = await getCookies(data);
                break;
                
            case 'GET_LOCAL_STORAGE':
                result = await getLocalStorage(data);
                break;
                
            case 'GET_SESSION_STORAGE':
                result = await getSessionStorage(data);
                break;
                
            case 'EXECUTE_SCRIPT':
                result = await executeScript(data);
                break;
                
            case 'GET_DOM_INFO':
                result = await getDOMInfo(data);
                break;
                
            case 'CONFIGURE_HOOK':
                result = await configureHook(data);
                break;
                
            case 'LIST_AVAILABLE_SCRIPTS':
                result = await listAvailableScripts(data);
                break;
                
            case 'REFRESH_PAGE':
                result = await refreshPage(data);
                break;
            
            // ===== 新增：浏览器控制功能 =====
            case 'TAKE_SCREENSHOT':
                result = await takeScreenshot(data);
                break;
                
            case 'CLICK_ELEMENT':
                result = await clickElement(data);
                break;
                
            case 'FILL_INPUT':
                result = await fillInput(data);
                break;
                
            case 'PRESS_KEY':
                result = await pressKey(data);
                break;
                
            case 'GET_CONSOLE_MESSAGES':
                result = await getConsoleMessages(data);
                break;
                
            case 'SCROLL_PAGE':
                result = await scrollPage(data);
                break;
                
            case 'WAIT_FOR_SELECTOR':
                result = await waitForSelector(data);
                break;

            // ===== CDP 真实交互（isTrusted=true）=====
            case 'GET_SEMANTIC_DOM':
                result = await getSemanticDom(data);
                break;

            case 'REAL_CLICK':
                result = await realClick(data);
                break;

            case 'REAL_TYPE':
                result = await realType(data);
                break;

            case 'REAL_KEY':
                result = await realKey(data);
                break;

            case 'REAL_HOVER':
                result = await realHover(data);
                break;

            // V4.9.39：鼠标级拖拽（滑块验证码 / rc-slider / 拖拽排序）
            case 'REAL_DRAG':
                result = await realDrag(data);
                break;

            case 'MOUSE_CONTROL':
                result = await mouseControl(data);
                break;

            // V4.9.39：新建标签页（多标签并行测试 / 拖拽类验证需要干净页面）
            case 'NEW_TAB':
                result = await newTab(data);
                break;

            // V4.9.41：工具面对齐 chrome-devtools —— 标签管理 / 文件上传 / 环境模拟 / 页面 console 全量
            case 'TAB_MANAGE':
                result = await tabManage(data);
                break;

            case 'UPLOAD_FILE':
                result = await uploadFile(data);
                break;

            case 'EMULATE':
                result = await emulate(data);
                break;

            case 'CONSOLE_LOG':
                result = await consoleLog(data);
                break;

            case 'HANDLE_DIALOG':
                result = await handleDialog(data);
                break;

            case 'TAKE_A11Y_SNAPSHOT':
                result = await takeA11ySnapshot(data);
                break;

            case 'RELOAD_EXTENSION':
                result = await reloadExtension();
                break;
                
            case 'GET_ELEMENT_INFO':
                result = await getElementInfo(data);
                break;
            
            // ===== 新增：加密分析命令 =====
            case 'ENABLE_ENCRYPTION_HOOKS':
                result = await enableEncryptionHooks(data || {});
                break;
                
            case 'INJECT_ENCRYPTION_CAPTURE':
                result = await injectEncryptionCapture(data || {});
                break;
                
            case 'GET_CAPTURED_ENCRYPTION':
                result = await getCapturedEncryption(data || {});
                break;
                
            case 'ANALYZE_PAGE_ENCRYPTION':
                result = await analyzePageEncryption(data || {});
                break;
                
            case 'AUTO_LOGIN_AND_CAPTURE':
                result = await autoLoginAndCapture(data);
                break;
                
            case 'DECRYPT_RSA':
                result = await decryptRSA(data);
                break;
                

            // ===== V3.1：密码学能力注册表 + 签名重放 + 响应解密 =====
            case 'GET_CRYPTO_REGISTRY':
                result = await getCryptoRegistry(data || {});
                break;

            case 'SIGN_PAYLOAD':
                result = await signPayload(data);
                break;

            case 'GET_DECRYPTED_RESPONSES':
                result = await getDecryptedResponses(data);
                break;

            // ===== V3.1：路由→API 关联图谱 =====
            case 'GET_JS_CHUNKS':
                result = await getJSChunks(data);
                break;

            // ===== V4.8：路由数组 Hook 替换（动态路由攻击面自动化） =====
            case 'HOOK_ROUTE_ARRAY':
                result = await hookRouteArray(data);
                break;

            // ===== 智能化功能命令 =====
            case 'DETECT_ANTI_DEBUG':
                result = await detectAntiDebug(data || {});
                break;
                
            case 'AUTO_BYPASS_ANTI_DEBUG':
                // V4.9.26（派发跳漏传，实测抓出）：原为 `autoBypassAntiDebug()`——**data 整个没传**，
                // 于是工具层传的 tab_id/hostname 在**派发这一跳**就被丢掉，一路回退到活动标签页。
                // 实测表现：传 tab_id=999999999 不但没报"标签页不存在"，反而在**活动标签**（用户的
                // 真实目标）上检测并启用了绕过脚本。同族缺陷里最难发现的一处：前面的链路全是通的。
                result = await autoBypassAntiDebug(data || {});
                break;
                
            case 'ANALYZE_API_SIGNATURE':
                result = await analyzeAPISignature(data || {});
                break;
                
            case 'EXTRACT_VUE_DATA':
                result = await extractVueData(data);
                break;
                
            case 'EXTRACT_REACT_DATA':
                result = await extractReactData(data);
                break;
                
            case 'ANALYZE_AUTHENTICATION':
                result = await analyzeAuthentication(data || {});
                break;
                
            case 'AUTO_FILL_FORM':
                result = await autoFillForm(data);
                break;
                
                
                
            case 'EXTRACT_PAGE_DATA':
                result = await extractPageData(data);
                break;
            
            // ===== Burp 格式请求 =====
                
            case 'GET_NETWORK_REQUESTS_BURP':
                result = await getNetworkRequestsBurp(data);
                break;
            
            // ===== 敏感数据检测功能 =====
            case 'GET_NETWORK_REQUESTS_WITH_BODY':
                result = await getNetworkRequestsWithBody(data);
                break;
                
            case 'START_SENSITIVE_MONITOR':
                result = await startSensitiveMonitor(data);
                break;
                
            case 'GET_SENSITIVE_ALERTS':
                result = await getSensitiveAlerts(data);
                break;
            
            // ===== 请求头管理功能 =====
            case 'GET_HEADERS_CONFIG':
                result = await getHeadersConfig();
                break;
                
            case 'CREATE_HEADER_GROUP':
                result = await createHeaderGroup(data);
                break;
                
            case 'DELETE_HEADER_GROUP':
                result = await deleteHeaderGroup(data);
                break;
                
            case 'SWITCH_HEADER_GROUP':
                result = await switchHeaderGroup(data);
                break;
                
            case 'ADD_HEADER':
                result = await addHeader(data);
                break;
                
            case 'UPDATE_HEADER':
                result = await updateHeader(data);
                break;
                
            case 'DELETE_HEADER':
                result = await deleteHeader(data);
                break;
                
            case 'TOGGLE_HEADER':
                result = await toggleHeader(data);
                break;
                
            case 'BATCH_UPDATE_HEADERS':
                result = await batchUpdateHeaders(data);
                break;
            
            // ===== 智能场景协调功能 =====
            case 'BATCH_ENABLE_SCRIPTS':
                result = await batchEnableScripts(data);
                break;
                
            case 'DISABLE_ALL_SCRIPTS':
                result = await disableAllScripts(data);
                break;
                
            default:
                throw new Error(`未知命令: ${type}`);
        }
        
        sendResponse(requestId, result);
    } catch (error) {
        console.error('[MCP Client] 处理命令失败:', error);
        sendResponse(requestId, null, error);
    } finally {
        commandInFlight--;   // bug-hunt S1：与入口 ++ 配对（所有返回路径含 throw 都被覆盖）
    }
}
