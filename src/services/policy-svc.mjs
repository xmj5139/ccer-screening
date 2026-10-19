/**
 * 政策和方法学模块服务（六模块之「政策和方法学」）
 * ============================================================================
 * 需求规格 1.2：
 *   - 政策库：按管理办法/注册登记规则/审定核查规则/交易结算规则/项目设计实施指南/
 *     监测与排放因子文件/部委政策/征求意见文件分类；支持标题/正文/文号/机关/日期检索；
 *     每条保存官方原文、附件、链接、文号、生效状态、版本、采集时间、人工确认人、变更记录；
 *   - 方法学库：正式与草案分栏；每项展示编号版本、适用类型、技术边界、排除条件、
 *     额外性、基准线、计入期、监测要求、参数、公式、因子、材料、常见问题、官方解读、
 *     修订差异、引用条款与 PDF 页码；
 *   - 解读层：面向投资团队的四类解读，AI 只产草稿并标注「AI 草稿 / 已复核」；
 *   - 完整性：以官方目录与公告清单为对照，生成「已收录 / 待核实 / 已失效 / 采集失败」清单。
 *
 * 【纪律】草案不得驱动资格判断与正式测算；PDF 归档与解析不等于领域专家复核。
 */
import { all, get, run, audit } from '../core/db.mjs';
import { newId, nowIso, uj, j, isDate } from '../core/util.mjs';
import { listMethodologyVersions } from './engine.mjs';
import { listMethodologyModules, getMethodologyModule } from '../methodologies/index.mjs';
import { EVIDENCE_LEVELS } from '../data/methodology-evidence.mjs';
import { POLICY_CATEGORIES, POLICY_CATEGORY_LABELS, POLICY_DOC_STATUS_LABELS } from '../data/policy-catalog.mjs';
import { CATALOG_BASELINE } from '../data/catalog.mjs';
import { policyImpact } from './collect-svc.mjs';

/* ==================================================================== */
/*  一、政策库                                                          */
/* ==================================================================== */

/**
 * 单条附件记录是否构成「可核验的官方原件归档」。
 * ============================================================================
 * 判定依据必须是**落地证据**，而不是解析质量字段本身：
 *   1. 有 local_path（官方原件已落盘到 data/official-originals/）；
 *   2. 有 file_hash（SHA-256，可校验未被篡改）；
 *   3. 解析质量不是 failed / not_attempted。
 *
 * 【为什么不能只看 parse_quality='good'】
 *   早期版本把「官方页面已核对」的占位 HTML 记录写成 parse_quality='good'，
 *   却没有下载任何文件、也没有哈希。用 `parse_quality === 'good'` 判定「已归档」
 *   会把真实缺口掩盖成已归档，并让「原件未归档」的核对记录永远无法自动结清。
 *   现在统一以「本地文件 + 哈希」为准；占位记录如实计为未归档。
 */
export function isAttachmentArchived(att) {
  if (!att) return false;
  if (!att.local_path) return false;
  if (!att.file_hash) return false;
  return att.parse_quality !== 'failed' && att.parse_quality !== 'not_attempted';
}

/** 政策是否已有可核验的原件归档（附件级或政策级本地文件 + 哈希） */
export function policyHasArchivedOriginal(policyId) {
  const atts = all('SELECT * FROM policy_attachment WHERE policy_id = ?', [policyId]);
  if (atts.some(isAttachmentArchived)) return true;
  const p = get('SELECT local_path, original_file_hash FROM policy_document WHERE id = ?', [policyId]);
  return Boolean(p && p.local_path && p.original_file_hash);
}

export function listPolicies(filters = {}) {
  const where = filters.include_duplicates ? [] : ['duplicate_of IS NULL'];
  const params = [];
  if (filters.category) {
    where.push('category = ?');
    params.push(filters.category);
  }
  if (filters.doc_status) {
    where.push('doc_status = ?');
    params.push(filters.doc_status);
  }
  if (filters.authority) {
    where.push('issuing_authority LIKE ?');
    params.push(`%${filters.authority}%`);
  }
  if (filters.publish_from && isDate(filters.publish_from)) {
    where.push('publish_date >= ?');
    params.push(filters.publish_from);
  }
  if (filters.publish_to && isDate(filters.publish_to)) {
    where.push('publish_date <= ?');
    params.push(filters.publish_to);
  }
  if (filters.effective_from && isDate(filters.effective_from)) {
    where.push('effective_date >= ?');
    params.push(filters.effective_from);
  }
  if (filters.keyword) {
    const k = `%${String(filters.keyword).trim()}%`;
    // 标题 / 文号 / 发布机关 / 摘要（正文摘要）联合检索
    where.push('(title LIKE ? OR COALESCE(doc_number,\'\') LIKE ? OR COALESCE(issuing_authority,\'\') LIKE ? OR COALESCE(summary,\'\') LIKE ?)');
    params.push(k, k, k, k);
  }
  const sql = `SELECT * FROM policy_document ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
               ORDER BY COALESCE(publish_date, '1900-01-01') DESC, created_at DESC`;
  const rows = all(sql, params);
  return rows.map((p) => {
    const atts = all('SELECT * FROM policy_attachment WHERE policy_id = ?', [p.id]);
    const changes = get(
      "SELECT COUNT(*) AS c FROM policy_change WHERE policy_id = ? AND review_status = 'pending'"
    )?.c ?? 0;
    return {
      ...p,
      category_label: POLICY_CATEGORY_LABELS[p.category] || p.category,
      status_label: POLICY_DOC_STATUS_LABELS[p.doc_status] || p.doc_status,
      attachment_count: atts.length,
      archived_count: atts.filter(isAttachmentArchived).length,
      has_archived_original: atts.some(isAttachmentArchived) || Boolean(p.local_path && p.original_file_hash),
      pending_changes: changes,
      has_official_url: !!p.official_url,
      confirmed_label: p.confirmed_by ? `已人工确认（${p.confirmed_by}）` : '未经人工确认',
    };
  });
}

export function getPolicyDetail(policyId) {
  const p = get('SELECT * FROM policy_document WHERE id = ?', [policyId]);
  if (!p) return null;
  const attachments = all('SELECT * FROM policy_attachment WHERE policy_id = ? ORDER BY created_at', [policyId]);
  const changes = all('SELECT * FROM policy_change WHERE policy_id = ? ORDER BY detected_at DESC', [policyId]);
  const source = p.source_id ? get('SELECT * FROM source_document WHERE id = ?', [p.source_id]) : null;
  const relatedMv = all(
    `SELECT id, methodology_id, code_display, name, version, document_status, evidence_level
     FROM methodology_version WHERE official_url = ? OR source_id = ?`,
    [p.official_url || '', p.source_id || '']
  );
  return {
    policy: {
      ...p,
      category_label: POLICY_CATEGORY_LABELS[p.category] || p.category,
      status_label: POLICY_DOC_STATUS_LABELS[p.doc_status] || p.doc_status,
    },
    attachments,
    supplemental_documents: all(`SELECT id,file_name,file_hash,source_status,text_source,ai_result,ai_summary,created_at,
      substr(text_content,1,20000) AS extracted_text FROM document_upload
      WHERE target_kind='policy' AND target_id=? AND ai_result='supported' ORDER BY created_at DESC LIMIT 3`, [policyId]),
    changes: changes.map((c) => ({ ...c, impact: uj(c.impact_json, null) })),
    source,
    related_methodologies: relatedMv,
    impact_preview: policyImpact(p),
    note:
      '政策条款以官方原文为准。原件未归档时只能引用到文件与章节层级；' +
      '补充副本的模型核对结果与官方来源确认状态分别展示。',
  };
}

/** 编辑政策条目（研究员/管理员），全部留痕 */
export function updatePolicy(user, policyId, patch = {}) {
  const p = get('SELECT * FROM policy_document WHERE id = ?', [policyId]);
  if (!p) return { error: '政策条目不存在', status: 404 };
  const allowed = [
    'title', 'doc_number', 'issuing_authority', 'category', 'doc_status', 'publish_date',
    'effective_date', 'repeal_date', 'summary', 'official_url', 'version_label', 'collect_note',
  ];
  const fields = [];
  const params = [];
  const before = {};
  const after = {};
  for (const k of allowed) {
    if (patch[k] === undefined) continue;
    fields.push(`${k} = ?`);
    params.push(patch[k] === '' ? null : patch[k]);
    before[k] = p[k];
    after[k] = patch[k];
  }
  if (!fields.length) return { error: '没有可更新的字段', status: 400 };
  fields.push('updated_at = ?');
  params.push(nowIso(), policyId);
  run(`UPDATE policy_document SET ${fields.join(', ')} WHERE id = ?`, params);
  audit({
    actor: user?.name || 'unknown',
    actorRole: user?.role || null,
    action: 'policy.update',
    objectType: 'policy_document',
    objectId: policyId,
    detail: { before, after, reason: patch.reason || null },
  });
  return { ok: true, id: policyId, updated: Object.keys(after), before, after };
}

/** 人工确认政策条目（确认人/时间写入，界面显示「已人工确认」） */
export function confirmPolicy(user, policyId, { note = null } = {}) {
  const p = get('SELECT * FROM policy_document WHERE id = ?', [policyId]);
  if (!p) return { error: '政策条目不存在', status: 404 };
  run('UPDATE policy_document SET confirmed_by = ?, confirmed_at = ?, collect_note = COALESCE(?, collect_note), updated_at = ? WHERE id = ?', [
    user?.name || 'unknown', nowIso(), note, nowIso(), policyId,
  ]);
  audit({
    actor: user?.name, actorRole: user?.role, action: 'policy.confirm',
    objectType: 'policy_document', objectId: policyId, detail: { note },
  });
  return { ok: true, id: policyId, confirmed_by: user?.name || 'unknown' };
}

/**
 * 登记附件（原件归档）。
 * 只登记归档事实与解析质量；**不把解析结果当作领域复核**。
 */
export function registerAttachment(user, policyId, payload = {}) {
  const p = get('SELECT * FROM policy_document WHERE id = ?', [policyId]);
  if (!p) return { error: '政策条目不存在', status: 404 };
  if (!payload.file_name) return { error: '缺少 file_name', status: 400 };
  const id = newId('PAT');
  run(
    `INSERT INTO policy_attachment (id,policy_id,file_name,file_type,url,file_hash,local_path,parse_quality,parse_note,fetched_at,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id, policyId, payload.file_name, payload.file_type || 'pdf', payload.url || null,
      payload.file_hash || null, payload.local_path || null,
      payload.parse_quality || 'not_attempted', payload.parse_note || null,
      payload.fetched_at || nowIso(), nowIso(),
    ]
  );
  if (payload.file_hash) {
    run('UPDATE policy_document SET original_file_hash = ?, updated_at = ? WHERE id = ?', [
      payload.file_hash, nowIso(), policyId,
    ]);
  }
  audit({
    actor: user?.name, actorRole: user?.role, action: 'policy.attachment.register',
    objectType: 'policy_document', objectId: policyId,
    detail: { file_name: payload.file_name, parse_quality: payload.parse_quality || 'not_attempted' },
  });
  return { ok: true, id, note: '已登记归档；原件解析结果仍需人工核对条款，不构成领域专家审批。' };
}

/** 政策库统计（模块页头） */
export function policyStats() {
  const rows = all('SELECT * FROM policy_document');
  const byCategory = {};
  const byStatus = {};
  for (const r of rows) {
    byCategory[r.category] = (byCategory[r.category] || 0) + 1;
    byStatus[r.doc_status] = (byStatus[r.doc_status] || 0) + 1;
  }
  const pendingChanges = get("SELECT COUNT(*) AS c FROM policy_change WHERE review_status = 'pending'")?.c ?? 0;
  const confirmed = rows.filter((r) => r.confirmed_by).length;
  const archived = rows.filter((r) => policyHasArchivedOriginal(r.id)).length;
  const latest = get('SELECT MAX(publish_date) AS d FROM policy_document')?.d || null;
  return {
    total: rows.length,
    by_category: Object.entries(byCategory).map(([k, v]) => ({ key: k, label: POLICY_CATEGORY_LABELS[k] || k, count: v })),
    by_status: Object.entries(byStatus).map(([k, v]) => ({ key: k, label: POLICY_DOC_STATUS_LABELS[k] || k, count: v })),
    confirmed,
    unconfirmed: rows.length - confirmed,
    archived_originals: archived,
    pending_changes: pendingChanges,
    latest_publish_date: latest,
    categories: POLICY_CATEGORIES,
    note:
      '「原件已归档」指官方原件已落盘（data/official-originals/）并记录 SHA-256，' +
      '可按文件与章节（PDF 可按页码）引用；只有「官方页面已核对」的占位登记不计入已归档。' +
      '未归档时只引用到文件与章节层级，不声称已读原文。',
  };
}

export function listPolicyChanges({ status = 'pending', limit = 100 } = {}) {
  return all(
    `SELECT c.*, p.title AS policy_title, p.category, p.official_url
     FROM policy_change c JOIN policy_document p ON p.id = c.policy_id
     ${status && status !== 'all' ? 'WHERE c.review_status = ?' : ''}
     ORDER BY c.detected_at DESC LIMIT ?`,
    status && status !== 'all' ? [status, limit] : [limit]
  ).map((c) => ({ ...c, impact: uj(c.impact_json, null) }));
}

/* ==================================================================== */
/*  二、方法学库                                                        */
/* ==================================================================== */

/** 方法学可用性判定（与 calc-svc 的门禁判据保持一致） */
export function methodologyGate(mv, mod) {
  const verification = get('SELECT * FROM methodology_doc_verification WHERE methodology_version_id = ?', [mv.id]);
  const evidenceLevel = mv.evidence_level || verification?.evidence_level || 'unverified';
  const evidence = EVIDENCE_LEVELS[evidenceLevel] || EVIDENCE_LEVELS.unverified;
  const blockers = [];
  if (mv.document_status !== 'formal') blockers.push('非正式发布版本（草案/征求意见稿）不得驱动资格判断与测算');
  if (!mod?.plugin) blockers.push('未注册计算插件');
  if (mv.calculator_status !== 'approved') blockers.push(`计算插件审批状态为「${mv.calculator_status}」`);
  if (!verification) blockers.push('未建立官方原文逐条对照台账');
  else if (verification.evidence_level !== 'official_original_verified') {
    blockers.push(`原文对照证据等级为「${evidence.short}」`);
  }
  if (verification && !verification.verified_by) blockers.push('未获领域复核人签字（不能正式出数）');
  const remaining = uj(verification?.remaining_blockers, []) || [];
  if (remaining.length) blockers.push(`原文对照后仍未结清 ${remaining.length} 项参数确认`);
  const canCalculate = blockers.length === 0;
  return {
    methodology_version_id: mv.id,
    evidence_level: evidenceLevel,
    evidence_label: evidence.label,
    evidence_short: evidence.short,
    doc_verification_id: verification?.id || null,
    official_url: verification?.official_url || mv.official_url || null,
    doc_number: verification?.doc_number || null,
    publish_date: verification?.publish_date || mv.release_date || null,
    sections_verified: uj(verification?.sections_verified, []) || [],
    coverage: uj(verification?.coverage_json, null),
    remaining_blockers: remaining,
    domain_review: verification?.verified_by
      ? { verified_by: verification.verified_by, verified_at: verification.verified_at }
      : null,
    can_calculate: canCalculate,
    blockers,
    display: canCalculate ? '可出数（业务通道）' : `暂不支持自动测算（${blockers[0] || '条件未满足'}）`,
  };
}

/** 方法学目录（正式 / 草案分栏 + 门槛状态） */
export function listMethodologiesV2(filters = {}) {
  let list = listMethodologyVersions();
  if (filters.methodology_id) list = list.filter((m) => m.methodology_id === filters.methodology_id);
  if (filters.domain) list = list.filter((m) => m.domain === filters.domain);
  if (filters.document_status) list = list.filter((m) => m.document_status === filters.document_status);
  if (filters.keyword) {
    const k = String(filters.keyword).toLowerCase();
    list = list.filter(
      (m) =>
        String(m.name || '').toLowerCase().includes(k) ||
        String(m.methodology_id || '').toLowerCase().includes(k) ||
        String(m.code_display || '').toLowerCase().includes(k)
    );
  }
  const modules = new Map(listMethodologyModules().map((m) => [`${m.meta.methodology_id}::${m.meta.version}`, m]));
  const decorate = (m) => {
    const mod = modules.get(`${m.methodology_id}::${m.version}`);
    const gate = methodologyGate(m, mod);
    const interpretations = all(
      'SELECT section, content, origin, status, reviewed_by FROM methodology_interpretation WHERE methodology_id = ? AND (version = ? OR version IS NULL)',
      [m.methodology_id, m.version]
    );
    const projectCount = get(
      'SELECT COUNT(*) AS c FROM public_project WHERE methodology_id = ?',
      [m.methodology_id]
    )?.c ?? 0;
    return {
      id: m.id,
      methodology_id: m.methodology_id,
      code_display: m.code_display,
      name: m.name,
      version: m.version,
      document_status: m.document_status,
      domain: m.domain,
      project_types: uj(m.project_types, []),
      tech_routes: uj(m.tech_routes, []),
      scale_note: m.scale_note,
      crediting_note: m.crediting_note,
      release_date: m.release_date,
      effective_date: m.effective_date,
      official_url: m.official_url,
      rulecard_status: m.rulecard_status,
      calculator_status: m.calculator_status,
      catalog_confidence: m.catalog_confidence,
      is_candidate_eligible: !!m.is_candidate_eligible,
      exclusion_note: m.exclusion_note,
      has_rulecard_module: !!mod?.rulecard?.length,
      has_plugin_module: !!mod?.plugin,
      plugin_version: mod?.plugin?.plugin_version || null,
      public_projects: projectCount,
      gate,
      interpretations,
    };
  };
  const allItems = list.map(decorate);
  const formal = allItems.filter((m) => m.document_status === 'formal');
  const draft = allItems.filter((m) => m.document_status !== 'formal');
  const domains = [...new Set(allItems.map((m) => m.domain).filter(Boolean))].sort();
  return {
    formal,
    draft,
    domains,
    counts: {
      formal: formal.length,
      draft: draft.length,
      code_verified: allItems.filter((m) => m.catalog_confidence === 'verified_from_official_notice').length,
      code_pending: allItems.filter((m) => m.catalog_confidence !== 'verified_from_official_notice').length,
      doc_verified: allItems.filter((m) => m.gate.evidence_level === 'official_original_verified').length,
      domain_signed: allItems.filter((m) => m.gate.domain_review).length,
      calculable: allItems.filter((m) => m.gate.can_calculate).length,
    },
    note:
      '正式发布与征求意见分栏展示；草案仅作观察项。' +
      '「已对照原文」表示规则与公式已逐条核对官方 PDF 并通过独立复算，' +
      '但**仍需领域复核人签字与参数确认**才能出数，本目录如实显示两道门的状态。',
  };
}

/** 方法学详情（规则 / 公式 / 因子 / 对照台账 / 解读 / 修订差异） */
export function getMethodologyDetail(id) {
  const mv = listMethodologyVersions().find((m) => m.id === id);
  if (!mv) return null;
  const mod = getMethodologyModule(mv.methodology_id, mv.version);
  const rules = all('SELECT * FROM rule WHERE methodology_version_id = ? ORDER BY sort_order', [mv.id]).map((r) => ({
    ...r,
    expr: uj(r.expr, null),
    required_fields: uj(r.required_fields, []),
  }));
  const formulas = all('SELECT * FROM formula WHERE methodology_version_id = ?', [mv.id]);
  const factors = all(
    'SELECT * FROM factor_version WHERE methodology_version_id = ? OR methodology_version_id = ?',
    [`${mv.methodology_id}::${mv.version}`, '']
  );
  const verification = get('SELECT * FROM methodology_doc_verification WHERE methodology_version_id = ?', [mv.id]);
  const gate = methodologyGate(mv, mod);
  const interpretations = all(
    'SELECT * FROM methodology_interpretation WHERE methodology_id = ? AND (version = ? OR version IS NULL) ORDER BY section',
    [mv.methodology_id, mv.version]
  );
  const history = all(
    'SELECT id, methodology_id, version, document_status, release_date, effective_date, change_log FROM methodology_version WHERE methodology_id = ? ORDER BY COALESCE(release_date, \'1900-01-01\')',
    [mv.methodology_id]
  );
  const projects = all(
    'SELECT id, name, registry_project_no, current_stage, evidence_level FROM public_project WHERE methodology_id = ? LIMIT 50',
    [mv.methodology_id]
  );
  return {
    version: {
      ...mv,
      project_types: uj(mv.project_types, []),
      tech_routes: uj(mv.tech_routes, []),
    },
    rules,
    formulas,
    factors,
    verification: verification
      ? {
          ...verification,
          sections_verified: uj(verification.sections_verified, []),
          coverage: uj(verification.coverage_json, null),
          remaining_blockers: uj(verification.remaining_blockers, []),
        }
      : null,
    gate,
    interpretations: interpretations.map((i) => ({
      ...i,
      citations: uj(i.citations_json, []),
      origin_label: i.origin === 'llm_draft' ? 'AI 草稿（未复核）' : '人工撰写',
      status_label: i.status === 'reviewed' ? '已复核' : '草稿',
    })),
    plugin: mod?.plugin
      ? {
          plugin_key: mod.plugin.plugin_key,
          plugin_version: mod.plugin.plugin_version,
          title: mod.plugin.title,
          status_note: mod.plugin.status_note,
          formula_refs: mod.plugin.formula_refs,
          parameters: mod.plugin.parameters,
          scenarios: mod.plugin.scenarios,
          self_check_samples: mod.plugin.selfCheckSamples,
        }
      : null,
    rulecard: mod?.rulecard || null,
    version_history: history,
    public_projects: projects,
    note:
      '原文对照台账与独立复算结果只是**放行的必要条件**；' +
      '领域复核人签字（verified_by）与参数确认缺一不可。界面不会显示未满足条件的业务数值。',
  };
}

/** 方法学解读层写入（AI 草稿必须标注 origin=llm_draft，人工复核后 status=reviewed） */
export function upsertInterpretation(user, { methodology_id, version, section, content, origin = 'manual', citations = [] }) {
  const validSections = ['applicability', 'exclusions', 'required_data', 'carbon_impact'];
  if (!validSections.includes(section)) return { error: `section 取值非法（${validSections.join('/')}）`, status: 400 };
  if (!methodology_id || !content) return { error: '缺少 methodology_id 或 content', status: 400 };
  const isDraft = origin === 'llm_draft';
  run(
    `INSERT INTO methodology_interpretation
       (id,methodology_id,version,section,content,origin,status,citations_json,reviewed_by,reviewed_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(methodology_id,version,section) DO UPDATE SET
       content=excluded.content, origin=excluded.origin, status=excluded.status,
       citations_json=excluded.citations_json, reviewed_by=excluded.reviewed_by,
       reviewed_at=excluded.reviewed_at, updated_at=excluded.updated_at`,
    [
      newId('MIT'), methodology_id, version || null, section, content, origin,
      isDraft ? 'draft' : 'reviewed', j(citations || []),
      isDraft ? null : user?.name || 'unknown', isDraft ? null : nowIso(), nowIso(),
    ]
  );
  return {
    ok: true,
    status: isDraft ? 'draft' : 'reviewed',
    label: isDraft ? 'AI 草稿（未复核，不得作为判断依据）' : `已复核（${user?.name || 'unknown'}）`,
  };
}

/* ==================================================================== */
/*  三、完整性清单（已收录 / 待核实 / 已失效 / 采集失败）                  */
/* ==================================================================== */

export function catalogCompleteness() {
  const mvs = all('SELECT * FROM methodology_version');
  const formal = mvs.filter((m) => m.document_status === 'formal');
  const drafts = mvs.filter((m) => m.document_status !== 'formal');
  const included = formal.filter((m) => m.catalog_confidence === 'verified_from_official_notice');
  const pendingCode = mvs.filter((m) => m.catalog_confidence !== 'verified_from_official_notice');
  const repealed = mvs.filter((m) => m.document_status === 'repealed' || m.repeal_date);
  // 采集失败：最近的采集任务或核对记录中与该方法学相关的失败
  const fetchFailures = all(
    `SELECT * FROM data_reconciliation WHERE dataset = 'policy' AND status = 'open' AND check_kind IN ('missing_official_url','missing_attachment')
     ORDER BY detected_at DESC LIMIT 50`
  );
  const policies = all('SELECT * FROM policy_document');
  const policyMissingOrigin = policies.filter((p) => !p.official_url);
  const gaps = all("SELECT * FROM data_gap WHERE status = 'open' ORDER BY severity DESC, detected_at DESC");
  return {
    baseline: CATALOG_BASELINE,
    included: included.map((m) => ({
      id: m.id,
      code_display: m.code_display,
      name: m.name,
      version: m.version,
      release_date: m.release_date,
      official_url: m.official_url,
      evidence_level: m.evidence_level,
    })),
    pending_verification: pendingCode.map((m) => ({
      id: m.id,
      code_display: m.code_display,
      name: m.name,
      version: m.version,
      document_status: m.document_status,
      catalog_confidence: m.catalog_confidence,
      reason: '编号或名称尚未从官方发布通知正文逐条核实；系统不推测编号',
      evidence_level: m.evidence_level,
    })),
    repealed: repealed.map((m) => ({
      id: m.id, code_display: m.code_display, name: m.name, version: m.version,
      document_status: m.document_status, repeal_date: m.repeal_date,
    })),
    fetch_failures: fetchFailures.map((f) => ({
      id: f.id, object_label: f.object_label, check_kind: f.check_kind, detail: f.detail, detected_at: f.detected_at,
    })),
    counts: {
      total: mvs.length,
      included: included.length,
      pending_verification: pendingCode.length,
      drafts: drafts.length,
      repealed: repealed.length,
      fetch_failures: fetchFailures.length,
      policies: policies.length,
      policies_without_url: policyMissingOrigin.length,
      open_gaps: gaps.length,
    },
    data_gaps: gaps,
    fix_notes: [
      {
        item: 'CCER-14-001 / CCER-14-002 错号',
        status: 'fixed',
        detail:
          '已按环办气候函〔2023〕343号正文逐字核实：造林碳汇为 CCER-14-001-V01、红树林营造为 CCER-14-002-V01，' +
          '并记录「不得依据新闻稿列举顺序推断编号」的处理原则。',
      },
      {
        item: '公路隧道照明系统节能（CCER-07-001-V01）漏项',
        status: 'included',
        detail:
          '已按环办气候函〔2024〕486号（2025-01-03 发布）收录，编号已核实；原件尚未归档，条款页码待补。',
      },
    ],
    note:
      '完整性以官方来源目录与公告清单为对照，不把手工录入的固定数量当长期真值；' +
      '「待核实」条目可检索但不参与候选与测算。',
  };
}

export { POLICY_CATEGORIES, POLICY_CATEGORY_LABELS, POLICY_DOC_STATUS_LABELS };
