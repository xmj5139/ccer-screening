/**
 * 信息治理 · 跨资料逐条五阶段、有界 worker、后台筛选/详情/重试
 * ============================================================================
 * docs/76 在 docs/74 的 content_item 闭环上扩展：
 *   - 政策、方法学版本、CEA 文件、标准规范、公开资料/问答、公开项目；
 *   - 正文/原件哈希/来源/时间从各自真实表与附件表读取，不把摘要当正文；
 *   - 摘要复用 summary-svc（输入哈希/提示词/模型键），核验复用既有适配器；
 *   - 内容、政策、方法学、项目、CEA 使用 verification-svc；碳核算两类使用
 *     accounting-evidence-svc 的既有签名；没有适配器的类型写 blocked，不伪造 verified；
 *   - 有界 worker 单并发、共享 collection 租约、尝试上限/退避、输入变化失效、
 *     跨类型轮转与全局条数/时间预算。
 *
 * 兼容：syncRecentContent / syncContentStages / getContentStages 等旧接口保留；
 * processPending 默认仍只处理 content_item，调用方要处理其它类型时必须显式传
 * objectTypes（每日链路与后台批次已显式传入全部类型）。
 */
import { all, get, run } from '../core/db.mjs';
import { nowIso } from '../core/util.mjs';
import { getSummary } from './summary-svc.mjs';
import { classifyStage, triageGaps } from './gap-triage-svc.mjs';
import {
  STAGES, STAGE_LABELS, STAGE_STATUS_LABELS, GOVERNED_OBJECT_TYPES, OBJECT_TYPE_LABELS,
  syncObjectStages, syncRecentStages, getObjectStages, recordStageAttempt,
  invalidateContentConclusions, objectCapabilities, objectEvidence, objectAdapterMeta,
  loadGovernedObject, isGovernedObjectType,
} from './processing-stage-svc.mjs';

const STAGE_ORDER = ['discovered', 'fetched', 'parsed', 'summarized', 'verified'];
const STATUS_PRIORITY = {
  blocked: 1, failed: 2, stale: 3, pending: 4, running: 5, skipped: 6, done: 7,
};

function intEnv(name, fallback, min, max) {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

/** 可配置但有硬上限：环境变量不能把 2 核 2GB 机器打满。 */
export function governanceConfig() {
  return {
    max_batch: intEnv('CCER_GOVERNANCE_MAX_BATCH', 20, 1, 100),
    max_attempts: intEnv('CCER_GOVERNANCE_MAX_ATTEMPTS', 3, 1, 10),
    retry_base_ms: intEnv('CCER_GOVERNANCE_RETRY_BASE_MS', 5 * 60 * 1000, 10_000, 3_600_000),
    retry_max_ms: intEnv('CCER_GOVERNANCE_RETRY_MAX_MS', 24 * 3600 * 1000, 60_000, 7 * 24 * 3600 * 1000),
    budget_ms: intEnv('CCER_GOVERNANCE_BUDGET_MS', 60_000, 1_000, 300_000),
    lease_ttl_ms: intEnv('CCER_GOVERNANCE_LEASE_TTL_MS', 15 * 60 * 1000, 30_000, 2 * 3600 * 1000),
    hard_limits: {
      max_batch: 100, max_attempts: 10, budget_ms: 300_000,
      retry_base_ms: 3_600_000, retry_max_ms: 7 * 24 * 3600 * 1000,
    },
  };
}

export function backoffAt(attempts, cfg = governanceConfig()) {
  const n = Math.max(1, Number(attempts) || 1);
  const delay = Math.min(cfg.retry_base_ms * 2 ** (n - 1), cfg.retry_max_ms);
  return new Date(Date.now() + delay).toISOString();
}

/* ==================================================================== */
/*  一、单实例租约                                                       */
/* ==================================================================== */

/**
 * 取得租约。只有租约不存在或已过期才能取得；不抢运行中的活任务。
 * @returns {{ok:boolean, lease?:object, reason?:string}}
 */
export function acquireLease({ key = 'collection', owner, purpose = null, ttlMs = null } = {}) {
  if (!owner) return { ok: false, reason: 'owner_required' };
  const cfg = governanceConfig();
  const ttl = Math.max(30_000, Math.min(Number(ttlMs) || cfg.lease_ttl_ms, 2 * 3600 * 1000));
  const now = nowIso();
  const expires = new Date(Date.now() + ttl).toISOString();
  const out = run(
    `INSERT INTO governance_lease (lease_key,owner,purpose,acquired_at,heartbeat_at,expires_at)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(lease_key) DO UPDATE SET
       owner=excluded.owner, purpose=excluded.purpose, acquired_at=excluded.acquired_at,
       heartbeat_at=excluded.heartbeat_at, expires_at=excluded.expires_at
     WHERE governance_lease.expires_at <= ?`,
    [key, owner, purpose, now, now, expires, now]
  );
  if (!out || Number(out.changes || 0) < 1) {
    return { ok: false, reason: 'lease_busy', lease: getLease(key) };
  }
  return { ok: true, lease: getLease(key) };
}

export function getLease(key = 'collection') {
  return get('SELECT * FROM governance_lease WHERE lease_key=?', [key]) || null;
}

export function renewLease({ key = 'collection', owner, ttlMs = null } = {}) {
  const cfg = governanceConfig();
  const ttl = Math.max(30_000, Math.min(Number(ttlMs) || cfg.lease_ttl_ms, 2 * 3600 * 1000));
  const now = nowIso();
  const expires = new Date(Date.now() + ttl).toISOString();
  const out = run(
    `UPDATE governance_lease SET heartbeat_at=?, expires_at=?
     WHERE lease_key=? AND owner=?`,
    [now, expires, key, owner]
  );
  return { ok: !!out && Number(out.changes || 0) > 0, lease: getLease(key) };
}

export function releaseLease({ key = 'collection', owner } = {}) {
  const out = run('DELETE FROM governance_lease WHERE lease_key=? AND owner=?', [key, owner]);
  return { ok: true, released: Number(out?.changes || 0) > 0 };
}

/** 过期租约是死租约：清理后可接续；未过期不清理。 */
export function reapExpiredLease(key = 'collection') {
  const now = nowIso();
  const out = run('DELETE FROM governance_lease WHERE lease_key=? AND expires_at <= ?', [key, now]);
  return { reaped: Number(out?.changes || 0) };
}

/* ==================================================================== */
/*  二、跨类型筛选、漏斗、详情                                           */
/* ==================================================================== */

function safeJson(text) {
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

function textOf(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function validateObjectTypes(objectTypes) {
  const types = [...new Set((Array.isArray(objectTypes) ? objectTypes : [objectTypes]).filter(Boolean))];
  const bad = types.filter((t) => !isGovernedObjectType(t));
  if (bad.length) throw new Error(`不支持的处理对象类型：${bad.join('、')}`);
  return types;
}

function typeSqlFilter(adapter, { objectType, stage, status, publisher, source_category, q } = {}) {
  const where = ['st.object_type=?', adapter.baseWhere];
  const params = [objectType];
  if (stage) { where.push('st.stage=?'); params.push(stage); }
  if (status) { where.push('st.status=?'); params.push(status); }
  if (q) {
    where.push(`(${adapter.searchCols.map((c) => `${c} LIKE ?`).join(' OR ')})`);
    for (let i = 0; i < adapter.searchCols.length; i += 1) params.push(`%${q}%`);
  }
  if (publisher && objectType === 'content_item') {
    where.push('ci.publisher LIKE ?'); params.push(`%${publisher}%`);
  }
  if (source_category && objectType === 'content_item') {
    where.push('ci.source_category=?'); params.push(source_category);
  }
  return { where: where.join(' AND '), params };
}

function stageQueryForType(objectType, filters, maxRows) {
  const meta = objectAdapterMeta(objectType);
  if (!meta) return { rows: [], total: 0 };
  const f = typeSqlFilter(meta, { ...filters, objectType });
  const rows = all(
    `SELECT st.*, ${meta.select}
       FROM processing_stage st
       JOIN ${meta.table} ${meta.alias} ON ${meta.alias}.id=st.object_id
      WHERE ${f.where}
      ORDER BY CASE st.status WHEN 'blocked' THEN 1 WHEN 'failed' THEN 2 WHEN 'stale' THEN 3
               WHEN 'pending' THEN 4 WHEN 'running' THEN 5 ELSE 6 END,
               COALESCE(st.next_retry_at,'9999') ASC,
               COALESCE(${meta.alias}.updated_at,'') DESC
      LIMIT ?`,
    [...f.params, Math.max(1, Math.min(Number(maxRows) || 200, 500))]
  );
  const total = Number(get(
    `SELECT COUNT(DISTINCT st.object_id) c
       FROM processing_stage st JOIN ${meta.table} ${meta.alias} ON ${meta.alias}.id=st.object_id
      WHERE ${f.where}`,
    f.params
  )?.c || 0);
  return { rows, total };
}

function aggregateItems(rows) {
  const map = new Map();
  for (const r of rows) {
    const key = `${r.object_type}|${r.object_id}`;
    if (!map.has(key)) {
      map.set(key, {
        object_type: r.object_type,
        type_label: OBJECT_TYPE_LABELS[r.object_type] || r.object_type,
        id: r.object_id,
        title: r.title,
        publisher: r.publisher,
        source_category: r.source_category,
        published_at: r.published_at,
        body_availability: r.body_availability,
        body_chars: r.body_chars,
        process_status: r.process_status,
        source_url: r.source_url,
        verification_status: r.verification_status,
        content_updated_at: r.content_updated_at,
        stages: [],
      });
    }
    map.get(key).stages.push({
      object_type: r.object_type,
      object_id: r.object_id,
      stage: r.stage,
      stage_label: STAGE_LABELS[r.stage] || r.stage,
      status: r.status,
      status_label: STAGE_STATUS_LABELS[r.status] || r.status,
      completed_at: r.completed_at,
      failure_reason: r.failure_reason,
      attempts: r.attempts,
      next_retry_at: r.next_retry_at,
      input_hash: r.input_hash,
      input_version: r.input_version,
      source_locator: r.source_locator,
      detail: safeJson(r.detail_json),
    });
  }
  const items = [...map.values()];
  for (const it of items) {
    it.stages.sort((a, b) => STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage));
    const blocked = it.stages.find((s) => s.status === 'blocked' || s.status === 'failed');
    it.blocking_stage = blocked
      ? { stage: blocked.stage, label: blocked.stage_label, reason: blocked.failure_reason }
      : null;
    it.summary_status = it.stages.find((s) => s.stage === 'summarized') || null;
    it.verify_status = it.stages.find((s) => s.stage === 'verified') || null;
    it.worst_status = it.stages.reduce((worst, s) => (
      !worst || (STATUS_PRIORITY[s.status] || 9) < (STATUS_PRIORITY[worst] || 9) ? s.status : worst
    ), null);
  }
  items.sort((a, b) => (STATUS_PRIORITY[a.worst_status] || 9) - (STATUS_PRIORITY[b.worst_status] || 9)
    || String(b.content_updated_at || '').localeCompare(String(a.content_updated_at || ''))
    || String(a.object_type).localeCompare(String(b.object_type))
    || String(a.id).localeCompare(String(b.id)));
  return items;
}

function typeTotals() {
  const out = {};
  for (const objectType of GOVERNED_OBJECT_TYPES) {
    const meta = objectAdapterMeta(objectType);
    out[objectType] = Number(get(
      `SELECT COUNT(*) c FROM ${meta.table} ${meta.alias} WHERE ${meta.baseWhere}`
    )?.c || 0);
  }
  return out;
}

function buildCoverage() {
  const totals = typeTotals();
  const stageCounts = {};
  for (const objectType of GOVERNED_OBJECT_TYPES) {
    const rows = all(
      `SELECT stage, status, COUNT(*) c FROM processing_stage WHERE object_type=? GROUP BY stage,status`,
      [objectType]
    );
    const stages = {};
    for (const r of rows) {
      stages[r.stage] = stages[r.stage] || {};
      stages[r.stage][r.status] = r.c;
    }
    stageCounts[objectType] = stages;
  }
  const notes = {
    content_item: '研报/行业动态逐条五阶段；正文、摘要、核验分别记录，失败可退避重试。',
    policy_document: '政策正文快照与 PDF 附件分列：附件登记不等于原件已归档；解析失败与原件未获取分开记录。',
    methodology_version: '方法学正文、官方 PDF 原件哈希与解析失败分列；核验按当前版本输入签名判断。',
    cea_document: 'CEA 政策/技术/研报正文与附件哈希来自 cea_document；已登记官方链接不等于已取得正文。',
    accounting_standard: '标准正文/原件 SHA-256 与 body_status 来自 accounting_standard；只对 full/partial 正文做模型核验。',
    accounting_public_document: '公开网页/问答逐条跟踪；目录/索引页解析完成不等于取得详情全文，不提供 PDF 补传入口。',
    public_project: '公开项目只有结构化登记字段：发现阶段完成，正文获取/解析不适用并标记 skipped；摘要限定公开字段，核验证据不足保持 insufficient。',
    emission_factor: '结构化数值因子沿用既有确定性核对与原文定位，不套用 PDF 下载/解析五阶段；不声明为已完成逐条五阶段闭环。',
    trade: '交易/行情为结构化数据，沿用既有确定性校验与来源快照；不新增逐条模型付费核验。',
    enterprise_directory: '企业名录为结构化公开名录，沿用既有确定性治理；不新增对全部企业逐条付费核验。',
  };
  const out = {};
  for (const objectType of GOVERNED_OBJECT_TYPES) {
    const caps = objectCapabilities(objectType);
    out[objectType] = {
      mode: 'five_stage', tracked: true, label: OBJECT_TYPE_LABELS[objectType],
      total: totals[objectType] || 0, stages: stageCounts[objectType],
      capabilities: caps, note: notes[objectType],
    };
  }
  out.emission_factor = {
    mode: 'structured_deterministic', tracked: false, label: '公开排放因子',
    total: Number(get('SELECT COUNT(*) c FROM emission_factor WHERE is_current=1')?.c || 0),
    note: notes.emission_factor,
  };
  out.trade = {
    mode: 'structured_deterministic', tracked: false, label: '交易行情',
    total: Number(get('SELECT COUNT(*) c FROM trade_daily')?.c || 0),
    note: notes.trade,
  };
  out.enterprise_directory = {
    mode: 'structured_deterministic', tracked: false, label: '企业名录',
    total: Number(get('SELECT COUNT(*) c FROM cea_entity')?.c || 0),
    note: notes.enterprise_directory,
  };
  return out;
}

/**
 * 后台阶段漏斗 + 条目明细 + 最近运行 + 阻塞原因。
 * 普通用户不会拿到该接口（路由统一后台管理员守卫）。
 */
export function listPipeline({
  objectType = null, stage = null, status = null, publisher = null,
  source_category = null, q = null, limit = 50, offset = 0, sync = true,
} = {}) {
  let types;
  try {
    types = objectType ? validateObjectTypes([objectType]) : [...GOVERNED_OBJECT_TYPES];
  } catch (e) {
    return { error: e.message, status: 400 };
  }
  if (sync) {
    try { syncRecentStages({ objectTypes: types, limit: 120 }); } catch { /* 漏斗仍可读既有阶段 */ }
  }
  const cfg = governanceConfig();
  const maxRows = Math.max(1, Math.min(Number(limit) || 50, 200));
  const off = Math.max(0, Number(offset) || 0);

  const funnel = [];
  for (const key of STAGES) {
    const params = [key];
    let typeClause = '';
    if (objectType) { typeClause = ' AND st.object_type=?'; params.push(objectType); }
    const rows = all(
      `SELECT st.status, COUNT(DISTINCT st.object_type || '|' || st.object_id) c
         FROM processing_stage st
        WHERE st.stage=?${typeClause}
        GROUP BY st.status`,
      params
    );
    const byStatus = Object.fromEntries(rows.map((r) => [r.status, r.c]));
    funnel.push({
      stage: key,
      label: STAGE_LABELS[key],
      total: rows.reduce((s, r) => s + r.c, 0),
      done: byStatus.done || 0,
      pending: byStatus.pending || 0,
      running: byStatus.running || 0,
      failed: byStatus.failed || 0,
      blocked: byStatus.blocked || 0,
      stale: byStatus.stale || 0,
      skipped: byStatus.skipped || 0,
    });
  }

  const fetched = [];
  let total = 0;
  const perType = {};
  for (const t of types) {
    const r = stageQueryForType(t, { stage, status, publisher, source_category, q }, off + maxRows + 30);
    fetched.push(...r.rows);
    total += r.total;
    perType[t] = r.total;
  }
  const merged = aggregateItems(fetched).slice(off, off + maxRows);

  const blockerParams = [];
  let blockerType = '';
  if (objectType) { blockerType = ' AND st.object_type=?'; blockerParams.push(objectType); }
  const blockers = all(
    `SELECT st.object_type, st.stage, st.status, st.failure_reason,
            COUNT(DISTINCT st.object_type || '|' || st.object_id) c
       FROM processing_stage st
      WHERE st.status IN ('blocked','failed','stale')${blockerType}
      GROUP BY st.object_type, st.stage, st.status, st.failure_reason
      ORDER BY c DESC LIMIT 16`,
    blockerParams
  ).map((b) => ({
    object_type: b.object_type,
    type_label: OBJECT_TYPE_LABELS[b.object_type] || b.object_type,
    stage: b.stage,
    stage_label: STAGE_LABELS[b.stage] || b.stage,
    status: b.status,
    status_label: STAGE_STATUS_LABELS[b.status] || b.status,
    reason: b.failure_reason || (b.status === 'stale' ? '输入已变化，待重新处理' : '未记录原因'),
    count: b.c,
    triage: classifyStage(b),
  }));

  const runs = all(
    `SELECT id, job_key, title, status, trigger_kind, triggered_by, created_at, started_at, finished_at,
            items_found, items_parsed, items_validated, items_queued, items_published,
            error_count, error_summary, data_as_of, detail_json
       FROM ingestion_job ORDER BY created_at DESC LIMIT 8`
  ).map((r) => ({
    ...r,
    stats: {
      found: r.items_found, parsed: r.items_parsed, validated: r.items_validated,
      queued: r.items_queued, published: r.items_published, errors: r.error_count,
    },
    detail: safeJson(r.detail_json),
  }));

  const queueParams = [nowIso(), cfg.max_attempts, ...(objectType ? [objectType] : [])];
  const queue = Number(get(
    `SELECT COUNT(DISTINCT st.object_type || '|' || st.object_id) c
       FROM processing_stage st
      WHERE st.stage IN ('summarized','verified') AND st.status IN ('pending','failed','stale','blocked')
        AND (st.next_retry_at IS NULL OR st.next_retry_at <= ?)
        AND st.attempts < ?${objectType ? ' AND st.object_type=?' : ''}`,
    queueParams
  )?.c || 0);

  const coverage = buildCoverage();
  const objectTypes = GOVERNED_OBJECT_TYPES.map((t) => ({
    key: t, label: OBJECT_TYPE_LABELS[t], total: coverage[t]?.total || 0,
    capabilities: coverage[t]?.capabilities || objectCapabilities(t),
  }));

  return {
    funnel,
    funnel_note:
      '阶段是独立状态：正文获取失败不等于核验失败；摘要成功、核验 unavailable 会分别展示。' +
      '「done」只表示该阶段已执行完成，不代表核验通过。',
    coverage,
    coverage_note:
      '逐条五阶段覆盖研报动态、政策、方法学版本、CEA 文件、标准规范、公开资料/问答与公开项目。' +
      '公开项目不适用正文下载/解析，相关阶段标记 skipped；排放因子、交易行情与企业名录仍用既有确定性治理，' +
      '不声明为 PDF 五阶段已完成。历史补采仍仅支持公开内容。',
    object_types: objectTypes,
    filters: { object_type: objectType || null, stage, status, publisher, source_category, q },
    total,
    per_type_total: perType,
    limit: maxRows,
    offset: off,
    items: merged,
    blockers,
    recent_runs: runs,
    queue,
    config: cfg,
    lease: getLease('collection'),
    generated_at: nowIso(),
  };
}

/* ==================================================================== */
/*  三、单条详情                                                         */
/* ==================================================================== */

function editHref(objectType, objectId) {
  return `#/admin?tab=maintenance&entity_type=${encodeURIComponent(objectType)}&entity_id=${encodeURIComponent(objectId)}&action=edit`;
}

function uploadLink(objectType, objectId) {
  const caps = objectCapabilities(objectType);
  if (!caps) return null;
  if (caps.upload_supported) {
    if (caps.upload_kind) {
      return {
        supported: true, kind: caps.upload_kind,
        href: `#/admin?tab=governance&upload_type=${encodeURIComponent(objectType)}&upload_id=${encodeURIComponent(objectId)}`,
        note: '落到现有 document-upload 补传界面，并预选该实体；不会另建写库路径。',
      };
    }
    return {
      supported: true, kind: objectType,
      href: `#/admin?tab=${encodeURIComponent(caps.upload_tab)}&upload_type=${encodeURIComponent(objectType)}&upload_id=${encodeURIComponent(objectId)}`,
      note: caps.upload_note,
    };
  }
  return {
    supported: false, kind: null,
    href: caps.upload_tab
      ? `#/admin?tab=${encodeURIComponent(caps.upload_tab)}`
      : null,
    note: caps.upload_note || '该资料类型没有原件补传入口。',
  };
}

/** 单条治理明细：真实证据、五阶段、摘要、核验、修订入口与定位链接。 */
export function getGovernanceItem(objectId, { objectType = 'content_item' } = {}) {
  if (!isGovernedObjectType(objectType)) {
    return { error: `不支持的处理对象类型：${objectType}`, status: 400 };
  }
  const row = loadGovernedObject(objectType, objectId);
  if (!row) return { error: '治理条目不存在', status: 404, object_type: objectType, object_id: String(objectId) };
  syncObjectStages(objectType, row);
  const stages = getObjectStages(objectType, row.id).map((s) => ({
    ...s,
    stage_label: STAGE_LABELS[s.stage] || s.stage,
    status_label: STAGE_STATUS_LABELS[s.status] || s.status,
    detail: safeJson(s.detail_json),
  }));
  const summaryRow = get(
    'SELECT * FROM entity_summary WHERE entity_type=? AND entity_id=? ORDER BY updated_at DESC LIMIT 1',
    [objectType, String(row.id)]
  );
  let summary = null;
  try { summary = getSummary(objectType, row.id); } catch { summary = null; }
  if (!summary && summaryRow) {
    summary = {
      ...summaryRow,
      input_kind: summaryRow.input_kind,
      scope_note: summaryRow.scope_note,
    };
  }
  const verifications = all(
    'SELECT * FROM verification_result WHERE object_type=? AND object_id=? ORDER BY created_at DESC LIMIT 5',
    [objectType, String(row.id)]
  ).map((v) => ({
    ...v,
    rules: safeJson(v.rules_json),
    citations: safeJson(v.citations_json),
    conflict_fields: safeJson(v.conflict_fields_json),
  }));
  const versions = objectType === 'content_item' ? all(
    'SELECT version_no, content_hash, title, body_chars, change_kind, change_summary, fetched_at FROM content_version WHERE content_item_id=? ORDER BY version_no DESC LIMIT 10',
    [row.id]
  ) : [];
  const revisions = all(
    'SELECT id, field_key, value, original_value, revision_no, status, note, actor, created_at FROM admin_revision WHERE entity_type=? AND entity_id=? ORDER BY created_at DESC LIMIT 20',
    [objectType, String(row.id)]
  );
  const capabilities = objectCapabilities(objectType);
  const item = { ...row, display_title: row.title || row.name || row.id };
  if (!item.title) item.title = item.display_title;
  return {
    object_type: objectType,
    object_id: String(row.id),
    type_label: OBJECT_TYPE_LABELS[objectType] || objectType,
    item,
    evidence: objectEvidence(objectType, row),
    capabilities,
    stages,
    summary,
    verifications,
    versions,
    revisions,
    links: {
      edit: { href: editHref(objectType, row.id), note: '编辑纠错走既有覆盖层并预选本实体，不改写原始证据。' },
      upload: uploadLink(objectType, row.id),
    },
    note:
      '处理阶段与核验结论分列展示：摘要成功不代表核验通过；核验 unavailable 表示服务未配置或调用失败，' +
      '不是「已核验」。正文/原件/摘要/核验均携带 object_type+object_id，避免不同类型同名 ID 串数据。',
  };
}

/* ==================================================================== */
/*  四、有界处理与重试                                                   */
/* ==================================================================== */

function needsStage(status) {
  return ['pending', 'failed', 'stale', 'blocked'].includes(status);
}

function loadActionsForType(objectType, stages, limit, cfg, now) {
  if (!stages.length) return [];
  const placeholders = stages.map(() => '?').join(',');
  return all(
    `SELECT st.object_type, st.object_id, st.stage, st.status, st.attempts, st.next_retry_at
       FROM processing_stage st
      WHERE st.object_type=?
        AND st.stage IN (${placeholders})
        AND st.status IN ('pending','failed','stale','blocked')
        AND (st.next_retry_at IS NULL OR st.next_retry_at <= ?)
        AND st.attempts < ?
      ORDER BY st.created_at ASC, st.attempts ASC, st.stage, st.object_id
      LIMIT ?`,
    [objectType, ...stages, now, cfg.max_attempts, Math.max(1, Math.min(Number(limit) || cfg.max_batch, cfg.max_batch))]
  );
}

/** 跨类型轮转：每个类型轮流取一条，避免老类型被新类型饿死。 */
function loadActionable({ types, stages, limit, cfg, now, verifyObjectTypes = null }) {
  const allowedVerify = verifyObjectTypes ? new Set(verifyObjectTypes) : null;
  const queues = types.map((type) => {
    const selected = stages.filter((s) => s === 'summarized'
      || (s === 'verified' && (!allowedVerify || allowedVerify.has(type))));
    return { type, rows: loadActionsForType(type, selected, limit, cfg, now), index: 0 };
  });
  const out = [];
  let progressed = true;
  while (out.length < limit && progressed) {
    progressed = false;
    for (const q of queues) {
      if (out.length >= limit) break;
      if (q.index < q.rows.length) {
        out.push(q.rows[q.index]);
        q.index += 1;
        progressed = true;
      }
    }
  }
  return out;
}

function markAttemptLimit(objectType, objectId, stage, cfg) {
  run(
    `UPDATE processing_stage SET status='blocked', next_retry_at=NULL,
       failure_reason='达到自动重试上限（' || ? || ' 次），需管理员手动重试'
         || CASE WHEN failure_reason IS NULL OR failure_reason='' THEN ''
                 ELSE '；原失败原因：' || failure_reason END,
       updated_at=?
     WHERE object_type=? AND object_id=? AND stage=?`,
    [cfg.max_attempts, nowIso(), objectType, String(objectId), stage]
  );
}

async function runSummary(objectType, objectId, { actor, deadlineAt, force = false } = {}) {
  const cfg = governanceConfig();
  const caps = objectCapabilities(objectType);
  const prev = get(
    'SELECT attempts FROM processing_stage WHERE object_type=? AND object_id=? AND stage=?',
    [objectType, String(objectId), 'summarized']
  );
  if (!caps?.summary_supported) {
    const next = backoffAt(Number(prev?.attempts || 0) + 1, cfg);
    recordStageAttempt({
      objectType, objectId, stage: 'summarized', status: 'blocked',
      failureReason: '该资料类型暂无摘要适配器', nextRetryAt: next,
    });
    return { status: 'blocked', reason: 'summary_not_supported', next_retry_at: next };
  }
  const summary = await import('./summary-svc.mjs');
  const remaining = Math.max(2_000, deadlineAt - Date.now() - 500);
  let out;
  try {
    out = await summary.runSummaryBatchExclusive({
      entityType: objectType, ids: [objectId], limit: 1, force,
      budgetMs: Math.min(remaining, 60_000), actor,
    });
  } catch (e) {
    const next = backoffAt(Number(prev?.attempts || 0) + 1, cfg);
    recordStageAttempt({
      objectType, objectId, stage: 'summarized', status: 'failed',
      failureReason: `摘要调用异常：${e.message}`, nextRetryAt: next,
    });
    return { status: 'failed', reason: e.message, next_retry_at: next };
  }
  if (out?.busy) {
    return { status: 'busy', reason: 'summary_busy', next_retry_at: null };
  }
  const { getSummary } = summary;
  const s = getSummary(objectType, objectId);
  const attempts = Number(prev?.attempts || 0) + (out?.scanned ? 1 : 0);
  if (s?.status === 'ok' && !s.stale) {
    syncObjectStages(objectType, objectId);
    return { status: 'done', generated_at: s.generated_at, model: s.model || null };
  }
  if (s?.status === 'skipped' || out?.reason === 'no_model' || out?.model_configured === false) {
    const next = backoffAt(Math.max(1, attempts), cfg);
    recordStageAttempt({
      objectType, objectId, stage: 'summarized', status: 'blocked',
      failureReason: s?.error || '未配置可用模型，摘要未生成（blocked，不是已完成）',
      nextRetryAt: next,
    });
    return { status: 'blocked', reason: 'no_model', next_retry_at: next };
  }
  const next = backoffAt(Math.max(1, attempts), cfg);
  recordStageAttempt({
    objectType, objectId, stage: 'summarized', status: 'failed',
    failureReason: s?.error || out?.error || '摘要生成失败', nextRetryAt: next,
  });
  return { status: 'failed', reason: s?.error || 'summary_failed', next_retry_at: next };
}

async function runVerify(objectType, objectId, { actor, force = false } = {}) {
  const cfg = governanceConfig();
  const prev = get(
    'SELECT attempts FROM processing_stage WHERE object_type=? AND object_id=? AND stage=?',
    [objectType, String(objectId), 'verified']
  );
  const caps = objectCapabilities(objectType);
  if (!caps?.verification_supported) {
    recordStageAttempt({
      objectType, objectId, stage: 'verified', status: 'blocked',
      failureReason: caps?.upload_note || '该资料类型暂无核验适配器；确定性校验保留，不伪造 verified',
    });
    return { status: 'blocked', reason: 'verification_not_supported' };
  }
  let out;
  try {
    if (objectType === 'content_item') {
      const verify = await import('./verification-svc.mjs');
      out = await verify.verifyContentItem(objectId, { actor, force });
    } else if (['policy_document', 'methodology_version', 'public_project', 'cea_document'].includes(objectType)) {
      const verify = await import('./verification-svc.mjs');
      out = await verify.verifyObject(objectType, objectId, { actor, force });
    } else if (objectType === 'accounting_standard') {
      const accounting = await import('./accounting-collect-svc.mjs');
      out = await accounting.verifyStandardWithModel(objectId, { actor, force });
    } else if (objectType === 'accounting_public_document') {
      const pub = await import('./accounting-public-svc.mjs');
      out = await pub.verifyPublicDocument(objectId, { actor });
    } else {
      out = { ok: false, error: '不支持的核验对象类型' };
    }
  } catch (e) {
    const next = backoffAt(Number(prev?.attempts || 0) + 1, cfg);
    recordStageAttempt({
      objectType, objectId, stage: 'verified', status: 'failed',
      failureReason: `核验调用异常：${e.message}`, nextRetryAt: next,
    });
    return { status: 'failed', reason: e.message, next_retry_at: next };
  }

  syncObjectStages(objectType, objectId);
  const current = get(
    'SELECT status, failure_reason FROM processing_stage WHERE object_type=? AND object_id=? AND stage=?',
    [objectType, String(objectId), 'verified']
  );
  if (out?.error && !out?.result) {
    const next = backoffAt(Number(prev?.attempts || 0) + 1, cfg);
    recordStageAttempt({
      objectType, objectId, stage: 'verified', status: 'blocked',
      failureReason: out.error, nextRetryAt: next,
    });
    return { status: 'blocked', reason: out.error, next_retry_at: next };
  }
  if (out?.result === 'unavailable' || current?.status === 'blocked') {
    const next = backoffAt(Number(prev?.attempts || 0) + 1, cfg);
    recordStageAttempt({
      objectType, objectId, stage: 'verified', status: 'blocked',
      failureReason: out?.capability_note || out?.summary || current?.failure_reason
        || '核验服务不可用（unavailable）',
      nextRetryAt: next,
    });
    return { status: 'blocked', result: out?.result || 'unavailable', reason: out?.reason || 'unavailable', next_retry_at: next };
  }
  if (current?.status === 'done') {
    return { status: 'done', result: out?.result || null, summary: out?.summary || current.failure_reason || null };
  }
  const next = backoffAt(Number(prev?.attempts || 0) + 1, cfg);
  recordStageAttempt({
    objectType, objectId, stage: 'verified', status: 'blocked',
    failureReason: current?.failure_reason || out?.reason || '核验未生成可复用的当前输入签名结果',
    nextRetryAt: next,
  });
  return {
    status: 'blocked', result: out?.result || null,
    reason: out?.reason || current?.failure_reason || 'verification_not_recorded', next_retry_at: next,
  };
}

/**
 * 每日任务/后台手动触发的有界补处理。
 * 默认只处理 content_item（兼容 docs/74/124）；跨类型调用必须显式传 objectTypes。
 */
export async function processPending({
  actor = 'system:governance', limit = null, budgetMs = null, dryRun = false, leaseOwner = null,
  only = ['summarized', 'verified'], objectTypes = ['content_item'], verifyObjectTypes = null,
  sync = true,
} = {}) {
  const cfg = governanceConfig();
  const types = validateObjectTypes(objectTypes);
  const stages = [...new Set((only || []).filter((s) => s === 'summarized' || s === 'verified'))];
  if (!stages.length) return { ok: true, scanned: 0, message: '没有可处理的阶段' };
  const allowedVerify = verifyObjectTypes ? validateObjectTypes(verifyObjectTypes) : null;
  const max = Math.max(1, Math.min(Number(limit) || cfg.max_batch, cfg.max_batch));
  const budget = Math.max(1_000, Math.min(Number(budgetMs) || cfg.budget_ms, cfg.budget_ms));
  const deadlineAt = Date.now() + budget;
  const now = nowIso();
  try { if (sync) syncRecentStages({ objectTypes: types, limit: 120 }); } catch { /* 同步失败不阻塞处理 */ }

  const typePlaceholders = types.map(() => '?').join(',');
  const stagePlaceholders = stages.map(() => '?').join(',');
  run(
    `UPDATE processing_stage SET status='blocked', next_retry_at=NULL,
       failure_reason='达到自动重试上限（' || ? || ' 次），需管理员手动重试'
         || CASE WHEN failure_reason IS NULL OR failure_reason='' THEN ''
                 ELSE '；原失败原因：' || failure_reason END,
       updated_at=?
     WHERE object_type IN (${typePlaceholders}) AND stage IN (${stagePlaceholders})
       AND attempts >= ? AND status IN ('pending','failed','blocked')`,
    [cfg.max_attempts, nowIso(), ...types, ...stages, cfg.max_attempts]
  );
  const actions = loadActionable({ types, stages, limit: max, cfg, now, verifyObjectTypes: allowedVerify });
  const out = {
    ok: true, scanned: actions.length, summarized: 0, verified: 0, blocked: 0, failed: 0,
    skipped: 0, busy: 0, deadline_reached: false, lease_held: false, actions: [],
    by_type: {}, by_stage: { summarized: 0, verified: 0 }, object_types: types,
  };
  for (const t of types) {
    out.by_type[t] = { scanned: 0, summarized: 0, verified: 0, blocked: 0, failed: 0, skipped: 0 };
  }
  let lease = null;
  if (leaseOwner) {
    lease = acquireLease({ key: 'collection', owner: leaseOwner, purpose: 'governance_process' });
    if (!lease.ok) return { ...out, ok: false, reason: lease.reason, lease: lease.lease };
    out.lease_held = true;
  }
  try {
    for (const a of actions) {
      if (Date.now() >= deadlineAt - 800) { out.deadline_reached = true; break; }
      const typeStat = out.by_type[a.object_type] || (out.by_type[a.object_type] = {
        scanned: 0, summarized: 0, verified: 0, blocked: 0, failed: 0, skipped: 0,
      });
      typeStat.scanned += 1;
      if (dryRun) {
        out.actions.push({ object_type: a.object_type, object_id: a.object_id, stage: a.stage, action: 'would_run' });
        continue;
      }
      const row = loadGovernedObject(a.object_type, a.object_id);
      if (!row) {
        out.skipped += 1;
        typeStat.skipped += 1;
        continue;
      }
      syncObjectStages(a.object_type, row);
      const fresh = get(
        'SELECT status, attempts FROM processing_stage WHERE object_type=? AND object_id=? AND stage=?',
        [a.object_type, String(a.object_id), a.stage]
      );
      if (!fresh || !needsStage(fresh.status)) continue;
      if (Number(fresh.attempts || 0) >= cfg.max_attempts) {
        markAttemptLimit(a.object_type, a.object_id, a.stage, cfg);
        out.blocked += 1;
        typeStat.blocked += 1;
        continue;
      }
      if (a.stage === 'summarized') {
        const r = await runSummary(a.object_type, a.object_id, { actor, deadlineAt });
        out.actions.push({ object_type: a.object_type, object_id: a.object_id, stage: a.stage, ...r });
        out.by_stage.summarized += 1;
        if (r.status === 'done') { out.summarized += 1; typeStat.summarized += 1; } else if (r.status === 'busy') {
          out.busy += 1; typeStat.skipped += 1;
        } else if (r.status === 'blocked' || r.status === 'skipped') {
          out.blocked += 1; typeStat.blocked += 1;
        } else { out.failed += 1; typeStat.failed += 1; }
      } else if (a.stage === 'verified') {
        const r = await runVerify(a.object_type, a.object_id, { actor });
        out.actions.push({ object_type: a.object_type, object_id: a.object_id, stage: a.stage, ...r });
        out.by_stage.verified += 1;
        if (r.status === 'done') { out.verified += 1; typeStat.verified += 1; } else if (r.status === 'blocked') {
          out.blocked += 1; typeStat.blocked += 1;
        } else { out.failed += 1; typeStat.failed += 1; }
      }
    }
  } finally {
    if (lease && lease.ok && leaseOwner) releaseLease({ key: 'collection', owner: leaseOwner });
  }
  out.ok = !out.deadline_reached && out.failed === 0;
  out.generated_at = nowIso();
  return out;
}

/**
 * 解释每日核验策略：只调度管理员启用的 scope；碳核算两类沿用 accounting 的
 * verify_with_model 配置。返回 null 表示“全部支持的类型”，空数组表示“核验全关”。
 */
export async function verifyTypesFromConfig() {
  const verify = await import('./verification-svc.mjs');
  const vcfg = verify.verifyConfig();
  const scopes = Array.isArray(vcfg.scopes) ? vcfg.scopes : [];
  const out = [];
  const map = {
    content: 'content_item', policy: 'policy_document', methodology: 'methodology_version',
    project: 'public_project', cea: 'cea_document',
  };
  for (const [scope, type] of Object.entries(map)) {
    if (scopes.includes(scope)) out.push(type);
  }
  try {
    const accounting = await import('./accounting-svc.mjs');
    if (accounting.accountingConfig().verify_with_model !== false) {
      out.push('accounting_standard', 'accounting_public_document');
    }
  } catch { /* 碳核算配置不可读时不在每日链路自动核验该两类 */ }
  return out;
}

/**
 * 每日链路的统一入口：摘要 + 核验都走同一有界 worker，不再调用旧
 * refreshAll / verifyAllBatch 旁路无限重试。调用方需已持有 collection 租约。
 */
export async function runDailyGovernance({ actor = 'system:daily', limit = null, budgetMs = null } = {}) {
  const verifyObjectTypes = await verifyTypesFromConfig();
  const out = await processPending({
    actor, limit, budgetMs,
    objectTypes: [...GOVERNED_OBJECT_TYPES],
    only: ['summarized', 'verified'],
    verifyObjectTypes,
  });
  // 每日兜底补入漏队项：只入持久队列，不在这里同步调用模型。
  let ingestQueue = null;
  try {
    const ingest = await import('./ingest-summary-svc.mjs');
    ingestQueue = ingest.enqueueMissedContentSummaries({ limit: 20, actor, source: 'daily_backfill' });
  } catch (e) {
    ingestQueue = { error: String(e?.message || e) };
  }
  // 每日缺口校准：只做确定性分类与已有证据结清（例如同 URL 快照证明非目标页、
  // 当前摘要已生成），不调模型、不猜关闭；结果保留在台账与审计中。
  let gapUpkeep = null;
  try {
    const triage = triageGaps({ status: 'open', limit: 300, persist: true, includeFields: false });
    gapUpkeep = {
      scanned: triage.total, open: triage.open,
      by_category: triage.by_category, stage_categories: triage.stage_categories,
    };
  } catch (e) {
    gapUpkeep = { error: String(e?.message || e) };
  }
  return { ...out, daily: true, verify_object_types: verifyObjectTypes, ingest_queue: ingestQueue, gap_upkeep: gapUpkeep };
}

/**
 * 后台单条重试。失败也会写回阶段、尝试次数和退避时间。
 * 正文/附件类阶段优先复用既有归档/OCR/上传服务；没有单条能力时如实返回
 * manual_upload/blocked 与正确实体的上传链接，不伪造“已重取”。
 */
export async function retryStage(user, {
  objectId, stage, objectType = 'content_item', force = true,
} = {}) {
  if (user?.role !== 'admin') return { error: '仅管理员可重试处理阶段', status: 403, object_type: objectType, object_id: objectId };
  if (!isGovernedObjectType(objectType)) return { error: `不支持的处理对象类型：${objectType}`, status: 400, object_type: objectType, object_id: objectId };
  if (!STAGES.includes(stage)) return { error: `未知阶段：${stage}`, status: 400, object_type: objectType, object_id: objectId };
  const row = loadGovernedObject(objectType, objectId);
  if (!row) return { error: '治理条目不存在', status: 404, object_type: objectType, object_id: objectId };
  const cfg = governanceConfig();
  syncObjectStages(objectType, row);
  const objectRef = { object_type: objectType, object_id: String(objectId) };

  const stageStatus = () => get(
    'SELECT status, failure_reason FROM processing_stage WHERE object_type=? AND object_id=? AND stage=?',
    [objectType, String(objectId), stage]
  );
  const finishSync = () => {
    syncObjectStages(objectType, objectId);
    const s = stageStatus();
    return {
      ok: s?.status === 'done', stage, status: s?.status || 'unknown',
      reason: s?.failure_reason || null, ...objectRef,
    };
  };
  const block = (reason, extra = {}) => {
    const next = backoffAt(1, cfg);
    recordStageAttempt({
      objectType, objectId, stage, status: 'blocked', failureReason: reason, nextRetryAt: next,
    });
    return { ok: false, stage, status: 'blocked', reason, next_retry_at: next, ...objectRef, ...extra };
  };

  if (stage === 'discovered') {
    syncObjectStages(objectType, objectId);
    return { ok: true, stage, action: 'resync', stages: getObjectStages(objectType, objectId), ...objectRef };
  }

  if (stage === 'fetched' || stage === 'parsed') {
    if (objectType === 'public_project') {
      syncObjectStages(objectType, objectId);
      return {
        ok: true, stage, action: 'not_applicable', status: 'skipped',
        reason: '公开项目为结构化登记字段，正文获取/解析阶段不适用', ...objectRef,
      };
    }
    if (objectType === 'content_item') {
      if (stage === 'parsed') {
        syncObjectStages(objectType, objectId);
        return { ok: true, stage, action: 'resync', ...objectRef };
      }
      const fetch = await import('./web-fetch-svc.mjs');
      const content = await import('./content-svc.mjs');
      const conn = fetch.pickFetchConnection();
      if (!conn) return block('未配置网页抓取连接，无法重取正文', { action: 'needs_fetch_connection' });
      let fr;
      try {
        fr = await import('./deepseek-fallback-svc.mjs').then((m) => m.fetchWithFallback(row.source_url, { attempts: 2 }));
      } catch (e) {
        fr = { ok: false, reason: 'exception', message: e.message };
      }
      if (!fr?.ok) return block(`正文重取失败（${fr?.reason || 'unknown'}）：${fr?.message || ''}`, { action: 'fetch_failed' });
      const body = content.normalizeBody(fr.content);
      if (body.length < 60) return block(`重取正文过短（${body.length} 字符），疑似跳转/错误页`, { action: 'body_too_short' });
      const up = content.upsertContent({
        title: row.title, source_url: row.source_url, content_type: row.content_type,
        record_kind: row.record_kind, publisher: row.publisher, published_at: row.published_at,
        summary: row.summary, body_snapshot: body,
        body_availability: body.length >= 1200 ? 'full_text' : 'partial',
        snapshot_id: row.snapshot_id, source_category: row.source_category,
        note: '管理员后台重试：从公开原文重新获取正文',
      }, { actor: user.name || 'admin' });
      if (up.action === 'unchanged') {
        run(
          `UPDATE content_item SET body_snapshot=?, body_chars=?, body_availability=?,
             collected_at=COALESCE(collected_at,?), updated_at=? WHERE id=?`,
          [body, body.length, body.length >= 1200 ? 'full_text' : 'partial', nowIso(), nowIso(), row.id]
        );
      }
      syncObjectStages(objectType, up.id || row.id);
      return { ok: true, stage, action: up.action, id: up.id || row.id, body_chars: body.length, ...objectRef };
    }
    if (objectType === 'policy_document') {
      if (stage === 'parsed' && textOf(row.body_snapshot)) {
        syncObjectStages(objectType, objectId);
        return { ok: true, stage, action: 'resync', ...objectRef };
      }
      try {
        const archive = await import('./policy-archive-svc.mjs');
        await archive.archivePolicyOriginal(objectId, { actor: user.name || 'admin', force: true });
      } catch (e) {
        return block(`政策原件归档失败：${e.message}`, { action: 'archive_failed' });
      }
      return finishSync();
    }
    if (['methodology_version', 'cea_document'].includes(objectType)) {
      try {
        const ocr = await import('./ocr-backfill-svc.mjs');
        const out = await ocr.reparseObject({
          kind: objectType, id: objectId, actor: user.name || 'admin', force: true,
          deadlineAt: Date.now() + 120_000,
        });
        if (out?.error) {
          return block(out.error, {
            action: 'reparse_unavailable',
            upload: uploadLink(objectType, objectId),
          });
        }
      } catch (e) {
        return block(`原件重解析失败：${e.message}`, { action: 'reparse_failed', upload: uploadLink(objectType, objectId) });
      }
      return finishSync();
    }
    if (objectType === 'accounting_standard') {
      return block(
        '标准原件补传/解析必须落到「碳核算资料」页签的既有 PDF 上传入口；治理页不另建写库路径',
        { action: 'manual_upload', upload: uploadLink(objectType, objectId) }
      );
    }
    if (objectType === 'accounting_public_document') {
      return block(
        '公开网页/问答没有单条 PDF 重试；请在「碳核算资料」页签运行公开资料采集（有界任务）',
        { action: 'manual_collect', upload: uploadLink(objectType, objectId) }
      );
    }
  }

  // 摘要 / 核验：管理员明确重试，清零尝试后执行一次。
  if (stage === 'summarized' || stage === 'verified') {
    run(
      `UPDATE processing_stage SET status='pending', attempts=0, next_retry_at=?, failure_reason=NULL, updated_at=?
        WHERE object_type=? AND object_id=? AND stage=?`,
      [nowIso(), nowIso(), objectType, String(objectId), stage]
    );
    const r = stage === 'summarized'
      ? await runSummary(objectType, objectId, {
        actor: user.name || 'admin', deadlineAt: Date.now() + Math.min(cfg.budget_ms, 60_000), force,
      })
      : await runVerify(objectType, objectId, { actor: user.name || 'admin', force });
    return { ...r, ok: r.status === 'done', stage, ...objectRef, upload: uploadLink(objectType, objectId) };
  }

  syncObjectStages(objectType, objectId);
  return { ok: true, stage, action: 'resync', ...objectRef };
}

/**
 * 后台批量触发补处理（有界、跨类型、共享 collection 租约）。
 */
export async function runGovernanceBatch(user, { limit = null, budgetMs = null } = {}) {
  if (user?.role !== 'admin') return { error: '仅管理员可执行治理批次', status: 403 };
  const verifyObjectTypes = await verifyTypesFromConfig();
  return processPending({
    actor: user.name || 'admin', limit, budgetMs,
    objectTypes: [...GOVERNED_OBJECT_TYPES],
    only: ['summarized', 'verified'],
    verifyObjectTypes,
    leaseOwner: `admin:${user.name || 'admin'}:${Date.now()}`,
  });
}

export { invalidateContentConclusions, syncRecentStages, syncObjectStages, getObjectStages };
