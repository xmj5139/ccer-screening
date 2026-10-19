/**
 * 审计服务（v2 扩展）
 * ============================================================================
 * 职责：
 *   1. 导出审计（export_log）：谁、在什么时间、以什么筛选条件、导出了多少行、文件哈希
 *   2. 登录记录（user_login_log）：登录成功/失败、方式、来源 IP 与 User-Agent
 *   3. 数据/规则变更审计的便捷封装
 *
 * 与 v1 的关系：v1 的 audit_log 继续使用，本模块只补充 v2 新增的两类留痕表，
 * 不改动 audit_log 的写入路径。
 */
import { all, get, run, audit, metaValue } from '../core/db.mjs';
import { newId, nowIso, j } from '../core/util.mjs';

/* --------------------------- 导出审计 --------------------------- */

export function exportLogAudit({ user, dataset, format, rowCount, filters = null, objectType = null, objectId = null, ip = null, note = null }) {
  const id = newId('EXP');
  run(
    `INSERT INTO export_log (id,at,actor,actor_role,dataset,format,row_count,filters_json,object_type,object_id,ip,note)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id, nowIso(), user?.name || 'unknown', user?.role || null, dataset, format,
      Number.isFinite(Number(rowCount)) ? Number(rowCount) : null,
      filters ? j(filters) : null, objectType, objectId, ip, note,
    ]
  );
  audit({
    actor: user?.name || 'unknown',
    actorRole: user?.role || null,
    action: 'data.export',
    objectType: objectType || 'dataset',
    objectId: objectId || dataset,
    detail: { dataset, format, rows: rowCount, filters, note },
    ip,
  });
  return id;
}

export function listExportLog(user, { limit = 200, dataset = null, actor = null } = {}) {
  if (!user || !['admin', 'reviewer'].includes(user.role)) {
    return { error: '仅系统管理员与领域复核人可查看导出审计', status: 403 };
  }
  const where = [];
  const params = [];
  if (dataset) {
    where.push('dataset = ?');
    params.push(dataset);
  }
  if (actor) {
    where.push('actor = ?');
    params.push(actor);
  }
  return all(
    `SELECT * FROM export_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY at DESC LIMIT ?`,
    [...params, Math.min(Number(limit) || 200, 2000)]
  );
}

/* --------------------------- 登录记录 --------------------------- */

export function loginLog({ userId, userName, result, method, ip, userAgent, sessionId, detail }) {
  const id = newId('LGN');
  run(
    `INSERT INTO user_login_log (id,user_id,user_name,at,result,method,ip,user_agent,session_id,detail)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      id, userId || null, userName || null, nowIso(), result, method,
      ip || null, userAgent ? String(userAgent).slice(0, 300) : null, sessionId || null,
      detail ? (typeof detail === 'string' ? detail : j(detail)) : null,
    ]
  );
  return id;
}

export function listLoginLog(user, { limit = 200, userId = null } = {}) {
  if (!user || user.role !== 'admin') {
    return { error: '仅系统管理员可查看登录记录', status: 403 };
  }
  const params = [];
  let where = '';
  if (userId) {
    where = 'WHERE user_id = ?';
    params.push(userId);
  }
  return all(
    `SELECT * FROM user_login_log ${where} ORDER BY at DESC LIMIT ?`,
    [...params, Math.min(Number(limit) || 200, 2000)]
  );
}

/* --------------------------- 数据变更留痕 --------------------------- */

/** 记录一次字段级数据变更（用于人工补录与修订留痕） */
export function recordChange({ user, action, objectType, objectId, before = null, after = null, reason = null, ip = null }) {
  audit({
    actor: user?.name || 'system',
    actorRole: user?.role || null,
    action,
    objectType,
    objectId,
    detail: { before, after, reason },
    ip,
  });
}

export function recentChanges({ objectType, objectId, limit = 50 }) {
  return all(
    `SELECT * FROM audit_log WHERE object_type = ? AND object_id = ? ORDER BY at DESC LIMIT ?`,
    [objectType, objectId, limit]
  );
}

export function auditStats() {
  const total = get('SELECT COUNT(*) AS c FROM audit_log')?.c ?? 0;
  const denied = get("SELECT COUNT(*) AS c FROM audit_log WHERE result = 'denied'")?.c ?? 0;
  const exports = get('SELECT COUNT(*) AS c FROM export_log')?.c ?? 0;
  const logins = get("SELECT COUNT(*) AS c FROM user_login_log WHERE result = 'ok'")?.c ?? 0;
  const failedLogins = get("SELECT COUNT(*) AS c FROM user_login_log WHERE result != 'ok'")?.c ?? 0;
  return {
    audit_total: total,
    audit_denied: denied,
    exports_total: exports,
    logins_ok: logins,
    logins_failed: failedLogins,
    retention_note: metaValue('audit_retention_note', '审计日志默认保留 3 年；导出审计含文件哈希与筛选条件。'),
  };
}
