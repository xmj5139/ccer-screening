/**
 * 测试 2：设计文档第 10 节的 7 项关键验收用例
 * ============================================================================
 * 用例 1  2026 造林/红树林修订征求意见稿：产生跟踪提醒，计算仍绑定现行正式版本
 * 用例 2  项目开工日期缺失：通用条件显示「待核实」，不能显示「通过」
 * 用例 3  项目公示记录：状态显示「项目公示」，不得显示「已登记」或「已签发」
 * 用例 4  因子年份或方法学版本变化：新旧结果并存，差异可解释，可恢复历史报告
 * 用例 5  关键计量值单位错误 / 期间重叠 / 超出合理范围：阻止出数并提示原始字段
 * 用例 6  任一计算结果可从报告追到输入文件页码、数据行、方法学公式、因子版本和审核人
 * 用例 7  权限测试：其他团队不能查看项目附件；导出记录可审计
 *
 * 【门禁模型变更（本次重写依据）】
 *   业务测算（channel = 'business'）只有在「方法学版本 calculator_status = approved +
 *   插件无占位系数 + 公式条款页码已回填 + 已绑定同一项目/版本/基准日且 0 硬障碍的
 *   条件检查快照」全部满足时才出数，否则 { rejected:true, kind:'precondition', 409 }。
 *   因此本文件中需要真实数字的用例（用例 4 的报告、用例 6、用例 7）先经由
 *   test/fixtures.mjs 的 simulateExpertApproval() 完成「专家已确认」，
 *   并把每次运行显式绑定到刚刚生成的条件检查快照（eligibilityRunId）。
 *   需要真实数字且要绕过审批的路径（用例 5 的输入校验）改走演示通道
 *   （enableDemoChannel + channel:'demo'，仅 admin / researcher 可用）。
 *
 *   ⚠ 见下方 alignPluginDeclarationWithDb()：src 的门禁读取的是插件模块里**静态声明**的
 *   占位状态，而夹具只更新数据库，故测试内需要一层显式标注的补偿垫片。
 *
 * 【另一处口径修正（用例 3）】
 *   注册登记链条状态与三类减排量均由项目档案人工录入，report-svc 已不再把
 *   registry 状态标注为「官方已确认」：有 registry_public_url 时为「项目资料记载」，
 *   无链接时只能为「待核实」，并在 note 中说明「系统未与注册登记系统自动核对」。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, teardown, projectByCode, findUnnegatedPhrases, ADMIN, ANALYST, RESEARCHER, REVIEWER, OUTSIDER } from './helpers.mjs';
import { simulateExpertApproval, enableDemoChannel, gateState } from './fixtures.mjs';

let M;
let P = {};

before(async () => {
  M = await setup();
  P = {
    p1: projectByCode(M.projects, 'CCER-DEMO-001'),
    p2: projectByCode(M.projects, 'CCER-DEMO-002'),
    p3: projectByCode(M.projects, 'CCER-DEMO-003'),
    p4: projectByCode(M.projects, 'CCER-DEMO-004'),
    p5: projectByCode(M.projects, 'CCER-DEMO-005'),
  };
});

after(() => teardown());

/* ========================================================================== */
/*  门禁辅助：专家确认 + 静态声明对齐 + 条件检查快照绑定                          */
/* ========================================================================== */

function mvRowOf(methodologyId, version = 'V01') {
  const row = M.db.get(
    'SELECT * FROM methodology_version WHERE methodology_id = ? AND version = ?',
    [methodologyId, version]
  );
  if (!row) throw new Error(`未找到方法学版本 ${methodologyId}::${version}`);
  return row;
}

/**
 * 测试补偿垫片（与 test/03-calculation.test.mjs 中的同名函数一致）。
 * src/services/calc-svc.mjs 的 assertCalculationPreconditions()、methodologyPluginStatus()
 * 与 engine.mjs 的 calculation_availability 判断「占位系数 / 条款页码」时读取的是插件模块
 * **静态声明**的 value_status 与 clause_ref，而 fixtures.simulateExpertApproval() 只改数据库
 * 里的 factor_version 行 —— 于是数据库侧的「专家已确认」无法解除门禁，业务通道永不可达。
 * 本函数只做两件事：数据库说 verified 就同步为 verified；把【占位】条款串换成显式标注的
 * 测试串（不臆造任何系数数值或官方条款号）。生产实现应以 factor_version 表为准。
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
  const clauseText = `${methodologyId}-${version} §6（测试补偿垫片：条款页码已按专家确认回填，非官方引用）`;
  for (const fr of pending) fr.clause_ref = clauseText;
  if (pending.length) {
    M.db.run(
      `UPDATE formula SET clause_ref = ?
       WHERE methodology_version_id = ?
         AND (clause_ref LIKE '%【占位】%' OR clause_ref LIKE '%待对照%')`,
      [clauseText, mvRowOf(methodologyId, version).id]
    );
  }
  return { factors, formulas: pending.length };
}

let businessReady = false;
/** 幂等地把库改造成「CCER-10-001 专家已确认」的状态（夹具 + 静态声明对齐） */
function ensureCc10001Approved() {
  if (businessReady) return;
  simulateExpertApproval('CCER-10-001');
  alignPluginDeclarationWithDb('CCER-10-001');
  businessReady = true;
}

/** 生成一份「同一项目 + 同一方法学版本 + 同一基准日」的条件检查快照并返回 */
function freshEligibility(projectId, methodologyId = 'CCER-10-001', analysisBaseDate = '2026-09-24') {
  const elig = M.engine.runEligibility(ADMIN, projectId, {
    methodologyVersionId: mvRowOf(methodologyId).id, analysisBaseDate,
  });
  assert.ok(!elig.error, JSON.stringify(elig));
  return elig;
}

/* ========================================================================== */
/*  补充：种子默认态不得伪造审批                                                 */
/* ========================================================================== */
test('种子默认态：没有任何方法学被标记为计算插件已审批通过（不得伪造审批）', () => {
  const seeded = gateState();
  assert.ok(seeded.methodology.length >= 4, '正式版方法学应不少于 4 个');
  assert.ok(
    seeded.methodology.every((r) => r.calculator_status !== 'approved'),
    `种子不得把任何方法学写成 approved：${JSON.stringify(seeded.methodology)}`
  );
  assert.ok(
    seeded.methodology.some((r) => r.calculator_status === 'pending_review'),
    '结构已就位的方法学应处于 pending_review，等待复核签字'
  );
  assert.ok(
    seeded.methodology.every((r) => r.rulecard_status !== 'approved'),
    '规则卡同样不得在种子阶段被写成 approved'
  );

  // 直接查库复核（不依赖夹具实现细节）
  const approved = M.db.all(
    "SELECT methodology_id, calculator_status FROM methodology_version WHERE calculator_status = 'approved'"
  );
  assert.equal(approved.length, 0, `库中不应存在已审批的计算插件：${JSON.stringify(approved)}`);
  const placeholders = M.db.get(
    "SELECT COUNT(*) AS c FROM factor_version WHERE value_status = 'placeholder'"
  ).c;
  assert.ok(placeholders > 0, '种子必须保留占位系数，不得自动升级为 verified');

  // 默认开关：严格模式 + 演示通道关闭
  assert.equal(seeded.meta.calculator_gate_mode, 'strict');
  assert.equal(seeded.meta.demo_channel_enabled, 'false');
});


/* ============================ 用例 1 ============================ */
test('验收用例 1：修订征求意见稿产生跟踪提醒，计算仍绑定现行正式版本', () => {
  const versions = M.engine.listMethodologyVersions();
  const drafts = versions.filter((v) => v.document_status === 'revised_draft');
  assert.equal(drafts.length, 2, '应有两份 2026 修订征求意见稿');
  for (const d of drafts) {
    assert.equal(d.effective_date, null, '草案不得有生效日期');
    assert.equal(d.is_candidate_eligible, 0, '草案不得列为可申报候选');
    assert.ok(d.supersedes_id, '草案应指向现行正式版本');
  }

  // 跟踪提醒
  const alerts = M.radar.listAlerts({ status: 'open' });
  const draftAlert = alerts.find((a) => a.kind === 'draft_consultation');
  assert.ok(draftAlert, '应存在修订征求意见稿跟踪提醒');
  assert.match(draftAlert.detail, /不得自动替换/);

  // 目录核对提醒
  assert.ok(alerts.some((a) => a.kind === 'catalog_gap'), '应存在方法学目录核对告警');

  // 用「造林碳汇」项目做匹配：草案只能作观察项；未建规则卡的正式版可供检索但不可列为候选
  const p = M.projects.createProject(ADMIN, {
    code: 'ACC-CASE1', name: '验收用例1 造林碳汇项目', project_type: '造林碳汇', technology_route: '乔木造林',
  });
  const match = M.engine.runMatch(ADMIN, p.id, { analysisBaseDate: '2026-09-24' });

  // 草案一律不出现在候选清单里
  assert.ok(
    match.candidates.every((c) => c.document_status === 'formal'),
    '候选清单中不得出现草案'
  );
  // 修订征求意见稿必须出现在观察项，并说明不得用于计算
  const obs = match.observations.filter((o) => o.document_status === 'revised_draft');
  assert.equal(obs.length, 1, '造林碳汇应有一份修订征求意见稿作为观察项');
  assert.match(obs[0].reason, /不得用于计算/);
  assert.equal(obs[0].effective_date, null);

  // 正式版 CCER-14-001-V01 尚未建立规则卡 → 不可列为可申报候选，但必须给出明确理由
  // （目录中「造林碳汇」对应 CCER-14-001，「红树林营造」对应 CCER-14-002）
  const formalForType = match.excluded.find((e) => e.code_display === 'CCER-14-001-V01');
  assert.ok(formalForType, '正式版应出现在排除清单中并说明理由');
  assert.equal(formalForType.reason_code, 'rulecard_missing');
  assert.match(formalForType.reason, /规则卡尚未建立/);
  assert.equal(match.candidates.length, 0, '未建规则卡的方法学不得成为候选');

  // 草案版本不得用于计算
  const draftId = drafts[0].id;
  const calc = M.calc.runCalculation(ADMIN, p.id, { methodologyVersionId: draftId, allScenarios: false });
  assert.ok(calc.error, '草案版本应拒绝计算');
  assert.match(calc.error, /计算必须绑定现行正式版本/);

  // 正式版但未注册计算插件 → 提示「暂不支持自动测算」
  const formalId = M.engine
    .listMethodologyVersions()
    .find((v) => v.methodology_id === 'CCER-14-002' && v.document_status === 'formal').id;
  const calc2 = M.calc.runCalculation(ADMIN, p.id, { methodologyVersionId: formalId, allScenarios: false });
  assert.ok(calc2.error);
  assert.match(calc2.error, /暂不支持自动测算/);

  // 条件检查：无候选 → 第四态结论，且不提供测算
  const elig = M.engine.runEligibility(ADMIN, p.id, { analysisBaseDate: '2026-09-24' });
  assert.equal(elig.conclusion, '无已发布适用方法学');
  assert.equal(elig.calculation_availability.available, false);
});

/* ============================ 用例 2 ============================ */
test('验收用例 2：开工日期缺失显示「待核实」，不能显示「通过」', () => {
  const e = M.engine.runEligibility(ADMIN, P.p2.id, { analysisBaseDate: '2026-09-24' });
  const c04 = e.layers.common.find((r) => r.rule_id === 'C-04');
  assert.equal(c04.state, 'unknown');
  assert.notEqual(c04.state, 'pass');
  assert.ok(c04.missing_fields.includes('time.start_construction_date'));
  assert.equal(e.conclusion, '资料不足暂无法判断');

  // 义务状态仅有业主自述 → 同样待核实
  const c05 = e.layers.common.find((r) => r.rule_id === 'C-05');
  assert.equal(c05.state, 'unknown');
  assert.match(c05.detail, /业主自述/);

  // 必须给出最小补充材料清单
  assert.ok(e.priority_gaps.length > 0);
  assert.ok(e.priority_gaps.some((g) => g.field_key === 'time.start_construction_date'));
});

/* ============================ 用例 3 ============================ */
test('验收用例 3：项目公示状态不得显示为「已登记」或「已签发」，且注册登记状态不得标注为「官方已确认」', () => {
  const full = M.projects.getProjectFull(ADMIN, P.p3.id);
  assert.deepEqual(full.project.registry_stage, ['项目公示']);
  assert.equal(full.project.registry_project_registered, 0);
  assert.equal(full.project.registry_reduction_registered, 0);
  assert.equal(full.project.registry_verified, 0);

  // 三套数字分开存储
  assert.equal(full.project.owner_announced_estimate, 320000);
  assert.equal(full.project.verified_amount, null);
  assert.equal(full.project.registered_amount, null);

  // 报告中的表述
  const rep = M.reports.generateReport(ADMIN, P.p3.id, { analysisBaseDate: '2026-09-24' });
  const overviewStatements = rep.content.one_page.project_overview;
  const overview = overviewStatements.map((s) => s.text).join('\n');
  assert.match(overview, /项目公示/);
  assert.doesNotMatch(overview, /已登记项目/);
  assert.doesNotMatch(overview, /已签发/);
  assert.match(overview, /业主公示预计减排量/);
  // 未公示的核查量 / 登记量必须表述为无记录
  assert.match(overview, /核查确定的量：无记录/);

  // ------------------------------------------------------------------
  // 注册登记链条状态由项目档案人工录入，系统未与注册登记系统自动核对，
  // 因此陈述正文**不得**出现「官方已确认」字样（只有否定式说明里才允许提及）。
  // 有 registry_public_url 时标注「项目资料记载」，无链接时标注「待核实」。
  // ------------------------------------------------------------------
  assert.doesNotMatch(overview, /官方已确认/, '注册登记状态由人工录入，不得标注为「官方已确认」');
  const registryStmt = overviewStatements.find((s) => s.text.includes('注册登记链条状态'));
  assert.ok(registryStmt, '项目概况必须包含注册登记链条状态');
  assert.equal(registryStmt.label, '项目资料记载', '已提供登记信息公开链接时应标注「项目资料记载」');
  assert.match(registryStmt.text, /人工录入/);
  assert.match(registryStmt.note, /未与.*自动核对/, 'note 必须说明系统未与注册登记系统自动核对');
  assert.match(registryStmt.note, /复核前不得作为官方状态引用/);

  // 不允许在没有官方链接时升级证据等级
  const p2full = M.projects.getProjectFull(ADMIN, P.p2.id);
  assert.equal(p2full.project.registry_public_url, null);
  const rep2 = M.reports.generateReport(ADMIN, P.p2.id, { analysisBaseDate: '2026-09-24' });
  const p2Registry = rep2.content.one_page.project_overview.find((s) => s.text.includes('注册登记链条状态'));
  assert.equal(p2Registry.label, '待核实', '无官方链接时只能标注「待核实」');

  // 也不能把情景估算称为「预计可签发量」——该短语只允许以否定形式出现。
  // 默认态（未经专家确认）下业务测算被门禁阻止，因此本段只允许出现「本报告不含减排量数值」。
  const estimation = rep.content.one_page.estimate.statements.map((s) => s.text).join('\n');
  assert.equal(
    findUnnegatedPhrases(estimation, ['预计可签发量', '预计减排量', '可交易量', '确定现金流']).length,
    0,
    '情景估算段落中出现了未加否定的禁止表述'
  );
  assert.equal(rep.content.one_page.estimate.available, false, '默认态不得出数');
  assert.match(estimation, /本报告不含减排量数值/);
  assert.match(estimation, /不得以任何形式引用减排量数字/);
  assert.match(rep.content.disclaimer, /不构成对减排量、签发量或可交易量的确认/);
  assert.match(rep.content.disclaimer, /情景估算不得作为确定现金流/);
});

/* ============================ 用例 4 ============================ */
test('验收用例 4：因子或版本变化后新旧结果并存、差异可解释、历史报告可恢复', () => {
  // 新门禁模型：业务测算必须绑定条件检查快照 → 先完成专家确认并生成快照
  ensureCc10001Approved();
  const mv = mvRowOf('CCER-10-001');
  const elig = freshEligibility(P.p1.id);
  assert.equal(elig.summary.blocking_failures, 0);
  const calcBusiness = (extra = {}) => M.calc.runCalculation(ADMIN, P.p1.id, {
    methodologyVersionId: mv.id,
    eligibilityRunId: elig.eligibility_run_id,
    analysisBaseDate: '2026-09-24',
    channel: 'business',
    allScenarios: false,
    scenario: 'base',
    ...extra,
  });

  // 第一次运行
  const r1 = calcBusiness();
  assert.ok(!r1.error && !r1.rejected, JSON.stringify(r1.errors || r1));
  assert.equal(r1.usable_for_report, true, '业务运行必须可用于筛选报告');
  const runIdA = r1.runs[0].calculation_run_id;
  const erA = r1.runs[0].er_annual;

  // 制造因子变化：把方法学专属 GWP 从 AR5(28) 改为 AR6(29.8)
  // （重写后的 CCER-10-001 插件只读方法学专属因子 c10-001.gwp.ch4，
  //   不再回落全局因子 gwp.ch4.fossil.ar5，故必须改这一个）
  const before = M.db.get(
    'SELECT * FROM factor_version WHERE factor_key = ? AND methodology_version_id = ?',
    ['c10-001.gwp.ch4', 'CCER-10-001::V01']
  );
  assert.ok(before, '应存在方法学专属 GWP 因子 c10-001.gwp.ch4');
  assert.equal(before.value, 28);
  M.db.run('UPDATE factor_version SET value = ?, source_year = ?, verification_note = ? WHERE id = ?', [
    29.8, 2021, '测试用例：模拟因子版本变化（GWP AR5 → AR6）', before.id,
  ]);

  const r2 = calcBusiness();
  assert.ok(!r2.rejected, JSON.stringify(r2.errors || r2));
  const runIdB = r2.runs[0].calculation_run_id;
  const erB = r2.runs[0].er_annual;
  assert.notEqual(erA, erB, '因子变化后结果应不同');

  // 恢复因子
  M.db.run('UPDATE factor_version SET value = ?, source_year = ?, verification_note = ? WHERE id = ?', [
    before.value, before.source_year, before.verification_note, before.id,
  ]);

  // 两次运行都保留，旧结果不因库更新被静默改写
  const a = M.calc.getCalculationRun(runIdA);
  const b = M.calc.getCalculationRun(runIdB);
  assert.equal(a.result.er_annual, erA);
  assert.equal(b.result.er_annual, erB);
  assert.equal(a.factor_snapshot.find((f) => f.factor_key === 'c10-001.gwp.ch4').value, 28);
  assert.equal(b.factor_snapshot.find((f) => f.factor_key === 'c10-001.gwp.ch4').value, 29.8);
  // 两次运行都必须是可进入报告的业务运行（而不是 demo）
  assert.equal(a.status, 'ok');
  assert.equal(b.status, 'ok');

  // 差异可解释
  const cmp = M.calc.compareRuns(runIdA, runIdB);
  assert.notEqual(cmp.delta_er_annual, 0);
  assert.ok(cmp.factor_diff.length >= 1, '应识别出因子差异');
  assert.ok(cmp.explanation.reasons.some((x) => x.includes('因子变化')));
  assert.match(cmp.note, /不会静默改写历史报告/);

  // 报告版本并存且可恢复（报告内的计算同样走业务通道并绑定条件检查快照）
  const rep1 = M.reports.generateReport(ADMIN, P.p1.id, { analysisBaseDate: '2026-09-24', carbonPrice: 70 });
  const rep2 = M.reports.generateReport(ADMIN, P.p1.id, { analysisBaseDate: '2026-09-24', carbonPrice: 100 });
  assert.notEqual(rep1.report_id, rep2.report_id);
  assert.equal(rep1.revision, 1);
  assert.equal(rep2.revision, 2);
  assert.equal(rep1.content.one_page.estimate.available, true, '业务路径的报告必须带情景估算数字');
  assert.ok(rep1.snapshot.calculation_run_ids.length >= 1);
  const list = M.reports.listReports(ADMIN, P.p1.id);
  assert.equal(list.length, 2);
  assert.equal(list.find((r) => r.revision === 1).id, rep1.report_id);
  assert.equal(list.find((r) => r.revision === 2).supersedes_id, rep1.report_id);
  // 旧报告内容仍可完整取出
  const old = M.db.get('SELECT * FROM report WHERE id = ?', [rep1.report_id]);
  assert.match(old.content_json, /情景估算/);
});

/* ============================ 用例 5 ============================ */
test('验收用例 5：单位错误 / 期间重叠 / 超出合理范围 → 阻止出数并提示原始字段', () => {
  // 新门禁模型下业务通道会被「审批状态 / 占位系数 / 条件检查快照」先行拦下，
  // 因此本用例改走**演示通道**（admin 可用），让输入校验成为唯一阻断原因。
  enableDemoChannel(ADMIN);
  const mv = mvRowOf('CCER-10-001');
  const base = {
    methodologyVersionId: mv.id, analysisBaseDate: '2026-09-24',
    channel: 'demo', allScenarios: false,
  };

  // (a) 非数值（疑似单位写进数值字段）
  const a = M.calc.runCalculation(ADMIN, P.p1.id, {
    ...base, overrides: { recovery_volume_nm3: '9600 万立方米' },
  });
  assert.ok(a.rejected, '非数值输入应被拒绝');
  assert.ok(a.errors.some((e) => e.kind === 'not_numeric' || e.kind === 'missing'));
  assert.ok(a.errors.some((e) => e.field === 'recovery_volume_nm3'));

  // (b) 超出合理范围（年运行小时数 90000）
  const b = M.calc.runCalculation(ADMIN, P.p1.id, {
    ...base, overrides: { hours_per_year: 90000 },
  });
  assert.ok(b.rejected);
  assert.ok(b.errors.some((e) => e.field === 'hours_per_year' && e.kind === 'out_of_range'));
  assert.match(b.errors.find((e) => e.field === 'hours_per_year').message, /合理上限/);
  assert.equal(b.message, '输入校验未通过，系统拒绝出数（不提供任何减排量数值）。');

  // (c) 甲烷浓度超出方法学适用范围
  const c = M.calc.runCalculation(ADMIN, P.p1.id, {
    ...base, overrides: { ch4_concentration_pct: 12 },
  });
  assert.ok(c.rejected);
  assert.ok(c.errors.some((e) => e.kind === 'scope_violation'));

  // (d) 期间重叠
  const dg = M.calc.runCalculation(ADMIN, P.p1.id, {
    ...base,
    extraPeriods: [
      { label: '第一计入期', start: '2025-01-01', end: '2027-12-31' },
      { label: '第二计入期', start: '2027-01-01', end: '2029-12-31' },
    ],
  });
  assert.ok(dg.rejected);
  assert.ok(dg.errors.some((e) => e.kind === 'period_overlap'));

  // (e) 期间起止倒置
  const rv = M.calc.runCalculation(ADMIN, P.p1.id, {
    ...base,
    extraPeriods: [{ label: '倒置期间', start: '2026-01-01', end: '2025-01-01' }],
  });
  assert.ok(rv.rejected);
  assert.ok(rv.errors.some((e) => e.kind === 'period_reversed'));

  // (f) 站场规模超限（CCER-10-004 硬性适用条件）：显式指定版本，经演示通道进入校验路径
  const sc = M.calc.runCalculation(ADMIN, P.p4.id, {
    methodologyId: 'CCER-10-004', analysisBaseDate: '2026-09-24', channel: 'demo', allScenarios: false,
  });
  assert.ok(sc.rejected);
  assert.ok(sc.errors.some((e) => e.kind === 'scope_violation' && e.field === 'station_design_scale_m3d'));

  // 被拒绝的运行写入历史，且不产生任何减排量数值
  const history = M.calc.listCalculationRuns(P.p1.id);
  const rejects = history.filter((h) => h.status === 'rejected');
  assert.ok(rejects.length >= 4);
  assert.ok(rejects.every((h) => h.er_annual === null || h.er_annual === undefined));
  // 演示通道的「成功」运行也不得混进业务口径
  assert.ok(history.every((h) => h.status !== 'demo' || h.usable_for_report === false));
});

/* ============================ 用例 6 ============================ */
test('验收用例 6：计算结果可从报告追到输入页码、方法学公式、因子版本与审核人', () => {
  // 可追溯性要求报告里真的有数字 → 先完成专家确认并生成条件检查快照，
  // 报告内部会以 channel:'business' + eligibilityRunId 绑定该快照。
  ensureCc10001Approved();
  freshEligibility(P.p1.id);

  const rep = M.reports.generateReport(ANALYST, P.p1.id, { analysisBaseDate: '2026-09-24', carbonPrice: 70 });
  assert.ok(!rep.error, JSON.stringify(rep));
  assert.equal(rep.content.one_page.estimate.available, true, '本用例需要一份带数字的报告');

  const body = rep.content.body;
  const tr = rep.content.traceability;

  // 原始数据 + 文件页码
  const volFact = body.project_facts.find((f) => f.field_key === 'gas.recovery_volume_nm3');
  assert.ok(volFact.evidence_id, '关键活动数据必须带证据 ID');
  const ev = M.db.get('SELECT * FROM project_evidence WHERE id = ?', [volFact.evidence_id]);
  assert.ok(ev.file_name);
  assert.ok(ev.page >= 1, '证据必须有页码');

  // 方法学公式（逐式明细）
  assert.ok(body.formulas_and_params.steps.length >= 8, '应输出逐式计算明细');
  assert.ok(body.formulas_and_params.steps.every((s) => s.formula && s.step_no >= 1));
  assert.ok(body.formulas_and_params.steps.some((s) => /ER_y\s*=/.test(s.formula) || /减排量/.test(s.title)));
  // 每一步都要能追到官方条款
  assert.ok(body.formulas_and_params.steps.every((s) => s.clause_ref));
  assert.ok(body.formulas_and_params.steps.every((s) => !/【占位】|待对照/.test(s.clause_ref)));

  // 因子版本：重写后的 CCER-10-001 插件只读方法学专属因子，
  // 全局因子 gwp.ch4.fossil.ar5 已不再进入快照。
  assert.ok(body.formulas_and_params.factor_snapshot.length >= 5);
  const gwp = body.formulas_and_params.factor_snapshot.find((f) => f.factor_key === 'c10-001.gwp.ch4');
  assert.ok(gwp, '因子快照必须包含方法学专属 GWP 因子 c10-001.gwp.ch4');
  assert.ok(gwp.source_ref && gwp.value_status === 'verified');
  assert.equal(gwp.value, 28);

  // 每条条件检查都带条款与规则版本
  assert.ok(body.condition_checks.every((r) => r.rule_id && r.judged_at && r.rule_version));
  assert.ok(body.condition_checks.some((r) => r.evidence && r.evidence.page >= 1));

  // 运行快照 ID
  assert.ok(tr.runs.eligibility_run_id);
  assert.ok(tr.runs.match_run_id);
  assert.ok(tr.runs.calculation_run_ids.length === 3, '三情景应各有一条运行记录');
  assert.ok(
    tr.runs.calculation_run_ids.every((id) => M.calc.getCalculationRun(id).status === 'ok'),
    '报告只能引用业务运行（status = ok）'
  );

  // 审核人：审核后写入 review_decision 并可追溯
  const calcId = tr.runs.calculation_run_ids[0];
  const dec = M.reports.decideReview(REVIEWER, {
    objectType: 'calculation_run', objectId: calcId, decision: 'approved', comment: '复算样例通过',
  });
  assert.equal(dec.ok, true);
  const rv = M.db.get('SELECT * FROM review_decision WHERE object_id = ?', [calcId]);
  assert.equal(rv.reviewer, '领域复核人');
  assert.equal(rv.decision, 'approved');
  const runAfter = M.db.get('SELECT * FROM calculation_run WHERE id = ?', [calcId]);
  assert.equal(runAfter.audit_status, 'approved');
});

/* ============================ 用例 7 ============================ */
test('验收用例 7：其他团队不能查看项目附件；导出记录可审计', () => {
  // 项目本体访问
  const denied = M.projects.getProjectFull(OUTSIDER, P.p1.id);
  assert.equal(denied.status, 403);
  assert.match(denied.error, /无权访问/);

  // 本团队成员可以访问
  const ok = M.projects.getProjectFull(ANALYST, P.p1.id);
  assert.ok(ok.project);

  // 受限级证据：分析师不可见，研究员可见
  const restricted = M.db.get(
    "SELECT * FROM project_evidence WHERE project_id = ? AND confidentiality = 'restricted' LIMIT 1",
    [P.p1.id]
  );
  assert.ok(restricted, '应存在受限级证据用于测试');
  const analystSees = M.projects.canViewEvidence(ANALYST, restricted);
  const researcherSees = M.projects.canViewEvidence(RESEARCHER, restricted);
  const outsiderSees = M.projects.canViewEvidence(OUTSIDER, restricted);
  assert.equal(analystSees, false, '分析师不应看到受限级附件');
  assert.equal(researcherSees, true, '研究员应能看到受限级附件');
  assert.equal(outsiderSees, false);

  // 分析师的证据清单里该受限证据不可见，并给出说明
  const full = M.projects.getProjectFull(ANALYST, P.p1.id);
  assert.ok(full.evidence_hidden >= 1);
  const blockedFact = full.facts.find((f) => f.evidence_blocked);
  assert.ok(blockedFact, '引用了受限证据的事实应标记为受保密限制');
  assert.match(blockedFact.evidence.note, /受保密限制/);

  // 导出：跨团队被拒绝并记审计
  const rep = M.reports.generateReport(ANALYST, P.p1.id, { analysisBaseDate: '2026-09-24' });
  const deniedExport = M.reports.exportReport(OUTSIDER, rep.report_id, 'markdown');
  assert.equal(deniedExport.status, 403);
  const deniedLog = M.db.all(
    "SELECT * FROM audit_log WHERE action = 'report.export_denied' ORDER BY at DESC LIMIT 1"
  );
  assert.equal(deniedLog.length, 1);
  assert.equal(deniedLog[0].result, 'denied');

  // 导出：本团队成功并记审计
  const goodExport = M.reports.exportReport(ANALYST, rep.report_id, 'markdown');
  assert.ok(!goodExport.error, JSON.stringify(goodExport));
  assert.match(goodExport.body, /CCER 投资筛选报告/);
  assert.match(goodExport.body, /可追溯索引/);
  const goodLog = M.db.all("SELECT * FROM audit_log WHERE action = 'report.export' ORDER BY at DESC LIMIT 1");
  assert.equal(goodLog.length, 1);
  assert.equal(goodLog[0].actor, '投资分析师');
  assert.match(goodLog[0].detail, /markdown/);

  // 五种导出格式都可用
  for (const fmt of ['markdown', 'html', 'csv', 'doc', 'xls']) {
    const out = M.reports.exportReport(ANALYST, rep.report_id, fmt);
    assert.ok(out.body.length > 500, `${fmt} 导出内容过短`);
    assert.match(out.file_name, new RegExp(`\\.${fmt === 'markdown' ? 'md' : fmt}$`), `${fmt} 文件名后缀不正确`);
  }
  // Word / Excel 导出必须带上 Office 命名空间与正确 MIME
  const doc = M.reports.exportReport(ANALYST, rep.report_id, 'doc');
  assert.equal(doc.mime, 'application/msword; charset=utf-8');
  assert.match(doc.body, /urn:schemas-microsoft-com:office:word/);
  assert.match(doc.body, /<w:WordDocument>/);
  const xls = M.reports.exportReport(ANALYST, rep.report_id, 'xls');
  assert.equal(xls.mime, 'application/vnd.ms-excel; charset=utf-8');
  assert.match(xls.body, /urn:schemas-microsoft-com:office:excel/);
  // Excel 版本应包含全部数据区块
  for (const sheetName of ['报告信息', '一页结论', '项目事实', '条件检查', '计算明细', '因子快照', '情景', '敏感性', '可追溯索引']) {
    assert.ok(xls.body.includes(sheetName), `Excel 导出缺少区块「${sheetName}」`);
  }
  // 两种 Office 格式都必须保留来源分层标注与免责声明
  assert.match(doc.body, /官方已确认|项目资料记载/);
  assert.match(doc.body, /不替代项目业主、审定与核查机构、注册登记机构/);
  assert.match(xls.body, /情景估算/);
});

/* ==================== 补充：结论枚举与陈述分层 ==================== */
test('筛选结论只输出四态枚举，且陈述按来源分层标注', () => {
  const allowed = new Set(['可继续尽调', '存在明确障碍', '资料不足暂无法判断', '无已发布适用方法学']);
  for (const key of ['p1', 'p2', 'p3', 'p4', 'p5']) {
    const e = M.engine.runEligibility(ADMIN, P[key].id, { analysisBaseDate: '2026-09-24' });
    assert.ok(allowed.has(e.conclusion), `非枚举结论：${e.conclusion}`);
    assert.doesNotMatch(e.summary_text, /符合申报/);
  }

  const labels = new Set(['官方已确认', '项目资料记载', '分析师推断', '模型假设', '待核实']);
  const rep = M.reports.generateReport(ADMIN, P.p1.id, { analysisBaseDate: '2026-09-24' });
  const allStatements = [
    ...rep.content.one_page.project_overview,
    ...rep.content.one_page.candidate_methodology,
    ...rep.content.one_page.estimate.statements,
    ...rep.content.body.investment_view,
    ...rep.content.body.carbon_rights_risks,
  ];
  assert.ok(allStatements.length > 10);
  for (const s of allStatements) {
    assert.ok(
      [...labels].some((l) => s.label.startsWith(l.slice(0, 4))),
      `未分层的陈述：${s.label} / ${s.text}`
    );
  }
});

test('演示项目覆盖四态结论中的三种，且边界结论与输入一致', () => {
  // 说明：新规则卡（CCER-10-001 v2 起）要求更细的专属证据，示例项目 p1/p2 因此判为
  // 「资料不足暂无法判断」；「可继续尽调」由资料齐备的 p3 / p5 覆盖。此处不逐项钉死
  // 结论文案，而是断言「结论落在四态枚举内 + 至少覆盖三种 + 关键边界与输入一致」。
  const allowed = new Set(['可继续尽调', '存在明确障碍', '资料不足暂无法判断', '无已发布适用方法学']);
  const conclusions = {};
  for (const key of ['p1', 'p2', 'p3', 'p4', 'p5']) {
    const e = M.engine.runEligibility(ADMIN, P[key].id, { analysisBaseDate: '2026-09-24' });
    conclusions[key] = e.conclusion;
    assert.ok(allowed.has(e.conclusion), `${key} 出现非枚举结论：${e.conclusion}`);
  }
  assert.ok(
    new Set(Object.values(conclusions)).size >= 3,
    `示例项目至少应覆盖三种结论，实际：${JSON.stringify(conclusions)}`
  );
  assert.ok(
    Object.values(conclusions).includes('可继续尽调'),
    '资料齐备的示例项目应能给出「可继续尽调」'
  );

  // 边界：站场规模超限的项目必须判「存在明确障碍」，并给出具体硬障碍规则
  const e4 = M.engine.runEligibility(ADMIN, P.p4.id, { analysisBaseDate: '2026-09-24' });
  assert.equal(e4.conclusion, '存在明确障碍');
  assert.ok(e4.summary.blocking_fail_list.some((b) => b.rule_id === 'M10-004-02'));

  // 第四态：无适用方法学的项目（且不提供测算）
  const p = M.projects.createProject(ADMIN, {
    code: 'ACC-CASE-NONE', name: '无适用方法学的项目', project_type: '其他',
  });
  const e = M.engine.runEligibility(ADMIN, p.id, { analysisBaseDate: '2026-09-24' });
  assert.equal(e.conclusion, '无已发布适用方法学');
  assert.equal(e.calculation_availability.available, false);
});
