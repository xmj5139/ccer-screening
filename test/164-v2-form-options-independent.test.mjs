import { setupV2, test, testAsync, assert, assertEqual, finish } from './v2-helpers.mjs';
import { loadFormOptions } from '../web/v2/form-selects.js';

await testAsync('选项短期合并请求，过期后读取新年度，失败后可重试', async () => {
  const originalNow = Date.now;
  let now = 100000;
  let calls = 0;
  let fail = false;
  Date.now = () => now;
  const api = async () => {
    calls++;
    if (fail) throw new Error('temporary unavailable');
    return { cea: { years: { entities: calls === 1 ? [2025] : [2026, 2025] } } };
  };
  try {
    const [a, b] = await Promise.all([loadFormOptions(api, { force: true }), loadFormOptions(api)]);
    assertEqual(calls, 1);
    assertEqual(a.cea.years.entities[0].value, '2025');
    assertEqual(b.cea.years.entities[0].value, '2025');
    now += 60001;
    assertEqual((await loadFormOptions(api)).cea.years.entities[0].value, '2026');
    assertEqual(calls, 2);
    fail = true;
    let rejected = false;
    try { await loadFormOptions(api, { force: true }); } catch { rejected = true; }
    assert(rejected);
    fail = false;
    await loadFormOptions(api);
    assertEqual(calls, 4);
  } finally { Date.now = originalNow; }
});

const { db } = await setupV2({ withPublicDemo: false });
const { formOptions } = await import('../src/services/form-options-svc.mjs');
const { searchUnified } = await import('../src/services/unified-search-svc.mjs');
test('重置为空查询后，方法学、CEA文件与企业名录不生成空 WHERE', () => {
  const result = searchUnified({});
  for (const type of ['methodology', 'cea_document', 'entity']) {
    assert(result.per_type[type]);
    assert(!result.per_type[type].error, result.per_type[type].error);
  }
});
test('方法学目录用已核实正式编号提供选项，不泄露内部 PENDING 主键', () => {
  const list = formOptions().projects.methodologies;
  assert(list.some((o) => o.value === 'CCER-14-003' && o.label.includes('滨海盐沼')));
  assert(!list.some((o) => o.value.startsWith('CCER-PENDING-')));
});
test('统一检索地区建议包括因子库实际区域与南方电网，选项读取不写入数据', () => {
  const now = '2026-10-22T00:00:00Z';
  db.run(`INSERT INTO emission_factor
    (id,identity_key,source_identity,source_code,name,value,original_unit,gas,category,caliber,region,
     data_year,publish_date,version,locator,original_url,evidence_level,is_current,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ['EF-164','ef-164','test:164','TEST-164','测试因子',0.5,'kgCO2/kWh','CO2','regional_average','测试口径',
    '区域历史写法',2026,'2026-10-01','v1','表1','https://example.test/164','metadata_only',1,now,now]);
  const before = db.get('SELECT COUNT(*) AS n FROM emission_factor').n;
  const values = formOptions().search.regions.map((x) => x.value);
  assert(values.includes('区域历史写法'));
  assert(values.includes('南方'));
  assertEqual(db.get('SELECT COUNT(*) AS n FROM emission_factor').n, before);
});
finish('164-v2-form-options-independent');
