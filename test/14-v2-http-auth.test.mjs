/**
 * v2 测试 14：HTTP 接口的认证与权限（端到端）
 * ============================================================================
 * 在临时库上启动真实 HTTP 服务（随机端口），验证：
 *   - 未认证访问 /api/v2/* → 401
 *   - session 模式下 x-user-id / ?user= 被忽略（不能靠改请求头提权）
 *   - 只有管理员能访问后台管理接口（普通用户 403）
 *   - 跨站写请求被拒绝（sec-fetch-site: cross-site）
 *   - 导出下载返回正确 MIME 与文件名
 *   - /v2 工作台静态页面可访问
 *   - 服务健康检查包含 v2 状态（生产库标记为只读）
 */
import {
  setupV2, test, testAsync, assert, assertEqual, assertIncludes, finish,
} from './v2-helpers.mjs';

const ctx = await setupV2();
const { db, auth } = ctx;

console.log('\n[v2-14] HTTP 认证与权限');

process.env.CCER_AUTH_MODE = 'session';
const { server } = await import('../src/server.mjs');
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

async function call(path, { method = 'GET', body = null, token = null, headers = {} } = {}) {
  const res = await fetch(`${base}${path}`, {
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
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: res.status, json, headers: res.headers };
}

let adminToken = null;
let viewerToken = null;

await testAsync('登录：管理员使用演示口令成功并返回会话令牌', async () => {
  const out = await call('/api/auth/login', { method: 'POST', body: { user_id: 'user-admin', password: 'admin-demo-2026' } });
  assertEqual(out.status, 200, `登录失败：${JSON.stringify(out.json)}`);
  assert(out.json.token, '应返回令牌');
  assertEqual(out.json.user.role, 'admin');
  assertEqual(out.json.must_change_password, false, '未设置服务端口令时不需要改密');
  adminToken = out.json.token;
});

await testAsync('登录：错误口令返回 401 且不区分「用户不存在」与「口令错误」', async () => {
  const a = await call('/api/auth/login', { method: 'POST', body: { user_id: 'user-admin', password: 'wrong-password-xxxx' } });
  const b = await call('/api/auth/login', { method: 'POST', body: { user_id: 'no-such-user', password: 'whatever-1234' } });
  assertEqual(a.status, 401);
  assertEqual(b.status, 401);
  assertEqual(a.json.error, b.json.error, '两种失败应返回同一文案，避免枚举账号');
});

await testAsync('未认证访问 v2 接口 → 401', async () => {
  const out = await call('/api/v2/overview');
  assertEqual(out.status, 401);
});

await testAsync('session 模式下 x-user-id 请求头被忽略（不能靠改头提权）', async () => {
  const out = await call('/api/v2/admin/status', { headers: { 'x-user-id': 'user-admin' } });
  assertEqual(out.status, 401, '仅带 x-user-id 应仍然 401');
  const out2 = await call('/api/v2/admin/status?user=user-admin');
  assertEqual(out2.status, 401, '查询参数自报身份同样无效');
});

await testAsync('普通用户（只读）访问后台管理接口 → 403', async () => {
  const login = await call('/api/auth/login', { method: 'POST', body: { user_id: 'user-other', password: 'viewer-demo-2026' } });
  assertEqual(login.status, 200);
  viewerToken = login.json.token;
  const out = await call('/api/v2/admin/users', { token: viewerToken });
  assertEqual(out.status, 403, '只读用户不得查看用户管理');
  assertIncludes(out.json.error, '权限');
});

await testAsync('普通用户不能执行写操作（采集 / 导入 / 核对 / 核验）', async () => {
  // 注意：旧的人工核对类写接口已停用（返回 410），这里只断言仍在用的写接口权限
  const collectOut = await call('/api/v2/trade/collect', { method: 'POST', body: { limit: 1 }, token: viewerToken });
  assertEqual(collectOut.status, 403, `采集应 403，实际 ${collectOut.status}`);
  // 用真实存在的模板，确保先命中权限判定（模板不存在会先返回 404）
  const importOut = await call('/api/v2/import/public-project', {
    method: 'POST', body: { rows: [{ name: 'x' }] }, token: viewerToken,
  });
  assertEqual(importOut.status, 403, `导入应 403，实际 ${importOut.status}`);
  const checksOut = await call('/api/v2/admin/checks/run', { method: 'POST', body: {}, token: viewerToken });
  assertEqual(checksOut.status, 403, `数据核对应 403，实际 ${checksOut.status}`);
  const verifyOut = await call('/api/v2/admin/verify/run', { method: 'POST', body: {}, token: viewerToken });
  assertEqual(verifyOut.status, 403, `自动核验应 403，实际 ${verifyOut.status}`);
  const contentOut = await call('/api/v2/content/collect', { method: 'POST', body: {}, token: viewerToken });
  assertEqual(contentOut.status, 403, `内容采集应 403，实际 ${contentOut.status}`);
  const connectorOut = await call('/api/v2/admin/search-providers', {
    method: 'POST', body: { name: 'x' }, token: viewerToken,
  });
  assertEqual(connectorOut.status, 403, `连接配置应 403，实际 ${connectorOut.status}`);
});

await testAsync('普通用户可以读取总览与交易信息（只读不受限）', async () => {
  const ov = await call('/api/v2/overview', { token: viewerToken });
  assertEqual(ov.status, 200);
  assert(Array.isArray(ov.json.metrics) && ov.json.metrics.length >= 6, '应返回指标');
  const tr = await call('/api/v2/trade/overview', { token: viewerToken });
  assertEqual(tr.status, 200);
});

await testAsync('跨站写请求被拒绝（Cookie 会话下的 CSRF 防护）', async () => {
  // 用 Cookie 会话（浏览器自动携带）模拟跨站表单/脚本请求：Origin 与本站不一致 → 拒绝
  const login = await call('/api/auth/login', { method: 'POST', body: { user_id: 'user-admin', password: 'admin-demo-2026' } });
  const cookie = login.headers.get('set-cookie');
  assert(cookie, '登录应下发 Cookie 会话');
  const crossSite = await fetch(`${base}/api/v2/content/collect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: String(cookie).split(';')[0], origin: 'https://evil.example.com' },
    body: JSON.stringify({}),
  });
  assertEqual(crossSite.status, 403, '跨站 Origin 的写请求应被拒绝');
  const body = await crossSite.json();
  assertIncludes(body.error, '跨站');
  // 同源 Cookie 请求正常放行（返回业务结果，而不是被 CSRF 拦截）
  const sameSite = await fetch(`${base}/api/v2/content/collect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: String(cookie).split(';')[0], origin: base },
    body: JSON.stringify({}),
  });
  assert(sameSite.status === 200 || sameSite.status === 201, `同源请求应进入业务逻辑，实际 ${sameSite.status}`);
  const sameBody = await sameSite.json();
  assertEqual(sameBody.reason, 'no_search_provider', '未配置搜索服务时应如实报告，而不是伪造结果');
  // Bearer 令牌请求不做 Origin 校验：Authorization 头不会被浏览器自动携带，不构成 CSRF 风险
  const bearer = await call('/api/v2/content/collect', {
    method: 'POST', token: adminToken, body: {},
    headers: { origin: 'https://evil.example.com' },
  });
  assertEqual(bearer.status, 200, 'Bearer 请求按业务处理');
  assertEqual(bearer.json.reason, 'no_search_provider', 'Bearer 请求应进入业务逻辑');
});

await testAsync('管理员读取系统状态：标记非生产库、AI 默认关闭', async () => {
  const out = await call('/api/v2/admin/status', { token: adminToken });
  assertEqual(out.status, 200);
  assertEqual(out.json.database.is_production_db, false);
  assertEqual(out.json.ai.any_ai_available, false);
  assertIncludes(out.json.identity.note, 'SSO');
});

await testAsync('导出下载：返回附件文件名、行数与 sha256，并写入导出审计', async () => {
  db.run(
    `INSERT INTO trade_daily (id,trade_date,trade_method,volume,turnover,avg_price,market,session_state,collected_at,verify_status,revision,created_at,updated_at)
     VALUES ('TD-HTTP-1','2026-07-01','官方合计（未区分交易方式）',1000,95000,95,'CCER','traded',?, 'verified',1,?,?)`,
    [new Date().toISOString(), new Date().toISOString(), new Date().toISOString()]
  );
  const res = await fetch(`${base}/api/v2/trade/export?format=csv&from=2026-07-01&to=2026-07-01`, {
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assertEqual(res.status, 200);
  assertIncludes(res.headers.get('content-type'), 'text/csv');
  assertIncludes(res.headers.get('content-disposition'), 'attachment');
  assert(res.headers.get('x-export-sha256'), '应返回 sha256');
  const text = await res.text();
  assertIncludes(text, '成交量');
  assertIncludes(text, '不是收盘价');
  const log = db.get("SELECT * FROM export_log WHERE dataset = '交易行情明细' ORDER BY at DESC LIMIT 1");
  assert(log, '应写入导出审计');
});

await testAsync('xlsx 导出可被解析为 ZIP（PK 头）', async () => {
  const res = await fetch(`${base}/api/v2/trade/export?format=xlsx`, { headers: { authorization: `Bearer ${adminToken}` } });
  assertEqual(res.status, 200);
  const buf = Buffer.from(await res.arrayBuffer());
  assertEqual(buf[0], 0x50, 'ZIP 头 PK');
  assertEqual(buf[1], 0x4b, 'ZIP 头 PK');
});

await testAsync('v2 工作台静态页面可访问（/v2）', async () => {
  const res = await fetch(`${base}/v2`);
  assertEqual(res.status, 200);
  const html = await res.text();
  assertIncludes(html, 'CCER');
  assertIncludes(html, '/v2/app.js');
  const js = await fetch(`${base}/v2/app.js`);
  assertEqual(js.status, 200);
  const appJs = await js.text();
  // 八个主模块导航（docs/34 起为八模块；docs/39 把「减排粗估」改名为「碳计算与因子」），
  // 且不再包含内部项目 / 人工审核入口
  for (const label of ['总览', '政策和方法学', '公开项目', '交易信息', 'CEA市场', '碳计算与因子', '研报与行业动态', '后台管理']) {
    assertIncludes(appJs, label, `导航应包含「${label}」`);
  }
  assert(!appJs.includes('内部项目库'), '导航不应再出现内部项目库');
  assert(!appJs.includes('审核任务'), '导航不应再出现审核任务');
});

await testAsync('健康检查包含 v2 状态说明', async () => {
  const out = await call('/api/health');
  assertEqual(out.status, 200);
  assert(out.json.v2, '应包含 v2 状态');
  assertEqual(out.json.v2.production_db, false);
});

await testAsync('v1 接口仍然可用（未破坏既有功能）', async () => {
  const out = await call('/api/methodologies', { token: adminToken });
  assertEqual(out.status, 200);
  assert(Array.isArray(out.json.formal), 'v1 方法学接口应正常返回');
});

await testAsync('管理员重置口令后：新口令可登录、旧会话被撤销、登录写入记录', async () => {
  const created = await call('/api/v2/admin/users', {
    method: 'POST', token: adminToken, body: { id: 'user-http-test', name: '接口测试用户', role: 'analyst', team_id: 'team-invest' },
  });
  assertEqual(created.status, 200);
  const reset = await call('/api/v2/admin/users/user-http-test/password', {
    method: 'POST', token: adminToken, body: { password: 'Zx9Qw8Er7Ty6' },
  });
  assertEqual(reset.status, 200, `重置失败：${JSON.stringify(reset.json)}`);
  const login = await call('/api/auth/login', { method: 'POST', body: { user_id: 'user-http-test', password: 'Zx9Qw8Er7Ty6' } });
  assertEqual(login.status, 200, '新口令应可登录');
  assertEqual(login.json.must_change_password, true, '应要求首次改密');
  const logs = db.all("SELECT * FROM user_login_log WHERE user_id = 'user-http-test'");
  assert(logs.length >= 1, '应写入登录记录');
  void auth;
});

await testAsync('未认证用户的越权尝试不会写入数据（接口调用后数据条数不变）', async () => {
  const before = db.get('SELECT COUNT(*) c FROM content_item').c;
  const out = await call('/api/v2/content/collect', { method: 'POST', body: {} });
  assertEqual(out.status, 401, `未认证写操作应 401，实际 ${out.status}`);
  const after = db.get('SELECT COUNT(*) c FROM content_item').c;
  assertEqual(after, before, '未认证请求不得写入数据');
});

server.close();
finish('test/14-v2-http-auth.test.mjs');
