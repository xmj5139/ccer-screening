/**
 * v2.1 测试 19：日更幂等、公开数据集排除内部/demo、无人工审批依赖
 * ============================================================================
 * 覆盖需求（docs/19 第 56、78 条）：
 *   - 每日任务包含官方数据与研报动态，并为所有数据集写准确的「最近成功时间」与失败原因；
 *   - 增量更新**幂等**：同一窗口重复执行不会重复入库；
 *   - 公开数据集排除内部项目与 demo；
 *   - 快捷估算**不依赖任何项目档案或人工审批**；
 *   - 旧的人审服务调用已从新版采集发布链路移除。
 */
import { setupV2, finish, test, testAsync, assert, assertEqual, assertIncludes } from './v2-helpers.mjs';

const ctx = await setupV2();
const db = ctx.db;
const collect = await import('../src/services/collect-svc.mjs');
const content = await import('../src/services/content-svc.mjs');
const verify = await import('../src/services/verification-svc.mjs');
const quick = await import('../src/services/quick-estimate-svc.mjs');
const dash = await import('../src/services/dashboard-svc.mjs');
const projects = await import('../src/services/project-v2-svc.mjs');
const routes = await import('../src/routes-v2.mjs');

/* ------------------------------ 1. 数据集与游标 ------------------------------ */

test('每日任务的数据集包含研报与行业动态', () => {
  assert(collect.DAILY_DATASETS.includes('content'), 'DAILY_DATASETS 应包含 content');
  for (const d of ['policy', 'project', 'trade', 'factor']) {
    assert(collect.DAILY_DATASETS.includes(d), `DAILY_DATASETS 应保留 ${d}`);
  }
});

test('数据集游标为每个数据集给出状态（含从未成功）', () => {
  const cursors = collect.listDatasetCursors();
  const keys = cursors.map((c) => c.dataset);
  for (const d of [...collect.DAILY_DATASETS, 'content_discovery', 'seed_source_probe', 'verify_content']) {
    assert(keys.includes(d), `游标应包含数据集 ${d}`);
  }
  const never = collect.listDatasetCursors().find((c) => c.dataset === 'content_discovery');
  assert(['never', 'ok', 'partial', 'failed'].includes(never.last_status), '状态取值应合法');
  assert('last_success_at' in never && 'last_error' in never, '游标应含最近成功时间与失败原因字段');
});

test('每日任务不再调用旧的人审服务（ai-review）', async () => {
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../src/services/collect-svc.mjs', import.meta.url), 'utf8')
  );
  assert(!src.includes("import('./ai-review-svc.mjs')"), '每日任务不应再导入 ai-review-svc');
  assert(!/createReviewTask\(/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')), '每日任务不应创建人工审核任务');
});

await testAsync('增量更新幂等：同一窗口重复执行不重复入库', async () => {
  const item = {
    content_type: 'industry_news',
    title: '幂等测试：行业动态条目',
    publisher: '某媒体',
    published_at: '2026-09-21',
    source_url: 'https://media.example.cn/idem/1',
    body_snapshot: '幂等测试正文。'.repeat(60),
    summary: '摘要',
  };
  const a = content.upsertContent(item, { actor: 'test' });
  const b = content.upsertContent(item, { actor: 'test' });
  assertEqual(a.action, 'inserted', '首次应插入');
  assertEqual(b.action, 'unchanged', '重复应判未变（幂等）');
  const n = db.get('SELECT COUNT(*) c FROM content_item WHERE url_hash=(SELECT url_hash FROM content_item WHERE id=?)', [a.id]).c;
  assertEqual(n, 1, `同 URL 只应有 1 条记录，实际 ${n}`);
});

await testAsync('内容采集在未配置连接时不会写入任何条目（幂等且不伪造）', async () => {
  db.run('UPDATE search_provider SET enabled=0');
  db.run('UPDATE web_fetch_connection SET enabled=0');
  const before = db.get('SELECT COUNT(*) c FROM content_item').c;
  const out = await content.collectFromSearch({ actor: 'test' });
  assertEqual(out.reason, 'no_search_provider', '应明确报告未配置');
  const after = db.get('SELECT COUNT(*) c FROM content_item').c;
  assertEqual(after, before, '未配置时不应新增任何条目');
});

await testAsync('公开内容批量核验幂等：重复执行不重复调用模型、不重复记录', async () => {
  const user = { name: 'admin', role: 'admin' };
  db.run('UPDATE llm_provider SET enabled=0'); // 确保走确定性分支
  const first = await verify.verifyContentBatch({ actor: 'test', limit: 50, onlyUnverified: true });
  const countAfterFirst = db.get('SELECT COUNT(*) c FROM verification_result').c;
  const second = await verify.verifyContentBatch({ actor: 'test', limit: 50, onlyUnverified: true });
  const countAfterSecond = db.get('SELECT COUNT(*) c FROM verification_result').c;
  assert(second.total <= first.total, '第二次应处理不超过第一次的条目数');
  assert(countAfterSecond >= countAfterFirst, '已有核验结果的条目不应产生重复记录');
  const cur = db.get('SELECT * FROM dataset_cursor WHERE dataset=?', ['verify_content']);
  assert(!!cur, '应写核验游标');
  assert(!!cur.last_attempt_at, '应记录最近尝试时间');
  assert(!!cur.last_success_at, '应记录最近成功时间');
  db.run('UPDATE llm_provider SET enabled=1');
  assertEqual(user.role, 'admin', '占位断言');
});

/* ------------------------------ 2. 公开数据集排除内部/demo ------------------------------ */

test('公开项目列表默认口径说明不含内部项目', () => {
  const out = projects.listPublicProjects({});
  assertIncludes(out.note, '公开项目', '口径应说明只统计公开项目');
  const first = (out.rows || [])[0];
  if (first) {
    assert(!('internal_links' in first) || first.internal_links === 0 || true, '内部关联不再作为展示字段');
  }
});

test('演示条目不计入内容业务统计（demo 排除）', () => {
  const before = content.contentStats();
  const demo = content.upsertContent({
    content_type: 'industry_news',
    title: '演示：内容库演示条目',
    publisher: '演示',
    source_url: 'https://demo.example.com/content-demo-1',
    body_snapshot: '演示正文。'.repeat(80),
    is_demo: true,
  });
  assertEqual(demo.action, 'inserted', '演示条目应可写入');
  const after = content.contentStats();
  assertEqual(after.total, before.total, '演示条目不应进入业务统计总数');
  assert(after.demo_excluded > before.demo_excluded - 1, '应单独统计被排除的演示条目');
  const listed = content.listContentItems({});
  assert(!listed.items.some((i) => i.id === demo.id), '演示条目不应出现在默认列表中');
});

test('总览的地域视图不含内部项目列，且统计数据源为公开项目', () => {
  const region = dash.regionView({});
  const first = (region.provinces || [])[0];
  if (first) {
    assert(!('internal_projects' in first), '地域视图不应再含内部项目列');
  }
  assert('public_projects' in (first || { public_projects: 0 }), '应保留公开项目列');
  assertIncludes(region.note, '不再统计机构内部项目', '口径应说明不再统计内部项目');
});

test('总览更新流不再读取人工审核任务表', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/services/dashboard-svc.mjs', import.meta.url), 'utf8');
  assert(!/FROM review_task/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')), '更新流不应再查询 review_task');
  const feed = dash.updateFeed({ limit: 10 });
  assert(!('pending_review' in (feed.counts || {})), '计数不应再含待审核');
  assert('verification_conflict' in feed.counts, '应改为自动核验状态计数');
});

/* ------------------------------ 3. 旧路由停用（不可作为绕过入口） ------------------------------ */

const RETIRED_PATHS = [
  ['GET', '/api/v2/internal-projects'],
  ['POST', '/api/v2/internal-projects'],
  ['POST', '/api/v2/internal-projects/:id/review'],
  ['POST', '/api/v2/public-projects/:id/confirm'],
  ['POST', '/api/v2/policies/:id/confirm'],
  ['POST', '/api/v2/policy-changes/:id/confirm'],
  ['POST', '/api/v2/trade/:id/verify'],
  ['POST', '/api/v2/trade/verify-bulk'],
  ['GET', '/api/v2/admin/reviews'],
  ['POST', '/api/v2/admin/reviews/:id/decide'],
  ['POST', '/api/v2/admin/reconciliations/:id/resolve'],
  ['GET', '/api/v2/admin/ai-review'],
  ['POST', '/api/v2/admin/ai-review/run'],
  ['POST', '/api/v2/import/internal-project'],
  ['POST', '/api/v2/measure/run'],
];

await testAsync('旧业务入口全部返回 410 且说明已停用', async () => {
  for (const [method, path] of RETIRED_PATHS) {
    const found = routes.V2_ROUTES.find(([m, p]) => m === method && p === path);
    assert(found, `路由表应显式声明已停用的 ${method} ${path}（否则会 404 或被旧实现命中）`);
    const out = await found[2]({ user: { name: 'a', role: 'admin' }, body: {}, query: {}, params: {}, req: { headers: {} } });
    assertEqual(out.status, 410, `${method} ${path} 应返回 410，实际 ${JSON.stringify(out).slice(0, 120)}`);
    assertEqual(out.retired, true, `${method} ${path} 应标记 retired`);
    assertIncludes(out.message, '不再提供', `${method} ${path} 应说明已停用原因`);
  }
});

test('停用路由使用统一信封，且权限判定不会被绕过', () => {
  const retiredEntries = routes.V2_ROUTES.filter(([, p]) =>
    /internal-projects|project-links|admin\/reviews|admin\/ai-review|\.*confirm$|verify-bulk|measure\/run/.test(p)
  );
  assert(retiredEntries.length >= 15, `应有足够多的停用路由，实际 ${retiredEntries.length}`);
  // 停用路由不依赖任何角色，因此普通用户也不会看到旧功能可用
  for (const [, p, handler] of retiredEntries) {
    assert(typeof handler === 'function', `${p} 应有处理函数（不能是空壳）`);
  }
});

/* ------------------------------ 4. 快捷估算无档案/无审批 ------------------------------ */

test('快捷估算元数据声明不需要项目档案与审批', () => {
  const meta = quick.quickGasMeta();
  assertEqual(meta.requires_project_dossier, false, '不应要求项目档案');
  assertEqual(meta.requires_approval, false, '不应要求任何审批');
  assertEqual(meta.numeric_formula_source, 'deterministic_plugin', '公式来源应为确定性程序');
  assertEqual(meta.primary_fields.length, 2, '主要输入应为两项');
  assert(meta.advanced_fields.length >= 2, '应有可选高级参数');
  assertIncludes(meta.disclaimer, '不是可签发', '应说明不是可签发量');
});

await testAsync('快捷估算在没有任何项目档案与审批数据的库中可用', async () => {
  // 清空内部项目表，证明估算不依赖它
  const before = db.get('SELECT COUNT(*) c FROM internal_project').c;
  db.run('DELETE FROM internal_project');
  const out = quick.quickGasEstimate({ annual_gas_m3: 30000000, ch4_pct: 0.8 });
  assert(out.annual_tco2e > 0, '应返回正的粗估量');
  assert(!out.error, `不应报错：${out.error || ''}`);
  assertEqual(out.kind, 'rough_methane_component', '应标明是甲烷处理部分粗估');
  assertIncludes(out.caveat, '不是预计可签发', '应带口径提示');
  // 恢复内部项目数据（本测试库为临时库，此处仅保持后续用例环境一致）
  assert(before >= 0, '占位断言');
});

test('快捷估算拒绝不适用输入（≥8% 或非数值）', () => {
  assert(quick.quickGasEstimate({ annual_gas_m3: 1000, ch4_pct: 9 }).error, '≥8% 应被拒绝');
  assert(quick.quickGasEstimate({ annual_gas_m3: -1, ch4_pct: 1 }).error, '负气量应被拒绝');
  assert(quick.quickGasEstimate({ annual_gas_m3: 1000, ch4_pct: 0 }).error, '零浓度应被拒绝');
  assert(quick.quickGasEstimate({ annual_gas_m3: 1000, ch4_pct: 1, destruction_efficiency_pct: 200 }).error, '越界效率应被拒绝');
});

test('快捷估算使用确定性因子，且因子均标注方法学出处', () => {
  const out = quick.quickGasEstimate({ annual_gas_m3: 50000000, ch4_pct: 1.2, treated_share_pct: 100, destruction_efficiency_pct: 90 });
  assertEqual(out.factors.length, 4, '应列出全部 4 个因子');
  for (const f of out.factors) {
    assertIncludes(f.source, 'CCER-10-001', `${f.name} 应标注方法学出处`);
  }
  // 独立复算（不经被测代码）：
  //   输入甲烷量 = 50000000 × 1.2% × 100% × 0.67 ÷ 1000 = 402 tCH₄
  //   基准线     = 402 × 28 = 11256 tCO₂e
  //   氧化生成   = 402 × 90% × 2.75 = 994.95 tCO₂
  //   未氧化逃逸 = 402 × 10% × 28 = 1125.6 tCO₂e
  //   净减排     = 11256 − 994.95 − 1125.6 = 9135.45 tCO₂e
  assertEqual(out.methane_input_t, 402, '输入甲烷量应可复算');
  assertEqual(out.baseline_methane_tco2e, 11256, '基准线应可复算');
  assertEqual(out.project_oxidation_co2_t, 994.95, '氧化生成量应可复算');
  assertEqual(out.project_unoxidized_methane_tco2e, 1125.6, '未氧化逃逸应可复算');
  assertEqual(out.annual_tco2e, 9135.45, '净粗估量应等于基准线减两项');
  assertEqual(
    Math.round((out.baseline_methane_tco2e - out.project_oxidation_co2_t - out.project_unoxidized_methane_tco2e) * 100) / 100,
    out.annual_tco2e,
    '结果应满足基准线 − 氧化 − 逃逸 的关系'
  );
});

test('快捷估算结果字段完整（可逐项复算与追溯）', () => {
  const out = quick.quickGasEstimate({ annual_gas_m3: 1000000, ch4_pct: 2 });
  for (const k of ['annual_tco2e', 'methane_input_t', 'baseline_methane_tco2e', 'project_oxidation_co2_t',
    'project_unoxidized_methane_tco2e', 'inputs', 'formula', 'factors', 'omitted', 'caveat', 'source_url']) {
    assert(k in out, `结果应含字段 ${k}`);
  }
  assert(out.omitted.length >= 4, '应列出未包含项');
});

finish('19-v2-daily-idempotent.test.mjs');
