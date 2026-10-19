/**
 * 计算服务：按方法学编号与版本注册的插件执行减排量初算
 * ============================================================================
 * 纪律（设计文档第 7 节）：
 *   - 数值由确定性插件计算，通用大模型不参与生成最终数字
 *   - 缺失关键监测数据禁止猜值；允许明确标注为「假设」的情景输入，
 *     但输出只称「情景估算」，不得称「预计可签发量」
 *   - 输出绑定「分析基准日 + 方法学版本 + 因子版本」
 *   - 每个运行保留完整快照，历史结果不因库更新被静默改写
 *   - 关键计量值单位错误 / 期间重叠 / 超出合理范围 → 阻止出数
 */
import { all, get, run, audit, getMeta } from '../core/db.mjs';
import { newId, nowIso, j, uj, toIsoDate, round } from '../core/util.mjs';
import { getMethodologyModule, listMethodologyModules } from '../methodologies/index.mjs';
import { FactorRegistry } from '../methodologies/lib/calc-kit.mjs';
import { detectPeriodOverlap } from '../methodologies/lib/calc-kit.mjs';
import { loadFactData, requireProjectAccess } from './project-svc.mjs';
import { runMatch } from './engine.mjs';
import { loadVerificationState, methodologyFactorPrefix } from './verification.mjs';

// 供其它模块沿用（定义在 verification.mjs，避免与 engine 形成循环依赖）
export { loadVerificationState, methodologyFactorPrefix };

export const SCENARIO_LABELS = { conservative: '保守情景', base: '基准情景', optimistic: '乐观情景' };

/* ========================================================================== */
/*  确认状态：一律以数据库为准，不读插件模块里的静态声明                        */
/* ========================================================================== */


export function loadFactorRegistry(methodologyId) {
  const rows = all('SELECT * FROM factor_version');
  void methodologyId;
  return new FactorRegistry(rows);
}

/** 从项目事实中取值（按字段类型转换） */
function readFactValue(factRowsByKey, factKey) {
  const f = factRowsByKey.get(factKey);
  if (!f) return null;
  if (f.value_type === 'number') return f.value_num;
  if (f.value_type === 'bool') return f.value_text === 'true';
  return f.value_text === '' ? null : f.value_text;
}

/**
 * 解析插件输入：事实 → 用户情景输入 → 因子缺省值 → 参数缺省值
 * 返回值同时记录每个输入项的来源，便于报告标注「官方已确认 / 项目资料记载 / 模型假设」。
 */
export function resolveInputs(plugin, factRows, overrides = {}) {
  const byKey = new Map(factRows.map((f) => [f.field_key, f]));
  const factors = loadFactorRegistry(plugin.methodology_id);
  const resolved = {};
  const origins = [];

  for (const p of plugin.parameters) {
    let value = null;
    let origin = null;

    // 1) 用户情景输入优先——但一律标注为「模型假设」，绝不冒充官方或项目资料证据
    if (overrides[p.key] !== undefined && overrides[p.key] !== null && overrides[p.key] !== '') {
      value = overrides[p.key];
      const base = p.source === 'fact' ? readFactValue(byKey, p.fact_key) : null;
      origin = {
        kind: 'assumption',
        label: '模型假设',
        note: base === null || base === undefined
          ? '由用户在情景输入中提供'
          : `覆盖项目事实值 ${base}（原始来源：${byKey.get(p.fact_key)?.source_kind || '未知'}）`,
        fact_key: p.fact_key || null,
        overrode_fact_value: base,
      };
    }

    // 2) 项目事实
    if (value === null && p.source === 'fact') {
      const f = byKey.get(p.fact_key);
      value = readFactValue(byKey, p.fact_key);
      if (value !== null && value !== undefined) {
        origin = {
          kind: f?.source_kind || 'unknown',
          label: {
            official: '官方已确认', project_doc: '项目资料记载',
            owner_claim: '业主自述', analyst: '分析师录入', assumption: '模型假设',
          }[f?.source_kind] || '未知来源',
          evidence_id: f?.evidence_id || null,
          fact_key: p.fact_key,
        };
      }
    }

    // 3) 方法学缺省因子
    if ((value === null || value === undefined) && p.factor_fallback) {
      const fv = factors.value(p.factor_fallback, `${plugin.methodology_id}::${plugin.methodology_version}`);
      if (fv !== null && fv !== undefined) {
        value = fv;
        origin = {
          kind: 'factor_default',
          label: '方法学缺省值（占位待确认）',
          factor_key: p.factor_fallback,
        };
      }
    }
    // 4) 插件缺省值
    if ((value === null || value === undefined) && p.default !== undefined) {
      value = p.default;
      origin = { kind: 'plugin_default', label: '插件缺省值', note: '须由领域专家确认' };
    }

    resolved[p.key] = value;
    origins.push({
      key: p.key,
      label: p.label,
      unit: p.unit || null,
      required: !!p.required,
      value,
      origin,
      fact_key: p.fact_key || null,
    });
  }

  return { inputs: resolved, origins, factors };
}

/**
 * 校验业务测算的全部前置条件。
 * ============================================================================
 * 设计文档与首轮检查整改清单共同要求：
 *   - 未完成公式校验的方法学一律不得出数（默认严格模式）
 *   - 有占位系数、缺原文页码、缺独立复算样例时，所有模式下均不可生成业务测算
 *   - 业务初算必须绑定同一项目、同一方法学版本、同一分析基准日的条件检查快照
 *   - 存在 blocking fail 时禁止形成可用于筛选报告的数字
 *   - 演示出数与业务库、业务页面、报告导出严格隔离
 *
 * @returns {{ok:boolean, channel:string, reason?:string, detail?:object, demo?:boolean}}
 */
export function assertCalculationPreconditions(user, project, mvRow, plugin, opts = {}) {
  const channel = opts.channel === 'demo' ? 'demo' : 'business';
  const gateMode = getMeta(null, 'calculator_gate_mode') || 'strict';
  const demoEnabled = (getMeta(null, 'demo_channel_enabled') || 'false') === 'true';
  // 以数据库为准（见 loadVerificationState 的说明）
  const { placeholders, pendingClauses } = loadVerificationState(mvRow.methodology_id, mvRow.version);

  /* ---------------- 演示通道 ---------------- */
  if (channel === 'demo') {
    if (!demoEnabled) {
      return {
        ok: false,
        channel,
        reason:
          '演示通道未开启。依据设计文档第 11 节与首轮检查整改要求，' +
          '未通过领域专家审核的方法学不得出数；如需流程演示，须由管理员在管理后台显式开启演示通道。',
        detail: { demo_channel_enabled: false },
      };
    }
    if (!['admin', 'researcher'].includes(user.role)) {
      return { ok: false, channel, reason: '演示通道仅对系统管理员与政策研究员开放。' };
    }
    return {
      ok: true,
      channel,
      demo: true,
      reason:
        `演示通道：本结果为「反事实演示」，仅用于流程演示与内部讨论。` +
        `含 ${placeholders.length} 项未经领域专家确认的占位系数；` +
        `不进入投资筛选报告，不可导出，不得用于任何对外材料或投资决策。`,
      placeholders,
    };
  }

  /* ---------------- 业务通道 ---------------- */
  if (mvRow.calculator_status !== 'approved') {
    return {
      ok: false,
      channel,
      reason:
        `该方法学计算插件的审批状态为「${mvRow.calculator_status}」，尚未通过领域专家校验，` +
        '界面提示「暂不支持自动测算」。业务测算要求在管理后台完成审批并记录审批人与时间后方可执行。',
      detail: { calculator_status: mvRow.calculator_status },
    };
  }

  if (placeholders.length) {
    const names = placeholders.map((p) => `${p.name}（${p.factor_key}）`).join('、');
    return {
      ok: false,
      channel,
      reason:
        `该插件仍含 ${placeholders.length} 项未经领域专家确认的占位系数，业务测算被阻止：${names}。` +
        '请先在管理后台逐项确认并改为 verified，或改用演示通道做流程演示。',
      detail: { placeholder_factors: placeholders.map((p) => p.factor_key) },
    };
  }

  // 公式条款页码必须已回填（不得再是【占位】）
  const pendingClause = (plugin.formula_refs || []).filter(
    (f) => !f.clause_ref || f.clause_ref.includes('【占位】') || f.clause_ref.includes('待对照')
  );
  if (pendingClause.length) {
    return {
      ok: false,
      channel,
      reason:
        `该插件有 ${pendingClause.length} 条公式尚未回填方法学原文条款页码，无法满足可追溯要求，业务测算被阻止。`,
      detail: { formulas: pendingClause.map((f) => f.formula_id) },
    };
  }

  // 必须绑定条件检查快照
  const elig = opts.eligibilityRunId
    ? get('SELECT * FROM eligibility_run WHERE id = ?', [opts.eligibilityRunId])
    : latestEligibilityFor(project.id, mvRow.id, opts.analysisBaseDate);

  if (!elig) {
    return {
      ok: false,
      channel,
      reason:
        '业务测算必须绑定同一项目、同一方法学版本、同一分析基准日的申报条件检查结果。' +
        '本项目尚无匹配的条件检查快照，请先运行「申报条件检查」。',
      detail: { need: 'eligibility_run' },
    };
  }
  const snap = {
    eligibility_run_id: elig.id,
    project_id: elig.project_id,
    methodology_version_id: elig.methodology_version_id,
    analysis_base_date: elig.analysis_base_date,
    conclusion: elig.conclusion,
    blocking_failures: elig.blocking_failures,
  };
  if (elig.project_id !== project.id) {
    return { ok: false, channel, reason: '所绑定的条件检查快照属于其他项目。', detail: snap };
  }
  if (elig.methodology_version_id !== mvRow.id) {
    return {
      ok: false,
      channel,
      reason: '所绑定的条件检查快照使用的是**其他方法学版本**，测算与判断必须同源。',
      detail: snap,
    };
  }
  if (opts.analysisBaseDate && elig.analysis_base_date !== toIsoDate(opts.analysisBaseDate)) {
    return {
      ok: false,
      channel,
      reason:
        `所绑定的条件检查快照分析基准日为 ${elig.analysis_base_date}，与本次测算基准日 ` +
        `${toIsoDate(opts.analysisBaseDate)} 不一致。`,
      detail: snap,
    };
  }
  if (elig.blocking_failures > 0) {
    return {
      ok: false,
      channel,
      reason:
        `条件检查存在 ${elig.blocking_failures} 项硬障碍（结论：${elig.conclusion}），` +
        '存在明确障碍的项目禁止形成可用于筛选报告的减排量数字。',
      detail: snap,
    };
  }

  return {
    ok: true,
    channel,
    demo: false,
    eligibility_snapshot: snap,
    eligibilityRun: elig,
    gate_mode: gateMode,
  };
}

function latestEligibilityFor(projectId, methodologyVersionId, analysisBaseDate) {
  const rows = all(
    `SELECT * FROM eligibility_run
     WHERE project_id = ? AND methodology_version_id = ?
     ORDER BY run_at DESC LIMIT 20`,
    [projectId, methodologyVersionId]
  );
  if (!rows.length) return null;
  if (!analysisBaseDate) return rows[0];
  const target = toIsoDate(analysisBaseDate);
  return rows.find((r) => r.analysis_base_date === target) || null;
}

function gateCheck(plugin) {
  const mode = getMeta(null, 'calculator_gate_mode') || 'strict';
  // 以数据库为准（见 loadVerificationState 的说明）
  const { placeholders, pendingClauses } = loadVerificationState(mvRow.methodology_id, mvRow.version);
  if (mode === 'strict' && placeholders.length) {
    return {
      blocked: true,
      reason:
        `严格模式：该计算插件含 ${placeholders.length} 项未经领域专家确认的占位系数，` +
        `界面提示「暂不支持自动测算」。占位系数：${placeholders.map((f) => f.name).join('、')}`,
    };
  }
  return { blocked: false, placeholders };
}

/**
 * 执行一次计算运行。
 * @param {object} user
 * @param {string} projectId
 * @param {{methodologyVersionId?:string, scenario?:string, allScenarios?:boolean,
 *          analysisBaseDate?:string, overrides?:object, extraPeriods?:Array}} opts
 */
export function runCalculation(user, projectId, opts = {}) {
  const access = requireProjectAccess(user, projectId, { needManage: true });
  if (access.error) return access;
  const project = access.project;

  const analysisBaseDate = toIsoDate(opts.analysisBaseDate);
  const scenario = opts.scenario || 'base';

  // 定位方法学版本：显式指定 → 项目类型匹配出的最高分候选 → 报错
  let mvRow = null;
  if (opts.methodologyVersionId) {
    mvRow = get('SELECT * FROM methodology_version WHERE id = ?', [opts.methodologyVersionId]);
  } else if (opts.methodologyId) {
    mvRow = get(
      `SELECT * FROM methodology_version WHERE methodology_id = ? AND document_status = 'formal'
       ORDER BY effective_date DESC LIMIT 1`,
      [opts.methodologyId]
    );
  } else {
    // 未显式指定版本：用「候选方法学匹配」的最高分候选，保证与条件检查使用同一版本
    const matched = runMatch(user, projectId, { analysisBaseDate });
    const top = matched.candidates?.[0];
    if (top) mvRow = get('SELECT * FROM methodology_version WHERE id = ?', [top.methodology_version_id]);
  }
  if (!mvRow) {
    return {
      error: '未找到可用于本项目的方法学版本：请先在「候选方法学匹配」中确认候选，或显式指定方法学版本 ID。',
      status: 404,
    };
  }

  if (mvRow.document_status !== 'formal') {
    return {
      error: `所选版本为「${mvRow.document_status === 'revised_draft' ? '修订征求意见稿' : '草案'}」，计算必须绑定现行正式版本。`,
      status: 409,
    };
  }

  const mod = getMethodologyModule(mvRow.methodology_id, mvRow.version);
  if (!mod || !mod.plugin) {
    return { error: '该方法学尚未注册计算插件，界面提示「暂不支持自动测算」。', status: 409 };
  }

  // 统一前置校验：审批状态、占位系数、条款页码、条件检查快照绑定、演示通道隔离
  const gate = assertCalculationPreconditions(user, project, mvRow, mod.plugin, {
    channel: opts.channel,
    eligibilityRunId: opts.eligibilityRunId,
    analysisBaseDate,
  });
  if (!gate.ok) {
    audit({
      actor: user.name, actorRole: user.role, action: 'calculation.blocked',
      objectType: 'project', objectId: projectId,
      detail: { methodology: mvRow.code_display, channel: gate.channel, reason: gate.reason },
      result: 'denied',
    });
    return {
      project_id: projectId,
      methodology_version_id: mvRow.id,
      status: 409,
      rejected: true,
      kind: 'precondition',
      channel: gate.channel,
      errors: [{ field: '__precondition__', kind: 'gate_blocked', message: gate.reason }],
      detail: gate.detail || null,
      message: gate.reason,
    };
  }
  // 'ok' 表示可用于投资筛选报告的正式业务测算；'demo' 表示隔离的反事实演示
  const runStatus = gate.demo ? 'demo' : 'ok';

  const { facts } = loadFactData(projectId);
  const { inputs, origins, factors } = resolveInputs(mod.plugin, facts, opts.overrides || {});

  // 期间重叠校验（设计文档第 10 节验收用例 5）
  if (Array.isArray(opts.extraPeriods) && opts.extraPeriods.length) {
    const overlaps = detectPeriodOverlap(opts.extraPeriods);
    if (overlaps.length) {
      return persistRejected(user, projectId, mvRow, mod.plugin, scenario, analysisBaseDate, inputs, origins, factors, overlaps, gate);
    }
  }

  const { errors, warnings } = mod.plugin.validate(inputs, { baseDate: analysisBaseDate });

  if (errors.length) {
    return persistRejected(user, projectId, mvRow, mod.plugin, scenario, analysisBaseDate, inputs, origins, factors, errors, gate, warnings);
  }

  const scenarios = opts.allScenarios ? ['conservative', 'base', 'optimistic'] : [scenario];
  const runs = [];

  for (const sc of scenarios) {
    const scenarioDef = mod.plugin.scenarios[sc];
    const out = mod.plugin.compute(inputs, {
      factors,
      scenario: sc,
      scenarioLabel: SCENARIO_LABELS[sc],
      scenarioMultipliers: scenarioDef.multipliers,
      baseDate: analysisBaseDate,
      project,
    });

    const resultPayload = {
      ...out,
      scenario: sc,
      scenario_label: SCENARIO_LABELS[sc],
      scenario_note: scenarioDef.note,
      scenario_multipliers: scenarioDef.multipliers,
      methodology: {
        methodology_id: mvRow.methodology_id,
        code_display: mvRow.code_display,
        name: mvRow.name,
        version: mvRow.version,
        official_url: mvRow.official_url,
        effective_date: mvRow.effective_date,
      },
      analysis_base_date: analysisBaseDate,
      inputs,
      input_origins: origins,
      warnings: [...warnings, ...(out.warnings || [])],
      // ---- 通道与隔离标记 ----
      channel: gate.channel,
      demo: !!gate.demo,
      gate_reason: gate.reason,
      eligibility_snapshot: gate.eligibility_snapshot || null,
      usable_for_report: !gate.demo,
      watermark: gate.demo
        ? '【演示通道 · 反事实推演】本结果不得用于投资筛选报告、对外材料或投资决策'
        : null,
      gate_mode: getMeta(null, 'calculator_gate_mode') || 'demo',
      placeholder_factors: factors.placeholders().map((p) => ({
        factor_key: p.factor_key, name: p.name, value: p.value, unit: p.unit,
        verification_note: p.verification_note,
      })),
      disclaimer:
        '本结果为「情景估算」，使用明确标注的假设输入。不得称为预计减排量、预计可签发量或可交易量。',
      unit_note: '全部为 tCO₂e；未与碳价相乘，碳收益须在投资筛选环节另行列出。',
    };

    const id = newId('CAL');
    run(
      `INSERT INTO calculation_run
       (id,project_id,methodology_version_id,plugin_key,plugin_version,scenario,analysis_base_date,
        run_at,operator,status,rejection_reason,inputs_json,result_json,factor_snapshot_json,
        audit_status,review_status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id, projectId, mvRow.id, mod.plugin.plugin_key, mod.plugin.plugin_version, sc,
        analysisBaseDate, nowIso(), user.name, runStatus, null,
        j({
          inputs, origins, overrides: opts.overrides || {},
          channel: gate.channel, eligibility_run_id: gate.eligibility_snapshot?.eligibility_run_id || null,
        }),
        j(resultPayload), j(factors.snapshot()), 'pending', 'pending',
      ]
    );

    audit({
      actor: user.name, actorRole: user.role, action: 'calculation.run',
      objectType: 'calculation_run', objectId: id,
      detail: {
        projectId, methodology: mvRow.code_display, scenario: sc,
        er_annual: resultPayload.er_annual,
        placeholder_factors: resultPayload.placeholder_factors.length,
      },
    });

    runs.push({
      calculation_run_id: id,
      scenario: sc,
      scenario_label: SCENARIO_LABELS[sc],
      status: runStatus,
      channel: gate.channel,
      demo: !!gate.demo,
      usable_for_report: !gate.demo,
      er_annual: resultPayload.er_annual,
      crediting: resultPayload.crediting,
      steps: resultPayload.steps,
      assumptions: resultPayload.assumptions,
      missing: resultPayload.missing,
      sensitivity: resultPayload.sensitivity,
      warnings: resultPayload.warnings,
      placeholder_factors: resultPayload.placeholder_factors,
      result: resultPayload,
    });
  }

  return {
    project_id: projectId,
    methodology_version_id: mvRow.id,
    analysis_base_date: analysisBaseDate,
    channel: gate.channel,
    demo: !!gate.demo,
    usable_for_report: !gate.demo,
    gate_reason: gate.reason,
    eligibility_snapshot: gate.eligibility_snapshot || null,
    status: 200,
    plugin: {
      plugin_key: mod.plugin.plugin_key,
      plugin_version: mod.plugin.plugin_version,
      title: mod.plugin.title,
      status_note: mod.plugin.status_note,
      formula_refs: mod.plugin.formula_refs,
    },
    inputs,
    input_origins: origins,
    factor_snapshot: factors.snapshot(),
    runs,
    warnings,
    status: 200,
  };
}

function persistRejected(user, projectId, mvRow, plugin, scenario, analysisBaseDate, inputs, origins, factors, errors, gate, warnings = []) {
  const id = newId('CAL');
  const payload = {
    status: 'rejected',
    errors,
    warnings,
    inputs,
    input_origins: origins,
    gate,
    methodology: {
      methodology_id: mvRow.methodology_id, code_display: mvRow.code_display,
      name: mvRow.name, version: mvRow.version,
    },
    analysis_base_date: analysisBaseDate,
    message: '输入校验未通过，系统拒绝出数（不提供任何减排量数值）。',
  };
  run(
    `INSERT INTO calculation_run
     (id,project_id,methodology_version_id,plugin_key,plugin_version,scenario,analysis_base_date,
      run_at,operator,status,rejection_reason,inputs_json,result_json,factor_snapshot_json,
      audit_status,review_status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id, projectId, mvRow.id, plugin.plugin_key, plugin.plugin_version, scenario,
      analysisBaseDate, nowIso(), user.name, 'rejected',
      errors.map((e) => e.message).join('；'),
      j({ inputs, origins }), j(payload), j(factors.snapshot()), 'rejected', 'rejected',
    ]
  );
  audit({
    actor: user.name, actorRole: user.role, action: 'calculation.rejected',
    objectType: 'calculation_run', objectId: id,
    detail: { projectId, errors: errors.map((e) => e.message) }, result: 'rejected',
  });
  return {
    project_id: projectId,
    methodology_version_id: mvRow.id,
    status: 422,
    rejected: true,
    calculation_run_id: id,
    errors,
    warnings,
    gate,
    message: '输入校验未通过，系统拒绝出数（不提供任何减排量数值）。',
  };
}

/* --------------------------- 运行历史与差异对比 --------------------------- */

export function getCalculationRun(id) {
  const row = get('SELECT * FROM calculation_run WHERE id = ?', [id]);
  if (!row) return null;
  return {
    ...row,
    inputs: uj(row.inputs_json, {}),
    result: uj(row.result_json, {}),
    factor_snapshot: uj(row.factor_snapshot_json, []),
  };
}

export function listCalculationRuns(projectId) {  return all(
    `SELECT c.id, c.scenario, c.run_at, c.operator, c.status, c.audit_status, c.plugin_key,
            c.plugin_version, c.analysis_base_date, c.rejection_reason, c.result_json,
            m.code_display, m.name AS methodology_name, m.version AS methodology_version
     FROM calculation_run c LEFT JOIN methodology_version m ON m.id = c.methodology_version_id
     WHERE c.project_id = ? ORDER BY c.run_at DESC`,
    [projectId]
  ).map((r) => {
    const result = uj(r.result_json, {});
    return {
      ...r,
      result_json: undefined,
      er_annual: result.er_annual ?? null,
      crediting_total: result.crediting?.total ?? null,
      demo: !!result.demo,
      channel: result.channel || 'business',
      usable_for_report: r.status === 'ok' && result.demo !== true,
    };
  });
}

/**
 * 两次运行差异对比（设计文档第 10 节验收用例 4）：
 * 新旧结果并存，差异可解释。
 */
export function compareRuns(idA, idB) {
  const a = getCalculationRun(idA);
  const b = getCalculationRun(idB);
  if (!a || !b) return { error: '运行记录不存在', status: 404 };
  if (a.project_id !== b.project_id) {
    return { error: '两次计算运行不属于同一项目，无法对比', status: 400 };
  }

  const inputDiff = [];
  const keys = new Set([...Object.keys(a.inputs?.inputs || {}), ...Object.keys(b.inputs?.inputs || {})]);
  for (const k of keys) {
    const va = a.inputs?.inputs?.[k];
    const vb = b.inputs?.inputs?.[k];
    if (JSON.stringify(va) !== JSON.stringify(vb)) {
      inputDiff.push({ key: k, run_a: va, run_b: vb });
    }
  }

  const factorMapA = new Map((a.factor_snapshot || []).map((f) => [f.factor_key, f]));
  const factorMapB = new Map((b.factor_snapshot || []).map((f) => [f.factor_key, f]));
  const factorDiff = [];
  for (const k of new Set([...factorMapA.keys(), ...factorMapB.keys()])) {
    const fa = factorMapA.get(k);
    const fb = factorMapB.get(k);
    if (!fa || !fb || fa.value !== fb.value || fa.value_status !== fb.value_status) {
      factorDiff.push({
        factor_key: k,
        name: fa?.name || fb?.name,
        run_a: fa ? { value: fa.value, unit: fa.unit, status: fa.value_status, source: fa.source_ref } : null,
        run_b: fb ? { value: fb.value, unit: fb.unit, status: fb.value_status, source: fb.source_ref } : null,
      });
    }
  }

  const erA = a.result?.er_annual ?? null;
  const erB = b.result?.er_annual ?? null;
  const delta = erA !== null && erB !== null ? round(erB - erA, 4) : null;

  return {
    run_a: {
      id: a.id, scenario: a.scenario, analysis_base_date: a.analysis_base_date, run_at: a.run_at,
      methodology: a.result?.methodology, er_annual: erA,
    },
    run_b: {
      id: b.id, scenario: b.scenario, analysis_base_date: b.analysis_base_date, run_at: b.run_at,
      methodology: b.result?.methodology, er_annual: erB,
    },
    delta_er_annual: delta,
    delta_pct: erA ? round(((erB - erA) / Math.abs(erA)) * 100, 4) : null,
    input_diff: inputDiff,
    factor_diff: factorDiff,
    explanation: buildDiffExplanation({ a, b, inputDiff, factorDiff, delta }),
    note: '历史运行结果与其因子快照被完整保留，库更新不会静默改写历史报告。',
  };
}

function buildDiffExplanation({ a, b, inputDiff, factorDiff, delta }) {
  const reasons = [];
  if (a.result?.methodology?.code_display !== b.result?.methodology?.code_display ||
      a.result?.methodology?.version !== b.result?.methodology?.version) {
    reasons.push(
      `方法学版本变化：${a.result?.methodology?.code_display} → ${b.result?.methodology?.code_display}`
    );
  }
  if (a.analysis_base_date !== b.analysis_base_date) {
    reasons.push(`分析基准日变化：${a.analysis_base_date} → ${b.analysis_base_date}`);
  }
  if (a.scenario !== b.scenario) reasons.push(`情景变化：${a.scenario} → ${b.scenario}`);
  for (const d of inputDiff) reasons.push(`输入参数变化：${d.key} ${d.run_a} → ${d.run_b}`);
  for (const d of factorDiff) {
    reasons.push(
      `因子变化：${d.name || d.factor_key} ${d.run_a?.value ?? '（无）'} → ${d.run_b?.value ?? '（无）'}`
    );
  }
  if (!reasons.length) reasons.push('输入、方法学版本与因子版本均一致，结果差异应来自运行时间不同；请核对数据修订记录。');
  return { reasons, delta_er_annual: delta };
}

export function methodologyPluginStatus() {
  const gateMode = getMeta(null, 'calculator_gate_mode') || 'strict';
  const demoEnabled = (getMeta(null, 'demo_channel_enabled') || 'false') === 'true';
  const rows = all('SELECT methodology_id, version, calculator_status, rulecard_status FROM methodology_version');
  const statusOf = new Map(rows.map((r) => [`${r.methodology_id}::${r.version}`, r]));
  return listMethodologyModules().map((m) => {
    const { placeholders, pendingClauses, verifiedCount } = loadVerificationState(m.meta.methodology_id, m.meta.version);
    const pendingClause = (m.plugin.formula_refs || []).filter(
      (f) => !f.clause_ref || f.clause_ref.includes('【占位】') || f.clause_ref.includes('待对照')
    );
    const row = statusOf.get(`${m.meta.methodology_id}::${m.meta.version}`);
    const businessBlocked =
      row?.calculator_status !== 'approved' || placeholders.length > 0 || pendingClause.length > 0;
    return {
      methodology_id: m.meta.methodology_id,
      version: m.meta.version,
      display_name: m.meta.display_name,
      plugin_key: m.plugin.plugin_key,
      plugin_version: m.plugin.plugin_version,
      formula_count: m.plugin.formula_refs.length,
      calculator_status: row?.calculator_status || 'none',
      rulecard_status: row?.rulecard_status || 'none',
      placeholder_factors: placeholders.map((p) => ({
        factor_key: p.factor_key, name: p.name, value: p.value, unit: p.unit, note: p.verification_note,
      })),
      verified_factors_count: verifiedCount,
      formulas_without_clause: pendingClause.map((f) => f.formula_id),
      business_calculation: businessBlocked ? '禁止出数（未通过审批 / 含占位系数 / 缺条款页码）' : '可出数',
      demo_channel: demoEnabled ? '可用（隔离的反事实演示）' : '未开启',
      gate_mode: gateMode,
      status_note: m.plugin.status_note,
    };
  });
}

/** 开启 / 关闭演示通道。开启后仍不产生可用于报告的数字。 */
export function setDemoChannel(enabled, user, note) {
  if (user.role !== 'admin') return { error: '仅系统管理员可变更演示通道', status: 403 };
  run(
    `INSERT INTO system_meta (key,value,updated_at) VALUES ('demo_channel_enabled',?,?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    [enabled ? 'true' : 'false', nowIso()]
  );
  run(
    `INSERT INTO system_meta (key,value,updated_at) VALUES ('demo_channel_enabled_by',?,?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    [enabled ? user.name : '', nowIso()]
  );
  run(
    `INSERT INTO system_meta (key,value,updated_at) VALUES ('demo_channel_enabled_at',?,?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    [enabled ? nowIso() : '', nowIso()]
  );
  audit({
    actor: user.name, actorRole: user.role, action: 'admin.set_demo_channel',
    detail: { enabled, note: note || null },
  });
  return {
    ok: true,
    demo_channel_enabled: !!enabled,
    message: enabled
      ? '演示通道已开启。该通道的结果标记为 demo，不进入报告、不可导出，仅供流程演示与内部讨论。'
      : '演示通道已关闭。',
  };
}

/** 审批流转：把规则卡或计算插件从 pending_review 流转为 approved（须记录审批人）。 */
export function approveMethodology(user, methodologyVersionId, { target, decision, comment }) {
  if (!['admin', 'reviewer'].includes(user.role)) {
    return { error: '仅领域复核人或系统管理员可执行审批', status: 403 };
  }
  if (!['rulecard', 'calculator'].includes(target)) {
    return { error: 'target 取值应为 rulecard 或 calculator', status: 400 };
  }
  if (!['approved', 'rejected', 'pending_review'].includes(decision)) {
    return { error: 'decision 取值应为 approved / rejected / pending_review', status: 400 };
  }
  const mv = get('SELECT * FROM methodology_version WHERE id = ?', [methodologyVersionId]);
  if (!mv) return { error: '方法学版本不存在', status: 404 };

  const col = target === 'rulecard' ? 'rulecard_status' : 'calculator_status';
  const byCol = target === 'rulecard' ? 'rulecard_approved_by' : 'calculator_approved_by';
  const atCol = target === 'rulecard' ? 'rulecard_approved_at' : 'calculator_approved_at';
  const isApproved = decision === 'approved';

  // 审批前置校验：不允许在存在占位系数或缺失条款页码时批准计算插件
  if (target === 'calculator' && isApproved) {
    const mod = getMethodologyModule(mv.methodology_id, mv.version);
    if (!mod?.plugin) return { error: '该方法学尚未注册计算插件', status: 409 };
    // 审批前置校验同样以数据库为准：这样「先确认因子、再批准」的顺序才成立，
    // 也保证 approveMethodology 与 assertCalculationPreconditions 判据完全一致。
    const { placeholders, pendingClauses: pendingClause } = loadVerificationState(
      mv.methodology_id, mv.version
    );
    if (placeholders.length || pendingClause.length) {
      return {
        error:
          `不允许批准：仍含 ${placeholders.length} 项占位系数、${pendingClause.length} 条缺条款页码的公式。` +
          '请先完成 docs/12 领域专家确认清单中的对应条目。',
        status: 409,
        detail: {
          placeholder_factors: placeholders.map((f) => f.factor_key),
          formulas_without_clause: pendingClause.map((f) => f.formula_id),
        },
      };
    }
  }

  run(`UPDATE methodology_version SET ${col} = ?, ${byCol} = ?, ${atCol} = ?, updated_at = ? WHERE id = ?`, [
    decision, isApproved ? user.name : null, isApproved ? nowIso() : null, nowIso(), methodologyVersionId,
  ]);
  run(
    `INSERT INTO review_decision (id,object_type,object_id,decision,reviewer,reviewer_role,comment,decided_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [newId('RVW'), target, methodologyVersionId, decision, user.name, user.role, comment || null, nowIso()]
  );
  audit({
    actor: user.name, actorRole: user.role, action: 'methodology.approve',
    objectType: 'methodology_version', objectId: methodologyVersionId,
    detail: { target, decision, comment },
  });
  return { ok: true, target, decision };
}

export function demoChannelState() {
  return {
    demo_channel_enabled: (getMeta(null, 'demo_channel_enabled') || 'false') === 'true',
    enabled_by: getMeta(null, 'demo_channel_enabled_by') || null,
    enabled_at: getMeta(null, 'demo_channel_enabled_at') || null,
    calculator_gate_mode: getMeta(null, 'calculator_gate_mode') || 'strict',
    note: getMeta(null, 'demo_channel_note') || null,
  };
}
