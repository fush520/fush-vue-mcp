// ==UserScript==
// @name         Crypto_Capture (密码学能力注册表 + 响应自动解密)
// @namespace    https://github.com/0xsdeo/AntiDebug_Breaker
// @version      2026-08-27
// @description  V3.1：捕获页面内所有加密调用（WebCrypto/SM/CryptoJS），建立"密码学能力注册表"（算法+密钥+函数引用），
//               支持 MCP sign_payload 工具主动调用原加密函数对任意明文重算签名/加密（改参重放）；
//               同时建立 密文→明文 解密映射并匹配 fetch 响应，实现响应自动解密。
// @author       0xsdeo / fusheng
// @run-at       document-start
// @match        *
// @grant        none
// ==/UserScript==

// V3.1 密码学能力注册表 + 响应自动解密
// 核心思路：Hook 层捕获密钥与加密函数引用，存入 window.__ADB_CRYPTO__；
// MCP 工具通过 chrome.scripting executeScript(MAIN world) 调 compute() 主动重算——密钥不出浏览器，签名任意改参。
(function () {
    'use strict';

    const LOCK_KEY = '__ADB_CRYPTO_CAPTURE__';
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

    const MAX_CAPS = 30;           // 能力注册上限
    const MAX_DECRYPT_KEYS = 200;  // 解密映射键上限
    const MAX_RESPONSES = 50;      // 已解密响应记录上限
    const MAX_CIPHER_KEY_LEN = 20000; // 密文匹配键长度上限
    const MAX_PLAIN_STORE = 65536; // 解密映射明文存储上限（字符）
    const REPORT_COOLDOWN = 2000;  // 上报冷却
    const initErrors = [];         // 初始化失败诊断信息（getRegistry 上报）

    // ==================== 注册表 ====================
    const registry = {
        capabilities: [],           // {id, kind, algorithm, keyHex?, keyB64?, iv?, mode?, cipherType?, publicKey?, keyRef?, fnRef?, algoParamsRaw?, algoParamsHex?, note, lastUsed, count}
        decryptMap: new Map(),      // 密文(hex/base64) -> {plainHex, plainB64, algorithm, ts}
        decryptedResponses: []      // {url, method, algorithm, plaintext, cipherLen, ts}
    };

    let capSeq = 0;
    let lastReportTime = 0;
    const pendingReports = [];

    // ==================== 帮助函数 ====================
    function bufToHex(buf, maxLen) {
        try {
            if (typeof buf === 'string') return buf;
            const arr = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
            const hex = Array.from(maxLen ? arr.slice(0, maxLen) : arr)
                .map(b => b.toString(16).padStart(2, '0')).join('');
            return hex;
        } catch (e) {
            return null;
        }
    }

    function bufToB64(buf, maxLen) {
        try {
            if (typeof buf === 'string') return buf;
            const arr = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
            const slice = maxLen ? arr.slice(0, maxLen) : arr;
            let bin = '';
            for (const b of slice) bin += String.fromCharCode(b);
            return btoa(bin);
        } catch (e) {
            return null;
        }
    }

    function fmtAlgo(algo) {
        try {
            if (!algo) return null;
            const out = { name: algo.name };
            for (const k of ['hash', 'iv', 'tagLength', 'additionalData', 'modulusLength', 'publicExponent', 'namedCurve', 'length', 'counter', 'salt']) {
                if (algo[k] === undefined) continue;
                if (algo[k] instanceof ArrayBuffer || (algo[k] && algo[k].BYTES_PER_ELEMENT)) {
                    out[k] = bufToHex(algo[k]);
                } else if (algo[k] && typeof algo[k] === 'object' && algo[k].name) {
                    out[k] = algo[k].name;
                } else {
                    out[k] = algo[k];
                }
            }
            return out;
        } catch (e) {
            return { name: algo && algo.name };
        }
    }

    function wordArrayToHex(wa) {
        try { return wa.toString(window.CryptoJS ? window.CryptoJS.enc.Hex : undefined); } catch (e) { return null; }
    }

    function safeLog(...args) {
        try { console.log(...args); } catch (e) { /* 忽略 */ }
    }

    function nowTs() {
        try { return new Date().toISOString(); } catch (e) { return ''; }
    }

    // ==================== 能力注册 ====================
    // CryptoKey 对象身份映射（同算法多密钥区分，避免合并后回放用错密钥）
    const keyIdMap = new WeakMap();
    let keySeq = 0;
    function getKeyId(key) {
        try {
            if (!key || (typeof key !== 'object' && typeof key !== 'function')) return null;
            let id = keyIdMap.get(key);
            if (!id) {
                id = ++keySeq;
                keyIdMap.set(key, id);
            }
            return id;
        } catch (e) {
            return null;
        }
    }

    function registerCapability(cap) {
        try {
            // 去重：kind|algorithm|direction|密钥身份（keyRef 按对象身份 / keyHex / 公钥）——
            // 加密/解密/SM2 三件套各自独立，多密钥不合并（防回放用错函数/密钥）
            const keyId = cap.keyRef ? getKeyId(cap.keyRef) : null;
            const dedupKey = cap.kind + '|' + (cap.algorithm || '') + '|' + (cap.direction || '') + '|' +
                (keyId !== null ? 'keyref:' + keyId : (cap.keyHex || cap.publicKey || 'nokey'));
            const existing = registry.capabilities.find(c => c._dedupKey === dedupKey);
            if (existing) {
                existing.lastUsed = nowTs();
                existing.count = (existing.count || 0) + 1;
                if (cap.publicKey && !existing.publicKey) existing.publicKey = cap.publicKey;
                if (cap.privateKey && !existing.privateKey) existing.privateKey = cap.privateKey;
                if (cap.iv && !existing.iv) existing.iv = cap.iv;
                if (cap.mode && !existing.mode) existing.mode = cap.mode;
                if (cap.cipherType && !existing.cipherType) existing.cipherType = cap.cipherType;
                if (cap.keyHex && !existing.keyHex) existing.keyHex = cap.keyHex;
                if (cap.keyFormat && !existing.keyFormat) existing.keyFormat = cap.keyFormat;
                if (cap.keyRef && !existing.keyRef) existing.keyRef = cap.keyRef;
                if (cap.fnRef && !existing.fnRef) existing.fnRef = cap.fnRef;
                if (cap.algoParamsRaw && !existing.algoParamsRaw) existing.algoParamsRaw = cap.algoParamsRaw;
                return existing.id;
            }
            if (registry.capabilities.length >= MAX_CAPS) registry.capabilities.shift();
            const id = 'cap_' + (++capSeq);
            cap.id = id;
            cap._dedupKey = dedupKey;
            cap.lastUsed = nowTs();
            cap.count = 1;
            registry.capabilities.push(cap);
            queueReport({ event: 'capability', capability: serializableCap(cap) });
            safeLog('%c[CryptoCapture] 注册密码学能力 #' + id, 'color: #22d3ee', serializableCap(cap));
            return id;
        } catch (e) {
            return null;
        }
    }

    function serializableCap(c) {
        return {
            id: c.id,
            kind: c.kind,
            algorithm: c.algorithm,
            direction: c.direction,
            keyHex: c.keyHex,
            keyB64: c.keyB64,
            keyFormat: c.keyFormat,
            iv: c.iv,
            mode: c.mode,
            cipherType: c.cipherType,
            publicKey: c.publicKey ? String(c.publicKey).slice(0, 300) : undefined,
            privateKey: c.privateKey ? String(c.privateKey).slice(0, 64) : undefined,
            algoParamsHex: c.algoParamsHex,
            hasKeyRef: !!c.keyRef,
            hasFnRef: !!c.fnRef,
            note: c.note,
            lastUsed: c.lastUsed,
            count: c.count
        };
    }

    // ==================== 解密映射 ====================
    function recordDecrypt(cipherHex, cipherB64, plainHex, plainB64, algorithm) {
        try {
            if (registry.decryptMap.size >= MAX_DECRYPT_KEYS) {
                // 删除最老的键（Map 迭代序 = 插入序）
                const firstKey = registry.decryptMap.keys().next().value;
                if (firstKey !== undefined) registry.decryptMap.delete(firstKey);
            }
            const plain = {
                plainHex: plainHex ? String(plainHex).slice(0, MAX_PLAIN_STORE) : undefined,
                plainB64: plainB64 ? String(plainB64).slice(0, MAX_PLAIN_STORE) : undefined,
                algorithm,
                ts: nowTs()
            };
            if (cipherHex && cipherHex.length <= MAX_CIPHER_KEY_LEN) registry.decryptMap.set(String(cipherHex).toLowerCase(), plain);
            if (cipherB64 && cipherB64.length <= MAX_CIPHER_KEY_LEN) registry.decryptMap.set(String(cipherB64), plain);
        } catch (e) { /* 忽略 */ }
    }

    function tryMatchCipher(text) {
        try {
            const norm = text.trim();
            if (norm.length < 16) return null;
            let hit = registry.decryptMap.get(norm) || registry.decryptMap.get(norm.toLowerCase());
            if (hit) return hit;
            // V4.9.19（批次4 明文对照）：URL 编码变体——表单/query 里的密文常被 encodeURIComponent
            //（base64 的 +/= 变 %2B/%3D），原样查不中时解码再查一次
            try {
                const dec = decodeURIComponent(norm);
                if (dec !== norm) hit = registry.decryptMap.get(dec) || registry.decryptMap.get(dec.toLowerCase());
            } catch (e) { /* 非法编码 */ }
            return hit || null;
        } catch (e) {
            return null;
        }
    }

    function recordDecryptedResponse(url, method, hit, cipherLen) {
        try {
            if (registry.decryptedResponses.length >= MAX_RESPONSES) registry.decryptedResponses.shift();
            const plaintext = (hit.plainB64 ? decodeB64ToText(hit.plainB64) : (hit.plainHex ? hexToText(hit.plainHex) : '')) || '';
            const rec = {
                url: String(url).slice(0, 500),
                method: method,
                algorithm: hit.algorithm,
                cipherLen: cipherLen,
                plaintext: plaintext.slice(0, 4000),
                ts: nowTs()
            };
            registry.decryptedResponses.push(rec);
            queueReport({
                event: 'decrypt_response',
                url: rec.url,
                algorithm: rec.algorithm,
                plaintextPreview: plaintext.slice(0, 1000)
            });
            safeLog('%c[CryptoCapture] ⭐ 响应自动解密命中', 'color: #fbbf24', {
                url: rec.url,
                algorithm: rec.algorithm,
                plaintext: rec.plaintext.slice(0, 500)
            });
        } catch (e) { /* 忽略 */ }
    }

    function decodeB64ToText(b64) {
        try {
            const bin = atob(b64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
        } catch (e) {
            return '';
        }
    }

    function hexToText(hex) {
        try {
            if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) return '';
            const bytes = new Uint8Array(hex.length / 2);
            for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
            return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
        } catch (e) {
            return '';
        }
    }

    // ==================== 上报（→ content.js → MCP） ====================
    let flushTimer = null;

    function queueReport(data) {
        pendingReports.push(data);
        if (pendingReports.length > 10) pendingReports.shift();
        // 冷却窗口结束后兜底发送（事件流停止时最后一批也能送达）
        if (flushTimer) return;
        const now = Date.now();
        const wait = Math.max(0, REPORT_COOLDOWN - (now - lastReportTime));
        flushTimer = setTimeout(() => {
            flushTimer = null;
            if (pendingReports.length === 0) return;
            lastReportTime = Date.now();
            const batch = pendingReports.splice(0, pendingReports.length);
            try {
                window.postMessage({
                    type: 'CRYPTO_DATA',
                    source: 'crypto-capture',
                    data: { events: batch, timestamp: lastReportTime },
                    timestamp: lastReportTime
                }, '*');
            } catch (e) { /* 忽略 */ }
        }, wait);
    }

    // ==================== Hook 1: WebCrypto (crypto.subtle) ====================
    // 从 keyUsages 推导操作方向（去重键区分加密/签名能力）
    function directionFromUsages(usages) {
        try {
            if (!Array.isArray(usages)) return '';
            if (usages.includes('sign')) return 'sign';
            if (usages.includes('encrypt')) return 'encrypt';
            if (usages.includes('decrypt')) return 'decrypt';
            if (usages.includes('verify')) return 'sign';
            return '';
        } catch (e) {
            return '';
        }
    }

    function hookSubtle() {
        if (!window.crypto || !crypto.subtle || typeof crypto.subtle.importKey !== 'function') return;
        const subtle = crypto.subtle;

        const rawImportKey = subtle.importKey.bind(subtle);
        subtle.importKey = async function (format, keyData, algo, extractable, keyUsages) {
            const result = await rawImportKey(format, keyData, algo, extractable, keyUsages);
            try {
                const a = fmtAlgo(algo);
                const cap = {
                    kind: 'webcrypto',
                    algorithm: a && a.name,
                    direction: directionFromUsages(keyUsages),
                    algoParamsRaw: algo,
                    algoParamsHex: a,
                    keyRef: result,
                    note: 'importKey(' + format + ', extractable=' + extractable + ')'
                };
                if (format === 'raw') {
                    cap.keyHex = bufToHex(keyData, 512);
                    cap.keyB64 = bufToB64(keyData, 1024);
                } else if (format === 'jwk') {
                    try { cap.keyB64 = JSON.stringify(keyData).slice(0, 500); } catch (e) { /* 忽略 */ }
                }
                if (extractable === true && subtle.exportKey) {
                    try {
                        const exported = await subtle.exportKey('raw', result);
                        cap.keyHex = bufToHex(exported, 512);
                        cap.keyB64 = bufToB64(exported, 1024);
                        cap.note += ' +raw导出';
                    } catch (e) { /* 非对称/不可导出 */ }
                }
                registerCapability(cap);
            } catch (e) { /* 忽略 */ }
            return result;
        };

        const rawGenerateKey = subtle.generateKey.bind(subtle);
        subtle.generateKey = async function (algo, extractable, keyUsages) {
            const result = await rawGenerateKey(algo, extractable, keyUsages);
            try {
                const a = fmtAlgo(algo);
                const cap = {
                    kind: 'webcrypto',
                    algorithm: a && a.name,
                    direction: directionFromUsages(keyUsages),
                    algoParamsRaw: algo,
                    algoParamsHex: a,
                    keyRef: result && result.privateKey ? result.privateKey : result,
                    note: 'generateKey(extractable=' + extractable + ')'
                };
                if (extractable === true && subtle.exportKey) {
                    try {
                        const exported = await subtle.exportKey('raw', result);
                        cap.keyHex = bufToHex(exported, 512);
                        cap.keyB64 = bufToB64(exported, 1024);
                    } catch (e) { /* 忽略 */ }
                }
                registerCapability(cap);
            } catch (e) { /* 忽略 */ }
            return result;
        };

        const rawEncrypt = subtle.encrypt.bind(subtle);
        subtle.encrypt = async function (algo, key, data) {
            const result = await rawEncrypt(algo, key, data);
            try {
                const a = fmtAlgo(algo);
                touchWebCryptoCap(key, a);
                // 记录 明文→密文（重放时校验用）
                // V4.9.19（批次4）：密文 hex 上限 512→20000 字节——原 512 截断使大密文（整个 body 加密）
                // 永远匹配不上请求体
                recordEncryptMapping(bufToHex(data), bufToHex(result, 20000), a && a.name);
            } catch (e) { /* 忽略 */ }
            return result;
        };

        const rawDecrypt = subtle.decrypt.bind(subtle);
        subtle.decrypt = async function (algo, key, data) {
            const result = await rawDecrypt(algo, key, data);
            try {
                const a = fmtAlgo(algo);
                touchWebCryptoCap(key, a);
                recordDecrypt(
                    bufToHex(data),
                    bufToB64(data),
                    bufToHex(result),
                    bufToB64(result),
                    'WebCrypto/' + (a && a.name)
                );
            } catch (e) { /* 忽略 */ }
            return result;
        };

        const rawSign = subtle.sign.bind(subtle);
        subtle.sign = async function (algo, key, data) {
            const result = await rawSign(algo, key, data);
            try {
                const a = fmtAlgo(algo);
                touchWebCryptoCap(key, a);
                const sigHex = bufToHex(result, 2048);
                const sigB64 = bufToB64(result, 2048);
                recordSignResult(a && a.name, sigHex, sigB64);
            } catch (e) { /* 忽略 */ }
            return result;
        };

        function touchWebCryptoCap(key, a) {
            try {
                const name = key && key.algorithm && key.algorithm.name;
                const caps = registry.capabilities.filter(c => c.kind === 'webcrypto');
                for (const c of caps) {
                    if (c.keyRef === key || (c.keyRef && c.keyRef.algorithm && c.keyRef.algorithm.name === name)) {
                        c.lastUsed = nowTs();
                        c.count = (c.count || 0) + 1;
                        return;
                    }
                }
                // 未注册过的 key（Hook 注入前已 import）→ 注册
                if (key) {
                    registerCapability({
                        kind: 'webcrypto',
                        algorithm: name,
                        direction: directionFromUsages(key.usages),
                        algoParamsRaw: a ? rebuildAlgo(name, a) : null,
                        algoParamsHex: a,
                        keyRef: key,
                        note: '运行中发现(' + (key.extractable ? 'extractable' : '不可导出') + ')'
                    });
                }
            } catch (e) { /* 忽略 */ }
        }
    }

    function rebuildAlgo(name, a) {
        // 从 hex 形式的 algoParams 重建可调用算法对象（iv 转回 bytes）
        try {
            const out = { name: name };
            if (!a) return out;
            for (const k of ['tagLength', 'length', 'modulusLength', 'namedCurve', 'hash', 'counter', 'salt']) {
                if (a[k] !== undefined) {
                    if (typeof a[k] === 'object' && a[k].name) out[k] = a[k];
                    else if (typeof a[k] === 'string' && /^[0-9a-fA-F]+$/.test(a[k]) && a[k].length % 2 === 0 && k !== 'hash') {
                        out[k] = hexToBytes(a[k]);
                    } else {
                        out[k] = a[k];
                    }
                }
            }
            if (a.iv && /^[0-9a-fA-F]+$/.test(a.iv) && a.iv.length % 2 === 0) out.iv = hexToBytes(a.iv);
            return out;
        } catch (e) {
            return { name: name };
        }
    }

    function hexToBytes(hex) {
        try {
            const bytes = new Uint8Array(hex.length / 2);
            for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
            return bytes;
        } catch (e) {
            return null;
        }
    }

    // 明文→密文映射（sign_payload 加密后校验）
    const encryptMap = new Map();
    function hexToB64(hex) {
        try {
            if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) return null;
            let bin = '';
            for (let i = 0; i < hex.length; i += 2) bin += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
            return btoa(bin);
        } catch (e) { return null; }
    }
    function recordEncryptMapping(plainHex, cipherHex, algorithm) {
        try {
            if (plainHex && cipherHex && encryptMap.size < 100) {
                encryptMap.set(plainHex.toLowerCase(), { cipherHex, algorithm, ts: nowTs() });
            }
            // V4.9.19（批次4 明文对照）：加密产物同时写入 decryptMap（密文→明文）——
            // 抓包请求体里的密文由此反查明文。原实现只建"响应侧解密映射"，请求侧加密无处可查。
            // **hex 与 base64 双形态登记**：页面通常把密文转 base64 再进请求体，只登记 hex 永远查不到
            if (plainHex && cipherHex) {
                const note = (algorithm || '') + '（请求加密产物）';
                recordDecrypt(cipherHex, null, plainHex, null, note);
                const b64 = hexToB64(cipherHex);
                if (b64) recordDecrypt(null, b64, plainHex, null, note);
            }
        } catch (e) { /* 忽略 */ }
    }

    // V4.9.19（批次4）：字符串/WordArray → hex（CryptoJS 加密侧的明文入参转 hex 用）
    function strToHex(s) {
        try {
            if (!s) return null;
            if (typeof s === 'object' && s.words) return wordArrayToHex(s);
            const bytes = new TextEncoder().encode(String(s));
            let hex = '';
            for (const b of bytes) hex += b.toString(16).padStart(2, '0');
            return hex;
        } catch (e) {
            return null;
        }
    }

    // 签名结果记录（用于校验签名格式）
    const signResults = [];
    function recordSignResult(algorithm, sigHex, sigB64) {
        try {
            if (signResults.length >= 20) signResults.shift();
            signResults.push({ algorithm, sigHex, sigB64, ts: nowTs() });
        } catch (e) { /* 忽略 */ }
    }

    // ==================== Hook 2: SM 国密（webpack call 拦截） ====================
    function hookSM() {
        // SM2 属性检测（同 Hook_SMcrypto）
        function has_SM2_Prop(obj) {
            const required = ['doDecrypt', 'doEncrypt', 'doSignature', 'doVerifySignature', 'generateKeyPairHex', 'getPoint'];
            if (!obj || typeof obj !== 'object') return false;
            for (const p of required) if (!(p in obj)) return false;
            return true;
        }

        function sm4_encrypt_test(func) {
            try {
                return func("123456", "0123456789abcdeffedcba9876543210", { mode: 'cbc', iv: "000102030405060708090a0b0c0d0e0f", cipherType: 'hex' });
            } catch (e) { return false; }
        }

        function sm4_decrypt_test(func) {
            try {
                return func("1b96f27b7f523118539b416810c91d4d", "0123456789abcdeffedcba9876543210", { mode: 'cbc', iv: "000102030405060708090a0b0c0d0e0f", cipherType: 'hex' });
            } catch (e) { return false; }
        }

        function sm3_test(func) {
            try {
                return func("123456");
            } catch (e) { return false; }
        }

        const rawCall = Function.prototype.call;
        function myCall() {
            const result = Reflect.apply(rawCall, this, arguments);
            // 廉价短路：webpack 加载特征为 4 参数，其余调用零额外开销
            if (arguments.length !== 4) return result;
            try {
                if (arguments[1] && arguments[1].exports) {
                    const exports = arguments[1].exports;

                    if (has_SM2_Prop(exports)) {
                        if (exports.doEncrypt) {
                            const raw = exports.doEncrypt;
                            registerCapability({ kind: 'sm2', algorithm: 'SM2-encrypt', direction: 'encrypt', fnRef: raw, note: 'sm2.doEncrypt' });
                            if (!raw.__ADB_HOOKED__) {
                                exports.doEncrypt = function (msg, pubKey) {
                                    const r = Reflect.apply(raw, this, arguments);
                                    try {
                                        touchSMCap('sm2', { publicKey: String(pubKey).slice(0, 200) }, raw);
                                    } catch (e) { /* 忽略 */ }
                                    return r;
                                };
                                exports.doEncrypt.__ADB_HOOKED__ = true;
                            }
                        }
                        if (exports.doDecrypt) {
                            const raw = exports.doDecrypt;
                            registerCapability({ kind: 'sm2', algorithm: 'SM2-decrypt', direction: 'decrypt', fnRef: raw, note: 'sm2.doDecrypt' });
                            if (!raw.__ADB_HOOKED__) {
                                exports.doDecrypt = function (cipher, privKey) {
                                    const r = Reflect.apply(raw, this, arguments);
                                    try {
                                        recordDecrypt(String(cipher), null, null, typeof r === 'string' ? btoaUnicode(r) : null, 'SM2');
                                        touchSMCap('sm2', { privateKey: privKey ? String(privKey).slice(0, 64) : undefined }, raw);
                                    } catch (e) { /* 忽略 */ }
                                    return r;
                                };
                                exports.doDecrypt.__ADB_HOOKED__ = true;
                            }
                        }
                        if (exports.doSignature) {
                            const raw = exports.doSignature;
                            registerCapability({ kind: 'sm2', algorithm: 'SM2-sign', direction: 'sign', fnRef: raw, note: 'sm2.doSignature' });
                            if (!raw.__ADB_HOOKED__) {
                                exports.doSignature = function (msg, privKey) {
                                    const r = Reflect.apply(raw, this, arguments);
                                    try {
                                        touchSMCap('sm2', { privateKey: privKey ? String(privKey).slice(0, 64) : undefined }, raw);
                                    } catch (e) { /* 忽略 */ }
                                    return r;
                                };
                                exports.doSignature.__ADB_HOOKED__ = true;
                            }
                        }
                    }

                    if (exports.encrypt) {
                        const testResult = sm4_encrypt_test(exports.encrypt);
                        if (testResult === "1b96f27b7f523118539b416810c91d4d") {
                            const raw = exports.encrypt;
                            registerCapability({ kind: 'sm4', algorithm: 'SM4', direction: 'encrypt', fnRef: raw, mode: 'cbc', cipherType: 'hex', note: 'sm4.encrypt' });
                            if (!raw.__ADB_HOOKED__) {
                                exports.encrypt = function (msg, key, cfg) {
                                    const r = Reflect.apply(raw, this, arguments);
                                    try {
                                        touchSMCap('sm4', {
                                            keyHex: String(key).slice(0, 64),
                                            iv: cfg && cfg.iv ? String(cfg.iv).slice(0, 32) : undefined,
                                            mode: cfg && cfg.mode ? String(cfg.mode) : undefined,
                                            cipherType: cfg && cfg.cipherType ? String(cfg.cipherType) : undefined
                                        }, raw);
                                    } catch (e) { /* 忽略 */ }
                                    return r;
                                };
                                exports.encrypt.__ADB_HOOKED__ = true;
                            }
                        }
                    }

                    if (exports.decrypt) {
                        const testResult = sm4_decrypt_test(exports.decrypt);
                        if (testResult === "123456") {
                            const raw = exports.decrypt;
                            registerCapability({ kind: 'sm4', algorithm: 'SM4', direction: 'decrypt', fnRef: raw, mode: 'cbc', cipherType: 'hex', note: 'sm4.decrypt' });
                            if (!raw.__ADB_HOOKED__) {
                                exports.decrypt = function (cipher, key, cfg) {
                                    const r = Reflect.apply(raw, this, arguments);
                                    try {
                                        touchSMCap('sm4', {
                                            keyHex: String(key).slice(0, 64),
                                            iv: cfg && cfg.iv ? String(cfg.iv).slice(0, 32) : undefined,
                                            mode: cfg && cfg.mode ? String(cfg.mode) : undefined,
                                            cipherType: cfg && cfg.cipherType ? String(cfg.cipherType) : undefined
                                        }, raw);
                                        if (typeof r === 'string' && typeof cipher === 'string') {
                                            recordDecrypt(String(cipher), null, null, btoaUnicode(r), 'SM4');
                                        }
                                    } catch (e) { /* 忽略 */ }
                                    return r;
                                };
                                exports.decrypt.__ADB_HOOKED__ = true;
                            }
                        }
                    }

                    // 纯行为检测（不依赖 toString，穿透其他 Hook 脚本的包装层依然成立）
                    if (typeof exports === "function") {
                        const testResult = sm3_test(exports);
                        if (testResult === "207cf410532f92a47dee245ce9b11ff71f578ebd763eb3bbea44ebd043d018fb") {
                            const raw = exports;
                            registerCapability({ kind: 'sm3', algorithm: 'SM3', direction: 'hash', fnRef: raw, note: 'sm3' });
                            if (!raw.__ADB_HOOKED__) {
                                const mySM3 = function () {
                                    const r = Reflect.apply(raw, this, arguments);
                                    try { touchSMCap('sm3', null, raw); } catch (e) { /* 忽略 */ }
                                    return r;
                                };
                                mySM3.__ADB_HOOKED__ = true;
                                arguments[1].exports = mySM3;
                            }
                        }
                    }
                }
            } catch (e) { /* 忽略 */ }
            return result;
        }
        Function.prototype.call = myCall;
    }

    function btoaUnicode(str) {
        try {
            return btoa(unescape(encodeURIComponent(str)));
        } catch (e) {
            return null;
        }
    }

    function touchSMCap(kind, updates, fnRef) {
        try {
            // 按 fnRef 精确匹配自己的 cap（SM2 encrypt/decrypt/sign 三件套与 SM4 双向各自独立）
            const caps = registry.capabilities.filter(c => c.kind === kind);
            if (caps.length === 0) return;
            let c = null;
            if (fnRef) {
                c = caps.find(x => x.fnRef === fnRef) || null;
            }
            if (!c) {
                c = caps[caps.length - 1]; // 兜底：最近注册的
            }
            c.lastUsed = nowTs();
            c.count = (c.count || 0) + 1;
            if (updates) {
                if (updates.keyHex) { c.keyHex = updates.keyHex; c.keyB64 = undefined; }
                if (updates.iv !== undefined) c.iv = updates.iv;
                if (updates.mode !== undefined) c.mode = updates.mode;
                if (updates.cipherType !== undefined) c.cipherType = updates.cipherType;
                if (updates.publicKey) c.publicKey = updates.publicKey;
                if (updates.privateKey) c.privateKey = updates.privateKey;
            }
        } catch (e) { /* 忽略 */ }
    }

    // ==================== Hook 3: CryptoJS ====================
    // 提取 CryptoJS 密钥：WordArray → hex；字符串口令 → 原样标记 passphrase（回放时不能 Hex.parse）
    function extractCryptoJSKey(key, C) {
        try {
            if (key instanceof C.lib.WordArray) {
                return { keyHex: wordArrayToHex(key), keyFormat: 'hex' };
            }
            if (typeof key === 'string') {
                return { keyHex: key, keyFormat: 'passphrase' };
            }
            return { keyHex: null, keyFormat: 'unknown' };
        } catch (e) {
            return { keyHex: null, keyFormat: 'unknown' };
        }
    }

    function hookCryptoJS() {
        if (!window.CryptoJS) return false;
        try {
            if (window.CryptoJS.__ADB_HOOKED__) return true;
            const C = window.CryptoJS;

            function hookAES() {
                if (!C.AES || !C.AES.encrypt || C.AES.encrypt.__ADB_HOOKED__) return;
                const origEnc = C.AES.encrypt;
                C.AES.encrypt = function (msg, key, cfg) {
                    const r = origEnc.apply(this, arguments);
                    try {
                        const k = extractCryptoJSKey(key, C);
                        const iv = cfg && cfg.iv ? wordArrayToHex(cfg.iv) : undefined;
                        const mode = cfg && cfg.mode ? (cfg.mode.name || String(cfg.mode)) : 'CBC';
                        registerCapability({ kind: 'cryptojs', algorithm: 'AES', direction: 'encrypt', keyHex: k.keyHex, keyFormat: k.keyFormat, iv: iv, mode: mode, note: 'CryptoJS.AES.encrypt' });
                        if (typeof r === 'object' && r.ciphertext) {
                            // V4.9.19（批次4）：补明文（原传 null——请求侧密文永远查不到明文）
                            recordEncryptMapping(strToHex(msg), wordArrayToHex(r.ciphertext), 'CryptoJS/AES');
                        }
                    } catch (e) { /* 忽略 */ }
                    return r;
                };
                C.AES.encrypt.__ADB_HOOKED__ = true;

                const origDec = C.AES.decrypt;
                C.AES.decrypt = function (cipher, key, cfg) {
                    const r = origDec.apply(this, arguments);
                    try {
                        const k = extractCryptoJSKey(key, C);
                        const iv = cfg && cfg.iv ? wordArrayToHex(cfg.iv) : undefined;
                        const mode = cfg && cfg.mode ? (cfg.mode.name || String(cfg.mode)) : 'CBC';
                        registerCapability({ kind: 'cryptojs', algorithm: 'AES', direction: 'decrypt', keyHex: k.keyHex, keyFormat: k.keyFormat, iv: iv, mode: mode, note: 'CryptoJS.AES.decrypt' });
                        const cipherStr = typeof cipher === 'string' ? cipher : (cipher && cipher.ciphertext ? wordArrayToHex(cipher.ciphertext) : null);
                        const plainStr = typeof r === 'object' ? r.toString(C.enc.Utf8) : String(r);
                        if (cipherStr && plainStr && plainStr.length < 50000) {
                            recordDecrypt(cipherStr, null, null, btoaUnicode(plainStr), 'CryptoJS/AES');
                        }
                    } catch (e) { /* 忽略 */ }
                    return r;
                };
                C.AES.decrypt.__ADB_HOOKED__ = true;
            }

            function hookHmac() {
                const algos = ['HmacSHA1', 'HmacSHA224', 'HmacSHA256', 'HmacSHA384', 'HmacSHA512', 'HmacMD5'];
                for (const name of algos) {
                    if (!C[name] || C[name].__ADB_HOOKED__) continue;
                    const orig = C[name];
                    C[name] = function (msg, key) {
                        const r = orig.apply(this, arguments);
                        try {
                            const k = extractCryptoJSKey(key, C);
                            registerCapability({ kind: 'cryptojs', algorithm: name, direction: 'sign', keyHex: k.keyHex, keyFormat: k.keyFormat, note: 'CryptoJS.' + name });
                        } catch (e) { /* 忽略 */ }
                        return r;
                    };
                    C[name].__ADB_HOOKED__ = true;
                }
            }

            function hookDigest() {
                const algos = ['MD5', 'SHA1', 'SHA224', 'SHA256', 'SHA384', 'SHA512', 'SHA3'];
                for (const name of algos) {
                    if (!C[name] || C[name].__ADB_HOOKED__) continue;
                    const orig = C[name];
                    C[name] = function (msg) {
                        const r = orig.apply(this, arguments);
                        try {
                            registerCapability({ kind: 'cryptojs', algorithm: name, direction: 'hash', note: 'CryptoJS.' + name + ' (无密钥)' });
                        } catch (e) { /* 忽略 */ }
                        return r;
                    };
                    C[name].__ADB_HOOKED__ = true;
                }
            }

            hookAES();
            hookHmac();
            hookDigest();
            C.__ADB_HOOKED__ = true;
            return true;
        } catch (e) {
            return false;
        }
    }

    // webpack 打包场景：CryptoJS 模块不挂 window（vue-cli webpackJsonp 运行时）
    // 用 FakeCryptoJS 同款技巧遍历模块注册表找 CryptoJS，找到后挂回 window.CryptoJS 供 hookCryptoJS 包装（保留函数引用，可重算）
    // ⚠️ 实测教训：混淆运行时（push 源码超长含 _0x 变量）会因假 chunkId 抛错并中断 webpack 启动流程 → probe 前必须检测运行时形态
    let webpackCryptoJSFound = false;
    let webpackProbeDisabled = false;
    function scanWebpackCryptoJS() {
        if (webpackCryptoJSFound || webpackProbeDisabled) return false;
        const wj = window.webpackJsonp;
        if (!wj || typeof wj.push !== 'function') return false;
        try {
            const src = String(wj.push);
            const isNative = src.indexOf('[native code]') !== -1;
            // 原生 push（运行时未接管）→ 跳过本次，等运行时就绪；混淆运行时 → 永久禁用（probe 有破坏页面风险）
            if (isNative) return false;
            if (src.length > 300) { webpackProbeDisabled = true; return false; }
        } catch (e) { webpackProbeDisabled = true; return false; }
        try {
            let found = null;
            const probe = function (modules, chunkIds, req) {
                try {
                    if (req && req.c) {
                        for (const id in req.c) {
                            const m = req.c[id];
                            const e = m && m.exports;
                            if (e && typeof e === 'object' && e.lib && e.lib.WordArray &&
                                e.AES && e.HmacSHA256 && e.MD5 && e.enc &&
                                typeof e.AES.encrypt === 'function') {
                                found = e;
                                break;
                            }
                        }
                    }
                } catch (err) { /* 继续找下一个模块 */ }
            };
            const probeId = '__adb_probe_' + Date.now() + '_' + Math.floor(Math.random() * 100000);
            try {
                wj.push([[probeId], {}, probe]);
            } finally {
                // 无论 push 是否抛错都清理探测项，避免污染页面队列
                const idx = wj.indexOf(probe);
                if (idx !== -1) wj.splice(idx, 1);
            }
            if (found) {
                window.CryptoJS = found;
                webpackCryptoJSFound = true;
                safeLog('%c[CryptoCapture] webpack 模块注册表中找到 CryptoJS，已挂载 window.CryptoJS', 'color: #22d3ee');
                return true;
            }
        } catch (err) { /* push 抛错说明运行时不兼容 → 禁用重试 */
            webpackProbeDisabled = true;
        }
        return false;
    }

    // ==================== Hook 4: apply 拦截捕获（webpack 打包 CryptoJS 不挂 window 的场景） ====================
    // 复用 Hook_CryptoJS 的调用特征检测（该脚本已被实测验证），从 apply 参数提取 key/iv hex 注册能力。
    // 无 fnRef（拿不到模块函数引用），但 keyHex 已足够：AES/HMAC 可在 node 侧用 crypto 模块重算。
    function hasEncryptShape(o) {
        if (!o || typeof o !== 'object') return false;
        const props = ['ciphertext', 'key', 'iv', 'algorithm', 'mode', 'padding', 'blockSize', 'formatter'];
        for (const p of props) { if (!(p in o)) return false; }
        return true;
    }
    function hasWordArrayShape(o) {
        return !!(o && typeof o === 'object' && 'words' in o && 'sigBytes' in o);
    }
    function hexStr(o) {
        try {
            const s = o ? o.toString() : '';
            return (typeof s === 'string' && /^[0-9a-f]+$/i.test(s) && s.length <= 64) ? s : null;
        } catch (e) { return null; }
    }
    function hookApplyCapture() {
        if (Function.prototype.apply && Function.prototype.apply.__ADB_CAPTURE__) return;
        const origApply = Function.prototype.apply;
        Function.prototype.apply = function (thisArg, argsArray) {
            try {
                if (thisArg && argsArray && typeof argsArray === 'object') {
                    // 对称加密：fn.apply(cipherObj, [cipherObj])（CryptoJS Cipher 对象 toString/formatter 调用链）
                    if (argsArray.length === 1 && hasEncryptShape(argsArray[0])) {
                        const obj = argsArray[0];
                        const keyHex = hexStr(obj.key);
                        const ivHex = obj.iv ? hexStr(obj.iv) : undefined;
                        const mode = (obj.mode && obj.mode.name) || (ivHex ? 'CBC' : 'ECB');
                        registerCapability({ kind: 'cryptojs', algorithm: 'AES', direction: 'encrypt', keyHex: keyHex, keyFormat: keyHex ? 'hex' : 'unknown', iv: ivHex, mode: mode, note: 'apply-capture (webpack 无 fnRef，keyHex 可 node 侧重算)' });
                        if (obj.ciphertext) recordEncryptMapping(null, hexStr(obj.ciphertext), 'CryptoJS/AES(apply)');
                    }
                    // 对称解密：fn.apply(obj, [2, keyWordArray, cfg])（_DEC_XFORM_MODE=2 特征）
                    else if (argsArray.length === 3 && argsArray[0] === 2 && hasWordArrayShape(argsArray[1])) {
                        const keyHex = hexStr(argsArray[1]);
                        const cfg = argsArray[2];
                        const ivHex = cfg && cfg.iv ? hexStr(cfg.iv) : undefined;
                        const mode = (cfg && cfg.mode && cfg.mode.name) || (ivHex ? 'CBC' : 'ECB');
                        registerCapability({ kind: 'cryptojs', algorithm: 'AES', direction: 'decrypt', keyHex: keyHex, keyFormat: keyHex ? 'hex' : 'unknown', iv: ivHex, mode: mode, note: 'apply-capture (webpack 无 fnRef，keyHex 可 node 侧重算)' });
                    }
                }
            } catch (e) { /* 不干扰页面 */ }
            // ⚠️ 必须用 Reflect.apply 调原生引用：origApply.apply(...) 的 .apply 会从原型链拿到
            // 已被本包装替换的 Function.prototype.apply → 无限自递归 → 栈溢出崩掉页面 JS
            return Reflect.apply(origApply, this, arguments);
        };
        Function.prototype.apply.__ADB_CAPTURE__ = true;
    }

    // ==================== fetch/XHR 响应匹配 ====================
    // 已匹配的响应键（method|url|长度）——按 URL 去重而非全局时间窗，避免并发响应漏匹配
    const matchedKeys = new Set();
    const MAX_MATCHED_KEYS = 1000;

    function hookFetchResponse() {
        if (window.fetch && window.fetch.__ADB_HOOKED__) return;
        const origFetch = window.fetch;
        window.fetch = async function (...args) {
            const resp = await origFetch(...args);
            try {
                if (registry.decryptMap.size > 0) {
                    const ct = (resp.headers && resp.headers.get && resp.headers.get('content-type')) || '';
                    if (/json|text|javascript|xml/i.test(ct)) {
                        const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
                        const clone = resp.clone();
                        clone.text().then(text => {
                            if (text && text.length > 0 && text.length < 200000) matchAndRecord(url, 'fetch', text);
                        }).catch(() => { /* 忽略 */ });
                    }
                }
            } catch (e) { /* 忽略 */ }
            return resp;
        };
        window.fetch.__ADB_HOOKED__ = true;
        try { window.fetch.__proto__ = origFetch.__proto__; } catch (e) { /* 忽略 */ }
    }

    function hookXHRResponse() {
        if (!window.XMLHttpRequest || XMLHttpRequest.prototype.__ADB_HOOKED__) return;
        const origOpen = XMLHttpRequest.prototype.open;
        const origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function (method, url) {
            try {
                this.__ADB_URL__ = String(url || '');
                this.__ADB_METHOD__ = String(method || 'xhr');
            } catch (e) { /* 忽略 */ }
            return origOpen.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function () {
            const xhr = this;
            try {
                xhr.addEventListener('load', () => {
                    try {
                        if (registry.decryptMap.size === 0) return;
                        const ct = xhr.getResponseHeader ? (xhr.getResponseHeader('content-type') || '') : '';
                        if (!/json|text|javascript|xml/i.test(ct)) return;
                        const text = xhr.responseText;
                        if (text && text.length > 0 && text.length < 200000) {
                            matchAndRecord(xhr.__ADB_URL__ || '', xhr.__ADB_METHOD__ || 'xhr', text);
                        }
                    } catch (e) { /* 忽略 */ }
                });
            } catch (e) { /* 忽略 */ }
            return origSend.apply(this, arguments);
        };
        XMLHttpRequest.prototype.__ADB_HOOKED__ = true;
    }

    function matchAndRecord(url, method, text) {
        try {
            const matchKey = method + '|' + url + '|' + text.length;
            if (matchedKeys.has(matchKey)) return;
            if (matchedKeys.size >= MAX_MATCHED_KEYS) matchedKeys.clear();
            matchedKeys.add(matchKey);
            // 1. 整体匹配
            const directHit = tryMatchCipher(text);
            if (directHit) {
                recordDecryptedResponse(url, method, directHit, text.length);
                return;
            }
            // 2. JSON 字段遍历（{code:0, data:"密文"} 模式）
            try {
                const parsed = JSON.parse(text);
                const candidates = [];
                collectCandidates(parsed, candidates, 0);
                for (const cand of candidates) {
                    const hit = tryMatchCipher(cand);
                    if (hit) {
                        recordDecryptedResponse(url, method, hit, cand.length);
                        return;
                    }
                }
            } catch (e) { /* 非 JSON，跳过 */ }
        } catch (e) { /* 忽略 */ }
    }

    function collectCandidates(obj, out, depth) {
        try {
            if (depth > 6) return;
            if (typeof obj === 'string') {
                if (obj.length >= 16 && obj.length <= 20000) out.push(obj);
                return;
            }
            if (Array.isArray(obj)) {
                if (obj.length > 200) return;
                for (const v of obj) collectCandidates(v, out, depth + 1);
                return;
            }
            if (obj && typeof obj === 'object') {
                const keys = Object.keys(obj);
                if (keys.length > 200) return;
                for (const k of keys) collectCandidates(obj[k], out, depth + 1);
            }
        } catch (e) { /* 忽略 */ }
    }

    // ==================== 计算 API（供 MCP executeScript 调用） ====================
    // 能力与操作匹配校验（防止 sign 选到 AES、encrypt 选到 HMAC 等静默错配）
    function isCapSuitable(cap, op) {
        try {
            const alg = String(cap.algorithm || '').toLowerCase();
            const dir = cap.direction || '';
            if (cap.kind === 'sm4') {
                return op === 'encrypt' ? dir === 'encrypt' : (op === 'decrypt' ? dir === 'decrypt' : false);
            }
            if (cap.kind === 'sm2') {
                if (op === 'encrypt') return dir === 'encrypt';
                if (op === 'decrypt') return dir === 'decrypt';
                if (op === 'sign') return dir === 'sign';
                return false;
            }
            if (cap.kind === 'sm3') {
                return op === 'hash';
            }
            if (cap.kind === 'cryptojs') {
                if (op === 'hash') return /^(md5|sha)/i.test(alg);
                if (op === 'sign') return alg.startsWith('hmac');
                if (op === 'encrypt' || op === 'decrypt') return alg === 'aes';
                return false;
            }
            if (cap.kind === 'webcrypto') {
                if (op === 'sign') return /hmac|ecdsa|rsa-pss|ed25519/i.test(alg);
                if (op === 'encrypt' || op === 'decrypt') return /aes|rsa-oaep|chacha/i.test(alg);
                if (op === 'hash') return false; // WebCrypto 无裸哈希能力
                return false;
            }
            return false;
        } catch (e) {
            return false;
        }
    }

    function findCapability(capId, op) {
        if (capId) {
            const cap = registry.capabilities.find(c => c.id === capId) || null;
            if (cap && !isCapSuitable(cap, op)) {
                return { cap: cap, unsuitable: true };
            }
            return cap;
        }
        // 自动选择：按 kind 优先级 + 算法/方向匹配，取 lastUsed 最近的
        const kindPrefs = {
            'sign': ['webcrypto', 'sm2', 'cryptojs'],
            'encrypt': ['sm4', 'webcrypto', 'cryptojs', 'sm2'],
            'decrypt': ['sm4', 'webcrypto', 'cryptojs', 'sm2'],
            'hash': ['sm3', 'cryptojs']
        };
        const prefs = kindPrefs[op] || [];
        for (const kind of prefs) {
            const matches = registry.capabilities.filter(c => c.kind === kind && isCapSuitable(c, op));
            if (matches.length > 0) {
                return matches[matches.length - 1];
            }
        }
        return null;
    }

    function toBytes(payload) {
        try {
            if (typeof payload === 'string') return new TextEncoder().encode(payload);
            if (payload && payload.hex) return hexToBytes(payload.hex);
            if (payload instanceof Uint8Array) return payload;
            if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
            return null;
        } catch (e) {
            return null;
        }
    }

    // base64 → hex（decrypt 输入支持 base64 密文）
    function b64ToHex(s) {
        try {
            const str = String(s).trim();
            if (str.length < 16 || str.length % 4 !== 0) return null;
            if (!/^[A-Za-z0-9+/=]+$/.test(str)) return null;
            const bin = atob(str);
            let hex = '';
            for (let i = 0; i < bin.length; i++) hex += bin.charCodeAt(i).toString(16).padStart(2, '0');
            return hex;
        } catch (e) {
            return null;
        }
    }

    // 按算法生成合法的 WebCrypto usages（混用数组对所有算法都非法）
    function usagesFor(algorithm, op) {
        const name = String(algorithm || '').toUpperCase();
        if (name.includes('HMAC') || name.includes('ECDSA') || name.includes('RSA-PSS')) {
            return op === 'sign' ? ['sign'] : ['verify'];
        }
        if (name.includes('AES') || name.includes('CHACHA') || name.includes('RSA-OAEP')) {
            return op === 'encrypt' ? ['encrypt'] : ['decrypt'];
        }
        return ['encrypt', 'decrypt', 'sign', 'verify'];
    }

    async function compute(payload, capId, op) {
        try {
            const found = findCapability(capId, op);
            if (!found) {
                return {
                    success: false,
                    error: '未找到与操作 ' + op + ' 匹配的密码学能力。请先在插件中开启 Crypto_Capture 脚本并触发一次目标站点的加密操作。' +
                        (registry.capabilities.length > 0 ? ' 当前已注册: ' + registry.capabilities.map(c => c.id + ':' + (c.direction ? c.direction + ':' : '') + c.algorithm).join(', ') : ' 当前注册表为空。')
                };
            }
            // 指定了 capId 但能力与操作不匹配 → 拒绝而非近似处理（防静默错配）
            if (found && found.unsuitable) {
                return {
                    success: false,
                    capabilityId: found.cap.id,
                    error: '指定的能力 ' + found.cap.id + '（' + found.cap.kind + '/' + found.cap.algorithm + (found.cap.direction ? '/' + found.cap.direction : '') + '）不支持操作 ' + op + '。请检查方向（encrypt/decrypt/sign/hash）是否匹配。'
                };
            }
            const cap = found;

            const output = { success: false, capabilityId: cap.id, kind: cap.kind, algorithm: cap.algorithm, direction: cap.direction, operation: op };

            // ---- SM4（fnRef 调用原始 sm-crypto 函数）----
            if (cap.kind === 'sm4') {
                if (!cap.fnRef) return { ...output, error: 'SM4 能力无函数引用（页面 Hook 前已加载？刷新页面重试）' };
                const key = cap.keyHex;
                if (!key) return { ...output, error: 'SM4 密钥未捕获（keyHex 为空），先触发一次页面内的加密调用' };
                const cfg = { mode: cap.mode || 'cbc', cipherType: cap.cipherType || 'hex' };
                if (cap.iv) cfg.iv = cap.iv;
                if (op === 'encrypt') {
                    const cipher = cap.fnRef(String(payload), key, cfg);
                    output.success = true;
                    output.result = String(cipher);
                    output.resultEncoding = cfg.cipherType || 'hex';
                } else if (op === 'decrypt') {
                    // 密文支持 hex 或 base64（base64 先转 hex 再按 cipherType 喂给原函数）
                    const hexInput = b64ToHex(payload);
                    const cipherInput = hexInput || String(payload);
                    const plain = cap.fnRef(cipherInput, key, cfg);
                    output.success = true;
                    output.result = String(plain);
                    output.resultEncoding = 'utf8';
                } else {
                    return { ...output, error: 'SM4 不支持操作: ' + op };
                }
                return output;
            }

            // ---- SM2 ----
            if (cap.kind === 'sm2') {
                if (!cap.fnRef) return { ...output, error: 'SM2 能力无函数引用' };
                if (op === 'encrypt') {
                    if (!cap.publicKey) return { ...output, error: 'SM2 公钥未捕获，先触发一次页面内的 SM2 加密' };
                    const r = cap.fnRef(String(payload), cap.publicKey);
                    output.success = true;
                    output.result = String(r);
                    return output;
                }
                if (op === 'sign') {
                    if (!cap.privateKey) return { ...output, error: 'SM2 私钥未捕获，先触发一次页面内的 SM2 签名（页面必须实际调用 doSignature）' };
                    const r = cap.fnRef(String(payload), cap.privateKey);
                    output.success = true;
                    output.result = String(r);
                    return output;
                }
                if (op === 'decrypt') {
                    if (!cap.privateKey) return { ...output, error: 'SM2 私钥未捕获，先触发一次页面内的 SM2 解密' };
                    const r = cap.fnRef(String(payload), cap.privateKey);
                    output.success = true;
                    output.result = String(r);
                    return output;
                }
                return { ...output, error: 'SM2 不支持操作: ' + op };
            }

            // ---- SM3 ----
            if (cap.kind === 'sm3') {
                if (!cap.fnRef) return { ...output, error: 'SM3 能力无函数引用' };
                const r = cap.fnRef(String(payload));
                output.success = true;
                output.result = String(r);
                return output;
            }

            // ---- CryptoJS ----
            if (cap.kind === 'cryptojs') {
                const C = window.CryptoJS;
                if (!C) return { ...output, error: 'CryptoJS 已不在页面中' };
                // 口令密钥直接传字符串（CryptoJS 内部 OpenSSL KDF）；hex 密钥才 Hex.parse
                function resolveKey() {
                    if (!cap.keyHex) return null;
                    if (cap.keyFormat === 'passphrase') return cap.keyHex;
                    try {
                        return C.enc.Hex.parse(cap.keyHex);
                    } catch (e) {
                        return cap.keyHex; // 非 hex 形（异常口令）→ 当口令处理
                    }
                }
                if (cap.algorithm && cap.algorithm.startsWith('Hmac')) {
                    const key = resolveKey();
                    if (key === null) return { ...output, error: 'HMAC 密钥未捕获' };
                    const r = C[cap.algorithm](String(payload), key);
                    output.success = true;
                    output.result = r.toString(C.enc.Hex);
                    output.resultEncoding = 'hex';
                    return output;
                }
                if (['MD5', 'SHA1', 'SHA224', 'SHA256', 'SHA384', 'SHA512', 'SHA3'].includes(cap.algorithm)) {
                    const r = C[cap.algorithm](String(payload));
                    output.success = true;
                    output.result = r.toString(C.enc.Hex);
                    output.resultEncoding = 'hex';
                    return output;
                }
                if (cap.algorithm === 'AES') {
                    const key = resolveKey();
                    if (key === null) return { ...output, error: 'AES 密钥未捕获' };
                    const cfg = { mode: C.mode[cap.mode] || C.mode.CBC, padding: C.pad.Pkcs7 };
                    if (cap.iv) {
                        try { cfg.iv = C.enc.Hex.parse(cap.iv); } catch (e) { /* iv 非 hex 时忽略 */ }
                    }
                    if (op === 'encrypt') {
                        const r = C.AES.encrypt(String(payload), key, cfg);
                        output.success = true;
                        output.result = r.toString();
                        output.resultEncoding = 'base64';
                    } else if (op === 'decrypt') {
                        const r = C.AES.decrypt(String(payload), key, cfg);
                        output.success = true;
                        output.result = r.toString(C.enc.Utf8);
                        output.resultEncoding = 'utf8';
                    } else {
                        return { ...output, error: 'CryptoJS AES 不支持操作: ' + op };
                    }
                    return output;
                }
                return { ...output, error: 'CryptoJS 能力不支持重算: ' + cap.algorithm };
            }

            // ---- WebCrypto ----
            if (cap.kind === 'webcrypto') {
                const subtle = crypto.subtle;
                if (!subtle) return { ...output, error: 'crypto.subtle 不可用' };
                let algo;
                if (cap.algoParamsRaw) {
                    algo = cap.algoParamsRaw;
                } else if (cap.algoParamsHex) {
                    algo = rebuildAlgo(cap.algoParamsHex.name, cap.algoParamsHex);
                } else {
                    algo = { name: cap.algorithm };
                }
                if (!cap.keyRef) {
                    // 用导出的 keyHex 重建密钥
                    if (!cap.keyHex) return { ...output, error: 'WebCrypto 密钥不可用（无 keyRef 且未导出）' };
                    try {
                        const keyBytes = hexToBytes(cap.keyHex);
                        const fmt = /AES|HMAC/.test(cap.algorithm || '') ? 'raw' : 'pkcs8';
                        const usages = usagesFor(cap.algorithm, op);
                        cap.keyRef = await subtle.importKey(fmt, keyBytes, { name: cap.algorithm }, false, usages);
                    } catch (e) {
                        return { ...output, error: '密钥重建失败: ' + e.message };
                    }
                }
                try {
                    if (op === 'encrypt') {
                        const data = toBytes(payload);
                        if (!data) return { ...output, error: 'payload 编码失败' };
                        const r = await subtle.encrypt(algo, cap.keyRef, data);
                        output.success = true;
                        output.result = bufToB64(r);
                        output.resultHex = bufToHex(r);
                        output.resultEncoding = 'base64';
                    } else if (op === 'decrypt') {
                        // 支持 hex 或 base64 密文输入
                        const hexInput = b64ToHex(payload);
                        const cipherBytes = hexInput ? hexToBytes(hexInput)
                            : (/^[0-9a-fA-F]+$/.test(String(payload)) && String(payload).length % 2 === 0 ? hexToBytes(String(payload)) : null);
                        if (!cipherBytes) return { ...output, error: '密文编码无法识别（需 hex 或 base64）' };
                        const r = await subtle.decrypt(algo, cap.keyRef, cipherBytes);
                        output.success = true;
                        output.result = new TextDecoder().decode(r);
                        output.resultEncoding = 'utf8';
                    } else if (op === 'sign') {
                        const data = toBytes(payload);
                        if (!data) return { ...output, error: 'payload 编码失败' };
                        const r = await subtle.sign(algo, cap.keyRef, data);
                        output.success = true;
                        output.result = bufToB64(r);
                        output.resultHex = bufToHex(r);
                        output.resultEncoding = 'base64';
                    } else {
                        return { ...output, error: 'WebCrypto 不支持操作: ' + op };
                    }
                } catch (e) {
                    return { ...output, error: 'WebCrypto 计算失败: ' + e.message, capabilityId: cap.id };
                }
                return output;
            }

            return { ...output, error: '未知能力类型: ' + cap.kind };
        } catch (e) {
            return { success: false, error: 'compute 异常: ' + e.message };
        }
    }

    // ==================== 对外 API（仅暴露只读接口，registry 闭包私有） ====================
    window.__ADB_CRYPTO__ = {
        getRegistry: function () {
            return {
                capabilities: registry.capabilities.map(serializableCap),
                decryptMapSize: registry.decryptMap.size,
                decryptedResponseCount: registry.decryptedResponses.length,
                lastSignResults: signResults.slice(-5),
                initErrors: initErrors.slice(0, 10)
            };
        },
        getDecryptedResponses: function (limit) {
            const n = Math.max(1, Math.min(Math.floor(limit || 50), 200));
            return registry.decryptedResponses.slice(-n);
        },
        // V4.9.19（批次4 明文对照）：批量"密文→明文"查询——抓包归并（mcp-client.js）调用。
        // 传入一批 body 文本，逐条返回命中的明文（整体匹配 + JSON 字段遍历；URL 编码变体自动解码）
        lookupBatch: function (texts) {
            const out = [];
            try {
                const arr = Array.isArray(texts) ? texts.slice(0, 50) : [];
                for (const t of arr) {
                    if (typeof t !== 'string' || t.length < 16) { out.push(null); continue; }
                    let hit = tryMatchCipher(t);
                    if (!hit) {
                        try {
                            const parsed = JSON.parse(t);
                            const cands = [];
                            collectCandidates(parsed, cands, 0);
                            for (const c of cands) {
                                const h = tryMatchCipher(c);
                                if (h) { hit = h; break; }
                            }
                        } catch (e) { /* 非 JSON */ }
                    }
                    out.push(hit ? {
                        algorithm: hit.algorithm,
                        plaintext: ((hit.plainB64 ? decodeB64ToText(hit.plainB64) : (hit.plainHex ? hexToText(hit.plainHex) : '')) || '').slice(0, 4000),
                        ts: hit.ts
                    } : null);
                }
            } catch (e) { /* 忽略 */ }
            return out;
        },
        compute: compute
    };

    // ==================== 初始化（逐个兜底，失败可诊断） ====================
    try {
        hookSubtle();
    } catch (e) {
        initErrors.push('hookSubtle: ' + (e && e.message));
    }
    try {
        hookSM();
    } catch (e) {
        initErrors.push('hookSM: ' + (e && e.message));
    }
    try {
        hookFetchResponse();
    } catch (e) {
        initErrors.push('hookFetchResponse: ' + (e && e.message));
    }
    try {
        hookXHRResponse();
    } catch (e) {
        initErrors.push('hookXHRResponse: ' + (e && e.message));
    }
    try {
        hookApplyCapture();
    } catch (e) {
        initErrors.push('hookApplyCapture: ' + (e && e.message));
    }
    if (initErrors.length > 0) {
        safeLog('%c[CryptoCapture] 初始化部分失败', 'color: #ef4444', initErrors);
    }

    // CryptoJS 可能在 chunk 里延迟加载 → 长驻低频轮询（幂等 hook，页面存续期间持续尝试）
    // 先扫 webpack 模块注册表（webpack 打包场景 window.CryptoJS 不存在），再尝试 window 全局
    setInterval(() => {
        scanWebpackCryptoJS();
        hookCryptoJS();
    }, 1000);

    safeLog('%c[CryptoCapture] 已挂载：密码学能力注册表 + 响应自动解密', 'color: #22d3ee', '开启后将捕获 WebCrypto/SM/CryptoJS 的密钥与函数，MCP 可调用 sign_payload 重放签名');
})();
