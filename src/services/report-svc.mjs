/**
 * 报告服务：投资筛选报告、导出、人工审核
 * ============================================================================
 * 对应设计文档第 9 节报告模板与第 10 节验收用例 6（可追溯性）。
 *
 * 报告中的**每一条陈述**都必须带来源分层标注：
 *   官方已确认 / 项目资料记载 / 分析师推断 / 模型假设 / 待核实
 *
 * 数字纪律：
 *   - 业主公示预计减排量、核查确定的量、登记量分别表述，不合并
 *   - 未登记项目不得表述为「已登记」；未签发不得表述为「已签发」
 *   - 情景估算不得表述为「预计可签发量」
 *   - 碳价仅为情景参数，碳收益另列，不与估算量相乘当作确定现金流
 */
import { all, get, run, audit } from '../core/db.mjs';
import { newId, nowIso, j, uj, toIsoDate, round } from '../core/util.mjs';
import { runEligibility, CONCLUSION } from './engine.mjs';
import { runCalculation, getCalculationRun } from './calc-svc.mjs';
import { loadFactData, registryStageLabel, requireProjectAccess } from './project-svc.mjs';
import { FACT_FIELDS } from '../data/fact-fields.mjs';

const LABELS = {
  official: '官方已确认',
  project_doc: '项目资料记载',
  analyst: '分析师推断',
  owner_claim: '项目资料记载（业主自述，未经官方核实）',
  assumption: '模型假设',
  factor_default: '模型假设（方法学缺省值待确认）',
  plugin_default: '模型假设（插件缺省值待确认）',
  unknown: '待核实',
};

export function stmt(label, text, extra = {}) {
  return { label, text, ...extra };
}

/**
 * 注册登记链条状态的证据等级标签。
 * ============================================================================
 * 该状态由项目档案人工录入，系统未与注册登记系统自动核对，
 * 因此证据等级最高只能是「项目资料记载」；无链接时只能标「待核实」。
 * 只有将来接入注册登记系统采集并记录 source_id 与采集时间后，才允许标注「官方已确认」。
 */
export function registryStatementLabel(project) {
  return project.registry_public_url ? '项目资料记载' : '待核实';
}

export function generateReport(user, projectId, opts = {}) {
  const access = requireProjectAccess(user, projectId, { needManage: true });
  if (access.error) return access;
  const project = access.project;

  const analysisBaseDate = toIsoDate(opts.analysisBaseDate);

  // 1) 条件检查（含匹配）
  const elig = runEligibility(user, projectId, {
    analysisBaseDate,
    methodologyVersionId: opts.methodologyVersionId,
  });
  if (elig.error) return elig;

  // 2) 情景计算（仅在业务通道可出数时执行；必须绑定本次条件检查快照）
  let calc = null;
  let calc_blocked_reason = null;
  if (elig.calculation_availability?.available && elig.methodology_version) {
    const r = runCalculation(user, projectId, {
      methodologyVersionId: elig.methodology_version.id,
      analysisBaseDate,
      allScenarios: true,
      overrides: opts.overrides || {},
      eligibilityRunId: elig.eligibility_run_id, // P0-4：绑定同一份条件检查快照
      channel: 'business',
    });
    if (r.error || r.rejected) {
      calc_blocked_reason = r.message || r.error;
    } else if (r.demo) {
      // 理论上不会发生（business 通道不会返回 demo），双保险
      calc_blocked_reason = '计算运行被标记为演示数据，已按隔离要求排除出报告。';
    } else {
      calc = r;
    }
  } else {
    calc_blocked_reason = elig.calculation_availability?.reason || '未执行计算。';
  }

  // 3) 组装报告
  const { facts } = loadFactData(projectId);
  const content = assembleReport({ project, elig, calc, facts, carbonPrice: opts.carbonPrice, calc_blocked_reason });

  const id = newId('RPT');
  const prev = get('SELECT id, revision FROM report WHERE project_id = ? ORDER BY revision DESC LIMIT 1', [projectId]);
  const revision = prev ? prev.revision + 1 : 1;

  run(
    `INSERT INTO report (id,project_id,analysis_base_date,generated_at,generated_by,status,
      snapshot_json,content_json,revision,supersedes_id)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      id, projectId, analysisBaseDate, nowIso(), user.name, 'draft',
      j({
        eligibility_run_id: elig.eligibility_run_id,
        match_run_id: elig.match_run_id,
        calculation_run_ids: calc?.runs?.map((r) => r.calculation_run_id) || [],
        methodology_version_id: elig.methodology_version?.id || null,
        analysis_base_date: analysisBaseDate,
        generated_at: nowIso(),
      }),
      j(content), revision, prev?.id || null,
    ]
  );

  audit({
    actor: user.name, actorRole: user.role, action: 'report.generate',
    objectType: 'report', objectId: id,
    detail: { projectId, revision, conclusion: elig.conclusion },
  });

  return {
    report_id: id,
    revision,
    project_id: projectId,
    analysis_base_date: analysisBaseDate,
    content,
    snapshot: {
      eligibility_run_id: elig.eligibility_run_id,
      match_run_id: elig.match_run_id,
      calculation_run_ids: calc?.runs?.map((r) => r.calculation_run_id) || [],
    },
    status: 200,
  };
}

function assembleReport({ project, elig, calc, facts, carbonPrice, calc_blocked_reason }) {
  const factByKey = new Map(facts.map((f) => [f.field_key, f]));
  const labelOf = (key) => {
    const f = factByKey.get(key);
    return LABELS[f?.source_kind] || '待核实';
  };
  const valueOf = (key, fallback = '（待核实）') => {
    const f = factByKey.get(key);
    if (!f) return fallback;
    return f.value_type === 'number' ? f.value_num : f.value_text;
  };

  /* ------------------------------ 一页结论 ------------------------------ */
  const baseRun = calc?.runs?.find((r) => r.scenario === 'base') || null;
  const consRun = calc?.runs?.find((r) => r.scenario === 'conservative') || null;
  const optRun = calc?.runs?.find((r) => r.scenario === 'optimistic') || null;

  const blockers = elig.summary.blocking_fail_list.map((b) => stmt('官方已确认', `${b.rule_id} ${b.title}：${b.detail}`));
  const majorFails = elig.layers.common
    .concat(elig.layers.specific)
    .filter((r) => r.state === 'fail' && r.severity === 'major')
    .map((r) => stmt('官方已确认', `${r.rule_id} ${r.title}：${r.detail}`));

  const top5 = elig.priority_gaps.slice(0, 5).map((g) =>
    stmt('待核实', `${g.label}（${g.required_for}；期望证据：${g.description || '按方法学要求'}）`, {
      field_key: g.field_key, evidence_policy: g.evidence_policy,
    })
  );

  const onePage = {
    title: '一页结论',
    project_overview: [
      stmt('项目资料记载', `项目名称：${project.name}（${project.code}）`),
      stmt('项目资料记载', `项目业主：${project.owner_name || '（待核实）'}；地点：${project.province || '—'} ${project.city || '—'}`),
      stmt('项目资料记载', `项目类型 / 技术路线：${project.project_type || '—'} / ${project.technology_route || '—'}`),
      // ------------------------------------------------------------------
      // 【证据等级纪律】注册登记链条状态与三类减排量均由人工在项目档案中录入，
      // 系统并未与注册登记系统做过自动核对，因此**不得**标注为「官方已确认」。
      // 只有在绑定可核对的注册登记系统记录与采集时间之后，才可升级证据等级。
      // ------------------------------------------------------------------
      stmt(registryStatementLabel(project), `注册登记链条状态（人工录入）：${registryStageLabel(project).join(' → ')}`, {
        note:
          '本字段由项目档案人工维护，系统未与全国温室气体自愿减排注册登记系统自动核对，' +
          '因此标注为人工录入而非「官方已确认」。各状态分列存储，不合并表述。' +
          '复核前不得作为官方状态引用。',
      }),
      stmt('待核实', `业主公示预计减排量：${project.owner_announced_estimate ?? '未公示'} tCO₂e`, {
        note: '仅代表业主公示口径，不等于核查量或登记量，且未经系统与公示页面核对。',
      }),
      stmt('待核实', `核查确定的量：${project.verified_amount ?? '无记录'} tCO₂e；登记量：${project.registered_amount ?? '无记录'} tCO₂e`, {
        note:
          '三套数字分开存储，未登记时不得表述为「已登记」。' +
          '上述数值为人工录入，须绑定注册登记系统记录后方可升级为官方口径。',
      }),
      stmt(project.registry_public_url ? '项目资料记载' : '待核实',
        `登记信息公开链接：${project.registry_public_url || '未提供'}`,
        { note: project.registry_public_url ? '已提供链接，但系统未自动抓取核对。' : '缺少可核对的官方链接。' }),
    ],
    candidate_methodology: elig.methodology_version
      ? [
          stmt('官方已确认', `${elig.methodology_version.code_display || elig.methodology_version.methodology_id} ${elig.methodology_version.name}`),
          stmt('官方已确认', `状态：${elig.methodology_version.document_status === 'formal' ? '正式发布' : '草案'}；生效日期：${elig.methodology_version.effective_date || '—'}`),
          stmt('官方已确认', `官方原文：${elig.methodology_version.official_url || '—'}`),
          stmt('官方已确认', `规则卡状态：${elig.methodology_version.rulecard_status === 'approved' ? '已获批' : '未获批'}；计算插件状态：${elig.methodology_version.calculator_status === 'approved' ? '已注册（含待确认系数）' : '未注册'}`),
        ]
      : [stmt('官方已确认', '未检索到可列为可申报候选的正式发布方法学。')],
    conclusion: stmt('官方已确认', elig.conclusion, { conclusion: elig.conclusion }),
    blockers: [...blockers, ...majorFails],
    top5_evidence_gaps: top5,
    estimate: buildEstimateBlock({ calc, baseRun, consRun, optRun, elig, carbonPrice, calc_blocked_reason }),
    data_reliability: buildDataReliability({ elig, calc, factByKey }),
    next_step: stmt('分析师推断', nextStepAdvice(elig, calc)),
  };

  /* -------------------------------- 正文 -------------------------------- */
  const body = {
    title: '正文',
    policy_basis: [
      stmt('官方已确认', '《温室气体自愿减排交易管理办法（试行）》：项目条件、申请与登记、减排量要求。', {
        url: 'https://www.mee.gov.cn/gzk/gz/202310/t20231020_1043695.shtml',
      }),
      ...(elig.methodology_version
        ? [stmt('官方已确认', `方法学发布通知与原文：${elig.methodology_version.official_url || '—'}`)]
        : []),
      stmt('官方已确认', '分析基准日：' + elig.analysis_base_date, {
        note: '报告引用运行快照，不引用「最新库值」；库更新不会静默改写本报告。',
      }),
    ],
    project_facts: facts.map((f) => {
      const meta = FACT_FIELDS.find((x) => x.key === f.field_key);
      return {
        field_key: f.field_key,
        label: meta?.label || f.field_key,
        group_name: meta?.group_name || '其他',
        value: f.value_type === 'number' ? f.value_num : f.value_text,
        unit: f.unit,
        label_of_statement: LABELS[f.source_kind] || '待核实',
        evidence_id: f.evidence_id,
        asserted_by: f.asserted_by,
        asserted_at: f.asserted_at,
      };
    }),
    condition_checks: [...elig.layers.common, ...elig.layers.specific].map((r) => ({
      rule_id: r.rule_id,
      layer: r.layer === 'common' ? '通用门槛' : '方法学专属条件',
      title: r.title,
      condition_text: r.condition_text,
      expression_text: r.expression_text,
      state: r.state,
      state_label: { pass: '通过', fail: '不通过', unknown: '待核实' }[r.state],
      detail: r.detail,
      severity: r.severity,
      clause_ref: r.clause_ref,
      evidence_policy: r.evidence_policy,
      fact_field: r.fact_field,
      fact_value: r.fact_value,
      fact_source_kind: r.fact_source_kind,
      fact_source_label: LABELS[r.fact_source_kind] || null,
      evidence: r.evidence,
      missing_fields: r.missing_fields,
      unknown_reasons: r.unknown_reasons,
      judged_at: r.judged_at,
      rule_version: r.rule_version,
    })),
    conflict_flags: elig.layers.conflict.map((r) => ({
      rule_id: r.rule_id,
      title: r.title,
      state: r.state,
      detail: r.detail,
      handling: '交由人工核对其法律与方法学影响；不因发现同名机制而自动判不合格。',
    })),
    formulas_and_params: calc
      ? {
          methodology: calc.plugin.title,
          plugin_version: calc.plugin.plugin_version,
          channel: calc.channel,
          eligibility_snapshot: calc.eligibility_snapshot,
          formula_refs: calc.plugin.formula_refs,
          inputs: calc.runs[0]?.result?.inputs || {},
          input_origins: calc.runs[0]?.result?.input_origins || [],
          factor_snapshot: calc.factor_snapshot,
          placeholder_factors: calc.runs[0]?.placeholder_factors || [],
          steps: baseRun?.steps || [],
        }
      : { note: calc_blocked_reason || elig.calculation_availability?.reason || '未执行计算。' },
    scenarios: calc
      ? calc.runs.map((r) => ({
          scenario: r.scenario,
          scenario_label: r.scenario_label,
          er_annual: r.er_annual,
          crediting_total: r.crediting?.total ?? null,
          crediting_years: r.crediting?.years ?? null,
          note: r.result?.scenario_note,
          multipliers: r.result?.scenario_multipliers,
        }))
      : [],
    sensitivity: baseRun?.sensitivity || [],
    carbon_rights_risks: [
      stmt('分析师推断', '需核对同一减排活动在其他自愿减排机制、绿证/绿电、补贴或合同中的权属与环境权益声明。'),
      ...elig.layers.conflict
        .filter((r) => r.state === 'fail')
        .map((r) => stmt('待核实', `${r.title}：${r.detail}`)),
    ],
    cost_items_pending: [
      stmt('待核实', '项目开发与备案成本、审定与核查费用、监测与联网改造费用、方法学适用性复核费用。'),
      stmt('待核实', `项目投资额：${valueOf('com.investment_amount')} 万元；开发/审定/核查成本：${valueOf('com.development_cost_estimate')} 万元`),
    ],
    investment_view: buildInvestmentView({ elig, calc, carbonPrice }),
  };

  /* ------------------------------ 可追溯索引 ------------------------------ */
  const traceability = {
    note: '任一结论均可从本报告追到输入文件页码、数据行、方法学公式、因子版本与审核人。',
    evidence_index: facts
      .filter((f) => f.evidence_id)
      .map((f) => ({ field_key: f.field_key, evidence_id: f.evidence_id })),
    methodology_version_id: elig.methodology_version?.id || null,
    rule_versions: [...elig.layers.common, ...elig.layers.specific, ...elig.layers.conflict].map((r) => ({
      rule_id: r.rule_id, rule_version: r.rule_version, judged_at: r.judged_at,
    })),
    factor_versions: calc?.factor_snapshot?.map((f) => ({
      factor_key: f.factor_key, value: f.value, unit: f.unit, source_ref: f.source_ref,
      source_year: f.source_year, value_status: f.value_status,
    })) || [],
    runs: {
      eligibility_run_id: elig.eligibility_run_id,
      match_run_id: elig.match_run_id,
      calculation_run_ids: calc?.runs?.map((r) => r.calculation_run_id) || [],
    },
  };

  return {
    generated_at: nowIso(),
    analysis_base_date: elig.analysis_base_date,
    one_page: onePage,
    body,
    traceability,
    disclaimer:
      '本报告为投资筛选与研究辅助材料，供分析师复核。不替代项目业主、审定与核查机构、注册登记机构的工作；' +
      '不构成对减排量、签发量或可交易量的确认；情景估算不得作为确定现金流。',
  };
}

function buildEstimateBlock({ calc, baseRun, consRun, optRun, elig, carbonPrice, calc_blocked_reason }) {
  if (!calc) {
    const reason = calc_blocked_reason || elig.calculation_availability?.reason || '未执行计算。';
    return {
      available: false,
      reason,
      statements: [
        stmt('待核实', '本报告不含减排量数值。' + reason),
        stmt('分析师推断', '在领域专家完成公式与系数确认、且条件检查无硬障碍之前，不得以任何形式引用减排量数字。'),
      ],
      carbon_revenue: null,
    };
  }
  const price = carbonPrice ?? null;
  const s = [];
  s.push(stmt('模型假设', `基准情景年度情景估算：${baseRun?.er_annual ?? '—'} tCO₂e/年`));
  s.push(stmt('模型假设', `保守情景：${consRun?.er_annual ?? '—'}；乐观情景：${optRun?.er_annual ?? '—'} tCO₂e/年`));
  s.push(stmt('模型假设', `计入期情景估算合计：${baseRun?.crediting?.total ?? '—'} tCO₂e（${baseRun?.crediting?.years ?? '—'} 年）`));
  s.push(stmt('模型假设', '上述均为「情景估算」，不是预计减排量、预计可签发量或可交易量。'));
  if (calc.runs[0]?.placeholder_factors?.length) {
    s.push(stmt('模型假设', `含 ${calc.runs[0].placeholder_factors.length} 项未经领域专家确认的占位系数，结果仅供内部讨论。`));
  }
  let carbonRevenue = null;
  if (price !== null && baseRun?.er_annual) {
    carbonRevenue = {
      price,
      annual: round(baseRun.er_annual * price, 2),
      crediting: baseRun.crediting?.total ? round(baseRun.crediting.total * price, 2) : null,
      note: '碳价为用户填入的情景参数，碳收益单独列出，不与估算量相乘当作确定现金流。',
    };
    s.push(stmt('模型假设', `按碳价 ${price} 元/tCO₂e 的情景碳收益：约 ${carbonRevenue.annual} 元/年（非确定现金流）`));
  } else {
    s.push(stmt('待核实', '未提供碳价情景参数，报告不列示碳收益。'));
  }
  return { available: true, statements: s, carbon_revenue: carbonRevenue };
}

function buildDataReliability({ elig, calc, factByKey }) {
  const strictFields = FACT_FIELDS.filter((f) => f.evidence_policy === 'strict');
  const missing = strictFields.filter((f) => !factByKey.has(f.key));
  const ownerClaim = strictFields.filter((f) => {
    const row = factByKey.get(f.key);
    return row && !['official', 'project_doc'].includes(row.source_kind);
  });
  return {
    strict_evidence_fields_total: strictFields.length,
    strict_fields_missing: missing.map((f) => f.label),
    strict_fields_without_qualified_evidence: ownerClaim.map((f) => ({
      label: f.label, source_kind: factByKey.get(f.key).source_kind,
    })),
    conclusion:
      elig.conclusion === CONCLUSION.INSUFFICIENT
        ? '关键字段证据不足，结论为「资料不足暂无法判断」。'
        : missing.length === 0 && ownerClaim.length === 0
          ? '严格证据字段均已附合格证据。'
          : '部分严格证据字段仍存在证据缺口，见上列清单。',
    placeholder_factor_count: calc?.runs?.[0]?.placeholder_factors?.length || 0,
  };
}

function nextStepAdvice(elig, calc) {
  if (elig.conclusion === CONCLUSION.NO_METHODOLOGY) {
    return '当前无已发布适用方法学。建议：纳入观察清单，跟踪方法学发布动态；或核对项目类型填报是否准确。';
  }
  if (elig.conclusion === CONCLUSION.BLOCKED) {
    return '存在硬障碍。建议：确认障碍是否因资料口径问题造成；若属实质不符合，终止本方法学路径并评估其他机制或改造方案。';
  }
  if (elig.conclusion === CONCLUSION.INSUFFICIENT) {
    return '资料不足。建议：按优先补充证据清单补齐材料后重跑条件检查，再决定是否进入财务测算。';
  }
  return calc
    ? '可继续尽调。建议：核实占位系数、核定项目投资与开发成本、核对环境权益处分情况，并委托第三方复算。'
    : '可继续尽调。建议：先完成计算插件校验，再进入财务测算。';
}

function buildInvestmentView({ elig, calc, carbonPrice }) {
  const out = [];
  out.push(stmt('分析师推断', `筛选结论：${elig.conclusion}（四态枚举之一，不作为申报成功概率）。`));
  if (elig.summary.blocking_fail_list.length) {
    out.push(stmt('分析师推断', `硬障碍 ${elig.summary.blocking_fail_list.length} 项，构成投资决策的一票否决项。`));
  }
  const majFails = elig.layers.specific.filter((r) => r.state === 'fail' && r.severity === 'major');
  if (majFails.length) {
    out.push(stmt('分析师推断', `方法学专属重大不符合 ${majFails.length} 项：${majFails.map((r) => r.title).join('、')}。`));
  }
  if (calc?.runs?.length) {
    const s = calc.runs.find((r) => r.scenario === 'conservative');
    const o = calc.runs.find((r) => r.scenario === 'optimistic');
    if (s && o) {
      out.push(stmt('模型假设', `碳收益敏感性：保守 ${s.er_annual} 至乐观 ${o.er_annual} tCO₂e/年，情景区间宽度 ${round((o.er_annual || 0) - (s.er_annual || 0), 2)} tCO₂e/年。`));
    }
    const top = calc.runs[0]?.sensitivity?.[0];
    if (top) {
      out.push(stmt('模型假设', `最敏感驱动因素：${top.label}（±${top.delta_pct}% 引起结果摆动 ${top.swing} tCO₂e/年），尽调资源应优先投向该参数的实测证据。`));
    }
  } else {
    out.push(stmt('待核实', '未出数，无法评估碳收益敏感性；投资判断应仅基于硬障碍与资料完备性。'));
  }
  out.push(stmt('待核实', `碳价情景参数：${carbonPrice ?? '未提供'} 元/tCO₂e；碳收益属情景参数，须与项目主业收益分开评估。`));
  return out;
}

/* -------------------------------- 导出 -------------------------------- */

export function exportReport(user, reportId, format = 'markdown') {
  const row = get('SELECT * FROM report WHERE id = ?', [reportId]);
  if (!row) return { error: '报告不存在', status: 404 };
  const content = uj(row.content_json, {});
  const project = get('SELECT * FROM project WHERE id = ?', [row.project_id]);
  if (!project) return { error: '项目不存在', status: 404 };
  if (user.role !== 'admin' && project.team_id !== user.team_id && project.confidentiality !== 'public') {
    audit({
      actor: user.name, actorRole: user.role, action: 'report.export_denied',
      objectType: 'report', objectId: reportId, detail: { reason: '团队授权限制' }, result: 'denied',
    });
    return { error: '无权导出该项目报告', status: 403 };
  }

  const files = {
    markdown: { ext: 'md', mime: 'text/markdown; charset=utf-8', body: toMarkdown(project, row, content) },
    html: { ext: 'html', mime: 'text/html; charset=utf-8', body: toHtml(project, row, content) },
    csv: { ext: 'csv', mime: 'text/csv; charset=utf-8', body: toCsv(project, row, content) },
    // Office 可直接打开 HTML 形式的 .doc / .xls（无需引入任何二进制写入库）
    doc: { ext: 'doc', mime: 'application/msword; charset=utf-8', body: toWordHtml(project, row, content) },
    xls: { ext: 'xls', mime: 'application/vnd.ms-excel; charset=utf-8', body: toExcelHtml(project, row, content) },
  };
  const f = files[format] || files.markdown;

  audit({
    actor: user.name, actorRole: user.role, action: 'report.export',
    objectType: 'report', objectId: reportId,
    detail: { format, project_id: row.project_id, revision: row.revision },
  });

  return {
    status: 200,
    file_name: `${project.code || project.id}_筛选报告_r${row.revision}.${f.ext}`,
    mime: f.mime,
    body: f.body,
  };
}

function toMarkdown(project, row, c) {
  const L = [];
  const P = (t) => L.push(t);
  P(`# ${project.name} —— CCER 投资筛选报告`);
  P('');
  P(`- 项目编号：${project.code}`);
  P(`- 分析基准日：${row.analysis_base_date}`);
  P(`- 报告版本：r${row.revision}；生成时间：${row.generated_at}；生成人：${row.generated_by}`);
  P(`- 报告状态：${row.status}`);
  P('');
  P('> ' + (c.disclaimer || ''));
  P('');
  P('## 一页结论');
  P('');
  P('### 项目概况');
  for (const s of c.one_page.project_overview) P(`- **【${s.label}】** ${s.text}${s.note ? `（${s.note}）` : ''}`);
  P('');
  P('### 候选方法学与版本');
  for (const s of c.one_page.candidate_methodology) P(`- **【${s.label}】** ${s.text}`);
  P('');
  P(`### 当前判断`);
  P('');
  P(`**${c.one_page.conclusion.text}**`);
  P('');
  P('### 关键硬障碍');
  if (c.one_page.blockers.length) for (const s of c.one_page.blockers) P(`- **【${s.label}】** ${s.text}`);
  else P('- 无硬障碍。');
  P('');
  P('### 需补充的前五项证据');
  if (c.one_page.top5_evidence_gaps.length) {
    c.one_page.top5_evidence_gaps.forEach((s, i) => P(`${i + 1}. **【${s.label}】** ${s.text}`));
  } else P('- 无。');
  P('');
  P('### 情景估算');
  for (const s of c.one_page.estimate.statements) P(`- **【${s.label}】** ${s.text}`);
  P('');
  P('### 数据可靠性');
  P(`- 严格证据字段总数：${c.one_page.data_reliability.strict_evidence_fields_total}`);
  P(`- 缺失：${c.one_page.data_reliability.strict_fields_missing.join('、') || '无'}`);
  P(`- 证据不合格：${c.one_page.data_reliability.strict_fields_without_qualified_evidence.map((x) => x.label).join('、') || '无'}`);
  P(`- 结论：${c.one_page.data_reliability.conclusion}`);
  P('');
  P('### 下一步尽调决定');
  P(`- **【${c.one_page.next_step.label}】** ${c.one_page.next_step.text}`);
  P('');
  P('## 正文');
  P('');
  P('### 1 政策与方法学依据');
  for (const s of c.body.policy_basis) P(`- **【${s.label}】** ${s.text}${s.url ? ` <${s.url}>` : ''}`);
  P('');
  P('### 2 项目事实及来源');
  P('');
  P('| 字段 | 值 | 单位 | 来源标注 | 证据 |');
  P('| --- | --- | --- | --- | --- |');
  for (const f of c.body.project_facts) {
    P(`| ${f.label} | ${f.value ?? '（空）'} | ${f.unit || ''} | ${f.label_of_statement} | ${f.evidence_id || '—'} |`);
  }
  P('');
  P('### 3 逐项条件检查');
  P('');
  P('| 规则 | 层级 | 条件 | 判断 | 依据 | 条款 | 证据 |');
  P('| --- | --- | --- | --- | --- | --- | --- |');
  for (const r of c.body.condition_checks) {
    P(`| ${r.rule_id} ${r.title} | ${r.layer} | ${r.expression_text} | ${r.state_label} | ${r.detail} | ${r.clause_ref || '—'} | ${r.evidence ? `${r.evidence.file_name} p.${r.evidence.page}` : '—'} |`);
  }
  P('');
  P('### 4 公式和参数');
  if (c.body.formulas_and_params.steps) {
    P(`插件：${c.body.formulas_and_params.methodology}（${c.body.formulas_and_params.plugin_version}）`);
    P('');
    P('| 步 | 名称 | 公式 | 代入 | 结果 | 单位 | 因子状态 |');
    P('| --- | --- | --- | --- | --- | --- | --- |');
    for (const s of c.body.formulas_and_params.steps) {
      P(`| ${s.step_no} | ${s.title} | ${s.formula} | ${s.substitution || ''} | ${s.result} | ${s.unit || ''} | ${s.factor_status || '—'} |`);
    }
    P('');
    P('因子快照：');
    P('');
    P('| 因子 | 取值 | 单位 | 出处 | 年份 | 状态 |');
    P('| --- | --- | --- | --- | --- | --- |');
    for (const f of c.body.formulas_and_params.factor_snapshot) {
      P(`| ${f.name} | ${f.value} | ${f.unit || ''} | ${f.source_ref || ''} | ${f.source_year ?? ''} | ${f.value_status} |`);
    }
  } else {
    P(`- ${c.body.formulas_and_params.note}`);
  }
  P('');
  P('### 5 情景与敏感性');
  for (const s of c.body.scenarios) P(`- **${s.scenario_label}**：${s.er_annual} tCO₂e/年；计入期 ${s.crediting_total} tCO₂e / ${s.crediting_years} 年。${s.note || ''}`);
  if (c.body.sensitivity.length) {
    P('');
    P('| 驱动因素 | 基准值 | ±扰动 | 结果摆动 | 敏感度指数 |');
    P('| --- | --- | --- | --- | --- |');
    for (const s of c.body.sensitivity) {
      P(`| ${s.label} | ${s.base_value} ${s.unit || ''} | ±${s.delta_pct}% | ${s.swing} | ${s.sensitivity_index} |`);
    }
  }
  P('');
  P('### 6 碳权属与重复计算风险');
  for (const s of c.body.carbon_rights_risks) P(`- **【${s.label}】** ${s.text}`);
  P('');
  P('### 7 待确认项');
  for (const s of c.body.cost_items_pending) P(`- **【${s.label}】** ${s.text}`);
  P('');
  P('### 8 投资建议');
  for (const s of c.body.investment_view) P(`- **【${s.label}】** ${s.text}`);
  P('');
  P('## 附录：可追溯索引');
  P('');
  P(`- 方法学版本 ID：${c.traceability.methodology_version_id}`);
  P(`- 条件检查运行 ID：${c.traceability.runs.eligibility_run_id}`);
  P(`- 匹配运行 ID：${c.traceability.runs.match_run_id}`);
  P(`- 计算运行 ID：${(c.traceability.runs.calculation_run_ids || []).join('、') || '无'}`);
  P(`- ${c.traceability.note}`);
  return L.join('\n');
}

function toHtml(project, row, c) {
  const md = toMarkdown(project, row, c);
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const body = esc(md)
    .replace(/^# (.*)$/gm, '<h1>$1</h1>')
    .replace(/^## (.*)$/gm, '<h2>$1</h2>')
    .replace(/^### (.*)$/gm, '<h3>$1</h3>')
    .replace(/^\| (.*) \|$/gm, (m) => `<tr>${m.split(' | ').map((x) => `<td>${x.replace(/^\||\|$/g, '').trim()}</td>`).join('')}</tr>`.replace(/^<tr><td>---.*/, ''))
    .replace(/^- (.*)$/gm, '<li>$1</li>')
    .replace(/\n/g, '<br/>');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/>
<title>${esc(project.name)} —— CCER 投资筛选报告</title>
<style>body{font-family:"Microsoft YaHei",system-ui,sans-serif;max-width:960px;margin:32px auto;line-height:1.7;color:#1f2430}
h1{border-bottom:3px solid #0f766e;padding-bottom:8px} h2{color:#0f766e;margin-top:32px}
li{margin:4px 0} table{border-collapse:collapse;width:100%;font-size:13px} td{border:1px solid #d8dee9;padding:4px 8px}
blockquote{background:#f1f5f9;border-left:4px solid #0f766e;padding:8px 16px;color:#475569}</style>
</head><body><div style="background:#fff7ed;border:1px solid #fdba74;padding:10px 14px;border-radius:6px;margin-bottom:16px">
<strong>报告状态：${esc(row.status)}</strong> ｜ 版本 r${row.revision} ｜ 生成时间 ${esc(row.generated_at)} ｜ 生成人 ${esc(row.generated_by)}
</div>
<pre style="display:none">${esc(md)}</pre>
<div id="c">${body}</div>
</body></html>`;
}

function toCsv(project, row, c) {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [];
  rows.push(['区块', '项目', '内容', '来源标注'].map(q).join(','));
  const push = (block, item, text, label) => rows.push([block, item, text, label].map(q).join(','));

  for (const s of c.one_page.project_overview) push('一页结论', '项目概况', s.text, s.label);
  for (const s of c.one_page.candidate_methodology) push('一页结论', '候选方法学', s.text, s.label);
  push('一页结论', '当前判断', c.one_page.conclusion.text, c.one_page.conclusion.label);
  for (const s of c.one_page.blockers) push('一页结论', '关键硬障碍', s.text, s.label);
  c.one_page.top5_evidence_gaps.forEach((s, i) => push('一页结论', `补充证据${i + 1}`, s.text, s.label));
  for (const s of c.one_page.estimate.statements) push('一页结论', '情景估算', s.text, s.label);
  push('一页结论', '下一步', c.one_page.next_step.text, c.one_page.next_step.label);
  for (const r of c.body.condition_checks) {
    push('条件检查', `${r.rule_id} ${r.title}`, `${r.expression_text} → ${r.state_label}：${r.detail}`, r.fact_source_label || '');
  }
  for (const s of c.body.scenarios) {
    push('情景', s.scenario_label, `年度 ${s.er_annual} tCO₂e；计入期 ${s.crediting_total} tCO₂e`, '模型假设');
  }
  for (const s of c.body.sensitivity) {
    push('敏感性', s.label, `±${s.delta_pct}% → 摆动 ${s.swing}`, '模型假设');
  }
  for (const s of c.body.investment_view) push('投资建议', '投资建议', s.text, s.label);
  push('追溯', '运行ID', `eligibility=${c.traceability.runs.eligibility_run_id}; calc=${(c.traceability.runs.calculation_run_ids || []).join('|')}`, '官方已确认');
  void project;
  void row;
  return '\ufeff' + rows.join('\n');
}

/**
 * Word 可打开的 HTML 文档（.doc）。
 * Microsoft Word 与 WPS 均可直接打开带 Office 命名空间的 HTML，并保留标题层级、表格与列表。
 * 这样无需引入任何二进制 docx 写入库即可满足「导出 Word」的需求。
 */
function toWordHtml(project, row, c) {
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const H = [];
  H.push('<h1>' + esc(project.name) + ' —— CCER 投资筛选报告</h1>');
  H.push('<table border="1" cellspacing="0" cellpadding="4"><tr><td><b>项目编号</b></td><td>' + esc(project.code) +
    '</td><td><b>分析基准日</b></td><td>' + esc(row.analysis_base_date) + '</td></tr>' +
    '<tr><td><b>报告版本</b></td><td>r' + row.revision + '</td><td><b>状态</b></td><td>' + esc(row.status) + '</td></tr>' +
    '<tr><td><b>生成时间</b></td><td>' + esc(row.generated_at) + '</td><td><b>生成人</b></td><td>' + esc(row.generated_by) + '</td></tr></table>');
  H.push('<p style="color:#92400e"><i>' + esc(c.disclaimer) + '</i></p>');

  const blockList = (title, items) => {
    H.push('<h3>' + esc(title) + '</h3>');
    if (!items.length) {
      H.push('<p>—</p>');
      return;
    }
    H.push('<ul>');
    for (const s of items) H.push('<li><b>【' + esc(s.label) + '】</b>' + esc(s.text) + (s.note ? '（' + esc(s.note) + '）' : '') + '</li>');
    H.push('</ul>');
  };

  H.push('<h2>一页结论</h2>');
  blockList('项目概况', c.one_page.project_overview);
  blockList('候选方法学与版本', c.one_page.candidate_methodology);
  H.push('<h3>当前判断</h3><p style="font-size:14pt"><b>' + esc(c.one_page.conclusion.text) + '</b></p>');
  blockList('关键硬障碍', c.one_page.blockers.length ? c.one_page.blockers : [{ label: '官方已确认', text: '无。' }]);
  blockList('需补充的前五项证据', c.one_page.top5_evidence_gaps.length ? c.one_page.top5_evidence_gaps : [{ label: '待核实', text: '无。' }]);
  blockList('情景估算', c.one_page.estimate.statements);
  if (c.one_page.estimate.carbon_revenue) {
    const cr = c.one_page.estimate.carbon_revenue;
    H.push('<p>碳收益（情景参数）：碳价 ' + esc(cr.price) + ' 元/tCO₂e，年度约 ' + esc(cr.annual) +
      ' 元，计入期约 ' + esc(cr.crediting) + ' 元。' + esc(cr.note) + '</p>');
  }
  H.push('<h3>数据可靠性</h3><table border="1" cellspacing="0" cellpadding="4">');
  H.push('<tr><td><b>严格证据字段总数</b></td><td>' + c.one_page.data_reliability.strict_evidence_fields_total + '</td></tr>');
  H.push('<tr><td><b>缺失</b></td><td>' + esc(c.one_page.data_reliability.strict_fields_missing.join('、') || '无') + '</td></tr>');
  H.push('<tr><td><b>证据不合格</b></td><td>' +
    esc(c.one_page.data_reliability.strict_fields_without_qualified_evidence.map((x) => x.label + '（' + x.source_kind + '）').join('、') || '无') + '</td></tr>');
  H.push('<tr><td><b>结论</b></td><td>' + esc(c.one_page.data_reliability.conclusion) + '</td></tr></table>');
  blockList('下一步尽调决定', [c.one_page.next_step]);

  H.push('<h2>正文</h2>');
  blockList('1 政策与方法学依据', c.body.policy_basis);

  H.push('<h3>2 项目事实及来源</h3><table border="1" cellspacing="0" cellpadding="4">');
  H.push('<tr><th>字段</th><th>值</th><th>单位</th><th>来源标注</th></tr>');
  for (const f of c.body.project_facts) {
    H.push('<tr><td>' + esc(f.label) + '</td><td>' + esc(f.value ?? '（空）') + '</td><td>' + esc(f.unit || '') + '</td><td>' + esc(f.label_of_statement) + '</td></tr>');
  }
  H.push('</table>');

  H.push('<h3>3 逐项条件检查</h3><table border="1" cellspacing="0" cellpadding="4">');
  H.push('<tr><th>规则</th><th>层级</th><th>条件</th><th>判断</th><th>依据</th><th>证据定位</th><th>条款</th></tr>');
  for (const r of c.body.condition_checks) {
    H.push('<tr><td>' + esc(r.rule_id + ' ' + r.title) + '</td><td>' + esc(r.layer) + '</td><td>' + esc(r.expression_text) +
      '</td><td>' + esc(r.state_label) + '</td><td>' + esc(r.detail) + '</td><td>' +
      esc(r.evidence ? r.evidence.file_name + (r.evidence.page ? ' p.' + r.evidence.page : '') : '—') +
      '</td><td>' + esc(r.clause_ref || '—') + '</td></tr>');
  }
  H.push('</table>');

  H.push('<h3>4 公式和参数</h3>');
  if (c.body.formulas_and_params.steps) {
    H.push('<p>插件：' + esc(c.body.formulas_and_params.methodology) + '（' + esc(c.body.formulas_and_params.plugin_version) + '）</p>');
    H.push('<table border="1" cellspacing="0" cellpadding="4"><tr><th>步</th><th>名称</th><th>公式</th><th>代入</th><th>结果</th><th>单位</th><th>因子状态</th></tr>');
    for (const s of c.body.formulas_and_params.steps) {
      H.push('<tr><td>' + s.step_no + '</td><td>' + esc(s.title) + '</td><td>' + esc(s.formula) + '</td><td>' +
        esc(s.substitution || '') + '</td><td>' + esc(s.result) + '</td><td>' + esc(s.unit || '') + '</td><td>' +
        esc(s.factor_status || '—') + '</td></tr>');
    }
    H.push('</table>');
    H.push('<h4>因子快照</h4><table border="1" cellspacing="0" cellpadding="4"><tr><th>因子</th><th>取值</th><th>单位</th><th>出处</th><th>年份</th><th>状态</th></tr>');
    for (const f of c.body.formulas_and_params.factor_snapshot) {
      H.push('<tr><td>' + esc(f.name) + '</td><td>' + esc(f.value) + '</td><td>' + esc(f.unit || '') + '</td><td>' +
        esc(f.source_ref || '') + '</td><td>' + esc(f.source_year ?? '') + '</td><td>' + esc(f.value_status) + '</td></tr>');
    }
    H.push('</table>');
  } else {
    H.push('<p>' + esc(c.body.formulas_and_params.note || '') + '</p>');
  }

  if (c.body.scenarios.length) {
    H.push('<h3>5 情景与敏感性</h3><table border="1" cellspacing="0" cellpadding="4"><tr><th>情景</th><th>年度 tCO₂e</th><th>计入期 tCO₂e</th><th>说明</th></tr>');
    for (const s of c.body.scenarios) {
      H.push('<tr><td>' + esc(s.scenario_label) + '</td><td>' + esc(s.er_annual) + '</td><td>' + esc(s.crediting_total) +
        '</td><td>' + esc(s.note || '') + '</td></tr>');
    }
    H.push('</table>');
    if (c.body.sensitivity.length) {
      H.push('<table border="1" cellspacing="0" cellpadding="4"><tr><th>驱动因素</th><th>基准值</th><th>扰动</th><th>结果摆动</th><th>敏感度指数</th></tr>');
      for (const s of c.body.sensitivity) {
        H.push('<tr><td>' + esc(s.label) + '</td><td>' + esc(s.base_value) + '</td><td>±' + esc(s.delta_pct) + '%</td><td>' +
          esc(s.swing) + '</td><td>' + esc(s.sensitivity_index) + '</td></tr>');
      }
      H.push('</table>');
    }
  }

  blockList('6 碳权属与重复计算风险', c.body.carbon_rights_risks);
  blockList('7 待确认项', c.body.cost_items_pending);
  blockList('8 投资建议', c.body.investment_view);

  H.push('<h2>附录：可追溯索引</h2>');
  H.push('<p>方法学版本 ID：' + esc(c.traceability.methodology_version_id || '—') + '<br/>' +
    '条件检查运行 ID：' + esc(c.traceability.runs.eligibility_run_id) + '<br/>' +
    '匹配运行 ID：' + esc(c.traceability.runs.match_run_id) + '<br/>' +
    '计算运行 ID：' + esc((c.traceability.runs.calculation_run_ids || []).join('、') || '无') + '</p>');
  H.push('<p>' + esc(c.traceability.note) + '</p>');

  return `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" lang="zh-CN">
<head><meta charset="utf-8"/>
<title>${esc(project.name)} —— CCER 投资筛选报告</title>
<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom></w:WordDocument></xml><![endif]-->
<style>
@page { size: A4; margin: 2cm; }
body { font-family: "微软雅黑", SimSun, serif; font-size: 10.5pt; line-height: 1.6; }
h1 { font-size: 18pt; border-bottom: 2px solid #0f766e; padding-bottom: 6pt; }
h2 { font-size: 14pt; color: #0f766e; margin-top: 16pt; }
h3 { font-size: 12pt; color: #334155; margin-top: 12pt; }
h4 { font-size: 11pt; color: #475569; }
table { border-collapse: collapse; width: 100%; font-size: 9pt; }
th { background: #eef2f7; }
td, th { border: 1px solid #94a3b8; padding: 3pt 5pt; vertical-align: top; }
</style></head>
<body>${H.join('\n')}</body></html>`;
}

/**
 * Excel 可打开的 HTML 表格工作簿（.xls）。
 * 用多个 <table> 区块组织「一页结论 / 条件检查 / 计算明细 / 因子快照 / 敏感性」，
 * Excel 打开后可直接筛选与排序。同样无需二进制写入库。
 */
function toExcelHtml(project, row, c) {
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const T = [];
  const sheet = (name, headers, bodyRows) => {
    T.push('<h3>' + esc(name) + '</h3>');
    T.push('<table border="1" cellspacing="0"><thead><tr>' +
      headers.map((x) => '<th>' + esc(x) + '</th>').join('') + '</tr></thead><tbody>' +
      bodyRows.map((r) => '<tr>' + r.map((x) => '<td>' + esc(x ?? '') + '</td>').join('') + '</tr>').join('') +
      '</tbody></table><br/>');
  };

  sheet('报告信息', ['项', '值'], [
    ['项目名称', project.name], ['项目编号', project.code],
    ['分析基准日', row.analysis_base_date], ['报告版本', 'r' + row.revision],
    ['生成时间', row.generated_at], ['生成人', row.generated_by], ['报告状态', row.status],
    ['四态结论', c.one_page.conclusion.text],
    ['免责声明', c.disclaimer],
  ]);

  sheet('一页结论', ['区块', '来源标注', '内容'], [
    ...c.one_page.project_overview.map((s) => ['项目概况', s.label, s.text]),
    ...c.one_page.candidate_methodology.map((s) => ['候选方法学', s.label, s.text]),
    ...c.one_page.blockers.map((s) => ['关键硬障碍', s.label, s.text]),
    ...c.one_page.top5_evidence_gaps.map((s, i) => [`补充证据${i + 1}`, s.label, s.text]),
    ...c.one_page.estimate.statements.map((s) => ['情景估算', s.label, s.text]),
    ['下一步', c.one_page.next_step.label, c.one_page.next_step.text],
  ]);

  sheet('项目事实', ['字段', '取值', '单位', '来源标注', '证据 ID'],
    c.body.project_facts.map((f) => [f.label, f.value, f.unit, f.label_of_statement, f.evidence_id]));

  sheet('条件检查', ['规则', '层级', '条件', '判断', '依据', '严重程度', '条款', '证据定位', '证据页码', '判断时间'],
    c.body.condition_checks.map((r) => [
      `${r.rule_id} ${r.title}`, r.layer, r.expression_text, r.state_label, r.detail, r.severity,
      r.clause_ref, r.evidence ? r.evidence.file_name : '', r.evidence ? r.evidence.page : '', r.judged_at,
    ]));

  if (c.body.formulas_and_params.steps) {
    sheet('计算明细', ['步', '名称', '公式', '代入', '结果', '单位', '因子引用', '因子状态', '条款'],
      c.body.formulas_and_params.steps.map((s) => [
        s.step_no, s.title, s.formula, s.substitution, s.result, s.unit,
        (s.factor_refs || []).join('、'), s.factor_status, s.clause_ref,
      ]));
    sheet('因子快照', ['因子', '名称', '取值', '单位', '出处', '年份', '状态'],
      c.body.formulas_and_params.factor_snapshot.map((f) => [
        f.factor_key, f.name, f.value, f.unit, f.source_ref, f.source_year, f.value_status,
      ]));
  }

  if (c.body.scenarios.length) {
    sheet('情景', ['情景', '年度 tCO₂e', '计入期合计 tCO₂e', '年数', '乘数', '说明'],
      c.body.scenarios.map((s) => [s.scenario_label, s.er_annual, s.crediting_total, s.crediting_years,
        JSON.stringify(s.multipliers || {}), s.note]));
  }
  if (c.body.sensitivity.length) {
    sheet('敏感性', ['驱动因素', '基准值', '单位', '扰动 %', '上行结果', '下行结果', '摆动', '敏感度指数'],
      c.body.sensitivity.map((s) => [s.label, s.base_value, s.unit, s.delta_pct, s.result_up, s.result_down, s.swing, s.sensitivity_index]));
  }

  sheet('冲突与权属', ['来源标注', '内容'],
    [...c.body.carbon_rights_risks, ...c.body.cost_items_pending, ...c.body.investment_view].map((s) => [s.label, s.text]));

  sheet('可追溯索引', ['项', '值'], [
    ['方法学版本 ID', c.traceability.methodology_version_id],
    ['条件检查运行 ID', c.traceability.runs.eligibility_run_id],
    ['匹配运行 ID', c.traceability.runs.match_run_id],
    ['计算运行 ID', (c.traceability.runs.calculation_run_ids || []).join('、')],
    ['说明', c.traceability.note],
  ]);

  return `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" lang="zh-CN">
<head><meta charset="utf-8"/>
<title>${esc(project.name)} —— CCER 投资筛选报告（Excel）</title>
<!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet>
<x:Name>筛选报告</x:Name><x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions>
</x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]-->
<style>
table { border-collapse: collapse; font-family: "微软雅黑", SimSun, sans-serif; font-size: 10pt; }
th { background: #dbeafe; font-weight: bold; }
td, th { border: 1px solid #94a3b8; padding: 2pt 5pt; vertical-align: top; mso-number-format:"\\@"; }
h3 { font-family: "微软雅黑", sans-serif; font-size: 12pt; color: #0f766e; }
</style></head>
<body>${T.join('\n')}</body></html>`;
}

/* -------------------------------- 审核 -------------------------------- */
export function decideReview(user, { objectType, objectId, decision, comment }) {
  if (!['admin', 'reviewer', 'researcher'].includes(user.role)) {
    return { error: '当前角色无审核权限', status: 403 };
  }
  if (!['approved', 'rejected', 'needs_info'].includes(decision)) {
    return { error: '审核结论应为 approved / rejected / needs_info', status: 400 };
  }
  const id = newId('RVW');
  run(
    `INSERT INTO review_decision (id,object_type,object_id,decision,reviewer,reviewer_role,comment,decided_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [id, objectType, objectId, decision, user.name, user.role, comment || null, nowIso()]
  );

  if (objectType === 'calculation_run') {
    run('UPDATE calculation_run SET audit_status = ?, review_status = ? WHERE id = ?', [decision, decision, objectId]);
  } else if (objectType === 'eligibility_run') {
    run('UPDATE eligibility_run SET review_status = ? WHERE id = ?', [decision, objectId]);
  } else if (objectType === 'report') {
    run('UPDATE report SET status = ? WHERE id = ?', [decision === 'approved' ? 'approved' : 'draft', objectId]);
  }

  audit({
    actor: user.name, actorRole: user.role, action: 'review.decision',
    objectType, objectId, detail: { decision, comment },
  });
  return { ok: true, review_id: id, decision };
}

export function listReports(user, projectId) {
  const project = get('SELECT * FROM project WHERE id = ?', [projectId]);
  if (!project) return { error: '项目不存在', status: 404 };
  if (user.role !== 'admin' && project.team_id !== user.team_id && project.confidentiality !== 'public') {
    return { error: '无权访问该项目报告', status: 403 };
  }
  return all(
    'SELECT id, revision, analysis_base_date, generated_at, generated_by, status, supersedes_id FROM report WHERE project_id = ? ORDER BY revision DESC',
    [projectId]
  );
}

export function listPendingReviews() {
  return {
    calculations: all(
      `SELECT c.id, c.project_id, c.scenario, c.run_at, c.operator, c.status, c.audit_status,
              p.name AS project_name, m.code_display
       FROM calculation_run c
       LEFT JOIN project p ON p.id = c.project_id
       LEFT JOIN methodology_version m ON m.id = c.methodology_version_id
       WHERE c.review_status = 'pending' ORDER BY c.run_at DESC LIMIT 100`
    ),
    eligibility: all(
      `SELECT e.id, e.project_id, e.conclusion, e.run_at, e.operator, e.review_status,
              p.name AS project_name
       FROM eligibility_run e LEFT JOIN project p ON p.id = e.project_id
       WHERE e.review_status = 'pending' ORDER BY e.run_at DESC LIMIT 100`
    ),
    reports: all(
      `SELECT r.id, r.project_id, r.revision, r.generated_at, r.status, p.name AS project_name
       FROM report r LEFT JOIN project p ON p.id = r.project_id
       WHERE r.status = 'draft' ORDER BY r.generated_at DESC LIMIT 100`
    ),
  };
}

export { getCalculationRun };
