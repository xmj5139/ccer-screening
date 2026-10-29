/**
 * v2 工作台 · 共享 UI 组件
 * ============================================================================
 * 零依赖（无框架、无构建步骤）。提供：
 *   - 数值/日期/状态格式化（含千分位与空值「—」）
 *   - 卡片、指标块（带「截至日期 + 来源 + 口径」）
 *   - 表格（排序、列筛选、分页、固定表头）
 *   - 折线/柱状/条形图（内联 SVG，带 tooltip）
 *   - 状态视图：加载中 / 无数据 / 采集失败 / 权限不足 / 草案 / 待审核
 *   - 抽屉（详情）、筛选栏、下载按钮
 *
 * 设计约束（需求规格第 3 节）：浅色底、深灰文字、克制的绿/蓝强调色、
 * 统一间距、重要数字带单位与千分位、关键状态有颜色以外的文字标识。
 */

/* ------------------------------ 格式化 ------------------------------ */

import { datalistHtml, selectOptionsHtml } from './form-selects.js';

export function num(v, digits = 0) {
  if (v === null || v === undefined || v === '' || Number.isNaN(Number(v))) return '—';
  return Number(v).toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: Math.max(digits, 2) });
}

export function pct(v, digits = 2) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return '—';
  return `${Number(v) > 0 ? '+' : ''}${Number(v).toFixed(digits)}%`;
}

/** 涨跌幅：保留正负号，并用与品牌绿分离的红/绿语义表示方向。 */
export function delta(v, digits = 2) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return '<span class="muted">—</span>';
  const n = Number(v);
  const tone = n > 0 ? 'up' : n < 0 ? 'down' : 'flat';
  return `<span class="delta delta-${tone}">${pct(n, digits)}</span>`;
}

export function shortDate(s) {
  if (!s) return '—';
  return String(s).slice(0, 10);
}

export function dateTime(s) {
  if (!s) return '—';
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(String(s))) {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).format(d);
  }
  return String(s).replace('T', ' ').slice(0, 19);
}

export function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function truncate(s, n = 60) {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

export const STATE_LABELS = {
  traded: '有成交', no_trade: '无成交', closed: '休市', missing: '数据暂缺',
  // 行情核对状态由系统自动执行：不使用「待核对/已核对」这类人工措辞
  pending: '待自动核对', verified: '系统自动核对通过', mismatch: '与官方不符（已自动标注）',
  pass: '满足', fail: '不满足', unknown: '待核实',
};

export function stateChip(state, label = null) {
  const cls = {
    traded: 'chip chip-ok', verified: 'chip chip-ok', pass: 'chip chip-ok',
    no_trade: 'chip chip-muted', closed: 'chip chip-muted',
    missing: 'chip chip-warn', pending: 'chip chip-warn', unknown: 'chip chip-warn',
    mismatch: 'chip chip-danger', fail: 'chip chip-danger',
  }[state] || 'chip';
  return `<span class="${cls}">${esc(label || STATE_LABELS[state] || state)}</span>`;
}

/* ------------------------------ 基础块 ------------------------------ */

export function card({ title, subtitle, actions = '', body = '', note = '', id = '' }) {
  return `
  <section class="card" ${id ? `id="${esc(id)}"` : ''}>
    ${title ? `<header class="card-head">
      <div><h3>${esc(title)}</h3>${subtitle ? `<p class="muted">${esc(subtitle)}</p>` : ''}</div>
      <div class="card-actions">${actions}</div>
    </header>` : ''}
    <div class="card-body">${body}</div>
    ${note ? `<footer class="card-note">${esc(note)}</footer>` : ''}
  </section>`;
}

/**
 * 指标块：数值 + 单位 + 截至日期 + 数据源 + 口径按钮（需求规格 1.1）
 */
export function metricCard(m) {
  const value = m.value === null || m.value === undefined ? '—' : num(m.value, Number.isInteger(Number(m.value)) ? 0 : 2);
  return `
  <article class="metric ${m.warn ? 'metric-warn' : ''}" data-drill="${esc(m.drill || '')}">
    <div class="metric-head">
      <span class="metric-label">${esc(m.label)}</span>
      ${m.warn ? '<span class="chip chip-warn">需关注</span>' : ''}
    </div>
    <div class="metric-value">${esc(value)}<span class="metric-unit">${esc(m.unit || '')}</span></div>
    <div class="metric-sub">${esc(String(m.sub || '').replaceAll('**', ''))}</div>
    ${m.note ? `<details class="metric-explain"><summary>指标说明</summary><div class="metric-note">${esc(String(m.note).replaceAll('**', ''))}</div></details>` : ''}
    <div class="metric-foot">
      <span>截至 ${esc(shortDate(m.as_of))}</span>
      <span title="${esc(m.source || '')}">来源：${esc(truncate(m.source, 32))}</span>
      ${m.caliber_key ? `<button class="link" data-caliber="${esc(m.caliber_key)}">口径</button>` : ''}
    </div>
  </article>`;
}

export function statusViews() {}

export function loading(text = '加载中…') {
  return `<div class="state"><div class="spinner" aria-hidden="true"></div><p>${esc(text)}</p></div>`;
}

function stateIcon(kind) {
  const body = kind === 'error'
    ? '<path d="M12 3.8 21 20H3z"/><path d="M12 9v4.8"/><path d="M12 17.1h.01"/>'
    : '<circle cx="10.8" cy="10.8" r="6.4"/><path d="m15.5 15.5 4.1 4.1"/><path d="M8 10.8h5.6"/>';
  return `<svg class="state-icon" viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}

export function emptyState(title, detail = '', hint = '') {
  return `<div class="state">${stateIcon('empty')}<h4>${esc(title)}</h4>
    ${detail ? `<p class="muted">${esc(detail)}</p>` : ''}
    ${hint ? `<p class="hint">${esc(hint)}</p>` : ''}</div>`;
}

export function errorState(err) {
  const status = err?.status || 0;
  const titleMap = {
    401: '需要登录',
    403: '权限不足',
    404: '没有找到',
    409: '当前状态不允许该操作',
    422: '输入校验未通过',
    503: 'v2 功能未启用',
  };
  const title = titleMap[status] || '加载失败';
  const detail = err?.body?.message || err?.body?.error || err?.message || '请稍后重试';
  const extra = err?.body?.missing_tables?.length
    ? `缺少表：${err.body.missing_tables.slice(0, 6).join('、')}`
    : err?.body?.v2?.message || '';
  return `<div class="state state-error">${stateIcon('error')}
    <h4>${esc(title)}${status ? `（HTTP ${status}）` : ''}</h4>
    <p>${esc(detail)}</p>${extra ? `<p class="muted">${esc(extra)}</p>` : ''}</div>`;
}

export function noteBlock(text) {
  return text ? `<p class="note-block">${esc(text)}</p>` : '';
}

export function chip(text, kind = '') {
  return `<span class="chip ${kind ? `chip-${kind}` : ''}">${esc(text)}</span>`;
}

export function kv(pairs) {
  return `<dl class="kv">${pairs
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`)
    .join('')}</dl>`;
}

/* ------------------------------ 表格 ------------------------------ */

/**
 * 渲染表格。
 * @param {{columns:Array<{key,label,unit?,align?,render?,definition?}>, rows:Array<object>,
 *          sortable?:boolean, pageSize?:number, emptyText?:string, id?:string}} cfg
 */
export function table(cfg) {
  const { columns, rows, pageSize = 25, emptyText = '没有数据', id = '' } = cfg;
  if (!rows || !rows.length) return emptyState(emptyText, cfg.emptyDetail || '', cfg.emptyHint || '');
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const sortable = cfg.sortable !== false;
  const head = columns.map((c) => {
    const canSort = sortable && Boolean(c.key);
    return `<th scope="col" class="${c.align === 'right' ? 'ta-r' : ''}" data-sort="${canSort ? esc(c.key) : ''}" ${canSort ? 'tabindex="0" aria-sort="none"' : ''} title="${esc(c.definition || '')}">${esc(c.label)}${c.unit ? `<span class="unit">(${esc(c.unit)})</span>` : ''}</th>`;
  }).join('');
  // 全部行都渲染在 DOM 中（前端分页只切换显示），这样排序、钻取都在本地完成，不需要重新请求
  // rowAttrs(row) 可给整行加 data-* 属性（用于整行钻取）；键盘钻取仍由单元格内的按钮提供
  const attrs = typeof cfg.rowAttrs === 'function' ? cfg.rowAttrs : () => '';
  const body = rows.map((r, i) => `<tr data-row-page="${Math.floor(i / pageSize) + 1}" ${attrs(r) || ''}>${columns.map((c) => {
    const v = c.render ? c.render(r) : esc(r[c.key] === null || r[c.key] === undefined ? '—' : r[c.key]);
    return `<td class="${c.align === 'right' ? 'ta-r' : ''}">${v}</td>`;
  }).join('')}</tr>`).join('');
  const scrollable = columns.length >= 7;
  return `
  <div class="table-wrap" ${id ? `id="${esc(id)}"` : ''} data-total="${total}" data-page="1" data-pages="${pages}" data-page-size="${pageSize}" data-cols="${columns.length}" ${scrollable ? 'tabindex="0" role="region" aria-label="数据表，可横向滚动"' : ''}>
    <table class="grid">
      <thead><tr>${head}</tr></thead>
      <tbody>${body}</tbody>
    </table>
    <div class="pager">
      ${pages > 1 ? `<button class="btn btn-sm" type="button" data-page-prev disabled aria-label="上一页">上一页</button>` : ''}
      <span class="pager-info">第 <b class="pager-now">1</b> / ${pages} 页 · 共 ${total} 条</span>
      ${pages > 1 ? `<button class="btn btn-sm" type="button" data-page-next aria-label="下一页">下一页</button>` : ''}
    </div>
  </div>`;
}

/** 前端分页：切换 .table-wrap 的当前页（CSS 依据 data-row-page 显隐） */
export function setTablePage(wrap, page) {
  const pages = Number(wrap.dataset.pages || '1');
  const target = Math.min(Math.max(1, page), pages);
  wrap.dataset.page = String(target);
  const now = wrap.querySelector('.pager-now');
  if (now) now.textContent = String(target);
  const prev = wrap.querySelector('[data-page-prev]');
  const next = wrap.querySelector('[data-page-next]');
  if (prev) prev.disabled = target <= 1;
  if (next) next.disabled = target >= pages;
}

/* ------------------------------ 图表（内联 SVG） ------------------------------ */

/**
 * 折线 + 柱状组合图：成交量柱 + 成交均价折线。
 * 图例文案/单位可覆盖（默认沿用 CCER 口径，CEA 传自己的吨/元口径）。
 * 缺失值（null/undefined）**不画 0 柱、不连线**：缺失就是缺失，不用 0 冒充。
 */
export function comboChart({
  points, height, showVolume = true, showPrice = true,
  valueKey = 'volume', priceKey = 'avg_price', labelKey = 'trade_date',
  valueLabel = '成交量', valueUnit = 'tCO₂e', priceLabel = '成交均价', priceUnit = '元/tCO₂e',
  priceNote = '右轴，非收盘价', priceDigits = 2, ariaLabel = '量价走势',
}) {
  const data = (points || []).filter((p) => p);
  if (!data.length) return emptyState('暂无行情数据', '导入或采集官方行情后显示走势');
  const has = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
  const w = 900;
  // 未显式传 height 时保持原有外观（沿用 styles.css 的 .chart svg 高度）
  const h = Number(height) || 220;
  const sizeAttr = height ? ` style="height:${Number(height)}px"` : '';
  const pad = { l: 62, r: 58, t: 14, b: 26 };
  const n = data.length;
  const vols = data.map((d) => (has(d[valueKey]) ? Number(d[valueKey]) : null));
  const prices = data.map((d) => (has(d[priceKey]) ? Number(d[priceKey]) : null));
  const maxV = Math.max(1, ...vols.filter((v) => v !== null));
  const priceVals = prices.filter((p) => p !== null);
  const minP = priceVals.length ? Math.min(...priceVals) : 0;
  const maxP = priceVals.length ? Math.max(...priceVals) : 1;
  const spanP = Math.max(1e-6, maxP - minP);
  const x = (i) => pad.l + (n === 1 ? (w - pad.l - pad.r) / 2 : (i * (w - pad.l - pad.r)) / (n - 1));
  const yV = (v) => h - pad.b - ((Number(v) || 0) / maxV) * (h - pad.t - pad.b);
  const yP = (v) => h - pad.b - ((v - minP) / spanP) * (h - pad.t - pad.b) * 0.9 - (h - pad.t - pad.b) * 0.05;
  const barW = Math.max(1.5, Math.min(14, (w - pad.l - pad.r) / Math.max(1, n) - 2));

  const bars = showVolume
    ? data.map((d, i) => (vols[i] === null ? '' : `<rect x="${(x(i) - barW / 2).toFixed(1)}" y="${yV(d[valueKey]).toFixed(1)}" width="${barW.toFixed(1)}"
        height="${Math.max(0, h - pad.b - yV(d[valueKey])).toFixed(1)}" class="bar"><title>${esc(d[labelKey])}｜${esc(valueLabel)} ${num(d[valueKey])} ${esc(valueUnit)}</title></rect>`)).join('')
    : '';
  const linePts = data.map((d, i) => (prices[i] === null ? null : `${x(i).toFixed(1)},${yP(prices[i]).toFixed(1)}`)).filter(Boolean).join(' ');
  const dots = showPrice
    ? data.map((d, i) => (prices[i] === null ? '' :
        `<circle cx="${x(i).toFixed(1)}" cy="${yP(prices[i]).toFixed(1)}" r="2.6" class="dot"><title>${esc(d[labelKey])}｜${esc(priceLabel)} ${num(prices[i], priceDigits)} ${esc(priceUnit)}</title></circle>`)).join('')
    : '';
  const yTicks = [0, 0.5, 1].map((f) => {
    const v = maxV * f;
    return `<g><line x1="${pad.l}" x2="${w - pad.r}" y1="${yV(v).toFixed(1)}" y2="${yV(v).toFixed(1)}" class="grid-line"/>
      <text x="${pad.l - 6}" y="${(yV(v) + 3).toFixed(1)}" class="axis ta-end">${num(v)}</text></g>`;
  }).join('');
  const pTicks = [0, 0.5, 1].map((f) => {
    const v = minP + spanP * f;
    return `<text x="${w - pad.r + 6}" y="${(yP(v) + 3).toFixed(1)}" class="axis">${num(v, priceDigits)}</text>`;
  }).join('');
  const first = data[0];
  const last = data[n - 1];
  return `
  <div class="chart">
    <svg viewBox="0 0 ${w} ${h}"${sizeAttr} preserveAspectRatio="none" role="img" aria-label="${esc(ariaLabel)}">
      ${yTicks}${pTicks}
      ${bars}
      ${linePts ? `<polyline points="${linePts}" class="line"/>` : ''}
      ${dots}
      <text x="${pad.l}" y="${h - 8}" class="axis">${esc(first[labelKey])}</text>
      <text x="${w - pad.r}" y="${h - 8}" class="axis ta-end">${esc(last[labelKey])}</text>
    </svg>
    <div class="legend">
      ${showVolume ? `<span><i class="swatch swatch-bar"></i>${esc(valueLabel)}（${esc(valueUnit)}，左轴）</span>` : ''}
      ${showPrice ? `<span><i class="swatch swatch-line"></i>${esc(priceLabel)}（${esc(priceUnit)}，${esc(priceNote)}）</span>` : ''}
    </div>
  </div>`;
}

/* ------------------------------ 多序列折线 / 分组柱 / 堆叠占比 ------------------------------ */

/** 序列色调（对应 styles.css 的 .line-a/.dot-a/.swatch-a 等） */
const TONES = ['a', 'b', 'c', 'd', 'e'];

const isNum = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));

/**
 * 多序列折线图（内联 SVG，零依赖；tooltip 用 <title>）。
 * 每个序列独立绘制、独立图例：缺失点断开连线，不连线、不补 0、不前填。
 * @param {{series:Array<{key:string,label:string,points:Array<{x:string,y:number|null}>,tone?:string,dashed?:boolean}>,
 *          height?:number, yUnit?:string, yDigits?:number, ariaLabel?:string, toggles?:boolean}} cfg
 */
export function lineChart({ series = [], height = 240, yUnit = '', yDigits = 2, ariaLabel = '折线图', toggles = true }) {
  const list = (series || [])
    .filter((s) => s && Array.isArray(s.points))
    .map((s, i) => ({ ...s, tone: s.tone || TONES[i % TONES.length], points: s.points.filter((p) => p && p.x !== null && p.x !== undefined) }))
    .filter((s) => s.points.some((p) => isNum(p.y)));
  if (!list.length) return emptyState('暂无可绘制的真实数据点', '接口返回空序列时不画替代曲线');
  const w = 900;
  const h = Number(height);
  const pad = { l: 66, r: 62, t: 14, b: 26 };
  const xs = [...new Set(list.flatMap((s) => s.points.map((p) => String(p.x))))].sort();
  const xi = new Map(xs.map((v, i) => [v, i]));
  const X = (v) => pad.l + (xs.length === 1 ? (w - pad.l - pad.r) / 2 : (xi.get(String(v)) * (w - pad.l - pad.r)) / (xs.length - 1));
  const vals = list.flatMap((s) => s.points.filter((p) => isNum(p.y)).map((p) => Number(p.y)));
  let min = Math.min(...vals);
  let max = Math.max(...vals);
  if (min === max) { const padV = Math.abs(min || 1) * 0.02; min -= padV; max += padV; }
  const span = Math.max(1e-9, max - min);
  const Y = (v) => h - pad.b - ((Number(v) - min) / span) * (h - pad.t - pad.b) * 0.88 - (h - pad.t - pad.b) * 0.06;
  const yTicks = [0, 0.5, 1].map((f) => {
    const v = min + span * f;
    return `<g><line x1="${pad.l}" x2="${w - pad.r}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" class="grid-line"/>
      <text x="${pad.l - 6}" y="${(Y(v) + 3).toFixed(1)}" class="axis ta-end">${num(v, yDigits)}</text></g>`;
  }).join('');
  const groups = list.map((s) => {
    const segs = [];
    let cur = [];
    for (const p of s.points.slice().sort((a, b) => String(a.x).localeCompare(String(b.x)))) {
      if (!isNum(p.y)) { if (cur.length) segs.push(cur); cur = []; continue; }
      cur.push(`${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`);
    }
    if (cur.length) segs.push(cur);
    const lines = segs.map((seg) => (seg.length === 1
      ? `<circle cx="${seg[0].split(',')[0]}" cy="${seg[0].split(',')[1]}" r="2.8" class="dot dot-${s.tone}"/>`
      : `<polyline points="${seg.join(' ')}" class="line line-${s.tone} ${s.dashed ? 'line-dash' : ''}"/>`)).join('');
    const dots = s.points.filter((p) => isNum(p.y)).map((p) =>
      `<circle cx="${X(p.x).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="2.4" class="dot dot-${s.tone}"><title>${esc(p.x)}｜${esc(s.label)} ${num(p.y, yDigits)} ${esc(yUnit)}${p.title ? `｜${esc(p.title)}` : ''}</title></circle>`).join('');
    return `<g data-series="${s.key}">${lines}${dots}</g>`;
  }).join('');
  const useToggles = toggles && list.length > 1;
  const legend = list.map((s) => (useToggles
    ? `<label class="legend-item"><input type="checkbox" data-series-toggle="${s.key}" checked><i class="swatch swatch-${s.tone}"></i>${esc(s.label)}</label>`
    : `<span><i class="swatch swatch-${s.tone}"></i>${esc(s.label)}</span>`)).join('');
  return `
  <div class="chart" data-chart>
    <svg viewBox="0 0 ${w} ${h}" style="height:${h}px" preserveAspectRatio="none" role="img" aria-label="${esc(ariaLabel)}">
      ${yTicks}
      ${groups}
      <text x="${pad.l}" y="${h - 8}" class="axis">${esc(xs[0] || '')}</text>
      <text x="${w - pad.r}" y="${h - 8}" class="axis ta-end">${esc(xs[xs.length - 1] || '')}</text>
      ${yUnit ? `<text x="${pad.l - 6}" y="${pad.t - 2}" class="axis ta-end">${esc(yUnit)}</text>` : ''}
    </svg>
    <div class="legend legend-wrap">${legend}</div>
  </div>`;
}

/** 绑定多序列折线图的图例开关（checkbox → 隐藏/显示对应 <g data-series>） */
export function bindChartToggles(scope) {
  const root = scope && scope.querySelectorAll ? scope : document;
  root.querySelectorAll('[data-series-toggle]').forEach((box) => {
    if (box.dataset.bound === '1') return;
    box.dataset.bound = '1';
    const chart = box.closest('[data-chart]') || document;
    const group = chart.querySelector(`[data-series="${box.dataset.seriesToggle}"]`);
    const apply = () => { if (group) group.style.display = box.checked ? '' : 'none'; };
    box.addEventListener('change', apply);
    apply();
  });
}

/**
 * 分组柱状图（同一横轴、多序列并排）。
 * 缺失值为 null 时不画柱、不填 0；tooltip 用 <title>。
 */
export function groupedBarChart({ categories = [], series = [], height = 240, unit = '', yDigits = 2, ariaLabel = '分组柱状图' }) {
  const list = (series || []).filter((s) => s && Array.isArray(s.values))
    .map((s, i) => ({ ...s, tone: s.tone || TONES[i % TONES.length] }));
  const cats = (categories || []).map(String);
  const all = list.flatMap((s) => s.values.filter((v) => isNum(v)).map((v) => Number(v)));
  if (!cats.length || !list.length || !all.length) return emptyState('暂无对比数据', '任一侧缺失时该点为空，不用 0 或前值代替');
  const w = 900;
  const h = Number(height);
  const pad = { l: 66, r: 20, t: 14, b: 30 };
  const maxV = Math.max(1, ...all);
  const groupW = (w - pad.l - pad.r) / cats.length;
  const barW = Math.max(2, Math.min(20, (groupW - 8) / list.length));
  const Y = (v) => h - pad.b - (Number(v) / maxV) * (h - pad.t - pad.b);
  const bars = cats.map((c, ci) => list.map((s, si) => {
    const v = s.values[ci];
    if (!isNum(v)) return '';
    const x = pad.l + ci * groupW + (groupW - barW * list.length) / 2 + si * barW;
    return `<rect x="${x.toFixed(1)}" y="${Y(v).toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(0, h - pad.b - Y(v)).toFixed(1)}"
      class="bar bar-${s.tone}"><title>${esc(c)}｜${esc(s.label)} ${num(v, yDigits)} ${esc(unit)}</title></rect>`;
  }).join('')).join('');
  const yTicks = [0, 0.5, 1].map((f) => {
    const v = maxV * f;
    return `<g><line x1="${pad.l}" x2="${w - pad.r}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" class="grid-line"/>
      <text x="${pad.l - 6}" y="${(Y(v) + 3).toFixed(1)}" class="axis ta-end">${num(v, yDigits)}</text></g>`;
  }).join('');
  const tickEvery = Math.max(1, Math.ceil(cats.length / 8));
  const xLabels = cats.map((c, i) => (i % tickEvery === 0
    ? `<text x="${(pad.l + i * groupW + groupW / 2).toFixed(1)}" y="${h - 10}" class="axis" text-anchor="middle">${esc(c)}</text>` : '')).join('');
  return `
  <div class="chart" data-chart>
    <svg viewBox="0 0 ${w} ${h}" style="height:${h}px" preserveAspectRatio="none" role="img" aria-label="${esc(ariaLabel)}">
      ${yTicks}${bars}${xLabels}
    </svg>
    <div class="legend legend-wrap">${list.map((s) => `<span><i class="swatch swatch-${s.tone}"></i>${esc(s.label)}</span>`).join('')}</div>
  </div>`;
}

/**
 * 堆叠占比条（横向）。每行的占比以该行**实际披露**的分项之和为分母：
 * 未披露（null）的分项不参与占比、显示为「未披露」，不当成 0。
 * @param {{rows:Array<{label:string,values:Record<string,number|null>,note?:string,unit?:string}>,
 *          segments:Array<{key:string,label:string,tone?:string}>, unit?:string,
 *          emptyText?:string, emptyDetail?:string}} cfg
 */
export function stackedShareChart({ rows = [], segments = [], unit = '', emptyText = '暂无占比数据', emptyDetail = '' }) {
  const segs = segments.map((s, i) => ({ ...s, tone: s.tone || TONES[i % TONES.length] }));
  const list = (rows || []).filter((r) => r && r.values);
  if (!list.length || !segs.length) return emptyState(emptyText, emptyDetail);
  return `
  <div class="stack-rows">
    ${list.map((r) => {
      const parts = segs.map((s) => ({ ...s, value: isNum(r.values[s.key]) ? Number(r.values[s.key]) : null }));
      const sum = parts.reduce((a, p) => a + (p.value || 0), 0);
      const bars = sum > 0
        ? parts.map((p) => (p.value === null || p.value === 0 ? '' :
            `<span class="stack-seg seg-${p.tone}" style="width:${((p.value / sum) * 100).toFixed(3)}%" title="${esc(p.label)} ${((p.value / sum) * 100).toFixed(1)}%｜${num(p.value)} ${esc(unit)}"></span>`)).join('')
        : '';
      return `<div class="stack-row">
        <div class="stack-head"><span class="stack-label">${esc(r.label)}</span>
          <span class="stack-total">${sum > 0 ? `合计 ${num(sum)} ${esc(unit)}` : '无可用数值'}</span></div>
        <div class="stack-track" role="img" aria-label="${esc(r.label)}交易方式占比">${bars}</div>
        <div class="stack-keys">${parts.map((p) => `<span><i class="swatch swatch-${p.tone}"></i>${esc(p.label)} ${p.value === null ? '<span class="muted">未披露</span>' : `${sum > 0 ? ((p.value / sum) * 100).toFixed(1) : '0.0'}%（${num(p.value)} ${esc(unit)}）`}</span>`).join('')}</div>
        ${r.note ? `<p class="hint">${esc(r.note)}</p>` : ''}
      </div>`;
    }).join('')}
  </div>`;
}

/** 原始 JSON 只读展示块（用于接口原始返回留痕；不解析、不改写） */
export function jsonBlock(value, { max = 4000, label = '' } = {}) {
  let text;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  const body = String(text ?? '');
  const clipped = body.length > max ? `${body.slice(0, max)}\n…（已截断，共 ${body.length} 字符）` : body;
  return `${label ? `<p class="hint">${esc(label)}</p>` : ''}<pre class="code">${esc(clipped)}</pre>`;
}

/** 横向条形图 */
export function barChart({ items, valueKey = 'count', labelKey = 'label', unit = '', max: maxOverride = null }) {
  const data = items || [];
  if (!data.length) return emptyState('暂无数据');
  const max = maxOverride || Math.max(1, ...data.map((d) => Number(d[valueKey]) || 0));
  return `<div class="bars">${data.map((d) => {
    const v = Number(d[valueKey]) || 0;
    return `<div class="bar-row">
      <span class="bar-label" title="${esc(d[labelKey])}">${esc(truncate(d[labelKey], 22))}</span>
      <span class="bar-track"><i style="width:${((v / max) * 100).toFixed(1)}%"></i></span>
      <span class="bar-value">${num(v)}${esc(unit)}</span>
    </div>`;
  }).join('')}</div>`;
}

/** 交易日历热力格 */
export function calendarGrid(days) {
  const list = days || [];
  if (!list.length) return emptyState('暂无日历数据');
  return `<div class="cal-grid">${list.map((d) => `
    <div class="cal-cell cal-${esc(d.state)}" title="${esc(d.trade_date)}｜${esc(d.state_label || '')}">
      <span class="cal-day">${esc(String(d.trade_date).slice(5))}</span>
      <span class="cal-state">${esc((d.state_label || '').replace(/（.*?）/g, ''))}</span>
    </div>`).join('')}</div>
    <div class="legend legend-wrap">
      ${['traded', 'no_trade', 'closed', 'missing'].map((s) => `<span><i class="swatch swatch-${s}"></i>${esc(STATE_LABELS[s])}</span>`).join('')}
    </div>`;
}

/* ------------------------------ 抽屉 / 弹层 ------------------------------ */

export function drawer(title, bodyHtml, { wide = false } = {}) {
  return `
  <div class="drawer-backdrop" data-close-drawer></div>
  <aside class="drawer ${wide ? 'drawer-wide' : ''}" role="dialog" aria-label="${esc(title)}">
    <header class="drawer-head"><h3>${esc(title)}</h3><button class="btn btn-sm" type="button" data-close-drawer>关闭</button></header>
    <div class="drawer-body">${bodyHtml}</div>
  </aside>`;
}

export function toast(message, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.setAttribute('role', kind === 'danger' || kind === 'error' ? 'alert' : 'status');
  el.setAttribute('aria-live', kind === 'danger' || kind === 'error' ? 'assertive' : 'polite');
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.classList.add('toast-in'), 10);
  setTimeout(() => {
    el.classList.remove('toast-in');
    setTimeout(() => el.remove(), 300);
  }, 4200);
}

/* ------------------------------ 表单片段 ------------------------------ */

export function filtersBar(fields, values = {}) {
  const html = fields.map((f) => {
    const v = values[f.key] ?? '';
    if (f.type === 'select') {
      return `<label class="fld"><span>${esc(f.label)}</span><select data-filter="${esc(f.key)}">${selectOptionsHtml(
        f.options || [], v, { allLabel: f.allLabel || '全部', allValue: '' },
      )}</select></label>`;
    }
    if (f.type === 'datalist') {
      const listId = `filter-${f.key}-options`;
      return `<label class="fld"><span>${esc(f.label)}</span>
        <input type="search" data-filter="${esc(f.key)}" value="${esc(v)}" placeholder="${esc(f.placeholder || '')}" list="${esc(listId)}">
        ${datalistHtml(listId, f.options || [], v)}</label>`;
    }
    if (f.type === 'date') {
      return `<label class="fld"><span>${esc(f.label)}</span><input type="date" data-filter="${esc(f.key)}" value="${esc(v)}"></label>`;
    }
    return `<label class="fld"><span>${esc(f.label)}</span><input type="search" data-filter="${esc(f.key)}" value="${esc(v)}" placeholder="${esc(f.placeholder || '')}"></label>`;
  }).join('');
  return `<div class="filters" role="group" aria-label="筛选条件">${html}${values.__extra || ''}</div>`;
}

export function exportButtons(dataset, extraQuery = '') {
  const q = extraQuery ? `&${extraQuery}` : '';
  return `<span class="export-group">
    <a class="btn btn-sm" href="/api/v2/${dataset}?format=csv${q}" download>下载 CSV</a>
    <a class="btn btn-sm" href="/api/v2/${dataset}?format=xlsx${q}" download>下载 Excel</a>
  </span>`;
}

export function renderKvRows(obj) {
  return Object.entries(obj || {}).map(([k, v]) =>
    `<div class="kv-line"><span class="kv-k">${esc(k)}</span><span class="kv-v">${typeof v === 'string' ? esc(v) : `<code>${esc(JSON.stringify(v))}</code>`}</span></div>`
  ).join('');
}
