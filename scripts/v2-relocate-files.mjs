/** Rewrite archived public-file paths after moving the v2 data directory to another OS.
 * Use on a copied database. Default is read-only; --apply verifies every referenced
 * file before changing any row. The source database is never reset or seeded.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { initV2Env, parseArgs } from './v2-env.mjs';

const args = parseArgs();
if (!args.db || !args['data-dir']) {
  console.error('用法：node scripts/v2-relocate-files.mjs --db=/opt/ccer/data/ccer_v2.db --data-dir=/opt/ccer/data [--apply]');
  process.exit(2);
}
process.env.CCER_DB_PATH = resolve(String(args.db));
await initV2Env({ quiet: true });
const { getDb, closeDb } = await import('../src/core/db.mjs');
const db = getDb();
const root = resolve(String(args['data-dir']));
const fields = [
  ['methodology_version', 'original_file_path', 'original_file_hash'],
  ['policy_document', 'local_path', null],
  ['policy_attachment', 'local_path', 'file_hash'],
  ['evidence', 'local_path', 'file_hash'],
  ['source_snapshot', 'body_path', null],
  // CEA（阶段B）：官方原件统一落盘 data/official-originals/cea/，迁移时必须一并改写并校验哈希，
  // 否则换机或改数据目录后 CEA 附件与管理员补充副本会指向不存在的路径（附件保护）。
  ['cea_document', 'attachment_path', 'attachment_hash'],
  ['document_upload', 'local_path', 'file_hash'],
];
const planned = [];
const errors = [];
for (const [table, column, hashColumn] of fields) {
  const rows = db.prepare(`SELECT id, ${column} AS old_path${hashColumn ? `, ${hashColumn} AS expected_hash` : ''} FROM ${table} WHERE ${column} IS NOT NULL AND ${column} <> ''`).all();
  for (const row of rows) {
    const path = String(row.old_path);
    const match = path.match(/(?:^|[\\/])data[\\/]((?:official-originals|registry-files)[\\/].+)$/i);
    if (!match) { errors.push({ table, id: row.id, reason: '路径不在允许的数据附件目录中' }); continue; }
    const target = resolve(root, ...match[1].split(/[\\/]/));
    if (!(target.startsWith(root + '\\') || target.startsWith(root + '/'))) {
      errors.push({ table, id: row.id, reason: '路径越过目标数据目录' }); continue;
    }
    if (!existsSync(target)) { errors.push({ table, id: row.id, reason: '目标附件缺失', target }); continue; }
    if (row.expected_hash) {
      const actual = createHash('sha256').update(readFileSync(target)).digest('hex');
      if (actual !== row.expected_hash) { errors.push({ table, id: row.id, reason: '附件哈希不匹配', target }); continue; }
    }
    if (target !== path) planned.push({ table, column, id: row.id, target });
  }
}
const result = { mode: args.apply ? 'apply' : 'check', data_dir: root, changes: planned.length, errors };
if (errors.length) { console.log(JSON.stringify(result)); closeDb(); process.exit(1); }
if (args.apply) {
  db.exec('BEGIN');
  try {
    for (const item of planned) {
      db.prepare(`UPDATE ${item.table} SET ${item.column}=? WHERE id=?`).run(item.target, item.id);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    closeDb();
    throw error;
  }
}
console.log(JSON.stringify(result));
closeDb();
