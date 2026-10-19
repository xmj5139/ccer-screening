/**
 * 模块五：碳计算与因子（原「减排粗估」，docs/39 第 5 条）
 * ============================================================================
 * 六个页签（页签状态放在 hash query，如 #/measure?tab=calc）：
 *   gas       减排粗估      —— 低于 8% 煤矿瓦斯简表（原有实现，保持默认落地页）
 *   calc      碳排放计算    —— 外购电力 / 燃料燃烧 / 多分项汇总（纯函数接口，不保存输入）
 *   factors   因子库        —— 公开排放因子（电力 CO2 因子）与原文定位
 *   standards 标准规范      —— 核算/核查规范元数据与原文正文（不解读、不摘编）
 *   public    政策与问答    —— 公开门户政策/标准/问答原文（栏目页不是全文；问答逐条保留原文）
 *   sources   资料来源      —— 来源登记与真实抓取状态、缺口、中碳登清结算日报
 *
 * 原「减排粗估」需求（docs/19 第 24 条、docs/22 第 17 条）在 gas 页签内**保持不变**：
 *   - **不需要项目档案、不需要任何签字或审批**；
 *   - 「低于 8% 煤矿瓦斯简表」置顶：年混合气量、平均甲烷浓度两项为主，
 *     处理比例与销毁效率为**可选高级参数**；
 *   - 结果是**规模粗估，不是可签发量**；正式申报量按方法学与监测数据计算，两者口径不同；
 *   - **不得由 LLM 任意生成数值公式**（公式与因子来自方法学原文的确定性程序）；
 *   - 气量单位由界面显式选择：m³/年 或 万 m³/年（服务端严格 ×10000 换算），
 *     避免单位错配导致数量级错误。
 */
import { api } from '../app.js';
import {
  card, esc, kv, num, toast, loading, errorState, emptyState,
} from '../ui.js';
import {
  renderCarbonCalc, renderFactorLibrary, renderStandardLibrary, renderSourceLibrary,
  renderPublicDocuments,
} from './accounting.js';

const TABS = [
  { key: 'gas', label: '减排粗估' },
  { key: 'calc', label: '碳排放计算' },
  { key: 'factors', label: '因子库' },
  { key: 'standards', label: '标准规范' },
  { key: 'public', label: '政策与问答' },
  { key: 'sources', label: '资料来源' },
];

/* ------------------------------ 小工具 ------------------------------ */

/** 来源链接白名单：只有 http/https 才生成链接，其余按纯文本显示 */
function safeHttpHref(value) {
  try {
    const url = new URL(String(value));
    return ['http:', 'https:'].includes(url.protocol) ? esc(url.href) : null;
  } catch { return null; }
}

function sourceLink(url, label) {
  const href = safeHttpHref(url);
  if (href) return `<a class="link" href="${href}" target="_blank" rel="noreferrer noopener">${esc(label)}</a>`;
  return url ? `<span class="muted">${esc(url)}</span>` : '—';
}

/* ------------------------------ 入口（页签外壳） ------------------------------ */

export async function renderMeasure(root, route) {
  const q = (route && route.query) || {};
  const tab = TABS.some((t) => t.key === q.tab) ? q.tab : 'gas';
  root.innerHTML = `
    <div class="tabs">${TABS.map((t) => `<a class="tab ${t.key === tab ? 'active' : ''}" href="#/measure?tab=${t.key}">${esc(t.label)}</a>`).join('')}</div>
    <div id="tab-body">${loading()}</div>`;
  const body = document.getElementById('tab-body');
  try {
    if (tab === 'gas') await renderQuickGas(body, q);
    else if (tab === 'calc') await renderCarbonCalc(body, q);
    else if (tab === 'factors') await renderFactorLibrary(body, q);
    else if (tab === 'standards') await renderStandardLibrary(body, q);
    else if (tab === 'public') await renderPublicDocuments(body, q);
    else await renderSourceLibrary(body, q);
  } catch (e) {
    body.innerHTML = errorState(e);
  }
}

/* ==================================================================== */
/*  一、减排粗估（低于 8% 煤矿瓦斯简表）—— 原有实现，行为不变            */
/* ==================================================================== */

export async function renderQuickGas(root) {
  let meta;
  try {
    meta = await api('/api/v2/measure/quick-gas/meta');
  } catch (e) {
    root.innerHTML = errorState(e);
    return;
  }

  root.innerHTML = `
  <div class="callout callout-ok">
    <b>${esc(meta.title)}</b>
    <p>${esc(meta.subtitle)}。本页不需要项目档案或审批流程：填入两项主要参数即可得到规模量级。</p>
  </div>

  ${card({
    title: '低于 8% 煤矿瓦斯简表',
    subtitle: '主要参数两项：年混合气量与平均甲烷浓度',
    body: `
      <form id="quick-form" class="quick-form">
        <div class="quick-primary">
          ${meta.primary_fields.map((f) => `
            <label class="fld fld-lg">
              <span>${esc(f.label)}${f.required ? ' <b class="req">必填</b>' : ''}</span>
              <span class="input-unit">
                <input type="number" step="any" min="0" data-q="${esc(f.key)}" placeholder="0"
                       aria-label="${esc(f.label)}" ${f.required ? 'required' : ''}>
                ${f.unit_options
                  ? `<select data-q-unit="${esc(f.key)}" aria-label="${esc(f.label)}单位">
                       ${f.unit_options.map((u) => `<option value="${esc(u.key)}">${esc(u.label)}</option>`).join('')}
                     </select>`
                  : `<i>${esc(f.unit || '')}</i>`}
              </span>
              <small class="hint">${esc(f.hint || '')}</small>
            </label>`).join('')}
        </div>

        <details class="quick-advanced">
          <summary>高级参数（可选，不填按方法学默认值）</summary>
          <div class="quick-adv-grid">
            ${meta.advanced_fields.map((f) => `
              <label class="fld">
                <span>${esc(f.label)}</span>
                <span class="input-unit">
                  <input type="number" step="any" min="0" data-q="${esc(f.key)}" placeholder="${esc(String(f.default))}"
                         aria-label="${esc(f.label)}">
                  <i>${esc(f.unit || '')}</i>
                </span>
                <small class="hint">${esc(f.hint || '')}</small>
              </label>`).join('')}
          </div>
        </details>

        <div class="quick-actions">
          <button class="btn btn-primary" type="submit" id="quick-submit">计算粗估量</button>
          <button class="btn" type="reset" id="quick-reset">清空</button>
          <span class="hint">结果仅为规模粗估，不是可签发 CCER 量。</span>
        </div>
      </form>
      <div id="quick-result"></div>
    `,
    note: meta.disclaimer,
  })}

  <div class="grid-2">
    ${card({
      title: '计算口径与公式来源',
      subtitle: '数值由确定性程序计算，不由大模型生成',
      body: `
        ${kv([
          ['公式', `<code>${esc(meta.formula)}</code>`],
          ['公式与因子来源', esc(meta.formula_origin)],
          ['数值来源', '确定性计算程序（服务端复算，结果可逐项复核）'],
          ['气量单位口径', `m³/年 或 万 m³/年（1 万 m³ = 10000 m³，服务端严格换算）`],
          ['方法学原文', sourceLink(meta.source_url, '打开官方 PDF')],
        ])}
        <p class="hint">大模型在本平台只用于公开内容的证据核验与摘要抽取，<b>不参与任何数值公式或结果的生成</b>。</p>
      `,
    })}
    ${card({
      title: '本简表未包含的内容',
      subtitle: '阅读结果时请一并考虑',
      body: `<ul class="bullets">
        <li>外供电替代排放、外供热替代排放、项目购电排放</li>
        <li>实际分时甲烷浓度与 ≥8% 时段的扣除</li>
        <li>装置进气甲烷量与按能源产出推算甲烷量取较小值的规则</li>
        <li>监测联网要求与项目适用条件</li>
      </ul>
      <p class="hint">本页给出的是规模粗估；正式申报量必须按方法学、实际监测数据与审定核查结论计算，
      两者口径不同，不作为申报或签发依据。</p>`,
    })}
  </div>

  ${card({
    title: '需要估算 CEA 履约成本？',
    subtitle: '全国碳排放配额（CEA）履约缺口与抵销情景的临时算术（不保存参数、不自动建议购买）',
    body: `<p>本页估算的是 CCER 项目减排规模（可签发量级），<b>不是</b> CEA 履约成本。若要看配额缺口、
    可用抵销数量与两种成本口径的差额，请使用 CEA 履约成本情景工具：抵销比例必须显式选择，
    参考价格可手动输入或从真实行情选择（会显示所选价格的交易日与口径）。</p>
    <p><a class="btn btn-sm btn-primary" href="#/cea?tab=scenario">CEA 履约成本情景</a></p>`,
  })}`;

  bindQuickForm(meta);
}

function bindQuickForm(meta) {
  const form = document.getElementById('quick-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {};
    form.querySelectorAll('[data-q]').forEach((el) => {
      const v = el.value.trim();
      if (v === '') return;
      // 气量字段按所选单位写入**对应口径的键**：annual_gas_m3 = m³/年，
      // annual_gas_10k_m3 = 万 m³/年（服务端严格 ×10000）。避免单位与数值口径不一致。
      const unitSel = form.querySelector(`[data-q-unit="${el.dataset.q}"]`);
      const key = unitSel && unitSel.value !== el.dataset.q ? unitSel.value : el.dataset.q;
      body[key] = Number(v);
    });
    const missing = meta.primary_fields.filter((f) => {
      if (body[f.key] !== undefined && body[f.key] > 0) return false;
      // 带单位可选项的气量字段：值可能写在换算键上
      return !(f.unit_options || []).some((u) => body[u.key] !== undefined && body[u.key] > 0);
    });
    if (missing.length) {
      toast(`请填写：${missing.map((f) => f.label).join('、')}`, 'warn');
      return;
    }
    const out = document.getElementById('quick-result');
    out.innerHTML = loading('计算中…');
    const btn = document.getElementById('quick-submit');
    btn.disabled = true;
    try {
      const r = await api('/api/v2/measure/quick-gas', { method: 'POST', body });
      out.innerHTML = renderQuickResult(r);
    } catch (err) {
      out.innerHTML = errorState(err);
    } finally {
      btn.disabled = false;
    }
  });
  form.addEventListener('reset', () => {
    document.getElementById('quick-result').innerHTML = '';
  });
}

function renderQuickResult(r) {
  if (r.error) {
    return emptyState('输入不适用', r.error);
  }
  return `
  <div class="quick-result">
    <div class="quick-headline">
      <span class="quick-label">甲烷处理部分粗估减排量</span>
      <span class="quick-value">${num(r.annual_tco2e, 2)}<i>tCO₂e/年</i></span>
      <span class="chip chip-warn">规模粗估，不是可签发量</span>
    </div>
    <div class="metrics metrics-sm">
      <article class="metric metric-sm"><div class="metric-label">输入甲烷量</div>
        <div class="metric-value">${num(r.methane_input_t, 2)}<span class="metric-unit">tCH₄</span></div></article>
      <article class="metric metric-sm"><div class="metric-label">基准线甲烷排放</div>
        <div class="metric-value">${num(r.baseline_methane_tco2e, 2)}<span class="metric-unit">tCO₂e</span></div></article>
      <article class="metric metric-sm"><div class="metric-label">项目氧化生成 CO₂</div>
        <div class="metric-value">${num(r.project_oxidation_co2_t, 2)}<span class="metric-unit">tCO₂</span></div></article>
      <article class="metric metric-sm"><div class="metric-label">未氧化逃逸甲烷</div>
        <div class="metric-value">${num(r.project_unoxidized_methane_tco2e, 2)}<span class="metric-unit">tCO₂e</span></div></article>
    </div>
    <h5>计算过程（可逐项复算）</h5>
    <p class="formula-line"><code>${esc(r.formula)}</code></p>
    <div class="table-wrap"><table class="grid grid-sm">
      <thead><tr><th>输入</th><th class="ta-r">取值</th></tr></thead>
      <tbody>
        <tr><td>年混合气量</td><td class="ta-r">${num(r.inputs.annual_gas_m3)} m³/年
          <span class="muted">（${num(r.inputs.annual_gas_10k_m3, 2)} 万 m³/年）</span></td></tr>
        <tr><td>平均甲烷浓度</td><td class="ta-r">${num(r.inputs.ch4_pct, 2)}%</td></tr>
        <tr><td>进入装置比例</td><td class="ta-r">${num(r.inputs.treated_share_pct, 2)}%</td></tr>
        <tr><td>销毁效率</td><td class="ta-r">${num(r.inputs.destruction_efficiency_pct, 2)}%</td></tr>
        <tr><td>气体基准</td><td class="ta-r">${esc(r.inputs.gas_basis)}</td></tr>
      </tbody></table></div>
    <h5>所用因子与出处</h5>
    <div class="table-wrap"><table class="grid grid-sm">
      <thead><tr><th>因子</th><th class="ta-r">取值</th><th>单位</th><th>出处</th></tr></thead>
      <tbody>${r.factors.map((f) => `<tr><td>${esc(f.name)}</td><td class="ta-r">${num(f.value, 2)}</td>
        <td>${esc(f.unit)}</td><td class="muted">${esc(f.source)}</td></tr>`).join('')}</tbody></table></div>
    <h5>本结果未包含</h5>
    <ul class="bullets">${r.omitted.map((o) => `<li>${esc(o)}</li>`).join('')}</ul>
    <div class="callout callout-warn"><b>口径提示</b><p>${esc(r.caveat)}</p>
      <p class="hint">方法学原文：${sourceLink(r.source_url, r.source_url)}</p></div>
  </div>`;
}
