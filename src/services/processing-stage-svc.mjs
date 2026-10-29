/**
 * 公开内容处理阶段（docs/74 A.1）
 * ============================================================================
 * 只做一件事：把「发现 / 正文获取 / 解析 / 摘要 / 核验」写成可查询、可重试的
 * 持久状态。阶段结论来源于**实际存在的行**，不靠前端或模型自报：
 *   - 摘要：entity_summary.status='ok' 且生成时间不早于内容更新时间；
 *   - 核验：verification_result 的最新记录不早于内容更新时间；
 *   - 正文/解析：content_item.body_chars 与 body_availability。
 *
 * 正文变更时（content-svc.upsertContent 已保存新版本），summarized/verified
 * 一律置为 stale 并清空完成时间，避免沿用旧结论。
 */
import { createHash } from 'node:crypto';
import { all, get, run } from '../core/db.mjs';
import { newId, nowIso, j, uj } from '../core/util.mjs';
import { getSummary, loadSummaryInput, summaryInputHash } from './summary-svc.mjs';
import {
  contentVerificationInput, INPUT_HASH_SCHEME, objectVerificationInput,
  modelKeyOf, pickVerifyProvider,
} from './verification-svc.mjs';
import { accountingEvidenceFingerprint } from './accounting-evidence-svc.mjs';

export const STAGES = ['discovered', 'fetched', 'parsed', 'summarized', 'verified'];

export const STAGE_LABELS = {
  discovered: '发现',
  fetched: '正文获取 / 附件下载',
  parsed: '解析 / OCR',
  summarized: '摘要',
  verified: '核验',
};

export const STAGE_STATUS_LABELS = {
  done: '已完成',
  pending: '待处理',
  running: '处理中',
  failed: '失败',
  blocked: '阻塞 / 不可用',
  stale: '已失效，待重新处理',
  skipped: '未执行 / 不适用',
};

/**
 * 逐条阶段白名单（docs/76）：表名与列名全部硬编码在适配器中，不接受调用方输入。
 * 结构化项目不适用下载/解析，相关阶段写 skipped 并说明原因；排放因子仍是
 * 确定性数值治理，不强行套用 PDF 五阶段。
 */
export const GOVERNED_OBJECT_TYPES = [
  'content_item', 'policy_document', 'methodology_version', 'cea_document',
  'accounting_standard', 'accounting_public_document', 'public_project',
];

export const OBJECT_TYPE_LABELS = {
  content_item: '研报与动态',
  policy_document: '政策文件',
  methodology_version: '方法学版本',
  cea_document: 'CEA 公开文件',
  accounting_standard: '标准规范',
  accounting_public_document: '公开资料与问答',
  public_project: '公开项目',
};

const OBJECT_TYPES = new Set(GOVERNED_OBJECT_TYPES);

function isContentType(objectType) {
  return String(objectType || '') === 'content_item';
}

export function isGovernedObjectType(objectType) {
  return OBJECT_TYPES.has(String(objectType || ''));
}

export function objectTypeLabel(objectType) {
  return OBJECT_TYPE_LABELS[objectType] || String(objectType || '');
}

function clip(value, max = 400) {
  const s = String(value || '');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function textOf(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function hashText(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

function bodyHash(row) {
  return hashText([
    row?.body_snapshot, row?.body_text, row?.content_hash, row?.sha256,
    row?.original_file_hash, row?.attachment_hash,
  ].filter(Boolean).join('\n'));
}

function summaryInputSafe(objectType, objectId) {
  try {
    const input = loadSummaryInput(objectType, objectId);
    if (!input) return { input: null, hash: null };
    return { input, hash: summaryInputHash(input) };
  } catch {
    return { input: null, hash: null };
  }
}

function summaryReadSafe(objectType, objectId) {
  try { return getSummary(objectType, objectId); } catch { return null; }
}

function currentVerification(objectType, row) {
  if (objectType === 'content_item') {
    try {
      const input = contentVerificationInput(row.id);
      return input ? {
        supported: true, mode: 'content', inputHash: input.inputHash,
        modelKey: null, hashScheme: INPUT_HASH_SCHEME,
      } : { supported: false, reason: '当前正文无法生成核验输入签名' };
    } catch (e) {
      return { supported: false, reason: `当前正文无法生成核验输入签名：${e.message}` };
    }
  }
  if (['policy_document', 'methodology_version', 'public_project', 'cea_document'].includes(objectType)) {
    try {
      const input = objectVerificationInput(objectType, row.id);
      return input ? {
        supported: true, mode: 'object', inputHash: input.inputHash,
        modelKey: input.modelKey || modelKeyOf(input.provider), hashScheme: INPUT_HASH_SCHEME,
      } : { supported: false, reason: '该对象不存在或暂无核验适配器' };
    } catch (e) {
      return { supported: false, reason: `当前对象无法生成核验输入签名：${e.message}` };
    }
  }
  if (objectType === 'accounting_standard' || objectType === 'accounting_public_document') {
    try {
      const fp = accountingEvidenceFingerprint(objectType, row);
      return fp ? {
        supported: true, mode: 'accounting-evidence', inputHash: fp.input_hash,
        modelKey: modelKeyOf(pickVerifyProvider()), hashScheme: INPUT_HASH_SCHEME,
      } : { supported: false, reason: '碳核算证据输入不完整，无法生成当前签名' };
    } catch (e) {
      return { supported: false, reason: `碳核算证据签名生成失败：${e.message}` };
    }
  }
  return { supported: false, reason: `资料类型 ${objectType} 暂无核验适配器，未执行模型核验` };
}

function latestSummary(objectId) {
  return get(
    "SELECT * FROM entity_summary WHERE entity_type='content_item' AND entity_id=? ORDER BY updated_at DESC LIMIT 1",
    [String(objectId)]
  );
}

function latestVerification(objectId) {
  return get(
    "SELECT * FROM verification_result WHERE object_type='content_item' AND object_id=? ORDER BY created_at DESC LIMIT 1",
    [String(objectId)]
  );
}

function isAfter(value, baseline) {
  if (!value) return false;
  if (!baseline) return true;
  const a = Date.parse(value);
  const b = Date.parse(baseline);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return a >= b;
}

/**
 * 读路径同步不得重置已排定的退避。只有得到 done / stale 等新结论时才覆盖；
 * 仍为 pending/blocked 且原阶段有未来重试时间时，保留原状态与时间。
 */
function keepBackoff(prev, { status, failureReason, nextRetryAt, now }) {
  if (!prev) return { status, failureReason, nextRetryAt };
  if (status === 'done' || status === 'stale') return { status, failureReason, nextRetryAt };
  if (['blocked', 'failed', 'stale'].includes(prev.status)
      && prev.next_retry_at && prev.next_retry_at > now) {
    return {
      status: prev.status,
      failureReason: prev.failure_reason || failureReason,
      nextRetryAt: prev.next_retry_at,
    };
  }
  return { status, failureReason, nextRetryAt };
}

/**
 * 写入/更新一个阶段。attempts 默认保留；显式失败/重试时由调用方递增。
 * @returns {object} 当前阶段行
 */
export function upsertStage({
  objectType = 'content_item', objectId, stage, status, inputHash = null,
  inputVersion = null, sourceLocator = null, completedAt = null, failureReason = null,
  nextRetryAt = null, incrementAttempts = false, attempts: attemptsOverride = null, detail = null,
}) {
  if (!isGovernedObjectType(objectType)) throw new Error(`不支持的处理对象类型：${objectType}`);
  if (!STAGES.includes(stage)) throw new Error(`未知处理阶段：${stage}`);
  if (!['done', 'pending', 'running', 'failed', 'blocked', 'stale', 'skipped'].includes(status)) {
    throw new Error(`未知阶段状态：${status}`);
  }
  if (!objectId) throw new Error('缺少处理对象 ID');
  const now = nowIso();
  const prev = get(
    'SELECT * FROM processing_stage WHERE object_type=? AND object_id=? AND stage=?',
    [objectType, String(objectId), stage]
  );
  const attempts = attemptsOverride !== null && attemptsOverride !== undefined
    ? Math.max(0, Number(attemptsOverride) || 0)
    : Math.max(0, Number(prev?.attempts || 0) + (incrementAttempts ? 1 : 0));
  run(
    `INSERT INTO processing_stage
       (object_type,object_id,stage,status,input_hash,input_version,source_locator,
        completed_at,failure_reason,attempts,next_retry_at,detail_json,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(object_type,object_id,stage) DO UPDATE SET
       status=excluded.status, input_hash=excluded.input_hash, input_version=excluded.input_version,
       source_locator=excluded.source_locator, completed_at=excluded.completed_at,
       failure_reason=excluded.failure_reason, attempts=excluded.attempts,
       next_retry_at=excluded.next_retry_at, detail_json=excluded.detail_json,
       updated_at=excluded.updated_at`,
    [
      objectType, String(objectId), stage, status, inputHash, inputVersion, sourceLocator,
      completedAt, failureReason, attempts, nextRetryAt,
      detail ? j(detail) : (prev?.detail_json || null), prev?.created_at || now, now,
    ]
  );
  return get(
    'SELECT * FROM processing_stage WHERE object_type=? AND object_id=? AND stage=?',
    [objectType, String(objectId), stage]
  );
}

function baseStage(objectType, objectId, stage, status, extra = {}) {
  return {
    objectType, objectId, stage, status,
    inputHash: extra.inputHash ?? null,
    inputVersion: extra.inputVersion ?? null,
    sourceLocator: extra.sourceLocator ?? null,
    completedAt: extra.completedAt ?? null,
    failureReason: extra.failureReason ?? null,
    nextRetryAt: extra.nextRetryAt ?? null,
    incrementAttempts: !!extra.incrementAttempts,
    attempts: extra.attempts ?? null,
    detail: extra.detail ?? null,
  };
}

/**
 * 根据当前真实记录同步五个阶段。summary/verify 的旧结论在正文变更后由
 * invalidateFrom 明确置 stale；本函数只按时间与输入判断是否仍有效。
 */
export function syncContentStages(contentOrId, { invalidate = false, reason = null } = {}) {
  const row = typeof contentOrId === 'string'
    ? get('SELECT * FROM content_item WHERE id=?', [contentOrId])
    : contentOrId;
  if (!row || !row.id) return { ok: false, reason: 'content_not_found' };
  const objectId = row.id;
  const baseline = row.updated_at || row.created_at;
  const now = nowIso();
  const bodyChars = Number(row.body_chars || 0);
  const availability = String(row.body_availability || 'metadata_only');
  const hasBody = bodyChars > 0 || availability === 'full_text' || availability === 'partial';

  // 发现：内容行存在即有真实来源 URL（content_item.source_url NOT NULL）。
  upsertStage(baseStage('content_item', objectId, 'discovered', 'done', {
    inputHash: row.url_hash || null,
    inputVersion: String(row.content_hash || '').slice(0, 16) || null,
    sourceLocator: row.source_url || null,
    completedAt: row.discovered_at || row.created_at || now,
    detail: { published_at: row.published_at || null, record_kind: row.record_kind || null },
  }));

  // 正文获取
  const failedFetch = String(row.process_status || '') === 'failed_fetch';
  upsertStage(baseStage('content_item', objectId, 'fetched',
    failedFetch ? 'failed' : hasBody ? 'done' : 'blocked', {
      inputHash: row.content_hash || null,
      inputVersion: String(row.content_hash || '').slice(0, 16) || null,
      sourceLocator: row.source_url || null,
      completedAt: hasBody && !failedFetch ? (row.collected_at || baseline) : null,
      failureReason: failedFetch
        ? (row.note || '抓取到的正文过短或疑似错误页，未作为正文入库')
        : hasBody ? null : `正文可获得性为 ${availability}：未取得公开全文，不能声称已读原文`,
      nextRetryAt: !hasBody && !failedFetch ? now : null,
      detail: { body_availability: availability, body_chars: bodyChars, snapshot_id: row.snapshot_id || null },
    }));

  // 解析 / OCR：公开内容条目为 HTML/正文文本，无附件 OCR；有正文即完成解析。
  upsertStage(baseStage('content_item', objectId, 'parsed',
    hasBody ? 'done' : availability === 'metadata_only' ? 'blocked' : 'pending', {
      inputHash: row.content_hash || null,
      inputVersion: String(row.content_hash || '').slice(0, 16) || null,
      sourceLocator: row.snapshot_id ? `source_snapshot:${row.snapshot_id}` : (row.source_url || null),
      completedAt: hasBody ? (row.collected_at || baseline) : null,
      failureReason: hasBody ? null : '尚无可解析正文',
      nextRetryAt: hasBody ? null : now,
      detail: {
        parser: 'html_text_normalize',
        body_chars: bodyChars,
        note: '研报/动态条目无 PDF 附件；PDF/OCR 阶段由政策、方法与 CEA 文件链路单独维护。',
      },
    }));

  // 摘要：必须存在 ok 的实体摘要且晚于内容更新时间；否则待处理/失效。
  // 摘要：以**实际输入哈希 + 提示词版本 + 模型键**判断 freshness（summary-svc
  // 的 getSummary 只读，不触发模型）。仅 updated_at 变化但输入未变时不得失效。
  const s = latestSummary(objectId);
  const prevSummaryStage = get(
    "SELECT * FROM processing_stage WHERE object_type='content_item' AND object_id=? AND stage='summarized'",
    [String(objectId)]
  );
  let summaryRead = null;
  try { summaryRead = getSummary('content_item', objectId); } catch { summaryRead = null; }
  const summaryFresh = !!summaryRead && summaryRead.status === 'ok' && !summaryRead.stale;
  let summaryStatus = 'pending';
  let summaryReason = null;
  let summaryRetry = now;
  if (invalidate) {
    summaryStatus = 'stale';
    summaryReason = reason || '正文变更：旧摘要已失效，必须重新生成';
  } else if (summaryFresh) {
    summaryStatus = 'done';
    summaryReason = null;
    summaryRetry = null;
  } else if (s?.status === 'skipped') {
    summaryStatus = 'blocked';
    summaryReason = s.error || '未配置可用模型，摘要未生成';
    summaryRetry = now;
  } else if (s?.status === 'failed') {
    summaryStatus = 'failed';
    summaryReason = s.error || '摘要生成失败';
    summaryRetry = now;
  } else if (s?.status === 'ok') {
    summaryStatus = 'stale';
    summaryReason = summaryRead?.stale_reason || '摘要输入已变化，旧摘要不再对应当前正文';
  }
  const summaryKept = keepBackoff(prevSummaryStage, {
    status: summaryStatus, failureReason: summaryReason, nextRetryAt: summaryRetry, now,
  });
  upsertStage(baseStage('content_item', objectId, 'summarized', summaryKept.status, {
    inputHash: s?.input_hash || row.content_hash || null,
    inputVersion: s?.prompt_version || null,
    sourceLocator: s ? `entity_summary:${s.id}` : null,
    completedAt: summaryKept.status === 'done' ? (s.generated_at || s.updated_at) : null,
    failureReason: summaryKept.failureReason,
    nextRetryAt: summaryKept.nextRetryAt,
    detail: s ? {
      summary_status: s.status, scope_note: s.scope_note || null,
      model: s.model || null, generated_at: s.generated_at || null,
      stale_reason: summaryRead?.stale_reason || null,
    } : null,
  }));

  // 核验：unavailable = 已执行但阻塞；insufficient/conflict/verified = 已完成，
  // 结论字段单独展示，不能因为核验未通过就把阶段写成 done 等于「核验通过」。
  const v = latestVerification(objectId);
  const prevVerifyStage = get(
    "SELECT * FROM processing_stage WHERE object_type='content_item' AND object_id=? AND stage='verified'",
    [String(objectId)]
  );
  // 核验必须同时满足：发生在当前正文之后，且 input_hash 与**当前**核验输入签名
  // 一致（策略/模型/证据/正文任一变化都会改变签名）。只靠时间会被旧签名冒充。
  let verificationFresh = !!v && isAfter(v.created_at, baseline);
  if (verificationFresh) {
    try {
      const current = contentVerificationInput(objectId);
      verificationFresh = !!current
        && v.input_hash_scheme === INPUT_HASH_SCHEME
        && v.input_hash === current.inputHash;
    } catch {
      verificationFresh = false;
    }
  }
  let verifyStatus = 'pending';
  let verifyReason = null;
  let verifyRetry = now;
  if (invalidate) {
    verifyStatus = 'stale';
    verifyReason = reason || '正文变更：旧核验结论已失效，必须重新判断';
    verifyRetry = now;
  } else if (verificationFresh && v.result === 'unavailable') {
    verifyStatus = 'blocked';
    verifyReason = v.capability_note || v.summary || v.error || '核验服务不可用';
  } else if (verificationFresh) {
    verifyStatus = 'done';
    verifyReason = v.result === 'verified' ? null : (v.summary || `核验结论：${v.result}`);
    verifyRetry = null;
  } else if (v) {
    verifyStatus = 'stale';
    verifyReason = '正文在核验后发生变化，旧核验结论不再对应当前正文';
  }
  const verifyKept = keepBackoff(prevVerifyStage, {
    status: verifyStatus, failureReason: verifyReason, nextRetryAt: verifyRetry, now,
  });
  upsertStage(baseStage('content_item', objectId, 'verified', verifyKept.status, {
    inputHash: v?.input_hash || row.content_hash || null,
    inputVersion: v?.model_key || v?.model || null,
    sourceLocator: v ? `verification_result:${v.id}` : (row.source_url || null),
    completedAt: verifyKept.status === 'done' ? v.created_at : null,
    failureReason: verifyKept.failureReason,
    nextRetryAt: verifyKept.nextRetryAt,
    detail: v ? {
      result: v.result, ui_state: v.ui_state, model_used: !!v.model_used,
      evidence_level: v.evidence_level, capability_note: v.capability_note || null,
    } : null,
  }));

  return { ok: true, id: objectId, stages: STAGES.length };
}

/** 正文变更：从摘要开始的所有结论一律失效，并重置重试计数。 */
export function invalidateContentConclusions(id, reason = '正文变更：摘要与核验结论失效') {
  const now = nowIso();
  const row = get('SELECT * FROM content_item WHERE id=?', [id]);
  if (!row) return { ok: false, reason: 'content_not_found' };
  for (const stage of ['summarized', 'verified']) {
    const prev = get(
      'SELECT * FROM processing_stage WHERE object_type=? AND object_id=? AND stage=?',
      ['content_item', String(id), stage]
    );
    if (!prev) {
      upsertStage(baseStage('content_item', String(id), stage, 'stale', {
        inputHash: row.content_hash || null, failureReason: reason,
        nextRetryAt: now, detail: null,
      }));
    } else {
      run(
        `UPDATE processing_stage SET status='stale', completed_at=NULL, failure_reason=?,
           attempts=0, next_retry_at=?, updated_at=?
         WHERE object_type=? AND object_id=? AND stage=?`,
        [reason, now, now, 'content_item', String(id), stage]
      );
    }
  }
  return { ok: true, id, invalidated: ['summarized', 'verified'] };
}

/* ==================================================================== */
/*  跨资料类型的逐条适配器（docs/76）                                     */
/* ==================================================================== */
/*
 * 每个类型只读取真实对应表/附件表，不把摘要或元数据当正文。
 * 下载/解析阶段在结构化数据上不适用时写 skipped 并说明；未知状态保留 blocked/failed。
 */
const objectCount = (sql, params = []) => Number(get(sql, params)?.c || 0);

const CONTENT_SELECT = `ci.title AS title, ci.publisher AS publisher, ci.source_category AS source_category,
  ci.published_at AS published_at, ci.source_url AS source_url, ci.body_availability AS body_availability,
  ci.body_chars AS body_chars, ci.process_status AS process_status, ci.verification_status AS verification_status,
  ci.updated_at AS content_updated_at`;
const POLICY_SELECT = `p.title AS title, p.issuing_authority AS publisher, NULL AS source_category,
  p.publish_date AS published_at, p.official_url AS source_url,
  CASE WHEN p.body_snapshot IS NOT NULL AND length(trim(p.body_snapshot))>0 THEN 'full_text' ELSE 'metadata_only' END AS body_availability,
  COALESCE(length(trim(p.body_snapshot)),0) AS body_chars, NULL AS process_status,
  p.auto_verify_status AS verification_status, p.updated_at AS content_updated_at`;
const METHOD_SELECT = `m.name AS title, m.domain AS publisher, NULL AS source_category,
  m.release_date AS published_at, m.official_url AS source_url,
  CASE WHEN m.body_snapshot IS NOT NULL AND length(trim(m.body_snapshot))>0 THEN 'full_text' ELSE 'metadata_only' END AS body_availability,
  COALESCE(length(trim(m.body_snapshot)),0) AS body_chars, NULL AS process_status,
  m.auto_verify_status AS verification_status, m.updated_at AS content_updated_at`;
const CEA_SELECT = `d.title AS title, d.issuer AS publisher, NULL AS source_category,
  d.publish_date AS published_at, COALESCE(d.official_url,d.page_url) AS source_url,
  d.evidence_level AS body_availability, COALESCE(length(trim(d.body_snapshot)),0) AS body_chars,
  NULL AS process_status, d.ai_status AS verification_status, d.updated_at AS content_updated_at`;
const PROJECT_SELECT = `p.name AS title, p.owner_name AS publisher, NULL AS source_category,
  COALESCE(p.last_checked_at,p.updated_at) AS published_at, p.official_url AS source_url,
  'metadata_only' AS body_availability, 0 AS body_chars, NULL AS process_status,
  p.auto_verify_status AS verification_status, p.updated_at AS content_updated_at`;
const ACCOUNTING_STANDARD_SELECT = `s.title AS title, s.issuer AS publisher, NULL AS source_category,
  COALESCE(s.publish_date,s.issue_date) AS published_at,
  COALESCE(s.original_url,s.announcement_url) AS source_url, s.body_status AS body_availability,
  COALESCE(s.chars,length(trim(s.body_text)),0) AS body_chars, NULL AS process_status,
  s.model_verify_status AS verification_status, s.updated_at AS content_updated_at`;
const ACCOUNTING_PUBLIC_SELECT = `d.title AS title, d.issuer AS publisher, NULL AS source_category,
  d.published_at AS published_at, d.url AS source_url, d.body_status AS body_availability,
  COALESCE(length(trim(d.body_text)),0) AS body_chars, NULL AS process_status,
  d.model_verify_status AS verification_status, d.updated_at AS content_updated_at`;

function attachmentSummary(rows = []) {
  return rows.map((a) => ({
    id: a.id || null,
    file_name: a.file_name || null,
    file_type: a.file_type || null,
    url: a.url || null,
    file_hash: a.file_hash || null,
    has_local_file: !!a.local_path,
    parse_quality: a.parse_quality || null,
    parse_note: a.parse_note ? clip(a.parse_note, 240) : null,
    fetched_at: a.fetched_at || null,
  }));
}

function skipped(stage, reason) {
  return {
    stage, status: 'skipped', failure_reason: reason, next_retry_at: null,
    detail: { applicable: false, reason },
  };
}

function doneOrBlocked(stage, ok, { sourceLocator = null, completedAt = null, failureReason = null, detail = null } = {}) {
  return {
    stage, status: ok ? 'done' : 'blocked', source_locator: sourceLocator,
    completed_at: ok ? (completedAt || nowIso()) : null,
    failure_reason: ok ? null : failureReason,
    next_retry_at: ok ? null : nowIso(),
    detail,
  };
}

function failedStage(stage, { sourceLocator = null, failureReason = null, detail = null } = {}) {
  return {
    stage, status: 'failed', source_locator: sourceLocator, completed_at: null,
    failure_reason: failureReason || '处理失败', next_retry_at: nowIso(), detail,
  };
}

const STAGE_ADAPTERS = {
  content_item: {
    label: '研报与动态', table: 'content_item', alias: 'ci',
    baseWhere: "ci.is_demo=0 AND ci.duplicate_of IS NULL AND ci.record_kind='article'",
    order: 'COALESCE(ci.updated_at,ci.created_at) DESC',
    select: CONTENT_SELECT,
    searchCols: ['ci.title', 'ci.publisher', 'ci.source_url'],
    summarySupported: true, verifyKind: 'content', uploadKind: null, uploadNote: null,
    load: (id) => get('SELECT * FROM content_item WHERE id=?', [String(id)]),
    evidence(row) {
      return {
        title: row.title, source_url: row.source_url, published_at: row.published_at,
        collected_at: row.collected_at, body_availability: row.body_availability,
        body_chars: Number(row.body_chars || 0), content_hash: row.content_hash || null,
        original_hash: null, attachments: [], source_note: '网页正文条目，无 PDF 原件要求',
      };
    },
  },
  policy_document: {
    label: '政策文件', table: 'policy_document', alias: 'p',
    baseWhere: 'p.duplicate_of IS NULL', order: 'COALESCE(p.publish_date,p.updated_at) DESC',
    select: POLICY_SELECT,
    searchCols: ['p.title', 'p.doc_number', 'p.issuing_authority', 'p.official_url'],
    summarySupported: true, verifyKind: 'object', uploadKind: 'policy', uploadNote: null,
    load: (id) => get('SELECT * FROM policy_document WHERE id=?', [String(id)]),
    attachments(id) {
      return all('SELECT * FROM policy_attachment WHERE policy_id=? ORDER BY created_at DESC', [String(id)]);
    },
    stageFacts(row) {
      const body = textOf(row.body_snapshot);
      const attachments = this.attachments(row.id);
      const archived = attachments.find((a) => a.local_path && a.file_hash)
        || (row.local_path && row.original_file_hash ? {
          file_name: 'policy_document.local_path', file_hash: row.original_file_hash,
          local_path: row.local_path, parse_quality: null, url: row.official_url,
        } : null);
      const failed = attachments.find((a) => a.parse_quality === 'failed');
      const fetched = doneOrBlocked('fetched', !!(body || archived), {
        sourceLocator: body ? row.official_url : (archived?.file_hash || null),
        completedAt: archived?.fetched_at || row.collected_at,
        failureReason: attachments.length
          ? '政策正文/附件链接已登记，但未取得可核对正文或本地原件（无文件与 SHA-256）'
          : '未取得政策正文或可下载附件，也未登记可核对的原件',
        detail: {
          body_chars: body.length, attachments: summaryFromAttachmentsForDetail(attachments),
          archived_original: !!archived, body_source: body ? 'policy_document.body_snapshot' : null,
        },
      });
      const parsed = body
        ? doneOrBlocked('parsed', true, {
          sourceLocator: row.local_path ? 'policy_document.local_path' : row.official_url,
          completedAt: row.updated_at, detail: { parser: 'html_or_pdf_text', body_chars: body.length },
        })
        : failed
          ? failedStage('parsed', {
            sourceLocator: failed.file_hash || failed.url || null,
            failureReason: failed.parse_note || '附件已归档，但解析失败（未取得可用正文）',
            detail: { parse_quality: failed.parse_quality || 'failed', attachment_id: failed.id || null },
          })
          : archived
            ? failedStage('parsed', {
              sourceLocator: archived.file_hash || null,
              failureReason: '原件已归档，但解析未取得可用正文（解析失败/未完成）',
              detail: { parse_quality: archived.parse_quality || null },
            })
            : doneOrBlocked('parsed', false, {
              failureReason: attachments.length
                ? '原件尚未获取，不能进入解析阶段'
                : '没有可解析的正文或原件',
              detail: { parse_quality: null },
            });
      return {
        discovered: {
          status: 'done', source_locator: row.official_url || null,
          completed_at: row.collected_at || row.created_at,
          detail: { doc_number: row.doc_number || null, doc_status: row.doc_status || null, attachments: attachments.length },
        },
        fetched, parsed,
        bodyAvailability: body ? 'full_text' : 'metadata_only',
        bodyChars: body.length,
      };
    },
    evidence(row) {
      const attachments = this.attachments(row.id);
      return {
        title: row.title, source_url: row.official_url, published_at: row.publish_date,
        collected_at: row.collected_at, body_availability: textOf(row.body_snapshot) ? 'full_text' : 'metadata_only',
        body_chars: textOf(row.body_snapshot).length,
        content_hash: row.original_file_hash || null, original_hash: row.original_file_hash || null,
        local_file: !!row.local_path, attachments: attachmentSummary(attachments),
        source_note: '政策网页正文与 PDF 附件分别记录；附件登记不等于原件已归档',
      };
    },
  },
  methodology_version: {
    label: '方法学版本', table: 'methodology_version', alias: 'm',
    baseWhere: '1=1', order: 'COALESCE(m.release_date,m.updated_at) DESC',
    select: METHOD_SELECT,
    searchCols: ['m.name', 'm.code_display', 'm.methodology_id', 'm.official_url'],
    summarySupported: true, verifyKind: 'object', uploadKind: 'methodology', uploadNote: null,
    load: (id) => get('SELECT * FROM methodology_version WHERE id=?', [String(id)]),
    stageFacts(row) {
      const body = textOf(row.body_snapshot);
      const hasOriginal = !!(row.original_file_hash || row.original_file_path);
      const fetched = doneOrBlocked('fetched', !!(body || hasOriginal), {
        sourceLocator: row.original_file_hash || (row.original_file_path ? 'methodology_version.original_file_path' : row.official_url),
        completedAt: row.updated_at,
        failureReason: '尚未取得方法学正文，也未归档官方原件（无文件哈希）',
        detail: { body_chars: body.length, original_file_hash: row.original_file_hash || null, has_local_file: !!row.original_file_path },
      });
      const parsed = body
        ? doneOrBlocked('parsed', true, {
          sourceLocator: row.original_file_path ? 'methodology_version.original_file_path' : row.official_url,
          completedAt: row.updated_at, detail: { parser: 'pdf_text_or_html', body_chars: body.length },
        })
        : hasOriginal
          ? failedStage('parsed', {
            sourceLocator: row.original_file_hash || row.original_file_path,
            failureReason: '方法学原件已归档，但正文解析未取得可用文本',
            detail: { original_file_hash: row.original_file_hash || null },
          })
          : doneOrBlocked('parsed', false, {
            failureReason: '原件尚未获取，不能进入解析阶段',
            detail: { parse_quality: null },
          });
      return {
        discovered: {
          status: 'done', source_locator: row.official_url || null,
          completed_at: row.created_at,
          detail: { code_display: row.code_display || null, document_status: row.document_status || null },
        },
        fetched, parsed,
        bodyAvailability: body ? 'full_text' : 'metadata_only',
        bodyChars: body.length,
      };
    },
    evidence(row) {
      return {
        title: row.name, source_url: row.official_url, published_at: row.release_date,
        collected_at: row.created_at, body_availability: textOf(row.body_snapshot) ? 'full_text' : 'metadata_only',
        body_chars: textOf(row.body_snapshot).length,
        content_hash: row.original_file_hash || null, original_hash: row.original_file_hash || null,
        local_file: !!row.original_file_path, attachments: [],
        source_note: '方法学正文与官方 PDF 原件哈希分列；原件存在不等于正文已提取',
      };
    },
  },
  cea_document: {
    label: 'CEA 公开文件', table: 'cea_document', alias: 'd',
    baseWhere: '1=1', order: 'COALESCE(d.publish_date,d.updated_at) DESC',
    select: CEA_SELECT,
    searchCols: ['d.title', 'd.doc_number', 'd.issuer', 'd.official_url', 'd.page_url'],
    summarySupported: true, verifyKind: 'object', uploadKind: 'cea_document', uploadNote: null,
    load: (id) => get('SELECT * FROM cea_document WHERE id=?', [String(id)]),
    stageFacts(row) {
      const body = textOf(row.body_snapshot);
      const hasOriginal = !!(row.attachment_hash || row.attachment_path);
      const fetched = doneOrBlocked('fetched', !!(body || hasOriginal), {
        sourceLocator: row.attachment_hash || (row.attachment_path ? 'cea_document.attachment_path' : (row.official_url || row.page_url)),
        completedAt: row.fetched_at || row.updated_at,
        failureReason: '已登记官方链接，但未取得可核对正文或附件原件',
        detail: { body_chars: body.length, attachment_hash: row.attachment_hash || null, has_attachment: !!row.attachment_path },
      });
      const parsed = body
        ? doneOrBlocked('parsed', true, {
          sourceLocator: row.attachment_path ? 'cea_document.attachment_path' : (row.official_url || row.page_url),
          completedAt: row.updated_at, detail: { parser: 'html_or_pdf_text', body_chars: body.length, evidence_level: row.evidence_level || null },
        })
        : hasOriginal
          ? failedStage('parsed', {
            sourceLocator: row.attachment_hash || row.attachment_path,
            failureReason: 'CEA 附件已归档，但正文解析未取得可用文本',
            detail: { evidence_level: row.evidence_level || null, attachment_hash: row.attachment_hash || null },
          })
          : doneOrBlocked('parsed', false, {
            failureReason: '原件尚未获取，不能进入解析阶段',
            detail: { evidence_level: row.evidence_level || null },
          });
      return {
        discovered: {
          status: 'done', source_locator: row.official_url || row.page_url || null,
          completed_at: row.fetched_at || row.created_at,
          detail: { doc_type: row.doc_type || null, doc_status: row.doc_status || null, count_in_stats: row.count_in_stats ?? null },
        },
        fetched, parsed,
        bodyAvailability: body ? (row.evidence_level || 'full_text') : 'metadata_only',
        bodyChars: body.length,
      };
    },
    evidence(row) {
      return {
        title: row.title, source_url: row.official_url || row.page_url || null,
        published_at: row.publish_date, collected_at: row.fetched_at || row.created_at,
        body_availability: row.evidence_level || 'metadata_only', body_chars: textOf(row.body_snapshot).length,
        content_hash: row.content_hash || null, original_hash: row.attachment_hash || null,
        local_file: !!row.attachment_path, attachments: [],
        source_note: 'CEA 正文/官方附件哈希来自 cea_document 真实字段',
      };
    },
  },
  public_project: {
    label: '公开项目', table: 'public_project', alias: 'p',
    baseWhere: 'COALESCE(p.is_demo,0)=0', order: 'COALESCE(p.last_checked_at,p.updated_at) DESC',
    select: PROJECT_SELECT,
    searchCols: ['p.name', 'p.registry_project_no', 'p.owner_name', 'p.official_url'],
    summarySupported: true, verifyKind: 'object', uploadKind: null,
    uploadNote: '公开项目是结构化登记字段，不适用 PDF 原件补传；缺少正文时只能补公开字段或等待登记系统更新。',
    load: (id) => get('SELECT * FROM public_project WHERE id=?', [String(id)]),
    stageFacts(row) {
      const skipReason = '不适用：公开项目为结构化登记字段，无 PDF 正文下载/解析阶段';
      return {
        discovered: {
          status: 'done', source_locator: row.official_url || row.registry_project_no || null,
          completed_at: row.created_at,
          detail: { registry_project_no: row.registry_project_no || null, evidence_level: row.evidence_level || null },
        },
        fetched: skipped('fetched', skipReason),
        parsed: skipped('parsed', skipReason),
        bodyAvailability: 'metadata_only',
        bodyChars: 0,
      };
    },
    evidence(row) {
      return {
        title: row.name, source_url: row.official_url || null,
        published_at: row.last_checked_at || row.updated_at, collected_at: row.created_at,
        body_availability: 'metadata_only', body_chars: 0, content_hash: null, original_hash: null,
        local_file: false, attachments: [],
        source_note: '仅公开登记字段；摘要限定于这些字段，核验不足保持 insufficient',
      };
    },
  },
  accounting_standard: {
    label: '标准规范', table: 'accounting_standard', alias: 's',
    baseWhere: '1=1', order: "COALESCE(s.publish_date,s.updated_at) DESC",
    select: ACCOUNTING_STANDARD_SELECT,
    searchCols: ['s.title', 's.code', 's.issuer'],
    summarySupported: true, verifyKind: 'accounting', uploadKind: null,
    uploadSupported: true,
    uploadNote: '标准原件补传使用「碳核算资料」页签的 PDF 上传/解析入口；治理页不另建写库路径。',
    uploadTab: 'accounting',
    load: (id) => get('SELECT * FROM accounting_standard WHERE id=?', [String(id)]),
    stageFacts(row) {
      const body = textOf(row.body_text);
      const status = String(row.body_status || 'metadata_only');
      const hasOriginal = !!(row.sha256 || row.original_sha256);
      const fetched = doneOrBlocked('fetched', !!(body || hasOriginal), {
        sourceLocator: row.sha256 || row.original_url || row.announcement_url || null,
        completedAt: row.updated_at,
        failureReason: '已登记公告/原文链接，但尚未取得标准正文或原件哈希',
        detail: { body_chars: body.length, body_status: status, sha256: row.sha256 || null, pages_total: row.pages_total ?? null },
      });
      let parsed;
      if (body && ['full', 'partial'].includes(status)) {
        parsed = doneOrBlocked('parsed', true, {
          sourceLocator: row.sha256 || row.original_url || row.announcement_url || null,
          completedAt: row.updated_at,
          detail: { parser: 'pdf_text_or_html', body_status: status, body_chars: body.length, extraction_complete: Number(row.extraction_complete || 0) === 1 },
        });
      } else if (body) {
        parsed = doneOrBlocked('parsed', true, {
          sourceLocator: row.sha256 || row.original_url || row.announcement_url || null,
          completedAt: row.updated_at,
          detail: { parser: 'pdf_text_or_html', body_status: status, body_chars: body.length, note: '正文存在但状态字段未标 full/partial，按实际正文记录并保留原状态' },
        });
      } else if (hasOriginal || status === 'unavailable') {
        parsed = failedStage('parsed', {
          sourceLocator: row.sha256 || null,
          failureReason: status === 'unavailable'
            ? '原件/正文当前不可用（unavailable），未取得可解析文本'
            : '标准原件哈希已存在，但正文解析未取得可用文本（body_status=metadata_only）',
          detail: { body_status: status, sha256: row.sha256 || null },
        });
      } else {
        parsed = doneOrBlocked('parsed', false, {
          failureReason: '正文/原件尚未获取，不能进入解析阶段', detail: { body_status: status },
        });
      }
      return {
        discovered: {
          status: 'done', source_locator: row.original_url || row.announcement_url || null,
          completed_at: row.created_at,
          detail: { code: row.code || null, standard_type: row.standard_type || null, status: row.status || null },
        },
        fetched, parsed,
        bodyAvailability: status,
        bodyChars: body.length,
      };
    },
    evidence(row) {
      return {
        title: row.title, source_url: row.original_url || row.announcement_url || null,
        published_at: row.publish_date || row.issue_date, collected_at: row.created_at,
        body_availability: row.body_status || 'metadata_only',
        body_chars: textOf(row.body_text).length,
        content_hash: row.content_hash || null, original_hash: row.sha256 || row.original_sha256 || null,
        local_file: false, attachments: [],
        source_note: '正文/原件 SHA-256 来自 accounting_standard；只有 full/partial 正文可进入模型核验',
      };
    },
  },
  accounting_public_document: {
    label: '公开资料与问答', table: 'accounting_public_document', alias: 'd',
    baseWhere: '1=1', order: "COALESCE(d.published_at,d.updated_at) DESC",
    select: ACCOUNTING_PUBLIC_SELECT,
    searchCols: ['d.title', 'd.url'],
    summarySupported: true, verifyKind: 'accounting', uploadKind: null,
    uploadSupported: false,
    uploadNote: '公开网页/问答没有 PDF 补传入口；失败时使用「碳核算资料」页签的公开资料采集重试。',
    uploadTab: 'accounting',
    load: (id) => get('SELECT * FROM accounting_public_document WHERE id=?', [String(id)]),
    stageFacts(row) {
      const body = textOf(row.body_text);
      const status = String(row.body_status || 'metadata_only');
      const hasSnapshot = !!(row.snapshot_path || row.content_hash || row.captured_at);
      const fetched = doneOrBlocked('fetched', !!(body || hasSnapshot), {
        sourceLocator: row.content_hash || row.snapshot_path || row.url || null,
        completedAt: row.captured_at || row.updated_at,
        failureReason: '仅登记公开 URL，尚未取得页面正文或快照',
        detail: { body_chars: body.length, body_status: status, content_hash: row.content_hash || null },
      });
      let parsed;
      if (body) {
        parsed = doneOrBlocked('parsed', true, {
          sourceLocator: row.content_hash || row.snapshot_path || row.url || null,
          completedAt: row.captured_at || row.updated_at,
          detail: {
            parser: 'fetched_html_structure', body_status: status, body_chars: body.length,
            note: status === 'index_only' ? '目录/索引页解析完成，但未取得详情正文，不能当作全文' : null,
          },
        });
      } else if (status === 'index_only') {
        parsed = doneOrBlocked('parsed', true, {
          sourceLocator: row.content_hash || row.snapshot_path || row.url || null,
          completedAt: row.captured_at || row.updated_at,
          detail: { body_status: status, note: '目录/索引页解析完成，未取得详情正文' },
        });
      } else if (status === 'unavailable' || hasSnapshot) {
        parsed = failedStage('parsed', {
          sourceLocator: row.content_hash || row.snapshot_path || row.url || null,
          failureReason: status === 'unavailable'
            ? '公开资料当前不可用（unavailable），未取得可解析正文'
            : '页面快照/哈希已存在，但正文解析未取得可用文本（metadata_only）',
          detail: { body_status: status, content_hash: row.content_hash || null },
        });
      } else {
        parsed = doneOrBlocked('parsed', false, {
          failureReason: '正文/快照尚未获取，不能进入解析阶段', detail: { body_status: status },
        });
      }
      return {
        discovered: {
          status: 'done', source_locator: row.url || null, completed_at: row.created_at,
          detail: { doc_type: row.doc_type || null, category: row.category || null, source_code: row.source_code || null },
        },
        fetched, parsed,
        bodyAvailability: status,
        bodyChars: body.length,
      };
    },
    evidence(row) {
      return {
        title: row.title, source_url: row.url || null, published_at: row.published_at,
        collected_at: row.captured_at || row.created_at,
        body_availability: row.body_status || 'metadata_only',
        body_chars: textOf(row.body_text).length,
        content_hash: row.content_hash || null, original_hash: row.content_hash || null,
        local_file: !!row.snapshot_path, attachments: [],
        source_note: '公开网页/问答；目录页与详情全文分列，不把索引当全文',
      };
    },
  },
};

function summaryFromAttachmentsForDetail(rows) {
  return attachmentSummary(rows).slice(0, 20);
}

/** 读取某类型的真实证据摘要（后台详情用）。 */
export function objectEvidence(objectType, rowOrId) {
  const adapter = STAGE_ADAPTERS[objectType];
  if (!adapter) return null;
  const row = typeof rowOrId === 'string' ? adapter.load(rowOrId) : rowOrId;
  if (!row) return null;
  try { return adapter.evidence(row); } catch { return null; }
}

/** 某类型是否支持摘要 / 核验 / 原件补传（不把“未支持”写成已完成）。 */
export function objectCapabilities(objectType) {
  const adapter = STAGE_ADAPTERS[objectType];
  if (!adapter) return null;
  return {
    object_type: objectType,
    label: adapter.label,
    summary_supported: !!adapter.summarySupported,
    verification_supported: adapter.verifyKind !== 'unsupported',
    verification_mode: adapter.verifyKind,
    upload_supported: adapter.uploadSupported !== undefined
      ? !!adapter.uploadSupported : !!adapter.uploadKind,
    upload_kind: adapter.uploadKind || null,
    upload_tab: adapter.uploadTab || null,
    upload_note: adapter.uploadNote || null,
  };
}

export function objectAdapterMeta(objectType) {
  const adapter = STAGE_ADAPTERS[objectType];
  if (!adapter) return null;
  return {
    object_type: objectType, label: adapter.label, table: adapter.table, alias: adapter.alias,
    baseWhere: adapter.baseWhere, order: adapter.order, select: adapter.select,
    searchCols: adapter.searchCols, uploadKind: adapter.uploadKind,
  };
}

export function governedAdapters() {
  return Object.keys(STAGE_ADAPTERS);
}

/** 读取白名单类型的真实业务行（后台详情用；表名硬编码在适配器内）。 */
export function loadGovernedObject(objectType, objectId) {
  const adapter = STAGE_ADAPTERS[objectType];
  return adapter ? adapter.load(objectId) : null;
}

function upsertFactsStage(objectType, objectId, fact) {
  return upsertStage({
    objectType, objectId, stage: fact.stage, status: fact.status,
    inputHash: fact.input_hash || null, inputVersion: fact.input_version || null,
    sourceLocator: fact.source_locator || null, completedAt: fact.completed_at || null,
    failureReason: fact.failure_reason || null, nextRetryAt: fact.next_retry_at || null,
    attempts: fact.attempts ?? null, detail: fact.detail ?? null,
  });
}

/**
 * 通用逐条阶段同步。content_item 沿用既有 syncContentStages（124/140 兼容）；
 * 其它类型只从真实表/附件表推导，正文变化会把摘要/核验置 stale 并清零自动重试。
 */
export function syncObjectStages(objectType, rowOrId, { invalidate = false, reason = null } = {}) {
  if (objectType === 'content_item') return syncContentStages(rowOrId, { invalidate, reason });
  const adapter = STAGE_ADAPTERS[objectType];
  if (!adapter) return { ok: false, reason: 'unsupported_object_type', object_type: objectType };
  const row = typeof rowOrId === 'string' ? adapter.load(rowOrId) : rowOrId;
  if (!row || !row.id) return { ok: false, reason: 'object_not_found', object_type: objectType };
  const objectId = row.id;
  const facts = adapter.stageFacts(row);
  const now = nowIso();
  const bodyHashValue = bodyHash(row);

  upsertFactsStage(objectType, objectId, {
    stage: 'discovered', ...facts.discovered,
    input_hash: row.registry_project_no || row.doc_number || row.code || row.url || null,
    input_version: String(row.updated_at || '').slice(0, 19) || null,
  });
  upsertFactsStage(objectType, objectId, {
    stage: 'fetched', ...facts.fetched,
    input_hash: facts.fetched.status === 'done' ? bodyHashValue : null,
    input_version: String(row.updated_at || '').slice(0, 19) || null,
  });
  upsertFactsStage(objectType, objectId, {
    stage: 'parsed', ...facts.parsed,
    input_hash: facts.parsed.status === 'done' ? bodyHashValue : null,
    input_version: String(row.updated_at || '').slice(0, 19) || null,
  });

  /* ---- 摘要：只读 summary-svc，按实际输入哈希/提示词/模型键判断 ---- */
  const { hash: currentSummaryHash } = summaryInputSafe(objectType, objectId);
  const summaryRead = summaryReadSafe(objectType, objectId);
  const prevSummary = get(
    "SELECT * FROM processing_stage WHERE object_type=? AND object_id=? AND stage='summarized'",
    [objectType, String(objectId)]
  );
  const summaryFresh = !!summaryRead && summaryRead.status === 'ok' && !summaryRead.stale;
  const summaryInputChanged = !!(prevSummary?.input_hash && currentSummaryHash
    && prevSummary.input_hash !== currentSummaryHash
    && !['pending', 'running'].includes(prevSummary.status));
  let summaryStatus = 'pending';
  let summaryReason = null;
  let summaryRetry = now;
  let summaryReset = false;
  if (invalidate) {
    summaryStatus = 'stale';
    summaryReason = reason || '正文/输入变化：旧摘要已失效';
    summaryReset = true;
  } else if (summaryFresh) {
    summaryStatus = 'done';
    summaryReason = null;
    summaryRetry = null;
  } else if (summaryRead?.stale) {
    summaryStatus = 'stale';
    summaryReason = summaryRead.stale_reason || '摘要输入已变化，旧摘要不再对应当前正文/字段';
    // 只有“本阶段已记录的输入哈希”与当前输入不同才重置尝试；
    // 旧缓存已 stale 但输入未再变化时，重复读路径必须保留退避与尝试次数。
    summaryReset = summaryInputChanged;
  } else if (summaryInputChanged) {
    summaryStatus = 'stale';
    summaryReason = '正文/元数据输入已变化：旧摘要失效，需重新生成';
    summaryReset = true;
  } else if (summaryRead?.status === 'skipped') {
    summaryStatus = 'blocked';
    summaryReason = summaryRead.error || '未配置可用模型，摘要未生成';
  } else if (summaryRead?.status === 'failed') {
    summaryStatus = 'failed';
    summaryReason = summaryRead.error || '摘要生成失败';
  } else if (summaryRead?.status === 'ok') {
    summaryStatus = 'stale';
    summaryReason = '摘要输入与当前记录不一致，需重新生成';
    summaryReset = true;
  }
  const summaryKept = keepBackoff(prevSummary, {
    status: summaryStatus, failureReason: summaryReason, nextRetryAt: summaryRetry, now,
  });
  if (summaryKept.status === 'stale' && !summaryInputChanged
      && prevSummary?.next_retry_at && prevSummary.next_retry_at > now) {
    summaryKept.nextRetryAt = prevSummary.next_retry_at;
    summaryKept.failureReason = prevSummary.failure_reason || summaryKept.failureReason;
  }
  if (summaryReset && summaryKept.status !== 'done') {
    summaryKept.attempts = 0;
    summaryKept.nextRetryAt = now;
  }
  upsertStage({
    objectType, objectId, stage: 'summarized', status: summaryKept.status,
    inputHash: currentSummaryHash || summaryRead?.input_hash || null,
    inputVersion: summaryRead?.prompt_version || null,
    sourceLocator: summaryRead?.generated_at ? `entity_summary:${objectType}:${objectId}` : null,
    completedAt: summaryKept.status === 'done' ? (summaryRead.generated_at || summaryRead.updated_at) : null,
    failureReason: summaryKept.failureReason, nextRetryAt: summaryKept.nextRetryAt,
    attempts: summaryKept.attempts ?? null,
    detail: {
      summary_status: summaryRead?.status || null,
      scope_note: summaryRead?.scope_note || null,
      input_kind: summaryRead?.input_kind || null,
      freshness_checked: !!summaryRead?.input_verified,
      stale_reason: summaryRead?.stale_reason || null,
    },
  });

  /* ---- 核验：必须匹配当前输入签名（含策略/模型/证据） ---- */
  const currentVerify = currentVerification(objectType, row);
  const v = get(
    'SELECT * FROM verification_result WHERE object_type=? AND object_id=? ORDER BY created_at DESC LIMIT 1',
    [objectType, String(objectId)]
  );
  let verifyFresh = false;
  if (currentVerify.supported && v) {
    verifyFresh = !!currentVerify.inputHash && v.input_hash === currentVerify.inputHash;
    if (verifyFresh && currentVerify.hashScheme) {
      verifyFresh = v.input_hash_scheme === currentVerify.hashScheme;
    }
    if (verifyFresh && currentVerify.modelKey !== null && currentVerify.modelKey !== undefined) {
      verifyFresh = (v.model_key || 'none') === currentVerify.modelKey;
    }
  }
  const prevVerify = get(
    "SELECT * FROM processing_stage WHERE object_type=? AND object_id=? AND stage='verified'",
    [objectType, String(objectId)]
  );
  const verifyInputChanged = !!(prevVerify?.input_hash && currentVerify.inputHash
    && prevVerify.input_hash !== currentVerify.inputHash
    && !['pending', 'running'].includes(prevVerify.status));
  let verifyStatus = 'pending';
  let verifyReason = null;
  let verifyRetry = now;
  let verifyReset = false;
  if (!currentVerify.supported) {
    verifyStatus = 'blocked';
    verifyReason = currentVerify.reason || '该资料类型暂无核验适配器';
    verifyRetry = null;
  } else if (invalidate) {
    verifyStatus = 'stale';
    verifyReason = reason || '正文/输入变化：旧核验结论已失效';
    verifyReset = true;
  } else if (verifyFresh && v.result === 'unavailable') {
    verifyStatus = 'blocked';
    verifyReason = v.capability_note || v.summary || v.error || '核验服务不可用';
  } else if (verifyFresh) {
    verifyStatus = 'done';
    verifyReason = v.result === 'verified' ? null : (v.summary || `核验结论：${v.result}`);
    verifyRetry = null;
  } else if (v || verifyInputChanged) {
    verifyStatus = 'stale';
    verifyReason = verifyInputChanged
      ? '正文/元数据/策略/模型输入已变化：旧核验结论失效，需重新判断'
      : '当前输入签名与最近核验不一致，旧结论不再对应当前记录';
    // 与摘要同样：旧结论 stale 本身不重置退避；只有当前输入再次变化才清零。
    verifyReset = verifyInputChanged;
  }
  const verifyKept = keepBackoff(prevVerify, {
    status: verifyStatus, failureReason: verifyReason, nextRetryAt: verifyRetry, now,
  });
  if (verifyKept.status === 'stale' && !verifyInputChanged
      && prevVerify?.next_retry_at && prevVerify.next_retry_at > now) {
    verifyKept.nextRetryAt = prevVerify.next_retry_at;
    verifyKept.failureReason = prevVerify.failure_reason || verifyKept.failureReason;
  }
  if (verifyReset && verifyKept.status !== 'done') {
    verifyKept.attempts = 0;
    verifyKept.nextRetryAt = now;
  }
  upsertStage({
    objectType, objectId, stage: 'verified', status: verifyKept.status,
    inputHash: currentVerify.inputHash || v?.input_hash || null,
    inputVersion: v?.model_key || v?.model || currentVerify.modelKey || null,
    sourceLocator: v ? `verification_result:${v.id}` : (currentVerify.supported ? 'pending_adapter' : 'unsupported'),
    completedAt: verifyKept.status === 'done' ? v.created_at : null,
    failureReason: verifyKept.failureReason, nextRetryAt: verifyKept.nextRetryAt,
    attempts: verifyKept.attempts ?? null,
    detail: {
      result: v?.result || null,
      verification_mode: currentVerify.mode || null,
      supported: !!currentVerify.supported,
      input_hash_match: verifyFresh,
      model_key: currentVerify.modelKey || null,
      input_hash_scheme: v?.input_hash_scheme || null,
      evidence_level: v?.evidence_level || null,
      capability_note: v?.capability_note || currentVerify.reason || null,
    },
  });
  return { ok: true, object_type: objectType, id: objectId, stages: STAGES.length };
}

/** 通用失效：输入变化后摘要/核验置 stale、尝试次数归零。 */
export function invalidateObjectConclusions(objectType, objectId, reason = '正文/输入变更：摘要与核验结论失效') {
  if (objectType === 'content_item') return invalidateContentConclusions(objectId, reason);
  if (!isGovernedObjectType(objectType)) return { ok: false, reason: 'unsupported_object_type' };
  const adapter = STAGE_ADAPTERS[objectType];
  const row = adapter?.load(objectId);
  if (!row) return { ok: false, reason: 'object_not_found' };
  const now = nowIso();
  for (const stage of ['summarized', 'verified']) {
    const prev = get(
      'SELECT * FROM processing_stage WHERE object_type=? AND object_id=? AND stage=?',
      [objectType, String(objectId), stage]
    );
    if (!prev) {
      upsertStage({
        objectType, objectId, stage, status: 'stale', failureReason: reason,
        nextRetryAt: now, attempts: 0, detail: null,
      });
    } else {
      run(
        `UPDATE processing_stage SET status='stale', completed_at=NULL, failure_reason=?,
           attempts=0, next_retry_at=?, updated_at=?
         WHERE object_type=? AND object_id=? AND stage=?`,
        [reason, now, now, objectType, String(objectId), stage]
      );
    }
  }
  return { ok: true, object_type: objectType, id: objectId, invalidated: ['summarized', 'verified'] };
}

/** 给最近条目补建阶段行（支持跨类型；默认保持 content 兼容）。 */
export function syncRecentStages({ objectTypes = GOVERNED_OBJECT_TYPES, limit = 100 } = {}) {
  const types = [...new Set(objectTypes)].filter((t) => STAGE_ADAPTERS[t]);
  const max = Math.max(1, Math.min(Number(limit) || 100, 500));
  const out = { synced: 0, total: 0, missing_synced: 0, by_type: {} };
  for (const objectType of types) {
    const adapter = STAGE_ADAPTERS[objectType];
    const missing = all(
      `SELECT ${adapter.alias}.id FROM ${adapter.table} ${adapter.alias}
        WHERE ${adapter.baseWhere}
          AND NOT EXISTS (
            SELECT 1 FROM processing_stage st
             WHERE st.object_type=? AND st.object_id=${adapter.alias}.id
          )
        ORDER BY ${adapter.order} LIMIT ?`,
      [objectType, max]
    );
    const rows = missing.map((r) => r.id);
    const remain = max - rows.length;
    if (remain > 0) {
      rows.push(...all(
        `SELECT ${adapter.alias}.id FROM ${adapter.table} ${adapter.alias}
          WHERE ${adapter.baseWhere}
            AND EXISTS (
              SELECT 1 FROM processing_stage st
               WHERE st.object_type=? AND st.object_id=${adapter.alias}.id
            )
          ORDER BY ${adapter.order} LIMIT ?`,
        [objectType, remain]
      ).map((r) => r.id));
    }
    let synced = 0;
    for (const id of rows) {
      try { if (syncObjectStages(objectType, id).ok) synced += 1; } catch { /* 单条失败不阻塞漏斗 */ }
    }
    out.synced += synced;
    out.total += rows.length;
    out.missing_synced += missing.length;
    out.by_type[objectType] = { synced, total: rows.length, missing: missing.length };
  }
  return out;
}

/**
 * 兼容包装（docs/74/124/140）：内容条目的阶段同步接口保持不变。
 * 新代码应使用 syncRecentStages / syncObjectStages 并显式携带 object_type。
 */
export function syncRecentContent({ limit = 100 } = {}) {
  return syncRecentStages({ objectTypes: ['content_item'], limit });
}

/** 记录一次处理尝试（供治理处理器/后台重试使用）。 */
export function recordStageAttempt({ objectType = 'content_item', objectId, stage, status, failureReason = null, nextRetryAt = null, detail = null }) {
  const prev = get(
    'SELECT * FROM processing_stage WHERE object_type=? AND object_id=? AND stage=?',
    [objectType, String(objectId), stage]
  );
  return upsertStage({
    objectType, objectId, stage, status,
    inputHash: prev?.input_hash || null,
    inputVersion: prev?.input_version || null,
    sourceLocator: prev?.source_locator || null,
    completedAt: status === 'done' ? nowIso() : null,
    failureReason, nextRetryAt, incrementAttempts: true, detail,
  });
}

export function getObjectStages(objectType, id) {
  const rows = all(
    'SELECT * FROM processing_stage WHERE object_type=? AND object_id=? ORDER BY CASE stage ' +
    "WHEN 'discovered' THEN 1 WHEN 'fetched' THEN 2 WHEN 'parsed' THEN 3 WHEN 'summarized' THEN 4 WHEN 'verified' THEN 5 ELSE 9 END",
    [String(objectType), String(id)]
  );
  return rows.map((r) => ({ ...r, detail: uj(r.detail_json, null) }));
}

/** 兼容包装：content_item 阶段明细。objectType 参数保留为显式隔离键。 */
export function getContentStages(id, objectType = 'content_item') {
  return getObjectStages(objectType, id);
}

export { isContentType, newId };
