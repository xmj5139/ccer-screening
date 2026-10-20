/**
 * 总览服务（六模块之一：总览）
 * ============================================================================
 * 设计约束（需求规格 1.1）：
 *   - 每个指标必须带「截至日期」与数据源；无交易日不显示 0 元价格
 *   - 同一项目的多阶段不能当作互斥分类相加
 *   - 图表提供筛选器（时间、领域、方法学、地区、状态），筛选同步影响指标
 *   - 每个指标与图表都能查看口径说明并下载数据
 */
import { all, get } from '../core/db.mjs';
import { todayCst, uj, sanitizeLegacyWording } from '../core/util.mjs';
import { EVIDENCE_LEVELS } from '../data/methodology-evidence.mjs';
import { POLICY_CATEGORY_LABELS } from '../data/policy-catalog.mjs';
import * as contentSvc from './content-svc.mjs';
import * as archiveSvc from './policy-archive-svc.mjs';
import { notificationSettled } from './collect-svc.mjs';
import { PUBLIC_RECON_FILTER } from './collect-svc.mjs';
import {
  STAGE_COLUMNS, STAGE_LABELS, aggregateProjectRows,
} from './project-aggregate.mjs';

export { STAGE_COLUMNS, STAGE_LABELS };

/** 政策效力状态文案（正式与征求意见分开，草案不得当作现行正式文件） */
const POLICY_STATUS_LABEL = {
  effective: '现行有效',
  superseded: '已被替代',
  repealed: '已废止',
  draft: '征求意见中',
  consultation: '征求意见中',
  notice: '公告',
};

const DAY = 86400000;

function isoDaysAgo(days, today = todayCst()) {
  return new Date(Date.parse(`${today}T00:00:00Z`) - days * DAY).toISOString().slice(0, 10);
}

/** 指标口径说明（来自 metric_definition 表；界面「来源与口径」按钮使用） */
export function metricDefinitions(module = null) {
  const rows = all('SELECT * FROM metric_definition ORDER BY module, key');
  return module ? rows.filter((r) => r.module === module) : rows;
}

export function metricDefinition(key) {
  return get('SELECT * FROM metric_definition WHERE key = ?', [key]) || null;
}

/* ------------------------------------------------------------------ */
/*  筛选器                                                             */
/* ------------------------------------------------------------------ */

export const DASHBOARD_RANGES = {
  '30d': { label: '近 30 天', days: 30 },
  '90d': { label: '近 90 天', days: 90 },
  '1y': { label: '近 1 年', days: 365 },
  all: { label: '全部', days: null },
};

export function parseFilters(query = {}) {
  const range = DASHBOARD_RANGES[query.range] ? query.range : '90d';
  return {
    range,
    range_label: DASHBOARD_RANGES[range].label,
    domain: query.domain || null,
    methodology_id: query.methodology_id || null,
    province: query.province || null,
    stage: query.stage || null,
    as_of: query.as_of || todayCst(),
  };
}

/**
 * 演示条目（历史种子写入的 is_demo=1 / 注释以「演示条目」开头）一律排除在业务统计外。
 * docs/22 第 16 条：294 条公开项目中含 3 条 demo，实际业务数应为 291；
 * 减排量批次统计同样必须排除 demo 项目。
 */
const DEMO_EXCLUDED = "COALESCE(p.is_demo,0)=0";

/** 公开项目的筛选 SQL 片段（始终排除演示条目） */
function projectWhere(f, alias = 'p') {
  const where = [`COALESCE(${alias}.is_demo,0)=0`];
  const params = [];
  if (f.domain) {
    where.push(`${alias}.domain = ?`);
    params.push(f.domain);
  }
  if (f.methodology_id) {
    where.push(`${alias}.methodology_id = ?`);
    params.push(f.methodology_id);
  }
  if (f.province) {
    where.push(`${alias}.province = ?`);
    params.push(f.province);
  }
  if (f.stage) {
    const col = STAGE_COLUMNS[f.stage];
    if (col) where.push(`${alias}.${col} = 1`);
  }
  return { sql: `WHERE ${where.join(' AND ')}`, params };
}

/* ------------------------------------------------------------------ */
/*  顶部指标                                                           */
/* ------------------------------------------------------------------ */

export function topMetrics(f = parseFilters()) {
  /* --- 方法学 --- */
  const mvAll = all('SELECT * FROM methodology_version');
  const formal = mvAll.filter((m) => m.document_status === 'formal');
  const formalVerifiedCode = formal.filter((m) => m.catalog_confidence === 'verified_from_official_notice');
  const formalPendingCode = formal.filter((m) => m.catalog_confidence !== 'verified_from_official_notice');
  const draft = mvAll.filter((m) => m.document_status !== 'formal');

  /* --- 政策 --- */
  const since = isoDaysAgo(30, f.as_of);
  const policyRecent = get(
    `SELECT COUNT(*) AS c FROM policy_document WHERE publish_date IS NOT NULL AND publish_date >= ?`,
    [since]
  )?.c ?? 0;
  const policyTotal = get('SELECT COUNT(*) AS c FROM policy_document')?.c ?? 0;
  const policyLast = get('SELECT MAX(publish_date) AS d FROM policy_document')?.d || null;
  // 官方原文变化是**自动检测记录**（运行状态），不是「待确认变更」，更不是人工待办
  const policyChangeDetected = get(
    "SELECT COUNT(*) AS c FROM policy_change WHERE review_status = 'pending'"
  )?.c ?? 0;

  /* --- 项目（一律排除演示条目，按登记号去重、阶段取并集） --- */
  const pw = projectWhere(f);
  const projectRows = all(
    `SELECT p.id, p.registry_project_no, p.name, p.province, p.methodology_id,
            p.current_stage, p.updated_at,
            p.stage_project_public, p.stage_validated, p.stage_project_registered,
            p.stage_reduction_public, p.stage_verified, p.stage_reduction_registered
     FROM public_project p ${pw.sql}`,
    pw.params
  );
  const projectAgg = aggregateProjectRows(projectRows);
  const projectStats = {
    total: projectAgg.total,
    public_cnt: projectAgg.stage_counts.project_public,
    registered_cnt: projectAgg.stage_counts.project_registered,
    reduction_registered_cnt: projectAgg.stage_counts.reduction_registered,
  };
  const demoProjects = get(
    'SELECT COUNT(*) AS c FROM public_project WHERE COALESCE(is_demo,0)=1'
  )?.c ?? 0;
  const registeredReduction = get(
    `SELECT SUM(rb.registered_amount) AS amt
     FROM reduction_batch rb JOIN public_project p ON p.id = rb.public_project_id
     ${pw.sql}`,
    pw.params
  )?.amt ?? null;
  const ownerAnnounced = get(
    `SELECT SUM(rb.owner_announced_estimate) AS amt
     FROM reduction_batch rb JOIN public_project p ON p.id = rb.public_project_id
     ${pw.sql}`,
    pw.params
  )?.amt ?? null;
  const verifiedAmount = get(
    `SELECT SUM(rb.verified_amount) AS amt
     FROM reduction_batch rb JOIN public_project p ON p.id = rb.public_project_id
     ${pw.sql}`,
    pw.params
  )?.amt ?? null;
  const projectAutoVerify = {};
  try {
    for (const r of all(
      `SELECT COALESCE(p.auto_verify_status,'none') s, COUNT(*) c FROM public_project p ${pw.sql}
       GROUP BY COALESCE(p.auto_verify_status,'none')`,
      pw.params
    )) projectAutoVerify[r.s] = r.c;
  } catch {
    /* 列尚未迁移 */
  }

  /* --- 交易 --- */
  const latestTrade = get(
    `SELECT * FROM trade_daily WHERE volume IS NOT NULL AND volume > 0
     ORDER BY trade_date DESC LIMIT 1`
  );
  const latestAnyTradeDate = get('SELECT MAX(trade_date) AS d FROM trade_daily')?.d || null;
  const calendarLatest = get('SELECT MAX(trade_date) AS d FROM trade_calendar')?.d || null;
  // 行情核对是**自动核对状态**：pending=待自动核对，verified=系统自动核对通过，mismatch=与官方不符
  const tradeVerify = {};
  for (const r of all('SELECT COALESCE(verify_status,\'none\') s, COUNT(*) c FROM trade_daily GROUP BY COALESCE(verify_status,\'none\')')) {
    tradeVerify[r.s] = r.c;
  }
  const tradePendingVerify = Number(tradeVerify.pending || 0);
  const tradeDatesImported = get('SELECT COUNT(*) AS c FROM trade_daily')?.c ?? 0;

  /* --- 数据异常 / 采集与缺口 ---
   * docs/44 第 4 条：总览**移除**「自动运行状态」与「数据缺口」两个版块，
   * 对所有用户（含管理员）均不展示；相关运行细节只在后台「运行与内容维护」
   * （管理员）可见。因此总览的指标口径里不再出现异常数、失败任务数、缺口数。 */

  /* --- 公开研报与动态（可公开的数据指标，取代原运行状态指标） --- */
  const contentSince = isoDaysAgo(30, f.as_of);
  let contentRecent = null;
  let contentLatest = null;
  try {
    contentRecent = get(
      `SELECT COUNT(*) AS c FROM content_item
       WHERE is_demo=0 AND duplicate_of IS NULL AND record_kind='article'
         AND COALESCE(process_status,'')<>'failed_fetch'
         AND COALESCE(published_at, collected_at) >= ?`,
      [contentSince]
    )?.c ?? 0;
    contentLatest = get(
      `SELECT MAX(COALESCE(published_at, collected_at)) AS d FROM content_item
       WHERE is_demo=0 AND duplicate_of IS NULL AND record_kind='article'`
    )?.d || null;
  } catch {
    contentRecent = null;
  }

  return {
    as_of: f.as_of,
    filters: f,
    metrics: [
      {
        key: 'dash.methodology_formal',
        label: '正式有效方法学数',
        value: formal.length,
        unit: '项',
        sub: `编号已从官方通知核实 ${formalVerifiedCode.length} 项 · 编号待核实 ${formalPendingCode.length} 项 · 草案 ${draft.length} 项`,
        note: formalPendingCode.length
          ? `其中 ${formalPendingCode.length} 项仅有名称与答记者问口径，编号未经发布通知逐条核实，系统不推测编号。`
          : '全部正式方法学的编号均已从官方发布通知逐条核实。',
        as_of: latestMethodologyDate(),
        source: '生态环境部方法学发布通知 + 系统方法学目录',
        caliber_key: 'dash.methodology_formal',
        drill: '#/policies?tab=methodologies',
        warn: formalPendingCode.length > 0,
      },
      {
        key: 'dash.policy_recent',
        label: '近 30 天新增/修订政策',
        value: policyRecent,
        unit: '条',
        sub: `政策库共 ${policyTotal} 条 · 最近发布 ${policyLast || '—'} · 官方原文变化自动检测 ${policyChangeDetected} 条`,
        note: '官方原文变化由每日巡检自动比对并留差异摘要，属自动运行状态，不需要管理员确认。',
        as_of: policyLast || f.as_of,
        source: '生态环境部及部委官方发布',
        caliber_key: 'dash.policy_recent',
        drill: '#/policies?tab=policies',
      },
      {
        key: 'dash.project_public',
        label: '公示项目数',
        value: Number(projectStats.public_cnt || 0),
        unit: '个',
        sub:
          `公开项目库 ${Number(projectStats.total || 0)} 个（已排除演示条目 ${demoProjects} 条）` +
          ` · 登记 ${Number(projectStats.registered_cnt || 0)} 个` +
          ` · 自动核验：通过 ${projectAutoVerify.verified || 0} / 证据不足 ${projectAutoVerify.insufficient || 0}`,
        note:
          '项目库按日读取注册登记系统公开页面的站内接口。本指标是**系统已收录、且已排除演示条目的业务数**，不代表全国总数。' +
          '演示条目只保留作历史留痕，不进入任何业务统计；缺少的项目可通过「公开项目导入模板」补充。',
        as_of: lastProjectCheckedAt() || f.as_of,
        source: '注册登记系统公开项目接口 + 自动采集',
        caliber_key: 'dash.project_public',
        drill: '#/projects?tab=public',
        warn: false,
      },
      {
        key: 'dash.reduction_registered',
        label: '已登记减排量',
        value: registeredReduction,
        unit: 'tCO₂e',
        sub:
          `业主公示预计量 ${fmtAmount(ownerAnnounced)} · 核查确定量 ${fmtAmount(verifiedAmount)}（已排除演示条目）`,
        note: '三个数字分开统计，不得互相替代：公示预计量 ≠ 核查量 ≠ 登记量；演示条目的批次不进入统计。',
        as_of: lastProjectCheckedAt() || f.as_of,
        source: '公开项目库 · 减排量批次（官方公开页面 / 导入）',
        caliber_key: 'dash.reduction_registered',
        drill: '#/projects?tab=public&stage=reduction_registered',
      },
      {
        key: 'dash.trade_latest',
        label: '最新交易日成交',
        value: latestTrade ? latestTrade.volume : null,
        unit: 'tCO₂e',
        sub: latestTrade
          ? `价格 ${fmtPrice(latestTrade.avg_price)} ${latestTrade.avg_price === null ? '' : '元/tCO₂e'} · 成交额 ${fmtAmount(latestTrade.turnover)} 元 · ${latestTrade.trade_method}`
          : '尚未导入任何有成交的交易日行情',
        note: latestTrade
          ? `成交均价 = 当日成交额 ÷ 当日成交量，**不是收盘价**。自动核对状态：${verifyLabel(latestTrade.verify_status)}。`
          : '交易系统未提供可稳定自动获取的公开接口；行情按官方公告页面自动采集后入库，界面不会用 0 元价格填充空白。',
        as_of: latestTrade ? latestTrade.trade_date : calendarLatest || f.as_of,
        source: latestTrade ? `全国温室气体自愿减排交易系统（${latestTrade.source_url || '官方公告'}）` : '交易信息 · 每日行情（官方公告采集）',
        caliber_key: 'dash.trade_latest',
        drill: '#/trades',
        warn: !latestTrade,
        extra: {
          last_imported_date: latestAnyTradeDate,
          imported_days: tradeDatesImported,
          pending_verify: tradePendingVerify,
          avg_price: latestTrade ? latestTrade.avg_price : null,
          turnover: latestTrade ? latestTrade.turnover : null,
          trade_date: latestTrade ? latestTrade.trade_date : null,
        },
      },
      {
        key: 'dash.content_recent',
        label: '近 30 天新收录研报与动态',
        value: contentRecent,
        unit: '条',
        sub: `公开研报、行业动态、机构观点与企业公告；最近一条 ${contentLatest ? String(contentLatest).slice(0, 10) : '—'}`,
        note:
          '统计口径：不含演示条目、不含转载副本，只计正文条目（来源首页/栏目页归档不计入）。' +
          '运行状态、采集失败与数据缺口属后台运行信息，不在公开总览展示。',
        as_of: contentLatest ? String(contentLatest).slice(0, 10) : f.as_of,
        source: '公开搜索 API + 网页抓取连接自动采集',
        caliber_key: 'dash.content_recent',
        drill: '#/content',
        warn: false,
      },
    ],
    // 数据自身的截至信息（不含运行告警 / 缺口细节：这些只在后台管理员可见）
    freshness: {
      trade_latest_date: latestTrade ? latestTrade.trade_date : null,
      trade_calendar_latest: calendarLatest,
      project_last_checked_at: lastProjectCheckedAt(),
      content_latest_at: contentLatest ? String(contentLatest).slice(0, 10) : null,
    },
  };
}

function latestMethodologyDate() {
  return get("SELECT MAX(release_date) AS d FROM methodology_version WHERE document_status = 'formal'")?.d || null;
}

function lastProjectCheckedAt() {
  return get('SELECT MAX(last_checked_at) AS d FROM public_project')?.d || null;
}

function fmtAmount(v) {
  if (v === null || v === undefined) return '—';
  return Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}
function fmtPrice(v) {
  if (v === null || v === undefined) return '—';
  return Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}
function verifyLabel(s) {
  return { pending: '待系统自动核对', verified: '系统自动核对通过', mismatch: '与官方公告不符（自动标注，保留原始记录）' }[s] || s;
}

/* ------------------------------------------------------------------ */
/*  市场走势                                                           */
/* ------------------------------------------------------------------ */

export function marketSeries({ range = '90d', as_of = todayCst(), trade_method = null } = {}) {
  const days = DASHBOARD_RANGES[range]?.days ?? null;
  const from = days ? isoDaysAgo(days, as_of) : null;
  const where = [];
  const params = [];
  if (from) {
    where.push('trade_date >= ?');
    params.push(from);
  }
  if (as_of) {
    where.push('trade_date <= ?');
    params.push(as_of);
  }
  if (trade_method) {
    where.push('trade_method = ?');
    params.push(trade_method);
  }
  const rows = all(
    `SELECT * FROM trade_daily ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY trade_date`,
    params
  );
  const calendar = all(
    `SELECT * FROM trade_calendar ${from ? 'WHERE trade_date >= ? AND trade_date <= ?' : 'WHERE trade_date <= ?'} ORDER BY trade_date`,
    from ? [from, as_of] : [as_of]
  );
  const calMap = new Map(calendar.map((c) => [c.trade_date, c]));
  const series = rows.map((r) => ({
    trade_date: r.trade_date,
    trade_method: r.trade_method,
    session_state: r.session_state,
    volume: r.session_state === 'traded' ? r.volume : null,
    turnover: r.session_state === 'traded' ? r.turnover : null,
    avg_price: r.session_state === 'traded' ? r.avg_price : null,
    verify_status: r.verify_status,
    source_url: r.source_url,
    published_at: r.published_at,
    revision: r.revision,
    note: r.note,
  }));
  // 把「有日历但无行情」与「工作日无任何记录」的日期显式标出，
  // 避免被误读为无成交；周末按星期推断为休市。
  const covByDate = new Map(series.map((s) => [s.trade_date, s]));
  const startDate =
    from ||
    series[0]?.trade_date ||
    calendar[0]?.trade_date ||
    as_of;
  const coverage = [];
  const dayMs = 86400000;
  const maxDays = 1500;
  for (
    let t = Date.parse(`${startDate}T00:00:00Z`), i = 0;
    t <= Date.parse(`${as_of}T00:00:00Z`) && i < maxDays;
    t += dayMs, i += 1
  ) {
    const d = new Date(t).toISOString().slice(0, 10);
    const s = covByDate.get(d);
    if (s) {
      coverage.push({ trade_date: d, state: s.session_state, has_record: true, verify_status: s.verify_status });
      continue;
    }
    const c = calMap.get(d);
    const dow = new Date(t).getUTCDay();
    if ((c && c.day_type !== 'trading') || dow === 0 || dow === 6) {
      coverage.push({ trade_date: d, state: 'closed', has_record: false, note: c?.note || '周末（非交易日）' });
    } else {
      coverage.push({
        trade_date: d,
        state: 'missing',
        has_record: false,
        note: c?.day_type === 'trading' ? '日历标为交易日但无行情记录' : '未采集/未导入',
      });
    }
  }
  return {
    range,
    range_label: DASHBOARD_RANGES[range]?.label || range,
    from: from || (series[0]?.trade_date ?? null),
    to: as_of,
    series,
    coverage,
    counts: {
      traded: coverage.filter((c) => c.state === 'traded').length,
      no_trade: coverage.filter((c) => c.state === 'no_trade').length,
      closed: coverage.filter((c) => c.state === 'closed' || c.state === 'weekend' || c.state === 'holiday').length,
      missing: coverage.filter((c) => c.state === 'missing').length,
    },    note:
      '有成交、无成交交易日、休市、数据暂缺分别显示，不用一个「0」混淆。' +
      '成交均价 = 当日成交额 ÷ 当日成交量，不是收盘价。',
  };
}

/* ------------------------------------------------------------------ */
/*  项目进度（分阶段，不相加）                                          */
/* ------------------------------------------------------------------ */

export function projectProgress(f = parseFilters()) {
  const pw = projectWhere(f);
  const rows = all(
    `SELECT p.id, p.registry_project_no, p.name, p.province, p.methodology_id,
            p.current_stage, p.updated_at,
            p.stage_project_public, p.stage_validated, p.stage_project_registered,
            p.stage_reduction_public, p.stage_verified, p.stage_reduction_registered
     FROM public_project p ${pw.sql}`,
    pw.params
  );
  const agg = aggregateProjectRows(rows);
  const stages = Object.entries(STAGE_LABELS).map(([key, label]) => ({
    stage: key,
    label,
    count: agg.stage_counts[key] || 0,
    drill: `#/projects?tab=public&stage=${key}`,
  }));
  return {
    stages,
    project_total: agg.total,
    note:
      '项目总数按官方登记编号去重（缺失时按项目 ID），同一项目多行阶段标记取并集。' +
      '各阶段**不是互斥分类**：一个项目可以同时处于多个已完成阶段，因此各阶段数量**不能相加**，' +
      '也不等于项目总数。项目总数单独统计；原始收录记录数保留在项目库中。',
  };
}

/* ------------------------------------------------------------------ */
/*  方法学分布                                                         */
/* ------------------------------------------------------------------ */

export function methodologyDistribution({ include_candidate = true } = {}) {
  const rows = all('SELECT * FROM methodology_version ORDER BY domain, methodology_id');
  const usable = include_candidate ? rows : rows.filter((r) => r.is_candidate_eligible);
  const byDomain = new Map();
  const byYear = new Map();
  for (const r of usable) {
    const d = r.domain || '未分类';
    if (!byDomain.has(d)) byDomain.set(d, { domain: d, formal: 0, draft: 0, total: 0 });
    const b = byDomain.get(d);
    if (r.document_status === 'formal') b.formal += 1;
    else b.draft += 1;
    b.total += 1;
    const y = (r.release_date || '').slice(0, 4) || '未标注';
    byYear.set(y, (byYear.get(y) || 0) + 1);
  }
  const projectCounts = all(
    `SELECT methodology_id, COUNT(*) AS c FROM public_project
     WHERE methodology_id IS NOT NULL AND COALESCE(is_demo,0)=0 GROUP BY methodology_id`
  );
  const pcMap = new Map(projectCounts.map((p) => [p.methodology_id, p.c]));
  const items = usable.map((r) => ({
    methodology_id: r.methodology_id,
    code_display: r.code_display,
    name: r.name,
    version: r.version,
    document_status: r.document_status,
    domain: r.domain,
    release_date: r.release_date,
    evidence_level: r.evidence_level || 'unverified',
    evidence_label: EVIDENCE_LEVELS[r.evidence_level || 'unverified']?.short || '未对照原文',
    rulecard_status: r.rulecard_status,
    calculator_status: r.calculator_status,
    catalog_confidence: r.catalog_confidence,
    is_candidate_eligible: !!r.is_candidate_eligible,
    exclusion_note: sanitizeLegacyWording(r.exclusion_note),
    public_projects: pcMap.get(r.methodology_id) || 0,
    drill: `#/policies?tab=methodologies&methodology_id=${encodeURIComponent(r.methodology_id)}`,
  }));
  return {
    items,
    by_domain: [...byDomain.values()].sort((a, b) => b.total - a.total),
    by_year: [...byYear.entries()].map(([year, count]) => ({ year, count })).sort((a, b) => String(a.year).localeCompare(String(b.year))),
    counts: {
      formal: items.filter((i) => i.document_status === 'formal').length,
      draft: items.filter((i) => i.document_status !== 'formal').length,
      code_verified: items.filter((i) => i.catalog_confidence === 'verified_from_official_notice').length,
      code_pending: items.filter((i) => i.catalog_confidence !== 'verified_from_official_notice').length,
      doc_verified: items.filter((i) => i.evidence_level === 'official_original_verified').length,
    },
    note:
      '草案与编号待核实项不得驱动资格判断与正式测算；' +
      '「已对照原文」表示规则与公式已逐条核对官方 PDF 并通过独立复算，但仍需参数确认才能出数。',
  };
}

/* ------------------------------------------------------------------ */
/*  地域与投资视图                                                     */
/* ------------------------------------------------------------------ */

export function regionView(f = parseFilters()) {
  const pw = projectWhere(f);
  const byProvince = all(
    `SELECT p.province, COUNT(*) AS projects,
            SUM(p.stage_project_registered) AS registered,
            SUM(p.stage_reduction_registered) AS reduction_registered,
            SUM(p.owner_announced_estimate) AS announced
     FROM public_project p ${pw.sql} ${pw.sql ? 'AND' : 'WHERE'} p.province IS NOT NULL
     GROUP BY p.province ORDER BY projects DESC`,
    pw.params
  );
  const focus = all(
    `SELECT p.id,p.name,p.province,p.methodology_id,p.current_stage,p.owner_announced_estimate,
            p.verified_amount,p.registered_amount,p.evidence_level,p.auto_verify_status,p.last_checked_at,
            (SELECT COUNT(*) FROM reduction_batch b WHERE b.public_project_id = p.id) AS batches
     FROM public_project p ${pw.sql} ORDER BY p.updated_at DESC LIMIT 20`,
    pw.params
  );
  const pendingEvidence = get(
    `SELECT COUNT(*) AS c FROM public_project p ${pw.sql ? `${pw.sql} AND` : 'WHERE'} p.evidence_level = 'unverified'`,
    pw.params
  )?.c ?? 0;
  const autoVerify = {};
  try {
    for (const r of all(
      `SELECT COALESCE(auto_verify_status,'none') s, COUNT(*) c FROM public_project p
       ${pw.sql ? pw.sql.replace(/^WHERE/, 'WHERE') : ''}
       GROUP BY COALESCE(auto_verify_status,'none')`,
      pw.params
    )) autoVerify[r.s] = r.c;
  } catch {
    /* 列尚未迁移 */
  }
  const gapItems = all("SELECT * FROM data_gap WHERE status = 'open' ORDER BY severity DESC, detected_at DESC");

  return {
    provinces: byProvince.map((r) => ({
      province: r.province,
      public_projects: r.projects,
      registered: Number(r.registered || 0),
      reduction_registered: Number(r.reduction_registered || 0),
      owner_announced_estimate: r.announced,
    })),
    focus_projects: focus.map((p) => ({ ...p, note: sanitizeLegacyWording(p.note) })),
    counts: {
      public_unverified_evidence: pendingEvidence,
      public_auto_verify: autoVerify,
    },
    data_gaps: gapItems.map(decorateGap),
    note:
      '本平台只整合公开项目，不再统计机构内部项目，演示条目也已从业务统计中排除。' +
      '公开项目的证据等级未经注册登记系统自动核对时一律标为「待核实」，不得作为官方状态引用；' +
      '「自动核验」为规则与模型的一致性检查结论，全流程无人工环节。',
  };
}

/**
 * 数据缺口展示口径（docs/22 第 16 条）：
 * 旧台账里的 manual_path 是**历史人工流程文案**，不能再作为现行处理路径展示。
 * 这里把缺口改写成「自动处理状态 + 自动补全方式」，原始记录只作为历史留痕折叠展示，
 * 不改写、不删除原始证据。
 *
 * 【回归修复】`gap-policy-original-archive` 是**动态缺口**：标题/影响/自动处理方式
 * 必须由实时归档状态推导。此前只有 description 被同步，标题仍停留在
 * 「部分政策原件（PDF）尚未归档与页码提取」，而实际上 14/14 原件已归档、
 * 只剩 2 条 JS 渲染页正文无法提取。展示层因此按实时状态覆盖该条文案，
 * 台账未及时同步也不会出现与事实相反的标题。
 */
export function decorateGap(gap) {
  let row = gap;
  if (gap.gap_key === 'gap-policy-original-archive') {
    try {
      const live = archiveSvc.policyArchiveGapState();
      row = {
        ...gap,
        title: live.title,
        description: live.description,
        impact: live.impact,
        auto_action: live.auto_action,
        status: live.status,
        live_checked_at: live.computed_at,
        archived_total: live.total,
        archived_pending: live.pending.length,
        unparsed_total: live.unparsed.length,
      };
    } catch {
      /* 实时推导失败时退回台账原文，不隐藏缺口 */
      row = gap;
    }
  }
  const autoAction = row.auto_action || {
    'gap-trade-daily': '自动采集官方每日行情公告（可重试）；未采集到的日期显示「数据暂缺」，不用 0 或旧数据填充。',
    'gap-methodology-pdf-og': '自动抓取官方 PDF 原文并归档哈希；未归档前该方法学只可检索与阅读，不参与测算。',
    'gap-catalog-8-pending': '从官方发布通知自动逐条比对编号；未核实前编号留空，不推测。',
    'gap-policy-original-archive': '随每日巡检自动抓取原件并计算哈希；未归档时条款只引用到章节层级。',
    'gap-llm-default-off': '未配置模型属已知限制：官方采集、规则判断与快捷估算不受影响，内容标记「暂未自动核验」并在配置后自动重试。',
  }[row.gap_key] || '由每日自动任务重试与补全；未完成时如实显示缺失状态。';
  return {
    ...row,
    // 历史数据里的标题/描述可能含旧人工流程措辞：展示层统一改写为自动口径，原库不动
    title: sanitizeLegacyWording(row.title),
    description: sanitizeLegacyWording(row.description),
    auto_action: autoAction,
    handling: '自动运行状态（无人工待办）',
    // 旧流程文案不进入公开总览页面；管理员后台仍可查看历史留痕（admin.listGaps）
    legacy_manual_path: null,
    manual_path: null,
    impact: sanitizeLegacyWording(row.impact),
  };
}

/* ------------------------------------------------------------------ */
/*  更新提醒                                                           */
/* ------------------------------------------------------------------ */

const SEVERITY_RANK = { critical: 0, high: 1, warning: 2, normal: 3, info: 4, low: 5 };

export function updateFeed({ limit = 30 } = {}) {
  const alerts = all(
    `SELECT a.*, (SELECT COUNT(*) FROM alert x WHERE x.status = 'open') AS open_total
     FROM alert a WHERE a.status != 'closed' AND a.source_id IS NOT NULL ORDER BY a.created_at DESC LIMIT ?`,
    [limit]
  );
  const notifications = all('SELECT * FROM notification ORDER BY created_at DESC LIMIT ?', [limit]);
  /* 【回归修复】提醒是「发现问题那一刻」的快照；问题（data_reconciliation / alert）
   * 结清后，提醒不得再以「待读 / 待关注」出现在总览。
   * 结清事实由 notification.resolved_at 记录（syncNotificationLifecycle），
   * 读路径再做一次判定，即使同步尚未跑到，也不会把已结清的旧提醒当成待关注。 */
  const notificationsSettled = notifications.filter((n) => notificationSettled(n));
  const notificationsPending = notifications.filter((n) => !notificationSettled(n));
  // 【本轮升级】不再读取 review_task（人工审核队列已取消）。
  // 改为展示「自动核验」中需要关注的结果：来源冲突与暂未自动核验（运行状态，非待办）。
  const verifyIssues = all(
    `SELECT v.*, c.title AS content_title, c.source_url AS content_url
     FROM verification_result v
     LEFT JOIN content_item c ON (v.object_type='content_item' AND c.id = v.object_id)
     WHERE v.result IN ('conflict','unavailable')
       AND (v.object_type!='content_item' OR (c.is_demo=0 AND c.record_kind='article' AND c.duplicate_of IS NULL AND COALESCE(c.process_status,'')!='failed_fetch'))
       AND (v.object_type!='public_project' OR EXISTS (SELECT 1 FROM public_project p WHERE p.id=v.object_id AND p.is_demo=0))
       AND NOT EXISTS (SELECT 1 FROM verification_result newer WHERE newer.object_type=v.object_type AND newer.object_id=v.object_id
         AND (newer.created_at>v.created_at OR (newer.created_at=v.created_at AND newer.rowid>v.rowid)))
     ORDER BY CASE v.result WHEN 'conflict' THEN 0 ELSE 1 END, v.created_at DESC LIMIT ?`,
    [limit]
  );
  const reconciliations = all(
    `SELECT * FROM data_reconciliation WHERE status = 'open' AND ${PUBLIC_RECON_FILTER}
     ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, detected_at DESC LIMIT ?`,
    [limit]
  );
  const items = [
    ...verifyIssues.map((v) => ({
      kind: 'verification',
      id: v.id,
      severity: v.result === 'conflict' ? 'warning' : 'info',
      title: sanitizeLegacyWording(v.result === 'conflict'
        ? `自动核验发现来源冲突：${v.content_title || v.object_id}`
        : `暂未自动核验：${v.content_title || v.object_id}`),
      detail: sanitizeLegacyWording(v.summary || v.error || ''),
      status: v.result === 'conflict' ? '来源冲突（不覆盖官方数值）' : '暂未自动核验（可自动重试）',
      at: v.created_at,
      drill: v.object_type === 'content_item' ? `#/content` : '#/admin?tab=verify',
    })),
    ...reconciliations.map((r) => ({
      kind: 'reconciliation',
      id: r.id,
      severity: r.severity,
      title: sanitizeLegacyWording(`数据核对：${r.object_label || r.object_id || r.dataset}`),
      detail: sanitizeLegacyWording(r.detail),
      status: '未结清差异（自动标注）',
      at: r.detected_at,
      drill: '#/admin?tab=reconciliation',
    })),
    ...alerts.map((a) => ({
      kind: 'alert',
      id: a.id,
      severity: a.severity,
      title: sanitizeLegacyWording(a.title),
      detail: sanitizeLegacyWording(a.detail),
      status: a.status === 'open' ? '自动告警未结清' : '已结清',
      at: a.created_at,
      drill: '#/policies?tab=changes',
    })),
    ...notificationsPending.map((n) => ({
      kind: 'notification',
      id: n.id,
      severity: n.severity,
      title: sanitizeLegacyWording(n.title),
      detail: sanitizeLegacyWording(n.detail),
      status: n.read_at ? '已读' : '待读',
      at: n.created_at,
      impact_level: n.impact_level,
      drill: drillForNotification(n),
    })),
  ]
    .sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9) || String(b.at).localeCompare(String(a.at)))
    .slice(0, limit);
  return {
    items,
    counts: {
      open_alerts: alerts.filter((a) => a.status === 'open').length,
      open_reconciliation: reconciliations.length,
      // 「未读提醒」只统计**仍未结清**的提醒；已随问题结清的历史提醒单独计数，不作为待关注。
      unread_notifications: notificationsPending.filter((n) => !n.read_at).length,
      settled_notifications: notificationsSettled.length,
      verification_conflict: verifyIssues.filter((v) => v.result === 'conflict').length,
      verification_unavailable: verifyIssues.filter((v) => v.result === 'unavailable').length,
    },
    note:
      '以上均为**自动运行状态**，不是人工待办：平台没有审核队列，冲突与未核验只作提示与检索，' +
      '不会自动覆盖官方数值，也不需要管理员批准内容。' +
      '所指向的核对记录 / 告警已结清的提醒会自动转为「已结清留痕」，不再列为待关注（仍保留在后台提醒记录与审计日志中，可检索）。',
  };
}

function drillForNotification(n) {
  switch (n.kind) {
    case 'new_policy':
    case 'methodology_revision':
      return '#/policies?tab=policies';
    case 'new_project':
      return '#/projects?tab=public';
    case 'trade_ready':
      return '#/trades';
    case 'ingestion_alert':
    case 'reconciliation':
      return '#/admin?tab=reconciliation';
    default:
      return '#/';
  }
}

/* ------------------------------------------------------------------ */
/*  概览聚合（一次请求返回首页所需全部组件）                            */
/* ------------------------------------------------------------------ */

/**
 * 概览聚合（一次请求返回首页所需全部组件）。
 *
 * 【docs/44 第 4 条】总览**不返回**运行告警与缺口细节：
 *   - 不再返回 `updates`（自动运行状态 / 更新提醒）；
 *   - `region` 中的 `data_gaps` 一律剥离（缺口明细只在后台「运行与内容维护」）。
 * 这些数据仍由 dash.updateFeed / dash.regionView 提供，供后台管理员接口使用。
 */
export function overview(query = {}) {
  const f = parseFilters(query);
  const metrics = topMetrics(f);
  const region = regionView(f);
  delete region.data_gaps;
  return {
    as_of: f.as_of,
    filters: f,
    filter_options: filterOptions(),
    metrics: metrics.metrics,
    freshness: metrics.freshness,
    market: marketSeries({ range: f.range, as_of: f.as_of }),
    progress: projectProgress(f),
    methodology: methodologyDistribution(),
    region,
    // 总览第 1、5 项：最新政策 + 最新研报与动态（标题下带核心摘要）
    policies: latestPolicies(6),
    content: latestContent(6),
    caliber: {
      metrics: metricDefinitions('总览'),
      trade: metricDefinition('trade.avg_price'),
      project: metricDefinition('project.stage'),
      note: '每个指标与图表均可查看口径说明并下载结构化数据；下载文件包含数据截点、来源与字段定义。',
    },
    note:
      '总览只展示公开数据本身（含截至日期、来源、单位与统计口径）；' +
      '采集运行状态、数据缺口与核验明细属后台运行信息，仅管理员在「运行与内容维护」中可见。',
  };
}

/** 总览用：最新政策（正式/征求意见分开标注） */
function latestPolicies(limit = 6) {
  try {
    return {
      latest: all(
        `SELECT id,title,doc_number,issuing_authority,category,doc_status,publish_date,effective_date,official_url
         FROM policy_document ORDER BY COALESCE(publish_date,'') DESC LIMIT ?`,
        [limit]
      ).map((p) => ({ ...p, status_label: POLICY_STATUS_LABEL[p.doc_status] || p.doc_status })),
    };
  } catch {
    return { latest: [] };
  }
}

/** 总览用：最新公开研报与行业动态（统计排除演示条目、转载副本与来源首页归档） */
function latestContent(limit = 6) {
  try {
    const stats = contentSvc.contentStats();
    const latest = all(
      `SELECT id,content_type,title,publisher,published_at,collected_at,verification_status,record_kind
       FROM content_item WHERE is_demo=0 AND duplicate_of IS NULL AND record_kind='article'
         AND COALESCE(process_status,'')<>'failed_fetch'
       ORDER BY COALESCE(published_at, collected_at) DESC, collected_at DESC LIMIT ?`,
      [limit]
    ).map((r) => ({
      ...r,
      published_at_known: !!r.published_at,
      content_type_label: contentSvc.CONTENT_TYPES[r.content_type]?.label || r.content_type,
    }));
    return { stats, latest };
  } catch {
    return { stats: null, latest: [] };
  }
}

export function filterOptions() {
  const domains = all(`SELECT DISTINCT domain FROM public_project WHERE COALESCE(is_demo,0)=0 AND domain IS NOT NULL ORDER BY domain`).map((r) => r.domain);
  const provinces = all(`SELECT DISTINCT province FROM public_project WHERE COALESCE(is_demo,0)=0 AND province IS NOT NULL ORDER BY province`).map((r) => r.province);
  const methodos = all(
    `SELECT DISTINCT methodology_id, methodology_version FROM public_project
     WHERE COALESCE(is_demo,0)=0 AND methodology_id IS NOT NULL ORDER BY methodology_id`
  ).map((r) => ({ methodology_id: r.methodology_id, version: r.methodology_version }));
  return {
    ranges: Object.entries(DASHBOARD_RANGES).map(([k, v]) => ({ key: k, label: v.label })),
    domains,
    provinces,
    methodologies: methodos,
    stages: Object.entries(STAGE_LABELS).map(([k, v]) => ({ key: k, label: v })),
  };
}
