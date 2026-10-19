/**
 * 数据库快照：把一个 SQLite 库完整复制到另一个路径（含 WAL 中尚未合并的数据）。
 * ============================================================================
 * 为什么要用 VACUUM INTO 而不是复制文件：
 *   本项目使用 WAL 模式，最新写入可能仍在 <db>-wal 中。直接复制主文件会**丢失**
 *   未 checkpoint 的数据，得到一个看似成功、实际缺数据或为空的副本。
 *   `VACUUM INTO 'path'` 由 SQLite 自己导出一致性快照，是唯一可靠的做法。
 *
 * 用途：
 *   1. 在隔离数据库上验证 schema 迁移（不触碰在用库）；
 *   2. 交付要求的「可验证的数据迁移脚本与回滚路径」中的备份环节。
 *
 * 用法：
 *   node scripts/snapshot-db.mjs <源库> <目标库>
 *   或 node scripts/snapshot-db.mjs --from data/ccer.db --to data/ccer_v2.db
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

function parseArgs(argv) {
  const positional = argv.filter((a) => !a.startsWith('--'));
  const get = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : null;
  };
  const from = get('--from') || positional[0];
  const to = get('--to') || positional[1];
  const force = argv.includes('--force');
  return { from, to, force };
}

const { from, to, force } = parseArgs(process.argv.slice(2));

if (!from || !to) {
  console.error('用法：node scripts/snapshot-db.mjs --from <源库> --to <目标库> [--force]');
  process.exit(2);
}

const src = resolve(from);
const dst = resolve(to);
if (!existsSync(src)) {
  console.error(`源库不存在：${src}`);
  process.exit(2);
}
if (existsSync(dst)) {
  if (!force) {
    console.error(`目标库已存在：${dst}（如需覆盖请加 --force）`);
    process.exit(2);
  }
  rmSync(dst, { force: true });
  rmSync(`${dst}-wal`, { force: true });
  rmSync(`${dst}-shm`, { force: true });
}
mkdirSync(dirname(dst), { recursive: true });

const db = new DatabaseSync(src, { readOnly: false });
try {
  db.exec(`VACUUM INTO '${dst.replace(/'/g, "''")}'`);
  console.log(`已生成一致性快照：${dst}`);

  const check = new DatabaseSync(dst);
  const tables = check
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((t) => t.name);
  console.log(`快照表数量：${tables.length}`);
  for (const t of ['methodology_version', 'project', 'app_user', 'rule', 'factor_version', 'source_document']) {
    if (!tables.includes(t)) continue;
    const c = check.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
    console.log(`  ${t} = ${c}`);
  }
  check.close();
} finally {
  db.close();
}
