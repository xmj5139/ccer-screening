/**
 * 119-v2-cea-entity-directory.test.mjs —— docs/64 全国碳市场企业名录补采修复
 * ============================================================================
 * 覆盖：
 *   1. 默认来源轮换（未尝试 → last_attempt_at 最旧 → priority/code 稳定）；
 *   2. 显式 codes 严格按指定顺序，不擅自轮换；
 *   3. 名录标题年度优先，发布日期/2025 年通知引用不误作 2026 名录年度；
 *   4. 年度冲突返回缺口；
 *   5. HTML 不同列顺序、多表按表标题行业；
 *   6. PDF 换行公司名、换行地区、2511 行业代码不当实际纳管类别；
 *   7. 可信小行业 1 行可解析；无表头/采购公告 1 行仍拦截；
 *   8. 地方试点、仅报告核查、拟纳入/征求意见名录拦截；
 *   9. 同源 hash 未变复用缓存、不重复更新；缓存缺失时弱解析不覆盖完整字段；
 *  10. 累计标记如实（sources_attempted / sources_not_attempted / truncated）。
 *
 * 隔离：setupV2 使用系统临时库；本机回环 stub，无真实付费服务，不触碰生产/预览库。
 */
import { createServer } from 'node:http';
import {
  setupV2, finish, test, testAsync, assert, assertEqual, assertIncludes,
} from './v2-helpers.mjs';

const ctx = await setupV2();
const { db } = ctx;
const parse = await import('../src/services/cea-parse.mjs');
const collect = await import('../src/services/cea-collect-svc.mjs');
const sourcesData = await import('../src/data/cea-sources.mjs');
const publicData = await import('../src/data/cea-entity-public-sources.mjs');

process.env.CCER_ALLOW_LOOPBACK_OUTBOUND = '1';

console.log('\n[v2-119] 企业名录补采：来源轮换 / HTML 多表 / PDF 换行 / 小名单 / 缓存');

/* ------------------------------------------------------------------ */
/* 本机官方原件 stub（只返回测试 HTML，不访问外网）                     */
/* ------------------------------------------------------------------ */

const routes = new Map();
const hits = [];
const stub = createServer((req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname;
  hits.push(path);
  const body = routes.get(path) || '<html><body><p>stub not found</p></body></html>';
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
});
await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
const STUB = `http://127.0.0.1:${stub.address().port}`;

function entityHtml(title, rows, headers = ['序号', '企业名称', '统一社会信用代码', '地区']) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>
<h1>${title}</h1>
<table><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr>
${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('\n')}
</table></body></html>`;
}

function insertSource(code, path, { priority = 100, enabled = 1, lastAttempt = null } = {}) {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO cea_source
       (id,code,name,url,dataset,kind,authority,allowed_domains,enabled,priority,last_attempt_at,created_at,updated_at)
     VALUES (?,?,?,?, 'entity','official_html','测试机关',?,?,?,?,?,?)`,
    [`SRC119-${code}`, code, `测试来源-${code}`, `${STUB}${path}`,
      JSON.stringify(['127.0.0.1']), enabled, priority, lastAttempt, now, now]
  );
}

function resetEntityTestData() {
  // 不删除 cea_source（其余表可能仍引用 source_id）；只停用旧测试来源，
  // 每个用例用全新 code，默认轮换只查 enabled=1。
  db.run("UPDATE cea_source SET enabled=0 WHERE dataset='entity'");
  db.run('DELETE FROM cea_entity_membership');
  db.run('DELETE FROM cea_entity_revision');
  db.run('DELETE FROM cea_entity');
  db.run("DELETE FROM data_gap WHERE dataset='cea_entity'");
  hits.length = 0;
}

/* ------------------------------------------------------------------ */
/* 1) 来源轮换与显式顺序                                                */
/* ------------------------------------------------------------------ */

test('默认来源轮换：未尝试优先 → last_attempt_at 最旧 → priority/code 稳定', () => {
  const batch = collect.selectCeaEntitySourceBatch([
    { code: 'a', priority: 30, last_attempt_at: null },
    { code: 'b', priority: 10, last_attempt_at: null },
    { code: 'c', priority: 5, last_attempt_at: '2026-10-01T00:00:00.000Z' },
    { code: 'd', priority: 50, last_attempt_at: '2026-09-01T00:00:00.000Z' },
    { code: 'e', priority: 1, last_attempt_at: '2026-09-15T00:00:00.000Z' },
    { code: 'f', priority: 20, last_attempt_at: null },
  ], { limit: 4 });
  assertEqual(batch.selected.map((s) => s.code).join(','), 'b,f,a,d',
    '未尝试来源按 priority 优先，然后已尝试来源按 last_attempt_at 最旧优先');
  assertEqual(batch.deferred.map((s) => s.code).join(','), 'e,c');
});

/* ------------------------------------------------------------------ */
/* 2) 年度识别与冲突                                                    */
/* ------------------------------------------------------------------ */

test('名录年度：标题 2026 优先，发布日期 2025 / 2025 年通知引用不得误作年度', () => {
  const html = entityHtml(
    '上海市2026年度全国碳排放权交易市场（发电行业）重点排放单位名录',
    [['1', '上海外高桥发电有限责任公司', '91310115132236621M', '浦东新区']]
  ).replace('</body>', '<p>发布时间：2025-10-27</p><p>根据《关于做好2025年全国碳排放权交易市场有关工作的通知》要求。</p></body>');
  const year = parse.detectEntityListYear(html);
  assertEqual(year.year, 2026);
  assertEqual(year.year_source, '原文');
  assertEqual(year.conflict, false);
  const rows = parse.parseEntityRows(html);
  assertEqual(rows.length, 1);
  assertEqual(rows[0].list_year, 2026);
  assertEqual(rows[0].year_source, '原文');
  assertEqual(rows[0].name, '上海外高桥发电有限责任公司');
});

test('名录年度冲突：标题 2026 与另一名录标题 2025 → 返回缺口，不猜测', () => {
  const html = `<html><body>
<h1>某省2026年度全国碳排放权交易市场重点排放单位名录</h1>
<p>2025年度重点排放单位名录（历史链接）</p>
<table><tr><th>序号</th><th>企业名称</th><th>统一社会信用代码</th></tr>
<tr><td>1</td><td>某省测试发电有限公司</td><td>91310115132236621M</td></tr></table>
</body></html>`;
  const year = parse.detectEntityListYear(html);
  assertEqual(year.conflict, true);
  assertEqual(year.year, null);
  assertIncludes(year.reason, '冲突');
  assertEqual(parse.parseEntityRows(html, { listYear: 2026 }).length, 0);
});

/* ------------------------------------------------------------------ */
/* 3) HTML 表格：列顺序与多表行业                                       */
/* ------------------------------------------------------------------ */

test('HTML 不同列顺序：按表头取值，不把行业/地区拼入名称', () => {
  const html = `<html><body>
<h2>上海市2026年度全国碳排放权交易市场（发电行业）重点排放单位名录</h2>
<table>
<tr><th>统一社会信用代码</th><th>企业名称</th><th>所属区</th></tr>
<tr><td>91310115132236621M</td><td>上海外高桥发电有限责任公司</td><td>浦东新区</td></tr>
</table>
<h2>上海市2026年度全国碳排放权交易市场（钢铁行业）重点排放单位名录</h2>
<table>
<tr><th>地区</th><th>统一社会信用代码</th><th>企业名称</th></tr>
<tr><td>宝山区</td><td>91310000631696382C</td><td>宝山钢铁股份有限公司</td></tr>
</table>
</body></html>`;
  const rows = parse.parseEntityRows(html);
  assertEqual(rows.length, 2, JSON.stringify(rows));
  assertEqual(rows[0].name, '上海外高桥发电有限责任公司');
  assertEqual(rows[0].sector, '发电');
  assertEqual(rows[0].city, '浦东新区');
  assertEqual(rows[1].name, '宝山钢铁股份有限公司');
  assertEqual(rows[1].sector, '钢铁');
  assertEqual(rows[1].city, '宝山区');
  assert(!rows.some((r) => /发电行业|钢铁行业|浦东新区|宝山区/.test(r.name)), '名称不得混入行业/地区列');
});

/* ------------------------------------------------------------------ */
/* 4) PDF 文本：换行名称、换行地区、2511 分类代码                        */
/* ------------------------------------------------------------------ */

test('PDF 换行公司名：上一行 + 代码行后「司」合并为完整名称', () => {
  const text = `广东省 2026 年度全国碳排放权交易市场（发电行业）
重点排放单位名录
序号 企业名称 统一社会信用代码 国民经济行业分类代码 备注
广东粤电花都天然气热电有限公
14 91440114061140330M 电力（44）
司`;
  const rows = parse.parseEntityRows(text);
  assertEqual(rows.length, 1);
  assertEqual(rows[0].name, '广东粤电花都天然气热电有限公司');
  assertEqual(rows[0].credit_code, '91440114061140330M');
  assertEqual(rows[0].sector, '发电');
});

test('PDF 换行地区与 2511：凉山彝族自治州正确合并；2511 不成为纳管类别', () => {
  const text = `四川省 2026 年度全国碳排放权交易市场（钢铁行业）
重点排放单位名录
序号 企业名称 统一社会信用代码 核算行业 核算子行业 地区
5 攀钢集团西昌钢钒有限公司 91513401MA62H9WN95 钢铁(31) 长流程
凉山彝族自
治州`;
  const rows = parse.parseEntityRows(text);
  assertEqual(rows.length, 1);
  assertEqual(rows[0].name, '攀钢集团西昌钢钒有限公司');
  assertEqual(rows[0].city, '凉山彝族自治州');
  assertEqual(rows[0].sector, '钢铁');

  const power = `辽宁省 2026 年度全国碳排放权交易市场（发电行业）
重点排放单位名录
序号 企业名称 统一社会信用代码 国民经济行业分类代码 备注
21 恒力石化（大连）炼化有限公司 91210244089087324F 2511 自备电厂`;
  const powerRows = parse.parseEntityRows(power);
  assertEqual(powerRows.length, 1);
  assertEqual(powerRows[0].sector, '发电');
  assertEqual(powerRows[0].source_sector, '发电');
  assert(!String(powerRows[0].sector).includes('2511'), '2511 只是行业分类代码，不是纳管类别');
});

/* ------------------------------------------------------------------ */
/* 5) 小行业 1 行 vs 采购公告/无表头                                    */
/* ------------------------------------------------------------------ */

test('可信小行业 1 行允许；无表头 1 行与采购公告仍拦截', () => {
  const one = entityHtml(
    '宁夏回族自治区2026年度全国碳排放权交易市场（钢铁行业）重点排放单位名录',
    [['1', '宁夏钢铁（集团）有限责任公司', '91640000MA75W1234X', '中卫市']]
  );
  const rows = parse.parseEntityRows(one);
  assertEqual(rows.length, 1);
  assertEqual(rows[0].name, '宁夏钢铁（集团）有限责任公司');
  assertEqual(rows[0].sector, '钢铁');

  const noHeader = `<html><body>
<h1>2026年度重点排放单位名录（钢铁行业）</h1>
<table><tr><td>1</td><td>宁夏某钢铁有限公司</td><td>91640000MA75W1234X</td><td>中卫市</td></tr></table>
</body></html>`;
  assertEqual(parse.parseEntityRows(noHeader).length, 0, '无表头 1 行不得放宽全局 minRows');

  const procurement = `<html><body>
<h1>2026年度某省重点排放单位名录编制服务采购公告</h1>
<table><tr><th>序号</th><th>供应商名称</th><th>统一社会信用代码</th><th>地区</th></tr>
<tr><td>1</td><td>某环保科技有限公司</td><td>91310115132236621M</td><td>上海市</td></tr></table>
</body></html>`;
  assertEqual(parse.parseEntityRows(procurement).length, 0, '采购公告即使有企业行也不得收录');
});

test('地方试点、仅报告核查、拟纳入/征求意见名录拦截', () => {
  const table = `<table><tr><th>序号</th><th>企业名称</th><th>统一社会信用代码</th><th>地区</th></tr>
<tr><td>1</td><td>北京某发电有限公司</td><td>91310115132236621M</td><td>北京市</td></tr></table>`;
  const pilot = `<html><body><h1>北京市2026年度碳排放权交易试点重点排放单位名录</h1>${table}</body></html>`;
  const reportOnly = `<html><body><h1>北京市2026年度全国碳排放权交易市场重点排放单位名录（仅报告与核查）</h1>${table}</body></html>`;
  const draft = `<html><body><h1>北京市2026年度全国碳排放权交易市场重点排放单位名录（拟纳入，征求意见稿）</h1>${table}</body></html>`;
  assertEqual(parse.parseEntityRows(pilot).length, 0, '地方试点名录不得进正式目录');
  assertEqual(parse.parseEntityRows(reportOnly).length, 0, '仅报告核查企业不得进正式目录');
  assertEqual(parse.parseEntityRows(draft).length, 0, '拟纳入/征求意见清单不得进正式目录');
});

/* ------------------------------------------------------------------ */
/* 6) 显式 codes 顺序                                                   */
/* ------------------------------------------------------------------ */

await testAsync('显式 codes：严格按指定顺序，不擅自轮换', async () => {
  resetEntityTestData();
  routes.set('/order/b', entityHtml(
    '上海市2026年度全国碳排放权交易市场（发电行业）重点排放单位名录',
    [['1', '顺序测试乙发电有限公司', '91310115132236621M', '浦东新区']]
  ));
  routes.set('/order/a', entityHtml(
    '上海市2026年度全国碳排放权交易市场（发电行业）重点排放单位名录',
    [['1', '顺序测试甲发电有限公司', '91310115632080651P', '浦东新区']]
  ));
  insertSource('test119_ord_b', '/order/b', { priority: 1 });
  insertSource('test119_ord_a', '/order/a', { priority: 2 });
  const out = await collect.collectCeaEntities({ actor: 'test', codes: ['test119_ord_b', 'test119_ord_a'], trigger: 'manual' });
  assertEqual(out.selection, 'explicit');
  assertEqual(out.sources_selected, 2);
  assertEqual(out.sources_attempted, 2);
  assertEqual(out.sources_not_attempted, 0);
  assertEqual(hits.join(','), '/order/b,/order/a', '显式 codes 不得按 priority/轮换重排');
  assert(out.entities_created + out.entities_updated > 0, JSON.stringify(out.sources));
});

/* ------------------------------------------------------------------ */
/* 7) 默认轮换的累计标记                                                */
/* ------------------------------------------------------------------ */

await testAsync('默认 6 个来源分两批：每批最多 4 个，未处理来源如实标记，不宣称完成', async () => {
  resetEntityTestData();
  const codes = [
    '91310115132236621M', '91310115632080651P', '913101157718269277',
    '91310000MA1K38CF47', '91310115093841553K', '913101150576551478',
  ];
  for (let i = 1; i <= 6; i += 1) {
    routes.set(`/rot/${i}`, entityHtml(
      '上海市2026年度全国碳排放权交易市场（发电行业）重点排放单位名录',
      [['1', `轮换测试企业${i}有限公司`, codes[i - 1], '浦东新区']]
    ));
    insertSource(`test119_rot_${i}`, `/rot/${i}`, { priority: i * 10 });
  }
  const first = await collect.collectCeaEntities({ actor: 'test', trigger: 'manual' });
  assertEqual(first.selection, 'rotation');
  assertEqual(first.sources_total, 6);
  assertEqual(first.sources_selected, 4);
  assertEqual(first.sources_attempted, 4);
  assertEqual(first.sources_not_attempted, 2);
  assertEqual(first.truncated, true, '还有未尝试来源时必须标 truncated，不能宣称全部完成');
  assertEqual(first.deferred_sources.join(','), 'test119_rot_5,test119_rot_6');
  assertEqual(hits.join(','), '/rot/1,/rot/2,/rot/3,/rot/4');
  assertIncludes(first.note, '未在本批处理');

  hits.length = 0;
  const second = await collect.collectCeaEntities({ actor: 'test', trigger: 'manual' });
  assertEqual(second.sources_selected, 4, '每批仍最多 4 个：未尝试的 5/6 先上，再用最旧的 1/2 补足');
  assertEqual(hits.join(','), '/rot/5,/rot/6,/rot/1,/rot/2');
  assertEqual(second.sources_attempted, 4);
  assertEqual(second.sources_not_attempted, 2, '本批未处理的是 rot_3/rot_4');
  assertEqual(second.truncated, true);
});

/* ------------------------------------------------------------------ */
/* 8) 同源 hash 未变复用缓存；弱解析不覆盖完整字段                      */
/* ------------------------------------------------------------------ */

await testAsync('同源 hash 未变：复用缓存不重复更新；缓存缺失时弱解析不覆盖完整字段', async () => {
  resetEntityTestData();
  routes.set('/cache', entityHtml(
    '上海市2026年度全国碳排放权交易市场（发电行业）重点排放单位名录',
    [['1', '缓存测试发电有限公司', '91310115132236621M', '浦东新区']]
  ));
  insertSource('test119_cache', '/cache', { priority: 1 });

  const first = await collect.collectCeaEntities({ actor: 'test', codes: ['test119_cache'], trigger: 'manual' });
  assertEqual(first.entities_created, 1);
  const cacheRow = db.get("SELECT value FROM system_meta WHERE key='cea_entity_parse_result:test119_cache'");
  assert(cacheRow, '完整解析后应写入既有 cache 契约');
  const cache = JSON.parse(cacheRow.value);
  assertEqual(cache.complete, true);
  assertEqual(cache.rows, 1);

  const before = db.get("SELECT * FROM cea_entity WHERE source_code='test119_cache'");
  hits.length = 0;
  const second = await collect.collectCeaEntities({ actor: 'test', codes: ['test119_cache'], trigger: 'manual' });
  assertEqual(second.entities_created + second.entities_updated, 0, 'hash 未变不得重复写入/更新');
  assertEqual(second.unchanged, 1);
  assertEqual(second.status, 'success', '缓存命中是已完成，不得误判 failed');
  assertEqual(second.sources[0].unchanged, true);
  const afterSecond = db.get("SELECT * FROM cea_entity WHERE source_code='test119_cache'");
  assertEqual(afterSecond.name, before.name);
  assertEqual(afterSecond.credit_code, before.credit_code);

  // 模拟缓存丢失 + 弱解析：既有名称更完整，当前 hash 相同，不能被短名称覆盖
  db.run('UPDATE cea_entity SET name=? WHERE id=?', ['缓存测试发电有限公司（完整名称）', before.id]);
  db.run("DELETE FROM system_meta WHERE key='cea_entity_parse_result:test119_cache'");
  const third = await collect.collectCeaEntities({ actor: 'test', codes: ['test119_cache'], trigger: 'manual' });
  assert(third.entities_created + third.entities_updated > 0, '缓存缺失时应重新解析');
  const afterThird = db.get("SELECT * FROM cea_entity WHERE source_code='test119_cache'");
  assertEqual(afterThird.name, '缓存测试发电有限公司（完整名称）', '同 hash 弱解析不得覆盖既有完整名称');
  assertEqual(afterThird.credit_code, before.credit_code);
  assertEqual(afterThird.city, '浦东新区');
  assertEqual(db.get("SELECT COUNT(*) AS n FROM cea_entity WHERE source_code='test119_cache'").n, 1);
});

/* ------------------------------------------------------------------ */
/* 9) 来源接线：Fujian 保留，Codex 公共来源文件只读接入                 */
/* ------------------------------------------------------------------ */

test('CEA_ENTITY_PUBLIC_SOURCES 已接入 CEA_SOURCES；福建 2026 来源保留', () => {
  assert(Array.isArray(publicData.CEA_ENTITY_PUBLIC_SOURCES), 'Codex 来源文件必须导出数组');
  const fujian = sourcesData.CEA_SOURCES.find((s) => s.code === 'cea_entity_fujian_2026');
  assert(fujian, '福建 2026 来源不得丢失');
  assertEqual(fujian.dataset, 'entity');
  for (const source of publicData.CEA_ENTITY_PUBLIC_SOURCES) {
    const wired = sourcesData.CEA_SOURCES.find((s) => s.code === source.code);
    assert(wired, `公共名录来源 ${source.code} 未接入 CEA_SOURCES`);
    assertEqual(wired.url, source.url, '接入不得改写 Codex 登记的 URL');
    assertEqual(wired.dataset, 'entity');
  }
});

stub.close();
finish('119-v2-cea-entity-directory.test.mjs');
