/** Create an online-consistent copy of the v2 SQLite database for migration. */
import { resolve, dirname } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const source = resolve(process.argv[2] || 'data/ccer_v2.db');
const target = resolve(process.argv[3] || 'data/ccer_v2.snapshot.db');
if (!existsSync(source) || existsSync(target) || source === target) {
  console.error('源数据库不存在、目标文件已存在或源与目标相同');
  process.exit(2);
}
mkdirSync(dirname(target), { recursive: true });
const db = new DatabaseSync(source);
try {
  db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
} finally {
  db.close();
}
const copy = new DatabaseSync(target);
try {
  const integrity = copy.prepare('PRAGMA integrity_check').all();
  if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') throw new Error('快照完整性检查失败');
  console.log(JSON.stringify({ source, target, integrity: 'ok' }));
} finally {
  copy.close();
}
