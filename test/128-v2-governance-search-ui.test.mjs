/**
 * 测试 128（docs/74 交付）：四项功能的 HTTP 入口、权限与前端可操作入口。
 * 隔离库；不联网。后台补采在未配置真实搜索连接时必须明确阻塞，不伪造成功。
 */
import { readFile } from 'node:fs/promises';
import {
  setupV2, test, testAsync, assert, assertEqual, assertIncludes, finish,
} from './v2-helpers.mjs';

const ctx = await setupV2({ withPublicDemo: false });
const { db, auth } = ctx;
const now = new Date().toISOString();

console.log('\n[v2-128] 信息治理与统一检索：API/前端入口验收');

db.run(
  `INSERT INTO methodology_version (id,methodology_id,code_display,name,version,document_status,release_date,effective_date,official_url,body_snapshot,catalog_confidence,is_candidate_eligible,created_at,updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ['MV-128A', 'M-128', 'CCER-M-128-A', '测试方法学 A', 'V01', 'formal', '2026-01-01', '2026-02-01',
    'https://www.mee.gov.cn/m/128a.pdf', '项目边界说明。计入期 10 年。监测要求按月计量。', 'verified_from_official_notice', 1, now, now]
);
db.run(
  `INSERT INTO methodology_version (id,methodology_id,code_display,name,version,document_status,release_date,effective_date,official_url,body_snapshot,catalog_confidence,is_candidate_eligible,created_at,updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ['MV-128B', 'M-128', 'CCER-M-128-B', '测试方法学 B', 'V02', 'formal', '2026-10-01', '2099-11-01',
    'https://www.mee.gov.cn/m/128b.pdf', '项目边界说明修订。计入期 7 年。监测要求按月计量电量。', 'verified_from_official_notice', 1, now, now]
);

const appJs = await readFile(new URL('../web/v2/app.js', import.meta.url), 'utf8');
const searchJs = await readFile(new URL('../web/v2/modules/search.js', import.meta.url), 'utf8');
const governanceJs = await readFile(new URL('../web/v2/modules/governance.js', import.meta.url), 'utf8');
const policiesJs = await readFile(new URL('../web/v2/modules/policies.js', import.meta.url), 'utf8');
const adminJs = await readFile(new URL('../web/v2/modules/admin.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../web/v2/styles.css', import.meta.url), 'utf8');

test('前端：顶栏检索入口 + 独立搜索页；主模块仍是 8 个', () => {
  assertIncludes(appJs, 'topbar-search', '顶栏应有统一检索入口');
  assertIncludes(appJs, 'renderSearch', '应挂载统一检索页');
  assertIncludes(appJs, "key === 'search'", '应支持 #/search 路由');
  assertIncludes(appJs, 'SEARCH_MODULE', '应有独立检索页描述');
  const mods = [...appJs.matchAll(/key: '(\w+)', label: '([^']+)'/g)].map((m) => m[2]);
  assertEqual(mods.length, 8, `主模块应保持 8 个，实际 ${mods.length}：${mods.join('、')}`);
  for (const need of ['highlightText', 'data-search-type', 'data-search-filter', 'data-search-page', 'sourceBlock']) {
    assertIncludes(searchJs, need, `搜索页应包含 ${need}`);
  }
  assertIncludes(searchJs, 'esc(part)', '高亮必须对每个片段转义');
  assertIncludes(searchJs, '<mark>', '应使用 mark 表达高亮');
  assert(!searchJs.includes('innerHTML = r.snippet'), '不得把摘要直接当 HTML 写入');
});

test('前端：后台信息治理/补采/方法学时间线入口齐备', () => {
  assertIncludes(adminJs, '信息治理与历史补采', '后台应新增信息治理页签');
  assertIncludes(adminJs, 'renderGovernance', '后台应挂载治理模块');
  for (const need of [
    '/api/v2/admin/governance/pipeline', '/api/v2/admin/governance/process', '/api/v2/admin/governance/retry',
    '/api/v2/admin/backfill/preview', '/api/v2/admin/backfill/tasks', '/api/v2/methodology-relations',
    '/api/v2/admin/document-upload',
  ]) assertIncludes(governanceJs, need, `治理页应调用 ${need}`);
  for (const need of ['阶段漏斗', '预览计划', '暂停', '继续', '取消', '重试', '页码游标', '段落/页码定位', '补传原件']) {
    assertIncludes(governanceJs, need, `治理页应包含「${need}」`);
  }
  assertIncludes(policiesJs, '/timeline', '方法学详情应读取版本时间线');
  assertIncludes(policiesJs, '/diff?compare_to=', '方法学详情应可比较版本差异');
  assertIncludes(policiesJs, '无法比较', '证据不足时必须明确无法比较');
  assertIncludes(styles, '.search-results', '应有检索结果样式');
  assertIncludes(styles, '.funnel', '应有阶段漏斗样式');
  assertIncludes(styles, '.version-lineage', '应有版本时间线样式');
});

await testAsync('HTTP：统一检索、版本时间线/差异、后台治理与补采入口', async () => {
  const adminUser = db.get("SELECT * FROM app_user WHERE role='admin' AND active=1 LIMIT 1");
  const token = auth.createSession(adminUser.id, { actor: 'test:128' }).token;
  const { server } = await import('../src/server.mjs');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = 'GET', body = null } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  try {
    const search = await call('/api/v2/search?q=' + encodeURIComponent('项目边界'));
    assertEqual(search.status, 200);
    assert(Array.isArray(search.body.results));

    const timeline = await call('/api/v2/methodology-versions/MV-128A/timeline');
    assertEqual(timeline.status, 200, JSON.stringify(timeline.body));
    assert(timeline.body.formal.length >= 2, '应返回正式版本列表');
    assert(timeline.body.timeline.find((v) => v.id === 'MV-128B').future_effective === true);

    const diff = await call('/api/v2/methodology-versions/MV-128B/diff?compare_to=MV-128A');
    assertEqual(diff.status, 200, JSON.stringify(diff.body));
    assertEqual(diff.body.diffs.length, 5);
    const boundary = diff.body.diffs.find((d) => d.aspect === 'boundary');
    assert(['changed', 'insufficient'].includes(boundary.change_kind));
    assert(boundary.evidence.length >= 1, '差异应带来源定位');

    const pipeline = await call('/api/v2/admin/governance/pipeline');
    assertEqual(pipeline.status, 200);
    assertEqual(pipeline.body.funnel.length, 5);
    const sync = await call('/api/v2/admin/governance/sync', { method: 'POST', body: { limit: 50 } });
    assertEqual(sync.status, 200);

    const sources = await call('/api/v2/admin/backfill/sources');
    assertEqual(sources.status, 200);
    assert(sources.body.datasets.find((d) => d.key === 'content').supported === true);
    const preview = await call('/api/v2/admin/backfill/preview', {
      method: 'POST',
      body: { dataset: 'content', date_from: '2026-09-01', date_to: '2026-09-05', window_days: 2, group_keys: ['ccer'] },
    });
    assertEqual(preview.status, 200);
    assert(Array.isArray(preview.body.blocking_reasons), '未配置真实连接时预览应说明阻塞原因');
    assertEqual(preview.body.date_filter_supported, false, '测试库未配置声明日期字段的搜索连接');
    const create = await call('/api/v2/admin/backfill/tasks', {
      method: 'POST',
      body: { dataset: 'content', date_from: '2026-09-01', date_to: '2026-09-05', window_days: 2, group_keys: ['ccer'] },
    });
    assertEqual(create.status, 409, '没有真实日期条件能力时必须拒绝创建，而不是假装可运行');
    assertIncludes(create.body.error, '日期条件');

    const relation = await call('/api/v2/methodology-relations', {
      method: 'POST',
      body: {
        from_version_id: 'MV-128B', to_version_id: 'MV-128A', relation_type: 'supersedes',
        evidence_url: 'https://www.mee.gov.cn/m/128a.pdf',
        evidence_locator: '正文第 1 段', evidence_quote: '计入期 10 年',
      },
    });
    assertEqual(relation.status, 200, JSON.stringify(relation.body));
    assertEqual(relation.body.confirmed, false, '未通过既有核验前只能保持候选');
  } finally {
    server.unref();
    await new Promise((r) => server.close(r));
  }
});

finish('test/128-v2-governance-search-ui.test.mjs');
