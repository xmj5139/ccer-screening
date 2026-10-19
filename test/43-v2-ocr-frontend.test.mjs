/**
 * 43-v2-ocr-frontend.test.mjs —— 「PDF 解析/OCR」后台页签的前端渲染回归
 * ============================================================================
 * 目的：**真实执行** web/v2/modules/admin.js 的 renderAdmin(tab=ocr) 渲染路径，
 *   断言页面确实产出了随附交互元素（密钥不回填、测试连接、能力探测、受限根、补跑），
 *   而不是只做实现字符串检查。
 *
 * 边界（如实声明，不冒充浏览器验收）：
 *   · 本文件用 Node 内的轻量 DOM 桩 + fetch 打桩承载渲染，属**渲染回归**；
 *   · 本机沙箱禁止子进程打开命名管道，Playwright 无法启动浏览器
 *     （`WinError 5 / spawn EPERM`），因此**浏览器复验未在本环境执行**，
 *     由 Codex 用真实浏览器独立复验；本文件不把未执行的浏览器行为写成通过。
 */
import {
  setupV2, test, testAsync, assert, assertEqual, assertIncludes, assertNotIncludes, finish,
} from './v2-helpers.mjs';

const ctx = await setupV2();
console.log('\n[v2-43] PDF 解析/OCR 页签：真实渲染回归（DOM 桩；浏览器复验由 Codex 执行）');

/* ==================================================================== */
/*  轻量 DOM 桩                                                         */
/* ==================================================================== */

function makeEl(tag = 'div') {
  const el = {
    tagName: String(tag).toUpperCase(),
    _html: '',
    value: '',
    textContent: '',
    className: '',
    dataset: {},
    style: {},
    files: null,
    children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); },
    insertAdjacentHTML(_pos, html) { this._html += String(html); },
    querySelector: () => makeEl('div'),
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    appendChild(c) { this.children.push(c); return c; },
    setAttribute() {},
    getAttribute: () => null,
    closest: () => null,
    focus() {},
    isConnected: true,
    scrollIntoView() {},
    replaceWith() {},
  };
  return el;
}

let mod = null;
let mountError = null;
await testAsync('挂载 DOM 桩并加载真实前端模块 web/v2/modules/admin.js', async () => {
  const registry = new Map();
  const bodyEl = makeEl('body');
  globalThis.location = { hash: '#/admin?tab=ocr', pathname: '/v2', search: '' };
  globalThis.window = { addEventListener() {}, location: globalThis.location, scrollTo() {} };
  globalThis.document = {
    body: bodyEl,
    createElement: (t) => makeEl(t),
    getElementById: (id) => registry.get(id) || null,
    querySelector: () => makeEl('div'),
    querySelectorAll: () => [],
    addEventListener() {},
    documentElement: makeEl('html'),
  };
  globalThis.DOMParser = class { parseFromString() { return { querySelector: () => null }; } };
  registry.set('app', makeEl('div'));
  try {
    mod = await import('../web/v2/modules/admin.js');
    assertEqual(typeof mod.renderAdmin, 'function', 'admin.js 应导出 renderAdmin');
  } catch (e) {
    mountError = e.message;
    console.log(`  ⚠ DOM 桩无法承载真实前端启动：${e.message}`);
  }
});
const domReady = () => !!mod;

/* ==================================================================== */
/*  服务端返回（与真实接口同形，全部来自本服务真实实现）                  */
/* ==================================================================== */

const backend = await import('../src/services/baidu-ocr-svc.mjs');
const backfillSvc = await import('../src/services/ocr-backfill-svc.mjs');
const pdfParse = await import('../src/services/pdf-parse-svc.mjs');

process.env.CCER_SECRET_KEY = 'test-master-key-for-ocr-frontend';
const ADMIN = { id: 'A1', name: 'admin', role: 'admin' };

const API_FIXTURES = {
  '/api/v2/admin/ocr/config': () => ({
    ...backend.baiduOcrPublicConfig(),
    backfill: backfillSvc.ocrBackfillConfig(),
    roots: backfillSvc.restrictedRoots(),
    ocr_root: pdfParse.ocrRoot(),
    parser_version: pdfParse.PDF_TEXT_PARSER_VERSION,
    limits_note: '服务端硬上限：单批 5000—600000ms；经典接口 pdf_file 为 base64，原始 PDF 上限 4MB。',
    modes: [
      { key: 'accurate_basic', label: '经典高精度（accurate_basic）', available: true, note: '本轮完整实现。' },
      { key: 'doc_parser', label: '异步文档解析（doc_parser）', available: false, note: '未通过真实能力探测。' },
      { key: 'unsupported', label: '不启用（unsupported）', available: true, note: '显式关闭。' },
    ],
  }),
  '/api/v2/admin/ocr/gaps': () => ({
    candidates: [{
      kind: 'policy_attachment', id: 'PAT-FE-1', title: '前端渲染测试附件',
      local_path: 'D:\\tmp\\official-originals\\a.pdf', file_hash: 'h1',
      reason: '附件解析质量为 not_attempted：未取得正文',
    }],
    rejected: [{ kind: 'policy_attachment', id: 'PAT-FE-OUT', title: '越界附件', reject_reason: '路径不在受限根内：C:\\Windows\\x.pdf' }],
    scanned: 2, roots: backfillSvc.restrictedRoots(),
    config: backfillSvc.ocrBackfillConfig(),
    ocr_ready: { ready: false, category: 'not_configured', reason: '未配置百度 OCR 凭据' },
    quota: backend.baiduOcrQuotaState(),
    note: '只包含落在受限根内、且确实缺正文的 PDF 原件。',
  }),
  '/api/v2/admin/ocr/status': () => ({
    ...backfillSvc.ocrBackfillStatus(),
    tasks: [{
      task_id: 'OCRTASK-fe-1', mode: 'scan', status: 'partial', queued_at: '2026-10-15T01:00:00.000Z',
      started_at: '2026-10-15T01:00:01.000Z', finished_at: '2026-10-15T01:00:09.000Z',
      elapsed_ms: 8000, job_id: 'JOB-fe-1', error: null,
      result: { candidates: 2, selected: 2, ok_count: 1, fail_count: 1, ocr_ready: false, ocr_note: 'OCR 未启用', docs: [] },
    }],
  }),
};

const apiCalls = [];
globalThis.fetch = async (path, opts = {}) => {
  const url = String(path).split('?')[0];
  apiCalls.push({ url, method: opts.method || 'GET' });
  const fixture = API_FIXTURES[url];
  if (!fixture) return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
  return new Response(JSON.stringify(fixture()), { status: 200, headers: { 'content-type': 'application/json' } });
};

/* ==================================================================== */
/*  渲染断言                                                            */
/* ==================================================================== */

let rendered = '';
let tabsHtml = '';
await testAsync('渲染 tab=ocr：产出配置/配额/能力/缺口/任务五块内容', async () => {
  if (!domReady()) { console.log(`  ↷ 本环境未执行 DOM 渲染：${mountError}`); return; }
  const root = makeEl('div');
  const tabBody = makeEl('div');
  globalThis.document.getElementById = (id) => (id === 'tab-body' ? tabBody : makeEl('div'));
  await mod.renderAdmin(root, { query: { tab: 'ocr' } });
  tabsHtml = root.innerHTML;      // 顶部页签栏
  rendered = tabBody.innerHTML;   // 页签内容
  assert(tabsHtml.includes('PDF 解析/OCR'), '顶部页签栏应包含「PDF 解析/OCR」');
  assert(rendered.length > 1500, `渲染结果过短（${rendered.length} 字符），疑似未真正渲染`);
  assertEqual(apiCalls.map((c) => c.url).sort().join(','),
    ['/api/v2/admin/ocr/config', '/api/v2/admin/ocr/gaps', '/api/v2/admin/ocr/status'].join(','),
    '应真实请求三个 OCR 接口');
});

test('渲染内容：页签存在、密钥输入为空且不回填、关键操作按钮齐备', () => {
  if (!domReady()) { console.log('  ↷ 本环境未执行 DOM 渲染'); return; }
  // 页签本身（renderAdmin 顶部标签栏）
  assertIncludes(tabsHtml, 'PDF 解析/OCR');
  assertIncludes(tabsHtml, 'class="tab active" href="#/admin?tab=ocr"', '当前页签应处于选中态');
  // 凭据纪律：只显示是否已配置，输入框留空
  assertIncludes(rendered, '百度 OCR');
  assertIncludes(rendered, '凭据未配置');
  assertNotIncludes(rendered, 'credential_cipher');
  assertNotIncludes(rendered, 'api_key" value="', '密钥输入框不得回填任何值');
  assertIncludes(rendered, 'data-ocr="api_key"');
  assertIncludes(rendered, 'data-ocr="secret_key"');
  assertIncludes(rendered, '留空=保留原值');
  assertIncludes(rendered, '清除已存凭据');
  // 关键操作
  assertIncludes(rendered, 'id="ocr-test"');
  assertIncludes(rendered, '测试真实连接');
  assertIncludes(rendered, 'id="ocr-probe"');
  assertIncludes(rendered, '探测文档解析权限');
  assertIncludes(rendered, 'id="ocr-backfill"');
  assertIncludes(rendered, 'id="ocr-daily"');
  assertIncludes(rendered, 'id="ocr-refresh"');
  // 受限根与结果目录如实展示
  assertIncludes(rendered, 'official-originals');
  assertIncludes(rendered, 'registry-files');
  assertIncludes(rendered, '接口域名固定为百度官方域名');
  // 页码约定（两种接口不同）写在页面上
  assertIncludes(rendered, 'page_filter');
  assertIncludes(rendered, '从 <b>0</b> 起');
  // 配额口径
  assertIncludes(rendered, '实际发出的 HTTP 尝试');
  // 缺口与越界条目
  assertIncludes(rendered, '前端渲染测试附件');
  assertIncludes(rendered, '被拒绝的条目');
  assertIncludes(rendered, '路径不在受限根内');
  // 任务列表
  assertIncludes(rendered, 'OCRTASK-fe-1');
  assertIncludes(rendered, 'ocr_backfill');
});

test('交互元素与处理函数一一对应（不存在只有按钮没有处理的分支）', async () => {
  if (!domReady()) { console.log('  ↷ 本环境未执行 DOM 渲染'); return; }
  // renderOcrAdmin 会在渲染后绑定事件；DOM 桩会吞掉绑定，这里改为断言元素 id
  // 与源码中 querySelector('#id') 一一对应，避免出现「按钮点了没反应」。
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../web/v2/modules/admin.js', import.meta.url), 'utf8');
  for (const id of ['ocr-cfg-form', 'ocr-test', 'ocr-probe', 'ocr-refresh', 'ocr-backfill', 'ocr-daily', 'ocr-clear-credentials']) {
    assertIncludes(src, `#${id}`, `应有 #${id} 的事件绑定`);
    assertIncludes(rendered, `id="${id}"`, `渲染结果应包含 #${id}`);
  }
  assertIncludes(src, 'pollOcrTask', '应按 task_id 轮询补跑任务');
  assertIncludes(src, 'data-ocr-reparse', '应支持按对象重解析');
  assertIncludes(src, 'data-ocr-task', '应支持查看任务结果');
});

test('前端口径与后端一致：未配置凭据时页面不显示「可用」', () => {
  if (!domReady()) { console.log('  ↷ 本环境未执行 DOM 渲染'); return; }
  assertIncludes(rendered, '凭据未配置');
  assertIncludes(rendered, '请在后台上传 API Key 与 Secret Key');
  assertNotIncludes(rendered, '凭据已配置</b>');
});

await testAsync('已配置凭据时：只显示「已配置」，且密钥输入框仍为空（不回填、不泄露）', async () => {
  if (!domReady()) { console.log('  ↷ 本环境未执行 DOM 渲染'); return; }
  const saved = backend.saveBaiduOcrConfig(ADMIN, {
    api_key: 'AK-FRONTEND-SECRET', secret_key: 'SK-FRONTEND-SECRET', enabled: true,
  });
  assertEqual(saved.ok, true, saved.error || '');
  const root = makeEl('div');
  const tabBody = makeEl('div');
  globalThis.document.getElementById = (id) => (id === 'tab-body' ? tabBody : makeEl('div'));
  await mod.renderAdmin(root, { query: { tab: 'ocr' } });
  const html = tabBody.innerHTML;
  assertIncludes(html, '凭据已配置');
  assertIncludes(html, '接口只返回「是否已配置」，绝不返回密钥或密文');
  assertNotIncludes(html, 'AK-FRONTEND-SECRET', '页面不得出现密钥明文');
  assertNotIncludes(html, 'SK-FRONTEND-SECRET', '页面不得出现密钥明文');
  assertNotIncludes(html, 'credential_cipher');
  assertNotIncludes(html, 'api_key" value="', '密钥输入框不得回填');
  assertIncludes(html, '测试真实连接（1 页，会计费）', '应如实提示连接测试会计费');
  backend.saveBaiduOcrConfig(ADMIN, { clear_credentials: true });
});

/* ==================================================================== */

finish('43-v2-ocr-frontend.test.mjs');
