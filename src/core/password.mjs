/**
 * 口令哈希（scrypt）
 * ============================================================================
 * 说明与边界：
 *   - 这是**服务端口令哈希**的实现（scrypt + 随机盐 + 定长时间比较），
 *     用于管理员重置口令、账号首次登录等场景；
 *   - 它**不是**机构统一身份认证。需求规格 P3 要求云端上线前接入 SSO/OIDC，
 *     届时本模块只保留「服务端本地口令」这一条回退路径。
 *   - 明文口令不写库、不写日志、不出现在任何接口响应中。
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };

/** 生成口令哈希：scrypt$N$r$p$saltB64$hashB64 */
export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(String(password), salt, PARAMS.keylen, { N: PARAMS.N, r: PARAMS.r, p: PARAMS.p });
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/** 校验口令（定长时间比较），格式不合法一律返回 false */
export function verifyPassword(password, stored) {
  if (!stored || typeof password !== 'string') return false;
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  try {
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = scryptSync(password, salt, expected.length, { N: Number(N), r: Number(r), p: Number(p) });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** 口令强度最低要求（原型：长度与字符类别） */
export function checkPasswordStrength(password) {
  const s = String(password || '');
  const issues = [];
  if (s.length < 12) issues.push('长度至少 12 位');
  if (!/[a-z]/.test(s)) issues.push('需包含小写字母');
  if (!/[A-Z]/.test(s)) issues.push('需包含大写字母');
  if (!/\d/.test(s)) issues.push('需包含数字');
  if (/^(.)\1+$/.test(s)) issues.push('不能是单一重复字符');
  return { ok: issues.length === 0, issues };
}
