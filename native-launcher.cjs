// Fush MCP — HTTP 服务按需启动器（Chrome/Edge Native Messaging Host）
//
// 被浏览器扩展叫醒（打开插件 MCP 开关 / SW 初始化 / WS 连接失败时）→ 检查 HTTP 服务是否在跑
// → 没跑就拉起 → 退出。不常驻、不开机自启：不打开插件开关时，电脑上零渗透进程。
//
// ⚠️ 保持 .cjs 后缀（CJS 模块）：项目根若出现 package.json "type":"module" 会破坏 require ——勿改回 .js
// ⚠️ stdout 是 Native Messaging 协议通道（4 字节 LE 长度头 + JSON）——严禁 console.log 污染
// 安装：install-native-launcher.bat（HKCU 注册，无需管理员）
// 日志：决策与错误追加到 temp/http-server.log（带 [launcher] 时间戳前缀）
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');
const { connect: netConnect } = require('net');

const PROJECT_DIR = __dirname;                                  // 本文件位于项目根
const SERVER_DIR = path.join(PROJECT_DIR, 'mcp-server');       // 服务工作目录
const LOG_PATH = path.join(PROJECT_DIR, 'temp', 'http-server.log');
const STAMP_FILE = path.join(PROJECT_DIR, 'temp', '.http-launcher-last-start');
// V4.9.6.1（审计 L-2）：端口跟随 MCP_HTTP_PORT（与 server 端一致；浏览器启动的 host 继承系统环境变量）
const HEALTH_PORT = Number(process.env.MCP_HTTP_PORT) || 18080;
const COOLDOWN_MS = 60000;

// 决策日志（审计 M-2：失败链路必须有据可查；temp 缺失自动建）
function launcherLog(msg) {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, `[launcher ${new Date().toISOString()}] ${msg}\n`);
  } catch (e) { /* 日志失败绝不阻断主流程 */ }
}

// 探测服务是否在跑（/health 200 = 在跑）。
// V4.9.38（批 4 审计 D-01 🔴）：**不再只认状态码**——同时取回 version/pid，
// 由调用方与「当前代码的版本」比对。原实现只认 200，于是旧实例（旧 build / 移动前目录 /
// 卸载遗留进程）被当成"自己人"，新版本静默不生效（项目在 START_HERE:61 记过同型事故：
// 版本六处已是 4.9.34，运行中服务仍返回 4.9.33）。
function probeService() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: HEALTH_PORT, path: '/health', timeout: 1500 }, (res) => {
      let body = '';
      res.on('data', (c) => { if (body.length < 8192) body += c; });
      res.on('end', () => {
        let info = null;
        try { info = JSON.parse(body); } catch (e) { /* 旧版 /health 没有 JSON 体 */ }
        resolve({
          ok: res.statusCode === 200,
          version: info && info.version ? String(info.version) : '',
          pid: info && info.pid ? Number(info.pid) : 0
        });
      });
    });
    req.on('error', () => resolve({ ok: false, version: '', pid: 0 }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, version: '', pid: 0 }); });
  });
}

// 当前代码的期望版本（mcp-server/package.json）——用于识别"旧进程还在跑"
function readExpectedVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(SERVER_DIR, 'package.json'), 'utf8'));
    return String(pkg.version || '');
  } catch (e) { return ''; }
}

// V4.9.10.2（审计 Note-8）：WS 端口占用探测——stdio 模式实例没有 HTTP 端口，
// 只看 /health 会误判"服务没跑"→ 空拉一个必被 9527 冲突干掉的进程（6s 僵尸 + 误报 started-unconfirmed）。
// WS 端口被占 = 已有实例在服务（stdio 或 http），视为"在跑"。
function probeWsPort() {
  return new Promise((resolve) => {
    const port = Number(process.env.MCP_PORT) || 9527;
    const s = netConnect({ port, host: '127.0.0.1' });
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; try { s.destroy(); } catch (e) { /* 忽略 */ } resolve(v); } };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    setTimeout(() => done(false), 800);
  });
}

// 冷却戳读写（记录 ts + pid）
function readStamp() {
  try { return JSON.parse(fs.readFileSync(STAMP_FILE, 'utf8')); } catch (e) { return null; }
}
function writeStamp(pid) {
  try { fs.mkdirSync(path.dirname(STAMP_FILE), { recursive: true }); fs.writeFileSync(STAMP_FILE, JSON.stringify({ ts: Date.now(), pid: pid || 0 })); } catch (e) { /* 忽略 */ }
}
function clearStamp() {
  try { fs.unlinkSync(STAMP_FILE); } catch (e) { /* 忽略 */ }
}
function isPidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; } // EPERM=进程存在但无权限（视为活）
}
// 是否处于启动冷却。防"服务永久起不来（如端口被占）→ 扩展反复叫醒 → 反复 spawn 失败进程"的循环。
// 关键（审计 M-1）：仅当上次拉起的进程**仍存活**才维持冷却——服务启动后被杀的典型场景应放行立即自愈。
// 边界（审计 L-3）：未来时间戳（休眠/NTP 回拨）视为过期，不无限延长冷却。
function inCooldown() {
  const s = readStamp();
  if (!s || !Number.isFinite(s.ts)) return false;
  const age = Date.now() - s.ts;
  if (age < 0 || age >= COOLDOWN_MS) return false;
  if (s.pid && !isPidAlive(s.pid)) return false; // 上次启动的服务已死 → 放行重启
  return true;
}

// 拉起 HTTP 服务（detached：launcher 退出后服务继续跑；日志追加；bundle 自包含不依赖 node_modules）
function startService() {
  let logFd = null;
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true }); // 审计 M-3：temp 缺失自动建
    logFd = fs.openSync(LOG_PATH, 'a');
  } catch (e) {
    launcherLog(`日志文件不可写（降级为丢弃输出）: ${e && e.message}`);
    logFd = null;
  }
  try {
    const child = spawn(process.execPath, ['dist/index.bundle.cjs', '--http'], {
      cwd: SERVER_DIR,
      detached: true,
      stdio: logFd !== null ? ['ignore', logFd, logFd] : ['ignore', 'ignore', 'ignore'],
      windowsHide: true
    });
    child.unref();
    return { started: true, pid: child.pid };
  } catch (e) {
    return { started: false, error: String((e && e.message) || e) };
  }
}

// Native Messaging 协议：4 字节小端长度头 + UTF-8 JSON（回调后退出，确保 stdout 冲刷——审计 N-1）
function respond(obj) {
  try {
    const json = Buffer.from(JSON.stringify(obj), 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(json.length, 0); // Buffer 字节长度（中文 note 亦正确）
    process.stdout.write(Buffer.concat([header, json]), () => setTimeout(() => process.exit(0), 50));
  } catch (e) {
    process.exit(1);
  }
}

function readMessages(onMsg) {
  let buf = Buffer.alloc(0);
  process.stdin.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) break;
      const body = buf.slice(4, 4 + len).toString('utf8');
      buf = buf.slice(4 + len);
      try { onMsg(JSON.parse(body)); } catch (e) { /* 忽略坏消息 */ }
    }
  });
  process.stdin.on('end', () => process.exit(0));
  process.stdin.on('error', () => process.exit(0));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

readMessages(async (msg) => {
  const cmd = msg && msg.cmd;
  if (cmd !== 'ensure') { respond({ status: 'unknown-cmd' }); return; }

  const probe = await probeService();
  const wsAlive = probe.ok ? false : await probeWsPort();
  const running = probe.ok || wsAlive; // V4.9.10.2：HTTP 或 WS 任一在服务即视为在跑（覆盖 stdio 模式）
  if (running) {
    const expected = readExpectedVersion();
    const actual = probe.version;
    // V4.9.38（批 4 审计 D-01 🔴）：版本不一致 = 旧进程还在跑，新 build 静默不生效。
    // 不自动杀进程（可能误杀用户的其它 node），只如实上报，由调用方/人决定重启。
    if (expected && actual && actual !== expected) {
      launcherLog(`ensure → version-mismatch（运行中 ${actual}，当前代码 ${expected}，pid=${probe.pid}）`);
      respond({
        status: 'version-mismatch',
        running_version: actual,
        expected_version: expected,
        pid: probe.pid,
        note: `运行中的 MCP 服务是旧版本（${actual}），当前代码是 ${expected} —— 新 build 不生效。结束占用 18080/9527 的 node 进程后重试（扩展会自动把服务拉起来）。`
      });
      return;
    }
    launcherLog('ensure → already-running' + (actual ? `（version ${actual}）` : '（旧版 /health 无版本信息）'));
    respond({ status: 'already-running', version: actual || undefined, pid: probe.pid || undefined });
    return;
  }
  if (inCooldown()) {
    const s = readStamp();
    launcherLog(`ensure → start-cooldown（上次启动 pid=${s && s.pid} 仍未就绪，冷却中）`);
    respond({ status: 'start-cooldown', note: '60 秒内已尝试过启动，服务暂未就绪（检查 temp/http-server.log）' });
    return;
  }
  const r = startService();
  if (!r.started) {
    launcherLog(`ensure → start-failed: ${r.error}`);
    writeStamp(0); // 启动失败：写冷却防死循环
    respond({ status: 'start-failed', error: r.error });
    return;
  }
  launcherLog(`ensure → spawned pid=${r.pid}，等待确认...`);
  await sleep(2500); // 服务初始化约 1-2 秒，等待后二次探测（审计：避免乐观状态）
  const after = await probeService();
  if (after.ok) {
    launcherLog(`ensure → started-confirmed pid=${r.pid} version=${after.version || '?'}`);
    clearStamp(); // 审计 M-1 修复核心：成功不写冷却——服务被杀时应能立即自愈重启
    respond({ status: 'started-confirmed', pid: r.pid, version: after.version || undefined });
  } else {
    launcherLog(`ensure → started-unconfirmed pid=${r.pid}（2.5s 后仍未就绪，写入冷却）`);
    writeStamp(r.pid); // 未确认成功：写冷却防死循环
    respond({ status: 'started-unconfirmed', pid: r.pid });
  }
});

// 安全兜底：15 秒无消息也退出（防 host 僵死；覆盖 2.5s 确认等待 + 余量）
setTimeout(() => process.exit(0), 15000);
