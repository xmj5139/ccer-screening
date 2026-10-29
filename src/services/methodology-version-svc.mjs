/**
 * 方法学版本跟踪（docs/74 C）
 * ============================================================================
 * 原则：
 *   - 版本时间线只来自真实字段与**有证据的关系**；不按编号相邻推断继承；
 *   - 关系必须保存原文 URL、段落/页码定位、逐字引文，并通过既有自动核验，
 *     才可成为 confirmed；否则保持 candidate，界面明确「待核实」；
 *   - 版本差异只比较已归档字段/正文/规则/公式/因子；取不到证据时写
 *     「无法比较」，不凭标题或模型记忆编造；
 *   - 正式版本与征求意见稿分栏；未来生效日期按当前日期判断；
 *   - 现有 calculation_run 保留 methodology_version_id 与 inputs_json，
 *     本服务只读，不因新版本发布改写旧结果。
 */
import { all, get, run } from '../core/db.mjs';
import { newId, nowIso, todayCst, j, uj } from '../core/util.mjs';
import { objectVerificationInput, INPUT_HASH_SCHEME } from './verification-svc.mjs';

export const RELATION_TYPES = {
  supersedes: '替代',
  revises: '修订',
  replaces: '取代',
  repeals: '废止',
  consults: '征求意见',
  supplements: '补充',
};

export const ASPECTS = {
  applicability: '适用范围',
  boundary: '项目边界',
  parameters: '关键参数',
  crediting_period: '计入期',
  monitoring: '监测要求',
};

const RELATION_KEYS = Object.keys(RELATION_TYPES);

function versionById(id) {
  const v = get('SELECT * FROM methodology_version WHERE id=?', [String(id)]);
  if (!v) return null;
  return { ...v, project_types: uj(v.project_types, []), tech_routes: uj(v.tech_routes, []) };
}

function normalizeEvidence(text) {
  return String(text || '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。；：、,.;:!?！？“”"'（）()【】\[\]—–\-]/g, '')
    .toLowerCase();
}

function verificationPassed(versionId) {
  const row = get(
    `SELECT * FROM verification_result
      WHERE object_type='methodology_version' AND object_id=? AND result='verified'
      ORDER BY created_at DESC LIMIT 1`,
    [String(versionId)]
  );
  if (!row) {
    return { ok: false, basis: '未找到该版本的既有 verified 核验记录（可变状态字段不构成确认依据）' };
  }
  const version = versionById(versionId);
  if (version?.updated_at && row.created_at < version.updated_at) {
    return { ok: false, basis: '既有核验早于当前版本正文更新时间，不能用于确认新正文' };
  }
  // 仅“时间较新”不够：必须与**当前**版本字段/正文/策略/模型生成的签名一致。
  try {
    const current = objectVerificationInput('methodology_version', versionId);
    if (!current || row.input_hash_scheme !== INPUT_HASH_SCHEME || row.input_hash !== current.inputHash) {
      return { ok: false, basis: '既有核验的输入签名与当前版本不一致，不能用于确认新正文' };
    }
  } catch {
    return { ok: false, basis: '无法计算当前版本核验签名，保持候选' };
  }
  return { ok: true, basis: `既有自动核验通过（${row.id}，${row.created_at}）`, verification_id: row.id };
}

const RELATION_EVIDENCE_TERMS = {
  supersedes: ['替代', '取代', '废止', '停止执行', '不再适用'],
  revises: ['修订', '修改', '更新', '调整'],
  replaces: ['取代', '替代'],
  repeals: ['废止', '撤销', '停止执行'],
  consults: ['征求意见', '征求'],
  supplements: ['补充', '增补'],
};

function sameSourceUrl(a, b) {
  try {
    const x = new URL(String(a));
    const y = new URL(String(b));
    // Download endpoints can distinguish documents by query parameters (fileId/id).
    // Preserve those identifiers; only fragments and parameter ordering are irrelevant.
    x.hash = ''; y.hash = '';
    x.searchParams.sort(); y.searchParams.sort();
    return x.href === y.href;
  } catch {
    return false;
  }
}

/**
 * 判断一条关系能否确认。任一硬条件不满足都只保持 candidate。
 */
export function evaluateRelation(relation) {
  const from = versionById(relation.from_version_id);
  const to = versionById(relation.to_version_id);
  if (!from || !to) return { confirmable: false, reason: '版本记录不存在' };
  if (from.id === to.id) return { confirmable: false, reason: '关系两端不能是同一版本' };
  if (from.methodology_id !== to.methodology_id) {
    return { confirmable: false, reason: '关系两端必须属于同一 methodology_id' };
  }
  if (!RELATION_KEYS.includes(relation.relation_type)) return { confirmable: false, reason: '关系类型不在白名单' };
  if (!/^https?:\/\//i.test(String(relation.evidence_url || ''))) {
    return { confirmable: false, reason: '缺少 http(s) 原文 URL' };
  }
  const locator = String(relation.evidence_locator || '').trim();
  const quote = String(relation.evidence_quote || '').trim();
  if (!locator) return { confirmable: false, reason: '缺少段落/页码定位' };
  if (quote.length < 8) return { confirmable: false, reason: '缺少可核对的逐字引文（至少 8 字）' };
  const quoteNorm = normalizeEvidence(quote);
  const relationTerms = RELATION_EVIDENCE_TERMS[relation.relation_type] || [];
  if (!relationTerms.some((term) => quote.includes(term))) {
    return {
      confirmable: false,
      reason: `引文未体现「${RELATION_TYPES[relation.relation_type] || relation.relation_type}」关系（普通适用范围句子不能证明版本关系）`,
    };
  }
  // The source identifies this version, but the quote must identify the other
  // endpoint too. A statement replacing V00 cannot prove replacement of V01.
  const targetCode = normalizeEvidence(to.code_display || `${to.methodology_id}-${to.version}`);
  const escapedVersion = String(to.version || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const targetVersionMentioned = /^V\d+/i.test(String(to.version || '')) && escapedVersion
    && new RegExp(`(?:^|[^A-Za-z0-9])${escapedVersion}(?![A-Za-z0-9])`, 'i').test(quote);
  if (!(targetCode && quoteNorm.includes(targetCode)) && !targetVersionMentioned) {
    return { confirmable: false, reason: '引文未明确指向目标版本编号，不能用其他版本的替代声明确认该关系' };
  }
  // 关键绑定：证据 URL、引文正文、当前核验三者必须来自**同一个版本记录**。
  // 不能拿 B 的引文配 A 的 URL，也不能拿任意历史 verified 记录来顶替当前输入。
  const evidenceSources = [from, to].filter((v) => v.official_url && sameSourceUrl(v.official_url, relation.evidence_url));
  if (!evidenceSources.length) {
    return { confirmable: false, reason: '证据 URL 必须是两版登记原文之一（精确来源，不接受前缀/相似域名）' };
  }
  const quoteSources = evidenceSources.filter((v) => normalizeEvidence(v.body_snapshot || '').includes(quoteNorm));
  if (!quoteSources.length) {
    return { confirmable: false, reason: '引文不在证据 URL 对应的版本正文中（不能拿另一版本的句子证明本来源）' };
  }
  const verifiedSources = quoteSources
    .map((v) => ({ version: v, verification: verificationPassed(v.id) }))
    .filter((x) => x.verification.ok);
  if (!verifiedSources.length) {
    return {
      confirmable: false,
      reason: quoteSources.map((v) => verificationPassed(v.id).basis).join('；') || '证据来源未通过当前输入核验',
    };
  }
  const picked = verifiedSources[0];
  return {
    confirmable: true,
    basis: [
      `证据来源版本：${picked.version.code_display || picked.version.version}`,
      '原文引文可在该来源正文中定位',
      locator ? `定位：${locator}` : null,
      `核验：${picked.verification.basis}`,
    ].filter(Boolean).join('；'),
    verification_id: picked.verification.verification_id || null,
  };
}

function relationRow(r) {
  const from = get('SELECT id,methodology_id,code_display,name,version,document_status,release_date,effective_date,official_url FROM methodology_version WHERE id=?', [r.from_version_id]);
  const to = get('SELECT id,methodology_id,code_display,name,version,document_status,release_date,effective_date,official_url FROM methodology_version WHERE id=?', [r.to_version_id]);
  return {
    ...r,
    relation_type_label: RELATION_TYPES[r.relation_type] || r.relation_type,
    from: from || { id: r.from_version_id, missing: true },
    to: to || { id: r.to_version_id, missing: true },
  };
}

export function listRelations({ versionId = null, methodologyId = null, status = null, limit = 100 } = {}) {
  const where = [];
  const params = [];
  if (versionId) {
    where.push('(r.from_version_id=? OR r.to_version_id=?)');
    params.push(String(versionId), String(versionId));
  }
  if (methodologyId) {
    const ids = all('SELECT id FROM methodology_version WHERE methodology_id=?', [String(methodologyId)]).map((x) => x.id);
    if (!ids.length) return [];
    where.push(`(r.from_version_id IN (${ids.map(() => '?').join(',')}) OR r.to_version_id IN (${ids.map(() => '?').join(',')}))`);
    params.push(...ids, ...ids);
  }
  if (status) { where.push('r.status=?'); params.push(status); }
  const rows = all(
    `SELECT r.* FROM methodology_version_relation r
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY r.created_at DESC LIMIT ?`,
    [...params, Math.max(1, Math.min(Number(limit) || 100, 300))]
  );
  return rows.map(relationRow);
}

/** 把旧库里的 supersedes_id 作为**候选**同步，绝不直接当作确认关系。 */
export function syncLegacyRelationCandidates() {
  const rows = all(
    `SELECT id, methodology_id, supersedes_id, release_date FROM methodology_version
      WHERE supersedes_id IS NOT NULL AND supersedes_id <> ''`
  );
  let inserted = 0;
  for (const v of rows) {
    if (!get('SELECT id FROM methodology_version WHERE id=?', [v.supersedes_id])) continue;
    const key = `legacy:${v.id}:supersedes:${v.supersedes_id}`;
    const out = run(
      `INSERT OR IGNORE INTO methodology_version_relation
         (id,relation_key,from_version_id,to_version_id,relation_type,status,confirmation_basis,created_by,created_at,updated_at)
       VALUES (?,?,?,?,?,'candidate',?,?,?,?)`,
      [newId('MVR'), key, v.id, v.supersedes_id, 'supersedes',
        '来自旧字段 supersedes_id；缺少原文定位与逐字引文，待核实，不作为确认继承关系。',
        'system:legacy-sync', nowIso(), nowIso()]
    );
    if (Number(out?.changes || 0) > 0) inserted += 1;
  }
  return { scanned: rows.length, inserted };
}

/**
 * 提交候选关系（管理员/研究员）。可立即通过证据校验则确认，否则保持 candidate。
 */
export function proposeRelation(user, input = {}) {
  if (!user || !['admin', 'researcher'].includes(user.role)) {
    return { error: '仅管理员或政策研究员可提交版本关系', status: 403 };
  }
  const fromId = String(input.from_version_id || '');
  const toId = String(input.to_version_id || '');
  const type = String(input.relation_type || '');
  if (!fromId || !toId || fromId === toId) return { error: '需要两个不同的版本 ID', status: 400 };
  if (!RELATION_KEYS.includes(type)) return { error: `关系类型须为 ${RELATION_KEYS.join('/')}`, status: 400 };
  if (!versionById(fromId) || !versionById(toId)) return { error: '版本记录不存在', status: 404 };
  const evidenceUrl = String(input.evidence_url || '').trim();
  const evidenceLocator = String(input.evidence_locator || '').trim();
  const evidenceQuote = String(input.evidence_quote || '').trim();
  if (!/^https?:\/\//i.test(evidenceUrl)) return { error: '证据 URL 必须是 http(s)', status: 400 };
  if (!evidenceLocator) return { error: '必须提供段落/页码定位', status: 400 };
  if (evidenceQuote.length < 8) return { error: '必须提供至少 8 字的逐字引文', status: 400 };

  const key = `${fromId}->${toId}:${type}`;
  const existing = get(
    `SELECT * FROM methodology_version_relation
      WHERE relation_key=? OR (from_version_id=? AND to_version_id=? AND relation_type=?)
      ORDER BY CASE status WHEN 'confirmed' THEN 0 ELSE 1 END LIMIT 1`,
    [key, fromId, toId, type]
  );
  if (existing?.status === 'confirmed') {
    return { ok: true, relation: relationRow(existing), note: '关系已确认，保留原确认证据，不因重复提交降级。' };
  }
  const id = existing?.id || newId('MVR');
  const now = nowIso();
  const basis = '提交的候选关系；系统按原文引文定位与既有核验自动判定';
  if (existing) {
    run(
      `UPDATE methodology_version_relation SET evidence_url=?, evidence_locator=?, evidence_quote=?,
         evidence_hash=?, status='candidate', confirmation_basis=?, confirmed_at=NULL, created_by=?, updated_at=?
       WHERE id=?`,
      [evidenceUrl, evidenceLocator, evidenceQuote, input.evidence_hash || null, basis, user.name || 'unknown', now, id]
    );
  } else {
    run(
      `INSERT INTO methodology_version_relation
         (id,relation_key,from_version_id,to_version_id,relation_type,evidence_url,evidence_locator,
          evidence_quote,evidence_hash,status,confirmation_basis,created_by,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,'candidate',?,?,?,?)`,
      [id, key, fromId, toId, type, evidenceUrl, evidenceLocator, evidenceQuote,
        input.evidence_hash || null, basis, user.name || 'unknown', now, now]
    );
  }
  return reconcileRelation(id);
}

/** 对单条候选重新评估（可在核验完成后自动调用）。 */
export function reconcileRelation(id) {
  const r = get('SELECT * FROM methodology_version_relation WHERE id=?', [id]);
  if (!r) return { error: '关系记录不存在', status: 404 };
  if (r.status === 'confirmed') return { ok: true, relation: relationRow(r), confirmed: true };
  const verdict = evaluateRelation(r);
  if (!verdict.confirmable) {
    run(
      `UPDATE methodology_version_relation SET status='candidate', confirmation_basis=?, updated_at=? WHERE id=?`,
      [verdict.reason, nowIso(), r.id]
    );
    return { ok: false, relation: relationRow(get('SELECT * FROM methodology_version_relation WHERE id=?', [r.id])), confirmed: false, reason: verdict.reason };
  }
  run(
    `UPDATE methodology_version_relation SET status='confirmed', confirmation_basis=?, confirmed_at=?, updated_at=? WHERE id=?`,
    [verdict.basis, nowIso(), nowIso(), r.id]
  );
  return { ok: true, relation: relationRow(get('SELECT * FROM methodology_version_relation WHERE id=?', [r.id])), confirmed: true };
}

/** 核验批次结束后自动确认满足条件的关系；不满足的保持候选。 */
export function reconcileAllRelations() {
  const rows = all("SELECT id FROM methodology_version_relation WHERE status='candidate'");
  const out = { scanned: rows.length, confirmed: 0, kept: 0, errors: 0 };
  for (const r of rows) {
    try {
      const res = reconcileRelation(r.id);
      if (res.confirmed) out.confirmed += 1; else out.kept += 1;
    } catch { out.errors += 1; }
  }
  return out;
}

function versionEventRows(v) {
  const events = [];
  const add = (type, label, date, extra = {}) => events.push({
    type, label, date: date || null,
    version_id: v.id, version: v.version, code_display: v.code_display,
    official_url: v.official_url || null, file_hash: v.original_file_hash || null,
    evidence_locator: extra.evidence_locator || null, evidence_quote: extra.evidence_quote || null,
    status: extra.status || 'recorded',
    status_label: extra.status_label || '结构化字段记录（未附原文定位）',
    note: extra.note || null,
  });
  if (v.consultation_start || ['draft', 'consultation', 'revised_draft'].includes(String(v.document_status))) {
    add('consultation', '征求意见', v.consultation_start || v.release_date, {
      status: 'recorded', status_label: '征求意见稿，不是正式发布',
      note: v.consultation_end ? `征求意见截止 ${v.consultation_end}` : '截止日期未记录',
    });
  }
  if (v.document_status === 'formal') {
    add('formal', '正式发布', v.release_date, {
      status: 'recorded', status_label: '正式发布记录',
      note: v.effective_date
        ? `生效日 ${v.effective_date}${v.effective_date > todayCst() ? '（未来生效）' : ''}`
        : '生效日期未记录',
    });
  }
  if (v.document_status === 'repealed' || v.repeal_date) {
    add('repeal', '废止', v.repeal_date, {
      status: 'recorded', status_label: '废止记录',
      note: v.repeal_date ? null : '废止日期未记录',
    });
  }
  return events;
}

/**
 * 同一 methodology_id 的完整版本时间线 + 关系证据。
 * 不把编号相邻的版本自动串成继承关系。
 */
export function methodologyTimeline(versionOrMethodologyId) {
  syncLegacyRelationCandidates();
  let base = versionById(versionOrMethodologyId);
  let methodologyId = base?.methodology_id || String(versionOrMethodologyId);
  if (!base) {
    base = get(
      'SELECT * FROM methodology_version WHERE methodology_id=? ORDER BY COALESCE(release_date,\'1900-01-01\') DESC LIMIT 1',
      [methodologyId]
    );
    if (!base) return null;
    base = versionById(base.id);
    methodologyId = base.methodology_id;
  }
  const versions = all(
    'SELECT * FROM methodology_version WHERE methodology_id=? ORDER BY COALESCE(release_date,\'1900-01-01\'), version',
    [methodologyId]
  ).map((v) => {
    const full = { ...v, project_types: uj(v.project_types, []), tech_routes: uj(v.tech_routes, []) };
    const relations = listRelations({ versionId: v.id, limit: 50 });
    const confirmed = relations.filter((r) => r.status === 'confirmed');
    const events = versionEventRows(full);
    // 修订/替代只来自已确认关系；候选关系在 relations 中展示，不写成已发生事件。
    for (const rel of confirmed) {
      if (rel.from_version_id === v.id && rel.relation_type === 'revises') {
        events.push({
          type: 'revision', label: '修订（有证据）', date: v.release_date || rel.confirmed_at,
          version_id: v.id, version: v.version, code_display: v.code_display,
          official_url: rel.evidence_url, evidence_locator: rel.evidence_locator,
          evidence_quote: rel.evidence_quote, status: 'confirmed', status_label: '已确认（原文证据 + 既有核验）',
          note: rel.to?.code_display ? `修订自 ${rel.to.code_display}` : null,
        });
      }
      if (rel.to_version_id === v.id && ['supersedes', 'replaces', 'repeals'].includes(rel.relation_type)) {
        events.push({
          type: rel.relation_type === 'repeals' ? 'repeal' : 'superseded',
          label: rel.relation_type === 'repeals' ? '废止（有证据）' : '已被替代（有证据）',
          date: v.release_date || rel.confirmed_at,
          version_id: v.id, version: v.version, code_display: v.code_display,
          official_url: rel.evidence_url, evidence_locator: rel.evidence_locator,
          evidence_quote: rel.evidence_quote, status: 'confirmed', status_label: '已确认（原文证据 + 既有核验）',
          note: rel.from?.code_display ? `关系来源 ${rel.from.code_display}` : null,
        });
      }
    }
    const calc = all(
      'SELECT id, project_id, run_at, status, inputs_json, factor_snapshot_json FROM calculation_run WHERE methodology_version_id=? ORDER BY run_at DESC LIMIT 20',
      [v.id]
    );
    return {
      ...full,
      is_formal: v.document_status === 'formal',
      status_label: v.document_status === 'formal'
        ? (v.effective_date && v.effective_date > todayCst() ? '正式发布（未来生效）' : '正式发布')
        : v.document_status === 'repealed' ? '已废止' : '征求意见 / 草案（不得当作现行正式方法学）',
      future_effective: !!(v.effective_date && v.effective_date > todayCst()),
      events: events.sort((a, b) => String(a.date || '').localeCompare(String(b.date || ''))),
      relations,
      calculation_runs: calc.length,
      calculation_runs_note: calc.length
        ? '旧测算保留 calculation_run.methodology_version_id 与 inputs_json/factor_snapshot_json；新版本发布不改写旧结果。'
        : '暂无测算记录引用此版本。',
      calculation_samples: calc.slice(0, 3).map((c) => ({
        id: c.id, project_id: c.project_id, run_at: c.run_at, status: c.status,
        input_keys: Object.keys(uj(c.inputs_json, {}) || {}).slice(0, 12),
      })),
    };
  });
  return {
    methodology_id: methodologyId,
    version: base,
    formal: versions.filter((v) => v.is_formal),
    draft: versions.filter((v) => !v.is_formal),
    timeline: versions,
    relation_types: RELATION_TYPES,
    note:
      '时间线只使用结构化日期与已确认关系；编号相邻不等于继承。' +
      '候选关系（candidate）明确待核实，只有原文定位、逐字引文与既有核验同时满足才会确认。' +
      '未来生效日期按当前日期显示。',
  };
}

function findBodyParagraph(body, keywords) {
  const text = String(body || '').trim();
  if (!text) return null;
  const chunks = text.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  for (let i = 0; i < chunks.length; i += 1) {
    if (keywords.some((k) => chunks[i].includes(k))) {
      return { quote: chunks[i].slice(0, 500), locator: `正文快照第 ${i + 1} 段` };
    }
  }
  // 没有段落分隔时，仍给出可核对的上下文，但定位如实写明「关键词上下文」。
  for (const k of keywords) {
    const idx = text.indexOf(k);
    if (idx >= 0) {
      const start = Math.max(0, idx - 100);
      return {
        quote: text.slice(start, Math.min(text.length, idx + 300)),
        locator: `正文快照关键词「${k}」上下文`,
      };
    }
  }
  return null;
}

function fieldEvidence(v, fields) {
  const bits = fields.filter((f) => v[f] !== null && v[f] !== undefined && String(v[f]).trim() !== '');
  if (!bits.length) return null;
  return {
    version_id: v.id,
    version: v.version,
    code_display: v.code_display,
    url: v.official_url || null,
    locator: `结构化字段：${bits.join('、')}`,
    quote: bits.map((f) => `${f}=${typeof v[f] === 'object' ? JSON.stringify(v[f]) : v[f]}`).join('；').slice(0, 500),
  };
}

function relationEvidence(v, bodyEvidence) {
  if (!bodyEvidence) return null;
  return {
    version_id: v.id, version: v.version, code_display: v.code_display,
    url: v.official_url || null, locator: bodyEvidence.locator, quote: bodyEvidence.quote,
  };
}

function compareAspect(version, compare, aspect) {
  const a = version;
  const b = compare;
  if (aspect === 'applicability') {
    const fields = ['project_types', 'tech_routes', 'domain', 'scale_note'];
    const valuesA = fields.map((f) => a[f]).filter((x) => (Array.isArray(x) ? x.length : x));
    const valuesB = fields.map((f) => b[f]).filter((x) => (Array.isArray(x) ? x.length : x));
    if (!valuesA.length || !valuesB.length) {
      return { aspect, change_kind: 'insufficient', summary: '一方或双方未归档适用范围字段，无法比较。', evidence: [] };
    }
    const same = JSON.stringify(fields.map((f) => a[f] ?? null)) === JSON.stringify(fields.map((f) => b[f] ?? null));
    return {
      aspect, change_kind: same ? 'same' : 'changed',
      summary: same ? '适用范围字段一致。' : `适用范围字段不同：${fields.map((f) => `${f} ${JSON.stringify(a[f] ?? null)} → ${JSON.stringify(b[f] ?? null)}`).join('；')}`,
      evidence: [fieldEvidence(a, fields), fieldEvidence(b, fields)].filter(Boolean),
    };
  }
  if (aspect === 'boundary') {
    const ea = findBodyParagraph(a.body_snapshot, ['项目边界', '边界', '空间范围']);
    const eb = findBodyParagraph(b.body_snapshot, ['项目边界', '边界', '空间范围']);
    if (!ea || !eb) {
      return { aspect, change_kind: 'insufficient', summary: '一方或双方未归档包含「项目边界」的正文段落，无法比较。', evidence: [relationEvidence(a, ea), relationEvidence(b, eb)].filter(Boolean) };
    }
    const same = normalizeEvidence(ea.quote) === normalizeEvidence(eb.quote);
    return {
      aspect, change_kind: same ? 'same' : 'changed',
      summary: same ? '两边正文中的边界段落一致。' : '项目边界段落存在差异，请逐条核对原文。',
      evidence: [relationEvidence(a, ea), relationEvidence(b, eb)].filter(Boolean),
    };
  }
  if (aspect === 'parameters') {
    const load = (id) => ({
      rules: all('SELECT rule_id,title,severity,clause_ref FROM rule WHERE methodology_version_id=? ORDER BY rule_id', [id]),
      formulas: all('SELECT formula_id AS formula_key,expression,clause_ref FROM formula WHERE methodology_version_id=? ORDER BY formula_id', [id]),
      factors: all('SELECT factor_key,value AS value_num,NULL AS value_text,unit,source_year AS applicable_year FROM factor_version WHERE methodology_version_id=? ORDER BY factor_key', [id]),
    });
    const pa = load(a.id);
    const pb = load(b.id);
    const totalA = pa.rules.length + pa.formulas.length + pa.factors.length;
    const totalB = pb.rules.length + pb.formulas.length + pb.factors.length;
    if (!totalA || !totalB) {
      return {
        aspect, change_kind: 'insufficient',
        summary: `一方或双方未归档规则/公式/因子（${totalA} → ${totalB} 条），无法比较关键参数。`,
        evidence: [],
      };
    }
    const same = JSON.stringify(pa) === JSON.stringify(pb);
    const changes = [];
    const factorMapA = new Map(pa.factors.map((f) => [f.factor_key, f]));
    for (const f of pb.factors) {
      const old = factorMapA.get(f.factor_key);
      if (old && JSON.stringify(old) !== JSON.stringify(f)) {
        changes.push(`${f.factor_key} ${old.value_num ?? old.value_text ?? '—'}${old.unit || ''} → ${f.value_num ?? f.value_text ?? '—'}${f.unit || ''}`);
      }
    }
    const summary = same
      ? '规则/公式/因子归档内容一致。'
      : `规则 ${pa.rules.length}→${pb.rules.length}；公式 ${pa.formulas.length}→${pb.formulas.length}；因子 ${pa.factors.length}→${pb.factors.length}` +
        (changes.length ? `；参数变化示例：${changes.slice(0, 3).join('；')}` : '；具体数值差异需逐条核对原文');
    return {
      aspect, change_kind: same ? 'same' : 'changed', summary,
      evidence: [
        { version_id: a.id, version: a.version, code_display: a.code_display, url: a.official_url || null, locator: '规则/公式/因子结构化表', quote: `规则 ${pa.rules.length}；公式 ${pa.formulas.length}；因子 ${pa.factors.length}` },
        { version_id: b.id, version: b.version, code_display: b.code_display, url: b.official_url || null, locator: '规则/公式/因子结构化表', quote: `规则 ${pb.rules.length}；公式 ${pb.formulas.length}；因子 ${pb.factors.length}` },
      ],
    };
  }
  if (aspect === 'crediting_period') {
    const ea = findBodyParagraph(a.body_snapshot, ['计入期']) || (a.crediting_note ? { quote: a.crediting_note, locator: '结构化字段：crediting_note' } : null);
    const eb = findBodyParagraph(b.body_snapshot, ['计入期']) || (b.crediting_note ? { quote: b.crediting_note, locator: '结构化字段：crediting_note' } : null);
    if (!ea || !eb) return { aspect, change_kind: 'insufficient', summary: '一方或双方未归档计入期说明，无法比较。', evidence: [relationEvidence(a, ea), relationEvidence(b, eb)].filter(Boolean) };
    const same = normalizeEvidence(ea.quote) === normalizeEvidence(eb.quote);
    return {
      aspect, change_kind: same ? 'same' : 'changed',
      summary: same ? '计入期说明一致。' : '计入期说明不同，请核对来源段落。',
      evidence: [relationEvidence(a, ea), relationEvidence(b, eb)].filter(Boolean),
    };
  }
  if (aspect === 'monitoring') {
    const ea = findBodyParagraph(a.body_snapshot, ['监测', '计量', '核查']);
    const eb = findBodyParagraph(b.body_snapshot, ['监测', '计量', '核查']);
    if (!ea || !eb) return { aspect, change_kind: 'insufficient', summary: '一方或双方未归档监测/计量/核查段落，无法比较。', evidence: [relationEvidence(a, ea), relationEvidence(b, eb)].filter(Boolean) };
    const same = normalizeEvidence(ea.quote) === normalizeEvidence(eb.quote);
    return {
      aspect, change_kind: same ? 'same' : 'changed',
      summary: same ? '监测/计量段落一致。' : '监测/计量要求存在差异，请核对来源段落。',
      evidence: [relationEvidence(a, ea), relationEvidence(b, eb)].filter(Boolean),
    };
  }
  return { aspect, change_kind: 'insufficient', summary: '未知比较维度。', evidence: [] };
}

/**
 * 计算并持久化两个版本的差异。证据不足的维度明确返回无法比较。
 */
export function compareVersions(versionId, compareVersionId) {
  const a = versionById(versionId);
  const b = versionById(compareVersionId);
  if (!a || !b) return { error: '版本记录不存在', status: 404 };
  if (a.methodology_id !== b.methodology_id) return { error: '只能比较同一 methodology_id 下的版本', status: 400 };
  const diffs = [];
  for (const aspect of Object.keys(ASPECTS)) {
    const d = compareAspect(a, b, aspect);
    const id = newId('MVD');
    run(
      `INSERT INTO methodology_version_diff
         (id,version_id,compare_version_id,aspect,change_kind,summary,evidence_json,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(version_id,compare_version_id,aspect) DO UPDATE SET
         change_kind=excluded.change_kind, summary=excluded.summary,
         evidence_json=excluded.evidence_json, updated_at=excluded.updated_at`,
      [id, a.id, b.id, aspect, d.change_kind, d.summary, j(d.evidence || []), nowIso(), nowIso()]
    );
    diffs.push({
      ...d,
      aspect_label: ASPECTS[aspect],
      evidence: d.evidence || [],
    });
  }
  const insufficient = diffs.filter((d) => d.change_kind === 'insufficient');
  return {
    ok: true,
    version: { id: a.id, code_display: a.code_display, version: a.version, release_date: a.release_date, official_url: a.official_url },
    compare: { id: b.id, code_display: b.code_display, version: b.version, release_date: b.release_date, official_url: b.official_url },
    diffs,
    can_compare: insufficient.length < diffs.length,
    insufficient_aspects: insufficient.map((d) => d.aspect_label),
    note:
      '每条差异带来源字段/正文段落定位；取不到证据的维度明确写「无法比较」，不据标题或编号推断。' +
      '比较结果不修改任何一版原文或既有测算结果。',
  };
}

/** 读取已持久化的差异（没有则提示需先比较）。 */
export function savedDiffs(versionId, compareVersionId = null) {
  const rows = all(
    `SELECT * FROM methodology_version_diff WHERE version_id=? ${compareVersionId ? 'AND compare_version_id=?' : ''}
      ORDER BY aspect`,
    compareVersionId ? [String(versionId), String(compareVersionId)] : [String(versionId)]
  ).map((r) => ({ ...r, evidence: uj(r.evidence_json, []), aspect_label: ASPECTS[r.aspect] || r.aspect }));
  return rows;
}
