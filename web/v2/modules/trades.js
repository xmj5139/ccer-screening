/**
 * 模块四：交易信息
 * ============================================================================
 * 需求规格 1.4：
 *   - 以全国温室气体自愿减排交易系统官方行情为首选来源；
 *   - 字段：交易日期、成交量、成交额、当日成交均价、来源、发布时间；
 *   - 有成交 / 无成交交易日 / 休市 / 数据暂缺 四种状态分别显示，不用一个 0 混淆；
 *   - 区间成交均价 = Σ成交额 ÷ Σ成交量（不取日均价的简单平均）；
 *   - 累计数据与官方披露累计值核对，差异告警并保留原始记录；
 *   - 图表数据、筛选明细、月/年汇总均可下载 CSV/Excel，文件含口径与来源。
 */
import { api, setQuery, state } from '../app.js';
import {
  card, table, loading, emptyState, errorState, noteBlock, esc, shortDate, dateTime, chip,
  drawer, kv, toast, num, delta, comboChart, barChart, calendarGrid,
  lineChart, bindChartToggles, groupedBarChart,
} from '../ui.js';

const GRANULARITY = [
  { value: 'day', label: '按日' },
  { value: 'month', label: '按月' },
  { value: 'quarter', label: '按季' },
  { value: 'year', label: '按年' },
];

/** 品种切换：CCER（原有视图）｜CEA（全国碳排放配额）｜同日对比 */
const VARIETIES = [
  { key: 'ccer', label: 'CCER' },
  { key: 'cea', label: 'CEA（全国碳排放配额）' },
  { key: 'compare', label: '同日对比（CEA / CCER）' },
];

function varietyBar(current, q = {}) {
  const rest = Object.fromEntries(Object.entries(q).filter(([k, v]) => v && k !== 'variety' && k !== 'tab'));
  return `<div class="tabs"><span class="tab-label">品种</span>${VARIETIES.map((v) => {
    const params = new URLSearchParams({ ...rest, variety: v.key });
    return `<a class="tab ${v.key === current ? 'active' : ''}" href="#/trades?${params.toString()}">${esc(v.label)}</a>`;
  }).join('')}</div>`;
}

export async function renderTrades(root, route) {
  const q = route.query || {};
  const variety = ['cea', 'compare'].includes(q.variety) ? q.variety : 'ccer';
  if (variety === 'cea') { await renderCeaTrades(root, q); return; }
  if (variety === 'compare') { await renderCompareTrades(root, q); return; }
  const rangeDays = q.range_days || '365';
  const granularity = q.granularity || 'month';
  const from = q.from || '';
  const to = q.to || '';
  root.innerHTML = loading('正在加载交易信息…');

  const query = { from, to, range_days: rangeDays, granularity };
  const qs = (obj) => new URLSearchParams(Object.fromEntries(Object.entries(obj).filter(([, v]) => v))).toString();

  let overview; let daily; let summary; let dims; let cal; let cumulative;
  try {
    [overview, daily, summary, dims, cal, cumulative] = await Promise.all([
      api(`/api/v2/trade/overview?range_days=${encodeURIComponent(rangeDays)}`),
      api(`/api/v2/trade/daily?${qs({ from, to, limit: 800 })}`),
      api(`/api/v2/trade/summary?${qs({ from, to, granularity })}`),
      api(`/api/v2/trade/dimensions?${qs({ from, to })}`),
      api(`/api/v2/trade/calendar?${qs({ from, to, limit: 400 })}`),
      api('/api/v2/trade/cumulative'),
    ]);
  } catch (e) {
    root.innerHTML = errorState(e);
    return;
  }

  const c = overview.counts || {};
  const latest = overview.latest_traded;
  const cum = cumulative || {};
  const chartPoints = (summary.buckets || []).map((b) => ({ trade_date: b.label || b.bucket, volume: b.volume, avg_price: b.avg_price }));

  root.innerHTML = `
  ${varietyBar('ccer', q)}
  <div class="filters">
    <label class="fld"><span>走势区间</span><select data-f="range_days">
      ${[['30', '近 30 天（走势统计）'], ['90', '近 90 天'], ['365', '近 1 年'], ['1200', '全部']]
        .map(([v, l]) => `<option value="${v}" ${String(rangeDays) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <label class="fld"><span>汇总粒度</span><select data-f="granularity">
      ${GRANULARITY.map((g) => `<option value="${g.value}" ${granularity === g.value ? 'selected' : ''}>${g.label}</option>`).join('')}</select></label>
    <label class="fld"><span>明细起</span><input type="date" data-f="from" value="${esc(from)}"></label>
    <label class="fld"><span>明细止</span><input type="date" data-f="to" value="${esc(to)}"></label>
    <span class="fld-actions">
      <button class="btn btn-sm btn-primary" data-collect>采集官方最新行情</button>
      <button class="btn btn-sm" data-run-checks>执行自动核对</button>
    </span>
  </div>

  <div class="metrics">
    ${metric('最新有成交交易日', latest ? latest.trade_date : '—', '', latest ? `成交量 ${num(latest.volume)} tCO₂e｜成交额 ${num(latest.turnover)} 元` : '尚无有成交的交易日',
      latest ? `成交均价 ${num(latest.avg_price, 2)} 元/tCO₂e（官方披露值，不是收盘价）` : '未导入前不显示 0 元价格', latest ? latest.trade_date : overview.as_of,
      latest ? `全国温室气体自愿减排交易系统${latest.source_url ? `｜${latest.source_url}` : ''}` : '官方每日行情公告', 'trade.avg_price')}
    ${metric('系统累计成交量', num(cum.system?.volume), 'tCO₂e', `覆盖 ${esc(cum.system?.from_date || '—')} ~ ${esc(cum.system?.to_date || '—')}（${cum.system?.days ?? 0} 个交易日）`,
      '系统内已导入且按日存储的成交量之和', cum.system?.to_date || overview.as_of, '交易信息 · 每日行情（已导入范围）', 'trade.cumulative')}
    ${metric('官方披露累计成交量', num(cum.official_latest?.volume_total), 'tCO₂e', cum.official_latest ? `截至 ${esc(cum.official_latest.as_of_date)}｜累计成交额 ${num(cum.official_latest.turnover_total)} 元` : '尚未采集到官方累计值',
      cum.check?.delta_check_available ? '系统与官方累计值可做差分校对' : '覆盖区间不完整时只并列显示，不宣称一致', cum.official_latest?.as_of_date || overview.as_of, '官方公告原文「截至…累计成交量」', 'trade.cumulative')}
    ${metric('行情自动核对', `${c.pending ?? 0} 待自动核对`, '', `系统自动核对通过 ${c.verified ?? 0}｜与官方不符 ${c.mismatch ?? 0}｜无成交交易日 ${c.no_trade_days ?? 0}`,
      `未结清数据异常 ${c.open_anomalies ?? 0} 条；异常由自动核对标注、可检索，不产生人工核对任务`, overview.as_of, '每日自动核对任务', 'dash.data_anomaly')}
  </div>

  <div class="grid-2">
    ${card({
      title: `市场走势（${granularity === 'month' ? '按月' : granularity === 'day' ? '按日' : granularity === 'quarter' ? '按季' : '按年'}）`,
      subtitle: `${summary.from || '—'} ~ ${summary.to || '—'}｜区间成交均价 = Σ成交额 ÷ Σ成交量`,
      actions: `<a class="btn btn-sm" href="/api/v2/trade/export?format=csv&dataset=summary&granularity=${granularity}${from ? `&from=${from}` : ''}${to ? `&to=${to}` : ''}" download>下载汇总</a>
                <a class="btn btn-sm" href="/api/v2/trade/export?format=xlsx&dataset=daily${from ? `&from=${from}` : ''}${to ? `&to=${to}` : ''}" download>下载明细</a>`,
      body: comboChart({ points: chartPoints }) + noteBlock(summary.note),
    })}
    ${card({
      title: '交易日历',
      subtitle: `有成交 ${cal.counts?.traded ?? 0}｜无成交 ${cal.counts?.no_trade ?? 0}｜休市 ${cal.counts?.closed ?? 0}｜数据暂缺 ${cal.counts?.missing ?? 0}`,
      body: calendarGrid(cal.days) + noteBlock(cal.note),
    })}
  </div>

  <div class="grid-2">
    ${card({
      title: `${GRANULARITY.find((g) => g.value === granularity)?.label}汇总`,
      subtitle: '同比/环比仅在上期有完整交易覆盖时给出，否则为空（不推测）',
      body: table({
        rows: summary.buckets || [],
        pageSize: 12,
        columns: [
          { key: 'label', label: '区间', render: (r) => esc(r.label || r.bucket) },
          { key: 'volume', label: '成交量', unit: 'tCO₂e', align: 'right', render: (r) => num(r.volume) },
          { key: 'turnover', label: '成交额', unit: '元', align: 'right', render: (r) => num(r.turnover) },
          { key: 'avg_price', label: '区间均价', unit: '元/tCO₂e', align: 'right', render: (r) => num(r.avg_price, 2) },
          { key: 'traded_days', label: '有成交天数', align: 'right' },
          { key: 'no_trade_days', label: '无成交天数', align: 'right' },
          { key: 'yoy_pct', label: '同比', align: 'right', render: (r) => (r.yoy_available ? delta(r.yoy_pct) : '—') },
          { key: 'prev_period_pct', label: '环比', align: 'right', render: (r) => (r.prev_period_available ? delta(r.prev_period_pct) : '—') },
        ],
        emptyText: '区间内暂无数据',
      }),
    })}
    ${card({
      title: '行业维度拆分',
      subtitle: dims.available ? '来自官方「每日行情」分行业数据' : '尚未采集到官方分行业数据',
      actions: '<button class="btn btn-sm" data-collect>采集（含分行业）</button>',
      body: dims.available
        ? table({
            rows: dims.by_value || [],
            pageSize: 6,
            columns: [
              { key: 'dimension_value', label: '行业' },
              { key: 'volume', label: '累计成交量', unit: 'tCO₂e', align: 'right', render: (r) => num(r.volume) },
              { key: 'turnover', label: '累计成交额', unit: '元', align: 'right', render: (r) => num(r.turnover) },
              { key: 'avg_price', label: '区间均价', unit: '元/tCO₂e', align: 'right', render: (r) => num(r.avg_price, 2) },
              { key: 'days', label: '有成交天数', align: 'right' },
            ],
          }) + noteBlock(dims.note)
        : emptyState('暂无分行业维度数据', dims.note),
    })}
  </div>

  ${card({
    title: '累计口径核对',
    subtitle: cum.check?.delta_check_available ? '系统与官方累计值已具备差分校对条件' : '覆盖区间不完整：仅并列展示，不宣称一致',
    body: `${kv([
      ['系统累计成交量', `${num(cum.system?.volume)} tCO₂e（${esc(cum.system?.from_date || '—')} ~ ${esc(cum.system?.to_date || '—')}）`],
      ['系统累计成交额', `${num(cum.system?.turnover)} 元`],
      ['官方累计成交量', cum.official_latest ? `${num(cum.official_latest.volume_total)} tCO₂e（截至 ${esc(cum.official_latest.as_of_date)}）` : '—'],
      ['官方累计成交额', cum.official_latest ? `${num(cum.official_latest.turnover_total)} 元` : '—'],
      ['差分基准日', esc(cum.check?.baseline_as_of || '—')],
      ['差分应有成交量', cum.check?.delta_expected_volume === null || cum.check?.delta_expected_volume === undefined ? '—' : `${num(cum.check.delta_expected_volume)} tCO₂e`],
    ])}${noteBlock(cum.check?.note)}`,
  })}

  ${card({
    title: '每日行情明细',
    subtitle: `共 ${daily.total} 条｜导出包含字段定义、单位、来源、抓取/核对时间与是否修订`,
    actions: `<a class="btn btn-sm" href="/api/v2/trade/export?format=csv${from ? `&from=${from}` : ''}${to ? `&to=${to}` : ''}" download>导出 CSV</a>
              <a class="btn btn-sm" href="/api/v2/trade/export?format=xlsx${from ? `&from=${from}` : ''}${to ? `&to=${to}` : ''}" download>导出 Excel</a>
              <button class="btn btn-sm" data-revisions>修订留痕</button>`,
    body: table({
      rows: daily.rows || [],
      pageSize: 20,
      columns: [
        { key: 'trade_date', label: '交易日期', render: (r) => esc(r.trade_date) },
        { key: 'weekday', label: '星期' },
        { key: 'session_label', label: '状态', render: (r) => chip(r.session_label, r.session_state === 'traded' ? 'ok' : r.session_state === 'missing' ? 'warn' : '') },
        { key: 'volume', label: '成交量', unit: 'tCO₂e', align: 'right', render: (r) => num(r.volume) },
        { key: 'turnover', label: '成交额', unit: '元', align: 'right', render: (r) => num(r.turnover) },
        { key: 'avg_price', label: '官方均价', unit: '元/tCO₂e', align: 'right', render: (r) => (r.avg_price === null ? '<span class="muted">未披露</span>' : num(r.avg_price, 2)) },
        { key: 'avg_price_derived', label: '均价计算值', align: 'right', render: (r) => (r.avg_price_derived === null ? '—' : `<span class="muted">${num(r.avg_price_derived, 2)}</span>`) },
        { key: 'verify_label', label: '自动核对', render: (r) => chip(r.verify_label, r.verify_status === 'verified' ? 'ok' : r.verify_status === 'mismatch' ? 'danger' : 'warn') },
        { key: 'revision', label: '版本', align: 'right', render: (r) => (r.revision > 1 ? chip(`第 ${r.revision} 版`, 'warn') : '1') },
        { key: 'published_at', label: '官方发布', render: (r) => esc(r.published_at || '—') },
        { key: 'source_url', label: '来源', render: (r) => (r.source_url ? `<a class="link" href="${esc(r.source_url)}" target="_blank" rel="noreferrer noopener">官方公告</a>` : '—') },
      ],
      emptyText: '尚无行情明细',
      emptyHint: '点击「采集官方最新行情」从官方公告导入；也可用「每日行情导入模板」导入公开数据',
    }) + noteBlock('成交均价 = 当日成交额 ÷ 当日成交量，不是收盘价；官方未披露均价时留空并给出「计算值」列（标注为计算值）。行情核对由系统自动执行，平台不设人工核对按钮。'),
  })}`;

  /* ---- 交互 ---- */
  const debounceMap = {};
  root.querySelectorAll('[data-f]').forEach((el) => {
    el.addEventListener('change', () => setQuery({ [el.dataset.f]: el.value }));
  });
  root.querySelectorAll('[data-collect]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    b.textContent = '采集中…';
    try {
      const out = await api('/api/v2/trade/collect', { method: 'POST', body: { limit: 20, onlyNew: true, withDimension: true } });
      toast(`采集完成：新增/更新 ${out.collected_count ?? 0} 个交易日；核对由系统自动执行，不产生人工任务`, 'ok');
      renderTrades(document.getElementById('module-root'), state.route);
    } catch (e) {
      toast(e.body?.error || e.message, 'danger');
      b.disabled = false;
      b.textContent = '采集官方最新行情';
    }
  }));
  root.querySelector('[data-run-checks]')?.addEventListener('click', async () => {
    try {
      const out = await api('/api/v2/trade/checks/run', { method: 'POST', body: {} });
      toast(`自动核对完成：检查 ${out.checked ?? 0} 项，标注差异 ${out.issues ?? 0} 项（无人工任务）`, out.issues ? 'warn' : 'ok');
      renderTrades(document.getElementById('module-root'), state.route);
    } catch (e) {
      toast(e.body?.error || e.message, 'danger');
    }
  });
  root.querySelector('[data-revisions]')?.addEventListener('click', async () => {
    const d = await api('/api/v2/trade/revisions?limit=200');
    document.body.insertAdjacentHTML('beforeend', drawer('历史修订留痕', d.revisions?.length
      ? `<table class="grid grid-sm"><thead><tr><th>交易日</th><th>字段</th><th>旧值</th><th>新值</th><th>原因</th><th>时间</th><th>操作人</th></tr></thead>
         <tbody>${d.revisions.map((r) => `<tr><td>${esc(r.trade_date)}</td><td>${esc(r.field)}</td><td>${esc(r.old_value ?? '—')}</td>
         <td>${esc(r.new_value ?? '—')}</td><td>${esc(r.reason || '')}</td><td>${esc(dateTime(r.revised_at))}</td><td>${esc(r.revised_by || '')}</td></tr>`).join('')}</tbody></table>`
      : '<p class="muted">没有修订记录。历史修订保留新旧值，不静默覆盖。</p>', { wide: true }));
  });
  root.addEventListener('click', async (e) => {
    const cal2 = e.target.closest('[data-caliber]');
    if (cal2) {
      const key = cal2.dataset.caliber;
      const metrics = await api('/api/v2/meta/metrics');
      const m = (metrics.metrics || []).find((x) => x.key === key);
      document.body.insertAdjacentHTML('beforeend', drawer('来源与口径', m
        ? `<h4>${esc(m.label)}</h4><p><b>口径：</b>${esc(m.caliber)}</p><p><b>单位：</b>${esc(m.unit || '—')}</p><p><b>数据源：</b>${esc(m.source_note || '—')}</p>`
        : '<p>未找到口径定义。</p>'));
      return;
    }
  });
}

function metric(label, value, unit, sub, note, asOf, source, caliberKey) {
  return `<article class="metric">
    <div class="metric-head"><span class="metric-label">${esc(label)}</span></div>
    <div class="metric-value">${esc(value)}<span class="metric-unit">${esc(unit || '')}</span></div>
    <div class="metric-sub">${esc(sub || '')}</div>
    <div class="metric-note">${esc(note || '')}</div>
    <div class="metric-foot"><span>截至 ${esc(shortDate(asOf))}</span><span>来源：${esc(source)}</span>
      ${caliberKey ? `<button class="link" data-caliber="${esc(caliberKey)}">口径</button>` : ''}</div>
  </article>`;
}

/* ============================ CEA 品种视图 ============================ */

/** CEA 独立行情（全国碳排放配额）：与 CCER 分表、分口径，不合并统计 */
async function renderCeaTrades(root, q) {
  root.innerHTML = `${varietyBar('cea', q)}${loading('正在加载 CEA 行情…')}`;
  const from = q.from || '';
  const to = q.to || '';
  let overview; let trade; let summary;
  try {
    [overview, trade, summary] = await Promise.all([
      api('/api/v2/cea/overview'),
      api(`/api/v2/cea/trade?${new URLSearchParams({ from, to, limit: '60' }).toString()}`),
      api(`/api/v2/cea/summary?${new URLSearchParams({ from, to }).toString()}`),
    ]);
  } catch (e) {
    root.innerHTML = `${varietyBar('cea', q)}${errorState(e)}`;
    return;
  }
  const latest = overview.latest_day;
  const counts = overview.counts || {};
  const checkLabel = { pass: '通过', warn: '有提示', fail: '不通过', pending: '待核对' };

  root.innerHTML = `
  ${varietyBar('cea', q)}
  <div class="callout">
    <b>CEA 是配额与履约市场，与 CCER 分表统计</b>
    <p>官方综合收盘价（close）与全方式计算均价（computed_avg_price）是两个不同口径，分开显示、互不替代。</p>
    <p><a class="btn btn-sm" href="#/cea?tab=quote">进入 CEA 行情专题（含来源钻取与价格历史）</a></p>
  </div>

  ${latest ? `
  <div class="metrics">
    ${metric('最新 CEA 官方综合收盘价', num(latest.close, 2), '元/吨',
      `指定权重指数（${latest.price_regime || '口径未标注'}）`, '不是全方式量加权均价，不用于计算成交额。',
      latest.trade_date, '官方综合行情（CEA 独立行情表）', null)}
    ${metric('最新 CEA 全方式计算均价', latest.computed_avg_price === null || latest.computed_avg_price === undefined ? '—' : num(latest.computed_avg_price, 2), '元/吨',
      latest.computed_avg_price === null || latest.computed_avg_price === undefined ? '无成交额/成交量时不计算' : '总成交额 ÷ 总成交量（程序计算）',
      '程序计算值，绝不覆盖官方公布值。', latest.trade_date, 'querySubStat（COMCEA 聚合）', null)}
    ${metric('最新总成交量', num(latest.total_volume), '吨', `总成交额 ${num(latest.total_turnover)} 元`,
      '官方披露的全方式合计；缺失分项显示「—」。', latest.trade_date, 'querySubStat（COMCEA 聚合）', null)}
    ${metric('数据截止日 / 采集状态', shortDate(overview.data_as_of), '',
      `确定性核对 ${checkLabel[latest.check_status] || latest.check_status || '—'}｜AI 核验 ${latest.verification_status || '—'}｜已入库 ${counts.trade_days ?? 0} 个交易日`,
      '未结清缺口不在此估算，见 CEA 专题「来源与缺口」。', overview.data_as_of, '自动核对与核验任务', null)}
  </div>` : emptyState('尚无 CEA 行情数据', '没有真实来源数据时留空：不用 0、不用前值、不用估算值填充。', '可在后台「CEA 配额市场 → 采集」触发采集')}

  ${card({
    title: 'CEA 行情明细（最近 60 个交易日）',
    subtitle: `${esc(summary.from || '—')} ~ ${esc(summary.to || '—')}｜区间成交量 ${summary.total_volume === null ? '—' : `${num(summary.total_volume)} 吨`}｜区间量加权均价 ${summary.vwap === null ? '—' : `${num(summary.vwap, 2)} 元/吨`}`,
    actions: `<a class="btn btn-sm" href="/api/v2/cea/export?dataset=trade&format=csv${from ? `&from=${from}` : ''}${to ? `&to=${to}` : ''}" download>下载 CEA 行情 CSV</a>
              <a class="btn btn-sm" href="/api/v2/cea/export?dataset=trade&format=json${from ? `&from=${from}` : ''}${to ? `&to=${to}` : ''}" download>下载 JSON</a>`,
    body: table({
      rows: trade.rows || [],
      pageSize: 15,
      columns: [
        { key: 'trade_date', label: '交易日期', render: (r) => esc(r.trade_date) },
        { key: 'close', label: '官方综合收盘价', unit: '元/吨', align: 'right', render: (r) => num(r.close, 2) },
        { key: 'computed_avg_price', label: '全方式计算均价', unit: '元/吨', align: 'right', render: (r) => (r.computed_avg_price === null || r.computed_avg_price === undefined ? '<span class="muted">—</span>' : num(r.computed_avg_price, 2)) },
        { key: 'change_pct', label: '涨跌幅', unit: '%', align: 'right', render: (r) => (r.change_pct === null || r.change_pct === undefined ? '—' : delta(r.change_pct)) },
        { key: 'total_volume', label: '总成交量', unit: '吨', align: 'right', render: (r) => num(r.total_volume) },
        { key: 'total_turnover', label: '总成交额', unit: '元', align: 'right', render: (r) => num(r.total_turnover) },
        { key: 'check_status', label: '确定性核对', render: (r) => chip(checkLabel[r.check_status] || r.check_status || '—', r.check_status === 'pass' ? 'ok' : r.check_status === 'fail' ? 'danger' : 'warn') },
        { key: 'verification_status', label: 'AI 核验', render: (r) => esc(r.verification_status || '—') },
        { key: 'source_url', label: '来源', render: (r) => (r.source_url ? `<a class="link" href="${esc(r.source_url)}" target="_blank" rel="noreferrer noopener">官方来源</a>` : '—') },
      ],
      emptyText: '所选区间没有 CEA 行情记录',
    }) + noteBlock(summary.caliber_note || ''),
  })}`;
}

/* ============================ 同日对比视图 ============================ */

/**
 * CEA / CCER 同日对比。
 * 规则：只在同日两侧都有数据时给出对比点；任一侧缺失 → 该侧为 null，显示「—」，
 * **不前填、不填 0**；价差只是两个市场报价的比较，不代表套利收益。
 */
async function renderCompareTrades(root, q) {
  root.innerHTML = `${varietyBar('compare', q)}${loading('正在加载同日对比…')}`;
  const from = q.from || '';
  const to = q.to || '';
  let data;
  try {
    data = await api(`/api/v2/cea/comparison?${new URLSearchParams({ from, to, limit: '180' }).toString()}`);
  } catch (e) {
    root.innerHTML = `${varietyBar('compare', q)}${errorState(e)}`;
    return;
  }
  const points = data.points || [];
  const both = points.filter((p) => p.same_day_complete);
  // 接口按日期倒序返回；图表按时间正序绘制，表格保留倒序（最新在上）
  const asc = points.slice().reverse();
  const priceSeries = [
    { key: 'cea_close', label: 'CEA 官方综合收盘价', tone: 'a', points: asc.map((p) => ({ x: p.trade_date, y: p.cea_composite_close })) },
    { key: 'cea_avg', label: 'CEA 全方式计算均价', tone: 'b', dashed: true, points: asc.map((p) => ({ x: p.trade_date, y: p.cea_computed_avg_price })) },
    { key: 'ccer_avg', label: 'CCER 计算均价', tone: 'c', points: asc.map((p) => ({ x: p.trade_date, y: p.ccer_computed_avg_price })) },
  ];
  const volAsc = asc.slice(-40);
  const volCats = volAsc.map((p) => p.trade_date);
  const volSeries = [
    { key: 'cea_volume', label: 'CEA 总成交量（吨）', tone: 'a', values: volAsc.map((p) => p.cea_volume) },
    { key: 'ccer_volume', label: 'CCER 成交量（吨）', tone: 'b', values: volAsc.map((p) => p.ccer_volume) },
  ];
  const latestDate = points[0]?.trade_date || null;

  root.innerHTML = `
  ${varietyBar('compare', q)}
  <div class="callout callout-warn">
    <b>价差只是两个市场的报价比较</b>
    <p>CEA 官方综合收盘价、CEA 全方式计算均价、CCER 计算均价是三个不同字段，图例分开，不混用。</p>
    <p>任一侧当日缺数据时该点为 null（显示「—」），<b>不沿用前值、不填 0</b>；价差不代表套利收益，也不等于真实成交结果。</p>
    <p class="hint">${esc(data.caliber_note || '')}</p>
  </div>

  <div class="filters">
    <label class="fld"><span>起始日期</span><input type="date" data-f="from" value="${esc(from)}"></label>
    <label class="fld"><span>截止日期</span><input type="date" data-f="to" value="${esc(to)}"></label>
    <span class="fld-actions">
      <a class="btn btn-sm" href="/api/v2/cea/export?dataset=trade&format=csv${from ? `&from=${from}` : ''}${to ? `&to=${to}` : ''}" download>下载 CEA 行情</a>
      <button class="btn btn-sm" data-reset>重置</button>
    </span>
  </div>

  <div class="metrics metrics-sm">
    ${metric('同日可比交易日', num(both.length), '天', `接口返回 ${points.length} 个 CEA 交易日`, '只有两侧同日都有报价才计入可比。', latestDate, '/api/v2/cea/comparison', null)}
    ${metric('任一侧缺失的交易日', num(points.length - both.length), '天', '缺失侧显示「—」，不前填、不填 0', '这是数据缺口，不是 0 值。', latestDate, '/api/v2/cea/comparison', null)}
  </div>

  ${card({
    title: '三口径价格对比（同日）',
    subtitle: 'CEA 官方综合收盘价 / CEA 全方式计算均价 / CCER 计算均价｜可分别开关图例',
    body: points.length
      ? lineChart({ series: priceSeries, height: 280, yUnit: '元/吨', yDigits: 2, ariaLabel: 'CEA 与 CCER 同日价格对比' })
        + noteBlock('折线在缺失处断开：某侧当日无报价时不会连线、不会用前值补齐。')
      : emptyState('暂无同日对比数据', 'CEA 与 CCER 同日都没有入库行情时不生成对比点。'),
  })}

  ${card({
    title: '成交量对比（最近 40 个同日）',
    subtitle: 'CEA 总成交量与 CCER 成交量分列；任一侧缺失不画柱、不填 0',
    body: groupedBarChart({ categories: volCats, series: volSeries, height: 260, unit: '吨', yDigits: 0, ariaLabel: 'CEA 与 CCER 成交量对比' }),
  })}

  ${card({
    title: '同日对比明细',
    subtitle: `共 ${points.length} 行（按日期倒序）｜空值一律显示「—」`,
    body: table({
      rows: points,
      pageSize: 20,
      columns: [
        { key: 'trade_date', label: '交易日期', render: (r) => esc(r.trade_date) },
        { key: 'cea_composite_close', label: 'CEA 官方综合收盘价', unit: '元/吨', align: 'right', render: (r) => (r.cea_composite_close === null || r.cea_composite_close === undefined ? '<span class="muted">—</span>' : num(r.cea_composite_close, 2)) },
        { key: 'cea_computed_avg_price', label: 'CEA 全方式计算均价', unit: '元/吨', align: 'right', render: (r) => (r.cea_computed_avg_price === null || r.cea_computed_avg_price === undefined ? '<span class="muted">—</span>' : num(r.cea_computed_avg_price, 2)) },
        { key: 'ccer_computed_avg_price', label: 'CCER 计算均价', unit: '元/吨', align: 'right', render: (r) => (r.ccer_computed_avg_price === null || r.ccer_computed_avg_price === undefined ? '<span class="muted">—</span>' : num(r.ccer_computed_avg_price, 2)) },
        { key: 'spread_close_minus_ccer', label: '价差（CEA 收盘 − CCER 均价）', unit: '元/吨', align: 'right', render: (r) => (r.spread_close_minus_ccer === null || r.spread_close_minus_ccer === undefined ? '<span class="muted">—（缺一侧报价）</span>' : num(r.spread_close_minus_ccer, 2)) },
        { key: 'cea_volume', label: 'CEA 总成交量', unit: '吨', align: 'right', render: (r) => (r.cea_volume === null || r.cea_volume === undefined ? '<span class="muted">—</span>' : num(r.cea_volume)) },
        { key: 'ccer_volume', label: 'CCER 成交量', unit: '吨', align: 'right', render: (r) => (r.ccer_volume === null || r.ccer_volume === undefined ? '<span class="muted">—</span>' : num(r.ccer_volume)) },
        { key: 'same_day_complete', label: '同日完整', render: (r) => (r.same_day_complete ? chip('两侧齐全', 'ok') : chip('缺一侧', 'warn')) },
        { key: 'cea_price_regime', label: 'CEA 口径', render: (r) => esc(r.cea_price_regime || '—') },
      ],
      emptyText: '暂无同日对比明细',
      emptyDetail: 'CEA 或 CCER 任一侧没有入库行情时不生成对比行。',
    }),
  })}`;

  root.querySelectorAll('[data-f]').forEach((el) => el.addEventListener('change', () => setQuery({ [el.dataset.f]: el.value })));
  root.querySelector('[data-reset]')?.addEventListener('click', () => setQuery({ from: null, to: null }));
  bindChartToggles(root);
}
