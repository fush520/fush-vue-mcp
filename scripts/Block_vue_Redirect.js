// ==UserScript==
// @name         Block_vue_Redirect
// @namespace    https://github.com/0xsdeo/AntiDebug_Breaker
// @version      4.8.0
// @description  V4.8新增：清除 Vue 站点跳转（跳回 login 的阻断）。三层拦截：① Vue Router push/replace hook（轮询装钩，等价 patch_bounce 自动化——实测 pushState 拦截挡不住 router 内部状态漂移，router 层才是正解）② history.pushState/replaceState 拦截（history 模式 URL 保护）③ hashchange 自动回退。整页跳转（location.href 型）受浏览器安全模型限制纯脚本无法可靠阻断，以 router 层拦截为主。配合 Clear_vue_Navigation_Guards / deep_link_probe 使用。Hook 无条件安装、实时读启用态（同 hook_websocket 模式）。
// @author       0xsdeo (V4.8 local by fusheng)
// @match        http://*/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const SCRIPT_ID = 'Block_vue_Redirect';
    // 与 patch_bounce 同款判断（实战验证）：拦 login 弹回，不误伤 /authorization 等业务路由
    const LOGIN_DROP_RE = /^(\/|#\/)?(\/)?(login|signin)([/?#]|$)/i;

    function isEnabled() {
        // 启用列表由 content.js 从 chrome.storage 同步到 localStorage（AntiDebug_Breaker key），
        // 每次拦截判断时实时读取——启用后无需重刷新即对下一次导航生效
        try {
            const parsed = JSON.parse(localStorage.getItem('AntiDebug_Breaker') || '{}');
            return (parsed[location.hostname] || []).includes(SCRIPT_ID);
        } catch (e) {
            return false;
        }
    }

    function isLoginTarget(u) {
        const s = String(u || '');
        return LOGIN_DROP_RE.test(s) || (/login/i.test(s) && s.length <= 8);
    }

    // ① Vue Router push/replace hook（核心：拦 router 层导航，防止 URL 拦截后 router 状态漂移）
    function tryHookRouter(attempt) {
        try {
            const app = document.querySelector('#app') || document.querySelector('[data-v-app]');
            const rt = app && app.__vue_app__ && app.__vue_app__.config.globalProperties.$router;
            if (rt && !rt.push.__adbNoRedirect) {
                const wrap = (orig, name) => function (loc) {
                    const to = typeof loc === 'string' ? loc : (loc && loc.path) || '';
                    if (isEnabled() && isLoginTarget(to)) {
                        console.log('[AntiDebug] 已拦截 router.' + name + ' 跳转:', to);
                        window.__adbBlockedRedirects = (window.__adbBlockedRedirects || 0) + 1;
                        return Promise.resolve();
                    }
                    return orig.apply(this, arguments);
                };
                rt.push = wrap(rt.push, 'push');
                rt.push.__adbNoRedirect = true;
                rt.replace = wrap(rt.replace, 'replace');
                rt.replace.__adbNoRedirect = true;
                window.__adbRouterHooked = true;
                return;
            }
        } catch (e) { /* 页面还没挂载，继续等 */ }
        if (attempt < 60) setTimeout(() => tryHookRouter(attempt + 1), 500); // 最长轮询 30s
    }

    function initHook() {
        // ② history.pushState/replaceState：拦 login 的 URL 变更（history 模式的 URL 保护层）
        const hookHistory = (orig, name) => function (state, title, url) {
            if (url && isLoginTarget(String(url)) && isEnabled()) {
                console.log(`[AntiDebug] 已阻断 ${name} 跳转: ${url}`);
                window.__adbBlockedRedirects = (window.__adbBlockedRedirects || 0) + 1;
                return;
            }
            return orig.apply(this, arguments);
        };
        if (!history.pushState.__adbBlocked) {
            history.pushState = hookHistory(history.pushState, 'pushState');
            history.pushState.__adbBlocked = true;
        }
        if (!history.replaceState.__adbBlocked) {
            history.replaceState = hookHistory(history.replaceState, 'replaceState');
            history.replaceState.__adbBlocked = true;
        }

        // ③ hashchange 回退：真实 hash 赋值跳 login 时自动退回上一个非 login hash
        let lastGoodHash = location.hash && !isLoginTarget(location.hash) ? location.hash : '';
        window.addEventListener('hashchange', () => {
            if (isEnabled() && isLoginTarget(location.hash)) {
                console.log('[AntiDebug] 已回退 login hash 跳转:', location.hash);
                window.__adbBlockedRedirects = (window.__adbBlockedRedirects || 0) + 1;
                if (lastGoodHash) {
                    try { location.hash = lastGoodHash; } catch (e) { /* 忽略 */ }
                }
                return;
            }
            lastGoodHash = location.hash;
        });

        // ① router hook 轮询启动（router 在页面挂载后才存在）
        tryHookRouter(0);
    }

    initHook();
})();
