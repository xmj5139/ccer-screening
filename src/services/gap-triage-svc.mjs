/**
 * 缺口分类与受控单条动作（docs/80 B）
 * ============================================================================
 * 只做确定性分类：从既有 data_gap、processing_stage 与真实附件/正文状态读取依据，
 * 不调用模型猜“是否关闭”。动作只复用现有采集、正文修复、OCR/PDF 重解析和摘要队列；
 * 没有单条能力时明确 unsupported，不把空按钮当“重试”。
 *
 * 结清纪律：
 *   · 抓取成功但解析失败不结清（由服务结果决定）；
 *   · 摘要只入队/重试不等于生成成功，摘要失败不结清；
 *   · 非目标页只按确定性规则记录排除并把同 URL 历史 parse gap 标为 mitigated；
 *   · 未知/空/访问失败、缺交易日、累计差异、原始冲突保持真实缺口。
 */
import { all, get, run, audit } from '../core/db.mjs';
import { nowIso, j } from '../core/util.mjs';
import { requireRole } from './project-svc.mjs';
import * as summary from './summary-svc.mjs';
import { detectCeaNonTargetPage, validEntityCreditCode } from './cea-parse.mjs';
import { recordCeaPageExclusion } from './cea-svc.mjs';

export const GAP_CATEGORIES = {
  access_failed: {
    label: '下载/访问失败',
    auto_action: '用既有抓取/CEA 日报采集入口按同一 URL 单条重试；只有取得正文并成功解析入库才结清。',
    retryable: true, blocking: true, tone: 'danger',
  },
  dynamic_partial: {
    label: '动态页/正文不全',
    auto_action: '用既有正文补采或 PDF/OCR 重解析继续取正文；仍非全文则保留缺口，不声称已读全文。',
    retryable: true, blocking: true, tone: 'warn',
  },
  pdf_unparsed: {
    label: 'PDF 已下载未解析',
    auto_action: '只对受限根内的本地 PDF 调用既有逐页解析/OCR；取得可用正文才结清。',
    retryable: true, blocking: true, tone: 'warn',
  },
  ocr_failed: {
    label: 'OCR 失败',
    auto_action: '复用 OCR/PDF 补跑能力单条重试；未配置 OCR 或仍无文字时保留缺口。',
    retryable: true, blocking: true, tone: 'warn',
  },
  summary_pending: {
    label: '摘要待办/失败',
    auto_action: '进入持久摘要队列并按输入签名/模型键去重；摘要失败或有模型未配置不结清缺口。',
    retryable: true, blocking: false, tone: 'warn',
  },
  verification_second_source: {
    label: '核验需第二来源',
    auto_action: '需要第二公开来源或当前输入签名下的核验结果；系统不伪造来源，不自动关闭。',
    retryable: false, blocking: false, tone: 'warn',
  },
  raw_conflict: {
    label: '原始事实冲突',
    auto_action: '保留冲突与原始出处，等待后续官方原文或同一来源/日期的证据消除；不以模型判断关闭。',
    retryable: false, blocking: true, tone: 'danger',
  },
  source_not_public: {
    label: '来源未公开',
    auto_action: '保留“来源未公开”空态；没有公开原文与授权副本时不自动补写。',
    retryable: false, blocking: true, tone: 'warn',
  },
  non_target: {
    label: '非目标页',
    auto_action: '按标题/主内容确定性规则记录来源、快照与排除规则；不建行情行，同 URL 缺口停止重复重试。',
    retryable: false, blocking: false, tone: 'muted',
  },
  optional_field: {
    label: '可选字段异常',
    auto_action: '字段级非阻塞提示；保留原始值，标准值留空，不猜测补齐，整条记录仍计入。',
    retryable: false, blocking: false, tone: 'muted',
  },
  missing_trade_date: {
    label: '交易日期缺失',
    auto_action: '按原文/官方目录重新确认日期；仍无日期则保留缺口，不用采集日兜底、不补 0。',
    retryable: true, blocking: true, tone: 'warn',
  },
  cumulative_mismatch: {
    label: '累计差异',
    auto_action: '保留累计差异和来源快照；不按单日值反推累计，不用模型抹平。',
    retryable: false, blocking: true, tone: 'warn',
  },
  unknown: {
    label: '未分类/待补证',
    auto_action: '保留原始说明；没有明确单条能力时不提供可执行动作，等待后续来源或证据补证。',
    retryable: false, blocking: true, tone: 'muted',
  },
};

const CATEGORY_KEYS = Object.keys(GAP_CATEGORIES);
const RETRY_ACTIONS = new Set(['retry_cea_fetch', 'retry_content_fetch', 'reparse_pdf', 'requeue_summary']);

function textOf(gap) {
  return [gap.gap_key, gap.dataset, gap.title, gap.description, gap.impact, gap.manual_path]
    .filter(Boolean).join(' ');
}

export function gapCategoryMeta(category) {
  const key = GAP_CATEGORIES[category] ? category : 'unknown';
  return { key, ...GAP_CATEGORIES[key] };
}

function pickCategory(gap) {
  const s = textOf(gap);
  if (/非目标页|企业基本信息|单位基本信息|人才招聘|招聘信息|网站地图|网站导航/.test(s)) return 'non_target';
  if (/摘要(?:队列|待办|未生成|失败)|summar(?:y|ized)|摘要.*(?:blocked|skipped|未配置)/i.test(s)) return 'summary_pending';
  if (/OCR[^。；]{0,18}(?:失败|未配置|不可用|无结果)|识别失败|ocr_failed/i.test(s)) return 'ocr_failed';
  if (/PDF[^。；]{0,24}(?:已下载|落盘|未解析|无法[^。；]{0,6}(?:提取|解析)|未取得[^。；]{0,6}文本)|pdf_text|pdf_unparsed/i.test(s)) return 'pdf_unparsed';
  if (/交易日[^。；]{0,8}(?:缺失|无法确定|未确定)|行情日期[^。；]{0,8}(?:缺失|无法)|nodate|no_trade_date/i.test(s)) return 'missing_trade_date';
  if (/累计[^。；]{0,8}(?:差异|不一致|不符)|cumulative/i.test(s)) return 'cumulative_mismatch';
  if (/抓取失败|获取失败|访问失败|访问超时|下载失败|HTTP\s*[45]\d\d|fetch_failed|download_failed|network|timeout/i.test(s)) return 'access_failed';
  if (/动态页|JS\s*渲染|正文不全|部分正文|部分页|内容截断|仅有摘要|目录页|索引页|metadata_only|partial_text|解析失败|parse_failed|未找到[^。；]{0,12}(?:行情|字段)|未识别出[^。；]{0,12}(?:主体|企业行)/i.test(s)) return 'dynamic_partial';
  if (/冲突|不一致|与原文不符|conflict/i.test(s)) return 'raw_conflict';
  if (/核验|第二来源|证据不足|insufficient/i.test(s)) return 'verification_second_source';
  if (/未公开|不公开|无公开来源|来源未公开/i.test(s)) return 'source_not_public';
  if (/信用代码|可选字段|字段[^。；]{0,8}(?:异常|不合规)|校验位|格式异常/i.test(s)) return 'optional_field';
  return 'unknown';
}

function extractUrl(gap) {
  const m = textOf(gap).match(/https?:\/\/[^\s"'<>，。；;）)]+/i);
  if (!m) return null;
  return m[0].replace(/[.,;:!?]+$/, '');
}

function ceaCodeFromGap(gap) {
  const key = String(gap.gap_key || '');
  const m = key.match(/^cea:(?:document|entity):(?:pdf_text|pdf_hash|fetch|parse):([A-Za-z0-9_-]+)$/);
  return m?.[1] || null;
}

function contentIdFromGap(gap) {
  const m = textOf(gap).match(/(?:content_item|content)[:/]([A-Za-z0-9_-]{4,})/);
  return m?.[1] || null;
}

function resolveContent(gap) {
  const id = contentIdFromGap(gap);
  if (id) {
    const byId = get('SELECT * FROM content_item WHERE id=?', [id]);
    if (byId) return byId;
  }
  const url = extractUrl(gap);
  if (url) return get('SELECT * FROM content_item WHERE source_url=? ORDER BY created_at DESC LIMIT 1', [url]);
  return null;
}

function resolveCeaDocument(gap) {
  const code = ceaCodeFromGap(gap);
  if (!code) return null;
  return get('SELECT * FROM cea_document WHERE source_code=? OR doc_key=? ORDER BY created_at DESC LIMIT 1', [code, code]);
}

function snapshotForUrl(url) {
  if (!url) return null;
  return get(
    `SELECT id,url,fetched_at,content_hash,SUBSTR(body_text,1,8000) AS body_text,parse_quality,parse_note
       FROM source_snapshot WHERE url=? AND body_text IS NOT NULL AND body_text<>''
      ORDER BY fetched_at DESC LIMIT 1`,
    [url]
  );
}

function actionDefsFor(gap, category) {
  const defs = [];
  const url = extractUrl(gap);
  const content = resolveContent(gap);
  const doc = resolveCeaDocument(gap);
  const isCeaTrade = /^cea_trade|cea:trade:/i.test(`${gap.dataset} ${gap.gap_key}`);
  if (category === 'non_target' && url) {
    const snap = snapshotForUrl(url);
    defs.push({
      key: 'record_exclusion',
      label: '记录非目标页排除',
      description: snap
        ? '按已保存快照复核标题/主内容规则；只标注历史缺口，不写行情行。'
        : '没有可复核快照，需先取得原文；不凭标题猜测。',
      supported: !!snap,
      unsupported_reason: snap ? null : '没有同一 URL 的正文快照，不能补造排除依据',
    });
  }
  if (['access_failed', 'dynamic_partial', 'missing_trade_date'].includes(category) && url && isCeaTrade) {
    defs.push({
      key: 'retry_cea_fetch', label: '单条重试 CEA 日报',
      description: '复用官方域名白名单与抓取限流；抓取成功但解析失败仍保留缺口。',
      supported: true,
    });
  }
  if (['access_failed', 'dynamic_partial'].includes(category) && content
    && String(content.body_availability || 'metadata_only') !== 'full_text') {
    defs.push({
      key: 'retry_content_fetch', label: '补采此条正文',
      description: '复用既有 repairIncompleteContent，仅接受实际抓到的完整正文；摘要片段不补写全文。',
      supported: true,
    });
  }
  if (['summary_pending', 'dynamic_partial'].includes(category) && content) {
    defs.push({
      key: 'requeue_summary', label: '重新入摘要队列',
      description: '按当前正文签名入持久队列；摘要生成失败不关闭缺口。',
      supported: true,
    });
  }
  if (['pdf_unparsed', 'ocr_failed'].includes(category) && doc) {
    defs.push({
      key: 'reparse_pdf', label: '按对象重解析 PDF',
      description: '只处理受限根内本地 PDF，复用逐页解析/OCR；无正文仍保留缺口。',
      supported: true,
    });
  }
  return defs;
}

/** data_gap 分类（纯读，不关闭任何记录）。 */
export function classifyGap(gap) {
  if (!gap) return null;
  let category = pickCategory(gap);
  let snapshotEvidence = null;
  const gapUrl = extractUrl(gap);
  const isCeaTradeGap = /^cea_trade|cea:trade:/i.test(`${gap.dataset || ''} ${gap.gap_key || ''}`);
  // 台账旧文案可能只写“解析失败”。同 URL 已有真实归档快照时，以标题/主内容
  // 证据复核非目标页；累计差异/摘要/可选字段等类别不因 URL 命中而改判。
  if (isCeaTradeGap && gapUrl && ['dynamic_partial', 'access_failed', 'unknown', 'missing_trade_date', 'non_target'].includes(category)) {
    const snap = snapshotForUrl(gapUrl);
    if (snap?.body_text) {
      const page = detectCeaNonTargetPage(snap.body_text, { url: gapUrl });
      if (page.non_target) {
        category = 'non_target';
        snapshotEvidence = {
          snapshot_id: snap.id, url: gapUrl, rule: page.rule, title: page.title,
          evidence: page.evidence, content_hash: snap.content_hash || null,
          snapshot_excerpt: page.main_excerpt || null,
        };
      }
    }
  }
  const meta = gapCategoryMeta(category);
  const actions = actionDefsFor(gap, category);
  const supported = actions.filter((a) => a.supported);
  const basis = [
    `台账键：${gap.gap_key || '—'}`,
    `标题：${gap.title || '—'}`,
    `数据集：${gap.dataset || '—'}`,
    gap.description ? `说明：${String(gap.description).slice(0, 180)}` : '说明：未记录',
    gap.impact ? `影响：${String(gap.impact).slice(0, 120)}` : null,
    snapshotEvidence ? `同 URL 快照 ${snapshotEvidence.snapshot_id}：规则 ${snapshotEvidence.rule}；${snapshotEvidence.evidence}` : null,
  ].filter(Boolean);
  return {
    category,
    label: meta.label,
    tone: meta.tone,
    basis,
    auto_action: meta.auto_action,
    retryable: supported.some((a) => RETRY_ACTIONS.has(a.key)),
    blocking: !!meta.blocking,
    supported_actions: supported,
    unsupported_actions: actions.filter((a) => !a.supported).map((a) => ({
      key: a.key, label: a.label, reason: a.unsupported_reason || '当前不具备该单条能力',
    })),
    evidence_snapshot: snapshotEvidence,
    unsupported_reason: supported.length ? null : (
      category === 'optional_field'
        ? '字段级异常非阻塞；不修改原始值、不猜测补齐，因此不提供动作。'
        : category === 'verification_second_source'
          ? '需要第二公开来源；系统不伪造或自动拼接来源。'
          : category === 'raw_conflict' || category === 'source_not_public' || category === 'cumulative_mismatch'
            ? '该类别不能靠现有单条动作消除；保留缺口与原证据。'
            : '未找到可安全复用的单条适配器或对象定位。'
    ),
  };
}

/** processing_stage 分类，供治理页“阻塞与失效原因”展示。 */
export function classifyStage(stageRow = {}) {
  const s = [stageRow.object_type, stageRow.stage, stageRow.status, stageRow.failure_reason].filter(Boolean).join(' ');
  let category = 'unknown';
  if (stageRow.stage === 'summarized' && ['pending', 'failed', 'blocked', 'stale'].includes(stageRow.status)) category = 'summary_pending';
  else if (stageRow.stage === 'verified' && /冲突|conflict/i.test(s)) category = 'raw_conflict';
  else if (stageRow.stage === 'verified' && ['blocked', 'failed', 'stale'].includes(stageRow.status)) category = 'verification_second_source';
  else if (/OCR|识别失败/i.test(s)) category = 'ocr_failed';
  else if (/PDF|附件|原件|parse|解析/i.test(s) && ['failed', 'blocked'].includes(stageRow.status)) category = 'pdf_unparsed';
  else if (stageRow.stage === 'fetched' && ['failed', 'blocked'].includes(stageRow.status)) category = 'access_failed';
  else if (['failed', 'blocked'].includes(stageRow.status)) category = 'dynamic_partial';
  const meta = gapCategoryMeta(category);
  return {
    category, label: meta.label, tone: meta.tone, blocking: !!meta.blocking,
    retryable: !!meta.retryable, auto_action: meta.auto_action,
    basis: [stageRow.stage, stageRow.status, stageRow.failure_reason].filter(Boolean).join('｜').slice(0, 240),
  };
}

function persistTriage(gap, triage) {
  run(
    `UPDATE data_gap SET classification=?, classification_basis=?, retryable=?, blocking=?, classified_at=?, updated_at=?
      WHERE id=?`,
    [triage.category, j(triage.basis), triage.retryable ? 1 : 0, triage.blocking ? 1 : 0,
      nowIso(), nowIso(), gap.id]
  );
}

function stageCategoryCounts() {
  const counts = {};
  const rows = all(
    `SELECT object_type,stage,status,failure_reason,COUNT(*) c
       FROM processing_stage WHERE status IN ('blocked','failed','stale')
      GROUP BY object_type,stage,status,failure_reason`
  );
  for (const r of rows) {
    const tri = classifyStage(r);
    counts[tri.category] = (counts[tri.category] || 0) + Number(r.c || 0);
  }
  return Object.entries(counts).map(([category, count]) => ({
    category, count, ...gapCategoryMeta(category),
  })).sort((a, b) => b.count - a.count);
}

function optionalFieldAnomalies({ limit = 50 } = {}) {
  const rows = all(
    `SELECT id,name,raw_credit_code,credit_code,province,list_year,source_url
       FROM cea_entity WHERE credit_code IS NULL AND raw_credit_code IS NOT NULL
      ORDER BY list_year DESC, province, name LIMIT ?`,
    [Math.max(1, Math.min(Number(limit) || 50, 200))]
  );
  return rows.map((r) => ({
    ...r,
    category: 'optional_field', category_label: GAP_CATEGORIES.optional_field.label,
    blocking: false, retryable: false,
    basis: `原表信用代码「${r.raw_credit_code}」未通过18位/校验位规则；标准代码留空，企业名称仍计入名录。`,
    auto_action: GAP_CATEGORIES.optional_field.auto_action,
    valid: validEntityCreditCode(r.raw_credit_code),
  }));
}

/**
 * 列出并分类缺口。persist=true 时只写分类列，不改变缺口状态；
 * 已由同一内容当前摘要证明修复的 summary 缺口可在这里结清。
 */
export function triageGaps({ status = 'all', limit = 200, persist = false, includeFields = true } = {}) {
  const rows = all(
    `SELECT * FROM data_gap ${status === 'all' ? '' : 'WHERE status=?'}
      ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,
               COALESCE(updated_at,detected_at) DESC LIMIT ?`,
    status === 'all' ? [Math.max(1, Math.min(Number(limit) || 200, 500))]
      : [status, Math.max(1, Math.min(Number(limit) || 200, 500))]
  );
  const items = [];
  const counts = Object.fromEntries(CATEGORY_KEYS.map((k) => [k, 0]));
  for (const gap of rows) {
    const triage = classifyGap(gap);
    let settled = null;
    if (persist && triage.category === 'non_target' && gap.status === 'open' && triage.evidence_snapshot) {
      const ev = triage.evidence_snapshot;
      const out = recordCeaPageExclusion({
        url: ev.url, snapshotId: ev.snapshot_id, contentHash: ev.content_hash,
        title: ev.title, rule: ev.rule, evidence: ev.evidence,
        snapshotExcerpt: ev.snapshot_excerpt, actor: 'system:gap-triage',
      });
      if (out?.ok) {
        const latest = get('SELECT * FROM data_gap WHERE id=?', [gap.id]);
        settled = {
          status: latest?.status || 'mitigated',
          note: '同 URL 归档快照按标题/主内容规则证明为非目标页；不建行情行，旧缺口留痕后停止重试。',
        };
      }
    }
    if (persist && triage.category === 'summary_pending' && gap.status === 'open') {
      const content = resolveContent(gap);
      const s = content ? summary.getSummary('content_item', content.id) : null;
      if (s?.status === 'ok' && !s.stale) {
        settled = settleGap(gap, {
          note: `摘要已按当前输入签名生成（${s.generated_at || '时间未知'}），同一内容证据足以结清该缺口。`,
          actor: 'system:gap-triage', status: 'closed',
        });
      }
    }
    const currentStatus = settled?.status || gap.status;
    if (currentStatus === 'open') counts[triage.category] += 1;
    if (persist) persistTriage(gap, triage);
    items.push({
      ...gap,
      status: currentStatus,
      triage,
      auto_settled: settled ? { status: settled.status, note: settled.note } : null,
    });
  }
  const exclusions = all(
    'SELECT * FROM cea_page_exclusion ORDER BY updated_at DESC LIMIT 20'
  );
  return {
    items,
    total: items.length,
    open: items.filter((i) => i.status === 'open').length,
    by_category: counts,
    categories: CATEGORY_KEYS.map((key) => ({ key, ...gapCategoryMeta(key) })),
    stage_categories: stageCategoryCounts(),
    optional_field_anomalies: includeFields ? optionalFieldAnomalies() : [],
    non_target_exclusions: exclusions,
    note:
      '分类与依据来自台账、真实阶段/附件/正文状态与确定性规则；不调用模型猜关闭。' +
      '非目标页只记录排除，不写行情行；可选字段异常不阻塞整条名录。',
  };
}

/* ==================================================================== */
/*  受控动作                                                             */
/* ==================================================================== */

function appendDescription(gap, note) {
  const desc = String(gap.description || '');
  if (desc.includes(note)) return desc;
  return `${desc}${desc ? '\n' : ''}【自动处理 ${nowIso()}】${note}`;
}

function settleGap(gap, { note, actor = 'system:gap-triage', status = 'closed' } = {}) {
  const now = nowIso();
  run(
    `UPDATE data_gap SET status=?, description=?, last_action=COALESCE(last_action,'auto_settle'),
       last_action_at=?, last_action_actor=?, last_action_result=?, updated_at=? WHERE id=?`,
    [status, appendDescription(gap, note), now, actor,
      j({ ok: true, status, note, settled_at: now }), now, gap.id]
  );
  audit({
    actor, actorRole: 'system', action: 'data_gap.auto_settle', objectType: 'data_gap',
    objectId: gap.id, detail: { before_status: gap.status, after_status: status, before_description: gap.description, note },
  });
  return { ok: true, status, note };
}

function recordAction(gap, action, result, actor, triage) {
  const now = nowIso();
  run(
    `UPDATE data_gap SET classification=?, classification_basis=?, retryable=?, blocking=?, classified_at=?,
       last_action=?, last_action_at=?, last_action_actor=?, last_action_result=?, updated_at=? WHERE id=?`,
    [triage.category, j(triage.basis), triage.retryable ? 1 : 0, triage.blocking ? 1 : 0, now,
      action, now, actor, j(result).slice(0, 4000), now, gap.id]
  );
}

async function runAction(gap, action, triage, { actor, deadlineAt }) {
  if (action === 'retry_cea_fetch') {
    const url = extractUrl(gap);
    if (!url) return { ok: false, error: '缺口没有可核对的 http(s) URL', status: 400 };
    // 只按 URL 等值定位已登记来源；不把任意域名加入白名单，也不放宽 SSRF 规则。
    const source = get("SELECT code FROM cea_source WHERE url=? AND enabled=1 ORDER BY priority, code LIMIT 1", [url]);
    const collect = await import('./cea-collect-svc.mjs');
    const out = await collect.collectOneCeaDaily(
      { url, sourceCode: source?.code || null, dateHint: null },
      { actor, deadlineAt }
    );
    if (out?.excluded || out?.reason === 'non_target_page') {
      return {
        ok: false, status: 'excluded', message: out.message,
        result: { stage: out.stage, exclusion_id: out.exclusion_id, rule: out.exclusion_rule, gaps_mitigated: out.gaps_mitigated },
      };
    }
    if (out?.ok) {
      return {
        ok: true, close: true, status: 'closed',
        note: `同一 URL 已成功采集并解析入库（交易日 ${out.trade_date || '—'}，快照 ${out.snapshot_id || '—'}）。`,
        message: 'CEA 日报已成功入库，缺口按同一来源/日期证据结清。',
        result: { trade_date: out.trade_date, record_id: out.record_id, snapshot_id: out.snapshot_id },
      };
    }
    return {
      ok: false, status: 'failed',
      error: `${out?.reason || 'retry_failed'}：${out?.message || '本次未取得可解析的日报'}`,
      message: '抓取/解析未成功，缺口保持未结清；抓取成功不等于解析成功。',
      result: { stage: out?.stage || null, reason: out?.reason || null, snapshot_id: out?.snapshotId || null },
    };
  }

  if (action === 'retry_content_fetch') {
    const content = resolveContent(gap);
    if (!content) return { ok: false, error: '该缺口未能定位到唯一内容条目', status: 400 };
    const contentSvc = await import('./content-svc.mjs');
    const out = await contentSvc.repairIncompleteContent({
      actor, limit: 1, ids: [content.id], verify: false, offset: 0,
    });
    const item = (out.items || [])[0];
    if (out.improved > 0) {
      return {
        ok: true, close: true, status: 'closed',
        note: `同一内容条目 ${content.id} 已实际补采到公开全文（快照 ${item?.snapshot_id || '—'}）。`,
        message: '正文补采成功，缺口按同一内容/来源证据结清。',
        result: { content_id: content.id, snapshot_id: item?.snapshot_id || null, improved: out.improved },
      };
    }
    return {
      ok: false, status: item?.status || 'unchanged',
      error: item?.reason || out.reason || '未取得比原记录更完整的正文',
      message: '抓取结果仍不是可核对全文，缺口保持未结清。',
      result: { content_id: content.id, attempted: out.attempted, unchanged: out.unchanged, failed: out.failed },
    };
  }

  if (action === 'requeue_summary') {
    const content = resolveContent(gap);
    if (!content) return { ok: false, error: '该缺口未能定位到唯一内容条目', status: 400 };
    const fresh = summary.getSummary('content_item', content.id);
    if (fresh?.status === 'ok' && !fresh.stale) {
      return {
        ok: true, close: true, status: 'closed',
        note: `当前输入签名下摘要已生成（${fresh.generated_at || '时间未知'}），无需重复付费。`,
        message: '摘要已是当前输入的有效结果，缺口按同一内容证据结清。',
        result: { already_fresh: true, generated_at: fresh.generated_at },
      };
    }
    const ingest = await import('./ingest-summary-svc.mjs');
    const queued = ingest.enqueueContentSummary(content.id, {
      source: 'gap_action', reason: `缺口动作：${gap.gap_key}`, revive: true,
    });
    if (!queued.ok) {
      return {
        ok: false, status: 'blocked',
        error: `未入队：${queued.reason || 'unknown'}`,
        message: '摘要未入队，缺口保持未结清。',
        result: { queued },
      };
    }
    return {
      ok: true, close: false, status: 'queued',
      message: queued.deduped
        ? '该输入签名的摘要任务已在队列中；等待 worker 处理，本次不重复调用模型。'
        : '已按当前输入签名入摘要队列；生成成功前缺口保持未结清。',
      result: { queue_id: queued.id, deduped: !!queued.deduped, revived: !!queued.revived },
    };
  }

  if (action === 'reparse_pdf') {
    const doc = resolveCeaDocument(gap);
    if (!doc) return { ok: false, error: '未找到该缺口对应的 CEA 文件或本地 PDF 对象', status: 404 };
    const ocr = await import('./ocr-backfill-svc.mjs');
    const out = await ocr.reparseObject({
      kind: 'cea_document', id: doc.id, actor, force: false,
      deadlineAt: Math.min(deadlineAt, Date.now() + 120000),
    });
    const pagesFailed = Number(out?.pages_failed || 0);
    if (out?.ok && pagesFailed === 0) {
      return {
        ok: true, close: true, status: 'closed',
        note: `同一 CEA 文件 ${doc.id} 的本地 PDF 已重新解析取得完整正文（${out.pages_text || 0} 页文本/${out.pages_ocr || 0} 页 OCR，失败 0 页）。`,
        message: 'PDF/OCR 重解析成功且全部页取得正文，缺口按同一对象/原件证据结清。',
        result: { document_id: doc.id, status: out.status, pages_total: out.pages_total, pages_failed: 0 },
      };
    }
    if (out?.ok) {
      return {
        ok: true, close: false, status: 'partial',
        message: `PDF/OCR 重解析取得部分正文，但仍有 ${pagesFailed} 页未读出；缺口保持未结清。`,
        result: {
          document_id: doc.id, status: out.status, pages_total: out.pages_total,
          pages_text: out.pages_text || 0, pages_ocr: out.pages_ocr || 0, pages_failed: pagesFailed,
        },
      };
    }
    return {
      ok: false, status: out?.status || 'failed',
      error: out?.error || out?.reason || out?.message || '未取得可用正文',
      message: 'PDF/OCR 重解析未取得正文，缺口保持未结清。',
      result: { document_id: doc.id, status: out?.status || null, reason: out?.reason || null, pages_failed: pagesFailed },
    };
  }

  if (action === 'record_exclusion') {
    const url = extractUrl(gap);
    const snap = snapshotForUrl(url);
    if (!snap) return { ok: false, error: '没有同一 URL 的正文快照，不能确认非目标页', status: 400 };
    const page = detectCeaNonTargetPage(snap.body_text, { url });
    if (!page.non_target) {
      return {
        ok: false, status: 'not_non_target',
        error: `快照复核未命中非目标规则：${page.reason}`,
        message: '没有确定性依据，不记录排除、不结清缺口。',
        result: { snapshot_id: snap.id, rule: page.rule },
      };
    }
    const cea = await import('./cea-svc.mjs');
    const out = cea.recordCeaPageExclusion({
      url, snapshotId: snap.id, contentHash: snap.content_hash, title: page.title,
      rule: page.rule, evidence: page.evidence, snapshotExcerpt: page.main_excerpt, actor,
    });
    if (!out?.ok) return { ok: false, status: 'failed', error: out?.error || '排除记录写入失败' };
    return {
      ok: true, close: false, status: 'mitigated',
      message: '已记录非目标页排除；同 URL 历史缺口标注为 mitigated，停止重复重试。',
      result: { exclusion_id: out.id, rule: out.rule, gaps_mitigated: out.gap_updated },
    };
  }
  return { ok: false, error: `不支持的动作：${action}`, status: 400, unsupported: true };
}

export async function runGapAction(user, gapId, action, { actorNote = null } = {}) {
  const denied = requireRole(user, ['admin'], '执行缺口受控动作');
  if (denied) return denied;
  const gap = get('SELECT * FROM data_gap WHERE id=?', [String(gapId)]);
  if (!gap) return { error: '缺口记录不存在', status: 404 };
  const triage = classifyGap(gap);
  const allowed = triage.supported_actions.find((a) => a.key === action);
  if (!allowed) {
    return {
      ok: false, error: `该缺口不支持动作「${action || '未指定'}」`, unsupported: true,
      status: 400, triage, allowed_actions: triage.supported_actions,
    };
  }
  const actor = user.name || 'admin';
  const deadlineAt = Date.now() + 130_000;
  let out;
  try {
    out = await runAction(gap, action, triage, { actor, deadlineAt });
  } catch (e) {
    out = { ok: false, status: 'failed', error: `动作异常：${e.message}` };
  }
  let settled = null;
  if (out?.ok && out.close) {
    persistTriage(gap, triage);
    settled = settleGap(gap, { note: out.note || out.message || '同一对象证据已修复', actor, status: 'closed' });
  }
  if (out?.result?.exclusion_id) {
    // 非目标页动作由 recordCeaPageExclusion 已把同 URL 缺口标为 mitigated；
    // 这里同步当前记录的动作列与审计，不重复追加结清说明。
    const latest = get('SELECT * FROM data_gap WHERE id=?', [gap.id]);
    if (latest) {
      run(
        `UPDATE data_gap SET last_action=?, last_action_at=?, last_action_actor=?, last_action_result=?, updated_at=? WHERE id=?`,
        [action, nowIso(), actor, j(out.result).slice(0, 3000), nowIso(), gap.id]
      );
    }
  } else if (!settled) {
    recordAction(gap, action, { ok: !!out?.ok, status: out?.status || null, error: out?.error || null, message: out?.message || null, result: out?.result || null }, actor, triage);
  } else {
    run(
      `UPDATE data_gap SET last_action=?, last_action_at=?, last_action_actor=?, last_action_result=?, updated_at=? WHERE id=?`,
      [action, nowIso(), actor, j({ ok: true, status: settled.status, message: out.message || out.note }).slice(0, 3000), nowIso(), gap.id]
    );
  }
  audit({
    actor, actorRole: user.role, action: 'data_gap.action', objectType: 'data_gap', objectId: gap.id,
    detail: { action, ok: !!out?.ok, status: out?.status || null, error: out?.error || null, note: actorNote, result: out?.result || null },
  });
  const after = get('SELECT * FROM data_gap WHERE id=?', [gap.id]);
  return {
    ok: !!out?.ok,
    action,
    gap_id: gap.id,
    status: out?.status || (out?.ok ? 'accepted' : 'failed'),
    message: out?.message || out?.note || out?.error || null,
    error: out?.error || null,
    close: !!out?.close,
    closed: settled?.status === 'closed',
    result: out?.result || null,
    gap: after ? { ...after, triage: classifyGap(after) } : null,
    note: '动作真实执行；只有同一对象/来源证据成功修复才结清，摘要入队或抓取成功但解析失败都不算完成。',
  };
}

export { optionalFieldAnomalies };
