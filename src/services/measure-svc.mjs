/**
 * 碳减排测算模块服务（六模块之「碳减排测算」）
 * ============================================================================
 * 需求规格 1.5：
 *   - 入口分为「新建测算」与「从项目档案测算」；
 *   - 判断顺序：方法学版本有效 → 通用申报条件 → 专属适用条件 → 关键数据完整性 → 公式计算；
 *     任一硬性适用条件不满足时，**不能生成可用于业务筛选的减排量数值**；
 *     信息不足时显示「待核实」和补证清单；
 *   - 仅正式方法学、已逐式复核的规则卡与计算插件可以出业务数值；
 *   - 输出必须包含：公式与代入值、因子来源与年份、方法学条款页码、输入与假设、
 *     数据质量、主要缺口、复核状态；历史运行按方法学、因子与输入快照留存。
 *
 * 【本模块的硬约束（本轮开发的明确要求）】
 *   1. 领域专家没有实际签字（methodology_doc_verification.verified_by 为空）时，
 *      **不得正式出数**；界面显示「待领域复核签字」并给出全部阻断项。
 *   2. PDF 解析、自动测试通过、原文对照完成，都**不等于**领域专家审批。
 *   3. 条件不满足时只返回「不适用依据 + 补证清单」，绝不返回减排量数字。
 */
import { all, get, run } from '../core/db.mjs';
import { nowIso, todayCst, j, uj, round } from '../core/util.mjs';
import { FactStore, evaluateRule, summarize, conclude, PASS, FAIL, UNKNOWN } from '../rules/engine.mjs';
import { FACT_FIELDS, FACT_GROUP_ORDER } from '../data/fact-fields.mjs';
import { listMethodologyVersions } from './engine.mjs';
import { getMethodologyModule } from '../methodologies/index.mjs';
import { methodologyGate } from './policy-svc.mjs';
import { requireProjectAccess } from './project-svc.mjs';
import { loadFactorRegistry } from './calc-svc.mjs';
import { canViewInternal } from './project-v2-svc.mjs';

const FACT_BY_KEY = new Map(FACT_FIELDS.map((f) => [f.key, f]));

/* ==================================================================== */
/*  一、放行状态总览                                                     */
/* ==================================================================== */

/**
 * 各方法学的「能否出数」总览。判据与 calc-svc.assertCalculationPreconditions 保持一致：
 * 插件已审批 + 无占位系数 + 条款页码齐全 + 原文对照 official_original_verified +
 * 领域复核人签字 + 无未结清阻断项。
 */
export function readiness() {
  const versions = listMethodologyVersions();
  const items = versions.map((mv) => {
    const mod = getMethodologyModule(mv.methodology_id, mv.version);
    const gate = methodologyGate(mv, mod);
    const verification = get('SELECT * FROM methodology_doc_verification WHERE methodology_version_id = ?', [mv.id]);
    const factors = all(
      'SELECT * FROM factor_version WHERE methodology_version_id = ? OR methodology_version_id = ?',
      [`${mv.methodology_id}::${mv.version}`, '']
    );
    const placeholderFactors = factors.filter((f) => f.value_status === 'placeholder');
    const pendingClauses = (mod?.plugin?.formula_refs || []).filter(
      (f) => !f.clause_ref || f.clause_ref.includes('【占位】') || f.clause_ref.includes('待对照')
    );
    const blockers = [...gate.blockers];
    if (placeholderFactors.length) blockers.push(`${placeholderFactors.length} 项因子为占位/未确认值`);
    if (pendingClauses.length) blockers.push(`${pendingClauses.length} 条公式未回填官方条款页码`);
    const can = blockers.length === 0;
    return {
      methodology_version_id: mv.id,
      methodology_id: mv.methodology_id,
      code_display: mv.code_display,
      name: mv.name,
      version: mv.version,
      document_status: mv.document_status,
      domain: mv.domain,
      evidence_level: gate.evidence_level,
      evidence_label: gate.evidence_label,
      domain_review: gate.domain_review,
      doc_verification_complete: gate.evidence_level === 'official_original_verified',
      plugin_status: mv.calculator_status,
      rulecard_status: mv.rulecard_status,
      official_url: gate.official_url,
      coverage: gate.coverage,
      remaining_blockers: gate.remaining_blockers,
      placeholder_factors: placeholderFactors.map((f) => ({
        key: f.factor_key || f.id, name: f.name, value: f.value_num ?? f.value_text, unit: f.unit,
        source_note: f.source_note, year: f.year || f.applicable_year,
      })),
      pending_clause_count: pendingClauses.length,
      can_calculate: can,
      blockers,
      status_label: can ? '可出数（业务通道）' : '暂不支持自动测算',
      status_reason: can ? null : blockers.join('；'),
      drill: `#/measure?methodology_version_id=${encodeURIComponent(mv.id)}`,
    };
  });
  const formal = items.filter((i) => i.document_status === 'formal');
  return {
    as_of: todayCst(),
    items,
    counts: {
      total: items.length,
      formal: formal.length,
      calculable: items.filter((i) => i.can_calculate).length,
      doc_verified: items.filter((i) => i.doc_verification_complete).length,
      domain_signed: items.filter((i) => i.domain_review).length,
      blocked_by_domain_signature: items.filter(
        (i) => i.doc_verification_complete && !i.domain_review
      ).length,
    },
    policy_gate:
      '业务出数需要同时满足：正式方法学 + 插件已审批 + 无占位系数 + 条款页码齐全 + ' +
      '原文逐条对照完成 + **领域复核人实际签字**。缺少任何一项时本模块只给出不适用依据与补证清单。',
    note:
      '自动测试通过、PDF 解析完成、原文对照完成，都**不构成**领域专家审批；' +
      '本页如实显示签字状态，未签字即不出数。',
  };
}

/* ==================================================================== */
/*  二、新建测算：适用条件预检（不产生任何数值）                          */
/* ==================================================================== */

/** 依据输入构造事实访问器（含一条显式的「本次输入」证据，不冒充原始文件） */
function buildFactStore(inputs, declaredSourceKind) {
  const rows = [];
  const evidenceById = new Map();
  const evidenceId = 'EV-PRECHECK-INPUT';
  evidenceById.set(evidenceId, {
    file_name: '本次预检的输入（用户录入，未附原始文件）',
    doc_type: 'precheck_input',
    page: null,
    line_ref: null,
    excerpt: '由用户在「碳减排测算 → 新建测算」中录入；未上传原始文件，核对时须回到项目材料。',
  });
  for (const [key, value] of Object.entries(inputs || {})) {
    if (value === null || value === undefined || value === '') continue;
    const def = FACT_BY_KEY.get(key);
    if (!def) continue;
    const row = {
      field_key: key,
      value_type: def.value_type,
      value_text: def.value_type === 'number' ? null : String(value),
      value_num: def.value_type === 'number' ? Number(value) : null,
      unit: def.unit || null,
      source_kind: declaredSourceKind,
      evidence_id: evidenceId,
      asserted_at: nowIso(),
    };
    rows.push(row);
  }
  return { store: new FactStore(rows, evidenceById), rowCount: rows.length, evidenceId };
}

/**
 * 适用条件预检：按需求规格的判断顺序执行规则，返回逐条判断与结论。
 * **绝不返回减排量数值**——即使规则全部通过，也只提示「可进入正式测算流程」。
 *
 * @param {object} user
 * @param {{methodology_version_id:string, inputs:object, declared_source_kind?:string,
 *          analysis_base_date?:string}} payload
 */
export function precheckApplicability(user, payload = {}) {
  const mv = listMethodologyVersions().find((m) => m.id === payload.methodology_version_id);
  if (!mv) return { error: '方法学版本不存在', status: 404 };
  const declared = payload.declared_source_kind || 'project_doc';
  const allowedKinds = ['official', 'project_doc', 'owner_claim', 'analyst', 'assumption'];
  if (!allowedKinds.includes(declared)) {
    return { error: `declared_source_kind 取值非法（${allowedKinds.join('/')}）`, status: 400 };
  }
  const baseDate = payload.analysis_base_date && /^\d{4}-\d{2}-\d{2}$/.test(payload.analysis_base_date)
    ? payload.analysis_base_date
    : todayCst();
  const { store } = buildFactStore(payload.inputs || {}, declared);

  const commonRules = all('SELECT * FROM rule WHERE methodology_version_id IS NULL ORDER BY sort_order');
  const specificRules = all('SELECT * FROM rule WHERE methodology_version_id = ? ORDER BY sort_order', [mv.id]);
  const results = [...commonRules, ...specificRules].map((r) => evaluateRule(r, store, { baseDate }));
  const s = summarize(results);
  const conclusion = conclude(s, { hasFormalCandidate: mv.document_status === 'formal' });

  const blockingFails = results.filter((r) => r.state === FAIL && (r.severity === 'blocking' || r.blocking));
  const unknown = results.filter((r) => r.state === UNKNOWN);
  const missingFields = [...new Set(unknown.flatMap((r) => r.missing_fields || []))];

  const mod = getMethodologyModule(mv.methodology_id, mv.version);
  const gate = methodologyGate(mv, mod);

  return {
    methodology: {
      id: mv.id,
      methodology_id: mv.methodology_id,
      code_display: mv.code_display,
      name: mv.name,
      version: mv.version,
      document_status: mv.document_status,
      official_url: mv.official_url,
    },
    analysis_base_date: baseDate,
    declared_source_kind: declared,
    declared_source_label:
      { official: '官方文件', project_doc: '项目资料', owner_claim: '业主自述', analyst: '分析师录入', assumption: '模型假设' }[declared],
    input_count: Object.keys(payload.inputs || {}).length,
    rule_results: results.map((r) => ({
      rule_id: r.rule_id,
      rule_key: r.rule_id,
      title: r.title,
      layer: r.layer,
      severity: r.severity,
      state: r.state,
      state_label: r.state === PASS ? '满足' : r.state === FAIL ? '不满足' : '待核实',
      detail: r.detail,
      condition_text: r.condition_text,
      clause_ref: r.clause_ref,
      evidence_policy: r.evidence_policy,
      fail_conclusion: r.fail_conclusion,
      missing_fields: r.missing_fields || [],
      unknown_reasons: r.unknown_reasons || [],
      fact_field: r.fact_field,
      fact_value: r.fact_value,
      evidence: r.evidence,
    })),
    summary: {
      pass: s.pass,
      fail: s.fail,
      unknown: s.unknown,
      blocking_failures: s.blocking_failures,
      conclusion,
    },
    not_applicable_basis: blockingFails.map((r) => ({
      rule_id: r.rule_id,
      title: r.title,
      clause_ref: r.clause_ref,
      // 优先给出方法学原文的「不适用结论」措辞，其次是引擎判定细节
      detail: r.fail_conclusion || r.detail,
      condition_text: r.condition_text,
      technical_detail: r.detail,
    })),
    evidence_gap_list: missingFields.map((f) => ({
      field_key: f,
      label: FACT_BY_KEY.get(f)?.label || f,
      group: FACT_BY_KEY.get(f)?.group_name || null,
      description: FACT_BY_KEY.get(f)?.description || null,
      evidence_policy: FACT_BY_KEY.get(f)?.evidence_policy || null,
    })),
    calculation_gate: {
      ...gate,
      can_return_numbers: false,
      reason:
        gate.can_calculate
          ? '规则层面满足，且方法学已具备出数条件；请在「从项目档案测算」中执行正式测算（结果绑定条件检查快照）。'
          : '本次仅完成适用条件预检。业务出数还缺少：' + (gate.blockers.join('；') || '—'),
    },
    persisted: false,
    disclaimer:
      '本结果为**初筛预检**，不产生任何减排量数值，也未落库；' +
      '「不满足」项须回到官方条款与项目材料核对；「待核实」项须补齐证据后才能判断。' +
      (declared === 'assumption'
        ? '当前输入声明为「模型假设」，按规则不参与硬性条件判定，只能用于情景演示。'
        : ''),
  };
}

/** 表单字段清单（按分组，供「新建测算」动态表单使用） */
export function precheckFormFields(methodologyVersionId = null) {
  const allFields = FACT_FIELDS.map((f) => ({
    key: f.key,
    label: f.label,
    group: f.group_name,
    value_type: f.value_type,
    unit: f.unit || null,
    enum_values: f.enum_values || null,
    description: f.description || null,
    evidence_policy: f.evidence_policy || null,
  }));
  let required = [];
  if (methodologyVersionId) {
    const rules = [
      ...all('SELECT * FROM rule WHERE methodology_version_id IS NULL'),
      ...all('SELECT * FROM rule WHERE methodology_version_id = ?', [methodologyVersionId]),
    ];
    required = [...new Set(rules.flatMap((r) => uj(r.required_fields, []) || []))];
  }
  return {
    groups: FACT_GROUP_ORDER,
    fields: allFields,
    required_for_methodology: required,
    note: '每个字段显示单位、定义、数据期与公式用途；证据要求见 evidence_policy。',
  };
}

/** 相似项目的事实模板（从公开项目带出，用户须自行确认，不得直接当作事实） */
export function prefillFromPublicProject(publicProjectId) {
  const p = get('SELECT * FROM public_project WHERE id = ?', [publicProjectId]);
  if (!p) return { error: '公开项目不存在', status: 404 };
  const inputs = {};
  const suggestions = [];
  const put = (key, value, label) => {
    if (value === null || value === undefined || value === '') return;
    inputs[key] = value;
    suggestions.push({ field_key: key, label, value, source: '公开项目库（待核实）' });
  };
  put('proj.name', p.name, '项目名称');
  put('proj.owner', p.owner_name, '项目业主');
  put('proj.province', p.province, '省份');
  put('proj.city', p.city, '地市');
  put('proj.industry', p.industry, '行业');
  put('proj.technology_route', p.technology_route, '技术路线');
  put('proj.boundary_desc', p.boundary_desc, '项目边界');
  return {
    public_project: { id: p.id, name: p.name, evidence_level: p.evidence_level, official_url: p.official_url },
    suggested_inputs: inputs,
    suggestions,
    note:
      '以上字段来自公开项目库，证据等级为「待核实」，**不能**直接作为条件判定的事实；' +
      '请核对官方页面与项目材料后再填入。',
  };
}

/* ==================================================================== */
/*  三、从项目档案测算                                                   */
/* ==================================================================== */

/** 可测算的内部项目清单（含档案与门禁状态） */
export function measurementTargets(user) {
  const rows = all('SELECT * FROM internal_project ORDER BY updated_at DESC');
  const visible = rows.filter((r) => canViewInternal(user, r));
  const out = visible.map((r) => {
    const dossier = r.dossier_project_id
      ? get('SELECT id, code, name FROM project WHERE id = ?', [r.dossier_project_id])
      : null;
    const runs = r.dossier_project_id
      ? all('SELECT COUNT(*) AS c FROM calculation_run WHERE project_id = ?', [r.dossier_project_id])?.c ?? 0
      : 0;
    return {
      internal_project_id: r.id,
      code: r.code,
      name: r.name,
      methodology_id: r.methodology_id,
      team_id: r.team_id,
      review_status: r.review_status,
      confidentiality: r.confidentiality,
      dossier,
      has_dossier: !!dossier,
      calculation_runs: runs,
      can_measure: !!dossier,
      reason: dossier ? null : '该内部项目尚未建立项目档案（事实/证据/测算运行），请先在项目档案中登记后测算',
    };
  });
  return {
    rows: out,
    counts: { total: out.length, with_dossier: out.filter((r) => r.has_dossier).length },
    note:
      '「从项目档案测算」只对已建立档案的项目开放；测算运行仍受方法学门禁与条件检查约束。',
  };
}

export function listRuns(user, filters = {}) {
  const where = [];
  const params = [];
  if (filters.project_id) {
    const access = requireProjectAccess(user, filters.project_id);
    if (access.error) return access;
    where.push('r.project_id = ?');
    params.push(filters.project_id);
  }
  if (filters.status) {
    where.push('r.status = ?');
    params.push(filters.status);
  }
  const rows = all(
    `SELECT r.*, p.name AS project_name, p.code AS project_code, mv.code_display, mv.methodology_id, mv.version
     FROM calculation_run r
     LEFT JOIN project p ON p.id = r.project_id
     LEFT JOIN methodology_version mv ON mv.id = r.methodology_version_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY r.run_at DESC LIMIT ?`,
    [...params, Math.min(Number(filters.limit) || 100, 500)]
  );
  // 权限过滤：只保留当前用户可访问的项目
  const visible = rows.filter((r) => {
    const access = requireProjectAccess(user, r.project_id);
    return !access.error;
  });
  return {
    runs: visible.map((r) => ({
      id: r.id,
      project_id: r.project_id,
      project_name: r.project_name,
      project_code: r.project_code,
      methodology: r.code_display || r.methodology_id,
      version: r.version,
      run_at: r.run_at,
      status: r.status,
      conclusion: r.conclusion,
      operator: r.operator,
    })),
    total: visible.length,
    note: '历史运行按方法学、因子与输入快照留存；导出可复算 Excel 见「运行详情」。',
  };
}

export function factorRegistry(methodologyId = null) {
  const reg = loadFactorRegistry(methodologyId);
  const factors = all('SELECT * FROM factor_version ORDER BY methodology_version_id, factor_key');
  return {
    factors: factors.map((f) => ({
      key: f.factor_key,
      name: f.name,
      value: f.value_num !== null && f.value_num !== undefined ? f.value_num : f.value_text,
      unit: f.unit,
      year: f.year || f.applicable_year || null,
      source: f.source_note || f.source || null,
      source_url: f.source_url || null,
      value_status: f.value_status,
      placeholder: f.value_status === 'placeholder',
      methodology_version_id: f.methodology_version_id,
    })),
    registry_note: reg?.note || null,
    placeholder_count: factors.filter((f) => f.value_status === 'placeholder').length,
    note:
      '因子来源与适用年份逐条展示；占位/未确认因子会阻断业务出数。' +
      '新年度因子发布后须由领域复核人确认再启用。',
  };
}

export { round };
