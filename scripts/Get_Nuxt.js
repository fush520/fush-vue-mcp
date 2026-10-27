// ==UserScript==
// @name         Get_Nuxt (Nuxt 框架数据提取)
// @namespace    https://github.com/0xsdeo/AntiDebug_Breaker
// @version      2026-08-27
// @description  Nuxt 2/3 站点数据提取：解析 __NUXT__/__NUXT_DATA__ payload，提取页面路径、API 端点与敏感字段（user/email/token 等）
// @author       0xsdeo / fusheng
// @run-at       document-start
// @match        *
// @grant        none
// ==/UserScript==

// Nuxt 框架 payload 提取（Nuxt 站点没有 vue-router 实例可提，需专门适配）
(function () {
    const LOCK_KEY = '__NUXT_EXTRACTOR__';
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

    let reported = false;

    function sendToExtension(data) {
        try {
            window.postMessage({
                type: 'VUE_ROUTER_DATA',
                source: 'get-nuxt-script',
                data: data
            }, '*');
        } catch (e) {
            console.warn('[GetNuxt] postMessage 发送失败:', e);
        }
    }

    function isNuxtSite() {
        if (window.__NUXT__ || window.useNuxtApp) return true;
        if (document.querySelector('#__NUXT_DATA__')) return true;
        // /_nuxt 静态资源特征
        const nuxtScripts = document.querySelectorAll('script[src*="/_nuxt/"], link[href*="/_nuxt/"]');
        if (nuxtScripts.length > 0) return true;
        return false;
    }

    // ========== 敏感字段识别 ==========
    const SENSITIVE_KEY_PATTERN = /(user|email|phone|mobile|token|jwt|session|secret|key|passwd|password|idcard|card|account|nickname|name|openid|unionid)/i;
    const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
    // V4.9.12（实测 ui.nuxt.com 驱动）：原 `(?:...)+` 要求**至少一个路径段**，导致**根路径 "/" 永远不被识别**——
    // 而内联 payload 的 `"path"` 字段（当前页面路径）常就是 "/"，于是唯一能拿到的那条路径被丢弃。
    // 改 `*` 使根路径命中；根路径是有意义的探测目标（`/_payload.json` 通常就是整站 payload）。
    const PATH_PATTERN = /^\/(?:[a-zA-Z0-9_-]+\/?)*$/;

    // 从任意对象递归提取敏感 key-value 与路径（深度限制 5）
    function extractFromObject(obj, depth, seen, out) {
        if (!obj || depth > 5 || typeof obj !== 'object') return;
        if (seen.has(obj)) return;
        seen.add(obj);

        try {
            if (Array.isArray(obj)) {
                for (const item of obj) extractFromObject(item, depth + 1, seen, out);
                return;
            }
            for (const key of Object.keys(obj)) {
                const v = obj[key];
                if (typeof v === 'string') {
                    if (SENSITIVE_KEY_PATTERN.test(key) && v.length > 0 && v.length < 500) {
                        out.sensitiveFields.push({ key, value: v, type: 'string' });
                    }
                    if (v.startsWith('/') && PATH_PATTERN.test(v) && v.length < 200) {
                        out.paths.add(v);
                    }
                    if (EMAIL_PATTERN.test(v)) {
                        out.emails.add(v);
                    }
                    if (/^(https?:\/\/|\/api\/|\/v[0-9]+\/)/i.test(v) && v.length < 500) {
                        out.apiCandidates.add(v);
                    }
                } else if (typeof v === 'object' && v !== null) {
                    extractFromObject(v, depth + 1, seen, out);
                }
            }
        } catch (e) { /* 忽略 */ }
    }

    function extractNuxt2() {
        const nuxt = window.__NUXT__;
        if (!nuxt || typeof nuxt !== 'object') return null;
        const out = {
            sensitiveFields: [],
            paths: new Set(),
            emails: new Set(),
            apiCandidates: new Set(),
            stateKeys: []
        };
        const seen = new WeakSet();
        try {
            // 顶层状态键列表
            for (const k of Object.keys(nuxt)) {
                if (k === 'state' || k === 'data' || k === 'serverRendered' || k === 'layout') {
                    if (nuxt[k] && typeof nuxt[k] === 'object') {
                        out.stateKeys.push(k);
                        extractFromObject(nuxt[k], 0, seen, out);
                    }
                }
            }
            extractFromObject(nuxt, 0, seen, out);
        } catch (e) {
            console.warn('[GetNuxt] Nuxt2 提取失败:', e);
        }
        return {
            version: 'Nuxt 2',
            sensitiveFields: out.sensitiveFields.slice(0, 200),
            paths: [...out.paths].slice(0, 500),
            emails: [...out.emails].slice(0, 50),
            apiCandidates: [...out.apiCandidates].slice(0, 200),
            stateKeys: out.stateKeys
        };
    }

    function extractNuxt3() {
        const scriptEl = document.querySelector('#__NUXT_DATA__');
        if (!scriptEl || !scriptEl.textContent) return null;
        let parsed;
        try {
            parsed = JSON.parse(scriptEl.textContent);
        } catch (e) {
            console.warn('[GetNuxt] Nuxt3 payload JSON 解析失败:', e.message);
            return { version: 'Nuxt 3', parseError: e.message, rawSample: scriptEl.textContent.slice(0, 2000) };
        }
        const out = {
            sensitiveFields: [],
            paths: new Set(),
            emails: new Set(),
            apiCandidates: new Set()
        };
        const seen = new WeakSet();
        // Nuxt 3 payload 是扁平数组（含解引用索引），启发式提取字符串值
        if (Array.isArray(parsed)) {
            const keys = [];
            for (const item of parsed) {
                if (typeof item === 'string') {
                    if (SENSITIVE_KEY_PATTERN.test(item) && item.length < 100) keys.push(item);
                    if (item.startsWith('/') && PATH_PATTERN.test(item) && item.length < 200) out.paths.add(item);
                    if (EMAIL_PATTERN.test(item)) out.emails.add(item);
                    if (/^(https?:\/\/|\/api\/|\/v[0-9]+\/)/i.test(item) && item.length < 500) out.apiCandidates.add(item);
                } else if (item && typeof item === 'object') {
                    extractFromObject(item, 0, seen, out);
                }
            }
            // 路径-值配对启发：数组相邻元素 [key, value] 的经典模式
            for (let i = 0; i < parsed.length - 1; i++) {
                const k = parsed[i], v = parsed[i + 1];
                if (typeof k === 'string' && SENSITIVE_KEY_PATTERN.test(k) && k.length < 100 &&
                    typeof v === 'string' && v.length > 0 && v.length < 500) {
                    out.sensitiveFields.push({ key: k, value: v, type: 'nuxt3-pair' });
                }
            }
        } else if (parsed && typeof parsed === 'object') {
            extractFromObject(parsed, 0, seen, out);
        }
        return {
            version: 'Nuxt 3',
            sensitiveFields: out.sensitiveFields.slice(0, 200),
            paths: [...out.paths].slice(0, 500),
            emails: [...out.emails].slice(0, 50),
            apiCandidates: [...out.apiCandidates].slice(0, 200)
        };
    }

    function runExtraction() {
        if (!isNuxtSite()) return;
        let result = extractNuxt3();
        if (!result) result = extractNuxt2();
        if (!result) {
            result = { version: 'Nuxt (unknown)', note: '检测到 Nuxt 特征但未找到 payload' };
        }
        result.timestamp = Date.now();
        reported = true;
        console.log('[GetNuxt] 提取完成:', result.version, '路径', (result.paths || []).length, '条');
        sendToExtension({
            type: 'NUXT_DATA',
            nuxt: result
        });
    }

    // 轮询（payload 可能在 hydration 后异步出现）
    let tries = 0;
    function poll() {
        tries++;
        runExtraction();
        if (!reported && tries < 10) {
            setTimeout(poll, 1000);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            setTimeout(poll, 500);
        });
    } else {
        setTimeout(poll, 500);
    }
})();
