/** One-time local review account setup. Never run this on the cloud server. */
import { resolve } from 'node:path';
import { initV2Env } from './v2-env.mjs';

if (process.platform !== 'win32' || process.env.NODE_ENV === 'production') {
  throw new Error('此脚本仅允许在本地 Windows 验收环境运行');
}
const password = process.env.CCER_LOCAL_ADMIN_PASSWORD;
if (!password) throw new Error('请在当前进程的 CCER_LOCAL_ADMIN_PASSWORD 中提供本地验收口令');
const { dbPath } = await initV2Env({ quiet: true });
const localDb = resolve('data/ccer_v2.db');
if (resolve(dbPath).toLowerCase() !== localDb.toLowerCase()) {
  throw new Error('拒绝修改非当前本地项目的 v2 数据库');
}

const { getDb, closeDb } = await import('../src/core/db.mjs');
const { hashPassword } = await import('../src/core/password.mjs');
const db = getDb();
const now = new Date().toISOString();
const id = 'xmj5139';
const demoIds = ['user-admin', 'user-analyst', 'user-researcher', 'user-reviewer', 'user-other'];
db.exec('BEGIN IMMEDIATE');
try {
  db.prepare(`INSERT INTO app_user
    (id,name,role,team_id,active,display_name,email,password_hash,password_algo,
     must_change_password,failed_attempts,locked_until,last_login_at,created_at,updated_at)
    VALUES (?,?,'admin','team-carbon',1,?,NULL,?,'scrypt',0,0,NULL,NULL,?,?)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name,role='admin',team_id='team-carbon',active=1,
      display_name=excluded.display_name,password_hash=excluded.password_hash,
      password_algo='scrypt',must_change_password=0,failed_attempts=0,
      locked_until=NULL,updated_at=excluded.updated_at`).run(
    id, '平台管理员', '平台管理员', hashPassword(password), now, now
  );
  const q = demoIds.map(() => '?').join(',');
  db.prepare(`UPDATE app_user SET active=0, updated_at=? WHERE id IN (${q})`).run(now, ...demoIds);
  db.prepare(`UPDATE user_session SET revoked_at=?, revoke_reason='local_admin_bootstrap'
    WHERE user_id IN (${q}) AND revoked_at IS NULL`).run(now, ...demoIds);
  db.exec('COMMIT');
  console.log(JSON.stringify({ admin_id: id, role: 'admin', password_hash_stored: true, demo_accounts_disabled: demoIds.length }));
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
} finally {
  closeDb();
}
