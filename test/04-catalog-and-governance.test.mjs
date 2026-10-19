/**
 * 测试 4：方法学目录纪律、来源库完整性与判断引擎的目录守则
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, teardown, findUnnegatedPhrases, ADMIN, ANALYST, RESEARCHER, REVIEWER, OUTSIDER } from './helpers.mjs';
import * as F from './fixtures.mjs';

let M;

before(async () => {
  M = await setup();
});

after(() => teardown());

test('来源库每条记录都有 URL、发布机关、状态与抓取时间', () => {
  const sources = M.radar.listSources();
  assert.ok(sources.length >= 8);
  for (const s of sources) {
    assert.ok(s.url, `来源「${s.title}」缺少 URL`);
    assert.ok(s.title, '来源缺少标题');
    assert.ok(s.issuing_authority, `来源「${s.title}」缺少发布机关`);
    assert.ok(s.status, `来源「${s.title}」缺少状态`);
    assert.ok(s.fetched_at, `来源「${s.title}」缺少抓取时间`);
    assert.ok([1, 2].includes(s.tier));
  }
  // 一级来源必须是官方
  const tier1 = sources.filter((s) => s.tier === 1);
  assert.ok(tier1.every((s) => s.is_official === true));
});

test('正式 / 征求意见 / 修订 / 废止 分列存储，绝不互相覆盖', () => {
  const versions = M.engine.listMethodologyVersions();
  const formal = versions.filter((v) => v.document_status === 'formal');
  const drafts = versions.filter((v) => v.document_status !== 'formal');
  assert.ok(formal.length >= 17);
  assert.ok(drafts.length >= 2);
  // 同一 methodology_id 可同时存在正式版与修订稿
  const ids = new Set(drafts.map((d) => d.methodology_id));
  for (const id of ids) {
    assert.ok(
      formal.some((f) => f.methodology_id === id),
      `${id} 的修订稿必须与其现行正式版并存，而不是替换`
    );
  }
});

test('编号未核实的方法学不得列为可申报候选', () => {
  const versions = M.engine.listMethodologyVersions();
  const pending = versions.filter((v) => v.catalog_confidence === 'name_only_pending_code');
  assert.ok(pending.length >= 1, '应存在编号待核实的目录条目');
  for (const p of pending) {
    assert.equal(p.code_display, null, '编号待核实的条目不得填写 code_display');
    assert.equal(p.is_candidate_eligible, 0);
    assert.ok(p.exclusion_note, '必须写明不可列为候选的原因');
  }
});

test('方法学编号与名称的对应关系以发布通知正文为准（来源驱动）', () => {
  // 2023 年首批 4 项的编号—名称对应关系由发布通知正文逐字给出
  // （环办气候函〔2023〕343号）：
  //   《造林碳汇（CCER-14-001-V01）》《并网光热发电（CCER-01-001-V01）》
  //   《并网海上风力发电（CCER-01-002-V01）》《红树林营造（CCER-14-002-V01）》
  // 原实现依据新闻稿的列举顺序推断编号，把 14-001/14-002 写反了。本测试防止复发。
  const EXPECTED = {
    'CCER-14-001-V01': '造林碳汇',
    'CCER-01-001-V01': '并网光热发电',
    'CCER-01-002-V01': '并网海上风力发电',
    'CCER-14-002-V01': '红树林营造',
  };
  const versions = M.engine.listMethodologyVersions();
  for (const [code, name] of Object.entries(EXPECTED)) {
    const v = versions.find((x) => x.code_display === code && x.document_status === 'formal');
    assert.ok(v, `缺少正式版本 ${code}`);
    assert.equal(v.name, name, `${code} 的名称应为「${name}」，实际为「${v.name}」`);
    // 发布通知必须是来源库中的一条一级官方来源
    assert.ok(v.source_id, `${code} 缺少来源关联`);
    const src = M.db.get('SELECT * FROM source_document WHERE id = ?', [v.source_id]);
    assert.ok(src, `${code} 的来源记录不存在`);
    assert.equal(src.is_official, 1);
    assert.equal(src.tier, 1);
    assert.match(src.title, /4项方法学|等4项/, `${code} 的来源应指向 2023 年首批发布通知`);
  }

  // 修订征求意见稿须与其现行正式版同名同系列
  const drafts = versions.filter((v) => v.document_status === 'revised_draft');
  for (const d of drafts) {
    const formal = versions.find((v) => v.id === d.supersedes_id);
    assert.ok(formal, `草案 ${d.code_display} 应指向一个现行正式版本`);
    assert.ok(
      d.name.startsWith(formal.name),
      `草案名称「${d.name}」应以其现行正式版名称「${formal.name}」开头，编号对调会导致此处不一致`
    );
  }
});

test('已补录两项原缺的方法学（07-001 公路隧道照明、14-005 淤地坝碳汇）', () => {
  const versions = M.engine.listMethodologyVersions().filter((v) => v.document_status === 'formal');
  const byCode = Object.fromEntries(versions.map((v) => [v.code_display, v]));
  for (const [code, name, docNo] of [
    ['CCER-07-001-V01', '公路隧道照明系统节能', '环办气候函〔2024〕486号'],
    ['CCER-14-005-V01', '淤地坝碳汇', '环办气候函〔2025〕438号'],
  ]) {
    const v = byCode[code];
    assert.ok(v, `缺少 ${code}`);
    assert.equal(v.name, name);
    const src = M.db.get('SELECT * FROM source_document WHERE id = ?', [v.source_id]);
    assert.equal(src.doc_number, docNo, `${code} 的来源文号应为 ${docNo}`);
    assert.equal(v.is_candidate_eligible, 1);
  }
  // 不得依据「系列号相邻」推断编号：14-003 / 14-004 不应被凭空补齐
  for (const guessed of ['CCER-14-003-V01', 'CCER-14-004-V01']) {
    assert.ok(
      !byCode[guessed],
      `${guessed} 的出现说明系统按系列号推断编号——编号必须逐条核对发布通知`
    );
  }
});

test('目录条目数差额被显式暴露为告警，而不是静默补齐', () => {
  const baseline = M.seed.catalogBaseline();
  assert.equal(baseline.design_doc_count, 18);
  assert.equal(baseline.seeded_methodology_ids, 18, '条目数应与官方目录一致');
  assert.equal(baseline.verified_code_count, 10, '编号已核实的方法学应为 10 项');
  assert.equal(baseline.pending_code_count, 8, '编号待核实的方法学应为 8 项');
  assert.match(baseline.note, /系统不推测编号|不得据此推断/);

  const alerts = M.radar.listAlerts({ kind: 'catalog_gap' });
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].title, /18/);
});

test('所有已核实编号的正式方法学都有官方 URL、来源关联与日期', () => {
  const versions = M.engine.listMethodologyVersions().filter((v) => v.document_status === 'formal');
  const verified = versions.filter((v) => v.catalog_confidence === 'verified_from_official_notice');
  const pending = versions.filter((v) => v.catalog_confidence !== 'verified_from_official_notice');
  assert.ok(verified.length >= 8, '应至少有 8 项编号已核实的正式方法学');
  assert.ok(pending.length >= 1, '应存在编号待核实的正式条目');

  for (const v of verified) {
    assert.ok(v.official_url, `${v.methodology_id} 缺少官方 URL`);
    assert.match(v.official_url, /^https:\/\//);
    assert.ok(v.source_id, `${v.methodology_id} 缺少来源关联`);
    assert.ok(v.effective_date, `${v.methodology_id} 缺少生效日期`);
    assert.ok(v.release_date, `${v.methodology_id} 缺少发布日期`);
  }
  // 编号待核实的条目允许缺日期，但必须给出官方链接与排除说明
  for (const v of pending) {
    assert.ok(v.official_url, `${v.methodology_id} 缺少官方链接`);
    assert.ok(v.exclusion_note, `${v.methodology_id} 缺少排除说明`);
  }
});

test('首批 4 项甲烷类方法学均已注册规则卡与插件，但审批状态为待复核', () => {
  const targets = ['CCER-10-001', 'CCER-10-002', 'CCER-10-003', 'CCER-10-004'];
  const versions = M.engine.listMethodologyVersions();
  for (const id of targets) {
    const v = versions.find((x) => x.methodology_id === id && x.document_status === 'formal');
    assert.ok(v, `${id} 缺少正式版本`);
    // 结构必须存在
    assert.ok(M.methodologies.hasRulecard(id, v.version), `${id} 缺少规则卡`);
    assert.ok(M.methodologies.hasPlugin(id, v.version), `${id} 缺少计算插件`);
    // 但审批状态不得为 approved——领域专家尚未签字。
    // 这是「整改清单 P0-2」的核心：代码里有模块 ≠ 已通过审核。
    assert.equal(v.rulecard_status, 'pending_review', `${id} 规则卡审批状态不应为 ${v.rulecard_status}`);
    assert.equal(v.calculator_status, 'pending_review', `${id} 计算插件审批状态不应为 ${v.calculator_status}`);
    assert.equal(v.rulecard_approved_by, null, `${id} 不得预先填写规则卡审批人`);
    assert.equal(v.calculator_approved_by, null, `${id} 不得预先填写插件审批人`);

    const rules = M.db.all('SELECT * FROM rule WHERE methodology_version_id = ?', [v.id]);
    assert.ok(rules.length >= 8, `${id} 专属规则少于 8 条`);
    for (const r of rules) {
      assert.ok(r.rule_id.startsWith('M10-'), `${id} 规则编号不规范：${r.rule_id}`);
      assert.ok(r.clause_ref, `${r.rule_id} 缺少条款引用`);
      assert.ok(r.condition_text && r.expression_text);
      const expr = JSON.parse(r.expr);
      assert.ok(expr.op, `${r.rule_id} 表达式缺少 op`);
    }
  }
});

test('种子数据不得伪造任何审批：默认全部方法学均非 approved', () => {
  const versions = M.engine.listMethodologyVersions();
  const approved = versions.filter(
    (v) => v.rulecard_status === 'approved' || v.calculator_status === 'approved'
  );
  assert.deepEqual(
    approved.map((v) => v.code_display || v.methodology_id),
    [],
    '新库中不应存在任何已审批的方法学——审批必须由领域专家在管理后台逐项完成'
  );
  assert.equal(F.gateState().meta.calculator_gate_mode, 'strict', '默认门禁应为 strict');
  assert.equal(F.gateState().meta.demo_channel_enabled, 'false', '演示通道默认应关闭');
  assert.equal(F.gateState().meta.auth_mode, 'session', '默认身份模式应为服务端会话');
});

test('通用门槛规则覆盖设计文档第 6 节第一层与第三层要求', () => {
  const common = M.db.all('SELECT * FROM rule WHERE methodology_version_id IS NULL ORDER BY sort_order');
  const byId = Object.fromEntries(common.map((r) => [r.rule_id, r]));
  // 第一层：通用门槛
  for (const id of ['C-01', 'C-02', 'C-03', 'C-04', 'C-05', 'C-06', 'C-07', 'C-08', 'C-09']) {
    assert.ok(byId[id], `缺少通用门槛规则 ${id}`);
  }
  // 第三层：冲突与重复
  for (const id of ['X-01', 'X-02', 'X-03', 'X-04']) {
    assert.ok(byId[id], `缺少冲突规则 ${id}`);
    assert.equal(byId[id].layer, 'conflict');
    assert.notEqual(byId[id].severity, 'blocking', '冲突规则不得为硬障碍（不能自动判不合格）');
  }
  // 日期与义务类必须使用严格证据策略
  for (const id of ['C-02', 'C-04', 'C-05', 'C-06', 'C-07']) {
    assert.equal(byId[id].evidence_policy, 'strict', `${id} 必须使用严格证据策略`);
  }
  // C-03 的支持领域应来自现行正式目录
  const formalTypes = M.seed.formalProjectTypes();
  const expr = JSON.parse(byId['C-03'].expr);
  assert.deepEqual([...expr.values].sort(), [...formalTypes].sort());
  assert.ok(!formalTypes.includes('其他'), '「其他」不得出现在支持领域内');
});

test('项目事实字段字典覆盖通用门槛与四项方法学的必需字段', () => {
  const { FACT_FIELDS } = M.factFields;
  const byKey = Object.fromEntries(FACT_FIELDS.map((f) => [f.key, f]));
  // 通用必需
  for (const k of ['time.start_construction_date', 'time.reduction_generation_start',
    'comp.legal_ghg_obligation', 'comp.in_ets_quota', 'comp.uniqueness_declared', 'comp.owner_commitment']) {
    assert.ok(byKey[k], `缺少通用必需字段 ${k}`);
    assert.ok(byKey[k].required_for.includes('__COMMON__'), `${k} 应标记为通用必需`);
  }
  // 四项方法学专属必需
  for (const [mid, keys] of Object.entries({
    'CCER-10-001': ['gas.mine_type', 'gas.gas_category', 'gas.ch4_concentration_pct', 'gas.utilization_route', 'gas.baseline_scenario'],
    'CCER-10-002': ['og.source_type', 'og.product_route'],
    'CCER-10-003': ['og.source_type', 'og.well_type', 'og.product_route'],
    'CCER-10-004': ['og.source_type', 'og.station_design_scale_m3d', 'og.product_route'],
  })) {
    for (const k of keys) {
      assert.ok(byKey[k], `缺少 ${mid} 的必需字段 ${k}`);
      assert.ok(byKey[k].required_for.includes(mid), `${k} 应标记为 ${mid} 的必需字段`);
    }
  }
  // 字段表的记录数与字典一致
  const rows = M.db.all('SELECT COUNT(*) AS c FROM fact_field');
  assert.equal(rows[0].c, FACT_FIELDS.length);
});

test('来源同步：演练模式不改数据；真实抓取失败会产生告警与变更记录', async () => {
  const before = M.db.all('SELECT COUNT(*) AS c FROM source_change')[0].c;
  const dry = await M.radar.syncSources(RESEARCHER, { dryRun: true });
  assert.equal(dry.summary.total, M.radar.listSources().length);
  assert.equal(M.db.all('SELECT COUNT(*) AS c FROM source_change')[0].c, before, '演练模式不得写变更记录');

  // 指向一个必定失败的主机，验证失败路径
  M.db.run('UPDATE source_document SET url = ? WHERE id = (SELECT id FROM source_document LIMIT 1)', [
    'http://127.0.0.1:1/never-listening',
  ]);
  const live = await M.radar.syncSources(RESEARCHER, { timeoutMs: 3000 });
  assert.ok(live.summary.failed >= 1);
  const fails = M.radar.listSourceChanges(50).filter((c) => c.change_kind === 'fetch_failed');
  assert.ok(fails.length >= 1);
  assert.ok(M.radar.listAlerts({ kind: 'fetch_failed' }).length >= 1);
});

test('抓取结果不会自动修改方法学状态（须人工确认）', async () => {
  const before = M.engine.listMethodologyVersions().map((v) => `${v.id}:${v.document_status}:${v.rulecard_status}`);
  await M.radar.syncSources(RESEARCHER, { dryRun: true });
  const after = M.engine.listMethodologyVersions().map((v) => `${v.id}:${v.document_status}:${v.rulecard_status}`);
  assert.deepEqual(after, before);
});

test('权限：只读用户不能触发来源同步，也不能查看审计日志', async () => {
  const denied = await M.radar.syncSources(OUTSIDER, { dryRun: true });
  assert.equal(denied.status, 403);
  const auditDenied = M.radar.listAudit(OUTSIDER);
  assert.equal(auditDenied.status, 403);
  const ok = M.radar.listAudit(ADMIN);
  assert.ok(Array.isArray(ok) && ok.length > 0);
});

test('权限：项目授权在服务层强制生效（不只是路由层）', () => {
  const pid = M.db.get("SELECT id FROM project WHERE code = 'CCER-DEMO-001'").id; // team-invest
  const cases = [
    ['runMatch', () => M.engine.runMatch(OUTSIDER, pid)],
    ['runEligibility', () => M.engine.runEligibility(OUTSIDER, pid)],
    ['runCalculation', () => M.calc.runCalculation(OUTSIDER, pid)],
    ['generateReport', () => M.reports.generateReport(OUTSIDER, pid)],
    ['getProjectFull', () => M.projects.getProjectFull(OUTSIDER, pid)],
    ['listReports', () => M.reports.listReports(OUTSIDER, pid)],
    ['requireProjectAccess', () => M.projects.requireProjectAccess(OUTSIDER, pid)],
  ];
  for (const [name, fn] of cases) {
    const out = fn();
    assert.equal(out.status, 403, `${name} 未对跨团队访问返回 403：${JSON.stringify(out)}`);
  }
  // 不存在的项目返回 404 而不是 403（不泄露存在性）
  const missing = M.projects.requireProjectAccess(ADMIN, 'PRJ-NOT-EXIST');
  assert.equal(missing.status, 404);

  // 只读角色不能执行需要管理的写入动作
  const inTeamViewer = { id: 'user-v', name: '只读成员', role: 'viewer', team_id: 'team-invest' };
  const denied = M.projects.requireProjectAccess(inTeamViewer, pid, { needManage: true });
  assert.equal(denied.status, 403);
  const readOnly = M.projects.requireProjectAccess(inTeamViewer, pid);
  assert.equal(readOnly.ok, true, '只读角色仍应可读取本团队项目');
});

test('权限：viewer 在可见项目内仍为只读，所有写操作被拒绝', () => {
  const pid = M.db.get("SELECT id FROM project WHERE code = 'CCER-DEMO-001'").id; // team-invest
  // 同团队的只读成员：可读，不可写
  const viewer = { id: 'user-v', name: '只读成员', role: 'viewer', team_id: 'team-invest' };

  // 可读
  assert.ok(M.projects.getProjectFull(viewer, pid).project);
  assert.ok(M.projects.requireProjectAccess(viewer, pid).ok);

  // 不可写
  const writes = [
    ['改注册登记状态', () => M.projects.updateProjectRegistry(viewer, pid, { registry_project_public: true })],
    ['写事实', () => M.projects.upsertFact(viewer, pid, { field_key: 'com.investment_amount', value: 1, source_kind: 'analyst' })],
    ['加证据', () => M.projects.addEvidence(viewer, pid, { file_name: 'x.pdf' })],
    ['跑匹配', () => M.engine.runMatch(viewer, pid)],
    ['跑条件检查', () => M.engine.runEligibility(viewer, pid)],
    ['跑计算', () => M.calc.runCalculation(viewer, pid, { allScenarios: false })],
    ['生成报告', () => M.reports.generateReport(viewer, pid)],
    ['导出报告', () => M.reports.exportReport(viewer, 'RPT-NOT-EXIST', 'markdown')],
  ];
  for (const [name, fn] of writes) {
    const out = fn();
    assert.ok(out.error, `${name} 未拒绝只读角色：${JSON.stringify(out)}`);
    assert.ok([403, 404].includes(out.status), `${name} 返回了意外状态：${out.status}`);
  }
  // 只读角色的导出许可判定
  assert.equal(M.projects.canExport(viewer), false);
  assert.equal(M.projects.canExport(ANALYST), true);
});

test('权限：两次计算运行必须属于同一项目才能对比', () => {
  const p1 = M.db.get("SELECT id FROM project WHERE code = 'CCER-DEMO-001'").id;
  const p3 = M.db.get("SELECT id FROM project WHERE code = 'CCER-DEMO-003'").id;
  // 默认门禁下业务测算被阻止，因此经演示通道取两条真实运行
  F.enableDemoChannel(ADMIN);
  const r1 = M.calc.runCalculation(ADMIN, p1, { allScenarios: false, analysisBaseDate: '2026-09-24', channel: 'demo' });
  const r3 = M.calc.runCalculation(ADMIN, p3, { allScenarios: false, analysisBaseDate: '2026-09-24', channel: 'demo' });
  assert.ok(!r1.rejected && !r3.rejected, JSON.stringify([r1.errors, r3.errors]));
  const cross = M.calc.compareRuns(r1.runs[0].calculation_run_id, r3.runs[0].calculation_run_id);
  assert.equal(cross.status, 400);
  assert.match(cross.error, /不属于同一项目/);
  const same = M.calc.compareRuns(r1.runs[0].calculation_run_id, r1.runs[0].calculation_run_id);
  assert.ok(!same.error);
});

test('权限：角色白名单校验返回明确原因', () => {
  assert.equal(M.projects.requireRole(ADMIN, ['admin'], '切换门禁'), null);
  const denied = M.projects.requireRole(ANALYST, ['admin'], '切换门禁');
  assert.equal(denied.status, 403);
  assert.match(denied.error, /投资分析师/);
  assert.match(denied.error, /系统管理员/);
});

test('项目列表支持按注册登记链条阶段过滤', () => {
  const all = M.projects.listProjects(ADMIN);
  assert.ok(all.length >= 5);
  assert.ok(all.every((p) => Array.isArray(p.registry_stage)));
  const publicOnly = M.projects.listProjects(ADMIN, { stage: '项目公示' });
  assert.ok(publicOnly.length >= 1);
  assert.ok(publicOnly.every((p) => p.registry_stage.includes('项目公示')));
  const none = M.projects.listProjects(ADMIN, { stage: '减排量登记' });
  assert.equal(none.length, 0, '演示数据中不应有已完成减排量登记的项目');
});

test('审计日志记录了种子、同步、判断、计算与导出等关键动作', async () => {
  const pid = M.db.get("SELECT id FROM project WHERE code = 'CCER-DEMO-001'").id;
  M.engine.runEligibility(ADMIN, pid, { analysisBaseDate: '2026-09-24' });
  F.enableDemoChannel(ADMIN);
  M.calc.runCalculation(ADMIN, pid, { allScenarios: false, analysisBaseDate: '2026-09-24', channel: 'demo' });
  // 触发一次「输入校验未通过」的运行，验证拒绝路径同样留痕（演示通道保持开启，确保走到校验分支）
  M.calc.runCalculation(ADMIN, pid, {
    allScenarios: false, analysisBaseDate: '2026-09-24', channel: 'demo', overrides: { hours_per_year: 999999 },
  });
  const rep = M.reports.generateReport(ADMIN, pid, { analysisBaseDate: '2026-09-24' });
  M.reports.exportReport(ADMIN, rep.report_id, 'markdown');
  M.reports.decideReview(REVIEWER, {
    objectType: 'report', objectId: rep.report_id, decision: 'approved', comment: '测试审核',
  });
  await M.radar.syncSources(RESEARCHER, { dryRun: true });
  // 通过服务层写入一条新事实，验证「事实级」审计留痕
  const created = M.projects.upsertFact(ADMIN, pid, {
    field_key: 'com.investment_amount', value: 28000, source_kind: 'analyst', note: '审计留痕测试',
  });
  assert.ok(!created.error, JSON.stringify(created));
  M.projects.addEvidence(ADMIN, pid, {
    file_name: '审计留痕测试附件.pdf', doc_type: '其他', page: 1, excerpt: '测试',
  });

  const log = M.radar.listAudit(ADMIN, { limit: 800 });
  const actions = new Set(log.map((a) => a.action));
  for (const a of ['seed.rebuild', 'source.sync', 'calculation.run', 'calculation.rejected',
    'report.generate', 'report.export', 'review.decision', 'fact.create', 'evidence.create']) {
    assert.ok(actions.has(a), `缺少关键审计动作：${a}`);
  }
  // 每条审计都有时间、操作人、动作
  for (const row of log) {
    assert.ok(row.at && row.actor && row.action, `审计记录字段不完整：${JSON.stringify(row)}`);
  }
});

test('前端骨架一致：index.html 中所有 hidden 的顶层容器都必须在 boot() 中被解除', async () => {
  const { readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { analyzeFrontend } = await import('../src/tools/frontend-skeleton.mjs');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const html = readFileSync(join(root, 'web', 'index.html'), 'utf8');
  const js = readFileSync(join(root, 'web', 'app.js'), 'utf8');

  const result = analyzeFrontend(html, js);
  assert.deepEqual(result.errors, [], `前端骨架不一致：\n${result.errors.join('\n')}`);
  assert.equal(result.ok, true);

  // 反向验证：把 boot() 中的 #view 解除行去掉，检查必须报错（证明本检查真的有效）
  const broken = js.split('\n').filter((l) => l.trim() !== "$('#view').hidden = false;").join('\n');
  assert.notEqual(broken, js, '未能构造出缺陷版本，反向验证无效');
  const brokenResult = analyzeFrontend(html, broken);
  assert.equal(brokenResult.ok, false, '缺陷版本竟然通过了检查，说明本检查是空转的');
  assert.ok(
    brokenResult.errors.some((e) => e.includes('#view')),
    `缺陷版本未报出 #view 问题：${brokenResult.errors.join('；')}`
  );
});

test('标准与依据编码表不含未核实的推测编号', async () => {
  const { standardCodes } = await import('../src/data/standard-codes.mjs');
  const s = standardCodes();
  assert.ok(s.standards.length >= 6);
  for (const st of s.standards) {
    assert.ok(st.code && st.title && st.kind && st.issuing_authority);
    if (!st.verified) {
      assert.ok(st.note, `未核实条目 ${st.code} 必须写明待核实说明`);
    } else {
      assert.ok(st.official_url, `已核实条目 ${st.code} 必须给出官方链接`);
    }
  }
  assert.ok(s.note.includes('不得用于计算口径判定'));
});

test('合规红线：报告与计算输出中不出现未加否定的被禁止表述', () => {
  const p = M.db.get("SELECT id FROM project WHERE code = 'CCER-DEMO-001'").id;
  const rep = M.reports.generateReport(ADMIN, p, { analysisBaseDate: '2026-09-24', carbonPrice: 70 });
  const text = JSON.stringify(rep.content);
  const forbidden = ['预计可签发量', '已签发', '符合申报', '确定现金流', '预计减排量', '可交易量', '已登记'];
  const violations = findUnnegatedPhrases(text, forbidden);
  assert.deepEqual(violations, [], `报告中出现未加否定的被禁止表述：\n${violations.join('\n')}`);

  // 必须出现免责声明
  assert.match(rep.content.disclaimer, /不替代项目业主、审定与核查机构、注册登记机构/);
  assert.match(rep.content.disclaimer, /不构成对减排量、签发量或可交易量的确认/);
  // 碳收益必须标注为情景参数——但仅在确实出数时校验。
  // 默认门禁下业务测算被阻止，报告不含任何数值；此时应断言「未出数」而非碳收益措辞。
  if (rep.content.one_page.estimate.available) {
    assert.ok(rep.content.one_page.estimate.carbon_revenue, '出数时碳收益块必须存在');
    assert.match(rep.content.one_page.estimate.carbon_revenue.note, /不与估算量相乘当作确定现金流/);
  } else {
    assert.equal(rep.content.one_page.estimate.carbon_revenue, null, '未出数时不得列示碳收益');
    assert.ok(
      rep.content.one_page.estimate.statements.some((s) => s.text.includes('本报告不含减排量数值')),
      '未出数时必须在报告中明确说明不含减排量数值'
    );
  }
  // 计算结果本身也带免责声明——经演示通道获取一条真实运行
  F.enableDemoChannel(ADMIN);
  const calc = M.calc.runCalculation(ADMIN, p, { allScenarios: false, channel: 'demo' });
  assert.ok(!calc.rejected, JSON.stringify(calc.errors || calc));
  assert.match(calc.runs[0].result.disclaimer, /不得称为预计减排量、预计可签发量或可交易量/);
  assert.match(calc.runs[0].result.unit_note, /未与碳价相乘/);
  F.disableDemoChannel();
});

test('审计测试收尾：关闭演示通道，恢复默认门禁状态', () => {
  F.disableDemoChannel();
  assert.equal(F.gateState().meta.demo_channel_enabled, 'false');
});
