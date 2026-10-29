/**
 * 模块：碳计算与因子（公开碳核算资料）
 * ============================================================================
 * 对应路由（src/routes-accounting.mjs）：
 *   计算（纯函数，无副作用、不保存用户输入）
 *     POST /api/v2/accounting/calculate/electricity  外购电力排放（范围二）
 *     POST /api/v2/accounting/calculate/fuel         燃料燃烧排放（范围一）
 *     POST /api/v2/accounting/calculate/summary      多分项汇总
 *     POST /api/v2/accounting/calculate/result.json  本次结果 JSON 下载
 *   资料
 *     GET  /api/v2/accounting/factors                公开排放因子库
 *     GET  /api/v2/accounting/standards              标准规范（核算/核查/更新说明）
 *     GET  /api/v2/accounting/public-documents       政策与问答（公开门户政策/标准/问答原文）
 *     GET  /api/v2/accounting/public-documents/:id   单篇原文 + 逐条问答
 *     GET  /api/v2/accounting/sources · /status      来源登记、真实抓取状态与缺口
 *     GET  /api/v2/accounting/crc-daily              中碳登清结算日报（含同日 CEA 对照）
 *
 * 口径纪律（不得为了好看而放宽）：
 *   1. **不做静默回落**：筛选后没有可计算因子就显示原因，绝不自动改用其他地区或全国平均值；
 *   2. **年度不混用**：目标年度与因子数据年度不一致时必须由用户显式勾选「接受使用参考年份因子」，
 *      服务端返回 400 时只提示、不自动带标记重试；
 *   3. **单位不隐式换算**：单位由界面显式选择，服务端 400 原文照实展示（不做前端兜底换算）；
 *   4. **CO₂ ≠ CO₂e**：界面不得把 CO₂ 写成 CO₂e，也不出示 CO₂e 数值；
 *   5. **缺失即缺失**：取不到的字段显示「—」或空态并说明原因，不用 0、不用推测值；
 *   6. **两份来源不同日相加**：中碳登与 CEA 的同日量额仅对照、不重复合计，不合并成一个总量；
 *   7. **正文不解读**：标准规范只展示已归档原文；仅元数据时明确说明尚未取得正文；
 *   8. **面向业务的文案**：页面不出现表名、服务器根目录、调试字段名与 null 之类的实现细节，
 *      必要留痕收进「技术细节（留痕）」折叠区；对用户只讲业务事实与能力限制。
 *
 * 安全：所有插值一律经 esc()；来源链接额外经 safeHttpHref()（仅 http/https 生成链接）。
 */
import { api, setQuery, ApiError } from '../app.js';
import {
  card, table, filtersBar, exportButtons, drawer, toast, loading, emptyState, errorState,
  noteBlock, chip, kv, num, esc, truncate, shortDate, dateTime, metricCard, renderKvRows,
} from '../ui.js';
import { summaryBlock, summaryCoverageHint, sourceBlock, sourceLinkBlock } from '../platform.js';
import { datalistHtml } from '../form-selects.js';

/* ==================================================================== */
/*  共享小工具                                                          */
/* ==================================================================== */

const qs = (obj) => new URLSearchParams(
  Object.fromEntries(Object.entries(obj || {}).filter(([, v]) => v !== null && v !== undefined && v !== ''))
).toString();

const has = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));

const dash = '<span class="muted">—</span>';

/** 来源链接白名单：只有 http/https 返回**已转义**的 href，其余返回 null（按纯文本显示） */
export function safeHttpHref(value) {
  try {
    const url = new URL(String(value));
    return ['http:', 'https:'].includes(url.protocol) ? esc(url.href) : null;
  } catch { return null; }
}

/** 链接或纯文本：非 http/https 时不生成 <a>，也不回显该 URL 文本（避免把危险协议当内容展示） */
function linkOrText(url, label = '打开原文') {
  const href = safeHttpHref(url);
  if (href) return `<a class="link" href="${href}" target="_blank" rel="noreferrer noopener">${esc(label)}</a>`;
  return url ? '<span class="muted">已登记地址不是 http/https：不生成跳转链接</span>' : dash;
}

/** 数值单元格：显示千分位；title 保留原文精确值，便于逐项核对（不是另一个数） */
function numCell(v, digits = 0, unit = '') {
  if (!has(v)) return dash;
  return `<span title="原文值 ${esc(String(v))}${unit ? ` ${esc(unit)}` : ''}">${num(v, digits)}</span>`;
}

/** 来源类别中文化：业务页只讲「这是哪个机构的哪类入口」，不暴露内部代码 */
const SOURCE_CATEGORY_LABEL = {
  crc: '中碳登（注册登记结算）',
  ncsc_factor: '全国碳市场管理平台·排放因子库',
  mee_factor: '生态环境部·排放因子公告',
  cets: '全国碳市场信息网（公开门户）',
  standard: '标准与规范原文',
};
const SOURCE_TYPE_LABEL = {
  portal: '门户首页', list: '列表/栏目页', detail: '文章详情页', pdf: '原件 PDF',
  faq: '问答页', index: '导航/索引页', announcement: '公告页',
};
const sourceCategoryLabel = (v) => (v ? (SOURCE_CATEGORY_LABEL[v] || v) : dash);
const sourceTypeLabel = (v) => (v ? (SOURCE_TYPE_LABEL[v] || v) : dash);

/** 技术细节折叠区：业务页默认不展示表名/字段名/路径等实现细节，留痕仍可展开核对 */
export function techDetails(inner, summary = '技术细节（留痕，可展开核对）') {
  if (!inner) return '';
  return `<details class="tech-details"><summary>${esc(summary)}</summary><div class="tech-details-body">${inner}</div></details>`;
}

const EVIDENCE_LABEL = {
  full_text: '已取得全文', full: '已取得全文', partial: '部分正文',
  abstract_only: '仅有摘要', metadata_only: '仅元数据（未取得正文）', user_input: '用户输入（未经平台核验）',
};
function evidenceChip(level) {
  if (!level) return dash;
  const label = EVIDENCE_LABEL[level] || level;
  const kind = (level === 'full_text' || level === 'full') ? 'ok' : level === 'user_input' ? 'muted' : 'warn';
  return chip(label, kind);
}

const VERIFY_LABEL = {
  verified: '自动核验通过', insufficient: '证据不足', conflict: '来源冲突',
  unavailable: '暂未自动核验', unverified: '未自动核验',
};
const VERIFY_KIND = { verified: 'ok', insufficient: 'warn', conflict: 'danger', unavailable: 'muted', unverified: 'muted' };
function verifyChip(status) {
  if (!status) return dash;
  return chip(VERIFY_LABEL[status] || status, VERIFY_KIND[status] || 'muted');
}

/** 服务端分页条（与 cea.js 同名组件语义一致，避免与 app.js 前端分页冲突） */
function remotePager({ total, limit, offset, unit = '条' }) {
  const page = Math.floor(offset / limit) + 1;
  const pages = Math.max(1, Math.ceil(total / limit));
  return `<div class="pager">
    <button class="btn btn-sm" data-page-remote="prev" ${offset <= 0 ? 'disabled' : ''}>上一页</button>
    <span class="pager-info">第 <b>${page}</b> / ${pages} 页 · 共 ${num(total)} ${esc(unit)}（每页 ${limit} 条，服务端分页）</span>
    <button class="btn btn-sm" data-page-remote="next" ${offset + limit >= total ? 'disabled' : ''}>下一页</button>
  </div>`;
}

/** 资料页筛选接线：写回 hash query（含 tab），触发重新渲染 */
function wireLibraryFilters(root, tab, debounceKeys = []) {
  root.querySelectorAll('[data-filter]').forEach((el) => {
    const key = el.dataset.filter;
    const apply = () => setQuery({ tab, [key]: el.value, offset: null });
    if (el.type === 'search' && debounceKeys.includes(key)) {
      let timer = null;
      el.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(apply, 420); });
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(timer); apply(); } });
    } else {
      el.addEventListener('change', apply);
    }
  });
  root.querySelector('[data-page-remote="prev"]')?.addEventListener('click', () => setQuery({ tab, offset: String(Math.max(0, Number(root.dataset.offset || 0) - Number(root.dataset.limit || 100))) }));
  root.querySelector('[data-page-remote="next"]')?.addEventListener('click', () => setQuery({ tab, offset: String(Number(root.dataset.offset || 0) + Number(root.dataset.limit || 100)) }));
}

/** 单条计算错误的统一展示（detail 原样解释，不吞掉服务端说明） */
function calcErrorHtml(err) {
  const d = err?.body?.detail || null;
  let extra = '';
  if (d && Array.isArray(d.available)) {
    extra = d.available.length
      ? `<p class="hint">当前可用的电力因子：${d.available.map((a) => `${esc(a.label)}（口径 ${esc(a.category || '—')}｜地区 ${esc(a.region || '全国')}）`).join('；')}</p>`
      : '<p class="hint">当前筛选条件下没有任何可用因子。系统不会自动改用其他地区或全国平均值。</p>';
  } else if (d && d.factor_data_year !== undefined && d.target_year !== undefined) {
    extra = `<p class="hint">因子数据年度 ${esc(String(d.factor_data_year))} 与目标年度 ${esc(String(d.target_year))} 不一致：
      如确需按参考年份计算，请勾选「接受使用参考年份因子」后<b>自行重新提交</b>（系统不会自动带该标记重试）。</p>`;
  } else if (d && d.expected_ncv_unit) {
    extra = `<p class="hint">服务端期望的低位发热量单位为 ${esc(String(d.expected_ncv_unit))}。本计算不做隐式单位换算。</p>`;
  }
  return errorState(err) + extra;
}

/** 结果 JSON 下载：服务端复算后返回文件，平台不保存本次输入 */
async function downloadCalcResult(payload, outBox) {
  try {
    const res = await api('/api/v2/accounting/calculate/result.json', { method: 'POST', body: payload, raw: true });
    if (!res.ok) {
      let parsed = null;
      try { parsed = JSON.parse(await res.text()); } catch { parsed = null; }
      throw new ApiError(res.status, parsed);
    }
    const blob = await res.blob();
    const cd = res.headers.get('content-disposition') || '';
    const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
    const plain = /filename="?([^";]+)"?/i.exec(cd);
    const name = star ? decodeURIComponent(star[1]) : (plain ? plain[1] : 'carbon-calc-result.json');
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast('结果 JSON 已开始下载（平台不保存本次输入与结果）', 'ok');
  } catch (err) {
    if (outBox) outBox.insertAdjacentHTML('beforeend', calcErrorHtml(err));
    toast(err.body?.error || err.message || '下载失败', 'danger');
  }
}

/* ==================================================================== */
/*  一、碳排放计算                                                      */
/* ==================================================================== */

const ENERGY_UNITS = ['kWh', 'MWh', '万kWh'];
/** 低位发热量单位与消耗量单位一一对应（服务端不做隐式换算，界面也不提供错的组合） */
const NCV_UNITS = { t: 'GJ/t', '万Nm³': 'GJ/万Nm³', 'Nm³': 'GJ/Nm³' };

const INPUT_LABELS = {
  energy: '电量（原始输入）', energy_unit: '电量单位', energy_kwh: '电量（换算为 kWh）',
  target_year: '目标年度', reference_year_accepted: '是否接受参考年份因子',
  amount: '燃料消耗量', amount_unit: '消耗量单位', ncv: '低位发热量 NCV', ncv_unit: 'NCV 单位',
  carbon_content: '单位热值含碳量', carbon_content_unit: '含碳量单位', oxidation_rate: '碳氧化率',
  energy_gj: '能源消费量（GJ）', carbon_t: '碳量（tC）', carbon_to_co2_ratio: 'CO₂/C 摩尔质量比',
};const INPUT_UNITS = {
  energy_kwh: 'kWh', energy_gj: 'GJ', carbon_t: 'tC',
  carbon_content: 'tC/TJ', ncv: '', amount: '',
};

function inputValueText(key, v) {
  if (v === null || v === undefined || v === '') return dash;
  if (typeof v === 'boolean') return v ? chip('是（已显式确认）', 'warn') : '否';
  if (has(v)) {
    const digits = ['carbon_to_co2_ratio'].includes(key) ? 6 : (['oxidation_rate'].includes(key) ? 4 : 4);
    const unit = INPUT_UNITS[key] ? ` ${esc(INPUT_UNITS[key])}` : '';
    return `${num(v, digits)}${unit}`;
  }
  return esc(String(v));
}

/** 代入取值表（把 response.inputs 的原始键翻译成中文标签，未登记键原样展示） */
function substitutedTable(inputs = {}) {
  const keys = Object.keys(inputs);
  if (!keys.length) return '<p class="muted">服务端未返回代入取值。</p>';
  return `<div class="table-wrap"><table class="grid grid-sm">
    <thead><tr><th>字段</th><th class="ta-r">取值</th></tr></thead>
    <tbody>${keys.map((k) => `<tr><td>${esc(INPUT_LABELS[k] || k)} <span class="muted">(${esc(k)})</span></td>
      <td class="ta-r">${inputValueText(k, inputs[k])}</td></tr>`).join('')}</tbody></table></div>`;
}

/** 因子出处表（与页面上「已选因子」信息一致，结果里再出现一次） */
function factorProvenanceTable(f = {}) {
  return `<div class="table-wrap"><table class="grid grid-sm">
    <thead><tr><th>字段</th><th>取值</th></tr></thead>
    <tbody>
      <tr><td>因子名称</td><td>${f.name ? esc(f.name) : dash}</td></tr>
      <tr><td>数值 / 单位</td><td>${has(f.value) ? num(f.value, 4) : dash} ${esc(f.unit || '')}</td></tr>
      <tr><td>来源代码</td><td>${f.source_code ? `<code>${esc(f.source_code)}</code>` : dash}${f.source_verified === false ? ` ${chip('未经平台核验（用户输入）', 'warn')}` : ''}</td></tr>
      <tr><td>口径类别</td><td>${f.category_label || f.category ? esc(f.category_label || f.category) : dash}</td></tr>
      <tr><td>口径说明</td><td>${f.caliber ? esc(f.caliber) : dash}</td></tr>
      <tr><td>地区</td><td>${esc(f.region || '全国')}</td></tr>
      <tr><td>数据年度</td><td>${f.data_year === null || f.data_year === undefined ? dash : esc(String(f.data_year))}</td></tr>
      <tr><td>版本 / 发布日期</td><td>${esc(f.version || '—')} / ${esc(shortDate(f.publish_date))}</td></tr>
      <tr><td>适用性说明</td><td>${f.applicability ? esc(f.applicability) : dash}</td></tr>
      <tr><td>原文定位</td><td>物理页 ${f.page_physical === null || f.page_physical === undefined ? '—' : esc(String(f.page_physical))}
        ｜打印页 ${f.page_printed === null || f.page_printed === undefined ? '—' : esc(String(f.page_printed))}
        ｜${esc(f.locator || '—')}</td></tr>
      <tr><td>原文链接</td><td>${linkOrText(f.original_url, '打开原件')}</td></tr>
      <tr><td>原件 SHA-256</td><td>${f.original_sha256 ? `<code>${esc(truncate(f.original_sha256, 64))}</code>` : dash}</td></tr>
      <tr><td>证据完整程度</td><td>${evidenceChip(f.evidence_level)}</td></tr>
      <tr><td>模型核验状态</td><td>${verifyChip(f.model_verify_status)}</td></tr>
    </tbody></table></div>`;
}

/** 计算结果（电力 / 燃料同一响应信封） */
function renderCalcResult(r, { title }) {
  const steps = r.steps || [];
  const warnings = r.warnings || [];
  const assumptions = r.assumptions || [];
  return `
  <div class="quick-result">
    <div class="quick-headline">
      <span class="quick-label">${esc(title)}</span>
      <span class="quick-value">${has(r.total_tco2) ? num(r.total_tco2, 4) : '—'}<i>${esc(r.result_unit || 'tCO2')}</i></span>
      ${chip(`气体口径 ${r.gas || '—'}：不折算 GWP，不出 CO₂e 数值`, 'warn')}
    </div>
    <p class="hint">${esc(r.gas_note || '')}</p>

    <h5>公式（服务端确定性程序）</h5>
    <p class="formula-line"><code>${esc(r.formula || '—')}</code></p>
    <p class="hint">${esc(r.formula_note || '')}</p>

    <h5>计算过程（可逐项复算）</h5>
    ${steps.length ? `<div class="table-wrap"><table class="grid grid-sm">
      <thead><tr><th>步骤</th><th>代入式</th></tr></thead>
      <tbody>${steps.map((s) => `<tr><td>${esc(s.step || '—')}</td><td><code>${esc(s.expression || '—')}</code></td></tr>`).join('')}</tbody>
    </table></div>` : '<p class="muted">服务端未返回计算步骤。</p>'}

    <h5>代入取值</h5>
    ${substitutedTable(r.inputs || {})}

    <h5>因子出处（与上方所选因子一致）</h5>
    ${factorProvenanceTable(r.factor || {})}

    <h5>计算假设</h5>
    ${assumptions.length ? `<ul class="bullets">${assumptions.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>` : '<p class="muted">无额外假设说明。</p>'}

    ${warnings.length ? `<div class="callout callout-warn"><b>提示（${warnings.length}）</b>
      <ul>${warnings.map((w) => `<li>${esc(String(w).replaceAll('**', ''))}</li>`).join('')}</ul></div>` : ''}

    <div class="callout callout-warn"><b>适用范围与限制</b>
      <p>${esc(String(r.limitation || '').replaceAll('**', ''))}</p></div>

    ${techDetails('<p>接口不返回 CO₂e 数值：本平台不会把 CO₂ 结果折算成 CO₂e，也不会用 CO₂e 冒充。</p>')}

    <div class="quick-actions">
      <button class="btn btn-sm" data-download-calc="${esc(r.kind || '')}">下载本次结果 JSON</button>
      <span class="hint">下载内容由服务端用同一套纯函数复算生成；平台不保存你的输入与结果。</span>
    </div>
  </div>`;
}

export async function renderCarbonCalc(body, q) {
  body.innerHTML = loading('加载排放因子库…');
  let first;
  try {
    first = await api('/api/v2/accounting/factors?limit=500');
  } catch (e) {
    body.innerHTML = errorState(e);
    return;
  }
  const facets = first.facets || {};

  /** 当前可选因子（仅 calculable === true）与其筛选条件同步维护 */
  let factorById = new Map();
  /** 最近一次提交的输入（只存在本页内存，用于「下载本次结果 JSON」） */
  let lastElectricity = null;
  let lastFuel = null;
  let lastSummaryItems = null;
  /** 分项汇总的页内数组（不落库、不保存） */
  const items = [];

  const yearOptions = (facets.data_years || []).map((y) => `<option value="${esc(y)}">${esc(String(y))}</option>`).join('');
  const catOptions = (facets.categories || []).map((c) => `<option value="${esc(c.key)}">${esc(c.label)}</option>`).join('');
  const regionOptions = (facets.regions || []).map((r) => `<option value="${esc(r.region)}">${esc(r.region)}${r.region_level ? `（${esc(r.region_level)}）` : ''}</option>`).join('');

  /** 因子的 <option>：只喂 calculable === true 的行 */
  function factorOptionHtml(f) {
    return `<option value="${esc(f.id)}">${esc(f.name)}｜${esc(f.category_label || f.category || '口径未标注')}｜${esc(f.region || '全国')}｜${esc(f.data_year === null || f.data_year === undefined ? '年度未标注' : String(f.data_year))}｜${has(f.value) ? esc(String(f.value)) : '—'} ${esc(f.standard_unit || f.original_unit || '')}</option>`;
  }

  /** 「已选因子」信息块（选择变化时由 updateFactorBrief 重渲染） */
  function factorBriefHtml(f) {
    if (!f) {
      return `<div class="callout callout-warn"><b>当前筛选下没有可计算因子</b>
        <p>没有 calculable = true 的因子可选。系统<b>不会</b>自动改用其他地区或全国平均值；
        请调整「因子数据年度 / 口径类别 / 因子地区」，或在确认口径后改用手工输入因子（需自行注明口径与出处）。</p></div>`;
    }
    return `<div class="callout callout-ok">
      <b>已选因子：${esc(f.name)}</b>
      <p>${has(f.value) ? num(f.value, 4) : '—'} ${esc(f.standard_unit || f.original_unit || '')}
        ｜口径：${esc(f.category_label || f.category || '—')}
        ｜地区：${esc(f.region || '全国')}
        ｜数据年度：${f.data_year === null || f.data_year === undefined ? '—' : esc(String(f.data_year))}</p>
      <p class="hint">原文定位：物理页 ${f.page_physical === null || f.page_physical === undefined ? '—' : esc(String(f.page_physical))}
        ｜打印页 ${f.page_printed === null || f.page_printed === undefined ? '—' : esc(String(f.page_printed))}
        ｜${esc(f.locator || '—')}<br>
        模型核验：${esc(VERIFY_LABEL[f.model_verify_status] || f.model_verify_status || '—')}
        ｜原文：${linkOrText(f.original_url, '打开原件')}</p>
    </div>`;
  }

  // 首次落地的因子清单直接进入模板（不额外发请求）；后续筛选变化由 refreshFactors 更新
  const initialFactors = (first.rows || []).filter((f) => f.calculable === true);
  factorById = new Map(initialFactors.map((f) => [f.id, f]));
  const initialFactorOptions = initialFactors.length
    ? initialFactors.map(factorOptionHtml).join('')
    : '<option value="">（当前筛选条件下没有可计算因子）</option>';

  body.innerHTML = `
  <div class="callout">
    <b>碳排放计算（外购电力 / 燃料燃烧）</b>
    <p>结果由服务端<b>确定性纯函数</b>计算，公式、代入取值与因子出处全部展示，可逐项复核；
    每次计算后可点「下载本次结果 JSON」下载由服务端复算生成的结果文件。</p>
    <p class="hint">平台不保存你的输入与计算结果：没有草稿、没有历史记录，刷新或离开页面后表单与分项列表即清空。</p>
    <p class="hint">气体口径为 CO₂，不折算 GWP：页面不出 CO₂e 数值，也不用 CO₂e 冒充。
    本结果不是 CCER 预计签发量，也不构成履约全口径核算。</p>
    <p class="hint">电力因子的三种全国口径（全国电力平均 / 不包括市场化交易的非化石能源电量 / 全国化石能源电力）<b>不得互换</b>：
    口径、地区与数据年度都必须由你在界面上显式筛选并选择，系统不会替你挑一个。</p>
  </div>

  ${card({
    title: '一、外购电力排放（范围二）',
    subtitle: '因子必须显式选择：只列出「可计算」因子；筛选不到时给出原因，不自动改用其他地区或全国平均值',
    body: `
      <form id="calc-elec-form">
        <div class="quick-adv-grid">
          <label class="fld"><span>电量 <b class="req">必填</b></span>
            <span class="input-unit">
              <input type="number" step="any" min="0" data-el="energy" placeholder="0" aria-label="电量">
              <select data-el="energy_unit" aria-label="电量单位">${ENERGY_UNITS.map((u) => `<option value="${esc(u)}">${esc(u)}</option>`).join('')}</select>
            </span>
            <small class="hint">单位由界面显式选择，服务端严格换算，不做隐式单位推断。</small></label>
          <label class="fld"><span>目标年度 <b class="req">必填</b></span>
            <input type="number" min="1900" max="2100" step="1" data-el="target_year" placeholder="如 2025" required aria-label="目标年度" list="calc-target-year-options">
            <small class="hint">必填，取值 1900—2100；与因子数据年度不一致时需显式确认，不提供默认年度。可参考因子库真实数据年度，但允许填其它年度。</small></label>
          <label class="fld"><span>因子数据年度</span>
            <select data-elf="data_year"><option value="">全部</option>${yearOptions}</select></label>
          <label class="fld"><span>因子口径类别</span>
            <select data-elf="category"><option value="">全部</option>${catOptions}</select></label>
          <label class="fld"><span>因子地区</span>
            <select data-elf="region"><option value="">全部</option>${regionOptions}</select></label>
          <label class="fld"><span>电力 CO₂ 因子 <b class="req">必填</b></span>
            <select data-el="factor_id" id="calc-factor-select">${initialFactorOptions}</select>
            <small class="hint">只列出 calculable = true 的因子；不会回落到全国平均值。</small></label>
        </div>
        ${datalistHtml('calc-target-year-options', facets.data_years || [], '', { currentSuffix: '（因子数据年度）' })}
        <label class="fld" id="calc-accept-ref-row">
          <input type="checkbox" id="calc-accept-ref">
          接受使用参考年份因子（目标年度与因子数据年度不一致时必须由你显式勾选，系统不会自动带此标记重试）
        </label>
        <div class="quick-actions">
          <button class="btn btn-primary" type="submit">计算电力排放</button>
          <button class="btn" type="button" data-add-item="electricity">加入分项汇总</button>
          <span class="hint">结果单位 tCO₂；不产出 CO₂e。</span>
        </div>
      </form>
      <div id="calc-factor-brief">${factorBriefHtml(initialFactors[0] || null)}</div>
      <div id="calc-elec-out"></div>`,
    note: '未找到匹配因子、单位不被支持、年度未确认等情形，服务端返回 400 原文照实展示；界面不做兜底换算或替换因子。',
  })}

  ${card({
    title: '二、燃料燃烧排放（范围一）',
    subtitle: '低位发热量单位与消耗量单位绑定（t↔GJ/t、万Nm³↔GJ/万Nm³、Nm³↔GJ/Nm³）；平台不提供默认因子',
    body: `
      <form id="calc-fuel-form">
        <div class="quick-adv-grid">
          <label class="fld"><span>燃料消耗量 <b class="req">必填</b></span>
            <span class="input-unit">
              <input type="number" step="any" min="0" data-el="amount" placeholder="0" aria-label="燃料消耗量">
              <select data-el="amount_unit" aria-label="消耗量单位">
                <option value="t">t（吨）</option><option value="万Nm³">万Nm³</option><option value="Nm³">Nm³</option>
              </select>
            </span></label>
          <label class="fld"><span>低位发热量 NCV <b class="req">必填</b></span>
            <span class="input-unit">
              <input type="number" step="any" min="0" data-el="ncv" placeholder="0" aria-label="低位发热量">
              <select data-el="ncv_unit" aria-label="低位发热量单位"></select>
            </span>
            <small class="hint">可选单位随消耗量单位变化；单位不匹配时服务端直接 400。</small></label>
          <label class="fld"><span>单位热值含碳量 <b class="req">必填</b></span>
            <span class="input-unit">
              <input type="number" step="any" min="0" data-el="carbon_content" placeholder="0" aria-label="单位热值含碳量">
              <i>tC/TJ</i>
            </span>
            <small class="hint">单位固定为 <b>tC/TJ</b>（提交时随值一并标注，其他单位不被接受）；按实测值或适用行业指南给定值填写，并自行注明出处。</small></label>
          <label class="fld"><span>碳氧化率 <b class="req">必填</b></span>
            <span class="input-unit">
              <input type="number" step="any" min="0" max="1" data-el="oxidation_rate" placeholder="0.99" aria-label="碳氧化率">
              <i>0—1</i>
            </span>
            <small class="hint">0.99 表示 99%；有燃料消耗时不得为 0。</small></label>
        </div>
        <div class="quick-actions">
          <button class="btn btn-primary" type="submit">计算燃料排放</button>
          <button class="btn" type="button" data-add-item="fuel_combustion">加入分项汇总</button>
          <span class="hint">本计算不包含 CH₄、N₂O，因此结果不是 CO₂e。</span>
        </div>
      </form>
      <div id="calc-fuel-out"></div>`,
    note: 'NCV / 单位热值含碳量 / 氧化率必须来自实测或适用指南：平台不提供默认值，也不声称这是正式履约全口径核算。',
  })}

  ${card({
    title: '三、多分项汇总（范围一 / 范围二分列）',
    subtitle: '分项只存在本页内存；合计口径为 CO₂，不自动升级为 CO₂e',
    body: `
      <div id="calc-items">${emptyState(
        '尚未添加分项',
        '在「外购电力」或「燃料燃烧」表单填好后点「加入分项汇总」。',
        '分项只保存在本页内存，刷新即丢失：平台不保存用户输入。'
      )}</div>
      <div class="quick-actions">
        <button class="btn btn-primary" type="button" id="calc-summary-run">计算汇总</button>
        <span class="hint">请先在上方表单点「加入分项汇总」。</span>
      </div>
      <div id="calc-summary-out"></div>`,
  })}`;

  /* ---------------- 因子选择 ---------------- */

  function updateFactorBrief() {
    const sel = body.querySelector('#calc-factor-select');
    const brief = body.querySelector('#calc-factor-brief');
    brief.innerHTML = factorBriefHtml(factorById.get(sel.value) || null);
  }

  /** 用一批因子行刷新下拉与「已选因子」信息（不发请求，筛选后由 refreshFactors 调用） */
  function applyFactorRows(rows) {
    const sel = body.querySelector('#calc-factor-select');
    factorById = new Map(rows.map((f) => [f.id, f]));
    sel.innerHTML = rows.length
      ? rows.map(factorOptionHtml).join('')
      : '<option value="">（当前筛选条件下没有可计算因子）</option>';
    updateFactorBrief();
  }

  async function refreshFactors() {
    const sel = body.querySelector('#calc-factor-select');
    const brief = body.querySelector('#calc-factor-brief');
    const dataYear = body.querySelector('[data-elf="data_year"]').value;
    const category = body.querySelector('[data-elf="category"]').value;
    const region = body.querySelector('[data-elf="region"]').value;
    brief.innerHTML = loading('正在查询可用因子…');
    sel.innerHTML = '<option value="">（查询中…）</option>';
    let out;
    try {
      out = await api(`/api/v2/accounting/factors?${qs({ data_year: dataYear, category, region, limit: 500 })}`);
    } catch (e) {
      sel.innerHTML = '<option value="">（查询失败）</option>';
      brief.innerHTML = errorState(e);
      return;
    }
    applyFactorRows((out.rows || []).filter((f) => f.calculable === true));
  }

  /* ---------------- 表单输入读取（不做任何单位/因子兜底） ---------------- */

  function buildElectricityInput(form) {
    const energy = form.querySelector('[data-el="energy"]').value.trim();
    if (energy === '') return { error: '请先填写电量' };
    const targetYearRaw = form.querySelector('[data-el="target_year"]').value.trim();
    if (targetYearRaw === '') return { error: '请先填写目标年度（必填，1900—2100；平台不提供默认年度）' };
    const targetYearNum = Number(targetYearRaw);
    if (!Number.isInteger(targetYearNum) || targetYearNum < 1900 || targetYearNum > 2100) {
      return { error: '目标年度必须是 1900—2100 之间的整数年度' };
    }
    const factorId = form.querySelector('[data-el="factor_id"]').value;
    if (!factorId) return { error: '请先选择一个可计算因子（当前筛选下没有因子时不会自动回落）' };
    const input = {
      energy: Number(energy),
      energy_unit: form.querySelector('[data-el="energy_unit"]').value,
      target_year: targetYearNum,
      factor_id: factorId,
    };
    if (form.querySelector('#calc-accept-ref').checked) input.accept_reference_year = true;
    return { input };
  }

  function buildFuelInput(form) {
    const required = [['amount', '燃料消耗量'], ['ncv', '低位发热量'], ['carbon_content', '单位热值含碳量'], ['oxidation_rate', '碳氧化率']];
    for (const [key, label] of required) {
      if (form.querySelector(`[data-el="${key}"]`).value.trim() === '') return { error: `请先填写${label}` };
    }
    return {
      input: {
        amount: Number(form.querySelector('[data-el="amount"]').value),
        amount_unit: form.querySelector('[data-el="amount_unit"]').value,
        ncv: Number(form.querySelector('[data-el="ncv"]').value),
        ncv_unit: form.querySelector('[data-el="ncv_unit"]').value,
        carbon_content: Number(form.querySelector('[data-el="carbon_content"]').value),
        // 单位在界面上固定为 tC/TJ，提交时显式带上；服务端拒绝其他单位
        carbon_content_unit: 'tC/TJ',
        oxidation_rate: Number(form.querySelector('[data-el="oxidation_rate"]').value),
      },
    };
  }

  function describeItem(it) {
    const i = it.input;
    if (it.kind === 'electricity') {
      const f = factorById.get(i.factor_id);
      return `电量 ${i.energy} ${i.energy_unit}｜因子 ${f ? f.name : i.factor_id}`
        + `｜目标年度 ${i.target_year}`
        + `${i.accept_reference_year ? '｜已确认使用参考年份因子' : ''}`;
    }
    return `消耗量 ${i.amount} ${i.amount_unit}｜NCV ${i.ncv} ${i.ncv_unit}｜含碳量 ${i.carbon_content} tC/TJ｜氧化率 ${i.oxidation_rate}`;
  }

  function renderItems() {
    const box = body.querySelector('#calc-items');
    if (!items.length) {
      box.innerHTML = emptyState(
        '尚未添加分项',
        '在「外购电力」或「燃料燃烧」表单填好后点「加入分项汇总」。',
        '分项只保存在本页内存，刷新即丢失：平台不保存用户输入。'
      );
      return;
    }
    box.innerHTML = table({
      rows: items.map((it, i) => ({ no: i + 1, kind: it.kind, desc: describeItem(it) })),
      pageSize: 20,
      columns: [
        { key: 'no', label: '序号', align: 'right', render: (r) => num(r.no) },
        { key: 'kind', label: '类型', render: (r) => chip(r.kind === 'electricity' ? '外购电力（范围二）' : '燃料燃烧（范围一）', r.kind === 'electricity' ? 'accent' : 'muted') },
        { key: 'desc', label: '输入摘要', render: (r) => esc(r.desc) },
        { key: 'actions', label: '操作', render: (r) => `<button class="btn btn-xs" data-remove-item="${r.no - 1}">移除</button>` },
      ],
      emptyText: '尚未添加分项',
    }) + '<p class="hint">汇总只做算术相加：同一活动数据不得在分项之间重复计入。</p>';
  }

  /* ---------------- 结果渲染 ---------------- */

  function renderSummaryResult(r) {
    const st = r.subtotals || {};
    return `
    <div class="callout callout-warn"><b>本结果不是 CCER 预计签发量，也不构成履约全口径核算。</b>
      <p>${esc(String(r.limitation || '').replaceAll('**', ''))}</p></div>
    <div class="metrics metrics-sm">
      <article class="metric metric-sm"><div class="metric-label">范围一｜直接排放（燃料燃烧）</div>
        <div class="metric-value">${has(st.direct_tco2) ? num(st.direct_tco2, 4) : '—'}<span class="metric-unit">tCO₂</span></div>
        <div class="metric-sub">分项类型 fuel_combustion 的算术合计</div></article>
      <article class="metric metric-sm"><div class="metric-label">范围二｜间接排放（外购电力）</div>
        <div class="metric-value">${has(st.indirect_tco2) ? num(st.indirect_tco2, 4) : '—'}<span class="metric-unit">tCO₂</span></div>
        <div class="metric-sub">分项类型 electricity 的算术合计</div></article>
      <article class="metric metric-sm"><div class="metric-label">合计（直接 + 间接）</div>
        <div class="metric-value">${has(st.total_tco2) ? num(st.total_tco2, 4) : '—'}<span class="metric-unit">tCO₂</span></div>
        <div class="metric-sub">仅 CO₂：不折算 GWP，不出 CO₂e 数值</div></article>
    </div>
    ${table({
      rows: r.items || [],
      pageSize: 25,
      columns: [
        { key: 'index', label: '分项', align: 'right', render: (x) => num(x.index) },
        { key: 'kind', label: '类型', render: (x) => esc(x.kind === 'electricity' ? '外购电力' : x.kind === 'fuel_combustion' ? '燃料燃烧' : (x.kind || '—')) },
        { key: 'scope', label: '范围', render: (x) => chip(x.scope === 'scope1_direct' ? '范围一（直接）' : x.scope === 'scope2_indirect' ? '范围二（间接）' : (x.scope || '—'), x.scope === 'scope1_direct' ? 'accent' : 'ok') },
        { key: 'total_tco2', label: '排放量', unit: 'tCO₂', align: 'right', render: (x) => (has(x.total_tco2) ? num(x.total_tco2, 4) : '—') },
        { key: 'warning_count', label: '提示数', align: 'right', render: (x) => num(x.warning_count) },
      ],
      emptyText: '没有分项',
    })}
    <p class="hint">${esc(String(r.gas_note || '').replaceAll('**', ''))}</p>
    ${(r.warnings || []).length ? `<div class="callout callout-warn"><b>提示</b><ul>${(r.warnings || []).map((w) => `<li>${esc(String(w).replaceAll('**', ''))}</li>`).join('')}</ul></div>` : ''}
    <div class="quick-actions">
      <button class="btn btn-sm" data-download-calc="summary">下载本次结果 JSON</button>
      <span class="hint">服务端用同一套纯函数复算后生成文件；平台不保存本次分项。</span>
    </div>`;
  }

  /* ---------------- 事件接线 ---------------- */

  const elecForm = body.querySelector('#calc-elec-form');
  const fuelForm = body.querySelector('#calc-fuel-form');

  function syncNcvUnit() {
    const amountUnit = fuelForm.querySelector('[data-el="amount_unit"]').value;
    const ncvSel = fuelForm.querySelector('[data-el="ncv_unit"]');
    const unit = NCV_UNITS[amountUnit];
    ncvSel.innerHTML = unit ? `<option value="${esc(unit)}">${esc(unit)}</option>` : '<option value="">（无匹配单位）</option>';
  }

  body.querySelectorAll('[data-elf]').forEach((el) => el.addEventListener('change', refreshFactors));
  body.querySelector('#calc-factor-select').addEventListener('change', updateFactorBrief);

  elecForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = body.querySelector('#calc-elec-out');
    const built = buildElectricityInput(elecForm);
    if (built.error) { toast(built.error, 'warn'); return; }
    out.innerHTML = loading('计算中…');
    try {
      const r = await api('/api/v2/accounting/calculate/electricity', { method: 'POST', body: built.input });
      lastElectricity = built.input;
      out.innerHTML = renderCalcResult(r, { title: '外购电力 CO₂ 排放量' });
    } catch (err) {
      out.innerHTML = calcErrorHtml(err);
      // 年度不一致：把「接受使用参考年份因子」勾选框标出来，等用户自己决定是否重新提交（绝不自动带标记重试）
      const d = err?.body?.detail;
      if (d && d.factor_data_year !== undefined && d.target_year !== undefined) {
        const row = elecForm.querySelector('#calc-accept-ref-row');
        if (row) { row.style.outline = '2px solid #edd9a8'; row.style.borderRadius = '6px'; }
      }
    }
  });

  fuelForm.querySelector('[data-el="amount_unit"]').addEventListener('change', syncNcvUnit);
  fuelForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = body.querySelector('#calc-fuel-out');
    const built = buildFuelInput(fuelForm);
    if (built.error) { toast(built.error, 'warn'); return; }
    out.innerHTML = loading('计算中…');
    try {
      const r = await api('/api/v2/accounting/calculate/fuel', { method: 'POST', body: built.input });
      lastFuel = built.input;
      out.innerHTML = renderCalcResult(r, { title: '燃料燃烧 CO₂ 排放量' });
    } catch (err) {
      out.innerHTML = calcErrorHtml(err);
    }
  });

  body.addEventListener('click', async (e) => {
    const add = e.target.closest('[data-add-item]');
    if (add) {
      const kind = add.dataset.addItem;
      const built = kind === 'electricity' ? buildElectricityInput(elecForm) : buildFuelInput(fuelForm);
      if (built.error) { toast(built.error, 'warn'); return; }
      items.push({ kind, input: { kind, ...built.input } });
      renderItems();
      toast(`已加入第 ${items.length} 个分项（仅本页内存）`, 'ok');
      return;
    }
    const rm = e.target.closest('[data-remove-item]');
    if (rm) {
      items.splice(Number(rm.dataset.removeItem), 1);
      renderItems();
      return;
    }
    const dl = e.target.closest('[data-download-calc]');
    if (dl) {
      const kind = dl.dataset.downloadCalc;
      const out = dl.closest('.quick-result') || body;
      if (kind === 'electricity') {
        if (!lastElectricity) { toast('请先完成一次电力排放计算', 'warn'); return; }
        await downloadCalcResult({ kind: 'electricity', input: lastElectricity }, out);
      } else if (kind === 'fuel_combustion') {
        if (!lastFuel) { toast('请先完成一次燃料排放计算', 'warn'); return; }
        await downloadCalcResult({ kind: 'fuel_combustion', input: lastFuel }, out);
      } else if (kind === 'summary') {
        if (!lastSummaryItems) { toast('请先完成一次汇总计算', 'warn'); return; }
        await downloadCalcResult({ items: lastSummaryItems }, out);
      }
    }
  });

  body.querySelector('#calc-summary-run').addEventListener('click', async () => {
    const out = body.querySelector('#calc-summary-out');
    if (!items.length) {
      out.innerHTML = '<div class="callout callout-warn"><b>还没有分项</b><p>请先在上方表单点「加入分项汇总」。</p></div>';
      return;
    }
    out.innerHTML = loading('汇总计算中…');
    try {
      const payload = items.map((it) => it.input);
      const r = await api('/api/v2/accounting/calculate/summary', { method: 'POST', body: { items: payload } });
      lastSummaryItems = payload;
      out.innerHTML = renderSummaryResult(r);
    } catch (err) {
      out.innerHTML = calcErrorHtml(err);
    }
  });

  syncNcvUnit();
}

/* ==================================================================== */
/*  二、因子库                                                          */
/* ==================================================================== */

async function openFactorDrawer(id) {
  let d;
  try {
    d = await api(`/api/v2/accounting/factors/${encodeURIComponent(id)}`);
  } catch (e) {
    toast(e.body?.error || e.message, 'danger');
    return;
  }
  const f = d.factor || {};
  const versions = f.versions || [];
  const src = f.source || null;
  document.body.insertAdjacentHTML('beforeend', drawer(`因子详情：${truncate(f.name || id, 44)}`, `
    <div class="drawer-section">
      <div class="chip-row">
        ${chip(f.is_current ? '现行版本' : '历史版本', f.is_current ? 'ok' : 'muted')}
        ${evidenceChip(f.evidence_level)}
        ${verifyChip(f.model_verify_status)}
        ${f.calculable ? chip('可计算（可被碳排放计算选用）', 'ok') : chip('不可计算（缺单位或非正值）', 'muted')}
      </div>
      ${kv([
        ['因子名称', esc(f.name || '—')],
        ['数值', has(f.value) ? `${num(f.value, 4)} <span class="muted">（原始单位 ${esc(f.original_unit || '—')}｜标准单位 ${esc(f.standard_unit || '—')}）</span>` : '—'],
        ['气体', esc(f.gas || '—')],
        ['口径类别', esc(f.category_label || f.category || '—')],
        ['口径说明', esc(f.caliber || '—')],
        ['地区 / 层级', `${esc(f.region || '全国')}${f.region_level ? `（${esc(f.region_level)}）` : ''}`],
        ['行业', esc(f.industry || '—')],
        ['数据年度', f.data_year === null || f.data_year === undefined ? '—' : esc(String(f.data_year))],
        ['版本 / 发布日期', `${esc(f.version || '—')} / ${esc(shortDate(f.publish_date))}`],
        ['换算说明', esc(f.conversion_note || '—')],
        ['适用性说明', esc(f.applicability || '—')],
        ['原文定位', `物理页 ${f.page_physical === null || f.page_physical === undefined ? '—' : esc(String(f.page_physical))}｜打印页 ${f.page_printed === null || f.page_printed === undefined ? '—' : esc(String(f.page_printed))}｜${esc(f.locator || '—')}`],
        ['原文链接', linkOrText(f.original_url, '打开原件')],
        ['原件 SHA-256', f.original_sha256 ? `<code>${esc(f.original_sha256)}</code>` : '—'],
        ['来源登记', src ? `${esc(src.name || src.code || '—')}：${linkOrText(src.url, '来源入口')}` : esc(f.source_code || '—')],
        ['模型核验时间', f.model_verify_at ? esc(dateTime(f.model_verify_at)) : '尚未自动核验'],
        ['更新时间', esc(dateTime(f.updated_at))],
      ])}
    </div>
    ${versions.length ? `<div class="drawer-section"><h4>同一来源 / 口径的版本记录（${versions.length}）</h4>
      ${table({
        rows: versions,
        pageSize: 12,
        columns: [
          { key: 'data_year', label: '数据年度', align: 'right', render: (r) => (r.data_year === null || r.data_year === undefined ? '—' : esc(String(r.data_year))) },
          { key: 'version', label: '版本', render: (r) => esc(r.version || '—') },
          { key: 'value', label: '数值', align: 'right', render: (r) => (has(r.value) ? num(r.value, 4) : '—') },
          { key: 'is_current', label: '状态', render: (r) => (r.is_current ? chip('现行', 'ok') : chip('历史', 'muted')) },
          { key: 'evidence_level', label: '证据', render: (r) => evidenceChip(r.evidence_level) },
          { key: 'publish_date', label: '发布日期', render: (r) => esc(shortDate(r.publish_date)) },
          { key: 'updated_at', label: '更新', render: (r) => esc(dateTime(r.updated_at)) },
        ],
      })}</div>` : ''}
    <div class="drawer-section">${techDetails(renderKvRows(f), '技术细节（接口字段留痕，未改写）')}</div>
    ${(d.notes || []).length ? `<div class="drawer-section">${(d.notes || []).map((n) => noteBlock(n)).join('')}</div>` : ''}
  `, { wide: true }));
}

export async function renderFactorLibrary(body, q) {
  const dataYear = q.data_year || '';
  const category = q.category || '';
  const region = q.region || '';
  const regionLevel = q.region_level || '';
  const keyword = q.q || '';
  const limit = 100;
  const offset = Math.max(0, Number(q.offset) || 0);

  const out = await api(`/api/v2/accounting/factors?${qs({
    data_year: dataYear, category, region, region_level: regionLevel, q: keyword, limit, offset,
  })}`);
  const facets = out.facets || {};
  const rows = out.rows || [];

  const exportExtra = `<span class="fld-actions">${exportButtons('accounting/export/factors', qs({ data_year: dataYear, category, region, q: keyword }))}
    <a class="btn btn-sm" href="/api/v2/accounting/export/factors?${qs({ format: 'json', data_year: dataYear, category, region, q: keyword })}" download>下载 JSON</a></span>`;

  body.dataset.limit = String(limit);
  body.dataset.offset = String(offset);
  body.innerHTML = `
  ${filtersBar([
    { key: 'data_year', label: '数据年度', type: 'select', options: (facets.data_years || []).map((y) => ({ value: y, label: String(y) })) },
    { key: 'category', label: '口径类别', type: 'select', options: (facets.categories || []).map((c) => ({ value: c.key, label: c.label })) },
    { key: 'region', label: '地区', type: 'select', options: (facets.regions || []).map((r) => ({ value: r.region, label: r.region })) },
    { key: 'q', label: '关键词', type: 'search', placeholder: '名称 / 口径 / 地区 / 适用性' },
  ], { data_year: dataYear, category, region, q: keyword, __extra: exportExtra })}

  <div class="callout">
    <b>电力 CO₂ 因子库（用于外购电力排放参考计算）</b>
    <p>三种口径（全国平均值 / 不含市场化交易非化石能源电量 / 仅化石能源电力）不可互换，分别标注在「口径」列；
    本库因子不是产品全生命周期碳足迹因子，也不是 CCER 区域电网基准线因子。</p>
    <p class="hint">「可计算性」表示该行具备规范单位与有限正值，可被碳排放计算选用；不可计算的因子照实标注，不做替换。</p>
  </div>

  ${card({
    title: '公开排放因子',
    subtitle: `共 ${num(out.total)} 条（本页 ${rows.length} 条，第 ${Number(out.page) || 1} 页）`,
    actions: `${exportButtons('accounting/export/factors', qs({ data_year: dataYear, category, region, q: keyword }))}
      <a class="btn btn-sm" href="/api/v2/accounting/export/factors?${qs({ format: 'json', data_year: dataYear, category, region, q: keyword })}" download>下载 JSON</a>`,
    body: `<div class="acc-table acc-table-factors">${table({
      rows,
      pageSize: 25,
      columns: [
        { key: 'name', label: '名称与核心摘要', render: (r) => `<button class="link title-cell" data-acc-factor="${esc(r.id)}" title="${esc(r.name || '')}">${esc(truncate(r.name || '—', 46))}</button>${summaryBlock(r, { compact: true })}` },
        { key: 'value', label: '数值', align: 'right', render: (r) => (has(r.value) ? num(r.value, 4) : dash) },
        { key: 'unit', label: '单位', render: (r) => esc(r.original_unit || r.standard_unit || '—') },
        { key: 'gas', label: '气体', render: (r) => esc(r.gas || '—') },
        { key: 'category', label: '口径', render: (r) => esc(r.category_label || r.category || '—') },
        { key: 'region', label: '地区', render: (r) => esc(r.region || '全国') },
        { key: 'data_year', label: '数据年度', align: 'right', render: (r) => (r.data_year === null || r.data_year === undefined ? dash : esc(String(r.data_year))) },
        { key: 'version', label: '版本', render: (r) => esc(r.version || '—') },
        { key: 'locator', label: '原文定位', render: (r) => `物理页 ${r.page_physical === null || r.page_physical === undefined ? '—' : esc(String(r.page_physical))}｜打印页 ${r.page_printed === null || r.page_printed === undefined ? '—' : esc(String(r.page_printed))}<div class="muted">${esc(r.locator || '—')}</div>` },
        { key: 'evidence_level', label: '证据完整程度', render: (r) => evidenceChip(r.evidence_level) },
        { key: 'calculable', label: '可计算性', render: (r) => (r.calculable ? chip('可计算', 'ok') : chip('不可计算（缺单位或非正值）', 'muted')) },
        { key: 'actions', label: '详情', render: (r) => `<button class="btn btn-xs" data-acc-factor="${esc(r.id)}">详情</button>` },
      ],
      emptyText: '当前筛选下没有因子',
      emptyDetail: '调整数据年度 / 口径类别 / 地区或清空关键词后重试；取不到数据时不生成替代行。',
    })}</div>${remotePager({ total: out.total || 0, limit, offset, unit: '条' })}
      ${((out.notes || []).length ? (out.notes || []).map((n) => noteBlock(n)).join('') : '')}`,
  })}`;

  wireLibraryFilters(body, 'factors', ['q']);
  body.addEventListener('click', (e) => {
    const t = e.target.closest('[data-acc-factor]');
    if (!t || !t.dataset.accFactor) return;
    openFactorDrawer(t.dataset.accFactor);
  });
}

/* ==================================================================== */
/*  三、标准规范                                                        */
/* ==================================================================== */

const STANDARD_STATUS_KIND = { formal: 'ok', consultation: 'warn', draft: 'warn', superseded: 'muted', historical: 'muted' };
function standardStatusChip(r) {
  const label = r.status_label || r.status || '—';
  return chip(label, STANDARD_STATUS_KIND[r.status] || 'muted');
}

const BODY_STATUS_KIND = { full: 'ok', partial: 'warn', metadata_only: 'muted' };
function bodyStatusChip(r) {
  const label = r.body_status_label || r.body_status || '—';
  return chip(label, BODY_STATUS_KIND[r.body_status] || 'muted');
}

/** 规范来源体系：国标与履约行业指南不是同一体系，页面必须分开展示 */
const SOURCE_KIND_LABEL = {
  cets_guide: '全国碳市场履约行业指南',
  cets_sector_guide: '全国碳市场履约行业指南',
  cets_update_notice: '履约指南技术要求更新说明',
  update_notice: '技术要求更新说明',
  national_standard: '国家标准（GB/T）',
  technical_spec: '技术规范',
  methodology: '方法学',
};
const PUBLISHED_STATUS_LABEL = {
  published: '已发布', effective: '已实施', draft: '草案', consultation: '征求意见',
  superseded: '已被替代', withdrawn: '已废止', unpublished: '未发布',
};
const BODY_ORIGIN_LABEL = {
  official_original: '官方原件（自动采集）',
  official_download: '官方原件（自动下载）',
  admin_upload: '管理员补充文件',
  admin_path: '管理员补充文件（受限目录）',
  user_upload: '管理员补充文件',
  collected: '自动采集',
  seed_metadata: '仅著录元数据',
};
const sourceKindLabel = (v) => (v ? (SOURCE_KIND_LABEL[v] || v) : '—');
const publishedStatusLabel = (v) => (v ? (PUBLISHED_STATUS_LABEL[v] || v) : '—');
const bodyOriginLabel = (v) => (v ? (BODY_ORIGIN_LABEL[v] || v) : '—');

/** 国标只著录元数据与官方链接：即便正文状态被标为已取得，也不得在页面写成「全文已取得」 */
function isMetadataOnlyStandard(s) {
  return s?.source_kind === 'national_standard' || s?.full_text_available === false;
}

/**
 * 标准详情正文（纯函数，便于回归）：
 * 新增来源体系、发布状态、实施日期、全文可得性、已解析页数、提取完整性、正文来源；
 * 国家标准只给官方链接，不显示「全文已取得」，也不当作履约行业指南的替代。
 */
export function renderStandardDetailHtml(s = {}) {
  const versions = s.versions || [];
  const bodyText = s.body_text ? String(s.body_text) : '';
  const metaOnly = isMetadataOnlyStandard(s);
  const national = s.source_kind === 'national_standard';
  const pagesRead = s.pages_read === null || s.pages_read === undefined ? null : Number(s.pages_read);
  const pagesTotal = s.pages_total === null || s.pages_total === undefined ? null : Number(s.pages_total);
  const extractionComplete = s.extraction_complete === true;
  const fullTextClaimed = !metaOnly && !!bodyText && (s.body_status === 'full' || s.body_status === 'full_text');
  return `
    <div class="drawer-section">
      <div class="chip-row">${standardStatusChip(s)}${bodyStatusChip(s)}${verifyChip(s.model_verify_status)}
        ${fullTextClaimed ? chip('本库已取得全文', 'ok') : chip('本库未取得全文', 'muted')}
        ${national ? chip('国家标准：仅元数据与官方链接', 'warn') : ''}</div>
      ${kv([
        ['编号', esc(s.code || '—')],
        ['标题', esc(s.title || '—')],
        ['发布机构', esc(s.issuer || '—')],
        ['来源体系', esc(sourceKindLabel(s.source_kind))],
        ['行业 / 类型', `${esc(s.sector || '—')} / ${esc(s.standard_type_label || s.standard_type || '—')}`],
        ['发布状态', esc(publishedStatusLabel(s.published_status || s.status))],
        ['版本', esc(s.version || '—')],
        ['发布日 / 落款日', `${esc(shortDate(s.publish_date))} / ${esc(shortDate(s.issue_date))}`],
        ['实施日期', s.effective_date ? esc(shortDate(s.effective_date)) : '<span class="muted">来源未标注</span>'],
        ['适用年度', esc(s.effective_year === null || s.effective_year === undefined ? '—' : String(s.effective_year))],
        ['适用年度清单', esc((s.applicable_years || []).join('、') || '—')],
        ['替代 / 相关编号', `${esc(s.replaces_code || '—')} / ${esc((s.related_codes || []).join('、') || '—')}`],
        ['全国碳市场关系', esc(s.cets_relation || '—')],
        ['原文 PDF', linkOrText(s.original_url, '打开原文 PDF')],
        ['公告页', linkOrText(s.announcement_url, '打开公告页')],
        ['原件 SHA-256', s.sha256 ? `<code>${esc(s.sha256)}</code>` : '—'],
        ['页数 / 已解析页数', `${pagesTotal === null ? '—' : num(pagesTotal)} 页 / ${pagesRead === null ? '—' : num(pagesRead)} 页`],
        ['正文提取是否完整', extractionComplete ? chip('已覆盖全部页', 'ok') : chip('未覆盖全部页（不作为全文）', 'warn')],
        ['正文字数', num(s.body_chars ?? s.chars)],
        ['正文来源', esc(bodyOriginLabel(s.body_origin))],
        ['元数据来源', esc(s.metadata_origin || '—')],
        ['模型核验时间', s.model_verify_at ? esc(dateTime(s.model_verify_at)) : '尚未自动核验'],
        ['更新时间', esc(dateTime(s.updated_at))],
        ['来源登记', s.source ? `${esc(s.source.name || s.source.code || '—')}：${linkOrText(s.source.url, '来源入口')}` : '—'],
      ])}
      ${national ? `<div class="callout callout-warn"><b>国家标准与履约行业指南不是同一体系</b>
        <p>本条为国家标准（GB/T）的公开著录信息：页面提供官方查询链接，但本库<b>不展示其全文</b>，也不把它当作全国碳市场履约行业指南的替代文件。</p></div>` : ''}
    </div>
    <div class="drawer-section">
      <h4>正文（原文）</h4>
      ${(bodyText && !metaOnly)
        ? `<details><summary>规范正文（原文）</summary><pre class="body-text">${esc(bodyText)}</pre></details>
           <p class="hint">正文为已归档原文，逐字展示：本平台<b>不</b>对条款做摘要、解读或改写。正文状态：${bodyStatusChip(s)}
           ｜提取覆盖：${pagesRead === null ? '页数未标注' : `已解析 ${num(pagesRead)} 页`}${pagesTotal === null ? '' : ` / 共 ${num(pagesTotal)} 页`}${extractionComplete ? '（已覆盖全部页）' : '（未覆盖全部页，不作为全文使用）'}。</p>`
        : (metaOnly
          ? emptyState(
            national ? '国家标准仅提供官方链接，不在本库展示全文' : '尚未取得正文（仅元数据）',
            national
              ? '本库只保存该国家标准的著录信息与官方查询入口；官方说明版权限制，不提供全文转载。'
              : '本库只有该规范的著录信息，没有可核对的正文，因此不提供条款解读。',
            '可由管理员上传 PDF 后自动解析并交模型核对（后台「碳核算资料 → 上传标准 PDF」，默认从本机选择文件）。'
          )
          : emptyState('尚未取得正文', '该条目当前没有正文文本，因此不提供条款解读。'))}
    </div>
    ${versions.length ? `<div class="drawer-section"><h4>同行业规范版本（${versions.length}）</h4>
      ${table({
        rows: versions,
        pageSize: 12,
        columns: [
          { key: 'code', label: '编号', render: (r) => esc(r.code || '—') },
          { key: 'version', label: '版本', render: (r) => esc(r.version || '—') },
          { key: 'status', label: '状态', render: (r) => esc(r.status || '—') },
          { key: 'publish_date', label: '发布日', render: (r) => esc(shortDate(r.publish_date)) },
          { key: 'body_status', label: '正文', render: (r) => esc(r.body_status || '—') },
        ],
      })}</div>` : ''}
    <div class="drawer-section">${techDetails(renderKvRows({ ...s, body_text: metaOnly ? '（本库不展示该来源的正文）' : (bodyText ? `（${bodyText.length} 字符，原文见上）` : null) }), '技术细节（接口字段留痕，未改写）')}</div>
  `;
}

async function openStandardDrawer(id) {
  let d;
  try {
    d = await api(`/api/v2/accounting/standards/${encodeURIComponent(id)}`);
  } catch (e) {
    toast(e.body?.error || e.message, 'danger');
    return;
  }
  const s = d.standard || {};
  document.body.insertAdjacentHTML('beforeend', drawer(
    `标准规范：${truncate(s.code || s.title || id, 46)}`,
    renderStandardDetailHtml(s),
    { wide: true }
  ));
}

export async function renderStandardLibrary(body, q) {
  const sector = q.sector || '';
  const status = q.status || '';
  const standardType = q.standard_type || '';
  const keyword = q.q || '';
  const limit = 100;

  const out = await api(`/api/v2/accounting/standards?${qs({
    sector, status, standard_type: standardType, q: keyword, limit,
  })}`);
  const facets = out.facets || {};
  const rows = out.rows || [];
  const exportQuery = qs({ sector, status, standard_type: standardType, q: keyword });

  body.innerHTML = `
  ${filtersBar([
    { key: 'sector', label: '行业', type: 'select', options: (facets.sectors || []).map((s) => ({ value: s, label: s })) },
    { key: 'status', label: '状态', type: 'select', options: (facets.statuses || []).map((s) => ({ value: s.key, label: s.label })) },
    { key: 'standard_type', label: '类型', type: 'select', options: (facets.types || []).map((t) => ({ value: t.key, label: t.label })) },
    { key: 'q', label: '关键词', type: 'search', placeholder: '标题 / 编号 / 原文定位' },
  ], {
    sector, status, standard_type: standardType, q: keyword,
    __extra: `<span class="fld-actions">
      <a class="btn btn-sm" href="/api/v2/accounting/export/standards?format=csv&${exportQuery}" download>下载 CSV</a>
      <a class="btn btn-sm" href="/api/v2/accounting/export/standards?format=json&${exportQuery}" download>下载 JSON</a></span>`,
  })}

  <div class="callout">
    <b>标准规范只做著录与原文归档，不做解读</b>
    <p>「现行正式」只用于正式印发/发布的规范；征求意见稿单独标注，绝不当作正式版。
    「仅元数据（未取得正文）」表示本库尚未取得规范正文，页面不会给出条款摘要或解释。</p>
    <p class="hint">正文取得后由已配置模型做带引用的自动核验：引用无法在正文中定位时判为「证据不足」，不显示为已核验。</p>
  </div>

  ${card({
    title: '标准与技术规范',
    subtitle: `共 ${num(out.total)} 条（本页 ${rows.length} 条）`,
    actions: `<a class="btn btn-sm" href="/api/v2/accounting/export/standards?format=csv&${exportQuery}" download>下载 CSV</a>
      <a class="btn btn-sm" href="/api/v2/accounting/export/standards?format=json&${exportQuery}" download>下载 JSON</a>`,
    body: `<div class="acc-table acc-table-standards">${table({
      rows,
      pageSize: 25,
      columns: [
        { key: 'code', label: '编号', render: (r) => `<button class="link" data-acc-std="${esc(r.id)}" title="${esc(r.title || '')}">${esc(r.code || '—')}</button>` },
        { key: 'title', label: '标题与核心摘要', render: (r) => `<span class="title-cell">${esc(truncate(r.title || '—', 52))}</span>${summaryBlock(r, { compact: true })}` },
        { key: 'issuer', label: '发布机构', render: (r) => esc(truncate(r.issuer || '—', 20)) },
        { key: 'sector', label: '行业', render: (r) => esc(r.sector || '—') },
        { key: 'standard_type', label: '类型', render: (r) => esc(r.standard_type_label || r.standard_type || '—') },
        { key: 'status', label: '状态', render: (r) => standardStatusChip(r) },
        { key: 'version', label: '版本', render: (r) => esc(r.version || '—') },
        { key: 'publish_date', label: '发布日', render: (r) => esc(shortDate(r.publish_date)) },
        { key: 'issue_date', label: '落款日', render: (r) => esc(shortDate(r.issue_date)) },
        { key: 'effective_year', label: '适用年度', render: (r) => (r.effective_year === null || r.effective_year === undefined ? dash : esc(String(r.effective_year))) },
        { key: 'body_status', label: '正文', render: (r) => bodyStatusChip(r) },
        { key: 'original_url', label: '原文 PDF', render: (r) => linkOrText(r.original_url, 'PDF') },
        { key: 'announcement_url', label: '公告页', render: (r) => linkOrText(r.announcement_url, '公告') },
        { key: 'actions', label: '详情', render: (r) => `<button class="btn btn-xs" data-acc-std="${esc(r.id)}">详情</button>` },
      ],
      emptyText: '当前筛选下没有标准规范',
      emptyDetail: '调整行业 / 状态 / 类型或清空关键词后重试；未采集到的规范不会生成占位行。',
    })}</div>${((out.notes || []).length ? (out.notes || []).map((n) => noteBlock(n)).join('') : '')}`,
  })}`;

  wireLibraryFilters(body, 'standards', ['q']);
  body.addEventListener('click', (e) => {
    const t = e.target.closest('[data-acc-std]');
    if (!t || !t.dataset.accStd) return;
    openStandardDrawer(t.dataset.accStd);
  });
}

/* ==================================================================== */
/*  四、资料来源                                                        */
/* ==================================================================== */

const SOURCE_STATUS_LABEL = {
  ok: '正常', blocked: '被拦截', error: '抓取失败', stale: '长期未更新',
  registered: '仅登记（未抓取）', empty: '空结果',
};
const SOURCE_STATUS_KIND = {
  ok: 'ok', blocked: 'danger', error: 'warn', stale: 'warn', registered: 'muted', empty: 'muted',
};
function sourceStatusChip(status) {
  if (!status) return dash;
  return chip(SOURCE_STATUS_LABEL[status] || status, SOURCE_STATUS_KIND[status] || 'muted');
}

const GAP_KIND_LABEL = {
  http_412_challenge: '来源返回 HTTP 412（反爬挑战）',
  count_not_imported: '来源数量未导入',
  standard_body_missing: '标准正文缺失',
};

/** 来源状态表（后台「碳核算资料」页复用同一渲染） */
export function renderAccountingSourceTable(sources, { pageSize = 12 } = {}) {
  return table({
    rows: sources || [],
    pageSize,
    columns: [
      { key: 'name', label: '名称', render: (r) => esc(truncate(r.name || '—', 34)) },
      { key: 'category', label: '来源类别', render: (r) => esc(sourceCategoryLabel(r.category)) },
      { key: 'source_type', label: '入口类型', render: (r) => esc(sourceTypeLabel(r.source_type)) },
      { key: 'authority', label: '权威主体', render: (r) => esc(truncate(r.authority || '—', 20)) },
      { key: 'status', label: '状态', render: (r) => sourceStatusChip(r.status) },
      { key: 'last_attempt_at', label: '最近尝试', render: (r) => esc(dateTime(r.last_attempt_at)) },
      {
        key: 'last_success_at',
        label: '最近成功',
        render: (r) => (r.last_success_at
          ? esc(dateTime(r.last_success_at))
          : '<span class="muted">未抓取（仅登记）</span>'),
      },
      { key: 'collected_count', label: '已采集', align: 'right', render: (r) => num(r.collected_count) },
      {
        key: 'url',
        label: '链接',
        render: (r) => `${linkOrText(r.url, '来源入口')}${r.last_page_url && r.last_page_url !== r.url ? `<div class="muted">最近抓取：${linkOrText(r.last_page_url, '页面')}</div>` : ''}`,
      },
      {
        key: 'tech',
        label: '运行说明',
        render: (r) => techDetails([
          `状态码：${r.last_http_status === null || r.last_http_status === undefined ? '—' : esc(String(r.last_http_status))}`,
          r.blocked_kind ? `拦截类型：${esc(r.blocked_kind)}` : '',
          r.fetch_kind ? `抓取方式：${esc(r.fetch_kind)}` : '',
          r.last_error || r.status_note ? `错误/说明：${esc(truncate(r.last_error || r.status_note, 160))}` : '',
        ].filter(Boolean).join('<br>'), '运行明细'),
      },
    ],
    emptyText: '没有符合条件的来源',
    emptyDetail: '来源登记由服务端种子数据维护；从未真实抓取过的来源保持「仅登记」状态。',
  });
}

/** 中碳登清结算日报的 CEA 同日对照单元（两方原值均保留，绝不相加） */
const CRC_FIELD_LABEL = {
  daily_volume_t: '本日成交量', daily_amount_yuan: '本日成交额',
  cumulative_volume_t: '累计成交量', cumulative_amount_yuan: '累计成交额',
};
function ceaCompareCell(row) {
  if (!row.cea_available) return '<span class="muted">同日无 CEA 行情</span>';
  const c = row.cea_compare || {};
  const cea = c.cea || {};
  const diffs = c.differences || [];
  return `
    <div>CEA 成交量 ${num(cea.total_volume)} 吨｜成交额 ${num(cea.total_turnover)} 元｜收盘价 ${num(cea.close, 2)} 元/吨</div>
    <div>${c.match ? chip('一致', 'ok') : chip('有差异（两方原值均已保留）', 'warn')}</div>
    ${diffs.length ? `<details><summary>差异明细（${diffs.length}）</summary>
      <table class="grid grid-sm"><thead><tr><th>字段</th><th class="ta-r">中碳登</th><th class="ta-r">CEA</th><th class="ta-r">差异</th></tr></thead>
      <tbody>${diffs.map((x) => `<tr><td>${esc(CRC_FIELD_LABEL[x.field] || x.field)}</td>
        <td class="ta-r">${num(x.crc)}</td><td class="ta-r">${num(x.cea)}</td><td class="ta-r">${num(x.diff)}</td></tr>`).join('')}</tbody></table>
      <p class="hint">差异只做标注：不取平均、不择一覆盖、不做合并总量。</p></details>` : ''}`;
}

function crcDailyTable(rows) {
  return table({
    rows: rows || [],
    pageSize: 25,
    columns: [
      { key: 'trade_date', label: '数据日期', render: (r) => (safeHttpHref(r.detail_url) ? `<a class="link" href="${safeHttpHref(r.detail_url)}" target="_blank" rel="noreferrer noopener">${esc(r.trade_date || '—')}</a>` : esc(r.trade_date || '—')) },
      { key: 'daily_volume_t', label: '本日成交量', unit: '吨', align: 'right', render: (r) => numCell(r.daily_volume_t, 0, '吨') },
      { key: 'daily_amount_yuan', label: '本日成交额', unit: '元', align: 'right', render: (r) => numCell(r.daily_amount_yuan, 0, '元') },
      { key: 'daily_avg_price_published', label: '公布均价', unit: '元/吨', align: 'right', render: (r) => numCell(r.daily_avg_price_published, 2, '元/吨') },
      { key: 'daily_avg_price_derived', label: '复算均价', unit: '元/吨', align: 'right', render: (r) => numCell(r.daily_avg_price_derived, 2, '元/吨') },
      { key: 'cumulative_volume_t', label: '累计成交量', unit: '吨', align: 'right', render: (r) => numCell(r.cumulative_volume_t, 0, '吨') },
      { key: 'cumulative_amount_yuan', label: '累计成交额', unit: '元', align: 'right', render: (r) => numCell(r.cumulative_amount_yuan, 0, '元') },
      { key: 'revision_no', label: '修订号', align: 'right', render: (r) => (r.revision_no ? chip(`第 ${num(r.revision_no)} 版`, Number(r.revision_no) > 1 ? 'warn' : 'muted') : '1') },
      { key: 'cea', label: 'CEA 同日对照', render: (r) => ceaCompareCell(r) },
    ],
    emptyText: '所选区间没有中碳登清结算日报',
    emptyDetail: '日报未采集或区间内没有数据时不生成占位行；可在后台「碳核算资料」触发 crc_daily 采集。',
  });
}

export async function renderSourceLibrary(body, q) {
  const category = q.category || '';
  const status = q.status || '';
  const keyword = q.q || '';

  const [st, src, crc] = await Promise.all([
    api('/api/v2/accounting/status'),
    api(`/api/v2/accounting/sources?${qs({ category, status, q: keyword, limit: 300 })}`),
    api('/api/v2/accounting/crc-daily?limit=30'),
  ]);
  const counts = st.counts || {};
  const gaps = st.gaps || [];
  const sources = src.sources || [];
  const bySource = st.by_source || [];
  const categories = [...new Set(bySource.map((x) => x.category).filter(Boolean))].sort();
  const statuses = [...new Set(bySource.map((x) => x.status).filter(Boolean))].sort();
  const crcRows = crc.rows || [];

  body.innerHTML = `
  <div class="metrics">
    ${metricCard({ label: '来源登记', value: counts.sources, unit: '个', sub: `被拦截 ${num(counts.blocked_sources)} 个｜按来源类别与状态分列在下方`, as_of: '', source: '公开来源登记', warn: Number(counts.blocked_sources || 0) > 0 })}
    ${metricCard({ label: '排放因子（现行 / 全部版本）', value: counts.factors, unit: '条', sub: `含历史版本共 ${num(counts.factors_total)} 条；不可计算因子照实标注`, as_of: '', source: '官方公告附件（本平台实际读取）' })}
    ${metricCard({ label: '标准规范', value: counts.standards, unit: '条', sub: `已取得正文 ${num(counts.standards_full ?? counts.standards_with_body)} 条｜其余仅著录元数据（不解读）`, as_of: '', source: '正式印发文件与国家标准著录', warn: Number(counts.standards || 0) > Number((counts.standards_full ?? counts.standards_with_body) || 0) })}
    ${metricCard({ label: '政策与问答', value: counts.public_documents, unit: '条', sub: `其中逐条问答 ${num(counts.public_qa)} 条｜栏目页与导航不是全文`, as_of: '', source: '全国碳市场信息网公开门户' })}
    ${metricCard({ label: '中碳登清结算日报', value: counts.crc_daily, unit: '期', sub: `最新数据日期 ${counts.crc_latest_date || '—'}；与 CEA 行情同日仅对照、不重复合计`, as_of: counts.crc_latest_date, source: '中碳登公开日报' })}
    ${metricCard({ label: '未结清缺口', value: gaps.length, unit: '项', sub: '缺口台账如实登记，不用占位数据顶替', as_of: '', source: '采集运行记录', warn: gaps.length > 0 })}
  </div>

  ${gaps.length ? `<div class="callout callout-warn"><b>缺口（如实登记的能力边界，共 ${gaps.length} 项）</b>
    <ul>${gaps.map((g) => `<li>${chip(GAP_KIND_LABEL[g.kind] || g.kind || '缺口', 'warn')} <b>${esc(g.code || '—')}</b>：${esc(g.note || '')}</li>`).join('')}</ul>
    <p class="hint">以上缺口不通过界面「补一个数字」解决：需要来源侧可访问或管理员上传原件后才能消除。</p></div>`
    : '<div class="callout callout-ok"><b>当前没有登记缺口</b><p>缺口台账为空，表示已登记来源均可正常抓取且规范正文均已取得。</p></div>'}

  ${(st.notes || []).map((n) => noteBlock(n)).join('')}

  ${filtersBar([
    { key: 'category', label: '来源类别', type: 'select', options: categories.map((c) => ({ value: c, label: sourceCategoryLabel(c) })) },
    { key: 'status', label: '状态', type: 'select', options: statuses.map((s) => ({ value: s, label: SOURCE_STATUS_LABEL[s] || s })) },
    { key: 'q', label: '关键词', type: 'search', placeholder: '名称 / 地址 / 状态说明' },
  ], { category, status, q: keyword })}

  ${card({
    title: '来源登记与真实抓取状态',
    subtitle: `${sources.length} 个来源｜状态与最近成功时间均来自真实运行记录；未经采集的来源保持「仅登记」`,
    body: `<div class="acc-table acc-table-sources">${renderAccountingSourceTable(sources, { pageSize: 12 })}</div>` + noteBlock(src.note || ''),
  })}

  ${card({
    title: '中碳登清结算日报（与 CEA 同日对照）',
    subtitle: `共 ${num(crc.total)} 期（本页 ${crcRows.length} 期）｜最新在前`,
    body: `
      <div class="callout callout-warn"><b>两份来源同日数据仅对照、不重复合计</b>
        <p>中碳登为<b>清结算日报</b>口径，CEA 为全国碳排放配额<b>行情</b>口径：同日数据只做交叉核对，
        差异保留两方原值，不做平均、不择一覆盖，也不合成一个总量（同一批交易不会被计两次）。</p>
        <p class="hint">公布均价是日报原文的四舍五入值；复算均价按「成交总额 ÷ 成交总量」另列，两个值不互相覆盖。</p></div>
      <div class="acc-table acc-table-crc">${crcDailyTable(crcRows)}</div>
      ${noteBlock(crc.note || '')}`,
  })}`;

  wireLibraryFilters(body, 'sources', ['q']);
}

/* ==================================================================== */
/*  五、政策与问答（公开门户政策 / 标准 / 问答原文）                      */
/* ==================================================================== */

const PUBLIC_CATEGORY_LABEL = { policy: '政策', standard: '标准', faq: '问答' };
const PUBLIC_CATEGORY_KIND = { policy: 'accent', standard: 'ok', faq: 'plain' };
const PUBLIC_DOC_TYPE_LABEL = { article: '文章正文', faq: '问答', index: '栏目页（导航，不是全文）' };
const PUBLIC_BODY_STATUS_LABEL = {
  full: '正文已取得', full_text: '正文已取得', partial: '部分正文',
  index_only: '仅栏目条目（未取正文）', list_only: '仅列表信息（未取正文）',
  metadata_only: '仅条目信息（未取得正文）', failed: '正文获取失败',
};
function publicCategoryChip(v) {
  if (!v) return dash;
  return chip(PUBLIC_CATEGORY_LABEL[v] || v, PUBLIC_CATEGORY_KIND[v] || 'muted');
}
function publicDocTypeChip(v) {
  if (!v) return dash;
  if (v === 'index') return chip(PUBLIC_DOC_TYPE_LABEL.index, 'warn');
  return chip(PUBLIC_DOC_TYPE_LABEL[v] || v, v === 'faq' ? 'accent' : 'muted');
}
function publicBodyStatusChip(v) {
  if (!v) return dash;
  const kind = (v === 'full' || v === 'full_text') ? 'ok' : v === 'partial' ? 'warn' : 'muted';
  return chip(PUBLIC_BODY_STATUS_LABEL[v] || v, kind);
}
/** 发布日期：原站未标注时如实写明，绝不用采集时间顶替 */
function publicPublishedText(doc) {
  if (doc.published_at) return esc(shortDate(doc.published_at));
  return `<span class="muted">${doc.category === 'faq' ? '原站问答，发布日期未标注' : '原站未标注'}</span>`;
}

/** 数量对照：来源页面宣称的条数 ≠ 本平台实际读取到的条数 */
function publicCountText(doc) {
  const parts = [];
  if (has(doc.observed_count)) parts.push(`本平台实际读取 ${num(doc.observed_count)} 条`);
  if (has(doc.announced_count)) parts.push(`原站栏目宣称 ${num(doc.announced_count)} 条（不是本平台已入库数量）`);
  if (has(doc.qa_count)) parts.push(`含问答 ${num(doc.qa_count)} 条`);
  return parts.length ? parts.join('｜') : '';
}

async function openPublicDocumentDrawer(id) {
  let d;
  try {
    d = await api(`/api/v2/accounting/public-documents/${encodeURIComponent(id)}`);
  } catch (e) {
    toast(e.body?.error || e.message, 'danger');
    return;
  }
  const doc = d.document || {};
  document.body.insertAdjacentHTML('beforeend', drawer(
    `公开原文：${truncate(doc.title || id, 44)}`,
    renderPublicDocumentDetail(doc, d.qa || []),
    { wide: true }
  ));
}

/** 公开原文详情（纯函数，便于回归）：原文 + 逐条问答 + 发布日期与核验口径提示 */
export function renderPublicDocumentDetail(doc = {}, qa = []) {
  const bodyText = doc.body_text ? String(doc.body_text) : '';
  const isIndex = doc.doc_type === 'index';
  return `
    <div class="drawer-section">
      <div class="chip-row">
        ${publicCategoryChip(doc.category)}${publicDocTypeChip(doc.doc_type)}
        ${publicBodyStatusChip(doc.body_status)}${verifyChip(doc.model_verify_status)}
      </div>
      ${kv([
        ['标题', esc(doc.title || '—')],
        ['来源分类', esc(PUBLIC_CATEGORY_LABEL[doc.category] || doc.category || '—')],
        ['页面类型', esc(PUBLIC_DOC_TYPE_LABEL[doc.doc_type] || doc.doc_type || '—')],
        ['原站发布日期', publicPublishedText(doc)],
        ['本平台采集时间', esc(dateTime(doc.captured_at))],
        ['原文入口', linkOrText(doc.url, '打开原站原文')],
        ['条目数量', publicCountText(doc) || '—'],
        ['能力限制', esc(doc.limitation || '未登记额外限制。')],
      ])}
      ${isIndex ? `<div class="callout callout-warn"><b>这是栏目 / 导航页，不是全文</b>
        <p>该条目来自原站栏目或索引：其中列出的链接与标题只用于发现后续页面，<b>不作为文章正文</b>，
        也不把菜单文字当作全文。</p></div>` : ''}
    </div>
    <div class="drawer-section">
      <h4>${isIndex ? '栏目页文本（导航内容，不作为全文）' : '原文'}</h4>
      ${bodyText
        ? `<pre class="body-text">${esc(bodyText)}</pre>
           <p class="hint">以上为原站抓取到的原文，逐字保留：本平台<b>不</b>改写、不摘编、不做条款解读。
           「核验」只表示正文与所给原文一致，不表示内容已按最新规范更新。</p>`
        : emptyState('尚未取得正文', '该条目当前没有可展示的正文文本；原站入口见上方链接，本平台不生成替代内容。')}
    </div>
    ${qa.length ? `<div class="drawer-section">
      <h4>问答（${qa.length} 条，按原站顺序逐条显示）</h4>
      <div class="qa-list">${qa.map((x, i) => `
        <article class="qa-item">
          <div class="qa-q"><span class="qa-no">问 ${num(has(x.ordinal) ? x.ordinal : i + 1)}</span>${esc(x.question || '（原站未提供问题文本）')}</div>
          <div class="qa-a">${esc(x.answer || '（原站未提供答复文本）')}</div>
          ${safeHttpHref(x.source_url) ? `<div class="public-meta">原站条目：<a class="link" href="${safeHttpHref(x.source_url)}" target="_blank" rel="noreferrer noopener">打开原站</a></div>` : ''}
        </article>`).join('')}</div>
      <div class="callout callout-warn"><b>问答阅读提示</b>
        <p>答复按原站原文保留：其中的指南名称与版本以原站为准，可能沿用当时有效的<b>旧版指南</b>名称，本平台不把它改写成现行文件。</p>
        <p class="hint">「核验」仅表示问答文本与所给原文一致，<b>不表示</b>全部答复已按最新规范更新；发布日期未标注时不用采集时间顶替。</p></div>
    </div>` : `<div class="drawer-section"><h4>问答</h4>${emptyState('该条目没有逐条问答', '只有问答类页面才包含逐条问答；本平台不拆分或改写其它页面。')}</div>`}
    <div class="drawer-section">${techDetails(renderKvRows({ ...doc, body_text: bodyText ? `（${bodyText.length} 字符，原文见上）` : null }), '技术细节（接口字段留痕，未改写）')}</div>
  `;
}

export async function renderPublicDocuments(body, q) {
  const category = q.category || '';
  const docType = q.doc_type || '';
  const keyword = q.q || '';
  const limit = 100;
  const offset = Math.max(0, Number(q.offset) || 0);

  const out = await api(`/api/v2/accounting/public-documents?${qs({
    q: keyword, category, doc_type: docType, limit, offset,
  })}`);
  const rows = out.rows || [];
  const total = Number(out.total) || 0;

  body.dataset.limit = String(limit);
  body.dataset.offset = String(offset);

  const listHtml = rows.length
    ? `<div class="public-grid">${rows.map((r) => `
        <article class="public-card">
          <div class="chip-row">${publicCategoryChip(r.category)}${publicDocTypeChip(r.doc_type)}${publicBodyStatusChip(r.body_status)}${sourceBlock(r)}</div>
          <h4 class="public-title">${esc(r.title || '（原站未提供标题）')}</h4>
          ${summaryBlock(r, { compact: true })}
          <p class="public-meta">原站发布日期：${publicPublishedText(r)}｜本平台采集：${esc(shortDate(r.captured_at))}</p>
          ${publicCountText(r) ? `<p class="public-meta">${esc(publicCountText(r))}</p>` : ''}
          ${r.limitation ? `<p class="hint">${esc(r.limitation)}</p>` : ''}
          <div class="public-actions">
            <button class="btn btn-sm" data-acc-public="${esc(r.id)}">查看原文${has(r.qa_count) && Number(r.qa_count) > 0 ? `与问答（${num(r.qa_count)}）` : ''}</button>
            ${safeHttpHref(r.url) ? `<a class="link src-link" href="${safeHttpHref(r.url)}" target="_blank" rel="noreferrer noopener">原站入口</a>` : '<span class="muted">来源未标注</span>'}
          </div>
        </article>`).join('')}</div>${summaryCoverageHint(rows)}`
    : emptyState(
      '当前筛选下没有公开资料',
      '本页只展示真实抓取入库的公开原文；没有读取到的条目不会生成占位内容。',
      '可调整分类 / 页面类型或清空关键词后重试。'
    );

  body.innerHTML = `
  ${filtersBar([
    { key: 'category', label: '分类', type: 'select', options: [
      { value: 'policy', label: '政策' }, { value: 'standard', label: '标准' }, { value: 'faq', label: '问答' },
    ] },
    { key: 'doc_type', label: '页面类型', type: 'select', options: [
      { value: 'article', label: '文章正文' }, { value: 'faq', label: '问答' }, { value: 'index', label: '栏目页（导航，不是全文）' },
    ] },
    { key: 'q', label: '关键词', type: 'search', placeholder: '标题 / 正文关键词' },
  ], { category, doc_type: docType, q: keyword })}

  <div class="callout">
    <b>政策与问答：全国碳市场信息网公开原文</b>
    <p>政策、标准与问答均来自公开门户，逐字保留原文；<b>栏目页与导航不是全文</b>，只用于发现后续页面。
    「核验」只表示正文与所给原文一致，<b>不表示</b>答复已按最新规范更新；旧版指南的答复保留原样，与现行文件分开展示。</p>
    <p class="hint">原站未标注发布日期时显示「原站未标注」，采集时间不作为发布日期。
    原站栏目宣称的条数只作对照，<b>不是</b>本平台已入库数量。</p>
  </div>

  ${card({
    title: '公开政策、标准与问答',
    subtitle: `共 ${num(total)} 条（本页 ${rows.length} 条）｜按原站列表逐条展示，问答逐条打开阅读`,
    body: `${listHtml}${remotePager({ total, limit, offset, unit: '条' })}`,
  })}`;

  wireLibraryFilters(body, 'public', ['q']);
  body.addEventListener('click', (e) => {
    const t = e.target.closest('[data-acc-public]');
    if (!t || !t.dataset.accPublic) return;
    openPublicDocumentDrawer(t.dataset.accPublic);
  });
}

/* 供后台「碳核算资料」复用的缺口渲染 */
export function renderAccountingGaps(gaps) {
  const list = gaps || [];
  if (!list.length) return '<p class="muted">当前没有登记缺口。</p>';
  return `<div class="callout callout-warn"><b>缺口（共 ${list.length} 项）</b>
    <ul>${list.map((g) => `<li>${chip(GAP_KIND_LABEL[g.kind] || g.kind || '缺口', 'warn')} <b>${esc(g.code || '—')}</b>：${esc(g.note || '')}</li>`).join('')}</ul></div>`;
}
