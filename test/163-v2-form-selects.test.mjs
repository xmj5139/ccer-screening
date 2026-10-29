/**
 * 163-v2-form-selects.test.mjs —— 表单选择优化（docs/84）
 * ============================================================================
 * 覆盖：
 *   1. 共享选择工具：选项 value/label/旧值转义，空值「全部」，未知 query 值保留；
 *   2. datalist：来源/方法学不完整清单仍可自由输入，不硬限制；
 *   3. 管理员编辑字段：有限枚举下拉、URL 原值保留、旧值不在目录时仍选中；
 *   4. 真实选项接口：省份/方法学/CEA 行业与年度/来源建议来自隔离临时库；
 *   5. 后端筛选不变：项目省份、CEA 省份别名/行业/年度、统一检索地区；
 *   6. 清空筛选（空 query 值）回到全部，不改变筛选语义。
 * 隔离库；不联网；finish 失败时以非零码退出。
 */
import {
  setupV2, test, testAsync, assert, assertEqual, assertIncludes, assertNotIncludes, finish,
} from './v2-helpers.mjs';
import { readFile } from 'node:fs/promises';
import {
  editFieldControl, normalizeOptions, selectOptionsHtml, datalistHtml,
} from '../web/v2/form-selects.js';

const ctx = await setupV2({ withPublicDemo: false });
const { db, auth } = ctx;
const now = '2026-10-22T00:00:00.000Z';

console.log('\n[v2-163] 表单选择优化：选项 / 旧值 / 清空 / 后端筛选');

/* ------------------------------ 隔离夹具 ------------------------------ */

db.run(
  `INSERT INTO public_project (id,registry_project_no,name,owner_name,province,city,domain,methodology_id,current_stage,official_url,last_checked_at,note,created_at,updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ['PP-163-FJ', 'R-163-FJ', '福建测试项目', '福建测试业主', '福建省', '福州市', '林业碳汇', 'CCER-10-001',
    'project_registered', 'https://ccer.cets.org.cn/project/163-fj', '2026-10-20', '测试项目', now, now]
);
db.run(
  `INSERT INTO public_project (id,registry_project_no,name,owner_name,province,city,domain,methodology_id,current_stage,official_url,last_checked_at,note,created_at,updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ['PP-163-XJ', 'R-163-XJ', '兵团历史值项目', '兵团测试业主', '新疆建设兵团', '乌鲁木齐', '林业碳汇', 'CCER-10-001',
    'project_public', 'https://ccer.cets.org.cn/project/163-xj', '2026-10-20', '历史省份写法', now, now]
);
db.run(
  `INSERT INTO cea_entity (id,entity_key,name,credit_code,province,city,sector,list_year,status,source_url,data_as_of,verify_status,created_at,updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ['ENT-163-FJ', 'credit:163-fj', '福建测试电厂', null, '福建省', '福州市', '发电', 2026, 'existing',
    'https://example.test/entity/163-fj', '2026-09-30', 'unverified', now, now]
);
db.run(
  `INSERT INTO cea_entity (id,entity_key,name,credit_code,province,city,sector,list_year,status,source_url,data_as_of,verify_status,created_at,updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ['ENT-163-NM', 'credit:163-nm', '内蒙古测试钢厂', null, '内蒙古', '包头市', '钢铁', 2025, 'existing',
    'https://example.test/entity/163-nm', '2026-09-30', 'unverified', now, now]
);
db.run(
  `INSERT INTO cea_document (id,doc_key,doc_type,title,issuer,publish_date,official_url,body_snapshot,evidence_level,covered_sectors,applicable_years,coverage_json,created_at,updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ['CEADOC-163', 'cea-doc-163', 'policy', '行业×年度配对测试文件', '测试生态环境厅', '2026-09-12',
    'https://example.test/cea/163.html', '公开文件正文。', 'full_text',
    '["发电","钢铁"]', '[2025,2026]',
    '[{"sector":"钢铁","years":[2026]},{"sector":"发电","years":[2025,2026]}]', now, now]
);
db.run(
  `INSERT INTO cea_intention (id,intention_key,published_date,instrument_label,quota_year,direction,volume,price,verify_status,created_at,updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ['INT-163', 'intent-163', '2026-10-20', 'CEA', 2026, 'buy', 100, 80.5, 'unverified', now, now]
);
db.run(
  `INSERT INTO emission_factor
     (id,identity_key,source_identity,source_code,name,value,original_unit,gas,category,caliber,region,
      data_year,publish_date,version,locator,original_url,evidence_level,is_current,created_at,updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ['EF-163', 'ef-163', 'test-source:163', 'TEST-163', '华北电网测试因子', 0.55, 'kgCO2/kWh', 'CO2',
    'regional_average', '测试口径', '华北', 2025, '2026-09-11', 'v1', '表 1',
    'https://example.test/factor/163', 'metadata_only', 1, now, now]
);
db.run(
  `INSERT INTO policy_document (id,policy_key,title,category,doc_status,publish_date,summary,official_url,body_snapshot,collected_at,created_at,updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ['POL-163', 'pol-163', 'URL 原值保留测试政策', 'climate', 'effective', '2026-09-10',
    '测试摘要。', 'https://www.mee.gov.cn/policy/163.html?v=1&from=old', '公开政策原文。', now, now, now]
);

/* ------------------------------ 共享工具 ------------------------------ */

test('选项转义：value/label/当前旧值都不会成为 HTML', () => {
  const html = selectOptionsHtml(
    [{ value: 'a"&<b>', label: '<img src=x onerror=alert(1)>' }],
    '<script>alert("old")</script>',
    { allLabel: '全部' },
  );
  assertIncludes(html, 'a&quot;&amp;&lt;b&gt;', 'value 应转义');
  assertIncludes(html, '&lt;img src=x onerror=alert(1)&gt;', 'label 应转义');
  assertIncludes(html, '&lt;script&gt;alert(&quot;old&quot;)&lt;/script&gt;', '旧值应转义');
  assertNotIncludes(html, '<img src=x', '不得输出未转义 label');
  assertNotIncludes(html, '<script>', '不得输出未转义旧值');
  assertIncludes(html, ' selected', '历史值应保持选中');
});

test('旧值保留：不在选项表中的 query 值仍作为「历史值」选中，不静默改回全部', () => {
  const html = selectOptionsHtml(['福建省', '全国'], '未知历史省', { allLabel: '全部省份' });
  assertIncludes(html, 'value="未知历史省" selected', '应保留未知旧值并选中');
  assertIncludes(html, '未知历史省（历史值）', '应标注历史值');
  assertNotIncludes(html, '<option value="" selected', '不应把未知旧值重置为全部');
  const urlCurrent = selectOptionsHtml(['全国'], 'https://example.test/a?b=1&c=2');
  assertIncludes(urlCurrent, 'value="https://example.test/a?b=1&amp;c=2" selected', 'URL 形式的旧 query 值也应保留并转义');
});

test('空值「全部」：清空筛选时空 option 选中，值为空', () => {
  const html = selectOptionsHtml(['福建省'], '', { allLabel: '全部省份' });
  assertIncludes(html, '<option value="" selected>全部省份</option>', '空值应代表全部并选中');
});

test('datalist：来源/机构建议不限制自由输入，当前值也进入建议', () => {
  const html = datalistHtml('source-options', ['生态环境部'], '历史机构');
  assertIncludes(html, '<datalist id="source-options">', '应输出 datalist');
  assertIncludes(html, 'value="历史机构"', '当前值应进入建议');
  assertIncludes(html, 'value="生态环境部"', '已知机构应进入建议');
  const escaped = datalistHtml('x"><script>', [{ value: 'a"&<b>', label: '<img onerror=x>' }], '<old>');
  assertNotIncludes(escaped, '<script>', 'datalist id 不得注入');
  assertNotIncludes(escaped, '<img', 'datalist label 不得注入');
  assertIncludes(escaped, '&lt;img onerror=x&gt;', 'datalist label 应转义');
});

test('管理员编辑：有限枚举为下拉，旧值/URL 原值保留，方法学仍可自由输入', () => {
  const province = editFieldControl(
    { key: 'province', label: '省份', type: 'text' },
    '历史省',
    { provinces: [{ value: '福建省', label: '福建省' }] },
  );
  assertIncludes(province, '<select data-edit-field="province">', '省份应为下拉');
  assertIncludes(province, 'value="历史省" selected', '目录外旧值应保留');

  const url = editFieldControl(
    { key: 'official_url', label: '官方原文链接', type: 'url' },
    'https://example.test/a?b=1&c=2',
    {},
  );
  assertIncludes(url, 'type="url"', 'URL 字段应保留 URL 输入');
  assertIncludes(url, 'value="https://example.test/a?b=1&amp;c=2"', 'URL 原值应原样保留并转义');
  assertNotIncludes(url, '<select', 'URL 不得被下拉替换');

  const methodology = editFieldControl(
    { key: 'methodology_id', label: '方法学编号', type: 'text', max: 80 },
    'M-UNKNOWN',
    { methodologies: [{ value: 'CCER-10-001', label: 'CCER-10-001' }] },
  );
  assertIncludes(methodology, 'list="edit-methodology-options"', '方法学应使用 datalist');
  assertIncludes(methodology, 'value="M-UNKNOWN"', '目录外方法学旧值应保留');
  assertNotIncludes(methodology, '<select', '方法学不应被硬限制为下拉');
});

test('选项去重：同 value 不会重复，空 value 丢弃', () => {
  const rows = normalizeOptions(['福建省', { value: '福建省', label: '重复' }, { value: '', label: '空' }, null]);
  assertEqual(rows.length, 1, '重复值与空值应去重');
  assertEqual(rows[0].label, '福建省', '首个 label 保留');
});

await testAsync('页面接线：优先字段确实使用共享选择工具，而不是回退文本手填', async () => {
  const projectsJs = await readFile(new URL('../web/v2/modules/projects.js', import.meta.url), 'utf8');
  const searchJs = await readFile(new URL('../web/v2/modules/search.js', import.meta.url), 'utf8');
  const ceaJs = await readFile(new URL('../web/v2/modules/cea.js', import.meta.url), 'utf8');
  const maintenanceJs = await readFile(new URL('../web/v2/modules/maintenance.js', import.meta.url), 'utf8');
  const accountingJs = await readFile(new URL('../web/v2/modules/accounting.js', import.meta.url), 'utf8');
  assertIncludes(projectsJs, '<select data-f="province">', '项目省份应为下拉');
  assertIncludes(projectsJs, '<select data-f="methodology_id">', '项目方法学应为下拉');
  assertIncludes(projectsJs, 'selectOptionsHtml(options.projects.provinces', '项目省份应使用共享工具');
  assertIncludes(searchJs, 'list="search-region-options"', '统一检索地区应提供建议并保留城市自由输入');
  assertIncludes(searchJs, 'list="search-source-options"', '来源机构应提供 datalist 建议');
  assertIncludes(ceaJs, '<select data-f="sector">', 'CEA 行业应为下拉');
  assertIncludes(ceaJs, '<select data-f="year">', 'CEA 文件年度应为下拉');
  assertIncludes(ceaJs, '<select data-f="list_year">', 'CEA 名录年度应为下拉');
  assertIncludes(ceaJs, 'list="cea-issuer-options"', 'CEA 研报机构应可自由输入');
  assertIncludes(maintenanceJs, 'editFieldControl(f,', '后台编辑应使用共享字段控件');
  assertIncludes(maintenanceJs, 'edit-year-options', '后台数据年度应提供建议');
  assertIncludes(accountingJs, 'list="calc-target-year-options"', '核算目标年度应提供真实年度建议');
});

/* ------------------------------ HTTP 真实筛选 ------------------------------ */

await testAsync('真实选项接口与后端筛选：项目/CEA/统一检索/管理员旧值', async () => {
  const adminUser = db.get("SELECT * FROM app_user WHERE role='admin' AND active=1 LIMIT 1");
  assert(adminUser, '测试库应有管理员用户');
  const token = auth.createSession(adminUser.id, { actor: 'test:163' }).token;
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
    const anon = await fetch(`${base}/api/v2/meta/form-options`);
    assertEqual(anon.status, 401, '表单选项接口不应匿名可读');
    const optionsRes = await call('/api/v2/meta/form-options');
    assertEqual(optionsRes.status, 200, JSON.stringify(optionsRes.body));
    const o = optionsRes.body;
    const values = (list) => (list || []).map((x) => x.value);
    assert(values(o.projects.provinces).includes('福建省'), '项目省份应有真实值');
    assert(values(o.projects.provinces).includes('新疆生产建设兵团'), '应保留兵团选项');
    assert(values(o.projects.provinces).includes('全国'), '应保留全国选项');
    assert(values(o.projects.methodologies).includes('CCER-10-001'), '方法学应来自真实目录');
    assert(values(o.cea.sectors).includes('发电') && values(o.cea.sectors).includes('钢铁'), 'CEA 行业应齐全');
    assertEqual(o.cea.years.documents.join(','), '2026,2025', '文件年度应真实倒序');
    assert(values(o.search.regions).includes('福建'), '检索地区应有短名');
    assert(values(o.search.regions).includes('福州市'), '检索地区应保留城市建议（允许按城市筛选）');
    assert(values(o.search.regions).includes('华北'), '检索地区应有电网区域');
    assert(values(o.admin.provinces).includes('新疆生产建设兵团'), '管理员省份应保留兵团');
    assert(values(o.sources).includes('测试生态环境厅'), '来源建议应来自真实发布机构');

    const fj = await call('/api/v2/public-projects?province=' + encodeURIComponent('福建省'));
    assertEqual(fj.status, 200);
    assertEqual(fj.body.total, 1, '项目省份精确筛选应只返回福建项目');
    assertEqual(fj.body.rows[0].id, 'PP-163-FJ');
    const xj = await call('/api/v2/public-projects?province=' + encodeURIComponent('新疆建设兵团'));
    assertEqual(xj.body.total, 1, '兵团历史写法应能原样筛选');
    assertEqual(xj.body.rows[0].id, 'PP-163-XJ');
    const allProjects = await call('/api/v2/public-projects?province=');
    assertEqual(allProjects.body.total, 2, '清空省份应回到全部，而不是零条');

    const entities = await call('/api/v2/cea/entities?province=' + encodeURIComponent('福建')
      + '&sector=' + encodeURIComponent('发电') + '&list_year=2026');
    assertEqual(entities.status, 200, JSON.stringify(entities.body));
    assertEqual(entities.body.total, 1, 'CEA 省份短名 + 行业 + 年度筛选应命中 1 条');
    assertEqual(entities.body.rows[0].id, 'ENT-163-FJ');

    const docs = await call('/api/v2/cea/documents?sector=' + encodeURIComponent('钢铁') + '&year=2026');
    assertEqual(docs.status, 200, JSON.stringify(docs.body));
    assertEqual(docs.body.total, 1, 'CEA 行业×年度配对筛选应命中 1 条');
    assertEqual(docs.body.rows[0].id, 'CEADOC-163');

    const searchRegion = await call('/api/v2/search?types=project,entity&region=' + encodeURIComponent('福建'));
    assertEqual(searchRegion.status, 200, JSON.stringify(searchRegion.body));
    assertEqual(searchRegion.body.filters.region, '福建', '地区 query 原样进入筛选');
    assert(searchRegion.body.results.some((r) => r.entity_id === 'PP-163-FJ'), '检索应命中福建项目');
    assert(searchRegion.body.results.some((r) => r.entity_id === 'ENT-163-FJ'), '检索应命中福建企业');
    assert(!searchRegion.body.results.some((r) => r.entity_id === 'PP-163-XJ'), '不应命中兵团项目');
    const searchCity = await call('/api/v2/search?types=project,entity&region=' + encodeURIComponent('福州市'));
    assertEqual(searchCity.status, 200);
    assert(searchCity.body.results.some((r) => r.entity_id === 'PP-163-FJ'), '地区仍应支持城市筛选');
    assert(!searchCity.body.results.some((r) => r.entity_id === 'ENT-163-NM'), '城市筛选不应命中其它城市');
    const searchCleared = await call('/api/v2/search?types=project,entity');
    assertEqual(searchCleared.body.filters.region, null, '清空地区时 filters.region 应为 null');
    assert(searchCleared.body.total >= searchRegion.body.total, '清空地区后结果不应减少');

    const preview = await call('/api/v2/admin/maintenance/preview', {
      method: 'POST', body: { entity_type: 'policy_document', entity_id: 'POL-163' },
    });
    assertEqual(preview.status, 200, JSON.stringify(preview.body));
    assertEqual(preview.body.current.official_url, 'https://www.mee.gov.cn/policy/163.html?v=1&from=old',
      '管理员编辑预览应保留 URL 原值');
    assert(preview.body.fields.some((f) => f.key === 'issuing_authority' && f.type === 'text'),
      '来源机构字段仍为可自由填写的文本');
  } finally {
    server.unref();
    await new Promise((r) => server.close(r));
  }
});

finish('test/163-v2-form-selects.test.mjs');
