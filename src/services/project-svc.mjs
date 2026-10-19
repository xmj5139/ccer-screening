/**
 * 项目服务：项目档案、事实、证据、授权与保密
 * ============================================================================
 * 授权规则（设计文档第 8 节、第 10 节验收用例 7）：
 *   - 项目按机构 / 团队 / 项目分级授权
 *   - 保密等级 public 之外的项目，仅本团队成员、复核人与管理员可查看
 *   - 保密等级 restricted 的证据附件，仅政策研究员、复核人与管理员可查看
 *   - 一切导出行为写审计日志
 */
import { run, all, get, audit, tx } from '../core/db.mjs';
import { newId, nowIso, j, uj, isDate } from '../core/util.mjs';
import { FACT_FIELDS } from '../data/fact-fields.mjs';

export const ROLES = ['admin', 'researcher', 'analyst', 'reviewer', 'viewer'];
export const ROLE_LABELS = {
  admin: '系统管理员', researcher: '政策研究员', analyst: '投资分析师',
  reviewer: '领域复核人', viewer: '只读用户',
};

/**
 * 【仅 dev 模式使用】按客户端自报的 userId 解析身份。
 * ============================================================================
 * ⚠️ 这是一条**会被客户端伪造**的旧路径：调用方传入的 userId 来自请求头
 *    x-user-id 或查询参数 ?user=，任何人只要改一个请求头就能冒充管理员。
 *
 * 使用约束：
 *   1. 只允许在 auth_mode = dev（本地演示、认证已关闭）下被 server.mjs 调用；
 *   2. auth_mode = session（默认、生产）下**禁止**调用本函数，身份必须来自
 *      src/services/auth-svc.mjs 的 resolveSession()；
 *   3. 新增业务代码不要直接调用本函数，请使用请求上下文 ctx.user
 *      （由服务端会话解析得到）。
 */
export function resolveUser(userId) {
  if (!userId) userId = 'user-analyst';
  const u = get('SELECT * FROM app_user WHERE id = ? AND active = 1', [userId]);
  if (u) return u;
  return get('SELECT * FROM app_user WHERE role = ? LIMIT 1', ['analyst']);
}

export function canViewProject(user, project) {
  if (!project) return false;
  if (user.role === 'admin') return true;
  if (project.confidentiality === 'public') return true;
  return project.team_id === user.team_id;
}

export function canViewEvidence(user, evidence) {
  if (user.role === 'admin' || user.role === 'reviewer' || user.role === 'researcher') return true;
  return evidence.confidentiality !== 'restricted';
}

export function canExport(user) {
  return user.role !== 'viewer';
}

/** 需要项目级授权的路由与服务统一使用本函数，避免遗漏。 */
export function requireProjectAccess(user, projectId, { needManage = false } = {}) {
  const p = get('SELECT * FROM project WHERE id = ?', [projectId]);
  if (!p) return { error: '项目不存在', status: 404 };
  if (!canViewProject(user, p)) {
    return { error: '无权访问该项目（团队或保密等级限制）', status: 403 };
  }
  if (needManage && user.role === 'viewer') {
    return { error: '只读角色不能修改项目数据', status: 403 };
  }
  return { ok: true, project: p };
}

/** 角色白名单校验。返回 null 表示通过，否则返回 {error,status}。 */
export function requireRole(user, roles, action = '执行该操作') {
  if (!roles.includes(user.role)) {
    return {
      error: `当前角色「${ROLE_LABELS[user.role] || user.role}」无权限${action}（需要：${roles.map((r) => ROLE_LABELS[r] || r).join(' / ')}）`,
      status: 403,
    };
  }
  return null;
}

/* --------------------------------- 项目 --------------------------------- */

export function listProjects(user, { keyword, projectType, teamId, stage } = {}) {
  const where = [];
  const params = [];
  if (user.role !== 'admin') {
    where.push('(team_id = ? OR confidentiality = ?)');
    params.push(user.team_id, 'public');
  }
  if (keyword) {
    where.push('(name LIKE ? OR code LIKE ? OR owner_name LIKE ?)');
    params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
  }
  if (projectType) {
    where.push('project_type = ?');
    params.push(projectType);
  }
  if (teamId) {
    where.push('team_id = ?');
    params.push(teamId);
  }
  const sql = `SELECT * FROM project ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY updated_at DESC`;
  let rows = all(sql, params).map((p) => ({ ...p, registry_stage: registryStageLabel(p) }));
  // 按注册登记链条状态过滤（前端「阶段」筛选）
  if (stage) rows = rows.filter((p) => p.registry_stage.includes(stage));
  return rows;
}

/** 注册登记链条状态：分列存储、分别展示，绝不合并为一个状态 */
export function registryStageLabel(p) {
  const stages = [];
  if (p.registry_project_public) stages.push('项目公示');
  if (p.registry_validated) stages.push('审定');
  if (p.registry_project_registered) stages.push('项目登记');
  if (p.registry_reduction_public) stages.push('减排量公示');
  if (p.registry_verified) stages.push('核查');
  if (p.registry_reduction_registered) stages.push('减排量登记');
  return stages.length ? stages : ['未进入注册登记流程'];
}

export function getProjectFull(user, projectId) {
  const p = get('SELECT * FROM project WHERE id = ?', [projectId]);
  if (!p) return { error: '项目不存在', status: 404 };
  if (!canViewProject(user, p)) return { error: '无权访问该项目（团队或保密等级限制）', status: 403 };

  const factRows = all('SELECT * FROM project_fact WHERE project_id = ?', [projectId]);
  const evidenceRows = all('SELECT * FROM project_evidence WHERE project_id = ? ORDER BY uploaded_at DESC', [projectId]);
  const visibleEvidence = evidenceRows.filter((e) => canViewEvidence(user, e));

  const facts = factRows.map((f) => {
    const meta = FACT_FIELDS.find((x) => x.key === f.field_key);
    const ev = f.evidence_id ? evidenceRows.find((e) => e.id === f.evidence_id) : null;
    const evVisible = ev ? canViewEvidence(user, ev) : false;
    return {
      ...f,
      value: f.value_type === 'number' ? f.value_num : f.value_text,
      label: meta?.label || f.field_key,
      group_name: meta?.group_name || '其他',
      evidence_blocked: !!ev && !evVisible,
      evidence: ev && evVisible
        ? { id: ev.id, file_name: ev.file_name, doc_type: ev.doc_type, page: ev.page, excerpt: ev.excerpt }
        : ev
          ? { id: ev.id, blocked: true, note: '该证据附件受保密限制，当前角色不可查看' }
          : null,
    };
  });

  return {
    project: { ...p, registry_stage: registryStageLabel(p) },
    facts,
    evidence: visibleEvidence,
    evidence_total: evidenceRows.length,
    evidence_hidden: evidenceRows.length - visibleEvidence.length,
  };
}

export function createProject(user, payload) {
  const id = newId('PRJ');
  const code = payload.code || `CCER-${Date.now().toString(36).toUpperCase()}`;
  run(
    `INSERT INTO project (id,code,name,owner_name,province,city,project_type,technology_route,
      industry,stage,capacity_note,boundary_desc,confidentiality,team_id,analyst,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id, code, payload.name || '未命名项目', payload.owner_name || null,
      payload.province || null, payload.city || null, payload.project_type || null,
      payload.technology_route || null, payload.industry || null, payload.stage || null,
      payload.capacity_note || null, payload.boundary_desc || null,
      payload.confidentiality || 'internal', payload.team_id || user.team_id,
      payload.analyst || user.name, nowIso(), nowIso(),
    ]
  );
  audit({ actor: user.name, actorRole: user.role, action: 'project.create', objectType: 'project', objectId: id, detail: { code } });
  return get('SELECT * FROM project WHERE id = ?', [id]);
}

export function updateProjectRegistry(user, projectId, flags) {
  const access = requireProjectAccess(user, projectId, { needManage: true });
  if (access.error) return access;
  const p = access.project;
  const mapping = {
    registry_project_public: 'registry_project_public',
    registry_validated: 'registry_validated',
    registry_project_registered: 'registry_project_registered',
    registry_reduction_public: 'registry_reduction_public',
    registry_verified: 'registry_verified',
    registry_reduction_registered: 'registry_reduction_registered',
  };
  for (const [k, col] of Object.entries(mapping)) {
    if (k in flags) run(`UPDATE project SET ${col} = ? WHERE id = ?`, [flags[k] ? 1 : 0, projectId]);
  }
  for (const k of ['owner_announced_estimate', 'verified_amount', 'registered_amount', 'registry_public_url']) {
    if (k in flags) run(`UPDATE project SET ${k} = ? WHERE id = ?`, [flags[k], projectId]);
  }
  run('UPDATE project SET updated_at = ? WHERE id = ?', [nowIso(), projectId]);
  audit({
    actor: user.name, actorRole: user.role, action: 'project.registry_update',
    objectType: 'project', objectId: projectId, detail: flags,
  });
  return { ok: true };
}

/* -------------------------------- 证据 -------------------------------- */

export function addEvidence(user, projectId, payload) {
  const access = requireProjectAccess(user, projectId, { needManage: true });
  if (access.error) return access;
  if (payload.confidentiality === 'restricted' && !['admin', 'researcher', 'reviewer'].includes(user.role)) {
    return { error: '当前角色不能将证据标记为受限级', status: 403 };
  }
  const id = newId('EVD');
  run(
    `INSERT INTO project_evidence (id,project_id,file_name,file_hash,doc_type,page,line_ref,excerpt,
      uploaded_by,uploaded_at,confidentiality,retention_note)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id, projectId, payload.file_name || '未命名文件', payload.file_hash || null,
      payload.doc_type || '其他', payload.page ?? null, payload.line_ref || null,
      payload.excerpt || null, user.name, nowIso(),
      payload.confidentiality || 'internal', payload.retention_note || null,
    ]
  );
  audit({
    actor: user.name, actorRole: user.role, action: 'evidence.create',
    objectType: 'project_evidence', objectId: id, detail: { projectId, file_name: payload.file_name },
  });
  return get('SELECT * FROM project_evidence WHERE id = ?', [id]);
}

/* -------------------------------- 事实 -------------------------------- */

export function upsertFact(user, projectId, payload) {
  const access = requireProjectAccess(user, projectId, { needManage: true });
  if (access.error) return access;

  const meta = FACT_FIELDS.find((f) => f.key === payload.field_key);
  if (!meta) return { error: `未登记的字段：${payload.field_key}`, status: 400 };

  const sourceKind = payload.source_kind || 'analyst';
  const evidenceId = payload.evidence_id || null;

  // 严格证据字段：来源为 project_doc / official 时必须附证据
  if (meta.evidence_policy === 'strict' && ['project_doc', 'official'].includes(sourceKind) && !evidenceId) {
    return {
      error: `字段「${meta.label}」为严格证据字段，来源为${sourceKind === 'official' ? '官方文件' : '项目资料'}时必须选择证据记录`,
      status: 400,
    };
  }
  if (evidenceId) {
    const ev = get('SELECT * FROM project_evidence WHERE id = ? AND project_id = ?', [evidenceId, projectId]);
    if (!ev) return { error: '所引用的证据不存在或不属于该项目', status: 400 };
  }
  if (payload.value_type === 'date' && payload.value && !isDate(payload.value)) {
    return { error: `日期格式应为 YYYY-MM-DD，收到「${payload.value}」`, status: 400 };
  }

  const existing = get('SELECT * FROM project_fact WHERE project_id = ? AND field_key = ?', [projectId, payload.field_key]);
  const id = existing ? existing.id : newId('FCT');
  let text = null;
  let numv = null;
  const type = payload.value_type || meta.value_type;
  if (type === 'number') {
    if (payload.value !== null && payload.value !== '' && Number.isNaN(Number(payload.value))) {
      return { error: `字段「${meta.label}」为数值类型，收到「${payload.value}」（疑似单位或格式错误）`, status: 400 };
    }
    numv = payload.value === null || payload.value === '' ? null : Number(payload.value);
  } else if (type === 'bool') {
    text = payload.value === true || payload.value === 'true' || payload.value === 1 ? 'true' : 'false';
  } else {
    text = payload.value === null || payload.value === undefined ? null : String(payload.value);
  }

  if (existing) {
    run(
      `UPDATE project_fact SET value_text=?, value_num=?, value_type=?, unit=?, source_kind=?,
        evidence_id=?, asserted_by=?, asserted_at=?, note=? WHERE id=?`,
      [text, numv, type, meta.unit || null, sourceKind, evidenceId, user.name, nowIso(), payload.note || null, id]
    );
  } else {
    run(
      `INSERT INTO project_fact (id,project_id,field_key,value_text,value_num,value_type,unit,
        source_kind,evidence_id,asserted_by,asserted_at,note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, projectId, payload.field_key, text, numv, type, meta.unit || null, sourceKind, evidenceId, user.name, nowIso(), payload.note || null]
    );
  }
  run('UPDATE project SET updated_at = ? WHERE id = ?', [nowIso(), projectId]);
  audit({
    actor: user.name, actorRole: user.role, action: existing ? 'fact.update' : 'fact.create',
    objectType: 'project_fact', objectId: id,
    detail: { projectId, field_key: payload.field_key, source_kind: sourceKind, has_evidence: !!evidenceId },
  });
  return get('SELECT * FROM project_fact WHERE id = ?', [id]);
}

/** 供引擎使用：构造 FactStore 所需的原始数据 */
export function loadFactData(projectId) {
  const facts = all('SELECT * FROM project_fact WHERE project_id = ?', [projectId]);
  const evidenceRows = all('SELECT * FROM project_evidence WHERE project_id = ?', [projectId]);
  const evidenceById = new Map(evidenceRows.map((e) => [e.id, e]));
  return { facts, evidenceRows, evidenceById };
}

/** 缺失字段清单：生成「最小补充材料清单」 */
export function buildGapList(methodologyId, facts) {
  const have = new Set(facts.map((f) => f.field_key));
  const common = FACT_FIELDS.filter((f) => (f.required_for || []).includes('__COMMON__'));
  const specific = FACT_FIELDS.filter((f) => (f.required_for || []).includes(methodologyId));
  const missing = [...common, ...specific].filter((f) => !have.has(f.key));
  return missing.map((f) => ({
    field_key: f.key,
    label: f.label,
    group_name: f.group_name,
    evidence_policy: f.evidence_policy || 'normal',
    description: f.description || null,
    required_for: (f.required_for || []).includes('__COMMON__') ? '通用门槛' : methodologyId,
  }));
}

export function saveMatchRun(user, projectId, analysisBaseDate, result) {
  const id = newId('MCH');
  run(
    'INSERT INTO match_run (id,project_id,analysis_base_date,run_at,operator,result_json) VALUES (?,?,?,?,?,?)',
    [id, projectId, analysisBaseDate, nowIso(), user.name, j(result)]
  );
  return id;
}

export function saveEligibilityRun(user, projectId, methodologyVersionId, analysisBaseDate, conclusion, summary, result) {
  const id = newId('ELG');
  run(
    `INSERT INTO eligibility_run (id,project_id,methodology_version_id,analysis_base_date,run_at,operator,
      conclusion,blocking_failures,unknown_count,summary,result_json,review_status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id, projectId, methodologyVersionId, analysisBaseDate, nowIso(), user.name, conclusion,
      result.summary.blocking_failures, result.summary.unknown, summary, j(result), 'pending',
    ]
  );
  return id;
}

export function latestEligibilityRun(projectId) {
  const row = get(
    'SELECT * FROM eligibility_run WHERE project_id = ? ORDER BY run_at DESC LIMIT 1',
    [projectId]
  );
  if (!row) return null;
  return { ...row, result: uj(row.result_json, {}) };
}

export function listRuns(projectId) {
  return {
    matches: all('SELECT id, analysis_base_date, run_at, operator FROM match_run WHERE project_id = ? ORDER BY run_at DESC', [projectId]),
    eligibility: all(
      `SELECT e.id, e.analysis_base_date, e.run_at, e.operator, e.conclusion, e.review_status, e.summary,
              m.code_display, m.name AS methodology_name
       FROM eligibility_run e LEFT JOIN methodology_version m ON m.id = e.methodology_version_id
       WHERE e.project_id = ? ORDER BY e.run_at DESC`,
      [projectId]
    ),
    calculations: all(
      `SELECT c.id, c.scenario, c.run_at, c.operator, c.status, c.audit_status, c.plugin_key,
              c.plugin_version, c.rejection_reason, c.result_json, m.code_display, m.name AS methodology_name
       FROM calculation_run c LEFT JOIN methodology_version m ON m.id = c.methodology_version_id
       WHERE c.project_id = ? ORDER BY c.run_at DESC`,
      [projectId]
    ),
  };
}

export { tx, j };
