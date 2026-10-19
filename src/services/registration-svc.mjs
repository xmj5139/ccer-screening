/**
 * 公开注册（自助注册）
 * ============================================================================
 * 端点：`POST /api/auth/register`（免登录白名单，见 src/server.mjs）。
 *
 * 安全基线（不得放宽）：
 *   1. **服务端固定账号属性**：角色恒为 `viewer`、团队恒为普通团队；
 *      客户端传入 `role` / `team_id` / `active` / `is_admin` 等账号属性一律
 *      **400 拒绝**，而不是静默忽略——静默忽略会让调用方误以为提权成功。
 *   2. **用户名唯一且格式受控**：统一小写归一后校验格式（字母开头，字母/数字/
 *      下划线/连字符，3–32 位），并显式拒绝会让人误认为管理员的保留名；
 *      唯一性先查一次给出友好提示，再由主键约束兜住并发写入。
 *   3. **口令复用既有实现**：强度校验与哈希都取自 src/core/password.mjs
 *      （scrypt + 随机盐，格式 `scrypt$N$r$p$salt$hash`）；明文口令不写库、
 *      不写日志、不出现在任何响应里。
 *   4. **不签发会话**：注册成功只返回账号信息与登录入口，用户需自行回登录页
 *      使用该用户名与口令登录（不自动建立会话，也就没有注册即登录的会话固定风险）。
 *   5. **与 v2 写入约束一致**：v2 未启用（503）或库路径指向在用生产库
 *      `data/ccer.db`（409）时拒绝注册；账号口令字段未迁移（503）时同样拒绝。
 *
 * 边界说明：
 *   - 注册是**公开写接口**，服务默认只监听回环地址；如以 CCER_ALLOW_REMOTE=1
 *     对内网开放，建议在反向代理层追加限流/验证码（本模块不做限流）。
 *   - 本模块只是「本地口令账号」的原型实现；云端上线前须由机构统一身份认证
 *     （SSO/OIDC/LDAP）接管账号生命周期。
 */
import { get, run, audit } from '../core/db.mjs';
import { nowIso } from '../core/util.mjs';
import { checkPasswordStrength, hashPassword } from '../core/password.mjs';
import { guardV2 } from './v2-guard.mjs';
import { hasV2AuthColumns } from './auth-svc.mjs';

/** 注册账号的固定角色（服务端决定，客户端不可指定） */
export const REGISTER_ROLE = 'viewer';

/** 注册账号的固定团队：综合管理组（只读查看），不是研究/投资等有授权的团队 */
export const REGISTER_TEAM_ID = 'team-other';

/** 首选团队不可用时的回退团队（默认团队，无任何项目授权） */
export const REGISTER_TEAM_FALLBACK_ID = 'team-default';

/** 用户名格式：字母开头，字母/数字/下划线/连字符，3–32 位（存储前统一小写） */
export const USERNAME_MIN = 3;
export const USERNAME_MAX = 32;
export const USERNAME_PATTERN = /^[a-z][a-z0-9_-]{2,31}$/;

/** 保留用户名：注册后会被误认为管理员/系统的名字，一律不允许占用 */
export const RESERVED_USERNAMES = new Set([
  'admin', 'administrator', 'root', 'sysadmin', 'system', 'superuser', 'superadmin',
]);

/** 显示名上限（可选字段） */
export const DISPLAY_NAME_MAX = 40;

/** 口令长度上限：仅用于挡住超长输入，强度要求见 checkPasswordStrength */
export const PASSWORD_MAX = 200;

/**
 * 客户端不得指定的账号属性（提权面）。
 * 出现任意一项即 400，绝不「读取后忽略」。
 */
export const PRIVILEGE_FIELDS = [
  'role', 'roles', 'is_admin', 'admin', 'isadmin', 'superuser',
  'team', 'team_id', 'teamId', 'active', 'enabled', 'status',
  'permissions', 'permission', 'grants', 'grant', 'scope', 'scopes',
  'password_hash', 'password_algo', 'must_change_password', 'failed_attempts', 'locked_until',
];

/** 允许的字段（严格白名单；未列出的字段一律 400，避免字段混淆） */
export const ALLOWED_FIELDS = new Set(['username', 'user_id', 'password', 'display_name', 'name']);

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
/** 显示名里不允许出现尖括号：避免在未转义的展示位置形成标记注入 */
const MARKUP_CHARS = /[<>]/;

function fail(status, error, message = null, issues = null) {
  const out = { ok: false, status, error };
  if (message) out.message = message;
  if (issues && issues.length) out.issues = issues;
  return out;
}

/** 用户名归一：去空白 + 统一小写（唯一性判断因此大小写不敏感） */
export function normalizeUsername(raw) {
  return String(raw === null || raw === undefined ? '' : raw).trim().toLowerCase();
}

/**
 * 纯函数校验：不碰数据库，便于单测与服务端复用。
 * @param {object} input 请求体
 * @returns {{ok:true, value:{username:string,password:string,display_name:string|null}}
 *          |{ok:false,status:number,error:string,message?:string,issues?:string[]}}
 */
export function validateRegistration(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return fail(400, '请求体必须是 JSON 对象');
  }

  // 1) 提权字段：显式拒绝（含值为 null/false 的情况，避免「传了但被忽略」的假象）
  const privileged = PRIVILEGE_FIELDS.filter((k) => Object.prototype.hasOwnProperty.call(input, k));
  if (privileged.length) {
    return fail(
      400,
      `注册不接受客户端指定账号属性：${privileged.join('、')}`,
      '角色、团队、启用状态、权限与口令哈希等账号属性由服务端固定（role=viewer ＋ 普通团队），客户端传入一律拒绝。'
    );
  }

  // 2) 未知字段：严格白名单，避免字段混淆或夹带
  const unknown = Object.keys(input).filter((k) => !ALLOWED_FIELDS.has(k));
  if (unknown.length) {
    return fail(400, `不支持的字段：${unknown.join('、')}`, `注册仅接受字段：${[...ALLOWED_FIELDS].join('、')}。`);
  }

  // 3) 用户名：username / user_id 二选一（同时提供时必须一致）
  const hasUsername = Object.prototype.hasOwnProperty.call(input, 'username');
  const hasUserId = Object.prototype.hasOwnProperty.call(input, 'user_id');
  if (!hasUsername && !hasUserId) {
    return fail(400, '缺少用户名', '请提供 username（用户名）。');
  }
  if (hasUsername && hasUserId) {
    if (typeof input.username !== 'string' || typeof input.user_id !== 'string' ||
        normalizeUsername(input.username) !== normalizeUsername(input.user_id)) {
      return fail(400, 'username 与 user_id 不一致', '两者是同一字段的别名，同时提供时必须完全相同。');
    }
  }
  const rawUsername = hasUsername ? input.username : input.user_id;
  if (typeof rawUsername !== 'string') {
    return fail(400, '用户名必须是字符串');
  }
  const username = normalizeUsername(rawUsername);
  if (!username) return fail(400, '用户名不能为空');
  if (username.length < USERNAME_MIN || username.length > USERNAME_MAX) {
    return fail(400, `用户名长度需为 ${USERNAME_MIN}–${USERNAME_MAX} 个字符`);
  }
  if (!USERNAME_PATTERN.test(username)) {
    return fail(400, '用户名只能包含小写字母、数字、下划线、连字符，且必须以字母开头',
      '示例：zhang-san、analyst_2026。');
  }
  if (RESERVED_USERNAMES.has(username)) {
    return fail(400, `用户名为保留名，不允许注册：${username}`, '请更换其他用户名。');
  }

  // 4) 口令：必填 + 现有强度校验（长度≥12、含大小写字母与数字、非单一重复字符）
  if (!Object.prototype.hasOwnProperty.call(input, 'password')) {
    return fail(400, '缺少口令', '请提供 password（口令）。');
  }
  if (typeof input.password !== 'string') {
    return fail(400, '口令必须是字符串');
  }
  if (input.password.length > PASSWORD_MAX) {
    return fail(400, `口令长度不得超过 ${PASSWORD_MAX} 个字符`);
  }
  const strength = checkPasswordStrength(input.password);
  if (!strength.ok) {
    return fail(400, '口令强度不足', '请按下列要求修改口令。', strength.issues);
  }

  // 5) 显示名：可选；空白视为未提供
  const hasDisplay = Object.prototype.hasOwnProperty.call(input, 'display_name');
  const hasName = Object.prototype.hasOwnProperty.call(input, 'name');
  if (hasDisplay && hasName &&
      (typeof input.display_name !== 'string' || typeof input.name !== 'string' ||
       input.display_name.trim() !== input.name.trim())) {
    return fail(400, 'display_name 与 name 不一致', '两者是同一字段的别名，同时提供时必须完全相同。');
  }
  const rawDisplay = hasDisplay ? input.display_name : hasName ? input.name : null;
  let displayName = null;
  if (rawDisplay !== null && rawDisplay !== undefined) {
    if (typeof rawDisplay !== 'string') return fail(400, '显示名必须是字符串');
    const trimmed = rawDisplay.trim();
    if (trimmed) {
      if (trimmed.length > DISPLAY_NAME_MAX) {
        return fail(400, `显示名长度不得超过 ${DISPLAY_NAME_MAX} 个字符`);
      }
      if (CONTROL_CHARS.test(trimmed)) return fail(400, '显示名不能包含控制字符');
      if (MARKUP_CHARS.test(trimmed)) return fail(400, '显示名不能包含 < 或 >');
      displayName = trimmed;
    }
  }

  return { ok: true, value: { username, password: input.password, display_name: displayName } };
}

/**
 * 注册归属团队：优先「综合管理组」（只读），其次「默认团队」；
 * 两者都不可用时仍固定使用 REGISTER_TEAM_ID（app_user.team_id 无外键，
 * 且该团队没有任何项目授权，不会因此获得额外可见范围）。
 * @returns {string}
 */
export function resolveRegisterTeamId() {
  try {
    for (const id of [REGISTER_TEAM_ID, REGISTER_TEAM_FALLBACK_ID]) {
      const row = get('SELECT id FROM app_team WHERE id = ? AND active = 1', [id]);
      if (row) return id;
    }
  } catch {
    // app_team 尚未建表（极早期启动路径）：回落到固定团队
  }
  return REGISTER_TEAM_ID;
}

/**
 * 公开注册。
 * @param {object} payload 请求体（只读 username/user_id、password、display_name/name）
 * @param {{ip?:string, userAgent?:string}} [opts]
 * @returns {{ok:true,status:201,user:object,message:string,login_endpoint:string}
 *          |{ok:false,status:number,error:string,message?:string,issues?:string[]}}
 */
export function registerUser(payload, { ip = null, userAgent = null } = {}) {
  // 与 v2 写入同一套约束：未启用 503；指向在用生产库 409（绝不写生产库）
  const gate = guardV2({ write: true });
  if (gate) return fail(gate.status, gate.error, gate.message);
  if (!hasV2AuthColumns()) {
    return fail(503, '注册功能未启用', '当前数据库缺少账号口令字段（password_hash 等），请先完成 v2 迁移。');
  }

  const checked = validateRegistration(payload);
  if (!checked.ok) return checked;
  const { username, password, display_name: displayName } = checked.value;

  // 唯一性（大小写不敏感）：先查一次给出明确提示
  if (get('SELECT id FROM app_user WHERE lower(id) = ?', [username])) {
    return fail(409, '该用户名已被占用', '请更换用户名后重试。');
  }

  const now = nowIso();
  const teamId = resolveRegisterTeamId();
  try {
    run(
      `INSERT INTO app_user
         (id,name,role,team_id,active,display_name,email,password_hash,password_algo,
          must_change_password,failed_attempts,locked_until,last_login_at,created_at,updated_at)
       VALUES (?,?,?,?,1,?,NULL,?,'scrypt',0,0,NULL,NULL,?,?)`,
      [username, displayName || username, REGISTER_ROLE, teamId, displayName, hashPassword(password), now, now]
    );
  } catch (e) {
    // 并发下的兜底：主键/唯一约束冲突仍按「用户名已被占用」返回
    if (/UNIQUE|PRIMARY KEY|constraint/i.test(String(e?.message || ''))) {
      return fail(409, '该用户名已被占用', '请更换用户名后重试。');
    }
    return fail(500, '注册失败', '账号写入失败，请稍后重试或联系管理员。');
  }

  // 审计只记录账号属性，绝不记录口令或哈希
  audit({
    actor: username,
    actorRole: REGISTER_ROLE,
    action: 'user.register',
    objectType: 'app_user',
    objectId: username,
    detail: {
      self_registration: true,
      role: REGISTER_ROLE,
      team_id: teamId,
      has_display_name: !!displayName,
      user_agent: userAgent ? String(userAgent).slice(0, 300) : null,
    },
    ip,
  });

  return {
    ok: true,
    status: 201,
    user: {
      id: username,
      name: displayName || username,
      display_name: displayName,
      role: REGISTER_ROLE,
      team_id: teamId,
      active: true,
    },
    message: '注册成功：账号为只读角色，请返回登录页使用该用户名与口令登录。',
    login_endpoint: '/api/auth/login',
  };
}
