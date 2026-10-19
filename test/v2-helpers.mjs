/**
 * v2 测试公共环境
 * ============================================================================
 * 硬约束：任何 v2 测试都必须在**独立临时库**中运行，并且：
 *   1. 设置 CCER_DB_PATH 指向系统临时目录中的新库；
 *   2. 设置 CCER_ENABLE_V2=1（否则 v2 迁移不会执行）；
 *   3. 若发现 CCER_DB_PATH 指向在用生产库 data/ccer.db → 直接抛错退出，
 *      绝不在该库上建表、写入或迁移。
 *
 * 该文件必须在导入任何 src 模块之前调用 setupV2()。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(TEST_DIR, '..');
export const PRODUCTION_DB = resolve(join(PROJECT_ROOT, 'data', 'ccer.db'));

let ctx = null;

export async function setupV2({ withPublicDemo = true } = {}) {
  if (ctx) return ctx;
  const dir = mkdtempSync(join(tmpdir(), 'ccer-v2-test-'));
  const dbPath = join(dir, 'v2-test.db');
  if (resolve(dbPath).toLowerCase() === PRODUCTION_DB.toLowerCase()) {
    throw new Error('测试库路径与在用生产库相同，已拒绝（安全护栏）');
  }
  process.env.CCER_DB_PATH = dbPath;
  process.env.CCER_ENABLE_V2 = '1';
  process.env.CCER_AUTH_MODE = 'session';
  delete process.env.CCER_ALLOW_REMOTE;

  const db = await import('../src/core/db.mjs');
  if (db.dbPath().toLowerCase() === PRODUCTION_DB.toLowerCase()) {
    throw new Error('CCER_DB_PATH 指向在用生产库 data/ccer.db，已拒绝运行 v2 测试');
  }
  const seed = await import('../src/services/seed.mjs');
  const seedV2 = await import('../src/services/seed-v2.mjs');
  const guard = await import('../src/services/v2-guard.mjs');
  const trade = await import('../src/services/trade-svc.mjs');
  const collect = await import('../src/services/collect-svc.mjs');
  const reconcile = await import('../src/services/reconcile-svc.mjs');
  const policy = await import('../src/services/policy-svc.mjs');
  const projects = await import('../src/services/project-v2-svc.mjs');
  const measure = await import('../src/services/measure-svc.mjs');
  const admin = await import('../src/services/admin-v2-svc.mjs');
  const dash = await import('../src/services/dashboard-svc.mjs');
  const exportSvc = await import('../src/services/export-svc.mjs');
  const templates = await import('../src/data/import-templates.mjs');
  const auth = await import('../src/services/auth-svc.mjs');

  db.getDb();
  seed.seedAll({ withDemo: true, actor: 'test' });
  seedV2.seedV2({ withPublicDemo, calendarDays: 30 });

  ctx = {
    dir, dbPath, db, seed, seedV2, guard, trade, collect, reconcile, policy, projects,
    measure, admin, dash, exportSvc, templates, auth,
  };
  return ctx;
}

export function teardownV2() {
  try {
    if (ctx?.db) ctx.db.closeDb();
  } catch {
    /* ignore */
  }
  if (ctx?.dir) {
    try {
      rmSync(ctx.dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  ctx = null;
}

/** 内存/临时库中直接建一张全新库（用于测试「未开启 v2 时不迁移」） */
export function freshDbFile(name = 'raw.db') {
  const p = join(ctx.dir, name);
  return { path: p, db: new DatabaseSync(p) };
}

export function hasTable(db, table) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(table);
}

export function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

/* ------------------------------ 断言 ------------------------------ */

let passed = 0;
let failed = 0;
const failures = [];

export function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    failures.push({ name, error: e });
    console.log(`  ✗ ${name}`);
    console.log(`      ${e.message}`);
  }
}

export async function testAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    failures.push({ name, error: e });
    console.log(`  ✗ ${name}`);
    console.log(`      ${e.message}`);
  }
}

export function assert(cond, message = '断言失败') {
  if (!cond) throw new Error(message);
}

export function assertEqual(actual, expected, message = '') {
  if (actual !== expected) {
    throw new Error(`${message}｜期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

export function assertIncludes(haystack, needle, message = '') {
  if (!String(haystack).includes(needle)) {
    throw new Error(`${message}｜未包含「${needle}」，实际：${String(haystack).slice(0, 160)}`);
  }
}

export function assertNotIncludes(haystack, needle, message = '') {
  if (String(haystack).includes(needle)) {
    throw new Error(`${message}｜不应包含「${needle}」，实际：${String(haystack).slice(0, 160)}`);
  }
}

export function assertThrows(fn, message = '应当抛出异常') {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  if (!threw) throw new Error(message);
}

export function summary(fileName) {
  console.log('');
  console.log(`  ── ${fileName}：通过 ${passed}，失败 ${failed} ──`);
  if (failed) {
    for (const f of failures) console.log(`  ✗ ${f.name}\n     ${f.error.stack?.split('\n')[1] || ''}`);
  }
  return failed;
}

export function finish(fileName) {
  const f = summary(fileName);
  teardownV2();
  process.exit(f ? 1 : 0);
}

/** 是否允许联网用例（由 scripts/v2-test.mjs 通过 --net 打开） */
export const netAllowed = () => process.env.CCER_TEST_ALLOW_NET === '1';
