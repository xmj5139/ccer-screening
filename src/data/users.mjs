/**
 * 演示用户名册与「演示口令」（占位实现）
 * ============================================================================
 * ⚠️ 重要安全声明（务必在正式部署前阅读）
 *
 *   1. 本文件只是为了在没有接入身份系统时，让原型能演示「登录 → 会话 → 授权」
 *      这条完整链路。**这里的 demo_passphrase 是明文的占位口令，不是密码存储方案。**
 *   2. 正式部署必须替换为机构统一身份认证（SSO）——推荐 OIDC / OAuth2 / CAS 或
 *      内网 LDAP，由身份提供方完成口令校验与多因素认证；本系统只负责接收
 *      身份断言并建立服务端会话（见 src/services/auth-svc.mjs）。
 *   3. 明文口令文件不得进入生产环境；替换方案落地后应整体删除本文件的口令字段。
 *   4. 服务端在任何响应中都不返回口令；口令比较使用定长时间比较，避免时序侧信道。
 *
 * 与 app_user 表的关系：
 *   id / name / role / team_id 必须与 src/services/seed.mjs 写入 app_user 的种子数据
 *   保持一致（服务端以 app_user 表为唯一权威，本文件只补充「口令」这一项）。
 *
 * 用户可见文案、注释一律使用简体中文。
 */

/** 五个既有演示用户（与 app_user 种子数据一一对应） */
export const DEMO_USERS = [
  {
    id: 'user-admin',
    name: '系统管理员',
    role: 'admin',
    team_id: 'team-carbon',
    demo_passphrase: 'admin-demo-2026',
  },
  {
    id: 'user-researcher',
    name: '政策研究员',
    role: 'researcher',
    team_id: 'team-carbon',
    demo_passphrase: 'researcher-demo-2026',
  },
  {
    id: 'user-analyst',
    name: '投资分析师',
    role: 'analyst',
    team_id: 'team-invest',
    demo_passphrase: 'analyst-demo-2026',
  },
  {
    id: 'user-reviewer',
    name: '领域复核人',
    role: 'reviewer',
    team_id: 'team-carbon',
    demo_passphrase: 'reviewer-demo-2026',
  },
  {
    id: 'user-other',
    name: '其他团队成员',
    role: 'viewer',
    team_id: 'team-other',
    demo_passphrase: 'viewer-demo-2026',
  },
];

/** 按用户 ID 取演示用户（不含口令，供前端展示与校验） */
export function findDemoUser(userId) {
  if (!userId) return null;
  return DEMO_USERS.find((u) => u.id === String(userId)) || null;
}

/** 该用户 ID 是否在演示名册内 */
export function isKnownUser(userId) {
  return !!findDemoUser(userId);
}

/**
 * 登录面板用的用户清单：只暴露 id / name / role / team_id，绝不返回 demo_passphrase。
 */
export function publicUserList() {
  return DEMO_USERS.map((u) => ({ id: u.id, name: u.name, role: u.role, team_id: u.team_id }));
}

/**
 * 校验演示口令。口令缺失或为空一律判为失败（不得出现「空口令即通过」）。
 * 说明：这只是占位机制，正式部署由 SSO/OIDC 取代。
 * @param {string} userId
 * @param {string} passphrase
 * @returns {boolean}
 */
export function verifyDemoPassphrase(userId, passphrase) {
  const u = findDemoUser(userId);
  if (!u) return false;
  if (typeof passphrase !== 'string' || passphrase.length === 0) return false;
  return timingSafeEqualStr(u.demo_passphrase, passphrase);
}

/**
 * 定长时间字符串比较：长度不同或字符不同都不提前返回，
 * 避免通过响应时间推断口令内容。
 */
function timingSafeEqualStr(expected, actual) {
  const a = Buffer.from(String(expected), 'utf8');
  const b = Buffer.from(String(actual), 'utf8');
  const len = Math.max(a.length, b.length, 1);
  const pa = Buffer.alloc(len);
  const pb = Buffer.alloc(len);
  a.copy(pa);
  b.copy(pb);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i += 1) diff |= pa[i] ^ pb[i];
  return diff === 0;
}
