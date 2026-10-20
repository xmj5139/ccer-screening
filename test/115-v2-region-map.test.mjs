/**
 * 测试 115：省域地图（docs/59）
 * ============================================================================
 * 使用独立临时库（setupV2）和本机回环 HTTP 服务。覆盖：
 *   - 34 地区全简称/全称/自治区归并，未知省份分离，不按项目名猜省份；
 *   - 非 demo、按官方登记编号去重、阶段/领域/方法学筛选传递；
 *   - 排放 null 与真实 0 区分、单位换算、同省/年/数据集唯一、修订留痕；
 *   - 多 dataset 不静默相加/覆盖；CEA 名录跨年同企业去重；
 *   - 非法查询 400、匿名 401、普通用户/管理员 200、导出审计与公式注入防护；
 *   - 真实 DataV 底图转 SVG（34 省级路径 + 南海诸岛插图）、选中/零/缺失状态；
 *   - 前端卡片 HTML 的来源转义、URL 防护、降级省份列表与键盘/ARIA 契约。
 *
 * 真实浏览器在本沙箱无法启动（Chromium spawn EPERM），因此页面级验证采用
 * **真实 HTTP 资源 + 真实 GeoJSON + 前端渲染函数**，不是单纯静态字符串检查；
 * 浏览器实机交互由后续独立复核执行。
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  setupV2, test, testAsync, assert, assertEqual, assertIncludes, assertNotIncludes, finish,
} from './v2-helpers.mjs';

const ctx = await setupV2({ withPublicDemo: false });
const { db } = ctx;
const regional = await import('../src/services/region-map-svc.mjs');
const catalog = await import('../src/data/region-catalog.mjs');
const mapUi = await import('../web/v2/modules/region-map.js');

console.log('\n[v2-115] 省域地图');

/* ==================================================================== */
/*  一、隔离测试数据                                                     */
/* ==================================================================== */

// 只清理本测试用到的业务表；所有操作都在 setupV2 的临时库中。
for (const table of ['internal_project_link', 'reduction_batch', 'project_event', 'registry_observation']) {
  try { db.run(`DELETE FROM ${table}`); } catch { /* 表或外键可能不存在 */ }
}
db.run('DELETE FROM public_project');
db.run('DELETE FROM region_emission');
db.run('DELETE FROM cea_entity');

const NOW = '2026-10-19T10:00:00.000Z';
const LATER = '2026-10-19T11:00:00.000Z';
function addProject({
  id, name, province, registry = null, domain = '能源', methodology = 'CCER-10-001',
  stagePublic = 1, stageRegistered = 0, stageReduction = 0, demo = 0, updatedAt = NOW,
}) {
  db.run(
    `INSERT INTO public_project
     (id,name,province,registry_project_no,domain,methodology_id,current_stage,
      stage_project_public,stage_project_registered,stage_reduction_registered,is_demo,
      updated_at,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, name, province, registry, domain, methodology,
      stageReduction ? '减排量登记' : stageRegistered ? '项目登记' : '项目公示',
      stagePublic, stageRegistered, stageReduction, demo, updatedAt, NOW]
  );
}

addProject({ id: 'P-BJ-1', name: '北京测试项目', province: '北京', registry: 'REG-BJ-1', stageRegistered: 1 });
addProject({
  id: 'P-BJ-2', name: '<script>alert(1)</script>北京项目', province: '北京市', registry: 'REG-BJ-1',
  stageRegistered: 1, stageReduction: 1, updatedAt: LATER,
});
addProject({ id: 'P-NM-1', name: '内蒙古测试项目', province: '内蒙古', registry: 'REG-NM-1', stageReduction: 1 });
addProject({ id: 'P-GX-1', name: '广西测试项目', province: '广西', registry: 'REG-GX-1', stageRegistered: 1 });
addProject({ id: 'P-XJ-1', name: '新疆测试项目', province: '新疆', registry: 'REG-XJ-1', stageRegistered: 1 });
addProject({ id: 'P-HK-1', name: '香港测试项目', province: '香港', registry: 'REG-HK-1', stageRegistered: 1 });
addProject({ id: 'P-TW-1', name: '台湾测试项目', province: '台湾', registry: 'REG-TW-1', stageReduction: 1 });
addProject({ id: 'P-YN-1', name: '云南林业测试项目', province: '云南省', registry: 'REG-YN-1', domain: '林业', methodology: 'CCER-10-002', stageRegistered: 1 });
addProject({ id: 'P-UNK-1', name: '广东省某海外项目', province: '海外', registry: 'REG-UNK-1' });
addProject({ id: 'P-UNK-2', name: '广东省某项目但省份为空', province: null, registry: 'REG-UNK-2' });
addProject({ id: 'P-DEMO-1', name: '演示条目：广东项目', province: '广东省', registry: 'REG-DEMO-1', demo: 1 });

function addEntity({ id, key, name, province, year, sourceUrl = 'https://www.mee.gov.cn/ywgz/ydqhbh/wsqtkz/', dataAsOf = '2025-06-30' }) {
  db.run(
    `INSERT INTO cea_entity
     (id,entity_key,name,province,city,sector,list_year,status,source_url,data_as_of,verify_status,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, key, name, province, null, '发电', year, 'existing', sourceUrl, dataAsOf, 'source_recorded', NOW, NOW]
  );
}
addEntity({ id: 'CE-GD-1', key: 'ENT-GD-1', name: '广东测试企业A', province: '广东省', year: 2023 });
addEntity({ id: 'CE-GD-2', key: 'ENT-GD-1', name: '广东测试企业A', province: '广东省', year: 2024 });
addEntity({ id: 'CE-GD-3', key: 'ENT-GD-2', name: '广东测试企业B', province: '广东', year: 2024 });
addEntity({ id: 'CE-BJ-1', key: 'ENT-BJ-1', name: '北京测试企业', province: '北京市', year: 2024 });

const BASE_EMISSION = {
  province: '北京市',
  scope: 'region_co2',
  year: 2024,
  value_tco2: 0,
  unit: 'tCO2',
  methodology: '测试核算方法（临时库，非真实）',
  boundary: '测试边界：30 省部门核算；研究口径',
  dataset_key: 'test-regional-2024',
  source_name: '测试临时数据（非真实）',
  source_url: 'https://www.ceads.net/data/carbon-inventory/provincial-level/',
  source_kind: 'research',
  published_at: '2025-01-01',
  excerpt: '测试临时数据：2024 年 CO2 排放记录，含 tCO2 单位（非真实，仅测试）',
  collected_at: '2026-01-01T00:00:00.000Z',
};

const mainImport = regional.importRegionRecords([
  { ...BASE_EMISSION, province: '北京市', value_tco2: 0 },
  { ...BASE_EMISSION, province: '天津市', value_tco2: 123456789 },
  { ...BASE_EMISSION, province: '河北省', value_tco2: 12345 },
  // 山西用于修订测试：先 100，再 120
  { ...BASE_EMISSION, province: '山西省', value_tco2: 100 },
], { actor: 'test:115' });

const officialImport = regional.importRegionRecords([
  {
    ...BASE_EMISSION,
    province: '北京市',
    value_tco2: 42,
    dataset_key: 'test-official-2024',
    source_name: '测试官方样例（非真实）',
    source_url: 'https://www.mee.gov.cn/ywgz/ydqhbh/wsqtkz/',
    source_kind: 'official',
    excerpt: '测试临时数据：官方样例 CO2 排放 42 吨（非真实）',
  },
], { actor: 'test:115' });

const year2023Import = regional.importRegionRecords([
  { ...BASE_EMISSION, year: 2023, province: '北京市', value_tco2: 1000, dataset_key: 'test-regional-2023', published_at: '2024-01-01' },
  { ...BASE_EMISSION, year: 2023, province: '山西省', value_tco2: 2000, dataset_key: 'test-regional-2023', published_at: '2024-01-01' },
], { actor: 'test:115' });

const natlEtsBefore = regional.buildRegionMap({ metric: 'national_ets' });

const natlImport = regional.importRegionRecords([
  {
    ...BASE_EMISSION,
    province: '广东省',
    scope: 'national_ets',
    value_tco2: 5000,
    dataset_key: 'test-ets-2024',
    source_name: '测试全国碳市场样例（非真实）',
    source_url: 'https://www.mee.gov.cn/ywgz/ydqhbh/wsqtkz/',
    source_kind: 'official',
    excerpt: '测试临时数据：全国碳市场纳管排放 5000 吨 CO2（非真实）',
  },
], { actor: 'test:115' });

const revisionFirst = regional.importRegionRecords([
  { ...BASE_EMISSION, province: '山西省', value_tco2: 120 },
], { actor: 'test:115' });
const revisionSame = regional.importRegionRecords([
  { ...BASE_EMISSION, province: '山西省', value_tco2: 120 },
], { actor: 'test:115' });

// 公式注入：来源名称以 = 开头，CSV 必须加前缀；导入仍保留来源，不改成官方。
const formulaImport = regional.importRegionRecords([
  {
    ...BASE_EMISSION,
    province: '青海省',
    year: 2021,
    value_tco2: 1,
    dataset_key: 'test-formula-2021',
    source_name: '=HYPERLINK("http://evil.example","x")',
    published_at: '2022-01-01',
    excerpt: '测试公式注入的 CO2 排放记录（非真实）',
  },
], { actor: 'test:115' });

// 直接写库的脏 URL（绕过导入）用于验证 API 输出防线；不改变默认 2024 视图。
db.run(
  `INSERT INTO region_emission
   (id,province_code,province_name,scope,year,value_tco2,unit,methodology,boundary,dataset_key,
    source_name,source_url,source_kind,published_at,excerpt,snapshot_hash,content_hash,
    verification_status,status,entered_by,collected_at,created_at,updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ['REM-DIRTY-2022', '630000', '青海省', 'region_co2', 2022, 8888, 'tCO2',
    '测试脏链接方法', '测试脏链接边界', 'test-dirty-2022', '测试脏链接来源',
    'javascript:alert(1)', 'research', '2023-01-01',
    '测试脏链接：CO2 排放 8888 吨（非真实）', null, 'dirtyhash',
    'source_recorded', 'active', 'test:115', '2023-02-01T00:00:00.000Z', NOW, NOW]
);

const projectsView = regional.buildRegionMap({});
const co2View = regional.buildRegionMap({ metric: 'region_co2' });
const co2OfficialView = regional.buildRegionMap({ metric: 'region_co2', dataset: 'test-official-2024' });
const co2Year2023View = regional.buildRegionMap({ metric: 'region_co2', year: 2023 });
const dirtyView = regional.buildRegionMap({ metric: 'region_co2', year: 2022, dataset: 'test-dirty-2022' });
const formulaView = regional.buildRegionMap({ metric: 'region_co2', year: 2021, dataset: 'test-formula-2021' });
const natlEtsView = regional.buildRegionMap({ metric: 'national_ets' });

/* ==================================================================== */
/*  二、目录与项目归并                                                   */
/* ==================================================================== */

test('34 个省级地区全称/简称/自治区归并一致', () => {
  assertEqual(catalog.PROVINCES.length, 34);
  for (const p of catalog.PROVINCES) {
    assertEqual(catalog.normalizeProvince(p.name)?.code, p.code, `全称未归并：${p.name}`);
    assertEqual(catalog.normalizeProvince(p.short_name)?.code, p.code, `简称未归并：${p.short_name}`);
  }
  for (const [raw, code] of [
    ['内蒙古', '150000'], ['内蒙', '150000'], ['内蒙古自治区', '150000'],
    ['广西', '450000'], ['广西壮族自治区', '450000'],
    ['新疆', '650000'], ['新疆维吾尔自治区', '650000'],
    ['宁夏回族自治区', '640000'], ['西藏自治区', '540000'],
    ['香港特别行政区', '810000'], ['澳门', '820000'],
  ]) {
    assertEqual(catalog.normalizeProvince(raw)?.code, code, `别名未归并：${raw}`);
  }
  for (const raw of ['广东省深圳市', '海外', '中国银行', '', null]) {
    assertEqual(catalog.normalizeProvince(raw), null, `不应猜测省份：${raw}`);
  }
});

test('项目指标：真实、非 demo、按登记号去重、未知省份分离、阶段筛选', () => {
  assert(projectsView, '项目视图应返回');
  assertEqual(projectsView.regions.length, 34, '必须固定返回 34 地区');
  assertEqual(new Set(projectsView.regions.map((r) => r.code)).size, 34);

  const bj = projectsView.regions.find((r) => r.code === '110000');
  assertEqual(bj.project_count, 1, '同一登记号重复行应去重');
  assertEqual(bj.registered_count, 1);
  assertEqual(bj.reduction_registered_count, 1, '重复行的阶段标记应取并集');
  assertEqual(projectsView.regions.find((r) => r.code === '150000').project_count, 1, '内蒙古简称应归并');
  assertEqual(projectsView.regions.find((r) => r.code === '450000').project_count, 1, '广西简称应归并');
  assertEqual(projectsView.regions.find((r) => r.code === '650000').project_count, 1, '新疆简称应归并');
  assertEqual(projectsView.regions.find((r) => r.code === '440000').project_count, 0, 'demo 必须排除');
  assertEqual(projectsView.unknown.projects.count, 2, '未知省份应单列计数');
  assert(projectsView.unknown.projects.items.some((x) => x.province === '海外'), '应保留原始未知省份文本');
  assert(projectsView.unknown.projects.items.some((x) => x.province === '未标注省份'), '空省份应单列');
  assertEqual(projectsView.totals.project_count, 7, '34 地区内项目总数应为 7');
  assertEqual(projectsView.totals.unknown_projects, 2);

  const yn = regional.buildRegionMap({ domain: '林业' });
  assertEqual(yn.totals.project_count, 1, '领域筛选应传递');
  assertEqual(yn.regions.find((r) => r.code === '530000').project_count, 1);
  const byMethod = regional.buildRegionMap({ methodology_id: 'CCER-10-002' });
  assertEqual(byMethod.totals.project_count, 1, '方法学筛选应传递');
  const registered = regional.buildRegionMap({ stage: 'project_registered' });
  assertEqual(registered.totals.project_count, 5, '阶段筛选应传递');
  const registeredReduction = regional.buildRegionMap({
    stage: 'project_registered', metric: 'reduction_registered_projects',
  });
  assertEqual(registeredReduction.regions.find((r) => r.code === '110000').value, 1, '阶段与登记子指标应取交集');
  assertEqual(registeredReduction.totals.value, 1);
});

/* ==================================================================== */
/*  三、排放、0/缺失、单位、数据集与修订                                 */
/* ==================================================================== */

test('排放 0 与缺数据严格区分，单位自动换算且底层始终为 tCO2', () => {
  assertEqual(co2View.metric, 'region_co2');
  assertEqual(co2View.unit, 'tCO2');
  assertEqual(co2View.year, 2024);
  assertEqual(co2View.dataset, 'test-regional-2024', '默认应选覆盖最多的数据集');
  const bj = co2View.regions.find((r) => r.code === '110000');
  const tj = co2View.regions.find((r) => r.code === '120000');
  const sh = co2View.regions.find((r) => r.code === '310000');
  assertEqual(bj.value, 0, '真实 0 必须保留');
  assertEqual(bj.missing, false, '真实 0 不是缺失');
  assertEqual(bj.zero, true);
  assertEqual(tj.value, 123456789);
  assertEqual(tj.display, '1.23 亿吨');
  assertEqual(co2View.regions.find((r) => r.code === '130000').display, '1.23 万吨');
  assertEqual(sh.value, null, '缺数据必须是 null，不能 Number(null) 变 0');
  assertEqual(sh.missing, true, '缺数据必须标记 missing');
  assertEqual(co2View.totals.covered_regions, 4);
  assertEqual(co2View.totals.missing_regions, 30);
  assertIncludes(co2View.totals.label, '已披露合计');
  assertIncludes(co2View.totals.label, '非全国排放总量');
  assert(!co2View.totals.label.startsWith('全国排放总量'), '不能把已披露合计叫全国排放总量');
  assertEqual(regional.formatTco2(0), '0 吨');
  assertEqual(regional.formatTco2(12345), '1.23 万吨');
  assertEqual(regional.formatTco2(123456789), '1.23 亿吨');
});

test('同省/年不同 dataset 分列展示，不静默相加或覆盖', () => {
  assertEqual(co2View.dataset_options.length, 2, '2024 应有研究/官方两个数据集');
  assertEqual(co2View.regions.find((r) => r.code === '110000').value, 0, '默认研究数据集');
  assertEqual(co2OfficialView.dataset, 'test-official-2024');
  assertEqual(co2OfficialView.regions.find((r) => r.code === '110000').value, 42, '显式 dataset 应切换口径');
  assertEqual(co2OfficialView.regions.find((r) => r.code === '110000').emission.source.source_kind, 'official');
  assertEqual(co2OfficialView.regions.find((r) => r.code === '110000').emission.source.verification_status, 'source_recorded', '管理员/CLI 导入不自动变官方核实');
  const active = db.all(
    `SELECT * FROM region_emission
     WHERE province_code='110000' AND scope='region_co2' AND year=2024 AND status='active'
     ORDER BY dataset_key`
  );
  assertEqual(active.length, 2, '同年同省不同 dataset 应各有一条 active');
  assertEqual(new Set(active.map((r) => r.dataset_key)).size, 2);
});

test('年度选择来自真实数据；指定不存在年度返回 400', () => {
  assert(co2View.year_options.includes(2024));
  assert(co2View.year_options.includes(2023));
  assertEqual(co2Year2023View.year, 2023);
  assertEqual(co2Year2023View.dataset, 'test-regional-2023');
  assertEqual(co2Year2023View.regions.find((r) => r.code === '110000').value, 1000);
  const bad = regional.buildRegionMap({ metric: 'region_co2', year: 2020 });
  assertEqual(bad.status, 400);
  assertEqual(regional.buildRegionMap({ metric: 'projects', year: 2024 }).status, 400);
});

test('修订留痕、幂等与单条 active 约束', () => {
  assert(revisionFirst.ok && revisionFirst.revised === 1, '第二次导入同键不同值应修订');
  assert(revisionSame.ok && revisionSame.unchanged === 1, '相同内容重复导入应幂等');
  const rows = db.all(
    `SELECT id,status,value_tco2,revision_of,superseded_by FROM region_emission
     WHERE province_code='140000' AND scope='region_co2' AND year=2024
       AND dataset_key='test-regional-2024'
     ORDER BY created_at, id`
  );
  assertEqual(rows.length, 2, '应保留旧值与新值两条历史');
  assertEqual(rows.filter((r) => r.status === 'active').length, 1, '只允许一条 active');
  const active = rows.find((r) => r.status === 'active');
  const old = rows.find((r) => r.status === 'superseded');
  assertEqual(active.value_tco2, 120);
  assertEqual(old.value_tco2, 100);
  assertEqual(active.revision_of, old.id, '新行应指向被修订行');
  assertEqual(old.superseded_by, active.id);
  assertEqual(regional.buildRegionMap({ metric: 'region_co2' }).regions.find((r) => r.code === '140000').value, 120);
});

test('CEA 名录按年度、企业去重，不跨年累加，也不冒充排放量', () => {
  assertEqual(natlEtsBefore.data_available, false, '尚未导入纳管排放时数据不可用');
  assertEqual(natlEtsBefore.regions.find((r) => r.code === '440000').missing, true);
  assertEqual(natlEtsBefore.regions.find((r) => r.code === '440000').ets_directory.count, 2, '2024 广东名录应为 2 家');
  assertEqual(natlEtsBefore.regions.find((r) => r.code === '440000').ets_directory.all_years_count, 2, '同一企业跨年应去重');
  assertEqual(natlEtsBefore.regions.find((r) => r.code === '440000').ets_directory.year, 2024);
  assertEqual(natlEtsBefore.totals.directory_total, 3, '2024 名录合计 3 家');
  assertEqual(natlEtsBefore.totals.directory_total_all_years, 3, '跨年去重后仍为 3 家');
  assertEqual(natlEtsView.data_available, true);
  assertEqual(natlEtsView.regions.find((r) => r.code === '440000').value, 5000);
  assertEqual(natlEtsView.regions.find((r) => r.code === '440000').ets_directory.count, 2, '名录数不是排放值');
  assertEqual(natlEtsView.regions.find((r) => r.code === '440000').emission.source.source_kind, 'official');
  assert(natlEtsView.notes.some((n) => n.includes('覆盖率')), '应说明名录数量不代表披露覆盖率');
  const etsCard = mapUi.regionMapCardHtml(natlEtsView, mapUi.createRegionMapState({
    view: 'national_ets', selectedCode: '440000', year: 2024, dataset: 'test-ets-2024',
  }));
  assertIncludes(etsCard, '全国碳市场名录入口');
  assertIncludes(etsCard, '名录来源');
  assertIncludes(etsCard, '名录 2 家（2024）');
});

test('未知省份/未来年度/NaN/单位/URL/证据等导入校验严格', () => {
  const base = { ...BASE_EMISSION };
  const cases = [
    [{ ...base, province: '海外' }, '未知省份'],
    [{ ...base, province: '北京市', year: 2099 }, '未来年度'],
    [{ ...base, province: '北京市', value_tco2: NaN }, 'NaN'],
    [{ ...base, province: '北京市', value_tco2: -1 }, '负数'],
    [{ ...base, province: '北京市', unit: 'tCO2e' }, '单位'],
    [{ ...base, province: '北京市', unit: '万吨' }, '单位'],
    [{ ...base, province: '北京市', source_kind: 'official', source_url: 'https://example.com/x' }, '伪造官方域名'],
    [{ ...base, province: '北京市', source_url: 'javascript:alert(1)' }, '协议'],
    [{ ...base, province: '北京市', excerpt: '太短' }, '证据'],
    [{ ...base, province: '北京市', dataset_key: '../x' }, '数据集键'],
    [{ ...base, province: '北京市', published_at: '2099-01-01' }, '未来发布日'],
    [{ ...base, province: '北京市', extra: 1 }, '未知字段'],
    [{ ...base, province_code: '110000', province_name: '上海市' }, '省份不一致'],
  ];
  for (const [raw, label] of cases) {
    const out = regional.validateImportRecord(raw);
    assertEqual(out.ok, false, `应拒绝：${label}`);
  }
  const mixed = regional.importRegionRecords([
    { ...base, province: '北京市', dataset_key: 'test-atomic-2024', value_tco2: 1 },
    { ...base, province: '海外', dataset_key: 'test-atomic-2024', value_tco2: 2 },
  ], { actor: 'test:115' });
  assertEqual(mixed.ok, false, '任一行非法时整批不写');
  assertEqual(db.get("SELECT COUNT(*) c FROM region_emission WHERE dataset_key='test-atomic-2024'").c, 0);
  const metaMismatch = regional.importRegionRecords([
    { ...base, province: '北京市', dataset_key: 'test-regional-2024', value_tco2: 1, boundary: '不同核算边界' },
  ], { actor: 'test:115' });
  assertEqual(metaMismatch.ok, false, '同一 dataset 内不同边界必须拒绝');
  const batchMismatch = regional.importRegionRecords([
    { ...base, province: '北京市', dataset_key: 'test-batch-meta-2024', boundary: '边界A', value_tco2: 1 },
    { ...base, province: '天津市', dataset_key: 'test-batch-meta-2024', boundary: '边界B', value_tco2: 2 },
  ], { actor: 'test:115' });
  assertEqual(batchMismatch.ok, false, '同一批次内不同边界必须拒绝');
  assertEqual(db.get("SELECT COUNT(*) c FROM region_emission WHERE dataset_key='test-batch-meta-2024'").c, 0);
  const dry = regional.importRegionRecords([
    { ...base, province: '北京市', dataset_key: 'test-dry-2024', value_tco2: 1 },
  ], { actor: 'test:115', dryRun: true });
  assertEqual(dry.ok, true);
  assertEqual(dry.valid, 1);
  assertEqual(db.get("SELECT COUNT(*) c FROM region_emission WHERE dataset_key='test-dry-2024'").c, 0, 'dry-run 不写库');
});

test('来源链接输出防线：脏 URL 降级为 null，官方声明不被自动升格', () => {
  const qh = dirtyView.regions.find((r) => r.code === '630000');
  assertEqual(qh.value, 8888);
  assertEqual(qh.emission.source.source_url, null, 'javascript: 链接必须被清除');
  assertEqual(dirtyView.source.source_url, null);
  const card = mapUi.regionMapCardHtml(dirtyView, mapUi.createRegionMapState({
    view: 'region_co2', selectedCode: '630000', year: 2022, dataset: 'test-dirty-2022',
  }));
  assertNotIncludes(card, 'javascript:', '页面不得输出脏协议链接');
  assertEqual(regional.validateImportRecord({
    ...BASE_EMISSION,
    province: '北京市',
    source_kind: 'official',
    source_url: 'https://www.mee.gov.cn/x',
  }).ok, true, '官方域名应通过来源声明校验');
  assertEqual(regional.validateImportRecord({
    ...BASE_EMISSION,
    province: '北京市',
    source_kind: 'official',
    source_url: 'http://www.mee.gov.cn/x',
  }).ok, false, '官方来源必须 https');
});

/* ==================================================================== */
/*  四、导出：同源、缺失标记、公式注入防护                               */
/* ==================================================================== */

test('CSV 导出与页面同源，含缺失标记与来源证据', () => {
  const out = regional.buildRegionMapExport({ metric: 'region_co2' });
  assertEqual(out.ok, true);
  assertEqual(out.rows.length, 34);
  const bj = out.rows.find((r) => r.province_code === '110000');
  const sh = out.rows.find((r) => r.province_code === '310000');
  assertEqual(bj.value, 0);
  assertEqual(bj.missing, 0);
  assertEqual(sh.value, null);
  assertEqual(sh.missing, 1);
  assertEqual(sh.missing_reason, '未取得该省排放记录');
  assertIncludes(out.columns.map((c) => c.key).join(','), 'source_url');
  assertIncludes(out.columns.map((c) => c.key).join(','), 'verification_status');
  assertIncludes(out.columns.map((c) => c.key).join(','), 'excerpt');
  assertIncludes(out.columns.map((c) => c.key).join(','), 'as_of');
  assertIncludes(out.columns.map((c) => c.key).join(','), 'missing');
  const regionOut = regional.buildRegionMapExport({ metric: 'region_co2', region: '华北' });
  assertEqual(regionOut.rows.length, 5, '华北分组应只导出 5 个省级地区');
  assert(regionOut.rows.every((r) => r.region_group === '华北'));
});

test('CSV 公式注入防护与导出审计', () => {
  const out = regional.buildRegionMapExport({ metric: 'region_co2', year: 2021, dataset: 'test-formula-2021' });
  assertEqual(out.ok, true);
  const csv = ctx.exportSvc.toCsv(out.columns, out.rows, { meta: out.meta });
  assertIncludes(csv, "'=HYPERLINK", '以 = 开头的来源名称必须加前缀');
  const built = ctx.exportSvc.buildExport({
    user: { name: '测试用户', role: 'viewer' }, dataset: '省域地图', fileBase: 'region_map_test',
    format: 'csv', columns: out.columns, rows: out.rows, meta: out.meta,
  });
  assert(built.sha256);
  const log = db.get("SELECT * FROM export_log WHERE dataset='省域地图' ORDER BY at DESC LIMIT 1");
  assert(log, '应写入导出审计');
  assertEqual(log.row_count, out.rows.length);
});

/* ==================================================================== */
/*  五、前端：真实 GeoJSON 转 SVG + 卡片渲染                              */
/* ==================================================================== */

const root = ctx.dir;
const geoPath = join(process.cwd(), 'web', 'v2', 'assets', 'maps', 'china-provinces.json');
const sourcePath = join(process.cwd(), 'web', 'v2', 'assets', 'maps', 'source.json');
const geo = JSON.parse(readFileSync(geoPath, 'utf8'));
const mapSource = JSON.parse(readFileSync(sourcePath, 'utf8'));
const geoHash = createHash('sha256').update(readFileSync(geoPath)).digest('hex');

test('本地底图来源、hash、采集时间与南海诸岛要素真实存在', () => {
  assertEqual(geoHash, mapSource.sha256, 'source.json 的 hash 应与本地底图一致');
  assertIncludes(mapSource.source_url, 'geo.datav.aliyun.com');
  assert(mapSource.collected_at, '应记录采集时间');
  assertIncludes(mapSource.note, '不代表自行取得新的地图审图号');
  assertEqual(geo.features.length, 35, '34 省级 + 南海诸岛/九段线要素');
  const names = geo.features.map((f) => f.properties?.name).filter(Boolean);
  for (const name of ['台湾省', '香港特别行政区', '澳门特别行政区', '海南省', '内蒙古自治区']) {
    assertIncludes(names.join(','), name);
  }
  assert(geo.features.some((f) => f.properties?.adcode === '100000_JD'), '应含南海诸岛/九段线要素');
  void root;
});

test('GeoJSON 投影生成 34 个省级路径 + 南海诸岛插图', () => {
  const prepared = mapUi.prepareGeometry(geo);
  assertEqual(prepared.main.length, 34);
  assertEqual(prepared.insetHainan.length, 1, '海南南部岛屿应进入插图');
  assertEqual(prepared.sea.length, 1, '九段线应进入插图');
  const svg = mapUi.buildRegionSvg(geo, co2View, mapUi.createRegionMapState({
    view: 'region_co2', selectedCode: '110000',
  }));
  const codes = [...svg.matchAll(/data-region-code="(\d{6})"/g)].map((m) => m[1]);
  assertEqual(codes.length, 34);
  assertEqual(new Set(codes).size, 34);
  assertIncludes(svg, '台湾省');
  assertIncludes(svg, '香港特别行政区');
  assertIncludes(svg, '澳门特别行政区');
  assertIncludes(svg, '海南省');
  assertIncludes(svg, 'region-map-inset');
  assertIncludes(svg, '南海诸岛');
  assertIncludes(svg, 'is-selected', '选中的北京应有深绿选择态');
  assertIncludes(svg, 'is-zero', '真实 0 应有独立状态');
  assertIncludes(svg, 'is-missing', '缺数据应有斜纹状态');
  assertIncludes(svg, '上海市，排放数据未取得');
  assertIncludes(svg, 'aria-pressed="true"');
  assertIncludes(svg, '<title id="region-map-svg-title">');
  assert(!svg.includes('<image'), '不得用外链位图替代本地边界');
  assert(!svg.includes('http'), 'SVG 不应引用外部 CDN');
});

test('0 与缺数据的图例、选中状态、降级列表与 ARIA 契约', () => {
  assertEqual(mapUi.classForValue(0, mapUi.buildScale([0, 10, 20])), 'is-zero');
  assertEqual(mapUi.classForValue(null, mapUi.buildScale([0, 10, 20])), 'is-missing');
  assert(mapUi.classForValue(10, mapUi.buildScale([0, 10, 20])).startsWith('heat-'));
  assertEqual(mapUi.formatTco2(123456789), '1.23 亿吨');
  assertEqual(mapUi.formatCount(0), '0 个');

  const state = mapUi.createRegionMapState({ view: 'region_co2', selectedCode: '110000', year: 2024, dataset: 'test-regional-2024' });
  const card = mapUi.regionMapCardHtml(co2View, state, { filters: {}, contextProvince: '北京市' });
  assertIncludes(card, '省域地图与排放');
  assertIncludes(card, '下载当前 CSV');
  assertIncludes(card, 'region-map-legend');
  assertIncludes(card, '未取得');
  assertIncludes(card, 'tCO2');
  assertIncludes(card, '来源已记录（未独立核实）');
  assertIncludes(card, '总览省份筛选：北京市（地图仍为全国底图）');
  assertIncludes(card, 'role="tooltip"');
  assertIncludes(card, 'aria-live="polite"');
  assertIncludes(card, 'aria-label="地图图例"');
  assertIncludes(card, 'metric=region_co2');
  assertIncludes(card, 'year=2024');
  assertIncludes(card, 'dataset=test-regional-2024');
  assertIncludes(card, '&lt;script&gt;alert(1)&lt;/script&gt;北京项目', '项目名必须转义');
  assertNotIncludes(card, '<script>alert(1)</script>');

  const fallback = mapUi.regionMapCardHtml(co2View, { ...state, geo: null, mapError: new Error('底图文件缺失') });
  assertIncludes(fallback, '底图未加载，已降级为省份列表');
  assertIncludes(fallback, 'region-map-fallback-grid');
  assertIncludes(fallback, 'data-map-select="110000"');

  let s = mapUi.createRegionMapState({ selectedCode: '110000' });
  s = mapUi.hoverRegion(s, '120000');
  s = mapUi.clearHover(s);
  assertEqual(s.selectedCode, '110000', '鼠标移开不得丢选择');
  assertEqual(s.hoverCode, null, '悬停可清除');
  const hoverHref = mapUi.buildExportHref(co2View, state, { stage: 'project_registered' });
  assertIncludes(hoverHref, 'stage=project_registered');
});

test('排名：缺失置底、并列同名次、区域分组只影响排名', () => {
  const ranked = mapUi.rankRegions(co2View.regions, 'region_co2');
  assertEqual(ranked[ranked.length - 1].missing, true, '缺失应置底');
  assert(ranked.slice(0, 4).every((r) => !r.missing));
  const north = mapUi.rankRegions(co2View.regions, 'region_co2', '华北');
  assertEqual(north.length, 5, '华北应 5 个省级地区');
  assert(north.every((r) => r.group === '华北'));
  const synthetic = [
    { code: '110000', name: '北京市', short_name: '北京', group: '华北', value: 5, missing: false, project_count: 0, registered_count: 0, reduction_registered_count: 0, ets_directory: {} },
    { code: '120000', name: '天津市', short_name: '天津', group: '华北', value: 5, missing: false, project_count: 0, registered_count: 0, reduction_registered_count: 0, ets_directory: {} },
    { code: '130000', name: '河北省', short_name: '河北', group: '华北', value: 9, missing: false, project_count: 0, registered_count: 0, reduction_registered_count: 0, ets_directory: {} },
  ];
  const ties = mapUi.rankRegions(synthetic, 'region_co2');
  assertEqual(ties[0].rank, 1);
  assertEqual(ties[1].rank, 2);
  assertEqual(ties[2].rank, 2);
});

/** 仅供异步归属测试的轻量 DOM 桩：只承载挂载路径用到的 slot/归属 wrapper/svg。 */
function makeMountRoot() {
  const root = {
    _html: '',
    _listeners: {},
    _listenerCount: 0,
    innerHTMLSets: 0,
    slot: null,
    attribution: null,
    svg: null,
    get innerHTML() { return this._html; },
    set innerHTML(value) {
      this._html = String(value);
      this.innerHTMLSets += 1;
      if (this._html.includes('data-map-slot')) {
        const self = this;
        this.slot = {
          _html: '',
          get innerHTML() { return this._html; },
          set innerHTML(v) {
            this._html = String(v);
            if (this._html.includes('data-map-svg')) {
              self.svg = { querySelector: () => null, appendChild() {} };
            }
          },
        };
      }
      if (this._html.includes('data-map-attribution')) {
        this.attribution = {
          _html: '',
          updates: 0,
          get innerHTML() { return this._html; },
          set innerHTML(v) {
            this._html = String(v);
            this.updates += 1;
          },
        };
      }
    },
    querySelector(sel) {
      if (sel === '[data-map-slot]') return this.slot;
      if (sel === '[data-map-attribution]') return this.attribution;
      if (sel === '[data-map-svg]') return this.svg;
      return null;
    },
    querySelectorAll() { return []; },
    addEventListener(type, fn) {
      this._listeners[type] = fn;
      this._listenerCount += 1;
    },
  };
  return root;
}

await testAsync('底图异步加载/重试后只刷新归属行，source 时间与 SHA 生效且不丢选择/焦点/事件委托', async () => {
  const prevDocument = globalThis.document;
  const prevWindow = globalThis.window;
  const prevFetch = globalThis.fetch;
  const focusEl = { id: 'focus-control' };
  const makeSvgNode = () => ({ setAttribute() {}, appendChild() {} });
  globalThis.document = {
    activeElement: focusEl,
    createElement: makeSvgNode,
    createElementNS: makeSvgNode,
  };
  globalThis.window = { matchMedia: () => ({ matches: false }) };
  let geoRequests = 0;
  let sourceRequests = 0;
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target === mapUi.GEO_URL) {
      geoRequests += 1;
      if (geoRequests === 1) {
        return new Response(JSON.stringify({ error: '底图上游暂时不可用' }), {
          status: 500, headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(geo), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (target === mapUi.SOURCE_URL) {
      sourceRequests += 1;
      return new Response(JSON.stringify(mapSource), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`未预期的底图请求：${target}`);
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  try {
    // 重试分支：首次 GeoJSON 失败 → 归属行保持缺省；点击重试成功后由异步 source 更新。
    const root = makeMountRoot();
    const mounted = mapUi.mountRegionMap({ root, initialData: co2View, contextProvince: '北京市' });
    assert(mounted, '应成功挂载地图');
    await flush();
    assertIncludes(root.slot.innerHTML, '底图未加载，已降级为省份列表');
    assertIncludes(root._html, 'data-map-attribution');
    assertIncludes(root.attribution.innerHTML, '采集 —', 'source 未取得前应显示缺省采集日期');
    assertNotIncludes(root.attribution.innerHTML, 'sha256');
    assertEqual(root.innerHTMLSets, 1, '初次挂载只整卡渲染一次');
    const clickHandler = root._listeners.click;
    const listenerCount = root._listenerCount;
    assertEqual(mounted.getState().selectedCode, '110000');

    const retryTarget = { closest: (sel) => (sel === '[data-map-retry]' ? retryTarget : null) };
    clickHandler({ target: retryTarget, preventDefault() {} });
    await flush();
    assertEqual(geoRequests, 2, '重试应强制重新请求 GeoJSON');
    assertEqual(sourceRequests, 2, '重试应重新请求 source.json');
    assertIncludes(root.slot.innerHTML, 'data-map-svg');
    assertIncludes(root.slot.innerHTML, 'is-selected', '重试成功后北京选择态仍在');
    assertIncludes(root.attribution.innerHTML, `采集 ${mapSource.collected_at.slice(0, 10)}`);
    assertIncludes(root.attribution.innerHTML, `sha256 ${mapSource.sha256.slice(0, 12)}…`);
    assertNotIncludes(root.attribution.innerHTML, '采集 —');
    assertEqual(root.attribution.updates, 2, '失败与重试成功都应刷新归属 wrapper');
    assertEqual(root.innerHTMLSets, 1, '异步归属更新不得整卡重渲染');
    assertEqual(root._listeners.click, clickHandler, '事件委托应保持同一处理器');
    assertEqual(root._listenerCount, listenerCount, '不得在异步更新时重复绑定事件');
    assertEqual(globalThis.document.activeElement, focusEl, '异步更新不得抢走控件焦点');
    assertEqual(mounted.getState().selectedCode, '110000', '异步更新不得丢失选中省份');

    // 初次异步分支：底图 promise 完成后同样只更新归属行。
    const root2 = makeMountRoot();
    const mounted2 = mapUi.mountRegionMap({ root: root2, initialData: co2View, contextProvince: '北京市' });
    assertIncludes(root2._html, '采集 —', '初次渲染时尚未取得 source');
    assertNotIncludes(root2._html, 'sha256');
    const click2 = root2._listeners.click;
    const listenerCount2 = root2._listenerCount;
    await flush();
    assertIncludes(root2.attribution.innerHTML, `采集 ${mapSource.collected_at.slice(0, 10)}`);
    assertIncludes(root2.attribution.innerHTML, `sha256 ${mapSource.sha256.slice(0, 12)}…`);
    assertEqual(root2.innerHTMLSets, 1, '初次底图加载完成不得整卡重渲染');
    assertEqual(root2._listeners.click, click2, '初次异步更新后事件委托处理器不变');
    assertEqual(root2._listenerCount, listenerCount2);
    assertEqual(globalThis.document.activeElement, focusEl, '初次异步更新不得抢走控件焦点');
    assertEqual(mounted2.getState().selectedCode, '110000');
  } finally {
    globalThis.document = prevDocument;
    globalThis.window = prevWindow;
    globalThis.fetch = prevFetch;
  }
});

/* ==================================================================== */
/*  六、HTTP：权限、非法参数、导出与静态资源                              */
/* ==================================================================== */

process.env.CCER_AUTH_MODE = 'session';
const { server } = await import('../src/server.mjs');
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

async function call(path, { method = 'GET', body = null, token = null, headers = {} } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, json, text, headers: res.headers };
}

let viewerToken = null;
let adminToken = null;

await testAsync('匿名访问地图/导出 → 401，普通用户与管理员只读 200', async () => {
  assertEqual((await call('/api/v2/overview/region-map')).status, 401);
  assertEqual((await call('/api/v2/overview/region-map/export?format=csv')).status, 401);

  const viewer = await call('/api/auth/login', {
    method: 'POST', body: { user_id: 'user-other', password: 'viewer-demo-2026' },
  });
  assertEqual(viewer.status, 200);
  viewerToken = viewer.json.token;
  const admin = await call('/api/auth/login', {
    method: 'POST', body: { user_id: 'user-admin', password: 'admin-demo-2026' },
  });
  assertEqual(admin.status, 200);
  adminToken = admin.json.token;

  const v = await call('/api/v2/overview/region-map', { token: viewerToken });
  assertEqual(v.status, 200);
  assertEqual(v.json.regions.length, 34);
  assertEqual(v.json.metric, 'projects');
  const a = await call('/api/v2/overview/region-map?metric=region_co2', { token: adminToken });
  assertEqual(a.status, 200);
  assertEqual(a.json.metric, 'region_co2');
  assertEqual(a.json.regions.find((r) => r.code === '310000').value, null);
});

await testAsync('非法白名单参数 → 400，且 SQL 注入不能触达数据库', async () => {
  const cases = [
    '/api/v2/overview/region-map?metric=bad',
    '/api/v2/overview/region-map?foo=1',
    '/api/v2/overview/region-map?metric=region_co2&year=2020',
    '/api/v2/overview/region-map?metric=projects&year=2024',
    '/api/v2/overview/region-map?metric=region_co2&region=火星',
    '/api/v2/overview/region-map?metric=region_co2&stage=bad',
    '/api/v2/overview/region-map?metric=region_co2&domain=不存在',
    '/api/v2/overview/region-map?metric=region_co2&dataset=../x',
    '/api/v2/overview/region-map?metric=region_co2%3B%20DROP%20TABLE%20public_project',
  ];
  for (const p of cases) {
    const out = await call(p, { token: viewerToken });
    assertEqual(out.status, 400, `${p} 应返回 400，实际 ${out.status}`);
    assert(out.json?.error, `${p} 应返回错误说明`);
  }
  assertEqual(db.get("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='public_project'").c, 1);
  assertEqual((await call('/api/v2/overview/region-map/export?format=exe', { token: viewerToken })).status, 400);
});

await testAsync('HTTP CSV 与页面同源，权限审计与缺失标记正确', async () => {
  const res = await fetch(`${BASE}/api/v2/overview/region-map/export?format=csv&metric=region_co2&year=2024&dataset=test-regional-2024`, {
    headers: { authorization: `Bearer ${viewerToken}` },
  });
  assertEqual(res.status, 200);
  assertIncludes(res.headers.get('content-type'), 'text/csv');
  assertIncludes(res.headers.get('content-disposition'), 'attachment');
  assertEqual(res.headers.get('x-export-rows'), '34');
  const text = await res.text();
  assertIncludes(text, '# 数据集: 省域地图');
  assertIncludes(text, '省份');
  assertIncludes(text, '缺失标记');
  assertIncludes(text, '来源链接');
  assertIncludes(text, '原文证据');
  assertIncludes(text, 'tCO2');
  const shLine = text.split(/\r?\n/).find((l) => l.startsWith('上海市,'));
  assert(shLine, '应包含上海市行');
  assertIncludes(shLine, ',1,未取得该省排放记录', '上海缺失标记应为 1');
  const log = db.get("SELECT * FROM export_log WHERE dataset='省域地图' ORDER BY at DESC LIMIT 1");
  assert(log, '导出应写审计');
  assertEqual(log.actor_role, 'viewer');
});

await testAsync('静态底图、前端模块与样式实际下发', async () => {
  const asset = await fetch(`${BASE}/v2/assets/maps/china-provinces.json`);
  assertEqual(asset.status, 200);
  const buf = Buffer.from(await asset.arrayBuffer());
  assertEqual(createHash('sha256').update(buf).digest('hex'), mapSource.sha256);
  const js = await fetch(`${BASE}/v2/modules/region-map.js`);
  assertEqual(js.status, 200);
  const jsText = await js.text();
  assertIncludes(jsText, 'export function buildRegionSvg');
  assertIncludes(jsText, 'region-map-tooltip');
  const overview = await fetch(`${BASE}/v2/modules/overview.js`);
  const overviewText = await overview.text();
  assertIncludes(overviewText, 'mountRegionMap');
  assertNotIncludes(overviewText, "title: '地域分布'", '旧地域表应被地图卡替换');
  const css = await fetch(`${BASE}/v2/styles.css`);
  const cssText = await css.text();
  assertIncludes(cssText, '.region-map-layout');
  assertIncludes(cssText, '.region-map-fallback');
  assertIncludes(cssText, '.region-shape:focus-visible');
  assertIncludes(cssText, '@media (max-width: 760px)');
  assertIncludes(cssText, 'prefers-reduced-motion');
  const mapCss = cssText.slice(cssText.indexOf('.region-map-card'));
  assertNotIncludes(mapCss, 'infinite', '地图卡不应有无限动画');
});

/* ==================================================================== */
/*  七、日更只读检查                                                     */
/* ==================================================================== */

test('日更只做有界状态检查，不重算/覆盖年度值', () => {
  const before = db.get("SELECT COUNT(*) c, MAX(updated_at) u FROM region_emission WHERE status='active'");
  const check = regional.runRegionalDailyCheck({ actor: 'test:115' });
  const after = db.get("SELECT COUNT(*) c, MAX(updated_at) u FROM region_emission WHERE status='active'");
  assertEqual(check.ok, true);
  assertEqual(check.values_changed, false);
  assert(check.active_records >= 6);
  assertEqual(check.latest_year, 2024);
  assertEqual(before.c, after.c);
  assertEqual(before.u, after.u);
  const status = regional.regionMapStatus();
  assertEqual(status.ok, true);
  assert(status.datasets.length >= 4);
  assert(status.coverage.provinces_by_scope.region_co2 >= 5);
  assert(status.directory.total >= 4);
});

test('项目总数按登记号去重、无号按 ID，总览与地图阶段并集口径一致', () => {
  const beforeTotal = ctx.dash.projectProgress({}).project_total;
  addProject({
    id: 'P-DUP-TOTAL-1', name: '同号项目第一次收录', province: '山西省',
    registry: 'REG-DUP-TOTAL-1', domain: '测试去重口径', stagePublic: 1,
  });
  addProject({
    id: 'P-DUP-TOTAL-2', name: '同号项目第二次收录', province: '山西省',
    registry: 'REG-DUP-TOTAL-1', domain: '测试去重口径', stageRegistered: 1, stagePublic: 0,
  });
  addProject({
    id: 'P-DUP-TOTAL-3', name: '同号项目第三次收录', province: '山西省',
    registry: 'REG-DUP-TOTAL-1', domain: '测试去重口径', stageRegistered: 0, stageReduction: 1,
  });
  addProject({
    id: 'P-NO-REG-1', name: '无登记号项目一', province: '河北省',
    registry: null, domain: '测试无号口径', stagePublic: 1,
  });
  addProject({
    id: 'P-NO-REG-2', name: '无登记号项目二', province: '河北省',
    registry: null, domain: '测试无号口径', stageRegistered: 1, stagePublic: 0,
  });

  const dedupProgress = ctx.dash.projectProgress({ domain: '测试去重口径' });
  assertEqual(dedupProgress.project_total, 1, '同号 3 条记录只能算 1 个项目');
  const stageCount = (data, key) => data.stages.find((s) => s.stage === key)?.count;
  assertEqual(stageCount(dedupProgress, 'project_public'), 1, '阶段标记应取并集，不是只取最新一行');
  assertEqual(stageCount(dedupProgress, 'project_registered'), 1, '项目登记阶段应取并集');
  assertEqual(stageCount(dedupProgress, 'reduction_registered'), 1, '减排量登记阶段应取并集');
  assertEqual(ctx.dash.projectProgress({}).project_total, beforeTotal + 3, '1 个同号项目 + 2 个无号项目');

  const dedupMap = regional.buildRegionMap({ domain: '测试去重口径' });
  assertEqual(dedupMap.totals.project_count, 1, '地图项目总数也应同号去重');
  const shanxi = dedupMap.regions.find((r) => r.code === '140000');
  assertEqual(shanxi.project_count, 1, '地图同号项目应只算 1 个');
  assertEqual(shanxi.registered_count, 1, '地图阶段标记应取并集');
  assertEqual(shanxi.reduction_registered_count, 1, '地图减排量登记阶段应取并集');
  assertEqual(regional.buildRegionMap({ domain: '测试去重口径', stage: 'project_public' }).totals.project_count, 1, '地图项目公示筛选应保留并集口径');
  assertEqual(regional.buildRegionMap({ domain: '测试去重口径', stage: 'reduction_registered' }).totals.project_count, 1, '地图减排量登记筛选应保留并集口径');

  const noRegProgress = ctx.dash.projectProgress({ domain: '测试无号口径' });
  assertEqual(noRegProgress.project_total, 2, '无登记号时按项目 ID，不能互相合并');
  assertEqual(regional.buildRegionMap({ domain: '测试无号口径' }).totals.project_count, 2);
  assertEqual(regional.buildRegionMap({ domain: '测试无号口径', stage: 'project_public' }).totals.project_count, 1, '无号项目按 ID 后阶段筛选仍有效');
});

test('名录 0 条只表述平台未收录，排放截至不借名录日期，项目为当前快照且阶段中文', () => {
  const card = mapUi.regionMapCardHtml(natlEtsView, mapUi.createRegionMapState({
    view: 'national_ets', metric: 'national_ets', selectedCode: '140000',
  }));
  assertIncludes(card, '名录未收录（2024）', '0 条名录不能写成裸的「名录 0 家」');
  assertNotIncludes(card, '名录 0 家');
  assertIncludes(card, '排放未取得', '缺少排放值时应明确写出');
  assertIncludes(card, '名录采集日期', '名录日期应另列');
  assertIncludes(card, '本系统收录名录 3 家（2024）', '名录总数应说明是本系统收录');

  const out = regional.buildRegionMapExport({ metric: 'national_ets' });
  const sx = out.rows.find((r) => r.province_code === '140000');
  assertEqual(sx.as_of, '', '没有排放值的行不得借用名录采集日期');
  assertIncludes(sx.ets_directory_note, '未收录');
  assertEqual(out.meta.名录采集日期, '2025-06-30');
  assertIncludes(out.meta.说明, '不代表该省实际重点排放单位总数');

  addProject({
    id: 'P-STAGE-EN-1', name: '阶段英文快照项目', province: '山西省',
    registry: 'REG-STAGE-EN-1', domain: '测试阶段中文', stagePublic: 1,
  });
  db.run("UPDATE public_project SET current_stage='project_public' WHERE id='P-STAGE-EN-1'");
  const projectCard = mapUi.regionMapCardHtml(regional.buildRegionMap({ domain: '测试阶段中文' }),
    mapUi.createRegionMapState({ selectedCode: '140000' }));
  assertIncludes(projectCard, '该省公开项目（当前快照）');
  assertIncludes(projectCard, '项目公示', '内部阶段枚举必须显示中文');
  assertNotIncludes(projectCard, 'project_public');
});

server.close();
finish('test/115-v2-region-map.test.mjs');
