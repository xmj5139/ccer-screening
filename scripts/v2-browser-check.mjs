#!/usr/bin/env node
/**
 * v2 六模块工作台 · 浏览器渲染检查（零依赖，CDP 驱动）
 * ============================================================================
 * 为什么不用 Playwright/Puppeteer：
 *   本机沙箱禁止进程间管道（named pipe），Playwright 的传输层需要管道会被拒绝；
 *   而 Chrome 自带的 DevTools 协议（CDP，HTTP + WebSocket）不需要管道，
 *   用 Node 内置的 fetch 与 WebSocket 即可完成渲染检查与截图。
 *
 * 检查内容：
 *   1. 启动本机 Chrome（headless），打开 /v2，用演示口令登录；
 *   2. 依次访问六个模块：断言关键文字存在、页面无 JS 异常、控制台无 error；
 *   3. 每个模块截图到 docs/_screenshots/v2-<module>.png；
 *   4. 输出结构化结果（供交付报告引用）。
 *
 * 用法：
 *   node scripts/v2-browser-check.mjs [baseUrl] [--keep]
 *   默认 baseUrl = http://127.0.0.1:8899
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'docs', '_screenshots');
const BASE = process.argv.find((a) => a.startsWith('http')) || 'http://127.0.0.1:8899';
const KEEP = process.argv.includes('--keep');

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const chromePath = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chromePath) {
  console.error('未找到 Chrome/Edge 可执行文件，跳过浏览器检查。');
  process.exit(3);
}

const DEBUG_PORT = 9200 + Math.floor(Math.random() * 500);
const userDataDir = mkdtempSync(join(tmpdir(), 'ccer-chrome-'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------ CDP 客户端 ------------------------------ */

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    this.debug = process.env.CCER_CDP_DEBUG === '1';
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (this.debug) console.log('[cdp<-]', JSON.stringify(msg).slice(0, 300));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve: res, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message}（${msg.error.code}）`));
        else res(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }

  send(method, params = {}, sessionId = undefined) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((res, reject) => {
      this.pending.set(id, { resolve: res, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时：${method}`));
        }
      }, 30000);
    });
  }

  drainEvents(method) {
    const out = this.events.filter((e) => e.method === method);
    this.events = this.events.filter((e) => e.method !== method);
    return out;
  }
}

async function connectWs(url) {
  const ws = new WebSocket(url);
  await new Promise((res, reject) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')), { once: true });
  });
  return ws;
}

/* ------------------------------ 主流程 ------------------------------ */

const MODULES = [
  { key: 'overview', route: '/#/', needles: ['总览', '市场走势', '项目进度', '方法学分布', '更新提醒', '数据缺口'] },
  { key: 'policies', route: '/#/policies', needles: ['政策库', '方法学库', '变更待确认', '目录完整性', '政策清单'] },
  { key: 'methodologies', route: '/#/policies?tab=methodologies', needles: ['正式发布方法学', '领域签字', '暂不支持自动测算', '编号待核实'] },
  { key: 'projects', route: '/#/projects', needles: ['公开项目库', '机构内部项目库', '导入与模板', '公示预计量'] },
  { key: 'trades', route: '/#/trades', needles: ['市场走势', '交易日历', '每日行情明细', '区间成交均价', '累计口径核对'] },
  { key: 'measure', route: '/#/measure', needles: ['放行状态', '暂不支持自动测算', '领域复核已签字', '可出数'] },
  { key: 'admin', route: '/#/admin', needles: ['系统状态', '数据源配置', '模型配置', '用户与团队', '核对与缺口'] },
];

const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--window-size=1440,950',
    'about:blank',
  ],
  { stdio: 'ignore', detached: false }
);

let exitCode = 0;
try {
  // 等待 DevTools 端口就绪
  let version = null;
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      if (r.ok) {
        version = await r.json();
        break;
      }
    } catch {
      /* 继续等待 */
    }
    await sleep(250);
  }
  if (!version) throw new Error('Chrome DevTools 端口未就绪');
  console.log(`浏览器：${version.Browser}`);

  const browserWs = await connectWs(version.webSocketDebuggerUrl);
  const browser = new Cdp(browserWs);
  void browser;

  // 直接连到 page target 自己的 WebSocket（不使用 flatten session，
  // 避免不同 Chrome 版本对 sessionId 的处理差异）
  const created = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`, { method: 'PUT' }).then((r) => r.json());
  if (!created.webSocketDebuggerUrl) throw new Error('无法创建页面 target');
  const pageWs = await connectWs(created.webSocketDebuggerUrl);
  const pageCdp = new Cdp(pageWs);
  const page = {
    send: (m, p) => pageCdp.send(m, p),
  };

  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Log.enable');
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 950, deviceScaleFactor: 1, mobile: false,
  });

  const evalJs = async (expr) => {
    const out = await page.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (out.exceptionDetails) throw new Error(out.exceptionDetails.text || 'JS 执行异常');
    return out.result?.value;
  };

  const goto = async (url) => {
    await page.send('Page.navigate', { url });
    for (let i = 0; i < 80; i += 1) {
      await sleep(150);
      const ready = await evalJs('document.readyState');
      if (ready === 'complete') break;
    }
    await sleep(900); // 等前端异步渲染
  };

  const consoleErrors = [];
  const pageErrors = [];

  // 登录
  await goto(`${BASE}/v2`);
  const hasLogin = await evalJs('!!document.getElementById("btn-login")');
  if (hasLogin) {
    await evalJs(`document.getElementById('login-user').value='user-admin';
      document.getElementById('login-pass').value='admin-demo-2026';
      document.getElementById('btn-login').click(); true`);
    await sleep(2200);
  }
  const who = await evalJs(`document.querySelector('.who-name') ? document.querySelector('.who-name').textContent : null`);
  console.log(`登录身份：${who}`);
  if (!who) throw new Error('登录后未显示用户身份，浏览器检查失败');

  mkdirSync(OUT_DIR, { recursive: true });
  const results = [];
  for (const m of MODULES) {
    await goto(`${BASE}/v2${m.route}`);
    const text = (await evalJs('document.getElementById("module-root").innerText')) || '';
    const missing = m.needles.filter((n) => !text.includes(n));
    const errors = pageCdp.drainEvents('Log.entryAdded')
      .filter((e) => e.params?.entry?.level === 'error')
      .map((e) => e.params.entry.text);
    pageCdp.drainEvents('Runtime.exceptionThrown').forEach((e) => {
      pageErrors.push(e.params?.exceptionDetails?.text || 'unknown');
    });
    consoleErrors.push(...errors.map((t) => `${m.key}: ${t}`));
    const shot = await page.send('Page.captureScreenshot', { format: 'png' });
    const file = join(OUT_DIR, `v2-${m.key}.png`);
    writeFileSync(file, Buffer.from(shot.data, 'base64'));
    const nodeCount = await evalJs('document.querySelectorAll("#module-root *").length');
    results.push({ module: m.key, text_length: text.length, nodes: nodeCount, missing, screenshot: file.replace(ROOT, '.') });
    console.log(`  [${missing.length ? '缺元素' : 'OK'}] ${m.key.padEnd(14)} 文本 ${String(text.length).padStart(5)} 字｜DOM ${String(nodeCount).padStart(4)} 节点｜${file.replace(ROOT, '.')}`);
    if (missing.length) console.log(`        缺失：${missing.join('、')}`);
  }

  console.log('');
  console.log(`控制台错误：${consoleErrors.length}${consoleErrors.length ? `（示例：${consoleErrors.slice(0, 3).join(' | ')}）` : ''}`);
  console.log(`页面异常：${pageErrors.length}${pageErrors.length ? `（示例：${pageErrors.slice(0, 3).join(' | ')}）` : ''}`);
  const failed = results.filter((r) => r.missing.length).length;
  console.log(`模块渲染：${results.length - failed}/${results.length} 通过`);
  if (failed || pageErrors.length) exitCode = 1;
} catch (e) {
  console.error(`浏览器检查失败：${e.message}`);
  exitCode = 2;
} finally {
  try {
    chrome.kill();
  } catch {
    /* ignore */
  }
  if (!KEEP) {
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  await sleep(400);
  process.exit(exitCode);
}
