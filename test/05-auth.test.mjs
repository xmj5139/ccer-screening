/**
 * 测试 5：身份认证与会话（服务端会话取代客户端自报身份）
 * ============================================================================
 * 覆盖范围：
 *   1) 登录：正确口令签发令牌；错误口令 / 未知用户 → 401；响应绝不回传口令
 *   2) 会话解析：有效 → 用户行；过期 → null；未知令牌 → null；已撤销 → null
 *   3) 跨团队越权矩阵（两个真实账号）：
 *        analyst（team-invest）vs researcher（team-carbon）
 *        读取对方项目 / 证据 / 运行记录 / 导出对方报告 → 403；本方 → 200
 *   4) 管理员专属接口对非管理员一律 403（门禁切换、会话列表、会话撤销）
 *   5) 【回归】session 模式下，不带令牌仅带 x-user-id: user-admin **不得**获得管理员权限
 *   6) 注销后令牌立即失效
 *
 * 约定与 test/01~04 一致：node:test + node:assert/strict + test/helpers.mjs 的
 * setup()/teardown()（CCER_DB_PATH 指向临时目录，不污染演示库）。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, teardown } from './helpers.mjs';

let M;
let auth;
let users;
let serverMod;
let base = '';

/** 断言计数：Node 内置 node:test 不统计断言次数，这里自行计数以便核对覆盖强度 */
let assertions = 0;
const A = {
  ok: (...args) => { assertions += 1; return assert.ok(...args); },
  equal: (...args) => { assertions += 1; return assert.equal(...args); },
  notEqual: (...args) => { assertions += 1; return assert.notEqual(...args); },
  deepEqual: (...args) => { assertions += 1; return assert.deepEqual(...args); },
  match: (...args) => { assertions += 1; return assert.match(...args); },
  rejects: async (...args) => { assertions += 1; return assert.rejects(...args); },
};

/** 会话 TTL 用尽后，亲手把 expires_at 改到过去，模拟自然过期 */
function expireSessionByToken(token) {
  M.db.run('UPDATE user_session SET expires_at = ? WHERE token_hash = ?', [
    new Date(Date.now() - 60 * 1000).toISOString(),
    auth.hashToken(token),
  ]);
}

async function http(path, { method = 'GET', token = null, headers = {}, body = null } = {}) {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  if (body !== null) h['content-type'] = 'application/json';
  const res = await fetch(`${base}${path}`, {
    method,
    headers: h,
    body: body === null ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { status: res.status, data, headers: res.headers };
}

/* ========================================================================== */

before(async () => {
  M = await setup();
  users = await import('../src/data/users.mjs');
  auth = await import('../src/services/auth-svc.mjs');

  // 认证模式必须默认落在 session（生产模式）
  delete process.env.CCER_AUTH_MODE;
  auth.resetAuthModeCache();
  A.equal(auth.authMode(true), 'session', 'auth_mode 默认必须是 session');
  A.equal(M.db.metaValue('auth_mode', null), 'session', 'system_meta.auth_mode 必须种入 session');

  // 起一个端口为 0 的临时实例，验证真实 HTTP 行为
  serverMod = await import('../src/server.mjs');
  await new Promise((resolve) => serverMod.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${serverMod.server.address().port}`;
});

after(async () => {
  try {
    await new Promise((resolve) => serverMod.server.close(resolve));
  } catch { /* ignore */ }
  teardown();
  console.log(`\n[test/05-auth] 断言总数：${assertions}`);
});

/* ============================ 1. 登录 ============================ */

test('登录：正确口令签发令牌；错误口令与未知用户一律 401；响应不回传口令', async () => {
  const good = await http('/api/auth/login', {
    method: 'POST',
    body: { user_id: 'user-analyst', password: 'analyst-demo-2026' },
  });
  A.equal(good.status, 200, `正确口令应登录成功，实际 ${good.status}`);
  A.ok(good.data.token && good.data.token.length >= 32, '必须返回令牌');
  A.ok(good.data.expires_at, '必须返回过期时间');
  A.equal(good.data.user.id, 'user-analyst');
  A.equal(good.data.user.role, 'analyst');
  A.equal(good.data.user.team_id, 'team-invest');
  A.ok(!('demo_passphrase' in good.data.user), '响应不得包含口令字段');
  A.ok(!JSON.stringify(good.data).includes('analyst-demo-2026'), '响应体不得回显明文口令');

  // Cookie 属性：HttpOnly + SameSite=Strict + Path=/
  const cookie = good.headers.get('set-cookie') || '';
  A.match(cookie, /ccer_session=/);
  A.match(cookie, /HttpOnly/i);
  A.match(cookie, /SameSite=Strict/i);
  A.match(cookie, /Path=\//i);
  // 令牌只承载在会话 Cookie 中（禁止出现 ?token= 这类查询参数形式的传输）
  A.ok(!/ccer_session=[^;]*[?&]token=/.test(cookie), '令牌不得作为查询参数传递');

  // 明确验证：会话令牌不接受查询参数传输（只有 Authorization 头 / Cookie 两种途径）
  const viaQueryToken = await http(`/api/auth/me?token=${encodeURIComponent(good.data.token)}`);
  A.equal(viaQueryToken.status, 401, '令牌不得通过查询参数传递');

  // 库中只有摘要，绝不落盘明文令牌
  const rows = M.db.all('SELECT token_hash FROM user_session', []);
  A.ok(rows.length >= 1);
  A.ok(M.db.get('SELECT id FROM user_session WHERE token_hash = ?', [good.data.token]) === null,
    '库中不得以明文令牌作为 token_hash');
  A.ok(M.db.get('SELECT id FROM user_session WHERE token_hash = ?', [auth.hashToken(good.data.token)]) !== null,
    '库中应保存令牌的 SHA-256 摘要');

  const wrong = await http('/api/auth/login', {
    method: 'POST', body: { user_id: 'user-analyst', password: '错误口令' },
  });
  A.equal(wrong.status, 401, '错误口令必须是 401');

  const unknown = await http('/api/auth/login', {
    method: 'POST', body: { user_id: 'user-nobody', password: 'x' },
  });
  A.equal(unknown.status, 401, '未知用户必须是 401');

  const empty = await http('/api/auth/login', { method: 'POST', body: { user_id: 'user-analyst' } });
  A.equal(empty.status, 401, '缺少口令不得登录');

  // 登录失败不应签发任何会话
  const before = auth.countSessions();
  await http('/api/auth/login', { method: 'POST', body: { user_id: 'user-admin', password: 'nope' } });
  A.equal(auth.countSessions(), before, '登录失败不得产生会话记录');

  // 名册对外不暴露口令
  for (const u of users.publicUserList()) {
    A.ok(!('demo_passphrase' in u), `名册条目 ${u.id} 不得包含口令`);
  }
});

/* ====================== 2. 会话解析与生命周期 ====================== */

test('会话解析：有效返回用户；未知 / 过期 / 已撤销一律 null', async () => {
  const s = auth.createSession('user-reviewer', { ip: '127.0.0.1', ttlMs: 60_000 });
  const u = auth.resolveSession(s.token);
  A.ok(u, '有效令牌必须解析出会话');
  A.equal(u.id, 'user-reviewer');
  A.equal(u.role, 'reviewer');
  A.equal(u.team_id, 'team-carbon');
  A.ok(u.session_id && u.session_expires_at, '应带出会话元信息');

  A.equal(auth.resolveSession('this-token-does-not-exist'), null, '未知令牌必须返回 null');
  A.equal(auth.resolveSession(null), null, '空令牌必须返回 null');
  A.equal(auth.resolveSession(''), null, '空字符串必须返回 null');

  // 过期
  const exp = auth.createSession('user-analyst', { ttlMs: 60_000 });
  A.ok(auth.resolveSession(exp.token), '过期前应有效');
  expireSessionByToken(exp.token);
  A.equal(auth.resolveSession(exp.token), null, '过期会话必须返回 null');

  // 撤销
  const rev = auth.createSession('user-analyst', { ttlMs: 60_000 });
  A.ok(auth.resolveSession(rev.token));
  A.equal(auth.destroySession(rev.token, { silent: true }), true, '注销应返回 true');
  A.equal(auth.resolveSession(rev.token), null, '已撤销会话必须返回 null');
  A.equal(auth.resolveSession(auth.hashToken(rev.token)), null, '以摘要形式查询也必须判定为已撤销');
  A.equal(auth.destroySession(rev.token, { silent: true }), false, '重复注销应为 false（幂等）');

  // 门禁模式列表：只给活跃会话，且绝不返回 token_hash
  const adminView = auth.listSessions({ role: 'admin' });
  A.ok(Array.isArray(adminView));
  for (const row of adminView) {
    A.ok(!('token_hash' in row), '会话列表不得返回 token_hash');
    A.equal(row.revoked_at, null);
  }
  const denied = auth.listSessions({ role: 'analyst' });
  A.equal(denied.status, 403, '非管理员不得列出会话');

  // 管理员撤销 + 过期清理
  const target = auth.createSession('user-other', { ttlMs: 60_000 });
  const revokedRow = M.db.get('SELECT id FROM user_session WHERE token_hash = ?', [auth.hashToken(target.token)]);
  const out = auth.revokeSessionById(revokedRow.id, { name: '系统管理员', role: 'admin' });
  A.equal(out.ok, true);
  A.equal(auth.resolveSession(target.token), null, '被管理员撤销的会话必须立即失效');
  A.equal(auth.revokeSessionById('SES-not-exist', { name: 'x', role: 'admin' }).status, 404);

  const exp2 = auth.createSession('user-other', { ttlMs: 60_000 });
  expireSessionByToken(exp2.token);
  const purged = auth.purgeExpiredSessions();
  A.ok(purged.expired >= 1, '过期清理应删除至少一条过期会话');
  A.equal(M.db.get('SELECT id FROM user_session WHERE token_hash = ?', [auth.hashToken(exp2.token)]), null);
});

/* ==================== 3. 跨团队越权矩阵（真实 HTTP） ==================== */

test('越权矩阵：analyst(team-invest) 与 researcher(team-carbon) 互访一律 403，本方 200', async () => {
  const analystLogin = await http('/api/auth/login', {
    method: 'POST', body: { user_id: 'user-analyst', password: 'analyst-demo-2026' },
  });
  const researcherLogin = await http('/api/auth/login', {
    method: 'POST', body: { user_id: 'user-researcher', password: 'researcher-demo-2026' },
  });
  A.equal(analystLogin.status, 200);
  A.equal(researcherLogin.status, 200);
  const analystToken = analystLogin.data.token;
  const researcherToken = researcherLogin.data.token;

  // 两名真实账号分属不同团队（越权矩阵的前提）
  A.equal(analystLogin.data.user.team_id, 'team-invest');
  A.equal(researcherLogin.data.user.team_id, 'team-carbon');
  A.notEqual(analystLogin.data.user.team_id, researcherLogin.data.user.team_id);

  const ANALYST_USER = { id: 'user-analyst', name: '投资分析师', role: 'analyst', team_id: 'team-invest' };
  const RESEARCHER_USER = { id: 'user-researcher', name: '政策研究员', role: 'researcher', team_id: 'team-carbon' };

  // 两个真实项目：一个属 team-carbon（研究员的本方），一个属 team-invest（分析师的本方）
  const ownOfResearcher = M.projects.createProject(RESEARCHER_USER, {
    code: 'AUTH-MATRIX-CARBON', name: '越权矩阵用 team-carbon 项目', confidentiality: 'internal',
  });
  const ownOfAnalyst = M.projects.createProject(ANALYST_USER, {
    code: 'AUTH-MATRIX-INVEST', name: '越权矩阵用 team-invest 项目', confidentiality: 'internal',
  });
  A.equal(ownOfResearcher.team_id, 'team-carbon');
  A.equal(ownOfAnalyst.team_id, 'team-invest');

  // 证据：对方项目内放一条受限证据（仅研究员/复核人/管理员可见）
  const evidenceId = M.db.run(
    `INSERT INTO project_evidence (id,project_id,file_name,file_hash,doc_type,page,line_ref,excerpt,
       uploaded_by,uploaded_at,confidentiality,retention_note)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ['EVD-MATRIX-1', ownOfResearcher.id, '受限证据_越权矩阵.pdf', null, '公示截图', 1, null,
      '越权矩阵测试用受限证据', '政策研究员', new Date().toISOString(), 'restricted', null]
  );
  A.ok(evidenceId);

  // 研究员在自己项目上先跑一次匹配，形成可被越权读取的运行记录
  const match = M.projects.saveMatchRun(RESEARCHER_USER, ownOfResearcher.id, '2026-09-24',
    { candidates: [], observations: [], excluded: [] });
  A.ok(match);

  const cases = [
    ['读取对方项目档案', (t, pid) => http(`/api/projects/${pid}`, { token: t })],
    ['读取对方项目事实', (t, pid) => http(`/api/projects/${pid}/facts`, { token: t })],
    ['读取对方运行记录', (t, pid) => http(`/api/projects/${pid}/runs`, { token: t })],
    ['读取对方计算运行清单', (t, pid) => http(`/api/projects/${pid}/calculations`, { token: t })],
    ['读取对方报告清单', (t, pid) => http(`/api/projects/${pid}/reports`, { token: t })],
    ['读取对方条件检查', (t, pid) => http(`/api/projects/${pid}/eligibility`, { token: t })],
  ];

  for (const [label, call] of cases) {
    const denied = await call(analystToken, ownOfResearcher.id);
    A.equal(denied.status, 403, `[${label}] 分析师访问 team-carbon 项目应 403，实际 ${denied.status}`);
    const allowed = await call(researcherToken, ownOfResearcher.id);
    A.equal(allowed.status, 200, `[${label}] 研究员访问本方项目应 200，实际 ${allowed.status}`);
  }

  // 反向：研究员访问 team-invest 项目应 403；分析师访问本方应 200
  const deniedReverse = await http(`/api/projects/${ownOfAnalyst.id}`, { token: researcherToken });
  A.equal(deniedReverse.status, 403, '研究员访问 team-invest 项目应 403');
  const allowedOwn = await http(`/api/projects/${ownOfAnalyst.id}`, { token: analystToken });
  A.equal(allowedOwn.status, 200, '分析师访问本方项目应 200');

  // 证据可见性：受限证据研究员可见、分析师连项目都进不去（403）
  const researcherView = await http(`/api/projects/${ownOfResearcher.id}`, { token: researcherToken });
  A.ok(researcherView.data.evidence.some((e) => e.id === 'EVD-MATRIX-1'), '研究员应能看到本方受限证据');
  A.equal(researcherView.data.evidence_hidden, 0);
  const analystEvidence = await http(`/api/projects/${ownOfResearcher.id}`, { token: analystToken });
  A.equal(analystEvidence.status, 403, '分析师不得读取对方项目证据');
  A.equal(analystEvidence.data.evidence, undefined, '403 响应不得夹带证据数据');

  // 报告导出：以研究员身份生成报告，分析师导出必须 403，研究员导出 200
  const rep = M.reports.generateReport(RESEARCHER_USER, ownOfResearcher.id, { analysisBaseDate: '2026-09-24' });
  A.ok(rep.report_id, '应能生成报告用于越权测试');

  const exportDenied = await http(`/api/reports/${rep.report_id}/export?format=markdown`, { token: analystToken });
  A.equal(exportDenied.status, 403, '导出对方团队报告应 403');
  A.match(String(exportDenied.data.error || ''), /无权导出/);

  const exportOwn = await http(`/api/reports/${rep.report_id}/export?format=markdown`, { token: researcherToken });
  A.equal(exportOwn.status, 200, '导出本方报告应 200');

  // 项目列表：各自只能看到本团队（或 public）项目
  const analystList = await http('/api/projects', { token: analystToken });
  const researcherList = await http('/api/projects', { token: researcherToken });
  A.equal(analystList.status, 200);
  A.equal(researcherList.status, 200);
  A.ok(analystList.data.projects.every((p) => p.team_id === 'team-invest' || p.confidentiality === 'public'),
    '分析师不得在列表里看到其他团队的非公开项目');
  A.ok(!analystList.data.projects.some((p) => p.id === ownOfResearcher.id), '对方项目不得出现在列表里');
  A.ok(researcherList.data.projects.some((p) => p.id === ownOfResearcher.id), '研究员列表应含本方项目');
  A.ok(!researcherList.data.projects.some((p) => p.id === ownOfAnalyst.id), '本方列表不得含对方项目');

  // 审计日志属受控接口：viewer 403、researcher 200
  const viewerLogin = await http('/api/auth/login', {
    method: 'POST', body: { user_id: 'user-other', password: 'viewer-demo-2026' },
  });
  A.equal(viewerLogin.status, 200);
  const viewerAudit = await http('/api/audit', { token: viewerLogin.data.token });
  A.equal(viewerAudit.status, 403, '只读用户不得查看审计日志');
  const researcherAudit = await http('/api/audit', { token: researcherToken });
  A.equal(researcherAudit.status, 200, '政策研究员可查看审计日志');

  // 清理本次会话，避免影响后续用例
  for (const t of [analystToken, researcherToken, viewerLogin.data.token]) {
    auth.destroySession(t, { silent: true });
  }
});

/* ==================== 4. 管理员专属接口 ==================== */

test('管理员专属接口：非管理员访问门禁切换与会话管理一律 403', async () => {
  const analyst = (await http('/api/auth/login', {
    method: 'POST', body: { user_id: 'user-analyst', password: 'analyst-demo-2026' },
  })).data.token;
  const admin = (await http('/api/auth/login', {
    method: 'POST', body: { user_id: 'user-admin', password: 'admin-demo-2026' },
  })).data.token;
  A.ok(analyst && admin);

  const gateDenied = await http('/api/admin/demo-channel', {
    method: 'POST', token: analyst, body: { enabled: true },
  });
  A.equal(gateDenied.status, 403, '非管理员不得切换演示通道（计算门禁）');

  const listDenied = await http('/api/admin/sessions', { token: analyst });
  A.equal(listDenied.status, 403, '非管理员不得查看会话列表');

  const listOk = await http('/api/admin/sessions', { token: admin });
  A.equal(listOk.status, 200, '管理员应能查看会话列表');
  A.ok(Array.isArray(listOk.data.sessions) && listOk.data.sessions.length >= 1);
  for (const row of listOk.data.sessions) {
    A.ok(!('token_hash' in row), '会话列表接口不得返回 token_hash');
    A.ok(row.user_id && row.created_at && row.expires_at, '会话列表应包含基本字段');
  }

  // 管理员撤销一个真实会话后，该令牌立即失效
  const victim = auth.createSession('user-other', { ttlMs: 60_000 });
  const victimId = M.db.get('SELECT id FROM user_session WHERE token_hash = ?', [auth.hashToken(victim.token)]).id;
  const revokeDenied = await http(`/api/admin/sessions/${victimId}`, { method: 'DELETE', token: analyst });
  A.equal(revokeDenied.status, 403, '非管理员不得撤销会话');
  A.ok(auth.resolveSession(victim.token), '被拒绝的撤销请求不得影响目标会话');

  const revokeOk = await http(`/api/admin/sessions/${victimId}`, { method: 'DELETE', token: admin });
  A.equal(revokeOk.status, 200, '管理员撤销会话应成功');
  A.equal(auth.resolveSession(victim.token), null, '被撤销会话的令牌必须立即失效');

  for (const t of [analyst, admin]) auth.destroySession(t, { silent: true });
});

/* ============ 5. 【回归】客户端自报身份不得再获得管理员权限 ============ */

test('回归（原始漏洞）：session 模式下不带令牌仅带 x-user-id: user-admin 不得获得管理员权限', async () => {
  delete process.env.CCER_AUTH_MODE;
  auth.resetAuthModeCache();
  A.equal(auth.authMode(true), 'session');

  // 旧漏洞的利用方式：请求头自报管理员
  const viaHeader = await http('/api/audit', { headers: { 'x-user-id': 'user-admin' } });
  A.equal(viaHeader.status, 401, '仅带 x-user-id 头必须 401，不得放行');
  A.match(String(viaHeader.data.error || ''), /未认证/);
  A.equal(viaHeader.data.user, undefined);
  A.ok(!Array.isArray(viaHeader.data.audit), '不得返回任何审计数据');

  // 旧漏洞的第二种利用方式：查询参数自报管理员
  const viaQuery = await http('/api/audit?user=user-admin');
  A.equal(viaQuery.status, 401, '仅带 ?user=user-admin 必须 401，不得放行');

  // 管理员专属写操作同样不得被自报身份绕过
  const gateViaHeader = await http('/api/admin/demo-channel', {
    method: 'POST', headers: { 'x-user-id': 'user-admin' }, body: { enabled: true },
  });
  A.equal(gateViaHeader.status, 401, '自报身份不得切换演示通道（计算门禁）');
  const sessionsViaHeader = await http('/api/admin/sessions', { headers: { 'x-user-id': 'user-admin' } });
  A.equal(sessionsViaHeader.status, 401, '自报身份不得读取会话列表');

  // 即使携带一个「已注销」的令牌，也不能靠 x-user-id 头「升级」为管理员
  const dead = auth.createSession('user-analyst', { ttlMs: 60_000 });
  auth.destroySession(dead.token, { silent: true });
  const deadPlusHeader = await http('/api/dashboard', {
    token: dead.token, headers: { 'x-user-id': 'user-admin' },
  });
  A.equal(deadPlusHeader.status, 401, '失效令牌 + 自报管理员必须 401');

  // 有效令牌 + 自报管理员：身份以会话为准（分析师仍是分析师）
  const analyst = (await http('/api/auth/login', {
    method: 'POST', body: { user_id: 'user-analyst', password: 'analyst-demo-2026' },
  })).data.token;
  const me = await http('/api/auth/me', { token: analyst, headers: { 'x-user-id': 'user-admin' } });
  A.equal(me.status, 200);
  A.equal(me.data.user.id, 'user-analyst', '身份必须来自会话，而不是自报请求头');
  A.equal(me.data.user.role, 'analyst');
  A.equal(me.data.auth_mode, 'session');

  const auditAsAnalyst = await http('/api/audit', { token: analyst, headers: { 'x-user-id': 'user-admin' } });
  A.equal(auditAsAnalyst.status, 403, '分析师带管理员头仍应 403');

  auth.destroySession(analyst, { silent: true });
});

/* ==================== 6. 白名单与静态资源 ==================== */

test('白名单：/api/health 与 /api/auth/login 免会话；其余 /api/* 一律 401；静态资源可访问', async () => {
  const health = await http('/api/health');
  A.equal(health.status, 200);
  A.equal(health.data.auth_mode, 'session', '健康检查须暴露 auth_mode');
  A.ok(health.data.ok === true);

  const index = await http('/');
  A.equal(index.status, 200, 'GET / 无需会话');
  A.match(String(index.data.raw || ''), /<html/i);

  const appJs = await http('/app.js');
  A.equal(appJs.status, 200, '静态资源无需会话');

  const protectedRoutes = [
    ['/api/dashboard', 'GET'],
    ['/api/projects', 'GET'],
    ['/api/methodologies', 'GET'],
    ['/api/audit', 'GET'],
    ['/api/alerts', 'GET'],
    ['/api/meta/fact-fields', 'GET'],
    ['/api/admin/plugins', 'GET'],
    ['/api/admin/sessions', 'GET'],
    ['/api/auth/me', 'GET'],
    ['/api/auth/logout', 'POST'],
  ];
  for (const [path, method] of protectedRoutes) {
    const res = await http(path, { method, body: method === 'POST' ? {} : null });
    A.equal(res.status, 401, `${method} ${path} 无会话必须 401，实际 ${res.status}`);
  }
});

/* ==================== 7. 注销后令牌失效 ==================== */

test('注销：令牌立即失效，且 logout 需要认证', async () => {
  const login = await http('/api/auth/login', {
    method: 'POST', body: { user_id: 'user-reviewer', password: 'reviewer-demo-2026' },
  });
  const token = login.data.token;
  A.equal((await http('/api/auth/me', { token })).status, 200);

  const out = await http('/api/auth/logout', { method: 'POST', token, body: {} });
  A.equal(out.status, 200);
  A.equal(out.data.revoked, true);
  A.match(out.headers.get('set-cookie') || '', /Max-Age=0/, '注销必须清除 Cookie');

  const after = await http('/api/auth/me', { token });
  A.equal(after.status, 401, '注销后令牌必须失效（401）');
  const reused = await http('/api/projects', { token });
  A.equal(reused.status, 401, '注销后令牌不得再访问任何业务接口');

  // 无会话调用 logout → 401（不泄露任何信息）
  const anonLogout = await http('/api/auth/logout', { method: 'POST', body: {} });
  A.equal(anonLogout.status, 401);
});

/* ==================== 8. dev 模式（显式开启）==================== */

test('dev 模式：必须显式开启；与 CCER_ALLOW_REMOTE=1 组合时拒绝启动', async () => {
  // (a) 与允许远程访问组合 → 启动期策略必须报错，且错误信息可读
  process.env.CCER_AUTH_MODE = 'dev';
  process.env.CCER_ALLOW_REMOTE = '1';
  auth.resetAuthModeCache();
  try {
    await A.rejects(
      async () => auth.enforceStartupPolicy(process.env),
      /dev 模式|冲突/,
      'dev 模式 + CCER_ALLOW_REMOTE=1 必须拒绝启动'
    );
  } finally {
    delete process.env.CCER_ALLOW_REMOTE;
  }

  // (b) 仅 dev 模式：打印醒目多行警告横幅，并允许旧的 x-user-id 行为（供本地演示）
  A.equal(auth.authMode(true), 'dev');
  const banner = auth.authStartupBanner('dev');
  A.ok(banner.length >= 6, 'dev 模式启动横幅必须为多行');
  A.ok(banner.join('\n').includes('认证已被关闭'), '横幅必须明确说明认证已关闭');
  A.ok(banner.join('\n').includes('禁止部署到内网'), '横幅必须警告不得暴露到内网');
  A.ok(auth.authStartupBanner('session').join('\n').includes('身份只来自服务端会话'));

  const viaHeader = await http('/api/audit', { headers: { 'x-user-id': 'user-admin' } });
  A.equal(viaHeader.status, 200, 'dev 模式下允许旧的 x-user-id 直连行为（仅本地演示）');
  A.ok(Array.isArray(viaHeader.data.audit), 'dev 模式应直接返回审计数据');
  const me = await http('/api/auth/me', { headers: { 'x-user-id': 'user-admin' } });
  A.equal(me.data.auth_mode, 'dev');
  A.equal(me.data.dev_mode, true, 'dev 模式必须向前端显式声明，界面据此展示「不安全」标记');
  A.equal(me.data.user.role, 'admin');
  A.equal(me.data.session.source, 'dev_header');

  // dev 模式下的身份切换口子：自报身份优先于会话，且 x-user-id 与 ?user= 都可用
  const devSession = (await http('/api/auth/login', {
    method: 'POST', body: { user_id: 'user-analyst', password: 'analyst-demo-2026' },
  })).data.token;
  const switched = await http('/api/auth/me', {
    token: devSession, headers: { 'x-user-id': 'user-reviewer' },
  });
  A.equal(switched.data.user.id, 'user-reviewer', 'dev 模式下自报身份优先于会话身份');
  A.equal(switched.data.session.source, 'dev_header');
  const switchedByQuery = await http('/api/auth/me?user=user-admin', { token: devSession });
  A.equal(switchedByQuery.data.user.id, 'user-admin', 'dev 模式下 ?user= 同样生效');
  auth.destroySession(devSession, { silent: true });

  // 恢复生产默认：撤销 dev 覆盖后，自报身份立刻失效
  delete process.env.CCER_AUTH_MODE;
  auth.resetAuthModeCache();
  A.equal(auth.authMode(true), 'session');
  const blocked = await http('/api/audit', { headers: { 'x-user-id': 'user-admin' } });
  A.equal(blocked.status, 401, '恢复 session 模式后自报身份必须立即失效');
});
