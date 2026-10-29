/**
 * 测试 143（docs/80 B3/B4）：CEA 日报先判非目标页、真日报含导航/页脚不被误伤、
 * 同 URL parse 缺口留痕停止重试、未知页仍保留缺口；异常信用代码字段级非阻塞。
 * 仅用 setupV2 临时库与本机回环桩；不联网、不调用真实模型。
 */
import http from 'node:http';
import {
  setupV2, test, testAsync, assert, assertEqual, assertIncludes, finish,
} from './v2-helpers.mjs';

const ctx = await setupV2({ withPublicDemo: false });
const { db } = ctx;
const parse = await import('../src/services/cea-parse.mjs');
const cea = await import('../src/services/cea-collect-svc.mjs');
const ceaSvc = await import('../src/services/cea-svc.mjs');
const gapTriage = await import('../src/services/gap-triage-svc.mjs');

const now = new Date().toISOString();
process.env.CCER_ALLOW_LOOPBACK_OUTBOUND = '1';

const DAILY_TEXT = `【CEA】全国碳市场每日综合价格行情及成交信息20260730-上海环境能源交易所
今日全国碳市场综合价格行情为: 开盘价96.00元/吨，最高价97.00元/吨，最低价95.90元/吨，收盘价96.61元/吨，收盘价较前一日上涨1.00%。
今日挂牌协议交易成交量544,313吨，成交额52,585,579.00元；大宗协议交易成交量500,000吨，成交额47,575,000.00元；今日无单向竞价。
今日全国碳排放配额总成交量1,044,313吨，总成交额100,160,579.00元。
2026年1月1日至7月30日，全国碳市场碳排放配额成交量68,966,986吨，成交额5,499,968,391.61元。
截至2026年7月30日，全国碳市场碳排放配额累计成交量933,833,506吨，累计成交额63,162,586,623.18元。`;

const TRUE_DAILY_HTML = `<!doctype html><html><head>
<title>【CEA】全国碳市场每日综合价格行情及成交信息20260730-上海环境能源交易所</title>
</head><body>
<nav>首页 基本信息 招聘 网站地图</nav>
<main><h1>全国碳市场每日综合价格行情及成交信息</h1>
${DAILY_TEXT.replace(/\n/g, '<br>')}
</main>
<footer>基本信息｜联系我们｜网站地图｜人才招聘</footer>
</body></html>`;

const ENTITY_BASIC_HTML = `<!doctype html><html><head><title>基本信息</title></head>
<body><nav>首页 行情 政策</nav><main><h1>上海环境能源交易所基本信息</h1>
<p>成立时间、注册资本、办公地址、联系方式等企业基本信息。</p>
<p>人才招聘与网站导航。</p></main><footer>版权所有</footer></body></html>`;

const UNKNOWN_HTML = '<!doctype html><html><head><title>页面加载中</title></head><body><div>暂无内容</div></body></html>';

let dailyHits = 0;
let basicHits = 0;
const server = http.createServer(async (req, res) => {
  for await (const _ of req) { /* drain */ }
  if (req.url.startsWith('/daily')) {
    dailyHits += 1;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', connection: 'close' });
    res.end(TRUE_DAILY_HTML);
    return;
  }
  if (req.url.startsWith('/basic')) {
    basicHits += 1;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', connection: 'close' });
    res.end(ENTITY_BASIC_HTML);
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', connection: 'close' });
  res.end(UNKNOWN_HTML);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const BASIC_URL = `http://127.0.0.1:${port}/basic/488525.shtml`;
const DAILY_URL = `http://127.0.0.1:${port}/daily/2026-07-30.html`;

function addSource(id, code, url) {
  db.run(
    `INSERT INTO cea_source (id,code,name,url,dataset,kind,allowed_domains,enabled,priority,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,1,1,?,?)`,
    [id, code, code, url, 'daily', 'official_html', JSON.stringify(['127.0.0.1']), now, now]
  );
}

try {
  test('非目标页判定：标题“基本信息”命中；空/未知页不判非目标', () => {
    const bad = parse.detectCeaNonTargetPage(ENTITY_BASIC_HTML, { url: BASIC_URL });
    assertEqual(bad.non_target, true);
    assertIncludes(bad.rule, 'basic_info');
    assertIncludes(bad.evidence, '基本信息');
    const empty = parse.detectCeaNonTargetPage('', { url: BASIC_URL });
    assertEqual(empty.non_target, false, '空正文不能当非目标页');
    const unknown = parse.detectCeaNonTargetPage(UNKNOWN_HTML, { url: BASIC_URL });
    assertEqual(unknown.non_target, false, '未知页面保留缺口，不猜非目标');
    const nav = parse.detectCeaNonTargetPage('<title>网站地图</title><main>栏目导航</main>');
    assertEqual(nav.non_target, true);
  });

  test('真日报含导航和页脚“基本信息”：不误伤，仍识别为行情页', () => {
    const r = parse.detectCeaNonTargetPage(TRUE_DAILY_HTML, { url: DAILY_URL });
    assertEqual(r.non_target, false, JSON.stringify(r));
    const p = parse.parseCeaDailyReport(TRUE_DAILY_HTML, { url: DAILY_URL });
    assertEqual(p.ok, true);
    assertEqual(p.trade_date, '2026-07-30');
    assertEqual(p.fields.close, 96.61);
  });

  await testAsync('真实采集：非目标页记录排除、同 URL parse 缺口 mitigated、零行情行', async () => {
    addSource('CEASRC-143-BASIC', 'cea-local-basic-143', BASIC_URL);
    db.run(
      `INSERT INTO data_gap (id,dataset,gap_key,title,description,impact,severity,status,detected_at,updated_at)
       VALUES (?,?,?,?,?,?,?, 'open',?,?)`,
      ['GAP-143-BASIC', 'cea_trade', `cea:trade:parse:${BASIC_URL}`, 'CEA 日报解析失败',
        `真实抓取成功但无行情字段：${BASIC_URL}`, '未写入行情行', 'critical', now, now]
    );
    const before = db.get('SELECT COUNT(*) n FROM cea_trade_daily').n;
    const out = await cea.collectOneCeaDaily({ url: BASIC_URL, sourceCode: 'cea-local-basic-143' }, { actor: 'test:143' });
    assertEqual(out.excluded, true, JSON.stringify(out));
    assertEqual(out.reason, 'non_target_page');
    assertEqual(basicHits, 1);
    assertEqual(db.get('SELECT COUNT(*) n FROM cea_trade_daily').n, before, '非目标页不得写行情行');
    const gap = db.get('SELECT * FROM data_gap WHERE id=?', ['GAP-143-BASIC']);
    assertEqual(gap.status, 'mitigated');
    assertEqual(gap.classification, 'non_target');
    assertEqual(gap.retryable, 0);
    assertEqual(gap.blocking, 0);
    assertIncludes(gap.description, '非目标页排除');
    const ex = db.all('SELECT * FROM cea_page_exclusion WHERE url=?', [BASIC_URL]);
    assertEqual(ex.length, 1);
    assertIncludes(ex[0].rule, 'basic_info');
    assertEqual(ex[0].snapshot_id, out.snapshotId);
  });

  await testAsync('同 URL 再次判定：命中已有排除记录，不重复抓取/建行', async () => {
    const beforeCount = db.get('SELECT COUNT(*) n FROM cea_page_exclusion').n;
    const hitsBefore = basicHits;
    const again = await cea.collectOneCeaDaily({ url: BASIC_URL, sourceCode: 'cea-local-basic-143' }, { actor: 'test:143' });
    assertEqual(again.excluded, true);
    assertEqual(basicHits, hitsBefore, '已登记非目标页不应重复抓取');
    assertEqual(again.reason, 'non_target_page_cached');
    assertEqual(db.get('SELECT COUNT(*) n FROM cea_page_exclusion').n, beforeCount, '同一 URL 不重复建排除行');
    assertEqual(db.get('SELECT COUNT(*) n FROM cea_trade_daily').n, 0);
  });

  await testAsync('真日报：带导航/页脚也能正常解析入库，不产生排除记录', async () => {
    addSource('CEASRC-143-DAILY', 'cea-local-daily-143', DAILY_URL);
    const out = await cea.collectOneCeaDaily({ url: DAILY_URL, sourceCode: 'cea-local-daily-143' }, { actor: 'test:143' });
    assertEqual(out.ok, true, JSON.stringify(out));
    assertEqual(out.trade_date, '2026-07-30');
    assertEqual(dailyHits, 1);
    assertEqual(db.get('SELECT COUNT(*) n FROM cea_trade_daily WHERE trade_date=?', ['2026-07-30']).n, 1);
    assertEqual(db.get('SELECT COUNT(*) n FROM cea_page_exclusion WHERE url=?', [DAILY_URL]).n, 0);
  });

  await testAsync('异常信用代码：企业仍入名录，原始值保留，字段级非阻塞提示', async () => {
    const invalid = '91350000MA0000000X';
    assertEqual(parse.validEntityCreditCode(invalid), false, 'fixture 应为异常校验位');
    const saved = ceaSvc.upsertCeaEntity({
      name: '福建省异常代码测试有限公司', list_year: 2026, province: '福建省',
      raw_credit_code: invalid, credit_code: null, sector: '发电', status: 'existing',
    }, { actor: 'test:143' });
    assert(saved.ok, JSON.stringify(saved));
    const list = ceaSvc.listCeaEntities({ q: '异常代码测试', list_year: 2026, limit: 20 });
    assertEqual(list.total, 1, '异常信用代码不能把整条企业从名录剔除');
    assertEqual(list.rows[0].name, '福建省异常代码测试有限公司');
    assertEqual(list.rows[0].credit_code, null, '标准代码留空，不猜补');
    assertEqual(list.rows[0].raw_credit_code, invalid, '原始异常值必须保留');
    assertEqual(list.rows[0].field_warnings.length, 1);
    assertEqual(list.rows[0].field_warnings[0].blocking, false);
    assertIncludes(list.rows[0].field_warnings[0].message, '企业仍按名称计入名录');
    assert(list.coverage.with_invalid_credit_code >= 1);
    const anomalies = gapTriage.optionalFieldAnomalies({ limit: 20 });
    assert(anomalies.some((a) => a.name === '福建省异常代码测试有限公司' && !a.blocking));
  });

  await testAsync('真缺口不被“信用代码可选字段”顺带关闭', async () => {
    db.run(
      `INSERT INTO data_gap (id,dataset,gap_key,title,description,impact,severity,status,detected_at,updated_at)
       VALUES (?,?,?,?,?,?,?, 'open',?,?)`,
      ['GAP-143-TRUE', 'cea_entity', 'cea:entity:parse:TEST-143', 'CEA 名录原件已获取但未解析出主体行',
        'PDF 已下载但解析出 0 行，保留 parse gap。', '该来源覆盖为 0', 'warning', now, now]
    );
    const out = gapTriage.triageGaps({ status: 'all', persist: true, includeFields: true });
    assert(out.items.some((g) => g.id === 'GAP-143-TRUE'));
    const gap = db.get('SELECT * FROM data_gap WHERE id=?', ['GAP-143-TRUE']);
    assertEqual(gap.status, 'open', '真实解析缺口不得被字段提示关闭');
    assertEqual(gap.classification, 'pdf_unparsed');
    assert((db.get('SELECT COUNT(*) n FROM cea_entity WHERE name=?', ['福建省异常代码测试有限公司']).n) === 1);
  });
} finally {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

finish('test/143-v2-cea-nontarget-credit.test.mjs');
