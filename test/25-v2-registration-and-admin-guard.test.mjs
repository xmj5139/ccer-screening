/**
 * v2 测试 25：公开注册与后台管理鉴权
 * ============================================================================
 * 在临时库上启动真实 HTTP 服务（随机端口），验证：
 *   1. `POST /api/auth/register` 未登录可用，成功后创建「只读用户 ＋ 普通团队」账号，
 *      并且**不签发会话**（用户须自行回登录页登录）；
 *   2. 口令复用现有强度校验与 scrypt 哈希：弱口令 400、明文不落库、不写日志、不回显；
 *   3. 重复用户名（含大小写差异与既有账号）返回 409；
 *   4. 提权字段（role / team_id / active / is_admin / permissions / password_hash …）
 *      一律 400 拒绝，且不产生任何账号；
 *   5. 用户名格式受控（长度、字符集、首字符、保留名、类型），显示名与口令类型校验；
 *   6. v2 未启用时注册被拒绝（503）且不写库；
 *   7. 普通用户（新注册的 viewer）访问 `/api/v2/admin/*` 一律 403，
 *      且路由表中每条在役后台路由都被服务端角色判定覆盖（不依赖前端隐藏入口）；
 *      已停用路由对任何角色都保持 410；仅 admin 可进入。
 *
 * 本文件不使用、不打印任何管理员口令：管理员侧的行为通过直接调用路由处理函数
 * （合成 ctx.user）验证，不经过登录。
 */
import {
  setupV2, testAsync, assert, assertEqual, assertIncludes, assertNotIncludes, finish,
} from './v2-helpers.mjs';

const ctx = await setupV2();
const { db } = ctx;

console.log('\n[v2-25] 公开注册与后台管理鉴权');

process.env.CCER_AUTH_MODE = 'session';
const { server } = await import('../src/server.mjs');
const routes = await import('../src/routes-v2.mjs');
const registration = await import('../src/services/registration-svc.mjs');
const { verifyPassword } = await import('../src/core/password.mjs');

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
    json = { raw: text.slice(0, 300) };
  }
  return { status: res.status, json, text, headers: res.headers };
}

/** 强口令（满足既有强度校验：≥12 位 + 大小写字母 + 数字） */
const STRONG = 'RegPass2026xyz';
const USER = 'new-analyst-01';
let viewerToken = null;

/* ------------------------------------------------------------------ */
/*  1. 注册成功路径                                                     */
/* ------------------------------------------------------------------ */

await testAsync('注册：未登录即可注册，返回 201、固定 viewer 与普通团队，且不签发会话', async () => {
  const out = await call('/api/auth/register', {
    method: 'POST',
    body: { username: USER, password: STRONG, display_name: '新注册分析师' },
  });
  assertEqual(out.status, 201, `注册失败：${out.text.slice(0, 200)}`);
  assertEqual(out.json.ok, true);
  assertEqual(out.json.user.id, USER);
  assertEqual(out.json.user.role, 'viewer', '角色必须由服务端固定为 viewer');
  assertEqual(out.json.user.team_id, registration.REGISTER_TEAM_ID, '团队必须由服务端固定为普通团队');
  assertEqual(out.json.user.display_name, '新注册分析师');
  assertEqual(out.json.login_endpoint, '/api/auth/login');
  assertIncludes(out.json.message, '登录', '应提示用户回登录页登录');
  // 不签发会话：没有 token，也没有 Set-Cookie
  assert(!('token' in out.json), '注册响应不得包含会话令牌');
  assertEqual(out.headers.get('set-cookie'), null, '注册不得下发会话 Cookie');
  // 响应不回显口令
  assertNotIncludes(out.text, STRONG, '响应不得包含明文口令');
});

await testAsync('注册：口令以 scrypt 哈希入库，明文不落库、不写审计、不回显', async () => {
  const row = db.get('SELECT * FROM app_user WHERE id = ?', [USER]);
  assert(row, '账号应已写入 app_user');
  assertEqual(row.role, 'viewer');
  assertEqual(row.team_id, registration.REGISTER_TEAM_ID);
  assertEqual(row.active, 1);
  assertEqual(row.must_change_password, 0, '自助注册由用户自行设定口令，不强制改密');
  assertEqual(row.password_algo, 'scrypt');
  assertIncludes(row.password_hash, 'scrypt$', '口令必须以 scrypt 哈希存储');
  assertNotIncludes(row.password_hash, STRONG, '哈希中不得出现明文口令');
  assert(verifyPassword(STRONG, row.password_hash), '入库哈希必须能用原口令校验通过');
  assert(!verifyPassword('WrongPass2026x', row.password_hash), '错误口令不得校验通过');
  // 审计留痕，但只记账号属性
  const auditRow = db.get(
    "SELECT * FROM audit_log WHERE action = 'user.register' AND object_id = ? ORDER BY at DESC LIMIT 1",
    [USER]
  );
  assert(auditRow, '应写入 user.register 审计');
  assertNotIncludes(String(auditRow.detail), STRONG, '审计明细不得包含明文口令');
  assertNotIncludes(String(auditRow.detail), 'scrypt$', '审计明细不得包含口令哈希');
});

await testAsync('注册：显示名可选（空白视为未提供，回落为用户名）', async () => {
  const blank = await call('/api/auth/register', {
    method: 'POST', body: { username: 'blank-name-1', password: STRONG, display_name: '   ' },
  });
  assertEqual(blank.status, 201, blank.text.slice(0, 160));
  assertEqual(blank.json.user.display_name, null);
  assertEqual(blank.json.user.name, 'blank-name-1', '未提供显示名时 name 回落为用户名');
  const none = await call('/api/auth/register', {
    method: 'POST', body: { username: 'no-name-01', password: STRONG },
  });
  assertEqual(none.status, 201);
  assertEqual(none.json.user.name, 'no-name-01');
});

await testAsync('注册：用户名统一小写归一，成功后可用新账号登录（普通只读用户）', async () => {
  const out = await call('/api/auth/register', {
    method: 'POST', body: { username: 'Mixed-Case-User', password: STRONG },
  });
  assertEqual(out.status, 201, out.text.slice(0, 160));
  assertEqual(out.json.user.id, 'mixed-case-user', '用户名应统一小写后入库');
  const login = await call('/api/auth/login', { method: 'POST', body: { user_id: USER, password: STRONG } });
  assertEqual(login.status, 200, `新账号应可登录：${login.text.slice(0, 160)}`);
  assert(login.json.token, '登录应返回会话令牌');
  assertEqual(login.json.user.role, 'viewer');
  assertEqual(login.json.user.team_id, registration.REGISTER_TEAM_ID);
  viewerToken = login.json.token;
  const bad = await call('/api/auth/login', { method: 'POST', body: { user_id: USER, password: 'WrongPass2026x' } });
  assertEqual(bad.status, 401, '错误口令必须 401');
});

/* ------------------------------------------------------------------ */
/*  2. 重复与无效输入                                                   */
/* ------------------------------------------------------------------ */

await testAsync('注册：重复用户名返回 409（含大小写差异与既有账号）', async () => {
  const same = await call('/api/auth/register', { method: 'POST', body: { username: USER, password: STRONG } });
  assertEqual(same.status, 409, `同名注册应 409，实际 ${same.status}`);
  assertIncludes(same.json.error, '占用');
  const upper = await call('/api/auth/register', { method: 'POST', body: { username: 'NEW-Analyst-01', password: STRONG } });
  assertEqual(upper.status, 409, '大小写不同也视为重复');
  const seeded = await call('/api/auth/register', { method: 'POST', body: { username: 'User-Admin', password: STRONG } });
  assertEqual(seeded.status, 409, '不得占用既有账号 ID');
  assertEqual(db.get('SELECT COUNT(*) c FROM app_user WHERE lower(id) = ?', [USER]).c, 1, '重复注册不得产生第二行');
});

await testAsync('注册：并发同名注册只有一个成功', async () => {
  const body = { username: 'race-user-01', password: STRONG };
  const outs = await Promise.all(Array.from({ length: 5 }, () => call('/api/auth/register', { method: 'POST', body })));
  const created = outs.filter((o) => o.status === 201).length;
  const conflict = outs.filter((o) => o.status === 409).length;
  assertEqual(created, 1, `应只有一次成功，实际 ${created}`);
  assertEqual(conflict, 4, `其余应为 409，实际 ${conflict}`);
  assertEqual(db.get('SELECT COUNT(*) c FROM app_user WHERE id = ?', ['race-user-01']).c, 1);
});

await testAsync('注册：提权字段一律 400 拒绝，且不写入任何账号', async () => {
  const before = db.get('SELECT COUNT(*) c FROM app_user').c;
  const payloads = [
    ['priv-role-1', { role: 'admin' }],
    ['priv-role-2', { roles: ['admin', 'researcher'] }],
    ['priv-team-1', { team_id: 'team-carbon' }],
    ['priv-team-2', { team: 'team-invest' }],
    ['priv-active', { active: false }],
    ['priv-admin-1', { is_admin: true }],
    ['priv-admin-2', { admin: true }],
    ['priv-perms-1', { permissions: ['admin'] }],
    ['priv-perms-2', { grants: [{ object_type: 'internal_project', object_id: 'X' }] }],
    ['priv-mcp-1', { must_change_password: 1 }],
    ['priv-hash-1', { password_hash: 'scrypt$1$1$1$a$b' }],
    ['priv-hash-2', { password_algo: 'plain' }],
  ];
  for (const [username, extra] of payloads) {
    const out = await call('/api/auth/register', {
      method: 'POST', body: { username, password: STRONG, ...extra },
    });
    assertEqual(out.status, 400, `${JSON.stringify(extra)} 应 400，实际 ${out.status}：${out.text.slice(0, 120)}`);
    assertIncludes(out.json.error, '不接受客户端指定账号属性', `应明确说明拒绝提权字段：${out.text.slice(0, 160)}`);
    assertEqual(db.get('SELECT id FROM app_user WHERE id = ?', [username]), null, `${username} 不得被创建`);
  }
  // 嵌套对象夹带同样不接受（未知字段）
  const nested = await call('/api/auth/register', {
    method: 'POST', body: { username: 'priv-nested-1', password: STRONG, user: { role: 'admin' } },
  });
  assertEqual(nested.status, 400);
  assertIncludes(nested.json.error, '不支持的字段');
  assertEqual(db.get('SELECT COUNT(*) c FROM app_user').c, before, '提权尝试不得产生任何账号');
});

await testAsync('注册：用户名格式受控（长度 / 字符集 / 首字符 / 保留名 / 类型）', async () => {
  const bad = [
    ['', '不能为空'],
    ['ab', '长度'],
    ['a'.repeat(33), '长度'],
    ['1abc', '小写字母、数字、下划线、连字符'],
    ['-abc', '小写字母、数字、下划线、连字符'],
    ['abc def', '小写字母、数字、下划线、连字符'],
    ['abc@example.com', '小写字母、数字、下划线、连字符'],
    ['张三abc', '小写字母、数字、下划线、连字符'],
    ['admin', '保留名'],
    ['Root', '保留名'],
  ];
  for (const [username, hint] of bad) {
    const out = await call('/api/auth/register', { method: 'POST', body: { username, password: STRONG } });
    assertEqual(out.status, 400, `用户名「${username}」应 400，实际 ${out.status}`);
    assertIncludes(out.json.error, hint, `错误文案应说明原因：${out.text.slice(0, 160)}`);
  }
  // 缺失与类型错误
  const missing = await call('/api/auth/register', { method: 'POST', body: { password: STRONG } });
  assertEqual(missing.status, 400);
  assertIncludes(missing.json.error, '缺少用户名');
  for (const username of [123, true, {}, [], null]) {
    const out = await call('/api/auth/register', { method: 'POST', body: { username, password: STRONG } });
    assertEqual(out.status, 400, `用户名类型 ${JSON.stringify(username)} 应 400`);
  }
  // user_id 是 username 的别名：两者一致可用，不一致 400
  const alias = await call('/api/auth/register', {
    method: 'POST', body: { user_id: 'alias-user-01', password: STRONG },
  });
  assertEqual(alias.status, 201, alias.text.slice(0, 160));
  assertEqual(alias.json.user.id, 'alias-user-01');
  const mismatch = await call('/api/auth/register', {
    method: 'POST', body: { username: 'mismatch-01', user_id: 'mismatch-02', password: STRONG },
  });
  assertEqual(mismatch.status, 400);
  assertIncludes(mismatch.json.error, '不一致');
  // 不支持未知字段
  const unknown = await call('/api/auth/register', {
    method: 'POST', body: { username: 'unknown-field', password: STRONG, foo: 'bar' },
  });
  assertEqual(unknown.status, 400);
  assertIncludes(unknown.json.error, '不支持的字段');
});

await testAsync('注册：口令复用现有强度校验（弱口令 / 超长 / 类型 400）', async () => {
  const weak = [
    ['Short1A', '长度至少 12 位'],
    ['alllowercase123', '需包含大写字母'],
    ['ALLUPPERCASE123', '需包含小写字母'],
    ['NoDigitsHere!!!', '需包含数字'],
    ['aaaaaaaaaaaa', '不能是单一重复字符'],
  ];
  for (const [password, hint] of weak) {
    const out = await call('/api/auth/register', { method: 'POST', body: { username: 'weak-pass-01', password } });
    assertEqual(out.status, 400, `弱口令「${password}」应 400，实际 ${out.status}`);
    assertIncludes(out.json.error, '口令强度不足');
    assert(Array.isArray(out.json.issues) && out.json.issues.some((i) => i.includes(hint)),
      `issues 应包含「${hint}」，实际 ${JSON.stringify(out.json.issues)}`);
    assertEqual(db.get('SELECT id FROM app_user WHERE id = ?', ['weak-pass-01']), null, '弱口令不得建号');
  }
  const missing = await call('/api/auth/register', { method: 'POST', body: { username: 'weak-pass-02' } });
  assertEqual(missing.status, 400);
  assertIncludes(missing.json.error, '缺少口令');
  const tooLong = await call('/api/auth/register', {
    method: 'POST', body: { username: 'weak-pass-03', password: `A1${'x'.repeat(250)}` },
  });
  assertEqual(tooLong.status, 400);
  assertIncludes(tooLong.json.error, '口令长度不得超过');
  const notString = await call('/api/auth/register', { method: 'POST', body: { username: 'weak-pass-04', password: 123456789012 } });
  assertEqual(notString.status, 400);
  assertIncludes(notString.json.error, '口令必须是字符串');
  // 空请求体
  const empty = await call('/api/auth/register', { method: 'POST', body: {} });
  assertEqual(empty.status, 400);
});

await testAsync('注册：显示名校验（超长 / 控制字符 / 尖括号 / 类型）', async () => {
  const tooLong = await call('/api/auth/register', {
    method: 'POST', body: { username: 'disp-01', password: STRONG, display_name: '名'.repeat(41) },
  });
  assertEqual(tooLong.status, 400);
  assertIncludes(tooLong.json.error, '显示名长度不得超过');
  const control = await call('/api/auth/register', {
    method: 'POST', body: { username: 'disp-02', password: STRONG, display_name: `张三${String.fromCharCode(0)}` },
  });
  assertEqual(control.status, 400);
  assertIncludes(control.json.error, '控制字符');
  const markup = await call('/api/auth/register', {
    method: 'POST', body: { username: 'disp-03', password: STRONG, display_name: '<script>x</script>' },
  });
  assertEqual(markup.status, 400);
  assertIncludes(markup.json.error, '不能包含');
  const notString = await call('/api/auth/register', {
    method: 'POST', body: { username: 'disp-04', password: STRONG, display_name: 123 },
  });
  assertEqual(notString.status, 400);
  assertIncludes(notString.json.error, '显示名必须是字符串');
  for (const u of ['disp-01', 'disp-02', 'disp-03', 'disp-04']) {
    assertEqual(db.get('SELECT id FROM app_user WHERE id = ?', [u]), null, '非法显示名不得建号');
  }
});

await testAsync('注册：v2 未启用时拒绝（503）且不写库', async () => {
  const before = db.get('SELECT COUNT(*) c FROM app_user').c;
  process.env.CCER_ENABLE_V2 = '0';
  let out;
  try {
    out = registration.registerUser({ username: 'v2-off-user', password: STRONG });
  } finally {
    process.env.CCER_ENABLE_V2 = '1';
  }
  assertEqual(out.ok, false);
  assertEqual(out.status, 503, '未启用 v2 时应 503，避免误写未迁移的库');
  assertEqual(db.get('SELECT COUNT(*) c FROM app_user').c, before, '拒绝时不得写入账号');
});

/* ------------------------------------------------------------------ */
/*  3. 后台管理鉴权                                                     */
/* ------------------------------------------------------------------ */

const ADMIN_GET_PATHS = [
  '/api/v2/admin/status',
  '/api/v2/admin/secret-key',
  '/api/v2/admin/datasources',
  '/api/v2/admin/search-providers',
  '/api/v2/admin/fetch-connections',
  '/api/v2/admin/verify-config',
  '/api/v2/admin/verifications',
  '/api/v2/admin/llm',
  '/api/v2/admin/users',
  '/api/v2/admin/logins',
  '/api/v2/admin/audit',
  '/api/v2/admin/exports',
  '/api/v2/admin/reconciliations',
  '/api/v2/admin/gaps',
  '/api/v2/admin/metrics',
  '/api/v2/admin/jobs',
  '/api/v2/admin/dataset-cursors',
  '/api/v2/admin/snapshots',
];

const ADMIN_POST_PATHS = [
  '/api/v2/admin/secret-key/init',
  '/api/v2/admin/datasources',
  '/api/v2/admin/datasources/DS-1/test',
  '/api/v2/admin/datasources/DS-1/pause',
  '/api/v2/admin/rollbacks/RB-1/restore',
  '/api/v2/admin/search-providers',
  '/api/v2/admin/search-providers/SRCH-1/test',
  '/api/v2/admin/search-providers/SRCH-1/pause',
  '/api/v2/admin/fetch-connections',
  '/api/v2/admin/fetch-connections/FC-1/test',
  '/api/v2/admin/fetch-connections/FC-1/pause',
  '/api/v2/admin/verify-config',
  '/api/v2/admin/verify-rules/RULE-1',
  '/api/v2/admin/verify/run',
  '/api/v2/admin/llm',
  '/api/v2/admin/llm/LLM-1/test',
  '/api/v2/admin/users',
  '/api/v2/admin/users/user-admin/password',
  '/api/v2/admin/checks/run',
  '/api/v2/admin/gaps/GAP-1',
  '/api/v2/admin/metrics/some_metric',
  '/api/v2/admin/daily',
];

await testAsync('后台管理：新注册的普通用户访问 /api/v2/admin/* 一律 403', async () => {
  assert(viewerToken, '需要普通用户会话');
  for (const p of ADMIN_GET_PATHS) {
    const out = await call(p, { token: viewerToken });
    assertEqual(out.status, 403, `GET ${p} 应 403，实际 ${out.status}：${out.text.slice(0, 120)}`);
    assertIncludes(out.json.error, '权限', `GET ${p} 应说明无权限`);
  }
  for (const p of ADMIN_POST_PATHS) {
    const out = await call(p, { method: 'POST', body: {}, token: viewerToken });
    assertEqual(out.status, 403, `POST ${p} 应 403，实际 ${out.status}：${out.text.slice(0, 120)}`);
  }
  // 未认证仍然 401（不是 403）
  const anon = await call('/api/v2/admin/users');
  assertEqual(anon.status, 401);
});

await testAsync('后台管理：普通用户的写调用不产生任何数据变更', async () => {
  const before = db.get('SELECT COUNT(*) c FROM app_user').c;
  const out = await call('/api/v2/admin/users', {
    method: 'POST', token: viewerToken,
    body: { id: 'injected-admin', name: '注入管理员', role: 'admin', team_id: 'team-carbon' },
  });
  assertEqual(out.status, 403, '普通用户不得创建账号');
  assertEqual(db.get('SELECT id FROM app_user WHERE id = ?', ['injected-admin']), null, '不得写入提权账号');
  const key = await call('/api/v2/admin/secret-key/init', { method: 'POST', body: {}, token: viewerToken });
  assertEqual(key.status, 403, '普通用户不得初始化主密钥');
  assertEqual(db.get('SELECT COUNT(*) c FROM app_user').c, before, '账号数量不得变化');
});

await testAsync('后台管理：路由表中每条在役 /api/v2/admin/* 都有服务端角色判定', async () => {
  const adminRoutes = routes.V2_ROUTES.filter(([, p]) => p.startsWith('/api/v2/admin/'));
  assert(adminRoutes.length >= 30, `后台路由数量异常：${adminRoutes.length}`);
  const makeCtx = (role) => ({
    user: { id: `u-${role}`, name: role, role, team_id: 'team-other' },
    req: { headers: {} }, query: {}, params: {}, body: {},
  });
  let guarded = 0;
  const retiredPaths = new Set();
  for (const [method, p, handler] of adminRoutes) {
    assert(typeof handler === 'function', `${method} ${p} 应有处理函数（不能是空壳）`);
    for (const role of ['viewer', 'analyst', 'researcher', 'reviewer']) {
      const out = await handler(makeCtx(role));
      const status = out && typeof out.status === 'number' ? out.status : out?.error ? 400 : 200;
      if (status === 410) {
        // 停用路由对任何角色都只回 410，不进入角色判定，也不暴露任何功能
        retiredPaths.add(`${method} ${p}`);
        continue;
      }
      assertEqual(status, 403, `${method} ${p} 对 ${role} 应 403，实际 ${status}`);
      assertIncludes(out.body?.error || '', '权限', `${method} ${p} 应返回权限错误`);
      guarded += 1;
    }
  }
  assert(guarded >= 120, `应有足够多的「角色 → 403」判定，实际 ${guarded}`);
  assert(retiredPaths.size >= 3, `应保留停用路由的 410 语义，实际 ${retiredPaths.size}`);
});

await testAsync('后台管理：仅 admin 可进入，已停用路由对普通用户为 410', async () => {
  const find = (method, p) => routes.V2_ROUTES.find(([m, rp]) => m === method && rp === p);
  const getStatus = find('GET', '/api/v2/admin/status');
  assert(getStatus, '应有 GET /api/v2/admin/status');
  for (const role of ['admin']) {
    const out = await getStatus[2]({
      user: { id: `u-${role}`, name: role, role, team_id: 'team-carbon' },
      req: { headers: {} }, query: {}, params: {}, body: {},
    });
    const status = out && typeof out.status === 'number' ? out.status : 200;
    assertEqual(status, 200, `${role} 应可访问后台状态，实际 ${status}`);
  }
  const researcherOut = await getStatus[2]({
    user: { id: 'u-researcher', name: 'researcher', role: 'researcher', team_id: 'team-carbon' },
    req: { headers: {} }, query: {}, params: {}, body: {},
  });
  assertEqual(researcherOut.status, 403, 'researcher 不得访问后台状态');
  // 已停用的后台入口对普通用户仍为 410（不是 403，也不是可用）
  const retiredOut = await call('/api/v2/admin/reviews', { token: viewerToken });
  assertEqual(retiredOut.status, 410, '停用路由对普通用户应保持 410');
  assertEqual(retiredOut.json.retired, true);
  // 角色枚举未被放宽
  assertEqual(routes.ADMIN_AREA_ROLES.join(','), 'admin');
});

server.close();
finish('test/25-v2-registration-and-admin-guard.test.mjs');
