/**
 * 模块一：总览
 * ============================================================================
 * 需求规格 1.1：顶部指标（带截至日期与数据源）、市场走势、项目进度（分阶段不相加）、
 * 方法学分布、地域与投资视图、更新提醒；筛选器同步影响指标；图表可查看口径并下载数据。
 */
import { api, setQuery, exportUrl, state } from '../app.js';
import {
  card, metricCard, comboChart, barChart, loading, emptyState, errorState, noteBlock,
  num, pct, esc, shortDate, chip, drawer, renderKvRows, toast,} from '../ui.js';
import { sourceBlock, sourceLinkBlock, summaryBlock, summaryCoverageHint, rangeSummaryBar, chatPanel, bindChatPanel } from '../platform.js';
import { mountRegionMap, mapQueryFromRoute } from './region-map.js';
import { selectOptionsHtml } from '../form-selects.js';

const RANGES = [
  { value: '30d', label: '近 30 天' },
  { value: '90d', label: '近 90 天' },
  { value: '1y', label: '近 1 年' },
  { value: 'all', label: '全部' },
];

export async function renderOverview(root) {
  root.innerHTML = loading('正在加载总览…');
  const route = state.route;
  const q = route.query || {};
  let data;
  let cea = null;
  let accounting = null;
  let regionMap = null;
  let mapHandle = null;
  try {
    const qs = new URLSearchParams(Object.fromEntries(Object.entries(q).filter(([, v]) => v))).toString();
    const mapQs = mapQueryFromRoute(q);
    [data, cea, regionMap] = await Promise.all([
      api(`/api/v2/overview${qs ? `?${qs}` : ''}`),
      // CEA 卡片失败不阻塞总览：如实显示空态与原因，不显示假数字
      api('/api/v2/cea/overview').catch((e) => ({ __error: e })),
      // 省域地图失败不阻塞总览；地图自身会显示错误/降级省份列表
      api(`/api/v2/overview/region-map${mapQs.toString() ? `?${mapQs.toString()}` : ''}`)
        .catch((e) => ({ __error: e })),
    ]);
    // 碳核算公开资料卡同样失败不阻塞总览；取不到就留空态，不显示替代数字
    accounting = await api('/api/v2/accounting/status').catch((e) => ({ __error: e }));
  } catch (e) {
    root.innerHTML = errorState(e);
    return;
  }
  const opts = data.filter_options || {};
  const f = data.filters || {};

  const filterHtml = `
    <div class="filters">
      <label class="fld"><span>时间范围</span><select data-f="range">
        ${RANGES.map((r) => `<option value="${r.value}" ${f.range === r.value ? 'selected' : ''}>${r.label}</option>`).join('')}
      </select></label>
      <label class="fld"><span>领域</span><select data-f="domain">${selectOptionsHtml(opts.domains || [], f.domain, { allLabel: '全部领域' })}</select></label>
      <label class="fld"><span>方法学</span><select data-f="methodology_id">${selectOptionsHtml((opts.methodologies || []).map((m) => ({ value: m.methodology_id, label: m.methodology_id })), f.methodology_id, { allLabel: '全部方法学' })}</select></label>
      <label class="fld"><span>省份</span><select data-f="province">${selectOptionsHtml(opts.provinces || [], f.province, { allLabel: '全部省份' })}</select></label>
      <label class="fld"><span>阶段</span><select data-f="stage">${selectOptionsHtml(opts.stages || [], f.stage, { allLabel: '全部阶段' })}</select></label>
      <span class="fld-actions"><button class="btn btn-sm" data-reset>重置</button></span>
    </div>`;

  // 行情数字表的区间口径汇总（确定性程序按当前筛选区间聚合；不逐行调用模型）
  let marketRangeBar = '';
  try {
    marketRangeBar = await rangeSummaryBar('trade', { range: f.range || '90d', as_of: f.as_of || '' });
  } catch {
    marketRangeBar = '';
  }

  const market = data.market || { series: [], coverage: [], counts: {} };
  const chartPoints = (market.series || []).map((s) => ({
    trade_date: s.trade_date,
    volume: s.volume,
    avg_price: s.avg_price,
    verify_status: s.verify_status,
  }));

  root.innerHTML = `
  ${filterHtml}
  <div class="metrics metrics-overview">${(data.metrics || []).map(metricCard).join('')}</div>

  <div id="region-map-slot" class="region-map-slot-host"></div>

  <div class="grid-2">
    ${card({
      title: '市场走势',
      subtitle: `${market.range_label || ''}｜${market.from || '—'} ~ ${market.to || '—'}`,
      actions: `${exportUrlLink('trade/export', 'csv', { dataset: 'daily' }, '下载日行情')}
                ${exportUrlLink('trade/export', 'xlsx', { dataset: 'summary', granularity: 'month' }, '下载月度汇总')}
                <button class="btn btn-sm" data-caliber="trade.avg_price">来源与口径</button>`,
      body: comboChart({ points: chartPoints }) + marketRangeBar +
        noteBlock(`有成交 ${market.counts?.traded ?? 0} 天｜无成交 ${market.counts?.no_trade ?? 0} 天｜休市 ${market.counts?.closed ?? 0} 天｜数据暂缺 ${market.counts?.missing ?? 0} 天。${market.note || ''}`),
    })}
    ${card({
      title: '项目进度',
      subtitle: `系统已收录公开项目 ${data.progress?.project_total ?? 0} 个（不等于全国总数）`,
      actions: '<button class="btn btn-sm" data-caliber="project.stage">来源与口径</button>',
      body: barChart({
        items: (data.progress?.stages || []).map((s) => ({ label: s.label, count: s.count, stage: s.stage })),
        unit: ' 个',
      }) + noteBlock(data.progress?.note),
    })}
  </div>

  ${ceaCard(cea)}

  ${accountingCard(accounting)}

  ${card({
    title: '方法学分布',
    subtitle: `正式 ${data.methodology?.counts?.formal ?? 0} 项｜草案 ${data.methodology?.counts?.draft ?? 0} 项｜编号待核实 ${data.methodology?.counts?.code_pending ?? 0} 项`,
    actions: '<a class="btn btn-sm" href="#/policies?tab=methodologies">进入方法学库</a>',
    body: barChart({ items: (data.methodology?.by_domain || []).map((d) => ({ label: d.domain, count: d.total })), unit: ' 项' })
      + noteBlock(data.methodology?.note),
  })}

  ${card({
    title: '最新政策与原文变化',
    subtitle: '官方原文自动采集；正式、征求意见、修订、废止分开；标题下为模型生成的核心摘要',
    actions: '<a class="btn btn-sm" href="#/policies">进入政策库</a>',
    body: (data.policies?.latest || []).length
      ? `<ul class="list">${data.policies.latest.slice(0, 6).map((p) => `
          <li>
            <div class="list-head"><b>${esc(p.title)}</b><span class="muted right">${esc(shortDate(p.publish_date))}</span></div>
            ${summaryBlock(p, { compact: true })}
            <div class="list-foot"><span class="chip chip-muted">${esc(p.status_label || '')}</span>
              ${sourceBlock(p)}
              ${sourceLinkBlock(p, { label: '原文' })}</div>
          </li>`).join('')}</ul>${summaryCoverageHint(data.policies?.latest || [])}`
      : emptyState('暂无政策条目', '官方政策巡检完成后显示'),
  })}

  ${contentCard(data.content)}

  ${chatPanel()}
  `;

  /* ---- 交互 ---- */
  root.querySelectorAll('[data-f]').forEach((sel) => {
    sel.addEventListener('change', () => setQuery({ [sel.dataset.f]: sel.value }));
  });
  root.querySelector('[data-reset]')?.addEventListener('click', () => setQuery({
    range: null, domain: null, methodology_id: null, province: null, stage: null,
    map: null, list_year: null,
  }));
  // 省域地图：独立异步挂载，底图/接口失败不阻塞总览其他卡片。
  // 地图只接收阶段/领域/方法学筛选；总览省份筛选仅作为上下文高亮，避免其他省全部消失。
  const mapHost = root.querySelector('#region-map-slot');
  if (mapHost) {
    const stageLabel = (opts.stages || []).find((s) => s.key === q.stage)?.label || q.stage || null;
    mapHandle = mountRegionMap({
      root: mapHost,
      initialData: regionMap,
      filters: {
        domain: q.domain || null,
        methodology_id: q.methodology_id || null,
        stage: q.stage || null,
        stage_label: stageLabel,
      },
      contextProvince: q.province || null,
      fetchApi: api,
    });
  }
  // 总览底部 AI 对话区（所有已登录用户可用；历史仅保存在内存）
  bindChatPanel(root);
  root.addEventListener('click', async (e) => {
    const cal = e.target.closest('[data-caliber]');
    if (cal) {
      const key = cal.dataset.caliber;
      const m = (data.caliber?.metrics || []).find((x) => x.key === key)
        || (key === 'trade.avg_price' ? data.caliber?.trade : null)
        || (key === 'project.stage' ? data.caliber?.project : null);
      document.body.insertAdjacentHTML('beforeend', drawer('来源与口径', m
        ? `<h4>${esc(m.label)}</h4>
           <p><b>口径：</b>${esc(m.caliber)}</p>
           <p><b>单位：</b>${esc(m.unit || '—')}</p>
           <p><b>数据源：</b>${esc(m.source_note || '—')}</p>
           <p class="hint">${esc(data.caliber?.note || '')}</p>`
        : '<p>未找到该指标的口径定义。</p>'));
    }
    const drill = e.target.closest('[data-drill]');
    if (drill && drill.dataset.drill && !e.target.closest('button,details,a')) {
      location.hash = drill.dataset.drill;
    }
  });
  return () => {
    mapHandle?.dispose?.();
    mapHandle = null;
  };
}

function exportUrlLink(path, format, query, label) {
  const qs = new URLSearchParams({ format, ...query }).toString();
  return `<a class="btn btn-sm" href="/api/v2/${path}?${qs}" download>${esc(label)}</a>`;
}

/**
 * CEA 市场卡片（全国碳排放配额）。
 * 只展示真实入库的行情：官方综合收盘价与全方式计算均价**分列**，标注数据截止日与采集核验状态；
 * 没有数据时显示空态与原因，不显示假数字。
 */
function ceaCard(cea) {
  if (!cea || cea.__error) {
    const err = cea?.__error;
    return card({
      title: 'CEA 配额市场',
      subtitle: '全国碳排放配额（CEA）行情与履约专题',
      actions: '<a class="btn btn-sm" href="#/cea">进入 CEA 专题</a>',
      body: err
        ? `${errorState(err)}<p class="hint">CEA 接口不可用时，总览不显示替代数字（HTTP ${esc(String(err.status || '—'))}）。</p>`
        : emptyState('CEA 数据不可用', '未取得 CEA 行情数据，不显示假数字。'),
    });
  }
  const latest = cea.latest_day;
  const counts = cea.counts || {};
  if (!latest) {
    return card({
      title: 'CEA 配额市场',
      subtitle: '全国碳排放配额（CEA）行情与履约专题',
      actions: '<a class="btn btn-sm" href="#/cea">进入 CEA 专题</a>',
      body: emptyState(
        '尚无 CEA 行情数据',
        '没有真实来源数据时留空：不用 0、不用前值、不用估算值填充。',
        `已入库交易日 ${counts.trade_days ?? 0} 个｜未结清缺口 ${counts.open_gaps ?? 0} 项｜来源失败 ${counts.sources_failed ?? 0} 个`
      ),
    });
  }
  const avg = latest.computed_avg_price;
  return card({
    title: 'CEA 配额市场',
    subtitle: `全国碳排放配额｜数据截止日 ${esc(shortDate(cea.data_as_of))}｜本系统已入库 ${counts.trade_days ?? 0} 个交易日`,
    actions: '<a class="btn btn-sm" href="#/cea?tab=quote">行情明细</a><a class="btn btn-sm" href="#/cea">进入 CEA 专题</a>',
    body: `
      <div class="metrics metrics-sm">
        ${metricCard({
          label: '官方综合收盘价', value: latest.close, unit: '元/吨',
          sub: `指定权重指数（${latest.price_regime || '口径未标注'}），非全方式均价｜涨跌幅 ${latest.change_pct === null || latest.change_pct === undefined ? '—' : pct(latest.change_pct)}`,
          source: '官方综合行情（CEA 独立行情表）', as_of: latest.trade_date,
        })}
        ${metricCard({
          label: '全方式计算均价', value: avg === null || avg === undefined ? null : avg, unit: '元/吨',
          sub: avg === null || avg === undefined ? '无成交额/成交量时不计算（不用 0 代替）' : '总成交额 ÷ 总成交量（程序计算）',
          source: 'querySubStat 精确聚合（COMCEA）', as_of: latest.trade_date,
        })}
        ${metricCard({
          label: '总成交量 / 总成交额', value: latest.total_volume, unit: '吨',
          sub: `成交额 ${num(latest.total_turnover)} 元`,
          source: '官方披露全方式合计', as_of: latest.trade_date,
        })}
      </div>
      <div class="chip-row">
        <span class="chip">真实行情截止日 ${esc(shortDate(cea.data_as_of))}</span>
        <span class="chip ${latest.check_status === 'pass' ? 'chip-ok' : latest.check_status === 'fail' ? 'chip-danger' : 'chip-warn'}">确定性核对 ${esc(latest.check_status || '—')}</span>
        <span class="chip ${latest.verification_status === 'verified' ? 'chip-ok' : latest.verification_status === 'conflict' ? 'chip-danger' : 'chip-muted'}">AI 证据核验 ${esc(latest.verification_status || '—')}</span>
        <span class="chip ${counts.sources_failed ? 'chip-warn' : ''}">来源失败 ${counts.sources_failed ?? 0} 个</span>
        <span class="chip ${counts.open_gaps ? 'chip-warn' : ''}">未结清缺口 ${counts.open_gaps ?? 0} 项</span>
      </div>
      <p class="hint">口径：官方综合收盘价 ≠ 全方式计算均价，两个字段不互相替代；概览层（官方舍入展示值）与精确值分开保存，可在专题页「行情」中逐条钻取来源快照与跨层核对。名录数量不等于买家数量，交易意向不等于成交。</p>
      ${counts.trade_fail ? `<p class="hint">存在 ${counts.trade_fail} 条核对不通过的行情记录，已如实标注，未改写官方数值。</p>` : ''}`,
  });
}

/**
 * 碳核算公开资料卡（docs/43）：只显示本平台**实际入库**的因子/规范正文/问答数量与入口。
 * 上游门户宣称的条数（如因子库宣称总量）不是本平台已入库数，不在此卡出现。
 */
export function accountingCard(acc) {
  const actions = '<a class="btn btn-sm" href="#/measure?tab=factors">因子库</a>'
    + '<a class="btn btn-sm" href="#/measure?tab=standards">标准规范</a>'
    + '<a class="btn btn-sm" href="#/measure?tab=public">政策与问答</a>';
  if (!acc || acc.__error) {
    return card({
      title: '碳核算公开资料',
      subtitle: '公开排放因子、规范正文与政策问答（本平台实际入库数量）',
      actions,
      body: `${emptyState('资料库暂不可用', '取不到真实入库数量时不显示替代数字。')}
        <p class="hint">可在「碳计算与因子」模块中查看公开排放因子、标准规范与政策问答。</p>`,
    });
  }
  const c = acc.counts || {};
  const factors = Number(c.factors || 0);
  const standards = Number(c.standards || 0);
  const standardsFull = Number(c.standards_full ?? c.standards_with_body ?? 0);
  const publicDocs = Number(c.public_documents || 0);
  const publicQa = Number(c.public_qa || 0);
  return card({
    title: '碳核算公开资料',
    subtitle: '公开排放因子、规范正文与政策问答｜数量均为本平台实际入库，不代表上游门户宣称的总量',
    actions,
    body: `
      <div class="metrics metrics-sm">
        ${metricCard({
          label: '公开排放因子', value: factors, unit: '条',
          sub: `现行因子；来源为公开公告附件，页面可查原文定位与数据年度`,
          source: '本平台实际入库（非上游宣称总量）',
        })}
        ${metricCard({
          label: '规范正文', value: standardsFull, unit: '条',
          sub: standardsFull === 0 ? `已著录规范 ${standards} 条，正文尚未取得（不解读条款）` : `已取得正文的规范；另有著录条目仅元数据，不解读条款`,
          source: '本平台实际入库', warn: standardsFull === 0 && standards > 0,
        })}
        ${metricCard({
          label: '政策与问答', value: publicQa, unit: '条问答',
          sub: `公开政策/标准/问答条目 ${publicDocs} 条；栏目页不是全文，旧版指南答复保留原样`,
          source: '本平台实际入库',
        })}
      </div>
      <p class="hint">「核验」只表示正文与所给原文一致，不表示答复已按最新规范更新；原站未标注发布日期时显示「原站未标注」。
      数量取自本平台资料库，不使用上游门户宣称的条数替代。</p>`,
  });
}

/**
 * 最新研报与行业动态（总览第七项）。
 * docs/44 第 2 条：**不再以「证据充足/不足/自动核验」等标签呈现，以来源为主**；
 * 官方网站显示「官方信息」，第三方显示实际发布机构 / 网站名；标题下带核心摘要。
 * 内部核验数据保留在后台「自动核验策略 / 核验记录」。
 */
function contentCard(c) {
  const stats = c?.stats || {};
  const items = c?.latest || [];
  return card({
    title: '最新研报与行业动态',
    subtitle:
      `公开研报、行业动态、机构观点与企业公告｜正文条目 ${stats.total ?? 0} 条（不含来源首页归档、演示与转载副本）` +
      `｜其中 ${stats.published_date_missing ?? 0} 条来源未披露发布日期｜最近发布 ${stats.latest_published_at ? shortDate(stats.latest_published_at) : '—'}`,
    actions: '<a class="btn btn-sm" href="#/content">进入研报与行业动态</a>',
    body: (items.length
      ? `<ul class="list">${items.slice(0, 6).map((it) => `<li>
            <div class="list-head">
              <b>${esc(it.title)}</b>
              <span class="muted right">${it.published_at_known ? `发布 ${esc(shortDate(it.published_at))}` : '发布日期未披露'}</span>
            </div>
            ${summaryBlock(it, { compact: true })}
            <div class="list-foot">
              <span class="chip chip-muted">${esc(it.content_type_label || '')}</span>
              ${sourceBlock(it)}
              ${sourceLinkBlock(it, { label: '原文' })}
              <a class="link" href="#/content?q=${encodeURIComponent(String(it.title || '').slice(0, 24))}">查看</a>
            </div>
          </li>`).join('')}</ul>`
      : emptyState('尚未采集到研报与动态', '数据源配置并完成采集后显示'))
      + summaryCoverageHint(items)
      + noteBlock(
        '来源口径：官方域名按 hostname 精确 / 受控子域匹配后显示「官方信息」，第三方显示其实际发布机构或网站名，' +
        '无法解析来源时显示域名或「来源未标注」；平台不会把转载官方内容的第三方认定为官网，也不杜撰来源。' +
        '企业主张按实际发布主体展示，不升格为官方事实。' +
        '发布日以来源页面声明为准，未声明时显示「未披露」而不用采集时间代替。' +
        '核验明细不在公开列表展示，可在后台「自动核验策略 / 核验记录」中查看。'
      ),
  });
}

/**
 * 运行提醒列表已随运行状态版块一并移出公开总览（docs/44 第 4 条）：
 * 提醒与缺口明细只在后台「运行与内容维护」（管理员）中展示。
 * 本模块因此不再渲染任何运行状态条目。
 */

