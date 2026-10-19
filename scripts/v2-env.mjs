/**
 * v2 脚本环境初始化（所有 v2 脚本的第一行导入）
 * ============================================================================
 * 硬约束（本轮交付要求）：
 *   1. 未设置 CCER_DB_PATH 时，默认指向 **data/ccer_v2.db**（独立库）；
 *   2. 总是设置 CCER_ENABLE_V2=1（v2 迁移只在显式开启时执行）；
 *   3. 若 CCER_DB_PATH 被显式指向在用生产库 data/ccer.db → **直接退出**，
 *      不做任何导入、不建连接，绝不触碰该文件及其 -wal / -shm。
 *
 * 用法（必须在导入任何 src 模块之前 await）：
 *     import { initV2Env } from './v2-env.mjs';
 *     await initV2Env();
 *     const db = await import('../src/core/db.mjs');
 */
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(SCRIPT_DIR, '..');
export const V2_DB_DEFAULT = join(PROJECT_ROOT, 'data', 'ccer_v2.db');

/**
 * @param {{temp?:boolean, quiet?:boolean}} [opts]
 * @returns {Promise<{dbPath:string, guard:object, temp:boolean}>}
 */
export async function initV2Env(opts = {}) {
  const explicit = process.env.CCER_DB_PATH;
  const useTemp = !!opts.temp || process.argv.includes('--temp');

  if (useTemp) {
    const dir = mkdtempSync(join(tmpdir(), 'ccer-v2-'));
    process.env.CCER_DB_PATH = join(dir, 'v2-temp.db');
  } else if (!explicit) {
    process.env.CCER_DB_PATH = V2_DB_DEFAULT;
  }
  process.env.CCER_ENABLE_V2 = '1';

  // 动态导入：确保 db.mjs 在环境变量设置之后才被求值
  const guard = await import('../src/services/v2-guard.mjs');
  const db = await import('../src/core/db.mjs');
  const p = db.dbPath();

  if (guard.isProductionDb(p)) {
    console.error('');
    console.error('✗ 已拒绝执行：CCER_DB_PATH 指向在用生产库 data/ccer.db');
    console.error('  本轮开发的硬约束：不得对 data/ccer.db 运行服务、seed、迁移、测试或写入。');
    console.error('  请改为：');
    console.error('    Remove-Item Env:\\CCER_DB_PATH      # 使用默认的 data/ccer_v2.db');
    console.error('    或 $env:CCER_DB_PATH="$PWD\\data\\ccer_v2.db"');
    console.error('    或加 --temp 使用系统临时库');
    console.error('');
    process.exit(2);
  }
  if (guard.v2EnvEnabled() !== true) {
    console.error('✗ CCER_ENABLE_V2 未能设置为 1，已中止。');
    process.exit(2);
  }
  mkdirSync(dirname(p), { recursive: true });
  if (!opts.quiet) {
    console.log(`[v2] 数据库：${p}${existsSync(p) ? '' : '（将新建）'}`);
    console.log(`[v2] CCER_ENABLE_V2=1｜临时库=${useTemp ? '是' : '否'}`);
  }
  return { dbPath: p, guard, temp: useTemp };
}

/** 解析命令行参数：--key=value / --flag */
export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (const a of argv) {
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}
