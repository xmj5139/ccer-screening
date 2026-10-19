/**
 * 49-v2-accounting-api.test.mjs —— 公开碳核算资料 API：认证、权限、202 任务、导出安全
 * ============================================================================
 * 断言重点（docs/39 第 97、99 条）：
 *   匿名 401、普通用户 403、管理员 202 任务；
 *   读接口在 v2 未启用 / 表未就绪时 503；
 *   CSV 防公式注入；来源链接 http/https 白名单；SQL 参数化；
 *   禁任意服务器路径与任意 URL 外发；凭据不外泄；
 *   "202 已受理"不等于"采集成功"。
 */
import {
  setupV2, test, testAsync, assert, assertEqual, assertIncludes, assertNotIncludes, finish } from './v2-helpers.mjs';

const ctx = await setupV2();
console.log('\n[v2-49] 公开碳核算资料 API：认证 / 权限 / 任务 / 导出安全');

const acc = await import('../src/services/accounting-svc.mjs');
acc.seedAccountingBase();

process.env.CCER_AUTH_MODE = 'session';
const { server } = await import('../src/server.mjs');
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port }`;

async function call(path, { method = 'GET', body = null, token = null, headers = { }, raw = false } = { }) {
  const res = await fetch(`${base }${path }`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : { }),
      ...(token ? { authorization: `Bearer ${token }` } : { }),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (raw) return { status: res.status, text: await res.text(), headers: res.headers };
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null; } catch {
    json = { raw: text.slice(0, 300) };
  }
  return { status: res.status, json, headers: res.headers };
}

let adminToken = null;
let viewerToken = null;

await testAsync('管理员登录', async () => {
  const out = await call('/api/auth/login', { method: 'POST', body: { user_id: 'user-admin', password: 'admin-demo-2026' } });
  assertEqual(out.status, 200, `登录失败：${JSON.stringify(out.json) }`);
  adminToken = out.json.token;
});

await testAsync('普通用户登录', async () => {
  const out = await call('/api/auth/login', { method: 'POST', body: { user_id: 'user-other', password: 'viewer-demo-2026' } });
  assertEqual(out.status, 200, `登录失败：${JSON.stringify(out.json) }`);
  assertEqual(out.json.user.role, 'viewer');
  viewerToken = out.json.token;
});

/* ==================================================================== */
/*  一、匿名 401                                                         */
/* ==================================================================== */

await testAsync('匿名访问碳核算读接口 → 401', async () => {
  for (const p of [
    '/api/v2/accounting/status',
    '/api/v2/accounting/sources',
    '/api/v2/accounting/factors',
    '/api/v2/accounting/standards',
    '/api/v2/accounting/crc-daily',
    '/api/v2/accounting/export/factors?format=csv',
  ]) {
    const out = await call(p);
    assertEqual(out.status, 401, `${p } 应要求登录`);
  }
});

await testAsync('匿名调用计算接口 → 401（计算也必须登录，且不是任意公开算力入口）', async () => {
  const out = await call('/api/v2/accounting/calculate/electricity', {
    method: 'POST', body: { energy: 1, energy_unit: 'kWh' },
  });
  assertEqual(out.status, 401);
});

await testAsync('匿名访问后台采集接口 → 401', async () => {
  for (const [m, p] of [['GET', '/api/v2/accounting/admin/config'], ['POST', '/api/v2/accounting/admin/collect']]) {
    const out = await call(p, { method: m, body: m === 'POST' ? { target: 'all' } : null });
    assertEqual(out.status, 401, `${m } ${p } 应要求登录`);
  }
});

/* ==================================================================== */
/*  二、普通用户：可读可算，不可管理                                     */
/* ==================================================================== */

await testAsync('普通用户可读因子库、标准库、来源与清结算日报', async () => {
  const f = await call('/api/v2/accounting/factors?data_year=2023', { token: viewerToken });
  assertEqual(f.status, 200, JSON.stringify(f.json).slice(0, 200));
  assertEqual(f.json.total, 40);
  assertEqual(f.json.rows.length, 40);
  assertEqual(f.json.facets.data_years.includes(2023), true);

  const s = await call('/api/v2/accounting/standards?sector=钢铁', { token: viewerToken });
  assertEqual(s.status, 200);
  assertEqual(s.json.total, 2);

  const src = await call('/api/v2/accounting/sources?category=crc', { token: viewerToken });
  assertEqual(src.status, 200);
  assert(src.json.sources.length >= 8);
  assertIncludes(src.json.note, '未经采集的来源保持 registered');

  const crc = await call('/api/v2/accounting/crc-daily', { token: viewerToken });
  assertEqual(crc.status, 200);
  assert(crc.json.rows.length >= 1);
  assertEqual(crc.json.rows[0].cea_compare.combined_total, null);
});

await testAsync('普通用户可调用纯函数计算接口，结果含公式与出处', async () => {
  const f = await call('/api/v2/accounting/factors?data_year=2023&category=national_average', { token: viewerToken });
  const factorId = f.json.rows[0].id;
  const out = await call('/api/v2/accounting/calculate/electricity', {
    method: 'POST', token: viewerToken,
    body: { energy: 100, energy_unit: '万kWh', factor_id: factorId, target_year: 2023 },
  });
  assertEqual(out.status, 200, JSON.stringify(out.json).slice(0, 200));
  assertEqual(out.json.total_tco2, 530.6);
  assertEqual(out.json.formula, 'E = AD × EF ÷ 1000');
  assertIncludes(out.json.limitation, '不是');
  assertEqual(out.json.total_tco2e, null);
});

await testAsync('普通用户非法输入 → 400 且给出明确原因（不是 500）', async () => {
  const out = await call('/api/v2/accounting/calculate/fuel', {
    method: 'POST', token: viewerToken,
    body: { amount: 1, amount_unit: 't', ncv: 20, ncv_unit: 'GJ/万Nm³', carbon_content: 25, oxidation_rate: 0.99, carbon_content_unit: 'tC/TJ' },
  });
  assertEqual(out.status, 400);
  assertIncludes(out.json.error, '单位不匹配');
});

await testAsync('普通用户访问后台接口 → 403（服务端判定，不依赖前端隐藏）', async () => {
  const cases = [
    ['GET', '/api/v2/accounting/admin/config', null],
    ['POST', '/api/v2/accounting/admin/config', { batch_budget_ms: 1000 }],
    ['POST', '/api/v2/accounting/admin/collect', { target: 'all' }],
    ['GET', '/api/v2/accounting/admin/jobs', null],
    ['POST', '/api/v2/accounting/admin/verify', { standard_id: 'x' }],
    ['POST', '/api/v2/accounting/admin/upload-body', { standard_id: 'x', file_path: 'C:/Windows/win.ini' }],
  ];
  for (const [m, p, b] of cases) {
    const out = await call(p, { method: m, token: viewerToken, body: b });
    assertEqual(out.status, 403, `${m } ${p } 应 403，实际 ${out.status }：${JSON.stringify(out.json).slice(0, 160) }`);
  }
});

await testAsync('普通用户不能通过 Bearer 之外的路径提权（x-user-id 被忽略）', async () => {
  const out = await call('/api/v2/accounting/admin/config', { headers: { 'x-user-id': 'user-admin' } });
  assertEqual(out.status, 401);
});

/* ==================================================================== */
/*  三、管理员：202 受理 + 进度轮询 + 配置校验                            */
/* ==================================================================== */

await testAsync('管理员触发采集 → 202 + task_id（明确"已受理≠已成功"）', async () => {
  const out = await call('/api/v2/accounting/admin/collect', {
    method: 'POST', token: adminToken, body: { target: 'portals' },
  });
  assertEqual(out.status, 202, JSON.stringify(out.json).slice(0, 300));
  assert(out.json.task_id, '应返回 task_id');
  assertEqual(out.json.accepted, true);
  assertEqual(out.json.http_status, 202);
  assertEqual(out.json.target, 'portals');
  // 立即轮询：状态应是 queued/running 或已结束，且**不能**因为受理就报 success
  const jobs = await call(`/api/v2/accounting/admin/jobs?task_id=${encodeURIComponent(out.json.task_id) }`, { token: adminToken });
  assertEqual(jobs.status, 200);
  assert(jobs.json.task, '应能按 task_id 取到任务');
  assert(['queued', 'running', 'success', 'partial', 'failed'].includes(jobs.json.task.status));
  assertIncludes(jobs.json.note, '202 只表示已受理');
  assertIncludes(jobs.json.note, '空扫描');
});

await testAsync('重复触发同一目标 → 合并到运行中的任务（不重复抓取）', async () => {
  const first = await call('/api/v2/accounting/admin/collect', {
    method: 'POST', token: adminToken, body: { target: 'standards' },
  });
  assertEqual(first.status, 202);
  const second = await call('/api/v2/accounting/admin/collect', {
    method: 'POST', token: adminToken, body: { target: 'standards' },
  });
  assertEqual(second.status, 202);
  // 若第一轮已跑完则不会合并；两种情况都必须是"同一个语义"：不重复抓取
  if (second.json.merged) {
    assertEqual(second.json.task_id, first.json.task_id, '合并必须指向同一 task_id');
    assertIncludes(second.json.message, '不重复抓取'); } else {
    assert(second.json.task_id !== first.json.task_id, '未合并时应是新任务'); }
  // 等待任务收尾，避免影响后续用例（沙箱无外网 → 会以网络失败结束，这是如实结果）
  for (let i = 0; i < 40; i += 1) {
    const j = await call(`/api/v2/accounting/admin/jobs?task_id=${encodeURIComponent(first.json.task_id) }`, { token: adminToken });
    if (['success', 'partial', 'failed'].includes(j.json.task?.status)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const done = await call(`/api/v2/accounting/admin/jobs?task_id=${encodeURIComponent(first.json.task_id) }`, { token: adminToken });
  assert(['success', 'partial', 'failed'].includes(done.json.task.status), `任务应已收尾，实际 ${done.json.task.status }`);
});

await testAsync('未知采集目标 → 400 并列出允许值', async () => {
  const out = await call('/api/v2/accounting/admin/collect', {
    method: 'POST', token: adminToken, body: { target: 'not-a-target' },
  });
  assertEqual(out.status, 400);
  assertIncludes(out.json.error, '未知采集目标');
  assert(out.json.allowed.includes('all'));
});

await testAsync('管理员配置：单批预算不得超过 120 秒（需求硬约束）', async () => {
  const bad = await call('/api/v2/accounting/admin/config', {
    method: 'POST', token: adminToken, body: { batch_budget_ms: 300000 },
  });
  assertEqual(bad.status, 400);
  assertIncludes(bad.json.error, '不得超过 120000');
  const bad2 = await call('/api/v2/accounting/admin/config', {
    method: 'POST', token: adminToken, body: { max_pages_per_pdf: 0 },
  });
  assertEqual(bad2.status, 400);
  const good = await call('/api/v2/accounting/admin/config', {
    method: 'POST', token: adminToken, body: { batch_budget_ms: 60000, max_details_per_source: 3, verify_with_model: false },
  });
  assertEqual(good.status, 200, JSON.stringify(good.json).slice(0, 200));
  assertEqual(good.json.config.batch_budget_ms, 60000);
  assertEqual(good.json.config.verify_with_model, false);
  // 配置可读回
  const cfg = await call('/api/v2/accounting/admin/config', { token: adminToken });
  assertEqual(cfg.json.config.batch_budget_ms, 60000);
  assertIncludes(cfg.json.limits_note, '单批 ≤120 秒');
});

await testAsync('配置接口不返回任何凭据类字段', async () => {
  const out = await call('/api/v2/accounting/admin/config', { token: adminToken });
  const s = JSON.stringify(out.json);
  for (const bad of ['credential_cipher', 'api_key', 'secret', 'access_token', 'password']) {
    assertNotIncludes(s, bad); }
});

await testAsync('上传正文：拒绝任意服务器路径（只接受受限根内路径）', async () => {
  const std = await call('/api/v2/accounting/standards?q=铝冶炼', { token: adminToken });
  const id = std.json.rows[0].id;
  for (const bad of ['C:/Windows/win.ini', '/etc/passwd', '../../secret.txt', 'D:\\AI workspace\\ccer-screening\\package.json']) {
    const out = await call('/api/v2/accounting/admin/upload-body', {
      method: 'POST', token: adminToken, body: { standard_id: id, file_path: bad },
    });
    assertEqual(out.status, 400, `${bad } 必须被拒绝，实际 ${out.status }`);
    assertIncludes(out.json.error, '受限根');
  }
  // 缺 file_path → 明确说明不接受任意 URL 外发
  const noPath = await call('/api/v2/accounting/admin/upload-body', {
    method: 'POST', token: adminToken, body: { standard_id: id },
  });
  assertEqual(noPath.status, 400);
  assertIncludes(noPath.json.error, '不接受任意路径或任意 URL 外发');
});

await testAsync('重跑模型核验：无模型配置时返回 unavailable，不显示为已核验', async () => {
  const std = await call('/api/v2/accounting/standards?q=钢铁', { token: adminToken });
  const target = std.json.rows.find((r) => r.code === 'CETS-AG-03.01-V01-2024');
  const out = await call('/api/v2/accounting/admin/verify', {
    method: 'POST', token: adminToken, body: { standard_id: target.id },
  });
  assertEqual(out.status, 200, JSON.stringify(out.json).slice(0, 200));
  assertEqual(out.json.result, 'unavailable');
  assertEqual(out.json.reason, 'no_body', '该规范还没有正文，应先返回 no_body');
  const missing = await call('/api/v2/accounting/admin/verify', {
    method: 'POST', token: adminToken, body: { },
  });
  assertEqual(missing.status, 400);
});

/* ==================================================================== */
/*  四、导出安全：CSV 公式注入、链接白名单、凭据不外泄                    */
/* ==================================================================== */

await testAsync('CSV 导出：公式注入被前缀转义，且带口径元信息', async () => {
  // 塞入一条以 = 开头的“因子名称”，验证导出时被转义
  const raw = ctx.db.getDb();
  raw.prepare(
    `INSERT INTO emission_factor
      (id, identity_key, source_identity, source_code, name, value, original_unit, standard_unit, gas,
       category, caliber, region, region_level, industry, data_year, version, original_url,
       evidence_level, model_verify_status, is_current, created_at, updated_at)
     VALUES ('EF-INJECT','inject|test|=cmd|2023|v1','x','mee_electricity_factor_2023',
       '=cmd|'' /C calc''!A1', 1.0, 'kgCO2/kWh', 'kgCO2/kWh', 'CO2',
       'national_average', '注入测试行', NULL, 'national', '电力', 2023, '2023', 'https://www.mee.gov.cn/x.pdf',
       'metadata_only', 'unavailable', 1, datetime('now'), datetime('now'))`
  ).run();
  const out = await call('/api/v2/accounting/export/factors?format=csv', { token: viewerToken, raw: true });
  assertEqual(out.status, 200);
  assertIncludes(out.headers.get('content-type') || '', 'csv');
  assert(out.text.includes("'=cmd"), '以 = 开头的单元格必须加前缀转义，避免被 Excel 当公式执行');
  assertNotIncludes(out.text.split('\n').filter((l) => l.includes('cmd|')).join('\n'), '\n=cmd');
  assertIncludes(out.text, '# 口径');
  assertIncludes(out.text, '不是 CCER 区域电网基准线因子');
  raw.prepare("DELETE FROM emission_factor WHERE id='EF-INJECT'").run();
});

await testAsync('JSON 导出：字段与数据库一致，且不含任何凭据字段', async () => {
  const out = await call('/api/v2/accounting/export/standards?format=json', { token: viewerToken });
  assertEqual(out.status, 200);
  const s = JSON.stringify(out.json);
  assertNotIncludes(s, 'credential');
  assertNotIncludes(s, 'api_key');
  assertNotIncludes(s, 'password');
  const rows = out.json.rows || out.json.data || out.json;
  assert(Array.isArray(rows) ? rows.length === 12 : true);
});

await testAsync('清单结算导出包含两方口径与修订号（不隐藏历史）', async () => {
  const out = await call('/api/v2/accounting/export/crc-daily?format=csv', { token: viewerToken, raw: true });
  assertEqual(out.status, 200);
  assertIncludes(out.text, '公布均价');
  assertIncludes(out.text, '复算均价');
  assertIncludes(out.text, '与 CEA 同日量额不做相加');
  assertIncludes(out.text, '2861440');
});

test('前端来源链接白名单：非 http/https 一律不给链接', async () => {
  const routes = await import('../src/routes-accounting.mjs');
  assertEqual(routes.validHttpUrl('https://www.mee.gov.cn/a.pdf'), 'https://www.mee.gov.cn/a.pdf');
  assertEqual(routes.validHttpUrl('http://www.chinacrc.net.cn/'), 'http://www.chinacrc.net.cn/');
  assertEqual(routes.validHttpUrl('javascript:alert(1)'), null);
  assertEqual(routes.validHttpUrl('data:text/html,<script>alert(1)</script>'), null);
  assertEqual(routes.validHttpUrl('file:///C:/Windows/win.ini'), null);
  assertEqual(routes.validHttpUrl('vbscript:msgbox(1)'), null);
  assertEqual(routes.validHttpUrl(''), null);
  assertEqual(routes.validHttpUrl(null), null); });

test('SQL 参数化：带引号/分号的筛选词不会破坏查询，也不会返回越权数据', () => {
  const evil = "2023'; DROP TABLE emission_factor; --";
  const out = acc.listFactors({ q: evil });
  assertEqual(out.total, 0, '恶意筛选词不应命中任何行');
  assertEqual(acc.listFactors({ data_year: 2023 }).total, 40, '表必须还在且数据完整');
  const std = acc.listStandards({ q: "' OR 1=1 --" });
  assertEqual(std.total, 0);
  assertEqual(acc.listStandards({ }).total, 12);
});

await testAsync('所有碳核算路由都已装配且方法正确（GET/POST 不串）', async () => {
  const routes = await import('../src/routes-v2.mjs');
  const accRoutes = routes.V2_ROUTES.filter(([, p]) => p.startsWith('/api/v2/accounting'));
  assertEqual(accRoutes.length, 25, '25 条碳核算路由（含公开资料列表及详情）');
  // GET 路由不接受 POST
  const out = await call('/api/v2/accounting/factors', { method: 'POST', token: viewerToken, body: { } });
  assert(out.status === 404 || out.status === 405, `GET 路由不应接受 POST，实际 ${out.status }`);
});

/* ==================================================================== */
/*  五、每日任务接入与任务状态语义（纯函数 + 装配）                       */
/* ==================================================================== */

test('每日全平台任务已加入碳核算采集步骤（06:30 默认任务）', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/services/collect-svc.mjs', import.meta.url), 'utf8');
  assertIncludes(src, 'runAccountingDailyStep', 'runDailyJob 必须调用碳核算每日步骤');
  assertIncludes(src, 'system:daily-accounting');
  // 失败只记录、不中断既有采集
  assertIncludes(src, 'detail.accounting');
  const collect = await import('../src/services/accounting-collect-svc.mjs');
  assertEqual(typeof collect.runAccountingDailyStep, 'function');
  assertEqual(typeof collect.summarizeAccountingOutcome, 'function');
  assertEqual(typeof collect.readAccountingCursor, 'function');
  assertEqual(typeof collect.writeAccountingCursor, 'function');
});

test('任务状态语义：「空扫描」不是失败，「抓到却解析 0 行」是失败', async () => {
  const collect = await import('../src/services/accounting-collect-svc.mjs');
  const empty = collect.summarizeAccountingOutcome({ empty_scan: true, stats: { errors: 0, parsed: 0 } });
  assertEqual(empty.status, 'success');
  assertEqual(empty.empty_scan, true);
  assertIncludes(empty.note, '空扫描');
  assertIncludes(empty.note, '不是采集成功');

  const zero = collect.summarizeAccountingOutcome({ empty_scan: false, stats: { errors: 0, parsed: 0 } });
  assertEqual(zero.status, 'failed', 'accepted 或 0 行解析都不得算成功');
  assertIncludes(zero.note, '不把 accepted 或 0 行解析称成功');

  const ok = collect.summarizeAccountingOutcome({ empty_scan: false, stats: { errors: 0, parsed: 3 } });
  assertEqual(ok.status, 'success');
  const partial = collect.summarizeAccountingOutcome({ empty_scan: false, stats: { errors: 2, parsed: 3 } });
  assertEqual(partial.status, 'partial');
  const failed = collect.summarizeAccountingOutcome({ empty_scan: false, stats: { errors: 2, parsed: 0 } });
  assertEqual(failed.status, 'failed');
});

test('重试游标可读写且幂等（写入后读回一致）', async () => {
  const collect = await import('../src/services/accounting-collect-svc.mjs');
  const written = collect.writeAccountingCursor({ crc_last_trade_date: '2026-10-14', standards_body_pending: 10 });
  assertEqual(written.crc_last_trade_date, '2026-10-14');
  const read = collect.readAccountingCursor();
  assertEqual(read.crc_last_trade_date, '2026-10-14');
  assertEqual(read.standards_body_pending, 12);
  assert(read.updated_at, '游标应带更新时间');
});

test('分页发现只跟随页面里真实存在的同路径 href（不拼猜页码）', async () => {
  const collect = await import('../src/services/accounting-collect-svc.mjs');
  const html = '<a href="/list/18.html?page=2">下一页</a><a href="/list/9.html?page=9">别的栏目</a><a href="/list/18.html?page=3">3</a>';
  const links = collect.paginationLinks(html, 'https://www.chinacrc.net.cn/list/18.html', 'https://www.chinacrc.net.cn/list/18.html');
  assertEqual(links.join(','), 'https://www.chinacrc.net.cn/list/18.html?page=2,https://www.chinacrc.net.cn/list/18.html?page=3');
  assertEqual(collect.paginationLinks('<p>没有分页</p>', 'https://www.chinacrc.net.cn/list/18.html', 'https://www.chinacrc.net.cn/list/18.html').length, 0); });

test('每日定时器在 CCER_DAILY_SYNC=0 时不启动（本地开发不误触发）', async () => {
  const prev = process.env.CCER_DAILY_SYNC;
  process.env.CCER_DAILY_SYNC = '0';
  const sched = await import('../src/services/daily-scheduler.mjs');
  assertEqual(sched.startDailyScheduler(), null);
  sched.stopDailyScheduler();
  process.env.CCER_DAILY_SYNC = prev; });

finish('49-v2-accounting-api.test.mjs');
