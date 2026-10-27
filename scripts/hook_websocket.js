// ==UserScript==
// @name         hook_websocket
// @namespace    https://github.com/0xsdeo/AntiDebug_Breaker
// @version      4.9.20
// @description  V4.9.20：二进制帧 base64 上报（`[binary NB b64]` 前缀，扫描前 4096 字节、上报前 2048 字符）+ 帧 seq 序号（异步上报可排序）+ close 补 code/reason；文本帧截断 2048 字符。console 输出与独立链路上报（get_ws_messages 查询）。
// @author       0xsdeo (V4.5 local port by fusheng)
// @match        http://*/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';
    if (window.__adbWSHooked) return; // 防扩展重载后同页重复 eval 双层包装（帧双报）
    window.__adbWSHooked = true;

    const SCRIPT_ID = 'hook_websocket';
    const MAX_FRAME_LEN = 2048; // 单帧截断：防止大帧撑爆缓冲

    function clear_Antidebug(id) {
        localStorage.removeItem("Antidebug_breaker_" + id + "_flag");
    }

    // V4.9.20（审计🟡-6）：帧序号——二进制帧走 FileReader 异步、文本帧同步，上报顺序可能与线上
    // 顺序不一致（"响应看起来先于请求"）。捕获点分配 seq（data.seq 覆盖模板值），消费侧可按 seq 排序。
    let wsSeq = 0;
    function report(kind, data) {
        try {
            const base = { kind: kind, timestamp: Date.now() };
            // 审计复验⚪：仅捕获点未传 seq 时自增（原模板无条件 ++ ——每帧耗 2 个号，"第 N 帧"语义混乱）
            if (!data || data.seq == null) base.seq = ++wsSeq;
            window.postMessage({
                type: 'WS_FRAME_DATA',
                source: 'ws-monitor-script',
                data: Object.assign(base, data)
            }, '*');
        } catch (e) { /* 上报失败不影响 Hook */ }
    }

    // V4.9.20：二进制帧 base64（chobitsu 方式）——原实现直接丢成 '[binary NB]'，protobuf/
    // 自定义协议的 WS 完全盲区（SRC 重点）。binaryType 影响 ev.data 类型：'blob' 给 Blob、
    // 'arraybuffer' 给 ArrayBuffer —— 两条路都要处理。
    function bytesToB64(bytes) {
        try {
            let bin = '';
            for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
            return btoa(bin);
        } catch (e) { return null; }
    }
    // V4.9.20（审计🟡-4）：只扫描前 4096 字节（2048 base64 字符需 1536 字节）——
    // 原实现**整帧**转换后再截断：大帧（WS 传文件/protobuf）逐字符 concat 会卡主线程 100-300ms
    // 且内存峰值 3~5 倍原帧（原始 + ArrayBuffer + Latin-1 串 + b64）
    const MAX_BIN_SCAN = 4096;
    function binToB64(data, cb) {
        // 审计⚪-2：一次性回调——原 catch 无条件兜底可能与已成功的回调二次调用（重复上报）
        let done = false;
        const finish = function (b64, size) {
            if (done) return; done = true;
            try { cb(b64, size); } catch (e) { /* 消费方异常不影响 Hook */ }
        };
        try {
            if (!data) return finish(null, 0);
            // 审计复验·半修1：跨 realm 的 Blob（同源 iframe/worker 传来）instanceof 为 false → toString 判定兜底
            if (typeof Blob !== 'undefined' &&
                (data instanceof Blob || Object.prototype.toString.call(data) === '[object Blob]')) {
                const total = data.size || 0;
                const fr = new FileReader();
                fr.onload = function () {
                    try { finish(bytesToB64(new Uint8Array(fr.result)), total); } catch (e) { finish(null, total); }
                };
                fr.onerror = function () { finish(null, total); };
                // 审计🟡-5 + 复验⚪：FileReader 可能既不 onload 也不 onerror（文档销毁/读取被丢弃）——
                // 超时兜底上报；**独立标记 + 2s**（原与真失败同渲染"无法读取"，文件型 Blob 慢读会被误报失败）
                setTimeout(function () { finish('__TIMEOUT__', total); }, 2000);
                fr.readAsArrayBuffer(data.slice(0, MAX_BIN_SCAN));   // Blob.slice 零拷贝
                return;
            }
            // 审计🟡-5：跨 realm 的 ArrayBuffer（同源 iframe/worker 传来）instanceof 为 false → 用 toString 判定兜底
            if (typeof ArrayBuffer !== 'undefined' &&
                (data instanceof ArrayBuffer || Object.prototype.toString.call(data) === '[object ArrayBuffer]')) {
                return finish(bytesToB64(new Uint8Array(data, 0, Math.min(data.byteLength, MAX_BIN_SCAN))), data.byteLength || 0);
            }
            // 审计🟡-5：ArrayBuffer.isView 跨 realm 安全（替代原 data.buffer 探测——跨 realm TypedArray 无此属性）
            if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView && ArrayBuffer.isView(data)) {
                const off = data.byteOffset || 0;
                const len = Math.min(data.byteLength || 0, MAX_BIN_SCAN);
                return finish(bytesToB64(new Uint8Array(data.buffer, off, len)), data.byteLength || 0);
            }
            finish(null, 0);
        } catch (e) { finish(null, 0); }
    }
    // 字符串帧同步回调；二进制帧异步（Blob 需 FileReader）——payload 统一为上报文本
    function framePayload(data, cb) {
        // 审计复验⚪：字符串路径同样包 try/catch——页面覆盖 console.log 为会抛的函数时，
        // 原直接 cb() 会让异常从 ws.send() 抛给页面（帧已发出，页面可能误判发送失败）
        if (typeof data === 'string') {
            try { cb(data.slice(0, MAX_FRAME_LEN)); } catch (e) { /* 消费方异常不影响 Hook */ }
            return;
        }
        binToB64(data, function (b64, size) {
            const sz = Number.isFinite(size) ? size : '?';   // 审计⚪-1：size 0（空帧）显示 0B 而非 '?'
            // 审计⚪-1：用 b64 === null 判**失败**（空帧 b64='' 是成功——原 !b64 会谎报"无法读取"）
            if (b64 === '__TIMEOUT__') return cb('[binary ' + sz + 'B 读取超时未上报]');
            if (b64 === null) return cb('[binary ' + sz + 'B 无法读取]');
            cb('[binary ' + sz + 'B b64' + (b64.length > MAX_FRAME_LEN ? '（截断）' : '') + '] ' + b64.slice(0, MAX_FRAME_LEN));
        });
    }

    function initHook() {
        let flag = localStorage.getItem("Antidebug_breaker_" + SCRIPT_ID + "_flag");

        const OrigWS = window.WebSocket;
        if (!OrigWS) return;

        function HookedWS(url, protocols) {
            const ws = protocols !== undefined ? new OrigWS(url, protocols) : new OrigWS(url);
            const wsUrl = String(url);

            if (flag === "0") {
                console.log("捕获到 WebSocket 连接：", wsUrl);
                report('open', { url: wsUrl });
            }

            ws.addEventListener('message', function (ev) {
                if (flag !== "0") return;
                const ts = Date.now();
                const seq = ++wsSeq;   // 审计🟡-6：捕获点分配序号（异步上报后仍可排序）
                framePayload(ev.data, function (payload) {
                    console.log("WS消息 [" + wsUrl + "]:", payload);
                    report('frame', { url: wsUrl, direction: 'in', payload: payload, timestamp: ts, seq: seq });
                });
            });

            const origSend = ws.send;
            ws.send = function (data) {
                const ts = Date.now();   // 发送时刻（先记——二进制转换异步）
                const seq = ++wsSeq;     // 审计🟡-6：捕获点分配序号
                const r = origSend.apply(ws, arguments);
                // V4.9.20（审计🟡-4）：上报挪到发送**之后**——原实现 ArrayBuffer/TypedArray 路径的同步
                // 转换会把真实帧发送推迟 100-200ms（观测扰动目标、可能改变被测应用时序）；
                // origSend 抛错时不执行上报（发送失败无需记录）
                if (flag === "0") {
                    framePayload(data, function (payload) {
                        console.log("WS发送 [" + wsUrl + "]:", payload);
                        report('frame', { url: wsUrl, direction: 'out', payload: payload, timestamp: ts, seq: seq });
                    });
                }
                return r;
            };

            ws.addEventListener('close', function (ev) {
                if (flag === "0") report('close', { url: wsUrl, code: ev && ev.code, reason: ev && ev.reason });
            });
            return ws;
        }
        // 保住 instanceof 与静态常量
        HookedWS.prototype = OrigWS.prototype;
        HookedWS.CONNECTING = OrigWS.CONNECTING;
        HookedWS.OPEN = OrigWS.OPEN;
        HookedWS.CLOSING = OrigWS.CLOSING;
        HookedWS.CLOSED = OrigWS.CLOSED;
        try { window.WebSocket = HookedWS; } catch (e) { console.warn('[AntiDebug] WebSocket Hook 失败:', e); return; }
        clear_Antidebug(SCRIPT_ID);
    }

    function setupConfigListener() {
        window.addEventListener('message', function (event) {
            if (event.source !== window ||
                !event.data ||
                event.data.source !== 'antidebug-extension' ||
                event.data.type !== 'HOOK_CONFIG_READY') {
                return;
            }
            const scriptIds = event.data.scriptIds || [];
            if (scriptIds.includes(SCRIPT_ID)) {
                initHook();
            }
        });
    }

    setupConfigListener();
})();
