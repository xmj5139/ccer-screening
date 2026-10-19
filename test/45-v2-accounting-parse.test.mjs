/**
 * 45-v2-accounting-parse.test.mjs —— 公开碳核算资料：真实公开夹具的确定性解析
 * ============================================================================
 * 全部夹具都是**真实公开原件**（随代码提供，见 test/fixtures/accounting/）：
 *   · electricity-co2-2023.pdf       生态环境部 2023 年电力 CO2 因子正式附件（物理 2 页）
 *   · chinacrc-daily-20261014.html   中碳登 2026-10-14 清结算信息日报详情页
 *   · chinacrc-list-18.html          中碳登信息日报列表页
 *   · mee-*.html                     生态环境部三份规范印发/更新公告
 *   · ncsc-412-challenge.html / cets-412-challenge.html  HTTP 412 JS 校验页（正文为空）
 *
 * 断言重点（docs/39 第 99 条）：
 *   真实 2023 PDF 40 行与特殊口径、0.5306 样本；412 不当正文；HTML/PDF 正文与元数据区分。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  setupV2, test, testAsync, assert, assertEqual, assertIncludes, assertNotIncludes, finish,
} from './v2-helpers.mjs';

const ctx = await setupV2();
console.log('\n[v2-45] 公开碳核算资料：真实公开夹具解析');

const FIX = (name) => fileURLToPath(new URL(`./fixtures/accounting/${name}`, import.meta.url));
const readFix = (name) => readFileSync(FIX(name), 'utf8');

const parse = await import('../src/services/accounting-parse.mjs');
const { pdfTextPages, pdfInfoPages } = await import('../src/services/pdf-parse-svc.mjs');
const acc = await import('../src/services/accounting-svc.mjs');
const collectSvc = await import('../src/services/accounting-collect-svc.mjs');
assert(typeof acc.seedAccountingBase === 'function');
assert(typeof collectSvc.classifyStandardStatus === 'function');
// 显式 seed（接口层会自动 seed，测试里必须显式调用，避免"空表也通过"的假阳性）
const seeded = acc.seedAccountingBase();
assertEqual(seeded.factors, 40, '应 seed 40 行电力因子');
assertEqual(seeded.standards, 12, '应 seed 10 项规范元数据');
assertEqual(seeded.sources, 29, '应 seed 29 条来源登记（含新增CETS公开栏目与国家标准源）');

/* ==================================================================== */
/*  一、真实电力因子 PDF：40 行 + 三种不可互换口径                       */
/* ==================================================================== */

let factorRows = null;
let factorStats = null;

await testAsync('真实 2023 电力 CO2 因子 PDF 解析出 40 行（1 全国 + 7 区域 + 30 省级 + 2 特殊口径）', async () => {
  const pdf = FIX('electricity-co2-2023.pdf');
  const info = await pdfInfoPages(pdf);
  assert(info.ok, `pdfinfo 应成功：${info.error || ''}`);
  assertEqual(info.pages, 2, '该附件物理页数固定为 2 页');
  const t = await pdfTextPages(pdf, { expectPages: info.pages });
  assert(t.ok, `pdftotext 应成功：${t.error || ''}`);
  const r = parse.parseElectricityFactorPages(t.pages);
  assert(r.ok, `解析应成功：${r.reason} ${r.message || ''}`);
  factorRows = r.rows;
  factorStats = r.stats;
  assertEqual(r.rows.length, 40, '合计必须是 40 行');
  assertEqual(r.stats.by_category.national_average, 1);
  assertEqual(r.stats.by_category.regional_average, 7);
  assertEqual(r.stats.by_category.provincial_average, 30);
  assertEqual(r.stats.by_category.national_excl_market_nonfossil, 1);
  assertEqual(r.stats.by_category.national_fossil, 1);
  assertEqual(r.stats.structurally_expected, true, `结构应完全符合原文：${JSON.stringify(r.stats.mismatch)}`);
});

test('全国平均 0.5306（样本：100 万 kWh × 0.5306 = 530.6 tCO2 的因子来源）', () => {
  const row = factorRows.find((r) => r.category === 'national_average');
  assertEqual(row.value, 0.5306);
  assertEqual(row.original_unit, 'kgCO2/kWh');
  assertEqual(row.gas, 'CO2');
  assertEqual(row.locator, '表1 2023 年全国电力平均二氧化碳排放因子｜全国');
});

test('三种口径不得互换：0.6096（不含市场化非化石电量）与 0.8273（化石能源电力）分列', () => {
  assertEqual(factorStats.national_average, 0.5306);
  assertEqual(factorStats.national_excl_market_nonfossil, 0.6096);
  assertEqual(factorStats.national_fossil, 0.8273);
  const a = factorRows.find((r) => r.category === 'national_average');
  const b = factorRows.find((r) => r.category === 'national_excl_market_nonfossil');
  const c = factorRows.find((r) => r.category === 'national_fossil');
  assert(a.caliber !== b.caliber && b.caliber !== c.caliber, '三种口径说明必须互不相同');
  assertIncludes(b.caliber, '不包括市场化交易的非化石能源电量');
  assertIncludes(c.caliber, '化石能源电力');
});

test('逐行保留物理页与打印页：物理 1=打印 3，物理 2=打印 4', () => {
  for (const r of factorRows) {
    assertEqual(r.page_physical === 1 ? '3' : '4', r.page_printed, `${r.locator} 的页码映射不正确`);
  }
  assertEqual(factorRows.filter((r) => r.page_physical === 1).length, 18, '物理页 1 应有 18 行');
  assertEqual(factorRows.filter((r) => r.page_physical === 2).length, 22, '物理页 2 应有 22 行');
  assertEqual(factorStats.printed_pages.join(','), '3,4');
});

test('区域 7 个与省级 30 个（原文未列西藏，不得自动补齐）', () => {
  const regions = factorRows.filter((r) => r.category === 'regional_average').map((r) => r.region);
  assertEqual(regions.join(','), '华北,东北,华东,华中,西北,南方,西南');
  const provinces = factorRows.filter((r) => r.category === 'provincial_average').map((r) => r.region);
  assertEqual(provinces.length, 30);
  assert(!provinces.includes('西藏'), '原文没有西藏，绝不能补一行');
  assertEqual(factorStats.has_tibet, false);
  assertEqual(provinces[0], '北京');
  assertEqual(provinces[provinces.length - 1], '新疆');
});

test('西藏缺失时按缺数据返回，不返回 0 也不返回全国值', () => {
  const tibet = factorRows.find((r) => r.region === '西藏');
  assertEqual(tibet, undefined);
  // 省级口径只覆盖 30 个省级行政区，取不到就是取不到
  assertEqual(factorRows.filter((r) => r.category === 'provincial_average' && r.region === '西藏').length, 0);
});

test('种子静态值与真实 PDF 解析结果逐行一致（哈希 + 页码 + 数值）', async () => {
  const { ELECTRICITY_FACTORS_2023, ELECTRICITY_FACTOR_SOURCE } = await import('../src/data/accounting-originals.mjs');
  assertEqual(ELECTRICITY_FACTORS_2023.length, 40);
  for (const seedRow of ELECTRICITY_FACTORS_2023) {
    const parsed = factorRows.find((r) => r.category === seedRow.category && (r.region || null) === (seedRow.region || null));
    assert(parsed, `PDF 中应存在 ${seedRow.category}/${seedRow.region}`);
    assertEqual(parsed.value, seedRow.value, `${seedRow.locator} 数值不一致`);
    assertEqual(parsed.page_physical, seedRow.page_physical, `${seedRow.locator} 物理页不一致`);
    assertEqual(parsed.page_printed, seedRow.page_printed, `${seedRow.locator} 打印页不一致`);
    assertIncludes(seedRow.locator, parsed.locator.split('｜')[0]);
  }
  assertEqual(ELECTRICITY_FACTOR_SOURCE.pages_physical, 2);
  assertIncludes(ELECTRICITY_FACTOR_SOURCE.printed_pages, '3');
  assertEqual(ELECTRICITY_FACTOR_SOURCE.sha256.length, 64, '必须附原件 SHA-256');
});

test('可提取文本为空的 PDF 不产生任何因子行（不猜测、不补全）', () => {
  const r = parse.parseElectricityFactorPages(['', '   ']);
  assertEqual(r.ok, false);
  assertEqual(r.reason, 'no_text');
  assertEqual(r.rows, undefined);
});

/* ==================================================================== */
/*  二、中碳登清结算日报：表格 × 正文双证据                              */
/* ==================================================================== */

let crc = null;

test('真实中碳登日报：2026-10-14 本日/累计量额与公布均价', () => {
  const r = parse.parseCrcDailyDetail(readFix('chinacrc-daily-20261014.html'), {
    url: 'https://www.chinacrc.net.cn/view/8753.html',
  });
  assert(r.ok, `解析应成功：${r.reason} ${r.message || ''}`);
  crc = r.data;
  assertEqual(crc.title, '2026年10月14日全国碳排放权交易市场清结算信息日报');
  assertEqual(crc.trade_date, '2026-10-14');
  assertEqual(crc.published_at, '2026-10-14');
  assertEqual(crc.daily_volume_t, 2861440);
  assertEqual(crc.daily_amount_yuan, 258301176.6);
  assertEqual(crc.daily_avg_price_published, 90.27);
  assertEqual(crc.cumulative_volume_t, 1001935009);
  assertEqual(crc.cumulative_amount_yuan, 69547332187.35);
  assertEqual(crc.scope, 'market_total');
});

test('表格与正文互为交叉证据，逐字段一致（不一致要如实报冲突）', () => {
  assertEqual(crc.table_prose_cross_check.agree, true);
  assertEqual(crc.table_prose_cross_check.conflicts.length, 0);
  for (const f of ['daily_volume_t', 'daily_amount_yuan', 'cumulative_volume_t', 'cumulative_amount_yuan']) {
    assertEqual(crc.table_prose_cross_check.fields[f].table, crc.table_prose_cross_check.fields[f].prose, `${f} 两方应一致`);
  }
});

test('公布均价与复算均价分层保存，互不覆盖', () => {
  assertEqual(crc.avg_price_origin, 'published');
  assertEqual(crc.daily_avg_price_published, 90.27);
  const derived = crc.daily_amount_yuan / crc.daily_volume_t;
  assertEqual(crc.daily_avg_price_derived, derived);
  assert(Math.abs(derived - 90.27) < 0.01, '复算值应与公布值接近但不等于（公布值经过四舍五入）');
  assert(derived !== crc.daily_avg_price_published, '复算值与公布值是两个字段，不能互相覆盖');
});

test('明细 → 小计 → 交易合计：只把小计计入合计，不重复加总', () => {
  assertEqual(crc.subtotal_check.agree, true);
  assertEqual(crc.subtotal_check.subtotal_rows, 6, '6 个年度配额品种各有一行小计');
  assertEqual(crc.subtotal_check.sum_of_subtotals.daily_volume_t, crc.daily_volume_t);
  assertEqual(crc.subtotal_check.sum_of_subtotals.daily_amount_yuan, crc.daily_amount_yuan);
  assertEqual(crc.subtotal_check.sum_of_subtotals.cumulative_volume_t, crc.cumulative_volume_t);
  assertEqual(crc.subtotal_check.sum_of_subtotals.cumulative_amount_yuan, crc.cumulative_amount_yuan);
  assertEqual(crc.components.length, 24, '6 品种 × 4 行（挂牌/大宗/单向竞价/小计）');
  // 明细行合计 == 小计合计 == 交易合计（三者相等）；把明细与小计一起相加会得到 2 倍，必须避免
  const details = crc.components.filter((c) => !c.counts_to_total);
  const detailSum = details.reduce((s, c) => s + (c.daily_volume_t || 0), 0);
  assertEqual(detailSum, crc.daily_volume_t, '明细行合计应与小计/交易合计相等');
  const allRows = crc.components.reduce((s, c) => s + (c.daily_volume_t || 0), 0);
  assertEqual(allRows, crc.daily_volume_t * 2, '若把明细与小计一起相加会翻倍——这正是入库时只计小计的原因');
});

test('列表页按真实 a.href 发现详情链接（不拼猜 URL）', () => {
  const links = parse.discoverCrcDetailLinks(readFix('chinacrc-list-18.html'), {
    baseUrl: 'https://www.chinacrc.net.cn/list/18.html',
  });
  assert(links.length >= 8, `应发现多条详情链接，实际 ${links.length}`);
  for (const l of links) {
    assert(/^https:\/\/www\.chinacrc\.net\.cn\/view\/\d+\.html$/.test(l.url), `链接格式应来自原文 href：${l.url}`);
  }
  assertEqual(links[0].url, 'https://www.chinacrc.net.cn/view/8755.html');
  assertIncludes(links[0].title, '清结算信息日报');
});

test('详情页表格结构与原文不符时返回明确失败，不写入任何数值', () => {
  const r = parse.parseCrcDailyDetail('<html><body><div class="cont_left"><div class="title">x</div></div><p>没有表格</p></body></html>', {
    url: 'https://www.chinacrc.net.cn/view/1.html',
  });
  assertEqual(r.ok, false);
  assertEqual(r.reason, 'table_not_found');
  assertEqual(r.data, undefined);
});

/* ==================================================================== */
/*  三、HTTP 412 校验页绝不当正文                                        */
/* ==================================================================== */

test('NCSC 因子库 412 页面被判为 blocked，不作为因子数据', () => {
  const r = parse.assessFetchedDocument({
    httpStatus: 412, html: readFix('ncsc-412-challenge.html'), url: 'https://data.ncsc.org.cn/factories/index',
  });
  assertEqual(r.ok, false);
  assertEqual(r.reason, 'http_412_challenge');
  assertIncludes(r.message, '不得当作正文');
});

test('CETS 门户 412 页面同样判为 blocked（不假装取得登录后公告）', () => {
  const r = parse.assessFetchedDocument({
    httpStatus: 412, html: readFix('cets-412-challenge.html'), url: 'https://www.cets.org.cn/',
  });
  assertEqual(r.ok, false);
  assertEqual(r.reason, 'http_412_challenge');
});

test('即使 HTTP 状态被伪造成 200，JS 挑战页仍被识别为校验页', () => {
  const r = parse.assessFetchedDocument({
    httpStatus: 200, html: readFix('ncsc-412-challenge.html'), url: 'https://data.ncsc.org.cn/factories/index',
  });
  assertEqual(r.ok, false);
  assertEqual(r.reason, 'http_412_challenge');
});

test('把 412 页面喂给日报解析器：拒绝解析，且不会得到任何数值', () => {
  const r = parse.parseCrcDailyDetail(readFix('cets-412-challenge.html'), {
    url: 'https://www.cets.org.cn/', httpStatus: 412,
  });
  assertEqual(r.ok, false);
  assertEqual(r.reason, 'http_412_challenge');
  assertEqual(r.data, undefined);
});

test('登录页被判为 login_required（不登录未知企业账户）', () => {
  const r = parse.assessFetchedDocument({
    httpStatus: 200, url: 'https://example.gov.cn/login',
    html: '<html><body><h1>用户登录</h1><form><input type="password" name="p"></form></body></html>',
  });
  assertEqual(r.ok, false);
  assertEqual(r.reason, 'login_required');
});

/* ==================================================================== */
/*  四、生态环境部公告：真实附件 href + 元数据/正文分离                  */
/* ==================================================================== */

const MEE_CASES = [
  {
    file: 'mee-power-guide-2026.html',
    base: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202606/t20260629_1160473.html',
    expect: [
      ['CETS-AG-01.01-V04-2026', 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202606/W020260629673485282202.pdf'],
      ['CETS-VG-01.01-V02-2026', 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202606/W020260629673486224832.pdf'],
    ],
    updateNotes: 2,
  },
  {
    file: 'mee-steel-guides-2024.html',
    base: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202501/t20250124_1101316.html',
    expect: [
      ['CETS-AG-03.01-V01-2024', 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202501/W020250124388842647934.pdf'],
      ['CETS-VG-03.01-V01-2024', 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202501/W020250124388843909905.pdf'],
    ],
    updateNotes: 0,
  },
  {
    file: 'mee-cement-aluminum-guides-2024.html',
    base: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202409/t20240914_1086067.html',
    expect: [
      ['CETS-AG-02.01-V01-2024', 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202409/W020240914705756032366.pdf'],
      ['CETS-VG-02.01-V01-2024', 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202409/W020240914705757419213.pdf'],
      ['CETS-AG-04.01-V01-2024', 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202409/W020240914705758174865.pdf'],
      ['CETS-VG-04.01-V01-2024', 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202409/W020240914705759175761.pdf'],
    ],
    updateNotes: 0,
  },
];

for (const c of MEE_CASES) {
  test(`公告页附件解析：${c.file} 的真实 PDF href 与锚文本编号`, () => {
    const r = parse.parseAnnouncementAttachments(readFix(c.file), { baseUrl: c.base });
    for (const [code, url] of c.expect) {
      const hit = r.files.find((f) => f.code === code);
      assert(hit, `${c.file} 应解析出 ${code}`);
      assertEqual(hit.url, url, `${code} 的 PDF URL 必须来自原文 href`);
    }
    const notes = r.files.filter((f) => f.kind === 'update_note');
    assertEqual(notes.length, c.updateNotes, `${c.file} 的更新说明附件数`);
  });
}

test('公告附件的相对 href 只在公告页自身目录下解析（避免落到错误目录）', () => {
  const r = parse.parseAnnouncementAttachments(readFix('mee-steel-guides-2024.html'), {
    baseUrl: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202501/t20250124_1101316.html',
  });
  for (const f of r.files) {
    assertIncludes(f.url, '/202501/', `钢铁公告附件应落在 202501 目录：${f.url}`);
  }
  assertNotIncludes(JSON.stringify(r.files), '/202606/', '不得因为传错 baseUrl 而拼出别的目录');
});

test('规范状态分类：征求意见稿绝不判为正式版', () => {
  // 确定性规则（不依赖网络）：由 accounting-collect-svc 的纯函数给出
  assertEqual(collectSvc.classifyStandardStatus({ title: '关于印发《企业温室气体排放核算与报告指南 发电设施》的通知', anchor: '' }), 'formal');
  assertEqual(collectSvc.classifyStandardStatus({ title: '关于公开征求《企业温室气体排放核算与报告指南 发电设施》意见的通知', anchor: '' }), 'consultation');
  assertEqual(collectSvc.classifyStandardStatus({ title: 'x', anchor: '《某指南》征求意见稿' }), 'consultation');
  assertEqual(collectSvc.classifyStandardStatus({ title: '某规范（废止）', anchor: '' }), 'historical');
  assertEqual(collectSvc.classifyStandardStatus({ title: '某规范草案', anchor: '' }), 'draft');
});

/* ==================================================================== */
/*  五、HTML 正文与元数据区分                                            */
/* ==================================================================== */

test('因子种子数据为「已取得全文」（附原件哈希与页码），规范种子为「仅元数据」', () => {
  // 因子：随代码提供了原件（PDF）的哈希、物理页与打印页 → evidence_level=full
  const factors = acc.listFactors({ data_year: 2023 }).rows;
  assertEqual(factors.length, 40, '因子库应有 40 行（先断言非空，避免空表也通过）');
  for (const f of factors) {
    assertEqual(f.evidence_level, 'full', `${f.name} 应标注已取得全文`);
    assertEqual(f.original_sha256.length, 64);
    assert(f.page_physical === 1 || f.page_physical === 2);
    assert(f.page_printed === '3' || f.page_printed === '4');
  }
  // 规范：只有元数据（未取得正文），不得假装已取得全文
  const standards = acc.listStandards({}).rows;
  assertEqual(standards.length, 12, '规范库应有 12 项（先断言非空）');
  for (const s of standards) {
    assertEqual(s.body_status, 'metadata_only', `${s.code || s.title} 本轮只有元数据`);
    assertEqual(s.body_chars, 0, '没有正文就不得有正文字数');
    assertEqual(s.model_verify_status, 'unavailable', '未跑模型就不得标记已核验');
  }
  // 三种口径分别入库，且口径文本互不相同
  const calibers = new Set(acc.listFactors({}).rows.map((f) => f.caliber));
  assert(calibers.size >= 5, '不同表/不同地区行的口径说明不得被压平成一句');
});

test('媒体正文与元数据的判定通道不同：PDF 不走 HTML 正文判定', () => {
  const r = parse.assessFetchedDocument({ httpStatus: 200, contentType: 'application/pdf', html: '' });
  assertEqual(r.ok, false);
  assertEqual(r.reason, 'pdf_not_supported');
});

test('CSV/JSON 导出行的字段与数据库一致（不含敏感字段）', () => {
  const rows = acc.factorExportRows({ data_year: 2023 });
  assertEqual(rows.length, 40);
  const keys = Object.keys(rows[0]).join(',');
  assertNotIncludes(keys, 'credential');
  assertNotIncludes(keys, 'api_key');
  assertIncludes(keys, 'original_sha256');
  const stdRows = acc.standardExportRows({});
  assertEqual(stdRows.length, 12);
  assertNotIncludes(Object.keys(stdRows[0]).join(','), 'password');
});

finish('45-v2-accounting-parse.test.mjs');
