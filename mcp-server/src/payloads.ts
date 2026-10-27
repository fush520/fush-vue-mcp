// 由 temp/tool_extract_payloads.js --ts 生成 —— 字段来源是**客户端 handler 的解构参数**
// （不是工具层 schema：工具层传了客户端不认的字段 = 静默 no-op，那正是要拦的）。
// 全字段可选 —— 靠 TS 的多余属性检查抓拼写错误，零误报。改字段前先跑那个脚本。

/** `ANALYZE_API_SIGNATURE` → `analyzeAPISignature()` */
export interface AnalyzeApiSignaturePayload {
    // 只吃作用域，无其它字段
}

/** `ANALYZE_AUTHENTICATION` → `analyzeAuthentication()` */
export interface AnalyzeAuthenticationPayload {
    // 只吃作用域，无其它字段
}

/** `ANALYZE_PAGE_ENCRYPTION` → `analyzePageEncryption()` */
export interface AnalyzePageEncryptionPayload {
    // 只吃作用域，无其它字段
}

/** `ANON_FETCH` → `anonFetch()` */
export interface AnonFetchPayload {
    url?: string;
    method?: string;
    body?: string | Record<string, any> | null;
    timeout?: number;
    authHeaders?: Record<string, string> | null;
}

/** `AUTO_BYPASS_ANTI_DEBUG` → `autoBypassAntiDebug()` */
export interface AutoBypassAntiDebugPayload {
    // 只吃作用域，无其它字段
}

/** `AUTO_FILL_FORM` → `autoFillForm()` */
export interface AutoFillFormPayload {
    formIndex?: number;
    values?: Record<string, any>;
}

/** `AUTO_LOGIN_AND_CAPTURE` → `autoLoginAndCapture()` */
export interface AutoLoginAndCapturePayload {
    username?: string;
    password?: string;
    usernameSelector?: string;
    passwordSelector?: string;
    submitSelector?: string;
    waitTime?: number;
}

/** `BATCH_ENABLE_SCRIPTS` → `batchEnableScripts()` */
export interface BatchEnableScriptsPayload {
    scriptIds?: string[];
    enabled?: boolean;
    autoRefresh?: boolean;
}

/** `CLICK_ELEMENT` → `clickElement()` */
export interface ClickElementPayload {
    selector?: string;
    x?: number;
    y?: number;
    ref?: string;
    dblClick?: boolean;
    index?: number;
    onDialog?: string;
}

/** `DEBUG_CONTROL` → `debugControl()` */
export interface DebugControlPayload {
    action?: string;
    urlRegex?: string;
    lineNumber?: number;
    columnNumber?: number;
    breakpointId?: string;
}

/** `DECRYPT_RSA` → `decryptRSA()` */
export interface DecryptRsaPayload {
    encryptedData?: string;
    privateKey?: string;
}

/** `DEEP_LINK_PROBE` → `deepLinkProbe()` */
export interface DeepLinkProbePayload {
    targetPath?: string;
    wait?: number;
    patchBounce?: boolean;
}

/** `DETECT_ANTI_DEBUG` → `detectAntiDebug()` */
export interface DetectAntiDebugPayload {
    // 只吃作用域，无其它字段
}

/** `DISABLE_ALL_SCRIPTS` → `disableAllScripts()` */
export interface DisableAllScriptsPayload {
    autoRefresh?: boolean;
}

/** `ENABLE_ENCRYPTION_HOOKS` → `enableEncryptionHooks()` */
export interface EnableEncryptionHooksPayload {
    // 只吃作用域，无其它字段
}

/** `EXECUTE_SCRIPT` → `executeScript()` */
export interface ExecuteScriptPayload {
    code?: string;
    world?: string;
}

/** `GET_COOKIES` → `getCookies()` */
export interface GetCookiesPayload {
    name?: string;
    httpOnly?: boolean;
}

/** `GET_ENABLED_SCRIPTS` → `getEnabledScripts()` */
export interface GetEnabledScriptsPayload {
    // 只吃作用域，无其它字段
}

/** `GET_LOCAL_STORAGE` → `getLocalStorage()` */
export interface GetLocalStoragePayload {
    key?: string;
}

/** `GET_SESSION_STORAGE` → `getSessionStorage()` */
export interface GetSessionStoragePayload {
    key?: string;
}

/** `EXTRACT_PAGE_DATA` → `extractPageData()` */
export interface ExtractPageDataPayload {
    selectors?: Record<string, string>;
}

/** `EXTRACT_REACT_DATA` → `extractReactData()` */
export interface ExtractReactDataPayload {
    selector?: string;
}

/** `EXTRACT_VUE_DATA` → `extractVueData()` */
export interface ExtractVueDataPayload {
    selector?: string;
}

/** `FILL_INPUT` → `fillInput()` */
export interface FillInputPayload {
    selector?: string;
    value?: string;
    clear?: boolean;
}

/** `GET_CAPTURED_ENCRYPTION` → `getCapturedEncryption()` */
export interface GetCapturedEncryptionPayload {
    // 只吃作用域，无其它字段
}

/** `GET_CONSOLE_MESSAGES` → `getConsoleMessages()` */
export interface GetConsoleMessagesPayload {
    limit?: number;
    types?: any[];
}

/** `GET_CRYPTO_REGISTRY` → `getCryptoRegistry()` */
export interface GetCryptoRegistryPayload {
    // 只吃作用域，无其它字段
}

/** `GET_DEBUG_STATE` → `getDebugState()` */
export interface GetDebugStatePayload {
    callFrameIndex?: number;
    scopeIndex?: number;
    maxVars?: number;
}

/** `GET_DECRYPTED_RESPONSES` → `getDecryptedResponses()` */
export interface GetDecryptedResponsesPayload {
    limit?: number;
}

/** `GET_DOM_INFO` → `getDOMInfo()` */
export interface GetDomInfoPayload {
    selector?: string;
    depth?: number;
}

/** `GET_ELEMENT_INFO` → `getElementInfo()` */
export interface GetElementInfoPayload {
    selector?: string;
}

/** `GET_JS_CHUNKS` → `getJSChunks()` */
export interface GetJsChunksPayload {
    maxChunks?: number;
}

/** `GET_NETWORK_REQUESTS` → `getNetworkRequests()` */
export interface GetNetworkRequestsPayload {
    limit?: number;
    filter?: string;
    method?: string;
    includeBody?: boolean;
    detail?: boolean;
}

/** `GET_NETWORK_REQUESTS_BURP` → `getNetworkRequestsBurp()` */
export interface GetNetworkRequestsBurpPayload {
    filter?: string;
    limit?: number;
}

/** `GET_NETWORK_REQUESTS_WITH_BODY` → `getNetworkRequestsWithBody()` */
export interface GetNetworkRequestsWithBodyPayload {
    filter?: string;
    limit?: number;
}

/** `GET_NETWORK_REQUEST_DETAIL` → `getNetworkRequestDetail()` */
export interface GetNetworkRequestDetailPayload {
    requestId?: string;
}

/** `GET_PAGE_INFO` → `getPageInfo()` */
export interface GetPageInfoPayload {
    // 只吃作用域，无其它字段
}

/** `GET_SEMANTIC_DOM` → `getSemanticDom()` */
export interface GetSemanticDomPayload {
    filter?: string;
    limit?: number;
}

/** `GET_SENSITIVE_ALERTS` → `getSensitiveAlerts()` */
export interface GetSensitiveAlertsPayload {
    limit?: number;
    severityFilter?: string;
}

/** `GET_STORE_DUMP` → `getStoreDump()` */
export interface GetStoreDumpPayload {
    // 只吃作用域，无其它字段
}

/** `GET_VUE_ROUTER_DATA` → `getVueRouterData()` */
export interface GetVueRouterDataPayload {
    timeoutMs?: number;
}

/** `GET_WS_FRAMES` → `getWSFrames()` */
export interface GetWsFramesPayload {
    limit?: number;
    filter?: string;
}

/** `HANDLE_DIALOG` → `handleDialog()` */
export interface HandleDialogPayload {
    accept?: boolean;
    promptText?: string;
}

/** `HOOK_ROUTE_ARRAY` → `hookRouteArray()` */
export interface HookRouteArrayPayload {
    urlKeyword?: string;
    fromStr?: string;
    toStr?: string;
    once?: boolean;
    reload?: boolean;
}

/** `INJECT_ENCRYPTION_CAPTURE` → `injectEncryptionCapture()` */
export interface InjectEncryptionCapturePayload {
    // 只吃作用域，无其它字段
}

/** `NAVIGATE_TO` → `navigateTo()` */
export interface NavigateToPayload {
    url?: string;
    /** V4.9.41：url / back / forward / reload（对齐 chrome-devtools 的 navigate_page） */
    action?: string;
}

/** `NUXT_PAYLOAD_PROBE` → `nuxtPayloadProbe()` */
export interface NuxtPayloadProbePayload {
    paths?: any[];
    waitMs?: number;
}

/** `PRESS_KEY` → `pressKey()` */
export interface PressKeyPayload {
    key?: string;
    modifiers?: any[];
}

/** `TAB_MANAGE` → `tabManage()`（V4.9.41：标签列表/切换/关闭，对齐 chrome-devtools 的 list/select/close_page） */
export interface TabManagePayload {
    action?: string;
    tabId?: number;
    index?: number;
}

/** `UPLOAD_FILE` → `uploadFile()`（V4.9.41：CDP DOM.setFileInputFiles 真实文件注入） */
export interface UploadFilePayload {
    selector?: string;
    files?: string[] | string;
}

/** `EMULATE` → `emulate()`（V4.9.41：视口/设备/UA/时区/地理位置/网络限速） */
export interface EmulatePayload {
    width?: number;
    height?: number;
    deviceScaleFactor?: number;
    mobile?: boolean;
    userAgent?: string;
    platform?: string;
    acceptLanguage?: string;
    timezone?: string;
    latitude?: number;
    longitude?: number;
    accuracy?: number;
    offline?: boolean;
    latency?: number;
    downloadThroughput?: number;
    uploadThroughput?: number;
    reset?: boolean;
}

/** `CONSOLE_LOG` → `consoleLog()`（V4.9.41：页面 console 全量捕获 start/read/clear） */
export interface ConsoleLogPayload {
    action?: string;
    limit?: number;
}

/** `REAL_CLICK` → `realClick()` */
export interface RealClickPayload {
    selector?: string;
    x?: number;
    y?: number;
    ref?: string;
    dblClick?: boolean;
    wait?: number;
    index?: number;
    onDialog?: string;
}

/** `REAL_DRAG` → `realDrag()`（V4.9.39：鼠标级拖拽，滑块验证码/rc-slider） */
export interface RealDragPayload {
    selector?: string;
    x?: number;
    y?: number;
    toSelector?: string;
    toX?: number;
    toY?: number;
    dx?: number;
    dy?: number;
    steps?: number;
    durationMs?: number;
    easing?: string;
    jitter?: number;
    button?: string;
    wait?: number;
    index?: number;
    holdBeforeReleaseMs?: number;
    onDialog?: string;
}

/** `MOUSE_CONTROL` → `mouseControl()`（V4.9.39：低层鼠标原语，滑块分步调试） */
export interface MouseControlPayload {
    action?: string;
    x?: number;
    y?: number;
    toX?: number;
    toY?: number;
    steps?: number;
    durationMs?: number;
    easing?: string;
    jitter?: number;
    button?: string;
    clickCount?: number;
}

/** `REAL_HOVER` → `realHover()` */
export interface RealHoverPayload {
    selector?: string;
    x?: number;
    y?: number;
    wait?: number;
    index?: number;
}

/** `REAL_KEY` → `realKey()` */
export interface RealKeyPayload {
    key?: string;
    selector?: string;
    wait?: number;
    index?: number;
}

/** `REAL_TYPE` → `realType()` */
export interface RealTypePayload {
    selector?: string;
    text?: string;
    delay?: number;
    submit?: boolean;
    clear?: boolean;
    wait?: number;
    index?: number;
}

/** `REFRESH_PAGE` → `refreshPage()` */
export interface RefreshPagePayload {
    hardRefresh?: boolean;
}

/** `SCROLL_PAGE` → `scrollPage()` */
export interface ScrollPagePayload {
    x?: number;
    y?: number;
    selector?: string;
    behavior?: string;
}

/** `SIGN_PAYLOAD` → `signPayload()` */
export interface SignPayloadPayload {
    payload?: string;
    capabilityId?: string;
    operation?: string;
}

/** `START_SENSITIVE_MONITOR` → `startSensitiveMonitor()` */
export interface StartSensitiveMonitorPayload {
    patterns?: string[];
    alertOnCritical?: boolean;
}

/** `TAKE_A11Y_SNAPSHOT` → `takeA11ySnapshot()` */
export interface TakeA11ySnapshotPayload {
    filter?: string;
    limit?: number;
}

/** `TAKE_SCREENSHOT` → `takeScreenshot()` */
export interface TakeScreenshotPayload {
    fullPage?: boolean;
    selector?: string;
}

/** `TOGGLE_SCRIPT` → `toggleScript()` */
export interface ToggleScriptPayload {
    scriptId?: string;
    enabled?: boolean;
}

/** `WAIT_FOR_SELECTOR` → `waitForSelector()` */
export interface WaitForSelectorPayload {
    selector?: string;
    /** V4.9.41：与 selector 二选一——等页面 innerText 出现该文本（对齐 chrome-devtools 的 wait_for） */
    text?: string;
    timeout?: number;
    visible?: boolean;
}

