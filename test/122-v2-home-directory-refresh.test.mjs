/**
 * 测试 122：首页名录地图、名录年度与刷新行为（docs/70）
 * ============================================================================
 * 使用 setupV2 临时库；真实名录审查库只以 readOnly 打开校验 1535/14，绝不写入。
 * 覆盖：
 *   - ets_entities 按信用代码+名录年度去重，多行业不重复，未收录省份 null；
 *   - 名录年度切换、项目筛选不影响名录、区域过滤、CSV 数值/省内全部出处；
 *   - 旧三类视图（项目/区域 CO2/纳管排放）数值与单位不变；
 *   - 刷新按钮/60 秒定时/可见性刷新，失败保留上次数据，销毁后不更新 DOM；
 *   - 视图切换的旧请求不能覆盖新视图。
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  setupV2, test, testAsync, assert, assertEqual, assertIncludes, assertNotIncludes, finish,
  PROJECT_ROOT,
} from './v2-helpers.mjs';

console.log('\n[v2-122] 首页名录地图与刷新');

const ctx = await setupV2({ withPublicDemo: false });
const { db } = ctx;
const regional = await import('../src/services/region-map-svc.mjs');
const mapUi = await import('../web/v2/modules/region-map.js');

// 刷新行为只验证前端状态机；本机底图请求用失败桩，避免任何网络/文件服务器依赖。
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('底图桩：测试不加载本地服务'); };

for (const table of ['cea_entity_membership', 'cea_entity', 'region_emission']) {
  try { db.run(`DELETE FROM ${table}`); } catch { /* 表可能不存在 */ }
}
try { db.run('DELETE FROM public_project'); } catch { /* 表可能不存在 */ }

const NOW = '2026-10-20T10:00:00.000Z';
const PROJECT = {
  id: 'P-122-1', name: '北京林业测试项目', province: '北京市', registry: 'REG-122-1',
  domain: '林业', methodology: 'TEST-122-M', currentStage: '项目公示',
  stagePublic: 1, stageRegistered: 0, stageReduction: 0, isDemo: 0,
};
db.run(
  `INSERT INTO public_project
   (id,name,province,registry_project_no,domain,methodology_id,current_stage,
    stage_project_public,stage_project_registered,stage_reduction_registered,is_demo,
    updated_at,created_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  [PROJECT.id, PROJECT.name, PROJECT.province, PROJECT.registry, PROJECT.domain,
    PROJECT.methodology, PROJECT.currentStage, PROJECT.stagePublic, PROJECT.stageRegistered,
    PROJECT.stageReduction, PROJECT.isDemo, NOW, NOW]
);

function addEntity({
  id, credit, name, province, year, sector, sourceCode, sourceUrl, asOf = '2026-10-01',
  memberships = [],
}) {
  db.run(
    `INSERT INTO cea_entity
     (id,entity_key,name,credit_code,province,city,sector,list_year,status,source_url,
      source_code,data_as_of,verify_status,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, credit || `name:${name}`, name, credit || null, province, null, sector, year,
      'existing', sourceUrl, sourceCode, asOf, 'source_recorded', NOW, NOW]
  );
  for (const [index, m] of memberships.entries()) {
    db.run(
      `INSERT INTO cea_entity_membership
       (id,entity_id,source_code,sector,source_url,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?)`,
      [`${id}-M${index + 1}`, id, m.sourceCode || sourceCode, m.sector || sector,
        m.sourceUrl || sourceUrl, NOW, NOW]
    );
  }
}

// 2026：广东 2 家（发电/钢铁）、河南 1 家（发电）、北京 1 家（发电+水泥，多行业只计 1）。
addEntity({
  id: 'E-GD-1', credit: '91440000GD000001', name: '广东发电测试一厂', province: '广东省',
  year: 2026, sector: '发电', sourceCode: 'gd_power_2026',
  sourceUrl: 'https://gdee.gd.gov.cn/attachment/2026-power.pdf', asOf: '2026-10-01',
  memberships: [{ sector: '发电' }],
});
addEntity({
  id: 'E-GD-2', credit: '91440000GD000002', name: '广东钢铁测试二厂', province: '广东省',
  year: 2026, sector: '钢铁', sourceCode: 'gd_steel_2026',
  sourceUrl: 'https://gdee.gd.gov.cn/attachment/2026-steel.pdf', asOf: '2026-10-02',
  memberships: [{ sector: '钢铁' }],
});
addEntity({
  id: 'E-HN-1', credit: '91410000HN000001', name: '河南发电测试厂', province: '河南省',
  year: 2026, sector: '发电', sourceCode: 'hn_power_2026',
  sourceUrl: 'https://sthjt.henan.gov.cn/attachment/2026-power.pdf', asOf: '2026-09-30',
  memberships: [{ sector: '发电' }],
});
addEntity({
  id: 'E-BJ-1', credit: '91110000BJ000001', name: '北京发电水泥测试厂', province: '北京市',
  year: 2026, sector: '发电、水泥', sourceCode: 'bj_2026',
  sourceUrl: 'https://sthjj.beijing.gov.cn/attachment/2026-list.docx', asOf: '2026-10-03',
  memberships: [{ sector: '发电' }, { sector: '水泥' }],
});
addEntity({
  id: 'E-UNK-1', credit: '91440000UNK00001', name: '省份无法归并测试厂', province: '海外',
  year: 2026, sector: '发电', sourceCode: 'unknown_2026',
  sourceUrl: 'https://gdee.gd.gov.cn/attachment/unknown.pdf', asOf: '2026-10-01',
});
// 2025：广东同一信用代码 1 家、上海 1 家，用于名录年度切换。
addEntity({
  id: 'E-GD-2025', credit: '91440000GD000001', name: '广东发电测试一厂', province: '广东省',
  year: 2025, sector: '发电', sourceCode: 'gd_power_2025',
  sourceUrl: 'https://gdee.gd.gov.cn/attachment/2025-power.pdf', asOf: '2025-10-01',
});
addEntity({
  id: 'E-SH-2025', credit: '91310000SH000001', name: '上海发电测试厂', province: '上海市',
  year: 2025, sector: '发电', sourceCode: 'sh_2025',
  sourceUrl: 'https://sthj.sh.gov.cn/attachment/2025-list.pdf', asOf: '2025-10-02',
});

const BASE_EMISSION = {
  province: '北京市', scope: 'region_co2', year: 2024, value_tco2: 12345,
  unit: 'tCO2', methodology: '测试核算方法（临时库，非真实）', boundary: '测试边界：省级核算',
  dataset_key: 'test-122-emission', source_name: '测试临时数据（非真实）',
  source_url: 'https://example.org/test-122', source_kind: 'research',
  published_at: '2025-01-01',
  excerpt: '测试临时数据：2024 年 CO2 排放 12345 吨（非真实，仅测试）',
  collected_at: '2026-01-01T00:00:00.000Z',
};
assert(regional.importRegionRecords([BASE_EMISSION], { actor: 'test:122' }).ok);
assert(regional.importRegionRecords([{
  ...BASE_EMISSION, scope: 'national_ets', value_tco2: 6789,
  dataset_key: 'test-122-ets', source_name: '测试纳管排放（非真实）',
  excerpt: '测试临时数据：全国碳市场纳管排放 6789 吨（非真实）',
}], { actor: 'test:122' }).ok);

const directory2026 = regional.buildRegionMap({ metric: 'ets_entities', list_year: 2026 });
const directory2025 = regional.buildRegionMap({ metric: 'ets_entities', list_year: 2025 });
const directoryDefault = regional.buildRegionMap({ metric: 'ets_entities' });
const directoryFiltered = regional.buildRegionMap({
  metric: 'ets_entities', list_year: 2026, domain: '林业', methodology_id: 'TEST-122-M',
  stage: 'project_registered',
});
const projectsView = regional.buildRegionMap({});
const co2View = regional.buildRegionMap({ metric: 'region_co2' });
const etsView = regional.buildRegionMap({ metric: 'national_ets' });

/* ==================================================================== */
/*  一、名录指标与年度                                                   */
/* ==================================================================== */

test('名录按信用代码+年度去重，多行业只计 1 家，未收录省份为 null', () => {
  assertEqual(directory2026.metric, 'ets_entities');
  assertEqual(directory2026.metric_label, 'CEA纳管企业名录');
  assertEqual(directory2026.unit, '家');
  assertEqual(directory2026.regions.length, 34);
  assertEqual(directory2026.list_year, 2026);
  assertEqual(directory2026.list_year_options.join(','), '2026,2025');
  assertEqual(directory2026.totals.directory_total, 4);
  assertEqual(directory2026.totals.directory_covered_regions, 3);
  assertEqual(directory2026.totals.covered_regions, 3);
  const gd = directory2026.regions.find((r) => r.code === '440000');
  const bj = directory2026.regions.find((r) => r.code === '110000');
  const tj = directory2026.regions.find((r) => r.code === '120000');
  assertEqual(gd.ets_directory.count, 2);
  assertEqual(bj.ets_directory.count, 1, '同一主体多行业/多出处只计 1 家');
  assertEqual(bj.directory.sectors.join('、'), '发电、水泥');
  assertEqual(tj.ets_directory.count, null, '未收录省份必须是 null');
  assertEqual(tj.value, null);
  assertEqual(tj.missing, true);
  assertIncludes(gd.ets_directory.coverage_note, '仅取得发电、钢铁行业名单');
  assertIncludes(directory2026.directory_summary.coverage_note, '本平台已收录');
  assertIncludes(directory2026.directory_summary.coverage_note, '非全国/全省完整数量');
  assertEqual(directory2026.unknown.directory.count, 1, '省份无法归并的名录单列');
});

test('名录年度默认最新且可切换，不借用排放 year', () => {
  assertEqual(directoryDefault.list_year, 2026);
  assertEqual(directoryDefault.totals.directory_total, 4);
  assertEqual(directory2025.list_year, 2025);
  assertEqual(directory2025.totals.directory_total, 2);
  assertEqual(directory2025.regions.find((r) => r.code === '440000').ets_directory.count, 1);
  assertEqual(directory2025.regions.find((r) => r.code === '310000').ets_directory.count, 1);
  assertEqual(directory2025.regions.find((r) => r.code === '410000').ets_directory.count, null);
  const badYear = regional.buildRegionMap({ metric: 'ets_entities', list_year: 2024 });
  assertEqual(badYear.status, 400);
  assertIncludes(badYear.error, '未收录 2024 年名录');
  assertEqual(regional.buildRegionMap({ metric: 'ets_entities', year: 2026 }).status, 400);
  assertEqual(regional.buildRegionMap({ metric: 'ets_entities', dataset: 'test-122-emission' }).status, 400);
  assertEqual(regional.buildRegionMap({ metric: 'projects', list_year: 2026 }).status, 400);
  assertEqual(regional.buildRegionMap({ metric: 'region_co2', list_year: 2025 }).status, 400);
});

test('项目阶段/领域/方法学筛选不改变名录企业数', () => {
  assertEqual(directoryFiltered.totals.directory_total, 4);
  assertEqual(directoryFiltered.totals.directory_covered_regions, 3);
  assertEqual(directoryFiltered.regions.find((r) => r.code === '110000').ets_directory.count, 1);
  assertIncludes(directoryFiltered.filters.note, '不改变名录企业数');
});

/* ==================================================================== */
/*  二、来源、区域过滤与 CSV                                             */
/* ==================================================================== */

test('省份详情返回该省全部官方出处，不用全库最后一条来源替代', () => {
  const gd = directory2026.regions.find((r) => r.code === '440000');
  assertEqual(gd.ets_directory.sources.length, 2);
  const urls = gd.ets_directory.sources.map((s) => s.source_url).join(' ');
  assertIncludes(urls, '2026-power.pdf');
  assertIncludes(urls, '2026-steel.pdf');
  assertNotIncludes(urls, '2026-list.docx');
  const bj = directory2026.regions.find((r) => r.code === '110000');
  assertEqual(bj.ets_directory.sources.length, 1);
  assertIncludes(bj.ets_directory.sources[0].source_url, '2026-list.docx');
  assertEqual(directory2026.directory_source.source_count, 4);
});

test('区域过滤只影响排名/导出，CSV 数值与省内出处一致', () => {
  const out = regional.buildRegionMapExport({ metric: 'ets_entities', list_year: 2026, region: '华南' });
  assertEqual(out.ok, true);
  assertEqual(out.rows.length, 3, '华南应导出广东、广西、海南 3 个省级地区');
  assert(out.rows.every((r) => r.region_group === '华南'));
  const gd = out.rows.find((r) => r.province_code === '440000');
  assertEqual(gd.value, 2);
  assertEqual(gd.unit, '家');
  assertEqual(gd.ets_directory_count, 2);
  assertEqual(gd.ets_directory_year, 2026);
  assertIncludes(gd.ets_source_urls, '2026-power.pdf');
  assertIncludes(gd.ets_source_urls, '2026-steel.pdf');
  assertNotIncludes(gd.ets_source_urls, '2026-list.docx');
  assertEqual(gd.ets_source_count, 2);
  assertIncludes(gd.ets_coverage_note, '仅取得发电、钢铁行业名单');
  const bj = out.rows.find((r) => r.province_code === '110000');
  assertEqual(bj, undefined, '区域过滤不应包含华北的北京');
  assertEqual(out.meta.年度, 2026);
  assertEqual(out.meta.数据截至, '2026-10-03');
  assertIncludes(out.meta.说明, '未收录为 null');
  assertEqual(out.fileBase, 'region_map_ets_entities_2026');

  const all = regional.buildRegionMapExport({ metric: 'ets_entities', list_year: 2026 });
  assertEqual(all.rows.length, 34);
  const tj = all.rows.find((r) => r.province_code === '120000');
  assertEqual(tj.value, null);
  assertEqual(tj.missing, 1);
  assertIncludes(tj.missing_reason, '不补 0');
  assertEqual(tj.ets_source_urls, '');
});

/* ==================================================================== */
/*  三、旧三视图语义不变                                                 */
/* ==================================================================== */

test('项目/区域 CO2/纳管排放三类旧视图数值、单位与来源不变', () => {
  assertEqual(projectsView.metric, 'projects');
  assertEqual(projectsView.regions.find((r) => r.code === '110000').value, 1);
  assertEqual(projectsView.unit, '个');
  assertEqual(co2View.metric, 'region_co2');
  assertEqual(co2View.regions.find((r) => r.code === '110000').value, 12345);
  assertEqual(co2View.unit, 'tCO2');
  assertEqual(etsView.metric, 'national_ets');
  assertEqual(etsView.regions.find((r) => r.code === '110000').value, 6789);
  assertEqual(etsView.unit, 'tCO2');
  assertEqual(etsView.regions.find((r) => r.code === '110000').ets_directory.count, 1);
  assertEqual(etsView.totals.directory_total, 4);
});

/* ==================================================================== */
/*  四、真实审查库只读校验                                               */
/* ==================================================================== */

test('真实审查库只读校验 1535 家/14 地区/名录 2026，不修改库', () => {
  const reviewDb = resolve(PROJECT_ROOT, 'data', 'cea-directory-review-final-20261020.db');
  assert(existsSync(reviewDb), `缺少真实审查库：${reviewDb}`);
  const ro = new DatabaseSync(reviewDb, { readOnly: true });
  try {
    const year = ro.prepare('SELECT MAX(list_year) AS y FROM cea_entity').get().y;
    const total = ro.prepare('SELECT COUNT(DISTINCT entity_key) AS n FROM cea_entity WHERE list_year=?').get(year).n;
    const provinces = ro.prepare('SELECT COUNT(DISTINCT province) AS n FROM cea_entity WHERE list_year=?').get(year).n;
    assertEqual(year, 2026);
    assertEqual(total, 1535);
    assertEqual(provinces, 14);
    const gdSources = ro.prepare(
      `SELECT COUNT(DISTINCT COALESCE(m.source_url, e.source_url)) AS n
         FROM cea_entity e LEFT JOIN cea_entity_membership m ON m.entity_id=e.id
        WHERE e.list_year=? AND e.province='广东'`
    ).get(year).n;
    assert(gdSources >= 1, '广东应有至少一份可追溯出处');
    const henan = ro.prepare(
      'SELECT COUNT(DISTINCT sector) AS n FROM cea_entity WHERE list_year=? AND province=?'
    ).get(year, '河南').n;
    assert(henan <= 2, '河南本批只取得发电/钢铁两类行业，不应虚增');
  } finally {
    ro.close();
  }
});

/* ==================================================================== */
/*  五、前端名录渲染与跳转                                               */
/* ==================================================================== */

test('前端名录卡：热力图、年度、全部出处、明细与名录入口', () => {
  const state = mapUi.createRegionMapState({
    view: 'ets_entities', metric: 'ets_entities', listYear: 2026, selectedCode: '440000',
    lastSuccessAt: '2026-10-20T10:00:00.000Z',
  });
  const card = mapUi.regionMapCardHtml(directory2026, state, { filters: { domain: '林业' } });
  assertIncludes(card, 'CEA纳管企业名录');
  assertIncludes(card, '名录年度');
  assertIncludes(card, '2026 年');
  assertIncludes(card, '2 家');
  assertIncludes(card, '仅取得发电、钢铁行业名单');
  assertIncludes(card, '名录出处（全部 2 份）');
  assertIncludes(card, '2026-power.pdf');
  assertIncludes(card, '2026-steel.pdf');
  assertNotIncludes(card, '2026-list.docx', '广东详情不应混入北京出处');
  assertIncludes(card, '单位：家');
  assertIncludes(card, '刷新数据');
  assertIncludes(card, '最近成功读取');
  assertIncludes(card, '当前为名录热力图');
  assertIncludes(card, 'data-map-list-year');
  assertIncludes(card, 'aria-label="名录年度"');
  assertIncludes(card, '2025 年');
  assertIncludes(card, '不改变名录企业数');
  assertNotIncludes(card, 'tCO2（展示换算为万吨/亿吨）');
  const href = mapUi.entityListHref(directory2026.regions.find((r) => r.code === '440000'));
  assertIncludes(decodeURIComponent(href), 'province=广东省');
  assertIncludes(href, 'list_year=2026');
});

test('显式名录入口直接请求名录视图并保留筛选，默认入口仍为项目', () => {
  const direct = mapUi.mapQueryFromRoute({
    map: 'ets_entities', list_year: '2026', domain: '林业', methodology_id: 'TEST-122-M', stage: 'project_registered',
  });
  assertEqual(direct.get('metric'), 'ets_entities');
  assertEqual(direct.get('list_year'), '2026');
  assertEqual(direct.get('domain'), '林业');
  assertEqual(direct.get('methodology_id'), 'TEST-122-M');
  assertEqual(direct.get('stage'), 'project_registered');
  const normal = mapUi.mapQueryFromRoute({ domain: '林业' });
  assertEqual(normal.get('metric'), null, '普通总览入口仍使用默认 CCER 项目视图');
  assertEqual(normal.get('domain'), '林业');

  const mounted = mapUi.mountRegionMap({
    root: makeRefreshRoot(), initialData: directory2026, filters: {}, contextProvince: null,
    fetchApi: async () => clone(directory2026),
  });
  try {
    assertEqual(mounted.getState().view, 'ets_entities', '从名录入口进入应直接展示名录热力图');
    assertEqual(mounted.getState().listYear, 2026);
    assertEqual(mapUi.currentMetric(mounted.getState().data, mounted.getState()), 'ets_entities');
  } finally {
    mounted.dispose();
  }
});

test('默认项目视图显眼展示最新名录摘要并直达名录热力图', () => {
  const card = mapUi.regionMapCardHtml(projectsView, mapUi.createRegionMapState({}));
  assertIncludes(card, '最新已收录纳管企业');
  assertIncludes(card, '4');
  assertIncludes(card, '家');
  assertIncludes(card, '覆盖 3 个省级地区');
  assertIncludes(card, '名录 2026 年');
  assertIncludes(card, '查看名录热力图');
  assertIncludes(card, 'map=ets_entities');
  assertIncludes(card, 'list_year=2026');
  assertIncludes(card, '本平台已收录');
});

/* ==================================================================== */
/*  六、刷新行为（轻量 DOM 桩，不引入依赖）                              */
/* ==================================================================== */

function makeNode(name) {
  return {
    name,
    _html: '',
    hidden: false,
    textContent: '',
    attrs: {},
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k] ?? null; },
    removeAttribute(k) { delete this.attrs[k]; },
    focus() {},
    querySelector() { return null; },
  };
}

function makeRefreshRoot() {
  const nodes = {};
  const root = {
    _html: '',
    innerHTMLSets: 0,
    _listeners: {},
    _listenerCount: 0,
    _removed: 0,
    get innerHTML() { return this._html; },
    set innerHTML(value) {
      this._html = String(value);
      this.innerHTMLSets += 1;
      nodes.slot = makeNode('slot');
      nodes.attribution = makeNode('attribution');
      nodes.error = makeNode('error');
      nodes.meta = makeNode('meta');
      nodes.chip = makeNode('chip');
      nodes.export = makeNode('export');
      nodes.refresh = makeNode('refresh');
      nodes.body = makeNode('body');
      nodes.card = makeNode('card');
      nodes.card.querySelector = (sel) => (sel === '.region-map-body' ? nodes.body : null);
      if (this._html.includes('data-map-refresh-error') && /data-map-refresh-error[^>]*hidden/.test(this._html)) {
        nodes.error.hidden = true;
      }
    },
    querySelector(sel) {
      if (sel === '[data-map-slot]') return nodes.slot || null;
      if (sel === '[data-map-attribution]') return nodes.attribution || null;
      if (sel === '[data-map-refresh-error]') return nodes.error || null;
      if (sel === '[data-map-last-refresh]') return nodes.meta || null;
      if (sel === '[data-map-updating]') return nodes.chip || null;
      if (sel === '[data-map-export]') return nodes.export || null;
      if (sel === '[data-map-refresh]') return nodes.refresh || null;
      if (sel === '.region-map-card') return nodes.card || null;
      if (sel === '[data-map-svg]') return null;
      return null;
    },
    querySelectorAll() { return []; },
    addEventListener(type, fn) {
      this._listeners[type] = fn;
      this._listenerCount += 1;
    },
    removeEventListener(type, fn) {
      if (this._listeners[type] === fn) {
        delete this._listeners[type];
        this._listenerCount -= 1;
        this._removed += 1;
      }
    },
    nodes,
  };
  return root;
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const deferred = () => {
  let resolveFn;
  let rejectFn;
  const promise = new Promise((res, rej) => { resolveFn = res; rejectFn = rej; });
  return { promise, resolve: resolveFn, reject: rejectFn };
};
const clone = (v) => JSON.parse(JSON.stringify(v));

await testAsync('“刷新数据”按钮触发只读刷新且不重复挂载', async () => {
  const root = makeRefreshRoot();
  let fetchCalls = 0;
  const fetchApi = async () => {
    fetchCalls += 1;
    const fresh = clone(projectsView);
    fresh.generated_at = '2026-10-20T13:00:00.000Z';
    return fresh;
  };
  const mounted = mapUi.mountRegionMap({
    root, initialData: projectsView, filters: {}, contextProvince: null, fetchApi,
  });
  try {
    const listenerCount = root._listenerCount;
    const sets = root.innerHTMLSets;
    const target = { closest: (sel) => (sel === '[data-map-refresh]' ? { dataset: {} } : null) };
    root._listeners.click({ target, preventDefault() {} });
    await flush();
    assertEqual(fetchCalls, 1, '点击刷新按钮应读取一次地图 API');
    assertEqual(root.innerHTMLSets, sets, '数据未变化时不得整卡重挂载');
    assertEqual(root._listenerCount, listenerCount, '刷新不得重复绑定事件');
    assertIncludes(root.nodes.meta.textContent, '2026-10-20');
  } finally {
    mounted.dispose();
  }
});

await testAsync('60 秒刷新、连续刷新不重复挂载、销毁清理定时器与监听', async () => {
  const prevSet = globalThis.setInterval;
  const prevClear = globalThis.clearInterval;
  const prevDocument = globalThis.document;
  const intervals = [];
  const visibility = {};
  globalThis.setInterval = (fn, ms) => {
    const handle = { fn, ms, unref() {}, cleared: false };
    intervals.push(handle);
    return handle;
  };
  globalThis.clearInterval = (handle) => { handle.cleared = true; };
  globalThis.document = {
    visibilityState: 'visible',
    addEventListener(type, fn) { visibility[type] = fn; },
    removeEventListener(type, fn) { if (visibility[type] === fn) delete visibility[type]; },
  };
  try {
    const root = makeRefreshRoot();
    let fetchCalls = 0;
    let pending = null;
    const fetchApi = async (url) => {
      fetchCalls += 1;
      assertIncludes(url, 'metric=projects');
      pending = deferred();
      return pending.promise;
    };
    const mounted = mapUi.mountRegionMap({
      root, initialData: projectsView, filters: {}, contextProvince: null, fetchApi,
    });
    assertEqual(intervals.length, 1, '每次挂载只能有一个 60 秒定时器');
    assertEqual(intervals[0].ms, 60000);
    assert(visibility.visibilitychange, '应监听标签页可见性');
    const listenerCount = root._listenerCount;
    const initialSets = root.innerHTMLSets;

    intervals[0].fn();
    await flush();
    assertEqual(fetchCalls, 1, '定时器应触发一次只读刷新');
    const second = mounted.refresh();
    assertEqual(await second, false, '刷新进行中不得重叠发起第二次');
    assertEqual(fetchCalls, 1);
    const fresh = clone(projectsView);
    fresh.generated_at = '2026-10-20T12:00:00.000Z';
    pending.resolve(fresh);
    await flush();
    assertEqual(root.innerHTMLSets, initialSets, '数据未变化时只更新读取时间，不整卡重渲染');
    assertIncludes(root.nodes.meta.textContent, '2026-10-20');
    assertEqual(root._listenerCount, listenerCount, '刷新不得重复绑定事件');
    assertEqual(intervals.length, 1, '刷新不得重复挂载/新建定时器');

    visibility.visibilitychange();
    await flush();
    assertEqual(fetchCalls, 2, '标签页重新可见时应立即刷新');
    pending.resolve(clone(projectsView));
    await flush();

    mounted.dispose();
    assertEqual(intervals[0].cleared, true, '销毁时必须清理定时器');
    assertEqual(visibility.visibilitychange, undefined, '销毁时必须移除可见性监听');
    assertEqual(root._listenerCount, 0, '销毁时必须移除根节点事件委托');
  } finally {
    globalThis.setInterval = prevSet;
    globalThis.clearInterval = prevClear;
    globalThis.document = prevDocument;
  }
});

await testAsync('切换视图后旧请求不能覆盖新视图', async () => {
  const root = makeRefreshRoot();
  const requests = [];
  const fetchApi = (url) => {
    const d = deferred();
    requests.push({ url, ...d });
    return d.promise;
  };
  const mounted = mapUi.mountRegionMap({
    root, initialData: projectsView, filters: {}, contextProvince: null, fetchApi,
  });
  try {
    const first = mounted.loadView('ets_entities');
    await flush();
    const second = mounted.loadView('region_co2');
    await flush();
    assertEqual(requests.length, 2);
    requests[1].resolve(clone(co2View));
    await second;
    await flush();
    assertEqual(mounted.getState().data.metric, 'region_co2');
    requests[0].resolve(clone(directory2026));
    await first;
    await flush();
    assertEqual(mounted.getState().data.metric, 'region_co2', '旧请求不得覆盖新视图');
    assertIncludes(root._html, '区域 CO₂ 排放');
    assertNotIncludes(root._html, 'CEA纳管企业名录｜');
  } finally {
    mounted.dispose();
  }
});

await testAsync('刷新失败保留上次成功数据并显示可重试提示', async () => {
  const root = makeRefreshRoot();
  let rejectNext = false;
  const fetchApi = async () => {
    if (rejectNext) throw new Error('网络中断（测试）');
    return clone(projectsView);
  };
  const mounted = mapUi.mountRegionMap({
    root, initialData: projectsView, filters: {}, contextProvince: null, fetchApi,
  });
  try {
    const beforeData = mounted.getState().data;
    const beforeTime = mounted.getState().lastSuccessAt;
    const beforeSets = root.innerHTMLSets;
    rejectNext = true;
    await mounted.refresh({ source: 'manual' });
    assertEqual(mounted.getState().data, beforeData, '失败时必须保留上次成功数据');
    assertEqual(mounted.getState().lastSuccessAt, beforeTime, '失败不得改写最近成功读取时间');
    assertEqual(root.innerHTMLSets, beforeSets, '失败不得整卡回退成项目错误页');
    assertIncludes(root._html, '省域地图与排放');
    assertEqual(root.nodes.error.hidden, false);
    assertIncludes(root.nodes.error.innerHTML, '刷新失败，仍显示上次成功数据');
    assertIncludes(root.nodes.error.innerHTML, '网络中断（测试）');
    assertIncludes(root.nodes.error.innerHTML, 'data-map-refresh-retry');
    assertIncludes(root.nodes.meta.textContent, '最近成功读取');
  } finally {
    mounted.dispose();
  }
});

await testAsync('视图加载失败保留旧图并明确提示，不伪装成新视图成功', async () => {
  const root = makeRefreshRoot();
  const fetchApi = async () => { throw new Error('名录接口失败（测试）'); };
  const mounted = mapUi.mountRegionMap({
    root, initialData: projectsView, filters: {}, contextProvince: null, fetchApi,
  });
  try {
    await mounted.loadView('ets_entities');
    assertEqual(mounted.getState().data.metric, 'projects', '失败时不得把旧项目图当作名录图');
    assertEqual(root.nodes.error.hidden, false);
    assertIncludes(root.nodes.error.innerHTML, 'CEA纳管企业名录加载失败，仍显示上次成功数据');
    assertIncludes(root.nodes.error.innerHTML, '名录接口失败（测试）');
    assertIncludes(root._html, '最新已收录纳管企业', '旧图仍可见，但失败提示必须同时存在');
  } finally {
    mounted.dispose();
  }
});

await testAsync('销毁后待处理请求不得更新 DOM', async () => {
  const root = makeRefreshRoot();
  const d = deferred();
  const fetchApi = async () => d.promise;
  const mounted = mapUi.mountRegionMap({
    root, initialData: projectsView, filters: {}, contextProvince: null, fetchApi,
  });
  const setsBefore = root.innerHTMLSets;
  const metaBefore = root.nodes.meta.textContent;
  const pending = mounted.refresh({ source: 'manual' });
  await flush();
  mounted.dispose();
  d.resolve(clone(directory2026));
  await pending;
  await flush();
  assertEqual(root.innerHTMLSets, setsBefore, '销毁后不得重渲染');
  assertEqual(root.nodes.meta.textContent, metaBefore, '销毁后不得更新读取时间');
  assertEqual(root.nodes.error.hidden, true, '销毁后不得显示新错误/新状态');
  assertEqual(mounted.isDestroyed(), true);
});

finish('test/122-v2-home-directory-refresh.test.mjs');
