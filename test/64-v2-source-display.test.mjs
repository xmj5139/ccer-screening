/**
 * v2.6 测试 64（docs/44 第 2 条）：来源展示口径 —— 官方域名只按 hostname 精确 /
 * 受控子域匹配，第三方转载官方内容不得被认定为官网，来源未知不得杜撰。
 * ============================================================================
 * 覆盖：
 *   · 精确 hostname 与受控子域命中官方；
 *   · 伪装域名（后缀包含、前缀拼接、路径包含、父域欺骗）不命中；
 *   · 「转载官方」的第三方站点：即使 source_category=official 也按第三方机构展示；
 *   · 来源未知：显示网站域名或「来源未标注」，不编造机构名；
 *   · 内容接口返回的 source_display 与登记表一致。
 */
import {
  setupV2, test, testAsync, assert, assertEqual, assertIncludes, finish,
} from './v2-helpers.mjs';

const ctx = await setupV2({ withPublicDemo: false });
const { db } = ctx;
const src = await import('../src/services/source-display-svc.mjs');
const content = await import('../src/services/content-svc.mjs');

console.log('\n[v2-64] 来源展示口径与官方域名判定');

src.seedOfficialDomains();

/* ==================================================================== */
/*  一、精确 hostname / 受控子域                                        */
/* ==================================================================== */

test('官方域名按精确 hostname 或受控子域命中', () => {
  const ok = [
    ['https://www.mee.gov.cn/xxgk/2026/x.html', 'mee.gov.cn'],
    ['https://mee.gov.cn/', 'mee.gov.cn'],
    ['https://ccer.cets.org.cn/projectPublicity/projectPublicityList', 'ccer.cets.org.cn'],
    ['https://overview.cneeex.com/c/2026-07-30/498086.shtml', 'cneeex.com'],
    ['http://www.ccer.com.cn/wcm/ccer/html/x.shtml', 'ccer.com.cn'],
  ];
  for (const [url, domain] of ok) {
    const hit = src.matchOfficialDomain(src.hostnameOf(url));
    assert(hit, `${url} 应命中官方登记`);
    assertEqual(hit.domain, domain, `${url} 应命中 ${domain}`);
  }
});

test('伪装域名一律不命中（不用 contains、不用 .gov.cn 字符串包含）', () => {
  const bad = [
    'https://notmee.gov.cn/x.html',                 // 同后缀但不同主体
    'https://mee.gov.cn.evil.example/x.html',       // 官方域名作为子域前缀
    'https://www.mee.gov.cn.evil.example/x.html',   // 同上（受控子域欺骗）
    'https://evil.example/mee.gov.cn/x.html',       // 路径包含（路径不参与判定）
    'https://fake-cets.org.cn.evil.example/x.html',
    'https://gov.cn.evil.example/x.html',
    'https://xmeegov.cn/x.html',
    'https://mee-gov.cn/x.html',
  ];
  for (const url of bad) {
    assertEqual(src.matchOfficialDomain(src.hostnameOf(url)), null, `${url} 不得被认定为官方`);
    assertEqual(src.isOfficialUrl(url), false, `${url} 的 isOfficialUrl 应为 false`);
  }
  // 命中时仍然认识自身
  assertEqual(src.isOfficialUrl('https://www.mee.gov.cn/'), true);
});

test('sourceDisplay：官方网站显示「官方信息」，第三方显示实际发布机构', () => {
  const official = src.sourceDisplay({ url: 'https://www.mee.gov.cn/xxgk/x.html', publisher: '某转载站' });
  assertEqual(official.kind, 'official');
  assertEqual(official.label, '官方信息');
  assertIncludes(official.detail, '生态环境部');

  const third = src.sourceDisplay({
    url: 'https://www.tanpaifang.com/a.html', publisher: '碳排放交易网',
  });
  assertEqual(third.kind, 'third_party');
  assertEqual(third.label, '碳排放交易网', '第三方应显示实际发布机构/网站名');
  assert(!third.label.includes('官方'), '第三方不得显示「官方」');
});

test('「转载官方」的第三方：来源类别写着 official 也不认定为官网', () => {
  const repost = src.sourceDisplay({
    url: 'https://www.tanpaifang.com/repost/mee-notice.html',
    publisher: '碳排放交易网（转自生态环境部）',
    source_category: 'official',
  });
  assertEqual(repost.kind, 'third_party', '域名未命中登记表时不得按官方展示');
  assert(!repost.label.includes('官方信息'), '不得显示为「官方信息」');
  assertIncludes(repost.note || '', '未在官方登记表中命中', '应说明判定依据');
});

test('来源未知：显示网站域名或「来源未标注」，不杜撰机构', () => {
  const unknown = src.sourceDisplay({ url: 'https://unknown-site.example/a.html' });
  assertEqual(unknown.kind, 'unknown');
  assertEqual(unknown.label, 'unknown-site.example', '应退回显示域名');
  const none = src.sourceDisplay({});
  assertEqual(none.kind, 'unknown');
  assertEqual(none.label, '来源未标注');
});

/* ==================================================================== */
/*  二、接口层：source_display 与登记表一致                              */
/* ==================================================================== */

await testAsync('内容接口按同一口径返回 source_display（官方 / 第三方 / 未标注）', async () => {
  const now = new Date().toISOString();
  void now;
  // 三条内容正文必须**互不相同**：同内容会被判为转载副本并建立 duplicate_of 关联
  // （那是正确的去重行为），这里要验证的是来源展示口径。
  content.upsertContent({
    source_url: 'https://www.mee.gov.cn/xxgk/2026/official.html',
    title: '官方来源条目', publisher: '生态环境部', body_snapshot: '官方政策正文。'.repeat(200),
    content_type: 'policy_notice', published_at: '2026-10-01', record_kind: 'article',
  }, { actor: 'test:64' });
  content.upsertContent({
    source_url: 'https://www.tanpaifang.com/repost/official-notice.html',
    title: '转载官方内容的第三方条目', publisher: '碳排放交易网', body_snapshot: '第三方转载与评论正文。'.repeat(200),
    content_type: 'industry_news', published_at: '2026-10-02', record_kind: 'article',
  }, { actor: 'test:64' });
  content.upsertContent({
    source_url: 'https://no-publisher.example/x.html',
    title: '未知来源条目', publisher: null, body_snapshot: '未知来源站点正文内容。'.repeat(200),
    content_type: 'industry_news', published_at: '2026-10-03', record_kind: 'article',
  }, { actor: 'test:64' });
  const rows = db.all("SELECT id, title FROM content_item WHERE title IN ('官方来源条目','转载官方内容的第三方条目','未知来源条目')");
  assertEqual(rows.length, 3, '应写入 3 条测试内容');

  process.env.CCER_AUTH_MODE = 'session';
  const { server } = await import('../src/server.mjs');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user_id: 'user-admin', password: 'admin-demo-2026' }),
  });
  const token = (await login.json()).token;
  const res = await fetch(`${base}/api/v2/content?limit=50`, { headers: { authorization: `Bearer ${token}` } });
  const body = await res.json();
  assert(Array.isArray(body.items), `内容接口应返回 items，实际 HTTP ${res.status}：${JSON.stringify(body).slice(0, 200)}`);
  const byTitle = Object.fromEntries((body.items || []).map((i) => [i.title, i]));
  assert(byTitle['官方来源条目'], `内容接口应返回测试条目，实际：${(body.items || []).map((i) => i.title).join('、')}`);
  assertEqual(byTitle['官方来源条目'].source_display.kind, 'official');
  assertEqual(byTitle['官方来源条目'].source_display.label, '官方信息');
  assertEqual(byTitle['转载官方内容的第三方条目'].source_display.kind, 'third_party');
  assertEqual(byTitle['转载官方内容的第三方条目'].source_display.label, '碳排放交易网');
  assertEqual(byTitle['未知来源条目'].source_display.kind, 'unknown');
  assertIncludes(byTitle['未知来源条目'].source_display.label, 'no-publisher.example');
  // 公开列表必须带核心摘要载荷（未生成时为如实空态）
  assert('summary_block' in byTitle['官方来源条目'], '列表条目应带 summary_block');
  // 让 keep-alive 连接与响应句柄先落定，避免 Windows 上 libuv 在 exit 时断言失败
  server.unref();
  await new Promise((r) => setTimeout(r, 50));
});

finish('64-v2-source-display.test.mjs');
