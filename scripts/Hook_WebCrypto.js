// ==UserScript==
// @name         Hook_WebCrypto
// @namespace    https://github.com/0xsdeo/AntiDebug_Breaker
// @version      2026-08-27
// @description  Hook WebCrypto (crypto.subtle) 的 importKey/generateKey/encrypt/decrypt，输出算法、密钥、iv、明文/密文
// @author       0xsdeo / fusheng
// @run-at       document-start
// @match        *
// @grant        none
// ==/UserScript==

// Hook WebCrypto API（现代前端的默认加密实现，AES-GCM 密文每次不同，只能运行时 Hook）
(function () {
    'use strict';

    const LOCK_KEY = '__HOOK_WEBCRYPTO__';
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

    // 仅在安全上下文（https/localhost）且存在 crypto.subtle 时生效
    if (!window.crypto || !crypto.subtle || typeof crypto.subtle.importKey !== 'function') {
        console.warn('[HookWebCrypto] 当前环境无 crypto.subtle，跳过');
        return;
    }

    const subtle = crypto.subtle;

    // Buffer/ArrayBuffer 转 hex/base64 帮助函数
    function bufToHex(buf) {
        try {
            if (typeof buf === 'string') return buf;
            const arr = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
            return Array.from(arr.slice(0, 512)).map(b => b.toString(16).padStart(2, '0')).join('');
        } catch (e) {
            return '[unserializable]';
        }
    }

    function bufToB64(buf) {
        try {
            if (typeof buf === 'string') return buf;
            const arr = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
            let bin = '';
            const chunk = arr.slice(0, 1024);
            for (const b of chunk) bin += String.fromCharCode(b);
            return btoa(bin);
        } catch (e) {
            return '[unserializable]';
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

    function safeLog(...args) {
        try {
            console.log(...args);
        } catch (e) { /* 忽略 */ }
    }

    // ========== Hook importKey：捕获密钥导入 ==========
    const rawImportKey = subtle.importKey.bind(subtle);
    subtle.importKey = async function (format, keyData, algo, extractable, keyUsages) {
        safeLog('%c[HookWebCrypto] importKey', 'color: #22d3ee', {
            format,
            keyData: format === 'raw' || format === 'jwk'
                ? (format === 'raw' ? bufToHex(keyData) : JSON.stringify(keyData).slice(0, 300))
                : `[${format}]`,
            algorithm: fmtAlgo(algo),
            extractable,
            keyUsages
        });
        const result = await rawImportKey(format, keyData, algo, extractable, keyUsages);
        // extractable=true 时直接导出原始密钥（拿到对称密钥=拿到一切）
        if (result && extractable === true && subtle.exportKey) {
            try {
                if (algo.name && !algo.name.includes('ECDSA') && !algo.name.includes('ECDH') && !algo.name.includes('RSA')) {
                    const exported = await subtle.exportKey('raw', result);
                    safeLog('%c[HookWebCrypto] ⭐ 导出对称密钥 (extractable)', 'color: #fbbf24', {
                        algorithm: algo.name,
                        keyHex: bufToHex(exported),
                        keyBase64: bufToB64(exported)
                    });
                }
            } catch (e) { /* extractable 密钥导出失败，忽略 */ }
        }
        return result;
    };

    // ========== Hook generateKey ==========
    const rawGenerateKey = subtle.generateKey.bind(subtle);
    subtle.generateKey = async function (algo, extractable, keyUsages) {
        safeLog('%c[HookWebCrypto] generateKey', 'color: #22d3ee', {
            algorithm: fmtAlgo(algo),
            extractable,
            keyUsages
        });
        const result = await rawGenerateKey(algo, extractable, keyUsages);
        if (result && extractable === true && subtle.exportKey) {
            try {
                if (algo.name && !algo.name.includes('ECDSA') && !algo.name.includes('ECDH') && !algo.name.includes('RSA')) {
                    const exported = await subtle.exportKey('raw', result);
                    safeLog('%c[HookWebCrypto] ⭐ 导出生成密钥 (extractable)', 'color: #fbbf24', {
                        algorithm: algo.name,
                        keyHex: bufToHex(exported),
                        keyBase64: bufToB64(exported)
                    });
                }
            } catch (e) { /* 忽略 */ }
        }
        return result;
    };

    // ========== Hook encrypt：记录明文+算法+iv ==========
    const rawEncrypt = subtle.encrypt.bind(subtle);
    subtle.encrypt = async function (algo, key, data) {
        const a = fmtAlgo(algo);
        safeLog('%c[HookWebCrypto] encrypt', 'color: #a78bfa', {
            algorithm: a,
            plaintextHex: bufToHex(data),
            plaintextB64: bufToB64(data),
            keyInfo: key && { algorithm: key.algorithm && key.algorithm.name, type: key.type, extractable: key.extractable }
        });
        const result = await rawEncrypt(algo, key, data);
        safeLog('%c[HookWebCrypto] encrypt 结果', 'color: #a78bfa', {
            algorithm: a && a.name,
            ciphertextHex: bufToHex(result)
        });
        return result;
    };

    // ========== Hook decrypt：记录密文+算法+iv ==========
    const rawDecrypt = subtle.decrypt.bind(subtle);
    subtle.decrypt = async function (algo, key, data) {
        const a = fmtAlgo(algo);
        safeLog('%c[HookWebCrypto] decrypt', 'color: #a78bfa', {
            algorithm: a,
            ciphertextHex: bufToHex(data)
        });
        const result = await rawDecrypt(algo, key, data);
        safeLog('%c[HookWebCrypto] ⭐ decrypt 明文', 'color: #fbbf24', {
            algorithm: a && a.name,
            plaintextHex: bufToHex(result),
            plaintextB64: bufToB64(result)
        });
        return result;
    };

    safeLog('%c[HookWebCrypto] 已挂载，等待加密调用...', 'color: #22d3ee');
})();
