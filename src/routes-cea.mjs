/**
 * CEA（全国碳排放配额）API 路由
 * ============================================================================
 * 依据 docs/31-CEA扩展开发规范.md「API契约」：
 *
 *   登录用户只读：
 *     GET /api/v2/cea/overview | /trade | /series | /comparison | /documents | /documents/:id
 *         /events | /entities | /intentions | /sources/status
 *     GET /api/v2/cea/export?dataset=trade|entities|intentions|documents|events&format=csv|json&from=&to=
 *   所有登录用户（仅计算、无持久化、无采集/配置副作用）：
 *     POST /api/v2/cea/scenario
 *   管理员：
 *     GET/POST /api/v2/admin/cea/config
 *     POST     /api/v2/admin/cea/collect
 *     GET      /api/v2/admin/cea/jobs
 *
 * 权限：所有 /api/v2/admin/cea/* 由 routes-v2.mjs 的后台守卫统一判定（仅 admin，其余 403）；
 *      未登录由 server.mjs 统一 401。写接口再叠加 writeGuard（v2 可用性 + 拒写生产库 + 同源校验）。
 * 导出：复用 export-svc（CSV 公式注入防护、导出审计、单位与口径写入表头）。
 */
import { get as dbGet, all as dbAll } from './core/db.mjs';
import { writeGuard, readGuard } from './services/http-guard.mjs';
import { requireRole } from './services/project-svc.mjs';
import { buildExport } from './services/export-svc.mjs';
import * as cea from './services/cea-svc.mjs';
import * as marketCandidate from './services/market-candidate-svc.mjs';
import * as ceaCollect from './services/cea-collect-svc.mjs';
import { guardCeaParams, CEA_LIMITS, CEA_DATASETS, CEA_FORMATS, CEA_GRANULARITY } from './services/cea-api-params.mjs';
import { parseCeaDailyReport } from './services/cea-parse.mjs';
import { verifyObject, verifyConfig, pickVerifyProvider } from './services/verification-svc.mjs';
import { uploadDocument, listCeaDocumentGaps, retryUploadedDocumentChecks } from './services/document-upload-svc.mjs';
import { ceaAfterCloseStatus, rescheduleCeaAfterClose } from './services/daily-scheduler.mjs';
// docs/44：统一「核心摘要」与「来源展示口径」（只读缓存，不在 GET 里生成摘要）
import * as summary from './services/summary-svc.mjs';
import { sourceDisplay } from './services/source-display-svc.mjs';

/** CEA 条目统一挂载核心摘要 + 来源展示（官方信息 / 实际发布机构 / 来源未标注）。 */
function withCeaSummaries(rows) {
  const attached = summary.attachSummaries('cea_document', Array.isArray(rows) ? rows : []);
  return attached.map((r) => ({
    ...r,
    source_display: sourceDisplay({
      url: r.official_url || r.first_source || r.page_url,
      publisher: r.issuer,
    }),
  }));
}

function exportResponse(ctx, { dataset, fileBase, format, columns, rows, meta, filters }) {
  const out = buildExport({
    user: ctx.user, dataset, fileBase, format: format || 'csv', columns, rows, meta: meta || {}, filters,
    ip: ctx.ip,
  });
  return {
    raw: {
      mime: out.mime,
      body: out.body,
      headers: {
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(out.file_name)}`,
        'x-export-sha256': out.sha256,
        'x-export-rows': String(out.row_count),
      },
    },
  };
}

const fmt = (params) => String(params.format || 'csv').toLowerCase();

/** 只读守卫：v2 未启用/表未就绪 → 503；未登录由 server.mjs 401 */
function readOnly(handler) {
  return async (ctx) => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    return handler(ctx);
  };
}

/** 参数校验守卫：非法参数一律 400，不静默回退默认值（阶段B 尾项4） */
function validated(spec, handler) {
  return async (ctx) => {
    const out = guardCeaParams(ctx.query, spec);
    if (out.denied) return out.denied;
    return handler(ctx, out.values);
  };
}

const DATE_RANGE = ['from', 'to'];
const LIMIT = (max, def) => ({ name: 'limit', min: 1, max, def });
const OFFSET = { name: 'offset', min: 0, max: 1_000_000, def: 0 };

export const CEA_RAW_ROUTES = [
  /* ===================== 只读：登录用户可见 ===================== */

  ['GET', '/api/v2/cea/overview', readOnly(async () => cea.ceaOverview())],

  ['GET', '/api/v2/cea/trade', readOnly(validated(
    {
      dates: DATE_RANGE, range: DATE_RANGE,
      ints: [LIMIT(CEA_LIMITS.trade.max, CEA_LIMITS.trade.def), OFFSET],
      enums: { instrument: ['CEA'], price_regime: [cea.CEA_PRICE_REGIME_2026, 'CEA_HISKLINE'], check_status: ['pass', 'warn', 'fail'], verification_status: ['unverified', 'verified', 'insufficient', 'conflict', 'unavailable'] },
    },
    async (ctx, v) => cea.listCeaTradeDaily({
      from: v.from || null,
      to: v.to || null,
      instrument: ctx.query.instrument || null,
      price_regime: ctx.query.price_regime || null,
      check_status: ctx.query.check_status || null,
      verification_status: ctx.query.verification_status || null,
      limit: v.limit,
      offset: v.offset,
    })
  ))],

  ['GET', '/api/v2/cea/trade/:id', readOnly(async (ctx) => {
    const row = cea.getCeaTradeDaily(ctx.params.id);
    if (!row) return { status: 404, body: { error: '未找到该 CEA 行情记录' } };
    return {
      row,
      checks: cea.listCeaChecks({ object_type: 'cea_trade_daily', object_id: row.id }),
      revisions: cea.listCeaTradeRevisions({ trade_daily_id: row.id, limit: 50 }),
      // 来源层级：精确通道（querySubStat）与概览通道（dailyov）分别标记，便于钻取
      quote_sources: cea.listQuoteSources({ trade_date: row.trade_date }),
      // 概览层（舍入展示值）单独返回，并带与精确值的跨层核对结果
      overview: cea.getCeaOverviewRow(row.trade_date),
      snapshot: row.snapshot_id ? dbGet('SELECT id,url,fetched_at,http_status,content_hash,content_bytes,parse_quality,parse_note,error FROM source_snapshot WHERE id=?', [row.snapshot_id]) : null,
      caliber_note:
        'close 为官方综合行情收盘价（2026 版为 CEA25 权重 1 的指定权重指数）；' +
        'computed_avg_price 为总成交额/总成交量的程序计算值。二者口径不同，不互相替代。' +
        'overview 为官方概览层（万吨/亿元舍入展示值），不覆盖上面的精确值。',
    };
  })],

  ['GET', '/api/v2/cea/calendar', readOnly(validated(
    { dates: DATE_RANGE, range: DATE_RANGE, ints: [LIMIT(2000, 400)], enums: { day_type: ['holiday', 'trading', 'unknown'] } },
    async (ctx, v) => {
      // 分层展示：正式公告 / 机器辅助列表 / 实际成交三层证据 + 独立异常列表
      const layered = cea.ceaCalendarLayered({ from: v.from || null, to: v.to || null, limit: v.limit });
      if (ctx.query.day_type) {
        layered.rows = layered.rows.filter((r) =>
          Object.values(r.layers || {}).some((l) => l.day_type === ctx.query.day_type));
      }
      return {
        ...layered,
        checks: cea.listCeaCalendarChecks({ from: v.from || null, to: v.to || null, limit: 500 }),
        note:
          'CEA 独立日历证据（不复用 CCER 交易日历）。正式全年休市公告（official_notice）优先于官方查询页使用的' +
          '机器辅助列表（holidays_json）；两者矛盾时保留双方原文、单独列出异常，并把该日按实际成交/正式公告处理。' +
          '不生成人工复核任务；行情数值不因机器列表异常被判为不真实。',
      };
    }
  ))],

  ['GET', '/api/v2/cea/series', readOnly(validated(
    { dates: DATE_RANGE, range: DATE_RANGE, enums: { granularity: CEA_GRANULARITY } },
    async (ctx, v) => cea.ceaSeries({ from: v.from || null, to: v.to || null, granularity: v.granularity || 'day' })
  ))],

  /* 真实历史价格层：来源历史价格（hiskline）与精确日统计（querySubStat）分层返回，不互相覆盖 */
  ['GET', '/api/v2/cea/price-history', readOnly(validated(
    { dates: DATE_RANGE, range: DATE_RANGE, ints: [LIMIT(CEA_LIMITS.history.max, CEA_LIMITS.history.def)] },
    async (ctx, v) => ({
      ...cea.ceaPriceHistoryLayered({ from: v.from || null, to: v.to || null, limit: v.limit }),
      snapshot_sources: cea.listQuoteSources({ limit: 50 }).filter((s) => s.channel === 'hiskline_json'),
      note:
        '只读历史价格层。source_history 来自官方公开 hiskline.json（真实长期价格序列，含来源快照与抓取时间），' +
        '其 volume_reference 不是全国全方式成交量，且不生成成交额/全方式均价；' +
        'precise_daily 来自 querySubStat 精确日统计。图表需分开图例。',
    })
  ))],

  ['GET', '/api/v2/cea/summary', readOnly(validated(
    { dates: DATE_RANGE, range: DATE_RANGE },
    async (ctx, v) => cea.ceaSummary({ from: v.from || null, to: v.to || null })
  ))],

  ['GET', '/api/v2/cea/comparison', readOnly(validated(
    { dates: DATE_RANGE, range: DATE_RANGE, ints: [LIMIT(CEA_LIMITS.comparison.max, CEA_LIMITS.comparison.def)] },
    async (ctx, v) => cea.ceaComparison({ from: v.from || null, to: v.to || null, limit: v.limit })
  ))],

  ['GET', '/api/v2/cea/documents', readOnly(validated(
    {
      ints: [{ name: 'year', min: 2000, max: 2100 }, LIMIT(500, 100)],
      enums: {
        doc_type: ['policy', 'technical', 'research', 'news'],
        doc_status: ['formal', 'draft', 'consultation', 'historical', 'superseded'],
        ai_status: ['unverified', 'verified', 'insufficient', 'conflict', 'unavailable'],
        include_attachments: ['true', 'false'],
      },
      passthrough: ['category', 'sector', 'q'],
    },
    async (ctx, v) => {
      const out = cea.listCeaDocuments({
        doc_type: ctx.query.doc_type || null,
        category: v.category || null,
        doc_status: ctx.query.doc_status || null,
        sector: v.sector || null,
        year: v.year ?? null,
        ai_status: ctx.query.ai_status || null,
        q: v.q || null,
        limit: v.limit,
      });
      // 指定行业/年度时，rows 已按**行业×年度配对**过滤（applicable=false 不返回），
      // 并带上配对判定依据供来源钻取。
      if (ctx.query.include_attachments !== 'true') {
        const before = out.rows.length;
        out.rows = out.rows.filter((d) => Number(d.count_in_stats) === 1);
        out.attachments_hidden = before - out.rows.length;
        out.attachment_note = '默认隐藏官方 PDF 附件行（count_in_stats=0），避免同一份通知被重复计数；加 include_attachments=true 可查看。';
      }
      out.total = out.rows.length;
      out.rows = withCeaSummaries(out.rows);
      return out;
    }
  ))],

  /* CEA 研报与行业动态：第一来源 / 机构 / 发布日期 / 数据截止日 / 观点标记 */
  ['GET', '/api/v2/cea/research', readOnly(validated(
    {
      ints: [LIMIT(200, 100)],
      enums: { doc_type: ['research', 'news'], viewpoint: ['research_opinion', 'market_news', 'institution_view', 'official_fact'] },
      passthrough: ['q', 'issuer'],
    },
    async (ctx, v) => {
      const out = cea.listCeaResearch({ doc_type: ctx.query.doc_type || null, viewpoint: ctx.query.viewpoint || null, q: v.q || null, limit: v.limit });
      if (v.issuer) out.rows = out.rows.filter((r) => String(r.issuer || '').includes(v.issuer));
      out.total = out.rows.length;
      // 公开列表**以来源为主**（官方信息 / 实际发布机构 / 来源未标注），核验数据保留后台
      out.rows = withCeaSummaries(out.rows);
      return out;
    }
  ))],

  ['GET', '/api/v2/cea/documents/:id', readOnly(async (ctx) => {
    const doc = cea.getCeaDocument(ctx.params.id);
    if (!doc) return { status: 404, body: { error: '未找到该 CEA 文件' } };
    const [row] = withCeaSummaries([{ id: doc.id, ...(doc.document || doc) }]);
    return { ...doc, document: row ? { ...(doc.document || {}), ...row } : doc.document, summary_block: row?.summary_block || null };
  })],

  ['GET', '/api/v2/cea/events', readOnly(validated(
    {
      dates: DATE_RANGE, range: DATE_RANGE, ints: [{ name: 'year', min: 2000, max: 2100 }, LIMIT(500, 200)],
      enums: {
        event_type: ['allocation_plan_issued', 'list_published', 'preallocation', 'adjustment', 'surrender_deadline', 'carryover_deadline', 'data_report_deadline', 'other'],
        date_verify_status: ['unverified', 'verified', 'insufficient', 'conflict', 'unavailable'],
      },
    },
    async (ctx, v) => cea.listCeaEvents({
      event_type: ctx.query.event_type || null,
      year: v.year ?? null,
      from: v.from || null,
      to: v.to || null,
      limit: v.limit,
    })
  ))],

  ['GET', '/api/v2/cea/entities', readOnly(validated(
    {
      ints: [{ name: 'list_year', min: 2000, max: 2100 }, LIMIT(2000, 200), OFFSET],
      enums: { status: ['new', 'existing', 'exit', 'unknown'] },
      passthrough: ['province', 'sector', 'q'],
    },
    async (ctx, v) => cea.listCeaEntities({
      province: v.province || null,
      sector: v.sector || null,
      list_year: v.list_year ?? null,
      status: ctx.query.status || null,
      q: v.q || null,
      limit: v.limit,
      offset: v.offset,
    })
  ))],

  ['GET', '/api/v2/cea/entities/:id', readOnly(async (ctx) => {
    const out = cea.getCeaEntityProfile(ctx.params.id);
    if (!out) return { status: 404, body: { error: '未找到该企业档案' } };
    return out;
  })],

  ['POST', '/api/v2/admin/cea/entities/:id/aliases', async (ctx) => {
    const g = writeGuard(ctx); if (g) return { status: g.status, body: g };
    const denied = requireRole(ctx.user, ['admin'], '维护企业别名'); if (denied) return { status: denied.status, body: denied };
    const b = ctx.body || {};
    const out = cea.addCeaEntityAlias(ctx.user, {
      entityId: ctx.params.id, alias: b.alias, sourceCode: b.source_code || null,
      sourceUrl: b.source_url || null, evidenceNote: b.evidence_note || null,
    });
    return out.error ? { status: out.status || 400, body: out } : out;
  }],

  ['GET', '/api/v2/cea/intentions', readOnly(validated(
    {
      dates: DATE_RANGE, range: DATE_RANGE,
      ints: [{ name: 'quota_year', min: 2000, max: 2100 }, LIMIT(2000, 200)],
      enums: { direction: ['buy', 'sell', 'unknown'] },
    },
    async (ctx, v) => cea.listCeaIntentions({
      direction: ctx.query.direction || null,
      quota_year: v.quota_year ?? null,
      from: v.from || null,
      to: v.to || null,
      limit: v.limit,
    })
  ))],

  ['GET', '/api/v2/cea/sources/status', readOnly(async () => {
    const status = ceaCollect.ceaSyncStatus();
    const vcfg = verifyConfig();
    return {
      sources: cea.listCeaSources({}),
      sync: status,
      gaps: cea.listCeaGaps({ status: 'open' }),
      verification: {
        enabled: !!vcfg.enabled,
        scopes: vcfg.scopes,
        provider_configured: !!pickVerifyProvider(vcfg),
        note: pickVerifyProvider(vcfg)
          ? '已配置可用模型：CEA 条目可进行证据一致性核验（引文必须能在提供的原文中定位）。'
          : '未配置可用模型：CEA 条目保持 unverified，平台不伪造 verified。',
      },
      note:
        '某一来源失败不中断全站采集，也不会把上一日行情标成当日；失败与缺口在此如实展示。',
    };
  })],

  /* ===================== 导出（登录用户） ===================== */

  ['GET', '/api/v2/cea/export', readOnly(validated(
    {
      dates: DATE_RANGE, range: DATE_RANGE,
      ints: [{ name: 'year', min: 2000, max: 2100 }, { name: 'list_year', min: 2000, max: 2100 }, { name: 'quota_year', min: 2000, max: 2100 }],
      enums: { format: CEA_FORMATS, direction: ['buy', 'sell', 'unknown'], doc_type: ['policy', 'technical', 'research', 'news'] },
      requiredEnums: null,
      passthrough: ['sector', 'province', 'category'],
    },
    async (ctx, v) => {
      const dataset = String(ctx.query.dataset || 'trade');
      // dataset 是必填枚举：非法值 400，不静默当成 trade（否则调用方会拿到错误数据集）
      if (!CEA_DATASETS.includes(dataset)) {
        return {
          status: 400,
          body: { error: `参数 dataset 不合法：只接受 ${CEA_DATASETS.join(' | ')}`, parameter: 'dataset', value: dataset, allowed: CEA_DATASETS },
        };
      }
      const built = cea.ceaExportRows(dataset, { ...ctx.query, ...v });
      if (built.error) return { status: built.status || 400, body: built };
      return exportResponse(ctx, {
        dataset: `CEA-${dataset}`,
        fileBase: `cea_${dataset}`,
        format: v.format || 'csv',
        columns: built.columns,
        rows: built.rows,
        meta: built.meta,
        filters: { ...ctx.query, ...v },
      });
    }
  ))],

  /* ===================== 情景工具（登录用户；只计算） ===================== */

  ['POST', '/api/v2/cea/scenario', async (ctx) => {
    // 情景工具不写库、不采集、不改配置；但仍做同源校验，避免被跨站页面滥用为计算代理
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    const out = cea.runCeaScenario(ctx.body || {});
    if (out.error) return { status: out.status || 400, body: out };
    return out;
  }],

  ['GET', '/api/v2/cea/scenario/presets', readOnly(async () => ({
    presets: cea.CEA_OFFSET_PRESETS,
    note: cea.CEA_SCENARIO_NOTE,
    formula: {
      gap_D: 'max(E - A, 0)',
      offset_Q: 'min(D, C, max(E*r - U, 0))',
      cea_only_cost: 'D * P1',
      combined_reference_cost: '(D - Q) * P1 + Q * P2 + 新增费用',
    },
  }))],

  /* 成本表单 P2 的 **CCER** 参考价（docs/35 第 8 条）：
     只读 CCER 独立交易行情（trade_daily.market='CCER'），与 CEA 指数行情完全分开；
     每条带 CCER 交易日、来源 URL、口径（成交均价 vs 计算均价）与核验状态。
     没有可靠 CCER 参考时 available=false，UI 只能手动输入并说明缺失——绝不回落到 CEA 价格。 */
  ['GET', '/api/v2/cea/scenario/ccer-quotes', readOnly(async (ctx) => {
    const limit = Math.min(Math.max(Number(ctx.query.limit) || 20, 1), 60);
    const rows = dbAll(
      `SELECT trade_date, trade_method, volume, turnover, avg_price, session_state, source_url, verify_status, note
         FROM trade_daily
        WHERE market='CCER' AND session_state='traded'
        ORDER BY trade_date DESC LIMIT ?`,
      [limit]
    );
    const usable = rows.filter((r) => Number.isFinite(Number(r.avg_price)) && Number(r.avg_price) > 0);
    // 区间量加权计算均价：Σ成交额 ÷ Σ成交量（只覆盖所选样本，标注为计算值，不冒充官方披露价）
    const sumV = usable.reduce((n, r) => n + (Number(r.volume) || 0), 0);
    const sumT = usable.reduce((n, r) => n + (Number(r.turnover) || 0), 0);
    const computed = sumV > 0 && Number.isFinite(sumT) ? Math.round((sumT / sumV) * 10000) / 10000 : null;
    return {
      market: 'CCER',
      instrument: 'CCER（国家核证自愿减排量）',
      available: usable.length > 0,
      reliable_count: usable.filter((r) => r.verify_status === 'verified').length,
      latest: usable[0]
        ? {
          trade_date: usable[0].trade_date, avg_price: usable[0].avg_price,
          source_url: usable[0].source_url, verify_status: usable[0].verify_status,
          caliber: '成交均价（官方披露口径）',
        }
        : null,
      computed_avg: computed === null ? null : {
        value: computed,
        window: `${usable.length} 个最近 CCER 交易日（${usable[usable.length - 1]?.trade_date || '—'} 至 ${usable[0]?.trade_date || '—'}）`,
        caliber: '区间量加权计算均价 = Σ成交额 ÷ Σ成交量（计算值，不是官方披露价）',
      },
      quotes: usable.map((r) => ({
        trade_date: r.trade_date,
        price: Number(r.avg_price),
        caliber: '成交均价（官方披露口径）',
        trade_method: r.trade_method,
        volume: r.volume, turnover: r.turnover,
        source_url: r.source_url, verify_status: r.verify_status,
      })),
      note:
        'CCER 参考价来自 CCER 独立交易行情（market=CCER），与 CEA 综合行情（CEA25 指数）是不同的市场与口径：' +
        '本接口绝不返回 CEA 价格，P2 也不得回落到 CEA 行情。' +
        (usable.length ? '' : '当前没有可用的 CCER 成交行情：请手动输入 P2 并自行记录日期与来源。'),
      missing_reason: usable.length ? null : '库中没有 CCER 独立交易行情记录（market=CCER 且 session_state=traded）',
    };
  })],

  /* ===================== 管理员：第三方行情候选 ===================== */
  // 候选独立表；本组接口不触碰 cea_trade_daily。普通用户/viewer 由统一后台守卫 403。
  ['GET', '/api/v2/admin/market-candidates', async (ctx) => {
    const g = readGuard(); if (g) return { status: g.status, body: g };
    const denied = requireRole(ctx.user, ['admin'], '查看第三方行情候选'); if (denied) return { status: denied.status, body: denied };
    return {
      ok: true,
      imports: marketCandidate.listMarketCandidateImports({ limit: ctx.query.limit }),
      rows: marketCandidate.listMarketCandidates({
        importId: ctx.query.import_id || null,
        status: ctx.query.status || null,
        limit: ctx.query.row_limit,
      }),
      limits: marketCandidate.MARKET_CANDIDATE_LIMITS,
      note: '第三方候选只用于差异报告；不写官方行情，不以均价补收盘价。',
    };
  }],

  ['POST', '/api/v2/admin/market-candidates/import', async (ctx) => {
    const g = writeGuard(ctx); if (g) return { status: g.status, body: g };
    const denied = requireRole(ctx.user, ['admin'], '导入第三方行情候选'); if (denied) return { status: denied.status, body: denied };
    const b = ctx.body || {};
    const out = marketCandidate.importMarketCandidates({
      user: ctx.user,
      text: b.text,
      format: String(b.format || 'csv').toLowerCase(),
      sourceName: b.source_name || null,
      sourceUrl: b.source_url || null,
      asOf: b.as_of || null,
      fileName: b.file_name || null,
      stale: b.stale === true,
    });
    return out.error ? { status: out.status || 400, body: out } : out;
  }],

  ['GET', '/api/v2/admin/market-candidates/export', async (ctx) => {
    const g = readGuard(); if (g) return { status: g.status, body: g };
    const denied = requireRole(ctx.user, ['admin'], '导出行情候选差异'); if (denied) return { status: denied.status, body: denied };
    const format = ['csv', 'json', 'xlsx'].includes(fmt(ctx.query)) ? fmt(ctx.query) : 'csv';
    const exported = marketCandidate.marketCandidateExport({
      importId: ctx.query.import_id || null, status: ctx.query.status || null,
    });
    return exportResponse(ctx, {
      dataset: 'market_candidates', fileBase: 'cea_market_candidates', format,
      columns: exported.columns, rows: exported.rows, meta: exported.meta,
      filters: { import_id: ctx.query.import_id || null, status: ctx.query.status || null },
    });
  }],

  /* ===================== 管理员：配置 / 采集 / 任务 ===================== */

  ['GET', '/api/v2/admin/cea/config', async () => ({
    config: ceaCollect.ceaCollectConfig(),
    defaults: ceaCollect.CEA_COLLECT_DEFAULT_CONFIG,
    limits_note:
      '服务端硬上限：每轮采集 ≤8 条、补证 ≤2 轮、单批时间 ≤600000ms（建议 ≤120000ms）、' +
      '当日抓取次数 ≤500（默认 60）。超限配置会被拒绝。',
    quota: ceaCollect.ceaQuotaState(),
    sync: ceaCollect.ceaSyncStatus(),
    // 收盘后轻量增量的真实调度状态（下一个运行时间由实际定时器计算，不是配置回显）
    after_close: ceaAfterCloseStatus(),
  })],

  ['POST', '/api/v2/admin/cea/config', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    const denied = requireRole(ctx.user, ['admin'], '配置 CEA 采集');
    if (denied) return { status: denied.status, body: denied };
    const out = ceaCollect.saveCeaCollectConfig(ctx.user, ctx.body || {});
    if (out.error) return { status: out.status || 400, body: out };
    // 配置保存后立即重排收盘后增量：开关/时间改动真实生效，并返回下一次运行时间
    const patch = ctx.body || {};
    if (patch.after_close_enabled !== undefined || patch.after_close_time !== undefined) {
      await rescheduleCeaAfterClose();
    }
    return { ...out, after_close: ceaAfterCloseStatus() };
  }],

  /* 管理员触发采集（docs/35 第 6 条）：
     后台异步启动有界任务，POST **立即返回 202 + task_id**，不再 await 外部采集
     （旧实现会让 UI 等 120 秒并被反代超时）。任务重入合并，不重复抓取，
     也不把仍在运行的旧任务提前关闭；进度与失败原因由 GET /admin/cea/jobs?task_id= 查询。 */
  ['POST', '/api/v2/admin/cea/collect', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    const denied = requireRole(ctx.user, ['admin'], '触发 CEA 采集');
    if (denied) return { status: denied.status, body: denied };
    const body = ctx.body || {};
    const target = String(body.target || 'daily');
    const actor = ctx.user?.name || 'unknown';
    const cfg = ceaCollect.ceaCollectConfig();
    const accepted = ceaCollect.startCeaCollectTask({ target, body, actor, cfg });
    if (accepted.error) return { status: accepted.status || 400, body: accepted };
    return { status: 202, body: accepted };
  }],

  /* 管理员：CEA 文件原件补充（PDF / OCR 副本）。
     普通用户 403（requireRole + uploadDocument 内部二次校验）；
     与官方 URL 字节完全一致的副本才提升为 official_hash_match，其余保留 admin_supplied_unverified 层级；
     扫描件不凭 metadata 伪造正文：无正文时 parse_quality=failed 并如实说明。 */
  ['GET', '/api/v2/admin/cea/document-gaps', async (ctx) => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    const denied = requireRole(ctx.user, ['admin'], '查看 CEA 原件补充入口');
    if (denied) return { status: denied.status, body: denied };
    return listCeaDocumentGaps();
  }],

  ['POST', '/api/v2/admin/cea/upload', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    const denied = requireRole(ctx.user, ['admin'], '上传 CEA 公开原件');
    if (denied) return { status: denied.status, body: denied };
    const body = ctx.body || {};
    if (!body.id) return { status: 400, body: { error: '缺少 id（CEA 文件 id）', parameter: 'id' } };
    const doc = cea.getCeaDocument(String(body.id));
    if (!doc) return { status: 404, body: { error: '未找到该 CEA 文件' } };
    const out = await uploadDocument(ctx.user, {
      kind: 'cea_document',
      id: String(body.id),
      file_name: body.file_name,
      pdf_base64: body.pdf_base64,
      ocr_text: body.ocr_text,
    });
    return out.ok === false ? { status: out.status || 400, body: out } : out;
  }],

  /* 管理员：重试尚无模型结论的补充文件（含 CEA） */
  ['POST', '/api/v2/admin/cea/retry-uploads', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    const denied = requireRole(ctx.user, ['admin'], '重试补充文件核验');
    if (denied) return { status: denied.status, body: denied };
    const stats = await retryUploadedDocumentChecks({ actor: ctx.user?.name || 'admin', limit: Number(ctx.body?.limit) || 20 });
    return { ...stats, note: '仅重试 ai_result=unavailable 且有正文的补充文件；来源层级不因重试而被提升。' };
  }],

  /* 后台任务列表：ingestion_job（真实入库任务）+ 进程内异步任务（queued/running/结束与错误）。
     ?task_id=CEATASK-… 时额外返回该任务详情，供 UI 按实际 task_id 轮询。 */
  ['GET', '/api/v2/admin/cea/jobs', async (ctx) => {
    const taskId = ctx.query.task_id ? String(ctx.query.task_id) : null;
    const task = taskId ? ceaCollect.getCeaCollectTask(taskId) : null;
    return {
      jobs: dbAll(
        `SELECT * FROM ingestion_job WHERE job_key LIKE 'cea%' ORDER BY started_at DESC LIMIT ?`,
        [Math.min(Number(ctx.query.limit) || 20, 200)]
      ),
      tasks: ceaCollect.listCeaCollectTasks({ limit: Number(ctx.query.limit) || 20 }),
      task,
      task_id: taskId,
      steps: ctx.query.job_id
        ? dbAll('SELECT * FROM ingestion_step WHERE job_id=? ORDER BY step_order', [ctx.query.job_id])
        : [],
      cursors: dbAll("SELECT * FROM dataset_cursor WHERE dataset LIKE 'cea%' ORDER BY dataset"),
      gaps: cea.listCeaGaps({ status: ctx.query.gap_status || 'open' }),
      note: 'tasks 为本次服务进程内受理的异步采集请求（POST 返回的 task_id 在此查询）；' +
        'jobs 为已落库的真实采集任务（含运行中/结束状态与错误摘要）。无结果时 status 不会是 success。',
    };
  }],

  ['GET', '/api/v2/admin/cea/jobs/:id', async (ctx) => {
    const job = dbGet('SELECT * FROM ingestion_job WHERE id=?', [ctx.params.id]);
    if (!job) return { status: 404, body: { error: '未找到该任务' } };
    return {
      job,
      steps: dbAll('SELECT * FROM ingestion_step WHERE job_id=? ORDER BY step_order', [job.id]),
      detail: job.detail_json ? JSON.parse(job.detail_json) : null,
    };
  }],

  /* 管理员手动核验 CEA 条目（真实调用既有 provider；无凭据则 unavailable，不伪造） */
  ['POST', '/api/v2/admin/cea/verify', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    const denied = requireRole(ctx.user, ['admin'], '核验 CEA 条目');
    if (denied) return { status: denied.status, body: denied };
    const body = ctx.body || {};
    const actor = ctx.user?.name || 'unknown';
    if (body.object_type === 'cea_trade_daily' && body.object_id) {
      return verifyObject('cea_trade_daily', body.object_id, { actor, force: body.force === true });
    }
    if (body.object_type === 'cea_document' && body.object_id) {
      return verifyObject('cea_document', body.object_id, { actor, force: body.force === true });
    }
    if (body.target === 'documents') return ceaCollect.verifyCeaDocuments({ actor, limit: Number(body.limit) || 8 });
    return ceaCollect.verifyCollectedCea(Array.isArray(body.record_ids) ? body.record_ids : [], { actor, limit: Number(body.limit) || 8 });
  }],

  /* 管理员：仅解析（不发网络请求），用于核对解析器与原文的对应关系 */
  ['POST', '/api/v2/admin/cea/parse-preview', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    const denied = requireRole(ctx.user, ['admin'], '预览 CEA 解析结果');
    if (denied) return { status: denied.status, body: denied };
    const body = ctx.body || {};
    if (!body.content) return { status: 400, body: { error: '缺少 content（原始 HTML/文本）' } };
    const parsed = parseCeaDailyReport(String(body.content).slice(0, 500_000), { url: body.url || '', tradeDateHint: body.trade_date || null });
    return {
      parsed,
      note: '只做解析与确定性核对，不写库、不外发请求。未在原文披露的字段为 null（不用 0 填充）。',
    };
  }],
];

export default CEA_RAW_ROUTES;
