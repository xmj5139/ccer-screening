/**
 * 判断引擎：候选方法学匹配 + 申报条件检查
 * ============================================================================
 * 对应设计文档第 6 节「申报条件与匹配逻辑」三层结构：
 *   第一层：通用门槛（layer = 'common'）
 *   第二层：专属适用条件（layer = 'specific'）
 *   第三层：冲突与重复（layer = 'conflict'，只标记不自动判不合格）
 *
 * 关键纪律：
 *   - 只有「正式有效 + 编号可核对 + 规则卡已获批」的版本才可列为可申报候选
 *   - 草案（含修订征求意见稿）只作观察项
 *   - 匹配分数仅用于排序，不代表申报成功概率
 *   - 结论只输出四态枚举，不输出笼统的「符合申报」
 */
import { all, get, run, getMeta } from '../core/db.mjs';
import { FactStore, evaluateRule, summarize, conclude, PASS, FAIL, UNKNOWN } from '../rules/engine.mjs';
import { toIsoDate, j, uj, nowIso } from '../core/util.mjs';
import { getMethodologyModule } from '../methodologies/index.mjs';
import { loadVerificationState } from './verification.mjs';
import {
  loadFactData, buildGapList, saveMatchRun, saveEligibilityRun, requireProjectAccess,
} from './project-svc.mjs';

export const CONCLUSION = {
  GO: '可继续尽调',
  BLOCKED: '存在明确障碍',
  INSUFFICIENT: '资料不足暂无法判断',
  NO_METHODOLOGY: '无已发布适用方法学',
};

export function listMethodologyVersions() {
  return all('SELECT * FROM methodology_version ORDER BY methodology_id, version').map((m) => ({
    ...m,
    project_types: uj(m.project_types, []),
    tech_routes: uj(m.tech_routes, []),
  }));
}

function methodologyVersionById(id) {
  const m = get('SELECT * FROM methodology_version WHERE id = ?', [id]);
  if (!m) return null;
  return { ...m, project_types: uj(m.project_types, []), tech_routes: uj(m.tech_routes, []) };
}

function resolveBaseDate(input) {
  return toIsoDate(input);
}

/* ========================================================================== */
/*  第一、二、三层：候选方法学匹配                                             */
/* ========================================================================== */

export function runMatch(user, projectId, opts = {}) {
  const access = requireProjectAccess(user, projectId, { needManage: true });
  if (access.error) return access;
  const project = access.project;

  const analysisBaseDate = resolveBaseDate(opts.analysisBaseDate);
  const versions = listMethodologyVersions();
  const { facts, evidenceById } = loadFactData(projectId);
  const store = new FactStore(facts, evidenceById);

  const projectType = project.project_type || store.value('proj.project_type');
  const techRoute = project.technology_route || store.value('proj.technology_route');

  const candidates = [];
  const observations = [];
  const excluded = [];

  for (const mv of versions) {
    const typeHit = !!projectType && mv.project_types.includes(projectType);

    // 草案 / 已废止：只作观察项
    if (mv.document_status !== 'formal') {
      if (typeHit) {
        observations.push({
          methodology_version_id: mv.id,
          methodology_id: mv.methodology_id,
          code_display: mv.code_display,
          name: mv.name,
          document_status: mv.document_status,
          reason:
            mv.document_status === 'revised_draft'
              ? '修订征求意见稿：仅作变更跟踪，不得列为可申报候选，不得用于计算。'
              : mv.document_status === 'draft'
                ? '征求意见稿：仅作观察项。'
                : '已废止版本：不得用于申报与计算。',
          effective_date: mv.effective_date,
          supersedes_id: mv.supersedes_id,
        });
      }
      continue;
    }

    if (!typeHit) {
      excluded.push({
        methodology_version_id: mv.id,
        code_display: mv.code_display,
        name: mv.name,
        reason_code: 'project_type_mismatch',
        reason: `项目类型「${projectType || '未填写'}」不在该方法学支持范围（${mv.project_types.join('、') || '未标注'}）内。`,
      });
      continue;
    }

    if (!mv.is_candidate_eligible) {
      excluded.push({
        methodology_version_id: mv.id,
        code_display: mv.code_display,
        name: mv.name,
        reason_code: 'catalog_confidence',
        reason: mv.exclusion_note || '方法学编号未从官方发布通知核实，系统不将其列为可申报候选。',
      });
      continue;
    }

    // 规则卡"存在"即可执行条件检查（判断依据可追溯到官方原文）；
    // 但规则卡是否已通过领域专家审批，通过 review_caveat 显式传递给界面与报告，
    // 避免把"结构已建"说成"已完成条件检查"。业务测算另有更严的门槛（见 calc-svc）。
    if (mv.rulecard_status === 'none') {
      excluded.push({
        methodology_version_id: mv.id,
        code_display: mv.code_display,
        name: mv.name,
        reason_code: 'rulecard_missing',
        reason: '规则卡尚未建立：可供检索，但不显示为「已完成条件检查」，也无法执行申报条件检查。',
      });
      continue;
    }

    candidates.push({ mv, score: scoreCandidate(mv, { project, store, techRoute, projectType, facts }) });
  }

  candidates.sort((a, b) => b.score.total - a.score.total);

  const gapList = projectType && candidates.length
    ? buildGapList(candidates[0].mv.methodology_id, facts)
    : buildGapList('__NONE__', facts);

  const unknownFields = [];
  const seen = new Set();
  for (const f of facts) {
    const u = store.usable(f.field_key, 'strict');
    if (!u.usable) {
      const k = `${f.field_key}|${u.reason}`;
      if (!seen.has(k)) {
        seen.add(k);
        unknownFields.push({ field_key: f.field_key, value: store.value(f.field_key), source_kind: f.source_kind, reason: u.reason });
      }
    }
  }

  const result = {
    project_id: projectId,
    project_name: project.name,
    project_type: projectType,
    technology_route: techRoute,
    analysis_base_date: analysisBaseDate,
    run_at: nowIso(),
    candidates: candidates.map((c) => ({
      methodology_version_id: c.mv.id,
      methodology_id: c.mv.methodology_id,
      code_display: c.mv.code_display,
      name: c.mv.name,
      version: c.mv.version,
      document_status: c.mv.document_status,
      effective_date: c.mv.effective_date,
      official_url: c.mv.official_url,
      rulecard_status: c.mv.rulecard_status,
      rulecard_review_caveat:
        c.mv.rulecard_status === 'approved'
          ? null
          : `规则卡审批状态为「${c.mv.rulecard_status}」，尚未通过领域专家复核。` +
            '本方法学的适用条件与判断规则可执行，但结果不得表述为「已完成条件检查」，' +
            '须在管理后台完成审批并记录审批人后方可正式引用。',
      calculator_status: c.mv.calculator_status,
      scale_note: c.mv.scale_note,
      score: c.score.total,
      score_breakdown: c.score.breakdown,
    })),
    observations,
    excluded,
    unknown_fields: unknownFields,
    gap_list: gapList,
    scoring_note: '匹配分数仅用于候选排序，不代表申报成功概率，也不构成「符合申报」的结论。',
  };

  const runId = saveMatchRun(user, projectId, analysisBaseDate, result);
  return { ...result, match_run_id: runId, status: 200 };
}

function scoreCandidate(mv, { project, store, techRoute, projectType, facts }) {
  const breakdown = [];
  let total = 0;

  breakdown.push({ item: '项目类型精确匹配', points: 50 });
  total += 50;

  let routeHit = false;
  if (techRoute && mv.tech_routes?.length) {
    routeHit = mv.tech_routes.some((r) => String(techRoute).includes(r) || r.includes(String(techRoute)));
  }
  if (routeHit) {
    breakdown.push({ item: `技术路线命中（${techRoute}）`, points: 25 });
    total += 25;
  } else if (techRoute) {
    breakdown.push({ item: `技术路线未在方法学标注路线中命中（${techRoute}）`, points: 0 });
  }

  // 规模适用性启发式提示（不参与硬判断，仅提示人工核对）
  const scaleNote = mv.scale_note || '';
  let scaleHint = 0;
  const scaleKeyword = scaleNote.match(/([0-9.]+)\s*(万)?\s*(立方米|m³|米|公里|km)/);
  if (scaleKeyword) {
    scaleHint = 5;
    breakdown.push({
      item: '方法学含规模/边界量化条件，需人工核对设计文件',
      points: scaleHint,
    });
    total += scaleHint;
  }

  // 专属必填字段完整度（最高 15 分）
  const required = facts.filter((f) => true).map((f) => f.field_key);
  const specificRequired = allFieldsRequiredFor(mv.methodology_id);
  const have = new Set(required);
  const hit = specificRequired.filter((k) => have.has(k)).length;
  const completeness = specificRequired.length ? Math.round((hit / specificRequired.length) * 15) : 15;
  breakdown.push({
    item: `方法学专属必填字段完整度（${hit}/${specificRequired.length}）`,
    points: completeness,
  });
  total += completeness;

  void store;
  void projectType;
  return { total, breakdown };
}

function allFieldsRequiredFor(methodologyId) {
  // 从 fact_field 表读取，避免与前端字典重复维护
  const rows = all('SELECT key, required_for FROM fact_field');
  return rows
    .filter((r) => {
      const req = uj(r.required_for, []);
      return req.includes(methodologyId);
    })
    .map((r) => r.key);
}

/* ========================================================================== */
/*  申报条件检查                                                               */
/* ========================================================================== */

export function runEligibility(user, projectId, opts = {}) {
  const access = requireProjectAccess(user, projectId, { needManage: true });
  if (access.error) return access;
  const project = access.project;

  const analysisBaseDate = resolveBaseDate(opts.analysisBaseDate);
  const { facts, evidenceById } = loadFactData(projectId);
  const store = new FactStore(facts, evidenceById);

  // 选定方法学版本
  let mv = opts.methodologyVersionId ? methodologyVersionById(opts.methodologyVersionId) : null;
  let matchResult = null;

  if (!mv) {
    matchResult = runMatch(user, projectId, { analysisBaseDate });
    if (matchResult.candidates?.length) {
      mv = methodologyVersionById(matchResult.candidates[0].methodology_version_id);
    }
  }

  const hasFormalCandidate = !!mv;

  // 规则集合：通用门槛 + 冲突标记 + 专属条件
  const commonRules = all(
    `SELECT * FROM rule WHERE methodology_version_id IS NULL ORDER BY sort_order`
  );
  const specificRules = mv
    ? all('SELECT * FROM rule WHERE methodology_version_id = ? ORDER BY sort_order', [mv.id])
    : [];

  const results = [];
  for (const r of [...commonRules, ...specificRules]) {
    results.push(evaluateRule(r, store, { baseDate: analysisBaseDate }));
  }

  const s = summarize(results);
  const finalConclusion = conclude(s, { hasFormalCandidate });

  // 方法学专属层与通用层分开呈现
  const layers = {
    common: results.filter((r) => r.layer === 'common'),
    specific: results.filter((r) => r.layer === 'specific'),
    conflict: results.filter((r) => r.layer === 'conflict'),
  };

  // 数据缺口与最小补充材料清单
  const gapList = buildGapList(mv ? mv.methodology_id : '__NONE__', facts);
  const blockedFields = new Set();
  for (const r of results) {
    if (r.state === UNKNOWN) r.missing_fields.forEach((f) => blockedFields.add(f));
  }
  const priorityGaps = gapList
    .filter((g) => blockedFields.has(g.field_key) || g.evidence_policy === 'strict')
    .slice(0, 10);

  // 计算能力提示：业务出数需要插件已审批通过、无占位系数、条款页码齐全
  let calculationAvailability;
  if (!mv) {
    calculationAvailability = { available: false, channel: 'business', reason: '无已发布适用方法学，不提供测算。' };
  } else {
    const mod = getMethodologyModule(mv.methodology_id, mv.version);
    // 确认状态以数据库为准（与 calc-svc.loadVerificationState 同一判据），
    // 不读插件模块的静态声明，否则管理后台的审批无法生效。
    const { placeholders, pendingClauses: pendingClause } = loadVerificationState(
      mv.methodology_id, mv.version
    );
    const demoEnabled = (getMeta(null, 'demo_channel_enabled') || 'false') === 'true';
    const blockers = [];
    if (!mod?.plugin) blockers.push('尚未注册计算插件');
    if (mv.calculator_status !== 'approved') blockers.push(`计算插件审批状态为「${mv.calculator_status}」`);
    if (placeholders.length) blockers.push(`含 ${placeholders.length} 项未确认的占位系数`);
    if (pendingClause.length) blockers.push(`有 ${pendingClause.length} 条公式未回填原文条款页码`);
    if (blockers.length) {
      calculationAvailability = {
        available: false,
        channel: 'business',
        demo_channel_available: demoEnabled,
        blockers,
        reason:
          '**暂不支持自动测算。** 业务出数被阻止：' + blockers.join('；') + '。' +
          (demoEnabled
            ? '如需流程演示，可由管理员或政策研究员使用「演示通道」做反事实推演。'
            : '演示通道当前未开启。'),
      };
    } else {
      const eligOk = s.blocking_failures === 0;
      calculationAvailability = {
        available: eligOk,
        channel: 'business',
        demo_channel_available: demoEnabled,
        blockers: eligOk ? [] : ['条件检查存在硬障碍'],
        reason: eligOk
          ? '条件检查无硬障碍，且插件已通过审批，可执行正式业务测算（结果绑定本次条件检查快照）。'
          : '条件检查存在硬障碍，禁止形成可用于筛选报告的减排量数字。',
      };
    }
  }

  const summaryText = buildSummaryText({
    project, mv, conclusion: finalConclusion, s, layers, priorityGaps,
  });

  const result = {
    project_id: projectId,
    project_name: project.name,
    analysis_base_date: analysisBaseDate,
    run_at: nowIso(),
    operator: user.name,
    methodology_version: mv
      ? {
          id: mv.id, methodology_id: mv.methodology_id, code_display: mv.code_display,
          name: mv.name, version: mv.version, document_status: mv.document_status,
          effective_date: mv.effective_date, official_url: mv.official_url,
          rulecard_status: mv.rulecard_status, calculator_status: mv.calculator_status,
          // 规则卡未经审批时，条件检查结果不得表述为「已完成条件检查」
          review_caveat:
            mv.rulecard_status === 'approved'
              ? null
              : `规则卡审批状态为「${mv.rulecard_status}」。判断依据来自官方原文且可追溯，` +
                '但尚未经领域专家复核签字，本结果仅供内部参考，不得对外表述为「已完成条件检查」。',
        }
      : null,
    conclusion: finalConclusion,
    summary: s,
    layers,
    gap_list: gapList,
    priority_gaps: priorityGaps,
    calculation_availability: calculationAvailability,
    match_snapshot: matchResult
      ? {
          match_run_id: matchResult.match_run_id,
          candidates: matchResult.candidates,
          observations: matchResult.observations,
          excluded: matchResult.excluded,
        }
      : null,
    summary_text: summaryText,
    disclaimer:
      '本结论为筛选辅助判断，供分析师复核；不替代项目业主、审定与核查机构、注册登记机构的工作，不代表申报成功概率。',
  };

  const runId = saveEligibilityRun(
    user, projectId, mv ? mv.id : null, analysisBaseDate, finalConclusion, summaryText, result
  );

  return { ...result, eligibility_run_id: runId, match_run_id: matchResult?.match_run_id || null, status: 200 };
}

function buildSummaryText({ project, mv, conclusion, s, layers, priorityGaps }) {
  const lines = [];
  lines.push(`项目「${project.name}」在本次分析基准日的筛选结论为：**${conclusion}**。`);
  if (mv) {
    lines.push(`采用候选方法学：${mv.code_display || mv.methodology_id} ${mv.name}（${mv.document_status === 'formal' ? '正式发布' : '草案'}）。`);
  } else {
    lines.push('未检索到可用于申报的正式发布方法学，因此不进行条件检查与测算。');
  }
  lines.push(
    `通用门槛：通过 ${layers.common.filter((r) => r.state === PASS).length} 项，` +
    `不通过 ${layers.common.filter((r) => r.state === FAIL).length} 项，` +
    `待核实 ${layers.common.filter((r) => r.state === UNKNOWN).length} 项。`
  );
  if (layers.specific.length) {
    lines.push(
      `专属条件：通过 ${layers.specific.filter((r) => r.state === PASS).length} 项，` +
      `不通过 ${layers.specific.filter((r) => r.state === FAIL).length} 项，` +
      `待核实 ${layers.specific.filter((r) => r.state === UNKNOWN).length} 项。`
    );
  }
  const conflictFlags = layers.conflict.filter((r) => r.state === FAIL);
  if (conflictFlags.length) {
    lines.push(`冲突与重复提示 ${conflictFlags.length} 项，须人工核对环境权益归属（不自动判不合格）。`);
  }
  if (s.blocking_fail_list.length) {
    lines.push('硬障碍：' + s.blocking_fail_list.map((x) => `${x.rule_id} ${x.title}`).join('；') + '。');
  }
  if (priorityGaps.length) {
    lines.push('优先补充证据（前 ' + Math.min(5, priorityGaps.length) + ' 项）：' +
      priorityGaps.slice(0, 5).map((g) => g.label).join('、') + '。');
  }
  return lines.join('\n');
}

export function eligibilityHistory(projectId) {
  return all(
    `SELECT id, analysis_base_date, run_at, operator, conclusion, review_status, summary
     FROM eligibility_run WHERE project_id = ? ORDER BY run_at DESC`,
    [projectId]
  ).map((r) => ({ ...r }));
}

export { j, uj, methodologyVersionById };
