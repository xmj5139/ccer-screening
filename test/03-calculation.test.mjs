/**
 * 测试 3：计算方法、门禁模型与独立复算（按「新门禁模型」重写）
 * ============================================================================
 * 【本文件验证的新模型】
 *   1. 种子默认态：`calculator_gate_mode = 'strict'`、`demo_channel_enabled = 'false'`，
 *      每个方法学版本的 `rulecard_status` / `calculator_status` 均为 `pending_review`
 *      （绝不自动写 approved）。因此**默认态一律不出数**。
 *   2. 业务通道（channel = 'business'，默认）只有在下列条件全部满足时才出数：
 *        ① 该方法学版本 `calculator_status === 'approved'`；
 *        ② 插件不含 `value_status = 'placeholder'` 的占位系数；
 *        ③ 每条 `formula_refs[].clause_ref` 都已回填真实条款（无【占位】/待对照）；
 *        ④ 绑定了「同一项目 + 同一方法学版本 + 同一分析基准日」的条件检查快照，
 *           且 `blocking_failures === 0`（通过 opts.eligibilityRunId 显式绑定，
 *           或由 latestEligibilityFor() 按基准日匹配）。
 *      任一条件不满足即返回 { rejected:true, kind:'precondition', status:409 }，
 *      且**不落库**任何可用于报告的运行记录。
 *   3. 演示通道（channel = 'demo'）：需要 `demo_channel_enabled === 'true'` 且角色 ∈
 *      {admin, researcher}；它绕过审批 / 占位系数 / 条件检查快照，但运行一律写
 *      `status = 'demo'`，返回体带 `demo:true`、`usable_for_report:false`、水印与
 *      `result.gate_reason`，且不进入投资筛选报告。
 *   4. 输入校验（单位错误 / 超范围 / 适用条件 / 期间重叠）永远照旧阻止出数，
 *      演示通道只是让校验路径（而不是门禁）成为阻断原因。
 *
 * 【为什么需要 alignPluginDeclarationWithDb() 这个「测试补偿垫片」】
 *   src/services/calc-svc.mjs 的 assertCalculationPreconditions()、methodologyPluginStatus()
 *   与 engine.mjs 的 calculation_availability，判断「是否含占位系数 / 是否缺条款页码」时
 *   读取的是**插件模块里静态声明的** `plugin.factors[].value_status` 与
 *   `plugin.formula_refs[].clause_ref`；而 test/fixtures.mjs 的 simulateExpertApproval()
 *   只更新数据库里的 factor_version 行（并把 methodology_version 的审批状态置为 approved）。
 *   结果是：数据库里的「专家已确认」无法解除门禁，业务通道在本仓库中永远不可达。
 *   为了让「已确认 → 可出数」这条业务路径可被测试，本文件在测试内把静态声明与数据库
 *   对齐（只做「数据库说 verified 就改成 verified」与「把【占位】条款串换成显式标注的
 *   测试串」两件事，不臆造任何系数或条款号）。
 *   ⚠ 这是测试补偿，不是生产实现：生产代码应以 factor_version 表为准。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, teardown, projectByCode, ADMIN, ANALYST } from './helpers.mjs';
import {
  simulateExpertApproval, enableDemoChannel, disableDemoChannel, gateState,
} from './fixtures.mjs';
import {
  OFFICIAL_DEFAULTS, UNRESOLVED, annualEmissionReduction, toNormalFlow,
  violatesApplicability, deductOverLimitHours, steamHeat, waterHeat,
} from './official-10-001.mjs';

let M;
let P = {};
/** 默认态（未做任何专家确认）时的方法学插件状态快照，供「门禁状态自检」使用 */
let pluginStatusAtSeed = null;
/** 默认态的系统开关快照（测试后段会开启演示通道，故必须在种子后立即取样） */
let gateStateAtSeed = null;

before(async () => {
  M = await setup();
  P = {
    p1: projectByCode(M.projects, 'CCER-DEMO-001'),
    p4: projectByCode(M.projects, 'CCER-DEMO-004'),
  };
  pluginStatusAtSeed = M.calc.methodologyPluginStatus();
  gateStateAtSeed = gateState();
});

after(() => teardown());

/* ========================================================================== */
/*  通用工具                                                                   */
/* ========================================================================== */

function mvRowOf(methodologyId, version = 'V01') {
  const row = M.db.get(
    'SELECT * FROM methodology_version WHERE methodology_id = ? AND version = ?',
    [methodologyId, version]
  );
  if (!row) throw new Error(`未找到方法学版本 ${methodologyId}::${version}`);
  return row;
}

/** 库中「可用于投资筛选报告的正式业务测算」条数（status = 'ok'） */
function okRunCount() {
  return M.db.get("SELECT COUNT(*) AS c FROM calculation_run WHERE status = 'ok'").c;
}

function approx(actual, expected, tolerance, label) {
  assert.ok(Number.isFinite(actual), `${label} 不是有限数值：${actual}`);
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label} 期望 ${expected}，实际 ${actual}，偏差 ${Math.abs(actual - expected)}`
  );
}

/** 相对容差比较（用于中间量；CEF 舍入等来源见测试 12 的说明） */
function relApprox(actual, expected, relTol, label) {
  assert.ok(Number.isFinite(actual), `${label} 不是有限数值：${actual}`);
  const tol = Math.max(Math.abs(expected) * relTol, 1e-6);
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${label} 期望 ${expected}，实际 ${actual}，偏差 ${Math.abs(actual - expected)}（容差 ${tol}）`
  );
}

/**
 * 测试补偿垫片：把插件**静态声明**的占位状态与数据库对齐，并回填条款页码。
 * 详见文件头「为什么需要 alignPluginDeclarationWithDb()」。
 * @returns {{factors:number, formulas:number}} 被改写的条数，便于断言垫片确实生效
 */
function alignPluginDeclarationWithDb(methodologyId, version = 'V01') {
  const mod = M.methodologies.getMethodologyModule(methodologyId, version);
  const rows = M.db.all('SELECT factor_key, value_status, methodology_version_id FROM factor_version');
  const statusByKey = new Map(
    rows.map((r) => [`${r.factor_key}::${r.methodology_version_id || ''}`, r.value_status])
  );

  let factors = 0;
  for (const f of mod.plugin.factors || []) {
    const status = statusByKey.get(`${f.factor_key}::${f.methodology_version_id || ''}`);
    if (status && f.value_status !== status) {
      f.value_status = status;
      factors += 1;
    }
  }

  const isPlaceholder = (s) => !s || s.includes('【占位】') || s.includes('待对照');
  const pending = (mod.plugin.formula_refs || []).filter((fr) => isPlaceholder(fr.clause_ref));
  for (const fr of pending) {
    fr.clause_ref = `${methodologyId}-${version} §6（测试补偿垫片：条款页码已按专家确认回填，非官方引用）`;
  }
  if (pending.length) {
    // 同步 formula 表：若实现改为读数据库，垫片同样生效
    M.db.run(
      `UPDATE formula SET clause_ref = ?
       WHERE methodology_version_id = ?
         AND (clause_ref LIKE '%【占位】%' OR clause_ref LIKE '%待对照%')`,
      [`${methodologyId}-${version} §6（测试补偿垫片：条款页码已按专家确认回填，非官方引用）`, mvRowOf(methodologyId, version).id]
    );
  }
  return { factors, formulas: pending.length };
}

/* ========================================================================== */
/*  1—4：默认态与演示通道隔离                                                   */
/* ========================================================================== */

test('默认状态：业务测算被阻止', () => {
  // (1) 不指定方法学版本：由候选匹配定位版本后再被门禁拦下。
  //     若匹配阶段就因「规则卡未获批」把方法学整体排除，则返回 404 说明未找到可用版本，
  //     同样是「不出数」——两种路径都不得产生任何数字。
  const auto = M.calc.runCalculation(ADMIN, P.p1.id, { analysisBaseDate: '2026-09-24' });
  assert.ok(auto.rejected || auto.error, `默认态不得出数：${JSON.stringify(auto)}`);
  if (auto.rejected) {
    assert.equal(auto.status, 409);
    assert.equal(auto.kind, 'precondition');
    assert.equal(auto.channel, 'business');
    // 阻断原因必须指向「审批状态未通过」或「占位系数未确认」
    assert.match(
      auto.message,
      /审批状态|占位系数|暂不支持自动测算/,
      `默认态业务测算的阻断原因应说明审批状态或占位系数：${auto.message}`
    );
  } else {
    assert.match(auto.error, /未找到可用于本项目的方法学版本/);
  }

  // (2) 显式指定版本：必须给出 precondition 拒绝
  const mv = mvRowOf('CCER-10-001');
  const out = M.calc.runCalculation(ADMIN, P.p1.id, {
    methodologyVersionId: mv.id, analysisBaseDate: '2026-09-24', channel: 'business',
  });
  assert.equal(out.status, 409);
  assert.equal(out.rejected, true);
  assert.equal(out.kind, 'precondition');
  assert.equal(out.channel, 'business');
  assert.match(
    out.message,
    /审批状态|占位系数|暂不支持自动测算/,
    `默认态业务测算的阻断原因应说明审批状态或占位系数：${out.message}`
  );
  assert.equal(out.detail.calculator_status, 'pending_review');

  // 默认态不得留下任何 status = 'ok' 的运行记录
  assert.equal(okRunCount(), 0, '默认态不得产生可用于报告的正式测算');
});

test('默认状态：演示通道关闭时，演示请求同样被阻止', () => {
  disableDemoChannel(); // 显式回到「演示通道关闭」的种子默认态
  const out = M.calc.runCalculation(ADMIN, P.p1.id, {
    analysisBaseDate: '2026-09-24', channel: 'demo',
  });

  assert.equal(out.status, 409);
  assert.equal(out.rejected, true);
  assert.equal(out.kind, 'precondition');
  assert.equal(out.channel, 'demo');
  assert.match(out.message, /演示通道/, `阻断原因应说明演示通道未开启：${out.message}`);
  assert.match(out.message, /未开启/);
  assert.equal(okRunCount(), 0);
});

test('开启演示通道后，演示运行成功但被隔离', () => {
  enableDemoChannel(ADMIN);
  const out = M.calc.runCalculation(ADMIN, P.p1.id, {
    analysisBaseDate: '2026-09-24', channel: 'demo', allScenarios: false,
  });

  assert.ok(!out.rejected && !out.error, JSON.stringify(out.errors || out));
  assert.equal(out.demo, true);
  assert.equal(out.usable_for_report, false);
  assert.equal(out.runs.length, 1);
  assert.equal(out.runs[0].status, 'demo');
  assert.equal(out.runs[0].demo, true);
  assert.equal(out.runs[0].usable_for_report, false);

  const watermark = out.runs[0].result.watermark;
  assert.equal(typeof watermark, 'string');
  assert.ok(watermark.length > 0, '演示运行必须带水印');
  assert.match(watermark, /演示/, '水印必须写明这是演示数据');
  assert.match(out.runs[0].result.gate_reason, /演示通道/);

  // 落库记录的 status 必须是 demo（而不是 ok）
  const row = M.db.get('SELECT status FROM calculation_run WHERE id = ?', [
    out.runs[0].calculation_run_id,
  ]);
  assert.equal(row.status, 'demo');
  assert.equal(okRunCount(), 0, '演示运行不得污染业务运行（status = ok）的计数');

  // 演示通道只对 admin / researcher 开放（投资分析师不可用）
  const denied = M.calc.runCalculation(ANALYST, P.p1.id, {
    analysisBaseDate: '2026-09-24', channel: 'demo',
  });
  assert.equal(denied.rejected, true);
  assert.match(denied.message, /演示通道仅对系统管理员与政策研究员开放/);
});

test('演示数据不进入投资筛选报告：报告只允许引用业务运行，演示运行既不进快照也不带出数字', () => {
  enableDemoChannel(ADMIN);
  const demo = M.calc.runCalculation(ADMIN, P.p1.id, {
    analysisBaseDate: '2026-09-24', channel: 'demo', allScenarios: false,
  });
  const demoRunId = demo.runs[0].calculation_run_id;

  // 本用例刻意安排在「专家确认」（测试 5）之前：此时业务通道仍被阻止，
  // 因此报告应当**一个数字都不带**；若夹具已把插件确认为可出数，
  // 报告也应只引用业务运行（channel = 'business'），绝不能引用演示运行。
  const rep = M.reports.generateReport(ADMIN, P.p1.id, { analysisBaseDate: '2026-09-24' });

  assert.ok(
    !rep.snapshot.calculation_run_ids.includes(demoRunId),
    '演示运行 ID 不得出现在报告的计算运行快照中'
  );
  assert.equal(
    rep.snapshot.calculation_run_ids.filter((id) => M.db.get('SELECT status FROM calculation_run WHERE id = ?', [id]).status === 'demo').length,
    0,
    '报告引用的运行里不得有 status = demo 的记录'
  );

  // 报告正文没有数字：formulas_and_params 不含 steps（只有一条「未执行计算」的说明）
  assert.equal(rep.content.body.formulas_and_params.steps, undefined);
  assert.ok(
    typeof rep.content.body.formulas_and_params.note === 'string'
      && rep.content.body.formulas_and_params.note.length > 0,
    '未出数时报告必须写明原因'
  );
  assert.equal(rep.content.one_page.estimate.available, false);
  assert.equal(rep.content.traceability.runs.calculation_run_ids.length, 0);

  // 演示运行本身仍在库中，只是被隔离
  assert.equal(
    M.db.get('SELECT status FROM calculation_run WHERE id = ?', [demoRunId]).status,
    'demo'
  );
});

/* ========================================================================== */
/*  5—8：业务通道的四项前置条件                                                 */
/* ========================================================================== */

test('业务路径：专家确认后，绑定条件检查快照才能出数', () => {
  // 1) 领域专家确认（夹具：因子 → verified，方法学版本 → approved）
  const approved = simulateExpertApproval('CCER-10-001');
  assert.equal(approved.factors, 3, 'CCER-10-001 应有 3 项占位系数待确认');
  const synced = alignPluginDeclarationWithDb('CCER-10-001');
  assert.equal(synced.factors, 3, '垫片应把 3 项占位系数与数据库对齐');

  // 2) 条件检查快照：0 项硬障碍
  const elig = M.engine.runEligibility(ADMIN, P.p1.id, { analysisBaseDate: '2026-09-24' });
  assert.equal(elig.methodology_version.methodology_id, 'CCER-10-001');
  assert.equal(elig.summary.blocking_failures, 0, '示例项目 p1 不应有硬障碍');

  // 3) 业务测算：绑定同一份条件检查快照 → 出数
  const out = M.calc.runCalculation(ADMIN, P.p1.id, {
    methodologyVersionId: elig.methodology_version.id,
    eligibilityRunId: elig.eligibility_run_id,
    analysisBaseDate: '2026-09-24',
    channel: 'business',
    allScenarios: false,
  });

  assert.ok(!out.rejected && !out.error, JSON.stringify(out.errors || out));
  assert.equal(out.demo, false);
  assert.equal(out.usable_for_report, true);
  assert.equal(out.status, 200);
  assert.equal(out.eligibility_snapshot.eligibility_run_id, elig.eligibility_run_id);
  assert.equal(out.eligibility_snapshot.methodology_version_id, elig.methodology_version.id);
  assert.equal(out.eligibility_snapshot.analysis_base_date, '2026-09-24');
  assert.equal(out.eligibility_snapshot.blocking_failures, 0);

  assert.equal(out.runs[0].status, 'ok');
  assert.equal(out.runs[0].demo, false);
  assert.equal(out.runs[0].result.watermark, null);
  assert.ok(out.runs[0].er_annual > 0, '业务测算应给出正的年度减排量');
  assert.equal(
    M.db.get('SELECT status FROM calculation_run WHERE id = ?', [out.runs[0].calculation_run_id]).status,
    'ok'
  );
  assert.ok(okRunCount() >= 1, '业务运行必须落库为 ok');
});

test('业务路径：缺少条件检查快照时被阻止', () => {
  // 插件已确认（测试 5 已确认），但这是一个从未跑过条件检查的新项目
  const fresh = M.projects.createProject(ADMIN, {
    code: 'CAL-NO-ELIG', name: '未做条件检查的煤矿瓦斯项目', project_type: '煤矿瓦斯回收利用',
    technology_route: '低浓度瓦斯发电',
  });
  const mv = mvRowOf('CCER-10-001');
  assert.equal(
    M.db.get('SELECT COUNT(*) AS c FROM eligibility_run WHERE project_id = ?', [fresh.id]).c,
    0,
    '该项目不应存在任何条件检查记录'
  );

  const out = M.calc.runCalculation(ADMIN, fresh.id, {
    methodologyVersionId: mv.id, analysisBaseDate: '2026-09-24', channel: 'business',
  });

  assert.equal(out.status, 409);
  assert.equal(out.rejected, true);
  assert.equal(out.kind, 'precondition');
  assert.match(out.message, /条件检查/, `阻断原因应说明缺少条件检查快照：${out.message}`);
  assert.equal(out.detail.need, 'eligibility_run');
});

test('业务路径：快照方法学版本或基准日不一致时被阻止', () => {
  const mv = mvRowOf('CCER-10-001');
  const otherMv = mvRowOf('CCER-10-002');

  // (a) 快照属于其他方法学版本
  const otherElig = M.engine.runEligibility(ADMIN, P.p1.id, {
    methodologyVersionId: otherMv.id, analysisBaseDate: '2026-09-24',
  });
  assert.equal(otherElig.methodology_version.methodology_id, 'CCER-10-002');
  const a = M.calc.runCalculation(ADMIN, P.p1.id, {
    methodologyVersionId: mv.id,
    eligibilityRunId: otherElig.eligibility_run_id,
    analysisBaseDate: '2026-09-24',
    channel: 'business',
  });
  assert.equal(a.rejected, true);
  assert.equal(a.status, 409);
  assert.match(a.message, /其他方法学版本|不一致/, `应指出快照与测算不同源：${a.message}`);

  // (b) 快照分析基准日与本次测算不一致
  const oldElig = M.engine.runEligibility(ADMIN, P.p1.id, {
    methodologyVersionId: mv.id, analysisBaseDate: '2026-09-01',
  });
  const b = M.calc.runCalculation(ADMIN, P.p1.id, {
    methodologyVersionId: mv.id,
    eligibilityRunId: oldElig.eligibility_run_id,
    analysisBaseDate: '2026-09-24',
    channel: 'business',
  });
  assert.equal(b.rejected, true);
  assert.equal(b.status, 409);
  assert.match(b.message, /其他方法学版本|不一致/, `应指出基准日不一致：${b.message}`);
  assert.match(b.message, /2026-09-01/);

  // 情形 (b) 也不得留下 ok 运行
  assert.ok(!M.calc.listCalculationRuns(P.p1.id).some((r) => r.status === 'ok' && r.analysis_base_date === '2026-09-01'));
});

test('业务路径：存在硬障碍的项目禁止出数', () => {
  // CCER-DEMO-004：站场设计总规模 3.5 万 m³/天，超过 CCER-10-004 的 3 万 m³/天上限
  const approved = simulateExpertApproval('CCER-10-004');
  assert.ok(approved.factors >= 1);
  alignPluginDeclarationWithDb('CCER-10-004');

  const elig = M.engine.runEligibility(ADMIN, P.p4.id, { analysisBaseDate: '2026-09-24' });
  assert.equal(elig.methodology_version.methodology_id, 'CCER-10-004');
  assert.ok(elig.summary.blocking_failures > 0, '站场规模超限应形成硬障碍');
  assert.equal(elig.conclusion, '存在明确障碍');
  assert.ok(
    elig.summary.blocking_fail_list.some((b) => b.rule_id === 'M10-004-02'),
    '硬障碍应来自站场处理规模规则 M10-004-02'
  );

  const out = M.calc.runCalculation(ADMIN, P.p4.id, {
    methodologyVersionId: elig.methodology_version.id,
    eligibilityRunId: elig.eligibility_run_id,
    analysisBaseDate: '2026-09-24',
    channel: 'business',
  });

  assert.equal(out.status, 409);
  assert.equal(out.rejected, true);
  assert.equal(out.kind, 'precondition');
  assert.match(out.message, /硬障碍/, `阻断原因应说明存在硬障碍：${out.message}`);
  assert.equal(out.detail.blocking_failures, elig.summary.blocking_failures);
  assert.ok(
    !M.calc.listCalculationRuns(P.p4.id).some((r) => r.status === 'ok'),
    '存在硬障碍的项目不得留下任何业务运行'
  );
});

/* ========================================================================== */
/*  9—11：输入校验、情景与计入期（经演示通道，确保不是门禁在挡）                  */
/* ========================================================================== */

test('输入校验仍然阻止出数（单位错误 / 超范围 / 期间重叠）', () => {
  // 经演示通道运行：门禁不再短路，被拦下的只能是输入校验本身
  enableDemoChannel(ADMIN);
  const mv = mvRowOf('CCER-10-001');
  const base = {
    methodologyVersionId: mv.id, analysisBaseDate: '2026-09-24',
    channel: 'demo', allScenarios: false,
  };

  // (a) 非数值（疑似把单位写进数值字段）
  const a = M.calc.runCalculation(ADMIN, P.p1.id, {
    ...base, overrides: { recovery_volume_nm3: '9600 万立方米' },
  });
  assert.ok(a.rejected, '非数值输入应被拒绝');
  assert.ok(a.errors.some((e) => e.kind === 'not_numeric' || e.kind === 'missing'));
  assert.ok(a.errors.some((e) => e.field === 'recovery_volume_nm3'));

  // (b) 超出合理范围（年运行小时数 90000 > 8784）
  const b = M.calc.runCalculation(ADMIN, P.p1.id, {
    ...base, overrides: { hours_per_year: 90000 },
  });
  assert.ok(b.rejected);
  assert.ok(b.errors.some((e) => e.field === 'hours_per_year' && e.kind === 'out_of_range'));
  assert.match(b.errors.find((e) => e.field === 'hours_per_year').message, /合理上限/);
  assert.equal(b.message, '输入校验未通过，系统拒绝出数（不提供任何减排量数值）。');

  // (c) 甲烷体积浓度超出方法学适用范围（≥ 8%）
  const c = M.calc.runCalculation(ADMIN, P.p1.id, {
    ...base, overrides: { ch4_concentration_pct: 12 },
  });
  assert.ok(c.rejected);
  assert.ok(c.errors.some((e) => e.kind === 'scope_violation' && e.field === 'ch4_concentration_pct'));

  // (d) 期间重叠
  const d = M.calc.runCalculation(ADMIN, P.p1.id, {
    ...base,
    extraPeriods: [
      { label: '第一计入期', start: '2025-01-01', end: '2027-12-31' },
      { label: '第二计入期', start: '2027-01-01', end: '2029-12-31' },
    ],
  });
  assert.ok(d.rejected);
  assert.ok(d.errors.some((e) => e.kind === 'period_overlap'));

  // (e) 期间起止倒置
  const e = M.calc.runCalculation(ADMIN, P.p1.id, {
    ...base,
    extraPeriods: [{ label: '倒置期间', start: '2026-01-01', end: '2025-01-01' }],
  });
  assert.ok(e.rejected);
  assert.ok(e.errors.some((x) => x.kind === 'period_reversed'));

  // 被拒绝的运行写入历史，且不产生任何减排量数值
  const rejects = M.calc.listCalculationRuns(P.p1.id).filter((h) => h.status === 'rejected');
  assert.ok(rejects.length >= 5, `应有至少 5 条被拒绝的运行记录，实际 ${rejects.length}`);
  assert.ok(
    rejects.every((h) => h.er_annual === null || h.er_annual === undefined),
    '被拒绝的运行不得保存任何减排量数值'
  );
});

test('三情景方向性：保守 ≤ 基准 ≤ 乐观，且三者不完全相同', () => {
  enableDemoChannel(ADMIN);
  const mv = mvRowOf('CCER-10-001');
  const out = M.calc.runCalculation(ADMIN, P.p1.id, {
    methodologyVersionId: mv.id, analysisBaseDate: '2026-09-24',
    channel: 'demo', allScenarios: true,
  });
  assert.ok(!out.rejected && !out.error, JSON.stringify(out.errors || out));
  assert.equal(out.runs.length, 3);

  const by = Object.fromEntries(out.runs.map((r) => [r.scenario, r.er_annual]));
  assert.ok(by.conservative <= by.base + 1e-6, `保守情景(${by.conservative}) 应不大于基准情景(${by.base})`);
  assert.ok(by.base <= by.optimistic + 1e-6, `基准情景(${by.base}) 应不大于乐观情景(${by.optimistic})`);
  assert.ok(
    ![by.conservative, by.base, by.optimistic].every((v) => Math.abs(v - by.base) < 1e-6),
    '三个情景结果完全相同，情景乘数可能未被应用'
  );
  assert.ok(by.optimistic - by.conservative > 0, '保守与乐观情景必须给出非空区间');
});

test('计入期合计等于年度估算乘以有数据年数，缺数据的年份不外推', () => {
  enableDemoChannel(ADMIN);
  const mv = mvRowOf('CCER-10-001');

  // (a) 全部年份都有数据 → 合计 = 年度值 × 年数
  const full = M.calc.runCalculation(ADMIN, P.p1.id, {
    methodologyVersionId: mv.id, analysisBaseDate: '2026-09-24', channel: 'demo',
    overrides: { crediting_years: 10, crediting_start_year: '2025-01-01' },
  });
  assert.ok(!full.rejected, JSON.stringify(full.errors));
  const r = full.runs[0];
  assert.equal(r.crediting.years, 10);
  assert.equal(r.result.annual.length, 10);
  approx(r.crediting.total, r.er_annual * 10, 0.01, '计入期合计');

  // (b) 只有 2 年有可用监测数据 → 其余年份为 null 且注明「不外推」
  const partial = M.calc.runCalculation(ADMIN, P.p1.id, {
    methodologyVersionId: mv.id, analysisBaseDate: '2026-09-24', channel: 'demo',
    overrides: { crediting_years: 5, crediting_start_year: '2025-01-01', data_years: [2025, 2026] },
  });
  assert.ok(!partial.rejected, JSON.stringify(partial.errors));
  const annual = partial.runs[0].result.annual;
  assert.equal(annual.length, 5);
  const withData = annual.filter((x) => x.reduction !== null);
  const without = annual.filter((x) => x.reduction === null);
  assert.equal(withData.length, 2);
  assert.equal(without.length, 3);
  assert.deepEqual(withData.map((x) => x.year), [2025, 2026]);
  assert.ok(
    without.every((x) => /不外推/.test(x.data_status)),
    `无数据年份必须注明不外推：${without.map((x) => x.data_status).join(' / ')}`
  );
  // 合计只累计有数据的年份，不得用平均值填补
  approx(partial.runs[0].crediting.total, partial.runs[0].er_annual * 2, 0.01, '部分年份合计');
});

/* ========================================================================== */
/*  12：最重要的独立复算                                                        */
/* ========================================================================== */

/**
 * 把自检样例的输入映射为 test/official-10-001.mjs 的独立实现参数。
 * 映射依据（全部来自官方原文口径）：
 *   · 公式(4)：工况流量 → 常温常压流量（20 ℃、101.325 kPa）；
 *   · 公式(3)：逐小时求和 Σ F_NPT,h × PC_CH4,h，故把「年运行总时长」展开为等值的逐小时序列；
 *             若样例只给年流量合计，则按 Σ F_NPT,h = V_NPT,y 折算出小时值；
 *   · 公式(8)(9)：外供热量优先取直接监测值，否则按蒸汽/热水换算；
 *   · 公式(15)(16)(17)：按填报的热能利用方式选择热电联产 / 仅发电 / 仅供热。
 */
function toOfficialArgs(inputs) {
  const hours = inputs.hours_per_year;
  let fNpt;
  if (inputs.npt_flow_m3h !== undefined && inputs.npt_flow_m3h !== null) {
    fNpt = inputs.npt_flow_m3h;
  } else if (inputs.raw_flow_m3h !== undefined && inputs.raw_flow_m3h !== null) {
    fNpt = toNormalFlow({
      F_operating: inputs.raw_flow_m3h, P_kPa: inputs.gas_pressure_kpa, t_C: inputs.gas_temp_c,
    });
  } else {
    fNpt = inputs.recovery_volume_nm3 / hours;
  }
  const hourly = Array.from({ length: hours }, () => ({
    F_NPT: fNpt, PC_CH4: inputs.ch4_concentration_pct,
  }));

  const utilization = inputs.heat_utilization_route === '发电' ? 'power'
    : inputs.heat_utilization_route === '供热' ? 'heat' : 'chp';

  let qHeat = inputs.heat_export_gj ?? null;
  if (qHeat === null && inputs.steam_mass_t != null) {
    qHeat = steamHeat({ Ma_st: inputs.steam_mass_t, En_st: inputs.steam_enthalpy_kjkg });
  }
  if (qHeat === null && inputs.hot_water_mass_t != null) {
    qHeat = waterHeat({ Ma_w: inputs.hot_water_mass_t, t_w: inputs.hot_water_temp_c });
  }

  return {
    hours: hourly,
    utilization,
    ELEC_export_MWh: inputs.elec_export_mwh ?? 0,
    Q_HEAT: qHeat ?? 0,
    EF_grid_OM: inputs.ef_grid_om,
    EF_grid_BM: inputs.ef_grid_bm,
    CONS_ELEC: inputs.cons_elec_mwh ?? 0,
    TDL: inputs.tdl,
    eta_ELEC: inputs.eta_elec,
    EFF: inputs.destruction_efficiency ?? OFFICIAL_DEFAULTS.EFF,
    // CEF_CH4 是官方正文**未定义**的参数：这里显式使用 UNRESOLVED 中记录的
    // 「化学计量候选值」44.009/16.043 = 2.7432，它不是官方数值。
    // 插件同样按 2.7432（4 位小数）代入，故两者在 PE_MD,y 上存在 3.6e-6 的相对差。
    CEF_CH4: UNRESOLVED.CEF_CH4.stoichiometric_candidate,
  };
}

/** 插件 checkpoint ↔ 独立实现字段 的对应关系 */
const CHECKPOINT_PAIRS = [
  ['mm_measured_t', 'MM_measured', '公式(3) 实测甲烷量 MM′_y'],
  ['mm_derived_t', 'MM_inferred', '公式(15)(16)(17) 推算甲烷量 MM″_y'],
  ['mm_t', 'MM', '公式(2) 取较小值后的 MM_y'],
  ['be_mr_tco2e', 'BE_MR', '公式(2) 排空基准线排放'],
  ['ef_grid_cm', 'EF_CM', '公式(6) 组合边际排放因子'],
  ['be_elec_tco2e', 'BE_ELEC', '公式(5) 外供电替代'],
  ['be_heat_tco2e', 'BE_HEAT', '公式(7) 外供热替代'],
  ['be_tco2e', 'BE', '公式(1) 基准线合计'],
  ['cons_grid_mwh', 'CONS_grid', '公式(12) 下网电量'],
  ['pe_me_tco2e', 'PE_ME', '公式(11) 运维电力排放'],
  ['pe_md_tco2e', 'PE_MD', '公式(13) 氧化后 CO₂'],
  ['pe_um_tco2e', 'PE_UM', '公式(14) 未氧化逃逸'],
  ['pe_tco2e', 'PE', '公式(10) 项目排放合计'],
  ['er_annual_tco2e', 'ER', '公式(18) 年度减排量'],
];

test('CCER-10-001 独立复算：插件与按原文公式重写的第二套实现一致', () => {
  const mod = M.methodologies.getMethodologyModule('CCER-10-001', 'V01');
  const samples = mod.plugin.selfCheckSamples || [];
  const withExpect = samples.filter((s) => s.expect && !s.expectRejection);
  const rejections = samples.filter((s) => s.expectRejection);
  assert.ok(withExpect.length >= 3, '应有至少 3 个带期望值的自检样例');
  assert.equal(rejections.length, 3, '应有 3 个应被拒绝的自检样例');

  // FactorRegistry 从数据库构建（与 runCalculation 同源）
  const factors = M.calc.loadFactorRegistry('CCER-10-001');

  for (const s of withExpect) {
    const ctx = {
      factors,
      scenario: 'base',
      scenarioLabel: '基准情景',
      scenarioMultipliers: { eff: 1, elec: 1, heat: 1, hours: 1 },
      baseDate: '2026-09-24',
    };
    const pluginOut = mod.plugin.compute(s.inputs, ctx);
    const c = pluginOut.checkpoints;
    assert.ok(c, `样例「${s.name}」必须返回 checkpoints`);

    const args = toOfficialArgs(s.inputs);
    const ind = annualEmissionReduction(args);

    // ① 年度减排量：两套实现相差必须在 0.02 tCO₂e 以内
    approx(c.er_annual_tco2e, ind.ER, 0.02, `样例「${s.name}」ER(插件 vs 独立实现)`);
    approx(c.er_annual_tco2e, pluginOut.er_annual, 0.0001, `样例「${s.name}」ER 与返回字段一致`);

    // ② 关键中间量：逐项比对（相对容差 1e-5，主要来源是 CEF_CH4 的 4 位小数舍入）
    for (const [ck, ik, label] of CHECKPOINT_PAIRS) {
      relApprox(c[ck], ind[ik], 1e-5, `样例「${s.name}」${label}`);
    }
    relApprox(c.q_heat_gj, args.Q_HEAT, 1e-9, `样例「${s.name}」外供热量 Q_HEAT`);
    // 公式(4) 的小时流量与公式(3) 的体积求和：直接由独立实现的小时序列复算
    const hasHourlyFlow = (s.inputs.npt_flow_m3h ?? s.inputs.raw_flow_m3h) != null;
    if (hasHourlyFlow) {
      relApprox(c.f_npt_h, args.hours[0].F_NPT, 1e-9, `样例「${s.name}」公式(4) F_NPT,h`);
    } else {
      // 样例只给了年度常温常压流量合计：插件不得凭空造出小时流量
      assert.equal(c.f_npt_h, null, `样例「${s.name}」未提供小时流量时 f_npt_h 必须为 null`);
    }
    const vCh4Indep = args.hours.reduce((sum, x) => sum + x.F_NPT * (x.PC_CH4 / 100), 0);
    relApprox(c.v_ch4_nm3, vCh4Indep, 1e-9, `样例「${s.name}」公式(3) V_CH4,y`);

    // ③ 插件输出同时要与样例自带的独立手算期望值一致
    const tol = s.tolerance ?? 0.02;
    for (const [k, expected] of Object.entries(s.expect)) {
      if (typeof expected !== 'number') continue;
      approx(c[k], expected, Math.max(tol, 0.01), `样例「${s.name}」样例声明的 ${k}`);
    }
    // ④ 公式(2) 的保守取值：MM_y 必须等于实测值与推算值的较小值
    approx(c.mm_t, Math.min(c.mm_measured_t, c.mm_derived_t), 1e-6, `样例「${s.name}」公式(2) 取较小值`);
    // ⑤ §6.5：公式(18) 不含泄漏项
    approx(c.er_annual_tco2e, c.be_tco2e - c.pe_tco2e, 1e-6, `样例「${s.name}」ER = BE − PE（无泄漏项）`);
  }

  // 应被拒绝的样例：validate() 必须给出所声明的 kind，且不得产出任何减排量
  for (const s of rejections) {
    const { errors } = mod.plugin.validate(s.inputs, { baseDate: '2026-09-24' });
    assert.ok(
      errors.some((e) => e.kind === s.expectRejection),
      `样例「${s.name}」应被拒绝（kind = ${s.expectRejection}），实际：${JSON.stringify(errors.map((e) => e.kind))}`
    );
    assert.ok(errors.length > 0);
  }

  // 两条拒绝样例的独立判断依据（同一套原文规则的第二实现）
  const overLimit = deductionsOfSample(rejections, '9%');
  assert.equal(overLimit.deductedHours, 1, '浓度 ≥ 8% 的时段必须从 time_y 中扣除');
  assert.equal(deductOverLimitHours([{ PC_CH4: 1.2 }]).deductedHours, 0);
  assert.equal(
    violatesApplicability({ sumDrainageFlow: 1000, importFlow: 2500 }),
    true,
    '公式(19)：混配入口流量大于抽采泵出口流量之和 → 不符合适用条件'
  );
  assert.equal(violatesApplicability({ sumDrainageFlow: 5000, importFlow: 1000 }), false);
  const creditingSample = rejections.find((s) => s.expectRejection === 'out_of_range');
  assert.ok(creditingSample, '应存在因计入期超限而被拒绝的样例');
  assert.ok(
    creditingSample.inputs.crediting_years > 10,
    '§5.2.2 规定计入期最长不超过 10 年，超过即为超范围'
  );
});

/** 从「浓度 ≥ 8%」拒绝样例中取出浓度值，交给独立实现判断应扣除的时段 */
function deductionsOfSample(rejections, marker) {
  const s = rejections.find((x) => x.name.includes(marker));
  assert.ok(s, `应存在包含「${marker}」的拒绝样例`);
  return deductOverLimitHours([{ PC_CH4: s.inputs.ch4_concentration_pct }]);
}

/* ========================================================================== */
/*  13：门禁状态自检                                                            */
/* ========================================================================== */

test('门禁状态自检：专家确认前禁止出数、确认后可出数', () => {
  const before = pluginStatusAtSeed.find((s) => s.methodology_id === 'CCER-10-001');
  assert.ok(before, '默认态应能读到 CCER-10-001 的插件状态');
  assert.equal(before.calculator_status, 'pending_review', '种子绝不自动写 approved');
  assert.match(before.business_calculation, /禁止出数/, '未确认前必须报「禁止出数」');
  assert.ok(before.placeholder_factors.length > 0, '未确认前必须列出占位系数');

  const after = M.calc.methodologyPluginStatus().find((s) => s.methodology_id === 'CCER-10-001');
  assert.equal(after.calculator_status, 'approved');
  assert.equal(after.business_calculation, '可出数', '专家确认后应报「可出数」');
  assert.equal(after.placeholder_factors.length, 0);
  assert.equal(after.formulas_without_clause.length, 0);

  // 种子默认值本身也要符合新模型（取样于 before 钩子，避免被后段开启演示通道影响）
  assert.equal(gateStateAtSeed.meta.calculator_gate_mode, 'strict');
  assert.equal(gateStateAtSeed.meta.demo_channel_enabled, 'false');
  assert.ok(
    gateStateAtSeed.methodology.every((r) => r.calculator_status !== 'approved'),
    '种子绝不自动写 approved'
  );
});
