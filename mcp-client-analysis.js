// ===== 新增：加密分析功能 =====

// 存储捕获的加密数据
let capturedEncryptionData = [];

// 启用加密 Hook 并准备捕获
async function enableEncryptionHooks({ tabId, hostname } = {}) {
    // V4.9.26（作用域收尾）：原签名不收作用域、且调 toggleScript 时也没传 —— 于是永远落在
    // **活动标签页**上：AI 指定了目标标签也照样改错站点的脚本开关。toggleScript 本就支持这两个参数
    const scriptsToEnable = [
        'Hook_JSEncrypt',      // RSA 加密
        'Hook_CryptoJS',       // AES/DES/MD5 等
        'hook_log'             // 防止 console.log 被清除
    ];

    const results = [];
    for (const scriptId of scriptsToEnable) {
        const result = await toggleScript({ scriptId, enabled: true, tabId, hostname });
        results.push({ scriptId, ...result });
    }
    
    return {
        success: true,
        enabledScripts: scriptsToEnable,
        results,
        message: '加密 Hook 脚本已启用，刷新页面后生效'
    };
}

// 在页面中注入加密数据捕获器
async function injectEncryptionCapture({ tabId, hostname } = {}) {
    const tab = await requireTab({ tabId, hostname });
    
    return new Promise((resolve, reject) => {
        // S3 双执行守卫（bug-hunt 2026-10-13）
        const dupTok = '__adbk_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        adbExecuteScript({
            target: { tabId: tab.id },
            func: (__tok) => {
                // S3 双执行守卫 + M9 幂等（bug-hunt 2026-10-13）：重复执行既防"双击"也防层层包 console.log
                if (window[__tok]) return { __adbDupSkipped: true };
                try { window[__tok] = 1; } catch (e) { /* window 冻结：fail-open 放行 */ }
                if (window.__adbEncHooked) return { success: true, reused: true };   // M9：已注入过（防层层包装）
                window.__adbEncHooked = true;
                // 初始化捕获数组
                window.__encryptionCaptures = window.__encryptionCaptures || [];

                // V4.9.11（验收修复 A13）：console.log 的原始 args 可能含函数 / DOM 节点 /
                // 循环引用（React 事件对象很常见），结构化克隆会抛 DataCloneError →
                // **整个 GET_CAPTURED_ENCRYPTION 调用失败，所有历史捕获一次性全丢**（单条坏记录污染整批）。
                // 这里在页面侧就把每条记录转成确定可克隆的形式：原始值保留，复杂值转字符串
                const __adbSafeArgs = (args) => {
                    try {
                        return (Array.isArray(args) ? args : [args]).map((a) => {
                            if (a === null) return null;
                            if (a === undefined) return 'undefined';
                            const t = typeof a;
                            if (t === 'string' || t === 'number' || t === 'boolean') return a;
                            if (t === 'function') return '[Function ' + (a.name || 'anonymous') + ']';
                            if (t === 'symbol' || t === 'bigint') return String(a);
                            try {
                                return JSON.stringify(a, (k, v) =>
                                    (typeof v === 'function' ? '[Function ' + (v.name || '') + ']' : v)) || String(a);
                            } catch (e2) {
                                return '[不可序列化: ' + Object.prototype.toString.call(a) + ']';
                            }
                        });
                    } catch (e) { return ['[序列化失败]']; }
                };

                // Hook console.log 来捕获加密输出
                const originalLog = console.log;
                console.log = function(...args) {
                    const message = args.join(' ');
                    
                    // 检测 JSEncrypt RSA 输出
                    if (message.includes('JSEncrypt') || message.includes('RSA') || 
                        message.includes('公钥') || message.includes('私钥') ||
                        message.includes('encrypt') || message.includes('decrypt')) {
                        window.__encryptionCaptures.push({
                            type: 'RSA',
                            timestamp: Date.now(),
                            data: __adbSafeArgs(args)
                        });
                    }
                    
                    // 检测 CryptoJS 输出
                    if (message.includes('CryptoJS') || message.includes('AES') || 
                        message.includes('DES') || message.includes('MD5') ||
                        message.includes('SHA') || message.includes('HMAC')) {
                        window.__encryptionCaptures.push({
                            type: 'CryptoJS',
                            timestamp: Date.now(),
                            data: __adbSafeArgs(args)
                        });
                    }
                    
                    originalLog.apply(console, args);
                };
                
                return { success: true, message: '加密捕获器已注入' };
            },
            args: [dupTok],
            world: 'MAIN'
        }).then(results => {
            resolve(results[0]?.result || { error: '执行失败' });
        }).catch(reject);
    });
}

// 获取捕获的加密数据
async function getCapturedEncryption({ tabId, hostname } = {}) {
    const tab = await requireTab({ tabId, hostname }, true);
    
    return new Promise((resolve, reject) => {
        adbExecuteScript({
            target: { tabId: tab.id },
            func: () => {
                return window.__encryptionCaptures || [];
            },
            world: 'MAIN'
        }).then(results => {
            resolve(results[0]?.result || []);
        }).catch(reject);
    });
}

// 分析页面中的加密库和密钥
async function analyzePageEncryption({ tabId, hostname } = {}) {
    const tab = await requireTab({ tabId, hostname });
    
    return new Promise((resolve, reject) => {
        adbExecuteScript({
            target: { tabId: tab.id },
            func: () => {
                const result = {
                    libraries: {
                        JSEncrypt: typeof JSEncrypt !== 'undefined',
                        CryptoJS: typeof CryptoJS !== 'undefined',
                        forge: typeof forge !== 'undefined',
                        sjcl: typeof sjcl !== 'undefined',
                        aesjs: typeof aesjs !== 'undefined',
                        sm2: typeof sm2 !== 'undefined',
                        sm4: typeof sm4 !== 'undefined'
                    },
                    detectedEncryption: null,
                    keys: {
                        publicKey: null,
                        privateKey: null
                    }
                };
                
                // 尝试从页面脚本中提取密钥
                const allScripts = Array.from(document.scripts);
                const scripts = allScripts.filter(s => !s.src);
                for (const script of scripts) {
                    const content = script.textContent || '';

                    // RSA 公钥模式
                    const publicKeyMatch = content.match(/"(MIGfMA[A-Za-z0-9+\/=\\n]+|MFwwDQ[A-Za-z0-9+\/=\\n]+)"/);
                    if (publicKeyMatch) {
                        result.keys.publicKey = publicKeyMatch[1];
                        result.detectedEncryption = 'RSA';
                    }

                    // RSA 私钥模式
                    const privateKeyMatch = content.match(/"(MIIBVAIBADANBgkqhkiG9w0BAQEFAASCAT[A-Za-z0-9+\/=\\n]+|MIIB[A-Za-z0-9+\/=\\n]{200,})"/);
                    if (privateKeyMatch) {
                        result.keys.privateKey = privateKeyMatch[1].substring(0, 100) + '...';
                        result.detectedEncryption = 'RSA';
                    }
                }

                // V4.9.25（清单🟡-8）：**detectedEncryption 不再恒为 null**。
                // 上面 `libraries` 早就把 JSEncrypt/CryptoJS/forge/sjcl/aesjs/sm2/sm4 **逐个探过**了，
                // 却从不用它推导加密方式——只有"脚本里搜到 PEM 公钥"才写 'RSA'。而现实里密钥多在后端
                // 下发或外链 bundle 中 → 绝大多数站点恒报"未知"，工具描述却承诺"分析页面加密"（含提取密钥）。
                // 现按**已探到的证据**推导：库命中 + 内联密钥
                const libHits = [];
                if (result.detectedEncryption === 'RSA') libHits.push('RSA(内联密钥)');
                if (result.libraries.JSEncrypt) libHits.push('JSEncrypt(RSA)');
                if (result.libraries.sm2 || result.libraries.sm4) libHits.push('国密(SM2/SM4)');
                if (result.libraries.forge) libHits.push('forge');
                if (result.libraries.sjcl) libHits.push('sjcl');
                if (result.libraries.aesjs) libHits.push('aesjs(AES)');
                if (result.libraries.CryptoJS) libHits.push('CryptoJS');
                result.detectedEncryption = libHits.length > 0 ? libHits.join(' + ') : null;

                // V4.9.25（同清单🟡-9 家族）：扫描覆盖范围如实标注——只扫**内联** script，
                // 外链 `<script src>` 的 textContent 恒为空串。"null" 必须能被区分成
                // "确实没有加密库" 还是 "没扫到"
                const externalCount = allScripts.length - scripts.length;
                result.scanCoverage = {
                    inlineScriptsScanned: scripts.length,
                    externalScriptsUnscanned: externalCount,
                    keyExtractionScope: '仅内联脚本中的 PEM 密钥字面量',
                    note: externalCount > 0
                        ? `只扫了 ${scripts.length} 个**内联** <script>；另有 ${externalCount} 个外链脚本**未扫**——库未检出/密钥未找到**不代表页面没有加密**（密钥常由后端下发或藏在外链 bundle 里，改用 get_chunk_source / info_leak_scan 读源码）`
                        : `全部 ${scripts.length} 个脚本均为内联，已完整扫描`
                };

                return result;
            },
            world: 'MAIN'
        }).then(results => {
            resolve(results[0]?.result || { error: '执行失败' });
        }).catch(reject);
    });
}

// 自动登录并捕获加密数据
async function autoLoginAndCapture({ username, password, usernameSelector, passwordSelector, submitSelector, waitTime = 3000, tabId, hostname }) {
    const tab = await requireTab({ tabId, hostname });
    
    // 先注入加密捕获器
    await injectEncryptionCapture({ tabId, hostname });
    
    return new Promise((resolve, reject) => {
        // S3 双执行守卫（bug-hunt 2026-10-13）：防"登录提交"双执行
        const dupTok = '__adbk_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        adbExecuteScript({
            target: { tabId: tab.id },
            func: async (__tok, user, pwd, userSel, pwdSel, submitSel, wait) => {
                if (window[__tok]) return { __adbDupSkipped: true };
                try { window[__tok] = 1; } catch (e) { /* window 冻结：fail-open 放行 */ }
                // 清空之前的捕获
                window.__encryptionCaptures = [];
                window.__loginRequest = null;
                
                // Hook XHR 和 fetch 来捕获登录请求
                // V4.9.22（修复🔴）：原实现只 patch 了 send，却读 `this._url` / `this._method`——这两个属性
                // **全项目无任何赋值点**（页面调的 XHR.prototype.open 没被我们 hook），于是条件恒假、
                // `__loginRequest` **永远是 null**：AI 会读成"登录请求未被捕获 / 该站登录不走 XHR"，
                // 而真相是这个字段从未生效。补 patch open 记录方法与 URL（与 scripts/hook_xhr_open.js 同范式）。
                const originalXHROpen = XMLHttpRequest.prototype.open;
                XMLHttpRequest.prototype.open = function(method, url) {
                    this._url = String(url);
                    this._method = method;
                    return originalXHROpen.apply(this, arguments);
                };
                const originalXHRSend = XMLHttpRequest.prototype.send;
                XMLHttpRequest.prototype.send = function(body) {
                    if (this._url && (this._url.includes('login') || this._url.includes('auth'))) {
                        window.__loginRequest = {
                            url: this._url,
                            method: this._method,
                            body: body,
                            timestamp: Date.now()
                        };
                    }
                    return originalXHRSend.apply(this, arguments);
                };
                
                // 默认选择器
                const usernameInput = document.querySelector(userSel || 'input[type="text"], input[placeholder*="账号"], input[placeholder*="用户"]');
                const passwordInput = document.querySelector(pwdSel || 'input[type="password"]');
                // 修复：默认候选改用合法 CSS；文本匹配（旧版混入 jQuery 语法 button:contains 导致 querySelector 抛 SyntaxError）
                let submitButton = submitSel ? document.querySelector(submitSel) : null;
                if (!submitButton) {
                    submitButton = document.querySelector('button[type="submit"], .login-btn, .el-button--primary, input[type="submit"]');
                }
                if (!submitButton) {
                    // 按可见文本匹配登录/提交按钮（遍历代替非法的 :contains 伪类）
                    const candidates = document.querySelectorAll('button, [role="button"], a.btn, input[type="button"]');
                    for (const btn of candidates) {
                        const t = (btn.textContent || btn.value || '').trim().toLowerCase();
                        if (/(登录|登陆|sign in|login|提交|submit)/.test(t)) { submitButton = btn; break; }
                    }
                }
                
                if (!usernameInput || !passwordInput) {
                    return { error: '找不到登录表单元素' };
                }
                
                // 填写表单
                usernameInput.focus();
                usernameInput.value = user;
                usernameInput.dispatchEvent(new Event('input', { bubbles: true }));
                
                passwordInput.focus();
                passwordInput.value = pwd;
                passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
                
                // 等待一下让 Vue 等框架响应
                await new Promise(r => setTimeout(r, 500));
                
                // 点击登录
                if (submitButton) {
                    submitButton.click();
                }
                
                // 等待请求完成
                await new Promise(r => setTimeout(r, wait));
                
                return {
                    success: true,
                    loginRequest: window.__loginRequest,
                    // V4.9.22（修复）：未捕获时如实说明**为什么**——原实现裸返 null，AI 会读成
                    // "该站登录不走 XHR"（实际还可能是：接口 URL 不含 login/auth 字样，或登录走 fetch 未 hook）
                    loginRequestNote: window.__loginRequest ? undefined
                        : '未捕获到登录请求——可能原因：① 登录接口 URL 不含 login/auth 字样（本 hook 只按此匹配）② 登录走 fetch（本函数未 hook fetch）③ 提交按钮未点中。请用 get_network_requests 核对真实登录请求',
                    encryptionCaptures: window.__encryptionCaptures,
                    message: '自动登录完成'
                };
            },
            args: [dupTok, username || '', password || '', usernameSelector || '', passwordSelector || '', submitSelector || '', waitTime || 1500],
            world: 'MAIN'
        }).then(results => {
            resolve(results[0]?.result || { error: '执行失败' });
        }).catch(reject);
    });
}

// 解密 RSA 加密的数据
async function decryptRSA({ encryptedData, privateKey, tabId, hostname }) {
    const tab = await requireTab({ tabId, hostname });
    
    return new Promise((resolve, reject) => {
        adbExecuteScript({
            target: { tabId: tab.id },
            func: async (encrypted, privKey) => {
                // 动态加载 JSEncrypt
                if (typeof JSEncrypt === 'undefined') {
                    const script = document.createElement('script');
                    script.src = 'https://cdn.jsdelivr.net/npm/jsencrypt@3.3.2/bin/jsencrypt.min.js';
                    document.head.appendChild(script);
                    await new Promise(r => script.onload = r);
                }
                
                const decrypt = new JSEncrypt();
                decrypt.setPrivateKey(privKey);
                const decrypted = decrypt.decrypt(encrypted);
                
                return {
                    success: !!decrypted,
                    encrypted: encrypted,
                    decrypted: decrypted,
                    message: decrypted ? '解密成功' : '解密失败'
                };
            },
            args: [encryptedData || '', privateKey || ''],
            world: 'MAIN'
        }).then(results => {
            resolve(results[0]?.result || { error: '执行失败' });
        }).catch(reject);
    });
}



// ===== V3.1：密码学能力注册表 + 签名重放 + 响应解密 =====

// 读取页面内 Crypto_Capture 脚本捕获的密码学能力注册表
async function getCryptoRegistry({ tabId, hostname } = {}) {
    const tab = await requireTab({ tabId, hostname }, true);

    return new Promise((resolve, reject) => {
        adbExecuteScript({
            target: { tabId: tab.id },
            func: () => {
                try {
                    if (!window.__ADB_CRYPTO__) {
                        return {
                            error: '页面未检测到 Crypto_Capture 脚本。请先在插件中开启「签名重放+响应解密」脚本并刷新目标页面，再触发一次目标站点的加密操作。'
                        };
                    }
                    return window.__ADB_CRYPTO__.getRegistry();
                } catch (e) {
                    return { error: e.message };
                }
            },
            world: 'MAIN'
        }).then(results => {
            resolve(results[0]?.result || { error: '执行失败' });
        }).catch(reject);
    });
}

// 使用页面捕获的密钥/加密函数对任意明文重算签名或加密（改参重放核心）
async function signPayload({ payload, capabilityId, operation = 'sign', tabId, hostname } = {}) {
    if (payload === undefined || payload === null || payload === '') {
        throw new Error('缺少 payload 参数（sign/encrypt/hash 传明文字符串，decrypt 传密文）');
    }
    if (!['sign', 'encrypt', 'decrypt', 'hash'].includes(operation)) {
        throw new Error('operation 必须是 sign/encrypt/decrypt/hash 之一');
    }
    const tab = await requireTab({ tabId, hostname });

    return new Promise((resolve, reject) => {
        adbExecuteScript({
            target: { tabId: tab.id },
            func: async (payloadText, capId, op) => {
                try {
                    if (!window.__ADB_CRYPTO__) {
                        return {
                            error: '页面未检测到 Crypto_Capture 脚本。请先在插件中开启「签名重放+响应解密」脚本并刷新目标页面。'
                        };
                    }
                    return await window.__ADB_CRYPTO__.compute(payloadText, capId || null, op);
                } catch (e) {
                    return { success: false, error: e.message };
                }
            },
            args: [String(payload || ''), capabilityId || null, operation || 'sign'],
            world: 'MAIN'
        }).then(results => {
            resolve(results[0]?.result || { error: '执行失败' });
        }).catch(reject);
    });
}

// 获取自动解密匹配到的响应（密文→明文）
async function getDecryptedResponses({ limit = 50, tabId, hostname } = {}) {
    const safeLimit = Math.max(1, Math.min(Math.floor(Number(limit) || 50), 200));
    const tab = await requireTab({ tabId, hostname }, true);

    return new Promise((resolve, reject) => {
        adbExecuteScript({
            target: { tabId: tab.id },
            func: (n) => {
                try {
                    if (!window.__ADB_CRYPTO__) {
                        return {
                            error: '页面未检测到 Crypto_Capture 脚本。请先在插件中开启「签名重放+响应解密」脚本并刷新目标页面。'
                        };
                    }
                    return window.__ADB_CRYPTO__.getDecryptedResponses(n);
                } catch (e) {
                    return { error: e.message };
                }
            },
            args: [safeLimit || 50],
            world: 'MAIN'
        }).then(results => {
            resolve(results[0]?.result || { error: '执行失败' });
        }).catch(reject);
    });
}

// ===== V3.1：路由→API 关联图谱 =====

// 收集当前页面已加载的 JS chunk URL 列表（performance API）
async function getJSChunks({ maxChunks = 300, tabId, hostname } = {}) {
    const maxN = Math.min(maxChunks, 500);

    // V4.9.26（作用域收尾）：**显式指定**的标签页解析失败必须上抛，不能落进下面的降级分支。
    // 降级是为"CDP 不可用"准备的，不是为"标签页不存在"——原实现把两者混在一个 try 里：
    // 传了不存在的 tab_id 会**静默**退回"全标签页的 webRequest 缓冲"（且 pageHost 也为空、
    // 连 hostname 过滤都失效），调用方拿到别的站点的 chunk 还以为是对的。
    // 这个缺陷是实测抓出来的：传 tab_id=999999999 时报的是"缓冲为空"而不是"标签页不存在"。
    let explicitTab = null;
    if (typeof tabId === 'number' || (typeof hostname === 'string' && hostname)) {
        explicitTab = await resolveTab({ tabId, hostname });   // 失败即抛，不降级
    }

    // V4.9.7：改为 CDP performance 优先（页面**实际加载成功**的资源清单，权威来源）。
    // 三次缓冲污染教训（dcourses 假 .js / gsjxcg 跨站残留 / DataEase 历史 404 请求被 /assets/ 路径
    // 绕过质量校验）：webRequest 记录的是"请求过"而非"当前有效"，任何质量校验都是启发式。
    // CDP 通道由 ensureTabAwake（睡眠 tab 唤醒）+ withDebugger 保障，5 秒超时降级缓冲。
    try {
        const tab = explicitTab || await resolveTab({});
        if (tab) {
            const cdpPromise = withDebugger(tab.id, async () => {
                const r = await cdpSend(tab.id, 'Runtime.evaluate', {
                    expression: `(function(maxN){try{const entries=performance.getEntriesByType('resource');const seen=new Set();const chunks=[];for(const e of entries){if(chunks.length>=maxN)break;const name=e.name||'';if(!/\\.js(\\?|#|$)/i.test(name))continue;const size=e.decodedBodySize||e.transferSize||0;if(seen.has(name))continue;seen.add(name);chunks.push({url:name,size:size});}return JSON.stringify({count:chunks.length,chunks:chunks,pageUrl:location.href});}catch(e){return JSON.stringify({error:e.message});}})(${maxN})`,
                    returnByValue: true,
                    userGesture: true
                });
                let payload;
                try { payload = JSON.parse(r && r.result && r.result.value); } catch (e) {
                    throw new Error('CDP performance 查询返回异常: ' + JSON.stringify(r && r.result).slice(0, 150));
                }
                if (payload && payload.error) throw new Error('chunk 收集失败: ' + payload.error);
                if (!payload || !Array.isArray(payload.chunks)) throw new Error('chunk 数据格式异常');
                return { count: payload.count, chunks: payload.chunks, pageUrl: payload.pageUrl, source: 'cdp-performance' };
            });
            const wdTimeout = new Promise((_, rej) => setTimeout(() => rej(new Error('cdp-timeout(5s)')), 5000));
            const result = await Promise.race([cdpPromise, wdTimeout]);
            if (result && Array.isArray(result.chunks) && result.chunks.length > 0) return result;
        }
    } catch (e) {
        console.warn('[MCP Client] CDP chunk 收集不可用，降级 webRequest 缓冲:', e && e.message);
    }

    // ===== 降级路径：webRequest 缓冲（尽力而为；V4.9.3 的 hostname 过滤保留）=====
    // V4.7.1 时代的缓冲记录：页面加载的全部 .js 请求 URL 都在 networkRequests 里。
    // V4.9.3：缓冲按当前页面 hostname 过滤（跨 tab/跨站导航残留旧记录）。
    let pageHost = '';
    let hostFilterDisabled = false;
    try {
        const t = explicitTab || await resolveTab({ tabId, hostname });
        if (t && t.url && /^https?:/i.test(t.url)) pageHost = new URL(t.url).hostname;
    } catch (e) {
        // V4.9.28：拿不到 host 就**不过滤** → 缓冲里跨标签/跨站的 .js 会全部混进结果。
        // 原注释把这叫"保守"，其实正相反：AI 会把这些 URL 当作目标站资源去读源码、找路由与密钥。
        hostFilterDisabled = true;
    }
    const jsReqs = networkRequests.filter(r => {
        if (!r.url || !/\.js(\?|#|$)/i.test(r.url) || r.url.startsWith('chrome-extension')) return false;
        if (pageHost) {
            try { return new URL(r.url).hostname === pageHost; } catch (e) { return false; }
        }
        return true;
    });
    // V4.9.11（实站实测 app.example.com）：hostname 过滤拦不住**同站历史累积**——页面多次刷新后
    // 10 个真实 chunk 会变成 80 条同 host 的历史记录（实测 API 提取从 74 个塌到 6 个，还混入
    // 第三方脚本里的路径）。以最新记录为基准取 120 秒窗口 ≈ 最近一次页面加载的资源
    let freshReqs = jsReqs;
    if (jsReqs.length > 0) {
        const newest = jsReqs.reduce((mx, r) => Math.max(mx, r.timestamp || 0), 0);
        if (newest > 0) {
            const filtered = jsReqs.filter(r => (r.timestamp || 0) >= newest - 120000);
            if (filtered.length > 0) freshReqs = filtered;
        }
    }
    const seen = new Set();
    const chunks = [];
    for (const r of freshReqs) {
        if (chunks.length >= maxChunks) break;
        if (seen.has(r.url)) continue;
        seen.add(r.url);
        chunks.push({ url: r.url, size: r.size || 0 });
    }
    // V4.9.7：降级路径下缓冲尽力而为——CDP 已不可用，此时质量校验只做"完全空则报错"，
    // 不再用启发式特征拦截（有总比没有好；调用方会展示 source 标记供 AI 判断可信度）。
    if (chunks.length > 0) {
        return {
            count: chunks.length, chunks: chunks,
            pageUrl: 'webrequest-buffer(fallback)', source: 'webrequest-buffer(fallback)',
            // V4.9.28：`source` 只说明"数据源降级"，没说"hostname 过滤没做"——
            // 不标记的话，混进来的跨站 .js 会被当成目标站资源。
            ...(hostFilterDisabled ? {
                hostFilterDisabled: true,
                hostFilterNote: '未能解析目标页 hostname，缓冲中的**跨站 .js 未被过滤**——下列 URL 可能不属于目标站，使用前请按 hostname 复核'
            } : {})
        };
    }
    throw new Error('chunk 收集失败：CDP performance 不可用且 webRequest 缓冲为空（目标页可能刚刷新/服务刚重启，重试一次即可）');
}
// ===== 智能化功能：自动反调试绕过 =====

// 检测页面反调试机制
async function detectAntiDebug({ tabId, hostname } = {}) {
    const tab = await requireTab({ tabId, hostname });
    
    return new Promise((resolve, reject) => {
        adbExecuteScript({
            target: { tabId: tab.id },
            func: () => {
                const detected = {
                    hasDebugger: false,
                    hasConsoleCheck: false,
                    hasDevtoolsCheck: false,
                    hasTimingCheck: false,
                    hasWindowSizeCheck: false,
                    recommendations: []
                };
                
                // 检查是否有 debugger 语句
                // V4.9.25（清单🟡-9）：**覆盖率必须如实标注**——下面读的是 `script.textContent`，
                // 而**外链** `<script src=...>` 的 textContent 恒为空串，循环对它们等于空转。
                // 原实现不留标记 → "未检测到反调试"被读成"该站没有反调试"，**覆盖盲区当成事实**。
                // 现代 SPA 的反调试基本都在打包后的外链 bundle 里 → 这一类站点**恒报未检测到**
                const allScripts = Array.from(document.scripts);
                const inlineScripts = allScripts.filter(s => !s.src);
                const externalCount = allScripts.length - inlineScripts.length;
                for (const script of inlineScripts) {
                    const content = script.textContent || '';
                    if (/\bdebugger\b/.test(content)) {
                        detected.hasDebugger = true;
                        detected.recommendations.push('Bypass_Debugger');
                    }
                    if (/console\s*\.\s*(log|clear|table)/.test(content) && /=\s*function/.test(content)) {
                        detected.hasConsoleCheck = true;
                        detected.recommendations.push('hook_log', 'hook_clear');
                    }
                    if (/devtools|firebug/i.test(content)) {
                        detected.hasDevtoolsCheck = true;
                        detected.recommendations.push('Fixed_window_size');
                    }
                    if (/performance\.now|Date\.now.*-.*Date\.now/i.test(content)) {
                        detected.hasTimingCheck = true;
                        detected.recommendations.push('hook_table');
                    }
                    if (/innerWidth|innerHeight|outerWidth|outerHeight/i.test(content)) {
                        detected.hasWindowSizeCheck = true;
                        detected.recommendations.push('Fixed_window_size');
                    }
                }

                detected.recommendations = [...new Set(detected.recommendations)];
                detected.scanCoverage = {
                    inlineScriptsScanned: inlineScripts.length,
                    externalScriptsUnscanned: externalCount,
                    note: externalCount > 0
                        ? `只扫了 ${inlineScripts.length} 个**内联** <script>；另有 ${externalCount} 个外链脚本**未扫**（textContent 为空）——「未检测到」**不代表**该站没有反调试。SPA 的反调试多打包在外链 bundle 里，改用 info_leak_scan / get_chunk_source 读源码搜索 debugger/devtools 特征`
                        : `全部 ${inlineScripts.length} 个脚本均为内联，已完整扫描`
                };
                return detected;
            },
            world: 'MAIN'
        }).then(results => {
            resolve(results[0]?.result || { error: '执行失败' });
        }).catch(reject);
    });
}

// 自动绕过反调试
async function autoBypassAntiDebug({ tabId, hostname } = {}) {
    // 先检测反调试机制
    const detection = await detectAntiDebug({ tabId, hostname });
    
    if (detection.error) {
        return detection;
    }
    
    // 根据检测结果启用相应脚本
    // V4.9.26（作用域收尾，子代理审计抓出）：原实现把 {tabId, hostname} 正确转给了 detectAntiDebug，
    // 这一句却**没转发** → **检测**打的是指定标签页，**启用脚本**仍落在**活动标签页**（半程生效，
    // 自相矛盾——而且调用方看不出哪一半生效了）。toggleScript 本就接收这两个参数。
    const results = [];
    for (const scriptId of detection.recommendations) {
        const result = await toggleScript({ scriptId, enabled: true, tabId, hostname });
        results.push({ scriptId, ...result });
    }
    
    return {
        detected: detection,
        enabled: results,
        message: detection.recommendations.length > 0 
            ? `检测到反调试，已启用 ${detection.recommendations.length} 个绕过脚本，请刷新页面`
            : '未检测到明显的反调试机制'
    };
}

// ===== 智能化功能：API 请求分析 =====

// 分析 API 请求签名
async function analyzeAPISignature({ tabId, hostname } = {}) {
    const tab = await requireTab({ tabId, hostname });
    
    // 获取最近的网络请求
    const requests = [...networkRequests].slice(-50);
    
    // 分析请求特征
    // V4.9.22（修复）：原实现有两个**恒空字段**——`authHeaders`/`encryptedParams` 硬编码为 []、
    // 循环里从未赋值，而工具描述宣称"提取签名参数、**加密参数**等特征" → AI 会读成
    // "该站没有认证头 / 没有加密参数"（与 jwt_analyze 的网络头提取同属"输出与实际不符"家族）。处置：
    //  · authHeaders     → **填真实值**（webRequest 采集的请求头本就在记录里，见下方循环）
    //  · encryptedParams → **删除**（单看字符串形态识别密文必然误报、属幻觉数据；项目已有更可靠的手段：
    //    Crypto_Capture 密文↔明文对照 / crypto_registry / sign_payload），工具描述同步改
    const analysis = {
        totalRequests: requests.length,
        methods: {},
        signaturePatterns: [],
        authHeaders: []
    };
    
    // V4.9.22：认证类请求头识别（名称匹配 + 按 name+value 去重 + 预览截断——最多 10 条，
    // 完整值请走 get_network_requests detail=true，避免 50 条请求的 Cookie 全串撑爆上下文）
    // 注：`x-` 后用 `.*` 而非 `.+`——`X-Api-Key`/`X-Auth`/`X-Session-Id` 的关键词**紧贴前缀**，
    // `.+` 会强制多吃一个字符导致漏报；关键词两侧加 `\b` 词边界——既覆盖 `X-Session-Id`（关键词后
    // 还有 `-Id`，靠行尾锚点会漏）又排除 `X-Unauthorized` 这类含 auth **子串**的误报。
    // （两处均由 node temp/test_auth_header_re.js 实测抓出）
    const AUTH_HEADER_RE = /^(authorization|cookie|token|x-.*\b(token|auth|api-?key|session)\b.*|.+-token)$/i;
    const seenAuth = new Set();

    for (const req of requests) {
        // 统计方法
        analysis.methods[req.method] = (analysis.methods[req.method] || 0) + 1;

        // 认证请求头收集（原 authHeaders 恒为空数组——见上方注释）
        if (Array.isArray(req.requestHeaders) && analysis.authHeaders.length < 10) {
            for (const h of req.requestHeaders) {
                if (!h || h.name == null || !AUTH_HEADER_RE.test(String(h.name))) continue;
                const val = String(h.value == null ? '' : h.value);
                const dedupKey = h.name + '\u0000' + val;
                if (seenAuth.has(dedupKey)) continue;
                seenAuth.add(dedupKey);
                if (analysis.authHeaders.length >= 10) break;
                analysis.authHeaders.push({
                    name: String(h.name),
                    valuePreview: val.length > 80 ? val.slice(0, 80) + '…（完整值用 get_network_requests detail=true 取）' : val,
                    url: (req.url || '').split('?')[0]
                });
            }
        }

        // 检测签名参数
        const url = req.url || '';
        if (/sign|signature|token|timestamp|nonce/i.test(url)) {
            const params = new URL(url).searchParams;
            const signParams = {};
            for (const [key, value] of params) {
                if (/sign|token|timestamp|nonce|key/i.test(key)) {
                    signParams[key] = value.length > 50 ? value.substring(0, 50) + '...' : value;
                }
            }
            if (Object.keys(signParams).length > 0) {
                analysis.signaturePatterns.push({ url: url.split('?')[0], params: signParams });
            }
        }
    }
    
    // 去重
    analysis.signaturePatterns = analysis.signaturePatterns.slice(0, 10);
    
    return analysis;
}

// ===== 智能化功能：Vue/React 数据提取 =====

// 提取 Vue 组件数据
async function extractVueData({ selector, tabId, hostname } = {}) {
    // V4.9.12（实测 ng-alain.com 驱动）：改走项目统一的 **CDP 通道**（下方 executeScript 工具）。
    // chrome.scripting.executeScript 的 func+args 形态对部分 tab 状态（睡眠冻结 / 导航中 / frozen）
    // **Promise 永不 settle**——这是项目 V4.7.1 就踩过并记录过的坑（见 executeScript 内注释
    // "实测挂 40s+，MAIN/ISOLATED 双中招"），该工具因此迁到了 CDP，但本函数一直没跟上。
    // 后果**不止于本工具挂起**：detect_site_framework 内部会调它，超时被外层 try/catch 吞掉后
    // 一律得出 vue:false —— 在 Vue 站上给出**假阴性**，而调用方看不到任何异常。
    // 顺带补齐 tabId/hostname 目标指定能力（与其余页面类工具对齐；本函数原本只能作用于活动页）。
    // 探针体保持原样并以 toString 注入，**避免维护第二份逻辑造成漂移**（下方缩进为原样保留）。
    const probe = (sel) => {
                // V4.9.4/4.9.5：探测逻辑——selector/#app 优先，找不到则全文档 BFS。
                // V4.9.5：BFS 收集多个实例并**优先返回带 router 的**（实测 news.example.edu：BFS 命中的
                // 第一个实例是深层组件（无 $router）→ hasRouter 误报 false，实际 22 条路由在根实例上）。
                const describeNode = (n) => (n.id ? '#' + n.id : n.tagName.toLowerCase() + (typeof n.className === 'string' && n.className ? '.' + n.className.split(' ')[0] : ''));

                const buildInfo = (n) => {
                    if (n.__vue_app__) {
                        const app = n.__vue_app__;
                        const gp = app.config && app.config.globalProperties;
                        const router = gp && gp.$router;
                        return {
                            version: 'Vue 3',
                            hasVue: true,
                            hasRouter: !!router,
                            routeCount: router && router.getRoutes ? router.getRoutes().length : 0,
                            mountEl: describeNode(n),
                            globalProperties: Object.keys(gp || {}),
                            componentCount: document.querySelectorAll('[data-v-]').length
                        };
                    }
                    if (n.__vue__) {
                        const vm = n.__vue__;
                        const router = vm.$router || (vm.$root && vm.$root.$router) || vm._router;
                        return {
                            version: 'Vue 2',
                            hasVue: true,
                            hasRouter: !!router,
                            routeCount: router ? (router.getRoutes ? router.getRoutes().length : ((router.options && router.options.routes) || []).length) : 0,
                            isRoot: vm === vm.$root,
                            mountEl: describeNode(n),
                            data: vm.$data,
                            computed: Object.keys(vm.$options.computed || {}),
                            methods: Object.keys(vm.$options.methods || {})
                        };
                    }
                    return null;
                };

                // 1) 显式 selector 或标准 #app
                // V4.9.12（实测 ng-alain.com 驱动）：**必须判空**——原实现直接把 document.querySelector
                // 的结果喂给 buildInfo，为 null 时 buildInfo 内 `n.__vue_app__` 抛 TypeError。
                // 两个后果：① 传了不存在的 selector → 报异常而非明确错误；
                // ② **不传 selector 且页面没有 #app（挂载点叫 #root/.app 等的 Vue 站）→ 同样抛异常，
                //    下方的全文档 BFS 兜底根本执行不到**（该兜底对这些站点等于死代码）。
                // React 侧同位置早有 `if (!element) return { error }` 判空，Vue 侧一直漏了。
                const element = sel ? document.querySelector(sel) : document.querySelector('#app');
                if (sel && !element) return { error: '未找到元素: ' + sel };
                const first = element ? buildInfo(element) : null;
                if (first) return first;

                // 2) 全文档 BFS：收集实例（上限 15），带 router 优先 > 根实例 > 第一个
                if (document.body) {
                    const candidates = [];
                    const q = [document.body];
                    let cnt = 0;
                    const visited = new Set();
                    while (q.length && cnt < 3000 && candidates.length < 15) {
                        const n = q.shift();
                        cnt++;
                        if (!n || n.nodeType !== 1 || visited.has(n)) continue;
                        visited.add(n);
                        const info = buildInfo(n);
                        if (info) candidates.push(info);
                        if (n.childNodes) for (const c of n.childNodes) q.push(c);
                    }
                    if (candidates.length > 0) {
                        const withRouter = candidates.find(c => c.hasRouter);
                        const root = candidates.find(c => c.isRoot);
                        return withRouter || root || candidates[0];
                    }
                }

                return { error: '未检测到 Vue 实例' };
    };
    return executeScript({ code: `(${probe.toString()})(${JSON.stringify(selector || '')})`, world: 'MAIN', tabId, hostname });
}

// 提取 React 组件数据
async function extractReactData({ selector, tabId, hostname } = {}) {
    // V4.9.12（实测 ng-alain.com 驱动）：与 extractVueData 同一处修复——改走 CDP 通道。
    // 原 chrome.scripting.executeScript 的 func+args 形态对部分 tab 状态 Promise 永不 settle
    //（项目 V4.7.1 已记录的坑），连带 detect_site_framework 的 React 判定静默假阴性。
    const probe = (sel) => {
                const element = sel ? document.querySelector(sel) : document.querySelector('#root, #app');
                if (!element) {
                    return { error: '未找到元素' };
                }

                // V4.9.11（换站实测发现·修复）：兼容 React 18 的 createRoot。
                // React 17 及以前：fiber 引用（__reactFiber$ / __reactInternalInstance$）挂在**根元素**上；
                // React 18（createRoot）：根元素上只有 __reactContainer$（其值是 HostRoot Fiber 本身），
                // fiber 挂在**子元素**上。原实现只查前者 → 在所有 React 18 站点（当前主流，实测
                // preview.pro.ant.design）恒返回"未检测到 React 实例"，连带 detect_site_framework
                // 误报"非 Vue/React/Nuxt 站点"、extract_react_data 完全不可用。
                // 四层探测顺序与页面脚本 Get_React_0.js（已正确支持 React 18）对齐
                let fiber = null;
                let detectedVia = null;

                // ① React 17-：根元素上的 fiber 引用
                const legacyKey = Object.keys(element).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
                if (legacyKey) { fiber = element[legacyKey]; detectedVia = 'root-fiber(React 17-)'; }

                // ② React 18 createRoot：__reactContainer$（另兼容个别构建的 __reactContainere$）
                if (!fiber) {
                    const ck = Object.keys(element).find(k => k.startsWith('__reactContainer$') || k.startsWith('__reactContainere$'));
                    if (ck) {
                        const c = element[ck];
                        fiber = (c && c.current) ? c.current : c;   // 兼容 FiberRoot / HostRoot 两种形态
                        detectedVia = 'root-container(React 18)';
                    }
                }

                // ③ React 17 的 _reactRootContainer（非可枚举属性，Object.keys 取不到，单独判）
                if (!fiber) {
                    const rc = element._reactRootContainer;
                    if (rc && rc._internalRoot && rc._internalRoot.current) {
                        fiber = rc._internalRoot.current;
                        detectedVia = 'root-container-legacy(React 17)';
                    }
                }

                // ④ 兜底：往子元素找一层
                if (!fiber) {
                    const child = element.firstElementChild;
                    if (child) {
                        const ck = Object.keys(child).find(k => k.startsWith('__reactFiber$'));
                        if (ck) { fiber = child[ck]; detectedVia = 'child-fiber(fallback)'; }
                    }
                }

                if (fiber) {
                    return {
                        version: 'React',
                        detectedVia,
                        componentName: fiber?.type?.name || fiber?.type?.displayName || 'Unknown',
                        hasProps: !!fiber?.memoizedProps,
                        hasState: !!fiber?.memoizedState
                    };
                }

                return { error: '未检测到 React 实例' };
    };
    return executeScript({ code: `(${probe.toString()})(${JSON.stringify(selector || '')})`, world: 'MAIN', tabId, hostname });
}

// ===== 智能化功能：认证分析 =====

// 分析认证机制
async function analyzeAuthentication({ tabId, hostname } = {}) {
    const tab = await requireTab({ tabId, hostname });
    
    // 获取 Cookie
    // V4.9.23（缺陷🟡-6）：原传空对象 `getCookies({})` / `getLocalStorage({})` → 两者各自 resolveTab
    // 回退到**活动标签页**，与本函数开头解析出的 tab 无关。多标签下会把别的站点（可能是另一个应用）
    // 的 cookie/localStorage 当成本页认证信息返回。此处已解析出 tab，只需往下传
    const cookies = await getCookies({ tabId: tab.id });

    // 获取 localStorage
    const storage = await getLocalStorage({ tabId: tab.id });

    // 分析认证相关数据
    const analysis = {
        // 分析对象归属：多标签下证明"分析的是哪一页"（V4.9.23 配套）
        tabId: tab.id,
        pageUrl: tab.url,
        cookies: {
            total: cookies.length,
            authRelated: cookies.filter(c =>
                /token|auth|session|jwt|access|refresh/i.test(c.name)
            ).map(c => ({
                name: c.name,
                value: c.value.length > 50 ? c.value.substring(0, 50) + '...' : c.value,
                // V4.9.23（缺陷🟡-21）：补完整原始值。下方 JWT 解析读的是 item.rawValue，
                // 而 cookie 分支从未提供该字段 → 落到截断成 50 字符的 value 上，三段式判断必失败
                // （JWT 极少短于 50 字符）→ **cookie 里的 JWT 永远解析不出来**。localStorage 分支的
                // M6 修复只做了一半（原注释"用完整原始值解析"）
                rawValue: c.value,
                httpOnly: c.httpOnly,
                secure: c.secure
            }))
        },
        localStorage: {
            total: Object.keys(storage).length,
            authRelated: Object.entries(storage)
                .filter(([k]) => /token|auth|user|login|jwt/i.test(k))
                .map(([k, v]) => ({
                    key: k,
                    value: typeof v === 'string' && v.length > 100 ? v.substring(0, 100) + '...' : v,
                    rawValue: v  // M6 修复：完整原始值供 JWT 解析
                }))
        },
        tokenAnalysis: null
    };
    
    // 尝试解析 JWT
    for (const item of [...analysis.cookies.authRelated, ...analysis.localStorage.authRelated]) {
        // M6 修复：用完整原始值解析（展示用截断副本解析不了完整 payload）+ base64url → base64 转换
        // V4.9.23（缺陷🟡-21 收口）：原判据 `rawValue.length > 100 ? rawValue : item.value` 与本函数的
        // 两个展示截断长度**对不上**——localStorage 展示截断在 100（恰好自洽），cookie 展示截断在 **50**：
        // 长度落在 (50, 100] 的 cookie 会倒回截断副本，三段式判断失败 → JWT 依旧解析不出来。
        // 即补了 rawValue 也要在这里放行，否则修复"在半路被架空"。改用"有完整值就用完整值"，
        // 仅对病态超长值设上限（防 atob 打大字符串）
        const rawValue = (typeof item.rawValue === 'string' && item.rawValue) ? item.rawValue : (typeof item.value === 'string' ? item.value : '');
        const value = rawValue.length <= 8192 ? rawValue : '';
        if (value.split('.').length === 3) {
            try {
                const b64 = value.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
                const padded = b64 + '='.repeat((4 - b64.length % 4) % 4);
                const payload = JSON.parse(decodeURIComponent(atob(padded).split('').map(c =>
                    '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join('')));
                analysis.tokenAnalysis = {
                    type: 'JWT',
                    source: item.name || item.key,
                    payload: payload
                };
                break;
            } catch (e) {
                // V4.9.28：形如 x.y.z 的 token 解析失败必须留痕——原实现静默 continue，
                // 于是 tokenAnalysis:null 与"该页**根本没有** JWT"完全同形，AI 会读成
                // "无 token 攻击面"而跳过 JWT 相关测试。后续 token 若解析成功会整体
                // 覆盖本对象（error 随之消失），语义正确。
                if (!analysis.tokenAnalysis) {
                    analysis.tokenAnalysis = {
                        error: '疑似 JWT 但解析失败: ' + String((e && e.message) || e),
                        source: item.name || item.key
                    };
                }
            }
        }
    }
    
    return analysis;
}

// ===== 智能化功能：表单自动化 =====

// 获取页面所有表单信息
async function getPageForms({ tabId, hostname } = {}) {
    const tab = await requireTab({ tabId, hostname });
    
    return new Promise((resolve, reject) => {
        adbExecuteScript({
            target: { tabId: tab.id },
            func: () => {
                const forms = Array.from(document.querySelectorAll('form, [class*="form"], [class*="login"]'));
                return forms.map((form, index) => {
                    const inputs = Array.from(form.querySelectorAll('input, select, textarea'));
                    const buttons = Array.from(form.querySelectorAll('button, input[type="submit"]'));
                    
                    return {
                        index,
                        id: form.id || null,
                        className: form.className || null,
                        action: form.action || null,
                        method: form.method || null,
                        inputs: inputs.map(input => ({
                            type: input.type,
                            name: input.name,
                            id: input.id,
                            placeholder: input.placeholder,
                            selector: input.id ? `#${input.id}` : 
                                      input.name ? `[name="${input.name}"]` :
                                      `input[type="${input.type}"]`
                        })),
                        buttons: buttons.map(btn => ({
                            text: btn.textContent?.trim(),
                            type: btn.type,
                            // V4.9.36：同 getDOMInfo —— className 在 SVG 上是对象，.split 会抛。
                            // 此处即便风险较低（HTML <button> 的 className 恒为字符串），
                            // 也按"全项目扫同类实例"补齐，避免下一次再有人照抄错的那份。
                            selector: btn.id ? `#${btn.id}` :
                                      (typeof btn.className === 'string' && btn.className) ? `.${btn.className.split(' ')[0]}` : 'button'
                        }))
                    };
                });
            },
            world: 'MAIN'
        }).then(results => {
            resolve(results[0]?.result || []);
        }).catch(reject);
    });
}

// 自动填充表单
async function autoFillForm({ formIndex = 0, values, tabId, hostname }) {
    const tab = await requireTab({ tabId, hostname });
    
    return new Promise((resolve, reject) => {
        // S3 双执行守卫（bug-hunt 2026-10-13）：保证"填表"只执行一次
        const dupTok = '__adbk_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        adbExecuteScript({
            target: { tabId: tab.id },
            func: (__tok, idx, vals) => {
                if (window[__tok]) return { __adbDupSkipped: true };
                try { window[__tok] = 1; } catch (e) { /* window 冻结：fail-open 放行 */ }
                const forms = Array.from(document.querySelectorAll('form, [class*="form"], [class*="login"]'));
                const form = forms[idx];
                if (!form) {
                    return { error: `未找到表单 ${idx}` };
                }
                
                const filled = [];
                for (const [selector, value] of Object.entries(vals)) {
                    const input = form.querySelector(selector) || document.querySelector(selector);
                    if (input) {
                        input.focus();
                        input.value = value;
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                        input.dispatchEvent(new Event('change', { bubbles: true }));
                        filled.push({ selector, value });
                    }
                }
                
                return { success: true, filled };
            },
            args: [dupTok, formIndex || 0, values || {}],
            world: 'MAIN'
        }).then(results => {
            resolve(results[0]?.result || { error: '执行失败' });
        }).catch(reject);
    });
}



// ===== 智能化功能：页面数据爬取 =====

// 提取页面结构化数据
async function extractPageData({ selectors, tabId, hostname }) {
    const tab = await requireTab({ tabId, hostname });
    
    return new Promise((resolve, reject) => {
        adbExecuteScript({
            target: { tabId: tab.id },
            func: (sels) => {
                const result = {};
                for (const [name, selector] of Object.entries(sels)) {
                    const elements = document.querySelectorAll(selector);
                    result[name] = Array.from(elements).map(el => ({
                        text: el.textContent?.trim(),
                        html: el.innerHTML?.substring(0, 200),
                        href: el.href || null,
                        src: el.src || null
                    }));
                }
                return result;
            },
            // V4.9.36：原为 `selectors || 'input, select, textarea'` —— **类型错了**。
            // 上面注入函数做的是 `Object.entries(sels)`，吃的是**映射表**；传字符串进去会被
            // 按**字符**拆成键值对（`[['0','i'],['1','n'],...]`），于是拿 `querySelectorAll('i')`
            // 挨个查，**静默产出一堆垃圾结果**——正是本项目最警惕的"没做成却看着像做成了"。
            // 当前够不到（工具层 zod 把 selectors 定为必填），但 fallback 写在就该是对的。
            args: [selectors || { '输入类元素': 'input, select, textarea' }],
            world: 'MAIN'
        }).then(results => {
            resolve(results[0]?.result || { error: '执行失败' });
        }).catch(reject);
    });
}

// 提取表格数据
async function extractTableData({ selector, tabId, hostname }) {
    const tab = await requireTab({ tabId, hostname });
    
    return new Promise((resolve, reject) => {
        adbExecuteScript({
            target: { tabId: tab.id },
            func: (sel) => {
                const table = document.querySelector(sel || 'table');
                if (!table) {
                    return { error: '未找到表格' };
                }
                
                const headers = Array.from(table.querySelectorAll('th')).map(th => th.textContent?.trim());
                const rows = Array.from(table.querySelectorAll('tbody tr')).map(tr => {
                    return Array.from(tr.querySelectorAll('td')).map(td => td.textContent?.trim());
                });
                
                return { headers, rows, rowCount: rows.length };
            },
            args: [selector || ''],
            world: 'MAIN'
        }).then(results => {
            resolve(results[0]?.result || { error: '执行失败' });
        }).catch(reject);
    });
}

// ===== Burp Suite 格式网络请求 =====

// 存储详细的请求数据（包括请求头和响应）
let detailedRequests = [];
const MAX_DETAILED_REQUESTS = 200;

// 添加详细请求
function addDetailedRequest(request) {
    detailedRequests.push(request);
    if (detailedRequests.length > MAX_DETAILED_REQUESTS) {
        detailedRequests = detailedRequests.slice(-MAX_DETAILED_REQUESTS);
    }
}

// 点击元素并捕获请求
async function clickAndCapture({ selector, waitTime = 3000, tabId, hostname }) {
    const tab = await requireTab({ tabId, hostname });
    
    // V4.9.22（修复🟡-3，审计指出）：原 `beforeCount = networkRequests.length` 方案已废弃——
    // 它有两个缺陷（① `networkRequests` 是**全标签页共享**缓冲，跨 await 后 slice 会把别的标签页
    // 的请求算成本次点击产生的；② 环形缓冲满 1000 时 splice 掉队首，`beforeCount=1000` 再进 N 条
    // 长度仍是 1000 → `slice(1000)=[]` **静默报 0**）。改用项目既有范式 `summarizeAfter(clickTs, tab.id)`。
    
    // 注入请求拦截器
    await new Promise((resolve, reject) => {
        // S3 双执行守卫（bug-hunt 2026-10-13）
        const dupTok = '__adbk_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        adbExecuteScript({
            target: { tabId: tab.id },
            func: (__tok) => {
                if (window[__tok]) return { __adbDupSkipped: true };
                try { window[__tok] = 1; } catch (e) { /* window 冻结：fail-open 放行 */ }
                // M3 修复：判重守卫——重复调用叠层 hook 会同一请求捕获 N 次（多按钮连续测试常见工作流）
                if (window.__adbCaptureHooked) {
                    window.__capturedRequests = window.__capturedRequests || [];
                    return 'already-hooked';
                }
                window.__adbCaptureHooked = true;
                window.__capturedRequests = [];
                
                // Hook XHR
                const originalXHROpen = XMLHttpRequest.prototype.open;
                const originalXHRSend = XMLHttpRequest.prototype.send;
                const originalXHRSetHeader = XMLHttpRequest.prototype.setRequestHeader;
                
                XMLHttpRequest.prototype.open = function(method, url) {
                    this._captureData = { method, url, headers: {}, startTime: Date.now() };
                    return originalXHROpen.apply(this, arguments);
                };
                
                XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
                    if (this._captureData) {
                        this._captureData.headers[name] = value;
                    }
                    return originalXHRSetHeader.apply(this, arguments);
                };
                
                // V4.9.17（抓包批次1-A2）：安全读响应文本——按 responseType 分支。
                // 原实现直接读 this.responseText：responseType='json'（axios 默认）等模式会抛
                // InvalidStateError → load 回调中断 → 整条记录（含请求体）丢失 + 异常冒泡进页面 window.onerror
                const safeReadXhrText = function(xhr, cap) {
                    try {
                        const rt = xhr.responseType;
                        let txt = '';
                        if (rt === '' || rt === 'text') txt = xhr.responseText || '';
                        else if (rt === 'json') { try { txt = JSON.stringify(xhr.response) || ''; } catch (e) { txt = '[json 序列化失败]'; } }
                        else if (rt === 'blob' && xhr.response) txt = '[blob ' + (xhr.response.size || '?') + 'B]';
                        else txt = '[' + (rt || 'binary') + ' ' + ((xhr.response && (xhr.response.byteLength || xhr.response.size)) || '?') + 'B]';
                        // 截断显式标记（批次1-B1：原 substring(0,10000) 无标记 = 静默损坏证据）
                        if (txt.length > cap) txt = txt.substring(0, cap) + '\n...[ADB 截断: 原始 ' + txt.length + ' 字符]';
                        return txt;
                    } catch (e) { return '[响应不可读: ' + (e && e.message) + ']'; }
                };

                XMLHttpRequest.prototype.send = function(body) {
                    if (this._captureData) {
                        // V4.9.18（验收⚪3）：非文本 body 归一——原样存 FormData/Blob 会在 toBurpFormat 里
                        // JSON.stringify 成 "{}" 冒充真 body（fetch 侧与主链路已修，此分支漏修）
                        const nb = (typeof body === 'string') ? body
                            : (body == null ? null : (function () { try { return (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) ? body.toString() : null; } catch (e) { return null; } })());
                        this._captureData.body = nb;
                        if (nb == null && body != null) {
                            try { this._captureData.bodyPlaceholder = Object.prototype.toString.call(body); } catch (e) { /* 忽略 */ }
                        }
                        const capture = this._captureData;

                        this.addEventListener('load', function() {
                            try {
                                capture.status = this.status;
                                capture.statusText = this.statusText;
                                capture.responseHeaders = this.getAllResponseHeaders();
                                capture.response = safeReadXhrText(this, 200000);
                                capture.endTime = Date.now();
                                window.__capturedRequests.push(capture);
                            } catch (e) { /* 采集失败绝不影响页面 */ }
                        });
                    }
                    return originalXHRSend.apply(this, arguments);
                };
                
                // Hook Fetch
                // V4.9.17（批次1-A1/A1护栏/B1/P1-7）：三处关键改动——
                // ① 读体移出调用链（原 await cloned.text() 挡在 return 前：SSE/流式被阻塞到全量读完；
                //    SSE 的 .text() 永不 resolve → 页面直接挂死）
                // ② Request 对象入参支持（原只读 init，method 记错 → 与 webRequest 归并时匹配断裂、body 全丢）
                // ③ 截断显式标记 + 200KB 上限（原 10000 无标记）
                const originalFetch = window.fetch;
                window.fetch = function(input, init = {}) {
                    const isReq = typeof Request !== 'undefined' && input instanceof Request;
                    const url = isReq ? input.url : (typeof input === 'string' ? input : String(input));
                    const method = init.method || (isReq ? input.method : 'GET');
                    const headers = init.headers || (isReq ? input.headers : {});
                    const body = init.body;
                    const nb = (typeof body === 'string') ? body
                        : (body == null ? null : (function () { try { return (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) ? body.toString() : null; } catch (e) { return null; } })());

                    const capture = {
                        method,
                        url,
                        headers: headers instanceof Headers ? Object.fromEntries(headers) : headers,
                        body: nb,
                        startTime: Date.now()
                    };
                    // 审计#3：非文本 body 不伪造占位字符串（原 '[Binary]'/'[Request 对象]' 会被当成真 body
                    // 算出伪 Content-Length 进 Burp 包——"看起来合法实际是假"的形态）——另记 bodyPlaceholder
                    if (nb == null && body != null) { try { capture.bodyPlaceholder = Object.prototype.toString.call(body); } catch (e) { capture.bodyPlaceholder = 'unknown'; } }
                    else if (nb == null && isReq) { capture.bodyPlaceholder = '[Request 对象]'; }

                    let pushed = false;
                    const finish = function() {
                        if (pushed) return; pushed = true;
                        try { window.__capturedRequests.push(capture); } catch (e) { /* 忽略 */ }
                    };
                    const readSide = function(response) {
                        try {
                            capture.status = response.status;
                            capture.statusText = response.statusText;
                            capture.responseHeaders = Object.fromEntries(response.headers);
                            const ctype = String(response.headers.get('content-type') || '');
                            if (ctype.indexOf('text/event-stream') !== -1) {
                                // 审计#4：SSE 的 .text() 永不 resolve（clone 无背压会静默涨内存）——直接跳过
                                capture.response = '[SSE 流未读取]';
                                capture.endTime = Date.now();
                                finish();
                                return;
                            }
                            const len = parseInt(response.headers.get('content-length') || '0', 10);
                            if (len > 200000) {   // 护栏：大响应不读 clone（tee 无背压，只读一支 = 全量驻留内存）
                                capture.response = '[oversize ' + len + 'B 未读取]';
                                capture.endTime = Date.now();
                                finish();
                                return;
                            }
                            // 审计#4：先入库（push 对象引用）body 到达后回填——长流/慢响应期间记录也可读
                            // （原实现 body 不 settle 则永不入库，SSE/长流请求在 include_body 里静默消失）
                            capture.response = '[读取中]';
                            capture.endTime = Date.now();
                            finish();
                            const cloned = response.clone();
                            cloned.text().then(function(t) {
                                capture.response = t.length > 200000
                                    ? t.substring(0, 200000) + '\n...[ADB 截断: 原始 ' + t.length + ' 字符]'
                                    : t;
                            }).catch(function() {
                                capture.response = '[响应体不可读]';
                            });
                        } catch (e) {
                            capture.error = '采集异常: ' + (e && e.message);
                            // V4.9.18（验收⚪4）：已入库记录停在 [读取中] 时改写为可读原因
                            if (capture.response === '[读取中]') capture.response = '[响应体不可读: ' + (e && e.message) + ']';
                            capture.endTime = Date.now();
                            finish();
                        }
                    };

                    let p;
                    try { p = originalFetch.apply(this, arguments); }
                    catch (e) { capture.error = e && e.message; capture.endTime = Date.now(); finish(); throw e; }
                    // 旁路读体：页面拿到的仍是原生 promise，交付不被我们阻塞
                    p.then(readSide, function(error) {
                        capture.error = error && error.message;
                        capture.endTime = Date.now();
                        finish();
                    });
                    return p;
                };
                
                return { success: true };
            },
            args: [dupTok],
            world: 'MAIN'
        }).then(resolve).catch(reject);
    });

    // 点击元素
    // V4.9.22（修复🔴）：**接收** resolve 值——原实现 `await new Promise` 不赋值，点击脚本返回的
    // `{error: '未找到元素'}` 被整个丢弃，于是本函数永远只报"成功形态"（见下方返回体注释）
    // V4.9.22（修复🟡-3）：点击起点时刻——供 summarizeAfter 划定"本次点击产生的请求"的时间下界
    const clickTs = Date.now();
    const clickResult = await new Promise((resolve, reject) => {
        // S3 双执行守卫（bug-hunt 2026-10-13）：防"点击"双执行
        const dupTok = '__adbk_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        adbExecuteScript({
            target: { tabId: tab.id },
            func: (__tok, sel) => {
                if (window[__tok]) return { __adbDupSkipped: true };
                try { window[__tok] = 1; } catch (e) { /* window 冻结：fail-open 放行 */ }
                const element = document.querySelector(sel);
                if (!element) {
                    return { error: `未找到元素: ${sel}` };
                }
                element.click();
                return { success: true, clicked: sel };
            },
            args: [dupTok, selector || ''],
            world: 'MAIN'
        }).then(results => {
            resolve(results[0]?.result || { error: '点击失败' });
        }).catch(reject);
    });
    
    // 等待请求完成
    await new Promise(resolve => setTimeout(resolve, waitTime));
    
    // 获取捕获的请求
    const captured = await new Promise((resolve, reject) => {
        adbExecuteScript({
            target: { tabId: tab.id },
            func: () => window.__capturedRequests || [],
            world: 'MAIN'
        }).then(results => {
            resolve(results[0]?.result || []);
        }).catch(reject);
    });

    // V4.9.22（修复🔴）：如实暴露点击结果。原返回体恒为"成功形态"（`clickedSelector` 只是入参回显、
    // 不含任何成败信息）——元素不存在时 AI 会读成"点中了但该站不触发请求"，得出错误归因。
    const clicked = !!(clickResult && clickResult.success);
    // V4.9.22（修复🟡-3）：同时按 timestamp 与 tabId 过滤（summarizeAfter 既有范式）——
    // 消除"跨标签页串数据"与"环形缓冲满时静默报 0"两个缺陷
    const clickSumErr = {};
    const newRequests = summarizeAfter(clickTs, tab.id, 20, clickSumErr);
    return {
        clicked,                                    // 点击是否**真的发生**（原字段无法判断）
        clickedSelector: selector,
        ...(clicked ? {} : { error: (clickResult && clickResult.error) || '点击未成功', clickResult }),
        capturedCount: captured.length,
        requests: captured,
        // V4.9.22：本次点击**新产生**的请求摘要（按 tabId + 时间双过滤）
        newRequestCount: newRequests.length,
        newRequests,
        // V4.9.28：摘要失败时标记——否则 newRequestCount:0 会被读成"点击没有触发任何请求"
        ...(clickSumErr.error ? { newRequestsUnavailable: clickSumErr.error } : {})
    };
}

// 转换为 Burp Suite 格式
// V4.9.17（审计#1/#2）：头形态归一——三条数据链的 headers 形态各不相同：
// 页面 hook XHR 给原始文本串（getAllResponseHeaders）、fetch 给 object、webRequest 给 [{name,value}]。
// 统一输出 [[name, value], ...]（**保序保重复头**——Burp 实测原样转发，Cookie 多行不合并；RFC 9110 §5.2）
function normHeaders(v) {
    if (!v) return null;
    if (Array.isArray(v)) {
        const out = [];
        for (const h of v) { if (h && h.name != null) out.push([String(h.name), h.value == null ? '' : String(h.value)]); }
        return out;
    }
    if (typeof v === 'string') {
        const out = [];
        for (const line of v.split('\n')) {
            const t = line.trim();
            if (!t) continue;
            const i = t.indexOf(':');
            if (i <= 0) continue;
            out.push([t.slice(0, i).trim(), t.slice(i + 1).trim()]);
        }
        return out;
    }
    try { return Object.entries(v).map(([k, val]) => [k, val == null ? '' : String(val)]); } catch (e) { return null; }
}

function toBurpFormat(requests) {
    return requests.map((req, index) => {
        const url = new URL(req.url, 'http://localhost');
        const host = url.hostname;
        const port = url.port || (url.protocol === 'https:' ? '443' : '80');
        const path = url.pathname + url.search;
        
        // 构建请求头
        let requestHeaders = `${req.method} ${path} HTTP/1.1\r\n`;
        requestHeaders += `Host: ${host}\r\n`;

        // V4.9.17（审计#1/#2）：**接入真实头**——webRequest(extraHeaders) 采的 requestHeaders（数组，含
        // Cookie/Authorization/真实 UA）或页面 hook 的 headers（object/文本串），统一 normHeaders 归一、保重复头
        const reqHdrs = normHeaders(req.headers || req.requestHeaders);
        if (reqHdrs) {
            for (const [name, value] of reqHdrs) {
                const low = name.toLowerCase();
                if (low === 'host') continue;                       // Host 由我们统一输出
                if (name.charAt(0) === ':') continue;               // V4.9.18：H2 伪头过滤（实测：伪头经 Burp 原样发上线 = 畸形请求）
                if (low === 'transfer-encoding') continue;          // V4.9.18：删 TE（body 已是解码态；CL+TE 并存 = 走私形状；残留让服务端挂起等终止符）
                if (low === 'content-length') continue;             // V4.9.18：CL 一律由我们按真实（可能截断后的）body 重算，防双 CL 冲突
                requestHeaders += `${name}: ${value}\r\n`;
            }
        }

        // V4.9.17（批次1-B2）：已删除"常见请求头补充"（原为硬编码假 UA Chrome/120 与猜测的 Accept/Content-Type——
        // 渗透场景属幻觉数据）。真实头由 webRequest+extraHeaders 全量采集并经上方归一接入。
        // 请求体归一化（bug-hunt M6：非字符串 body 原样 += 会变 "[object Object]"；CL 原用 String.length 谎报字节数）
        let requestBodyText = '';
        const rawBody = req.body !== undefined ? req.body : req.requestBody;
        if (typeof rawBody === 'string' && rawBody) {
            requestBodyText = rawBody;
        } else if (rawBody && typeof rawBody === 'object') {
            try { requestBodyText = JSON.stringify(rawBody); } catch (e) { requestBodyText = String(rawBody); }
        }
        let bodyBinary = false;
        if (requestBodyText) {
            // V4.9.18（调研规则6）：二进制 body 旁路——含控制字符（TAB/LF/CR 除外）就不塞进文本 raw
            // （塞进去是乱码 + CL 失真；完整数据无文本形态可表达，只出注释头）
            if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(requestBodyText)) {
                bodyBinary = true;
                requestHeaders += `X-ADB-Body-Binary: true\r\n`;   // 不写 CL、不拼 body
            } else {
                let bodyLen = 0;
                try { bodyLen = new TextEncoder().encode(requestBodyText).length; } catch (e) { bodyLen = requestBodyText.length; }
                requestHeaders += `Content-Length: ${bodyLen}\r\n`;
                if (/\[ADB 截断/.test(requestBodyText)) {
                    requestHeaders += `X-ADB-Body-Truncated: true\r\n`;   // 截断过的 body 必须标注（CL 按截断后字节算）
                }
            }
        } else if (req.bodyPlaceholder) {
            // 审计#3：未采集的 body 只注释、**不伪造 body、不写 Content-Length**
            requestHeaders += `X-ADB-Body-Not-Captured: ${String(req.bodyPlaceholder).replace(/[\r\n]/g, ' ')}\r\n`;
        }
        // V4.9.21（审计🟡-1）：SW 回收后从分层落盘恢复的记录不含头——必须**包内可见**。
        // 否则产出一条"语法合法、无 Cookie、看起来可直接重放"的包，读包人会误判"原请求本来就没有 Cookie"
        // （与本函数既有 X-ADB-Body-Truncated / Not-Captured 同款做法；违禁静默降级）
        if (req.headersOmitted) {
            requestHeaders += `X-ADB-Headers-Omitted: true (恢复记录不含头——分层落盘仅最近100条含头)\r\n`;
        }

        requestHeaders += `\r\n`;

        // 请求体
        if (requestBodyText && !bodyBinary) {
            requestHeaders += requestBodyText;
        }

        // 构建响应头（审计#1/#2：statusCode 归一——webRequest 链路的字段名是 statusCode；响应头/体同样多形态归一）
        const statusCode = req.status || req.statusCode;
        let responseHeaders = '';
        if (statusCode) {
            responseHeaders = `HTTP/1.1 ${statusCode} ${req.statusText || 'OK'}\r\n`;
            const resHdrs = normHeaders(req.responseHeaders);
            if (resHdrs) {
                for (const [name, value] of resHdrs) {
                    responseHeaders += `${name}: ${value}\r\n`;
                }
            }
            responseHeaders += `\r\n`;
            const resBody = req.response !== undefined ? req.response : req.responseBody;
            if (typeof resBody === 'string' && resBody) {
                responseHeaders += resBody;
            }
        }

        const resBodyStr = typeof req.response === 'string' ? req.response : (typeof req.responseBody === 'string' ? req.responseBody : '');
        return {
            index: index + 1,
            host,
            port,
            protocol: url.protocol.replace(':', ''),
            method: req.method,
            path,
            status: statusCode,
            length: resBodyStr.length,
            // V4.9.18（验收⚪5d）：length 是字符数（易与字节数混淆——中文站差异大）——补 lengthBytes 明确字节
            lengthBytes: (() => { try { return new TextEncoder().encode(resBodyStr).length; } catch (e) { return resBodyStr.length; } })(),
            duration: req.endTime && req.startTime ? `${req.endTime - req.startTime}ms` : 'N/A',
            request: requestHeaders,
            response: responseHeaders,
            // V4.9.18（验收⚪5a）：警示提到成品块（原先只在 raw 里——而 Burp 路径恰恰最需要它：
            // 旧 hook 直接影响包质量，读包人必须看到）
            // V4.9.21（审计🟡-1）：缺头警示同样提到成品块（两种警示可同时出现，合并为一个 warn 字段）
            ...((req.hookStale || req.headersOmitted) ? { warn: [
                req.hookStale,
                req.headersOmitted ? '请求头未随 SW 恢复（分层落盘仅最近 100 条含头）——Cookie/Authorization 缺失≠原请求没有' : null
            ].filter(Boolean).join(' | ') } : {}),
            // 原始数据
            raw: req
        };
    });
}

// 获取 Burp 格式的网络请求
// V4.9.17（审计#1）：改走归并链路——原只读 webRequest 元数据（无 body），现在 include_body 归并页面 hook 的
// 请求体/响应体；webRequest(extraHeaders) 采的真实头本就在元数据里 → 输出"完整可重放包"（Cookie/真实 UA/body/响应）
async function getNetworkRequestsBurp({ filter, limit = 50, tabId } = {}) {
    let requests;
    let degraded = null;
    try {
        requests = await getNetworkRequests({ filter, limit, tabId, includeBody: true });
    } catch (e) {
        // 归并失败（页面 hook 不可用等）→ 降级为纯元数据（头仍完整，body 缺）
        // V4.9.23（缺陷🟡-24）：原降级路径**丢 tabId 过滤**——多标签下会把别的标签页的请求
        // 混进"目标站的完整包"里，而且返回体无任何标记（AI 拿去重放会打到错的站）；
        // 且原实现在 slice 之后才 filter，与主路径"先过滤后截断"语义相反（命中被前面的噪声挤掉）
        degraded = (e && e.message) || String(e);
        requests = [...networkRequests];
        if (typeof tabId === 'number') requests = requests.filter(r => r && r.tabId === tabId);
        if (filter) {
            const fLow = filter.toLowerCase();
            requests = requests.filter(r => String((r && r.url) || '').toLowerCase().includes(fLow));
        }
        requests = requests.slice(-limit);
    }
    return {
        total: requests.length,
        ...(typeof tabId === 'number' ? { tabId } : {}),
        ...(degraded ? {
            degraded: true,
            degradedReason: 'body 归并不可用（页面 hook 未注入或页面未刷新）——本次**仅返回 webRequest 元数据**，请求体/响应体缺失（并非该请求本就没有 body）',
            degradedError: degraded
        } : {}),
        burpFormat: toBurpFormat(requests)
    };
}

// V4.9.18（批次2）：单条请求全量详情——两段式工作流第二段：
// get_network_requests（精简列表拿 requestId）→ 本函数（单条完整头/体，含 body 归并）
async function getNetworkRequestDetail({ requestId, tabId } = {}) {
    const rid = String(requestId == null ? '' : requestId);
    if (!rid) throw new Error('缺少 request_id 参数');
    const entry = networkRequestIndex.get(rid) || networkRequests.find(r => String(r.requestId) === rid);
    if (!entry) {
        throw new Error('未找到 requestId=' + rid + ' 的记录（可能已被环形缓冲淘汰，或扩展重载后缓冲清空——重新触发一次请求即可）');
    }
    // 复用 include_body 归并（含头/体）后取该条；归并失败降级为元数据
    try {
        const list = await getNetworkRequests({
            limit: 1000,
            includeBody: true,
            tabId: typeof tabId === 'number' ? tabId : entry.tabId
        });
        const hit = Array.isArray(list) ? list.find(r => String(r.requestId) === rid) : null;
        if (hit) return hit;
        // V4.9.25（清单🟡-16）：归并跑通但**这一条**没命中——同样要说明，否则与"归并失败"不可分
        return {
            ...entry,
            bodyMergeFailed: true,
            bodyMergeNote: 'body 归并未覆盖本条（页面 hook 无对应记录：可能未注入 hook、页面未刷新、或请求早于 hook 生效）——本次为**纯元数据**，请求体/响应体缺失**并非该请求本来就没有 body**'
        };
    } catch (e) {
        // V4.9.25（清单🟡-16）：**降级必须留标记**——原实现静默 return entry，调用方无法区分
        // "这条请求本来就没有 body" 与 "归并整体不可用"。对齐本项目 `X-ADB-Body-Truncated` 既有范式
        return {
            ...entry,
            bodyMergeFailed: true,
            bodyMergeError: (e && e.message) || String(e),
            bodyMergeNote: 'body 归并整体不可用（页面 hook 未注入/页面未刷新）——本次为**纯元数据**，请求体/响应体缺失**并非该请求本来就没有 body**'
        };
    }
}

// 点击并获取 Burp 格式请求
// bug-hunt S2（2026-10-13）：原签名丢弃 tabId/hostname（server 明确发送、schema 对外承诺 tab_id）——
// 会在**活动标签页**上真实点击+抓包而返回体无提示（同 L6 型的跨标签错点，且带真实副作用）
async function clickAndGetBurp({ selector, waitTime = 3000, tabId, hostname }) {
    const result = await clickAndCapture({ selector, waitTime, tabId, hostname });
    
    if (result.error) {
        return result;
    }
    
    const burpRequests = toBurpFormat(result.requests);
    
    return {
        clicked: result.clickedSelector,
        totalRequests: result.capturedCount,
        burpRequests
    };
}

// 自动登录并获取 Burp 格式请求
async function loginAndGetBurp({ username, password, usernameSelector, passwordSelector, submitSelector, waitTime = 3000, tabId, hostname }) {
    const tab = await requireTab({ tabId, hostname });
    
    // 先注入请求拦截器
    await new Promise((resolve, reject) => {
        // S3 双执行守卫（bug-hunt 2026-10-13）
        const dupTok = '__adbk_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        adbExecuteScript({
            target: { tabId: tab.id },
            func: (__tok) => {
                if (window[__tok]) return { __adbDupSkipped: true };
                try { window[__tok] = 1; } catch (e) { /* window 冻结：fail-open 放行 */ }
                // M3 修复：判重守卫（同 clickAndCapture）
                if (window.__adbCaptureHooked) {
                    window.__capturedRequests = window.__capturedRequests || [];
                    return 'already-hooked';
                }
                window.__adbCaptureHooked = true;
                window.__capturedRequests = [];
                
                // Hook XHR
                const originalXHROpen = XMLHttpRequest.prototype.open;
                const originalXHRSend = XMLHttpRequest.prototype.send;
                const originalXHRSetHeader = XMLHttpRequest.prototype.setRequestHeader;
                
                XMLHttpRequest.prototype.open = function(method, url) {
                    this._captureData = { method, url, headers: {}, startTime: Date.now() };
                    return originalXHROpen.apply(this, arguments);
                };
                
                XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
                    if (this._captureData) {
                        this._captureData.headers[name] = value;
                    }
                    return originalXHRSetHeader.apply(this, arguments);
                };
                
                // V4.9.17（抓包批次1-A2）：安全读响应文本——按 responseType 分支。
                // 原实现直接读 this.responseText：responseType='json'（axios 默认）等模式会抛
                // InvalidStateError → load 回调中断 → 整条记录（含请求体）丢失 + 异常冒泡进页面 window.onerror
                const safeReadXhrText = function(xhr, cap) {
                    try {
                        const rt = xhr.responseType;
                        let txt = '';
                        if (rt === '' || rt === 'text') txt = xhr.responseText || '';
                        else if (rt === 'json') { try { txt = JSON.stringify(xhr.response) || ''; } catch (e) { txt = '[json 序列化失败]'; } }
                        else if (rt === 'blob' && xhr.response) txt = '[blob ' + (xhr.response.size || '?') + 'B]';
                        else txt = '[' + (rt || 'binary') + ' ' + ((xhr.response && (xhr.response.byteLength || xhr.response.size)) || '?') + 'B]';
                        // 截断显式标记（批次1-B1：原 substring(0,10000) 无标记 = 静默损坏证据）
                        if (txt.length > cap) txt = txt.substring(0, cap) + '\n...[ADB 截断: 原始 ' + txt.length + ' 字符]';
                        return txt;
                    } catch (e) { return '[响应不可读: ' + (e && e.message) + ']'; }
                };

                XMLHttpRequest.prototype.send = function(body) {
                    if (this._captureData) {
                        // V4.9.18（验收⚪3）：非文本 body 归一——原样存 FormData/Blob 会在 toBurpFormat 里
                        // JSON.stringify 成 "{}" 冒充真 body（fetch 侧与主链路已修，此分支漏修）
                        const nb = (typeof body === 'string') ? body
                            : (body == null ? null : (function () { try { return (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) ? body.toString() : null; } catch (e) { return null; } })());
                        this._captureData.body = nb;
                        if (nb == null && body != null) {
                            try { this._captureData.bodyPlaceholder = Object.prototype.toString.call(body); } catch (e) { /* 忽略 */ }
                        }
                        const capture = this._captureData;

                        this.addEventListener('load', function() {
                            try {
                                capture.status = this.status;
                                capture.statusText = this.statusText;
                                capture.responseHeaders = this.getAllResponseHeaders();
                                capture.response = safeReadXhrText(this, 200000);
                                capture.endTime = Date.now();
                                window.__capturedRequests.push(capture);
                            } catch (e) { /* 采集失败绝不影响页面 */ }
                        });
                    }
                    return originalXHRSend.apply(this, arguments);
                };
                
                // Hook Fetch
                // V4.9.17（批次1-A1/A1护栏/B1/P1-7）：与 clickAndCapture 同一修法（非阻塞读体/Request 对象/截断标记）
                const originalFetch = window.fetch;
                window.fetch = function(input, init = {}) {
                    const isReq = typeof Request !== 'undefined' && input instanceof Request;
                    const url = isReq ? input.url : (typeof input === 'string' ? input : String(input));
                    const method = init.method || (isReq ? input.method : 'GET');
                    const headers = init.headers || (isReq ? input.headers : {});
                    const body = init.body;
                    const nb = (typeof body === 'string') ? body
                        : (body == null ? null : (function () { try { return (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) ? body.toString() : null; } catch (e) { return null; } })());

                    const capture = {
                        method,
                        url,
                        headers: headers instanceof Headers ? Object.fromEntries(headers) : headers,
                        body: nb,
                        startTime: Date.now()
                    };
                    // 审计#3：非文本 body 不伪造占位字符串（原 '[Binary]'/'[Request 对象]' 会被当成真 body
                    // 算出伪 Content-Length 进 Burp 包——"看起来合法实际是假"的形态）——另记 bodyPlaceholder
                    if (nb == null && body != null) { try { capture.bodyPlaceholder = Object.prototype.toString.call(body); } catch (e) { capture.bodyPlaceholder = 'unknown'; } }
                    else if (nb == null && isReq) { capture.bodyPlaceholder = '[Request 对象]'; }

                    let pushed = false;
                    const finish = function() {
                        if (pushed) return; pushed = true;
                        try { window.__capturedRequests.push(capture); } catch (e) { /* 忽略 */ }
                    };
                    const readSide = function(response) {
                        try {
                            capture.status = response.status;
                            capture.statusText = response.statusText;
                            capture.responseHeaders = Object.fromEntries(response.headers);
                            const ctype = String(response.headers.get('content-type') || '');
                            if (ctype.indexOf('text/event-stream') !== -1) {
                                // 审计#4：SSE 的 .text() 永不 resolve（clone 无背压会静默涨内存）——直接跳过
                                capture.response = '[SSE 流未读取]';
                                capture.endTime = Date.now();
                                finish();
                                return;
                            }
                            const len = parseInt(response.headers.get('content-length') || '0', 10);
                            if (len > 200000) {   // 护栏：大响应不读 clone（tee 无背压，只读一支 = 全量驻留内存）
                                capture.response = '[oversize ' + len + 'B 未读取]';
                                capture.endTime = Date.now();
                                finish();
                                return;
                            }
                            // 审计#4：先入库（push 对象引用）body 到达后回填——长流/慢响应期间记录也可读
                            // （原实现 body 不 settle 则永不入库，SSE/长流请求在 include_body 里静默消失）
                            capture.response = '[读取中]';
                            capture.endTime = Date.now();
                            finish();
                            const cloned = response.clone();
                            cloned.text().then(function(t) {
                                capture.response = t.length > 200000
                                    ? t.substring(0, 200000) + '\n...[ADB 截断: 原始 ' + t.length + ' 字符]'
                                    : t;
                            }).catch(function() {
                                capture.response = '[响应体不可读]';
                            });
                        } catch (e) {
                            capture.error = '采集异常: ' + (e && e.message);
                            // V4.9.18（验收⚪4）：已入库记录停在 [读取中] 时改写为可读原因
                            if (capture.response === '[读取中]') capture.response = '[响应体不可读: ' + (e && e.message) + ']';
                            capture.endTime = Date.now();
                            finish();
                        }
                    };

                    let p;
                    try { p = originalFetch.apply(this, arguments); }
                    catch (e) { capture.error = e && e.message; capture.endTime = Date.now(); finish(); throw e; }
                    // 旁路读体：页面拿到的仍是原生 promise，交付不被我们阻塞
                    p.then(readSide, function(error) {
                        capture.error = error && error.message;
                        capture.endTime = Date.now();
                        finish();
                    });
                    return p;
                };
                
                return { success: true };
            },
            args: [dupTok],
            world: 'MAIN'
        }).then(resolve).catch(reject);
    });

    // 填写表单
    // V4.9.22（修复🔴）：**接收** resolve 值——原实现不赋值，`{usernameFound, passwordFound}` 被整个丢弃，
    // 表单元素一个都没找到时同样返回"成功形态"（AI 会读成"填好了但登录不触发请求"）
    const fillResult = await new Promise((resolve, reject) => {
        adbExecuteScript({
            target: { tabId: tab.id },
            func: (user, pwd, userSel, pwdSel) => {
                const usernameInput = document.querySelector(userSel || 'input[type="text"], input[placeholder*="账号"], input[placeholder*="用户"], input[name="username"]');
                const passwordInput = document.querySelector(pwdSel || 'input[type="password"]');
                
                if (usernameInput) {
                    usernameInput.focus();
                    usernameInput.value = user;
                    usernameInput.dispatchEvent(new Event('input', { bubbles: true }));
                    usernameInput.dispatchEvent(new Event('change', { bubbles: true }));
                }
                
                if (passwordInput) {
                    passwordInput.focus();
                    passwordInput.value = pwd;
                    passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
                    passwordInput.dispatchEvent(new Event('change', { bubbles: true }));
                }
                
                return { usernameFound: !!usernameInput, passwordFound: !!passwordInput };
            },
            args: [username || '', password || '', usernameSelector || '', passwordSelector || ''],
            world: 'MAIN'
        }).then(results => {
            resolve(results[0]?.result || { error: '填写失败' });
        }).catch(reject);
    });
    
    // 等待表单响应
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // 点击登录按钮
    // V4.9.22（修复🔴）：同填写段——**接收** resolve 值，否则 `{clicked:false, error:'未找到登录按钮'}`
    // 被丢弃（按钮压根没点到也报成功）
    const clickResult = await new Promise((resolve, reject) => {
        adbExecuteScript({
            target: { tabId: tab.id },
            func: (submitSel) => {
                const submitBtn = document.querySelector(submitSel || 'button[type="submit"], .login-btn, .el-button--primary, button.ant-btn-primary');
                if (submitBtn) {
                    submitBtn.click();
                    return { clicked: true };
                }
                // 尝试查找包含"登录"文字的按钮
                const buttons = document.querySelectorAll('button');
                for (const btn of buttons) {
                    if (btn.textContent && btn.textContent.includes('登录')) {
                        btn.click();
                        return { clicked: true, text: btn.textContent };
                    }
                }
                return { clicked: false, error: '未找到登录按钮' };
            },
            args: [submitSelector || ''],
            world: 'MAIN'
        }).then(results => {
            resolve(results[0]?.result || { error: '点击失败' });
        }).catch(reject);
    });
    
    // 等待请求完成
    await new Promise(resolve => setTimeout(resolve, waitTime));
    
    // 获取捕获的请求
    const captured = await new Promise((resolve, reject) => {
        adbExecuteScript({
            target: { tabId: tab.id },
            func: () => window.__capturedRequests || [],
            world: 'MAIN'
        }).then(results => {
            resolve(results[0]?.result || []);
        }).catch(reject);
    });
    
    // V4.9.22（修复🔴×2）：
    //  ① 如实暴露填写/点击结果——原实现两处 `await new Promise` 都不接收 resolve 值，
    //     表单找不到、登录按钮没点到时一律返回"成功形态"，AI 会误判"该站登录不触发请求"；
    //  ② **删除凭据明文回显**——原返回体带 `username`/`password` 原样回显，毫无功能价值
    //     （调用方本就知道自己传了什么），却让账号密码进入 AI 上下文与会话记录（我方隐私纪律）。
    const usernameFound = !!(fillResult && fillResult.usernameFound);
    const passwordFound = !!(fillResult && fillResult.passwordFound);
    const clicked = !!(clickResult && clickResult.clicked);
    return {
        usernameFound,
        passwordFound,
        clicked,
        ...((usernameFound && passwordFound && clicked) ? {} : {
            error: '登录流程未完整走通——' + [
                usernameFound ? null : '未找到用户名输入框',
                passwordFound ? null : '未找到密码输入框',
                clicked ? null : '未找到/未点中登录按钮'
            ].filter(Boolean).join('；') + '（可用 username_selector / password_selector / submit_selector 显式指定）'
        }),
        totalRequests: captured.length,
        burpRequests: toBurpFormat(captured)
    };
}

// ===== 敏感数据检测功能 =====

// 存储捕获的请求响应体
let requestsWithBody = [];
const MAX_REQUESTS_WITH_BODY = 100;

// 敏感数据告警
let sensitiveAlerts = [];
let sensitiveMonitorEnabled = false;
let sensitiveMonitorPatterns = ['idCard', 'phone', 'bankCard', 'password'];

// 获取带响应体的网络请求
async function getNetworkRequestsWithBody({ filter, limit = 20, tabId, hostname } = {}) {
    // V4.9.10：支持 tabId（供 getNetworkRequests 的 include_body 整合指定目标；走后台优先语义解析）
    // V4.9.26（子代理审计抓出）：原签名**只解构 tabId**，hostname 被整个丢掉 → 工具层传了也没用。
    // 同文件的 getJSChunks/getPageContent 早已是 { tabId, hostname } 形态，此处对齐。
    const tab = await requireTab({ tabId, hostname });
    
    // 先注入请求拦截器（如果尚未注入）
    // V4.9.17（审计#6）：旧版本 hook 检测——MAIN world 标记在扩展重载后不消失，旧（阻塞版）hook 会继续服务
    // 且新注入被静默跳过（调用方"拿到成功"但行为是旧的）
    let hookStale = false;
    await new Promise((resolve, reject) => {
        adbExecuteScript({
            target: { tabId: tab.id },
            func: () => {
                if (window.__requestBodyCapture) {
                    // __requestBodyCaptureV2 缺失 = 旧版本 hook（扩展重载前注入）
                    return { alreadyInjected: true, stale: !window.__requestBodyCaptureV2, requests: window.__capturedRequestsWithBody || [] };
                }

                window.__requestBodyCapture = true;
                window.__requestBodyCaptureV2 = 1;
                window.__capturedRequestsWithBody = window.__capturedRequestsWithBody || [];
                
                // V4.9.10.2（审计 M-1）：body 归一化——FormData/Blob/URLSearchParams 等非字符串 body
                // 直接存引用会在跨进程回传时序列化失败（整次调用 reject）或变 "[object Object]"（假数据）
                // V4.9.17（审计#3）：非文本 body 返回 null（原占位字符串会被当成真 body 算出伪 Content-Length
                // 进 Burp 包——"看起来合法实际是假"；占位信息改走 bodyPlaceholder 字段）
                const normalizeBody = (b) => {
                    if (b == null) return undefined;
                    if (typeof b === 'string') return b;
                    try { if (typeof URLSearchParams !== 'undefined' && b instanceof URLSearchParams) return b.toString(); } catch (e) { /* 继续 */ }
                    return null;
                };

                // Hook XHR
                // V4.9.17（批次1-A2/B1）：按 responseType 分支安全读体（原直接读 responseText——
                // responseType='json'（axios 默认）抛 InvalidStateError 导致整条丢失 + 异常泄漏页面）
                const originalXHROpen = XMLHttpRequest.prototype.open;
                const originalXHRSend = XMLHttpRequest.prototype.send;

                XMLHttpRequest.prototype.open = function(method, url) {
                    this._captureInfo = { method, url: String(url), startTime: Date.now() }; // V4.9.10.2：URL 对象场景 String 兜底
                    return originalXHROpen.apply(this, arguments);
                };

                const pushBounded = function(item) {
                    window.__capturedRequestsWithBody.push(item);
                    if (window.__capturedRequestsWithBody.length > 100) {
                        window.__capturedRequestsWithBody = window.__capturedRequestsWithBody.slice(-100);
                    }
                };
                const safeReadXhrText = function(xhr, cap) {
                    try {
                        const rt = xhr.responseType;
                        let txt = '';
                        if (rt === '' || rt === 'text') txt = xhr.responseText || '';
                        else if (rt === 'json') { try { txt = JSON.stringify(xhr.response) || ''; } catch (e) { txt = '[json 序列化失败]'; } }
                        else if (rt === 'blob' && xhr.response) txt = '[blob ' + (xhr.response.size || '?') + 'B]';
                        else txt = '[' + (rt || 'binary') + ' ' + ((xhr.response && (xhr.response.byteLength || xhr.response.size)) || '?') + 'B]';
                        // 截断显式标记（批次1-B1：原 substring(0,50000) 无标记 = 静默损坏证据）
                        if (txt.length > cap) txt = txt.substring(0, cap) + '\n...[ADB 截断: 原始 ' + txt.length + ' 字符]';
                        return txt;
                    } catch (e) { return '[响应不可读: ' + (e && e.message) + ']'; }
                };

                XMLHttpRequest.prototype.send = function(body) {
                    if (this._captureInfo) {
                        this._captureInfo.requestBody = normalizeBody(body);
                        // 审计#3：非文本 body 另记占位（不伪造进 requestBody，避免伪 body+伪 CL 进 Burp 包）
                        if (this._captureInfo.requestBody == null && body != null) {
                            try { this._captureInfo.bodyPlaceholder = Object.prototype.toString.call(body); } catch (e) { /* 忽略 */ }
                        }
                        const info = this._captureInfo;

                        this.addEventListener('load', function() {
                            try {
                                info.statusCode = this.status;
                                info.responseBody = safeReadXhrText(this, 200000);
                                info.endTime = Date.now();
                                pushBounded(info);
                            } catch (e) { /* 采集失败绝不影响页面 */ }
                        });
                    }
                    return originalXHRSend.apply(this, arguments);
                };

                // Hook Fetch
                // V4.9.17（批次1-A1/A1护栏/B1/P1-7）：
                // ① 读体移出调用链（原 await cloned.text() 挡在 return 前：SSE/流式被阻塞到全量读完；
                //    SSE 的 .text() 永不 resolve → 页面直接挂死）
                // ② Request 对象入参（原只读 init → method 记错 → 归并匹配断裂、body 全丢）
                // ③ 截断显式标记 + 200KB 上限 + oversize 护栏（大响应不读 clone，防 tee 无背压内存滞留）
                const originalFetch = window.fetch;
                window.fetch = function(input, init = {}) {
                    const isReq = typeof Request !== 'undefined' && input instanceof Request;
                    const url = isReq ? input.url : (typeof input === 'string' ? input : String(input));
                    const method = init.method || (isReq ? input.method : 'GET');
                    const info = { method, url: String(url), startTime: Date.now(), requestBody: normalizeBody(init.body) };
                    // 审计#3：非文本 body 另记占位（不伪造进 requestBody，避免伪 body+伪 CL 进 Burp 包）
                    if (info.requestBody == null && (init.body != null || isReq)) {
                        try { info.bodyPlaceholder = init.body != null ? Object.prototype.toString.call(init.body) : '[Request 对象]'; } catch (e) { info.bodyPlaceholder = 'unknown'; }
                    }

                    let pushed = false;
                    const finish = function() { if (pushed) return; pushed = true; pushBounded(info); };
                    const readSide = function(response) {
                        try {
                            info.statusCode = response.status;
                            const ctype = String(response.headers.get('content-type') || '');
                            if (ctype.indexOf('text/event-stream') !== -1) {
                                // 审计#4：SSE 的 .text() 永不 resolve（clone 无背压会静默涨内存）——直接跳过
                                info.responseBody = '[SSE 流未读取]';
                                info.endTime = Date.now();
                                finish();
                                return;
                            }
                            const len = parseInt(response.headers.get('content-length') || '0', 10);
                            if (len > 200000) {   // 护栏：大响应不读 clone（tee 无背压，只读一支 = 全量驻留内存）
                                info.responseBody = '[oversize ' + len + 'B 未读取]';
                                info.endTime = Date.now();
                                finish();
                                return;
                            }
                            // 审计#4：先入库（push 对象引用）body 到达后回填——长流/慢响应期间记录也可读
                            // （原实现 body 不 settle 则永不入库，SSE/长流请求在 include_body 里静默消失）
                            info.responseBody = '[读取中]';
                            info.endTime = Date.now();
                            finish();
                            const cloned = response.clone();
                            cloned.text().then(function(t) {
                                info.responseBody = t.length > 200000
                                    ? t.substring(0, 200000) + '\n...[ADB 截断: 原始 ' + t.length + ' 字符]'
                                    : t;
                            }).catch(function() {
                                info.responseBody = '[响应体不可读]';
                            });
                        } catch (e) {
                            info.error = '采集异常: ' + (e && e.message);
                            // V4.9.18（验收⚪4）：已在库中的记录若停在 [读取中]（读体阶段抛错），改写为可读原因
                            if (info.responseBody === '[读取中]') info.responseBody = '[响应体不可读: ' + (e && e.message) + ']';
                            info.endTime = Date.now();
                            finish();
                        }
                    };

                    let p;
                    try { p = originalFetch.apply(this, arguments); }
                    catch (e) { info.error = e && e.message; info.endTime = Date.now(); finish(); throw e; }
                    // 旁路读体：页面拿到的仍是原生 promise，交付不被我们阻塞
                    p.then(readSide, function(error) {
                        info.error = error && error.message;
                        info.endTime = Date.now();
                        finish();
                    });
                    return p;
                };

                return { injected: true };
            },
            world: 'MAIN'
        }).then(results => {
            const r0 = results && results[0] && results[0].result;
            if (r0 && r0.stale) hookStale = true;   // V4.9.17（审计#6）
            resolve(results);
        }).catch(reject);
    });

    // 获取捕获的请求
    return new Promise((resolve, reject) => {
        adbExecuteScript({
            target: { tabId: tab.id },
            func: (filterStr, maxLimit) => {
                let requests = window.__capturedRequestsWithBody || [];
                if (filterStr) {
                    requests = requests.filter(r => r.url?.toLowerCase().includes(filterStr.toLowerCase()));
                }
                return requests.slice(-maxLimit);
            },
            args: [filter || '', limit],
            world: 'MAIN'
        }).then(results => {
            let list = results[0]?.result || [];
            // V4.9.17（审计#6）：旧版本 hook 场景逐条打标（保持数组形态；字段级提示——AI 读记录时可见）
            if (hookStale && Array.isArray(list)) {
                const note = '页面 hook 为旧版本（扩展重载前注入）——SSE 阻塞/responseType 丢数据等问题仍存在；建议刷新页面后重新抓包';
                list = list.map(r => (r && typeof r === 'object') ? Object.assign({}, r, { hookStale: note }) : r);
            }
            resolve(list);
        }).catch(reject);
    });
}

// 获取页面内容（用于敏感数据扫描）
async function getPageContent({ tabId, hostname } = {}) {
    const tab = await requireTab({ tabId, hostname });
    
    return new Promise((resolve, reject) => {
        adbExecuteScript({
            target: { tabId: tab.id },
            func: () => {
                // 获取页面主要文本内容
                const body = document.body;
                if (!body) return '';
                
                // 移除脚本和样式内容
                const clone = body.cloneNode(true);
                const scripts = clone.querySelectorAll('script, style, noscript');
                scripts.forEach(s => s.remove());
                
                return clone.textContent || '';
            },
            world: 'MAIN'
        }).then(results => {
            resolve(results[0]?.result || '');
        }).catch(reject);
    });
}

// 启动敏感数据监控
async function startSensitiveMonitor({ patterns = ['idCard', 'phone', 'bankCard', 'password'], alertOnCritical = true, tabId, hostname } = {}) {
    sensitiveMonitorEnabled = true;
    sensitiveMonitorPatterns = patterns;
    
    const tab = await resolveTab({ tabId, hostname });
    if (!tab) {
        return { success: false, error: '无法获取当前标签页' };
    }

    // V4.9.22（修复🔴）：入参归一 + 不支持项**如实告知**。原实现把不支持的类型静默丢掉、仍报 success
    // ——AI 会带着"已在监控邮箱/身份证"的错觉继续操作，并把"监控期间无告警"当成证据（白名单陷阱）。
    // 本清单必须与注入体内 PATTERNS 的键集保持一致（chineseName 已从两处一并移除：中文姓名无可靠正则，
    // "2-4 个汉字"会把"北京""登录"全算命中 = 幻觉数据）。`all` 展开为已支持集合。
    const SUPPORTED_PATTERNS = ['idCard', 'phone', 'bankCard', 'password', 'jwt', 'email', 'ipAddress', 'socialSecurity'];
    const requested = Array.isArray(patterns) && patterns.length > 0 ? patterns : SUPPORTED_PATTERNS;
    const expanded = requested.includes('all') ? SUPPORTED_PATTERNS.slice() : requested;
    const effectivePatterns = [...new Set(expanded)].filter((p) => SUPPORTED_PATTERNS.includes(p));
    const unsupportedPatterns = [...new Set(expanded)].filter((p) => !SUPPORTED_PATTERNS.includes(p));

    // 注入实时监控脚本
    await new Promise((resolve, reject) => {
        // S3 双执行守卫（bug-hunt 2026-10-13）
        const dupTok = '__adbk_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        adbExecuteScript({
            target: { tabId: tab.id },
            func: (__tok, patternsToMonitor, shouldAlert) => {
                // S3 双执行守卫（bug-hunt 2026-10-13）
                if (window[__tok]) return { __adbDupSkipped: true };
                try { window[__tok] = 1; } catch (e) { /* window 冻结：fail-open 放行 */ }
                // bug-hunt M3（2026-10-13）：已注入过则只更新配置后返回——原实现重复注入会在
                // defineProperty 处抛 "Cannot redefine property: responseText"（且与内存态不一致）
                if (window.__sensitiveMonitor) {
                    window.__sensitiveMonitor.patterns = patternsToMonitor;
                    window.__sensitiveMonitor.alertOnCritical = shouldAlert;
                    window.__sensitiveMonitor.enabled = true;
                    return { success: true, reused: true };
                }
                window.__sensitiveMonitor = {
                    enabled: true,
                    patterns: patternsToMonitor,
                    alertOnCritical: shouldAlert,
                    alerts: []
                };
                
                // 敏感数据正则
                // V4.9.22（修复🔴）：原 PATTERNS 只有 5 类，而工具层 enum 允许 10 类——传
                // email/chineseName/ipAddress/socialSecurity/all 时**一个都不监控**却仍报 success（白名单陷阱）。
                // 现：补齐可靠可实现的 3 类（email / IPv4 / SSN），**chineseName 从 enum 移除**
                // （中文姓名无可靠正则——"2-4 个汉字"会把"北京""中国""登录"全算命中，属幻觉数据，违项目纪律）；
                // `all` 在外层注入前展开为"已支持集合"。
                const PATTERNS = {
                    idCard: /\b[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g,
                    phone: /\b1[3-9]\d{9}\b/g,
                    bankCard: /\b(?:62|4[0-9]|5[1-5]|6[2-6])\d{14,17}\b/g,
                    password: /"(?:password|passwd|pwd)"\s*:\s*"[^"]+"/gi,
                    jwt: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
                    email: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
                    ipAddress: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
                    socialSecurity: /\b\d{3}-\d{2}-\d{4}\b/g
                };

                // V4.9.22（修复🔴）：补 fetch 覆盖——原只 hook XHR，而现代站主流走 fetch，
                // 描述"监控**所有** API 响应"名不副实（fetch 型站点零覆盖）。读体遵循 V4.9.17 的非阻塞范式：
                // 不挡 return、clone 后读、oversize 与 SSE 跳过（SSE 的 clone().text() 永不 resolve）。
                const originalFetch = window.fetch;
                if (typeof originalFetch === 'function') {
                    window.fetch = function(input, init) {
                        const p = originalFetch.apply(this, arguments);
                        try {
                            const url = typeof input === 'string' ? input : ((input && input.url) || '');
                            p.then((resp) => {
                                try {
                                    if (!window.__sensitiveMonitor || !window.__sensitiveMonitor.enabled) return;
                                    if (!resp || resp.bodyUsed) return;
                                    const hdr = resp.headers;
                                    const ct = String((hdr && hdr.get && hdr.get('content-type')) || '').toLowerCase();
                                    if (ct.includes('text/event-stream')) return;
                                    const cl = parseInt((hdr && hdr.get && hdr.get('content-length')) || '0', 10);
                                    if (cl > 200000) return;
                                    resp.clone().text()
                                        .then((t) => { try { checkSensitiveData(t, url, 'fetch'); } catch (e) { /* 监控失败不影响页面 */ } })
                                        .catch(() => { /* 读体失败不影响页面 */ });
                                } catch (e) { /* 监控失败不影响页面 */ }
                            }, () => { /* 请求失败：无需监控 */ });
                        } catch (e) { /* 监控失败不影响页面 */ }
                        return p;
                    };
                }
                
                // Hook XHR 响应
                const originalXHROpen = XMLHttpRequest.prototype.open;
                XMLHttpRequest.prototype.open = function(method, url) {
                    this._monitorUrl = url;
                    return originalXHROpen.apply(this, arguments);
                };
                
                const xhrDesc = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'responseText');
                const originalXHRGet = xhrDesc && xhrDesc.get;
                const originalXHRSet = xhrDesc && xhrDesc.set;
                // bug-hunt M3：补 configurable（默认 false 使重复 defineProperty 抛错）+ 保留原 setter
                // V4.9.17（批次1-A2）：非 text responseType 直接透传原生 getter（抛 InvalidStateError 的
                // 行为与原生保持一致，不做额外处理）；扫描加 try/catch——监控绝不干扰页面（正则遇大文本可能卡顿）
                Object.defineProperty(XMLHttpRequest.prototype, 'responseText', {
                    configurable: true,
                    get: function() {
                        if (this.responseType !== '' && this.responseType !== 'text') {
                            return originalXHRGet.call(this);
                        }
                        const text = originalXHRGet.call(this);
                        if (text && window.__sensitiveMonitor && window.__sensitiveMonitor.enabled) {
                            try { checkSensitiveData(text, this._monitorUrl, 'XHR'); } catch (e) { /* 监控失败不影响页面 */ }
                        }
                        return text;
                    },
                    set: originalXHRSet ? function(v) { return originalXHRSet.call(this, v); } : undefined
                });
                
                // 检测函数
                function checkSensitiveData(text, url, source) {
                    const monitor = window.__sensitiveMonitor;
                    if (!monitor || !monitor.enabled) return;
                    
                    for (const patternName of monitor.patterns) {
                        const regex = PATTERNS[patternName];
                        if (!regex) continue;
                        
                        const matches = text.match(regex);
                        if (matches && matches.length > 0) {
                            const alert = {
                                timestamp: Date.now(),
                                url,
                                source,
                                type: patternName,
                                severity: ['idCard', 'bankCard', 'password'].includes(patternName) ? 'critical' : 'high',
                                matchCount: matches.length,
                                sample: matches[0]?.substring(0, 20) + '...'
                            };
                            
                            monitor.alerts.push(alert);
                            
                            // 控制台告警
                            if (monitor.alertOnCritical && alert.severity === 'critical') {
                                console.warn(`🚨 [敏感数据告警] ${patternName}: 在 ${url} 发现 ${matches.length} 处`);
                            }
                        }
                    }
                }
                
                return { success: true, message: '敏感数据监控已启动' };
            },
            args: [dupTok, effectivePatterns, alertOnCritical !== false],
            world: 'MAIN'
        }).then(resolve).catch(reject);
    });
    
    return {
        success: true,
        message: unsupportedPatterns.length > 0
            ? `敏感数据监控已启动——但 ${unsupportedPatterns.length} 类不支持、已忽略：${unsupportedPatterns.join(', ')}（不要把"未告警"当作这些类型"未泄露"的证据）`
            : '敏感数据监控已启动',
        // V4.9.22：原返回的是**模块级默认值**（sensitiveMonitorPatterns），与本次实际启用的毫无关系
        patterns: effectivePatterns,
        unsupportedPatterns,
        coverage: { xhr: true, fetch: true }   // V4.9.22：fetch 覆盖已补（原只 hook XHR）
    };
}

// 获取敏感数据告警
async function getSensitiveAlerts({ limit = 50, severityFilter = 'all', tabId, hostname } = {}) {
    const tab = await resolveTab({ tabId, hostname }, true);
    if (!tab) {
        // M4 修复：返回结构与成功形态对齐（原 return [] 使调用方 .filteredAlerts 得 undefined，无法区分"无告警"与"不可达"）
        return { success: false, enabled: false, alerts: [], filteredAlerts: [], error: '无法获取当前标签页' };
    }
    
    return new Promise((resolve, reject) => {
        adbExecuteScript({
            target: { tabId: tab.id },
            func: (maxLimit, severity) => {
                const monitor = window.__sensitiveMonitor;
                if (!monitor) {
                    return { enabled: false, alerts: [] };
                }
                
                let alerts = monitor.alerts || [];
                if (severity !== 'all') {
                    alerts = alerts.filter(a => a.severity === severity);
                }
                
                return {
                    enabled: monitor.enabled,
                    totalAlerts: monitor.alerts?.length || 0,
                    filteredAlerts: alerts.slice(-maxLimit),
                    patterns: monitor.patterns
                };
            },
            args: [limit || 100, severityFilter || ''],
            world: 'MAIN'
        }).then(results => {
            resolve(results[0]?.result || { enabled: false, alerts: [] });
        }).catch(reject);
    });
}
