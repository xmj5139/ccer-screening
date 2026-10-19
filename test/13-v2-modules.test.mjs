/**
 * v2 测试 13：六模块业务规则
 * ============================================================================
 * 覆盖需求规格的验收用例：
 *   - 政策库检索与分类、方法学门禁（无领域签字不出数）
 *   - 公开项目：阶段分列、三套数字分离、交易不可归属（不宣称已成交）
 *   - 内部项目：团队隔离、人工关联
 *   - 碳减排测算：不符合 CCER-10-001 适用范围的项目给出明确不适用依据且不产生数值
 *   - 总览指标口径与阶段不可相加
 *   - 后台管理：系统状态、模型配置不下发凭据、用户与权限
 */
import {
  setupV2, test, assert, assertEqual, assertIncludes, assertNotIncludes, finish,
} from './v2-helpers.mjs';

const ctx = await setupV2();
const {
  policy, projects, measure, dash, admin, db, trade,
} = ctx;

const ADMIN = { name: '系统管理员', role: 'admin', team_id: 'team-carbon' };
const RESEARCHER = { name: '政策研究员', role: 'researcher', team_id: 'team-carbon' };
const ANALYST = { name: '投资分析师', role: 'analyst', team_id: 'team-invest' };
const OUTSIDER = { name: '其他团队', role: 'viewer', team_id: 'team-other' };

console.log('\n[v2-13] 六模块业务规则');

/* ------------------------------ 政策和方法学 ------------------------------ */

test('政策库：分类与关键词检索可用', () => {
  const all = policy.listPolicies({});
  assert(all.length >= 8, '政策库应有条目');
  const mgmt = policy.listPolicies({ category: 'management' });
  assert(mgmt.length >= 1, '管理办法分类应有条目');
  const kw = policy.listPolicies({ keyword: '方法学' });
  assert(kw.length >= 4, '关键词「方法学」应命中多条');
  assert(kw.every((p) => p.title.includes('方法学') || String(p.summary || '').includes('方法学') || String(p.doc_number || '').includes('方法学')));
});

test('政策统计与完整性清单：已收录 / 待核实 / 已失效 / 采集失败分列', () => {
  const stats = policy.policyStats();
  assert(stats.total >= 8, '统计总数');
  assert(stats.by_category.length >= 4, '应按分类统计');
  const comp = policy.catalogCompleteness();
  // 2026-09-30 复核：18 项正式方法学的编号与名称已全部从发布通知正文核实，
  // 「待核实」清单因此为空；仍未被机器核实的只剩注册登记系统目录条目数，
  // 由 baseline.registry_listing_count_verified=false 如实保留。
  assertEqual(comp.counts.included, 18, '18 项正式方法学的编号均应已从发布通知核实');
  assertEqual(comp.counts.pending_verification, 0, '不应再有编号待核实条目');
  assert(comp.baseline.registry_listing_count_verified === false, '注册登记系统目录条目数仍未核实，不得标为已核实');
  assert(comp.fix_notes.some((f) => f.item.includes('14-001')), '应记录 14-001/14-002 错号修复');
  assert(comp.fix_notes.some((f) => f.item.includes('07-001')), '应记录 07-001 漏项修复');
});

test('方法学门禁：CCER-10-001 已对照原文但未获领域签字 → 不允许出数', () => {
  const list = policy.listMethodologiesV2({ methodology_id: 'CCER-10-001' });
  const mv = list.formal.find((m) => m.methodology_id === 'CCER-10-001');
  assert(mv, '应存在 CCER-10-001');
  assertEqual(mv.gate.evidence_level, 'official_original_verified', '应已登记原文对照');
  assertEqual(mv.gate.domain_review, null, '领域签字应为空（本轮无实际审批）');
  assertEqual(mv.gate.can_calculate, false, '未签字不得出数');
  assertIncludes(mv.gate.display, '暂不支持自动测算');
  assert(mv.gate.blockers.some((b) => b.includes('领域复核人签字')), '阻断项应说明缺签字');
  assert(mv.gate.remaining_blockers.length >= 3, '应保留原文对照后仍未结清的参数项');
});

test('方法学门禁：未登记原文对照的方法学一律阻断', () => {
  const list = policy.listMethodologiesV2({});
  const blocked = list.formal.filter((m) => m.gate.evidence_level === 'unverified');
  assert(blocked.length >= 1, '应存在未对照原文的方法学');
  assert(blocked.every((m) => !m.gate.can_calculate), '未对照原文不得出数');
  const readiness = measure.readiness();
  assertEqual(readiness.counts.calculable, 0, '当前没有任何方法学满足全部出数条件');
  assertIncludes(readiness.note, '不构成');
});

test('方法学详情：规则、公式、因子、解读层与版本历史齐备', () => {
  const list = policy.listMethodologiesV2({ methodology_id: 'CCER-10-001' });
  const mv = list.formal.find((m) => m.methodology_id === 'CCER-10-001');
  const detail = policy.getMethodologyDetail(mv.id);
  assert(detail.rules.length >= 5, '规则卡应有条目');
  assert(detail.formulas.length >= 5, '公式应有条目');
  assert(detail.factors.length >= 5, '因子应有条目');
  assert(detail.interpretations.length >= 4, '应提供四类解读');
  assert(detail.interpretations.every((i) => i.status_label), '解读应标注已复核/草稿');
  assert(detail.version_history.length >= 1, '版本历史');
  assert(detail.note.includes('领域复核人签字'), '应说明放行条件');
});

test('AI 草稿解读必须标注为未复核，不得冒充人工结论', () => {
  const out = policy.upsertInterpretation(RESEARCHER, {
    methodology_id: 'CCER-10-001', version: 'V01', section: 'applicability',
    content: '（AI 生成的草稿文本，测试用）', origin: 'llm_draft',
  });
  assertEqual(out.status, 'draft');
  assertIncludes(out.label, 'AI 草稿');
  const rows = db.all("SELECT * FROM methodology_interpretation WHERE methodology_id='CCER-10-001' AND section='applicability'");
  assertEqual(rows.length, 1, '同一 section 应 upsert 而不是重复');
  assertEqual(rows[0].reviewed_by, null, 'AI 草稿不得写入复核人');
});

/* ------------------------------ 项目信息 ------------------------------ */

test('公开项目：阶段分列存储，三套数字分开（互不替代），且演示条目默认排除', () => {
  // 默认口径：演示条目（is_demo=1 / 注释「演示条目…」）不进业务列表
  const visible = projects.listPublicProjects({});
  assert(!visible.rows.some((p) => Number(p.is_demo) === 1 || String(p.note || '').startsWith('演示条目')),
    '默认列表不得包含演示条目');
  // 历史留痕查看（显式 include_demo）仍可看到示例数据
  const list = projects.listPublicProjects({ include_demo: 'true' });
  assert(list.total >= 3, '显式包含演示条目时应能看到示例项目');
  assert(list.note.includes('不等于官方全国总数'), '应说明已收录数不等于全国总数');
  const withBatches = list.rows.find((p) => p.batch_count > 0);
  assert(withBatches, '应有带减排量批次的项目');
  const detail = projects.getPublicProjectDetail(withBatches.id);
  assert(detail.project.stage_flags.length === 6, '六个阶段应分列');
  assert(detail.amounts_summary.note.includes('≠'), '应说明三套数字不可互相替代');
  const amounts = detail.amounts_summary;
  assert(amounts.owner_announced_estimate !== amounts.registered_amount || amounts.registered_amount === null,
    '公示预计量与登记量应分别存储');
});

test('交易关联：无官方对应证据时明确「无法归属」，且不出现项目成交量', () => {
  const p = db.get('SELECT * FROM public_project LIMIT 1');
  const attr = projects.tradeAttribution(p);
  assertEqual(attr.attributable, false, '默认不可归属');
  assertIncludes(attr.message, '无法归属');
  assertIncludes(attr.message, '不宣称');
  assert(attr.market_summary.cannot_attribute === true, '市场汇总应显式标注不可归因');
});

test('公开项目：提升证据等级必须有官方链接', () => {
  const created = projects.upsertPublicProject(RESEARCHER, {
    registry_project_no: 'TEST-NO-URL', name: '无链接测试项目', evidence_level: 'unverified',
  });
  assert(created.ok);
  const denied = projects.confirmPublicProject(RESEARCHER, created.id, { evidence_level: 'official_registry' });
  assert(denied.error, '无官方链接不得提升为官方登记事实');
  const ok = projects.confirmPublicProject(RESEARCHER, created.id, {
    evidence_level: 'official_registry', official_url: 'https://ccer.cets.org.cn/example',
  });
  assert(ok.ok, '提供官方链接后应可确认');
});

test('公开项目导入：方法学编号格式错误与缺 ID 会被拒绝', () => {
  const out = projects.importPublicProjects(RESEARCHER, [
    { __row: 2, registry_project_no: 'OK-1', name: '正常项目', methodology_id: 'CCER-10-001', evidence_level: 'unverified' },
    { __row: 3, registry_project_no: null, name: '缺 ID 项目' },
    { __row: 4, registry_project_no: 'BAD-2', name: '编号格式错误', methodology_id: '10-001' },
  ]);
  assertEqual(out.accepted_count, 1, '只应接受 1 行');
  assertEqual(out.rejected_count, 2, '应拒绝 2 行');
  assert(out.rejected.some((r) => r.errors.join('').includes('缺') || r.errors.join('').includes('官方项目 ID')));
  assert(out.rejected.some((r) => r.errors.join('').includes('CCER-XX-XXX')));
});

test('内部项目：团队隔离（其他团队看不到，管理员可见）', () => {
  const created = projects.createInternalProject(ANALYST, { code: 'INV-TEST-1', name: '内部测试项目' });
  assert(created.ok, '投资分析师应可创建内部项目');
  const mine = projects.listInternalProjects(ANALYST, {});
  assert(mine.rows.some((r) => r.id === created.id), '本团队应可见');
  const other = projects.listInternalProjects(OUTSIDER, {});
  assert(!other.rows.some((r) => r.id === created.id), '其他团队不得可见');
  const adminList = projects.listInternalProjects(ADMIN, {});
  assert(adminList.rows.some((r) => r.id === created.id), '管理员应可见全部');
  const detail = projects.getInternalProjectDetail(OUTSIDER, created.id);
  assertEqual(detail.status, 403, '越权访问应返回 403');
});

test('内部项目审阅：本人维护的项目不能由本人批准', () => {
  const created = projects.createInternalProject(ANALYST, { code: 'INV-TEST-2', name: '审阅测试项目' });
  const selfApprove = projects.decideInternalProject(ANALYST, created.id, { decision: 'approved' });
  assert(selfApprove.error, '分析师不得自批');
  const byReviewer = projects.decideInternalProject(
    { name: '领域复核人', role: 'reviewer', team_id: 'team-carbon' }, created.id, { decision: 'approved', note: '已核对资料' }
  );
  assert(byReviewer.ok, '复核人应可批准');
});

test('内部项目 ↔ 公开项目关联必须人工建立并写明依据', () => {
  const ip = db.get("SELECT * FROM internal_project WHERE code = 'INV-TEST-1'");
  const pp = db.get('SELECT * FROM public_project LIMIT 1');
  const noBasis = projects.linkInternalToPublic(ANALYST, {
    internal_project_id: ip.id, public_project_id: pp.id,
  });
  assert(noBasis.error, '缺少关联依据应被拒绝');
  const ok = projects.linkInternalToPublic(ANALYST, {
    internal_project_id: ip.id, public_project_id: pp.id,
    match_basis: '登记编号一致：DEMO-PUB-0001', name_mismatch_note: '业主名称在公示后变更，已核对统一社会信用代码',
  });
  assert(ok.ok, '带依据的人工关联应通过');
});

/* ------------------------------ 碳减排测算 ------------------------------ */

test('验收用例 3：不符合 CCER-10-001 适用范围的项目 → 明确不适用依据且无数值', () => {
  const list = policy.listMethodologiesV2({ methodology_id: 'CCER-10-001' });
  const mv = list.formal.find((m) => m.methodology_id === 'CCER-10-001');
  const out = measure.precheckApplicability(RESEARCHER, {
    methodology_version_id: mv.id,
    declared_source_kind: 'project_doc',
    inputs: {
      'proj.project_type': '煤矿瓦斯回收利用',
      'gas.mine_type': '露天煤矿',                          // §2 第 1 段：仅适用于井工煤矿 → 不满足
      'gas.mine_abandoned_or_closed': 'false',
      'gas.oxidation_technology': '其他分解销毁技术',        // §2 第 3 段：仅限无焰氧化 → 不满足
      'gas.heat_utilization_route': '其他',                 // §2 a)/b)：仅限发电/供热/热电联产 → 不满足
      'gas.ch4_concentration_pct': 9,                      // §2：须低于 8% → 不满足
      'gas.diluted_from_high_concentration': 'false',
    },
  });
  assert(!out.error, `预检不应报错：${out.error || ''}`);
  assert(out.not_applicable_basis.length >= 3, `应给出多条不适用依据，实际 ${out.not_applicable_basis.length}`);
  const basis = out.not_applicable_basis.map((b) => `${b.title}${b.detail}`).join('；');
  assert(basis.includes('露天') || basis.includes('井工'), `不适用依据应说明矿井类型：${basis}`);
  assert(basis.includes('无焰氧化'), `不适用依据应说明销毁技术：${basis}`);
  assert(out.not_applicable_basis.every((b) => b.clause_ref), '每条不适用依据都应引用方法学条款');
  assert(out.not_applicable_basis.every((b) => b.detail && b.detail.length > 8), '每条不适用依据都应有原文结论措辞');
  assertEqual(out.summary.blocking_failures >= 3, true, '应统计硬性阻断条数');
  assertEqual(out.calculation_gate.can_return_numbers, false, '不得返回业务数值');
  const json = JSON.stringify(out);
  assertNotIncludes(json, '"reduction"', '结果中不应出现减排量字段');
  assert(!/\b\d{4,}\s*tCO₂e/.test(json), '结果中不应出现减排量数值');
  assertEqual(out.persisted, false, '预检不落库');
});

test('符合适用条件的输入：不给出数值，只提示可进入正式测算流程', () => {
  const list = policy.listMethodologiesV2({ methodology_id: 'CCER-10-001' });
  const mv = list.formal.find((m) => m.methodology_id === 'CCER-10-001');
  const out = measure.precheckApplicability(RESEARCHER, {
    methodology_version_id: mv.id,
    declared_source_kind: 'project_doc',
    inputs: {
      'proj.project_type': '煤矿瓦斯回收利用',
      'gas.mine_type': '井工煤矿',
      'gas.mine_abandoned_or_closed': 'false',
      'gas.oxidation_technology': '无焰氧化',
      'gas.heat_utilization_route': '热电联产',
      'gas.ch4_concentration_pct': 5,
      'gas.diluted_from_high_concentration': 'false',
    },
  });
  const states = out.rule_results.map((r) => [r.rule_id, r.state]);
  const mine = out.rule_results.find((r) => r.rule_id === 'M10-001-01');
  assert(mine, '应包含矿井类型规则 M10-001-01');
  assertEqual(mine.state, 'pass', `矿井类型应判定满足：${JSON.stringify(states)}`);
  const tech = out.rule_results.find((r) => r.rule_id === 'M10-001-03');
  assertEqual(tech.state, 'pass', '分解销毁技术应判定满足');
  assertEqual(out.summary.blocking_failures, 0, '不应有硬性阻断');
  assertEqual(out.calculation_gate.can_return_numbers, false, '预检永远不返回数值');
  assertIncludes(out.disclaimer, '初筛预检');
});

test('测算目标与运行：无档案的内部项目不能测算', () => {
  const created = projects.createInternalProject(ANALYST, { code: 'INV-TEST-3', name: '无档案项目' });
  const targets = measure.measurementTargets(ANALYST);
  const t = targets.rows.find((r) => r.internal_project_id === created.id);
  assert(t && t.can_measure === false, '无档案项目不可测算');
  assertIncludes(t.reason, '尚未建立项目档案');
});

test('因子清单：占位因子被显式标注并阻断出数', () => {
  const reg = measure.factorRegistry('CCER-10-001');
  assert(reg.factors.length >= 5, '应有因子记录');
  assert(reg.placeholder_count >= 1, '应存在占位因子');
  assertIncludes(reg.note, '阻断');
});

/* ------------------------------ 总览 ------------------------------ */

test('总览：指标带截至日期与来源，阶段不可相加', () => {
  const ov = dash.overview({});
  assert(ov.metrics.length >= 6, '顶部指标应有 6 项以上');
  for (const m of ov.metrics) {
    assert(m.as_of, `指标 ${m.label} 应有截至日期`);
    assert(m.source, `指标 ${m.label} 应标注数据源`);
    assert(m.caliber_key, `指标 ${m.label} 应可查口径`);
  }
  const progress = dash.projectProgress({});
  assert(progress.stages.length === 6, '项目进度应有六个阶段');
  assertIncludes(progress.note, '不能相加');
});

test('总览：无交易日行情时不显示 0 元价格', () => {
  const ov = dash.overview({});
  const tradeMetric = ov.metrics.find((m) => m.key === 'dash.trade_latest');
  assert(tradeMetric, '应有最新交易日指标');
  if (!tradeMetric.extra?.trade_date) {
    assertEqual(tradeMetric.value, null, '没有行情时应显示空值而不是 0');
  } else {
    assert(tradeMetric.value > 0, '有行情时成交量应大于 0');
  }
});

test('总览：市场走势四种状态分别统计', () => {
  trade.upsertTradeDaily({ trade_date: '2026-08-03', volume: 100, turnover: 9000, avg_price: 90, session_state: 'traded' }, { actor: 'test' });
  trade.rebuildCalendar(['2026-08-03'], { windowStart: '2026-08-03' });
  // 观测窗取 2026-08-03 ~ 08-07：08-03 有成交、08-04~07 未采集（数据暂缺）、08-08/09 周末超出窗口
  const m = dash.marketSeries({ range: 'all', as_of: '2026-08-07' });
  assert(m.coverage.length >= 3, `覆盖区间应包含多个日期，实际 ${m.coverage.length}`);
  const states = new Set(m.coverage.map((c) => c.state));
  assert(states.has('traded'), '应有有成交状态');
  assert(states.has('missing'), '未采集的日期应显示数据暂缺');
  const traded = m.coverage.find((c) => c.trade_date === '2026-08-03');
  assertEqual(traded.state, 'traded');
  const missing = m.coverage.find((c) => c.trade_date === '2026-08-04');
  assertEqual(missing.state, 'missing', '08-04 未采集 → 数据暂缺');
  assert(m.counts.missing >= 1, '应统计暂缺天数');
  assertIncludes(m.note, '分别显示');
  assertIncludes(m.note, '不是收盘价');
});

/* ------------------------------ 后台管理 ------------------------------ */

test('系统状态：库、任务、核对、缺口与身份说明齐备', () => {
  const st = admin.systemStatus();
  assert(st.database.path, '应返回数据库路径');
  assertEqual(st.database.is_production_db, false, '测试库不应是生产库');
  assert(st.counts.policy_document >= 8, '应统计表条数');
  assert(st.identity.note.includes('SSO'), '应如实说明尚未接入 SSO');
  assertIncludes(st.scheduler, process.env.CCER_DAILY_SYNC === '1' ? '每日自动更新已启用' : '每日自动更新当前未启用');
});

test('模型配置：凭据不下发，未配置时给出明确提示', () => {
  const providers = admin.listLlmProviders();
  assert(providers.length >= 1, '应有占位模型配置');
  const p = providers[0];
  assertEqual(p.enabled, false, '默认不启用任何外部模型');
  const json = JSON.stringify(providers);
  assertNotIncludes(json, 'sk-', '响应中不得含密钥样式字符串');
  assertNotIncludes(json, 'api_key', '响应中不得含 api_key 字段');
  const status = admin.llmStatus();
  assertEqual(status.any_ai_available, false, '默认 AI 全部关闭');
  assertIncludes(status.note, '不受影响');
});

test('模型配置：禁止把任意地址与空白名单写入配置', () => {
  const noDomain = admin.upsertLlmProvider(ADMIN, {
    name: '测试模型', base_url: 'https://llm.example.com/v1', model: 'test-model', allowed_domains: [],
  });
  assert(noDomain.error, '空域名白名单应被拒绝');
  const badUrl = admin.upsertLlmProvider(ADMIN, {
    name: '测试模型', base_url: 'file:///etc/passwd', model: 'test-model', allowed_domains: ['llm.example.com'],
  });
  assert(badUrl.error, '非 http(s) 地址应被拒绝');
});

test('模型配置：未设置服务端密钥时拒绝保存明文凭据', () => {
  const keep = process.env.CCER_SECRET_KEY;
  delete process.env.CCER_SECRET_KEY;
  try {
    const out = admin.upsertLlmProvider(ADMIN, {
      name: '测试模型2', base_url: 'https://llm.example.com/v1', model: 'test-model',
      allowed_domains: ['llm.example.com'], secret: 'plain-text-secret',
    });
    assert(out.error, '无 CCER_SECRET_KEY 时应拒绝保存明文凭据');
    assertIncludes(out.message || out.error, '环境变量');
  } finally {
    if (keep) process.env.CCER_SECRET_KEY = keep;
  }
});

test('用户与权限：非管理员不能管理用户，管理员可停用但不能停用自己', () => {
  const denied = admin.upsertUser(RESEARCHER, { id: 'user-x', name: 'X', role: 'viewer' });
  assertEqual(denied.status, 403, '研究员不得创建用户');
  const created = admin.upsertUser(ADMIN, { id: 'user-test-v2', name: '测试用户', role: 'analyst', team_id: 'team-invest' });
  assert(created.ok, '管理员应可创建用户');
  assertEqual(created.note.includes('口令'), true, '应提示需设置初始口令');
  const selfDisable = admin.upsertUser(
    { id: 'user-admin', name: '系统管理员', role: 'admin', team_id: 'team-carbon' },
    { id: 'user-admin', role: 'admin', active: false }
  );
  assert(selfDisable.error, '不得停用当前登录账号');
});

test('口令策略：长度与复杂度不足被拒绝，合格口令写入 scrypt 哈希', () => {
  const weak = admin.resetUserPassword(ADMIN, 'user-test-v2', { password: 'short' });
  assert(weak.error, '弱口令应被拒绝');
  const ok = admin.resetUserPassword(ADMIN, 'user-test-v2', { password: 'Abcd1234Efgh', must_change: true });
  assert(ok.ok, '合格口令应通过');
  const row = db.get('SELECT * FROM app_user WHERE id = ?', ['user-test-v2']);
  assertIncludes(row.password_hash, 'scrypt$', '应存 scrypt 哈希');
  assert(!row.password_hash.includes('Abcd1234Efgh'), '不得存明文');
  assertEqual(row.must_change_password, 1, '应要求首次改密');
});

test('数据源配置：出站域名白名单与 URL 协议受校验', () => {
  const bad = admin.upsertDatasource(ADMIN, {
    name: '内网地址', url: 'http://192.168.1.10/data.json', source_kind: 'authorized_api', parser: 'json',
  });
  assert(bad.error, '内网/非 http 地址应被拒绝或被采集层阻断');
  const ok = admin.upsertDatasource(ADMIN, {
    name: '测试官方源', url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/', source_kind: 'official_page',
    parser: 'html_list', frequency: 'daily', data_owner: '政策研究员', license_note: '公开信息',
    allowed_domains: ['www.mee.gov.cn'],
  });
  assert(ok.ok, '合法数据源应可保存');
  const list = admin.listDatasources();
  const created = list.find((d) => d.id === ok.id);
  assertEqual(created.allowed_domains[0], 'www.mee.gov.cn', '白名单应保存');
});

test('采集层：出站 URL 校验拒绝私网与未登记域名', () => {
  const { collect } = ctx;
  assertEqual(collect.checkOutboundUrl('http://127.0.0.1/x').ok, false, '本机地址应拒绝');
  assertEqual(collect.checkOutboundUrl('http://10.0.0.5/x').ok, false, '私网地址应拒绝');
  assertEqual(collect.checkOutboundUrl('https://evil.example.com/x').ok, false, '未登记域名应拒绝');
  assertEqual(collect.checkOutboundUrl('https://www.mee.gov.cn/a').ok, true, '官方域名应放行');
  assertEqual(collect.checkOutboundUrl('file:///etc/passwd').ok, false, '非 http(s) 应拒绝');
});

test('指标口径说明可由研究员维护并留痕', () => {
  const metrics = admin.listMetricDefinitions();
  assert(metrics.length >= 8, '应有指标口径定义');
  const key = metrics[0].key;
  const out = admin.updateMetricDefinition(RESEARCHER, key, { caliber: '更新后的口径说明（测试）' });
  assert(out.ok, '研究员应可维护口径');
  const after = admin.listMetricDefinitions().find((m) => m.key === key);
  assertIncludes(after.caliber, '更新后的口径说明');
  const log = db.get("SELECT * FROM audit_log WHERE action = 'metric.update' ORDER BY at DESC LIMIT 1");
  assert(log, '口径维护应写入审计');
});

test('导出审计：导出动作记录操作人、数据集与行数', () => {
  const before = db.get('SELECT COUNT(*) c FROM export_log').c;
  const out = ctx.exportSvc.buildExport({
    user: ANALYST, dataset: '公开项目库', fileBase: 'pp', format: 'csv',
    columns: [{ key: 'name', label: '名称' }], rows: [{ name: 'A' }], meta: {}, filters: { province: '山西省' },
  });
  assert(out.file_name.endsWith('.csv'), '应生成文件名');
  const after = db.get('SELECT COUNT(*) c FROM export_log').c;
  assertEqual(after, before + 1, '应新增一条导出审计');
  const last = db.get('SELECT * FROM export_log ORDER BY at DESC LIMIT 1');
  assertEqual(last.actor, '投资分析师');
  assertIncludes(last.filters_json, '山西省');
});

finish('test/13-v2-modules.test.mjs');
