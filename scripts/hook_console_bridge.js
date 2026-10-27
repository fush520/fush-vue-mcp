// ==UserScript==
// @name         hook_console_bridge (Hook 数据 → MCP 桥)
// @namespace    https://github.com/0xsdeo/AntiDebug_Breaker
// @version      2026-08-27
// @description  劫持 console 输出并把 Hook 相关日志转发给 MCP（使 get_hook_data 工具可用）
// @author       0xsdeo / fusheng
// @run-at       document-start
// @match        *
// @grant        none
// ==/UserScript==

// Hook 数据桥：把页面内 Hook 脚本的 console 输出转发到扩展 → MCP get_hook_data
// 仅转发含 Hook/加密关键词的日志，避免噪音
(function () {
    'use strict';

    const LOCK_KEY = '__HOOK_CONSOLE_BRIDGE__';
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

    // 只转发含这些关键词的日志（Hook 脚本输出特征）
    // V4.9.38（批 3 审计 S-R2 🔴）：**必须加 i 标志**——原正则大小写敏感，而 hook_xhr_open /
    // hook_xhr_setRequestHeader 的日志里写的是小写 "xhr"，正则里却是大写 "XHR"；同理
    // "请求头设置" 没有任何关键词能命中。实测这两个最常用 XHR Hook 的输出 4/4 条全 DROP，
    // 永远进不了 MCP → AI 读成"目标站未发生 XHR"。加 i 后统一大小写；并补 xhr/请求头/响应头等词。
    const HOOK_KEYWORD = /(加密|解密|密文|明文|SM2|SM3|SM4|AES|DES|RSA|MD5|SHA|HMAC|hook|公钥|私钥|签名|密钥|key|iv\b|token|cookie|localStorage|sessionStorage|xhr|fetch|请求头|响应头|header|JSON\.parse|JSON\.stringify|WebCrypto|importKey|generateKey|随机数|random|Date\.now)/i;
    const MAX_LENGTH = 4000;

    const orig = {
        log: console.log.bind(console),
        warn: console.warn.bind(console),
        error: console.error.bind(console),
        info: console.info.bind(console)
    };

    // V4.9.38（批 3 审计 S-R3 🔴）：**递归护栏**。
    // 序列化用的是全局 JSON.stringify，而 hook_json_stringify.js 会给全局 JSON.stringify 装钩子、
    // 并在钩子里 console.log —— 两者同时启用时形成
    //   桥 → JSON.stringify → hook_json_stringify → console.log → 桥 → JSON.stringify → …
    // 的相互递归。实测单次调用 ≥501 层递归 / 500 次 postMessage；无护栏时进程 OOM、
    // 目标页卡死、SW 被消息风暴打爆。
    // 护栏：同一时刻只允许一层序列化，重入直接放弃这一条（宁可丢一条日志，不可让页面卡死）。
    let serializing = false;
    function serializeArgs(args) {
        if (serializing) return '';
        serializing = true;
        try {
            return args.map(a => {
                if (typeof a === 'string') return a;
                if (typeof a === 'number' || typeof a === 'boolean') return String(a);
                if (typeof a === 'bigint') return a.toString();
                if (typeof a === 'function') return '[Function]';
                try {
                    const json = JSON.stringify(a, (k, v) => {
                        if (typeof v === 'function') return '[Function]';
                        if (typeof v === 'bigint') return v.toString();
                        if (typeof v === 'undefined') return '[undefined]';
                        return v;
                    });
                    return json !== undefined ? json : String(a);
                } catch (e) {
                    return String(a);
                }
            }).join(' ');
        } catch (e) {
            return '';
        } finally {
            serializing = false;
        }
    }

    function forward(level, args) {
        try {
            const text = serializeArgs(args);
            if (!text) return;
            if (text.length > MAX_LENGTH) return;
            if (!HOOK_KEYWORD.test(text)) return;
            window.postMessage({
                type: 'CONSOLE_LOG',
                source: 'hook-console-bridge',
                level: level,
                text: text,
                timestamp: Date.now()
            }, '*');
        } catch (e) { /* 忽略 */ }
    }

    // 包装 console 方法（保留原始输出）
    for (const level of ['log', 'warn', 'error', 'info']) {
        try {
            const wrapper = function (...args) {
                try { forward(level, args); } catch (e) { /* 忽略 */ }
                return orig[level](...args);
            };
            // V4.9.38（批 3 审计 S-R6 🔴）：打标记，让 hook_log 的 Proxy 放行扩展自己的桥。
            // 否则 hook_log 先注入时，本包装会被它的 set 陷阱静默拦掉，所有 Hook 数据断流。
            wrapper.__adb_bridge = true;
            console[level] = wrapper;
            // 安装后自检：被别的 Proxy / 反调试脚本拦掉时必须留痕（不能静默断流）
            if (console[level] !== wrapper) {
                try {
                    window.postMessage({
                        type: 'CONSOLE_LOG',
                        source: 'hook-console-bridge',
                        level: 'warn',
                        text: '[adb] 警告：console.' + level + ' 的数据桥包装安装失败（被页面的反调试脚本拦截），该级别日志可能进不了 MCP',
                        timestamp: Date.now()
                    }, '*');
                } catch (e) { /* 忽略 */ }
            }
        } catch (e) { /* 忽略 */ }
    }
})();
