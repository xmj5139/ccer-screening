/**
 * 模块：CEA 市场（全国碳排放配额）
 * ============================================================================
 * 依据 docs/31-CEA扩展开发规范.md 与 docs/34-CEA阶段B交付任务.md「界面交付」。
 *
 * 口径纪律（所有页签共同遵守，不得为了好看而放宽）：
 *   1. **官方综合收盘价 close ≠ 全方式计算均价 computed_avg_price**：两个字段分开显示、
 *      分开图例，互不替代；close 是指定权重指数（2026 版 CEA25 权重 1），不是量加权均价。
 *   2. **来源历史价格（hiskline）与精确日统计（querySubStat）分层**：来源历史价格的
 *      volume_reference 是参考数量，绝不作为成交量/成交额绘制；没有金额的历史点
 *      不生成成交额与均价。
 *   3. **概览层（dailyov 舍入展示值）不与精确值混用**：概览单独成块，并展示跨层核对结果。
 *   4. **缺失即缺失**：取不到的字段显示「—」或空态并说明原因，不用 0、不用前值、
 *      不用模型推测填充。
 *   5. **意向 ≠ 成交**：交易意向不计入成交量/成交额。
 *   6. **日历三层证据分开**：正式公告 / 机器辅助列表 / 实际成交，异常独立告警。
 *   7. **临时情景算术**：成本情景只做算术、不保存参数、不自动建议购买。
 *
 * 页签状态放在 hash query（#/cea?tab=quote），支持二级钻取（trade=<id>｜doc=<id>）。
 */
import { api, setQuery, state } from '../app.js';
import {
  card, table, lineChart, bindChartToggles, comboChart, stackedShareChart, calendarGrid,
  loading, emptyState, errorState, noteBlock, chip, kv, drawer, toast, jsonBlock,
  num, pct, delta, esc, truncate, shortDate, dateTime, renderKvRows, filtersBar, exportButtons,
} from '../ui.js';
import { summaryBlock, summaryCoverageHint, sourceBlock, sourceLinkBlock } from '../platform.js';

/* ------------------------------ 标签字典 ------------------------------ */

const TABS = [
  { key: 'quote', label: '行情' },
  { key: 'policy', label: '政策配额' },
  { key: 'calendar', label: '履约日历' },
  { key: 'entities', label: '企业名录' },
  { key: 'intentions', label: '交易意向' },
  { key: 'clearing', label: '登记与清结算' },
  { key: 'scenario', label: '成本情景' },
  { key: 'research', label: '研报动态' },
  { key: 'sources', label: '来源与缺口' },
];

const SESSION_LABEL = { traded: '有成交', no_trade: '交易日无成交', missing: '数据暂缺' };
const CHECK_LABEL = { pass: '确定性核对通过', warn: '核对有提示', fail: '核对不通过', pending: '待自动核对' };
const CHECK_KIND = { pass: 'ok', warn: 'warn', fail: 'danger', pending: 'warn' };
const VERIFY_LABEL = {
  verified: '自动核验通过', insufficient: '证据不足', conflict: '来源冲突',
  unavailable: '暂未自动核验', unverified: '未自动核验',
};
const VERIFY_KIND = { verified: 'ok', insufficient: 'warn', conflict: 'danger', unavailable: 'muted', unverified: 'muted' };
const DOC_TYPE_LABEL = { policy: '政策', technical: '技术文件', research: '研报', news: '行业动态' };
const DOC_STATUS_LABEL = {
  formal: '现行正式', draft: '草案', consultation: '征求意见', historical: '历史文件', superseded: '已被替代',
};

/**
 * 时间字段展示纪律（本轮整理）：
 * 库里的 fetched_at / published_at 只应在**确实是时间**时按时间展示；
 * UUID、sha256、快照号一类不是时间的字段（例如历史错位写入的 content_hash）
 * 绝不冒充「成交时间 / 抓取时间」显示，一律回落到「—」。
 */
const TIME_LIKE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/;
export function ceaTimeText(v, dash = '—') {
  const s = String(v ?? '').trim();
  if (!s || !TIME_LIKE.test(s)) return dash;
  const d = new Date(s.length <= 10 ? `${s}T00:00:00Z` : s);
  return Number.isNaN(d.getTime()) ? dash : dateTime(s);
}
/** 值是否是「原始 JSON 调试内容」（旧数据可能把核对 JSON 错位写进 note 字段） */
function looksLikeRawJson(v) {
  const s = String(v ?? '').trim();
  return (s.startsWith('[') && s.endsWith(']')) || (s.startsWith('{') && s.endsWith('}'));
}
/** 中文说明优先；若该字段实际是原始 JSON（历史错位留痕），收进可折叠详情而不是直接铺在页面上 */
function noteOrRawDetail(text, summary = '原始留痕（JSON，调试内容）') {
  const s = String(text ?? '').trim();
  if (!s) return '';
  if (looksLikeRawJson(s)) {
    return `<details><summary>${esc(summary)}</summary>${jsonBlock(s, { max: 3000 })}</details>`;
  }
  return noteBlock(s);
}

/**
 * 文件「效力状态」展示（docs/35 第 8 条）：
 * 研报/行业动态是**公开资料**，不是规则：状态只能显示「已发布 / 研究观点」，
 * 不得显示「现行正式规则」这类规范性措辞；政策/技术文件仍按 doc_status 展示。
 */
function docStatusChip(r = {}) {
  const isResearch = r.doc_type === 'research' || r.doc_type === 'news';
  if (isResearch) {
    const label = (r.viewpoint === 'research_opinion' || r.viewpoint === 'institution_view') ? '研究观点' : '已发布';
    return chip(label, label === '研究观点' ? 'warn' : 'plain');
  }
  const label = DOC_STATUS_LABEL[r.doc_status] || r.doc_status;
  return chip(label, r.doc_status === 'formal' ? 'ok' : r.doc_status === 'superseded' ? 'muted' : 'warn');
}
const EVIDENCE_LABEL = {
  full_text: '已取得全文', partial: '部分正文', abstract_only: '仅有摘要', metadata_only: '仅元数据（未取得正文）',
};
const VIEWPOINT_LABEL = { research_opinion: '研究观点', market_news: '行业动态', institution_view: '机构观点', official_fact: '官方事实' };
const DIRECTION_LABEL = { buy: '买入', sell: '卖出', unknown: '未知（来源未标注）' };
const ENTITY_STATUS_LABEL = { new: '新增', existing: '存续', exit: '移出', unknown: '未标注' };
const EVENT_TYPE_LABEL = {
  allocation_plan_issued: '分配方案印发', list_published: '名录公布', preallocation: '预分配',
  adjustment: '配额调整', surrender_deadline: '清缴截止', carryover_deadline: '结转截止',
  data_report_deadline: '数据报送截止', other: '其他',
};
const EFFECTIVE_STATE_LABEL = {
  trading: '交易日', closed: '休市', holiday_machine_only: '仅机器列表标休市（未采信）', unknown: '证据不足',
};

/* ------------------------------ 小工具 ------------------------------ */

const qs = (obj) => new URLSearchParams(
  Object.fromEntries(Object.entries(obj || {}).filter(([, v]) => v !== null && v !== undefined && v !== ''))
).toString();

const has = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));

function checkChip(status) {
  if (!status) return '<span class="muted">—</span>';
  return chip(CHECK_LABEL[status] || status, CHECK_KIND[status] || '');
}

function verifyChip2(status) {
  if (!status) return '<span class="muted">—</span>';
  return chip(VERIFY_LABEL[status] || status, VERIFY_KIND[status] || 'muted');
}

function sessionChip(state2) {
  const kind = state2 === 'traded' ? 'ok' : state2 === 'missing' ? 'warn' : 'muted';
  return chip(SESSION_LABEL[state2] || state2 || '—', kind);
}

function caliberValue(caliber) {
  return caliber === 'close'
    ? { label: '官方综合收盘价', field: 'close', note: '官方指定权重指数收盘价，不是全方式量加权均价' }
    : { label: '全方式计算均价', field: 'computed_avg_price', note: '总成交额 ÷ 总成交量（程序计算）' };
}

/** CEA 指标块：口径与来源直接可见（不折叠），符合「信息层级优先」 */
function metric({ label, value, unit = '', sub = '', note = '', asOf = '', source = '', warn = false }) {
  return `<article class="metric ${warn ? 'metric-warn' : ''}">
    <div class="metric-head"><span class="metric-label">${esc(label)}</span>${warn ? '<span class="chip chip-warn">需关注</span>' : ''}</div>
    <div class="metric-value">${esc(value)}<span class="metric-unit">${esc(unit)}</span></div>
    <div class="metric-sub">${esc(sub)}</div>
    ${note ? `<div class="metric-note">${esc(note)}</div>` : ''}
    <div class="metric-foot"><span>截至 ${esc(shortDate(asOf))}</span><span>来源：${esc(truncate(source, 30))}</span></div>
  </article>`;
}

/** 服务端分页条：用 data-page-remote，避免与 app.js 的表格分页（data-page-prev/next）冲突 */
function remotePager({ total, limit, offset, unit = '条' }) {
  const page = Math.floor(offset / limit) + 1;
  const pages = Math.max(1, Math.ceil(total / limit));
  return `<div class="pager">
    <button class="btn btn-sm" data-page-remote="prev" ${offset <= 0 ? 'disabled' : ''}>上一页</button>
    <span class="pager-info">第 <b>${page}</b> / ${pages} 页 · 共 ${num(total)} ${esc(unit)}（每页 ${limit} 条，服务端分页）</span>
    <button class="btn btn-sm" data-page-remote="next" ${offset + limit >= total ? 'disabled' : ''}>下一页</button>
  </div>`;
}

function bindRemotePager(root, { limit, offset }) {
  root.querySelector('[data-page-remote="prev"]')?.addEventListener('click', () => setQuery({ offset: String(Math.max(0, offset - limit)) }));
  root.querySelector('[data-page-remote="next"]')?.addEventListener('click', () => setQuery({ offset: String(offset + limit) }));
}

/** 筛选器接线：切换筛选时重置服务端分页 offset */
function wireFilters(root, debounceKeys = []) {
  root.querySelectorAll('[data-f]').forEach((el) => {
    const key = el.dataset.f;
    const apply = () => {
      const value = el.type === 'checkbox' ? (el.checked ? 'true' : '') : el.value;
      setQuery({ [key]: value, offset: null });
    };
    if (el.type === 'search' && debounceKeys.includes(key)) {
      let timer = null;
      el.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(apply, 420); });
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(timer); apply(); } });
    } else {
      el.addEventListener('change', apply);
    }
  });
  root.querySelector('[data-reset]')?.addEventListener('click', () => setQuery({
    from: null, to: null, q: null, sector: null, year: null, doc_type: null, doc_status: null,
    province: null, list_year: null, status: null, direction: null, quota_year: null, viewpoint: null,
    issuer: null, day_type: null, include_attachments: null, check_status: null, verification_status: null,
    offset: null, trade: null, doc: null, range_days: null,
  }));
}

function exportLinks(dataset, query, label = '') {
  const q = qs({ dataset, ...query });
  return `<span class="export-group">${label ? `<span class="muted">${esc(label)}</span>` : ''}
    <a class="btn btn-sm" href="/api/v2/cea/export?${q}&format=csv" download>下载 CSV</a>
    <a class="btn btn-sm" href="/api/v2/cea/export?${q}&format=json" download>下载 JSON</a>
  </span>`;
}

/** 深链钻取的 hash 参数清理：关闭抽屉时把 trade/doc 参数移除，不触发重新渲染 */
function clearDrill(...keys) {
  const hash = location.hash || '';
  const [path, queryPart] = hash.split('?');
  if (!queryPart) return;
  const params = new URLSearchParams(queryPart);
  let changed = false;
  for (const k of keys) if (params.has(k)) { params.delete(k); changed = true; }
  if (changed) history.replaceState(null, '', `${path}?${params.toString()}`);
}
if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-close-drawer]')) clearDrill('trade', 'doc');
  });
}

/* ------------------------------ 入口 ------------------------------ */

export async function renderCea(root, route) {
  const q = route.query || {};
  const tab = TABS.some((t) => t.key === q.tab) ? q.tab : 'quote';
  root.innerHTML = `
    <div class="tabs">${TABS.map((t) => `<a class="tab ${t.key === tab ? 'active' : ''}" href="#/cea?tab=${t.key}">${esc(t.label)}</a>`).join('')}</div>
    <div id="cea-body">${loading()}</div>`;
  const body = document.getElementById('cea-body');
  try {
    if (tab === 'quote') await renderQuote(body, q);
    else if (tab === 'policy') await renderPolicy(body, q);
    else if (tab === 'calendar') await renderCalendar(body, q);
    else if (tab === 'entities') await renderEntities(body, q);
    else if (tab === 'intentions') await renderIntentions(body, q);
    else if (tab === 'clearing') await renderClearing(body, q);
    else if (tab === 'scenario') await renderScenario(body, q);
    else if (tab === 'research') await renderResearch(body, q);
    else await renderSources(body);
  } catch (e) {
    // 400/403/503 一律显示后端返回的中文错误正文
    body.innerHTML = errorState(e);
  }
}

/* ==================================================================== */
/*  一、行情                                                            */
/* ==================================================================== */

async function renderQuote(body, q) {
  const from = q.from || '';
  const to = q.to || '';
  const checkStatus = q.check_status || '';
  const verifyStatus = q.verification_status || '';
  const [overview, history, trade, summary] = await Promise.all([
    api('/api/v2/cea/overview'),
    api(`/api/v2/cea/price-history?${qs({ from, to, limit: 400 })}`),
    api(`/api/v2/cea/trade?${qs({ from, to, limit: 200, check_status: checkStatus, verification_status: verifyStatus })}`),
    api(`/api/v2/cea/summary?${qs({ from, to })}`),
  ]);

  const latest = overview.latest_day;
  const counts = overview.counts || {};
  const precise = (history.precise_daily || []).filter((p) => has(p.total_volume));
  const ovRow = overview.latest_overview || null;

  const priceSeries = [
    {
      key: 'source_history',
      label: '来源历史价格（hiskline，元/吨）',
      tone: 'c',
      dashed: true,
      points: (history.source_history || []).map((r) => ({
        x: r.trade_date,
        y: r.close,
        title: has(r.volume_reference) ? `参考数量 ${num(r.volume_reference)} 吨（不是成交量）` : '来源未给参考数量',
      })),
    },
    {
      key: 'precise_close',
      label: '精确日收盘（querySubStat，元/吨）',
      tone: 'a',
      points: (history.precise_daily || []).map((r) => ({ x: r.trade_date, y: r.close })),
    },
  ];

  const mixRows = (rows, keys, label, note) => {
    const sum = {};
    let any = false;
    for (const k of keys) {
      const vals = rows.map((r) => r[k]).filter((v) => has(v)).map(Number);
      sum[k] = vals.length ? vals.reduce((a, b) => a + b, 0) : null;
      if (vals.length) any = true;
    }
    return any ? { label, values: sum, note } : null;
  };
  const mixSegments = [
    { key: 'listed_volume', label: '挂牌协议', tone: 'a' },
    { key: 'block_volume', label: '大宗协议', tone: 'b' },
    { key: 'auction_volume', label: '单向竞价', tone: 'c' },
  ];
  const turnSegments = [
    { key: 'listed_turnover', label: '挂牌协议', tone: 'a' },
    { key: 'block_turnover', label: '大宗协议', tone: 'b' },
    { key: 'auction_turnover', label: '单向竞价', tone: 'c' },
  ];
  const rangeLabel = `所选区间合计（${from || '最早'} ~ ${to || '最新'}，${trade.rows.length} 个交易日）`;
  const mixNote = '只累计官方实际披露的分项；某日未披露该交易方式时不计入合计（显示「未披露」，不当成 0）。官方明确「无」的记录为 0。';
  const volumeMixRows = [
    mixRows(trade.rows, mixSegments.map((s) => s.key), rangeLabel, mixNote),
    latest ? mixRows([latest], mixSegments.map((s) => s.key), `最新交易日 ${latest.trade_date}`, mixNote) : null,
  ].filter(Boolean);
  const turnoverMixRows = [
    mixRows(trade.rows, turnSegments.map((s) => s.key), rangeLabel, mixNote),
    latest ? mixRows([latest], turnSegments.map((s) => s.key), `最新交易日 ${latest.trade_date}`, mixNote) : null,
  ].filter(Boolean);

  body.innerHTML = `
  <div class="filters">
    <label class="fld"><span>明细起</span><input type="date" data-f="from" value="${esc(from)}"></label>
    <label class="fld"><span>明细止</span><input type="date" data-f="to" value="${esc(to)}"></label>
    <label class="fld"><span>确定性核对</span><select data-f="check_status"><option value="">全部</option>
      ${['pass', 'warn', 'fail'].map((k) => `<option value="${k}" ${checkStatus === k ? 'selected' : ''}>${esc(CHECK_LABEL[k])}</option>`).join('')}</select></label>
    <label class="fld"><span>AI 证据核验</span><select data-f="verification_status"><option value="">全部</option>
      ${['verified', 'insufficient', 'conflict', 'unavailable', 'unverified'].map((k) => `<option value="${k}" ${verifyStatus === k ? 'selected' : ''}>${esc(VERIFY_LABEL[k])}</option>`).join('')}</select></label>
    <span class="fld-actions">
      ${exportLinks('trade', { from, to }, '行情')}
      ${exportLinks('price_history', { from, to }, '价格历史')}
      <button class="btn btn-sm" data-reset>重置</button>
    </span>
  </div>

  <div class="callout">
    <b>两个价格口径必须分开看</b>
    <p><b>官方综合收盘价（close）</b>：${esc(overview.calibers?.close || '官方指定权重指数收盘价')}。</p>
    <p><b>全方式计算均价（computed_avg_price）</b>：${esc(overview.calibers?.computed_avg_price || '总成交额 ÷ 总成交量（程序计算）')}。</p>
    <p class="hint">${esc(overview.disclaimer || '')}</p>
  </div>

  ${latest ? `
  <div class="metrics">
    ${metric({
      label: '官方综合收盘价（close）', value: num(latest.close, 2), unit: '元/吨',
      sub: `指定权重指数（${latest.price_regime || '口径未标注'}），非全方式均价`,
      note: '官方综合行情收盘价，不用于计算成交额；与下方计算均价口径不同，不互相替代。',
      asOf: latest.trade_date, source: `官方行情 JSON（${latest.source_code || 'queryMarketByDate'}）`,
    })}
    ${metric({
      label: '全方式计算均价', value: has(latest.computed_avg_price) ? num(latest.computed_avg_price, 2) : '—', unit: '元/吨',
      sub: has(latest.computed_avg_price) ? '总成交额 ÷ 总成交量（程序计算）' : '当日缺成交额或成交量为 0，按规范不计算（不用 0 代替）',
      note: '程序计算值，绝不覆盖官方公布值。',
      asOf: latest.trade_date, source: 'cea_trade_daily（querySubStat 精确聚合）',
    })}
    ${metric({
      label: '总成交量', value: num(latest.total_volume), unit: '吨',
      sub: `挂牌 ${num(latest.listed_volume)}｜大宗 ${num(latest.block_volume)}｜单向竞价 ${num(latest.auction_volume)}`,
      note: '官方披露的全方式合计（吨）；未披露的分项显示「—」。',
      asOf: latest.trade_date, source: 'querySubStat（COMCEA 三行聚合）',
    })}
    ${metric({
      label: '总成交额', value: num(latest.total_turnover), unit: '元',
      sub: `年累计成交量 ${num(latest.year_volume)} 吨｜历史累计 ${num(latest.lifetime_volume)} 吨`,
      note: '官方披露的全方式合计（元）；缺失交易日不补 0。',
      asOf: latest.trade_date, source: 'querySubStat（COMCEA 三行聚合）',
    })}
    ${metric({
      label: '涨跌幅', value: has(latest.change_pct) ? pct(latest.change_pct) : '—', unit: '',
      sub: `昨收 ${num(latest.prev_close, 2)} 元/吨｜开 ${num(latest.open, 2)}｜高 ${num(latest.high, 2)}｜低 ${num(latest.low, 2)}`,
      note: '官方公布的涨跌幅，基于官方综合收盘价，不是计算均价的变化率。',
      asOf: latest.trade_date, source: '官方行情 JSON',
    })}
    ${metric({
      label: '数据截止日', value: shortDate(overview.data_as_of), unit: '',
      sub: `系统已入库 ${num(counts.trade_days)} 个交易日｜概览层 ${num(counts.overview_days)} 天｜来源通道留痕 ${num(counts.quote_channels)} 条`,
      note: '数据截止日 = 已入库行情中的最新交易日；不等于「今天有行情」，也不代表全国全部交易日都已收录。',
      asOf: overview.data_as_of, source: 'cea_trade_daily / cea_daily_overview',
    })}
    ${metric({
      label: '采集与核验状态', value: num(counts.trade_verified), unit: '条已核验',
      sub: `核对通过 ${num(counts.trade_ok)}｜有提示 ${num(counts.trade_warn)}｜不通过 ${num(counts.trade_fail)}｜待核对 ${num(counts.trade_unverified)}`,
      note: '确定性核对只标注差异、不改写官方数值；AI 核验表示证据一致性，不是独立审计。',
      asOf: overview.data_as_of, source: '自动核对 + 自动核验任务',
      warn: Number(counts.trade_fail || 0) > 0,
    })}
  </div>` : emptyState(
    '尚未采集到 CEA 真实行情',
    '没有真实来源数据时不显示任何替代数字（不填 0、不用估算值）。可在后台「CEA 配额市场」触发采集。',
    `已入库交易日 ${num(counts.trade_days)} 个；未结清缺口 ${num(counts.open_gaps)} 项（缺口台账见「来源与缺口」页签）`
  )}

  ${latest ? card({
    title: '最新交易日的采集与来源状态',
    subtitle: `交易日 ${esc(latest.trade_date)}｜状态与来源均可回溯到快照`,
    body: kv([
      ['交易日状态', sessionChip(latest.session_state)],
      ['确定性核对', checkChip(latest.check_status)],
      ['AI 证据核验', `${verifyChip2(latest.verification_status)}${latest.verification_note ? ` <span class="muted">${esc(truncate(latest.verification_note, 120))}</span>` : ''}`],
      ['行情口径版本', esc(latest.price_regime || '—')],
      ['数据截止日', esc(latest.data_as_of || '—')],
      ['官方发布时间', esc(latest.published_at || '—')],
      ['抓取时间', esc(ceaTimeText(latest.fetched_at))],
      ['来源链接', latest.source_url ? `<a class="link" href="${esc(latest.source_url)}" target="_blank" rel="noreferrer noopener">${esc(truncate(latest.source_url, 70))}</a>` : '—'],
      ['来源快照', esc(latest.snapshot_id || '—')],
      ['修订次数', latest.revision > 1 ? chip(`第 ${latest.revision} 版（历史值保留在修订留痕中）`, 'warn') : '1'],
    ]) + noteBlock('点击下方明细行的日期可查看该交易日的来源分层（精确通道 / 概览通道）、概览跨层核对与确定性核对明细。'),
  }) : ''}

  <div class="grid-2">
    ${card({
      title: '价格历史（两个来源层，分开图例）',
      subtitle: `来源历史价格 ${num(history.source_history_count)} 点（${esc(history.earliest_history || '—')} ~ ${esc(history.latest_history || '—')}）｜精确日统计 ${num(history.precise_daily_count)} 点（最新 ${esc(history.latest_precise || '—')}）`,
      actions: exportLinks('price_history', { from, to }),
      body: lineChart({ series: priceSeries, height: 260, yUnit: '元/吨', yDigits: 2, ariaLabel: 'CEA 价格历史' })
        + noteBlock('来源历史价格（hiskline）中的 volume_reference 是参考数量，不是全国全方式成交量：本图不绘制成交量或成交额，也没有金额的历史点不生成均价。')
        + noteBlock(history.caliber_note || '')
        + `<p class="hint">${esc(history.min_points_note || '')}</p>`
        + ((history.snapshot_sources || []).length ? `<details><summary>来源历史价格快照来源（${history.snapshot_sources.length}）</summary>
            <table class="grid grid-sm"><thead><tr><th>通道</th><th>来源</th><th>抓取时间</th><th>快照</th></tr></thead><tbody>
            ${history.snapshot_sources.slice(0, 10).map((s) => `<tr><td>${esc(s.channel)}</td>
              <td>${s.source_url ? `<a class="link" href="${esc(s.source_url)}" target="_blank" rel="noreferrer noopener">${esc(truncate(s.source_url, 46))}</a>` : '—'}</td>
              <td>${esc(ceaTimeText(s.fetched_at))}</td><td class="muted">${esc(s.snapshot_id || '—')}</td></tr>`).join('')}
            </tbody></table></details>` : ''),
    })}
    ${card({
      title: '概览层（官方舍入展示值）与精确值对照',
      subtitle: ovRow ? `概览交易日 ${esc(ovRow.trade_date)}｜只使用官方概览通道（dailyov）的舍入文本，不覆盖精确值` : '尚未采集到官方概览层数据',
      body: ovRow ? `
        ${kv([
          ['概览收盘价', `${num(ovRow.close, 2)} 元/吨`],
          ['今日数量（原文）', esc(ovRow.today_qty_text || '—')],
          ['今日数量（换算近似）', has(ovRow.today_qty_approx) ? `${num(ovRow.today_qty_approx)} 吨（按展示精度换算，仅供核对）` : '—'],
          ['今日金额（原文）', esc(ovRow.today_amt_text || '—')],
          ['今日金额（换算近似）', has(ovRow.today_amt_approx) ? `${num(ovRow.today_amt_approx)} 元` : '—'],
          ['累计数量（原文）', esc(ovRow.total_qty_text || '—')],
          ['累计金额（原文）', esc(ovRow.total_amt_text || '—')],
          ['概览抓取时间', esc(ceaTimeText(ovRow.fetched_at))],
        ])}
        <h5>跨层核对（概览舍入值 vs 精确值）</h5>
        ${(ovRow.cross_checks || []).length ? `<table class="grid grid-sm"><thead><tr><th>字段</th><th>概览原文</th><th>概览换算</th><th>精确值</th><th>差异</th><th>容差</th><th>结论</th></tr></thead><tbody>
          ${(ovRow.cross_checks || []).map((c) => `<tr><td>${esc(c.field)}</td><td>${esc(c.overview_text || '—')}</td>
            <td class="ta-r">${num(c.overview_approx)}</td><td class="ta-r">${num(c.precise)}</td><td class="ta-r">${num(c.diff)}</td>
            <td class="ta-r">${num(c.tolerance)}</td>
            <td>${c.within_rounding ? chip('舍入一致', 'ok') : chip('超出舍入容差（两侧都保留）', 'warn')}
              <div class="muted">${esc(c.note || '')}</div></td></tr>`).join('')}
          </tbody></table>` : '<p class="muted">该概览日尚未形成跨层核对项（可能缺少同日精确值）。</p>'}
        ${noteOrRawDetail(ovRow.note, '概览层原始留痕（JSON，调试内容；中文核对结论见上表）')}`
        : emptyState('尚无概览层数据', '官方概览通道（dailyov.json）未采集到数据时留空，不用精确值冒充概览值。'),
    })}
  </div>

  <div class="grid-2">
    ${card({
      title: '成交量（柱）与全方式计算均价（线）',
      subtitle: `仅使用精确日统计（querySubStat）：${num(precise.length)} 个有成交量的交易日`,
      body: precise.length
        ? comboChart({
            points: precise.map((p) => ({ trade_date: p.trade_date, volume: p.total_volume, avg_price: p.computed_avg_price })),
            height: 250, valueLabel: '总成交量', valueUnit: '吨',
            priceLabel: '全方式计算均价', priceUnit: '元/吨', priceDigits: 2,
            ariaLabel: 'CEA 成交量与全方式计算均价',
          }) + noteBlock('只画精确通道（querySubStat）的 total_volume 与 computed_avg_price；没有成交额的历史点不生成均价（折线断开），缺失交易日不补 0。')
        : emptyState('所选区间没有精确日统计', '来源历史价格层不含成交量与金额，不能用于绘制本图。'),
    })}
    ${card({
      title: '成交额（柱，仅精确日统计）',
      subtitle: `仅使用 precise_daily 的 total_turnover：${num(precise.filter((p) => has(p.total_turnover)).length)} 个有金额的交易日`,
      body: precise.filter((p) => has(p.total_turnover)).length
        ? comboChart({
            points: precise.filter((p) => has(p.total_turnover)).map((p) => ({ trade_date: p.trade_date, volume: p.total_turnover })),
            height: 250, showPrice: false, valueLabel: '总成交额', valueUnit: '元', ariaLabel: 'CEA 成交额',
          }) + noteBlock('金额只来自精确日统计；来源历史价格序列没有金额，因此不生成任何成交额点。')
        : emptyState('所选区间没有成交额数据', '没有金额的历史点不生成成交额。'),
    })}
  </div>

  <div class="grid-2">
    ${card({
      title: '交易方式占比（成交量）',
      subtitle: '挂牌协议 / 大宗协议 / 单向竞价的成交量占比',
      body: stackedShareChart({ rows: volumeMixRows, segments: mixSegments, unit: '吨', emptyText: '暂无可比的分方式成交量', emptyDetail: '官方未披露分方式成交量时留空，不用总量拆分估算。' })
        + noteBlock('占比分母是各行「实际披露分项」之和；未披露的分项不计入分母，也不显示为 0。'),
    })}
    ${card({
      title: '交易方式占比（成交额）',
      subtitle: '挂牌协议 / 大宗协议 / 单向竞价的成交额占比',
      body: stackedShareChart({ rows: turnoverMixRows, segments: turnSegments, unit: '元', emptyText: '暂无可比的分方式成交额', emptyDetail: '官方未披露分方式成交额时留空，不用总量拆分估算。' })
        + noteBlock('0 表示官方明确「无」；「未披露」表示来源没有该字段，两者不混用。'),
    })}
  </div>

  ${card({
    title: '区间汇总（实际有数据的交易日）',
    subtitle: `${esc(summary.from || '—')} ~ ${esc(summary.to || '—')}｜交易日 ${num(summary.trading_days)} 天（其中无成交 ${num(summary.no_trade_days)} 天）`,
    body: kv([
      ['区间总成交量', has(summary.total_volume) ? `${num(summary.total_volume)} 吨` : '—（区间内无成交数据）'],
      ['区间总成交额', has(summary.total_turnover) ? `${num(summary.total_turnover)} 元` : '—'],
      ['区间量加权均价', has(summary.vwap) ? `${num(summary.vwap, 2)} 元/吨（区间总成交额 ÷ 区间总成交量，程序计算）` : '—'],
      ['官方综合收盘价均值', has(summary.avg_composite_close) ? `${num(summary.avg_composite_close, 2)} 元/吨（简单平均，非量加权）` : '—'],
      ['官方综合收盘价区间', has(summary.min_close) ? `${num(summary.min_close, 2)} ~ ${num(summary.max_close, 2)} 元/吨` : '—'],
      ['最新年累计成交量', has(summary.latest_year_volume) ? `${num(summary.latest_year_volume)} 吨` : '—'],
      ['最新历史累计成交量', has(summary.latest_lifetime_volume) ? `${num(summary.latest_lifetime_volume)} 吨` : '—'],
    ]) + noteBlock(summary.caliber_note || ''),
  })}

  ${card({
    title: '行情明细',
    subtitle: `共 ${num(trade.total)} 条（本页 ${trade.rows.length} 条）｜点击日期查看来源钻取`,
    actions: exportLinks('trade', { from, to }),
    body: table({
      rows: trade.rows || [],
      pageSize: 20,
      rowAttrs: (r) => `data-cea-trade="${esc(r.id)}"`,
      columns: [
        { key: 'trade_date', label: '交易日期', render: (r) => `<button class="link" data-cea-trade="${esc(r.id)}">${esc(r.trade_date)}</button>` },
        { key: 'session_state', label: '状态', render: (r) => sessionChip(r.session_state) },
        { key: 'close', label: '官方综合收盘价', unit: '元/吨', align: 'right', render: (r) => num(r.close, 2) },
        { key: 'computed_avg_price', label: '全方式计算均价', unit: '元/吨', align: 'right', render: (r) => (has(r.computed_avg_price) ? num(r.computed_avg_price, 2) : '<span class="muted">—</span>') },
        { key: 'change_pct', label: '涨跌幅', unit: '%', align: 'right', render: (r) => (has(r.change_pct) ? delta(r.change_pct) : '—') },
        { key: 'listed_volume', label: '挂牌量', unit: '吨', align: 'right', render: (r) => num(r.listed_volume) },
        { key: 'listed_turnover', label: '挂牌额', unit: '元', align: 'right', render: (r) => num(r.listed_turnover) },
        { key: 'block_volume', label: '大宗量', unit: '吨', align: 'right', render: (r) => num(r.block_volume) },
        { key: 'block_turnover', label: '大宗额', unit: '元', align: 'right', render: (r) => num(r.block_turnover) },
        { key: 'auction_volume', label: '竞价量', unit: '吨', align: 'right', render: (r) => num(r.auction_volume) },
        { key: 'auction_turnover', label: '竞价额', unit: '元', align: 'right', render: (r) => num(r.auction_turnover) },
        { key: 'total_volume', label: '总成交量', unit: '吨', align: 'right', render: (r) => num(r.total_volume) },
        { key: 'total_turnover', label: '总成交额', unit: '元', align: 'right', render: (r) => num(r.total_turnover) },
        { key: 'check_status', label: '确定性核对', render: (r) => checkChip(r.check_status) },
        { key: 'verification_status', label: 'AI 证据核验', render: (r) => verifyChip2(r.verification_status) },
        { key: 'source_url', label: '来源', render: (r) => (r.source_url ? `<a class="link" href="${esc(r.source_url)}" target="_blank" rel="noreferrer noopener">官方来源</a>` : '—') },
      ],
      emptyText: '所选区间没有行情记录',
      emptyDetail: '缺失交易日不生成 0 值行；可在后台「CEA 配额市场 → 采集」按渠道补采。',
    }),
  })}`;

  wireFilters(body, []);
  body.addEventListener('click', (e) => {
    const t = e.target.closest('[data-cea-trade]');
    if (!t || !t.dataset.ceaTrade) return;
    // 先关掉已打开的抽屉，避免深链重渲染后叠加出第二个抽屉
    document.querySelector('.drawer-backdrop')?.remove();
    document.querySelector('.drawer')?.remove();
    setQuery({ trade: t.dataset.ceaTrade });
  });
  bindChartToggles(body);
  if (q.trade) await openTradeDrawer(q.trade);
}

/* ------------------------------ 行情来源钻取 ------------------------------ */

async function openTradeDrawer(id) {
  let d;
  try {
    d = await api(`/api/v2/cea/trade/${encodeURIComponent(id)}`);
  } catch (e) {
    toast(e.body?.message || e.body?.error || e.message, 'danger');
    return;
  }
  const row = d.row || {};
  const snap = d.snapshot;
  const ov = d.overview;
  const sources = d.quote_sources || [];
  const checks = d.checks || [];
  const revisions = d.revisions || [];
  const cal = caliberValue('close');
  const cal2 = caliberValue('computed_avg_price');

  document.body.insertAdjacentHTML('beforeend', drawer(`CEA 行情来源钻取：${row.trade_date || id}`, `
    <div class="drawer-section">
      <div class="chip-row">${sessionChip(row.session_state)}${checkChip(row.check_status)}${verifyChip2(row.verification_status)}</div>
      ${kv([
        ['品种 / 市场范围', `${esc(row.instrument || '—')}｜${esc(row.market_scope || '—')}`],
        ['行情口径版本', esc(row.price_regime || '—')],
        ['交易日期', esc(row.trade_date || '—')],
        ['官方综合收盘价', `${num(row.close, 2)} 元/吨 <span class="muted">（${esc(cal.note)}）</span>`],
        ['全方式计算均价', has(row.computed_avg_price)
          ? `${num(row.computed_avg_price, 2)} 元/吨 <span class="muted">（${esc(cal2.note)}）</span>`
          : '<span class="muted">—（无成交额或成交量为 0 时不计算，不用 0 代替）</span>'],
        ['开盘 / 最高 / 最低 / 昨收', `${num(row.open, 2)} / ${num(row.high, 2)} / ${num(row.low, 2)} / ${num(row.prev_close, 2)} 元/吨`],
        ['涨跌幅', has(row.change_pct) ? delta(row.change_pct) : '—'],
        ['挂牌协议（量 / 额）', `${num(row.listed_volume)} 吨 / ${num(row.listed_turnover)} 元`],
        ['大宗协议（量 / 额）', `${num(row.block_volume)} 吨 / ${num(row.block_turnover)} 元`],
        ['单向竞价（量 / 额）', `${num(row.auction_volume)} 吨 / ${num(row.auction_turnover)} 元`],
        ['总成交量 / 总成交额', `${num(row.total_volume)} 吨 / ${num(row.total_turnover)} 元`],
        ['年累计（量 / 额）', `${num(row.year_volume)} 吨 / ${num(row.year_turnover)} 元`],
        ['历史累计（量 / 额）', `${num(row.lifetime_volume)} 吨 / ${num(row.lifetime_turnover)} 元`],
        ['数据截止日', esc(row.data_as_of || '—')],
        ['官方发布 / 抓取时间', `${esc(row.published_at || '—')} / ${esc(ceaTimeText(row.fetched_at))}`],
        ['来源 URL', row.source_url ? `<a class="link" href="${esc(row.source_url)}" target="_blank" rel="noreferrer noopener">${esc(truncate(row.source_url, 66))}</a>` : '—'],
        ['内容哈希', row.content_hash ? `<code>${esc(String(row.content_hash).slice(0, 24))}…</code>` : '—'],
      ])}
    </div>

    <div class="drawer-section">
      <h4>来源快照</h4>
      ${snap ? `${kv([
        ['快照 ID', `<code>${esc(snap.id)}</code>`],
        ['快照 URL', snap.url ? `<a class="link" href="${esc(snap.url)}" target="_blank" rel="noreferrer noopener">${esc(truncate(snap.url, 66))}</a>` : '—'],
        ['HTTP 状态', esc(snap.http_status ?? '—')],
        ['抓取时间', esc(ceaTimeText(snap.fetched_at))],
        ['字节数', snap.content_bytes ? `${num(snap.content_bytes)} 字节` : '—'],
        ['解析质量', esc(snap.parse_quality || '—')],
        ['解析说明', esc(snap.parse_note || '—')],
        ['错误', snap.error ? `<span class="muted">${esc(snap.error)}</span>` : '无'],
      ])}` : '<p class="muted">该行情行未关联来源快照（无法回溯原文时不补造快照）。</p>'}
    </div>

    <div class="drawer-section">
      <h4>行情来源分层（同一交易日可能有多个通道）</h4>
      ${sources.length ? `<table class="grid grid-sm"><thead><tr><th>通道</th><th>层级</th><th>来源</th><th>抓取时间</th><th>快照</th></tr></thead><tbody>
        ${sources.map((s) => `<tr>
          <td>${esc(s.channel)}</td>
          <td>${Number(s.is_precise) === 1 ? chip('精确依据', 'ok') : Number(s.is_overview) === 1 ? chip('仅概览/舍入展示', 'warn') : chip('OHLC 通道', 'muted')}</td>
          <td>${s.source_url ? `<a class="link" href="${esc(s.source_url)}" target="_blank" rel="noreferrer noopener">${esc(truncate(s.source_url, 40))}</a>` : '—'}
            <div class="muted">${esc(s.note || '')}</div></td>
          <td>${esc(ceaTimeText(s.fetched_at))}</td>
          <td class="muted">${esc(s.snapshot_id || '—')}</td></tr>`).join('')}
        </tbody></table>
        <p class="hint">概览通道（dailyov）只提供舍入展示值，不作为精确成交量/额依据；精确通道为 querySubStat 的 COMCEA 聚合。</p>`
        : '<p class="muted">没有该交易日的来源通道留痕。</p>'}
    </div>

    <div class="drawer-section">
      <h4>概览层跨层核对</h4>
      ${ov ? `${kv([
        ['概览交易日', esc(ov.trade_date)],
        ['概览收盘价', `${num(ov.close, 2)} 元/吨`],
        ['今日数量（原文）', esc(ov.today_qty_text || '—')],
        ['今日金额（原文）', esc(ov.today_amt_text || '—')],
        ['来源 URL', ov.source_url ? `<a class="link" href="${esc(ov.source_url)}" target="_blank" rel="noreferrer noopener">${esc(truncate(ov.source_url, 60))}</a>` : '—'],
      ])}
      ${(ov.cross_checks || []).length ? `<ul class="bullets">${(ov.cross_checks || []).map((c) => `<li>${c.within_rounding ? '✓' : '✗'} <b>${esc(c.field)}</b>：概览「${esc(c.overview_text || '—')}」vs 精确 ${num(c.precise)}（差异 ${num(c.diff)}，容差 ${num(c.tolerance)}）<div class="muted">${esc(c.note || '')}</div></li>`).join('')}</ul>`
        : '<p class="muted">无跨层核对项。</p>'}
      ${noteOrRawDetail(ov.note, '概览层原始留痕（JSON，调试内容；中文核对结论见上）')}`
        : '<p class="muted">该交易日没有概览层记录。</p>'}
    </div>

    <div class="drawer-section">
      <h4>确定性核对（${checks.length}）</h4>
      ${checks.length ? `<table class="grid grid-sm"><thead><tr><th>检查</th><th>结论</th><th>期望</th><th>实际</th><th>说明</th><th>时间</th></tr></thead><tbody>
        ${checks.map((c) => `<tr><td>${esc(c.label || c.check_key)}</td>
          <td>${c.ok ? chip('通过', 'ok') : chip(CHECK_LABEL[c.severity] || '未通过', c.severity === 'fail' ? 'danger' : 'warn')}</td>
          <td class="muted">${esc(c.expected ?? '—')}</td><td class="muted">${esc(c.actual ?? '—')}</td>
          <td>${esc(c.detail || '')}</td><td class="muted">${esc(dateTime(c.checked_at))}</td></tr>`).join('')}
        </tbody></table>` : '<p class="muted">没有核对记录。</p>'}
    </div>

    <div class="drawer-section">
      <h4>修订留痕（${revisions.length}）</h4>
      ${revisions.length ? `<ul class="bullets">${revisions.map((r) => `<li>${esc(r.field)}：<span class="muted">${esc(r.old_value ?? '—')} → ${esc(r.new_value ?? '—')}</span>（${esc(r.reason || '')}）<div class="muted">${esc(dateTime(r.revised_at))}｜${esc(r.revised_by || '系统')}</div></li>`).join('')}</ul>`
        : '<p class="muted">无修订记录。官方改数时旧值不会被静默覆盖。</p>'}
    </div>

    <div class="drawer-section">
      <h4>口径说明</h4>
      <p class="prose">${esc(d.caliber_note || '')}</p>
      <details><summary>解析出的原文键值（raw_fields，留痕用）</summary>${jsonBlock(row.raw_fields || {}, { max: 3000 })}</details>
    </div>
  `, { wide: true }));
}

/* ==================================================================== */
/*  二、政策配额                                                        */
/* ==================================================================== */

async function renderPolicy(body, q) {
  const sector = q.sector || '';
  const year = q.year || '';
  const docType = q.doc_type || '';
  const docStatus = q.doc_status || '';
  const keyword = q.q || '';
  const withAttachments = q.include_attachments === 'true';
  const data = await api(`/api/v2/cea/documents?${qs({
    doc_type: docType, doc_status: docStatus, sector, year, q: keyword,
    include_attachments: withAttachments ? 'true' : '', limit: 200,
  })}`);
  const rows = data.rows || [];
  const paired = Boolean(sector || year);

  body.innerHTML = `
  <div class="filters">
    <label class="fld"><span>关键词（标题/机关/备注）</span><input type="search" data-f="q" value="${esc(keyword)}" placeholder="例如：配额分配、结转"></label>
    <label class="fld"><span>文件类型</span><select data-f="doc_type"><option value="">全部</option>
      ${Object.entries(DOC_TYPE_LABEL).map(([k, l]) => `<option value="${k}" ${docType === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
    <label class="fld"><span>效力状态</span><select data-f="doc_status"><option value="">全部</option>
      ${Object.entries(DOC_STATUS_LABEL).map(([k, l]) => `<option value="${k}" ${docStatus === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
    <label class="fld"><span>行业</span><input type="search" data-f="sector" value="${esc(sector)}" placeholder="如 发电 / 钢铁"></label>
    <label class="fld"><span>适用年度</span><input type="number" data-f="year" value="${esc(year)}" min="2000" max="2100" placeholder="如 2026"></label>
    <label class="fld"><span>附件行</span><select data-f="include_attachments">
      <option value="" ${!withAttachments ? 'selected' : ''}>默认隐藏（不重复计数）</option>
      <option value="true" ${withAttachments ? 'selected' : ''}>显示官方 PDF 附件行</option></select></label>
    <span class="fld-actions">${exportLinks('documents', { doc_type: docType, doc_status: docStatus, sector, year })}<button class="btn btn-sm" data-reset>重置</button></span>
  </div>

  ${paired ? `<div class="callout callout-warn">
    <b>已按行业×年度配对判定</b>
    <p>明确不适用的文件已排除（excluded_not_applicable = ${num(data.excluded_not_applicable)} 条）；
    缺少配对登记、无法精确判定的条目保留但标为「依据不足」（applicability=null，共 ${num(data.unknown_applicability)} 条）。</p>
    <p class="hint">${esc(data.applicability_note || '')}</p>
    <p class="hint">判定依据是文件的 coverage（行业×年度**配对**）字段，不是「覆盖行业清单 × 适用年度清单」的笛卡尔积。</p>
  </div>` : ''}

  <div class="metrics metrics-sm">
    ${metric({ label: '文件条目', value: num(data.total), unit: '条', sub: `按当前筛选返回｜过滤前 ${num(data.total_before_applicability_filter ?? data.total)} 条`, asOf: '', source: 'cea_document' })}
    ${metric({ label: '已取得全文', value: num(rows.filter((r) => r.evidence_level === 'full_text').length), unit: '条', sub: '只有取得全文才具备逐条对照能力', asOf: '', source: 'cea_document.evidence_level' })}
    ${metric({ label: '自动核验通过', value: num(rows.filter((r) => r.ai_status === 'verified').length), unit: '条', sub: '证据一致性结论，不是独立审计', asOf: '', source: 'cea_document.ai_status' })}
    ${metric({ label: '配对排除 / 依据不足', value: `${num(data.excluded_not_applicable)} / ${num(data.unknown_applicability)}`, unit: '条', sub: '仅在按行业或年度筛选时产生', asOf: '', source: 'documentApplicability（行业×年度配对）' })}
  </div>

  ${card({
    title: 'CEA 政策与配额文件',
    subtitle: '配额分配方案、年度管理工作通知、结转规定、行情编制方案等；效力状态与证据等级分列',
    actions: exportLinks('documents', { doc_type: docType, doc_status: docStatus, sector, year }),
    body: table({
      rows,
      pageSize: 20,
      rowAttrs: (r) => `data-cea-doc="${esc(r.id)}"`,
      columns: [
        { key: 'title', label: '标题与核心摘要', render: (r) => `<button class="link title-cell" data-cea-doc="${esc(r.id)}" title="${esc(r.title)}">${esc(truncate(r.title, 48))}</button>${summaryBlock(r, { compact: true })}` },
        { key: 'doc_type', label: '类型', render: (r) => esc(DOC_TYPE_LABEL[r.doc_type] || r.doc_type) },
        { key: 'doc_status', label: '效力状态', render: (r) => docStatusChip(r) },
        { key: 'doc_number', label: '文号', render: (r) => esc(r.doc_number || '—') },
        { key: 'source_display', label: '来源', definition: '官方信息 / 第三方实际发布机构 / 来源未标注', render: (r) => sourceBlock(r) },
        { key: 'publish_date', label: '印发日期', render: (r) => esc(shortDate(r.publish_date)) },
        { key: 'applicable_years', label: '适用年度', render: (r) => esc((r.applicable_years || []).join('、') || '—') },
        { key: 'covered_sectors', label: '覆盖行业', render: (r) => esc((r.covered_sectors || []).join('、') || '—') },
        ...(paired ? [{
          key: 'applicability', label: '配对适用性', render: (r) => {
            const a = r.applicability || {};
            const label = a.applicable === true ? '适用（配对命中）' : a.applicable === false ? '明确不适用' : '依据不足（不判为适用）';
            const kind = a.applicable === true ? 'ok' : a.applicable === false ? 'danger' : 'warn';
            return `<span title="${esc(a.reason || '')}">${chip(label, kind)}</span>`;
          },
        }] : []),
        { key: 'count_in_stats', label: '统计', render: (r) => (Number(r.count_in_stats) === 1 ? '计入' : chip('附件行（不重复计数）', 'muted')) },
        { key: 'official_url', label: '原文', render: (r) => sourceLinkBlock(r, { label: '原文' }) },
      ],
      emptyText: paired ? '当前行业×年度配对下没有任何适用文件' : '没有符合条件的 CEA 文件',
      emptyDetail: '文件尚未采集或正文未取得时不会出现在列表；可放宽筛选或在后台触发 documents 采集。',
    }) + noteBlock(data.note || '')
      + (data.attachments_hidden ? noteBlock(`默认隐藏官方 PDF 附件行 ${num(data.attachments_hidden)} 条：${esc(data.attachment_note || '')}`) : ''),
  })}`;

  wireFilters(body, ['q', 'sector']);
  body.addEventListener('click', (e) => {
    const t = e.target.closest('[data-cea-doc]');
    if (!t || !t.dataset.ceaDoc) return;
    document.querySelector('.drawer-backdrop')?.remove();
    document.querySelector('.drawer')?.remove();
    setQuery({ doc: t.dataset.ceaDoc });
  });
  if (q.doc) await openDocDrawer(q.doc);
}

async function openDocDrawer(id) {
  let d;
  try {
    d = await api(`/api/v2/cea/documents/${encodeURIComponent(id)}`);
  } catch (e) {
    toast(e.body?.message || e.body?.error || e.message, 'danger');
    return;
  }
  const body = String(d.body_snapshot || '');
  const coverage = d.coverage || [];
  document.body.insertAdjacentHTML('beforeend', drawer(`CEA 文件：${d.title}`, `
    <div class="drawer-section">
      <div class="chip-row">
        ${chip(DOC_TYPE_LABEL[d.doc_type] || d.doc_type)}
        ${docStatusChip(d)}
        ${chip(EVIDENCE_LABEL[d.evidence_level] || d.evidence_level, d.evidence_level === 'full_text' ? 'ok' : 'warn')}
        ${verifyChip2(d.ai_status)}
      </div>
      ${kv([
        ['标题', esc(d.title)],
        ['文号', esc(d.doc_number || '—')],
        ['发布机关', esc(d.issuer || '—')],
        ['印发 / 施行日期', `${esc(shortDate(d.publish_date))} / ${esc(shortDate(d.effective_date))}`],
        ['分类', esc(d.category || '—')],
        ['版本', esc(d.version || '—')],
        ['适用年度（书面清单）', esc((d.applicable_years || []).join('、') || '—')],
        ['覆盖行业（书面清单）', esc((d.covered_sectors || []).join('、') || '—')],
        ['计入统计', Number(d.count_in_stats) === 1 ? '计入（正文行）' : '附件行，不重复计数'],
        ['官方 URL', d.official_url ? `<a class="link" href="${esc(d.official_url)}" target="_blank" rel="noreferrer noopener">${esc(truncate(d.official_url, 60))}</a>` : '—'],
        ['附件', d.attachment_available ? `已归档（${esc(d.attachment_url || d.attachment_path || '本地原件')}）` : '尚未归档官方原件'],
        ['抓取时间', esc(ceaTimeText(d.fetched_at))],
        ['快照', esc(d.snapshot_id || '—')],
        ['正文长度', body ? `${num(body.length)} 字符` : '未取得正文'],
        ['AI 核验时间', esc(d.ai_checked_at ? dateTime(d.ai_checked_at) : '尚未自动核验')],
      ])}
    </div>

    <div class="drawer-section">
      <h4>行业×年度配对覆盖（适用性判定依据）</h4>
      ${coverage.length ? `<table class="grid grid-sm"><thead><tr><th>行业</th><th>适用年度</th><th>依据</th></tr></thead><tbody>
        ${coverage.map((c) => `<tr><td>${esc(c.sector || '—')}</td><td>${esc((c.years || []).join('、') || '—')}</td><td class="muted">${esc(c.note || c.source || '')}</td></tr>`).join('')}
        </tbody></table><p class="hint">依据说明：${esc(d.coverage_source || '—')}</p>`
        : '<p class="muted">该文件未登记行业×年度配对，无法精确判定适用性（依据不足，不判为适用）。</p>'}
    </div>

    <div class="drawer-section">
      <h4>正文摘要（已归档原文）</h4>
      ${body ? `<pre class="body-snapshot">${esc(truncate(body, 6000))}</pre>
        <p class="hint">以上为真实抓取并归档的官方正文片段；未取得全文时不声称已读原文。</p>`
        : `<p class="muted">未取得正文（${esc(EVIDENCE_LABEL[d.evidence_level] || d.evidence_level)}）。扫描件不会凭元数据伪造正文，可由管理员在后台补充可读原件或 OCR 文字。</p>`}
      ${d.ai_summary ? `<h5>模型核验摘要</h5><p class="prose">${esc(d.ai_summary)}</p>` : ''}
    </div>

    <div class="drawer-section">
      <h4>相关履约事件（${(d.events || []).length}）</h4>
      ${(d.events || []).length ? `<table class="grid grid-sm"><thead><tr><th>事件</th><th>类型</th><th>执行日期</th><th>年度</th><th>日期核验</th></tr></thead><tbody>
        ${(d.events || []).map((ev) => `<tr><td>${esc(ev.title)}</td><td>${esc(EVENT_TYPE_LABEL[ev.event_type] || ev.event_type)}</td>
          <td>${esc(shortDate(ev.deadline))}</td>
          <td class="muted">${esc([ev.emission_year, ev.quota_year, ev.list_year].filter(Boolean).join(' / ') || '—')}</td>
          <td>${verifyChip2(ev.date_verify_status)}</td></tr>`).join('')}
        </tbody></table>` : '<p class="muted">该文件未锚定履约事件。</p>'}
    </div>

    <div class="drawer-section">
      <h4>证据核验（${(d.verifications || []).length}）</h4>
      ${(d.verifications || []).length ? (d.verifications || []).map((v) => `
        <div class="verify-box verify-${esc(v.result || 'unavailable')}">
          <div class="verify-head">${verifyChip2(v.result)}<span class="muted">${esc(dateTime(v.created_at))}｜模型 ${esc(v.model || '—')}</span></div>
          <p>${esc(v.summary || '')}</p>
          ${(v.citations || []).length ? `<ul class="bullets">${(v.citations || []).map((c) => `<li>〔${esc(c.kind || '')}${c.locator ? ` · ${esc(c.locator)}` : ''}〕${esc(truncate(c.quote || '', 160))}</li>`).join('')}</ul>` : '<p class="muted">没有可在原文中定位的引文：不据此判定为已核验。</p>'}
        </div>`).join('') : '<p class="muted">尚无核验记录；未配置模型时保持「暂未自动核验」，不伪造通过。</p>'}
    </div>

    ${d.provenance_note ? `<div class="drawer-section"><h4>元数据来源说明</h4><p class="prose">${esc(d.provenance_note)}</p></div>` : ''}
    ${d.note ? `<div class="drawer-section"><p class="hint">${esc(d.note)}</p></div>` : ''}
  `, { wide: true }));
}

/* ==================================================================== */
/*  三、履约日历                                                        */
/* ==================================================================== */

async function renderCalendar(body, q) {
  const from = q.from || '';
  const to = q.to || '';
  const dayType = q.day_type || '';
  const data = await api(`/api/v2/cea/calendar?${qs({ from, to, day_type: dayType, limit: 400 })}`);
  const rows = data.rows || [];
  const anomalies = data.anomalies || [];

  const gridDays = rows.map((r) => {
    const layers = r.layers || {};
    const noticeHoliday = layers.official_notice?.day_type === 'holiday';
    const noticeOpen = layers.official_notice_open?.day_type === 'trading';
    const machineHoliday = layers.holidays_json?.day_type === 'holiday';
    let state = 'missing';
    let label = '证据不足';
    if (r.actual_trades) { state = 'traded'; label = '有成交'; }
    else if (noticeHoliday) { state = 'closed'; label = '正式公告休市'; }
    else if (noticeOpen) { state = 'no_trade'; label = '正式公告开市（无成交记录）'; }
    else if (machineHoliday) { state = 'missing'; label = '仅机器列表标休市'; }
    return { trade_date: r.trade_date, state, state_label: label };
  });

  const layerCell = (layer, expect) => {
    if (!layer) return '<span class="muted">未覆盖</span>';
    const isHoliday = layer.day_type === 'holiday';
    const label = isHoliday ? '休市' : layer.day_type === 'trading' ? '开市' : (layer.day_type || '—');
    const kind = isHoliday ? (expect === 'notice' ? '' : 'warn') : 'ok';
    return `${chip(label, kind)}<div class="muted">${esc(truncate(layer.note || layer.source_code || '', 70))}</div>
      ${layer.evidence_url ? `<a class="link" href="${esc(layer.evidence_url)}" target="_blank" rel="noreferrer noopener">证据原文</a>` : ''}`;
  };

  body.innerHTML = `
  <div class="callout">
    <b>日历证据分三层，互不覆盖</b>
    <p>正式公告优先于机器辅助列表；异常独立告警并保留原文，<b>不生成人工复核任务</b>，行情数值不因此被判为不真实。</p>
    <p class="hint">${esc(data.layers_note || '')}</p>
    <p class="hint">${esc(data.note || '')}</p>
  </div>

  <div class="filters">
    <label class="fld"><span>起</span><input type="date" data-f="from" value="${esc(from)}"></label>
    <label class="fld"><span>止</span><input type="date" data-f="to" value="${esc(to)}"></label>
    <label class="fld"><span>日类型（机器列表标注）</span><select data-f="day_type"><option value="">全部</option>
      <option value="holiday" ${dayType === 'holiday' ? 'selected' : ''}>休市</option>
      <option value="trading" ${dayType === 'trading' ? 'selected' : ''}>交易日</option>
      <option value="unknown" ${dayType === 'unknown' ? 'selected' : ''}>未标注</option></select></label>
    <span class="fld-actions">${exportLinks('calendar', { from, to })}<button class="btn btn-sm" data-reset>重置</button></span>
  </div>

  <div class="metrics metrics-sm">
    ${metric({ label: '日历日期', value: num(data.total), unit: '天', sub: `本页展示 ${rows.length} 天（按日期倒序）`, asOf: '', source: 'cea_calendar（三层证据合并）' })}
    ${metric({ label: '来源异常', value: num(data.anomaly_count), unit: '条', sub: '机器列表与正式公告/实际成交矛盾，独立告警', asOf: '', source: 'cea_calendar_check', warn: Number(data.anomaly_count) > 0 })}
    ${metric({ label: '人工复核任务', value: num(data.checks?.manual_review_created ?? 0), unit: '条', sub: '本平台不生成人工复核任务（恒为 0）', asOf: '', source: 'cea_calendar_check.manual_review' })}
    ${Number(data.superseded_evidence?.total || 0) > 0 ? metric({
      label: '来源修订后过期证据', value: num(data.superseded_evidence.total), unit: '条',
      sub: '来源完整快照已删除的旧日期：历史原文与快照保留可追溯，不作为当前事实或告警依据',
      asOf: '', source: 'cea_calendar.source_state=superseded',
    }) : ''}
    ${metric({ label: '有实际成交的日期（本页）', value: num(rows.filter((r) => r.actual_trades).length), unit: '天', sub: '以真实入库行情为准，不以日历标注推断', asOf: '', source: 'cea_trade_daily' })}
  </div>

  ${card({
    title: '分层日历（正式公告 / 机器辅助列表 / 实际成交）',
    subtitle: '综合结论按「正式公告 > 实际成交 > 机器辅助列表」给出',
    body: rows.length ? calendarGrid(gridDays) + noteBlock('格子颜色只表示综合结论；「仅机器列表标休市」表示缺正式公告与成交证据，不据此宣称休市。')
      : emptyState('所选区间没有日历证据', '未采集到官方休市列表或正式公告时留空，不推测节假日。'),
  })}

  <div class="grid-2">
    ${card({
      title: '异常与不一致（独立告警）',
      subtitle: `${anomalies.length} 条｜保留双方原文，不删除机器列表，不生成人工复核任务`,
      body: anomalies.length ? `<ul class="list">${anomalies.map((a) => `<li>
        <div class="list-head"><b>${esc(a.trade_date)}</b>${chip(a.severity === 'warn' ? '告警' : a.severity, a.severity === 'warn' ? 'warn' : '')}
          <span class="muted right">${esc(a.check_key)}｜综合结论：${esc(EFFECTIVE_STATE_LABEL[a.effective_state] || a.effective_state)}</span></div>
        <p class="muted">${esc(a.detail || '')}</p>
        <p class="hint">采信依据：${esc(a.resolved_by || '—')}｜人工复核任务：${Number(a.manual_review || 0)}</p>
        ${a.evidence ? `<details><summary>三层证据原始取值</summary>${renderKvRows(a.evidence)}</details>` : ''}
      </li>`).join('')}</ul>`
        : emptyState('没有来源异常', '机器辅助列表与正式公告、实际成交一致时不产生告警。'),
    })}
    ${card({
      title: '日历核对记录',
      subtitle: `核对了 ${num(data.checks?.total ?? 0)} 个日期｜异常 ${num(data.checks?.anomalies ?? 0)} 条`,
      body: (data.checks?.rows || []).length ? table({
        rows: data.checks.rows,
        pageSize: 10,
        columns: [
          { key: 'trade_date', label: '日期' },
          { key: 'check_key', label: '检查项' },
          { key: 'severity', label: '级别', render: (r) => chip(r.severity === 'warn' ? '告警' : r.severity, r.severity === 'warn' ? 'warn' : '') },
          { key: 'effective_state', label: '综合结论', render: (r) => esc(EFFECTIVE_STATE_LABEL[r.effective_state] || r.effective_state) },
          { key: 'resolved_by', label: '采信依据', render: (r) => esc(r.resolved_by || '—') },
        ],
      }) : emptyState('暂无核对记录', '正式公告与机器辅助列表都未覆盖时不产生核对项。'),
    })}
  </div>

  ${card({
    title: '分层明细表',
    subtitle: '每行的三层证据与来源优先级说明都可逐条核对',
    actions: exportLinks('calendar', { from, to }),
    body: table({
      rows,
      pageSize: 20,
      columns: [
        { key: 'trade_date', label: '日期', render: (r) => esc(r.trade_date) },
        { key: 'notice', label: '正式公告', render: (r) => layerCell(r.layers?.official_notice, 'notice') },
        { key: 'notice_open', label: '正式公告（开市）', render: (r) => layerCell(r.layers?.official_notice_open, 'notice') },
        { key: 'machine', label: '机器辅助列表', render: (r) => layerCell(r.layers?.holidays_json, 'machine') },
        { key: 'actual_trades', label: '实际成交', render: (r) => (r.actual_trades ? chip('有成交记录', 'ok') : '<span class="muted">无成交记录</span>') },
        { key: 'effective_state', label: '综合结论', render: (r) => chip(EFFECTIVE_STATE_LABEL[r.effective_state] || r.effective_state, r.effective_state === 'trading' ? 'ok' : r.effective_state === 'closed' ? 'muted' : 'warn') },
        { key: 'source_priority_note', label: '来源优先级说明', render: (r) => esc(r.source_priority_note || '—') },
        { key: 'anomaly', label: '异常', render: (r) => (r.anomaly ? `${chip('来源异常（已独立告警）', 'warn')}<div class="muted">${esc(truncate(r.anomaly.detail || '', 90))}</div>` : '—') },
      ],
      emptyText: '所选区间没有日历行',
    }),
  })}`;

  wireFilters(body, []);
}

/* ==================================================================== */
/*  四、企业名录                                                        */
/* ==================================================================== */

function entitySourceCell(r) {
  const entries = [];
  const seen = new Set();
  for (const m of Array.isArray(r.source_memberships) ? r.source_memberships : []) {
    const href = safeHttpHref(m.source_url);
    if (!href) continue;
    const key = `${href}|${m.sector || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ href, label: m.sector || '公开名录' });
  }
  if (entries.length <= 1) {
    if (!entries.length) return clearingLink(r.source_url, '公开名录');
    return `<a class="link" href="${entries[0].href}" target="_blank" rel="noreferrer noopener">公开名录</a>`;
  }
  return `<details class="tech-details"><summary>${entries.length} 个出处</summary>` +
    `<div class="tech-details-body">${entries.map((e) => `<a class="link" href="${e.href}" target="_blank" rel="noreferrer noopener">${esc(e.label)}</a>`).join('<br>')}</div></details>`;
}

async function renderEntities(body, q) {
  const province = q.province || '';
  const sector = q.sector || '';
  const listYear = q.list_year || '';
  const status = q.status || '';
  const keyword = q.q || '';
  const limit = 200;
  const offset = Math.max(0, Number(q.offset) || 0);
  const data = await api(`/api/v2/cea/entities?${qs({
    province, sector, list_year: listYear, status, q: keyword, limit, offset,
  })}`);
  const rows = data.rows || [];
  const coverage = data.coverage || {};
  const filtered = Boolean(province || sector || listYear || status || keyword);

  const entityTable = table({
    rows,
    pageSize: 25,
    columns: [
      { key: 'name', label: '企业名称', render: (r) => esc(truncate(r.name, 40)) },
      { key: 'credit_code', label: '统一社会信用代码', render: (r) => (r.credit_code ? `<code>${esc(r.credit_code)}</code>` : '<span class="muted">未披露</span>') },
      { key: 'province', label: '省份', render: (r) => esc(r.province || '—') },
      { key: 'city', label: '城市', render: (r) => esc(r.city || '—') },
      { key: 'sector', label: '行业', render: (r) => esc(r.sector || '—') },
      { key: 'list_year', label: '名录年度', align: 'right', render: (r) => esc(String(r.list_year ?? '—')) },
      { key: 'status', label: '名录状态', render: (r) => esc(ENTITY_STATUS_LABEL[r.status] || r.status || '—') },
      { key: 'data_as_of', label: '数据截止日', render: (r) => esc(shortDate(r.data_as_of)) },
      { key: 'verify_status', label: '核验状态', render: (r) => verifyChip2(r.verify_status) },
      { key: 'source_url', label: '来源', render: (r) => entitySourceCell(r) },
    ],
    emptyText: '没有名录条目',
  });
  const entityBody = (data.total === 0 && filtered)
    ? emptyState('当前筛选没有名录条目', '可放宽省份/年度/行业筛选，或清除关键词。')
    : (data.total === 0
      ? emptyState(
        '来源解析缺口：暂无可核对的公开名录行',
        '公开样本（省级 PDF）为扫描件或无结构化名录行，不添加假企业填充。',
        '缺口已登记在「来源与缺口」页签；管理员可在后台「CEA 配额市场」上传官方名录原件，或触发 entities 采集重试'
      )
      : entityTable + remotePager({ total: data.total, limit, offset, unit: '条' }));

  body.innerHTML = `
  <div class="callout">
    <b>名录数量不等于买家数量</b>
    <p>重点排放单位名录只说明该主体被纳入全国碳市场管理，不代表它一定购买配额，也不代表企业实际盈缺。</p>
    <p class="hint">${esc(data.note || '')}</p>
  </div>

  <div class="filters">
    <label class="fld"><span>省份</span><input type="search" data-f="province" value="${esc(province)}" placeholder="如 福建省"></label>
    <label class="fld"><span>行业</span><input type="search" data-f="sector" value="${esc(sector)}" placeholder="如 发电"></label>
    <label class="fld"><span>名录年度</span><input type="number" data-f="list_year" value="${esc(listYear)}" min="2000" max="2100" placeholder="如 2026"></label>
    <label class="fld"><span>名录状态</span><select data-f="status"><option value="">全部</option>
      ${Object.entries(ENTITY_STATUS_LABEL).map(([k, l]) => `<option value="${k}" ${status === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
    <label class="fld"><span>关键词（企业名称/信用代码）</span><input type="search" data-f="q" value="${esc(keyword)}"></label>
    <span class="fld-actions">${exportLinks('entities', { province, sector, list_year: listYear, status })}<button class="btn btn-sm" data-reset>重置</button></span>
  </div>

  <div class="metrics metrics-sm">
    ${metric({ label: '名录条目（筛选后）', value: num(data.total), unit: '条', sub: `本页 ${rows.length} 条｜全库覆盖省份 ${num(coverage.provinces)} 个`, asOf: coverage.as_of || '', source: '官方公开名录' })}
    ${metric({ label: '名录年度', value: (coverage.list_years || []).join('、') || '—', unit: '', sub: '以统一社会信用代码 + 名录年度为标识', asOf: coverage.as_of || '', source: '官方公开名录' })}
    ${metric({ label: '全库未披露信用代码', value: num(coverage.without_credit_code), unit: '条', sub: '公开名录未披露该字段时不推测', asOf: coverage.as_of || '', source: '官方公开名录', warn: Number(coverage.without_credit_code) > 0 })}
  </div>

  ${card({
    title: 'CEA 重点排放单位名录',
    subtitle: `共 ${num(data.total)} 条（本系统已收录数，不等于全国总数）｜与 CCER 公开项目分开统计`,
    actions: exportLinks('entities', { province, sector, list_year: listYear, status }),
    body: entityBody,
  })}`;

  wireFilters(body, ['province', 'sector', 'q']);
  bindRemotePager(body, { limit, offset });
}

/* ==================================================================== */
/*  五、交易意向                                                        */
/* ==================================================================== */

/** 意向的地区信息写在 note 里（来源原文口径），这里只做展示解析，不改变数据 */
function intentionRegion(note) {
  const m = String(note || '').match(/地区（非主体）：([^｜|]+)/);
  return m ? m[1].trim() : null;
}

async function renderIntentions(body, q) {
  const direction = q.direction || '';
  const quotaYear = q.quota_year || '';
  const from = q.from || '';
  const to = q.to || '';
  // 服务端该路由单次最多返回 2000 条（超出即截断），因此本地按 200 条分页展示已返回的真实行
  const fetchLimit = 2000;
  const limit = 200;
  const offset = Math.max(0, Number(q.offset) || 0);
  const data = await api(`/api/v2/cea/intentions?${qs({ direction, quota_year: quotaYear, from, to, limit: fetchLimit })}`);
  const all = data.rows || [];
  const rows = all.slice(offset, offset + limit);

  body.innerHTML = `
  <div class="callout callout-warn">
    <b>交易意向不等于成交</b>
    <p>本页条目<b>不计入成交量 / 成交额</b>，也不参与任何行情统计。方向只按来源标注：1 = 买入、2 = 卖出、其他 = 未知（unknown，不猜）。</p>
    <p><b>价格与主体未公开时为「—」</b>，不用 0 或推测值填充。</p>
    <p class="hint">${esc(data.note || '')}</p>
  </div>

  <div class="filters">
    <label class="fld"><span>方向</span><select data-f="direction"><option value="">全部</option>
      ${Object.entries(DIRECTION_LABEL).map(([k, l]) => `<option value="${k}" ${direction === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
    <label class="fld"><span>配额年度</span><input type="number" data-f="quota_year" value="${esc(quotaYear)}" min="2000" max="2100" placeholder="如 2026"></label>
    <label class="fld"><span>发布日期起</span><input type="date" data-f="from" value="${esc(from)}"></label>
    <label class="fld"><span>止</span><input type="date" data-f="to" value="${esc(to)}"></label>
    <span class="fld-actions">${exportLinks('intentions', { direction, quota_year: quotaYear, from, to })}<button class="btn btn-sm" data-reset>重置</button></span>
  </div>

  <div class="metrics metrics-sm">
    ${metric({ label: '意向条目', value: num(data.total), unit: '条', sub: '筛选后返回；不计入成交量/成交额', asOf: '', source: 'cea_intention' })}
    ${metric({ label: '买入 / 卖出', value: `${num(all.filter((r) => r.direction === 'buy').length)} / ${num(all.filter((r) => r.direction === 'sell').length)}`, unit: '条', sub: '来源标注为 1 / 2 的条目', asOf: '', source: 'cea_intention.direction' })}
    ${metric({ label: '方向未知', value: num(all.filter((r) => r.direction === 'unknown').length), unit: '条', sub: '来源未标注方向时不推断', asOf: '', source: 'cea_intention.direction' })}
  </div>

  ${card({
    title: '公开交易意向',
    subtitle: '来源原文口径；「地区」是意向发布涉及的地区，不是主体名称',
    actions: exportLinks('intentions', { direction, quota_year: quotaYear, from, to }),
    body: rows.length ? table({
      rows,
      pageSize: 25,
      columns: [
        { key: 'published_date', label: '发布日期', render: (r) => esc(shortDate(r.published_date)) },
        { key: 'instrument_label', label: '品种标注（原文）', render: (r) => esc(r.instrument_label || '—') },
        { key: 'quota_year', label: '配额年度', align: 'right', render: (r) => num(r.quota_year) },
        { key: 'direction', label: '方向', render: (r) => chip(DIRECTION_LABEL[r.direction] || r.direction, r.direction === 'buy' ? 'ok' : r.direction === 'sell' ? 'accent' : 'muted') },
        { key: 'volume', label: '数量', unit: '吨', align: 'right', render: (r) => num(r.volume) },
        { key: 'price', label: '价格', unit: '元/吨', align: 'right', render: (r) => (has(r.price) ? num(r.price, 2) : '<span class="muted" title="来源未公开该字段：不用 0 或推测值填充">—</span>') },
        { key: 'participant', label: '主体', render: (r) => (r.participant ? esc(r.participant) : '<span class="muted" title="来源未公开该字段">—</span>') },
        { key: 'region', label: '地区（非主体）', render: (r) => esc(intentionRegion(r.note) || '—') },
        { key: 'verify_status', label: '核验状态', render: (r) => verifyChip2(r.verify_status) },
        { key: 'source_url', label: '来源', render: (r) => (r.source_url ? `<a class="link" href="${esc(r.source_url)}" target="_blank" rel="noreferrer noopener">原文</a>` : '—') },
      ],
      emptyText: '没有符合条件的交易意向',
      emptyDetail: '官方公开 JSON（tradeIntent）未采集到数据时不生成本地示例行。',
    }) + remotePager({ total: all.length, limit, offset, unit: '条' })
      + noteBlock('价格与主体未公开时显示「—」（不用 0 或推测值填充）；服务端单次最多返回 2000 条，条目更多时请用日期或配额年度筛选缩小范围（本页分页只在已返回的真实行内翻页，不虚构更多行）。')
      + noteBlock('地区来自来源原文的备注字段（「地区（非主体）」），只表示意向涉及的地区，不能当作交易主体或企业身份。')
      : emptyState('没有符合条件的交易意向', '官方公开 JSON（tradeIntent）未采集到数据时不生成本地示例行。', '可在后台「CEA 配额市场 → 采集」触发 intentions 采集'),
  })}`;

  wireFilters(body, ['quota_year']);
  bindRemotePager(body, { limit, offset });
}

/* ==================================================================== */
/*  五之二、登记与清结算（中碳登清结算日报 × CEA 同日对照）              */
/* ==================================================================== */

/**
 * 本页签属于**碳核算资料来源**（/api/v2/accounting/crc-daily），不是 CEA 行情：
 *   · 口径来源不同：中碳登清结算日报 vs 全国碳排放配额行情，页面上分列，不混算；
 *   · 自愿注销公示量不计入成交量；累计成交量是中碳登日报公布的口径，不是本平台统计；
 *   · 同日对照只做交叉核对：combined_total 恒为 null，差异保留两方原值。
 */

/** 来源链接白名单：只有 http/https 才生成链接，其余按纯文本显示 */
function safeHttpHref(value) {
  try {
    const url = new URL(String(value));
    return ['http:', 'https:'].includes(url.protocol) ? esc(url.href) : null;
  } catch { return null; }
}

function clearingLink(url, label) {
  const href = safeHttpHref(url);
  if (href) return `<a class="link" href="${href}" target="_blank" rel="noreferrer noopener">${esc(label)}</a>`;
  return url ? '<span class="muted">已登记地址不是 http/https：不生成跳转链接</span>' : '—';
}

/** 数值单元格：显示千分位；title 保留原文精确值，便于逐项核对（不是另一个数） */
function crcNumCell(v, digits = 0, unit = '') {
  if (!has(v)) return '—';
  return `<span title="原文值 ${esc(String(v))}${unit ? ` ${esc(unit)}` : ''}">${num(v, digits)}</span>`;
}

const CRC_FIELD_LABEL = {
  daily_volume_t: '本日成交量', daily_amount_yuan: '本日成交额',
  cumulative_volume_t: '累计成交量', cumulative_amount_yuan: '累计成交额',
};

/** 同日 CEA 对照单元：两方原值都保留，绝不相加 */
function clearingCeaCell(row) {
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
      <p class="hint">差异只做标注：不取平均、不择一覆盖、也不生成合并总量。</p></details>` : ''}`;
}

/** filtersBar 接线（写回 hash query，保留 tab=clearing） */
function wireClearingFilters(root) {
  root.querySelectorAll('[data-filter]').forEach((el) => {
    el.addEventListener('change', () => setQuery({ [el.dataset.filter]: el.value }));
  });
}

async function renderClearing(body, q) {
  const from = q.from || '';
  const to = q.to || '';
  const limit = Math.min(Math.max(Number(q.limit) || 90, 1), 400);
  const data = await api(`/api/v2/accounting/crc-daily?${qs({ from, to, limit })}`);
  const rows = data.rows || [];
  const latest = rows[0] || null;
  const exportQuery = qs({ from, to });

  body.innerHTML = `
  <div class="callout callout-warn">
    <b>本页为「中碳登清结算日报」口径，与 CCER / CEA 行情分属不同来源</b>
    <p>自愿注销公示量<b>不计入</b>成交量；累计成交量是中碳登日报公布的口径，<b>不是</b>本平台统计。</p>
    <p>两份来源的同日量额<b>不做相加</b>（combined_total 恒为 null）：CEA 列只在同一交易日存在 CEA 行情时显示，
    差异保留两方原值，不取平均、不择一覆盖。</p>
    <p class="hint">${esc(data.note || '')}</p>
  </div>

  ${filtersBar([
    { key: 'from', label: '数据日期起', type: 'date' },
    { key: 'to', label: '止', type: 'date' },
  ], { from, to, __extra: `<span class="fld-actions">${exportButtons('accounting/export/crc-daily', exportQuery)}
    <button class="btn btn-sm" data-reset>重置</button></span>` })}

  ${latest ? `
  <div class="metrics">
    ${metric({
      label: '本日成交量', value: num(latest.daily_volume_t), unit: '吨',
      sub: `中碳登清结算日报原文（最新一期 ${latest.trade_date || '—'}）`,
      note: '日报口径的当日成交量；自愿注销公示量不计入。',
      asOf: latest.trade_date, source: 'crc_clearing_daily',
    })}
    ${metric({
      label: '本日成交额', value: num(latest.daily_amount_yuan), unit: '元',
      sub: '中碳登清结算日报原文',
      note: '日报口径的当日成交金额，与 CEA 行情成交额不是同一来源。',
      asOf: latest.trade_date, source: 'crc_clearing_daily',
    })}
    ${metric({
      label: '公布均价（原文，四舍五入值）', value: has(latest.daily_avg_price_published) ? num(latest.daily_avg_price_published, 2) : '—', unit: '元/吨',
      sub: '日报原文公布的均价：是原文四舍五入后的展示值',
      note: '公布均价是日报原文的舍入展示值，不是本平台计算值，也不覆盖右侧的复算均价。',
      asOf: latest.trade_date, source: '日报原文',
    })}
    ${metric({
      label: '复算均价（成交额 ÷ 成交量）', value: has(latest.daily_avg_price_derived) ? num(latest.daily_avg_price_derived, 2) : '—', unit: '元/吨',
      sub: has(latest.daily_avg_price_derived) ? '按本日成交额 ÷ 本日成交量复算' : '当日缺成交额或成交量为 0 时不计算（不用 0 代替）',
      note: '复算值与公布均价并列显示，两个口径不互相替代。',
      asOf: latest.trade_date, source: 'crc-daily 复算',
    })}
    ${metric({
      label: '累计成交量（日报口径）', value: num(latest.cumulative_volume_t), unit: '吨',
      sub: '中碳登日报公布的累计口径，不是本平台统计',
      note: '累计值来自日报原文，本平台不做任何累加统计。',
      asOf: latest.trade_date, source: '日报原文',
    })}
    ${metric({
      label: '累计成交额（日报口径）', value: num(latest.cumulative_amount_yuan), unit: '元',
      sub: `修订号 ${latest.revision_no ? `第 ${num(latest.revision_no)} 版` : '1'}｜发布时间 ${shortDate(latest.published_at)}`,
      note: '日报改数时旧版本保留在修订留痕中，不覆盖。',
      asOf: latest.trade_date, source: '日报原文',
    })}
  </div>

  ${card({
    title: `最新一期同日 CEA 对照（${latest.trade_date || '—'}）`,
    subtitle: '两个来源分列展示，不做合并总量',
    actions: exportButtons('accounting/export/crc-daily', exportQuery),
    body: `
      <div class="table-wrap"><table class="grid grid-sm">
        <thead><tr><th>口径</th><th class="ta-r">成交量</th><th class="ta-r">成交额</th><th class="ta-r">价格</th><th>来源</th></tr></thead>
        <tbody>
          <tr><td>中碳登清结算日报</td>
            <td class="ta-r">${num(latest.daily_volume_t)} 吨</td>
            <td class="ta-r">${num(latest.daily_amount_yuan)} 元</td>
            <td class="ta-r">公布 ${num(latest.daily_avg_price_published, 2)}｜复算 ${num(latest.daily_avg_price_derived, 2)} 元/吨</td>
            <td>${clearingLink(latest.detail_url, '日报详情')}</td></tr>
          <tr><td>CEA 全国配额行情</td>
            ${latest.cea_available
              ? `<td class="ta-r">${num(latest.cea_compare?.cea?.total_volume)} 吨</td>
                 <td class="ta-r">${num(latest.cea_compare?.cea?.total_turnover)} 元</td>
                 <td class="ta-r">综合收盘价 ${num(latest.cea_compare?.cea?.close, 2)} 元/吨</td>
                 <td>${clearingLink(latest.cea_compare?.cea?.source_url, '行情来源')}</td>`
              : '<td class="ta-r muted">—</td><td class="ta-r muted">—</td><td class="ta-r muted">—</td><td class="muted">同日无 CEA 行情</td>'}
          </tr>
        </tbody></table></div>
      ${latest.cea_available ? `<p class="hint">${chip(latest.cea_compare?.match ? '一致' : '有差异（两方原值均已保留）', latest.cea_compare?.match ? 'ok' : 'warn')}
        ${esc(latest.cea_compare?.note || '')}</p>` : '<p class="hint">该交易日没有 CEA 行情记录：不做单侧推算，也不留空相加。</p>'}
      ${noteBlock('两份来源的同日量额不做相加，combined_total 恒为 null；公布均价是日报原文的四舍五入值，复算均价由程序按成交额 ÷ 成交量另列。')}`,
  })}
  ` : emptyState(
    '所选区间没有中碳登清结算日报',
    '日报未采集或区间内没有数据时不生成占位行，也不用 CEA 行情替代。',
    '可在后台「碳核算资料」触发 crc_daily 采集（202 只表示已受理，实际进度见任务轮询）。'
  )}

  ${card({
    title: '清结算日报明细（含同日 CEA 对照）',
    subtitle: `共 ${num(data.total)} 期（本页 ${rows.length} 期）｜最新在前｜CEA 对照表${data.cea_table_ready ? '已就绪' : '尚未就绪（cea_trade_daily 缺失）'}`,
    actions: exportButtons('accounting/export/crc-daily', exportQuery),
    body: rows.length ? table({
      rows,
      pageSize: 25,
      columns: [
        { key: 'trade_date', label: '数据日期', render: (r) => (safeHttpHref(r.detail_url) ? `<a class="link" href="${safeHttpHref(r.detail_url)}" target="_blank" rel="noreferrer noopener">${esc(r.trade_date || '—')}</a>` : esc(r.trade_date || '—')) },
        { key: 'daily_volume_t', label: '本日成交量', unit: '吨', align: 'right', render: (r) => crcNumCell(r.daily_volume_t, 0, '吨') },
        { key: 'daily_amount_yuan', label: '本日成交额', unit: '元', align: 'right', render: (r) => crcNumCell(r.daily_amount_yuan, 0, '元') },
        { key: 'daily_avg_price_published', label: '公布均价', unit: '元/吨', align: 'right', render: (r) => crcNumCell(r.daily_avg_price_published, 2, '元/吨') },
        { key: 'daily_avg_price_derived', label: '复算均价', unit: '元/吨', align: 'right', render: (r) => crcNumCell(r.daily_avg_price_derived, 2, '元/吨') },
        { key: 'cumulative_volume_t', label: '累计成交量（日报口径）', unit: '吨', align: 'right', render: (r) => crcNumCell(r.cumulative_volume_t, 0, '吨') },
        { key: 'cumulative_amount_yuan', label: '累计成交额（日报口径）', unit: '元', align: 'right', render: (r) => crcNumCell(r.cumulative_amount_yuan, 0, '元') },
        { key: 'revision_no', label: '修订号', align: 'right', render: (r) => (r.revision_no ? chip(`第 ${num(r.revision_no)} 版`, Number(r.revision_no) > 1 ? 'warn' : 'muted') : '1') },
        { key: 'cea', label: 'CEA 同日对照', render: (r) => clearingCeaCell(r) },
      ],
      emptyText: '所选区间没有日报记录',
      emptyDetail: '缺失日期不生成 0 值行；可放宽日期区间或在后台触发采集。',
    }) + noteBlock('公布均价为日报原文的舍入展示值，复算均价为「本日成交额 ÷ 本日成交量」的程序计算值，两者并列不互相覆盖。')
      + noteBlock('累计成交量/额是中碳登日报公布的口径，不是本平台统计；自愿注销公示量不计入成交量。')
      : emptyState('所选区间没有日报记录', '缺失日期不生成 0 值行，也不用 CEA 行情替代。'),
  })}`;

  wireClearingFilters(body);
  body.querySelector('[data-reset]')?.addEventListener('click', () => setQuery({ from: null, to: null }));
}

/* ==================================================================== */
/*  六、成本情景                                                        */
/* ==================================================================== */

async function renderScenario(body, q) {
  const [presetsOut, overview, ccerOut] = await Promise.all([
    api('/api/v2/cea/scenario/presets'),
    api('/api/v2/cea/overview').catch(() => null),
    api('/api/v2/cea/scenario/ccer-quotes').catch(() => null),
  ]);
  const presets = presetsOut.presets || [];
  const latest = overview?.latest_day || null;
  const ccer = ccerOut || { available: false, quotes: [], market: 'CCER' };
  const presetOptions = presets.map((p) => `<option value="${esc(p.key)}" data-ratio="${p.ratio === null || p.ratio === undefined ? '' : p.ratio}">${esc(p.label)}</option>`).join('');

  // P1（CEA）与 P2（CCER）**来源不同**：P1 用 CEA 综合行情，P2 只能用手动输入或 CCER 独立行情；
  // P2 不提供 CEA 行情口径选择，避免把 CEA 指数价当 CCER 价（docs/35 第 8 条）。
  const priceField = (key, label, unit, kind) => `
    <div class="fgroup">
      <legend>${esc(label)}</legend>
      <div class="quick-adv-grid">
        <label class="fld"><span>价格来源</span>
          <select data-src="${key}">
            <option value="manual">手动输入</option>
            ${kind === 'cea'
              ? '<option value="market">从 CEA 真实行情选择（最新交易日）</option>'
              : `<option value="market" ${ccer.available ? '' : 'disabled'}>从 CCER 独立行情选择${ccer.available ? '' : '（当前无可用 CCER 行情）'}</option>`}
          </select></label>
        <label class="fld"><span>价格口径</span>
          ${kind === 'cea'
            ? `<select data-caliber="${key}">
                 <option value="close">官方综合收盘价（close）</option>
                 <option value="computed_avg_price">全方式计算均价（computed_avg_price）</option>
               </select>`
            : `<select data-caliber="${key}" data-ccer-caliber>
                 <option value="latest">CCER 最新成交均价（官方披露）</option>
                 <option value="computed">CCER 区间量加权计算均价（计算值）</option>
                 ${(ccer.quotes || []).slice(0, 12).map((x) => `<option value="d:${esc(x.trade_date)}">CCER ${esc(x.trade_date)} 成交均价</option>`).join('')}
               </select>`}
        </label>
        <label class="fld"><span>${esc(label)}（${esc(unit)}）</span>
          <span class="input-unit"><input type="number" step="any" min="0" data-price="${key}" placeholder="0" aria-label="${esc(label)}"><i>${esc(unit)}</i></span></label>
      </div>
      <p class="hint" data-price-note="${key}">${kind === 'cea'
        ? '手动输入时请自行记录价格日期与口径；选择 CEA 行情时会在此显示所选价格的交易日与口径。'
        : (ccer.available
          ? 'P2 参考价只能来自 CCER 独立行情或手动输入：选择后在此显示 CCER 交易日、来源与口径。'
          : `当前没有可用的 CCER 参考行情（${esc(ccer.missing_reason || '库中无 CCER 成交行情')}）：请手动输入并记录来源，本表单不会用 CEA 价格顶替 CCER 价格。`)}</p>
    </div>`;

  body.innerHTML = `
  <div class="callout callout-warn">
    <b>临时情景算术，不保存参数，不自动建议购买</b>
    <p>本页只做算术：不写入任何台账、不触发采集、不产生建议。结果不等于真实成交价、最终履约费用或合规结论。</p>
    <p><b>抵销比例 r 必须由你显式选择</b>：${esc(presetsOut.note || '')}</p>
    <p class="hint">5% 是历史情景假设，<b>不是所有年度的现行规则</b>；实际可用比例与 CCER 可用数量上限必须以对应年度的正式文件为准。</p>
  </div>

  <form id="scenario-form" class="quick-form">
    <fieldset class="fgroup">
      <legend>数量参数（吨CO2e）</legend>
      <div class="quick-adv-grid">
        <label class="fld"><span>应清缴量 E <b class="req">必填</b></span><span class="input-unit"><input type="number" step="any" min="0" data-in="E" aria-label="应清缴量 E"><i>吨CO2e</i></span></label>
        <label class="fld"><span>可用于该年度清缴的配额 A <b class="req">必填</b></span><span class="input-unit"><input type="number" step="any" min="0" data-in="A" aria-label="配额 A"><i>吨CO2e</i></span></label>
        <label class="fld"><span>符合该年度规则的 CCER 可用数量 C <b class="req">必填</b></span><span class="input-unit"><input type="number" step="any" min="0" data-in="C" aria-label="CCER 可用数量 C"><i>吨CO2e</i></span></label>
        <label class="fld"><span>已使用抵销量 U <b class="req">必填</b></span><span class="input-unit"><input type="number" step="any" min="0" data-in="U" aria-label="已使用抵销量 U"><i>吨CO2e</i></span></label>
      </div>
    </fieldset>

    <fieldset class="fgroup">
      <legend>抵销情景假设</legend>
      <div class="quick-adv-grid">
        <label class="fld"><span>抵销比例 r <b class="req">必填</b></span>
          <select data-r-select>${presetOptions}</select></label>
        <label class="fld"><span>自定义比例（0—1，选「自定义情景假设」时必填）</span>
          <span class="input-unit"><input type="number" step="any" min="0" max="1" data-r-custom placeholder="如 0.05" aria-label="自定义抵销比例"><i>比例</i></span></label>
      </div>
      <p class="hint" data-r-note>选择预设时按预设比例计算；预设只是历史情景，不代表该年度现行规则。</p>
    </fieldset>

    ${priceField('P1', '参考 CEA 价格 P1', '元/吨', 'cea')}
    ${priceField('P2', 'CCER 价格 P2', '元/吨', 'ccer')}

    <fieldset class="fgroup">
      <legend>其他费用</legend>
      <div class="quick-adv-grid">
        <label class="fld"><span>新增费用（可选，默认 0）</span><span class="input-unit"><input type="number" step="any" min="0" data-in="extra_cost" placeholder="0" aria-label="新增费用"><i>元</i></span></label>
      </div>
      <p class="hint">新增费用用于组合情景的一次性支出（如交易手续费、咨询费），仅在组合参考成本中计入。</p>
    </fieldset>

    <div class="quick-actions">
      <button class="btn btn-primary" type="submit" id="scenario-submit">计算情景差额</button>
      <button class="btn" type="reset" id="scenario-reset">清空</button>
      <span class="hint">不保存参数、不产生副作用（服务端只计算）。</span>
    </div>
  </form>

  ${card({
    title: '计算公式（服务端实现）',
    subtitle: '与该页签展示的字段一一对应',
    body: kv([
      ['缺口 D', esc(presetsOut.formula?.gap_D || 'max(E - A, 0)')],
      ['情景使用抵销量 Q', esc(presetsOut.formula?.offset_Q || 'min(D, C, max(E*r - U, 0))')],
      ['仅买 CEA 成本', esc(presetsOut.formula?.cea_only_cost || 'D * P1')],
      ['组合参考成本', esc(presetsOut.formula?.combined_reference_cost || '(D - Q) * P1 + Q * P2 + 新增费用')],
    ]) + noteBlock('U > E·r 时剩余抵销额度按 0 计（不允许负数额度变成额外抵扣）；差额可能为负，只表示两种情景的算术差。'),
  })}

  <div id="scenario-result">${emptyState('尚未计算', '填写参数后点击「计算情景差额」；结果只在本页显示，不写入数据库。')}</div>`;

  /* ------- 参考价：P1 取 CEA 综合行情；P2 取 CCER 独立行情（两者来源不同，互不回退） ------- */
  const priceState = {
    P1: { source: 'manual', caliber: 'close', market: 'CEA' },
    P2: { source: 'manual', caliber: 'latest', market: 'CCER' },
  };
  const applyCeaMarketPrice = (key) => {
    const input = body.querySelector(`[data-price="${key}"]`);
    const note = body.querySelector(`[data-price-note="${key}"]`);
    const cal = caliberValue(priceState[key].caliber);
    if (!latest) {
      input.value = '';
      note.innerHTML = '当前没有已入库的 CEA 真实行情，无法从行情选择价格；请手动输入并自行记录日期与口径。';
      return false;
    }
    const value = latest[cal.field];
    if (!has(value)) {
      input.value = '';
      note.innerHTML = `最新交易日 ${esc(latest.trade_date)} 未披露「${esc(cal.label)}」，不能作为参考价（不用 0 代替）；请手动输入。`;
      return false;
    }
    input.value = String(value);
    priceState[key].picked = { date: latest.trade_date, price: Number(value), caliber: cal.label, source: latest.source_url || '官方行情 JSON', market: 'CEA' };
    note.innerHTML = `所选价格：<b>${esc(cal.label)} ${esc(num(value, 2))} 元/吨</b>｜交易日 <b>${esc(latest.trade_date)}</b>｜口径：${esc(cal.note)}｜来源：${esc(latest.source_url || '官方行情 JSON')}`;
    return true;
  };
  const applyCcerMarketPrice = (key) => {
    const input = body.querySelector(`[data-price="${key}"]`);
    const note = body.querySelector(`[data-price-note="${key}"]`);
    const sel = body.querySelector(`[data-caliber="${key}"]`);
    const mode = sel?.value || 'latest';
    if (!ccer.available) {
      input.value = '';
      priceState[key].picked = null;
      note.innerHTML = `当前没有可用的 CCER 独立行情（${esc(ccer.missing_reason || '库中无 CCER 成交行情')}）：只能手动输入 P2，并自行记录来源与日期；<b>不会用 CEA 价格顶替 CCER 价格</b>。`;
      return false;
    }
    let picked = null;
    if (mode === 'computed') {
      const c = ccer.computed_avg;
      if (c && has(c.value)) picked = { date: c.window, price: Number(c.value), caliber: c.caliber, source: '由 CCER 独立行情计算', market: 'CCER' };
    } else if (mode.startsWith('d:')) {
      const d = mode.slice(2);
      const q = (ccer.quotes || []).find((x) => x.trade_date === d);
      if (q) picked = { date: q.trade_date, price: q.price, caliber: q.caliber, source: q.source_url, market: 'CCER', verify_status: q.verify_status };
    } else if (ccer.latest) {
      picked = { date: ccer.latest.trade_date, price: ccer.latest.avg_price, caliber: ccer.latest.caliber, source: ccer.latest.source_url, market: 'CCER', verify_status: ccer.latest.verify_status };
    }
    if (!picked || !has(picked.price)) {
      input.value = '';
      priceState[key].picked = null;
      note.innerHTML = '所选 CCER 参考口径没有可用数值（不用 0 代替）：请手动输入。';
      return false;
    }
    input.value = String(picked.price);
    priceState[key].picked = picked;
    note.innerHTML = `所选价格：<b>CCER ${esc(num(picked.price, 2))} 元/吨</b>｜CCER 日期/窗口 <b>${esc(String(picked.date))}</b>｜口径：${esc(picked.caliber)}｜来源：${esc(picked.source || 'CCER 独立行情')}${picked.verify_status ? `｜核验状态：${esc(picked.verify_status)}` : ''}`
      + '<br><span class="muted">这是 CCER（国家核证自愿减排量）市场的价格，与 CEA 配额市场口径不同，不是 CEA 指数价。</span>';
    return true;
  };
  const applyMarketPrice = (key) => (key === 'P2' ? applyCcerMarketPrice(key) : applyCeaMarketPrice(key));
  body.querySelectorAll('[data-src]').forEach((sel) => {
    sel.addEventListener('change', () => {
      const key = sel.dataset.src;
      priceState[key].source = sel.value;
      const input = body.querySelector(`[data-price="${key}"]`);
      input.readOnly = sel.value === 'market';
      if (sel.value === 'market') applyMarketPrice(key);
      else {
        priceState[key].picked = null;
        body.querySelector(`[data-price-note="${key}"]`).textContent = '手动输入时请自行记录价格日期、来源与口径。';
      }
    });
  });
  body.querySelectorAll('[data-caliber]').forEach((sel) => {
    sel.addEventListener('change', () => {
      const key = sel.dataset.caliber;
      priceState[key].caliber = sel.value;
      if (priceState[key].source === 'market') applyMarketPrice(key);
    });
  });
  body.querySelector('[data-r-select]')?.addEventListener('change', (e) => {
    const opt = e.target.selectedOptions[0];
    const ratio = opt?.dataset.ratio;
    const note = body.querySelector('[data-r-note]');
    const custom = body.querySelector('[data-r-custom]');
    if (ratio === '' || ratio === undefined) {
      custom.disabled = false;
      note.textContent = '已选「自定义情景假设」：请填写比例（0—1），本平台不判断其合规性。';
    } else {
      custom.value = '';
      custom.disabled = true;
      note.textContent = `已选预设比例 ${ratio}：这是历史情景假设，不是所有年度的现行规则；实际可用比例以对应年度正式文件为准。`;
    }
  });

  body.querySelector('#scenario-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = body.querySelector('#scenario-result');
    const btn = body.querySelector('#scenario-submit');
    const val = (key) => body.querySelector(`[data-in="${key}"]`)?.value ?? '';
    const rSelect = body.querySelector('[data-r-select]');
    const rOpt = rSelect?.selectedOptions[0];
    const presetRatio = rOpt?.dataset.ratio;
    const r = presetRatio === '' || presetRatio === undefined ? body.querySelector('[data-r-custom]')?.value : presetRatio;
    if (r === '' || r === undefined || r === null) {
      out.innerHTML = errorState({ status: 400, body: { error: '请选择抵销比例 r：选择预设，或选「自定义情景假设」后填写比例（服务端不默认套用 5%）。' } });
      return;
    }
    const payload = {
      E: val('E'), A: val('A'), C: val('C'), U: val('U'), r,
      P1: body.querySelector('[data-price="P1"]').value,
      P2: body.querySelector('[data-price="P2"]').value,
      extra_cost: val('extra_cost') === '' ? 0 : val('extra_cost'),
      offset_ratio_source: presetRatio === '' || presetRatio === undefined ? 'user_custom' : `preset:${rSelect.value}`,
    };
    btn.disabled = true;
    btn.textContent = '计算中…';
    out.innerHTML = loading('正在计算情景差额…');
    try {
      const res = await api('/api/v2/cea/scenario', { method: 'POST', body: payload });
      out.innerHTML = scenarioResultHtml(res, latest, priceState);
    } catch (err) {
      out.innerHTML = `${errorState(err)}<p class="hint">若提示缺参数，请检查 E/A/C/U 与 P1/P2 是否都填写了数值（不接受空值，也不用 0 默认）。</p>`;
      toast(err.body?.error || err.message, 'danger');
    } finally {
      btn.disabled = false;
      btn.textContent = '计算情景差额';
    }
  });
  body.querySelector('#scenario-reset')?.addEventListener('click', () => {
    // 原生 reset 在事件之后执行：这里先恢复来源与只读状态，再让表单清空
    body.querySelectorAll('[data-src]').forEach((sel) => {
      sel.value = 'manual';
      const key = sel.dataset.src;
      priceState[key].source = 'manual';
      priceState[key].caliber = key === 'P2' ? 'latest' : 'close';
      priceState[key].picked = null;
      const input = body.querySelector(`[data-price="${key}"]`);
      if (input) input.readOnly = false;
      const note = body.querySelector(`[data-price-note="${key}"]`);
      if (note) note.textContent = '手动输入时请自行记录价格日期、来源与口径。';
    });
    body.querySelectorAll('[data-caliber]').forEach((sel) => {
      const key = sel.dataset.caliber;
      sel.value = key === 'P2' ? 'latest' : 'close';
    });
    body.querySelector('#scenario-result').innerHTML = emptyState('尚未计算', '填写参数后点击「计算情景差额」；结果只在本页显示，不写入数据库。');
  });

  // 初始化抵销比例提示（默认选中第一项预设，通常是「自定义情景假设」）
  body.querySelector('[data-r-select]')?.dispatchEvent(new Event('change'));
}

function scenarioResultHtml(res, latest, priceState) {
  const r = res.result || {};
  const inputs = res.inputs || {};
  const diff = Number(r.difference);
  const diffNote = diff < 0
    ? '差额为负：组合参考成本低于「仅买 CEA」的情景算术结果。这只是算术差，不构成购买建议，也不代表一定可以按该价格成交。'
    : '差额为正：组合参考成本高于「仅买 CEA」的情景算术结果（通常因抵销比例受限或 CCER 价格较高）。';
  const priceLines = ['P1', 'P2'].map((k) => {
    const st = priceState?.[k] || { source: 'manual' };
    const value = inputs[k];
    if (st.source === 'market' && st.picked) {
      const p = st.picked;
      return `<li>${k}：${num(value, 2)} 元/吨｜来源：<b>${esc(p.market)} 独立行情</b>（${esc(String(p.date))}，${esc(p.caliber)}）${p.source ? `｜${esc(String(p.source).slice(0, 120))}` : ''}</li>`;
    }
    if (st.source === 'market') {
      return `<li>${k}：${num(value, 2)} 元/吨｜来源：<b>所选行情没有可用数值，本次未取到参考价</b>（请核对后重填）</li>`;
    }
    return `<li>${k}：${num(value, 2)} 元/吨｜来源：手动输入（价格日期、来源与口径由使用者负责记录）</li>`;
  }).join('');
  return `
  <div class="quick-result">
    <div class="quick-headline">
      <span class="quick-label">缺口 D</span><span class="quick-value">${num(r.gap_D)}<i>吨CO2e</i></span>
      <span class="quick-label">情景使用抵销量 Q</span><span class="quick-value">${num(r.offset_used_Q)}<i>吨CO2e</i></span>
    </div>
    <div class="metrics metrics-sm" style="margin-top:12px">
      ${metric({ label: '可用抵销额度', value: num(r.offset_room), unit: '吨CO2e', sub: `= max(E×r − U, 0)｜r = ${num(inputs.r, 4)}（${esc(res.assumptions?.offset_ratio_source || 'user_input')}）`, asOf: '', source: '情景算术' })}
      ${metric({ label: '剩余抵销额度', value: num(r.remaining_offset_room), unit: '吨CO2e', sub: '= max(额度 − 情景使用量, 0)', asOf: '', source: '情景算术' })}
      ${metric({ label: '仅买 CEA 成本', value: num(r.cea_only_cost), unit: '元', sub: `= D × P1 = ${num(r.gap_D)} × ${num(inputs.P1, 2)}`, asOf: '', source: '情景算术' })}
      ${metric({ label: '组合参考成本', value: num(r.combined_reference_cost), unit: '元', sub: `= (D − Q) × P1 + Q × P2 + 新增费用（${num(inputs.extra_cost)} 元）`, asOf: '', source: '情景算术' })}
      ${metric({ label: '差额（可能为负）', value: num(r.difference), unit: '元', sub: r.difference_kind || '情景算术差额', note: diffNote, asOf: '', source: '情景算术', warn: diff < 0 })}
    </div>
    <h5>本次使用的参考价格</h5>
    <ul class="bullets">${priceLines}</ul>
    <h5>假设与边界</h5>
    <ul class="bullets">
      <li>${esc(res.assumptions?.offset_ratio_note || '')}</li>
      <li>${esc(res.assumptions?.price_note || '')}</li>
    </ul>
    <div class="callout callout-warn"><b>临时情景算术，不保存参数，不自动建议购买</b>
      <p>${esc(res.disclaimer || '')}</p>
      <p class="hint">5% 不是所有年度的现行规则；本结果不写入任何台账（persisted = ${res.persisted ? 'true' : 'false'}）。</p>
    </div>
  </div>`;
}

/* ==================================================================== */
/*  七、研报动态                                                        */
/* ==================================================================== */

async function renderResearch(body, q) {
  const docType = q.doc_type || '';
  const viewpoint = q.viewpoint || '';
  const keyword = q.q || '';
  const issuer = q.issuer || '';
  const data = await api(`/api/v2/cea/research?${qs({ doc_type: docType, viewpoint, q: keyword, issuer, limit: 100 })}`);
  const rows = data.rows || [];
  const gaps = data.open_gaps || [];
  const isRepost = (r) => String(r.discovery?.source_kind || '') === 'media_repost';

  body.innerHTML = `
  <div class="filters">
    <label class="fld"><span>关键词</span><input type="search" data-f="q" value="${esc(keyword)}" placeholder="标题关键词"></label>
    <label class="fld"><span>类型</span><select data-f="doc_type"><option value="">全部</option>
      <option value="research" ${docType === 'research' ? 'selected' : ''}>研报</option>
      <option value="news" ${docType === 'news' ? 'selected' : ''}>行业动态</option></select></label>
    <label class="fld"><span>观点标记</span><select data-f="viewpoint"><option value="">全部</option>
      ${Object.entries(VIEWPOINT_LABEL).map(([k, l]) => `<option value="${k}" ${viewpoint === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
    <label class="fld"><span>机构</span><input type="search" data-f="issuer" value="${esc(issuer)}" placeholder="如 上海环境能源交易所"></label>
    <span class="fld-actions">${exportLinks('research', { doc_type: docType, viewpoint })}<button class="btn btn-sm" data-reset>重置</button></span>
  </div>

  <div class="callout">
    <b>列表只收录已取得正文的条目</b>
    <p>入库要求 evidence_level = full_text（真实取得的正文）；搜索摘要不作为事实，聚合/转载站会显式标注为非第一来源。</p>
    <p class="hint">${esc(data.note || '')}</p>
  </div>

  <div class="metrics metrics-sm">
    ${metric({ label: 'CEA 研报与动态', value: num(data.total), unit: '条', sub: `研究观点 ${num(data.by_viewpoint?.research_opinion || 0)}｜行业动态 ${num(data.by_viewpoint?.market_news || 0)}`, asOf: '', source: 'cea_document（doc_type=research/news，full_text）' })}
    ${metric({ label: '已取得全文', value: num(rows.filter((r) => r.evidence_level === 'full_text').length), unit: '条', sub: '未取得正文的候选不写入本列表', asOf: '', source: 'cea_document.evidence_level' })}
    ${metric({ label: '非第一来源（聚合/转载）', value: num(rows.filter(isRepost).length), unit: '条', sub: '已显式标注，不作为公开第一来源', asOf: '', source: 'cea_document.discovery_json.source_kind', warn: rows.some(isRepost) })}
    ${metric({ label: '发布日期未标注', value: num(rows.filter((r) => !r.publish_date).length), unit: '条', sub: '来源未标注时显示「未标注」，不用采集时间代替', asOf: '', source: 'cea_document.publish_date' })}
  </div>

  ${card({
    title: 'CEA 研报与行业动态',
    subtitle: '公开第一来源、机构、发布日期、数据截止日与观点标记分列；观点类不作为现行规则依据',
    actions: exportLinks('research', { doc_type: docType, viewpoint }),
    body: (rows.length ? table({
      rows,
      pageSize: 25,
      columns: [
        { key: 'publish_date', label: '发布日期', render: (r) => (r.publish_date ? esc(shortDate(r.publish_date)) : '<span class="muted">未标注</span>') },
        { key: 'data_cutoff_date', label: '数据截止日', render: (r) => {
          if (!r.data_cutoff_date) return '<span class="muted">未标注</span>';
          // 按原文精度显示：只到月/年时不显示成具体某一天（docs/35 第 5 条）
          const label = r.data_cutoff_display || r.data_cutoff_date;
          const raw = r.data_cutoff_raw ? ` title="${esc(r.data_cutoff_raw)}"` : '';
          return `<span${raw}>${esc(label)}</span>`;
        } },
        { key: 'viewpoint', label: '观点标记', render: (r) => chip(VIEWPOINT_LABEL[r.viewpoint] || r.viewpoint, r.is_viewpoint ? 'warn' : 'accent') },
        { key: 'title', label: '标题与核心摘要', render: (r) => `<span class="title-cell" title="${esc(r.title)}">${esc(truncate(r.title, 52))}</span>${summaryBlock(r, { compact: true })}` },
        { key: 'source_display', label: '来源', definition: '官方信息 / 第三方实际发布机构 / 来源未标注', render: (r) => sourceBlock(r) },
        { key: 'source_kind', label: '来源类型', render: (r) => {
          const kind = r.discovery?.source_kind_label || r.discovery?.source_kind || '未标注';
          const host = r.discovery?.source_host ? `<div class="muted">${esc(r.discovery.source_host)}</div>` : '';
          return `${chip(kind, isRepost(r) ? 'warn' : 'muted')}${isRepost(r) ? '<div class="muted">聚合/转载站：非公开第一来源</div>' : ''}${host}`;
        } },
        { key: 'first_source', label: '公开第一来源', render: (r) => (r.first_source
          ? `<a class="link src-link" href="${esc(r.first_source)}" target="_blank" rel="noreferrer noopener">原文</a>`
          : `<span class="muted" title="${esc(r.page_url || '')}">未确认（本页为转载/聚合：不冒充第一来源）</span>`) },
      ],
      emptyText: '没有符合条件的研报或动态',
    }) + summaryCoverageHint(rows) : emptyState(
      '尚未采集到 CEA 研报与行业动态',
      '需要有界定向发现 + 全文取得后才入库；只拿到搜索摘要时不写入列表。',
      `真实缺口 ${gaps.length} 项，见下方缺口说明`
    )) + (gaps.length ? `<h5>真实缺口（open_gaps）</h5><ul class="list">${gaps.map((g) => `<li>
        <div class="list-head"><b>${esc(g.title)}</b><span class="muted right">${esc(g.dataset || '')}</span></div>
        <p class="muted">${esc(truncate(g.description || '', 240))}</p>
        <p class="hint">影响：${esc(g.impact || '—')}｜自动处理路径：${esc(g.manual_path || '由每日自动任务重试与补全')}｜状态：${esc(g.status || 'open')}</p>
      </li>`).join('')}</ul>`
      : '<p class="hint">当前没有与研报/动态相关的未结清缺口。</p>')
      + noteBlock('下载文件由服务端按「类型 / 观点标记」生成；「机构」筛选只在列表接口生效，导出如需按机构筛选请用关键词 q。'),
  })}

  <div class="callout">
    <b>想按 CCER 视角看研报与动态？</b>
    <p>本页只展示 CEA（全国碳排放配额）相关的公开研报与行业动态；CCER 公开研报与动态在「研报与行业动态」模块中，可按机构、类型与核验状态筛选。</p>
    <p><a class="btn btn-sm" href="#/content">前往研报与行业动态模块</a></p>
  </div>`;

  wireFilters(body, ['q', 'issuer']);
}

/* ==================================================================== */
/*  八、来源与缺口                                                      */
/* ==================================================================== */

async function renderSources(body) {
  const data = await api('/api/v2/cea/sources/status');
  const sync = data.sync || {};
  const cfg = sync.config || {};
  const quota = sync.quota || data.quota || {};
  const ai = sync.ai || {};
  const verify = data.verification || {};
  const sources = data.sources || [];
  const gaps = data.gaps || [];

  body.innerHTML = `
  <div class="callout">
    <b>失败如实展示，不美化</b>
    <p>${esc(data.note || '')}</p>
    <p class="hint">密钥类信息不在此展示；模型与连接只显示「是否可用 / 名称」，不显示任何凭据。</p>
  </div>

  <div class="metrics metrics-sm">
    ${metric({ label: 'CEA 来源登记', value: num(sources.length), unit: '个', sub: `启用 ${num(sources.filter((s) => s.enabled).length)} 个｜最近失败 ${num(sources.filter((s) => s.last_status === 'failed').length)} 个`, asOf: '', source: 'cea_source', warn: sources.some((s) => s.last_status === 'failed') })}
    ${metric({ label: '当日抓取配额', value: `${num(quota.used)} / ${num(quota.limit)}`, unit: '次', sub: `剩余 ${num(quota.remaining)} 次｜统计日期 ${esc(quota.date || '—')}`, asOf: quota.date, source: 'source_snapshot（当日 CEA 域名抓取计数）' })}
    ${metric({ label: '未结清缺口', value: num(gaps.length), unit: '项', sub: '缺口台账如实登记，不用占位数据顶替', asOf: '', source: 'data_gap（dataset like cea%）', warn: gaps.length > 0 })}
    ${metric({ label: 'AI 核验能力', value: ai.provider_configured ? '可用' : '不可用', unit: '', sub: ai.provider_configured ? `模型：${esc(ai.model || '已配置')}（不显示凭据）` : (ai.note || '未配置可用模型：CEA 条目保持未核验'), asOf: '', source: 'verification-svc 配置', warn: !ai.provider_configured })}
  </div>

  <div class="grid-2">
    ${card({
      title: '采集运行配置（服务端实际生效值）',
      subtitle: cfg.enabled ? 'CEA 采集已启用' : 'CEA 采集已停用（后台配置）',
      actions: state.user?.role === 'admin' ? '<a class="btn btn-sm" href="#/admin?tab=cea">在后台修改</a>' : '',
      body: kv([
        ['采集开关', cfg.enabled ? chip('已启用', 'ok') : chip('已停用', 'warn')],
        ['单批时间上限', `${num(cfg.batch_budget_ms)} 毫秒`],
        ['每轮最多新增', `${num(cfg.max_items_per_round)} 条`],
        ['最多补证轮数', `${num(cfg.max_evidence_rounds)} 轮`],
        ['单条请求超时', `${num(cfg.request_timeout_ms)} 毫秒`],
        ['每日抓取上限', `${num(cfg.daily_fetch_limit)} 次`],
        ['采集后自动核验', cfg.auto_verify ? '开启' : '关闭'],
        ['收盘后采集时刻', esc(cfg.after_close_time || '—')],
        ['搜索服务', sync.search?.configured ? `${esc(sync.search.name || '已配置')}（${sync.search.enabled ? '启用' : '停用'}）` : '未配置'],
        ['网页抓取连接', sync.fetch?.configured ? `${esc(sync.fetch.name || '已配置')}（${esc(sync.fetch.conn_kind || '')}）` : '未配置'],
      ]) + noteBlock('以上为服务端硬上限内的实际生效值；超过上限的配置会被服务端拒绝（400）。'),
    })}
    ${card({
      title: '核验策略',
      subtitle: verify.enabled ? '核验已启用' : '核验未启用',
      body: kv([
        ['核验开关', verify.enabled ? chip('已启用', 'ok') : chip('未启用', 'warn')],
        ['可用模型', verify.provider_configured ? chip('已配置', 'ok') : chip('未配置', 'warn')],
        ['适用对象', esc((verify.scopes || []).join('、') || '—')],
      ]) + noteBlock(verify.note || ''),
    })}
  </div>

  ${card({
    title: '来源状态',
    subtitle: '每个来源的最后状态、最后错误与最后成功时间均来自真实运行记录',
    body: sources.length ? table({
      rows: sources,
      pageSize: 12,
      columns: [
        { key: 'code', label: '来源代码', render: (r) => `<code>${esc(r.code)}</code>` },
        { key: 'name', label: '名称', render: (r) => esc(truncate(r.name, 30)) },
        { key: 'dataset', label: '数据集' },
        { key: 'kind', label: '类型', render: (r) => esc(r.kind || '—') },
        { key: 'enabled', label: '启用', render: (r) => (r.enabled ? chip('启用', 'ok') : chip('停用', 'muted')) },
        { key: 'priority', label: '优先级', align: 'right' },
        { key: 'last_status', label: '最后状态', render: (r) => (r.last_status === 'ok' ? chip('成功', 'ok') : r.last_status === 'failed' ? chip('失败', 'danger') : chip(r.last_status || '未运行', 'muted')) },
        { key: 'last_success_at', label: '最后成功', render: (r) => esc(dateTime(r.last_success_at)) },
        { key: 'items_ok', label: '成功条目', align: 'right', render: (r) => num(r.items_ok) },
        { key: 'items_failed', label: '失败条目', align: 'right', render: (r) => num(r.items_failed) },
        { key: 'last_error', label: '最后错误', render: (r) => (r.last_error ? `<span class="muted">${esc(truncate(r.last_error, 90))}</span>` : '—') },
        { key: 'url', label: '来源地址', render: (r) => (r.url ? `<a class="link" href="${esc(r.url)}" target="_blank" rel="noreferrer noopener">打开</a>` : '—') },
      ],
      emptyText: '尚未登记 CEA 来源',
    }) : emptyState('尚未登记 CEA 来源', '来源登记由服务端种子数据维护（不含任何行情数值）。'),
  })}

  <div class="grid-2">
    ${card({
      title: '数据集游标与最近任务',
      subtitle: '游标记录每个数据集的最后尝试/成功状态；失败不掩盖成功时间',
      body: `${(sync.cursors || []).length ? table({
        rows: sync.cursors,
        pageSize: 8,
        columns: [
          { key: 'dataset', label: '数据集' },
          { key: 'last_status', label: '最后状态', render: (r) => (r.last_status === 'success' ? chip('成功', 'ok') : chip(r.last_status || '—', r.last_status === 'failed' ? 'danger' : 'warn')) },
          { key: 'last_attempt_at', label: '最后尝试', render: (r) => esc(dateTime(r.last_attempt_at)) },
          { key: 'last_success_at', label: '最后成功', render: (r) => esc(dateTime(r.last_success_at)) },
          { key: 'items_seen', label: '发现', align: 'right', render: (r) => num(r.items_seen) },
          { key: 'items_new', label: '新增', align: 'right', render: (r) => num(r.items_new) },
          { key: 'last_error', label: '最后错误', render: (r) => esc(truncate(r.last_error || '—', 60)) },
        ],
      }) : emptyState('暂无游标记录')}
      <h5>缺口按数据集汇总</h5>
      ${(sync.gaps || []).length ? `<ul class="bullets">${(sync.gaps || []).map((g) => `<li>${esc(g.dataset)}：${num(g.c)} 项未结清</li>`).join('')}</ul>` : '<p class="muted">没有未结清缺口。</p>'}`,
    })}
    ${card({
      title: '最近 CEA 任务',
      subtitle: '任务状态、失败原因与错误摘要',
      actions: state.user?.role === 'admin' ? '<a class="btn btn-sm" href="#/admin?tab=cea">在后台查看任务明细</a>' : '',
      body: (sync.last_jobs || []).length ? table({
        rows: sync.last_jobs,
        pageSize: 8,
        columns: [
          { key: 'job_key', label: '任务' },
          { key: 'status', label: '状态', render: (r) => chip(r.status, r.status === 'success' ? 'ok' : r.status === 'failed' ? 'danger' : 'warn') },
          { key: 'started_at', label: '开始', render: (r) => esc(dateTime(r.started_at)) },
          { key: 'finished_at', label: '结束', render: (r) => esc(dateTime(r.finished_at)) },
          { key: 'items_published', label: '入库', align: 'right' },
          { key: 'error_count', label: '问题', align: 'right' },
          { key: 'error_summary', label: '错误摘要', render: (r) => esc(truncate(r.error_summary || '—', 60)) },
        ],
      }) : emptyState('还没有 CEA 采集任务', '首次采集后在此显示真实运行结果。'),
    })}
  </div>

  ${card({
    title: '缺口台账（如实登记）',
    subtitle: `${gaps.length} 项未结清｜缺口由自动流程登记与结清，不产生人工待办`,
    body: gaps.length ? table({
      rows: gaps,
      pageSize: 12,
      columns: [
        { key: 'gap_key', label: '缺口键', render: (r) => `<code>${esc(truncate(r.gap_key, 46))}</code>` },
        { key: 'title', label: '标题', render: (r) => `<span title="${esc(r.title)}">${esc(truncate(r.title, 50))}</span>` },
        { key: 'dataset', label: '数据集', render: (r) => esc(r.dataset || '—') },
        { key: 'severity', label: '级别', render: (r) => chip(r.severity === 'critical' ? '严重' : r.severity === 'warning' ? '警告' : (r.severity || '一般'), r.severity === 'critical' ? 'danger' : r.severity === 'warning' ? 'warn' : 'muted') },
        { key: 'impact', label: '影响', render: (r) => esc(truncate(r.impact || '—', 70)) },
        { key: 'manual_path', label: '补全路径', render: (r) => esc(truncate(r.manual_path || '由每日自动任务重试', 50)) },
        { key: 'gap_status', label: '状态', render: (r) => chip(r.status === 'open' ? '未结清' : (r.status || '—'), r.status === 'open' ? 'warn' : 'ok') },
        { key: 'detected_at', label: '发现时间', render: (r) => esc(dateTime(r.detected_at)) },
      ],
      emptyText: '没有未结清缺口',
    }) : emptyState('没有未结清缺口', '所有已发现的缺口都已由后续采集自动结清（结清记录保留在台账中）。'),
  })}`;
}
