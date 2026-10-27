// ==UserScript==
// @name         Hook_responseText
// @namespace    https://github.com/0xsdeo/Hook_JS
// @version      2025-01-05
// @description  当网站js读取XHR响应内容（responseText）时打印响应内容与堆栈。移植自上游 Hook_JS（2026-07-25 新增），本地化接入 HOOK_CONFIG_READY 门控。
// @author       0xsdeo
// @match        http://*/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const SCRIPT_ID = 'hook_responseText';

    function clear_Antidebug(id) {
        localStorage.removeItem("Antidebug_breaker_" + id + "_flag");
        localStorage.removeItem("Antidebug_breaker_" + id + "_debugger");
        localStorage.removeItem("Antidebug_breaker_" + id + "_stack");
    }

    function initHook() {
        let flag = localStorage.getItem("Antidebug_breaker_" + SCRIPT_ID + "_flag");
        let is_debugger = localStorage.getItem("Antidebug_breaker_" + SCRIPT_ID + "_debugger");
        let is_stack = localStorage.getItem("Antidebug_breaker_" + SCRIPT_ID + "_stack");

        // 记录原始属性访问器（getter 可能被站点或前置 Hook 改写过，此处取当前值）
        const property_accessor = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, "responseText");
        if (!property_accessor || !property_accessor.get) {
            console.warn('[AntiDebug] 无法获取 responseText 属性访问器，Hook 未生效');
            return;
        }
        const get_accessor = property_accessor.get;
        const is_data_property = !!property_accessor.value; // data 属性（非访问器）异常形态保护

        try {
            Object.defineProperty(XMLHttpRequest.prototype, "responseText", {
                get: function () {
                    const response_text = is_data_property ? this._adb_original_responseText : get_accessor.call(this);
                    if (flag === "0") {
                        // 长响应截断打印：避免大响应刷爆控制台（console 桥同步截断，此处置面展示）
                        const preview = typeof response_text === 'string' && response_text.length > 4096
                            ? response_text.slice(0, 4096) + `...[共${response_text.length}字符]`
                            : response_text;
                        console.log("捕获到 XHR responseText 读取：\n", preview);
                        if (is_debugger === "1") {
                            debugger;
                        }
                        if (is_stack === "1") {
                            console.log(new Error().stack);
                        }
                    }
                    return response_text; // 网站js读取时走原 getter 返回
                },
                configurable: true
            });
        } catch (e) {
            console.warn('[AntiDebug] Hook responseText 失败:', e);
            return;
        }
        clear_Antidebug(SCRIPT_ID);
    }

    function setupConfigListener() {
        window.addEventListener('message', function (event) {
            // 只接受来自扩展的消息
            if (event.source !== window ||
                !event.data ||
                event.data.source !== 'antidebug-extension' ||
                event.data.type !== 'HOOK_CONFIG_READY') {
                return;
            }

            // 检查是否包含当前脚本ID
            const scriptIds = event.data.scriptIds || [];
            if (scriptIds.includes(SCRIPT_ID)) {
                // 配置已就绪，初始化Hook
                initHook();
            }
        });
    }

    // 立即设置监听器
    setupConfigListener();
})();
