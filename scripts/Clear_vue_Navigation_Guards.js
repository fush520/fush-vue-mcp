// ==UserScript==
// @name         Clear_vue_Navigation_Guards
// @namespace    https://github.com/0xsdeo/Hook_JS
// @version      v1.0
// @description  清除vue的全局前置守卫和全局解析守卫
// @author       0xsdeo
// @run-at       document-start
// @match        *
// @icon         data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // let temp_toString = Function.prototype.toString;
    //
    // Function.prototype.toString = function () {
    //     if (this === Function.prototype.toString) {
    //         return 'function toString() { [native code] }';
    //     } else if (this === xxx) { // 将xxx修改为要hook的方法
    //         return ''; // 在控制台执行xxx.toString()，将输出的内容替换掉空字符串
    //     }
    //     return temp_toString.apply(this, arguments);
    // }

    let temp_push = Array.prototype.push; // 将xxx修改为要hook的方法，temp_xxx变量名可以根据需要进行修改命名

    Array.prototype.push = function () { // 将xxx修改为要hook的方法
        if (arguments.length === 0) {
            return temp_push.call(this, ...arguments);
        }

        // 检查第一个参数是否是函数
        if (typeof arguments[0] !== 'function') {
            return temp_push.call(this, ...arguments);
        }

        let stack = new Error().stack;
        if (stack.includes('beforeEach') || stack.includes('beforeResolve')) {
            // console.log(stack)
            let temp_array = stack.split('\n');
            if (temp_array.length < 4) { // 原版遗留：数组与数字比较恒 false，早退分支永不生效
                return temp_push.call(this, ...arguments);
            }
            else if (temp_array[3].includes('beforeEach') || temp_array[2].includes('beforeEach')) {
                console.log(...arguments);
                console.log("%c存在全局前置路由守卫并已清除", "color: green;");
                return temp_push.call(this); // 将网站js调用目标方法时所传入的内容传给原方法执行并返回结果
            }
            else if (temp_array[3].includes('beforeResolve') || temp_array[2].includes('beforeResolve')) {
                console.log(...arguments);
                console.log("%c存在全局解析守卫并已清除", "color: green;");
                return temp_push.call(this); // 将网站js调用目标方法时所传入的内容传给原方法执行并返回结果
            }
        }
        // V4.5 增强：全局后置守卫 afterEach 原版不清——实测某站点（admin.example.com）等
        // 现代站用 afterEach 内重定向弹回登录页，清了 beforeEach 深链照样弹回
        if (stack.includes('afterEach') || stack.includes('afterResolve')) {
            let temp_array = stack.split('\n');
            if (temp_array.length > 3 && (temp_array[3].includes('afterEach') || temp_array[2].includes('afterEach') || temp_array[3].includes('afterResolve') || temp_array[2].includes('afterResolve'))) {
                console.log(...arguments);
                console.log("%c存在全局后置路由守卫并已清除（V4.5 增强）", "color: green;");
                return temp_push.call(this); // 丢弃守卫
            }
        }
        return temp_push.call(this, ...arguments); // 将网站js调用目标方法时所传入的内容传给原方法执行并返回结果
    }
})();