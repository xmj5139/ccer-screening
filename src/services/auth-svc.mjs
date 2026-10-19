/**
 * 身份认证与会话服务（零第三方依赖，仅用 Node 内置模块）
 * ============================================================================
 * 职责：
 *   1. 建立服务端会话（登录）：令牌由 crypto.randomBytes(32) 生成，
 *      **数据库只保存令牌的 SHA-256 摘要**，明文令牌只在登录响应里返回一次。
 *   2. 解析会话：Authorization: Bearer <token> 优先，其次 Cookie ccer_session。
 *   3. 注销、管理员撤销、过期清理与管理员会话列表。
 *   4. 认证模式（auth_mode）的解析与启动期安全策略。
 *
 * 认证模式：
 *   - session（默认，生产）：身份**只**来自会话；请求头 x-user-id 与查询参数 user
 *     被完全忽略（不报错、也不记录）。
 *   - dev（必须显式开启，仅本地演示）：允许旧的 x-user-id / ?user= 直连行为。
 *     与 CCER_ALLOW_REMOTE=1 同时出现且未经显式设置时，服务拒绝启动。
 *
 * 正式部署：本模块的口令校验环节必须替换为机构统一身份认证（SSO/OIDC/LDAP）。
 */
import { createHash, randomBytes } from 'node:crypto';
import { all, get, run, metaValue, audit, getDb } from '../core/db.mjs';
import { newId, nowIso } from '../core/util.mjs';
import { verifyDemoPassphrase } from '../data/users.mjs';
import { verifyPassword } from '../core/password.mjs';

/** 会话默认有效期：12 小时 */
export const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;

/** 会话 Cookie 名 / 令牌传输方式（令牌禁止出现在查询参数中） */
export const COOKIE_NAME = 'ccer_session';

/** 活跃会话的最小刷新间隔：避免每个请求都写一次 last_seen_at */
const LAST_SEEN_REFRESH_MS = 60 * 1000;

/** 允许的认证模式 */
export const AUTH_MODES = ['session', 'dev'];

/** 系统元数据键名 */
const META_KEY = 'auth_mode';

let cachedMode = null;

/* ------------------------------ 认证模式 ------------------------------ */

/**
 * 当前生效的认证模式。
 * 优先级：环境变量 CCER_AUTH_MODE（显式覆盖）> 系统元数据 auth_mode > 'session'。
 * @param {boolean} force 忽略缓存重新读取
 * @returns {'session'|'dev'}
 */
export function authMode(force = false) {
  if (!force && cachedMode) return cachedMode;

  const envRaw = String(process.env.CCER_AUTH_MODE || '').trim().toLowerCase();
  if (AUTH_MODES.includes(envRaw)) {
    cachedMode = envRaw;
    return cachedMode;
  }

  let meta = null;
  try {
    meta = metaValue(META_KEY, null);
  } catch {
    // 库尚未建表时（例如极早期启动路径）回落到默认值
    meta = null;
  }
  const metaRaw = String(meta || '').trim().toLowerCase();
  cachedMode = AUTH_MODES.includes(metaRaw) ? metaRaw : 'session';
  return cachedMode;
}

/** 模式来源，便于运维排查：environment | system_meta | default */
export function authModeSource() {
  const envRaw = String(process.env.CCER_AUTH_MODE || '').trim().toLowerCase();
  if (AUTH_MODES.includes(envRaw)) return 'environment';
  const metaRaw = String(metaValue(META_KEY, '') || '').trim().toLowerCase();
  if (AUTH_MODES.includes(metaRaw)) return 'system_meta';
  return 'default';
}

/** 中文标签，供界面与日志使用 */
export function authModeLabel(mode = authMode()) {
  return mode === 'dev' ? 'dev（演示模式：认证已关闭）' : 'session（服务端会话，生产模式）';
}

/** 清空模式缓存（测试或运行期切换环境变量后调用） */
export function resetAuthModeCache() {
  cachedMode = null;
}

/**
 * 启动期安全策略：拒绝「dev 模式 + 允许远程访问」这一危险组合。
 * dev 模式关闭了认证，一旦允许非回环访问，任何能访问该端口的人都能冒充任意身份。
 * @returns {{ mode:string, source:string }} 通过时返回当前模式
 * @throws {Error} 组合不合法时抛出，由启动入口打印明确错误并退出
 */
export function enforceStartupPolicy(env = process.env) {
  const mode = authMode(true);
  const source = authModeSource();
  const allowRemote = String(env.CCER_ALLOW_REMOTE || '') === '1';
  if (mode === 'dev' && allowRemote) {
    throw new Error(
      '认证配置冲突：dev 模式会关闭全部身份认证，不得与 CCER_ALLOW_REMOTE=1（允许非回环访问）同时使用。\n' +
      '  · 本地演示：请去掉 CCER_ALLOW_REMOTE=1，仅通过 127.0.0.1 访问；\n' +
      '  · 内网部署：必须使用 session 模式（auth_mode=session，即默认值），并接入机构统一身份认证；\n' +
      `  · 当前来源：auth_mode 来自 ${source}。`
    );
  }
  return { mode, source };
}

/**
 * 启动横幅。dev 模式下列印醒目的多行警告。
 * @param {string} mode
 * @returns {string[]} 逐行打印的文本
 */
export function authStartupBanner(mode = authMode()) {
  if (mode === 'dev') {
    return [
      '',
      '  ############################################################',
      '  #  警告：认证已被关闭（auth_mode = dev，演示模式）         #',
      '  ############################################################',
      '  #  · 服务端会直接信任请求头 x-user-id 与查询参数 ?user=，  #',
      '  #    任何人都可以冒充管理员（role=admin）读取全部项目。    #',
      '  #  · 本模式仅供本机演示，禁止部署到内网或任何共享环境。    #',
      '  #  · 本服务必须只监听回环地址（127.0.0.1），不得设置       #',
      '  #    CCER_ALLOW_REMOTE=1，也不得反向代理到其他主机。      #',
      '  #  · 恢复正常认证：设置 CCER_AUTH_MODE=session 并重启。    #',
      '  ############################################################',
      '',
    ];
  }
  return [
    `  身份认证：${authModeLabel(mode)}`,
    '  身份只来自服务端会话；请求头 x-user-id 与查询参数 user 一律忽略。',
    '  提示：本原型尚未接入机构统一身份认证，登录口令为占位演示口令，正式部署须替换为 SSO/OIDC。',
  ];
}

/* ------------------------------ 令牌处理 ------------------------------ */

/** 令牌摘要：SHA-256 十六进制。库中只出现该摘要，绝不出现明文令牌。 */
export function hashToken(token) {
  return createHash('sha256').update(String(token), 'utf8').digest('hex');
}

/** 生成明文令牌（32 字节随机数，base64url 编码；仅在登录响应中出现一次） */
export function generateToken() {
  return randomBytes(32).toString('base64url');
}

/**
 * 从请求头 / Cookie 中取出令牌。优先 Authorization: Bearer，其次 Cookie。
 * 明确不支持查询参数传令牌（令牌会残留在日志与浏览器历史中）。
 * @param {import('node:http').IncomingMessage} req
 * @returns {string|null}
 */
export function resolveToken(req) {
  const auth = String((req && req.headers && req.headers.authorization) || '');
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m && m[1].trim()) return m[1].trim();
  const cookie = parseCookies(req && req.headers ? req.headers.cookie : '')[COOKIE_NAME];
  return cookie || null;
}

/** 解析 Cookie 头为对象 */
export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    let v = part.slice(i + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

/** 会话 Cookie 属性：HttpOnly + SameSite=Strict + Path=/（禁止脚本读取，禁止跨站携带） */
export function sessionCookie(token, { maxAgeSec = Math.floor(DEFAULT_TTL_MS / 1000), secure = false } = {}) {
  const parts = [`${COOKIE_NAME}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
  if (Number.isFinite(maxAgeSec)) parts.push(`Max-Age=${Math.floor(maxAgeSec)}`);
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/** 清除 Cookie：Max-Age=0 */
export function clearSessionCookie({ secure = false } = {}) {
  const parts = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/* ------------------------------ 会话读写 ------------------------------ */

/**
 * 建立会话。
 * @param {string} userId 必须是 app_user 中存在的启用用户
 * @param {{ip?:string, ttlMs?:number, actor?:string}} [opts]
 * @returns {{token:string, expires_at:string, session_id:string, user:object}}
 * @throws {Error} 用户不存在 / 已停用
 */
export function createSession(userId, { ip = null, ttlMs = DEFAULT_TTL_MS, actor = null } = {}) {
  const user = loadUser(userId);
  if (!user) throw new Error('用户不存在或已停用，无法建立会话');

  const token = generateToken();
  const tokenHash = hashToken(token);
  const created = nowIso();
  const ttl = Number.isFinite(Number(ttlMs)) && Number(ttlMs) > 0 ? Number(ttlMs) : DEFAULT_TTL_MS;
  const expiresAt = new Date(Date.now() + ttl).toISOString();
  const id = newId('SES');

  run(
    `INSERT INTO user_session
       (id, token_hash, user_id, created_at, expires_at, last_seen_at, ip, revoked_at, revoke_reason)
     VALUES (?,?,?,?,?,?,?,NULL,NULL)`,
    [id, tokenHash, user.id, created, expiresAt, created, ip]
  );

  audit({
    actor: actor || user.name,
    actorRole: user.role,
    action: 'auth.login',
    objectType: 'user_session',
    objectId: id,
    detail: { user_id: user.id, ttl_ms: ttl, mode: authMode() },
    ip,
  });

  // 明文令牌只在这里返回一次；库里只有摘要。
  return { token, expires_at: expiresAt, session_id: id, user };
}

/**
 * 解析会话，返回 app_user 行（并刷新 last_seen_at）。
 * 过期、已撤销、未知令牌、已停用用户一律返回 null。
 * @param {string|null} token 明文令牌，或已计算的摘要
 * @returns {object|null} app_user 行（含 session_id / session_expires_at），并附 active:boolean
 */
export function resolveSession(token) {
  if (!token || typeof token !== 'string') return null;
  const hash = token.length === 64 && /^[0-9a-f]{64}$/i.test(token) ? token.toLowerCase() : hashToken(token);
  const row = get(
    `SELECT s.id AS session_id, s.user_id, s.created_at AS session_created_at,
            s.expires_at AS session_expires_at, s.last_seen_at, s.ip AS session_ip,
            u.id, u.name, u.role, u.team_id, u.active
       FROM user_session s
       JOIN app_user u ON u.id = s.user_id
      WHERE s.token_hash = ?
        AND s.revoked_at IS NULL
        AND s.expires_at > ?
        AND u.active = 1
      LIMIT 1`,
    [hash, nowIso()]
  );
  if (!row) return null;

  // 节流刷新：同一会话 60 秒内只写一次，避免读接口也产生大量写事务。
  const lastSeen = row.last_seen_at ? Date.parse(row.last_seen_at) : 0;
  if (!lastSeen || Date.now() - lastSeen > LAST_SEEN_REFRESH_MS) {
    try {
      run('UPDATE user_session SET last_seen_at = ? WHERE id = ?', [nowIso(), row.session_id]);
    } catch {
      // 刷新失败不影响本次请求的身份判定
    }
  }

  return { ...row, active: !!row.active };
}

/**
 * 注销会话（幂等）。
 * @param {string} token 明文令牌或摘要
 * @param {{reason?:string, actor?:string, actorRole?:string, ip?:string, silent?:boolean}} [opts]
 * @returns {boolean} 是否确实撤销了一个有效会话
 */
export function destroySession(token, { reason = 'logout', actor = null, actorRole = null, ip = null, silent = false } = {}) {
  if (!token || typeof token !== 'string') return false;
  const hash = token.length === 64 && /^[0-9a-f]{64}$/i.test(token) ? token.toLowerCase() : hashToken(token);
  const row = get('SELECT * FROM user_session WHERE token_hash = ?', [hash]);
  if (!row || row.revoked_at) return false;
  run('UPDATE user_session SET revoked_at = ?, revoke_reason = ? WHERE id = ?', [nowIso(), reason, row.id]);
  if (!silent) {
    audit({
      actor: actor || row.user_id,
      actorRole,
      action: 'auth.logout',
      objectType: 'user_session',
      objectId: row.id,
      detail: { user_id: row.user_id, reason },
      ip,
    });
  }
  return true;
}

/**
 * 管理员按会话 ID 撤销。
 * @returns {{ok:true,id:string}|{error:string,status:number}}
 */
export function revokeSessionById(sessionId, actor, { reason = 'admin_revoke' } = {}) {
  const row = get('SELECT * FROM user_session WHERE id = ?', [String(sessionId || '')]);
  if (!row) return { error: '会话不存在', status: 404 };
  if (row.revoked_at) return { ok: true, id: row.id, already: true };
  run('UPDATE user_session SET revoked_at = ?, revoke_reason = ? WHERE id = ?', [nowIso(), reason, row.id]);
  audit({
    actor: actor?.name || 'system',
    actorRole: actor?.role || null,
    action: 'auth.session_revoke',
    objectType: 'user_session',
    objectId: row.id,
    detail: { user_id: row.user_id, reason },
  });
  return { ok: true, id: row.id };
}

/**
 * 清理过期会话（housekeeping）。已过期的令牌在任何情况下都不能再被使用，
 * 且过期行不承载审计价值（审计日志在 audit_log 中另行留存），因此直接删除。
 * @param {{includeRevoked?:boolean}} [opts]
 * @returns {{expired:number, revoked:number}} 删除行数
 */
export function purgeExpiredSessions({ includeRevoked = false } = {}) {
  const now = nowIso();
  const before = countSessions();
  run('DELETE FROM user_session WHERE expires_at <= ?', [now]);
  const expiredRemoved = before - countSessions();
  let revokedRemoved = 0;
  if (includeRevoked) {
    const mid = countSessions();
    run('DELETE FROM user_session WHERE revoked_at IS NOT NULL');
    revokedRemoved = mid - countSessions();
  }
  return { expired: expiredRemoved, revoked: revokedRemoved };
}

/**
 * 活跃会话列表（管理后台用）。
 * **绝不返回 token_hash**：这里手工挑选字段，不使用 SELECT *。
 * @param {object} [user] 传入非管理员时返回 403 结构；不传表示不做权限判断
 * @returns {Array|{error:string,status:number}}
 */
export function listSessions(user = null) {
  if (user && user.role !== 'admin') {
    return { error: '仅管理员可查看会话列表', status: 403 };
  }
  return all(
    `SELECT s.id, s.user_id, u.name AS user_name, u.role AS user_role, u.team_id,
            s.created_at, s.expires_at, s.last_seen_at, s.ip, s.revoked_at, s.revoke_reason,
            CASE WHEN s.revoked_at IS NOT NULL THEN 'revoked'
                 WHEN s.expires_at <= ? THEN 'expired'
                 ELSE 'active' END AS status
       FROM user_session s
       JOIN app_user u ON u.id = s.user_id
      WHERE s.revoked_at IS NULL AND s.expires_at > ?
      ORDER BY s.last_seen_at DESC, s.created_at DESC`,
    [nowIso(), nowIso()]
  );
}

/** 会话计数（含已撤销 / 已过期），供清理与自检使用 */
export function countSessions() {
  const r = get('SELECT COUNT(*) AS c FROM user_session');
  return r ? Number(r.c) : 0;
}

/* ------------------------------ 登录辅助 ------------------------------ */

/** 读取启用用户 */
export function loadUser(userId) {
  const row = get('SELECT id, name, role, team_id, active FROM app_user WHERE id = ?', [String(userId || '')]);
  if (!row || !row.active) return null;
  return { ...row, active: !!row.active };
}

/* ------------------------------------------------------------------ */
/*  v2：服务端口令哈希 / 锁定 / 登录记录                                 */
/*  - 只有 v2 迁移执行过（CCER_ENABLE_V2=1）的库才存在这些列与表；       */
/*    列/表不存在时全部逻辑安全跳过，v1 行为完全不变。                   */
/* ------------------------------------------------------------------ */

let _v2AuthColumns = null;

/** 当前库是否具备 v2 的账号列（password_hash 等） */
export function hasV2AuthColumns() {
  if (_v2AuthColumns !== null) return _v2AuthColumns;
  try {
    const cols = getDb().prepare('PRAGMA table_info(app_user)').all().map((c) => c.name);
    _v2AuthColumns = cols.includes('password_hash') && cols.includes('failed_attempts');
  } catch {
    _v2AuthColumns = false;
  }
  return _v2AuthColumns;
}

export function resetAuthColumnCache() {
  _v2AuthColumns = null;
}

/** 账号安全信息（不存在则返回 null） */
export function loadUserSecurity(userId) {
  if (!hasV2AuthColumns()) return null;
  return (
    get(
      `SELECT id, name, role, team_id, active, password_hash, password_algo, must_change_password,
              failed_attempts, locked_until, last_login_at
       FROM app_user WHERE id = ?`,
      [String(userId || '')]
    ) || null
  );
}

function hasLoginLogTable() {
  try {
    return !!getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='user_login_log'")
      .get();
  } catch {
    return false;
  }
}

/** 写入登录记录（v2 表不存在时静默跳过） */
export function recordLogin({ userId, userName, result, method = 'password', ip = null, userAgent = null, sessionId = null, detail = null }) {
  if (!hasLoginLogTable()) return null;
  try {
    const id = newId('LGN');
    run(
      `INSERT INTO user_login_log (id,user_id,user_name,at,result,method,ip,user_agent,session_id,detail)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [id, userId || null, userName || null, nowIso(), result, method, ip || null,
        userAgent ? String(userAgent).slice(0, 300) : null, sessionId || null,
        detail ? (typeof detail === 'string' ? detail : JSON.stringify(detail)) : null]
    );
    return id;
  } catch {
    return null;
  }
}

const MAX_FAILED = 5;
const LOCK_MS = 15 * 60 * 1000;

function registerFailure(userId, { ip, reason, userAgent = null }) {
  if (!hasV2AuthColumns()) return;
  const row = loadUserSecurity(userId);
  if (!row) return;
  const attempts = Number(row.failed_attempts || 0) + 1;
  const lockedUntil = attempts >= MAX_FAILED ? new Date(Date.now() + LOCK_MS).toISOString() : row.locked_until;
  run('UPDATE app_user SET failed_attempts = ?, locked_until = ?, updated_at = ? WHERE id = ?', [
    attempts, lockedUntil, nowIso(), userId,
  ]);
  recordLogin({ userId, userName: row.name, result: 'bad_credentials', ip, userAgent, detail: { reason, attempts } });
}

function clearFailures(userId) {
  if (!hasV2AuthColumns()) return;
  run('UPDATE app_user SET failed_attempts = 0, locked_until = NULL, last_login_at = ?, updated_at = ? WHERE id = ?', [
    nowIso(), nowIso(), userId,
  ]);
}

/** 账号是否处于锁定状态 */
export function isLocked(userId) {
  if (!hasV2AuthColumns()) return { locked: false };
  const row = loadUserSecurity(userId);
  if (!row || !row.locked_until) return { locked: false };
  const until = Date.parse(row.locked_until);
  if (Number.isNaN(until) || until <= Date.now()) return { locked: false };
  return { locked: true, until: row.locked_until, minutes: Math.ceil((until - Date.now()) / 60000) };
}

/**
 * 登录（原型实现，v2 增强）。
 * 口令校验顺序：
 *   1. 若账号已设置服务端口令哈希（scrypt，v2 管理后台重置口令时写入）→ 校验哈希；
 *   2. 否则回落到 src/data/users.mjs 的**演示口令**（仅原型占位，正式部署必须删除）。
 * 账号锁定：连续 5 次失败锁定 15 分钟（仅在具备 v2 列的库生效）。
 * 正式部署必须改为 SSO/OIDC 身份断言。
 * @param {string} userId
 * @param {string} passphrase
 * @param {{ip?:string, ttlMs?:number, userAgent?:string}} [opts]
 * @returns {{ok:true, token:string, expires_at:string, user:object}|{ok:false, status:number, error:string}}
 */
export function loginWithPassphrase(userId, passphrase, { ip = null, ttlMs = DEFAULT_TTL_MS, userAgent = null } = {}) {
  const user = loadUser(userId);
  // 用户不存在与口令错误返回同一文案，避免枚举账号
  const denied = { ok: false, status: 401, error: '用户 ID 或口令不正确' };
  if (!user) {
    auditLoginFailure(userId, ip, 'user_not_found');
    recordLogin({ userId, result: 'bad_credentials', ip, userAgent, detail: { reason: 'user_not_found' } });
    return denied;
  }
  const lock = isLocked(user.id);
  if (lock.locked) {
    recordLogin({
      userId: user.id, userName: user.name, result: 'locked', ip, userAgent,
      detail: { until: lock.until },
    });
    return {
      ok: false,
      status: 423,
      error: `账号已锁定，请于 ${lock.minutes} 分钟后重试或联系管理员重置口令`,
      locked_until: lock.until,
    };
  }
  const sec = loadUserSecurity(user.id);
  let ok = false;
  let method = 'password';
  if (sec && sec.password_hash) {
    ok = verifyPassword(String(passphrase ?? ''), sec.password_hash);
  } else if (process.env.NODE_ENV !== 'production') {
    method = 'dev';
    ok = verifyDemoPassphrase(user.id, passphrase);
  }
  if (!ok) {
    registerFailure(user.id, {
      ip,
      reason: sec?.password_hash ? 'bad_password' : process.env.NODE_ENV === 'production' ? 'no_password_configured' : 'bad_demo_passphrase',
      userAgent,
    });
    auditLoginFailure(userId, ip, 'bad_passphrase');
    return denied;
  }
  clearFailures(user.id);
  const s = createSession(user.id, { ip, ttlMs });
  recordLogin({
    userId: user.id, userName: user.name,
    result: 'ok', method, ip, userAgent, sessionId: s.session_id,
    detail: sec?.password_hash ? null : { note: '使用演示口令登录（原型占位机制，上线前须替换为 SSO）' },
  });
  return {
    ok: true,
    token: s.token,
    expires_at: s.expires_at,
    session_id: s.session_id,
    user: s.user,
    must_change_password: sec ? !!sec.must_change_password : false,
  };
}

function auditLoginFailure(userId, ip, reason) {
  try {
    audit({
      actor: String(userId || 'unknown'),
      action: 'auth.login',
      objectType: 'user_session',
      detail: { reason },
      ip,
      result: 'denied',
    });
  } catch {
    /* 审计失败不阻断登录失败响应 */
  }
}
