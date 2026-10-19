/**
 * 50-v2-accounting-frontend.test.mjs —— 「碳计算与因子」/「登记与清结算」/「碳核算资料」渲染回归
 * ============================================================================
 * 目的：**真实执行** web/v2/modules 的前端渲染路径（含挂载后写入子元素的动态内容），
 *   断言页面确实产出了随附交互元素与口径提示，而不是只做实现字符串检查。
 *
 * 边界（如实声明，不冒充浏览器验收）：
 *   · 本文件用 Node 内的轻量 DOM 桩 + fetch 打桩承载渲染，属**渲染回归**；
 *   · 打桩返回的数据由**真实后端服务模块**（accounting-svc / carbon-calc-svc /
 *     accounting-collect-svc）现场生成，不是手写静态假数据；
 *   · 本机沙箱禁止子进程打开命名管道，Playwright 无法启动浏览器
 *     （`WinError 5 / spawn EPERM`），因此**浏览器复验未在本环境执行**，
 *     由 Codex 用真实浏览器独立复验；本文件不把未执行的浏览器行为写成通过。
 */
import {
  setupV2, test, testAsync, assert, assertEqual, assertIncludes, assertNotIncludes, finish,
} from './v2-helpers.mjs';

const ctx = await setupV2();
console.log('\n[v2-50] 碳计算与因子 / 登记与清结算 / 碳核算资料：真实渲染回归（DOM 桩；浏览器复验由 Codex 执行）');

/* ==================================================================== */
/*  轻量 DOM 桩（两级：挂载根 + 按 id 缓存的子元素，可追踪挂载后写入）   */
/* ==================================================================== */

function makeEl(tag = 'div') {
  const el = {
    tagName: String(tag).toUpperCase(),
    _html: '',
    _kids: new Map(),
    value: '',
    checked: false,
    textContent: '',
    className: '',
    dataset: {},
    style: {},
    files: null,
    children: [],
    type: '',
    disabled: false,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    get innerHTML() {
      let h = this._html;
      for (const [id, kid] of this._kids) {
        const re = new RegExp(`(<[a-z]+[^>]*\\bid="${id}"[^>]*>)(</[a-z]+>)`, 'i');
        h = h.replace(re, (_m, open, close) => `${open}${kid.innerHTML}${close}`);
      }
      return h;
    },
    set innerHTML(v) {
      this._html = String(v);
      // 每次整体重设 HTML 时重建子元素索引（模拟浏览器解析出的元素）
      this._kids = new Map();
      for (const m of this._html.matchAll(/id="([^"]+)"/g)) this._kids.set(m[1], makeEl('div'));
    },
    insertAdjacentHTML(_pos, html) {
      this._html += String(html);
      for (const m of String(html).matchAll(/id="([^"]+)"/g)) {
        if (!this._kids.has(m[1])) this._kids.set(m[1], makeEl('div'));
      }
    },
    querySelector(sel) {
      if (typeof sel === 'string' && sel.startsWith('#')) return this._kids.get(sel.slice(1)) || makeEl('div');
      return makeEl('div');
    },
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    appendChild(c) { this.children.push(c); return c; },
    removeChild() {},
    remove() {},
    setAttribute() {},
    getAttribute: () => null,
    closest: () => null,
    focus() {},
    click() {},
    isConnected: true,
    scrollIntoView() {},
    replaceWith() {},
  };
  return el;
}

const registry = new Map();
let mount = null;
globalThis.location = { hash: '#/measure?tab=calc', pathname: '/v2', search: '' };
globalThis.window = { addEventListener() {}, location: globalThis.location, scrollTo() {} };
globalThis.document = {
  body: makeEl('body'),
  createElement: (t) => makeEl(t),
  getElementById: (id) => (mount && mount._kids.get(id)) || registry.get(id) || makeEl('div'),
  querySelector: () => makeEl('div'),
  querySelectorAll: () => [],
  addEventListener() {},
  documentElement: makeEl('html'),
};
globalThis.DOMParser = class { parseFromString() { return { querySelector: () => null }; } };
globalThis.URL.createObjectURL = () => 'blob:stub';
globalThis.URL.revokeObjectURL = () => {};

/* ==================================================================== */
/*  fetch 打桩：数据由真实后端服务现场生成                               */
/* ==================================================================== */

const acc = await import('../src/services/accounting-svc.mjs');
const calc = await import('../src/services/carbon-calc-svc.mjs');
const collectSvc = await import('../src/services/accounting-collect-svc.mjs');
acc.seedAccountingBase();

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body ?? {}), { status, headers: { 'content-type': 'application/json' } });
}

/* ==================================================================== */
/*  docs/43 契约 stub 数据（接口未实现时按契约形状测试，不冒充后端已完成）  */
/* ==================================================================== */

const CONTRACT_PUBLIC_DOCS = [
  {
    id: 'cets-policy-1', title: '关于做好 2026 年度全国碳排放权交易市场有关工作的通知',
    category: 'policy', doc_type: 'article', url: 'https://www.cets.org.cn/zcwjx/123.jhtml',
    published_at: '2026-03-02', body_status: 'full', model_verify_status: 'verified',
    observed_count: 1, announced_count: null,
    limitation: '只读取公开门户当前页；不登录企业账户。', captured_at: '2026-10-15T06:31:00Z', qa_count: 0,
  },
  {
    id: 'cets-standards-index', title: '标准规范（栏目）',
    category: 'standard', doc_type: 'index', url: 'https://www.cets.org.cn/bzgf/index.jhtml',
    published_at: null, body_status: 'partial', model_verify_status: 'unavailable',
    observed_count: 5, announced_count: 40,
    limitation: '栏目宣称 40 条，本平台只读取到当前页 5 条真实链接；分页不猜接口。',
    captured_at: '2026-10-15T06:31:00Z', qa_count: 0,
  },
  {
    id: 'cets-faq-general', title: '全国碳市场共性问答',
    category: 'faq', doc_type: 'faq', url: 'https://www.cets.org.cn/gxwt/index.jhtml',
    published_at: null, body_status: 'partial', model_verify_status: 'insufficient',
    observed_count: 1, announced_count: 51,
    limitation: '只读取第一页问答，不是全部 51 条。', captured_at: '2026-10-15T06:31:00Z', qa_count: 2,
  },
];

const CONTRACT_PUBLIC_DOC_DETAILS = {
  'cets-standards-index': {
    ...CONTRACT_PUBLIC_DOCS[1],
    body_text: '标准规范 政策文件 常见问题 首页 上一页 下一页',
  },
  'cets-faq-general': {
    ...CONTRACT_PUBLIC_DOCS[2],
    body_text: '问：什么企业需要报告温室气体排放？\n答：按《企业温室气体排放核算与报告指南 发电设施》执行。',
  },
};
const CONTRACT_PUBLIC_QA = {
  'cets-faq-general': [
    { ordinal: 1, question: '什么企业需要报告温室气体排放？', answer: '按《企业温室气体排放核算与报告指南 发电设施》执行。' },
    { ordinal: 2, question: '数据质量控制计划什么时候提交？', answer: '按原站答复的时间要求提交，本平台不改写。' },
  ],
};

const apiCalls = [];
globalThis.fetch = async (path, opts = {}) => {
  const u = new URL(String(path), 'http://local.invalid');
  const p = u.pathname;
  const q = Object.fromEntries(u.searchParams);
  const body = opts.body ? JSON.parse(String(opts.body)) : null;
  apiCalls.push({ url: p, method: opts.method || 'GET' });
  if (p.startsWith('/api/v2/accounting/admin/') && !globalThis.__isAdmin) {
    return jsonResponse({ error: '权限不足', message: '仅管理员可访问' }, 403);
  }

  if (p === '/api/v2/measure/quick-gas/meta') {
    return jsonResponse({
      title: '低于 8% 煤矿瓦斯简表', subtitle: '规模粗估', disclaimer: '仅为规模粗估',
      formula: 'E = Q × c × 0.716 × 28 × η', formula_origin: '方法学原文',
      source_url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk01/202512/x.pdf',
      primary_fields: [{ key: 'annual_gas_m3', label: '年混合气量', required: true, unit: 'm³/年' }],
      advanced_fields: [],
      caveat: '不是可签发量',
    });
  }
  if (p === '/api/v2/accounting/status') {
    // public_documents / public_qa / standards_full 三项计数按 docs/43 契约新增（后端由 Codex 并行实现）
    const base = acc.accountingStatus();
    return jsonResponse({
      ...base,
      counts: { ...base.counts, public_documents: 3, public_qa: 2, standards_full: base.counts.standards_with_body || 0 },
      collect: collectSvc.accountingCollectStatus(),
    });
  }
  /* docs/43 契约 stub：公开资料接口由 Codex 并行实现，本轮按契约形状打桩，不代表后端已实现 */
  if (p === '/api/v2/accounting/public-documents') {
    const rows = CONTRACT_PUBLIC_DOCS.filter((d) => (!q.category || d.category === q.category)
      && (!q.doc_type || d.doc_type === q.doc_type)
      && (!q.q || String(d.title).includes(q.q)));
    const limit = Number(q.limit) || 100;
    const offset = Number(q.offset) || 0;
    return jsonResponse({ total: rows.length, rows: rows.slice(offset, offset + limit), limit, offset });
  }
  if (/^\/api\/v2\/accounting\/public-documents\/[^/]+$/.test(p)) {
    const id = decodeURIComponent(p.split('/').pop());
    const doc = CONTRACT_PUBLIC_DOCS.find((d) => d.id === id);
    if (!doc) return jsonResponse({ error: '未找到该公开资料' }, 404);
    return jsonResponse({ document: CONTRACT_PUBLIC_DOC_DETAILS[id] || doc, qa: CONTRACT_PUBLIC_QA[id] || [] });
  }
  if (p === '/api/v2/accounting/sources') {
    return jsonResponse({
      sources: acc.listSources({ category: q.category || null, status: q.status || null, q: q.q || null, limit: Number(q.limit) || 200 }),
      note: '来源登记只描述公开入口与允许抓取的域名；状态/最近成功时间/HTTP 状态只有在**真实抓取过**之后才有值。',
    });
  }
  if (p === '/api/v2/accounting/factors') {
    return jsonResponse({
      ...acc.listFactors({
        data_year: q.data_year || null, category: q.category || null, region: q.region || null,
        q: q.q || null, limit: Number(q.limit) || 200, offset: Number(q.offset) || 0,
      }),
      facets: acc.factorFacets(),
      category_labels: acc.FACTOR_CATEGORY_LABELS,
      notes: ['本库电力 CO2 因子用于外购电力排放参考计算；不是产品全生命周期碳足迹因子，也不是 CCER 区域电网基准线因子。'],
    });
  }
  if (/^\/api\/v2\/accounting\/factors\/[^/]+$/.test(p)) {
    const factor = acc.getFactor(decodeURIComponent(p.split('/').pop()));
    return factor ? jsonResponse({ factor }) : jsonResponse({ error: '未找到该因子' }, 404);
  }
  if (p === '/api/v2/accounting/standards') {
    return jsonResponse({
      ...acc.listStandards({
        sector: q.sector || null, status: q.status || null,
        standard_type: q.standard_type || null, q: q.q || null, limit: Number(q.limit) || 200,
      }),
      facets: acc.standardFacets(),
      notes: ['「现行正式」只用于生态环境部正式印发/发布的规范；征求意见稿一律单独标注，绝不当作正式版。'],
    });
  }
  if (/^\/api\/v2\/accounting\/standards\/[^/]+$/.test(p)) {
    const standard = acc.getStandard(decodeURIComponent(p.split('/').pop()));
    return standard ? jsonResponse({ standard }) : jsonResponse({ error: '未找到该标准' }, 404);
  }
  if (p === '/api/v2/accounting/crc-daily') {
    return jsonResponse(acc.crcDailyWithCeaCompare({ from: q.from || null, to: q.to || null, limit: Number(q.limit) || 30 }));
  }
  if (p === '/api/v2/accounting/calculate/electricity') {
    try { return jsonResponse(calc.calculateElectricity(body || {})); } catch (e) { return jsonResponse({ error: e.message, detail: e.detail || null }, 400); }
  }
  if (p === '/api/v2/accounting/calculate/fuel') {
    try { return jsonResponse(calc.calculateFuelCombustion(body || {})); } catch (e) { return jsonResponse({ error: e.message, detail: e.detail || null }, 400); }
  }
  if (p === '/api/v2/accounting/calculate/summary') {
    try { return jsonResponse(calc.summarizeEmissions((body || {}).items || [])); } catch (e) { return jsonResponse({ error: e.message, detail: e.detail || null }, 400); }
  }
  if (p === '/api/v2/accounting/admin/config') {
    return jsonResponse({
      config: acc.accountingConfig(), defaults: acc.ACCOUNTING_DEFAULT_CONFIG,
      status: acc.accountingStatus(), collect: collectSvc.accountingCollectStatus(),
      limits_note: '服务端硬约束：单批预算 5000—120000ms（需求：单批 ≤120 秒）｜单并发｜重入合并。',
    });
  }
  if (p === '/api/v2/accounting/admin/jobs') {
    return jsonResponse({ status: collectSvc.accountingCollectStatus(), task: null, task_id: null });
  }
  if (p.startsWith('/api/v2/cea/')) return jsonResponse({ rows: [], total: 0, series: [], summary: null });
  return jsonResponse({ error: `未打桩的接口：${p}` }, 404);
};

const measureMod = await import('../web/v2/modules/measure.js');
const accountingMod = await import('../web/v2/modules/accounting.js');
const adminMod = await import('../web/v2/modules/admin.js');
const ceaMod = await import('../web/v2/modules/cea.js');
const appMod = await import('../web/v2/app.js');

/** 渲染一个页签，返回 { tabs, body, root }；body 支持追踪子元素写入 */
async function render(mod, tab, query = {}, opts = {}) {
  apiCalls.length = 0;
  const root = makeEl('div');
  const body = makeEl('div');
  mount = body;
  registry.set('tab-body', body);
  registry.set('cea-body', body);
  globalThis.__isAdmin = opts.admin === true;
  globalThis.location.hash = mod === ceaMod ? `#/cea?tab=${tab}` : mod === adminMod ? `#/admin?tab=${tab}` : `#/measure?tab=${tab}`;
  if (mod === adminMod) await mod.renderAdmin(root, { query: { tab, ...query } });
  else if (mod === ceaMod) await mod.renderCea(root, { query: { tab, ...query } });
  else await mod.renderMeasure(root, { query: { tab, ...query } });
  return { tabs: root.innerHTML, body, html: body.innerHTML };
}

/* ==================================================================== */
/*  一、主导航与页签                                                     */
/* ==================================================================== */

test('主导航 measure 已改名为「碳计算与因子」，路由仍是 #/measure，仍是八个主模块', () => {
  const m = appMod.MODULES.find((x) => x.key === 'measure');
  assert(m, 'measure 模块必须存在');
  assertEqual(m.label, '碳计算与因子');
  assertIncludes(m.desc, '碳排放计算');
  assertIncludes(m.desc, '排放因子库');
  assertIncludes(m.desc, '标准规范');
  assertEqual(appMod.MODULES.length, 8, '主模块数量保持 8 个');
  assert(!appMod.MODULES.some((x) => x.key === 'accounting'), '不新增一级模块，碳核算作为 measure 的二级页签');
});

await testAsync('measure 页签外壳：6 个二级页签（含「政策与问答」），默认落在「减排粗估」', async () => {
  const r = await render(measureMod, 'gas');
  for (const label of ['减排粗估', '碳排放计算', '因子库', '标准规范', '政策与问答', '资料来源']) {
    assertIncludes(r.tabs, label, `应有页签「${label}」`);
  }
  assertIncludes(r.tabs, 'class="tab active" href="#/measure?tab=gas"', '默认页签应是减排粗估');
  assertIncludes(r.tabs, 'href="#/measure?tab=public"', '第六个页签应是「政策与问答」');
  assertIncludes(r.html, '低于 8% 煤矿瓦斯简表', '默认页签保留原低浓度瓦斯粗估');
  assertIncludes(r.html, 'id="quick-form"');
});

/* ==================================================================== */
/*  二、碳排放计算                                                       */
/* ==================================================================== */

let calcBody = null;

await testAsync('渲染 tab=calc：真实请求因子清单并产出计算表单', async () => {
  const r = await render(measureMod, 'calc');
  calcBody = r.body;
  assert(r.html.length > 2000, `渲染结果过短（${r.html.length} 字符），疑似未真正渲染`);
  const urls = apiCalls.map((c) => c.url);
  assert(urls.includes('/api/v2/accounting/factors'), '挂载时应真实请求因子清单');
  assertNotIncludes(urls.join(','), '未打桩', '不应出现未打桩的接口（说明渲染路径完整）');
});

test('计算页：单位、表单 id、参考年份确认齐备', () => {
  const html = calcBody.innerHTML;
  for (const unit of ['kWh', 'MWh', '万kWh']) assertIncludes(html, unit);
  for (const unit of ['GJ/t', '万Nm³', 'GJ/万Nm³']) assertIncludes(html, unit);
  assertIncludes(html, 'tC/TJ');
  assertIncludes(html, '碳氧化率');
  assertIncludes(html, 'id="calc-elec-form"');
  assertIncludes(html, 'id="calc-fuel-form"');
  assertIncludes(html, 'id="calc-summary-run"');
  assertIncludes(html, 'id="calc-accept-ref"', '必须有「接受使用参考年份因子」的显式勾选');
  assertIncludes(html, '系统不会自动带此标记重试');
  assertIncludes(html, '平台不保存');
  assertIncludes(html, '本结果');
  assertIncludes(html, 'CCER 预计签发量');
  assertIncludes(html, '不折算 GWP');
});

await testAsync('计算页：口径文案面向业务（不出现字段名与 null 之类的实现细节）', async () => {
  const html = calcBody.innerHTML;
  assertIncludes(html, '不折算 GWP', '气体口径必须写明不折算 GWP');
  assertNotIncludes(html, 'total_tco2e', '业务页不得展示接口字段名 total_tco2e');
  assertNotIncludes(html, '恒为 null', '业务页不得用 null 描述业务事实');
  assertIncludes(html, '不出 CO₂e 数值', '应改用业务文案说明不产出 CO₂e');
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../web/v2/modules/accounting.js', import.meta.url), 'utf8');
  assertNotIncludes(src, '恒为 null', '源码中不应再保留「恒为 null」这类实现细节文案');
});

await testAsync('计算页：目标年度必填 1900—2100，燃料含碳量单位固定 tC/TJ（提交时显式带上）', async () => {
  const html = calcBody.innerHTML;
  // 目标年度：必填 + 取值区间 + 不提供隐式默认
  assertIncludes(html, '目标年度 <b class="req">必填</b>', '目标年度必须标为必填');
  assertIncludes(html, 'min="1900" max="2100"', '目标年度取值区间必须是 1900—2100');
  assertIncludes(html, '不提供默认年度', '不得提供隐式默认年度');
  // 燃料含碳量单位：界面固定标注并随提交带上，服务端拒绝其他单位
  assertIncludes(html, '单位固定为 <b>tC/TJ</b>');
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../web/v2/modules/accounting.js', import.meta.url), 'utf8');
  assertIncludes(src, "carbon_content_unit: 'tC/TJ'", '燃料计算提交必须显式带 carbon_content_unit');
  assertIncludes(src, '目标年度必须是 1900—2100 之间的整数年度', '缺年份/越界必须在前端先拦下');
});

test('计算页：因子下拉由真实接口填充，只含 calculable=true（40 行），不回落全国平均', () => {
  const html = calcBody.innerHTML;
  // 因子清单可能内联在首次模板中，也可能在挂载后写入子元素——两处都接受，但必须非空
  const inline = (/<select[^>]*id="calc-factor-select"[^>]*>([\s\S]*?)<\/select>/.exec(html) || [])[1] || '';
  const child = calcBody._kids.get('calc-factor-select')?.innerHTML || '';
  const options = inline.length >= child.length ? inline : child;
  assert(options.length > 500, `因子下拉应有内容，实际 ${options.length} 字符`);
  assertEqual((options.match(/<option/g) || []).length, 40, '下拉应恰好列出 40 个可计算因子');
  for (const v of ['0.5306', '0.6096', '0.8273']) assertIncludes(options, v, `应列出因子值 ${v}`);
  assertIncludes(options, '不包括市场化交易的非化石能源电量');
  assertIncludes(options, '化石能源电力');
  // 因子说明块：要么已选中第一个因子（显示口径/页码/核验状态），要么明确"没有可计算因子、不会回落"
  const inlineBrief = (/<div[^>]*id="calc-factor-brief"[^>]*>([\s\S]*?)<\/div>\s*<div[^>]*id="calc-elec-out"/.exec(html) || [])[1] || '';
  const brief = `${inlineBrief}${calcBody._kids.get('calc-factor-brief')?.innerHTML || ''}`;
  const briefText = brief.length ? brief : html;
  assert(
    briefText.includes('已选因子') || briefText.includes('当前筛选下没有可计算因子'),
    '因子说明块必须给出「已选因子」或明确说明没有可计算因子'
  );
  assertIncludes(html, '不会');
  assertIncludes(html, '全国平均值');
});

await testAsync('计算页：静态源码中的口径纪律（三口径不得互换、CO2 不标 CO2e、单位不做隐式换算）', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../web/v2/modules/accounting.js', import.meta.url), 'utf8');
  assertIncludes(src, 'f.calculable === true', '下拉必须只取 calculable=true');
  assertIncludes(src, '不会自动改用其他地区或全国平均值');
  assertIncludes(src, '单位不匹配时服务端直接 400');
  assertIncludes(src, '不折算 GWP', 'CO₂ 结果不得标成 CO₂e（业务文案：不折算 GWP）');
  assertIncludes(src, 'downloadCalcResult', '应有结果 JSON 下载实现');
  assertIncludes(src, '下载本次结果 JSON');
  assertIncludes(src, 'accept_reference_year');
});

await testAsync('计算错误路径：因子缺失的 400 detail.available 被解释为"不会自动回落"', async () => {
  const res = await fetch('/api/v2/accounting/calculate/electricity', {
    method: 'POST', body: JSON.stringify({ energy: 1, energy_unit: 'kWh', factor_id: 'NO-SUCH' }),
  });
  assertEqual(res.status, 400);
  const payload = await res.json();
  assertIncludes(payload.error, '未找到匹配的电力因子');
  assert(Array.isArray(payload.detail.available));
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../web/v2/modules/accounting.js', import.meta.url), 'utf8');
  assertIncludes(src, '系统不会自动改用其他地区或全国平均值');
});

/* ==================================================================== */
/*  三、因子库                                                           */
/* ==================================================================== */

let factorHtml = '';

await testAsync('渲染 tab=factors：真实请求 40 行因子并产出筛选与导出', async () => {
  const r = await render(measureMod, 'factors', { data_year: '2023' });
  factorHtml = r.html;
  assertIncludes(apiCalls.map((c) => c.url).join(','), '/api/v2/accounting/factors');
});

test('因子库：显示数值/单位/口径/地区/数据年/原文定位/可计算性与导出（含 JSON）', () => {
  for (const needle of [
    '0.5306', '0.6096', '0.8273', 'kgCO2/kWh', '全国电力平均二氧化碳排放因子',
    '物理页', '2023', '可计算', 'accounting/export/factors', '下载 JSON',
    '不是 CCER 区域电网基准线因子', '不包括市场化交易的非化石能源电量',
  ]) {
    assertIncludes(factorHtml, needle, `因子库应包含「${needle}」`);
  }
});

test('因子库：来源链接只放行 http/https（不生成 javascript:/data: 链接，HTML 被转义）', () => {
  assertEqual(accountingMod.safeHttpHref('https://www.mee.gov.cn/a.pdf'), 'https://www.mee.gov.cn/a.pdf');
  assertEqual(accountingMod.safeHttpHref('javascript:alert(1)'), null);
  assertEqual(accountingMod.safeHttpHref('data:text/html,x'), null);
  assertEqual(accountingMod.safeHttpHref('file:///C:/x.pdf'), null);
  const html = accountingMod.renderAccountingSourceTable([{
    code: 'evil', name: '<img src=x onerror=alert(1)>', url: 'javascript:alert(1)',
    category: 'crc', source_type: 'portal', status: 'registered', collected_count: 0,
  }]);
  assertNotIncludes(html, 'href="javascript:', 'javascript: 不得出现在 href 中');
  assertNotIncludes(html, '<img src=x', 'HTML 必须被转义，不得直接注入');
  assertIncludes(html, '&lt;img', '应显示转义后的文本');
  assertIncludes(html, '未抓取（仅登记）', '没有真实抓取成功时间时必须如实标注');
});

test('来源表：类别与入口类型中文化，运行明细（HTTP 码/抓取方式）收进技术细节', () => {
  const html = accountingMod.renderAccountingSourceTable([{
    code: 'chinacrc_daily_list', name: '中碳登·信息日报（列表）', url: 'https://www.chinacrc.net.cn/list/18.html',
    category: 'crc', source_type: 'list', status: 'ok', collected_count: 3,
    last_http_status: 200, fetch_kind: 'direct_html', last_success_at: '2026-10-15T06:31:00Z',
  }]);
  assertIncludes(html, '中碳登（注册登记结算）', '来源类别必须中文化');
  assertIncludes(html, '列表/栏目页', '入口类型必须中文化');
  const techIdx = html.indexOf('tech-details');
  assert(techIdx > 0, '运行明细应折叠留痕');
  assertIncludes(html, '运行明细');
  assertNotIncludes(html.slice(0, techIdx), 'direct_html', '抓取实现细节不得出现在业务列');
  assertIncludes(html.slice(techIdx), 'direct_html', '抓取方式只在技术细节中留痕');
});

await testAsync('因子库：资料表由容器自己横向滚动（合理 min-width，不把列挤成竖字）', async () => {
  assertIncludes(factorHtml, 'acc-table-factors', '因子表应有独立滚动容器类');
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../web/v2/styles.css', import.meta.url), 'utf8');
  assertIncludes(css, '.acc-table-factors table.grid { min-width: 1080px; }', '因子表必须有合理 min-width');
  assertIncludes(css, '.acc-table .table-wrap { -webkit-overflow-scrolling: touch; }', '表格容器自己横向滚动');
  assertIncludes(css, '.filters .fld select, .filters .fld input, .filters .fld textarea {', '筛选栏内控件必须可收缩');
  assertIncludes(css, 'min-width: 0; max-width: 100%;', '筛选栏/表单容器 min-width:0，页面整体不溢出');
});

/* ==================================================================== */
/*  四、标准规范                                                         */
/* ==================================================================== */

let stdHtml = '';

await testAsync('渲染 tab=standards：真实请求 10 项规范并标出"仅元数据"', async () => {
  const r = await render(measureMod, 'standards');
  stdHtml = r.html;
  assertIncludes(apiCalls.map((c) => c.url).join(','), '/api/v2/accounting/standards');
});

test('标准规范：编号/行业/类型/状态/版本/正文状态与原文链接齐备', () => {
  for (const needle of [
    'CETS-AG-01.01-V04-2026', 'CETS-VG-03.01-V01-2024', '现行正式',
    '核算与报告指南', '核查技术指南', '技术要求更新说明',
    '仅元数据（未取得正文）', 'www.mee.gov.cn', '征求意见稿', 'accounting/export/standards',
  ]) {
    assertIncludes(stdHtml, needle, `标准库应包含「${needle}」`);
  }
});

await testAsync('标准详情：未取得正文时明确说明，不编造条款', async () => {
  const std = acc.listStandards({ sector: '钢铁' }).rows.find((r) => r.code === 'CETS-AG-03.01-V01-2024');
  const detail = await fetch(`/api/v2/accounting/standards/${encodeURIComponent(std.id)}`);
  const payload = await detail.json();
  assertEqual(payload.standard.body_status, 'metadata_only');
  assertEqual(payload.standard.body_text, null);
  assertIncludes(payload.standard.body_status_label, '未取得正文');
});

test('标准详情：新增来源体系/发布状态/实施日期/全文可得性/页覆盖/正文来源字段', () => {
  const html = accountingMod.renderStandardDetailHtml({
    id: 'std-1', code: 'CETS-AG-01.01-V04-2026', title: '企业温室气体排放核算与报告指南 发电设施',
    sector: '发电', standard_type: 'guide', status: 'formal', status_label: '现行正式',
    source_kind: 'cets_guide', published_status: 'published', effective_date: '2026-01-01',
    full_text_available: true, body_status: 'full', body_text: '第一条 ……',
    pages_read: 51, pages_total: 51, extraction_complete: true, body_origin: 'official_original',
    original_url: 'https://www.mee.gov.cn/a.pdf', model_verify_status: 'verified',
  });
  for (const needle of ['全国碳市场履约行业指南', '已发布', '实施日期', '已解析 51 页', '已覆盖全部页', '官方原件（自动采集）']) {
    assertIncludes(html, needle, `标准详情应包含「${needle}」`);
  }
  assertIncludes(html, '本库已取得全文', '页覆盖完整且来源为官方原件时才可显示已取得全文');
});

test('标准详情：国家标准只给官方链接，绝不显示「全文已取得」，也不是履约指南的替代', () => {
  const html = accountingMod.renderStandardDetailHtml({
    id: 'gb-1', code: 'GB/T 32150-2025', title: '工业企业温室气体排放核算和报告通则',
    source_kind: 'national_standard', published_status: 'published', effective_date: '2026-07-01',
    full_text_available: false, body_status: 'metadata_only', body_text: null,
    original_url: 'https://openstd.samr.gov.cn/bzgk/std/newGbInfo?hcno=6E4997D6B3118055931BC13C71B9A452',
    model_verify_status: 'unavailable',
  });
  assertIncludes(html, '国家标准（GB/T）');
  assertIncludes(html, '国家标准仅提供官方链接，不在本库展示全文');
  assertIncludes(html, '国家标准与履约行业指南不是同一体系');
  assertIncludes(html, '履约行业指南的替代文件');
  assertNotIncludes(html, '（不应展示）', '国标正文不得出现在详情中（含技术细节）');
  assertIncludes(html, 'openstd.samr.gov.cn', '官方查询链接必须可点');
  assertNotIncludes(html, '本库已取得全文', '国标元数据不得显示为已取得全文');
});

test('标准详情：即使接口误标全文状态，国标来源也不得显示「已取得全文」', () => {
  const html = accountingMod.renderStandardDetailHtml({
    id: 'gb-2', code: 'GB/T 24067-2024', title: '温室气体 产品碳足迹 量化要求和指南',
    source_kind: 'national_standard', full_text_available: false,
    body_status: 'full', body_text: '（不应展示）', pages_read: 40, pages_total: 40,
    extraction_complete: true, body_origin: 'admin_upload',
  });
  assertNotIncludes(html, '本库已取得全文', '国标不得显示已取得全文');
  assertNotIncludes(html, '（不应展示）', '国标正文不得展示');
  assertIncludes(html, '国家标准仅提供官方链接');
});

/* ==================================================================== */
/*  五、资料来源                                                         */
/* ==================================================================== */

let srcHtml = '';

await testAsync('渲染 tab=sources：真实请求状态/来源/清结算三组数据', async () => {
  const r = await render(measureMod, 'sources');
  srcHtml = r.html;
  const urls = apiCalls.map((c) => c.url).join(',');
  assertIncludes(urls, '/api/v2/accounting/status');
  assertIncludes(urls, '/api/v2/accounting/sources');
  assertIncludes(urls, '/api/v2/accounting/crc-daily');
  assert(r.html.length > 3000, `渲染结果过短（${r.html.length}）`);
});

test('资料来源：412 缺口与"公告 576 个因子不是已导入数"如实展示', () => {
  for (const needle of ['HTTP 412', '不破解校验', '576', '不是本应用已导入条数', '尚未取得正文', '未抓取（仅登记）']) {
    assertIncludes(srcHtml, needle, `资料来源应包含「${needle}」`);
  }
});

test('资料来源：中碳登日报与同日 CEA 对照分列，明确「仅对照、不重复合计」', () => {
  for (const needle of ['2,861,440', '90.27', '仅对照、不重复合计', '不做相加', '同日无 CEA 行情', '修订']) {
    assertIncludes(srcHtml, needle, `资料来源应包含「${needle}」`);
  }
  assertNotIncludes(srcHtml, 'combined_total', '业务页不得出现接口字段名 combined_total');
  assertNotIncludes(srcHtml, 'accounting_source', '业务页不得出现数据表名');
});

/* ==================================================================== */
/*  五之二、政策与问答（docs/43 第六页签，接口按契约 stub）              */
/* ==================================================================== */

let publicHtml = '';

await testAsync('渲染 tab=public：请求公开资料接口并按分类/页面类型/关键词筛选', async () => {
  const r = await render(measureMod, 'public');
  publicHtml = r.html;
  const urls = apiCalls.map((c) => c.url).join(',');
  assertIncludes(urls, '/api/v2/accounting/public-documents');
  assertNotIncludes(urls, '未打桩', '不应出现未打桩的接口');
  assertIncludes(r.html, '政策与问答', '页面标题应说明是「政策与问答」');
});

test('政策与问答：分类/页面类型用中文标签，不向用户暴露原始字段名', () => {
  for (const needle of ['政策', '标准', '问答', '文章正文', '栏目页（导航，不是全文）']) {
    assertIncludes(publicHtml, needle, `政策与问答页应包含「${needle}」`);
  }
  for (const raw of ['doc_type', 'category', 'body_status', 'model_verify_status', 'observed_count', 'announced_count', 'qa_count', 'limitation']) {
    const visible = publicHtml.replace(/<[^>]*>/g, ' ');
    assertNotIncludes(visible, raw, `不得把原始字段名 ${raw} 显示给用户`);
  }
});

test('政策与问答：未标发布日期显示「原站未标注」，宣称条数不等于本平台已入库', () => {
  assertIncludes(publicHtml, '原站未标注', '没有发布日期时必须如实标注');
  assertIncludes(publicHtml, '原站栏目宣称 40 条（不是本平台已入库数量）');
  assertIncludes(publicHtml, '本平台实际读取 5 条');
  assert(publicHtml.includes('不用采集时间顶替') || publicHtml.includes('采集时间不作为发布日期'),
    '必须写明采集时间不是发布日期');
});

test('政策与问答：列表是卡片，问答逐条在详情中显示（含旧版指南与核验口径提示）', () => {
  assertIncludes(publicHtml, 'public-card', '列表应使用卡片布局');
  assertIncludes(publicHtml, 'public-grid');
  const detail = accountingMod.renderPublicDocumentDetail(
    { ...CONTRACT_PUBLIC_DOCS[2], body_text: '问：…？\n答：按《企业温室气体排放核算与报告指南 发电设施》执行。' },
    CONTRACT_PUBLIC_QA['cets-faq-general']
  );
  assertIncludes(detail, 'qa-item', '问答必须逐条显示');
  assertIncludes(detail, '问 1');
  assertIncludes(detail, '问 2');
  assertIncludes(detail, '什么企业需要报告温室气体排放？');
  assertIncludes(detail, '旧版指南', '必须提示答复可能沿用旧版指南名称');
  assertIncludes(detail, '全部答复已按最新规范更新', '核验只表示与原文一致，不代表答复已更新');
  assertIncludes(detail, '原站问答，发布日期未标注');
});

test('政策与问答：后端真实正文状态码（含 index_only）一律中文化，不显示原始取值', () => {
  for (const [raw, label] of [['index_only', '仅栏目条目（未取正文）'], ['list_only', '仅列表信息（未取正文）'], ['metadata_only', '仅条目信息（未取得正文）']]) {
    const detail = accountingMod.renderPublicDocumentDetail(
      { id: 'x', title: 't', category: 'standard', doc_type: raw === 'index_only' ? 'index' : 'article', body_status: raw, body_text: null },
      []
    );
    // 业务区（技术细节折叠之前）只出现中文化文案；原始取值只保留在折叠的接口留痕里
    const techIdx = detail.indexOf('tech-details');
    const visible = detail.slice(0, techIdx > 0 ? techIdx : detail.length);
    assertIncludes(visible, label, `正文状态 ${raw} 必须显示为「${label}」`);
    assertNotIncludes(visible, `>${raw}<`, `业务区不得把原始状态码 ${raw} 直接显示`);
  }
});

test('政策与问答：栏目/导航页明确标明不是全文，不把菜单当正文', () => {
  const detail = accountingMod.renderPublicDocumentDetail(
    { ...CONTRACT_PUBLIC_DOCS[1], body_text: '标准规范 政策文件 常见问题 首页 上一页 下一页' },
    []
  );
  assertIncludes(detail, '这是栏目 / 导航页，不是全文');
  assertIncludes(detail, '不作为文章正文');
  assertIncludes(detail, '栏目页文本（导航内容，不作为全文）');
  assertNotIncludes(detail, '本库已取得全文');
});

test('政策与问答：问答文本被转义，不注入 HTML', () => {
  const detail = accountingMod.renderPublicDocumentDetail(
    { id: 'x', title: '<b>x</b>', category: 'faq', doc_type: 'faq', body_status: 'full', body_text: 'a' },
    [{ ordinal: 1, question: '<img src=x onerror=alert(1)>', answer: '<script>alert(1)</script>' }]
  );
  assertNotIncludes(detail, '<img src=x');
  assertNotIncludes(detail, '<script>');
  assertIncludes(detail, '&lt;img');
});

test('资料来源：隐私与凭据纪律（页面不出现任何凭据字段）', () => {
  for (const bad of ['credential_cipher', 'api_key', 'secret_key', 'access_token', 'password_hash']) {
    for (const [name, html] of [['sources', srcHtml], ['factors', factorHtml], ['standards', stdHtml], ['calc', calcBody.innerHTML]]) {
      assertNotIncludes(html, bad, `${name} 页不得出现 ${bad}`);
    }
  }
});

/* ==================================================================== */
/*  六、CEA「登记与清结算」                                              */
/* ==================================================================== */

await testAsync('CEA 页签新增「登记与清结算」，渲染时不与行情相加', async () => {
  const r = await render(ceaMod, 'clearing');
  assertIncludes(r.tabs, '登记与清结算');
  assertIncludes(r.tabs, 'class="tab active" href="#/cea?tab=clearing"');
  assertIncludes(apiCalls.map((c) => c.url).join(','), '/api/v2/accounting/crc-daily');
  assert(r.html.length > 800, `清结算页渲染过短（${r.html.length}）`);
  for (const needle of ['2,861,440', '90.27', '不做相加', '自愿注销']) {
    assertIncludes(r.html, needle, `清结算页应包含「${needle}」`);
  }
});

/* ==================================================================== */
/*  七、后台「碳核算资料」                                               */
/* ==================================================================== */

let adminHtml = '';

await testAsync('后台新增「碳核算资料」页签，管理员渲染出配置/采集/核验/上传四块', async () => {
  const r = await render(adminMod, 'accounting', {}, { admin: true });
  adminHtml = r.html;
  assertIncludes(r.tabs, '碳核算资料');
  assertIncludes(r.tabs, 'class="tab active" href="#/admin?tab=accounting"');
  assert(r.html.length > 1500, `后台渲染过短（${r.html.length}）`);
  for (const id of ['acc-cfg-form', 'acc-target', 'acc-collect-btn', 'acc-verify-id', 'acc-verify-btn',
    'acc-upload-id', 'acc-upload-path', 'acc-upload-btn', 'acc-collect-out', 'acc-cfg-msg']) {
    assertIncludes(r.html, `id="${id}"`, `应渲染 #${id}`);
  }
  assertIncludes(apiCalls.map((c) => c.url).join(','), '/api/v2/accounting/admin/config');
});

test('后台页：配置表单回填真实配置值，并写明 120 秒上限', () => {
  const cfg = acc.accountingConfig();
  assertIncludes(adminHtml, String(cfg.batch_budget_ms), '应回填当前单批预算');
  assertIncludes(adminHtml, '120000');
  assertIncludes(adminHtml, '单批');
  assertIncludes(adminHtml, '120');
});

await testAsync('后台页：交互元素与源码事件绑定一一对应（不存在只有按钮没有处理的元素）', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../web/v2/modules/admin.js', import.meta.url), 'utf8');
  for (const id of ['acc-cfg-form', 'acc-collect-btn', 'acc-verify-btn', 'acc-upload-btn', 'acc-upload-path-btn', 'acc-refresh', 'acc-target']) {
    assertIncludes(src, `#${id}`, `应有 #${id} 的事件绑定或查询`);
  }
  assertIncludes(src, 'startAccountingPoll', '应实现 task_id 轮询');
  assertIncludes(src, 'stopAccountingPoll', '轮询必须可停止（不在无任务时长时间空转）');
  assertIncludes(src, 'acc-task-live', '应有实时进度展示区');
});

await testAsync('后台页：采集目标新增 cets_public（政策与问答），沿用 202 + 轮询', async () => {
  assertIncludes(adminHtml, 'cets_public', '采集目标必须包含 cets_public');
  assertIncludes(adminHtml, '全国碳市场信息网·政策与问答');
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../web/v2/modules/admin.js', import.meta.url), 'utf8');
  assertIncludes(src, '栏目导航不当正文', '目标说明必须写明栏目导航不当正文');
  assertIncludes(src, '宣称条数不当作已入库数');
});

await testAsync('后台页：PDF 绑定是真实文件选择（accept=application/pdf，≤20 MiB，base64 提交）', async () => {
  assertIncludes(adminHtml, 'type="file"', '必须有真实 file input');
  assertIncludes(adminHtml, 'id="acc-upload-file"');
  assertIncludes(adminHtml, 'accept="application/pdf"');
  assertIncludes(adminHtml, '20 MiB');
  assertIncludes(adminHtml, 'base64');
  assertIncludes(adminHtml, '管理员补充文件');
  assertIncludes(adminHtml, '不会</b>写成已验证官方原件');
  // 受限路径方式保留，但收进折叠的高级设置里（默认用户只见文件选择）
  assertIncludes(adminHtml, 'id="acc-upload-path"', '受限路径方式应保留');
  assertIncludes(adminHtml, '高级设置：按服务器受限目录解析（默认无需使用）');
  const pathIdx = adminHtml.indexOf('id="acc-upload-path"');
  const fileIdx = adminHtml.indexOf('id="acc-upload-file"');
  assert(fileIdx > 0 && pathIdx > fileIdx, '文件选择在前，受限路径收进高级设置');
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../web/v2/modules/admin.js', import.meta.url), 'utf8');
  assertIncludes(src, 'file_base64', '必须按契约提交 file_base64');
  assertIncludes(src, 'file_name', '必须按契约提交 file_name');
  assertIncludes(src, 'matches_original', '必须按契约读取 matches_original（哈希不一致 → 管理员补充文件）');
  assertIncludes(src, '20 * 1024 * 1024', '前端必须校验 20 MiB 上限');
  assertIncludes(src, 'readFileAsBase64');
});

test('后台页：服务器目录路径等实现细节收进技术细节折叠区', () => {
  assertIncludes(adminHtml, '技术细节（运行留痕）');
  assertIncludes(adminHtml, '原件存放位置（受限）');
  assertNotIncludes(adminHtml, 'schema_version', '页面不得直接显示内部字段名');
});

await testAsync('后台页源码：202 受理口径与空扫描/0 行解析的区别写在页面上', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../web/v2/modules/admin.js', import.meta.url), 'utf8');
  for (const needle of ['202', '只表示已受理', '空扫描', '解析 0 行', '受限根', 'unavailable']) {
    assertIncludes(src, needle, `后台页应说明「${needle}」`);
  }
});

await testAsync('后台接口对普通用户仍返回 403（页面不隐藏也调不通）', async () => {
  const r = await render(adminMod, 'accounting', {}, { admin: false });
  assertIncludes(r.html, '权限不足');
  assertNotIncludes(r.html, 'id="acc-cfg-form"');
});

/* ==================================================================== */
/*  八、总览「碳核算公开资料」卡（简洁，只显示平台实际入库数量）          */
/* ==================================================================== */

await testAsync('总览：新增碳核算公开资料卡，展示真实入库的因子/规范正文/问答数量与链接', async () => {
  const overviewMod = await import('../web/v2/modules/overview.js');
  const html = overviewMod.accountingCard({
    counts: { factors: 40, standards: 12, standards_full: 2, public_documents: 3, public_qa: 51 },
  });
  assertIncludes(html, '碳核算公开资料');
  assertIncludes(html, '40', '应显示实际入库因子数');
  assertIncludes(html, '51', '应显示实际入库问答数');
  for (const href of ['#/measure?tab=factors', '#/measure?tab=standards', '#/measure?tab=public']) {
    assertIncludes(html, href, `卡片应有入口 ${href}`);
  }
  assertNotIncludes(html, '576', '不得把上游宣称的 576 当作平台数量显示');
  assertIncludes(html, '本平台实际入库');
  assertEqual(appMod.MODULES.length, 8, '新增资料卡不得改变 8 个主模块');
});

await testAsync('总览：资料库不可用时留空态，不显示替代数字', async () => {
  const overviewMod = await import('../web/v2/modules/overview.js');
  const html = overviewMod.accountingCard({ __error: { status: 503 } });
  assertIncludes(html, '资料库暂不可用');
  assertIncludes(html, '不显示替代数字');
  assertNotIncludes(html, '576');
});

/* ==================================================================== */
/*  九、移动端（390px）适配：新页签、卡片与抽屉                          */
/* ==================================================================== */

await testAsync('移动端样式：新页签/卡片/问答/抽屉在窄屏可用，页面整体不溢出', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../web/v2/styles.css', import.meta.url), 'utf8');
  for (const needle of [
    '.public-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px; }',
    '.qa-item {',
    '.qa-a {',
    '.drawer-body .body-text { max-width: 100%; }',
    '.public-grid { grid-template-columns: minmax(0, 1fr); }',
    '.filters .fld { flex: 1 1 100%; }',
  ]) {
    assertIncludes(css, needle, `移动端样式应包含「${needle}」`);
  }
  // 页签容器允许换行，六个页签在 390px 不会横向撑破
  assertIncludes(css, '.tabs { display: flex; gap: 6px; margin-bottom: 14px; flex-wrap: wrap; align-items: center; }');
});

finish('50-v2-accounting-frontend.test.mjs');
