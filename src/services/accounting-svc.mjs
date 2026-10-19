/**
 * 公开碳核算资料服务（docs/39 第 1、5 条）
 * ============================================================================
 * 职责：来源登记 / 排放因子 / 标准规范 / 中碳登清结算日报的**读取**与幂等 seed，
 *       以及与 CEA 同日量额的交叉核对（只读 CEA，绝不合并、绝不相加）。
 *
 * 边界（与 docs/39 完全一致）：
 *   1. 只读公开资料；不写 v1 正式 CCER 因子，不解除 33 条历史门禁，
 *      这里的通用电力因子**不会**被当作 CCER 区域电网基准线因子使用；
 *   2. 与 CEA / CCER 主行情同日数据只做**对照**：两方原值都保留，不求和、不覆盖，
 *      中碳登的累计成交量也不写成「CCER 累计成交量」；
 *   3. 「自愿注销公示」与交易/履约清缴分开，公示量不计入成交量；
 *   4. seed 只写来源登记、规范元数据与已核实静态值（附原件哈希与页码），
 *      **不写任何抓取成功状态与模型核验结论**（一律 registered / unavailable）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { all, get, run, getDb, dbPath, metaValue, setMeta, audit } from '../core/db.mjs';
import { newId, nowIso, j, uj } from '../core/util.mjs';
import {
  ACCOUNTING_SOURCES, ELECTRICITY_FACTORS_2023, ELECTRICITY_FACTOR_SOURCE,
  ACCOUNTING_STANDARDS, CRC_DAILY_SAMPLE, SOURCE_GAPS, ELECTRICITY_CATEGORIES,
} from '../data/accounting-originals.mjs';

export const ACCOUNTING_SCHEMA_VERSION = '2.4.0';

/** 原件落盘根：与**当前数据库同级**的 official-originals/accounting（测试库不会污染项目 data）。 */
export function accountingRoot() {
  return join(dirname(dbPath()), 'official-originals', 'accounting');
}

export function ensureAccountingRoot() {
  const p = accountingRoot();
  mkdirSync(p, { recursive: true });
  return p;
}

/* ==================================================================== */
/*  一、seed（幂等）                                                    */
/* ==================================================================== */

export const ACCOUNTING_SEED_KEY = 'accounting_seed_v2';

function upsertSource(s) {
  const now = nowIso();
  const existing = get('SELECT id FROM accounting_source WHERE code = ?', [s.code]);
  const domains = j(s.allowed_domains || []);
  if (existing) {
    // 只更新「登记类」字段；**不覆盖** last_* / status（抓取状态只能由真实抓取写入）
    run(
      `UPDATE accounting_source SET name=?, url=?, authority=?, allowed_domains=?, source_type=?,
         category=?, fetch_kind=?, cets_relation=COALESCE(?, cets_relation), status_note=COALESCE(?, status_note),
         updated_at=? WHERE code=?`,
      [s.name, s.url, s.authority || null, domains, s.source_type, s.category,
        s.fetch_kind || null, s.cets_relation || null, s.note || null, now, s.code]
    );
    return { code: s.code, inserted: false };
  }
  run(
    `INSERT INTO accounting_source
      (id, code, name, url, authority, allowed_domains, source_type, category, fetch_kind,
       cets_relation, enabled, status, status_note, collected_count, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [newId('ACCSRC'), s.code, s.name, s.url, s.authority || null, domains, s.source_type, s.category,
      s.fetch_kind || null, s.cets_relation || null, 1, 'registered', s.note || null, 0, now, now]
  );
  return { code: s.code, inserted: true };
}

function upsertFactor(row) {
  const now = nowIso();
  const identity = [
    row.source_code, row.category, row.region || '全国', row.data_year, row.version,
  ].join('|');
  const sourceIdentity = [row.original_url, row.page_physical ?? '-', row.locator || '-'].join('#');
  const existing = get('SELECT id FROM emission_factor WHERE identity_key = ?', [identity]);
  const src = get('SELECT id FROM accounting_source WHERE code = ?', [row.source_code]);
  if (existing) {
    run(
      `UPDATE emission_factor SET name=?, value=?, original_unit=?, standard_unit=?, gas=?, caliber=?,
         region=?, region_level=?, industry=?, data_year=?, publish_date=?, version=?, applicability=?,
         page_physical=?, page_printed=?, locator=?, original_url=?, original_sha256=?, evidence_level=?,
         metadata_origin=?, source_identity=?, source_id=COALESCE(?, source_id), updated_at=?
       WHERE identity_key=?`,
      [row.name, row.value, row.original_unit, row.standard_unit || null, row.gas, row.caliber,
        row.region || null, row.region_level || null, row.industry || null, row.data_year,
        row.publish_date || null, row.version, row.applicability || null,
        row.page_physical ?? null, row.page_printed || null, row.locator || null,
        row.original_url, row.original_sha256 || null, row.evidence_level || 'metadata_only',
        row.metadata_origin || null, sourceIdentity, src?.id || null, now, identity]
    );
    return { identity_key: identity, inserted: false };
  }
  run(
    `INSERT INTO emission_factor
      (id, identity_key, source_identity, source_id, source_code, name, value, original_unit, standard_unit,
       conversion_factor, conversion_note, gas, category, caliber, region, region_level, industry,
       data_year, publish_date, effective_date, version, applicability, page_physical, page_printed,
       locator, original_url, original_sha256, snapshot_path, evidence_level, model_verify_status,
       is_current, metadata_origin, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [newId('EF'), identity, sourceIdentity, src?.id || null, row.source_code, row.name, row.value,
      row.original_unit, row.standard_unit || null, row.conversion_factor ?? null, row.conversion_note || null,
      row.gas, row.category, row.caliber, row.region || null, row.region_level || null, row.industry || null,
      row.data_year, row.publish_date || null, row.effective_date || null, row.version,
      row.applicability || null, row.page_physical ?? null, row.page_printed || null, row.locator || null,
      row.original_url, row.original_sha256 || null, null, row.evidence_level || 'metadata_only',
      // 未经真实模型核验：一律 unavailable，绝不 seed 成 verified
      'unavailable', 1, row.metadata_origin || null, now, now]
  );
  return { identity_key: identity, inserted: true };
}

function upsertStandard(s) {
  const now = nowIso();
  const identity = s.code || `${s.announcement_url}#${s.original_url || s.title}`;
  const src = get('SELECT id FROM accounting_source WHERE code = ?', [s.announcement_code]);
  const existing = get('SELECT * FROM accounting_standard WHERE identity_key = ?', [identity]);
  const keepBody = existing?.body_text && (!s.body_status || s.body_status==='metadata_only');
  const cols = [
    s.code || null, s.title, s.issuer || null, s.sector || null, s.standard_type, s.status,
    s.version || null, s.publish_date || null, s.issue_date || null, s.effective_year ?? null,
    s.applicable_years ? j(s.applicable_years) : null, s.applicability || null,
    s.announcement_url || null, s.original_url || null,
    keepBody ? existing.body_status : (s.body_status || 'metadata_only'), keepBody ? existing.sha256 : (s.sha256 || null), s.pages_total ?? existing?.pages_total ?? null, keepBody ? existing.chars : (s.chars ?? null),
    src?.id || null, s.source_locator || null, s.replaces_code || null,
    s.related_codes ? j(s.related_codes) : null, s.cets_relation || null, s.metadata_origin || null,
  ];
  if (existing) {
    run(
      `UPDATE accounting_standard SET code=?, title=?, issuer=?, sector=?, standard_type=?, status=?,
         version=?, publish_date=?, issue_date=?, effective_year=?, applicable_years=?, applicability=?,
         announcement_url=?, original_url=?, body_status=?, sha256=?, pages_total=?, chars=?,
         source_id=COALESCE(?, source_id), source_locator=?, replaces_code=?, related_codes=?,
         cets_relation=?, metadata_origin=?, updated_at=?
       WHERE identity_key=?`,
      [...cols, now, identity]
    );
    return { identity_key: identity, inserted: false };
  }
  run(
    `INSERT INTO accounting_standard
      (id, identity_key, code, title, issuer, sector, standard_type, status, version, publish_date, issue_date,
       effective_year, applicable_years, applicability, announcement_url, original_url, body_status, sha256,
       pages_total, chars, source_id, source_locator, replaces_code, related_codes, cets_relation,
       metadata_origin, model_verify_status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [newId('STD'), identity, ...cols, 'unavailable', now, now]
  );
  return { identity_key: identity, inserted: true };
}

function seedCrcDaily(sample, { actor = 'system:seed' } = {}) {
  const now = nowIso();
  const src = get('SELECT id FROM accounting_source WHERE code = ?', [sample.source_code]);
  const existing = get(
    'SELECT * FROM crc_clearing_daily WHERE source_code=? AND trade_date=? AND scope=? AND revision_no=1',
    [sample.source_code, sample.trade_date, sample.scope]
  );
  const derived = sample.daily_volume_t && sample.daily_amount_yuan
    ? sample.daily_amount_yuan / sample.daily_volume_t : null;
  let id;
  if (existing) {
    // 同源同日同口径同修订号：只补齐空字段，不改写已有值（修订走新 revision_no）
    id = existing.id;
    run(
      `UPDATE crc_clearing_daily SET title=COALESCE(title,?), published_at=COALESCE(published_at,?),
         daily_volume_t=COALESCE(daily_volume_t,?), daily_amount_yuan=COALESCE(daily_amount_yuan,?),
         daily_avg_price_published=COALESCE(daily_avg_price_published,?),
         daily_avg_price_derived=COALESCE(daily_avg_price_derived,?),
         avg_price_origin=COALESCE(avg_price_origin,?), cumulative_volume_t=COALESCE(cumulative_volume_t,?),
         cumulative_amount_yuan=COALESCE(cumulative_amount_yuan,?),
         content_hash=COALESCE(content_hash,?), parse_note=COALESCE(parse_note,?), updated_at=?
       WHERE id=?`,
      [sample.title || null, sample.published_at || null, sample.daily_volume_t ?? null,
        sample.daily_amount_yuan ?? null, sample.daily_avg_price_published ?? null, derived,
        sample.daily_avg_price_published !== null && sample.daily_avg_price_published !== undefined ? 'published' : derived !== null ? 'derived' : 'none',
        sample.cumulative_volume_t ?? null, sample.cumulative_amount_yuan ?? null,
        sample.content_hash || null, sample.parse_note || null, now, id]
    );
  } else {
    id = newId('CRCD');
    run(
      `INSERT INTO crc_clearing_daily
        (id, source_id, source_code, detail_url, title, trade_date, published_at, daily_volume_t,
         daily_amount_yuan, daily_avg_price_published, daily_avg_price_derived, avg_price_origin,
         cumulative_volume_t, cumulative_amount_yuan, caliber, scope, snapshot_path, content_hash,
         revision_of, revision_no, is_current, parse_note, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, src?.id || null, sample.source_code, sample.url, sample.title || null, sample.trade_date,
        sample.published_at || null, sample.daily_volume_t ?? null, sample.daily_amount_yuan ?? null,
        sample.daily_avg_price_published ?? null, derived,
        sample.daily_avg_price_published !== null && sample.daily_avg_price_published !== undefined ? 'published' : derived !== null ? 'derived' : 'none',
        sample.cumulative_volume_t ?? null, sample.cumulative_amount_yuan ?? null,
        sample.caliber, sample.scope, null, sample.content_hash || null, null, 1, 1,
        sample.parse_note || null, now, now]
    );
  }
  if (sample.components?.length && !get('SELECT id FROM crc_clearing_component WHERE daily_id=? LIMIT 1', [id])) {
    for (const c of sample.components) {
      run(
        `INSERT INTO crc_clearing_component
          (id, daily_id, year_label, trade_method, is_subtotal, daily_volume_t, daily_amount_yuan,
           cumulative_volume_t, cumulative_amount_yuan, counts_to_total, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [newId('CRCC'), id, c.year_label, c.trade_method, c.is_subtotal ?? 0,
          c.daily_volume_t ?? null, c.daily_amount_yuan ?? null,
          c.cumulative_volume_t ?? null, c.cumulative_amount_yuan ?? null,
          c.counts_to_total ?? 0, now]
      );
    }
  }
  return { id, inserted: !existing };
}

/**
 * 幂等 seed：来源登记 + 规范元数据 + 已核实静态数值（电力因子 40 行）+ CRC 日报样本。
 * 可重复调用；不产生重复行，也不覆盖真实抓取写入的状态字段。
 */
export function seedAccountingBase({ withStaticValues = true, actor = 'system:seed' } = {}) {
  const now = nowIso();
  const summary = { sources: 0, factors: 0, standards: 0, crc_daily: 0, skipped_values: !withStaticValues };
  for (const s of ACCOUNTING_SOURCES) {
    const r = upsertSource(s);
    if (r.inserted) summary.sources += 1;
  }
  if (withStaticValues) {
    for (const f of ELECTRICITY_FACTORS_2023) {
      const r = upsertFactor(f);
      if (r.inserted) summary.factors += 1;
    }
    const crc = seedCrcDaily(CRC_DAILY_SAMPLE, { actor });
    summary.crc_daily += 1;
    summary.crc_daily_id = crc.id;
  }
  for (const s of ACCOUNTING_STANDARDS) {
    const r = upsertStandard(s);
    if(s.sha256)run('UPDATE accounting_standard SET official_sha256=COALESCE(official_sha256,?),full_text_available=1 WHERE identity_key=?',[s.sha256,r.identity_key]);
    if (s.source_kind) run('UPDATE accounting_standard SET source_kind=?,published_status=?,effective_date=?,full_text_available=? WHERE identity_key=?',[s.source_kind,s.published_status,s.effective_date,s.full_text_available?1:0,r.identity_key]);
    if (r.inserted) summary.standards += 1;
  }
  setMeta(getDb(), ACCOUNTING_SEED_KEY, now);
  audit({
    actor, actorRole: 'system', action: 'accounting.seed', objectType: 'accounting_seed',
    detail: summary,
  });
  return { ok: true, seeded_at: now, ...summary };
}

/** 首次读取时自动补齐基础资料（幂等；不触发任何网络请求）。 */
export function ensureAccountingSeeded() {
  if (metaValue(ACCOUNTING_SEED_KEY, null)) return { ok: true, already: true };
  return seedAccountingBase();
}

export function accountingSeeded() {
  return !!metaValue(ACCOUNTING_SEED_KEY, null);
}

/* ==================================================================== */
/*  二、来源登记                                                        */
/* ==================================================================== */

function sourcePublic(r) {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    url: r.url,
    authority: r.authority,
    allowed_domains: uj(r.allowed_domains, []) || [],
    source_type: r.source_type,
    category: r.category,
    fetch_kind: r.fetch_kind,
    cets_relation: r.cets_relation,
    status: r.status,
    status_note: r.status_note,
    blocked_kind: r.blocked_kind || null,
    enabled: !!r.enabled,
    last_attempt_at: r.last_attempt_at,
    last_success_at: r.last_success_at,
    last_http_status: r.last_http_status,
    last_error: r.last_error,
    last_url: r.last_url,
    last_page_url: r.last_page_url,
    last_content_hash: r.last_content_hash,
    last_content_bytes: r.last_content_bytes,
    last_file_path: r.last_file_path,
    collected_count: r.collected_count,
    updated_at: r.updated_at,
  };
}

export function listSources({ category = null, status = null, q = null, limit = 200 } = {}) {
  const where = [];
  const params = [];
  if (category) { where.push('category = ?'); params.push(category); }
  if (status) { where.push('status = ?'); params.push(status); }
  if (q) { where.push('(name LIKE ? OR url LIKE ? OR status_note LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const rows = all(
    `SELECT * FROM accounting_source ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY category, code LIMIT ?`,
    [...params, Math.min(Number(limit) || 200, 500)]
  );
  return rows.map(sourcePublic);
}

export function getSource(code) {
  const r = get('SELECT * FROM accounting_source WHERE code = ? OR id = ?', [String(code), String(code)]);
  return r ? sourcePublic(r) : null;
}

/** 采集预算/调度配置（管理员可改）。 */
export const ACCOUNTING_DEFAULT_CONFIG = {
  /** 单批总预算（毫秒）——需求：单批 ≤ 120 秒 */
  batch_budget_ms: 120000,
  /** 单源最多发现的详情页数 */
  max_details_per_source: 6,
  /** 单次最多下载的 PDF 数 */
  max_pdfs_per_run: 8,
  /** 单个 PDF 最多解析页数 */
  max_pages_per_pdf: 60,
  /** 每日自动采集的详情页数上限 */
  daily_details: 6,
  /** 是否对新增正文做模型一致性核验 */
  verify_with_model: true,
};

const CFG_KEY = 'accounting_config_v1';

export function accountingConfig() {
  const saved = uj(metaValue(CFG_KEY, null), {}) || {};
  return { ...ACCOUNTING_DEFAULT_CONFIG, ...saved };
}

export function saveAccountingConfig(user, patch = {}) {
  if (user?.role !== 'admin') return { error: '仅管理员可配置碳核算资料采集', status: 403 };
  const next = { ...accountingConfig() };
  const intRange = (v, min, max) => Number.isInteger(Number(v)) && Number(v) >= min && Number(v) <= max;
  for (const [key, min, max] of [
    ['batch_budget_ms', 5000, 600000],
    ['max_details_per_source', 1, 50],
    ['max_pdfs_per_run', 0, 50],
    ['max_pages_per_pdf', 1, 500],
    ['daily_details', 0, 100],
  ]) {
    if (patch[key] === undefined) continue;
    if (!intRange(patch[key], min, max)) {
      return { error: `${key} 须为 ${min}—${max} 的整数`, status: 400 };
    }
    next[key] = Number(patch[key]);
  }
  if (patch.verify_with_model !== undefined) next.verify_with_model = patch.verify_with_model === true;
  if (next.batch_budget_ms > 120000) {
    // 需求硬约束：单批 ≤ 120 秒（允许更小，不允许更大）
    return { error: 'batch_budget_ms 不得超过 120000（需求：单批 ≤120 秒）', status: 400 };
  }
  setMeta(getDb(), CFG_KEY, j(next));
  audit({ actor: user.name || user.id, actorRole: 'admin', action: 'accounting.config', objectType: 'system_meta', objectId: CFG_KEY, detail: next });
  return { ok: true, config: next };
}

/** 来源状态汇总 + 缺口（供界面与健康接口）。 */
export function accountingStatus() {
  const src = all('SELECT category, status, COUNT(*) AS c FROM accounting_source GROUP BY category, status');
  const counts = {
    sources: get('SELECT COUNT(*) AS c FROM accounting_source')?.c || 0,
    factors: get('SELECT COUNT(*) AS c FROM emission_factor WHERE is_current=1')?.c || 0,
    factors_total: get('SELECT COUNT(*) AS c FROM emission_factor')?.c || 0,
    standards: get('SELECT COUNT(*) AS c FROM accounting_standard')?.c || 0,
    standards_with_body: get("SELECT COUNT(*) AS c FROM accounting_standard WHERE body_status IN ('full','partial')")?.c || 0,
    crc_daily: get('SELECT COUNT(*) AS c FROM crc_clearing_daily')?.c || 0,
    crc_latest_date: get('SELECT MAX(trade_date) AS d FROM crc_clearing_daily')?.d || null,
    public_documents: get('SELECT COUNT(*) c FROM accounting_public_document WHERE is_current=1')?.c||0,
    public_qa: get('SELECT COUNT(*) c FROM accounting_public_qa q JOIN accounting_public_document d ON d.id=q.document_id WHERE d.is_current=1')?.c||0,
    standards_full: get("SELECT COUNT(*) c FROM accounting_standard WHERE body_status='full'")?.c||0,
    blocked_sources: get("SELECT COUNT(*) AS c FROM accounting_source WHERE status='blocked'")?.c || 0,
  };
  const gaps = [];
  for (const g of SOURCE_GAPS) {
    const s = get('SELECT code, status, status_note FROM accounting_source WHERE code=?', [g.code]);
    if (s && s.status !== 'ok') gaps.push({ ...g, source_status: s.status, source_note: s.status_note });
  }
  for(const source of all("SELECT code,name,status,last_error,status_note FROM accounting_source WHERE status IN ('blocked','error','stale')")){
    if(!gaps.some(g=>g.code===source.code))gaps.push({code:source.code,kind:'source_unavailable',source_status:source.status,note:`${source.name}：${source.last_error||source.status_note||'来源暂不可用'}；保留已取得资料并在后续批次自动重试。`});
  }
  // 规范仍有缺正文的：如实列为缺口（不假装已取得全文）
  for (const s of all("SELECT code, title, sector, original_url, body_status FROM accounting_standard WHERE body_status='metadata_only' ORDER BY sector, code")) {
    const label = /^《.*》$/.test(s.title) ? s.title : `《${s.title}》`;
    gaps.push({
      code: s.code || s.title,
      kind: 'standard_body_missing',
      note: `${label}尚未取得正文（仅元数据）；原件地址 ${s.original_url}。可由管理员上传 PDF 后自动解析并交模型核对。`,
    });
  }
  return {
    seeded: accountingSeeded(),
    schema_version: ACCOUNTING_SCHEMA_VERSION,
    config: accountingConfig(),
    counts,
    by_source: src.map((r) => ({ category: r.category, status: r.status, count: r.c })),
    gaps,
    roots: { accounting_originals: accountingRoot() },
    notes: [
      '本库的电力 CO2 因子用于外购电力排放参考计算；不是产品全生命周期碳足迹因子，也不是 CCER 区域电网基准线因子。',
      '中碳登清结算数据与 CEA 行情分列两方原值，不同来源的同日市场量额不做相加。',
      '自愿注销公示量与交易/履约清缴分开，公示量不计入成交量。',
    ],
  };
}

/* ==================================================================== */
/*  三、排放因子                                                        */
/* ==================================================================== */

export const FACTOR_CATEGORY_LABELS = Object.fromEntries(
  Object.entries(ELECTRICITY_CATEGORIES).map(([k, v]) => [k, v.label])
);

function factorPublic(r) {
  return {
    id: r.id,
    source_code: r.source_code,
    name: r.name,
    value: r.value,
    original_unit: r.original_unit,
    standard_unit: r.standard_unit,
    conversion_note: r.conversion_note,
    gas: r.gas,
    category: r.category,
    category_label: FACTOR_CATEGORY_LABELS[r.category] || r.category,
    caliber: r.caliber,
    region: r.region,
    region_level: r.region_level,
    industry: r.industry,
    data_year: r.data_year,
    publish_date: r.publish_date,
    version: r.version,
    applicability: r.applicability,
    page_physical: r.page_physical,
    page_printed: r.page_printed,
    locator: r.locator,
    original_url: r.original_url,
    original_sha256: r.original_sha256,
    snapshot_path: r.snapshot_path,
    evidence_level: r.evidence_level,
    model_verify_status: r.model_verify_status,
    model_verify_at: r.model_verify_at,
    is_current: !!r.is_current,
    supersedes_id: r.supersedes_id,
    superseded_by_id: r.superseded_by_id,
    metadata_origin: r.metadata_origin,
    updated_at: r.updated_at,
    /** 界面「可计算性」标记：能被碳排放计算选用 */
    calculable: r.gas === 'CO2' && !!r.standard_unit && Number.isFinite(r.value) && r.value > 0,
  };
}

function factorWhere(f = {}) {
  const where = [];
  const params = [];
  if (f.data_year) { where.push('data_year = ?'); params.push(Number(f.data_year)); }
  if (f.category) { where.push('category = ?'); params.push(String(f.category)); }
  if (f.region) { where.push('region = ?'); params.push(String(f.region)); }
  if (f.region_level) { where.push('region_level = ?'); params.push(String(f.region_level)); }
  if (f.gas) { where.push('gas = ?'); params.push(String(f.gas)); }
  if (f.current_only !== false) where.push('is_current = 1');
  if (f.q) {
    where.push('(name LIKE ? OR caliber LIKE ? OR region LIKE ? OR applicability LIKE ?)');
    const like = `%${f.q}%`;
    params.push(like, like, like, like);
  }
  return { clause: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}

export function listFactors(f = {}) {
  const { clause, params } = factorWhere(f);
  const limit = Math.min(Number(f.limit) || 200, 1000);
  const offset = Math.max(0, Number(f.offset) || 0);
  const total = get(`SELECT COUNT(*) AS c FROM emission_factor ${clause}`, params)?.c || 0;
  const rows = all(
    `SELECT * FROM emission_factor ${clause}
     ORDER BY data_year DESC, CASE category WHEN 'national_average' THEN 0 WHEN 'regional_average' THEN 1
       WHEN 'provincial_average' THEN 2 WHEN 'national_excl_market_nonfossil' THEN 3 ELSE 4 END,
       region IS NULL DESC, region LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return { total, rows: rows.map(factorPublic), limit, offset };
}

export function getFactor(id) {
  const r = get('SELECT * FROM emission_factor WHERE id = ? OR identity_key = ?', [String(id), String(id)]);
  if (!r) return null;
  const out = factorPublic(r);
  out.versions = all(
    `SELECT id, version, data_year, value, is_current, evidence_level, publish_date, updated_at
     FROM emission_factor WHERE source_code=? AND category=? AND COALESCE(region,'')=COALESCE(?,'')
     ORDER BY data_year DESC, version DESC`,
    [r.source_code, r.category, r.region]
  );
  out.source = getSource(r.source_code);
  return out;
}

/** 筛选可选值（地区 / 年度 / 口径 / 类别）。 */
export function factorFacets() {
  return {
    data_years: all('SELECT DISTINCT data_year FROM emission_factor WHERE is_current=1 ORDER BY data_year DESC').map((r) => r.data_year),
    categories: all('SELECT DISTINCT category FROM emission_factor WHERE is_current=1').map((r) => ({
      key: r.category, label: FACTOR_CATEGORY_LABELS[r.category] || r.category,
    })),
    regions: all(
      "SELECT DISTINCT region, region_level FROM emission_factor WHERE is_current=1 AND region IS NOT NULL ORDER BY region_level, region"
    ).map((r) => ({ region: r.region, region_level: r.region_level })),
    gases: all('SELECT DISTINCT gas FROM emission_factor WHERE is_current=1').map((r) => r.gas),
    units: all('SELECT DISTINCT original_unit FROM emission_factor WHERE is_current=1').map((r) => r.original_unit),
  };
}

/**
 * 计算可选因子清单（供碳排放计算页显式选择）。
 * **不做任何静默回落**：选择区域/省份时只返回该地区因子，取不到就返回空并说明原因。
 */
export function selectableFactors({ data_year = null, category = null, region = null } = {}) {
  const { clause, params } = factorWhere({
    data_year, category, region: region || null, current_only: true, gas: 'CO2',
  });
  const rows = all(
    `SELECT * FROM emission_factor ${clause} AND standard_unit IS NOT NULL AND value > 0
     ORDER BY data_year DESC, region IS NULL DESC, region`,
    params
  ).map(factorPublic);
  return rows;
}

/* ==================================================================== */
/*  四、标准与技术规范                                                  */
/* ==================================================================== */

export const STANDARD_TYPE_LABELS = {
  accounting: '核算与报告指南', verification: '核查技术指南', update_note: '技术要求更新说明', policy: '政策文件',
};
export const STANDARD_STATUS_LABELS = {
  formal: '现行正式', draft: '草案', consultation: '征求意见稿', historical: '历史文件', superseded: '已被替代',
};
export const BODY_STATUS_LABELS = {
  full: '已取得全文', partial: '部分正文', metadata_only: '仅元数据（未取得正文）',
};

function standardPublic(r) {
  return {
    id: r.id,
    code: r.code,
    title: r.title,
    issuer: r.issuer,
    sector: r.sector,
    standard_type: r.standard_type,
    standard_type_label: STANDARD_TYPE_LABELS[r.standard_type] || r.standard_type,
    status: r.status,
    status_label: STANDARD_STATUS_LABELS[r.status] || r.status,
    version: r.version,
    publish_date: r.publish_date,
    issue_date: r.issue_date,
    effective_year: r.effective_year,
    applicable_years: uj(r.applicable_years, null),
    applicability: r.applicability || null,
    announcement_url: r.announcement_url,
    original_url: r.original_url,
    body_status: r.body_status,
    body_status_label: BODY_STATUS_LABELS[r.body_status] || r.body_status,
    body_chars: r.body_text ? String(r.body_text).length : 0,
    sha256: r.sha256,
    pages_total: r.pages_total,
    chars: r.chars,
    source_locator: r.source_locator,
    model_verify_status: r.model_verify_status,
    model_verify_at: r.model_verify_at,
    replaces_code: r.replaces_code,
    related_codes: uj(r.related_codes, null),
    cets_relation: r.cets_relation,
    source_kind:r.source_kind,published_status:r.published_status,effective_date:r.effective_date,full_text_available:!!r.full_text_available,pages_read:r.pages_read,extraction_complete:!!r.extraction_complete,body_origin:r.body_origin,
    metadata_origin: r.metadata_origin,
    updated_at: r.updated_at,
  };
}

export function listStandards({ sector = null, status = null, standard_type = null, q = null, limit = 200 } = {}) {
  const where = [];
  const params = [];
  if (sector) { where.push('sector = ?'); params.push(sector); }
  if (status) { where.push('status = ?'); params.push(status); }
  if (standard_type) { where.push('standard_type = ?'); params.push(standard_type); }
  if (q) {
    where.push('(title LIKE ? OR code LIKE ? OR source_locator LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  const rows = all(
    `SELECT * FROM accounting_standard ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY sector, status, code LIMIT ?`,
    [...params, Math.min(Number(limit) || 200, 500)]
  );
  return { total: rows.length, rows: rows.map(standardPublic) };
}

export function getStandard(id) {
  const r = get('SELECT * FROM accounting_standard WHERE id = ? OR identity_key = ? OR code = ?',
    [String(id), String(id), String(id)]);
  if (!r) return null;
  const out = standardPublic(r);
  out.body_text = r.body_text || null;
  out.source = r.source_id ? getSource(r.source_id) : null;
  out.versions = all(
    'SELECT id, code, version, status, publish_date, body_status FROM accounting_standard WHERE sector=? ORDER BY publish_date DESC',
    [r.sector]
  );
  return out;
}

export function standardFacets() {
  return {
    sectors: all('SELECT DISTINCT sector FROM accounting_standard WHERE sector IS NOT NULL ORDER BY sector').map((r) => r.sector),
    statuses: all('SELECT DISTINCT status FROM accounting_standard').map((r) => ({
      key: r.status, label: STANDARD_STATUS_LABELS[r.status] || r.status,
    })),
    types: all('SELECT DISTINCT standard_type FROM accounting_standard').map((r) => ({
      key: r.standard_type, label: STANDARD_TYPE_LABELS[r.standard_type] || r.standard_type,
    })),
    body_status: all('SELECT DISTINCT body_status FROM accounting_standard').map((r) => ({
      key: r.body_status, label: BODY_STATUS_LABELS[r.body_status] || r.body_status,
    })),
  };
}

/**
 * 把管理员上传并解析出的正文写回标准行。
 * **不**因此把状态标成 verified：模型核验状态由 verification-svc 的真实调用结果决定。
 */
export function attachStandardBody(id, { bodyText, source, sha256=null, pagesTotal=null, pagesRead=null, extractionComplete=false, origin='official_fetch', actor='system:accounting' }={}) {
  const r=get('SELECT * FROM accounting_standard WHERE id=? OR code=?',[String(id),String(id)]);
  if(!r) return {error:'未找到该标准',status:404};
  const text=String(bodyText||'').trim();if(!text)return{error:'正文为空',status:400};
  const complete=extractionComplete===true && Number.isInteger(pagesTotal) && pagesTotal>0 && pagesRead===pagesTotal;
  const bodyStatus=complete?'full':'partial';const hash=createHash('sha256').update(text).digest('hex');const changed=r.content_hash!==hash;
  const rev=changed?Number(r.body_revision_no||0)+1:Number(r.body_revision_no||1);
  if(changed)run(`INSERT INTO accounting_standard_body_revision(id,standard_id,revision_no,body_status,sha256,pages_total,pages_read,extraction_complete,chars,source,source_url,origin,content_hash,created_at)VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[newId('ASR'),r.id,rev,bodyStatus,sha256,pagesTotal,pagesRead,complete?1:0,text.length,source,source?.startsWith('https://')?source:null,origin,hash,nowIso()]);
  run(`UPDATE accounting_standard SET body_text=?,body_status=?,sha256=COALESCE(?,sha256),pages_total=COALESCE(?,pages_total),pages_read=?,extraction_complete=?,content_hash=?,body_origin=?,body_revision_no=?,chars=?,source_locator=?,model_verify_status=CASE WHEN ? THEN 'unavailable' ELSE model_verify_status END,model_verify_at=CASE WHEN ? THEN NULL ELSE model_verify_at END,updated_at=? WHERE id=?`,[text,bodyStatus,sha256,pagesTotal,pagesRead,complete?1:0,hash,origin,rev,text.length,(origin==='admin_upload'?'管理员补充文件：':'官方原件：')+(source||''),changed?1:0,changed?1:0,nowIso(),r.id]);
  return{ok:true,id:r.id,body_status:bodyStatus,chars:text.length,content_hash:hash,pages_read:pagesRead};
}

/* ==================================================================== */
/*  五、中碳登清结算日报（与 CEA 同日对照）                             */
/* ==================================================================== */

function crcPublic(r) {
  return {
    id: r.id,
    source_code: r.source_code,
    detail_url: r.detail_url,
    title: r.title,
    trade_date: r.trade_date,
    published_at: r.published_at,
    daily_volume_t: r.daily_volume_t,
    daily_amount_yuan: r.daily_amount_yuan,
    daily_avg_price_published: r.daily_avg_price_published,
    daily_avg_price_derived: r.daily_avg_price_derived,
    avg_price_origin: r.avg_price_origin,
    cumulative_volume_t: r.cumulative_volume_t,
    cumulative_amount_yuan: r.cumulative_amount_yuan,
    caliber: r.caliber,
    scope: r.scope,
    snapshot_path: r.snapshot_path,
    content_hash: r.content_hash,
    revision_of: r.revision_of,
    revision_no: r.revision_no,
    is_current: !!r.is_current,
    parse_note: r.parse_note,
    updated_at: r.updated_at,
  };
}

export function listCrcDaily({ from = null, to = null, limit = 60, include_history = false } = {}) {
  const where = [];
  const params = [];
  if (from) { where.push('trade_date >= ?'); params.push(String(from)); }
  if (to) { where.push('trade_date <= ?'); params.push(String(to)); }
  if (!include_history) where.push('is_current = 1');
  const rows = all(
    `SELECT * FROM crc_clearing_daily ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY trade_date DESC, revision_no DESC LIMIT ?`,
    [...params, Math.min(Number(limit) || 60, 400)]
  );
  return { total: rows.length, rows: rows.map(crcPublic) };
}

export function getCrcDaily(idOrDate) {
  const r = get(
    `SELECT * FROM crc_clearing_daily WHERE id = ? OR (trade_date = ? AND is_current = 1) ORDER BY revision_no DESC LIMIT 1`,
    [String(idOrDate), String(idOrDate)]
  );
  if (!r) return null;
  const out = crcPublic(r);
  out.components = all(
    'SELECT * FROM crc_clearing_component WHERE daily_id = ? ORDER BY rowid',
    [r.id]
  ).map((c) => ({
    year_label: c.year_label,
    trade_method: c.trade_method,
    is_subtotal: !!c.is_subtotal,
    counts_to_total: !!c.counts_to_total,
    daily_volume_t: c.daily_volume_t,
    daily_amount_yuan: c.daily_amount_yuan,
    cumulative_volume_t: c.cumulative_volume_t,
    cumulative_amount_yuan: c.cumulative_amount_yuan,
  }));
  out.revisions = all(
    'SELECT id, revision_no, daily_volume_t, daily_amount_yuan, content_hash, created_at FROM crc_clearing_daily WHERE source_code=? AND trade_date=? AND scope=? ORDER BY revision_no DESC',
    [r.source_code, r.trade_date, r.scope]
  );
  out.source = getSource(r.source_code);
  out.subtotal_check = crcSubtotalCheck(out.components, out);
  return out;
}

/** 明细 → 小计 → 交易合计 的加总核对（确定性；不修改任何原值）。 */
export function crcSubtotalCheck(components = [], total = {}) {
  const subs = components.filter((c) => c.counts_to_total);
  if (!subs.length) return { agree: null, reason: 'no_subtotal_rows', subtotal_rows: 0 };
  const sum = (key) => subs.reduce((s, c) => s + (Number(c[key]) || 0), 0);
  const pairs = {
    daily_volume_t: [sum('daily_volume_t'), total.daily_volume_t],
    daily_amount_yuan: [sum('daily_amount_yuan'), total.daily_amount_yuan],
    cumulative_volume_t: [sum('cumulative_volume_t'), total.cumulative_volume_t],
    cumulative_amount_yuan: [sum('cumulative_amount_yuan'), total.cumulative_amount_yuan],
  };
  const diffs = {};
  const mismatches = [];
  for (const [k, [a, b]] of Object.entries(pairs)) {
    if (b === null || b === undefined) continue;
    const d = a - Number(b);
    diffs[k] = d;
    if (Math.abs(d) > 0.005) mismatches.push(k);
  }
  return {
    agree: mismatches.length === 0,
    subtotal_rows: subs.length,
    sum_of_subtotals: Object.fromEntries(Object.entries(pairs).map(([k, [a]]) => [k, a])),
    diffs,
    mismatches,
    note: '只把「小计」行计入合计，挂牌/大宗/单向竞价明细不得与合计再相加（避免重复计算）。',
  };
}

/**
 * 中碳登日报 × CEA 同日行情对照（**纯函数**，两侧原值都保留）。
 * 绝不做：相加、取其一覆盖、把中碳登累计量当成 CCER 累计量。
 */
export function compareCrcWithCea(crc, cea) {
  const out = {
    trade_date: crc?.trade_date || cea?.trade_date || null,
    crc: crc ? {
      daily_volume_t: crc.daily_volume_t,
      daily_amount_yuan: crc.daily_amount_yuan,
      avg_price_published: crc.daily_avg_price_published,
      avg_price_derived: crc.daily_avg_price_derived,
      cumulative_volume_t: crc.cumulative_volume_t,
      cumulative_amount_yuan: crc.cumulative_amount_yuan,
      source_code: crc.source_code,
      url: crc.detail_url,
      caliber: crc.caliber,
    } : null,
    cea: cea ? {
      total_volume: cea.total_volume,
      total_turnover: cea.total_turnover,
      close: cea.close,
      computed_avg_price: cea.computed_avg_price,
      lifetime_volume: cea.lifetime_volume,
      lifetime_turnover: cea.lifetime_turnover,
      source_url: cea.source_url,
      instrument: cea.instrument,
    } : null,
    combined_total: null, // 明确：不存在「合并总量」，避免被误用
  };
  const diffs = [];
  const cmp = (label, a, b, tol = 1e-6) => {
    if (a === null || a === undefined || b === null || b === undefined) return;
    const d = Number(a) - Number(b);
    if (Math.abs(d) > tol) diffs.push({ field: label, crc: Number(a), cea: Number(b), diff: d });
  };
  if (out.crc && out.cea) {
    cmp('daily_volume_t', out.crc.daily_volume_t, out.cea.total_volume);
    cmp('daily_amount_yuan', out.crc.daily_amount_yuan, out.cea.total_turnover);
    cmp('cumulative_volume_t', out.crc.cumulative_volume_t, out.cea.lifetime_volume);
    cmp('cumulative_amount_yuan', out.crc.cumulative_amount_yuan, out.cea.lifetime_turnover);
  }
  out.differences = diffs;
  // 只有两侧都有数据时才能判「是否一致」；缺一侧是缺失，既不算一致也不算差异
  out.match = out.crc && out.cea ? diffs.length === 0 : null;
  out.note =
    '两个来源的同日市场量额只做交叉核对：**差异保留两方原值**，不做平均、不择一覆盖，' +
    '**不做相加**（两份来源的同日成交量不得合计成一个数）。' +
    '中碳登为清结算日报口径，CEA 为全国碳排放配额行情口径；' +
    '任一侧缺失时 match=null（缺失既不算一致，也不算差异）。';
  return out;
}

/** 取同日 CEA 行情（只读 cea_trade_daily，缺表/缺行时如实为空）。 */
function ceaRowForDate(date) {
  try {
    return get(
      `SELECT * FROM cea_trade_daily WHERE trade_date = ? AND market_scope='national'
       ORDER BY price_regime DESC LIMIT 1`,
      [String(date)]
    );
  } catch {
    return null;
  }
}

/** 中碳登日报 + 同日 CEA 对照（列表）。 */
export function crcDailyWithCeaCompare({ from = null, to = null, limit = 30 } = {}) {
  const { rows } = listCrcDaily({ from, to, limit });
  const out = rows.map((r) => {
    const cea = ceaRowForDate(r.trade_date);
    const cmp = compareCrcWithCea(r, cea);
    return { ...r, cea_compare: cmp, cea_available: !!cea };
  });
  return {
    total: out.length,
    rows: out,
    cea_table_ready: (() => {
      try {
        return !!get("SELECT name FROM sqlite_master WHERE type='table' AND name='cea_trade_daily'");
      } catch {
        return false;
      }
    })(),
    note:
      '「登记与清结算」展示中碳登公布的清结算量额；CEA 列只在同一交易日存在 CEA 行情时显示，' +
      '两列不做加总，也不互相替代。',
  };
}

/* ==================================================================== */
/*  六、导出（CSV 防公式注入由 export-svc 统一处理）                    */
/* ==================================================================== */

export function factorExportRows(f = {}) {
  const { rows } = listFactors({ ...f, limit: 1000, offset: 0 });
  return rows.map((r) => ({
    name: r.name,
    value: r.value,
    unit: r.original_unit,
    gas: r.gas,
    category: r.category_label,
    region: r.region || '全国',
    data_year: r.data_year,
    version: r.version,
    publish_date: r.publish_date,
    page_physical: r.page_physical,
    page_printed: r.page_printed,
    locator: r.locator,
    evidence_level: r.evidence_level,
    model_verify_status: r.model_verify_status,
    original_url: r.original_url,
    original_sha256: r.original_sha256,
  }));
}

export function standardExportRows(f = {}) {
  return listStandards(f).rows.map((r) => ({
    code: r.code,
    title: r.title,
    issuer: r.issuer,
    sector: r.sector,
    type: r.standard_type_label,
    status: r.status_label,
    version: r.version,
    publish_date: r.publish_date,
    issue_date: r.issue_date,
    effective_year: r.effective_year,
    body_status: r.body_status_label,
    pages_total: r.pages_total,
    original_url: r.original_url,
    announcement_url: r.announcement_url,
    sha256: r.sha256,
    model_verify_status: r.model_verify_status,
  }));
}

export function crcExportRows(f = {}) {
  return listCrcDaily({ ...f, include_history: true }).rows.map((r) => ({
    trade_date: r.trade_date,
    daily_volume_t: r.daily_volume_t,
    daily_amount_yuan: r.daily_amount_yuan,
    avg_price_published: r.daily_avg_price_published,
    avg_price_derived: r.daily_avg_price_derived,
    cumulative_volume_t: r.cumulative_volume_t,
    cumulative_amount_yuan: r.cumulative_amount_yuan,
    caliber: r.caliber,
    revision_no: r.revision_no,
    published_at: r.published_at,
    detail_url: r.detail_url,
    content_hash: r.content_hash,
  }));
}

/* ==================================================================== */
/*  七、写入接口（仅供采集服务调用）                                    */
/* ==================================================================== */

/** 记录一次来源抓取结果（真实 HTTP/URL/哈希；不写就会保持 registered）。 */
export function recordSourceAttempt(code, patch = {}) {
  const r = get('SELECT * FROM accounting_source WHERE code = ?', [String(code)]);
  if (!r) return null;
  const now = nowIso();
  run(
    `UPDATE accounting_source SET status=?, status_note=COALESCE(?, status_note), last_attempt_at=?,
       last_success_at=COALESCE(?, last_success_at), last_http_status=?, last_error=?, last_url=?,
       last_content_hash=COALESCE(?, last_content_hash), last_content_bytes=COALESCE(?, last_content_bytes),
       last_file_path=COALESCE(?, last_file_path), last_page_url=COALESCE(?, last_page_url),
       collected_count=COALESCE(?, collected_count), blocked_kind=?, updated_at=?
     WHERE code=?`,
    [patch.status || r.status, patch.status_note ?? null, now,
      patch.success ? now : null, patch.http_status ?? null, patch.error ?? null, patch.url ?? null,
      patch.content_hash ?? null, patch.content_bytes ?? null, patch.file_path ?? null,
      patch.page_url ?? null, patch.collected_count ?? null, patch.blocked_kind ?? null, now, code]
  );
  return getSource(code);
}

/**
 * 写入 / 更新一条中碳登日报（同源同日同口径已存在则新增修订号，不覆盖原值）。
 * @returns {{id:string, action:'inserted'|'revision'|'unchanged'}}
 */
export function upsertCrcDaily(row, { actor = 'system:accounting-collect' } = {}) {
  const now = nowIso();
  const src = get('SELECT id FROM accounting_source WHERE code = ?', [row.source_code]);
  const current = get(
    'SELECT * FROM crc_clearing_daily WHERE source_code=? AND trade_date=? AND scope=? AND is_current=1',
    [row.source_code, row.trade_date, row.scope]
  );
  const derived = row.daily_volume_t && row.daily_amount_yuan
    ? row.daily_amount_yuan / row.daily_volume_t : null;
  const avgOrigin = row.daily_avg_price_published !== null && row.daily_avg_price_published !== undefined
    ? 'published' : derived !== null ? 'derived' : 'none';

  if (current && current.content_hash && row.content_hash && current.content_hash === row.content_hash) {
    return { id: current.id, action: 'unchanged' };
  }
  if (current) {
    // 「来源未变」的判定必须覆盖**全部数值字段**，不能只看量额：
    // 只比量额会把「官方只改了公布均价」误判成未变，从而丢掉一次真实修订。
    const valueFields = [
      'daily_volume_t', 'daily_amount_yuan', 'daily_avg_price_published',
      'cumulative_volume_t', 'cumulative_amount_yuan', 'published_at', 'title',
    ];
    const sameValues = valueFields.every((k) => (current[k] ?? null) === (row[k] ?? null));
    if (sameValues) {
      run('UPDATE crc_clearing_daily SET content_hash=COALESCE(?,content_hash), updated_at=? WHERE id=?',
        [row.content_hash || null, now, current.id]);
      return { id: current.id, action: 'unchanged' };
    }
    // 官方修订：旧行保留为历史（is_current=0），新增修订行并互相关联
    const id = newId('CRCD');
    run('UPDATE crc_clearing_daily SET is_current=0, updated_at=? WHERE id=?', [now, current.id]);
    run(
      `INSERT INTO crc_clearing_daily
        (id, source_id, source_code, detail_url, title, trade_date, published_at, daily_volume_t,
         daily_amount_yuan, daily_avg_price_published, daily_avg_price_derived, avg_price_origin,
         cumulative_volume_t, cumulative_amount_yuan, caliber, scope, snapshot_path, content_hash,
         revision_of, revision_no, is_current, parse_note, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, src?.id || null, row.source_code, row.detail_url, row.title || null, row.trade_date,
        row.published_at || null, row.daily_volume_t ?? null, row.daily_amount_yuan ?? null,
        row.daily_avg_price_published ?? null, derived, avgOrigin,
        row.cumulative_volume_t ?? null, row.cumulative_amount_yuan ?? null, row.caliber, row.scope,
        row.snapshot_path || null, row.content_hash || null, current.id,
        (Number(current.revision_no) || 1) + 1, 1, row.parse_note || null, now, now]
    );
    writeCrcComponents(id, row.components || []);
    audit({
      actor, actorRole: 'system', action: 'accounting.crc_revision', objectType: 'crc_clearing_daily',
      objectId: id, detail: { trade_date: row.trade_date, previous: current.id, previous_revision: current.revision_no },
    });
    return { id, action: 'revision' };
  }
  const id = newId('CRCD');
  run(
    `INSERT INTO crc_clearing_daily
      (id, source_id, source_code, detail_url, title, trade_date, published_at, daily_volume_t,
       daily_amount_yuan, daily_avg_price_published, daily_avg_price_derived, avg_price_origin,
       cumulative_volume_t, cumulative_amount_yuan, caliber, scope, snapshot_path, content_hash,
       revision_of, revision_no, is_current, parse_note, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, src?.id || null, row.source_code, row.detail_url, row.title || null, row.trade_date,
      row.published_at || null, row.daily_volume_t ?? null, row.daily_amount_yuan ?? null,
      row.daily_avg_price_published ?? null, derived, avgOrigin,
      row.cumulative_volume_t ?? null, row.cumulative_amount_yuan ?? null, row.caliber, row.scope,
      row.snapshot_path || null, row.content_hash || null, null, 1, 1, row.parse_note || null, now, now]
  );
  writeCrcComponents(id, row.components || []);
  audit({
    actor, actorRole: 'system', action: 'accounting.crc_insert', objectType: 'crc_clearing_daily',
    objectId: id, detail: { trade_date: row.trade_date, source: row.source_code },
  });
  return { id, action: 'inserted' };
}

function writeCrcComponents(dailyId, components) {
  run('DELETE FROM crc_clearing_component WHERE daily_id = ?', [dailyId]);
  const now = nowIso();
  for (const c of components) {
    run(
      `INSERT INTO crc_clearing_component
        (id, daily_id, year_label, trade_method, is_subtotal, daily_volume_t, daily_amount_yuan,
         cumulative_volume_t, cumulative_amount_yuan, counts_to_total, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [newId('CRCC'), dailyId, c.year_label, c.trade_method, c.is_subtotal ?? 0,
        c.daily_volume_t ?? null, c.daily_amount_yuan ?? null,
        c.cumulative_volume_t ?? null, c.cumulative_amount_yuan ?? null, c.counts_to_total ?? 0, now]
    );
  }
}

/** 写入 / 更新排放因子（identity_key 命中则更新，保留历史版本关系）。 */
export function upsertEmissionFactor(row) {
  const identity = [row.source_code, row.category, row.region || '全国', row.data_year, row.version].join('|');
  const existing = get('SELECT id FROM emission_factor WHERE identity_key = ?', [identity]);
  const r = upsertFactor({ ...row, identity_key: identity });
  return { identity_key: r.identity_key, inserted: r.inserted, id: existing?.id || null };
}

/** 写入 / 更新标准元数据或正文。 */
export function upsertAccountingStandard(row) {
  const r = upsertStandard(row);
  const found = get('SELECT id FROM accounting_standard WHERE identity_key = ?', [r.identity_key]);
  return { ...r, id: found?.id || null };
}

/** 把原件字节落到 DB 旁的 official-originals/accounting（内容寻址，天然去重）。 */
export function writeAccountingOriginal(hash, bytes, ext = 'bin') {
  const root = ensureAccountingRoot();
  const p = join(root, `${hash}.${ext}`);
  if (!existsSync(p)) writeFileSync(p, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
  return p;
}

export function readAccountingOriginal(path) {
  try {
    return existsSync(path) ? readFileSync(path) : null;
  } catch {
    return null;
  }
}
