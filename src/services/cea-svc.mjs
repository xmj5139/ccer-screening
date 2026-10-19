/**
 * CEA 数据服务（全国碳排放配额）
 * ============================================================================
 * 依据 docs/31-CEA扩展开发规范.md、docs/decisions/ADR-002。
 *
 * 覆盖：
 *   - 来源登记与基础数据（政策/配额元数据、履约日历事件）
 *   - CEA 日行情入库（幂等 + 修订留痕 + 确定性核对落库）
 *   - 行情序列 / 区间汇总 / 同日 CEA-CCER 对比（缺一侧即 null）
 *   - 政策文件、履约日历、重点排放单位名录、公开交易意向
 *   - 轻量履约成本情景（**无持久化**、无采集副作用）
 *   - 导出数据行与缺口登记
 *
 * 纪律：
 *   - 未披露字段保持 NULL；不用 0、不用前值、不用模型推测填充。
 *   - 官方公布值与程序推导值分列（close vs computed_avg_price）。
 *   - 意向表与成交表严格分离：任何统计都不得把意向计入成交。
 *   - 名录数量不等于买家数量；不提供企业持仓或实际盈缺。
 */
import { all, get, run, tx, audit } from '../core/db.mjs';
import { newId, nowIso, todayCst, round, j, uj, isDate } from '../core/util.mjs';
import { CEA_SOURCES, CEA_DOCUMENTS, CEA_EVENTS, CEA_DEFAULTS, CEA_SCENARIO_NOTE } from '../data/cea-sources.mjs';
import { deriveDaily, runDailyChecks } from './cea-parse.mjs';

export const CEA_PRICE_REGIME_2026 = 'CEA_COMPOSITE_2026';
export const CEA_INSTRUMENT = 'CEA';
export const CEA_MARKET_SCOPE = 'national';
// 情景工具的口径说明：API 与 CLI 都会直接引用，必须对外导出
export { CEA_SCENARIO_NOTE };

/** 数据缺口台账中 CEA 相关的 dataset 命名空间（与 CCER 分开统计） */
export const CEA_GAP_DATASETS = {
  trade: 'cea_trade',
  document: 'cea_document',
  entity: 'cea_entity',
  intention: 'cea_intention',
  attachment: 'cea_attachment',
  calendar: 'cea_calendar',
  research: 'cea_research',
  price_history: 'cea_price_history',
};

/* ==================================================================== */
/*  一、来源登记与基础数据                                              */
/* ==================================================================== */

/** 幂等写入官方来源清单（只改登记信息与运行状态字段，不触碰行情数据） */
export function ensureCeaSources({ actor = 'system:cea' } = {}) {
  const now = nowIso();
  let created = 0;
  let updated = 0;
  for (const s of CEA_SOURCES) {
    const ex = get('SELECT id FROM cea_source WHERE code=?', [s.code]);
    if (!ex) {
      run(
        `INSERT INTO cea_source
         (id,code,name,url,dataset,kind,method,body_template,authority,allowed_domains,enabled,priority,note,
          last_status,items_ok,items_failed,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'never',0,0,?,?)`,
        [
          newId('CEASRC'), s.code, s.name, s.url, s.dataset, s.kind || null,
          s.method || 'GET', s.body_template ? j(s.body_template) : null, s.authority || null,
          j(s.allowed_domains || []), s.enabled === false ? 0 : 1, Number.isFinite(s.priority) ? s.priority : 100,
          s.note || null, now, now,
        ]
      );
      created += 1;
    } else {
      // 来源地址变更必须留下审计痕迹（URL 白名单与 SSRF 检查在采集侧执行）
      const before = get('SELECT url, allowed_domains FROM cea_source WHERE id=?', [ex.id]);
      run(
        `UPDATE cea_source SET name=?, url=?, dataset=?, kind=?, method=?, body_template=?, authority=?,
           allowed_domains=?, priority=?, note=?, updated_at=? WHERE id=?`,
        [
          s.name, s.url, s.dataset, s.kind || null, s.method || 'GET',
          s.body_template ? j(s.body_template) : null, s.authority || null,
          j(s.allowed_domains || []), Number.isFinite(s.priority) ? s.priority : 100, s.note || null, now, ex.id,
        ]
      );
      if (before && before.url !== s.url) {
        audit({
          actor, action: 'cea.source_url_change', objectType: 'cea_source', objectId: ex.id,
          detail: { from: before.url, to: s.url, note: '来源地址变更需经 URL 白名单与 SSRF 检查后才可采集' },
        });
      }
      updated += 1;
    }
  }
  return { created, updated, total: CEA_SOURCES.length };
}

/** 来源运行状态回写（真实采集后调用；失败如实记录） */
export function markCeaSourceRun(code, { ok, error = null, itemsOk = 0, itemsFailed = 0 } = {}) {
  const now = nowIso();
  const s = get('SELECT id FROM cea_source WHERE code=?', [code]);
  if (!s) return { ok: false, reason: 'unknown_source_code' };
  run(
    `UPDATE cea_source SET last_attempt_at=?, last_status=?,
       last_success_at=CASE WHEN ?=1 THEN ? ELSE last_success_at END,
       last_error=?, items_ok=items_ok+?, items_failed=items_failed+?, updated_at=? WHERE id=?`,
    [now, ok ? 'ok' : 'failed', ok ? 1 : 0, now, ok ? null : String(error || '采集失败').slice(0, 800), itemsOk, itemsFailed, now, s.id]
  );
  return { ok: true, id: s.id };
}

export function listCeaSources({ dataset = null, enabled = null } = {}) {
  const where = [];
  const params = [];
  if (dataset) { where.push('dataset=?'); params.push(dataset); }
  if (enabled !== null) { where.push('enabled=?'); params.push(enabled ? 1 : 0); }
  return all(
    `SELECT * FROM cea_source ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY priority, code`,
    params
  ).map((r) => ({ ...r, allowed_domains: uj(r.allowed_domains, []), enabled: !!r.enabled }));
}

export function getCeaSourceByCode(code) {
  const r = get('SELECT * FROM cea_source WHERE code=?', [code]);
  return r
    ? { ...r, allowed_domains: uj(r.allowed_domains, []), body_template: uj(r.body_template, null), method: r.method || 'GET' }
    : null;
}

/**
 * 基础数据种子：只写**已由官方公开文件确认的元数据**与来源登记。
 * 不写任何行情数值、名录行或意向行——那些只能来自真实采集。
 * 已存在的行不会被覆盖正文（body_snapshot）与核验状态。
 */
export function seedCeaBaseData({ actor = 'system:cea-seed' } = {}) {
  const src = ensureCeaSources({ actor });
  const now = nowIso();
  let docsCreated = 0;
  let docsKept = 0;
  let eventsCreated = 0;
  let eventsKept = 0;

  for (const d of CEA_DOCUMENTS) {
    const ex = get('SELECT id, body_snapshot FROM cea_document WHERE doc_key=?', [d.doc_key]);
    const source = get('SELECT id FROM cea_source WHERE code=?', [d.source_code]);
    if (ex) {
      // 已存在：只补配对覆盖 / 附件关联等新增元数据，绝不覆盖已抓取的正文与核验状态
      const parent = d.attachment_of_doc_key
        ? get('SELECT id FROM cea_document WHERE doc_key=?', [d.attachment_of_doc_key])
        : null;
      run(
        `UPDATE cea_document SET coverage_json=COALESCE(coverage_json,?), coverage_source=COALESCE(coverage_source,?),
           attachment_of=COALESCE(attachment_of,?), count_in_stats=?, updated_at=? WHERE id=?`,
        [
          d.coverage ? j(d.coverage) : null, d.coverage_source || null, parent?.id || null,
          // 附件行不计入政策计数；主行保持计入
          d.attachment_of_doc_key ? 0 : 1,
          now, ex.id,
        ]
      );
      docsKept += 1;
      continue;
    }
    // 先建主行，再建附件行（附件需要主行 id）
    const id = newId('CEADOC');
    const parent = d.attachment_of_doc_key
      ? get('SELECT id FROM cea_document WHERE doc_key=?', [d.attachment_of_doc_key])
      : null;
    run(
      `INSERT INTO cea_document
       (id,doc_key,doc_type,category,title,doc_number,issuer,publish_date,effective_date,covered_sectors,
        applicable_years,doc_status,version,official_url,source_id,source_code,evidence_level,ai_status,
        coverage_json,coverage_source,attachment_of,count_in_stats,provenance_note,note,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'metadata_only','unverified',?,?,?,?,?,?,?,?)`,
      [
        id, d.doc_key, d.doc_type, d.category || null, d.title, d.doc_number || null,
        d.issuer || null, d.publish_date || null, d.effective_date || null,
        d.covered_sectors ? j(d.covered_sectors) : null,
        d.applicable_years ? j(d.applicable_years) : null,
        d.doc_status || 'formal', d.version || null, d.official_url || null,
        source?.id || null, d.source_code || null,
        d.coverage ? j(d.coverage) : null, d.coverage_source || null,
        parent?.id || null,
        // 附件行不计入政策计数，避免同一份通知被统计两次
        d.attachment_of_doc_key ? 0 : 1,
        d.provenance_note || null, d.note || null, now, now,
      ]
    );
    docsCreated += 1;
  }

  for (const e of CEA_EVENTS) {
    const ex = get('SELECT id FROM cea_event WHERE event_key=?', [e.event_key]);
    if (ex) { eventsKept += 1; continue; }
    const doc = e.source_doc_key ? get('SELECT id FROM cea_document WHERE doc_key=?', [e.source_doc_key]) : null;
    run(
      `INSERT INTO cea_event
       (id,event_key,event_type,title,deadline,emission_year,quota_year,list_year,industry,
        source_document_id,source_url,source_quote,date_extract_status,date_verify_status,note,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'unverified',?,?,?)`,
      [
        newId('CEAEVT'), e.event_key, e.event_type, e.title, e.deadline || null,
        e.emission_year ?? null, e.quota_year ?? null, e.list_year ?? null, e.industry || null,
        doc?.id || null, e.source_url || null, e.source_quote || null,
        e.date_extract_status || 'extracted', e.note || null, now, now,
      ]
    );
    eventsCreated += 1;
  }

  audit({
    actor, action: 'cea.seed_base_data', objectType: 'cea_source',
    detail: { ...src, docsCreated, docsKept, eventsCreated, eventsKept },
  });
  return { sources: src, docs_created: docsCreated, docs_kept: docsKept, events_created: eventsCreated, events_kept: eventsKept };
}

/* ==================================================================== */
/*  二、日行情入库（幂等 + 修订留痕）                                    */
/* ==================================================================== */

/** 会被比对与留痕的官方字段 */
const TRACKED_FIELDS = [
  'open', 'high', 'low', 'close', 'change_pct', 'prev_close',
  'listed_volume', 'listed_turnover', 'block_volume', 'block_turnover',
  'auction_volume', 'auction_turnover',
  'total_volume', 'total_turnover', 'year_volume', 'year_turnover',
  'lifetime_volume', 'lifetime_turnover',
];

function eqNum(a, b) {
  const na = a === null || a === undefined || a === '' ? null : Number(a);
  const nb = b === null || b === undefined || b === '' ? null : Number(b);
  if (na === null && nb === null) return true;
  if (na === null || nb === null) return false;
  return Math.abs(na - nb) <= 1e-9;
}

export function saveCeaChecks(objectType, objectId, checks) {
  const now = nowIso();
  for (const c of checks || []) {
    run(
      `INSERT INTO cea_check (id,object_type,object_id,check_key,label,ok,severity,detail,expected,actual,checked_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(object_type,object_id,check_key) DO UPDATE SET
         label=excluded.label, ok=excluded.ok, severity=excluded.severity, detail=excluded.detail,
         expected=excluded.expected, actual=excluded.actual, checked_at=excluded.checked_at`,
      [
        newId('CEACHK'), objectType, objectId, c.check_key, c.label || null, c.ok ? 1 : 0,
        c.severity || 'warn', c.detail || null, c.expected === null || c.expected === undefined ? null : String(c.expected),
        c.actual === null || c.actual === undefined ? null : String(c.actual), now,
      ]
    );
  }
}

export function listCeaChecks({ object_type = null, object_id = null, only_failed = false, limit = 200 } = {}) {
  const where = [];
  const params = [];
  if (object_type) { where.push('object_type=?'); params.push(object_type); }
  if (object_id) { where.push('object_id=?'); params.push(object_id); }
  if (only_failed) where.push('ok=0');
  return all(
    `SELECT * FROM cea_check ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY checked_at DESC, check_key LIMIT ?`,
    [...params, Math.min(Number(limit) || 200, 1000)]
  ).map((r) => ({ ...r, ok: !!r.ok }));
}

/**
 * 写入/更新一条 CEA 日行情。
 *
 * 幂等规则（CEA-06）：
 *   - 同 (trade_date, instrument, market_scope, price_regime) 且 content_hash 相同 →
 *     不重复写数值，只刷新 fetched_at / last snapshot；
 *   - 同键但内容哈希不同 → 逐字段比对官方值，差异写入 cea_trade_revision 并 revision+1；
 *   - 任何情况下都**不**用解析或模型推导值覆盖官方值。
 *
 * @param {object} p
 * @param {string} p.trade_date
 * @param {object} p.fields 解析得到的官方字段（null 表示未披露）
 * @param {object} p.parse   parseCeaDailyReport 的返回值（用于 raw_fields/units/status）
 * @param {{sourceCode?:string,sourceUrl:string,snapshotId?:string,contentHash?:string,fetchedAt?:string,actor?:string,note?:string}} p.meta
 */
export function upsertCeaTradeDaily(p = {}) {
  const { trade_date: tradeDate, fields = {}, parse = {}, meta = {} } = p;
  if (!isDate(tradeDate)) return { error: 'trade_date 非法（必须是 YYYY-MM-DD，不能用采集日兜底）', status: 400 };
  const instrument = meta.instrument || CEA_INSTRUMENT;
  const marketScope = meta.marketScope || CEA_MARKET_SCOPE;
  const priceRegime = meta.priceRegime || CEA_PRICE_REGIME_2026;
  const sourceUrl = String(meta.sourceUrl || '').trim();
  if (!sourceUrl) return { error: '缺少来源 URL：CEA 行情必须可回溯到官方原文', status: 400 };

  const dv = deriveDaily(fields);
  const row = {
    ...fields,
    computed_avg_price: dv.computed_avg_price,
    sum_volume: dv.sum_volume,
    sum_turnover: dv.sum_turnover,
    session_state: dv.session_state,
  };

  const now = nowIso();
  const source = meta.sourceCode ? get('SELECT id FROM cea_source WHERE code=?', [meta.sourceCode]) : null;

  return tx(() => {
    const ex = get(
      `SELECT * FROM cea_trade_daily WHERE trade_date=? AND instrument=? AND market_scope=? AND price_regime=?`,
      [tradeDate, instrument, marketScope, priceRegime]
    );

    if (ex && meta.contentHash && ex.content_hash && ex.content_hash === meta.contentHash) {
      // 同 URL 同哈希重采：幂等，不改数值、不增 revision
      run('UPDATE cea_trade_daily SET fetched_at=?, updated_at=? WHERE id=?', [meta.fetchedAt || now, now, ex.id]);
      return { ok: true, id: ex.id, unchanged: true, deduped: true, revision: ex.revision, reason: 'same_content_hash' };
    }

    if (!ex) {
      const id = newId('CEATD');
      run(
        `INSERT INTO cea_trade_daily
         (id,trade_date,instrument,market_scope,price_regime,
          open,high,low,close,change_pct,prev_close,
          listed_volume,listed_turnover,block_volume,block_turnover,auction_volume,auction_turnover,
          total_volume,total_turnover,year_volume,year_turnover,lifetime_volume,lifetime_turnover,
          computed_avg_price,sum_volume,sum_turnover,
          source_url,source_id,source_code,snapshot_id,content_hash,fetched_at,published_at,data_as_of,
          parse_status,parse_note,check_status,verification_status,session_state,revision,
          units_json,raw_fields_json,note,created_at,updated_at)
         VALUES (?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?, ?,?,?,?,?,?,?,?, ?,?,?,?,?,?,
                 ?,?,?,?,?)`,
        [
          id, tradeDate, instrument, marketScope, priceRegime,
          nn(row.open), nn(row.high), nn(row.low), nn(row.close), nn(row.change_pct), nn(row.prev_close),
          nn(row.listed_volume), nn(row.listed_turnover), nn(row.block_volume), nn(row.block_turnover),
          nn(row.auction_volume), nn(row.auction_turnover),
          nn(row.total_volume), nn(row.total_turnover), nn(row.year_volume), nn(row.year_turnover),
          nn(row.lifetime_volume), nn(row.lifetime_turnover),
          nn(row.computed_avg_price), nn(row.sum_volume), nn(row.sum_turnover),
          sourceUrl, source?.id || null, meta.sourceCode || null, meta.snapshotId || null,
          meta.contentHash || null, meta.fetchedAt || now, meta.publishedAt || null, meta.dataAsOf || tradeDate,
          parse.parse_status || 'pending', parse.parse_note || null, 'pending', 'unverified', row.session_state, 1,
          parse.units ? j(parse.units) : null, parse.raw_fields ? j(parse.raw_fields) : null,
          meta.note || null, now, now,
        ]
      );
      const checks = runDailyChecks(row, { rangeComplete: meta.rangeComplete, dateInfo: parse.date_candidates ? { candidates: parse.date_candidates, consistent: parse.date_consistent, source: parse.date_source } : null, prevRow: ex });
      saveCeaChecks('cea_trade_daily', id, checks.checks);
      run('UPDATE cea_trade_daily SET check_status=? WHERE id=?', [checks.status, id]);
      return { ok: true, id, created: true, revision: 1, check_status: checks.status, checks: checks.checks };
    }

    // 已存在：逐字段比对，差异留痕，不静默覆盖
    const changed = [];
    for (const f of TRACKED_FIELDS) {
      if (!eqNum(ex[f], row[f])) changed.push({ field: f, old: ex[f], next: nn(row[f]) });
    }
    if (!changed.length) {
      run('UPDATE cea_trade_daily SET fetched_at=?, updated_at=?, parse_status=?, parse_note=? WHERE id=?', [
        meta.fetchedAt || now, now, parse.parse_status || ex.parse_status, parse.parse_note || ex.parse_note, ex.id,
      ]);
      return { ok: true, id: ex.id, unchanged: true, revision: ex.revision, reason: 'values_identical' };
    }

    const nextRevision = Number(ex.revision || 1) + 1;
    for (const c of changed) {
      run(
        `INSERT INTO cea_trade_revision (id,trade_daily_id,revised_at,revised_by,field,old_value,new_value,reason,official_ref,snapshot_id)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [
          newId('CEAREV'), ex.id, now, meta.actor || 'system:cea-collect', c.field,
          c.old === null || c.old === undefined ? null : String(c.old),
          c.next === null ? null : String(c.next),
          meta.revisionReason || '本次采集得到的官方数值与已有记录不同（官方修订或解析差异），旧值保留可审计；不改写为模型推测值',
          sourceUrl, meta.snapshotId || null,
        ]
      );
    }
    run(
      `UPDATE cea_trade_daily SET
         open=?,high=?,low=?,close=?,change_pct=?,prev_close=?,
         listed_volume=?,listed_turnover=?,block_volume=?,block_turnover=?,auction_volume=?,auction_turnover=?,
         total_volume=?,total_turnover=?,year_volume=?,year_turnover=?,lifetime_volume=?,lifetime_turnover=?,
         computed_avg_price=?,sum_volume=?,sum_turnover=?,
         source_url=?,source_id=?,source_code=?,snapshot_id=?,content_hash=?,fetched_at=?,published_at=?,data_as_of=?,
         parse_status=?,parse_note=?,verification_status='unverified',verification_note=NULL,revision=?,
         units_json=?,raw_fields_json=?,session_state=?,updated_at=?
       WHERE id=?`,
      [
        nn(row.open), nn(row.high), nn(row.low), nn(row.close), nn(row.change_pct), nn(row.prev_close),
        nn(row.listed_volume), nn(row.listed_turnover), nn(row.block_volume), nn(row.block_turnover),
        nn(row.auction_volume), nn(row.auction_turnover),
        nn(row.total_volume), nn(row.total_turnover), nn(row.year_volume), nn(row.year_turnover),
        nn(row.lifetime_volume), nn(row.lifetime_turnover),
        nn(row.computed_avg_price), nn(row.sum_volume), nn(row.sum_turnover),
        sourceUrl, source?.id || null, meta.sourceCode || null, meta.snapshotId || null,
        meta.contentHash || null, meta.fetchedAt || now, meta.publishedAt || null, meta.dataAsOf || tradeDate,
        parse.parse_status || 'ok', parse.parse_note || null, nextRevision,
        parse.units ? j(parse.units) : ex.units_json, parse.raw_fields ? j(parse.raw_fields) : ex.raw_fields_json,
        row.session_state, now, ex.id,
      ]
    );
    const checks = runDailyChecks(row, { prevRow: ex, rangeComplete: meta.rangeComplete, dateInfo: parse.date_candidates ? { candidates: parse.date_candidates, consistent: parse.date_consistent, source: parse.date_source } : null });
    saveCeaChecks('cea_trade_daily', ex.id, checks.checks);
    run('UPDATE cea_trade_daily SET check_status=? WHERE id=?', [checks.status, ex.id]);
    return { ok: true, id: ex.id, revised: true, revision: nextRevision, changed, check_status: checks.status, checks: checks.checks };
  });
}

function nn(v) {
  const n = Number(v);
  return v === null || v === undefined || v === '' || !Number.isFinite(n) ? null : n;
}

export function listCeaTradeRevisions({ trade_daily_id = null, limit = 200 } = {}) {
  const where = trade_daily_id ? 'WHERE trade_daily_id=?' : '';
  return all(
    `SELECT * FROM cea_trade_revision ${where} ORDER BY revised_at DESC LIMIT ?`,
    trade_daily_id ? [trade_daily_id, Math.min(Number(limit) || 200, 1000)] : [Math.min(Number(limit) || 200, 1000)]
  );
}

/* ==================================================================== */
/*  三、行情查询                                                        */
/* ==================================================================== */

function mapTradeRow(r) {
  if (!r) return null;
  return {
    ...r,
    units: uj(r.units_json, {}),
    raw_fields: uj(r.raw_fields_json, {}),
    // 明确口径，避免前端把两个价格混用
    price_caliber: {
      close: '官方综合行情收盘价（2026 版为 CEA25 权重 1 的指定权重指数）',
      computed_avg_price: '全方式量加权均价 = 总成交额 / 总成交量（程序计算）',
    },
  };
}

export function getCeaTradeDaily(id) {
  return mapTradeRow(get('SELECT * FROM cea_trade_daily WHERE id=?', [id]));
}

export function listCeaTradeDaily(f = {}) {
  const where = [];
  const params = [];
  if (f.from) { where.push('trade_date>=?'); params.push(f.from); }
  if (f.to) { where.push('trade_date<=?'); params.push(f.to); }
  if (f.instrument) { where.push('instrument=?'); params.push(f.instrument); }
  if (f.price_regime) { where.push('price_regime=?'); params.push(f.price_regime); }
  if (f.check_status) { where.push('check_status=?'); params.push(f.check_status); }
  if (f.verification_status) { where.push('verification_status=?'); params.push(f.verification_status); }
  const limit = Math.min(Number(f.limit) || 200, 2000);
  const offset = Math.max(Number(f.offset) || 0, 0);
  const total = get(
    `SELECT COUNT(*) AS c FROM cea_trade_daily ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`,
    params
  )?.c || 0;
  const rows = all(
    `SELECT * FROM cea_trade_daily ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY trade_date DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  ).map(mapTradeRow);
  return { total, limit, offset, rows, data_as_of: rows[0]?.trade_date || null };
}

/** 区间汇总：只在真实有数据的交易日上计算，不补缺失日 */
export function ceaSummary({ from = null, to = null } = {}) {
  const where = [];
  const params = [];
  if (from) { where.push('trade_date>=?'); params.push(from); }
  if (to) { where.push('trade_date<=?'); params.push(to); }
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const agg = get(
    `SELECT COUNT(*) AS days,
            MIN(trade_date) AS first_date, MAX(trade_date) AS last_date,
            SUM(total_volume) AS volume, SUM(total_turnover) AS turnover,
            AVG(CASE WHEN price_regime='CEA_COMPOSITE_2026' THEN close END) AS avg_close,
            MIN(CASE WHEN price_regime='CEA_COMPOSITE_2026' THEN close END) AS min_close,
            MAX(CASE WHEN price_regime='CEA_COMPOSITE_2026' THEN close END) AS max_close,
            MAX(lifetime_volume) AS lifetime_volume, MAX(lifetime_turnover) AS lifetime_turnover,
            MAX(year_volume) AS year_volume, MAX(year_turnover) AS year_turnover,
            COUNT(DISTINCT price_regime) AS price_regime_count
     FROM cea_trade_daily ${clause}`,
    params
  );
  const noTradeDays = get(
    `SELECT COUNT(*) AS c FROM cea_trade_daily ${clause ? clause + ' AND ' : 'WHERE '} session_state='no_trade'`,
    params
  )?.c || 0;
  const volRaw = agg?.volume;
  const turnRaw = agg?.turnover;
  const vol = volRaw === null || volRaw === undefined ? null : Number(volRaw);
  const turn = turnRaw === null || turnRaw === undefined ? null : Number(turnRaw);
  const mixedRegimes = Number(agg?.price_regime_count || 0) > 1;
  return {
    from: from || agg?.first_date || null,
    to: to || agg?.last_date || null,
    trading_days: Number(agg?.days || 0),
    no_trade_days: Number(noTradeDays),
    // 只有实际披露过分项合计时才给区间值；全部未披露保持 null，不把未知压成 0。
    total_volume: vol === null ? null : round(vol, 6),          // 吨
    total_turnover: turn === null ? null : round(turn, 6),      // 元
    // 区间量加权均价：区间内无成交/未知量额则为 null，不是 0
    vwap: vol !== null && vol > 0 && turn !== null ? round(turn / vol, 6) : null,
    // 跨价格编制口径不得简单平均成一个“官方综合收盘价均值”。
    avg_composite_close: mixedRegimes || agg?.avg_close === null || agg?.avg_close === undefined ? null : round(agg.avg_close, 6),
    min_close: mixedRegimes ? null : (agg?.min_close ?? null),
    max_close: mixedRegimes ? null : (agg?.max_close ?? null),
    price_regimes: Number(agg?.price_regime_count || 0),
    latest_lifetime_volume: agg?.lifetime_volume ?? null,
    latest_lifetime_turnover: agg?.lifetime_turnover ?? null,
    latest_year_volume: agg?.year_volume ?? null,
    latest_year_turnover: agg?.year_turnover ?? null,
    caliber_note:
      '区间加权均价 = 区间总成交额 / 区间总成交量（程序计算）；avg_composite_close 是官方综合收盘价的简单平均。' +
      '两者口径不同，不得互相替代（CEA-05）。缺失交易日不补 0、不前填。',
  };
}

/** 序列（展示用）：按日或按月聚合；缺失日不产生 0 值行 */
export function ceaSeries({ from = null, to = null, granularity = 'day' } = {}) {
  const rows = listCeaTradeDaily({ from, to, limit: 2000 }).rows.slice().reverse();
  if (granularity === 'month') {
    const map = new Map();
    for (const r of rows) {
      const k = r.trade_date.slice(0, 7);
      if (!map.has(k)) map.set(k, { period: k, days: 0, volume: 0, turnover: 0, closes: [], has_volume: false });
      const b = map.get(k);
      b.days += 1;
      if (Number.isFinite(r.total_volume)) { b.volume += r.total_volume; b.has_volume = true; }
      if (Number.isFinite(r.total_turnover)) b.turnover += r.total_turnover;
      if (Number.isFinite(r.close)) b.closes.push(r.close);
    }
    return {
      granularity: 'month',
      points: [...map.values()].map((b) => ({
        period: b.period,
        trading_days: b.days,
        total_volume: b.has_volume ? round(b.volume, 6) : null,
        total_turnover: b.has_volume ? round(b.turnover, 6) : null,
        vwap: b.has_volume && b.volume > 0 ? round(b.turnover / b.volume, 6) : null,
        avg_composite_close: b.closes.length ? round(b.closes.reduce((a, c) => a + c, 0) / b.closes.length, 6) : null,
      })),
      note: '按月聚合只使用实际采集到的交易日；没有数据的月份不生成 0 值点。',
    };
  }
  return {
    granularity: 'day',
    points: rows.map((r) => ({
      trade_date: r.trade_date,
      instrument: r.instrument,
      price_regime: r.price_regime,
      open: r.open, high: r.high, low: r.low, close: r.close, change_pct: r.change_pct,
      composite_close: r.close,
      computed_avg_price: r.computed_avg_price,
      total_volume: r.total_volume,
      total_turnover: r.total_turnover,
      listed_volume: r.listed_volume, listed_turnover: r.listed_turnover,
      block_volume: r.block_volume, block_turnover: r.block_turnover,
      auction_volume: r.auction_volume, auction_turnover: r.auction_turnover,
      session_state: r.session_state,
      check_status: r.check_status,
      verification_status: r.verification_status,
      source_url: r.source_url,
      fetched_at: r.fetched_at,
    })),
    note: '仅包含实际采集到的交易日；缺失日不在序列中生成 0 或前填值。',
  };
}

/**
 * CEA / CCER 同日价格对比。
 * 规则（CEA-05）：只在**同日两侧都有数据**时给出对比点；任一侧缺失 → 该侧为 null，
 * 不沿用前值、不填 0。CEA 综合收盘价、CEA 全方式计算均价、CCER 计算均价是三个字段。
 */
export function ceaComparison({ from = null, to = null, limit = 180 } = {}) {
  const where = [];
  const params = [];
  if (from) { where.push('trade_date>=?'); params.push(from); }
  if (to) { where.push('trade_date<=?'); params.push(to); }
  const rows = all(
    `SELECT * FROM cea_ccer_same_day ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY trade_date DESC LIMIT ?`,
    [...params, Math.min(Number(limit) || 180, 2000)]
  );
  return {
    points: rows.map((r) => {
      const ceaClose = r.cea_composite_close ?? null;
      const ccerAvg = r.ccer_computed_avg_price ?? null;
      return {
        trade_date: r.trade_date,
        cea_composite_close: ceaClose,
        cea_computed_avg_price: r.cea_computed_avg_price ?? null,
        ccer_computed_avg_price: ccerAvg,
        cea_volume: r.cea_volume ?? null,
        ccer_volume: r.ccer_volume ?? null,
        // 价差只在两侧同日都有报价时给出；其余为 null
        spread_close_minus_ccer: Number.isFinite(ceaClose) && Number.isFinite(ccerAvg) ? round(ceaClose - ccerAvg, 6) : null,
        cea_price_regime: r.cea_price_regime ?? null,
        same_day_complete: Number.isFinite(ceaClose) && Number.isFinite(ccerAvg),
      };
    }),
    caliber_note:
      '默认仅同日连接：任一品种缺当日数据时该点为 null，不沿用前值冒充同日交易，也不填 0。' +
      'CEA 综合收盘价（官方指定权重指数）、CEA 全方式计算均价、CCER 计算均价是三个不同字段，不得混用图例。' +
      '价差只是两个市场报价的比较，不代表确定套利收益，也不等于真实成交结果。',
  };
}

/* ==================================================================== */
/*  三·B、概览层 / 日历证据 / 行情来源层级                              */
/* ==================================================================== */

/**
 * 写入 dailyov 概览层。**绝不覆盖** cea_trade_daily 的精确值：
 * 概览只回答「官方展示成多少」，精确成交仍以 querySubStat 的 COMCEA 聚合为准。
 * 同时做交叉核对：差异超过舍入容差才提示，不修改任何一侧。
 */
export function upsertCeaOverview(row, { sourceCode = 'cea_json_dailyov', sourceUrl, snapshotId = null, contentHash = null, fetchedAt = null } = {}) {
  if (!isDate(row?.trade_date)) return { error: '概览缺少合法 trade_date', status: 400 };
  const now = nowIso();
  const approx = (v) => (v && Number.isFinite(v.value) ? v.value : null);
  const text = (v) => (v && v.text ? v.text : null);

  // 交叉核对：与同交易日精确值比较（概览舍入到 0.01 万吨 / 0.01 亿元）
  const precise = get(
    'SELECT total_volume, total_turnover, lifetime_volume, lifetime_turnover, open, high, low, close FROM cea_trade_daily WHERE trade_date=? ORDER BY revision DESC LIMIT 1',
    [row.trade_date]
  );
  const checks = [];
  const cmp = (label, ovField, preciseValue) => {
    const ovValue = approx(ovField);
    if (ovValue === null || preciseValue === null || preciseValue === undefined) return;
    // 容差由**展示精度**决定（0.5 个最后显示单位），而不是写死的常数
    const tol = Number.isFinite(ovField?.tolerance) && ovField.tolerance > 0 ? ovField.tolerance : 1;
    const diff = Math.abs(Number(ovValue) - Number(preciseValue));
    checks.push({
      field: label,
      overview_text: text(ovField),
      overview_approx: ovValue,
      precise: Number(preciseValue),
      diff,
      tolerance: tol,
      within_rounding: diff <= tol,
      note: diff <= tol
        ? `差异 ${diff} ≤ 展示舍入容差 ${tol}（「${text(ovField)}」的最后一位代表 ${tol * 2}），两层数值一致`
        : `差异 ${diff} 超出展示舍入容差 ${tol}：概览「${text(ovField)}」与精确值 ${preciseValue} 不一致，需核对来源（不覆盖任何一侧）`,
    });
  };
  if (precise) {
    cmp('total_volume', row.rounded?.today_qty, precise.total_volume);
    cmp('total_turnover', row.rounded?.today_amt, precise.total_turnover);
    cmp('lifetime_volume', row.rounded?.lifetime_qty, precise.lifetime_volume);
    cmp('lifetime_turnover', row.rounded?.lifetime_amt, precise.lifetime_turnover);
    for (const f of ['open', 'high', 'low', 'close']) {
      if (Number.isFinite(row[f]) && precise[f] !== null && Math.abs(Number(row[f]) - Number(precise[f])) > 1e-9) {
        checks.push({
          field: f, overview_text: String(row[f]), overview_approx: row[f], precise: Number(precise[f]),
          diff: Math.abs(Number(row[f]) - Number(precise[f])), within_rounding: false,
          note: `概览与日报的 ${f} 不一致：概览 ${row[f]}、日报 ${precise[f]}；两套来源都保留，由确定性核对提示复核`,
        });
      }
    }
  }

  const vals = [
    row.trade_date, row.open ?? null, row.high ?? null, row.low ?? null, row.close ?? null,
    row.prev_close ?? null, row.before_close ?? null, row.change_pct ?? null,
    text(row.rounded?.today_qty), approx(row.rounded?.today_qty),
    text(row.rounded?.today_amt), approx(row.rounded?.today_amt),
    text(row.rounded?.lifetime_qty), approx(row.rounded?.lifetime_qty),
    text(row.rounded?.lifetime_amt), approx(row.rounded?.lifetime_amt),
    sourceUrl || null, sourceCode, snapshotId, contentHash, fetchedAt || now,
    checks.length ? j(checks) : null,
    row.rounded?.note || null, now, now,
  ];
  const ex = get('SELECT id FROM cea_daily_overview WHERE trade_date=? AND source_code=?', [row.trade_date, sourceCode]);
  if (ex) {
    // v2.3 修复：旧实现用 `vals.slice(1, vals.length - 3)` 直接喂 UPDATE，但 UPDATE 少一列
    // （不写 source_code / trade_date / created_at），导致参数整体错位：
    //   snapshot_id ← sourceCode、content_hash ← snapshotId、fetched_at ← contentHash（把 sha256 当抓取时间）、
    //   cross_check_json ← fetchedAt、note ← 核对 JSON（原始 JSON 调试内容泄漏到界面）。
    // 这里改为按列显式取值，杜绝位置偏移。
    const [
      , ovOpen, ovHigh, ovLow, ovClose, ovPrevClose, ovBeforeClose, ovChangePct,
      ovTodayQtyText, ovTodayQtyApprox, ovTodayAmtText, ovTodayAmtApprox,
      ovTotalQtyText, ovTotalQtyApprox, ovTotalAmtText, ovTotalAmtApprox,
      ovSourceUrl, , ovSnapshotId, ovContentHash, ovFetchedAt, ovChecks, ovNote,
    ] = vals;
    run(
      `UPDATE cea_daily_overview SET open=?,high=?,low=?,close=?,prev_close=?,before_close=?,change_pct=?,
         today_qty_text=?,today_qty_approx=?,today_amt_text=?,today_amt_approx=?,
         total_qty_text=?,total_qty_approx=?,total_amt_text=?,total_amt_approx=?,
         source_url=?,snapshot_id=?,content_hash=?,fetched_at=?,cross_check_json=?,note=?,updated_at=? WHERE id=?`,
      [
        ovOpen, ovHigh, ovLow, ovClose, ovPrevClose, ovBeforeClose, ovChangePct,
        ovTodayQtyText, ovTodayQtyApprox, ovTodayAmtText, ovTodayAmtApprox,
        ovTotalQtyText, ovTotalQtyApprox, ovTotalAmtText, ovTotalAmtApprox,
        ovSourceUrl, ovSnapshotId, ovContentHash, ovFetchedAt, ovChecks, ovNote, now, ex.id,
      ]
    );
    return { ok: true, id: ex.id, updated: true, cross_checks: checks };
  }
  const id = newId('CEAOV');
  run(
    `INSERT INTO cea_daily_overview
     (id,trade_date,open,high,low,close,prev_close,before_close,change_pct,
      today_qty_text,today_qty_approx,today_amt_text,today_amt_approx,
      total_qty_text,total_qty_approx,total_amt_text,total_amt_approx,
      source_url,source_code,snapshot_id,content_hash,fetched_at,cross_check_json,note,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, ...vals]
  );
  return { ok: true, id, created: true, cross_checks: checks };
}

export function getCeaOverviewRow(tradeDate) {
  const r = get('SELECT * FROM cea_daily_overview WHERE trade_date=? ORDER BY fetched_at DESC LIMIT 1', [tradeDate]);
  return r ? { ...r, cross_checks: uj(r.cross_check_json, []) } : null;
}

/**
 * 写入官方休市日历证据（CEA 独立于 CCER 日历）。
 *
 * v2.3 来源修订纪律（docs/35「17:00 之后的独立故障注入追加」）：
 *   - `complete=true` 表示这是一次**成功且完整**的来源快照（响应成功、数组可解析、无非法日期、非空）。
 *     此时同步「当前有效集合」：本次列表内的日期保持/恢复为 current；同一 evidence_kind 中
 *     不在本次列表的旧日期标记为 `superseded`——**保留行、note、snapshot 原样可追溯**，
 *     只改状态，供 `listCeaCalendar` / `reconcileCeaCalendar` / 统计排除。
 *   - `complete=false`（失败 / 不完整结果）**绝不清空**或改动当前集合，只做增量 upsert。
 */
export function upsertCeaCalendarDates(dates = [], {
  evidenceKind = 'holidays_json', sourceCode = 'cea_json_holidays', evidenceUrl = null,
  snapshotId = null, note = null, complete = false, supersededReason = null,
} = {}) {
  const now = nowIso();
  const list = [...new Set((Array.isArray(dates) ? dates : []).filter((d) => isDate(d)))].sort();
  let created = 0;
  let updated = 0;
  let keptSuperseded = 0;
  for (const d of list) {
    const ex = get('SELECT trade_date,source_state FROM cea_calendar WHERE trade_date=? AND evidence_kind=?', [d, evidenceKind]);
    if (ex && ex.source_state !== 'current' && !complete) {
      // 不完整 / 失败的来源结果不得改写、也不得据此复活已过期证据：整行原样保留（含原 note 与快照）
      keptSuperseded += 1;
      continue;
    }
    if (ex) {
      run('UPDATE cea_calendar SET snapshot_id=COALESCE(?,snapshot_id), note=COALESCE(?,note), updated_at=? WHERE trade_date=? AND evidence_kind=?',
        [snapshotId, note, now, d, evidenceKind]);
      updated += 1;
    } else {
      run(
        `INSERT INTO cea_calendar (trade_date,day_type,evidence_kind,evidence_url,source_code,snapshot_id,note,source_state,created_at,updated_at)
         VALUES (?, 'holiday', ?,?,?,?,?, 'current', ?,?)`,
        [d, evidenceKind, evidenceUrl, sourceCode, snapshotId, note || '官方公布的日行情查询页休市日期（非周末）', now, now]
      );
      created += 1;
    }
  }
  let superseded = 0;
  let restored = 0;
  const placeholders = list.map(() => '?').join(',');
  if (complete) {
    // ① 本次快照内仍存在的日期：恢复为当前有效（来源把已删日期改回来时同样适用）
    if (list.length) {
      const r = run(
        `UPDATE cea_calendar SET source_state='current', superseded_at=NULL, superseded_by_snapshot=NULL,
           superseded_reason=NULL, updated_at=?
         WHERE evidence_kind=? AND trade_date IN (${placeholders}) AND source_state<>'current'`,
        [now, evidenceKind, ...list]
      );
      restored = Number(r?.changes || 0);
    }
    // ② 来源已删除的旧日期：不删除证据行，只标为过期（不再作为当前事实 / 告警依据）
    const r2 = run(
      `UPDATE cea_calendar SET source_state='superseded', superseded_at=?, superseded_by_snapshot=?,
         superseded_reason=?, updated_at=?
       WHERE evidence_kind=? AND source_state='current'${list.length ? ` AND trade_date NOT IN (${placeholders})` : ''}`,
      [
        now, snapshotId,
        supersededReason ||
          `来源完整快照（${snapshotId || '快照未记录'}）已不包含该日期：历史证据保留可追溯，但不再作为当前有效集合或告警依据`,
        now, evidenceKind, ...list,
      ]
    );
    superseded = Number(r2?.changes || 0);
  }
  const currentTotal = get(
    "SELECT COUNT(*) AS c FROM cea_calendar WHERE evidence_kind=? AND source_state='current'",
    [evidenceKind]
  )?.c || 0;
  return {
    created, updated, total: list.length, complete: !!complete, superseded, restored, kept_superseded: keptSuperseded,
    current_total: currentTotal,
  };
}

export function listCeaCalendar({ from = null, to = null, day_type = null, include_superseded = false } = {}) {
  const where = [];
  const params = [];
  if (from) { where.push('trade_date>=?'); params.push(from); }
  if (to) { where.push('trade_date<=?'); params.push(to); }
  if (day_type) { where.push('day_type=?'); params.push(day_type); }
  // 来源修订后，「当前事实」只认 current；历史证据（superseded）仅在显式要求时一并返回以便追溯
  if (!include_superseded) where.push("source_state='current'");
  return all(
    `SELECT * FROM cea_calendar ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY trade_date LIMIT 2000`,
    params
  );
}

/**
 * 写入**正式全年休市公告**解析结果（沪环境交〔2025〕44号一类文件）。
 * 证据层级 `official_notice`，与查询页使用的机器辅助列表 `holidays_json` 分开保存、互不覆盖。
 */
export function applyCeaAnnualClosureNotice(parsed, {
  sourceCode = 'cea_annual_closures_2026', evidenceUrl = null, snapshotId = null, documentId = null, actor = 'system:cea-collect',
} = {}) {
  if (!parsed?.ok) return { error: parsed?.reason || '公告解析失败', status: 400 };
  const now = nowIso();
  const note = `正式全年休市公告${parsed.doc_number ? `（${parsed.doc_number}）` : ''}：` +
    `休市 ${parsed.ranges.map((r) => `${r.from}~${r.to}`).join('、')}；` +
    `原文明确开市日 ${parsed.reopen_dates.join('、') || '（未列出）'}。范围只来自公告原文，不按节假日名称推测。`;
  let created = 0;
  let updated = 0;
  for (const d of parsed.closed_dates) {
    const ex = get("SELECT trade_date FROM cea_calendar WHERE trade_date=? AND evidence_kind='official_notice'", [d]);
    if (ex) {
      run("UPDATE cea_calendar SET snapshot_id=COALESCE(?,snapshot_id), evidence_url=COALESCE(?,evidence_url), note=?, updated_at=? WHERE trade_date=? AND evidence_kind='official_notice'",
        [snapshotId, evidenceUrl, note, now, d]);
      updated += 1;
    } else {
      run(
        `INSERT INTO cea_calendar (trade_date,day_type,evidence_kind,evidence_url,source_code,snapshot_id,note,created_at,updated_at)
         VALUES (?, 'holiday', 'official_notice', ?,?,?,?,?,?)`,
        [d, evidenceUrl, sourceCode, snapshotId, note, now, now]
      );
      created += 1;
    }
  }
  // 公告写明「起照常开市」的日期：单独记 `official_notice_open` 的 trading 证据，
  // 用于在核对时压过机器辅助列表的误标（不删除机器列表原文）
  let reopened = 0;
  for (const d of parsed.reopen_dates) {
    const ex = get("SELECT trade_date FROM cea_calendar WHERE trade_date=? AND evidence_kind='official_notice_open'", [d]);
    if (ex) {
      run("UPDATE cea_calendar SET snapshot_id=COALESCE(?,snapshot_id), evidence_url=COALESCE(?,evidence_url), note=?, updated_at=? WHERE trade_date=? AND evidence_kind='official_notice_open'",
        [snapshotId, evidenceUrl, note, now, d]);
    } else {
      run(
        `INSERT INTO cea_calendar (trade_date,day_type,evidence_kind,evidence_url,source_code,snapshot_id,note,created_at,updated_at)
         VALUES (?, 'trading', 'official_notice_open', ?,?,?,?,?,?)`,
        [d, evidenceUrl, sourceCode, snapshotId, note, now, now]
      );
      reopened += 1;
    }
  }
  if (documentId) run('UPDATE cea_document SET note=?, updated_at=? WHERE id=?', [note.slice(0, 900), now, documentId]);
  const reconcile = reconcileCeaCalendar({ actor });
  return { ok: true, created, updated, reopened, closed_dates: parsed.closed_dates.length, note, reconcile };
}

/**
 * CEA 日历核对：正式公告 / 机器辅助列表 / 实际成交三方对照。
 *
 * 规范要求（docs/31 补充段）：
 *   - 正式公告优先于机器辅助列表；
 *   - 机器列表异常**独立告警**、保留原文，不抹掉，也不把可靠行情数值判成不真实；
 *   - **不生成人工复核任务**（manual_review 恒为 0）。
 */
export function reconcileCeaCalendar({ actor = 'system:cea-collect', from = null, to = null } = {}) {
  const now = nowIso();
  const where = [];
  const params = [];
  if (from) { where.push('trade_date>=?'); params.push(from); }
  if (to) { where.push('trade_date<=?'); params.push(to); }
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  // 只使用**当前有效集合**：来源修订（如 holidays.json 101→100）后，被来源删除的旧日期已标 superseded，
  // 不再参与核对，也不继续产生永久告警；旧证据行仍在（含原 note / snapshot），可用 include_superseded 追溯。
  const scopeCond = where.length ? ` AND ${where.join(' AND ')}` : '';
  const machine = new Set(all(`SELECT trade_date FROM cea_calendar WHERE source_state='current' AND evidence_kind='holidays_json'${scopeCond}`, params).map((r) => r.trade_date));
  const notice = new Set(all(`SELECT trade_date FROM cea_calendar WHERE source_state='current' AND evidence_kind='official_notice'${scopeCond}`, params).map((r) => r.trade_date));
  const reopened = new Set(all(`SELECT trade_date FROM cea_calendar WHERE source_state='current' AND evidence_kind='official_notice_open'${scopeCond}`, params).map((r) => r.trade_date));
  const traded = new Set(all(`SELECT DISTINCT trade_date FROM cea_trade_daily ${clause}`, params).map((r) => r.trade_date));
  const dates = [...new Set([...machine, ...notice, ...reopened, ...traded])].sort();
  let anomalies = 0;
  for (const d of dates) {
    const inMachine = machine.has(d);
    const inNotice = notice.has(d);
    const isReopened = reopened.has(d);
    const hasTrades = traded.has(d);
    const evidence = {
      machine_holidays_json: inMachine ? 'holiday' : null,
      official_notice: inNotice ? 'holiday' : null,
      official_notice_open: isReopened ? 'trading' : null,
      actual_trades: hasTrades ? 'traded' : null,
    };
    // 综合结论：正式公告 > 实际成交 > 机器辅助列表
    const effective = inNotice && !hasTrades && !isReopened ? 'closed' : hasTrades || isReopened ? 'trading' : inNotice ? 'closed' : 'unknown';

    // 异常：机器列表与实际成交/正式公告开市日矛盾
    if (inMachine && (hasTrades || isReopened) && !inNotice) {
      anomalies += 1;
      const detail =
        `机器辅助休市列表（holidays.json）把 ${d} 标为休市，但` +
        `${hasTrades ? '当日官方公开 JSON 有真实成交记录' : ''}${hasTrades && isReopened ? '，且' : ''}` +
        `${isReopened ? '正式休市公告明确写「该日起照常开市」' : ''}。` +
        '按「正式公告优先于机器辅助列表」处理：该日按交易日对待，机器列表原文保留、不删除，' +
        '行情数值不因此被判为不真实，也不生成人工复核任务。';
      run(
        `INSERT INTO cea_calendar_check (trade_date,check_key,severity,effective_state,detail,evidence_json,resolved_by,manual_review,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,0,?,?)
         ON CONFLICT(trade_date,check_key) DO UPDATE SET severity=excluded.severity, effective_state=excluded.effective_state,
           detail=excluded.detail, evidence_json=excluded.evidence_json, resolved_by=excluded.resolved_by,
           manual_review=0, updated_at=excluded.updated_at`,
        [d, 'machine_list_vs_actual', 'warn', effective, detail, j(evidence), hasTrades ? 'actual_trades' : 'official_notice', now, now]
      );
    } else {
      run('DELETE FROM cea_calendar_check WHERE trade_date=? AND check_key=?', [d, 'machine_list_vs_actual']);
    }
    // 正式公告内部核对：某日既被公告列为休市，又被公告列为开市 → 冲突（不静默择一）
    if (inNotice && isReopened) {
      run(
        `INSERT INTO cea_calendar_check (trade_date,check_key,severity,effective_state,detail,evidence_json,resolved_by,manual_review,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,0,?,?)
         ON CONFLICT(trade_date,check_key) DO UPDATE SET severity=excluded.severity, effective_state=excluded.effective_state,
           detail=excluded.detail, evidence_json=excluded.evidence_json, resolved_by=excluded.resolved_by,
           manual_review=0, updated_at=excluded.updated_at`,
        [d, 'notice_internal_conflict', 'warn', effective,
          `正式休市公告同时把 ${d} 写进休市范围与「起照常开市」，两侧原文均保留，需以上游修订为准（不生成人工复核任务）。`,
          j(evidence), 'none', now, now]
      );
    } else {
      run('DELETE FROM cea_calendar_check WHERE trade_date=? AND check_key=?', [d, 'notice_internal_conflict']);
    }
  }
  // 来源修订自动结清旧告警：某日期已不在当前有效集合、也没有实际成交/正式公告证据时，
  // 只由已过期（superseded）机器列表产生的旧核对行必须删除 —— 否则旧告警会永久残留。
  const dateSet = new Set(dates);
  const staleChecks = all(
    `SELECT trade_date FROM cea_calendar_check WHERE check_key='machine_list_vs_actual'${scopeCond}`,
    params
  ).map((r) => r.trade_date).filter((d) => !dateSet.has(d));
  for (const d of staleChecks) {
    run('DELETE FROM cea_calendar_check WHERE trade_date=? AND check_key=?', [d, 'machine_list_vs_actual']);
  }
  return { dates_checked: dates.length, anomalies, manual_review_created: 0, actor, stale_checks_closed: staleChecks.length };
}

export function listCeaCalendarChecks({ severity = null, from = null, to = null, limit = 200 } = {}) {
  const where = [];
  const params = [];
  if (severity) { where.push('severity=?'); params.push(severity); }
  if (from) { where.push('trade_date>=?'); params.push(from); }
  if (to) { where.push('trade_date<=?'); params.push(to); }
  const rows = all(
    `SELECT * FROM cea_calendar_check ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY trade_date DESC LIMIT ?`,
    [...params, Math.min(Number(limit) || 200, 1000)]
  ).map((r) => ({ ...r, evidence: uj(r.evidence_json, null) }));
  return { total: rows.length, rows, anomalies: rows.filter((r) => r.severity === 'warn').length, manual_review_created: 0 };
}

/**
 * 日历分层视图：每个日期给出「正式公告 / 机器辅助列表 / 实际成交」三层证据与综合结论，
 * 异常单独成列，不与常规日期混在一起（需求：日期/金额核验状态与日历来源异常分层展示）。
 */
export function ceaCalendarLayered({ from = null, to = null, limit = 400 } = {}) {
  const rows = listCeaCalendar({ from, to });
  const checks = listCeaCalendarChecks({ from, to, limit: 1000 }).rows;
  const byDate = new Map();
  for (const r of rows) {
    if (!byDate.has(r.trade_date)) byDate.set(r.trade_date, { trade_date: r.trade_date, layers: {}, evidence_kinds: [] });
    const item = byDate.get(r.trade_date);
    item.layers[r.evidence_kind] = { day_type: r.day_type, source_code: r.source_code, evidence_url: r.evidence_url, note: r.note };
    item.evidence_kinds.push(r.evidence_kind);
  }
  const tradedDates = new Set(all('SELECT DISTINCT trade_date FROM cea_trade_daily').map((r) => r.trade_date));
  for (const [d, item] of byDate) {
    const machineHoliday = item.layers.holidays_json?.day_type === 'holiday';
    const noticeHoliday = item.layers.official_notice?.day_type === 'holiday';
    const noticeOpen = item.layers.official_notice_open?.day_type === 'trading';
    const hasTrades = tradedDates.has(d);
    item.actual_trades = hasTrades;
    // 正式公告优先；其次实际成交；机器列表只作为辅助证据
    item.effective_state = noticeHoliday && !hasTrades && !noticeOpen ? 'closed' : hasTrades || noticeOpen ? 'trading' : machineHoliday ? 'holiday_machine_only' : 'unknown';
    item.anomaly = checks.find((c) => c.trade_date === d) || null;
    item.source_priority_note = noticeHoliday || noticeOpen
      ? '正式全年休市公告优先于查询页使用的机器辅助列表'
      : '仅有机器辅助列表证据（正式公告未覆盖该日）';
  }
  const list = [...byDate.values()].sort((a, b) => (a.trade_date < b.trade_date ? 1 : -1)).slice(0, Math.min(Number(limit) || 400, 2000));
  // 过期证据（来源修订后已删除的日期）：行与原始 note/snapshot 保留，但不出现在上面的当前分层里。
  const supWhere = [];
  const supParams = [];
  if (from) { supWhere.push('trade_date>=?'); supParams.push(from); }
  if (to) { supWhere.push('trade_date<=?'); supParams.push(to); }
  const supersededRows = all(
    `SELECT evidence_kind, COUNT(*) AS c FROM cea_calendar WHERE source_state='superseded'` +
    `${supWhere.length ? ' AND ' + supWhere.join(' AND ') : ''} GROUP BY evidence_kind`,
    supParams
  );
  const supersededTotal = supersededRows.reduce((a, r) => a + Number(r.c || 0), 0);
  return {
    rows: list,
    total: byDate.size,
    anomalies: checks.filter((c) => c.severity === 'warn'),
    anomaly_count: checks.filter((c) => c.severity === 'warn').length,
    superseded_evidence: { total: supersededTotal, by_kind: supersededRows },
    layers_note:
      '三层证据分开保存、互不覆盖：official_notice=正式全年休市公告（沪环境交〔2025〕44号一类），' +
      'holidays_json=官方查询页使用的机器辅助非周末休市列表，actual_trades=当日是否有真实成交记录。' +
      '综合结论按「正式公告 > 实际成交 > 机器辅助列表」给出；机器列表异常独立告警并保留原文，不生成人工复核任务。' +
      (supersededTotal
        ? ` 另有 ${supersededTotal} 条来源修订后的过期证据（superseded）：历史原文与快照保留可追溯，不作为当前事实或告警依据。`
        : ''),
  };
}

/** 记录某个交易日某个数据通道的来源层级（精确 / 概览），便于来源钻取与审计 */
export function recordQuoteSource({
  trade_date, channel, sourceCode = null, sourceUrl = null, snapshotId = null,
  contentHash = null, fetchedAt = null, parsed = null, isPrecise = 0, isOverview = 0, note = null,
}) {
  if (!isDate(trade_date) || !channel) return { error: 'recordQuoteSource 需要 trade_date 与 channel', status: 400 };
  const now = nowIso();
  const ex = get('SELECT id FROM cea_quote_source WHERE trade_date=? AND channel=? AND source_code IS ?', [trade_date, channel, sourceCode]);
  if (ex) {
    run(
      `UPDATE cea_quote_source SET source_url=?,snapshot_id=?,content_hash=?,fetched_at=?,parsed_json=?,
         is_precise=?,is_overview=?,note=? WHERE id=?`,
      [sourceUrl, snapshotId, contentHash, fetchedAt || now, parsed ? j(parsed).slice(0, 100_000) : null,
        isPrecise ? 1 : 0, isOverview ? 1 : 0, note, ex.id]
    );
    return { ok: true, id: ex.id, updated: true };
  }
  const id = newId('CEAQS');
  run(
    `INSERT INTO cea_quote_source (id,trade_date,channel,source_code,source_url,snapshot_id,content_hash,fetched_at,
       parsed_json,is_precise,is_overview,note,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, trade_date, channel, sourceCode, sourceUrl, snapshotId, contentHash, fetchedAt || now,
      parsed ? j(parsed).slice(0, 100_000) : null, isPrecise ? 1 : 0, isOverview ? 1 : 0, note, now]
  );
  return { ok: true, id, created: true };
}

export function listQuoteSources({ trade_date = null, limit = 200 } = {}) {
  return all(
    `SELECT id,trade_date,channel,source_code,source_url,snapshot_id,content_hash,fetched_at,is_precise,is_overview,note,created_at
     FROM cea_quote_source ${trade_date ? 'WHERE trade_date=?' : ''} ORDER BY trade_date DESC, channel LIMIT ?`,
    trade_date ? [trade_date, Math.min(Number(limit) || 200, 1000)] : [Math.min(Number(limit) || 200, 1000)]
  );
}

/* ==================================================================== */
/*  三之二、真实历史价格层（hiskline 公开序列）                          */
/* ==================================================================== */

/**
 * 写入官方公开历史价格序列（`hiskline.json`）。
 *
 * 口径纪律：
 *   - `volume_reference` 是来源给出的参考数量，**不是**全国全方式成交量，
 *     禁止写入 `cea_trade_daily.total_volume`，也禁止据此推算成交额或全方式均价；
 *   - 本表**没有** turnover / vwap 列：没有金额的历史点不生成成交额与均价；
 *   - 与精确日统计（querySubStat）分层保存，`is_precise=0`，界面上分开图例。
 */
export function upsertCeaPriceHistory(points = [], {
  sourceCode = 'cea_json_hiskline', sourceUrl = null, snapshotId = null, contentHash = null, fetchedAt = null,
  priceRegime = 'CEA_HISKLINE', quoteCaliber = 'source_history', actor = 'system:cea-collect',
} = {}) {
  const now = nowIso();
  let created = 0;
  let updated = 0;
  let skipped = 0;
  for (const p of points || []) {
    if (!isDate(p?.trade_date)) { skipped += 1; continue; }
    const ex = get('SELECT id FROM cea_price_history WHERE trade_date=? AND source_code IS ?', [p.trade_date, sourceCode]);
    const note = '来源历史价格序列（hiskline）：volume_reference 为参考数量，不是全国全方式成交量；未生成成交额/均价。';
    if (ex) {
      run(
        `UPDATE cea_price_history SET open=?,high=?,low=?,close=?,volume_reference=?,price_regime=?,quote_caliber=?,
           is_precise=0,source_url=?,snapshot_id=?,content_hash=?,fetched_at=?,note=?,updated_at=? WHERE id=?`,
        [p.open ?? null, p.high ?? null, p.low ?? null, p.close ?? null, p.volume_reference ?? null,
          priceRegime, quoteCaliber, sourceUrl, snapshotId, contentHash, fetchedAt || now, note, now, ex.id]
      );
      updated += 1;
    } else {
      run(
        `INSERT INTO cea_price_history (id,trade_date,open,high,low,close,volume_reference,price_regime,quote_caliber,
           is_precise,source_code,source_url,snapshot_id,content_hash,fetched_at,note,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?,?)`,
        [newId('CEAPH'), p.trade_date, p.open ?? null, p.high ?? null, p.low ?? null, p.close ?? null,
          p.volume_reference ?? null, priceRegime, quoteCaliber, sourceCode, sourceUrl, snapshotId, contentHash,
          fetchedAt || now, note, now, now]
      );
      created += 1;
    }
  }
  return { ok: true, created, updated, skipped, total: (points || []).length, actor };
}

export function listCeaPriceHistory({ from = null, to = null, limit = 500, price_regime = null } = {}) {
  const where = [];
  const params = [];
  if (from) { where.push('trade_date>=?'); params.push(from); }
  if (to) { where.push('trade_date<=?'); params.push(to); }
  if (price_regime) { where.push('price_regime=?'); params.push(price_regime); }
  const rows = all(
    `SELECT trade_date,open,high,low,close,volume_reference,price_regime,quote_caliber,is_precise,
            source_code,source_url,snapshot_id,content_hash,fetched_at,note
     FROM cea_price_history ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY trade_date ASC LIMIT ?`,
    [...params, Math.min(Number(limit) || 500, 5000)]
  );
  return {
    total: rows.length,
    rows,
    earliest: rows[0]?.trade_date || null,
    latest: rows[rows.length - 1]?.trade_date || null,
  };
}

/**
 * 分层价格序列：左侧「来源历史价格」（hiskline 真实长期序列）+ 右侧「精确日统计」（querySubStat）。
 * 两层**不合并、不互相覆盖**，前端必须以不同图例展示。
 *
 * @param {{from?:string|null,to?:string|null,limit?:number}} opts limit 默认 200（≥120 保证足够的历史点）
 */
export function ceaPriceHistoryLayered({ from = null, to = null, limit = 200 } = {}) {
  const n = Math.min(Math.max(Number(limit) || 200, 1), 2000);
  const hist = listCeaPriceHistory({ limit: 5000 });
  const windowed = hist.rows.filter((r) => (!from || r.trade_date >= from) && (!to || r.trade_date <= to));
  const sourceHistory = windowed.slice(-n);
  const precise = listCeaTradeDaily({ from, to, limit: 2000 }).rows
    .slice()
    .sort((a, b) => (a.trade_date < b.trade_date ? -1 : 1))
    .map((r) => ({
      trade_date: r.trade_date,
      open: r.open, high: r.high, low: r.low, close: r.close, change_pct: r.change_pct,
      total_volume: r.total_volume,             // 精确全方式成交量（吨）
      total_turnover: r.total_turnover,         // 精确全方式成交额（元）
      computed_avg_price: r.computed_avg_price, // 仅当有量有额时才非空
      price_regime: r.price_regime,
      quote_caliber: 'precise_daily',
      is_precise: 1,
      source_url: r.source_url,
      snapshot_id: r.snapshot_id,
      fetched_at: r.fetched_at,
    }));
  return {
    source_history: sourceHistory,
    precise_daily: precise,
    source_history_count: sourceHistory.length,
    precise_daily_count: precise.length,
    earliest_history: sourceHistory[0]?.trade_date || null,
    latest_history: sourceHistory[sourceHistory.length - 1]?.trade_date || null,
    latest_precise: precise.length ? precise[precise.length - 1].trade_date : null,
    min_points_note: sourceHistory.length >= 120
      ? `来源历史价格序列已覆盖 ${sourceHistory.length} 个真实价格点（≥120）`
      : `来源历史价格序列当前 ${sourceHistory.length} 个点，未达 120：需继续采集官方 hiskline.json（不伪造补点）`,
    caliber_note:
      '来源历史价格（source_history）来自官方公开 hiskline.json，是长期真实价格序列，其数量为**参考数量**，' +
      '不是全国全方式成交量；该层**没有**成交额与全方式均价（没有金额就不生成）。' +
      '精确日统计（precise_daily）来自 querySubStat 的 COMCEA 聚合，含精确成交量/额与程序计算的量加权均价。' +
      '两层口径不同，图表必须分开图例，不得互相覆盖或把参考数量当成交量。',
  };
}

/* ==================================================================== */
/*  四、总览与状态                                                      */
/* ==================================================================== */

export function ceaOverview() {
  const latest = get('SELECT * FROM cea_trade_daily ORDER BY trade_date DESC LIMIT 1');
  const counts = {
    trade_days: get('SELECT COUNT(*) AS c FROM cea_trade_daily')?.c || 0,
    trade_ok: get("SELECT COUNT(*) AS c FROM cea_trade_daily WHERE check_status='pass'")?.c || 0,
    trade_warn: get("SELECT COUNT(*) AS c FROM cea_trade_daily WHERE check_status='warn'")?.c || 0,
    trade_fail: get("SELECT COUNT(*) AS c FROM cea_trade_daily WHERE check_status='fail'")?.c || 0,
    trade_verified: get("SELECT COUNT(*) AS c FROM cea_trade_daily WHERE verification_status='verified'")?.c || 0,
    trade_unverified: get("SELECT COUNT(*) AS c FROM cea_trade_daily WHERE verification_status='unverified'")?.c || 0,
    documents: get('SELECT COUNT(*) AS c FROM cea_document WHERE count_in_stats=1')?.c || 0,
    documents_all_rows: get('SELECT COUNT(*) AS c FROM cea_document')?.c || 0,
    documents_attachments: get('SELECT COUNT(*) AS c FROM cea_document WHERE attachment_of IS NOT NULL')?.c || 0,
    documents_full_text: get("SELECT COUNT(*) AS c FROM cea_document WHERE evidence_level='full_text'")?.c || 0,
    overview_days: get('SELECT COUNT(*) AS c FROM cea_daily_overview')?.c || 0,
    calendar_holidays: get("SELECT COUNT(*) AS c FROM cea_calendar WHERE day_type='holiday' AND source_state='current'")?.c || 0,
    // 阶段B：日历来源异常、正式公告层与真实历史价格层覆盖（供界面分层展示）
    calendar_notice_days: get("SELECT COUNT(*) AS c FROM cea_calendar WHERE evidence_kind='official_notice' AND source_state='current'")?.c || 0,
    // 来源修订（holidays.json 101→100 一类）：旧证据保留但已标过期，不计入当前事实，单独计数以便追溯
    calendar_superseded: get("SELECT COUNT(*) AS c FROM cea_calendar WHERE source_state='superseded'")?.c || 0,
    calendar_anomalies: get("SELECT COUNT(*) AS c FROM cea_calendar_check WHERE severity='warn'")?.c || 0,
    calendar_manual_review: get('SELECT COUNT(*) AS c FROM cea_calendar_check WHERE manual_review<>0')?.c || 0,
    price_history_points: get('SELECT COUNT(*) AS c FROM cea_price_history')?.c || 0,
    price_history_earliest: get('SELECT MIN(trade_date) AS d FROM cea_price_history')?.d || null,
    price_history_latest: get('SELECT MAX(trade_date) AS d FROM cea_price_history')?.d || null,
    research_items: get("SELECT COUNT(*) AS c FROM cea_document WHERE doc_type IN ('research','news') AND evidence_level='full_text'")?.c || 0,
    research_viewpoints: get("SELECT COUNT(*) AS c FROM cea_document WHERE viewpoint='research_opinion'")?.c || 0,
    quote_channels: get('SELECT COUNT(*) AS c FROM cea_quote_source')?.c || 0,
    events: get('SELECT COUNT(*) AS c FROM cea_event')?.c || 0,
    entities: get('SELECT COUNT(*) AS c FROM cea_entity')?.c || 0,
    entity_provinces: get('SELECT COUNT(DISTINCT province) AS c FROM cea_entity WHERE province IS NOT NULL')?.c || 0,
    entities_no_credit_code: get('SELECT COUNT(*) AS c FROM cea_entity WHERE credit_code IS NULL')?.c || 0,
    intentions: get('SELECT COUNT(*) AS c FROM cea_intention')?.c || 0,
    intentions_buy: get("SELECT COUNT(*) AS c FROM cea_intention WHERE direction='buy'")?.c || 0,
    intentions_sell: get("SELECT COUNT(*) AS c FROM cea_intention WHERE direction='sell'")?.c || 0,
    open_gaps: get("SELECT COUNT(*) AS c FROM data_gap WHERE status='open' AND dataset LIKE 'cea%'")?.c || 0,
    sources_enabled: get('SELECT COUNT(*) AS c FROM cea_source WHERE enabled=1')?.c || 0,
    sources_failed: get("SELECT COUNT(*) AS c FROM cea_source WHERE last_status='failed'")?.c || 0,
  };
  const nearDeadlines = all(
    `SELECT * FROM cea_event WHERE deadline IS NOT NULL AND deadline >= ?
     ORDER BY deadline LIMIT 6`,
    [todayCst()]
  );
  // 概览层（官方舍入展示值）单独返回；与精确值分属两层，不互相覆盖
  const latestOverview = get('SELECT * FROM cea_daily_overview ORDER BY trade_date DESC LIMIT 1');
  return {
    latest_day: mapTradeRow(latest),
    latest_overview: latestOverview
      ? { ...latestOverview, cross_checks: uj(latestOverview.cross_check_json, []) }
      : null,
    counts,
    near_deadlines: nearDeadlines,
    data_as_of: latest?.trade_date || null,
    calibers: {
      close: '官方综合行情收盘价（2026 版为 CEA25 权重 1 的权重指数），不等于全方式量加权均价',
      computed_avg_price: '总成交额 / 总成交量（程序计算）',
      intention: '公开交易意向 ≠ 成交，不计入成交量/成交额',
      entity: '名录数量不等于买家数量，也不代表企业实际盈缺',
    },
    disclaimer:
      '所有统计均标注来源、数据截止日、品种、年度与价格口径。公开资料未披露的字段为 null；不使用 AI 推测冒充事实。',
  };
}

export function ceaStatus() {
  return {
    sources: listCeaSources({}),
    datasets: all('SELECT * FROM dataset_cursor WHERE dataset LIKE ? ORDER BY dataset', ['cea%']),
    jobs: all("SELECT * FROM ingestion_job WHERE job_key LIKE 'cea%' ORDER BY started_at DESC LIMIT 10"),
    counts: {
      trade_days: get('SELECT COUNT(*) AS c FROM cea_trade_daily')?.c || 0,
      documents: get('SELECT COUNT(*) AS c FROM cea_document')?.c || 0,
      events: get('SELECT COUNT(*) AS c FROM cea_event')?.c || 0,
      entities: get('SELECT COUNT(*) AS c FROM cea_entity')?.c || 0,
      intentions: get('SELECT COUNT(*) AS c FROM cea_intention')?.c || 0,
      checks: get('SELECT COUNT(*) AS c FROM cea_check')?.c || 0,
      revisions: get('SELECT COUNT(*) AS c FROM cea_trade_revision')?.c || 0,
    },
    defaults: CEA_DEFAULTS,
  };
}

/** 数据缺口登记（失败如实留缺口，不用占位数据顶替） */
export function recordCeaGap({
  dataset, title, description, impact = null, manualPath = null, severity = 'normal', gapKey = null,
} = {}) {
  if (!dataset || !title) return { error: '缺口登记需要 dataset 与 title', status: 400 };
  const key = gapKey || `cea:${dataset}:${title}`.slice(0, 300);
  const now = nowIso();
  const ex = get('SELECT id, status FROM data_gap WHERE gap_key=?', [key]);
  if (ex) {
    run('UPDATE data_gap SET description=?, impact=COALESCE(?,impact), manual_path=COALESCE(?,manual_path), updated_at=? WHERE id=?', [
      description || '', impact, manualPath, now, ex.id,
    ]);
    return { id: ex.id, deduped: true, status: ex.status };
  }
  const id = newId('GAP');
  run(
    `INSERT INTO data_gap (id,dataset,gap_key,title,description,impact,manual_path,severity,status,detected_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?, 'open',?,?)`,
    [id, dataset, key, title, description || '', impact, manualPath, severity, now, now]
  );
  return { id, created: true, status: 'open' };
}

export function listCeaGaps({ status = 'open' } = {}) {
  return all(
    `SELECT * FROM data_gap WHERE dataset LIKE 'cea%' ${status ? 'AND status=?' : ''} ORDER BY updated_at DESC LIMIT 500`,
    status ? [status] : []
  );
}

/**
 * 结清已消除的 CEA 缺口（例如同一 URL 之前抓取失败、本次已成功）。
 * 只改 status 与 description 留痕，不删除记录。
 */
export function closeCeaGap(gapKey, { note = null, actor = 'system:cea-collect' } = {}) {
  const ex = get('SELECT id,status FROM data_gap WHERE gap_key=?', [gapKey]);
  if (!ex) return { ok: false, reason: 'not_found' };
  if (ex.status === 'closed') return { ok: true, id: ex.id, already: true };
  const now = nowIso();
  run(
    `UPDATE data_gap SET status='closed', description=COALESCE(description,'') || ?, updated_at=? WHERE id=?`,
    [`｜已于 ${now} 结清：${note || '后续采集已成功获取并入库'}（由 ${actor} 自动结清，记录保留）`, now, ex.id]
  );
  return { ok: true, id: ex.id, closed: true };
}

/** 按缺口键前缀批量结清（例如某 URL 的抓取/解析缺口） */
export function closeCeaGapsByPrefixes(prefixes = [], { note = null, actor = 'system:cea-collect' } = {}) {
  let closed = 0;
  for (const p of prefixes) {
    const rows = all("SELECT gap_key FROM data_gap WHERE dataset LIKE 'cea%' AND status='open' AND gap_key LIKE ?", [`${p}%`]);
    for (const r of rows) {
      const res = closeCeaGap(r.gap_key, { note, actor });
      if (res.closed) closed += 1;
    }
  }
  return closed;
}

/* ==================================================================== */
/*  五、政策文件 / 日历 / 名录 / 意向                                    */
/* ==================================================================== */

function mapDoc(r) {
  if (!r) return null;
  return {
    ...r,
    covered_sectors: uj(r.covered_sectors, []),
    applicable_years: uj(r.applicable_years, []),
    coverage: uj(r.coverage_json, []),
    discovery: uj(r.discovery_json, null),
    count_in_stats: r.count_in_stats === undefined ? 1 : Number(r.count_in_stats),
    has_full_text: r.evidence_level === 'full_text',
    attachment_available: !!r.attachment_path || !!r.attachment_url || !!r.attachment_of,
    // 研报/动态的第一来源与观点标记（阶段B 尾项7 / docs35 尾项5）：
    //   研报/动态（research|news）只认**确认过的公开第一来源** first_source_url；
    //   聚合/转载站原文出处未知时保持 null，不把转载页当第一来源（本页 URL 在 page_url）；
    //   政策/技术文件的 official_url 本身就是官方来源，可继续作为 first_source。
    first_source: r.first_source_url
      || ((r.doc_type === 'research' || r.doc_type === 'news') ? null : (r.official_url || null)),
    first_source_unknown: !r.first_source_url && (r.doc_type === 'research' || r.doc_type === 'news'),
    page_url: r.page_url || r.official_url || null,
    data_cutoff_precision: r.data_cutoff_precision || (r.data_cutoff_date ? 'day' : null),
    data_cutoff_raw: r.data_cutoff_raw || null,
    is_viewpoint: r.viewpoint === 'research_opinion' || r.viewpoint === 'institution_view',
  };
}

/**
 * 判断某政策/配额文件是否适用于「行业 + 年度」。
 *
 * 规范要求：跨行业且不同年度生效的文件必须按**配对**判断，
 * 不得把 covered_sectors × applicable_years 做笛卡尔积。
 * 例：2026-09 分配方案的钢铁只适用 2026，发电适用 2025 与 2026。
 *
 * @returns {{applicable:boolean|null, reason:string, matched:Array}}
 */
export function documentApplicability(doc, { sector = null, year = null, docId = null } = {}) {
  const d = doc || (docId ? get('SELECT * FROM cea_document WHERE id=?', [docId]) : null);
  if (!d) return { applicable: null, reason: '文件不存在', matched: [] };
  const coverage = uj(d.coverage_json, null);
  const y = year === null || year === undefined || year === '' ? null : Number(year);
  if (Array.isArray(coverage) && coverage.length) {
    const hit = coverage.filter((c) => {
      const sectorOk = !sector || String(c.sector) === String(sector);
      const yearOk = y === null || (Array.isArray(c.years) ? c.years.map(Number) : []).includes(y);
      return sectorOk && yearOk;
    });
    if (hit.length) {
      return {
        applicable: true,
        matched: hit,
        reason: `配对覆盖命中：${hit.map((h) => `${h.sector} ${(h.years || []).join('/')}`).join('、')}（按行业×年度配对判断，未做笛卡尔积）`,
      };
    }
    const sectors = coverage.map((c) => c.sector);
    const sectorKnown = !sector || sectors.includes(String(sector));
    return {
      applicable: false,
      matched: [],
      reason: sectorKnown && sector
        ? `配对覆盖未命中：${sector}${y === null ? '' : ` ${y} 年度`} 不在本文件适用范围内（本文件配对为 ${coverage
            .map((c) => `${c.sector} ${(c.years || []).join('/')}`)
            .join('；')}）。不得由书面行业清单 × 年度清单推导适用性。`
        : `配对覆盖未命中：年度 ${y ?? '（未指定）'} 不在本文件适用范围内`,
    };
  }
  // 无配对数据时：只做保守的「都命中才算适用」，并明确标注依据不足
  const sectors = uj(d.covered_sectors, []);
  const years = uj(d.applicable_years, []).map(Number);
  const sectorOk = !sector || sectors.includes(String(sector));
  const yearOk = y === null || years.includes(y);
  return {
    applicable: sectorOk && yearOk ? null : false,
    matched: [],
    reason: sectorOk && yearOk
      ? '该文件未登记行业×年度配对，无法精确判定适用性（依据不足，不判为适用）'
      : `明确不适用：行业覆盖 ${sectors.join('/') || '（未登记）'}，年度覆盖 ${years.join('/') || '（未登记）'}`,
    coverage_missing: true,
  };
}

export function listCeaDocuments(f = {}) {
  const where = [];
  const params = [];
  if (f.doc_type) {
    // 支持逗号分隔的多类型（研报/动态列表常用 doc_type=research,news）
    const types = String(f.doc_type).split(',').map((s) => s.trim()).filter(Boolean);
    if (types.length === 1) { where.push('doc_type=?'); params.push(types[0]); }
    else if (types.length > 1) { where.push(`doc_type IN (${types.map(() => '?').join(',')})`); params.push(...types); }
  }
  if (f.category) { where.push('category=?'); params.push(f.category); }
  if (f.doc_status) { where.push('doc_status=?'); params.push(f.doc_status); }
  if (f.viewpoint) { where.push('viewpoint=?'); params.push(f.viewpoint); }
  if (f.sector) { where.push('covered_sectors LIKE ?'); params.push(`%${f.sector}%`); }
  if (f.year) { where.push('applicable_years LIKE ?'); params.push(`%${Number(f.year)}%`); }
  if (f.ai_status) { where.push('ai_status=?'); params.push(f.ai_status); }
  if (f.q) { where.push('(title LIKE ? OR issuer LIKE ? OR note LIKE ?)'); params.push(`%${f.q}%`, `%${f.q}%`, `%${f.q}%`); }
  const limit = Math.min(Number(f.limit) || 100, 500);
  const raw = all(
    `SELECT * FROM cea_document ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY COALESCE(publish_date,'') DESC, title LIMIT ?`,
    [...params, f.sector || f.year ? limit * 4 : limit]
  ).map(mapDoc);

  let rows = raw;
  let excludedNotApplicable = 0;
  let unknownApplicability = 0;
  if (f.sector || f.year) {
    // 规范要求（CEA-17）：按行业×年度配对判定，**不得返回 applicability=false 的文件**。
    // 例：钢铁 2025 不能命中 2026 年新版分配方案；发电 2025 应能命中。
    const annotated = raw.map((d) => ({ ...d, applicability: documentApplicability(d, { sector: f.sector || null, year: f.year || null }) }));
    const kept = annotated.filter((d) => {
      if (d.applicability.applicable === false) { excludedNotApplicable += 1; return false; }
      if (d.applicability.applicable === null) unknownApplicability += 1;
      return true;
    });
    rows = kept.slice(0, limit);
  }
  return {
    total: rows.length,
    total_before_applicability_filter: raw.length,
    excluded_not_applicable: excludedNotApplicable,
    unknown_applicability: unknownApplicability,
    rows,
    applicability_note: f.sector || f.year
      ? '适用性按行业×年度配对（coverage）判定：applicability=false 的文件已从结果中排除，' +
        '例如 2026 年分配方案的钢铁只适用 2026、发电适用 2025 与 2026；' +
        '不得由「覆盖行业清单 × 适用年度清单」推导（笛卡尔积）。缺少配对登记的条目保留但 applicability=null。'
      : null,
    note:
      '现行正式文件、历史文件、征求意见稿分列（doc_status）。日期由原文核对；' +
      '未获取到全文的条目 evidence_level=metadata_only，不得据此判定为已核验。' +
      (f.sector || f.year
        ? '已按行业×年度配对（coverage）过滤：明确不适用的文件已排除（excluded_not_applicable），' +
          '缺少配对登记的文件保留但 applicability=null（依据不足，不判为适用）。'
        : ''),
  };
}

/**
 * CEA 研报与行业动态列表（阶段B 尾项7）。
 * 每条给出：公开第一来源、机构、发布日期、数据截止日、观点标记与 AI 核验状态。
 */
/**
 * 数据截止日的展示文本：按**原文精度**呈现，不补造日。
 *   day   → 2023-12-31
 *   month → 2023-12（原文仅到月）
 *   year  → 2023（原文仅到年）
 */
export function formatCeaCutoff(date, precision) {
  if (!date) return null;
  const p = precision || (String(date).length === 10 ? 'day' : String(date).length === 7 ? 'month' : 'year');
  if (p === 'day') return String(date);
  if (p === 'month') return `${date}（原文仅到月）`;
  return `${date}（原文仅到年）`;
}

export function listCeaResearch(f = {}) {
  const out = listCeaDocuments({ ...f, doc_type: f.doc_type || 'research,news' });
  const withMeta = out.rows.map((d) => ({
    id: d.id,
    title: d.title,
    doc_type: d.doc_type,
    category: d.category,
    issuer: d.issuer,
    publish_date: d.publish_date,
    data_cutoff_date: d.data_cutoff_date,
    // 原文精度与原文片段：只到月/年时不显示成具体某一天（docs/35 第 5 条）
    data_cutoff_precision: d.data_cutoff_precision,
    data_cutoff_raw: d.data_cutoff_raw,
    data_cutoff_display: formatCeaCutoff(d.data_cutoff_date, d.data_cutoff_precision),
    viewpoint: d.viewpoint || (d.doc_type === 'research' ? 'research_opinion' : 'market_news'),
    is_viewpoint: d.is_viewpoint,
    first_source: d.first_source,
    first_source_unknown: d.first_source_unknown,
    page_url: d.page_url,
    official_url: d.official_url,
    evidence_level: d.evidence_level,
    body_chars: d.body_snapshot ? String(d.body_snapshot).length : 0,
    ai_status: d.ai_status,
    ai_summary: d.ai_summary,
    ai_checked_at: d.ai_checked_at,
    fetched_at: d.fetched_at,
    discovery: d.discovery,
    provenance_note: d.provenance_note,
    note: d.note,
  }));
  const gaps = listCeaGaps({ status: 'open' }).filter((g) => String(g.dataset || '').includes('research'));
  return {
    total: withMeta.length,
    rows: withMeta,
    by_viewpoint: withMeta.reduce((acc, r) => { acc[r.viewpoint] = (acc[r.viewpoint] || 0) + 1; return acc; }, {}),
    open_gaps: gaps,
    note:
      '研报与行业动态：条目必须来自真实取得的正文（evidence_level=full_text），保留公开第一来源、机构、发布日期、' +
      '数据截止日与观点标记；观点类内容不作为现行规则或履约义务依据。未取得正文的候选不写入本列表。',
  };
}

export function getCeaDocument(id) {
  const doc = mapDoc(get('SELECT * FROM cea_document WHERE id=?', [id]));
  if (!doc) return null;
  return {
    ...doc,
    events: all('SELECT * FROM cea_event WHERE source_document_id=? ORDER BY deadline', [id]),
    verifications: all(
      `SELECT * FROM verification_result WHERE object_type='cea_document' AND object_id=? ORDER BY created_at DESC LIMIT 10`,
      [id]
    ).map((v) => ({ ...v, citations: uj(v.citations_json, []), rules: uj(v.rules_json, []) })),
  };
}

/** 写入/更新政策文件元数据与正文（正文只能来自真实抓取） */
export function upsertCeaDocument(patch = {}, { actor = 'system:cea-collect' } = {}) {
  const docKey = String(patch.doc_key || '').trim();
  if (!docKey) return { error: '缺少 doc_key', status: 400 };
  if (!String(patch.title || '').trim()) return { error: '缺少标题', status: 400 };
  const now = nowIso();
  const ex = get('SELECT * FROM cea_document WHERE doc_key=?', [docKey]);
  const source = patch.source_code ? get('SELECT id FROM cea_source WHERE code=?', [patch.source_code]) : null;
  const cols = {
    doc_type: patch.doc_type || ex?.doc_type || 'news',
    category: patch.category ?? ex?.category ?? null,
    title: patch.title,
    doc_number: patch.doc_number ?? ex?.doc_number ?? null,
    issuer: patch.issuer ?? ex?.issuer ?? null,
    publish_date: patch.publish_date ?? ex?.publish_date ?? null,
    effective_date: patch.effective_date ?? ex?.effective_date ?? null,
    covered_sectors: patch.covered_sectors ? j(patch.covered_sectors) : ex?.covered_sectors ?? null,
    applicable_years: patch.applicable_years ? j(patch.applicable_years) : ex?.applicable_years ?? null,
    doc_status: patch.doc_status || ex?.doc_status || 'formal',
    version: patch.version ?? ex?.version ?? null,
    official_url: patch.official_url ?? ex?.official_url ?? null,
    source_id: source?.id ?? ex?.source_id ?? null,
    source_code: patch.source_code ?? ex?.source_code ?? null,
    snapshot_id: patch.snapshot_id ?? ex?.snapshot_id ?? null,
    content_hash: patch.content_hash ?? ex?.content_hash ?? null,
    fetched_at: patch.fetched_at ?? ex?.fetched_at ?? null,
    // 正文只允许被真实抓取的正文替换；patch 未给正文时保留原文，绝不用摘要顶替
    body_snapshot: patch.body_snapshot ?? ex?.body_snapshot ?? null,
    attachment_path: patch.attachment_path ?? ex?.attachment_path ?? null,
    attachment_hash: patch.attachment_hash ?? ex?.attachment_hash ?? null,
    attachment_url: patch.attachment_url ?? ex?.attachment_url ?? null,
    evidence_level: patch.evidence_level || ex?.evidence_level || 'metadata_only',
    // 配对覆盖与附件关联：采集不得清空已登记的元数据
    coverage_json: patch.coverage ? j(patch.coverage) : (ex?.coverage_json ?? null),
    coverage_source: patch.coverage_source ?? ex?.coverage_source ?? null,
    attachment_of: patch.attachment_of ?? ex?.attachment_of ?? null,
    count_in_stats: patch.count_in_stats !== undefined ? (patch.count_in_stats ? 1 : 0) : (ex?.count_in_stats ?? 1),
    // 研报/动态元数据（阶段B 尾项7）：第一来源、数据截止日、观点标记、发现通道留痕
    first_source_url: patch.first_source_url !== undefined ? (patch.first_source_url || null) : (ex?.first_source_url ?? null),
    data_cutoff_date: patch.data_cutoff_date ?? ex?.data_cutoff_date ?? null,
    // docs/35 尾项5：截止日精度与原文片段；当前页面 URL 与「第一来源」分开存
    data_cutoff_precision: patch.data_cutoff_precision !== undefined ? (patch.data_cutoff_precision || null) : (ex?.data_cutoff_precision ?? null),
    data_cutoff_raw: patch.data_cutoff_raw !== undefined ? (patch.data_cutoff_raw || null) : (ex?.data_cutoff_raw ?? null),
    page_url: patch.page_url !== undefined ? (patch.page_url || null) : (ex?.page_url ?? null),
    viewpoint: patch.viewpoint ?? ex?.viewpoint ?? null,
    discovery_json: patch.discovery_json ? String(patch.discovery_json) : (ex?.discovery_json ?? null),
    provenance_note: patch.provenance_note ?? ex?.provenance_note ?? null,
    note: patch.note ?? ex?.note ?? null,
  };
  if (ex) {
    run(
      `UPDATE cea_document SET doc_type=?,category=?,title=?,doc_number=?,issuer=?,publish_date=?,effective_date=?,
         covered_sectors=?,applicable_years=?,doc_status=?,version=?,official_url=?,source_id=?,source_code=?,
         snapshot_id=?,content_hash=?,fetched_at=?,body_snapshot=?,attachment_path=?,attachment_hash=?,attachment_url=?,
         evidence_level=?,coverage_json=?,coverage_source=?,attachment_of=?,count_in_stats=?,
         first_source_url=?,data_cutoff_date=?,viewpoint=?,discovery_json=?,
         data_cutoff_precision=?,data_cutoff_raw=?,page_url=?,
         provenance_note=?,note=?,updated_at=? WHERE id=?`,
      [
        cols.doc_type, cols.category, cols.title, cols.doc_number, cols.issuer, cols.publish_date, cols.effective_date,
        cols.covered_sectors, cols.applicable_years, cols.doc_status, cols.version, cols.official_url,
        cols.source_id, cols.source_code, cols.snapshot_id, cols.content_hash, cols.fetched_at, cols.body_snapshot,
        cols.attachment_path, cols.attachment_hash, cols.attachment_url, cols.evidence_level,
        cols.coverage_json, cols.coverage_source, cols.attachment_of, cols.count_in_stats,
        cols.first_source_url, cols.data_cutoff_date, cols.viewpoint, cols.discovery_json,
        cols.data_cutoff_precision, cols.data_cutoff_raw, cols.page_url,
        cols.provenance_note, cols.note, now, ex.id,
      ]
    );
    return { ok: true, id: ex.id, updated: true };
  }
  const id = newId('CEADOC');
  run(
    `INSERT INTO cea_document
     (id,doc_key,doc_type,category,title,doc_number,issuer,publish_date,effective_date,covered_sectors,
      applicable_years,doc_status,version,official_url,source_id,source_code,snapshot_id,content_hash,fetched_at,
      body_snapshot,attachment_path,attachment_hash,attachment_url,evidence_level,ai_status,
      coverage_json,coverage_source,attachment_of,count_in_stats,
      first_source_url,data_cutoff_date,viewpoint,discovery_json,
      data_cutoff_precision,data_cutoff_raw,page_url,
      provenance_note,note,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'unverified',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id, docKey, cols.doc_type, cols.category, cols.title, cols.doc_number, cols.issuer, cols.publish_date,
      cols.effective_date, cols.covered_sectors, cols.applicable_years, cols.doc_status, cols.version, cols.official_url,
      cols.source_id, cols.source_code, cols.snapshot_id, cols.content_hash, cols.fetched_at, cols.body_snapshot,
      cols.attachment_path, cols.attachment_hash, cols.attachment_url, cols.evidence_level,
      cols.coverage_json, cols.coverage_source, cols.attachment_of, cols.count_in_stats,
      cols.first_source_url, cols.data_cutoff_date, cols.viewpoint, cols.discovery_json,
      cols.data_cutoff_precision, cols.data_cutoff_raw, cols.page_url,
      cols.provenance_note, cols.note, now, now,
    ]
  );
  audit({ actor, action: 'cea.document_upsert', objectType: 'cea_document', objectId: id, detail: { doc_key: docKey, evidence_level: cols.evidence_level } });
  return { ok: true, id, created: true };
}

export function listCeaEvents(f = {}) {
  const where = [];
  const params = [];
  if (f.event_type) { where.push('event_type=?'); params.push(f.event_type); }
  if (f.year) {
    where.push('(emission_year=? OR quota_year=? OR list_year=?)');
    params.push(Number(f.year), Number(f.year), Number(f.year));
  }
  if (f.from) { where.push('(deadline IS NULL OR deadline>=?)'); params.push(f.from); }
  if (f.to) { where.push('(deadline IS NULL OR deadline<=?)'); params.push(f.to); }
  const rows = all(
    `SELECT * FROM cea_event ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY COALESCE(deadline,'9999-12-31'), event_type LIMIT ?`,
    [...params, Math.min(Number(f.limit) || 200, 1000)]
  );
  const docs = new Map(
    all('SELECT id,title,doc_status,official_url FROM cea_document').map((d) => [d.id, d])
  );
  return {
    total: rows.length,
    rows: rows.map((r) => ({
      ...r,
      document: r.source_document_id ? docs.get(r.source_document_id) || null : null,
      days_left: r.deadline ? Math.round((Date.parse(`${r.deadline}T00:00:00Z`) - Date.parse(`${todayCst()}T00:00:00Z`)) / 86400000) : null,
    })),
    note:
      '排放年度、配额年度、名录年度、执行日期分别记录；日期必须能回溯到原文片段。' +
      'date_verify_status=unverified 表示尚未用原文核验，不能据此当作确定的合规义务日期。',
  };
}

export function upsertCeaEvent(patch = {}, { actor = 'system:cea-collect' } = {}) {
  const key = String(patch.event_key || '').trim();
  if (!key) return { error: '缺少 event_key', status: 400 };
  if (!String(patch.title || '').trim()) return { error: '缺少标题', status: 400 };
  const now = nowIso();
  const ex = get('SELECT id FROM cea_event WHERE event_key=?', [key]);
  const doc = patch.source_doc_key ? get('SELECT id FROM cea_document WHERE doc_key=?', [patch.source_doc_key]) : null;
  const vals = [
    patch.event_type || ex?.event_type || 'other', patch.title, patch.deadline ?? ex?.deadline ?? null,
    patch.emission_year ?? ex?.emission_year ?? null, patch.quota_year ?? ex?.quota_year ?? null,
    patch.list_year ?? ex?.list_year ?? null, patch.industry ?? ex?.industry ?? null,
    doc?.id ?? patch.source_document_id ?? ex?.source_document_id ?? null,
    patch.source_url ?? ex?.source_url ?? null,
    // 原文片段只能被真实抓取的原文替换
    patch.source_quote ?? ex?.source_quote ?? null,
    patch.date_extract_status || ex?.date_extract_status || 'unverified',
    patch.date_verify_status || ex?.date_verify_status || 'unverified',
    patch.verify_note ?? ex?.verify_note ?? null, patch.note ?? ex?.note ?? null,
  ];
  if (ex) {
    run(
      `UPDATE cea_event SET event_type=?,title=?,deadline=?,emission_year=?,quota_year=?,list_year=?,industry=?,
         source_document_id=?,source_url=?,source_quote=?,date_extract_status=?,date_verify_status=?,verify_note=?,
         note=?,updated_at=? WHERE id=?`,
      [...vals, now, ex.id]
    );
    return { ok: true, id: ex.id, updated: true };
  }
  const id = newId('CEAEVT');
  run(
    `INSERT INTO cea_event (id,event_key,event_type,title,deadline,emission_year,quota_year,list_year,industry,
       source_document_id,source_url,source_quote,date_extract_status,date_verify_status,verify_note,note,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, key, ...vals, now, now]
  );
  audit({ actor, action: 'cea.event_upsert', objectType: 'cea_event', objectId: id, detail: { event_key: key } });
  return { ok: true, id, created: true };
}

/* ------------------------------ 企业名录 ------------------------------ */

export function listCeaEntities(f = {}) {
  const where = [];
  const params = [];
  if (f.province) { where.push('province=?'); params.push(f.province); }
  if (f.sector) { where.push('sector=?'); params.push(f.sector); }
  if (f.list_year) { where.push('list_year=?'); params.push(Number(f.list_year)); }
  if (f.status) { where.push('status=?'); params.push(f.status); }
  if (f.q) { where.push('(name LIKE ? OR credit_code LIKE ?)'); params.push(`%${f.q}%`, `%${f.q}%`); }
  const limit = Math.min(Number(f.limit) || 200, 1000);
  const offset = Math.max(Number(f.offset) || 0, 0);
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = get(`SELECT COUNT(*) AS c FROM cea_entity ${clause}`, params)?.c || 0;
  const rows = all(`SELECT * FROM cea_entity ${clause} ORDER BY list_year DESC, province, name LIMIT ? OFFSET ?`, [
    ...params, limit, offset,
  ]);
  return {
    total, limit, offset, rows,
    coverage: {
      provinces: get('SELECT COUNT(DISTINCT province) AS c FROM cea_entity WHERE province IS NOT NULL')?.c || 0,
      list_years: all('SELECT DISTINCT list_year FROM cea_entity ORDER BY list_year DESC').map((r) => r.list_year),
      without_credit_code: get('SELECT COUNT(*) AS c FROM cea_entity WHERE credit_code IS NULL')?.c || 0,
    },
    note:
      '以统一社会信用代码 + 名录年度建立标识；名称变化保留来源，不合并集团旗下不同法人或分公司。' +
      '名录数量不等于买家数量，也不代表企业实际盈缺。credit_code 为 null 表示公开名录未披露该字段。',
  };
}

export function upsertCeaEntity(patch = {}, { actor = 'system:cea-collect' } = {}) {
  const name = String(patch.name || '').trim();
  if (!name) return { error: '缺少企业名称', status: 400 };
  const listYear = Number(patch.list_year);
  if (!Number.isInteger(listYear)) return { error: '缺少名录年度 list_year', status: 400 };
  const creditCode = patch.credit_code ? String(patch.credit_code).trim().toUpperCase() : null;
  const entityKey = creditCode || `name:${name}`;
  const now = nowIso();
  let ex = get('SELECT * FROM cea_entity WHERE entity_key=? AND list_year=?', [entityKey, listYear]);
  // 同一原始名录的重采可能暂时识别不出信用代码；不能新增同名重复行，也不抹去旧代码。
  if (!ex && !creditCode && patch.source_code) ex = get('SELECT * FROM cea_entity WHERE name=? AND list_year=? AND source_code=?', [name, listYear, patch.source_code]);
  const source = patch.source_code ? get('SELECT id FROM cea_source WHERE code=?', [patch.source_code]) : null;
  if (ex) {
    // 名称/行业/省份变化保留历史，不静默改写
    const diffs = ['name', 'province', 'city', 'sector', 'status']
      .filter((k) => patch[k] !== undefined && String(patch[k] ?? '') !== String(ex[k] ?? ''))
      .map((k) => ({ field: k, old: ex[k], next: patch[k] }));
    for (const d of diffs) {
      run(
        `INSERT INTO cea_entity_revision (id,entity_id,revised_at,revised_by,field,old_value,new_value,reason,source_url)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [newId('CEAENTR'), ex.id, now, actor, d.field, d.old === null ? null : String(d.old), d.next === null ? null : String(d.next),
          '同一年度名录中该主体字段发生变化，保留旧值可审计', patch.source_url || ex.source_url || null]
      );
    }
    run(
      `UPDATE cea_entity SET name=?,province=COALESCE(?,province),city=COALESCE(?,city),sector=COALESCE(?,sector),
         status=COALESCE(?,status),source_id=COALESCE(?,source_id),source_url=COALESCE(?,source_url),
         source_code=COALESCE(?,source_code),snapshot_id=COALESCE(?,snapshot_id),source_hash=COALESCE(?,source_hash),
         data_as_of=COALESCE(?,data_as_of),note=COALESCE(?,note),updated_at=? WHERE id=?`,
      [
        name, patch.province ?? null, patch.city ?? null, patch.sector ?? null, patch.status ?? null,
        source?.id ?? null, patch.source_url ?? null, patch.source_code ?? null, patch.snapshot_id ?? null,
        patch.source_hash ?? null, patch.data_as_of ?? null, patch.note ?? null, now, ex.id,
      ]
    );
    return { ok: true, id: ex.id, updated: true, revisions: diffs.length };
  }
  const id = newId('CEAENT');
  run(
    `INSERT INTO cea_entity (id,entity_key,name,credit_code,province,city,sector,list_year,status,source_id,
       source_url,source_code,snapshot_id,source_hash,data_as_of,verify_status,note,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'unverified',?,?,?)`,
    [
      id, entityKey, name, creditCode, patch.province ?? null, patch.city ?? null, patch.sector ?? null,
      listYear, patch.status || 'existing', source?.id || null, patch.source_url || null,
      patch.source_code || null, patch.snapshot_id || null, patch.source_hash || null,
      patch.data_as_of || null, patch.note || null, now, now,
    ]
  );
  return { ok: true, id, created: true };
}

/* ------------------------------ 交易意向 ------------------------------ */

export function listCeaIntentions(f = {}) {
  const where = [];
  const params = [];
  if (f.direction) { where.push('direction=?'); params.push(f.direction); }
  if (f.quota_year) { where.push('quota_year=?'); params.push(Number(f.quota_year)); }
  if (f.from) { where.push('(published_date IS NULL OR published_date>=?)'); params.push(f.from); }
  if (f.to) { where.push('(published_date IS NULL OR published_date<=?)'); params.push(f.to); }
  const rows = all(
    `SELECT * FROM cea_intention ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY COALESCE(published_date,'') DESC LIMIT ?`,
    [...params, Math.min(Number(f.limit) || 200, 1000)]
  );
  return {
    total: rows.length,
    rows,
    // 意向与成交严格分开：这里再显式声明一次，避免调用方误用
    not_turnover: true,
    note:
      '公开交易意向不等于成交，不计入成交量/成交额。价格或主体未公开时为 null，不用 0 或推测值填充。' +
      '本数据集不参与 cea_trade_daily 的任何统计。',
  };
}

export function upsertCeaIntention(patch = {}, { actor = 'system:cea-collect' } = {}) {
  const dir = ['buy', 'sell', 'unknown'].includes(patch.direction) ? patch.direction : null;
  if (!dir) return { error: 'direction 必须是 buy/sell/unknown', status: 400 };
  const key =
    String(patch.intention_key || '').trim() ||
    `${patch.source_code || 'src'}|${patch.published_date || 'nodate'}|${dir}|${patch.volume ?? 'novol'}|${patch.instrument_label || ''}`;
  const now = nowIso();
  const ex = get('SELECT id, first_seen_at FROM cea_intention WHERE intention_key=?', [key]);
  const source = patch.source_code ? get('SELECT id FROM cea_source WHERE code=?', [patch.source_code]) : null;
  if (ex) {
    run(
      `UPDATE cea_intention SET published_date=COALESCE(?,published_date), instrument_label=COALESCE(?,instrument_label),
         quota_year=COALESCE(?,quota_year), direction=?, volume=COALESCE(?,volume), price=COALESCE(?,price),
         participant=COALESCE(?,participant), source_url=COALESCE(?,source_url), source_hash=COALESCE(?,source_hash),
         snapshot_id=COALESCE(?,snapshot_id), last_seen_at=?, note=COALESCE(?,note), updated_at=? WHERE id=?`,
      [
        patch.published_date ?? null, patch.instrument_label ?? null, patch.quota_year ?? null, dir,
        patch.volume ?? null, patch.price ?? null, patch.participant ?? null, patch.source_url ?? null,
        patch.source_hash ?? null, patch.snapshot_id ?? null, now, patch.note ?? null, now, ex.id,
      ]
    );
    return { ok: true, id: ex.id, updated: true };
  }
  const id = newId('CEAINT');
  run(
    `INSERT INTO cea_intention (id,intention_key,source_id,source_code,published_date,instrument_label,quota_year,
       direction,volume,price,participant,source_url,source_hash,snapshot_id,last_seen_at,first_seen_at,
       verify_status,note,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'unverified',?,?,?)`,
    [
      id, key, source?.id || null, patch.source_code || null, patch.published_date ?? null,
      patch.instrument_label ?? null, patch.quota_year ?? null, dir, patch.volume ?? null, patch.price ?? null,
      patch.participant ?? null, patch.source_url ?? null, patch.source_hash ?? null, patch.snapshot_id ?? null,
      now, now, patch.note ?? null, now, now,
    ]
  );
  audit({ actor, action: 'cea.intention_upsert', objectType: 'cea_intention', objectId: id, detail: { intention_key: key, direction: dir } });
  return { ok: true, id, created: true };
}

/* ==================================================================== */
/*  六、轻量履约成本情景（无持久化）                                     */
/* ==================================================================== */

const MAX_SCENARIO_NUMBER = 1e12;

/** 已获证据支持的抵销比例预设（**不是**所有年度的现行规则承诺） */
export const CEA_OFFSET_PRESETS = [
  {
    key: 'custom',
    label: '自定义情景假设',
    ratio: null,
    note: '由使用者自行输入比例，本平台不判断其合规性；结果只是情景算术。',
  },
  {
    key: 'historical_5pct',
    label: '历史 5%（仅作历史情景，非现行规则承诺）',
    ratio: 0.05,
    note:
      '历史上曾使用的抵销比例。**不得**把它无条件写成所有年度的现行规则；' +
      '实际可用比例须以对应年度的正式文件为准，且必须考虑 CCER 可用数量上限。',
  },
];

function scenarioNum(v, name, { allowZero = true, max = MAX_SCENARIO_NUMBER } = {}) {
  if (v === null || v === undefined || v === '') return { ok: false, error: `${name} 不能为空` };
  const n = Number(v);
  if (!Number.isFinite(n)) return { ok: false, error: `${name} 必须是有限数值（拒绝 NaN / Infinity / 非数字）` };
  if (n < 0) return { ok: false, error: `${name} 不能为负` };
  if (!allowZero && n === 0) return { ok: false, error: `${name} 必须大于 0` };
  if (n > max) return { ok: false, error: `${name} 超出可计算范围（上限 ${max}）` };
  return { ok: true, value: n };
}

/**
 * 履约成本情景计算。**只做算术，不写库、不采集、不产生任何副作用。**
 *
 *   D = max(E - A, 0)
 *   Q = min(D, C, max(E*r - U, 0))
 *   仅买 CEA 成本 = D * P1
 *   组合参考成本 = (D - Q) * P1 + Q * P2 + 新增费用
 *
 * 结果可能为负（差额），不自动建议购买，也不等于真实成交或最终履约费用。
 */
export function runCeaScenario(input = {}) {
  const fields = {};
  for (const [key, name, opts] of [
    ['E', '应清缴量 E', { allowZero: true }],
    ['A', '可用于该年度清缴的配额 A', { allowZero: true }],
    ['C', '符合该年度规则的 CCER 可用数量 C', { allowZero: true }],
    ['U', '已使用抵销量 U', { allowZero: true }],
    ['P1', '参考 CEA 价格 P1', { allowZero: true }],
    ['P2', 'CCER 价格 P2', { allowZero: true }],
    ['extra_cost', '新增费用', { allowZero: true }],
  ]) {
    if (input[key] === undefined || input[key] === null || input[key] === '') {
      // 只有新增费用允许缺省为 0，其余必须显式给出
      if (key === 'extra_cost') { fields[key] = 0; continue; }
      return { error: `缺少输入 ${name}`, field: key, status: 400 };
    }
    const r = scenarioNum(input[key], name, opts);
    if (!r.ok) return { error: r.error, field: key, status: 400 };
    fields[key] = r.value;
  }
  // 抵销比例必须显式给出：不能默认套用历史 5%（规范：不得把历史 5% 无条件写成现行规则）
  if (input.r === undefined || input.r === null || input.r === '') {
    return {
      error: '必须显式选择抵销比例 r（可用预设或自定义情景假设）',
      message: CEA_SCENARIO_NOTE,
      field: 'r',
      presets: CEA_OFFSET_PRESETS,
      status: 400,
    };
  }
  const rr = scenarioNum(input.r, '抵销比例 r', { allowZero: true, max: 1 });
  if (!rr.ok) return { error: `${rr.error}（比例范围 0..1）`, field: 'r', status: 400 };
  const { E, A, C, U, P1, P2, extra_cost: extra } = fields;
  const r = rr.value;

  const D = Math.max(E - A, 0);
  // U > E*r 时剩余抵销额度为 0（不允许负数额度变成额外抵扣）
  const offsetRoom = Math.max(E * r - U, 0);
  const Q = Math.min(D, C, offsetRoom);
  const ceaOnlyCost = D * P1;
  const combinedCost = (D - Q) * P1 + Q * P2 + extra;
  const diff = combinedCost - ceaOnlyCost;

  return {
    ok: true,
    persisted: false,
    inputs: { E, A, C, U, r, P1, P2, extra_cost: extra },
    result: {
      gap_D: round(D, 6),
      offset_room: round(offsetRoom, 6),
      offset_used_Q: round(Q, 6),
      remaining_offset_room: round(Math.max(offsetRoom - Q, 0), 6),
      cea_only_cost: round(ceaOnlyCost, 6),
      combined_reference_cost: round(combinedCost, 6),
      difference: round(diff, 6),
      difference_kind: '情景算术差额（可能为负）',
      units: { quantity: '吨CO2e', price: '元/吨', cost: '元' },
    },
    assumptions: {
      offset_ratio_source: input.offset_ratio_source || 'user_input',
      offset_ratio_note:
        '抵销比例来自使用者输入或所选预设。历史上 5% 的抵销比例不是所有年度的现行规则承诺；' +
        '实际可用比例与 CCER 可用数量上限必须以对应年度的正式文件为准。',
      price_note:
        '参考价格由使用者提供或显式覆盖；如需引用平台行情，请同时记录行情日期与口径' +
        '（官方综合收盘价 / 全方式计算均价是两个不同口径）。',
    },
    disclaimer:
      '本结果是临时情景算术，不写入任何台账，不自动建议购买，也不等于真实成交价、最终履约费用或合规结论。',
  };
}

/* ==================================================================== */
/*  七、导出数据行                                                      */
/* ==================================================================== */

export const CEA_EXPORT_COLUMNS = {
  trade: [
    { key: 'trade_date', label: '交易日期', definition: '官方行情对应的交易日' },
    { key: 'instrument', label: '品种', definition: 'CEA 配额标的' },
    { key: 'price_regime', label: '行情口径版本', definition: 'CEA_COMPOSITE_2026：2026-01-05 起 CEA25 权重 1' },
    { key: 'open', label: '开盘价', unit: '元/吨' },
    { key: 'high', label: '最高价', unit: '元/吨' },
    { key: 'low', label: '最低价', unit: '元/吨' },
    { key: 'close', label: '官方综合收盘价', unit: '元/吨', definition: '官方公布的指定权重指数收盘价，不是全方式量加权均价' },
    { key: 'computed_avg_price', label: '全方式计算均价', unit: '元/吨', definition: '总成交额/总成交量（程序计算）；无成交时为空' },
    { key: 'change_pct', label: '涨跌幅', unit: '%' },
    { key: 'listed_volume', label: '挂牌协议成交量', unit: '吨' },
    { key: 'listed_turnover', label: '挂牌协议成交额', unit: '元' },
    { key: 'block_volume', label: '大宗协议成交量', unit: '吨' },
    { key: 'block_turnover', label: '大宗协议成交额', unit: '元' },
    { key: 'auction_volume', label: '单向竞价成交量', unit: '吨', definition: '空=未披露；0=官方明确无' },
    { key: 'auction_turnover', label: '单向竞价成交额', unit: '元' },
    { key: 'total_volume', label: '总成交量', unit: '吨' },
    { key: 'total_turnover', label: '总成交额', unit: '元' },
    { key: 'year_volume', label: '年累计成交量', unit: '吨' },
    { key: 'year_turnover', label: '年累计成交额', unit: '元' },
    { key: 'lifetime_volume', label: '历史累计成交量', unit: '吨' },
    { key: 'lifetime_turnover', label: '历史累计成交额', unit: '元' },
    { key: 'session_state', label: '交易日状态', definition: 'traded 有成交 / no_trade 有交易日无成交 / missing 数据暂缺' },
    { key: 'check_status', label: '确定性核对', definition: 'pass/warn/fail；只标注，不改写官方数值' },
    { key: 'verification_status', label: 'AI 证据一致性', definition: 'unverified/verified/insufficient/conflict/unavailable；不覆盖官方数值' },
    { key: 'revision', label: '修订次数' },
    { key: 'fetched_at', label: '抓取时间' },
    { key: 'source_url', label: '来源 URL' },
  ],
  entities: [
    { key: 'name', label: '企业名称' },
    { key: 'credit_code', label: '统一社会信用代码', definition: '空=公开名录未披露' },
    { key: 'province', label: '省份' },
    { key: 'city', label: '城市' },
    { key: 'sector', label: '行业' },
    { key: 'list_year', label: '名录年度' },
    { key: 'status', label: '名录状态', definition: 'new/existing/exit/unknown' },
    { key: 'data_as_of', label: '数据截止日' },
    { key: 'verify_status', label: '核验状态' },
    { key: 'source_url', label: '来源 URL' },
  ],
  intentions: [
    { key: 'published_date', label: '发布日期' },
    { key: 'instrument_label', label: '品种标注（原文）' },
    { key: 'quota_year', label: '配额年度' },
    { key: 'direction', label: '方向', definition: 'buy/sell/unknown' },
    { key: 'volume', label: '数量', unit: '吨' },
    { key: 'price', label: '价格', unit: '元/吨', definition: '空=未公开，不用 0 代替' },
    { key: 'participant', label: '主体', definition: '空=未公开' },
    { key: 'source_url', label: '来源 URL' },
    { key: 'note', label: '备注', definition: '意向不等于成交，不计入成交量/成交额' },
  ],
  documents: [
    { key: 'title', label: '标题' },
    { key: 'doc_type', label: '类型', definition: 'policy/technical/research/news' },
    { key: 'category', label: '分类' },
    { key: 'doc_number', label: '文号' },
    { key: 'issuer', label: '发布机关' },
    { key: 'publish_date', label: '印发日期' },
    { key: 'effective_date', label: '施行日期' },
    { key: 'doc_status', label: '效力状态', definition: 'formal/draft/consultation/historical/superseded' },
    { key: 'applicable_years', label: '适用年度' },
    { key: 'covered_sectors', label: '覆盖行业' },
    { key: 'evidence_level', label: '证据等级', definition: 'full_text/partial/abstract_only/metadata_only' },
    { key: 'ai_status', label: 'AI 证据一致性' },
    { key: 'official_url', label: '官方 URL' },
  ],
  events: [
    { key: 'title', label: '事件' },
    { key: 'event_type', label: '类型' },
    { key: 'deadline', label: '执行日期' },
    { key: 'emission_year', label: '排放年度' },
    { key: 'quota_year', label: '配额年度' },
    { key: 'list_year', label: '名录年度' },
    { key: 'date_extract_status', label: '日期提取状态' },
    { key: 'date_verify_status', label: '日期核验状态' },
    { key: 'source_url', label: '来源 URL' },
  ],
  research: [
    { key: 'title', label: '标题' },
    { key: 'doc_type', label: '类型', definition: 'research 研究 / news 行业动态' },
    { key: 'issuer', label: '机构', definition: '空=来源未标注（不推测）' },
    { key: 'publish_date', label: '发布日期', definition: '空=来源未标注' },
    { key: 'data_cutoff_date', label: '数据截止日', definition: '按原文精度记录：day=YYYY-MM-DD / month=YYYY-MM / year=YYYY；空=未标注，绝不补造具体日' },
    { key: 'data_cutoff_precision', label: '截止日精度', definition: 'day|month|year（原文只到月/年时不生成具体日）' },
    { key: 'data_cutoff_raw', label: '截止日原文', definition: '正文原文片段，可追溯' },
    { key: 'viewpoint', label: '观点标记', definition: 'research_opinion 观点 / market_news 动态' },
    { key: 'first_source', label: '公开第一来源', definition: '空=原始出处未确认（聚合/转载站不冒充第一来源）' },
    { key: 'page_url', label: '本条页面 URL', definition: '实际抓取的页面地址；与公开第一来源分开记录' },
    { key: 'evidence_level', label: '证据等级', definition: '入库要求 full_text（真实取得的正文）' },
    { key: 'ai_status', label: 'AI 证据一致性' },
    { key: 'fetched_at', label: '抓取时间' },
  ],
  price_history: [
    { key: 'trade_date', label: '日期' },
    { key: 'open', label: '开盘价', unit: '元/吨' },
    { key: 'high', label: '最高价', unit: '元/吨' },
    { key: 'low', label: '最低价', unit: '元/吨' },
    { key: 'close', label: '收盘价', unit: '元/吨' },
    { key: 'volume_reference', label: '参考数量', unit: '吨', definition: '来源历史序列的参考数量，**不是**全国全方式成交量；不据此计算成交额/均价' },
    { key: 'price_regime', label: '报价口径', definition: '来源历史序列（CEA_HISKLINE），与 2026 版编制方案区分' },
    { key: 'source_url', label: '来源 URL' },
    { key: 'snapshot_id', label: '来源快照' },
    { key: 'fetched_at', label: '抓取时间' },
  ],
  calendar: [
    { key: 'trade_date', label: '日期' },
    { key: 'effective_state', label: '综合结论', definition: '按「正式公告 > 实际成交 > 机器辅助列表」给出' },
    { key: 'actual_trades', label: '当日有成交' },
    { key: 'machine_holiday', label: '机器辅助列表=休市' },
    { key: 'notice_holiday', label: '正式公告=休市' },
    { key: 'notice_open', label: '正式公告=开市' },
    { key: 'anomaly', label: '来源异常', definition: '机器列表与实际成交/正式公告矛盾时的独立告警说明' },
  ],
};

export function ceaExportRows(dataset, filters = {}) {
  const cols = CEA_EXPORT_COLUMNS[dataset];
  if (!cols) return { error: `不支持的 CEA 数据集：${dataset}（可选：${Object.keys(CEA_EXPORT_COLUMNS).join('/')}）`, status: 400 };
  let rows = [];
  let meta = {};
  if (dataset === 'trade') {
    const out = listCeaTradeDaily({ ...filters, limit: 2000 });
    rows = out.rows.slice().reverse();
    meta = {
      数据截至: out.data_as_of || '（暂无行情）',
      口径: 'CEA 独立行情；官方综合收盘价与全方式计算均价分列；缺失交易日不补 0',
      来源: '官方来源 URL 见 source_url 列',
    };
  } else if (dataset === 'entities') {
    const out = listCeaEntities({ ...filters, limit: 1000 });
    rows = out.rows;
    meta = { 数据截至: rows[0]?.data_as_of || '（暂无名录数据）', 说明: '名录数量不等于买家数量' };
  } else if (dataset === 'intentions') {
    const out = listCeaIntentions({ ...filters, limit: 1000 });
    rows = out.rows;
    meta = { 说明: '公开交易意向不等于成交，不计入成交量/成交额' };
  } else if (dataset === 'documents') {
    rows = listCeaDocuments({ ...filters, limit: 500 }).rows;
    meta = { 说明: '政策/技术/研报分类归档；metadata_only 表示尚未取得原文' };
  } else if (dataset === 'events') {
    rows = listCeaEvents({ ...filters, limit: 500 }).rows;
    meta = { 说明: '排放年度/配额年度/名录年度分列；日期未核验的条目见 date_verify_status' };
  } else if (dataset === 'research') {
    rows = listCeaResearch({ ...filters, limit: 200 }).rows;
    meta = { 说明: '研报与行业动态：第一来源/机构/发布日期/数据截止日/观点标记；观点不作为现行规则' };
  } else if (dataset === 'price_history') {
    const out = listCeaPriceHistory({ from: filters.from || null, to: filters.to || null, limit: 2000 });
    rows = out.rows;
    meta = {
      说明: '来源历史价格序列（hiskline）：参考数量不是全国全方式成交量；无成交额与全方式均价列',
      区间: `${out.earliest || '—'} ~ ${out.latest || '—'}`,
    };
  } else if (dataset === 'calendar') {
    const layered = ceaCalendarLayered({ from: filters.from || null, to: filters.to || null, limit: 2000 });
    rows = layered.rows.map((r) => ({
      trade_date: r.trade_date,
      effective_state: r.effective_state,
      actual_trades: r.actual_trades ? '是' : '否',
      machine_holiday: r.layers.holidays_json?.day_type === 'holiday' ? '是' : '否',
      notice_holiday: r.layers.official_notice?.day_type === 'holiday' ? '是' : '否',
      notice_open: r.layers.official_notice_open?.day_type === 'trading' ? '是' : '否',
      anomaly: r.anomaly ? r.anomaly.detail : '',
    }));
    meta = { 说明: '三层日历证据（正式公告/机器辅助列表/实际成交）分开导出，异常单独成列' };
  }
  const flat = rows.map((r) => {
    const o = {};
    for (const c of cols) {
      const v = r[c.key];
      o[c.key] = Array.isArray(v) ? v.join('、') : v === undefined ? null : v;
    }
    return o;
  });
  return { columns: cols, rows: flat, meta };
}
